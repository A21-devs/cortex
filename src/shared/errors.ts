/**
 * The error type shared by every bundle (plugin, worker, runner). Owner: E1.
 *
 * Errors that cross a process or thread boundary travel as `RunnerErrorInfo` (code + fixed message + detail);
 * `fromErrorInfo` rebuilds them on the other side. Codes come from a fixed catalogue (SAFE-17), so the UI maps a
 * code to its own copy and never shows raw error text from a frame. `isCortexError` also recognises errors built
 * by another bundle (an `instanceof` check fails across a worker or a second copy of this module).
 */
import type { RunnerErrorCode, RunnerErrorInfo } from "./protocol/runner";

/** Codes that exist only inside one bundle; `toInfo()` reports them as E_INTERNAL across a boundary. */
export type LocalErrorCode = "E_NOT_IMPLEMENTED" | "E_WEBGL" | "E_WORKER";
export type CortexErrorCode = RunnerErrorCode | LocalErrorCode;

const RUNNER_CODES: ReadonlySet<string> = new Set<RunnerErrorCode>([
  "E_BAD_REQUEST",
  "E_PROTOCOL",
  "E_LOCKED",
  "E_CANCELLED",
  "E_TIMEOUT",
  "E_NODE_MISSING",
  "E_ENGINE_MISSING",
  "E_ENGINE_AUTH",
  "E_ENGINE_LIMIT",
  "E_ENGINE_FAILED",
  "E_SETTINGS",
  "E_BUDGET_CAPPED",
  "E_PAUSED",
  "E_VALIDATION",
  "E_PATH_DENIED",
  "E_IO",
  "E_PARSE",
  "E_INTERNAL",
]);
const LOCAL_CODES: ReadonlySet<string> = new Set<LocalErrorCode>(["E_NOT_IMPLEMENTED", "E_WEBGL", "E_WORKER"]);

/** True for every code in the catalogue (runner codes and bundle-local codes). */
export function isCortexErrorCode(code: unknown): code is CortexErrorCode {
  return typeof code === "string" && (RUNNER_CODES.has(code) || LOCAL_CODES.has(code));
}

/** True for the codes that may travel in a runner frame. */
export function isRunnerErrorCode(code: unknown): code is RunnerErrorCode {
  return typeof code === "string" && RUNNER_CODES.has(code);
}

export interface CortexErrorOptions {
  retryable?: boolean;
  detail?: Record<string, unknown>;
  cause?: unknown;
}

export class CortexError extends Error {
  readonly code: CortexErrorCode;
  readonly retryable: boolean;
  readonly detail?: Record<string, unknown>;

  constructor(code: CortexErrorCode, message: string, opts: CortexErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "CortexError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    if (opts.detail !== undefined) this.detail = opts.detail;
  }

  /** The frame form. Bundle-local codes become E_INTERNAL; the detail is copied, never shared. */
  toInfo(): RunnerErrorInfo {
    const code: RunnerErrorCode = isRunnerErrorCode(this.code) ? this.code : "E_INTERNAL";
    const info: RunnerErrorInfo = { code, message: this.message, retryable: this.retryable };
    if (this.detail !== undefined) info.detail = { ...this.detail };
    return info;
  }
}

/**
 * True for a CortexError from this module or from another bundle (same name and a catalogue code). The duck
 * test matters for errors rebuilt by a worker or a runner that loaded its own copy of this file.
 */
export function isCortexError(e: unknown): e is CortexError {
  if (e instanceof CortexError) return true;
  if (typeof e !== "object" || e === null) return false;
  const o = e as { name?: unknown; code?: unknown; message?: unknown };
  return o.name === "CortexError" && isCortexErrorCode(o.code) && typeof o.message === "string";
}

/** True when `e` means "the work was cancelled" (a CortexError E_CANCELLED or a DOM/Node AbortError). */
export function isCancellation(e: unknown): boolean {
  if (isCortexError(e)) return e.code === "E_CANCELLED";
  if (typeof e !== "object" || e === null) return false;
  const o = e as { name?: unknown; code?: unknown };
  return o.name === "AbortError" || o.code === "ABORT_ERR";
}

/** Node system error codes that mean the file system refused or failed (mapped to E_IO). */
const FS_CODES = new Set(["ENOENT", "EEXIST", "EPERM", "EACCES", "EBUSY", "EISDIR", "ENOTDIR", "ENOTEMPTY", "EMFILE", "ENFILE", "ENOSPC", "EROFS", "EXDEV", "EIO", "ETXTBSY", "ELOOP", "ENAMETOOLONG"]);

/** The message of anything thrown, without a stack. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

/** Normalise anything thrown into a CortexError (cancellation and file-system errors keep their meaning). */
export function asCortexError(e: unknown, fallback: CortexErrorCode = "E_INTERNAL"): CortexError {
  if (e instanceof CortexError) return e;
  if (isCortexError(e)) {
    const o = e as CortexError;
    return new CortexError(o.code, o.message, { retryable: o.retryable === true, ...(o.detail !== undefined ? { detail: o.detail } : {}), cause: e });
  }
  if (isCancellation(e)) return new CortexError("E_CANCELLED", "cancelled", { cause: e });
  if (e instanceof Error) {
    const sys = (e as { code?: unknown }).code;
    if (typeof sys === "string" && FS_CODES.has(sys)) {
      const retryable = sys === "EBUSY" || sys === "EPERM" || sys === "EACCES" || sys === "EMFILE" || sys === "ENFILE";
      return new CortexError("E_IO", e.message, { retryable, detail: { code: sys }, cause: e });
    }
    return new CortexError(fallback, e.message, { cause: e });
  }
  return new CortexError(fallback, errorMessage(e));
}

/** Rebuild an error that arrived in a frame; unknown codes become E_PROTOCOL (never trusted as-is). */
export function fromErrorInfo(info: unknown): CortexError {
  if (typeof info !== "object" || info === null) return new CortexError("E_PROTOCOL", "malformed error frame");
  const o = info as { code?: unknown; message?: unknown; retryable?: unknown; detail?: unknown };
  const code: CortexErrorCode = isRunnerErrorCode(o.code) ? o.code : "E_PROTOCOL";
  const message = typeof o.message === "string" ? o.message.slice(0, 2000) : "error";
  const detail = typeof o.detail === "object" && o.detail !== null && !Array.isArray(o.detail) ? { ...(o.detail as Record<string, unknown>) } : undefined;
  return new CortexError(code, message, { retryable: o.retryable === true, ...(detail !== undefined ? { detail } : {}) });
}

/**
 * @deprecated Scaffold helper kept only while other modules still call it during the parallel build; it is
 * removed at integration once no call site remains. Throws a CortexError with code E_NOT_IMPLEMENTED.
 */
export function notImplemented(what: string): never {
  throw new CortexError("E_NOT_IMPLEMENTED", `${what} is not implemented yet`);
}
