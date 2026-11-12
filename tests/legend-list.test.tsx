/**
 * The desktop legend list (pkg-04): the heading total, the paired counts and their caption, the chosen-row pill with the
 * Area's subfolders, Record-by toggling, the help lines and the standing button, the struck no-value row under Hide
 * unsorted, and the counts recounted inside an area's lens.
 */
import { render } from "preact-render-to-string";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DataIndex } from "../src/shared/index-format";
import type { GroupingParams, LegendModel, LegendRow, LegendSection, VisibilityParams } from "../src/shared/protocol/worker";
import { LeafContext, ServicesContext, ShellContext, shellFor } from "../src/ui/context";
import { closeSheet, openPage } from "../src/state/actions";
import { forceHost } from "../src/ui/host";
import { lensCounts } from "../src/ui/stage/KeyBar";
import { clickBehaviour, childCount, keyTotalLabel, listFooter, KeyList, rowLook } from "../src/ui/stage/KeyList";
import { computeGrouping } from "../src/worker/grouping";
import { buildSampleIndex } from "../src/worker/sampleIndex";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

afterEach(() => forceHost(null));

const NOW = Date.UTC(2026, 10, 9);
let index: DataIndex;
beforeAll(() => {
  index = buildSampleIndex(7, NOW);
}, 60_000);

const grouping = (over: Partial<GroupingParams> = {}): GroupingParams => ({
  notes: { kind: "categorical", dim: "space" },
  record: { kind: "age" },
  fold: true,
  hideNoValue: false,
  hiddenGroups: [],
  merges: {},
  palette: "prism",
  light: false,
  slots: {},
  visibility: {} as VisibilityParams,
  ...over,
});

const row = (key: string, notes: number, record: number, over: Partial<LegendRow> = {}): LegendRow => ({ key, name: key, slot: 1, bucket: "value", rgb: [1, 2, 3], notes, record, hidden: false, depth: 0, expandable: false, ...over });

function mount(h: FakeHarness): string {
  forceHost("desktop");
  return render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>
        <ShellContext.Provider value={shellFor(h.leaf)}>
          <KeyList />
        </ShellContext.Provider>
      </LeafContext.Provider>
    </ServicesContext.Provider>,
  );
}

const section = (over: Partial<LegendSection> = {}): LegendSection => ({ population: "both", dim: "space", rows: [row("a", 10, 4), row("b", 3, 1)], total: 18, ...over });

describe("row looks", () => {
  it("fades the rows a choice hides instead of striking them", () => {
    const hid = row("b", 1, 1, { hidden: true });
    expect(rowLook(hid, "select", "a")).toEqual({ struck: false, dim: true });
    expect(rowLook(hid, "select", null)).toEqual({ struck: true, dim: false });
    expect(rowLook(row("a", 1, 1), "select", "a")).toEqual({ struck: false, dim: false });
  });

  it("fades and strikes a toggled-off Record-by group", () => {
    expect(rowLook(row("x", 0, 5, { hidden: true }), "toggle", null)).toEqual({ struck: true, dim: true });
    expect(rowLook(row("x", 0, 5), "toggle", null)).toEqual({ struck: false, dim: false });
  });

  it("strikes the no-value row while Hide unsorted is on, even when a row is chosen", () => {
    expect(rowLook(row("", 5, 0, { bucket: "none", dropped: true }), "select", null).struck).toBe(true);
    expect(rowLook(row("", 5, 0, { bucket: "none", dropped: true }), "select", "a").struck).toBe(true);
  });

  it("dims every row but the one the lens holds", () => {
    expect(rowLook(row("a", 1, 1), "select", null, "a").dim).toBe(false);
    expect(rowLook(row("b", 1, 1), "select", null, "a").dim).toBe(true);
  });

  it("chooses in notes sections and toggles in Record-by sections", () => {
    expect(clickBehaviour({ population: "notes", dim: "space" })).toBe("select");
    expect(clickBehaviour({ population: "both", dim: "folder" })).toBe("select");
    expect(clickBehaviour({ population: "record", dim: "source" })).toBe("toggle");
    expect(clickBehaviour({ population: "record", dim: "age" })).toBe("select");
  });
});

describe("totals, footer and lens counts", () => {
  it("shows the key's total, or the matching count while lit, or the lens's own", () => {
    expect(keyTotalLabel({ grandTotal: 15889 }, null)).toBe("15.9k");
    expect(keyTotalLabel({ grandTotal: 900 }, null)).toBe("900");
    expect(keyTotalLabel({ grandTotal: 900, lit: 7 }, null)).toBe("7 matching");
    expect(keyTotalLabel({ grandTotal: 900 }, { sections: [], grandTotal: 42 })).toBe("42");
  });

  it("says what is left out, or the full count", () => {
    expect(listFooter(141, 8)).toBe("133 more");
    expect(listFooter(8, 8)).toBe("All 8 groups");
    expect(listFooter(3, 8)).toBe("All 3 groups");
  });

  it("counts a subfolder like its group", () => {
    expect(childCount({ key: "k", name: "k", notes: 21, record: 2 }, "both", { notes: true, record: true })).toBe("21 · 2");
    expect(childCount({ key: "k", name: "k", notes: 21, record: 2 }, "notes", { notes: true, record: true })).toBe("21");
  });

  it("recounts rows from the lens legend, zero where the area has none", () => {
    const lens: LegendModel = { grandTotal: 5, sections: [{ population: "both", dim: "space", rows: [row("a", 4, 1)], total: 5 }] };
    const sec = section();
    expect(lensCounts(lens, sec, sec.rows[0] as LegendRow)).toEqual({ notes: 4, record: 1 });
    expect(lensCounts(lens, sec, sec.rows[1] as LegendRow)).toEqual({ notes: 0, record: 0 });
    expect(lensCounts(null, sec, sec.rows[1] as LegendRow)).toEqual(sec.rows[1]);
    // A key coloured another way than the lens's has no match: the rows keep their own counts.
    expect(lensCounts(lens, section({ dim: "folder" }), sec.rows[1] as LegendRow)).toEqual(sec.rows[1]);
  });
});

describe("worker legend", () => {
  it("marks the no-value row dropped only while Hide unsorted is on", () => {
    let found = false;
    for (const dim of ["folder", "source", "project", "kind", "space"] as const) {
      const off = computeGrouping(index, grouping({ notes: { kind: "categorical", dim } }));
      const none = off.legend.sections.flatMap((s) => s.rows).find((r) => r.bucket === "none");
      if (!none) continue;
      found = true;
      expect(none.dropped).toBeUndefined();
      const on = computeGrouping(index, grouping({ notes: { kind: "categorical", dim }, hideNoValue: true }));
      const row2 = on.legend.sections.flatMap((s) => s.rows).find((r) => r.bucket === "none");
      expect(row2?.dropped).toBe(true);
      expect(row2?.notes).toBe(none.notes);
      expect(on.legend.sections.flatMap((s) => s.rows).filter((r) => r.bucket !== "none").every((r) => r.dropped === undefined)).toBe(true);
    }
    expect(found).toBe(true);
  });

  it("recounts over a lit set, the lens's second grouping", () => {
    const full = computeGrouping(index, grouping());
    const lit = new Uint8Array(index.count);
    for (let i = 0; i < Math.min(index.count, 40); i++) lit[i] = 1;
    const lens = computeGrouping(index, grouping({ lit }));
    expect(lens.legend.grandTotal).toBeLessThanOrEqual(40);
    expect(lens.legend.grandTotal).toBeLessThan(full.legend.grandTotal);
    expect(lens.legend.lit).toBe(lens.legend.grandTotal);
  });
});

describe("legend list markup", () => {
  it("prints the total at the heading, a column caption, the help lines and the standing button", () => {
    const h = fakeServices();
    h.leaf.store.update("legend", () => ({ sections: [section()], grandTotal: 18 }));
    const html = mount(h);
    expect(html).toContain('data-testid="key-total"');
    expect(html).toContain(">18<");
    expect(html).toContain("notes · record");
    expect(html).toContain("10 · 4");
    expect(html).toContain("All 2 groups");
    expect(html).toContain("cx-keylist-help");
    expect(html).toContain("<strong>The spine is time</strong>");
    expect(html).toMatch(/cx-keylist-showall is-idle[^>]*aria-disabled="true"/);
    expect(html).toContain("Show every group");
  });

  it("steps away while the Chart card is open over its corner, and comes back when it closes", () => {
    const h = fakeServices();
    h.leaf.store.update("legend", () => ({ sections: [section()], grandTotal: 18 }));
    openPage(h.leaf.store, "chart");
    h.leaf.store.update("ui", (u) => ({ ...u, breakpoint: "XL", sheet: { ...u.sheet, float: true } }));
    expect(mount(h)).not.toContain("Show every group");
    closeSheet(h.leaf.store);
    expect(mount(h)).toContain("Show every group");
  });

  it("follows the spine order setting and the usage tips switch", () => {
    const h = fakeServices();
    h.leaf.store.update("legend", () => ({ sections: [section()], grandTotal: 18 }));
    h.leaf.store.update("view", (v) => ({ ...v, spineOrder: "newest-at-brain" }));
    expect(mount(h)).toContain("newest by the brain");
    h.leaf.store.update("view", (v) => ({ ...v, spineOrder: "oldest-at-brain" }));
    expect(mount(h)).toContain("oldest by the brain");
    h.services.device.update((d) => ({ ...d, keyTipsHidden: true }));
    expect(mount(h)).not.toContain("cx-keylist-help");
  });

  it("says N matching at the heading while lit, and drops the caption when one layer is off", () => {
    const h = fakeServices();
    h.leaf.store.update("legend", () => ({ sections: [section()], grandTotal: 18, lit: 18 }));
    expect(mount(h)).toContain("18 matching");
    h.leaf.store.update("view", (v) => ({ ...v, layers: { ...v.layers, record: false } }));
    const html = mount(h);
    expect(html).not.toContain("notes · record");
    expect(html).not.toContain("10 · 4");
  });

  it("draws the chosen row as a pill with its subfolders, the others faded and not struck", () => {
    const h = fakeServices();
    const sec = section({
      population: "notes",
      rows: [row("a", 10, 0), row("b", 3, 0, { hidden: true })],
      children: { a: [{ key: "a", name: "", notes: 4, record: 0, direct: true }, { key: "a/x", name: "x", notes: 6, record: 0 }] },
    });
    h.leaf.store.update("legend", () => ({ sections: [sec], grandTotal: 13 }));
    h.leaf.store.update("ui", { hiddenGroups: ["space=b"] });
    const html = mount(h);
    expect(html).toMatch(/cx-keylist-row is-selected"/);
    expect(html).toMatch(/cx-keylist-row is-dim"/);
    expect(html).not.toContain("is-hidden");
    expect(html).toContain("cx-keylist-sub");
    expect(html).toContain(">x<");
  });

  it("leaves a Record-by section to toggle: a hidden group is struck and faded, never a pill", () => {
    const h = fakeServices();
    const sec = section({ population: "record", dim: "source", rows: [row("a", 0, 10), row("b", 0, 3, { hidden: true })] });
    h.leaf.store.update("legend", () => ({ sections: [sec], grandTotal: 13 }));
    h.leaf.store.update("ui", { hiddenGroups: ["source=b"] });
    h.leaf.store.update("view", (v) => ({ ...v, colour: { ...v.colour, record: { kind: "categorical", dim: "source" } } }));
    const html = mount(h);
    expect(html).not.toContain("is-selected");
    expect(html).toContain("is-hidden is-dim");
    expect(html).toContain("Click to show or hide this group");
  });

  it("strikes the no-value row under Hide unsorted and keeps its count", () => {
    const h = fakeServices();
    const sec = section({ population: "notes", rows: [row("a", 10, 0), row("", 7, 0, { bucket: "none", dropped: true })] });
    h.leaf.store.update("legend", () => ({ sections: [sec], grandTotal: 17 }));
    const html = mount(h);
    expect(html).toContain("is-hidden");
    expect(html).toContain(">7<");
  });

  it("recounts the rows while the area lens holds an area", () => {
    const h = fakeServices();
    const sec = section({ population: "notes", rows: [row("a", 10, 0), row("b", 3, 0)] });
    h.leaf.store.update("legend", () => ({ sections: [sec], grandTotal: 13 }));
    h.leaf.store.update("lens", () => ({ area: "a", legend: { grandTotal: 2, sections: [{ population: "notes", dim: "space", rows: [row("b", 2, 0)], total: 2 }] } }));
    // The lens counts apply only while the area is the held preview.
    expect(mount(h)).toContain(">10<");
    h.leaf.store.update("ui", { preview: { kind: "area", key: "a", strong: true } });
    const html = mount(h);
    expect(html).not.toContain(">10<");
    expect(html).toContain(">2<");
  });
});
