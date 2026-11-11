/**
 * The stage a chart is laid out for (CHART-03). The layouts work in fixed world units, but text is a fixed number of
 * pixels, so how many label columns and tick rows fit depends on how many pixels the stage gives a world unit. The
 * controller measures the visible stage (the canvas minus the sheet that covers its right edge) and sends it with the
 * chart request; the worker reads it through these pure helpers. Without a stage (older callers, tests) a chart is laid
 * out for a stage of the usual size.
 */

export interface ChartStage {
  /** CSS pixels of stage that stay visible (canvas width minus the open sheet). */
  width: number;
  height: number;
  /** width / height. */
  aspect: number;
}

/** Below this stage width (CSS px) the labels of a chart stay in one column. */
export const STAGE_NARROW_PX = 520;
/** World size of the frame a flat chart is fitted into (matches the chart builder's FRAME). */
export const FRAME_UNITS = { w: 13, h: 8 } as const;
/** Pixels per world unit assumed when no stage is given: the usual desktop stage. */
export const DEFAULT_PX_PER_UNIT = 100;
/** A label needs about this much room along its axis (CSS px) so its neighbours do not touch it. */
export const LABEL_PITCH_PX = 20;
/** Width of one character of an axis label (CSS px). */
export const LABEL_CHAR_PX = 6.4;
/** Characters of a label in the two-column form: both columns have to fit side by side. */
export const COLUMN_LABEL_CHARS = 12;
/** A tick slot narrower than this many pixels forces the labels onto two rows. */
export const TICK_SLOT_PX = 18;

export function chartStageOf(width: number, height: number): ChartStage {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return { width: w, height: h, aspect: w / h };
}

/** A coarse key of the stage: a change of it is worth a new layout (40 px steps), a smaller one is not. */
export function chartStageKey(stage: ChartStage | null | undefined): string {
  return stage ? `${Math.round(stage.width / 40)}x${Math.round(stage.height / 40)}` : "";
}

/** CSS pixels per world unit of the fitted frame. */
export function pxPerUnit(stage: ChartStage | null | undefined): number {
  if (!stage) return DEFAULT_PX_PER_UNIT;
  return Math.max(10, Math.min(stage.width / FRAME_UNITS.w, stage.height / FRAME_UNITS.h));
}

/** One label column on a narrow stage, two when the stage is wide enough to hold both. */
export function labelColumns(stage: ChartStage | null | undefined): 1 | 2 {
  return stage && stage.width < STAGE_NARROW_PX ? 1 : 2;
}

/** World distance two labels of a list need between them. */
export function labelPitch(stage: ChartStage | null | undefined): number {
  return LABEL_PITCH_PX / pxPerUnit(stage);
}

/** One tick row while the slots are wide, two once they crowd. `slot` is the world width of one tick. */
export function tickRows(stage: ChartStage | null | undefined, slot: number): 1 | 2 {
  return slot * pxPerUnit(stage) < TICK_SLOT_PX ? 2 : 1;
}

/** How many times the world size of a label (its width and its row step) grows on a stage smaller than the usual one: 1 at the usual stage. */
export function labelScale(stage: ChartStage | null | undefined): number {
  return DEFAULT_PX_PER_UNIT / pxPerUnit(stage);
}

/** Every how-many-th row of a single column of labels `pitch` world units apart can be labelled without the labels touching. */
export function oneColumnStride(stage: ChartStage | null | undefined, pitch: number): number {
  return Math.max(1, Math.ceil(labelPitch(stage) / Math.max(1e-6, pitch)));
}

/** World width of a column of labels of `chars` characters. */
export function labelWidth(stage: ChartStage | null | undefined, chars: number): number {
  return (chars * LABEL_CHAR_PX) / pxPerUnit(stage);
}

// ───────────────────────────── the frame a flat chart fills ─────────────────────────────

/** CSS px the camera keeps free round a flat chart: left and right (the stage overlays), then top and bottom (the bar and the colour key). */
export const SAFE_MARGIN_PX = { x: 94, y: 218 } as const;
/** The width to height of the usual frame (13 by 8 world units). */
export const FRAME_ASPECT = FRAME_UNITS.w / FRAME_UNITS.h;
/** The frame never gets narrower than this many world units across, nor wider than that. */
const FRAME_W_RANGE = { min: 9, max: 18 } as const;

/** Width to height of the rectangle a flat chart is fitted into: the visible stage less the margins the camera keeps. */
export function stageAspect(stage: ChartStage | null | undefined): number {
  if (!stage) return FRAME_ASPECT;
  const w = Math.max(120, stage.width - SAFE_MARGIN_PX.x);
  const h = Math.max(120, stage.height - SAFE_MARGIN_PX.y);
  return Math.min(2.6, Math.max(0.7, w / h));
}

/**
 * The world rectangle (width and height in units) a flat chart is laid out to fill. The usual stage gives the usual
 * 13 by 8; a stage that is squarer or wider gets a frame of the same shape, so no side of the stage stays empty.
 */
export function frameUnits(stage: ChartStage | null | undefined): { w: number; h: number } {
  if (!stage) return { w: FRAME_UNITS.w, h: FRAME_UNITS.h };
  const a = stageAspect(stage);
  const w = Math.min(FRAME_W_RANGE.max, Math.max(FRAME_W_RANGE.min, FRAME_UNITS.h * a));
  return { w, h: w / a };
}
