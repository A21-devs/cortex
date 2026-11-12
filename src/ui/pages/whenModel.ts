/**
 * Time › "When you wrote": the pure geometry and wording behind the sections (month columns, drag → period, axis
 * ticks, day-heat levels, stacked segments, the label choices). Rendering lives in WhenSections.tsx; the series come
 * from the worker (stats "when").
 */
import { labelDim, type DimId } from "../../shared/dims";
import type { WhenStack } from "../../shared/protocol/worker";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "Nov 2026" (fixed English abbreviations, like every other date in Cortex). */
export function monthText(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "3 Nov 2026". */
export function dayText(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "28 Oct 2024 – 11 Nov 2025". */
export function rangeText(from: number, to: number): string {
  return `${dayText(from)} – ${dayText(to)}`;
}

/** Items per month over every group of a stack. */
export function monthTotals(stack: WhenStack, months: number): number[] {
  const out = new Array<number>(months).fill(0);
  for (let g = 0; g < stack.groups.length; g++) for (let m = 0; m < months; m++) out[m]! += stack.cells[g * months + m] ?? 0;
  return out;
}

/** The month column under a pointer at fraction `frac` ∈ [0, 1] of the chart's width; -1 when there are no months. */
export function columnOf(frac: number, months: number): number {
  if (months <= 0) return -1;
  return Math.max(0, Math.min(months - 1, Math.floor(frac * months)));
}

/** The period dragged across month columns a..b (either order): from the first month's start to the last month's last ms. */
export function monthSpanPeriod(monthStarts: readonly number[], a: number, b: number): [number, number] | null {
  const months = monthStarts.length - 1;
  if (months <= 0) return null;
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(months - 1, Math.max(a, b));
  return [monthStarts[lo] as number, (monthStarts[hi + 1] as number) - 1];
}

/** The period dragged across a continuous axis [from, to) between two fractions (either order); at least one hour wide. */
export function timeSpanPeriod(fa: number, fb: number, from: number, to: number): [number, number] | null {
  if (!(to > from)) return null;
  const clamp = (f: number) => Math.max(0, Math.min(1, f));
  const a = from + clamp(Math.min(fa, fb)) * (to - from);
  const b = from + clamp(Math.max(fa, fb)) * (to - from);
  const lo = Math.round(a);
  return [lo, Math.max(Math.round(b), lo + 3_600_000)];
}

/** Axis labels: the year at each year start, or every second month when the range is under 18 months. */
export function axisTicks(monthStarts: readonly number[]): { i: number; label: string }[] {
  const months = monthStarts.length - 1;
  const out: { i: number; label: string }[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(monthStarts[i] as number);
    if (months < 18) {
      if (i % 2 === 0) out.push({ i, label: d.getMonth() === 0 || i === 0 ? `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}` : (MONTHS[d.getMonth()] as string) });
    } else if (d.getMonth() === 0 || i === 0) out.push({ i, label: String(d.getFullYear()) });
  }
  return out;
}

/** Day-heat step 0 (empty) or 1..4 for a count against the busiest day (25 / 50 / 75 / 100 %). */
export function heatLevel(n: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (n <= 0 || max <= 0) return 0;
  const f = n / max;
  return f <= 0.25 ? 1 : f <= 0.5 ? 2 : f <= 0.75 ? 3 : 4;
}

/** Month labels over the heatmap's week columns: the first week that starts in a new month, with its column index. */
export function weekMonthLabels(weekStarts: readonly number[]): { w: number; label: string }[] {
  const out: { w: number; label: string }[] = [];
  let last = -1;
  weekStarts.forEach((ms, w) => {
    const d = new Date(ms + 3 * 86_400_000);
    const key = d.getFullYear() * 12 + d.getMonth();
    if (key !== last) {
      out.push({ w, label: MONTHS[d.getMonth()] as string });
      last = key;
    }
  });
  // Drop labels that would crowd the one before (less than 3 weeks apart).
  return out.filter((l, i) => i === 0 || l.w - (out[i - 1] as { w: number }).w >= 3);
}

/** Grey skeleton heights (0..1) shown while a new range is counted: stable for a given length. */
export function skeletonHeights(n: number): number[] {
  return Array.from({ length: Math.max(1, n) }, (_, i) => 0.25 + 0.55 * Math.abs(Math.sin(i * 1.7 + 0.6)));
}

export interface Segment {
  /** Group index into the stack. */
  g: number;
  n: number;
  /** Fraction of the chart height (0..1) from the baseline. */
  y0: number;
  y1: number;
}

/** Stacked segments of one month, bottom first, against the busiest month (`scale`). */
export function segmentsOf(stack: WhenStack, months: number, m: number, scale: number): Segment[] {
  const out: Segment[] = [];
  let acc = 0;
  if (scale <= 0) return out;
  for (let g = 0; g < stack.groups.length; g++) {
    const n = stack.cells[g * months + m] ?? 0;
    if (n <= 0) continue;
    out.push({ g, n, y0: acc / scale, y1: (acc + n) / scale });
    acc += n;
  }
  return out;
}

/** The segment of a month under a pointer height fraction (0 = baseline), or null above the bar. */
export function segmentAt(segments: readonly Segment[], yFrac: number): Segment | null {
  return segments.find((s) => yFrac >= s.y0 && yFrac <= s.y1) ?? null;
}

export interface LabelChoice {
  id: DimId;
  /** Kind of field for the label text: a built-in dimension or a pack field. */
  pack?: string;
  field?: string;
}

/** The dimensions offered by "Labels over time": kind, project, source, folder, then every label-pack field loaded. */
export function labelChoices(columns: readonly { pack: string; field: string }[]): LabelChoice[] {
  const out: LabelChoice[] = [{ id: "kind" }, { id: "project" }, { id: "source" }, { id: "folder" }];
  const seen = new Set<string>();
  for (const c of columns) {
    const id = labelDim(c.pack, c.field);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, pack: c.pack, field: c.field });
  }
  return out;
}

/** A chart's colour slot (1..8) for a group by rank, or null for Other and the hollow no-value group. */
export function rankSlot(kind: "value" | "other" | "none", rank: number): number | null {
  return kind === "value" ? (rank % 8) + 1 : null;
}

// ───────────────────────────── per-section CSV (SPEC V15: Copy as CSV) ─────────────────────────────

/** One CSV field: quoted when it holds a comma, quote or line break. */
export function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvLine = (cells: readonly (string | number)[]): string => cells.map((c) => csvCell(String(c))).join(",");

const pad2 = (n: number): string => String(n).padStart(2, "0");
/** Local calendar day, "2026-11-03". */
export function isoDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/** Local calendar month, "2026-11". */
export function isoMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** A monthly stack as CSV: one row per month, one column per group (the period's months, like the chart). */
export function stackCsv(monthStarts: readonly number[], stack: WhenStack, groupName: (g: number) => string, monthHead: string): string {
  const months = monthStarts.length - 1;
  const lines = [csvLine([monthHead, ...stack.groups.map((_, g) => groupName(g))])];
  for (let m = 0; m < months; m++) lines.push(csvLine([isoMonth(monthStarts[m] as number), ...stack.groups.map((_, g) => stack.cells[g * months + m] ?? 0)]));
  return lines.join("\n");
}

/** The lanes as CSV: one row per tick (kind, day, title). */
export function lanesCsv(lanes: readonly { kind: string; ticks: readonly { t: number; title: string }[] }[], kindName: (kind: string) => string, heads: readonly [string, string, string]): string {
  const lines = [csvLine(heads)];
  for (const lane of lanes) for (const k of lane.ticks) lines.push(csvLine([kindName(lane.kind), isoDay(k.t), k.title]));
  return lines.join("\n");
}

/** The day heatmap as CSV: one row per day that has entries, oldest first. `addDays` steps a local midnight. */
export function daysCsv(days: { weekStarts: readonly number[]; counts: readonly number[] }, addDays: (ms: number, n: number) => number, heads: readonly [string, string]): string {
  const weeks = days.weekStarts.length;
  const lines = [csvLine(heads)];
  for (let w = 0; w < weeks; w++) {
    for (let r = 0; r < 7; r++) {
      const n = days.counts[r * weeks + w] ?? 0;
      if (n > 0) lines.push(csvLine([isoDay(addDays(days.weekStarts[w] as number, r)), n]));
    }
  }
  return lines.join("\n");
}

export interface TaggedShare {
  /** Whole percent of the pack's items that carry a label. */
  pct: number;
  n: number;
  total: number;
  pack: string;
  /** Other packs that tagged something. */
  more: number;
  rest: number;
}

/** How much is tagged so far: the busiest pack's labelled items against its items, plus how many other packs tag; null when none does. */
export function taggedShare(packs: readonly { pack: string; items: number; labelled: number }[]): TaggedShare | null {
  const live = packs.filter((x) => x.labelled > 0).sort((a, b) => b.labelled - a.labelled);
  const best = live[0];
  if (!best || best.items <= 0) return null;
  const n = Math.min(best.labelled, best.items);
  return { pct: Math.max(1, Math.round((n / best.items) * 100)), n, total: best.items, pack: best.pack, more: live.length - 1, rest: best.items - n };
}

/** Days of the heatmap with at least one entry. */
export function daysWithEntries(counts: readonly number[]): number {
  let n = 0;
  for (const c of counts) if (c > 0) n += 1;
  return n;
}

/** Marks drawn against marks that exist, over every lane. */
export function laneDrawn(lanes: readonly { total: number; ticks: readonly unknown[] }[]): { drawn: number; total: number } {
  let drawn = 0;
  let total = 0;
  for (const l of lanes) {
    drawn += l.ticks.length;
    total += l.total;
  }
  return { drawn, total };
}
