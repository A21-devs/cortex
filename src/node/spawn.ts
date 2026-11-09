/**
 * Safe child processes. Owner: E1. SECURITY-CRITICAL.
 *  - never `shell: true`; arguments are passed as an array (no interpolation, no quoting games);
 *  - the executable must be an absolute path to an existing file; on Windows it must be a .exe
 *    (.cmd/.bat/.ps1 shims would need a shell and are refused); inside Electron, Electron's own binary is refused
 *    (its RunAsNode fuse is off, so it would start a second Obsidian);
 *  - stdin carries large payloads (prompts), never the command line;
 *  - the environment is exactly what the caller passes (undefined values dropped); callers pass an allowlist;
 *  - output is capped; timeouts and cancellation kill the whole process tree, but only while the child is still
 *    running (exitCode and signalCode both null), so a reused Windows PID is never killed (SAFE-05);
 *  - every live child pid is registered so the runner can tree-kill them synchronously on SIGINT, SIGTERM,
 *    SIGBREAK and exit (SKILL-LONG-RUNS, `installChildCleanup`): no orphaned claude.exe keeps spending budget.
 */
import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import * as path from "node:path";
import { CortexError } from "../shared/errors";

export interface RunOptions {
  cwd: string;
  /** The complete environment of the child (undefined values are dropped). Omit only for trusted tools. */
  env?: Record<string, string | undefined>;
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
  /** Called for each complete stdout line (streaming consumers); "\r" is trimmed. */
  onStdoutLine?: (line: string) => void;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  /** stdout went over maxStdoutBytes (the child was stopped). */
  truncated: boolean;
  durationMs: number;
}

const SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1", ".vbs", ".js", ".com"]);

function isElectron(): boolean {
  return typeof (process.versions as Record<string, string | undefined>).electron === "string";
}

export function assertExecutable(exe: string): void {
  if (typeof exe !== "string" || exe.length === 0 || exe.includes("\u0000")) throw new CortexError("E_BAD_REQUEST", "invalid executable path");
  if (!path.isAbsolute(exe)) throw new CortexError("E_BAD_REQUEST", `executable must be an absolute path: ${exe}`);
  const ext = path.extname(exe).toLowerCase();
  if (process.platform === "win32") {
    if (ext !== ".exe") throw new CortexError("E_BAD_REQUEST", `only .exe files can be launched without a shell: ${exe}`);
  } else if (SHIM_EXTENSIONS.has(ext)) {
    throw new CortexError("E_BAD_REQUEST", `scripts cannot be launched directly: ${exe}`);
  }
  if (isElectron() && path.resolve(exe).toLowerCase() === path.resolve(process.execPath).toLowerCase()) {
    throw new CortexError("E_BAD_REQUEST", "refusing to launch the host application's own executable");
  }
  let st;
  try {
    st = statSync(exe);
  } catch {
    throw new CortexError("E_ENGINE_MISSING", `executable not found: ${exe}`);
  }
  if (!st.isFile()) throw new CortexError("E_BAD_REQUEST", `not a file: ${exe}`);
}

function assertArgs(args: readonly string[]): void {
  for (const a of args) {
    if (typeof a !== "string" || a.includes("\u0000")) throw new CortexError("E_BAD_REQUEST", "invalid argument");
  }
}

function cleanEnv(env: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv | undefined {
  if (env === undefined) return undefined;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && !k.includes("=") && !k.includes("\u0000") && !v.includes("\u0000")) out[k] = v;
  }
  return out;
}

/** Pids of children started by runProcess that have not exited yet. */
export const liveChildren = new Set<number>();

function taskkillPath(): string {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
}

/** Kill every live child tree synchronously (signal handlers and process exit). Returns how many were killed. */
export function killAllChildrenSync(): number {
  let n = 0;
  for (const pid of [...liveChildren]) {
    try {
      if (process.platform === "win32") {
        spawnSync(taskkillPath(), ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore", timeout: 5000 });
      } else {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          process.kill(pid, "SIGKILL");
        }
      }
      n++;
    } catch {
      // already gone
    }
    liveChildren.delete(pid);
  }
  return n;
}

let cleanupInstalled = false;

/**
 * Install process handlers (once) that tree-kill live children when this process exits or is interrupted.
 * For a signal the process then exits with the conventional code, as it would without the handler.
 */
export function installChildCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on("exit", () => void killAllChildrenSync());
  const onSignal = (sig: NodeJS.Signals, code: number) => () => {
    killAllChildrenSync();
    // Exit as the signal would have, unless someone else handles it too.
    if (process.listenerCount(sig) <= 1) process.exit(code);
  };
  process.on("SIGINT", onSignal("SIGINT", 130));
  process.on("SIGTERM", onSignal("SIGTERM", 143));
  if (process.platform === "win32") process.on("SIGBREAK", onSignal("SIGBREAK", 149));
}

/** Kill a process and all of its children; resolves when the kill finished (or after 10 s at most). */
export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      let settled = false;
      const done = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const p = spawn(taskkillPath(), ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
      p.on("exit", done);
      p.on("error", done);
      setTimeout(done, 10_000).unref?.();
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      resolve();
    }
  });
}

/**
 * Run a process to completion with stdin input, capped output, timeout and cancellation. Never uses a shell.
 * Resolves with the exit status (a non-zero exit is not an error); rejects only when the process cannot start.
 */
export function runProcess(exe: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
  assertExecutable(exe);
  assertArgs(args);
  // Already cancelled: report a cancelled run without starting anything.
  if (opts.signal?.aborted) return Promise.resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: true, truncated: false, durationMs: 0 });
  const started = Date.now();
  const maxOut = opts.maxStdoutBytes ?? 32 * 1024 * 1024;
  const maxErr = opts.maxStderrBytes ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [...args], {
      cwd: opts.cwd,
      env: cleanEnv(opts.env),
      shell: false,
      windowsHide: true,
      // Own process group on POSIX so a timeout can kill the whole tree.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let lineCarry = "";
    let settled = false;
    const pid = child.pid;
    if (pid !== undefined) liveChildren.add(pid);
    const kill = (): void => {
      // Only while the child is still running: after exit the PID may already belong to another process.
      if (pid !== undefined && child.exitCode === null && child.signalCode === null) void killTree(pid);
    };
    const timer = opts.timeoutMs !== undefined ? setTimeout(() => ((timedOut = true), kill()), Math.max(0, opts.timeoutMs)) : undefined;
    const onAbort = (): void => {
      cancelled = true;
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      if (pid !== undefined) liveChildren.delete(pid);
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (truncated) return;
      outBytes += Buffer.byteLength(chunk);
      if (outBytes > maxOut) {
        truncated = true;
        kill();
        return;
      }
      stdout += chunk;
      if (opts.onStdoutLine) {
        const parts = (lineCarry + chunk).split("\n");
        lineCarry = parts.pop() ?? "";
        for (const p of parts) {
          try {
            opts.onStdoutLine(p.endsWith("\r") ? p.slice(0, -1) : p);
          } catch {
            // A consumer error must not break the child's pipes.
          }
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      const n = Buffer.byteLength(chunk);
      if (errBytes + n <= maxErr) stderr += chunk;
      errBytes += n;
    });
    child.on("error", (e) => {
      cleanup();
      if (settled) return;
      settled = true;
      reject(new CortexError(errorCodeOf(e) === "ENOENT" ? "E_ENGINE_MISSING" : "E_ENGINE_FAILED", `failed to start ${path.basename(exe)}: ${e.message}`, { cause: e }));
    });
    child.on("exit", () => {
      if (pid !== undefined) liveChildren.delete(pid);
    });
    child.on("close", (code, signal) => {
      cleanup();
      if (settled) return;
      settled = true;
      if (opts.onStdoutLine && lineCarry.length > 0 && !truncated) {
        try {
          opts.onStdoutLine(lineCarry.endsWith("\r") ? lineCarry.slice(0, -1) : lineCarry);
        } catch {
          // ignore consumer errors
        }
      }
      resolve({ code, signal, stdout, stderr, timedOut, cancelled, truncated, durationMs: Date.now() - started });
    });
    child.stdin.on("error", () => undefined); // EPIPE when the child exits early: reported through the exit code
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

function errorCodeOf(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}
