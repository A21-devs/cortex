/**
 * The Claude plan's own limits, as Claude Code reports them (pure; no I/O).
 *
 * Claude Code (headless, `--output-format stream-json --verbose`) emits `rate_limit_event` lines whose
 * `rate_limit_info` carries the plan windows it read from the API's response headers: `unifiedWindows.five_hour` and
 * `unifiedWindows.seven_day`, each with `utilization` (the fraction of the window used, usually 0 to 1) and `resetsAt`
 * (epoch seconds); older builds put one window at the top level (`rateLimitType`, `utilization`, `resetsAt`). A rejected
 * window without a utilization counts as full. Nothing here sends a prompt: readings arrive with the calls the agents
 * make anyway, so a window is "not reported yet" until one has run.
 *
 * Cortex keeps the latest reading of each window (with its reset time) in the budget state, and stops agents when a
 * window's use reaches the person's cap for it. A window whose reset time has passed counts as empty again, so a pass
 * that paused at a cap resumes by itself after the reset.
 */

export type PlanWindowId = "fiveHour" | "weekly";
export const PLAN_WINDOWS: readonly PlanWindowId[] = ["fiveHour", "weekly"];

/** One window as last reported. */
export interface PlanWindow {
  /** Percent of the window used, 0 and up (above 100 when usage ran past the limit). */
  pct: number;
  /** When the window resets (epoch ms). */
  resetsAt: number;
  /** When this reading was taken (epoch ms). */
  seenAt: number;
}

export interface PlanWindows {
  fiveHour?: PlanWindow;
  weekly?: PlanWindow;
}

/** The caps in force: a percent per window, or null when that cap is off. */
export interface PlanCaps {
  fiveHour: number | null;
  weekly: number | null;
}

/** Why work may not start: which window is at its cap, how far along it is, and when it resets (epoch ms). */
export interface PlanBlock {
  window: PlanWindowId;
  pct: number;
  capPct: number;
  resumeAt: number;
}

/** What the screens show for one window. */
export interface PlanWindowView {
  window: PlanWindowId;
  /** Percent used now, or null when no reading exists yet. A window past its reset reads 0. */
  pct: number | null;
  /** The cap percent, or null when this cap is off. */
  capPct: number | null;
  /** Next reset (epoch ms), or null when unknown. */
  resetsAt: number | null;
  /** The reading is from a window that has since reset (no new reading yet). */
  stale: boolean;
  atCap: boolean;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Epoch seconds (Claude Code) or milliseconds to milliseconds. */
function toMs(v: number): number {
  return v > 1e11 ? Math.round(v) : Math.round(v * 1000);
}

/** Fraction (0 to 1+) to percent with one decimal, never negative. */
function toPct(fraction: number): number {
  return Math.max(0, Math.round(fraction * 1000) / 10);
}

function windowFrom(raw: unknown, now: number): PlanWindow | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const w = raw as { utilization?: unknown; resetsAt?: unknown; status?: unknown };
  if (!isNum(w.resetsAt)) return undefined;
  if (isNum(w.utilization)) return { pct: toPct(w.utilization), resetsAt: toMs(w.resetsAt), seenAt: now };
  if (w.status === "rejected") return { pct: 100, resetsAt: toMs(w.resetsAt), seenAt: now };
  return undefined;
}

/** The windows one `rate_limit_info` object reports (nothing for windows it does not mention). */
export function windowsFromInfo(info: unknown, now: number): PlanWindows {
  const out: PlanWindows = {};
  if (typeof info !== "object" || info === null) return out;
  const i = info as { unifiedWindows?: unknown; rateLimitType?: unknown; utilization?: unknown; resetsAt?: unknown; status?: unknown };
  const uw = typeof i.unifiedWindows === "object" && i.unifiedWindows !== null ? (i.unifiedWindows as { five_hour?: unknown; seven_day?: unknown }) : undefined;
  const five = windowFrom(uw?.five_hour, now);
  const seven = windowFrom(uw?.seven_day, now);
  if (five) out.fiveHour = five;
  if (seven) out.weekly = seven;
  if ((i.rateLimitType === "five_hour" || i.rateLimitType === "seven_day") && !(i.rateLimitType === "five_hour" ? five : seven)) {
    const w = windowFrom({ utilization: i.utilization, resetsAt: i.resetsAt, status: i.status }, now);
    if (w) out[i.rateLimitType === "five_hour" ? "fiveHour" : "weekly"] = w;
  }
  return out;
}

/** Merge a newer reading over an older one, window by window (the newer reading wins). */
export function mergePlan(prev: PlanWindows | undefined, next: PlanWindows | null | undefined): PlanWindows {
  const out: PlanWindows = { ...(prev ?? {}) };
  if (!next) return out;
  for (const id of PLAN_WINDOWS) {
    const n = next[id];
    const p = out[id];
    if (n && (!p || n.seenAt >= p.seenAt)) out[id] = n;
  }
  return out;
}

/**
 * Read the plan windows out of Claude Code's stream-json stdout: every `rate_limit_event` line, later events over
 * earlier ones. Returns null when the output holds none (a plain `json` run, an API-key run, an older CLI).
 */
export function parseRateLimitEvents(stdout: string, now = Date.now()): PlanWindows | null {
  let found: PlanWindows | null = null;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{") || !line.includes("rate_limit_event")) continue;
    let ev: { type?: unknown; rate_limit_info?: unknown };
    try {
      ev = JSON.parse(line) as typeof ev;
    } catch {
      continue;
    }
    if (ev.type !== "rate_limit_event") continue;
    const w = windowsFromInfo(ev.rate_limit_info, now);
    if (w.fiveHour || w.weekly) found = mergePlan(found ?? undefined, w);
  }
  return found;
}

/** Percent used now: a window past its reset time reads 0; no reading is undefined. */
export function effectivePct(w: PlanWindow | undefined, now: number): number | undefined {
  if (!w) return undefined;
  return w.resetsAt <= now ? 0 : w.pct;
}

/** Whether a cap percent is usable: a finite number from 1 to 100. */
export function capPctOf(v: unknown): number | null {
  return isNum(v) && v >= 1 ? Math.min(100, v) : null;
}

/** The caps in force from the settings shape (`on` false = no cap for that window). */
export function planCapsOf(c: { fiveHour: { on: boolean; pct: number }; weekly: { on: boolean; pct: number } } | undefined): PlanCaps {
  return { fiveHour: c?.fiveHour.on ? capPctOf(c.fiveHour.pct) : null, weekly: c?.weekly.on ? capPctOf(c.weekly.pct) : null };
}

/**
 * The window that stops work now, or null. A window with no reading, or whose reset has passed, never stops it. When
 * both are at their caps the one that resets later is reported (nothing runs before that).
 */
export function planBlock(plan: PlanWindows | undefined, caps: PlanCaps, now = Date.now()): PlanBlock | null {
  let worst: PlanBlock | null = null;
  for (const id of PLAN_WINDOWS) {
    const cap = caps[id];
    const w = plan?.[id];
    if (cap === null || !w) continue;
    const pct = effectivePct(w, now) ?? 0;
    if (pct < cap) continue;
    const b: PlanBlock = { window: id, pct, capPct: cap, resumeAt: w.resetsAt };
    if (!worst || b.resumeAt > worst.resumeAt) worst = b;
  }
  return worst;
}

/** What to show for both windows. */
export function planViews(plan: PlanWindows | undefined, caps: PlanCaps, now = Date.now()): Record<PlanWindowId, PlanWindowView> {
  const one = (id: PlanWindowId): PlanWindowView => {
    const w = plan?.[id];
    const cap = caps[id];
    const stale = w !== undefined && w.resetsAt <= now;
    const pct = w ? (effectivePct(w, now) as number) : null;
    return { window: id, pct, capPct: cap, resetsAt: w && !stale ? w.resetsAt : null, stale, atCap: cap !== null && pct !== null && pct >= cap };
  };
  return { fiveHour: one("fiveHour"), weekly: one("weekly") };
}

/** The same views under other caps (the settings changed): only the cap and whether it is reached change. */
export function withCaps(views: Record<PlanWindowId, PlanWindowView>, caps: PlanCaps): Record<PlanWindowId, PlanWindowView> {
  const one = (v: PlanWindowView): PlanWindowView => {
    const cap = caps[v.window];
    return { ...v, capPct: cap, atCap: cap !== null && v.pct !== null && v.pct >= cap };
  };
  return { fiveHour: one(views.fiveHour), weekly: one(views.weekly) };
}

/** Both windows with no reading yet (the state before any call has reported). */
export function emptyPlanViews(caps: PlanCaps = { fiveHour: null, weekly: null }): Record<PlanWindowId, PlanWindowView> {
  return planViews(undefined, caps, 0);
}

/** Parse the plan windows out of a stored value (any shape; garbage is dropped). */
export function normalizePlan(raw: unknown): PlanWindows | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: PlanWindows = {};
  for (const id of PLAN_WINDOWS) {
    const w = (raw as Record<string, unknown>)[id];
    if (typeof w !== "object" || w === null) continue;
    const { pct, resetsAt, seenAt } = w as Record<string, unknown>;
    if (isNum(pct) && pct >= 0 && isNum(resetsAt) && resetsAt > 0) out[id] = { pct, resetsAt, seenAt: isNum(seenAt) ? seenAt : 0 };
  }
  return out.fiveHour || out.weekly ? out : undefined;
}
