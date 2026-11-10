/**
 * "Save image…" (CORTEX-UX §5.28, §7.4; L3). Owner: E10.
 * Renders the current leaf offscreen at twice the canvas size (the same scene, camera and stage background, so the
 * picture is self-contained), composites the overlays (chart rules, axis and group labels from the arrangement's
 * overlay model, and the name chips on screen), encodes PNG and returns the bytes for plugin/saveFile.ts (system
 * Save dialog, else Downloads). Nothing here touches the disk.
 */
import { projectOverlay } from "./overlay";
import type { CortexRenderer } from "./renderer";

export const EXPORT_SCALE = 2;

const FONT = "11px system-ui, -apple-system, 'Segoe UI', sans-serif";

/** Whether the picture is drawn on a light stage (the label ink flips): mean luminance of a sparse grid. */
function isLight(px: Uint8Array): boolean {
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 2 < px.length; i += 4 * 997) {
    sum += (0.2126 * (px[i] as number) + 0.7152 * (px[i + 1] as number) + 0.0722 * (px[i + 2] as number)) / 255;
    n++;
  }
  return n > 0 && sum / n > 0.5;
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

export async function renderPicture(renderer: CortexRenderer, overlay: HTMLElement | null, scale = EXPORT_SCALE): Promise<Uint8Array> {
  const px = renderer.renderPixels(scale);
  if (!px) throw new Error("The 3D view is not available, so there is nothing to save.");
  const doc = overlay?.ownerDocument ?? document;
  const c = doc.createElement("canvas");
  c.width = px.width;
  c.height = px.height;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("A 2D canvas is not available.");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(px.data.buffer.slice(0) as ArrayBuffer), px.width, px.height), 0, 0);
  const geom = renderer.stageGeom();
  const k = px.width / Math.max(1, geom.width);
  const light = isLight(px.data);
  const ink = light ? "20,22,28" : "236,238,244";
  ctx.save();
  ctx.scale(k, k);
  ctx.font = FONT;
  ctx.textBaseline = "middle";
  const items = projectOverlay(renderer.overlay(), renderer.camera.camera, geom.width, geom.height);
  for (const it of items) {
    switch (it.type) {
      case "line":
        ctx.strokeStyle = `rgba(${ink},${it.alpha})`;
        ctx.lineWidth = 1;
        ctx.setLineDash(it.dashed ? [4, 3] : []);
        ctx.beginPath();
        ctx.moveTo(it.x0, it.y0);
        ctx.lineTo(it.x1, it.y1);
        ctx.stroke();
        break;
      case "polyline":
        ctx.strokeStyle = `rgba(${ink},${it.alpha})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        for (let i = 0; i + 1 < it.points.length; i += 2) {
          if (i === 0) ctx.moveTo(it.points[0] as number, it.points[1] as number);
          else ctx.lineTo(it.points[i] as number, it.points[i + 1] as number);
        }
        if (it.closed) ctx.closePath();
        ctx.stroke();
        break;
      case "rect":
        ctx.setLineDash([]);
        if (it.fill > 0) {
          ctx.fillStyle = `rgba(${ink},${it.fill})`;
          ctx.fillRect(it.x0, it.y0, it.x1 - it.x0, it.y1 - it.y0);
        }
        ctx.strokeStyle = `rgba(${ink},${it.alpha})`;
        ctx.strokeRect(it.x0, it.y0, it.x1 - it.x0, it.y1 - it.y0);
        break;
      case "ring":
        ctx.setLineDash([]);
        ctx.strokeStyle = `rgba(${ink},0.6)`;
        ctx.beginPath();
        ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
        if (it.hue !== undefined) {
          ctx.fillStyle = `hsl(${Math.round(it.hue)}, 78%, 64%)`;
          ctx.fill();
        } else ctx.stroke();
        break;
      case "label": {
        const l = it.label;
        ctx.save();
        ctx.translate(l.x, l.y);
        if (l.rotate) ctx.rotate((l.rotate * Math.PI) / 180);
        ctx.textAlign = l.align === "left" ? "left" : l.align === "right" ? "right" : "center";
        ctx.fillStyle = `rgba(${ink},${l.style === "muted" ? l.opacity * 0.6 : l.opacity})`;
        // Chart labels that name a copy key or a category are resolved by the overlay; use its text when it has one.
        const shown = overlay ? overlay.querySelector<HTMLElement>(`[data-cx-label-key="${cssEscape(l.key)}"]`)?.textContent : null;
        ctx.fillText(shown ? shown : l.text, 0, 0);
        ctx.restore();
        break;
      }
    }
  }
  // The name chips currently on the figure (HTML in the overlay host): drawn as plain text on a plate.
  if (overlay) {
    const host = overlay.getBoundingClientRect();
    ctx.setLineDash([]);
    ctx.textAlign = "left";
    for (const chip of Array.from(overlay.querySelectorAll<HTMLElement>("[data-cx-chip]"))) {
      const r = chip.getBoundingClientRect();
      const text = (chip.textContent ?? "").trim();
      if (!text || r.width === 0) continue;
      const x = r.left - host.left, y = r.top - host.top;
      ctx.fillStyle = `rgba(${light ? "255,255,255" : "18,20,26"},0.82)`;
      ctx.fillRect(x, y, r.width, r.height);
      ctx.fillStyle = `rgba(${ink},0.95)`;
      ctx.fillText(text, x + 6, y + r.height / 2);
    }
  }
  ctx.restore();
  const blob = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed."))), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}
