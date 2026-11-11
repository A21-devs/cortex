/**
 * ChartId → layout function, one entry per chart of the CORTEX-UX §7.2 catalogue. Owner: E9.
 *
 * Every layout decides membership itself (visibility, period, filters, "Hide items without a value"), so the
 * worker can call `CHARTS[spec.chart](ctx)` with an empty `members` array; `runChart` is the one-call form for
 * the worker's `arrangement` method (kind "chart").
 */
import { CortexError } from "../../shared/errors";
import type { DataIndex } from "../../shared/index-format";
import type { ArrangementResult, ChartSpec, VisibilityParams } from "../../shared/protocol/worker";
import { CHART_IDS, type ChartId } from "../../shared/views";
import type { ChartStage } from "../../shared/chartStage";
import type { ChartContext, ChartRegistry } from "./common";
import * as C from "./compare";
import * as N from "./connections";
import * as R from "./rhythm";
import * as T from "./time";

export const CHARTS: ChartRegistry = {
  "ranked-bars": C.layoutRankedBars,
  matrix: C.layoutMatrix,
  treemap: C.layoutTreemap,
  icicle: C.layoutIcicle,
  "bubble-pack": C.layoutBubblePack,
  "nested-bubbles": C.layoutNestedBubbles,
  stream: T.layoutStream,
  bands: T.layoutBands,
  ridgeline: T.layoutRidgeline,
  "calendar-heatmap": T.layoutCalendarHeatmap,
  "timeline-lanes": T.layoutTimelineLanes,
  "arc-diagram": T.layoutArcDiagram,
  "diverging-area": T.layoutDivergingArea,
  "two-sides": T.layoutBalance,
  beeswarm: T.layoutBeeswarm,
  "radial-clock": R.layoutRadialClock,
  "radial-heatmap": R.layoutRadialHeatmap,
  alluvial: N.layoutAlluvial,
  chord: N.layoutChord,
  "clusters-3d": N.layoutClusters3d,
};

export interface RunChartOptions {
  /** Restrict the chart to these ordinals (empty or absent = the whole index). */
  members?: Uint32Array;
  now?: number;
  seed?: number;
  isCancelled?: () => boolean;
  /** The visible stage in CSS px (labels and ticks switch columns and rows with it). */
  stage?: ChartStage;
}

/** Lay out one chart: the worker's `arrangement` for `{ kind: "chart" }`. Unknown charts are E_BAD_REQUEST. */
export function runChart(index: DataIndex, spec: ChartSpec, visibility: VisibilityParams, opts: RunChartOptions = {}): ArrangementResult {
  const id = spec?.chart as ChartId | undefined;
  if (!id || !(CHART_IDS as readonly string[]).includes(id)) throw new CortexError("E_BAD_REQUEST", `unknown chart ${String(id)}`);
  const seed = opts.seed ?? 0;
  const ctx: ChartContext = {
    index,
    spec,
    visibility,
    members: opts.members ?? new Uint32Array(0),
    seed: () => seed,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.isCancelled ? { isCancelled: opts.isCancelled } : {}),
    ...(opts.stage ? { stage: opts.stage } : {}),
  };
  return CHARTS[id](ctx);
}
