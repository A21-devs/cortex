/**
 * Package 10, chart forms: the per-chart answer sentences, the Lifelines Curve, the calendar's month blocks and the
 * clock's rings and hour labels. Pure helpers first, then one layout test per worker layout on the sample record.
 */
import { describe, expect, it } from "vitest";
import { buildAnswer, type AnswerInput } from "../src/shared/chartAnswers";
import { chartStageOf } from "../src/shared/chartStage";
import { DEFAULT_SERIES } from "../src/shared/chartAxes";
import { lanesShow } from "../src/shared/chartOptions";
import type { ChartSpec } from "../src/shared/protocol/worker";
import { defaultVisibility } from "../src/worker/charts/common";
import { lifespanTicks, spreadLabels, survivalShare } from "../src/worker/charts/lifeCurve";
import { runChart } from "../src/worker/charts/registry";
import { clockLabelStride } from "../src/worker/charts/rhythm";
import { monthBlocks, monthOutline } from "../src/worker/charts/time";
import { buildSampleIndex } from "../src/worker/sampleIndex";
import { overlayLabelText, parseRef, spanText } from "../src/ui/stage/ChartOverlay";
import { COPY, t } from "../src/ui/copy";

const NOW = Date.UTC(2026, 10, 10);
const index = buildSampleIndex(20261110, NOW);
const vis = defaultVisibility(index.count);
const DAY = 86_400_000;

function spec(chart: ChartSpec["chart"], over: Partial<ChartSpec> = {}): ChartSpec {
  return { chart, x: { dim: "week", sort: "date" }, y: null, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options: {}, ...over } as ChartSpec;
}

const area = (pts: readonly [number, number][]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[(i + 1) % pts.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
};

describe("calendar month blocks (C-05)", () => {
  it("gives every month 4 to 6 week columns and a gap, and an outline that encloses exactly its days", () => {
    for (const year of [2024, 2025, 2026]) {
      const blocks = monthBlocks(year);
      expect(blocks).toHaveLength(12);
      let prevEnd = -1;
      for (const mb of blocks) {
        expect(mb.cols).toBeGreaterThanOrEqual(4);
        expect(mb.cols).toBeLessThanOrEqual(6);
        expect(mb.col0).toBeGreaterThan(prevEnd);
        prevEnd = mb.col0 + mb.cols;
        expect(area(monthOutline(mb))).toBe(mb.days);
      }
    }
  });
  it("starts the first week on the month's first weekday (Monday = 0)", () => {
    // 1 February 2026 was a Sunday; 1 January 2026 a Thursday.
    expect(monthBlocks(2026)[1]!.weekday).toBe(6);
    expect(monthBlocks(2026)[0]!.weekday).toBe(3);
    expect(monthOutline(monthBlocks(2026)[1]!)[0]).toEqual([0, 6]);
  });
  it("draws one outline per month, month names under the blocks, and each day inside its month's block", () => {
    const res = runChart(index, spec("calendar-heatmap", { x: { dim: "day", sort: "date" } }), vis, { now: NOW });
    const rings = res.overlay.items.flatMap((i) => (i.type === "polyline" && i.closed ? [i.points] : []));
    expect(rings.length).toBeGreaterThanOrEqual(12);
    const box = (pts: readonly (readonly number[])[]) => ({ x0: Math.min(...pts.map((p) => p[0]!)), x1: Math.max(...pts.map((p) => p[0]!)), y0: Math.min(...pts.map((p) => p[1]!)), y1: Math.max(...pts.map((p) => p[1]!)) });
    const boxes = rings.map(box);
    expect(res.overlay.marks.length).toBeGreaterThan(0);
    for (const m of res.overlay.marks) {
      const cx = (m.bounds.min[0] + m.bounds.max[0]) / 2;
      const cy = (m.bounds.min[1] + m.bounds.max[1]) / 2;
      expect(boxes.filter((b) => cx > b.x0 && cx < b.x1 && cy > b.y0 && cy < b.y1)).toHaveLength(1);
    }
    // The month names stand below the block they name.
    const names = res.overlay.items.filter((i) => i.type === "label" && i.style === "muted" && /^[A-Z][a-z]{2}$/.test(i.text) && !["Mon", "Wed", "Fri"].includes(i.text));
    expect(names.length).toBeGreaterThanOrEqual(12);
    for (const n of names) {
      if (n.type !== "label") continue;
      const under = boxes.some((b) => n.at[0] >= b.x0 - 0.01 && n.at[0] <= b.x1 + 0.01 && n.at[1] < b.y0);
      expect(under).toBe(true);
    }
    // Month blocks of a row do not touch.
    const rowTop = Math.max(...boxes.map((b) => b.y1));
    const row = boxes.filter((b) => Math.abs(b.y1 - rowTop) < 1e-6).sort((a, b) => a.x0 - b.x0);
    for (let k = 1; k < row.length; k++) expect(row[k]!.x0).toBeGreaterThan(row[k - 1]!.x1);
  });
});

describe("clock rings and hour labels (C-06)", () => {
  const labels = (res: ReturnType<typeof runChart>) => res.overlay.items.flatMap((i) => (i.type === "label" ? [i] : []));
  it("defaults the vertical zone to the area, so a fresh clock has one ring per area", () => {
    expect(DEFAULT_SERIES["radial-clock"]).toBe("space");
    const res = runChart(index, spec("radial-clock", { x: { dim: "hour", sort: "date" } }), vis, { now: NOW });
    const ringNames = labels(res).filter((l) => parseRef(l.key)?.y?.[0] === "space");
    expect(ringNames.length).toBeGreaterThan(1);
    const dims = new Set(res.overlay.marks.map((m) => parseRef(m.key)?.y?.[0]));
    expect(dims.has("space")).toBe(true);
    // The ring names run up one spoke: they stand at x close to 0 and rise with their ring.
    const ys = ringNames.map((l) => l.at[1]);
    expect(ringNames.every((l) => Math.abs(l.at[0]) <= 0.1)).toBe(true);
    expect(new Set(ys).size).toBe(ys.length);
  });
  it("labels every hour on a stage with room, every third on a tiny one", () => {
    expect(clockLabelStride(undefined, 24)).toBe(1);
    expect(clockLabelStride(chartStageOf(1400, 800), 24)).toBe(1);
    expect(clockLabelStride(chartStageOf(130, 100), 24)).toBe(3);
    expect(clockLabelStride(chartStageOf(130, 100), 7)).toBe(1);
    const hours = (stage?: ReturnType<typeof chartStageOf>) => {
      const res = runChart(index, spec("radial-clock", { x: { dim: "hour", sort: "date" } }), vis, stage ? { now: NOW, stage } : { now: NOW });
      return labels(res).filter((l) => parseRef(l.key)?.x?.[0] === "hour" && l.style === "axis");
    };
    expect(hours()).toHaveLength(24);
    expect(hours()[0]!.text).toBe("00:00");
    expect(hours(chartStageOf(130, 100))).toHaveLength(8);
  });
  it("draws a pointer tick at 00:00, above the outer ring", () => {
    const res = runChart(index, spec("radial-clock", { x: { dim: "hour", sort: "date" } }), vis, { now: NOW });
    const tick = res.overlay.items.find((i) => i.type === "line" && Math.abs(i.a[0]) < 1e-9 && Math.abs(i.b[0]) < 1e-9 && i.a[1] > 3.4 && i.alpha >= 0.9);
    expect(tick).toBeDefined();
  });
  it("keeps a clock with an explicit ring dimension on that dimension", () => {
    const res = runChart(index, spec("radial-clock", { x: { dim: "hour", sort: "date" }, y: { dim: "source", sort: "count" } }), vis, { now: NOW });
    const dims = new Set(res.overlay.marks.map((m) => parseRef(m.key)?.y?.[0]));
    expect(dims.has("source")).toBe(true);
    expect(dims.has("space")).toBe(false);
  });
});

describe("Lifelines Curve (C-04)", () => {
  it("reads Curve as a Show choice", () => {
    expect(lanesShow({ show: "curve" })).toBe("curve");
    expect(lanesShow({ show: "nonsense" })).toBe("lines");
  });
  it("counts the share of lives that last at least as long", () => {
    const lives = [0, 0, 10, 30, 400];
    expect(survivalShare(lives, 0)).toBe(1);
    expect(survivalShare(lives, 1)).toBeCloseTo(0.6, 9);
    expect(survivalShare(lives, 30)).toBeCloseTo(0.4, 9);
    expect(survivalShare(lives, 401)).toBe(0);
    expect(survivalShare([], 0)).toBe(0);
  });
  it("picks day, month or year ticks that fit", () => {
    const days = lifespanTicks(20);
    expect(days.every((k) => k.unit === "days")).toBe(true);
    expect(days.length).toBeLessThanOrEqual(9);
    const years = lifespanTicks(4.3 * 365.25);
    expect(years[0]).toMatchObject({ days: 0, n: 0 });
    expect(years.some((k) => k.unit === "years")).toBe(true);
    expect(years.length).toBeLessThanOrEqual(9);
    expect(lifespanTicks(150).some((k) => k.unit === "months")).toBe(true);
  });
  it("moves labels apart but keeps their order", () => {
    const out = spreadLabels([1, 0.98, 0.97, 0.2], 0.2, 0);
    expect(out[0]! - out[1]!).toBeGreaterThanOrEqual(0.2 - 1e-9);
    expect(out[1]! - out[2]!).toBeGreaterThanOrEqual(0.2 - 1e-9);
    expect(out[3]).toBeCloseTo(0.2, 9);
    expect(spreadLabels([0.05, 0.04], 0.2, 0).every((v) => v >= 0)).toBe(true);
  });
  const curveSpec = () => spec("timeline-lanes", { y: { dim: "space", sort: "count" }, options: { show: "curve" } });
  it("lays one non-increasing curve per series between 100% and 0%, with percent hover slices", () => {
    const res = runChart(index, curveSpec(), vis, { now: NOW });
    const lines = res.overlay.items.flatMap((i) => (i.type === "polyline" && !i.closed ? [i.points] : []));
    expect(lines.length).toBeGreaterThan(0);
    for (const pts of lines) for (let k = 1; k < pts.length; k++) expect(pts[k]![1]).toBeLessThanOrEqual(pts[k - 1]![1] + 1e-9);
    // 100 / 50 / 0 % ticks and a lifespan axis, worded through the copy table.
    const ticks = res.overlay.items.flatMap((i) => (i.type === "label" && i.key ? [{ text: i.text, copy: parseRef(i.key)?.copy }] : []));
    expect(ticks.filter((x) => x.copy === "chart.percentTick").map((x) => x.text).sort()).toEqual(["0", "100", "50"]);
    expect(ticks.some((x) => x.copy?.startsWith("chart.lifeTick"))).toBe(true);
    const slices = res.overlay.marks.map((m) => ({ m, ref: parseRef(m.key)! })).filter((x) => x.ref.curve);
    expect(slices.length).toBeGreaterThan(0);
    for (const { ref } of slices) {
      expect(ref.curve![0]).toBeGreaterThanOrEqual(0);
      expect(ref.curve![0]).toBeLessThanOrEqual(100);
      expect(ref.y?.[0]).toBe("space");
    }
    // A series' first slice starts at 100%.
    expect(slices.some((x) => x.ref.curve![0] === 100)).toBe(true);
    // Particles sit inside the plot.
    let placed = 0;
    for (let i = 0; i < res.arr.length; i += 3) if (Number.isFinite(res.arr[i]!)) placed++;
    expect(placed).toBeGreaterThan(0);
  });
  it("words a slice by series, percent and lifespan, and the panel sentence reads the answer", () => {
    expect(spanText(12)).toBe("12 days");
    expect(spanText(1)).toBe("1 day");
    expect(spanText(95)).toBe("3 months");
    expect(spanText(900)).toBe("2.5 years");
    const ref = { y: ["space", "x"] as [string, string], curve: [62, 95] as [number, number] };
    expect(overlayLabelText("Garden", ref as never)).toContain(": 62% last 3 months or more");
    const res = runChart(index, curveSpec(), vis, { now: NOW });
    const answer = buildAnswer({
      chart: "timeline-lanes", x: "week", y: "space", colour: null, options: { show: "curve" }, categories: [],
      marks: res.overlay.marks.map((m) => ({ label: m.label, count: m.count, key: m.key })), placed: 100,
      name: (_d, k, f) => f || k, dimName: (d) => d, period: (a, b) => `${a}-${b}`, span: spanText,
    });
    expect(answer.answer?.key).toMatch(/^answers\.a\.curve/);
  });
  it("keeps the other Show choices on their own layout", () => {
    const res = runChart(index, spec("timeline-lanes", { y: { dim: "space", sort: "count" } }), vis, { now: NOW });
    expect(res.overlay.marks.some((m) => parseRef(m.key)?.life)).toBe(true);
    expect(res.overlay.marks.some((m) => parseRef(m.key)?.curve)).toBe(false);
  });
});

describe("answer sentences per chart (C-03)", () => {
  const base: AnswerInput = {
    chart: "stream", x: "week", y: "space", colour: null, options: {}, categories: [], marks: [], placed: 100,
    name: (_d, k, f) => f || k, dimName: (d) => d, period: (a, b) => `${a}-${b}`, span: (d) => `${Math.round(d)}d`,
  };
  const mark = (ref: object, count: number, label = "m") => ({ label, count, key: JSON.stringify(ref) });
  const bin = (series: string, n: number, k: number, count: number) => mark({ y: ["space", series], t: [k * 7 * DAY, (k + 1) * 7 * DAY] }, count, series.toUpperCase());

  it("stream, bands and ridgeline compare the first and the last third", () => {
    const marks = [bin("a", 1, 0, 9), bin("b", 1, 0, 2), bin("a", 1, 1, 6), bin("b", 1, 1, 4), bin("a", 1, 2, 3), bin("b", 1, 2, 5), bin("a", 1, 3, 1), bin("b", 1, 3, 9), bin("a", 1, 4, 1), bin("b", 1, 4, 9), bin("a", 1, 5, 0), bin("b", 1, 5, 9)];
    for (const chart of ["stream", "bands", "ridgeline"] as const) {
      expect(buildAnswer({ ...base, chart, marks }).answer).toEqual({ key: "answers.a.led", values: { a: "A", b: "B" } });
    }
    const steady = [bin("a", 1, 0, 9), bin("b", 1, 0, 2), bin("a", 1, 1, 9), bin("b", 1, 1, 2), bin("a", 1, 2, 9)];
    expect(buildAnswer({ ...base, marks: steady }).answer).toEqual({ key: "answers.a.ledThroughout", values: { a: "A" } });
    // One period only: the older sentence stays.
    expect(buildAnswer({ ...base, categories: [{ key: "a", label: "A", count: 9 }], marks: [bin("a", 1, 0, 9)] }).answer?.key).toBe("answers.a.topPeriod");
  });
  it("alluvial names its strongest flow", () => {
    const marks = [mark({ x: ["project", "p"], y: ["kind", "k1"] }, 30, "p to k1"), mark({ x: ["project", "q"], y: ["kind", "k2"] }, 70, "q to k2"), mark({ x: ["project", "q"] }, 90, "q")];
    const a = buildAnswer({ ...base, chart: "alluvial", x: "project", y: "kind", marks }).answer;
    expect(a).toEqual({ key: "answers.a.flow", values: { from: "q", to: "k2", n: "70", total: "100", share: "70%" } });
  });
  it("clock names the peak hour and the ring most concentrated at another hour", () => {
    const cell = (hour: string, ring: string, count: number) => mark({ x: ["hour", hour], y: ["space", ring] }, count, `${hour}:00 · ${ring.toUpperCase()}`);
    const marks = [cell("19", "a", 40), cell("19", "b", 2), cell("02", "b", 8), cell("04", "a", 4), cell("05", "b", 1)];
    const a = buildAnswer({ ...base, chart: "radial-clock", x: "hour", marks }).answer;
    expect(a).toEqual({ key: "answers.a.clock", values: { label: "19:00", name: "B", at: "02:00" } });
    const one = buildAnswer({ ...base, chart: "radial-clock", x: "hour", marks: [mark({ x: ["hour", "07"] }, 12, "07:00")] }).answer;
    expect(one).toEqual({ key: "answers.a.clockOne", values: { label: "07:00", n: "12", total: "100" } });
  });
  it("arc diagram counts the returns and gives the usual gap", () => {
    const burst = (series: string, from: number, to: number) => mark({ y: ["space", series], t: [from * DAY, to * DAY + 1] }, 3, series);
    const marks = [burst("a", 0, 5), burst("a", 95, 100), burst("a", 190, 192), burst("b", 0, 3), burst("b", 33, 40)];
    expect(buildAnswer({ ...base, chart: "arc-diagram", marks }).answer).toEqual({ key: "answers.a.returns", values: { n: "3", gap: "90d" } });
    expect(buildAnswer({ ...base, chart: "arc-diagram", marks: [burst("a", 0, 5), burst("a", 95, 100)] }).answer?.key).toBe("answers.a.returnsOne");
  });
  it("lanes say how many are still going", () => {
    const lane = (key: string, going: number) => mark({ y: ["space", key], span: [0, 10 * DAY], life: [3, going] }, 5, key);
    const lanes = (...g: number[]) => buildAnswer({ ...base, chart: "timeline-lanes", marks: g.map((v, k) => lane(`l${k}`, v)) }).answer;
    expect(lanes(1, 1, 1)?.key).toBe("answers.a.lanesAll");
    expect(lanes(1, 1, 0)?.key).toBe("answers.a.lanesMost");
    expect(lanes(1, 0, 0)?.key).toBe("answers.a.lanesSome");
    expect(lanes(0, 0)?.key).toBe("answers.a.lanesNone");
    expect(lanes(1, 1, 0)?.values).toMatchObject({ going: "2", k: "3", share: "67%" });
  });
  it("never names the no-value bucket as the series that stands out", () => {
    const cell = (hour: string, ring: string, count: number) => mark({ x: ["hour", hour], y: ["space", ring] }, count, `${hour}:00 · ${ring}`);
    const clock = buildAnswer({ ...base, chart: "radial-clock", x: "hour", marks: [cell("19", "a", 40), cell("02", "", 30), cell("04", "a", 2)] }).answer;
    expect(clock?.key).toBe("answers.a.clockOne");
    const lane = (key: string, days: number) => mark({ y: ["space", key], span: [0, days * DAY] }, 3, key);
    const lanes = buildAnswer({ ...base, chart: "timeline-lanes", marks: [lane("", 200), lane("a", 20)] }).answer;
    expect(lanes?.values).toMatchObject({ name: "a" });
  });
  it("the Curve answer names the series that holds on longest", () => {
    const slice = (series: string, pct: number, days: number) => mark({ y: ["space", series], curve: [pct, days] }, 4, series.toUpperCase());
    const marks = [slice("a", 100, 0), slice("a", 60, 30), slice("a", 20, 60), slice("b", 100, 0), slice("b", 55, 200), slice("b", 10, 400)];
    expect(buildAnswer({ ...base, chart: "timeline-lanes", marks }).answer).toEqual({ key: "answers.a.curve", values: { name: "B", span: "200d" } });
    expect(buildAnswer({ ...base, chart: "timeline-lanes", marks: marks.slice(0, 3) }).answer?.key).toBe("answers.a.curveOne");
    expect(buildAnswer({ ...base, chart: "timeline-lanes", marks: [slice("a", 100, 0), slice("a", 20, 0.5)] }).answer?.key).toBe("answers.a.curveShort");
  });
  it("has copy for every new line", () => {
    expect(t("answers.a.led", { a: "A", b: "B" })).toBe("A led at first, B by the end.");
    expect(t("answers.a.returns", { n: 3, gap: "3 months" })).toContain("3 times");
    expect(COPY.chart.showCurve).toBe("Curve");
  });
});
