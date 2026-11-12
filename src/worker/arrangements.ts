/**
 * Groups arrangements (the shape bar's Groups target). Owner: E8. CORTEX-UX §6.12:
 *  - bubbles (default): one sphere per group, radius ∝ ∛count, packed around the largest, members with a
 *    Gaussian falloff (σ = 0.45 r); groups under 30 items are reported in `sparse` and drawn as hollow outlined
 *    spheres with an n chip (the shape bar's warning dot offers "Fold groups under 30 into Other");
 *  - tree: the folder hierarchy left to right (root at the left, children fanning right), 1 px leaders;
 *  - spine ("Along the spine"): the figure stays standing; each group is a bar leaving the cord sideways at the
 *    spine position τ of its median date (groups alternate sides), length ∝ count, bars that would overlap step
 *    apart along the cord;
 *  - strata: groups as horizontal slabs stacked by size (largest at the bottom), width ∝ count, the stack curved;
 *  - wheel ("Year wheel"): groups round a circle in their natural order; months (YYYY-MM) sit in twelve sectors, one
 *    concentric ring per year (oldest innermost, January at the top, clockwise), with the year boxed on its ring;
 *  - grid ("Month grid"): months in twelve columns, one row per year (oldest at the top), year labels boxed at the
 *    left; any other dimension fills a square-ish grid in its natural order.
 * Three groupings take a figure form instead of the plain pack when the layout is bubbles (worker/forms.ts): Map type
 * (a bright beam of the map types over the big "Not a map" sphere, joined by cones), Role (the comet: one cluster per
 * brain region along a teardrop, named, swaying between lying and standing) and Kind while an area is chosen (the T).
 * Every layout reports fibre bundles between its spheres, weighted by the note links that cross between the groups
 * (`bundles`; the renderer draws them as the Groups shape's links, subject to the Lines look setting).
 * Region placement is Placement › By role in the body (placement.ts), not a separate layout. Charts live in
 * worker/charts/. Arrangement → arrangement changes take 750 ms with a 0.3-unit lift (renderer). Items outside
 * the leaf's Layers, scope or period get a NaN target (they fade out).
 */
import { builtinDim, isLabelBased, noneNameOf, parseDateDim, ROLE_DIM, type DimId } from "../shared/dims";
import type { DataIndex } from "../shared/index-format";
import { Population } from "../shared/index-format";
import { RECORD_MARK_PREFIX, type ArrangementParams, type ArrangementResult, type GroupBundle, type MergeMap, type OverlayItem, type Vec3 } from "../shared/protocol/worker";
import type { Pose } from "../shared/settings";
import { NO_CODE, OTHER_VALUE, readDim, writtenAt } from "./charts/common";
import { FIGURE, poseXYZ, resolvePose, spinePoint } from "./anatomy";
import { clamp, fibonacciSphere, packCircles, unit3, type Circle } from "./geom";
import { monthName } from "./charts/common";
import { subregionByKey } from "../shared/packs";
import { cometLabelAt, cometLayout, railLayout, tLayout, type FormBundle, type FormLayout } from "./forms";
import { computeSpineTime, normaliseVisibility, REGION_KEYS, shownNow, tauOfTime } from "./placement";

/** Groups smaller than this are "sparse" (hollow spheres + n chip). */
export const SPARSE_GROUP = FIGURE.groups.sparseBelow;

/** Sphere radius for a group of `count` items (∛ scaling, minimum for single items). */
export function groupRadius(count: number, unit = FIGURE.groups.unit): number {
  return Math.max(unit * 0.5, unit * Math.cbrt(Math.max(1, count)));
}

/** English fallbacks for the remainder buckets (the UI resolves its own copy by key). */
const NONE_TEXT: Readonly<Record<string, string>> = {
  noArea: "No area",
  undated: "Undated",
  noProject: "No project",
  noKind: "No kind",
  noMap: "No map",
  noStatus: "No map status",
  noFolder: "No folder",
  noLayer: "No layer",
  noSource: "No source",
  noSpeaker: "No speaker",
  noConversation: "No conversation",
  noLabel: "No label",
  noValue: "No value",
  noFunction: "(none)",
};

export interface Group {
  key: string;
  label: string;
  kind: "value" | "none" | "other";
  items: number[];
  order: number;
}

type Params = Extract<ArrangementParams, { kind: "groups" }>;

function gauss(seed: number, ord: number, salt: number): number {
  const u = Math.max(1e-12, unit3(seed, ord, salt));
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * unit3(seed, ord, salt + 7919));
}

/** The groups of a dimension over `items`: global merges applied, Fold sends groups under 30 to Other. */
function buildGroups(index: DataIndex, dim: DimId, items: number[], merges: MergeMap, fold: boolean, hideNoValue: boolean): Group[] {
  const dv = readDim(index, dim, items);
  const mg = merges[dim] ?? {};
  const noneText = NONE_TEXT[noneNameOf(dim) ?? "noLabel"] ?? "None";
  const byKey = new Map<string, Group>();
  for (const o of items) {
    const code = dv.codes[o] as number;
    let key = code === NO_CODE ? "" : (dv.keys[code] ?? "");
    if (key === "" && hideNoValue) continue;
    const merged = mg[key];
    if (merged !== undefined && merged !== "") key = merged;
    let g = byKey.get(key);
    if (!g) {
      const c = key === "" ? NO_CODE : dv.keys.indexOf(key);
      g = { key, label: key === "" ? noneText : c >= 0 ? (dv.labels[c] ?? key) : key, kind: key === "" ? "none" : "value", items: [], order: c >= 0 ? (dv.order[c] ?? 0) : Number.MAX_SAFE_INTEGER };
      byKey.set(key, g);
    }
    g.items.push(o);
  }
  let list = [...byKey.values()];
  if (fold) {
    const keep: Group[] = [];
    const other: Group = { key: OTHER_VALUE, label: "Other", kind: "other", items: [], order: Number.MAX_SAFE_INTEGER };
    for (const g of list) {
      if (g.kind === "value" && g.items.length < SPARSE_GROUP) other.items.push(...g.items);
      else keep.push(g);
    }
    if (other.items.length > 0) keep.push(other);
    list = keep;
  }
  return list;
}

/** Spread `ids` through a ball of radius r about c: Gaussian falloff σ = 0.45 r, or on the shell when hollow. */
function fillBall(arr: Float32Array, ids: readonly number[], c: Vec3, r: number, hollow: boolean, seed: number): void {
  const m = ids.length;
  const d: Vec3 = [0, 0, 0];
  for (let k = 0; k < m; k++) {
    const o = ids[k] as number;
    fibonacciSphere(k, m, d);
    const rho = hollow ? r : Math.min(r, Math.abs(gauss(seed, o, 5)) * FIGURE.groups.falloff * r);
    arr[o * 3] = c[0] + d[0] * rho;
    arr[o * 3 + 1] = c[1] + d[1] * rho;
    arr[o * 3 + 2] = c[2] + d[2] * rho;
  }
}

function emptyResult(n: number): ArrangementResult {
  return { arr: new Float32Array(n * 3).fill(Number.NaN), overlay: { items: [], marks: [] }, camera: { centre: [0, 0, 0], radius: 5.5, tiltDeg: 0, keepUpright: false }, sparse: [] };
}

interface Placed {
  key: string;
  label: string;
  count: number;
  centre: Vec3;
  radius: number;
  hollow: boolean;
  /** The items drawn in this sphere (bundles count the note links between spheres). */
  items: readonly number[];
  /** True when the sphere's name is carried by axis text instead (month cells of the wheel and grid). */
  quiet?: boolean;
  /** Half extents of a mark that is not a sphere (the grid's dash rows); hit bounds use it instead of the radius. */
  half?: Vec3;
  /** Suffix chip beside the label (the record family of a split layout). */
  chip?: string;
  /** Where the name stands instead of above the mark (strata: left of the slab, clear of the bright column). */
  nameAt?: { at: Vec3; align: "left" | "center" | "right" };
}

/** Scale all positions about the origin so the bounding radius is the figure's half-height. */
function fitToFrame(arr: Float32Array, placed: Placed[], extra: Vec3[]): number {
  let r = 0;
  for (const p of placed) r = Math.max(r, Math.hypot(p.centre[0], p.centre[1], p.centre[2]) + p.radius);
  for (const e of extra) r = Math.max(r, Math.hypot(e[0], e[1], e[2]));
  const s = r > 0 ? FIGURE.groups.targetRadius / r : 1;
  for (let i = 0; i < arr.length; i++) if (Number.isFinite(arr[i] as number)) arr[i] = (arr[i] as number) * s;
  for (const p of placed) {
    p.centre = [p.centre[0] * s, p.centre[1] * s, p.centre[2] * s];
    p.radius *= s;
    if (p.half) p.half = [p.half[0] * s, p.half[1] * s, p.half[2] * s];
    if (p.nameAt) p.nameAt = { at: [p.nameAt.at[0] * s, p.nameAt.at[1] * s, p.nameAt.at[2] * s], align: p.nameAt.align };
  }
  for (const e of extra) {
    e[0] *= s;
    e[1] *= s;
    e[2] *= s;
  }
  return s;
}

function finish(res: ArrangementResult, placed: Placed[], lines: OverlayItem[], tiltDeg: number, keepUpright: boolean, extent: readonly Vec3[] = []): ArrangementResult {
  const items: OverlayItem[] = [...lines];
  for (const p of placed) {
    const h: Vec3 = p.half ?? [p.radius, p.radius, p.radius];
    if (p.quiet !== true) items.push({ type: "label", at: p.nameAt?.at ?? [p.centre[0], p.centre[1] + h[1] + 0.12, p.centre[2]], text: p.label, style: "box", align: p.nameAt?.align ?? "center", key: p.key, ...(p.chip ? { chip: p.chip } : {}) });
    res.overlay.marks.push({
      key: p.key,
      label: p.label,
      count: p.count,
      bounds: { min: [p.centre[0] - h[0], p.centre[1] - h[1], p.centre[2] - h[2]], max: [p.centre[0] + h[0], p.centre[1] + h[1], p.centre[2] + h[2]] },
    });
    if (p.hollow) res.sparse?.push({ key: p.key, count: p.count });
  }
  res.overlay.items = items;
  let r = 0;
  for (const p of placed) r = Math.max(r, Math.hypot(p.centre[0], p.centre[1], p.centre[2]) + p.radius);
  for (const e of extent) r = Math.max(r, Math.hypot(e[0], e[1], e[2]));
  res.camera = { centre: [0, 0, 0], radius: Math.max(r * 1.08, 1), tiltDeg, keepUpright };
  return res;
}

/** The group key that stands as the apex of a kind grouping: the maps (the kind dimension calls them "hub"). */
export const APEX_KIND = "hub";

/**
 * One sphere per group, packed around the largest. With an `apexKey` that names one of the groups (and at least one
 * other group exists), that sphere is lifted out of the pack and stands above all the others (the hub apex).
 */
function bubbles(arr: Float32Array, groups: Group[], seed: number, apexKey?: string): Placed[] {
  const sorted = [...groups].sort((a, b) => b.items.length - a.items.length || (a.key < b.key ? -1 : 1));
  const apex = apexKey !== undefined && sorted.length > 1 ? sorted.find((g) => g.key === apexKey) : undefined;
  const rest = apex ? sorted.filter((g) => g !== apex) : sorted;
  const circles = packCircles(rest.map((g) => groupRadius(g.items.length)).map((r) => r + FIGURE.groups.tree.nodeGap * 0.25));
  const placed: Placed[] = rest.map((g, i) => {
    const c = circles[i] as Circle;
    const r = groupRadius(g.items.length);
    const hollow = g.items.length < SPARSE_GROUP;
    fillBall(arr, g.items, [c.x, c.y, 0], r, hollow, seed);
    return { key: g.key, label: g.label, count: g.items.length, centre: [c.x, c.y, 0] as Vec3, radius: r, hollow, items: g.items };
  });
  if (apex) {
    const r = groupRadius(apex.items.length);
    let top = -Infinity;
    let sx = 0;
    for (const p of placed) {
      top = Math.max(top, p.centre[1] + p.radius);
      sx += p.centre[0];
    }
    const c: Vec3 = [sx / Math.max(1, placed.length), top + r + Math.max(0.5, r), 0];
    const hollow = apex.items.length < SPARSE_GROUP;
    fillBall(arr, apex.items, c, r, hollow, seed);
    placed.push({ key: apex.key, label: apex.label, count: apex.items.length, centre: c, radius: r, hollow, items: apex.items });
  }
  return placed;
}

interface TreeNode {
  path: string;
  label: string;
  depth: number;
  children: TreeNode[];
  items: number[];
  total: number;
  y: number;
}

function tree(arr: Float32Array, groups: Group[], hierarchical: boolean, seed: number): { placed: Placed[]; parentOf: Map<string, string | null> } {
  const root: TreeNode = { path: "", label: "", depth: 0, children: [], items: [], total: 0, y: 0 };
  const byPath = new Map<string, TreeNode>([["", root]]);
  const node = (path: string, label: string): TreeNode => {
    let n = byPath.get(path);
    if (n) return n;
    const cutAt = hierarchical ? path.lastIndexOf("/") : -1;
    const parentPath = cutAt > 0 ? path.slice(0, cutAt) : "";
    const parent = cutAt > 0 ? node(parentPath, parentPath.slice(parentPath.lastIndexOf("/") + 1)) : root;
    n = { path, label, depth: parent.depth + 1, children: [], items: [], total: 0, y: 0 };
    parent.children.push(n);
    byPath.set(path, n);
    return n;
  };
  for (const g of groups) {
    const leaf = g.key === "" || g.key === OTHER_VALUE ? g.key || g.label : g.key;
    const n = node(leaf, g.kind === "value" && hierarchical ? leaf.slice(leaf.lastIndexOf("/") + 1) : g.label);
    n.items.push(...g.items);
  }
  const fg = FIGURE.groups;
  let cursor = 0;
  const walk = (n: TreeNode): void => {
    n.children.sort((a, b) => (a.path < b.path ? -1 : 1));
    n.total = n.items.length;
    for (const c of n.children) {
      walk(c);
      n.total += c.total;
    }
    if (n.children.length === 0) {
      const r = groupRadius(n.items.length);
      cursor += r;
      n.y = cursor;
      cursor += r + fg.tree.nodeGap;
    } else {
      n.y = n.children.reduce((sum, c) => sum + c.y, 0) / n.children.length;
    }
  };
  walk(root);
  const placed: Placed[] = [];
  const parentOf = new Map<string, string | null>();
  const maxDepth = Math.max(1, ...[...byPath.values()].map((n) => n.depth));
  const place = (n: TreeNode, parent: TreeNode | null): void => {
    const c: Vec3 = [(n.depth - maxDepth / 2) * fg.tree.levelGap, cursor / 2 - n.y, 0];
    if (n !== root) {
      const r = groupRadius(Math.max(1, n.items.length));
      const hollow = n.items.length > 0 && n.items.length < SPARSE_GROUP;
      fillBall(arr, n.items, c, r, hollow, seed);
      placed.push({ key: n.path, label: n.label, count: n.total, centre: c, radius: r, hollow, items: n.items });
      parentOf.set(n.path, parent && parent !== root ? parent.path : null);
    }
    for (const k of n.children) place(k, n);
  };
  place(root, null);
  return { placed, parentOf };
}

function strata(arr: Float32Array, groups: Group[], seed: number): Placed[] {
  const s = FIGURE.groups.strata;
  const sorted = [...groups].sort((a, b) => b.items.length - a.items.length || (a.key < b.key ? -1 : 1));
  const maxCount = Math.max(1, sorted[0]?.items.length ?? 1);
  const total = sorted.length * (s.thickness + s.gap);
  const placed: Placed[] = [];
  sorted.forEach((g, i) => {
    // Largest at the bottom: slab i sits i slabs above the floor.
    const y0 = -total / 2 + i * (s.thickness + s.gap);
    const w = Math.max(0.3, (g.items.length / maxCount) * s.maxWidth);
    const m = g.items.length;
    for (let k = 0; k < m; k++) {
      const o = g.items[k] as number;
      const x = (unit3(seed, o, 13) - 0.5) * w;
      const arch = s.bend * (1 - (x / (s.maxWidth / 2)) ** 2);
      arr[o * 3] = x;
      arr[o * 3 + 1] = y0 + (unit3(seed, o, 17) - 0.5) * s.thickness + arch;
      arr[o * 3 + 2] = (unit3(seed, o, 19) - 0.5) * s.depth;
    }
    // The name stands just left of the slab at the slab's own height (the bend lowers its edge), not over the column.
    const edge = Math.max(w / 2, s.thickness / 2);
    const nameY = y0 + s.bend * (1 - (edge / (s.maxWidth / 2)) ** 2);
    placed.push({ key: g.key, label: g.label, count: m, centre: [0, y0 + s.bend, 0], radius: edge, hollow: m < SPARSE_GROUP, items: g.items, nameAt: { at: [-edge - 0.18, nameY, 0], align: "right" } });
  });
  return placed;
}

function spine(index: DataIndex, arr: Float32Array, groups: Group[], pose: Pose, seed: number): Placed[] {
  const sp = FIGURE.groups.spine;
  const st = computeSpineTime(index);
  const maxCount = Math.max(1, ...groups.map((g) => g.items.length));
  type Bar = { g: Group; tau: number; length: number };
  const bars: Bar[] = groups.map((g) => {
    const times = g.items.map((o) => writtenAt(index, o)).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
    const median = times.length > 0 ? (times[(times.length - 1) >> 1] as number) : Number.NaN;
    const tau = tauOfTime(st, median);
    return { g, tau: Number.isFinite(tau) ? tau : 1, length: clamp((g.items.length / maxCount) * sp.maxLength, sp.minLength, sp.maxLength) };
  });
  bars.sort((a, b) => a.tau - b.tau || (a.g.key < b.g.key ? -1 : 1));
  const pitch = 2 * sp.columnRadius + sp.gap;
  const lastY = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const placed: Placed[] = [];
  const p: Vec3 = [0, 0, 0];
  const q: Vec3 = [0, 0, 0];
  bars.forEach((b, i) => {
    const side = i % 2 === 0 ? 0 : 1;
    spinePoint(b.tau, p);
    // Bars that would overlap step apart along the cord (down the figure).
    const y = Math.min(p[1], (lastY[side] as number) - pitch);
    lastY[side] = y;
    const dir = side === 0 ? -1 : 1;
    const x0 = dir * (sp.columnRadius + 0.1);
    const m = b.g.items.length;
    for (let k = 0; k < m; k++) {
      const o = b.g.items[k] as number;
      const u = (k + unit3(seed, o, 23)) / m;
      const a = unit3(seed, o, 29) * 2 * Math.PI;
      const rr = sp.columnRadius * Math.sqrt(unit3(seed, o, 31));
      poseXYZ(pose, x0 + dir * u * b.length, y + Math.cos(a) * rr, p[2] + Math.sin(a) * rr, q);
      arr[o * 3] = q[0];
      arr[o * 3 + 1] = q[1];
      arr[o * 3 + 2] = q[2];
    }
    const c = poseXYZ(pose, x0 + (dir * b.length) / 2, y, p[2], [0, 0, 0]);
    placed.push({ key: b.g.key, label: b.g.label, count: m, centre: c, radius: Math.max(b.length / 2, sp.columnRadius), hollow: m < SPARSE_GROUP, items: b.g.items });
  });
  return placed;
}

// ───────────────────────────── wheel and grid ─────────────────────────────

/** Year and month of a group key: "2024-03" gives 2024 and 3; "03" (month of the year) gives no year and 3; anything else is null. */
export function monthOfKey(key: string): { year: number | null; month: number } | null {
  const ym = /^(\d{4})-(\d{2})$/.exec(key);
  const m = ym ? Number(ym[2]) : /^\d{2}$/.test(key) ? Number(key) : 0;
  if (m < 1 || m > 12) return null;
  return { year: ym ? Number(ym[1]) : null, month: m };
}

/** One month of a calendar layout. */
interface MonthCell {
  g: Group;
  year: number | null;
  month: number;
}

/** The groups as months, when every value group is one (the none and other groups stay with the remainder). */
export function monthCells(dim: DimId, groups: readonly Group[]): { cells: MonthCell[]; rest: Group[] } | null {
  // Only the month dimensions have month keys ("03" is also an hour, a folder or a label value).
  const grain = parseDateDim(dim)?.grain;
  if (grain !== "month" && grain !== "monthOfYear") return null;
  const cells: MonthCell[] = [];
  const rest: Group[] = [];
  for (const g of groups) {
    const m = g.kind === "value" ? monthOfKey(g.key) : null;
    if (m) cells.push({ g, year: m.year, month: m.month });
    else if (g.kind === "value") return null;
    else rest.push(g);
  }
  return cells.length > 0 ? { cells, rest } : null;
}

/** Natural order of groups (the dimension's own order, then key); remainders last. */
function naturalOrder(groups: readonly Group[]): Group[] {
  const rank = (g: Group): number => (g.kind === "value" ? 0 : g.kind === "other" ? 1 : 2);
  return [...groups].sort((a, b) => rank(a) - rank(b) || a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Calendar cell pitch (world units before the fit), and the sphere radius that fits a cell for `count` items. */
const CELL = 1;
const cellRadius = (count: number, maxCount: number): number => CELL * 0.46 * Math.max(0.28, Math.cbrt(Math.max(1, count) / Math.max(1, maxCount)));

function place(arr: Float32Array, g: Group, centre: Vec3, radius: number, seed: number, quiet: boolean): Placed {
  const hollow = g.items.length < SPARSE_GROUP;
  fillBall(arr, g.items, centre, radius, hollow, seed);
  return { key: g.key, label: g.label, count: g.items.length, centre, radius, hollow, items: g.items, quiet };
}

/** Short dash rows per cell of the banded grid. */
const DASH_ROWS = 4;

/**
 * A grid cell drawn as banded dash rows: three or four short horizontal rows of dots (tiny vertical jitter), the
 * points dealt out to the rows in turn so each row keeps the mix of colours. The mark's hit bounds are dash shaped.
 */
function placeRows(arr: Float32Array, g: Group, centre: Vec3, radius: number, seed: number, quiet: boolean): Placed {
  const m = g.items.length;
  const rows = Math.max(1, Math.min(m < 6 ? DASH_ROWS - 1 : DASH_ROWS, m));
  const halfW = radius * 0.95;
  const pitch = radius * 0.42;
  for (let j = 0; j < m; j++) {
    const o = g.items[j] as number;
    const row = j % rows;
    const q = Math.floor(j / rows);
    const inRow = Math.ceil((m - row) / rows);
    arr[o * 3] = centre[0] + ((q + 0.5) / inRow - 0.5) * 2 * halfW;
    arr[o * 3 + 1] = centre[1] + (row - (rows - 1) / 2) * pitch + (unit3(seed, o, 41) - 0.5) * pitch * 0.12;
    arr[o * 3 + 2] = centre[2] + (unit3(seed, o, 43) - 0.5) * 0.04;
  }
  const half: Vec3 = [halfW, ((rows - 1) / 2) * pitch + pitch * 0.15, 0.03];
  return { key: g.key, label: g.label, count: m, centre, radius: halfW, hollow: m < SPARSE_GROUP, items: g.items, quiet, half };
}

interface Decoration {
  items: OverlayItem[];
  /** Points that must stay inside the frame (label anchors). */
  extent: Vec3[];
}

/**
 * Year wheel. Months: twelve sectors (January at the top, clockwise), one ring per year, oldest innermost; remainder
 * groups sit in the middle. Anything else: the groups round one circle in their natural order.
 */
function wheel(arr: Float32Array, dim: DimId, groups: Group[], seed: number): { placed: Placed[]; deco: Decoration } {
  const placed: Placed[] = [];
  const deco: Decoration = { items: [], extent: [] };
  const months = monthCells(dim, groups);
  const maxCount = Math.max(1, ...groups.map((g) => g.items.length));
  const polar = (rad: number, a: number): Vec3 => [rad * Math.sin(a), rad * Math.cos(a), 0];
  const ring = (rad: number): Vec3[] => Array.from({ length: 73 }, (_, i) => polar(rad, (i / 72) * Math.PI * 2));
  if (months) {
    const years = [...new Set(months.cells.map((c) => c.year))].sort((a, b) => (a ?? 0) - (b ?? 0));
    const r0 = Math.max(2, (12 * CELL) / (2 * Math.PI)) + (months.rest.length > 0 ? 1 : 0);
    const radiusOf = (yi: number): number => r0 + yi * CELL * 1.05;
    for (const c of months.cells) {
      const a = ((c.month - 0.5) / 12) * Math.PI * 2;
      placed.push(place(arr, c.g, polar(radiusOf(years.indexOf(c.year)), a), cellRadius(c.g.items.length, maxCount), seed, true));
    }
    months.rest.forEach((g, i) => placed.push(place(arr, g, [(i - (months.rest.length - 1) / 2) * CELL * 1.1, 0, 0], cellRadius(g.items.length, maxCount), seed, false)));
    const outer = radiusOf(years.length - 1) + CELL * 0.7;
    years.forEach((y, yi) => {
      deco.items.push({ type: "polyline", points: ring(radiusOf(yi)), alpha: 0.12, closed: true });
      // The year is boxed on its ring, on the boundary between December and January (straight above the centre).
      if (y !== null) deco.items.push({ type: "label", at: polar(radiusOf(yi), 0), text: String(y), style: "box", align: "center", key: String(y) });
    });
    for (let m = 0; m < 12; m++) {
      deco.items.push({ type: "line", a: polar(r0 - CELL * 0.6, (m / 12) * Math.PI * 2), b: polar(outer, (m / 12) * Math.PI * 2), alpha: 0.06 });
      const at = polar(outer + 0.35, ((m + 0.5) / 12) * Math.PI * 2);
      deco.items.push({ type: "label", at, text: monthName(m + 1), style: "axis", align: "center", key: `month-${m + 1}` });
      deco.extent.push([at[0], at[1], at[2]]);
    }
    return { placed, deco };
  }
  const list = naturalOrder(groups);
  const radii = list.map((g) => groupRadius(g.items.length));
  const rr = Math.max(1.2, radii.reduce((n, r) => n + 2 * r + FIGURE.groups.tree.nodeGap * 0.25, 0) / (2 * Math.PI));
  list.forEach((g, i) => placed.push(place(arr, g, polar(rr, ((i + 0.5) / list.length) * Math.PI * 2), radii[i] as number, seed, false)));
  deco.items.push({ type: "polyline", points: ring(rr), alpha: 0.12, closed: true });
  return { placed, deco };
}

/**
 * Month grid. Months: twelve columns (January first), one row per year, oldest at the top, the year boxed at the
 * left and the month names across the top; remainder groups form a last row. Anything else: a square-ish grid in
 * natural order, filled row by row.
 */
function grid(arr: Float32Array, dim: DimId, groups: Group[], seed: number, marks: "spheres" | "rows" = "spheres"): { placed: Placed[]; deco: Decoration } {
  const put = marks === "rows" ? placeRows : place;
  const placed: Placed[] = [];
  const deco: Decoration = { items: [], extent: [] };
  const months = monthCells(dim, groups);
  const maxCount = Math.max(1, ...groups.map((g) => g.items.length));
  if (months) {
    const years = [...new Set(months.cells.map((c) => c.year))].sort((a, b) => (a ?? 0) - (b ?? 0));
    const rows = years.length + (months.rest.length > 0 ? 1 : 0);
    const rowY = (row: number): number => ((rows - 1) / 2 - row) * CELL;
    const colX = (col: number): number => (col - 5.5) * CELL;
    for (const c of months.cells) placed.push(put(arr, c.g, [colX(c.month - 1), rowY(years.indexOf(c.year)), 0], cellRadius(c.g.items.length, maxCount), seed, true));
    months.rest.forEach((g, i) => placed.push(put(arr, g, [colX(i), rowY(rows - 1), 0], cellRadius(g.items.length, maxCount), seed, false)));
    years.forEach((y, yi) => {
      if (y === null) return;
      const at: Vec3 = [colX(0) - CELL * 0.75, rowY(yi), 0];
      deco.items.push({ type: "label", at, text: String(y), style: "box", align: "right", key: String(y) });
      deco.extent.push([at[0] - CELL * 0.6, at[1], 0]);
    });
    for (let m = 0; m < 12; m++) {
      const at: Vec3 = [colX(m), rowY(0) + CELL * 0.8, 0];
      deco.items.push({ type: "label", at, text: monthName(m + 1), style: "axis", align: "center", key: `month-${m + 1}` });
      deco.extent.push([at[0], at[1], at[2]]);
    }
    return { placed, deco };
  }
  const list = naturalOrder(groups);
  const cols = Math.max(1, Math.ceil(Math.sqrt(list.length)));
  const rows = Math.ceil(list.length / cols);
  const pitch = CELL * 1.4;
  list.forEach((g, i) => placed.push(put(arr, g, [((i % cols) - (cols - 1) / 2) * pitch, ((rows - 1) / 2 - Math.floor(i / cols)) * pitch, 0], cellRadius(g.items.length, maxCount), seed, false)));
  return { placed, deco };
}

/** Scale the positions of overlay items (the frame fit scales everything about the origin). */
function scaleItems(items: readonly OverlayItem[], s: number): OverlayItem[] {
  const v = (p: Vec3): Vec3 => [p[0] * s, p[1] * s, p[2] * s];
  return items.map((it) => {
    switch (it.type) {
      case "label":
        return { ...it, at: v(it.at) };
      case "line":
        return { ...it, a: v(it.a), b: v(it.b) };
      case "polyline":
        return { ...it, points: it.points.map(v) };
      case "rect":
        return { ...it, min: v(it.min), max: v(it.max) };
      default:
        return { ...it, at: v(it.at), radius: it.radius * s };
    }
  });
}

// ───────────────────────────── bundles ─────────────────────────────

/** Most bundles reported (the heaviest ones). */
export const MAX_BUNDLES = 120;

/**
 * Fibre bundles between the group spheres, weighted by the note links that cross between them. Each undirected link
 * counts once; links inside a group, or to items that sit in no group, do not count. With an `apexKey` naming one of
 * the spheres (the kind grouping's hub apex), every other sphere is also joined to it by an apex bundle (flagged
 * `apex`, drawn in azure on top), weighted by how many of the sphere's items belong to a map (at least one).
 */
export function groupBundles(index: DataIndex, placed: readonly Placed[], apexKey?: string): GroupBundle[] {
  if (placed.length < 2) return [];
  const apexAt = apexKey === undefined ? -1 : placed.findIndex((p) => p.key === apexKey);
  const of = new Int32Array(index.count).fill(-1);
  placed.forEach((p, gi) => {
    for (const o of p.items) if (o >= 0 && o < index.count) of[o] = gi;
  });
  const counts = new Map<number, number>();
  const G = placed.length;
  const { offsets, targets } = index.rel.noteLinks;
  for (let o = 0; o < index.count && o + 1 < offsets.length; o++) {
    const a = of[o] as number;
    if (a < 0) continue;
    for (let k = offsets[o] as number; k < (offsets[o + 1] as number); k++) {
      const t = targets[k] as number;
      if (t <= o || t >= index.count) continue;
      const b = of[t] as number;
      if (b < 0 || b === a) continue;
      const key = a < b ? a * G + b : b * G + a;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const ranked = [...counts].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, MAX_BUNDLES);
  const top = ranked[0]?.[1] ?? 1;
  const out: GroupBundle[] = ranked.map(([key, links]) => {
    const pa = placed[Math.floor(key / G)] as Placed;
    const pb = placed[key % G] as Placed;
    return { a: pa.centre, b: pb.centre, ra: pa.radius, rb: pb.radius, links, weight: links / top };
  });
  if (apexAt >= 0) {
    const apex = placed[apexAt] as Placed;
    const member = new Uint8Array(index.count);
    const hm = index.rel.hubMembers;
    for (let h = 0; h + 1 < hm.offsets.length; h++) for (let k = hm.offsets[h] as number; k < (hm.offsets[h + 1] as number); k++) {
      const t = hm.targets[k] as number;
      if (t < index.count) member[t] = 1;
    }
    const rows = placed
      .map((p, gi) => ({ p, gi, links: Math.max(1, p.items.reduce((n, o) => n + (o >= 0 && o < index.count ? (member[o] as number) : 0), 0)) }))
      .filter((r) => r.gi !== apexAt);
    const peak = Math.max(1, ...rows.map((r) => r.links));
    for (const r of rows) out.push({ a: r.p.centre, b: apex.centre, ra: r.p.radius, rb: apex.radius, links: r.links, weight: r.links / peak, apex: true });
  }
  return out;
}

function withBundles(index: DataIndex, res: ArrangementResult, placed: readonly Placed[], apexKey?: string, forms: readonly GroupBundle[] = []): ArrangementResult {
  const bundles = [...groupBundles(index, placed, apexKey), ...forms];
  if (bundles.length > 0) res.bundles = bundles;
  return res;
}

/** One population's layout: its spheres, the lines and decoration drawn with them, and the camera hints. */
interface Family {
  placed: Placed[];
  lines: OverlayItem[];
  extent: Vec3[];
  tilt: number;
  keepUpright: boolean;
  apexKey?: string;
  /** The form's own beams and cones (Map type rail, role comet, the kind T), already scaled to the stage. */
  forms?: GroupBundle[];
  /** The role comet: it turns between lying and standing. */
  sway?: boolean;
}

/** The comet's cluster order: regions by how many items they hold, biggest (the head) first; items without a role count as one more region. */
function cometOrder(groups: readonly Group[]): { g: Group; region: number; regionId: number }[] {
  const regionOf = (g: Group): number => (g.kind === "value" ? (subregionByKey(g.key)?.region ?? -1) : -1);
  const total = new Map<number, number>();
  for (const g of groups) total.set(regionOf(g), (total.get(regionOf(g)) ?? 0) + g.items.length);
  const ranked = [...total.keys()].sort((a, b) => (total.get(b) as number) - (total.get(a) as number) || a - b);
  return groups
    .map((g) => ({ g, regionId: regionOf(g), region: ranked.indexOf(regionOf(g)) }))
    .sort((a, b) => a.region - b.region || b.g.items.length - a.g.items.length || (a.g.key < b.g.key ? -1 : 1));
}

/** Fill the spheres of a form's layout with their points and scale the whole thing to the stage; the form's bundles come back scaled. */
function placeForm(arr: Float32Array, groups: readonly Group[], lay: FormLayout, radii: readonly number[], seed: number, extra: Vec3[] = [], quiet = false): { placed: Placed[]; forms: GroupBundle[]; scale: number } {
  const placed: Placed[] = groups.map((g, i) => {
    const c = lay.centres[i] as Vec3;
    const r = radii[i] as number;
    const hollow = g.items.length < SPARSE_GROUP;
    fillBall(arr, g.items, c, r, hollow, seed);
    return { key: g.key, label: g.label, count: g.items.length, centre: c, radius: r, hollow, items: g.items, ...(quiet ? { quiet: true } : {}) };
  });
  const ends = lay.bundles.flatMap((b) => [b.a, b.b]).map((p): Vec3 => [p[0], p[1], p[2]]);
  const s = fitToFrame(arr, placed, [...extra, ...ends]);
  const forms = lay.bundles.map((b: FormBundle, k): GroupBundle => ({ a: ends[k * 2] as Vec3, b: ends[k * 2 + 1] as Vec3, ra: b.ra * s, rb: b.rb * s, links: 0, weight: b.weight, form: b.form }));
  return { placed, forms, scale: s };
}

/**
 * The figure forms (see forms.ts): the map-type rail, the kind T (only while an area is chosen) and the role comet.
 * Null when the grouping has no form or the groups cannot make one (then the plain spheres are drawn).
 */
function formFamily(dim: DimId, groups: Group[], params: Params, seed: number, arr: Float32Array): Family | null {
  if (dim === "hubType") {
    const MAP_TYPES = ["project", "area", "topic"];
    const sorted = [...groups].sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : 1));
    const spheres = sorted.map((g) => ({ r: groupRadius(g.items.length), role: g.kind === "value" && MAP_TYPES.includes(g.key) ? ("map" as const) : g.kind === "value" && g.key === "none" ? ("base" as const) : ("other" as const) }));
    const lay = railLayout(spheres);
    if (!lay) return null;
    const f = placeForm(arr, sorted, lay, spheres.map((s) => s.r), seed);
    return { placed: f.placed, lines: [], extent: [], tilt: 8, keepUpright: false, forms: f.forms };
  }
  if (dim === "kind" && params.visibility.scope !== "all") {
    const sorted = [...groups].sort((a, b) => b.items.length - a.items.length || (a.key < b.key ? -1 : 1));
    const apex = sorted.findIndex((g) => g.key === APEX_KIND);
    if (apex < 0 || sorted.length < 2) return null;
    const radii = sorted.map((g) => groupRadius(g.items.length));
    const lay = tLayout(radii, apex);
    const f = placeForm(arr, sorted, lay, radii, seed);
    return { placed: f.placed, lines: [], extent: [], tilt: 8, keepUpright: false, apexKey: APEX_KIND, forms: f.forms };
  }
  if (dim === ROLE_DIM) {
    if (groups.length < 2) return null;
    const order = cometOrder(groups);
    const orientation = params.orientation ?? "horizontal";
    const lay = cometLayout(order.map((o) => ({ r: groupRadius(o.g.items.length), region: o.region })), orientation);
    const f = placeForm(arr, order.map((o) => o.g), lay, lay.radii, seed, [], true);
    // One boxed name per brain region, over (lying) or beside (standing) the clusters it covers; it follows them as the comet turns.
    const lines: OverlayItem[] = [];
    const byRegion = new Map<number, { c: Vec3; r: number }[]>();
    order.forEach((o, i) => {
      if (o.regionId < 0) return;
      const p = f.placed[i] as Placed;
      byRegion.set(o.regionId, [...(byRegion.get(o.regionId) ?? []), { c: p.centre, r: p.radius }]);
    });
    // Lying, neighbouring names alternate between two heights so the small clusters of the tail keep readable names.
    const meanR = f.placed.reduce((n, p) => n + p.radius, 0) / Math.max(1, f.placed.length);
    let k = 0;
    for (const [id, members] of [...byRegion].sort((a, b) => Math.min(...a[1].map((m) => m.c[0])) - Math.min(...b[1].map((m) => m.c[0])) || a[0] - b[0])) {
      const key = REGION_KEYS[id];
      if (key === undefined) continue;
      const at = cometLabelAt(members, orientation);
      const lift = orientation === "horizontal" && k % 2 === 1 ? meanR * 0.9 : 0;
      lines.push({ type: "label", at: [at.at[0], at.at[1] + lift, at.at[2]], text: key.charAt(0).toUpperCase() + key.slice(1), style: "box", align: at.align, key: `region:${key}` });
      k++;
    }
    return { placed: f.placed, lines, extent: [], tilt: 8, keepUpright: false, forms: f.forms, sway: true };
  }
  return null;
}

/** Lay `items` out by `dim` in the chosen layout, writing target positions into `arr`; null when no group results. */
function layoutFamily(index: DataIndex, arr: Float32Array, dim: DimId, params: Params, items: number[], pose: Pose): Family | null {
  const groups = buildGroups(index, dim, items, params.merges ?? {}, params.fold === true, params.hideNoValue === true);
  if (groups.length === 0) return null;
  const seed = 1;
  switch (params.layout) {
    case "tree": {
      const t = tree(arr, groups, builtinDim(dim)?.hierarchical === true, seed);
      fitToFrame(arr, t.placed, []);
      // 1 px leaders from each node to its parent (the first level hangs from the root at the left edge).
      const at = new Map(t.placed.map((p) => [p.key, p]));
      const left = Math.min(...t.placed.map((p) => p.centre[0] - p.radius)) - FIGURE.groups.tree.levelGap * 0.4;
      const lines: OverlayItem[] = [];
      for (const p of t.placed) {
        const parent = at.get(t.parentOf.get(p.key) ?? "");
        lines.push({ type: "line", a: parent ? parent.centre : [left, 0, 0], b: p.centre, alpha: parent ? 0.35 : 0.2 });
      }
      return { placed: t.placed, lines, extent: [], tilt: 0, keepUpright: true };
    }
    case "spine":
      return { placed: spine(index, arr, groups, pose, seed), lines: [], extent: [], tilt: 0, keepUpright: false };
    case "strata": {
      const placed = strata(arr, groups, seed);
      fitToFrame(arr, placed, []);
      return { placed, lines: [], extent: [], tilt: 0, keepUpright: true };
    }
    case "wheel":
    case "grid": {
      const w = params.layout === "wheel" ? wheel(arr, dim, groups, seed) : grid(arr, dim, groups, seed, params.layoutOptions?.gridMarks ?? "spheres");
      const s = fitToFrame(arr, w.placed, w.deco.extent);
      return { placed: w.placed, lines: scaleItems(w.deco.items, s), extent: w.deco.extent, tilt: 0, keepUpright: true };
    }
    default: {
      const shaped = formFamily(dim, groups, params, seed, arr);
      if (shaped) return shaped;
      const apexKey = dim === "kind" ? APEX_KIND : undefined;
      const placed = bubbles(arr, groups, seed, apexKey);
      fitToFrame(arr, placed, []);
      return { placed, lines: [], extent: [], tilt: 8, keepUpright: false, ...(apexKey !== undefined && placed.length > 1 && placed.some((p) => p.key === apexKey) ? { apexKey } : {}) };
    }
  }
}

/** Gap between the notes' band and the record band of a split layout, and the record band's size relative to the notes'. */
export const SPLIT_GAP = 0.9;
export const SPLIT_RECORD_SCALE = 0.6;

const markHalfY = (p: Placed): number => p.half?.[1] ?? p.radius;

/** Move (and scale) a whole family: positions of its points, spheres, lines and extent points. */
function transformFamily(f: Family, arr: Float32Array, scale: number, dy: number): void {
  const mv = (v: Vec3): Vec3 => [v[0] * scale, v[1] * scale + dy, v[2] * scale];
  for (let i = 0; i < arr.length; i += 3) {
    if (!Number.isFinite(arr[i] as number)) continue;
    arr[i] = (arr[i] as number) * scale;
    arr[i + 1] = (arr[i + 1] as number) * scale + dy;
    arr[i + 2] = (arr[i + 2] as number) * scale;
  }
  for (const p of f.placed) {
    p.centre = mv(p.centre);
    p.radius *= scale;
    if (p.half) p.half = [p.half[0] * scale, p.half[1] * scale, p.half[2] * scale];
  }
  f.lines = f.lines.map((it) => {
    switch (it.type) {
      case "label":
        return { ...it, at: mv(it.at) };
      case "line":
        return { ...it, a: mv(it.a), b: mv(it.b) };
      case "polyline":
        return { ...it, points: it.points.map(mv) };
      case "rect":
        return { ...it, min: mv(it.min), max: mv(it.max) };
      default:
        return { ...it, at: mv(it.at), radius: it.radius * scale };
    }
  });
  f.extent = f.extent.map(mv);
  if (f.forms) f.forms = f.forms.map((b) => ({ ...b, a: mv(b.a), b: mv(b.b), ra: b.ra * scale, rb: b.rb * scale }));
}

/** Vertical extent of a family (spheres, label anchors and decoration). */
function familySpan(f: Family): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const p of f.placed) {
    min = Math.min(min, p.centre[1] - markHalfY(p));
    max = Math.max(max, p.centre[1] + markHalfY(p));
  }
  for (const e of f.extent) {
    min = Math.min(min, e[1]);
    max = Math.max(max, e[1]);
  }
  return { min, max };
}

/**
 * Split layout: the notes keep their own figure, the record entries get a second, smaller one in a band below it
 * (grouped by their own dimension); the record family's marks and labels carry RECORD_MARK_PREFIX and a "record" chip.
 */
function composeSplit(index: DataIndex, res: ArrangementResult, notes: Family, record: Family, recArr: Float32Array, dim: DimId, recordDim: DimId): ArrangementResult {
  transformFamily(record, recArr, SPLIT_RECORD_SCALE, 0);
  const nSpan = familySpan(notes);
  const rSpan = familySpan(record);
  const dy = nSpan.min - SPLIT_GAP - rSpan.max;
  transformFamily(record, recArr, 1, dy);
  // Centre the pair vertically about the origin (the camera looks at the origin).
  const mid = (nSpan.max + (rSpan.min + dy)) / 2;
  transformFamily(notes, res.arr, 1, -mid);
  transformFamily(record, recArr, 1, -mid);
  for (let i = 0; i < recArr.length; i++) if (Number.isFinite(recArr[i] as number)) res.arr[i] = recArr[i] as number;
  for (const p of record.placed) {
    p.key = RECORD_MARK_PREFIX + p.key;
    p.chip = "record";
  }
  const recLines: OverlayItem[] = [];
  for (const it of record.lines) {
    // The same month names across the top would repeat: the record band keeps its own year boxes only.
    if (it.type === "label" && it.style === "axis" && recordDim === dim) continue;
    recLines.push(it.type === "label" && it.key !== undefined ? { ...it, key: RECORD_MARK_PREFIX + it.key } : it);
  }
  const placed = [...notes.placed, ...record.placed];
  const finished = finish(res, placed, [...notes.lines, ...recLines], notes.tilt, notes.keepUpright, [...notes.extent, ...record.extent]);
  return withBundles(index, finished, placed, notes.apexKey, [...(notes.forms ?? []), ...(record.forms ?? [])]);
}

/**
 * The size of the smallest value group of a grouping, before Fold sends the small ones into Other (the richness hint
 * names it). Null when there is no value group. Items without a value and the folded remainder do not count.
 */
export function thinnestValue(index: DataIndex, dim: DimId, items: readonly number[], merges: MergeMap = {}): number | null {
  const dv = readDim(index, dim, items);
  const mg = merges[dim] ?? {};
  const counts = new Map<string, number>();
  for (const o of items) {
    const code = dv.codes[o] as number;
    if (code === NO_CODE) continue;
    let key = dv.keys[code] ?? "";
    const merged = mg[key];
    if (merged !== undefined && merged !== "") key = merged;
    if (key === "") continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let min: number | null = null;
  for (const n of counts.values()) if (min === null || n < min) min = n;
  return min;
}

/** Groups arrangement; a label grouping also reports its thinnest value on the overlay model (the richness hint). */
export function computeGroupsArrangement(index: DataIndex, params: Params, anat: Float32Array, pose: Pose = resolvePose(undefined)): ArrangementResult {
  const res = arrangeGroups(index, params, anat, pose);
  if (res.overlay.marks.length === 0 || !(isLabelBased(params.dim) || (params.recordDim !== undefined && isLabelBased(params.recordDim)))) return res;
  const vis = normaliseVisibility(params.visibility, index.count);
  const notes: number[] = [];
  const entries: number[] = [];
  for (let i = 0; i < index.count; i++) if (shownNow(index, i, vis)) (params.recordDim !== undefined && index.cols.pop[i] === Population.Record ? entries : notes).push(i);
  const merges = params.merges ?? {};
  let thin: number | null = null;
  const take = (n: number | null): void => {
    if (n !== null && (thin === null || n < thin)) thin = n;
  };
  const split = params.recordDim !== undefined && notes.length > 0 && entries.length > 0;
  if (!split) {
    // One figure (or a record dimension with only one population shown): everything groups by the notes' dimension.
    take(isLabelBased(params.dim) ? thinnestValue(index, params.dim, [...notes, ...entries], merges) : null);
  } else {
    if (isLabelBased(params.dim)) take(thinnestValue(index, params.dim, notes, merges));
    if (params.recordDim !== undefined && isLabelBased(params.recordDim)) take(thinnestValue(index, params.recordDim, entries, merges));
  }
  if (thin !== null) res.overlay.thinnest = thin;
  return res;
}

function arrangeGroups(index: DataIndex, params: Params, anat: Float32Array, pose: Pose): ArrangementResult {
  void anat;
  const n = index.count;
  const res = emptyResult(n);
  const vis = normaliseVisibility(params.visibility, n);
  const items: number[] = [];
  for (let i = 0; i < n; i++) if (shownNow(index, i, vis)) items.push(i);
  if (items.length === 0) return res;
  if (params.recordDim !== undefined) {
    const noteItems = items.filter((o) => index.cols.pop[o] !== Population.Record);
    const recItems = items.filter((o) => index.cols.pop[o] === Population.Record);
    if (noteItems.length > 0 && recItems.length > 0) {
      const recArr = new Float32Array(n * 3).fill(Number.NaN);
      const notes = layoutFamily(index, res.arr, params.dim, params, noteItems, pose);
      const record = layoutFamily(index, recArr, params.recordDim, params, recItems, pose);
      if (notes && record) return composeSplit(index, res, notes, record, recArr, params.dim, params.recordDim);
      res.arr.fill(Number.NaN);
    }
  }
  const f = layoutFamily(index, res.arr, params.dim, params, items, pose);
  if (!f) return res;
  const out = withBundles(index, finish(res, f.placed, f.lines, f.tilt, f.keepUpright, f.extent), f.placed, f.apexKey, f.forms);
  if (f.sway) out.sway = true;
  return out;
}
