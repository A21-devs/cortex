/**
 * Chart controls (Waves scale, smoothing and window; Counts and Links on every chart; semantic zoom): the smoothing
 * maths, the options both sides read, the options the Chart page offers per chart, and what a layout adds on top.
 */
import { describe, expect, it } from "vitest";
import { countsOn, linksAvailable, linksOn, waveScale, waveSmoothing, waveWindowDays } from "../src/shared/chartOptions";
import { CHART_CATALOGUE, CHART_IDS } from "../src/shared/views";
import type { ChartSpec } from "../src/shared/protocol/worker";
import { optionsFor } from "../src/ui/pages/ChartPage";
import { GIVE_WAY, LINK_CAP, MEMBER_LABEL_CAP, MEMBERS_PER_CELL } from "../src/worker/charts/annotations";
import { defaultVisibility } from "../src/worker/charts/common";
import { parseRef } from "../src/ui/stage/ChartOverlay";
import { runChart } from "../src/worker/charts/registry";
import { exponentialAverage, movingAverage, scaleSeries, smoothSeries, windowBins } from "../src/worker/charts/smoothing";
import { buildSampleIndex } from "../src/worker/sampleIndex";
import { emptyIndex } from "../src/shared/indexCodec";
import { AXIS_ROLES, capKey, COLOUR_KEY_CAP, ORDER_CHOICES } from "../src/shared/chartAxes";
import { closeSheet, markChartOpenedByPage, openTab, openPage, setChartCloseHook, setMorph, setShape, setSheetCollapsed } from "../src/state/actions";
import { createLeafStore } from "../src/state/store";
import type { LegendModel } from "../src/shared/protocol/worker";
import { sheetFolded, stageBox } from "../src/ui/breakpoints";
import { dismissChartAreaOffer, emptyDeviceState, parseDeviceState } from "../src/ui/deviceState";
import { fieldLabels } from "../src/ui/pages/chart/ChartAxesSection";
import { applyAreaColour, arrangementOf, chooseArrangement, closeChartToBrain, legendDots, offersAreaColour, openChartShape, withAxisOrder } from "../src/ui/pages/chart/chartPanel";

const NOW = Date.UTC(2026, 10, 10);
const index = buildSampleIndex(20261110, NOW);
const vis = defaultVisibility(index.count);

function specFor(chart: ChartSpec["chart"], options: ChartSpec["options"] = {}): ChartSpec {
  const g = CHART_CATALOGUE.find((c) => c.id === chart)!.group;
  const base: ChartSpec = { chart, x: { dim: g === "time" ? "week" : g === "rhythm" ? "hour" : "space", sort: g === "time" ? "date" : "count" }, y: null, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options };
  if (chart === "matrix" || chart === "alluvial" || chart === "chord" || chart === "clusters-3d" || chart === "radial-heatmap") return { ...base, y: { dim: "source", sort: "count" } };
  if (chart === "diverging-area") return { ...base, x: { dim: "month", sort: "date" } };
  if (chart === "ridgeline" || chart === "stream" || chart === "timeline-lanes" || chart === "arc-diagram" || chart === "radial-clock") return { ...base, y: { dim: "space", sort: "count" } };
  return base;
}

const f = (...v: number[]) => Float64Array.from(v);
const arr = (a: Float64Array) => Array.from(a);

describe("smoothing maths", () => {
  it("turns a window in days into whole bins, at least one", () => {
    expect(windowBins(7, "day")).toBe(7);
    expect(windowBins(90, "week")).toBe(13);
    expect(windowBins(7, "week")).toBe(1);
    expect(windowBins(7, "month")).toBe(1);
    expect(windowBins(90, "month")).toBe(3);
  });
  it("moving average: centred mean, edges average what is there, a window of one changes nothing", () => {
    expect(arr(movingAverage(f(0, 0, 9, 0, 0), 3))).toEqual([0, 3, 3, 3, 0]);
    expect(arr(movingAverage(f(3, 6, 9), 3))).toEqual([4.5, 6, 7.5]);
    expect(arr(movingAverage(f(1, 2, 3), 1))).toEqual([1, 2, 3]);
    expect(arr(movingAverage(f(4, 4, 4, 4), 4))).toEqual([4, 4, 4, 4]);
  });
  it("moving average with an even window stays centred: a symmetric spike stays symmetric", () => {
    const out = movingAverage(f(0, 0, 0, 0, 12, 0, 0, 0, 0), 4);
    for (let i = 0; i < 4; i++) expect(out[i]).toBeCloseTo(out[8 - i]!, 9);
    expect(out[4]).toBeCloseTo(Math.max(...out), 9);
    expect(out.reduce((a, v) => a + v, 0)).toBeCloseTo(12, 6);
  });
  it("moving average keeps an interior spike's total and its place", () => {
    const out = movingAverage(f(0, 0, 0, 0, 12, 0, 0, 0, 0), 5);
    expect(out.reduce((a, v) => a + v, 0)).toBeCloseTo(12, 6);
    expect(out[4]).toBe(Math.max(...out));
    expect(out[1]).toBe(0);
    expect(out[7]).toBe(0);
  });
  it("exponential average: symmetric, bounded by the data, flat stays flat, the peak stays in place", () => {
    const flat = exponentialAverage(f(5, 5, 5, 5, 5), 7);
    expect(arr(flat).every((v) => Math.abs(v - 5) < 1e-9)).toBe(true);
    const out = exponentialAverage(f(0, 0, 0, 0, 10, 0, 0, 0, 0), 7);
    expect(out.indexOf(Math.max(...out))).toBe(4);
    for (let i = 0; i < 4; i++) expect(out[i]).toBeCloseTo(out[8 - i]!, 9);
    expect(Math.max(...out)).toBeLessThan(10);
    expect(Math.min(...out)).toBeGreaterThanOrEqual(0);
    expect(arr(exponentialAverage(f(1, 2, 3), 1))).toEqual([1, 2, 3]);
    expect(exponentialAverage(new Float64Array(0), 5).length).toBe(0);
  });
  it("a longer window smooths more", () => {
    const spike = f(0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0);
    expect(movingAverage(spike, 7)[6]!).toBeLessThan(movingAverage(spike, 3)[6]!);
    expect(exponentialAverage(spike, 13)[6]!).toBeLessThan(exponentialAverage(spike, 3)[6]!);
  });
  it("smoothSeries picks the method; None returns the series itself", () => {
    const s = f(0, 6, 0);
    expect(smoothSeries(s, "none", 5)).toBe(s);
    expect(arr(smoothSeries(s, "moving", 3))).toEqual(arr(movingAverage(s, 3)));
    expect(arr(smoothSeries(s, "exponential", 3))).toEqual(arr(exponentialAverage(s, 3)));
  });
  it("scales: linear is untouched; square root and log lift small values and keep order", () => {
    const s = f(0, 1, 4, 9);
    expect(scaleSeries(s, "linear")).toBe(s);
    expect(arr(scaleSeries(s, "sqrt"))).toEqual([0, 1, 2, 3]);
    const lg = scaleSeries(s, "log");
    expect(lg[0]).toBe(0);
    expect(lg[3]).toBeCloseTo(Math.log1p(9), 12);
    expect(lg[1]! < lg[2]! && lg[2]! < lg[3]!).toBe(true);
    const ratio = (a: Float64Array) => a[1]! / a[3]!;
    expect(ratio(s)).toBeLessThan(ratio(scaleSeries(s, "sqrt")));
    expect(ratio(s)).toBeLessThan(ratio(lg));
  });
});

describe("shared chart options", () => {
  it("reads Waves options with defaults, and an older smoothingDays as a moving average", () => {
    expect(waveScale({})).toBe("linear");
    expect(waveScale({ scale: "sqrt" })).toBe("sqrt");
    expect(waveScale({ scale: "log" })).toBe("log");
    expect(waveScale({ scale: "cubic" })).toBe("linear");
    expect(waveSmoothing({})).toBe("none");
    expect(waveSmoothing({ smoothing: "exponential" })).toBe("exponential");
    expect(waveSmoothing({ smoothingDays: 14 })).toBe("moving");
    expect(waveSmoothing({ smoothing: "none", smoothingDays: 14 })).toBe("none");
    expect(waveWindowDays({})).toBe(30);
    expect(waveWindowDays({ windowDays: "90" })).toBe(90);
    expect(waveWindowDays({ windowDays: "12" })).toBe(30);
    expect(waveWindowDays({ smoothingDays: 14 })).toBe(14);
  });
  it("Counts default on where the count is the point; Links off, and absent on connection charts", () => {
    expect(countsOn("matrix", {})).toBe(true);
    expect(countsOn("matrix", { counts: false })).toBe(false);
    expect(countsOn("treemap", {})).toBe(false);
    expect(countsOn("treemap", { counts: true })).toBe(true);
    expect(linksOn("matrix", {})).toBe(false);
    expect(linksOn("matrix", { links: true })).toBe(true);
    for (const id of ["alluvial", "chord", "arc-diagram"] as const) {
      expect(linksAvailable(id)).toBe(false);
      expect(linksOn(id, { links: true })).toBe(false);
    }
  });
});

describe("the Chart page's options per chart", () => {
  it("offers Counts on every chart and Links on every chart that is not a drawing of connections", () => {
    for (const id of CHART_IDS) {
      const keys = optionsFor(id).map((o) => o.key);
      expect(keys.filter((k) => k === "counts")).toHaveLength(1);
      expect(keys.includes("links")).toBe(linksAvailable(id));
    }
  });
  it("Waves: Scale (3), Smoothing (3), Window (3, only once smoothing is on), own peak", () => {
    const o = optionsFor("ridgeline");
    const choices = (k: string) => (o.find((c) => c.key === k) as { choices: unknown[] }).choices.length;
    expect(choices("scale")).toBe(3);
    expect(choices("smoothing")).toBe(3);
    expect(choices("windowDays")).toBe(3);
    const win = o.find((c) => c.key === "windowDays")!;
    expect(win.when?.({})).toBe(false);
    expect(win.when?.({ smoothing: "moving" })).toBe(true);
    expect(o.find((c) => c.key === "normalise")?.kind).toBe("toggle");
  });
  it("shows the default each toggle really has", () => {
    expect(optionsFor("matrix").find((c) => c.key === "counts")).toMatchObject({ fallback: true });
    expect(optionsFor("calendar-heatmap").find((c) => c.key === "counts")).toMatchObject({ fallback: true });
    expect(optionsFor("treemap").find((c) => c.key === "counts")).toMatchObject({ fallback: false });
  });
});

type Result = ReturnType<typeof runChart>;
const labels = (res: Result) => res.overlay.items.filter((i): i is Extract<typeof i, { type: "label" }> => i.type === "label");
const lineCount = (res: Result) => res.overlay.items.filter((i) => i.type === "line").length;
const isCount = (text: string) => /^[\d,]+$/.test(text);
const numeric = (res: Result) => labels(res).filter((l) => l.style === "muted" && isCount(l.text)).length;

describe("Waves options reach the layout", () => {
  const rows = (opt: ChartSpec["options"]) => {
    const res = runChart(index, specFor("ridgeline", opt), vis, { now: NOW });
    return JSON.stringify(res.overlay.items.filter((i) => i.type === "polyline"));
  };
  it("each choice draws a different curve; Window matters only with smoothing; own peak changes row heights", () => {
    const base = rows({});
    expect(rows({ scale: "sqrt" })).not.toBe(base);
    expect(rows({ scale: "log" })).not.toBe(rows({ scale: "sqrt" }));
    expect(rows({ smoothing: "moving", windowDays: "90" })).not.toBe(base);
    expect(rows({ smoothing: "exponential", windowDays: "90" })).not.toBe(rows({ smoothing: "moving", windowDays: "90" }));
    expect(rows({ smoothing: "none", windowDays: "90" })).toBe(base);
    expect(rows({ normalise: true })).not.toBe(base);
  });
});

describe("Counts", () => {
  it("draws a count per cell, bar or group when on; none when off", () => {
    for (const id of ["treemap", "bubble-pack", "clusters-3d", "radial-heatmap", "timeline-lanes"] as const) {
      const on = runChart(index, specFor(id, { counts: true }), vis, { now: NOW });
      const off = runChart(index, specFor(id, { counts: false }), vis, { now: NOW });
      expect(numeric(on), id).toBeGreaterThan(numeric(off));
    }
  });
  it("matrix and calendar keep their counts by default and lose them when switched off", () => {
    for (const id of ["matrix", "calendar-heatmap"] as const) {
      expect(numeric(runChart(index, specFor(id), vis, { now: NOW })), id).toBeGreaterThan(0);
      expect(numeric(runChart(index, specFor(id, { counts: false }), vis, { now: NOW })), id).toBe(0);
    }
  });
  it("ranked bars and icicle draw their end counts, switched off by the toggle", () => {
    for (const id of ["ranked-bars", "icicle"] as const) {
      const n = (opt: ChartSpec["options"]) => numeric(runChart(index, specFor(id, opt), vis, { now: NOW }));
      expect(n({}), id).toBeGreaterThan(0);
      expect(n({ counts: false }), id).toBe(0);
    }
  });
  it("a count shows from 18 px and gives way when the cell's members are named", () => {
    const counts = labels(runChart(index, specFor("matrix"), vis, { now: NOW })).filter((l) => isCount(l.text));
    for (const c of counts) expect(parseRef(c.key)?.zoom).toBeGreaterThan(0);
    expect(counts.some((c) => parseRef(c.key)?.zoomMax !== undefined)).toBe(true);
  });
});

describe("Semantic zoom: member labels", () => {
  it("names the biggest members of a cell at their own particles, hidden until the cell is large", () => {
    const res = runChart(index, specFor("matrix", { counts: false }), vis, { now: NOW });
    const members = labels(res).filter((l) => parseRef(l.key)?.zoom !== undefined);
    expect(members.length).toBeGreaterThan(0);
    expect(members.length).toBeLessThanOrEqual(MEMBER_LABEL_CAP);
    for (const m of members) {
      expect(m.text.length).toBeLessThanOrEqual(28);
      expect(m.at.every(Number.isFinite)).toBe(true);
      expect(parseRef(m.key)?.zoomMax).toBeUndefined();
    }
    // No cell is named for more than MEMBERS_PER_CELL members: count the labels placed inside each mark.
    for (const mark of res.overlay.marks) {
      const inside = members.filter((m) => m.at[0] >= mark.bounds.min[0] && m.at[0] <= mark.bounds.max[0] + 0.05 && m.at[1] >= mark.bounds.min[1] && m.at[1] <= mark.bounds.max[1]);
      expect(inside.length).toBeLessThanOrEqual(MEMBERS_PER_CELL * 4);
    }
    expect(GIVE_WAY).toBeCloseTo(0.15, 10);
  });
  it("works with nothing placed", () => {
    const empty = runChart(index, { ...specFor("matrix", { links: true }), filter: [{ dim: "space", value: "no-such-area" }] }, vis, { now: NOW });
    expect(numeric(empty)).toBe(0);
    expect(lineCount(empty)).toBe(0);
  });
});

describe("Links", () => {
  it("draws a line for each link between two placed notes, none when off", () => {
    const withLinks = runChart(index, specFor("matrix", { links: true }), vis, { now: NOW });
    const without = runChart(index, specFor("matrix", { links: false }), vis, { now: NOW });
    expect(lineCount(withLinks)).toBeGreaterThan(lineCount(without));
    expect(lineCount(withLinks) - lineCount(without)).toBeLessThanOrEqual(LINK_CAP);
  });
  it("only joins placed particles", () => {
    const res = runChart(index, specFor("matrix", { links: true }), vis, { now: NOW });
    const base = runChart(index, specFor("matrix"), vis, { now: NOW });
    const placed = new Set<string>();
    for (let o = 0; o < index.count; o++) if (Number.isFinite(res.arr[o * 3]!)) placed.add(`${res.arr[o * 3]},${res.arr[o * 3 + 1]},${res.arr[o * 3 + 2]}`);
    const extra = res.overlay.items.filter((i) => i.type === "line").slice(lineCount(base)) as { a: number[]; b: number[] }[];
    expect(extra.length).toBeGreaterThan(0);
    for (const l of extra) {
      expect(placed.has(`${l.a[0]},${l.a[1]},${l.a[2]}`)).toBe(true);
      expect(placed.has(`${l.b[0]},${l.b[1]},${l.b[2]}`)).toBe(true);
    }
  });
  it("is ignored on charts that are themselves connections", () => {
    for (const id of ["alluvial", "chord", "arc-diagram"] as const) {
      expect(lineCount(runChart(index, specFor(id, { links: true }), vis, { now: NOW })), id).toBe(lineCount(runChart(index, specFor(id), vis, { now: NOW })));
    }
  });
  it("every chart still lays out with Counts and Links on", () => {
    for (const id of CHART_IDS) {
      const res = runChart(index, specFor(id, { counts: true, links: true }), vis, { now: NOW });
      expect(res.arr.length).toBe(index.count * 3);
    }
  });
});

describe("An empty index", () => {
  it("lays out every chart with Counts and Links on, placing nothing", () => {
    const empty = emptyIndex();
    const ev = defaultVisibility(empty.count);
    for (const id of CHART_IDS) {
      const res = runChart(empty, specFor(id, { counts: true, links: true, smoothing: "exponential" }), ev, { now: NOW });
      expect(res.arr.length, id).toBe(0);
      expect(lineCount(res), id).toBe(0);
    }
  });
});

describe("Chart page: close returns to the brain, open sets the chart shape", () => {
  const now = (fn: () => void): undefined => {
    fn();
    return undefined;
  };
  it("closing the page that opened the chart animates to the brain and sets the shape to body", () => {
    const store = createLeafStore();
    markChartOpenedByPage(store, true);
    setShape(store, "chart");
    setMorph(store, 1);
    const targets: number[] = [];
    const did = closeChartToBrain(
      store,
      (to) => {
        targets.push(to);
        setMorph(store, to);
      },
      now,
    );
    expect(did).toBe(true);
    expect(targets).toEqual([0]);
    expect(store.get("view").shape).toBe("body");
    expect(store.get("view").morph).toBe(0);
  });
  it("a chart the user chose another way goes back too; Groups stays", () => {
    const store = createLeafStore();
    markChartOpenedByPage(store, false);
    setShape(store, "chart");
    setMorph(store, 1);
    const targets: number[] = [];
    expect(closeChartToBrain(store, (to) => (targets.push(to), setMorph(store, to)), now)).toBe(true);
    expect(targets).toEqual([0]);
    expect(store.get("view")).toMatchObject({ shape: "body", morph: 0 });
    const g = createLeafStore();
    setShape(g, "groups");
    setMorph(g, 1);
    expect(closeChartToBrain(g, (to) => setMorph(g, to), now)).toBe(false);
    expect(g.get("view")).toMatchObject({ shape: "groups", morph: 1 });
  });
  it("closeSheet on the Chart page runs the page's hook; another page's close does not", () => {
    const store = createLeafStore();
    openPage(store, "chart");
    markChartOpenedByPage(store, true);
    setShape(store, "chart");
    setMorph(store, 1);
    setChartCloseHook(store, () => void closeChartToBrain(store, (to) => setMorph(store, to), now));
    closeSheet(store);
    expect(store.get("ui").sheet.open).toBe(false);
    expect(store.get("view").shape).toBe("body");
    openPage(store, "time");
    setShape(store, "chart");
    setMorph(store, 1);
    markChartOpenedByPage(store, true);
    closeSheet(store);
    expect(store.get("view").shape).toBe("chart");
  });
  it("the Brain tab closes the Chart page like x, and a fold does not survive opening another page", () => {
    const store = createLeafStore();
    openPage(store, "chart");
    markChartOpenedByPage(store, true);
    setShape(store, "chart");
    setMorph(store, 1);
    setSheetCollapsed(store, true);
    openTab(store, "brain");
    expect(store.get("view")).toMatchObject({ shape: "body", morph: 0 });
    expect(store.get("ui").sheet.collapsed).toBeFalsy();
    openPage(store, "chart");
    setSheetCollapsed(store, true);
    openTab(store, "time");
    expect(store.get("ui").sheet.collapsed).toBeFalsy();
  });
  it("closeSheet with no hook mounted still returns the figure to the brain", () => {
    const store = createLeafStore();
    openPage(store, "chart");
    markChartOpenedByPage(store, true);
    setShape(store, "chart");
    setMorph(store, 1);
    closeSheet(store);
    expect(store.get("view")).toMatchObject({ shape: "body", morph: 0 });
  });
  it("a page opened any way (rail, header, Display switch) takes its chart back on leaving; leaving for another page counts", () => {
    const store = createLeafStore();
    openPage(store, "chart");
    openChartShape(store, (to) => setMorph(store, to));
    expect(store.get("view").shape).toBe("chart");
    const targets: number[] = [];
    setChartCloseHook(store, () => void closeChartToBrain(store, (to) => (targets.push(to), setMorph(store, to)), now));
    openTab(store, "read");
    expect(targets).toEqual([0]);
    expect(store.get("view")).toMatchObject({ shape: "body", morph: 0 });
    expect(store.get("ui").sheet.stack[0]).toMatchObject({ route: expect.not.stringMatching(/^chart$/) });
  });
  it("a chart that was already out when the page opened goes back to the brain on every way out", () => {
    for (const leave of [(st: ReturnType<typeof createLeafStore>) => closeSheet(st), (st: ReturnType<typeof createLeafStore>) => openTab(st, "time"), (st: ReturnType<typeof createLeafStore>) => openTab(st, "brain")]) {
      const store = createLeafStore();
      setShape(store, "chart");
      setMorph(store, 1);
      openPage(store, "chart");
      openChartShape(store, () => undefined);
      const targets: number[] = [];
      setChartCloseHook(store, () => void closeChartToBrain(store, (to) => (targets.push(to), setMorph(store, to)), now));
      leave(store);
      expect(targets).toEqual([0]);
      expect(store.get("view")).toMatchObject({ shape: "body", morph: 0 });
    }
  });
  it("opening sets the chart shape, seeds the first chart and morphs to 1; the last chart is kept", () => {
    const store = createLeafStore();
    const targets: number[] = [];
    openChartShape(store, (to) => targets.push(to));
    const v = store.get("view");
    expect(v.shape).toBe("chart");
    expect(v.chart?.chart).toBe("ranked-bars");
    expect(targets).toEqual([1]);
    const last = specFor("matrix");
    const again = createLeafStore();
    again.update("view", { chart: last });
    openChartShape(again, () => undefined);
    expect(again.get("view").chart).toBe(last);
  });
  it("a Groups figure that is already out is left alone, and the switch shows it", () => {
    const store = createLeafStore();
    setShape(store, "groups");
    setMorph(store, 1);
    openChartShape(store, () => undefined);
    expect(store.get("view").shape).toBe("groups");
    expect(arrangementOf(store.get("view").shape)).toBe("groups");
    expect(arrangementOf("body")).toBe("chart");
  });
});

describe("Chart page: Groups | Chart switch", () => {
  it("sets the shape and morphs to it", () => {
    const store = createLeafStore();
    const targets: number[] = [];
    chooseArrangement(store, "groups", (to) => targets.push(to));
    expect(store.get("view").shape).toBe("groups");
    chooseArrangement(store, "chart", (to) => targets.push(to));
    expect(store.get("view").shape).toBe("chart");
    expect(store.get("view").chart).not.toBeNull();
    expect(targets).toEqual([1, 1]);
  });
  it("a choice made on the switch is kept when the page closes", () => {
    const store = createLeafStore();
    markChartOpenedByPage(store, true);
    chooseArrangement(store, "groups", (to) => setMorph(store, to));
    expect(closeChartToBrain(store, (to) => setMorph(store, to), (fn) => void fn())).toBe(false);
    expect(store.get("view").shape).toBe("groups");
  });
});

describe("Chart page: the sheet folds to its header", () => {
  it("is folded only while the Chart page is on top, and the stage takes the room back", () => {
    const store = createLeafStore();
    openPage(store, "chart");
    const ui = () => store.get("ui");
    expect(sheetFolded(ui().sheet)).toBe(false);
    setSheetCollapsed(store, true);
    expect(sheetFolded(ui().sheet)).toBe(true);
    const size = { width: 1400, height: 900 };
    const open = stageBox(size, { ...ui(), breakpoint: "XL", immersive: false, sheet: { ...ui().sheet, collapsed: false } });
    const folded = stageBox(size, { ...ui(), breakpoint: "XL", immersive: false });
    expect(folded.insetRight).toBe(0);
    expect(folded.width).toBeGreaterThan(open.width);
    setSheetCollapsed(store, false);
    expect(sheetFolded(ui().sheet)).toBe(false);
    setSheetCollapsed(store, true);
    openPage(store, "time");
    expect(sheetFolded(ui().sheet)).toBe(false);
    openPage(store, "chart");
    setSheetCollapsed(store, true);
    closeSheet(store);
    expect(ui().sheet.collapsed).toBeFalsy();
  });
});

describe("Chart page: axis role names and Order", () => {
  it("every chart names its axes; one-axis forms have one row; none says Horizontal or Vertical", () => {
    for (const id of CHART_IDS) {
      const roles = AXIS_ROLES[id];
      expect(roles.x, id).toBeTruthy();
      const labels = fieldLabels(id);
      expect(labels, id).toHaveLength(roles.y ? 3 : 2);
      expect(labels.some((l) => /^(Horizontal|Vertical)$/.test(l)), id).toBe(false);
      expect(labels[labels.length - 1]).toBe("Colour");
    }
  });
  it("names the axes of each form in Cortex's own words", () => {
    expect(fieldLabels("matrix")).toEqual(["Across", "Down", "Colour"]);
    expect(fieldLabels("radial-heatmap")).toEqual(["Around", "Rings", "Colour"]);
    expect(fieldLabels("nested-bubbles")).toEqual(["Spheres", "Shells", "Colour"]);
    expect(fieldLabels("alluvial")).toEqual(["From", "To", "Colour"]);
    expect(fieldLabels("clusters-3d")).toEqual(["Clusters by", "Then by", "Colour"]);
    expect(fieldLabels("calendar-heatmap")).toEqual(["Days", "Colour"]);
    expect(fieldLabels("ridgeline")[1]).toBe("Rows");
    expect(fieldLabels("timeline-lanes")[1]).toBe("Lanes");
  });
  it("the Order select writes the axis sort and nothing else", () => {
    const spec = specFor("matrix");
    expect(ORDER_CHOICES).toEqual(["count", "name", "date"]);
    const byName = withAxisOrder(spec, "x", "name");
    expect(byName.x.sort).toBe("name");
    expect(byName.y).toEqual(spec.y);
    const down = withAxisOrder(byName, "y", "date");
    expect(down.y?.sort).toBe("date");
    expect(down.x.sort).toBe("name");
    expect(withAxisOrder(spec, "x", spec.x.sort)).toBe(spec);
    expect(withAxisOrder({ ...spec, y: null }, "y", "name").y).toBeNull();
  });
});

describe("Chart page: colour key", () => {
  const row = (key: string, name: string, n: number) => ({ key, name, slot: 1, bucket: "value" as const, rgb: [0.1, 0.2, 0.3] as [number, number, number], notes: n, record: 0, hidden: false, depth: 0, expandable: false });
  const legend: LegendModel = { grandTotal: 30, sections: [{ population: "notes", dim: "space", total: 30, rows: [row("a", "Alpha", 20), row("b", "Beta", 10), { ...row("y", "2026", 5), aggregate: true }, { ...row("c", "Child", 1), depth: 1 }] }] };
  it("lists a dot and a name for each value of the dimension the stage key shows", () => {
    const dots = legendDots(legend, "space");
    expect(dots?.map((d) => d.name)).toEqual(["Alpha", "Beta"]);
    expect(dots?.[0]?.rgb).toEqual([0.1, 0.2, 0.3]);
    expect(legendDots(legend, "source")).toBeNull();
    expect(legendDots(null, "space")).toBeNull();
  });
  it("caps the key at 24 dots and counts the rest", () => {
    const dots = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, name: `V${i}`, rgb: [0, 0, 0] as [number, number, number] }));
    expect(COLOUR_KEY_CAP).toBe(24);
    const { shown, more } = capKey(dots);
    expect(shown).toHaveLength(24);
    expect(more).toBe(6);
    expect(capKey(dots.slice(0, 5))).toMatchObject({ more: 0 });
  });
});

describe("Chart page: Colour by area offer", () => {
  it("offers until the figure is coloured by area or the offer is dismissed, and applying sets notes to area", () => {
    const store = createLeafStore();
    store.update("view", (v) => ({ ...v, colour: { ...v.colour, notes: { kind: "categorical", dim: "source" } } }));
    expect(offersAreaColour(store.get("view").colour.notes, false)).toBe(true);
    expect(offersAreaColour(store.get("view").colour.notes, true)).toBe(false);
    applyAreaColour(store);
    expect(store.get("view").colour.notes).toEqual({ kind: "categorical", dim: "space" });
    expect(offersAreaColour(store.get("view").colour.notes, false)).toBe(false);
  });
  it("remembers the dismissal on the device", () => {
    const d = dismissChartAreaOffer(emptyDeviceState());
    expect(d.chartAreaOfferDismissed).toBe(true);
    expect(parseDeviceState(JSON.parse(JSON.stringify(d))).chartAreaOfferDismissed).toBe(true);
    expect(parseDeviceState({}).chartAreaOfferDismissed).toBeUndefined();
    expect(parseDeviceState({ chartAreaOfferDismissed: "yes" }).chartAreaOfferDismissed).toBeUndefined();
  });
});
