/**
 * Settings > Appearance, moved out of settingsTab.ts so the two can change independently. The tab passes itself in
 * as `AppearanceHost` (its row helpers and the element the section builds into).
 *
 * Window theme: a grid of cards (stage ground, chrome bar, five dots in the active data palette, accent chip, name).
 * Data colours: one row of palette swatches (an eight-slot ramp each) with Age colours as a segmented control under it.
 * What the figure draws: four described switches. Then the rest of the controls as rows.
 */
import type { CortexSettings, PaletteId, StageId } from "../shared/settings";
import { SETTING_RANGES } from "../shared/settings";
import { activeColourTheme, applyColourTheme, COLOUR_THEMES } from "../shared/colourTheme";
import { paletteDots, paletteRamp, themeCardsFor } from "../shared/palette";
import { SETTINGS_COPY, t, type CopyKey } from "../ui/copy";

/** What the Appearance section needs from the settings tab. */
export interface AppearanceHost {
  /** The element rows are built into. */
  readonly mount: HTMLElement;
  /** True in Cortex Desktop (no Obsidian theme to follow, so no Follow theme card). */
  readonly desktopHost: boolean;
  set(patch: (s: CortexSettings) => void): void;
  refresh(): void;
  row(name: string, desc?: string): import("obsidian").Setting;
  toggle(name: string, desc: string | undefined, value: boolean, apply: (s: CortexSettings, v: boolean) => void, disabled?: boolean): void;
  dropdown<V extends string>(name: string, desc: string | undefined, options: Record<V, string>, value: V, apply: (s: CortexSettings, v: V) => void, rerender?: boolean): void;
  slider(name: string, desc: string | undefined, range: readonly [number, number], step: number, value: number, apply: (s: CortexSettings, v: number) => void): void;
}

/** The data palettes in swatch order. */
export const PALETTE_ORDER: readonly PaletteId[] = ["prism", "signal", "harbor", "orchard", "ember", "reef", "print"];

/** The control to focus after the section re-renders (a radio group the keyboard just moved within). */
let restoreFocus: string | null = null;

export function renderAppearance(h: AppearanceHost, s: CortexSettings): void {
  const c = SETTINGS_COPY.appearance;
  const p = s.appearance;
  h.mount.createEl("p", { cls: "cx-note", text: c.defaultsDesc });
  themeCards(h, p.stage, p.palette);
  colourThemes(h, p);
  h.dropdown(c.tint, undefined, { off: c.tintOff, on: c.tintHue }, p.stageTint === null ? "off" : "on", (x, v) => void (x.appearance.stageTint = v === "off" ? null : x.appearance.stageTint ?? 210), true);
  if (p.stageTint !== null) h.slider(c.tintHue, undefined, [0, 359], 1, p.stageTint, (x, v) => void (x.appearance.stageTint = v));
  dataColours(h, p.palette, p.ageColours);
  figureDraws(h, s);
  h.toggle(c.frosted, c.frostedDesc, p.frosted, (x, v) => void (x.appearance.frosted = v));
  h.toggle(c.patterns, undefined, p.patterns, (x, v) => void (x.appearance.patterns = v));
  h.dropdown(c.motion, undefined, { system: c.followSystem, reduced: c.reduced, full: c.full }, p.motion, (x, v) => void (x.appearance.motion = v));
  h.toggle(c.animatePages, c.animatePagesDesc, p.animatePageChanges, (x, v) => void (x.appearance.animatePageChanges = v));
  h.toggle(c.collapseOnLeave, c.collapseOnLeaveDesc, p.collapseOnLeave, (x, v) => void (x.appearance.collapseOnLeave = v));
  h.toggle(c.chartCard, c.chartCardDesc, p.chartCard, (x, v) => void (x.appearance.chartCard = v));
  h.slider(c.dotSize, undefined, SETTING_RANGES.dotSize, 0.1, p.dotSize, (x, v) => void (x.appearance.dotSize = v));
  h.slider(c.glow, undefined, SETTING_RANGES.glow, 0.1, p.glow, (x, v) => void (x.appearance.glow = v));
  h.slider(c.brightness, undefined, SETTING_RANGES.brightness, 0.05, p.brightness, (x, v) => void (x.appearance.brightness = v));
  h.dropdown(c.strip, undefined, { log: c.log, linear: c.linear }, p.stripScale, (x, v) => void (x.appearance.stripScale = v));
  if (restoreFocus) {
    h.mount.querySelector?.<HTMLElement>(`[data-focus-key="${restoreFocus}"]`)?.focus();
    restoreFocus = null;
  }
}

/** The index the arrow keys move a radio group's choice to (wrapping); null for other keys. Exported for tests. */
export function radioStep(count: number, index: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Radio semantics for a row of buttons: one tab stop (the chosen one), arrow keys choose, a click chooses. */
function radio(group: HTMLElement, button: HTMLElement, key: string, on: boolean, pick: () => void): void {
  button.setAttr("type", "button");
  button.setAttr("role", "radio");
  button.setAttr("aria-checked", String(on));
  button.setAttr("data-focus-key", key);
  button.tabIndex = on ? 0 : -1;
  button.addEventListener("click", () => {
    restoreFocus = key;
    pick();
  });
  button.addEventListener("keydown", (e) => {
    const all = Array.from(group.querySelectorAll<HTMLElement>("[role='radio']"));
    const next = radioStep(all.length, all.indexOf(button), e.key);
    if (next === null) return;
    e.preventDefault();
    all[next]?.click();
  });
}

/** The window theme as selectable cards; one is chosen and a click restyles the window at once. */
function themeCards(h: AppearanceHost, current: StageId, palette: PaletteId): void {
  const c = SETTINGS_COPY.appearance;
  h.row(c.stage, c.themeDesc);
  const grid = h.mount.createEl("div", { cls: "cx-theme-cards" });
  grid.setAttr("role", "radiogroup");
  grid.setAttr("aria-label", c.stage);
  const names: Record<StageId, string> = { follow: c.followTheme, ink: c.ink, paper: c.paper, vesper: c.vesper, lichen: c.lichen, copper: c.copper, cobalt: c.cobalt, flint: c.flint, garnet: c.garnet };
  // Cortex Desktop has no theme of its own to follow: Follow reads as Ink there.
  const shown: StageId = h.desktopHost && current === "follow" ? "ink" : current;
  for (const card of themeCardsFor(!h.desktopHost)) {
    const on = card.id === shown;
    const b = grid.createEl("button", { cls: on ? "cx-theme-card is-on" : "cx-theme-card" });
    const dots = paletteDots(palette, 5, card.id === "paper");
    b.setAttr("data-theme-card", card.id);
    b.setAttr("style", `--sw-stage:${card.stage};--sw-lift:${card.lift};--sw-chrome:${card.chrome};--sw-accent:${card.accent};--sw-ink:${card.id === "paper" ? "#1b1b1b" : "#f2f2f2"};${dots.map((d, i) => `--sw-d${i + 1}:${d}`).join(";")}`);
    const sw = b.createEl("span", { cls: "cx-theme-swatch" });
    sw.createEl("span", { cls: "cx-theme-bar" });
    const row = sw.createEl("span", { cls: "cx-theme-dots" });
    for (let i = 0; i < 5; i++) row.createEl("i");
    sw.createEl("span", { cls: "cx-theme-line" });
    sw.createEl("span", { cls: "cx-theme-line is-short" });
    sw.createEl("span", { cls: "cx-theme-chip" });
    b.createEl("span", { cls: "cx-theme-name", text: names[card.id] });
    radio(grid, b, `theme:${card.id}`, on, () => {
      h.set((x) => void (x.appearance.stage = card.id));
      h.refresh();
    });
  }
}

/** Figure colour themes: one row of swatches (the theme's eight-slot ramp, its name under it); a pick writes only the figure colours setting; the Data colours below are untouched. */
function colourThemes(h: AppearanceHost, p: CortexSettings["appearance"]): void {
  const c = SETTINGS_COPY.appearance;
  const active = activeColourTheme(p);
  h.row(c.colourTheme, c.colourThemeDesc);
  const group = h.mount.createEl("div", { cls: "cx-palette-row cx-colour-theme-row" });
  group.setAttr("role", "radiogroup");
  group.setAttr("aria-label", c.colourTheme);
  for (const theme of COLOUR_THEMES) {
    const on = theme.id === active;
    const b = group.createEl("button", { cls: on ? "cx-palette-swatch is-on" : "cx-palette-swatch" });
    b.setAttr("data-colour-theme", theme.id);
    const ramp = b.createEl("span", { cls: "cx-palette-ramp" });
    ramp.setAttr("style", `background:${paletteRamp(theme.palette ?? p.palette)}`);
    b.createEl("span", { cls: "cx-palette-name", text: t(`colourThemes.${theme.id}` as CopyKey) });
    radio(group, b, `colour-theme:${theme.id}`, on, () => {
      h.set((x) => applyColourTheme(x.appearance, theme.id));
      h.refresh();
    });
  }
}

/** One row of palette swatches (an eight-slot ramp each, the name under it), with Age colours under the row. */
function dataColours(h: AppearanceHost, current: PaletteId, age: CortexSettings["appearance"]["ageColours"]): void {
  const c = SETTINGS_COPY.appearance;
  h.row(c.dataColours);
  const names: Partial<Record<PaletteId, string>> = { prism: c.prism, signal: c.signal, harbor: c.harbor, orchard: c.orchard, ember: c.ember, reef: c.reef, print: c.print };
  const group = h.mount.createEl("div", { cls: "cx-palette-row" });
  group.setAttr("role", "radiogroup");
  group.setAttr("aria-label", c.dataColours);
  for (const id of PALETTE_ORDER) {
    const on = id === current;
    const b = group.createEl("button", { cls: on ? "cx-palette-swatch is-on" : "cx-palette-swatch" });
    b.setAttr("data-palette", id);
    const ramp = b.createEl("span", { cls: id === "print" ? "cx-palette-ramp is-print" : "cx-palette-ramp" });
    ramp.setAttr("style", `background:${paletteRamp(id)}`);
    b.createEl("span", { cls: "cx-palette-name", text: names[id] ?? id });
    radio(group, b, `palette:${id}`, on, () => {
      h.set((x) => void (x.appearance.palette = id));
      h.refresh();
    });
  }
  h.mount.createEl("p", { cls: "cx-note", text: current === "print" ? `${c.dataColoursNote} ${c.printNote}` : c.dataColoursNote });
  const row = h.row(c.ageColours);
  const seg = row.controlEl.createEl("div", { cls: "cx-age-seg" });
  seg.setAttr("role", "radiogroup");
  seg.setAttr("aria-label", c.ageColours);
  for (const [id, label] of [["hue", c.hueAndLightness], ["lightness", c.lightnessOnly]] as const) {
    const b = seg.createEl("button", { cls: id === age ? "cx-age-seg-item is-on" : "cx-age-seg-item", text: label });
    radio(seg, b, `age:${id}`, id === age, () => {
      h.set((x) => void (x.appearance.ageColours = id));
      h.refresh();
    });
  }
}

/** The four switches for what is painted over the figure, each with a grey line of explanation. */
function figureDraws(h: AppearanceHost, s: CortexSettings): void {
  const c = SETTINGS_COPY.appearance;
  const p = s.appearance;
  const forced = p.palette === "print";
  h.row(c.draws, c.drawsDesc).setHeading();
  h.row(c.links, c.linksDesc).addToggle((tg) =>
    tg.setValue(p.lines !== "off").onChange((v) => {
      h.set((x) => void (x.appearance.lines = v ? "selection" : "off"));
      h.refresh();
    }),
  );
  if (p.lines !== "off") h.toggle(c.linksSelection, undefined, p.lines === "selection", (x, v) => void (x.appearance.lines = v ? "selection" : "all"));
  h.toggle(c.threads, c.threadsDesc, p.stems, (x, v) => void (x.appearance.stems = v));
  h.row(c.namesOver, c.namesOverDesc).addToggle((tg) =>
    tg.setValue(forced || p.namesOnFigure !== "off").setDisabled(forced).onChange((v) => {
      h.set((x) => void (x.appearance.namesOnFigure = !v ? "off" : x.appearance.namesAtRest ? "always" : "hover"));
      h.refresh();
    }),
  );
  h.row(c.namesRest, c.namesRestDesc).addToggle((tg) =>
    tg.setValue(forced || (p.namesAtRest && p.namesOnFigure !== "off")).setDisabled(forced).onChange((v) => {
      h.set((x) => {
        x.appearance.namesAtRest = v;
        if (v && x.appearance.namesOnFigure === "hover") x.appearance.namesOnFigure = "always";
        else if (!v && x.appearance.namesOnFigure === "always") x.appearance.namesOnFigure = "hover";
        else if (v && x.appearance.namesOnFigure === "off") x.appearance.namesOnFigure = "always";
      });
      h.refresh();
    }),
  );
}
