/**
 * Colour, legend and speed (package 2): colouring the Brain by date, any colour for a single-colour row, the month
 * tree (years over months, one hidden state), the grand total, the four extra data palettes (colour-blind
 * separation, contrast, no white) and the 0–200% motion speed.
 */
import { render } from "preact-render-to-string";
import { beforeAll, describe, expect, it } from "vitest";
import { TurntableCamera } from "../src/render/camera";
import { ItemFlag, Population, type DataIndex } from "../src/shared/index-format";
import { bucketColor, contrastRatio, deltaE, hexToRgb, hueCount, MONTH_RAMP, MONTH_RAMP_NAMES, NO_VALUE, normaliseHex, PALETTES, paletteById, rampAt, rgbToHex, srgbToOklab, oklabToSrgb } from "../src/shared/palette";
import type { GroupingParams, LegendModel, LegendRow, LegendSection, VisibilityParams } from "../src/shared/protocol/worker";
import type { PaletteId } from "../src/shared/settings";
import { setGroupBy, showAllGroups, soloGroup, toggleGroup } from "../src/state/actions";
import { consumeInstantRestore, resetInstantRestore } from "../src/state/instantRestore";
import { sanitizeView } from "../src/state/persist";
import { MOTION_SPEED_RANGE, defaultView } from "../src/state/types";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { SETTINGS_COPY } from "../src/ui/copy";
import { applyKeyOption, ageEndLabel, anyHidden, isolatedRow, KeyBar, KeyChip, keyOptionItems, monthLabel, rowDimension, selectedRow } from "../src/ui/stage/KeyBar";
import { childRowsFor, helpLines, KeyPopover, latestYearKey, openRows, sectionChoices, singleHex, soloScope, visibleTreeRows } from "../src/ui/stage/KeyPopover";
import { emptyDeviceState, keyTipsShown, parseDeviceState, setDisplayExpanded, setKeyTipsShown } from "../src/ui/deviceState";
import { clampSpeed } from "../src/ui/stage/DisplayPopover";
import { computeGrouping, HIDDEN_ALPHA, isMonthDim, monthNumber, monthRampFn, monthTreeRows, singleRgb, unionSpineTime, yearOfMonthKey } from "../src/worker/grouping";
import { computeSpineTime } from "../src/worker/placement";
import { buildSampleIndex } from "../src/worker/sampleIndex";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

const NOW = Date.UTC(2026, 10, 9);
const VIS: VisibilityParams = {} as VisibilityParams;
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
  visibility: VIS,
  ...over,
});

function renderIn(h: FakeHarness, node: preact.ComponentChild): string {
  return render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>{node}</LeafContext.Provider>
    </ServicesContext.Provider>,
  );
}

const byte = (c: Uint8Array, o: number): [number, number, number, number] => [c[o * 4] as number, c[o * 4 + 1] as number, c[o * 4 + 2] as number, c[o * 4 + 3] as number];

describe("colour the Brain by date (F64)", () => {
  it("offers the age ramp for the Brain row as well as the Spine row", () => {
    for (const pop of ["notes", "record", "both"] as const) {
      expect(keyOptionItems({ same: false, fold: true, hideNoValue: false }, pop).some((i) => i.value === "key:age")).toBe(true);
    }
    const checked = keyOptionItems({ same: false, fold: true, hideNoValue: false }, "notes", { kind: "age" }).find((i) => i.value === "key:age");
    expect((checked as { checked?: boolean }).checked).toBe(true);
  });

  it("applies Age to the Brain only, leaving the Spine alone, and to both when the colours are shared", () => {
    const h = fakeServices();
    const store = h.leaf.store;
    applyKeyOption(store, "notes", "key:age");
    expect(store.get("view").colour.notes).toEqual({ kind: "age" });
    store.update("view", (v) => ({ ...v, colour: { ...v.colour, record: { kind: "single", slot: 2 } } }));
    expect(store.get("view").colour.record).toEqual({ kind: "single", slot: 2 });
    store.update("view", (v) => ({ ...v, colour: { ...v.colour, same: true } }));
    applyKeyOption(store, "notes", "key:age");
    expect(store.get("view").colour.record).toEqual({ kind: "age" });
  });

  it("builds a Brain gradient legend and colours notes by their date, oldest to newest", () => {
    const g = computeGrouping(index, grouping({ notes: { kind: "age" }, record: { kind: "single", slot: 2 } }));
    const sec = g.legend.sections.find((s) => s.population === "notes") as LegendSection;
    expect(sec.dim).toBe("age");
    expect(sec.gradient?.stops).toHaveLength(8);
    expect(Number.isFinite(sec.gradient?.from)).toBe(true);
    // Two dated notes at the extremes of the record get different colours, never the No-value slate.
    let first = -1;
    let last = -1;
    for (let i = 0; i < index.count; i++) {
      if (index.cols.pop[i] !== Population.Note || !Number.isFinite(index.cols.t[i] as number)) continue;
      if (first < 0 || (index.cols.t[i] as number) < (index.cols.t[first] as number)) first = i;
      if (last < 0 || (index.cols.t[i] as number) > (index.cols.t[last] as number)) last = i;
    }
    expect(first).toBeGreaterThanOrEqual(0);
    expect(byte(g.color, first).slice(0, 3)).not.toEqual(byte(g.color, last).slice(0, 3));
    const slate = NO_VALUE.glow;
    expect(rgbToHex([byte(g.color, first)[0] / 255, byte(g.color, first)[1] / 255, byte(g.color, first)[2] / 255])).not.toBe(slate);
  });

  it("labels the gradient with the first month and, for the Brain, the last month (the Spine keeps today)", () => {
    const g = computeGrouping(index, grouping({ notes: { kind: "age" }, record: { kind: "single", slot: 2 } }));
    const grad = (g.legend.sections.find((s) => s.population === "notes") as LegendSection).gradient;
    expect(ageEndLabel("notes", grad)).toBe(monthLabel(grad?.to as number));
    expect(ageEndLabel("notes", grad)).not.toBe("today");
    expect(ageEndLabel("record", grad)).toBe("today");
    expect(ageEndLabel("both", undefined)).toBe("today");
  });

  it("colours the Brain by its own dates when no record entry has a date", () => {
    const flags = Uint32Array.from(index.cols.flags as ArrayLike<number>);
    for (let i = 0; i < index.count; i++) if (index.cols.pop[i] === Population.Record) flags[i] = (flags[i] as number) | ItemFlag.Excluded;
    const vaultOnly = { ...index, cols: { ...index.cols, flags } } as DataIndex;
    const g = computeGrouping(vaultOnly, grouping({ notes: { kind: "age" }, record: { kind: "single", slot: 2 } }));
    const sec = g.legend.sections.find((x) => x.population === "notes") as LegendSection;
    expect(Number.isFinite(sec.gradient?.from)).toBe(true);
    expect(Number.isFinite(sec.gradient?.to)).toBe(true);
    expect((sec.gradient?.from as number) < (sec.gradient?.to as number)).toBe(true);
    const colours = new Set<string>();
    for (let i = 0; i < index.count; i++) if (index.cols.pop[i] === Population.Note && Number.isFinite(index.cols.t[i] as number)) colours.add(byte(g.color, i).join(","));
    expect(colours.size).toBeGreaterThan(3);
    expect(sec.gradient?.undated).toBeLessThan(sec.total);
  });

  it("colours by Area (the space dimension) with sticky slots", () => {
    const g = computeGrouping(index, grouping());
    const sec = g.legend.sections.find((s) => s.population === "notes") as LegendSection;
    expect(sec.dim).toBe("space");
    expect(sec.rows.length).toBeGreaterThan(1);
    expect(sec.rows.some((r) => r.slot >= 1)).toBe(true);
  });
});

describe("custom colour for a single-colour row", () => {
  it("normalises typed hex colours", () => {
    expect(normaliseHex("#ABC")).toBe("#aabbcc");
    expect(normaliseHex(" 5aa9ff ")).toBe("#5aa9ff");
    expect(normaliseHex("#12345")).toBeNull();
    expect(normaliseHex("red")).toBeNull();
    expect(normaliseHex("#gggggg")).toBeNull();
  });

  it("colours every item of the population with the hex and shows it as the row's name", () => {
    const g = computeGrouping(index, grouping({ record: { kind: "single", slot: 1, hex: "#336699" } }));
    let checked = 0;
    for (let i = 0; i < index.count && checked < 5; i++) {
      if (index.cols.pop[i] !== Population.Record) continue;
      expect(byte(g.color, i).slice(0, 3)).toEqual([0x33, 0x66, 0x99]);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    const row = (g.legend.sections.find((s) => s.dim === "single") as LegendSection).rows[0] as LegendRow;
    expect(row.name).toBe("#336699");
    expect(rgbToHex(row.rgb)).toBe("#336699");
  });

  it("falls back to the palette slot for a bad hex, and the slot colour has no name", () => {
    expect(rgbToHex(singleRgb({ slot: 2, hex: "nope" }, "prism", "glow"))).toBe(rgbToHex(singleRgb({ slot: 2 }, "prism", "glow")));
    const g = computeGrouping(index, grouping({ record: { kind: "single", slot: 3 } }));
    expect((g.legend.sections.find((s) => s.dim === "single") as LegendSection).rows[0]?.name).toBe("");
  });

  it("restores a saved custom colour and drops a malformed one", () => {
    const base = defaultView();
    const ok = sanitizeView({ colour: { record: { kind: "single", slot: 2, hex: "#ABCDEF" } } }, base);
    expect(ok.colour.record).toEqual({ kind: "single", slot: 2, hex: "#abcdef" });
    const bad = sanitizeView({ colour: { record: { kind: "single", slot: 2, hex: "javascript:1" } } }, base);
    expect(bad.colour.record).toEqual({ kind: "single", slot: 2 });
  });

  it("shows the hex of the current colour in the swatch popover", () => {
    expect(singleHex({ kind: "single", slot: 1, hex: "#336699" }, "prism")).toBe("#336699");
    expect(singleHex({ kind: "single", slot: 1 }, "prism")).toBe(rgbToHex(hexToRgb(paletteById("prism").glow[0] as string)));
    const h = fakeServices();
    h.leaf.store.update("view", (v) => ({ ...v, colour: { ...v.colour, notes: { kind: "single", slot: 1, hex: "#336699" } } }));
    h.leaf.store.update("ui", { popover: "key" });
    const section: LegendSection = { population: "notes", dim: "single", rows: [{ key: "single", name: "#336699", slot: 1, bucket: "value", rgb: [0.2, 0.4, 0.6], notes: 4, record: 0, hidden: false, depth: 0, expandable: false }], total: 4 };
    h.leaf.store.update("legend", () => ({ sections: [section], grandTotal: 4 }));
    const html = renderIn(h, <KeyPopover />);
    expect(html).toContain('value="#336699"');
    expect(html).toContain("Colour as hex");
    expect(html).toContain("Custom colour");
  });
});

describe("the legend as a month tree (V1.2)", () => {
  it("recognises month keys and month dimensions", () => {
    expect(yearOfMonthKey("2024-03")).toBe("2024");
    expect(yearOfMonthKey("2024")).toBeNull();
    expect(yearOfMonthKey("2024-W07")).toBeNull();
    expect(isMonthDim("month")).toBe(true);
    expect(isMonthDim("month:imported")).toBe(true);
    expect(isMonthDim("space")).toBe(false);
    expect(isMonthDim("week")).toBe(false);
  });

  const mk = (key: string, notes: number, record = 0, bucket: LegendRow["bucket"] = "value"): LegendRow => ({ key, name: key, slot: bucket === "value" ? 1 : 0, bucket, rgb: [1, 0, 0], notes, record, hidden: false, depth: 0, expandable: false });

  it("puts months under year rows with summed counts, years ascending, the remainders last", () => {
    const rows = [mk("2025-02", 5, 1), mk("2024-11", 2, 3), mk("2025-01", 4), mk("__other", 9, 0, "other"), mk("", 1, 1, "none")];
    const tree = monthTreeRows(rows, () => false, [0.5, 0.5, 0.5]);
    expect(tree.map((r) => r.key)).toEqual(["2024", "2024-11", "2025", "2025-01", "2025-02", "__other", ""]);
    const y25 = tree.find((r) => r.key === "2025") as LegendRow;
    expect(y25).toMatchObject({ depth: 0, expandable: true, aggregate: true, notes: 9, record: 1, slot: 0 });
    expect(tree.find((r) => r.key === "2025-01")).toMatchObject({ depth: 1, parentKey: "2025" });
    expect(tree.find((r) => r.key === "__other")?.depth).toBe(0);
  });

  it("carries a real tree in the worker legend when colouring by month", () => {
    const g = computeGrouping(index, grouping({ notes: { kind: "categorical", dim: "month" } }));
    const sec = g.legend.sections.find((s) => s.population === "notes") as LegendSection;
    const years = sec.rows.filter((r) => r.aggregate);
    expect(years.length).toBeGreaterThan(0);
    for (const y of years) {
      const months = sec.rows.filter((r) => r.parentKey === y.key);
      expect(months.length).toBeGreaterThan(0);
      expect(months.reduce((n, m) => n + m.notes, 0)).toBe(y.notes);
      expect(months.every((m) => m.depth === 1 && m.key.startsWith(`${y.key}-`))).toBe(true);
    }
    // The grand total is the sum of the sections' totals.
    expect(g.legend.grandTotal).toBe(g.legend.sections.reduce((n, s) => n + s.total, 0));
  });

  it("hides a year's months with one toggle, and hides groups by the key bar's dim=value key", () => {
    const g = computeGrouping(index, grouping({ notes: { kind: "categorical", dim: "month" }, fold: false }));
    const sec = g.legend.sections.find((s) => s.population === "notes") as LegendSection;
    const year = sec.rows.find((r) => r.aggregate) as LegendRow;
    const hid = computeGrouping(index, grouping({ notes: { kind: "categorical", dim: "month" }, fold: false, hiddenGroups: [`month=${year.key}`] }));
    const hsec = hid.legend.sections.find((s) => s.population === "notes") as LegendSection;
    expect(hsec.rows.find((r) => r.key === year.key)?.hidden).toBe(true);
    expect(hsec.rows.filter((r) => r.parentKey === year.key).every((r) => r.hidden)).toBe(true);
    let faded = 0;
    for (let i = 0; i < index.count; i++) if (index.cols.pop[i] === Population.Note && hid.color[i * 4 + 3] === HIDDEN_ALPHA) faded++;
    expect(faded).toBeGreaterThan(0);
    // A plain dimension: "space=<key>" fades its items (the form the key bar stores).
    const first = computeGrouping(index, grouping());
    const key = Object.keys(first.newSlots.space ?? {})[0] as string;
    const one = computeGrouping(index, grouping({ hiddenGroups: [`space=${key}`], slots: { space: first.newSlots.space ?? {} } }));
    expect((one.legend.sections.find((s) => s.population === "notes") as LegendSection).rows.find((r) => r.key === key)?.hidden).toBe(true);
  });

  it("does not count a year's months twice in the section total or the grand total", () => {
    const months = computeGrouping(index, grouping({ notes: { kind: "categorical", dim: "month" } }));
    const space = computeGrouping(index, grouping());
    const m = months.legend.sections.find((x) => x.population === "notes") as LegendSection;
    const a = space.legend.sections.find((x) => x.population === "notes") as LegendSection;
    expect(m.total).toBe(a.total);
    expect(months.legend.grandTotal).toBe(space.legend.grandTotal);
  });

  it("keeps months past the eight hues (fold off) inside their year", () => {
    const g = computeGrouping(index, grouping({ notes: { kind: "categorical", dim: "month" }, fold: false }));
    const sec = g.legend.sections.find((x) => x.population === "notes") as LegendSection;
    const monthRows = sec.rows.filter((r) => yearOfMonthKey(r.key) !== null);
    expect(monthRows.length).toBeGreaterThan(8);
    expect(monthRows.every((r) => r.depth === 1 && r.parentKey === yearOfMonthKey(r.key))).toBe(true);
    expect(monthRows.some((r) => r.bucket === "other")).toBe(true);
  });

  it("solos a month against the other months, never the years", () => {
    const rows = monthTreeRows([mk("2024-11", 2), mk("2024-12", 3), mk("2025-01", 4), mk("", 1, 0, "none")], () => false, [0.5, 0.5, 0.5]);
    const month = rows.find((r) => r.key === "2024-11") as LegendRow;
    const year = rows.find((r) => r.key === "2024") as LegendRow;
    expect(soloScope(rows, month)).toEqual(["2024-11", "2024-12", "2025-01", ""]);
    expect(soloScope(rows, year)).toEqual(["2024", "2025", ""]);
    expect(soloScope([mk("a", 1), mk("b", 2)], mk("a", 1))).toEqual(["a", "b"]);
  });

  it("traces a year row by the year dimension, in the row's own basis", () => {
    const row = { ...mk("2024", 5), aggregate: true };
    expect(rowDimension("month", row)).toBe("year");
    expect(rowDimension("month:imported", row)).toBe("year:imported");
    expect(rowDimension("month", mk("2024-03", 1))).toBe("month");
    expect(rowDimension("space", row)).toBe("space");
  });

  it("shows only the years until one is expanded", () => {
    const rows = monthTreeRows([mk("2024-11", 2), mk("2025-01", 4)], () => false, [0.5, 0.5, 0.5]);
    expect(visibleTreeRows(rows, new Set(), false).map((r) => r.key)).toEqual(["2024", "2025"]);
    expect(visibleTreeRows(rows, new Set(["2025"]), false).map((r) => r.key)).toEqual(["2024", "2025", "2025-01"]);
  });

  it("renders the popover with the latest year open and the earlier ones collapsed", () => {
    const h = fakeServices();
    h.leaf.store.update("ui", { popover: "key" });
    const rows = monthTreeRows([mk("2024-11", 2), mk("2025-01", 4)], () => false, [0.5, 0.5, 0.5]);
    const sec: LegendSection = { population: "notes", dim: "month", rows, total: 6 };
    h.leaf.store.update("legend", () => ({ sections: [sec], grandTotal: 6 }));
    const html = renderIn(h, <KeyPopover />);
    expect(html).toContain("Collapse 2025");
    expect(html).toContain("Expand 2024");
    expect(html).toContain("cx-disclosure");
    expect(html).toContain("6 items");
    expect(html).toContain("2025-01");
    expect(html).not.toContain("2024-11");
  });

  it("opens the most recent year by default and keeps the reader's own choices on top", () => {
    const rows = monthTreeRows([mk("2023-05", 1), mk("2024-11", 2), mk("2025-01", 4)], () => false, [0.5, 0.5, 0.5]);
    expect(latestYearKey(rows)).toBe("2025");
    expect(latestYearKey([mk("a", 1)])).toBeNull();
    expect([...openRows(rows, new Map())]).toEqual(["2025"]);
    expect([...openRows(rows, new Map([["2024", true]]))].sort()).toEqual(["2024", "2025"]);
    // Closing the recent year stays closed.
    expect([...openRows(rows, new Map([["2025", false]]))]).toEqual([]);
    expect(visibleTreeRows(rows, openRows(rows, new Map()), false).map((r) => r.key)).toEqual(["2023", "2024", "2025", "2025-01"]);
    // Choices are kept per section: closing the Brain's recent year leaves the Spine's open.
    const all = new Map([["notes|2025", false]]);
    expect([...openRows(rows, sectionChoices(all, "notes"))]).toEqual([]);
    expect([...openRows(rows, sectionChoices(all, "record"))]).toEqual(["2025"]);
    // A folder tree has no year rows: it stays collapsed.
    expect(openRows([mk("a", 1), { ...mk("a/b", 1), parentKey: "a", depth: 1 }], new Map()).size).toBe(0);
  });
});

describe("the grand total in the legend header (E 3.10)", () => {
  it("shows the total beside the key bar", () => {
    const h = fakeServices();
    h.leaf.store.update("ui", { breakpoint: "XL" });
    const legend: LegendModel = {
      sections: [{ population: "notes", dim: "space", rows: [{ key: "a", name: "Alpha", slot: 1, bucket: "value", rgb: [1, 0, 0], notes: 12345, record: 0, hidden: false, depth: 0, expandable: false }], total: 12345 }],
      grandTotal: 12345,
    };
    h.leaf.store.update("legend", () => legend);
    const html = renderIn(h, <KeyBar />);
    expect(html).toContain("12.3k items");
    expect(html).toContain("12,345 items");
  });
});

// ───────────────────────────── palettes ─────────────────────────────

const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
} as const;
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** ΔE (OKLab × 100) between two colours as seen with protanopia or deuteranopia (Machado et al. 2009, severity 1). */
function cvdDelta(a: string, b: string, kind: "protan" | "deutan"): number {
  const sim = (hex: string): string => {
    const l = hexToRgb(hex).map(lin);
    const m = MACHADO[kind];
    const out = m.map((row) => Math.max(0, Math.min(1, gam(row[0] * (l[0] as number) + row[1] * (l[1] as number) + row[2] * (l[2] as number)))));
    return rgbToHex([out[0] as number, out[1] as number, out[2] as number]);
  };
  return deltaE(sim(a), sim(b));
}

const NEW_PALETTES: readonly PaletteId[] = ["harbor", "orchard", "ember", "reef"];
const COLOUR_BLIND_FIRST: readonly PaletteId[] = ["harbor", "orchard"];

describe("data palettes (F45)", () => {
  it("ships seven selectable palettes, each with a settings name", () => {
    const ids = PALETTES.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["prism", "signal", "print", ...NEW_PALETTES]));
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    const names = SETTINGS_COPY.appearance as unknown as Record<string, string>;
    for (const id of ids) expect(typeof names[id]).toBe("string");
  });

  for (const id of NEW_PALETTES) {
    describe(id, () => {
      const p = paletteById(id);
      it("has eight hues in every variant, valid, distinct and never white", () => {
        expect(hueCount(id)).toBe(8);
        for (const v of ["glow", "fill", "light"] as const) {
          expect(p[v]).toHaveLength(8);
          for (const c of p[v]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
          expect(p[v]).not.toContain("#ffffff");
          expect(new Set(p[v]).size).toBe(8);
          for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) expect(deltaE(p[v][i] as string, p[v][j] as string), `${v} ${i + 1}/${j + 1}`).toBeGreaterThanOrEqual(5);
        }
        expect(p.forcesPaper).toBe(false);
        expect(p.patterns).toBe(false);
      });
      it("reads on its surface: glow on Ink, fill on dark chrome, light on Paper", () => {
        for (const c of p.glow) expect(contrastRatio(c, "#07080b")).toBeGreaterThanOrEqual(5.5);
        for (const c of p.fill) expect(contrastRatio(c, "#1c1c1c")).toBeGreaterThanOrEqual(4.3);
        for (const c of p.light) expect(contrastRatio(c, "#f4f2ee")).toBeGreaterThanOrEqual(3);
      });
      it("keeps neighbouring slots apart for colour-blind readers" + (COLOUR_BLIND_FIRST.includes(id) ? " (colour-blind first)" : ""), () => {
        const floor = COLOUR_BLIND_FIRST.includes(id) ? 7 : 4;
        for (const v of ["glow", "fill", "light"] as const) {
          for (let i = 0; i < 7; i++) {
            for (const kind of ["protan", "deutan"] as const) expect(cvdDelta(p[v][i] as string, p[v][i + 1] as string, kind), `${v} ${i + 1}/${i + 2} ${kind}`).toBeGreaterThanOrEqual(floor);
          }
        }
      });
    });
  }

  it("falls back to Prism for an unknown id", () => {
    expect(paletteById("nope" as PaletteId).id).toBe("prism");
  });
});

// ───────────────────────────── motion speed ─────────────────────────────

describe("motion speed (F5)", () => {
  it("runs 0–200% and persists any value in range, clamping the rest", () => {
    expect(MOTION_SPEED_RANGE).toEqual([0, 2]);
    const base = defaultView();
    expect(sanitizeView({ motion: { speed: 0 } }, base).motion.speed).toBe(0);
    expect(sanitizeView({ motion: { speed: 1.37 } }, base).motion.speed).toBe(1.37);
    expect(sanitizeView({ motion: { speed: 9 } }, base).motion.speed).toBe(2);
    expect(sanitizeView({ motion: { speed: -1 } }, base).motion.speed).toBe(0);
    expect(sanitizeView({ motion: { speed: "fast" } }, base).motion.speed).toBe(base.motion.speed);
    expect(clampSpeed(0.4349)).toBe(0.43);
    expect(clampSpeed(5)).toBe(2);
    expect(clampSpeed(Number.NaN)).toBe(1);
  });

  it("shows a slider, not three buttons, in the Display popover", async () => {
    const { DisplayPopover } = await import("../src/ui/stage/DisplayPopover");
    const h = fakeServices();
    h.leaf.store.update("view", (v) => ({ ...v, motion: { ...v.motion, speed: 0.5 } }));
    // The compact popover keeps Speed behind "All controls".
    h.services.device.update((d) => setDisplayExpanded(d, true));
    const html = renderIn(h, <DisplayPopover />);
    expect(html).toContain("Speed");
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="200"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).not.toContain("×0.5");
  });

  it("holds the figure still at speed 0 and turns it at 100%", () => {
    const still = new TurntableCamera(1, "standing");
    still.setMotion("spin", 0);
    const y0 = still.framing(0).yawDeg;
    for (let i = 0; i < 400; i++) still.update(i * 50, 0.05);
    expect(still.framing(20_000).yawDeg).toBeCloseTo(y0, 6);
    const run = new TurntableCamera(1, "standing");
    run.setMotion("spin", 1);
    for (let i = 0; i < 400; i++) run.update(i * 50, 0.05);
    expect(Math.abs(run.framing(20_000).yawDeg - y0)).toBeGreaterThan(10);
    const fast = new TurntableCamera(1, "standing");
    fast.setMotion("spin", 2);
    for (let i = 0; i < 400; i++) fast.update(i * 50, 0.05);
    expect(Math.abs(fast.framing(20_000).yawDeg - y0)).toBeGreaterThan(Math.abs(run.framing(20_000).yawDeg - y0));
    expect(still.motion().speed).toBe(0);
  });
});

// Keeps the colour helpers used by the palette tests honest.
describe("colour helpers", () => {
  it("round-trips OKLab and parses hex", () => {
    const c = hexToRgb("#5aa9ff");
    const back = oklabToSrgb(srgbToOklab(c));
    expect(rgbToHex(back)).toBe("#5aa9ff");
  });
});

describe("one shared age key and a Brain ramp over every date", () => {
  const DAY = 86_400_000;
  const withNoteTimes = (): { idx: DataIndex; early: number; edge: number; late: number; oldest: number; tMin: number; tMax: number } => {
    const st = computeSpineTime(index);
    const t = Float64Array.from(index.cols.t);
    const notes: number[] = [];
    for (let i = 0; i < index.count && notes.length < 3; i++) if (index.cols.pop[i] === Population.Note) notes.push(i);
    const [early, edge, late] = notes as [number, number, number];
    t[early] = st.tMin - 400 * DAY;
    t[edge] = st.tMax;
    t[late] = st.tMax + 400 * DAY;
    let oldest = -1;
    for (let i = 0; i < index.count; i++) if (Number.isFinite(st.tau[i] as number) && (oldest < 0 || (st.tau[i] as number) < (st.tau[oldest] as number))) oldest = i;
    return { idx: { ...index, cols: { ...index.cols, t } } as DataIndex, early, edge, late, oldest, tMin: st.tMin, tMax: st.tMax };
  };
  const rgbOf = (c: Uint8Array, o: number): string => byte(c, o).slice(0, 3).join(",");

  it("merges Brain and Spine into one age section when both are coloured by age", () => {
    const both = computeGrouping(index, grouping({ notes: { kind: "age" }, record: { kind: "age" } }));
    expect(both.legend.sections.map((s) => [s.population, s.dim])).toEqual([["both", "age"]]);
    const sec = both.legend.sections[0] as LegendSection;
    expect(sec.gradient?.stops).toHaveLength(8);
    // The shared key counts every shown note and entry once.
    expect(sec.total).toBeGreaterThan(0);
    expect(both.legend.grandTotal).toBe(sec.total);
    const apart = computeGrouping(index, grouping({ notes: { kind: "age" }, record: { kind: "single", slot: 2 } }));
    expect(apart.legend.sections.map((s) => s.population)).toEqual(["notes", "record"]);
    const spine = computeGrouping(index, grouping({ notes: { kind: "categorical", dim: "space" }, record: { kind: "age" } }));
    expect(spine.legend.sections.map((s) => s.population)).toEqual(["notes", "record"]);
  });

  it("labels the shared key's end with today only when the ramp ends this month", () => {
    const now = Date.UTC(2026, 10, 9);
    const g = { stops: ["#000", "#fff"], from: Date.UTC(2024, 0, 1), to: now, undated: 0 };
    expect(ageEndLabel("both", g, now)).toBe("today");
    expect(ageEndLabel("both", { ...g, to: Date.UTC(2025, 5, 3) }, now)).toBe(monthLabel(Date.UTC(2025, 5, 3)));
    expect(ageEndLabel("both", undefined, now)).toBe("today");
  });

  it("widens the Brain's ramp to the notes' dates as well as the record's", () => {
    const { idx, early, edge, late, tMin, tMax } = withNoteTimes();
    const g = computeGrouping(idx, grouping({ notes: { kind: "age" }, record: { kind: "single", slot: 2 } }));
    const grad = (g.legend.sections.find((s) => s.population === "notes") as LegendSection).gradient;
    expect(grad?.from).toBe(tMin - 400 * DAY);
    expect(grad?.to).toBe(tMax + 400 * DAY);
    // A note at the record's newest date and one a year later no longer share the end colour.
    expect(rgbOf(g.color, edge)).not.toBe(rgbOf(g.color, late));
    expect(rgbOf(g.color, early)).not.toBe(rgbOf(g.color, edge));
  });

  it("keeps the record's own span when no note lies outside it", () => {
    const st = computeSpineTime(index);
    expect(unionSpineTime(st, { from: st.tMin, to: st.tMax })).toBe(st);
    expect(unionSpineTime(st, null)).toBe(st);
    expect(unionSpineTime(st, { from: st.tMin - 5, to: st.tMax })).toMatchObject({ tMin: st.tMin - 5, tMax: st.tMax });
  });

  it("reads the record against the same ramp as the Brain under the shared age key", () => {
    const { idx, early, oldest } = withNoteTimes();
    const shared = computeGrouping(idx, grouping({ notes: { kind: "age" }, record: { kind: "age" } }));
    const grad = (shared.legend.sections[0] as LegendSection).gradient;
    expect(grad?.from).toBeLessThan(computeSpineTime(idx).tMin);
    // The entry at the record's start is no longer the ramp's oldest colour: the early note is.
    expect(rgbOf(shared.color, oldest)).not.toBe(rgbOf(shared.color, early));
    // A Spine coloured by age on its own keeps the record's own span.
    const own = computeGrouping(idx, grouping({ notes: { kind: "categorical", dim: "space" }, record: { kind: "age" } }));
    expect((own.legend.sections.find((s) => s.population === "record") as LegendSection).gradient?.from).toBe(computeSpineTime(idx).tMin);
  });
});

// ───────────────────────────── the key: select, subfolders, help, show every group ─────────────────────────────

const row = (key: string, notes: number, over: Partial<LegendRow> = {}): LegendRow => ({ key, name: key, slot: 1, bucket: "value", rgb: [0.2, 0.4, 0.8], notes, record: 0, hidden: false, depth: 0, expandable: false, ...over });

describe("select to isolate (LEG-05)", () => {
  it("reads the selected group from the isolation itself", () => {
    const rows = [row("a", 5), row("b", 3, { hidden: true }), row("c", 2, { hidden: true })];
    expect(isolatedRow(rows)?.key).toBe("a");
    expect(selectedRow(rows)?.key).toBe("a");
    // Nothing selected when everything shows, when two show, or when there is only one group.
    expect(selectedRow([row("a", 5), row("b", 3)])).toBeNull();
    expect(selectedRow([row("a", 5), row("b", 3), row("c", 1, { hidden: true })])).toBeNull();
    expect(selectedRow([row("a", 5)])).toBeNull();
  });

  it("selects one month of a month tree, never a year", () => {
    const tree = monthTreeRows([row("2024-01", 2), row("2024-02", 3), row("2025-01", 4)], () => false, [0.5, 0.5, 0.5]);
    const only = tree.map((r) => (r.key === "2024-02" || r.aggregate ? r : { ...r, hidden: true }));
    expect(selectedRow(only)?.key).toBe("2024-02");
  });

  it("a click solos the group and a second click clears it; the eye hides or shows one group", () => {
    const h = fakeServices();
    const all = ["space=a", "space=b", "space=c"];
    soloGroup(h.leaf.store, "space=a", all);
    expect(h.leaf.store.get("ui").hiddenGroups).toEqual(["space=b", "space=c"]);
    soloGroup(h.leaf.store, "space=a", all);
    expect(h.leaf.store.get("ui").hiddenGroups).toEqual([]);
    toggleGroup(h.leaf.store, "space=b");
    expect(h.leaf.store.get("ui").hiddenGroups).toEqual(["space=b"]);
    toggleGroup(h.leaf.store, "space=b");
    expect(h.leaf.store.get("ui").hiddenGroups).toEqual([]);
  });

  it("draws the selected chip as a pill with the siblings dimmed, and an eye on every chip", () => {
    const h = fakeServices();
    h.leaf.store.update("ui", { breakpoint: "XL", hiddenGroups: ["space=b", "space=c"] });
    const rows = [row("a", 5, { name: "Al" }), row("b", 3, { name: "Be", hidden: true }), row("c", 2, { name: "Ga", hidden: true })];
    h.leaf.store.update("legend", () => ({ sections: [{ population: "notes", dim: "space", rows, total: 10 }], grandTotal: 10 }));
    const html = renderIn(h, <KeyBar />);
    expect(html).toContain("has-selected");
    expect(html.match(/cx-key-chipset is-selected/g)?.length).toBe(1);
    // One eye on each chip that fits (the rest collapse into "+n").
    expect(html.match(/cx-key-eye/g)?.length).toBe(html.match(/class="cx-key-chipset/g)?.length);
    expect(html.match(/cx-key-eye/g)?.length).toBeGreaterThan(0);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Hide Al");
    // A hidden chip offers to show it again.
    const hidden = render(<KeyChip row={row("b", 3, { name: "Be", hidden: true })} dim="space" population="notes" onToggle={() => undefined} onSolo={() => undefined} onTrace={() => undefined} onMenu={() => undefined} onPreview={() => undefined} />);
    expect(hidden).toContain("Show Be");
    expect(hidden).toContain("is-hidden");
    expect(hidden).toContain('aria-pressed="false"');
  });
});

describe("show every group (LEG-08)", () => {
  it("clears every hide and the isolation at once, without a fade", () => {
    const h = fakeServices();
    resetInstantRestore();
    h.leaf.store.update("ui", { hiddenGroups: ["space=b", "space=c"] });
    expect(anyHidden(h.leaf.store.get("ui").hiddenGroups)).toBe(true);
    showAllGroups(h.leaf.store);
    expect(h.leaf.store.get("ui").hiddenGroups).toEqual([]);
    expect(consumeInstantRestore()).toBe(true);
    expect(anyHidden([])).toBe(false);
  });

  it("offers a chip at the end of the bar only while something is hidden, and a button in the popover", () => {
    const h = fakeServices();
    h.leaf.store.update("ui", { breakpoint: "XL" });
    const rows = [row("a", 5, { name: "Alpha" }), row("b", 3, { name: "Beta" })];
    h.leaf.store.update("legend", () => ({ sections: [{ population: "notes", dim: "space", rows, total: 8 }], grandTotal: 8 }));
    expect(renderIn(h, <KeyBar />)).not.toContain("cx-key-showall");
    h.leaf.store.update("ui", { hiddenGroups: ["space=b"] });
    expect(renderIn(h, <KeyBar />)).toContain("Show every group");
    h.leaf.store.update("ui", { popover: "key", hiddenGroups: [] });
    expect(renderIn(h, <KeyPopover />)).toMatch(/cx-key-showall is-wide"[^>]*disabled/);
    h.leaf.store.update("ui", { hiddenGroups: ["space=b"] });
    expect(renderIn(h, <KeyPopover />)).not.toMatch(/cx-key-showall is-wide"[^>]*disabled/);
  });
});

describe("subfolders of the selected group (LEG-06)", () => {
  it("lists the subfolders by count, largest first, with the direct members leading, for Area", () => {
    const g = computeGrouping(index, grouping());
    const sec = g.legend.sections[0] as LegendSection;
    expect(sec.children).toBeDefined();
    for (const [parent, kids] of Object.entries(sec.children ?? {})) {
      const r = sec.rows.find((x) => x.key === parent) as LegendRow;
      expect(r).toBeDefined();
      const subs = kids.filter((k) => !k.direct);
      expect(subs.length).toBeGreaterThan(0);
      const counts = subs.map((k) => k.notes + k.record);
      expect(counts).toEqual([...counts].sort((a, b) => b - a));
      if (kids[0]?.direct) expect(kids[0].key).toBe(parent);
      // Everything under a group is inside the group's count.
      expect(kids.reduce((n, k) => n + k.notes + k.record, 0)).toBeLessThanOrEqual(r.notes + r.record);
    }
  });

  it("gives other dimensions no subfolders", () => {
    const g = computeGrouping(index, grouping({ notes: { kind: "categorical", dim: "source" } }));
    expect((g.legend.sections[0] as LegendSection).children).toBeUndefined();
  });

  it("recounts the subfolders over the lit set", () => {
    const g = computeGrouping(index, grouping());
    const sec0 = g.legend.sections[0] as LegendSection;
    const area = sec0.rows[0] as LegendRow;
    const kids = sec0.children?.[area.key] ?? [];
    const first = kids.find((k) => !k.direct) as { key: string };
    const lit = new Uint8Array(index.count);
    for (let i = 0; i < index.count; i++) if (index.dicts.folders.get(index.cols.folder[i] as number) === first.key) lit[i] = 1;
    const narrowed = computeGrouping(index, grouping({ lit }));
    const sec = narrowed.legend.sections[0] as LegendSection;
    expect(sec.rows.map((r) => r.key)).toEqual([area.key]);
    expect(Object.values(sec.children ?? {}).flat().every((k) => k.key === first.key || k.direct)).toBe(true);
  });

  it("expands only the selected group in the popover, under its row, without dots", () => {
    const h = fakeServices();
    const rows = [row("a", 9, { name: "Alpha" }), row("b", 3, { name: "Beta", hidden: true }), row("c", 2, { name: "Gamma", hidden: true })];
    const children = { a: [{ key: "a", name: "", notes: 2, record: 0, direct: true }, { key: "Alpha/One", name: "One", notes: 4, record: 0 }, { key: "Alpha/Two", name: "Two", notes: 3, record: 0 }] };
    const sec: LegendSection = { population: "notes", dim: "space", rows, total: 14, children };
    h.leaf.store.update("legend", () => ({ sections: [sec], grandTotal: 14 }));
    h.leaf.store.update("ui", { popover: "key" });
    const html = renderIn(h, <KeyPopover />);
    expect(html.match(/cx-key-child/g)?.length).toBe(3);
    expect(html.indexOf("Alpha")).toBeLessThan(html.indexOf(">One<"));
    expect(html.indexOf(">One<")).toBeLessThan(html.indexOf("Beta"));
    expect(html).toContain("cx-key-child is-direct");
    // With nothing selected there is nothing to expand.
    const open = { ...sec, rows: rows.map((r) => ({ ...r, hidden: false })) };
    h.leaf.store.update("legend", () => ({ sections: [open], grandTotal: 14 }));
    expect(renderIn(h, <KeyPopover />)).not.toContain("cx-key-child");
    expect(childRowsFor(sec, rows[0] as LegendRow, "a")).toHaveLength(3);
    expect(childRowsFor(sec, rows[0] as LegendRow, "b")).toHaveLength(0);
    expect(childRowsFor(sec, rows[0] as LegendRow, null)).toHaveLength(0);
  });
});

describe("the help footer (LEG-07)", () => {
  it("shows three lines under a divider and follows the spine direction", () => {
    expect(helpLines("oldest-at-brain")).toHaveLength(3);
    expect(helpLines("oldest-at-brain")[2]).toContain("oldest");
    expect(helpLines("newest-at-brain")[2]).toContain("newest");
    const h = fakeServices();
    h.leaf.store.update("ui", { popover: "key" });
    h.leaf.store.update("legend", () => ({ sections: [], grandTotal: 0 }));
    const html = renderIn(h, <KeyPopover />);
    expect(html).toContain("cx-key-help");
    expect(html).toContain(helpLines("oldest-at-brain")[0] as string);
    h.leaf.store.update("view", { spineOrder: "newest-at-brain" });
    expect(renderIn(h, <KeyPopover />)).toContain("newest by the brain");
  });

  it("hides per device and remembers it", () => {
    const h = fakeServices();
    h.leaf.store.update("ui", { popover: "key" });
    h.leaf.store.update("legend", () => ({ sections: [], grandTotal: 0 }));
    h.services.device.update((d) => setKeyTipsShown(d, false));
    expect(keyTipsShown(h.services.device.value)).toBe(false);
    expect(renderIn(h, <KeyPopover />)).not.toContain("cx-key-help");
    const saved = parseDeviceState(JSON.parse(JSON.stringify(h.services.device.value)));
    expect(keyTipsShown(saved)).toBe(false);
    expect(keyTipsShown(emptyDeviceState())).toBe(true);
    expect(keyTipsShown(setKeyTipsShown(saved, true))).toBe(true);
  });
});

describe("the key follows the grouping (LEG-09, LEG-23)", () => {
  it("sets the notes colour dimension when Key follows groups is on", () => {
    const h = fakeServices();
    h.leaf.store.update("view", { syncKeyToGroups: true });
    setGroupBy(h.leaf.store, "source");
    expect(h.leaf.store.get("view").groupBy).toBe("source");
    expect(h.leaf.store.get("view").colour.notes).toEqual({ kind: "categorical", dim: "source" });
  });

  it("always follows while the shape is Groups, and leaves the key alone otherwise", () => {
    const h = fakeServices();
    const before = h.leaf.store.get("view").colour;
    setGroupBy(h.leaf.store, "kind");
    expect(h.leaf.store.get("view").colour).toEqual(before);
    h.leaf.store.update("view", { shape: "groups" });
    setGroupBy(h.leaf.store, "kind");
    expect(h.leaf.store.get("view").colour.notes).toEqual({ kind: "categorical", dim: "kind" });
  });

  it("toggles from the key's options menu and applies at once", () => {
    const h = fakeServices();
    const items = keyOptionItems(defaultView().colour, "notes", undefined, false);
    expect(items.find((i) => i.value === "key:sync")).toMatchObject({ label: "Key follows groups", checked: false });
    expect(keyOptionItems(defaultView().colour, "notes").some((i) => i.value === "key:sync")).toBe(false);
    h.leaf.store.update("view", { groupBy: "project" });
    applyKeyOption(h.leaf.store, "notes", "key:sync");
    expect(h.leaf.store.get("view").syncKeyToGroups).toBe(true);
    expect(h.leaf.store.get("view").colour.notes).toEqual({ kind: "categorical", dim: "project" });
    applyKeyOption(h.leaf.store, "notes", "key:sync");
    expect(h.leaf.store.get("view").syncKeyToGroups).toBe(false);
  });

  it("names the dimension in small caps in the popover heading", () => {
    const h = fakeServices();
    h.leaf.store.update("ui", { popover: "key" });
    h.leaf.store.update("legend", () => ({ sections: [{ population: "notes", dim: "space", rows: [row("a", 1)], total: 1 }], grandTotal: 1 }));
    expect(renderIn(h, <KeyPopover />)).toContain("cx-key-dimname");
  });
});

describe("scope, period and selection narrow the key (LEG-24, LEG-25)", () => {
  it("puts the scoped area's group first and counts only that area", () => {
    const all = computeGrouping(index, grouping());
    const rows = (all.legend.sections[0] as LegendSection).rows;
    const last = rows[rows.length - 1] as LegendRow;
    const scoped = computeGrouping(index, grouping({ visibility: { scope: last.key } as VisibilityParams }));
    expect((scoped.legend.sections[0] as LegendSection).rows.map((r) => r.key)).toEqual([last.key]);
  });

  it("recounts to the period", () => {
    const all = computeGrouping(index, grouping());
    const t = (Array.from(index.cols.t) as number[]).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    const mid = t[Math.floor(t.length / 2)] as number;
    const some = computeGrouping(index, grouping({ visibility: { period: [mid, Number.MAX_SAFE_INTEGER] } as VisibilityParams }));
    expect(some.legend.grandTotal).toBeLessThan(all.legend.grandTotal);
  });

  it("shows one total and only the groups with lit members", () => {
    const base = computeGrouping(index, grouping({ record: { kind: "single", slot: 2 } }));
    expect(base.legend.lit).toBeUndefined();
    const lit = new Uint8Array(index.count);
    let want = 0;
    for (let i = 0; i < index.count; i++) {
      if (index.cols.pop[i] === Population.Note && (index.cols.space[i] as number) % 2 === 0) {
        lit[i] = 1;
        want++;
      }
    }
    expect(want).toBeGreaterThan(0);
    const g = computeGrouping(index, grouping({ lit, record: { kind: "single", slot: 2 } }));
    const notes = g.legend.sections.find((s) => s.population === "notes") as LegendSection;
    expect(notes.rows.length).toBeLessThan((base.legend.sections.find((s) => s.population === "notes") as LegendSection).rows.length);
    expect(notes.rows.every((r) => r.notes > 0)).toBe(true);
    expect(notes.rows.reduce((n, r) => n + r.notes, 0)).toBe(want);
    // The record is not lit, so the key's one total is the lit notes.
    expect(g.legend.lit).toBe(want);
    expect(g.legend.grandTotal).toBe(want);
  });

  it("does not change what the figure draws", () => {
    const lit = new Uint8Array(index.count);
    const a = computeGrouping(index, grouping());
    const b = computeGrouping(index, grouping({ lit }));
    expect(Array.from(b.color)).toEqual(Array.from(a.color));
  });

  it("shows the matching total in the bar and the popover head", () => {
    const h = fakeServices();
    h.leaf.store.update("ui", { breakpoint: "XL", popover: "key" });
    h.leaf.store.update("legend", () => ({ sections: [{ population: "notes", dim: "space", rows: [row("a", 7, { name: "Alpha" })], total: 7 }], grandTotal: 7, lit: 7 }));
    expect(renderIn(h, <KeyBar />)).toContain("7 matching");
    expect(renderIn(h, <KeyPopover />)).toContain("7 matching");
  });
});

describe("the month ramp (LEG-29)", () => {
  it("runs violet to red through orange, with a name for every stop", () => {
    expect(MONTH_RAMP.dark).toHaveLength(8);
    expect(MONTH_RAMP.light).toHaveLength(8);
    expect(MONTH_RAMP_NAMES).toHaveLength(8);
    for (const ramp of [MONTH_RAMP.dark, MONTH_RAMP.light]) for (const hex of ramp) expect(hex).not.toBe("#ffffff");
    const red = hexToRgb(MONTH_RAMP.dark[7]);
    expect(red[0]).toBeGreaterThan(red[1] * 1.5);
    const orange = hexToRgb(MONTH_RAMP.dark[6]);
    expect(orange[0]).toBeGreaterThan(orange[2] * 1.8);
  });

  it("colours a month by its number between the first and the last month", () => {
    expect(monthNumber("2024-03")).toBe(2024 * 12 + 2);
    expect(monthNumber("nope")).toBeNaN();
    const f = monthRampFn(["2023-01", "2023-07", "2024-01", ""], false) as (k: string) => [number, number, number] | null;
    expect(f("2023-01")).toEqual(Array.from(rampAt(MONTH_RAMP.dark, 0)));
    expect(f("2024-01")).toEqual(Array.from(rampAt(MONTH_RAMP.dark, 1)));
    expect(f("2023-07")).toEqual(Array.from(rampAt(MONTH_RAMP.dark, 6 / 12)));
    expect(f("x")).toBeNull();
    expect(monthRampFn(["a", "b"], false)).toBeUndefined();
    expect(monthRampFn(["2023-05"], true)?.("2023-05")).toEqual(Array.from(rampAt(MONTH_RAMP.light, 0.5)));
  });

  it("draws month rows and points in ramp colours, not the categorical set", () => {
    const g = computeGrouping(index, grouping({ notes: { kind: "categorical", dim: "month" }, fold: false }));
    const sec = g.legend.sections[0] as LegendSection;
    const isMonth = (r: LegendRow) => !r.aggregate && /^\d{4}-\d{2}$/.test(r.key);
    const months = sec.rows.filter(isMonth);
    expect(months.length).toBeGreaterThan(8);
    const first = months[0] as LegendRow;
    const last = months[months.length - 1] as LegendRow;
    expect(first.rgb[0]).toBeCloseTo(rampAt(MONTH_RAMP.dark, 0)[0], 5);
    expect(last.rgb[0]).toBeCloseTo(rampAt(MONTH_RAMP.dark, 1)[0], 5);
    expect(new Set(months.map((r) => r.rgb.join(","))).size).toBeGreaterThan(8);
    // The figure's points match their month's row.
    let checked = 0;
    for (let o = 0; o < index.count && checked < 50; o++) {
      const r = sec.rows[g.groupOf[o] as number];
      if (!r || !isMonth(r)) continue;
      expect(g.color[o * 4]).toBe(Math.round(r.rgb[0] * 255));
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("leaves other dimensions on the categorical set", () => {
    const g = computeGrouping(index, grouping());
    const first = (g.legend.sections[0] as LegendSection).rows[0] as LegendRow;
    expect(first.slot).toBeGreaterThan(0);
    expect(first.rgb).toEqual(Array.from(bucketColor("value", first.slot, "prism", "glow")));
  });
});
