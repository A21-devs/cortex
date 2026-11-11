/**
 * Motion: easing, tweens, the intro growth clock, rebuild and scope choreography timing. Owner: E10.
 * Numbers live in RENDER_TUNING (render/tuning.ts); CORTEX-UX §4.8 and §6.7 are the source.
 *
 * Growth (the user's figure brief): the cord first, from the brainstem downward, then the nerves (each
 * conversation's frond) outward, then the brain. Birth times per point come from the worker (placement.birth);
 * the shader reveals a point when the intro clock passes its birth, with a birth flash (white at 2.2× size,
 * settling over 220 ms), and a frond's messages swing out of a 60° curl over 0.45 s as they appear. Haze fades in
 * (0.4 s) instead of flashing. Rebuild plays the same order 4× faster (0.9 s). A leaf that opens later in the
 * session, or returns from release, fades its points in over 200 ms instead ("return").
 * Scope change (ORIG-16): the figure turns so the chosen territory faces the viewer (600 ms); non-members sink
 * 25% toward the brain's core (record: toward the cord axis) while fading out (300 ms); on return to All areas they
 * rise back over 400 ms. Live arrivals are born in their slots with a flash; nothing else moves.
 * Reduced motion: no growth (200 ms fade), no unfurl, no seed ring; scope and shape changes jump with a 120 ms
 * opacity dip; camera moves cut.
 */
import type { MotionPref } from "../shared/settings";
import { RENDER_TUNING } from "./tuning";

export type Easing = (t: number) => number;

const clamp01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t);

/**
 * CSS cubic-bezier(x1, y1, x2, y2) as an easing function (Newton iterations with a bisection fallback), so the
 * camera and the morphs use exactly the UI's motion tokens (CORTEX-UX §4.8).
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): Easing {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number): number => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number): number => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number): number => (3 * ax * s + 2 * bx) * s + cx;
  const solve = (x: number): number => {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(s) - x;
      if (Math.abs(err) < 1e-6) return s;
      const d = slopeX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    let lo = 0;
    let hi = 1;
    s = x;
    for (let i = 0; i < 30; i++) {
      const v = sampleX(s);
      if (Math.abs(v - x) < 1e-6) return s;
      if (v < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  };
  return (t: number) => {
    const x = clamp01(t);
    if (x === 0 || x === 1) return x;
    return sampleY(solve(x));
  };
}

/** `--cx-ease-out` cubic-bezier(.16,.84,.3,1): most entrances. */
export const easeOut: Easing = cubicBezier(0.16, 0.84, 0.3, 1);
/** `--cx-ease-inout` cubic-bezier(.62,.02,.33,.98): camera, docking, morphs. */
export const easeInOut: Easing = cubicBezier(0.62, 0.02, 0.33, 0.98);
export const linear: Easing = clamp01;
/** GLSL-style smoothstep on 0..1. */
export const smooth: Easing = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

const G = RENDER_TUNING.growth;

export const INTRO_STAGES = G.stages;
export type IntroStageName = (typeof INTRO_STAGES)[number]["name"];
export const INTRO_SECONDS = G.introSec;
export const REBUILD_SECONDS = G.rebuildSec;
export const SCOPE_FADE_MS = RENDER_TUNING.scope.sinkFadeMs;
export const RISE_MS = RENDER_TUNING.scope.riseMs;
export const BIRTH_FLASH_MS = G.birthFlashMs;

/** Birth time of a cord point at spine position τ (seconds into the intro): the cord grows from the brainstem. */
export function spineBirth(tau: number): number {
  return G.spineStart + G.spineSpan * clamp01(tau);
}

/** Progress 0..1 of an intro stage at intro time `t` (seconds). */
export function stageProgress(name: IntroStageName, t: number): number {
  const s = INTRO_STAGES.find((x) => x.name === name);
  if (!s) return 1;
  return clamp01((t - s.from) / (s.to - s.from));
}

export interface Tween {
  from: number;
  to: number;
  startMs: number;
  durationMs: number;
  ease: Easing;
}

export function tweenValue(tw: Tween, nowMs: number): { value: number; done: boolean } {
  const t = tw.durationMs <= 0 ? 1 : (nowMs - tw.startMs) / tw.durationMs;
  const done = t >= 1;
  return { value: tw.from + (tw.to - tw.from) * tw.ease(clamp01(t)), done };
}

/**
 * A scalar that tweens toward targets. `set` with a duration of 0 jumps. `value(now)` is cheap; `busy(now)` says
 * whether frames are still needed.
 */
export class AnimatedValue {
  private tw: Tween;

  constructor(initial: number) {
    this.tw = { from: initial, to: initial, startMs: 0, durationMs: 0, ease: linear };
  }

  get target(): number {
    return this.tw.to;
  }

  value(nowMs: number): number {
    return tweenValue(this.tw, nowMs).value;
  }

  set(to: number, nowMs: number, durationMs: number, ease: Easing = easeInOut): void {
    const from = this.value(nowMs);
    this.tw = { from, to, startMs: nowMs, durationMs: Math.max(0, durationMs), ease };
  }

  jump(to: number): void {
    this.tw = { from: to, to, startMs: 0, durationMs: 0, ease: linear };
  }

  busy(nowMs: number): boolean {
    return !tweenValue(this.tw, nowMs).done;
  }
}

/**
 * Follows the store's morph value (0 = body … 1 = the target shape): a jump larger than `morphJump` (a click on
 * an end of the shape bar, a command) animates over 1.4 s × the distance; small steps (scrubbing) follow live.
 * Reduced motion jumps (the caller dips opacity for 120 ms).
 */
export class MorphFollower {
  readonly anim = new AnimatedValue(0);

  follow(target: number, nowMs: number, reduced: boolean): "jump" | "animate" | "live" {
    const t = clamp01(target);
    const cur = this.anim.value(nowMs);
    const delta = Math.abs(t - cur);
    if (delta === 0 && !this.anim.busy(nowMs)) return "live";
    if (reduced) {
      this.anim.jump(t);
      return "jump";
    }
    if (delta > RENDER_TUNING.shape.morphJump) {
      this.anim.set(t, nowMs, Math.max(120, (t < cur ? RENDER_TUNING.shape.morphBackMs : RENDER_TUNING.shape.morphMs) * delta), easeInOut);
      return "animate";
    }
    this.anim.jump(t);
    return "live";
  }
}

export type IntroKind = "intro" | "rebuild" | "return";

/**
 * The intro timeline. Points with birth ≤ time(now) are born. The clock keeps running after the intro (so arrivals
 * can be born "now" with a flash); `settled` says when the growth has finished.
 */
export class IntroClock {
  private startMs = 0;
  private rate = 1;
  private offsetSec = INTRO_SECONDS + 1;
  kind: IntroKind = "return";
  /** True while the growth plays with unfurling fronds and the seed ring (not under reduced motion). */
  growing = false;

  /** Start a sequence. Reduced motion or "return": everything is born at once (the caller fades in). */
  play(kind: IntroKind, nowMs: number, reduced: boolean): void {
    this.kind = kind;
    this.startMs = nowMs;
    if (reduced || kind === "return") {
      this.rate = 1;
      this.offsetSec = INTRO_SECONDS + 1;
      this.growing = false;
      return;
    }
    this.rate = kind === "rebuild" ? INTRO_SECONDS / REBUILD_SECONDS : 1;
    this.offsetSec = 0;
    this.growing = true;
  }

  /** Seconds on the intro timeline. Before any play: past the end (everything born, no flashes). */
  time(nowMs: number): number {
    return this.offsetSec + (Math.max(0, nowMs - this.startMs) / 1000) * this.rate;
  }

  /** Real milliseconds until the growth (and its last birth flash) has finished. */
  remainingMs(nowMs: number): number {
    const end = INTRO_SECONDS + G.birthFlashMs / 1000;
    const left = end - this.time(nowMs);
    return left <= 0 ? 0 : (left / this.rate) * 1000;
  }

  settled(nowMs: number): boolean {
    return this.remainingMs(nowMs) === 0;
  }

  /** 0..1 ease-in of the camera motion (the spin, or the drift when lying): introMotionStart on the first frame of
   *  the growth, full speed after introMotionRampMs. */
  motionEase(nowMs: number): number {
    if (!this.growing) return 1;
    const M = RENDER_TUNING.motion;
    const t = Math.max(0, this.time(nowMs));
    return M.introMotionStart + (1 - M.introMotionStart) * clamp01(((t / this.rate) * 1000) / M.introMotionRampMs);
  }

  /** Birth times for `n` revealed arrivals: now, spread over the stagger window in ordinal order. */
  arrivalBirths(n: number, nowMs: number, out: Float32Array = new Float32Array(n)): Float32Array {
    const t0 = this.time(nowMs);
    const span = G.arrivalStaggerSec * this.rate;
    for (let i = 0; i < n; i++) out[i] = t0 + (n <= 1 ? 0 : (i / (n - 1)) * span);
    return out;
  }
}

/** Duration of a scope state change: fading out to a territory, rising back to All areas, or the reduced cut. */
export function scopeTransitionMs(direction: "out" | "in", reduced: boolean): number {
  if (reduced) return RENDER_TUNING.scope.reducedCrossfadeMs;
  return direction === "out" ? RENDER_TUNING.scope.sinkFadeMs : RENDER_TUNING.scope.riseMs;
}

/**
 * Reduced motion: Settings › Appearance › Motion "Reduced", or "Follow system" and prefers-reduced-motion.
 * Accepts the settings values ("system" | "reduced" | "full") and the older ("auto" | "on" | "off").
 */
export function prefersReducedMotion(setting: MotionPref | "auto" | "on" | "off", win?: { matchMedia?: (q: string) => { matches: boolean } }): boolean {
  if (setting === "reduced" || setting === "on") return true;
  if (setting === "full" || setting === "off") return false;
  const mm = win?.matchMedia ?? (typeof matchMedia === "function" ? matchMedia : undefined);
  if (!mm) return false;
  try {
    return mm("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// ───────────────────────────── point-shader effects (P04) ─────────────────────────────
// Pure mirrors of the maths the point vertex shader runs, so the effects can be tested without a GPU. The integer
// hash is the same PCG hash in GLSL (render/shaders.ts, `pcgHash`) and here; salt k of point i is hash(8i + k).

/** PCG hash of a 32-bit value; identical to the shader's `pcgHash` (uint arithmetic wraps like Math.imul). */
export function pcgHash(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

/** Stable 0..1 hash of point `id` under `salt` (0..7): shimmer phase 1, dissolve 5, the humanoid pose 0..4 use their own salts. */
export function hashUnit(id: number, salt: number): number {
  return pcgHash((Math.imul(id >>> 0, 8) + salt) >>> 0) / 4294967296;
}

export const HASH_SALT = { shimmer: 1, dissolve: 5, human: 0 } as const;

const M = RENDER_TUNING.morph;
/** Whole length of a grouping-change dissolve, ms. */
export const DISSOLVE_MS = M.dissolveOutMs + M.dissolveInMs;
/** Where the positions swap, as a share of the dissolve. */
export const DISSOLVE_SPLIT = M.dissolveOutMs / DISSOLVE_MS;

/** Whether point `id` is one of the share `keep` of points that fade out in a dissolve (the rest only shrink). */
export function dissolveFades(id: number, keep: number = M.dissolveFade): boolean {
  return hashUnit(id, HASH_SALT.dissolve) < keep;
}

/**
 * Alpha and size multipliers of a dissolve at progress `d` (0..1). Phase one (to DISSOLVE_SPLIT): the faded share goes to
 * 0 and the rest shrink to `dissolveShrink`; positions swap at the split; phase two: the faded share fades back in and
 * the rest grow back. d < 0 = no dissolve.
 */
export function dissolveLook(d: number, fades: boolean): { alpha: number; size: number } {
  if (d < 0) return { alpha: 1, size: 1 };
  const x = Math.min(1, d);
  if (x < DISSOLVE_SPLIT) {
    const k = x / DISSOLVE_SPLIT;
    return fades ? { alpha: 1 - k, size: 1 } : { alpha: 1, size: 1 + (M.dissolveShrink - 1) * k };
  }
  const k = (x - DISSOLVE_SPLIT) / (1 - DISSOLVE_SPLIT);
  const s = k * k * (3 - 2 * k);
  return fades ? { alpha: s, size: 1 } : { alpha: 1, size: M.dissolveShrink + (1 - M.dissolveShrink) * s };
}

/** The shimmer multiplier of a point's alpha at time `t` seconds (shimmer 0..1). */
export function shimmerAlpha(t: number, id: number, shimmer = 1): number {
  const S = RENDER_TUNING.shimmer;
  return 1 + shimmer * S.amp * Math.sin(t * S.rate + hashUnit(id, HASH_SALT.shimmer) * 2 * Math.PI);
}

/**
 * The query fade at `elapsedMs` since it started: the whole figure dips to `queryDipTo` (dip 1 → floor), then regrows
 * (regrow 0 → 1) in the growth clock's own order. `regrow` is -1 outside the second phase; `done` after both.
 */
export type FadeKind = "query" | "group";

/** Dip depth, dip time and regrow time of a fade: a query dips to 15% in 150 ms; a change of Group by to about 0 in 300 ms. */
export function fadeShape(kind: FadeKind): { dipTo: number; dipMs: number; regrowMs: number } {
  const S = RENDER_TUNING.states;
  return kind === "group" ? { dipTo: S.groupDipTo, dipMs: S.groupDipMs, regrowMs: S.groupRegrowMs } : { dipTo: S.queryDipTo, dipMs: S.queryDipMs, regrowMs: S.queryRegrowMs };
}

export function queryFadeAt(elapsedMs: number, kind: FadeKind = "query"): { dip: number; regrow: number; done: boolean } {
  const S = fadeShape(kind);
  if (elapsedMs < S.dipMs) return { dip: 1 + (S.dipTo - 1) * Math.max(0, elapsedMs / S.dipMs), regrow: -1, done: false };
  const p = (elapsedMs - S.dipMs) / S.regrowMs;
  if (p >= 1) return { dip: 1, regrow: -1, done: true };
  return { dip: 1, regrow: p, done: false };
}

/**
 * How far a closing flat chart has shrunk toward its small top rectangle (0..1) at morph value `m` falling from 1: it
 * shrinks and fades over the first part of the way back, then the points travel home (the value returns to 0).
 */
export function chartExitAt(m: number): number {
  const into = Math.max(0, Math.min(1, (1 - m) / 0.2));
  const out = Math.max(0, Math.min(1, (0.8 - m) / 0.4));
  const s = (x: number): number => x * x * (3 - 2 * x);
  return s(into) * (1 - s(out));
}

/** Growth-clock span the regrow wave sweeps: the intro's length plus the soft edge (also a shader uniform). */
export const REGROW_SPAN = G.introSec + RENDER_TUNING.states.queryRegrowSoftSec;

/**
 * Brightness multiplier (0..1) of a point born at `birth` growth-clock seconds while the regrow wave is at progress `p`:
 * the figure waits at `queryDipTo`, then each point rises to full when the wave passes its birth, so the cord (born
 * first) comes back before the nerves and the brain. Points born after the span (live arrivals) are not gated.
 */
export function regrowReveal(birth: number, p: number, floor: number = RENDER_TUNING.states.queryDipTo): number {
  if (p < 0 || birth > REGROW_SPAN) return 1;
  const soft = RENDER_TUNING.states.queryRegrowSoftSec;
  const t = Math.min(1, p) * REGROW_SPAN;
  const k = Math.max(0, Math.min(1, (t - birth) / soft));
  return floor + (1 - floor) * k * k * (3 - 2 * k);
}

export interface SpreadTerms {
  /** Scale of the cerebrum about its centre. */
  brainScale: number;
  /** Brightness and size multipliers of the cord's points. */
  cordBright: number;
  cordSize: number;
  /** Density (alpha) multiplier of the body field (haze). */
  hazeDensity: number;
}

/** The global body terms of the Display Scatter slider `s` (1 = rest): see RENDER_TUNING.spread. */
export function scatterTerms(s: number): SpreadTerms {
  const P = RENDER_TUNING.spread;
  const x = Number.isFinite(s) ? s : 1;
  const c = (v: number, r: readonly number[]): number => Math.max(r[0] as number, Math.min(r[1] as number, v));
  return {
    brainScale: P.brainBase + P.brainGain * x,
    cordBright: c(1 + (1 - x) * P.cordBright, P.brightRange),
    cordSize: c(1 + (1 - x) * P.cordSize, P.sizeRange),
    hazeDensity: c(1 + (1 - x) * P.haze, P.hazeRange),
  };
}

/** Cumulative share (0..1) at the end of each humanoid transit-pose part (RENDER_TUNING.transit); the shader holds the same table. */
export const HUMAN_CUMULATIVE: readonly number[] = (() => {
  const parts = RENDER_TUNING.transit.parts;
  const total = parts.reduce((n, q) => n + q.weight, 0);
  let acc = 0;
  return parts.map((q) => (acc += q.weight / total));
})();
