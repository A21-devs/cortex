/**
 * Connection charts (CORTEX-UX §7.2). Owner: E9.
 *  alluvial    — two stacked axes (Horizontal on the left, Vertical on the right) joined by curved ribbons
 *                ∝ count, ribbons packed with their particles; reading: the widest ribbon labelled with its count;
 *  chord       — category arcs around a circle (arc ∝ items); ribbons weighted by shared conversations or by
 *                links between notes (Weight option); particles ride their category's ribbons; reading: the
 *                thickest ribbon labelled with its weight (P2);
 *  clusters-3d — one Gaussian cluster per (x × y) value, σ ∝ ∛count, centred on an ellipsoid; labels
 *                "‹a› · ‹b›" fade in after the morph; reading: the largest cluster's label enlarged with its count.
 */
import type { DimId } from "../../shared/dims";
import { labelPitch, labelWidth } from "../../shared/chartStage";
import { NONE32 } from "../../shared/index-format";
import type { ArrangementResult, ChartSpec, Vec3 } from "../../shared/protocol/worker";
import {
  axisCategories,
  axisLabel,
  bezier,
  ChartBuilder,
  clamp,
  clearLabels,
  emptyChart,
  flatCamera,
  NO_CODE,
  OTHER_VALUE,
  prepareChart,
  r2u,
  r2v,
  rnd,
  sphereDir,
  THIN_GROUP,
  volumeCamera,
  type ChartContext,
  type ChartRef,
} from "./common";
import { fmtCount, makeReading } from "./readings";

/** The right-hand / second dimension when the vertical zone is empty (Area ↔ Source). */
function secondDim(s: ChartSpec): DimId {
  if (s.y && s.y.dim !== s.x.dim) return s.y.dim;
  return s.x.dim === "source" ? "space" : "source";
}

// ───────────────────────────── alluvial ─────────────────────────────

/**
 * Which stacked nodes get a name: the largest first, each only when its label stands a full label pitch from the ones
 * already named (a node a few pixels tall has no room for its own line; hovering it still names it). `centres` are the
 * world heights of the node centres.
 */
export function namedNodes(centres: readonly number[], sizes: readonly number[], pitch: number): Set<number> {
  const order = centres.map((_, i) => i).filter((i) => sizes[i]! > 0).sort((a, c) => sizes[c]! - sizes[a]!);
  const kept: number[] = [];
  const out = new Set<number>();
  for (const i of order) {
    if (kept.some((y) => Math.abs(y - centres[i]!) < pitch)) continue;
    kept.push(centres[i]!);
    out.add(i);
  }
  return out;
}

export function layoutAlluvial(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, (s) => [s.x.dim, secondDim(s)]);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  const xd = p.spec.x.dim;
  const yd = secondDim(p.spec);
  const L = axisCategories(p, xd, p.spec.x.sort, true);
  const R = axisCategories(p, yd, p.spec.y?.sort ?? "count", false);
  b.categories = L.all;
  const nl = L.list.length;
  const nr = R.list.length;
  const flows = new Map<number, number[]>();
  const leftN = new Float64Array(nl);
  const rightN = new Float64Array(nr);
  let total = 0;
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const l = L.of[o]!;
    const r = R.of[o]!;
    if (l === NO_CODE || r === NO_CODE) continue;
    const key = l * nr + r;
    const list = flows.get(key);
    if (list) list.push(o);
    else flows.set(key, [o]);
    leftN[l]! += 1;
    rightN[r]! += 1;
    total += 1;
  }
  if (total === 0) return b.finish(flatCamera());
  const gap = 0.1;
  const span = 7.0;
  const k = Math.min((span - gap * Math.max(0, nl - 1)) / total, (span - gap * Math.max(0, nr - 1)) / total);
  const stack = (counts: Float64Array) => {
    const tops = new Float64Array(counts.length);
    const used = counts.reduce((a, c) => a + c * k, 0) + gap * Math.max(0, counts.length - 1);
    let y = used / 2;
    for (let i = 0; i < counts.length; i++) {
      tops[i] = y;
      y -= counts[i]! * k + gap;
    }
    return tops;
  };
  const leftTop = stack(leftN);
  const rightTop = stack(rightN);
  const xL = -3.9;
  const xR = 3.9;
  const barW = 0.16;
  const xm = (xL + xR) / 2;
  // Ribbon offsets: at a left node in right-node order, at a right node in left-node order.
  const offL = new Float64Array(nl * nr);
  const offR = new Float64Array(nl * nr);
  for (let l = 0; l < nl; l++) {
    let acc = 0;
    for (let r = 0; r < nr; r++) {
      offL[l * nr + r] = acc;
      acc += (flows.get(l * nr + r)?.length ?? 0) * k;
    }
  }
  for (let r = 0; r < nr; r++) {
    let acc = 0;
    for (let l = 0; l < nl; l++) {
      offR[l * nr + r] = acc;
      acc += (flows.get(l * nr + r)?.length ?? 0) * k;
    }
  }
  const ribbons = [...flows.entries()].sort((a, c) => c[1].length - a[1].length);
  ribbons.forEach(([key, list], rank) => {
    const l = Math.floor(key / nr);
    const r = key % nr;
    const th = list.length * k;
    const yl = leftTop[l]! - offL[key]!;
    const yr = rightTop[r]! - offR[key]!;
    const top = (u: number) => bezier(yl, yl, yr, yr, u);
    const xAt = (u: number) => bezier(xL, xm, xm, xR, u);
    const ref: ChartRef = { x: [xd, L.list[l]!.key], y: [yd, R.list[r]!.key] };
    const midY = top(0.5) - th / 2;
    const mark = b.mark(ref, `${L.list[l]!.label} · ${R.list[r]!.label}`, list.length, { x0: xAt(0.42), y0: midY - th / 2 - 0.02, x1: xAt(0.58), y1: midY + th / 2 + 0.02 });
    for (let q = 0; q < list.length; q++) {
      const o = list[q]!;
      const u = 0.015 + 0.97 * ((r2u(q) + rnd(p, o, 31) * 0.01) % 1);
      const v = 0.08 + 0.84 * r2v(q);
      b.flat(o, xAt(u), top(u) - v * th, mark);
    }
    if (rank < 80) {
      const edgeTop: Vec3[] = [];
      const edgeBottom: Vec3[] = [];
      for (let s = 0; s <= 24; s++) {
        const u = s / 24;
        edgeTop.push([xAt(u), top(u), 0]);
        edgeBottom.push([xAt(u), top(u) - th, 0]);
      }
      b.poly(edgeTop, 0.16);
      b.poly(edgeBottom, 0.16);
    }
    if (rank === 0) {
      b.reading(
        makeReading({
          kind: "widest",
          copyKey: "readings.widest",
          values: { n: fmtCount(list.length) },
          at: [xAt(0.5), midY, 0.05],
          ref,
        }),
      );
    }
  });
  const pitch = labelPitch(p.stage);
  const leftNamed = namedNodes(L.list.map((_, l) => leftTop[l]! - (leftN[l]! * k) / 2), Array.from(leftN, (n) => n), pitch);
  const rightNamed = namedNodes(R.list.map((_, r) => rightTop[r]! - (rightN[r]! * k) / 2), Array.from(rightN, (n) => n), pitch);
  L.list.forEach((c, l) => {
    const yTop = leftTop[l]!;
    const h = leftN[l]! * k;
    if (h <= 0) return;
    const r = { x0: xL - barW, y0: yTop - h, x1: xL, y1: yTop };
    b.rect(r, 0.55);
    b.mark({ x: [xd, c.key] }, c.label, leftN[l]!, r);
    if (leftNamed.has(l)) b.label([xL - barW - 0.12, yTop - h / 2, 0], axisLabel(c.label), "axis", "right", { x: [xd, c.key] });
    if (c.count < THIN_GROUP) b.thin(c.key, c.count);
  });
  R.list.forEach((c, r) => {
    const yTop = rightTop[r]!;
    const h = rightN[r]! * k;
    if (h <= 0) return;
    const rr = { x0: xR, y0: yTop - h, x1: xR + barW, y1: yTop };
    b.rect(rr, 0.55);
    b.mark({ y: [yd, c.key] }, c.label, rightN[r]!, rr);
    if (rightNamed.has(r)) b.label([xR + barW + 0.12, yTop - h / 2, 0], axisLabel(c.label), "axis", "left", { y: [yd, c.key] });
  });
  return b.finish(flatCamera());
}

// ───────────────────────────── chord ─────────────────────────────

const CHORD_R = 3.1;
const CHORD_BAND = 0.18;

function onCircle(r: number, a: number): [number, number] {
  return [r * Math.sin(a), r * Math.cos(a)];
}

function quad(a: number, c: number, d: number, u: number): number {
  const v = 1 - u;
  return v * v * a + 2 * v * u * c + u * u * d;
}

export function layoutChord(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, (s) => [s.x.dim]);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  const xd = p.spec.x.dim;
  const cats = axisCategories(p, xd, p.spec.x.sort, true, { cap: 24 });
  b.categories = cats.all;
  const n = cats.list.length;
  if (n === 0) return b.finish(flatCamera());
  const W = new Float64Array(n * n);
  const fillByLinks = (): void => {
    const member = new Uint8Array(p.index.count);
    for (let i = 0; i < p.members.length; i++) member[p.members[i]!] = 1;
    const { offsets, targets } = p.index.rel.noteLinks;
    for (let i = 0; i < p.members.length; i++) {
      const o = p.members[i]!;
      const a = cats.of[o]!;
      if (a === NO_CODE || o + 1 >= offsets.length) continue;
      for (let e = offsets[o]!; e < offsets[o + 1]!; e++) {
        const q = targets[e]!;
        if (q >= p.index.count || member[q] !== 1) continue;
        const c = cats.of[q]!;
        if (c === NO_CODE || c === a) continue;
        W[a * n + c]! += 0.5;
        W[c * n + a]! += 0.5;
      }
    }
  };
  const fillByConversations = (): void => {
    const perConv = new Map<number, Set<number>>();
    const conv = p.index.cols.conv;
    for (let i = 0; i < p.members.length; i++) {
      const o = p.members[i]!;
      const cv = conv[o]!;
      const a = cats.of[o]!;
      if (cv === NONE32 || a === NO_CODE) continue;
      let set = perConv.get(cv);
      if (!set) {
        set = new Set();
        perConv.set(cv, set);
      }
      set.add(a);
    }
    for (const set of perConv.values()) {
      if (set.size < 2) continue;
      const list = [...set];
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          W[list[i]! * n + list[j]!]! += 1;
          W[list[j]! * n + list[i]!]! += 1;
        }
    }
  };
  if (p.spec.options.weight === "links") fillByLinks();
  else {
    fillByConversations();
    // A vault with no conversations in it has no shared-conversation ties: its ribbons are the links between notes.
    if (!W.some((w) => w > 0)) fillByLinks();
  }
  const T = new Float64Array(n);
  for (let a = 0; a < n; a++) for (let c = 0; c < n; c++) T[a]! += W[a * n + c]!;
  const padA = 0.035;
  const total = cats.list.reduce((s, c) => s + c.count, 0);
  const free = Math.PI * 2 - padA * n;
  const start = new Float64Array(n);
  const end = new Float64Array(n);
  let ang = 0;
  cats.list.forEach((c, a) => {
    start[a] = ang;
    end[a] = ang + (free * c.count) / Math.max(1, total);
    ang = end[a]! + padA;
  });
  // Sub-spans of each arc per ribbon partner, in partner order.
  const sub0 = new Float64Array(n * n);
  const sub1 = new Float64Array(n * n);
  for (let a = 0; a < n; a++) {
    let s = start[a]!;
    const len = end[a]! - start[a]!;
    for (let c = 0; c < n; c++) {
      const w = T[a]! > 0 ? (len * W[a * n + c]!) / T[a]! : 0;
      sub0[a * n + c] = s;
      sub1[a * n + c] = s + w;
      s += w;
    }
  }
  const ribbonPoint = (a: number, c: number, u: number, v: number): [number, number] => {
    // Edges: from a's sub-span start to c's sub-span end, and a's end to c's start, both through the centre.
    const [p0x, p0y] = onCircle(CHORD_R, sub0[a * n + c]!);
    const [p1x, p1y] = onCircle(CHORD_R, sub1[c * n + a]!);
    const [q0x, q0y] = onCircle(CHORD_R, sub1[a * n + c]!);
    const [q1x, q1y] = onCircle(CHORD_R, sub0[c * n + a]!);
    const ex = quad(p0x, 0, p1x, u);
    const ey = quad(p0y, 0, p1y, u);
    const fx = quad(q0x, 0, q1x, u);
    const fy = quad(q0y, 0, q1y, u);
    return [ex + (fx - ex) * v, ey + (fy - ey) * v];
  };
  const buckets: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const a = cats.of[o]!;
    if (a !== NO_CODE) buckets[a]!.push(o);
  }
  const arcMark: number[] = [];
  cats.list.forEach((c, a) => {
    const mid = (start[a]! + end[a]!) / 2;
    const [mx, my] = onCircle(CHORD_R + CHORD_BAND / 2, mid);
    arcMark.push(b.mark({ x: [xd, c.key] }, c.label, c.count, { x0: mx - 0.18, y0: my - 0.18, x1: mx + 0.18, y1: my + 0.18 }));
  });
  for (let a = 0; a < n; a++) {
    const list = buckets[a]!;
    for (let q = 0; q < list.length; q++) {
      const o = list[q]!;
      if (T[a]! <= 0) {
        const angle = start[a]! + r2u(q) * (end[a]! - start[a]!);
        const [x, y] = onCircle(CHORD_R + CHORD_BAND * (0.1 + 0.8 * r2v(q)), angle);
        b.flat(o, x, y, arcMark[a]);
        continue;
      }
      // Choose a partner ∝ weight, deterministically per item.
      let pick = rnd(p, o, 41) * T[a]!;
      let c = 0;
      for (; c < n - 1; c++) {
        pick -= W[a * n + c]!;
        if (pick <= 0 && W[a * n + c]! > 0) break;
      }
      while (W[a * n + c]! <= 0 && c > 0) c -= 1;
      const u = 0.02 + 0.46 * r2u(q);
      const v = 0.1 + 0.8 * r2v(q);
      const [x, y] = ribbonPoint(a, c, u, v);
      b.flat(o, x, y, arcMark[a]);
    }
  }
  // Arcs, labels, ribbon edges and the thickest ribbon.
  const names: { a: number; at: [number, number]; text: string; right: boolean; x: number; y: number; w: number; size: number }[] = [];
  cats.list.forEach((c, a) => {
    const inner: Vec3[] = [];
    const outer: Vec3[] = [];
    for (let s = 0; s <= 24; s++) {
      const angle = start[a]! + ((end[a]! - start[a]!) * s) / 24;
      const [ix, iy] = onCircle(CHORD_R, angle);
      const [ox, oy] = onCircle(CHORD_R + CHORD_BAND, angle);
      inner.push([ix, iy, 0]);
      outer.push([ox, oy, 0]);
    }
    b.poly([...inner, ...outer.reverse()], 0.55, true);
    const mid = (start[a]! + end[a]!) / 2;
    const [lx, ly] = onCircle(CHORD_R + CHORD_BAND + 0.3, mid);
    const text = axisLabel(c.label);
    const w = labelWidth(p.stage, text.length);
    const right = Math.sin(mid) >= 0;
    names.push({ a, at: [lx, ly], text, right, x: right ? lx : lx - w, y: ly, w, size: c.count });
    if (c.count < THIN_GROUP && c.key !== OTHER_VALUE) b.thin(c.key, c.count);
  });
  // Arcs side by side that are too narrow to name each give their name to the larger one.
  const shown = clearLabels(names, labelPitch(p.stage));
  names.forEach((nm, i) => {
    if (shown.has(i)) b.label([nm.at[0], nm.at[1], 0], nm.text, "axis", nm.right ? "left" : "right", { x: [xd, cats.list[nm.a]!.key] });
  });
  const pairs: { a: number; c: number; w: number }[] = [];
  for (let a = 0; a < n; a++) for (let c = a + 1; c < n; c++) if (W[a * n + c]! > 0) pairs.push({ a, c, w: W[a * n + c]! });
  pairs.sort((x, y) => y.w - x.w);
  pairs.slice(0, 60).forEach((pr) => {
    const e1: Vec3[] = [];
    const e2: Vec3[] = [];
    for (let s = 0; s <= 20; s++) {
      const u = s / 20;
      const [x1, y1] = ribbonPoint(pr.a, pr.c, u, 0);
      const [x2, y2] = ribbonPoint(pr.a, pr.c, u, 1);
      e1.push([x1, y1, 0]);
      e2.push([x2, y2, 0]);
    }
    b.poly(e1, 0.18);
    b.poly(e2, 0.18);
  });
  pairs.slice(0, 400).forEach((pr) => {
    const [mx, my] = ribbonPoint(pr.a, pr.c, 0.5, 0.5);
    const ref: ChartRef = { or: [[xd, cats.list[pr.a]!.key], [xd, cats.list[pr.c]!.key]] };
    b.mark(ref, `${cats.list[pr.a]!.label} · ${cats.list[pr.c]!.label}`, Math.round(pr.w), { x0: mx - 0.12, y0: my - 0.12, x1: mx + 0.12, y1: my + 0.12 });
  });
  const top = pairs[0];
  if (top) {
    const [mx, my] = ribbonPoint(top.a, top.c, 0.5, 0.5);
    b.reading(
      makeReading({
        kind: "widest",
        copyKey: "readings.widest",
        values: { n: fmtCount(top.w) },
        at: [mx, my, 0.05],
        ref: { or: [[xd, cats.list[top.a]!.key], [xd, cats.list[top.c]!.key]] },
      }),
    );
  }
  return b.finish(flatCamera());
}

// ───────────────────────────── 3D clusters ─────────────────────────────

const CLUSTER_MAX = 60;
const ELLIPSOID: Vec3 = [5.0, 3.1, 2.8];

/** Standard normal from two uniforms (Box–Muller). */
function normal(u: number, v: number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, u))) * Math.cos(2 * Math.PI * v);
}

/** Centre i of n on a Fibonacci lattice over the ellipsoid (the largest clusters first). */
function ellipsoidPoint(i: number, n: number): Vec3 {
  const yy = n <= 1 ? 0 : 1 - (2 * (i + 0.5)) / n;
  const rr = Math.sqrt(Math.max(0, 1 - yy * yy));
  const th = Math.PI * (3 - Math.sqrt(5)) * i + Math.PI / 2;
  return [Math.cos(th) * rr * ELLIPSOID[0], yy * ELLIPSOID[1], Math.sin(th) * rr * ELLIPSOID[2]];
}

export function layoutClusters3d(ctx: ChartContext): ArrangementResult {
  const p = prepareChart(ctx, (s) => [s.x.dim, secondDim(s)]);
  if (p.members.length === 0) return emptyChart(p);
  const b = new ChartBuilder(p);
  const xd = p.spec.x.dim;
  const yd = secondDim(p.spec);
  const cx = axisCategories(p, xd, p.spec.x.sort, true);
  const cy = axisCategories(p, yd, p.spec.y?.sort ?? "count", false);
  b.categories = cx.all;
  const ny = cy.list.length;
  const pairs = new Map<number, number[]>();
  for (let i = 0; i < p.members.length; i++) {
    const o = p.members[i]!;
    const a = cx.of[o]!;
    const c = cy.of[o]!;
    if (a === NO_CODE || c === NO_CODE) continue;
    const key = a * ny + c;
    const list = pairs.get(key);
    if (list) list.push(o);
    else pairs.set(key, [o]);
  }
  const ranked = [...pairs.entries()].sort((a, c) => c[1].length - a[1].length || a[0] - c[0]);
  const shown = ranked.slice(0, CLUSTER_MAX).map(([key, items]) => ({ key, items, other: false }));
  const rest = ranked.slice(CLUSTER_MAX).flatMap(([, items]) => items);
  if (rest.length > 0) shown.push({ key: -1, items: rest, other: true });
  const n = shown.length;
  const maxCount = shown.reduce((m, c) => Math.max(m, c.items.length), 1);
  const dir: Vec3 = [0, 0, 0];
  let biggest = -1;
  const centres = shown.map((_, i) => ellipsoidPoint(i, n));
  const sigmas = shown.map((cl) => clamp(0.5 * Math.cbrt(cl.items.length / maxCount), 0.07, 0.5));
  shown.forEach((cl, i) => {
    const c = centres[i]!;
    const sigma = sigmas[i]!;
    const a = cl.other ? -1 : Math.floor(cl.key / ny);
    const yc = cl.other ? -1 : cl.key % ny;
    const ref: ChartRef = cl.other ? { x: [xd, OTHER_VALUE] } : { x: [xd, cx.list[a]!.key], y: [yd, cy.list[yc]!.key] };
    const label = cl.other ? "" : `${cx.list[a]!.label} · ${cy.list[yc]!.label}`;
    const s2 = sigma * 2.2;
    const mark = b.mark(ref, label, cl.items.length, { x0: c[0] - s2, y0: c[1] - s2, x1: c[0] + s2, y1: c[1] + s2 }, c[2] - s2, c[2] + s2);
    for (const o of cl.items) {
      const r = Math.min(2.5, Math.abs(normal(rnd(p, o, 51), rnd(p, o, 52))));
      sphereDir(rnd(p, o, 53), rnd(p, o, 54), dir);
      b.place(o, c[0] + dir[0] * r * sigma, c[1] + dir[1] * r * sigma, c[2] + dir[2] * r * sigma, mark);
    }
    if (i < 24 && !cl.other) b.label([c[0], c[1] + sigma * 2.4 + 0.08, c[2]], label, i === 0 ? "title" : "box", "center", ref);
    if (biggest < 0 || cl.items.length > shown[biggest]!.items.length) biggest = i;
    if (cl.items.length < THIN_GROUP && !cl.other) b.thin(`${cx.list[a]!.key}·${cy.list[yc]!.key}`, cl.items.length);
  });
  if (biggest >= 0) {
    const cl = shown[biggest]!;
    const c = centres[biggest]!;
    const at: Vec3 = [c[0], c[1] + sigmas[biggest]! * 2.4 + 0.38, c[2]];
    const a = Math.floor(cl.key / ny);
    const yc = cl.key % ny;
    b.reading(
      makeReading({
        kind: "largest",
        copyKey: "readings.largest",
        values: { n: fmtCount(cl.items.length) },
        at,
        ref: cl.other ? { x: [xd, OTHER_VALUE] } : { x: [xd, cx.list[a]!.key], y: [yd, cy.list[yc]!.key] },
      }),
    );
  }
  return b.finish(volumeCamera(6.2));
}
