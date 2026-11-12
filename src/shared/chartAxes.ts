/**
 * What each chart calls its axes. The Chart page used to show Horizontal and Vertical for every form; a matrix reads
 * Across and Down, a radial heatmap Around and Rings, a flow From and To, and a form with a single axis shows one row.
 * The role ids are plain words; the page turns them into copy (`chart.role<Id>`). The order choices map onto the
 * axis sort the worker already honours (count, name, and the dimension's natural order).
 */
import type { DimId } from "./dims";
import type { ChartSpec } from "./protocol/worker";
import type { ChartId } from "./views";

export type AxisRole =
  | "across"
  | "down"
  | "bars"
  | "boxes"
  | "bands"
  | "bubbles"
  | "spheres"
  | "shells"
  | "streams"
  | "rows"
  | "days"
  | "lanes"
  | "along"
  | "arcsBy"
  | "around"
  | "rings"
  | "from"
  | "to"
  | "linkedBy"
  | "clusters"
  | "then";

export interface AxisRoles {
  x: AxisRole;
  /** null: the form has one axis, so the page shows one row. */
  y: AxisRole | null;
}

export const AXIS_ROLES: Readonly<Record<ChartId, AxisRoles>> = {
  "ranked-bars": { x: "bars", y: null },
  matrix: { x: "across", y: "down" },
  treemap: { x: "boxes", y: null },
  icicle: { x: "bands", y: null },
  "bubble-pack": { x: "bubbles", y: null },
  "nested-bubbles": { x: "spheres", y: "shells" },
  stream: { x: "across", y: "streams" },
  bands: { x: "across", y: "bands" },
  ridgeline: { x: "across", y: "rows" },
  "calendar-heatmap": { x: "days", y: null },
  "timeline-lanes": { x: "across", y: "lanes" },
  "arc-diagram": { x: "along", y: "arcsBy" },
  "diverging-area": { x: "across", y: null },
  "two-sides": { x: "across", y: null },
  beeswarm: { x: "across", y: null },
  "radial-clock": { x: "around", y: "rings" },
  "radial-heatmap": { x: "around", y: "rings" },
  alluvial: { x: "from", y: "to" },
  chord: { x: "around", y: "linkedBy" },
  "clusters-3d": { x: "clusters", y: "then" },
};

/**
 * The dimension a time form runs its streams, rows, lanes or arcs along while the vertical axis is empty (the worker's
 * fallback, worker/charts/time.ts; the clock's rings, worker/charts/rhythm.ts). The Chart page names it in the row instead of saying "None".
 */
export const DEFAULT_SERIES: Readonly<Partial<Record<ChartId, DimId>>> = {
  stream: "space",
  bands: "space",
  ridgeline: "space",
  "timeline-lanes": "project",
  "arc-diagram": "project",
  "radial-clock": "space",
};

export function axisRolesFor(chart: ChartId): AxisRoles {
  return AXIS_ROLES[chart];
}

/** The Order choices an axis offers, in menu order; each is a value of the axis' `sort`. */
export const ORDER_CHOICES = ["count", "name", "date"] as const;
export type OrderChoice = (typeof ORDER_CHOICES)[number];

/** The copy key of an order choice ("date" is the dimension's natural order, so it reads Natural). */
export const ORDER_COPY = { count: "chart.orderCount", name: "chart.orderName", date: "chart.orderNatural" } as const satisfies Record<OrderChoice, string>;

/** Most dots the colour key lists before it ends with "+N". */
export const COLOUR_KEY_CAP = 24;

export interface KeyDot {
  key: string;
  name: string;
  rgb: [number, number, number];
}

/** The dots a colour key shows and how many more there are beyond the cap. */
export function capKey(dots: readonly KeyDot[], cap: number = COLOUR_KEY_CAP): { shown: KeyDot[]; more: number } {
  return dots.length <= cap ? { shown: [...dots], more: 0 } : { shown: dots.slice(0, cap), more: dots.length - cap };
}

// ───────────────────────────── start-from presets ─────────────────────────────

export const START_PRESET_IDS = ["monthFolder", "speakerTime", "projectKind", "dayArea"] as const;
export type StartPresetId = (typeof START_PRESET_IDS)[number];

/** A ready-made pairing: the chart that suits it and what goes on each axis. A one-axis form puts its second dimension in the colour. */
export interface StartPreset {
  id: StartPresetId;
  chart: ChartId;
  x: DimId;
  y: DimId | null;
  colour: DimId | null;
}

export const START_PRESETS: readonly StartPreset[] = [
  { id: "monthFolder", chart: "matrix", x: "month", y: "folder", colour: null },
  { id: "speakerTime", chart: "stream", x: "week", y: "speaker", colour: null },
  { id: "projectKind", chart: "alluvial", x: "project", y: "kind", colour: null },
  { id: "dayArea", chart: "calendar-heatmap", x: "day", y: null, colour: "space" },
];

const DATE_DIMS: ReadonlySet<string> = new Set(["day", "week", "month", "year", "hour", "weekday", "monthOfYear"]);

/** A date axis keeps its natural order, any other axis runs largest first. */
const sortFor = (dim: DimId): ChartSpec["x"]["sort"] => (DATE_DIMS.has(dim) ? "date" : "count");

/**
 * The chart after a preset: its form and both axes (and the colour when the preset names one). Size, filter, "hide items
 * without a value", merges, combined values and the value limit carry over (as they do when another form is chosen); chart options belong to the old form, so they reset.
 */
export function applyPreset(spec: ChartSpec, preset: StartPreset): ChartSpec {
  return {
    ...spec,
    chart: preset.chart,
    x: { dim: preset.x, sort: sortFor(preset.x) },
    y: preset.y ? { dim: preset.y, sort: sortFor(preset.y) } : null,
    colour: preset.colour ?? spec.colour,
    options: {},
  };
}

/** Whether the chart on screen is already this preset (form and axes). */
export function presetMatches(spec: ChartSpec, preset: StartPreset): boolean {
  return spec.chart === preset.chart && spec.x.dim === preset.x && (spec.y?.dim ?? null) === preset.y && (preset.colour === null || spec.colour === preset.colour);
}
