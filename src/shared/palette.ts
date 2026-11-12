/**
 * Data palettes, ramps and stages (CORTEX-UX §4.3–4.5, §12.3). Owner: E11. Pure: used by the worker (colour
 * buffers), the renderer and the UI. Every value here equals the one checked by docs/mockups/src/palette_check.py
 * (accessibility, the 5 ΔE originality floor and the counterpart-set rule); tests/originality.test.ts parses that
 * script and fails the build if this file drifts from it, and runs it when Python is available.
 *
 * Shipped: Prism (default) and Signal (colour-blind first), Harbor and Orchard (colour-blind first), Ember and Reef,
 * plus Print, a computed mode (four brown-black ink
 * greys × solid / 45° hatch) that forces the Paper stage and names on the figure. Stages: Ink and Paper (+ "Follow
 * theme") with an optional Stage tint hue. Remainders: Other = mist, No value = slate; WHITE IS NEVER A DATA
 * COLOUR (hover, selection and birth flashes only). The age ramp rises in lightness (newest is brightest).
 */
import type { AgeColours, PaletteId, StageId } from "./settings";

export type Rgb = readonly [number, number, number];
export type Variant = "glow" | "fill" | "light";

export interface PaletteDef {
  id: PaletteId;
  /** Particles and stage keys on a dark stage. */
  glow: readonly string[];
  /** 2D marks on the dark chrome (Time page, Data view). */
  fill: readonly string[];
  /** Paper stage and light chrome. */
  light: readonly string[];
  /** Print draws on Paper with pattern fills and names on the figure. */
  forcesPaper: boolean;
  patterns: boolean;
  /** Print turns "Names on the figure" to Always (particles cannot carry a hatch). */
  forcesNames: boolean;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(rgb: Rgb): string {
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, "0");
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

/** A typed colour as "#rrggbb" (lower case): accepts "#abc", "#aabbcc" and the same without the "#"; null when it is not a hex colour. */
export function normaliseHex(input: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m?.[1]) return null;
  const h = m[1].toLowerCase();
  return `#${h.length === 3 ? h.split("").map((c) => c + c).join("") : h}`;
}

/** sRGB (0..1) → OKLab. */
export function srgbToOklab(rgb: Rgb): [number, number, number] {
  const r = toLinear(rgb[0]), g = toLinear(rgb[1]), b = toLinear(rgb[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → sRGB (0..1, clamped). */
export function oklabToSrgb(lab: readonly [number, number, number]): Rgb {
  const [L, a, b] = lab;
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  return [
    clamp(toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clamp(toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clamp(toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

/** OKLab ΔE × 100 between two hex colours (the unit used by every palette check). */
export function deltaE(a: string, b: string): number {
  const p = srgbToOklab(hexToRgb(a));
  const q = srgbToOklab(hexToRgb(b));
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Interpolate a list of hex stops in OKLab at f ∈ [0, 1]. */
export function rampAt(stops: readonly string[], f: number): Rgb {
  if (stops.length === 0) return hexToRgb(NO_VALUE.glow);
  if (stops.length === 1) return hexToRgb(stops[0] ?? NO_VALUE.glow);
  const x = Math.max(0, Math.min(1, f)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const a = srgbToOklab(hexToRgb(stops[i] ?? NO_VALUE.glow));
  const b = srgbToOklab(hexToRgb(stops[i + 1] ?? NO_VALUE.glow));
  const u = x - i;
  return oklabToSrgb([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
}

// ───────────────────────────── categorical palettes (§4.4) ─────────────────────────────

/** Prism slot order: azure, amber, rose, citron, teal, coral, violet, mint (you = amber, assistant = violet). */
export const PRISM_NAMES = ["azure", "amber", "rose", "citron", "teal", "coral", "violet", "mint"] as const;

/** Print: OKLab lightness of the four ink greys and the slot → (grey, fill) assignment (§4.4). */
export const PRINT_LIGHTNESS: readonly number[] = [0.3, 0.42, 0.54, 0.66];
export const PRINT_SLOTS: readonly (readonly [number, "solid" | "hatch"])[] = [
  [0, "solid"], [2, "hatch"], [1, "solid"], [3, "hatch"], [2, "solid"], [0, "hatch"], [3, "solid"], [1, "hatch"],
];
const PRINT_HUE = (15 * Math.PI) / 180;
export const PRINT_GREYS: readonly string[] = PRINT_LIGHTNESS.map((L) => rgbToHex(oklabToSrgb([L, 0.02 * Math.cos(PRINT_HUE), 0.02 * Math.sin(PRINT_HUE)])));
const PRINT_STOPS = PRINT_SLOTS.map(([g]) => PRINT_GREYS[g] ?? "#584949");

export const PALETTES: readonly PaletteDef[] = [
  {
    id: "prism",
    glow: ["#7ab9fd", "#deb125", "#f58ebc", "#cbd871", "#2eeafd", "#e6ac86", "#c4a9ff", "#6ad39a"],
    fill: ["#5293ed", "#cd8000", "#d35e9a", "#9d9900", "#00a0ad", "#d95833", "#9875e3", "#09a773"],
    light: ["#156ec3", "#a56500", "#b84580", "#878300", "#0090a4", "#c5482c", "#864fc2", "#008c5f"],
    forcesPaper: false,
    patterns: false,
    forcesNames: false,
  },
  {
    id: "signal",
    glow: ["#dfb748", "#f487c5", "#cddb78", "#a2cffe", "#f17731", "#169ad6", "#3fd399"],
    fill: ["#dfb748", "#f487c5", "#cddb78", "#a2cffe", "#f17731", "#169ad6", "#3fd399"],
    light: ["#b17a00", "#b6508c", "#ada200", "#0f9bd7", "#b54f02", "#005d92", "#008a64"],
    forcesPaper: false,
    patterns: false,
    forcesNames: false,
  },
  // Harbor and Orchard are colour-blind first (neighbouring slots stay 8+ dE apart under protan and deutan vision); Ember
  // and Reef trade that for a warmer or cooler mood. All four keep 5+ dE from every colour the recordings show.
  {
    id: "harbor",
    glow: ["#749dff", "#d3b047", "#00b786", "#ffbef9", "#8ea442", "#b99bfe", "#04ecff", "#e97996"],
    fill: ["#7596ff", "#cd6d0c", "#669e68", "#e475c6", "#a8a835", "#b35ee1", "#2aafb3", "#db8176"],
    light: ["#005d9c", "#c63e00", "#1f7c60", "#a25aa9", "#5b4c00", "#51448d", "#005a5a", "#a0696b"],
    forcesPaper: false,
    patterns: false,
    forcesNames: false,
  },
  {
    id: "orchard",
    glow: ["#ba7ec4", "#ffd19f", "#a9b33d", "#04ada6", "#a6b2ff", "#f37ba4", "#e354a9", "#c38304"],
    fill: ["#dc89d3", "#cb7100", "#5d986a", "#1bc79e", "#0095b7", "#dd807b", "#c462b8", "#ba9600"],
    light: ["#93609f", "#66461e", "#007b2c", "#007772", "#245197", "#9a3a00", "#a8046e", "#997401"],
    forcesPaper: false,
    patterns: false,
    forcesNames: false,
  },
  {
    id: "ember",
    glow: ["#f95fa6", "#cba100", "#d07b04", "#f6b2e4", "#e18cc6", "#15b1a4", "#8ca54d", "#e8ab74"],
    fill: ["#e37f7e", "#9c874e", "#a89f00", "#f470c0", "#bd6acf", "#22a3aa", "#70b586", "#d06d18"],
    light: ["#a93f00", "#9b6f52", "#786700", "#8c5979", "#653b8d", "#207c66", "#00750d", "#6d4200"],
    forcesPaper: false,
    patterns: false,
    forcesNames: false,
  },
  {
    id: "reef",
    glow: ["#04ecff", "#4ab981", "#a8ceff", "#d494e3", "#00afb7", "#b5a748", "#ffb4dd", "#7caeee"],
    fill: ["#0097aa", "#7f8f4b", "#90a3ff", "#c986d8", "#00ad56", "#b98400", "#ad67d6", "#15b6b6"],
    light: ["#007580", "#465500", "#3444a3", "#5d3a7b", "#008555", "#7d601b", "#9f006e", "#005a5a"],
    forcesPaper: false,
    patterns: false,
    forcesNames: false,
  },
  { id: "print", glow: PRINT_STOPS, fill: PRINT_STOPS, light: PRINT_STOPS, forcesPaper: true, patterns: true, forcesNames: true },
];

/**
 * Tint palettes: the data colours of the figure colour themes (shared/colourTheme.ts). One hue each, spread over
 * eight slots by a little hue drift and a lightness pattern, so a figure coloured by them reads as one colour (red, blue,
 * green …) yet keeps neighbouring slots apart. They are not offered as Data colours cards and stay out of PALETTES (the
 * recordings check there covers the named palettes); paletteById resolves them.
 */
export const TINT_IDS = ["garnet", "sapphire", "verdant", "saffron", "orchid"] as const;
export type TintId = (typeof TINT_IDS)[number];
/** OKLCH hue (degrees) of each tint's centre. */
export const TINT_HUE: Readonly<Record<TintId, number>> = { garnet: 22, sapphire: 258, verdant: 148, saffron: 78, orchid: 322 };
const TINT_SPREAD = [0, -16, 14, -30, 28, -8, 22, -22] as const;
const TINT_LIGHTNESS: Readonly<Record<Variant, readonly number[]>> = {
  glow: [0.8, 0.66, 0.9, 0.72, 0.6, 0.84, 0.68, 0.9],
  fill: [0.68, 0.54, 0.76, 0.6, 0.48, 0.72, 0.56, 0.78],
  light: [0.5, 0.4, 0.58, 0.44, 0.36, 0.54, 0.42, 0.6],
};
const TINT_CHROMA: Readonly<Record<Variant, number>> = { glow: 0.15, fill: 0.14, light: 0.13 };
function tintSlots(hue: number, variant: Variant): string[] {
  return TINT_LIGHTNESS[variant].map((L, i) => {
    const h = ((hue + (TINT_SPREAD[i] ?? 0)) * Math.PI) / 180;
    const c = TINT_CHROMA[variant];
    return rgbToHex(oklabToSrgb([L, c * Math.cos(h), c * Math.sin(h)]));
  });
}
export const TINT_PALETTES: readonly PaletteDef[] = TINT_IDS.map((id) => ({
  id,
  glow: tintSlots(TINT_HUE[id], "glow"),
  fill: tintSlots(TINT_HUE[id], "fill"),
  light: tintSlots(TINT_HUE[id], "light"),
  forcesPaper: false,
  patterns: false,
  forcesNames: false,
}));

/** At most this many hues per dimension; the rest fold into Other. */
export const MAX_HUES = 8;

/** Other (folded groups) = mist; No value (No area, Undated, No kind, No project, No map) = slate. Never white. */
export const OTHER = { glow: "#b6bbd3", fill: "#7b90a5", light: "#4a5666" } as const;
export const NO_VALUE = { glow: "#727b8a", fill: "#66686f", light: "#7e8086" } as const;

// ───────────────────────────── ramps and fixed sets (§4.5) ─────────────────────────────

/** Age ramp, oldest → newest; lightness rises monotonically on dark (falls on Paper, newest most contrast). */
export const AGE_RAMP = {
  dark: ["#866fc8", "#5890ec", "#37acc3", "#56c4a7", "#90cf82", "#cdd261", "#e1d6ba", "#f0e0c6"],
  light: ["#b1b0ed", "#82a5ec", "#229dc3", "#018d87", "#2c7f44", "#5f6700", "#734c00", "#772e00"],
} as const;

/**
 * Month ramp, oldest → newest (the month rows of the key and the figure when colouring by month): the age ramp's cool
 * run (violet, blue, cyan, teal, green, lime) with an orange then red tail, so a long record reads as a spectrum.
 * Separate from AGE_RAMP, which stays lightness-led and pinned to palette_check.py; here the hue leads.
 */
export const MONTH_RAMP = {
  dark: ["#866fc8", "#5890ec", "#37acc3", "#56c4a7", "#90cf82", "#cdd261", "#f0a35c", "#ee6a5a"],
  light: ["#b1b0ed", "#82a5ec", "#229dc3", "#018d87", "#2c7f44", "#5f6700", "#b55a00", "#b0281d"],
} as const;

/** Cortex names of the month ramp's stops, in order (for tooltips and tests; never shown as colour names in the UI). */
export const MONTH_RAMP_NAMES = ["iris", "cove", "lagoon", "jade", "meadow", "straw", "ember", "flare"] as const;

/** Count ramp (magnitude: calendar cells, matrix density, the rhythm grid): one hue, blue, low → high. */
export const COUNT_RAMP = {
  dark: ["#1e2c3f", "#004568", "#265d8e", "#3d6dc3", "#5692ec", "#73b2f8", "#abcffe"],
  light: ["#aacefc", "#92b0e6", "#5593ea", "#426ec3", "#0f62a4", "#084c81", "#0c3965"],
  emptyDark: "#1e2b38",
  emptyLight: "#e5e4d1",
} as const;

/** You ↔ assistant diverging ramp (you arm amber, assistant arm violet, grey midpoint; extremes brightest). */
export const DIVERGING = {
  dark: ["#fdd0a0", "#dcab53", "#c68128", "#4e4f58", "#926fd4", "#b295ee", "#e9baff"],
  light: ["#a36400", "#cc8730", "#e6af73", "#ccc3cb", "#bcabe6", "#9a7ad9", "#814cb7"],
} as const;

/** Agent and import states; always shown with an icon and a word. */
export const STATUS = {
  dark: { ok: "#4cc38a", warn: "#dfbc5e", serious: "#f27733", critical: "#e6737c" },
  light: { ok: "#168a5a", warn: "#a66a00", serious: "#b9541d", critical: "#ce2637" },
} as const;

/** Dotted machine rules, dashed chips and the machine avatar. */
export const MACHINE = { dark: "#b8a6ff", light: "#7b4acc" } as const;

export interface StageColours {
  stage: string;
  lift: string;
  strip: string;
}

/** Stages: Ink (dark) and Paper (light); "follow" picks by Obsidian's theme. */
export const STAGES: Readonly<Record<"ink" | "paper", StageColours>> = {
  ink: { stage: "#06070a", lift: "#0e121a", strip: "#090b10" },
  paper: { stage: "#f4f2ee", lift: "#ffffff", strip: "#efede8" },
};

export function paletteById(id: PaletteId): PaletteDef {
  return PALETTES.find((p) => p.id === id) ?? TINT_PALETTES.find((p) => p.id === id) ?? (PALETTES[0] as PaletteDef);
}

export function resolveStage(stage: StageId, obsidianDark: boolean, palette: PaletteId): "ink" | "paper" {
  if (paletteById(palette).forcesPaper) return "paper";
  if (stage === "follow") return obsidianDark ? "ink" : "paper";
  return stage === "paper" ? "paper" : "ink";
}

/** The three Cortex window themes (Settings > Appearance cards): dark stages with their own ground, lift, strip and accent. */
export type ThemeId = "vesper" | "lichen" | "copper" | "cobalt" | "flint" | "garnet";
export interface ThemeStage extends StageColours {
  accent: string;
}
export const THEME_STAGES: Readonly<Record<ThemeId, ThemeStage>> = {
  vesper: { stage: "#0a0914", lift: "#191535", strip: "#0d0b1c", accent: "#9f8cff" },
  lichen: { stage: "#06090a", lift: "#102019", strip: "#080d0b", accent: "#74cf9c" },
  copper: { stage: "#0b0705", lift: "#261811", strip: "#100a07", accent: "#f0a35f" },
  cobalt: { stage: "#05080f", lift: "#10203f", strip: "#070b14", accent: "#6ea8ff" },
  flint: { stage: "#08090a", lift: "#1d2024", strip: "#0b0c0d", accent: "#b8c0cc" },
  garnet: { stage: "#0b0607", lift: "#2b1418", strip: "#100809", accent: "#f2707c" },
};

export function isThemeId(v: unknown): v is ThemeId {
  return v === "vesper" || v === "lichen" || v === "copper" || v === "cobalt" || v === "flint" || v === "garnet";
}

/** Ground, lift and strip colours of the stage in force: a Cortex theme's own (on a dark stage), else Ink or Paper. */
export function stageColours(stage: StageId, resolved: "ink" | "paper"): StageColours {
  return resolved === "ink" && isThemeId(stage) ? THEME_STAGES[stage] : STAGES[resolved];
}

/** A hex colour as linear-light RGB (0..1), for the shader's stage uniforms. */
export function hexToLinear(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return [toLinear(r), toLinear(g), toLinear(b)];
}

/**
 * The canvas ground in Cortex Desktop: Ink is pure black, a window theme is one flat colour (its lift, which is also the
 * DOM ground in desktop-shell.css, so the rail and the stage meet without a seam), Paper keeps its own.
 */
export function desktopGround(stage: StageId, resolved: "ink" | "paper"): StageColours {
  const c = stageColours(stage, resolved);
  if (resolved !== "ink") return c;
  return isThemeId(stage) ? { ...c, stage: c.lift } : { ...c, stage: "#000000", lift: "#000000" };
}

/** The six selectable window-theme cards of Settings > Appearance, in order, each with its swatch colours (stage ground, lift glow, chrome bar, accent chip). */
export interface ThemeCard {
  id: StageId;
  stage: string;
  lift: string;
  chrome: string;
  accent: string;
}
export const THEME_CARDS: readonly ThemeCard[] = [
  { id: "follow", stage: "linear-gradient(90deg, #06070a 50%, #f4f2ee 50%)", lift: "#5a6070", chrome: "#7b7b7b", accent: "#8a5cf5" },
  { id: "ink", stage: STAGES.ink.stage, lift: STAGES.ink.lift, chrome: "#1c1c1c", accent: "#8a5cf5" },
  { id: "vesper", stage: THEME_STAGES.vesper.stage, lift: THEME_STAGES.vesper.lift, chrome: "#110e24", accent: THEME_STAGES.vesper.accent },
  { id: "lichen", stage: THEME_STAGES.lichen.stage, lift: THEME_STAGES.lichen.lift, chrome: "#0b1411", accent: THEME_STAGES.lichen.accent },
  { id: "copper", stage: THEME_STAGES.copper.stage, lift: THEME_STAGES.copper.lift, chrome: "#150d09", accent: THEME_STAGES.copper.accent },
  { id: "cobalt", stage: THEME_STAGES.cobalt.stage, lift: THEME_STAGES.cobalt.lift, chrome: "#0a1226", accent: THEME_STAGES.cobalt.accent },
  { id: "flint", stage: THEME_STAGES.flint.stage, lift: THEME_STAGES.flint.lift, chrome: "#121416", accent: THEME_STAGES.flint.accent },
  { id: "garnet", stage: THEME_STAGES.garnet.stage, lift: THEME_STAGES.garnet.lift, chrome: "#170b0d", accent: THEME_STAGES.garnet.accent },
  { id: "paper", stage: STAGES.paper.stage, lift: STAGES.paper.lift, chrome: "#ffffff", accent: "#8a5cf5" },
];

/** The cards a host offers: Follow theme only where the host has a theme of its own to follow (the Obsidian plugin). */
export function themeCardsFor(plugin: boolean): readonly ThemeCard[] {
  return plugin ? THEME_CARDS : THEME_CARDS.filter((c) => c.id !== "follow");
}

/** A palette as a left-to-right ramp of its eight slots (the Data colours swatch). Print is its four greys, stepped. */
export function paletteRamp(id: PaletteId, n = 8): string {
  const def = paletteById(id);
  const colours = (id === "print" ? PRINT_GREYS : def.glow).slice(0, n);
  return `linear-gradient(90deg, ${colours.join(", ")})`;
}

/** The first `n` slot colours of a palette (the dots on a theme card): light-variant ones on the Paper card. */
export function paletteDots(id: PaletteId, n: number, light = false): string[] {
  const def = paletteById(id);
  const src = id === "print" ? PRINT_GREYS : light ? def.light : def.glow;
  return Array.from({ length: n }, (_v, i) => src[i % src.length] ?? "#888888");
}

/** The `data-cx-theme` value for the shell (undefined for Follow, Ink, Paper, and when a palette forces Paper). */
export function themeAttr(stage: StageId, resolved: "ink" | "paper"): ThemeId | undefined {
  return resolved === "ink" && isThemeId(stage) ? stage : undefined;
}

/** Stage tint: rotate the lift (and the haze tint) toward an OKLCH hue, keeping lightness; null = Off. */
export function tintedLift(lift: string, hue: number | null, stage: "ink" | "paper" = "ink"): string {
  if (hue === null) return lift;
  const chroma = stage === "ink" ? 0.03 : 0.02;
  const [L] = srgbToOklab(hexToRgb(lift));
  const h = (hue * Math.PI) / 180;
  return rgbToHex(oklabToSrgb([L, chroma * Math.cos(h), chroma * Math.sin(h)]));
}

/** Colour of a key bucket: slot 1..8 of the palette, or the Other / No value colour. */
export function bucketColor(bucket: "value" | "other" | "none", slot: number, palette: PaletteId, variant: Variant): Rgb {
  if (bucket === "other") return hexToRgb(OTHER[variant]);
  if (bucket === "none") return hexToRgb(NO_VALUE[variant]);
  const p = paletteById(palette)[variant];
  const hex = slot >= 1 && slot <= p.length ? p[slot - 1] : undefined;
  return hexToRgb(hex ?? OTHER[variant]);
}

/**
 * Age colour from spine position τ (0 oldest → 1 newest); undefined/NaN = Undated (slate).
 * "Lightness only": the ramp's lightness with chroma 0.02 at the Stage tint hue (or the ramp's own hue).
 */
export function ageColor(tau: number | undefined, light: boolean, mode: AgeColours = "hue", tintHue: number | null = null, chroma = 0.02): Rgb {
  if (tau === undefined || Number.isNaN(tau)) return hexToRgb(light ? NO_VALUE.light : NO_VALUE.glow);
  const c = rampAt(light ? AGE_RAMP.light : AGE_RAMP.dark, tau);
  if (mode === "hue") return c;
  const [L, a, b] = srgbToOklab(c);
  const h = tintHue === null ? Math.atan2(b, a) : (tintHue * Math.PI) / 180;
  return oklabToSrgb([L, chroma * Math.cos(h), chroma * Math.sin(h)]);
}

/** The age ramp's stops as the key's gradient draws them: unchanged in "hue" mode, else the same lightness at the tint (a colour theme's hue and chroma). */
export function ageStops(light: boolean, mode: AgeColours = "hue", tintHue: number | null = null, chroma = 0.02): string[] {
  const stops = light ? AGE_RAMP.light : AGE_RAMP.dark;
  if (mode === "hue") return [...stops];
  return stops.map((_s, i) => rgbToHex(ageColor(i / Math.max(1, stops.length - 1), light, mode, tintHue, chroma)));
}

/** Speakers: palette slots + shapes (you filled, assistant hollow, another person half, tool a small square). */
export const SPEAKER_SLOTS = { you: 2, assistant: 7, other: 5 } as const;
/** Tool output uses the no-value slate. */
export const TOOL_COLOUR = NO_VALUE;
/** Machine note kinds → slots and glyphs (§4.5); a map is a white-lifted beacon in the renderer. */
export const KIND_STYLE = {
  decision: { slot: 2, glyph: "◆" },
  question: { slot: 1, glyph: "?" },
  plan: { slot: 5, glyph: "▸" },
  abandoned: { slot: 6, glyph: "×" },
  idea: { slot: 8, glyph: "✶" },
  concept: { slot: 7, glyph: "◎" },
  /** The conversation summary (code: gist; frontmatter and copy: "summary"). */
  gist: { slot: 3, glyph: "≡" },
} as const;

/** Pattern per slot for Print and "Patterns on charts": 45° for 2, 4, 6, 8; 135° for 3, 5, 7; solid for 1. */
export function patternFor(slot: number): "solid" | "hatch45" | "hatch135" {
  if (slot <= 1) return "solid";
  return slot % 2 === 0 ? "hatch45" : "hatch135";
}

// ───────────────────────────── runtime helpers for the shell (§4.2, §4.4) ─────────────────────────────

/** Hues a palette offers per dimension (Signal has seven; the rest fold into Other). */
export function hueCount(palette: PaletteId): number {
  return Math.min(MAX_HUES, paletteById(palette).glow.length);
}

/** WCAG 2 relative luminance of a hex colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio between two hex colours (1 … 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** CSS `color-mix(in oklab, a w, b)`: OKLab interpolation with `weightA` of the first colour. */
export function mixOklab(a: string, b: string, weightA: number): string {
  const w = Math.max(0, Math.min(1, weightA));
  const p = srgbToOklab(hexToRgb(a));
  const q = srgbToOklab(hexToRgb(b));
  return rgbToHex(oklabToSrgb([p[0] * w + q[0] * (1 - w), p[1] * w + q[1] * (1 - w), p[2] * w + q[2] * (1 - w)]));
}

/** The primary-button fill: the accent mixed 90% with black (§4.2, `--cx-accent-fill`). */
export function accentFill(accentHex: string): string {
  return mixOklab(accentHex, "#000000", 0.9);
}

/** Text on the primary fill: white while it keeps 4.5:1, otherwise #111111 (§4.2: measured at runtime). */
export function onAccentText(accentHex: string): "#ffffff" | "#111111" {
  return contrastRatio("#ffffff", accentFill(accentHex)) >= 4.5 ? "#ffffff" : "#111111";
}

/** Parse a computed CSS colour (`#rgb`, `#rrggbb`, `rgb()`/`rgba()` with commas or spaces) to `#rrggbb`. */
export function cssColourToHex(css: string): string | null {
  const s = css.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(s) || /^#[0-9a-f]{6}$/.test(s)) return rgbToHex(hexToRgb(s));
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (!m) return null;
  const c = [m[1], m[2], m[3]].map((x) => Number(x) / 255) as [number, number, number];
  return c.every((x) => Number.isFinite(x)) ? rgbToHex(c) : null;
}

/**
 * CSS custom properties for the active palette, so every chrome mark (speakers, kinds, chips) follows the
 * Palette setting: `--cx-cat-N` are 2D marks on the chrome (fill on dark chrome, light on light chrome) and
 * `--cx-cat-N-glow` are stage keys (glow on Ink, light on Paper). Slots past the palette's length are Other.
 */
export function paletteCssVars(id: PaletteId, opts: { lightChrome: boolean; paperStage: boolean }): Record<string, string> {
  const p = paletteById(id);
  const chrome = opts.lightChrome ? p.light : p.fill;
  const stage = opts.paperStage ? p.light : p.glow;
  const out: Record<string, string> = {};
  for (let slot = 1; slot <= MAX_HUES; slot++) {
    out[`--cx-cat-${slot}`] = chrome[slot - 1] ?? (opts.lightChrome ? OTHER.light : OTHER.fill);
    out[`--cx-cat-${slot}-glow`] = stage[slot - 1] ?? (opts.paperStage ? OTHER.light : OTHER.glow);
  }
  out["--cx-cat-other"] = opts.lightChrome ? OTHER.light : OTHER.fill;
  out["--cx-cat-other-glow"] = opts.paperStage ? OTHER.light : OTHER.glow;
  out["--cx-none"] = opts.lightChrome ? NO_VALUE.light : NO_VALUE.fill;
  out["--cx-none-glow"] = opts.paperStage ? NO_VALUE.light : NO_VALUE.glow;
  const ramp = opts.paperStage ? AGE_RAMP.light : AGE_RAMP.dark;
  ramp.forEach((hex, i) => (out[`--cx-age-${i}`] = hex));
  return out;
}

/** CSS colour of a key bucket for HTML marks (dots, chips, the compass ring). */
export function bucketCss(bucket: "value" | "other" | "none", slot: number, palette: PaletteId, variant: Variant): string {
  return rgbToHex(bucketColor(bucket, slot, palette, variant));
}

/** `rgb(…)` from a 0..1 triple (legend rows carry linear 0..1 sRGB components). */
export function rgbCss(rgb: readonly [number, number, number], alpha = 1): string {
  const c = rgb.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255));
  return alpha >= 1 ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

/** The seven data palettes the Display panel's "Data colours" list offers, in order (tint palettes belong to colour themes). */
export const DATA_COLOUR_IDS: readonly PaletteId[] = ["prism", "signal", "harbor", "orchard", "ember", "reef", "print"];
/** Colours in a row's stripe. */
export const DATA_COLOUR_STRIPE = 7;

export interface DataColourRow {
  id: PaletteId;
  /** The palette's first seven colours (its light variants on a paper stage). */
  stripe: string[];
  selected: boolean;
}

/** One row per data palette: its stripe, and whether it is the one in use. A tint palette in use selects no row. */
export function dataColourRows(current: PaletteId, light = false): DataColourRow[] {
  return DATA_COLOUR_IDS.map((id) => ({ id, stripe: paletteDots(id, DATA_COLOUR_STRIPE, light), selected: id === current }));
}

/** The row an arrow key moves to (wraps); a current palette outside the list starts from the first row. */
export function stepDataColour(current: PaletteId, dir: 1 | -1): PaletteId {
  const at = DATA_COLOUR_IDS.indexOf(current);
  if (at < 0) return DATA_COLOUR_IDS[dir === 1 ? 0 : DATA_COLOUR_IDS.length - 1] as PaletteId;
  return DATA_COLOUR_IDS[(at + dir + DATA_COLOUR_IDS.length) % DATA_COLOUR_IDS.length] as PaletteId;
}

/** The Stage tint slider: 0 = Off, 1 to 360 = the OKLCH hue (360 stands for hue 0). */
export const TINT_SLIDER = [0, 360] as const;
export function tintToSlider(hue: number | null): number {
  if (hue === null || !Number.isFinite(hue)) return 0;
  const h = Math.round(((hue % 360) + 360) % 360);
  return h === 0 ? 360 : h;
}
export function sliderToTint(v: number): number | null {
  if (!Number.isFinite(v) || v < 1) return null;
  return Math.round(Math.min(360, v)) % 360;
}
