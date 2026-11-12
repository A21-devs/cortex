/**
 * Shared chart machinery. Owner: E9. CORTEX-UX §7 is normative.
 *
 * Every chart is drawn by the same particles: a layout returns one target position per item (NaN = not in this
 * chart, the particle leaves), an overlay model (axes, rules, labels, outlines and hit regions) that the UI draws
 * once the particles settle, and up to three readings (numbers and names drawn on the chart, never sentences).
 * Flat charts lie on the XY plane centred at the origin, about 13 × 8 world units; 3D charts fill a similar
 * volume. A map's sources are ringed in place with a count chip; nothing is gathered into a separate halo.
 *
 * Membership (who is in a chart) is decided here, not by the caller: the leaf's visibility (Layers, scope, held
 * arrivals), the period (items outside it leave; undated items have no place in a period), the chart's filters
 * (OR within a dimension, AND across dimensions) and "Hide items without a value" on the axes. `ChartContext.
 * members` can only narrow that set.
 *
 * Category text: the worker never holds copy. Labels carry a fallback `text` (dates, folder paths, titles) and a
 * JSON `key` (`ChartRef`) from which the UI resolves the display name (value labels, remainder names, areas).
 */
import { CortexError } from "../../shared/errors";
import {
  ItemFlag,
  ItemKind,
  NONE16,
  NONE32,
  NONE8,
  HUB_STATUS_ORDER,
  HUB_TYPE_ORDER,
  NOTE_KIND_ORDER,
  Population,
  SOURCE_ORDER,
  SPACE_ORDER,
  SPEAKER_ORDER,
  type DataIndex,
  type LabelColumn,
} from "../../shared/index-format";
import { FILING_VALUES, isLabelDim, parseDateDim, parseLabelDim, RECENCY_VALUES, ROLE_DIM, recencyOfDays, type DateGrain, type DimId } from "../../shared/dims";
import { frameUnits, labelColumns, labelPitch, labelWidth, COLUMN_LABEL_CHARS, type ChartStage } from "../../shared/chartStage";
import { STARTER_PACKS, SUBREGIONS, subregionOfRole } from "../../shared/packs";
import { addAnnotations } from "./annotations";
import { spaceName } from "../../shared/spaces";
import type {
  ArrangementResult,
  AxisSpec,
  ChartReading,
  ChartSpec,
  OverlayItem,
  OverlayModel,
  TimeWindow,
  Vec3,
  VisibilityParams,
} from "../../shared/protocol/worker";
import type { SpaceId } from "../../shared/types";
import { chartDef, type ChartId } from "../../shared/views";

// ───────────────────────────── context ─────────────────────────────

export interface ChartContext {
  index: DataIndex;
  spec: ChartSpec;
  visibility: VisibilityParams;
  /**
   * Optional narrowing: when non-empty, only these ordinals can be in the chart (the chart still applies its own
   * visibility, period and filter rules). Empty = every item of the index is a candidate.
   */
  members: Uint32Array;
  /** Per-item seed in [0, 1); mixed with a stable hash of the ordinal, so a constant function is fine. */
  seed(ordinal: number): number;
  /** Clock for the time axis and "now" marks (tests pin it). Default Date.now(). */
  now?: number;
  /** Cooperative cancellation, polled between passes; a cancelled layout throws E_CANCELLED. */
  isCancelled?: () => boolean;
  /**
   * The visible stage in CSS px (width, height, aspect). Labels and ticks switch between one and two columns or rows
   * with the room they have (shared/chartStage.ts); absent, the chart is laid out for the usual stage.
   */
  stage?: ChartStage;
}

export type ChartLayout = (ctx: ChartContext) => ArrangementResult;

export type ChartRegistry = Readonly<Record<ChartId, ChartLayout>>;

/**
 * What an overlay label, a mark or a reading refers to. Serialised as JSON in `OverlayItem.key`, mark keys and
 * `ChartReading.values.ref`; only the UI overlay parses it (stage/ChartOverlay.tsx).
 */
export interface ChartRef {
  /** Horizontal-zone category: traced as a group token. */
  x?: [DimId, string];
  /** Vertical-zone or series category: traced as a band token (AND with x). */
  y?: [DimId, string];
  /** Several categories of one dimension, OR-ed (chord ribbons). */
  or?: [DimId, string][];
  /** Time range [t0, t1): traced as a time token. */
  t?: [number, number];
  /** Treemap drill-in: clicking this label or box zooms the treemap into this folder path ("" = the whole tree). */
  drill?: string;
  /** Calendar semantic zoom: world height of the cell; the overlay shows the label only at ≥ 18 px on screen. */
  zoom?: number;
  /** Semantic zoom, the other way: world length of the cell; the label gives way once that is ≥ 18 px on screen. */
  zoomMax?: number;
  /** Index of the mark (cell) a count label belongs to: it gives way when the overlay names that cell's members. */
  cell?: number;
  /** Copy key the UI renders instead of `text` (e.g. "strip.today"). */
  copy?: string;
  /** Lane span [first, last] shown in the tooltip instead of the period. */
  span?: [number, number];
  /** Icicle row: clicking its label expands or collapses this folder path. */
  fold?: string;
  /** Lifeline lane: [months from first to last entry, 1 while it is still active]; the overlay words it ("ongoing, 7 months"). */
  life?: [number, number];
  /** Returns row: months of the longest gap before the topic came back; the overlay words the label "name - back after N months". */
  back?: number;
  /** Lifelines Curve slice: [percent of lives that last at least this long, that length in days]; the overlay words it. */
  curve?: [number, number];
}

export function refKey(ref: ChartRef): string {
  return JSON.stringify(ref);
}

/** Category key of the "no value" bucket. */
export const NONE_VALUE = "";
/** Category key of the folded remainder (Top N). */
export const OTHER_VALUE = "__other__";
/** Default Top N (CORTEX-UX §7.4). */
export const DEFAULT_TOP = 20;
export const TOP_RANGE = { min: 5, max: 60 } as const;
/** Groups smaller than this are thin: outlined, with an "n" chip (CORTEX-UX §5.29). */
export const THIN_GROUP = 30;
/** At most this many map sources are ringed individually; beyond, the marks containing them are outlined. */
export const RING_LIMIT = 400;
/** Category labels are truncated at 24 characters (CORTEX-UX §7.1). */
export const LABEL_MAX = 24;
export const MAX_READINGS = 3;
/** Categories reported back for the Top-N stepper, Combine with… and the folders checklist. */
export const MAX_REPORTED_CATEGORIES = 400;

/** Truncate category labels for axes (24 characters including the ellipsis). */
export function axisLabel(s: string, max = LABEL_MAX): string {
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

/** Clamp a Top N value to 5–60; "all" stays "all". */
export function clampTop(top: ChartSpec["top"] | undefined): number | "all" {
  if (top === "all") return "all";
  if (typeof top !== "number" || !Number.isFinite(top)) return DEFAULT_TOP;
  return Math.max(TOP_RANGE.min, Math.min(TOP_RANGE.max, Math.round(top)));
}

export interface Category {
  key: string;
  label: string;
  count: number;
}

/** Top-N stepper: keep the N largest categories and fold the rest into "Other". */
export function foldLargest(cats: readonly Category[], top: ChartSpec["top"]): Category[] {
  const sorted = [...cats].sort((a, b) => b.count - a.count);
  if (top === "all" || sorted.length <= top) return sorted;
  const keep = sorted.slice(0, top);
  const rest = sorted.slice(top).reduce((n, c) => n + c.count, 0);
  return rest > 0 ? [...keep, { key: OTHER_VALUE, label: "Other", count: rest }] : keep;
}

// ───────────────────────────── deterministic randomness ─────────────────────────────

/** Stable value in [0, 1) for (ordinal, salt): a 32-bit integer mix, no allocation. */
export function hashUnit(o: number, salt: number): number {
  let h = (Math.imul(o, 0x9e3779b1) ^ Math.imul(salt + 0x632be5ab, 0x85ebca77)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const R2_A = 0.7548776662466927;
const R2_B = 0.5698402909980532;
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** k-th point of the R2 low-discrepancy sequence in the unit square: even fill for any count. */
export function r2u(k: number): number {
  return (0.5 + R2_A * k) % 1;
}
export function r2v(k: number): number {
  return (0.5 + R2_B * k) % 1;
}

// ───────────────────────────── local calendar arithmetic ─────────────────────────────

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
const QUARTER_MS = 900_000;
const offsetCache = new Map<number, number>();

/** Local UTC offset (ms, local = utc + offset) at t; cached per quarter hour (every zone's transitions fall on one). */
export function localOffset(t: number): number {
  const q = Math.floor(t / QUARTER_MS);
  let off = offsetCache.get(q);
  if (off === undefined) {
    off = -new Date(q * QUARTER_MS).getTimezoneOffset() * 60_000;
    if (offsetCache.size > 200_000) offsetCache.clear();
    offsetCache.set(q, off);
  }
  return off;
}

/** Days since 1970-01-01 in the local calendar. */
export function localDay(t: number): number {
  return Math.floor((t + localOffset(t)) / DAY_MS);
}

/** Local hour 0–23. */
export function localHour(t: number): number {
  const local = t + localOffset(t);
  return Math.floor((((local % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS);
}

/** Weekday of a local day number, Monday = 0 … Sunday = 6. */
export function weekdayOfDay(day: number): number {
  return (((day + 3) % 7) + 7) % 7;
}

/** Civil date of a day number (Hinnant's algorithm): [year, month 1–12, day 1–31]. */
export function civilFromDays(days: number): [number, number, number] {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

/** Day number of a civil date. */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Epoch ms of local midnight starting a day number (DST-exact). */
export function dayStartMs(day: number): number {
  const [y, m, d] = civilFromDays(day);
  return new Date(y, m - 1, d).getTime();
}

/** ISO week of a day number: Monday of that week and the ISO week-year / number. */
export function isoWeek(day: number): { monday: number; year: number; week: number } {
  const monday = day - weekdayOfDay(day);
  const thursday = monday + 3;
  const year = civilFromDays(thursday)[0];
  const week = Math.floor((thursday - daysFromCivil(year, 1, 1)) / 7) + 1;
  return { monday, year, week };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const fmtMonthShort = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });
const fmtWeekdayShort = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" });

/** "Nov" for a month 1–12 (formatted through Intl, en-GB like shared/time.ts). */
export function monthName(m: number): string {
  return fmtMonthShort.format(Date.UTC(2001, m - 1, 1));
}

/** "Mon" … "Sun" for Monday = 0 … Sunday = 6. */
export function weekdayName(wd: number): string {
  return fmtWeekdayShort.format(Date.UTC(2001, 0, 1 + wd)); // 1 Jan 2001 was a Monday
}

/** "3 Nov 2026" for a day number. */
export function dayLabel(day: number): string {
  const [y, m, d] = civilFromDays(day);
  return `${d} ${monthName(m)} ${y}`;
}

/** "Nov 2026" for a month index (year × 12 + month − 1). */
export function monthLabel(mi: number): string {
  return `${monthName((mi % 12) + 1)} ${Math.floor(mi / 12)}`;
}

/** Month index (year × 12 + month − 1) of a day number. */
export function monthIndexOfDay(day: number): number {
  const [y, m] = civilFromDays(day);
  return y * 12 + m - 1;
}

/** First day number of a month index. */
export function dayOfMonthIndex(mi: number): number {
  return daysFromCivil(Math.floor(mi / 12), (mi % 12) + 1, 1);
}

// ───────────────────────────── visibility and membership ─────────────────────────────

/** The defaults a new leaf starts with (reference, Ask history, subagents and automated sessions hidden). */
export function defaultVisibility(count: number): VisibilityParams {
  return {
    scope: "all",
    period: null,
    notes: true,
    vaultNotes: true,
    maps: true,
    record: true,
    undatedCloud: true,
    reference: false,
    askHistory: false,
    subagents: false,
    automated: false,
    revealedCount: count,
  };
}

const TOGGLED_HIDDEN = ItemFlag.Subagent | ItemFlag.AssistantPane | ItemFlag.Automated | ItemFlag.Reference;

/**
 * Whether the leaf shows an item at all (Layers, scope, held arrivals; never excluded items). The period is
 * separate (`inPeriod`) because the strip and the unrolled spine draw the whole record under the period brush.
 */
export function isVisible(index: DataIndex, o: number, vis: VisibilityParams): boolean {
  // revealedCount <= 0 (or not a number) means nothing is held, as everywhere else.
  if (vis.revealedCount > 0 && o >= vis.revealedCount) return false;
  const c = index.cols;
  const f = c.flags[o]!;
  if (f & ItemFlag.Excluded) return false;
  if (f & ItemFlag.Reference && !vis.reference) return false;
  if (f & ItemFlag.Subagent && !vis.subagents) return false;
  if (f & ItemFlag.AssistantPane && !vis.askHistory) return false;
  if (f & ItemFlag.Automated && !vis.automated) return false;
  // Harness lines and tool output have no Layers toggle: hidden whenever flagged hidden-by-default.
  if (f & ItemFlag.HiddenByDefault && !(f & TOGGLED_HIDDEN)) return false;
  if (c.pop[o] === Population.Record) {
    if (!vis.record) return false;
    if (f & ItemFlag.Undated && !vis.undatedCloud) return false;
  } else {
    const kind = c.kind[o];
    if (kind === ItemKind.NoteHub) {
      if (!vis.maps) return false;
    } else if (kind === ItemKind.NoteWiki) {
      if (!vis.vaultNotes) return false;
    } else if (!vis.notes) return false;
  }
  if (vis.scope !== "all" && SPACE_ORDER[c.space[o]!] !== vis.scope) return false;
  return true;
}

/** Written time of an item, NaN when undated. */
export function writtenAt(index: DataIndex, o: number): number {
  const t = index.cols.t[o]!;
  return index.cols.flags[o]! & ItemFlag.Undated ? Number.NaN : t;
}

export function inPeriod(t: number, period: TimeWindow | null): boolean {
  if (period === null) return true;
  return t >= period[0] && t <= period[1];
}

export function checkCancelled(isCancelled: (() => boolean) | undefined): void {
  if (isCancelled?.()) throw new CortexError("E_CANCELLED", "chart computation cancelled");
}

// ───────────────────────────── dimension values ─────────────────────────────

export const NO_CODE = 0xffffffff;

/** Values of one dimension for a set of items: a dense code per ordinal plus a table per code. */
export interface DimValues {
  readonly dim: DimId;
  /** Code per ordinal; NO_CODE for "no value" (only meaningful for the ordinals read). */
  readonly codes: Uint32Array;
  readonly keys: string[];
  /** Fallback display text per code (dates, paths, titles); the UI resolves enum values and remainders. */
  readonly labels: string[];
  /** Natural order per code (chronological for dates, enum order for sources, areas, speakers…). */
  readonly order: number[];
  /** True for date grains (Top N never folds a time axis). */
  readonly isDate: boolean;
  readonly grain: DateGrain | null;
  readonly basis: "written" | "imported" | null;
}

class Interner {
  readonly keys: string[] = [];
  readonly labels: string[] = [];
  readonly order: number[] = [];
  private readonly byKey = new Map<string, number>();
  private readonly byNum = new Map<number, number>();

  str(key: string, label: string, order: number): number {
    let c = this.byKey.get(key);
    if (c === undefined) {
      c = this.keys.length;
      this.keys.push(key);
      this.labels.push(label);
      this.order.push(order);
      this.byKey.set(key, c);
    }
    return c;
  }

  /** Numeric identity (day number, dictionary id …) with lazily built key and label. */
  num(n: number, make: (n: number) => [string, string, number]): number {
    let c = this.byNum.get(n);
    if (c === undefined) {
      const [key, label, order] = make(n);
      c = this.str(key, label, order);
      this.byNum.set(n, c);
    }
    return c;
  }
}

/** Find a label column for a pack field; the newest version wins when several are loaded. */
export function labelColumn(index: DataIndex, pack: string, field: string): LabelColumn | undefined {
  let best: LabelColumn | undefined;
  for (const col of index.labels) {
    if (col.pack !== pack || col.field !== field) continue;
    if (!best || compareVersions(col.packVersion, best.packVersion) > 0) best = col;
  }
  return best;
}

/** Semver-ish comparison of dotted numeric versions ("1.10.0" > "1.9.2"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10));
  const pb = b.split(".").map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return a.localeCompare(b);
    if (x !== y) return x - y;
  }
  return 0;
}

/** Value id of the first value of a label column for an item; -1 when none. */
export function labelValueId(col: LabelColumn, o: number): number {
  if (col.single) {
    const v = col.single[o];
    return v === undefined || v === NONE16 || v >= col.values.length ? -1 : v;
  }
  if (col.multi) {
    const a = col.multi.offsets[o];
    const b = col.multi.offsets[o + 1];
    if (a === undefined || b === undefined || b <= a) return -1;
    const v = col.multi.targets[a]!;
    return v < col.values.length ? v : -1;
  }
  return -1;
}

/** First value of a label column for an item ("" when none). */
export function labelValue(col: LabelColumn, o: number): string {
  const v = labelValueId(col, o);
  return v < 0 ? "" : (col.values[v] ?? "");
}

function fieldLabel(pack: string, field: string): string {
  const def = STARTER_PACKS.find((p) => p.id === pack);
  return def?.fields.find((f) => f.key === field)?.label ?? field;
}

const mapCache = new WeakMap<DataIndex, { count: number; mapOf: Uint32Array }>();

const HUB_TYPE_WORD: Readonly<Record<string, string>> = { project: "Project map", area: "Area map", topic: "Topic map" };
/** Order of the "conversation" kind: after every stored note kind. */
const CONVERSATION_KIND = NOTE_KIND_ORDER.length;

const HUB_STATUS_WORD: Readonly<Record<string, string>> = { active: "Active", quiet: "Cooling", paused: "Dormant" };

const FILING_WORD: Readonly<Record<string, string>> = { filed: "Filed into an area", unfiled: "Not yet filed" };
const RECENCY_WORD: Readonly<Record<string, string>> = { active: "Active", cooling: "Cooling", dormant: "Dormant" };

const newestCache = new WeakMap<DataIndex, { count: number; newest: number }>();

/** The newest written time in the index (your newest entry): the Recency dimension counts back from it. NaN when nothing is dated. */
export function newestWritten(index: DataIndex): number {
  const hit = newestCache.get(index);
  if (hit && hit.count === index.count) return hit.newest;
  let newest = Number.NaN;
  for (let o = 0; o < index.count; o++) {
    const v = writtenAt(index, o);
    if (v === v && (newest !== newest || v > newest)) newest = v;
  }
  newestCache.set(index, { count: index.count, newest });
  return newest;
}

/** The map (hub ordinal) each note belongs to; NONE32 for none. Larger maps win when a note is in several. */
export function mapOfNotes(index: DataIndex): Uint32Array {
  const hit = mapCache.get(index);
  if (hit && hit.count === index.count) return hit.mapOf;
  const mapOf = new Uint32Array(index.count).fill(NONE32);
  const { offsets, targets } = index.rel.hubMembers;
  const hubs: number[] = [];
  for (let h = 0; h + 1 < offsets.length && h < index.count; h++) if (offsets[h + 1]! > offsets[h]!) hubs.push(h);
  hubs.sort((a, b) => offsets[b + 1]! - offsets[b]! - (offsets[a + 1]! - offsets[a]!) || a - b);
  for (const h of hubs) {
    if (mapOf[h] === NONE32) mapOf[h] = h;
    for (let k = offsets[h]!; k < offsets[h + 1]!; k++) {
      const m = targets[k]!;
      if (m < index.count && mapOf[m] === NONE32) mapOf[m] = h;
    }
  }
  for (let o = 0; o < index.count; o++) if (index.cols.kind[o] === ItemKind.NoteHub && mapOf[o] === NONE32) mapOf[o] = o;
  mapCache.set(index, { count: index.count, mapOf });
  return mapOf;
}

/**
 * Read one dimension for `items`. Dates use the local calendar (the worker runs in Obsidian's time zone);
 * rhythm grains (hour, weekday) always use the written date.
 */
export function readDim(index: DataIndex, dim: DimId, items: ArrayLike<number>): DimValues {
  const c = index.cols;
  const codes = new Uint32Array(index.count).fill(NO_CODE);
  const it = new Interner();
  const n = items.length;
  const date = parseDateDim(dim);
  if (date) {
    const imported = date.basis === "imported";
    for (let i = 0; i < n; i++) {
      const o = items[i]!;
      const t = imported ? c.tAdded[o]! : writtenAt(index, o);
      if (!Number.isFinite(t)) continue;
      switch (date.grain) {
        case "day": {
          const d = localDay(t);
          codes[o] = it.num(d, (x) => {
            const [y, m, dd] = civilFromDays(x);
            return [`${y}-${pad2(m)}-${pad2(dd)}`, dayLabel(x), x];
          });
          break;
        }
        case "week": {
          const w = isoWeek(localDay(t));
          codes[o] = it.num(w.monday, (x) => [`${w.year}-W${pad2(w.week)}`, dayLabel(x), x]);
          break;
        }
        case "month": {
          const mi = monthIndexOfDay(localDay(t));
          codes[o] = it.num(mi, (x) => [`${Math.floor(x / 12)}-${pad2((x % 12) + 1)}`, monthLabel(x), x]);
          break;
        }
        case "year": {
          const y = civilFromDays(localDay(t))[0];
          codes[o] = it.num(y, (x) => [String(x), String(x), x]);
          break;
        }
        case "hour": {
          const h = localHour(t);
          codes[o] = it.num(h, (x) => [pad2(x), `${pad2(x)}:00`, x]);
          break;
        }
        case "weekday": {
          const wd = weekdayOfDay(localDay(t));
          codes[o] = it.num(wd, (x) => [String(x + 1), weekdayName(x), x]);
          break;
        }
        case "monthOfYear": {
          // Every year folded onto one cycle: key "01".."12", Jan first.
          const m = civilFromDays(localDay(t))[1];
          codes[o] = it.num(m, (x) => [pad2(x), monthName(x), x]);
          break;
        }
      }
    }
    return { dim, codes, keys: it.keys, labels: it.labels, order: it.order, isDate: true, grain: date.grain, basis: date.basis };
  }
  const plain = (fill: (o: number) => number) => {
    for (let i = 0; i < n; i++) {
      const o = items[i]!;
      codes[o] = fill(o);
    }
  };
  if (isLabelDim(dim) || dim === "yourFixes") {
    const { pack, field } = dim === "yourFixes" ? { pack: "correction", field: "fixes" } : parseLabelDim(dim);
    const col = labelColumn(index, pack, field);
    if (col && dim === ROLE_DIM) {
      // Function (anatomy): each role reads as the finer brain region it lands in; a value outside the pack has no region.
      plain((o) => {
        const v = labelValueId(col, o);
        const sub = v < 0 ? undefined : subregionOfRole(col.values[v] ?? "");
        return sub ? it.num(SUBREGIONS.indexOf(sub), () => [sub.key, sub.name, SUBREGIONS.indexOf(sub)]) : NO_CODE;
      });
    } else if (col) {
      plain((o) => {
        const v = labelValueId(col, o);
        if (v < 0) return NO_CODE;
        return it.num(v, (x) => {
          const value = col.values[x] ?? "";
          return [value, value, x];
        });
      });
    }
  } else {
    switch (dim) {
      case "space":
        plain((o) => {
          const s = c.space[o]!;
          const id = SPACE_ORDER[s];
          if (id === undefined || id === "none") return NO_CODE;
          return it.num(s, () => [id, spaceName(id as SpaceId), s]);
        });
        break;
      case "folder":
      case "folderPath":
        plain((o) => {
          const f = c.folder[o]!;
          if (f === NONE32 || f >= index.dicts.folders.size) return NO_CODE;
          return it.num(f, (x) => {
            const path = index.dicts.folders.get(x);
            return [path, path, 0];
          });
        });
        break;
      case "layer":
        plain((o) => {
          const l = c.layer[o]!;
          if (l === NONE8 || c.pop[o] !== Population.Note) return NO_CODE;
          return it.num(l, (x) => [String(x), String(x), x]);
        });
        break;
      case "source":
        plain((o) => {
          const s = c.source[o]!;
          const id = SOURCE_ORDER[s];
          return id === undefined ? NO_CODE : it.num(s, () => [id, id, s]);
        });
        break;
      case "project":
        plain((o) => {
          const p = c.project[o]!;
          if (p === NONE32 || p >= index.dicts.projects.size) return NO_CODE;
          return it.num(p, (x) => {
            const name = index.dicts.projects.get(x);
            return [name, name, 0];
          });
        });
        break;
      case "conversation":
        plain((o) => {
          const cv = c.conv[o]!;
          if (cv === NONE32 || cv >= index.convs.size) return NO_CODE;
          return it.num(cv, (x) => {
            const row = index.convs.get(x);
            return [row.id, row.title.trim() === "" ? row.id : row.title, row.startedAt];
          });
        });
        break;
      case "speaker":
        plain((o) => {
          if (c.pop[o] !== Population.Record) return NO_CODE;
          const s = c.speaker[o]!;
          const id = SPEAKER_ORDER[s];
          return id === undefined ? NO_CODE : it.num(s, () => [id, id, s]);
        });
        break;
      case "kind":
        plain((o) => {
          if (c.pop[o] === Population.Record) {
            // The first entry of a conversation stands for the conversation itself.
            return c.conv[o] !== NONE32 && c.idx[o] === 0 ? it.num(CONVERSATION_KIND, () => ["conversation", "conversation", CONVERSATION_KIND]) : NO_CODE;
          }
          const k = c.noteKind[o]!;
          if (k === NONE8) return NO_CODE;
          const id = NOTE_KIND_ORDER[k];
          return id === undefined ? NO_CODE : it.num(k, () => [id, id, k]);
        });
        break;
      case "layer2":
        // Vault note or record entry: the two populations of the figure.
        plain((o) => (c.pop[o] === Population.Record ? it.num(1, () => ["record", "Record", 1]) : it.num(0, () => ["note", "Note", 0])));
        break;
      case "filing":
        // Filed into an area, or not yet: every item has a value (an item with no area is "Not yet filed").
        plain((o) => {
          const id = SPACE_ORDER[c.space[o]!];
          const k = id === undefined || id === "none" ? 1 : 0;
          return it.num(k, () => [FILING_VALUES[k]!, FILING_WORD[FILING_VALUES[k]!]!, k]);
        });
        break;
      case "recency": {
        // Active, cooling or dormant by how long before your newest entry the item was written (Read's thresholds); undated items have no value.
        const newest = newestWritten(index);
        plain((o) => {
          const at = writtenAt(index, o);
          if (at !== at || newest !== newest) return NO_CODE;
          const r = RECENCY_VALUES.indexOf(recencyOfDays((newest - at) / 86_400_000));
          return it.num(r, () => [RECENCY_VALUES[r]!, RECENCY_WORD[RECENCY_VALUES[r]!]!, r]);
        });
        break;
      }
      case "hubType":
        // The kind of map a map is; every other note is "none" (Not a map); record entries carry no value.
        plain((o) => {
          if (c.pop[o] !== Population.Note) return NO_CODE;
          const h = c.hubType[o]!;
          const id = h === NONE8 ? undefined : HUB_TYPE_ORDER[h];
          return id === undefined ? it.num(HUB_TYPE_ORDER.length, () => ["none", "Not a map", HUB_TYPE_ORDER.length]) : it.num(h, () => [id, HUB_TYPE_WORD[id] ?? id, h]);
        });
        break;
      case "map": {
        const mapOf = mapOfNotes(index);
        plain((o) => {
          const h = mapOf[o]!;
          if (h === NONE32 || c.pop[o] !== Population.Note) return NO_CODE;
          return it.num(h, (x) => [index.ids.get(x), index.titles.get(x), x]);
        });
        break;
      }
      case "hubStatus": {
        // The status of the map a note belongs to (a map is its own): active, quiet or paused by how recently it grew.
        const mapOf = mapOfNotes(index);
        plain((o) => {
          const h = mapOf[o]!;
          if (h === NONE32 || c.pop[o] !== Population.Note) return NO_CODE;
          const s = c.hubStatus[h]!;
          const id = s === NONE8 ? undefined : HUB_STATUS_ORDER[s];
          // Words the person sees: map recency "quiet" reads "Cooling" and "paused" "Dormant" (ui/valueLabels.ts).
          return id === undefined ? NO_CODE : it.num(s, () => [id, HUB_STATUS_WORD[id] ?? id, s]);
        });
        break;
      }
      case "yourLabels":
        plain((o) => {
          for (let ci = 0; ci < index.labels.length; ci++) {
            const col = index.labels[ci]!;
            if (col.byUser[o] !== 1) continue;
            const v = labelValue(col, o);
            if (v === "") continue;
            return it.str(`${col.pack}/${col.field}=${v}`, `${fieldLabel(col.pack, col.field)}: ${v}`, ci);
          }
          return NO_CODE;
        });
        break;
      default:
        throw new CortexError("E_BAD_REQUEST", `unknown dimension ${String(dim)}`);
    }
  }
  return { dim, codes, keys: it.keys, labels: it.labels, order: it.order, isDate: false, grain: null, basis: null };
}

// ───────────────────────────── categories (merges, combines, Top N, sort) ─────────────────────────────

export interface CatInfo {
  key: string;
  label: string;
  kind: "value" | "none" | "other";
  /** Items. */
  count: number;
  /** Size measure: items or words. */
  size: number;
  /** Earliest written time (NaN when none is dated). */
  first: number;
  /** Latest written time. */
  last: number;
  order: number;
  /** Raw value keys folded into this category (Other, merges, combines). */
  members: string[];
}

export interface CategorySet {
  dim: DimId;
  list: CatInfo[];
  /** Category index per ordinal (valid for the items it was built from); NO_CODE when not categorised. */
  of: Uint32Array;
  total: number;
  totalSize: number;
  /** Every value category before Top N folding, largest first (for the stepper and Combine with…). */
  all: Category[];
}

export interface CategoryOptions {
  sort: AxisSpec["sort"];
  top: number | "all";
  size: ChartSpec["size"];
  merges?: Readonly<Record<string, string>>;
  combined?: Readonly<Record<string, readonly string[]>>;
  /** Names the person gave combined categories, by final category key (inline rename, CORTEX-UX §7.4). */
  names?: Readonly<Record<string, string>>;
  /** Fold beyond Top N into Other (never for time axes). */
  foldable: boolean;
  /** Keep the no-value bucket (false when "Hide items without a value" removed those items already). */
  keepNone: boolean;
  /** Hard cap on value categories regardless of Top N (dense grids). */
  cap?: number;
}

/** The prefix of the chart option that names a combined category: `rename:‹dim›=‹first value›` → the name. */
export const RENAME_OPTION_PREFIX = "rename:";

/** Names of combined categories on one dimension, from the chart's options. Blank or non-text values are ignored. */
export function combineNamesFor(spec: ChartSpec, dim: DimId): Record<string, string> {
  const out: Record<string, string> = {};
  const head = `${RENAME_OPTION_PREFIX}${dim}=`;
  for (const [k, v] of Object.entries(spec.options ?? {})) {
    if (!k.startsWith(head) || typeof v !== "string") continue;
    const name = v.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 60);
    if (name !== "") out[k.slice(head.length)] = name;
  }
  return out;
}

/** Chart-local combines for one dimension: `{ "<dim>=<first value>": [other values] }` or bare keys for x. */
export function combinesFor(spec: ChartSpec, dim: DimId, isX: boolean): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, vals] of Object.entries(spec.combined ?? {})) {
    if (!Array.isArray(vals)) continue;
    const eq = k.indexOf("=");
    let target: string;
    if (eq > 0 && k.slice(0, eq) === dim) target = k.slice(eq + 1);
    else if (eq < 0 && isX) target = k;
    else continue;
    out[target] = vals.filter((v): v is string => typeof v === "string");
  }
  return out;
}

export function buildCategories(index: DataIndex, items: ArrayLike<number>, dv: DimValues, opts: CategoryOptions): CategorySet {
  const words = index.cols.words;
  // 1. raw code → final key (global merges first, then chart-local combines).
  const into = new Map<string, string>();
  for (const [target, vals] of Object.entries(opts.combined ?? {})) for (const v of vals) if (v !== target) into.set(v, target);
  const finalCode = new Uint32Array(dv.keys.length);
  const finalKeys: string[] = [];
  const finalIndex = new Map<string, number>();
  const raw: string[][] = [];
  for (let code = 0; code < dv.keys.length; code++) {
    let key = dv.keys[code]!;
    const merged = opts.merges?.[key];
    if (merged !== undefined && merged !== "") key = merged;
    key = into.get(key) ?? key;
    let f = finalIndex.get(key);
    if (f === undefined) {
      f = finalKeys.length;
      finalKeys.push(key);
      finalIndex.set(key, f);
      raw.push([]);
    }
    raw[f]!.push(dv.keys[code]!);
    finalCode[code] = f;
  }
  const codeOfKey = new Map<string, number>();
  dv.keys.forEach((k, i) => codeOfKey.set(k, i));
  const labelOf = (f: number): string => {
    const key = finalKeys[f]!;
    const named = opts.names?.[key];
    if (named !== undefined && (opts.combined?.[key]?.length ?? 0) > 0) return named;
    const own = codeOfKey.get(key);
    return own !== undefined ? dv.labels[own]! : key;
  };
  const orderOf = (f: number): number => {
    let best = Number.POSITIVE_INFINITY;
    for (const k of raw[f]!) {
      const c = codeOfKey.get(k);
      if (c !== undefined) best = Math.min(best, dv.order[c]!);
    }
    return best;
  };
  // 2. tallies.
  const nf = finalKeys.length;
  const count = new Float64Array(nf + 1);
  const size = new Float64Array(nf + 1);
  const first = new Float64Array(nf + 1).fill(Number.POSITIVE_INFINITY);
  const last = new Float64Array(nf + 1).fill(Number.NEGATIVE_INFINITY);
  const NONE_SLOT = nf;
  const n = items.length;
  let total = 0;
  let totalSize = 0;
  for (let i = 0; i < n; i++) {
    const o = items[i]!;
    const code = dv.codes[o]!;
    const f = code === NO_CODE ? NONE_SLOT : finalCode[code]!;
    if (f === NONE_SLOT && !opts.keepNone) continue;
    const s = opts.size === "words" ? words[o]! : 1;
    count[f]! += 1;
    size[f]! += s;
    total += 1;
    totalSize += s;
    const t = writtenAt(index, o);
    if (Number.isFinite(t)) {
      if (t < first[f]!) first[f] = t;
      if (t > last[f]!) last[f] = t;
    }
  }
  const values: CatInfo[] = [];
  for (let f = 0; f < nf; f++) {
    if (count[f] === 0) continue;
    values.push({
      key: finalKeys[f]!,
      label: labelOf(f),
      kind: "value",
      count: count[f]!,
      size: size[f]!,
      first: Number.isFinite(first[f]!) ? first[f]! : Number.NaN,
      last: Number.isFinite(last[f]!) ? last[f]! : Number.NaN,
      order: orderOf(f),
      members: raw[f]!,
    });
  }
  const all: Category[] = [...values].sort((a, b) => b.count - a.count || a.order - b.order).slice(0, MAX_REPORTED_CATEGORIES).map((v) => ({ key: v.key, label: v.label, count: v.count }));
  // 3. Top N (and the hard cap) fold the smallest value categories into Other.
  let keep = values;
  let other: CatInfo | null = null;
  const limit = Math.min(opts.foldable && opts.top !== "all" ? opts.top : Number.POSITIVE_INFINITY, opts.cap ?? Number.POSITIVE_INFINITY);
  if (values.length > limit) {
    const ranked = [...values].sort((a, b) => b.size - a.size || b.count - a.count || a.order - b.order);
    keep = ranked.slice(0, limit);
    const rest = ranked.slice(limit);
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const c of rest) {
      if (Number.isFinite(c.first)) lo = Math.min(lo, c.first);
      if (Number.isFinite(c.last)) hi = Math.max(hi, c.last);
    }
    other = {
      key: OTHER_VALUE,
      label: "Other",
      kind: "other",
      count: rest.reduce((s, c) => s + c.count, 0),
      size: rest.reduce((s, c) => s + c.size, 0),
      first: Number.isFinite(lo) ? lo : Number.NaN,
      last: Number.isFinite(hi) ? hi : Number.NaN,
      order: Number.POSITIVE_INFINITY,
      members: rest.flatMap((c) => c.members),
    };
  }
  // 4. sort.
  sortCategories(keep, opts.sort, dv.isDate);
  const list = [...keep];
  if (other) list.push(other);
  if (count[NONE_SLOT]! > 0 && opts.keepNone) {
    list.push({
      key: NONE_VALUE,
      label: "",
      kind: "none",
      count: count[NONE_SLOT]!,
      size: size[NONE_SLOT]!,
      first: Number.isFinite(first[NONE_SLOT]!) ? first[NONE_SLOT]! : Number.NaN,
      last: Number.isFinite(last[NONE_SLOT]!) ? last[NONE_SLOT]! : Number.NaN,
      order: Number.POSITIVE_INFINITY,
      members: [],
    });
  }
  // 5. final category per ordinal.
  const pos = new Map<string, number>();
  list.forEach((c, i) => pos.set(c.kind === "none" ? "\u0000none" : c.key, i));
  const otherIdx = other ? list.indexOf(other) : -1;
  const finalToList = new Uint32Array(nf);
  for (let f = 0; f < nf; f++) finalToList[f] = pos.get(finalKeys[f]!) ?? (otherIdx >= 0 ? otherIdx : NO_CODE);
  const noneIdx = pos.get("\u0000none") ?? NO_CODE;
  const of = new Uint32Array(index.count).fill(NO_CODE);
  for (let i = 0; i < n; i++) {
    const o = items[i]!;
    const code = dv.codes[o]!;
    of[o] = code === NO_CODE ? noneIdx : finalToList[finalCode[code]!]!;
  }
  return { dim: dv.dim, list, of, total, totalSize, all };
}

export function sortCategories(cats: CatInfo[], sort: AxisSpec["sort"], isDate: boolean): void {
  const byOrder = (a: CatInfo, b: CatInfo) => a.order - b.order || a.label.localeCompare(b.label);
  if (sort === "count") cats.sort((a, b) => b.size - a.size || b.count - a.count || byOrder(a, b));
  else if (sort === "name") cats.sort((a, b) => a.label.localeCompare(b.label, "en-GB", { numeric: true, sensitivity: "base" }) || byOrder(a, b));
  else if (isDate) cats.sort(byOrder);
  else cats.sort((a, b) => (Number.isFinite(a.first) ? a.first : Infinity) - (Number.isFinite(b.first) ? b.first : Infinity) || byOrder(a, b));
}

// ───────────────────────────── preparing a chart ─────────────────────────────

export interface Prepared {
  index: DataIndex;
  spec: ChartSpec;
  vis: VisibilityParams;
  /** Final members (visible, in the period, passing the filters and the no-value rule), ascending. */
  members: Uint32Array;
  now: number;
  top: number | "all";
  salt: number;
  isCancelled: (() => boolean) | undefined;
  /** The visible stage, when the caller measured it. */
  stage: ChartStage | undefined;
  /** Dimension values read once and shared by the layout. */
  dims: Map<DimId, DimValues>;
}

/** Seeded uniform in [0, 1) for item `o`, stream `k`. */
export function rnd(p: Prepared, o: number, k: number): number {
  return hashUnit(o, p.salt + k * 0x3c6ef372);
}

export function dimOf(p: Prepared, dim: DimId): DimValues {
  let dv = p.dims.get(dim);
  if (!dv) {
    dv = readDim(p.index, dim, p.members);
    p.dims.set(dim, dv);
  }
  return dv;
}

/** Validate and complete a spec coming over the wire (unknown chart → E_BAD_REQUEST). */
export function normaliseSpec(spec: ChartSpec): ChartSpec {
  if (!spec || typeof spec !== "object") throw new CortexError("E_BAD_REQUEST", "chart spec missing");
  try {
    chartDef(spec.chart);
  } catch {
    throw new CortexError("E_BAD_REQUEST", `unknown chart ${String(spec.chart)}`);
  }
  const sort = (s: unknown): AxisSpec["sort"] => (s === "name" || s === "count" || s === "date" ? s : "count");
  const axis = (a: AxisSpec | null | undefined): AxisSpec | null => (a && typeof a.dim === "string" ? { dim: a.dim, sort: sort(a.sort) } : null);
  const x = axis(spec.x) ?? { dim: "space", sort: "count" };
  return {
    chart: spec.chart,
    x,
    y: axis(spec.y),
    colour: typeof spec.colour === "string" ? spec.colour : null,
    size: spec.size === "words" ? "words" : "entries",
    filter: Array.isArray(spec.filter) ? spec.filter.filter((f) => f && typeof f.dim === "string" && typeof f.value === "string") : [],
    hideNoValue: spec.hideNoValue === true,
    merges: spec.merges && typeof spec.merges === "object" ? spec.merges : {},
    combined: spec.combined && typeof spec.combined === "object" ? spec.combined : {},
    top: clampTop(spec.top),
    options: spec.options && typeof spec.options === "object" ? spec.options : {},
    ...(typeof spec.focusMap === "number" ? { focusMap: spec.focusMap } : {}),
  };
}

/** The dimensions a chart lays items out by (their no-value items leave with "Hide items without a value"). */
export type AxisDims = DimId[];

/**
 * Compute the members of a chart: visibility, period, filters, the caller's narrowing and, for `axes`, the
 * "Hide items without a value" rule.
 */
export function prepareChart(ctx: ChartContext, axes: (spec: ChartSpec) => AxisDims): Prepared {
  const index = ctx.index;
  const spec = normaliseSpec(ctx.spec);
  const vis = ctx.visibility ?? defaultVisibility(index.count);
  const now = ctx.now ?? Date.now();
  const salt = Math.floor((ctx.seed?.(0) ?? 0) * 0x7fffffff) | 0;
  const p: Prepared = { index, spec, vis, members: new Uint32Array(0), now, top: clampTop(spec.top), salt, isCancelled: ctx.isCancelled, stage: ctx.stage, dims: new Map() };
  const restrict = ctx.members && ctx.members.length > 0 ? ctx.members : null;
  const count = index.count;
  let cand: Uint32Array;
  if (restrict) {
    cand = new Uint32Array(restrict.length);
    let m = 0;
    for (let i = 0; i < restrict.length; i++) {
      const o = restrict[i]!;
      if (o < count && isVisible(index, o, vis) && (vis.period === null || inPeriod(writtenAt(index, o), vis.period))) cand[m++] = o;
    }
    cand = cand.slice(0, m).sort();
  } else {
    const tmp = new Uint32Array(count);
    let m = 0;
    for (let o = 0; o < count; o++) {
      if ((o & 0xffff) === 0) checkCancelled(ctx.isCancelled);
      if (isVisible(index, o, vis) && (vis.period === null || inPeriod(writtenAt(index, o), vis.period))) tmp[m++] = o;
    }
    cand = tmp.slice(0, m);
  }
  p.members = cand;
  // Filters: OR within a dimension, AND across dimensions (like tokens, H4).
  if (spec.filter.length > 0) {
    const byDim = new Map<DimId, Set<string>>();
    for (const f of spec.filter) {
      const set = byDim.get(f.dim) ?? new Set<string>();
      set.add(f.value);
      byDim.set(f.dim, set);
    }
    for (const [dim, want] of byDim) {
      const dv = readDim(index, dim, p.members);
      p.dims.set(dim, dv);
      const merges = spec.merges[dim];
      p.members = p.members.filter((o) => {
        const code = dv.codes[o]!;
        if (code === NO_CODE) return want.has(NONE_VALUE);
        const key = dv.keys[code]!;
        const merged = merges?.[key];
        return want.has(key) || (merged !== undefined && want.has(merged));
      });
    }
  }
  if (spec.hideNoValue) {
    for (const dim of axes(spec)) {
      const dv = dimOf(p, dim);
      p.members = p.members.filter((o) => dv.codes[o] !== NO_CODE);
    }
  }
  checkCancelled(ctx.isCancelled);
  return p;
}

/** Category set for an axis of the chart, honouring merges, combines, Top N and the axis sort. */
export function axisCategories(p: Prepared, dim: DimId, sort: AxisSpec["sort"], isX: boolean, extra: Partial<CategoryOptions> = {}): CategorySet {
  const dv = dimOf(p, dim);
  return buildCategories(p.index, p.members, dv, {
    sort,
    top: p.top,
    size: p.spec.size,
    merges: p.spec.merges[dim] ?? {},
    combined: combinesFor(p.spec, dim, isX),
    names: combineNamesFor(p.spec, dim),
    foldable: !dv.isDate,
    keepNone: !p.spec.hideNoValue,
    ...extra,
  });
}

// ───────────────────────────── time axes ─────────────────────────────

/**
 * Initial axis range for charts (the period is the user's, H4): t1 = now (or the newest item, if a clock skew
 * dated one later); t0 = 1 January of the year in which cumulative dated items first reach 1% of all dated items,
 * so a handful of ancient outliers never squashes the axis. `times` sorted ascending (no NaN).
 */
export function autoWindow(times: Float64Array | readonly number[], now = Date.now()): TimeWindow {
  const n = times.length;
  if (n === 0) return [new Date(new Date(now).getFullYear(), 0, 1).getTime(), now];
  const k = Math.max(0, Math.ceil(n * 0.01) - 1);
  const t = times[k] as number;
  return [new Date(new Date(t).getFullYear(), 0, 1).getTime(), Math.max(now, times[n - 1] as number)];
}

/** Time of an item on a chart's time axis (written, or imported for "…:imported" date dimensions). */
export function axisTime(p: Prepared, o: number, basis: "written" | "imported" | null): number {
  return basis === "imported" ? p.index.cols.tAdded[o]! : writtenAt(p.index, o);
}

/** The chart's time window: the period, else autoWindow over the members' dates. */
export function chartWindow(p: Prepared, basis: "written" | "imported" | null): TimeWindow {
  if (p.vis.period) return [p.vis.period[0], p.vis.period[1]];
  const times = new Float64Array(p.members.length);
  let m = 0;
  for (let i = 0; i < p.members.length; i++) {
    const t = axisTime(p, p.members[i]!, basis);
    if (Number.isFinite(t)) times[m++] = t;
  }
  const sorted = times.slice(0, m).sort();
  return autoWindow(sorted, p.now);
}

export type BinGrain = "day" | "week" | "month";

/** Bins between t0 and t1 aligned to local days, ISO weeks or months. */
export interface Bins {
  grain: BinGrain;
  /** Bin start times (epoch ms), plus the end of the last bin: length = count + 1. */
  edges: number[];
  count: number;
  /** Bin of a time; -1 outside. */
  of(t: number): number;
  /** Compact label of bin i ("3 Nov", "Nov 2026"). */
  label(i: number): string;
}

export function pickGrain(t0: number, t1: number, requested?: DateGrain | null): BinGrain {
  if (requested === "day" || requested === "week" || requested === "month") {
    const spanDays = (t1 - t0) / DAY_MS;
    if (requested === "day" && spanDays > 400) return spanDays > 2900 ? "month" : "week";
    if (requested === "week" && spanDays > 2900) return "month";
    return requested;
  }
  if (requested === "year") return "month";
  const spanDays = (t1 - t0) / DAY_MS;
  return spanDays <= 120 ? "day" : spanDays <= 365 * 3 ? "week" : "month";
}

export function makeBins(t0: number, t1: number, grain: BinGrain): Bins {
  const d0 = localDay(t0);
  const d1 = localDay(Math.max(t0, t1));
  const startDays: number[] = [];
  if (grain === "day") for (let d = d0; d <= d1; d++) startDays.push(d);
  else if (grain === "week") for (let d = d0 - weekdayOfDay(d0); d <= d1; d += 7) startDays.push(d);
  else for (let mi = monthIndexOfDay(d0); dayOfMonthIndex(mi) <= d1; mi++) startDays.push(dayOfMonthIndex(mi));
  const nextStart =
    grain === "day" ? (startDays[startDays.length - 1] ?? d0) + 1 : grain === "week" ? (startDays[startDays.length - 1] ?? d0) + 7 : dayOfMonthIndex(monthIndexOfDay(startDays[startDays.length - 1] ?? d0) + 1);
  const edgeDays = [...startDays, nextStart];
  const edges = edgeDays.map(dayStartMs);
  const count = startDays.length;
  const first = startDays[0] ?? d0;
  return {
    grain,
    edges,
    count,
    of(t: number): number {
      if (!Number.isFinite(t)) return -1;
      const d = localDay(t);
      if (d < first || d >= nextStart) return -1;
      if (grain === "day") return d - first;
      if (grain === "week") return Math.floor((d - first) / 7);
      return monthIndexOfDay(d) - monthIndexOfDay(first);
    },
    label(i: number): string {
      const d = edgeDays[i] ?? first;
      if (grain === "month") return monthLabel(monthIndexOfDay(d));
      const [, m, dd] = civilFromDays(d);
      return `${dd} ${monthName(m)}`;
    },
  };
}

/** Year / month tick marks for a time axis between t0 and t1 (at most ~14 labels). */
export function timeTicks(t0: number, t1: number): { t: number; label: string; major: boolean }[] {
  const out: { t: number; label: string; major: boolean }[] = [];
  const d0 = localDay(t0);
  const d1 = localDay(t1);
  const m0 = monthIndexOfDay(d0);
  const m1 = monthIndexOfDay(d1);
  const months = m1 - m0 + 1;
  const step = months <= 14 ? 1 : months <= 30 ? 3 : months <= 60 ? 6 : 12;
  if (months <= 2) {
    const dayStep = d1 - d0 <= 16 ? 1 : 7;
    for (let d = d0; d <= d1; d += dayStep) {
      const [, m, dd] = civilFromDays(d);
      out.push({ t: dayStartMs(d), label: `${dd} ${monthName(m)}`, major: dd === 1 });
    }
    return out;
  }
  for (let mi = m0 + 1; mi <= m1; mi++) {
    const isYear = mi % 12 === 0;
    if (!isYear && (mi % step !== 0 || step === 12)) continue;
    const t = dayStartMs(dayOfMonthIndex(mi));
    if (t < t0 || t > t1) continue;
    out.push({ t, label: isYear ? String(Math.floor(mi / 12)) : monthName((mi % 12) + 1), major: isYear });
  }
  return out;
}

// ───────────────────────────── frame and builder ─────────────────────────────

/** The flat chart frame in world units (x ∈ [-6.5, 6.5], y ∈ [-4, 4]). */
export const FRAME = { halfW: 6.5, halfH: 4 } as const;
/** Default plot area for charts with labels on the left and an axis at the bottom. */
export const PLOT = { left: -4.4, right: 5.6, bottom: -3.1, top: 3.6 } as const;

export interface PlotRect {
  left: number;
  right: number;
  bottom: number;
  top: number;
}

/**
 * The plot area for a stage: the same margins as PLOT (2.1 units of labels at the left, 0.9 at the right, 0.4 above and
 * 0.9 below) round a frame shaped like the stage, so a chart fills the stage's usable rectangle. Without a stage, or on
 * the usual one, it is PLOT itself.
 */
export function plotRect(stage: ChartStage | null | undefined): PlotRect {
  const f = frameUnits(stage);
  return { left: -f.w / 2 + 2.1, right: f.w / 2 - 0.9, bottom: -f.h / 2 + 0.9, top: f.h / 2 - 0.4 };
}
/** Depth jitter of flat charts so the glow reads as a slab, not a sheet. */
export const FLAT_Z = 0.12;

export interface Rect2 {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type Mark = OverlayModel["marks"][number];

export class ChartBuilder {
  readonly arr: Float32Array;
  readonly items: OverlayItem[] = [];
  readonly marks: Mark[] = [];
  readonly readings: ChartReading[] = [];
  /** Mark index per ordinal (-1 = none), for outlining the marks that contain a map's sources. */
  readonly markOf: Int32Array;
  categories: Category[] | undefined;
  sparse: { key: string; count: number }[] = [];
  /** True when the layout draws (or deliberately leaves out) its own counts, so the generic cell counts are skipped. */
  ownCounts = false;
  /** The members of the marks left unnamed at layout time (annotations.ts); the overlay names them when zoomed in. */
  readonly zoomMembers: { mark: number; members: number[] }[] = [];

  constructor(readonly p: Prepared) {
    this.arr = new Float32Array(p.index.count * 3).fill(Number.NaN);
    this.markOf = new Int32Array(p.index.count).fill(-1);
  }

  place(o: number, x: number, y: number, z: number, mark = -1): void {
    const i = o * 3;
    this.arr[i] = x;
    this.arr[i + 1] = y;
    this.arr[i + 2] = z;
    if (mark >= 0) this.markOf[o] = mark;
  }

  /** Place on the flat plane with the standard depth jitter. */
  flat(o: number, x: number, y: number, mark = -1): void {
    this.place(o, x, y, (rnd(this.p, o, 7) - 0.5) * FLAT_Z, mark);
  }

  mark(ref: ChartRef, label: string, count: number, r: Rect2, z0 = -0.1, z1 = 0.1): number {
    this.marks.push({ key: refKey(ref), label, count, bounds: { min: [Math.min(r.x0, r.x1), Math.min(r.y0, r.y1), z0], max: [Math.max(r.x0, r.x1), Math.max(r.y0, r.y1), z1] } });
    return this.marks.length - 1;
  }

  label(at: Vec3, text: string, style: "box" | "tile" | "axis" | "muted" | "title", align: "left" | "center" | "right" = "center", ref?: ChartRef, rotate?: number): void {
    const item: OverlayItem = { type: "label", at, text, style, align };
    if (ref) item.key = refKey(ref);
    if (rotate !== undefined && rotate !== 0) item.rotate = rotate;
    this.items.push(item);
  }

  line(a: Vec3, b: Vec3, alpha: number, dashed = false): void {
    this.items.push(dashed ? { type: "line", a, b, alpha, dashed: true } : { type: "line", a, b, alpha });
  }

  poly(points: Vec3[], alpha: number, closed = false): void {
    if (points.length < 2) return;
    this.items.push(closed ? { type: "polyline", points, alpha, closed: true } : { type: "polyline", points, alpha });
  }

  rect(r: Rect2, alpha: number, fill?: number, z = 0): void {
    const item: OverlayItem = { type: "rect", min: [Math.min(r.x0, r.x1), Math.min(r.y0, r.y1), z], max: [Math.max(r.x0, r.x1), Math.max(r.y0, r.y1), z], alpha };
    if (fill !== undefined) item.fill = fill;
    this.items.push(item);
  }

  reading(r: ChartReading): void {
    if (this.readings.length < MAX_READINGS) this.readings.push(r);
  }

  thin(key: string, count: number): void {
    if (count < THIN_GROUP) this.sparse.push({ key, count });
  }

  finish(camera: ArrangementResult["camera"]): ArrangementResult {
    if (this.p.spec.focusMap !== undefined) ringMapSources(this);
    addAnnotations(this);
    const out: ArrangementResult = { arr: this.arr, overlay: { items: this.items, marks: this.marks }, camera: fillStage(camera, this.arr, this.p.stage), readings: this.readings.slice(0, MAX_READINGS) };
    if (this.categories) out.categories = this.categories;
    if (this.zoomMembers.length > 0) out.zoomMembers = this.zoomMembers;
    if (this.sparse.length > 0) out.sparse = this.sparse;
    return out;
  }
}

/** Camera for flat charts: fitted to the frame, Keep upright on (flat charts switch it on by themselves). */
export function flatCamera(): ArrangementResult["camera"] {
  return { centre: [0, 0, 0], radius: Math.hypot(FRAME.halfW, FRAME.halfH) * 0.98, tiltDeg: 0, keepUpright: true, half: { w: FRAME.halfW, h: FRAME.halfH } };
}

/**
 * A flat camera fitted to the usual frame is re-fitted to the frame of this stage (`frameUnits`), widened where a
 * placed point lies outside it, so the chart fills the stage's usable rectangle. Any other camera is left alone.
 */
export function fillStage(camera: ArrangementResult["camera"], arr: Float32Array, stage: ChartStage | null | undefined): ArrangementResult["camera"] {
  const half = camera.half;
  if (!half || !stage || camera.tiltDeg !== 0 || !camera.keepUpright) return camera;
  if (Math.abs(half.w - FRAME.halfW) > 1e-9 || Math.abs(half.h - FRAME.halfH) > 1e-9) return camera;
  const f = frameUnits(stage);
  let w = f.w / 2;
  let h = f.h / 2;
  for (let i = 0; i + 2 < arr.length; i += 3) {
    const x = arr[i]!;
    const y = arr[i + 1]!;
    if (Number.isFinite(x) && Math.abs(x) > w) w = Math.min(Math.abs(x) * 1.04, w * 1.5);
    if (Number.isFinite(y) && Math.abs(y) > h) h = Math.min(Math.abs(y) * 1.04, h * 1.5);
  }
  return { ...camera, half: { w, h }, radius: Math.hypot(w, h) * 0.98 };
}

export function volumeCamera(radius: number): ArrangementResult["camera"] {
  return { centre: [0, 0, 0], radius, tiltDeg: 8, keepUpright: false };
}

/** Camera of a perspective chart: its rows recede in depth under a camera pitched 20 degrees; `depth` is the deepest row's z. */
export const PERSPECTIVE_PITCH_DEG = -20;
export function perspectiveCamera(depth: number, stage?: ChartStage | null): ArrangementResult["camera"] {
  const flat = fillStage(flatCamera(), new Float32Array(0), stage);
  return { centre: [0, 0, depth / 2], radius: flat.radius * 1.05 + depth * 0.45, tiltDeg: -PERSPECTIVE_PITCH_DEG, keepUpright: true };
}

/** One entry of a vertical list of labels (a row name). */
export interface ListLabel {
  y: number;
  z?: number;
  text: string;
  ref?: ChartRef;
  /** Always shown (in the first column, whole), whatever the density. */
  keep?: boolean;
  style?: "axis" | "muted";
}

/**
 * Set a vertical list of labels at `xRight` (right-aligned, so the list grows outward to the left) for the room the
 * stage gives it (CHART-03). Rows `pitch` world units apart that a label cannot be given every row of stride that
 * label; on a stage wide enough for two columns the crowded list splits into two (alternate labels in the second
 * column, cut short to fit beside the first), on a narrow one it keeps a single column and shows fewer labels.
 * Returns the number of columns used.
 */
export function listStride(stage: ChartStage | undefined, pitch: number): { stride: number; columns: 1 | 2 } {
  const one = Math.max(1, Math.ceil(labelPitch(stage) / Math.max(1e-6, pitch)));
  const two = labelColumns(stage) === 2 && one > 1;
  return { stride: two ? Math.max(1, Math.ceil(one / 2)) : one, columns: two ? 2 : 1 };
}

export function columnLabels(b: ChartBuilder, rows: readonly ListLabel[], xRight: number, pitch: number): 1 | 2 {
  const stage = b.p.stage;
  const { stride, columns } = listStride(stage, pitch);
  const two = columns === 2;
  const second = xRight - labelWidth(stage, COLUMN_LABEL_CHARS) - 0.14;
  let shown = 0;
  rows.forEach((r, i) => {
    const pick = i % stride === 0;
    if (!pick && !r.keep) return;
    const col = two && pick && !r.keep ? shown % 2 : 0;
    if (pick) shown += 1;
    const text = col === 1 ? axisLabel(r.text, COLUMN_LABEL_CHARS) : axisLabel(r.text);
    b.label([col === 1 ? second : xRight, r.y, r.z ?? 0], text, r.style ?? "axis", "right", r.ref);
  });
  return two ? 2 : 1;
}

/**
 * The same thinning as columnLabels for charts that draw their row labels themselves (they have a second line, a
 * different anchor or a style of their own). `slot(i, keep)` says where the label of row i goes: null when the stage
 * leaves it no room (it stays in the tooltip), else its x and whether it is cut short for the second column.
 * `columns: 1` keeps one column however wide the stage is (labels that grow to the right have no room beside them).
 */
export function rowLabelSlots(stage: ChartStage | undefined, pitch: number, xRight: number, columns: 1 | 2 = 2): (i: number, keep?: boolean) => { x: number; short: boolean } | null {
  const plan = listStride(stage, pitch);
  const two = columns === 2 && plan.columns === 2;
  const stride = two ? plan.stride : Math.max(1, Math.ceil(labelPitch(stage) / Math.max(1e-6, pitch)));
  const second = xRight - labelWidth(stage, COLUMN_LABEL_CHARS) - 0.14;
  let shown = 0;
  return (i, keep = false) => {
    const pick = i % stride === 0;
    if (!pick && !keep) return null;
    const col = two && pick && !keep ? shown % 2 : 0;
    if (pick) shown += 1;
    return col === 1 ? { x: second, short: true } : { x: xRight, short: false };
  };
}

/** Empty result for charts that have nothing to show. */
export function emptyArrangement(count: number): ArrangementResult {
  return {
    arr: new Float32Array(count * 3).fill(Number.NaN),
    overlay: { items: [], marks: [] },
    camera: { centre: [0, 0, 0], radius: 6, tiltDeg: 0, keepUpright: true },
    readings: [],
  };
}

/** The empty chart for a prepared context (keeps the camera kind of the chart). */
export function emptyChart(p: Prepared): ArrangementResult {
  const flat = chartDef(p.spec.chart).flat;
  const b = new ChartBuilder(p);
  return b.finish(flat ? flatCamera() : volumeCamera(5.5));
}

/**
 * A map open in the reader (`spec.focusMap`): ring its sources in place (up to 400, a ring per particle) and put
 * a count chip at the chart's top right; beyond 400 the marks containing them are outlined instead.
 */
export function ringMapSources(b: ChartBuilder): void {
  const p = b.p;
  const hub = p.spec.focusMap;
  if (hub === undefined || hub < 0 || hub >= p.index.count) return;
  const { hubMembers, noteSources } = p.index.rel;
  const notes: number[] = [hub];
  if (hub + 1 < hubMembers.offsets.length) for (let k = hubMembers.offsets[hub]!; k < hubMembers.offsets[hub + 1]!; k++) notes.push(hubMembers.targets[k]!);
  const sources = new Set<number>();
  for (const nOrd of notes) {
    if (nOrd + 1 >= noteSources.offsets.length) continue;
    for (let k = noteSources.offsets[nOrd]!; k < noteSources.offsets[nOrd + 1]!; k++) sources.add(noteSources.targets[k]!);
  }
  const present: number[] = [];
  for (const o of sources) if (o < p.index.count && Number.isFinite(b.arr[o * 3]!)) present.push(o);
  present.sort((a, c) => a - c);
  if (present.length <= RING_LIMIT) {
    // Ring radius in CSS px around each particle; the overlay strokes it 1.5 px white (CORTEX-UX §7.1).
    for (const o of present) b.items.push({ type: "ring", at: [b.arr[o * 3]!, b.arr[o * 3 + 1]!, b.arr[o * 3 + 2]!], radius: 4, count: 1 });
  } else {
    const marks = new Set<number>();
    for (const o of present) {
      const m = b.markOf[o]!;
      if (m >= 0) marks.add(m);
    }
    for (const m of marks) {
      const mk = b.marks[m];
      if (mk) b.items.push({ type: "rect", min: mk.bounds.min, max: mk.bounds.max, alpha: 0.95 });
    }
  }
  b.label([FRAME.halfW - 0.1, FRAME.halfH - 0.15, 0], String(present.length), "box", "right", { copy: "chart.mapSources" });
}

// ───────────────────────────── packing helpers ─────────────────────────────

/** Group items by a category index: returns per-category item lists in ordinal order (stable layouts). */
export function bucketise(items: ArrayLike<number>, of: Uint32Array, n: number): Uint32Array[] {
  const counts = new Uint32Array(n);
  for (let i = 0; i < items.length; i++) {
    const c = of[items[i]!]!;
    if (c < n) counts[c]! += 1;
  }
  const out = Array.from({ length: n }, (_, i) => new Uint32Array(counts[i]!));
  const fill = new Uint32Array(n);
  for (let i = 0; i < items.length; i++) {
    const o = items[i]!;
    const c = of[o]!;
    if (c < n) out[c]![fill[c]!++] = o;
  }
  return out;
}

/**
 * Which labels of a plot to draw when they would touch: the biggest first, each only if it stands clear of the ones
 * already kept, i.e. its text box (`w` wide from `x`, `h` tall about `y`) does not meet theirs. Returns indices into `labels`.
 */
export function clearLabels(labels: readonly { x: number; y: number; w: number; size: number }[], h: number): Set<number> {
  const order = labels.map((_, i) => i).sort((a, c) => labels[c]!.size - labels[a]!.size || a - c);
  const kept: number[] = [];
  for (const i of order) {
    const a = labels[i]!;
    const clash = kept.some((k) => {
      const q = labels[k]!;
      return a.x < q.x + q.w && q.x < a.x + a.w && Math.abs(a.y - q.y) < h;
    });
    if (!clash) kept.push(i);
  }
  return new Set(kept);
}

/** Fill a rectangle evenly with `list` (R2 sequence plus a little per-item jitter). */
export function fillRect(b: ChartBuilder, list: ArrayLike<number>, r: Rect2, mark: number, pad = 0.04): void {
  const n = list.length;
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const px = Math.min(Math.abs(w) * 0.2, pad);
  const py = Math.min(Math.abs(h) * 0.2, pad);
  const cell = Math.sqrt(Math.abs(w * h) / Math.max(1, n)) * 0.35;
  for (let k = 0; k < n; k++) {
    const o = list[k]!;
    const jx = (rnd(b.p, o, 1) - 0.5) * cell;
    const jy = (rnd(b.p, o, 2) - 0.5) * cell;
    const x = r.x0 + px + r2u(k) * (w - 2 * px) + jx;
    const y = r.y0 + py + r2v(k) * (h - 2 * py) + jy;
    b.flat(o, clamp(x, Math.min(r.x0, r.x1), Math.max(r.x0, r.x1)), clamp(y, Math.min(r.y0, r.y1), Math.max(r.y0, r.y1)), mark);
  }
}

/** A sunflower disc of radius `radius` around (cx, cy) on the flat plane. */
export function fillDisc(b: ChartBuilder, list: ArrayLike<number>, cx: number, cy: number, radius: number, mark: number): void {
  const n = list.length;
  for (let k = 0; k < n; k++) {
    const o = list[k]!;
    const r = radius * Math.sqrt((k + 0.5) / Math.max(1, n));
    const a = k * GOLDEN_ANGLE + rnd(b.p, o, 3) * 0.3;
    b.flat(o, cx + Math.cos(a) * r, cy + Math.sin(a) * r, mark);
  }
}

/** Uniform direction on the unit sphere from two uniforms. */
export function sphereDir(u: number, v: number, out: Vec3): Vec3 {
  const z = 2 * u - 1;
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  const a = 2 * Math.PI * v;
  out[0] = s * Math.cos(a);
  out[1] = s * Math.sin(a);
  out[2] = z;
  return out;
}

/** Fill a ball (or a hollow shell for thin groups) around a centre. */
export function fillBall(b: ChartBuilder, list: ArrayLike<number>, c: Vec3, radius: number, mark: number, hollow = false, rInner = 0): void {
  const dir: Vec3 = [0, 0, 0];
  const r0c = Math.pow(rInner / Math.max(radius, 1e-6), 3);
  for (let k = 0; k < list.length; k++) {
    const o = list[k]!;
    sphereDir(rnd(b.p, o, 4), rnd(b.p, o, 5), dir);
    const u = rnd(b.p, o, 6);
    const r = hollow ? radius * (0.9 + 0.1 * u) : radius * Math.cbrt(r0c + (1 - r0c) * u);
    b.place(o, c[0] + dir[0] * r, c[1] + dir[1] * r, c[2] + dir[2] * r, mark);
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export interface Circle {
  x: number;
  y: number;
  r: number;
}

/**
 * Pack circles around the first (largest) one: each new circle takes the position tangent to two placed circles
 * (or to one) that lies closest to the origin without overlapping. Radii are processed in the given order.
 */
export function packCircles(radii: readonly number[], gap = 0.04): Circle[] {
  const out: Circle[] = [];
  const fits = (x: number, y: number, r: number) => out.every((c) => Math.hypot(c.x - x, c.y - y) >= c.r + r + gap - 1e-9);
  for (const r of radii) {
    if (out.length === 0) {
      out.push({ x: 0, y: 0, r });
      continue;
    }
    let best: Circle | null = null;
    const consider = (x: number, y: number) => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !fits(x, y, r)) return;
      if (!best || Math.hypot(x, y) < Math.hypot(best.x, best.y)) best = { x, y, r };
    };
    for (let i = 0; i < out.length; i++) {
      const a = out[i]!;
      for (let s = 0; s < 12; s++) {
        const ang = (s / 12) * Math.PI * 2;
        consider(a.x + Math.cos(ang) * (a.r + r + gap), a.y + Math.sin(ang) * (a.r + r + gap));
      }
      for (let j = i + 1; j < out.length; j++) {
        const c = out[j]!;
        const ra = a.r + r + gap;
        const rc = c.r + r + gap;
        const dx = c.x - a.x;
        const dy = c.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d === 0 || d > ra + rc || d < Math.abs(ra - rc)) continue;
        const l = (ra * ra - rc * rc + d * d) / (2 * d);
        const h = Math.sqrt(Math.max(0, ra * ra - l * l));
        const mx = a.x + (dx * l) / d;
        const my = a.y + (dy * l) / d;
        consider(mx + (dy * h) / d, my - (dx * h) / d);
        consider(mx - (dy * h) / d, my + (dx * h) / d);
      }
    }
    out.push(best ?? { x: out.reduce((m, c) => Math.max(m, c.x + c.r), 0) + r + gap, y: 0, r });
  }
  return out;
}

/**
 * Squarified treemap (Bruls, Huizing, van Wijk) of `values` inside `rect` (x0 < x1, y0 < y1); one rectangle per
 * value in the input order (zero values get an empty rectangle at the corner). Rows run along the shorter side.
 */
export function squarify(values: readonly number[], rect: Rect2): Rect2[] {
  const out: Rect2[] = values.map(() => ({ x0: rect.x0, y0: rect.y0, x1: rect.x0, y1: rect.y0 }));
  const idx = values
    .map((_, i) => i)
    .filter((i) => values[i]! > 0)
    .sort((a, b) => values[b]! - values[a]! || a - b);
  const total = idx.reduce((s, i) => s + values[i]!, 0);
  if (total <= 0) return out;
  let { x0, y0 } = rect;
  const { x1, y1 } = rect;
  const scale = ((x1 - x0) * (y1 - y0)) / total;
  const area = (i: number) => values[i]! * scale;
  const worst = (r: readonly number[], side: number) => {
    let s = 0;
    let mx = 0;
    let mn = Number.POSITIVE_INFINITY;
    for (const i of r) {
      const v = area(i);
      s += v;
      mx = Math.max(mx, v);
      mn = Math.min(mn, v);
    }
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  const layoutRow = (r: readonly number[]) => {
    const s = r.reduce((a, i) => a + area(i), 0);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w >= h) {
      const colW = h > 0 ? s / h : 0;
      let y = y0;
      for (const i of r) {
        const hh = colW > 0 ? area(i) / colW : 0;
        out[i] = { x0, y0: y, x1: x0 + colW, y1: y + hh };
        y += hh;
      }
      x0 += colW;
    } else {
      const rowH = w > 0 ? s / w : 0;
      let x = x0;
      for (const i of r) {
        const ww = rowH > 0 ? area(i) / rowH : 0;
        out[i] = { x0: x, y0, x1: x + ww, y1: y0 + rowH };
        x += ww;
      }
      y0 += rowH;
    }
  };
  let row: number[] = [];
  for (const i of idx) {
    const side = Math.min(x1 - x0, y1 - y0);
    if (row.length === 0 || worst([...row, i], side) <= worst(row, side)) row.push(i);
    else {
      layoutRow(row);
      row = [i];
    }
  }
  if (row.length > 0) layoutRow(row);
  return out;
}

/** Evaluate a cubic Bézier coordinate. */
export function bezier(a: number, b: number, c: number, d: number, u: number): number {
  const v = 1 - u;
  return v * v * v * a + 3 * v * v * u * b + 3 * v * u * u * c + u * u * u * d;
}

/** Linear interpolation of a per-bin series at a fractional bin position (bin centres at i + 0.5). */
export function sampleSeries(series: ArrayLike<number>, pos: number): number {
  const n = series.length;
  if (n === 0) return 0;
  const x = pos - 0.5;
  if (x <= 0) return series[0]!;
  if (x >= n - 1) return series[n - 1]!;
  const i = Math.floor(x);
  const f = x - i;
  return series[i]! * (1 - f) + series[i + 1]! * f;
}

/**
 * Direction on a unit sphere for particle `k` of `n` laid along `arms` spiral arms that wind `turns` times from one
 * pole to the other: a swirl texture instead of a random scatter. `phase` turns the whole pattern (a sphere's own
 * offset, so neighbours do not swirl in step). Stable for fixed inputs.
 */
export function swirlDir(k: number, n: number, arms: number, turns: number, phase: number, out: Vec3): Vec3 {
  const a = Math.max(1, Math.round(arms));
  const arm = k % a;
  const along = (Math.floor(k / a) + 0.5) / Math.max(1, Math.ceil(n / a));
  const z = 1 - 2 * along;
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  const ang = phase + (arm / a) * Math.PI * 2 + turns * Math.PI * 2 * along;
  out[0] = s * Math.cos(ang);
  out[1] = s * Math.sin(ang);
  out[2] = z;
  return out;
}
