import { describe, expect, it } from "vitest";
import { envelopeHalfWidth, fibreCourse, FIGURE, HAZE_BUDGET, nerveCourse } from "../src/worker/anatomy";
import { frondPath } from "../src/worker/placement";
import { RENDER_TUNING } from "../src/render/tuning";

describe("fibre net", () => {
  it("makes distinct thin variants of a level's course that stay on the torso and leave the same side", () => {
    const a = fibreCourse(10, 1, 0.1, 0.2, 0.3, 0.4);
    const b = fibreCourse(10, 1, 0.9, 0.8, 0.7, 0.6);
    expect(a).not.toBe(b);
    expect(Array.from(a.pts)).not.toEqual(Array.from(b.pts));
    for (const poly of [a, b]) {
      for (let i = 0; i < poly.pts.length; i += 3) {
        const x = poly.pts[i] as number;
        const y = poly.pts[i + 1] as number;
        expect(x).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(x)).toBeLessThanOrEqual(envelopeHalfWidth(y) * FIGURE.nerves.fibres.shell[1] + 1e-6);
        expect(y).toBeGreaterThanOrEqual(FIGURE.cord.floorY - 1e-9);
      }
    }
    // The same numbers give the same (cached) polyline; the other side mirrors to +X.
    expect(fibreCourse(10, 1, 0.1, 0.2, 0.3, 0.4)).toBe(a);
    expect(fibreCourse(10, -1, 0.1, 0.2, 0.3, 0.4).pts[(FIGURE.nerves.steps) * 3] as number).toBeGreaterThanOrEqual(0);
    expect(nerveCourse(10, 1).pts.length).toBe(a.pts.length);
  });

  it("gives conversations of one segment different courses, so they fan out instead of stacking", () => {
    const ends = new Set<string>();
    for (let h = 1; h <= 40; h++) {
      const shape = frondPath(0.5, 1, 400, h * 7919, false);
      const n = shape.poly.pts.length;
      ends.add(`${(shape.poly.pts[n - 3] as number).toFixed(1)}:${(shape.poly.pts[n - 2] as number).toFixed(1)}`);
    }
    expect(ends.size).toBeGreaterThan(10);
  });

  it("budgets every strand of the haze guides", () => {
    const g = FIGURE.nerves.guide;
    expect(FIGURE.nerves.fibres.strands).toBeGreaterThan(1);
    expect(HAZE_BUDGET.nerveGuides).toBeGreaterThanOrEqual(62 * FIGURE.nerves.fibres.strands * (g.base + g.perLength * 2));
  });

  it("keeps the fibre look subtle: pale strands, rare bright specks", () => {
    const f = RENDER_TUNING.fibre;
    expect(f.colourKeep).toBeLessThan(0.8);
    expect(f.size).toBeLessThan(1);
    expect(f.speckShare).toBeGreaterThan(0);
    expect(f.speckShare).toBeLessThan(0.2);
    expect(f.hazeSpeckShare).toBeLessThan(0.2);
  });
});

describe("vertebra beads", () => {
  it("keeps tau in [0, 1), monotonic, with points pulled toward each rung centre", async () => {
    const { beadTau, FIGURE } = await import("../src/worker/anatomy");
    const n = FIGURE.haze.beads.count;
    let prev = -1;
    let near = 0;
    const total = 4000;
    for (let i = 0; i < total; i++) {
      const t = beadTau(i / total);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(1);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
      if (Math.abs((t * n) % 1 - 0.5) < 0.25) near++;
    }
    expect(near / total).toBeGreaterThan(0.6);
  });
});
