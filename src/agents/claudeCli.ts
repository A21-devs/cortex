/**
 * Claude Code CLI engine (default; uses the user's existing Claude Code login, no API key). Owner: E5.
 *
 * Invocation (verified flags; ARCHITECTURE §11.1):
 *   claude.exe -p --output-format stream-json --verbose --input-format text --model <alias> --effort <level>
 *     --tools "" --restricted --permission-mode dontAsk --disallowedTools <every built-in tool>
 *     --strict-mcp-config --safe-mode --disable-slash-commands --no-session-persistence
 *     --permission-prompts none --max-turns 4
 *     --system-prompt-file <tmp file>   (falls back to --system-prompt; system prompts carry NO record text)
 *     --json-schema <compact JSON>      (optional; we validate ourselves either way)
 *     --max-budget-usd <n.nnnn>         (per-call ceiling ≥ 0.01)
 *   prompt (all record data, constraints and comments) on STDIN; cwd = %LOCALAPPDATA%/cortex/agent-cwd, which
 *   must hold no CLAUDE.md, CLAUDE.local.md, .claude/ or .mcp.json (anything Claude Code would load from it).
 *   Every call is a fresh process with shell:false, killed (whole tree) on timeout or cancel.
 *
 * Isolation is mandatory (SAFE-05): if the CLI rejects any of MANDATORY_FLAGS, the call fails with engine state
 * "unsafe" and agents stop until `doctor` passes — never a silent fallback. Only OPTIONAL_FLAGS fall back, each
 * at most once per engine instance (a rejected optional flag is remembered; --help without it never sends it).
 * An exhausted structured-output retry turns --json-schema off for the rest of the run (we validate anyway).
 * `liveCheck` (doctor --live, and once per CLI version before the first agent call) sends one tiny fixed prompt
 * with stream-json and asserts the init event lists zero tools and zero MCP servers, no tool_use block appears,
 * num_turns is 1 and no session file appears under ~/.claude/projects for the agent folder.
 *
 * Environment (ENV-INHERIT): built from an ALLOWLIST (Windows basics, PATH, profile and temp folders, proxies)
 * plus DISABLE_AUTOUPDATER=1. Every CLAUDE*, MCP_*, OTEL_* variable is dropped (a skill-launched runner inherits
 * a Claude Code session's CLAUDE_CODE_SESSION_ID, messaging socket, OAuth host-refresh switch, CLAUDE_EFFORT=max
 * …), and ANTHROPIC_* only passes for the API engine. `doctor` reports the key names it would pass.
 *
 * Failure classification (CLI-FAILURE-CLASSIFY) reads structured fields only (subtype, is_error, exit code, API
 * error status/type, stderr), never `result` (the model's own text, which may discuss auth and 429s). A
 * subscription usage limit becomes E_ENGINE_LIMIT with a resume time (the CLI's reset time, else +1 h): the
 * scheduler pauses instead of retrying. Messages are Cortex's own fixed strings (SAFE-17).
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { CortexError } from "../shared/errors";
import type { Logger } from "../shared/log";
import type { EngineState, RunnerErrorCode } from "../shared/protocol/runner";
import { PLAN_WINDOWS, parseRateLimitEvents, type PlanWindows } from "../shared/planLimits";
import { isValidModelAlias } from "../shared/settings";
import { runProcess, type RunResult } from "../node/spawn";
import { claudeProjectSlug } from "../node/platform";
import type { Engine, EngineError, EngineProbe, EngineRequest, EngineResult, EngineUsage } from "./engine";
import { zeroUsage } from "./engine";

/** Built-in tools named in --disallowedTools as a backstop to --tools "". */
export const BUILTIN_TOOLS: readonly string[] = ["Bash", "BashOutput", "KillShell", "Edit", "MultiEdit", "Write", "Read", "Glob", "Grep", "LS", "NotebookEdit", "NotebookRead", "WebFetch", "WebSearch", "Task", "TodoWrite", "ExitPlanMode", "SlashCommand"];

/** Flags without which Cortex never calls the CLI. */
export const MANDATORY_FLAGS: readonly string[] = ["--tools", "--restricted", "--permission-mode", "--disallowedTools", "--strict-mcp-config", "--safe-mode", "--disable-slash-commands", "--no-session-persistence", "--permission-prompts"];
/** Flags that may fall back when rejected. */
export const OPTIONAL_FLAGS: readonly string[] = ["--json-schema", "--system-prompt-file", "--effort", "--max-budget-usd"];
/** Flags every call needs beyond isolation (a CLI without them cannot run headless JSON calls at all). */
export const REQUIRED_FLAGS: readonly string[] = ["--print", "--output-format", "--input-format", "--model", "--max-turns"];

/** Files and folders Claude Code would load from its working folder; the agent folder must never hold them. */
export const CWD_FORBIDDEN: readonly string[] = ["CLAUDE.md", "CLAUDE.local.md", ".claude", ".mcp.json"];

/** Flags the CLI may accept without listing them in --help; probed with an empty-input call. */
const HIDDEN_FLAG_CANDIDATES: readonly string[] = ["--max-turns", "--system-prompt-file"];

/** Longest system prompt passed inline when --system-prompt-file is unavailable (Windows command-line limit). */
export const MAX_INLINE_SYSTEM_CHARS = 8_000;
/** Longest --json-schema value passed on the command line; larger schemas are validated by Cortex only. */
export const MAX_SCHEMA_ARG_CHARS = 12_000;

export interface ClaudeCliConfig {
  /** Absolute path to claude.exe. */
  exe: string;
  /** Empty working directory for the headless call. */
  cwd: string;
  /** Folder for per-call temp files (system prompt). */
  tmpDir: string;
  useJsonSchemaFlag: boolean;
  /** Prepended arguments (tests run a fake CLI as `node fake-claude.mjs …`). */
  preArgs?: string[];
  /** Base environment (default process.env); always filtered through claudeEnv(). */
  env?: Record<string, string | undefined>;
  /** Claude Code's projects folder (default ~/.claude/projects), for the live check's session-file test. */
  projectsDir?: string;
  /** Timeout of the --version / --help probe. */
  probeTimeoutMs?: number;
}

export interface ClaudeArgsInput {
  model: string;
  /** Explicit for every job (ENV-INHERIT: never inherit CLAUDE_EFFORT). */
  effort: "low" | "medium" | "high";
  systemPromptFile?: string;
  systemPrompt?: string;
  schemaJson?: string;
  maxUsd?: number;
  maxTurns?: number;
  /**
   * "stream-json" (with --verbose) is what every call uses (the same result line as "json", plus the rate-limit
   * events that carry the plan's 5-hour and weekly utilization) and the live isolation check inspects.
   */
  outputFormat?: "json" | "stream-json";
  /** Optional flags to leave out (rejected by this CLI). Mandatory flags can never be omitted. */
  omit?: ReadonlySet<string>;
}

const EFFORTS = new Set(["low", "medium", "high"]);

/** Exact argument vector for a headless, tool-less call. Pure and unit-tested. */
export function buildClaudeArgs(a: ClaudeArgsInput): string[] {
  if (!isValidModelAlias(a.model)) throw new CortexError("E_BAD_REQUEST", "invalid model alias");
  if (!EFFORTS.has(a.effort)) throw new CortexError("E_BAD_REQUEST", "invalid effort");
  if (a.maxUsd !== undefined && !(Number.isFinite(a.maxUsd) && a.maxUsd >= 0.01)) throw new CortexError("E_BAD_REQUEST", "per-call budget below 0.01");
  const turns = a.maxTurns ?? 4;
  if (!Number.isInteger(turns) || turns < 1 || turns > 20) throw new CortexError("E_BAD_REQUEST", "invalid turn limit");
  const omit = a.omit ?? new Set<string>();
  for (const f of omit) if (!OPTIONAL_FLAGS.includes(f)) throw new CortexError("E_BAD_REQUEST", "only optional flags can be left out");
  const stream = a.outputFormat === "stream-json";
  const args = ["-p", "--output-format", stream ? "stream-json" : "json"];
  if (stream) args.push("--verbose");
  args.push("--input-format", "text", "--model", a.model);
  if (!omit.has("--effort")) args.push("--effort", a.effort);
  args.push(
    "--tools", "",
    "--restricted",
    "--permission-mode", "dontAsk",
    "--disallowedTools", ...BUILTIN_TOOLS,
    "--strict-mcp-config",
    "--safe-mode",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--permission-prompts", "none",
    "--max-turns", String(turns),
  );
  if (a.systemPromptFile && !omit.has("--system-prompt-file")) args.push("--system-prompt-file", a.systemPromptFile);
  else if (a.systemPrompt !== undefined && a.systemPrompt.length > 0) {
    if (a.systemPrompt.length > MAX_INLINE_SYSTEM_CHARS) throw new CortexError("E_BAD_REQUEST", "system prompt too long to pass inline");
    args.push("--system-prompt", a.systemPrompt);
  }
  if (a.schemaJson && !omit.has("--json-schema")) {
    if (a.schemaJson.length > MAX_SCHEMA_ARG_CHARS) throw new CortexError("E_BAD_REQUEST", "schema too long for the command line");
    args.push("--json-schema", a.schemaJson);
  }
  if (a.maxUsd !== undefined && !omit.has("--max-budget-usd")) args.push("--max-budget-usd", a.maxUsd.toFixed(4));
  return args;
}

/** Environment variables a model call may receive (case-insensitive match on Windows). */
export const ENV_ALLOWLIST: readonly string[] = [
  "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "PATH", "OS", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME",
  "USERNAME", "USERDOMAIN", "COMPUTERNAME", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "ALLUSERSPROFILE", "TEMP", "TMP", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "LANG", "LC_ALL", "TZ",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS",
];

/** Child environment from the allowlist (+ ANTHROPIC_* only for the API engine), plus DISABLE_AUTOUPDATER=1. */
export function claudeEnv(base: Record<string, string | undefined>, opts: { allowAnthropic?: boolean } = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const up = k.toUpperCase();
    if (ENV_ALLOWLIST.includes(up) || (opts.allowAnthropic === true && up.startsWith("ANTHROPIC_"))) env[k] = v;
  }
  env.DISABLE_AUTOUPDATER = "1";
  return env;
}

export interface ClaudeResultEnvelope {
  type: "result";
  subtype: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; costUSD?: number }>;
  num_turns?: number;
  duration_ms?: number;
  session_id?: string;
  stop_reason?: string | null;
  /** API error details when the CLI reports them (structured; preferred over any text). */
  api_error_status?: number | null;
  error?: { type?: string; message?: string } | string | null;
}

function isResult(v: unknown): v is ClaudeResultEnvelope {
  return typeof v === "object" && v !== null && (v as { type?: unknown }).type === "result";
}

/** Find the result envelope in CLI stdout (single object, an array of messages, or JSON lines). */
export function parseClaudeOutput(stdout: string): ClaudeResultEnvelope | null {
  const text = stdout.trim();
  if (!text) return null;
  const pick = (v: unknown): ClaudeResultEnvelope | null => {
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) {
        const r = pick(v[i]);
        if (r) return r;
      }
      return null;
    }
    return isResult(v) ? v : null;
  };
  try {
    return pick(JSON.parse(text));
  } catch {
    const lines = text.split(/\r?\n/).reverse();
    for (const l of lines) {
      const t = l.trim();
      if (!t.startsWith("{") && !t.startsWith("[")) continue;
      try {
        const r = pick(JSON.parse(t));
        if (r) return r;
      } catch {
        // keep scanning
      }
    }
    return null;
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** The usage with the plan utilization the call reported attached (a call with no envelope but a reading still keeps the reading). */
export function withPlan(usage: EngineUsage | undefined, plan: PlanWindows | null): EngineUsage | undefined {
  if (!plan) return usage;
  return { ...(usage ?? zeroUsage(true)), plan };
}

/** When a usage-limit failure's window resets, from the plan readings (the window that is full and resets last), or undefined. */
export function limitResetFromPlan(plan: PlanWindows | null): number | undefined {
  let at: number | undefined;
  for (const id of PLAN_WINDOWS) {
    const w = plan?.[id];
    if (w && w.pct >= 100 && (at === undefined || w.resetsAt > at)) at = w.resetsAt;
  }
  return at;
}

export function usageFromEnvelope(env: ClaudeResultEnvelope): EngineUsage {
  const u = env.usage ?? {};
  const models = Object.keys(env.modelUsage ?? {});
  let input = num(u.input_tokens);
  let output = num(u.output_tokens);
  let cacheRead = num(u.cache_read_input_tokens);
  let cacheWrite = num(u.cache_creation_input_tokens);
  // Prefer the per-model totals when present (they include fallback models and retries).
  if (env.modelUsage && models.length > 0) {
    input = output = cacheRead = cacheWrite = 0;
    for (const m of Object.values(env.modelUsage)) {
      input += num(m.inputTokens);
      output += num(m.outputTokens);
      cacheRead += num(m.cacheReadInputTokens);
      cacheWrite += num(m.cacheCreationInputTokens);
    }
  }
  const estimated = env.usage === undefined && env.modelUsage === undefined;
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, costUsd: num(env.total_cost_usd), estimated, models };
}

/** The JSON payload: structured_output when the CLI produced it, else JSON parsed out of `result` text. */
export function extractJsonPayload(env: ClaudeResultEnvelope): unknown {
  if (env.structured_output !== undefined && env.structured_output !== null) return env.structured_output;
  const text = (env.result ?? "").trim();
  if (!text) return undefined;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export interface CliFailure {
  code: RunnerErrorCode;
  retryable: boolean;
  message: string;
  /** E_ENGINE_LIMIT: when work may resume (ISO). */
  resumeAt?: string;
  /** Engine state this failure implies (auth, missing, limit, offline, unsafe). */
  state?: EngineState;
  /** The flag the CLI rejected, when it rejected one. */
  flag?: string;
  /** Machine-readable cause for the scheduler ("structured-output", "flag-rejected" …). */
  reason?: string;
}

/** Next local occurrence of hour:minute after `now`. */
function nextLocalTime(hour: number, minute: number, now: number): number {
  const d = new Date(now);
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0, 0).getTime();
  return t > now ? t : t + 86_400_000;
}

/**
 * Reset time reported by the CLI for a usage limit: an ISO time, epoch seconds ("…limit reached|1731300000",
 * "resets_at: 1731300000"), or a clock time ("resets 3pm", "reset at 15:30"); otherwise now + 1 h.
 */
export function limitResumeAt(stderr: string, now = Date.now()): string {
  const iso = /reset(?:s|ting)?(?:\s+at)?[^0-9]{0,20}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(stderr);
  if (iso?.[1] && !Number.isNaN(Date.parse(iso[1]))) return new Date(Date.parse(iso[1])).toISOString();
  const epoch = /(?:limit reached\|\s*|resets?_?at["':\s]{1,5})(\d{10})\b/i.exec(stderr);
  if (epoch?.[1]) {
    const t = Number(epoch[1]) * 1000;
    if (t > now - 86_400_000) return new Date(t).toISOString();
  }
  const clock = /reset(?:s|ting)?(?:\s+at)?\s{1,3}(\d{1,2})(?::(\d{2}))?\s{0,2}(am|pm)?\b/i.exec(stderr);
  if (clock?.[1]) {
    let hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    const ampm = clock[3]?.toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59 && (ampm !== undefined || clock[2] !== undefined)) return new Date(nextLocalTime(hour, minute, now)).toISOString();
  }
  return new Date(now + 3_600_000).toISOString();
}

/** The option a CLI refused ("error: unknown option '--safe-mode'"), if its stderr says so. */
export function rejectedFlag(stderr: string): string | undefined {
  const m = /(?:unknown|unrecognized|unexpected|invalid)\s+(?:option|argument|flag)[:\s]+['"`]?(--?[A-Za-z][\w-]*)/i.exec(stderr);
  return m?.[1];
}

const AUTH_RE = /invalid api key|please run \/login|run \/login|not logged in|log ?in required|oauth token (?:has )?expired|authentication[_ ](?:error|failed)|unauthorized|invalid (?:x-api-key|credentials)/;
const LIMIT_RE = /usage limit|limit (?:will )?reset|reached your (?:\w+ ){0,2}limit|hit your (?:\w+ ){0,2}limit|limit reached\|/;
const OVERLOAD_RE = /\b(?:429|529)\b|rate.?limit|overloaded|too many requests/;
const NETWORK_RE = /econnrefused|econnreset|enotfound|eai_again|etimedout|enetunreach|ehostunreach|fetch failed|network error|connection error|socket hang up|getaddrinfo|unable to connect|tls|certificate/;

/** Map a failed run (exit code, stderr, envelope) to an error code, from structured fields only. */
export function classifyCliFailure(exitCode: number | null, stderr: string, env: ClaudeResultEnvelope | null, timedOut: boolean, now = Date.now()): CliFailure {
  if (timedOut) return { code: "E_TIMEOUT", retryable: true, message: "model call timed out" };
  if (env?.subtype === "error_max_budget_usd") return { code: "E_BUDGET_CAPPED", retryable: false, message: "per-call budget reached", reason: "per-call" };
  // --json-schema could not be satisfied: the engine retries once without it (we validate ourselves).
  if (env?.subtype === "error_max_structured_output_retries") return { code: "E_VALIDATION", retryable: true, message: "structured output retries exhausted", reason: "structured-output" };
  if (env?.subtype === "error_max_turns") return { code: "E_ENGINE_FAILED", retryable: false, message: "the model used more turns than allowed", reason: "max-turns" };
  const flag = rejectedFlag(stderr);
  if (flag) {
    const mandatory = MANDATORY_FLAGS.includes(flag);
    return { code: "E_ENGINE_FAILED", retryable: !mandatory, message: mandatory ? "Claude Code rejected an isolation flag" : "Claude Code rejected an option", flag, reason: "flag-rejected", ...(mandatory ? { state: "unsafe" as const } : {}) };
  }
  const errObj = env && typeof env.error === "object" && env.error !== null ? env.error : undefined;
  const status = typeof env?.api_error_status === "number" ? env.api_error_status : undefined;
  const errType = (errObj?.type ?? "").toLowerCase();
  const err = stderr.toLowerCase();
  if (status === 401 || status === 403 || errType === "authentication_error" || errType === "permission_error" || AUTH_RE.test(err)) {
    return { code: "E_ENGINE_AUTH", retryable: false, message: "Claude Code is not signed in", state: "auth" };
  }
  if (errType === "usage_limit" || LIMIT_RE.test(err)) {
    return { code: "E_ENGINE_LIMIT", retryable: false, message: "usage limit reached", resumeAt: limitResumeAt(stderr, now), state: "limit" };
  }
  if (status === 429 || status === 529 || errType === "rate_limit_error" || errType === "overloaded_error" || OVERLOAD_RE.test(err)) {
    return { code: "E_ENGINE_FAILED", retryable: true, message: "rate limited or overloaded", state: "offline", reason: "overloaded" };
  }
  if ((status !== undefined && status >= 500) || errType === "api_error" || NETWORK_RE.test(err)) {
    return { code: "E_ENGINE_FAILED", retryable: true, message: "Claude Code could not reach the service", state: "offline", reason: "network" };
  }
  if (status !== undefined && status >= 400) return { code: "E_ENGINE_FAILED", retryable: false, message: "the request was refused", reason: "request" };
  return { code: "E_ENGINE_FAILED", retryable: exitCode !== 0, message: "the model call failed", reason: "exit" };
}

/** Flags advertised by `claude --help`, matched as whole tokens (so --system-prompt ≠ --append-system-prompt). */
export function parseHelpFlags(help: string): Record<string, boolean> {
  const want = [...REQUIRED_FLAGS, "--json-schema", "--effort", "--system-prompt", "--system-prompt-file", "--max-budget-usd", "--verbose", ...MANDATORY_FLAGS];
  const out: Record<string, boolean> = {};
  for (const f of new Set(want)) {
    const re = new RegExp(`(^|[\\s,(\\[|])${f.replace(/[-]/g, "\\-")}(?=[\\s,=<\\])|]|$)`, "m");
    out[f] = re.test(help);
  }
  return out;
}

/** Mandatory isolation flags missing from --help (agents stay off while non-empty). */
export function missingMandatory(flags: Record<string, boolean>): string[] {
  return MANDATORY_FLAGS.filter((f) => flags[f] !== true);
}

/** First line of `--version`, without control characters and capped (it is shown in doctor and diagnostics). */
export function cleanVersion(stdout: string): string {
  return (stdout.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
}

/** The semantic version inside a `--version` line ("2.1.319 (Claude Code)" → "2.1.319"). */
export function versionNumber(v: string | undefined): string | undefined {
  return v ? /(\d+\.\d+\.\d+)/.exec(v)?.[1] : undefined;
}

/** Entries of the agent folder that Claude Code would load (they must not exist). */
export async function forbiddenCwdEntries(cwd: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fsp.readdir(cwd);
  } catch {
    return [];
  }
  const lower = new Set(CWD_FORBIDDEN.map((n) => n.toLowerCase()));
  return names.filter((n) => lower.has(n.toLowerCase()));
}

export interface LiveCheckResult {
  ok: boolean;
  /** Why it failed: tools, mcp, tool-use, turns, session-file, no-init, no-result, call-failed, cancelled, verbose-missing, not-found, probe, model, cwd-not-empty. */
  reason?: string;
  version?: string;
  usage?: EngineUsage;
  error?: EngineError;
  /** True once the prompt was handed to the CLI (tokens may have been spent). */
  sent: boolean;
  durationMs: number;
}

/** Fixed prompt of the live isolation check: no record text, a few tokens. */
export const LIVE_CHECK_SYSTEM = "You are a connectivity check. Reply with JSON only.";
export const LIVE_CHECK_PROMPT = 'Return exactly {"ok":true}.';

interface StreamEvent {
  type?: unknown;
  subtype?: unknown;
  tools?: unknown;
  mcp_servers?: unknown;
  message?: { content?: unknown };
}

/** Inspect stream-json output for the isolation guarantees (pure; unit-tested). */
export function inspectStream(stdout: string): { ok: boolean; reason?: string; result: ClaudeResultEnvelope | null } {
  let init: StreamEvent | undefined;
  let toolUse = false;
  let result: ClaudeResultEnvelope | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    if (ev.type === "system" && ev.subtype === "init") init = ev;
    if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content as { type?: unknown }[]) if (block && (block.type === "tool_use" || block.type === "server_tool_use")) toolUse = true;
    }
    if (isResult(ev)) result = ev;
  }
  if (!init) return { ok: false, reason: "no-init", result };
  if (!Array.isArray(init.tools) || init.tools.length > 0) return { ok: false, reason: "tools", result };
  if (Array.isArray(init.mcp_servers) ? init.mcp_servers.length > 0 : init.mcp_servers !== undefined) return { ok: false, reason: "mcp", result };
  if (toolUse) return { ok: false, reason: "tool-use", result };
  if (!result) return { ok: false, reason: "no-result", result };
  if (result.is_error === true || result.subtype !== "success") return { ok: false, reason: "call-failed", result };
  if (result.num_turns !== 1) return { ok: false, reason: "turns", result };
  return { ok: true, result };
}

async function listNames(dir: string): Promise<Set<string>> {
  try {
    return new Set(await fsp.readdir(dir));
  } catch {
    return new Set();
  }
}

export class ClaudeCliEngine implements Engine {
  readonly kind = "claude-cli" as const;
  readonly where = "remote" as const;
  readonly paidBy = "plan" as const;
  /** Optional flags this CLI rejected or does not advertise (never sent again by this instance). */
  private readonly disabled = new Set<string>();

  constructor(private readonly cfg: ClaudeCliConfig, private readonly log: Logger) {
    if (!cfg.useJsonSchemaFlag) this.disabled.add("--json-schema");
  }

  private command(args: string[]): { exe: string; args: string[] } {
    return { exe: this.cfg.exe, args: [...(this.cfg.preArgs ?? []), ...args] };
  }

  private env(): Record<string, string> {
    return claudeEnv(this.cfg.env ?? process.env);
  }

  /** Keys (never values) of the environment a call would receive. */
  envKeys(): string[] {
    return Object.keys(this.env()).sort();
  }

  /** Optional flags currently left out of calls. */
  disabledFlags(): string[] {
    return [...this.disabled].sort();
  }

  async probe(): Promise<EngineProbe> {
    const timeoutMs = this.cfg.probeTimeoutMs ?? 15_000;
    try {
      const v = this.command(["--version"]);
      const ver = await runProcess(v.exe, v.args, { cwd: this.cfg.cwd, timeoutMs, env: this.env(), maxStdoutBytes: 64 * 1024 });
      const h = this.command(["--help"]);
      const help = await runProcess(h.exe, h.args, { cwd: this.cfg.cwd, timeoutMs, env: this.env(), maxStdoutBytes: 1024 * 1024 });
      const flags = parseHelpFlags(help.stdout);
      // Some flags work but are left out of `--help` (the installed CLI hides --max-turns): confirm each with an
      // empty-input call, which is refused before anything could reach a model.
      if (ver.code === 0 && help.code === 0) {
        for (const f of HIDDEN_FLAG_CANDIDATES) {
          if (flags[f] !== true) flags[f] = await this.acceptsHiddenFlag(f, timeoutMs);
        }
      }
      const missing = missingMandatory(flags);
      const requiredOk = REQUIRED_FLAGS.every((f) => flags[f] === true);
      for (const f of OPTIONAL_FLAGS) if (flags[f] !== true) this.disabled.add(f);
      const version = cleanVersion(ver.stdout);
      const ok = ver.code === 0 && help.code === 0 && requiredOk && missing.length === 0;
      const detail = ok ? "ready" : ver.code !== 0 || help.code !== 0 ? "did not answer" : missing.length > 0 ? "isolation flags missing" : "required flags missing";
      return { ok, ...(version ? { version } : {}), flags, missingMandatory: missing, detail };
    } catch (e) {
      const missing = e instanceof CortexError && (e.code === "E_ENGINE_MISSING" || e.code === "E_BAD_REQUEST");
      return { ok: false, flags: {}, missingMandatory: [...MANDATORY_FLAGS], detail: missing ? "not found" : "could not start" };
    }
  }

  /** True when the CLI parses `flag` although --help omits it. Sends empty input only, so no prompt is ever sent. */
  private async acceptsHiddenFlag(flag: string, timeoutMs: number): Promise<boolean> {
    const value = flag === "--max-turns" ? "1" : this.cfg.cwd;
    try {
      const c = this.command(["-p", flag, value]);
      const r = await runProcess(c.exe, c.args, { cwd: this.cfg.cwd, timeoutMs, env: this.env(), stdin: "", maxStdoutBytes: 64 * 1024 });
      if (r.timedOut) return false;
      return !/(?:unknown|unrecognized|unexpected|invalid)\s+(?:option|argument|flag)/i.test(`${r.stderr} ${r.stdout}`);
    } catch {
      return false;
    }
  }

  private async writeSystemFile(runId: string, system: string): Promise<string | undefined> {
    if (this.disabled.has("--system-prompt-file") || system.length === 0) return undefined;
    await fsp.mkdir(this.cfg.tmpDir, { recursive: true });
    const file = path.join(this.cfg.tmpDir, `sys-${runId.replace(/[^\w-]/g, "")}-${Math.random().toString(36).slice(2, 10)}.txt`);
    await fsp.writeFile(file, system, { encoding: "utf8", flag: "wx" });
    return file;
  }

  private fail(error: EngineError, started: boolean, t0: number, usage?: EngineUsage): EngineResult {
    const res: EngineResult = { ok: false, error, durationMs: Date.now() - t0, started };
    if (usage) res.usage = usage;
    return res;
  }

  private async exec(args: string[], req: { prompt: string; timeoutMs: number; signal: AbortSignal }): Promise<RunResult> {
    const cmd = this.command(args);
    return runProcess(cmd.exe, cmd.args, { cwd: this.cfg.cwd, env: this.env(), stdin: req.prompt, timeoutMs: req.timeoutMs, signal: req.signal });
  }

  async run(req: EngineRequest): Promise<EngineResult> {
    const t0 = Date.now();
    if (!isValidModelAlias(req.model) || !EFFORTS.has(req.effort)) return this.fail({ code: "E_BAD_REQUEST", message: "invalid model or effort", retryable: false }, false, t0);
    if (req.signal.aborted) return this.fail({ code: "E_CANCELLED", message: "cancelled", retryable: false }, false, t0);
    try {
      await fsp.mkdir(this.cfg.cwd, { recursive: true });
    } catch {
      return this.fail({ code: "E_IO", message: "the agent folder could not be created", retryable: true }, false, t0);
    }
    const forbidden = await forbiddenCwdEntries(this.cfg.cwd);
    if (forbidden.length > 0) {
      this.log.warn("agent folder holds files Claude Code would load", { names: forbidden.length });
      return this.fail({ code: "E_ENGINE_FAILED", message: "the agent folder is not empty", retryable: false, state: "unsafe", reason: "cwd-not-empty" }, false, t0);
    }
    let sysFile: string | undefined;
    try {
      sysFile = await this.writeSystemFile(req.runId, req.system);
    } catch {
      return this.fail({ code: "E_IO", message: "the system prompt file could not be written", retryable: true }, false, t0);
    }
    const schemaText = JSON.stringify(req.schema);
    let schemaRetried = false;
    try {
      for (let attempt = 0; attempt < OPTIONAL_FLAGS.length + 2; attempt++) {
        const input: ClaudeArgsInput = { model: req.model, effort: req.effort, omit: this.disabled, outputFormat: "stream-json" };
        if (sysFile && !this.disabled.has("--system-prompt-file")) input.systemPromptFile = sysFile;
        else input.systemPrompt = req.system;
        if (schemaText.length <= MAX_SCHEMA_ARG_CHARS) input.schemaJson = schemaText;
        if (req.maxUsd !== undefined) input.maxUsd = Math.max(0.01, req.maxUsd);
        let args: string[];
        try {
          args = buildClaudeArgs(input);
        } catch (e) {
          return this.fail({ code: "E_BAD_REQUEST", message: e instanceof CortexError ? e.message : "invalid call", retryable: false }, false, t0);
        }
        let r: RunResult;
        try {
          r = await this.exec(args, req);
        } catch (e) {
          const missing = e instanceof CortexError && (e.code === "E_ENGINE_MISSING" || e.code === "E_BAD_REQUEST");
          return this.fail(
            missing ? { code: "E_ENGINE_MISSING", message: "Claude Code was not found", retryable: false, state: "missing" } : { code: "E_ENGINE_FAILED", message: "Claude Code could not be started", retryable: true },
            false,
            t0,
          );
        }
        if (r.cancelled) return this.fail({ code: "E_CANCELLED", message: "cancelled", retryable: false }, true, t0);
        const env = parseClaudeOutput(r.stdout);
        const plan = parseRateLimitEvents(r.stdout);
        const usage = withPlan(env ? usageFromEnvelope(env) : undefined, plan);
        if (r.truncated) return this.fail({ code: "E_ENGINE_FAILED", message: "the answer was too large", retryable: false, reason: "too-large" }, true, t0, usage);
        if (!env || r.code !== 0 || env.is_error === true || env.subtype !== "success") {
          const failure = classifyCliFailure(r.code, r.stderr, env, r.timedOut);
          const resets = failure.code === "E_ENGINE_LIMIT" ? limitResetFromPlan(plan) : undefined;
          if (resets !== undefined) failure.resumeAt = new Date(resets).toISOString();
          if (failure.flag && OPTIONAL_FLAGS.includes(failure.flag) && !this.disabled.has(failure.flag)) {
            this.disabled.add(failure.flag);
            this.log.info("optional CLI flag rejected; retrying without it", { flag: failure.flag });
            continue;
          }
          if (failure.reason === "structured-output" && !schemaRetried && !this.disabled.has("--json-schema")) {
            schemaRetried = true;
            this.disabled.add("--json-schema");
            this.log.info("structured output retries exhausted; --json-schema off for this run");
            continue;
          }
          this.log.warn("claude call failed", { runId: req.runId, code: failure.code, exit: r.code, reason: failure.reason ?? "" });
          const started = !(failure.flag !== undefined && failure.reason === "flag-rejected");
          return this.fail(failure, started, t0, usage);
        }
        const output = extractJsonPayload(env);
        const okUsage = usage ?? zeroUsage();
        if (output === undefined) {
          return { ok: false, error: { code: "E_VALIDATION", message: "model returned no JSON", retryable: true, reason: "no-json" }, usage: okUsage, rawText: env.result ?? "", durationMs: Date.now() - t0, started: true };
        }
        return { ok: true, output, rawText: env.result ?? "", usage: okUsage, durationMs: Date.now() - t0, modelUsed: okUsage.models[0] ?? req.model };
      }
      return this.fail({ code: "E_ENGINE_FAILED", message: "Claude Code kept rejecting options", retryable: false, reason: "flag-rejected" }, false, t0);
    } finally {
      if (sysFile) await fsp.rm(sysFile, { force: true }).catch(() => undefined);
    }
  }

  /**
   * The live isolation check (SAFE-05): one tiny fixed prompt with stream-json. Spends a few tokens; callers
   * reserve and settle them like any call. Never carries record text.
   */
  async liveCheck(opts: { model: string; timeoutMs: number; signal: AbortSignal }): Promise<LiveCheckResult> {
    const t0 = Date.now();
    const done = (r: Omit<LiveCheckResult, "durationMs">): LiveCheckResult => ({ ...r, durationMs: Date.now() - t0 });
    const probe = await this.probe();
    const version = probe.version;
    const base = version ? { version } : {};
    if (!probe.ok) return done({ ok: false, sent: false, reason: probe.detail === "not found" ? "not-found" : "probe", ...base });
    if (probe.flags["--verbose"] !== true) return done({ ok: false, sent: false, reason: "verbose-missing", ...base });
    if (!isValidModelAlias(opts.model)) return done({ ok: false, sent: false, reason: "model", ...base });
    if (opts.signal.aborted) return done({ ok: false, sent: false, reason: "cancelled", error: { code: "E_CANCELLED", message: "cancelled", retryable: false }, ...base });
    const forbidden = await forbiddenCwdEntries(this.cfg.cwd);
    if (forbidden.length > 0) return done({ ok: false, sent: false, reason: "cwd-not-empty", ...base });
    const projects = this.cfg.projectsDir;
    const slugDir = projects ? path.join(projects, claudeProjectSlug(this.cfg.cwd)) : undefined;
    const before = slugDir ? await listNames(slugDir) : new Set<string>();
    // No --json-schema here: structured output may be served through an internal tool, which would hide whether
    // ordinary tools are really off. The reply is checked as plain JSON text instead.
    const input: ClaudeArgsInput = { model: opts.model, effort: "low", systemPrompt: LIVE_CHECK_SYSTEM, outputFormat: "stream-json", maxTurns: 1, omit: this.disabled };
    let r: RunResult;
    try {
      await fsp.mkdir(this.cfg.cwd, { recursive: true });
      r = await this.exec(buildClaudeArgs(input), { prompt: LIVE_CHECK_PROMPT, timeoutMs: opts.timeoutMs, signal: opts.signal });
    } catch {
      return done({ ok: false, sent: false, reason: "not-found", ...base });
    }
    const inspected = inspectStream(r.stdout);
    const usage = withPlan(inspected.result ? usageFromEnvelope(inspected.result) : undefined, parseRateLimitEvents(r.stdout));
    const withUsage = usage ? { usage } : {};
    if (r.cancelled) return done({ ok: false, sent: true, reason: "cancelled", error: { code: "E_CANCELLED", message: "cancelled", retryable: false }, ...base, ...withUsage });
    if (r.timedOut || (r.code !== 0 && !inspected.result)) {
      const failure = classifyCliFailure(r.code, r.stderr, null, r.timedOut);
      const flagOnly = failure.reason === "flag-rejected";
      return done({ ok: false, sent: !flagOnly, reason: flagOnly ? "flag-rejected" : "call-failed", error: failure, ...base });
    }
    if (inspected.result && (inspected.result.is_error === true || inspected.result.subtype !== "success")) {
      const failure = classifyCliFailure(r.code, r.stderr, inspected.result, r.timedOut);
      return done({ ok: false, sent: true, reason: "call-failed", error: failure, ...base, ...withUsage });
    }
    if (!inspected.ok) return done({ ok: false, sent: true, ...(inspected.reason ? { reason: inspected.reason } : {}), ...base, ...withUsage });
    if (slugDir) {
      const after = await listNames(slugDir);
      for (const n of after) if (!before.has(n)) return done({ ok: false, sent: true, reason: "session-file", ...base, ...withUsage });
    }
    return done({ ok: true, sent: true, ...base, ...withUsage });
  }
}
