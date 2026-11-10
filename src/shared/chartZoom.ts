/**
 * Chart semantic zoom (shared by the worker's layout-time labels and the overlay's view-time labels). A cell that spans
 * about 120 px on screen names its biggest members; its count gives way. The worker names the busiest cells when it
 * lays the chart out (worker/charts/annotations.ts). A quiet cell is never among them, so the worker also returns the
 * members of those cells (`ArrangementResult.zoomMembers`) and, once the chart is zoomed in, the overlay names the cells
 * under the current view too (`pickZoomCells` per camera change), capped for performance.
 */
import type { Vec3 } from "./protocol/worker";

/** 18 px label threshold over the ≈ 120 px a cell must span before its members are named. */
export const GIVE_WAY = 18 / 120;
export const MEMBERS_PER_CELL = 8;
export const MEMBER_LABEL_MAX = 28;
/** Most member labels the overlay adds for the cells under the view (on top of the layout's own). */
export const ZOOM_LABEL_CAP = 240;
/** Cells the overlay names at once. */
export const ZOOM_CELL_CAP = 60;

export interface ZoomMark {
  bounds: { min: Vec3; max: Vec3 };
  count: number;
}

export interface ZoomProjected {
  x: number;
  y: number;
  visible: boolean;
}

/**
 * The cells to name for the current view, biggest on screen first: the cell is on screen, spans the threshold
 * (`GIVE_WAY` × side ≥ 18 px) and is among the `cells` biggest; members run out at `labels` labels in all.
 */
export function pickZoomCells(
  marks: readonly ZoomMark[],
  candidates: ReadonlyMap<number, readonly number[]>,
  project: (p: Vec3) => ZoomProjected,
  view: { width: number; height: number },
  caps: { cells: number; labels: number } = { cells: ZOOM_CELL_CAP, labels: ZOOM_LABEL_CAP },
): number[] {
  const hits: { mark: number; px: number }[] = [];
  for (const mark of candidates.keys()) {
    const { min, max } = (marks[mark] as ZoomMark).bounds;
    const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, cz = max[2] + 0.02;
    const side = Math.min(max[0] - min[0], max[1] - min[1]);
    const p = project([cx, cy, cz]);
    if (!p.visible) continue;
    const q = project([cx, cy + 1, cz]);
    const px = Math.hypot(q.x - p.x, q.y - p.y) * side;
    if (px * GIVE_WAY < 18) continue;
    const half = px / 2;
    if (p.x + half < 0 || p.x - half > view.width || p.y + half < 0 || p.y - half > view.height) continue;
    hits.push({ mark, px });
  }
  hits.sort((a, b) => b.px - a.px || a.mark - b.mark);
  const out: number[] = [];
  let labels = 0;
  for (const h of hits) {
    if (out.length >= caps.cells) break;
    const n = candidates.get(h.mark)?.length ?? 0;
    if (labels + n > caps.labels) break;
    out.push(h.mark);
    labels += n;
  }
  return out;
}

/** The text shown for a note's title: whitespace collapsed, long titles cut. Empty when there is no title. */
export function memberLabelText(title: string): string {
  const t = title.replace(/\s+/g, " ").trim();
  return t.length > MEMBER_LABEL_MAX ? `${t.slice(0, MEMBER_LABEL_MAX - 1)}…` : t;
}

// ───────────────────────────── growing and fading counts ─────────────────────────────

/** The count's text never grows past this multiple of its base size. */
export const COUNT_SCALE_MAX = 1.8;
/** Share of the give-way threshold over which a count fades out before the member titles take over. */
export const GIVE_WAY_BAND = 0.4;

/** Text scale of a cell's count while the cell is `px` wide on screen: 1 at the 18 px threshold, up to `COUNT_SCALE_MAX`. */
export function countScale(px: number, min = 18): number {
  if (!(px > 0) || !(min > 0)) return 1;
  return Math.min(COUNT_SCALE_MAX, Math.max(1, px / min));
}

/**
 * Opacity of a count that gives way to member titles. `px` is the cell's size times `GIVE_WAY`; the count is full
 * below (1 - `GIVE_WAY_BAND`) × 18 px, gone at 18 px, and fades in between instead of switching off.
 */
export function giveWayOpacity(px: number, threshold = 18): number {
  const from = threshold * (1 - GIVE_WAY_BAND);
  if (px <= from) return 1;
  if (px >= threshold) return 0;
  return 1 - (px - from) / (threshold - from);
}
