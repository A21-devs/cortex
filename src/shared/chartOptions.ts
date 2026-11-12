/**
 * Chart options that both the Chart page (UI) and the layouts (worker) read, so the two agree on defaults.
 *  - Counts: draw the count in each cell, bar or group. On by default where the count is the point of the chart;
 *    elsewhere off until switched on.
 *  - Links: draw the links between the notes that the chart shows. Not offered where the chart already is a drawing
 *    of connections (alluvial, chord, arc diagram).
 *  - Waves (the ridgeline): Scale, Smoothing, Window and "each to its own peak".
 */
import type { ChartId } from "./views";

type Options = Readonly<Record<string, unknown>>;

/** Charts whose counts show without the toggle being touched. */
export const COUNTS_BY_DEFAULT: readonly ChartId[] = ["matrix", "calendar-heatmap", "ranked-bars", "icicle"];

export function countsDefault(chart: ChartId): boolean {
  return COUNTS_BY_DEFAULT.includes(chart);
}

export function countsOn(chart: ChartId, options: Options): boolean {
  return typeof options.counts === "boolean" ? options.counts : countsDefault(chart);
}

/** Charts that are themselves a drawing of connections have no Links toggle. */
export const NO_LINKS_CHARTS: readonly ChartId[] = ["alluvial", "chord", "arc-diagram"];

export function linksAvailable(chart: ChartId): boolean {
  return !NO_LINKS_CHARTS.includes(chart);
}

export function linksOn(chart: ChartId, options: Options): boolean {
  return linksAvailable(chart) && options.links === true;
}

// ───────────────────────────── Waves ─────────────────────────────

export type WaveScale = "linear" | "sqrt" | "log";
export type WaveSmoothing = "none" | "moving" | "exponential";

export const WAVE_SCALES: readonly WaveScale[] = ["linear", "sqrt", "log"];
export const WAVE_SMOOTHINGS: readonly WaveSmoothing[] = ["none", "moving", "exponential"];
export const WAVE_WINDOWS: readonly number[] = [7, 30, 90];
export const WAVE_WINDOW_DEFAULT = 30;

export function waveScale(options: Options): WaveScale {
  return options.scale === "sqrt" || options.scale === "log" ? options.scale : "linear";
}

/** An older saved chart carries `smoothingDays` (0 to 90) instead of Smoothing: it reads as a moving average. */
export function waveSmoothing(options: Options): WaveSmoothing {
  if (options.smoothing === "moving" || options.smoothing === "exponential" || options.smoothing === "none") return options.smoothing;
  return typeof options.smoothingDays === "number" && options.smoothingDays > 0 ? "moving" : "none";
}

export function waveWindowDays(options: Options): number {
  const n = typeof options.windowDays === "string" ? Number(options.windowDays) : options.windowDays;
  if (typeof n === "number" && WAVE_WINDOWS.includes(n)) return n;
  if (options.smoothing === undefined && typeof options.smoothingDays === "number" && options.smoothingDays > 0) return Math.min(90, Math.max(1, Math.round(options.smoothingDays)));
  return WAVE_WINDOW_DEFAULT;
}

/**
 * The windows the Window control offers: 7, 30 and 90 days, plus the chart's own when an older saved chart smooths over
 * another number of days, so the control shows (and keeps) the value the chart really uses.
 */
export function waveWindowChoices(options: Options): number[] {
  const own = waveWindowDays(options);
  return WAVE_WINDOWS.includes(own) ? [...WAVE_WINDOWS] : [...WAVE_WINDOWS, own].sort((a, b) => a - b);
}

// ───────────────────────────── Shells (nested bubbles) ─────────────────────────────

/** Shells are drawn as rows of swirl-textured spheres (one row per group, one sphere per value) or as nested shells. */
export type ShellsForm = "rows" | "nested";

export const SHELLS_FORMS: readonly ShellsForm[] = ["rows", "nested"];

export function shellsForm(options: Options): ShellsForm {
  return options.form === "nested" ? "nested" : "rows";
}

// ───────────────────────────── Grid (matrix) and Folders (treemap) ─────────────────────────────

/** The Grid's rows recede in depth under a tilted camera. On unless the chart says otherwise. */
export function matrixPerspective(options: Options): boolean {
  return options.perspective !== false;
}

/** The folder path a Folders treemap is drilled into ("" = the whole tree). */
export function treemapRoot(options: Options): string {
  return typeof options.root === "string" ? options.root : "";
}

/** Options with the drill-in root set (an empty path clears it). */
export function withTreemapRoot<T extends Record<string, unknown>>(options: T, root: string): T {
  const next: Record<string, unknown> = { ...options };
  if (root === "") delete next.root;
  else next.root = root;
  return next as T;
}

// ───────────────────────────── Lifelines (timeline lanes) ─────────────────────────────

/**
 * How a lifeline lane is drawn: a line with particle clusters, monthly blocks, loose dots, a density curve, or (Curve)
 * one survival curve per series: how long a life lasted against the share of lives that lasted at least that long.
 */
export type LanesShow = "lines" | "blocks" | "dots" | "density" | "curve";

export const LANES_SHOWS: readonly LanesShow[] = ["lines", "blocks", "dots", "density", "curve"];

/**
 * The Show choice of the Lifelines chart. Lines is the default. A chart saved before Show existed carries the old
 * Monthly density toggle: on reads as Blocks, off as Dots.
 */
export function lanesShow(options: Options): LanesShow {
  const v = options.show;
  if (v === "lines" || v === "blocks" || v === "dots" || v === "density" || v === "curve") return v;
  if (options.monthlyDensity === false) return "dots";
  if (options.monthlyDensity === true) return "blocks";
  return "lines";
}

// ───────────────────────────── Show rows (Lifelines, Arc diagram) ─────────────────────────────

/** Which rows of Lifelines and the Arc diagram come first: the longest, the most recently active, or the busiest. */
export type RowsShow = "longest" | "recent" | "most";

export const ROWS_SHOWS: readonly RowsShow[] = ["longest", "recent", "most"];

/** The Show rows choice, or null while it is untouched (the rows then keep the order of their axis). */
export function rowsShow(options: Options): RowsShow | null {
  const v = options.rows;
  return v === "longest" || v === "recent" || v === "most" ? v : null;
}

/** Whole months in a stretch of days, at least one ("back after 1 month"). */
export function monthsOfDays(days: number): number {
  return Math.max(1, Math.round(days / 30.44));
}

/**
 * The order the rows take under Show rows: `key[i]` is row i's longest stretch, newest entry and count. Ties keep the
 * order the rows already had. Returns the old row index for each new position.
 */
export function rowsOrder(show: RowsShow, rows: readonly { longest: number; newest: number; count: number }[]): number[] {
  const idx = rows.map((_, i) => i);
  const key = (i: number): number => (show === "longest" ? rows[i]!.longest : show === "recent" ? rows[i]!.newest : rows[i]!.count);
  return idx.sort((a, b) => key(b) - key(a) || a - b);
}

/** Bands: how long one segment of a band is. */
export type BandSegments = "auto" | "week" | "month";

export function bandSegments(options: Options): BandSegments {
  return options.grain === "week" || options.grain === "month" ? options.grain : "auto";
}
