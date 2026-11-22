/**
 * Steps for the screenshot harness (scripts/desktop-shot.mjs → Electron main, src/desktop/main.ts). A steps file
 * is a JSON array (or `{ "steps": [...] }`, other keys ignored) of objects with exactly one action each:
 *   { "wait": 1500 }                                   wait, in ms (≤ 10 min)
 *   { "click": ".cx-header button[aria-label='Settings']", "timeout": 5000 }
 *                                                      click the element's centre (waits for it to appear)
 *   { "eval": "document.body.dataset.x = '1'" }        run JavaScript in the page (awaited; the value is reported)
 *   { "size": "1280x800" }  /  { "size": [1280, 800] }  /  { "size": { "width": 1280, "height": 800 } }
 *                                                      set the window's content size
 *   { "agentsStatus": "agents-status.json" }  /  { "agentsStatus": { …an agents.status result… } }
 *                                                      a stand-in agents status: an AgentsStatusResult
 *                                                      (src/shared/protocol/runner.ts), checked here and applied to
 *                                                      the shared store as the runner's own status is, so while
 *                                                      agents are on the Agents page shows its counts and what is
 *                                                      waiting (the sample vault has them off; the steps in
 *                                                      scripts/shots/agents-waiting.json turn them on for the run
 *                                                      with settings.preview, never saved). A file name is
 *                                                      read relative to the steps file, before the app is waited
 *                                                      for. Only the page's in-memory store changes: the runner
 *                                                      is not asked, no agent runs, nothing is saved.
 *   { "capture": "after-click.png" }                   save a PNG (relative paths land in --out)
 * The canonical form `{ "type": "wait", "ms": 1500 }` (and `selector`, `js`, `width`/`height`, `file`/`status`,
 * `path`) is accepted too. Pure: tests run it directly.
 */
import { PLAN_WINDOWS, type PlanWindowId } from "../shared/planLimits";
import type { AgentsStatusResult, EngineState, PendingGroup } from "../shared/protocol/runner";
import type { JobKind, RunStatus } from "../shared/types";
import { formatIssues, validate, type JsonSchema } from "../shared/validate";

export type ShotStep =
  | { kind: "wait"; ms: number }
  | { kind: "click"; selector: string; timeoutMs: number }
  | { kind: "eval"; js: string }
  | { kind: "size"; width: number; height: number }
  /** `file` names a status file (relative to the steps file); `status` is the checked status (inline, or once read). */
  | { kind: "agentsStatus"; file: string | null; status: AgentsStatusResult | null }
  | { kind: "capture"; path: string };

export class StepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepError";
  }
}

export const STEP_LIMITS = {
  maxSteps: 500,
  maxWaitMs: 600_000,
  defaultClickTimeoutMs: 10_000,
  minSide: 200,
  maxWidth: 7680,
  maxHeight: 4320,
  maxText: 100_000,
  /** A stand-in agents status file (characters) and its groups. */
  maxStatusText: 1_000_000,
  maxGroups: 1000,
} as const;

const ACTIONS = ["wait", "click", "eval", "size", "agentsStatus", "capture"] as const;
type Action = (typeof ACTIONS)[number];

/** "1512x982" (or "1512×982", "1512,982") → { width, height }. */
export function parseSize(text: string): { width: number; height: number } {
  const m = /^\s*(\d{2,5})\s*[x×,]\s*(\d{2,5})\s*$/i.exec(text);
  if (!m) throw new StepError(`size "${text}" is not WIDTHxHEIGHT`);
  return checkSize(Number(m[1]), Number(m[2]));
}

function checkSize(width: unknown, height: unknown): { width: number; height: number } {
  const ok = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= STEP_LIMITS.minSide && v <= max;
  if (!ok(width, STEP_LIMITS.maxWidth) || !ok(height, STEP_LIMITS.maxHeight)) {
    throw new StepError(`size must be whole pixels between ${STEP_LIMITS.minSide} and ${STEP_LIMITS.maxWidth}×${STEP_LIMITS.maxHeight}`);
  }
  return { width, height };
}

function sizeOf(v: unknown, step: Record<string, unknown>): { width: number; height: number } {
  if (typeof v === "string") return parseSize(v);
  if (Array.isArray(v) && v.length === 2) return checkSize(v[0], v[1]);
  if (v && typeof v === "object") return checkSize((v as Record<string, unknown>).width, (v as Record<string, unknown>).height);
  if (v === undefined) return checkSize(step.width, step.height);
  throw new StepError("size needs WIDTHxHEIGHT, [width, height] or { width, height }");
}

function text(v: unknown, what: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new StepError(`${what} must be a non-empty string`);
  if (v.length > STEP_LIMITS.maxText) throw new StepError(`${what} is too long`);
  if (v.includes("\u0000")) throw new StepError(`${what} contains a NUL character`);
  return v;
}

function ms(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > STEP_LIMITS.maxWaitMs) throw new StepError(`${what} must be a number of milliseconds between 0 and ${STEP_LIMITS.maxWaitMs}`);
  return Math.round(v);
}

/** A capture path: a file name or path ending in .png (".png" is added when there is no extension). */
export function capturePath(v: unknown): string {
  const p = text(v, "capture path").trim();
  if (/[<>"|?*]/.test(p.replace(/^[a-zA-Z]:/, ""))) throw new StepError(`capture path "${p}" has characters a file name cannot hold`);
  if (/\.png$/i.test(p)) return p;
  if (/\.[a-z0-9]{1,5}$/i.test(p)) throw new StepError(`capture path "${p}" must end in .png`);
  return `${p}.png`;
}

/** An agents status file: a file name or path ending in .json. */
export function statusFilePath(v: unknown): string {
  const p = text(v, "agents status file").trim();
  if (/[<>"|?*]/.test(p.replace(/^[a-zA-Z]:/, ""))) throw new StepError(`agents status file "${p}" has characters a file name cannot hold`);
  if (!/\.json$/i.test(p)) throw new StepError(`agents status file "${p}" must end in .json`);
  return p;
}

function agentsStatusStep(v: unknown): ShotStep {
  if (typeof v === "string") return { kind: "agentsStatus", file: statusFilePath(v), status: null };
  if (v && typeof v === "object" && !Array.isArray(v)) return { kind: "agentsStatus", file: null, status: parseAgentsStatus(v) };
  throw new StepError("agentsStatus needs a status file name (.json) or the status itself (an object)");
}

/** One step object → a ShotStep. */
export function parseStep(raw: unknown, index = 0): ShotStep {
  const where = `step ${index + 1}`;
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new StepError("must be an object");
    const s = raw as Record<string, unknown>;
    let action: Action;
    if (typeof s.type === "string") {
      if (!(ACTIONS as readonly string[]).includes(s.type)) throw new StepError(`unknown type "${s.type}" (use ${ACTIONS.join(", ")})`);
      action = s.type as Action;
    } else {
      const present = ACTIONS.filter((a) => a in s);
      if (present.length === 0) throw new StepError(`needs one of ${ACTIONS.join(", ")}`);
      if (present.length > 1) throw new StepError(`has more than one action (${present.join(", ")})`);
      action = present[0] as Action;
    }
    const value = typeof s.type === "string" ? undefined : s[action];
    switch (action) {
      case "wait":
        return { kind: "wait", ms: ms(value ?? s.ms, "wait") };
      case "click":
        return { kind: "click", selector: text(value ?? s.selector, "click selector"), timeoutMs: s.timeout === undefined ? STEP_LIMITS.defaultClickTimeoutMs : ms(s.timeout, "click timeout") };
      case "eval":
        return { kind: "eval", js: text(value ?? s.js ?? s.script, "eval script") };
      case "size":
        return { kind: "size", ...sizeOf(value, s) };
      case "agentsStatus":
        return agentsStatusStep(value ?? s.file ?? s.status);
      case "capture":
        return { kind: "capture", path: capturePath(value ?? s.path) };
    }
  } catch (e) {
    throw new StepError(`${where}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A whole steps document (array, or `{ steps: [...] }`) → ShotStep[]. */
export function parseSteps(raw: unknown): ShotStep[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { steps?: unknown }).steps) ? ((raw as { steps: unknown[] }).steps as unknown[]) : null;
  if (!list) throw new StepError("steps must be a JSON array (or an object with a \"steps\" array)");
  if (list.length > STEP_LIMITS.maxSteps) throw new StepError(`too many steps (${list.length} > ${STEP_LIMITS.maxSteps})`);
  return list.map((s, i) => parseStep(s, i));
}

/** Parse the text of a steps file (JSON). */
export function parseStepsText(json: string): ShotStep[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json.charCodeAt(0) === 0xfeff ? json.slice(1) : json);
  } catch (e) {
    throw new StepError(`steps file is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  return parseSteps(raw);
}

// ───────────────────────────── a stand-in agents status ─────────────────────────────

/** Every value of a closed string type, as the keys of an object literal, so the typecheck fails when the type gains one. */
function allOf<K extends string>(keys: Record<K, true>): K[] {
  return Object.keys(keys) as K[];
}

const JOB_KINDS = allOf<JobKind>({ label: true, gist: true, hub: true, filing: true, "name-check": true, answer: true, directions: true });
const ENGINE_STATES = allOf<EngineState>({ ok: true, offline: true, auth: true, missing: true, limit: true, unsafe: true });
const RUN_STATUSES = allOf<RunStatus>({ running: true, finished: true, stopped: true, failed: true, capped: true, "nothing tagged": true });
const GROUP_KINDS = allOf<PendingGroup["what"]>({ notes: true, wiki: true, chats: true, summaries: true, maps: true, other: true });

const COUNT: JsonSchema = { type: "integer", minimum: 0 };
const NAME: JsonSchema = { type: "string", minLength: 1, maxLength: 200 };
const ISO_TIME = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d{1,9})?)?(Z|[+-]\\d{2}:\\d{2})$";

function planWindowSchema(id: PlanWindowId): JsonSchema {
  return {
    type: "object",
    required: ["window", "pct", "capPct", "resetsAt", "stale", "atCap"],
    additionalProperties: false,
    properties: {
      window: { const: id },
      pct: { type: ["number", "null"], minimum: 0 },
      capPct: { type: ["number", "null"], minimum: 1, maximum: 100 },
      resetsAt: { type: ["integer", "null"], minimum: 0 },
      stale: { type: "boolean" },
      atCap: { type: "boolean" },
    },
  };
}

/** AgentsStatusResult (src/shared/protocol/runner.ts) as a closed schema: a misspelt key is an error, not a silent gap. */
export const AGENTS_STATUS_SCHEMA: JsonSchema = {
  type: "object",
  required: ["day", "tokensToday", "tokensReserved", "usdToday", "plan", "capped", "paused", "engine", "pending", "checks"],
  additionalProperties: false,
  properties: {
    day: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    tokensToday: COUNT,
    tokensReserved: COUNT,
    usdToday: { type: "number", minimum: 0 },
    plan: { type: "object", required: PLAN_WINDOWS, additionalProperties: false, properties: Object.fromEntries(PLAN_WINDOWS.map((id) => [id, planWindowSchema(id)])) },
    capped: { type: "boolean" },
    paused: { type: "boolean" },
    engine: { enum: ENGINE_STATES },
    resumeAt: { type: "string", pattern: ISO_TIME },
    pending: { type: "object", required: JOB_KINDS, additionalProperties: false, properties: Object.fromEntries(JOB_KINDS.map((k) => [k, COUNT])) },
    groups: {
      type: "array",
      maxItems: STEP_LIMITS.maxGroups,
      items: {
        type: "object",
        required: ["what", "n"],
        additionalProperties: false,
        // The planner names at most two subfolders (agents/pendingGroups.ts INSIDE_NAMES).
        properties: { what: { enum: GROUP_KINDS }, where: NAME, inside: { type: "array", maxItems: 2, items: NAME }, insideTotal: COUNT, n: { type: "integer", minimum: 1 } },
      },
    },
    checks: COUNT,
    lastRun: {
      type: "object",
      required: ["runId", "job", "status"],
      additionalProperties: false,
      properties: { runId: { type: "string", pattern: "^r_[0-9A-Za-z_-]{1,64}$" }, job: { enum: JOB_KINDS }, status: { enum: RUN_STATUSES }, finishedAt: { type: "string", pattern: ISO_TIME } },
    },
  },
};

/** The date part names a day that exists ("2026-02-30" does not). */
function realDay(iso: string): boolean {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const realTime = (iso: string): boolean => realDay(iso) && Number.isFinite(Date.parse(iso));

/**
 * Check a stand-in agents status: the AgentsStatusResult shape, real dates, a folder or area for every notes and wiki
 * group, and groups that add up to the pending label, summary and map work, as the runner's own status always does.
 * Throws a StepError naming the problems.
 */
export function parseAgentsStatus(raw: unknown): AgentsStatusResult {
  const r = validate<AgentsStatusResult>(AGENTS_STATUS_SCHEMA, raw, 8);
  if (!r.ok) throw new StepError(`agents status: ${formatIssues(r.issues)}`);
  const s = r.value;
  const problems: string[] = [];
  if (!realDay(s.day)) problems.push("$.day is not a real day");
  if (s.resumeAt !== undefined && !realTime(s.resumeAt)) problems.push("$.resumeAt is not a real time");
  if (s.lastRun?.finishedAt !== undefined && !realTime(s.lastRun.finishedAt)) problems.push("$.lastRun.finishedAt is not a real time");
  const groups = s.groups ?? [];
  groups.forEach((g, i) => {
    if ((g.what === "notes" || g.what === "wiki") && g.where === undefined) problems.push(`$.groups[${i}].where is required for ${g.what}`);
    if (g.inside !== undefined && g.insideTotal !== undefined && g.insideTotal < g.inside.length) problems.push(`$.groups[${i}].insideTotal is below the ${g.inside.length} names in inside`);
  });
  if (groups.length > 0) {
    const grouped = groups.reduce((n, g) => n + g.n, 0);
    const pending = s.pending.label + s.pending.gist + s.pending.hub;
    if (grouped !== pending) problems.push(`$.groups add up to ${grouped}, but $.pending label + gist + hub is ${pending}`);
  }
  if (problems.length > 0) throw new StepError(`agents status: ${problems.join("; ")}`);
  return s;
}

/** The text of a status file (JSON; a byte-order mark is fine) → the checked status. */
export function parseAgentsStatusText(json: string): AgentsStatusResult {
  if (json.length > STEP_LIMITS.maxStatusText) throw new StepError(`agents status is too long (over ${STEP_LIMITS.maxStatusText} characters)`);
  let raw: unknown;
  try {
    raw = JSON.parse(json.charCodeAt(0) === 0xfeff ? json.slice(1) : json);
  } catch (e) {
    throw new StepError(`agents status is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  return parseAgentsStatus(raw);
}

/** Read and check one status file: `read` turns the name into its text, `where` starts every error ("step 2", "--agents-status"). */
export function readAgentsStatus(file: string, read: (file: string) => string, where: string): AgentsStatusResult {
  let json: string;
  try {
    json = read(file);
  } catch (e) {
    throw new StepError(`${where}: could not read the agents status file ${file} (${e instanceof Error ? e.message : String(e)})`);
  }
  try {
    return parseAgentsStatusText(json);
  } catch (e) {
    throw new StepError(`${where}: ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Read the file of every agentsStatus step that names one (`read` gets the name as written; main.ts resolves it against
 * the steps file's folder), so a missing or malformed status stops the run before the app is waited for.
 */
export function loadStatusFiles(steps: readonly ShotStep[], read: (file: string) => string): ShotStep[] {
  return steps.map((step, i) => (step.kind === "agentsStatus" && step.status === null && step.file !== null ? { ...step, status: readAgentsStatus(step.file, read, `step ${i + 1}`) } : step));
}
