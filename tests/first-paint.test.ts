/** First paint: the side-view cloud, its timeline and the condense mapping (pure parts of render/firstPaint.ts). */
import { describe, expect, it } from "vitest";
import { buildCloud, COMETS, condenseTargets, insideSideBrain, paintBusy, paintState, rng, turnStartAt, yawXZ, type PaintClock } from "../src/render/firstPaint";
import { RENDER_TUNING } from "../src/render/tuning";

const P = RENDER_TUNING.firstPaint;

describe("the side-view brain outline", () => {
  it("holds the cerebrum, the cerebellum lobe and the brainstem stalk, and nothing outside", () => {
    expect(insideSideBrain(0, 0.1)).toBe(true);
    expect(insideSideBrain(-0.6, -0.5)).toBe(true);
    expect(insideSideBrain(-0.25, -0.7)).toBe(true);
    expect(insideSideBrain(0.9, -0.8)).toBe(false);
    expect(insideSideBrain(1.2, 0)).toBe(false);
    expect(insideSideBrain(0, 0.9)).toBe(false);
  });
});

describe("buildCloud", () => {
  const cloud = buildCloud(600, 40, 3);
  it("makes the requested points and two comet fans", () => {
    expect(cloud.count).toBe(600 + 40 * COMETS.length);
    expect(cloud.local.length).toBe(cloud.count * 3);
    let comets = 0;
    for (let i = 0; i < cloud.count; i++) comets += cloud.comet[i] as number;
    expect(comets).toBe(40 * COMETS.length);
  });
  it("keeps body points inside the outline (u along z, v up) and a thin depth", () => {
    for (let i = 0; i < 600; i++) {
      expect(insideSideBrain(cloud.local[i * 3 + 2] as number, cloud.local[i * 3 + 1] as number)).toBe(true);
      expect(Math.abs(cloud.local[i * 3] as number)).toBeLessThanOrEqual(0.5);
    }
  });
  it("is deterministic for a seed and differs between seeds", () => {
    const a = buildCloud(100, 10, 5);
    const b = buildCloud(100, 10, 5);
    const c = buildCloud(100, 10, 6);
    expect(Array.from(a.local)).toEqual(Array.from(b.local));
    expect(Array.from(a.local)).not.toEqual(Array.from(c.local));
  });
  it("runs comets hot near their origin and body points dimmer", () => {
    let hot = 0;
    let body = 0;
    for (let i = 0; i < cloud.count; i++) {
      if (cloud.comet[i]) hot = Math.max(hot, cloud.bright[i] as number);
      else body = Math.max(body, cloud.bright[i] as number);
    }
    expect(hot).toBeGreaterThan(0.9);
    expect(body).toBeLessThanOrEqual(0.7);
  });
  it("orders the points by height for the condense mapping", () => {
    const y = Array.from(cloud.byHeight, (i) => cloud.local[i * 3 + 1] as number);
    for (let k = 1; k < y.length; k++) expect(y[k]).toBeGreaterThanOrEqual(y[k - 1] as number);
    expect(new Set(cloud.byHeight).size).toBe(cloud.count);
  });
  it("has a generator that stays in 0..1", () => {
    const r = rng(1);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("yawXZ", () => {
  it("leaves the front view alone and turns the head's axis across the screen at 90 degrees", () => {
    expect(yawXZ(0.3, 1, 0)).toEqual([0.3, 1]);
    const [x, z] = yawXZ(0, 1, Math.PI / 2);
    expect(x).toBeCloseTo(1, 12);
    expect(z).toBeCloseTo(0, 12);
  });
  it("preserves length", () => {
    const [x, z] = yawXZ(0.4, 0.9, 1.1);
    expect(Math.hypot(x, z)).toBeCloseTo(Math.hypot(0.4, 0.9), 12);
  });
});

describe("paintState: hold, turn, cancel", () => {
  const held: PaintClock = { startMs: 1000, turnStartMs: null, cancelStartMs: null };
  it("fades in then holds at the side view with the figure away", () => {
    expect(paintState(1000, held).cloudAlpha).toBe(0);
    const s = paintState(1000 + P.fadeInMs, held);
    expect(s.cloudAlpha).toBe(1);
    expect(s.yawDeg).toBe(P.yawDeg);
    expect(s.figure).toBe(0);
    expect(s.condense).toBe(0);
    expect(s.turning).toBe(false);
    expect(s.done).toBe(false);
  });
  it("turns over turnMs to the front view, condensing, and ends done", () => {
    const c: PaintClock = { startMs: 0, turnStartMs: 1000, cancelStartMs: null };
    expect(paintState(999, c).turning).toBe(false);
    const start = paintState(1000, c);
    expect(start.yawDeg).toBe(P.yawDeg);
    const mid = paintState(1000 + P.turnMs / 2, c);
    expect(mid.yawDeg).toBeGreaterThan(0);
    expect(mid.yawDeg).toBeLessThan(P.yawDeg);
    expect(mid.condense).toBeGreaterThan(0);
    expect(mid.figure).toBeGreaterThan(0);
    const end = paintState(1000 + P.turnMs, c);
    expect(end.yawDeg).toBe(0);
    expect(end.condense).toBe(1);
    expect(end.cloudAlpha).toBe(0);
    expect(end.figure).toBe(1);
    expect(end.done).toBe(true);
  });
  it("only ever moves forward: yaw falls, condense and the figure rise", () => {
    const c: PaintClock = { startMs: 0, turnStartMs: 0, cancelStartMs: null };
    let last = paintState(0, c);
    for (let t = 20; t <= P.turnMs; t += 20) {
      const s = paintState(t, c);
      expect(s.yawDeg).toBeLessThanOrEqual(last.yawDeg + 1e-9);
      expect(s.condense).toBeGreaterThanOrEqual(last.condense - 1e-9);
      expect(s.figure).toBeGreaterThanOrEqual(last.figure - 1e-9);
      last = s;
    }
  });
  it("fades out on cancel without a turn", () => {
    const c: PaintClock = { startMs: 0, turnStartMs: null, cancelStartMs: 2000 };
    expect(paintState(2000, c).cloudAlpha).toBe(1);
    expect(paintState(2000 + P.cancelMs / 2, c).cloudAlpha).toBeCloseTo(0.5, 5);
    const end = paintState(2000 + P.cancelMs, c);
    expect(end.cloudAlpha).toBe(0);
    expect(end.done).toBe(true);
    expect(end.turning).toBe(false);
  });
});

describe("the hold and the idle loop", () => {
  it("holds the cloud at least holdMinMs before the turn", () => {
    expect(turnStartAt(1000, 1100)).toBe(1000 + P.holdMinMs);
    expect(turnStartAt(1000, 5000)).toBe(5000);
  });
  it("needs frames only while fading in, turning or fading out: a held cloud lets the loop idle", () => {
    const held: PaintClock = { startMs: 0, turnStartMs: null, cancelStartMs: null };
    expect(paintBusy(10, held, false)).toBe(true);
    expect(paintBusy(P.fadeInMs + 200, held, false)).toBe(false);
    expect(paintBusy(10_000, held, false)).toBe(false);
    expect(paintBusy(10_000, { ...held, turnStartMs: 9000 }, false)).toBe(true);
    expect(paintBusy(10_000, { ...held, cancelStartMs: 9000 }, false)).toBe(true);
    expect(paintBusy(10_000, { ...held, turnStartMs: 9000 }, true)).toBe(false);
  });
});

describe("condenseTargets", () => {
  const cloud = buildCloud(500, 30, 2);
  const n = 300;
  const ys = Array.from({ length: n }, (_, j) => (j * 37) % n); // shuffled heights 0..n-1
  it("gives every point a valid sample and lands the crown on the figure's top", () => {
    const t = condenseTargets(cloud, n, (j) => ys[j] as number, 4, 0.02);
    expect(t.length).toBe(cloud.count);
    for (const j of t) expect(j).toBeLessThan(n);
    const top = cloud.byHeight[cloud.count - 1] as number;
    const bottom = cloud.byHeight[0] as number;
    expect(ys[t[top] as number] as number).toBeGreaterThan(n * 0.9);
    expect(ys[t[bottom] as number] as number).toBeLessThan(n * 0.1);
  });
  it("is deterministic and tolerates an empty figure", () => {
    expect(Array.from(condenseTargets(cloud, n, (j) => j, 9))).toEqual(Array.from(condenseTargets(cloud, n, (j) => j, 9)));
    expect(condenseTargets(cloud, 0, () => 0).every((v) => v === 0)).toBe(true);
  });
});

describe("tuning", () => {
  it("keeps the turn at about 1.1 s from a side view", () => {
    expect(P.turnMs).toBe(1100);
    expect(P.yawDeg).toBe(90);
    expect(P.cloudFadeFrom).toBeGreaterThan(P.figureFrom);
  });
});
