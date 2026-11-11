import { describe, expect, it } from "vitest";
import { chartExitAt, fadeShape, MorphFollower, queryFadeAt } from "../src/render/animation";
import { entryStyleFor, relayoutKey } from "../src/render/entryStyle";
import { RENDER_TUNING } from "../src/render/tuning";
import { SHELL } from "../src/ui/breakpoints";
import { shapeMsFor } from "../src/ui/stage/ShapeBar";
import { TurntableCamera } from "../src/render/camera";
import type { ChartSpec } from "../src/shared/protocol/worker";

describe("P06 figure morphs", () => {
  it("morphs take about 0.35 s out, 0.55 s back, 0.25 s chart to chart", () => {
    expect(SHELL.timing.shapeMs).toBe(350);
    expect(SHELL.timing.shapeBackMs).toBe(550);
    expect(shapeMsFor(0, 1)).toBe(350);
    expect(shapeMsFor(1, 0)).toBe(550);
    expect(RENDER_TUNING.shape.formMs).toBe(250);
    expect(RENDER_TUNING.shape.overlayFadeInMs).toBe(120);
    const f = new MorphFollower();
    expect(f.follow(1, 0, false)).toBe("animate");
    expect(f.anim.value(350)).toBe(1);
    expect(f.anim.value(100)).toBeLessThan(1);
    const g = new MorphFollower();
    g.anim.jump(1);
    expect(g.follow(0, 0, false)).toBe("animate");
    expect(g.anim.value(300)).toBeGreaterThan(0);
    expect(g.anim.value(550)).toBe(0);
  });

  it("the group labels flash between morph 0.35 and 0.55 and settle at 0.85", () => {
    expect(SHELL.timing.labelsFlash).toEqual([0.35, 0.55]);
    expect(RENDER_TUNING.shape.labelsAtMorph).toBe(0.85);
  });

  it("a change of Group by fades the body to about nothing over 300 ms, then regrows over 450 ms", () => {
    expect(fadeShape("group")).toEqual({ dipTo: 0.02, dipMs: 300, regrowMs: 450 });
    expect(fadeShape("query")).toEqual({ dipTo: 0.15, dipMs: 150, regrowMs: 300 });
    expect(queryFadeAt(299, "group").dip).toBeCloseTo(0.02, 1);
    expect(queryFadeAt(300, "group")).toEqual({ dip: 1, regrow: 0, done: false });
    expect(queryFadeAt(750, "group").done).toBe(true);
    // The default is still the query's own dip.
    expect(queryFadeAt(149.99).dip).toBeCloseTo(0.15, 3);
  });

  it("a closing chart shrinks while fading, then the points travel home", () => {
    expect(chartExitAt(1)).toBe(0);
    expect(chartExitAt(0.8)).toBeCloseTo(1, 5);
    expect(chartExitAt(0.9)).toBeGreaterThan(0);
    expect(chartExitAt(0.9)).toBeLessThan(1);
    expect(chartExitAt(0.4)).toBeCloseTo(0, 5);
    expect(chartExitAt(0)).toBe(0);
  });

  it("picks an entry style per chart pair", () => {
    expect(entryStyleFor("matrix", "bubble-pack")).toBe(1);
    expect(entryStyleFor("timeline-lanes", "calendar-heatmap")).toBe(2);
    expect(entryStyleFor("calendar-heatmap", "ridgeline")).toBe(3);
    expect(entryStyleFor("ranked-bars", "stream")).toBe(3);
    expect(entryStyleFor("ranked-bars", "treemap")).toBe(0);
    expect(entryStyleFor(null, "ridgeline")).toBe(0);
    expect(entryStyleFor("ridgeline", "ridgeline")).toBe(0);
  });

  it("a folder-tree node or a combined row changes the relayout key; nothing else does", () => {
    const base = { chart: "icicle", x: { dim: "area", sort: "count" }, y: null, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options: {} } as unknown as ChartSpec;
    const open = { ...base, options: { expanded: ["a"] } } as ChartSpec;
    const merged = { ...base, combined: { a: ["b"] } } as unknown as ChartSpec;
    expect(relayoutKey(open)).not.toBe(relayoutKey(base));
    expect(relayoutKey(merged)).not.toBe(relayoutKey(base));
    expect(relayoutKey({ ...base, top: 30 } as ChartSpec)).toBe(relayoutKey(base));
    expect(relayoutKey(null)).toBe("");
  });

  it("returning from a scope dollies back from 0.7 of the home distance in 300 ms", () => {
    expect(RENDER_TUNING.camera.scopeReturnDollyFactor).toBe(0.7);
    expect(RENDER_TUNING.camera.scopeReturnDollyMs).toBe(300);
    const cam = new TurntableCamera(1, "standing");
    const home = cam.framing(0).distance;
    cam.dollyIn(0, RENDER_TUNING.camera.scopeReturnDollyMs, RENDER_TUNING.camera.scopeReturnDollyFactor);
    cam.update(0, 0.016);
    expect(cam.framing(0).distance).toBeCloseTo(home * 0.7, 1);
    cam.update(400, 0.016);
    expect(cam.framing(400).distance).toBeCloseTo(home, 1);
  });
});
