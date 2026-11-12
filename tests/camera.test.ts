/**
 * P03 camera feel: orbit inertia, the opening dolly, the group-change flight, canvas cursors and the instant restore
 * flag. Pure maths first, then the TurntableCamera behaviour built on it (no GPU needed).
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  FLAT_CHART_MOTION_SCALE,
  fitFrame,
  flatChartRect,
  fitSphere,
  safeRect,
  TurntableCamera,
  arrangementAngles,
  coastDone,
  coastStep,
  dollyDistance,
  groupFlightPlan,
  releaseVelocity,
  sameFit,
  type Framing,
  type OrbitSample,
} from "../src/render/camera";
import { canvasCursor, chartZoomedPastGiveWay } from "../src/render/cursor";
import { RENDER_TUNING } from "../src/render/tuning";
import { INSTANT_RESTORE_TTL_MS, consumeInstantRestore, markInstantRestore, resetInstantRestore } from "../src/state/instantRestore";
import { GIVE_WAY } from "../src/shared/chartZoom";

const T = RENDER_TUNING;

function camera(reduced = false): TurntableCamera {
  const c = new TurntableCamera(1.6, "lying");
  c.setStage({ width: 800, height: 500, insetLeft: 0, insetRight: 0, breakpoint: "XL" });
  c.setMotion("off", 1);
  c.reduced = reduced;
  return c;
}

/** Drag left by `px` per move for `moves` moves, 16 ms apart, then release `idle` ms after the last move. */
function drag(c: TurntableCamera, opts: { px?: number; py?: number; moves?: number; idle?: number } = {}): number {
  const { px = -12, py = 0, moves = 4, idle = 4 } = opts;
  let t = 1000;
  c.pointerDown(400, 250, 0, false, t);
  let x = 400, y = 250;
  for (let i = 0; i < moves; i++) {
    t += 16;
    x += px;
    y += py;
    c.pointerMove(x, y, t);
  }
  t += idle;
  c.pointerUp(t);
  return t;
}

function run(c: TurntableCamera, from: number, ms: number): number {
  let t = from;
  const end = from + ms;
  while (t < end) {
    t += 16;
    c.update(t, 0.016);
  }
  return t;
}

describe("orbit inertia (FIG-13): pure maths", () => {
  it("releaseVelocity averages the last three moves and ignores a still pointer", () => {
    const s: OrbitSample[] = [
      { t: 16, dt: 16, dYaw: 9, dPitch: 0 },
      { t: 32, dt: 16, dYaw: 3, dPitch: 1 },
      { t: 48, dt: 16, dYaw: 3, dPitch: 1 },
      { t: 64, dt: 16, dYaw: 3, dPitch: 1 },
    ];
    const v = releaseVelocity(s, 66);
    expect(v.yaw).toBeCloseTo(9 / 48, 6); // the first sample falls outside the last three
    expect(v.pitch).toBeCloseTo(3 / 48, 6);
    expect(releaseVelocity(s, 64 + T.camera.inertiaIdleMs + 1)).toEqual({ yaw: 0, pitch: 0 });
    expect(releaseVelocity([], 0)).toEqual({ yaw: 0, pitch: 0 });
  });

  it("a click's one-pixel jitter carries no velocity", () => {
    const v = releaseVelocity([{ t: 10, dt: 16, dYaw: T.camera.orbitDegPerPx, dPitch: 0 }], 12);
    expect(v).toEqual({ yaw: 0, pitch: 0 });
  });

  it("caps the carried velocity", () => {
    const v = releaseVelocity([{ t: 10, dt: 10, dYaw: 500, dPitch: -500 }], 11);
    expect(v.yaw).toBe(T.camera.inertiaMaxDegPerMs);
    expect(v.pitch).toBe(-T.camera.inertiaMaxDegPerMs);
  });

  it("decays exponentially with tau about 350 ms and converges below the stop speed", () => {
    const v0 = { yaw: 0.3, pitch: 0 };
    const one = coastStep(v0, T.camera.inertiaTauMs);
    expect(one.vel.yaw).toBeCloseTo(0.3 / Math.E, 6);
    // Splitting a span into frames covers the same angle (the step is exact, not an Euler approximation).
    let v = v0;
    let total = 0;
    for (let i = 0; i < 21; i++) {
      const s = coastStep(v, 350 / 21);
      total += s.dYaw;
      v = s.vel;
    }
    expect(total).toBeCloseTo(one.dYaw, 6);
    expect(coastDone(v0)).toBe(false);
    let frames = 0;
    v = v0;
    while (!coastDone(v) && frames < 2000) {
      v = coastStep(v, 1000 / 60).vel;
      frames++;
    }
    expect(frames).toBeLessThan(400);
    expect(coastDone(v)).toBe(true);
  });
});

describe("orbit inertia: TurntableCamera", () => {
  let c: TurntableCamera;
  beforeEach(() => {
    c = camera();
  });

  it("keeps turning after release, then converges", () => {
    const tUp = drag(c);
    const yaw0 = c.heading(tUp).headingDeg;
    let t = run(c, tUp, 300);
    const yaw1 = c.heading(t).headingDeg;
    expect(yaw1).toBeGreaterThan(yaw0 + 1);
    expect(c.animating(t)).toBe(true);
    t = run(c, t, 6000);
    const yaw2 = c.heading(t).headingDeg;
    expect(yaw2).toBeGreaterThan(yaw1);
    // Converged: no more turning, and the camera reports idle again (motion is off).
    t = run(c, t, 500);
    expect(c.heading(t).headingDeg).toBeCloseTo(yaw2, 6);
    expect(c.animating(t)).toBe(false);
  });

  it("travels about velocity times tau", () => {
    const tUp = drag(c, { px: -10, moves: 5, idle: 2 });
    const v = (10 * T.camera.orbitDegPerPx) / 16;
    const yaw0 = c.heading(tUp).headingDeg;
    const t = run(c, tUp, 8000);
    const travelled = c.heading(t).headingDeg - yaw0;
    expect(travelled).toBeGreaterThan(v * T.camera.inertiaTauMs * 0.8);
    expect(travelled).toBeLessThan(v * T.camera.inertiaTauMs * 1.3);
  });

  it("a release after holding still does not coast", () => {
    const tUp = drag(c, { idle: 400 });
    const yaw0 = c.heading(tUp).headingDeg;
    const t = run(c, tUp, 500);
    expect(c.heading(t).headingDeg).toBeCloseTo(yaw0, 9);
  });

  it("stops at the pitch clamp and keeps turning in yaw", () => {
    const tUp = drag(c, { px: -6, py: -30, moves: 5, idle: 2 });
    const t = run(c, tUp, 4000);
    const h = c.heading(t);
    expect(h.pitchDeg).toBeLessThanOrEqual(T.camera.pitchLimitDeg + 1e-6);
    expect(h.pitchDeg).toBeGreaterThanOrEqual(-T.camera.pitchLimitDeg - 1e-6);
  });

  it("a new pointerdown cancels the coast", () => {
    const tUp = drag(c);
    let t = run(c, tUp, 100);
    c.pointerDown(300, 200, 0, false, t);
    const yaw = c.heading(t).headingDeg;
    t = run(c, t, 400);
    expect(c.heading(t).headingDeg).toBeCloseTo(yaw, 9);
  });

  it("is off under reduced motion", () => {
    const r = camera(true);
    const tUp = drag(r);
    const yaw0 = r.heading(tUp).headingDeg;
    const t = run(r, tUp, 500);
    expect(r.heading(t).headingDeg).toBeCloseTo(yaw0, 9);
  });

  it("starts the auto-motion pause only after the coast ends", () => {
    const m = camera();
    m.setMotion("spin", 1);
    const tUp = drag(m);
    let t = tUp;
    let prev = m.heading(t).yawDeg;
    // Follow the coast until the figure stands still (the first frame that does not turn it).
    let stillSince = -1;
    for (let i = 0; i < 1000 && stillSince < 0; i++) {
      t += 16;
      m.update(t, 0.016);
      const y = m.heading(t).yawDeg;
      if (Math.abs(y - prev) < 1e-9) stillSince = t;
      prev = y;
    }
    expect(stillSince).toBeGreaterThan(tUp + 1000);
    const h0 = m.heading(t).yawDeg;
    // Inside the pause that starts now (not at release) the spin has not resumed.
    t = run(m, t, T.motion.pauseAfterDragMs - 300);
    expect(m.heading(t).yawDeg).toBeCloseTo(h0, 6);
    t = run(m, t, 300 + T.motion.resumeMs + 1500);
    expect(Math.abs(m.heading(t).yawDeg - h0)).toBeGreaterThan(0.2);
  });
});

describe("opening dolly (FIG-15)", () => {
  const home: Framing = { yawDeg: 11, pitchDeg: -8, distance: 40, target: [0, 1, 0], shiftX: 5, shiftY: -4 };

  it("dollyDistance runs from 0.35 x home to home, eased out", () => {
    expect(dollyDistance(40, 0)).toBeCloseTo(40 * T.camera.introDollyFactor, 9);
    expect(dollyDistance(40, 1)).toBeCloseTo(40, 9);
    let prev = 0;
    for (let i = 0; i <= 20; i++) {
      const d = dollyDistance(40, i / 20);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
    // Ease-out: more than half the way there by the half time.
    const mid = dollyDistance(40, 0.5);
    expect((Math.log(mid) - Math.log(40 * 0.35)) / (Math.log(40) - Math.log(40 * 0.35))).toBeGreaterThan(0.5);
  });

  it("tweens the camera from close to the home distance in introDollyMs", () => {
    const c = camera();
    c.setHome(home, 0, 0);
    expect(c.framing(0).distance).toBeCloseTo(40, 6);
    c.dollyIn(100);
    expect(c.framing(100).distance).toBeCloseTo(40 * 0.35, 6);
    const mid = c.framing(100 + T.camera.introDollyMs / 2).distance;
    expect(mid).toBeGreaterThan(14);
    expect(mid).toBeLessThan(40);
    const end = 100 + T.camera.introDollyMs;
    c.update(end + 1, 0.016);
    expect(c.framing(end + 1).distance).toBeCloseTo(40, 6);
    expect(c.animating(end + 1)).toBe(false);
  });

  it("a new home during the dolly is where it lands", () => {
    const c = camera();
    c.setHome(home, 0, 0);
    c.dollyIn(0);
    c.setHome({ ...home, distance: 60 }, 100, 0);
    c.update(T.camera.introDollyMs + 5, 0.016);
    expect(c.framing(T.camera.introDollyMs + 5).distance).toBeCloseTo(60, 6);
  });

  it("is skipped under reduced motion", () => {
    const c = camera(true);
    c.setHome(home, 0, 0);
    c.dollyIn(0);
    expect(c.framing(0).distance).toBeCloseTo(40, 6);
  });

  it("restorePose can open with the dolly too", () => {
    const c = camera();
    c.setHome(home, 0, 0);
    c.restorePose({ yawDeg: 30, pitchDeg: -10, distance: 1, target: [0, 1, 0] }, 50, { dolly: true });
    expect(c.framing(50).distance).toBeCloseTo(40 * 0.35, 6);
    c.update(50 + T.camera.introDollyMs + 1, 0.016);
    expect(c.framing(50 + T.camera.introDollyMs + 1).distance).toBeCloseTo(40, 6);
    expect(c.framing(50 + T.camera.introDollyMs + 1).yawDeg).toBeCloseTo(30, 6);
  });
});

describe("group-change flight (FIG-18)", () => {
  const start: Framing = { yawDeg: 10, pitchDeg: -8, distance: 30, target: [0, 2, 0], shiftX: 0, shiftY: 0 };
  const fit: Framing = { yawDeg: 10, pitchDeg: -10, distance: 22, target: [1, 3, 0], shiftX: 20, shiftY: 0 };

  it("plans back-off (x1.3, target down 0.15) then a fit seen from 12 degrees lower", () => {
    const p = groupFlightPlan(start, fit);
    expect(p.via.distance).toBeCloseTo(30 * T.camera.groupFlightBackFactor, 9);
    expect(p.via.target[1]).toBeCloseTo(2 - T.camera.groupFlightDrop, 9);
    expect(p.to.pitchDeg).toBeCloseTo(-10 + T.camera.groupFlightPitchDeg, 9);
    expect(p.to.distance).toBe(22);
    expect(p.split).toBeCloseTo(300 / 800, 9);
  });

  it("flies through the back-off before arriving", () => {
    const c = camera();
    c.setHome(start, 0, 0);
    expect(c.groupFlight(fit, 1000)).toBe(true);
    const total = T.camera.groupFlightBackMs + T.camera.groupFlightInMs;
    const atSplit = c.framing(1000 + T.camera.groupFlightBackMs);
    expect(atSplit.distance).toBeCloseTo(30 * T.camera.groupFlightBackFactor, 5);
    expect(c.framing(1000 + 150).distance).toBeGreaterThan(30);
    c.update(1000 + total + 1, 0.016);
    const end = c.framing(1000 + total + 1);
    expect(end.distance).toBeCloseTo(22, 6);
    expect(end.pitchDeg).toBeCloseTo(-10 + T.camera.groupFlightPitchDeg, 6);
    expect(end.target[0]).toBeCloseTo(1, 6);
  });

  it("falls back to a plain re-fit under reduced motion", () => {
    const c = camera(true);
    c.setHome(start, 0, 0);
    expect(c.groupFlight(fit, 0)).toBe(false);
  });

  it("the same fit again only re-frames; forgetting it flies again", () => {
    const c = camera();
    c.setHome(start, 0, 0);
    c.groupFlight(fit, 0);
    c.update(2000, 0.016);
    expect(sameFit(fit, { ...fit, distance: fit.distance * 1.01 })).toBe(true);
    c.groupFlight(fit, 3000);
    // A plain 400 ms re-frame: no back-off, so the distance never exceeds the larger of its ends.
    expect(c.framing(3000 + 100).distance).toBeLessThanOrEqual(22.001);
    c.update(4000, 0.016);
    c.forgetGroupFlight();
    c.groupFlight(fit, 5000);
    expect(c.framing(5000 + T.camera.groupFlightBackMs).distance).toBeGreaterThan(22 * 1.2);
  });
});

describe("canvas cursors (SYS-12)", () => {
  it("picks the cursor by priority: drag, target, deep zoom, grab", () => {
    expect(canvasCursor({ dragging: true, overTarget: true, deepZoom: true })).toBe("grabbing");
    expect(canvasCursor({ dragging: false, overTarget: true, deepZoom: true })).toBe("pointer");
    expect(canvasCursor({ dragging: false, overTarget: false, deepZoom: true })).toBe("zoom-dot");
    expect(canvasCursor({ dragging: false, overTarget: false, deepZoom: false })).toBe("grab");
  });

  it("deep zoom starts where a cell spans 120 px (GIVE_WAY x side >= 18 px)", () => {
    const marks = [{ bounds: { min: [0, 0, 0] as [number, number, number], max: [2, 2, 0] as [number, number, number] } }];
    const at = (pxPerUnit: number) => (p: [number, number, number]) => ({ x: 100 + p[0] * pxPerUnit, y: 100 - p[1] * pxPerUnit, visible: true });
    const view = { width: 800, height: 600 };
    // A 2-unit cell at 50 px/unit spans 100 px: still under 120.
    expect(chartZoomedPastGiveWay(marks, at(50), view)).toBe(false);
    expect(2 * 61 * GIVE_WAY).toBeGreaterThan(18);
    expect(chartZoomedPastGiveWay(marks, at(61), view)).toBe(true);
    expect(chartZoomedPastGiveWay(marks, () => ({ x: 0, y: 0, visible: false }), view)).toBe(false);
    expect(chartZoomedPastGiveWay([], at(500), view)).toBe(false);
    // Off screen: no dot.
    expect(chartZoomedPastGiveWay(marks, (p) => ({ x: 5000 + p[0] * 100, y: 100 - p[1] * 100, visible: true }), view)).toBe(false);
  });
});

describe("instant restore flag (FIG-25)", () => {
  beforeEach(() => resetInstantRestore());

  it("is one-shot", () => {
    expect(consumeInstantRestore(0)).toBe(false);
    markInstantRestore(10);
    expect(consumeInstantRestore(20)).toBe(true);
    expect(consumeInstantRestore(21)).toBe(false);
  });

  it("expires so a restore that changed nothing cannot leak into a later fade", () => {
    markInstantRestore(0);
    expect(consumeInstantRestore(INSTANT_RESTORE_TTL_MS + 1)).toBe(false);
  });
});

describe("flat charts face the camera (not seen from behind)", () => {
  it("fits a flat or perspective chart at yaw 0, a volume at the figure's heading", () => {
    expect(arrangementAngles({ keepUpright: true, tiltDeg: 0 }, -154)).toEqual({ yawDeg: 0, pitchDeg: 0 });
    expect(arrangementAngles({ keepUpright: true, tiltDeg: 20 }, -154)).toEqual({ yawDeg: 0, pitchDeg: -20 });
    expect(arrangementAngles({ keepUpright: false, tiltDeg: 8 }, -154)).toEqual({ yawDeg: -154, pitchDeg: -8 });
  });

  it("holds a flat chart's upright camera about the chart, not about the figure's standing home (yaw -154)", () => {
    const c = new TurntableCamera(1.6, "standing");
    c.setStage({ width: 800, height: 500, insetLeft: 0, insetRight: 0, breakpoint: "XL" });
    c.setMotion("off", 1);
    c.setForcedUpright(true, { yawDeg: 0, pitchDeg: 0 });
    c.fit({ yawDeg: 0, pitchDeg: 0, distance: 10, target: [0, 0, 0], shiftX: 0, shiftY: 0 }, 0, 0);
    c.update(1, 0.016);
    const f = c.framing(1);
    expect(Math.abs(f.yawDeg)).toBeLessThan(1);
    c.orbitBy(120, 0);
    expect(Math.abs(c.framing(1).yawDeg)).toBeLessThanOrEqual(T.camera.uprightYawDeg + 1e-6);
    // Without the chart, the same clamp is about the home view again.
    c.setForcedUpright(false);
    expect(c.isForcedUpright()).toBe(false);
  });

  it("only breathes while it faces a flat chart: the idle drift stays a fraction of the figure's", () => {
    const run = (): number => {
      const c = new TurntableCamera(1.6, "standing");
      c.setStage({ width: 800, height: 500, insetLeft: 0, insetRight: 0, breakpoint: "XL" });
      c.setMotion("drift", 1);
      c.setForcedUpright(true, { yawDeg: 0, pitchDeg: 0 });
      c.fit({ yawDeg: 0, pitchDeg: 0, distance: 10, target: [0, 0, 0], shiftX: 0, shiftY: 0 }, 0, 0);
      let worst = 0;
      for (let i = 1; i < 4000; i++) {
        c.update(i * 20, 0.02);
        worst = Math.max(worst, Math.abs(c.framing(i * 20).yawDeg));
      }
      return worst;
    };
    expect(run()).toBeLessThanOrEqual(T.motion.driftYawAmpDeg * FLAT_CHART_MOTION_SCALE + 1e-6);
  });

  it("keeps a flat chart's camera when the stage resizes and the figure's home is fitted again", () => {
    const c = new TurntableCamera(1.6, "standing");
    c.setStage({ width: 800, height: 500, insetLeft: 0, insetRight: 0, breakpoint: "XL" });
    c.setMotion("off", 1);
    c.setForcedUpright(true, { yawDeg: 0, pitchDeg: 0 });
    c.fit({ yawDeg: 0, pitchDeg: 0, distance: 10, target: [0, 0, 0], shiftX: 0, shiftY: 0 }, 0, 0);
    c.leaveHome();
    // The figure's home view looks at it from behind (yaw -154); a new home must only be remembered.
    c.setHome({ yawDeg: -154, pitchDeg: -9, distance: 30, target: [0, 1, 0], shiftX: 0, shiftY: 0 }, 5, 0);
    c.update(10, 0.016);
    expect(Math.abs(c.framing(10).yawDeg)).toBeLessThan(1);
    expect(c.framing(10).distance).toBeCloseTo(10, 5);
  });
});

describe("flat chart fit", () => {
  const g = { width: 1000, height: 800, insetLeft: 0, insetRight: 0, breakpoint: "XL" as const };
  it("fits the chart's rectangle into the safe frame, larger than the circle round it", () => {
    const half = { w: 6.5, h: 4 };
    const f = fitFrame([0, 0, 0], half, g, { yawDeg: 0, pitchDeg: 0 });
    const tanV = Math.tan((T.camera.fovDeg * Math.PI) / 360);
    const px = g.height / (2 * f.distance * tanV);
    const r = flatChartRect(g);
    const wide = (r.x1 - r.x0) * (1 - T.frame.refitMargin);
    const tall = (r.y1 - r.y0) * (1 - T.frame.refitMargin);
    expect(2 * half.w * px).toBeLessThanOrEqual(wide + 1e-6);
    expect(2 * half.h * px).toBeLessThanOrEqual(tall + 1e-6);
    // One of the two sides touches its limit.
    expect(Math.max((2 * half.w * px) / wide, (2 * half.h * px) / tall)).toBeCloseTo(1, 6);
    const sphere = fitSphere([0, 0, 0], Math.hypot(half.w, half.h) * 0.98, g, { yawDeg: 0, pitchDeg: 0 });
    expect(f.distance).toBeLessThan(sphere.distance);
    expect(f.shiftX).toBeCloseTo((r.x0 + r.x1) / 2 - g.width / 2, 6);
  });
});

describe("scripted legs (Showcase mode's dolly, orbit, comet tilt and fly-through)", () => {
  const home = (c: TurntableCamera): Framing => c.home();
  const setup = (reduced = false): TurntableCamera => {
    const c = camera(reduced);
    c.setHome({ yawDeg: -154, pitchDeg: -9, distance: 20, target: [0, 0.3, -0.2], shiftX: 0, shiftY: 0 }, 0, 0);
    return c;
  };

  it("flies the legs one after another, each from where the last ended, and lands on the last", () => {
    const c = setup();
    c.flyLegs([{ target: [1, 4, 0], distanceFactor: 0.1, ms: 300 }, { target: [2, 0, 1], distanceFactor: 0.2, yawDeg: 40, ms: 300 }, { distanceFactor: 1, ms: 300 }], 1000);
    expect(c.animating(1100)).toBe(true);
    const mid = c.framing(1150);
    expect(mid.distance).toBeLessThan(home(c).distance);
    const t = run(c, 1000, 400);
    expect(c.framing(t).target[1]).not.toBeCloseTo(home(c).target[1], 1);
    run(c, t, 700);
    const end = c.framing(2200);
    expect(end.distance).toBeCloseTo(home(c).distance, 3);
    expect(end.yawDeg).toBeCloseTo(home(c).yawDeg, 3);
    expect(c.flyingLegs(2300)).toBe(false);
  });

  it("offsets the heading and pitch from the home view, the short way round", () => {
    const c = setup();
    c.flyLegs([{ yawDeg: 40, pitchDeg: 10, ms: 100 }], 0);
    run(c, 0, 200);
    const f = c.framing(300);
    expect(f.yawDeg).toBeCloseTo(-154 + 40, 3);
    expect(f.pitchDeg).toBeCloseTo(-9 + 10, 3);
  });

  it("rolls the picture about the line of sight and rolls it back upright", () => {
    const c = setup();
    c.flyLegs([{ rollDeg: 90, ms: 200 }], 0);
    run(c, 0, 300);
    c.apply(400);
    // Rolled a quarter turn: the camera's up has no vertical part left.
    expect(Math.abs(c.camera.up.y)).toBeLessThan(0.2);
    c.flyLegs([{ rollDeg: 0, ms: 200 }], 400);
    run(c, 400, 300);
    c.apply(800);
    expect(c.camera.up.y).toBeCloseTo(1, 3);
  });

  it("a gesture, a reset or a restore drops the rest of the path and turns the picture upright", () => {
    for (const how of ["pointer", "reset", "restore"] as const) {
      const c = setup();
      c.flyLegs([{ rollDeg: 90, ms: 300 }, { rollDeg: 90, distanceFactor: 0.3, ms: 300 }], 0);
      run(c, 0, 100);
      if (how === "pointer") c.pointerDown(10, 10, 0, false, 120);
      else if (how === "reset") c.reset(120, 0);
      else c.restorePose({ yawDeg: 0, pitchDeg: 0, distance: 1, target: [0, 0, 0] }, 120);
      expect(c.flyingLegs(121 + 400)).toBe(false);
      run(c, 120, 600);
      c.apply(800);
      if (how !== "pointer") expect(c.camera.up.y).toBeCloseTo(1, 3);
    }
  });

  it("cuts straight to the last leg under reduced motion, and a zero-length leg still lets the next start", () => {
    const r = setup(true);
    r.flyLegs([{ distanceFactor: 0.1, ms: 500 }, { distanceFactor: 2, ms: 500 }], 0);
    expect(r.framing(1).distance).toBeCloseTo(home(r).distance * 2, 3);
    const c = setup();
    c.flyLegs([{ distanceFactor: 0.05, ms: 0 }, { distanceFactor: 1, ms: 200 }], 0);
    const t = run(c, 0, 600);
    expect(c.framing(t).distance).toBeCloseTo(home(c).distance, 3);
  });
});
