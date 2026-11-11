/**
 * Agent spend accounting and the plan caps. Owner: E5.
 * There is no daily token or dollar limit: tokens and dollars are only counted and shown (local midnight reset).
 * What stops agents is the Claude plan itself: the latest 5-hour and weekly utilization that Claude Code reports
 * (shared/planLimits.ts) is kept in `plan`, and a call or pass does not start while a window is at the cap the person
 * set for it, until that window's reset time. Every engine call is charged input + output + cache-read +
 * cache-write tokens. State lives in
 * `.vault-meta/cortex/state/budget.json` (shared truth across computers, rewritten atomically under the local
 * budget lock); the runs ledger remains the audit trail.
 *
 * Reservations (BUDGET-RESERVE): before a call the GuardedEngine (agents/scheduler.ts) checks the plan caps and
 * records the call as open under the lock (today.reserved += estimate); after the call the reservation is settled
 * with the actual usage. A call killed
 * after it started (cancel, timeout) is charged its estimate, because it spent tokens. A reservation left open by
 * a crashed runner is charged its estimate after RESERVATION_STALE_MS (it may have spent tokens).
 *
 * One enforcement point: jobs run under the scheduler get a StoreContext marked engine-managed
 * (markEngineManaged); for such a context reserveBudget/settleBudget are no-ops, because the GuardedEngine already
 * reserves and settles every call. Code that drives a raw engine (not through the scheduler) calls them itself.
 *
 * Ask calls are left out of the counted tokens when "Ask counts toward the cap" is off; their tokens are kept in
 * `uncounted` so Today and the ledger still show them. An unreadable budget file fails closed: today counts as
 * capped (`unknown`) until the next local day.
 */
import { readJsonIfExists, writeJsonAtomic } from "../node/fsAtomic";
import { locksDirOf, withLock } from "../node/locks";
import { resolveInVault, writablePath } from "../node/paths";
import { mergePlan, normalizePlan, planBlock, planViews, type PlanBlock, type PlanCaps, type PlanWindows, type PlanWindowId, type PlanWindowView } from "../shared/planLimits";
import { budgetDay } from "../shared/time";
import { budgetPath, type StoreContext } from "../store/layout";
import type { RunnerEvent } from "../shared/protocol/runner";
import type { CortexSettings } from "../shared/settings";
import { planCapsOf } from "../shared/planLimits";
import { CortexError } from "../shared/errors";
import type { EngineError, EngineUsage } from "./engine";

/** An open reservation: tokens held for a call in flight, and when (epoch ms). */
export interface OpenReservation {
  tokens: number;
  at: number;
}

export interface BudgetDay {
  day: string;
  /** Tokens charged against the cap. */
  tokens: number;
  usd: number;
  calls: number;
  /** Tokens reserved by calls in flight. */
  reserved: number;
  /** Open reservations by call id. */
  open: Record<string, OpenReservation>;
  /** Tokens of calls that do not count toward the cap (Ask with "Ask counts toward the cap" off). */
  uncounted?: number;
  /** Earlier versions: the daily token cap in force on that day (read for old capped days; no longer written). */
  cap?: number;
  /** The budget file could not be read today: the day counts as capped (fail closed). */
  unknown?: boolean;
}

export interface BudgetHistoryDay {
  day: string;
  tokens: number;
  usd: number;
  calls: number;
  uncounted?: number;
  cap?: number;
  capped?: boolean;
  unknown?: boolean;
}

export interface BudgetState {
  v: 1;
  today: BudgetDay;
  /** Previous days, newest first, at most HISTORY_DAYS. */
  history: BudgetHistoryDay[];
  /** The plan's 5-hour and weekly windows as Claude Code last reported them (absent until a call has run). */
  plan?: PlanWindows;
}

export const HISTORY_DAYS = 30;
/** Reservations older than this are charged as spent (their runner died mid-call). */
export const RESERVATION_STALE_MS = 30 * 60_000;

export function emptyBudget(day = budgetDay()): BudgetState {
  return { v: 1, today: { day, tokens: 0, usd: 0, calls: 0, reserved: 0, open: {} }, history: [] };
}

export function chargedTokens(u: EngineUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Validate a parsed budget file (any earlier shape); garbage values become zero, never negative. */
export function normalizeBudget(raw: unknown, day = budgetDay(), now = Date.now()): BudgetState {
  if (typeof raw !== "object" || raw === null) return emptyBudget(day);
  const r = raw as { v?: unknown; today?: unknown; history?: unknown; plan?: unknown };
  if (r.v !== 1 || typeof r.today !== "object" || r.today === null) return emptyBudget(day);
  const t = r.today as Record<string, unknown>;
  if (!isDay(t.day)) return emptyBudget(day);
  const open: Record<string, OpenReservation> = {};
  if (typeof t.open === "object" && t.open !== null) {
    for (const [id, v] of Object.entries(t.open as Record<string, unknown>)) {
      if (typeof v === "number") open[id] = { tokens: count(v), at: now };
      else if (typeof v === "object" && v !== null) open[id] = { tokens: count((v as OpenReservation).tokens), at: count((v as OpenReservation).at) || now };
    }
  }
  const today: BudgetDay = {
    day: t.day,
    tokens: count(t.tokens),
    usd: count(t.usd),
    calls: count(t.calls),
    reserved: Object.values(open).reduce((s, o) => s + o.tokens, 0),
    open,
  };
  if (count(t.uncounted) > 0) today.uncounted = count(t.uncounted);
  if (count(t.cap) > 0) today.cap = count(t.cap);
  if (t.unknown === true) today.unknown = true;
  const history: BudgetHistoryDay[] = [];
  if (Array.isArray(r.history)) {
    for (const h of r.history as Record<string, unknown>[]) {
      if (typeof h !== "object" || h === null || !isDay(h.day)) continue;
      const d: BudgetHistoryDay = { day: h.day, tokens: count(h.tokens), usd: count(h.usd), calls: count(h.calls) };
      if (count(h.uncounted) > 0) d.uncounted = count(h.uncounted);
      if (count(h.cap) > 0) d.cap = count(h.cap);
      if (h.capped === true) d.capped = true;
      if (h.unknown === true) d.unknown = true;
      history.push(d);
    }
  }
  const plan = normalizePlan(r.plan);
  return { v: 1, today, history: history.slice(0, HISTORY_DAYS), ...(plan ? { plan } : {}) };
}

/** Roll the state forward to `day` (moving the old day into history; open reservations do not carry over). */
export function rollDay(s: BudgetState, day = budgetDay()): BudgetState {
  if (s.today.day === day) return { ...s, today: { ...s.today, reserved: s.today.reserved ?? 0, open: { ...(s.today.open ?? {}) } } };
  const { day: d, tokens, usd, calls, uncounted, cap, unknown } = s.today;
  const past: BudgetHistoryDay = { day: d, tokens, usd, calls };
  if (uncounted) past.uncounted = uncounted;
  if (cap) {
    past.cap = cap;
    if (tokens >= cap) past.capped = true;
  }
  if (unknown) past.unknown = true;
  const history = [past, ...s.history.filter((h) => h.day !== d)].filter((x) => x.calls > 0 || x.tokens > 0 || x.unknown === true || (x.uncounted ?? 0) > 0).slice(0, HISTORY_DAYS);
  return { v: 1, today: { day, tokens: 0, usd: 0, calls: 0, reserved: 0, open: {} }, history, ...(s.plan ? { plan: s.plan } : {}) };
}

/** Charge reservations older than `staleMs` as spent (a crashed runner's calls may have used tokens). */
export function expireStale(s: BudgetState, now = Date.now(), staleMs = RESERVATION_STALE_MS): BudgetState {
  const open: Record<string, OpenReservation> = {};
  let charge = 0;
  let calls = 0;
  for (const [id, o] of Object.entries(s.today.open)) {
    if (now - o.at > staleMs) {
      charge += o.tokens;
      calls++;
    } else open[id] = o;
  }
  if (calls === 0) return s;
  const reserved = Object.values(open).reduce((sum, o) => sum + o.tokens, 0);
  return { ...s, today: { ...s.today, tokens: s.today.tokens + charge, calls: s.today.calls + calls, reserved, open } };
}

/** Rough token estimate for a prompt (≈3.5 characters per token) plus the expected output. */
export function estimateTokens(promptChars: number, systemChars: number, expectedOutputTokens: number): number {
  return Math.ceil((Math.max(0, promptChars) + Math.max(0, systemChars)) / 3.5) + Math.max(0, Math.ceil(expectedOutputTokens));
}

/** `block` names the plan window at its cap and when it resets; it is absent when the budget file could not be read. */
export type BudgetDecision = { ok: true } | { ok: false; reason: "capped"; block?: PlanBlock };

/** Whether work may start: not while the budget file is unreadable, nor while a plan window is at its cap before its reset. */
export function canStart(s: BudgetState, caps: PlanCaps, day = budgetDay(), now = Date.now()): BudgetDecision {
  const cur = rollDay(s, day);
  if (cur.today.unknown === true) return { ok: false, reason: "capped" };
  const block = planBlock(cur.plan, caps, now);
  return block ? { ok: false, reason: "capped", block } : { ok: true };
}

/** Pure: record call `id` as open (holding `estimate` tokens) if the plan caps allow it. */
export function reserve(s: BudgetState, caps: PlanCaps, id: string, estimate: number, day = budgetDay(), now = Date.now()): { state: BudgetState; decision: BudgetDecision } {
  const cur = rollDay(s, day);
  const decision = canStart(cur, caps, day, now);
  if (!decision.ok) return { state: cur, decision };
  const prev = cur.today.open[id]?.tokens ?? 0;
  const open = { ...cur.today.open, [id]: { tokens: estimate, at: now } };
  return { state: { ...cur, today: { ...cur.today, reserved: cur.today.reserved - prev + estimate, open } }, decision };
}

/**
 * Pure: settle call `id`. With usage → charge it; without usage and `startedCall` → charge the estimate (the call
 * spent tokens before it was killed); otherwise release the reservation. `counted` false puts the tokens in
 * `uncounted` instead of against the cap (Ask with "Ask counts toward the cap" off).
 */
export function settle(s: BudgetState, id: string, usage: EngineUsage | null, startedCall: boolean, day = budgetDay(), opts: { counted?: boolean } = {}): BudgetState {
  const cur = rollDay(s, day);
  const est = cur.today.open[id]?.tokens ?? 0;
  const open = { ...cur.today.open };
  delete open[id];
  const charge = usage ? chargedTokens(usage) : startedCall ? est : 0;
  const called = usage !== null || startedCall;
  const today: BudgetDay = {
    ...cur.today,
    usd: cur.today.usd + count(usage?.costUsd),
    calls: cur.today.calls + (called ? 1 : 0),
    reserved: Math.max(0, cur.today.reserved - est),
    open,
  };
  if (opts.counted === false) today.uncounted = (cur.today.uncounted ?? 0) + charge;
  else today.tokens = cur.today.tokens + charge;
  return { ...cur, today };
}

export function applyUsage(s: BudgetState, u: EngineUsage, day = budgetDay()): BudgetState {
  const cur = rollDay(s, day);
  return { ...cur, today: { ...cur.today, tokens: cur.today.tokens + chargedTokens(u), usd: cur.today.usd + u.costUsd, calls: cur.today.calls + 1 } };
}

export interface BudgetStatus {
  day: string;
  tokensToday: number;
  tokensReserved: number;
  /** Tokens left out of the counted total today (Ask, when configured). */
  uncounted: number;
  /** Dollars spent today at API list prices (shown, never a limit). */
  usdToday: number;
  /** The plan's two windows with their caps. */
  plan: Record<PlanWindowId, PlanWindowView>;
  /** The plan window at its cap now, when one is. */
  block: PlanBlock | null;
  capped: boolean;
}

export function budgetStatus(s: BudgetState, caps: PlanCaps, day = budgetDay(), now = Date.now()): BudgetStatus {
  const cur = rollDay(s, day);
  const block = planBlock(cur.plan, caps, now);
  return {
    day: cur.today.day,
    tokensToday: cur.today.tokens,
    tokensReserved: cur.today.reserved,
    uncounted: cur.today.uncounted ?? 0,
    usdToday: cur.today.usd,
    plan: planViews(cur.plan, caps, now),
    block,
    capped: cur.today.unknown === true || block !== null,
  };
}

/** The plan caps in force from the settings. */
export function capsOf(s: Pick<CortexSettings, "agents">): PlanCaps {
  return planCapsOf(s.agents.planCaps);
}

/** The runner's budget event for a status. */
export function budgetEvent(st: BudgetStatus): Extract<RunnerEvent, { kind: "budget" }> {
  return { kind: "budget", day: st.day, tokensToday: st.tokensToday, usdToday: st.usdToday, plan: st.plan, capped: st.capped };
}

/** Cortex-written text for a call or pass that does not start because of a plan cap (never CLI text). */
export function cappedMessage(block: PlanBlock | undefined): string {
  if (!block) return "the budget file could not be read";
  return block.window === "fiveHour" ? "the plan's 5-hour limit is at your cap" : "the plan's weekly limit is at your cap";
}

/** The engine failure for a call refused by a plan cap: `reason` names the window, `resumeAt` is when it resets. */
export function cappedFailure(block: PlanBlock | undefined): EngineError {
  const e: EngineError = { code: "E_BUDGET_CAPPED", message: cappedMessage(block), retryable: false, reason: block ? (block.window === "fiveHour" ? "plan-5h" : "plan-weekly") : "unreadable" };
  if (block) e.resumeAt = new Date(block.resumeAt).toISOString();
  return e;
}

/** The thrown form of cappedFailure (the live check). */
export function cappedError(block: PlanBlock | undefined): CortexError {
  return new CortexError("E_BUDGET_CAPPED", cappedMessage(block), { detail: { scope: "plan", ...(block ? { window: block.window, resumeAt: new Date(block.resumeAt).toISOString() } : {}) } });
}

// ───────────────────────────── on disk ─────────────────────────────

/** Read the current state (rolled to today, stale reservations charged). An unreadable file fails closed. */
export async function loadBudget(ctx: Pick<StoreContext, "vaultRoot">, now = Date.now()): Promise<BudgetState> {
  const day = budgetDay(now);
  let raw: unknown;
  try {
    raw = await readJsonIfExists<unknown>(resolveInVault(ctx.vaultRoot, budgetPath()));
  } catch {
    const s = emptyBudget(day);
    s.today.unknown = true;
    return s;
  }
  if (raw === null) return emptyBudget(day);
  return expireStale(rollDay(normalizeBudget(raw, day, now), day), now);
}

async function mutate(ctx: StoreContext, fn: (s: BudgetState) => BudgetState): Promise<BudgetState> {
  return withLock(locksDirOf(ctx.cacheDir), "state:budget", { owner: ctx.owner, staleMs: ctx.lockStaleMs }, async () => {
    const next = fn(await loadBudget(ctx));
    await writeJsonAtomic(writablePath(ctx.vaultRoot, budgetPath()), next);
    return next;
  });
}

/** Reserve before a call (locked); always acts. Used by the GuardedEngine. */
export async function reserveForCall(ctx: StoreContext, caps: PlanCaps, id: string, estimate: number): Promise<BudgetDecision> {
  let decision: BudgetDecision = { ok: true };
  await mutate(ctx, (s) => {
    const r = reserve(s, caps, id, estimate, budgetDay(), Date.now());
    decision = r.decision;
    return r.state;
  });
  return decision;
}

/** Settle after a call (locked); always acts. Used by the GuardedEngine. `plan` is the utilization the call reported. */
export async function settleCall(ctx: StoreContext, id: string, usage: EngineUsage | null, startedCall: boolean, counted = true, plan?: PlanWindows | null): Promise<BudgetState> {
  return mutate(ctx, (s) => {
    const next = settle(s, id, usage, startedCall, budgetDay(), { counted });
    const seen = plan ?? usage?.plan;
    return seen ? { ...next, plan: mergePlan(next.plan, seen) } : next;
  });
}

/** Keep the latest plan utilization a call reported (locked), without charging anything. */
export async function recordPlan(ctx: StoreContext, plan: PlanWindows): Promise<BudgetState> {
  return mutate(ctx, (s) => ({ ...s, plan: mergePlan(s.plan, plan) }));
}

const managed = new WeakSet<object>();

/** The scheduler's jobs get this context: their budget is handled per call by the GuardedEngine. */
export function markEngineManaged(ctx: StoreContext): StoreContext {
  managed.add(ctx);
  return ctx;
}

export function isEngineManaged(ctx: StoreContext): boolean {
  return managed.has(ctx);
}

/** Reserve before a call (locked). A no-op for engine-managed contexts (the GuardedEngine reserves). */
export async function reserveBudget(ctx: StoreContext, caps: PlanCaps, id: string, estimate: number): Promise<BudgetDecision> {
  if (isEngineManaged(ctx)) return { ok: true };
  return reserveForCall(ctx, caps, id, estimate);
}

/** Settle after a call (locked). A no-op for engine-managed contexts (the GuardedEngine settles). */
export async function settleBudget(ctx: StoreContext, id: string, usage: EngineUsage | null, startedCall: boolean): Promise<BudgetState> {
  if (isEngineManaged(ctx)) return loadBudget(ctx);
  return settleCall(ctx, id, usage, startedCall);
}
