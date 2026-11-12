/**
 * Over-time charts (CORTEX-UX §7.2). Owner: E9. The time axis is the period, or (All time) the chart's initial
 * range from `autoWindow`; bins are days (≤ 120 days), ISO weeks or months unless the x zone names a grain.
 *  stream           — centred streamgraph, wiggle-minimising baseline (Byron & Wattenberg) with inside-out order;
 *                     bands filled with their particles at their own dates; band names at the right; a "now" mark;
 *                     reading: the leading band named at each end of the time axis;
 *  bands            — a band per series value, each a row of short dotted segments (one per week or month, Segments) as
 *                     tall as the entries they hold, on one scale; the name at the band's left end; reading: the fullest segment;
 *  ridgeline        — one overlapping area per category from a shared baseline, particles under each curve;
 *                     options Normalise rows, Scale (Linear · Square root · Log), Smoothing (None · Moving average · Exponential
 *                     average) with a Window of 7, 30 or 90 days; a dot on each
 *                     row's peak with its month, the latest brighter; reading: the latest peak;
 *  calendar-heatmap — a block per year, 53/54 week columns × 7 days, a particle clump per day sized by count;
 *                     counts appear in cells ≥ 18 px (semantic zoom); readings: a bracket over the longest run with
 *                     its length, a callout on the busiest day;
 *  timeline-lanes   — a lane per category from its first to its last entry, particle blocks per month (Monthly
 *                     density, on by default); open arrow = still active, closed cap = ended; reading: a bracket on
 *                     the longest lane;
 *  arc-diagram      — bursts per lane on a baseline joined by half-ellipse arcs, height ∝ gap (Minimum gap);
 *                     reading: the tallest arc with its gap (P2). Timeline lanes and the Arc diagram take Show rows (Longest,
 *                     Recent, Most) and name a row that came back "name - back after N months";
 *  diverging-area   — your share above a zero line, the assistant's below (Measure: Words · Messages), smoothed,
 *                     a dashed line at your overall share; reading: "peak 46%" at the month your share peaked;
 *  beeswarm         — each conversation a packed cluster on the time axis, size ∝ messages or words; reading:
 *                     the largest cluster's message count (P2).
 */
import { isDateDim, parseDateDim, type DimId } from "../../shared/dims";
import { bandSegments, lanesShow, monthsOfDays, rowsOrder, rowsShow, waveScale, waveSmoothing, waveWindowDays, type WaveScale, type WaveSmoothing } from "../../shared/chartOptions";
import { balanceDim, balanceSides } from "../../shared/balance";
import { NONE32, Population, SPEAKER_ORDER } from "../../shared/index-format";
import { scaleSeries, smoothSeries, windowBins } from "./smoothing";
import { DEFAULT_SERIES } from "../../shared/chartAxes";
import { COLUMN_LABEL_CHARS, labelPitch, labelScale, labelWidth, type ChartStage } from "../../shared/chartStage";
import type { ArrangementResult, AxisSpec, ChartSpec, TimeWindow, Vec3 } from "../../shared/protocol/worker";
import {
  axisCategories,
  axisLabel,
  axisTime,
  bucketise,
  ChartBuilder,
  chartWindow,
  clamp,
  clearLabels,
  DAY_MS,
  dayLabel,
  dayStartMs,
  dimOf,
  emptyChart,
  fillDisc,
  FLAT_Z,
  FRAME,
  fillRect,
  flatCamera,
  localDay,
  makeBins,
  monthName,
  NO_CODE,
  pickGrain,
  plotRect,
  prepareChart,
  rowLabelSlots,
  rnd,
  sampleSeries,
  THIN_GROUP,
  timeTicks,
  weekdayName,
  weekdayOfDay,
  civilFromDays,
  daysFromCivil,
  type Bins,
  type CategorySet,
  type ChartContext,
  type ChartRef,
  type Prepared,
  type Rect2,
} from "./common";
import { fmtCount, longestRun, makeReading, peakIndex, percent } from "./readings";
import { layoutLifeCurves } from "./lifeCurve";

// ───────────────────────────── shared time setup ─────────────────────────────

interface TimeSetup {
  basis: "written" | "imported";
  window: TimeWindow;
  bins: Bins;
  /** Series (bands, rows, lanes) dimension and the zone it came from. */
  series: DimId | null;
  zone: "x" | "y";
  sort: AxisSpec["sort"];
  left: number;
  right: number;
  xOf(t: number): number;
}

/** Series of a time chart: the vertical zone (or colour) when x is a date; otherwise x itself. */
function seriesOf(s: ChartSpec, fallback: DimId | null): { dim: DimId | null; zone: "x" | "y"; sort: AxisSpec["sort"] } {
  if (!isDateDim(s.x.dim)) return { dim: s.x.dim, zone: "x", sort: s.x.sort };
  if (s.y && !isDateDim(s.y.dim)) return { dim: s.y.dim, zone: "y", sort: s.y.sort };
  if (s.colour && !isDateDim(s.colour)) return { dim: s.colour, zone: "y", sort: "count" };
  return { dim: fallback, zone: "y", sort: "count" };
}

function seriesAxes(fallback: DimId | null) {
  return (s: ChartSpec): DimId[] => {
    const d = seriesOf(s, fallback).dim;
    return d ? [d] : [];
  };
}

function timeSetup(p: Prepared, fallback: DimId | null, leftAt?: number, rightAt?: number, grainAt?: "week" | "month"): TimeSetup {
  const PLOT = plotRect(p.stage);
  const left = leftAt ?? PLOT.left;
  const right = rightAt ?? PLOT.right - 0.9;
  const date = parseDateDim(p.spec.x.dim);
  const basis = date?.basis ?? "written";
  const window = chartWindow(p, basis);
  const grain = pickGrain(window[0], window[1], grainAt ?? date?.grain ?? null);
  const bins = makeBins(window[0], window[1], grain);
  const t0 = bins.edges[0]!;
  const t1 = bins.edges[bins.count]!;
  const s = seriesOf(p.spec, fallback);
  return {
    basis,
    window,
    bins,
    series: s.dim,
    zone: s.zone,
    sort: s.sort,
    left,
    right,
    xOf: (t: number) => left + ((t - t0) / Math.max(1, t1 - t0)) * (right - left),
  };
}

/** Fractional bin position of t (bin centres at i + 0.5). */
function binPos(ts: TimeSetup, t: number, b: number): number {
  const a = ts.bins.edges[b]!;
  const z = ts.bins.edges[b + 1]!;
  return b + (t - a) / Math.max(1, z - a);
}

function binCentreX(ts: TimeSetup, b: number): number {
  return ts.xOf((ts.bins.edges[b]! + ts.bins.edges[b + 1]!) / 2);
}

/** Bin per member on the chart's time axis (-1 when undated or outside the window). */
function binsOfMembers(p: Prepared, ts: TimeSetup): Int32Array {
  const out = new Int32Array(p.index.count).fill(-1);
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const t = axisTime(p, o, ts.basis);
    if (Number.isFinite(t) && t >= ts.window[0] && t <= ts.window[1]) out[o] = ts.bins.of(t);
  }
  return out;
}

/** World width of one character of an axis label (10.5 px mono at about 100 px per unit). */
const TICK_CHAR = 0.07;
/** Rotation of date labels that do not fit their slot, and the rows they stagger across. */
export const TICK_ROTATE = -38;
export const TICK_ROWS = 3;

/**
 * How the labels of a time axis are set. Labels that fit their slot stay level (two rows when more than 12 crowd the
 * axis). Labels longer than the slot rotate to -38 degrees and stagger across up to three rows (row = index mod rows),
 * as many as it takes for neighbours not to meet.
 */
export function tickLayout(labels: readonly string[], span: number, stage?: ChartStage): { rotate: number; rows: number } {
  const n = labels.length;
  if (n === 0) return { rotate: 0, rows: 1 };
  const slot = span / Math.max(1, n);
  let longest = 0;
  for (const l of labels) longest = Math.max(longest, l.length);
  // Text is a fixed number of pixels: a stage that gives a world unit fewer pixels makes a label wider in world units.
  const width = longest * TICK_CHAR * labelScale(stage);
  if (width <= slot * 0.95) return { rotate: 0, rows: n > 12 ? 2 : 1 };
  const flat = width * Math.cos((-TICK_ROTATE * Math.PI) / 180);
  return { rotate: TICK_ROTATE, rows: Math.max(1, Math.min(TICK_ROWS, Math.ceil(flat / slot))) };
}

function timeAxis(b: ChartBuilder, ts: TimeSetup, y: number, top: number, z = 0): void {
  b.line([ts.left, y, z], [ts.right, y, z], 0.32);
  const t0 = ts.bins.edges[0]!;
  const t1 = ts.bins.edges[ts.bins.count]!;
  const ticks = timeTicks(t0, t1);
  const stage = b.p.stage;
  const layout = tickLayout(ticks.map((tk) => tk.label), ts.right - ts.left, stage);
  // The rows of a staggered axis stand a text height apart: a fixed number of pixels, so more world units on a small stage.
  const k = labelScale(stage);
  ticks.forEach((tk, i) => {
    const x = ts.xOf(tk.t);
    if (tk.major) b.line([x, y, z], [x, top, z], 0.12, true);
    else b.line([x, y, z], [x, y - 0.06, z], 0.3);
    const row = i % layout.rows;
    if (layout.rotate !== 0) b.label([x, y - 0.18 - row * 0.2 * k, z], tk.label, "axis", "right", undefined, layout.rotate);
    else b.label([x, y - 0.2 - (layout.rows > 1 && row === 1 ? 0.2 * k : 0), z], tk.label, "axis", "center");
  });
}

function nowMark(b: ChartBuilder, ts: TimeSetup, bottom: number, top: number, now: number): void {
  const t0 = ts.bins.edges[0]!;
  const t1 = ts.bins.edges[ts.bins.count]!;
  if (now < t0 || now > t1) return;
  const x = ts.xOf(now);
  b.line([x, bottom, 0], [x, top, 0], 0.5, true);
  b.label([x, top + 0.16, 0], "", "muted", "center", { copy: "strip.today" });
}

function seriesCategories(p: Prepared, ts: TimeSetup, extra: { cap?: number } = {}): CategorySet | null {
  if (!ts.series) return null;
  return axisCategories(p, ts.series, ts.sort, ts.zone === "x", extra);
}

function seriesRef(ts: TimeSetup, key: string, t?: [number, number]): ChartRef {
  if (!ts.series) return t ? { t } : {};
  const pair: [DimId, string] = [ts.series, key];
  const ref: ChartRef = ts.zone === "x" ? { x: pair } : { y: pair };
  if (t) ref.t = t;
  return ref;
}

/** A returning row has been away at least this long before it came back. */
const BACK_MIN_DAYS = 30;
/** Rows that say "back after N months" need a wider gutter for their names (world units added at the left). */
export const BACK_GUTTER = 1.4;

/** What the Show rows choice and the "back after" labels need to know about one row of a time chart. */
interface RowStat {
  first: number;
  last: number;
  count: number;
  /** The longest stretch between two entries of the row (ms; 0 with fewer than two). */
  gap: number;
}

function rowStats(p: Prepared, ts: TimeSetup, cats: CategorySet): RowStat[] {
  const L = cats.list.length;
  const times: number[][] = Array.from({ length: L }, () => []);
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const l = cats.of[o]!;
    const t = axisTime(p, o, ts.basis);
    if (l === NO_CODE || l >= L || !Number.isFinite(t) || t < ts.window[0] || t > ts.window[1]) continue;
    times[l]!.push(t);
  }
  return times.map((list) => {
    list.sort((a, c) => a - c);
    let gap = 0;
    for (let k = 1; k < list.length; k++) gap = Math.max(gap, list[k]! - list[k - 1]!);
    return { first: list[0] ?? Number.NaN, last: list[list.length - 1] ?? Number.NaN, count: list.length, gap };
  });
}

/** Months a row was away before it came back, or undefined when it never left for as long as a month. */
export function backMonths(gapMs: number): number | undefined {
  const days = gapMs / DAY_MS;
  return days >= BACK_MIN_DAYS ? monthsOfDays(days) : undefined;
}

/**
 * The rows of a lane or arc chart in the order of its Show rows choice (Longest, Recent, Most); untouched, they keep
 * the order of their axis. `longest` says what Longest means for the chart: the lane's span or the row's longest gap.
 */
function showRows(p: Prepared, ts: TimeSetup, cats: CategorySet | null, longest: "span" | "gap"): CategorySet | null {
  const show = rowsShow(p.spec.options);
  if (!cats || !show || cats.list.length < 2) return cats;
  const st = rowStats(p, ts, cats);
  const order = rowsOrder(
    show,
    st.map((r) => ({ longest: longest === "span" ? (Number.isFinite(r.first) ? r.last - r.first : -1) : r.gap, newest: Number.isFinite(r.last) ? r.last : -1, count: r.count })),
  );
  const at = new Uint32Array(order.length);
  order.forEach((old, pos) => (at[old] = pos));
  const of = new Uint32Array(cats.of.length);
  for (let i = 0; i < of.length; i++) {
    const c = cats.of[i]!;
    of[i] = c === NO_CODE || c >= at.length ? c : at[c]!;
  }
  return { ...cats, list: order.map((i) => cats.list[i]!), of };
}

/** A row's label ref; a returning row's carries the months it was away (not in the second column, which has no room for it). */
function rowRef(ts: TimeSetup, key: string, back: number | undefined, short: boolean): ChartRef {
  const ref = seriesRef(ts, key);
  if (back !== undefined && !short) ref.back = back;
  return ref;
}

// ───────────────────────────── stream graph ─────────────────────────────

/** Inside-out order: the largest series in the middle, the rest alternating outward by total. */
function insideOut(totals: readonly number[]): number[] {
  const idx = totals.map((_, i) => i).sort((a, c) => totals[c]! - totals[a]! || a - c);
  const topList: number[] = [];
  const bottomList: number[] = [];
  let top = 0;
  let bottom = 0;
  for (const i of idx) {
    if (top <= bottom) {
      topList.push(i);
      top += totals[i]!;
    } else {
      bottomList.push(i);
      bottom += totals[i]!;
    }
  }
  return [...bottomList.reverse(), ...topList];
}

/** Wiggle-minimising baseline for stacked series (values[s][b]) in the given order. */
export function wiggleBaseline(values: readonly Float64Array[], order: readonly number[], bins: number): Float64Array {
  const g = new Float64Array(bins);
  let y = 0;
  for (let j = 1; j < bins; j++) {
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < order.length; i++) {
      const si = values[order[i]!]!;
      const d = si[j]! - si[j - 1]!;
      let s3 = d / 2;
      for (let k = 0; k < i; k++) {
        const sk = values[order[k]!]!;
        s3 += sk[j]! - sk[j - 1]!;
      }
      s1 += si[j]!;
      s2 += s3 * si[j]!;
    }
    if (s1 > 0) y -= s2 / s1;
    g[j] = y;
  }
  return g;
}

export function layoutStream(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, seriesAxes(DEFAULT_SERIES.stream!));
  const PLOT = plotRect(p.stage);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  const ts = timeSetup(p, DEFAULT_SERIES.stream!);
  const cats = seriesCategories(p, ts);
  const S = cats ? cats.list.length : 1;
  const B = ts.bins.count;
  if (cats) b.categories = cats.all;
  const binOf = binsOfMembers(p, ts);
  const raw = Array.from({ length: S }, () => new Float64Array(B));
  const words = p.index.cols.words;
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const bi = binOf[o]!;
    const s = cats ? cats.of[o]! : 0;
    if (bi < 0 || s === NO_CODE) continue;
    raw[s]![bi]! += p.spec.size === "words" ? words[o]! : 1;
  }
  // Light [1 2 1] smoothing for the geometry only (readings use the raw counts).
  const sm = raw.map((r) => {
    const out = new Float64Array(B);
    for (let j = 0; j < B; j++) out[j] = (2 * r[j]! + (j > 0 ? r[j - 1]! : r[j]!) + (j < B - 1 ? r[j + 1]! : r[j]!)) / 4;
    return out;
  });
  const order = insideOut(sm.map((r) => r.reduce((a, v) => a + v, 0)));
  const base = wiggleBaseline(sm, order, B);
  const lower = Array.from({ length: S }, () => new Float64Array(B));
  const upper = Array.from({ length: S }, () => new Float64Array(B));
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < B; j++) {
    let y = base[j]!;
    for (const s of order) {
      lower[s]![j] = y;
      y += sm[s]![j]!;
      upper[s]![j] = y;
    }
    lo = Math.min(lo, base[j]!);
    hi = Math.max(hi, y);
  }
  const bottom = PLOT.bottom + 0.15;
  const top = PLOT.top - 0.2;
  const span = hi - lo || 1;
  const scale = (top - bottom) / span;
  const mid = (top + bottom) / 2 - ((hi + lo) / 2) * scale;
  const Y = (v: number) => mid + v * scale;
  // Particles at their own dates, spread across their band.
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const bi = binOf[o]!;
    const s = cats ? cats.of[o]! : 0;
    if (bi < 0 || s === NO_CODE) continue;
    const t = axisTime(p, o, ts.basis);
    const pos = binPos(ts, t, bi);
    const l = sampleSeries(lower[s]!, pos);
    const u = sampleSeries(upper[s]!, pos);
    b.flat(o, ts.xOf(t), Y(l + (0.08 + 0.84 * rnd(p, o, 11)) * (u - l)));
  }
  // Marks: one per band × bin cell (the chart's counts table).
  let marks = 0;
  for (let s = 0; s < S; s++) {
    const cat = cats?.list[s];
    for (let j = 0; j < B && marks < 8000; j++) {
      const c = raw[s]![j]!;
      if (c <= 0) continue;
      const x0 = ts.xOf(ts.bins.edges[j]!);
      const x1 = ts.xOf(ts.bins.edges[j + 1]!);
      b.mark(seriesRef(ts, cat?.key ?? "", [ts.bins.edges[j]!, ts.bins.edges[j + 1]!]), cat?.label ?? ts.bins.label(j), c, { x0, y0: Y(lower[s]![j]!), x1, y1: Y(upper[s]![j]!) });
      marks += 1;
    }
  }
  // Band edges and names at the right, each name where its band ends; names that would touch are left to the larger band.
  const names: { s: number; x: number; y: number; w: number; size: number }[] = [];
  for (let s = 0; s < S; s++) {
    const pts: Vec3[] = [];
    for (let j = 0; j < B; j++) pts.push([binCentreX(ts, j), Y(upper[s]![j]!), 0]);
    b.poly(pts, 0.22);
    const cat = cats?.list[s];
    if (!cat) continue;
    let last = -1;
    for (let j = B - 1; j >= 0; j--) if (raw[s]![j]! > 0) {
      last = j;
      break;
    }
    if (last < 0) continue;
    const thick = (upper[s]![last]! - lower[s]![last]!) * scale;
    if (thick < 0.05 && S > 6) continue;
    const x = binCentreX(ts, last) + 0.12;
    names.push({ s, x, y: Y((upper[s]![last]! + lower[s]![last]!) / 2), w: labelWidth(p.stage, axisLabel(cat.label).length), size: cat.count });
  }
  const shown = clearLabels(names, labelPitch(p.stage));
  names.forEach((n, i) => {
    const cat = cats!.list[n.s]!;
    if (shown.has(i)) b.label([n.x, n.y, 0], axisLabel(cat.label), "axis", "left", seriesRef(ts, cat.key));
    if (cat.count < THIN_GROUP) b.thin(cat.key, cat.count);
  });
  const lowest: Vec3[] = [];
  for (let j = 0; j < B; j++) lowest.push([binCentreX(ts, j), Y(base[j]!), 0]);
  b.poly(lowest, 0.22);
  timeAxis(b, ts, bottom - 0.25, top);
  nowMark(b, ts, bottom - 0.25, top, p.now);
  // Readings: the leading band named at each end of the time axis.
  const totals = new Float64Array(B);
  for (let s = 0; s < S; s++) for (let j = 0; j < B; j++) totals[j]! += raw[s]![j]!;
  let first = -1;
  let lastBin = -1;
  for (let j = 0; j < B; j++) if (totals[j]! > 0) {
    if (first < 0) first = j;
    lastBin = j;
  }
  if (cats && first >= 0) {
    for (const j of first === lastBin ? [first] : [first, lastBin]) {
      let lead = 0;
      for (let s = 1; s < S; s++) if (raw[s]![j]! > raw[lead]![j]!) lead = s;
      const cat = cats.list[lead]!;
      b.reading(
        makeReading({
          kind: "largest",
          copyKey: "readings.largest",
          values: { n: cat.label },
          at: [binCentreX(ts, j), Y((upper[lead]![j]! + lower[lead]![j]!) / 2), 0],
          ref: seriesRef(ts, cat.key),
          cat: [ts.series!, cat.key],
        }),
      );
    }
  }
  return b.finish(flatCamera());
}

// ───────────────────────────── ridgeline ─────────────────────────────

/** The waves are stacked in depth and the camera looks down on them at this angle. */
export const WAVE_TILT = 20;
/** Rows sit this much closer together vertically than the flat chart spaced them; depth carries the rest. */
const WAVE_Y_SPACING = 0.8;
/** Depth between two rows, as a share of the row gap. */
const WAVE_Z_SHARE = 0.6;

/** Depth of a wave row: rows stack front to back, the first (back) row furthest, the stack centred on z = 0. */
export function waveRowZ(row: number, rows: number, gap: number): number {
  return (row - (rows - 1) / 2) * gap * WAVE_Z_SHARE;
}

/**
 * The aggregate envelope: every row's binned series summed, then smoothed and scaled exactly as the rows are, so it
 * lines up with them. One value per bin.
 */
export function waveEnvelope(rows: readonly Float64Array[], smoothing: WaveSmoothing, window: number, scale: WaveScale): Float64Array {
  const B = rows[0]?.length ?? 0;
  const sum = new Float64Array(B);
  for (const r of rows) for (let j = 0; j < B; j++) sum[j]! += r[j]!;
  return scaleSeries(smoothSeries(sum, smoothing, window), scale);
}

export function layoutRidgeline(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, seriesAxes(DEFAULT_SERIES.ridgeline!));
  const PLOT = plotRect(p.stage);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  // The row labels stand in a column at the right, so the time axis starts further left than it used to.
  const ts = timeSetup(p, DEFAULT_SERIES.ridgeline!, -5.9, 4.7);
  const cats = seriesCategories(p, ts);
  const S = cats ? cats.list.length : 1;
  const B = ts.bins.count;
  if (cats) b.categories = cats.all;
  const binOf = binsOfMembers(p, ts);
  const words = p.index.cols.words;
  const raw = Array.from({ length: S }, () => new Float64Array(B));
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const bi = binOf[o]!;
    const s = cats ? cats.of[o]! : 0;
    if (bi >= 0 && s !== NO_CODE) raw[s]![bi]! += p.spec.size === "words" ? words[o]! : 1;
  }
  const opt = p.spec.options;
  const smoothing = waveSmoothing(opt);
  const bins = windowBins(waveWindowDays(opt), ts.bins.grain);
  const scale = waveScale(opt);
  const normalise = opt.normalise === true;
  const shaped = raw.map((r) => scaleSeries(smoothSeries(r, smoothing, bins), scale));
  const globalMax = shaped.reduce((m, r) => Math.max(m, ...r), 0) || 1;
  const height = shaped.map((r) => {
    const max = normalise ? Math.max(...r) || 1 : globalMax;
    return r.map((v) => v / max);
  });
  // Rows: the aggregate envelope is its own row at the back (row 0) when there is more than one series.
  const hasEnv = S >= 2;
  const R = S + (hasEnv ? 1 : 0);
  const rowOf = (s: number) => (hasEnv ? s + 1 : s);
  const top = PLOT.top;
  const bottom = PLOT.bottom + 0.1;
  const gap = (top - bottom) / (WAVE_Y_SPACING * (R - 1) + 1.7);
  const amp = gap * 1.7;
  const rowY = (r: number) => top - (WAVE_Y_SPACING * r + 1.7) * gap;
  const rowZ = (r: number) => waveRowZ(r, R, gap);
  const baseY = (s: number) => rowY(rowOf(s));
  const waveSlot = rowLabelSlots(p.stage, gap * WAVE_Y_SPACING, ts.right + 0.14, 1);
  const zOf = (s: number) => rowZ(rowOf(s));
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const bi = binOf[o]!;
    const s = cats ? cats.of[o]! : 0;
    if (bi < 0 || s === NO_CODE) continue;
    const t = axisTime(p, o, ts.basis);
    const h = Math.max(0.02, sampleSeries(height[s]!, binPos(ts, t, bi)) * amp);
    b.place(o, ts.xOf(t), baseY(s) + (0.04 + 0.92 * rnd(p, o, 12)) * h, zOf(s) + (rnd(p, o, 7) - 0.5) * FLAT_Z);
  }
  // Rows: baseline, curve, label at the right, peak dot with its month.
  const peaks: { s: number; j: number; t: number }[] = [];
  let marks = 0;
  for (let s = 0; s < S; s++) {
    const y0 = baseY(s);
    const z = zOf(s);
    const cat = cats?.list[s];
    b.line([ts.left, y0, z], [ts.right, y0, z], 0.16);
    const pts: Vec3[] = [];
    for (let j = 0; j < B; j++) pts.push([binCentreX(ts, j), y0 + height[s]![j]! * amp, z]);
    b.poly(pts, 0.5);
    // The names stand at the right with no room beside them for a second column: a crowded stage names every other row.
    if (cat) {
      if (waveSlot(s)) b.label([ts.right + 0.14, y0 + 0.06, z], axisLabel(cat.label), "axis", "left", seriesRef(ts, cat.key));
      if (cat.count < THIN_GROUP) b.thin(cat.key, cat.count);
    }
    for (let j = 0; j < B && marks < 8000; j++) {
      const c = raw[s]![j]!;
      if (c <= 0) continue;
      b.mark(
        seriesRef(ts, cat?.key ?? "", [ts.bins.edges[j]!, ts.bins.edges[j + 1]!]),
        cat?.label ?? ts.bins.label(j),
        c,
        { x0: ts.xOf(ts.bins.edges[j]!), y0, x1: ts.xOf(ts.bins.edges[j + 1]!), y1: y0 + Math.max(0.05, height[s]![j]! * amp) },
        z - 0.1,
        z + 0.1,
      );
      marks += 1;
    }
    const pk = peakIndex(raw[s]!);
    if (pk >= 0) peaks.push({ s, j: pk, t: ts.bins.edges[pk]! });
  }
  let latest = -1;
  peaks.forEach((pk, i) => {
    if (latest < 0 || pk.t > peaks[latest]!.t) latest = i;
  });
  peaks.forEach((pk, i) => {
    const x = binCentreX(ts, pk.j);
    const y = baseY(pk.s) + height[pk.s]![pk.j]! * amp;
    const z = zOf(pk.s);
    b.rect({ x0: x - 0.035, y0: y - 0.035, x1: x + 0.035, y1: y + 0.035 }, i === latest ? 1 : 0.6, 1, z + 0.05);
    if (i !== latest) b.label([x, y + 0.14, z + 0.05], ts.bins.label(pk.j), "muted", "center", seriesRef(ts, cats?.list[pk.s]?.key ?? "", [ts.bins.edges[pk.j]!, ts.bins.edges[pk.j + 1]!]));
  });
  // The aggregate envelope: the total, smoothed and scaled like the rows, in near-white above the stack.
  let envPeak = -1;
  let env: Float64Array = new Float64Array(0);
  let emax = 1;
  if (hasEnv) {
    env = waveEnvelope(raw, smoothing, bins, scale);
    emax = Math.max(...env) || 1;
    const y0 = rowY(0);
    const z = rowZ(0);
    b.line([ts.left, y0, z], [ts.right, y0, z], 0.16);
    const pts: Vec3[] = [];
    for (let j = 0; j < B; j++) pts.push([binCentreX(ts, j), y0 + (env[j]! / emax) * amp, z]);
    b.poly(pts, 0.92);
    b.label([ts.right + 0.14, y0 + 0.06, z], "", "axis", "left", { copy: "chart.waveTotal" });
    const sum = new Float64Array(B);
    for (const r of raw) for (let j = 0; j < B; j++) sum[j]! += r[j]!;
    envPeak = peakIndex(sum);
    if (envPeak >= 0) {
      const x = binCentreX(ts, envPeak);
      const y = y0 + (env[envPeak]! / emax) * amp;
      b.rect({ x0: x - 0.035, y0: y - 0.035, x1: x + 0.035, y1: y + 0.035 }, 0.95, 1, z + 0.05);
    }
  }
  // The wall at the right edge (a thin outline of the plane that closes the stack) and a flag at the current date.
  const front = rowZ(R - 1) + gap * 0.3;
  const back = rowZ(0) - gap * 0.3;
  const wallLo = rowY(R - 1) - 0.05;
  const wallHi = rowY(0) + amp * 0.9;
  b.poly([[ts.right, wallLo, back], [ts.right, wallLo, front], [ts.right, wallHi, front], [ts.right, wallHi, back]], 0.3, true);
  const t0 = ts.bins.edges[0]!;
  const t1 = ts.bins.edges[B]!;
  if (p.now >= t0 && p.now <= t1) {
    const x = ts.xOf(p.now);
    const poleTop = wallHi - 0.1;
    b.line([x, wallLo, front], [x, poleTop, front], 0.5);
    b.poly([[x, poleTop, front], [x - 0.22, poleTop - 0.07, front], [x, poleTop - 0.14, front]], 0.7, true);
    b.label([x, poleTop + 0.14, front], "", "muted", "center", { copy: "strip.today" });
  }
  timeAxis(b, ts, rowY(R - 1) - 0.2, top, front);
  // Readings: the latest peak, then the tallest peak when it is another row, then the overall peak.
  const reading = (i: number) => {
    const pk = peaks[i]!;
    const cat = cats?.list[pk.s];
    const label = ts.bins.grain === "month" ? ts.bins.label(pk.j) : dayLabel(localDay(ts.bins.edges[pk.j]!));
    b.reading(
      makeReading({
        kind: "peak",
        copyKey: "readings.peak",
        values: { label },
        at: [binCentreX(ts, pk.j), baseY(pk.s) + height[pk.s]![pk.j]! * amp + 0.14, zOf(pk.s) + 0.05],
        ref: seriesRef(ts, cat?.key ?? "", [ts.bins.edges[pk.j]!, ts.bins.edges[pk.j + 1]!]),
      }),
    );
  };
  if (latest >= 0) reading(latest);
  let tallest = -1;
  peaks.forEach((pk, i) => {
    if (tallest < 0 || raw[pk.s]![pk.j]! > raw[peaks[tallest]!.s]![peaks[tallest]!.j]!) tallest = i;
  });
  if (tallest >= 0 && tallest !== latest) reading(tallest);
  if (envPeak >= 0) {
    b.reading(
      makeReading({
        kind: "peak",
        copyKey: "readings.peak",
        values: { label: ts.bins.grain === "month" ? ts.bins.label(envPeak) : dayLabel(localDay(ts.bins.edges[envPeak]!)) },
        at: [binCentreX(ts, envPeak), rowY(0) + (env[envPeak]! / emax) * amp + 0.14, rowZ(0) + 0.05],
        ref: { t: [ts.bins.edges[envPeak]!, ts.bins.edges[envPeak + 1]!] },
      }),
    );
  }
  return b.finish({ centre: [0, 0, 0], radius: Math.hypot(FRAME.halfW, FRAME.halfH) * 1.02, tiltDeg: WAVE_TILT, keepUpright: true });
}

// ───────────────────────────── calendar heatmap ─────────────────────────────

/**
 * A square of side `side` around (cx, cy) on the flat plane: the list fills a jittered grid inside it, the last row
 * centred. Every particle stays inside the square.
 */
export function fillSquare(b: ChartBuilder, list: ArrayLike<number>, cx: number, cy: number, side: number, mark: number): void {
  const n = list.length;
  if (n === 0) return;
  const g = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / g);
  const cell = side / g;
  const half = side / 2;
  for (let k = 0; k < n; k++) {
    const o = list[k]!;
    const gx = k % g;
    const gy = Math.floor(k / g);
    const inRow = gy === rows - 1 ? n - gy * g : g;
    const jx = (rnd(b.p, o, 1) - 0.5) * cell * 0.6;
    const jy = (rnd(b.p, o, 2) - 0.5) * cell * 0.6;
    const x = cx - half + (gx + 0.5 + (g - inRow) / 2) * cell + jx;
    const y = cy - half + (gy + 0.5 + (g - rows) / 2) * cell + jy;
    b.flat(o, clamp(x, cx - half, cx + half), clamp(y, cy - half, cy + half), mark);
  }
}

/** Gap between the year rows of the calendar, in cells: room for the month names under each row of blocks. */
const MONTH_ROW_GAP = 2.4;
/** Gap between two month blocks of a row, in cells. */
const MONTH_COL_GAP = 0.7;

/** One month's block in a calendar row: its first day, length, first weekday (Monday = 0), width in weeks and first column. */
export interface MonthBlock {
  month: number;
  first: number;
  days: number;
  weekday: number;
  cols: number;
  col0: number;
}

/** The 12 month blocks of a year, left to right, each `cols` weeks wide with `MONTH_COL_GAP` cells between. */
export function monthBlocks(year: number): MonthBlock[] {
  const out: MonthBlock[] = [];
  let col = 0;
  for (let m = 1; m <= 12; m++) {
    const first = daysFromCivil(year, m, 1);
    const days = (m === 12 ? daysFromCivil(year + 1, 1, 1) : daysFromCivil(year, m + 1, 1)) - first;
    const weekday = weekdayOfDay(first);
    const cols = Math.ceil((weekday + days) / 7);
    out.push({ month: m, first, days, weekday, cols, col0: col });
    col += cols + MONTH_COL_GAP;
  }
  return out;
}

/** Width of a row of month blocks in cells. */
function rowCols(blocks: readonly MonthBlock[]): number {
  const last = blocks[blocks.length - 1]!;
  return last.col0 + last.cols;
}

/** The outline of a month block as (column, row) corners from its top-left, row growing downward; the first and last weeks step. */
export function monthOutline(mb: MonthBlock): [number, number][] {
  const last = mb.weekday + mb.days - 1;
  const lastCol = Math.floor(last / 7);
  const lastRow = (last % 7) + 1;
  const raw: [number, number][] = [
    [0, mb.weekday],
    [1, mb.weekday],
    [1, 0],
    [lastCol + 1, 0],
    [lastCol + 1, lastRow],
    [lastCol, lastRow],
    [lastCol, 7],
    [0, 7],
  ];
  const out: [number, number][] = [];
  for (const pt of raw) {
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== pt[0] || prev[1] !== pt[1]) out.push(pt);
  }
  return out;
}

export function layoutCalendarHeatmap(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, () => []);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  const date = parseDateDim(p.spec.x.dim);
  const basis = date?.basis ?? "written";
  const window = chartWindow(p, basis);
  const d0 = localDay(window[0]);
  const d1 = localDay(window[1]);
  const y0 = civilFromDays(d0)[0];
  const y1 = civilFromDays(d1)[0];
  const years = Math.max(1, y1 - y0 + 1);
  const dayOf = new Int32Array(p.index.count).fill(-1);
  const perDay = new Map<number, number[]>();
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const t = axisTime(p, o, basis);
    if (!Number.isFinite(t)) continue;
    const d = localDay(t);
    if (d < d0 || d > d1) continue;
    dayOf[o] = d;
    const list = perDay.get(d);
    if (list) list.push(o);
    else perDay.set(d, [o]);
  }
  if (perDay.size === 0) return b.finish(flatCamera());
  // Each year is a row of 12 month blocks (weekday rows, one column per week) with a gap between the blocks. The grid
  // is as wide as the widest year, so every row lines up under the same width.
  const blockCache = new Map<number, MonthBlock[]>();
  const yearBlocks = (year: number): MonthBlock[] => {
    let v = blockCache.get(year);
    if (!v) blockCache.set(year, (v = monthBlocks(year)));
    return v;
  };
  let colsMax = 0;
  for (let year = y0; year <= y1; year++) colsMax = Math.max(colsMax, rowCols(yearBlocks(year)));
  const s = Math.min(12.2 / colsMax, 7.4 / (years * (7 + MONTH_ROW_GAP)));
  const gridW = colsMax * s;
  const xLeft = -gridW / 2 + 0.35;
  const blockH = 7 * s;
  const gap = MONTH_ROW_GAP * s;
  const totalH = years * blockH + (years - 1) * gap;
  const topY = totalH / 2;
  /** Most recent year at the top. */
  const blockTop = (year: number) => topY - (y1 - year) * (blockH + gap);
  const cell = (d: number) => {
    const [year, month] = civilFromDays(d);
    const mb = yearBlocks(year)[month - 1]!;
    const off = mb.weekday + (d - mb.first);
    const x = xLeft + (mb.col0 + Math.floor(off / 7) + 0.5) * s;
    const y = blockTop(year) - ((off % 7) + 0.5) * s;
    return { x, y, year };
  };
  let maxC = 0;
  for (const list of perDay.values()) maxC = Math.max(maxC, list.length);
  for (let year = y0; year <= y1; year++) {
    const bt = blockTop(year);
    // The year stands left of the weekday names (Mon, Wed, Fri), not on top of them.
    b.label([xLeft - 0.16 - labelWidth(p.stage, 3), bt - blockH / 2, 0], String(year), "axis", "right", { t: [dayStartMs(daysFromCivil(year, 1, 1)), dayStartMs(daysFromCivil(year + 1, 1, 1))] });
    for (const mb of yearBlocks(year)) {
      const last = mb.first + mb.days - 1;
      if (mb.first > d1 || last < d0) continue;
      const x0 = xLeft + mb.col0 * s;
      // A hairline outline per month: a stepped rectangle, the first week starting on the month's first weekday.
      const ring = monthOutline(mb).map(([cx, cy]): Vec3 => [x0 + cx * s, bt - cy * s, 0]);
      b.poly(ring, 0.1, true);
      // The month's name stands under its block; the first and the last month of a row turn upright (-90 deg) at the edges.
      const edge = mb.month === 1 || mb.month === 12;
      const name = monthName(mb.month);
      if (edge) b.label([x0 + (mb.cols * s) / 2, bt - blockH - 0.08 - name.length * 0.035, 0], name, "muted", "center", undefined, -90);
      else b.label([x0 + (mb.cols * s) / 2, bt - blockH - 0.1, 0], name, "muted", "center");
    }
  }
  const firstBlock = blockTop(y1);
  for (const wd of [0, 2, 4]) b.label([xLeft - 0.06, firstBlock - (wd + 0.5) * s, 0], weekdayName(wd), "muted", "right");
  const days = [...perDay.keys()].sort((a, c) => a - c);
  let busiest = days[0]!;
  for (const d of days) {
    const list = perDay.get(d)!;
    const { x, y } = cell(d);
    // A day is a square of particles; the side grows with the count, so zoomed in the cells read as large squares.
    const side = s * 0.9 * Math.max(0.4, Math.sqrt(list.length / maxC));
    const t: [number, number] = [dayStartMs(d), dayStartMs(d + 1)];
    const mark = b.mark({ t }, dayLabel(d), list.length, { x0: x - s / 2, y0: y - s / 2, x1: x + s / 2, y1: y + s / 2 });
    fillSquare(b, list, x, y, side, mark);
    if (list.length > perDay.get(busiest)!.length) busiest = d;
  }
  const run = longestRun(days);
  if (run.length >= 2) {
    const a = cell(run.start);
    const z = cell(run.end);
    const yb = blockTop(a.year) + 0.05;
    b.reading(
      makeReading({
        kind: "run",
        copyKey: "readings.run",
        values: { n: run.length },
        at: [a.x - s / 2, yb, 0],
        to: [z.year === a.year ? z.x + s / 2 : xLeft + gridW, yb, 0],
        ref: { t: [dayStartMs(run.start), dayStartMs(run.end + 1)] },
      }),
    );
  }
  const bc = cell(busiest);
  b.reading(
    makeReading({
      kind: "peak",
      copyKey: "readings.peak",
      values: { label: dayLabel(busiest) },
      at: [bc.x, bc.y + s * 0.6, 0.06],
      ref: { t: [dayStartMs(busiest), dayStartMs(busiest + 1)] },
    }),
  );
  return b.finish(flatCamera());
}

// ───────────────────────────── timeline lanes ─────────────────────────────

/** "Still active" = its last entry within 30 days of the newest entry in the chart. */
const ACTIVE_DAYS = 30;
/** The plane tilts to this angle when a hub is focused on the Lifelines chart. */
export const FOCUS_TILT = 18;
/** The focused lane's row is this many times as tall as the others. */
const FOCUS_HEIGHT = 2;
/** Everything but the focused lane is drawn at this strength. */
const FOCUS_DIM = 0.4;

/** A lane's length in months (at least 1) and 1 while it is still active (last entry within 30 days of the newest). */
export function lifeSpan(first: number, last: number, newest: number): [number, number] {
  const months = Math.max(1, Math.round((last - first) / DAY_MS / 30.44));
  return [months, last >= newest - ACTIVE_DAYS * DAY_MS ? 1 : 0];
}

/**
 * Row centres and heights (top to bottom order of the lanes as given). Without focus every lane has the same row. With
 * a focused lane that lane takes the centre row at twice the height and the others share the rest above and below.
 */
export function laneRows(lanes: number, top: number, bottom: number, focus: number | null): { y: number[]; h: number[] } {
  const y = new Array<number>(lanes).fill(0);
  const h = new Array<number>(lanes).fill(0);
  if (lanes === 0) return { y, h };
  if (focus === null || focus < 0 || focus >= lanes) {
    const step = (top - bottom) / lanes;
    for (let l = 0; l < lanes; l++) {
      h[l] = step;
      y[l] = top - (l + 0.5) * step;
    }
    return { y, h };
  }
  const unit = (top - bottom) / (lanes + FOCUS_HEIGHT - 1);
  const others: number[] = [];
  for (let l = 0; l < lanes; l++) if (l !== focus) others.push(l);
  const aboveCount = Math.floor((lanes - 1) / 2);
  const order = [...others.slice(0, aboveCount), focus, ...others.slice(aboveCount)];
  let cursor = top;
  for (const l of order) {
    h[l] = l === focus ? unit * FOCUS_HEIGHT : unit;
    y[l] = cursor - h[l]! / 2;
    cursor -= h[l]!;
  }
  return { y, h };
}

/**
 * The lane a hub (spec.focusMap) belongs to: the lane that holds most of the hub, its member notes and their sources,
 * or -1 when none of them sits on a lane.
 */
export function focusLane(p: Prepared, of: ArrayLike<number>, lanes: number): number {
  const hub = p.spec.focusMap;
  if (hub === undefined || hub < 0 || hub >= p.index.count) return -1;
  const { hubMembers, noteSources } = p.index.rel;
  const votes = new Array<number>(lanes).fill(0);
  const vote = (o: number) => {
    if (o < 0 || o >= p.index.count) return;
    const l = of[o]!;
    if (l !== NO_CODE && l < lanes) votes[l]! += 1;
  };
  const notes: number[] = [hub];
  if (hub + 1 < hubMembers.offsets.length) for (let k = hubMembers.offsets[hub]!; k < hubMembers.offsets[hub + 1]!; k++) notes.push(hubMembers.targets[k]!);
  for (const n of notes) {
    vote(n);
    if (n + 1 >= noteSources.offsets.length) continue;
    for (let k = noteSources.offsets[n]!; k < noteSources.offsets[n + 1]!; k++) vote(noteSources.targets[k]!);
  }
  let best = -1;
  for (let l = 0; l < lanes; l++) if (votes[l]! > 0 && (best < 0 || votes[l]! > votes[best]!)) best = l;
  return best;
}

export function layoutTimelineLanes(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, seriesAxes(DEFAULT_SERIES["timeline-lanes"]!));
  const PLOT = plotRect(p.stage);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  let ts = timeSetup(p, DEFAULT_SERIES["timeline-lanes"]!, PLOT.left, PLOT.right - 0.3);
  const cats = showRows(p, ts, seriesCategories(p, ts), "span");
  if (!cats || cats.list.length === 0) return b.finish(flatCamera());
  b.categories = cats.all;
  const L = cats.list.length;
  const stat = rowStats(p, ts, cats);
  if (stat.some((r) => backMonths(r.gap) !== undefined)) ts = timeSetup(p, DEFAULT_SERIES["timeline-lanes"]!, PLOT.left + BACK_GUTTER, PLOT.right - 0.3);
  const t0 = ts.window[0];
  const t1 = ts.window[1];
  const first = new Float64Array(L).fill(Number.POSITIVE_INFINITY);
  const last = new Float64Array(L).fill(Number.NEGATIVE_INFINITY);
  let newest = Number.NEGATIVE_INFINITY;
  const inAxis = (t: number) => Number.isFinite(t) && t >= t0 && t <= t1;
  // Show = Curve plots how long lives lasted against the share still going: its own layout.
  if (lanesShow(p.spec.options) === "curve") return layoutLifeCurves(b, p, cats, (o) => { const t = axisTime(p, o, ts.basis); return inAxis(t) ? t : Number.NaN; }, (key) => seriesRef(ts, key));
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const l = cats.of[o]!;
    const t = axisTime(p, o, ts.basis);
    if (l === NO_CODE || !inAxis(t)) continue;
    first[l] = Math.min(first[l]!, t);
    last[l] = Math.max(last[l]!, t);
    newest = Math.max(newest, t);
  }
  const top = PLOT.top;
  const bottom = PLOT.bottom + 0.15;
  // A hub in focus (a map open in the reader): its lane takes the centre row at twice the height and the plane tilts.
  let focus = focusLane(p, cats.of, L);
  if (focus >= 0 && !Number.isFinite(first[focus]!)) focus = -1;
  const rows = laneRows(L, top, bottom, focus >= 0 ? focus : null);
  const show = lanesShow(p.spec.options);
  const months = makeBins(t0, t1, "month");
  const buckets = bucketise(p.members, cats.of, L);
  // Entries per month per lane (not needed when the entries are drawn as loose dots).
  const perMonth: Map<number, number[]>[] = Array.from({ length: L }, () => new Map<number, number[]>());
  let maxBlock = 0;
  if (show !== "dots") {
    for (let l = 0; l < L; l++) {
      for (const o of buckets[l]!) {
        const t = axisTime(p, o, ts.basis);
        if (!inAxis(t)) continue;
        const m = months.of(t);
        const list = perMonth[l]!.get(m);
        if (list) list.push(o);
        else perMonth[l]!.set(m, [o]);
      }
      for (const list of perMonth[l]!.values()) maxBlock = Math.max(maxBlock, list.length);
    }
  }
  // Density: each lane's monthly counts, lightly smoothed, share one height scale.
  const curves: Float64Array[] = [];
  let maxCurve = 0;
  if (show === "density") {
    for (let l = 0; l < L; l++) {
      const raw = new Float64Array(months.count);
      for (const [m, list] of perMonth[l]!) raw[m] = list.length;
      const sm = new Float64Array(months.count);
      for (let j = 0; j < months.count; j++) sm[j] = (2 * raw[j]! + (j > 0 ? raw[j - 1]! : raw[j]!) + (j < months.count - 1 ? raw[j + 1]! : raw[j]!)) / 4;
      for (let j = 0; j < months.count; j++) maxCurve = Math.max(maxCurve, sm[j]!);
      curves.push(sm);
    }
  }
  let longest = -1;
  const labelSlot = rowLabelSlots(p.stage, Math.min(...rows.h), ts.left - 0.14);
  for (let l = 0; l < L; l++) {
    const cat = cats.list[l]!;
    const y = rows.y[l]!;
    const step = rows.h[l]!;
    if (!Number.isFinite(first[l]!)) continue;
    const isFocus = l === focus;
    const dim = focus >= 0 && !isFocus ? FOCUS_DIM : 1;
    const xa = ts.xOf(first[l]!);
    const xb = ts.xOf(last[l]!);
    const life = lifeSpan(first[l]!, last[l]!, newest);
    const ref = seriesRef(ts, cat.key);
    ref.span = [first[l]!, last[l]!];
    ref.life = life;
    const mark = b.mark(ref, cat.label, cat.count, { x0: xa - 0.05, y0: y - step * 0.45, x1: xb + 0.05, y1: y + step * 0.45 });
    b.line([xa, y, 0], [xb, y, 0], 0.45 * dim);
    // A short tick across the lane marks its first entry.
    const tick = Math.min(0.08, step * 0.3);
    b.line([xa, y - tick, 0], [xa, y + tick, 0], 0.75 * dim);
    if (life[1] === 1) {
      const a = Math.min(0.12, step * 0.3);
      b.poly([[xb - a, y + a * 0.7, 0], [xb + 0.02, y, 0], [xb - a, y - a * 0.7, 0]], 0.75 * dim);
    } else b.line([xb, y - tick, 0], [xb, y + tick, 0], 0.75 * dim);
    // The label: the name, and under it the length and status when the row is tall enough (the tooltip always says it).
    // A crowded stage labels every other row, or sets alternate names in a second column (CHART-03).
    const slot = labelSlot(l, isFocus);
    if (!slot) {
      // no room for this row's name: it stays in the tooltip
    } else if (isFocus || step >= 0.4) {
      const off = Math.min(0.14, step * 0.2);
      b.label([slot.x, y + off, 0], axisLabel(cat.label, slot.short ? COLUMN_LABEL_CHARS : undefined), isFocus ? "title" : dim < 1 ? "muted" : "axis", "right", rowRef(ts, cat.key, backMonths(stat[l]!.gap), slot.short));
      b.label([slot.x, y - off, 0], "", "muted", "right", { life });
    } else b.label([slot.x, y, 0], axisLabel(cat.label, slot.short ? COLUMN_LABEL_CHARS : undefined), dim < 1 ? "muted" : "axis", "right", rowRef(ts, cat.key, backMonths(stat[l]!.gap), slot.short));
    if (cat.count < THIN_GROUP) b.thin(cat.key, cat.count);
    if (longest < 0 || last[l]! - first[l]! > last[longest]! - first[longest]!) longest = l;
    if (show === "dots") {
      for (const o of buckets[l]!) {
        const t = axisTime(p, o, ts.basis);
        if (inAxis(t)) b.flat(o, ts.xOf(t), y + (rnd(p, o, 13) - 0.5) * step * 0.4, mark);
      }
    } else if (show === "density") {
      const curve = curves[l]!;
      const scaleY = (step * 0.8) / (maxCurve || 1);
      const pts: Vec3[] = [];
      for (let j = 0; j < months.count; j++) {
        const x = ts.xOf((months.edges[j]! + months.edges[j + 1]!) / 2);
        if (x < xa - 0.05 || x > xb + 0.05) continue;
        pts.push([x, y + curve[j]! * scaleY, 0]);
      }
      b.poly(pts, 0.5 * dim);
      for (const o of buckets[l]!) {
        const t = axisTime(p, o, ts.basis);
        if (!inAxis(t)) continue;
        const m = months.of(t);
        const pos = m + (t - months.edges[m]!) / Math.max(1, months.edges[m + 1]! - months.edges[m]!);
        const h = Math.max(0.02, sampleSeries(curve, pos) * scaleY);
        b.flat(o, ts.xOf(t), y + (0.04 + 0.92 * rnd(p, o, 14)) * h, mark);
      }
    } else {
      for (const [m, list] of perMonth[l]!) {
        const xa2 = ts.xOf(months.edges[m]!);
        const xb2 = ts.xOf(months.edges[m + 1]!);
        const xc = (xa2 + xb2) / 2;
        if (show === "blocks") {
          const w = (xb2 - xa2) * 0.82;
          const h = Math.max(step * 0.12, step * 0.72 * Math.sqrt(list.length / Math.max(1, maxBlock)));
          fillRect(b, list, { x0: xc - w / 2, y0: y - h / 2, x1: xc + w / 2, y1: y + h / 2 }, mark, 0.01);
        } else {
          // Lines: the month's entries gather in a small clump on the line itself.
          const r = Math.min(step * 0.4, 0.03 + 0.07 * Math.sqrt(list.length / Math.max(1, maxBlock)));
          fillDisc(b, list, xc, y, r, mark);
        }
      }
    }
    if (isFocus) focusAdornments(b, xa, xb, y, step);
  }
  timeAxis(b, ts, bottom - 0.2, top);
  if (longest >= 0) {
    const y = rows.y[longest]! + Math.min(0.3, rows.h[longest]! * 0.45);
    const days = Math.max(1, Math.round((last[longest]! - first[longest]!) / DAY_MS) + 1);
    b.reading(
      makeReading({
        kind: "longest",
        copyKey: "readings.run",
        values: { n: days },
        at: [ts.xOf(first[longest]!), y, 0],
        to: [ts.xOf(last[longest]!), y, 0],
        ref: seriesRef(ts, cats.list[longest]!.key),
      }),
    );
  }
  const camera = flatCamera();
  return b.finish(focus >= 0 ? { ...camera, tiltDeg: FOCUS_TILT, keepUpright: true } : camera);
}

/**
 * The focused lane's extras: a focus sphere at its last entry with a halo of points around it, and a ribbon of points,
 * its hue sweeping from the first entry to the last, that follows the lane from start to end.
 */
function focusAdornments(b: ChartBuilder, xa: number, xb: number, y: number, step: number): void {
  const radius = Math.min(0.16, step * 0.2);
  b.items.push({ type: "ring", at: [xb, y, 0.06], radius, count: 1 });
  b.items.push({ type: "ring", at: [xb, y, 0.06], radius: radius * 0.55, count: 1, hue: 205 });
  const halo = 20;
  for (let i = 0; i < halo; i++) {
    const a = (i / halo) * Math.PI * 2;
    b.items.push({ type: "ring", at: [xb + Math.cos(a) * radius * 1.9, y + Math.sin(a) * radius * 1.9, 0.06], radius: 0.014, count: 1, hue: (i / halo) * 360 });
  }
  const length = xb - xa;
  if (length < 0.05) return;
  const n = Math.max(8, Math.min(160, Math.round(length / 0.06)));
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    b.items.push({ type: "ring", at: [xa + length * f, y + Math.sin(f * Math.PI * 6) * step * 0.07, 0.04], radius: 0.014, count: 1, hue: f * 300 });
  }
}

// ───────────────────────────── bands ─────────────────────────────

/** A segment of a band is at most this tall (world units), however tall the band's row. */
const BAND_SEGMENT_MAX = 0.95;

/**
 * Bands: one band per value of the series, laid along the date axis as short dotted segments (one per week or month,
 * Segments), each as tall as the entries it holds, all on one scale so the bands compare. The band's name stands at its
 * left end; a faint dotted line joins its segments. Reading: the fullest segment.
 */
export function layoutBands(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, seriesAxes(DEFAULT_SERIES.bands!));
  const PLOT = plotRect(p.stage);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  const seg = bandSegments(p.spec.options);
  const ts = timeSetup(p, DEFAULT_SERIES.bands!, PLOT.left, PLOT.right - 0.3, seg === "auto" ? undefined : seg);
  const cats = seriesCategories(p, ts);
  if (!cats || cats.list.length === 0) return b.finish(flatCamera());
  b.categories = cats.all;
  const L = cats.list.length;
  const binOf = binsOfMembers(p, ts);
  const cell: Map<number, number[]>[] = Array.from({ length: L }, () => new Map<number, number[]>());
  let maxCount = 0;
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const l = cats.of[o]!;
    const bi = binOf[o]!;
    if (l === NO_CODE || l >= L || bi < 0) continue;
    const list = cell[l]!.get(bi);
    if (list) list.push(o);
    else cell[l]!.set(bi, [o]);
  }
  for (const m of cell) for (const list of m.values()) maxCount = Math.max(maxCount, list.length);
  const top = PLOT.top;
  const bottom = PLOT.bottom + 0.15;
  const step = (top - bottom) / L;
  const labelSlot = rowLabelSlots(p.stage, step, ts.left - 0.14);
  const reach = Math.min(BAND_SEGMENT_MAX, step * 0.8);
  let best: { l: number; bin: number; n: number } | null = null;
  for (let l = 0; l < L; l++) {
    const cat = cats.list[l]!;
    const y = top - (l + 0.5) * step;
    b.line([ts.left, y, 0], [ts.right, y, 0], 0.12, true);
    const slot = labelSlot(l);
    if (slot) b.label([slot.x, y, 0], axisLabel(cat.label, slot.short ? COLUMN_LABEL_CHARS : undefined), "axis", "right", seriesRef(ts, cat.key));
    if (cat.count < THIN_GROUP) b.thin(cat.key, cat.count);
    for (const [bi, list] of cell[l]!) {
      const xa = ts.xOf(ts.bins.edges[bi]!);
      const xb = ts.xOf(ts.bins.edges[bi + 1]!);
      const w = Math.max(0.02, (xb - xa) * 0.8);
      const xc = (xa + xb) / 2;
      const h = Math.max(Math.min(0.06, reach), reach * (0.12 + 0.88 * Math.sqrt(list.length / Math.max(1, maxCount))));
      const r: Rect2 = { x0: xc - w / 2, y0: y - h / 2, x1: xc + w / 2, y1: y + h / 2 };
      const mark = b.mark(seriesRef(ts, cat.key, [ts.bins.edges[bi]!, ts.bins.edges[bi + 1]!]), cat.label, list.length, r);
      fillRect(b, list, r, mark, 0.005);
      if (!best || list.length > best.n) best = { l, bin: bi, n: list.length };
    }
  }
  timeAxis(b, ts, bottom - 0.2, top);
  if (best) {
    const cat = cats.list[best.l]!;
    const xc = (ts.xOf(ts.bins.edges[best.bin]!) + ts.xOf(ts.bins.edges[best.bin + 1]!)) / 2;
    b.reading(
      makeReading({
        kind: "largest",
        copyKey: "readings.largest",
        values: { n: fmtCount(best.n) },
        at: [xc, top - (best.l + 0.5) * step + reach / 2 + 0.14, 0],
        ref: seriesRef(ts, cat.key, [ts.bins.edges[best.bin]!, ts.bins.edges[best.bin + 1]!]),
      }),
    );
  }
  return b.finish(flatCamera());
}

// ───────────────────────────── arc diagram ─────────────────────────────

export function layoutArcDiagram(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, seriesAxes(DEFAULT_SERIES["arc-diagram"]!));
  const PLOT = plotRect(p.stage);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  let ts = timeSetup(p, DEFAULT_SERIES["arc-diagram"]!, PLOT.left, PLOT.right - 0.3);
  const cats = showRows(p, ts, seriesCategories(p, ts), "gap");
  if (!cats || cats.list.length === 0) return b.finish(flatCamera());
  b.categories = cats.all;
  const minGapDays = clamp(typeof p.spec.options.minGapDays === "number" ? p.spec.options.minGapDays : 7, 1, 365);
  const L = cats.list.length;
  const stat = rowStats(p, ts, cats);
  if (stat.some((r) => r.gap >= minGapDays * DAY_MS && backMonths(r.gap) !== undefined)) ts = timeSetup(p, DEFAULT_SERIES["arc-diagram"]!, PLOT.left + BACK_GUTTER, PLOT.right - 0.3);
  const top = PLOT.top;
  const bottom = PLOT.bottom + 0.15;
  const step = (top - bottom) / L;
  const buckets = bucketise(p.members, cats.of, L);
  interface Burst {
    start: number;
    end: number;
    items: number[];
  }
  const lanes: Burst[][] = [];
  let maxGap = 0;
  for (let l = 0; l < L; l++) {
    const dated = [...buckets[l]!]
      .map((o) => ({ o, t: axisTime(p, o, ts.basis) }))
      .filter((d) => Number.isFinite(d.t) && d.t >= ts.window[0] && d.t <= ts.window[1])
      .sort((a, c) => a.t - c.t || a.o - c.o);
    const bursts: Burst[] = [];
    for (const d of dated) {
      const cur = bursts[bursts.length - 1];
      if (cur && d.t - cur.end < minGapDays * DAY_MS) {
        cur.end = d.t;
        cur.items.push(d.o);
      } else bursts.push({ start: d.t, end: d.t, items: [d.o] });
    }
    for (let k = 1; k < bursts.length; k++) maxGap = Math.max(maxGap, bursts[k]!.start - bursts[k - 1]!.end);
    lanes.push(bursts);
  }
  const tallest = { l: -1, k: -1, gap: 0 };
  const baseOf = (l: number) => top - (l + 0.85) * step;
  const labelSlot = rowLabelSlots(p.stage, step, ts.left - 0.14);
  lanes.forEach((bursts, l) => {
    const cat = cats.list[l]!;
    const y = baseOf(l);
    b.line([ts.left, y, 0], [ts.right, y, 0], 0.14);
    const slot = labelSlot(l);
    // A row that went quiet for a while and came back says how long it was away (bursts further apart than the Minimum gap).
    const away = stat[l]!.gap >= minGapDays * DAY_MS ? backMonths(stat[l]!.gap) : undefined;
    if (slot) b.label([slot.x, y, 0], axisLabel(cat.label, slot.short ? COLUMN_LABEL_CHARS : undefined), "axis", "right", rowRef(ts, cat.key, away, slot.short));
    if (cat.count < THIN_GROUP) b.thin(cat.key, cat.count);
    bursts.forEach((burst, k) => {
      const xc = ts.xOf((burst.start + burst.end) / 2);
      const r = Math.min(step * 0.3, 0.035 * Math.sqrt(burst.items.length) + 0.03);
      const ref = seriesRef(ts, cat.key, [burst.start, burst.end + 1]);
      const mark = b.mark(ref, cat.label, burst.items.length, { x0: xc - r, y0: y - r, x1: xc + r, y1: y + r });
      fillDisc(b, burst.items, xc, y, r, mark);
      if (k === 0) return;
      const prev = bursts[k - 1]!;
      const gap = burst.start - prev.end;
      const xa = ts.xOf((prev.start + prev.end) / 2);
      const h = maxGap > 0 ? step * 0.9 * (gap / maxGap) : 0;
      const pts: Vec3[] = [];
      for (let q = 0; q <= 24; q++) {
        const a = Math.PI * (q / 24);
        pts.push([(xa + xc) / 2 - Math.cos(a) * ((xc - xa) / 2), y + Math.sin(a) * h, 0]);
      }
      b.poly(pts, 0.4);
      if (tallest.l < 0 || gap > tallest.gap) Object.assign(tallest, { l, k, gap });
    });
  });
  timeAxis(b, ts, bottom - 0.2, top);
  if (tallest.l >= 0) {
    const best = tallest;
    const bursts = lanes[best.l]!;
    const prev = bursts[best.k - 1]!;
    const cur = bursts[best.k]!;
    const xa = ts.xOf((prev.start + prev.end) / 2);
    const xc = ts.xOf((cur.start + cur.end) / 2);
    const h = maxGap > 0 ? step * 0.9 * (best.gap / maxGap) : 0;
    b.reading(
      makeReading({
        kind: "longest",
        copyKey: "readings.run",
        values: { n: Math.max(1, Math.round(best.gap / DAY_MS)) },
        at: [(xa + xc) / 2, baseOf(best.l) + h + 0.12, 0],
        ref: seriesRef(ts, cats.list[best.l]!.key, [prev.end, cur.start]),
      }),
    );
  }
  return b.finish(flatCamera());
}

// ───────────────────────────── diverging area ─────────────────────────────

const SPEAKER_YOU = SPEAKER_ORDER.indexOf("you");
const SPEAKER_ASSISTANT = SPEAKER_ORDER.indexOf("assistant");

export function layoutDivergingArea(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, () => []);
  const PLOT = plotRect(p.stage);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  const ts = timeSetup(p, null, PLOT.left, PLOT.right - 0.4);
  const B = ts.bins.count;
  const measureWords = p.spec.options.measure !== "messages";
  const c = p.index.cols;
  const binOf = binsOfMembers(p, ts);
  const you = new Float64Array(B);
  const asst = new Float64Array(B);
  const youItems = new Uint32Array(B);
  const asstItems = new Uint32Array(B);
  const sideOf = new Int8Array(p.index.count);
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const bi = binOf[o]!;
    if (bi < 0 || c.pop[o] !== Population.Record) continue;
    const sp = c.speaker[o]!;
    const v = measureWords ? c.words[o]! : 1;
    if (sp === SPEAKER_YOU) {
      you[bi]! += v;
      youItems[bi]! += 1;
      sideOf[o] = 1;
    } else if (sp === SPEAKER_ASSISTANT) {
      asst[bi]! += v;
      asstItems[bi]! += 1;
      sideOf[o] = -1;
    }
  }
  // Smoothed share per bin, weighted by volume (empty bins carry no share).
  const share = new Float64Array(B).fill(Number.NaN);
  for (let j = 0; j < B; j++) {
    let y = 0;
    let t = 0;
    for (let k = Math.max(0, j - 1); k <= Math.min(B - 1, j + 1); k++) {
      const w = k === j ? 2 : 1;
      y += you[k]! * w;
      t += (you[k]! + asst[k]!) * w;
    }
    if (you[j]! + asst[j]! > 0 && t > 0) share[j] = y / t;
  }
  // Interpolate shares across empty bins for continuous edges; particles only exist in non-empty bins.
  const filled = Float64Array.from(share);
  let lastSeen = -1;
  for (let j = 0; j < B; j++) {
    if (Number.isNaN(share[j]!)) continue;
    if (lastSeen >= 0 && j - lastSeen > 1) for (let k = lastSeen + 1; k < j; k++) filled[k] = share[lastSeen]! + ((share[j]! - share[lastSeen]!) * (k - lastSeen)) / (j - lastSeen);
    lastSeen = j;
  }
  const firstSeen = share.findIndex((v) => !Number.isNaN(v));
  if (firstSeen < 0) return b.finish(flatCamera());
  for (let j = 0; j < firstSeen; j++) filled[j] = share[firstSeen]!;
  for (let j = lastSeen + 1; j < B; j++) filled[j] = share[lastSeen]!;
  const H = 3.2;
  const zero = -0.1;
  const youTop = Array.from(filled, (s) => s * H);
  const asstBottom = Array.from(filled, (s) => -(1 - s) * H);
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const side = sideOf[o]!;
    const bi = binOf[o]!;
    if (side === 0 || bi < 0) continue;
    const t = axisTime(p, o, ts.basis);
    const pos = binPos(ts, t, bi);
    const u = 0.04 + 0.92 * rnd(p, o, 14);
    const y = side > 0 ? sampleSeries(youTop, pos) * u : sampleSeries(asstBottom, pos) * u;
    b.flat(o, ts.xOf(t), zero + y, -1);
  }
  const totalYou = you.reduce((a, v) => a + v, 0);
  const totalAll = totalYou + asst.reduce((a, v) => a + v, 0);
  const overall = totalAll > 0 ? totalYou / totalAll : 0;
  b.line([ts.left, zero, 0], [ts.right, zero, 0], 0.45);
  b.line([ts.left, zero + overall * H, 0], [ts.right, zero + overall * H, 0], 0.55, true);
  const topEdge: Vec3[] = [];
  const bottomEdge: Vec3[] = [];
  for (let j = 0; j < B; j++) {
    topEdge.push([binCentreX(ts, j), zero + youTop[j]!, 0]);
    bottomEdge.push([binCentreX(ts, j), zero + asstBottom[j]!, 0]);
  }
  b.poly(topEdge, 0.5);
  b.poly(bottomEdge, 0.5);
  b.label([ts.left + 0.05, zero + H - 0.1, 0], "", "axis", "left", { copy: "values.you", y: ["speaker", "you"] });
  b.label([ts.left + 0.05, zero - H + 0.1, 0], "", "axis", "left", { copy: "time.assistant", y: ["speaker", "assistant"] });
  let marks = 0;
  for (let j = 0; j < B && marks < 8000; j++) {
    const tr: [number, number] = [ts.bins.edges[j]!, ts.bins.edges[j + 1]!];
    const x0 = ts.xOf(tr[0]);
    const x1 = ts.xOf(tr[1]);
    const youCount = youItems[j]!;
    const asstCount = asstItems[j]!;
    if (youCount > 0) b.mark({ y: ["speaker", "you"], t: tr }, ts.bins.label(j), youCount, { x0, y0: zero, x1, y1: zero + youTop[j]! });
    if (asstCount > 0) b.mark({ y: ["speaker", "assistant"], t: tr }, ts.bins.label(j), asstCount, { x0, y0: zero + asstBottom[j]!, x1, y1: zero });
    marks += 2;
  }
  timeAxis(b, ts, zero - H - 0.2, zero + H);
  // Reading: the bin where your share peaked (ignoring bins under 10% of the median volume).
  const volumes = Array.from({ length: B }, (_, j) => you[j]! + asst[j]!).filter((v) => v > 0).sort((a, c2) => a - c2);
  const median = volumes[Math.floor(volumes.length / 2)] ?? 0;
  let peak = -1;
  for (let j = 0; j < B; j++) {
    const v = you[j]! + asst[j]!;
    if (v <= 0 || v < median * 0.1) continue;
    const s = you[j]! / v;
    if (peak < 0 || s > you[peak]! / (you[peak]! + asst[peak]!)) peak = j;
  }
  if (peak >= 0) {
    const s = you[peak]! / (you[peak]! + asst[peak]!);
    b.reading(
      makeReading({
        kind: "share",
        copyKey: "readings.share",
        values: { p: percent(s) },
        at: [binCentreX(ts, peak), zero + youTop[peak]! + 0.16, 0],
        ref: { y: ["speaker", "you"], t: [ts.bins.edges[peak]!, ts.bins.edges[peak + 1]!] },
      }),
    );
  }
  return b.finish(flatCamera());
}

// ───────────────────────────── beeswarm ─────────────────────────────

/** Conversations beyond this many (the smallest) leave the beeswarm: thousands of clusters are unreadable. */
const BEESWARM_MAX = 4000;

export function layoutBeeswarm(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, () => []);
  const PLOT = plotRect(p.stage);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  const ts = timeSetup(p, null, PLOT.left + 0.3, PLOT.right - 0.3);
  const c = p.index.cols;
  const byWords = p.spec.options.size === "words";
  const convs = new Map<number, { items: number[]; start: number; messages: number; words: number }>();
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const cv = c.conv[o]!;
    if (cv === NONE32) continue;
    const t = axisTime(p, o, ts.basis);
    if (!Number.isFinite(t) || t < ts.window[0] || t > ts.window[1]) continue;
    let e = convs.get(cv);
    if (!e) {
      e = { items: [], start: t, messages: 0, words: 0 };
      convs.set(cv, e);
    }
    e.items.push(o);
    e.start = Math.min(e.start, t);
    e.messages += 1;
    e.words += c.words[o]!;
  }
  if (convs.size === 0) return b.finish(flatCamera());
  const list = [...convs.entries()].map(([conv, e]) => ({ conv, ...e, size: byWords ? e.words : e.messages }));
  list.sort((a, z) => z.size - a.size || a.start - z.start);
  const shown = list.slice(0, BEESWARM_MAX);
  const maxSize = shown[0]!.size || 1;
  const rMax = 0.55;
  const k = rMax / Math.sqrt(maxSize);
  const limitY = 3.2;
  const centres: { x: number; y: number; r: number }[] = [];
  for (const e of shown) {
    const r = Math.max(0.035, k * Math.sqrt(e.size));
    const x = ts.xOf(e.start);
    // Candidates: on the axis, or tangent above / below a neighbour; the one nearest the axis that fits wins.
    const near = centres.filter((q) => Math.abs(q.x - x) < q.r + r);
    const fits = (y: number) => near.every((q) => Math.hypot(q.x - x, q.y - y) >= q.r + r - 1e-9);
    let best = fits(0) ? 0 : Number.NaN;
    if (Number.isNaN(best)) {
      for (const q of near) {
        const dy = Math.sqrt(Math.max(0, (q.r + r) ** 2 - (q.x - x) ** 2));
        for (const y of [q.y + dy, q.y - dy]) if (fits(y) && (Number.isNaN(best) || Math.abs(y) < Math.abs(best))) best = y;
      }
    }
    centres.push({ x, y: Number.isNaN(best) ? 0 : clamp(best, -limitY, limitY), r });
  }
  shown.forEach((e, i) => {
    const ce = centres[i]!;
    const row = p.index.convs.get(e.conv);
    const mark = i < 1500 ? b.mark({ x: ["conversation", row.id] }, row.title.trim() === "" ? row.id : row.title, e.items.length, { x0: ce.x - ce.r, y0: ce.y - ce.r, x1: ce.x + ce.r, y1: ce.y + ce.r }) : -1;
    fillDisc(b, e.items, ce.x, ce.y, ce.r, mark);
  });
  timeAxis(b, ts, -limitY - 0.3, limitY);
  const top = shown[0]!;
  const tc = centres[0]!;
  b.reading(
    makeReading({
      kind: "largest",
      copyKey: "readings.largest",
      values: { n: fmtCount(top.messages) },
      at: [tc.x, tc.y + tc.r + 0.14, 0],
      ref: { x: ["conversation", p.index.convs.get(top.conv).id] },
    }),
  );
  return b.finish(flatCamera());
}


// ───────────────────────────── balance ─────────────────────────────

/**
 * Two sides (CHART-33, the reference's Balance): per period, the two sides of a two-sided dimension (default you versus assistants; any
 * dimension with a chosen pair of values, `options.dim`, `sideA`, `sideB`). Centred diverging bars: side A grows
 * above the zero line and side B below it, both on one scale, particles filling each bar; a polyline follows the net
 * (A minus B) in the same scale. The Size control (Count · Words) is the measure. Reading: the period where the
 * gap was widest. The chart reports the dimension's values as its categories, which the page's pickers offer.
 */
/** The hatched strip under the cone of the Balance chart: short slanted strokes along the base, one every 0.17 units. */
export function hatchStrip(b: ChartBuilder, left: number, right: number, y0: number, y1: number): void {
  const step = 0.17;
  const slant = (y1 - y0) * 0.9;
  for (let x = left; x + slant <= right; x += step) b.line([x, y0, 0], [x + slant, y1, 0], 0.22);
}

export function layoutBalance(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, () => []);
  const PLOT = plotRect(p.stage);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  const dim = balanceDim(p.spec.options);
  const dv = dimOf(p, dim);
  const tally = new Float64Array(dv.keys.length);
  for (let i = 0; i < p.members.length; i++) {
    const code = dv.codes[p.members[i]!]!;
    if (code !== NO_CODE) tally[code]! += 1;
  }
  const values = dv.keys.map((key, code) => ({ key, label: dv.labels[code]!, count: tally[code]! })).filter((v) => v.count > 0);
  b.categories = [...values].sort((a, c) => c.count - a.count || a.key.localeCompare(c.key));
  const [ka, kb] = balanceSides(p.spec.options, dim, values);
  if (ka === null || kb === null) return b.finish(flatCamera());
  const labelOf = (k: string) => values.find((v) => v.key === k)?.label ?? k;
  const ts = timeSetup(p, null, PLOT.left, PLOT.right - 0.4);
  const B = ts.bins.count;
  const binOf = binsOfMembers(p, ts);
  const words = p.spec.size === "words";
  const c = p.index.cols;
  const sideA = new Float64Array(B);
  const sideB = new Float64Array(B);
  const itemsA = new Uint32Array(B);
  const itemsB = new Uint32Array(B);
  const cellOf = new Uint32Array(p.index.count).fill(NO_CODE);
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const bi = binOf[o]!;
    const code = dv.codes[o]!;
    if (bi < 0 || code === NO_CODE) continue;
    const key = dv.keys[code]!;
    const v = words ? c.words[o]! : 1;
    if (key === ka) {
      sideA[bi]! += v;
      itemsA[bi]! += 1;
      cellOf[o] = bi * 2;
    } else if (key === kb) {
      sideB[bi]! += v;
      itemsB[bi]! += 1;
      cellOf[o] = bi * 2 + 1;
    }
  }
  let peak = 0;
  for (let j = 0; j < B; j++) peak = Math.max(peak, sideA[j]!, sideB[j]!);
  if (peak <= 0) return b.finish(flatCamera());
  const H = (PLOT.top - PLOT.bottom) / 2.23;
  const zero = (PLOT.top + PLOT.bottom) / 2 - 0.35;
  const buckets = bucketise(p.members, cellOf, B * 2);
  const refA: ChartRef = { y: [dim, ka] };
  const refB: ChartRef = { y: [dim, kb] };
  let marks = 0;
  for (let j = 0; j < B; j++) {
    const tr: [number, number] = [ts.bins.edges[j]!, ts.bins.edges[j + 1]!];
    const x0 = ts.xOf(tr[0]);
    const x1 = ts.xOf(tr[1]);
    const gap = (x1 - x0) * 0.08;
    const up = (sideA[j]! / peak) * H;
    const down = (sideB[j]! / peak) * H;
    if (itemsA[j]! > 0) {
      const r: Rect2 = { x0: x0 + gap, y0: zero, x1: x1 - gap, y1: zero + Math.max(0.03, up) };
      const mark = marks < 8000 ? b.mark({ ...refA, t: tr }, ts.bins.label(j), itemsA[j]!, r) : -1;
      marks += 1;
      fillRect(b, buckets[j * 2]!, r, mark, 0.01);
    }
    if (itemsB[j]! > 0) {
      const r: Rect2 = { x0: x0 + gap, y0: zero - Math.max(0.03, down), x1: x1 - gap, y1: zero };
      const mark = marks < 8000 ? b.mark({ ...refB, t: tr }, ts.bins.label(j), itemsB[j]!, r) : -1;
      marks += 1;
      fillRect(b, buckets[j * 2 + 1]!, r, mark, 0.01);
    }
  }
  // The net line: A minus B per period, on the same scale as the bars, across the periods that have anything.
  const net: Vec3[] = [];
  for (let j = 0; j < B; j++) if (itemsA[j]! + itemsB[j]! > 0) net.push([binCentreX(ts, j), zero + ((sideA[j]! - sideB[j]!) / peak) * H, 0.05]);
  b.line([ts.left, zero, 0], [ts.right, zero, 0], 0.45, true);
  b.poly(net, 0.7);
  b.label([ts.left + 0.05, zero + H - 0.1, 0], labelOf(ka), "axis", "left", refA);
  b.label([ts.left + 0.05, zero - H + 0.1, 0], labelOf(kb), "axis", "left", refB);
  hatchStrip(b, ts.left, ts.right, zero - H - 0.18, zero - H - 0.05);
  timeAxis(b, ts, zero - H - 0.2, zero + H);
  // Reading: the period with the widest gap between the sides (periods under 10% of the median volume are ignored).
  const volumes = Array.from({ length: B }, (_, j) => sideA[j]! + sideB[j]!).filter((v) => v > 0).sort((x, y) => x - y);
  const median = volumes[Math.floor(volumes.length / 2)] ?? 0;
  let widest = -1;
  for (let j = 0; j < B; j++) {
    const v = sideA[j]! + sideB[j]!;
    if (v <= 0 || v < median * 0.1) continue;
    if (widest < 0 || Math.abs(sideA[j]! - sideB[j]!) > Math.abs(sideA[widest]! - sideB[widest]!)) widest = j;
  }
  if (widest >= 0) {
    const lead = sideA[widest]! >= sideB[widest]!;
    b.reading(
      makeReading({
        kind: "peak",
        copyKey: "readings.peak",
        values: { label: ts.bins.label(widest) },
        at: [binCentreX(ts, widest), zero + (lead ? (sideA[widest]! / peak) * H + 0.16 : -(sideB[widest]! / peak) * H - 0.16), 0],
        ref: { ...(lead ? refA : refB), t: [ts.bins.edges[widest]!, ts.bins.edges[widest + 1]!] },
      }),
    );
  }
  return b.finish(flatCamera());
}
