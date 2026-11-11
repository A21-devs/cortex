/**
 * Fibre bundles between group spheres (Groups shape). The worker reports which spheres are joined by note links and
 * how many links cross (`GroupBundle`); this turns each bundle into a fan of thin curves: the fibres leave one
 * sphere spread over its facing side, draw together toward the middle of the bundle and spread out again over the
 * facing side of the other. Pure and deterministic, so the same arrangement draws the same fibres on every open.
 * The count of fibres follows the weight (more links, more fibres); the Lines look setting decides whether they are
 * drawn at all and how many ("All" doubles the fibre count of "Selection", which is the resting amount).
 */
import type { GroupBundle, Vec3 } from "../shared/protocol/worker";
import { mulberry32 } from "../shared/rng";

export interface BundleFibres {
  /** Segment endpoints, 6 floats per segment. */
  positions: Float32Array;
  /** Draw-on parameter per vertex (0 at the first sphere, 1 at the second). */
  t: Float32Array;
  /** RGBA bytes per vertex. */
  colors: Uint8Array;
  segments: number;
  /** Fibres drawn per bundle, in the order of the input. */
  fibres: number[];
}

/** Straight pieces per fibre. */
export const FIBRE_STEPS = 8;
/** Tint of the fibres (a pale cool white; the line shader multiplies in its own alpha and depth cue). */
export const FIBRE_RGB: readonly [number, number, number] = [150, 174, 236];

/** Tint of the bundles that converge on the hub apex (the palette's azure glow). */
export const APEX_RGB: readonly [number, number, number] = [122, 185, 253];

/** Tint of a beam (the bright rail of a figure form): brighter than the fibres, still cool. */
export const BEAM_RGB: readonly [number, number, number] = [214, 232, 255];

/** Alpha byte of a bundle: brighter for heavier ones but faint (a sheaf of them must not outshine the groups), never fully off; apex bundles run from faint to about half with the link count. */
export function bundleAlpha(weight: number, apex: boolean): number {
  const w = Math.max(0, Math.min(1, Number.isFinite(weight) ? weight : 0));
  return Math.round(255 * (apex ? 0.08 + 0.4 * w : 0.1 + 0.26 * w));
}

/** Alpha byte of a figure form's fibres: a cone is a translucent sheet (faint to half), a beam is bright (60% to full). */
export function formAlpha(weight: number, form: "cone" | "beam"): number {
  const w = Math.max(0, Math.min(1, Number.isFinite(weight) ? weight : 0));
  return Math.round(255 * (form === "beam" ? 0.6 + 0.4 * w : 0.25 + 0.3 * w));
}

export type FibreDensity = "selection" | "all";

/** Fibres for a bundle: 2 for the thinnest, up to 14 for the heaviest; doubled (capped at 24) for "all". */
export function fibreCount(weight: number, density: FibreDensity): number {
  const w = Math.max(0, Math.min(1, Number.isFinite(weight) ? weight : 0));
  const base = Math.round(2 + 12 * Math.sqrt(w));
  return Math.min(24, density === "all" ? base * 2 : base);
}

function unitVec(a: Vec3, b: Vec3): { d: Vec3; len: number } {
  const x = b[0] - a[0], y = b[1] - a[1], z = b[2] - a[2];
  const len = Math.hypot(x, y, z);
  return len > 1e-9 ? { d: [x / len, y / len, z / len], len } : { d: [1, 0, 0], len: 0 };
}

/** Two unit vectors perpendicular to `d` and to each other. */
function perpendicular(d: Vec3): [Vec3, Vec3] {
  // Cross with the axis least aligned with d.
  const ax: Vec3 = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  let u: Vec3 = [d[1] * ax[2] - d[2] * ax[1], d[2] * ax[0] - d[0] * ax[2], d[0] * ax[1] - d[1] * ax[0]];
  const ul = Math.hypot(u[0], u[1], u[2]) || 1;
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const v: Vec3 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  return [u, v];
}

/** Fibres of a figure form: a cone is dense (10 to 36), a beam is a tight rope of 28; "all" adds half again (capped at 48). */
export function formFibreCount(weight: number, form: "cone" | "beam", density: FibreDensity): number {
  const w = Math.max(0, Math.min(1, Number.isFinite(weight) ? weight : 0));
  const base = form === "beam" ? 28 : Math.round(10 + 26 * Math.sqrt(w));
  return Math.min(48, density === "all" ? Math.round(base * 1.5) : base);
}

function countOf(b: GroupBundle, density: FibreDensity): number {
  if (!(unitVec(b.a, b.b).len > 0)) return 0;
  return b.form === "cone" || b.form === "beam" ? formFibreCount(b.weight, b.form, density) : fibreCount(b.weight, density);
}

/**
 * Build the fibres of every bundle. Bundles of two overlapping spheres (no gap between them) draw nothing. A "cone"
 * form leaves a narrow end at `a` and opens in straight fibres over the facing side of `b`; a "beam" runs straight
 * between the two points with only a hair of spread.
 */
export function bundleFibres(bundles: readonly GroupBundle[], density: FibreDensity, seed = 7): BundleFibres {
  const counts = bundles.map((b) => countOf(b, density));
  const total = counts.reduce((n, c) => n + c, 0) * FIBRE_STEPS;
  const positions = new Float32Array(total * 6);
  const t = new Float32Array(total * 2);
  const colors = new Uint8Array(total * 8);
  const rand = mulberry32(seed);
  let seg = 0;
  bundles.forEach((b, bi) => {
    const n = counts[bi] as number;
    if (n === 0) return;
    const { d, len } = unitVec(b.a, b.b);
    const [u, v] = perpendicular(d);
    const shaped = b.form === "cone" || b.form === "beam";
    const alpha = shaped ? formAlpha(b.weight, b.form as "cone" | "beam") : bundleAlpha(b.weight, b.apex === true);
    const rgb = b.form === "beam" ? BEAM_RGB : b.form === "cone" || b.apex === true ? APEX_RGB : FIBRE_RGB;
    const bow = shaped ? 0 : len * 0.1;
    // Where fibres leave each end: within this share of the radius of the axis, and how far in from the end.
    const spreadA = b.form === "cone" ? 0.12 : b.form === "beam" ? 0.5 : 0.55;
    const spreadB = b.form === "cone" ? 0.85 : b.form === "beam" ? 0.5 : 0.55;
    const inset = b.form === "beam" ? 0 : 0.8;
    const mid: Vec3 = [(b.a[0] + b.b[0]) / 2, (b.a[1] + b.b[1]) / 2, (b.a[2] + b.b[2]) / 2];
    for (let k = 0; k < n; k++) {
      // Where the fibre leaves each sphere: on the facing side, spread within 55% of the radius of the axis.
      const sa = Math.sqrt(rand()) * spreadA * b.ra, aa = rand() * Math.PI * 2;
      const sb = Math.sqrt(rand()) * spreadB * b.rb, ab = rand() * Math.PI * 2;
      const pa: Vec3 = [0, 0, 0], pb: Vec3 = [0, 0, 0], c: Vec3 = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        pa[i] = (b.a[i] as number) + (d[i] as number) * b.ra * inset + ((u[i] as number) * Math.cos(aa) + (v[i] as number) * Math.sin(aa)) * sa;
        pb[i] = (b.b[i] as number) - (d[i] as number) * b.rb * inset + ((u[i] as number) * Math.cos(ab) + (v[i] as number) * Math.sin(ab)) * sb;
      }
      // All fibres of a bundle pass close to one waist, bowed to one side so crossing bundles stay apart.
      // Cones and beams stay straight: the control point is the midpoint of the two ends.
      const j1 = shaped ? 0 : (rand() - 0.5) * 0.12 * len, j2 = shaped ? 0 : (rand() - 0.5) * 0.12 * len;
      for (let i = 0; i < 3; i++) c[i] = shaped ? (pa[i] as number) / 2 + (pb[i] as number) / 2 : (mid[i] as number) + (u[i] as number) * (bow + j1) + (v[i] as number) * j2;
      let prev: Vec3 = pa;
      for (let s = 1; s <= FIBRE_STEPS; s++) {
        const q = s / FIBRE_STEPS;
        const w0 = (1 - q) * (1 - q), w1 = 2 * (1 - q) * q, w2 = q * q;
        const next: Vec3 = [w0 * pa[0] + w1 * c[0] + w2 * pb[0], w0 * pa[1] + w1 * c[1] + w2 * pb[1], w0 * pa[2] + w1 * c[2] + w2 * pb[2]];
        positions.set(prev, seg * 6);
        positions.set(next, seg * 6 + 3);
        t[seg * 2] = (s - 1) / FIBRE_STEPS;
        t[seg * 2 + 1] = q;
        for (let e = 0; e < 2; e++) {
          colors[seg * 8 + e * 4] = rgb[0];
          colors[seg * 8 + e * 4 + 1] = rgb[1];
          colors[seg * 8 + e * 4 + 2] = rgb[2];
          colors[seg * 8 + e * 4 + 3] = alpha;
        }
        prev = next;
        seg++;
      }
    }
  });
  return { positions, t, colors, segments: seg, fibres: counts };
}
