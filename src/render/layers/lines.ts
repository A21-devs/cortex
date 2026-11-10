/**
 * Line families (CORTEX-UX §6.10, §12.7): source lines (note → its source entries; quadratic curves whose control
 * point sits level with the chord's middle on the entry's side of the cord, 2 × w(y) + 0.2 from the axis, so they
 * pass outside the torso and never cross the cord; white at 34–50%, drawn on over 280 ms from the source end),
 * conversation stems (alpha = the Stems strength, 10% by default), note-link fibres (faint, brighter zoomed in) and map spokes (straight, territory colour at 55%, on selection only).
 * All 1 px, premultiplied additive and multiplied by the depth cue; the per-vertex t drives the draw-on. Label
 * leaders are HTML/SVG (ui/stage/LabelLayer). Hovering a line names it: `nearestSegment` is the hover pick over
 * the segments projected with `projectSegments`. Owner: E10.
 */
import { BufferAttribute, BufferGeometry, GLSL3, LineSegments, RawShaderMaterial, Vector3, Vector4, type Camera, type IUniform } from "three";
import { LINES_FRAG, LINES_VERT } from "../shaders";
import { RENDER_TUNING } from "../tuning";
import { setPointBlending } from "./points";

/** Index order = LINE_FAMILIES in shared/protocol/worker.ts. */
export const LINE_FAMILY = { Source: 0, Stem: 1, Spoke: 2, Link: 3 } as const;
export type LineFamily = (typeof LINE_FAMILY)[keyof typeof LINE_FAMILY];

const L = RENDER_TUNING.lines;
/** Base alpha per family: source 50% (34% at the far end of the draw-on), stem 10%, spoke 55%. */
export const LINE_ALPHA: Readonly<Record<LineFamily, number>> = { 0: L.sourceAlpha, 1: L.stemAlpha, 2: L.spokeAlpha, 3: L.linkAlpha };
/** Alpha at t = 0 (the source end); equal to LINE_ALPHA for stems and spokes. */
export const LINE_ALPHA_FAR: Readonly<Record<LineFamily, number>> = { 0: L.sourceAlphaFar, 1: L.stemAlpha, 2: L.spokeAlpha, 3: L.linkAlpha };
export const DRAW_ON_MS = L.drawOnMs;
/** Hover pick tolerance in CSS px. */
export const LINE_PICK_PX = L.pickPx;

/**
 * Nearest projected segment to a pointer (screen-space, CSS px), or -1 beyond `tolerance`. `screen` holds the
 * projected endpoints as [x0, y0, x1, y1] per segment; segments with a NaN endpoint (behind the camera) are skipped.
 */
export function nearestSegment(screen: Float32Array, px: number, py: number, tolerance = LINE_PICK_PX): number {
  let best = -1;
  let bestD = tolerance * tolerance;
  for (let i = 0; i + 3 < screen.length; i += 4) {
    const x0 = screen[i] as number, y0 = screen[i + 1] as number, x1 = screen[i + 2] as number, y1 = screen[i + 3] as number;
    if (Number.isNaN(x0) || Number.isNaN(y0) || Number.isNaN(x1) || Number.isNaN(y1)) continue;
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const u = len2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
    const ex = x0 + u * dx - px, ey = y0 + u * dy - py;
    const d = ex * ex + ey * ey;
    if (d <= bestD) {
      bestD = d;
      best = i / 4;
    }
  }
  return best;
}

const tmp = new Vector3();

// ───────────────────────────── source-line routing (§6.10) ─────────────────────────────

const ENV = RENDER_TUNING.figure.envelope;

/** Torso half-width w(y) (§6.2): piecewise linear through the table, smoothed over ±0.2, clamped to the end values
 *  above and below the table. */
export function envelopeHalfWidth(y: number): number {
  const raw = (v: number): number => {
    const ys = ENV.y, ws = ENV.halfWidth;
    if (v >= (ys[0] as number)) return ws[0] as number;
    if (v <= (ys[ys.length - 1] as number)) return ws[ws.length - 1] as number;
    for (let i = 0; i + 1 < ys.length; i++) {
      const y0 = ys[i] as number, y1 = ys[i + 1] as number;
      if (v <= y0 && v >= y1) return (ws[i] as number) + (((ws[i + 1] as number) - (ws[i] as number)) * (y0 - v)) / (y0 - y1);
    }
    return 0;
  };
  const h = ENV.smoothing;
  return (raw(y - h) + 2 * raw(y) + raw(y + h)) / 4;
}

/**
 * One source line as `steps` straight pieces along a quadratic curve from `a` (the note) to `b` (its entry). The
 * control point is level with the chord's middle, on the entry's side of the cord, at 2 × w(y) + 0.2 from the
 * cord axis, so the line leaves the brain and arcs round the torso. Writes steps × 2 points into `out` at `at`.
 */
export function writeSourceCurve(a: readonly [number, number, number], b: readonly [number, number, number], steps: number, out: Float32Array, at: number): void {
  const L = RENDER_TUNING.lines;
  const side = b[0] >= 0 ? 1 : -1;
  const ym = (a[1] + b[1]) / 2;
  const cx = side * (L.ctrlWidthFactor * envelopeHalfWidth(ym) + L.ctrlOffset);
  const cz = (a[2] + b[2]) / 2;
  const at3 = (u: number, o: number): void => {
    const k = 1 - u;
    out[o] = k * k * a[0] + 2 * k * u * cx + u * u * b[0];
    out[o + 1] = k * k * a[1] + 2 * k * u * ym + u * u * b[1];
    out[o + 2] = k * k * a[2] + 2 * k * u * cz + u * u * b[2];
  };
  for (let s = 0; s < steps; s++) {
    at3(s / steps, at + s * 6);
    at3((s + 1) / steps, at + s * 6 + 3);
  }
}

/** Pieces per source line so that `lines` curves stay inside the segment budget. */
export function sourceSteps(lines: number, budget: number = RENDER_TUNING.lines.budget): number {
  const L = RENDER_TUNING.lines;
  return Math.max(L.minSteps, Math.min(L.maxSteps, Math.floor(budget / Math.max(1, lines))));
}

/**
 * Turn the worker's source chords (one note → entry segment each, t = draw-on parameter at both ends, 0 at the
 * entry) into curves. Segment k of the result belongs to chord floor(k / steps), which hover naming uses.
 */
export function routeSourceLines(positions: Float32Array, t: Float32Array, chords: number, budget: number = RENDER_TUNING.lines.budget): { positions: Float32Array; t: Float32Array; steps: number; segments: number } {
  const steps = sourceSteps(chords, budget);
  const outP = new Float32Array(chords * steps * 6);
  const outT = new Float32Array(chords * steps * 2);
  for (let c = 0; c < chords; c++) {
    const a: [number, number, number] = [positions[c * 6] as number, positions[c * 6 + 1] as number, positions[c * 6 + 2] as number];
    const b: [number, number, number] = [positions[c * 6 + 3] as number, positions[c * 6 + 4] as number, positions[c * 6 + 5] as number];
    writeSourceCurve(a, b, steps, outP, c * steps * 6);
    const ta = t[c * 2] ?? 0, tb = t[c * 2 + 1] ?? 1;
    for (let s = 0; s < steps; s++) {
      outT[(c * steps + s) * 2] = ta + ((tb - ta) * s) / steps;
      outT[(c * steps + s) * 2 + 1] = ta + ((tb - ta) * (s + 1)) / steps;
    }
  }
  return { positions: outP, t: outT, steps, segments: chords * steps };
}

/** Project segment endpoints (pairs of xyz) to canvas CSS px; endpoints behind the camera become NaN. */
export function projectSegments(positions: Float32Array, segments: number, camera: Camera, width: number, height: number, out?: Float32Array): Float32Array {
  const res = out && out.length >= segments * 4 ? out : new Float32Array(segments * 4);
  for (let v = 0; v < segments * 2; v++) {
    tmp.set(positions[v * 3] as number, positions[v * 3 + 1] as number, positions[v * 3 + 2] as number).project(camera);
    const ok = tmp.z > -1 && tmp.z < 1 && Number.isFinite(tmp.x) && Number.isFinite(tmp.y);
    res[v * 2] = ok ? (tmp.x * 0.5 + 0.5) * width : Number.NaN;
    res[v * 2 + 1] = ok ? (-tmp.y * 0.5 + 0.5) * height : Number.NaN;
  }
  return res;
}

export interface LineSet {
  positions: Float32Array;
  segments: number;
}

export interface LinesLayer {
  readonly objects: readonly LineSegments[];
  set(family: LineFamily, positions: Float32Array, colors: Uint8Array, t: Float32Array): void;
  clear(family: LineFamily): void;
  /** Animate draw-on 0 → 1 over `ms` from `nowMs` (instant when ms ≤ 0). */
  drawOn(family: LineFamily, ms: number, nowMs: number): void;
  /** Advance draw-on; true while any family is still drawing. */
  update(nowMs: number): boolean;
  /** Segments of a family (CPU copy) for hover picking. */
  segments(family: LineFamily): LineSet;
  /** Alpha of a family from now on (stems: the Stems strength; links: the zoom-aware fibre alpha). Both ends of the line take it. */
  setAlpha(family: LineFamily, alpha: number): void;
  /** Whole-layer multiplier (selection fades, morph). */
  setDim(dim: number): void;
  setPaper(paper: boolean): void;
  /** Shared figure uniforms (depth cue). */
  setFigure(figure: Vector4, figureZ: number): void;
  setWriteScale(s: number): void;
  dispose(): void;
}

interface FamilyState {
  object: LineSegments;
  geom: BufferGeometry;
  material: RawShaderMaterial;
  cap: number;
  segments: number;
  draw: { startMs: number; ms: number } | null;
}

export function createLinesLayer(maxSegments: number = L.capacity): LinesLayer {
  const families: FamilyState[] = [];
  const objects: LineSegments[] = [];
  for (const f of [LINE_FAMILY.Source, LINE_FAMILY.Stem, LINE_FAMILY.Spoke, LINE_FAMILY.Link] as LineFamily[]) {
    const geom = new BufferGeometry();
    const cap = 64;
    geom.setAttribute("position", new BufferAttribute(new Float32Array(cap * 6), 3));
    geom.setAttribute("color", new BufferAttribute(new Uint8Array(cap * 8), 4, true));
    geom.setAttribute("t", new BufferAttribute(new Float32Array(cap * 2), 1));
    geom.setDrawRange(0, 0);
    const uniforms: Record<string, IUniform> = {
      uDraw: { value: 1 },
      uAlpha: { value: LINE_ALPHA[f] },
      uAlphaFar: { value: LINE_ALPHA_FAR[f] },
      uDim: { value: 1 },
      uFigure: { value: new Vector4(0, 0, 0, 1) },
      uFigureZ: { value: 0 },
      uWriteScale: { value: 1 },
      uPaper: { value: 0 },
    };
    const material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: LINES_VERT,
      fragmentShader: LINES_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms,
    });
    setPointBlending(material, false);
    const object = new LineSegments(geom, material);
    object.frustumCulled = false;
    object.renderOrder = 6 + f;
    object.visible = false;
    families.push({ object, geom, material, cap, segments: 0, draw: null });
    objects.push(object);
  }
  const fam = (f: LineFamily): FamilyState => families[f] as FamilyState;
  const limit = Math.max(1, Math.floor(maxSegments));

  const layer: LinesLayer = {
    objects,
    set(family, positions, colors, t) {
      const s = fam(family);
      const segs = Math.max(0, Math.min(limit, Math.floor(positions.length / 6), Math.floor(colors.length / 8), Math.floor(t.length / 2)));
      if (segs > s.cap) {
        s.cap = Math.min(limit, Math.max(segs, Math.ceil(segs * 1.25)));
        s.geom.dispose();
        s.geom.setAttribute("position", new BufferAttribute(new Float32Array(s.cap * 6), 3));
        s.geom.setAttribute("color", new BufferAttribute(new Uint8Array(s.cap * 8), 4, true));
        s.geom.setAttribute("t", new BufferAttribute(new Float32Array(s.cap * 2), 1));
      }
      const pa = s.geom.getAttribute("position") as BufferAttribute;
      const ca = s.geom.getAttribute("color") as BufferAttribute;
      const ta = s.geom.getAttribute("t") as BufferAttribute;
      (pa.array as Float32Array).set(positions.subarray(0, segs * 6));
      (ca.array as Uint8Array).set(colors.subarray(0, segs * 8));
      (ta.array as Float32Array).set(t.subarray(0, segs * 2));
      if (segs > 0) {
        for (const a of [pa, ca, ta]) {
          a.clearUpdateRanges();
          a.addUpdateRange(0, segs * a.itemSize * 2);
          a.needsUpdate = true;
        }
      }
      s.segments = segs;
      s.geom.setDrawRange(0, segs * 2);
      s.object.visible = segs > 0;
    },
    clear(family) {
      const s = fam(family);
      s.segments = 0;
      s.geom.setDrawRange(0, 0);
      s.object.visible = false;
      s.draw = null;
    },
    drawOn(family, ms, nowMs) {
      const s = fam(family);
      if (ms <= 0) {
        s.draw = null;
        (s.material.uniforms.uDraw as IUniform).value = 1;
        return;
      }
      s.draw = { startMs: nowMs, ms };
      (s.material.uniforms.uDraw as IUniform).value = 0;
    },
    update(nowMs) {
      let busy = false;
      for (const s of families) {
        if (!s.draw) continue;
        const k = Math.max(0, Math.min(1, (nowMs - s.draw.startMs) / s.draw.ms));
        (s.material.uniforms.uDraw as IUniform).value = k;
        if (k >= 1) s.draw = null;
        else busy = true;
      }
      return busy;
    },
    segments(family) {
      const s = fam(family);
      return { positions: (s.geom.getAttribute("position").array as Float32Array).subarray(0, s.segments * 6), segments: s.segments };
    },
    setAlpha(family, alpha) {
      const s = fam(family);
      const a = Math.max(0, alpha);
      (s.material.uniforms.uAlpha as IUniform).value = a;
      (s.material.uniforms.uAlphaFar as IUniform).value = a;
    },
    setDim(dim) {
      for (const s of families) (s.material.uniforms.uDim as IUniform).value = Math.max(0, dim);
    },
    setPaper(paper) {
      for (const s of families) {
        setPointBlending(s.material, paper);
        (s.material.uniforms.uPaper as IUniform).value = paper ? 1 : 0;
      }
    },
    setFigure(figure, figureZ) {
      for (const s of families) {
        (s.material.uniforms.uFigure as IUniform).value = figure;
        (s.material.uniforms.uFigureZ as IUniform).value = figureZ;
      }
    },
    setWriteScale(v) {
      for (const s of families) (s.material.uniforms.uWriteScale as IUniform).value = v;
    },
    dispose() {
      for (const s of families) {
        s.geom.dispose();
        s.material.dispose();
      }
    },
  };
  return layer;
}
