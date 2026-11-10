/**
 * The cursor over the 3D canvas (pure; the controller writes the result to the canvas' `data-cursor`, stage.css
 * turns it into a CSS cursor). Owner: P03.
 *   pointer   over a point, a label or a hub (something a click opens)
 *   grab      empty canvas: a drag orbits
 *   grabbing  while a drag is turning or panning the view
 *   zoom-dot  a chart zoomed in past the point where its cells name their members (a small white circle)
 */
import type { Vec3 } from "../shared/protocol/worker";
import { GIVE_WAY } from "../shared/chartZoom";

export type CanvasCursor = "pointer" | "grab" | "grabbing" | "zoom-dot";

export interface CursorState {
  /** A button is down and the pointer has dragged (orbit or pan). */
  dragging: boolean;
  /** The pointer is over a point, a label chip or a hub. */
  overTarget: boolean;
  /** A chart is shown and zoomed past the GIVE_WAY threshold. */
  deepZoom: boolean;
}

export function canvasCursor(s: CursorState): CanvasCursor {
  if (s.dragging) return "grabbing";
  if (s.overTarget) return "pointer";
  if (s.deepZoom) return "zoom-dot";
  return "grab";
}

export interface CursorMark {
  bounds: { min: Vec3; max: Vec3 };
}

/**
 * True when any chart cell on screen spans enough for its members to be named (`GIVE_WAY` × its side ≥ 18 px):
 * the same test the chart overlay uses, so the dot cursor appears exactly when the zoom has "arrived".
 */
export function chartZoomedPastGiveWay(
  marks: readonly CursorMark[],
  project: (p: Vec3) => { x: number; y: number; visible: boolean },
  view: { width: number; height: number },
): boolean {
  for (const m of marks) {
    const { min, max } = m.bounds;
    const side = Math.min(max[0] - min[0], max[1] - min[1]);
    if (!(side > 0)) continue;
    const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, cz = max[2] + 0.02;
    const p = project([cx, cy, cz]);
    if (!p.visible) continue;
    const q = project([cx, cy + 1, cz]);
    const px = Math.hypot(q.x - p.x, q.y - p.y) * side;
    if (px * GIVE_WAY < 18) continue;
    const half = px / 2;
    if (p.x + half < 0 || p.x - half > view.width || p.y + half < 0 || p.y - half > view.height) continue;
    return true;
  }
  return false;
}
