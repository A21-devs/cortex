/**
 * cortex-runner.js entry point. Owner: E5.
 * Three ways in (same RunnerCore, same frames):
 *   1. `node cortex-runner.js serve`     child of the plugin, JSON lines on stdio (cwd = the local cache);
 *   2. `serveWorker(self)` inside a Node-integrated Web Worker (frames over postMessage), or
 *      `createInlineRunner(onFrame)` in-process as a last resort when no system Node is available;
 *   3. `node cortex-runner.js <cmd>`     Claude Code skill / terminal (bounded by --max-seconds, default 90).
 * stdout carries ONLY protocol frames in serve/--json mode; diagnostics go to stderr. Frames never echo record
 * text (SAFE-17). On SIGINT, SIGTERM, SIGBREAK and exit every live engine child tree is killed synchronously
 * (SKILL-LONG-RUNS). Runner code never uses child_process.fork or process.execPath (inside Obsidian the latter
 * is Obsidian.exe): enforced by scripts/check-boundaries.mjs.
 */
import * as readline from "node:readline";
import { yieldToHost } from "../shared/cancel";
import { asCortexError } from "../shared/errors";
import { consoleSink, createLogger, type Logger } from "../shared/log";
import { isToRunner, MAX_FRAME_BYTES, type FromRunner, type ToRunner } from "../shared/protocol/runner";
import { killAllChildrenSync } from "../node/spawn";
import { HELP_TEXT, parseArgv } from "./cli";
import { createHandlers } from "./commands";
import { ERROR_TEXT, RUNNER_BUILD, RUNNER_VERSION, RunnerCore, safeErrorInfo, type RunnerHost } from "./host";
import { setEncryptionConfigured } from "../shared/crypto/keyring";
import { loadRunnerContext } from "./settingsLoader";

export { RUNNER_BUILD, RUNNER_VERSION };

export interface InlineRunner {
  send(frame: ToRunner): void;
  dispose(): void;
}

const protocolError = (reason: string): FromRunner => ({ t: "error", error: { code: "E_PROTOCOL", message: ERROR_TEXT.E_PROTOCOL, retryable: false, detail: { reason } } });

/** In-process runner used by the plugin when no system Node is available (imports only; agents refuse). */
export function createInlineRunner(onFrame: (frame: FromRunner) => void, log?: Logger): InlineRunner {
  const host: RunnerHost = {
    mode: "inline",
    emit: onFrame,
    log: log ?? createLogger("runner", consoleSink, () => false),
    yield: yieldToHost,
  };
  const core = new RunnerCore(host, createHandlers());
  core.hello();
  let disposed = false;
  return {
    send: (f) => {
      if (disposed) return;
      if (!isToRunner(f)) {
        host.emit(protocolError("unknown-frame"));
        return;
      }
      core.handle(f);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      core.cancelAll();
      killAllChildrenSync();
    },
  };
}

/** The message port of a (Node-integrated) Web Worker, structurally. */
export interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  close?(): void;
}

/**
 * Serve the protocol inside a Node-integrated Web Worker (INLINE-FALLBACK-UI-THREAD): the same frames over
 * postMessage, off the UI thread. Returns a disposer.
 */
export function serveWorker(scope: WorkerScope, log?: Logger): () => void {
  const host: RunnerHost = {
    mode: "worker",
    emit: (f) => scope.postMessage(f),
    log: log ?? createLogger("runner", consoleSink, () => false),
    yield: async () => undefined,
  };
  const core = new RunnerCore(host, createHandlers());
  let closed = false;
  const dispose = () => {
    if (closed) return;
    closed = true;
    core.cancelAll();
    killAllChildrenSync();
  };
  scope.addEventListener("message", (ev) => {
    if (closed) return;
    const frame = ev.data;
    if (!isToRunner(frame)) {
      host.emit(protocolError("unknown-frame"));
      return;
    }
    if (frame.t === "shutdown") {
      dispose();
      void core.idle().then(() => scope.close?.());
      return;
    }
    core.handle(frame);
  });
  core.hello();
  return dispose;
}

/** Cancel work and tree-kill engine children on every way the process can be told to stop. */
export function installSignalHandlers(cancelAll: () => void): void {
  const stop = () => {
    cancelAll();
    killAllChildrenSync();
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
    process.on(sig, () => {
      stop();
      process.exitCode = 130;
      setTimeout(() => process.exit(), 50).unref();
    });
  }
  process.on("exit", () => killAllChildrenSync());
}

function stderrLogger(): Logger {
  return createLogger(
    "runner",
    (level, scope, msg, data) => {
      process.stderr.write(`[${level}] ${scope}: ${msg}${data ? " " + JSON.stringify(data) : ""}\n`);
    },
    () => process.env.CORTEX_DEBUG === "1",
  );
}

/** One JSON line per frame; a frame over the size limit is replaced by an error (results reference files). */
function frameLine(f: FromRunner): string {
  const line = JSON.stringify(f);
  if (line.length <= MAX_FRAME_BYTES) return line + "\n";
  const id = "id" in f && typeof f.id === "string" ? f.id : undefined;
  return JSON.stringify({ t: "error", ...(id ? { id } : {}), error: { code: "E_INTERNAL", message: ERROR_TEXT.E_INTERNAL, retryable: false, detail: { reason: "frame-too-large" } } }) + "\n";
}

/** `serve`: the plugin's child. Exits when stdin closes (parent gone) or on a shutdown frame. */
export function serve(): void {
  const log = stderrLogger();
  const host: RunnerHost = {
    mode: "child",
    emit: (f) => void process.stdout.write(frameLine(f)),
    log,
    yield: async () => undefined,
  };
  const core = new RunnerCore(host, createHandlers());
  process.on("uncaughtException", (e) => {
    log.error("uncaught exception", { code: asCortexError(e).code, name: e.name });
  });
  process.on("unhandledRejection", (e) => {
    log.error("unhandled rejection", { code: asCortexError(e).code });
  });
  core.hello();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let exiting = false;
  const exitWhenIdle = (graceMs: number) => {
    if (exiting) return;
    exiting = true;
    core.cancelAll();
    killAllChildrenSync();
    const done = () => process.exit(0);
    void core.idle().then(done);
    setTimeout(done, graceMs).unref();
  };
  rl.on("line", (line) => {
    if (!line.trim()) return;
    if (line.length > MAX_FRAME_BYTES) {
      host.emit(protocolError("frame-too-large"));
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      host.emit(protocolError("invalid-json"));
      return;
    }
    if (!isToRunner(frame)) {
      host.emit(protocolError("unknown-frame"));
      return;
    }
    if (frame.t === "shutdown") {
      exitWhenIdle(2000);
      return;
    }
    core.handle(frame);
  });
  // Parent gone (stdin closed): cancel everything and exit within 2 s.
  rl.on("close", () => exitWhenIdle(2000));
  installSignalHandlers(() => core.cancelAll());
}

/** Exit codes of the CLI. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/** Run one CLI command; resolves with the exit code (serve never resolves with a code: -1). */
export async function runCli(argv: readonly string[], io: { out(s: string): void; err(s: string): void } = { out: (s) => void process.stdout.write(s), err: (s) => void process.stderr.write(s) }, runnerFile = __filename): Promise<number> {
  const inv = parseArgv(argv);
  if (inv.mode === "serve") {
    serve();
    return -1;
  }
  if (inv.mode === "help" || !inv.command) {
    if (inv.errors.length > 0) {
      io.err(inv.errors.join("\n") + "\n\n" + HELP_TEXT);
      return EXIT.usage;
    }
    io.out(HELP_TEXT);
    return EXIT.ok;
  }
  if (inv.errors.length > 0) {
    io.err(inv.errors.join("\n") + "\n");
    return EXIT.usage;
  }
  let ctx;
  try {
    ctx = loadRunnerContext(inv.vault, runnerFile);
    if (ctx.settings.record.encryption.enabled) setEncryptionConfigured(true);
  } catch (e) {
    const info = safeErrorInfo(e);
    if (inv.json) io.out(JSON.stringify({ t: "error", error: info }) + "\n");
    else io.err(`error ${info.code}: ${info.message}\n`);
    return EXIT.failed;
  }
  const command = inv.command;
  const log = stderrLogger();
  return new Promise<number>((resolve) => {
    let finished = false;
    const host: RunnerHost = {
      mode: "cli",
      emit: (f) => {
        if (inv.json) io.out(frameLine(f));
        else if (f.t === "progress" && !inv.quiet) io.err(`${f.phase} ${f.done}${f.total !== undefined ? "/" + f.total : ""}${f.unit ? " " + f.unit : ""}\n`);
        else if (f.t === "result") io.out(JSON.stringify(f.data, null, 2) + "\n");
        else if (f.t === "error") io.err(`error ${f.error.code}: ${f.error.message}\n`);
        if (f.t === "result" && f.id === "cli" && !finished) {
          finished = true;
          resolve(EXIT.ok);
        }
        if (f.t === "error" && f.id === "cli" && !finished) {
          finished = true;
          resolve(EXIT.failed);
        }
      },
      log,
      yield: async () => undefined,
    };
    const core = new RunnerCore(host, createHandlers());
    installSignalHandlers(() => core.cancelAll());
    // Last-resort bound (SKILL-LONG-RUNS): handlers stop by themselves at --max-seconds; if one does not within
    // half a minute more, the request is cancelled so the skill's foreground call always ends.
    const maxSeconds = (command.args as { maxSeconds?: unknown }).maxSeconds;
    if (typeof maxSeconds === "number" && maxSeconds > 0) setTimeout(() => core.cancelAll(), (maxSeconds + 30) * 1000).unref();
    core.handle({ t: "req", id: "cli", ctx, command });
  });
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      if (code >= 0) {
        process.exitCode = code;
        // Leave no timers or children behind: a bounded CLI pass ends here.
        killAllChildrenSync();
        setTimeout(() => process.exit(code), 100).unref();
      }
    },
    (e: unknown) => {
      process.stderr.write(`fatal ${asCortexError(e).code}\n`);
      killAllChildrenSync();
      process.exitCode = 1;
    },
  );
}
