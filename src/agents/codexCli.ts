/**
 * Codex CLI engine: the person's own OpenAI/ChatGPT agent subscription, run headless. Owner: no-model-engines.
 *
 * Invocation (flags as `codex exec --help` lists them; every flag below is checked against that help first):
 *   codex exec --sandbox read-only --skip-git-repo-check --ephemeral --color never --json
 *     --output-last-message <tmp file> --cd <empty folder> -c approval_policy="never" [--model <name>] -
 *   The whole prompt (system text, the JSON-only instruction with the schema, then the record data) goes on STDIN,
 *   never on the command line. Every call is a fresh process with shell:false, killed (whole tree) on timeout or
 *   cancel (node/spawn.ts), in an empty folder that holds nothing Codex would load (no AGENTS.md, no .codex).
 *
 * Read-only, no tools: Codex has no switch that removes its shell tool, so the call runs in the read-only sandbox
 * with approvals set to "never" (nothing can be written or run with side effects, and nothing asks), in an empty
 * folder, and the prompt tells it to answer from the text alone. Output is parsed as JSON and handed to the job,
 * which validates it against the call's schema (one repair call) exactly as it does for Claude Code: this engine
 * never executes or follows anything the model says, and a reply that is not a JSON object is a failed call.
 * (The schema is not passed as --output-schema: OpenAI's structured outputs accept only a strict subset of JSON
 * Schema, and Cortex validates the answer itself either way.)
 *
 * Environment: the same allowlist as the Claude engine (no ANTHROPIC_*, no OPENAI_*), plus CODEX_HOME so a Codex
 * sign-in kept in a custom folder is found. Sign in once with `codex login`; Cortex never sees or stores the login.
 *
 * Privacy: the text goes to OpenAI through the person's own Codex login, which is the point of choosing this
 * engine. The same guards as every engine apply before it is called: kill switches, the privacy policy and
 * redaction (agents/privacy.ts), the read record logged first, the daily budget and the per-call token ceiling
 * (GuardedEngine in agents/scheduler.ts). Run records carry engine "codex-cli", where "remote", paidBy "plan".
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { CortexError } from "../shared/errors";
import type { Logger } from "../shared/log";
import { estimateTextTokens, parseJsonText } from "../shared/localModel";
import { isValidModelAlias } from "../shared/settings";
import { runProcess, type RunResult } from "../node/spawn";
import { cleanVersion, ENV_ALLOWLIST, limitResumeAt, rejectedFlag, type CliFailure } from "./claudeCli";
import type { Engine, EngineError, EngineProbe, EngineRequest, EngineResult, EngineUsage } from "./engine";
import { zeroUsage } from "./engine";

/** Flags without which the call is not isolated: if the CLI lacks one, agents stay off (never a silent fallback). */
export const CODEX_MANDATORY_FLAGS: readonly string[] = ["--sandbox", "--skip-git-repo-check", "--output-last-message", "--cd"];
/** Flags that only tighten or tidy the call; a CLI that rejects one is retried without it, once. */
export const CODEX_OPTIONAL_FLAGS: readonly string[] = ["--ephemeral", "--color", "--json", "--config", "--model"];
/** Files a Codex run would load from its working folder (they must not exist there). */
export const CODEX_CWD_FORBIDDEN: readonly string[] = ["AGENTS.md", "AGENTS.override.md", ".codex"];

export interface CodexCliConfig {
  /** Absolute path to codex.exe. */
  exe: string;
  /** Empty working directory for the headless call. */
  cwd: string;
  /** Folder for per-call temp files (the last message). */
  tmpDir: string;
  /** A Codex model name; "" or invalid = the CLI's own default. */
  model: string;
  /** Prepended arguments (tests run a fake CLI as `node fake-codex.mjs …`). */
  preArgs?: string[];
  /** Base environment (default process.env); always filtered through codexEnv(). */
  env?: Record<string, string | undefined>;
  /** Timeout of the --version / --help probe. */
  probeTimeoutMs?: number;
}

export interface CodexArgsInput {
  outFile: string;
  cwd: string;
  model?: string;
  omit?: ReadonlySet<string>;
}

/** The argument vector of one call. Everything after `exec` is a fixed flag or a value Cortex built. */
export function buildCodexArgs(a: CodexArgsInput): string[] {
  const omit = a.omit ?? new Set<string>();
  if (a.model !== undefined && a.model.length > 0 && !isValidModelAlias(a.model)) throw new CortexError("E_BAD_REQUEST", "invalid model name");
  const args = ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--output-last-message", a.outFile, "--cd", a.cwd];
  if (!omit.has("--ephemeral")) args.push("--ephemeral");
  if (!omit.has("--color")) args.push("--color", "never");
  if (!omit.has("--json")) args.push("--json");
  if (!omit.has("--config")) args.push("-c", 'approval_policy="never"');
  if (a.model && !omit.has("--model")) args.push("--model", a.model);
  args.push("-");
  return args;
}

/** Child environment from the allowlist plus CODEX_HOME. No API keys of any provider pass. */
export function codexEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const up = k.toUpperCase();
    if (ENV_ALLOWLIST.includes(up) || up === "CODEX_HOME") env[k] = v;
  }
  return env;
}

/** Flags advertised by `codex exec --help`, matched as whole tokens. */
export function parseCodexHelp(help: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const f of new Set([...CODEX_MANDATORY_FLAGS, ...CODEX_OPTIONAL_FLAGS])) {
    const re = new RegExp(`(^|[\\s,(\\[|])${f.replace(/-/g, "\\-")}(?=[\\s,=<\\])|]|$)`, "m");
    out[f] = re.test(help);
  }
  return out;
}

export function codexMissingMandatory(flags: Record<string, boolean>): string[] {
  return CODEX_MANDATORY_FLAGS.filter((f) => flags[f] !== true);
}

/** What `--json` printed, read line by line (lines that are not JSON, or not events, are ignored). */
export interface CodexEvents {
  usage?: { input: number; cached: number; output: number };
  /** The last agent message of the run (a fallback for a missing --output-last-message file). */
  lastMessage?: string;
  /** The error messages the run reported. */
  errors: string[];
  completed: boolean;
}

const nn = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export function parseCodexEvents(stdout: string): CodexEvents {
  const out: CodexEvents = { errors: [], completed: false };
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    if (typeof ev !== "object" || ev === null) continue;
    const e = ev as Record<string, unknown>;
    const type = typeof e.type === "string" ? e.type : "";
    if (type === "turn.completed") {
      out.completed = true;
      const u = e.usage as Record<string, unknown> | undefined;
      if (u && typeof u === "object") out.usage = { input: nn(u.input_tokens), cached: nn(u.cached_input_tokens), output: nn(u.output_tokens) };
    } else if (type === "item.completed") {
      const item = e.item as Record<string, unknown> | undefined;
      if (item && item.type === "agent_message" && typeof item.text === "string") out.lastMessage = item.text;
    } else if (type === "error" && typeof e.message === "string") out.errors.push(e.message);
    else if (type === "turn.failed") {
      const er = e.error as Record<string, unknown> | undefined;
      if (er && typeof er.message === "string") out.errors.push(er.message);
    }
  }
  return out;
}

const AUTH_RE = /not logged in|please (?:run|use) `?codex login|log ?in required|sign ?in (?:again|required)|invalid api key|incorrect api key|unauthorized|\b401\b|authentication[_ ](?:error|failed)|token (?:has )?expired|refresh token/;
const LIMIT_RE = /usage limit|hit your (?:\w+ ){0,2}limit|reached your (?:\w+ ){0,2}limit|limit (?:will )?reset|quota (?:exceeded|exhausted)|insufficient[_ ]quota|try again (?:at|in) /;
const OVERLOAD_RE = /\b(?:429|503|529)\b|rate.?limit|overloaded|too many requests|at capacity/;
const NETWORK_RE = /econnrefused|econnreset|enotfound|eai_again|etimedout|enetunreach|ehostunreach|fetch failed|network error|connection error|socket hang up|getaddrinfo|unable to connect|stream disconnected|error sending request|tls|certificate/;

/** Map a failed run to an error code from the exit code, stderr and the events (never from the model's own text). */
export function classifyCodexFailure(exitCode: number | null, stderr: string, events: CodexEvents, timedOut: boolean, now = Date.now()): CliFailure {
  if (timedOut) return { code: "E_TIMEOUT", retryable: true, message: "model call timed out" };
  const flag = rejectedFlag(stderr);
  if (flag) {
    const mandatory = CODEX_MANDATORY_FLAGS.includes(flag);
    return { code: "E_ENGINE_FAILED", retryable: !mandatory, message: mandatory ? "Codex rejected an isolation flag" : "Codex rejected an option", flag, reason: "flag-rejected", ...(mandatory ? { state: "unsafe" as const } : {}) };
  }
  const text = `${stderr}\n${events.errors.join("\n")}`.toLowerCase();
  if (AUTH_RE.test(text)) return { code: "E_ENGINE_AUTH", retryable: false, message: "Codex is not signed in", state: "auth" };
  if (LIMIT_RE.test(text)) return { code: "E_ENGINE_LIMIT", retryable: false, message: "usage limit reached", resumeAt: limitResumeAt(`${stderr}\n${events.errors.join("\n")}`, now), state: "limit" };
  if (OVERLOAD_RE.test(text)) return { code: "E_ENGINE_FAILED", retryable: true, message: "rate limited or overloaded", state: "offline", reason: "overloaded" };
  if (NETWORK_RE.test(text)) return { code: "E_ENGINE_FAILED", retryable: true, message: "Codex could not reach the service", state: "offline", reason: "network" };
  return { code: "E_ENGINE_FAILED", retryable: exitCode !== 0, message: "the model call failed", reason: "exit" };
}

/** Entries of the working folder that Codex would load (they must not exist). */
export async function codexForbiddenEntries(cwd: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fsp.readdir(cwd);
  } catch {
    return [];
  }
  const lower = new Set(CODEX_CWD_FORBIDDEN.map((n) => n.toLowerCase()));
  return names.filter((n) => lower.has(n.toLowerCase()));
}

const JSON_ONLY =
  "You are a text-to-JSON function. Answer from the text below alone: do not run commands, read or write files, browse the web or use any tool. Reply with exactly one JSON object that matches the JSON Schema below, and nothing else: no prose, no code fence.";

/** The one stdin prompt: system text, the JSON-only instruction with the schema, then the record data. */
export function codexPrompt(req: Pick<EngineRequest, "system" | "prompt" | "schema">): string {
  return [req.system.trim(), JSON_ONLY, `JSON Schema:\n${JSON.stringify(req.schema)}`, req.prompt].filter((x) => x.length > 0).join("\n\n");
}

export class CodexCliEngine implements Engine {
  readonly kind = "codex-cli" as const;
  readonly where = "remote" as const;
  readonly paidBy = "plan" as const;
  /** Optional flags this CLI rejected or does not advertise (never sent again by this instance). */
  private readonly disabled = new Set<string>();

  constructor(private readonly cfg: CodexCliConfig, private readonly log: Logger) {}

  private command(args: string[]): { exe: string; args: string[] } {
    return { exe: this.cfg.exe, args: [...(this.cfg.preArgs ?? []), ...args] };
  }

  private env(): Record<string, string> {
    return codexEnv(this.cfg.env ?? process.env);
  }

  /** Keys (never values) of the environment a call would receive. */
  envKeys(): string[] {
    return Object.keys(this.env()).sort();
  }

  disabledFlags(): string[] {
    return [...this.disabled].sort();
  }

  /** Free check: the version and the help only. Never sends a prompt. */
  async probe(): Promise<EngineProbe> {
    const timeoutMs = this.cfg.probeTimeoutMs ?? 15_000;
    try {
      await fsp.mkdir(this.cfg.cwd, { recursive: true });
      const v = this.command(["--version"]);
      const ver = await runProcess(v.exe, v.args, { cwd: this.cfg.cwd, timeoutMs, env: this.env(), maxStdoutBytes: 64 * 1024 });
      const h = this.command(["exec", "--help"]);
      const help = await runProcess(h.exe, h.args, { cwd: this.cfg.cwd, timeoutMs, env: this.env(), maxStdoutBytes: 1024 * 1024 });
      const flags = parseCodexHelp(`${help.stdout}\n${help.stderr}`);
      const missing = codexMissingMandatory(flags);
      for (const f of CODEX_OPTIONAL_FLAGS) if (flags[f] !== true) this.disabled.add(f);
      const version = cleanVersion(ver.stdout);
      const ok = ver.code === 0 && help.code === 0 && missing.length === 0;
      const detail = ok ? "ready" : ver.code !== 0 || help.code !== 0 ? "did not answer" : "isolation flags missing";
      return { ok, ...(version ? { version } : {}), flags, missingMandatory: missing, detail };
    } catch (e) {
      const missing = e instanceof CortexError && (e.code === "E_ENGINE_MISSING" || e.code === "E_BAD_REQUEST");
      return { ok: false, flags: {}, missingMandatory: [...CODEX_MANDATORY_FLAGS], detail: missing ? "not found" : "could not start" };
    }
  }

  private fail(error: EngineError, started: boolean, t0: number, usage?: EngineUsage): EngineResult {
    const res: EngineResult = { ok: false, error, durationMs: Date.now() - t0, started };
    if (usage) res.usage = usage;
    return res;
  }

  private usageOf(ev: CodexEvents, promptChars: number, outChars: number): EngineUsage {
    if (ev.usage) {
      // Codex counts cached input inside input_tokens: split it so the cache share is not charged twice.
      const cached = Math.min(ev.usage.cached, ev.usage.input);
      return { inputTokens: ev.usage.input - cached, outputTokens: ev.usage.output, cacheReadTokens: cached, cacheWriteTokens: 0, costUsd: 0, estimated: false, models: [] };
    }
    return { ...zeroUsage(true), inputTokens: estimateTextTokens(promptChars), outputTokens: estimateTextTokens(outChars) };
  }

  async run(req: EngineRequest): Promise<EngineResult> {
    const t0 = Date.now();
    if (req.signal.aborted) return this.fail({ code: "E_CANCELLED", message: "cancelled", retryable: false }, false, t0);
    try {
      await fsp.mkdir(this.cfg.cwd, { recursive: true });
      await fsp.mkdir(this.cfg.tmpDir, { recursive: true });
    } catch {
      return this.fail({ code: "E_IO", message: "the agent folder could not be created", retryable: true }, false, t0);
    }
    const forbidden = await codexForbiddenEntries(this.cfg.cwd);
    if (forbidden.length > 0) {
      this.log.warn("codex folder holds files Codex would load", { names: forbidden.length });
      return this.fail({ code: "E_ENGINE_FAILED", message: "the agent folder is not empty", retryable: false, state: "unsafe", reason: "cwd-not-empty" }, false, t0);
    }
    const model = isValidModelAlias(this.cfg.model) ? this.cfg.model : undefined;
    const prompt = codexPrompt(req);
    const outFile = path.join(this.cfg.tmpDir, `codex-${req.runId.replace(/[^\w-]/g, "")}-${Math.random().toString(36).slice(2, 10)}.txt`);
    try {
      for (let attempt = 0; attempt < CODEX_OPTIONAL_FLAGS.length + 1; attempt++) {
        const input: CodexArgsInput = { outFile, cwd: this.cfg.cwd, omit: this.disabled };
        if (model) input.model = model;
        let args: string[];
        try {
          args = buildCodexArgs(input);
        } catch (e) {
          return this.fail({ code: "E_BAD_REQUEST", message: e instanceof CortexError ? e.message : "invalid call", retryable: false }, false, t0);
        }
        let r: RunResult;
        try {
          const cmd = this.command(args);
          r = await runProcess(cmd.exe, cmd.args, { cwd: this.cfg.cwd, env: this.env(), stdin: prompt, timeoutMs: req.timeoutMs, signal: req.signal });
        } catch (e) {
          const missing = e instanceof CortexError && (e.code === "E_ENGINE_MISSING" || e.code === "E_BAD_REQUEST");
          return this.fail(
            missing ? { code: "E_ENGINE_MISSING", message: "Codex was not found", retryable: false, state: "missing" } : { code: "E_ENGINE_FAILED", message: "Codex could not be started", retryable: true },
            false,
            t0,
          );
        }
        if (r.cancelled) return this.fail({ code: "E_CANCELLED", message: "cancelled", retryable: false }, true, t0);
        const events = parseCodexEvents(r.stdout);
        if (r.truncated) return this.fail({ code: "E_ENGINE_FAILED", message: "the answer was too large", retryable: false, reason: "too-large" }, true, t0);
        if (r.code !== 0 || r.timedOut) {
          const failure = classifyCodexFailure(r.code, r.stderr, events, r.timedOut);
          if (failure.flag && CODEX_OPTIONAL_FLAGS.includes(failure.flag) && !this.disabled.has(failure.flag)) {
            this.disabled.add(failure.flag);
            this.log.info("optional Codex flag rejected; retrying without it", { flag: failure.flag });
            continue;
          }
          this.log.warn("codex call failed", { runId: req.runId, code: failure.code, exit: r.code, reason: failure.reason ?? "" });
          const started = !(failure.flag !== undefined && failure.reason === "flag-rejected");
          return this.fail(failure, started, t0);
        }
        let text = "";
        try {
          text = (await fsp.readFile(outFile, "utf8")).trim();
        } catch {
          text = (events.lastMessage ?? "").trim();
        }
        const usage = this.usageOf(events, prompt.length, text.length);
        const output = parseJsonText(text);
        if (typeof output !== "object" || output === null || Array.isArray(output)) {
          return { ok: false, error: { code: "E_VALIDATION", message: "model returned no JSON", retryable: true, reason: "no-json" }, usage, rawText: text, durationMs: Date.now() - t0, started: true };
        }
        return { ok: true, output, rawText: text, usage, durationMs: Date.now() - t0, modelUsed: model ?? "codex" };
      }
      return this.fail({ code: "E_ENGINE_FAILED", message: "Codex kept rejecting options", retryable: false, reason: "flag-rejected" }, false, t0);
    } finally {
      await fsp.rm(outFile, { force: true }).catch(() => undefined);
    }
  }
}
