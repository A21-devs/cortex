/**
 * Icons. Owner: E11. CORTEX-UX §1.3 and §4.10. Part of the EAGER core (main.ts registers the glyph): this module
 * imports nothing.
 *  - The Cortex glyph "strata": two open arcs around a seed (outer arc opens right, inner arc toward the lower
 *    right): growth turning outward from a centre. Not a brain silhouette; unlike the taken ribbon icons
 *    `network`, `sparkles` and `orbit`. Never filled, never coloured inside, minimum 12 px.
 *  - Every control uses Obsidian's bundled Lucide icons through setIcon(), so Cortex matches the app.
 *  - Colour-slot dots for native menus (the scope menu shows each area's dot) are registered as tiny icons whose
 *    fill is the slot colour of the active palette (slotIconSvg / SLOT_ICON_IDS).
 */

export const CORTEX_ICON_ID = "cortex-glyph";

/** Obsidian addIcon() content for a 0 0 100 100 viewBox (the 24-grid master scaled by 4.1667). */
export const CORTEX_GLYPH_SVG =
  '<g transform="scale(4.1667)" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M19.09 6.46A9 9 0 1 0 19.09 17.54"/>' +
  '<path d="M16.83 10.71A5 5 0 1 0 12.44 16.98"/>' +
  '<circle cx="12" cy="12" r="1.65" fill="currentColor" stroke="none"/>' +
  "</g>";

/** The 24 × 24 master, for inline use where an <svg> element is drawn directly (sizes per §1.3). */
export const CORTEX_GLYPH_PATHS = {
  outer: "M19.09 6.46A9 9 0 1 0 19.09 17.54",
  inner: "M16.83 10.71A5 5 0 1 0 12.44 16.98",
  seed: { cx: 12, cy: 12, r: 1.65 },
} as const;

/** Lucide names per control (CORTEX-UX §4.10); rendered with Obsidian's setIcon(). */
export const LUCIDE = {
  display: "sliders-horizontal",
  chart: "chart-column",
  names: "tag",
  lines: "spline",
  motion: "rotate-3d",
  home: "house",
  immersive: "maximize",
  find: "search",
  addSources: "plus",
  settings: "settings",
  more: "ellipsis",
  back: "arrow-left",
  close: "x",
  pin: "pin",
  showInBrain: "crosshair",
  export: "download",
  undo: "undo-2",
  history: "history",
  folder: "folder",
  document: "file-text",
  conversation: "message-square",
  agents: "cpu",
  privacy: "shield-check",
  guide: "circle-help",
  checks: "inbox",
  calendar: "calendar",
  today: "sun",
  newEntry: "pen-line",
  data: "table",
  sources: "database",
  play: "play",
  pause: "pause",
  warning: "triangle-alert",
  flag: "flag",
  layers: "layers",
  swap: "arrow-left-right",
  saveImage: "image-down",
  copyData: "clipboard-copy",
  reset: "rotate-ccw",
  lock: "lock",
  chevron: "chevron-down",
  body: "person-standing",
  groups: "boxes",
  tools: "wrench",
  list: "list",
  scope: "circle-dot",
  key: "palette",
  theme: "palette",
  check: "check",
  clock: "clock",
  vault: "book-open",
  terminal: "terminal",
  openMain: "maximize-2",
  info: "info",
  eye: "eye",
  eyeOff: "eye-off",
  dockLeft: "panel-left",
  dockRight: "panel-right",
  parkLeft: "panel-left-close",
  parkRight: "panel-right-close",
} as const;

export type IconName = keyof typeof LUCIDE;

/** Inline fallback used when Obsidian's setIcon is unavailable (tests, string rendering). */
export function iconPlaceholder(name: IconName): string {
  return `<span class="cx-icon" data-icon="${LUCIDE[name]}" aria-hidden="true"></span>`;
}

/** Icon ids of the colour-slot dots used in native menus: slot 1..8, Other (mist) and No value (slate). */
export const SLOT_ICON_IDS = {
  slot: (n: number) => `cortex-slot-${n}`,
  other: "cortex-slot-other",
  none: "cortex-slot-none",
  ring: "cortex-slot-ring",
} as const;

/** addIcon() body (0 0 100 100) of a filled dot; `hollow` draws a ring (No area keeps a hollow slate dot). */
export function slotIconSvg(hex: string, hollow = false): string {
  const safe = /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#727b8a";
  return hollow
    ? `<circle cx="50" cy="50" r="24" fill="none" stroke="${safe}" stroke-width="10"/>`
    : `<circle cx="50" cy="50" r="28" fill="${safe}"/>`;
}

/** addIcon() body of the "All areas" ring: the first colours as arcs around an open centre. */
export function ringIconSvg(hexes: readonly string[]): string {
  const cols = hexes.filter((h) => /^#[0-9a-f]{6}$/i.test(h)).slice(0, 8);
  if (cols.length === 0) return slotIconSvg("#727b8a", true);
  const r = 28;
  const c = 2 * Math.PI * r;
  const seg = c / cols.length;
  return cols
    .map((h, i) => `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${h}" stroke-width="12" stroke-dasharray="${seg.toFixed(2)} ${(c - seg).toFixed(2)}" stroke-dashoffset="${(-i * seg + c / 4).toFixed(2)}"/>`)
    .join("");
}
