/**
 * Live finding: with the sample record showing, the time strip read "0 entries · 0 notes". A fresh leaf has
 * revealedCount 0 ("nothing is held"), and the stats/search visibility treated 0 as "nothing is revealed".
 */
import { describe, expect, it } from "vitest";
import { visibilityParams } from "../src/state/selectors";
import { createLeafStore } from "../src/state/store";
import { buildSampleIndex } from "../src/worker/sampleIndex";
import { computeStats } from "../src/worker/stats";
import { makeVisibility } from "../src/worker/search";

describe("a fresh leaf (revealedCount 0) sees the whole sample record", () => {
  const index = buildSampleIndex(20261110, Date.UTC(2026, 10, 10));
  const store = createLeafStore();
  const vis = { ...visibilityParams(store.get("ui"), store.get("view")), period: null };

  it("starts with nothing held", () => {
    expect(vis.revealedCount).toBe(0);
  });

  it("counts entries and notes on the strip", () => {
    const res = computeStats(index, { kind: "strip", bin: "auto", notesLane: true, ageColour: false, visibility: vis }, { now: Date.UTC(2026, 10, 10) });
    if (res.kind !== "strip") throw new Error("not a strip");
    const entries = res.bins.reduce((n, b) => n + b.entries, 0);
    const notes = res.bins.reduce((n, b) => n + b.notes, 0);
    expect(entries).toBeGreaterThan(1000);
    expect(notes).toBeGreaterThan(100);
  });

  it("still holds back arrivals past an explicit revealedCount", () => {
    const res = computeStats(index, { kind: "strip", bin: "auto", notesLane: true, ageColour: false, visibility: { ...vis, revealedCount: 10 } }, { now: Date.UTC(2026, 10, 10) });
    if (res.kind !== "strip") throw new Error("not a strip");
    expect(res.bins.reduce((n, b) => n + b.entries + b.notes, 0)).toBeLessThanOrEqual(10);
  });

  it("search honours the same rule", () => {
    const shown = makeVisibility(index, vis);
    expect(shown(0)).toBe(true);
    expect(shown(index.count - 1)).toBe(true);
    expect(makeVisibility(index, { ...vis, revealedCount: 10 })(10)).toBe(false);
  });
});

describe("the first-run card", () => {
  it("never covers the sample record", async () => {
    const { firstRunCardShown } = await import("../src/ui/stage/Stage");
    expect(firstRunCardShown("ready", false, true)).toBe(false);
    expect(firstRunCardShown("empty", true, false)).toBe(true);
    expect(firstRunCardShown("ready", false, false)).toBe(true);
    expect(firstRunCardShown("ready", true, false)).toBe(false);
  });
});

describe("the camera numbers have one source", () => {
  it("renderer tuning and the figure's camera read the same object", async () => {
    const { CAMERA_NUMBERS } = await import("../src/shared/cameraNumbers");
    const { RENDER_TUNING } = await import("../src/render/tuning");
    const { FIGURE } = await import("../src/worker/anatomy");
    expect(RENDER_TUNING.camera.fovDeg).toBe(CAMERA_NUMBERS.fovDeg);
    expect(FIGURE.camera.fovDeg).toBe(CAMERA_NUMBERS.fovDeg);
    expect(RENDER_TUNING.motion.spinPeriodSec).toBe(FIGURE.camera.spinPeriodSec);
    expect(RENDER_TUNING.motion.swayYawAmpDeg).toBe(FIGURE.camera.swayDeg);
  });
});

describe("nerve guides fade from root to tip", () => {
  it("scales a nerve point by its distance from the cord and leaves other haze alone", async () => {
    const { restScale } = await import("../src/render/layers/haze");
    const { HAZE_KINDS } = await import("../src/shared/protocol/worker");
    const nerve = HAZE_KINDS.indexOf("nerve");
    const brain = HAZE_KINDS.indexOf("brain");
    expect(restScale(nerve, 0, 0)).toBeCloseTo(0.2 / 0.13, 5);
    expect(restScale(nerve, 3, 0)).toBeCloseTo(0.08 / 0.13, 5);
    expect(restScale(nerve, 0.9, 0)).toBeGreaterThan(restScale(nerve, 1.6, 0));
    expect(restScale(brain, 5, 5)).toBe(1);
  });
});

describe("the period preview", () => {
  it("reads the strip's hover key", async () => {
    const { parsePeriodPreview } = await import("../src/render/controller");
    expect(parsePeriodPreview("1699779741330-1700384541330")).toEqual([1699779741330, 1700384541330]);
    expect(parsePeriodPreview("9-3")).toBeNull();
    expect(parsePeriodPreview("code")).toBeNull();
  });
});
