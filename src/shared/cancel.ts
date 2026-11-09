/**
 * Cooperative cancellation shared by the runner, importers, agents and the worker. Owner: E1.
 *
 * A CancelSource owns an AbortController; its token is handed to work that checks `cancelled` (or awaits
 * `sleep`) between units. Child sources follow their parent and detach from it when they are disposed or
 * cancelled, so a long-lived parent never accumulates listeners. Every cancellation surfaces as a CortexError
 * with code E_CANCELLED (`isCancellation` also recognises DOM and Node AbortErrors).
 */
import { CortexError, isCancellation } from "./errors";

export interface CancelToken {
  readonly cancelled: boolean;
  /** Why the work was cancelled (undefined while running). */
  readonly reason: string | undefined;
  readonly signal: AbortSignal;
  /** Throws CortexError E_CANCELLED once cancelled. */
  throwIfCancelled(): void;
  /** Run `fn` once when cancelled (at once if already cancelled); returns a function that removes it. */
  onCancel(fn: (reason: string) => void): () => void;
}

export interface CancelSource {
  readonly token: CancelToken;
  cancel(reason?: string): void;
  /** Detach from the parent and clear the timeout without cancelling (the work finished normally). */
  dispose(): void;
}

export interface CancelSourceOptions {
  /** Cancel automatically after this many milliseconds (reason "timeout"). */
  timeoutMs?: number;
}

export { isCancellation };

function cancelledError(reason: string | undefined): CortexError {
  return new CortexError("E_CANCELLED", reason ? `cancelled: ${reason}` : "cancelled");
}

/** A cancel source, optionally following a parent token (cancelled when the parent is) and timing out. */
export function createCancelSource(parent?: CancelToken, opts: CancelSourceOptions = {}): CancelSource {
  const ac = new AbortController();
  let reason: string | undefined;
  let detach: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const release = (): void => {
    detach?.();
    detach = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const cancel = (why = "cancelled"): void => {
    if (ac.signal.aborted) return;
    reason = why;
    release();
    ac.abort(cancelledError(why));
  };

  if (parent) {
    if (parent.cancelled) cancel(parent.reason ?? "parent cancelled");
    else detach = parent.onCancel((why) => cancel(why));
  }
  if (!ac.signal.aborted && opts.timeoutMs !== undefined) {
    timer = setTimeout(() => cancel("timeout"), Math.max(0, opts.timeoutMs));
  }

  const token: CancelToken = {
    get cancelled() {
      return ac.signal.aborted;
    },
    get reason() {
      return reason;
    },
    signal: ac.signal,
    throwIfCancelled() {
      if (ac.signal.aborted) throw cancelledError(reason);
    },
    onCancel(fn) {
      if (ac.signal.aborted) {
        fn(reason ?? "cancelled");
        return () => undefined;
      }
      const listener = (): void => fn(reason ?? "cancelled");
      ac.signal.addEventListener("abort", listener, { once: true });
      return () => ac.signal.removeEventListener("abort", listener);
    },
  };

  return { token, cancel, dispose: release };
}

/** A source that cancels itself after `ms` (reason "timeout"), optionally following a parent. */
export function createTimeoutSource(ms: number, parent?: CancelToken): CancelSource {
  return createCancelSource(parent, { timeoutMs: ms });
}

function abortReasonText(r: unknown): string {
  if (r instanceof Error) return r.message;
  return typeof r === "string" && r.length > 0 ? r : "aborted";
}

/** A token that follows an AbortSignal (for APIs that hand us a signal). */
export function tokenFromSignal(signal: AbortSignal): CancelToken {
  const src = createCancelSource();
  if (signal.aborted) src.cancel(abortReasonText(signal.reason));
  else signal.addEventListener("abort", () => src.cancel(abortReasonText(signal.reason)), { once: true });
  return src.token;
}

/** A token that is never cancelled (tests, one-shot CLI calls). */
export const NEVER_CANCELLED: CancelToken = Object.freeze({
  cancelled: false,
  reason: undefined,
  signal: new AbortController().signal,
  throwIfCancelled: () => undefined,
  onCancel: () => () => undefined,
});

/** Resolve after `ms`, or reject with E_CANCELLED as soon as the token is cancelled. */
export function sleep(ms: number, token: CancelToken = NEVER_CANCELLED): Promise<void> {
  if (token.cancelled) return Promise.reject(cancelledError(token.reason));
  return new Promise<void>((resolve, reject) => {
    let off: () => void = () => undefined;
    const t = setTimeout(() => {
      off();
      resolve();
    }, Math.max(0, ms));
    off = token.onCancel((why) => {
      clearTimeout(t);
      reject(cancelledError(why));
    });
  });
}

/** Await `p`, but reject with E_CANCELLED as soon as the token is cancelled (`p` itself keeps running). */
export function raceCancel<T>(p: Promise<T>, token: CancelToken): Promise<T> {
  if (token.cancelled) return Promise.reject(cancelledError(token.reason));
  return new Promise<T>((resolve, reject) => {
    const off = token.onCancel((why) => reject(cancelledError(why)));
    p.then(
      (v) => {
        off();
        resolve(v);
      },
      (e: unknown) => {
        off();
        reject(e);
      },
    );
  });
}

type SchedulerLike = { yield?: () => Promise<void> };
type SetImmediateLike = (fn: () => void) => unknown;

let channel: { port: MessagePort; queue: (() => void)[] } | null = null;

function viaMessageChannel(): Promise<void> | null {
  const MC = (globalThis as { MessageChannel?: typeof MessageChannel }).MessageChannel;
  if (typeof MC !== "function") return null;
  if (!channel) {
    const mc = new MC();
    const queue: (() => void)[] = [];
    mc.port1.onmessage = () => queue.shift()?.();
    channel = { port: mc.port2, queue };
  }
  const ch = channel;
  return new Promise<void>((resolve) => {
    ch.queue.push(resolve);
    ch.port.postMessage(0);
  });
}

/**
 * Cooperative yield for work running on a UI thread (inline runner / inline worker): resolves on the next
 * macrotask so input and rendering can run. Prefers scheduler.yield() (Chromium ≥ 129), then setImmediate
 * (Node), then a MessageChannel (no 4 ms clamp), then setTimeout.
 */
export function yieldToHost(): Promise<void> {
  const s = (globalThis as { scheduler?: SchedulerLike }).scheduler;
  if (typeof s?.yield === "function") return s.yield();
  const si = (globalThis as { setImmediate?: SetImmediateLike }).setImmediate;
  if (typeof si === "function") return new Promise((r) => void si(r));
  return viaMessageChannel() ?? new Promise((r) => setTimeout(r, 0));
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

/**
 * Returns a function that yields to the host whenever more than `budgetMs` passed since the last yield and
 * checks the token around each yield. A disabled yielder only checks the token.
 */
export function createYielder(budgetMs: number, enabled: boolean, token: CancelToken = NEVER_CANCELLED): () => Promise<void> {
  let last = nowMs();
  return async () => {
    token.throwIfCancelled();
    if (!enabled) return;
    if (nowMs() - last >= budgetMs) {
      await yieldToHost();
      last = nowMs();
      token.throwIfCancelled();
    }
  };
}
