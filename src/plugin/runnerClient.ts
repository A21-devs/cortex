/**
 * Plugin side of the runner protocol. Owner: E5.
 *
 * Mode selection (settings.advanced.runnerMode "auto"):
 *   1. child  — system Node ≥ 20 found (advanced.nodePath, PATH, Program Files…): spawn
 *               `<node> --max-old-space-size=<n> <pluginDir>/cortex-runner.js serve` (shell:false, windowsHide,
 *               cwd = the local cache folder, never the OneDrive plugin folder: CHILD-CWD-ONEDRIVE). One
 *               long-lived child per Obsidian session, started lazily; restarted on crash (max 3 per 10 min).
 *   2. worker — no usable Node: probe once whether a Blob Web Worker has `require` (Obsidian 1.15 sets
 *               nodeIntegrationInWorker); if so run the runner bundle there with the same frames over
 *               postMessage, off the UI thread (INLINE-FALLBACK-UI-THREAD).
 *   3. inline — last resort: `require(<pluginDir>/cortex-runner.js).createInlineRunner(onFrame)` on the UI
 *               thread, concurrency 1, imports only (no agents), lock stale limit ≥ 5 min. Before requiring,
 *               `delete require.cache[require.resolve(runnerPath)]` so a deploy + plugin:reload loads new code.
 *   Electron's own binary is never used as Node (RunAsNode fuse disabled); fork() and process.execPath are
 *   banned in runner code (lint in scripts/check-boundaries.mjs).
 * Watchdog: see PING_* in shared/protocol/runner.ts (outstanding-ping rule, any frame = alive, suspended while
 * the document is hidden). Version check: protocol + build id from the hello frame.
 * Requests: ids "q<n>"; progress/events go to per-request callbacks and to the bus ("runner:frame"); engine
 * states update the shared store. Cancellation sends {t:"cancel"}; no answer within 5 s kills the child tree.
 * Obsidian closing → stdin closes → the child exits by itself.
 */
import { asCortexError, CortexError, fromErrorInfo } from "../shared/errors";
import { parseJsonLine, splitLines } from "../shared/jsonl";
import type { Logger } from "../shared/log";
import {
  CANCEL_GRACE_MS,
  isFromRunner,
  MAX_FRAME_BYTES,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  RUNNER_PROTOCOL_VERSION,
  type FromRunner,
  type RunnerCommand,
  type RunnerCommandName,
  type RunnerContext,
  type RunnerEvent,
  type RunnerResultMap,
  type ToRunner,
  type WarningCode,
} from "../shared/protocol/runner";
import type { CortexSettings } from "../shared/settings";
import type { EventBus } from "../state/events";

export type RunnerMode = "child" | "worker" | "inline" | "unavailable" | "stopped";

export interface RunnerRequestOptions {
  onProgress?: (p: Extract<FromRunner, { t: "progress" }>) => void;
  onEvent?: (e: RunnerEvent) => void;
  signal?: AbortSignal;
}

export interface RunnerClient {
  readonly mode: RunnerMode;
  /** Start (or restart) the runner; resolves after the hello frame. */
  start(): Promise<RunnerMode>;
  request<C extends RunnerCommandName>(command: Extract<RunnerCommand, { cmd: C }>, opts?: RunnerRequestOptions): Promise<RunnerResultMap[C]>;
  cancelAll(): void;
  stop(): Promise<void>;
}

export interface RunnerClientDeps {
  pluginDir: string;
  vaultRoot: string;
  vaultKey: string;
  cacheDir: string;
  pluginVersion: string;
  getSettings(): CortexSettings;
  bus: EventBus;
  log: Logger;
  /** Test seam: the runner bundle's file name inside pluginDir (default cortex-runner.js). */
  runnerFileName?: string;
}

/** Restarts allowed in this window before the runner is declared unavailable. */
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW_MS = 10 * 60_000;
const HELLO_TIMEOUT_MS = 10_000;
const WORKER_PROBE_MS = 5_000;
const STOP_GRACE_MS = 2_000;
const PLUGIN_BUILD: string = typeof __CORTEX_BUILD__ === "string" ? __CORTEX_BUILD__ : "dev";

/** One way of reaching a runner: a child process, a Node-integrated worker or the UI thread. */
interface Transport {
  readonly mode: "child" | "worker" | "inline";
  send(frame: ToRunner): void;
  /** Ask politely, then force. Resolves when nothing is left running. */
  close(): Promise<void>;
  /** Force-stop at once (cancel timed out, watchdog). */
  kill(): Promise<void>;
}

interface TransportHandlers {
  onFrame(frame: FromRunner): void;
  onExit(): void;
  onStderr(text: string): void;
}

interface Pending {
  cmd: RunnerCommandName;
  resolve(v: unknown): void;
  reject(e: unknown): void;
  opts: RunnerRequestOptions;
  abort?: () => void;
  grace?: ReturnType<typeof setTimeout>;
}


// ───────────────────────────── Node access without static imports ─────────────────────────────
// This file is type-checked in the browser program too (ui/ imports the RunnerClient type), where Node's types
// do not exist. Node's modules are therefore reached through the host's require, behind minimal local types.

interface Readable {
  setEncoding(enc: string): void;
  on(ev: "data", fn: (chunk: string) => void): void;
}
interface ChildLike {
  pid?: number;
  stdin: { write(s: string): boolean; end(): void; on(ev: "error", fn: () => void): void } | null;
  stdout: Readable | null;
  stderr: Readable | null;
  on(ev: "exit" | "error", fn: () => void): void;
}
interface NodeModules {
  cp: {
    spawn(cmd: string, args: string[], opts: Record<string, unknown>): ChildLike;
    execFile(file: string, args: string[], opts: Record<string, unknown>, cb: (err: unknown, stdout: string) => void): unknown;
  };
  fs: { existsSync(p: string): boolean; mkdirSync(p: string, o: { recursive: boolean }): void };
  path: { join(...p: string[]): string; isAbsolute(p: string): boolean; delimiter: string; basename(p: string): string };
}
interface ProcLike {
  platform: string;
  env: Record<string, string | undefined>;
}
const proc = (): ProcLike => (globalThis as unknown as { process: ProcLike }).process;

function nodeModules(): NodeModules | undefined {
  const req = nodeRequire();
  if (!req) return undefined;
  try {
    return { cp: req("node:child_process") as NodeModules["cp"], fs: req("node:fs") as NodeModules["fs"], path: req("node:path") as NodeModules["path"] };
  } catch {
    return undefined;
  }
}

/** First Node >= 20 that answers --version (spawned without a shell). Electron's own binary is never a candidate. */
async function findSystemNode(nm: NodeModules, configured: string): Promise<string | undefined> {
  const { env, platform } = proc();
  const win = platform === "win32";
  const out: string[] = [];
  const conf = configured.trim();
  if (conf && nm.path.isAbsolute(conf)) out.push(conf);
  for (const d of (env.PATH ?? env.Path ?? "").split(nm.path.delimiter)) {
    const dir = d.trim().replace(/^"|"$/g, "");
    if (dir && nm.path.isAbsolute(dir)) out.push(nm.path.join(dir, win ? "node.exe" : "node"));
  }
  if (win) {
    out.push(nm.path.join(env.ProgramFiles ?? "C:\\Program Files", "nodejs", "node.exe"));
    if (env.LOCALAPPDATA) out.push(nm.path.join(env.LOCALAPPDATA, "Programs", "nodejs", "node.exe"));
    if (env.NVM_SYMLINK) out.push(nm.path.join(env.NVM_SYMLINK, "node.exe"));
    if (env.VOLTA_HOME) out.push(nm.path.join(env.VOLTA_HOME, "bin", "node.exe"));
    if (env.USERPROFILE) out.push(nm.path.join(env.USERPROFILE, "scoop", "apps", "nodejs", "current", "node.exe"));
  } else out.push("/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node");
  const probeEnv = { PATH: env.PATH, SystemRoot: env.SystemRoot, HOME: env.HOME, USERPROFILE: env.USERPROFILE };
  for (const exe of new Set(out)) {
    if (!/^node(?:[0-9][0-9.-]*)?(?:\.exe)?$/i.test(nm.path.basename(exe)) || !nm.fs.existsSync(exe)) continue;
    const version = await new Promise<string>((resolve) => {
      try {
        nm.cp.execFile(exe, ["--version"], { timeout: 5000, windowsHide: true, env: probeEnv }, (err, stdout) => resolve(err ? "" : String(stdout).trim()));
      } catch {
        resolve("");
      }
    });
    const m = /^v(\d+)\./.exec(version);
    if (m && Number(m[1]) >= 20) return exe;
  }
  return undefined;
}

/** Kill a process and its children; resolves when the kill finished (10 s at most). */
function killTreeOf(nm: NodeModules, pid: number): Promise<void> {
  return new Promise((resolve) => {
    const { platform, env } = proc();
    const done = (): void => resolve();
    const timer = setTimeout(done, 10_000);
    (timer as { unref?: () => void }).unref?.();
    try {
      if (platform === "win32") {
        const taskkill = nm.path.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "taskkill.exe");
        const k = nm.cp.spawn(taskkill, ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
        k.on("exit", done);
        k.on("error", done);
      } else {
        (globalThis as unknown as { process: { kill(pid: number, sig: string): void } }).process.kill(pid, "SIGKILL");
        done();
      }
    } catch {
      done();
    }
  });
}

type NodeRequireLike = ((id: string) => Record<string, unknown>) & { cache?: Record<string, unknown>; resolve(id: string): string };

// Declared here (not from @types/node) because the browser program type-checks this file without Node's types.
declare const require: unknown;

function nodeRequire(): NodeRequireLike | undefined {
  if (typeof require === "function") return require as unknown as NodeRequireLike;
  const w = globalThis as { require?: unknown };
  return typeof w.require === "function" ? (w.require as NodeRequireLike) : undefined;
}

function childTransport(nm: NodeModules, node: string, runnerFile: string, cwd: string, maxOldMb: number, h: TransportHandlers, log: Logger): Transport {
  const child = nm.cp.spawn(node, [`--max-old-space-size=${Math.max(256, Math.floor(maxOldMb))}`, runnerFile, "serve"], { shell: false, windowsHide: true, cwd, stdio: ["pipe", "pipe", "pipe"] });
  let carry = "";
  let exited = false;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    const r = splitLines(chunk, carry);
    carry = r.carry.length > MAX_FRAME_BYTES ? "" : r.carry;
    for (const line of r.lines) {
      const f = parseJsonLine<unknown>(line);
      if (isFromRunner(f)) h.onFrame(f);
      else log.warn("runner sent an unreadable line");
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (t: string) => h.onStderr(t));
  child.stdin?.on("error", () => undefined);
  const gone = new Promise<void>((resolve) => {
    const done = (): void => {
      if (exited) return;
      exited = true;
      resolve();
      h.onExit();
    };
    child.on("exit", done);
    child.on("error", done);
  });
  return {
    mode: "child",
    send: (f) => {
      if (!exited) child.stdin?.write(JSON.stringify(f) + "\n");
    },
    close: async () => {
      try {
        child.stdin?.write(JSON.stringify({ t: "shutdown" } satisfies ToRunner) + "\n");
        child.stdin?.end();
      } catch {
        // already closed
      }
      const timer = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, STOP_GRACE_MS);
        (t as { unref?: () => void }).unref?.();
      });
      await Promise.race([gone, timer]);
      if (!exited && child.pid !== undefined) await killTreeOf(nm, child.pid);
    },
    kill: async () => {
      if (!exited && child.pid !== undefined) await killTreeOf(nm, child.pid);
    },
  };
}

/** A Blob Web Worker with Node integration (Obsidian 1.15); null when it cannot be created. */
function workerTransport(runnerFile: string, h: TransportHandlers): Transport | null {
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  const source = `try { var r = require(${JSON.stringify(runnerFile)}); r.serveWorker(self); } catch (e) { postMessage({ t: "worker-unusable" }); }`;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  let worker: Worker;
  try {
    worker = new Worker(url);
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
  let closed = false;
  const end = (): void => {
    if (closed) return;
    closed = true;
    worker.terminate();
    URL.revokeObjectURL(url);
    h.onExit();
  };
  worker.onmessage = (ev: MessageEvent<unknown>) => {
    if (isFromRunner(ev.data)) h.onFrame(ev.data);
    else end();
  };
  worker.onerror = end;
  return {
    mode: "worker",
    send: (f) => {
      if (!closed) worker.postMessage(f);
    },
    close: async () => {
      if (!closed) worker.postMessage({ t: "shutdown" } satisfies ToRunner);
      await new Promise((r) => setTimeout(r, 200));
      end();
    },
    kill: async () => end(),
  };
}

/** The runner bundle on the UI thread (last resort). A fresh copy is loaded on every start (deploy + reload). */
function inlineTransport(runnerFile: string, h: TransportHandlers, log: Logger): Transport | null {
  const req = nodeRequire();
  if (!req) return null;
  try {
    if (req.cache) delete req.cache[req.resolve(runnerFile)];
    const mod = req(runnerFile) as { createInlineRunner?: (on: (f: FromRunner) => void, log?: Logger) => { send(f: ToRunner): void; dispose(): void } };
    if (typeof mod.createInlineRunner !== "function") return null;
    const runner = mod.createInlineRunner((f) => h.onFrame(f), log);
    let closed = false;
    const shut = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      runner.dispose();
      h.onExit();
    };
    return {
      mode: "inline",
      send: (f) => {
        if (!closed) runner.send(f);
      },
      close: shut,
      kill: shut,
    };
  } catch (e) {
    log.warn("the runner could not be loaded in this window", { code: asCortexError(e).code });
    return null;
  }
}

export function createRunnerClient(deps: RunnerClientDeps): RunnerClient {
  const { log, bus } = deps;
  const nm0 = nodeModules();
  const runnerFile = nm0 ? nm0.path.join(deps.pluginDir, deps.runnerFileName ?? "cortex-runner.js") : `${deps.pluginDir}/${deps.runnerFileName ?? "cortex-runner.js"}`;
  const pending = new Map<string, Pending>();
  const restarts: number[] = [];
  let mode: RunnerMode = "stopped";
  let transport: Transport | null = null;
  let starting: Promise<RunnerMode> | null = null;
  let helloWaiter: ((ok: boolean) => void) | null = null;
  let seq = 0;
  let pingN = 0;
  let pingSentAt = 0;
  let pingOutstanding = -1;
  let lastFrameAt = Date.now();
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let stopping = false;

  const warn = (code: WarningCode): void => bus.emit("runner:frame", { t: "event", event: { kind: "warning", code } });

  const failAll = (error: CortexError): void => {
    for (const [id, p] of [...pending]) {
      pending.delete(id);
      if (p.grace) clearTimeout(p.grace);
      p.reject(error);
    }
  };

  const onFrame = (f: FromRunner, own: Transport | null): void => {
    if (own !== null && own !== transport) return;
    lastFrameAt = Date.now();
    switch (f.t) {
      case "hello": {
        const ok = f.protocol === RUNNER_PROTOCOL_VERSION && f.build === PLUGIN_BUILD;
        if (!ok) log.warn("runner version mismatch", { protocol: f.protocol });
        helloWaiter?.(ok);
        helloWaiter = null;
        break;
      }
      case "pong":
        if (f.n === pingOutstanding) pingOutstanding = -1;
        break;
      case "progress":
        pending.get(f.id)?.opts.onProgress?.(f);
        break;
      case "event":
        if (f.id !== undefined) pending.get(f.id)?.opts.onEvent?.(f.event);
        break;
      case "result": {
        const p = pending.get(f.id);
        if (p) {
          pending.delete(f.id);
          if (p.grace) clearTimeout(p.grace);
          p.resolve(f.data);
        }
        break;
      }
      case "error": {
        const p = f.id !== undefined ? pending.get(f.id) : undefined;
        if (p && f.id !== undefined) {
          pending.delete(f.id);
          if (p.grace) clearTimeout(p.grace);
          p.reject(fromErrorInfo(f.error));
        } else log.warn("runner reported an error", { code: f.error.code });
        break;
      }
      case "log":
        log[f.level](f.msg);
        break;
    }
    bus.emit("runner:frame", f);
  };

  const dropTransport = (t: Transport): void => {
    if (transport !== t) return;
    transport = null;
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    pingOutstanding = -1;
    helloWaiter?.(false);
    helloWaiter = null;
    if (stopping) {
      mode = "stopped";
      return;
    }
    const now = Date.now();
    restarts.push(now);
    while (restarts.length > 0 && now - (restarts[0] as number) > RESTART_WINDOW_MS) restarts.shift();
    failAll(new CortexError("E_INTERNAL", "the background program stopped", { retryable: true, detail: { reason: "runner-exited" } }));
    if (restarts.length > MAX_RESTARTS) {
      mode = "unavailable";
      warn("runner-unavailable");
    } else mode = "stopped";
  };

  const startWatchdog = (t: Transport): void => {
    if (watchdog) clearInterval(watchdog);
    lastFrameAt = Date.now();
    watchdog = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        pingOutstanding = -1; // Obsidian's timers are throttled while hidden: no verdict now
        return;
      }
      const now = Date.now();
      if (pingOutstanding >= 0 && now - pingSentAt > PING_TIMEOUT_MS && now - lastFrameAt > PING_TIMEOUT_MS) {
        log.warn("runner did not answer; restarting it");
        void t.kill();
        return;
      }
      if (pingOutstanding < 0) {
        pingOutstanding = ++pingN;
        pingSentAt = now;
        t.send({ t: "ping", n: pingOutstanding });
      }
    }, PING_INTERVAL_MS);
    (watchdog as { unref?: () => void }).unref?.();
  };

  const waitHello = (limitMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        helloWaiter = null;
        resolve(false);
      }, limitMs);
      helloWaiter = (ok) => {
        clearTimeout(timer);
        resolve(ok);
      };
    });

  async function tryTransport(kind: "child" | "worker" | "inline"): Promise<boolean> {
    const slot: { t: Transport | null } = { t: null };
    const h: TransportHandlers = {
      onFrame: (f) => onFrame(f, slot.t),
      onExit: () => {
        if (slot.t) dropTransport(slot.t);
      },
      onStderr: (text) => log.debug(text.slice(0, 2000)),
    };
    const settings = deps.getSettings();
    let t: Transport | null = null;
    // The waiter exists before the transport does: an inline runner says hello while it is being created.
    const hello = waitHello(kind === "worker" ? WORKER_PROBE_MS : HELLO_TIMEOUT_MS);
    try {
      if (kind === "child") {
        const nm = nodeModules();
        const node = nm ? await findSystemNode(nm, settings.advanced.nodePath) : undefined;
        if (nm && node) {
          nm.fs.mkdirSync(deps.cacheDir, { recursive: true });
          t = childTransport(nm, node, runnerFile, deps.cacheDir, settings.advanced.maxOldSpaceMb, h, log);
        }
      } else if (kind === "worker") t = workerTransport(runnerFile, h);
      else t = inlineTransport(runnerFile, h, log);
    } catch (e) {
      log.warn("runner transport failed to start", { kind, code: asCortexError(e).code });
      t = null;
    }
    if (!t) {
      helloWaiter?.(false);
      await hello;
      return false;
    }
    slot.t = t;
    transport = t;
    if (!(await hello)) {
      if (transport === t) transport = null;
      slot.t = null;
      await t.kill();
      return false;
    }
    mode = kind;
    if (kind === "child") startWatchdog(t);
    return true;
  }

  async function doStart(): Promise<RunnerMode> {
    stopping = false;
    if (restarts.length > MAX_RESTARTS) {
      if (Date.now() - (restarts[restarts.length - 1] as number) < RESTART_WINDOW_MS) return (mode = "unavailable");
      restarts.length = 0;
    }
    // An encrypted record is worked on in the app's own process, where the key is (a child or worker runner has none).
    const wanted = deps.getSettings().record?.encryption?.enabled === true ? "inline" : deps.getSettings().advanced.runnerMode;
    const order: ("child" | "worker" | "inline")[] = wanted === "auto" ? ["child", "worker", "inline"] : wanted === "child" ? ["child"] : wanted === "worker" ? ["worker", "inline"] : ["inline"];
    for (const kind of order) {
      if (await tryTransport(kind)) {
        if (kind !== "child" && wanted === "auto") warn("node-missing");
        return mode;
      }
    }
    mode = "unavailable";
    warn("runner-unavailable");
    return mode;
  }

  const context = (): RunnerContext => ({ vaultRoot: deps.vaultRoot, vaultKey: deps.vaultKey, cacheDir: deps.cacheDir, settings: deps.getSettings(), pluginVersion: deps.pluginVersion, settingsSource: "plugin" });

  const client: RunnerClient = {
    get mode() {
      return mode;
    },
    start() {
      if (transport) return Promise.resolve(mode);
      starting ??= doStart().finally(() => {
        starting = null;
      });
      return starting;
    },
    async request<C extends RunnerCommandName>(command: Extract<RunnerCommand, { cmd: C }>, opts: RunnerRequestOptions = {}): Promise<RunnerResultMap[C]> {
      if (opts.signal?.aborted) throw new CortexError("E_CANCELLED", "cancelled");
      if (!transport) await client.start();
      const t = transport;
      if (!t || mode === "unavailable") throw new CortexError("E_NODE_MISSING", "the background program is not available", { detail: { reason: "runner-unavailable" } });
      const id = `q${++seq}`;
      let entry: Pending | undefined;
      return new Promise<RunnerResultMap[C]>((resolve, reject) => {
        const p: Pending = { cmd: command.cmd, resolve: resolve as (v: unknown) => void, reject, opts };
        entry = p;
        pending.set(id, p);
        if (opts.signal) {
          p.abort = () => {
            if (!pending.has(id)) return;
            t.send({ t: "cancel", id });
            p.grace = setTimeout(() => {
              if (!pending.delete(id)) return;
              reject(new CortexError("E_CANCELLED", "cancelled"));
              log.warn("runner ignored a cancel; restarting it");
              void t.kill();
            }, CANCEL_GRACE_MS);
          };
          opts.signal.addEventListener("abort", p.abort, { once: true });
        }
        try {
          t.send({ t: "req", id, ctx: context(), command });
        } catch (e) {
          pending.delete(id);
          reject(asCortexError(e));
        }
      }).finally(() => {
        if (entry?.abort) opts.signal?.removeEventListener("abort", entry.abort);
        pending.delete(id);
      });
    },
    cancelAll() {
      for (const id of pending.keys()) transport?.send({ t: "cancel", id });
    },
    async stop() {
      stopping = true;
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
      failAll(new CortexError("E_CANCELLED", "cancelled"));
      const t = transport;
      transport = null;
      mode = "stopped";
      if (t) await t.close();
    },
  };
  return client;
}
