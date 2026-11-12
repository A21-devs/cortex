/**
 * Display panel, sectioned form (P03): on Cortex Desktop every section at first, "Fewer options" hiding SHOW, MOTION and the extras; the
 * footer links; the Chart switch's mirror of the sheet; the colour row and swatch strip; the tool button's filled
 * state; and the plugin host keeping its own layout with the same footer.
 */
import { render } from "preact-render-to-string";
import { afterEach, describe, expect, it } from "vitest";
import { openPage, setColourMode, setLayer, closeSheet } from "../src/state/actions";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { displayCompactOn, parseDeviceState, setDisplayCompact, setDisplayExpanded } from "../src/ui/deviceState";
import { forceHost } from "../src/ui/host";
import { defaultView } from "../src/state/types";
import {
  chartSheetOpen,
  chooseNotesBy,
  chooseRecordBy,
  colourChoiceLabel,
  DisplayPopover,
  linesWithAll,
  linesWithLinks,
  pickSingleColour,
  recordByLabel,
  recordDimItems,
  rotationOn,
  SAME_AS_NOTES,
  scatterFromSpread,
  setColourEverywhere,
  setRotation,
  showCounts,
  spreadFromScatter,
  yourColourText,
} from "../src/ui/stage/DisplayPopover";
import { ToolColumn } from "../src/ui/stage/ToolColumn";
import { dimLabel } from "../src/ui/valueLabels";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

afterEach(() => forceHost(null));

function renderIn(h: FakeHarness, node: preact.ComponentChild): string {
  return render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>{node}</LeafContext.Provider>
    </ServicesContext.Provider>,
  );
}

const expand = (h: FakeHarness, on = true) => h.services.device.update((d) => setDisplayExpanded(d, on));
/** The visible text of one section's heading row, in order of appearance. */
const headings = (html: string) => [...html.matchAll(/class="cx-section-label"[^>]*><span>([^<]+)<\/span>/g)].map((m) => m[1] ?? "");

describe("desktop: the first screen", () => {
  it("opens on FORM, GROUPS, COLOUR, SHOW, MOTION and DRAWN, the collapsed theme block and the extras, with Fewer options in the footer", () => {
    forceHost("desktop");
    const h = fakeServices();
    const html = renderIn(h, <DisplayPopover />);
    expect(headings(html)).toEqual(["Form", "Groups", "Colour", "Show", "Motion", "Drawn", "Look", "Points", "Tooltip", "Area scope"]);
    for (const s of ["Spacing", "Notes", "Record", "Notes by", "Record by", "Same as notes", "Labels", "Hide unsorted", "Colour by", "Your colour", "Body", "All links", "Rotation", "Speed", "Keep upright", "Links", "Scaffold", "Dot size"]) expect(html).toContain(s);
    for (const s of ["Fewer options", "Quick walkthrough", "Explore the sample record", "Reset", "Theme and data colours"]) expect(html).toContain(s);
    expect(html).not.toContain("More options");
    // inside the collapsed theme block
    for (const s of ["Colour theme", "Stage tint", "Prism"]) expect(html).not.toContain(s);
  });

  it("the sections follow each other in the reference order", () => {
    forceHost("desktop");
    const h = fakeServices();
    const html = renderIn(h, <DisplayPopover />);
    const at = (x: string) => html.indexOf(x);
    expect(at("Spacing")).toBeLessThan(at("Notes by"));
    expect(at("Hide unsorted")).toBeLessThan(at("Colour by"));
    expect(at("Your colour")).toBeLessThan(at("All links"));
    expect(at("All links")).toBeLessThan(at("Rotation"));
    expect(at("Keep upright")).toBeLessThan(at("Scaffold"));
    expect(at("Scaffold")).toBeLessThan(at("Theme and data colours"));
  });

  it("the full panel carries the chart switch, LOOK, POINTS, Tooltip and Area scope below DRAWN", () => {
    forceHost("desktop");
    const h = fakeServices();
    const html = renderIn(h, <DisplayPopover />);
    expect(html).toContain("Fewer options");
    expect(html).toContain('aria-expanded="true"');
    for (const s of ["Chart", "Rotation style", "Pause while pointing", "Lines", "Brain outline", "Glow", "Brightness"]) expect(html).toContain(s);
  });

  it("Fewer options hides SHOW, MOTION and the extras, remembered on the device; More options brings them back", () => {
    forceHost("desktop");
    const h = fakeServices();
    expect(displayCompactOn(h.services.device.value)).toBe(false);
    h.services.device.update((d) => setDisplayCompact(d, true));
    const html = renderIn(h, <DisplayPopover />);
    expect(headings(html)).toEqual(["Form", "Groups", "Colour", "Drawn"]);
    expect(html).toContain("More options");
    expect(html).toContain('aria-expanded="false"');
    for (const s of ["All links", "Keep upright", "Rotation style", "Brain outline", "Tooltip"]) expect(html).not.toContain(s);
    // Parsed back from storage; a malformed value opens the full panel.
    expect(displayCompactOn(parseDeviceState(JSON.parse(JSON.stringify(h.services.device.value))))).toBe(true);
    expect(displayCompactOn(parseDeviceState({ displayCompact: "yes" }))).toBe(false);
    h.services.device.update((d) => setDisplayCompact(d, false));
    expect(headings(renderIn(h, <DisplayPopover />))).toContain("Show");
  });

  it("keeps the wording the originality list bans out of the panel", () => {
    forceHost("desktop");
    const h = fakeServices();
    expand(h);
    const html = renderIn(h, <DisplayPopover />);
    for (const banned of ["Turning", "Spread", "Threads", "Arrangement"]) expect(html).not.toMatch(new RegExp(`\\b${banned}\\b`));
    for (const banned of ["point size", "limit rotation", "own chats", "labels on the brain", "table builder"]) expect(html).not.toMatch(new RegExp(banned, "i"));
  });

  it("the Order row follows the slider: only at the Body end", () => {
    forceHost("desktop");
    const h = fakeServices();
    expect(renderIn(h, <DisplayPopover />)).toContain("Order: Oldest first");
    h.leaf.store.update("view", { shape: "groups", morph: 0.6 });
    expect(renderIn(h, <DisplayPopover />)).not.toContain("Order: ");
  });

  it("Record by reads Same as notes until a field is chosen, in both forms", () => {
    forceHost("desktop");
    const h = fakeServices();
    expect(renderIn(h, <DisplayPopover />)).toContain("Record by: Same as notes");
    h.leaf.store.update("view", { shape: "groups", morph: 1 });
    expect(renderIn(h, <DisplayPopover />)).toContain("Record by: Same as notes");
    h.leaf.store.update("view", { splitGroups: true, groupByRecord: "speaker" });
    expect(renderIn(h, <DisplayPopover />)).toContain(`Record by: ${dimLabel("speaker")}`);
  });
});

describe("Spacing, Rotation and the link switches", () => {
  it("Spacing 0 is the resting figure and 100% the top of the Scatter range", () => {
    expect(scatterFromSpread(0)).toBe(1);
    expect(scatterFromSpread(1)).toBe(1.5);
    expect(scatterFromSpread(0.5)).toBe(1.25);
    expect(scatterFromSpread(7)).toBe(1.5);
    expect(scatterFromSpread(-3)).toBe(1);
    expect(scatterFromSpread(Number.NaN)).toBe(1);
    expect(spreadFromScatter(1)).toBe(0);
    expect(spreadFromScatter(1.5)).toBe(1);
    expect(spreadFromScatter(1.25)).toBe(0.5);
    expect(spreadFromScatter(0.6)).toBe(0);
    expect(spreadFromScatter(Number.NaN)).toBe(0);
    for (const x of [0, 0.25, 0.5, 0.75, 1]) expect(spreadFromScatter(scatterFromSpread(x))).toBe(x);
  });

  it("a fresh view starts at the resting figure", () => {
    expect(spreadFromScatter(defaultView().look.scatter)).toBe(0);
  });

  it("Rotation turns the motion off and back to the pose's own", () => {
    const h = fakeServices();
    const store = h.leaf.store;
    store.update("view", { pose: "standing" });
    expect(rotationOn(store.get("view").motion)).toBe(true);
    setRotation(store, false);
    expect(store.get("view").motion.mode).toBe("off");
    expect(rotationOn(store.get("view").motion)).toBe(false);
    setRotation(store, true);
    expect(store.get("view").motion.mode).toBe("spin");
    store.update("view", { pose: "lying" });
    setRotation(store, false);
    setRotation(store, true);
    expect(store.get("view").motion.mode).toBe("drift");
  });

  it("Links and All links map onto the lines mode", () => {
    expect(linesWithLinks("off", true)).toBe("selection");
    expect(linesWithLinks("all", true)).toBe("all");
    expect(linesWithLinks("selection", false)).toBe("off");
    expect(linesWithAll(true)).toBe("all");
    expect(linesWithAll(false)).toBe("selection");
  });
});

describe("Notes by and Record by", () => {
  it("Notes by groups the notes by the field and recolours them", () => {
    const h = fakeServices();
    const store = h.leaf.store;
    chooseNotesBy(store, "kind");
    expect(store.get("view").groupBy).toBe("kind");
    expect(store.get("view").colour.notes).toEqual({ kind: "categorical", dim: "kind" });
  });

  it("Record by a field groups and recolours the record at once, and Same as notes undoes it", () => {
    const h = fakeServices();
    const store = h.leaf.store;
    chooseRecordBy(store, "speaker");
    let v = store.get("view");
    expect(v.splitGroups).toBe(true);
    expect(v.groupByRecord).toBe("speaker");
    expect(v.colour.record).toEqual({ kind: "categorical", dim: "speaker" });
    expect(v.colour.same).toBe(false);
    expect(recordByLabel(v)).toBe(dimLabel("speaker"));
    chooseNotesBy(store, "kind");
    chooseRecordBy(store, null);
    v = store.get("view");
    expect(v.splitGroups).toBe(false);
    expect(v.groupByRecord).toBeNull();
    expect(v.colour.record).toEqual(v.colour.notes);
    expect(recordByLabel(v)).toBe("Same as notes");
  });

  it("the Record by menu leads with Same as notes, then the shared fields, then the record-only ones", () => {
    const items = recordDimItems([], null, true);
    expect(items[0]).toMatchObject({ value: SAME_AS_NOTES, label: "Same as notes", checked: true, group: "same" });
    const groups = items.map((i) => i.group);
    expect(groups.indexOf("shared")).toBeGreaterThan(0);
    expect(groups.lastIndexOf("same")).toBe(0);
    expect(recordDimItems([], "speaker", true)[0]).toMatchObject({ checked: false });
    expect(recordDimItems([], null)[0]?.group).not.toBe("same");
  });
});

describe("the lower theme block", () => {
  it("is a collapsed disclosure that does not render the theme or the data colours until opened", () => {
    forceHost("desktop");
    const h = fakeServices();
    const html = renderIn(h, <DisplayPopover />);
    expect(html).toMatch(/class="cx-display-disclosure"[^>]*aria-expanded="false"|aria-expanded="false"[^>]*class="cx-display-disclosure"/);
    expect(html).not.toContain("Data colours");
  });
});

describe("the Chart switch", () => {
  it("mirrors the sheet: on only while the Chart page is the sheet's current entry", () => {
    const h = fakeServices();
    const store = h.leaf.store;
    expect(chartSheetOpen(store.get("ui").sheet)).toBe(false);
    openPage(store, "chart");
    expect(chartSheetOpen(store.get("ui").sheet)).toBe(true);
    openPage(store, "guide");
    expect(chartSheetOpen(store.get("ui").sheet)).toBe(false);
    closeSheet(store);
    expect(chartSheetOpen(store.get("ui").sheet)).toBe(false);
  });

  it("renders checked while the page is open", () => {
    forceHost("desktop");
    const h = fakeServices();
    openPage(h.leaf.store, "chart");
    const html = renderIn(h, <DisplayPopover />);
    expect(html).toMatch(/aria-checked="true"[^>]*aria-labelledby="[^"]+"[^>]*class="cx-toggle is-on"[^>]*><span class="cx-toggle-knob"><\/span><\/button><\/div>/);
  });
});

describe("colour row", () => {
  it("shows the live hex for one colour and 'follows the figure' otherwise", () => {
    expect(yourColourText({ kind: "single", slot: 1, hex: "#22d3ee" }, "default" as never)).toBe("#22D3EE");
    expect(yourColourText({ kind: "age" }, "default" as never)).toBe("follows the figure");
    expect(yourColourText({ kind: "categorical", dim: "space" }, "default" as never)).toBe("follows the figure");
  });

  it("names the Colour by choice: One colour, Date ramp or the dimension", () => {
    expect(colourChoiceLabel({ kind: "single", slot: 3 })).toBe("One colour");
    expect(colourChoiceLabel({ kind: "age" })).toBe("Date ramp");
    expect(colourChoiceLabel({ kind: "categorical", dim: "space" })).toBe(dimLabel("space"));
  });

  it("picking a swatch while a dimension colours the points switches to one colour, for both populations", () => {
    const h = fakeServices();
    const store = h.leaf.store;
    setColourMode(store, "notes", { kind: "categorical", dim: "space" });
    pickSingleColour(store, 4);
    expect(store.get("view").colour.notes).toEqual({ kind: "single", slot: 4 });
    expect(store.get("view").colour.record).toEqual({ kind: "single", slot: 4 });
    pickSingleColour(store, 2, "#abcdef");
    expect(store.get("view").colour.notes).toEqual({ kind: "single", slot: 2, hex: "#abcdef" });
    setColourEverywhere(store, { kind: "age" });
    expect(store.get("view").colour.record).toEqual({ kind: "age" });
  });

  it("renders the strip with a white swatch, a clickable conic swatch and the selected ring state", () => {
    forceHost("desktop");
    const h = fakeServices();
    expand(h);
    setColourEverywhere(h.leaf.store, { kind: "single", slot: 2 });
    const html = renderIn(h, <DisplayPopover />);
    expect(html).toContain("cx-swatch is-white");
    expect(html).toMatch(/<button[^>]*class="cx-swatch is-custom"/);
    expect(html).toMatch(/class="cx-swatch is-on"[^>]*/);
    expect(html).toContain("cx-your-colour-value is-hex");
    setColourEverywhere(h.leaf.store, { kind: "single", slot: 2, hex: "#ffffff" });
    const white = renderIn(h, <DisplayPopover />);
    expect(white).toMatch(/aria-label="White"[^>]*class="cx-swatch is-white is-on"|class="cx-swatch is-white is-on"/);
    expect(white).toContain("#FFFFFF");
  });
});

describe("SHOW", () => {
  it("carries the counts and flips the layers", () => {
    expect(showCounts(null)).toEqual({ notes: null, record: null, agent: null });
    const c = { notes: 12, record: 3400, askHistory: 7 } as Parameters<typeof showCounts>[0];
    expect(showCounts(c)).toEqual({ notes: 12, record: 3400, agent: 7 });
    forceHost("desktop");
    const h = fakeServices();
    expand(h);
    setLayer(h.leaf.store, "record", false);
    const html = renderIn(h, <DisplayPopover />);
    expect(html).toMatch(/aria-checked="false"[^>]*aria-label="Record[^"]*"/);
  });
});

describe("tool buttons", () => {
  it("the Display and list buttons are panel buttons (filled while open); toggles keep the dot", () => {
    const h = fakeServices();
    const html = renderIn(h, <ToolColumn />);
    expect(html).toMatch(/class="cx-icon-button s32 cx-tool is-panel"[^>]*aria-label="Display/);
    expect(html).toMatch(/class="cx-icon-button s28 cx-tool cx-tool-list is-panel"/);
    expect(html).not.toMatch(/class="cx-icon-button s32 cx-tool is-panel"[^>]*aria-label="Names/);
  });
});

describe("plugin host", () => {
  it("keeps its compact list and gains the footer links; All controls adds COLOUR and SHOW", () => {
    forceHost("plugin");
    const h = fakeServices();
    const compact = renderIn(h, <DisplayPopover />);
    expect(compact).toContain("All controls");
    expect(compact).toContain("Quick walkthrough");
    expect(compact).not.toContain("Your colour");
    expand(h);
    const full = renderIn(h, <DisplayPopover />);
    for (const s of ["Colour by", "Your colour", "Agent conversations", "Fewer controls"]) expect(full).toContain(s);
  });
});
