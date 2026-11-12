/**
 * Lifelines, Show = Curve (CHART-C04). A survival-style plot: across, how long a life lasted; up, the share of lives
 * that lasted at least that long (100% at the left edge, 0% at the bottom). One curve per series, the particles sit on
 * the curves at the age they were written.
 *
 * A "life" is a thread of entries: all the entries of one series that share a project, or (when an entry has no project)
 * a conversation. Its length is the time from its first to its last entry in the chart's window; a thread of one entry
 * lasted no time at all, so a chart of mostly one-off ideas drops away from 100% at once.
 */
import { NONE32 } from "../../shared/index-format";
import { labelPitch, labelWidth } from "../../shared/chartStage";
import {
  axisLabel,
  ChartBuilder,
  flatCamera,
  NO_CODE,
  plotRect,
  rnd,
  THIN_GROUP,
  type CategorySet,
  type ChartRef,
  type Prepared,
} from "./common";
import type { ArrangementResult, Vec3 } from "../../shared/protocol/worker";

const DAY_MS = 86_400_000;
/** Samples a curve is drawn through, and marks it is split into for hovering. */
const CURVE_SAMPLES = 72;
const CURVE_MARKS = 24;
/** Days in a month and in a year, for the lifespan ticks. */
const MONTH_DAYS = 30.44;
const YEAR_DAYS = 365.25;

export type LifeUnit = "days" | "months" | "years";

export interface LifeTick {
  /** Where the tick stands, in days. */
  days: number;
  /** The number the label shows. */
  n: number;
  unit: LifeUnit;
}

/** Candidate tick steps, smallest first: [step in its unit, unit]. */
const TICK_STEPS: readonly [number, LifeUnit][] = [
  [1, "days"],
  [2, "days"],
  [5, "days"],
  [10, "days"],
  [15, "days"],
  [1, "months"],
  [2, "months"],
  [3, "months"],
  [6, "months"],
  [1, "years"],
  [2, "years"],
  [5, "years"],
  [10, "years"],
  [20, "years"],
  [50, "years"],
];

const UNIT_DAYS: Readonly<Record<LifeUnit, number>> = { days: 1, months: MONTH_DAYS, years: YEAR_DAYS };

/** Ticks along a lifespan axis that runs `maxDays` long: the finest round step that gives at most `most` ticks (day, month or year steps). */
export function lifespanTicks(maxDays: number, most = 8): LifeTick[] {
  const max = Math.max(1, maxDays);
  let pick = TICK_STEPS[TICK_STEPS.length - 1]!;
  for (const step of TICK_STEPS) {
    if (max / (step[0] * UNIT_DAYS[step[1]]) <= most) {
      pick = step;
      break;
    }
  }
  const [step, unit] = pick;
  const out: LifeTick[] = [];
  for (let k = 0; k * step * UNIT_DAYS[unit] <= max + 1e-9; k++) out.push({ days: k * step * UNIT_DAYS[unit], n: k * step, unit });
  return out;
}

/** Share (0..1) of the lives, given ascending, that lasted at least `at` days. */
export function survivalShare(sorted: readonly number[], at: number): number {
  if (sorted.length === 0) return 0;
  // First index whose life is >= at.
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! >= at) hi = mid;
    else lo = mid + 1;
  }
  return (sorted.length - lo) / sorted.length;
}

/**
 * Label heights nudged apart: `want` are the heights the labels would like, the result keeps their order and puts at
 * least `pitch` between neighbours, pushing down from the top and then back up from `floor`.
 */
export function spreadLabels(want: readonly number[], pitch: number, floor: number): number[] {
  const order = want.map((_, i) => i).sort((a, b) => want[b]! - want[a]! || a - b);
  const out = new Array<number>(want.length).fill(0);
  let prev = Number.POSITIVE_INFINITY;
  for (const i of order) {
    out[i] = Math.min(want[i]!, prev - pitch);
    prev = out[i]!;
  }
  let below = floor;
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k]!;
    if (out[i]! < below) out[i] = below;
    below = out[i]! + pitch;
  }
  return out;
}

interface Life {
  first: number;
  last: number;
  /** The entries of this thread that the chart placed. */
  items: number[];
}

/** The lives of every series: threads keyed by series and project (or conversation). */
function livesOf(p: Prepared, cats: CategorySet, timeOf: (o: number) => number): Map<string, Life & { l: number }> {
  const out = new Map<string, Life & { l: number }>();
  const { project, conv } = p.index.cols;
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const l = cats.of[o]!;
    const t = timeOf(o);
    if (l === NO_CODE || !Number.isFinite(t)) continue;
    const thread = project[o] !== NONE32 ? `p${project[o]}` : conv[o] !== NONE32 ? `c${conv[o]}` : "";
    if (thread === "") continue;
    const key = `${l}|${thread}`;
    const cur = out.get(key);
    if (cur) {
      cur.first = Math.min(cur.first, t);
      cur.last = Math.max(cur.last, t);
      cur.items.push(o);
    } else out.set(key, { l, first: t, last: t, items: [o] });
  }
  return out;
}

/**
 * The Curve layout. `timeOf` is the entry's time inside the chart's window (NaN outside it), `ref` the series ref of a
 * category key. Returns the arrangement, with every curve cut into hoverable slices named by series and percent.
 */
export function layoutLifeCurves(b: ChartBuilder, p: Prepared, cats: CategorySet, timeOf: (o: number) => number, ref: (key: string) => ChartRef): ArrangementResult {
  const L = cats.list.length;
  const lives = livesOf(p, cats, timeOf);
  const perSeries: { life: number; entries: number; v: Life }[][] = Array.from({ length: L }, () => []);
  let maxLife = 0;
  for (const v of lives.values()) {
    const days = (v.last - v.first) / DAY_MS;
    perSeries[v.l]!.push({ life: days, entries: v.items.length, v });
    maxLife = Math.max(maxLife, days);
  }
  if (maxLife <= 0) maxLife = 1;
  const PLOT = plotRect(p.stage);
  const bottom = PLOT.bottom + 0.15;
  const top = PLOT.top - 0.2;
  const gutter = Math.min(2.4, labelWidth(p.stage, 14) + 0.3);
  const left = PLOT.left + 0.4;
  const right = Math.max(left + 3, PLOT.right - gutter);
  const xOf = (days: number) => left + (days / maxLife) * (right - left);
  const yOf = (share: number) => bottom + share * (top - bottom);

  // Axes: 100 / 50 / 0 % and the lifespan ticks.
  for (const share of [1, 0.5, 0]) {
    const y = yOf(share);
    b.line([left, y, 0], [right, y, 0], share === 0 ? 0.32 : 0.12, share !== 0);
    b.label([left - 0.1, y, 0], String(share * 100), "axis", "right", { copy: "chart.percentTick" });
  }
  for (const tick of lifespanTicks(maxLife)) {
    const x = xOf(tick.days);
    b.line([x, bottom, 0], [x, bottom - 0.06, 0], 0.3);
    b.label([x, bottom - 0.2, 0], String(tick.n), "axis", "center", { copy: tick.unit === "days" ? "chart.lifeTickDays" : tick.unit === "months" ? "chart.lifeTickMonths" : "chart.lifeTickYears" });
  }

  const ends: { l: number; x: number; y: number }[] = [];
  for (let l = 0; l < L; l++) {
    const cat = cats.list[l]!;
    const rows = perSeries[l]!;
    if (rows.length === 0) continue;
    const sorted = rows.map((r) => r.life).sort((a, c) => a - c);
    const longest = sorted[sorted.length - 1]!;
    const pts: Vec3[] = [];
    const n = CURVE_SAMPLES;
    for (let j = 0; j <= n; j++) {
      const d = (j / n) * longest;
      pts.push([xOf(d), yOf(survivalShare(sorted, d)), 0]);
    }
    b.poly(pts, 0.6);
    // Hover slices: a slice of the curve, named by the series and the share of lives that last at least that long.
    const k = Math.max(1, Math.min(CURVE_MARKS, Math.ceil((longest / maxLife) * CURVE_MARKS)));
    const marks: number[] = [];
    for (let j = 0; j < k; j++) {
      const from = (j / k) * longest;
      const to = ((j + 1) / k) * longest;
      const share = survivalShare(sorted, from);
      const shareTo = survivalShare(sorted, to);
      const survivors = rows.filter((r) => r.life >= from);
      const entries = survivors.reduce((a, r) => a + r.entries, 0);
      const r = ref(cat.key);
      r.curve = [Math.round(share * 100), Math.round(from)];
      const lo = Math.min(share, shareTo);
      const hi = Math.max(share, shareTo);
      marks.push(b.mark(r, cat.label, Math.max(1, entries), { x0: xOf(from), y0: yOf(lo) - 0.12, x1: xOf(to), y1: yOf(hi) + 0.12 }));
    }
    // The series' entries sit on its curve at the age they were written, a little loose so a crowd reads as a smear.
    for (const { v } of rows) {
      for (const o of v.items) {
        const age = Math.max(0, Math.min(longest, (timeOf(o) - v.first) / DAY_MS));
        const x = xOf(age) + (rnd(p, o, 11) - 0.5) * 0.04;
        const y = yOf(survivalShare(sorted, age)) + (rnd(p, o, 12) - 0.5) * 0.06;
        const m = marks[Math.min(marks.length - 1, Math.floor((age / Math.max(1e-9, longest)) * marks.length))]!;
        b.flat(o, x, Math.max(bottom, Math.min(top + 0.05, y)), m);
      }
    }
    if (cat.count < THIN_GROUP) b.thin(cat.key, cat.count);
    ends.push({ l, x: xOf(longest), y: pts[pts.length - 1]![1] });
  }
  // Each curve is named at its right-hand end; names that would touch are moved apart.
  const heights = spreadLabels(ends.map((e) => e.y), labelPitch(p.stage), bottom);
  ends.forEach((e, i) => b.label([e.x + 0.12, heights[i]!, 0], axisLabel(cats.list[e.l]!.label), "axis", "left", ref(cats.list[e.l]!.key)));
  return b.finish(flatCamera());
}
