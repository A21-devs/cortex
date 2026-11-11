/**
 * Runner core: request bookkeeping, cancellation, lanes, frame emission. Transport-agnostic (child stdio, Node-
 * integrated worker, in-process inline, or CLI). Owner: E5.
 *
 *  - Every request frame is validated before anything runs: id, command name, and a RunnerContext whose vault
 *    root holds `.obsidian/`, whose cache folder is `…/cortex/<vaultKey>` outside the vault (SAFE-02), and
 *    whose settings pass the fail-safe migration (a distrusted value → E_SETTINGS, SAFE-08).
 *  - Lanes: imports, index and search builds, cache and ledger maintenance share one serial lane; agent passes
 *    have their own; status, queue, inspect and estimate run at once; Ask runs at once. Inline (UI-thread)
 *    runners serialise everything (concurrency 1).
 *  - Frames carry only counts, ids, codes and Cortex-built paths (SAFE-17): every error is reported with the
 *    catalogue text of its code, and `detail` keeps only numbers, booleans and plain tokens.
 *  - Progress frames are throttled per request (≥ 100 ms apart unless the phase changes or the work is done).
 */
import { existsSync } from "node:fs";
import * as path from "node:path";
import { createCancelSource, type CancelSource, type CancelToken } from "../shared/cancel";
import { asCortexError, CortexError } from "../shared/errors";
import type { Logger } from "../shared/log";
import { recordKeyState, setEncryptionConfigured } from "../shared/crypto/keyring";
import {
  MAX_FRAME_BYTES,
  RUNNER_PROTOCOL_VERSION,
  type FromRunner,
  type RunnerCommand,
  type RunnerCommandName,
  type RunnerContext,
  type RunnerErrorCode,
  type RunnerErrorInfo,
  type RunnerEvent,
  type RunnerResultMap,
  type ToRunner,
} from "../shared/protocol/runner";
import { migrateSettingsChecked } from "../shared/settings";

/** From package.json via esbuild define (RUNNER-VERSION-LICENSES); never a hand-edited literal. */
export const RUNNER_VERSION: string = typeof __CORTEX_VERSION__ === "string" ? __CORTEX_VERSION__ : "0.0.0-dev";
/** Build id shared with main.js; the plugin compares protocol version + build id, not package versions. */
export const RUNNER_BUILD: string = typeof __CORTEX_BUILD__ === "string" ? __CORTEX_BUILD__ : "dev";

export interface RunnerHost {
  readonly mode: "child" | "worker" | "inline" | "cli";
  emit(frame: FromRunner): void;
  log: Logger;
  /** No-op in a child process; a real yield to the UI thread when inline. */
  yield(): Promise<void>;
}

export interface RequestContext {
  id: string;
  ctx: RunnerContext;
  token: CancelToken;
  host: RunnerHost;
  progress(phase: string, done: number, total?: number, unit?: string, note?: string): void;
  event(e: RunnerEvent): void;
}

export type CommandHandler<C extends RunnerCommandName> = (args: Extract<RunnerCommand, { cmd: C }>["args"], rc: RequestContext) => Promise<RunnerResultMap[C]>;
/** Commands that do not touch the record, so they run while an encrypted record is locked. */
const WORKS_LOCKED: ReadonlySet<string> = new Set(["doctor", "cache.clear"]);

export type CommandHandlers = { [C in RunnerCommandName]: CommandHandler<C> };

export type Lane = "io" | "agents" | "light" | "ask";

/** Which requests may overlap (inline runners serialise everything). */
export const COMMAND_LANES: Readonly<Record<RunnerCommandName, Lane>> = {
  doctor: "light",
  import: "io",
  "index.build": "io",
  "search.build": "io",
  "agents.run": "agents",
  "agents.status": "light",
  "agents.enqueue": "light",
  "agents.dequeue": "light",
  "review.discard": "light",
  "ai.ask": "ask",
  "import.inspect": "light",
  "import.estimate": "light",
  "cache.clear": "io",
  "ledger.compact": "io",
  "seals.run": "io",
  "seals.status": "light",
  "seals.publish": "io",
  "seals.check": "io",
  "seals.auto": "io",
  "seals.proof": "light",
  "proof.entry": "io",
  "audit.pack": "io",
  "export.record": "io",
  "privacy.screened": "light",
  "consent.reads": "light",
};

const SERIAL_LANES: ReadonlySet<Lane> = new Set(["io", "agents"]);

/** Fixed text per error code (SAFE-17). The plugin maps codes to CORTEX-UX §5.31 copy. */
export const ERROR_TEXT: Readonly<Record<RunnerErrorCode, string>> = {
  E_BAD_REQUEST: "bad request",
  E_PROTOCOL: "protocol error",
  E_LOCKED: "another Cortex runner is busy",
  E_CANCELLED: "cancelled",
  E_TIMEOUT: "timed out",
  E_NODE_MISSING: "this needs Node.js 20 or later",
  E_ENGINE_MISSING: "Claude Code was not found",
  E_ENGINE_AUTH: "Claude Code needs you to sign in",
  E_ENGINE_LIMIT: "Claude Code's usage limit is reached",
  E_ENGINE_FAILED: "the model call failed",
  E_SETTINGS: "Cortex's settings could not be read safely",
  E_BUDGET_CAPPED: "the plan cap is reached",
  E_PAUSED: "Cortex's agents are paused or not set up",
  E_VALIDATION: "the model's answer did not validate",
  E_PATH_DENIED: "that path is not allowed",
  E_IO: "a file could not be read or written",
  E_PARSE: "a file could not be parsed",
  E_INTERNAL: "internal error",
};

const SAFE_TOKEN = /^[A-Za-z0-9_.:/\\@+=-]{0,200}$/;

/** Keep only values that cannot carry record text: finite numbers, booleans and plain tokens. */
export function safeDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (!/^[A-Za-z][\w]{0,40}$/.test(k)) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && SAFE_TOKEN.test(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The frame form of any error: catalogue text, the code's retry flag, filtered detail. */
export function safeErrorInfo(e: unknown): RunnerErrorInfo {
  const err = asCortexError(e);
  const info = err.toInfo();
  const out: RunnerErrorInfo = { code: info.code, message: ERROR_TEXT[info.code] ?? ERROR_TEXT.E_INTERNAL, retryable: info.retryable };
  const detail = safeDetail(info.detail);
  if (detail) out.detail = detail;
  return out;
}

const COMMANDS: ReadonlySet<string> = new Set(Object.keys(COMMAND_LANES));
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const VAULT_KEY = /^[a-z2-7]{16}$/;

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Validate a request's context (and normalise its settings). Throws E_BAD_REQUEST / E_SETTINGS. */
export function checkContext(raw: unknown): RunnerContext {
  if (typeof raw !== "object" || raw === null) throw new CortexError("E_BAD_REQUEST", "missing context");
  const c = raw as Partial<RunnerContext>;
  if (typeof c.vaultRoot !== "string" || !path.isAbsolute(c.vaultRoot)) throw new CortexError("E_BAD_REQUEST", "vault root must be absolute");
  if (!existsSync(path.join(c.vaultRoot, ".obsidian"))) throw new CortexError("E_BAD_REQUEST", "not a vault", { detail: { reason: "no-obsidian-folder" } });
  if (typeof c.vaultKey !== "string" || !VAULT_KEY.test(c.vaultKey)) throw new CortexError("E_BAD_REQUEST", "invalid vault key");
  if (typeof c.cacheDir !== "string" || !path.isAbsolute(c.cacheDir)) throw new CortexError("E_BAD_REQUEST", "cache folder must be absolute");
  const cache = path.resolve(c.cacheDir);
  if (path.basename(cache) !== c.vaultKey || path.basename(path.dirname(cache)).toLowerCase() !== "cortex") throw new CortexError("E_PATH_DENIED", "cache folder must be …/cortex/<vaultKey>");
  if (isInside(cache, c.vaultRoot) || isInside(c.vaultRoot, cache)) throw new CortexError("E_PATH_DENIED", "cache folder must be outside the vault");
  if (c.settingsSource !== "plugin" && c.settingsSource !== "data.json" && c.settingsSource !== "defaults") throw new CortexError("E_BAD_REQUEST", "invalid settings source");
  const m = migrateSettingsChecked(c.settings);
  if (m.corrupt) throw new CortexError("E_SETTINGS", "settings unreadable", { detail: { code: "settings-unreadable" } });
  return {
    vaultRoot: path.resolve(c.vaultRoot),
    vaultKey: c.vaultKey,
    cacheDir: cache,
    settings: m.settings,
    pluginVersion: typeof c.pluginVersion === "string" ? c.pluginVersion.slice(0, 64) : "unknown",
    settingsSource: c.settingsSource,
  };
}

export const PROGRESS_MIN_INTERVAL_MS = 100;

export interface RunnerCoreOptions {
  now?(): number;
}

/** Dispatches request frames to handlers; tracks in-flight requests so cancel frames can stop them. */
export class RunnerCore {
  private readonly inflight = new Map<string, CancelSource>();
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly settled = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly host: RunnerHost, private readonly handlers: CommandHandlers, opts: RunnerCoreOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  hello(): void {
    this.host.emit({ t: "hello", protocol: RUNNER_PROTOCOL_VERSION, runner: RUNNER_VERSION, build: RUNNER_BUILD, node: process.version, pid: process.pid, mode: this.host.mode });
  }

  handle(frame: ToRunner): void {
    switch (frame.t) {
      case "ping":
        this.host.emit({ t: "pong", n: typeof frame.n === "number" ? frame.n : 0 });
        return;
      case "cancel":
        if (typeof frame.id === "string") this.inflight.get(frame.id)?.cancel();
        return;
      case "shutdown":
        this.cancelAll();
        return;
      case "req":
        this.accept(frame);
        return;
      default:
        this.host.emit({ t: "error", error: { code: "E_PROTOCOL", message: ERROR_TEXT.E_PROTOCOL, retryable: false } });
    }
  }

  cancelAll(): void {
    for (const s of this.inflight.values()) s.cancel();
  }

  get busy(): boolean {
    return this.inflight.size > 0;
  }

  /** Resolves once no request is in flight. */
  idle(): Promise<void> {
    if (this.inflight.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (this.inflight.size === 0) {
          this.settled.delete(check);
          resolve();
        }
      };
      this.settled.add(check);
    });
  }

  private accept(frame: Extract<ToRunner, { t: "req" }>): void {
    const id = frame.id;
    if (typeof id !== "string" || !REQUEST_ID.test(id)) {
      this.host.emit({ t: "error", error: { code: "E_PROTOCOL", message: ERROR_TEXT.E_PROTOCOL, retryable: false } });
      return;
    }
    if (this.inflight.has(id)) {
      this.host.emit({ t: "error", error: { code: "E_PROTOCOL", message: ERROR_TEXT.E_PROTOCOL, retryable: false, detail: { reason: "duplicate-id" } } });
      return;
    }
    const command = frame.command as RunnerCommand | undefined;
    if (typeof command !== "object" || command === null || typeof command.cmd !== "string" || !COMMANDS.has(command.cmd) || typeof command.args !== "object" || command.args === null) {
      this.host.emit({ t: "error", id, error: { code: "E_BAD_REQUEST", message: ERROR_TEXT.E_BAD_REQUEST, retryable: false, detail: { reason: "unknown-command" } } });
      return;
    }
    let ctx: RunnerContext;
    try {
      ctx = checkContext(frame.ctx);
    } catch (e) {
      this.host.emit({ t: "error", id, error: safeErrorInfo(e) });
      return;
    }
    const source = createCancelSource();
    this.inflight.set(id, source);
    const lane: string = this.host.mode === "inline" ? "all" : COMMAND_LANES[command.cmd];
    const serial = this.host.mode === "inline" || SERIAL_LANES.has(COMMAND_LANES[command.cmd]);
    const start = () => this.run(id, ctx, command, source);
    if (!serial) {
      void start();
      return;
    }
    const prev = this.lanes.get(lane) ?? Promise.resolve();
    const next = prev.then(start, start);
    this.lanes.set(lane, next);
    void next.then(() => {
      if (this.lanes.get(lane) === next) this.lanes.delete(lane);
    });
  }

  private async run(id: string, ctx: RunnerContext, command: RunnerCommand, source: CancelSource): Promise<void> {
    // An encrypted record is never written plain from here: a runner without the key refuses writes (E_LOCKED); the inline runner shares the plugin's key.
    if (ctx.settings?.record?.encryption?.enabled === true) setEncryptionConfigured(true);
    let lastProgress = 0;
    let lastPhase = "";
    const rc: RequestContext = {
      id,
      ctx,
      token: source.token,
      host: this.host,
      progress: (phase, done, total, unit, note) => {
        const t = this.now();
        const finished = total !== undefined && done >= total;
        if (phase === lastPhase && !finished && t - lastProgress < PROGRESS_MIN_INTERVAL_MS) return;
        lastProgress = t;
        lastPhase = phase;
        this.host.emit({ t: "progress", id, phase, done, ...(total !== undefined ? { total } : {}), ...(unit !== undefined ? { unit } : {}), ...(note !== undefined ? { note } : {}) });
      },
      event: (event) => this.host.emit({ t: "event", id, event }),
    };
    try {
      if (source.token.cancelled) throw new CortexError("E_CANCELLED", "cancelled");
      // A locked encrypted record is neither read nor written: an index built now would be empty, and an import refused halfway helps nobody.
      if (recordKeyState() === "locked" && !WORKS_LOCKED.has(command.cmd)) throw new CortexError("E_LOCKED", "the record is encrypted and locked", { detail: { reason: "record-locked" } });
      const handler = this.handlers[command.cmd] as CommandHandler<typeof command.cmd>;
      const data = await handler(command.args as never, rc);
      const frame: FromRunner = { t: "result", id, ok: true, cmd: command.cmd, data };
      if (JSON.stringify(frame).length > MAX_FRAME_BYTES) throw new CortexError("E_INTERNAL", "result too large", { detail: { reason: "frame-too-large" } });
      this.host.emit(frame);
    } catch (e) {
      const err = asCortexError(e);
      if (err.code === "E_INTERNAL" || err.code === "E_NOT_IMPLEMENTED") this.host.log.error("request failed", { cmd: command.cmd, code: err.code, name: e instanceof Error ? e.name : typeof e });
      else this.host.log.debug("request failed", { cmd: command.cmd, code: err.code });
      this.host.emit({ t: "error", id, error: safeErrorInfo(err) });
    } finally {
      this.inflight.delete(id);
      for (const fn of [...this.settled]) fn();
    }
  }
}
