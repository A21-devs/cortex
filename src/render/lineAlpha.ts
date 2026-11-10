/**
 * Alpha of the drawn lines while something is selected (CORTEX-UX §6.10: source lines are white at 34–50%).
 * The selection's own lines are drawn at the tuned alphas as they are (0.5 at the entry end … 0.34 at the note
 * end, before the depth cue). Lines drawn for everything shown (Lines: All, stems) dim to half while a selection
 * exists, so the selection's lines stand out from them. Pure, so the effective values can be tested.
 */
import { RENDER_TUNING } from "./tuning";

/** Multiplier on lines that are not the selection's own while a selection exists. */
export const OTHER_LINES_DIM_WHILE_SELECTED = 0.5;

/** Per-segment vertex alpha (0..1): 1 for the selection's own lines, the dim for the rest while selecting. */
export function lineVertexAlpha(own: boolean, selecting: boolean): number {
  return own || !selecting ? 1 : OTHER_LINES_DIM_WHILE_SELECTED;
}

/** Vertex alpha as the Uint8 the colour buffer holds. */
export function lineVertexAlpha8(own: boolean, selecting: boolean): number {
  return Math.round(255 * lineVertexAlpha(own, selecting));
}

/**
 * Alpha of the note-link fibres for the camera's distance (FIG-62): faint (0.05) at the home distance and further out,
 * rising smoothly to 0.18 by the time the camera is closer than 0.6 × home, so they read across the cerebrum zoomed in.
 */
export function linkAlpha(distance: number, homeDistance: number): number {
  const L = RENDER_TUNING.lines;
  if (!(homeDistance > 0) || !Number.isFinite(distance)) return L.linkAlpha;
  const k = Math.max(0, Math.min(1, (homeDistance - distance) / (homeDistance * (1 - L.linkZoom))));
  const s = k * k * (3 - 2 * k);
  return L.linkAlpha + (L.linkAlphaNear - L.linkAlpha) * s;
}

/** Alpha of the conversation stems for the Stems strength (0 hides them, 1 is full): the strength itself. */
export function stemAlpha(strength: number): number {
  return Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
}

/** The alpha a source line ends at, near and far end (before the depth cue), for a segment of the given kind. */
export function effectiveSourceAlpha(own: boolean, selecting: boolean): { near: number; far: number } {
  const v = lineVertexAlpha8(own, selecting) / 255;
  return { near: RENDER_TUNING.lines.sourceAlpha * v, far: RENDER_TUNING.lines.sourceAlphaFar * v };
}
