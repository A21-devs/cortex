/**
 * Index-related worker methods: load/append/patch the shared index, search shards, related items and the token
 * query. Owner: E7.
 *  - loadIndex receives COPIES of the cache files: `record` (the runner's record part), `vault` (the plugin's vault
 *    part) and `corrections` (one part the plugin layers on top: the runner's pending delta and the live overlay
 *    of your corrections). They are assembled into an IndexStore whose buffers are registered as state-owned, so
 *    results never transfer (detach) them (TRANSFER-DETACH);
 *  - appendIndex accepts a delta part only for the loaded epoch and only when it starts at or below the loaded
 *    count; anything else fails with an "E_EPOCH" message and the plugin reloads;
 *  - patchIndex replaces flags of existing rows in place (no re-placement);
 *  - query combines tokens: OR within a kind, AND across kinds (H4); empty tokens light nothing.
 */
import { CortexError } from "../shared/errors";
import { IndexStore, decodePart } from "../shared/indexCodec";
import { ItemFlag, NONE32, NONE8, Population, type DataIndex } from "../shared/index-format";
import { LINE_FAMILIES, type IndexSummary, type LinesResult, type QueryParams, type QueryResult, type QueryToken, type RelatedParams, type RelatedResult } from "../shared/protocol/worker";
import { combineShards, decodeSearchIndex, type SearchShard } from "../shared/searchCodec";
import { FIGURE, poseXYZ, resolvePose, unposeXYZ } from "./anatomy";
import type { Pose } from "../shared/settings";
import { dimValue } from "./grouping";
import { labelColumn, labelValueId } from "./charts/common";
import { isLabelDim, parseLabelDim } from "../shared/dims";
import { sourceControl } from "./lines";
import { makerOrdinals, makerScope } from "./influence";
import type { WorkerState } from "./handler";
import { makeVisibility, matchQuery } from "./search";

/** The growable store behind `st.index` (WorkerState is E8's; the store lives beside it). */
const STORES = new WeakMap<WorkerState, IndexStore>();

function epochError(message: string): CortexError {
  return new CortexError("E_BAD_REQUEST", `E_EPOCH: ${message}`);
}

function summary(store: IndexStore, index: DataIndex): IndexSummary {
  return { count: index.count, notes: index.header.stats.notes, record: index.header.stats.record, seq: store.seq, epoch: store.epoch };
}

function requireStore(st: WorkerState): IndexStore {
  const store = STORES.get(st);
  if (!store || !st.index) throw new CortexError("E_BAD_REQUEST", "no index loaded");
  return store;
}

export function loadIndexOp(params: { record: ArrayBuffer; vault: ArrayBuffer | null; corrections: ArrayBuffer | null }, st: WorkerState): IndexSummary {
  if (!(params.record instanceof ArrayBuffer)) throw new CortexError("E_BAD_REQUEST", "loadIndex needs the record part");
  const parts = [decodePart(params.record)];
  if (params.vault) parts.push(decodePart(params.vault));
  if (params.corrections) parts.push(decodePart(params.corrections));
  const store = IndexStore.fromParts(parts, { part: "merged", onBuffer: (b) => st.stateOwned.add(b) });
  STORES.set(st, store);
  st.index = store.snapshot();
  return summary(store, st.index);
}

export function appendIndexOp(params: { epoch: string; fromCount: number; delta: ArrayBuffer }, st: WorkerState): IndexSummary {
  const store = requireStore(st);
  if (params.epoch !== store.epoch) throw epochError(`delta for ${params.epoch}, loaded ${store.epoch}`);
  if (params.fromCount > store.count) throw epochError(`delta starts at ${params.fromCount}, loaded ${store.count} rows`);
  const part = decodePart(params.delta);
  if (part.header.epoch !== store.epoch) throw epochError(`delta file of ${part.header.epoch}`);
  store.applyPart(part);
  st.index = store.snapshot();
  return summary(store, st.index);
}

export function patchIndexOp(params: { epoch: string; ordinals: Uint32Array; flags?: Uint32Array }, st: WorkerState): IndexSummary {
  const store = requireStore(st);
  if (params.epoch !== store.epoch) throw epochError(`patch for ${params.epoch}, loaded ${store.epoch}`);
  if (params.flags) {
    if (params.flags.length !== params.ordinals.length) throw new CortexError("E_BAD_REQUEST", "patchIndex: one flags value per ordinal");
    store.applyFlags(params.ordinals, params.flags);
  }
  st.index = store.snapshot();
  return summary(store, st.index);
}

// ───────────────────────────── search shards ─────────────────────────────

const LIVE_KEY = "live";

function searchTotals(st: WorkerState): { terms: number; docs: number } {
  return st.search ? { terms: st.search.header.terms, docs: st.search.header.docs } : { terms: 0, docs: 0 };
}

function registerShard(st: WorkerState, shard: SearchShard): void {
  st.stateOwned.add(shard.docs.buffer);
}

export function loadSearchOp(params: { shards: ArrayBuffer[] }, st: WorkerState): { terms: number; docs: number } {
  const shards = params.shards.map((b) => decodeSearchIndex(b));
  for (const s of shards) registerShard(st, s);
  st.search = shards.length > 0 ? combineShards(shards) : null;
  return searchTotals(st);
}

/**
 * Add one shard. The live shard (replacesLive) replaces the previous live shard and stays last; any other shard
 * replaces the shard with the same key in place, or is inserted just before the live shard.
 */
export function addSearchShardOp(params: { shard: ArrayBuffer; replacesLive: boolean }, st: WorkerState): { terms: number; docs: number } {
  const shard = decodeSearchIndex(params.shard);
  registerShard(st, shard);
  const list = [...(st.search?.shards ?? [])];
  if (list.length > 0 && list[0]!.header.epoch !== shard.header.epoch) {
    st.search = combineShards([shard]);
    return searchTotals(st);
  }
  const liveAt = list.findIndex((s) => s.header.key === LIVE_KEY);
  if (params.replacesLive || shard.header.key === LIVE_KEY) {
    if (liveAt >= 0) list.splice(liveAt, 1);
    list.push(shard);
  } else {
    const same = list.findIndex((s) => s.header.key === shard.header.key && shard.header.key !== "");
    if (same >= 0) list[same] = shard;
    else if (liveAt >= 0) list.splice(liveAt, 0, shard);
    else list.push(shard);
  }
  st.search = combineShards(list);
  return searchTotals(st);
}

// ───────────────────────────── related ─────────────────────────────

interface ReverseCaches {
  citedBy?: { offsets: Uint32Array; targets: Uint32Array };
  byConv?: { offsets: Uint32Array; targets: Uint32Array };
}
const REVERSE = new WeakMap<DataIndex, ReverseCaches>();
function reverse(index: DataIndex): ReverseCaches {
  let r = REVERSE.get(index);
  if (!r) {
    r = {};
    REVERSE.set(index, r);
  }
  return r;
}

/** CSR grouping: key per ordinal (NONE32 = none) → ordinals with that key, ascending. */
function groupBy(count: number, keys: number, keyOf: (o: number, emit: (k: number) => void) => void): { offsets: Uint32Array; targets: Uint32Array } {
  const counts = new Uint32Array(keys + 1);
  for (let o = 0; o < count; o++) keyOf(o, (k) => counts[k + 1]!++);
  for (let k = 0; k < keys; k++) counts[k + 1]! += counts[k]!;
  const targets = new Uint32Array(counts[keys]!);
  const fill = counts.slice(0, keys);
  for (let o = 0; o < count; o++) keyOf(o, (k) => (targets[fill[k]!++] = o));
  return { offsets: counts, targets };
}

function citedByIndex(index: DataIndex): { offsets: Uint32Array; targets: Uint32Array } {
  const r = reverse(index);
  if (!r.citedBy) {
    const src = index.rel.noteSources;
    r.citedBy = groupBy(index.count, index.count, (o, emit) => {
      for (let k = src.offsets[o]!; k < src.offsets[o + 1]!; k++) {
        const t = src.targets[k]!;
        if (t < index.count) emit(t);
      }
    });
  }
  return r.citedBy;
}

function convIndex(index: DataIndex): { offsets: Uint32Array; targets: Uint32Array } {
  const r = reverse(index);
  if (!r.byConv) {
    const conv = index.cols.conv;
    const n = index.convs.size;
    r.byConv = groupBy(index.count, n, (o, emit) => {
      const c = conv[o]!;
      if (c !== NONE32 && c < n && index.cols.kind[o] !== NONE8) emit(c);
    });
  }
  return r.byConv;
}

const usable = (index: DataIndex, o: number): boolean => o < index.count && index.cols.kind[o] !== NONE8 && (index.cols.flags[o]! & ItemFlag.Excluded) === 0;

function slice(c: { offsets: Uint32Array; targets: Uint32Array }, row: number, index: DataIndex): number[] {
  if (row + 1 >= c.offsets.length) return [];
  const out: number[] = [];
  for (let k = c.offsets[row]!; k < c.offsets[row + 1]!; k++) {
    const t = c.targets[k]!;
    if (usable(index, t)) out.push(t);
  }
  return out;
}

/** Segments per source-line curve (one number with the always-on source lines, FIGURE.lines). */
export const CURVE_SEGMENTS = FIGURE.lines.selectionSegments;
/** Segment budget for one selection's lines. */
export const RELATED_LINE_BUDGET = 60_000;
const FAMILY_SOURCE = LINE_FAMILIES.indexOf("source");
const FAMILY_SPOKE = LINE_FAMILIES.indexOf("spoke");

interface LineBuilder {
  positions: number[];
  t: number[];
  family: number[];
  owner: number[];
  target: number[];
}

function pos(anat: Float32Array, o: number): [number, number, number] | null {
  const x = anat[o * 3];
  const y = anat[o * 3 + 1];
  const z = anat[o * 3 + 2];
  if (x === undefined || y === undefined || z === undefined || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [x, y, z];
}

/**
 * A source line from the source end (t = 0) to the note (t = 1): the same quadratic curve as the always-on source
 * lines (worker/lines.ts `sourceControl`, in the skeleton frame), posed like the view. `target` is the ordinal of the
 * entry end, which only decides the side for an entry exactly on the cord.
 */
function addCurve(b: LineBuilder, from: [number, number, number], to: [number, number, number], pose: Pose, owner: number, target: number): void {
  const a = unposeXYZ(pose, from[0], from[1], from[2]);
  const z = unposeXYZ(pose, to[0], to[1], to[2]);
  const ctrl = sourceControl(a, z, target % 2 === 0 ? 1 : -1);
  const point = (u: number): [number, number, number] => {
    const w0 = (1 - u) * (1 - u);
    const w1 = 2 * (1 - u) * u;
    const w2 = u * u;
    const q = poseXYZ(pose, w0 * a[0] + w1 * ctrl[0] + w2 * z[0], w0 * a[1] + w1 * ctrl[1] + w2 * z[1], w0 * a[2] + w1 * ctrl[2] + w2 * z[2]);
    return [q[0], q[1], q[2]];
  };
  let prev = point(0);
  for (let s = 1; s <= CURVE_SEGMENTS; s++) {
    const u = s / CURVE_SEGMENTS;
    const next = point(u);
    b.positions.push(...prev, ...next);
    b.t.push((s - 1) / CURVE_SEGMENTS, u);
    b.family.push(FAMILY_SOURCE);
    b.owner.push(owner);
    b.target.push(target);
    prev = next;
  }
}

function addSpoke(b: LineBuilder, from: [number, number, number], to: [number, number, number], owner: number, target: number): void {
  b.positions.push(...from, ...to);
  b.t.push(0, 1);
  b.family.push(FAMILY_SPOKE);
  b.owner.push(owner);
  b.target.push(target);
}

function finishLines(b: LineBuilder): LinesResult {
  return {
    positions: Float32Array.from(b.positions),
    t: Float32Array.from(b.t),
    family: Uint8Array.from(b.family),
    owner: Uint32Array.from(b.owner),
    target: Uint32Array.from(b.target),
    segments: b.family.length,
  };
}

/**
 * Everything one item is connected to (CORTEX-UX §6.9): a note's sources, a map's members, the messages of the
 * same conversation, the notes that cite an entry, the parent (-1 when none), and the selection's lines: source
 * lines (note → its sources, or every citing note → this entry) and, for a map, straight spokes to its members.
 */
export function relatedOp(params: RelatedParams, st: WorkerState, viewId: string): RelatedResult {
  const index = st.index;
  if (!index) throw new CortexError("E_BAD_REQUEST", "no index loaded");
  const o = params.ordinal;
  if (!Number.isInteger(o) || o < 0 || o >= index.count || index.cols.kind[o] === NONE8) throw new CortexError("E_BAD_REQUEST", "related: unknown ordinal");
  const rel = index.rel;
  const sources = slice(rel.noteSources, o, index);
  const members = slice(rel.hubMembers, o, index);
  let citedBy = slice(citedByIndex(index), o, index);
  const conv = index.cols.conv[o]!;
  let sameConversation: number[] = [];
  /** [source entry, note built from it] pairs whose lines are drawn: for an entry of a conversation, every note built from any of its messages. */
  const cites: [number, number][] = citedBy.map((n): [number, number] => [o, n]);
  if (conv !== NONE32) {
    sameConversation = slice(convIndex(index), conv, index);
    const idx = index.cols.idx;
    sameConversation.sort((a, b) => (idx[a] === NONE32 ? Infinity : idx[a]!) - (idx[b] === NONE32 ? Infinity : idx[b]!) || a - b);
    if (index.cols.pop[o] === Population.Record) {
      const seen = new Set<number>();
      cites.length = 0;
      for (const m of sameConversation) {
        for (const n of slice(citedByIndex(index), m, index)) {
          cites.push([m, n]);
          seen.add(n);
        }
      }
      citedBy = [...seen];
    }
  }
  const parentRaw = index.cols.parent[o]!;
  const parent = parentRaw !== NONE32 && usable(index, parentRaw) ? parentRaw : -1;

  const builder: LineBuilder = { positions: [], t: [], family: [], owner: [], target: [] };
  const anat = st.views.get(viewId)?.anat ?? null;
  if (anat && anat.length >= index.count * 3) {
    const pose = st.views.get(viewId)?.pose ?? resolvePose(undefined);
    const here = pos(anat, o);
    const budget = (): boolean => builder.family.length + CURVE_SEGMENTS <= RELATED_LINE_BUDGET;
    if (here) {
      for (const s of sources) {
        if (!budget()) break;
        const p = pos(anat, s);
        if (p) addCurve(builder, p, here, pose, o, s);
      }
      for (const m of members) {
        if (!budget()) break;
        const p = pos(anat, m);
        if (p) addSpoke(builder, here, p, o, m);
      }
      for (const [m, n] of cites) {
        if (!budget()) break;
        const from = m === o ? here : pos(anat, m);
        const p = pos(anat, n);
        if (from && p) addCurve(builder, from, p, pose, n, m);
      }
    }
  }
  return {
    sources: Uint32Array.from(sources),
    members: Uint32Array.from(members),
    sameConversation: Uint32Array.from(sameConversation),
    citedBy: Uint32Array.from(citedBy),
    parent,
    lines: finishLines(builder),
  };
}

// ───────────────────────────── query tokens ─────────────────────────────

/** Group tokens by kind: OR inside a group, AND between groups. Pure helper shared with tests. */
export function tokenGroups<T extends { kind: string }>(tokens: readonly T[]): T[][] {
  const by = new Map<string, T[]>();
  for (const t of tokens) {
    const list = by.get(t.kind) ?? [];
    list.push(t);
    by.set(t.kind, list);
  }
  return [...by.values()];
}

function badToken(t: QueryToken, why: string): CortexError {
  return new CortexError("E_BAD_REQUEST", `query token ${t.id}: ${why}`);
}

/** Whether an item's dimension key falls under a token's value: equal, or (folder paths) inside it. */
export function dimKeyMatches(dim: string, key: string, value: string): boolean {
  if (key === value) return true;
  return dim === "folderPath" && value !== "" && key.startsWith(`${value}/`);
}

/** A group token on `label:<pack>/*` selects everything labelled by that pack; its `value` is the version ("" = any). */
export function packWildcard(dim: string): string | null {
  return dim.startsWith("label:") && dim.endsWith("/*") ? dim.slice("label:".length, -2) : null;
}

/**
 * A tag: one value of a multi-valued label field (the session pack's topics). A group token on `label:<pack>/<field>`
 * selects every item carrying that value anywhere in its list, not only the first. Null when the dimension is not a
 * multi-valued label column (the token then falls back to the one-value reading).
 */
export function tagOrdinals(index: DataIndex, dim: string, value: string): number[] | null {
  if (!isLabelDim(dim as `label:${string}/${string}`) || packWildcard(dim) !== null) return null;
  const { pack, field } = parseLabelDim(dim as `label:${string}/${string}`);
  const col = labelColumn(index, pack, field);
  const multi = col?.multi;
  if (!col || !multi) return null;
  const id = col.values.indexOf(value);
  if (id < 0) return [];
  const out: number[] = [];
  for (let o = 0; o < index.count; o++) {
    if (index.cols.kind[o] === NONE8) continue;
    for (let k = multi.offsets[o]!; k < multi.offsets[o + 1]!; k++) {
      if (multi.targets[k] === id) {
        out.push(o);
        break;
      }
    }
  }
  return out;
}

/** Ordinals carrying any label value from one pack (at one version, or any). */
export function packOrdinals(index: DataIndex, pack: string, version: string): number[] {
  const cols = index.labels.filter((c) => c.pack === pack && (version === "" || c.packVersion === version));
  const out: number[] = [];
  for (let o = 0; o < index.count; o++) {
    if (index.cols.kind[o] === NONE8) continue;
    if (cols.some((c) => labelValueId(c, o) >= 0)) out.push(o);
  }
  return out;
}

/** Mark every ordinal one token selects (not filtered by visibility). */
function markToken(t: QueryToken, index: DataIndex, st: WorkerState, mark: Uint8Array, dimCache: Map<string, string[]>): void {
  const n = index.count;
  const byIds = (ids: readonly string[]): void => {
    for (const id of ids) {
      const o = index.ordinalOf(id);
      if (o >= 0) mark[o] = 1;
    }
  };
  const byRange = (range: readonly [number, number]): void => {
    const [a, b] = range;
    if (!(Number.isFinite(a) && Number.isFinite(b))) throw badToken(t, "range must be two epoch times");
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const col = index.cols.t;
    const pop = index.cols.pop;
    for (let o = 0; o < n; o++) {
      const v = col[o]!;
      if (v >= lo && v <= hi && (t.recordsOnly !== true || pop[o] === Population.Record)) mark[o] = 1;
    }
  };
  const byDim = (dim: NonNullable<QueryToken["dim"]>, value: string): void => {
    const pack = packWildcard(dim);
    if (pack !== null) {
      for (const o of packOrdinals(index, pack, value)) mark[o] = 1;
      return;
    }
    const makers = makerScope(dim);
    if (makers !== null) {
      for (const o of makerOrdinals(index, makers, value)) mark[o] = 1;
      return;
    }
    const tagged = tagOrdinals(index, dim, value);
    if (tagged !== null) {
      for (const o of tagged) mark[o] = 1;
      return;
    }
    let values = dimCache.get(dim);
    if (!values) {
      values = new Array<string>(n);
      for (let o = 0; o < n; o++) values[o] = index.cols.kind[o] === NONE8 ? "\u0000" : dimValue(index, o, dim);
      dimCache.set(dim, values);
    }
    for (let o = 0; o < n; o++) if (dimKeyMatches(dim, values[o]!, value)) mark[o] = 1;
  };
  switch (t.kind) {
    case "text": {
      if (typeof t.text !== "string") throw badToken(t, "text token without text");
      for (const o of matchQuery(st.search, index, t.text).keys()) mark[o] = 1;
      return;
    }
    case "group":
      if (!t.dim || typeof t.value !== "string") throw badToken(t, "group token needs a dimension and a value");
      byDim(t.dim, t.value);
      return;
    case "time":
      if (!t.range) throw badToken(t, "time token without a range");
      byRange(t.range);
      return;
    case "set":
      if (!Array.isArray(t.ids)) throw badToken(t, "set token without ids");
      byIds(t.ids);
      return;
    case "band":
      if (Array.isArray(t.ids)) byIds(t.ids);
      else if (t.range) byRange(t.range);
      else if (t.dim && typeof t.value === "string") byDim(t.dim, t.value);
      else throw badToken(t, "band token needs ids, a range or a dimension value");
      return;
  }
}

export function queryOp(params: QueryParams, st: WorkerState): QueryResult {
  const index = st.index;
  if (!index) throw new CortexError("E_BAD_REQUEST", "no index loaded");
  if (params.tokens.length === 0) return { ordinals: new Uint32Array(0), count: 0 };
  const n = index.count;
  const visible = makeVisibility(index, params.visibility);
  const dimCache = new Map<string, string[]>();
  let result: Uint8Array | null = null;
  for (const group of tokenGroups(params.tokens)) {
    const mark = new Uint8Array(n);
    for (const t of group) markToken(t, index, st, mark, dimCache);
    if (result) for (let o = 0; o < n; o++) result[o] = result[o]! & mark[o]!;
    else result = mark;
  }
  const out: number[] = [];
  if (result) for (let o = 0; o < n; o++) if (result[o] === 1 && visible(o)) out.push(o);
  return { ordinals: Uint32Array.from(out), count: out.length };
}
