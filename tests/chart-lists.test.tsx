/**
 * The Chart page's value lists (P10): the Combine values checklist and its Largest select, the Folders form with its
 * Boxes | Tree switch and folder tree, and the saved charts (name, save, apply, remove) over a pinned-views stub.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import type { PinnedViewService } from "../src/plugin/services";
import type { ChartSpec } from "../src/shared/protocol/worker";
import type { PinnedViewRecord } from "../src/shared/types";
import { setView } from "../src/state/actions";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { t } from "../src/ui/copy";
import { ChartPage, setFolderIncluded } from "../src/ui/pages/ChartPage";
import {
  allLevelsShown,
  ChartFolders,
  defaultOpenDepth,
  folderRows,
  formOf,
  isFolderAxis,
  setFolderOpen,
  visibleFolderRows,
  withAllLevels,
  withFoldersForm,
} from "../src/ui/pages/chart/ChartFolders";
import {
  applyCombine,
  ChartMergeList,
  combinedGroups,
  combineKeys,
  largestOptions,
  largestValue,
  shownValues,
  undoCombine,
  valueRows,
  valuesFooter,
  withLargest,
} from "../src/ui/pages/chart/ChartMergeList";
import { applySavedChart, hasChart, memoryViews, SavedTables, saveableName, savedCharts, saveChartAs } from "../src/ui/pages/chart/SavedTables";
import { renamesOf } from "../src/ui/stage/ChartOverlay";
import { areaLabel } from "../src/ui/valueLabels";
import { fakeServices } from "./helpers/fakeServices";

function spec(over: Partial<ChartSpec> = {}): ChartSpec {
  return { chart: "ranked-bars", x: { dim: "space", sort: "count" }, y: null, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options: {}, ...over };
}

const h = fakeServices();
const wrap = (node: preact.ComponentChild) =>
  render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>{node}</LeafContext.Provider>
    </ServicesContext.Provider>,
  );

const AREAS = [
  { key: "code", label: "Work", count: 164 },
  { key: "web", label: "Home", count: 90 },
  { key: "data", label: "Study", count: 31 },
];

describe("Combine values", () => {
  it("lists the values with their counts and the helper line", () => {
    const html = wrap(<ChartMergeList spec={spec()} setSpec={() => undefined} categories={AREAS} />);
    expect(html).toContain(t("chart.combineValues"));
    expect(html).toContain(t("chart.combineHint"));
    expect(html).toContain("164");
    expect(html).toContain(`>${areaLabel("code")}<`);
    expect(html).toContain("cx-chart-values");
  });

  it("ticking two values and combining writes spec.combined the way the stage's Combine with… does", () => {
    const next = applyCombine(spec(), ["code", "web"], "", "Work");
    expect(next.combined).toEqual({ "space=code": ["web"] });
    expect(renamesOf(next.options)).toEqual({});
    expect(applyCombine(spec(), ["code"], "x", "Work")).toEqual(spec());
  });

  it("the name asked for inline is stored as the group's name, and the first value's own name is not a rename", () => {
    const named = applyCombine(spec(), ["code", "web", "data"], "Everyday", "Work");
    expect(named.combined).toEqual({ "space=code": ["web", "data"] });
    expect(renamesOf(named.options)).toEqual({ "space=code": "Everyday" });
    expect(renamesOf(applyCombine(spec(), ["code", "web"], "Work", "Work").options)).toEqual({});
  });

  it("a ticked value that already heads a group brings its members along, so groups never nest", () => {
    const before = spec({ combined: { "space=web": ["data"] } });
    const next = combineKeys(before.combined, "space", ["code", "web"]);
    expect(next).toEqual({ "space=code": ["web", "data"] });
  });

  it("keeps the groups of other dimensions", () => {
    const next = combineKeys({ "source=a": ["b"] }, "space", ["code", "web"]);
    expect(next).toEqual({ "source=a": ["b"], "space=code": ["web"] });
  });

  it("lists the combined groups of the horizontal dimension and Undo removes the group and its name", () => {
    const s = applyCombine(spec(), ["code", "web"], "Everyday", "Work");
    expect(combinedGroups(s.combined, "space")).toEqual([{ head: "code", members: ["web"] }]);
    expect(combinedGroups(s.combined, "source")).toEqual([]);
    const undone = undoCombine(s, "space", "code");
    expect(undone.combined).toEqual({});
    expect(renamesOf(undone.options)).toEqual({});
    expect(combinedGroups({ code: ["web"] }, "space")).toEqual([{ head: "code", members: ["web"] }]);
  });

  it("shows an already combined group with an Undo", () => {
    const s = applyCombine(spec(), ["code", "web"], "Everyday", "Work");
    const html = wrap(<ChartMergeList spec={s} setSpec={() => undefined} categories={[{ key: "code", label: "Work", count: 254 }, AREAS[2]!]} />);
    expect(html).toContain(t("chart.combineUndo"));
    expect(html).toContain("Everyday · 2 values");
  });

  it("an empty index shows a note, not a list", () => {
    const html = wrap(<ChartMergeList spec={spec()} setSpec={() => undefined} categories={[]} />);
    expect(html).toContain(t("chart.noValues"));
    expect(html).not.toContain("<ul class=\"cx-chart-values\"");
  });

  it("the remainder bucket is not offered as a value", () => {
    expect(valueRows([...AREAS, { key: "__other__", label: "Other", count: 5 }]).map((r) => r.key)).toEqual(["code", "web", "data"]);
  });
});

describe("Largest and the value footer", () => {
  it("Largest offers 5 · 10 · 20 · 40 · 60 · All and All writes top 'all'", () => {
    expect(largestOptions(20).map((o) => o.value)).toEqual(["5", "10", "20", "40", "60", "all"]);
    expect(largestOptions(20).at(-1)?.label).toBe(t("chart.largestAll"));
    expect(withLargest(spec({ top: 20 }), "all").top).toBe("all");
    expect(withLargest(spec({ top: "all" }), "10").top).toBe(10);
    expect(withLargest(spec(), "999").top).toBe(60);
    expect(largestValue("all")).toBe("all");
    expect(largestValue(40)).toBe("40");
  });

  it("keeps a number a saved chart carries as its own choice", () => {
    expect(largestOptions(17).map((o) => o.value)).toEqual(["5", "10", "17", "20", "40", "60", "all"]);
  });

  it("the footer says how many values there are and how many the chart shows", () => {
    expect(valuesFooter(20, 107)).toBe("All 107 values, the 20 largest shown");
    expect(valuesFooter("all", 107)).toBe("All 107 values");
    expect(valuesFooter(60, 12)).toBe("All 12 values");
    expect(shownValues(20, 107)).toEqual({ all: false, n: 20 });
  });

  it("renders the footer and the Largest select", () => {
    const html = wrap(<ChartMergeList spec={spec({ top: 5 })} setSpec={() => undefined} categories={AREAS} />);
    expect(html).toContain("All 3 values");
    expect(html).toContain(`${t("chart.largest")}: 5`);
  });
});

const TREE = [
  { key: "Medical", label: "Medical", count: 40 },
  { key: "Medical/School", label: "School", count: 25 },
  { key: "Medical/School/Notes", label: "Notes", count: 10 },
  { key: "Medical/Research", label: "Research", count: 15 },
  { key: "Home", label: "Home", count: 8 },
];

describe("Folders form", () => {
  it("Boxes | Tree switches the chart between Treemap and Icicle and keeps the unticked folders and every option", () => {
    let s = spec({ chart: "treemap", x: { dim: "folderPath", sort: "count" }, options: { allLevels: true, counts: false } });
    s = setFolderIncluded(s, "Home", false);
    const tree = withFoldersForm(s, "tree");
    expect(tree.chart).toBe("icicle");
    expect(tree.options).toEqual(s.options);
    expect(tree.options.excludedFolders).toEqual(["Home"]);
    expect(formOf(tree)).toBe("tree");
    const back = withFoldersForm(tree, "boxes");
    expect(back).toEqual({ ...s, chart: "treemap" });
    expect(withFoldersForm(s, "boxes")).toBe(s);
  });

  it("only a folder axis draws a folder tree", () => {
    expect(isFolderAxis(spec({ chart: "treemap", x: { dim: "folderPath", sort: "count" } }))).toBe(true);
    expect(isFolderAxis(spec({ chart: "treemap" }))).toBe(false);
  });

  it("rows come with their depth and whether they have children", () => {
    const rows = folderRows(TREE);
    expect(rows.map((r) => [r.key, r.depth, r.hasChildren])).toEqual([
      ["Medical", 0, true],
      ["Medical/School", 1, true],
      ["Medical/School/Notes", 2, false],
      ["Medical/Research", 1, false],
      ["Home", 0, false],
    ]);
  });

  it("levels below the first start collapsed in a Treemap; the chevron writes expanded, and again collapsed", () => {
    const s = spec({ chart: "treemap", x: { dim: "folderPath", sort: "count" } });
    const rows = folderRows(TREE);
    expect(visibleFolderRows(s, rows).map((r) => r.key)).toEqual(["Medical", "Medical/School", "Medical/Research", "Home"]);
    const opened = setFolderOpen(s, "Medical/School", true);
    expect(opened.options.expanded).toEqual(["Medical/School"]);
    expect(visibleFolderRows(opened, rows).map((r) => r.key)).toContain("Medical/School/Notes");
    const closed = setFolderOpen(opened, "Medical/School", false);
    expect(closed.options.expanded).toEqual([]);
    expect(closed.options.collapsed).toEqual(["Medical/School"]);
    expect(visibleFolderRows(closed, rows).map((r) => r.key)).not.toContain("Medical/School/Notes");
  });

  it("closing a top folder hides everything under it", () => {
    const s = setFolderOpen(spec({ chart: "treemap", x: { dim: "folderPath", sort: "count" } }), "Medical", false);
    expect(s.options.collapsed).toEqual(["Medical"]);
    expect(visibleFolderRows(s, folderRows(TREE)).map((r) => r.key)).toEqual(["Medical", "Home"]);
  });

  it("an Icicle lists the rows the chart draws on its own (as deep as fits)", () => {
    const s = spec({ chart: "icicle", x: { dim: "folderPath", sort: "count" } });
    expect(defaultOpenDepth(s, folderRows(TREE))).toBeGreaterThanOrEqual(3);
    expect(visibleFolderRows(s, folderRows(TREE))).toHaveLength(5);
  });

  it("Show all opens every level and Show fewer returns to the defaults", () => {
    const rows = folderRows(TREE);
    const box = spec({ chart: "treemap", x: { dim: "folderPath", sort: "count" } });
    expect(allLevelsShown(box, rows)).toBe(false);
    const all = withAllLevels(box, rows, true);
    expect(all.options.allLevels).toBe(true);
    expect(allLevelsShown(all, rows)).toBe(true);
    expect(withAllLevels(all, rows, false).options.allLevels).toBe(false);

    const ici = spec({ chart: "icicle", x: { dim: "folderPath", sort: "count" } });
    const big = Array.from({ length: 60 }, (_, i) => [`F${i}`, `F${i}/a`, `F${i}/a/b`]).flat().map((key) => ({ key, label: key.split("/").at(-1)!, count: 3 }));
    const bigRows = folderRows(big);
    expect(allLevelsShown(ici, bigRows)).toBe(false);
    const open = withAllLevels(ici, bigRows, true);
    expect(open.options.expanded).toHaveLength(120);
    expect(allLevelsShown(open, bigRows)).toBe(true);
    const fewer = withAllLevels(open, bigRows, false);
    expect(fewer.options.expanded).toBeUndefined();
    expect(allLevelsShown(fewer, bigRows)).toBe(false);
  });

  it("ticking a folder reuses the unticked list; a child of an unticked folder shows unticked", () => {
    const s = setFolderIncluded(spec({ chart: "treemap" }), "Medical", false);
    expect(s.options.excludedFolders).toEqual(["Medical"]);
    expect(setFolderIncluded(s, "Medical", true).options.excludedFolders).toEqual([]);
  });

  it("renders the Folders section with Boxes | Tree, Show all and a scrolling tree", () => {
    const html = wrap(<ChartFolders spec={spec({ chart: "treemap", x: { dim: "folderPath", sort: "count" } })} setSpec={() => undefined} categories={TREE} />);
    expect(html).toContain(t("chart.foldersBoxes"));
    expect(html).toContain(t("chart.foldersTree"));
    expect(html).toContain(t("chart.showAll"));
    expect(html).toContain('role="tree"');
    expect(html).toContain("Medical");
    expect(html).toContain(t("chart.expandFolder", { name: "School" }));
    expect(html).not.toContain(">Notes<");
    expect(html).toContain(t("chart.collapseFolder", { name: "Medical" }));
  });

  it("a Treemap that is not drawn by folder offers to draw by folder", () => {
    const html = wrap(<ChartFolders spec={spec({ chart: "treemap" })} setSpec={() => undefined} categories={AREAS} />);
    expect(html).toContain(t("chart.drawByFolder"));
    expect(html).not.toContain('role="tree"');
  });
});

function stubService(): PinnedViewService & { rows: PinnedViewRecord[] } {
  const rows: PinnedViewRecord[] = [];
  return {
    rows,
    list: async () => [...rows].reverse(),
    get: async (id) => rows.find((r) => r.id === id),
    async save(name, state) {
      const rec: PinnedViewRecord = { id: `v_stub${rows.length}`, name, state: JSON.parse(JSON.stringify(state)), at: new Date(1_000 + rows.length).toISOString() };
      rows.push(rec);
      return rec;
    },
    async remove(id) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
  };
}

describe("Saved charts", () => {
  it("saves the leaf's current state under the name, lists it, applies it and removes it", async () => {
    const hh = fakeServices();
    const store = hh.leaf.store;
    const svc = stubService();
    const mine = spec({ chart: "matrix", y: { dim: "source", sort: "count" }, top: "all", combined: { "space=code": ["web"] } });
    setView(store, "chart", mine);

    const rec = await saveChartAs(svc, store, "  My   matrix ");
    expect(rec?.name).toBe("My matrix");
    expect(await saveChartAs(svc, store, "   ")).toBeNull();
    expect(svc.rows).toHaveLength(1);

    // A view with no chart is stored by Pin view too; the list keeps only charts.
    svc.rows.push({ id: "v_plain", name: "Brain only", state: { v: 1, view: { shape: "body" } }, at: new Date(5).toISOString() });
    const listed = savedCharts(await svc.list());
    expect(listed.map((r) => r.name)).toEqual(["My matrix"]);
    expect(hasChart(listed[0]!.state)).toBe(true);
    expect(hasChart({ v: 1, view: { chart: null } })).toBe(false);
    expect(hasChart(null)).toBe(false);

    // Apply: change the chart, then put the saved one back; the Chart page is open on it.
    setView(store, "chart", spec({ chart: "treemap" }));
    applySavedChart(store, listed[0]!, hh.services.settings.value);
    const restored = store.get("view").chart;
    expect(restored?.chart).toBe("matrix");
    expect(restored?.top).toBe("all");
    expect(restored?.combined).toEqual({ "space=code": ["web"] });
    const ui = store.get("ui");
    expect(ui.sheet.open).toBe(true);
    expect(ui.sheet.stack[ui.sheet.index]).toMatchObject({ kind: "page", route: "chart" });

    await svc.remove(listed[0]!.id);
    expect(savedCharts(await svc.list())).toEqual([]);
  });

  it("saving under a name that exists replaces it (the service keeps one view per name)", async () => {
    const svc = memoryViews();
    const hh = fakeServices();
    setView(hh.leaf.store, "chart", spec({ top: 10 }));
    const a = await saveChartAs(svc, hh.leaf.store, "Areas");
    setView(hh.leaf.store, "chart", spec({ top: 40 }));
    const b = await saveChartAs(svc, hh.leaf.store, "areas");
    expect(b?.id).toBe(a?.id);
    const rows = await svc.list();
    expect(rows).toHaveLength(1);
    expect((rows[0]!.state as { view: { chart: ChartSpec } }).view.chart.top).toBe(40);
  });

  it("the in-memory service used for the sample record round-trips and removes", async () => {
    const svc = memoryViews(() => 5);
    const rec = await svc.save("One", { v: 1, view: { chart: { chart: "treemap" } } });
    expect(await svc.get(rec.id)).toEqual(rec);
    await svc.remove(rec.id);
    expect(await svc.list()).toEqual([]);
  });

  it("a blank or spaced name is cleaned; blank is refused", () => {
    expect(saveableName("  a   b ")).toBe("a b");
    expect(saveableName(" \n ")).toBeNull();
  });

  it("renders the field, the Save button and the empty note", () => {
    const html = wrap(<SavedTables />);
    expect(html).toContain(t("chart.nameThisChart"));
    expect(html).toContain(t("chart.saveChart"));
    expect(html).toContain(t("chart.savedEmpty"));
    expect(t("chart.savedEmpty")).toBe("Saved charts show up here.");
  });
});

describe("Chart page with the lists", () => {
  it("renders with an empty index and no chart value yet (Treemap by folder, then a ranked chart)", () => {
    const hh = fakeServices();
    setView(hh.leaf.store, "chart", spec({ chart: "treemap", x: { dim: "folderPath", sort: "count" } }));
    const wrapped = (node: preact.ComponentChild) =>
      render(
        <ServicesContext.Provider value={hh.services}>
          <LeafContext.Provider value={hh.leaf}>{node}</LeafContext.Provider>
        </ServicesContext.Provider>,
      );
    const tree = wrapped(<ChartPage params={{}} />);
    expect(tree).toContain(t("chart.foldersBoxes"));
    expect(tree).toContain(t("chart.savedCharts"));
    expect(tree).not.toContain(t("chart.combineValues"));
    expect(tree).not.toContain(t("chart.fields"));

    setView(hh.leaf.store, "chart", spec());
    const bars = wrapped(<ChartPage params={{}} />);
    expect(bars).toContain(t("chart.combineValues"));
    expect(bars).toContain(t("chart.startAndFields"));
    expect(bars).toContain(t("chart.savedCharts"));
    expect(bars).not.toContain(t("chart.foldersBoxes"));
  });
});
