/**
 * The Chart page's "Show or hide" checklist and "Start from" presets: the hidden-set functions, how the set is saved
 * and restored with a leaf (and so with Saved charts), the shared set the right-click on a chart label edits, the
 * presets and what they write, and both sections as drawn.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { applyPreset, axisRolesFor, presetMatches, START_PRESET_IDS, START_PRESETS } from "../src/shared/chartAxes";
import {
  checklistRows,
  HIDDEN_CAP,
  hiddenChips,
  hiddenKeyOf,
  hiddenOn,
  isHiddenValue,
  isOnlyValue,
  onlyValue,
  sameHidden,
  sanitizeHidden,
  showAllOf,
  toggleValue,
} from "../src/shared/chartHidden";
import { builtinDim } from "../src/shared/dims";
import type { ChartSpec } from "../src/shared/protocol/worker";
import { CHART_IDS } from "../src/shared/views";
import { setHiddenGroups, setView } from "../src/state/actions";
import { captureLeafState, restoreLeafState } from "../src/state/persist";
import { createLeafStore } from "../src/state/store";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { t } from "../src/ui/copy";
import { ChartPage } from "../src/ui/pages/ChartPage";
import { presetCopy, presetSummary, StartFromRow } from "../src/ui/pages/chart/ChartAxesSection";
import { ShowHideView, showHideAxes } from "../src/ui/pages/chart/ChartShowHide";
import { hiddenKey, labelContext } from "../src/ui/stage/ChartOverlay";
import { fakeServices } from "./helpers/fakeServices";
import { migrateSettingsChecked } from "../src/shared/settings";

function spec(over: Partial<ChartSpec> = {}): ChartSpec {
  return { chart: "matrix", x: { dim: "month", sort: "date" }, y: { dim: "folder", sort: "count" }, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options: {}, ...over };
}

const MONTHS = [
  { key: "2019-01", label: "Jan 2019", count: 46 },
  { key: "2019-04", label: "Apr 2019", count: 4 },
  { key: "2019-05", label: "May 2019", count: 14 },
  { key: "2019-06", label: "Jun 2019", count: 4 },
];
const ALL = MONTHS.map((m) => m.key);

describe("hidden-set functions", () => {
  it("writes the same key the stage's right-click and the key bar write", () => {
    expect(hiddenKeyOf("month", "2019-05")).toBe(hiddenKey(["month", "2019-05"]));
  });

  it("hides and shows one value without touching the others", () => {
    const one = toggleValue(["space=code"], "month", "2019-05");
    expect(one).toEqual(["space=code", "month=2019-05"]);
    expect(isHiddenValue(one, "month", "2019-05")).toBe(true);
    expect(toggleValue(one, "month", "2019-05")).toEqual(["space=code"]);
    expect(hiddenOn(one, "month")).toEqual(["2019-05"]);
    expect(hiddenOn(one, "space")).toEqual(["code"]);
  });

  it("a bare key (the worker accepts them) counts as hidden and is removed by showing the value", () => {
    expect(isHiddenValue(["2019-05"], "month", "2019-05")).toBe(true);
    expect(toggleValue(["2019-05"], "month", "2019-05")).toEqual([]);
  });

  it("Only hides every other value of that axis, and again brings the axis back; other axes keep their hides", () => {
    const solo = onlyValue(["space=code"], "month", ALL, "2019-05");
    expect(solo.sort()).toEqual(["month=2019-01", "month=2019-04", "month=2019-06", "space=code"]);
    expect(isOnlyValue(solo, "month", ALL, "2019-05")).toBe(true);
    expect(isOnlyValue(solo, "month", ALL, "2019-01")).toBe(false);
    expect(onlyValue(solo, "month", ALL, "2019-05")).toEqual(["space=code"]);
  });

  it("Only on a one-value list hides nothing, and an empty list has no 'only' value", () => {
    expect(onlyValue([], "month", ["2019-05"], "2019-05")).toEqual([]);
    expect(isOnlyValue([], "month", [], "2019-05")).toBe(false);
  });

  it("Show all clears everything, or just one axis' keys", () => {
    const h = ["month=2019-01", "space=code", "folder=a=b"];
    expect(showAllOf(h)).toEqual([]);
    expect(showAllOf(h, "month")).toEqual(["space=code", "folder=a=b"]);
  });

  it("the checklist lists the largest first, ties by name, with each row's shown state", () => {
    const rows = checklistRows(MONTHS, ["month=2019-04"], "month");
    expect(rows.map((r) => r.key)).toEqual(["2019-01", "2019-05", "2019-04", "2019-06"]);
    expect(rows.find((r) => r.key === "2019-04")?.shown).toBe(false);
    expect(rows.find((r) => r.key === "2019-01")?.shown).toBe(true);
    expect(rows[0]?.count).toBe(46);
  });

  it("one chip per hidden key; the chart's own axes split on their dimension even when the value has an '='", () => {
    const chips = hiddenChips(["folder=a=b", "space=code", "space=code", "loose"], ["folder"]);
    expect(chips).toEqual([
      { key: "folder=a=b", dim: "folder", value: "a=b" },
      { key: "space=code", dim: "space", value: "code" },
      { key: "loose", dim: null, value: "loose" },
    ]);
  });

  it("sanitizeHidden keeps bounded strings only", () => {
    expect(sanitizeHidden(["a=b", "a=b", 4, "", null, "x".repeat(401), "c=d"])).toEqual(["a=b", "c=d"]);
    expect(sanitizeHidden("nope")).toEqual([]);
    expect(sanitizeHidden(Array.from({ length: HIDDEN_CAP + 50 }, (_, i) => `k=${i}`))).toHaveLength(HIDDEN_CAP);
  });

  it("sameHidden ignores order", () => {
    expect(sameHidden(["a=1", "b=2"], ["b=2", "a=1"])).toBe(true);
    expect(sameHidden(["a=1"], ["a=1", "b=2"])).toBe(false);
  });
});

describe("the hidden set is the stage's set", () => {
  it("a right-click on a chart label shows up as a chip, and the checklist hides the same band the stage does", () => {
    const store = createLeafStore();
    expect(labelContext(store, ["month", "2019-05"])).toBe("hide");
    expect(store.get("ui").hiddenGroups).toEqual(["month=2019-05"]);
    expect(hiddenChips(store.get("ui").hiddenGroups, ["month", "folder"])).toEqual([{ key: "month=2019-05", dim: "month", value: "2019-05" }]);
    // The checklist's untick of the same value leaves the same list the right-click would, and a second untick-then-tick round trips.
    setHiddenGroups(store, toggleValue(store.get("ui").hiddenGroups, "month", "2019-01"));
    expect(store.get("ui").hiddenGroups).toEqual(["month=2019-05", "month=2019-01"]);
    setHiddenGroups(store, toggleValue(store.get("ui").hiddenGroups, "month", "2019-05"));
    expect(store.get("ui").hiddenGroups).toEqual(["month=2019-01"]);
  });

  it("setHiddenGroups replaces the set and an equal set is not a change (the slice object stays)", () => {
    const store = createLeafStore();
    setHiddenGroups(store, ["a=1", "b=2"]);
    const ui = store.get("ui");
    setHiddenGroups(store, ["b=2", "a=1"]);
    expect(store.get("ui")).toBe(ui);
    setHiddenGroups(store, []);
    expect(store.get("ui").hiddenGroups).toEqual([]);
  });

  it("an undo puts back exactly what was there (the closure the section pushes)", () => {
    const store = createLeafStore();
    setHiddenGroups(store, ["space=code"]);
    const before = store.get("ui").hiddenGroups;
    setHiddenGroups(store, showAllOf(before));
    expect(store.get("ui").hiddenGroups).toEqual([]);
    setHiddenGroups(store, before);
    expect(store.get("ui").hiddenGroups).toEqual(["space=code"]);
  });
});

describe("saved with Saved charts", () => {
  const settings = migrateSettingsChecked(undefined).settings;

  it("a leaf with nothing hidden saves no 'hidden' key (older saves read the same)", () => {
    expect("hidden" in captureLeafState(createLeafStore())).toBe(false);
  });

  it("the hidden set is captured and restored, copied rather than shared", () => {
    const a = createLeafStore();
    setHiddenGroups(a, ["month=2019-05", "folder=Inbox"]);
    const saved = captureLeafState(a);
    expect(saved.hidden).toEqual(["month=2019-05", "folder=Inbox"]);
    expect(saved.hidden).not.toBe(a.get("ui").hiddenGroups);
    const b = createLeafStore();
    restoreLeafState(b, JSON.parse(JSON.stringify(saved)), settings);
    expect(b.get("ui").hiddenGroups).toEqual(["month=2019-05", "folder=Inbox"]);
  });

  it("applying a chart saved with nothing hidden shows everything again; junk in the file is dropped", () => {
    const b = createLeafStore();
    setHiddenGroups(b, ["space=code"]);
    restoreLeafState(b, { ...captureLeafState(createLeafStore()) }, settings);
    expect(b.get("ui").hiddenGroups).toEqual([]);
    restoreLeafState(b, { ...captureLeafState(createLeafStore()), hidden: ["ok=1", 7, { a: 1 }] }, settings);
    expect(b.get("ui").hiddenGroups).toEqual(["ok=1"]);
  });
});

describe("Start from presets", () => {
  it("offers Month by Folder, Speaker by Time, Project by Kind and Day by Area", () => {
    expect(START_PRESET_IDS).toEqual(["monthFolder", "speakerTime", "projectKind", "dayArea"]);
    expect(START_PRESETS.map((p) => t(presetCopy(p)))).toEqual(["Month by Folder", "Speaker by Time", "Project by Kind", "Day by Area"]);
  });

  it("each preset names a real chart, real dimensions, and a vertical axis only where the form has one", () => {
    for (const p of START_PRESETS) {
      expect(CHART_IDS).toContain(p.chart);
      expect(builtinDim(p.x)).toBeTruthy();
      if (p.y) expect(builtinDim(p.y)).toBeTruthy();
      expect(p.y !== null).toBe(axisRolesFor(p.chart).y !== null);
      if (p.colour) expect(builtinDim(p.colour)).toBeTruthy();
    }
  });

  it("sets the form and both axes in one write; dates keep their order, other axes run by count", () => {
    const base = spec({ chart: "ranked-bars", x: { dim: "space", sort: "name" }, y: null, size: "words", filter: [{ dim: "kind", value: "note" }], hideNoValue: true, top: 10, options: { counts: false } });
    const month = START_PRESETS.find((p) => p.id === "monthFolder");
    expect(month).toBeTruthy();
    const next = applyPreset(base, month!);
    expect(next.chart).toBe("matrix");
    expect(next.x).toEqual({ dim: "month", sort: "date" });
    expect(next.y).toEqual({ dim: "folder", sort: "count" });
    // what the person set elsewhere carries over; options of the old form do not
    expect(next.size).toBe("words");
    expect(next.filter).toEqual(base.filter);
    expect(next.hideNoValue).toBe(true);
    expect(next.top).toBe(10);
    expect(next.options).toEqual({});
  });

  it("Day by Area is a one-axis calendar coloured by area; the others have no colour of their own", () => {
    const day = applyPreset(spec({ colour: "kind" }), START_PRESETS.find((p) => p.id === "dayArea")!);
    expect(day).toMatchObject({ chart: "calendar-heatmap", x: { dim: "day" }, y: null, colour: "space" });
    const speaker = applyPreset(spec({ colour: "kind" }), START_PRESETS.find((p) => p.id === "speakerTime")!);
    expect(speaker).toMatchObject({ chart: "stream", x: { dim: "week" }, y: { dim: "speaker" }, colour: "kind" });
  });

  it("a preset is marked as on once the chart has its form and axes, and not before; it does not mutate the chart", () => {
    const before = spec({ chart: "ranked-bars", x: { dim: "space", sort: "count" }, y: null });
    const snapshot = JSON.stringify(before);
    for (const p of START_PRESETS) {
      expect(presetMatches(before, p)).toBe(false);
      expect(presetMatches(applyPreset(before, p), p)).toBe(true);
    }
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("every preset can be applied twice with the same result", () => {
    for (const p of START_PRESETS) {
      const once = applyPreset(spec(), p);
      expect(applyPreset(once, p)).toEqual(once);
    }
  });

  it("describes what a click sets", () => {
    expect(presetSummary(START_PRESETS[0]!)).toContain("Matrix");
    expect(presetSummary(START_PRESETS[3]!)).toContain("Area");
  });
});

const h = fakeServices();
const wrap = (node: preact.ComponentChild) =>
  render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>{node}</LeafContext.Provider>
    </ServicesContext.Provider>,
  );

const noop = () => undefined;
function view(over: Partial<Parameters<typeof ShowHideView>[0]> = {}) {
  return (
    <ShowHideView
      axes={[
        { zone: "x", dim: "month" },
        { zone: "y", dim: "folder" },
      ]}
      active="x"
      onTab={noop}
      rows={checklistRows(MONTHS, ["month=2019-04"], "month")}
      chips={[{ chip: { key: "month=2019-04", dim: "month", value: "2019-04" }, name: "Apr 2019" }]}
      onToggle={noop}
      onOnly={noop}
      onChip={noop}
      onShowAll={noop}
      isOnly={() => false}
      {...over}
    />
  );
}

describe("Show or hide as drawn", () => {
  it("has a tab per axis, a row per value with its count and an Only link, the hidden chips and Show all", () => {
    const html = render(view());
    expect(html).toContain(t("chart.showHide"));
    expect(html).toContain(">Month<");
    expect(html).toContain(">Folder<");
    expect(html).toContain("Jan 2019");
    expect(html).toContain(">46<");
    expect((html.match(new RegExp(`>${t("chart.showHideOnly")}<`, "g")) ?? []).length).toBe(MONTHS.length);
    expect(html).toContain(t("chart.hiddenLabel"));
    expect(html).toContain(t("chart.hiddenChip", { name: "Apr 2019" }));
    expect(html).toContain(t("chart.showAll"));
    // the hidden value's box is unticked, the shown ones are ticked
    expect((html.match(/ checked(?=[ >])/g) ?? []).length).toBe(MONTHS.length - 1);
  });

  it("a one-axis chart shows no tabs; nothing hidden says so and disables Show all", () => {
    const html = render(view({ axes: [{ zone: "x", dim: "month" }], chips: [] }));
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toContain(t("chart.hiddenNone"));
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*Show all/);
  });

  it("says when it is reading, when there is nothing to list, and when reading failed", () => {
    expect(render(view({ rows: null }))).toContain(t("chart.showHideLoading"));
    expect(render(view({ rows: [] }))).toContain(t("chart.showHideEmpty"));
    expect(render(view({ rows: null, failed: true }))).toContain(t("chart.showHideFailed"));
  });

  it("the Only link of the one shown value reads as pressed", () => {
    const html = render(view({ isOnly: (r) => r.key === "2019-05" }));
    expect(html).toContain("aria-pressed");
    expect(html).toContain(t("chart.showHideAgain", { name: "May 2019", dim: "Month" }));
  });

  it("tabs follow the chart: two for a two-axis form, one for a one-axis form", () => {
    expect(showHideAxes(spec()).map((a) => a.dim)).toEqual(["month", "folder"]);
    expect(showHideAxes(spec({ chart: "calendar-heatmap", x: { dim: "day", sort: "date" }, y: null })).map((a) => a.dim)).toEqual(["day"]);
    expect(showHideAxes(spec({ chart: "ranked-bars", y: { dim: "folder", sort: "count" } })).map((a) => a.dim)).toEqual(["month"]);
  });
});

describe("Start from as drawn", () => {
  it("shows the four chips and marks the one the chart already is", () => {
    const html = wrap(<StartFromRow spec={spec()} setSpec={noop} />);
    expect(html).toContain(t("chart.startFrom"));
    for (const p of START_PRESETS) expect(html).toContain(t(presetCopy(p)));
    expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(1);
  });
});

describe("the Chart page", () => {
  it("keeps Show or hide, Start from and Fields as collapsed sections, with an empty index", () => {
    const hh = fakeServices();
    setView(hh.leaf.store, "chart", spec());
    const html = render(
      <ServicesContext.Provider value={hh.services}>
        <LeafContext.Provider value={hh.leaf}>
          <ChartPage params={{}} />
        </LeafContext.Provider>
      </ServicesContext.Provider>,
    );
    const a = html.indexOf(`>${t("chart.showHide")}<`);
    const b = html.indexOf(`>${t("chart.startAndFields")}<`);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    // Closed: the checklist and the chips are not read or drawn.
    expect(html).not.toContain(`>${t("chart.fields")}<`);
    expect(html).not.toContain("cx-chart-showhide-list");
    expect(html).toContain('aria-expanded="false"');
  });
});
