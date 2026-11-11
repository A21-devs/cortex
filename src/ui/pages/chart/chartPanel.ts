/**
 * The Chart page's own state transitions, kept apart from the drawing so they can be tested without a view:
 *  - opening the page brings the chart shape up (last chart, or the first one in the gallery) and closing it sends the
 *    figure back to the brain when the page was what opened it;
 *  - the Groups | Chart switch;
 *  - the one-click "Colour by area" offer;
 *  - the Order of an axis, and the dots of the colour key.
 */
import type { DimId } from "../../../shared/dims";
import { capKey, type KeyDot, type OrderChoice } from "../../../shared/chartAxes";
import type { ChartSpec, ColourMode, LegendModel } from "../../../shared/protocol/worker";
import { CHART_CATALOGUE, type ShapeKind } from "../../../shared/views";
import { markChartOpenedByPage, setColourMode, setShape, setView, takeChartOpenedByPage } from "../../../state/actions";
import type { CortexStore } from "../../../state/store";
import { SHELL } from "../../breakpoints";
import { chartAvailable, chartSpecFor } from "../../stage/ShapeBar";

export type Arrangement = "groups" | "chart";

/** The Groups | Chart switch shows Groups while the figure is (or is going) the grouped shape, otherwise Chart. */
export function arrangementOf(shape: ShapeKind): Arrangement {
  return shape === "groups" ? "groups" : "chart";
}

/** The chart a first open shows: the first form of the gallery that is available. */
export function defaultChartId() {
  return (CHART_CATALOGUE.find((c) => chartAvailable(c)) ?? CHART_CATALOGUE[0]!).id;
}

const closing = new WeakMap<CortexStore, ReturnType<typeof setTimeout>>();

/**
 * Opening the page: the figure takes the chart shape and morphs to it (animateTo(1)), using the leaf's last chart or the
 * gallery's first. A Groups figure that is already out stays (the switch shows it).
 */
export function openChartShape(store: CortexStore, animateTo: (to: number) => void): void {
  const pending = closing.get(store);
  if (pending !== undefined) {
    clearTimeout(pending);
    closing.delete(store);
  }
  const v = store.get("view");
  // A Groups figure already out is the user's (the page leaves it); a chart goes back to the brain on leaving, whether the
  // page brought it up or it was already out (rail, header, key, the Display panel's Chart switch).
  if (v.shape === "body" || v.morph < 0.5) markChartOpenedByPage(store, true);
  if (v.shape === "groups" && v.morph >= 0.5) return;
  if (!v.chart) setView(store, "chart", chartSpecFor(defaultChartId(), null, v.groupBy));
  if (v.shape !== "chart") setShape(store, "chart");
  if (v.morph < 1) animateTo(1);
}

/**
 * Closing the page: a chart on screen (the page brought it up, or it was already out) dissolves back to the brain (morph to 0, then
 * the shape is Body again, so the key returns to the brain's dimension). Returns whether it did.
 */
export function closeChartToBrain(store: CortexStore, animateTo: (to: number) => void, schedule: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms), ms: number = SHELL.timing.shapeBackMs): boolean {
  // A chart on screen goes back with the page, however it came up (the page, the shape bar, a command); Groups stays.
  const opened = takeChartOpenedByPage(store);
  const cur = store.get("view");
  if (!opened && !(cur.shape === "chart" && cur.morph >= 0.5)) return false;
  animateTo(0);
  const finish = () => {
    closing.delete(store);
    const v = store.get("view");
    if (v.shape === "chart" && v.morph < 0.5) setShape(store, "body");
  };
  if (ms <= 0) finish();
  else {
    const h = schedule(finish, ms + 60);
    if (h !== undefined && h !== null && typeof h !== "boolean") closing.set(store, h as ReturnType<typeof setTimeout>);
  }
  return true;
}

/** The Groups | Chart switch: sets the shape and morphs to it. What the user picks here stays when the page closes. */
export function chooseArrangement(store: CortexStore, to: Arrangement, animateTo: (target: number) => void): void {
  takeChartOpenedByPage(store);
  const v = store.get("view");
  if (to === "chart" && !v.chart) setView(store, "chart", chartSpecFor(defaultChartId(), null, v.groupBy));
  if (v.shape !== to) setShape(store, to);
  if (v.morph < 1) animateTo(1);
}

// ───────────────────────────── Colour by area ─────────────────────────────

/** The dimension that is Area. */
export const AREA_DIM: DimId = "space";

export function colouredByArea(mode: ColourMode): boolean {
  return mode.kind === "categorical" && mode.dim === AREA_DIM;
}

/** The offer shows until it is taken or dismissed, and only when the figure is not already coloured by area. */
export function offersAreaColour(notes: ColourMode, dismissed: boolean): boolean {
  return !dismissed && !colouredByArea(notes);
}

export function applyAreaColour(store: CortexStore): void {
  setColourMode(store, "notes", { kind: "categorical", dim: AREA_DIM });
}

// ───────────────────────────── axes and the colour key ─────────────────────────────

/** Order of an axis: the select writes the axis' `sort`. */
export function withAxisOrder(spec: ChartSpec, zone: "x" | "y", order: OrderChoice): ChartSpec {
  if (zone === "x") return spec.x.sort === order ? spec : { ...spec, x: { ...spec.x, sort: order } };
  if (!spec.y || spec.y.sort === order) return spec;
  return { ...spec, y: { ...spec.y, sort: order } };
}

/** The dots of the key as the stage's own legend colours them: the section for this dimension, when it is on screen. */
export function legendDots(legend: LegendModel | null, dim: DimId): KeyDot[] | null {
  const section = legend?.sections.find((s) => s.dim === dim);
  if (!section) return null;
  return section.rows.filter((r) => r.depth === 0 && !r.aggregate).map((r) => ({ key: r.key, name: r.name, rgb: r.rgb }));
}

export { capKey };
