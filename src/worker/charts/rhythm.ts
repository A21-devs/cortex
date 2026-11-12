/**
 * Rhythm charts (CORTEX-UX §7.2). Owner: E9. Round charts: Horizontal runs around the circle, Vertical outward.
 *  radial-clock   — 24 hour sectors (00:00 at the top, clockwise) or 7 weekday sectors (Date ▸ Rhythm); one
 *                   concentric ring per category of the vertical zone; a particle clump per sector and ring sized
 *                   by count; reading: a callout at the peak hour, plus a peak tick on each ring;
 *  radial-heatmap — sectors for one dimension, rings for another, central hole 30%, particles fill each cell;
 *                   reading: the hottest cell outlined with its count (P2).
 * Rhythm grains always use the written date (an import time says nothing about when you work).
 */
import type { DimId } from "../../shared/dims";
import type { ArrangementResult, ChartSpec, Vec3 } from "../../shared/protocol/worker";
import {
  axisCategories,
  axisLabel,
  ChartBuilder,
  dimOf,
  emptyChart,
  fillDisc,
  flatCamera,
  NO_CODE,
  prepareChart,
  r2u,
  r2v,
  rnd,
  LABEL_MAX,
  THIN_GROUP,
  monthName,
  weekdayName,
  type CategorySet,
  type ChartContext,
  type ChartRef,
  type Prepared,
} from "./common";
import { labelColumns, labelWidth, oneColumnStride, type ChartStage } from "../../shared/chartStage";
import { DEFAULT_SERIES } from "../../shared/chartAxes";
import { fmtCount, makeReading, peakIndex } from "./readings";

const R_OUTER = 3.45;

/** Clock position: angle 0 at the top, clockwise. */
function polar(r: number, a: number, z = 0): Vec3 {
  return [r * Math.sin(a), r * Math.cos(a), z];
}

/** Rim labels longer than this many characters (dates) run along the spoke instead of standing level. */
const RIM_LEVEL_CHARS = 3;

/**
 * A label round the rim of a wheel at sector `s` of `S`. Short names (hours) stand level beside the rim; longer ones
 * (dates) run outward along the sector's spoke, turned to read upright on both halves of the wheel, so more of them
 * fit round the rim than level labels would.
 */
export function rimLabel(b: ChartBuilder, text: string, s: number, S: number, stage: ChartStage | undefined, ref: ChartRef): void {
  const a = ((s + 0.5) / S) * Math.PI * 2;
  if (text.length <= RIM_LEVEL_CHARS) {
    b.label(polar(R_OUTER + 0.3, a), text, "axis", "center", ref);
    return;
  }
  const deg = (a * 180) / Math.PI;
  const rotate = Math.round((deg > 180 ? deg - 270 : deg - 90) * 10) / 10;
  b.label(polar(R_OUTER + 0.18 + labelWidth(stage, text.length) / 2, a), text, "axis", "center", ref, rotate);
}

function circle(r: number, segments = 96): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= segments; i++) pts.push(polar(r, (i / segments) * Math.PI * 2));
  return pts;
}

interface Sectors {
  dim: DimId;
  count: number;
  /** Sector per ordinal (-1 = none). */
  of: Int32Array;
  key(i: number): string;
  label(i: number): string;
  cats: CategorySet | null;
}

/** Rhythm grains: sector count and the offset of their keys ("01".."12" and "1".."7" start at one). */
const RHYTHM_SECTORS: Readonly<Record<string, { n: number; base: number }>> = { hour: { n: 24, base: 0 }, weekday: { n: 7, base: 1 }, monthOfYear: { n: 12, base: 1 } };

/** The sector dimension a radial clock reads from its x axis: hour (default), weekday or month of the year. */
export function clockSectorDim(x: DimId): DimId {
  return x === "weekday" || x === "monthOfYear" ? x : "hour";
}

function rhythmKey(dim: DimId, i: number): string {
  return dim === "weekday" ? String(i + 1) : dim === "monthOfYear" ? String(i + 1).padStart(2, "0") : String(i).padStart(2, "0");
}

function rhythmLabel(dim: DimId, i: number): string {
  return dim === "weekday" ? weekdayName(i) : dim === "monthOfYear" ? monthName(i + 1) : `${String(i).padStart(2, "0")}:00`;
}

/** Hour (24), weekday (7) or month-of-year (12) sectors in clock order, or the categories of any other dimension. */
function sectorsOf(p: Prepared, dim: DimId, cap: number): Sectors {
  const of = new Int32Array(p.index.count).fill(-1);
  const rhythm = RHYTHM_SECTORS[dim];
  if (rhythm) {
    const dv = dimOf(p, dim);
    const parsed = dv.keys.map((k) => Number.parseInt(k, 10) - rhythm.base);
    for (let i = 0; i < p.members.length; i++) {
      const o = p.members[i]!;
      const code = dv.codes[o]!;
      if (code !== NO_CODE) of[o] = parsed[code]!;
    }
    return { dim, count: rhythm.n, of, key: (i) => rhythmKey(dim, i), label: (i) => rhythmLabel(dim, i), cats: null };
  }
  const cats = axisCategories(p, dim, p.spec.x.sort, true, { cap });
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const c = cats.of[o]!;
    if (c !== NO_CODE) of[o] = c;
  }
  return { dim, count: cats.list.length, of, key: (i) => cats.list[i]?.key ?? "", label: (i) => cats.list[i]?.label ?? "", cats };
}

/**
 * The dimension that gives the clock its rings: the vertical zone, else the colour, else (for the clock) the area, so a
 * fresh clock has one ring per area and not one lump. The heatmap has no such default.
 */
const ringDimOf = (s: ChartSpec, sector: DimId): DimId | null => {
  const d = s.y?.dim ?? s.colour ?? (s.chart === "radial-clock" ? DEFAULT_SERIES["radial-clock"]! : null);
  return d && d !== sector ? d : null;
};

/** World spacing between two neighbouring hour labels round the rim of the clock (they sit just outside the outer ring). */
const HOUR_ARC = (Math.PI * 2 * (R_OUTER + 0.3)) / 24;

/** Every how-many-th hour carries a label: every hour while the stage has room for them, else every third. */
export function clockLabelStride(stage: ChartStage | undefined, sectors: number): number {
  if (sectors <= 12) return 1;
  return oneColumnStride(stage, HOUR_ARC) <= 1 ? 1 : 3;
}

// ───────────────────────────── radial clock ─────────────────────────────

export function layoutRadialClock(ctx: ChartContext): ArrangementResult {
  const sectorDim = (s: ChartSpec): DimId => clockSectorDim(s.x.dim);
  const p = prepareChart(ctx, (s) => {
    const r = ringDimOf(s, sectorDim(s));
    return r ? [sectorDim(s), r] : [sectorDim(s)];
  });
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  const sd = sectorDim(p.spec);
  const sectors = sectorsOf(p, sd, 24);
  const rd = ringDimOf(p.spec, sd);
  const rings = rd && p.spec.y && p.spec.y.dim === rd ? axisCategories(p, rd, p.spec.y.sort, false, { cap: 10 }) : rd ? axisCategories(p, rd, "count", false, { cap: 10 }) : null;
  if (rings) b.categories = rings.all;
  const S = sectors.count;
  const K = rings ? rings.list.length : 1;
  const r0 = 0.55;
  const w = (R_OUTER - r0) / K;
  const cells = new Map<number, number[]>();
  const totals = new Float64Array(S);
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const s = sectors.of[o]!;
    const k = rings ? rings.of[o]! : 0;
    if (s < 0 || k === NO_CODE) continue;
    const key = k * S + s;
    const list = cells.get(key);
    if (list) list.push(o);
    else cells.set(key, [o]);
    totals[s]! += 1;
  }
  let maxC = 0;
  for (const list of cells.values()) maxC = Math.max(maxC, list.length);
  const ringPeak = new Int32Array(K).fill(-1);
  const ringPeakCount = new Float64Array(K);
  for (const [key, list] of cells) {
    const k = Math.floor(key / S);
    const s = key % S;
    const a = ((s + 0.5) / S) * Math.PI * 2;
    const rc = r0 + (k + 0.5) * w;
    const arc = (rc * Math.PI * 2) / S;
    const cr = Math.min(w, arc) * 0.46 * Math.max(0.28, Math.sqrt(list.length / Math.max(1, maxC)));
    const [cx, cy] = polar(rc, a);
    const ref: ChartRef = { x: [sd, sectors.key(s)] };
    if (rings && rd) ref.y = [rd, rings.list[k]!.key];
    const label = rings ? `${sectors.label(s)} · ${rings.list[k]!.label}` : sectors.label(s);
    const mark = b.mark(ref, label, list.length, { x0: cx - cr, y0: cy - cr, x1: cx + cr, y1: cy + cr });
    fillDisc(b, list, cx, cy, cr, mark);
    if (list.length > ringPeakCount[k]!) {
      ringPeakCount[k] = list.length;
      ringPeak[k] = s;
    }
  }
  for (let k = 0; k <= K; k++) b.poly(circle(r0 + k * w), k === 0 || k === K ? 0.3 : 0.12, true);
  const hourStride = clockLabelStride(p.stage, S);
  for (let s = 0; s < S; s++) {
    const a = (s / S) * Math.PI * 2;
    b.line(polar(r0, a), polar(R_OUTER, a), 0.06);
    if (s % hourStride === 0) rimLabel(b, sd === "hour" && hourStride > 1 ? sectors.key(s) : sectors.label(s), s, S, p.stage, { x: [sd, sectors.key(s)] });
  }
  // The pointer tick marks 00:00 (the top), where the ring names run up their spoke.
  b.line(polar(R_OUTER + 0.03, 0, 0.05), polar(R_OUTER + 0.22, 0, 0.05), 0.9);
  if (rings && rd) {
    // The ring names stand along one spoke, one per ring by radius; a crowded wheel on a wide stage staggers them on both sides.
    const two = labelColumns(p.stage) === 2 && K > 6;
    b.line(polar(r0, 0, 0.05), polar(R_OUTER, 0, 0.05), 0.3, true);
    rings.list.forEach((c, k) => {
      const right = two && k % 2 === 1;
      b.label([right ? 0.07 : -0.07, r0 + (k + 0.5) * w, 0.05], axisLabel(c.label, two ? 12 : LABEL_MAX), "muted", right ? "left" : "right", { y: [rd, c.key] });
      if (c.count < THIN_GROUP) b.thin(c.key, c.count);
    });
  }
  for (let k = 0; k < K; k++) {
    const s = ringPeak[k]!;
    if (s < 0 || K === 1) continue;
    const a = ((s + 0.5) / S) * Math.PI * 2;
    b.line(polar(r0 + k * w + w * 0.08, a, 0.05), polar(r0 + (k + 1) * w - w * 0.08, a, 0.05), 0.85);
  }
  const peak = peakIndex(totals);
  if (peak >= 0) {
    const a = ((peak + 0.5) / S) * Math.PI * 2;
    b.reading(
      makeReading({
        kind: "peak",
        copyKey: "readings.peak",
        values: { label: sectors.label(peak), n: fmtCount(totals[peak]!) },
        at: polar(R_OUTER + 0.62, a),
        ref: { x: [sd, sectors.key(peak)] },
      }),
    );
  }
  return b.finish(flatCamera());
}

// ───────────────────────────── radial heatmap ─────────────────────────────

/** The rings end at this share of the wheel's radius when it has rings; the wedges' crown takes the rest. */
export const WHEEL_RINGS_END = 0.78;
/** Gap between the last ring and the crown (world units). */
export const WHEEL_GAP = 0.1;

/**
 * The wedges' own ring around the rings: one wedge per sector (the x values), a bar in it growing outward with the
 * wedge's total, and a hit region so hovering or clicking a wedge speaks for the whole sector.
 */
function wheelCrown(b: ChartBuilder, totals: Float64Array, S: number, xd: DimId, sectors: Sectors, rA: number, rB: number): void {
  const da = (Math.PI * 2) / S;
  let max = 0;
  for (let s = 0; s < S; s++) max = Math.max(max, totals[s]!);
  b.poly(circle(rA), 0.14, true);
  b.poly(circle(rB), 0.3, true);
  if (max <= 0) return;
  const half = (rB - rA) / 2;
  for (let s = 0; s < S; s++) {
    const n = totals[s]!;
    if (n <= 0) continue;
    const a0 = s * da + da * 0.06;
    const a1 = (s + 1) * da - da * 0.06;
    const rBar = rA + (rB - rA) * (0.18 + 0.82 * (n / max));
    const edge: Vec3[] = [];
    for (let q = 0; q <= 6; q++) edge.push(polar(rA, a0 + (q / 6) * (a1 - a0), 0.03));
    for (let q = 6; q >= 0; q--) edge.push(polar(rBar, a0 + (q / 6) * (a1 - a0), 0.03));
    b.poly(edge, 0.55, true);
    const [cx, cy] = polar((rA + rB) / 2, (a0 + a1) / 2);
    const reach = Math.min(half, (rA + rB) * 0.5 * (a1 - a0) * 0.5);
    b.mark({ x: [xd, sectors.key(s)] }, sectors.label(s), n, { x0: cx - reach, y0: cy - reach, x1: cx + reach, y1: cy + reach });
  }
}

export function layoutRadialHeatmap(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, (s) => (s.y ? [s.x.dim, s.y.dim] : [s.x.dim]));
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  const xd = p.spec.x.dim;
  const sectors = sectorsOf(p, xd, 36);
  const rd = p.spec.y && p.spec.y.dim !== xd ? p.spec.y.dim : null;
  const rings = rd && p.spec.y ? axisCategories(p, rd, p.spec.y.sort, false, { cap: 12 }) : null;
  if (sectors.cats) b.categories = sectors.cats.all;
  const S = sectors.count;
  const K = rings ? rings.list.length : 1;
  if (S === 0) return b.finish(flatCamera());
  // With rings the wheel splits (CHART-13): the rings take the inner part, the wedges a crown of their own outside them.
  const r0 = R_OUTER * 0.3;
  const rIn = rings ? R_OUTER * WHEEL_RINGS_END : R_OUTER;
  const w = (rIn - r0) / K;
  const cells = new Map<number, number[]>();
  const wedgeTotal = new Float64Array(S);
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const s = sectors.of[o]!;
    const k = rings ? rings.of[o]! : 0;
    if (s < 0 || k === NO_CODE) continue;
    const key = k * S + s;
    const list = cells.get(key);
    if (list) list.push(o);
    else cells.set(key, [o]);
    wedgeTotal[s]! += 1;
  }
  const da = (Math.PI * 2) / S;
  let hottest = -1;
  let hottestCount = 0;
  for (const [key, list] of cells) {
    const k = Math.floor(key / S);
    const s = key % S;
    const ra = r0 + k * w + w * 0.04;
    const rb = r0 + (k + 1) * w - w * 0.04;
    const a0 = s * da + da * 0.04;
    const a1 = (s + 1) * da - da * 0.04;
    const [cx, cy] = polar((ra + rb) / 2, (a0 + a1) / 2);
    const half = Math.min((rb - ra) / 2, ((ra + rb) / 2) * (a1 - a0) * 0.5);
    const ref: ChartRef = { x: [xd, sectors.key(s)] };
    if (rings && rd) ref.y = [rd, rings.list[k]!.key];
    const mark = b.mark(ref, rings ? `${sectors.label(s)} · ${rings.list[k]!.label}` : sectors.label(s), list.length, { x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half });
    for (let q = 0; q < list.length; q++) {
      const o = list[q]!;
      const r = Math.sqrt(ra * ra + r2u(q) * (rb * rb - ra * ra));
      const a = a0 + (r2v(q) + (rnd(p, o, 21) - 0.5) * 0.02) * (a1 - a0);
      const [x, y] = polar(r, a);
      b.flat(o, x, y, mark);
    }
    if (list.length > hottestCount) {
      hottestCount = list.length;
      hottest = key;
    }
  }
  for (let k = 0; k <= K; k++) b.poly(circle(r0 + k * w), k === 0 || k === K ? 0.3 : 0.1, true);
  const stride = Math.max(1, Math.ceil(S / 24));
  for (let s = 0; s < S; s++) {
    b.line(polar(r0, s * da), polar(R_OUTER, s * da), 0.07);
    if (s % stride === 0) rimLabel(b, axisLabel(xd === "hour" ? sectors.key(s) : sectors.label(s), 14), s, S, p.stage, { x: [xd, sectors.key(s)] });
  }
  if (rings) wheelCrown(b, wedgeTotal, S, xd, sectors, rIn + WHEEL_GAP, R_OUTER);
  sectors.cats?.list.forEach((c) => {
    if (c.count < THIN_GROUP) b.thin(c.key, c.count);
  });
  // Ring names run up the top spoke, one per ring, stacked by radius; the tick above the rim marks where the spoke is.
  if (rings && rd) {
    const two = labelColumns(p.stage) === 2 && K > 6;
    b.line(polar(r0, 0, 0.05), polar(rIn, 0, 0.05), 0.3, true);
    rings.list.forEach((c, k) => {
      const right = two && k % 2 === 1;
      b.label([right ? 0.07 : -0.07, r0 + (k + 0.5) * w, 0.05], axisLabel(c.label, two ? 12 : LABEL_MAX), "muted", right ? "left" : "right", { y: [rd, c.key] });
    });
  }
  b.line(polar(R_OUTER + 0.03, 0, 0.05), polar(R_OUTER + 0.22, 0, 0.05), 0.9);
  if (hottest >= 0) {
    const k = Math.floor(hottest / S);
    const s = hottest % S;
    const ra = r0 + k * w;
    const rb = r0 + (k + 1) * w;
    const outline: Vec3[] = [];
    for (let q = 0; q <= 12; q++) outline.push(polar(ra, s * da + (q / 12) * da, 0.05));
    for (let q = 12; q >= 0; q--) outline.push(polar(rb, s * da + (q / 12) * da, 0.05));
    b.poly(outline, 0.95, true);
    const ref: ChartRef = { x: [xd, sectors.key(s)] };
    if (rings && rd) ref.y = [rd, rings.list[k]!.key];
    b.reading(
      makeReading({
        kind: "largest",
        copyKey: "readings.largest",
        values: { n: fmtCount(hottestCount) },
        at: polar(rb + 0.2, (s + 0.5) * da, 0.05),
        ref,
      }),
    );
  }
  return b.finish(flatCamera());
}
