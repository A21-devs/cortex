/**
 * grouping-hints: the Filing and Recency dimensions (menus, readDim, colour, chart axes), the key rows' "notes · entries"
 * pair, and the richness hint under label groupings.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_DIMS,
  FILING_VALUES,
  isLabelBased,
  RECENCY_ACTIVE_DAYS,
  RECENCY_COOLING_DAYS,
  RECENCY_VALUES,
  RESUME_DIM,
  recencyOfDays,
  RICHNESS_TARGET,
  builtinDim,
  noneNameOf,
  recordDims,
  type DimId,
} from "../src/shared/dims";
import { SPACE_ORDER, type DataIndex } from "../src/shared/index-format";
import type { LegendRow } from "../src/shared/protocol/worker";
import { sanitizeView } from "../src/state/persist";
import { defaultView } from "../src/state/types";
import { COPY } from "../src/ui/copy";
import { LeafContext, ServicesContext, ShellContext, shellFor } from "../src/ui/context";
import { emptyDeviceState } from "../src/ui/deviceState";
import { dimMenuModel, flatDimItems } from "../src/ui/primitives/dimMenu";
import { mapRecency } from "../src/ui/pages/Read";
import { categoryName } from "../src/ui/stage/ChartOverlay";
import { richnessHint, RichnessHint } from "../src/ui/stage/Hints";
import { keyRowCount } from "../src/ui/stage/KeyList";
import { fieldFor } from "../src/ui/stage/Tooltip";
import { dimLabel } from "../src/ui/valueLabels";
import { computeGroupsArrangement, thinnestValue } from "../src/worker/arrangements";
import { buildCategories, defaultVisibility, newestWritten, NO_CODE, readDim, writtenAt } from "../src/worker/charts/common";
import { computeGrouping } from "../src/worker/grouping";
import { buildSampleIndex } from "../src/worker/sampleIndex";
import { signal } from "@preact/signals";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

const NOW = Date.UTC(2026, 10, 10);
const index = buildSampleIndex(20261110, NOW);
const all = Array.from({ length: index.count }, (_, i) => i);
const vis = defaultVisibility(index.count);

/** The sample index with a label field: 150 items carry "alpha", 6 carry "beta", the rest nothing. */
function labelled(): { idx: DataIndex; items: number[] } {
  const col = { pack: "resume", packVersion: "1.0.0", field: "item", type: "text" as const, values: ["alpha", "beta"], single: new Uint16Array(index.count).fill(0xffff), byUser: new Uint8Array(index.count) };
  for (let i = 0; i < 150; i++) col.single[i] = 0;
  for (let i = 150; i < 156; i++) col.single[i] = 1;
  return { idx: { ...index, labels: [...index.labels, col] } as unknown as DataIndex, items: Array.from({ length: 156 }, (_, i) => i) };
}

describe("Filing dimension", () => {
  it("is a From the file dimension with a label and shows in Group by, Colour and chart axis lists", () => {
    expect(builtinDim("filing")).toMatchObject({ group: "file", appliesTo: "both" });
    expect(dimLabel("filing")).toBe(COPY.dims.filing);
    expect(COPY.dims.filing).toBe("Filing");
    const model = dimMenuModel([]);
    expect(model.sections.find((s) => s.group === "file")!.items.map((i) => i.id)).toEqual(expect.arrayContaining(["filing", "recency"]));
    expect(flatDimItems(model).map((i) => i.value)).toEqual(expect.arrayContaining(["filing", "recency"]));
    expect(recordDims().shared).toEqual(expect.arrayContaining(["filing", "recency"]));
    expect(noneNameOf("filing")).toBe("noValue");
    expect(noneNameOf("recency")).toBe("undated");
  });

  it("files an item once it sits in an area, and reads every item", () => {
    const dv = readDim(index, "filing", all);
    expect(FILING_VALUES).toEqual(["filed", "unfiled"]);
    let filed = 0;
    let unfiled = 0;
    for (const o of all) {
      const code = dv.codes[o]!;
      expect(code).not.toBe(NO_CODE);
      const area = SPACE_ORDER[index.cols.space[o]!];
      const key = dv.keys[code];
      if (area === undefined || area === "none") {
        expect(key).toBe("unfiled");
        unfiled++;
      } else {
        expect(key).toBe("filed");
        filed++;
      }
    }
    expect(filed).toBeGreaterThan(0);
    expect(filed + unfiled).toBe(index.count);
    expect(dv.labels).toEqual(expect.arrayContaining(unfiled > 0 ? ["Filed into an area", "Not yet filed"] : ["Filed into an area"]));
  });

  it("words its values from copy in chart labels and tooltips", () => {
    expect(categoryName("filing", "filed", "x")).toBe("Filed into an area");
    expect(categoryName("filing", "unfiled", "x")).toBe("Not yet filed");
    expect(COPY.dims.filed).toBe("Filed into an area");
    expect(COPY.dims.unfiled).toBe("Not yet filed");
    const meta = { space: "none", kind: 0, title: "t", writtenAt: "", folder: "" } as never;
    expect(fieldFor("filing", meta)).toBe("Not yet filed");
    expect(fieldFor("filing", { ...(meta as object), space: "code" } as never)).toBe("Filed into an area");
  });

  it("colours by it: two keyed groups in the key", () => {
    const g = computeGrouping(index, {
      notes: { kind: "categorical", dim: "filing" },
      record: { kind: "categorical", dim: "filing" },
      fold: true,
      hideNoValue: false,
      hiddenGroups: [],
      merges: {},
      palette: "prism",
      light: false,
      slots: {},
      visibility: vis,
    });
    const rows = g.legend.sections.flatMap((s) => s.rows).filter((r) => r.bucket === "value");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.key).every((k) => (FILING_VALUES as readonly string[]).includes(k))).toBe(true);
  });

  it("groups and charts by it", () => {
    const res = computeGroupsArrangement(index, { kind: "groups", dim: "filing", layout: "bubbles", fold: false, merges: {}, hideNoValue: false, visibility: vis }, new Float32Array(index.count * 3));
    expect(res.overlay.marks.length).toBeGreaterThan(0);
    expect(res.overlay.marks.length).toBeLessThanOrEqual(2);
    const dv = readDim(index, "filing", all);
    const cats = buildCategories(index, all, dv, { sort: "count", top: "all", size: "entries", foldable: false, keepNone: true });
    expect(cats.list.filter((c) => c.kind === "value").map((c) => c.key).sort()).toEqual([...new Set(all.map((o) => dv.keys[dv.codes[o]!]!))].sort());
  });

  it("survives a saved view", () => {
    const v = sanitizeView({ groupBy: "filing" }, defaultView());
    expect(v.groupBy).toBe("filing");
    expect(sanitizeView({ groupBy: "recency" }, defaultView()).groupBy).toBe("recency");
  });
});

describe("Recency dimension", () => {
  it("uses Read's thresholds", () => {
    expect(RECENCY_ACTIVE_DAYS).toBe(30);
    expect(RECENCY_COOLING_DAYS).toBe(120);
    expect(RECENCY_VALUES).toEqual(["active", "cooling", "dormant"]);
    for (const [days, want] of [
      [0, "active"],
      [30, "active"],
      [30.5, "cooling"],
      [120, "cooling"],
      [121, "dormant"],
    ] as const) {
      expect(recencyOfDays(days)).toBe(want);
      expect(mapRecency(0, days * 86_400_000)).toBe(want);
    }
    expect(dimLabel("recency")).toBe("Recency");
  });

  it("reads each dated item by its age before your newest entry", () => {
    const newest = newestWritten(index);
    expect(Number.isFinite(newest)).toBe(true);
    const dv = readDim(index, "recency", all);
    const seen = new Set<string>();
    for (const o of all) {
      const at = writtenAt(index, o);
      const code = dv.codes[o]!;
      if (!Number.isFinite(at)) {
        expect(code).toBe(NO_CODE);
        continue;
      }
      const key = dv.keys[code]!;
      expect(key).toBe(recencyOfDays((newest - at) / 86_400_000));
      seen.add(key);
    }
    expect(seen.size).toBeGreaterThan(0);
    expect(dv.order[dv.keys.indexOf("active")]).toBeLessThan(dv.order[dv.keys.indexOf("dormant")] ?? 99);
    expect(categoryName("recency", "cooling", "x")).toBe("Cooling");
  });

  it("groups by it into at most three groups plus the undated", () => {
    const res = computeGroupsArrangement(index, { kind: "groups", dim: "recency", layout: "bubbles", fold: false, merges: {}, hideNoValue: false, visibility: vis }, new Float32Array(index.count * 3));
    expect(res.overlay.marks.length).toBeGreaterThan(0);
    expect(res.overlay.marks.length).toBeLessThanOrEqual(4);
  });
});

describe("key rows: notes · entries", () => {
  const row = (notes: number, record: number): LegendRow => ({ key: "k", name: "K", slot: 1, bucket: "value", rgb: [1, 1, 1], notes, record, hidden: false, depth: 0, expandable: false });
  it("shows the pair while both layers are on, compact above 9,999", () => {
    expect(keyRowCount(row(1880, 9994), "both")).toBe("1,880 · 9,994");
    expect(keyRowCount(row(28400, 12), "both", { notes: true, record: true })).toBe("28.4k · 12");
    expect(keyRowCount(row(5, 20000), "both", { notes: true, record: true })).toBe("5 · 20.0k");
  });
  it("shows one count when a layer is hidden, or when the section holds one layer", () => {
    expect(keyRowCount(row(1880, 9994), "both", { notes: false, record: true })).toBe("9,994");
    expect(keyRowCount(row(1880, 9994), "both", { notes: true, record: false })).toBe("1,880");
    expect(keyRowCount(row(1880, 9994), "notes")).toBe("1,880");
    expect(keyRowCount(row(1880, 9994), "record")).toBe("9,994");
  });
});

describe("richness hint", () => {
  const view = { shape: "groups", morph: 1, groupBy: "label:resume/item" as DimId, recordDim: null, thinnest: 12 };

  it("knows a label grouping from a date, folder or area one", () => {
    expect(RICHNESS_TARGET).toBe(100);
    expect(isLabelBased("label:session/work")).toBe(true);
    expect(isLabelBased(RESUME_DIM)).toBe(true);
    expect(isLabelBased("yourLabels")).toBe(true);
    for (const d of ["month", "space", "folder", "source", "kind", "filing", "recency"] as DimId[]) expect(isLabelBased(d)).toBe(false);
    expect(BUILTIN_DIMS.length).toBeGreaterThan(0);
  });

  it("names the thinnest value under a label grouping", () => {
    expect(richnessHint(view)).toBe(12);
    expect(richnessHint({ ...view, groupBy: "yourFixes" })).toBe(12);
  });

  it("stays away for other groupings, other shapes (a chart card, the body) and full groups", () => {
    expect(richnessHint({ ...view, groupBy: "month" })).toBeNull();
    expect(richnessHint({ ...view, groupBy: "space" })).toBeNull();
    expect(richnessHint({ ...view, shape: "body" })).toBeNull();
    expect(richnessHint({ ...view, morph: 0 })).toBeNull();
    expect(richnessHint({ ...view, thinnest: RICHNESS_TARGET })).toBeNull();
    expect(richnessHint({ ...view, thinnest: 480 })).toBeNull();
    expect(richnessHint({ ...view, thinnest: null })).toBeNull();
    expect(richnessHint({ ...view, thinnest: undefined })).toBeNull();
    expect(richnessHint({ ...view, thinnest: RICHNESS_TARGET - 1 })).toBe(99);
  });

  it("follows the record entries' own label dimension", () => {
    expect(richnessHint({ ...view, groupBy: "space", recordDim: "label:session/work" })).toBe(12);
  });

  it("counts a value's items before Fold and reports it on the arrangement", () => {
    const { idx, items } = labelled();
    expect(thinnestValue(idx, RESUME_DIM, items)).toBe(6);
    expect(thinnestValue(idx, RESUME_DIM, [])).toBeNull();
    expect(thinnestValue(idx, RESUME_DIM, [200, 201])).toBeNull();
    const res = computeGroupsArrangement(idx, { kind: "groups", dim: RESUME_DIM, layout: "bubbles", fold: true, merges: {}, hideNoValue: true, visibility: defaultVisibility(idx.count) }, new Float32Array(idx.count * 3));
    // Fold sent the six "beta" items to Other, yet the hint still sees them.
    expect(res.overlay.thinnest).toBe(6);
    // A date grouping reports nothing.
    const byMonth = computeGroupsArrangement(idx, { kind: "groups", dim: "month", layout: "bubbles", fold: true, merges: {}, hideNoValue: false, visibility: defaultVisibility(idx.count) }, new Float32Array(idx.count * 3));
    expect(byMonth.overlay.thinnest).toBeUndefined();
  });

  it("honours merges when counting", () => {
    const { idx, items } = labelled();
    expect(thinnestValue(idx, RESUME_DIM, items, { [RESUME_DIM]: { beta: "alpha" } })).toBe(156);
  });

  function inHarness(h: FakeHarness, thinnest: number | null): string {
    h.leaf.store.update("view", { shape: "groups", morph: 1, groupBy: "label:resume/item" });
    return render(
      <ServicesContext.Provider value={h.services}>
        <LeafContext.Provider value={h.leaf}>
          <ShellContext.Provider value={shellFor(h.leaf)}>
            <RichnessHint thinnest={signal(thinnest)} />
          </ShellContext.Provider>
        </LeafContext.Provider>
      </ServicesContext.Provider>,
    );
  }

  it("says it in Cortex's words with Add sources and the sample record", () => {
    const html = inHarness(fakeServices(), 12);
    expect(html).toContain("cx-richness");
    expect(html).toContain("About 100 labelled entries a value reads well · the smallest has 12");
    // Two lines, no dismiss control.
    expect(html.match(/<p /g)).toHaveLength(2);
    expect(html).not.toContain("cx-icon-button");
    expect(html).toContain(">Add sources<");
    expect(html).toContain(">See the sample record<");
    expect(inHarness(fakeServices(), 140)).toBe("");
    expect(inHarness(fakeServices(), null)).toBe("");
  });
});
