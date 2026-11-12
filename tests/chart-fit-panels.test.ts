/** F-01 / F-02: the lens takes the haze down with the points; charts are fitted between the floating panels. */
import { describe, expect, it } from "vitest";
import { CHART_MIN_FREE_PX, chartFitGeom, fitArrangementCamera, flatChartRect, safeRect } from "../src/render/camera";
import { RENDER_TUNING as T } from "../src/render/tuning";
import { measureChartCover } from "../src/ui/mount";

const g = { width: 1400, height: 800, insetLeft: 0, insetRight: 0, breakpoint: "XL" as const };
const cam = { centre: [0, 0, 0] as [number, number, number], radius: 7.5, tiltDeg: 0, keepUpright: true, half: { w: 6.5, h: 4 } };
const angles = { yawDeg: 0, pitchDeg: 0 };

describe("lens darkens the haze (F-01)", () => {
  it("takes the haze to 6-10% while a strong area lens is on, below every other state", () => {
    const s = T.stateAlpha;
    expect(s.hazeWhileLens).toBeGreaterThanOrEqual(0.06);
    expect(s.hazeWhileLens).toBeLessThanOrEqual(0.1);
    expect(s.hazeWhileLens).toBeLessThan(s.hazeWhileSelected);
    expect(s.hazeWhileLens).toBeLessThan(s.hazeWhileTraced);
  });
});

describe("charts fit between the floating panels (F-02)", () => {
  it("leaves the geometry alone without a cover", () => {
    expect(chartFitGeom(g, null)).toBe(g);
    expect(chartFitGeom(g, { left: 0, right: 0 })).toBe(g);
  });
  it("adds the cover to the sheet insets", () => {
    const geom = chartFitGeom({ ...g, insetRight: 100 }, { left: 256, right: 340 });
    expect(geom.insetLeft).toBe(256);
    expect(geom.insetRight).toBe(440);
  });
  it("never leaves the chart less than the minimum width", () => {
    const geom = chartFitGeom(g, { left: 900, right: 900 });
    expect(geom.width - geom.insetLeft - geom.insetRight).toBeGreaterThanOrEqual(CHART_MIN_FREE_PX - 2);
  });
  it("centres a flat chart in the free space and keeps its edges inside it", () => {
    const cover = { left: 256, right: 360 };
    const geom = chartFitGeom(g, cover);
    const f = fitArrangementCamera(cam, geom, angles);
    const free = flatChartRect(geom);
    expect(f.shiftX).toBeCloseTo((free.x0 + free.x1) / 2 - g.width / 2, 6);
    const tanV = Math.tan((T.camera.fovDeg * Math.PI) / 360);
    const px = g.height / (2 * f.distance * tanV);
    const left = g.width / 2 + f.shiftX - cam.half.w * px;
    const right = g.width / 2 + f.shiftX + cam.half.w * px;
    expect(left).toBeGreaterThanOrEqual(cover.left);
    expect(right).toBeLessThanOrEqual(g.width - cover.right + 1e-6);
    // Fitted to the whole stage the same chart runs under both panels.
    const bare = fitArrangementCamera(cam, g, angles);
    const bpx = g.height / (2 * bare.distance * tanV);
    expect(f.distance).toBeGreaterThan(bare.distance);
    expect(g.width / 2 + bare.shiftX + cam.half.w * bpx).toBeGreaterThan(g.width - cover.right);
    expect(safeRect(geom).x1).toBeLessThan(safeRect(g).x1);
  });
});

describe("measureChartCover", () => {
  const rect = (l: number, r: number) => ({ left: l, right: r, top: 0, bottom: 100, width: r - l, height: 100 });
  const el = (r: ReturnType<typeof rect>) => ({ getBoundingClientRect: () => r });
  const root = (card: object | null, pop: object | null, popCollapsed = false) =>
    ({
      querySelector: (sel: string) => {
        if (sel === ".cx-stage") return { getBoundingClientRect: () => rect(60, 1460), querySelector: (s: string) => (s.includes(":not(.is-collapsed)") ? (popCollapsed ? null : pop) : null) };
        if (sel === ".cx-sheet.is-card") return card;
        return null;
      },
    }) as unknown as Element;
  it("measures the card on the left and the popover on the right in stage coordinates", () => {
    const c = measureChartCover(root(el(rect(72, 316)), el(rect(1100, 1448))));
    expect(c).toEqual({ left: 316 - 60 + 12, right: 1460 - 1100 + 12 });
  });
  it("ignores a closed card and a collapsed popover", () => {
    expect(measureChartCover(root(null, el(rect(1100, 1448)), true))).toEqual({ left: 0, right: 0 });
  });
});
