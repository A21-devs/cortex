/**
 * Colours and the key model (same source of truth for `color` and key rows). Owner: E8.
 * CORTEX-UX §4.4–4.5, §5.3 (M8):
 *  - categorical: STICKY slots — each value keeps the slot recorded in colours.json (GroupingParams.slots);
 *    values without one take the next free slot by rank over everything indexed, and are returned in
 *    GroupingResult.newSlots for the plugin to persist; at most 8 hues; folded groups → Other (mist #b5bfcb);
 *    missing values → No value (slate #737b87); two different buckets;
 *  - age: a continuous ramp from spine position τ (PlacementResult.tau), not a dimension; undated → slate;
 *  - single: one slot for the whole population, or any colour (`hex`) (the haze takes a dim tint of it);
 *  - month dimensions list as a tree: a year row (counts of its months; hiding it hides them) over its month rows;
 *  - merges (global merge-groups corrections) are applied before counting; hidden groups fade to 6%.
 * White is reserved for hover, selection and birth flashes: nothing here ever returns white.
 */
import { builtinDim, parseDateDim, type DimId } from "../shared/dims";
import { CortexError } from "../shared/errors";
import { NONE32, Population, type DataIndex } from "../shared/index-format";
import { MONTH_RAMP, OTHER, ageColor, ageStops, bucketColor, hexToRgb, normaliseHex, rampAt } from "../shared/palette";
import type { ColourMode, GroupingParams, GroupingResult, LegendChild, LegendRow, LegendSection, MergeMap } from "../shared/protocol/worker";
import { NO_CODE, OTHER_VALUE, readDim } from "./charts/common";
import { ageOfTau, computeSpineTime, cordTau, layerVisible, normaliseVisibility, shownNow, tauOfTime, type SpineTime } from "./placement";

/** Value of an item for a dimension ("" = no value). */
export function dimValue(index: DataIndex, ordinal: number, dim: DimId): string {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= index.count) return "";
  const dv = readDim(index, dim, [ordinal]);
  const code = dv.codes[ordinal] as number;
  return code === NO_CODE ? "" : (dv.keys[code] ?? "");
}

/**
 * Sticky slot assignment: keep `existing` slots; give new values the next free slot (1..8) in rank order; values
 * beyond 8 hues get slot 0 (they are drawn as Other). The no-value key "" always gets 0.
 */
export function assignSlots(counts: ReadonlyMap<string, number>, existing: Readonly<Record<string, number>> = {}, fixedOrder?: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  // A slot stays reserved for its group even while the group is filtered out of this view, so it never
  // repaints when it comes back (CORTEX-UX §4.4 "colour follows the group").
  for (const [k, s] of Object.entries(existing)) {
    if (s < 1 || s > 8) continue;
    used.add(s);
    if (counts.has(k)) out.set(k, s);
  }
  const keys = [...counts.keys()].filter((k) => k !== "" && !out.has(k));
  if (fixedOrder) keys.sort((a, b) => (fixedOrder.indexOf(a) + 1 || 999) - (fixedOrder.indexOf(b) + 1 || 999));
  else keys.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
  for (const k of keys) {
    let slot = 0;
    for (let s = 1; s <= 8; s++) {
      if (!used.has(s)) {
        slot = s;
        used.add(s);
        break;
      }
    }
    out.set(k, slot);
  }
  if (counts.has("")) out.set("", 0);
  return out;
}

/** Key rows carry palette colours as 0..1 floats (rgbCss reads them so); the per-item `color` buffer carries sRGB bytes. */
const toRgb = (c: readonly [number, number, number]): [number, number, number] => [c[0], c[1], c[2]];
const toByte = (c: readonly [number, number, number]): [number, number, number] => [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];

/** Alpha of a hidden group (it fades to 6%, keeping the shape). */
export const HIDDEN_ALPHA = Math.round(0.06 * 255);

type Pop = { name: "notes" | "record"; mode: ColourMode; items: Uint32Array };

interface DimWork {
  /** Final (merged) key per ordinal; "" = no value. */
  keyOf: Map<number, string>;
  labels: Map<string, string>;
  order: Map<string, number>;
  slots: Map<string, number>;
  /** Month dimensions: the colour of a month key along the month ramp (null for a key that is not a month). */
  monthRgb?: (key: string) => [number, number, number] | null;
}

/** Read one dimension over `items`, applying global merges; counts are over everything given (sticky ranks). */
function workDim(index: DataIndex, dim: DimId, items: Uint32Array, merges: MergeMap, existing: Readonly<Record<string, number>>, light = false): DimWork {
  const dv = readDim(index, dim, items);
  const mg = merges[dim] ?? {};
  const keyOfCode: string[] = dv.keys.map((k) => {
    const m = mg[k];
    return m !== undefined && m !== "" ? m : k;
  });
  const labels = new Map<string, string>();
  const order = new Map<string, number>();
  dv.keys.forEach((k, code) => {
    labels.set(k, dv.labels[code] ?? k);
    order.set(k, dv.order[code] ?? code);
  });
  const keyOf = new Map<number, string>();
  const counts = new Map<string, number>();
  for (const o of items) {
    const code = dv.codes[o] as number;
    const key = code === NO_CODE ? "" : (keyOfCode[code] ?? "");
    keyOf.set(o, key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const key of counts.keys()) {
    if (!order.has(key)) order.set(key, Number.MAX_SAFE_INTEGER);
    if (!labels.has(key)) labels.set(key, key);
  }
  const monthRgb = isMonthDim(dim) ? monthRampFn(counts.keys(), light) : undefined;
  return { keyOf, labels, order, slots: assignSlots(counts, existing), ...(monthRgb ? { monthRgb } : {}) };
}

/** A month key as a running month number (year × 12 + month); NaN for any other key. */
export function monthNumber(key: string): number {
  const m = MONTH_KEY.exec(key);
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : Number.NaN;
}

/**
 * The colour of each month along MONTH_RAMP by its month number between the first and the last month present (oldest
 * violet, newest red; one month sits mid-ramp). Null when no key is a month.
 */
export function monthRampFn(keys: Iterable<string>, light: boolean): ((key: string) => [number, number, number] | null) | undefined {
  let first = Infinity;
  let last = -Infinity;
  for (const k of keys) {
    const n = monthNumber(k);
    if (Number.isNaN(n)) continue;
    if (n < first) first = n;
    if (n > last) last = n;
  }
  if (first > last) return undefined;
  const stops = light ? MONTH_RAMP.light : MONTH_RAMP.dark;
  return (key) => {
    const n = monthNumber(key);
    if (Number.isNaN(n)) return null;
    const c = rampAt(stops, last > first ? (n - first) / (last - first) : 0.5);
    return [c[0], c[1], c[2]];
  };
}

function popItems(index: DataIndex, pop: number): Uint32Array {
  const c = index.cols.pop;
  let n = 0;
  for (let i = 0; i < index.count; i++) if (c[i] === pop) n++;
  const out = new Uint32Array(n);
  n = 0;
  for (let i = 0; i < index.count; i++) if (c[i] === pop) out[n++] = i;
  return out;
}

/** The colour of a single-colour population: its own hex when it has one, else its palette slot. */
export function singleRgb(mode: { slot: number; hex?: string }, palette: GroupingParams["palette"], variant: "glow" | "light"): readonly [number, number, number] {
  const hex = mode.hex === undefined ? null : normaliseHex(mode.hex);
  return hex ? hexToRgb(hex) : bucketColor("value", mode.slot, palette, variant);
}

function colourModeOk(m: ColourMode | undefined): ColourMode {
  if (m && (m.kind === "age" || m.kind === "single" || m.kind === "categorical")) return m;
  return { kind: "age" };
}

/** Months group under years in the key (Written or Imported). */
export function isMonthDim(dim: DimId): boolean {
  return parseDateDim(dim)?.grain === "month";
}

const MONTH_KEY = /^(\d{4})-(\d{2})$/;

/** The year of a month key ("2024-03" → "2024"); null for any other key. */
export function yearOfMonthKey(key: string): string | null {
  return MONTH_KEY.exec(key)?.[1] ?? null;
}

/**
 * The month tree of a legend (V1.2): every month row moves under a year row (ascending years, months in their
 * order), the year row carrying the sum of its months' counts. Rows that are not months (Other, no value) stay
 * last at the top level. `isHidden` is the hidden state of a key; the year row hides and shows its months.
 */
export function monthTreeRows(rows: readonly LegendRow[], isHidden: (key: string) => boolean, yearRgb: [number, number, number], monthRgb?: (key: string) => [number, number, number] | null): LegendRow[] {
  const years = new Map<string, LegendRow[]>();
  const rest: LegendRow[] = [];
  for (const r of rows) {
    // Months past the 8 hues (fold off) are "other"-coloured rows but still months; only the no-value row ("") and
    // the folded Other row (OTHER_VALUE) fail the month pattern.
    const y = yearOfMonthKey(r.key);
    if (y === null) rest.push(r);
    else (years.get(y) ?? years.set(y, []).get(y)!).push(r);
  }
  const out: LegendRow[] = [];
  for (const y of [...years.keys()].sort()) {
    const months = (years.get(y) ?? []).sort((a, b) => (a.key < b.key ? -1 : 1));
    out.push({
      key: y,
      name: y,
      slot: 0,
      bucket: "other",
      rgb: yearRgb,
      notes: months.reduce((n, m) => n + m.notes, 0),
      record: months.reduce((n, m) => n + m.record, 0),
      hidden: isHidden(y),
      depth: 0,
      expandable: true,
      aggregate: true,
    });
    // The month rows take their colour from the month ramp (when given), the same colour the figure draws them in.
    for (const m of months) out.push({ ...m, depth: 1, parentKey: y, ...(monthRgb && monthRgb(m.key) ? { rgb: monthRgb(m.key) as [number, number, number] } : {}) });
  }
  return [...out, ...rest];
}

/** Folder-path rows: depth and parent from the path. */
function pathInfo(key: string): { depth: number; parentKey?: string } {
  const parts = key.split("/").filter((s) => s.length > 0);
  if (parts.length <= 1) return { depth: 0 };
  return { depth: parts.length - 1, parentKey: parts.slice(0, -1).join("/") };
}

/** A dated span in ms. */
interface Span {
  from: number;
  to: number;
}

/** The dated span of the notes (null when no note has a date). */
function notesSpan(index: DataIndex): Span | null {
  let from = Infinity;
  let to = -Infinity;
  for (let i = 0; i < index.count; i++) {
    if ((index.cols.pop[i] as number) !== Population.Note) continue;
    const t = index.cols.t[i] as number;
    if (!Number.isFinite(t)) continue;
    if (t < from) from = t;
    if (t > to) to = t;
  }
  return from <= to ? { from, to } : null;
}

/**
 * The record's spine time with its span widened to also cover the notes' dates (the union). Ranks still come from the
 * record's own times; only the linear share of the ramp stretches, so a note older or newer than the whole record takes
 * the end of the ramp instead of sharing the record's end colour. The same object when nothing is wider.
 */
export function unionSpineTime(st: SpineTime, notes: Span | null): SpineTime {
  if (notes === null || st.times.length === 0) return st;
  const tMin = Math.min(st.tMin, notes.from);
  const tMax = Math.max(st.tMax, notes.to);
  return tMin === st.tMin && tMax === st.tMax ? st : { ...st, tMin, tMax };
}

/** What one population's age colour is read against. */
interface AgeCtx {
  st: SpineTime;
  /** The notes' own span, used only when no record entry has a date. */
  own: Span | null;
  /** Record entries are placed by their time against `st` (a widened span) instead of by their own spine position. */
  rerank: boolean;
}

/**
 * τ for age colour: record entries have one; notes take the position their date would have among the record.
 * With no dated record entries (a vault-only index) the notes spread over their own dates instead (linearly).
 */
function tauFor(index: DataIndex, ctx: AgeCtx, o: number): number {
  const t = ctx.st.tau[o] as number;
  if (Number.isFinite(t)) return ctx.rerank ? tauOfTime(ctx.st, index.cols.t[o] as number) : t;
  if ((index.cols.pop[o] as number) !== Population.Note) return Number.NaN;
  const time = index.cols.t[o] as number;
  if (ctx.own === null) return tauOfTime(ctx.st, time);
  if (!Number.isFinite(time)) return Number.NaN;
  const f = ctx.own.to > ctx.own.from ? (time - ctx.own.from) / (ctx.own.to - ctx.own.from) : 0.5;
  return cordTau(f, f);
}

export function computeGrouping(index: DataIndex, params: GroupingParams): GroupingResult {
  if (params === null || typeof params !== "object") throw new CortexError("E_BAD_REQUEST", "grouping: params must be an object");
  const n = index.count;
  const vis = normaliseVisibility(params.visibility, n);
  const variant = params.light ? "light" : "glow";
  const palette = params.palette;
  // The figure's particles may be drawn from a colour theme's palette and ramp; the key (rows, swatches, gradient) keeps the own ones.
  const figPalette = params.figure?.palette ?? palette;
  const figAge = params.figure?.age ?? params.age;
  const merges: MergeMap = params.merges ?? {};
  const hidden = new Set(params.hiddenGroups ?? []);
  // The key bar and popover store hidden groups as "dim=value"; bare values are accepted too. A month is also
  // hidden when its year row is.
  const isHidden = (dim: DimId, key: string): boolean => {
    if (hidden.size === 0) return false;
    if (hidden.has(key) || hidden.has(`${dim}=${key}`)) return true;
    const y = isMonthDim(dim) ? yearOfMonthKey(key) : null;
    return y !== null && (hidden.has(y) || hidden.has(`${dim}=${y}`));
  };
  const slotsIn = params.slots ?? {};
  // A lit set (tokens or a traced set) narrows what the key counts to the lit items.
  const lit = params.lit instanceof Uint8Array && params.lit.length >= n ? params.lit : null;
  const counted = (o: number): boolean => shownNow(index, o, vis) && (lit === null || lit[o] === 1);
  const st = computeSpineTime(index);
  const noteSpan = notesSpan(index);
  const own = st.times.length === 0 ? noteSpan : null;
  // The Brain's age ramp spans the notes' dates AND the record's, so no note clamps to an end colour it does not reach.
  const union = unionSpineTime(st, noteSpan);
  const color = new Uint8Array(n * 4);
  const groupOf = new Uint32Array(n).fill(NONE32);
  const newSlots: Record<string, Record<string, number>> = {};
  const pops: [Pop, Pop] = [
    { name: "notes", mode: colourModeOk(params.notes), items: popItems(index, Population.Note) },
    { name: "record", mode: colourModeOk(params.record), items: popItems(index, Population.Record) },
  ];
  // One slot assignment per categorical dimension, ranked over EVERYTHING indexed (colour follows the group).
  const works = new Map<DimId, DimWork>();
  for (const p of pops) {
    if (p.mode.kind !== "categorical" || works.has(p.mode.dim)) continue;
    const dim = p.mode.dim;
    const using = pops.filter((q) => q.mode.kind === "categorical" && q.mode.dim === dim);
    const items = using.length === 1 ? p.items : Uint32Array.from([...pops[0].items, ...pops[1].items]);
    const existing = slotsIn[dim] ?? {};
    const w = workDim(index, dim, items, merges, existing, params.light === true);
    works.set(dim, w);
    const added: Record<string, number> = {};
    for (const [k, s] of w.slots) if (k !== "" && s >= 1 && existing[k] === undefined) added[k] = s;
    if (Object.keys(added).length > 0) newSlots[dim] = added;
  }
  const sections: LegendSection[] = [];
  let grandTotal = 0;
  const m0 = pops[0].mode;
  const m1 = pops[1].mode;
  const bothDim: DimId | null = m0.kind === "categorical" && m1.kind === "categorical" && m0.dim === m1.dim ? m0.dim : null;
  // Age on both populations (Same colour): one ramp, one key section, the record read against the same span.
  const bothAge = m0.kind === "age" && m1.kind === "age";
  const ageCtx = (p: Pop): AgeCtx => (p.name === "notes" ? { st: union, own, rerank: false } : bothAge ? { st: union, own, rerank: union !== st } : { st, own, rerank: false });

  const rowsFor = (dim: DimId, w: DimWork, members: Pop[]): LegendRow[] => {
    type Acc = { key: string; notes: number; record: number; bucket: "value" | "other" | "none"; slot: number };
    const acc = new Map<string, Acc>();
    let otherNotes = 0;
    let otherRecord = 0;
    for (const m of members) {
      for (const o of m.items) {
        if (!counted(o)) continue;
        const key = w.keyOf.get(o) ?? "";
        const slot = key === "" ? 0 : (w.slots.get(key) ?? 0);
        if (key !== "" && slot === 0 && params.fold) {
          if (m.name === "notes") otherNotes++;
          else otherRecord++;
          continue;
        }
        let a = acc.get(key);
        if (!a) acc.set(key, (a = { key, notes: 0, record: 0, bucket: key === "" ? "none" : slot === 0 ? "other" : "value", slot }));
        if (m.name === "notes") a.notes++;
        else a.record++;
      }
    }
    const byOrder = builtinDim(dim)?.ordered === true;
    const list = [...acc.values()].filter((a) => a.key !== "");
    // Values with a hue first (natural order or by size), then the ones drawn as Other.
    list.sort((a, b) => {
      if ((a.slot === 0) !== (b.slot === 0)) return a.slot === 0 ? 1 : -1;
      const d = byOrder ? (w.order.get(a.key) ?? 0) - (w.order.get(b.key) ?? 0) : b.notes + b.record - (a.notes + a.record);
      return d || (a.key < b.key ? -1 : 1);
    });
    // With an area in scope its group leads the key (the isolated area first).
    if (dim === "space" && vis.scope !== "all") {
      const at = list.findIndex((a) => a.key === vis.scope);
      if (at > 0) list.unshift(...list.splice(at, 1));
    }
    const out: LegendRow[] = [];
    const push = (a: Acc, name: string): void => {
      const pi = dim === "folderPath" && a.key !== "" ? pathInfo(a.key) : { depth: 0 };
      out.push({
        key: a.key,
        name,
        slot: a.slot,
        bucket: a.bucket,
        rgb: toRgb(bucketColor(a.bucket, a.slot, palette, variant)),
        notes: a.notes,
        record: a.record,
        hidden: isHidden(dim, a.key),
        ...(a.bucket === "none" && params.hideNoValue ? { dropped: true } : {}),
        depth: pi.depth,
        expandable: dim === "folderPath" && a.key !== "" && [...acc.keys()].some((k) => k.startsWith(`${a.key}/`)),
        ...(pi.parentKey !== undefined ? { parentKey: pi.parentKey } : {}),
      });
    };
    for (const a of list) push(a, w.labels.get(a.key) ?? a.key);
    if (otherNotes + otherRecord > 0) push({ key: OTHER_VALUE, notes: otherNotes, record: otherRecord, bucket: "other", slot: 0 }, "");
    const none = acc.get("");
    if (none) push(none, "");
    return isMonthDim(dim) ? monthTreeRows(out, (k) => isHidden(dim, k), toRgb(hexToRgb(OTHER[variant])), w.monthRgb) : out;
  };

  /** Subfolders of each Area or Folder group, counted over what the key counts (null for other dimensions). */
  const childrenFor = (dim: DimId, w: DimWork, members: Pop[], rows: readonly LegendRow[]): Record<string, LegendChild[]> | undefined => {
    if (dim !== "space" && dim !== "folder") return undefined;
    const parents = new Set(rows.filter((r) => r.bucket !== "none" && r.key !== OTHER_VALUE && r.key !== "").map((r) => r.key));
    if (parents.size === 0) return undefined;
    const items: number[] = [];
    for (const m of members) for (const o of m.items) if (counted(o)) items.push(o);
    const folders = dim === "space" ? readDim(index, "folder", items) : null;
    type Tally = { notes: number; record: number };
    const acc = new Map<string, Map<string, Tally>>();
    const add = (parent: string, child: string, pop: "notes" | "record"): void => {
      const byChild = acc.get(parent) ?? acc.set(parent, new Map()).get(parent)!;
      const t = byChild.get(child) ?? byChild.set(child, { notes: 0, record: 0 }).get(child)!;
      t[pop]++;
    };
    for (const m of members) {
      for (const o of m.items) {
        if (!counted(o)) continue;
        const key = w.keyOf.get(o) ?? "";
        if (folders) {
          if (!parents.has(key)) continue;
          const code = folders.codes[o] as number;
          add(key, code === NO_CODE ? "" : (folders.keys[code] ?? ""), m.name);
        } else {
          // Folder dimension: the row is the item's own folder; every ancestor row that exists gains the next level down.
          const segs = key.split("/").filter((x) => x.length > 0);
          let pre = "";
          for (let k = 0; k < segs.length - 1; k++) {
            pre = k === 0 ? (segs[0] as string) : `${pre}/${segs[k]}`;
            if (parents.has(pre)) add(pre, `${pre}/${segs[k + 1]}`, m.name);
          }
        }
      }
    }
    const out: Record<string, LegendChild[]> = {};
    for (const [parent, byChild] of acc) {
      const subs = [...byChild].filter(([k]) => k !== "" && k !== parent);
      if (subs.length === 0) continue;
      const list: LegendChild[] = subs
        .sort((a, b) => b[1].notes + b[1].record - (a[1].notes + a[1].record) || (a[0] < b[0] ? -1 : 1))
        .slice(0, 200)
        .map(([key, t]) => ({ key, name: key.split("/").filter((x) => x.length > 0).pop() ?? key, notes: t.notes, record: t.record }));
      // The same short name twice under one group: show the whole path so the rows stay apart.
      const seen = new Map<string, number>();
      for (const c of list) seen.set(c.name, (seen.get(c.name) ?? 0) + 1);
      for (const c of list) if ((seen.get(c.name) ?? 0) > 1) c.name = c.key;
      const row = rows.find((r) => r.key === parent);
      const direct = dim === "space" ? byChild.get("") : row ? { notes: row.notes, record: row.record } : undefined;
      if (direct && direct.notes + direct.record > 0) list.unshift({ key: parent, name: "", notes: direct.notes, record: direct.record, direct: true });
      out[parent] = list;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const rowIndex = new Map<string, Map<string, number>>();
  const addSection = (section: LegendSection, owner: string): void => {
    sections.push(section);
    const m = new Map<string, number>();
    section.rows.forEach((r, i) => m.set(r.key, i));
    rowIndex.set(owner, m);
    grandTotal += section.total;
  };
  let bothDone = false;
  for (const p of pops) {
    const mode = p.mode;
    if (mode.kind === "categorical") {
      if (bothDim !== null && bothDone) continue;
      const w = works.get(mode.dim) as DimWork;
      const members: Pop[] = bothDim !== null ? [...pops] : [p];
      bothDone = bothDim !== null;
      const rows = rowsFor(mode.dim, w, members);
      // Year rows of the month tree repeat their months' counts; they are not counted again.
      const total = rows.reduce((s, r) => (r.aggregate ? s : s + r.notes + r.record), 0);
      const children = childrenFor(mode.dim, w, members, rows);
      addSection({ population: bothDim !== null ? "both" : p.name, dim: mode.dim, rows, total, ...(children ? { children } : {}) }, bothDim !== null ? "both" : p.name);
    } else if (mode.kind === "single") {
      let count = 0;
      for (const o of p.items) if (counted(o)) count++;
      const rgb = toRgb(singleRgb(mode, palette, variant));
      const row: LegendRow = { key: "single", name: (mode.hex !== undefined && normaliseHex(mode.hex)) || "", slot: mode.slot, bucket: "value", rgb, notes: p.name === "notes" ? count : 0, record: p.name === "record" ? count : 0, hidden: false, depth: 0, expandable: false };
      addSection({ population: p.name, dim: "single", rows: [row], total: count }, p.name);
    } else {
      if (bothAge && p.name === "record") continue;
      const members: Pop[] = bothAge ? [...pops] : [p];
      let count = 0;
      let undated = 0;
      for (const m of members) {
        const ctx = ageCtx(m);
        for (const o of m.items) {
          if (!counted(o)) continue;
          count++;
          if (!Number.isFinite(tauFor(index, ctx, o))) undated++;
        }
      }
      const c = ageCtx(p);
      const stops = ageStops(params.light === true, params.age?.mode, params.age?.tintHue ?? null, params.age?.chroma);
      const owner = bothAge ? "both" : p.name;
      addSection({ population: owner, dim: "age", rows: [], gradient: { stops, from: c.own ? c.own.from : c.st.tMin, to: c.own ? c.own.to : c.st.tMax, undated }, total: count }, owner);
    }
  }

  // Per-item colour and group row.
  for (const p of pops) {
    const mode = p.mode;
    const rows = rowIndex.get(bothDim !== null ? "both" : p.name);
    const w = mode.kind === "categorical" ? works.get(mode.dim) : undefined;
    const single = mode.kind === "single" ? toByte(singleRgb(mode, figPalette, variant)) : null;
    const ageOf = ageCtx(p);
    for (const o of p.items) {
      if (!layerVisible(index, o, vis)) continue;
      let rgb: [number, number, number];
      let alpha = 255;
      let row = 0;
      if (mode.kind === "categorical" && w) {
        const key = w.keyOf.get(o) ?? "";
        const slot = key === "" ? 0 : (w.slots.get(key) ?? 0);
        const ramp = key !== "" && !(slot === 0 && params.fold) ? w.monthRgb?.(key) : null;
        rgb = ramp ? toByte(ramp) : toByte(bucketColor(key === "" ? "none" : slot === 0 ? "other" : "value", slot, figPalette, variant));
        if (key === "" && params.hideNoValue) alpha = 0;
        else if (isHidden(mode.dim, key)) alpha = HIDDEN_ALPHA;
        row = rows?.get(key !== "" && slot === 0 && params.fold ? OTHER_VALUE : key) ?? NONE32;
      } else if (single) {
        rgb = single;
      } else {
        rgb = toByte(ageColor(ageOfTau(tauFor(index, ageOf, o)), params.light === true, figAge?.mode, figAge?.tintHue ?? null, figAge?.chroma));
      }
      color[o * 4] = rgb[0];
      color[o * 4 + 1] = rgb[1];
      color[o * 4 + 2] = rgb[2];
      color[o * 4 + 3] = alpha;
      groupOf[o] = row;
    }
  }
  return { color, groupOf, legend: { sections, grandTotal, ...(lit ? { lit: grandTotal } : {}) }, newSlots };
}
