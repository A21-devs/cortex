/**
 * Compare charts (CORTEX-UX §7.2). Owner: E9. Every chart is drawn by the same particles; layouts return target
 * positions, an overlay and up to three computed readings (annotations), never a canned question.
 *  ranked-bars    — one horizontal bar per group (sorted), particles packed so length ∝ size; names left, counts
 *                   right; reading: the top bar's count and share at its end;
 *  matrix         — x × y grid, each cell a rectangle filled with its particles (density = count); option
 *                   "Counts in cells"; reading: the busiest cell outlined with its count;
 *  treemap        — squarified nested rectangles of the folder hierarchy (or x then y), area ∝ size, particles
 *                   fill the leaves; options "Show all levels" and the Folders checklist (`excludedFolders`);
 *                   reading: the largest top-level box's share inside it;
 *  icicle         — indented horizontal bands in tree order; rows expand and collapse (`collapsed`/`expanded`);
 *                   Folders checklist; reading: the deepest branch's depth ("6 levels") at its end;
 *  bubble-pack    — one sphere per group (radius ∝ ∛size), coloured by the colour zone; reading: "×2.4" between
 *                   the two largest;
 *  nested-bubbles — spheres per group with concentric shells per colour value (largest innermost) plus an Other
 *                   sphere; reading: the largest shell's share (P2).
 */
import { countsOn, matrixPerspective, shellsForm, treemapRoot } from "../../shared/chartOptions";
import { frameUnits, tickRows } from "../../shared/chartStage";
import type { DimId } from "../../shared/dims";
import type { ArrangementResult, ChartSpec, Vec3 } from "../../shared/protocol/worker";
import {
  axisCategories,
  axisLabel,
  bucketise,
  ChartBuilder,
  columnLabels,
  dimOf,
  emptyChart,
  fillBall,
  fillRect,
  flatCamera,
  listStride,
  perspectiveCamera,
  NO_CODE,
  NONE_VALUE,
  packCircles,
  plotRect,
  prepareChart,
  refKey,
  rnd,
  squarify,
  swirlDir,
  THIN_GROUP,
  volumeCamera,
  MAX_REPORTED_CATEGORIES,
  type Category,
  type ChartContext,
  type ChartRef,
  type ListLabel,
  type Prepared,
  type Rect2,
} from "./common";
import { fmtCount, fmtRatio, fmtShare, makeReading, topTwo } from "./readings";

const xAxis = (s: ChartSpec): DimId[] => [s.x.dim];
const xyAxes = (s: ChartSpec): DimId[] => (s.y ? [s.x.dim, s.y.dim] : [s.x.dim]);

// ───────────────────────────── ranked bars ─────────────────────────────

export function layoutRankedBars(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, xAxis);
  const PLOT = plotRect(p.stage);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  const counts = countsOn(p.spec.chart, p.spec.options);
  b.ownCounts = true;
  const dim = p.spec.x.dim;
  const cats = axisCategories(p, dim, p.spec.x.sort, true);
  b.categories = cats.all;
  const list = cats.list;
  const n = list.length;
  const left = PLOT.left;
  const right = PLOT.right - 0.5;
  const top = PLOT.top;
  const bottom = PLOT.bottom + 0.4;
  const slot = (top - bottom) / n;
  const barH = Math.min(0.46, slot * 0.74);
  const maxSize = list.reduce((m, c) => Math.max(m, c.size), 0);
  const buckets = bucketise(p.members, cats.of, n);
  const { stride } = listStride(p.stage, slot);
  const names: ListLabel[] = [];
  let topIdx = 0;
  for (let i = 1; i < n; i++) if (list[i]!.size > list[topIdx]!.size) topIdx = i;
  const ends: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = list[i]!;
    const y = top - slot * (i + 0.5);
    const len = maxSize > 0 ? ((right - left) * c.size) / maxSize : 0;
    const r: Rect2 = { x0: left, y0: y - barH / 2, x1: left + Math.max(len, 0.05), y1: y + barH / 2 };
    ends.push(r.x1);
    const ref: ChartRef = { x: [dim, c.key] };
    const mark = b.mark(ref, c.label, c.count, r);
    fillRect(b, buckets[i]!, r, mark);
    names.push({ y, text: c.label, ref, keep: i === topIdx });
    if (i % stride === 0 && i !== topIdx && counts) b.label([r.x1 + 0.1, y, 0], fmtCount(c.size), "muted", "left");
    if (c.count < THIN_GROUP) {
      b.thin(c.key, c.count);
      b.rect(r, 0.55);
    }
  }
  columnLabels(b, names, left - 0.14, slot);
  b.line([left, top + 0.12, 0], [left, bottom - 0.12, 0], 0.35);
  const tc = list[topIdx]!;
  const ty = top - slot * (topIdx + 0.5);
  b.reading(
    makeReading({
      kind: "largest",
      copyKey: "readings.largest",
      values: { n: `${fmtCount(tc.size)} · ${fmtShare(cats.totalSize > 0 ? tc.size / cats.totalSize : 0)}` },
      at: [ends[topIdx]! + 0.12, ty, 0],
      ref: { x: [dim, tc.key] },
    }),
  );
  return b.finish(flatCamera());
}

// ───────────────────────────── matrix ─────────────────────────────

/** Perspective (CHART-11): depth between neighbouring rows, and the most depth the whole grid may have (world units). */
export const MATRIX_DEPTH_STEP = 0.16;
export const MATRIX_DEPTH_SPAN = 2.4;

export function layoutMatrix(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, xyAxes);
  const PLOT = plotRect(p.stage);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  const xd = p.spec.x.dim;
  const yd = p.spec.y?.dim ?? null;
  const cx = axisCategories(p, xd, p.spec.x.sort, true, { cap: 60 });
  const cy = yd && p.spec.y ? axisCategories(p, yd, p.spec.y.sort, false, { cap: 60 }) : null;
  b.categories = cx.all;
  const nx = cx.list.length;
  const ny = cy ? cy.list.length : 1;
  const cellOf = new Uint32Array(p.index.count).fill(NO_CODE);
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const ix = cx.of[o]!;
    const iy = cy ? cy.of[o]! : 0;
    if (ix !== NO_CODE && iy !== NO_CODE) cellOf[o] = iy * nx + ix;
  }
  const buckets = bucketise(p.members, cellOf, nx * ny);
  const left = PLOT.left;
  const right = PLOT.right;
  const top = PLOT.top;
  const bottom = PLOT.bottom + 0.5;
  const cw = (right - left) / nx;
  const ch = (top - bottom) / ny;
  const pad = Math.min(cw, ch) * 0.07;
  // Perspective: row iy sits iy * dz deep, so the rows recede under the tilted camera (a flat grid when it is off).
  const deep = matrixPerspective(p.spec.options) && ny > 1;
  const dz = deep ? Math.min(MATRIX_DEPTH_STEP, MATRIX_DEPTH_SPAN / (ny - 1)) : 0;
  const rowZ = (iy: number): number => iy * dz;
  let busiest = -1;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const cell = iy * nx + ix;
      const list = buckets[cell]!;
      if (list.length === 0) continue;
      const r: Rect2 = { x0: left + ix * cw + pad, y0: top - (iy + 1) * ch + pad, x1: left + (ix + 1) * cw - pad, y1: top - iy * ch - pad };
      const xc = cx.list[ix]!;
      const yc = cy?.list[iy];
      const ref: ChartRef = yc && yd ? { x: [xd, xc.key], y: [yd, yc.key] } : { x: [xd, xc.key] };
      const z = rowZ(iy);
      const mark = b.mark(ref, yc ? `${xc.label} · ${yc.label}` : xc.label, list.length, r, z - 0.1, z + 0.1);
      fillRect(b, list, r, mark, Math.min(cw, ch) * 0.05);
      if (z !== 0) for (let q = 0; q < list.length; q++) b.arr[list[q]! * 3 + 2] = b.arr[list[q]! * 3 + 2]! + z;
      if (busiest < 0 || list.length > buckets[busiest]!.length) busiest = cell;
    }
  }
  const zMax = rowZ(ny - 1);
  for (let ix = 0; ix <= nx; ix++) b.line([left + ix * cw, top, 0], [left + ix * cw, bottom, zMax], 0.07);
  for (let iy = 0; iy <= ny; iy++) b.line([left, top - iy * ch, Math.max(0, rowZ(iy) - dz / 2)], [right, top - iy * ch, Math.max(0, rowZ(iy) - dz / 2)], 0.07);
  // Column labels: level or rotated; on a crowded axis they stagger over two rows (CHART-03), else one.
  const rows = tickRows(p.stage, cw);
  const colStride = rows === 2 ? Math.max(1, Math.ceil(0.16 / (cw * 2))) : Math.max(1, Math.ceil(0.16 / cw));
  const rotate = cw < 0.95 ? -40 : 0;
  let shownCols = 0;
  cx.list.forEach((c, ix) => {
    if (ix % colStride !== 0) return;
    const row = rows === 2 ? shownCols % 2 : 0;
    shownCols += 1;
    b.label([left + (ix + 0.5) * cw, bottom - 0.16 - row * 0.22, zMax], axisLabel(c.label), "axis", rotate ? "right" : "center", { x: [xd, c.key] }, rotate);
    if (c.count < THIN_GROUP) b.thin(c.key, c.count);
  });
  if (cy && yd) {
    const yRef = yd;
    columnLabels(
      b,
      cy.list.map((c, iy): ListLabel => ({ y: top - (iy + 0.5) * ch, z: rowZ(iy), text: c.label, ref: { y: [yRef, c.key] } })),
      left - 0.14,
      ch,
    );
  }
  if (busiest >= 0) {
    const ix = busiest % nx;
    const iy = Math.floor(busiest / nx);
    const r: Rect2 = { x0: left + ix * cw, y0: top - (iy + 1) * ch, x1: left + (ix + 1) * cw, y1: top - iy * ch };
    const bz = rowZ(iy);
    b.rect(r, 0.95, undefined, bz);
    const xc = cx.list[ix]!;
    const yc = cy?.list[iy];
    b.reading(
      makeReading({
        kind: "largest",
        copyKey: "readings.largest",
        values: { n: fmtCount(buckets[busiest]!.length) },
        at: [(r.x0 + r.x1) / 2, r.y1 + 0.16, bz],
        ref: yc && yd ? { x: [xd, xc.key], y: [yd, yc.key] } : { x: [xd, xc.key] },
      }),
    );
  }
  return b.finish(deep ? perspectiveCamera(zMax, p.stage) : flatCamera());
}

// ───────────────────────────── hierarchy (treemap, icicle) ─────────────────────────────

const SEP = "\u001f";

interface TNode {
  /** Folder path ("a/b/c"), or "x" / "x␟y" category keys for non-folder hierarchies. */
  path: string;
  name: string;
  depth: number;
  /** Items in this subtree (all members, before exclusions). */
  count: number;
  /** Size measure in this subtree after exclusions (layout weight). */
  size: number;
  /** Items in this subtree after exclusions. */
  kept: number;
  /** Items directly in this node (after exclusions). */
  own: number[];
  children: TNode[];
  kids: Map<string, TNode>;
  excluded: boolean;
  ref: ChartRef;
}

interface Hierarchy {
  root: TNode;
  /** True when the hierarchy is the folder tree (Folders checklist applies). */
  folders: boolean;
  dim: DimId;
}

function newNode(path: string, name: string, depth: number, ref: ChartRef): TNode {
  return { path, name, depth, count: 0, size: 0, kept: 0, own: [], children: [], kids: new Map(), excluded: false, ref };
}

/** Folder hierarchy (x is Folder or Folder path) or a two-level x → y hierarchy. */
function buildHierarchy(p: Prepared): Hierarchy {
  const xd = p.spec.x.dim;
  const folders = xd === "folder" || xd === "folderPath";
  const excluded = new Set(Array.isArray(p.spec.options.excludedFolders) ? (p.spec.options.excludedFolders as unknown[]).filter((s): s is string => typeof s === "string") : []);
  const isExcluded = (path: string) => {
    if (excluded.size === 0) return false;
    for (const ex of excluded) if (path === ex || path.startsWith(ex + "/")) return true;
    return false;
  };
  const words = p.index.cols.words;
  const sizeOf = (o: number) => (p.spec.size === "words" ? words[o]! : 1);
  const root = newNode("", "", -1, {});
  const add = (o: number, chain: { key: string; name: string; ref: ChartRef }[], skip: boolean) => {
    let node = root;
    root.count += 1;
    if (!skip) {
      root.kept += 1;
      root.size += sizeOf(o);
    }
    for (const step of chain) {
      let next = node.kids.get(step.key);
      if (!next) {
        next = newNode(step.key, step.name, node.depth + 1, step.ref);
        node.kids.set(step.key, next);
        node.children.push(next);
      }
      node = next;
      node.count += 1;
      if (!skip) {
        node.kept += 1;
        node.size += sizeOf(o);
      }
    }
    if (!skip) node.own.push(o);
  };
  if (folders) {
    const dv = dimOf(p, xd);
    const chains = new Map<number, { chain: { key: string; name: string; ref: ChartRef }[]; skip: boolean }>();
    const noFolder = [{ key: NONE_VALUE, name: "", ref: { x: ["folderPath", NONE_VALUE] } as ChartRef }];
    for (let i = 0; i < p.members.length; i++) {
      const o = p.members[i]!;
      const code = dv.codes[o]!;
      if (code === NO_CODE) {
        add(o, noFolder, false);
        continue;
      }
      let entry = chains.get(code);
      if (!entry) {
        const parts = dv.keys[code]!.split("/").filter((s) => s.length > 0);
        const chain = parts.map((name, k) => {
          const key = parts.slice(0, k + 1).join("/");
          return { key, name, ref: { x: ["folderPath", key] } as ChartRef };
        });
        entry = { chain, skip: isExcluded(chain[chain.length - 1]?.key ?? "") };
        chains.set(code, entry);
      }
      add(o, entry.chain, entry.skip);
    }
  } else {
    const cx = axisCategories(p, xd, p.spec.x.sort, true);
    const yd = p.spec.y?.dim ?? null;
    const cy = yd && p.spec.y ? axisCategories(p, yd, p.spec.y.sort, false) : null;
    for (let i = 0; i < p.members.length; i++) {
      const o = p.members[i]!;
      const xc = cx.list[cx.of[o]!];
      if (!xc) continue;
      const chain: { key: string; name: string; ref: ChartRef }[] = [{ key: xc.key, name: xc.label, ref: { x: [xd, xc.key] } }];
      const yc = cy ? cy.list[cy.of[o]!] : undefined;
      if (yc && yd) chain.push({ key: xc.key + SEP + yc.key, name: yc.label, ref: { x: [xd, xc.key], y: [yd, yc.key] } });
      add(o, chain, false);
    }
  }
  // Skip a common root chain ("wiki" → "kb" …) so the top level is where the tree first branches.
  let top = root;
  while (top.children.length === 1 && top.own.length === 0 && top.children[0]!.children.length > 0) top = top.children[0]!;
  if (top !== root) {
    const shift = top.depth + 1;
    const rebase = (nd: TNode) => {
      nd.depth -= shift;
      nd.children.forEach(rebase);
    };
    top.children.forEach(rebase);
    top.depth = -1;
  }
  const mark = (nd: TNode, ex: boolean) => {
    nd.excluded = ex || (folders && nd.depth >= 0 && isExcluded(nd.path));
    nd.children.sort((a, c) => c.count - a.count || a.name.localeCompare(c.name));
    nd.children.forEach((c) => mark(c, nd.excluded));
  };
  mark(top, false);
  return { root: top, folders, dim: folders ? "folderPath" : xd };
}

/** Every node in DFS order (largest first), for the Folders checklist (`categories`). */
function treeCategories(h: Hierarchy): Category[] {
  const out: Category[] = [];
  const walk = (nd: TNode) => {
    for (const c of nd.children) {
      if (out.length >= MAX_REPORTED_CATEGORIES) return;
      out.push({ key: c.path, label: c.name, count: c.count });
      walk(c);
    }
  };
  walk(h.root);
  return out;
}

function maxDepth(nd: TNode): { depth: number; node: TNode } {
  let best = { depth: nd.depth, node: nd };
  for (const c of nd.children) {
    if (c.excluded || c.kept === 0) continue;
    const d = maxDepth(c);
    if (d.depth > best.depth) best = d;
  }
  return best;
}

// ───────────────────────────── treemap ─────────────────────────────

/** The node at `path` (a folder path, or "x" / "x␟y" keys) below `nd`, or null. */
export function findNode(nd: TNode, path: string): TNode | null {
  if (nd.path === path && nd.depth >= 0) return nd;
  for (const c of nd.children) {
    if (c.depth < 0 || (path !== c.path && !path.startsWith(c.path + "/") && !path.startsWith(c.path + SEP))) continue;
    const hit = findNode(c, path);
    if (hit) return hit;
  }
  return null;
}

/** Screen-space crumb of a drilled treemap: "All › a › b", each segment a label that drills back to its path. */
const CRUMB_X = 14;
const CRUMB_Y = 14;
const CRUMB_CHAR = 6.4;

function crumbLabels(b: ChartBuilder, h: Hierarchy, root: TNode): void {
  const trail: { text: string; path: string; ref: ChartRef }[] = [{ text: "All", path: "", ref: { copy: "chart.crumbAll", drill: "" } }];
  const trailOf = (nd: TNode): TNode[] | null => {
    if (nd === root) return nd.depth >= 0 ? [nd] : [];
    for (const c of nd.children) {
      const t = trailOf(c);
      if (t) return nd.depth >= 0 ? [nd, ...t] : t;
    }
    return null;
  };
  for (const nd of trailOf(h.root) ?? []) trail.push({ text: axisLabel(nd.name, 18), path: nd.path, ref: { drill: nd.path } });
  let x = CRUMB_X;
  trail.forEach((seg, i) => {
    if (i > 0) {
      b.items.push({ type: "label", at: [x, CRUMB_Y, 0], text: "›", style: "muted", align: "left", screen: true });
      x += CRUMB_CHAR * 2;
    }
    b.items.push({ type: "label", at: [x, CRUMB_Y, 0], text: seg.text, style: i === trail.length - 1 ? "title" : "axis", align: "left", key: refKey(seg.ref), screen: true });
    x += (seg.ref.copy ? 3 : seg.text.length) * CRUMB_CHAR * (i === trail.length - 1 ? 1.08 : 1) + CRUMB_CHAR;
  });
}

export function layoutTreemap(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, xyAxes);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  const h = buildHierarchy(p);
  // Drill-in (CHART-19): options.root lays out only that subtree; an unknown path shows the whole tree.
  const rootPath = treemapRoot(p.spec.options);
  const sub = rootPath === "" ? null : findNode(h.root, rootPath);
  const base = sub ? sub.depth + 1 : 0;
  b.categories = h.folders ? treeCategories(h) : axisCategories(p, p.spec.x.dim, p.spec.x.sort, true).all;
  const allLevels = p.spec.options.allLevels === true;
  const fu = frameUnits(p.stage);
  const frame: Rect2 = { x0: -fu.w / 2 + 0.3, y0: -fu.h / 2 + 0.4, x1: fu.w / 2 - 0.3, y1: fu.h / 2 - 0.6 };
  const topRects = new Map<TNode, Rect2>();
  let marks = 0;
  const lay = (nd: TNode, r: Rect2, box: TNode | null) => {
    const kids = nd.children.filter((c) => !c.excluded && c.kept > 0);
    const ownSize = nd.own.reduce((s, o) => s + (p.spec.size === "words" ? p.index.cols.words[o]! : 1), 0);
    const parts = [...kids.map((c) => c.size), ownSize];
    const rects = squarify(parts, r);
    kids.forEach((c, i) => {
      const cr = rects[i]!;
      const w = cr.x1 - cr.x0;
      const hh = cr.y1 - cr.y0;
      if (w <= 0 || hh <= 0) return;
      const pad = Math.min(0.045, w * 0.08, hh * 0.08);
      const inner: Rect2 = { x0: cr.x0 + pad, y0: cr.y0 + pad, x1: cr.x1 - pad, y1: cr.y1 - pad };
      const top = c.depth === base;
      // The top-level box this one sits in: a click on any of its marks drills into it, when it has anything to open.
      const tb = top ? c : box;
      const opens = tb !== null && tb.children.some((g) => !g.excluded && g.kept > 0);
      const mref = (nd: TNode): ChartRef => (opens ? { ...nd.ref, drill: tb!.path } : nd.ref);
      if (top) topRects.set(c, cr);
      if (top || allLevels) b.rect(cr, top ? 0.42 : 0.18);
      if ((top || allLevels) && w > 0.8 && hh > 0.32) b.label([cr.x0 + 0.1, cr.y1 - 0.14, 0.05], axisLabel(c.name), top ? "tile" : "muted", "left", c.ref);
      if (c.kept < THIN_GROUP && top) b.thin(c.path, c.kept);
      if (c.children.length === 0 || c.children.every((g) => g.excluded || g.kept === 0)) {
        const mark = marks < 1500 ? b.mark(mref(c), c.name, c.kept, cr) : -1;
        marks += 1;
        fillRect(b, c.own, inner, mark, 0.02);
      } else lay(c, inner, tb);
    });
    if (nd.own.length > 0 && nd.depth >= 0) {
      const or = rects[kids.length]!;
      if (or.x1 > or.x0 && or.y1 > or.y0) {
        const own: ChartRef = box !== null ? { ...nd.ref, drill: box.path } : nd.ref;
        const mark = marks < 1500 ? b.mark(own, nd.name, nd.own.length, or) : -1;
        marks += 1;
        fillRect(b, nd.own, or, mark, 0.02);
      }
    }
  };
  const scope = sub ?? h.root;
  lay(scope, frame, null);
  if (sub) crumbLabels(b, h, sub);
  const tops = [...topRects.keys()];
  if (tops.length > 0 && scope.size > 0) {
    const big = tops.reduce((a, c) => (c.size > a.size ? c : a));
    const r = topRects.get(big)!;
    b.reading(
      makeReading({
        kind: "share",
        copyKey: "readings.largest",
        values: { n: fmtShare(big.size / scope.size) },
        at: [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, 0.1],
        ref: big.ref,
      }),
    );
  }
  return b.finish(flatCamera());
}

// ───────────────────────────── icicle ─────────────────────────────

const ICICLE_ROWS = 40;

function stringSet(v: unknown): Set<string> {
  return new Set(Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
}

export function layoutIcicle(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, xyAxes);
  const PLOT = plotRect(p.stage);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  const h = buildHierarchy(p);
  const counts = countsOn(p.spec.chart, p.spec.options);
  b.ownCounts = true;
  b.categories = h.folders ? treeCategories(h) : axisCategories(p, p.spec.x.dim, p.spec.x.sort, true).all;
  const collapsed = stringSet(p.spec.options.collapsed);
  const expanded = stringSet(p.spec.options.expanded);
  // Default expansion depth: as deep as fits in ~40 rows.
  const live = (nd: TNode) => nd.children.filter((c) => !c.excluded && c.kept > 0);
  let autoDepth = 0;
  for (let d = 0; d < 32; d++) {
    let rows = 0;
    const count = (nd: TNode, depth: number) => {
      for (const c of live(nd)) {
        rows += 1;
        if (depth < d) count(c, depth + 1);
      }
    };
    count(h.root, 0);
    if (rows > ICICLE_ROWS) break;
    autoDepth = d;
  }
  const isOpen = (nd: TNode) => live(nd).length > 0 && (expanded.has(nd.path) || (nd.depth < autoDepth && !collapsed.has(nd.path)));
  const rows: TNode[] = [];
  const walk = (nd: TNode) => {
    for (const c of live(nd)) {
      rows.push(c);
      if (isOpen(c)) walk(c);
    }
  };
  walk(h.root);
  if (rows.length === 0) return b.finish(flatCamera());
  const left = PLOT.left + 0.2;
  const right = PLOT.right - 0.4;
  const top = PLOT.top;
  const bottom = PLOT.bottom;
  const slot = Math.min(0.42, (top - bottom) / rows.length);
  const bandH = slot * 0.72;
  const indent = 0.3;
  const rootSize = h.root.size || 1;
  const rowEnd = new Map<TNode, { x: number; y: number }>();
  const sizeOf = (o: number) => (p.spec.size === "words" ? p.index.cols.words[o]! : 1);
  rows.forEach((nd, i) => {
    const y = top - slot * (i + 0.5);
    const x0 = left + nd.depth * indent;
    const full = Math.max(0.05, (right - x0) * (nd.size / rootSize));
    const band: Rect2 = { x0, y0: y - bandH / 2, x1: x0 + full, y1: y + bandH / 2 };
    rowEnd.set(nd, { x: band.x1, y });
    const open = isOpen(nd);
    const ref: ChartRef = live(nd).length > 0 ? { ...nd.ref, fold: nd.path } : nd.ref;
    b.label([x0 - 0.1, y, 0], axisLabel(nd.name), "tile", "right", ref);
    if (counts) b.label([band.x1 + 0.1, y, 0], fmtCount(nd.kept), "muted", "left");
    if (open) {
      // The band spans the whole subtree; only its own files are drawn here (children have their own rows).
      b.rect(band, 0.3);
      const ownSize = nd.own.reduce((s, o) => s + sizeOf(o), 0);
      if (nd.own.length > 0) {
        const seg: Rect2 = { x0, y0: band.y0, x1: x0 + Math.max(0.04, full * (ownSize / Math.max(1, nd.size))), y1: band.y1 };
        fillRect(b, nd.own, seg, b.mark(nd.ref, nd.name, nd.own.length, seg), 0.02);
      }
    } else {
      const items: number[] = [];
      const gather = (n: TNode) => {
        for (const o of n.own) items.push(o);
        for (const c of n.children) if (!c.excluded) gather(c);
      };
      gather(nd);
      fillRect(b, items, band, b.mark(nd.ref, nd.name, items.length, band), 0.02);
    }
    if (nd.kept < THIN_GROUP && nd.depth === 0) b.thin(nd.path, nd.kept);
  });
  const deepest = maxDepth(h.root);
  if (deepest.depth >= 0) {
    let anchor: TNode | null = deepest.node;
    const parentOf = new Map<TNode, TNode>();
    const link = (nd: TNode): void => {
      for (const c of nd.children) {
        parentOf.set(c, nd);
        link(c);
      }
    };
    link(h.root);
    while (anchor && !rowEnd.has(anchor)) anchor = parentOf.get(anchor) ?? null;
    const end = anchor ? rowEnd.get(anchor) : undefined;
    if (end) {
      b.reading(
        makeReading({
          kind: "longest",
          copyKey: "readings.levels",
          values: { n: deepest.depth + 1 },
          at: [Math.min(end.x + 0.75, 6.2), end.y, 0],
          ref: deepest.node.ref,
        }),
      );
    }
  }
  return b.finish(flatCamera());
}

// ───────────────────────────── bubble pack ─────────────────────────────

interface Bubble {
  x: number;
  y: number;
  r: number;
}

/** Pack group spheres (radius ∝ ∛size) and scale them into the frame. */
function packBubbles(sizes: readonly number[]): { bubbles: Bubble[]; extent: number } {
  const radii = sizes.map((s) => Math.cbrt(Math.max(1, s)));
  const order = radii.map((_, i) => i).sort((a, c) => radii[c]! - radii[a]! || a - c);
  const packed = packCircles(order.map((i) => radii[i]!), 0.08 * (radii[order[0]!] ?? 1));
  const tmp: Bubble[] = new Array(sizes.length);
  order.forEach((i, k) => {
    const c = packed[k]!;
    tmp[i] = { x: c.x, y: c.y, r: c.r };
  });
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const c of tmp) {
    minX = Math.min(minX, c.x - c.r);
    maxX = Math.max(maxX, c.x + c.r);
    minY = Math.min(minY, c.y - c.r);
    maxY = Math.max(maxY, c.y + c.r);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const s = Math.min(11.6 / Math.max(1e-6, maxX - minX), 6.6 / Math.max(1e-6, maxY - minY));
  const bubbles = tmp.map((c) => ({ x: (c.x - cx) * s, y: (c.y - cy) * s - 0.15, r: c.r * s }));
  return { bubbles, extent: Math.max(((maxX - minX) * s) / 2, ((maxY - minY) * s) / 2) };
}

export function layoutBubblePack(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, xAxis);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  const dim = p.spec.x.dim;
  const cats = axisCategories(p, dim, p.spec.x.sort, true);
  b.categories = cats.all;
  const list = cats.list;
  const { bubbles, extent } = packBubbles(list.map((c) => c.size));
  const buckets = bucketise(p.members, cats.of, list.length);
  list.forEach((c, i) => {
    const bb = bubbles[i]!;
    const ref: ChartRef = { x: [dim, c.key] };
    const mark = b.mark(ref, c.label, c.count, { x0: bb.x - bb.r, y0: bb.y - bb.r, x1: bb.x + bb.r, y1: bb.y + bb.r }, -bb.r, bb.r);
    const thin = c.count < THIN_GROUP;
    fillBall(b, buckets[i]!, [bb.x, bb.y, 0], bb.r * 0.96, mark, thin);
    b.label([bb.x, bb.y + bb.r + 0.14, 0], axisLabel(c.label), "box", "center", ref);
    if (thin) {
      b.thin(c.key, c.count);
      b.label([bb.x, bb.y, bb.r], String(c.count), "muted", "center");
    }
  });
  const [a, c2] = topTwo(list.map((c) => c.size));
  if (a >= 0 && c2 >= 0) {
    const A = bubbles[a]!;
    const B = bubbles[c2]!;
    b.reading(
      makeReading({
        kind: "largest",
        copyKey: "readings.ratio",
        values: { r: fmtRatio(list[a]!.size / list[c2]!.size) },
        at: [(A.x + B.x) / 2, (A.y + B.y) / 2, Math.max(A.r, B.r)],
        ref: { x: [dim, list[a]!.key] },
      }),
    );
  }
  return b.finish(volumeCamera(Math.max(4.2, extent * 1.25)));
}

// ───────────────────────────── nested bubbles ─────────────────────────────

/** Most rows and columns of the Shells rows form (the rest fold into Other). */
export const SHELL_ROWS_MAX = 7;
export const SHELL_COLS_MAX = 8;
/** Spiral arms and turns of a swirl-textured sphere. */
export const SWIRL_ARMS = 3;
export const SWIRL_TURNS = 2.5;

/**
 * Shells as rows (CHART-16): one row per group (first zone), one sphere per value of the shell dimension (second zone),
 * its radius growing with the cube root of the count, the value's name beneath. Each sphere's particles lie along
 * spiral arms (`swirlDir`), so the sphere reads as a swirl rather than a scatter. With more than three rows the names
 * sit once, under the last row; fewer rows name every sphere.
 */
function layoutShellRows(p: Prepared, b: ChartBuilder, xd: DimId, sd: DimId): ArrangementResult {
  const groups = axisCategories(p, xd, p.spec.x.sort, true, { cap: SHELL_ROWS_MAX, top: SHELL_ROWS_MAX });
  const shells = axisCategories(p, sd, "count", false, { cap: SHELL_COLS_MAX, top: SHELL_COLS_MAX });
  b.categories = groups.all;
  const R = groups.list.length;
  const C = shells.list.length;
  if (R === 0 || C === 0) return b.finish(volumeCamera(7.6));
  const cellOf = new Uint32Array(p.index.count).fill(NO_CODE);
  const counts = new Float64Array(R * C);
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const g = groups.of[o]!;
    const s = shells.of[o]!;
    if (g === NO_CODE || s === NO_CODE) continue;
    cellOf[o] = g * C + s;
    counts[g * C + s]! += 1;
  }
  const buckets = bucketise(p.members, cellOf, R * C);
  const left = -4.6;
  const right = 5.8;
  const top = 3.3;
  const bottom = R > 3 ? -2.7 : -2.5;
  const rh = (top - bottom) / R;
  const cw = (right - left) / C;
  let biggest = 0;
  for (let k = 0; k < counts.length; k++) biggest = Math.max(biggest, counts[k]!);
  const rMax = Math.min(rh * 0.4, cw * 0.46, 0.95);
  const named = R <= 3;
  const best = { g: -1, s: -1, count: 0 };
  const dir: Vec3 = [0, 0, 0];
  groups.list.forEach((gc, g) => {
    const cy = top - rh * (g + 0.5);
    const gref: ChartRef = { x: [xd, gc.key] };
    b.label([left - 0.18, cy, 0], axisLabel(gc.label), "axis", "right", gref);
    if (gc.count < THIN_GROUP) b.thin(gc.key, gc.count);
    shells.list.forEach((sc, s) => {
      const n = counts[g * C + s]!;
      if (n <= 0) return;
      const cx = left + cw * (s + 0.5);
      const r = Math.max(0.05, rMax * Math.cbrt(n / biggest));
      const mark = b.mark({ x: [xd, gc.key], y: [sd, sc.key] }, `${gc.label} · ${sc.label}`, n, { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r }, -r, r);
      const list = buckets[g * C + s]!;
      const phase = (g * 7 + s * 3) * 0.9;
      for (let k = 0; k < list.length; k++) {
        const o = list[k]!;
        swirlDir(k, list.length, SWIRL_ARMS, SWIRL_TURNS, phase, dir);
        const rad = r * (0.86 + 0.14 * rnd(p, o, 8));
        b.place(o, cx + dir[0]! * rad, cy + dir[1]! * rad, dir[2]! * rad, mark);
      }
      if (n > best.count) Object.assign(best, { g, s, count: n });
      if (named) b.label([cx, cy - r - 0.16, 0], axisLabel(sc.label), "muted", "center", { y: [sd, sc.key] });
    });
  });
  if (!named) {
    const nameRows = tickRows(p.stage, cw);
    shells.list.forEach((sc, s) => b.label([left + cw * (s + 0.5), bottom - 0.2 - (nameRows === 2 ? (s % 2) * 0.22 : 0), 0], axisLabel(sc.label), "muted", "center", { y: [sd, sc.key] }));
  }
  if (best.g >= 0) {
    const total = groups.list[best.g]!.count;
    b.reading(
      makeReading({
        kind: "share",
        copyKey: "readings.largest",
        values: { n: fmtShare(best.count / Math.max(1, total)) },
        at: [left + cw * (best.s + 0.5), top - rh * (best.g + 0.5), rMax],
        ref: { x: [xd, groups.list[best.g]!.key], y: [sd, shells.list[best.s]!.key] },
      }),
    );
  }
  return b.finish(volumeCamera(7.6));
}

export function layoutNestedBubbles(ctx: ChartContext): ArrangementResult {
  const shellDimOf = (s: ChartSpec): DimId => s.colour ?? s.y?.dim ?? (s.x.dim === "source" ? "space" : "source");
  const p = prepareChart(ctx, (s) => [s.x.dim, shellDimOf(s)]);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  const xd = p.spec.x.dim;
  const sd = shellDimOf(p.spec);
  if (shellsForm(p.spec.options) === "rows") return layoutShellRows(p, b, xd, sd);
  const groups = axisCategories(p, xd, p.spec.x.sort, true);
  const shells = axisCategories(p, sd, "count", false, { cap: 8, top: 8 });
  b.categories = groups.all;
  const ng = groups.list.length;
  const ns = shells.list.length;
  const { bubbles, extent } = packBubbles(groups.list.map((c) => c.size));
  // Per group: shell counts, ordered largest innermost.
  const counts = new Float64Array(ng * ns);
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const g = groups.of[o]!;
    const s = shells.of[o]!;
    if (g !== NO_CODE && s !== NO_CODE) counts[g * ns + s]! += 1;
  }
  const shellOrder: number[][] = [];
  const bounds: number[][] = [];
  for (let g = 0; g < ng; g++) {
    const ord = Array.from({ length: ns }, (_, s) => s)
      .filter((s) => counts[g * ns + s]! > 0)
      .sort((a, c) => counts[g * ns + c]! - counts[g * ns + a]! || a - c);
    shellOrder.push(ord);
    const total = ord.reduce((t, s) => t + counts[g * ns + s]!, 0);
    let cum = 0;
    const R = bubbles[g]!.r * 0.96;
    bounds.push(
      ord.map((s) => {
        cum += counts[g * ns + s]!;
        return R * Math.cbrt(cum / Math.max(1, total));
      }),
    );
  }
  const cellOf = new Uint32Array(p.index.count).fill(NO_CODE);
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const g = groups.of[o]!;
    const s = shells.of[o]!;
    if (g !== NO_CODE && s !== NO_CODE) cellOf[o] = g * ns + s;
  }
  const buckets = bucketise(p.members, cellOf, ng * ns);
  const best = { g: -1, k: -1, share: 0, count: 0 };
  groups.list.forEach((gc, g) => {
    const bb = bubbles[g]!;
    const ref: ChartRef = { x: [xd, gc.key] };
    const mark = b.mark(ref, gc.label, gc.count, { x0: bb.x - bb.r, y0: bb.y - bb.r, x1: bb.x + bb.r, y1: bb.y + bb.r }, -bb.r, bb.r);
    const ord = shellOrder[g]!;
    const rs = bounds[g]!;
    const total = ord.reduce((t, s) => t + counts[g * ns + s]!, 0);
    ord.forEach((s, k) => {
      const inner = k === 0 ? 0 : rs[k - 1]!;
      fillBall(b, buckets[g * ns + s]!, [bb.x, bb.y, 0], rs[k]!, mark, false, inner);
      if (k < ord.length - 1) {
        const ring: Vec3[] = [];
        for (let a = 0; a <= 40; a++) ring.push([bb.x + Math.cos((a / 40) * Math.PI * 2) * rs[k]!, bb.y + Math.sin((a / 40) * Math.PI * 2) * rs[k]!, 0]);
        b.poly(ring, 0.16, true);
      }
      const c = counts[g * ns + s]!;
      if (c > best.count) Object.assign(best, { g, k, share: c / Math.max(1, total), count: c });
    });
    b.label([bb.x, bb.y + bb.r + 0.14, 0], axisLabel(gc.label), "box", "center", ref);
    if (gc.count < THIN_GROUP) b.thin(gc.key, gc.count);
  });
  if (best.g >= 0) {
    const bb = bubbles[best.g]!;
    const s = shellOrder[best.g]![best.k]!;
    b.reading(
      makeReading({
        kind: "share",
        copyKey: "readings.largest",
        values: { n: fmtShare(best.share) },
        at: [bb.x, bb.y, bb.r],
        ref: { x: [xd, groups.list[best.g]!.key], y: [sd, shells.list[s]!.key] },
      }),
    );
  }
  return b.finish(volumeCamera(Math.max(4.2, extent * 1.25)));
}
