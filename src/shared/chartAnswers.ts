/**
 * The question line and the one-line answer each chart shows in its panel (TB-18). Pure: the worker's result in, copy
 * keys and values out; `ui/stage/Answers.ts` renders them through `t()`, so every word lives in ui/copy.ts.
 *
 * The question is a short italic line naming what the chart answers ("Which folder holds the most?"). The answer is
 * computed from the data on screen: a count and share for the leading value, the longest run of days, the busiest
 * period, the lane that lasted longest, how often one side led. A chart with nothing placed has no answer (null).
 * These sit beside the readings (≤ 3 numbers drawn on the chart), they do not replace them.
 */
import { balanceDim, balanceSides } from "./balance";
import type { DimId } from "./dims";
import type { ChartId } from "./views";

export interface AnswerCategory {
  key: string;
  label: string;
  count: number;
}

export interface AnswerMark {
  label: string;
  count: number;
  /** The mark's ref, JSON as the worker wrote it (`ChartRef`). */
  key: string;
}

export interface AnswerInput {
  chart: ChartId;
  x: DimId;
  y: DimId | null;
  colour: DimId | null;
  options: Readonly<Record<string, unknown>>;
  /** Value categories the chart reported (largest first, before Top N folds). */
  categories: readonly AnswerCategory[];
  marks: readonly AnswerMark[];
  /** Items placed on the chart. */
  placed: number;
  /** Display name of a value of a dimension. */
  name(dim: DimId, key: string, fallback: string): string;
  /** Display name of a dimension, lower case ("folder"). */
  dimName(dim: DimId): string;
  /** A period [from, to) as words. */
  period(from: number, to: number): string;
  /** A length of time in days as words ("3 months"); a plain count of days when left out. */
  span?(days: number): string;
}

/** A copy key under `answers.` and the values that fill it. */
export interface AnswerLine {
  key: string;
  values: Record<string, string | number>;
}

export interface ChartAnswer {
  question: AnswerLine;
  answer: AnswerLine | null;
}

const OTHER = "__other__";
const DAY = 86_400_000;

const num = (n: number): string => Math.round(n).toLocaleString("en-GB");

/** "23%", or "<1%" for a small non-zero share. */
export function shareText(part: number, whole: number): string {
  if (!(whole > 0) || !(part > 0)) return "0%";
  const v = Math.round((Math.min(part, whole) / whole) * 100);
  return v === 0 ? "<1%" : `${v}%`;
}

interface Ref {
  x?: [DimId, string];
  y?: [DimId, string];
  or?: unknown;
  t?: [number, number];
  span?: [number, number];
  life?: [number, number];
  curve?: [number, number];
}

function parseRef(json: string): Ref {
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === "object" ? (v as Ref) : {};
  } catch {
    return {};
  }
}

const isPair = (v: unknown): v is [DimId, string] => Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string";
const isRange = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]);

/** Local calendar day number of an instant that is a local midnight. */
export function dayNumber(ms: number): number {
  return Math.round((ms - new Date(ms).getTimezoneOffset() * 60_000) / DAY);
}

/** Longest run of consecutive day numbers in an ascending list; length 0 when empty. */
export function longestDayRun(days: readonly number[]): number {
  let best = 0;
  let len = 0;
  let prev = Number.NaN;
  for (const d of days) {
    if (!Number.isFinite(d) || d === prev) continue;
    len = Number.isFinite(prev) && d === prev + 1 ? len + 1 : 1;
    best = Math.max(best, len);
    prev = d;
  }
  return best;
}

const line = (key: string, values: Record<string, string | number> = {}): AnswerLine => ({ key, values });

// ───────────────────────────── questions ─────────────────────────────

/** The italic question line of a chart. */
export function questionFor(i: AnswerInput): AnswerLine {
  const x = i.dimName(i.x);
  const y = i.y ? i.dimName(i.y) : "";
  const series = i.dimName(seriesDim(i) ?? i.x);
  switch (i.chart) {
    case "ranked-bars":
      return line("answers.q.rankedBars", { x });
    case "matrix":
      return y ? line("answers.q.matrix", { x, y }) : line("answers.q.rankedBars", { x });
    case "treemap":
      return line("answers.q.treemap", { x });
    case "icicle":
      return line("answers.q.icicle", { x });
    case "bubble-pack":
      return line("answers.q.bubblePack", { x });
    case "nested-bubbles":
      return y ? line("answers.q.nestedBubbles", { x, y }) : line("answers.q.treemap", { x });
    case "stream":
      return line("answers.q.stream", { series });
    case "bands":
      return line("answers.q.bands", { series });
    case "ridgeline":
      return line("answers.q.ridgeline", { series });
    case "calendar-heatmap":
      return line("answers.q.calendar");
    case "timeline-lanes":
      return line("answers.q.lanes", { series });
    case "arc-diagram":
      return line("answers.q.arcs", { series });
    case "diverging-area":
      return line("answers.q.diverging");
    case "two-sides":
      return line("answers.q.balance");
    case "beeswarm":
      return line("answers.q.beeswarm");
    case "radial-clock":
      return line("answers.q.clock", { x });
    case "radial-heatmap":
      return y ? line("answers.q.radialHeatmap", { x, y }) : line("answers.q.clock", { x });
    case "alluvial":
      return y ? line("answers.q.alluvial", { x, y }) : line("answers.q.rankedBars", { x });
    case "chord":
      return line("answers.q.chord", { x });
    case "clusters-3d":
      return line("answers.q.clusters");
  }
}

/** The dimension a time chart's series (bands, rows, lanes) run along: the first mark's own, else the axes. */
function seriesDim(i: AnswerInput): DimId | null {
  for (const m of i.marks) {
    const r = parseRef(m.key);
    const pair = isPair(r.y) ? r.y : isPair(r.x) ? r.x : null;
    if (pair) return pair[0];
  }
  return i.y ?? i.colour;
}

// ───────────────────────────── answers ─────────────────────────────

function topCategory(i: AnswerInput, dim: DimId = i.x): AnswerLine | null {
  const real = i.categories.filter((c) => c.key !== OTHER && c.count > 0);
  const pool = real.filter((c) => c.key !== "");
  const list = pool.length > 0 ? pool : real;
  let top: AnswerCategory | null = null;
  for (const c of list) if (!top || c.count > top.count) top = c;
  if (!top) return null;
  const total = Math.max(i.placed, top.count);
  return line("answers.a.top", { name: i.name(dim, top.key, top.label), n: num(top.count), total: num(total), share: shareText(top.count, total) });
}

function topMark(i: AnswerInput): AnswerLine | null {
  let marks = i.marks.filter((m) => m.count > 0);
  // Alluvial: the flows between the two sides (both zones in the ref), not the side bands; chord: the ribbons between two.
  const flows = marks.filter((m) => {
    const r = parseRef(m.key);
    return i.chart === "chord" ? Array.isArray(r.or) : isPair(r.x) && isPair(r.y);
  });
  if ((i.chart === "alluvial" || i.chart === "chord") && flows.length > 0) marks = flows;
  let top: AnswerMark | null = null;
  for (const m of marks) if (!top || m.count > top.count) top = m;
  if (!top) return null;
  const total = Math.max(i.placed, top.count);
  // A mark that carries no label of its own (a matrix column) is named from the value its ref points at.
  const r = parseRef(top.key);
  const pair = isPair(r.x) ? r.x : isPair(r.y) ? r.y : null;
  const name = top.label.trim() !== "" ? top.label : pair ? i.name(pair[0], pair[1], pair[1]) : "";
  if (name.trim() === "") return topCategory(i);
  return line("answers.a.top", { name, n: num(top.count), total: num(total), share: shareText(top.count, total) });
}

/**
 * Who led at first and who by the end: the series with the most entries in the first third of the periods against the
 * one with the most in the last third. Null when the marks carry no series or there are fewer than two periods.
 */
function ledAnswer(i: AnswerInput): AnswerLine | null {
  const perBin = new Map<number, Map<string, number>>();
  const named = new Map<string, { dim: DimId; key: string; label: string }>();
  for (const m of i.marks) {
    const r = parseRef(m.key);
    const pair = isPair(r.y) ? r.y : isPair(r.x) ? r.x : null;
    if (!pair || !isRange(r.t) || !(m.count > 0)) continue;
    const id = `${pair[0]}|${pair[1]}`;
    named.set(id, { dim: pair[0], key: pair[1], label: m.label });
    const at = perBin.get(r.t[0]) ?? new Map<string, number>();
    at.set(id, (at.get(id) ?? 0) + m.count);
    perBin.set(r.t[0], at);
  }
  const starts = [...perBin.keys()].sort((a, b) => a - b);
  if (starts.length < 2) return null;
  const third = Math.max(1, Math.floor(starts.length / 3));
  const leader = (bins: readonly number[]): string | null => {
    const sum = new Map<string, number>();
    for (const t of bins) for (const [id, n] of perBin.get(t)!) sum.set(id, (sum.get(id) ?? 0) + n);
    let best: string | null = null;
    for (const [id, n] of sum) if (best === null || n > sum.get(best)! || (n === sum.get(best)! && id < best)) best = id;
    return best;
  };
  const first = leader(starts.slice(0, third));
  const last = leader(starts.slice(starts.length - third));
  if (first === null || last === null) return null;
  const nameOf = (id: string): string => {
    const v = named.get(id)!;
    return i.name(v.dim, v.key, v.label);
  };
  return first === last ? line("answers.a.ledThroughout", { a: nameOf(first) }) : line("answers.a.led", { a: nameOf(first), b: nameOf(last) });
}

/** Alluvial: the strongest single flow, from one side to the other. */
function flowAnswer(i: AnswerInput): AnswerLine | null {
  let top: { from: [DimId, string]; to: [DimId, string]; n: number } | null = null;
  for (const m of i.marks) {
    const r = parseRef(m.key);
    if (!isPair(r.x) || !isPair(r.y) || !(m.count > 0)) continue;
    if (!top || m.count > top.n) top = { from: r.x, to: r.y, n: m.count };
  }
  if (!top) return null;
  const total = Math.max(i.placed, top.n);
  return line("answers.a.flow", { from: i.name(top.from[0], top.from[1], top.from[1]), to: i.name(top.to[0], top.to[1], top.to[1]), n: num(top.n), total: num(total), share: shareText(top.n, total) });
}

/** The clock: the busiest sector, and the ring whose entries gather most at some other sector. */
function clockAnswer(i: AnswerInput): AnswerLine | null {
  const sector = new Map<string, { label: string; n: number }>();
  const rings = new Map<string, { dim: DimId; key: string; label: string; total: number; at: Map<string, { label: string; n: number }> }>();
  for (const m of i.marks) {
    const r = parseRef(m.key);
    if (!isPair(r.x) || !(m.count > 0)) continue;
    const [sectorLabel, ...rest] = m.label.split(" · ");
    const sk = r.x[1];
    const cur = sector.get(sk) ?? { label: sectorLabel!, n: 0 };
    cur.n += m.count;
    sector.set(sk, cur);
    if (!isPair(r.y)) continue;
    const ring = rings.get(r.y[1]) ?? { dim: r.y[0], key: r.y[1], label: rest.join(" · "), total: 0, at: new Map() };
    ring.total += m.count;
    const here = ring.at.get(sk) ?? { label: sectorLabel!, n: 0 };
    here.n += m.count;
    ring.at.set(sk, here);
    rings.set(r.y[1], ring);
  }
  let peak: string | null = null;
  for (const [k, v] of sector) if (peak === null || v.n > sector.get(peak)!.n || (v.n === sector.get(peak)!.n && k < peak)) peak = k;
  if (peak === null) return null;
  // The ring most concentrated in one sector other than the busiest: the share of its own entries in that sector.
  let odd: { ring: { dim: DimId; key: string; label: string }; at: string; share: number } | null = null;
  for (const ring of rings.values()) {
    // The "no value" ring is not a series of its own to name.
    if (ring.total < 3 || ring.key === "") continue;
    let at: string | null = null;
    for (const [k, v] of ring.at) if (at === null || v.n > ring.at.get(at)!.n || (v.n === ring.at.get(at)!.n && k < at)) at = k;
    if (at === null || at === peak) continue;
    const share = ring.at.get(at)!.n / ring.total;
    if (!odd || share > odd.share) odd = { ring, at: ring.at.get(at)!.label, share };
  }
  const top = sector.get(peak)!;
  if (odd) return line("answers.a.clock", { label: top.label, name: i.name(odd.ring.dim, odd.ring.key, odd.ring.label), at: odd.at });
  const total = Math.max(i.placed, top.n);
  return line("answers.a.clockOne", { label: top.label, n: num(top.n), total: num(total) });
}

const spanWords = (i: AnswerInput, days: number): string => (i.span ? i.span(days) : `${Math.round(days)} days`);

/** The arc diagram: how many times a series came back after a quiet spell and the usual length of the spell. */
function returnsAnswer(i: AnswerInput): AnswerLine | null {
  const rows = new Map<string, [number, number][]>();
  for (const m of i.marks) {
    const r = parseRef(m.key);
    const pair = isPair(r.y) ? r.y : isPair(r.x) ? r.x : null;
    if (!pair || !isRange(r.t) || !(m.count > 0)) continue;
    const list = rows.get(pair[1]) ?? [];
    list.push(r.t);
    rows.set(pair[1], list);
  }
  const gaps: number[] = [];
  for (const list of rows.values()) {
    list.sort((a, b) => a[0] - b[0]);
    for (let k = 1; k < list.length; k++) gaps.push(Math.max(0, (list[k]![0] - (list[k - 1]![1] - 1)) / DAY));
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const median = gaps.length % 2 === 1 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
  const gap = spanWords(i, median);
  return gaps.length === 1 ? line("answers.a.returnsOne", { gap }) : line("answers.a.returns", { n: num(gaps.length), gap });
}

/** Lifelines Curve: the series whose lives hold on longest and how long half of them last. */
function curveAnswer(i: AnswerInput): AnswerLine | null {
  const half = new Map<string, { dim: DimId; key: string; label: string; days: number }>();
  for (const m of i.marks) {
    const r = parseRef(m.key);
    const pair = isPair(r.y) ? r.y : isPair(r.x) ? r.x : null;
    if (!pair || !isRange(r.curve)) continue;
    const id = `${pair[0]}|${pair[1]}`;
    const cur = half.get(id) ?? { dim: pair[0], key: pair[1], label: m.label, days: 0 };
    // Half of the lives last at least as long as the furthest slice that still holds half of them.
    if (r.curve[0] >= 50) cur.days = Math.max(cur.days, r.curve[1]);
    half.set(id, cur);
  }
  let best: { dim: DimId; key: string; label: string; days: number } | null = null;
  // A series that has a name beats the "no value" one, then the longer wins.
  for (const v of half.values()) if (!best || (v.key !== "" && best.key === "") || ((v.key === "") === (best.key === "") && v.days > best.days)) best = v;
  if (!best) return null;
  const name = i.name(best.dim, best.key, best.label);
  if (best.days < 1) return line("answers.a.curveShort", { name });
  return line(half.size > 1 ? "answers.a.curve" : "answers.a.curveOne", { name, span: spanWords(i, best.days) });
}

function streamAnswer(i: AnswerInput): AnswerLine | null {
  const led = ledAnswer(i);
  if (led) return led;
  const lead = topCategory(i, seriesDim(i) ?? i.x);
  if (!lead) return null;
  const perBin = new Map<number, { n: number; to: number }>();
  for (const m of i.marks) {
    const r = parseRef(m.key);
    if (!isRange(r.t)) continue;
    const cur = perBin.get(r.t[0]) ?? { n: 0, to: r.t[1] };
    cur.n += m.count;
    perBin.set(r.t[0], cur);
  }
  let best: { from: number; n: number; to: number } | null = null;
  for (const [from, v] of perBin) if (!best || v.n > best.n) best = { from, n: v.n, to: v.to };
  if (!best) return lead;
  return line("answers.a.topPeriod", { name: lead.values.name!, n: lead.values.n!, label: i.period(best.from, best.to), m: num(best.n) });
}

function calendarAnswer(i: AnswerInput): AnswerLine | null {
  const days: { day: number; n: number; from: number; to: number }[] = [];
  for (const m of i.marks) {
    const r = parseRef(m.key);
    if (m.count > 0 && isRange(r.t)) days.push({ day: dayNumber(r.t[0]), n: m.count, from: r.t[0], to: r.t[1] });
  }
  if (days.length === 0) return null;
  days.sort((a, b) => a.day - b.day);
  const run = longestDayRun(days.map((d) => d.day));
  let busiest = days[0]!;
  for (const d of days) if (d.n > busiest.n) busiest = d;
  const values = { days: num(days.length), run, label: i.period(busiest.from, busiest.to), n: num(busiest.n) };
  return run >= 2 ? line("answers.a.days", values) : line("answers.a.daysOne", values);
}

function lanesAnswer(i: AnswerInput): AnswerLine | null {
  if (i.marks.some((m) => isRange(parseRef(m.key).curve))) return curveAnswer(i);
  let longest: { label: string; span: number; dim: DimId; key: string } | null = null;
  let lanes = 0;
  let going = 0;
  let known = 0;
  for (const m of i.marks) {
    const r = parseRef(m.key);
    if (!isRange(r.span)) continue;
    lanes += 1;
    if (isRange(r.life)) {
      known += 1;
      if (r.life[1] === 1) going += 1;
    }
    const span = Math.max(1, Math.round((r.span[1] - r.span[0]) / DAY) + 1);
    const pair = isPair(r.y) ? r.y : isPair(r.x) ? r.x : null;
    // A lane that has a name beats the "no value" lane, then the longer wins.
    if (pair && (!longest || (pair[1] !== "" && longest.key === "") || ((pair[1] === "") === (longest.key === "") && span > longest.span))) longest = { label: m.label, span, dim: pair[0], key: pair[1] };
  }
  if (!longest) return null;
  const values = { k: num(lanes), name: i.name(longest.dim, longest.key, longest.label), days: num(longest.span) };
  if (known === 0 || known < lanes) return line("answers.a.lanes", values);
  const withShare = { ...values, going: num(going), share: shareText(going, lanes) };
  if (going === lanes) return line("answers.a.lanesAll", withShare);
  if (going === 0) return line("answers.a.lanesNone", withShare);
  return line(going * 2 > lanes ? "answers.a.lanesMost" : "answers.a.lanesSome", withShare);
}

function sidesAnswer(i: AnswerInput): AnswerLine | null {
  const totals = new Map<string, number>();
  const dims = new Map<string, DimId>();
  const periods = new Map<number, Map<string, number>>();
  for (const m of i.marks) {
    const r = parseRef(m.key);
    if (!isPair(r.y) || !isRange(r.t) || !(m.count > 0)) continue;
    totals.set(r.y[1], (totals.get(r.y[1]) ?? 0) + m.count);
    dims.set(r.y[1], r.y[0]);
    const at = periods.get(r.t[0]) ?? new Map<string, number>();
    at.set(r.y[1], (at.get(r.y[1]) ?? 0) + m.count);
    periods.set(r.t[0], at);
  }
  if (totals.size === 0) return null;
  const ranked = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)! || a.localeCompare(b));
  let [a, b] = [ranked[0]!, ranked[1] ?? null] as [string, string | null];
  if (i.chart === "two-sides") {
    const dim = balanceDim(i.options);
    const sides = balanceSides(i.options, dim, [...totals.keys()].map((key) => ({ key, count: totals.get(key)! })));
    if (sides[0] !== null && totals.has(sides[0])) a = sides[0];
    if (sides[1] !== null && totals.has(sides[1]) && sides[1] !== a) b = sides[1];
    else if (b === a) b = ranked.find((k) => k !== a) ?? null;
  } else if (b === "you") [a, b] = [b, a];
  if (b === null) return null;
  let ahead = 0;
  for (const at of periods.values()) if ((at.get(a) ?? 0) > (at.get(b) ?? 0)) ahead += 1;
  const dim = dims.get(a)!;
  return line("answers.a.sides", { a: i.name(dim, a, a), na: num(totals.get(a)!), b: i.name(dims.get(b) ?? dim, b, b), nb: num(totals.get(b)!), k: ahead, m: periods.size });
}

/** The one-line answer computed from what the chart shows; null when there is nothing to say. */
export function answerFor(i: AnswerInput): AnswerLine | null {
  if (i.placed <= 0) return null;
  switch (i.chart) {
    case "ranked-bars":
    case "treemap":
    case "icicle":
    case "bubble-pack":
    case "nested-bubbles":
      return topCategory(i) ?? topMark(i);
    case "arc-diagram":
      return returnsAnswer(i) ?? topMark(i) ?? topCategory(i);
    case "radial-clock":
      return clockAnswer(i) ?? topMark(i) ?? topCategory(i);
    case "alluvial":
      return flowAnswer(i) ?? topMark(i) ?? topCategory(i);
    case "matrix":
    case "radial-heatmap":
    case "chord":
    case "clusters-3d":
    case "beeswarm":
      return topMark(i) ?? topCategory(i);
    case "stream":
    case "bands":
    case "ridgeline":
      return streamAnswer(i);
    case "calendar-heatmap":
      return calendarAnswer(i);
    case "timeline-lanes":
      return lanesAnswer(i);
    case "diverging-area":
    case "two-sides":
      return sidesAnswer(i);
  }
}

/** Question and answer of a chart. */
export function buildAnswer(i: AnswerInput): ChartAnswer {
  return { question: questionFor(i), answer: answerFor(i) };
}
