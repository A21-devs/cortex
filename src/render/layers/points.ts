/**
 * Data points layer: one THREE.Points over typed attributes, plus the hover / selection / active-note rings and
 * the picking object, which share the same GPU buffers (one BufferAttribute each, several geometries). Owner: E10.
 * Budget: ≤ 340k record + ≤ 60k notes points at 88 bytes per point on the GPU (≈ 35 MB at 400k), CPU copies are
 * the attribute arrays themselves (re-uploaded after a context loss or a release).
 *
 * Uploads are partial whenever possible (POINTS-TOUCH-NOOP: ranges are clamped, never negative; ranges queued in
 * one frame accumulate; a pending full upload is never downgraded to a partial one).
 */
import {
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  GLSL3,
  IntType,
  NoBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Points,
  RawShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  AddEquation,
  type IUniform,
} from "three";
import type { PlacementResult } from "../../shared/protocol/worker";
import { CORD_SAMPLES, GEO_BITS, PICK_FRAG, PICK_FRAG_RGBA8, POINTS_FRAG, POINTS_VERT, RING_FRAG, RING_VERT, STREAK_TINTS, kindProfiles, pickVert } from "../shaders";
import { RENDER_TUNING } from "../tuning";

export const POINT_ATTRIBUTES = {
  aAnat: { itemSize: 3, type: "f32" },
  aCentre: { itemSize: 3, type: "f32" },
  aArr: { itemSize: 3, type: "f32" },
  aArrPrev: { itemSize: 3, type: "f32" },
  aColor: { itemSize: 4, type: "u8n" },
  aColorPrev: { itemSize: 4, type: "u8n" },
  aMisc: { itemSize: 4, type: "f32" },
  aState: { itemSize: 2, type: "u32" },
  aGeo: { itemSize: 1, type: "u32" },
  /** Chart / key group of the point for hover emphasis: 0 = none, else row + 1 (low 31 bits) and the population in bit 31. */
  aGroup: { itemSize: 1, type: "u32" },
} as const;

export type PointAttribute = keyof typeof POINT_ATTRIBUTES;

/** Bytes per point on the GPU. */
export const BYTES_PER_POINT = (Object.values(POINT_ATTRIBUTES) as { itemSize: number; type: string }[]).reduce(
  (n, a) => n + a.itemSize * (a.type === "u8n" ? 1 : 4),
  0,
);

/** Per-point look computed from the index: draw kind (POINT_KIND) and rest intensity. */
export interface PointLook {
  kind: Uint8Array;
  intensity: Float32Array;
}

type Uniforms = Record<string, IUniform>;

/** Stable 0..1 seed per ordinal (murmur3 finaliser), so morph delays and LOD never change between sessions. */
export function hashSeed(i: number): number {
  let h = (i + 0x9e3779b9) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** sRGB byte → linear light. */
export const SRGB_TO_LINEAR: Float32Array = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

export function linearToSrgbByte(l: number): number {
  const c = l <= 0 ? 0 : l >= 1 ? 1 : l;
  const s = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/** groupOf value of an item that is not in a group (hidden, no value). */
export const NO_GROUP = 0xffffffff;

/** The aGroup word of a point: row + 1 in the low 31 bits (0 = none), the population (1 = record) in bit 31. */
export function groupAttr(row: number, population: number): number {
  if (row === NO_GROUP || row < 0 || row >= 0x7fffffff) return 0;
  return (((population === 0 ? 0 : 1) << 31) | (row + 1)) >>> 0;
}

/** The uniforms shared by the points, ring and pick materials (same objects: one update reaches all three). */
export function createCoreUniforms(): Uniforms {
  const T = RENDER_TUNING;
  return {
    uTime: { value: 0 },
    uIntro: { value: 1e6 },
    uGrowing: { value: 0 },
    uUnfurlRad: { value: (T.growth.unfurlDeg * Math.PI) / 180 },
    uUnfurlSec: { value: T.growth.unfurlSec },
    uMorph: { value: 0 },
    uForm: { value: 1 },
    uFormLift: { value: T.shape.formLift },
    uCurlAmp: { value: T.shape.curlAmp },
    uUp: { value: new Vector3(0, 1, 0) },
    uScatter: { value: 1 },
    uStateT: { value: 1 },
    uOthers: { value: 1 },
    uHiddenDim: { value: T.stateAlpha.hiddenByKey },
    uPeriodDim: { value: T.stateAlpha.outsidePeriod },
    uMemberBoost: { value: T.stateAlpha.selectedGroupBoost },
    uMemberSize: { value: T.stateAlpha.selectedGroupSize },
    uSourceBoost: { value: T.stateAlpha.mapSourcesBoost },
    uThin: { value: T.stateAlpha.thinGroup },
    uScopeSink: { value: T.stateAlpha.scopeSink },
    uScopeFlash: { value: 0 },
    uSwirl: { value: 0 },
    uSwirlAmp: { value: T.scope.swirlAmp },
    uFade: { value: 1 },
    uLodKeep: { value: 1 },
    uLongAxis: { value: new Vector3(0, 1, 0) },
    /** Direction along the cord toward the tip (newest): down when standing, +X when lying. */
    uTip: { value: new Vector3(0, -1, 0) },
    uCordSpan: { value: [0, 1] },
    uCord: { value: Array.from({ length: CORD_SAMPLES }, () => new Vector3()) },
    uBrain: { value: new Vector4(0, 0, 0, 1) },
    // Point-shader effects (P04): shimmer, grouping dissolve, query dip and regrow, transit pose, spread contraction.
    uShimmer: { value: 0 },
    uShimmerJit: { value: T.shimmer.jitter },
    uShimmerRate: { value: T.shimmer.rate },
    uDissolve: { value: -1 },
    uDissolveSplit: { value: T.morph.dissolveOutMs / (T.morph.dissolveOutMs + T.morph.dissolveInMs) },
    uDissolveFade: { value: T.morph.dissolveFade },
    uDissolveShrink: { value: T.morph.dissolveShrink },
    uDip: { value: 1 },
    uRegrow: { value: -1 },
    uRegrowSpan: { value: T.growth.introSec + T.states.queryRegrowSoftSec },
    uRegrowSoft: { value: T.states.queryRegrowSoftSec },
    uDipFloor: { value: T.states.queryDipTo },
    uHumanW: { value: 0 },
    uHumX: { value: new Vector3(1, 0, 0) },
    uHumY: { value: new Vector3(0, 1, 0) },
    uBrainScale: { value: 1 },
    // Click latency and chart entry/exit styles (P06).
    uPending: { value: 0 },
    uExit: { value: 0 },
    uExitAnchor: { value: new Vector3() },
    uExitLook: { value: new Vector2(T.shape.chartExit.shrink, T.shape.chartExit.fadeTo) },
    uEntry: { value: new Vector3() },
  };
}

function profileVectors(): Vector4[] {
  const p = kindProfiles();
  const out: Vector4[] = [];
  for (let i = 0; i < p.length; i += 4) out.push(new Vector4(p[i], p[i + 1], p[i + 2], p[i + 3]));
  return out;
}

/** Additive premultiplied (Ink) or premultiplied over (Paper). */
export function setPointBlending(m: RawShaderMaterial, paper: boolean): void {
  m.blending = CustomBlending;
  m.blendEquation = AddEquation;
  m.blendEquationAlpha = AddEquation;
  m.blendSrc = OneFactor;
  m.blendSrcAlpha = OneFactor;
  m.blendDst = paper ? OneMinusSrcAlphaFactor : OneFactor;
  m.blendDstAlpha = paper ? OneMinusSrcAlphaFactor : OneFactor;
  m.premultipliedAlpha = true;
  m.needsUpdate = true;
}

export interface RingObject {
  readonly object: Points;
  readonly material: RawShaderMaterial;
  /** Show the ring at an ordinal (-1 hides it). */
  show(ordinal: number): void;
  readonly ordinal: number;
}

export interface PointsLayer {
  readonly object: Points;
  readonly material: RawShaderMaterial;
  readonly core: Uniforms;
  readonly capacity: number;
  count: number;
  readonly rings: { hover: RingObject; selected: RingObject; active: RingObject };
  attr(name: PointAttribute): BufferAttribute;
  /** Mark a range of an attribute dirty (partial upload, clamped; no count = to the end of the live range). */
  touch(name: PointAttribute, from?: number, count?: number): void;
  setCount(n: number): void;
  /** Positions, sizes, births, kinds and intensities from a placement (all ordinals, or [from, count)). */
  writePlacement(p: PlacementResult, look: PointLook, count: number, from?: number): void;
  /** New colours; `animate` keeps the colour shown at progress `t` of a running recolour as the start colour. */
  writeColors(rgba: Uint8Array, animate: boolean, t: number): void;
  /** Arrangement targets: "morph" replaces them, "form" keeps the current ones as the start of a transition. */
  writeArrangement(arr: Float32Array | null, mode: "morph" | "form"): void;
  /**
   * State bits for [from, from + count). animate: every point's previous bits become its current bits and the
   * caller restarts the transition; otherwise both are set (instant).
   */
  writeState(state: Uint32Array, from: number, count: number, animate: boolean): void;
  /** Overwrite birth times of a range (arrivals born now). */
  writeBirths(births: Float32Array, from: number): void;
  /** Hover-emphasis groups: `groupOf` row per ordinal (0xFFFFFFFF = none) and `pop` (1 = a record entry) per ordinal. */
  writeGroups(groupOf: Uint32Array | null, pop: ArrayLike<number> | null): void;
  /** Picking object sharing the buffers (created on first use). */
  pickObject(integerIds: boolean): Points;
  setPaper(paper: boolean): void;
  dispose(): void;
}

export function createPointsLayer(capacity: number): PointsLayer {
  const cap = Math.max(1, Math.floor(capacity));
  const geom = new BufferGeometry();
  const attrs = {} as Record<PointAttribute, BufferAttribute>;
  const fullPending = new Set<PointAttribute>();
  for (const name of Object.keys(POINT_ATTRIBUTES) as PointAttribute[]) {
    const spec = POINT_ATTRIBUTES[name];
    let a: BufferAttribute;
    if (spec.type === "f32") a = new BufferAttribute(new Float32Array(cap * spec.itemSize), spec.itemSize);
    else if (spec.type === "u8n") a = new BufferAttribute(new Uint8Array(cap * spec.itemSize), spec.itemSize, true);
    else {
      a = new BufferAttribute(new Uint32Array(cap * spec.itemSize), spec.itemSize);
      // IntType = integer attribute (vertexAttribIPointer); the Uint32Array makes it UNSIGNED_INT → `in uint`/`uvec2`.
      a.gpuType = IntType;
    }
    a.onUpload(() => fullPending.delete(name));
    attrs[name] = a;
    geom.setAttribute(name, a);
  }
  geom.setDrawRange(0, 0);

  const core = createCoreUniforms();
  const T = RENDER_TUNING;
  const pointUniforms: Uniforms = {
    ...core,
    uDotSize: { value: 1 },
    uGlow: { value: 1 },
    uDpr: { value: 1 },
    uRefDist: { value: 25 },
    uDistPow: { value: T.sprites.distancePower },
    uMinPx: { value: T.sprites.minPx },
    uMaxPx: { value: T.sprites.maxPx },
    uExtent: { value: T.sprites.extentSigma },
    uRecolourT: { value: 1 },
    uHover: { value: -1 },
    uSelected: { value: -1 },
    uFlashSec: { value: T.growth.birthFlashMs / 1000 },
    uFlashSize: { value: T.growth.birthFlashSize },
    uHoverSize: { value: T.stateAlpha.hoverSize },
    uSelectedSize: { value: T.stateAlpha.selectedSize },
    uWhitePeak: { value: T.stateAlpha.whitePeak },
    uMapBoost: { value: T.stateAlpha.mapBoost },
    uMapWhite: { value: T.intensity.mapWhite },
    uSmallBrain: { value: 1 },
    uSmallRecord: { value: 1 },
    uWarm: { value: T.stateAlpha.inFlightWarm },
    uSourceTint: { value: new Vector3(1, 1, 1) },
    uSourceTintMix: { value: 0 },
    uPaper: { value: 0 },
    uPaperAlpha: { value: T.stage.paperAlpha },
    uCoreScale: { value: T.stage.paperCoreScale },
    uBrainZ: { value: 0 },
    uFigure: { value: new Vector4(0, 0, 0, 1) },
    uFigureZ: { value: 0 },
    uRimBase: { value: T.intensity.noteRimBase },
    uRimGain: { value: T.intensity.noteRimGain },
    uInside: { value: T.intensity.noteInside },
    uProfile: { value: profileVectors() },
    uWriteScale: { value: 1 },
    uShimmerAmp: { value: T.shimmer.amp },
    uCordBright: { value: 1 },
    uCordSize: { value: 1 },
    uFibre: { value: new Vector4(T.fibre.colourKeep, T.fibre.size, T.fibre.intensity, T.fibre.speckShare) },
    uSpeck: { value: new Vector4(T.fibre.speckSize, T.fibre.speckBoost, T.fibre.speckLift, T.fibre.cordSize) },
    uHumanTint: { value: new Vector3(1, 0.4, 0.3) },
    uHumanTintMix: { value: 0 },
    uHoverOn: { value: 0 },
    uHoverGroup: { value: -1 },
    uHoverPop: { value: -1 },
    uHoverDim: { value: T.hover.dim },
    uHoverBoost: { value: T.hover.boost },
    uHoverGrow: { value: T.hover.size },
    uHoverGlow: { value: T.hover.glow },
    uHoverGlowPx: { value: T.hover.glowPx },
    uStreak: { value: 0 },
    uStreakPx: { value: T.hover.streakPx },
    uStreakDir: { value: new Vector2(1, 0) },
    uStreakTint: { value: Array.from({ length: STREAK_TINTS }, () => new Vector3(1, 1, 1)) },
  };
  const material = new RawShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: POINTS_VERT,
    fragmentShader: POINTS_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: pointUniforms,
  });
  setPointBlending(material, false);
  const object = new Points(geom, material);
  object.frustumCulled = false;
  object.renderOrder = 2;

  const ringUniformsBase = { uDpr: pointUniforms.uDpr as IUniform, uWriteScale: pointUniforms.uWriteScale as IUniform };
  const makeRing = (spec: readonly { r: number; w: number; a: number }[], order: number): RingObject => {
    const g = new BufferGeometry();
    for (const name of Object.keys(attrs) as PointAttribute[]) g.setAttribute(name, attrs[name]);
    g.setDrawRange(0, 0);
    const a = spec[0] ?? { r: 0, w: 0, a: 0 };
    const b = spec[1] ?? { r: 0, w: 0, a: 0 };
    const extent = Math.max(a.r + a.w, b.r + b.w) + 2;
    const m = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        ...core,
        ...ringUniformsBase,
        uRingExtent: { value: extent },
        uRingColor: { value: new Vector3(1, 1, 1) },
        uRingA: { value: new Vector3(a.r, a.w, a.a) },
        uRingB: { value: new Vector3(b.r, b.w, b.a) },
        uRingGain: { value: T.rings.gain },
      },
    });
    setPointBlending(m, false);
    const obj = new Points(g, m);
    obj.frustumCulled = false;
    obj.renderOrder = order;
    obj.visible = false;
    let ordinal = -1;
    return {
      object: obj,
      material: m,
      get ordinal() {
        return ordinal;
      },
      show(i: number) {
        ordinal = i;
        if (i < 0 || i >= layer.count) {
          obj.visible = false;
          g.setDrawRange(0, 0);
          return;
        }
        g.setDrawRange(i, 1);
        obj.visible = true;
      },
    };
  };
  const rings = {
    active: makeRing(T.rings.active, 3),
    selected: makeRing(T.rings.selected, 4),
    hover: makeRing(T.rings.hover, 5),
  };

  let pick: { object: Points; integer: boolean } | null = null;

  const arr = <K extends PointAttribute>(name: K) => attrs[name].array as K extends "aColor" | "aColorPrev" ? Uint8Array : K extends "aState" | "aGeo" | "aGroup" ? Uint32Array : Float32Array;

  const layer: PointsLayer = {
    object,
    material,
    core,
    capacity: cap,
    count: 0,
    rings,
    attr: (name) => attrs[name],
    touch(name, from = 0, count = -1) {
      const a = attrs[name];
      // POINTS-TOUCH-NOOP: never pass a negative count (WebGL turns -1 into 4294967295 and uploads nothing).
      // No count = from `from` to the end of the live range; from 0 with no count = full upload.
      if (count < 0 && from <= 0) {
        a.clearUpdateRanges();
        fullPending.add(name);
        a.needsUpdate = true;
        return;
      }
      if (fullPending.has(name)) {
        a.needsUpdate = true;
        return;
      }
      const items = count < 0 ? Math.max(0, layer.count - from) : count;
      const start = Math.max(0, Math.min(from, cap)) * a.itemSize;
      const len = Math.max(0, Math.min(items * a.itemSize, a.array.length - start));
      if (len <= 0) return;
      a.addUpdateRange(start, len);
      a.needsUpdate = true;
    },
    setCount(n) {
      layer.count = Math.max(0, Math.min(cap, n));
      geom.setDrawRange(0, layer.count);
      if (pick) (pick.object.geometry as BufferGeometry).setDrawRange(0, layer.count);
      for (const r of Object.values(rings)) if (r.ordinal >= layer.count) r.show(-1);
    },
    writePlacement(p, look, count, from = 0) {
      const n = Math.min(cap, count);
      const anat = arr("aAnat");
      const centre = arr("aCentre");
      const misc = arr("aMisc");
      const geo = arr("aGeo");
      const a = arr("aArr");
      const ap = arr("aArrPrev");
      for (let i = Math.max(0, from); i < n; i++) {
        const x = p.anat[i * 3] ?? Number.NaN;
        const y = p.anat[i * 3 + 1] ?? Number.NaN;
        const z = p.anat[i * 3 + 2] ?? Number.NaN;
        const placed = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
        anat[i * 3] = placed ? x : 0;
        anat[i * 3 + 1] = placed ? y : 0;
        anat[i * 3 + 2] = placed ? z : 0;
        const cx = p.centre[i * 3] ?? Number.NaN;
        const cy = p.centre[i * 3 + 1] ?? Number.NaN;
        const cz = p.centre[i * 3 + 2] ?? Number.NaN;
        const hasCentre = Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(cz);
        centre[i * 3] = hasCentre ? cx : (anat[i * 3] as number);
        centre[i * 3 + 1] = hasCentre ? cy : (anat[i * 3 + 1] as number);
        centre[i * 3 + 2] = hasCentre ? cz : (anat[i * 3 + 2] as number);
        const size = p.size[i];
        const birth = p.birth[i];
        misc[i * 4] = hashSeed(i);
        misc[i * 4 + 1] = size !== undefined && Number.isFinite(size) && size > 0 ? size : 1;
        misc[i * 4 + 2] = birth !== undefined && Number.isFinite(birth) ? birth : 0;
        misc[i * 4 + 3] = look.intensity[i] ?? 1;
        const keep = (geo[i] as number) & (GEO_BITS.HasArr | GEO_BITS.HasArrPrev);
        geo[i] = keep | (placed ? GEO_BITS.Placed : 0) | (((look.kind[i] ?? 0) & 15) << GEO_BITS.KindShift);
        if (!(keep & GEO_BITS.HasArr)) {
          a[i * 3] = anat[i * 3] as number;
          a[i * 3 + 1] = anat[i * 3 + 1] as number;
          a[i * 3 + 2] = anat[i * 3 + 2] as number;
        }
        if (!(keep & GEO_BITS.HasArrPrev)) {
          ap[i * 3] = anat[i * 3] as number;
          ap[i * 3 + 1] = anat[i * 3 + 1] as number;
          ap[i * 3 + 2] = anat[i * 3 + 2] as number;
        }
      }
      const f = Math.max(0, from);
      const c = Math.max(0, n - f);
      if (f === 0) {
        for (const name of ["aAnat", "aCentre", "aMisc", "aGeo", "aArr", "aArrPrev"] as const) layer.touch(name);
      } else {
        for (const name of ["aAnat", "aCentre", "aMisc", "aGeo", "aArr", "aArrPrev"] as const) layer.touch(name, f, c);
      }
    },
    writeColors(rgba, animate, t) {
      const cur = arr("aColor");
      const prev = arr("aColorPrev");
      const n = Math.min(cur.length, rgba.length);
      if (animate) {
        const k = Math.max(0, Math.min(1, t));
        if (k >= 1) prev.set(cur.subarray(0, n));
        else {
          for (let i = 0; i < n; i++) {
            if ((i & 3) === 3) {
              prev[i] = Math.round((prev[i] as number) + ((cur[i] as number) - (prev[i] as number)) * k);
              continue;
            }
            const a = SRGB_TO_LINEAR[prev[i] as number] as number;
            const b = SRGB_TO_LINEAR[cur[i] as number] as number;
            prev[i] = linearToSrgbByte(a + (b - a) * k);
          }
        }
      }
      cur.set(rgba.subarray(0, n));
      if (!animate) prev.set(rgba.subarray(0, n));
      layer.touch("aColor");
      layer.touch("aColorPrev");
    },
    writeArrangement(target, mode) {
      const a = arr("aArr");
      const ap = arr("aArrPrev");
      const geo = arr("aGeo");
      const anat = arr("aAnat");
      const n = layer.count;
      for (let i = 0; i < n; i++) {
        let g = geo[i] as number;
        if (mode === "form") {
          ap[i * 3] = a[i * 3] as number;
          ap[i * 3 + 1] = a[i * 3 + 1] as number;
          ap[i * 3 + 2] = a[i * 3 + 2] as number;
          g = g & GEO_BITS.HasArr ? g | GEO_BITS.HasArrPrev : g & ~GEO_BITS.HasArrPrev;
        } else g &= ~GEO_BITS.HasArrPrev;
        const x = target ? (target[i * 3] ?? Number.NaN) : Number.NaN;
        const y = target ? (target[i * 3 + 1] ?? Number.NaN) : Number.NaN;
        const z = target ? (target[i * 3 + 2] ?? Number.NaN) : Number.NaN;
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          a[i * 3] = x;
          a[i * 3 + 1] = y;
          a[i * 3 + 2] = z;
          g |= GEO_BITS.HasArr;
        } else {
          a[i * 3] = anat[i * 3] as number;
          a[i * 3 + 1] = anat[i * 3 + 1] as number;
          a[i * 3 + 2] = anat[i * 3 + 2] as number;
          g &= ~GEO_BITS.HasArr;
        }
        geo[i] = g;
      }
      layer.touch("aArr");
      layer.touch("aArrPrev");
      layer.touch("aGeo");
    },
    writeState(state, from, count, animate) {
      const s = arr("aState");
      const start = Math.max(0, Math.min(cap, from));
      const end = Math.max(start, Math.min(cap, from + count, start + state.length));
      if (animate) {
        for (let i = 0; i < cap; i++) s[i * 2 + 1] = s[i * 2] as number;
        for (let i = start; i < end; i++) s[i * 2] = state[i - start] as number;
        layer.touch("aState");
        return;
      }
      for (let i = start; i < end; i++) {
        const v = state[i - start] as number;
        s[i * 2] = v;
        s[i * 2 + 1] = v;
      }
      layer.touch("aState", start, end - start);
    },
    writeBirths(births, from) {
      const misc = arr("aMisc");
      const start = Math.max(0, Math.min(cap, from));
      const end = Math.min(cap, start + births.length);
      for (let i = start; i < end; i++) misc[i * 4 + 2] = births[i - start] as number;
      layer.touch("aMisc", start, end - start);
    },
    writeGroups(groupOf, pop) {
      const g = arr("aGroup");
      const n = Math.min(cap, groupOf ? groupOf.length : layer.count);
      for (let i = 0; i < cap; i++) g[i] = 0;
      for (let i = 0; i < n; i++) g[i] = groupAttr(groupOf ? (groupOf[i] as number) : NO_GROUP, pop ? (pop[i] as number) : 0);
      layer.touch("aGroup");
    },
    pickObject(integerIds) {
      if (pick && pick.integer === integerIds) return pick.object;
      if (pick) {
        (pick.object.material as RawShaderMaterial).dispose();
        pick.object.geometry.dispose();
      }
      const g = new BufferGeometry();
      for (const name of Object.keys(attrs) as PointAttribute[]) g.setAttribute(name, attrs[name]);
      g.setDrawRange(0, layer.count);
      const m = new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: pickVert(),
        fragmentShader: integerIds ? PICK_FRAG : PICK_FRAG_RGBA8,
        transparent: false,
        depthTest: true,
        depthWrite: true,
        blending: NoBlending,
        uniforms: {
          ...core,
          uDotSize: pointUniforms.uDotSize as IUniform,
          uRefDist: pointUniforms.uRefDist as IUniform,
          uDistPow: pointUniforms.uDistPow as IUniform,
          uProfile: pointUniforms.uProfile as IUniform,
          uMinPickPx: { value: T.pointer.pickMinSizePx },
          uMinAlpha: { value: T.pointer.pickAlphaMin },
        },
      });
      const obj = new Points(g, m);
      obj.frustumCulled = false;
      pick = { object: obj, integer: integerIds };
      return obj;
    },
    setPaper(paper) {
      setPointBlending(material, paper);
      for (const r of Object.values(rings)) setPointBlending(r.material, paper);
    },
    dispose() {
      geom.dispose();
      material.dispose();
      for (const r of Object.values(rings)) {
        r.object.geometry.dispose();
        r.material.dispose();
      }
      if (pick) {
        pick.object.geometry.dispose();
        (pick.object.material as RawShaderMaterial).dispose();
        pick = null;
      }
    },
  };
  return layer;
}

/** Grow a layer: a new one with room for `count` (+25%), carrying every attribute over. */
export function growPointsLayer(old: PointsLayer, count: number): PointsLayer {
  const next = createPointsLayer(Math.max(count, Math.ceil(count * 1.25), 1024));
  for (const name of Object.keys(POINT_ATTRIBUTES) as PointAttribute[]) {
    const src = old.attr(name).array as Float32Array | Uint8Array | Uint32Array;
    const dst = next.attr(name).array as Float32Array | Uint8Array | Uint32Array;
    (dst as Float32Array).set((src as Float32Array).subarray(0, Math.min(src.length, dst.length)));
    next.touch(name);
  }
  for (const [k, u] of Object.entries(old.core)) {
    const target = next.core[k];
    if (target) target.value = u.value;
  }
  next.setCount(old.count);
  return next;
}
