/** Figure colour themes (shared/colourTheme.ts, the theme popover) and Showcase mode (ui/showcase). */
import { render } from "preact-render-to-string";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMAND_IDS } from "../src/plugin/commands";
import { desktopMenu, menuCommandIds } from "../src/desktop/menu";
import { activeColourTheme, ageOptions, applyColourTheme, figureAgeOptions, figureOverride, figurePalette, COLOUR_THEMES, COLOUR_THEME_IDS } from "../src/shared/colourTheme";
import { ageStops, deltaE, hexToRgb, isThemeId, paletteById, THEME_CARDS, THEME_STAGES, TINT_IDS, TINT_PALETTES } from "../src/shared/palette";
import { createSettingsHandle } from "../src/plugin/settingsStore";
import { DEFAULT_SETTINGS, migrateSettings, migrateSettingsChecked, type CortexSettings } from "../src/shared/settings";
import type { SpaceId } from "../src/shared/types";
import * as A from "../src/state/actions";
import { LeafContext, ServicesContext, Shell } from "../src/ui/context";
import { COPY, t, type CopyKey } from "../src/ui/copy";
import { CHORD_WINDOW_MS, createChord, type ChordKey } from "../src/ui/showcase/chord";
import { buildShowcase, offeredCharts, offeredLayouts, type ShowcaseEnv } from "../src/ui/showcase/registry";
import { installShowcaseKeys, showcaseEnv, showcaseRunning, startShowcase, stopShowcase } from "../src/ui/showcase/runner";
import { StageCluster } from "../src/ui/stage/StageCluster";
import { pickColourTheme, ThemePopover } from "../src/ui/stage/ThemePopover";
import { ToolColumn } from "../src/ui/stage/ToolColumn";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

const appearance = () => structuredClone(DEFAULT_SETTINGS.appearance);

describe("tint palettes and the garnet window theme", () => {
  it("resolve through paletteById with eight distinct slots in every variant", () => {
    expect(TINT_IDS).toHaveLength(5);
    for (const id of TINT_IDS) {
      const def = paletteById(id);
      expect(def.id).toBe(id);
      for (const variant of ["glow", "fill", "light"] as const) {
        const slots = def[variant];
        expect(slots).toHaveLength(8);
        for (const hex of slots) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
        for (let i = 0; i < 8; i++) expect(deltaE(slots[i] as string, slots[(i + 1) % 8] as string)).toBeGreaterThan(4);
      }
      expect(def.forcesPaper).toBe(false);
    }
    expect(TINT_PALETTES.map((p) => p.id)).toEqual([...TINT_IDS]);
  });

  it("keep one hue: red slots lean red, blue slots lean blue, green slots lean green", () => {
    const lean = (id: (typeof TINT_IDS)[number]) => {
      const [r, g, b] = hexToRgb(paletteById(id).fill[0] as string);
      return { r, g, b };
    };
    expect(lean("garnet").r).toBeGreaterThan(lean("garnet").b);
    expect(lean("sapphire").b).toBeGreaterThan(lean("sapphire").r);
    expect(lean("verdant").g).toBeGreaterThan(lean("verdant").r);
  });

  it("garnet is a window theme with its own card, and the original ids still resolve", () => {
    expect(isThemeId("garnet")).toBe(true);
    expect(THEME_STAGES.garnet.accent).toMatch(/^#/);
    expect(THEME_CARDS.map((c) => c.id)).toContain("garnet");
    expect(paletteById("prism").id).toBe("prism");
    expect(paletteById("nope" as "prism").id).toBe("prism");
  });
});

describe("colour theme settings", () => {
  it("lists Default first, then red, blue and green among others, each with a name in the copy", () => {
    expect(COLOUR_THEME_IDS[0]).toBe("default");
    for (const id of ["garnet", "sapphire", "verdant"] as const) expect(COLOUR_THEME_IDS).toContain(id);
    for (const c of COLOUR_THEMES) expect(t(`colourThemes.${c.id}` as CopyKey)).toBe(COPY.colourThemes[c.id]);
  });

  it("a pick writes only appearance.figureColours: the data palette, age colours, window and tint are untouched", () => {
    const a = appearance();
    a.stage = "paper";
    a.palette = "harbor";
    a.stageTint = 40;
    a.ageColours = "lightness";
    const before = JSON.parse(JSON.stringify(a)) as Record<string, unknown>;
    applyColourTheme(a, "garnet");
    expect(a).toMatchObject({ stage: "paper", stageTint: 40, palette: "harbor", ageColours: "lightness", figureColours: "garnet" });
    expect(activeColourTheme(a)).toBe("garnet");
    const changed = Object.keys(a).filter((k) => JSON.stringify((a as Record<string, unknown>)[k]) !== JSON.stringify(before[k]));
    expect(changed).toEqual(["figureColours"]);
  });

  it("moving between colour themes and back to Default leaves every other setting exactly as it was", () => {
    const a = appearance();
    a.stage = "ink";
    a.stageTint = 120;
    a.palette = "reef";
    const before = JSON.stringify(a);
    applyColourTheme(a, "sapphire");
    applyColourTheme(a, "verdant");
    expect(a).toMatchObject({ stage: "ink", stageTint: 120, palette: "reef", ageColours: "hue", figureColours: "verdant" });
    applyColourTheme(a, "default");
    expect(a.figureColours).toBeNull();
    expect(JSON.stringify(a)).toBe(before);
    expect(activeColourTheme(a)).toBe("default");
  });

  it("the figure's palette and age ramp follow the theme (dark to bright); the own ramp for everything else never does", () => {
    const a = appearance();
    a.stageTint = 200;
    a.ageColours = "lightness";
    expect(ageOptions(a)).toEqual({ mode: "lightness", tintHue: 200, chroma: 0.02 });
    expect(figureAgeOptions(a)).toEqual(ageOptions(a));
    expect(figurePalette(a)).toBe("prism");
    expect(figureOverride(a)).toBeUndefined();
    applyColourTheme(a, "garnet");
    expect(ageOptions(a)).toEqual({ mode: "lightness", tintHue: 200, chroma: 0.02 });
    const o = figureAgeOptions(a);
    expect(o).toMatchObject({ mode: "lightness", tintHue: COLOUR_THEMES.find((c) => c.id === "garnet")?.hue });
    expect(figurePalette(a)).toBe("garnet");
    expect(figureOverride(a)).toEqual({ palette: "garnet", age: o });
    expect(a.stageTint).toBe(200);
    const stops = ageStops(false, o.mode, o.tintHue, o.chroma).map((h) => hexToRgb(h));
    expect(stops).toHaveLength(8);
    for (const [r, g, b] of stops.slice(0, 7)) expect(r).toBeGreaterThan(Math.max(g, b) - 1);
    const L = (rgb: readonly number[]) => 0.2126 * (rgb[0] as number) + 0.7152 * (rgb[1] as number) + 0.0722 * (rgb[2] as number);
    expect(new Set(stops.map((x) => L(x))).size).toBeGreaterThan(5);
    applyColourTheme(a, "default");
    expect(figureAgeOptions(a)).toEqual({ mode: "lightness", tintHue: 200, chroma: 0.02 });
  });

  it("Default with no theme in force changes nothing", () => {
    const a = appearance();
    const before = JSON.stringify(a);
    applyColourTheme(a, "default");
    expect(JSON.stringify(a)).toBe(before);
  });

  it("a Data colours card picked in Settings is independent of the figure theme, and a window theme does not end it", () => {
    const a = appearance();
    applyColourTheme(a, "orchid");
    a.stage = "ink";
    a.palette = "reef";
    expect(activeColourTheme(a)).toBe("orchid");
    expect(figurePalette(a)).toBe("orchid");
    applyColourTheme(a, "default");
    expect(figurePalette(a)).toBe("reef");
  });

  it("an earlier version's colour theme gives the window back once, and a later window choice is kept", () => {
    const old = structuredClone(DEFAULT_SETTINGS) as unknown as { version: number; appearance: Record<string, unknown> };
    old.version = 5;
    Object.assign(old.appearance, { stage: "cobalt", palette: "sapphire", ageColours: "lightness", stageTint: 258, colourMemory: { stage: "paper", palette: "harbor", ageColours: "hue", stageTint: 40 } });
    const moved = migrateSettings(old).appearance;
    expect(moved).toMatchObject({ stage: "paper", stageTint: 40, palette: "harbor", ageColours: "hue", figureColours: "sapphire" });
    const now = structuredClone(old);
    now.version = 6;
    expect(migrateSettings(now).appearance).toMatchObject({ stage: "cobalt", palette: "harbor", ageColours: "hue", figureColours: "sapphire" });
  });

  it("a v6 colour theme moves into figureColours and the person's own data colours come back; a v6 file with no theme is left alone", () => {
    const v6 = structuredClone(DEFAULT_SETTINGS) as unknown as { version: number; appearance: Record<string, unknown> };
    v6.version = 6;
    Object.assign(v6.appearance, { palette: "verdant", ageColours: "lightness", colourMemory: { stage: "follow", palette: "reef", ageColours: "hue", stageTint: null } });
    expect(migrateSettings(v6).appearance).toMatchObject({ palette: "reef", ageColours: "hue", figureColours: "verdant" });
    const plain = structuredClone(DEFAULT_SETTINGS) as unknown as { version: number; appearance: Record<string, unknown> };
    plain.version = 6;
    Object.assign(plain.appearance, { palette: "harbor", ageColours: "lightness" });
    expect(migrateSettings(plain).appearance).toMatchObject({ palette: "harbor", ageColours: "lightness", figureColours: null });
    // Current files are not migrated again.
    const v7 = structuredClone(DEFAULT_SETTINGS);
    v7.appearance.palette = "garnet";
    expect(migrateSettings(JSON.parse(JSON.stringify(v7))).appearance).toMatchObject({ palette: "garnet", figureColours: null });
  });

  it("is part of the saved settings with a safe default, survives an old file without it, and drops an unknown id", () => {
    expect(DEFAULT_SETTINGS.appearance.figureColours).toBeNull();
    const old = structuredClone(DEFAULT_SETTINGS) as unknown as { appearance: Record<string, unknown> };
    delete old.appearance.figureColours;
    expect(migrateSettings(old).appearance.figureColours).toBeNull();
    const kept = structuredClone(DEFAULT_SETTINGS);
    applyColourTheme(kept.appearance, "saffron");
    const back = migrateSettings(JSON.parse(JSON.stringify(kept))).appearance;
    expect(back.figureColours).toBe("saffron");
    expect(back.palette).toBe("prism");
    kept.appearance.figureColours = "prism";
    expect(migrateSettings(JSON.parse(JSON.stringify(kept))).appearance.figureColours).toBeNull();
  });
});

describe("settings handle: update saves, preview does not", () => {
  it("a colour theme pick is one saved write and Default restores the stored look", async () => {
    const h = fakeServices();
    await h.services.settings.update((x) => applyColourTheme(x.appearance, "garnet"));
    expect(h.saved).toHaveLength(1);
    expect(h.services.settings.value.appearance.figureColours).toBe("garnet");
    expect(h.services.settings.value.appearance.palette).toBe("prism");
    await h.services.settings.update((x) => applyColourTheme(x.appearance, "default"));
    expect(h.services.settings.value.appearance.figureColours).toBeNull();
    expect(h.services.settings.value.appearance.palette).toBe("prism");
    expect(h.services.settings.value.appearance.stage).toBe("follow");
  });

  it("a preview shows a theme without saving it, and ending it brings the stored one back", () => {
    const h = fakeServices();
    const before = h.services.settings.value;
    h.services.settings.preview?.((x) => applyColourTheme(x.appearance, "sapphire"));
    expect(h.services.settings.value.appearance.figureColours).toBe("sapphire");
    h.services.settings.preview?.((x) => applyColourTheme(x.appearance, "default"));
    expect(h.services.settings.value.appearance.figureColours).toBeNull();
    h.services.settings.endPreview?.();
    expect(h.services.settings.value).toBe(before);
    expect(h.saved).toHaveLength(0);
  });

  it("an update during a preview works on the stored settings, not the previewed ones", async () => {
    const h = fakeServices();
    h.services.settings.preview?.((x) => applyColourTheme(x.appearance, "orchid"));
    await h.services.settings.update((x) => void (x.appearance.glow = 1.5));
    expect(h.services.settings.value.appearance.figureColours).toBeNull();
    expect(h.services.settings.value.appearance.glow).toBe(1.5);
    expect(h.saved[0]?.appearance.figureColours).toBeNull();
  });

  it("a preview taken while an update saves ends on what was saved: the older settings never come back or get saved again", async () => {
    let finishSave: () => void = () => undefined;
    const saved: CortexSettings[] = [];
    const handle = createSettingsHandle(migrateSettingsChecked(undefined), {
      load: async () => null,
      exists: async () => false,
      save: (s) =>
        new Promise<void>((done) => {
          saved.push(s);
          finishSave = done;
        }),
      backup: async () => undefined,
    });
    const glow = handle.value.appearance.glow;
    const pending = handle.update((x) => void (x.appearance.glow = glow + 0.5));
    await new Promise((r) => setTimeout(r, 0));
    expect(saved).toHaveLength(1);
    // Showcase mode previews a colour while the file is being written.
    handle.preview?.((x) => applyColourTheme(x.appearance, "garnet"));
    finishSave();
    await pending;
    expect(handle.value.appearance.glow).toBe(glow + 0.5);
    handle.preview?.((x) => applyColourTheme(x.appearance, "sapphire"));
    expect(handle.value.appearance.glow).toBe(glow + 0.5);
    handle.endPreview?.();
    expect(handle.value.appearance.glow).toBe(glow + 0.5);
    expect(handle.value.appearance.figureColours).toBeNull();
    const next = handle.update((x) => void (x.appearance.dotSize = 1.2));
    await new Promise((r) => setTimeout(r, 0));
    finishSave();
    await next;
    expect(saved.at(-1)?.appearance.glow).toBe(glow + 0.5);
    expect(saved.at(-1)?.appearance.dotSize).toBe(1.2);
  });

  it("a preview taken while the file is re-read (a sync) ends on what was read, and lives on when the file had not changed", async () => {
    let file: unknown = null;
    let finishLoad: () => void = () => undefined;
    const handle = createSettingsHandle(migrateSettingsChecked(undefined), {
      load: () => new Promise<unknown>((done) => void (finishLoad = () => done(file))),
      exists: async () => true,
      save: async () => undefined,
      backup: async () => undefined,
    });
    const before = handle.value;
    // The same settings on disk: a preview taken meanwhile stays on screen and still goes back to them.
    file = JSON.parse(JSON.stringify(before));
    let pending = handle.reload();
    await new Promise((r) => setTimeout(r, 0));
    handle.preview?.((x) => applyColourTheme(x.appearance, "garnet"));
    finishLoad();
    await pending;
    expect(handle.value.appearance.figureColours).toBe("garnet");
    handle.endPreview?.();
    expect(handle.value).toBe(before);
    // Changed on disk (another device): what was read wins, and no later end of a preview brings the old settings back.
    file = { ...JSON.parse(JSON.stringify(before)), appearance: { ...before.appearance, glow: before.appearance.glow + 0.25 } };
    pending = handle.reload();
    await new Promise((r) => setTimeout(r, 0));
    handle.preview?.((x) => applyColourTheme(x.appearance, "verdant"));
    finishLoad();
    await pending;
    expect(handle.value.appearance.glow).toBe(before.appearance.glow + 0.25);
    handle.preview?.((x) => applyColourTheme(x.appearance, "saffron"));
    handle.endPreview?.();
    expect(handle.value.appearance.glow).toBe(before.appearance.glow + 0.25);
    expect(handle.value.appearance.figureColours).toBeNull();
  });
});

function renderIn(h: FakeHarness, node: preact.ComponentChild): string {
  return render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>{node}</LeafContext.Provider>
    </ServicesContext.Provider>,
  );
}

describe("the theme button and its menu", () => {
  it("sits in both hosts' top-right tool buttons", () => {
    const h = fakeServices();
    expect(renderIn(h, <ToolColumn />)).toContain(`aria-label="${COPY.tools.theme}"`);
    expect(renderIn(h, <StageCluster />)).toContain(`aria-label="${COPY.tools.theme}"`);
  });

  it("opens a swatch menu of Default and the colour themes with the one in force checked", async () => {
    const h = fakeServices();
    let html = renderIn(h, <ThemePopover />);
    for (const id of COLOUR_THEME_IDS) expect(html).toContain(`data-colour-theme="${id}"`);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    await h.services.settings.update((x) => applyColourTheme(x.appearance, "verdant"));
    html = renderIn(h, <ThemePopover />);
    const on = /<button[^>]*is-on[^>]*>/.exec(html)?.[0] ?? "";
    expect(on).toContain('data-colour-theme="verdant"');
  });

  it("draws data colours only: no theme ground or window accent, and a pick leaves the window settings alone", async () => {
    const h = fakeServices();
    const html = renderIn(h, <ThemePopover />);
    expect(html).not.toContain("--sw-ground");
    expect(html).toContain("--sw-accent");
    const before = { stage: h.services.settings.value.appearance.stage, tint: h.services.settings.value.appearance.stageTint };
    pickColourTheme(h.services, "sapphire");
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const a = h.services.settings.value.appearance;
    expect({ stage: a.stage, tint: a.stageTint }).toEqual(before);
    expect(a.figureColours).toBe("sapphire");
    expect(a.palette).toBe("prism");
  });

  it("the theme popover is a popover id the store accepts", () => {
    const h = fakeServices();
    A.openPopover(h.leaf.store, "themes");
    expect(h.leaf.store.get("ui").popover).toBe("themes");
  });
});

// ───────────────────────────── Showcase mode ─────────────────────────────

const key = (k: string, extra: Partial<ChordKey> = {}): ChordKey => ({ key: k, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...extra });

describe("the chord", () => {
  it("fires on Ctrl+0 then Ctrl+9 within a second, and Ctrl+0 alone only arms", () => {
    const c = createChord();
    expect(c.feed(key("0"), 0)).toBe("arm");
    expect(c.feed(key("9"), 400)).toBe("fire");
    expect(c.feed(key("9"), 500)).toBe("reset");
  });
  it("lets the window lapse, and a key between the two cancels it", () => {
    const c = createChord();
    c.feed(key("0"), 0);
    expect(c.feed(key("9"), CHORD_WINDOW_MS + 1)).toBe("reset");
    c.feed(key("0"), 5000);
    expect(c.feed(key("x"), 5100)).toBe("reset");
    expect(c.feed(key("9"), 5200)).toBe("reset");
  });
  it("ignores the modifier keys themselves and key repeat, and needs a plain Ctrl", () => {
    const c = createChord();
    c.feed(key("0"), 0);
    expect(c.feed(key("Control"), 100)).toBe("ignore");
    expect(c.feed(key("0", { repeat: true }), 150)).toBe("ignore");
    expect(c.feed(key("9", { shiftKey: true }), 200)).toBe("reset");
    c.feed(key("0"), 300);
    expect(c.feed(key("9", { altKey: true }), 400)).toBe("reset");
    c.feed(key("0", { ctrlKey: false, metaKey: true }), 500);
    expect(c.feed(key("9", { ctrlKey: false, metaKey: true }), 600)).toBe("fire");
  });
  it("reads the digit from the physical key too", () => {
    const c = createChord();
    expect(c.feed(key("a", { code: "Digit0" }), 0)).toBe("arm");
    expect(c.feed(key("b", { code: "Digit9" }), 10)).toBe("fire");
  });
});

const ENV: ShowcaseEnv = {
  layouts: offeredLayouts(),
  charts: offeredCharts(),
  themes: ["garnet", "sapphire", "verdant", "saffron", "orchid", "default"],
  areas: ["claude-code", "vault"] as unknown as SpaceId[],
};

function fakeWindowShell(): { shell: Shell; press: (k: string, extra?: object) => void; click: () => void; listeners: () => number } {
  const handlers = new Map<string, Set<(e: unknown) => void>>();
  const win = {
    setTimeout: (f: () => void, ms: number) => globalThis.setTimeout(f, ms) as unknown as number,
    clearTimeout: (id: number) => globalThis.clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
  };
  const doc = {
    defaultView: win,
    activeElement: null,
    addEventListener: (n: string, f: (e: unknown) => void) => {
      if (!handlers.has(n)) handlers.set(n, new Set());
      handlers.get(n)?.add(f);
    },
    removeEventListener: (n: string, f: (e: unknown) => void) => void handlers.get(n)?.delete(f),
  };
  const shell = new Shell("test-leaf");
  shell.root = { isConnected: true, ownerDocument: doc, getClientRects: () => [{}] } as unknown as HTMLElement;
  const fire = (name: string, e: object) => {
    const ev = { preventDefault: vi.fn(), stopPropagation: vi.fn(), repeat: false, ...e };
    for (const f of [...(handlers.get(name) ?? [])]) f(ev);
    return ev;
  };
  return {
    shell,
    press: (k, extra = {}) => void fire("keydown", { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...extra }),
    click: () => void fire("pointerdown", {}),
    listeners: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  };
}

describe("running the tour", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("moves the view on a timer, then any key stops it and puts everything back exactly", async () => {
    const h = fakeServices();
    const { shell, press, listeners } = fakeWindowShell();
    const store = h.leaf.store;
    // A view with something to lose: a look, a popover.
    A.setLook(store, { names: "always" });
    A.openPopover(store, "key");
    const before = JSON.stringify(store.snapshot());
    const bus: string[] = [];
    for (const n of ["camera:save", "camera:restore", "intro:play"] as const) h.services.bus.on(n, () => void bus.push(n));
    const steps = buildShowcase({ ...ENV, areas: [] });
    expect(startShowcase(h.services, h.leaf, shell, steps)).toBe(true);
    expect(showcaseRunning(shell)).toBe(true);
    expect(bus).toContain("camera:save");
    // The first step is the growth, with no start screen before it: the points scatter and assemble on the next tick.
    expect(steps[0]?.id).toBe("open-grow");
    await vi.advanceTimersByTimeAsync(1);
    expect(bus).toContain("intro:play");
    await vi.advanceTimersByTimeAsync(3000);
    expect(JSON.stringify(store.snapshot())).not.toBe(before);
    const states = new Set<string>();
    for (let i = 0; i < 80; i++) {
      await vi.advanceTimersByTimeAsync(500);
      states.add(JSON.stringify(store.get("view")) + JSON.stringify(store.get("ui").popover) + JSON.stringify(store.get("ui").sheet.open));
    }
    expect(states.size).toBeGreaterThan(12);
    press("x");
    expect(showcaseRunning(shell)).toBe(false);
    expect(JSON.stringify(store.snapshot())).toBe(before);
    // The camera goes back once the body it returns to has been laid out again (a moment after the store).
    await vi.advanceTimersByTimeAsync(100);
    expect(bus).toContain("camera:restore");
    expect(listeners()).toBe(0);
    // Stopped for good: no more steps.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(JSON.stringify(store.snapshot())).toBe(before);
  });

  it("is read-only: the colour themes are previewed, never saved, and the stored settings come back", async () => {
    const h = fakeServices();
    const { shell, press } = fakeWindowShell();
    const stored = h.services.settings.value;
    const steps = buildShowcase({ ...ENV, layouts: [], charts: [], areas: [] });
    startShowcase(h.services, h.leaf, shell, steps);
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      await vi.advanceTimersByTimeAsync(500);
      seen.add(`${h.services.settings.value.appearance.figureColours}|${h.services.settings.value.appearance.palette}`);
    }
    expect(seen.size).toBeGreaterThan(2);
    expect(h.saved).toHaveLength(0);
    press("Escape");
    expect(h.services.settings.value).toBe(stored);
    expect(h.saved).toHaveLength(0);
  });

  it("a click stops it; modifier keys alone do not", async () => {
    const h = fakeServices();
    const { shell, press, click } = fakeWindowShell();
    startShowcase(h.services, h.leaf, shell, buildShowcase({ ...ENV, areas: [] }));
    await vi.advanceTimersByTimeAsync(1000);
    press("Control", { ctrlKey: true });
    press("Shift");
    expect(showcaseRunning(shell)).toBe(true);
    click();
    expect(showcaseRunning(shell)).toBe(false);
  });

  it("a key right after it starts does not stop it (the held 9 repeating)", () => {
    const h = fakeServices();
    const { shell, press } = fakeWindowShell();
    startShowcase(h.services, h.leaf, shell, buildShowcase({ ...ENV, areas: [] }));
    press("9", { ctrlKey: true });
    expect(showcaseRunning(shell)).toBe(true);
    stopShowcase(shell);
    expect(showcaseRunning(shell)).toBe(false);
  });

  it("will not start twice, and the tour of a real record is built from the services", () => {
    const h = fakeServices();
    const { shell } = fakeWindowShell();
    const steps = buildShowcase({ ...ENV, areas: [] });
    expect(startShowcase(h.services, h.leaf, shell, steps)).toBe(true);
    expect(startShowcase(h.services, h.leaf, shell, steps)).toBe(false);
    stopShowcase(shell);
    const env = showcaseEnv(h.services);
    expect(env.themes).toContain("garnet");
    expect(env.layouts.length).toBeGreaterThan(0);
    expect(env.areas).toEqual([]);
  });

  it("the chord starts it from a fresh Ctrl+0 Ctrl+9 only, and a stop key does not restart it", async () => {
    const h = fakeServices();
    const { shell, press } = fakeWindowShell();
    let t0 = 0;
    const off = installShowcaseKeys(h.services, h.leaf, shell, { owns: () => true, now: () => t0 });
    press("0", { ctrlKey: true });
    expect(showcaseRunning(shell)).toBe(false);
    t0 = 300;
    press("9", { ctrlKey: true });
    expect(showcaseRunning(shell)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    // Ctrl+0 while it runs is a key like any other: it stops the tour, and the 9 that follows does not start it again.
    t0 = 1500;
    press("0", { ctrlKey: true });
    expect(showcaseRunning(shell)).toBe(false);
    t0 = 1600;
    press("9", { ctrlKey: true });
    expect(showcaseRunning(shell)).toBe(false);
    off();
  });

  it("does nothing when this view does not own the keyboard", () => {
    const h = fakeServices();
    const { shell, press } = fakeWindowShell();
    installShowcaseKeys(h.services, h.leaf, shell, { owns: () => false });
    press("0", { ctrlKey: true });
    press("9", { ctrlKey: true });
    expect(showcaseRunning(shell)).toBe(false);
  });
});

describe("the command and the View menu", () => {
  it("registers Showcase mode as a command and in Cortex Desktop's View menu", () => {
    expect(COMMAND_IDS).toContain("showcase");
    expect(menuCommandIds(desktopMenu())).toContain("showcase");
    const view = desktopMenu().find((n) => n.kind === "submenu" && n.label === COPY.desktopMenu.view);
    expect(JSON.stringify(view)).toContain(COPY.desktopMenu.showcase);
  });
});
