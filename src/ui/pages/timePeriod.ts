/**
 * Time page period controls (chips, busy-year stepper, brush): the pure arithmetic. The period is the leaf's
 * `ui.period` ([from, to] in epoch ms, inclusive), shared with the strip's brush; null means all time.
 */
import type { TimeBin } from "../../shared/protocol/worker";

export type PeriodPreset = "from" | "all" | "years5" | "year1" | "months6" | "days30";

export const PRESETS: readonly PeriodPreset[] = ["from", "all", "years5", "year1", "months6", "days30"];

/** Default number of entries a year needs before "From" starts at it. */
export const DEFAULT_BUSY = 50;
export const MAX_BUSY = 100000;

const DAY_MS = 86_400_000;

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The last millisecond of the local day holding `ms`. */
export function endOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** The busy-year threshold from a page param: a whole number from 1 up, else the default. */
export function busyParam(raw: string | undefined): number {
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) && n >= 1 ? Math.min(MAX_BUSY, n) : DEFAULT_BUSY;
}

/** One click of the stepper: 1 up to 10, then in tens, and always at least 1. */
export function stepBusy(n: number, dir: 1 | -1): number {
  const step = n >= 100 ? 50 : n >= 10 && !(n === 10 && dir === -1) ? 10 : 1;
  return Math.max(1, Math.min(MAX_BUSY, n + dir * step));
}

/** The first calendar year (local time) holding at least `min` entries, else the first year that has any; null with none. */
export function firstBusyYear(bins: readonly Pick<TimeBin, "start" | "entries">[], min: number): number | null {
  const byYear = new Map<number, number>();
  for (const b of bins) {
    if (b.entries <= 0) continue;
    const y = new Date(b.start).getFullYear();
    byYear.set(y, (byYear.get(y) ?? 0) + b.entries);
  }
  if (byYear.size === 0) return null;
  const years = [...byYear.keys()].sort((a, b) => a - b);
  return years.find((y) => (byYear.get(y) ?? 0) >= min) ?? (years[0] as number);
}

export interface PeriodSpan {
  first: number;
  last: number;
}

/** The period a chip stands for, or null for all time. Windows end on the newest dated entry's day. */
export function presetPeriod(preset: PeriodPreset, span: PeriodSpan, fromYear: number | null): [number, number] | null {
  const end = endOfDay(span.last);
  const back = (f: (d: Date) => void): [number, number] => {
    const d = new Date(end);
    f(d);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    return [Math.max(startOfDay(span.first), d.getTime()), end];
  };
  switch (preset) {
    case "all":
      return null;
    case "from":
      return fromYear === null ? null : [new Date(fromYear, 0, 1).getTime(), end];
    case "years5":
      return back((d) => d.setFullYear(d.getFullYear() - 5));
    case "year1":
      return back((d) => d.setFullYear(d.getFullYear() - 1));
    case "months6":
      return back((d) => d.setMonth(d.getMonth() - 6));
    case "days30":
      return back((d) => d.setDate(d.getDate() - 30));
  }
}

/** Whether a period is exactly the window of one chip (within a day). */
export function matchesPreset(period: readonly [number, number] | null, preset: PeriodPreset, span: PeriodSpan, fromYear: number | null): boolean {
  const w = presetPeriod(preset, span, fromYear);
  if (period === null || w === null) return period === null && w === null;
  return Math.abs(w[0] - period[0]) < DAY_MS && Math.abs(w[1] - period[1]) < DAY_MS;
}

/** The chip a period matches (within a day), or null when it matches none. With "From" and "All" alike, the earlier chip wins. */
export function activePreset(period: readonly [number, number] | null, span: PeriodSpan, fromYear: number | null, chosen: PeriodPreset | null = null): PeriodPreset | null {
  if (period === null) return "all";
  // Short data makes windows equal (6 months and 5 years can both be the whole record): the chip you pressed stays marked.
  if (chosen && chosen !== "all" && matchesPreset(period, chosen, span, fromYear)) return chosen;
  for (const p of PRESETS) if (p !== "all" && matchesPreset(period, p, span, fromYear)) return p;
  return null;
}

/** A window that covers the whole span is the same as no period: it clears the period instead. */
export function normalisePeriod(w: readonly [number, number], span: PeriodSpan): [number, number] | null {
  const lo = startOfDay(span.first);
  const hi = endOfDay(span.last);
  const a = Math.max(w[0], lo);
  const b = Math.min(w[1], hi);
  return a <= lo && b >= hi - 1 ? null : [a, b];
}

/** Which handle moves: "a" the start, "b" the end, "w" the whole window (keeping its length). */
export type BrushHandle = "a" | "b" | "w";

/** The window after a drag: handles never cross, a move keeps the length, and nothing leaves [lo, hi]. */
export function dragWindow(start: readonly [number, number], handle: BrushHandle, delta: number, lo: number, hi: number): [number, number] {
  if (handle === "w") {
    const len = start[1] - start[0];
    const a = Math.min(Math.max(start[0] + delta, lo), Math.max(lo, hi - len));
    return [a, a + len];
  }
  if (handle === "a") return [Math.min(Math.max(start[0] + delta, lo), start[1]), start[1]];
  return [start[0], Math.max(Math.min(start[1] + delta, hi), start[0])];
}

/** The brush's window as fractions (0..1) of the span; null period means the whole span. */
export function windowFractions(period: readonly [number, number] | null, lo: number, hi: number): [number, number] {
  const len = Math.max(1, hi - lo);
  if (!period) return [0, 1];
  return [Math.max(0, Math.min(1, (period[0] - lo) / len)), Math.max(0, Math.min(1, (period[1] - lo) / len))];
}

/** Bars for the brush: entries per bin folded into `n` equal slices of [lo, hi], scaled to 0..1 by the tallest. */
export function brushBars(bins: readonly Pick<TimeBin, "start" | "end" | "entries">[], lo: number, hi: number, n: number): number[] {
  const out = new Array<number>(Math.max(1, n)).fill(0);
  const len = Math.max(1, hi - lo);
  for (const b of bins) {
    if (b.entries <= 0) continue;
    const mid = (b.start + b.end) / 2;
    const i = Math.min(out.length - 1, Math.max(0, Math.floor(((mid - lo) / len) * out.length)));
    out[i] = (out[i] as number) + b.entries;
  }
  const top = Math.max(...out);
  return top > 0 ? out.map((v) => v / top) : out;
}
