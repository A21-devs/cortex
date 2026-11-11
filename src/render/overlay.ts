/**
 * Projects world-space overlay items (labels, rules, outlines, rings from the worker; label anchors) to screen
 * space for the HTML / 2D overlay, and lays label chips out (CORTEX-UX §5.12, §6.11). Owner: E10. Pure functions
 * over a three Camera: the stage's label layer (E11) and chart overlay (E9) call them from the renderer's frame
 * callback (≤ 30 Hz), and Save image uses them to draw the overlays into the picture.
 */
import { Vector3, type Camera } from "three";
import type { OverlayItem, OverlayModel, Vec3 } from "../shared/protocol/worker";

export interface ScreenPoint {
  x: number;
  y: number;
  /** 0 = nearest … 1 = farthest (for depth fading). */
  depth: number;
  visible: boolean;
}

const tmp = new Vector3();
const tmpView = new Vector3();

export function project(p: Vec3, camera: Camera, width: number, height: number): ScreenPoint {
  tmp.set(p[0], p[1], p[2]).project(camera);
  return { x: (tmp.x * 0.5 + 0.5) * width, y: (-tmp.y * 0.5 + 0.5) * height, depth: tmp.z * 0.5 + 0.5, visible: tmp.z > -1 && tmp.z < 1 };
}

/**
 * Depth fade of a label anchor within a sphere (the figure or an arrangement): nearest 100%, farthest 45%
 * (CORTEX-UX §5.12).
 */
export function depthFade(p: Vec3, camera: Camera, centre: Vec3, radius: number): number {
  tmpView.set(p[0], p[1], p[2]).applyMatrix4(camera.matrixWorldInverse);
  const pz = tmpView.z;
  tmpView.set(centre[0], centre[1], centre[2]).applyMatrix4(camera.matrixWorldInverse);
  const r = Math.max(1e-6, radius);
  const nearness = Math.max(0, Math.min(1, (pz - (tmpView.z - r)) / (2 * r)));
  return 0.45 + 0.55 * nearness;
}

export interface ScreenLabel {
  key: string;
  text: string;
  x: number;
  y: number;
  opacity: number;
  style: "box" | "tile" | "axis" | "muted" | "title";
  align: "left" | "center" | "right";
  rotate: number;
}

/** Labels only (lines/rects are projected by projectOverlay). */
export function projectLabels(items: readonly OverlayItem[], camera: Camera, width: number, height: number, sphere?: { centre: Vec3; radius: number }): ScreenLabel[] {
  const out: ScreenLabel[] = [];
  items.forEach((it, i) => {
    if (it.type !== "label") return;
    if (it.screen) {
      out.push({ key: it.key ?? String(i), text: it.text, x: it.at[0], y: it.at[1], opacity: 1, style: it.style, align: it.align ?? "center", rotate: it.rotate ?? 0 });
      return;
    }
    const s = project(it.at, camera, width, height);
    if (!s.visible) return;
    const opacity = sphere ? depthFade(it.at, camera, sphere.centre, sphere.radius) : 1 - 0.55 * s.depth;
    out.push({ key: it.key ?? String(i), text: it.text, x: s.x, y: s.y, opacity, style: it.style, align: it.align ?? "center", rotate: it.rotate ?? 0 });
  });
  return out;
}

/** Screen-space primitives of an overlay model (CSS px), ready to draw on a 2D canvas or as SVG. */
export type ScreenOverlayItem =
  | { type: "label"; label: ScreenLabel }
  | { type: "line"; x0: number; y0: number; x1: number; y1: number; alpha: number; dashed: boolean }
  | { type: "polyline"; points: number[]; alpha: number; closed: boolean }
  | { type: "rect"; x0: number; y0: number; x1: number; y1: number; alpha: number; fill: number }
  | { type: "ring"; x: number; y: number; r: number; count: number; hue?: number };

export function projectOverlay(model: OverlayModel | null, camera: Camera, width: number, height: number): ScreenOverlayItem[] {
  if (!model) return [];
  const out: ScreenOverlayItem[] = [];
  model.items.forEach((it, i) => {
    switch (it.type) {
      case "label": {
        if (it.screen) {
          out.push({ type: "label", label: { key: it.key ?? String(i), text: it.text, x: it.at[0], y: it.at[1], opacity: 1, style: it.style, align: it.align ?? "center", rotate: it.rotate ?? 0 } });
          return;
        }
        const s = project(it.at, camera, width, height);
        if (s.visible) out.push({ type: "label", label: { key: it.key ?? String(i), text: it.text, x: s.x, y: s.y, opacity: 1 - 0.55 * s.depth, style: it.style, align: it.align ?? "center", rotate: it.rotate ?? 0 } });
        return;
      }
      case "line": {
        const a = project(it.a, camera, width, height);
        const b = project(it.b, camera, width, height);
        if (a.visible && b.visible) out.push({ type: "line", x0: a.x, y0: a.y, x1: b.x, y1: b.y, alpha: it.alpha, dashed: it.dashed === true });
        return;
      }
      case "polyline": {
        const pts: number[] = [];
        for (const p of it.points) {
          const s = project(p, camera, width, height);
          if (!s.visible) return;
          pts.push(s.x, s.y);
        }
        if (pts.length >= 4) out.push({ type: "polyline", points: pts, alpha: it.alpha, closed: it.closed === true });
        return;
      }
      case "rect": {
        const corners: Vec3[] = [
          [it.min[0], it.min[1], it.min[2]],
          [it.max[0], it.min[1], it.min[2]],
          [it.min[0], it.max[1], it.min[2]],
          [it.max[0], it.max[1], it.max[2]],
        ];
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const c of corners) {
          const s = project(c, camera, width, height);
          if (!s.visible) return;
          x0 = Math.min(x0, s.x);
          y0 = Math.min(y0, s.y);
          x1 = Math.max(x1, s.x);
          y1 = Math.max(y1, s.y);
        }
        out.push({ type: "rect", x0, y0, x1, y1, alpha: it.alpha, fill: it.fill ?? 0 });
        return;
      }
      case "ring": {
        const c = project(it.at, camera, width, height);
        if (!c.visible) return;
        // Radius: project a point one radius away along the camera's right axis.
        tmp.set(1, 0, 0).applyQuaternion(camera.quaternion);
        const e = project([it.at[0] + tmp.x * it.radius, it.at[1] + tmp.y * it.radius, it.at[2] + tmp.z * it.radius], camera, width, height);
        out.push({ type: "ring", x: c.x, y: c.y, r: Math.hypot(e.x - c.x, e.y - c.y), count: it.count, ...(it.hue !== undefined ? { hue: it.hue } : {}) });
        return;
      }
    }
  });
  return out;
}

// ───────────────────────────── label chip layout (§6.11) ─────────────────────────────

export interface ChipInput {
  key: string;
  /** Anchor (the point) in CSS px. */
  ax: number;
  ay: number;
  /** Chip size in CSS px. */
  w: number;
  h: number;
  /** Higher first: selected > the selection's notes > traced > largest. */
  priority: number;
}

export interface ChipPlaced {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  ax: number;
  ay: number;
  /** Nearest point of the chip's outline to its anchor (the leader's end). */
  lx: number;
  ly: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const LABEL_LAYOUT = { max: 24, iterations: 6, gapPx: 4, anchorGapPx: 8 } as const;

/**
 * The standing figure's two label columns (§6.11): chips go either side of the brain, each at its anchor's height
 * and in the column on its anchor's side. `leftX` is where the left column's chips end (right-aligned), `rightX`
 * where the right column's chips start, both just outside the brain's projected width, so chips never sit over
 * the torso.
 */
export interface LabelColumns {
  leftX: number;
  rightX: number;
}

/** Brain's projected width → the two column edges, `gap` px clear of it. */
export function labelColumnsFor(brainLeftPx: number, brainRightPx: number, gap = LABEL_LAYOUT.anchorGapPx + 4): LabelColumns {
  return { leftX: brainLeftPx - gap, rightX: brainRightPx + gap };
}

/**
 * Keep the top 24 chips by priority whose anchors are on screen and outside the overlay rectangles, place each
 * just above-right of its anchor, then relax: 6 iterations of a simple repulsion keeping chips 4 px apart and 8 px
 * from their anchors, pushed out of the overlay rectangles. Deterministic for the same input.
 */
export function layoutChips(chips: readonly ChipInput[], bounds: Rect, blockers: readonly Rect[] = [], columns?: LabelColumns): ChipPlaced[] {
  const inside = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
  const kept = chips
    .filter((c) => Number.isFinite(c.ax) && Number.isFinite(c.ay) && inside(bounds, c.ax, c.ay) && !blockers.some((b) => inside(b, c.ax, c.ay)))
    .sort((a, b) => b.priority - a.priority || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, LABEL_LAYOUT.max);
  const g = LABEL_LAYOUT.anchorGapPx;
  const mid = columns ? (columns.leftX + columns.rightX) / 2 : 0;
  const placed = kept.map((c) => {
    if (!columns) return { key: c.key, x: c.ax + g, y: c.ay - g - c.h, w: c.w, h: c.h, ax: c.ax, ay: c.ay, lx: c.ax, ly: c.ay };
    const left = c.ax < mid;
    return { key: c.key, x: left ? columns.leftX - c.w : columns.rightX, y: c.ay - c.h / 2, w: c.w, h: c.h, ax: c.ax, ay: c.ay, lx: c.ax, ly: c.ay };
  });
  for (let it = 0; it < LABEL_LAYOUT.iterations; it++) {
    for (let i = 0; i < placed.length; i++) {
      const a = placed[i] as ChipPlaced;
      for (let j = i + 1; j < placed.length; j++) {
        const b = placed[j] as ChipPlaced;
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + LABEL_LAYOUT.gapPx;
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + LABEL_LAYOUT.gapPx;
        if (ox <= 0 || oy <= 0) continue;
        // Separate along the axis of least overlap; the lower-priority chip (later) moves more.
        if (columns || oy < ox) {
          const dir = a.y + a.h / 2 <= b.y + b.h / 2 ? 1 : -1;
          a.y -= (dir * oy) / 3;
          b.y += (dir * oy * 2) / 3;
        } else {
          const dir = a.x + a.w / 2 <= b.x + b.w / 2 ? 1 : -1;
          a.x -= (dir * ox) / 3;
          b.x += (dir * ox * 2) / 3;
        }
      }
    }
    for (const c of placed) {
      // Keep the anchor gap: the chip may not cover its own point (column chips sit beside it, never over it).
      if (columns) {
        for (const b of blockers) {
          const oy = Math.min(c.y + c.h, b.y1) - Math.max(c.y, b.y0);
          const ox = Math.min(c.x + c.w, b.x1) - Math.max(c.x, b.x0);
          if (ox > 0 && oy > 0) c.y = c.y + c.h / 2 < (b.y0 + b.y1) / 2 ? b.y0 - c.h - LABEL_LAYOUT.gapPx : b.y1 + LABEL_LAYOUT.gapPx;
        }
        c.y = Math.max(bounds.y0, Math.min(bounds.y1 - c.h, c.y));
        continue;
      }
      const nx = Math.max(c.x, Math.min(c.ax, c.x + c.w));
      const ny = Math.max(c.y, Math.min(c.ay, c.y + c.h));
      const d = Math.hypot(nx - c.ax, ny - c.ay);
      if (d < g) {
        if (c.ay >= c.y + c.h / 2) c.y = c.ay - g - c.h;
        else c.y = c.ay + g;
      }
      for (const b of blockers) {
        const ox = Math.min(c.x + c.w, b.x1) - Math.max(c.x, b.x0);
        const oy = Math.min(c.y + c.h, b.y1) - Math.max(c.y, b.y0);
        if (ox > 0 && oy > 0) {
          if (oy < ox) c.y = c.y + c.h / 2 < (b.y0 + b.y1) / 2 ? b.y0 - c.h - LABEL_LAYOUT.gapPx : b.y1 + LABEL_LAYOUT.gapPx;
          else c.x = c.x + c.w / 2 < (b.x0 + b.x1) / 2 ? b.x0 - c.w - LABEL_LAYOUT.gapPx : b.x1 + LABEL_LAYOUT.gapPx;
        }
      }
      c.x = Math.max(bounds.x0, Math.min(bounds.x1 - c.w, c.x));
      c.y = Math.max(bounds.y0, Math.min(bounds.y1 - c.h, c.y));
    }
  }
  for (const c of placed) {
    c.lx = Math.max(c.x, Math.min(c.ax, c.x + c.w));
    c.ly = Math.max(c.y, Math.min(c.ay, c.y + c.h));
  }
  return placed;
}
