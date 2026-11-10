/**
 * Plugin side of the layout worker protocol. Owner: E8.
 *
 * The worker bundle (IIFE) is inlined into main.js at build time as the string constant
 * __CORTEX_WORKER_SOURCE__ (esbuild `define`). At first call: Blob → URL.createObjectURL → new Worker(url)
 * (classic worker). If construction throws (policy, CSP) or the source is empty, the client runs the same message
 * handler on the main thread ("inline" mode; one task per call) with identical messages and results.
 * ONE worker serves every leaf (H6): each call names its `viewId`; a newer call of the same (viewId, method)
 * cancels the older one; dropView(viewId) frees a closed leaf's cached placement. Params that are typed arrays
 * are transferred only when the caller passes them in `transfer` (the caller must not reuse them).
 * Inline mode evaluates the same worker script with a shim for the worker scope (the plugin tier may not import
 * worker modules), so both modes run identical code.
 */
import { CortexError, type CortexErrorCode } from "../shared/errors";
import type { Logger } from "../shared/log";
import type { FromWorker, ToWorker, WorkerErrorCode, WorkerMethod, WorkerMethods } from "../shared/protocol/worker";

declare const __CORTEX_WORKER_SOURCE__: string;

export interface WorkerCallOptions {
  signal?: AbortSignal;
  transfer?: Transferable[];
  onProgress?: (phase: string, done: number, total: number) => void;
}

export interface WorkerClient {
  readonly mode: "worker" | "inline" | "stopped";
  call<M extends WorkerMethod>(viewId: string, method: M, params: WorkerMethods[M]["params"], opts?: WorkerCallOptions): Promise<WorkerMethods[M]["result"]>;
  dropView(viewId: string): void;
  terminate(): void;
}

/** The inlined worker source (empty string in unit tests). */
export function workerSource(): string {
  return typeof __CORTEX_WORKER_SOURCE__ === "string" ? __CORTEX_WORKER_SOURCE__ : "";
}

/** Latest-wins key for cancellation. */
export function callKey(viewId: string, method: WorkerMethod): string {
  return `${viewId}\u0000${method}`;
}

/** The part of a Web Worker the client uses. */
export interface WorkerLike {
  postMessage(msg: ToWorker, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: { data: FromWorker }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
}

/** The part of the worker handler the inline mode uses. */
export interface InlineHandler {
  onMessage(msg: ToWorker): void;
}

export interface WorkerClientDeps {
  /** The worker script; defaults to the inlined bundle. */
  source?: string;
  /** Start a real worker from the script; may throw. Default: Blob + object URL + new Worker. */
  spawn?: (source: string) => WorkerLike;
  /** Create the inline handler delivering to `post`. Default: evaluate the worker script against a shimmed scope. */
  inline?: (post: (msg: FromWorker, transfer: ArrayBuffer[]) => void, source: string) => Promise<InlineHandler>;
  /** Run `fn` as its own task (inline mode). Default: setTimeout 0. */
  defer?: (fn: () => void) => void;
}

function defaultSpawn(source: string): WorkerLike {
  const g = globalThis as unknown as { Worker?: new (url: string) => WorkerLike; Blob?: new (parts: string[], opts: { type: string }) => unknown; URL?: { createObjectURL(b: unknown): string } };
  if (!g.Worker || !g.Blob || !g.URL) throw new CortexError("E_WORKER", "Web Workers are not available");
  return new g.Worker(g.URL.createObjectURL(new g.Blob([source], { type: "text/javascript" })));
}

async function defaultInline(post: (msg: FromWorker, transfer: ArrayBuffer[]) => void, source: string): Promise<InlineHandler> {
  if (source.length === 0) throw new CortexError("E_WORKER", "the layout worker bundle is missing");
  const scope: { onmessage: ((ev: { data: ToWorker }) => void) | null; postMessage(msg: FromWorker, transfer?: ArrayBuffer[]): void } = {
    onmessage: null,
    postMessage: (msg, transfer) => post(msg, transfer ?? []),
  };
  // The worker script talks to `globalThis`; inside this function that name is the shim.
  new Function("globalThis", "self", source)(scope, scope);
  const handle = scope.onmessage;
  if (typeof handle !== "function") throw new CortexError("E_WORKER", "the layout worker bundle did not register a message handler");
  return { onMessage: (msg) => handle({ data: msg }) };
}

const defaultDefer = (fn: () => void): void => {
  setTimeout(fn, 0);
};

function toError(code: WorkerErrorCode, message: string): CortexError {
  const mapped: CortexErrorCode = code === "E_CANCELLED" ? "E_CANCELLED" : code === "E_BAD_PARAMS" ? "E_BAD_REQUEST" : "E_WORKER";
  return new CortexError(mapped, message, { detail: { workerCode: code } });
}

interface Pending {
  key: string;
  resolve(v: unknown): void;
  reject(e: unknown): void;
  onProgress?: (phase: string, done: number, total: number) => void;
  cleanup(): void;
}

export function createWorkerClient(log: Logger, deps: WorkerClientDeps = {}): WorkerClient {
  let mode: "worker" | "inline" | "stopped" = "stopped";
  let terminated = false;
  let nextId = 1;
  let worker: WorkerLike | null = null;
  let inline: InlineHandler | null = null;
  let starting: Promise<void> | null = null;
  const pending = new Map<number, Pending>();
  const latest = new Map<string, number>();
  const defer = deps.defer ?? defaultDefer;

  const settle = (id: number): Pending | undefined => {
    const p = pending.get(id);
    if (!p) return undefined;
    pending.delete(id);
    if (latest.get(p.key) === id) latest.delete(p.key);
    p.cleanup();
    return p;
  };

  const deliver = (msg: FromWorker): void => {
    if (msg.t === "ready") {
      log.debug("layout worker ready", { version: msg.version, mode });
      return;
    }
    if (msg.t === "progress") {
      pending.get(msg.id)?.onProgress?.(msg.phase, msg.done, msg.total);
      return;
    }
    const p = settle(msg.id);
    if (!p) return;
    if (msg.ok) p.resolve(msg.result);
    else p.reject(toError(msg.error.code, msg.error.message));
  };

  const failAll = (e: unknown): void => {
    for (const id of [...pending.keys()]) settle(id)?.reject(e);
  };

  const start = async (): Promise<void> => {
    if (terminated) throw new CortexError("E_CANCELLED", "the layout worker was terminated");
    if (mode !== "stopped") return;
    if (starting) return starting;
    starting = (async () => {
      const source = deps.source ?? workerSource();
      if (source.length > 0) {
        try {
          const w = (deps.spawn ?? defaultSpawn)(source);
          w.onmessage = (ev) => deliver(ev.data);
          w.onerror = (ev) => {
            log.error("layout worker failed", { message: ev.message });
            failAll(new CortexError("E_WORKER", ev.message ?? "the layout worker stopped"));
            w.terminate();
            if (worker === w) {
              worker = null;
              mode = "stopped";
            }
          };
          worker = w;
          mode = "worker";
          return;
        } catch (e) {
          log.warn("layout worker could not start; running inline", { error: e instanceof Error ? e.message : String(e) });
        }
      }
      inline = await (deps.inline ?? defaultInline)((msg) => deliver(msg), source);
      mode = "inline";
    })().finally(() => {
      starting = null;
    });
    return starting;
  };

  const post = (msg: ToWorker, transfer: Transferable[] = []): void => {
    if (mode === "worker" && worker) worker.postMessage(msg, transfer);
    else if (mode === "inline" && inline) {
      const h = inline;
      defer(() => h.onMessage(msg));
    }
  };

  return {
    get mode() {
      return mode;
    },
    async call<M extends WorkerMethod>(viewId: string, method: M, params: WorkerMethods[M]["params"], opts: WorkerCallOptions = {}): Promise<WorkerMethods[M]["result"]> {
      if (opts.signal?.aborted) throw new CortexError("E_CANCELLED", "cancelled");
      await start();
      const id = nextId++;
      const key = callKey(viewId, method);
      // A newer call of the same (view, method) replaces the older one.
      const older = latest.get(key);
      if (older !== undefined) {
        post({ t: "cancel", id: older });
        settle(older)?.reject(new CortexError("E_CANCELLED", "superseded by a newer call"));
      }
      latest.set(key, id);
      return new Promise<WorkerMethods[M]["result"]>((resolve, reject) => {
        const onAbort = (): void => {
          if (!pending.has(id)) return;
          post({ t: "cancel", id });
          settle(id)?.reject(new CortexError("E_CANCELLED", "cancelled"));
        };
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        pending.set(id, {
          key,
          resolve: resolve as (v: unknown) => void,
          reject,
          ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
          cleanup: () => opts.signal?.removeEventListener("abort", onAbort),
        });
        post({ t: "call", id, viewId, method, params } as ToWorker, opts.transfer);
      });
    },
    dropView(viewId) {
      if (mode === "stopped") return;
      post({ t: "dropView", viewId });
    },
    terminate() {
      terminated = true;
      failAll(new CortexError("E_CANCELLED", "the layout worker was terminated"));
      worker?.terminate();
      worker = null;
      inline = null;
      mode = "stopped";
    },
  };
}
