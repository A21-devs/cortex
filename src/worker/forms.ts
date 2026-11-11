/**
 * Figure forms of the Groups shape's sphere layout (CORTEX-UX §6.12). Three groupings take a form of their own
 * instead of the plain pack of spheres, because the groups there are not peers:
 *  - rail (Map type): the three map types stand on a bright beam across the top, the big "Not a map" sphere sits
 *    below, and a long cone leaves each map type and opens over the big sphere;
 *  - comet (Role, the placement pack's field): the roles gather into one cluster per brain region, laid along a
 *    teardrop with a big head and a tapering tail; strands stream back along the tail and each region is named
 *    (boxed) over its clusters. It turns between lying and standing (`orientation`);
 *  - T (What kind, while an area is chosen): the kinds stand in a bar across the top, the map apex hangs below the
 *    middle of the bar on a stem.
 * Everything here is pure geometry over sphere radii: the caller fills the spheres with points and draws the bundles.
 * Positions are in the arrangement's frame before it is scaled to the stage; y is up.
 */
import type { Vec3 } from "../shared/protocol/worker";

/** How a bundle's fibres are drawn: a spread fan between two spheres, a cone from a narrow end to a wide one, a straight beam. */
export type BundleForm = "bundle" | "cone" | "beam";

/** One extra bundle of a form: ends are sphere indices (or free points for a beam). */
export interface FormBundle {
  /** Narrow end (cones) or first end. */
  a: Vec3;
  b: Vec3;
  ra: number;
  rb: number;
  weight: number;
  form: BundleForm;
}

export interface FormLayout {
  /** One centre per input sphere, in input order. */
  centres: Vec3[];
  bundles: FormBundle[];
}

const v3 = (x: number, y: number, z = 0): Vec3 => [x, y, z];

// ───────────────────────────── rail (Map type) ─────────────────────────────

export interface RailSphere {
  r: number;
  role: "map" | "base" | "other";
}

/**
 * The map-type rail: `map` spheres in a row across the top (in input order), the `base` sphere (the non-maps) below
 * and the `other` spheres (items without a value) beside it. Null when there is no rail to draw (no map type, or no
 * base to join it to).
 */
export function railLayout(spheres: readonly RailSphere[]): FormLayout | null {
  const maps = spheres.map((s, i) => ({ s, i })).filter((x) => x.s.role === "map");
  const base = spheres.map((s, i) => ({ s, i })).filter((x) => x.s.role === "base").sort((a, b) => b.s.r - a.s.r)[0];
  if (maps.length === 0 || !base) return null;
  const centres: Vec3[] = spheres.map(() => v3(0, 0));
  const R = base.s.r;
  const maxMap = Math.max(...maps.map((m) => m.s.r));
  // The rail is about as wide as the base is across, never tighter than its spheres.
  const pitch = Math.max(maxMap * 2.6, (R * 1.7) / Math.max(1, maps.length - 1 || 1));
  const yRail = R + Math.max(R * 2.2, maxMap * 6);
  maps.forEach((m, k) => {
    centres[m.i] = v3((k - (maps.length - 1) / 2) * pitch, yRail);
  });
  centres[base.i] = v3(0, 0);
  // Spheres without a value stand to the right of the base, stepping down.
  let ox = R + 1;
  for (let i = 0; i < spheres.length; i++) {
    const s = spheres[i] as RailSphere;
    if (s.role !== "other") continue;
    ox += s.r;
    centres[i] = v3(ox, -R * 0.35);
    ox += s.r + 0.6;
  }
  const bundles: FormBundle[] = [];
  const half = ((maps.length - 1) / 2) * pitch + pitch * 0.75;
  bundles.push({ a: v3(-half, yRail), b: v3(half, yRail), ra: maxMap * 0.5, rb: maxMap * 0.5, weight: 1, form: "beam" });
  const peak = Math.max(...maps.map((m) => m.s.r));
  for (const m of maps) bundles.push({ a: centres[m.i] as Vec3, b: centres[base.i] as Vec3, ra: m.s.r, rb: R, weight: 0.45 + 0.55 * (m.s.r / peak), form: "cone" });
  return { centres, bundles };
}

// ───────────────────────────── T (What kind, scoped) ─────────────────────────────

/**
 * The T: `bar` spheres in a row (input order, widest gap to neighbours kept even) across the top and the `apex`
 * sphere (an index into `radii`) hung under the middle of the bar. The bar and the stem are drawn as beams.
 */
export function tLayout(radii: readonly number[], apex: number): FormLayout {
  const centres: Vec3[] = radii.map(() => v3(0, 0));
  const bar = radii.map((r, i) => ({ r, i })).filter((x) => x.i !== apex);
  const gap = Math.max(0.5, Math.max(0, ...bar.map((b) => b.r)) * 0.5);
  const width = bar.reduce((n, b) => n + 2 * b.r, 0) + gap * Math.max(0, bar.length - 1);
  let x = -width / 2;
  for (const b of bar) {
    centres[b.i] = v3(x + b.r, 0);
    x += 2 * b.r + gap;
  }
  const rApex = radii[apex] ?? 0;
  const stem = Math.max(width * 0.42, rApex + Math.max(0, ...bar.map((b) => b.r)) * 2.2);
  centres[apex] = v3(0, -stem);
  const bundles: FormBundle[] = [];
  if (bar.length > 1) {
    const first = centres[(bar[0] as { i: number }).i] as Vec3;
    const last = centres[(bar[bar.length - 1] as { i: number }).i] as Vec3;
    const thin = Math.max(0.2, gap * 0.3);
    bundles.push({ a: v3(first[0], 0), b: v3(last[0], 0), ra: thin, rb: thin, weight: 0.6, form: "beam" });
  }
  bundles.push({ a: v3(0, 0), b: v3(0, -stem + rApex), ra: Math.max(0.2, gap * 0.3), rb: Math.max(0.2, gap * 0.3), weight: 0.8, form: "beam" });
  return { centres, bundles };
}

// ───────────────────────────── comet (Role) ─────────────────────────────

export interface CometSphere {
  r: number;
  /** Cluster order group (the brain region, or a rank after the regions for values outside the pack). */
  region: number;
}

export type CometOrientation = "horizontal" | "vertical";

export interface CometLayout extends FormLayout {
  /** Radii the spheres should be filled with (the tail tapers). */
  radii: number[];
}

/** How much the tail narrows: the last cluster keeps this fraction less of its radius. */
export const COMET_TAPER = 0.35;

/**
 * Lay clusters along a teardrop: they arrive biggest region first (the head), each one further along a gently
 * widening gap, nudged alternately above and below the axis by an amount that shrinks toward the tail. Horizontal
 * puts the head at the left and the tail running right; vertical puts the head on top. The result is centred on
 * the origin so both orientations frame alike. Strands run from each cluster back toward the one before it.
 */
export function cometLayout(spheres: readonly CometSphere[], orientation: CometOrientation = "horizontal"): CometLayout {
  const n = spheres.length;
  const radii = spheres.map((s, i) => s.r * (1 - COMET_TAPER * (n > 1 ? i / (n - 1) : 0)));
  const along: Vec3[] = [];
  let x = 0;
  for (let i = 0; i < n; i++) {
    const r = radii[i] as number;
    if (i > 0) x += (radii[i - 1] as number) + r + 0.35 * ((radii[i - 1] as number) + r) * (1 + 0.15 * i);
    const side = i === 0 ? 0 : i % 2 === 1 ? 1 : -1;
    along.push(v3(x, side * 0.5 * r * (1 - i / Math.max(1, n))));
  }
  let lo = Infinity, hi = -Infinity, ylo = Infinity, yhi = -Infinity;
  for (let i = 0; i < n; i++) {
    const c = along[i] as Vec3;
    const r = radii[i] as number;
    lo = Math.min(lo, c[0] - r);
    hi = Math.max(hi, c[0] + r);
    ylo = Math.min(ylo, c[1] - r);
    yhi = Math.max(yhi, c[1] + r);
  }
  const mx = (lo + hi) / 2, my = (ylo + yhi) / 2;
  const centres = along.map((c): Vec3 => {
    const px = c[0] - mx, py = c[1] - my;
    // Standing: the axis runs down the screen, the head on top.
    return orientation === "horizontal" ? v3(px, py) : v3(py, -px);
  });
  const bundles: FormBundle[] = [];
  for (let i = 1; i < n; i++) {
    // The narrow end of a strand is the tail cluster, so the strands open toward the head like a comet's wake.
    bundles.push({ a: centres[i] as Vec3, b: centres[i - 1] as Vec3, ra: radii[i] as number, rb: radii[i - 1] as number, weight: Math.max(0.35, 1 - i / Math.max(2, n)), form: "cone" });
  }
  return { centres, radii, bundles };
}

/** Where a region's name sits over the clusters it covers: above them lying, to their left standing. */
export function cometLabelAt(members: readonly { c: Vec3; r: number }[], orientation: CometOrientation): { at: Vec3; align: "center" | "right" } {
  let cx = 0, cy = 0, w = 0;
  for (const m of members) {
    cx += m.c[0] * m.r;
    cy += m.c[1] * m.r;
    w += m.r;
  }
  cx /= w || 1;
  cy /= w || 1;
  if (orientation === "horizontal") return { at: v3(cx, Math.max(...members.map((m) => m.c[1] + m.r)) + 0.12), align: "center" };
  return { at: v3(Math.min(...members.map((m) => m.c[0] - m.r)) - 0.12, cy), align: "right" };
}
