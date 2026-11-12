/**
 * P22 chart extras: the Balance chart (CHART-33), swirl-textured Shells rows (CHART-16), treemap comet streaks
 * (CHART-20), the Waves label flicker (CHART-37) and the question and answer lines of every chart (TB-18).
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SERIES } from "../src/shared/chartAxes";
import { balanceDim, balanceSides, withBalanceDim, withBalanceSide } from "../src/shared/balance";
import { shellsForm } from "../src/shared/chartOptions";
import { buildAnswer, dayNumber, longestDayRun, shareText, type AnswerInput } from "../src/shared/chartAnswers";
import type { ChartSpec } from "../src/shared/protocol/worker";
import { CHART_CATALOGUE, CHART_IDS, type ChartId } from "../src/shared/views";
import { COPY, t, type CopyKey } from "../src/ui/copy";
import { answerLineText, answerTextOf } from "../src/ui/stage/answers";
import { countPlaced, placeTitle, type ChartFeedValue } from "../src/ui/stage/ChartOverlay";
import { blinkApplies, blinkSteps, BLINK_MS, BLINK_STEP_MS } from "../src/ui/stage/labelBlink";
import { boxesFromMarks, cometsForBox, COMET_PER_BOX_MAX, COMET_TOTAL_MAX, makeComets, planComets, refitComets, rng, spawnComet, stepComet, tailEnd, type CometBox } from "../src/ui/stage/comets";
import { namedNodes } from "../src/worker/charts/connections";
import { clearLabels, defaultVisibility, swirlDir } from "../src/worker/charts/common";
import { SHELL_ROWS_MAX, SWIRL_ARMS, SWIRL_TURNS } from "../src/worker/charts/compare";
import { runChart } from "../src/worker/charts/registry";
import { buildSampleIndex } from "../src/worker/sampleIndex";

const NOW = Date.UTC(2026, 10, 10);
const index = buildSampleIndex(20261110, NOW);
const vis = defaultVisibility(index.count);

function specFor(chart: ChartId, patch: Partial<ChartSpec> = {}): ChartSpec {
  const g = CHART_CATALOGUE.find((c) => c.id === chart)!.group;
  const base: ChartSpec = { chart, x: { dim: g === "time" ? "month" : g === "rhythm" ? "hour" : "space", sort: g === "time" ? "date" : "count" }, y: null, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options: {} };
  const needsY = chart === "matrix" || chart === "alluvial" || chart === "chord" || chart === "clusters-3d" || chart === "radial-heatmap";
  const withY = needsY ? { ...base, y: { dim: "source" as const, sort: "count" as const } } : chart === "ridgeline" || chart === "stream" || chart === "timeline-lanes" || chart === "arc-diagram" || chart === "radial-clock" ? { ...base, y: { dim: "space" as const, sort: "count" as const } } : base;
  return { ...withY, ...patch };
}

function feedValue(spec: ChartSpec): ChartFeedValue {
  const result = runChart(index, spec, vis, { now: NOW });
  return { spec, result, placed: countPlaced(result.arr), seq: 1 };
}

describe("Balance sides (CHART-33)", () => {
  it("defaults to you versus assistants on the speaker dimension", () => {
    expect(balanceDim({})).toBe("speaker");
    expect(balanceSides({}, "speaker", [{ key: "assistant", count: 9 }, { key: "you", count: 3 }])).toEqual(["you", "assistant"]);
  });
  it("takes the two largest values of another dimension until a pair is chosen", () => {
    const values = [{ key: "a", count: 2 }, { key: "b", count: 9 }, { key: "c", count: 5 }];
    expect(balanceSides({ dim: "source" }, "source", values)).toEqual(["b", "c"]);
    expect(balanceSides({ dim: "source", sideA: "a", sideB: "c" }, "source", values)).toEqual(["a", "c"]);
    expect(balanceSides({ sideA: "c" }, "source", values)).toEqual(["c", "b"]);
  });
  it("never offers the same value on both sides, and reports too few values", () => {
    expect(balanceSides({ sideA: "a", sideB: "a" }, "source", [{ key: "a", count: 4 }, { key: "b", count: 1 }])).toEqual(["a", "b"]);
    expect(balanceSides({}, "source", [{ key: "a", count: 4 }])).toEqual(["a", null]);
    expect(balanceSides({}, "source", [])).toEqual([null, null]);
  });
  it("resets the pair with the dimension and swaps when one side takes the other's value", () => {
    expect(withBalanceDim({ sideA: "a", sideB: "b", counts: true }, "source")).toEqual({ counts: true, dim: "source" });
    expect(withBalanceSide({}, "sideA", "c", ["a", "b"])).toEqual({ sideA: "c", sideB: "b" });
    expect(withBalanceSide({}, "sideA", "b", ["a", "b"])).toEqual({ sideA: "b", sideB: "a" });
  });
});

describe("Balance layout (CHART-33)", () => {
  it("lays out both sides of the speaker dimension as bars with a net line", () => {
    const res = runChart(index, specFor("two-sides"), vis, { now: NOW });
    expect(countPlaced(res.arr)).toBeGreaterThan(0);
    expect(res.overlay.items.some((i) => i.type === "polyline")).toBe(true);
    const sides = new Set(res.overlay.marks.map((m) => (JSON.parse(m.key) as { y?: [string, string] }).y?.[1]));
    expect(sides).toEqual(new Set(["you", "assistant"]));
    expect((res.categories ?? []).map((c) => c.key)).toEqual(expect.arrayContaining(["you", "assistant"]));
    expect((res.readings ?? []).length).toBeLessThanOrEqual(3);
  });
  it("places the particles of side A above the zero line and side B below it", () => {
    const res = runChart(index, specFor("two-sides"), vis, { now: NOW });
    const above = res.overlay.marks.filter((m) => (JSON.parse(m.key) as { y: [string, string] }).y[1] === "you");
    const below = res.overlay.marks.filter((m) => (JSON.parse(m.key) as { y: [string, string] }).y[1] === "assistant");
    expect(above.length).toBeGreaterThan(0);
    expect(below.length).toBeGreaterThan(0);
    for (const m of above) expect(m.bounds.min[1]).toBeGreaterThanOrEqual(-0.1 - 1e-6);
    for (const m of below) expect(m.bounds.max[1]).toBeLessThanOrEqual(-0.1 + 1e-6);
  });
  it("compares a chosen pair of another dimension", () => {
    const res = runChart(index, specFor("two-sides", { options: { dim: "source" } }), vis, { now: NOW });
    const cats = res.categories ?? [];
    expect(cats.length).toBeGreaterThanOrEqual(2);
    const keys = new Set(res.overlay.marks.map((m) => (JSON.parse(m.key) as { y?: [string, string] }).y?.[1]));
    expect(keys.has(cats[0]!.key)).toBe(true);
    const pick = runChart(index, specFor("two-sides", { options: { dim: "source", sideA: cats[1]!.key, sideB: cats[0]!.key } }), vis, { now: NOW });
    const first = pick.overlay.items.filter((i) => i.type === "label")[0];
    expect(first).toBeDefined();
  });
  it("is empty rather than broken when the dimension has no two values", () => {
    const res = runChart(index, specFor("two-sides", { filter: [{ dim: "speaker", value: "you" }] }), vis, { now: NOW });
    expect(res.arr.length).toBe(index.count * 3);
    expect(countPlaced(res.arr)).toBe(0);
  });
});

describe("Shells swirl rows (CHART-16)", () => {
  it("rows is the default form, nested stays available", () => {
    expect(shellsForm({})).toBe("rows");
    expect(shellsForm({ form: "nested" })).toBe("nested");
    expect(shellsForm({ form: "bogus" })).toBe("rows");
  });
  it("lays particles on spiral arms (unit directions, a winding azimuth) rather than at random", () => {
    const out: [number, number, number] = [0, 0, 0];
    const n = 60;
    for (let k = 0; k < n; k++) {
      swirlDir(k, n, SWIRL_ARMS, SWIRL_TURNS, 0, out);
      expect(Math.hypot(out[0], out[1], out[2])).toBeCloseTo(1, 6);
    }
    // Along one arm the azimuth advances steadily from pole to pole.
    const arm: number[] = [];
    for (let k = 0; k < n; k += SWIRL_ARMS) {
      swirlDir(k, n, SWIRL_ARMS, SWIRL_TURNS, 0, out);
      arm.push(Math.atan2(out[1], out[0]));
    }
    const steps = arm.slice(1).map((a, i) => (((a - arm[i]!) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
    const mean = steps.reduce((s, v) => s + v, 0) / steps.length;
    for (const s of steps) expect(Math.abs(s - mean)).toBeLessThan(1e-6);
    swirlDir(7, n, SWIRL_ARMS, SWIRL_TURNS, 0, out);
    const a = [...out];
    swirlDir(7, n, SWIRL_ARMS, SWIRL_TURNS, 0, out);
    expect([...out]).toEqual(a);
    swirlDir(7, n, SWIRL_ARMS, SWIRL_TURNS, 1.3, out);
    expect([...out]).not.toEqual(a);
  });
  it("draws one row per group and one sphere per value, sized by count, within its sphere", () => {
    const spec = specFor("nested-bubbles", { x: { dim: "space", sort: "count" }, y: { dim: "source", sort: "count" } });
    const res = runChart(index, spec, vis, { now: NOW });
    expect(countPlaced(res.arr)).toBeGreaterThan(0);
    const spheres = res.overlay.marks.map((m) => ({ ...(JSON.parse(m.key) as { x: [string, string]; y: [string, string] }), count: m.count, bounds: m.bounds }));
    expect(spheres.length).toBeGreaterThan(1);
    const rows = new Set(spheres.map((s) => s.x[1]));
    expect(rows.size).toBeLessThanOrEqual(SHELL_ROWS_MAX + 1);
    // One sphere per (row, value); the same value shares a column across rows.
    expect(new Set(spheres.map((s) => `${s.x[1]}|${s.y[1]}`)).size).toBe(spheres.length);
    const colOf = new Map<string, number>();
    for (const s of spheres) {
      const cx = (s.bounds.min[0] + s.bounds.max[0]) / 2;
      const prev = colOf.get(s.y[1]);
      if (prev !== undefined) expect(Math.abs(prev - cx)).toBeLessThan(1e-4);
      colOf.set(s.y[1], cx);
    }
    // Radius grows with the count (the larger sphere is at least as big as the smaller).
    const sorted = [...spheres].sort((a, b) => a.count - b.count);
    const rad = (s: (typeof spheres)[number]) => (s.bounds.max[0] - s.bounds.min[0]) / 2;
    expect(rad(sorted[sorted.length - 1]!)).toBeGreaterThanOrEqual(rad(sorted[0]!) - 1e-6);
    // Every particle sits on its sphere's shell.
    const markOfCentre = res.overlay.marks.map((m) => ({ c: [(m.bounds.min[0] + m.bounds.max[0]) / 2, (m.bounds.min[1] + m.bounds.max[1]) / 2, (m.bounds.min[2] + m.bounds.max[2]) / 2], r: (m.bounds.max[0] - m.bounds.min[0]) / 2 }));
    let checked = 0;
    for (let o = 0; o < index.count && checked < 400; o++) {
      const x = res.arr[o * 3]!;
      if (!Number.isFinite(x)) continue;
      const near = markOfCentre.some((m) => Math.hypot(x - m.c[0]!, res.arr[o * 3 + 1]! - m.c[1]!, res.arr[o * 3 + 2]! - m.c[2]!) <= m.r + 1e-4);
      expect(near).toBe(true);
      checked++;
    }
  });
  it("labels each sphere beneath it and keeps the nested form", () => {
    const spec = specFor("nested-bubbles", { x: { dim: "space", sort: "count" }, y: { dim: "source", sort: "count" } });
    const rows = runChart(index, spec, vis, { now: NOW });
    expect(rows.overlay.items.filter((i) => i.type === "label").length).toBeGreaterThan(0);
    const nested = runChart(index, { ...spec, options: { form: "nested" } }, vis, { now: NOW });
    expect(countPlaced(nested.arr)).toBeGreaterThan(0);
    expect(nested.overlay.items.some((i) => i.type === "polyline")).toBe(true);
  });
});

describe("Comet streaks (CHART-20)", () => {
  const big: CometBox = { x0: 0, y0: 0, x1: 300, y1: 200, count: 5000 };
  it("gives bigger and fuller boxes more streaks, tiny or empty boxes none", () => {
    expect(cometsForBox(0, 300, 200)).toBe(0);
    expect(cometsForBox(50, 20, 200)).toBe(0);
    expect(cometsForBox(5, 100, 100)).toBeGreaterThanOrEqual(1);
    expect(cometsForBox(5000, 300, 200)).toBeGreaterThan(cometsForBox(5, 300, 200));
    expect(cometsForBox(1e9, 900, 900)).toBeLessThanOrEqual(COMET_PER_BOX_MAX);
  });
  it("keeps the whole chart within its budget, fullest boxes first", () => {
    const boxes: CometBox[] = Array.from({ length: 200 }, (_, i) => ({ x0: 0, y0: 0, x1: 200, y1: 200, count: 1000 - i }));
    const plan = planComets(boxes);
    expect(plan.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(COMET_TOTAL_MAX);
    expect(plan[0]!).toBeGreaterThan(0);
    expect(plan[199]!).toBe(0);
  });
  it("moves a streak along its heading and restarts it once it has left the box", () => {
    const rand = rng(3);
    const c = { ...spawnComet(0, big, rand, true), x: 150, y: 100, angle: 0, speed: 100, tail: 20 };
    const moved = stepComet(c, big, 0.5, rand);
    expect(moved.x).toBeCloseTo(200, 6);
    expect(moved.y).toBeCloseTo(100, 6);
    const gone = stepComet({ ...c, x: 290, tail: 10 }, big, 1, rand);
    expect(gone.x).toBeGreaterThanOrEqual(big.x0 - 1e-6);
    expect(gone.x).toBeLessThanOrEqual(big.x1 + 1e-6);
    const e = tailEnd({ ...c });
    expect(e.x).toBeCloseTo(130, 6);
  });
  it("is deterministic and re-fits to moved boxes", () => {
    const boxes = boxesFromMarks([{ x0: 0, y0: 0, x1: 300, y1: 200, count: 100 }, { x0: 300, y0: 0, x1: 400, y1: 200, count: 0 }]);
    expect(boxes).toHaveLength(1);
    expect(makeComets(boxes, 9)).toEqual(makeComets(boxes, 9));
    const comets = makeComets(boxes, 9);
    const moved = refitComets(comets, boxes, [{ x0: 100, y0: 50, x1: 700, y1: 450, count: 100 }])!;
    expect(moved).toHaveLength(comets.length);
    for (const c of moved) {
      expect(c.x).toBeGreaterThanOrEqual(100 - 1e-6);
      expect(c.x).toBeLessThanOrEqual(700 + 1e-6);
    }
    expect(refitComets(comets, boxes, [])).toBeNull();
  });
});

describe("Waves label flicker (CHART-37)", () => {
  it("alternates for a few hundred ms and then stays on", () => {
    const steps = blinkSteps(false);
    expect(steps.length).toBeGreaterThan(2);
    expect(steps[0]).toBe(false);
    expect(steps[steps.length - 1]).toBe(true);
    expect(steps[steps.length - 2]).toBe(true);
    for (let i = 1; i < steps.length - 1; i++) expect(steps[i]).not.toBe(steps[i - 1]);
    expect(steps.length * BLINK_STEP_MS).toBeLessThanOrEqual(BLINK_MS + 2 * BLINK_STEP_MS);
    expect(steps.length * BLINK_STEP_MS).toBeGreaterThanOrEqual(200);
  });
  it("does not flicker under reduced motion, and only for the waves", () => {
    expect(blinkSteps(true)).toEqual([]);
    expect(blinkApplies("ridgeline")).toBe(true);
    for (const id of CHART_IDS.filter((c) => c !== "ridgeline")) expect(blinkApplies(id)).toBe(false);
  });
});

describe("Question and answer lines (TB-18)", () => {
  const base: AnswerInput = {
    chart: "ranked-bars",
    x: "space",
    y: null,
    colour: null,
    options: {},
    categories: [],
    marks: [],
    placed: 100,
    name: (_d, k, f) => f || k,
    dimName: (d) => d,
    period: (a, b) => `${a}-${b}`,
  };
  const mark = (ref: object, count: number, label = "m") => ({ label, count, key: JSON.stringify(ref) });

  it("formats shares and day runs", () => {
    expect(shareText(23, 100)).toBe("23%");
    expect(shareText(1, 1000)).toBe("<1%");
    expect(shareText(0, 10)).toBe("0%");
    expect(longestDayRun([1, 2, 3, 7, 8])).toBe(3);
    expect(longestDayRun([4, 4, 5])).toBe(2);
    expect(longestDayRun([])).toBe(0);
    const midnight = new Date(2026, 10, 10).getTime();
    expect(dayNumber(new Date(2026, 10, 11).getTime()) - dayNumber(midnight)).toBe(1);
  });
  it("names the leading value of a count chart", () => {
    const a = buildAnswer({ ...base, categories: [{ key: "a", label: "Alpha", count: 60 }, { key: "__other__", label: "Other", count: 90 }, { key: "b", label: "Beta", count: 20 }] });
    expect(a.question).toEqual({ key: "answers.q.rankedBars", values: { x: "space" } });
    expect(a.answer).toEqual({ key: "answers.a.top", values: { name: "Alpha", n: "60", total: "100", share: "60%" } });
  });
  it("says active days, the longest run and the busiest day for the calendar", () => {
    const day = (d: number, n: number) => mark({ t: [new Date(2026, 0, d).getTime(), new Date(2026, 0, d + 1).getTime()] }, n);
    const a = buildAnswer({ ...base, chart: "calendar-heatmap", marks: [day(1, 2), day(2, 5), day(3, 1), day(10, 3)] });
    expect(a.answer?.key).toBe("answers.a.days");
    expect(a.answer?.values).toMatchObject({ days: "4", run: 3, n: "5" });
    const lone = buildAnswer({ ...base, chart: "calendar-heatmap", marks: [day(1, 2), day(9, 1)] });
    expect(lone.answer?.key).toBe("answers.a.daysOne");
  });
  it("names the longest lane", () => {
    const D = 86_400_000;
    const a = buildAnswer({ ...base, chart: "timeline-lanes", marks: [mark({ y: ["space", "a"], span: [0, 10 * D] }, 5, "A"), mark({ y: ["space", "b"], span: [0, 30 * D] }, 2, "B")] });
    expect(a.answer).toEqual({ key: "answers.a.lanes", values: { k: "2", name: "B", days: "31" } });
  });
  it("counts the periods one side led (diverging and balance)", () => {
    const side = (k: string, t0: number, n: number) => mark({ y: ["speaker", k], t: [t0, t0 + 1] }, n);
    const marks = [side("you", 0, 5), side("assistant", 0, 2), side("you", 1, 1), side("assistant", 1, 4), side("you", 2, 9)];
    const a = buildAnswer({ ...base, chart: "diverging-area", marks });
    expect(a.answer).toEqual({ key: "answers.a.sides", values: { a: "you", na: "15", b: "assistant", nb: "6", k: 2, m: 3 } });
    const swapped = buildAnswer({ ...base, chart: "two-sides", options: { sideA: "assistant", sideB: "you" }, categories: [{ key: "you", label: "you", count: 3 }, { key: "assistant", label: "assistant", count: 3 }], marks });
    expect(swapped.answer?.values).toMatchObject({ a: "assistant", b: "you", k: 1, m: 3 });
  });
  it("has no answer when nothing is placed", () => {
    for (const id of CHART_IDS) expect(buildAnswer({ ...base, chart: id, placed: 0 }).answer).toBeNull();
  });

  it("gives every chart a question and, on the sample record, a worded answer that moves with the scope", () => {
    for (const id of CHART_IDS) {
      const v = feedValue(specFor(id));
      const text = answerTextOf(v);
      expect(text.question, id).not.toMatch(/\{|answers\./);
      expect(text.question.endsWith("?"), id).toBe(true);
      if (countPlaced(v.result.arr) > 0) {
        expect(text.answer, id).not.toBeNull();
        expect(text.answer, id).not.toMatch(/\{|answers\./);
      }
    }
    const all = answerTextOf(feedValue(specFor("ranked-bars")));
    const youOnly = answerTextOf(feedValue(specFor("ranked-bars", { filter: [{ dim: "speaker", value: "you" }] })));
    expect(all.answer).not.toBe(youOnly.answer);
  });
  it("keeps its wording in the copy table", () => {
    const keys = Object.keys(COPY.answers.q).map((k) => `answers.q.${k}`).concat(Object.keys(COPY.answers.a).map((k) => `answers.a.${k}`));
    for (const key of keys) expect(t(key as CopyKey, { x: "x", y: "y", series: "s" })).not.toBe(key);
    expect(answerLineText({ key: "answers.a.top", values: { name: "N", n: "1", total: "2", share: "50%" } })).toContain("N");
  });
});

describe("Chord ribbons (connections)", () => {
  it("draws ribbons from the note links when the vault has no shared conversations", () => {
    const sample = buildSampleIndex(20261110, NOW);
    sample.cols.conv.fill(0xffffffff);
    const res = runChart(sample, specFor("chord", { y: null, x: { dim: "month", sort: "date" } }), defaultVisibility(sample.count), { now: NOW });
    expect(res.overlay.items.filter((i) => i.type === "polyline").length).toBeGreaterThan(cmpArcs(res));
  });
});

function cmpArcs(res: ReturnType<typeof runChart>): number {
  return (res.categories ?? []).length;
}

describe("Alluvial node names", () => {
  it("names the largest nodes first and skips a node whose label would touch a named one", () => {
    // Heights 0, -0.1, -0.2 ...: the big node at 0 takes its name; the small ones within 0.25 of it stay quiet.
    const named = namedNodes([0, -0.1, -0.2, -0.6], [100, 5, 4, 3], 0.25);
    expect([...named].sort()).toEqual([0, 3]);
  });
  it("never names an empty node", () => {
    expect([...namedNodes([0, -1], [0, 2], 0.25)]).toEqual([1]);
  });
});

describe("Member titles of a zoomed cell", () => {
  it("never places a title on top of one already placed", () => {
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    expect(placeTitle(placed, 100, 100, 20)).toBe(true);
    expect(placeTitle(placed, 150, 104, 20)).toBe(false);
    expect(placeTitle(placed, 100, 130, 20)).toBe(true);
    expect(placed).toHaveLength(2);
  });
});

describe("Default series of the time forms", () => {
  it("names the dimension the worker really runs the series along when the vertical row is empty", () => {
    for (const [chart, dim] of Object.entries(DEFAULT_SERIES) as [ChartId, string][]) {
      const g = CHART_CATALOGUE.find((c) => c.id === chart)!.group;
      expect(["time", "rhythm"]).toContain(g);
      const res = runChart(index, { ...specFor(chart), y: null }, vis, { now: NOW });
      const dims = new Set(res.overlay.marks.map((m) => { const k = JSON.parse(m.key) as { x?: [string, string]; y?: [string, string] }; return k.y?.[0] ?? k.x?.[0]; }));
      expect(dims.has(dim)).toBe(true);
    }
  });
});

describe("Labels that would touch", () => {
  it("keeps the biggest of two labels whose text boxes meet, and every label that stands clear", () => {
    const kept = clearLabels([{ x: 0, y: 0, w: 1, size: 5 }, { x: 0.4, y: 0.05, w: 1, size: 50 }, { x: 0, y: 1, w: 1, size: 1 }, { x: 3, y: 0.05, w: 1, size: 2 }], 0.3);
    expect([...kept].sort()).toEqual([1, 2, 3]);
  });
});
