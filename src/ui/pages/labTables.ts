/**
 * Lab tables (SPEC V17): "Spend by day" and "Conversations tagged", both folded from the runs ledger Cortex already
 * keeps (RunRecord). Pure helpers; Agents.tsx renders them. Owner: E12.
 */
import type { RunRecord } from "../../shared/types";

export interface SpendDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  /** API-equivalent cost of the day's runs in US dollars (0 when the plan covered them). */
  spent: number;
  /** Runs started that day. */
  calls: number;
}

/** `YYYY-MM-DD` of an instant in the viewer's time zone. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The last `days` days (today included) that had at least one run, newest first. */
export function spendByDay(runs: readonly Pick<RunRecord, "startedAt" | "costUsd">[], days = 14, nowMs = Date.now()): SpendDay[] {
  const oldest = new Date(nowMs);
  oldest.setHours(0, 0, 0, 0);
  oldest.setDate(oldest.getDate() - (Math.max(1, days) - 1));
  const byDay = new Map<string, SpendDay>();
  for (const r of runs) {
    const ms = Date.parse(r.startedAt);
    if (!Number.isFinite(ms) || ms < oldest.getTime() || ms > nowMs + 86_400_000) continue;
    const day = localDayKey(ms);
    const row = byDay.get(day) ?? { day, spent: 0, calls: 0 };
    row.calls += 1;
    row.spent += Number.isFinite(r.costUsd) && r.costUsd > 0 ? r.costUsd : 0;
    byDay.set(day, row);
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

/** "≈$0.42", or an en dash when nothing was spent. */
export function fmtSpend(usd: number): string {
  return usd > 0 ? `≈$${usd.toFixed(2)}` : "–";
}

/** Who pays for a row's runs, from the ledger's `paidBy` of each run: the plan, the API account, nothing (it ran on this computer), or a mix. */
export type PaidBy = RunRecord["paidBy"] | "mixed";

/** The payer shared by every run, "mixed" when they differ, "none" for no runs; a run with no recorded payer counts as "none". */
export function paidByOf(runs: readonly Pick<RunRecord, "paidBy">[]): PaidBy {
  let seen: RunRecord["paidBy"] | null = null;
  for (const r of runs) {
    const v = r.paidBy === "plan" || r.paidBy === "api" ? r.paidBy : "none";
    if (seen !== null && seen !== v) return "mixed";
    seen = v;
  }
  return seen ?? "none";
}

/** What a model's labelling stands at right now (the NOW column). */
export type TaggedNow = "finished" | "running" | "stopped" | "none" | "failed" | "capped";

export interface TaggedRow {
  key: string;
  model: string;
  pack: string | undefined;
  /** Who paid for the row's runs (the ledger's `paidBy`). */
  paidBy: PaidBy;
  /** Distinct conversations and notes the runs processed. */
  conversations: number;
  tagged: number;
  refused: number;
  now: TaggedNow;
}

/** The state shown in NOW for the newest run of a row. */
export function taggedNow(r: Pick<RunRecord, "status" | "items" | "labels">): TaggedNow {
  switch (r.status) {
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "capped":
      return "capped";
    case "stopped":
      return r.items > 0 ? "stopped" : "none";
    case "nothing tagged":
      return "none";
    default:
      return r.labels > 0 ? "finished" : "none";
  }
}

/** One row per model and pack over the labelling runs: who tagged how many conversations, and what is happening now. Newest activity first. */
export function taggedRows(runs: readonly RunRecord[]): TaggedRow[] {
  const groups = new Map<string, { rows: RunRecord[]; targets: Set<string> }>();
  for (const r of runs) {
    if (r.job !== "label") continue;
    const key = `${r.model}\u0000${r.pack ?? ""}`;
    const g = groups.get(key) ?? { rows: [], targets: new Set<string>() };
    g.rows.push(r);
    for (const id of r.targets) g.targets.add(id);
    groups.set(key, g);
  }
  const out: { row: TaggedRow; last: string }[] = [];
  for (const [key, g] of groups) {
    const newest = g.rows.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
    out.push({
      last: newest.startedAt,
      row: {
        key,
        model: newest.model,
        pack: newest.pack,
        paidBy: paidByOf(g.rows),
        conversations: g.targets.size > 0 ? g.targets.size : g.rows.reduce((n, r) => n + r.items, 0),
        tagged: g.rows.reduce((n, r) => n + r.labels, 0),
        refused: g.rows.reduce((n, r) => n + r.declined, 0),
        now: taggedNow(newest),
      },
    });
  }
  return out.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0)).map((x) => x.row);
}

// ───────────────────────────── budget in dollars (Agents › Budget) ─────────────────────────────

/** Average list-price dollars per token over the runs that recorded a cost; null when none did (the engine reports no money). */
export function usdPerToken(runs: readonly Pick<RunRecord, "tokensIn" | "tokensOut" | "costUsd">[]): number | null {
  let usd = 0;
  let tokens = 0;
  for (const r of runs) {
    const n = (Number.isFinite(r.tokensIn) ? Math.max(0, r.tokensIn) : 0) + (Number.isFinite(r.tokensOut) ? Math.max(0, r.tokensOut) : 0);
    if (!(r.costUsd > 0) || !Number.isFinite(r.costUsd) || n <= 0) continue;
    usd += r.costUsd;
    tokens += n;
  }
  return tokens > 0 ? usd / tokens : null;
}

