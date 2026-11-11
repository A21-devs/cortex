/**
 * The Time and Waves charts use the stage size helpers (CHART-03): tick rows and rotation, and the row-name columns,
 * switch with the room the visible stage gives them; the chart feed's own request carries the stage too.
 */
import { describe, expect, it } from "vitest";
import { chartStageOf, labelScale, oneColumnStride } from "../src/shared/chartStage";
import type { ChartSpec, OverlayItem } from "../src/shared/protocol/worker";
import { defaultVisibility, rowLabelSlots } from "../src/worker/charts/common";
import { runChart } from "../src/worker/charts/registry";
import { tickLayout } from "../src/worker/charts/time";
import { buildSampleIndex } from "../src/worker/sampleIndex";
import { CHART_CATALOGUE } from "../src/shared/views";

const NOW = Date.UTC(2026, 10, 10);
const index = buildSampleIndex(20261110, NOW);
const vis = defaultVisibility(index.count);
const WIDE = chartStageOf(1200, 700);
const NARROW = chartStageOf(400, 700);

function spec(chart: ChartSpec["chart"], over: Partial<ChartSpec> = {}): ChartSpec {
  const g = CHART_CATALOGUE.find((c) => c.id === chart)!.group;
  return { chart, x: { dim: g === "time" ? "week" : "space", sort: "count" }, y: null, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options: {}, ...over };
}
const labels = (items: readonly OverlayItem[]) => items.filter((i): i is Extract<OverlayItem, { type: "label" }> => i.type === "label");

describe("time axis ticks follow the stage", () => {
  it("is unchanged without a stage and crowds sooner on a small one", () => {
    expect(labelScale(undefined)).toBe(1);
    expect(labelScale(NARROW)).toBeGreaterThan(labelScale(WIDE));
    const months = Array.from({ length: 10 }, () => "October 2022");
    expect(tickLayout(months, 10)).toEqual(tickLayout(months, 10, undefined));
    // Labels that fit level on the usual stage turn over on a stage that gives each unit far fewer pixels.
    const fits = Array.from({ length: 8 }, () => "Nov 2022");
    expect(tickLayout(fits, 10, WIDE).rotate).toBe(0);
    expect(tickLayout(fits, 10, chartStageOf(130, 80)).rotate).not.toBe(0);
  });
  it("turns the Waves time axis over on a stage that gives each unit few pixels, and keeps it level on a usual one", () => {
    const wave = spec("ridgeline", { x: { dim: "week", sort: "count" } });
    const rotated = (stage?: ReturnType<typeof chartStageOf>) => {
      const res = runChart(index, wave, vis, { now: NOW, ...(stage ? { stage } : {}) });
      return labels(res.overlay.items).filter((l) => l.align !== "left" && l.rotate !== undefined).length;
    };
    expect(rotated()).toBe(0);
    expect(rotated(WIDE)).toBe(0);
    expect(rotated(chartStageOf(160, 100))).toBeGreaterThan(0);
  });
});

describe("row names of Waves and Lifelines follow the stage", () => {
  it("rowLabelSlots keeps every row when there is room, thins crowded rows, and honours one column", () => {
    const all = rowLabelSlots(WIDE, 1, 0);
    expect([0, 1, 2, 3].every((i) => all(i) !== null)).toBe(true);
    const crowded = rowLabelSlots(WIDE, 0.05, 0);
    const xs = new Set<number>();
    let shown = 0;
    for (let i = 0; i < 40; i++) {
      const s = crowded(i);
      if (s) {
        shown += 1;
        xs.add(s.x);
      }
    }
    expect(xs.size).toBe(2);
    expect(shown).toBeLessThan(40);
    expect(crowded(1, true)).not.toBeNull();
    const one = rowLabelSlots(WIDE, 0.05, 0, 1);
    const used = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const s = one(i);
      if (s) used.add(s.x);
    }
    expect(used.size).toBe(1);
    expect(oneColumnStride(WIDE, 0.05)).toBeGreaterThan(1);
    // A narrow stage keeps a single column.
    const narrow = rowLabelSlots(NARROW, 0.05, 0);
    const nx = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const s = narrow(i);
      if (s) nx.add(s.x);
    }
    expect(nx.size).toBe(1);
  });
  it("names fewer Waves rows on a small stage than on the usual one", () => {
    const wave = spec("ridgeline", { x: { dim: "week", sort: "count" }, top: 60 });
    const names = (stage?: ReturnType<typeof chartStageOf>) => {
      const res = runChart(index, wave, vis, { now: NOW, ...(stage ? { stage } : {}) });
      return labels(res.overlay.items).filter((l) => l.align === "left" && l.style === "axis" && l.text !== "").length;
    };
    expect(names(chartStageOf(160, 100))).toBeLessThan(names());
    expect(names(WIDE)).toBe(names());
  });
});
