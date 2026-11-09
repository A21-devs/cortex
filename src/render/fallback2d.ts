/**
 * Static 2D picture used when WebGL2 is unavailable (CORTEX-UX §6.14): the figure from its home view direction as
 * an orthographic still, framed like the 3D home view (standing: crown 9% below the top, the lowest point 68 px
 * above the bottom, centred on the free stage; lying: the safe frame), points at 1.3 px and 85% alpha with
 * "lighter" compositing on Ink (normal on Paper), the haze faintly behind them. Owner: E10.
 */
import type { Pose } from "../shared/settings";
import { cameraBasis, homeAngles, safeRect, type StageGeom } from "./camera";
import { RENDER_TUNING } from "./tuning";

export const FALLBACK_DOT_PX = 1.3;
export const FALLBACK_ALPHA = 0.85;

export interface FallbackScene {
  pose: Pose;
  stage: "ink" | "paper";
  /** Stage colours (CSS hex). */
  background: { stage: string; lift: string };
  /** Data points: xyz, RGBA8 colours, and an optional visibility mask (1 = draw). */
  points: { pos: Float32Array; color: Uint8Array; count: number; visible?: Uint8Array };
  haze?: { pos: Float32Array; color: Uint8Array; count: number };
}

export interface FallbackFrame {
  /** Screen = (x·r) * scale + offsetX, −(x·u) * scale + offsetY. */
  scale: number;
  offsetX: number;
  offsetY: number;
  yawDeg: number;
  pitchDeg: number;
}

/** Orthographic framing of the points from the pose's home direction, fitted like the 3D home view. */
export function fallbackFrame(scene: FallbackScene, g: StageGeom): FallbackFrame | null {
  const { yawDeg, pitchDeg } = homeAngles(scene.pose);
  const b = cameraBasis(yawDeg, pitchDeg);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  const scan = (pos: Float32Array, n: number, mask?: Uint8Array) => {
    for (let i = 0; i < n; i++) {
      if (mask && !mask[i]) continue;
      const x = pos[i * 3] as number, y = pos[i * 3 + 1] as number, z = pos[i * 3 + 2] as number;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      const u = x * b.r[0] + y * b.r[1] + z * b.r[2];
      const v = x * b.u[0] + y * b.u[1] + z * b.u[2];
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
  };
  scan(scene.points.pos, scene.points.count, scene.points.visible);
  if (scene.haze) scan(scene.haze.pos, scene.haze.count);
  if (!Number.isFinite(u0) || !Number.isFinite(v0)) return null;
  const du = Math.max(1e-6, u1 - u0);
  const dv = Math.max(1e-6, v1 - v0);
  const free = { x0: Math.max(0, g.insetLeft), w: Math.max(1, g.width - Math.max(0, g.insetLeft) - Math.max(0, g.insetRight)) };
  if (scene.pose === "standing") {
    const F = RENDER_TUNING.frame.standing;
    const top = F.topFrac * g.height;
    const bottom = Math.max(top + 1, g.height - F.bottomClearPx);
    const scale = Math.min((bottom - top) / dv, (free.w - F.centreLeftPx - F.centreRightPx) / du);
    const xc = free.x0 + (F.centreLeftPx + free.w - F.centreRightPx) / 2;
    return { scale, offsetX: xc - ((u0 + u1) / 2) * scale, offsetY: top + v1 * scale, yawDeg, pitchDeg };
  }
  const r = safeRect(g);
  const m = RENDER_TUNING.frame.lying.margin;
  const scale = Math.min(((r.x1 - r.x0) * (1 - 2 * m)) / du, ((r.y1 - r.y0) * (1 - 2 * m)) / dv);
  return { scale, offsetX: (r.x0 + r.x1) / 2 - ((u0 + u1) / 2) * scale, offsetY: (r.y0 + r.y1) / 2 + ((v0 + v1) / 2) * scale, yawDeg, pitchDeg };
}

/** Draw the still. Returns false when there was nothing to draw (the background is still painted). */
export function drawFallback(ctx: CanvasRenderingContext2D, scene: FallbackScene, g: StageGeom, dpr = 1): boolean {
  const w = g.width;
  const h = g.height;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillStyle = scene.background.stage;
  ctx.fillRect(0, 0, w, h);
  const cx = Math.max(0, g.insetLeft) + (w - Math.max(0, g.insetLeft) - Math.max(0, g.insetRight)) / 2;
  const grad = ctx.createRadialGradient(cx, h / 2, 0, cx, h / 2, Math.max(w, h) * 0.6);
  grad.addColorStop(0, scene.background.lift);
  grad.addColorStop(1, scene.background.stage);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const f = fallbackFrame(scene, g);
  if (!f) {
    ctx.restore();
    return false;
  }
  const b = cameraBasis(f.yawDeg, f.pitchDeg);
  const paper = scene.stage === "paper";
  ctx.globalCompositeOperation = paper ? "source-over" : "lighter";
  const plot = (pos: Float32Array, col: Uint8Array, n: number, size: number, alpha: number, mask?: Uint8Array) => {
    let last = "";
    for (let i = 0; i < n; i++) {
      if (mask && !mask[i]) continue;
      const x = pos[i * 3] as number, y = pos[i * 3 + 1] as number, z = pos[i * 3 + 2] as number;
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      const a = ((col[i * 4 + 3] ?? 255) / 255) * alpha;
      if (a <= 0.003) continue;
      const sx = (x * b.r[0] + y * b.r[1] + z * b.r[2]) * f.scale + f.offsetX;
      const sy = -(x * b.u[0] + y * b.u[1] + z * b.u[2]) * f.scale + f.offsetY;
      if (sx < -2 || sy < -2 || sx > w + 2 || sy > h + 2) continue;
      const style = `rgba(${col[i * 4] ?? 0},${col[i * 4 + 1] ?? 0},${col[i * 4 + 2] ?? 0},${a.toFixed(3)})`;
      if (style !== last) {
        ctx.fillStyle = style;
        last = style;
      }
      ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
    }
  };
  if (scene.haze) plot(scene.haze.pos, scene.haze.color, scene.haze.count, 1, paper ? 0.18 : 0.28);
  plot(scene.points.pos, scene.points.color, scene.points.count, FALLBACK_DOT_PX, FALLBACK_ALPHA, scene.points.visible);
  ctx.restore();
  return true;
}
