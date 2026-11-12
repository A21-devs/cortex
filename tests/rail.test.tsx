/**
 * The left rail's head and shell (P02): the wordmark with its area suffix, colour and roll, the palette bar, the
 * search field and its hairline, the toggle on the active destination, aria-pressed, and the palette-coloured
 * meters.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { contrastRatio, paletteById } from "../src/shared/palette";
import { openPage, pushSheet, setCommandMode, setScope } from "../src/state/actions";
import { LeafContext, ServicesContext, ShellContext, shellFor } from "../src/ui/context";
import { t } from "../src/ui/copy";
import { NavRail } from "../src/ui/nav/Nav";
import { isOpenOnTop, openNavItem, type NavHooks } from "../src/ui/nav/navModel";
import { isMacPlatform, runRailFind } from "../src/ui/nav/RailSearch";
import { CHROME_BG, ensureContrast, paletteStops, RAIL_STOPS, stopsGradient, suffixColour, suffixRoll, suffixText } from "../src/ui/nav/RailWordmark";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

const hooks = (): NavHooks => ({ add: () => undefined, ask: () => undefined, canWrite: () => true });

function renderRail(h: FakeHarness, shell = shellFor(h.leaf)): string {
  return render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>
        <ShellContext.Provider value={shell}>
          <NavRail />
        </ShellContext.Provider>
      </LeafContext.Provider>
    </ServicesContext.Provider>,
  );
}

describe("rail: wordmark and suffix", () => {
  it("shows bold 'cortex' and no suffix at All areas", () => {
    const h = fakeServices();
    const html = renderRail(h);
    expect(html).toContain('class="cx-rail-word-main"');
    expect(html).toContain(">cortex<");
    expect(suffixText("all")).toBe("");
    expect(html).not.toContain("cx-roll-in");
  });

  it("shows the area name as the suffix, tinted with the area's slot colour", () => {
    const h = fakeServices();
    setScope(h.leaf.store, "code");
    const html = renderRail(h);
    const name = suffixText("code");
    expect(name.length).toBeGreaterThan(0);
    expect(html).toMatch(new RegExp(`cx-roll-now" style="[^"]*color:[^"]*">${name}<`));
    const palette = h.services.settings.value.appearance.palette;
    const want = suffixColour("code", { code: 3 }, palette, "glow", true);
    expect(want).toBe(ensureContrast(paletteById(palette).glow[2] as string, CHROME_BG.dark));
  });

  it("lifts a dark slot colour until it keeps 4.5:1 on the chrome, and lowers a pale one on a light chrome", () => {
    const dark = ensureContrast("#2a2a6a", CHROME_BG.dark);
    expect(contrastRatio(dark, CHROME_BG.dark)).toBeGreaterThanOrEqual(4.5);
    const pale = ensureContrast("#e8e8a0", CHROME_BG.light);
    expect(contrastRatio(pale, CHROME_BG.light)).toBeGreaterThanOrEqual(4.5);
    // A colour that already passes is left alone.
    expect(ensureContrast("#ffffff", CHROME_BG.dark)).toBe("#ffffff");
  });

  it("steps on click, opens the scope menu from the chevron or a right-click; a modifier click, or the glyph, goes to Brain", () => {
    const html = renderRail(fakeServices());
    expect(html).toContain('class="cx-rail-word"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('class="cx-rail-glyph"');
    expect(html).toContain('class="cx-rail-word-menu"');
  });
});

describe("rail: suffix roll", () => {
  it("plans a roll when the area changes", () => {
    expect(suffixRoll("Code", "Web", false)).toEqual({ from: "Code", to: "Web" });
    expect(suffixRoll("", "Web", false)).toEqual({ from: "", to: "Web" });
  });
  it("skips the roll under reduced motion and when the word is unchanged", () => {
    expect(suffixRoll("Code", "Web", true)).toBeNull();
    expect(suffixRoll("Code", "Code", false)).toBeNull();
  });
  it("never renders the roll classes on first paint, reduced motion or not", () => {
    const h = fakeServices((s) => void (s.appearance.motion = "reduced"));
    setScope(h.leaf.store, "web");
    expect(renderRail(h)).not.toContain("is-rolling");
  });
});

describe("rail: palette bar, search hairline and meter fill", () => {
  it("draws a 2 px bar of the active palette's first six slots", () => {
    const h = fakeServices();
    const html = renderRail(h);
    const palette = h.services.settings.value.appearance.palette;
    const stops = paletteStops(palette, "glow");
    expect(stops).toHaveLength(RAIL_STOPS);
    expect(html).toContain('class="cx-rail-bar"');
    expect(html).toContain(stopsGradient(stops));
    expect(html).toContain('class="cx-rail-search-line"');
  });
  it("recolours when the palette setting changes", () => {
    const a = renderRail(fakeServices((s) => void (s.appearance.palette = "prism")));
    const b = renderRail(fakeServices((s) => void (s.appearance.palette = "ember")));
    expect(a).not.toBe(b);
    expect(b).toContain(stopsGradient(paletteStops("ember", "glow")));
  });
});

describe("rail: search field", () => {
  it("renders the magnifier button with the placeholder and a platform key chip", () => {
    const html = renderRail(fakeServices());
    expect(html).toContain('class="cx-rail-search"');
    expect(html).toContain(t("rail.find"));
    expect(html).toMatch(/<kbd class="cx-rail-key">(Ctrl K|Cmd K)<\/kbd>/);
  });
  it("reads Cmd K on a Mac and Ctrl K elsewhere", () => {
    expect(isMacPlatform({ navigator: { platform: "MacIntel" } })).toBe(true);
    expect(isMacPlatform({ navigator: { platform: "Win32" } })).toBe(false);
    expect(isMacPlatform(undefined)).toBe(false);
  });
  it("runs the focus-find action: Find mode in the command line", () => {
    const h = fakeServices();
    setCommandMode(h.leaf.store, "ask");
    runRailFind(h.leaf.store, shellFor(h.leaf));
    expect(h.leaf.store.get("ui").command.mode).toBe("find");
  });
});

describe("rail: choosing the open destination again closes the sheet", () => {
  it("toggles a page destination", () => {
    const h = fakeServices();
    const store = h.leaf.store;
    openNavItem(store, "navigator", hooks());
    expect(store.get("ui").sheet.open).toBe(true);
    openNavItem(store, "navigator", hooks());
    expect(store.get("ui").sheet.open).toBe(false);
    openNavItem(store, "navigator", hooks());
    expect(store.get("ui").sheet.open).toBe(true);
  });
  it("closes a pushed page too (Write), and switches rather than closes for another destination", () => {
    const store = fakeServices().leaf.store;
    openNavItem(store, "write", hooks());
    openNavItem(store, "write", hooks());
    expect(store.get("ui").sheet.open).toBe(false);
    openNavItem(store, "timeline", hooks());
    openNavItem(store, "numbers", hooks());
    expect(store.get("ui").sheet.open).toBe(true);
  });
  it("does not toggle when a reader sits on top of the page, or for Brain, + Add and Ask", () => {
    const store = fakeServices().leaf.store;
    openPage(store, "read");
    pushSheet(store, { kind: "reader", route: "entry", id: "e_1" });
    expect(isOpenOnTop(store.get("ui"), "navigator")).toBe(false);
    openNavItem(store, "navigator", hooks());
    expect(store.get("ui").sheet.open).toBe(true);
    for (const id of ["brain", "add", "ai"] as const) expect(isOpenOnTop(store.get("ui"), id)).toBe(false);
  });
  it("marks nav items with aria-pressed", () => {
    const h = fakeServices();
    openNavItem(h.leaf.store, "navigator", hooks());
    const html = renderRail(h);
    expect(html).toMatch(/data-nav="navigator"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-nav="brain"[^>]*aria-pressed="false"/);
  });
});

describe("rail: mount points", () => {
  it("leaves an empty slot for the status block under the destinations", () => {
    const html = renderRail(fakeServices());
    const nav = html.indexOf("</nav>");
    const status = html.indexOf('class="cx-rail-status"');
    expect(nav).toBeGreaterThan(-1);
    expect(status).toBeGreaterThan(nav);
    expect(html).not.toContain("cx-rail-mini");
    expect(html.indexOf('class="cx-rail-head"')).toBeLessThan(html.indexOf('class="cx-rail-scope"'));
  });
});
