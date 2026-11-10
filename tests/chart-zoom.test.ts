/**
 * Chart semantic zoom for cells the layout left unnamed (shared/chartZoom.ts): which members a cell gets, which
 * cells are named for a given view, the caps, and what the worker records so the overlay knows the rest.
 */
import { describe, expect, it } from "vitest";
import { GIVE_WAY, MEMBERS_PER_CELL, memberLabelText, pickZoomCells, type ZoomMark } from "../src/shared/chartZoom";
import { waveWindowChoices, waveWindowDays } from "../src/shared/chartOptions";
import type { ChartSpec } from "../src/shared/protocol/worker";
import { parseRef } from "../src/ui/stage/ChartOverlay";
import { defaultVisibility } from "../src/worker/charts/common";
import { runChart } from "../src/worker/charts/registry";
import { buildSampleIndex } from "../src/worker/sampleIndex";

const mark = (x0: number, y0: number, x1: number, y1: number, count = 5): ZoomMark => ({ bounds: { min: [x0, y0, -0.1], max: [x1, y1, 0.1] }, count });

describe("pickZoomCells", () => {
  const view = { width: 800, height: 600 };
  // A flat camera: `px` pixels per world unit, world origin at the screen centre.
  const flat = (px: number) => (p: [number, number, number]) => ({ x: 400 + p[0] * px, y: 300 - p[1] * px, visible: true });
  const marks = [mark(-1, -1, 1, 1), mark(100, 100, 102, 102), mark(0, 0, 0.5, 0.5)];
  const cands = new Map<number, number[]>([[0, [1, 2]], [1, [3]], [2, [4]]]);
  it("names only cells that span the 120 px threshold and are on screen", () => {
    expect(pickZoomCells(marks, cands, flat(10), view)).toEqual([]);
    // 100 px per unit: cell 0 is 200 px across (named), cell 2 is 50 px (not), cell 1 is far off screen.
    expect(pickZoomCells(marks, cands, flat(100), view)).toEqual([0]);
    expect(GIVE_WAY * 120).toBeCloseTo(18, 10);
  });
  it("skips cells behind the camera", () => {
    expect(pickZoomCells(marks, cands, () => ({ x: 0, y: 0, visible: false }), view)).toEqual([]);
  });
  it("takes the biggest on screen first and stops at the caps", () => {
    const many = Array.from({ length: 10 }, (_, i) => mark(i * 3, 0, i * 3 + 1 + i * 0.1, 1 + i * 0.1));
    const c = new Map(many.map((_, i) => [i, [i]] as const));
    const proj = (p: [number, number, number]) => ({ x: p[0] * 130, y: 300 - p[1] * 130, visible: true });
    const wide = { width: 5000, height: 600 };
    const all = pickZoomCells(many, c, proj, wide, { cells: 100, labels: 100 });
    expect(all.length).toBeGreaterThan(0);
    const capped = pickZoomCells(many, c, proj, wide, { cells: 2, labels: 100 });
    expect(capped).toEqual(all.slice(0, 2));
    expect(pickZoomCells(many, c, proj, wide, { cells: 100, labels: 1 })).toHaveLength(Math.min(1, all.length));
  });
});

describe("memberLabelText", () => {
  it("collapses whitespace and cuts long titles", () => {
    expect(memberLabelText("  a \n b  ")).toBe("a b");
    expect(memberLabelText("")).toBe("");
    expect(memberLabelText("x".repeat(40))).toHaveLength(28);
  });
});

describe("what the worker records for the overlay", () => {
  const NOW = Date.UTC(2026, 10, 10);
  const index = buildSampleIndex(20261110, NOW);
  const vis = defaultVisibility(index.count);
  const spec = (): ChartSpec => ({ chart: "matrix", x: { dim: "space", sort: "count" }, y: { dim: "source", sort: "count" }, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options: {} });
  it("tags each count with its cell", () => {
    const res = runChart(index, spec(), vis, { now: NOW });
    const counts = res.overlay.items.filter((i) => i.type === "label" && parseRef(i.key)?.zoom !== undefined && parseRef(i.key)?.cell !== undefined);
    expect(counts.length).toBeGreaterThan(0);
  });
  it("hands over the members of the cells it did not name when its label budget runs out", () => {
    // The beeswarm has far more cells than the member-label budget: the unnamed ones come with their members.
    const res = runChart(index, { ...spec(), chart: "beeswarm", x: { dim: "week", sort: "date" }, y: null }, vis, { now: NOW });
    const named = new Set(res.overlay.items.flatMap((i) => (i.type === "label" && parseRef(i.key)?.zoomMax !== undefined ? [parseRef(i.key)?.cell] : [])));
    expect(res.zoomMembers?.length).toBeGreaterThan(0);
    for (const z of res.zoomMembers ?? []) {
      expect(res.overlay.marks[z.mark]).toBeDefined();
      expect(named.has(z.mark)).toBe(false);
      expect(z.members.length).toBeGreaterThan(0);
      expect(z.members.length).toBeLessThanOrEqual(MEMBERS_PER_CELL);
      for (const o of z.members) expect(Number.isNaN(res.arr[o * 3] as number)).toBe(false);
    }
    expect(new Set((res.zoomMembers ?? []).map((z) => z.mark)).size).toBe(res.zoomMembers?.length ?? 0);
  });
});

describe("Waves window shows the real value", () => {
  it("offers the chart's own window when an older saved chart smooths over another number of days", () => {
    expect(waveWindowChoices({})).toEqual([7, 30, 90]);
    expect(waveWindowChoices({ smoothing: "moving", windowDays: "7" })).toEqual([7, 30, 90]);
    expect(waveWindowChoices({ smoothingDays: 14 })).toEqual([7, 14, 30, 90]);
    expect(waveWindowDays({ smoothingDays: 14 })).toBe(14);
    expect(waveWindowChoices({ smoothingDays: 90 })).toEqual([7, 30, 90]);
  });
});
