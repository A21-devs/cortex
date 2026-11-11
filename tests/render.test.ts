/**
 * Renderer contracts (owner E10) that run without a GPU: camera defaults and drift around a heading (§6.8),
 * colour-state multipliers (§6.6), line families and hover picking (§6.10), picking that clears to zero on a
 * Paper stage (PICK-CLEAR-PROBE), partial uploads that never go negative (POINTS-TOUCH-NOOP), at most three live
 * renderers (§2.4) and the frame governor (§8.4). The WebGL smoke test lives in tests/smoke/.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { INTRO_SECONDS, INTRO_STAGES, IntroClock, REBUILD_SECONDS } from "../src/render/animation";
import { CAMERA_DEFAULTS, HomeFitCache, TurntableCamera, driftAngles, fitHome, fitStanding, homeAngles, overlayConflict, projectSamples, type FitSamples, type StageGeom } from "../src/render/camera";
import { buildLook } from "../src/render/controller";
import { HAZE_KINDS } from "../src/shared/protocol/worker";
import { hazeColors, hazeIntensities, hazeIntensityOf, isBrainKind } from "../src/render/layers/haze";
import { envelopeHalfWidth, routeSourceLines, sourceSteps } from "../src/render/layers/lines";
import { labelColumnsFor, layoutChips } from "../src/render/overlay";
import { silhouetteFor } from "../src/render/silhouette";
import { HAZE_SLOTS } from "../src/render/shaders";
import { RENDER_TUNING, overlayRects } from "../src/render/tuning";
import { buildAnatomy, FIGURE, HAZE_SUB_INDEX } from "../src/worker/anatomy";
import { FrameGovernor, isSlowFrame, SLOW_WINDOW_MS, WARMUP_MS } from "../src/render/governor";
import { LINE_ALPHA, LINE_FAMILY, nearestSegment } from "../src/render/layers/lines";
import { createPointsLayer } from "../src/render/layers/points";
import { decodeIdRgba8, encodeIdRgba8, withPickClear } from "../src/render/picking";
import { createRendererPool, HIDDEN_RELEASE_MS, LruPool, MAX_LIVE } from "../src/render/rendererPool";
import { SCOPE_TIMING, STATE_ALPHA } from "../src/render/shaders";

describe("render/camera (§6.8)", () => {
  it("uses the UX camera and drifts around the current heading", () => {
    expect(CAMERA_DEFAULTS.fovDeg).toBe(30);
    expect(CAMERA_DEFAULTS.homeLying).toEqual({ yawDeg: 11, pitchDeg: -8 });
    expect(CAMERA_DEFAULTS.uprightYawDeg).toBe(50);
    expect(CAMERA_DEFAULTS.uprightPitchDeg).toBe(30);
    expect(driftAngles(0, 1).yawDeg).toBeCloseTo(11);
    expect(driftAngles(3, 1).yawDeg).toBeCloseTo(11 + 26);
    expect(driftAngles(1.5, 2).yawDeg).toBeCloseTo(11 + 26);
    expect(driftAngles(3, 1, 70).yawDeg).toBeCloseTo(96);
  });
});

describe("render/shaders and animation (§6.6, §6.7)", () => {
  it("dims by the UX multipliers and times the intro and scope turn", () => {
    expect(STATE_ALPHA.selectedOthers).toBe(0.06);
    expect(STATE_ALPHA.hazeWhileSelected).toBe(0.35);
    expect(STATE_ALPHA.tracedOthers).toBe(0.12);
    expect(STATE_ALPHA.hazeWhileTraced).toBe(0.5);
    expect(STATE_ALPHA.hazeWhileKeyed).toBeGreaterThan(1);
    expect(STATE_ALPHA.previewOthers).toBe(0.35);
    expect(STATE_ALPHA.scopeSink).toBe(0.25);
    expect(SCOPE_TIMING).toMatchObject({ turnMs: 600, sinkFadeMs: 300, riseMs: 400 });
    expect(INTRO_SECONDS).toBe(3.6);
    expect(REBUILD_SECONDS).toBe(0.9);
    expect(INTRO_STAGES.length).toBe(6);
  });
});

describe("render/layers/lines (§6.10)", () => {
  it("has four families and picks the nearest projected segment for hover names", () => {
    expect(Object.keys(LINE_FAMILY)).toEqual(["Source", "Stem", "Spoke", "Link"]);
    expect(LINE_ALPHA[LINE_FAMILY.Stem]).toBe(0.1);
    const screen = new Float32Array([0, 0, 100, 0, 0, 50, 100, 50]);
    expect(nearestSegment(screen, 50, 2)).toBe(0);
    expect(nearestSegment(screen, 50, 48)).toBe(1);
    expect(nearestSegment(screen, 50, 25)).toBe(-1);
  });
});

describe("render/picking (PICK-CLEAR-PROBE)", () => {
  it("clears the id target to zero for the pick pass and restores the stage colour", () => {
    const calls: unknown[] = [];
    const r = {
      getClearColor: (t: { r: number; g: number; b: number }) => Object.assign(t, { r: 0.96, g: 0.95, b: 0.93 }),
      getClearAlpha: () => 1,
      setClearColor: (c: unknown, a?: number) => calls.push([c, a]),
    };
    withPickClear(r, () => calls.push("pick"));
    expect(calls[0]).toEqual([0x000000, 0]);
    expect(calls[1]).toBe("pick");
    expect(calls[2]).toEqual([{ r: 0.96, g: 0.95, b: 0.93 }, 1]);
    expect(decodeIdRgba8(...encodeIdRgba8(123456))).toBe(123456);
    expect(decodeIdRgba8(244, 242, 238, 0)).toBe(0);
  });
});

describe("render/layers/points (POINTS-TOUCH-NOOP)", () => {
  it("clamps partial uploads to the live range", () => {
    const layer = createPointsLayer(10);
    layer.count = 4;
    layer.touch("aAnat", 2, 100);
    const pos = layer.attr("aAnat");
    const ranges = (pos as unknown as { updateRanges: { start: number; count: number }[] }).updateRanges;
    for (const r of ranges) {
      expect(r.start).toBeGreaterThanOrEqual(0);
      expect(r.count).toBeGreaterThan(0);
      expect(r.start + r.count).toBeLessThanOrEqual(10 * pos.itemSize);
    }
    layer.touch("aAnat", 8, 5);
    layer.dispose();
  });
});

describe("render/rendererPool and governor (§2.4, §8.4)", () => {
  it("keeps at most three live renderers and lowers detail after 2 s of slow frames", () => {
    const pool = new LruPool(MAX_LIVE);
    expect(pool.acquire("a")).toBeNull();
    expect(pool.acquire("b")).toBeNull();
    expect(pool.acquire("c")).toBeNull();
    expect(pool.acquire("d")).toBe("a");
    expect(pool.acquire("b")).toBeNull();
    expect(pool.liveIds()).toEqual(["c", "d", "b"]);
    pool.setHidden("c", true, 0);
    expect(pool.dueForRelease(60_000)).toEqual(["c"]);
    // A 60 Hz display that then falls behind: after the warm-up, 2 s of 30 ms frames lower detail one step.
    const g = new FrameGovernor();
    let t = 0;
    for (; t < WARMUP_MS + 500; t += 16.7) expect(g.frame(t, 16.7)).toBeNull();
    expect(g.frame(t, 30)).toBeNull();
    expect(g.frame(t + SLOW_WINDOW_MS + 1, 30)).toBe(1);
    expect(g.frame(t + SLOW_WINDOW_MS + 2, 10)).toBeNull();
  });

  it("brings a leaf released after 60 s hidden back to life when it is shown again", () => {
    let t = 0;
    const pending: Array<() => void> = [];
    const pool = createRendererPool(() => t, MAX_LIVE, { setTimeout: (fn) => (pending.push(fn), pending.length), clearTimeout: () => undefined });
    const seen: string[] = [];
    pool.onChange("a", (s) => seen.push(s));
    pool.request("a");
    pool.setVisible("a", false);
    t = HIDDEN_RELEASE_MS + 1;
    pool.sweep(t);
    expect(seen).toEqual(["live", "released"]);
    expect(pool.isLive("a")).toBe(false);
    pool.setVisible("a", true);
    expect(seen).toEqual(["live", "released", "live"]);
    expect(pool.isLive("a")).toBe(true);
    // A leaf pushed out while visible (more than three live) stays on its still until clicked.
    const seenB: string[] = [];
    for (const id of ["b", "c", "d"]) pool.request(id);
    pool.onChange("a", (s) => seenB.push(s));
    pool.request("e");
    pool.setVisible("a", false);
    pool.setVisible("a", true);
    expect(seenB).toEqual([]);
    pool.dispose();
  });

  it("never counts a 30 Hz display, a capped unfocused leaf or the warm-up as slow", () => {
    const run = (dt: number, floor: number, seconds: number): number => {
      const g = new FrameGovernor();
      let steps = 0;
      for (let t = 0; t < seconds * 1000; t += dt) if (g.frame(t, dt, floor) !== null) steps++;
      return steps;
    };
    expect(run(33.3, 0, 20)).toBe(0); // 30 Hz screen
    expect(run(33.3, 1000 / 30, 20)).toBe(0); // unfocused leaf capped at 30 fps
    expect(run(41.7, 0, 20)).toBe(0); // 24 Hz screen
    // Start-up jank inside the warm-up never counts, even when long enough to fill the slow window.
    const g = new FrameGovernor();
    let t = 0;
    for (; t < 1000; t += 16.7) g.frame(t, 16.7);
    g.interrupt(); // e.g. a new placement
    for (const end = t + WARMUP_MS - 1; t < end; t += 60) expect(g.frame(t, 60)).toBeNull();
    // A real slowdown after the warm-up still lowers detail: 50 ms frames for over 2 s.
    let stepped: number | null = null;
    for (const end = t + SLOW_WINDOW_MS + 200; t < end && stepped === null; t += 50) stepped = g.frame(t, 50);
    expect(stepped).toBe(1);
  });

  it("never lowers detail for slowness that overlaps main-thread long tasks, but does for a GPU that can't keep up", () => {
    const slowRun = (busy: (t: number) => number): number | null => {
      const g = new FrameGovernor();
      let t = 0;
      for (; t < WARMUP_MS + 500; t += 16.7) g.frame(t, 16.7);
      let stepped: number | null = null;
      for (const end = t + 3 * SLOW_WINDOW_MS; t < end && stepped === null; t += 80) stepped = g.frame(t, 80, 0, busy(t));
      return stepped;
    };
    // Page work: a long task ends every 400 ms (reported a frame late), so no 2 s streak free of it ever forms.
    expect(slowRun((t) => Math.floor((t - 80) / 400) * 400)).toBeNull();
    // GPU-bound: the same 80 ms frames with no long tasks lower detail one step.
    expect(slowRun(() => Number.NEGATIVE_INFINITY)).toBe(1);
  });

  it("restarts the warm-up after a long stall, so loading work never lowers detail", () => {
    // Start-up pattern seen live: 0.4-0.5 s stalls while the index and sample load, with 50-200 ms frames between.
    const g = new FrameGovernor();
    let t = 0;
    for (; t < 1000; t += 16.7) g.frame(t, 16.7);
    for (let k = 0; k < 12; k++) {
      t += 450;
      expect(g.frame(t, 450)).toBeNull();
      for (let i = 0; i < 20; i++) expect(g.frame((t += 120), 120)).toBeNull();
    }
  });

  it("isSlowFrame uses the display cadence and the leaf cap, never below 22 ms", () => {
    expect(isSlowFrame(30, 16.7)).toBe(true);
    expect(isSlowFrame(20, 16.7)).toBe(false);
    expect(isSlowFrame(33.3, 33.3)).toBe(false);
    expect(isSlowFrame(45, 33.3)).toBe(true); // over 1.5 × the 28 ms cadence cap
    expect(isSlowFrame(45, 16.7, 1000 / 30)).toBe(false); // the cap's 50 ms line
    expect(isSlowFrame(23, null)).toBe(true);
  });
});

// ───────────────────────────── the standing figure (CORTEX-UX §3.2, §6.2, §6.7, §6.8) ─────────────────────────────

/** A coarse standing figure from the §6.2 key heights and envelope: brain dome, cord, ribs, cauda fan, cloud. */
function standingSamples(): FitSamples {
  const F = RENDER_TUNING.figure;
  const pts: number[] = [];
  const add = (x: number, y: number, z: number): void => void pts.push(x, y, z);
  for (let a = 0; a <= 180; a += 6) {
    for (let b = 0; b < 360; b += 30) {
      const ar = (a * Math.PI) / 180, br = (b * Math.PI) / 180;
      add(Math.cos(ar) * 1.42 * Math.cos(br), 4 + Math.sin(ar) * 1.0, 0.06 + 0.48 * Math.cos(br));
    }
  }
  add(0, F.crownY, 0);
  for (let y = F.brainstemTopY; y >= F.cordTipY; y -= 0.1) add(0, y, 0.37 * Math.sin(y));
  for (let y = 2.6; y >= F.lowestNerveY; y -= 0.1) {
    const w = envelopeHalfWidth(y);
    add(-w, y, 0.4 * w);
    add(w, y, 0.4 * w);
  }
  for (let k = 0; k < 40; k++) add(Math.sin(k * 3.7) * 0.9, F.undatedLowY + Math.abs(Math.sin(k * 1.3)) * 0.3, 0);
  add(0, F.undatedLowY, 0);
  return { pos: new Float32Array(pts), count: pts.length / 3 };
}

const REF_STAGE: StageGeom = { width: 1176, height: 825, insetLeft: 0, insetRight: 0, breakpoint: "XL" };

describe("render/tuning: the standing figure's numbers live in one object", () => {
  it("is Standing and Spin first, aimed at the cord, with the home heading 154 and elevation 9 degrees", () => {
    const P = RENDER_TUNING.poses;
    expect(P.standing.home).toEqual({ yawDeg: -154, pitchDeg: -9 });
    expect(P.standing.aim).toEqual([0, 0.3, -0.2]);
    expect(P.standing.defaultMotion).toBe("spin");
    expect(P.lying.defaultMotion).toBe("drift");
    expect(RENDER_TUNING.frame.standing).toMatchObject({ topFrac: 0.09, bottomClearPx: 68, overlayGapPx: 8, slideStepPx: 6, maxSlidePx: 36, shrinkStep: 0.02 });
    expect(RENDER_TUNING.figure).toMatchObject({ crownY: 5, cordTipY: -4.02, lowestNerveY: -4.32, undatedLowY: -4.36 });
    expect(RENDER_TUNING.motion.spinPeriodSec).toBe(16);
    expect(RENDER_TUNING.motion.driftPeriodSec).toBe(12);
  });

  it("reads the default pose from the shared settings, not from the renderer", () => {
    const pose = DEFAULT_SETTINGS.general.pose;
    expect(homeAngles(pose)).toEqual(RENDER_TUNING.poses[pose].home);
    const cam = new TurntableCamera(1);
    expect(cam.motion().mode).toBe(RENDER_TUNING.poses[pose].defaultMotion);
    expect(new TurntableCamera(1, "standing").motion().mode).toBe("spin");
    expect(new TurntableCamera(1, "lying").motion().mode).toBe("drift");
    expect(homeAngles("lying")).toEqual({ yawDeg: 11, pitchDeg: -8 });
  });
});

describe("render/camera: standing home view and framing (§3.2, §6.8)", () => {
  it("fits by height: the crown near 9% of the stage, the lowest point 8+ px above the command line, clear of overlays", () => {
    const s = standingSamples();
    const f = fitHome("standing", s, REF_STAGE);
    expect(f.yawDeg).toBe(-154);
    expect(f.pitchDeg).toBe(-9);
    const p = projectSamples(s, f, REF_STAGE);
    let top = Infinity, bottom = -Infinity;
    for (let i = 0; i < p.n; i++) {
      top = Math.min(top, p.y[i] as number);
      bottom = Math.max(bottom, p.y[i] as number);
    }
    expect(top / REF_STAGE.height).toBeGreaterThan(0.08);
    expect(top / REF_STAGE.height).toBeLessThan(0.12);
    const commandLineTop = overlayRects("XL", REF_STAGE.width, REF_STAGE.height).find((r) => r.name === "command line")?.y0 as number;
    expect(bottom).toBeLessThanOrEqual(commandLineTop - 8);
    expect(overlayConflict(s, f, REF_STAGE)).toBeNull();
  });

  it("Cortex Desktop's chrome has its own overlay set: the old command line no longer shrinks the standing fit", () => {
    const names = overlayRects("XL", REF_STAGE.width, REF_STAGE.height, true).map((r) => r.name);
    expect(names).toEqual(["cluster", "legend", "histogram"]);
    expect(overlayRects("Mini", REF_STAGE.width, REF_STAGE.height, true)).toEqual([]);
    const s = standingSamples();
    const desk: StageGeom = { ...REF_STAGE, desktop: true };
    const f = fitHome("standing", s, desk);
    const p = projectSamples(s, f, desk);
    let top = Infinity, bottom = -Infinity;
    for (let i = 0; i < p.n; i++) {
      top = Math.min(top, p.y[i] as number);
      bottom = Math.max(bottom, p.y[i] as number);
    }
    // Full height: crown at topFrac, lowest point bottomClearPx above the stage bottom (no shrink steps).
    expect(top / REF_STAGE.height).toBeCloseTo(RENDER_TUNING.frame.standing.topFrac, 2);
    expect(bottom).toBeGreaterThan(REF_STAGE.height - RENDER_TUNING.frame.standing.bottomClearPx - 4);
  });

  it("Mini fits the brain only: closer than the whole figure, aimed at the brain, filling the small stage", () => {
    const s = standingSamples();
    const mini: StageGeom = { width: 420, height: 320, insetLeft: 0, insetRight: 0, breakpoint: "Mini" };
    const f = fitHome("standing", s, mini);
    const whole = fitStanding(s, mini);
    expect(f.target[1]).toBeGreaterThan(RENDER_TUNING.frame.mini.brainBaseY);
    expect(f.distance).toBeLessThan(whole.distance);
    const p = projectSamples(s, f, mini);
    let top = Infinity;
    for (let i = 0; i < p.n; i++) if (((s.pos[i * 3 + 1] as number) >= RENDER_TUNING.frame.mini.brainBaseY)) top = Math.min(top, p.y[i] as number);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it("slides away from an overlay along x (6 px steps, up to 36 px) before it shrinks", () => {
    // A narrow brain: the key bar is only just touched, so sliding alone clears it and the crown stays at 9%.
    const F = RENDER_TUNING.figure;
    const pts: number[] = [0, F.crownY, 0, 0, F.undatedLowY, 0, -3, 0, 0, 3, 0, 0];
    for (let a = 0; a <= 180; a += 10) pts.push(Math.cos((a * Math.PI) / 180) * 0.62, 4 + Math.sin((a * Math.PI) / 180), 0);
    const s: FitSamples = { pos: new Float32Array(pts), count: pts.length / 3 };
    const free = fitStanding(s, { ...REF_STAGE, breakpoint: "Mini" });
    const f = fitStanding(s, REF_STAGE);
    expect(overlayConflict(s, f, REF_STAGE)).toBeNull();
    const slide = f.shiftX - free.shiftX;
    expect(Math.abs(slide)).toBeGreaterThan(0);
    expect(Math.abs(slide)).toBeLessThanOrEqual(RENDER_TUNING.frame.standing.maxSlidePx + 0.01);
    expect(Math.abs(slide) % RENDER_TUNING.frame.standing.slideStepPx).toBeLessThan(0.01);
    expect(Math.abs(f.distance - free.distance)).toBeLessThan(0.01);
  });

  it("stays clear of every overlay on other stage sizes (slide first, then shrink)", () => {
    const s = standingSamples();
    const stages: StageGeom[] = [
      { ...REF_STAGE, width: 776 },
      { ...REF_STAGE, width: 1576 },
      { width: 900, height: 600, insetLeft: 0, insetRight: 0, breakpoint: "L" },
      { width: 700, height: 520, insetLeft: 0, insetRight: 0, breakpoint: "M" },
    ];
    for (const g of stages) {
      const f = fitStanding(s, g);
      expect(overlayConflict(s, f, g)).toBeNull();
    }
  });

  it("spins 360 degrees in 16 s about the vertical axis and sways when kept upright", () => {
    const cam = new TurntableCamera(1, "standing");
    cam.setMotion("spin", 1);
    for (let i = 0; i < 160; i++) cam.update(i * 50, 0.05);
    expect(cam.framing(8_000).yawDeg - -154).toBeCloseTo(180, -1);
    const up = new TurntableCamera(1, "standing");
    up.setMotion("spin", 1);
    up.setKeepUpright(true);
    let maxYaw = 0;
    let maxPitch = 0;
    for (let i = 0; i < 1200; i++) {
      up.update(i * 50, 0.05);
      const h = up.heading(i * 50);
      maxYaw = Math.max(maxYaw, Math.abs(h.yawDeg - h.headingDeg));
      maxPitch = Math.max(maxPitch, Math.abs(h.pitchDeg + 9));
    }
    expect(maxYaw).toBeLessThanOrEqual(26.01);
    expect(maxYaw).toBeGreaterThan(20);
    expect(maxPitch).toBeLessThan(0.01);
  });
});

describe("render/camera: HomeFitCache (the layout event that changes nothing does not refit)", () => {
  const samples = (): FitSamples => standingSamples();
  const geom = { ...REF_STAGE };
  it("computes once per pose, samples and stage, and again when any of them changes", () => {
    const cache = new HomeFitCache();
    const s = samples();
    const a = cache.get("standing", s, geom);
    expect(cache.get("standing", s, { ...geom })).toBe(a);
    expect(cache.computed).toBe(1);
    cache.get("standing", s, { ...geom, width: 900 });
    cache.get("standing", s, { ...geom, width: 900, insetRight: 300 });
    cache.get("lying", s, { ...geom, width: 900, insetRight: 300 });
    cache.get("lying", samples(), { ...geom, width: 900, insetRight: 300 });
    cache.get("lying", samples(), { ...geom, width: 900, insetRight: 300, immersive: true });
    expect(cache.computed).toBe(6);
  });
  it("keeps a few stages, so a panel that opens and closes toggles between two fits without recomputing", () => {
    const cache = new HomeFitCache();
    const s = samples();
    const open = { ...geom, insetRight: 300 };
    for (let i = 0; i < 3; i++) {
      cache.get("standing", s, geom);
      cache.get("standing", s, open);
    }
    expect(cache.computed).toBe(2);
  });
  it("returns what the fit returns", () => {
    const s = samples();
    expect(new HomeFitCache().get("lying", s, geom)).toEqual(fitHome("lying", s, geom));
  });
});

describe("growth timing: the brain appears at about 1.8-2.3 s, after the cord and the nerves (recordings A, B, E)", () => {
  const tm = FIGURE.timing;
  it("the worker's birth windows agree with the tuning stages", () => {
    const at = Object.fromEntries(INTRO_STAGES.map((s) => [s.name, s]));
    expect(tm.introSec).toBe(RENDER_TUNING.growth.introSec);
    expect(tm.spine.start).toBe(RENDER_TUNING.growth.spineStart);
    expect(tm.spine.span).toBe(RENDER_TUNING.growth.spineSpan);
    expect(tm.spine.start + tm.spine.span).toBeCloseTo(at.spine!.to, 5);
    expect(tm.bloom.start).toBeGreaterThanOrEqual(at.bloom!.from);
    expect(tm.bloom.start + tm.bloom.span).toBeLessThanOrEqual(at.bloom!.to);
    expect(tm.bloom.start).toBeGreaterThanOrEqual(1.8);
    expect(tm.bloom.start).toBeLessThanOrEqual(2.3);
    expect(tm.anatomyHaze[0]).toBeGreaterThanOrEqual(1.8);
    expect(tm.undated.start + tm.undated.span).toBeLessThanOrEqual(tm.bloom.start);
  });
  it("no brain haze point is born before 1.8 s and the cord and nerves are born first", () => {
    const a = buildAnatomy(7, 20_000);
    let brainFirst = Infinity;
    let cordLast = 0;
    let nerveFirst = Infinity;
    for (let i = 0; i < a.haze.count; i++) {
      const sub = a.haze.sub[i] as number;
      const b = a.haze.birth[i] as number;
      if (sub === HAZE_SUB_INDEX.brainFolds || sub === HAZE_SUB_INDEX.brainVolume || sub === HAZE_SUB_INDEX.cerebellum || sub === HAZE_SUB_INDEX.brainLips) brainFirst = Math.min(brainFirst, b);
      else if (sub === HAZE_SUB_INDEX.thread) cordLast = Math.max(cordLast, b);
      else if (sub === HAZE_SUB_INDEX.nerve) nerveFirst = Math.min(nerveFirst, b);
    }
    expect(brainFirst).toBeGreaterThanOrEqual(1.8);
    expect(cordLast).toBeLessThanOrEqual(tm.spine.start + tm.spine.span + 1e-6);
    expect(nerveFirst).toBeLessThan(brainFirst);
  });
});

describe("render/animation: growth order (CORTEX-UX 6.7)", () => {
  it("grows the cord first, then the nerves, then the brain, and eases the spin in from Settle", () => {
    const names = INTRO_STAGES.map((s) => s.name) as string[];
    expect(names.indexOf("spine")).toBeLessThan(names.indexOf("fronds"));
    expect(names.indexOf("fronds")).toBeLessThan(names.indexOf("bloom"));
    const at = Object.fromEntries(INTRO_STAGES.map((s) => [s.name, s]));
    expect(at.spine).toMatchObject({ from: 0.25, to: 0.95 });
    expect(at.fronds).toMatchObject({ from: 0.55, to: 1.8 });
    expect(at.body).toMatchObject({ from: 1.0, to: 1.8 });
    expect(at.bloom).toMatchObject({ from: 1.8, to: 3.0 });
    expect(at.settle).toMatchObject({ from: 2.9, to: 3.6 });
    expect(RENDER_TUNING.growth.frondDelaySec).toBe(0.08);
    const c = new IntroClock();
    c.play("intro", 0, false);
    // The turntable is already turning on the first frame (0.2) and at full speed 0.5 s in.
    expect(c.motionEase(0)).toBeCloseTo(0.2, 5);
    expect(c.motionEase(250)).toBeCloseTo(0.6, 5);
    expect(c.motionEase(500)).toBe(1);
    expect(c.motionEase(2_000)).toBe(1);
  });
});

describe("render/layers/lines: source lines arc outside the torso (CORTEX-UX 6.10)", () => {
  it("routes a chord through a control point at 2 w(y) + 0.2 on the entry's side and never crosses the cord", () => {
    expect(envelopeHalfWidth(1.5)).toBeCloseTo(2.3, 1);
    expect(envelopeHalfWidth(-1.4)).toBeCloseTo(2.25, 1);
    const chords = new Float32Array([0, 4, 0, 1.5, -1, 0.1, 0.2, 4, 0, -1.2, -3, 0.1]);
    const r = routeSourceLines(chords, new Float32Array([0, 1, 0, 1]), 2);
    expect(r.segments).toBe(2 * r.steps);
    expect(r.steps).toBeGreaterThanOrEqual(RENDER_TUNING.lines.minSteps);
    const mid = Math.floor(r.steps / 2) * 6;
    for (let s = 0; s < r.steps; s++) {
      const y = r.positions[s * 6 + 1] as number;
      if (y < 2.7) expect(r.positions[s * 6] as number).toBeGreaterThan(0);
    }
    expect(r.positions[mid] as number).toBeGreaterThan(envelopeHalfWidth(r.positions[mid + 1] as number));
    const base = r.steps * 6;
    expect(r.positions[base + mid] as number).toBeLessThan(0);
    expect(sourceSteps(60_000)).toBe(RENDER_TUNING.lines.minSteps);
    expect(sourceSteps(10)).toBe(RENDER_TUNING.lines.maxSteps);
  });
});

describe("render/overlay: two label columns beside the brain (CORTEX-UX 6.11)", () => {
  it("puts each chip in the column on its anchor's side, at its anchor's height", () => {
    const cols = labelColumnsFor(500, 700);
    const bounds = { x0: 0, y0: 0, x1: 1200, y1: 800 };
    const chips = [
      { key: "l", ax: 520, ay: 200, w: 120, h: 21, priority: 2 },
      { key: "r", ax: 680, ay: 300, w: 120, h: 21, priority: 1 },
    ];
    const out = layoutChips(chips, bounds, [], cols);
    const l = out.find((c) => c.key === "l") as (typeof out)[number];
    const r = out.find((c) => c.key === "r") as (typeof out)[number];
    expect(l.x + l.w).toBeLessThanOrEqual(cols.leftX + 0.01);
    expect(r.x).toBeGreaterThanOrEqual(cols.rightX - 0.01);
    expect(l.y + l.h / 2).toBeCloseTo(200, 0);
    expect(r.y + r.h / 2).toBeCloseTo(300, 0);
  });
});

describe("render/layers/haze: kinds by name (CORTEX-UX 6.5, 12.6)", () => {
  it("looks up intensities by kind name and treats the brain kinds alike", () => {
    expect(hazeIntensityOf("thread")).toBe(0.9);
    expect(hazeIntensityOf("brainstem")).toBe(0.55);
    expect(hazeIntensityOf("not-a-kind")).toBeGreaterThan(0);
    expect(isBrainKind("brain")).toBe(true);
    expect(isBrainKind("cerebellum")).toBe(true);
    expect(isBrainKind("nerve")).toBe(false);
    expect(hazeIntensities().length).toBe(HAZE_SLOTS);
  });
});

describe("render/controller buildLook and render/silhouette", () => {
  it("classifies notes, maps, fronds, cord entries and the undated cloud", () => {
    const NONE32 = 0xffffffff;
    const NONE8 = 0xff;
    const index = {
      count: 5,
      cols: {
        pop: new Uint8Array([0, 0, 1, 1, 1]),
        hubType: new Uint8Array([NONE8, 2, NONE8, NONE8, NONE8]),
        conv: new Uint32Array([NONE32, NONE32, 0, NONE32, NONE32]),
        idx: new Uint32Array([NONE32, NONE32, 1, NONE32, NONE32]),
      },
      convs: { size: 1, get: () => ({ entryCount: 3 }), rowOf: () => 0 },
    } as unknown as Parameters<typeof buildLook>[0];
    const look = buildLook(index, new Float32Array([NaN, NaN, 0.5, 0.4, NaN]), 5);
    expect(Array.from(look.kind)).toEqual([2, 3, 0, 1, 4]);
    expect(look.intensity[3]).toBe(RENDER_TUNING.intensity.cord);
    expect(look.intensity[4]).toBeCloseTo(RENDER_TUNING.intensity.undated, 5);
    expect(look.intensity[2]).toBeGreaterThan(0.3);
    expect(look.intensity[2]).toBeLessThan(0.7);
  });

  it("draws a data-URI silhouette per stage and pose", () => {
    const a = silhouetteFor("ink");
    expect(a.startsWith("data:image/svg+xml")).toBe(true);
    expect(silhouetteFor("paper")).not.toBe(a);
    expect(silhouetteFor("ink", "lying")).not.toBe(a);
    expect(silhouetteFor("ink")).toBe(a);
  });
});

describe("render/layers/haze: the cord thread takes the spine's colours", () => {
  const thread = HAZE_KINDS.indexOf("thread");
  const nerve = HAZE_KINDS.indexOf("nerve");
  const base = {
    pos: new Float32Array(9),
    kind: new Uint8Array([thread, thread, nerve]),
    count: 3,
    notePos: new Float32Array(0),
    noteRgb: new Uint8Array(0),
    noteCount: 0,
    mist: [182, 187, 211] as const,
    tint: null,
    oldest: [150, 120, 230] as const,
    undated: [114, 123, 138] as const,
  };
  it("colours each bead from the spine colour of its stretch, lifted a little, and leaves other kinds on the mist", () => {
    // Two stretches: the first red, the second green.
    const spine = new Uint8Array([255, 0, 0, 0, 255, 0]);
    const out = hazeColors({ ...base, age: new Float32Array([0.1, 0.9, 0.5]), spine });
    expect(out[0]).toBeGreaterThan(out[1] as number);
    expect(out[5]).toBeGreaterThan(out[4] as number);
    expect(out[5]).toBeGreaterThan(out[1] as number);
    const mist = hazeColors({ ...base, age: null, spine: null });
    expect([out[8], out[9], out[10]]).toEqual([mist[8], mist[9], mist[10]]);
    expect([mist[0], mist[1], mist[2]]).toEqual([mist[8], mist[9], mist[10]]);
  });
  it("pushes a pastel spine colour away from its grey so the cord keeps saturated runs", () => {
    const spine = new Uint8Array([150, 200, 170, 150, 200, 170]);
    const out = hazeColors({ ...base, age: new Float32Array([0.1, 0.9, 0.5]), spine });
    // Green stays the dominant channel and its lead over red grows past the plain colour's lead.
    expect((out[1] as number) - (out[0] as number)).toBeGreaterThan(50);
    expect(out[1]).toBeGreaterThan(out[2] as number);
  });
});
