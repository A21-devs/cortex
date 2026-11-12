/**
 * Camera for the figure. Owner: E10. Numbers: RENDER_TUNING (render/tuning.ts); CORTEX-UX §3.2, §6.7, §6.8.
 *  - perspective, vertical FOV 30°, near 0.1, far 200;
 *  - home view per pose. Standing (the default pose, read from settings): behind the figure turned toward its
 *    right side and slightly above, FITTED BY HEIGHT so the brain's crown sits 9% below the stage top and the
 *    lowest point (the undated cloud past the tip) 8 px above the command line, centred on the free stage
 *    ((24 + stage width − 70) / 2), shrinking in 2% steps until it clears every stage overlay by 8 px. Lying:
 *    the projected bounds fill the safe frame (left 24, top 86, right 70, bottom 76) with a 4% margin;
 *  - Spin (standing default): 360° per 60 s about the vertical axis; Drift (lying default):
 *    yaw(t) = h + 26° sin(2πt/P), pitch(t) = pitch₀ + 3° sin(πt/P), P = 40 s / speed, h = the current heading;
 *  - pauses while dragging and 2.5 s after, and while the pointer rests on a point (Pause while pointing);
 *    resumes over 600 ms; unfocused leaves pause; the intro eases the motion in over 1.5 s;
 *  - orbit: yaw free, pitch ±75°; Keep upright (or a flat chart): yaw ±50°, pitch ±30° about the home view;
 *  - dolly toward the cursor, 0.15–4 × home distance; pan with right-drag or Shift + drag;
 *  - fly to a selection in 520 ms (0.5 × home distance, centred in the safe frame), back in 380 ms;
 *    re-fit 400 ms after a shape change (bounds + 8%);
 *  - the sheet docks with a tweened view offset (300 ms); the camera itself does not move;
 *  - a scope change turns the heading so the chosen territory faces the viewer (600 ms); no dolly, no swirl.
 * Reduced motion: every camera move cuts.
 * The image is shifted on screen with PerspectiveCamera.setViewOffset (a pure 2D translation of the projection),
 * so framing and docking never change what the camera looks at.
 */
import { PerspectiveCamera } from "three";
import type { Vec3 } from "../shared/protocol/worker";
import type { Pose } from "../shared/settings";
import type { Breakpoint, CameraPose } from "../state/types";
import { easeInOut, easeOut, type Easing } from "./animation";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { overlayRects, RENDER_TUNING } from "./tuning";

const T = RENDER_TUNING;
const DEG = Math.PI / 180;
/** A flat chart (the camera faces its plane) only breathes: the idle sway and drift run at this fraction, so its edges are never carried off the stage or seen from the side. */
export const FLAT_CHART_MOTION_SCALE = 0.2;

export const CAMERA_DEFAULTS = {
  fovDeg: T.camera.fovDeg,
  near: T.camera.near,
  far: T.camera.far,
  homeLying: T.poses.lying.home,
  homeStanding: T.poses.standing.home,
  /** Safe frame insets in CSS px for the lying fit, arrangements and fly-to (stage minus overlays). */
  safeFrame: { left: T.frame.lying.left, top: T.frame.lying.top, right: T.frame.lying.right, bottom: T.frame.lying.bottom },
  fitMargin: T.frame.lying.margin,
  minDistanceFactor: T.camera.minDistanceFactor,
  maxDistanceFactor: T.camera.maxDistanceFactor,
  pitchLimitDeg: T.camera.pitchLimitDeg,
  uprightYawDeg: T.camera.uprightYawDeg,
  uprightPitchDeg: T.camera.uprightPitchDeg,
  driftYawAmpDeg: T.motion.driftYawAmpDeg,
  driftPitchAmpDeg: T.motion.driftPitchAmpDeg,
  driftPeriodSec: T.motion.driftPeriodSec,
  spinPeriodSec: T.motion.spinPeriodSec,
  pauseAfterDragMs: T.motion.pauseAfterDragMs,
  pointerRestMs: T.motion.pointerRestMs,
  resumeMs: T.motion.resumeMs,
  flyInMs: T.fly.inMs,
  flyOutMs: T.fly.outMs,
  flyDistanceFactor: T.fly.distanceFactor,
  refitMs: T.fly.refitMs,
  dockShiftMs: T.fly.dockMs,
} as const;

/** Home yaw and pitch of a pose. */
export function homeAngles(pose: Pose): { yawDeg: number; pitchDeg: number } {
  return pose === "standing" ? T.poses.standing.home : T.poses.lying.home;
}

/**
 * Drift yaw/pitch (degrees) at time t (seconds) for a speed multiplier (×0.5 · ×1 · ×2), centred on a heading (the
 * lying home 11° by default; a scoped territory's heading after a scope turn, ORIG-16) and a base pitch.
 */
export function driftAngles(
  tSec: number,
  speed: number,
  headingDeg: number = T.poses.lying.home.yawDeg,
  pitchBaseDeg: number = T.poses.lying.home.pitchDeg,
): { yawDeg: number; pitchDeg: number } {
  const p = T.motion.driftPeriodSec / Math.max(0.01, speed);
  return {
    yawDeg: headingDeg + T.motion.driftYawAmpDeg * Math.sin((2 * Math.PI * tSec) / p),
    pitchDeg: pitchBaseDeg + T.motion.driftPitchAmpDeg * Math.sin((Math.PI * tSec) / p),
  };
}

/** Spin yaw (degrees) at time t for a speed multiplier: 360° per 60 s at ×1. */
export function spinYaw(tSec: number, speed: number, headingDeg = 0): number {
  return headingDeg + (360 * tSec * speed) / T.motion.spinPeriodSec;
}

/** Distance at which a sphere of `radius` fits the vertical FOV with `margin` (e.g. 0.08). */
export function fitDistance(radius: number, fovDeg: number, margin = 0.08): number {
  return (radius * (1 + margin)) / Math.sin((fovDeg * Math.PI) / 360);
}

/** Shortest signed angular difference b − a in degrees (−180, 180]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

// ───────────────────────────── inertia, dolly and flight maths (pure) ─────────────────────────────

/** One pointer move of an orbit drag: when it happened, the ms since the move before it, and the angle it turned. */
export interface OrbitSample {
  t: number;
  dt: number;
  dYaw: number;
  dPitch: number;
}

/** Orbit angular velocity in degrees per ms. */
export interface AngularVelocity {
  yaw: number;
  pitch: number;
}

/**
 * The velocity a released drag carries: the angle turned over the last `n` moves divided by the time they took
 * (capped). A release long after the last move (the pointer was held still) carries nothing.
 */
export function releaseVelocity(samples: readonly OrbitSample[], nowMs: number, n: number = T.camera.inertiaSamples): AngularVelocity {
  const last = samples[samples.length - 1];
  if (!last || nowMs - last.t > T.camera.inertiaIdleMs) return { yaw: 0, pitch: 0 };
  const use = samples.slice(-Math.max(1, n));
  let span = 0, yaw = 0, pitch = 0;
  for (const u of use) {
    span += Math.max(1, u.dt);
    yaw += u.dYaw;
    pitch += u.dPitch;
  }
  // A click's jitter (a pixel or two) is not a flick: it must not spin the figure.
  if (Math.hypot(yaw, pitch) < 3 * T.camera.orbitDegPerPx) return { yaw: 0, pitch: 0 };
  const cap = T.camera.inertiaMaxDegPerMs;
  const clamp = (v: number): number => Math.max(-cap, Math.min(cap, v));
  return { yaw: clamp(yaw / span), pitch: clamp(pitch / span) };
}

/** One frame of the coast: exponential decay with time constant `tauMs`; returns the angle to add and the velocity left. */
export function coastStep(v: AngularVelocity, dtMs: number, tauMs: number = T.camera.inertiaTauMs): { dYaw: number; dPitch: number; vel: AngularVelocity } {
  const k = Math.exp(-Math.max(0, dtMs) / Math.max(1, tauMs));
  const reach = Math.max(1, tauMs) * (1 - k);
  return { dYaw: v.yaw * reach, dPitch: v.pitch * reach, vel: { yaw: v.yaw * k, pitch: v.pitch * k } };
}

/** The coast has run out when it turns less than `stopRad` per 60 Hz frame. */
export function coastDone(v: AngularVelocity, stopRad: number = T.camera.inertiaStopRad): boolean {
  return Math.hypot(v.yaw, v.pitch) * (1000 / 60) * DEG < stopRad;
}

/** Camera distance of the opening dolly at progress t (0..1): `factor` × home at 0, home at 1, eased out. */
export function dollyDistance(homeDistance: number, t: number, factor: number = T.camera.introDollyFactor, ease: Easing = easeOut): number {
  return homeDistance * Math.pow(factor, 1 - ease(Math.max(0, Math.min(1, t))));
}

/**
 * The two-phase flight into a group arrangement: first back off (distance × 1.3) while the target drops 0.15
 * units, then ease to the new fit seen from slightly below (+12° of pitch). `split` is the share of the flight
 * the first phase takes.
 */
export function groupFlightPlan(from: Framing, fit: Framing): { via: Framing; to: Framing; split: number } {
  const via = cloneFraming(from);
  via.distance = from.distance * T.camera.groupFlightBackFactor;
  via.target = [from.target[0], from.target[1] - T.camera.groupFlightDrop, from.target[2]];
  const to = cloneFraming(fit);
  to.pitchDeg = fit.pitchDeg + T.camera.groupFlightPitchDeg;
  const total = T.camera.groupFlightBackMs + T.camera.groupFlightInMs;
  return { via, to, split: T.camera.groupFlightBackMs / total };
}

/** True when two fits frame the same thing (distance within 2%, target within 1% of the distance). */
export function sameFit(a: Framing, b: Framing): boolean {
  const d = Math.max(1e-6, a.distance);
  return Math.abs(b.distance / d - 1) < 0.02 && Math.hypot(a.target[0] - b.target[0], a.target[1] - b.target[1], a.target[2] - b.target[2]) < 0.01 * d;
}

// ───────────────────────────── basis and projection (pure) ─────────────────────────────

export interface CameraBasis {
  /** Unit vector from the target toward the camera. */
  c: Vec3;
  /** Screen right and screen up in world space. */
  r: Vec3;
  u: Vec3;
}

export function cameraBasis(yawDeg: number, pitchDeg: number): CameraBasis {
  const y = yawDeg * DEG;
  const p = pitchDeg * DEG;
  const c: Vec3 = [Math.cos(p) * Math.sin(y), -Math.sin(p), Math.cos(p) * Math.cos(y)];
  // right = normalize(worldUp × c); up = c × right
  let rx = c[2];
  let rz = -c[0];
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  const r: Vec3 = [rx, 0, rz];
  const u: Vec3 = [c[1] * r[2] - c[2] * r[1], c[2] * r[0] - c[0] * r[2], c[0] * r[1] - c[1] * r[0]];
  return { c, r, u };
}

/** The stage the camera frames: the canvas (CSS px) and the parts covered by a pushing sheet. */
export interface StageGeom {
  width: number;
  height: number;
  insetLeft: number;
  insetRight: number;
  breakpoint: Breakpoint;
  /** Immersive mode hides every overlay. */
  immersive?: boolean;
  /** Cortex Desktop's chrome: its own overlay rectangles (the standing fit does not shrink for the old key bar and command line). */
  desktop?: boolean;
}

/** A fitted framing: what the camera looks at, from how far, and the screen shift of the image (CSS px). */
export interface Framing {
  yawDeg: number;
  pitchDeg: number;
  distance: number;
  target: Vec3;
  shiftX: number;
  shiftY: number;
}

/** Points to frame, as xyz triplets; `data` marks samples that set the horizontal centre (not haze). */
export interface FitSamples {
  pos: Float32Array;
  count: number;
  data?: Uint8Array;
}

function freeStage(g: StageGeom): { x0: number; width: number } {
  const x0 = Math.max(0, g.insetLeft);
  return { x0, width: Math.max(1, g.width - x0 - Math.max(0, g.insetRight)) };
}

/** Axis-aligned centre of the samples. */
export function samplesCentre(s: FitSamples): Vec3 {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < s.count; i++) {
    const x = s.pos[i * 3] as number, y = s.pos[i * 3 + 1] as number, z = s.pos[i * 3 + 2] as number;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  if (!Number.isFinite(x0)) return [0, 0, 0];
  return [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
}

function percentile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i] as number;
}

interface Ratios {
  /** u/(D−w) and v/(D−w) per finite sample. */
  u: Float64Array;
  v: Float64Array;
  data: Uint8Array;
  n: number;
}

function ratios(s: FitSamples, target: Vec3, b: CameraBasis, d: number, out?: Ratios): Ratios {
  const cap = s.count;
  const r: Ratios = out && out.u.length >= cap ? out : { u: new Float64Array(cap), v: new Float64Array(cap), data: new Uint8Array(cap), n: 0 };
  let n = 0;
  for (let i = 0; i < s.count; i++) {
    const qx = (s.pos[i * 3] as number) - target[0];
    const qy = (s.pos[i * 3 + 1] as number) - target[1];
    const qz = (s.pos[i * 3 + 2] as number) - target[2];
    if (!Number.isFinite(qx) || !Number.isFinite(qy) || !Number.isFinite(qz)) continue;
    const w = qx * b.c[0] + qy * b.c[1] + qz * b.c[2];
    const depth = Math.max(1e-3, d - w);
    r.u[n] = (qx * b.r[0] + qy * b.r[1] + qz * b.r[2]) / depth;
    r.v[n] = (qx * b.u[0] + qy * b.u[1] + qz * b.u[2]) / depth;
    r.data[n] = s.data ? (s.data[i] as number) : 1;
    n++;
  }
  r.n = n;
  return r;
}

/** Nearest distance that keeps every sample in front of the near plane, and a generous upper bound. */
function distanceBounds(s: FitSamples, target: Vec3, b: CameraBasis): { lo: number; hi: number } {
  let maxW = 0;
  let maxR = 0;
  for (let i = 0; i < s.count; i++) {
    const qx = (s.pos[i * 3] as number) - target[0];
    const qy = (s.pos[i * 3 + 1] as number) - target[1];
    const qz = (s.pos[i * 3 + 2] as number) - target[2];
    if (!Number.isFinite(qx) || !Number.isFinite(qy) || !Number.isFinite(qz)) continue;
    const w = qx * b.c[0] + qy * b.c[1] + qz * b.c[2];
    if (w > maxW) maxW = w;
    const rr = Math.hypot(qx, qy, qz);
    if (rr > maxR) maxR = rr;
  }
  const radius = Math.max(maxR, 0.5);
  return { lo: maxW + T.camera.near * 2 + 0.05 * radius, hi: Math.max(maxW + 1, radius * 400) };
}

/** Binary search (log scale) for the distance at which `size(d)` equals `want`; size decreases with d. */
function solveDistance(lo: number, hi: number, want: number, size: (d: number) => number): number {
  let a = Math.log(lo);
  let z = Math.log(hi);
  if (size(lo) <= want) return lo;
  for (let i = 0; i < 60; i++) {
    const m = (a + z) / 2;
    if (size(Math.exp(m)) > want) a = m;
    else z = m;
  }
  return Math.exp((a + z) / 2);
}

function vExtent(r: Ratios): { lo: number; hi: number } {
  const v = new Float64Array(r.v.subarray(0, r.n)).sort();
  // Drop the most extreme 0.05% at the bottom (a stray undated point) but keep the crown exact.
  return { lo: percentile(v, 0.0005), hi: v.length > 0 ? (v[v.length - 1] as number) : 0 };
}

function uExtent(r: Ratios, q: number): { lo: number; hi: number } {
  let m = 0;
  for (let i = 0; i < r.n; i++) if (r.data[i]) m++;
  const pick = m >= 8;
  const u = new Float64Array(pick ? m : r.n);
  let j = 0;
  for (let i = 0; i < r.n; i++) if (!pick || r.data[i]) u[j++] = r.u[i] as number;
  u.sort();
  return { lo: percentile(u, q), hi: percentile(u, 1 - q) };
}

/** Projected silhouette in canvas CSS px for a framing (for overlay tests and the label layer). */
export function projectSamples(s: FitSamples, f: Framing, g: StageGeom, fovDeg: number = T.camera.fovDeg): { x: Float32Array; y: Float32Array; n: number } {
  const b = cameraBasis(f.yawDeg, f.pitchDeg);
  const r = ratios(s, f.target, b, f.distance);
  const tanV = Math.tan((fovDeg * DEG) / 2);
  const tanH = tanV * (g.width / Math.max(1, g.height));
  const x = new Float32Array(r.n);
  const y = new Float32Array(r.n);
  for (let i = 0; i < r.n; i++) {
    x[i] = (g.width / 2) * (1 + (r.u[i] as number) / tanH) + f.shiftX;
    y[i] = (g.height / 2) * (1 - (r.v[i] as number) / tanV) + f.shiftY;
  }
  return { x, y, n: r.n };
}

/** The first stage overlay (stage-local rect, shifted to canvas px) that a projected sample comes within `gap` px of. */
function conflictingOverlay(s: FitSamples, f: Framing, g: StageGeom, gap: number): { name: string; x0: number; x1: number } | null {
  if (g.immersive) return null;
  const fs = freeStage(g);
  const rects = overlayRects(g.breakpoint, fs.width, g.height, g.desktop === true);
  if (rects.length === 0) return null;
  const p = projectSamples(s, f, g);
  for (const rc of rects) {
    const x0 = fs.x0 + rc.x0 - gap, x1 = fs.x0 + rc.x1 + gap, y0 = rc.y0 - gap, y1 = rc.y1 + gap;
    for (let i = 0; i < p.n; i++) {
      const x = p.x[i] as number, y = p.y[i] as number;
      if (x > x0 && x < x1 && y > y0 && y < y1) return { name: rc.name, x0: fs.x0 + rc.x0, x1: fs.x0 + rc.x1 };
    }
  }
  return null;
}

/** True when any projected sample comes within `gap` px of a stage overlay (stage-local rects). */
export function overlayConflict(s: FitSamples, f: Framing, g: StageGeom, gap: number = T.frame.standing.overlayGapPx): string | null {
  return conflictingOverlay(s, f, g, gap)?.name ?? null;
}

/**
 * Standing home: fit by height. Crown at topFrac × H, the lowest point at H − bottomClearPx, horizontally centred
 * on the free stage. If the silhouette still comes within the gap of an overlay it first slides away from it along
 * x (6 px steps, up to 36 px), then shrinks about its centre in 2% steps until it clears (§3.2). The camera aims
 * at the cord's own x = 0 so the spin turns the figure about its vertical axis.
 */
export function fitStanding(s: FitSamples, g: StageGeom, angles: { yawDeg: number; pitchDeg: number } = T.poses.standing.home, fovDeg: number = T.camera.fovDeg): Framing {
  const F = T.frame.standing;
  const aim = T.poses.standing.aim;
  const target: Vec3 = [aim[0], aim[1], aim[2]];
  const b = cameraBasis(angles.yawDeg, angles.pitchDeg);
  const tanV = Math.tan((fovDeg * DEG) / 2);
  const tanH = tanV * (g.width / Math.max(1, g.height));
  const H = Math.max(1, g.height);
  const topY = F.topFrac * H;
  const botY = H - F.bottomClearPx;
  const wantFull = Math.max(H * 0.25, botY - topY);
  const fs = freeStage(g);
  const xc = fs.x0 + (F.centreLeftPx + fs.width - F.centreRightPx) / 2;
  const { lo, hi } = distanceBounds(s, target, b);
  const scratch = ratios(s, target, b, hi);
  const heightPx = (d: number): number => {
    const r = ratios(s, target, b, d, scratch);
    const e = vExtent(r);
    return ((e.hi - e.lo) * H) / (2 * tanV);
  };
  const centreY = (topY + Math.max(topY + 1, botY)) / 2;
  const build = (k: number, slidePx: number): Framing => {
    const want = wantFull * Math.pow(1 - F.shrinkStep, k);
    const d = solveDistance(lo, hi, want, heightPx);
    const r = ratios(s, target, b, d, scratch);
    const e = vExtent(r);
    const ue = uExtent(r, F.extentPercentile);
    const height = ((e.hi - e.lo) * H) / (2 * tanV);
    const top = k === 0 ? topY : centreY - height / 2;
    const shiftY = top - (H / 2) * (1 - e.hi / tanV);
    const shiftX = xc + slidePx - (g.width / 2) * (1 + (ue.lo + ue.hi) / 2 / tanH);
    return { yawDeg: angles.yawDeg, pitchDeg: angles.pitchDeg, distance: d, target, shiftX, shiftY };
  };
  let framing = build(0, 0);
  const hit = conflictingOverlay(s, framing, g, F.overlayGapPx);
  if (hit === null) return framing;
  const dir = xc >= (hit.x0 + hit.x1) / 2 ? 1 : -1;
  let slide = 0;
  for (let px = F.slideStepPx; px <= F.maxSlidePx; px += F.slideStepPx) {
    slide = dir * px;
    framing = build(0, slide);
    if (conflictingOverlay(s, framing, g, F.overlayGapPx) === null) return framing;
  }
  for (let k = 1; k <= F.maxShrinkSteps; k++) {
    framing = build(k, slide);
    if (conflictingOverlay(s, framing, g, F.overlayGapPx) === null) break;
  }
  return framing;
}

/** The safe rectangle (canvas CSS px) used by the lying fit, arrangements and fly-to. */
export function safeRect(g: StageGeom): { x0: number; y0: number; x1: number; y1: number } {
  const fs = freeStage(g);
  const L = T.frame.lying;
  if (g.immersive || g.breakpoint === "Mini") return { x0: fs.x0 + 8, y0: 8, x1: fs.x0 + fs.width - 8, y1: g.height - 8 };
  const x0 = fs.x0 + L.left;
  const x1 = Math.max(x0 + 1, fs.x0 + fs.width - L.right);
  const y0 = L.top;
  const y1 = Math.max(y0 + 1, g.height - L.bottom);
  return { x0, y0, x1, y1 };
}

/** Lying home: the projected bounds fill the safe frame with a margin; centred in it. */
export function fitRect(s: FitSamples, g: StageGeom, angles: { yawDeg: number; pitchDeg: number } = T.poses.lying.home, margin: number = T.frame.lying.margin, fovDeg: number = T.camera.fovDeg): Framing {
  const target = samplesCentre(s);
  const b = cameraBasis(angles.yawDeg, angles.pitchDeg);
  const tanV = Math.tan((fovDeg * DEG) / 2);
  const tanH = tanV * (g.width / Math.max(1, g.height));
  const rect = safeRect(g);
  const availW = Math.max(1, (rect.x1 - rect.x0) * (1 - 2 * margin));
  const availH = Math.max(1, (rect.y1 - rect.y0) * (1 - 2 * margin));
  const { lo, hi } = distanceBounds(s, target, b);
  const scratch = ratios(s, target, b, hi);
  const fill = (d: number): number => {
    const r = ratios(s, target, b, d, scratch);
    const ve = vExtent(r);
    const ue = uExtent(r, 0);
    const wPx = ((ue.hi - ue.lo) * g.width) / (2 * tanH);
    const hPx = ((ve.hi - ve.lo) * g.height) / (2 * tanV);
    return Math.max(wPx / availW, hPx / availH);
  };
  const d = solveDistance(lo, hi, 1, fill);
  const r = ratios(s, target, b, d, scratch);
  const ve = vExtent(r);
  const ue = uExtent(r, 0);
  const cx = (g.width / 2) * (1 + (ue.lo + ue.hi) / 2 / tanH);
  const cy = (g.height / 2) * (1 - (ve.lo + ve.hi) / 2 / tanV);
  return { yawDeg: angles.yawDeg, pitchDeg: angles.pitchDeg, distance: d, target, shiftX: (rect.x0 + rect.x1) / 2 - cx, shiftY: (rect.y0 + rect.y1) / 2 - cy };
}

/**
 * The camera angles an arrangement is fitted at. A flat chart (Keep upright, no tilt) or a tilted one (a perspective
 * grid) is a plane facing +Z, so its camera looks straight at it (yaw 0) whatever way the figure was turned; a volume
 * (spheres, clusters) keeps the heading the figure has, which spins freely.
 */
export function arrangementAngles(c: { keepUpright: boolean; tiltDeg: number }, headingDeg: number): { yawDeg: number; pitchDeg: number } {
  return { yawDeg: c.keepUpright ? 0 : headingDeg, pitchDeg: c.keepUpright && c.tiltDeg === 0 ? 0 : -c.tiltDeg };
}

/** Re-fit to a sphere (an arrangement's bounds) inside the safe frame, + margin. */
export function fitSphere(centre: Vec3, radius: number, g: StageGeom, angles: { yawDeg: number; pitchDeg: number }, margin: number = T.frame.refitMargin, fovDeg: number = T.camera.fovDeg): Framing {
  const rect = safeRect(g);
  const tanV = Math.tan((fovDeg * DEG) / 2);
  const rw = rect.x1 - rect.x0;
  const rh = rect.y1 - rect.y0;
  // The sphere must fit the rect: its angular radius against the rect's half-extent in each axis.
  const halfV = Math.atan(tanV * (rh / Math.max(1, g.height)));
  const halfH = Math.atan(tanV * (rw / Math.max(1, g.height)));
  const half = Math.max(1e-3, Math.min(halfV, halfH));
  const distance = (Math.max(1e-3, radius) * (1 + margin)) / Math.sin(half);
  return {
    yawDeg: angles.yawDeg,
    pitchDeg: angles.pitchDeg,
    distance,
    target: [centre[0], centre[1], centre[2]],
    shiftX: (rect.x0 + rect.x1) / 2 - g.width / 2,
    shiftY: (rect.y0 + rect.y1) / 2 - g.height / 2,
  };
}

/** A flat chart leaves this much more room at the bottom than the figure does: the colour key stands in the bottom-left corner. */
export const FLAT_CHART_BOTTOM_EXTRA_PX = 56;

/** The safe frame a flat chart is fitted into. */
export function flatChartRect(g: StageGeom): { x0: number; y0: number; x1: number; y1: number } {
  const r = safeRect(g);
  return { ...r, y1: Math.max(r.y0 + 1, r.y1 - FLAT_CHART_BOTTOM_EXTRA_PX) };
}

/**
 * Re-fit to a flat chart seen square on: the rectangle `half` (world half width and height) fills the safe frame, so a
 * wide chart uses the width a circle round it would waste. Same shifts as `fitSphere`.
 */
export function fitFrame(centre: Vec3, half: { w: number; h: number }, g: StageGeom, angles: { yawDeg: number; pitchDeg: number }, margin: number = T.frame.refitMargin, fovDeg: number = T.camera.fovDeg): Framing {
  const rect = flatChartRect(g);
  const tanV = Math.tan((fovDeg * DEG) / 2);
  const rw = Math.max(1, rect.x1 - rect.x0) * (1 - margin);
  const rh = Math.max(1, rect.y1 - rect.y0) * (1 - margin);
  const distance = (Math.max(half.w / rw, half.h / rh) * Math.max(1, g.height)) / tanV;
  return {
    yawDeg: angles.yawDeg,
    pitchDeg: angles.pitchDeg,
    distance,
    target: [centre[0], centre[1], centre[2]],
    shiftX: (rect.x0 + rect.x1) / 2 - g.width / 2,
    shiftY: (rect.y0 + rect.y1) / 2 - g.height / 2,
  };
}

/** A chart never gets less than this much width (CSS px) between the panels that float over the stage. */
export const CHART_MIN_FREE_PX = 280;

/**
 * The stage a chart is fitted into: the canvas minus the sheet inset and minus what the floating Chart card (left) and the
 * Display popover (right) cover of it, so the chart is scaled and centred in the free space between them. A pair of panels
 * that leave less than CHART_MIN_FREE_PX shrinks proportionally, so a narrow window still shows a chart.
 */
export function chartFitGeom(g: StageGeom, cover: { left: number; right: number } | null | undefined): StageGeom {
  if (!cover || (cover.left <= 0 && cover.right <= 0)) return g;
  const free = Math.max(1, g.width - Math.max(0, g.insetLeft) - Math.max(0, g.insetRight));
  let left = Math.max(0, cover.left), right = Math.max(0, cover.right);
  const room = Math.max(0, free - CHART_MIN_FREE_PX);
  const sum = left + right;
  if (sum > room) {
    const k = sum > 0 ? room / sum : 0;
    left *= k;
    right *= k;
  }
  return { ...g, insetLeft: g.insetLeft + Math.round(left), insetRight: g.insetRight + Math.round(right) };
}

/** The framing of an arrangement's camera: a flat chart square on fits its frame, anything else the sphere round it. */
export function fitArrangementCamera(c: { centre: Vec3; radius: number; tiltDeg: number; keepUpright: boolean; half?: { w: number; h: number } }, g: StageGeom, angles: { yawDeg: number; pitchDeg: number }): Framing {
  if (c.half && c.keepUpright && c.tiltDeg === 0) return fitFrame(c.centre, c.half, g, angles);
  return fitSphere(c.centre, c.radius, g, angles);
}

/**
 * Mini (CORTEX-UX §2.5): the brain only, fitted to its crown and cerebellum. The samples above `brainBaseY` (the
 * brainstem's top and everything over it) are wrapped in a sphere that fills the safe frame; the spin turns about it.
 */
export function fitBrain(s: FitSamples, g: StageGeom, angles: { yawDeg: number; pitchDeg: number } = T.poses.standing.home): Framing {
  const base = T.frame.mini.brainBaseY;
  const keep: number[] = [];
  for (let i = 0; i < s.count; i++) {
    const y = s.pos[i * 3 + 1] as number;
    if (Number.isFinite(y) && y >= base && Number.isFinite(s.pos[i * 3] as number) && Number.isFinite(s.pos[i * 3 + 2] as number)) keep.push(i);
  }
  if (keep.length < 8) return fitStanding(s, g, angles);
  const pos = new Float32Array(keep.length * 3);
  keep.forEach((i, j) => {
    pos[j * 3] = s.pos[i * 3] as number;
    pos[j * 3 + 1] = s.pos[i * 3 + 1] as number;
    pos[j * 3 + 2] = s.pos[i * 3 + 2] as number;
  });
  const centre = samplesCentre({ pos, count: keep.length });
  let r2 = 0;
  for (let j = 0; j < keep.length; j++) {
    const dx = (pos[j * 3] as number) - centre[0], dy = (pos[j * 3 + 1] as number) - centre[1], dz = (pos[j * 3 + 2] as number) - centre[2];
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  return fitSphere(centre, Math.sqrt(r2), g, angles, T.frame.mini.margin);
}

/** Fit the home view of a pose. */
export function fitHome(pose: Pose, s: FitSamples, g: StageGeom): Framing {
  if (pose === "standing" && g.breakpoint === "Mini") return fitBrain(s, g, T.poses.standing.home);
  return pose === "standing" ? fitStanding(s, g, T.poses.standing.home) : fitRect(s, g, T.poses.lying.home);
}

/**
 * Remembers the last home fit. The fit projects every sample (tens of ms on a busy stage) and depends only on the pose, the
 * samples and the stage, so a layout event that changes none of them (a panel moved, the Groups morph began) reuses it.
 */
export class HomeFitCache {
  private samples: FitSamples | null = null;
  private fits = new Map<string, Framing>();
  /** How many times the fit was actually computed (tests). */
  computed = 0;

  /** Keeps the last few stages (a panel that opens and closes toggles between two), for the current samples only. */
  get(pose: Pose, s: FitSamples, g: StageGeom, compute: (pose: Pose, s: FitSamples, g: StageGeom) => Framing = fitHome): Framing {
    if (this.samples !== s) {
      this.samples = s;
      this.fits.clear();
    }
    const key = `${pose}|${g.width}|${g.height}|${g.insetLeft}|${g.insetRight}|${g.breakpoint}|${g.immersive === true}|${g.desktop === true}`;
    const hit = this.fits.get(key);
    if (hit) return hit;
    const framing = compute(pose, s, g);
    this.computed++;
    if (this.fits.size >= 4) this.fits.delete(this.fits.keys().next().value as string);
    this.fits.set(key, framing);
    return framing;
  }
}

// ───────────────────────────── the turntable camera ─────────────────────────────

/** Motion modes, Spin first: the figure stands by default (CORTEX-UX §6.8). */
export type MotionMode = "spin" | "drift" | "off";

export interface CameraInsets {
  left: number;
  right: number;
}

interface PoseTween {
  from: Framing;
  to: Framing;
  startMs: number;
  durationMs: number;
  ease: Easing;
  /** A two-phase flight: from → via over the first `split` of the time, via → to over the rest. */
  via?: Framing;
  split?: number;
  /** The opening dolly (a new home retargets it instead of cutting it short). */
  dolly?: boolean;
}

/**
 * One leg of a scripted camera move (Showcase mode's dolly, orbit, comet tilt and fly-through). Every field but `ms`
 * is optional and falls back to the home view: `yawDeg` and `pitchDeg` are turns away from the home heading and pitch,
 * `distanceFactor` is a multiple of the home distance, `target` the point looked at, `rollDeg`
 * the turn of the picture about the line of sight (the comet tilt).
 */
export interface CameraLeg {
  yawDeg?: number;
  pitchDeg?: number;
  distanceFactor?: number;
  target?: Vec3;
  rollDeg?: number;
  ms: number;
  ease?: "inout" | "out" | "linear";
}

const LEG_EASE: Readonly<Record<NonNullable<CameraLeg["ease"]>, Easing>> = { inout: easeInOut, out: easeOut, linear: (t) => t };

/** The framings a tween passes through, so a mode change or a shift can move all of them together. */
const tweenEnds = (tw: PoseTween): Framing[] => (tw.via ? [tw.from, tw.via, tw.to] : [tw.from, tw.to]);

const cloneFraming = (f: Framing): Framing => ({ ...f, target: [f.target[0], f.target[1], f.target[2]] });

function lerpFraming(a: Framing, b: Framing, t: number): Framing {
  return {
    yawDeg: a.yawDeg + angleDelta(a.yawDeg, b.yawDeg) * t,
    pitchDeg: a.pitchDeg + (b.pitchDeg - a.pitchDeg) * t,
    distance: a.distance * Math.pow(b.distance / Math.max(1e-6, a.distance), t),
    target: [a.target[0] + (b.target[0] - a.target[0]) * t, a.target[1] + (b.target[1] - a.target[1]) * t, a.target[2] + (b.target[2] - a.target[2]) * t],
    shiftX: a.shiftX + (b.shiftX - a.shiftX) * t,
    shiftY: a.shiftY + (b.shiftY - a.shiftY) * t,
  };
}

/**
 * Orbit camera around a target with drift / spin motion, gestures, flights and docking. Pure state + a three
 * PerspectiveCamera it keeps in sync (`apply`). Times are in ms from the renderer's clock.
 */
export class TurntableCamera {
  readonly camera: PerspectiveCamera;
  /** The user's framing (heading, pitch, distance, target, screen shift); motion adds to yaw/pitch. */
  private base: Framing;
  private homeFrame: Framing;
  private tween: PoseTween | null = null;
  private dockTween: { from: number; to: number; startMs: number } | null = null;
  private beforeFly: Framing | null = null;
  private width = 1;
  private height = 1;
  private geom: StageGeom = { width: 1, height: 1, insetLeft: 0, insetRight: 0, breakpoint: "XL" };

  private mode: MotionMode;
  private speed = 1;
  private phase = 0;
  private yawOff = 0;
  private pitchOff = 0;
  private resume = 1;
  private dragUntilMs = 0;
  private dragging: { kind: "orbit" | "pan"; x: number; y: number; t: number } | null = null;
  private orbitSamples: OrbitSample[] = [];
  /** The released drag's angular velocity while it coasts to a stop (null = not coasting). */
  private coast: AngularVelocity | null = null;
  /** The last group-change fit flown to; the same fit again only re-frames, it does not fly again. */
  private lastFlightFit: Framing | null = null;
  private resting = false;
  private suspended = false;
  private motionScale = 1;
  private userUpright = false;
  private forcedUpright = false;
  /** The view a flat chart is upright about (it faces the camera: yaw 0); null = the figure's home view. */
  private uprightAbout: { yawDeg: number; pitchDeg: number } | null = null;
  private atHome = true;
  /** Scripted legs still to fly after the one in progress (cancelled by any gesture, a reset or a restore). */
  private legs: CameraLeg[] = [];
  /** The picture's turn about the line of sight, tweened on its own (0 = upright). */
  private roll: { from: number; to: number; startMs: number; durationMs: number } = { from: 0, to: 0, startMs: 0, durationMs: 0 };
  reduced = false;

  /** `pose` is the leaf's pose (view state, seeded from settings `general.pose`): the first frame is already that
   *  pose's home view, so a standing leaf never snaps from the lying one. */
  constructor(aspect = 1, pose: Pose = DEFAULT_SETTINGS.general.pose) {
    this.camera = new PerspectiveCamera(T.camera.fovDeg, aspect, T.camera.near, T.camera.far);
    this.camera.up.set(0, 1, 0);
    const h = homeAngles(pose);
    const aim = pose === "standing" ? T.poses.standing.aim : ([0, 0, 0] as const);
    this.base = { yawDeg: h.yawDeg, pitchDeg: h.pitchDeg, distance: 25, target: [aim[0], aim[1], aim[2]], shiftX: 0, shiftY: 0 };
    this.homeFrame = cloneFraming(this.base);
    this.mode = T.poses[pose].defaultMotion;
  }

  /** Current framing including motion offsets (what the camera shows now). */
  framing(nowMs: number): Framing {
    const f = this.tween ? this.tweened(nowMs) : this.base;
    const out = cloneFraming(f);
    out.yawDeg += this.yawOff;
    out.pitchDeg += this.pitchOff;
    if (this.dockTween) out.shiftX += this.dockOffset(nowMs);
    this.clampUpright(out);
    return out;
  }

  home(): Framing {
    return cloneFraming(this.homeFrame);
  }

  /** A flat chart took the camera: it is no longer at the figure's home view, so a resize or a new home fit must not carry it back there. */
  leaveHome(): void {
    this.atHome = false;
  }

  /** True while the user has not moved the camera since the last home fit. */
  isAtHome(): boolean {
    return this.atHome;
  }

  /** Whether frames are needed for motion or tweens. */
  animating(nowMs: number): boolean {
    if (this.tween && nowMs < this.tween.startMs + this.tween.durationMs) return true;
    if (this.dockTween && nowMs < this.dockTween.startMs + T.fly.dockMs) return true;
    if (this.legs.length > 0 || nowMs < this.roll.startMs + this.roll.durationMs) return true;
    if (this.dragging || this.coast) return true;
    return this.mode !== "off" && !this.suspended && !this.reduced;
  }

  setStage(g: StageGeom): void {
    this.geom = { ...g };
    this.width = Math.max(1, g.width);
    this.height = Math.max(1, g.height);
    this.camera.aspect = this.width / this.height;
  }

  stage(): StageGeom {
    return { ...this.geom };
  }

  /** Set the fitted home framing; `jump` moves there now (first fit), otherwise the caller decides. */
  setHome(f: Framing, nowMs: number, ms = 0): void {
    this.homeFrame = cloneFraming(f);
    if (!this.atHome) return;
    const tw = this.tween;
    if (tw && tw.dolly && ms === 0 && nowMs < tw.startMs + tw.durationMs) {
      // A new home while the opening dolly runs (the stage resized, more notes arrived): the dolly lands on it.
      tw.to = cloneFraming(f);
      tw.from = { ...cloneFraming(f), distance: f.distance * T.camera.introDollyFactor };
      return;
    }
    this.goTo(f, nowMs, ms);
  }

  /**
   * Opening dolly: from `introDollyFactor` × the home distance, pull back to home (450 ms, ease-out). Cut under
   * reduced motion. The caller says when (first fit, a return from a scope).
   */
  dollyIn(nowMs: number, ms: number = T.camera.introDollyMs, factor: number = T.camera.introDollyFactor): void {
    this.dollyTo(this.homeFrame, nowMs, ms, factor);
  }

  private dollyTo(to: Framing, nowMs: number, ms: number, factor: number = T.camera.introDollyFactor): void {
    if (this.reduced || ms <= 0 || !(factor < 1)) return;
    this.endCoast(nowMs);
    this.beforeFly = null;
    const end = cloneFraming(to);
    const from = cloneFraming(to);
    from.distance = to.distance * factor;
    this.base = cloneFraming(from);
    this.tween = { from, to: end, startMs: nowMs, durationMs: ms, ease: easeOut, dolly: true };
  }

  /**
   * Group-change flight (see `groupFlightPlan`). Returns false when the flight is off or motion is reduced: the
   * caller then re-fits plainly. The same fit again (the data refreshed, nothing else changed) only re-frames.
   */
  groupFlight(fit: Framing, nowMs: number): boolean {
    if (!T.camera.groupFlight || this.reduced) return false;
    const from = this.tween ? this.tweened(nowMs) : cloneFraming(this.base);
    const plan = groupFlightPlan(from, fit);
    const again = this.lastFlightFit !== null && sameFit(this.lastFlightFit, fit);
    this.lastFlightFit = cloneFraming(fit);
    this.beforeFly = null;
    if (again) {
      this.goTo(plan.to, nowMs, T.fly.refitMs);
      return true;
    }
    this.endCoast(nowMs);
    this.tween = { from, to: plan.to, via: plan.via, split: plan.split, startMs: nowMs, durationMs: T.camera.groupFlightBackMs + T.camera.groupFlightInMs, ease: easeInOut };
    return true;
  }

  /** Forget the last group fit (the figure left the Groups shape), so the next arrival flies again. */
  forgetGroupFlight(): void {
    this.lastFlightFit = null;
  }

  setMotion(mode: MotionMode, speed: number): void {
    if (mode !== this.mode) {
      // Fold the current offset into the heading so changing mode never jumps; the new motion starts there.
      this.base.yawDeg += this.yawOff;
      this.base.pitchDeg += this.pitchOff;
      if (this.tween) {
        for (const e of tweenEnds(this.tween)) {
          e.yawDeg += this.yawOff;
          e.pitchDeg += this.pitchOff;
        }
      }
      this.yawOff = 0;
      this.pitchOff = 0;
      this.phase = 0;
      this.mode = mode;
    }
    // 0 = still: the phase stops advancing (Display's Speed slider runs 0–200%).
    this.speed = Number.isFinite(speed) ? Math.max(0, speed) : 1;
  }

  motion(): { mode: MotionMode; speed: number } {
    return { mode: this.mode, speed: this.speed };
  }

  setKeepUpright(on: boolean): void {
    this.userUpright = on;
  }

  /**
   * Flat charts keep the camera upright by themselves, about the view that faces the chart (`about`), not about the
   * figure's home view: that one looks at the figure from behind, which would show a chart plane from its back.
   */
  setForcedUpright(on: boolean, about: { yawDeg: number; pitchDeg: number } | null = null): void {
    this.forcedUpright = on;
    this.uprightAbout = on ? about : null;
  }

  isForcedUpright(): boolean {
    return this.forcedUpright;
  }

  /** The view Keep upright holds the camera about: the chart's facing view while a flat chart is up, else the home view. */
  private uprightCentre(): { yawDeg: number; pitchDeg: number } {
    return this.forcedUpright && this.uprightAbout ? this.uprightAbout : this.homeFrame;
  }

  /** 1 for the figure; FLAT_CHART_MOTION_SCALE while the camera faces a flat chart. */
  private idleScale(): number {
    return this.forcedUpright && this.uprightAbout ? FLAT_CHART_MOTION_SCALE : 1;
  }

  private upright(): boolean {
    return this.userUpright || this.forcedUpright;
  }

  /** Pointer resting on a point (Pause while pointing). */
  setResting(on: boolean): void {
    this.resting = on;
  }

  /** Unfocused or hidden leaves pause their motion. */
  setSuspended(on: boolean): void {
    this.suspended = on;
  }

  /** 0..1 multiplier on the motion rate (the intro eases the drift in). */
  setMotionScale(s: number): void {
    this.motionScale = Math.max(0, Math.min(1, s));
  }

  /** Advance motion and tweens; apply to the three camera. */
  update(nowMs: number, dtSec: number): void {
    const dt = Math.max(0, Math.min(T.motion.maxFrameDeltaMs / 1000, dtSec));
    if (this.coast) this.stepCoast(nowMs, dt * 1000);
    const paused = this.dragging !== null || nowMs < this.dragUntilMs || this.resting || this.suspended;
    if (paused) this.resume = 0;
    else this.resume = Math.min(1, this.resume + (dt * 1000) / T.motion.resumeMs);
    const rate = this.reduced ? 0 : easeInOut(this.resume) * this.motionScale;
    if (this.mode !== "off" && rate > 0) this.phase += dt * rate * this.speed;
    const spin = this.mode === "spin" && !this.upright();
    if (this.mode === "off" || this.reduced) {
      // Keep whatever offset motion left (folded on the next mode change).
    } else if (spin) {
      this.yawOff = (360 * this.phase) / T.motion.spinPeriodSec;
      this.pitchOff = 0;
      if (this.yawOff > 360 || this.yawOff < -360) {
        // Keep the numbers small: fold whole turns into the heading.
        const turns = Math.trunc(this.yawOff / 360) * 360;
        this.base.yawDeg += turns;
        if (this.tween) for (const e of tweenEnds(this.tween)) e.yawDeg += turns;
        this.phase -= (turns * T.motion.spinPeriodSec) / 360;
        this.yawOff -= turns;
      }
    } else if (this.mode === "spin") {
      // Keep upright: the spin becomes a sway, yaw = h ± 26° over 40 s, pitch 0 (§6.8).
      this.yawOff = this.idleScale() * T.motion.swayYawAmpDeg * Math.sin((2 * Math.PI * this.phase) / T.motion.swayPeriodSec);
      this.pitchOff = 0;
    } else {
      const P = T.motion.driftPeriodSec;
      this.yawOff = this.idleScale() * T.motion.driftYawAmpDeg * Math.sin((2 * Math.PI * this.phase) / P);
      this.pitchOff = this.idleScale() * T.motion.driftPitchAmpDeg * Math.sin((Math.PI * this.phase) / P);
    }
    if (this.tween && nowMs >= this.tween.startMs + this.tween.durationMs) {
      const endMs = this.tween.startMs + this.tween.durationMs;
      this.base = cloneFraming(this.tween.to);
      this.tween = null;
      // A scripted move goes on from where the last leg ended (no pause, so a fly-through reads as one flight).
      const next = this.legs.shift();
      if (next) this.startLeg(next, Math.min(nowMs, endMs));
    }
    if (this.dockTween && nowMs >= this.dockTween.startMs + T.fly.dockMs) {
      this.base.shiftX += this.dockTween.to;
      this.dockTween = null;
    }
    this.apply(nowMs);
  }

  /** Write the current framing into the three camera (position, orientation, projection with view offset). */
  apply(nowMs: number): void {
    const f = this.framing(nowMs);
    const b = cameraBasis(f.yawDeg, f.pitchDeg);
    const cam = this.camera;
    const roll = this.rollNow(nowMs) * DEG;
    if (roll !== 0) {
      // The picture turned about the line of sight: the up vector leans toward screen-right.
      const cs = Math.cos(roll);
      const sn = Math.sin(roll);
      cam.up.set(b.u[0] * cs + b.r[0] * sn, b.u[1] * cs + b.r[1] * sn, b.u[2] * cs + b.r[2] * sn);
    } else cam.up.set(0, 1, 0);
    cam.position.set(f.target[0] + b.c[0] * f.distance, f.target[1] + b.c[1] * f.distance, f.target[2] + b.c[2] * f.distance);
    cam.lookAt(f.target[0], f.target[1], f.target[2]);
    cam.aspect = this.width / this.height;
    cam.near = Math.max(T.camera.near, f.distance * 0.002);
    cam.far = Math.max(T.camera.far, f.distance * 4);
    cam.setViewOffset(this.width, this.height, -f.shiftX, -f.shiftY, this.width, this.height);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }

  private tweened(nowMs: number): Framing {
    const tw = this.tween as PoseTween;
    const t = tw.durationMs <= 0 ? 1 : Math.max(0, Math.min(1, (nowMs - tw.startMs) / tw.durationMs));
    if (tw.via && tw.split !== undefined && tw.split > 0 && tw.split < 1) {
      const sp = tw.split;
      return t < sp ? lerpFraming(tw.from, tw.via, easeInOut(t / sp)) : lerpFraming(tw.via, tw.to, tw.ease((t - sp) / (1 - sp)));
    }
    return lerpFraming(tw.from, tw.to, tw.ease(t));
  }

  /** Advance the post-release coast by one frame; it respects the pitch clamp and ends below the stop speed. */
  private stepCoast(nowMs: number, dtMs: number): void {
    const v = this.coast;
    if (!v) return;
    if (this.reduced || this.dragging) {
      this.endCoast(nowMs);
      return;
    }
    const s = coastStep(v, dtMs);
    const y0 = this.base.yawDeg;
    const p0 = this.base.pitchDeg;
    this.orbitBy(s.dYaw, s.dPitch);
    // A clamp (pitch limit, Keep upright) swallowed part of the turn: that axis stops.
    const vel = { yaw: s.vel.yaw, pitch: s.vel.pitch };
    if (Math.abs(this.base.pitchDeg - p0 - s.dPitch) > 1e-6) vel.pitch = 0;
    if (Math.abs(this.base.yawDeg - y0 - s.dYaw) > 1e-6) vel.yaw = 0;
    if (coastDone(vel)) this.endCoast(nowMs);
    else this.coast = vel;
  }

  /** End the coast; the auto-motion pause (then its 600 ms resume) starts from here. */
  private endCoast(nowMs: number): void {
    if (!this.coast) return;
    this.coast = null;
    this.dragUntilMs = nowMs + T.motion.pauseAfterDragMs;
  }

  private dockOffset(nowMs: number): number {
    const d = this.dockTween;
    if (!d) return 0;
    const t = Math.max(0, Math.min(1, (nowMs - d.startMs) / T.fly.dockMs));
    return d.from + (d.to - d.from) * easeInOut(t);
  }

  private settle(nowMs: number): void {
    if (this.tween) {
      this.base = this.tweened(nowMs);
      this.tween = null;
    }
  }

  private clampUpright(f: Framing): void {
    if (this.upright()) {
      const h = this.uprightCentre();
      const dy = angleDelta(h.yawDeg, f.yawDeg);
      f.yawDeg = h.yawDeg + Math.max(-T.camera.uprightYawDeg, Math.min(T.camera.uprightYawDeg, dy));
      f.pitchDeg = Math.max(h.pitchDeg - T.camera.uprightPitchDeg, Math.min(h.pitchDeg + T.camera.uprightPitchDeg, f.pitchDeg));
    } else {
      f.pitchDeg = Math.max(-T.camera.pitchLimitDeg, Math.min(T.camera.pitchLimitDeg, f.pitchDeg));
    }
  }

  /** The roll now, in degrees. */
  private rollNow(nowMs: number): number {
    const r = this.roll;
    if (r.durationMs <= 0 || nowMs >= r.startMs + r.durationMs) return r.to;
    return r.from + (r.to - r.from) * easeInOut(Math.max(0, (nowMs - r.startMs) / r.durationMs));
  }

  private startLeg(leg: CameraLeg, nowMs: number): void {
    const now = this.tween ? this.tweened(nowMs) : cloneFraming(this.base);
    const h = this.homeFrame;
    const to: Framing = {
      yawDeg: h.yawDeg + (leg.yawDeg ?? 0),
      pitchDeg: h.pitchDeg + (leg.pitchDeg ?? 0),
      distance: h.distance * (leg.distanceFactor ?? 1),
      target: leg.target ? [leg.target[0], leg.target[1], leg.target[2]] : [h.target[0], h.target[1], h.target[2]],
      shiftX: h.shiftX,
      shiftY: h.shiftY,
    };
    // The turn goes the short way round.
    to.yawDeg = now.yawDeg + angleDelta(now.yawDeg, to.yawDeg);
    this.atHome = false;
    // A leg of 0 ms still takes a tick, so the next leg starts from the frame loop.
    this.goTo(to, nowMs, Math.max(1, leg.ms), LEG_EASE[leg.ease ?? "inout"]);
    const rollTo = leg.rollDeg ?? 0;
    this.roll = { from: this.rollNow(nowMs), to: rollTo, startMs: nowMs, durationMs: this.reduced ? 0 : leg.ms };
  }

  /**
   * Fly a scripted path, one leg after another (a leg runs from where the last ended). Replaces any path in progress.
   * Cut to the last leg under reduced motion.
   */
  flyLegs(legs: readonly CameraLeg[], nowMs: number): void {
    this.legs = [];
    if (legs.length === 0) return;
    this.beforeFly = null;
    if (this.reduced) {
      this.startLeg({ ...(legs[legs.length - 1] as CameraLeg), ms: 0 }, nowMs);
      return;
    }
    this.startLeg(legs[0] as CameraLeg, nowMs);
    this.legs = legs.slice(1).map((l) => ({ ...l }));
  }

  /** Drop the rest of a scripted path and turn the picture upright (`ms` 0 cuts); the camera stays where it is. */
  cancelLegs(nowMs: number, ms = 0): void {
    this.legs = [];
    this.roll = { from: this.rollNow(nowMs), to: 0, startMs: nowMs, durationMs: this.reduced ? 0 : ms };
  }

  /** Is a scripted path (or its roll) still moving? */
  flyingLegs(nowMs: number): boolean {
    return this.legs.length > 0 || nowMs < this.roll.startMs + this.roll.durationMs;
  }

  /** Move to a framing over `ms` (cut under reduced motion). The motion offset is kept. */
  goTo(to: Framing, nowMs: number, ms: number, ease: Easing = easeInOut): void {
    this.endCoast(nowMs);
    const from = this.tween ? this.tweened(nowMs) : cloneFraming(this.base);
    const dur = this.reduced ? 0 : Math.max(0, ms);
    if (dur === 0) {
      this.base = cloneFraming(to);
      this.tween = null;
      return;
    }
    // Arrive with the same motion offset the camera has now: the tween moves the base, the offset rides on top.
    this.tween = { from, to: cloneFraming(to), startMs: nowMs, durationMs: dur, ease };
  }

  // ───── gestures ─────

  pointerDown(x: number, y: number, button: number, shift: boolean, nowMs: number): void {
    this.settle(nowMs);
    this.cancelLegs(nowMs, 200);
    // A new press stops a coast in its tracks; this drag's own release re-arms the pause.
    this.coast = null;
    this.orbitSamples = [];
    this.dragging = { kind: button === 2 || button === 1 || shift ? "pan" : "orbit", x, y, t: nowMs };
  }

  pointerMove(x: number, y: number, nowMs: number): void {
    const d = this.dragging;
    if (!d) return;
    const dx = x - d.x;
    const dy = y - d.y;
    d.x = x;
    d.y = y;
    if (dx === 0 && dy === 0) return;
    this.settle(nowMs);
    this.atHome = false;
    this.beforeFly = null;
    if (d.kind === "orbit") {
      const dYaw = -dx * T.camera.orbitDegPerPx;
      const dPitch = -dy * T.camera.orbitDegPerPx;
      this.orbitBy(dYaw, dPitch);
      this.orbitSamples.push({ t: nowMs, dt: nowMs - d.t, dYaw, dPitch });
      if (this.orbitSamples.length > 8) this.orbitSamples.shift();
    } else this.panBy(dx, dy, nowMs);
    d.t = nowMs;
  }

  pointerUp(nowMs: number): void {
    const d = this.dragging;
    this.dragging = null;
    if (!d) return;
    // A released orbit keeps turning (exponential decay); the auto-motion pause starts when it stops.
    if (d.kind === "orbit" && !this.reduced) {
      const v = releaseVelocity(this.orbitSamples, nowMs);
      if (!coastDone(v)) {
        this.coast = v;
        this.dragUntilMs = Infinity;
        this.orbitSamples = [];
        return;
      }
    }
    this.orbitSamples = [];
    this.dragUntilMs = nowMs + T.motion.pauseAfterDragMs;
  }

  isDragging(): boolean {
    return this.dragging !== null;
  }

  /** Orbit by degrees (keys and drags), clamped (Keep upright about the home view; else pitch ±75°). */
  orbitBy(dYawDeg: number, dPitchDeg: number): void {
    this.atHome = false;
    this.base.yawDeg += dYawDeg;
    this.base.pitchDeg += dPitchDeg;
    if (this.upright()) {
      const h = this.uprightCentre();
      const lim = T.camera.uprightYawDeg;
      const dy = angleDelta(h.yawDeg, this.base.yawDeg + this.yawOff);
      if (dy > lim) this.base.yawDeg -= dy - lim;
      if (dy < -lim) this.base.yawDeg -= dy + lim;
      const pl = T.camera.uprightPitchDeg;
      this.base.pitchDeg = Math.max(h.pitchDeg - pl - this.pitchOff, Math.min(h.pitchDeg + pl - this.pitchOff, this.base.pitchDeg));
    } else {
      const pl = T.camera.pitchLimitDeg;
      this.base.pitchDeg = Math.max(-pl - this.pitchOff, Math.min(pl - this.pitchOff, this.base.pitchDeg));
    }
  }

  /** Pan the target in the screen plane by CSS px (grab: the content follows the pointer). */
  panBy(dxPx: number, dyPx: number, nowMs: number): void {
    this.settle(nowMs);
    this.atHome = false;
    const f = this.framing(nowMs);
    const b = cameraBasis(f.yawDeg, f.pitchDeg);
    const wpp = (2 * f.distance * Math.tan((T.camera.fovDeg * DEG) / 2)) / this.height;
    const t = this.base.target;
    for (let k = 0; k < 3; k++) t[k] = (t[k] as number) - (b.r[k] as number) * dxPx * wpp + (b.u[k] as number) * dyPx * wpp;
  }

  /** Dolly toward the cursor (CSS px on the canvas); distance stays within 0.15–4 × the home distance. */
  wheel(deltaY: number, x: number, y: number, fine: boolean, nowMs: number): void {
    const k = Math.exp(deltaY * T.camera.wheelZoomPerPx * (fine ? T.camera.fineWheelFactor : 1));
    this.zoomAt(k, x, y, nowMs);
  }

  /** Multiply the distance by k about a screen point (keys and pinch use the free stage centre). */
  zoomAt(k: number, x: number, y: number, nowMs: number): void {
    this.settle(nowMs);
    this.atHome = false;
    const f = this.framing(nowMs);
    const homeD = this.homeFrame.distance;
    const nd = Math.max(homeD * T.camera.minDistanceFactor, Math.min(homeD * T.camera.maxDistanceFactor, f.distance * k));
    const ratio = nd / f.distance;
    if (Math.abs(ratio - 1) < 1e-9) return;
    // World point under the cursor on the plane through the target facing the camera.
    const b = cameraBasis(f.yawDeg, f.pitchDeg);
    const tanV = Math.tan((T.camera.fovDeg * DEG) / 2);
    const tanH = tanV * (this.width / this.height);
    const ndcX = (x - f.shiftX - this.width / 2) / (this.width / 2);
    const ndcY = -(y - f.shiftY - this.height / 2) / (this.height / 2);
    const px = ndcX * tanH * f.distance;
    const py = ndcY * tanV * f.distance;
    const t = this.base.target;
    for (let i = 0; i < 3; i++) {
      const p = (t[i] as number) + (b.r[i] as number) * px + (b.u[i] as number) * py;
      t[i] = p + ((t[i] as number) - p) * ratio;
    }
    this.base.distance = nd;
  }

  /** Fly to a point: centred in the safe frame at 0.5 × the home distance, 520 ms. */
  flyTo(point: Vec3, nowMs: number, opts: { distanceFactor?: number; ms?: number } = {}): void {
    const now = this.tween ? this.tweened(nowMs) : cloneFraming(this.base);
    if (!this.beforeFly) this.beforeFly = cloneFraming(now);
    const rect = safeRect(this.geom);
    const to: Framing = {
      yawDeg: now.yawDeg,
      pitchDeg: now.pitchDeg,
      distance: this.homeFrame.distance * (opts.distanceFactor ?? T.fly.distanceFactor),
      target: [point[0], point[1], point[2]],
      shiftX: (rect.x0 + rect.x1) / 2 - this.width / 2,
      shiftY: (rect.y0 + rect.y1) / 2 - this.height / 2,
    };
    this.atHome = false;
    this.goTo(to, nowMs, opts.ms ?? T.fly.inMs);
  }

  /** Fly back to where the camera was before the last fly-to (380 ms); false when there is nothing to return to. */
  flyBack(nowMs: number): boolean {
    const back = this.beforeFly;
    if (!back) return false;
    this.beforeFly = null;
    this.goTo(back, nowMs, T.fly.outMs);
    return true;
  }

  hasFlown(): boolean {
    return this.beforeFly !== null;
  }

  /** Home view (H, double-click empty stage, Reset display). */
  reset(nowMs: number, ms: number = T.fly.inMs): void {
    this.cancelLegs(nowMs, ms);
    this.beforeFly = null;
    this.atHome = true;
    this.goTo(this.homeFrame, nowMs, ms);
  }

  /** Re-fit to a framing (shape change, arrangement camera), 400 ms. */
  fit(to: Framing, nowMs: number, ms: number = T.fly.refitMs): void {
    this.cancelLegs(nowMs, ms);
    this.beforeFly = null;
    this.lastFlightFit = null;
    this.goTo(to, nowMs, ms);
  }

  /**
   * Scope turn: rotate so `headingDeg` faces the viewer (shortest way), 600 ms. Drift continues around the new
   * heading; a spinning figure keeps spinning from there.
   */
  turnTo(headingDeg: number, nowMs: number, ms: number = RENDER_TUNING.scope.turnMs): void {
    const now = this.tween ? this.tweened(nowMs) : cloneFraming(this.base);
    const from = this.mode === "spin" ? now.yawDeg + this.yawOff : now.yawDeg;
    const to = cloneFraming(now);
    to.yawDeg = now.yawDeg + angleDelta(from, headingDeg);
    this.goTo(to, nowMs, ms);
  }

  /** Shift the layout-dependent part of the framing (the screen shift) without moving the image yet. */
  setShiftX(shiftX: number): void {
    const delta = shiftX - (this.tween ? this.tween.to.shiftX : this.base.shiftX);
    if (this.tween) for (const e of tweenEnds(this.tween)) e.shiftX += delta;
    this.base.shiftX += delta;
  }

  /**
   * Sheet docking and resizes: after the layout changed (setStage, a new home, a new shift), keep the image where
   * `before` showed it on a canvas `oldWidth` wide, then slide to the new framing over 300 ms. The camera itself
   * does not move (CORTEX-UX §3.4).
   */
  dockFrom(before: Framing, oldWidth: number, nowMs: number): void {
    const keep = oldWidth / 2 + before.shiftX - this.width / 2;
    const noDock = this.tween ? this.tweened(nowMs).shiftX : this.base.shiftX;
    const fromDelta = keep - noDock;
    if (this.reduced || Math.abs(fromDelta) < 0.5) {
      this.dockTween = null;
      return;
    }
    this.dockTween = { from: fromDelta, to: 0, startMs: nowMs };
  }

  /** Persisted pose (state/types CameraPose): distance as a multiple of the home distance. */
  pose(nowMs: number): CameraPose {
    const f = this.framing(nowMs);
    return { yawDeg: f.yawDeg, pitchDeg: f.pitchDeg, distance: f.distance / Math.max(1e-6, this.homeFrame.distance), target: [f.target[0], f.target[1], f.target[2]] };
  }

  /** Restore a persisted pose against the current home framing. */
  restorePose(p: CameraPose, nowMs: number, opts: { dolly?: boolean } = {}): void {
    if (![p.yawDeg, p.pitchDeg, p.distance, ...p.target].every((x) => typeof x === "number" && Number.isFinite(x))) return;
    this.cancelLegs(nowMs, 0);
    const d = Math.max(T.camera.minDistanceFactor, Math.min(T.camera.maxDistanceFactor, p.distance)) * this.homeFrame.distance;
    this.yawOff = 0;
    this.pitchOff = 0;
    this.phase = 0;
    this.atHome = false;
    this.goTo({ yawDeg: p.yawDeg, pitchDeg: p.pitchDeg, distance: d, target: [p.target[0], p.target[1], p.target[2]], shiftX: this.homeFrame.shiftX, shiftY: this.homeFrame.shiftY }, nowMs, 0);
    // A restore from a pinned view opens with the same dolly as the first fit.
    if (opts.dolly) this.dollyTo(this.base, nowMs, T.camera.introDollyMs);
  }

  /** Current heading (drift centre) and the yaw the figure shows now. */
  heading(nowMs: number): { headingDeg: number; yawDeg: number; pitchDeg: number } {
    const f = this.framing(nowMs);
    const base = this.tween ? this.tweened(nowMs) : this.base;
    return { headingDeg: base.yawDeg, yawDeg: f.yawDeg, pitchDeg: f.pitchDeg };
  }
}
