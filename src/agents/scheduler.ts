/**
 * Job queue and execution policy. Owner: E5.
 *  - concurrency (settings, 1–4; 1 in worker mode; agents never run inline), priorities answer > label > gist >
 *    filing > name-check > map, FIFO within a priority; a persisted queue (`<cache>/state/queue.json`) so
 *    `agents.enqueue` / `agents.dequeue` can queue and cancel work (Ask refresh, "Queued … · Cancel"), and so
 *    retries keep their back-off across passes;
 *  - the GuardedEngine is the only engine jobs see. Before EVERY call it re-reads control.json (paused → stop;
 *    a privacyRev different from the pass's → abandon before sending more text, SAFE-03), refuses a call whose
 *    run has no ReadRecord yet (every model call is logged with what it read), enforces the per-invocation token
 *    ceiling and the pass deadline, and reserves the estimate under the budget lock; after the call it settles
 *    to the real usage (BUDGET-RESERVE). While a call runs it polls control.json, so Pause kills claude.exe even
 *    in a runner the plugin cannot reach (a skill run). Jobs therefore never touch the budget themselves
 *    (their StoreContext is engine-managed: agents/budget.ts);
 *  - engine states (M1, persisted in `<cache>/state/engine.json`): sign-in or missing CLI set "auth"/"missing"
 *    (not paused) and a check at most every 5 minutes resumes work; E_ENGINE_LIMIT pauses until resumeAt
 *    (never retried); a rejected isolation flag, a CLI whose --help lacks one, a non-empty agent folder or a
 *    failed live check set "unsafe" and stop agents until doctor passes or the CLI version changes; two
 *    network/overload failures in a row set "offline". The live isolation check (SAFE-05) must pass once per
 *    CLI version before the first call;
 *  - retries: retryable failures are queued with back-off 30 s → 2 min → 10 min (3 attempts, then a day's
 *    rest), and selected work whose targets are backing off is skipped until due; E_VALIDATION gets one repair
 *    retry inside the job; an exhausted structured-output error turns --json-schema off for the run (engine);
 *  - every run is in the runs ledger at start ("running") and at finish (final status): the scheduler watches
 *    the ledger appends of its jobs, writes the final record when a job returned or failed without one, logs
 *    "capped" when the cap stops a planned run, and emits job-started / job-finished once per run;
 *  - the coarse lock `runner:agents` (local cache) prevents two runners from processing the queue at once.
 */
import type { CancelToken } from "../shared/cancel";
import { asCortexError, CortexError } from "../shared/errors";
import { compareIds, newRunId, sortableBody } from "../shared/ids";
import type { Logger } from "../shared/log";
import type { AgentsEnqueueArgs, AgentsRunArgs, AgentsRunResult, AgentsStatusResult, AiAskArgs, AiAskResult, EngineState, PendingGroup, RunnerEvent } from "../shared/protocol/runner";
import type { CortexSettings, ModelRole } from "../shared/settings";
import type { EngineKind, JobKind, ReadRecord, ReviewCardRecord, RunId, RunRecord, RunStatus } from "../shared/types";
import { readJsonIfExists, writeJsonAtomic } from "../node/fsAtomic";
import { locksDirOf, withLock } from "../node/locks";
import { cacheWritablePath } from "../node/paths";
import { mayContinue, readControl } from "../store/control";
import type { LedgerRecordMap, LedgerStore } from "../store/ledger";
import type { LedgerName, StoreContext } from "../store/layout";
import { noGrantReason } from "./grants";
import { readerOfEngine } from "../shared/consent";
import { localDayKey } from "../shared/time";
import { budgetEvent, budgetStatus, canStart, cappedError, cappedFailure, capsOf, estimateTokens, loadBudget, markEngineManaged, reserveForCall, settleCall, type BudgetState } from "./budget";
import { versionNumber, type LiveCheckResult } from "./claudeCli";
import { LOCAL_DOWN_DETAILS } from "./localEngine";
import { addUsage, engineStateForError, EXPECTED_OUTPUT_TOKENS, usageTokens, zeroUsage, type Engine, type EngineError, type EngineProbe, type EngineRequest, type EngineResult, type EngineUsage } from "./engine";
import { RULE_JOBS } from "./ruleLabels";
import { runAnswer, runJob as defaultRunJob, selectTargets as defaultSelectTargets, type JobContext, type JobPlan } from "./jobs";
import { describePending as defaultDescribePending } from "./pendingGroups";
import { normaliseRequest } from "./directions";
import { PROMPT_VERSIONS } from "./prompts";

export const JOB_PRIORITY: Readonly<Record<JobKind, number>> = { answer: 0, label: 1, gist: 2, filing: 3, "name-check": 4, hub: 5, directions: 6 };
export const RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;
/** After MAX_ATTEMPTS failures a target rests this long before it is tried again. */
export const GIVE_UP_DELAY_MS = 24 * 3_600_000;
export const ENGINE_PROBE_INTERVAL_MS = 5 * 60_000;
/** A new call starts only when at least this much of the pass deadline is left. */
export const MIN_CALL_WINDOW_MS = 60_000;
/** A call may run this far past the deadline (CLI passes: --max-seconds plus this). */
export const DEADLINE_GRACE_MS = 15_000;
export const CONTROL_POLL_MS = 3_000;
/** Tokens reserved for the live isolation check (settled to the real usage). */
export const LIVE_CHECK_ESTIMATE_TOKENS = 6_000;
export const LIVE_CHECK_TIMEOUT_MS = 60_000;
/** Plans a plugin pass may start when the request names no bound. */
export const DEFAULT_PASS_MAX_JOBS = 50;
export const MAX_PASS_JOBS = 500;
export const MAX_QUEUE_ITEMS = 5_000;
/** Two network or overload failures in a row put the engine "offline". */
export const OFFLINE_AFTER_FAILURES = 2;

/** Jobs a pass selects by itself, per reason (filing and name-check otherwise run only when asked or queued). */
export const PASS_JOBS: Readonly<Record<AgentsRunArgs["reason"], readonly JobKind[]>> = {
  idle: ["label", "gist", "hub"],
  nightly: ["label", "gist", "hub", "filing"],
  manual: ["label", "gist", "hub"],
  skill: ["label", "gist", "hub"],
  refresh: [],
};

/** Typical prompt size per job, for plans built from the queue (the job reads the real text). */
const QUEUED_INPUT_CHARS: Readonly<Record<JobKind, number>> = { label: 12_000, gist: 40_000, hub: 20_000, filing: 8_000, "name-check": 20_000, answer: 8_000, directions: 10_000 };
const SYSTEM_CHARS = 3_000;

const ROLE_OF: Readonly<Record<JobKind, ModelRole>> = { label: "labels", filing: "labels", "name-check": "labels", gist: "summaries", hub: "maps", answer: "ask", directions: "ask" };

const TARGET_ID = /^[cenw]_[a-z2-7]{16}$/;
const QUEUE_ID = /^q_[a-z2-7]{16}$/;
const JOB_KINDS: readonly JobKind[] = ["label", "gist", "hub", "filing", "name-check", "answer", "directions"];

/** The CLI alias a job runs with (settings › Agents › Models). */
export function modelFor(job: JobKind, settings: CortexSettings): string {
  return settings.agents.models[ROLE_OF[job]];
}

/** Sort plans by priority then by estimated size (small first) for fair progress. */
export function orderPlans<P extends JobPlan>(plans: readonly P[]): P[] {
  return [...plans].sort((a, b) => JOB_PRIORITY[a.job] - JOB_PRIORITY[b.job] || a.priority - b.priority || a.estimateTokens - b.estimateTokens);
}

/** The retry delay after `attempt` failures (1-based), then a day's rest. */
export function retryDelay(attempt: number): number {
  return attempt >= 1 && attempt <= RETRY_DELAYS_MS.length ? (RETRY_DELAYS_MS[attempt - 1] as number) : GIVE_UP_DELAY_MS;
}

const RETRYABLE_CODES: ReadonlySet<string> = new Set(["E_TIMEOUT", "E_ENGINE_FAILED", "E_IO", "E_LOCKED", "E_VALIDATION"]);

/** Final run status for a failure code. */
export function statusForCode(code: string): RunStatus {
  if (code === "E_CANCELLED" || code === "E_PAUSED") return "stopped";
  if (code === "E_BUDGET_CAPPED") return "capped";
  return "failed";
}

/** Fixed text per code for run records written by the scheduler (SAFE-17: never raw error text). */
const RUN_ERROR_TEXT: Readonly<Record<string, string>> = {
  E_CANCELLED: "stopped",
  E_PAUSED: "stopped: agents paused or privacy changed",
  E_BUDGET_CAPPED: "plan cap reached",
  E_TIMEOUT: "timed out",
  E_ENGINE_AUTH: "Claude Code needs sign-in",
  E_ENGINE_MISSING: "Claude Code not found",
  E_ENGINE_LIMIT: "usage limit reached",
  E_ENGINE_FAILED: "the model call failed",
  E_VALIDATION: "the answer did not validate",
  E_IO: "file error",
  E_LOCKED: "busy",
  E_INTERNAL: "internal error",
};

export function runErrorText(code: string): string {
  return RUN_ERROR_TEXT[code] ?? "failed";
}

// ───────────────────────────── engine state (machine-local) ─────────────────────────────

export interface EngineStateFile {
  v: 1;
  state: EngineState;
  at: string;
  resumeAt?: string;
  /** Why the state was entered (auth, not-found, flags-missing, flag-rejected, cwd-not-empty, live-check:<reason> …). */
  reason?: string;
  /** CLI version when the state was entered ("unsafe" lifts by itself when the version changes). */
  cliVersion?: string;
  /** Last check that spent (or tried to spend) a call: rate-limits auth / offline checks. */
  lastProbeAt?: string;
  /** The live isolation check, per CLI version (SAFE-05). */
  live?: { version: string; ok: boolean; at: string; reason?: string };
}

export function initialEngineState(): EngineStateFile {
  return { v: 1, state: "ok", at: new Date(0).toISOString() };
}

const ENGINE_STATES: ReadonlySet<string> = new Set(["ok", "offline", "auth", "missing", "limit", "unsafe"]);

/** Read `<cache>/state/engine.json`; unreadable = the initial state (the live check then runs again). */
export async function loadEngineState(cacheDir: string): Promise<EngineStateFile> {
  try {
    const raw = await readJsonIfExists<EngineStateFile>(`${cacheDir}/state/engine.json`);
    if (!raw || raw.v !== 1 || !ENGINE_STATES.has(raw.state)) return initialEngineState();
    return raw;
  } catch {
    return initialEngineState();
  }
}

/** The state in force at `now` (a usage limit ends at its resume time). */
export function currentEngineState(s: EngineStateFile, now: number): { state: EngineState; resumeAt?: string } {
  if (s.state === "limit") {
    const t = s.resumeAt ? Date.parse(s.resumeAt) : Number.NaN;
    if (!Number.isFinite(t) || now >= t) return { state: "ok" };
    return { state: "limit", resumeAt: s.resumeAt as string };
  }
  return { state: s.state };
}

export interface EngineStateSink {
  store: StoreContext;
  emit(e: RunnerEvent): void;
  now(): number;
}

/** Change engine.json under its lock; announces an engine-state event when the state or resume time changed. */
export async function updateEngineState(sink: EngineStateSink, patch: (cur: EngineStateFile) => EngineStateFile): Promise<EngineStateFile> {
  const { store } = sink;
  const { before, after } = await withLock(locksDirOf(store.cacheDir), "state:engine", { owner: store.owner, staleMs: store.lockStaleMs }, async () => {
    const cur = await loadEngineState(store.cacheDir);
    const next = patch({ ...cur });
    await writeJsonAtomic(cacheWritablePath(store.cacheDir, "state/engine.json"), next);
    return { before: cur, after: next };
  });
  const now = sink.now();
  const a = currentEngineState(before, now);
  const b = currentEngineState(after, now);
  if (a.state !== b.state || a.resumeAt !== b.resumeAt) sink.emit({ kind: "engine-state", state: b.state, ...(b.resumeAt ? { resumeAt: b.resumeAt } : {}) });
  return after;
}

/** Enter `state` (with the failure that caused it and the CLI version, when known). */
export function enterEngineState(sink: EngineStateSink, state: EngineState, error?: EngineError, cliVersion?: string): Promise<EngineStateFile> {
  return updateEngineState(sink, (cur) => {
    const at = new Date(sink.now()).toISOString();
    const next: EngineStateFile = { ...cur, state, at };
    if (state === "limit" && error?.resumeAt) next.resumeAt = error.resumeAt;
    else delete next.resumeAt;
    if (state === "ok") delete next.reason;
    else next.reason = error?.reason ?? (error ? error.code.toLowerCase() : state);
    if (cliVersion !== undefined) next.cliVersion = cliVersion;
    if (state === "auth" || state === "offline") next.lastProbeAt = at;
    return next;
  });
}

/** Store the outcome of a live isolation check for `version` (and the state it implies). */
export function recordLiveCheck(sink: EngineStateSink, version: string, r: LiveCheckResult): Promise<EngineStateFile> {
  return updateEngineState(sink, (cur) => {
    const at = new Date(sink.now()).toISOString();
    const live: NonNullable<EngineStateFile["live"]> = { version, ok: r.ok, at };
    if (r.reason) live.reason = r.reason;
    const next: EngineStateFile = { ...cur, live, cliVersion: version, lastProbeAt: at, at };
    if (r.ok) {
      next.state = "ok";
      delete next.reason;
      delete next.resumeAt;
    } else {
      next.state = "unsafe";
      next.reason = `live-check:${r.reason ?? "failed"}`;
      delete next.resumeAt;
    }
    return next;
  });
}

const PROBE_MISSING: ReadonlySet<string> = new Set(["not found", "did not answer", "could not start"]);

export interface EngineGateDeps extends EngineStateSink {
  settings: CortexSettings;
  engine: Engine;
  liveCheck: ((opts: { model: string; timeoutMs: number; signal: AbortSignal }) => Promise<LiveCheckResult>) | null;
  token: CancelToken;
  log: Logger;
}

/** The error a refused call reports for an engine state. */
export function engineRefusal(state: EngineState, s: Pick<EngineStateFile, "resumeAt">): CortexError {
  switch (state) {
    case "auth":
      return new CortexError("E_ENGINE_AUTH", "Claude Code is not signed in", { detail: { state } });
    case "missing":
      return new CortexError("E_ENGINE_MISSING", "Claude Code was not found", { detail: { state } });
    case "limit":
      return new CortexError("E_ENGINE_LIMIT", "usage limit reached", { detail: { state, ...(s.resumeAt ? { resumeAt: s.resumeAt } : {}) } });
    case "offline":
      return new CortexError("E_ENGINE_FAILED", "Claude Code is not answering", { retryable: true, detail: { state } });
    default:
      return new CortexError("E_ENGINE_FAILED", "Claude Code cannot be run safely", { detail: { state } });
  }
}

/**
 * Make sure the engine may be called (agents and Ask): the free probe (version, help, isolation flags), the
 * usage-limit wait, "unsafe" held for the CLI version that caused it, the rate-limited recovery check for
 * auth / offline, and the live isolation check once per CLI version. Throws the refusal; resolves when calls
 * may start.
 */
export async function ensureEngineReady(g: EngineGateDeps): Promise<void> {
  const now = g.now();
  const es = await loadEngineState(g.store.cacheDir);
  const cur = currentEngineState(es, now);
  if (cur.state === "limit") throw engineRefusal("limit", es);
  const probe = await g.engine.probe();
  const version = versionNumber(probe.version) ?? probe.version ?? "unknown";
  if (!probe.ok) {
    if (LOCAL_DOWN_DETAILS.has(probe.detail)) {
      // A model on this computer that is not answering (server stopped, wrong address, model not pulled): the engine
      // is "offline" and the next pass checks again, free of charge.
      const reason = `local:${probe.detail.replace(/ /g, "-")}`;
      await enterEngineState(g, "offline", { code: "E_ENGINE_FAILED", message: "the local model could not be reached", retryable: true, state: "offline", reason });
      throw new CortexError("E_ENGINE_FAILED", "the local model could not be reached", { retryable: true, detail: { state: "offline", reason } });
    }
    if (PROBE_MISSING.has(probe.detail)) {
      await enterEngineState(g, "missing", { code: "E_ENGINE_MISSING", message: g.engine.kind === "codex-cli" ? "Codex was not found" : "Claude Code was not found", retryable: false, reason: probe.detail.replace(/ /g, "-") });
      throw engineRefusal("missing", es);
    }
    const flag = probe.missingMandatory[0];
    if (flag) g.emit({ kind: "warning", code: "cli-flag-rejected", detail: { flag } });
    await enterEngineState(g, "unsafe", { code: "E_ENGINE_FAILED", message: "isolation flags missing", retryable: false, reason: flag ? "flags-missing" : "required-flags-missing" }, version);
    throw engineRefusal("unsafe", es);
  }
  if (es.state === "unsafe" && es.cliVersion === version && es.reason !== "cwd-not-empty") throw engineRefusal("unsafe", es);
  const recovering = es.state === "auth" || es.state === "offline";
  // The 5-minute rest guards calls that cost something; the probe of a model on this computer is free.
  if (recovering && g.engine.where !== "this computer" && es.lastProbeAt && now - Date.parse(es.lastProbeAt) < ENGINE_PROBE_INTERVAL_MS) throw engineRefusal(es.state, es);
  const liveOk = es.live?.ok === true && es.live.version === version;
  if (g.liveCheck && (!liveOk || recovering)) {
    await runLiveCheck(g, version);
    return;
  }
  if (es.state !== "ok") await enterEngineState(g, "ok", undefined, version);
}

/** Run the live isolation check within the daily budget and record what it found. */
export async function runLiveCheck(g: EngineGateDeps, version: string): Promise<LiveCheckResult> {
  const check = g.liveCheck;
  if (!check) throw new CortexError("E_INTERNAL", "no live check for this engine");
  const caps = capsOf(g.settings);
  const callId = `live:${sortableBody(g.now())}`;
  const decision = await reserveForCall(g.store, caps, callId, LIVE_CHECK_ESTIMATE_TOKENS);
  if (!decision.ok) throw cappedError(decision.block);
  let r: LiveCheckResult;
  try {
    r = await check({ model: modelFor("label", g.settings), timeoutMs: LIVE_CHECK_TIMEOUT_MS, signal: g.token.signal });
  } catch (e) {
    g.log.error("live check threw", { code: asCortexError(e).code });
    r = { ok: false, sent: true, reason: "call-failed", durationMs: 0 };
  }
  try {
    const s = await settleCall(g.store, callId, r.usage ?? null, r.sent, true);
    g.emit(budgetEvent(budgetStatus(s, caps)));
  } catch (e) {
    g.log.error("budget settle failed", { code: asCortexError(e).code });
  }
  if (r.ok) {
    await recordLiveCheck(g, version, r);
    return r;
  }
  if (r.reason === "cancelled") throw new CortexError("E_CANCELLED", "cancelled");
  if (r.reason === "not-found") {
    await enterEngineState(g, "missing", { code: "E_ENGINE_MISSING", message: "Claude Code was not found", retryable: false, reason: "not-found" });
    throw engineRefusal("missing", {});
  }
  if (r.reason === "call-failed" && r.error) {
    // The check could not run (sign-in, limit, network): that state, not "unsafe"; it runs again later.
    const state = engineStateForError(r.error) ?? (r.error.code === "E_TIMEOUT" ? "offline" : r.error.retryable ? "offline" : "unsafe");
    if (state === "unsafe") {
      await recordLiveCheck(g, version, r);
      throw engineRefusal("unsafe", {});
    }
    const after = await enterEngineState(g, state, { ...r.error, reason: r.error.reason ?? "live-check" }, version);
    throw engineRefusal(state, after);
  }
  g.log.warn("live isolation check failed", { reason: r.reason ?? "" });
  if (r.reason === "flag-rejected" && r.error?.flag) g.emit({ kind: "warning", code: "cli-flag-rejected", detail: { flag: r.error.flag } });
  await recordLiveCheck(g, version, r);
  throw engineRefusal("unsafe", {});
}

// ───────────────────────────── queue (machine-local) ─────────────────────────────

export interface QueueItem {
  id: string;
  job: JobKind;
  targets: string[];
  reason: AgentsEnqueueArgs["reason"] | "retry";
  /** Failures so far (0 for new work). */
  attempt: number;
  addedAt: string;
  /** Not before this time (retry back-off). */
  notBefore?: string;
  lastError?: string;
}

export interface QueueFile {
  v: 1;
  items: QueueItem[];
}

export async function loadQueue(cacheDir: string): Promise<QueueFile> {
  try {
    const raw = await readJsonIfExists<QueueFile>(`${cacheDir}/state/queue.json`);
    if (!raw || raw.v !== 1 || !Array.isArray(raw.items)) return { v: 1, items: [] };
    const items = raw.items.filter(
      (i): i is QueueItem =>
        typeof i === "object" &&
        i !== null &&
        typeof i.id === "string" &&
        QUEUE_ID.test(i.id) &&
        JOB_KINDS.includes(i.job) &&
        Array.isArray(i.targets) &&
        i.targets.length > 0 &&
        i.targets.every((t) => typeof t === "string" && TARGET_ID.test(t)) &&
        typeof i.attempt === "number",
    );
    return { v: 1, items };
  } catch {
    return { v: 1, items: [] };
  }
}

async function mutateQueue<T>(store: StoreContext, fn: (q: QueueFile) => T): Promise<T> {
  return withLock(locksDirOf(store.cacheDir), "state:queue", { owner: store.owner, staleMs: store.lockStaleMs }, async () => {
    const q = await loadQueue(store.cacheDir);
    const result = fn(q);
    q.items = q.items.slice(-MAX_QUEUE_ITEMS);
    await writeJsonAtomic(cacheWritablePath(store.cacheDir, "state/queue.json"), q);
    return result;
  });
}

const pairKey = (job: JobKind, target: string) => `${job}|${target}`;

/** Queue work (one item per job and target); work already queued keeps its item. Returns the item ids. */
export async function enqueueJobs(store: StoreContext, args: AgentsEnqueueArgs, now = Date.now()): Promise<string[]> {
  if (typeof args !== "object" || args === null || !Array.isArray(args.jobs) || !Array.isArray(args.targets)) throw new CortexError("E_BAD_REQUEST", "jobs and targets are required");
  const jobs = [...new Set(args.jobs)];
  if (jobs.length === 0 || jobs.some((j) => !JOB_KINDS.includes(j) || j === "answer" || j === "directions")) throw new CortexError("E_BAD_REQUEST", "unknown job");
  const targets = [...new Set(args.targets)];
  if (targets.length === 0 || targets.length > 500 || targets.some((t) => typeof t !== "string" || !TARGET_ID.test(t))) throw new CortexError("E_BAD_REQUEST", "invalid targets");
  if (!["refresh", "comment", "manual"].includes(args.reason)) throw new CortexError("E_BAD_REQUEST", "invalid reason");
  return mutateQueue(store, (q) => {
    const ids: string[] = [];
    const byPair = new Map<string, QueueItem>();
    for (const it of q.items) for (const t of it.targets) byPair.set(pairKey(it.job, t), it);
    for (const job of jobs) {
      for (const target of targets) {
        const existing = byPair.get(pairKey(job, target));
        if (existing) {
          if (existing.reason === "retry") {
            // Asked again: run it at the next pass instead of waiting out the back-off.
            delete existing.notBefore;
            existing.reason = args.reason;
          }
          ids.push(existing.id);
          continue;
        }
        const item: QueueItem = { id: `q_${sortableBody(now)}`, job, targets: [target], reason: args.reason, attempt: 0, addedAt: new Date(now).toISOString() };
        q.items.push(item);
        byPair.set(pairKey(job, target), item);
        ids.push(item.id);
      }
    }
    return [...new Set(ids)];
  });
}

/** Remove queued work by id ("Queued … · Cancel"). */
export async function dequeueJobs(store: StoreContext, ids: readonly string[]): Promise<number> {
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== "string")) throw new CortexError("E_BAD_REQUEST", "invalid ids");
  const drop = new Set(ids);
  return mutateQueue(store, (q) => {
    const before = q.items.length;
    q.items = q.items.filter((i) => !drop.has(i.id));
    return before - q.items.length;
  });
}

// ───────────────────────────── watched ledger ─────────────────────────────

/** What the jobs of one pass appended: runs with a ReadRecord, and the latest RunRecord per run. */
export interface LedgerWatch {
  reads: Set<string>;
  runs: Map<string, RunRecord>;
}

/**
 * Wrap a LedgerStore so the scheduler sees every ReadRecord and RunRecord its jobs append. Every other member
 * is passed through unchanged (a Proxy, so members the store gains later need no change here).
 */
export function watchLedger(inner: LedgerStore, watch: LedgerWatch, onRun: (rec: RunRecord) => void): LedgerStore {
  async function append<L extends LedgerName>(ledger: L, records: readonly LedgerRecordMap[L][]): Promise<number> {
    const seq = await inner.append(ledger, records);
    if (ledger === "reads") for (const r of records as readonly ReadRecord[]) watch.reads.add(r.runId);
    if (ledger === "runs") {
      for (const r of records as readonly RunRecord[]) {
        watch.runs.set(r.id, r);
        onRun(r);
      }
    }
    return seq;
  }
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "append") return append;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

// ───────────────────────────── guarded engine ─────────────────────────────

export interface GuardDeps {
  inner: Engine;
  store: StoreContext;
  settings: CortexSettings;
  /** privacyRev the pass started with (control.json). */
  privacyRev: number;
  token: CancelToken;
  now(): number;
  log: Logger;
  emit(e: RunnerEvent): void;
  /** Epoch ms after which no new call starts (bounded passes). */
  deadline?: number;
  /** Per-invocation token ceiling (AgentsRunArgs.maxTokens); the daily cap always applies too. */
  maxTokens?: number;
  /** True once the run's ReadRecord was appended. */
  readLogged(runId: RunId): boolean;
  /** Engine state transitions (persisted and announced by the owner). */
  onEngineState(state: EngineState, error?: EngineError): Promise<void>;
  controlPollMs?: number;
}

export interface RunCallStats {
  job: JobKind;
  model: string;
  calls: number;
  usage: EngineUsage;
  lastError?: EngineError;
}

/** The engine every job sees: kill switches, audit, ceilings, budget and engine states around each call. */
export class GuardedEngine implements Engine {
  readonly kind: EngineKind;
  readonly where: "remote" | "this computer";
  readonly paidBy: "plan" | "api" | "none";
  readonly perRun = new Map<RunId, RunCallStats>();
  private seq = 0;
  private spent = 0;
  private inFlight = 0;
  private offlineStreak = 0;
  private blockedBy: EngineError | undefined;
  private lastBudget: BudgetState | undefined;

  constructor(private readonly d: GuardDeps) {
    this.kind = d.inner.kind;
    this.where = d.inner.where;
    this.paidBy = d.inner.paidBy;
  }

  /** The failure that stopped calls for the rest of the pass (an engine state), if any. */
  get blocked(): EngineError | undefined {
    return this.blockedBy;
  }

  /** Tokens charged by calls through this engine (estimates for killed calls). */
  get tokensSpent(): number {
    return this.spent;
  }

  /** The budget as last settled by this engine. */
  get budget(): BudgetState | undefined {
    return this.lastBudget;
  }

  probe(): Promise<EngineProbe> {
    return this.d.inner.probe();
  }

  private refuse(t0: number, error: EngineError): EngineResult {
    return { ok: false, error, durationMs: Math.max(0, this.d.now() - t0), started: false };
  }

  private emitBudget(s: BudgetState): void {
    this.d.emit(budgetEvent(budgetStatus(s, capsOf(this.d.settings))));
  }

  private track(req: EngineRequest, usage: EngineUsage | undefined, error?: EngineError): void {
    const cur = this.perRun.get(req.runId) ?? { job: req.job, model: req.model, calls: 0, usage: zeroUsage(false) };
    cur.calls++;
    if (usage) cur.usage = addUsage(cur.usage, usage);
    if (error) cur.lastError = error;
    else delete cur.lastError;
    this.perRun.set(req.runId, cur);
  }

  async run(req: EngineRequest): Promise<EngineResult> {
    const d = this.d;
    const t0 = d.now();
    if (this.blockedBy) return this.refuse(t0, { ...this.blockedBy });
    if (d.token.cancelled || req.signal.aborted) return this.refuse(t0, { code: "E_CANCELLED", message: "cancelled", retryable: false });
    let timeoutMs = req.timeoutMs;
    if (d.deadline !== undefined) {
      const remaining = d.deadline - t0;
      if (remaining < MIN_CALL_WINDOW_MS) return this.refuse(t0, { code: "E_TIMEOUT", message: "the pass ran out of time", retryable: true, reason: "deadline" });
      timeoutMs = Math.min(timeoutMs, remaining + DEADLINE_GRACE_MS);
    }
    const control = await readControl(d.store);
    const go = mayContinue(control, d.privacyRev);
    if (!go.ok) return this.refuse(t0, { code: "E_PAUSED", message: go.reason === "paused" ? "agents are paused" : "privacy settings changed", retryable: false, reason: go.reason });
    if (!d.readLogged(req.runId)) {
      d.log.error("model call refused: no ReadRecord for this run", { runId: req.runId, job: req.job });
      return this.refuse(t0, { code: "E_INTERNAL", message: "the read was not logged before the call", retryable: false, reason: "read-not-logged" });
    }
    const estimate = estimateTokens(req.prompt.length, req.system.length, req.expectedOutputTokens ?? EXPECTED_OUTPUT_TOKENS[req.job]);
    if (d.maxTokens !== undefined && this.spent + this.inFlight + estimate > d.maxTokens) {
      return this.refuse(t0, { code: "E_BUDGET_CAPPED", message: "this run's token limit is reached", retryable: false, reason: "invocation" });
    }
    // A run on this computer costs nothing: it stays out of the counted spend unless the person asked to count it.
    const counted = (req.job !== "answer" || d.settings.agents.askCountsTowardCap) && (d.inner.paidBy !== "none" || d.settings.agents.local.countTowardCap);
    const callId = `${req.runId}#${++this.seq}`;
    if (counted) {
      const decision = await reserveForCall(d.store, capsOf(d.settings), callId, estimate);
      if (!decision.ok) {
        this.emitBudget(await loadBudget(d.store));
        return this.refuse(t0, cappedFailure(decision.block));
      }
    }
    this.inFlight += estimate;
    const ac = new AbortController();
    let stoppedBy: "paused" | "privacy-changed" | undefined;
    const abort = () => ac.abort();
    req.signal.addEventListener("abort", abort, { once: true });
    d.token.signal.addEventListener("abort", abort, { once: true });
    const poll = setInterval(() => {
      readControl(d.store)
        .then((c) => {
          const m = mayContinue(c, d.privacyRev);
          if (!m.ok && !ac.signal.aborted) {
            stoppedBy = m.reason;
            ac.abort();
          }
        })
        .catch(() => undefined);
    }, d.controlPollMs ?? CONTROL_POLL_MS);
    (poll as { unref?: () => void }).unref?.();
    let res: EngineResult;
    try {
      res = await d.inner.run({ ...req, timeoutMs, signal: ac.signal });
    } catch (e) {
      d.log.error("engine threw instead of returning a failure", { runId: req.runId, code: asCortexError(e).code });
      res = { ok: false, error: { code: "E_INTERNAL", message: "engine error", retryable: false }, durationMs: d.now() - t0, started: true };
    } finally {
      clearInterval(poll);
      req.signal.removeEventListener("abort", abort);
      d.token.signal.removeEventListener("abort", abort);
      this.inFlight -= estimate;
    }
    if (!res.ok && res.error.code === "E_CANCELLED" && stoppedBy !== undefined) {
      res = { ...res, error: { code: "E_PAUSED", message: stoppedBy === "paused" ? "agents are paused" : "privacy settings changed", retryable: false, reason: stoppedBy } };
    }
    const started = res.ok || res.started !== false;
    const usage = res.usage && !(res.usage.estimated && usageTokens(res.usage) === 0) ? res.usage : null;
    try {
      this.lastBudget = await settleCall(d.store, callId, usage, started, counted, res.usage?.plan ?? null);
      this.emitBudget(this.lastBudget);
    } catch (e) {
      d.log.error("budget settle failed", { runId: req.runId, code: asCortexError(e).code });
    }
    this.spent += usage ? usageTokens(usage) : started ? estimate : 0;
    this.track(req, usage ?? undefined, res.ok ? undefined : res.error);
    if (res.ok) {
      this.offlineStreak = 0;
      await d.onEngineState("ok");
      return res;
    }
    if (res.error.flag) d.emit({ kind: "warning", code: "cli-flag-rejected", detail: { flag: res.error.flag } });
    const state = engineStateForError(res.error);
    if (state === "offline") {
      this.offlineStreak++;
      if (this.offlineStreak >= OFFLINE_AFTER_FAILURES) {
        this.blockedBy = res.error;
        await d.onEngineState("offline", res.error);
      }
    } else if (state !== undefined) {
      this.blockedBy = res.error;
      await d.onEngineState(state, res.error);
    }
    return res;
  }
}

/** An engine that never sends anything: for planning and status, which must not reach a model. */
export function noCallEngine(inner: Pick<Engine, "kind" | "where" | "paidBy" | "probe">): Engine {
  return {
    kind: inner.kind,
    where: inner.where,
    paidBy: inner.paidBy,
    probe: () => inner.probe(),
    run: async () => ({ ok: false, error: { code: "E_INTERNAL", message: "planning never calls a model", retryable: false, reason: "no-calls" }, durationMs: 0, started: false }),
  };
}

// ───────────────────────────── scheduler ─────────────────────────────

/** Fields the scheduler adds to every JobContext (proposed for JobContext in docs/rfcs/E5.md). */
export interface JobContextExtras {
  /** Who started the pass (ReadRecord.origin; the ledger's "from /cortex-organise"). */
  origin: "plugin" | "skill";
  settingsSource: "plugin" | "data.json" | "defaults";
  pluginVersion: string;
  /** Pass deadline (epoch ms), when bounded. */
  deadline?: number;
  /** Prompt version per job (RunRecord.promptVersion). */
  promptVersions: Readonly<Record<JobKind, string>>;
}

export type SchedulerJobContext = JobContext & JobContextExtras;

export interface SchedulerJobs {
  selectTargets(job: JobKind, ctx: JobContext, limit: number): Promise<JobPlan[]>;
  runJob(plan: JobPlan, ctx: JobContext): Promise<RunRecord>;
  /** What the pending targets are, in groups for the status ("840 notes in Game Notes V2"); optional for stand-ins. */
  describePending?(byJob: Partial<Record<JobKind, readonly string[]>>, ctx: JobContext): Promise<PendingGroup[]>;
}

export interface SchedulerDeps {
  store: StoreContext;
  ledger: LedgerStore;
  settings: CortexSettings;
  /** The raw engine (Claude Code CLI); jobs only ever see it through the GuardedEngine. */
  engine: Engine;
  /** The live isolation check for this engine, or null for an engine that needs none. */
  liveCheck: EngineGateDeps["liveCheck"];
  token: CancelToken;
  log: Logger;
  emit(e: RunnerEvent): void;
  now(): number;
  mode: "child" | "worker" | "inline" | "cli";
  origin: "plugin" | "skill";
  settingsSource: "plugin" | "data.json" | "defaults";
  pluginVersion: string;
  jobs?: SchedulerJobs;
}

export interface PlannedJob extends JobPlan {
  key: string;
  attempt: number;
  queueId?: string;
}

export type PassStop = "capped" | "paused" | "privacy-changed" | "engine" | "deadline" | "max-jobs" | "max-tokens" | "cancelled";

export interface PassResult extends AgentsRunResult {
  /** A bound (--max-seconds, --max-jobs, --max-tokens) stopped the pass with work left: run again. */
  partial: boolean;
  /** Why the pass stopped before its plans ran out. */
  stopped?: PassStop;
  /** The engine state at the end of the pass, when not ok. */
  engine?: EngineState;
  resumeAt?: string;
  /** Dry runs: what would run, with Cortex's estimate. */
  planned?: { job: JobKind; targets: number; model: string; estimateTokens: number }[];
  estimateTokens?: number;
}

const sameTargets = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
const planKey = (job: JobKind, targets: readonly string[]) => `${job}:${[...targets].sort().join(",")}`;
const runTokens = (r: RunRecord) => r.tokensIn + r.tokensOut + r.tokensCacheRead + r.tokensCacheWrite;
const internalCode = (code: string) => (code === "E_NOT_IMPLEMENTED" || code === "E_WEBGL" || code === "E_WORKER" ? "E_INTERNAL" : code);

function emptyPending(): Record<JobKind, number> {
  return { label: 0, gist: 0, hub: 0, filing: 0, "name-check": 0, answer: 0, directions: 0 };
}

export class AgentScheduler {
  private readonly jobs: SchedulerJobs;

  constructor(private readonly d: SchedulerDeps) {
    this.jobs = d.jobs ?? { selectTargets: defaultSelectTargets, runJob: defaultRunJob, describePending: defaultDescribePending };
  }

  private context(engine: Engine, ledger: LedgerStore, privacyRev: number, emit: (e: RunnerEvent) => void, deadline?: number): SchedulerJobContext {
    const ctx: SchedulerJobContext = {
      engine,
      ledger,
      store: markEngineManaged({ ...this.d.store }),
      settings: this.d.settings,
      privacyRev,
      token: this.d.token,
      log: this.d.log,
      emit,
      origin: this.d.origin,
      settingsSource: this.d.settingsSource,
      pluginVersion: this.d.pluginVersion,
      promptVersions: PROMPT_VERSIONS,
    };
    if (deadline !== undefined) ctx.deadline = deadline;
    return ctx;
  }

  private gateDeps(): EngineGateDeps {
    const d = this.d;
    return { store: d.store, emit: d.emit, now: d.now, settings: d.settings, engine: d.engine, liveCheck: d.liveCheck, token: d.token, log: d.log };
  }

  private emitBudget(s: BudgetState): void {
    this.d.emit(budgetEvent(budgetStatus(s, capsOf(this.d.settings))));
  }

  private async collectPlans(args: AgentsRunArgs, ctx: JobContext, queue: QueueFile, limit: number): Promise<PlannedJob[]> {
    const now = this.d.now();
    const settings = this.d.settings;
    const only = args.jobs && args.jobs.length > 0 ? new Set(args.jobs) : undefined;
    const backingOff = new Set<string>();
    const out = new Map<string, PlannedJob>();
    const estimateFor = (job: JobKind) => estimateTokens(QUEUED_INPUT_CHARS[job], SYSTEM_CHARS, EXPECTED_OUTPUT_TOKENS[job]);
    for (const it of queue.items) {
      if (only && !only.has(it.job)) continue;
      // A direction trial carries its purpose with the request, so it is never queued or retried from the queue.
      if (it.job === "directions") continue;
      if (it.notBefore && Date.parse(it.notBefore) > now) {
        for (const t of it.targets) backingOff.add(pairKey(it.job, t));
        continue;
      }
      const key = planKey(it.job, it.targets);
      if (!out.has(key)) out.set(key, { job: it.job, targets: [...it.targets], model: modelFor(it.job, settings), estimateTokens: estimateFor(it.job), priority: -1, key, attempt: it.attempt, queueId: it.id });
    }
    if (args.targets && args.targets.length > 0) {
      const targets = [...new Set(args.targets)].filter((t) => TARGET_ID.test(t));
      for (const job of only ? [...only] : (["label", "gist"] as JobKind[])) {
        if (job === "answer" || job === "directions") continue;
        for (const t of targets) {
          const key = planKey(job, [t]);
          if (!out.has(key) && !backingOff.has(pairKey(job, t))) out.set(key, { job, targets: [t], model: modelFor(job, settings), estimateTokens: estimateFor(job), priority: 0, key, attempt: 0 });
        }
      }
    } else {
      for (const job of only ? [...only] : PASS_JOBS[args.reason]) {
        if (job === "answer") continue;
        let plans: JobPlan[];
        try {
          // Only a direction trial reads the request's purpose and arms (JobTrigger.experiment); other jobs see no trigger, as before.
          plans = await this.jobs.selectTargets(job, job === "directions" ? { ...ctx, trigger: { reason: args.reason, jobs: [job], ...(args.experiment ? { experiment: args.experiment } : {}) } } : ctx, limit);
        } catch (e) {
          const err = asCortexError(e);
          if (err.code === "E_CANCELLED") throw err;
          this.d.log.warn("target selection failed", { job, code: err.code });
          continue;
        }
        for (const p of plans) {
          if (!Array.isArray(p.targets) || p.targets.length === 0 || p.job !== job) continue;
          if (p.targets.some((t) => backingOff.has(pairKey(p.job, t)))) continue;
          const key = planKey(p.job, p.targets);
          if (!out.has(key)) out.set(key, { ...p, key, attempt: 0 });
        }
      }
    }
    // No model: only the jobs the rules can do are planned (summaries, filing and the name check need a model).
    const all = [...out.values()];
    return orderPlans(this.d.engine.kind === "rule" ? all.filter((p) => RULE_JOBS.has(p.job)) : all);
  }

  /** Plan without running (dry runs, the work-remaining readout). Never calls a model. */
  async plan(args: AgentsRunArgs): Promise<PlannedJob[]> {
    const control = await readControl(this.d.store);
    const ctx = this.context(noCallEngine(this.d.engine), this.d.ledger, control.privacyRev, () => undefined);
    const queue = await loadQueue(this.d.store.cacheDir);
    const maxJobs = Math.max(0, Math.min(MAX_PASS_JOBS, Math.floor(args.maxJobs ?? DEFAULT_PASS_MAX_JOBS)));
    return (await this.collectPlans(args, ctx, queue, Math.max(maxJobs, 1) * 4)).slice(0, maxJobs);
  }

  private gate(args: AgentsRunArgs): void {
    const s = this.d.settings;
    if (args.jobs?.includes("directions") && normaliseRequest(args.experiment) === null) throw new CortexError("E_BAD_REQUEST", "a direction trial needs a purpose of 6 to 400 characters and at least one arm");
    if (!s.general.firstRunDone) throw new CortexError("E_PAUSED", "Cortex has not been set up yet", { detail: { reason: "first-run" } });
    if (this.d.mode === "inline") throw new CortexError("E_NODE_MISSING", "agents need Node.js 20 or later", { detail: { reason: "inline" } });
    if (!s.agents.enabled && (args.reason === "idle" || args.reason === "nightly")) throw new CortexError("E_PAUSED", "agents are off", { detail: { reason: "agents-off" } });
    if (s.agents.engine !== "claude-cli" && s.agents.engine !== "local" && s.agents.engine !== "codex-cli" && s.agents.engine !== "none") throw new CortexError("E_ENGINE_MISSING", "this engine is not available yet", { detail: { reason: "engine" } });
    // Consent: with "Require a grant" on, a model reads nothing until a live grant names it. (A direction trial that gives the
    // model no record text needs none; its record arm only ever sees what a grant covers.)
    const onlyDirections = args.jobs !== undefined && args.jobs.length > 0 && args.jobs.every((j) => j === "directions");
    if (!onlyDirections && noGrantReason(s.consent, readerOfEngine(this.d.engine.kind), localDayKey(this.d.now())) !== null) throw new CortexError("E_PAUSED", "no grant lets a model read the record", { detail: { reason: "no-grant" } });
  }

  async run(args: AgentsRunArgs): Promise<PassResult> {
    this.gate(args);
    const d = this.d;
    const settings = d.settings;
    const t0 = d.now();
    const control = await readControl(d.store);
    if (control.paused || settings.agents.paused) throw new CortexError("E_PAUSED", "agents are paused", { detail: { reason: "paused" } });
    const deadline = args.maxSeconds !== undefined && args.maxSeconds > 0 ? t0 + args.maxSeconds * 1000 : undefined;
    const maxJobs = Math.max(0, Math.min(MAX_PASS_JOBS, Math.floor(args.maxJobs ?? DEFAULT_PASS_MAX_JOBS)));
    const concurrency = d.mode === "worker" ? 1 : Math.max(1, Math.min(4, Math.floor(settings.agents.concurrency)));
    const caps = capsOf(settings);
    return withLock(locksDirOf(d.store.cacheDir), "runner:agents", { owner: d.store.owner, staleMs: d.store.lockStaleMs, waitMs: 0 }, async () => {
      const startBudget = await loadBudget(d.store);
      const queue = await loadQueue(d.store.cacheDir);
      const finishResult = async (runs: PassResult["runs"], queued: number, extra: Partial<PassResult>, budget?: BudgetState): Promise<PassResult> => {
        const b = budget ?? (await loadBudget(d.store));
        const st = budgetStatus(b, caps, undefined, d.now());
        const es = currentEngineState(await loadEngineState(d.store.cacheDir), d.now());
        const res: PassResult = { runs, tokensToday: st.tokensToday, plan: st.plan, capped: st.capped || extra.stopped === "capped", queued, partial: false, ...extra };
        if (es.state !== "ok") {
          res.engine = es.state;
          if (es.resumeAt) res.resumeAt = es.resumeAt;
        } else if (st.block && res.stopped === "capped") res.resumeAt = new Date(st.block.resumeAt).toISOString();
        return res;
      };
      if (args.dryRun) {
        const ctx = this.context(noCallEngine(d.engine), d.ledger, control.privacyRev, () => undefined);
        const plans = (await this.collectPlans(args, ctx, queue, Math.max(maxJobs, 1) * 4)).slice(0, maxJobs);
        return finishResult([], plans.length, {
          planned: plans.map((p) => ({ job: p.job, targets: p.targets.length, model: p.model, estimateTokens: p.estimateTokens })),
          estimateTokens: plans.reduce((s, p) => s + p.estimateTokens, 0),
        }, startBudget);
      }
      if (budgetStatus(startBudget, caps, undefined, d.now()).capped) {
        this.emitBudget(startBudget);
        return finishResult([], queue.items.length, { stopped: "capped" }, startBudget);
      }
      await ensureEngineReady(this.gateDeps());
      if (maxJobs === 0) return finishResult([], queue.items.length, {});

      // Per-pass watches: which runs logged their reads, which records the jobs wrote, events once per run.
      const watch: LedgerWatch = { reads: new Set(), runs: new Map() };
      const announced = new Set<string>();
      const emitOnce = (e: RunnerEvent): void => {
        if (e.kind === "job-started" || e.kind === "job-finished") {
          const k = `${e.kind}:${e.runId}`;
          if (announced.has(k)) return;
          announced.add(k);
        }
        d.emit(e);
      };
      const ledger = watchLedger(d.ledger, watch, (rec) => {
        if (rec.status === "running") emitOnce({ kind: "job-started", job: rec.job, runId: rec.id, targets: rec.targets.length, model: rec.model });
        else emitOnce({ kind: "job-finished", job: rec.job, runId: rec.id, status: rec.status, tokens: runTokens(rec), costUsd: rec.costUsd });
      });
      const guardDeps: GuardDeps = {
        inner: d.engine,
        store: d.store,
        settings,
        privacyRev: control.privacyRev,
        token: d.token,
        now: d.now,
        log: d.log,
        emit: emitOnce,
        readLogged: (runId) => watch.reads.has(runId),
        onEngineState: async (state, error) => void (await enterEngineState({ store: d.store, emit: d.emit, now: d.now }, state, error)),
      };
      if (deadline !== undefined) guardDeps.deadline = deadline;
      if (args.maxTokens !== undefined && args.maxTokens > 0) guardDeps.maxTokens = args.maxTokens;
      const guard = new GuardedEngine(guardDeps);
      const ctx = this.context(guard, ledger, control.privacyRev, emitOnce, deadline);
      const plans = await this.collectPlans(args, ctx, queue, Math.max(maxJobs, 1) * 4);

      const runs: PassResult["runs"] = [];
      const retries: { plan: PlannedJob; error: string }[] = [];
      const doneQueueIds = new Set<string>();
      const started = new Set<string>();
      let index = 0;
      let stop: PassStop | undefined;
      let partial = false;

      const failRecord = (plan: PlannedJob, code: string, base?: RunRecord): RunRecord => {
        const nowIso = new Date(d.now()).toISOString();
        if (base) {
          const u = guard.perRun.get(base.id)?.usage;
          const rec: RunRecord = { ...base, status: statusForCode(code), finishedAt: nowIso, error: { code, message: runErrorText(code) } };
          if (u) {
            rec.tokensIn = Math.max(rec.tokensIn, u.inputTokens);
            rec.tokensOut = Math.max(rec.tokensOut, u.outputTokens);
            rec.tokensCacheRead = Math.max(rec.tokensCacheRead, u.cacheReadTokens);
            rec.tokensCacheWrite = Math.max(rec.tokensCacheWrite, u.cacheWriteTokens);
            rec.costUsd = Math.max(rec.costUsd, u.costUsd);
            rec.tokensEstimated = rec.tokensEstimated || u.estimated;
          }
          return rec;
        }
        return {
          v: 1,
          id: newRunId(d.now()),
          job: plan.job,
          pass: 1,
          engine: guard.kind,
          model: plan.model,
          where: guard.where,
          paidBy: guard.paidBy,
          startedAt: nowIso,
          finishedAt: nowIso,
          status: statusForCode(code),
          targets: [...plan.targets],
          items: plan.targets.length,
          labels: 0,
          declined: 0,
          noAnswer: 0,
          tokensIn: 0,
          tokensOut: 0,
          tokensCacheRead: 0,
          tokensCacheWrite: 0,
          tokensEstimated: false,
          costUsd: 0,
          priceTableDate: "",
          promptVersion: PROMPT_VERSIONS[plan.job],
          settingsSource: d.settingsSource,
          ...(plan.experiment ? { experiment: { purpose: plan.experiment.purpose, arm: plan.experiment.arm, directions: [], passages: 0 } } : {}),
          error: { code, message: runErrorText(code) },
        };
      };

      const runPlan = async (plan: PlannedJob): Promise<void> => {
        let rec: RunRecord;
        let thrown: CortexError | undefined;
        try {
          rec = await this.jobs.runJob(plan, ctx);
          if (rec.status === "running") rec = { ...rec, status: "failed", finishedAt: new Date(d.now()).toISOString(), error: { code: "E_INTERNAL", message: runErrorText("E_INTERNAL") } };
          const seen = watch.runs.get(rec.id);
          if (!seen || seen.status === "running") await ledger.append("runs", [rec]);
        } catch (e) {
          thrown = asCortexError(e);
          const code = internalCode(thrown.code);
          const open = [...watch.runs.values()].filter((r) => r.status === "running" && r.job === plan.job && sameTargets(r.targets, plan.targets));
          if (open.length > 0) {
            for (const r of open) await ledger.append("runs", [failRecord(plan, code, r)]);
            rec = watch.runs.get((open[open.length - 1] as RunRecord).id) as RunRecord;
          } else {
            rec = failRecord(plan, code);
            await ledger.append("runs", [rec]);
          }
        }
        runs.push({ runId: rec.id, job: rec.job, status: rec.status, tokens: runTokens(rec), costUsd: rec.costUsd, targets: rec.targets.length });
        const code = thrown ? internalCode(thrown.code) : rec.error?.code;
        if (rec.status === "finished" || rec.status === "nothing tagged") {
          if (plan.queueId) doneQueueIds.add(plan.queueId);
          return;
        }
        if (guard.blocked) {
          stop ??= "engine";
          return;
        }
        if (code === "E_TIMEOUT" && deadline !== undefined && d.now() >= deadline - MIN_CALL_WINDOW_MS) {
          // Cut by the pass deadline: it runs again next pass, without counting as a failure.
          stop ??= "deadline";
          partial = true;
          return;
        }
        if (rec.status === "stopped") {
          stop ??= code === "E_PAUSED" ? "paused" : "cancelled";
          return;
        }
        if (rec.status === "capped") {
          if (guard.tokensSpent > 0 && args.maxTokens !== undefined && guard.tokensSpent + plan.estimateTokens > args.maxTokens) {
            stop ??= "max-tokens";
            partial = true;
          } else stop ??= "capped";
          return;
        }
        const retryable = plan.job !== "directions" && (thrown ? thrown.retryable || RETRYABLE_CODES.has(code ?? "") : code !== undefined && RETRYABLE_CODES.has(code));
        if (retryable) retries.push({ plan, error: code ?? "E_INTERNAL" });
        else if (plan.queueId) doneQueueIds.add(plan.queueId);
      };

      let cappedRecorded = false;
      const worker = async (): Promise<void> => {
        for (;;) {
          if (stop !== undefined || d.token.cancelled || index >= plans.length) return;
          if (started.size >= maxJobs) {
            stop ??= "max-jobs";
            partial = true;
            return;
          }
          if (deadline !== undefined && deadline - d.now() < MIN_CALL_WINDOW_MS) {
            stop ??= "deadline";
            partial = true;
            return;
          }
          const plan = plans[index++] as PlannedJob;
          const b = await loadBudget(d.store);
          if (!canStart(b, caps, undefined, d.now()).ok) {
            stop ??= "capped";
            if (!cappedRecorded) {
              cappedRecorded = true;
              const rec = failRecord(plan, "E_BUDGET_CAPPED");
              await ledger.append("runs", [rec]);
              runs.push({ runId: rec.id, job: rec.job, status: rec.status, tokens: 0, costUsd: 0, targets: rec.targets.length });
            }
            this.emitBudget(b);
            return;
          }
          if (args.maxTokens !== undefined && args.maxTokens > 0 && guard.tokensSpent + plan.estimateTokens > args.maxTokens) {
            stop ??= "max-tokens";
            partial = true;
            return;
          }
          const c = await readControl(d.store);
          const go = mayContinue(c, control.privacyRev);
          if (!go.ok) {
            stop ??= go.reason;
            return;
          }
          if (guard.blocked) {
            stop ??= "engine";
            return;
          }
          started.add(plan.key);
          await runPlan(plan);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, plans.length)) }, () => worker()));
      if (d.token.cancelled) stop = "cancelled";

      // Persist the queue: finished or permanently failed items leave it; retryable failures back off.
      if (doneQueueIds.size > 0 || retries.length > 0) {
        await mutateQueue(d.store, (q) => {
          q.items = q.items.filter((i) => !doneQueueIds.has(i.id));
          const now = d.now();
          for (const { plan, error } of retries) {
            const attempt = plan.attempt + 1;
            const notBefore = new Date(now + retryDelay(attempt)).toISOString();
            const existing = plan.queueId ? q.items.find((i) => i.id === plan.queueId) : undefined;
            if (existing) {
              existing.attempt = attempt;
              existing.notBefore = notBefore;
              existing.lastError = error;
              existing.reason = "retry";
            } else {
              q.items.push({ id: `q_${sortableBody(now)}`, job: plan.job, targets: [...plan.targets], reason: "retry", attempt, addedAt: new Date(now).toISOString(), notBefore, lastError: error });
            }
          }
        });
      }
      if (d.token.cancelled) throw new CortexError("E_CANCELLED", "cancelled");
      const unstarted = plans.filter((p) => !started.has(p.key));
      const unstartedQueueIds = new Set(unstarted.flatMap((p) => (p.queueId ? [p.queueId] : [])));
      const endQueue = await loadQueue(d.store.cacheDir);
      const queued = unstarted.length + endQueue.items.filter((i) => !unstartedQueueIds.has(i.id)).length;
      const budget = guard.budget ?? (await loadBudget(d.store));
      this.emitBudget(budget);
      const extra: Partial<PassResult> = { partial: partial && queued > 0 };
      if (stop !== undefined) extra.stopped = stop;
      return finishResult(runs, queued, extra, budget);
    });
  }

  /**
   * `ai.ask`: one Ask exchange through the same guarded engine as a pass (kill switches, read audit, budget
   * reserve/settle, engine states). Runs beside a pass: the budget lock keeps their reservations apart.
   */
  async ask(args: AiAskArgs): Promise<AiAskResult> {
    this.gate({ reason: "manual" });
    // No model: the rules can file the record, but they cannot answer a question.
    if (this.d.engine.kind === "rule") throw new CortexError("E_ENGINE_MISSING", "Ask needs a model", { detail: { reason: "no-model" } });
    const d = this.d;
    const settings = d.settings;
    const control = await readControl(d.store);
    if (control.paused || settings.agents.paused) throw new CortexError("E_PAUSED", "agents are paused", { detail: { reason: "paused" } });
    await ensureEngineReady(this.gateDeps());
    const watch: LedgerWatch = { reads: new Set(), runs: new Map() };
    const announced = new Set<string>();
    const emitOnce = (e: RunnerEvent): void => {
      if (e.kind === "job-started" || e.kind === "job-finished") {
        const k = `${e.kind}:${e.runId}`;
        if (announced.has(k)) return;
        announced.add(k);
      }
      d.emit(e);
    };
    const ledger = watchLedger(d.ledger, watch, (rec) => {
      if (rec.status === "running") emitOnce({ kind: "job-started", job: rec.job, runId: rec.id, targets: rec.targets.length, model: rec.model });
      else emitOnce({ kind: "job-finished", job: rec.job, runId: rec.id, status: rec.status, tokens: runTokens(rec), costUsd: rec.costUsd });
    });
    const guard = new GuardedEngine({
      inner: d.engine,
      store: d.store,
      settings,
      privacyRev: control.privacyRev,
      token: d.token,
      now: d.now,
      log: d.log,
      emit: emitOnce,
      readLogged: (runId) => watch.reads.has(runId),
      onEngineState: async (state, error) => void (await enterEngineState({ store: d.store, emit: d.emit, now: d.now }, state, error)),
    });
    const ctx = this.context(guard, ledger, control.privacyRev, emitOnce);
    const res = await runAnswer(args, ctx);
    this.emitBudget(guard.budget ?? (await loadBudget(d.store)));
    return res;
  }

  async status(): Promise<AgentsStatusResult> {
    const d = this.d;
    const now = d.now();
    const [budget, control, es, queue] = await Promise.all([loadBudget(d.store, now), readControl(d.store), loadEngineState(d.store.cacheDir), loadQueue(d.store.cacheDir)]);
    const st = budgetStatus(budget, capsOf(d.settings), undefined, now);
    const engine = currentEngineState(es, now);
    const pending = emptyPending();
    const queuedPairs = new Set<string>();
    // The pending targets themselves, so the status can say what they are.
    const targets: Partial<Record<JobKind, string[]>> = {};
    const keep = (job: JobKind, target: string): void => void (targets[job] ??= []).push(target);
    for (const it of queue.items) {
      for (const t of it.targets) {
        queuedPairs.add(pairKey(it.job, t));
        keep(it.job, t);
      }
      pending[it.job] += it.targets.length;
    }
    let groups: PendingGroup[] = [];
    if (d.settings.general.firstRunDone) {
      const ctx = this.context(noCallEngine(d.engine), d.ledger, control.privacyRev, () => undefined);
      for (const job of PASS_JOBS.idle) {
        try {
          for (const p of await this.jobs.selectTargets(job, ctx, 10_000)) {
            for (const t of p.targets) {
              if (queuedPairs.has(pairKey(job, t))) continue;
              pending[job]++;
              keep(job, t);
            }
          }
        } catch (e) {
          d.log.warn("pending count failed", { job, code: asCortexError(e).code });
        }
      }
      if (this.jobs.describePending) {
        try {
          groups = await this.jobs.describePending({ label: targets.label ?? [], gist: targets.gist ?? [], hub: targets.hub ?? [] }, ctx);
        } catch (e) {
          d.log.warn("pending groups failed", { code: asCortexError(e).code });
        }
      }
    }
    const res: AgentsStatusResult = {
      day: st.day,
      tokensToday: st.tokensToday,
      tokensReserved: st.tokensReserved,
      usdToday: st.usdToday,
      plan: st.plan,
      capped: st.capped,
      paused: control.paused || d.settings.agents.paused,
      engine: engine.state,
      pending,
      checks: await countOpenChecks(d.ledger),
    };
    if (groups.length > 0) res.groups = groups;
    if (engine.resumeAt) res.resumeAt = engine.resumeAt;
    else if (st.block) res.resumeAt = new Date(st.block.resumeAt).toISOString();
    const last = await latestRun(d.ledger);
    if (last) res.lastRun = last;
    return res;
  }
}

/** Review cards not resolved by a fix (a card is resolved when it names its fix or a fix targets the card). */
export async function countOpenChecks(ledger: LedgerStore): Promise<number> {
  const resolved = new Set<string>();
  for (const c of await ledger.readCorrections()) resolved.add(c.target);
  const open = new Map<string, boolean>();
  for await (const card of ledger.readAll("review")) {
    const rc = card as ReviewCardRecord;
    open.set(rc.id, rc.resolvedBy === undefined && rc.dismissedAt === undefined && !resolved.has(rc.id));
  }
  let n = 0;
  for (const v of open.values()) if (v) n++;
  return n;
}

/** The most recently started run (its latest record). */
export async function latestRun(ledger: LedgerStore): Promise<AgentsStatusResult["lastRun"] | undefined> {
  const latest = new Map<string, RunRecord>();
  for await (const r of ledger.readAll("runs")) latest.set(r.id, r);
  let best: RunRecord | undefined;
  for (const r of latest.values()) if (!best || r.startedAt > best.startedAt || (r.startedAt === best.startedAt && compareIds(r.id, best.id) > 0)) best = r;
  if (!best) return undefined;
  const out: NonNullable<AgentsStatusResult["lastRun"]> = { runId: best.id, job: best.job, status: best.status };
  if (best.finishedAt) out.finishedAt = best.finishedAt;
  return out;
}
