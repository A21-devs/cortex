/**
 * Display popover (P08): compact by default, "All controls" remembered per device, the spine order only on the body,
 * the grouping rows (split toggle, one or two selects), the conversation-threads slider and its Lines shortcut,
 * hover previews that clear, the record select's two sections, the reflow fade, and the list button under Display.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it, vi } from "vitest";
import { STARTER_PACKS } from "../src/shared/packs";
import type { PackDef } from "../src/shared/types";
import { setDimPreview, setLayer, setShape, setLook, setSplitGroups, setGroupByRecord, setSpineOrder } from "../src/state/actions";
import { STEM_ON_STRENGTH } from "../src/state/types";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { emptyDeviceState, parseDeviceState, setDisplayExpanded, displayExpanded } from "../src/ui/deviceState";
import { groupingShown, DisplayPopover, previewMenu, recordDimChoices, recordDimItems, spineOrderShown } from "../src/ui/stage/DisplayPopover";
import { fadePhase } from "../src/ui/stage/Reflow";
import { ToolColumn, toggleStems } from "../src/ui/stage/ToolColumn";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

const phase = vi.hoisted(() => ({ value: "P2" as "P0" | "P1" | "P2" }));
vi.mock("../src/shared/features", async (orig) => {
  const m = await orig<typeof import("../src/shared/features")>();
  return { ...m, featureOn: (id: Parameters<typeof m.featureOn>[0], p = phase.value) => m.featureOn(id, p) };
});

function renderIn(h: FakeHarness, node: preact.ComponentChild): string {
  return render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>{node}</LeafContext.Provider>
    </ServicesContext.Provider>,
  );
}

const expand = (h: FakeHarness) => h.services.device.update((d) => setDisplayExpanded(d, true));

describe("compact and expanded", () => {
  it("opens compact: Scatter, Names, Lines, Keep upright and the disclosure only", () => {
    const h = fakeServices();
    const html = renderIn(h, <DisplayPopover />);
    for (const s of ["Scatter", "Names", "Lines", "Keep upright", "All controls"]) expect(html).toContain(s);
    for (const s of ["Dot size", "Glow", "Brightness", "Speed", "Pause while pointing", "Conversation threads", "Tooltip"]) expect(html).not.toContain(s);
    expect(html).toContain('aria-expanded="false"');
  });

  it("keeps the expanded choice on the device and shows every section", () => {
    const h = fakeServices();
    expect(displayExpanded(h.services.device.value)).toBe(false);
    expand(h);
    expect(displayExpanded(h.services.device.value)).toBe(true);
    const html = renderIn(h, <DisplayPopover />);
    for (const s of ["Dot size", "Glow", "Brightness", "Speed", "Pause while pointing", "Conversation threads", "Fewer controls"]) expect(html).toContain(s);
    // Parsed back from storage, and a malformed value starts compact.
    expect(displayExpanded(parseDeviceState(JSON.parse(JSON.stringify(h.services.device.value))))).toBe(true);
    expect(displayExpanded(parseDeviceState({ displayExpanded: "yes" }))).toBe(false);
    expect(setDisplayExpanded(emptyDeviceState(), false)).toEqual(emptyDeviceState());
    h.services.device.update((d) => setDisplayExpanded(d, false));
    expect(renderIn(h, <DisplayPopover />)).toContain("All controls");
  });
});

describe("spine order", () => {
  it("is offered only while the figure is the body", () => {
    const h = fakeServices();
    expand(h);
    expect(spineOrderShown({ morph: 0 })).toBe(true);
    expect(spineOrderShown({ morph: 0.4 })).toBe(false);
    expect(renderIn(h, <DisplayPopover />)).toContain("Oldest by the brain");
    setSpineOrder(h.leaf.store, "newest-at-brain");
    expect(renderIn(h, <DisplayPopover />)).toContain("Newest by the brain");
    setShape(h.leaf.store, "groups");
    h.leaf.store.update("view", { morph: 0.6 });
    expect(renderIn(h, <DisplayPopover />)).not.toContain("Spine runs");
  });
});

describe("grouping rows", () => {
  it("shows them only in Groups; one Group by select, or Notes by and Record by once the record is split", () => {
    const h = fakeServices();
    expand(h);
    const store = h.leaf.store;
    expect(groupingShown({ shape: "body" })).toBe(false);
    expect(renderIn(h, <DisplayPopover />)).not.toContain("Group names");
    setShape(store, "groups");
    setLayer(store, "record", false);
    let html = renderIn(h, <DisplayPopover />);
    expect(html).toContain("Group names");
    expect(html).toContain("Group by");
    expect(html).not.toContain("Separate record");
    setLayer(store, "record", true);
    html = renderIn(h, <DisplayPopover />);
    expect(html).toContain("Separate record");
    expect(html).toContain("Group by");
    expect(html).not.toContain("Record by");
    setSplitGroups(store, true);
    html = renderIn(h, <DisplayPopover />);
    expect(html).toContain("Notes by");
    expect(html).toContain("Record by");
    expect(html).toContain("Same as notes");
    setGroupByRecord(store, "speaker");
    expect(renderIn(h, <DisplayPopover />)).toContain("Speaker");
    setSplitGroups(store, false);
    expect(store.get("view").groupByRecord).toBeNull();
    html = renderIn(h, <DisplayPopover />);
    expect(html).not.toContain("Record by");
    expect(html).toContain("Group by");
  });

  it("offers the record two sections: fields shared with the notes, and record-only fields", () => {
    const c = recordDimChoices([]);
    expect(c.shared.map((d) => d.id)).toContain("month");
    expect(c.shared.map((d) => d.id)).toContain("space");
    expect(c.recordOnly.map((d) => d.id)).toEqual(expect.arrayContaining(["conversation", "speaker"]));
    expect(c.shared.map((d) => d.id)).not.toContain("speaker");
    expect(c.recordOnly.map((d) => d.id)).not.toContain("map");
    expect(c.shared.map((d) => d.id)).not.toContain("hubStatus");
    const items = recordDimItems([], "speaker");
    expect(items.find((i) => i.value === "speaker")).toMatchObject({ checked: true, group: "record", groupLabel: "Record only" });
    expect(items.find((i) => i.value === "month")).toMatchObject({ group: "shared", groupLabel: "Shared with notes" });
  });

  it("sorts a pack's fields by what the pack applies to", () => {
    const base = STARTER_PACKS[0] as PackDef;
    const field = base.fields[0]!;
    const only = (id: string, appliesTo: PackDef["appliesTo"]): PackDef => ({ ...base, id, appliesTo, fields: [field], writer: "model" });
    const dim = (id: string) => `label:${id}/${field.key}`;
    const c = recordDimChoices([only("p-both", ["note", "entry"]), only("p-rec", ["entry", "conversation"]), only("p-note", ["note"])]);
    expect(c.shared.map((d) => d.id)).toContain(dim("p-both"));
    expect(c.recordOnly.map((d) => d.id)).toContain(dim("p-rec"));
    const all = [...c.shared, ...c.recordOnly].map((d) => d.id);
    expect(all).not.toContain(dim("p-note"));
  });
});

describe("hover preview", () => {
  it("sets the preview dimension while a row is hovered and clears it when the menu closes", () => {
    const h = fakeServices();
    const store = h.leaf.store;
    const m = previewMenu(store);
    m.onHover("speaker");
    expect(store.get("ui").dimPreview).toBe("speaker");
    m.onHover(null);
    expect(store.get("ui").dimPreview).toBeNull();
    m.onHover("month");
    m.onHover("dim:date");
    expect(store.get("ui").dimPreview).toBeNull();
    setDimPreview(store, "kind");
    m.onHide();
    expect(store.get("ui").dimPreview).toBeNull();
  });
});

describe("conversation threads", () => {
  it("is a 0-100% slider in the expanded panel bound to the strength", () => {
    const h = fakeServices();
    expand(h);
    setLook(h.leaf.store, { stemStrength: 0.35 });
    const html = renderIn(h, <DisplayPopover />);
    expect(html).toContain("Conversation threads");
    expect(html).toContain("35%");
    expect(html).toContain('aria-valuenow="35"');
  });

  it("the Lines menu shortcut toggles between off and the last non-zero strength", () => {
    const h = fakeServices();
    const store = h.leaf.store;
    toggleStems(store);
    expect(store.get("view").look.stemStrength).toBe(STEM_ON_STRENGTH);
    setLook(store, { stemStrength: 0.6 });
    toggleStems(store);
    expect(store.get("view").look.stemStrength).toBe(0);
    toggleStems(store);
    expect(store.get("view").look.stemStrength).toBe(0.6);
  });
});

describe("reflow fade", () => {
  it("fades a row out for a moment before it unmounts, and not at all under reduced motion", () => {
    expect(fadePhase(true, false, false)).toBe("in");
    expect(fadePhase(false, true, false)).toBe("out");
    expect(fadePhase(false, false, false)).toBeNull();
    expect(fadePhase(false, true, true)).toBeNull();
  });
});

describe("list button", () => {
  it("sits under Display at every size and follows the Key popover", () => {
    const h = fakeServices();
    let html = renderIn(h, <ToolColumn />);
    expect(html).toContain("Key as a list");
    expect(html.indexOf("Display")).toBeLessThan(html.indexOf("Key as a list"));
    expect(html.indexOf("Key as a list")).toBeLessThan(html.indexOf("Names"));
    h.leaf.store.update("ui", { popover: "key" });
    html = renderIn(h, <ToolColumn />);
    expect(html).toMatch(/aria-label="Key as a list"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="Key as a list"/);
  });
});
