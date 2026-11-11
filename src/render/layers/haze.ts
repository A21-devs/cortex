/**
 * Anatomy haze (CORTEX-UX §6.2, §6.4–6.5, §6.13, §12.6): decorative points that keep the figure's silhouette
 * legible when the record is small — the brain (folds, volume, cerebellum, lips), the paired nerve guides and
 * twigs that form the torso, the cord thread, the segment rings and the brainstem — each kind with its own
 * intensity (RENDER_TUNING.intensity.haze, looked up by the kind's name in HAZE_KINDS, so the worker's kind list
 * can change without touching the shader). There is no filled body envelope. Not pickable; dimmed to 35% while
 * something is selected and 50% while something is traced; fades out as the figure morphs into Groups or a
 * Chart; halved by the frame governor's last step. The neck sheath (two faint columns) and the body field (a sparse torso cloud) are haze kinds too; the cord thread is brighter where a month has more entries (a per-point multiplier). Brain haze is coloured 60% by the territory it sits in (the
 * nearest note's area colour) + 40% mist (Stage tint, when on, replaces the mist); brainstem haze 60% the oldest
 * age stop + 40% mist; body and vertebrae mist; the undated cloud slate. Owner: E10.
 */
import { BufferAttribute, BufferGeometry, GLSL3, Points, RawShaderMaterial, Vector3, Vector4, type IUniform } from "three";
import { HAZE_KINDS, type HazeKind } from "../../shared/protocol/worker";
import { HAZE_SLOTS, HAZE_VERT, POINTS_FRAG } from "../shaders";
import { RENDER_TUNING } from "../tuning";
import { SRGB_TO_LINEAR, hashSeed, linearToSrgbByte, setPointBlending } from "./points";

/** Initial capacity: brain 15,800, nerve guides and twigs 14,200, cord thread 3,000, rings 1,240, brainstem 700. */
export const HAZE_COUNT = 8_400 + 3_500 + 2_100 + 1_800 + 11_000 + 3_200 + 3_000 + 1_240 + 700 + 240 + 3_000;

export type Rgb = readonly [number, number, number];

export interface HazeLayer {
  readonly object: Points;
  readonly material: RawShaderMaterial;
  readonly count: number;
  /** `bright` (optional): a brightness multiplier per point, 1 where absent (the cord thread follows each period's activity). */
  setPositions(pos: Float32Array, kind: Uint8Array, birth: Float32Array, count: number, bright?: Float32Array): void;
  /** RGBA8 per haze point (see hazeColors). */
  setColors(rgba: Uint8Array): void;
  /** 1 = rest, 0.35 while something is selected, 0.5 while something is traced. */
  setOpacity(alpha: number): void;
  setPaper(paper: boolean): void;
  /** CPU copies (positions xyz, kinds) for colouring, framing and the 2D fallback. */
  positions(): Float32Array;
  kinds(): Uint8Array;
  dispose(): void;
}

/** Brain-like kinds take the territory colour of the nearest note and the small-brain boost. */
export function isBrainKind(name: string): boolean {
  return name === "brain" || name.startsWith("brain") || name === "cerebellum";
}

/** The body field: the haze kinds whose density follows the Spread (Scatter) slider (the torso's nerve guides and a "body" kind). */
export function isBodyFieldKind(name: string): boolean {
  return name === "nerve" || name === "body";
}

/** Kinds that flash when born (the brainstem cap). */
export function flashesOnBirth(name: string): boolean {
  return name === "brainstem";
}

/** Rest intensity of a haze kind by name (0.1 for a kind the table does not know, so it is visible but quiet). */
export function hazeIntensityOf(name: string): number {
  const table = RENDER_TUNING.intensity.haze as Readonly<Record<string, number>>;
  return table[name] ?? 0.1;
}

/**
 * Nerve guides fade from root to tip (0.24 at the cord down to 0.13 at the end, CORTEX-UX §6.5): the rest
 * intensity table holds their mean (0.18), so each point scales by its gradient value over that mean, found from
 * how far it lies from the cord axis (a guide leaves the cord and arches out to the torso envelope).
 */
export function restScale(kind: number, x: number, z: number): number {
  if (HAZE_KINDS[kind] !== "nerve") return 1;
  const g = RENDER_TUNING.intensity.nerveGuide;
  const s = Math.max(0, Math.min(1, Math.hypot(x, z) / g.tipRadius));
  return (g.root + (g.tip - g.root) * s) / g.mean;
}

/** Per-slot arrays for the haze shader, indexed like HAZE_KINDS and padded to HAZE_SLOTS. */
function slotArray(f: (name: string) => number): number[] {
  const out = new Array<number>(HAZE_SLOTS).fill(0);
  HAZE_KINDS.forEach((k, i) => {
    if (i < HAZE_SLOTS) out[i] = f(k);
  });
  return out;
}

export function hazeIntensities(): number[] {
  return slotArray(hazeIntensityOf);
}

export function createHazeLayer(initialCapacity = HAZE_COUNT): HazeLayer {
  let cap = Math.max(16, initialCapacity);
  const geom = new BufferGeometry();
  let pos = new BufferAttribute(new Float32Array(cap * 3), 3);
  let col = new BufferAttribute(new Uint8Array(cap * 4), 4, true);
  let misc = new BufferAttribute(new Float32Array(cap * 4), 4);
  let kinds = new Uint8Array(cap);
  geom.setAttribute("aPos", pos);
  geom.setAttribute("aColor", col);
  geom.setAttribute("aMisc", misc);
  geom.setDrawRange(0, 0);
  const T = RENDER_TUNING;
  const s = T.sprites.record;
  const uniforms: Record<string, IUniform> = {
    uIntro: { value: 1e6 },
    uFadeSec: { value: T.growth.hazeFadeSec },
    uFlashSec: { value: T.growth.birthFlashMs / 1000 },
    uMorph: { value: 0 },
    uHazeDim: { value: 1 },
    uKeep: { value: 1 },
    uBoost: { value: 1 },
    uBrainBoost: { value: 1 },
    uDotSize: { value: 1 },
    uGlow: { value: 1 },
    uDpr: { value: 1 },
    uRefDist: { value: 25 },
    uDistPow: { value: T.sprites.distancePower },
    uMinPx: { value: T.sprites.minPx },
    uMaxPx: { value: T.sprites.maxPx },
    uExtent: { value: T.sprites.extentSigma },
    uFade: { value: 1 },
    uPaper: { value: 0 },
    uPaperAlpha: { value: T.stage.paperAlpha },
    uCoreScale: { value: T.stage.paperCoreScale },
    uFigure: { value: new Vector4(0, 0, 0, 1) },
    uFigureZ: { value: 0 },
    uProfile: { value: new Vector4(s.sigmaCore, s.sigmaHalo, s.corePeak, s.haloPeak) },
    uIntensity: { value: hazeIntensities() },
    uBrainKind: { value: slotArray((k) => (isBrainKind(k) ? 1 : 0)) },
    uFlashKind: { value: slotArray((k) => (flashesOnBirth(k) ? 1 : 0)) },
    uBodyKind: { value: slotArray((k) => (isBodyFieldKind(k) ? 1 : 0)) },
    uBrainC: { value: new Vector3(0, 0, 0) },
    uBrainScale: { value: 1 },
    uHazeDensity: { value: 1 },
    uHazeSpeck: { value: new Vector3(T.fibre.hazeSpeckSize, T.fibre.hazeSpeckBoost, 0.45) },
    uHazeSpeckShare: { value: T.fibre.hazeSpeckShare },
    uWriteScale: { value: 1 },
  };
  const material = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: HAZE_VERT,
    fragmentShader: POINTS_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms,
  });
  setPointBlending(material, false);
  const object = new Points(geom, material);
  object.frustumCulled = false;
  object.renderOrder = 1;
  let count = 0;

  const grow = (n: number): void => {
    if (n <= cap) return;
    cap = Math.ceil(n * 1.1);
    pos = new BufferAttribute(new Float32Array(cap * 3), 3);
    col = new BufferAttribute(new Uint8Array(cap * 4), 4, true);
    misc = new BufferAttribute(new Float32Array(cap * 4), 4);
    kinds = new Uint8Array(cap);
    geom.dispose();
    geom.setAttribute("aPos", pos);
    geom.setAttribute("aColor", col);
    geom.setAttribute("aMisc", misc);
  };

  const layer: HazeLayer = {
    object,
    material,
    get count() {
      return count;
    },
    setPositions(p, kind, birth, n, bright) {
      const m = Math.max(0, Math.min(n, Math.floor(p.length / 3), kind.length));
      grow(m);
      const P = pos.array as Float32Array;
      const M = misc.array as Float32Array;
      let j = 0;
      for (let i = 0; i < m; i++) {
        const x = p[i * 3] as number, y = p[i * 3 + 1] as number, z = p[i * 3 + 2] as number;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        P[j * 3] = x;
        P[j * 3 + 1] = y;
        P[j * 3 + 2] = z;
        const k = Math.min(HAZE_KINDS.length - 1, HAZE_SLOTS - 1, kind[i] as number);
        kinds[j] = k;
        const b = birth[i];
        M[j * 4] = hashSeed(i + 0x51ed);
        M[j * 4 + 1] = k;
        M[j * 4 + 2] = b !== undefined && Number.isFinite(b) ? b : 0;
        const bv = bright?.[i];
        M[j * 4 + 3] = restScale(kind[i] as number, x, z) * (bv !== undefined && Number.isFinite(bv) ? bv : 1);
        j++;
      }
      count = j;
      geom.setDrawRange(0, count);
      pos.needsUpdate = true;
      misc.needsUpdate = true;
    },
    setColors(rgba) {
      const C = col.array as Uint8Array;
      C.set(rgba.subarray(0, Math.min(rgba.length, C.length, count * 4)));
      col.needsUpdate = true;
    },
    setOpacity(alpha) {
      (uniforms.uHazeDim as IUniform).value = Math.max(0, alpha);
    },
    setPaper(paper) {
      setPointBlending(material, paper);
    },
    positions: () => (pos.array as Float32Array).subarray(0, count * 3),
    kinds: () => kinds.subarray(0, count),
    dispose() {
      geom.dispose();
      material.dispose();
    },
  };
  return layer;
}

// ───────────────────────────── colours (pure) ─────────────────────────────

export interface HazeColourInput {
  /** Haze positions (xyz) and kinds (HAZE_KINDS index). */
  pos: Float32Array;
  kind: Uint8Array;
  count: number;
  /** Notes in the brain (xyz) and their territory colour (RGB bytes). */
  notePos: Float32Array;
  noteRgb: Uint8Array;
  noteCount: number;
  mist: Rgb;
  /** Stage tint colour replaces the mist in the brain haze; null = off. */
  tint: Rgb | null;
  oldest: Rgb;
  undated: Rgb;
  /** Spine position τ (0..1) of each haze point on the cord (NaN elsewhere) and the spine's colour per τ bin (RGB bytes, null = none): the thread's beads take them. */
  age?: Float32Array | null;
  spine?: Uint8Array | null;
}

/** Share a spine colour is lifted toward white on the cord thread, so the column stays bright. */
const SPINE_LIFT = 0.05;
/** How far a spine colour is pushed from its own grey on the thread (1 = unchanged), so the column keeps saturated runs. */
const SPINE_SAT = 1.35;

const kindIndex = (k: HazeKind): number => HAZE_KINDS.indexOf(k);
const kindName = (i: number): string => HAZE_KINDS[i] ?? "";

function mixLinear(a: Rgb, b: Rgb, t: number, out: Uint8Array, o: number): void {
  for (let c = 0; c < 3; c++) {
    const la = SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round(a[c] as number)))] as number;
    const lb = SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round(b[c] as number)))] as number;
    out[o + c] = linearToSrgbByte(la * (1 - t) + lb * t);
  }
  out[o + 3] = 255;
}

/**
 * Per-point haze colours (RGBA8). Brain haze takes the territory colour of its nearest note (a uniform grid, so
 * it needs no knowledge of the wedge convention), mixed 60/40 with the mist (or the tint).
 */
export function hazeColors(input: HazeColourInput): Uint8Array {
  const out = new Uint8Array(input.count * 4);
  const mix = RENDER_TUNING.intensity.hazeTerritoryMix;
  const brainMist = input.tint ?? input.mist;
  const STEM = kindIndex("brainstem");
  const UNDATED = kindIndex("undated");
  const THREAD = kindIndex("thread");
  const spineBins = input.spine ? Math.floor(input.spine.length / 3) : 0;
  const grid = input.noteCount > 0 ? buildGrid(input.notePos, input.noteCount) : null;
  for (let i = 0; i < input.count; i++) {
    const k = input.kind[i] as number;
    const o = i * 4;
    if (isBrainKind(kindName(k))) {
      const n = grid ? nearest(grid, input.notePos, input.pos[i * 3] as number, input.pos[i * 3 + 1] as number, input.pos[i * 3 + 2] as number) : -1;
      if (n >= 0) {
        const terr: Rgb = [input.noteRgb[n * 3] as number, input.noteRgb[n * 3 + 1] as number, input.noteRgb[n * 3 + 2] as number];
        mixLinear(brainMist, terr, mix, out, o);
      } else mixLinear(brainMist, brainMist, 0, out, o);
    } else if (k === THREAD && spineBins > 0 && input.age && Number.isFinite(input.age[i] as number)) {
      const b = Math.min(spineBins - 1, Math.max(0, Math.floor((input.age[i] as number) * spineBins)));
      const c: Rgb = [input.spine![b * 3] as number, input.spine![b * 3 + 1] as number, input.spine![b * 3 + 2] as number];
      const y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
      const vivid: Rgb = [y + (c[0] - y) * SPINE_SAT, y + (c[1] - y) * SPINE_SAT, y + (c[2] - y) * SPINE_SAT];
      mixLinear(vivid, [255, 255, 255], SPINE_LIFT, out, o);
    } else if (k === STEM) mixLinear(input.mist, input.oldest, mix, out, o);
    else if (k === UNDATED) mixLinear(input.undated, input.undated, 0, out, o);
    else mixLinear(input.mist, input.mist, 0, out, o);
  }
  return out;
}

interface Grid {
  min: [number, number, number];
  cell: number;
  dims: [number, number, number];
  start: Uint32Array;
  items: Uint32Array;
}

function buildGrid(p: Float32Array, n: number): Grid {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = p[i * 3] as number, y = p[i * 3 + 1] as number, z = p[i * 3 + 2] as number;
    if (!Number.isFinite(x + y + z)) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  if (!Number.isFinite(x0)) {
    x0 = y0 = z0 = 0;
    x1 = y1 = z1 = 1;
  }
  const span = Math.max(x1 - x0, y1 - y0, z1 - z0, 1e-3);
  const cell = span / 24;
  const dims: [number, number, number] = [
    Math.max(1, Math.ceil((x1 - x0) / cell) + 1),
    Math.max(1, Math.ceil((y1 - y0) / cell) + 1),
    Math.max(1, Math.ceil((z1 - z0) / cell) + 1),
  ];
  const cells = dims[0] * dims[1] * dims[2];
  const counts = new Uint32Array(cells + 1);
  const cellOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const x = p[i * 3] as number, y = p[i * 3 + 1] as number, z = p[i * 3 + 2] as number;
    if (!Number.isFinite(x + y + z)) {
      cellOf[i] = -1;
      continue;
    }
    const c = cellIndex(dims, Math.floor((x - x0) / cell), Math.floor((y - y0) / cell), Math.floor((z - z0) / cell));
    cellOf[i] = c;
    counts[c + 1] = (counts[c + 1] as number) + 1;
  }
  for (let c = 0; c < cells; c++) counts[c + 1] = (counts[c + 1] as number) + (counts[c] as number);
  const fill = counts.slice(0, cells);
  const items = new Uint32Array(counts[cells] as number);
  for (let i = 0; i < n; i++) {
    const c = cellOf[i] as number;
    if (c < 0) continue;
    items[fill[c] as number] = i;
    fill[c] = (fill[c] as number) + 1;
  }
  return { min: [x0, y0, z0], cell, dims, start: counts, items };
}

function cellIndex(d: [number, number, number], ix: number, iy: number, iz: number): number {
  const x = Math.max(0, Math.min(d[0] - 1, ix));
  const y = Math.max(0, Math.min(d[1] - 1, iy));
  const z = Math.max(0, Math.min(d[2] - 1, iz));
  return (z * d[1] + y) * d[0] + x;
}

function nearest(g: Grid, p: Float32Array, x: number, y: number, z: number): number {
  const cx = Math.max(0, Math.min(g.dims[0] - 1, Math.floor((x - g.min[0]) / g.cell)));
  const cy = Math.max(0, Math.min(g.dims[1] - 1, Math.floor((y - g.min[1]) / g.cell)));
  const cz = Math.max(0, Math.min(g.dims[2] - 1, Math.floor((z - g.min[2]) / g.cell)));
  let best = -1;
  let bestD = Infinity;
  for (let r = 0; r <= 4; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
          const ix = cx + dx, iy = cy + dy, iz = cz + dz;
          if (ix < 0 || iy < 0 || iz < 0 || ix >= g.dims[0] || iy >= g.dims[1] || iz >= g.dims[2]) continue;
          const c = (iz * g.dims[1] + iy) * g.dims[0] + ix;
          for (let k = g.start[c] as number; k < (g.start[c + 1] as number); k++) {
            const i = g.items[k] as number;
            const ddx = (p[i * 3] as number) - x, ddy = (p[i * 3 + 1] as number) - y, ddz = (p[i * 3 + 2] as number) - z;
            const d = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
    }
    // A hit in ring r is the nearest once the next ring cannot be closer.
    if (best >= 0 && Math.sqrt(bestD) <= r * g.cell) break;
  }
  return best;
}
