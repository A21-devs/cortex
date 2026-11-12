/**
 * A figure colour pick changes only what the renderer draws for the figure's particles. The window, the stage ground, the
 * rail, the legend and key, the time strip, the top buttons, the Display panel and the Settings window render exactly the
 * same markup, styles and CSS variables with and without a pick.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { applyColourTheme, COLOUR_THEME_IDS, figureOverride } from "../src/shared/colourTheme";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { openPopover } from "../src/state/actions";
import { App } from "../src/ui/App";
import { LeafContext, ServicesContext, ShellContext, shellFor } from "../src/ui/context";
import { NavRail } from "../src/ui/nav/Nav";
import { DisplayPopover } from "../src/ui/stage/DisplayPopover";
import { KeyPopover } from "../src/ui/stage/KeyPopover";
import { StageCluster } from "../src/ui/stage/StageCluster";
import { ToolColumn } from "../src/ui/stage/ToolColumn";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

/** Rendered markup with the running counter of generated element ids taken out (each render numbers them afresh). */
function renderIn(h: FakeHarness, node: preact.ComponentChild): string {
  return renderRaw(h, node).replace(/(cx-[a-z]+)-\d+/g, "$1-N");
}

function renderRaw(h: FakeHarness, node: preact.ComponentChild): string {
  return render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>
        <ShellContext.Provider value={shellFor(h.leaf)}>{node}</ShellContext.Provider>
      </LeafContext.Provider>
    </ServicesContext.Provider>,
  );
}

/** The same shell with a window and data colours that are not the defaults, so a leak would show. */
function harness(): FakeHarness {
  return fakeServices((s) => {
    s.appearance.stage = "paper";
    s.appearance.stageTint = 40;
    s.appearance.palette = "harbor";
    s.appearance.ageColours = "lightness";
  });
}

describe("a figure colour pick is figure-only", () => {
  it("leaves the data colours, age colours, window theme and tint settings untouched", async () => {
    const h = harness();
    const keys = (): string => JSON.stringify({ ...h.services.settings.value.appearance, figureColours: null });
    const before = keys();
    for (const id of COLOUR_THEME_IDS) {
      await h.services.settings.update((x) => applyColourTheme(x.appearance, id));
      expect(keys()).toBe(before);
      expect(h.services.settings.value.appearance.figureColours).toBe(id === "default" ? null : id);
    }
  });

  it("renders the whole window, rail, tool buttons, key, Display panel and its CSS variables identically with every theme", async () => {
    const pieces: Array<[string, (h: FakeHarness) => preact.ComponentChild]> = [
      ["the app", (h) => <App services={h.services} leaf={h.leaf} />],
      ["the rail", () => <NavRail />],
      ["the tool column", () => <ToolColumn />],
      ["the stage cluster", () => <StageCluster />],
      ["the key popover", () => <KeyPopover />],
      ["the Display panel", () => <DisplayPopover />],
    ];
    for (const [name, make] of pieces) {
      const h = harness();
      openPopover(h.leaf.store, "key");
      // One neutral write first: a save starts the shell's own loading line, which is not what is under test.
      await h.services.settings.update((x) => applyColourTheme(x.appearance, "default"));
      const base = renderIn(h, make(h));
      for (const id of COLOUR_THEME_IDS) {
        await h.services.settings.update((x) => applyColourTheme(x.appearance, id));
        expect(renderIn(h, make(h)), `${name} with ${id}`).toBe(base);
      }
    }
  });

  it("reaches the render pipeline: the figure override is the only thing that follows the pick", async () => {
    const h = harness();
    const a = () => h.services.settings.value.appearance;
    expect(figureOverride(a())).toBeUndefined();
    await h.services.settings.update((x) => applyColourTheme(x.appearance, "verdant"));
    expect(figureOverride(a())).toMatchObject({ palette: "verdant", age: { mode: "lightness" } });
    expect(a().palette).toBe("harbor");
    expect(a().ageColours).toBe("lightness");
    expect(DEFAULT_SETTINGS.appearance.figureColours).toBeNull();
  });
});
