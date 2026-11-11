/**
 * The haze silhouette shown within 50 ms of opening a view, before any data arrives (CORTEX-UX §8.4, L5).
 * Owner: E10. Drawn from the same §6.2 geometry the renderer uses (RENDER_TUNING.figure: the crown at +5.00, the
 * torso envelope w(y), the cord tip at -4.02, the lowest strand at -4.36) as a small SVG data URI:
 * a dome brain over a neck, the paired nerves as ribs that follow the envelope, the cord down the centre with its
 * gentle S-curve, a fan at the bottom and a few undated dots along the lowest fibres. No build step and nothing to keep in sync by hand.
 * Standing is drawn upright; Lying is the same drawing turned +90° (x, y) → (-y, x).
 */
import type { Pose } from "../shared/settings";
import { HUMAN_CUMULATIVE, hashUnit } from "./animation";
import { envelopeHalfWidth } from "./layers/lines";
import { RENDER_TUNING } from "./tuning";

const F = RENDER_TUNING.figure;

interface Palette {
  dot: string;
  thread: string;
  rib: string;
  dome: string;
}
const PALETTES: Record<"ink" | "paper", Palette> = {
  ink: { dot: "#b6bbd3", thread: "#d9d4ee", rib: "#8f96b5", dome: "#aab0d8" },
  paper: { dot: "#4a5666", thread: "#3a3550", rib: "#5c667a", dome: "#4b5478" },
};

/** The cord's gentle S-curve: a sideways swing in scene units along the cord. */
export function cordSwing(y: number): number {
  const t = Math.max(0, Math.min(1, (F.brainstemTopY - y) / (F.brainstemTopY - F.cordTipY)));
  return 0.12 * Math.sin(2 * Math.PI * t);
}

function build(stage: "ink" | "paper", pose: Pose): string {
  const p = PALETTES[stage];
  const W = 240, H = 480;
  const unit = H / 10.6;
  const standing = pose === "standing";
  // Figure coordinates (x right, y up) → drawing pixels. Lying turns the figure +90°: (x, y) → (-y, x).
  const at = (x: number, y: number): [number, number] => {
    const fx = standing ? x : -y;
    const fy = standing ? y : x;
    return standing ? [W / 2 + fx * unit, (F.crownY + 0.3 - fy) * unit] : [H / 2 + fx * unit, W / 2 - fy * unit];
  };
  const out: string[] = [];
  const line = (pts: [number, number][], color: string, w: number, o: number): void => {
    const d = pts.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(" ");
    out.push(`<polyline points="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-opacity="${o}" stroke-linecap="round" stroke-linejoin="round"/>`);
  };
  const dome: [number, number][] = [];
  for (let a = 0; a <= 180; a += 12) {
    const r = (a * Math.PI) / 180;
    dome.push(at(Math.cos(r) * 1.42, 4.0 + Math.sin(r) * 1.0));
  }
  line(dome, p.dome, 1.4, 0.55);
  line([at(-1.42, 4.0), at(-0.8, 3.3), at(0.8, 3.3), at(1.42, 4.0)], p.dome, 1.1, 0.35);
  const cord: [number, number][] = [];
  for (let y = F.brainstemTopY; y >= F.cordTipY; y -= 0.25) cord.push(at(cordSwing(y), y));
  line(cord, p.thread, 1.6, 0.85);
  for (let i = 0; i < 31; i++) {
    const y = 2.6 - (i / 30) * (2.6 - F.lowestNerveY - 0.2);
    const w = Math.min(envelopeHalfWidth(y), 3.02);
    for (const side of [-1, 1]) {
      const pts: [number, number][] = [];
      for (let k = 0; k <= 8; k++) {
        const u = k / 8;
        const x = side * w * Math.sin((u * Math.PI) / 2) * (0.35 + 0.65 * u);
        const yy = y - u * u * (0.5 + 0.02 * (30 - i));
        pts.push(at(cordSwing(y) + x, Math.max(F.lowestNerveY, yy)));
      }
      line(pts, p.rib, 0.8, i % 2 === 0 ? 0.32 : 0.2);
    }
  }
  for (let k = -4; k <= 4; k++) line([at(0, F.cordTipY), at(k * 0.16, F.lowestNerveY)], p.rib, 0.7, 0.3);
  for (let k = 0; k < 26; k++) {
    const y0 = F.undatedLowY + 0.1 + Math.abs(Math.sin(k * 4.1414)) * 2.2;
    const [x, y] = at(Math.sin(k * 12.9898) * 0.8 * envelopeHalfWidth(y0), y0);
    out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="0.9" fill="${p.dot}" fill-opacity="0.45"/>`);
  }
  const vw = standing ? W : H;
  const vh = standing ? H : W;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}" width="${vw}" height="${vh}"><defs><filter id="b"><feGaussianBlur stdDeviation="0.6"/></filter></defs><g filter="url(#b)">${out.join("")}</g></svg>`;
}

const cache = new Map<string, string>();

/** A `data:image/svg+xml` URI of the haze silhouette for a stage and pose (cached). */
export function silhouetteFor(stage: "ink" | "paper", pose: Pose = "standing"): string {
  const key = `${stage}/${pose}`;
  let uri = cache.get(key);
  if (!uri) {
    uri = `data:image/svg+xml;utf8,${encodeURIComponent(build(stage, pose))}`;
    cache.set(key, uri);
  }
  return uri;
}

// ───────────────────────────── transit pose (FIG-40) ─────────────────────────────

const HUMAN = RENDER_TUNING.transit;
/**
 * The point of the humanoid transit pose (head ring, torso, arms, legs) that data point `index` takes, in the figure's own
 * units (x right, y up, z toward the viewer): a pure function of the index through the shared PCG hash, so the shader
 * (shaders.ts, `humanoid`) and the tests see the same pose without any buffer. Salts 0..4 of hashUnit are used.
 */
export function humanoidPoint(index: number): [number, number, number] {
  const part = hashUnit(index, 0);
  const t = hashUnit(index, 1);
  const u = hashUnit(index, 2);
  const side = hashUnit(index, 3) < 0.5 ? -1 : 1;
  const zz = (hashUnit(index, 4) - 0.5) * 2 * HUMAN.depth;
  let k = HUMAN_CUMULATIVE.findIndex((c) => part <= c);
  if (k < 0) k = HUMAN.parts.length - 1;
  const p = HUMAN.parts[k] as (typeof HUMAN.parts)[number];
  const [a, b, c, d] = p.a;
  if (p.shape === 0) {
    const ang = t * 2 * Math.PI;
    const r = c + (u - 0.5) * p.width;
    return [a + Math.cos(ang) * r, b + Math.sin(ang) * r, zz];
  }
  if (p.shape === 1) return [a + (c - a) * t, b + (d - b) * u, zz];
  // A limb: along the segment from (a, b) to (c, d), thickness across it, mirrored for the left side.
  const dx = c - a, dy = d - b;
  const len = Math.hypot(dx, dy) || 1;
  const off = (u - 0.5) * p.width;
  const x = a + dx * t + (-dy / len) * off;
  const y = b + dy * t + (dx / len) * off;
  return [side * x, y, zz];
}
