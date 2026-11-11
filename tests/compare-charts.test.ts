/**
 * Compare and rhythm charts (P12): responsive relayout (stage width and aspect in the chart context, label columns and
 * tick rows), the Grid's perspective, the wheel's crown and top spoke, Shells rows with swirl texture, the treemap's
 * drill-in with its crumb, and the hub link fan over a chart arrangement.
 */
import { describe, expect, it } from "vitest";
import { chartStageKey, chartStageOf, labelColumns, labelPitch, tickRows, STAGE_NARROW_PX } from "../src/shared/chartStage";
import { matrixPerspective, treemapRoot, withTreemapRoot } from "../src/shared/chartOptions";
import type { ChartSpec, OverlayItem } from "../src/shared/protocol/worker";
import { CHART_CATALOGUE } from "../src/shared/views";
import { defaultVisibility, swirlDir } from "../src/worker/charts/common";
import { MATRIX_DEPTH_SPAN, SHELL_ROWS_MAX } from "../src/worker/charts/compare";
import { runChart } from "../src/worker/charts/registry";
import { WHEEL_RINGS_END } from "../src/worker/charts/rhythm";
import { buildSampleIndex } from "../src/worker/sampleIndex";
import { buildHubFan, fanPositions } from "../src/render/hubFan";
import { drillTreemap, parseRef } from "../src/ui/stage/ChartOverlay";
import { createLeafStore } from "../src/state/store";
import { CHART_OPTIONS } from "../src/ui/pages/ChartPage";
import { t } from "../src/ui/copy";

const NOW = Date.UTC(2026, 10, 10);
const index = buildSampleIndex(20261110, NOW);
const vis = defaultVisibility(index.count);

function specFor(chart: ChartSpec["chart"], over: Partial<ChartSpec> = {}): ChartSpec {
  const g = CHART_CATALOGUE.find((c) => c.id === chart)!.group;
  const base: ChartSpec = { chart, x: { dim: g === "time" ? "week" : g === "rhythm" ? "hour" : "space", sort: "count" }, y: null, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options: {} };
  const withY = chart === "matrix" || chart === "radial-heatmap" ? { ...base, y: { dim: "source" as const, sort: "count" as const } } : base;
  return { ...withY, ...over };
}

const WIDE = chartStageOf(1200, 700);
const NARROW = chartStageOf(400, 700);

function labels(items: readonly OverlayItem[]): Extract<OverlayItem, { type: "label" }>[] {
  return items.filter((i): i is Extract<OverlayItem, { type: "label" }> => i.type === "label");
}

describe("stage in the chart context (CHART-03)", () => {
  it("measures the stage and keys it by 40 px steps", () => {
    const s = chartStageOf(900.4, 450);
    expect(s).toEqual({ width: 900, height: 450, aspect: 2 });
    expect(chartStageKey(chartStageOf(900, 450))).toBe(chartStageKey(chartStageOf(910, 455)));
    expect(chartStageKey(chartStageOf(900, 450))).not.toBe(chartStageKey(chartStageOf(700, 450)));
    expect(chartStageKey(null)).toBe("");
  });
  it("gives one label column below 520 px and two at or above it", () => {
    expect(STAGE_NARROW_PX).toBe(520);
    expect(labelColumns(chartStageOf(519, 700))).toBe(1);
    expect(labelColumns(chartStageOf(520, 700))).toBe(2);
    expect(labelColumns(WIDE)).toBe(2);
    expect(labelColumns(NARROW)).toBe(1);
    // A narrow stage gives each unit fewer pixels, so a label needs more of them.
    expect(labelPitch(NARROW)).toBeGreaterThan(labelPitch(WIDE));
  });
  it("gives one tick row while the slots are wide and two once they crowd", () => {
    expect(tickRows(WIDE, 1)).toBe(1);
    expect(tickRows(WIDE, 0.1)).toBe(2);
    expect(tickRows(NARROW, 0.4)).toBe(2);
  });
  it("lays a crowded list of names in two columns on a wide stage and one on a narrow stage", () => {
    const spec = specFor("ranked-bars", { x: { dim: "folderPath", sort: "count" }, top: 60 });
    const columnsOf = (stage: ReturnType<typeof chartStageOf>) => {
      const res = runChart(index, spec, vis, { now: NOW, stage });
      const names = labels(res.overlay.items).filter((l) => l.style === "axis" && l.align === "right");
      return { names, xs: new Set(names.map((l) => l.at[0].toFixed(3))) };
    };
    const wide = columnsOf(WIDE);
    const narrow = columnsOf(NARROW);
    expect(wide.xs.size).toBe(2);
    expect(narrow.xs.size).toBe(1);
    // The second column is cut short to sit beside the first.
    expect(Math.max(...wide.names.map((l) => l.text.length))).toBeLessThanOrEqual(24);
    const short = wide.names.filter((l) => l.at[0] < Math.max(...wide.names.map((n) => n.at[0])));
    for (const l of short) expect(l.text.length).toBeLessThanOrEqual(12);
  });
  it("lays out without a stage as before (one column of names)", () => {
    const res = runChart(index, specFor("ranked-bars"), vis, { now: NOW });
    expect(res.arr.length).toBe(index.count * 3);
  });
});

describe("Grid perspective (CHART-11)", () => {
  const spec = specFor("matrix", { x: { dim: "source", sort: "count" }, y: { dim: "space", sort: "count" } });
  it("defaults on and reads the option", () => {
    expect(matrixPerspective({})).toBe(true);
    expect(matrixPerspective({ perspective: false })).toBe(false);
    const toggle = CHART_OPTIONS.matrix?.find((o) => o.kind === "toggle" && o.key === "perspective");
    expect(toggle).toMatchObject({ kind: "toggle", fallback: true, label: "chart.perspective" });
    expect(t("chart.perspective")).toBe("Perspective");
  });
  it("recedes the rows in depth under a pitched camera", () => {
    const res = runChart(index, spec, vis, { now: NOW });
    const rowMarks = res.overlay.marks.map((m) => ({ y: m.bounds.min[1], z: (m.bounds.min[2] + m.bounds.max[2]) / 2 }));
    const rows = new Map<string, number>();
    for (const m of rowMarks) rows.set(m.y.toFixed(3), m.z);
    expect(rows.size).toBeGreaterThan(1);
    const zs = [...rows.entries()].sort((a, b) => Number(b[0]) - Number(a[0])).map((e) => e[1]);
    for (let i = 1; i < zs.length; i++) expect(zs[i]!).toBeGreaterThan(zs[i - 1]!);
    expect(zs[zs.length - 1]! - zs[0]!).toBeLessThanOrEqual(MATRIX_DEPTH_SPAN + 1e-6);
    expect(res.camera.tiltDeg).toBe(20);
    expect(res.camera.keepUpright).toBe(true);
    // The particles of each row sit at its depth, and the row names carry it too.
    const rowNames = labels(res.overlay.items).filter((l) => parseRef(l.key)?.y !== undefined);
    expect(new Set(rowNames.map((l) => l.at[2].toFixed(3))).size).toBe(rowNames.length);
    // Column labels stay rotated when the cells are narrow.
    const rotated = labels(res.overlay.items).filter((l) => l.rotate !== undefined);
    if (rotated.length > 0) expect(rotated.every((l) => l.rotate === -40)).toBe(true);
  });
  it("stays flat with Perspective off", () => {
    const res = runChart(index, { ...spec, options: { perspective: false } }, vis, { now: NOW });
    expect(res.camera.tiltDeg).toBe(0);
    for (const m of res.overlay.marks) expect(m.bounds.min[2]).toBeCloseTo(-0.1, 6);
    for (let i = 2; i < res.arr.length; i += 3) if (Number.isFinite(res.arr[i]!)) expect(Math.abs(res.arr[i]!)).toBeLessThan(0.2);
  });
});

describe("Wheel (CHART-13)", () => {
  const spec = specFor("radial-heatmap", { x: { dim: "weekday", sort: "date" }, y: { dim: "source", sort: "count" } });
  const res = runChart(index, spec, vis, { now: NOW });
  const radius = (x: number, y: number) => Math.hypot(x, y);
  it("keeps the rings inside the wedges' crown", () => {
    let ringMax = 0;
    for (let i = 0; i < res.arr.length; i += 3) {
      const x = res.arr[i]!;
      if (Number.isFinite(x)) ringMax = Math.max(ringMax, radius(x, res.arr[i + 1]!));
    }
    const outer = 3.45;
    expect(ringMax).toBeLessThanOrEqual(outer * WHEEL_RINGS_END + 1e-6);
    // The wedges' hit regions lie in the crown beyond the rings.
    const crown = res.overlay.marks.filter((m) => {
      const ref = parseRef(m.key);
      return ref?.x !== undefined && ref.y === undefined;
    });
    expect(crown.length).toBeGreaterThan(1);
    for (const m of crown) {
      const cx = (m.bounds.min[0] + m.bounds.max[0]) / 2;
      const cy = (m.bounds.min[1] + m.bounds.max[1]) / 2;
      expect(radius(cx, cy)).toBeGreaterThan(outer * WHEEL_RINGS_END);
      expect(radius(cx, cy)).toBeLessThan(outer);
    }
  });
  it("runs the ring names up the top spoke, stacked by radius, with a tick above the rim", () => {
    const ringNames = labels(res.overlay.items).filter((l) => parseRef(l.key)?.y !== undefined);
    expect(ringNames.length).toBeGreaterThan(1);
    for (const l of ringNames) expect(Math.abs(l.at[0])).toBeLessThan(0.1);
    const ys = ringNames.map((l) => l.at[1]);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(new Set(ys).size).toBe(ys.length);
    const tick = res.overlay.items.find((i) => i.type === "line" && i.a[0] === 0 && i.b[0] === 0 && i.a[1] > 3.4 && i.alpha >= 0.9);
    expect(tick).toBeDefined();
    // The sector names stay around the rim.
    const rim = labels(res.overlay.items).filter((l) => parseRef(l.key)?.x !== undefined && parseRef(l.key)?.y === undefined);
    expect(rim.length).toBeGreaterThan(1);
    for (const l of rim) expect(radius(l.at[0], l.at[1])).toBeGreaterThan(3.45);
  });
  it("keeps a single annulus when there are no rings", () => {
    const flat = runChart(index, { ...spec, y: null }, vis, { now: NOW });
    let max = 0;
    for (let i = 0; i < flat.arr.length; i += 3) if (Number.isFinite(flat.arr[i]!)) max = Math.max(max, radius(flat.arr[i]!, flat.arr[i + 1]!));
    expect(max).toBeGreaterThan(3.45 * WHEEL_RINGS_END);
  });
});

describe("Shells rows (CHART-16)", () => {
  const spec = specFor("nested-bubbles", { x: { dim: "space", sort: "count" }, colour: "source" });
  it("has one row per group and one sphere per value in the row", () => {
    const res = runChart(index, spec, vis, { now: NOW });
    const groupRefs = new Set(res.overlay.marks.map((m) => parseRef(m.key)?.x?.[1]));
    const rowYs = new Set(res.overlay.marks.map((m) => ((m.bounds.min[1] + m.bounds.max[1]) / 2).toFixed(3)));
    expect(groupRefs.size).toBeGreaterThan(0);
    expect(groupRefs.size).toBeLessThanOrEqual(SHELL_ROWS_MAX);
    expect(rowYs.size).toBe(groupRefs.size);
    const rowNames = labels(res.overlay.items).filter((l) => l.align === "right" && parseRef(l.key)?.x !== undefined);
    expect(rowNames.length).toBe(groupRefs.size);
    // One sphere per (group, value): no pair twice.
    const pairs = res.overlay.marks.map((m) => m.key);
    expect(new Set(pairs).size).toBe(pairs.length);
  });
  it("sizes spheres by the cube root of their count", () => {
    const res = runChart(index, spec, vis, { now: NOW });
    const marks = res.overlay.marks.filter((m) => parseRef(m.key)?.y !== undefined);
    const big = marks.reduce((a, m) => (m.count > a.count ? m : a));
    const small = marks.reduce((a, m) => (m.count < a.count ? m : a));
    if (big.count > small.count * 2) {
      const radius = (m: typeof big) => (m.bounds.max[0] - m.bounds.min[0]) / 2;
      expect(radius(big)).toBeGreaterThan(radius(small));
    }
  });
  it("lays the particles of a sphere along spiral arms, not a scatter", () => {
    const a: [number, number, number] = [0, 0, 0];
    const dirs: number[][] = [];
    for (let k = 0; k < 60; k++) dirs.push([...swirlDir(k, 60, 3, 2.5, 0.4, a)]);
    for (const d of dirs) expect(Math.hypot(d[0]!, d[1]!, d[2]!)).toBeCloseTo(1, 6);
    // Same arm: the angle advances with the position along it (a winding), and the poles are covered.
    expect(dirs[0]![2]!).toBeGreaterThan(0.9);
    expect(dirs[57]![2]!).toBeLessThan(-0.9);
    expect(swirlDir(5, 60, 3, 2.5, 0.4, [0, 0, 0])).toEqual(dirs[5]);
  });
  it("still draws the nested shells on request", () => {
    const res = runChart(index, { ...spec, options: { form: "nested" } }, vis, { now: NOW });
    expect(res.overlay.items.some((i) => i.type === "polyline")).toBe(true);
  });
});

describe("Folders treemap drill-in (CHART-19)", () => {
  const spec = specFor("treemap", { x: { dim: "folderPath", sort: "count" } });
  const whole = runChart(index, spec, vis, { now: NOW });
  const placed = (arr: Float32Array) => {
    let n = 0;
    for (let i = 0; i < arr.length; i += 3) if (Number.isFinite(arr[i]! + arr[i + 1]! + arr[i + 2]!)) n++;
    return n;
  };
  /** A folder with folders inside it. */
  function drillable(): string {
    const paths = whole.overlay.marks.flatMap((m) => {
      const ref = parseRef(m.key);
      return ref?.drill !== undefined ? [ref.drill] : [];
    });
    expect(paths.length).toBeGreaterThan(0);
    return paths[0]!;
  }
  it("reads and writes the root option", () => {
    expect(treemapRoot({})).toBe("");
    expect(treemapRoot({ root: "a/b" })).toBe("a/b");
    expect(withTreemapRoot({ allLevels: true }, "a")).toEqual({ allLevels: true, root: "a" });
    expect(withTreemapRoot({ root: "a" }, "")).toEqual({});
  });
  it("marks the boxes that have folders inside with the folder a click zooms into", () => {
    const root = drillable();
    expect(typeof root).toBe("string");
    // The whole tree has no crumb.
    expect(labels(whole.overlay.items).some((l) => l.screen === true)).toBe(false);
  });
  it("lays out only the subtree and emits a crumb of clickable segments", () => {
    const root = drillable();
    const res = runChart(index, { ...spec, options: { root } }, vis, { now: NOW });
    expect(placed(res.arr)).toBeGreaterThan(0);
    expect(placed(res.arr)).toBeLessThan(placed(whole.arr));
    for (const m of res.overlay.marks) {
      const x = parseRef(m.key)?.x?.[1] ?? "";
      expect(x === root || x.startsWith(root + "/")).toBe(true);
    }
    const crumb = labels(res.overlay.items).filter((l) => l.screen === true);
    const segments = crumb.filter((l) => parseRef(l.key)?.drill !== undefined);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(parseRef(segments[0]!.key)).toEqual({ copy: "chart.crumbAll", drill: "" });
    expect(parseRef(segments[segments.length - 1]!.key)?.drill).toBe(root);
    expect(crumb.some((l) => l.text === "›")).toBe(true);
    // Top-left in screen space: CSS px from the corner, left to right.
    for (const l of crumb) {
      expect(l.align).toBe("left");
      expect(l.at[1]).toBeLessThan(40);
    }
    const xs = crumb.map((l) => l.at[0]);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(t("chart.crumbAll")).toBe("All");
  });
  it("sets and clears the root on the leaf's chart when a crumb segment or a box is clicked", () => {
    const store = createLeafStore();
    store.update("view", (v) => ({ ...v, shape: "chart" as const, chart: spec }));
    drillTreemap(store, "a/b");
    expect(store.get("view").chart?.options.root).toBe("a/b");
    drillTreemap(store, "");
    expect(store.get("view").chart?.options.root).toBeUndefined();
    store.update("view", (v) => ({ ...v, chart: { ...spec, chart: "matrix" as const } }));
    drillTreemap(store, "a");
    expect(store.get("view").chart?.options.root).toBeUndefined();
  });
  it("shows the whole tree for a root that is not there", () => {
    const res = runChart(index, { ...spec, options: { root: "no/such/folder" } }, vis, { now: NOW });
    expect(placed(res.arr)).toBe(placed(whole.arr));
    expect(labels(res.overlay.items).some((l) => l.screen === true)).toBe(false);
  });
});

describe("Hub link fan over a chart (CHART-10)", () => {
  it("fans over the chart's arrangement positions", () => {
    const res = runChart(index, specFor("ranked-bars"), vis, { now: NOW });
    const anat = new Float32Array(res.arr.length).fill(0);
    expect(fanPositions("chart", 1, 0.85, anat, res.arr)).toBe(res.arr);
    let a = -1;
    let b = -1;
    for (let o = 0; o < res.arr.length / 3; o++) {
      if (!Number.isFinite(res.arr[o * 3]!)) continue;
      if (a < 0) a = o;
      else {
        b = o;
        break;
      }
    }
    const fan = buildHubFan(fanPositions("chart", 1, 0.85, anat, res.arr)!, null, a, [b]);
    expect(fan.segments).toBe(1);
    expect(fan.positions[0]).toBe(res.arr[a * 3]);
    expect(fan.positions[3]).toBe(res.arr[b * 3]);
  });
});
