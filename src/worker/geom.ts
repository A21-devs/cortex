/**
 * Pure helpers for the layout worker. Owner: E8. No DOM, no Node; no allocation in hot loops (callers pass `out`).
 *  - vector and interpolation helpers, superellipsoid radius, polylines with an arc-length table;
 *  - deterministic integer hashing and seeded random streams (same data + seed → same figure);
 *  - circle packing (front chain, largest first) and the squarified treemap;
 *  - time-sliced jobs: layouts are generators that `yield` progress at checkpoints, so the handler can slice them
 *    (inline mode keeps the UI thread responsive), observe cancellation between slices and post progress; pure
 *    callers and tests run them to completion with `runJob`.
 */
import type { Vec3 } from "../shared/protocol/worker";

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
export const TAU = Math.PI * 2;

// ───────────────────────────── scalars ─────────────────────────────

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Angle wrapped into [0, 2π). */
export function wrapAngle(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/** Piecewise-linear lookup in a table with ascending `xs`; clamps beyond both ends (like numpy.interp). */
export function interpTable(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  if (n === 0) return 0;
  if (x <= (xs[0] as number)) return ys[0] as number;
  if (x >= (xs[n - 1] as number)) return ys[n - 1] as number;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] as number) <= x) lo = mid;
    else hi = mid;
  }
  const x0 = xs[lo] as number;
  const x1 = xs[hi] as number;
  const t = x1 > x0 ? (x - x0) / (x1 - x0) : 0;
  return lerp(ys[lo] as number, ys[hi] as number, t);
}

// ───────────────────────────── vectors ─────────────────────────────

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return [x, y, z];
}

export function length3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

/** Normalise in place (a zero vector becomes +Y). */
export function normalize3(v: Vec3): Vec3 {
  const l = length3(v[0], v[1], v[2]);
  if (l < 1e-12) {
    v[0] = 0;
    v[1] = 1;
    v[2] = 0;
    return v;
  }
  v[0] /= l;
  v[1] /= l;
  v[2] /= l;
  return v;
}

export function cross3(a: Vec3, b: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  out[0] = x;
  out[1] = y;
  out[2] = z;
  return out;
}

/** i-th of n points evenly spread on the unit sphere (Fibonacci lattice). */
export function fibonacciSphere(i: number, n: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const y = n <= 1 ? 0 : 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const th = GOLDEN_ANGLE * i;
  out[0] = Math.cos(th) * r;
  out[1] = y;
  out[2] = Math.sin(th) * r;
  return out;
}

/**
 * Distance from the centre to the surface of the superellipsoid |x/a|^e + |y/b|^e + |z/c|^e = 1 along the unit
 * direction (dx, dy, dz).
 */
export function superellipsoidRadius(dx: number, dy: number, dz: number, ax: readonly number[], e: number): number {
  const s = Math.pow(Math.abs(dx / (ax[0] as number)), e) + Math.pow(Math.abs(dy / (ax[1] as number)), e) + Math.pow(Math.abs(dz / (ax[2] as number)), e);
  return s > 0 ? Math.pow(s, -1 / e) : 0;
}

/** True when (x, y, z) lies inside the superellipsoid centred at c with semi-axes ax (scaled by k). */
export function insideSuperellipsoid(x: number, y: number, z: number, c: readonly number[], ax: readonly number[], e: number, k = 1): boolean {
  const qx = Math.abs((x - (c[0] as number)) / ((ax[0] as number) * k));
  const qy = Math.abs((y - (c[1] as number)) / ((ax[1] as number) * k));
  const qz = Math.abs((z - (c[2] as number)) / ((ax[2] as number) * k));
  return Math.pow(qx, e) + Math.pow(qy, e) + Math.pow(qz, e) < 1;
}

// ───────────────────────────── curves ─────────────────────────────

/** Catmull-Rom interpolation of scalar control points at u ∈ [0, 1] (uniform parameterisation). */
export function catmullRom(points: readonly number[], u: number): number {
  const n = points.length;
  if (n === 0) return 0;
  if (n === 1) return points[0] as number;
  const x = clamp01(u) * (n - 1);
  const i = Math.min(n - 2, Math.floor(x));
  const t = x - i;
  const p0 = points[Math.max(0, i - 1)] as number;
  const p1 = points[i] as number;
  const p2 = points[i + 1] as number;
  const p3 = points[Math.min(n - 1, i + 2)] as number;
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** A polyline (xyz triples) with its normalised cumulative arc length (0 at the first point, 1 at the last). */
export interface ArcPolyline {
  readonly pts: Float64Array;
  readonly arc: Float64Array;
  readonly length: number;
  readonly count: number;
}

export function arcPolyline(pts: Float64Array): ArcPolyline {
  const count = Math.floor(pts.length / 3);
  const arc = new Float64Array(Math.max(1, count));
  let acc = 0;
  for (let i = 1; i < count; i++) {
    const dx = (pts[i * 3] as number) - (pts[i * 3 - 3] as number);
    const dy = (pts[i * 3 + 1] as number) - (pts[i * 3 - 2] as number);
    const dz = (pts[i * 3 + 2] as number) - (pts[i * 3 - 1] as number);
    acc += Math.sqrt(dx * dx + dy * dy + dz * dz);
    arc[i] = acc;
  }
  if (acc > 0) for (let i = 1; i < count; i++) arc[i] = (arc[i] as number) / acc;
  return { pts, arc, length: acc, count };
}

/** Segment index j with arc[j] ≤ s < arc[j+1] (clamped) and the fraction inside it. */
function locate(p: ArcPolyline, s: number): { j: number; f: number } {
  const n = p.count;
  if (n < 2) return { j: 0, f: 0 };
  const x = clamp01(s);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((p.arc[mid] as number) <= x) lo = mid;
    else hi = mid;
  }
  const a0 = p.arc[lo] as number;
  const a1 = p.arc[hi] as number;
  return { j: lo, f: a1 > a0 ? (x - a0) / (a1 - a0) : 0 };
}

/** Point at arc fraction s ∈ [0, 1]. */
export function pointAt(p: ArcPolyline, s: number, out: Vec3 = [0, 0, 0]): Vec3 {
  if (p.count === 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    return out;
  }
  if (p.count === 1) {
    out[0] = p.pts[0] as number;
    out[1] = p.pts[1] as number;
    out[2] = p.pts[2] as number;
    return out;
  }
  const { j, f } = locate(p, s);
  const a = j * 3;
  const b = Math.min(p.count - 1, j + 1) * 3;
  out[0] = lerp(p.pts[a] as number, p.pts[b] as number, f);
  out[1] = lerp(p.pts[a + 1] as number, p.pts[b + 1] as number, f);
  out[2] = lerp(p.pts[a + 2] as number, p.pts[b + 2] as number, f);
  return out;
}

/** Unit direction of the polyline at arc fraction s (the direction of travel). */
export function tangentAt(p: ArcPolyline, s: number, out: Vec3 = [0, 0, 0]): Vec3 {
  if (p.count < 2) {
    out[0] = 0;
    out[1] = -1;
    out[2] = 0;
    return out;
  }
  const { j } = locate(p, s);
  const a = Math.min(j, p.count - 2) * 3;
  out[0] = (p.pts[a + 3] as number) - (p.pts[a] as number);
  out[1] = (p.pts[a + 4] as number) - (p.pts[a + 1] as number);
  out[2] = (p.pts[a + 5] as number) - (p.pts[a + 2] as number);
  return normalize3(out);
}

// ───────────────────────────── deterministic randomness ─────────────────────────────

/** 32-bit integer avalanche hash (lowbias32). */
export function mix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash of two integers. */
export function hash2(a: number, b: number): number {
  return mix32((mix32(a) ^ Math.imul(b >>> 0, 0x9e3779b9)) >>> 0);
}

/** Stable value in [0, 1) for (seed, a, salt). */
export function unit3(seed: number, a: number, salt: number): number {
  return hash2(hash2(seed, a), salt) / 4294967296;
}

/** A seeded random stream: uniform floats in [0, 1) and standard normals. */
export interface Rng {
  next(): number;
  normal(): number;
  range(lo: number, hi: number): number;
}

export function createRng(seed: number): Rng {
  let a = mix32(seed) || 0x9e3779b9;
  let spare = Number.NaN;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    normal() {
      if (!Number.isNaN(spare)) {
        const s = spare;
        spare = Number.NaN;
        return s;
      }
      const u = Math.max(1e-12, next());
      const v = next();
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(TAU * v);
      return r * Math.cos(TAU * v);
    },
    range(lo, hi) {
      return lo + (hi - lo) * next();
    },
  };
}

/** A random stream named by a string salt (each part of the figure draws from its own stream). */
export function streamRng(seed: number, salt: string): Rng {
  let h = 0x811c9dc5;
  for (let i = 0; i < salt.length; i++) {
    h ^= salt.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return createRng(hash2(seed, h >>> 0));
}

/** Uniform random unit vector. */
export function randomDirection(rng: Rng, out: Vec3 = [0, 0, 0]): Vec3 {
  for (;;) {
    const x = rng.normal();
    const y = rng.normal();
    const z = rng.normal();
    const l = length3(x, y, z);
    if (l > 1e-9) {
      out[0] = x / l;
      out[1] = y / l;
      out[2] = z / l;
      return out;
    }
  }
}

// ───────────────────────────── circle packing ─────────────────────────────

export interface Circle {
  x: number;
  y: number;
  r: number;
}

interface ChainNode {
  c: Circle;
  next: ChainNode;
  prev: ChainNode;
}

/** Place circle c tangent to both a and b (on the left of a → b). */
function placeTangent(b: Circle, a: Circle, c: Circle): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  if (d2 > 0) {
    let a2 = a.r + c.r;
    a2 *= a2;
    let b2 = b.r + c.r;
    b2 *= b2;
    if (a2 > b2) {
      const x = (d2 + b2 - a2) / (2 * d2);
      const y = Math.sqrt(Math.max(0, b2 / d2 - x * x));
      c.x = b.x - x * dx - y * dy;
      c.y = b.y - x * dy + y * dx;
    } else {
      const x = (d2 + a2 - b2) / (2 * d2);
      const y = Math.sqrt(Math.max(0, a2 / d2 - x * x));
      c.x = a.x + x * dx - y * dy;
      c.y = a.y + x * dy + y * dx;
    }
  } else {
    c.x = a.x + c.r;
    c.y = a.y;
  }
}

function overlaps(a: Circle, b: Circle): boolean {
  const dr = a.r + b.r - 1e-6;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dr > 0 && dr * dr > dx * dx + dy * dy;
}

function chainScore(n: ChainNode): number {
  const a = n.c;
  const b = n.next.c;
  const ab = a.r + b.r;
  const dx = (a.x * b.r + b.x * a.r) / ab;
  const dy = (a.y * b.r + b.y * a.r) / ab;
  return dx * dx + dy * dy;
}

function node(c: Circle): ChainNode {
  const n = { c } as ChainNode;
  n.next = n;
  n.prev = n;
  return n;
}

/**
 * Pack circles (radii given, largest first) around the first one with the front-chain method: every circle is
 * tangent to two already placed ones, none overlap, and the pack grows around the largest. Returns one circle per
 * radius in the input order, centred on the bounding box of the pack.
 */
export function packCircles(radii: readonly number[]): Circle[] {
  const circles: Circle[] = radii.map((r) => ({ x: 0, y: 0, r: Math.max(0, Number.isFinite(r) ? r : 0) }));
  const n = circles.length;
  if (n === 0) return circles;
  const c0 = circles[0] as Circle;
  if (n === 1) return circles;
  const c1 = circles[1] as Circle;
  c0.x = -c1.r;
  c1.x = c0.r;
  c1.y = 0;
  if (n > 2) {
    placeTangent(c0, c1, circles[2] as Circle);
    let a = node(c0);
    let b = node(c1);
    let c = node(circles[2] as Circle);
    a.next = c.prev = b;
    b.next = a.prev = c;
    c.next = b.prev = a;
    pack: for (let i = 3; i < n; i++) {
      const ci = circles[i] as Circle;
      placeTangent(a.c, b.c, ci);
      c = node(ci);
      let j = b.next;
      let k = a.prev;
      let sj = b.c.r;
      let sk = a.c.r;
      do {
        if (sj <= sk) {
          if (overlaps(j.c, c.c)) {
            b = j;
            a.next = b;
            b.prev = a;
            i--;
            continue pack;
          }
          sj += j.c.r;
          j = j.next;
        } else {
          if (overlaps(k.c, c.c)) {
            a = k;
            a.next = b;
            b.prev = a;
            i--;
            continue pack;
          }
          sk += k.c.r;
          k = k.prev;
        }
      } while (j !== k.next);
      c.prev = a;
      c.next = b;
      a.next = b.prev = b = c;
      let best = chainScore(a);
      while ((c = c.next) !== b) {
        const s = chainScore(c);
        if (s < best) {
          a = c;
          best = s;
        }
      }
      b = a.next;
    }
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of circles) {
    x0 = Math.min(x0, c.x - c.r);
    y0 = Math.min(y0, c.y - c.r);
    x1 = Math.max(x1, c.x + c.r);
    y1 = Math.max(y1, c.y + c.r);
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  for (const c of circles) {
    c.x -= cx;
    c.y -= cy;
  }
  return circles;
}

/** Radius of the smallest circle about the origin that holds every circle. */
export function enclosingRadius(circles: readonly Circle[]): number {
  let r = 0;
  for (const c of circles) r = Math.max(r, Math.hypot(c.x, c.y) + c.r);
  return r;
}

// ───────────────────────────── squarified treemap ─────────────────────────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Worst aspect ratio of a row with total area `sum`, smallest `mn` and largest `mx` laid along `side`. */
function worstRatio(sum: number, mn: number, mx: number, side: number): number {
  if (sum <= 0 || side <= 0 || mn <= 0) return Infinity;
  const s2 = side * side;
  const sum2 = sum * sum;
  return Math.max((s2 * mx) / sum2, sum2 / (s2 * mn));
}

/**
 * Squarified treemap (Bruls, Huizing and van Wijk) of `values` inside `rect`: areas proportional to the values,
 * aspect ratios kept close to 1. Returns one rectangle per value in the input order; non-positive values get an
 * empty rectangle at the corner of the space left.
 */
export function squarify(values: readonly number[], rect: Rect): Rect[] {
  const out: Rect[] = values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  const total = values.reduce((s, v) => s + (Number.isFinite(v) && v > 0 ? v : 0), 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return out;
  const scale = (rect.w * rect.h) / total;
  const order = values
    .map((v, i) => ({ i, a: Number.isFinite(v) && v > 0 ? v * scale : 0 }))
    .filter((e) => e.a > 0)
    .sort((p, q) => q.a - p.a || p.i - q.i);
  let x = rect.x;
  let y = rect.y;
  let w = rect.w;
  let h = rect.h;
  let k = 0;
  while (k < order.length) {
    const side = Math.min(w, h);
    const first = order[k] as { i: number; a: number };
    const row: { i: number; a: number }[] = [first];
    let sum = first.a;
    let mn = first.a;
    let mx = first.a;
    k++;
    while (k < order.length) {
      const cand = order[k] as { i: number; a: number };
      const cur = worstRatio(sum, mn, mx, side);
      const next = worstRatio(sum + cand.a, Math.min(mn, cand.a), Math.max(mx, cand.a), side);
      if (next > cur) break;
      row.push(cand);
      sum += cand.a;
      mn = Math.min(mn, cand.a);
      mx = Math.max(mx, cand.a);
      k++;
    }
    const rowArea = sum;
    if (w >= h) {
      // Lay the row as a column on the left.
      const cw = h > 0 ? rowArea / h : 0;
      let yy = y;
      for (const e of row) {
        const eh = cw > 0 ? e.a / cw : 0;
        out[e.i] = { x, y: yy, w: cw, h: eh };
        yy += eh;
      }
      x += cw;
      w = Math.max(0, w - cw);
    } else {
      // Lay the row along the top.
      const rh = w > 0 ? rowArea / w : 0;
      let xx = x;
      for (const e of row) {
        const ew = rh > 0 ? e.a / rh : 0;
        out[e.i] = { x: xx, y, w: ew, h: rh };
        xx += ew;
      }
      y += rh;
      h = Math.max(0, h - rh);
    }
  }
  for (let i = 0; i < out.length; i++) {
    const r = out[i] as Rect;
    if (r.w === 0 && r.h === 0) out[i] = { x, y, w: 0, h: 0 };
  }
  return out;
}

// ───────────────────────────── time-sliced jobs ─────────────────────────────

/** A checkpoint: what the job is doing and how far it got (phase names are stable ids, not copy). */
export interface JobStep {
  phase: string;
  done: number;
  total: number;
}

/** A layout computation that yields at checkpoints and returns its result. */
export type Job<T> = Generator<JobStep, T, void>;

/** Run a job to completion synchronously (tests and pure callers). */
export function runJob<T>(job: Job<T>): T {
  for (;;) {
    const r = job.next();
    if (r.done) return r.value;
  }
}

/** How often hot loops offer a checkpoint (items between yields). */
export const CHECK_EVERY = 4096;
