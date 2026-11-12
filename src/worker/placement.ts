/**
 * Data → body slots. Owner: E8. CORTEX-UX §6.3 (and the standing figure of v1.2) is normative (H8).
 *
 * Notes (brain): territories by area — azimuth wedges ∝ count^γ (γ = 0.6) starting at the frontal pole and
 * running first along the side that faces the home camera (the figure's right); inside a wedge, folders split
 * the elevation by the same rule and subfolders split the azimuth again (a nested treemap over the folded
 * surface). Or by role (the placement pack's role → region; unlabelled notes stay in their area wedge). Depth:
 * At the core = oldest (default) | newest | largest; vault notes use their `layer` (0–8) as the depth key and
 * their date within a layer. Maps sit at their members' centroid pushed out to the surface (+0.08).
 *
 * Record (brainstem, cord and nerves): spine position τ = 0.06 + 0.88 × (0.65 r + 0.35 ℓ) (r = rank among dated
 * entries, ℓ = linear calendar position), so time runs DOWN the cord: oldest at the brainstem, newest at the tip.
 * Each conversation is one nerve: it leaves the cord at τ(first message) through a 0.22 rootlet onto the course of
 * the spinal segment whose exit level is nearest (31 pairs, C1 … Co1), on alternating sides in start order (the
 * first to the figure's right, −X), f × the segment's full length long (f from the message count). Messages sit
 * at arc (i / (n − 1))^0.85 with scatter σ = 0.004 + 0.009 s, the outer 20% splaying down and outward; later parts
 * branch off as barbs (one per 180 messages, at most 4). Single entries sit in the cord core with |N(0, 0.7 r)|
 * radial jitter; undated entries (and reference documents, when shown) sit in the undated cloud below the tip.
 *
 * Births (intro): the spine first, top to bottom behind a travelling tip; each frond 0.08 s after the tip passes
 * its root, root → tip over 0.45 s; then the brain blooms deepest-first; maps ignite last.
 * Slot stability: recolouring never moves a point; scope and period never move a point; live arrivals take
 * new slots without moving others (incremental mode via the view's memo).
 */
import { CortexError } from "../shared/errors";
import { ItemFlag, ItemKind, NONE32, NONE8, Population, SOURCE_ORDER, SPACE_ORDER, type DataIndex, type LabelColumn } from "../shared/index-format";
import { Region, ROLE_TO_REGION, SUBREGIONS, subregionOfRole } from "../shared/packs";
import type { PlacementParams, PlacementResult, RegionLabel, SpineOrderParam, Territory, TimeWindow, Vec3, VisibilityParams } from "../shared/protocol/worker";
import type { Pose } from "../shared/settings";
import { hash32 } from "../shared/rng";
import type { SpaceId } from "../shared/types";
import {
  brainSurfaceAlong,
  clipToEnvelope,
  FIGURE,
  hazeBrightness,
  insideBrain,
  fibreCourse,
  NERVE_LEVELS,
  nerveLevel,
  orderedTau,
  poseArray,
  poseBounds,
  regionOf,
  resolvePose,
  SlotPart,
  spineActivity,
  spinePoint,
  spineRadius,
  spineTangent,
  type AnatomyModel,
  type Bounds,
} from "./anatomy";
import { arcPolyline, CHECK_EVERY, clamp, clamp01, hash2, lerp, mix32, pointAt, runJob, tangentAt, TAU, unit3, type ArcPolyline, type Job, type JobStep } from "./geom";

// ───────────────────────────── formulas (pinned by tests) ─────────────────────────────

/** Spine position for a record entry from its rank fraction and linear time fraction (both 0..1). */
export function cordTau(rankFraction: number, linearFraction: number): number {
  const t = FIGURE.tau;
  return t.start + t.span * (t.rank * rankFraction + t.linear * linearFraction);
}

/** Position on the age ramp (0 oldest … 1 newest) of a spine position τ; NaN stays NaN. */
export function ageOfTau(tau: number): number {
  if (!Number.isFinite(tau)) return Number.NaN;
  return clamp01((tau - FIGURE.tau.start) / FIGURE.tau.span);
}

/** Spine position τ (in the record entries' own scale) of every haze point on the cord (the thread's beads); NaN for the rest. */
export function hazeSpineTau(haze: { count: number; tau: Float32Array }, order: Parameters<typeof orderedTau>[0]): Float32Array {
  const out = new Float32Array(haze.count).fill(Number.NaN);
  for (let i = 0; i < haze.count; i++) {
    const t = haze.tau[i] as number;
    if (Number.isFinite(t)) out[i] = orderedTau(order, t);
  }
  return out;
}

/** Share f of its segment's full nerve that a conversation of `messages` messages runs (CORTEX-UX §6.3); `jitter` is U(0.9, 1.1). */
export function frondFraction(messages: number, jitter = 1): number {
  const l = FIGURE.fronds.length;
  const base = clamp(l.base + l.perLog * Math.log(1 + Math.max(0, messages) / l.logScale), l.min, l.max);
  return Math.min(1, Math.max(l.floor, base * jitter));
}

/** Arc fraction of message i of n along its frond. */
export function frondArc(i: number, n: number): number {
  return n <= 1 ? 0 : Math.pow(clamp01(i / (n - 1)), FIGURE.fronds.arcPower);
}

/** Wedge widths ∝ count^γ, normalised to sum to `total` radians. */
export function wedgeWidths(counts: readonly number[], gamma: number, total = Math.PI * 2): number[] {
  const w = counts.map((c) => (c > 0 ? Math.pow(c, gamma) : 0));
  const sum = w.reduce((a, b) => a + b, 0);
  return sum > 0 ? w.map((x) => (x / sum) * total) : counts.map(() => 0);
}

/** Birth time (intro seconds) of a spine point at τ: the travelling tip. */
export function spineBirth(tau: number): number {
  return FIGURE.timing.spine.start + FIGURE.timing.spine.span * clamp01(tau);
}

// ───────────────────────────── visibility ─────────────────────────────

/** VisibilityParams with defaults applied and the held-arrival boundary resolved against the index. */
export interface Visibility {
  scope: SpaceId | "all";
  /** SPACE_ORDER index of the scope, −1 for all areas. */
  scopeIndex: number;
  period: TimeWindow | null;
  notes: boolean;
  vaultNotes: boolean;
  maps: boolean;
  record: boolean;
  undatedCloud: boolean;
  reference: boolean;
  askHistory: boolean;
  subagents: boolean;
  automated: boolean;
  /** Items with an ordinal ≥ this are held arrivals (not shown). ≤ 0 or missing means nothing is held. */
  revealedCount: number;
}

const bool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);

/** Apply the Layers defaults (CORTEX-UX §5.3) to a possibly partial visibility. */
export function normaliseVisibility(v: Partial<VisibilityParams> | null | undefined, count: number): Visibility {
  const scope = typeof v?.scope === "string" && (v.scope === "all" || SPACE_ORDER.includes(v.scope as SpaceId)) ? (v.scope as SpaceId | "all") : "all";
  const p = v?.period;
  const period: TimeWindow | null = Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[0] <= p[1] ? [p[0], p[1]] : null;
  const rc = v?.revealedCount;
  return {
    scope,
    scopeIndex: scope === "all" ? -1 : SPACE_ORDER.indexOf(scope),
    period,
    notes: bool(v?.notes, true),
    vaultNotes: bool(v?.vaultNotes, true),
    maps: bool(v?.maps, true),
    record: bool(v?.record, true),
    undatedCloud: bool(v?.undatedCloud, true),
    reference: bool(v?.reference, false),
    askHistory: bool(v?.askHistory, false),
    subagents: bool(v?.subagents, false),
    automated: bool(v?.automated, false),
    revealedCount: typeof rc === "number" && Number.isFinite(rc) && rc > 0 ? Math.min(count, Math.floor(rc)) : count,
  };
}

const ASK_SOURCE = SOURCE_ORDER.indexOf("cortex-ask");
const OBSIDIAN_SOURCE = SOURCE_ORDER.indexOf("obsidian");
const NONE_SPACE = SPACE_ORDER.indexOf("none");

/** Hidden-by-default traffic (subagents, harness, automated, Ask history, reference): shown only with its layer. */
function trafficVisible(flags: number, source: number, vis: Visibility): boolean {
  const sub = (flags & (ItemFlag.Subagent | ItemFlag.Harness)) !== 0;
  const auto = (flags & ItemFlag.Automated) !== 0;
  const ask = (flags & ItemFlag.AssistantPane) !== 0 || source === ASK_SOURCE;
  const ref = (flags & ItemFlag.Reference) !== 0;
  if (sub && !vis.subagents) return false;
  if (auto && !vis.automated) return false;
  if (ask && !vis.askHistory) return false;
  if (ref && !vis.reference) return false;
  if ((flags & ItemFlag.HiddenByDefault) !== 0 && !(sub || auto || ask || ref)) return false;
  return true;
}

/** A record entry that belongs in the undated cloud (no date evidence, or a reference document). */
export function isUndatedRecord(index: DataIndex, i: number): boolean {
  const flags = index.cols.flags[i] as number;
  return (flags & (ItemFlag.Undated | ItemFlag.Reference)) !== 0 || !Number.isFinite(index.cols.t[i] as number);
}

/**
 * Is item i drawn in this leaf (Layers and held arrivals)? Scope and period never decide this: they dim or sink
 * points, they do not remove them from the body. Notes and Record are master switches over their sub-layers.
 */
export function layerVisible(index: DataIndex, i: number, vis: Visibility): boolean {
  if (i >= vis.revealedCount) return false;
  const c = index.cols;
  const flags = c.flags[i] as number;
  if ((flags & (ItemFlag.Excluded | ItemFlag.Superseded)) !== 0) return false;
  const source = c.source[i] as number;
  if (!trafficVisible(flags, source, vis)) return false;
  if ((c.pop[i] as number) === Population.Note) {
    if (!vis.notes) return false;
    const kind = c.kind[i] as number;
    if (kind === ItemKind.NoteHub) return vis.maps;
    if (kind === ItemKind.NoteWiki || source === OBSIDIAN_SOURCE) return vis.vaultNotes;
    return true;
  }
  if (!vis.record) return false;
  if (isUndatedRecord(index, i) && !vis.undatedCloud) return false;
  return true;
}

/** Item i is inside the leaf's scope (all areas, or its area). */
export function inScope(index: DataIndex, i: number, vis: Visibility): boolean {
  return vis.scopeIndex < 0 || (index.cols.space[i] as number) === vis.scopeIndex;
}

/** Item i is inside the leaf's period (All time, or a dated item inside the window). */
export function inPeriod(index: DataIndex, i: number, vis: Visibility): boolean {
  if (!vis.period) return true;
  const t = index.cols.t[i] as number;
  return Number.isFinite(t) && t >= vis.period[0] && t <= vis.period[1];
}

/** Drawn, in scope and in period: the items a Groups or Chart arrangement and the key counts work on. */
export function shownNow(index: DataIndex, i: number, vis: Visibility): boolean {
  return layerVisible(index, i, vis) && inScope(index, i, vis) && inPeriod(index, i, vis);
}

// ───────────────────────────── spine time (τ) ─────────────────────────────

export interface SpineTime {
  /** τ per item: dated record entries only (NaN otherwise). */
  tau: Float32Array;
  /** Dated record times, ascending. */
  times: Float64Array;
  /** τ of each entry in `times` (ascending too). */
  tauSorted: Float64Array;
  tMin: number;
  tMax: number;
}

const spineCache = new WeakMap<DataIndex, { key: string; st: SpineTime }>();

/** Entries that carry a spine position: dated, non-reference record entries that are not excluded. */
function hasSpineTime(index: DataIndex, i: number): boolean {
  const c = index.cols;
  if ((c.pop[i] as number) !== Population.Record) return false;
  if (((c.flags[i] as number) & ItemFlag.Excluded) !== 0) return false;
  return !isUndatedRecord(index, i);
}

/**
 * τ for every dated record entry, over EVERYTHING indexed (not only what a leaf shows), so toggling layers,
 * scope or period never moves a point along the spine. Ties are broken by ordinal, which spreads bursts.
 */
export function computeSpineTime(index: DataIndex): SpineTime {
  const n = index.count;
  const c = index.cols;
  let fh = 0x811c9dc5;
  for (let i = 0; i < n; i++) fh = Math.imul(fh ^ (c.flags[i] as number), 0x01000193);
  const key = `${n}:${index.header.epoch}:${index.header.seq}:${fh >>> 0}`;
  const hit = spineCache.get(index);
  if (hit && hit.key === key) return hit.st;
  let m = 0;
  for (let i = 0; i < n; i++) if (hasSpineTime(index, i)) m++;
  const ords = new Uint32Array(m);
  m = 0;
  for (let i = 0; i < n; i++) if (hasSpineTime(index, i)) ords[m++] = i;
  const t = c.t;
  ords.sort((a, b) => (t[a] as number) - (t[b] as number) || a - b);
  const tau = new Float32Array(n).fill(Number.NaN);
  const times = new Float64Array(m);
  const tauSorted = new Float64Array(m);
  for (let k = 0; k < m; k++) times[k] = t[ords[k] as number] as number;
  const tMin = m > 0 ? (times[0] as number) : Number.NaN;
  const tMax = m > 0 ? (times[m - 1] as number) : Number.NaN;
  const span = tMax - tMin;
  for (let k = 0; k < m; k++) {
    const r = m > 1 ? k / (m - 1) : 0.5;
    const l = span > 0 ? ((times[k] as number) - tMin) / span : 0.5;
    tau[ords[k] as number] = cordTau(r, l);
    tauSorted[k] = tau[ords[k] as number] as number;
  }
  const st = { tau, times, tauSorted, tMin, tMax };
  spineCache.set(index, { key, st });
  return st;
}

function lowerBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((a[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((a[mid] as number) <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The spine position a time would have among the dated record (used to age-colour notes); NaN when unknown. */
export function tauOfTime(st: SpineTime, time: number): number {
  const m = st.times.length;
  if (!Number.isFinite(time) || m === 0) return Number.NaN;
  const rank = (lowerBound(st.times, time) + upperBound(st.times, time) - 1) / 2;
  const r = m > 1 ? clamp01(rank / (m - 1)) : 0.5;
  const span = st.tMax - st.tMin;
  const l = span > 0 ? clamp01((time - st.tMin) / span) : 0.5;
  return cordTau(r, l);
}

// ───────────────────────────── params ─────────────────────────────

/** Optional placement inputs proposed in docs/rfcs/E8.md (read through this adapter until they land). */
export interface PlacementExtras {
  /** Sticky colour slots of the area dimension (colours.json `space`): wedges run in slot order. */
  areaSlots?: Readonly<Record<string, number>>;
}

interface Resolved {
  seed: number;
  pose: Pose;
  placement: "area" | "role";
  order: "oldest" | "newest" | "largest";
  depthKey: "time" | "layer";
  gamma: number;
  vis: Visibility;
  areaSlots: Readonly<Record<string, number>> | null;
  spineOrder: SpineOrderParam;
}

function bad(msg: string): never {
  throw new CortexError("E_BAD_REQUEST", `placement: ${msg}`);
}

function resolveParams(index: DataIndex, p: PlacementParams): Resolved {
  if (p === null || typeof p !== "object") bad("params must be an object");
  if (typeof p.seed !== "number" || !Number.isFinite(p.seed)) bad("seed must be a finite number");
  if (p.placement !== "area" && p.placement !== "role") bad(`unknown placement "${String(p.placement)}"`);
  if (p.order !== "oldest" && p.order !== "newest" && p.order !== "largest") bad(`unknown core order "${String(p.order)}"`);
  if (p.depthKey !== "time" && p.depthKey !== "layer") bad(`unknown depth key "${String(p.depthKey)}"`);
  if (typeof p.gamma !== "number" || !Number.isFinite(p.gamma) || p.gamma <= 0 || p.gamma > 2) bad("gamma must be in (0, 2]");
  if (p.visibility === null || typeof p.visibility !== "object") bad("visibility is required");
  const extras = p as PlacementParams & PlacementExtras;
  const slots = extras.areaSlots && typeof extras.areaSlots === "object" ? extras.areaSlots : null;
  return {
    seed: Math.floor(p.seed) >>> 0,
    pose: resolvePose(p.pose),
    placement: p.placement,
    order: p.order,
    depthKey: p.depthKey,
    gamma: p.gamma,
    vis: normaliseVisibility(p.visibility, index.count),
    areaSlots: slots,
    spineOrder: p.spineOrder === "newest-at-brain" ? "newest-at-brain" : "oldest-at-brain",
  };
}

/** Everything that decides where an existing point sits (scope, period and held arrivals do not). */
function signature(r: Resolved, slotsKey: string): string {
  const v = r.vis;
  const layers = [v.notes, v.vaultNotes, v.maps, v.record, v.undatedCloud, v.reference, v.askHistory, v.subagents, v.automated].map((b) => (b ? 1 : 0)).join("");
  const slots = r.areaSlots ? JSON.stringify(Object.keys(r.areaSlots).sort().map((k) => [k, r.areaSlots?.[k]])) : "";
  return [r.seed, r.pose, r.placement, r.order, r.depthKey, r.gamma, layers, slotsKey, slots, r.spineOrder].join("|");
}

// ───────────────────────────── territories ─────────────────────────────

/** Wedge order: areas with a sticky colour slot in slot order, then the rest in SPACE_ORDER; No area last. */
export function wedgeOrder(areaSlots: Readonly<Record<string, number>> | null): number[] {
  const all = SPACE_ORDER.map((_, i) => i).filter((i) => i !== NONE_SPACE);
  const slotOf = (i: number): number => {
    const s = areaSlots?.[SPACE_ORDER[i] as string];
    return typeof s === "number" && s >= 1 && s <= 8 ? s : 99;
  };
  all.sort((a, b) => slotOf(a) - slotOf(b) || a - b);
  if (NONE_SPACE >= 0) all.push(NONE_SPACE);
  return all;
}

/** Brain territories (compass wedges) for per-area note counts. */
export function computeTerritories(countsBySpace: readonly number[], gamma: number, areaSlots: Readonly<Record<string, number>> | null = null): Territory[] {
  const order = wedgeOrder(areaSlots).filter((i) => (countsBySpace[i] ?? 0) > 0);
  const widths = wedgeWidths(
    order.map((i) => countsBySpace[i] ?? 0),
    gamma,
  );
  const out: Territory[] = [];
  let phi = 0;
  order.forEach((s, k) => {
    const w = widths[k] ?? 0;
    out.push({ space: SPACE_ORDER[s] as SpaceId, phi0: phi, phi1: k === order.length - 1 ? TAU : phi + w, notes: countsBySpace[s] ?? 0 });
    phi += w;
  });
  return out;
}

/** Brain slots needed so the busiest territory still has room (before bucketing). */
export function requiredBrainSlots(index: DataIndex, params: PlacementParams): number {
  const vis = normaliseVisibility(params?.visibility, index.count);
  const gamma = typeof params?.gamma === "number" && params.gamma > 0 && params.gamma <= 2 ? params.gamma : 0.6;
  const counts = new Array<number>(SPACE_ORDER.length).fill(0);
  const c = index.cols;
  for (let i = 0; i < index.count; i++) {
    if ((c.pop[i] as number) !== Population.Note || (c.kind[i] as number) === ItemKind.NoteHub) continue;
    if (!layerVisible(index, i, vis)) continue;
    const s = c.space[i] as number;
    counts[s < counts.length ? s : NONE_SPACE] = (counts[s < counts.length ? s : NONE_SPACE] ?? 0) + 1;
  }
  const w = wedgeWidths(counts, gamma);
  let need = 0;
  counts.forEach((cnt, i) => {
    const share = (w[i] ?? 0) / TAU;
    if (cnt > 0 && share > 0) need = Math.max(need, cnt / share);
  });
  const areaShare = 1 - FIGURE.brain.shares.brainstem;
  return Math.ceil((need * FIGURE.brain.slots.slack) / areaShare);
}

// ───────────────────────────── memo (incremental) ─────────────────────────────

/** What a view keeps from its last placement so live arrivals can be placed without moving anything. */
export interface PlacementMemo {
  sig: string;
  slotsKey: string;
  pose: Pose;
  count: number;
  /** Unposed (skeleton frame) positions and scatter centres; NaN = not placed. */
  skeleton: Float32Array;
  centreSkeleton: Float32Array;
  birth: Float32Array;
  size: Float32Array;
  region: Uint8Array;
  tau: Float32Array;
  /** Anatomy slot taken by each note (−1 for record items, maps and synthesized positions). */
  noteSlot: Int32Array;
  taken: Uint8Array;
  /** Conversation row → side (+1 right, −1 left) of every frond placed so far. */
  convSide: Map<number, number>;
  territories: Territory[];
  bounds: Bounds;
}

// ───────────────────────────── helpers ─────────────────────────────

const NAN = Number.NaN;

/** Folder path of an item ("" when none), from the folder dictionary. */
function folderOf(index: DataIndex, i: number): string {
  const f = index.cols.folder[i] as number;
  if (f === NONE32 || f >= index.dicts.folders.size) return "";
  return index.dicts.folders.get(f);
}

function itemTime(index: DataIndex, i: number): number {
  const t = index.cols.t[i] as number;
  if (Number.isFinite(t)) return t;
  const a = index.cols.tAdded[i] as number;
  return Number.isFinite(a) ? a : 0;
}

/** Two depth keys per note for the core order (smaller sorts deeper). */
function depthKeys(index: DataIndex, i: number, r: Resolved): [number, number] {
  const c = index.cols;
  const time = itemTime(index, i);
  const isVault = (c.kind[i] as number) === ItemKind.NoteWiki || (c.source[i] as number) === OBSIDIAN_SOURCE;
  const layer = c.layer[i] as number;
  const layerKey = r.depthKey === "layer" ? (isVault ? (layer === NONE8 ? 8.5 : layer) : 9) : 0;
  if (r.order === "newest") return [-layerKey, -time];
  if (r.order === "largest") {
    const size = (c.words[i] as number) || (c.chars[i] as number) || 0;
    return [-size, time];
  }
  return [layerKey, time];
}

/** Largest-remainder split of `total` into parts ∝ weights; every positive weight gets ≥ 1 while total allows. */
function allocate(weights: readonly number[], total: number): number[] {
  const n = weights.length;
  const out = new Array<number>(n).fill(0);
  const sum = weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  if (total <= 0 || sum <= 0) return out;
  const positive = weights.filter((w) => w > 0).length;
  const base = total >= positive ? 1 : 0;
  let left = total - base * positive;
  const rem: { i: number; f: number }[] = [];
  for (let i = 0; i < n; i++) {
    const w = weights[i] as number;
    if (w <= 0) continue;
    const exact = (w / sum) * left;
    const fl = Math.floor(exact);
    out[i] = base + fl;
    rem.push({ i, f: exact - fl });
  }
  left -= rem.reduce((a, e) => a + (out[e.i]! - base), 0);
  rem.sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; k < rem.length && left > 0; k++, left--) out[rem[k]!.i] = out[rem[k]!.i]! + 1;
  return out;
}

/** Common leading folder segments of a set of paths. */
function commonPrefix(paths: readonly string[][]): number {
  if (paths.length === 0) return 0;
  const first = paths[0] as string[];
  let n = first.length;
  for (const p of paths) {
    let k = 0;
    while (k < n && k < p.length && p[k] === first[k]) k++;
    n = k;
    if (n === 0) break;
  }
  return n;
}

function groupBy<T>(items: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of items) {
    const k = key(x);
    let list = m.get(k);
    if (!list) m.set(k, (list = []));
    list.push(x);
  }
  return m;
}

/** Groups ordered by size (largest first, the band nearest the base), ties by key. */
function sortedGroups<T>(m: Map<string, T[]>): [string, T[]][] {
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Gaussian pair from (seed, ordinal, salt) without allocating a stream. */
function gauss(seed: number, ord: number, salt: number): number {
  const u = Math.max(1e-12, unit3(seed, ord, salt));
  const v = unit3(seed, ord, salt + 7919);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

const DOWN: Vec3 = [0, -1, 0];

// ───────────────────────────── the brain ─────────────────────────────

interface NoteJob {
  ord: number;
  k1: number;
  k2: number;
  path: string[];
}

interface BrainState {
  index: DataIndex;
  anatomy: AnatomyModel;
  r: Resolved;
  skeleton: Float32Array;
  centre: Float32Array;
  region: Uint8Array;
  noteSlot: Int32Array;
  noteDepth: Float32Array;
  taken: Uint8Array;
  synth: number;
}

function placeNoteAtSlot(b: BrainState, ord: number, slot: number, jitterSalt: number): void {
  const a = b.anatomy;
  let x = a.brainSlots[slot * 3] as number;
  let y = a.brainSlots[slot * 3 + 1] as number;
  let z = a.brainSlots[slot * 3 + 2] as number;
  if (jitterSalt > 0) {
    // A synthesized position next to a slot (only when a cell holds more notes than slots).
    const s = 0.025;
    x += s * gauss(b.r.seed, ord, jitterSalt);
    y += s * gauss(b.r.seed, ord, jitterSalt + 1);
    z += s * gauss(b.r.seed, ord, jitterSalt + 2);
    b.synth++;
  } else {
    b.taken[slot] = 1;
    b.noteSlot[ord] = slot;
  }
  b.skeleton[ord * 3] = x;
  b.skeleton[ord * 3 + 1] = y;
  b.skeleton[ord * 3 + 2] = z;
  const part = a.brainPart[slot] as number;
  const pc = part === SlotPart.Cerebellum ? FIGURE.brain.cerebellum.centre : part === SlotPart.Brainstem ? FIGURE.brainstem.bottom : FIGURE.brain.centre;
  const k = FIGURE.brain.scatterCore;
  b.centre[ord * 3] = pc[0] + (x - pc[0]) * k;
  b.centre[ord * 3 + 1] = pc[1] + (y - pc[1]) * k;
  b.centre[ord * 3 + 2] = pc[2] + (z - pc[2]) * k;
  b.region[ord] = a.brainRegion[slot] as number;
  b.noteDepth[ord] = a.brainDepth[slot] as number;
}

/** Give each note of a cell one slot: slots spread over the cell's depth range, the deepest to the core order's first. */
function assignCell(b: BrainState, slots: readonly number[], notes: NoteJob[]): void {
  if (notes.length === 0) return;
  notes.sort((p, q) => p.k1 - q.k1 || p.k2 - q.k2 || p.ord - q.ord);
  const depth = b.anatomy.brainDepth;
  const sorted = [...slots].sort((p, q) => (depth[p] as number) - (depth[q] as number) || p - q);
  const S = sorted.length;
  const N = notes.length;
  if (S === 0) return;
  if (N <= S) {
    for (let k = 0; k < N; k++) placeNoteAtSlot(b, notes[k]!.ord, sorted[Math.min(S - 1, Math.floor(((k + 0.5) * S) / N))]!, 0);
    return;
  }
  // More notes than slots: every slot is used and the rest crowd in beside them, still in depth order.
  for (let k = 0; k < N; k++) {
    const pos = Math.min(S - 1, Math.floor(((k + 0.5) * S) / N));
    const first = k === 0 || Math.min(S - 1, Math.floor(((k - 0.5) * S) / N)) !== pos;
    placeNoteAtSlot(b, notes[k]!.ord, sorted[pos]!, first ? 0 : 101 + (k % 7) * 3);
  }
}

/** Split slots into contiguous runs (sorted by `key`) sized by count^γ, one run per group. */
function splitBy(slots: readonly number[], key: Float32Array, groups: readonly number[], gamma: number): number[][] {
  const sorted = [...slots].sort((p, q) => (key[p] as number) - (key[q] as number) || p - q);
  const sizes = allocate(
    groups.map((g) => Math.pow(g, gamma)),
    sorted.length,
  );
  const out: number[][] = [];
  let at = 0;
  for (const s of sizes) {
    out.push(sorted.slice(at, at + s));
    at += s;
  }
  return out;
}

/** Nested treemap over the folded surface: folders split the elevation, subfolders split the azimuth again. */
function assignWedge(b: BrainState, slots: readonly number[], notes: NoteJob[]): void {
  if (notes.length === 0) return;
  const gamma = b.r.gamma;
  const pre = commonPrefix(notes.map((n) => n.path));
  const level1 = groupBy(notes, (n) => n.path[pre] ?? "");
  if (level1.size <= 1) {
    assignBand(b, slots, notes, pre + 1, gamma);
    return;
  }
  const groups = sortedGroups(level1);
  const bands = splitBy(
    slots,
    b.anatomy.brainPsi,
    groups.map((g) => g[1].length),
    gamma,
  );
  groups.forEach(([, members], k) => assignBand(b, bands[k] ?? [], members, pre + 1, gamma));
}

function assignBand(b: BrainState, slots: readonly number[], notes: NoteJob[], level: number, gamma: number): void {
  const level2 = groupBy(notes, (n) => n.path[level] ?? "");
  if (level2.size <= 1) {
    assignCell(b, slots, notes);
    return;
  }
  const groups = sortedGroups(level2);
  const cells = splitBy(
    slots,
    b.anatomy.brainPhi,
    groups.map((g) => g[1].length),
    gamma,
  );
  groups.forEach(([, members], k) => assignCell(b, cells[k] ?? [], members));
}

/** The free area slots nearest in azimuth to φ (used when a wedge is too thin to hold any slot). */
function nearestFreeSlots(b: BrainState, phi: number, want: number): number[] {
  const a = b.anatomy;
  const cand: { s: number; d: number }[] = [];
  for (let s = 0; s < a.slotCount; s++) {
    if (b.taken[s] || (a.brainPart[s] as number) === SlotPart.Brainstem) continue;
    let d = Math.abs((a.brainPhi[s] as number) - phi);
    if (d > Math.PI) d = TAU - d;
    cand.push({ s, d });
  }
  cand.sort((p, q) => p.d - q.d || p.s - q.s);
  return cand.slice(0, want).map((e) => e.s);
}

function labelColumn(index: DataIndex, pack: string, field: string): LabelColumn | null {
  let best: LabelColumn | null = null;
  for (const col of index.labels) {
    if (col.pack !== pack || col.field !== field) continue;
    if (!best || compareVersions(col.packVersion, best.packVersion) > 0) best = col;
  }
  return best;
}

/** Compare dotted versions numerically ("1.10.0" > "1.9.0"). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10));
  const pb = b.split(".").map((x) => parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (Number.isFinite(pa[i]) ? (pa[i] as number) : 0) - (Number.isFinite(pb[i]) ? (pb[i] as number) : 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The placement pack's role of a note ("" when unlabelled). */
function roleOf(col: LabelColumn | null, i: number): string {
  if (!col) return "";
  if (col.single) {
    const v = col.single[i] as number;
    return v === undefined || v === 0xffff ? "" : (col.values[v] ?? "");
  }
  if (col.multi) {
    const a = col.multi.offsets[i] as number;
    const e = col.multi.offsets[i + 1] as number;
    return a !== undefined && e !== undefined && e > a ? (col.values[col.multi.targets[a] as number] ?? "") : "";
  }
  return "";
}

/** A map's spot: its members' centroid pushed out along the ray from the brain's centre to just inside the surface (lift < 0). */
function mapPosition(cx: number, cy: number, cz: number, out: Vec3): Vec3 {
  const c = FIGURE.brain.centre;
  let dx = cx - c[0];
  let dy = cy - c[1];
  let dz = cz - c[2];
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (l < 1e-6) {
    dx = 0;
    dy = 1;
    dz = 0;
  } else {
    dx /= l;
    dy /= l;
    dz /= l;
  }
  const s = brainSurfaceAlong(dx, dy, dz) + FIGURE.maps.lift;
  out[0] = c[0] + dx * s;
  out[1] = c[1] + dy * s;
  out[2] = c[2] + dz * s;
  return out;
}

/**
 * A map's spot among its notes: beside its medoid note, nudged a little outward from the brain's centre and turned by a
 * small stable angle (so two maps that share a medoid do not land on one spot), and kept just inside the surface.
 */
function mapAmong(x: number, y: number, z: number, h: number, out: Vec3): Vec3 {
  const c = FIGURE.brain.centre;
  const m = FIGURE.maps;
  let dx = x - c[0];
  let dy = y - c[1];
  let dz = z - c[2];
  const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (r < 1e-6) return mapPosition(x, y, z, out);
  dx /= r;
  dy /= r;
  dz /= r;
  // Turn the direction by up to ±spread radians about two axes (stable per map ordinal).
  const ua = (hash2(h, 0x6d61) / 4294967296 - 0.5) * 2 * m.spread;
  const ub = (hash2(h, 0x7073) / 4294967296 - 0.5) * 2 * m.spread;
  dx += ua * dz;
  dz -= ua * dx;
  dy += ub;
  const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
  dx /= l;
  dy /= l;
  dz /= l;
  const s = Math.min(r + m.nudge, brainSurfaceAlong(dx, dy, dz) + m.lift);
  out[0] = c[0] + dx * s;
  out[1] = c[1] + dy * s;
  out[2] = c[2] + dz * s;
  return out;
}

function placeMap(index: DataIndex, h: number, territories: readonly Territory[], skeleton: Float32Array, centre: Float32Array, region: Uint8Array): void {
  const rel = index.rel.hubMembers;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let n = 0;
  // The members that are notes (brain points): a map sits among them, a white spark inside its own patch of the
  // brain, rather than every map of an area stacking at one spot on the surface.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let nn = 0;
  const a = rel.offsets[h];
  const e = rel.offsets[h + 1];
  if (a !== undefined && e !== undefined) {
    for (let k = a; k < e; k++) {
      const m = rel.targets[k] as number;
      if (m >= index.count || m === h) continue;
      const x = skeleton[m * 3] as number;
      if (!Number.isFinite(x)) continue;
      const y = skeleton[m * 3 + 1] as number;
      const z = skeleton[m * 3 + 2] as number;
      sx += x;
      sy += y;
      sz += z;
      n++;
      if ((index.cols.pop[m] as number) === Population.Note) {
        nx += x;
        ny += y;
        nz += z;
        nn++;
      }
    }
  }
  const p: Vec3 = [0, 0, 0];
  if (nn > 0 && a !== undefined && e !== undefined) {
    // The note member nearest the note members' centre (their medoid), so the spark is where its notes are.
    const cx = nx / nn;
    const cy = ny / nn;
    const cz = nz / nn;
    let best = -1;
    let bestD = Infinity;
    for (let k = a; k < e; k++) {
      const m = rel.targets[k] as number;
      if (m >= index.count || m === h || (index.cols.pop[m] as number) !== Population.Note) continue;
      const x = skeleton[m * 3] as number;
      if (!Number.isFinite(x)) continue;
      const d = (x - cx) ** 2 + ((skeleton[m * 3 + 1] as number) - cy) ** 2 + ((skeleton[m * 3 + 2] as number) - cz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    mapAmong(skeleton[best * 3] as number, skeleton[best * 3 + 1] as number, skeleton[best * 3 + 2] as number, h, p);
  } else if (n > 0) mapPosition(sx / n, sy / n, sz / n, p);
  else {
    // No placed member: the middle of its own area's wedge, up on the crown side.
    const space = SPACE_ORDER[index.cols.space[h] as number];
    const t = territories.find((w) => w.space === space) ?? territories[0];
    const phi = t ? (t.phi0 + t.phi1) / 2 : 0;
    const el = 0.6;
    // Azimuth 0 is the frontal pole (+Z) and grows toward the figure's right (−X).
    mapPosition(FIGURE.brain.centre[0] - Math.sin(phi) * Math.cos(el), FIGURE.brain.centre[1] + Math.sin(el), FIGURE.brain.centre[2] + Math.cos(phi) * Math.cos(el), p);
  }
  skeleton[h * 3] = p[0];
  skeleton[h * 3 + 1] = p[1];
  skeleton[h * 3 + 2] = p[2];
  const c = FIGURE.brain.centre;
  const k = FIGURE.brain.scatterCore;
  centre[h * 3] = c[0] + (p[0] - c[0]) * k;
  centre[h * 3 + 1] = c[1] + (p[1] - c[1]) * k;
  centre[h * 3 + 2] = c[2] + (p[2] - c[2]) * k;
  const ce = FIGURE.brain.cerebellum;
  const inCerebellum = insideBrain(p[0], p[1], p[2], 1.25) && p[1] < FIGURE.brain.cerebrum.baseY && p[2] < ce.centre[2] + ce.axes[2];
  region[h] = inCerebellum ? Region.Cerebellum : regionOf(SlotPart.Cerebrum, p[0], p[1], p[2], 1);
}

// ───────────────────────────── the record ─────────────────────────────

interface FrondPlan {
  row: number;
  root: number;
  side: number;
  /** Eligible messages in conversation order. */
  msgs: number[];
}

interface RecordState {
  index: DataIndex;
  r: Resolved;
  st: SpineTime;
  skeleton: Float32Array;
  centre: Float32Array;
  birth: Float32Array;
  tauOut: Float32Array;
  smallRecord: boolean;
}

/** Deterministic per-conversation parameters from its id. */
function convHash(index: DataIndex, row: number, seed: number): number {
  let id = "";
  try {
    id = index.convs.get(row).id;
  } catch {
    id = String(row);
  }
  return hash2(seed, hash32(id || String(row)));
}

/** What a conversation's frond follows: its segment's nerve course, cut to f of its length, behind a rootlet. */
export interface FrondShape {
  poly: ArcPolyline;
  /** The length share f actually used. */
  fraction: number;
  /** Segment index 0..30 (C1 … Co1). */
  level: number;
}

const ROOTLET_SAMPLES = 24;

/**
 * The nerve a conversation's frond follows (skeleton frame, CORTEX-UX §6.3): the segment whose exit level is nearest
 * `root` (its τ), on `side`; length = f × the segment's full nerve (f from the message count, never below 0.12); a
 * rootlet 0.22 long runs from the cord point at τ to the course, which it then follows out and down.
 */
export function frondPath(root: number, side: number, messages: number, h: number, smallRecord: boolean): FrondShape {
  const fr = FIGURE.fronds;
  const u = mix32(h ^ 0x2c1b3c6d) / 4294967296;
  const level = nerveLevel(root);
  // Each conversation runs its own variant of the segment's course (leave angle, bend, length and depth shell picked
  // from its id), so the fronds fan out as thin strands across the torso instead of stacking on one rib.
  const fan = (salt: number): number => mix32(h ^ salt) / 4294967296;
  const course = fibreCourse(level.index, side, fan(0x51a3b7c1), fan(0x7f4a7c15), fan(0x2545f491), fan(0x9e3779b1));
  let fraction = frondFraction(messages, lerp(fr.length.jitter[0], fr.length.jitter[1], u));
  if (smallRecord) fraction = Math.max(fraction, Math.min(1, FIGURE.sparse.minFrondLength / level.length));
  // The course cut at fraction × steps (the step schedule of the full nerve is kept).
  const steps = FIGURE.nerves.steps;
  const cut = fraction * steps;
  const m = Math.min(steps, Math.floor(cut));
  const cutPts: number[] = [];
  for (let j = 0; j <= m; j++) cutPts.push(course.pts[j * 3] as number, course.pts[j * 3 + 1] as number, course.pts[j * 3 + 2] as number);
  if (cut > m && m < steps) {
    const t = cut - m;
    for (let d = 0; d < 3; d++) cutPts.push(lerp(course.pts[m * 3 + d] as number, course.pts[(m + 1) * 3 + d] as number, t));
  }
  const cutPoly = arcPolyline(Float64Array.from(cutPts));
  const attach = cutPoly.length > 0 ? Math.min(1, fr.rootlet / cutPoly.length) : 0;
  const rootPt = spinePoint(root, [0, 0, 0]);
  const pts = new Float64Array((ROOTLET_SAMPLES + 2) * 3);
  pts[0] = rootPt[0];
  pts[1] = rootPt[1];
  pts[2] = rootPt[2];
  const q: Vec3 = [0, 0, 0];
  for (let i = 0; i <= ROOTLET_SAMPLES; i++) {
    pointAt(cutPoly, lerp(attach, 1, i / ROOTLET_SAMPLES), q);
    pts[(i + 1) * 3] = q[0];
    pts[(i + 1) * 3 + 1] = q[1];
    pts[(i + 1) * 3 + 2] = q[2];
  }
  return { poly: arcPolyline(pts), fraction, level: level.index };
}

const pScratch: Vec3 = [0, 0, 0];
const tScratch: Vec3 = [0, 0, 0];

/** Place messages [from, msgs.length) of a frond (from > 0 extends a live frond without moving older messages). */
function placeFrond(rs: RecordState, plan: FrondPlan, from: number, h: number, keep: Uint8Array | null): void {
  const { skeleton, centre, birth } = rs;
  const n = plan.msgs.length;
  if (n === 0) return;
  const fr = FIGURE.fronds;
  const tm = FIGURE.timing;
  const floor = FIGURE.cord.floorY - fr.floorMargin;
  const shape = frondPath(plan.root, plan.side, n, h, rs.smallRecord);
  const rootBirth = spineBirth(plan.root) + tm.frondDelay;
  const seed = rs.r.seed;
  const out = -plan.side;
  // Conversations that share a segment lie side by side as a ribbon: a fixed offset per conversation in height and
  // depth, from 30% at the rootlet to 120% at the end.
  const offY = fr.ribbon.sigma * gauss(seed, plan.row, 71);
  const offZ = fr.ribbon.sigma * gauss(seed, plan.row, 73);
  const ribbon = (s: number): number => lerp(fr.ribbon.from, fr.ribbon.to, s);
  // Parts: a long conversation is dealt out over several fibre strands of its segment (a fresh full placement only; live
  // growth stays on the stem). Message i goes to strand i mod K at rank ⌊i / K⌋, so time still runs along every strand.
  const nParts = from === 0 ? Math.max(1, Math.min(fr.parts.max, Math.ceil(n / fr.parts.perMessages))) : 1;
  const put = (ord: number, x: number, y: number, z: number, jit: number, bt: number, salt: number): void => {
    if (keep && keep[ord]) return;
    skeleton[ord * 3] = x + jit * gauss(seed, ord, salt);
    skeleton[ord * 3 + 1] = Math.max(floor, y + jit * gauss(seed, ord, salt + 1));
    skeleton[ord * 3 + 2] = z + jit * gauss(seed, ord, salt + 2);
    centre[ord * 3] = x;
    centre[ord * 3 + 1] = Math.max(floor, y);
    centre[ord * 3 + 2] = z;
    birth[ord] = Math.min(tm.introSec, bt);
  };
  const sp = fr.splay;
  for (let part = 0; part < nParts; part++) {
    // Each extra strand leaves the cord a little above or below the first, so a big conversation is a bundle, not a point.
    const ph = mix32(h ^ Math.imul(part, 0x9e3779b9));
    const poly = part === 0 ? shape.poly : frondPath(clamp01(plan.root + fr.parts.rootSpread * (2 * (ph / 4294967296) - 1)), plan.side, n, ph, rs.smallRecord).poly;
    const count = nParts === 1 ? n - from : Math.ceil((n - part) / nParts);
    for (let k = 0; k < count; k++) {
      const i = nParts === 1 ? from + k : part + k * nParts;
      const s = nParts === 1 ? frondArc(i, n) : lerp(fr.parts.arcFrom, 1, frondArc(k, count));
      pointAt(poly, s, pScratch);
      const rb = ribbon(s);
      let x = pScratch[0];
      let y = pScratch[1] + offY * rb;
      const z = pScratch[2] + offZ * rb;
      // The outer 20% splays downward and outward into a soft brush.
      const ord = plan.msgs[i] as number;
      const t = clamp01((s - (1 - sp.outer)) / sp.outer);
      if (t > 0) {
        const amt = sp.amount * (sp.low + (1 - sp.low) * shape.fraction) * t;
        x += out * amt * unit3(seed, ord, 79);
        y -= amt * unit3(seed, ord, 83);
      }
      put(ord, clipToEnvelope(x, y), y, z, fr.jitter.base + fr.jitter.gain * s, rootBirth + tm.frondUnfurl * s, 11);
    }
  }
}

/** A single entry in the spine core at its τ. */
function placeSingle(rs: RecordState, ord: number, tau: number): void {
  const p = spinePoint(tau, pScratch);
  const rad = spineRadius(tau) * Math.abs(gauss(rs.r.seed, ord, 31)) * FIGURE.core.jitter;
  const a = unit3(rs.r.seed, ord, 37) * TAU;
  rs.skeleton[ord * 3] = p[0] + Math.cos(a) * rad;
  rs.skeleton[ord * 3 + 1] = p[1];
  rs.skeleton[ord * 3 + 2] = p[2] + Math.sin(a) * rad;
  rs.centre[ord * 3] = p[0];
  rs.centre[ord * 3 + 1] = p[1];
  rs.centre[ord * 3 + 2] = p[2];
  rs.birth[ord] = spineBirth(tau);
}

/** Cumulative weights over the levels an undated entry may take (deeper levels likelier), built once. */
const UNDATED_LEVELS: readonly { level: number; cum: number }[] = (() => {
  const u = FIGURE.undated;
  const out: { level: number; cum: number }[] = [];
  let acc = 0;
  const last = NERVE_LEVELS.length - 1;
  for (let l = u.fromLevel; l <= last; l++) {
    acc += 1 + (u.lowWeight * (l - u.fromLevel)) / Math.max(1, last - u.fromLevel);
    out.push({ level: l, cum: acc });
  }
  return out;
})();

/**
 * An undated entry lies faintly along one of the lowest fibres of the leaf (no cloud below the tip): a level from the
 * lumbar nerves down, a side and one of a few fixed strands of that level, at an arc fraction of its course.
 */
function placeUndated(rs: RecordState, ord: number): void {
  const u = FIGURE.undated;
  const seed = rs.r.seed;
  const pick = unit3(seed, ord, 41) * (UNDATED_LEVELS[UNDATED_LEVELS.length - 1] as { cum: number }).cum;
  let level = (UNDATED_LEVELS[UNDATED_LEVELS.length - 1] as { level: number }).level;
  for (const e of UNDATED_LEVELS) {
    if (pick <= e.cum) {
      level = e.level;
      break;
    }
  }
  const side = unit3(seed, ord, 44) < 0.5 ? 1 : -1;
  const variant = Math.min(u.variants - 1, Math.floor(unit3(seed, ord, 47) * u.variants));
  // A strand is fixed by (level, side, variant), so a few hundred courses serve any number of entries.
  const v = (k: number): number => mix32(Math.imul(level * 2 + (side > 0 ? 1 : 0), 0x9e3779b1) ^ Math.imul(variant + 1, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35)) / 4294967296;
  const poly = fibreCourse(level, side, v(0), v(1), v(2), v(3));
  const s = lerp(u.along[0], u.along[1], unit3(seed, ord, 50));
  pointAt(poly, s, pScratch);
  const floor = FIGURE.cord.floorY - FIGURE.fronds.floorMargin;
  const y = Math.max(floor, pScratch[1]);
  rs.skeleton[ord * 3] = pScratch[0] + u.jitter * gauss(seed, ord, 56);
  rs.skeleton[ord * 3 + 1] = Math.max(floor, y + u.jitter * gauss(seed, ord, 59));
  rs.skeleton[ord * 3 + 2] = pScratch[2] + u.jitter * gauss(seed, ord, 62);
  rs.centre[ord * 3] = pScratch[0];
  rs.centre[ord * 3 + 1] = y;
  rs.centre[ord * 3 + 2] = pScratch[2];
  rs.birth[ord] = FIGURE.timing.undated.start + FIGURE.timing.undated.span * unit3(seed, ord, 53);
}

/** Root τ per conversation row: the earliest dated message over everything indexed (stable under layers). */
export function conversationRoots(index: DataIndex, st: SpineTime): Float64Array {
  const rows = index.convs.size;
  const root = new Float64Array(rows).fill(Number.POSITIVE_INFINITY);
  const c = index.cols;
  for (let i = 0; i < index.count; i++) {
    const row = c.conv[i] as number;
    if (row === NONE32 || row >= rows) continue;
    const t = st.tau[i] as number;
    if (Number.isFinite(t) && t < (root[row] as number)) root[row] = t;
  }
  return root;
}

/** Sides alternate in start order over every dated conversation (so layers never flip a frond). */
export function conversationSides(root: Float64Array): Int8Array {
  const rows: number[] = [];
  for (let r = 0; r < root.length; r++) if (Number.isFinite(root[r] as number)) rows.push(r);
  rows.sort((a, b) => (root[a] as number) - (root[b] as number) || a - b);
  const side = new Int8Array(root.length);
  rows.forEach((r, k) => (side[r] = k % 2 === 0 ? 1 : -1));
  return side;
}

// ───────────────────────────── the job ─────────────────────────────

export interface PlacementOutput {
  result: PlacementResult;
  memo: PlacementMemo;
}

function step(phase: string, done: number, total: number): JobStep {
  return { phase, done, total };
}

/**
 * Place every item of the index for a leaf (see the file header). With `params.fromCount` and a memo of the
 * same signature, existing points keep their positions and only newly shown items are placed.
 */
export function* placementJob(index: DataIndex, anatomy: AnatomyModel, params: PlacementParams, memo: PlacementMemo | null = null): Job<PlacementOutput> {
  const r = resolveParams(index, params);
  const n = index.count;
  const c = index.cols;
  const sig = signature(r, anatomy.slotsKey);
  const incremental = memo !== null && params.fromCount !== undefined && memo.sig === sig && memo.slotsKey === anatomy.slotsKey && memo.count <= n;
  const st = computeSpineTime(index);
  yield step("spine", 0, n);

  const skeleton = new Float32Array(n * 3).fill(NAN);
  const centre = new Float32Array(n * 3).fill(NAN);
  const birth = new Float32Array(n).fill(NAN);
  const size = new Float32Array(n);
  const region = new Uint8Array(n).fill(255);
  const tau = new Float32Array(n).fill(NAN);
  const noteSlot = new Int32Array(n).fill(-1);
  const taken = new Uint8Array(anatomy.slotCount);
  const noteDepth = new Float32Array(n).fill(NAN);

  // Who is drawn, and what is already placed (incremental).
  const eligible = new Uint8Array(n);
  let noteCount = 0;
  let recordCount = 0;
  for (let i = 0; i < n; i++) {
    if (!layerVisible(index, i, r.vis)) continue;
    eligible[i] = 1;
    if ((c.pop[i] as number) === Population.Note) noteCount++;
    else recordCount++;
    if ((i & (CHECK_EVERY - 1)) === 0) yield step("visibility", i, n);
  }
  const keep = new Uint8Array(n);
  if (incremental && memo) {
    const old = memo.count;
    for (let i = 0; i < old; i++) {
      if (!eligible[i] || !Number.isFinite(memo.skeleton[i * 3] as number)) continue;
      keep[i] = 1;
      for (let d = 0; d < 3; d++) {
        skeleton[i * 3 + d] = memo.skeleton[i * 3 + d] as number;
        centre[i * 3 + d] = memo.centreSkeleton[i * 3 + d] as number;
      }
      birth[i] = memo.birth[i] as number;
      size[i] = memo.size[i] as number;
      region[i] = memo.region[i] as number;
      tau[i] = memo.tau[i] as number;
      const s = memo.noteSlot[i] as number;
      noteSlot[i] = s;
      if (s >= 0 && s < taken.length) taken[s] = 1;
    }
  }

  // ── brain ──
  const countsBySpace = new Array<number>(SPACE_ORDER.length).fill(0);
  const placeNotes: number[] = [];
  const hubs: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!eligible[i] || (c.pop[i] as number) !== Population.Note) continue;
    if ((c.kind[i] as number) === ItemKind.NoteHub) {
      if (!keep[i]) hubs.push(i);
      continue;
    }
    const s = c.space[i] as number;
    countsBySpace[s < countsBySpace.length ? s : NONE_SPACE] = (countsBySpace[s < countsBySpace.length ? s : NONE_SPACE] ?? 0) + 1;
    if (!keep[i]) placeNotes.push(i);
  }
  const territories = incremental && memo ? memo.territories.map((t) => ({ ...t, notes: countsBySpace[SPACE_ORDER.indexOf(t.space)] ?? 0 })) : computeTerritories(countsBySpace, r.gamma, r.areaSlots);
  const brain: BrainState = { index, anatomy, r, skeleton, centre, region, noteSlot, noteDepth, taken, synth: 0 };
  if (incremental) placeNotesIncrementally(brain, placeNotes, territories);
  else {
    const jobs: NoteJob[] = placeNotes.map((ord) => {
      const [k1, k2] = depthKeys(index, ord, r);
      return { ord, k1, k2, path: folderOf(index, ord).split("/").filter((s) => s.length > 0) };
    });
    let rest = jobs;
    if (r.placement === "role") {
      const col = labelColumn(index, "placement", "role");
      const byRegion = new Map<number, NoteJob[]>();
      rest = [];
      for (const j of jobs) {
        const reg = ROLE_TO_REGION[roleOf(col, j.ord)];
        if (reg === undefined) {
          rest.push(j);
          continue;
        }
        let list = byRegion.get(reg);
        if (!list) byRegion.set(reg, (list = []));
        list.push(j);
      }
      // Slot heights, for the finer regions that share one brain region (low to high, in SUBREGIONS order).
      const slotY = new Float32Array(anatomy.slotCount);
      for (let s = 0; s < slotY.length; s++) slotY[s] = anatomy.brainSlots[s * 3 + 1] as number;
      for (const [reg, list] of byRegion) {
        const slots: number[] = [];
        for (let s = 0; s < anatomy.slotCount; s++) if ((anatomy.brainRegion[s] as number) === reg && !taken[s]) slots.push(s);
        const parts = splitBySubregion(list, (j) => roleOf(col, j.ord));
        if (parts.length < 2 || slots.length < parts.length) {
          assignCell(brain, slots.length > 0 ? slots : nearestFreeSlots(brain, 0, list.length), list);
          continue;
        }
        // Each finer region of this brain region gets its own band of the region's slots, so its name can sit over it.
        const bands = splitBy(slots, slotY, parts.map((q) => q.length), r.gamma);
        parts.forEach((q, k) => {
          const band = bands[k] as number[];
          assignCell(brain, band.length > 0 ? band : nearestFreeSlots(brain, 0, q.length), q);
        });
      }
      yield step("regions", byRegion.size, byRegion.size);
    }
    // Area wedges over the slots still free.
    const bySpace = groupBy(rest, (j) => String(c.space[j.ord] as number));
    for (const t of territories) {
      const s = SPACE_ORDER.indexOf(t.space);
      const notes = bySpace.get(String(s)) ?? [];
      if (notes.length === 0) continue;
      const slots: number[] = [];
      for (let k = 0; k < anatomy.slotCount; k++) {
        if (taken[k] || (anatomy.brainPart[k] as number) === SlotPart.Brainstem) continue;
        const phi = anatomy.brainPhi[k] as number;
        if (phi >= t.phi0 && phi < t.phi1) slots.push(k);
      }
      assignWedge(brain, slots.length > 0 ? slots : nearestFreeSlots(brain, (t.phi0 + t.phi1) / 2, notes.length), notes);
      yield step("brain", s, SPACE_ORDER.length);
    }
    // Notes whose area has no wedge (an unknown space id) join No area's wedge or the largest one.
    const unknown = rest.filter((j) => (c.space[j.ord] as number) >= SPACE_ORDER.length);
    if (unknown.length > 0) assignCell(brain, nearestFreeSlots(brain, territories[territories.length - 1]?.phi0 ?? 0, unknown.length), unknown);
  }
  for (const h of hubs) placeMap(index, h, territories, skeleton, centre, region);
  yield step("maps", hubs.length, hubs.length);

  // Note births: the brain blooms deepest-first after the nerves (1.60 + 1.5 × depth rank).
  const tm = FIGURE.timing;
  const fewNotes = noteCount < FIGURE.sparse.fewNotes;
  const bloomOrder: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!eligible[i] || keep[i] || (c.pop[i] as number) !== Population.Note) continue;
    if ((c.kind[i] as number) === ItemKind.NoteHub) {
      birth[i] = tm.maps.start + tm.maps.span * unit3(r.seed, i, 61);
      size[i] = fewNotes ? FIGURE.sparse.fewNotesSize : 1;
      continue;
    }
    if (Number.isFinite(noteDepth[i] as number)) bloomOrder.push(i);
    size[i] = fewNotes ? FIGURE.sparse.fewNotesSize : 1;
  }
  bloomOrder.sort((a, b) => (noteDepth[a] as number) - (noteDepth[b] as number) || a - b);
  bloomOrder.forEach((i, k) => {
    birth[i] = tm.bloom.start + tm.bloom.span * (bloomOrder.length > 1 ? k / (bloomOrder.length - 1) : 0);
  });

  // ── record ──
  const rs: RecordState = { index, r, st, skeleton, centre, birth, tauOut: tau, smallRecord: recordCount < FIGURE.sparse.smallRecord };
  const roots = conversationRoots(index, st);
  const sides = conversationSides(roots);
  const convSide = new Map<number, number>(incremental && memo ? memo.convSide : []);
  const byConv = new Map<number, number[]>();
  const rows = index.convs.size;
  let done = 0;
  for (let i = 0; i < n; i++) {
    if (!eligible[i] || (c.pop[i] as number) !== Population.Record) continue;
    if (!keep[i]) tau[i] = st.tau[i] as number;
    if (!keep[i]) size[i] = 1;
    const row = c.conv[i] as number;
    const rootTau = row !== NONE32 && row < rows ? (roots[row] as number) : Number.POSITIVE_INFINITY;
    if (row !== NONE32 && row < rows && Number.isFinite(rootTau)) {
      let list = byConv.get(row);
      if (!list) byConv.set(row, (list = []));
      list.push(i);
    } else if (!keep[i]) {
      if (isUndatedRecord(index, i)) placeUndated(rs, i);
      else placeSingle(rs, i, orderedTau(r.spineOrder, st.tau[i] as number));
    }
    if ((++done & (CHECK_EVERY - 1)) === 0) yield step("record", done, recordCount);
  }
  const idx = c.idx;
  const convRows = [...byConv.keys()].sort((a, b) => (roots[a] as number) - (roots[b] as number) || a - b);
  let fronds = 0;
  for (const row of convRows) {
    const msgs = byConv.get(row) as number[];
    msgs.sort((a, b) => ((idx[a] as number) === NONE32 ? 0 : 1) - ((idx[b] as number) === NONE32 ? 0 : 1) || (idx[a] as number) - (idx[b] as number) || itemTime(index, a) - itemTime(index, b) || a - b);
    const from = incremental ? msgs.findIndex((m) => !keep[m]) : 0;
    if (from < 0) continue;
    // Sides alternate in start order over every dated conversation; a frond keeps the side it was given.
    const side = (incremental ? convSide.get(row) : undefined) ?? ((sides[row] as number) || 1);
    convSide.set(row, side);
    placeFrond(rs, { row, root: orderedTau(r.spineOrder, roots[row] as number), side, msgs }, from, convHash(index, row, r.seed), incremental ? keep : null);
    if ((++fronds & 63) === 0) yield step("fronds", fronds, convRows.length);
  }
  yield step("fronds", convRows.length, convRows.length);

  // ── bounds and pose ──
  const dataMin: Vec3 = [Infinity, Infinity, Infinity];
  const dataMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const x = skeleton[i * 3] as number;
    if (!Number.isFinite(x)) continue;
    for (let d = 0; d < 3; d++) {
      const v = skeleton[i * 3 + d] as number;
      if (v < dataMin[d]!) dataMin[d] = v;
      if (v > dataMax[d]!) dataMax[d] = v;
    }
  }
  const sb: Bounds = {
    min: [Math.min(anatomy.bounds.min[0], dataMin[0]), Math.min(anatomy.bounds.min[1], dataMin[1]), Math.min(anatomy.bounds.min[2], dataMin[2])],
    max: [Math.max(anatomy.bounds.max[0], dataMax[0]), Math.max(anatomy.bounds.max[1], dataMax[1]), Math.max(anatomy.bounds.max[2], dataMax[2])],
  };
  const newMemo: PlacementMemo = {
    sig,
    slotsKey: anatomy.slotsKey,
    pose: r.pose,
    count: n,
    skeleton,
    centreSkeleton: centre,
    birth: birth.slice(),
    size: size.slice(),
    region: region.slice(),
    tau: tau.slice(),
    noteSlot,
    taken,
    convSide,
    territories,
    bounds: sb,
  };
  const anatPosed = poseArray(r.pose, skeleton);
  const result: PlacementResult = {
    anat: anatPosed,
    birth,
    size,
    region,
    tau,
    haze: {
      pos: poseArray(r.pose, anatomy.haze.pos.subarray(0, anatomy.haze.count * 3)),
      kind: anatomy.haze.kind.slice(0, anatomy.haze.count),
      birth: anatomy.haze.birth.slice(0, anatomy.haze.count),
      count: anatomy.haze.count,
      bright: hazeBrightness(anatomy.haze, spineActivity(st.times, st.tauSorted), r.spineOrder),
      tau: hazeSpineTau(anatomy.haze, r.spineOrder),
    },
    centre: poseArray(r.pose, centre),
    territories: territories.map((t) => ({ ...t })),
    bounds: poseBounds(r.pose, sb),
    slotsKey: anatomy.slotsKey,
    ...(r.placement === "role" ? { labels: subregionLabels(anatPosed, region, subregionIdsOf(labelColumn(index, "placement", "role"), region, n), n) } : {}),
  };
  yield step("done", n, n);
  return { result, memo: newMemo };
}

/** Region ids in id order, as the lower-case keys the stage looks its names up by (copy regions.*). */
export const REGION_KEYS = ["prefrontal", "frontal", "parietal", "occipital", "temporal", "limbic", "cerebellum", "brainstem"] as const;

/**
 * One label per brain region that holds notes (Placement › By role): the region's name at the centroid of its
 * notes' positions (`pos` is in the posed figure frame, like `anat`). Record entries (region 255) and unplaced
 * points (NaN) do not count.
 */
export function regionLabels(anat: Float32Array, region: Uint8Array, n: number): RegionLabel[] {
  const sum = REGION_KEYS.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < n; i++) {
    const reg = region[i] as number;
    const acc = reg < REGION_KEYS.length ? sum[reg] : undefined;
    if (!acc) continue;
    const x = anat[i * 3] as number, y = anat[i * 3 + 1] as number, z = anat[i * 3 + 2] as number;
    if (!Number.isFinite(x + y + z)) continue;
    acc[0]! += x;
    acc[1]! += y;
    acc[2]! += z;
    acc[3]! += 1;
  }
  const out: RegionLabel[] = [];
  sum.forEach((a, id) => {
    const c = a[3] as number;
    if (c === 0) return;
    const key = REGION_KEYS[id] as string;
    out.push({ text: key.charAt(0).toUpperCase() + key.slice(1), pos: [(a[0] as number) / c, (a[1] as number) / c, (a[2] as number) / c], kind: "region", key });
  });
  return out;
}

/** One finer-region id per item (index into SUBREGIONS), 255 for items whose role did not put them in their region (record entries, area-placed notes, maps). */
export function subregionIdsOf(col: LabelColumn | null, region: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n).fill(255);
  if (!col) return out;
  for (let i = 0; i < n; i++) {
    const sub = subregionOfRole(roleOf(col, i));
    if (sub && region[i] === sub.region) out[i] = SUBREGIONS.indexOf(sub);
  }
  return out;
}

/** Notes grouped by their finer region, in SUBREGIONS order (low to high inside the brain region); roles outside the pack are left out. */
function splitBySubregion(jobs: readonly NoteJob[], role: (j: NoteJob) => string): NoteJob[][] {
  const by = new Map<number, NoteJob[]>();
  for (const j of jobs) {
    const sub = subregionOfRole(role(j));
    const id = sub ? SUBREGIONS.indexOf(sub) : -1;
    let list = by.get(id);
    if (!list) by.set(id, (list = []));
    list.push(j);
  }
  return [...by.keys()].sort((a, b) => a - b).map((id) => by.get(id) as NoteJob[]);
}

/**
 * One label per finer region that holds notes (Placement › By role): its name at the centroid of its notes' positions.
 * `sub` is subregionIdsOf's array; the label's key is the finer region's key (copy `regions.*`).
 */
export function subregionLabels(anat: Float32Array, region: Uint8Array, sub: Uint8Array, n: number): RegionLabel[] {
  const sum = SUBREGIONS.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < n; i++) {
    const id = sub[i] as number;
    const acc = id < SUBREGIONS.length ? sum[id] : undefined;
    if (!acc || (region[i] as number) !== SUBREGIONS[id]!.region) continue;
    const x = anat[i * 3] as number, y = anat[i * 3 + 1] as number, z = anat[i * 3 + 2] as number;
    if (!Number.isFinite(x + y + z)) continue;
    acc[0]! += x;
    acc[1]! += y;
    acc[2]! += z;
    acc[3]! += 1;
  }
  const out: RegionLabel[] = [];
  sum.forEach((a, id) => {
    const c = a[3] as number;
    if (c === 0) return;
    const def = SUBREGIONS[id]!;
    out.push({ text: def.name, pos: [(a[0] as number) / c, (a[1] as number) / c, (a[2] as number) / c], kind: "region", key: def.key });
  });
  return out;
}

/** New notes of a live update: the free slot of their wedge at the depth the core order gives the newest. */
function placeNotesIncrementally(b: BrainState, notes: readonly number[], territories: readonly Territory[]): void {
  if (notes.length === 0) return;
  const a = b.anatomy;
  const c = b.index.cols;
  const outermost = b.r.order !== "newest";
  for (const ord of notes) {
    const space = SPACE_ORDER[c.space[ord] as number];
    const t = territories.find((w) => w.space === space) ?? territories[territories.length - 1];
    let best = -1;
    let bestDepth = outermost ? -Infinity : Infinity;
    for (let s = 0; s < a.slotCount; s++) {
      if (b.taken[s] || (a.brainPart[s] as number) === SlotPart.Brainstem) continue;
      const phi = a.brainPhi[s] as number;
      if (t && (phi < t.phi0 || phi >= t.phi1)) continue;
      const d = a.brainDepth[s] as number;
      if (outermost ? d > bestDepth : d < bestDepth) {
        bestDepth = d;
        best = s;
      }
    }
    if (best >= 0) placeNoteAtSlot(b, ord, best, 0);
    else {
      const near = nearestFreeSlots(b, t ? (t.phi0 + t.phi1) / 2 : 0, 1);
      // Every slot is taken: crowd in next to the wedge's middle.
      const fallback = near[0] ?? 0;
      placeNoteAtSlot(b, ord, fallback, near.length > 0 ? 0 : 211);
    }
  }
}

/** Synchronous placement (tests, pure callers). */
export function computePlacement(index: DataIndex, anatomy: AnatomyModel, params: PlacementParams, memo: PlacementMemo | null = null): PlacementResult {
  return runJob(placementJob(index, anatomy, params, memo)).result;
}
