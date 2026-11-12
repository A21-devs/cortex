/**
 * Charts (owner E9; CORTEX-UX §7): one registry entry per catalogue chart, Top N folding into Other, readings
 * as numbers and names (never sentences), the dimension menu by provenance, the Chart page's helpers, the overlay's
 * refs, tokens and zones, Copy data as CSV on the bus, and every statistic the pages ask for.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { STARTER_PACKS } from "../src/shared/packs";
import { EventBus } from "../src/state/events";
import { createLeafStore } from "../src/state/store";
import { CHART_IDS, CHART_CATALOGUE } from "../src/shared/views";
import type { ChartSpec } from "../src/shared/protocol/worker";
import { CHARTS, runChart } from "../src/worker/charts/registry";
import { DEFAULT_TOP, defaultVisibility, foldLargest, NONE_VALUE, OTHER_VALUE, refKey, type ChartRef as WorkerRef } from "../src/worker/charts/common";
import { longestStreak, peakIndex } from "../src/worker/charts/readings";
import { fillSquare, laneRows, lifeSpan, tickLayout, waveEnvelope, waveRowZ } from "../src/worker/charts/time";
import { lanesShow } from "../src/shared/chartOptions";
import { COUNT_SCALE_MAX, countScale, GIVE_WAY_BAND, giveWayOpacity } from "../src/shared/chartZoom";
import type { ChartBuilder } from "../src/worker/charts/common";
import { buildSampleIndex } from "../src/worker/sampleIndex";
import { computeStats } from "../src/worker/stats";
import { chooserGroups } from "../src/ui/pages/chart/ChartChooser";
import { chartDescription, CHART_OPTIONS, clampTopN, folderIncluded, galleryGroups, setFolderIncluded, specForChart, tableParams, TOP_N, zoneFallback } from "../src/ui/pages/ChartPage";
import { dimMenuModel, flatDimItems } from "../src/ui/primitives/dimMenu";
import { addCombine, assignZone, bindCopyCsv, categoryName, chartCsv, csvCell, csvForLeaf, groupsCsv, isKnownDim, lifeText, markAt, nextSort, NONE_VALUE as UI_NONE, OTHER_VALUE as UI_OTHER, overlayLabelText, parseRef, refTokens, rowsToCsv, swapAxes, toggleFold, type ChartRef } from "../src/ui/stage/ChartOverlay";
import { bracketStyle, readingCategory, readingRef, readingText } from "../src/ui/stage/Readings";

const NOW = Date.UTC(2026, 10, 10);
const index = buildSampleIndex(20261110, NOW);
const vis = defaultVisibility(index.count);

function specFor(chart: ChartSpec["chart"]): ChartSpec {
  const g = CHART_CATALOGUE.find((c) => c.id === chart)!.group;
  const base: ChartSpec = { chart, x: { dim: g === "time" ? "week" : g === "rhythm" ? "hour" : "space", sort: g === "time" ? "date" : "count" }, y: null, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options: {} };
  if (chart === "matrix" || chart === "alluvial" || chart === "chord" || chart === "clusters-3d" || chart === "radial-heatmap") return { ...base, y: { dim: "source", sort: "count" } };
  if (chart === "diverging-area") return { ...base, x: { dim: "month", sort: "date" } };
  if (chart === "ridgeline" || chart === "stream" || chart === "timeline-lanes" || chart === "arc-diagram" || chart === "radial-clock") return { ...base, y: { dim: "space", sort: "count" } };
  return base;
}

describe("worker/charts", () => {
  it("registers a layout for every catalogue chart", () => {
    expect(Object.keys(CHARTS).sort()).toEqual([...CHART_IDS].sort());
  });
  it("folds the rest into Other after Top N (default 20, 5–60)", () => {
    const cats = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, label: `K${i}`, count: 30 - i }));
    const top = foldLargest(cats, DEFAULT_TOP);
    expect(top.length).toBe(21);
    expect(top[20]?.key).toBe("__other__");
    expect(top[20]?.count).toBe(55);
    expect(TOP_N).toEqual({ default: 20, min: 5, max: 60 });
    expect(clampTopN(2)).toBe(5);
    expect(clampTopN(99)).toBe(60);
  });
  it("computes readings as values, not sentences", () => {
    expect(longestStreak(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-07"])).toEqual({ length: 3, end: "2026-11-03" });
    expect(peakIndex([1, 9, 3])).toBe(1);
    expect(readingText({ kind: "peak", copyKey: "readings.peak", values: { label: "21:00" }, at: [0, 0, 0] })).toBe("21:00 · peak");
    expect(readingText({ kind: "run", copyKey: "readings.run", values: { n: 23 }, at: [0, 0, 0] })).toBe("23 days");
  });
  it.each(CHART_IDS.map((id) => [id]))("lays out %s on the sample record", (id) => {
    const res = runChart(index, specFor(id), vis, { now: NOW });
    expect(res.arr.length).toBe(index.count * 3);
    let placed = 0;
    for (let i = 0; i < res.arr.length; i += 3) if (Number.isFinite(res.arr[i]! + res.arr[i + 1]! + res.arr[i + 2]!)) placed++;
    expect(placed).toBeGreaterThan(0);
    expect((res.readings ?? []).length).toBeLessThanOrEqual(3);
    for (const r of res.readings ?? []) {
      expect(r.copyKey.startsWith("readings.")).toBe(true);
      expect(readingText(r)).not.toContain("readings.");
    }
    expect(res.camera.radius).toBeGreaterThan(0);
    for (const m of res.overlay.marks) expect(parseRef(m.key)).not.toBeNull();
  });
  it("does not change when asked twice (stable layouts)", () => {
    const a = runChart(index, specFor("ranked-bars"), vis, { now: NOW });
    const b = runChart(index, specFor("ranked-bars"), vis, { now: NOW });
    expect(Array.from(a.arr.slice(0, 300))).toEqual(Array.from(b.arr.slice(0, 300)));
  });
  it("rejects an unknown chart", () => {
    expect(() => runChart(index, { ...specFor("matrix"), chart: "pie" as never }, vis)).toThrow(/unknown chart/);
  });
});

describe("worker/stats: every statistic the pages ask for", () => {
  const opts = { now: NOW };
  it("answers each kind with its own shape", () => {
    const kinds: Record<string, unknown> = {
      strip: computeStats(index, { kind: "strip", bin: "auto", notesLane: true, ageColour: true, visibility: vis }, opts),
      spine: computeStats(index, { kind: "spine", visibility: vis }, opts),
      rhythm: computeStats(index, { kind: "rhythm", visibility: vis }, opts),
      hours: computeStats(index, { kind: "hours", visibility: vis }, opts),
      voices: computeStats(index, { kind: "voices", visibility: vis }, opts),
      data: computeStats(index, { kind: "data", rows: "space", columns: "none", measure: "entries", visibility: vis }, opts),
      read: computeStats(index, { kind: "read", view: "date", folder: null, preset: "all", pinnedOnly: false, sort: "newest", query: "", offset: 0, limit: 20, visibility: vis }, opts),
      sources: computeStats(index, { kind: "sources", visibility: vis }, opts),
      today: computeStats(index, { kind: "today", dayStart: NOW - 86_400_000 }, opts),
      packs: computeStats(index, { kind: "packs", includeSuperseded: false }, opts),
    };
    for (const [k, v] of Object.entries(kinds)) expect((v as { kind: string }).kind).toBe(k);
  });
  it("counts the same entries in the rhythm grid, the hours and the Data view", () => {
    const rh = computeStats(index, { kind: "rhythm", visibility: vis }, opts);
    const hr = computeStats(index, { kind: "hours", visibility: vis }, opts);
    const dt = computeStats(index, { kind: "data", rows: "source", columns: "none", measure: "entries", visibility: vis }, opts);
    if (rh.kind !== "rhythm" || hr.kind !== "hours" || dt.kind !== "data") throw new Error("shape");
    const grid = Array.from(rh.cells).reduce((a, b) => a + b, 0);
    const hours = Array.from(hr.counts).reduce((a, b) => a + b, 0);
    expect(rh.cells.length).toBe(168);
    expect(hr.counts.length).toBe(24);
    expect(grid).toBe(hours);
    expect(hr.counts[hr.peakHour]).toBe(Math.max(...Array.from(hr.counts)));
    expect(dt.rows.reduce((a, r) => a + r.total, 0)).toBeGreaterThanOrEqual(grid);
    for (const r of dt.rows) expect(r.share).toBeGreaterThanOrEqual(0);
  });
});

describe("ui: Chart page and the dimension menu (§5.25, §7.3)", () => {
  it("groups the gallery and falls back to the next dimension", () => {
    const groups = galleryGroups(false);
    expect(groups.map((g) => g.group)).toEqual(["compare", "time", "rhythm", "connections"]);
    expect(groups.flatMap((g) => g.charts)).not.toContain("chord");
    expect(galleryGroups(true).flatMap((g) => g.charts).length).toBe(20);
    expect(zoneFallback("space")).toBe("folder");
    expect(zoneFallback("folder")).toBe("month");
    expect(zoneFallback("space", "folder")).toBe("month");
  });
  it("offers every chart a chooser cell and offers the options of §7.2", () => {
    for (const id of CHART_IDS) expect(chooserGroups(true).flatMap((g) => g.charts)).toContain(id);
    expect(CHART_OPTIONS.ridgeline?.map((o) => o.key)).toEqual(["scale", "smoothing", "windowDays", "normalise"]);
    expect(CHART_OPTIONS.chord?.[0]?.key).toBe("weight");
    for (const id of Object.keys(CHART_OPTIONS)) expect(CHART_IDS).toContain(id);
  });
  it("keeps axes inside a group and reseeds across groups, never carrying chart options", () => {
    const prev = { ...specFor("matrix"), options: { counts: false }, size: "words" as const, top: 30 };
    const same = specForChart("treemap", prev, "space");
    expect(same.x).toEqual(prev.x);
    expect(same.size).toBe("words");
    expect(same.options).toEqual({});
    const other = specForChart("ridgeline", prev, "space");
    expect(other.x.dim).toBe("week");
    expect(other.top).toBe(30);
  });
  it("ticks folders and removes a whole subtree", () => {
    const spec = specFor("treemap");
    const off = setFolderIncluded(spec, "wiki/notes", false);
    expect(folderIncluded(off, "wiki/notes")).toBe(false);
    expect(folderIncluded(off, "wiki/notes/deep")).toBe(false);
    expect(folderIncluded(off, "wiki")).toBe(true);
    expect(folderIncluded(setFolderIncluded(off, "wiki/notes", true), "wiki/notes")).toBe(true);
    const res = runChart(index, off, vis, { now: NOW });
    expect(res.categories).toBeDefined();
  });
  it("opens the Data view with the chart's rows and columns", () => {
    expect(tableParams(specFor("matrix"))).toEqual({ view: "data", rows: "space", cols: "source", measure: "entries" });
    expect(tableParams({ ...specFor("ranked-bars"), x: { dim: "conversation", sort: "count" }, size: "words" })).toEqual({ view: "data", rows: "space", measure: "words" });
  });
  it("describes the chart Ask receives", () => {
    expect(chartDescription(specFor("calendar-heatmap"), null)).toContain("Calendar heatmap");
    expect(chartDescription({ ...specFor("calendar-heatmap"), colour: "source" }, null)).toContain("Source");
  });
  it("builds the provenance menu with Date first and pack fields under From the agents", () => {
    const m = dimMenuModel(STARTER_PACKS);
    expect(m.date.grains.map((g) => g.id)).toEqual(["day", "week", "month", "year"]);
    expect(m.date.rhythm.map((g) => g.id)).toEqual(["hour", "weekday", "monthOfYear"]);
    expect(dimMenuModel(STARTER_PACKS, "imported").date.grains[1]?.id).toBe("week:imported");
    const agents = m.sections.find((s) => s.group === "agents");
    expect(agents?.items.map((i) => i.id)).toContain("label:session/work");
    expect(agents?.items.map((i) => i.id)).not.toContain("label:correction/fixes");
    expect(m.sections.map((s) => s.label)).toEqual(["From the file", "From the conversation", "From the agents", "From you", "Your résumé"]);
    expect(flatDimItems(m).length).toBeGreaterThan(10);
  });
  it("renders the gallery without a model call or canned questions", () => {
    const html = render(<div>{galleryGroups(true).map((g) => g.charts.join(","))}</div>);
    expect(html).toContain("ranked-bars");
  });
});

describe("ui: the overlay's refs, names, tokens and zones (§7.1, §7.4)", () => {
  it("keeps the overlay's ChartRef and category keys in step with the worker's", () => {
    const ref: ChartRef = { x: ["space", "garden"], y: ["source", "chatgpt"], t: [1, 2], zoom: 0.3, zoomMax: 0.5, copy: "strip.today", span: [1, 2], fold: "a/b", or: [["space", "a"]] };
    const asWorker: WorkerRef = ref;
    expect(parseRef(refKey(asWorker))).toEqual(ref);
    expect(UI_NONE).toBe(NONE_VALUE);
    expect(UI_OTHER).toBe(OTHER_VALUE);
  });
  it("drops malformed refs instead of throwing", () => {
    expect(parseRef(undefined)).toBeNull();
    expect(parseRef("{")).toBeNull();
    expect(parseRef("[1]")).toBeNull();
    expect(parseRef('{"x":["space"],"t":["a",1],"copy":3}')).toEqual({});
  });
  it("names remainders and enum values from Cortex's own labels", () => {
    expect(categoryName("space", NONE_VALUE, "")).toBe("No area");
    expect(categoryName("month", NONE_VALUE, "")).toBe("Undated");
    expect(categoryName("project", OTHER_VALUE, "Other")).toBe("Other");
    expect(categoryName("source", "claude-code", "claude-code")).toBe("Claude Code");
    expect(categoryName("speaker", "assistant", "assistant")).toBe("Assistant");
    expect(categoryName("hour", "09", "09:00")).toBe("09:00");
  });
  it("resolves overlay label text: copy keys, categories, plain text", () => {
    expect(overlayLabelText("", { copy: "strip.today" })).toBe("today");
    expect(overlayLabelText("4", { copy: "chart.mapSources" })).toBe("4 of this map's sources");
    expect(overlayLabelText("x", { x: ["space", NONE_VALUE] })).toBe("No area");
    expect(overlayLabelText("1,284", null)).toBe("1,284");
    expect(overlayLabelText("a very long folder path that goes on and on", { x: ["folderPath", "a"] }).length).toBeLessThanOrEqual(24);
  });
  it("turns refs into tokens: x group, y band, time range, several OR-ed groups", () => {
    const toks = refTokens({ x: ["space", "garden"], y: ["source", "chatgpt"] });
    expect(toks.map((tk) => [tk.kind, tk.dim, tk.value])).toEqual([["group", "space", "garden"], ["band", "source", "chatgpt"]]);
    expect(toks[1]?.label).toBe("Source: ChatGPT");
    const time = refTokens({ t: [Date.UTC(2026, 9, 2), Date.UTC(2026, 9, 9)] });
    expect(time[0]?.kind).toBe("time");
    expect(time[0]?.range).toEqual([Date.UTC(2026, 9, 2), Date.UTC(2026, 9, 9)]);
    expect(refTokens({ or: [["space", "a"], ["space", "b"]] }).map((tk) => tk.kind)).toEqual(["group", "group"]);
    expect(refTokens({ x: ["folderPath", "a/b"] }, "b")[0]?.label).toBe("Folder path: b");
  });
  it("moves the other axis on when one dimension would land on both", () => {
    const base = { ...specFor("matrix"), x: { dim: "space" as const, sort: "count" as const }, y: { dim: "source" as const, sort: "name" as const } };
    const ch = assignZone(base, "y", "space");
    expect(ch.spec.y?.dim).toBe("space");
    expect(ch.spec.y?.sort).toBe("name");
    expect(ch.moved).toEqual({ zone: "x", dim: "folder" });
    expect(ch.spec.x.dim).toBe("folder");
    expect(assignZone(base, "colour", "speaker")).toEqual({ spec: { ...base, colour: "speaker" } });
    expect(assignZone({ ...base, y: null }, "y", "month").spec.y).toEqual({ dim: "month", sort: "count" });
    expect(assignZone(base, "x", "kind").moved).toBeUndefined();
  });
  it("swaps axes with their sorts, and cycles sorts Date → Name → Count", () => {
    const base = { ...specFor("matrix"), x: { dim: "space" as const, sort: "date" as const }, y: { dim: "source" as const, sort: "count" as const } };
    const sw = swapAxes(base);
    expect(sw.x).toEqual(base.y);
    expect(sw.y).toEqual(base.x);
    expect(swapAxes({ ...base, y: null }).x).toEqual(base.x);
    expect([nextSort("date"), nextSort("name"), nextSort("count")]).toEqual(["name", "count", "date"]);
    expect(isKnownDim("space")).toBe(true);
    expect(isKnownDim("label:session/work")).toBe(true);
    expect(isKnownDim("week:imported")).toBe(true);
    expect(isKnownDim("<script>")).toBe(false);
  });
  it("toggles icicle rows and records combines in the shape the worker reads", () => {
    const o1 = toggleFold({}, "a/b", true);
    expect(o1).toEqual({ collapsed: ["a/b"], expanded: [] });
    expect(toggleFold(o1, "a/b", false)).toEqual({ collapsed: [], expanded: ["a/b"] });
    const c = addCombine({}, "space", "garden", "studio");
    expect(c).toEqual({ "space=garden": ["studio"] });
    expect(addCombine(c, "space", "garden", "studio")).toBe(c);
    const res = runChart(index, { ...specFor("ranked-bars"), combined: c }, vis, { now: NOW });
    expect(res.categories).toBeDefined();
  });
  it("hit-tests the smallest mark first", () => {
    const big = { key: "big", label: "B", count: 9, x0: 0, y0: 0, x1: 100, y1: 100, area: 10000 };
    const small = { key: "small", label: "S", count: 1, x0: 10, y0: 10, x1: 20, y1: 20, area: 100 };
    expect(markAt([big, small], 15, 15)?.key).toBe("small");
    expect(markAt([big, small], 50, 50)?.key).toBe("big");
    expect(markAt([big, small], 150, 50)).toBeNull();
  });
  it("places a bracket between its two anchors", () => {
    expect(bracketStyle({ x: 10, y: 10, x2: 40, y2: 50 }).width).toBe("50.0px");
    expect(readingRef({ kind: "run", copyKey: "readings.run", values: { n: 3, ref: '{"t":[1,2]}' }, at: [0, 0, 0] })).toEqual({ t: [1, 2] });
    expect(readingCategory({ kind: "peak", copyKey: "readings.peak", values: { label: "x", cat: '["space",""]' }, at: [0, 0, 0] })).toEqual(["space", ""]);
    expect(readingText({ kind: "peak", copyKey: "readings.peak", values: { label: "x", cat: '["space",""]' }, at: [0, 0, 0] })).toBe("No area · peak");
  });
});

describe("Copy data as CSV (§7.4)", () => {
  it("keeps spreadsheet formulas inert and quotes what needs it", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell("-5")).toBe("-5");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(rowsToCsv(["Name", "Count"], [["a", 1], ["b,c", 2]])).toBe('Name,Count\na,1\n"b,c",2');
  });
  it("writes the chart's counts with shares: categories, or cells for two-way charts", () => {
    const bars = runChart(index, specFor("ranked-bars"), vis, { now: NOW });
    const placed = Array.from({ length: index.count }, (_, i) => bars.arr[i * 3]!).filter(Number.isFinite).length;
    const csv = chartCsv(specFor("ranked-bars"), bars, placed).split("\n");
    expect(csv[0]).toBe("Area,Count,Share");
    expect(csv.length).toBeGreaterThan(1);
    const total = csv.slice(1).reduce((a, l) => a + Number(l.split(",").at(-2)), 0);
    expect(total).toBeLessThanOrEqual(placed);
    const grid = runChart(index, specFor("matrix"), vis, { now: NOW });
    expect(chartCsv(specFor("matrix"), grid, placed).split("\n")[0]).toBe("Area,Source,Count,Share");
  });
  it("counts a Groups figure from the Data view's rows", () => {
    const dt = computeStats(index, { kind: "data", rows: "space", columns: "none", measure: "entries", visibility: vis }, { now: NOW });
    if (dt.kind !== "data") throw new Error("shape");
    const lines = groupsCsv("space", dt).split("\n");
    expect(lines[0]).toBe("Area,Count,Share");
    expect(lines.length).toBe(dt.rows.length + 1);
  });
  it("has a handler on the bus command event and ignores other views and commands", () => {
    const bus = new EventBus();
    let runs = 0;
    const off = bindCopyCsv(bus, "v1", () => runs++);
    bus.emit("command", { viewId: "v2", id: "copy-data-csv" });
    bus.emit("command", { viewId: "v1", id: "save-image" });
    expect(runs).toBe(0);
    bus.emit("command", { viewId: "v1", id: "copy-data-csv" });
    expect(runs).toBe(1);
    off();
    bus.emit("command", { viewId: "v1", id: "copy-data-csv" });
    expect(runs).toBe(1);
  });
  it("builds the CSV for a leaf: the chart through the feed, a Groups figure through the Data view", async () => {
    const store = createLeafStore();
    const leaf = { store, viewId: "v1" } as never;
    const dt = computeStats(index, { kind: "data", rows: "space", columns: "none", measure: "entries", visibility: vis }, { now: NOW });
    const calls: string[] = [];
    const s = { worker: { call: async (id: string) => (calls.push(id), dt) } } as never;
    const feed = { ensure: async () => null } as never;
    const body = await csvForLeaf(s, leaf, feed);
    expect(body?.split("\n")[0]).toBe("Area,Count,Share");
    expect(calls).toEqual(["v1#csv"]);
    const spec = specFor("ranked-bars");
    store.update("view", { shape: "chart", chart: spec });
    const result = runChart(index, spec, vis, { now: NOW });
    const withChart = await csvForLeaf(s, leaf, { ensure: async () => ({ spec, result, placed: 100, seq: 1 }) } as never);
    expect(withChart?.split("\n")[0]).toBe("Area,Count,Share");
    expect(await csvForLeaf(s, leaf, feed)).toBeNull();
  });
});

describe("time charts: dates, calendar, lifelines, waves", () => {
  const polylines = (res: ReturnType<typeof runChart>) => res.overlay.items.flatMap((i) => (i.type === "polyline" ? [i] : []));

  it("rotates date ticks that do not fit their slot and staggers them across up to three rows", () => {
    const long = Array.from({ length: 30 }, () => "31 October 2022");
    const crowded = tickLayout(long, 10);
    expect(crowded.rotate).toBe(-38);
    expect(crowded.rows).toBe(3);
    expect(tickLayout(long.slice(0, 6), 10).rows).toBeLessThan(3);
    expect(tickLayout(["Jan", "Feb", "Mar"], 10)).toEqual({ rotate: 0, rows: 1 });
    expect(tickLayout(Array.from({ length: 14 }, () => "Nov"), 10)).toEqual({ rotate: 0, rows: 2 });
  });

  it("fills a calendar day as a square of particles inside its cell", () => {
    const placed: [number, number][] = [];
    const stub = { p: { salt: 0 }, flat: (_o: number, x: number, y: number) => placed.push([x, y]) } as unknown as ChartBuilder;
    const list = Array.from({ length: 23 }, (_, i) => i);
    fillSquare(stub, list, 1, 2, 0.4, 0);
    expect(placed.length).toBe(23);
    for (const [x, y] of placed) {
      expect(x).toBeGreaterThanOrEqual(0.8 - 1e-9);
      expect(x).toBeLessThanOrEqual(1.2 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(1.8 - 1e-9);
      expect(y).toBeLessThanOrEqual(2.2 + 1e-9);
    }
    // A square, not a disc: particles reach the corners of the cell.
    expect(placed.some(([x, y]) => Math.hypot(x - 1, y - 2) > 0.2 * 1.05)).toBe(true);
    const xs = placed.map((p) => p[0]);
    const ys = placed.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.25);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.25);
  });

  it("lays the calendar out in square cells and turns the edge month labels upright", () => {
    const res = runChart(index, specFor("calendar-heatmap"), vis, { now: NOW });
    expect(res.overlay.marks.length).toBeGreaterThan(0);
    for (const m of res.overlay.marks) {
      expect(m.bounds.max[0] - m.bounds.min[0]).toBeCloseTo(m.bounds.max[1] - m.bounds.min[1], 5);
    }
    const upright = res.overlay.items.filter((i) => i.type === "label" && i.rotate === -90);
    expect(upright.length).toBeGreaterThan(0);
  });

  it("grows a count with its cell and fades it out over the give-way band", () => {
    expect(countScale(18)).toBe(1);
    expect(countScale(27)).toBeCloseTo(1.5, 5);
    expect(countScale(500)).toBe(COUNT_SCALE_MAX);
    expect(giveWayOpacity(5)).toBe(1);
    expect(giveWayOpacity(18)).toBe(0);
    const mid = giveWayOpacity(18 * (1 - GIVE_WAY_BAND / 2));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it("words a lifeline length and status, in years from 24 months", () => {
    expect(lifeText([7, 1])).toBe("ongoing, 7 months");
    expect(lifeText([1, 0])).toBe("1 month");
    expect(lifeText([3, 0])).toBe("3 months");
    expect(lifeText([30, 1])).toBe("ongoing, 2.5 years");
    expect(lifeSpan(0, 40 * 86400000, 50 * 86400000)).toEqual([1, 1]);
    expect(lifeSpan(0, 200 * 86400000, 400 * 86400000)).toEqual([7, 0]);
  });

  it("gives each lifeline a start tick and a label that says ongoing for the recent ones", () => {
    const res = runChart(index, specFor("timeline-lanes"), vis, { now: NOW });
    const lanes = res.overlay.marks.map((m) => ({ m, ref: parseRef(m.key) })).filter((x) => x.ref?.life);
    expect(lanes.length).toBeGreaterThan(0);
    const recent = lanes.find((x) => x.ref!.life![1] === 1);
    expect(recent).toBeDefined();
    expect(overlayLabelText(recent!.m.label, recent!.ref)).toContain("ongoing");
    const ended = lanes.find((x) => x.ref!.life![1] === 0);
    if (ended) expect(overlayLabelText(ended.m.label, ended.ref)).not.toContain("ongoing");
    for (const { m } of lanes) {
      const xa = m.bounds.min[0] + 0.05;
      const tick = res.overlay.items.find((i) => i.type === "line" && Math.abs(i.a[0] - xa) < 1e-6 && Math.abs(i.b[0] - xa) < 1e-6 && i.a[1] !== i.b[1]);
      expect(tick).toBeDefined();
    }
    // The second label line is the status alone.
    for (const i of res.overlay.items) {
      if (i.type !== "label") continue;
      const ref = parseRef(i.key);
      if (ref?.life && !ref.x && !ref.y) expect(overlayLabelText(i.text, ref)).toMatch(/month|year/);
    }
  });

  it("offers Show on the Lifelines chart and lets it change what is drawn", () => {
    const control = CHART_OPTIONS["timeline-lanes"]?.find((o) => o.key === "show");
    expect(control?.kind).toBe("choice");
    expect(control && control.kind === "choice" ? control.choices.map((c) => c.value) : []).toEqual(["lines", "blocks", "dots", "density", "curve"]);
    expect(lanesShow({})).toBe("lines");
    expect(lanesShow({ monthlyDensity: false })).toBe("dots");
    expect(lanesShow({ monthlyDensity: true })).toBe("blocks");
    expect(lanesShow({ show: "density", monthlyDensity: false })).toBe("density");
    const base = specFor("timeline-lanes");
    const run = (show: string) => runChart(index, { ...base, options: { show } }, vis, { now: NOW });
    const lines = run("lines");
    const blocks = run("blocks");
    const dots = run("dots");
    const density = run("density");
    expect(polylines(density).length).toBeGreaterThan(polylines(lines).length);
    const key = (r: ReturnType<typeof runChart>) => Array.from(r.arr.slice(0, 600)).join(",");
    expect(new Set([key(lines), key(blocks), key(dots), key(density)]).size).toBe(4);
    for (const r of [lines, blocks, dots, density]) expect(r.overlay.marks.length).toBe(lines.overlay.marks.length);
  });

  it("stacks the waves in depth, labels them in a right-hand column and draws a wall and a flag", () => {
    const res = runChart(index, specFor("ridgeline"), vis, { now: NOW });
    const rows = polylines(res).filter((p) => p.alpha === 0.5);
    expect(rows.length).toBeGreaterThan(2);
    const zs = rows.map((p) => p.points[0]![2]);
    for (let i = 1; i < zs.length; i++) expect(zs[i]!).toBeGreaterThan(zs[i - 1]!);
    expect(res.camera.tiltDeg).toBeGreaterThan(0);
    expect(res.camera.keepUpright).toBe(true);
    const labels = res.overlay.items.filter((i) => i.type === "label" && i.align === "left" && i.style === "axis");
    expect(labels.length).toBeGreaterThanOrEqual(rows.length);
    const wall = polylines(res).find((p) => p.closed && p.points.length === 4 && p.points.every((q) => q[0] === p.points[0]![0]));
    expect(wall).toBeDefined();
    expect(res.overlay.items.some((i) => i.type === "label" && parseRef(i.key)?.copy === "strip.today")).toBe(true);
    expect(waveRowZ(2, 5, 1)).toBeGreaterThan(waveRowZ(1, 5, 1));
    expect(waveRowZ(2, 5, 1)).toBe(0);
  });

  it("draws the aggregate envelope with one value per bin, scaled like the rows", () => {
    const a = Float64Array.from([1, 2, 3, 0]);
    const c = Float64Array.from([0, 2, 1, 4]);
    expect(Array.from(waveEnvelope([a, c], "none", 1, "linear"))).toEqual([1, 4, 4, 4]);
    expect(waveEnvelope([a, c], "none", 1, "sqrt")[1]).toBeCloseTo(2, 5);
    const res = runChart(index, specFor("ridgeline"), vis, { now: NOW });
    const rowLines = polylines(res).filter((p) => p.alpha === 0.5);
    const env = polylines(res).filter((p) => p.alpha === 0.92);
    expect(env.length).toBe(1);
    expect(env[0]!.points.length).toBe(rowLines[0]!.points.length);
    // It is the back row: further from the camera than every wave.
    expect(env[0]!.points[0]![2]).toBeLessThan(rowLines[0]!.points[0]![2]);
    expect(res.readings!.length).toBeLessThanOrEqual(3);
  });

  it("centres the focused lane at twice the height", () => {
    const rows = laneRows(5, 3, -3, 1);
    const unit = 1;
    expect(rows.h[1]).toBeCloseTo(2 * unit, 9);
    expect(rows.h[0]).toBeCloseTo(unit, 9);
    expect(Math.abs(rows.y[1]!)).toBeLessThanOrEqual(unit / 2 + 1e-9);
    expect(laneRows(5, 3, -3, 2).y[2]).toBeCloseTo(0, 9);
    const flat = laneRows(4, 4, 0, null);
    expect(flat.h).toEqual([1, 1, 1, 1]);
    expect(flat.y).toEqual([3.5, 2.5, 1.5, 0.5]);
    // Rows tile the plot without gaps or overlaps.
    const spans = rows.y.map((y, i) => [y + rows.h[i]! / 2, y - rows.h[i]! / 2] as const).sort((p, q) => q[0] - p[0]);
    expect(spans[0]![0]).toBeCloseTo(3, 9);
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeCloseTo(spans[i - 1]![1], 9);
    expect(spans[spans.length - 1]![1]).toBeCloseTo(-3, 9);
  });

  it("re-lays the lifelines out around a focused hub: tilted plane, focus sphere, ribbon, dimmed others", () => {
    const { hubMembers } = index.rel;
    let hub = -1;
    for (let h = 0; h + 1 < hubMembers.offsets.length && hub < 0; h++) if (hubMembers.offsets[h + 1]! > hubMembers.offsets[h]!) hub = h;
    expect(hub).toBeGreaterThanOrEqual(0);
    const base = specFor("timeline-lanes");
    const plain = runChart(index, base, vis, { now: NOW });
    const res = runChart(index, { ...base, focusMap: hub }, vis, { now: NOW });
    expect(plain.camera.tiltDeg).toBe(0);
    expect(res.camera.tiltDeg).toBe(18);
    expect(res.camera.keepUpright).toBe(true);
    const dots = res.overlay.items.flatMap((i) => (i.type === "ring" && i.hue !== undefined ? [i.hue] : []));
    expect(dots.length).toBeGreaterThan(20);
    expect(new Set(dots.map((h) => Math.round(h / 60))).size).toBeGreaterThan(3);
    const heights = res.overlay.marks.filter((m) => parseRef(m.key)?.life).map((m) => m.bounds.max[1] - m.bounds.min[1]);
    const tall = Math.max(...heights);
    const short = Math.min(...heights);
    expect(heights.length).toBeGreaterThan(1);
    expect(tall / short).toBeCloseTo(2, 3);
    // The focused lane sits on the centre row.
    const focused = res.overlay.marks.find((m) => m.bounds.max[1] - m.bounds.min[1] === tall)!;
    const top = 3.6;
    const bottom = -3.1 + 0.15;
    const unit = (top - bottom) / (heights.length + 1);
    expect(Math.abs((focused.bounds.max[1] + focused.bounds.min[1]) / 2 - (top + bottom) / 2)).toBeLessThanOrEqual(unit / 2 + 1e-6);
    // Its label is two lines: the name, then length and status; the others recede.
    expect(res.overlay.items.some((i) => i.type === "label" && i.style === "title")).toBe(true);
    expect(res.overlay.items.some((i) => i.type === "line" && i.alpha < 0.2)).toBe(true);
  });
});
