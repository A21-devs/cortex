/**
 * The Chart panel's order and its parts (C-01, C-02): the window sentence under the axes, the Shape and Question
 * chooser, the Filter checklist (largest first, ticks write the filter, a note when the list is cut), the collapsed
 * sections, and the order of the sections on the page.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import type { ChartSpec } from "../src/shared/protocol/worker";
import { CHART_CATALOGUE } from "../src/shared/views";
import { setView } from "../src/state/actions";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { t } from "../src/ui/copy";
import { galleryGroups, ChartPage } from "../src/ui/pages/ChartPage";
import { windowSentence } from "../src/ui/pages/chart/ChartAxesSection";
import { chooserGroups, padCells, SHAPE_CHARTS } from "../src/ui/pages/chart/ChartChooser";
import { FilterChecklist } from "../src/ui/pages/chart/ChartWhatShows";
import { activeFilterDim, clearKept, filterChoices, FILTER_SHOWN, isKept, toggleKept } from "../src/ui/pages/chart/chartFilter";
import { fakeServices } from "./helpers/fakeServices";

function spec(over: Partial<ChartSpec> = {}): ChartSpec {
  return { chart: "stream", x: { dim: "month", sort: "date" }, y: { dim: "folder", sort: "count" }, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options: {}, ...over } as ChartSpec;
}

describe("the window sentence", () => {
  it("names the dated span the charts cover, the last day inclusive", () => {
    const from = new Date(2019, 0, 1).getTime();
    const to = new Date(2026, 10, 5).getTime(); // exclusive: the period ends at midnight after 4 Nov
    const s = windowSentence([from, to]);
    expect(s).toContain("1 Jan 2019");
    expect(s).toContain("4 Nov 2026");
    expect(s.startsWith("Charts cover")).toBe(true);
  });
  it("reads the whole record when no period is set", () => {
    expect(windowSentence(null)).toBe(t("chart.windowWhole"));
    expect(windowSentence([Number.NaN, 1])).toBe(t("chart.windowWhole"));
  });
});

describe("the chooser", () => {
  it("splits every chart into Shape and Question without losing or repeating one", () => {
    for (const phase2 of [false, true]) {
      const groups = chooserGroups(phase2);
      expect(groups.map((g) => g.kind)).toEqual(["shape", "question"]);
      const all = groups.flatMap((g) => g.charts);
      expect(new Set(all).size).toBe(all.length);
      expect([...all].sort()).toEqual(galleryGroups(phase2).flatMap((g) => g.charts).sort());
    }
    expect(chooserGroups(true).flatMap((g) => g.charts).length).toBe(CHART_CATALOGUE.length);
    for (const id of SHAPE_CHARTS) expect(CHART_CATALOGUE.map((c) => c.id)).toContain(id);
  });
  it("pads the last row so the frame is whole", () => {
    expect(padCells(7)).toBe(1);
    expect(padCells(12)).toBe(0);
    expect(padCells(9)).toBe(3);
  });
});

describe("the Filter checklist", () => {
  const values = [
    { key: "a", label: "Alpha", count: 5 },
    { key: "b", label: "Beta", count: 50 },
    { key: "c", label: "Gamma", count: 0 },
    { key: "d", label: "Delta", count: 5 },
  ];
  it("lists values largest first, leaving out empty ones, ties by name", () => {
    const c = filterChoices(values);
    expect(c.rows.map((r) => r.key)).toEqual(["b", "a", "d"]);
    expect(c.total).toBe(3);
    expect(c.cut).toBe(false);
  });
  it("cuts a long list to the largest and says so", () => {
    const many = Array.from({ length: 208 }, (_, i) => ({ key: `k${i}`, label: `V${i}`, count: i + 1 }));
    const c = filterChoices(many);
    expect(c.rows).toHaveLength(FILTER_SHOWN);
    expect(c.rows[0]?.key).toBe("k207");
    expect(c.total).toBe(208);
    expect(c.cut).toBe(true);
    const html = render(<FilterChecklist dim="folder" values={many} spec={spec()} setSpec={() => {}} onKeepAll={() => {}} />);
    expect(html).toContain(t("chart.filterLargest", { n: FILTER_SHOWN }));
    expect(html).toContain(t("chart.filterTick"));
    expect(html).toContain("208 values");
  });
  it("ticks write the chart's filter and untick removes only that value", () => {
    let s = toggleKept(spec(), "folder", "b");
    s = toggleKept(s, "folder", "a");
    s = toggleKept(s, "source", "x");
    expect(s.filter).toEqual([{ dim: "folder", value: "b" }, { dim: "folder", value: "a" }, { dim: "source", value: "x" }]);
    expect(isKept(s, "folder", "a")).toBe(true);
    expect(toggleKept(s, "folder", "b").filter.map((f) => f.value)).toEqual(["a", "x"]);
    expect(clearKept(s, "folder").filter).toEqual([{ dim: "source", value: "x" }]);
    expect(clearKept(spec(), "folder")).toEqual(spec());
  });
  it("opens on the picked field, else the last field the chart already filters on", () => {
    expect(activeFilterDim(null, spec())).toBeNull();
    expect(activeFilterDim(null, spec({ filter: [{ dim: "folder", value: "a" }, { dim: "source", value: "b" }] }))).toBe("source");
    expect(activeFilterDim("kind", spec({ filter: [{ dim: "folder", value: "a" }] }))).toBe("kind");
  });
  it("draws ticked values checked and says when the values are loading", () => {
    const html = render(<FilterChecklist dim="folder" values={values} spec={spec({ filter: [{ dim: "folder", value: "b" }] })} setSpec={() => {}} onKeepAll={() => {}} />);
    expect(html).toContain("Beta");
    expect(html.match(/checked/g)?.length).toBe(1);
    expect(render(<FilterChecklist dim="folder" values={null} spec={spec()} setSpec={() => {}} onKeepAll={() => {}} />)).toContain(t("chart.filterLoading"));
  });
});

describe("the panel's order", () => {
  it("reads Axes, Showing, the chooser's two grids, options and readings, then the collapsed Show or hide", () => {
    const hh = fakeServices();
    setView(hh.leaf.store, "chart", spec());
    const html = render(
      <ServicesContext.Provider value={hh.services}>
        <LeafContext.Provider value={hh.leaf}>
          <ChartPage params={{}} />
        </LeafContext.Provider>
      </ServicesContext.Provider>,
    );
    const at = (s: string) => html.indexOf(`>${s}<`);
    const order = [t("chart.axes"), t("chart.whatShows"), t("chart.chooseShape"), t("chart.chooseQuestion"), t("chart.options"), t("chart.readings"), t("chart.showHide"), t("chart.startAndFields")].map(at);
    for (const i of order) expect(i).toBeGreaterThan(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain(t("chart.windowWhole"));
    // The chooser is four to a row with a hover name per cell.
    expect(html).toContain("is-four");
    expect(html).toContain('data-tip="Stream graph"');
  });
});
