/**
 * First paint, the pure part (no three.js): the loose cloud of points that stands in for the figure while the record is
 * read, and its timeline. Owner: first-paint package.
 *
 *  - The cloud fills a SIDE-view brain outline (cerebrum, cerebellum, a stub of brainstem) with two bright comet fans.
 *    Its points live in a local frame: x across the head, y up, z along the head (front is +z). Yaw 90° shows that side
 *    view to a camera looking down -z; yaw 0 is the front view the figure has.
 *  - When the record is ready the cloud turns to the front view over `turnMs` (eased) while its points condense onto
 *    positions of the real figure (matched by height, so the top of the cloud lands on the brain and the bottom on the
 *    cord), the cloud fades and the figure fades in under it.
 *  - Numbers live in RENDER_TUNING.firstPaint. Everything here is deterministic for a seed, so it can be tested.
 */
import { easeInOut, smooth } from "./animation";
import { RENDER_TUNING } from "./tuning";

const P = RENDER_TUNING.firstPaint;

const clamp01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t);

/** Small deterministic generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Whether a point (u along the head, v up; the outline's half-length is 1) is inside the side-view brain. */
export function insideSideBrain(u: number, v: number): boolean {
  // Cerebrum: a wide ellipse with a flattened underside.
  const cer = (u / 1.0) ** 2 + ((v - 0.12) / 0.66) ** 2 <= 1 && v >= -0.42;
  // Cerebellum: a small lobe under the back of the head.
  const cb = ((u + 0.58) / 0.34) ** 2 + ((v + 0.5) / 0.21) ** 2 <= 1;
  // Brainstem: a short stalk.
  const bs = u >= -0.34 && u <= -0.15 && v >= -0.95 && v <= -0.34;
  return cer || cb || bs;
}

export interface Cloud {
  count: number;
  /** x, y, z per point in the local frame (outline half-length 1). */
  local: Float32Array;
  /** 0..1 per point: how bright it is drawn (comet points run hot near their origin). */
  bright: Float32Array;
  /** 1 for the points of a comet fan. */
  comet: Uint8Array;
  /** Palette slot per point (index into RENDER_TUNING.firstPaint.slots). */
  slot: Uint8Array;
  /** Point indices ordered by local height (low to high), for the condense mapping. */
  byHeight: Uint32Array;
}

/** The two fans: an origin on the outline and the direction they spread in (unit, in the u-v plane). */
export const COMETS: readonly { ou: number; ov: number; du: number; dv: number; length: number }[] = [
  { ou: 0.38, ov: 0.74, du: -0.42, dv: -0.9, length: 1.05 },
  { ou: -0.52, ov: -0.46, du: 0.62, dv: 0.78, length: 0.9 },
];

/** The rays of a comet fan and the angle between neighbours (radians). */
export const FAN_RAYS = 7;
export const FAN_STEP = 0.2;

/** Build the cloud: `total` points of which `comet` per fan are comet points. */
export function buildCloud(total: number = P.points, comet: number = P.cometPoints, seed = 7): Cloud {
  const r = rng(seed);
  const n = total + comet * COMETS.length;
  const local = new Float32Array(n * 3);
  const bright = new Float32Array(n);
  const isComet = new Uint8Array(n);
  const slot = new Uint8Array(n);
  let i = 0;
  const put = (u: number, v: number, depth: number, b: number, c: number, s: number): void => {
    local[i * 3] = depth;
    local[i * 3 + 1] = v;
    local[i * 3 + 2] = u;
    bright[i] = b;
    isComet[i] = c;
    slot[i] = s;
    i++;
  };
  // Body: rejection-sampled inside the outline, thickest in the middle (two uniforms make a soft bell).
  while (i < total) {
    const u = -1 + 2 * r();
    const v = -1 + 1.8 * r();
    if (!insideSideBrain(u, v)) continue;
    const w = 0.5 * (1 - 0.55 * Math.min(1, u * u + (v - 0.1) * (v - 0.1)));
    const depth = (r() + r() - 1) * w;
    put(u, v, depth, 0.35 + 0.35 * r(), 0, i % P.slots.length);
  }
  // Comets: points along a ray from the origin, dense and bright near it.
  for (let k = 0; k < COMETS.length; k++) {
    const c = COMETS[k] as (typeof COMETS)[number];
    const norm = Math.hypot(c.du, c.dv) || 1;
    const base = Math.atan2(c.dv / norm, c.du / norm);
    for (let j = 0; j < comet; j++) {
      // A fan: points sit on one of a few rays out of the origin, dense and bright near it.
      const t = r() ** 1.5;
      const ray = Math.floor(r() * FAN_RAYS) - (FAN_RAYS - 1) / 2;
      const ang = base + ray * FAN_STEP + (r() - 0.5) * 0.05;
      const len = t * c.length;
      const u = c.ou + Math.cos(ang) * len;
      const v = c.ov + Math.sin(ang) * len;
      put(u, v, (r() - 0.5) * 0.18, 1 - 0.7 * t, 1, k % P.slots.length);
    }
  }
  const order = Array.from({ length: n }, (_, j) => j).sort((a, b) => (local[a * 3 + 1] as number) - (local[b * 3 + 1] as number));
  return { count: n, local, bright, comet: isComet, slot, byHeight: Uint32Array.from(order) };
}

/** Rotate a local (x, z) about the vertical axis by `yawRad` (0: front view, π/2: side view). Returns [x, z]. */
export function yawXZ(x: number, z: number, yawRad: number): [number, number] {
  const c = Math.cos(yawRad);
  const s = Math.sin(yawRad);
  return [x * c + z * s, -x * s + z * c];
}

export interface PaintClock {
  /** When the cloud started to appear. */
  startMs: number;
  /** When the turn starts (null: still holding). */
  turnStartMs: number | null;
  /** When a cancel started the cloud's fade-out (null: not cancelled). */
  cancelStartMs: number | null;
}

export interface PaintState {
  /** Yaw in degrees: 90 holding, easing to 0 over the turn. */
  yawDeg: number;
  /** 0..1: how far the points have flown to the figure. */
  condense: number;
  /** 0..1: opacity of the cloud. */
  cloudAlpha: number;
  /** 0..1: how much of the real figure shows (0 while holding). */
  figure: number;
  /** The turn has started. */
  turning: boolean;
  /** The cloud has finished (turned and faded, or cancelled and faded): remove it. */
  done: boolean;
}

/** Everything the cloud shows at `nowMs` (pure). */
export function paintState(nowMs: number, c: PaintClock): PaintState {
  const appear = smooth(clamp01((nowMs - c.startMs) / P.fadeInMs));
  if (c.cancelStartMs !== null) {
    const k = clamp01((nowMs - c.cancelStartMs) / P.cancelMs);
    return { yawDeg: P.yawDeg, condense: 0, cloudAlpha: appear * (1 - k), figure: 0, turning: false, done: k >= 1 };
  }
  if (c.turnStartMs === null || nowMs < c.turnStartMs) return { yawDeg: P.yawDeg, condense: 0, cloudAlpha: appear, figure: 0, turning: false, done: false };
  const p = clamp01((nowMs - c.turnStartMs) / P.turnMs);
  return {
    yawDeg: P.yawDeg * (1 - easeInOut(p)),
    condense: easeInOut(clamp01((p - P.condenseFrom) / (1 - P.condenseFrom))),
    cloudAlpha: appear * (1 - smooth(clamp01((p - P.cloudFadeFrom) / (1 - P.cloudFadeFrom)))),
    figure: smooth(clamp01((p - P.figureFrom) / (1 - P.figureFrom))),
    turning: true,
    done: p >= 1,
  };
}

/** When the turn may start: now, but not before the cloud has been held `holdMinMs` (pure). */
export function turnStartAt(startMs: number, nowMs: number): number {
  return Math.max(nowMs, startMs + P.holdMinMs);
}

/** Whether the cloud still needs frames: it is fading in, turning or fading out (a held cloud is still, so the loop idles). */
export function paintBusy(nowMs: number, c: PaintClock, done: boolean): boolean {
  if (done) return false;
  if (c.turnStartMs !== null || c.cancelStartMs !== null) return true;
  return nowMs - c.startMs < P.fadeInMs + 40;
}

/**
 * For each cloud point, the index of the figure sample it condenses onto. Points are matched to samples by rank in
 * height, so the cloud's crown lands on the figure's crown. `sampleY` has the samples' heights (or any ordering axis).
 * `jitter` (0..1) picks neighbours within that share of the ranks so the result is a fuzzy, not a banded, mapping.
 */
export function condenseTargets(cloud: Cloud, sampleCount: number, sampleY: (j: number) => number, seed = 11, jitter = 0.04): Uint32Array {
  const out = new Uint32Array(cloud.count);
  if (sampleCount <= 0) return out;
  const r = rng(seed);
  const order = Array.from({ length: sampleCount }, (_, j) => j).sort((a, b) => sampleY(a) - sampleY(b));
  for (let k = 0; k < cloud.count; k++) {
    const q = clamp01(k / Math.max(1, cloud.count - 1) + (r() - 0.5) * 2 * jitter);
    out[cloud.byHeight[k] as number] = order[Math.min(sampleCount - 1, Math.floor(q * sampleCount))] as number;
  }
  return out;
}
