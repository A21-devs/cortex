/**
 * Time › "When you wrote" (SPEC V15): the series behind the page's sections, computed in one pass over the leaf's
 * visible, dated items. Every series shares ONE month axis: the leaf's period when it is set, else the dated range.
 *  - area: monthly counts stacked by area (Unsorted = items outside every area), top 8 + Other;
 *  - lanes: one tick per decision / question / plan / rejection note at its date;
 *  - days: record entries per local day as 7 weekday rows × weeks;
 *  - speakers: record entries per month by you / assistant / other (tool counts as other);
 *  - labels: the chosen dimension stacked per month, items with no value left out and counted.
 * Dates are bucketed in the local calendar, like every other stat.
 */
import { ItemFlag, NOTE_KIND_ORDER, Population, SPEAKER_ORDER, type DataIndex } from "../shared/index-format";
import type { StatsParams, VisibilityParams, WhenLaneKind, WhenStack, WhenStats } from "../shared/protocol/worker";
import {
  buildCategories,
  dayOfMonthIndex,
  dayStartMs,
  defaultVisibility,
  inPeriod,
  isVisible,
  localDay,
  monthIndexOfDay,
  NO_CODE,
  readDim,
  weekdayOfDay,
  writtenAt,
} from "./charts/common";

const SPEAKER_YOU = SPEAKER_ORDER.indexOf("you");
const SPEAKER_ASSISTANT = SPEAKER_ORDER.indexOf("assistant");
/** Values drawn as their own colour before the rest fold into Other. */
export const WHEN_TOP = 8;
/** Ticks kept per lane (an even subsample beyond this; `total` still counts all). */
export const LANE_TICK_CAP = 1500;
const LANES: readonly WhenLaneKind[] = ["decision", "question", "plan", "abandoned"];

type WhenParams = Extract<StatsParams, { kind: "when" }>;

function emptyStack(): WhenStack {
  return { groups: [], cells: [] };
}

function stackOf(index: DataIndex, items: Uint32Array, dim: WhenParams["labelDim"], keepNone: boolean, monthOf: (o: number) => number, months: number): { stack: WhenStack; dropped: number } {
  const dv = readDim(index, dim, items);
  const cats = buildCategories(index, items, dv, { sort: "count", top: WHEN_TOP, size: "entries", foldable: true, keepNone });
  const cells = new Array<number>(cats.list.length * months).fill(0);
  let dropped = 0;
  for (const o of items) {
    const g = cats.of[o]!;
    if (g === NO_CODE) {
      dropped += 1;
      continue;
    }
    const m = monthOf(o);
    if (m >= 0 && m < months) cells[g * months + m]! += 1;
  }
  return { stack: { groups: cats.list.map((c) => ({ key: c.kind === "none" ? "" : c.key, label: c.kind === "none" ? "" : c.label, kind: c.kind })), cells }, dropped };
}

export function whenStats(index: DataIndex, p: WhenParams): WhenStats {
  const vis: VisibilityParams = p.visibility ?? defaultVisibility(index.count);
  const c = index.cols;
  const dated: number[] = [];
  let undated = 0;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let o = 0; o < index.count; o++) {
    if (!isVisible(index, o, vis)) continue;
    const t = writtenAt(index, o);
    if (!Number.isFinite(t)) {
      if (c.pop[o] === Population.Record && c.flags[o]! & ItemFlag.Undated) undated += 1;
      continue;
    }
    if (!inPeriod(t, vis.period)) continue;
    dated.push(o);
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  const none = { dim: p.labelDim, ...emptyStack(), unlabelled: 0 };
  if (dated.length === 0) {
    return { kind: "when", monthStarts: [], first: Number.NaN, last: Number.NaN, area: emptyStack(), labels: none, lanes: LANES.map((kind) => ({ kind, total: 0, ticks: [] })), days: { weekStarts: [], counts: [], max: 0 }, speakers: { you: [], assistant: [], other: [] }, undated };
  }
  const items = Uint32Array.from(dated);
  const m0 = monthIndexOfDay(localDay(lo));
  const m1 = monthIndexOfDay(localDay(hi));
  const months = m1 - m0 + 1;
  const monthStarts = Array.from({ length: months + 1 }, (_, i) => dayStartMs(dayOfMonthIndex(m0 + i)));
  const monthOf = (o: number): number => monthIndexOfDay(localDay(c.t[o]!)) - m0;

  const area = stackOf(index, items, "space", true, monthOf, months).stack;
  const lab = stackOf(index, items, p.labelDim, false, monthOf, months);
  const labels = { dim: p.labelDim, ...lab.stack, unlabelled: lab.dropped };

  // Lanes.
  const laneTicks = new Map<WhenLaneKind, { t: number; ordinal: number }[]>(LANES.map((k) => [k, []]));
  for (const o of items) {
    if (c.pop[o] !== Population.Note) continue;
    const k = NOTE_KIND_ORDER[c.noteKind[o]!] as WhenLaneKind | undefined;
    if (k === undefined) continue;
    laneTicks.get(k)?.push({ t: c.t[o]!, ordinal: o });
  }
  const lanes = LANES.map((kind) => {
    const all = laneTicks.get(kind) ?? [];
    all.sort((a, b) => a.t - b.t || a.ordinal - b.ordinal);
    const step = all.length > LANE_TICK_CAP ? all.length / LANE_TICK_CAP : 1;
    const ticks: { t: number; ordinal: number; title: string }[] = [];
    for (let i = 0; i < all.length; i += step) {
      const x = all[Math.floor(i)]!;
      ticks.push({ t: x.t, ordinal: x.ordinal, title: index.titles.get(x.ordinal) });
    }
    return { kind, total: all.length, ticks };
  });

  // Day heatmap and speakers (record entries).
  const you = new Array<number>(months).fill(0);
  const assistant = new Array<number>(months).fill(0);
  const other = new Array<number>(months).fill(0);
  const weekOffset = p.weekStart === 0 ? 1 : 0;
  const rowOfDay = (day: number): number => (weekdayOfDay(day) + weekOffset) % 7;
  let d0 = Number.POSITIVE_INFINITY;
  let d1 = Number.NEGATIVE_INFINITY;
  for (const o of items) {
    if (c.pop[o] !== Population.Record) continue;
    const day = localDay(c.t[o]!);
    d0 = Math.min(d0, day);
    d1 = Math.max(d1, day);
  }
  const firstWeekDay = Number.isFinite(d0) ? d0 - rowOfDay(d0) : 0;
  const weeks = Number.isFinite(d0) ? Math.floor((d1 - firstWeekDay) / 7) + 1 : 0;
  const counts = new Array<number>(7 * weeks).fill(0);
  let max = 0;
  for (const o of items) {
    if (c.pop[o] !== Population.Record) continue;
    const day = localDay(c.t[o]!);
    const w = Math.floor((day - firstWeekDay) / 7);
    const i = rowOfDay(day) * weeks + w;
    counts[i]! += 1;
    if (counts[i]! > max) max = counts[i]!;
    const m = monthOf(o);
    const sp = c.speaker[o]!;
    if (sp === SPEAKER_YOU) you[m]! += 1;
    else if (sp === SPEAKER_ASSISTANT) assistant[m]! += 1;
    else other[m]! += 1;
  }
  const weekStarts = Array.from({ length: weeks }, (_, w) => dayStartMs(firstWeekDay + w * 7));
  return { kind: "when", monthStarts, first: lo, last: hi, area, labels, lanes, days: { weekStarts, counts, max }, speakers: { you, assistant, other }, undated };
}
