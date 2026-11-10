/**
 * Foundation for the dimension and state packages: the Map type, Note or record and Kind dimensions, the
 * stem-strength migration, spine order, split groups, highlight helpers and the transient flags.
 */
import { describe, expect, it } from "vitest";
import { builtinDim } from "../src/shared/dims";
import { HUB_TYPE_ORDER, NONE32, NONE8, Population } from "../src/shared/index-format";
import type { QueryToken } from "../src/shared/protocol/worker";
import {
  addToken,
  clearHighlights,
  removeHighlight,
  removeToken,
  setDimPreview,
  setGroupByRecord,
  setLook,
  setSpineOrder,
  setSplitGroups,
  setSyncKeyToGroups,
} from "../src/state/actions";
import { captureLeafState, restoreLeafState, sanitizeView } from "../src/state/persist";
import { highlightCount, highlightTokens, stemsOn } from "../src/state/selectors";
import { createLeafStore } from "../src/state/store";
import { defaultUi, defaultView, STEM_ON_STRENGTH } from "../src/state/types";
import { COPY } from "../src/ui/copy";
import { dimLabel, hubTypeLabel, kindLabel, noteOrRecordLabel } from "../src/ui/valueLabels";
import { buildCategories, NO_CODE, readDim } from "../src/worker/charts/common";
import { buildSampleIndex } from "../src/worker/sampleIndex";

const NOW = Date.UTC(2026, 10, 10);
const index = buildSampleIndex(20261110, NOW);
const all = Array.from({ length: index.count }, (_, i) => i);
const settings = { general: { pose: "standing", showReference: false }, appearance: { dotSize: 1, glow: 1, brightness: 1, namesOnFigure: "hover", lines: "selection", stems: false } } as never;
const settingsStemsOn = { general: { pose: "standing", showReference: false }, appearance: { dotSize: 1, glow: 1, brightness: 1, namesOnFigure: "hover", lines: "selection", stems: true } } as never;

describe("hub type dimension", () => {
  it("is a provenance-group dimension for notes with a label", () => {
    expect(builtinDim("hubType")).toMatchObject({ group: "agents", appliesTo: "notes", none: "noMap" });
    expect(dimLabel("hubType")).toBe(COPY.dims.hubType);
  });

  it("reads the map type of a map and none for a plain note", () => {
    const dv = readDim(index, "hubType", all);
    let maps = 0;
    let plain = 0;
    for (const o of all) {
      const code = dv.codes[o]!;
      if (index.cols.pop[o] === Population.Record) {
        expect(code).toBe(NO_CODE);
        continue;
      }
      const h = index.cols.hubType[o]!;
      if (h !== NONE8) {
        maps++;
        expect(dv.keys[code]).toBe(HUB_TYPE_ORDER[h]);
      } else {
        plain++;
        expect(dv.keys[code]).toBe("none");
        expect(dv.labels[code]).toBe(COPY.dims.notAMap);
      }
    }
    expect(maps).toBeGreaterThan(0);
    expect(plain).toBeGreaterThan(0);
  });

  it("has value labels", () => {
    expect(hubTypeLabel("project")).toBe(COPY.reader.projectMap);
    expect(hubTypeLabel("none")).toBe(COPY.dims.notAMap);
  });
});

describe("note or record dimension", () => {
  it("splits everything into two categories that sum to the total", () => {
    expect(builtinDim("layer2")).toMatchObject({ group: "file", appliesTo: "both" });
    expect(dimLabel("layer2")).toBe(COPY.dims.layer2);
    const dv = readDim(index, "layer2", all);
    expect([...dv.keys].sort()).toEqual(["note", "record"]);
    const set = buildCategories(index, all, dv, { sort: "count", top: "all", size: "entries", foldable: false, keepNone: true });
    const values = set.list.filter((c) => c.kind === "value");
    expect(values).toHaveLength(2);
    expect(values.reduce((s, c) => s + c.count, 0)).toBe(index.count);
    const notes = all.filter((o) => index.cols.pop[o] === Population.Note).length;
    expect(values.find((c) => c.key === "note")!.count).toBe(notes);
    expect(noteOrRecordLabel("note")).toBe(COPY.dims.noteWord);
    expect(noteOrRecordLabel("record")).toBe(COPY.dims.recordWord);
  });
});

describe("kind values", () => {
  it("includes maps and conversation heads", () => {
    const dv = readDim(index, "kind", all);
    expect(dv.keys).toContain("hub");
    expect(dv.keys).toContain("conversation");
    expect(kindLabel("hub")).toBe(COPY.kinds.map);
    expect(kindLabel("conversation")).toBe(COPY.kinds.conversation);
    for (const o of all) {
      const key = dv.codes[o] === NO_CODE ? undefined : dv.keys[dv.codes[o]!];
      if (key === "conversation") {
        expect(index.cols.pop[o]).toBe(Population.Record);
        expect(index.cols.idx[o]).toBe(0);
        expect(index.cols.conv[o]).not.toBe(NONE32);
      }
      if (index.cols.pop[o] === Population.Record && index.cols.idx[o] !== 0) expect(dv.codes[o]).toBe(NO_CODE);
    }
  });
});

describe("stem strength", () => {
  it("defaults from the settings flag and exposes stemsOn", () => {
    expect(defaultView(settings).look.stemStrength).toBe(0);
    const on = defaultView(settingsStemsOn);
    expect(on.look.stemStrength).toBe(STEM_ON_STRENGTH);
    expect(stemsOn(on)).toBe(true);
    expect(stemsOn(defaultView())).toBe(false);
  });

  it("migrates a saved boolean and round-trips a number", () => {
    const base = defaultView();
    expect(sanitizeView({ look: { stems: true } }, base).look.stemStrength).toBe(STEM_ON_STRENGTH);
    expect(sanitizeView({ look: { stems: false } }, base).look.stemStrength).toBe(0);
    expect(sanitizeView({ look: { stemStrength: 0.4, stems: true } }, base).look.stemStrength).toBe(0.4);
    expect(sanitizeView({ look: { stemStrength: 9 } }, base).look.stemStrength).toBe(1);
    expect(sanitizeView({ look: {} }, base).look.stemStrength).toBe(0);
    const a = createLeafStore({ view: defaultView() });
    setLook(a, { stemStrength: 0.25, groupLabels: false });
    const saved = JSON.parse(JSON.stringify(captureLeafState(a)));
    const b = createLeafStore();
    restoreLeafState(b, saved, settings);
    expect(b.get("view").look).toMatchObject({ stemStrength: 0.25, groupLabels: false });
  });
});

describe("view fields and actions", () => {
  it("has quiet defaults", () => {
    const v = defaultView();
    expect(v).toMatchObject({ spineOrder: "oldest-at-brain", groupByRecord: null, splitGroups: false, syncKeyToGroups: false });
    expect(v.look.groupLabels).toBe(true);
    expect(defaultUi().dimPreview).toBeNull();
  });

  it("sets spine order, split groups and the record dimension", () => {
    const s = createLeafStore({ view: defaultView() });
    setSpineOrder(s, "newest-at-brain");
    setSplitGroups(s, true);
    setGroupByRecord(s, "source");
    setSyncKeyToGroups(s, true);
    expect(s.get("view")).toMatchObject({ spineOrder: "newest-at-brain", splitGroups: true, groupByRecord: "source", syncKeyToGroups: true });
    const saved = JSON.parse(JSON.stringify(captureLeafState(s)));
    const r = createLeafStore();
    restoreLeafState(r, saved, settings);
    expect(r.get("view")).toMatchObject({ spineOrder: "newest-at-brain", splitGroups: true, groupByRecord: "source", syncKeyToGroups: true });
    setSplitGroups(s, false);
    expect(s.get("view").groupByRecord).toBeNull();
    expect(s.get("view").splitGroups).toBe(false);
  });

  it("drops a saved record dimension when groups are not split, and bad values", () => {
    const base = defaultView();
    expect(sanitizeView({ splitGroups: false, groupByRecord: "source" }, base).groupByRecord).toBeNull();
    expect(sanitizeView({ splitGroups: true, groupByRecord: "nope" }, base).groupByRecord).toBeNull();
    expect(sanitizeView({ spineOrder: "sideways" }, base).spineOrder).toBe("oldest-at-brain");
  });

  it("keeps the dimension preview out of the saved state", () => {
    const s = createLeafStore({ view: defaultView() });
    setDimPreview(s, "kind");
    expect(s.get("ui").dimPreview).toBe("kind");
    expect(JSON.stringify(captureLeafState(s))).not.toContain("dimPreview");
    const r = createLeafStore();
    restoreLeafState(r, JSON.parse(JSON.stringify(captureLeafState(s))), settings);
    expect(r.get("ui").dimPreview).toBeNull();
    setDimPreview(s, null);
    expect(s.get("ui").dimPreview).toBeNull();
  });
});

describe("highlight helpers", () => {
  const hl = (id: string): QueryToken => ({ id: `chart:group:space:${id}`, kind: "group", dim: "space", value: id, label: id });
  const text: QueryToken = { id: "t1", kind: "text", label: "slots", text: "slots" };
  const set: QueryToken = { id: "set:read:x", kind: "set", label: "x", ids: ["a"] };

  it("counts only chart highlight tokens", () => {
    const s = createLeafStore({ view: defaultView() });
    for (const t of [hl("a"), text, hl("b"), set]) addToken(s, t);
    expect(highlightTokens(s.get("ui")).map((t) => t.value)).toEqual(["a", "b"]);
    expect(highlightCount(s.get("ui"))).toBe(2);
  });

  it("removes one highlight or all and leaves other tokens", () => {
    const s = createLeafStore({ view: defaultView() });
    for (const t of [hl("a"), text, hl("b"), set]) addToken(s, t);
    removeHighlight(s, "t1");
    expect(s.get("ui").tokens).toHaveLength(4);
    removeHighlight(s, hl("a").id);
    expect(s.get("ui").tokens.map((t) => t.id)).toEqual(["t1", hl("b").id, "set:read:x"]);
    clearHighlights(s);
    expect(s.get("ui").tokens.map((t) => t.id)).toEqual(["t1", "set:read:x"]);
    removeToken(s, "t1");
    clearHighlights(s);
    expect(s.get("ui").tokens.map((t) => t.id)).toEqual(["set:read:x"]);
  });
});

describe("chart legend names for the new dimensions", () => {
  it("uses Cortex's own value labels, not the worker's text", async () => {
    const { categoryName } = await import("../src/ui/stage/ChartOverlay");
    expect(categoryName("hubType", "project", "x")).toBe(COPY.reader.projectMap);
    expect(categoryName("hubType", "none", "x")).toBe(COPY.dims.notAMap);
    expect(categoryName("layer2", "record", "x")).toBe(COPY.dims.recordWord);
    expect(categoryName("layer2", "note", "x")).toBe(COPY.dims.noteWord);
  });
});
