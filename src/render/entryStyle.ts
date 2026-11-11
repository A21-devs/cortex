/**
 * Chart-to-chart entry styles (P06): the signature of a form morph that depends on the two charts. Pure; the renderer
 * turns the number into shader terms (render/shaders.ts uEntry).
 *   0 plain (the generic curl travel)   1 smear along X (a matrix breaking into spheres)
 *   2 diagonal burst (lanes into the calendar)   3 rise from the baseline (waves, stream, diverging area)
 */
import type { ChartSpec } from "../shared/protocol/worker";
import type { ChartId } from "../shared/views";

export type EntryStyle = 0 | 1 | 2 | 3;

const RISING: ReadonlySet<ChartId> = new Set<ChartId>(["ridgeline", "stream", "diverging-area"]);

export function entryStyleFor(prev: ChartId | null, next: ChartId | null): EntryStyle {
  if (!next || !prev || prev === next) return 0;
  if (RISING.has(next)) return 3;
  if (prev === "timeline-lanes" && next === "calendar-heatmap") return 2;
  if (prev === "matrix") return 1;
  return 0;
}

/**
 * The part of a chart spec that re-flows the rows of a tree or a combined-values list without changing the chart:
 * which folder nodes are open and which values are combined. A change of it dims the chart to dark dots for a beat
 * and relights it (the query dip), with no change in the page code.
 */
export function relayoutKey(spec: ChartSpec | null | undefined): string {
  if (!spec) return "";
  return JSON.stringify([spec.chart, spec.options.expanded ?? null, spec.options.collapsed ?? null, spec.combined, spec.merges]);
}
