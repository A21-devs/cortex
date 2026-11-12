/**
 * Display panel looks: the Data colours row model and list, Stage tint slider mapping, "Names for" and Density with a
 * lit set, the Brain outline slider (0 = haze off), the Body / Groups switch and the hairline leaders.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { DATA_COLOUR_IDS, DATA_COLOUR_STRIPE, dataColourRows, paletteDots, sliderToTint, stepDataColour, tintToSlider } from "../src/shared/palette";
import { sanitizeView } from "../src/state/persist";
import { createLeafStore } from "../src/state/store";
import { defaultView, hazeScale, NAMES_DENSITY, NAMES_FOR, OUTLINE_RANGE } from "../src/state/types";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { setDisplayExpanded } from "../src/ui/deviceState";
import { forceHost } from "../src/ui/host";
import { DataColoursList } from "../src/ui/stage/DataColoursList";
import { DisplayPopover, MODE_SWITCH_MS, modeSwitchTarget, namesForPatch, tintLabel } from "../src/ui/stage/DisplayPopover";
import { leaderFor } from "../src/ui/stage/GroupOverlay";
import { chipCap, chipsForNames } from "../src/ui/stage/LabelLayer";
import { setBrainOutline, setHazeLayer } from "../src/ui/stage/LayersMenu";
import { declutterNames, densityCap, FEW_NAMES, litKeys, namesForFilter, type NameBox } from "../src/ui/stage/nameDeclutter";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

function renderIn(h: FakeHarness, node: preact.ComponentChild): string {
  return render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>{node}</LeafContext.Provider>
    </ServicesContext.Provider>,
  );
}

describe("data colours row model", () => {
  it("has seven named rows with seven-colour stripes, the one in use selected", () => {
    const rows = dataColourRows("harbor");
    expect(rows.map((r) => r.id)).toEqual([...DATA_COLOUR_IDS]);
    expect(rows).toHaveLength(7);
    for (const r of rows) expect(r.stripe).toHaveLength(DATA_COLOUR_STRIPE);
    expect(rows.filter((r) => r.selected).map((r) => r.id)).toEqual(["harbor"]);
    expect(rows[0]?.stripe).toEqual(paletteDots("prism", 7));
  });

  it("a tint palette (from a colour theme) selects no row", () => {
    expect(dataColourRows("garnet").some((r) => r.selected)).toBe(false);
  });

  it("arrow steps wrap around the list", () => {
    expect(stepDataColour("prism", 1)).toBe("signal");
    expect(stepDataColour("prism", -1)).toBe("print");
    expect(stepDataColour("print", 1)).toBe("prism");
    expect(stepDataColour("garnet", 1)).toBe("prism");
  });
});

describe("stage tint slider", () => {
  it("0 is Off and 1 to 360 is the hue", () => {
    expect(sliderToTint(0)).toBeNull();
    expect(sliderToTint(200)).toBe(200);
    expect(sliderToTint(360)).toBe(0);
    expect(tintToSlider(null)).toBe(0);
    expect(tintToSlider(0)).toBe(360);
    expect(tintToSlider(148)).toBe(148);
    for (const h of [0, 22, 148, 258, 359]) expect(sliderToTint(tintToSlider(h))).toBe(h);
    expect(tintLabel(0)).toBe("Off");
    expect(tintLabel(148)).toBe("148°");
  });
});

describe("the data colours list", () => {
  it("renders the seven rows and outlines the selected one", () => {
    const h = fakeServices((s) => void (s.appearance.palette = "reef"));
    const html = renderIn(h, <DataColoursList />);
    for (const name of ["Prism", "Signal", "Harbor", "Orchard", "Ember", "Reef", "Print"]) expect(html).toContain(name);
    expect(html.match(/cx-data-colour is-on/g)).toHaveLength(1);
    expect(html).toMatch(/is-on"[^>]*data-palette="reef"/);
  });

  it("writes only the palette: the window theme and tint stay", async () => {
    const h = fakeServices((s) => {
      s.appearance.stage = "cobalt";
      s.appearance.stageTint = 258;
    });
    await h.services.settings.update((x) => void (x.appearance.palette = "ember"));
    const a = h.services.settings.value.appearance;
    expect(a.palette).toBe("ember");
    expect(a.stage).toBe("cobalt");
    expect(a.stageTint).toBe(258);
  });

  it("a preview shows a palette without saving it", () => {
    const h = fakeServices();
    const before = h.services.settings.value.appearance.palette;
    h.services.settings.preview?.((x) => void (x.appearance.palette = "reef"));
    expect(h.services.settings.value.appearance.palette).toBe("reef");
    h.services.settings.endPreview?.();
    expect(h.services.settings.value.appearance.palette).toBe(before);
  });
});

const box = (key: string, x: number, y: number, weight: number, extra: Partial<NameBox> = {}): NameBox => ({ key, x, y, w: 40, h: 16, align: "center", weight, ...extra });

describe("names for and density", () => {
  const boxes = [box("a", 0, 0, 9, { lit: true }), box("b", 100, 0, 5), box("c", 200, 0, 3, { hovered: true }), box("axis", 300, 0, 0, { fixed: true })];

  it("Everything keeps every name", () => {
    expect(namesForFilter(boxes, "everything").map((b) => b.key)).toEqual(["a", "b", "c", "axis"]);
  });

  it("What is lit keeps the lit, the hovered and the fixed ones", () => {
    expect(namesForFilter(boxes, "lit").map((b) => b.key)).toEqual(["a", "c", "axis"]);
  });

  it("Hovered only keeps the hovered and the fixed ones", () => {
    expect(namesForFilter(boxes, "hovered").map((b) => b.key)).toEqual(["c", "axis"]);
  });

  it("re-declutters as the lit set changes", () => {
    const stacked = (lit: string[]) => ["a", "b", "c"].map((k, i) => box(k, 0, 0, 10 - i, { lit: lit.includes(k) }));
    const first = declutterNames(namesForFilter(stacked(["b"]), "lit"));
    expect([...first.keys()]).toEqual(["b"]);
    expect(first.get("b")).toEqual({ dy: 0, hidden: false });
    const second = declutterNames(namesForFilter(stacked(["a", "c"]), "lit"));
    expect([...second.keys()].sort()).toEqual(["a", "c"]);
    expect(second.get("a")?.hidden).toBe(false);
  });

  it("the lit keys come from the highlighted groups", () => {
    const keys = litKeys([{ key: "x", pk: "folder=Work" }, { key: "y", pk: "folder=Home" }, { key: "z", pk: null }], new Set(["folder=Work"]));
    expect([...keys]).toEqual(["x"]);
  });

  it("density: Few caps at a dozen, Auto keeps the cap, All has none and hides nothing", () => {
    expect(densityCap("few", 60)).toBe(FEW_NAMES);
    expect(densityCap("auto", 60)).toBe(60);
    expect(densityCap("all", 60)).toBe(Number.POSITIVE_INFINITY);
    const crowd = Array.from({ length: 12 }, (_v, i) => box(`n${i}`, 0, 0, 20 - i));
    expect([...declutterNames(crowd).values()].some((p) => p.hidden)).toBe(true);
    expect([...declutterNames(crowd, 2, true).values()].every((p) => !p.hidden)).toBe(true);
  });

  it("chips follow the same choices", () => {
    const a = (key: string, priority: number, hover = false) => ({ key, ordinal: 0, x: 1, y: 1, depth: 0, priority, kind: "", glyph: "", title: key, rgb: [1, 1, 1] as [number, number, number], ...(hover ? { hover } : {}) });
    const list = [a("big", 1), a("traced", 2), a("picked", 4), a("hub", 2.5, true)];
    expect(chipsForNames(list, "everything")).toHaveLength(4);
    expect(chipsForNames(list, "lit").map((x) => x.key)).toEqual(["traced", "picked", "hub"]);
    expect(chipsForNames(list, "hovered").map((x) => x.key)).toEqual(["picked", "hub"]);
    expect(chipCap("few", 24)).toBe(8);
    expect(chipCap("auto", 24)).toBe(24);
    expect(chipCap("all", 24)).toBe(48);
  });

  it("choosing Names for settles the chips with it", () => {
    expect(namesForPatch("everything")).toEqual({ namesFor: "everything", names: "always" });
    expect(namesForPatch("lit")).toEqual({ namesFor: "lit", names: "hover" });
    expect(namesForPatch("hovered").names).toBe("hover");
  });

  it("the choices survive a saved view and fall back when unreadable", () => {
    const base = defaultView();
    expect(base.look.namesFor).toBe("everything");
    expect(base.look.density).toBe("auto");
    const v = sanitizeView({ look: { namesFor: "lit", density: "few", outline: 0.4 } }, base);
    expect([v.look.namesFor, v.look.density, v.look.outline]).toEqual(["lit", "few", 0.4]);
    const bad = sanitizeView({ look: { namesFor: "nope", density: 3, outline: "x" } }, base);
    expect([bad.look.namesFor, bad.look.density, bad.look.outline]).toEqual(["everything", "auto", 1]);
    expect(NAMES_FOR).toHaveLength(3);
    expect(NAMES_DENSITY).toHaveLength(3);
  });
});

describe("leaders", () => {
  const b = { x: 100, y: 100, w: 60, h: 16, align: "center" as const };
  it("a name right over its sphere needs none; a distant or nudged one gets a hairline to the centroid", () => {
    expect(leaderFor(b, 0, { x: 100, y: 120 })).toBeNull();
    const far = leaderFor(b, 0, { x: 100, y: 200 });
    expect(far).toEqual({ x0: 100, y0: 108, x1: 100, y1: 200 });
    expect(leaderFor(b, 18, { x: 100, y: 112 })).not.toBeNull();
  });
});

describe("brain outline", () => {
  it("scales the haze: 0 is off, 100% rests, 150% is the top", () => {
    expect(OUTLINE_RANGE).toEqual([0, 1.5]);
    expect(hazeScale({ haze: true }, { outline: 1 })).toBe(1);
    expect(hazeScale({ haze: true }, { outline: 0 })).toBe(0);
    expect(hazeScale({ haze: true }, { outline: 1.5 })).toBe(1.5);
    expect(hazeScale({ haze: true }, { outline: 9 })).toBe(1.5);
    expect(hazeScale({ haze: false }, { outline: 1.2 })).toBe(0);
    expect(hazeScale({ haze: true }, {})).toBe(1);
  });

  it("the slider at 0 turns the haze layer off; raising it turns the layer back on", () => {
    const store = createLeafStore();
    setBrainOutline(store, 0);
    expect(store.get("view").layers.haze).toBe(false);
    setBrainOutline(store, 0.5);
    expect(store.get("view").layers.haze).toBe(true);
    expect(store.get("view").look.outline).toBe(0.5);
    setBrainOutline(store, 4);
    expect(store.get("view").look.outline).toBe(1.5);
  });

  it("the Layers menu row at outline 0 brings the outline back to 100%", () => {
    const store = createLeafStore();
    setBrainOutline(store, 0);
    setHazeLayer(store, true);
    expect(store.get("view").layers.haze).toBe(true);
    expect(store.get("view").look.outline).toBe(1);
    setHazeLayer(store, false);
    expect(store.get("view").layers.haze).toBe(false);
    expect(store.get("view").look.outline).toBe(1);
  });
});

describe("view mode switch", () => {
  it("morphs over 1.4 s and flips at the half", () => {
    expect(MODE_SWITCH_MS).toBe(1400);
    expect(modeSwitchTarget(0)).toBe(1);
    expect(modeSwitchTarget(0.49)).toBe(1);
    expect(modeSwitchTarget(0.5)).toBe(0);
    expect(modeSwitchTarget(1)).toBe(0);
  });

  it("has a collapse chevron, starts on the Form section, and keeps the theme and data colours in a collapsed block below", () => {
    forceHost("desktop");
    try {
      const h = fakeServices();
      const html = renderIn(h, <DisplayPopover />);
      expect(html).toContain("Collapse the panel");
      expect(html.indexOf("Form")).toBeLessThan(html.indexOf("Theme and data colours"));
      expect(html).not.toContain("Colour theme");
    } finally {
      forceHost(null);
    }
  });

  it("the plugin panel keeps the Body / Groups switch", () => {
    forceHost("plugin");
    try {
      const h = fakeServices();
      expect(renderIn(h, <DisplayPopover />)).toContain("Show as groups");
    } finally {
      forceHost(null);
    }
  });

  it("the Names toggle is gone: Names for and Density replace it", () => {
    forceHost("desktop");
    try {
      const h = fakeServices();
      h.services.device.update((d) => setDisplayExpanded(d, true));
      const html = renderIn(h, <DisplayPopover />);
      expect(html).not.toContain("Always show point names");
      for (const s of ["Names for", "Everything", "Density", "Auto", "Brain outline"]) expect(html).toContain(s);
    } finally {
      forceHost(null);
    }
  });
});
