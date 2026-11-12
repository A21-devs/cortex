/**
 * Chart forms: the Bands chart, the Show rows select (Longest, Recent, Most) with "back after N months" row labels on
 * Lifelines and the Arc diagram, and the layout pass that fills the stage's usable rectangle (frame shaped like the
 * stage, boxed tile names, rim labels along the spoke, the hatched base strip of Balance).
 */
import { describe, expect, it } from "vitest";
import { bandSegments, monthsOfDays, rowsOrder, rowsShow } from "../src/shared/chartOptions";
import { FRAME_ASPECT, FRAME_UNITS, chartStageOf, frameUnits, stageAspect } from "../src/shared/chartStage";
import { chartDef, CHART_CATALOGUE, CHART_IDS } from "../src/shared/views";
import { AXIS_ROLES, DEFAULT_SERIES } from "../src/shared/chartAxes";
import type { ChartSpec, OverlayItem } from "../src/shared/protocol/worker";
import { buildSampleIndex } from "../src/worker/sampleIndex";
import { defaultVisibility, plotRect, PLOT } from "../src/worker/charts/common";
import { CHARTS, runChart } from "../src/worker/charts/registry";
import { backMonths } from "../src/worker/charts/time";
import { buildAnswer, type AnswerInput } from "../src/shared/chartAnswers";
import { CHART_OPTIONS } from "../src/ui/pages/ChartPage";
import { backText, overlayLabelText, parseRef } from "../src/ui/stage/ChartOverlay";
import { t } from "../src/ui/copy";

const NOW = Date.UTC(2026, 10, 10);
const index = buildSampleIndex(20261110, NOW);
const vis = defaultVisibility(index.count);

function spec(chart: ChartSpec["chart"], options: ChartSpec["options"] = {}, over: Partial<ChartSpec> = {}): ChartSpec {
  return { chart, x: { dim: "week", sort: "date" }, y: { dim: "space", sort: "count" }, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options, ...over };
}

type Label = Extract<OverlayItem, { type: "label" }>;
const labelsOf = (items: readonly OverlayItem[]): Label[] => items.filter((i): i is Label => i.type === "label");
const placed = (arr: Float32Array): number => {
  let n = 0;
  for (let i = 0; i < arr.length; i += 3) if (Number.isFinite(arr[i]!)) n += 1;
  return n;
};

describe("Bands (catalogue)", () => {
  it("is a flat time chart of phase P1 with its tile, copy, roles and layout", () => {
    expect(chartDef("bands")).toEqual({ id: "bands", group: "time", phase: "P1", flat: true });
    expect(CHART_IDS).toContain("bands");
    expect(CHARTS.bands).toBeTypeOf("function");
    expect(AXIS_ROLES.bands).toEqual({ x: "across", y: "bands" });
    expect(DEFAULT_SERIES.bands).toBe("space");
    expect(t("charts.bands")).toBe("Bands");
    expect(CHART_CATALOGUE.filter((c) => c.group === "time").map((c) => c.id)).toContain("bands");
  });
  it("words its question and answers it from its segments", () => {
    const res = runChart(index, spec("bands"), vis, { now: NOW });
    const input: AnswerInput = {
      chart: "bands",
      x: "week",
      y: "space",
      colour: null,
      options: {},
      marks: res.overlay.marks,
      categories: res.categories ?? [],
      placed: placed(res.arr),
      dimName: (d) => d,
      name: (_d, _k, label) => label,
      period: (a, b) => `${a}-${b}`,
    };
    const ans = buildAnswer(input);
    expect(ans.question.key).toBe("answers.q.bands");
    expect(ans.answer).not.toBeNull();
  });
});

describe("Bands (layout)", () => {
  const res = runChart(index, spec("bands"), vis, { now: NOW });
  const bandOf = (key: string) => {
    const r = parseRef(key);
    return r?.y ? r.y[1] : null;
  };
  it("draws a band per value of the series, each a row of dotted segments along the date axis", () => {
    const series = new Set(res.overlay.marks.map((m) => bandOf(m.key)).filter((k): k is string => k !== null));
    expect(series.size).toBeGreaterThan(1);
    expect(placed(res.arr)).toBeGreaterThan(100);
    // Every segment carries its time range, and the segments of one band share a row.
    const rows = new Map<string, Set<number>>();
    for (const m of res.overlay.marks) {
      const r = parseRef(m.key)!;
      expect(r.t).toBeDefined();
      const y = Math.round(((m.bounds.min[1] + m.bounds.max[1]) / 2) * 100) / 100;
      const set = rows.get(bandOf(m.key)!) ?? new Set<number>();
      set.add(y);
      rows.set(bandOf(m.key)!, set);
    }
    for (const set of rows.values()) expect(set.size).toBe(1);
  });
  it("names each band at its left end and joins its segments with a dotted line", () => {
    const labels = labelsOf(res.overlay.items).filter((l) => parseRef(l.key)?.y);
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) expect(l.align).toBe("right");
    const dotted = res.overlay.items.filter((i) => i.type === "line" && i.dashed === true);
    expect(dotted.length).toBeGreaterThanOrEqual(labels.length);
  });
  it("scales every segment on one height scale, so the fuller one is taller", () => {
    const sized = res.overlay.marks.map((m) => ({ n: m.count, h: m.bounds.max[1] - m.bounds.min[1] }));
    const most = sized.reduce((a, c) => (c.n > a.n ? c : a));
    const least = sized.reduce((a, c) => (c.n < a.n ? c : a));
    expect(most.h).toBeGreaterThanOrEqual(least.h);
  });
  it("reads the fullest segment", () => {
    expect(res.readings?.length).toBe(1);
    expect(res.readings![0]!.kind).toBe("largest");
  });
  it("takes Segments: weeks give more, narrower segments than months", () => {
    const weeks = runChart(index, spec("bands", { grain: "week" }), vis, { now: NOW });
    const months = runChart(index, spec("bands", { grain: "month" }), vis, { now: NOW });
    expect(weeks.overlay.marks.length).toBeGreaterThan(months.overlay.marks.length);
    expect(bandSegments({})).toBe("auto");
    expect(bandSegments({ grain: "week" })).toBe("week");
    expect(bandSegments({ grain: "year" })).toBe("auto");
    const control = CHART_OPTIONS.bands?.find((o) => o.key === "grain");
    expect(control?.kind === "choice" ? control.choices.map((c) => c.value) : []).toEqual(["auto", "week", "month"]);
  });
  it("is empty and quiet on an empty record or an empty period", () => {
    const none = { ...vis, hidden: new Set<string>(["__nothing__"]) } as typeof vis;
    expect(() => runChart(index, spec("bands"), none, { now: NOW, members: new Uint32Array([0]) })).not.toThrow();
    const out = runChart(index, spec("bands", {}, { filter: [{ dim: "space", values: ["__nothing__"] } as never] }), vis, { now: NOW });
    expect(out.arr.length).toBe(index.count * 3);
  });
});

describe("Show rows", () => {
  it("offers Longest, Recent and Most on Lifelines (beside its Show) and on the Arc diagram", () => {
    for (const id of ["timeline-lanes", "arc-diagram"] as const) {
      const c = CHART_OPTIONS[id]?.find((o) => o.key === "rows");
      expect(c?.kind).toBe("choice");
      expect(c?.kind === "choice" ? c.choices.map((x) => x.value) : []).toEqual(["longest", "recent", "most"]);
    }
    expect(t("chart.showRows")).toBe("Show rows");
  });
  it("reads the choice, and leaves the order alone until it is made", () => {
    expect(rowsShow({})).toBeNull();
    expect(rowsShow({ rows: "x" })).toBeNull();
    expect(rowsShow({ rows: "recent" })).toBe("recent");
  });
  it("orders rows by the longest, the newest or the most, ties keeping their place", () => {
    const rows = [
      { longest: 5, newest: 10, count: 3 },
      { longest: 9, newest: 4, count: 3 },
      { longest: 5, newest: 12, count: 8 },
    ];
    expect(rowsOrder("longest", rows)).toEqual([1, 0, 2]);
    expect(rowsOrder("recent", rows)).toEqual([2, 0, 1]);
    expect(rowsOrder("most", rows)).toEqual([2, 0, 1]);
  });
  it("reorders the rows of Lifelines and keeps every row's marks and points", () => {
    const base = spec("timeline-lanes");
    const names = (r: ReturnType<typeof runChart>) => r.overlay.marks.map((m) => parseRef(m.key)?.y?.[1]);
    const recent = runChart(index, { ...base, options: { rows: "recent" } }, vis, { now: NOW });
    const longest = runChart(index, { ...base, options: { rows: "longest" } }, vis, { now: NOW });
    const plain = runChart(index, base, vis, { now: NOW });
    expect([...names(recent)].sort()).toEqual([...names(plain)].sort());
    expect(placed(recent.arr)).toBe(placed(plain.arr));
    // Recent puts the lane that was active last on top; Longest the lane with the longest span.
    const spans = (r: ReturnType<typeof runChart>) => r.overlay.marks.map((m) => parseRef(m.key)!.span!);
    const s = spans(longest).map(([a, b]) => b - a);
    expect(s).toEqual([...s].sort((a, b) => b - a));
    const lasts = spans(recent).map(([, b]) => b);
    expect(lasts).toEqual([...lasts].sort((a, b) => b - a));
  });
  it("orders the Arc diagram's rows by the biggest gap first under Longest", () => {
    const res = runChart(index, { ...spec("arc-diagram"), options: { rows: "longest", minGapDays: 7 } }, vis, { now: NOW });
    const rowLabels = labelsOf(res.overlay.items).filter((l) => parseRef(l.key)?.y);
    expect(rowLabels.length).toBeGreaterThan(1);
    const backs = rowLabels.map((l) => parseRef(l.key)!.back ?? 0);
    expect(backs).toEqual([...backs].sort((a, b) => b - a));
  });
});

describe("Back after N months", () => {
  it("is a whole number of months for a gap of a month or more, and nothing for a shorter one", () => {
    expect(monthsOfDays(5)).toBe(1);
    expect(monthsOfDays(91)).toBe(3);
    expect(backMonths(10 * 86400000)).toBeUndefined();
    expect(backMonths(31 * 86400000)).toBe(1);
    expect(backMonths(200 * 86400000)).toBe(7);
  });
  it("words the row label: months, one month and years", () => {
    expect(backText("Design", 7)).toBe("Design - back after 7 months");
    expect(backText("Design", 1)).toBe("Design - back after 1 month");
    expect(backText("Design", 30)).toBe("Design - back after 2.5 years");
  });
  it("puts the gap on the row's label ref and words it through the overlay", () => {
    const res = runChart(index, spec("arc-diagram", { minGapDays: 7 }), vis, { now: NOW });
    const withBack = labelsOf(res.overlay.items).filter((l) => parseRef(l.key)?.back !== undefined);
    expect(withBack.length).toBeGreaterThan(0);
    for (const l of withBack) {
      const ref = parseRef(l.key)!;
      expect(ref.y).toBeDefined();
      expect(overlayLabelText(l.text, ref)).toMatch(/ - back after \d+(\.\d)? (month|months|years)$/);
    }
    const lanes = runChart(index, spec("timeline-lanes"), vis, { now: NOW });
    const first = labelsOf(lanes.overlay.items).find((l) => parseRef(l.key)?.back !== undefined);
    if (first) expect(overlayLabelText(first.text, parseRef(first.key))).toContain("back after");
  });
  it("keeps the ref round trip: a malformed gap is dropped", () => {
    expect(parseRef(JSON.stringify({ y: ["space", "code"], back: 4 }))?.back).toBe(4);
    expect(parseRef(JSON.stringify({ y: ["space", "code"], back: "x" }))?.back).toBeUndefined();
  });
});

describe("Filling the stage", () => {
  const sizes = [chartStageOf(952, 982), chartStageOf(1512, 982), chartStageOf(640, 900)] as const;
  it("shapes the frame like the stage, and is the usual 13 by 8 without one", () => {
    expect(frameUnits(null)).toEqual({ w: FRAME_UNITS.w, h: FRAME_UNITS.h });
    expect(stageAspect(null)).toBe(FRAME_ASPECT);
    for (const s of sizes) {
      const f = frameUnits(s);
      expect(f.w / f.h).toBeCloseTo(stageAspect(s), 6);
      expect(f.w).toBeGreaterThanOrEqual(9);
      expect(f.w).toBeLessThanOrEqual(18);
    }
    const wide = frameUnits(sizes[1]);
    const narrow = frameUnits(sizes[2]);
    expect(wide.w / wide.h).toBeGreaterThan(narrow.w / narrow.h);
  });
  it("lays the plot out at the usual margins round that frame, and is PLOT itself on the usual stage", () => {
    expect(plotRect(null)).toEqual(PLOT);
    for (const s of sizes) {
      const f = frameUnits(s);
      const r = plotRect(s);
      expect(r.left).toBeCloseTo(-f.w / 2 + 2.1, 9);
      expect(r.right).toBeCloseTo(f.w / 2 - 0.9, 9);
      expect(r.top).toBeCloseTo(f.h / 2 - 0.4, 9);
      expect(r.bottom).toBeCloseTo(-f.h / 2 + 0.9, 9);
    }
  });
  const FLAT = CHART_CATALOGUE.filter((c) => c.flat).map((c) => c.id);
  it.each(FLAT.map((id) => [id]))("%s fits its camera to the stage's frame and keeps every point inside it, at three stage sizes", (id) => {
    for (const stage of sizes) {
      const res = runChart(index, spec(id, {}, id === "calendar-heatmap" ? { y: null } : {}), vis, { now: NOW, stage });
      const half = res.camera.half;
      if (!half) continue;
      const f = frameUnits(stage);
      expect(half.w).toBeGreaterThanOrEqual(f.w / 2 - 1e-9);
      expect(half.h).toBeGreaterThanOrEqual(f.h / 2 - 1e-9);
      // Widened for a point beyond the frame (by at most half again), never shrunk below it.
      expect(half.w).toBeLessThanOrEqual((f.w / 2) * 1.5 + 1e-9);
      expect(half.h).toBeLessThanOrEqual((f.h / 2) * 1.5 + 1e-9);
      for (let i = 0; i < res.arr.length; i += 3) {
        const x = res.arr[i]!;
        const y = res.arr[i + 1]!;
        if (!Number.isFinite(x)) continue;
        expect(Math.abs(x)).toBeLessThanOrEqual(half.w * 1.001 + 0.2);
        expect(Math.abs(y)).toBeLessThanOrEqual(half.h * 1.001 + 0.2);
      }
    }
  }, 30_000);
  it("makes the matrix span more of a tall stage than it did of the fixed frame", () => {
    const tall = chartStageOf(700, 982);
    const wide = chartStageOf(1512, 700);
    const extent = (stage: ReturnType<typeof chartStageOf> | undefined) => {
      const res = runChart(index, spec("matrix", { perspective: false }), vis, { now: NOW, ...(stage ? { stage } : {}) });
      let lo = Infinity;
      let hi = -Infinity;
      let l0 = Infinity;
      let l1 = -Infinity;
      for (let i = 0; i < res.arr.length; i += 3) {
        if (!Number.isFinite(res.arr[i]!)) continue;
        lo = Math.min(lo, res.arr[i + 1]!);
        hi = Math.max(hi, res.arr[i + 1]!);
        l0 = Math.min(l0, res.arr[i]!);
        l1 = Math.max(l1, res.arr[i]!);
      }
      return { h: hi - lo, w: l1 - l0, half: res.camera.half! };
    };
    const base = extent(undefined);
    const t = extent(tall);
    const w = extent(wide);
    expect(t.h).toBeGreaterThan(base.h);
    expect(w.w).toBeGreaterThan(base.w);
    // The camera frame follows: taller on the tall stage, wider on the wide one.
    expect(t.half.h / t.half.w).toBeGreaterThan(base.half.h / base.half.w);
    expect(w.half.w / w.half.h).toBeGreaterThan(base.half.w / base.half.h);
  });
  it("keeps the figure of charts without a stage exactly as before", () => {
    const a = runChart(index, spec("matrix", { perspective: false }), vis, { now: NOW });
    expect(a.camera.half).toEqual({ w: 6.5, h: 4 });
  });
  it("names the tiles of the treemap and the icicle in boxes", () => {
    for (const id of ["treemap", "icicle"] as const) {
      const res = runChart(index, spec(id, {}, { x: { dim: "space", sort: "count" }, y: null }), vis, { now: NOW });
      const tiles = labelsOf(res.overlay.items).filter((l) => l.style === "tile");
      expect(tiles.length).toBeGreaterThan(0);
    }
  });
  it("sets the treemap in the stage's frame", () => {
    const stage = chartStageOf(1512, 982);
    const res = runChart(index, spec("treemap", {}, { x: { dim: "space", sort: "count" }, y: null }), vis, { now: NOW, stage });
    const f = frameUnits(stage);
    const rects = res.overlay.items.filter((i): i is Extract<OverlayItem, { type: "rect" }> => i.type === "rect");
    const right = Math.max(...rects.map((r) => r.max[0]));
    expect(right).toBeGreaterThan(6.2);
    expect(right).toBeLessThanOrEqual(f.w / 2);
  });
  it("runs rim labels of dates along the spoke and keeps short hours level", () => {
    const dates = runChart(index, spec("radial-heatmap", {}, { x: { dim: "month", sort: "date" } }), vis, { now: NOW });
    const rim = labelsOf(dates.overlay.items).filter((l) => parseRef(l.key)?.x && l.text.length > 3);
    expect(rim.length).toBeGreaterThan(0);
    expect(rim.filter((l) => l.rotate !== undefined).length).toBeGreaterThan(rim.length / 2);
    for (const l of rim) {
      expect(Math.abs(l.rotate ?? 0)).toBeLessThanOrEqual(90);
    }
    const hours = runChart(index, spec("radial-heatmap", {}, { x: { dim: "hour", sort: "count" } }), vis, { now: NOW });
    const level = labelsOf(hours.overlay.items).filter((l) => parseRef(l.key)?.x);
    expect(level.length).toBeGreaterThan(0);
    for (const l of level) expect(l.rotate).toBeUndefined();
  });
  it("draws Balance with a hatched strip along the foot of the cone", () => {
    const res = runChart(index, spec("two-sides", {}, { y: null }), vis, { now: NOW });
    const slanted = res.overlay.items.filter((i) => i.type === "line" && !i.dashed && i.a[1] !== i.b[1] && i.a[0] !== i.b[0] && Math.abs(i.b[1] - i.a[1]) < 0.2);
    expect(slanted.length).toBeGreaterThan(20);
    const ys = new Set(slanted.map((i) => (i.type === "line" ? Math.round(i.a[1] * 100) : 0)));
    expect(ys.size).toBe(1);
  });
});

describe("Back after N months (long names)", () => {
  it("cuts a long row name before the suffix so the label fits its gutter", () => {
    const text = overlayLabelText("a-very-long-project-name", { y: ["project", "a-very-long-project-name"], back: 3 });
    expect(text.startsWith("a-very-long-p")).toBe(true);
    expect(text).toMatch(/…? - back after 3 months$/);
    expect(text.length).toBeLessThanOrEqual(14 + " - back after 3 months".length);
  });
});
