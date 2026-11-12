/**
 * Aggregations for the strip, the Time page (unrolled spine, rhythm grid, hours, voices), the Data view, Read
 * rows, Sources, Today and the packs table (StatsParams kinds; CORTEX-UX §12.17). Owner: E9. Runs in the worker
 * so pages never loop over 300k items on the UI thread.
 *
 * Shared rules:
 *  - visibility (Layers, scope, held arrivals) applies everywhere it is passed; reference material, subagent,
 *    automated and Ask traffic count only when their Layers toggle is on (H3); excluded items never count;
 *  - the period limits rhythm, hours, voices, data and read; the strip and the unrolled spine always span the whole
 *    record because their brushes draw the period over it; Sources is an inventory (period and scope ignored);
 *  - dates are bucketed in the local calendar (the worker runs in Obsidian's time zone);
 *  - τ (spine position) is the cord's: τ = 0.06 + 0.88 × (0.65 r + 0.35 ℓ) over dated record entries (§6.3).
 */
import { CortexError } from "../shared/errors";
import {
  ItemFlag,
  ItemKind,
  NONE32,
  NOTE_KIND_ORDER,
  Population,
  SOURCE_ORDER,
  SPACE_ORDER,
  SPEAKER_ORDER,
  type DataIndex,
} from "../shared/index-format";
import { STARTER_PACKS } from "../shared/packs";
import type { MeasureId, SpineFrond, StatsParams, StatsResult, TimeBin, TimeWindow, VisibilityParams } from "../shared/protocol/worker";
import type { NoteKind, SpaceId } from "../shared/types";
import {
  autoWindow,
  buildCategories,
  checkCancelled,
  compareVersions,
  DAY_MS,
  dayStartMs,
  defaultVisibility,
  inPeriod,
  isVisible,
  labelValueId,
  localDay,
  localHour,
  makeBins,
  monthIndexOfDay,
  monthLabel,
  NO_CODE,
  OTHER_VALUE,
  readDim,
  weekdayOfDay,
  writtenAt,
  type BinGrain,
} from "./charts/common";
import { influenceStats } from "./influence";
import { cordTau } from "./placement";
import { whenStats } from "./whenStats";

export { autoWindow };

export interface StatsOptions {
  /** Clock for "today" and the strip's right end (tests pin it). */
  now?: number;
  isCancelled?: () => boolean;
}

const SPEAKER_YOU = SPEAKER_ORDER.indexOf("you");
const SPEAKER_ASSISTANT = SPEAKER_ORDER.indexOf("assistant");
const SPEAKER_OTHER = SPEAKER_ORDER.indexOf("other");
const SPEAKER_TOOL = SPEAKER_ORDER.indexOf("tool");
/** Strip bins: days up to 120 days, months beyond 8 years, weeks between (CORTEX-UX §5.8). */
const STRIP_DAY_LIMIT = 120;
const STRIP_MONTH_AFTER_DAYS = 8 * 365.25;
/** Buckets of the voices track along τ (the spine figure is 360 px wide). */
export const VOICE_BUCKETS = 96;
/** The Data view's column cap for a dimension; the rest fold into Other. */
const DATA_COLUMN_CAP = 60;
const DATA_ROW_CAP = 2000;
const FOLDER_ROW_CAP = 2000;

export function computeStats(index: DataIndex, params: StatsParams, opts: StatsOptions = {}): StatsResult {
  if (!params || typeof params !== "object") throw new CortexError("E_BAD_REQUEST", "stats parameters missing");
  const now = opts.now ?? Date.now();
  checkCancelled(opts.isCancelled);
  switch (params.kind) {
    case "strip":
      return stripStats(index, params, now, opts.isCancelled);
    case "spine":
      return spineStats(index, params.visibility);
    case "rhythm":
      return rhythmStats(index, params.visibility);
    case "hours":
      return hoursStats(index, params.visibility);
    case "voices":
      return voicesStats(index, params.visibility);
    case "when":
      return whenStats(index, params);
    case "data":
      return dataStats(index, params);
    case "read":
      return readStats(index, params, now);
    case "sources":
      return sourcesStats(index, params.visibility);
    case "today":
      return todayStats(index, params.dayStart);
    case "packs":
      return packsStats(index, params.includeSuperseded);
    case "influence":
      return influenceStats(index, params.scope);
    default:
      throw new CortexError("E_BAD_REQUEST", `unknown stats kind ${String((params as { kind?: unknown }).kind)}`);
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function visOrDefault(index: DataIndex, vis: VisibilityParams | undefined): VisibilityParams {
  return vis ?? defaultVisibility(index.count);
}

/** Visible items, optionally limited to the period; `dated` keeps only items with a written date. */
function visibleItems(index: DataIndex, vis: VisibilityParams, opts: { period: boolean; dated: boolean; population?: number }): Uint32Array {
  const out = new Uint32Array(index.count);
  let m = 0;
  for (let o = 0; o < index.count; o++) {
    if (!isVisible(index, o, vis)) continue;
    if (opts.population !== undefined && index.cols.pop[o] !== opts.population) continue;
    const t = writtenAt(index, o);
    if (opts.dated && !Number.isFinite(t)) continue;
    if (opts.period && vis.period !== null && !inPeriod(t, vis.period)) continue;
    out[m++] = o;
  }
  return out.slice(0, m);
}

const tauCache = new WeakMap<DataIndex, { sig: string; tau: Float32Array }>();

/**
 * Spine position τ per ordinal (NaN for notes, undated and excluded items): rank among dated record entries
 * (ties share their mid rank) and linear calendar position, combined as on the cord (worker/placement.ts).
 */
export function spineTau(index: DataIndex): Float32Array {
  const c = index.cols;
  let n = 0;
  let sig = 0;
  const eligible = (o: number) => c.pop[o] === Population.Record && !(c.flags[o]! & (ItemFlag.Undated | ItemFlag.Excluded)) && Number.isFinite(c.t[o]!);
  for (let o = 0; o < index.count; o++) {
    if (!eligible(o)) continue;
    n += 1;
    sig = (sig + o * 2654435761) % 4294967296;
  }
  const key = `${index.count}:${n}:${sig}`;
  const hit = tauCache.get(index);
  if (hit && hit.sig === key) return hit.tau;
  const tau = new Float32Array(index.count).fill(Number.NaN);
  if (n > 0) {
    const sorted = new Float64Array(n);
    let m = 0;
    for (let o = 0; o < index.count; o++) if (eligible(o)) sorted[m++] = c.t[o]!;
    sorted.sort();
    const tmin = sorted[0]!;
    const tmax = sorted[n - 1]!;
    for (let o = 0; o < index.count; o++) {
      if (!eligible(o)) continue;
      const t = c.t[o]!;
      const lo = lowerBound(sorted, t);
      const hi = lowerBound(sorted, t + 1e-9 * Math.max(1, Math.abs(t))) - 1;
      const rank = n > 1 ? (lo + Math.max(lo, hi)) / 2 / (n - 1) : 0.5;
      const lin = tmax > tmin ? (t - tmin) / (tmax - tmin) : 0.5;
      tau[o] = cordTau(rank, lin);
    }
  }
  tauCache.set(index, { sig: key, tau });
  return tau;
}

function lowerBound(sorted: Float64Array, v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** τ is 0.06–0.94 on the cord; the age ramp runs 0–1 over that span. */
export function agePosition(tau: number): number {
  return Math.max(0, Math.min(1, (tau - 0.06) / 0.88));
}

/** Trend of your share over the period: first vs last third of the monthly shares, ±3 points = steady. */
export function shareTrendOf(shares: readonly number[]): "rising" | "falling" | "steady" {
  if (shares.length < 3) return "steady";
  const third = Math.max(1, Math.floor(shares.length / 3));
  const avg = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const delta = avg(shares.slice(-third)) - avg(shares.slice(0, third));
  return delta > 0.03 ? "rising" : delta < -0.03 ? "falling" : "steady";
}

/** Rotate Monday-first rhythm rows to a Sunday-first week (Settings › General › Week starts on). */
export function rotateWeek(cells: Uint32Array, weekStart: 0 | 1): Uint32Array {
  if (weekStart === 1) return cells;
  const out = new Uint32Array(7 * 24);
  for (let r = 0; r < 7; r++) {
    const from = (r + 6) % 7;
    out.set(cells.subarray(from * 24, from * 24 + 24), r * 24);
  }
  return out;
}

// ───────────────────────────── strip ─────────────────────────────

function stripStats(index: DataIndex, p: Extract<StatsParams, { kind: "strip" }>, now: number, isCancelled?: () => boolean): StatsResult {
  const vis = visOrDefault(index, p.visibility);
  const c = index.cols;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  let undated = 0;
  const dated: number[] = [];
  for (let o = 0; o < index.count; o++) {
    if ((o & 0xffff) === 0) checkCancelled(isCancelled);
    if (!isVisible(index, o, vis)) continue;
    const t = writtenAt(index, o);
    if (!Number.isFinite(t)) {
      if (c.pop[o] === Population.Record) undated += 1;
      continue;
    }
    if (c.pop[o] !== Population.Record && !p.notesLane) continue;
    dated.push(o);
    if (t < first) first = t;
    if (t > last) last = t;
  }
  if (dated.length === 0) return { kind: "strip", bin: p.bin === "auto" ? "week" : p.bin, bins: [], undated, first: Number.NaN, last: Number.NaN };
  const end = Math.max(now, last);
  const spanDays = (end - first) / DAY_MS;
  const grain: BinGrain = p.bin !== "auto" ? p.bin : spanDays <= STRIP_DAY_LIMIT ? "day" : spanDays > STRIP_MONTH_AFTER_DAYS ? "month" : "week";
  const bins = makeBins(first, end, grain);
  const entries = new Uint32Array(bins.count);
  const notes = new Uint32Array(bins.count);
  const tauSum = new Float64Array(bins.count);
  const tauN = new Uint32Array(bins.count);
  const tau = p.ageColour ? spineTau(index) : null;
  for (const o of dated) {
    const bi = bins.of(c.t[o]!);
    if (bi < 0) continue;
    if (c.pop[o] === Population.Record) {
      entries[bi]! += 1;
      const tv = tau?.[o];
      if (tv !== undefined && Number.isFinite(tv)) {
        tauSum[bi]! += tv;
        tauN[bi]! += 1;
      }
    } else notes[bi]! += 1;
  }
  const out: TimeBin[] = [];
  for (let i = 0; i < bins.count; i++) {
    out.push({
      start: bins.edges[i]!,
      end: bins.edges[i + 1]!,
      entries: entries[i]!,
      notes: notes[i]!,
      age: tau && tauN[i]! > 0 ? agePosition(tauSum[i]! / tauN[i]!) : Number.NaN,
    });
  }
  const firstEntry = Number.isFinite(first) ? first : Number.NaN;
  return { kind: "strip", bin: grain, bins: out, undated, first: firstEntry, last: Number.isFinite(last) ? last : Number.NaN };
}

// ───────────────────────────── spine (unrolled cord) ─────────────────────────────

const MARKER_KINDS = new Set<NoteKind>(["decision", "question", "plan", "abandoned"]);

function spineStats(index: DataIndex, visibility: VisibilityParams): StatsResult {
  const vis = { ...visOrDefault(index, visibility), period: null };
  const c = index.cols;
  const tau = spineTau(index);
  interface Acc {
    tau: number;
    t: number;
    messages: number;
    you: number;
    assistant: number;
  }
  const convs = new Map<number, Acc>();
  const youBins = new Float64Array(VOICE_BUCKETS);
  const asstBins = new Float64Array(VOICE_BUCKETS);
  let undated = 0;
  for (let o = 0; o < index.count; o++) {
    if (c.pop[o] !== Population.Record || !isVisible(index, o, vis)) continue;
    const tv = tau[o]!;
    if (!Number.isFinite(tv)) {
      if (c.flags[o]! & ItemFlag.Undated) undated += 1;
      continue;
    }
    const sp = c.speaker[o]!;
    const w = c.words[o]!;
    const bucket = Math.min(VOICE_BUCKETS - 1, Math.max(0, Math.floor(tv * VOICE_BUCKETS)));
    if (sp === SPEAKER_YOU) youBins[bucket]! += w;
    else if (sp === SPEAKER_ASSISTANT) asstBins[bucket]! += w;
    const cv = c.conv[o]!;
    if (cv === NONE32) continue;
    let acc = convs.get(cv);
    if (!acc) {
      acc = { tau: tv, t: c.t[o]!, messages: 0, you: 0, assistant: 0 };
      convs.set(cv, acc);
    }
    if (c.t[o]! < acc.t) {
      acc.t = c.t[o]!;
      acc.tau = tv;
    }
    acc.messages += 1;
    if (sp === SPEAKER_YOU) acc.you += w;
    else if (sp === SPEAKER_ASSISTANT) acc.assistant += w;
  }
  const fronds: SpineFrond[] = [];
  for (const [conv, acc] of convs) {
    const row = conv < index.convs.size ? index.convs.get(conv) : null;
    fronds.push({ conv, tau: acc.tau, messages: acc.messages, space: (row?.space ?? "none") as SpaceId, you: acc.you, assistant: acc.assistant });
  }
  fronds.sort((a, b) => a.tau - b.tau || a.conv - b.conv);
  const voices = Array.from({ length: VOICE_BUCKETS }, (_, i) => ({ tau: (i + 0.5) / VOICE_BUCKETS, you: youBins[i]!, assistant: asstBins[i]! }));
  // Machine-note kind markers at the τ of their source conversation.
  const frondTau = new Map<number, number>();
  for (const [conv, acc] of convs) frondTau.set(conv, acc.tau);
  const gistConv = new Map<number, number>();
  for (let r = 0; r < index.convs.size; r++) {
    const g = index.convs.get(r).gist;
    if (g !== NONE32) gistConv.set(g, r);
  }
  const { offsets, targets } = index.rel.noteSources;
  const markers: { tau: number; kind: "decision" | "question" | "plan" | "abandoned"; ordinal: number }[] = [];
  for (let o = 0; o < index.count; o++) {
    if (c.pop[o] !== Population.Note) continue;
    const kind = NOTE_KIND_ORDER[c.noteKind[o]!];
    if (!kind || !MARKER_KINDS.has(kind) || !isVisible(index, o, vis)) continue;
    let conv = -1;
    if (o + 1 < offsets.length) {
      for (let k = offsets[o]!; k < offsets[o + 1]! && conv < 0; k++) {
        const e = targets[k]!;
        if (e < index.count && c.conv[e]! !== NONE32) conv = c.conv[e]!;
      }
    }
    for (let q = o, hops = 0; conv < 0 && q !== NONE32 && q < index.count && hops < 4; hops++) {
      const g = gistConv.get(q);
      if (g !== undefined) conv = g;
      q = c.parent[q]!;
    }
    const tv = conv >= 0 ? frondTau.get(conv) : undefined;
    if (tv !== undefined) markers.push({ tau: tv, kind: kind as "decision" | "question" | "plan" | "abandoned", ordinal: o });
  }
  markers.sort((a, b) => a.tau - b.tau || a.ordinal - b.ordinal);
  return { kind: "spine", fronds, voices, markers, undated };
}

// ───────────────────────────── rhythm and hours ─────────────────────────────

function rhythmStats(index: DataIndex, visibility: VisibilityParams): StatsResult {
  const vis = visOrDefault(index, visibility);
  const cells = new Uint32Array(7 * 24);
  for (const o of visibleItems(index, vis, { period: true, dated: true, population: Population.Record })) {
    const t = index.cols.t[o]!;
    cells[weekdayOfDay(localDay(t)) * 24 + localHour(t)]! += 1;
  }
  let max = 0;
  for (const v of cells) max = Math.max(max, v);
  return { kind: "rhythm", cells, max };
}

function hoursStats(index: DataIndex, visibility: VisibilityParams): StatsResult {
  const vis = visOrDefault(index, visibility);
  const counts = new Uint32Array(24);
  for (const o of visibleItems(index, vis, { period: true, dated: true, population: Population.Record })) counts[localHour(index.cols.t[o]!)]! += 1;
  let peakHour = -1;
  for (let h = 0; h < 24; h++) if (counts[h]! > 0 && (peakHour < 0 || counts[h]! > counts[peakHour]!)) peakHour = h;
  return { kind: "hours", counts, peakHour };
}

// ───────────────────────────── voices ─────────────────────────────

function voicesStats(index: DataIndex, visibility: VisibilityParams): StatsResult {
  const vis = visOrDefault(index, visibility);
  const c = index.cols;
  const items = visibleItems(index, vis, { period: true, dated: true, population: Population.Record });
  if (items.length === 0) return { kind: "voices", youShare: 0, trend: "steady", months: [] };
  let m0 = Number.POSITIVE_INFINITY;
  let m1 = Number.NEGATIVE_INFINITY;
  for (const o of items) {
    const mi = monthIndexOfDay(localDay(c.t[o]!));
    m0 = Math.min(m0, mi);
    m1 = Math.max(m1, mi);
  }
  const n = m1 - m0 + 1;
  const you = new Float64Array(n);
  const asst = new Float64Array(n);
  const other = new Float64Array(n);
  const tool = new Float64Array(n);
  for (const o of items) {
    const i = monthIndexOfDay(localDay(c.t[o]!)) - m0;
    const w = c.words[o]!;
    const sp = c.speaker[o]!;
    if (sp === SPEAKER_YOU) you[i]! += w;
    else if (sp === SPEAKER_ASSISTANT) asst[i]! += w;
    else if (sp === SPEAKER_OTHER) other[i]! += w;
    else if (sp === SPEAKER_TOOL) tool[i]! += w;
  }
  const months = Array.from({ length: n }, (_, i) => {
    const mi = m0 + i;
    return { month: `${Math.floor(mi / 12)}-${String((mi % 12) + 1).padStart(2, "0")}`, you: you[i]!, assistant: asst[i]!, other: other[i]!, tool: tool[i]! };
  });
  const yt = you.reduce((a, v) => a + v, 0);
  const all = yt + asst.reduce((a, v) => a + v, 0) + other.reduce((a, v) => a + v, 0);
  const shares = months.filter((m) => m.you + m.assistant + m.other > 0).map((m) => m.you / (m.you + m.assistant + m.other));
  return { kind: "voices", youShare: all > 0 ? yt / all : 0, trend: shareTrendOf(shares), months };
}

// ───────────────────────────── data view ─────────────────────────────

function measureOf(index: DataIndex, o: number, measure: MeasureId): number {
  const pop = index.cols.pop[o];
  switch (measure) {
    case "entries":
      return pop === Population.Record ? 1 : 0;
    case "notes":
      return pop === Population.Note ? 1 : 0;
    case "both":
      return 1;
    case "words":
      return index.cols.words[o]!;
  }
}

function dataStats(index: DataIndex, p: Extract<StatsParams, { kind: "data" }>): StatsResult {
  const vis = visOrDefault(index, p.visibility);
  const measure: MeasureId = p.measure === "entries" || p.measure === "notes" || p.measure === "words" ? p.measure : "both";
  const all = visibleItems(index, vis, { period: true, dated: false });
  const items = all.filter((o) => measureOf(index, o, measure) > 0 || (measure === "words" && index.cols.pop[o] !== undefined));
  const rowsDv = readDim(index, p.rows, items);
  const rowCats = buildCategories(index, items, rowsDv, { sort: "count", top: "all", size: "entries", foldable: true, keepNone: true, cap: DATA_ROW_CAP });
  // Columns.
  let columns: string[] = [];
  let colOf: (o: number) => number = () => -1;
  if (p.columns === "week" || p.columns === "month" || p.columns === "year") {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const o of items) {
      const t = writtenAt(index, o);
      if (!Number.isFinite(t)) continue;
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    if (vis.period) {
      lo = vis.period[0];
      hi = vis.period[1];
    }
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      if (p.columns === "year") {
        const y0 = new Date(lo).getFullYear();
        const y1 = new Date(hi).getFullYear();
        columns = Array.from({ length: y1 - y0 + 1 }, (_, i) => String(y0 + i));
        colOf = (o) => {
          const t = writtenAt(index, o);
          return Number.isFinite(t) ? new Date(t).getFullYear() - y0 : -1;
        };
      } else {
        const bins = makeBins(lo, hi, p.columns);
        columns = Array.from({ length: bins.count }, (_, i) => (p.columns === "month" ? monthLabel(monthIndexOfDay(localDay(bins.edges[i]!))) : bins.label(i) + " " + new Date(bins.edges[i]!).getFullYear()));
        colOf = (o) => bins.of(writtenAt(index, o));
      }
    }
  } else if (p.columns !== "none") {
    const colDv = readDim(index, p.columns, items);
    const colCats = buildCategories(index, items, colDv, { sort: "count", top: DATA_COLUMN_CAP, size: "entries", foldable: !colDv.isDate, keepNone: true, cap: DATA_COLUMN_CAP });
    columns = colCats.list.map((cc) => (cc.kind === "none" ? "" : cc.kind === "other" ? OTHER_VALUE : cc.label));
    colOf = (o) => {
      const v = colCats.of[o]!;
      return v === NO_CODE ? -1 : v;
    };
  }
  const nc = columns.length;
  const nr = rowCats.list.length;
  const cells = new Float64Array(nr * Math.max(1, nc));
  const totalsRow = new Float64Array(nr);
  const totals = new Float64Array(nc);
  let grand = 0;
  for (const o of items) {
    const r = rowCats.of[o]!;
    if (r === NO_CODE) continue;
    const v = measureOf(index, o, measure);
    if (v === 0) continue;
    totalsRow[r]! += v;
    grand += v;
    if (nc > 0) {
      const ci = colOf(o);
      if (ci >= 0 && ci < nc) {
        cells[r * nc + ci]! += v;
        totals[ci]! += v;
      }
    }
  }
  const rows = rowCats.list
    .map((rc, r) => ({
      key: rc.kind === "none" ? "" : rc.kind === "other" ? OTHER_VALUE : rc.key,
      label: rc.kind === "none" ? "" : rc.label,
      total: totalsRow[r]!,
      share: grand > 0 ? totalsRow[r]! / grand : 0,
      cells: nc > 0 ? Array.from(cells.subarray(r * nc, r * nc + nc)) : [],
    }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total || (a.key === "" ? 1 : b.key === "" ? -1 : 0));
  return { kind: "data", columns, rows, totals: Array.from(totals) };
}

// ───────────────────────────── read ─────────────────────────────

interface ReadRow {
  ordinal: number;
  count: number;
  you: number;
  words: number;
  first: number;
  last: number;
  pinned: boolean;
  conv: number;
  youShare: number;
}

const titleCache = new WeakMap<DataIndex, { count: number; lower: (string | undefined)[] }>();

function lowerTitle(index: DataIndex, o: number): string {
  let hit = titleCache.get(index);
  if (!hit || hit.count !== index.count) {
    hit = { count: index.count, lower: new Array(index.count) };
    titleCache.set(index, hit);
  }
  let s = hit.lower[o];
  if (s === undefined) {
    s = index.titles.get(o).toLowerCase();
    hit.lower[o] = s;
  }
  return s;
}

function rowTitle(index: DataIndex, r: ReadRow): string {
  if (r.conv !== NONE32 && r.conv < index.convs.size) return index.convs.get(r.conv).title.toLowerCase();
  return lowerTitle(index, r.ordinal);
}

function folderOf(index: DataIndex, o: number): string {
  const f = index.cols.folder[o]!;
  return f === NONE32 || f >= index.dicts.folders.size ? "" : index.dicts.folders.get(f);
}

function sourceGroupOf(index: DataIndex, o: number): { source: string; project: string } {
  const source = SOURCE_ORDER[index.cols.source[o]!] ?? "";
  const pj = index.cols.project[o]!;
  return { source, project: pj === NONE32 || pj >= index.dicts.projects.size ? "" : index.dicts.projects.get(pj) };
}

const YOURS_BY_KIND = new Set<number>([ItemKind.RecordDocument, ItemKind.RecordPassage, ItemKind.RecordFile]);

function readStats(index: DataIndex, p: Extract<StatsParams, { kind: "read" }>, now: number): StatsResult {
  const vis = visOrDefault(index, p.visibility);
  const c = index.cols;
  const todayStart = dayStartMs(localDay(now));
  const todayEnd = dayStartMs(localDay(now) + 1);
  const folder = p.folder ?? null;
  const inFolder = (o: number): boolean => {
    if (folder === null || folder === "") return true;
    if (p.view === "folder") {
      const f = folderOf(index, o);
      return f === folder || f.startsWith(folder + "/");
    }
    if (p.view === "source") {
      const g = sourceGroupOf(index, o);
      const slash = folder.indexOf("/");
      if (slash < 0) return g.source === folder;
      return g.source === folder.slice(0, slash) && g.project === folder.slice(slash + 1);
    }
    return true;
  };
  const items = visibleItems(index, vis, { period: true, dated: false });
  const rowsByConv = new Map<number, ReadRow>();
  const rows: ReadRow[] = [];
  const folderCounts = new Map<string, number>();
  for (const o of items) {
    const t = writtenAt(index, o);
    const tt = Number.isFinite(t) ? t : c.tAdded[o]!;
    if (p.preset === "today" && !(tt >= todayStart && tt < todayEnd)) continue;
    if (p.view === "folder") {
      const f = folderOf(index, o);
      if (f !== "") {
        const parts = f.split("/").filter((s) => s.length > 0);
        for (let k = 1; k <= parts.length; k++) {
          const path = parts.slice(0, k).join("/");
          folderCounts.set(path, (folderCounts.get(path) ?? 0) + 1);
        }
      }
    } else if (p.view === "source") {
      const g = sourceGroupOf(index, o);
      folderCounts.set(g.source, (folderCounts.get(g.source) ?? 0) + 1);
      if (g.project !== "") folderCounts.set(`${g.source}/${g.project}`, (folderCounts.get(`${g.source}/${g.project}`) ?? 0) + 1);
    }
    if (!inFolder(o)) continue;
    const pinned = (c.flags[o]! & ItemFlag.Pinned) !== 0;
    const sp = c.speaker[o]!;
    const w = c.words[o]!;
    const cv = c.pop[o] === Population.Record ? c.conv[o]! : NONE32;
    if (cv !== NONE32) {
      let r = rowsByConv.get(cv);
      if (!r) {
        r = { ordinal: o, count: 0, you: 0, words: 0, first: tt, last: tt, pinned: false, conv: cv, youShare: 0 };
        rowsByConv.set(cv, r);
        rows.push(r);
      }
      r.count += 1;
      r.words += sp === SPEAKER_TOOL ? 0 : w;
      if (sp === SPEAKER_YOU) r.you += w;
      if (tt < r.first || (tt === r.first && c.idx[o]! < c.idx[r.ordinal]!)) {
        r.first = tt;
        r.ordinal = o;
      }
      r.last = Math.max(r.last, tt);
      r.pinned ||= pinned;
      continue;
    }
    const kind = c.kind[o]!;
    const share = c.pop[o] === Population.Note ? Number.NaN : YOURS_BY_KIND.has(kind) || c.source[o] === SOURCE_ORDER.indexOf("written") ? 1 : sp === SPEAKER_YOU ? 1 : 0;
    rows.push({ ordinal: o, count: 1, you: 0, words: w, first: tt, last: tt, pinned, conv: NONE32, youShare: share });
  }
  for (const r of rowsByConv.values()) r.youShare = r.words > 0 ? r.you / r.words : 0;
  let list = p.pinnedOnly ? rows.filter((r) => r.pinned) : rows;
  const q = p.query.trim().toLowerCase();
  if (q !== "") {
    const terms = q.split(/\s+/).filter((s) => s.length > 0);
    list = list.filter((r) => {
      const title = rowTitle(index, r);
      return terms.every((term) => title.includes(term));
    });
  }
  const byTime = (a: ReadRow, b: ReadRow) => a.ordinal - b.ordinal;
  switch (p.sort) {
    case "newest":
      list.sort((a, b) => b.last - a.last || byTime(b, a));
      break;
    case "oldest":
      list.sort((a, b) => a.first - b.first || byTime(a, b));
      break;
    case "size":
      list.sort((a, b) => b.count - a.count || b.words - a.words || b.last - a.last);
      break;
    case "title":
      list.sort((a, b) => rowTitle(index, a).localeCompare(rowTitle(index, b), "en-GB", { numeric: true }) || byTime(a, b));
      break;
  }
  const offset = Math.max(0, Math.floor(p.offset) || 0);
  const limit = Math.max(0, Math.floor(p.limit) || 0);
  const page = list.slice(offset, offset + limit).map((r) => ({ ordinal: r.ordinal, count: r.count, youShare: r.youShare, last: r.last }));
  const folders = [...folderCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "en-GB", { numeric: true }))
    .slice(0, FOLDER_ROW_CAP)
    .map(([path, count]) => ({ path, count, depth: path.split("/").length - 1 }));
  return { kind: "read", total: list.length, rows: page, folders };
}

// ───────────────────────────── sources ─────────────────────────────

function sourcesStats(index: DataIndex, visibility: VisibilityParams): StatsResult {
  const vis = { ...visOrDefault(index, visibility), period: null, scope: "all" as const };
  const c = index.cols;
  const n = SOURCE_ORDER.length;
  const entries = new Float64Array(n);
  const yours = new Float64Array(n);
  const words = new Float64Array(n);
  const undated = new Float64Array(n);
  const convs = Array.from({ length: n }, () => new Set<number>());
  for (let o = 0; o < index.count; o++) {
    if (c.pop[o] !== Population.Record || !isVisible(index, o, vis)) continue;
    const s = c.source[o]!;
    if (s >= n) continue;
    entries[s]! += 1;
    words[s]! += c.words[o]!;
    if (c.speaker[o] === SPEAKER_YOU) yours[s]! += c.words[o]!;
    if (c.flags[o]! & ItemFlag.Undated) undated[s]! += 1;
    if (c.conv[o]! !== NONE32) convs[s]!.add(c.conv[o]!);
  }
  const rows = SOURCE_ORDER.map((source, s) => ({ source, entries: entries[s]!, conversations: convs[s]!.size, yourWords: yours[s]!, words: words[s]!, undated: undated[s]! })).filter((r) => r.entries > 0);
  return { kind: "sources", rows };
}

// ───────────────────────────── today ─────────────────────────────

function todayStats(index: DataIndex, dayStart: number): StatsResult {
  if (!Number.isFinite(dayStart)) throw new CortexError("E_BAD_REQUEST", "today needs a day start");
  const vis = defaultVisibility(index.count);
  const c = index.cols;
  const start = dayStartMs(localDay(dayStart));
  const end = dayStartMs(localDay(dayStart) + 1);
  const bySource = new Float64Array(SOURCE_ORDER.length);
  const newNotes: { o: number; t: number }[] = [];
  for (let o = 0; o < index.count; o++) {
    if (!isVisible(index, o, vis)) continue;
    if (c.pop[o] === Population.Record) {
      const t = writtenAt(index, o);
      if (t >= start && t < end) bySource[c.source[o]!]! += 1;
    } else {
      const ta = c.tAdded[o]!;
      if (ta >= start && ta < end) newNotes.push({ o, t: ta });
    }
  }
  newNotes.sort((a, b) => b.t - a.t || a.o - b.o);
  return {
    kind: "today",
    bySource: SOURCE_ORDER.map((source, i) => ({ source, entries: bySource[i]! })).filter((r) => r.entries > 0),
    newNotes: newNotes.map((n) => n.o),
  };
}

// ───────────────────────────── packs ─────────────────────────────

function packsStats(index: DataIndex, includeSuperseded: boolean): StatsResult {
  const c = index.cols;
  const groups = new Map<string, { pack: string; version: string; cols: number[] }>();
  index.labels.forEach((col, i) => {
    const key = `${col.pack}@${col.packVersion}`;
    const g = groups.get(key) ?? { pack: col.pack, version: col.packVersion, cols: [] };
    g.cols.push(i);
    groups.set(key, g);
  });
  const newest = new Map<string, string>();
  for (const g of groups.values()) {
    const cur = newest.get(g.pack);
    if (cur === undefined || compareVersions(g.version, cur) > 0) newest.set(g.pack, g.version);
  }
  const eligible = (o: number) => !(c.flags[o]! & (ItemFlag.Excluded | ItemFlag.Reference | ItemFlag.HiddenByDefault));
  /** Label values on a pack version: per entry and field, and who made them (a user correction vs a model). */
  const tally = (cols: readonly number[]) => {
    const seen = new Uint8Array(index.count);
    let labels = 0;
    let entries = 0;
    let you = 0;
    for (const ci of cols) {
      const col = index.labels[ci]!;
      for (let o = 0; o < index.count; o++) {
        if (!eligible(o) || labelValueId(col, o) < 0) continue;
        labels++;
        if (col.byUser[o]) you++;
        if (!seen[o]) {
          seen[o] = 1;
          entries++;
        }
      }
    }
    return { labels, entries, you, machine: labels - you };
  };
  const out: Extract<StatsResult, { kind: "packs" }>["packs"] = [];
  let supersededLabels = 0;
  for (const g of groups.values()) {
    if (newest.get(g.pack) !== g.version) supersededLabels += tally(g.cols).labels;
    if (!includeSuperseded && newest.get(g.pack) !== g.version) continue;
    const def = STARTER_PACKS.find((d) => d.id === g.pack);
    let targets = def?.appliesTo ?? [];
    if (targets.length === 0) {
      // Unknown pack: infer its targets from where its values are.
      const onRecord = g.cols.some((ci) => {
        const col = index.labels[ci]!;
        for (let o = 0; o < index.count; o++) if (c.pop[o] === Population.Record && labelValueId(col, o) >= 0) return true;
        return false;
      });
      targets = onRecord ? ["conversation"] : ["note"];
    }
    // Units: conversations (any message labelled), notes, and record entries outside conversations.
    const unitOf = new Int32Array(index.count).fill(-1);
    const unitIds = new Map<number, number>();
    let units = 0;
    for (let o = 0; o < index.count; o++) {
      if (!eligible(o)) continue;
      if (c.pop[o] === Population.Note) {
        if (targets.includes("note")) unitOf[o] = units++;
      } else if (c.conv[o]! !== NONE32) {
        if (targets.includes("conversation")) {
          let u = unitIds.get(c.conv[o]!);
          if (u === undefined) {
            u = units++;
            unitIds.set(c.conv[o]!, u);
          }
          unitOf[o] = u;
        }
      } else if (targets.includes("entry")) unitOf[o] = units++;
    }
    const labelled = new Uint8Array(units);
    const perField = g.cols.map(() => new Uint8Array(units));
    g.cols.forEach((ci, fi) => {
      const col = index.labels[ci]!;
      for (let o = 0; o < index.count; o++) {
        const u = unitOf[o]!;
        if (u < 0 || labelValueId(col, o) < 0) continue;
        perField[fi]![u] = 1;
        labelled[u] = 1;
      }
    });
    const nLabelled = labelled.reduce((a, v) => a + v, 0);
    const made = tally(g.cols);
    out.push({
      pack: g.pack,
      version: g.version,
      items: units,
      labelled: nLabelled,
      blank: units - nLabelled,
      labelCount: made.labels,
      entryCount: made.entries,
      authors: { machine: made.machine, you: made.you },
      fields: g.cols.map((ci, fi) => ({ field: index.labels[ci]!.field, coverage: units > 0 ? perField[fi]!.reduce((a, v) => a + v, 0) / units : 0 })),
    });
  }
  out.sort((a, b) => a.pack.localeCompare(b.pack) || compareVersions(b.version, a.version));
  return { kind: "packs", packs: out, supersededLabels };
}

/** Range of the Data view's time columns, exposed for the Chart page's "Show as table" hand-off. */
export function dataRange(window: TimeWindow | null, first: number, last: number): TimeWindow | null {
  if (window) return window;
  return Number.isFinite(first) && Number.isFinite(last) ? [first, last] : null;
}

export { SPACE_ORDER };
