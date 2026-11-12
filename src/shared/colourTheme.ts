/**
 * Figure colour themes. One pick recolours ONLY what the renderer draws for the figure's particles: the brain's points,
 * the spine and its age ramp, the body and nerve fibres, the haze and the record dots (also when the figure is in a
 * Groups or chart form). Nothing else follows it: not the window theme, the stage ground, the accent, the rail, the key
 * and legend dots, the time strip, the panels, the charts' axes, labels and chips, or the Settings window. A theme is
 * a tint palette (shared/palette.ts TINT_PALETTES) and its hue, which the figure's age ramp follows; it is stored in its
 * own setting, `appearance.figureColours` (a theme id, or null for no override), which only the render pipeline reads.
 * `appearance.palette` and `.ageColours` keep meaning the person's own data colours for everything else. Pure: no DOM,
 * no settings handle.
 */
import { TINT_HUE, TINT_IDS, type TintId } from "./palette";
import type { AgeColours, CortexSettings, PaletteId } from "./settings";

export type ColourThemeId = "default" | TintId;
export type Appearance = CortexSettings["appearance"];

export interface ColourTheme {
  id: ColourThemeId;
  /** The tint palette this theme uses for the data (null for Default). */
  palette: TintId | null;
  /** OKLCH hue of the age ramp (null for Default). */
  hue: number | null;
}

/** Default first, then the colour themes in the order the menu lists them. */
export const COLOUR_THEMES: readonly ColourTheme[] = [
  { id: "default", palette: null, hue: null },
  ...TINT_IDS.map((id): ColourTheme => ({ id, palette: id, hue: TINT_HUE[id] })),
];

export const COLOUR_THEME_IDS: readonly ColourThemeId[] = COLOUR_THEMES.map((c) => c.id);

export function colourThemeById(id: ColourThemeId): ColourTheme {
  return COLOUR_THEMES.find((c) => c.id === id) ?? (COLOUR_THEMES[0] as ColourTheme);
}

/** The colour theme in force: the stored figure theme, else Default. */
export function activeColourTheme(a: Pick<Appearance, "figureColours">): ColourThemeId {
  return TINT_IDS.find((id) => id === a.figureColours) ?? "default";
}

/** The palette the figure's particles are drawn with: the theme's tint palette, else the person's own data palette. */
export function figurePalette(a: Pick<Appearance, "palette" | "figureColours">): PaletteId {
  return a.figureColours ?? a.palette;
}

type AgeRamp = { mode: AgeColours; tintHue: number | null; chroma: number };

/** How the age ramp is drawn for everything that is not the figure (the key's gradient, the time strip): the person's own, never a theme's. */
export function ageOptions(a: Pick<Appearance, "ageColours" | "stageTint">): AgeRamp {
  return { mode: a.ageColours, tintHue: a.stageTint, chroma: 0.02 };
}

/**
 * How the age ramp is drawn on the figure (the spine, the record dots, the notes by age): a colour theme draws it at its
 * own hue and a clear chroma, dark to bright; otherwise it is the person's own (`ageOptions`).
 */
export function figureAgeOptions(a: Pick<Appearance, "ageColours" | "stageTint" | "figureColours">): AgeRamp {
  const theme = colourThemeById(activeColourTheme(a));
  if (theme.hue !== null) return { mode: "lightness", tintHue: theme.hue, chroma: 0.1 };
  return ageOptions(a);
}

/** The figure-only part of the grouping request: the palette and age ramp the particles use, or undefined without a theme (the own ones apply). */
export function figureOverride(a: Pick<Appearance, "palette" | "ageColours" | "stageTint" | "figureColours">): { palette: PaletteId; age: AgeRamp } | undefined {
  if (a.figureColours === null) return undefined;
  return { palette: figurePalette(a), age: figureAgeOptions(a) };
}

/** Write a colour theme into a settings draft (the body of `settings.update`): the figure setting only. */
export function applyColourTheme(a: Appearance, id: ColourThemeId): void {
  a.figureColours = colourThemeById(id).palette;
}
