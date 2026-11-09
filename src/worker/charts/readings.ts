/**
 * Computed readings drawn ON charts as annotations (ORIG-07). Owner: E9.
 *
 * At most three per chart. A reading is a copy key (ui/copy.ts `readings.*`) plus values and an anchor: a
 * callout ("21:00 · peak"), a bracket ("23 days" with `to`), or a label on a mark ("1,284"). Never a canned
 * question or an answer sentence; the user asks their own questions with "Ask about this chart".
 *
 * Values the UI understands besides the copy placeholders:
 *  - `ref`: JSON ChartRef of what the reading is about (the Chart page's Trace button turns it into tokens);
 *  - `cat`: JSON [dimension, value] when a placeholder names a category, so the UI can show its display name
 *    (value labels, remainders) instead of the worker's fallback text.
 */
import type { DimId } from "../../shared/dims";
import type { ChartReading, Vec3 } from "../../shared/protocol/worker";
import { civilFromDays, daysFromCivil, refKey, type ChartRef } from "./common";

/** Copy keys of `readings.*` in ui/copy.ts. */
export type ReadingCopyKey = "readings.peak" | "readings.run" | "readings.widest" | "readings.largest" | "readings.share" | "readings.ratio" | "readings.levels";

const countFmt = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const ratioFmt = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** "1,284" (en-GB grouping, like the rest of the copy). */
export function fmtCount(n: number): string {
  return countFmt.format(Math.round(n));
}

/** Share 0..1 → "23%" (never "0%" for a non-zero share: "<1%"). */
export function fmtShare(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "0%";
  const v = Math.round(p * 100);
  return v === 0 ? "<1%" : `${v}%`;
}

/** Whole percent 0..100 for `readings.share` ("peak {p}%"). */
export function percent(p: number): number {
  return Number.isFinite(p) ? Math.round(Math.max(0, Math.min(1, p)) * 100) : 0;
}

/** "2.4" for ×-ratios. */
export function fmtRatio(r: number): string {
  return ratioFmt.format(r);
}

export interface ReadingInput {
  kind: ChartReading["kind"];
  copyKey: ReadingCopyKey;
  values: Record<string, string | number>;
  at: Vec3;
  to?: Vec3;
  ref?: ChartRef;
  cat?: [DimId, string];
}

export function makeReading(r: ReadingInput): ChartReading {
  const values: Record<string, string | number> = { ...r.values };
  if (r.ref) values.ref = refKey(r.ref);
  if (r.cat) values.cat = JSON.stringify(r.cat);
  const out: ChartReading = { kind: r.kind, copyKey: r.copyKey, values, at: r.at };
  if (r.to) out.to = r.to;
  return out;
}

/** Longest run of consecutive active days (calendar bracket). Days are local "YYYY-MM-DD" keys, sorted. */
export function longestStreak(days: readonly string[]): { length: number; end?: string } {
  const nums = days.map((d) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    return m ? daysFromCivil(Number(m[1]), Number(m[2]), Number(m[3])) : Number.NaN;
  });
  const run = longestRun(nums);
  if (run.length === 0) return { length: 0 };
  const [y, m, d] = civilFromDays(run.end);
  return { length: run.length, end: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}

/**
 * Longest run of consecutive day numbers in an ascending list (duplicates allowed, NaN skipped). The earliest
 * run wins a tie. Returns length 0 for an empty list.
 */
export function longestRun(days: ArrayLike<number>): { length: number; start: number; end: number } {
  let best = { length: 0, start: Number.NaN, end: Number.NaN };
  let start = Number.NaN;
  let prev = Number.NaN;
  let len = 0;
  for (let i = 0; i < days.length; i++) {
    const d = days[i]!;
    if (!Number.isFinite(d)) continue;
    if (Number.isFinite(prev) && d === prev) continue;
    if (Number.isFinite(prev) && d === prev + 1) len += 1;
    else {
      len = 1;
      start = d;
    }
    if (len > best.length) best = { length: len, start, end: d };
    prev = d;
  }
  return best;
}

/** Index of the peak bin (radial clock callout); -1 when all are zero. The first maximum wins. */
export function peakIndex(counts: ArrayLike<number>): number {
  let best = -1;
  let max = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i] ?? 0;
    if (c > max) {
      max = c;
      best = i;
    }
  }
  return best;
}

/** Index of the largest value and the second largest (−1 when absent). */
export function topTwo(values: ArrayLike<number>): [number, number] {
  let a = -1;
  let b = -1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!(v > 0)) continue;
    if (a < 0 || v > values[a]!) {
      b = a;
      a = i;
    } else if (b < 0 || v > values[b]!) b = i;
  }
  return [a, b];
}
