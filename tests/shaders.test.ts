/**
 * Point-shader effects (package P04): the GLSL sources are consistent with the uniforms the layers supply (a uniform the
 * shader reads but the material lacks would read 0 and silently break a pass), the integer hash the shader and the TS
 * mirror share, and the pure maths of shimmer, the grouping dissolve, the query dip and regrow, the transit pose and the
 * Spread contraction. No GPU needed; the shaders themselves were also compiled and linked in a real WebGL2 context.
 */
import { describe, expect, it } from "vitest";
import {
  DISSOLVE_MS,
  DISSOLVE_SPLIT,
  HUMAN_CUMULATIVE,
  REGROW_SPAN,
  dissolveFades,
  dissolveLook,
  hashUnit,
  pcgHash,
  queryFadeAt,
  regrowReveal,
  scatterTerms,
  shimmerAlpha,
} from "../src/render/animation";
import { createHazeLayer, isBodyFieldKind } from "../src/render/layers/haze";
import { NO_GROUP, createPointsLayer, groupAttr } from "../src/render/layers/points";
import { HAZE_VERT, POINTS_FRAG, POINTS_VERT, RING_FRAG, RING_VERT, STREAK_TINTS, pickVert } from "../src/render/shaders";
import { humanoidPoint } from "../src/render/silhouette";
import { RENDER_TUNING } from "../src/render/tuning";

/** Names of the `uniform` declarations of a GLSL source (arrays included). */
function uniformNames(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/gm)) out.push(m[1] as string);
  return out;
}

const THREE_BUILTIN = new Set(["modelViewMatrix", "projectionMatrix"]);

describe("render/shaders: every uniform a pass reads is supplied by its layer", () => {
  it("points, rings and picking", () => {
    const layer = createPointsLayer(8);
    const pick = layer.pickObject(true).material as unknown as { uniforms: Record<string, unknown> };
    const checks: [string, string[], Record<string, unknown>][] = [
      ["points", [...uniformNames(POINTS_VERT), ...uniformNames(POINTS_FRAG)], layer.material.uniforms],
      ["ring", [...uniformNames(RING_VERT), ...uniformNames(RING_FRAG)], layer.rings.hover.material.uniforms],
      ["pick", uniformNames(pickVert()), pick.uniforms],
    ];
    for (const [name, names, have] of checks) {
      const missing = names.filter((n) => !THREE_BUILTIN.has(n) && !(n in have));
      expect({ name, missing }).toEqual({ name, missing: [] });
    }
    layer.dispose();
  });

  it("haze", () => {
    const haze = createHazeLayer(64);
    const missing = [...uniformNames(HAZE_VERT), ...uniformNames(POINTS_FRAG)].filter((n) => !THREE_BUILTIN.has(n) && !(n in haze.material.uniforms));
    // The hover-trail uniforms of the shared fragment shader are the points material's: the haze never draws a trail (vHot is 0).
    expect(missing.filter((n) => !/^uStreak/.test(n))).toEqual([]);
    haze.dispose();
  });

  it("the effect uniforms start neutral, so a point draws as before", () => {
    const u = createPointsLayer(4).material.uniforms;
    expect(u.uShimmer?.value).toBe(0);
    expect(u.uDissolve?.value).toBe(-1);
    expect(u.uRegrow?.value).toBe(-1);
    expect(u.uDip?.value).toBe(1);
    expect(u.uHumanW?.value).toBe(0);
    expect(u.uBrainScale?.value).toBe(1);
    expect(u.uCordBright?.value).toBe(1);
    expect(u.uHoverOn?.value).toBe(0);
    expect((u.uStreakTint?.value as unknown[]).length).toBe(STREAK_TINTS);
  });

  it("declares the per-point group attribute and the shimmer and dissolve maths", () => {
    expect(POINTS_VERT).toContain("in uint aGroup;");
    expect(POINTS_VERT).toMatch(/uShimmerAmp \* sin\(uTime \* uShimmerRate/);
    expect(POINTS_VERT).toContain("uint pcgHash(uint v)");
    expect(POINTS_VERT).toContain("hashUnit(id, 5u) < uDissolveFade");
    // The humanoid table is generated from the tuning: the same cumulative shares as the TS mirror.
    expect(POINTS_VERT).toContain(`const int HN = ${RENDER_TUNING.transit.parts.length};`);
    for (const c of HUMAN_CUMULATIVE) expect(POINTS_VERT).toContain(String(c).length > 3 ? String(c) : c.toFixed(1));
  });
});

/** Reference PCG hash on BigInt (unbounded integers reduced mod 2^32), independent of Math.imul. */
function pcgRef(v: number): number {
  const M = 0x100000000n;
  const s = (BigInt(v) * 747796405n + 2891336453n) % M;
  const sh = (s >> 28n) + 4n;
  const w = ((((s >> sh) ^ s) % M) * 277803737n) % M;
  return Number(((w >> 22n) ^ w) % M);
}

describe("render/animation: the shared PCG hash", () => {
  it("matches an arbitrary-precision reference for many inputs", () => {
    for (const v of [0, 1, 2, 7, 255, 65535, 123456789, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff]) expect(pcgHash(v)).toBe(pcgRef(v));
    for (let i = 0; i < 200; i++) expect(pcgHash(i * 2654435761)).toBe(pcgRef((i * 2654435761) >>> 0));
  });

  it("maps to [0, 1) and differs by salt", () => {
    for (let i = 0; i < 500; i++) {
      for (let k = 0; k < 8; k++) {
        const h = hashUnit(i, k);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(1);
      }
    }
    expect(hashUnit(3, 1)).not.toBe(hashUnit(3, 2));
  });
});

describe("render/animation: dissolve on a grouping change (FIG-50)", () => {
  it("fades 85% of points, chosen by the hash, and the rest only shrink", () => {
    const N = 40_000;
    let fading = 0;
    for (let i = 0; i < N; i++) if (dissolveFades(i)) fading++;
    expect(fading / N).toBeGreaterThan(0.84);
    expect(fading / N).toBeLessThan(0.86);
    // Stable: the same point is always in the same share.
    expect(dissolveFades(12345)).toBe(dissolveFades(12345));
    expect(dissolveFades(7, 0)).toBe(false);
    expect(dissolveFades(7, 1.01)).toBe(true);
  });

  it("runs 120 ms out and 300 ms in, with the swap at the split", () => {
    expect(DISSOLVE_MS).toBe(420);
    expect(DISSOLVE_SPLIT).toBeCloseTo(120 / 420, 10);
    expect(RENDER_TUNING.morph.groupChange).toBe("dissolve");
  });

  it("goes dark (or small) at the swap and refills with no jump at either end", () => {
    const out = RENDER_TUNING.morph.dissolveShrink;
    expect(dissolveLook(-1, true)).toEqual({ alpha: 1, size: 1 });
    expect(dissolveLook(0, true)).toEqual({ alpha: 1, size: 1 });
    expect(dissolveLook(0, false)).toEqual({ alpha: 1, size: 1 });
    const justBefore = DISSOLVE_SPLIT - 1e-9;
    expect(dissolveLook(justBefore, true).alpha).toBeCloseTo(0, 6);
    expect(dissolveLook(DISSOLVE_SPLIT, true).alpha).toBeCloseTo(0, 6);
    expect(dissolveLook(justBefore, false).size).toBeCloseTo(out, 6);
    expect(dissolveLook(DISSOLVE_SPLIT, false).size).toBeCloseTo(out, 6);
    // The shrinking share stays fully visible all the way through.
    for (const d of [0, 0.1, DISSOLVE_SPLIT, 0.6, 1]) expect(dissolveLook(d, false).alpha).toBe(1);
    expect(dissolveLook(1, true)).toEqual({ alpha: 1, size: 1 });
    expect(dissolveLook(1, false).size).toBeCloseTo(1, 10);
    // Monotone refill.
    let last = -1;
    for (let d = DISSOLVE_SPLIT; d <= 1; d += 0.02) {
      const a = dissolveLook(d, true).alpha;
      expect(a).toBeGreaterThanOrEqual(last);
      last = a;
    }
  });
});

describe("render/animation: shimmer (FIG-10)", () => {
  it("twinkles an alpha by at most 18% and is steady with the shimmer off", () => {
    let lo = 2, hi = 0;
    for (let i = 0; i < 400; i++) {
      for (let t = 0; t < 6; t += 0.37) {
        const a = shimmerAlpha(t, i, 1);
        lo = Math.min(lo, a);
        hi = Math.max(hi, a);
        expect(shimmerAlpha(t, i, 0)).toBe(1);
      }
    }
    expect(lo).toBeGreaterThanOrEqual(1 - 0.18 - 1e-9);
    expect(hi).toBeLessThanOrEqual(1 + 0.18 + 1e-9);
    expect(hi - lo).toBeGreaterThan(0.3);
    // Out of phase between points.
    expect(shimmerAlpha(1, 1)).not.toBe(shimmerAlpha(1, 2));
  });

  it("has the constants of the spec", () => {
    expect(RENDER_TUNING.shimmer).toMatchObject({ amp: 0.18, jitter: 0.002, rate: 2.3 });
  });
});

describe("render/animation: query fade and regrow (FIG-28)", () => {
  it("dips to 15% over 150 ms, regrows over 300 ms, then is done", () => {
    expect(queryFadeAt(0)).toEqual({ dip: 1, regrow: -1, done: false });
    expect(queryFadeAt(75).dip).toBeCloseTo((1 + 0.15) / 2, 10);
    expect(queryFadeAt(149.99).dip).toBeCloseTo(0.15, 3);
    expect(queryFadeAt(150)).toEqual({ dip: 1, regrow: 0, done: false });
    expect(queryFadeAt(300).regrow).toBeCloseTo(0.5, 10);
    expect(queryFadeAt(450).done).toBe(true);
    expect(queryFadeAt(450).regrow).toBe(-1);
    expect(RENDER_TUNING.states.regrowOnQuery).toBe(true);
    expect(RENDER_TUNING.states.queryDebounceMs).toBe(400);
  });

  it("brings the cord back before the nerves and the nerves before the brain", () => {
    const G = RENDER_TUNING.growth;
    const cord = G.spineStart + 0.3; // a cord point
    const nerve = 1.4; // a frond point
    const brain = 2.6; // a note
    for (let p = 0; p <= 1.0001; p += 0.05) {
      expect(regrowReveal(cord, p)).toBeGreaterThanOrEqual(regrowReveal(nerve, p) - 1e-12);
      expect(regrowReveal(nerve, p)).toBeGreaterThanOrEqual(regrowReveal(brain, p) - 1e-12);
    }
    const floor = RENDER_TUNING.states.queryDipTo;
    expect(regrowReveal(brain, 0)).toBeCloseTo(floor, 10);
    expect(regrowReveal(brain, 1)).toBeCloseTo(1, 10);
    // Everything waits at the floor when the wave starts, and nothing is gated outside the regrow or past the growth span.
    expect(regrowReveal(cord, 0)).toBeLessThan(0.2);
    expect(regrowReveal(brain, -1)).toBe(1);
    expect(regrowReveal(REGROW_SPAN + 5, 0.2)).toBe(1);
    // Mid-wave the cord is already bright while the brain still waits.
    expect(regrowReveal(cord, 0.4)).toBeGreaterThan(0.95);
    expect(regrowReveal(brain, 0.4)).toBeLessThan(0.4);
  });
});

describe("render/silhouette: the humanoid transit pose (FIG-40)", () => {
  it("is a pure function of the index with finite, bounded coordinates", () => {
    for (let i = 0; i < 5000; i++) {
      const p = humanoidPoint(i);
      expect(p).toEqual(humanoidPoint(i));
      expect(p.every(Number.isFinite)).toBe(true);
      expect(Math.abs(p[0])).toBeLessThan(3.2);
      expect(p[1]).toBeGreaterThan(-4.6);
      expect(p[1]).toBeLessThan(5);
      expect(Math.abs(p[2])).toBeLessThanOrEqual(RENDER_TUNING.transit.depth + 1e-9);
    }
  });

  it("puts a head ring on top, a torso, and arms and legs on both sides", () => {
    const head: number[] = [];
    let left = 0, right = 0, legsLow = 0, torso = 0;
    const N = 20_000;
    for (let i = 0; i < N; i++) {
      const [x, y] = humanoidPoint(i);
      if (y > 3.1) head.push(Math.hypot(x - 0, y - 4.05));
      if (y < -2) (x < 0 ? left++ : right++, legsLow++);
      if (y > 0.7 && y < 3 && Math.abs(x) < 1.15) torso++;
    }
    // The head: points sit on a ring of radius 0.8 (± its thickness).
    expect(head.length).toBeGreaterThan(N * 0.08);
    const mean = head.reduce((a, b) => a + b, 0) / head.length;
    expect(mean).toBeGreaterThan(0.7);
    expect(mean).toBeLessThan(0.9);
    expect(left).toBeGreaterThan(legsLow * 0.4);
    expect(right).toBeGreaterThan(legsLow * 0.4);
    expect(torso).toBeGreaterThan(N * 0.2);
  });

  it("shares of the parts follow the tuning weights", () => {
    expect(HUMAN_CUMULATIVE.length).toBe(RENDER_TUNING.transit.parts.length);
    expect(HUMAN_CUMULATIVE[HUMAN_CUMULATIVE.length - 1]).toBeCloseTo(1, 10);
    expect(RENDER_TUNING.transit).toMatchObject({ weight: 0.6, tint: 0.12 });
  });
});

describe("render/animation: Spread contracts the body (FIG-64)", () => {
  it("is neutral at 100%", () => {
    expect(scatterTerms(1)).toEqual({ brainScale: 1, cordBright: 1, cordSize: 1, hazeDensity: 1 });
  });

  it("below 100% the cerebrum shrinks and the cord and body field get denser", () => {
    const t = scatterTerms(0.5);
    expect(t.brainScale).toBeCloseTo(0.85 + 0.15 * 0.5, 10);
    expect(t.cordBright).toBeCloseTo(1 + 0.5 * 0.8, 10);
    expect(t.cordSize).toBeCloseTo(1 + 0.5 * 0.5, 10);
    expect(t.hazeDensity).toBeCloseTo(1.5, 10);
  });

  it("above 100% it does the opposite, clamped", () => {
    const t = scatterTerms(1.5);
    expect(t.brainScale).toBeGreaterThan(1);
    expect(t.cordBright).toBeLessThan(1);
    expect(t.cordBright).toBeGreaterThanOrEqual(RENDER_TUNING.spread.brightRange[0]);
    expect(t.cordSize).toBeGreaterThanOrEqual(RENDER_TUNING.spread.sizeRange[0]);
    expect(t.hazeDensity).toBeGreaterThanOrEqual(RENDER_TUNING.spread.hazeRange[0]);
    // Far outside the slider's range the terms stay in their clamps.
    expect(scatterTerms(-10).cordBright).toBeLessThanOrEqual(RENDER_TUNING.spread.brightRange[1]);
    expect(scatterTerms(50).hazeDensity).toBeGreaterThanOrEqual(RENDER_TUNING.spread.hazeRange[0]);
    expect(scatterTerms(Number.NaN)).toEqual(scatterTerms(1));
  });

  it("the haze's body field is the torso's nerve guides and a body kind", () => {
    expect(isBodyFieldKind("nerve")).toBe(true);
    expect(isBodyFieldKind("body")).toBe(true);
    expect(isBodyFieldKind("brain")).toBe(false);
    expect(isBodyFieldKind("thread")).toBe(false);
  });
});

describe("render/layers/points: hover-emphasis groups (CHART-09)", () => {
  it("packs row + 1 and the population, and 0 for no group", () => {
    expect(groupAttr(NO_GROUP, 0)).toBe(0);
    expect(groupAttr(0, 0)).toBe(1);
    expect(groupAttr(4, 0)).toBe(5);
    expect(groupAttr(4, 1)).toBe(((1 << 31) | 5) >>> 0);
    expect(groupAttr(4, 1) >>> 31).toBe(1);
    expect(groupAttr(4, 1) & 0x7fffffff).toBe(5);
    expect(groupAttr(-1, 0)).toBe(0);
  });

  it("writes one word per ordinal and clears the rest", () => {
    const layer = createPointsLayer(6);
    layer.setCount(4);
    layer.writeGroups(new Uint32Array([0, 1, NO_GROUP, 1]), [0, 1, 0, 1]);
    expect(Array.from(layer.attr("aGroup").array.slice(0, 6))).toEqual([1, ((1 << 31) | 2) >>> 0, 0, ((1 << 31) | 2) >>> 0, 0, 0]);
    layer.writeGroups(null, null);
    expect(Array.from(layer.attr("aGroup").array.slice(0, 6))).toEqual([0, 0, 0, 0, 0, 0]);
    layer.dispose();
  });

  it("dims the rest to 35% and lifts the group to 1.6", () => {
    expect(RENDER_TUNING.hover).toMatchObject({ dim: 0.35, boost: 1.6 });
  });
});
