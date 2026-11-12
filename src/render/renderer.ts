/**
 * CortexRenderer: owns the WebGL2 context, scene, HDR target, layers, camera, picking and the frame loop.
 * Owner: E10. Driven by RenderController (render/controller.ts) which maps store + worker results to calls.
 *
 * Frame: update the camera and tweens → draw haze, points, rings and lines additively (Ink) or premultiplied over
 * (Paper) into an RGBA16F target → tone-map and composite over the stage background to the canvas → report the
 * camera to the overlay (≤ 30 Hz) → picking is scheduled by the controller (≤ 30 Hz). The loop runs only while
 * something moves (spin, tweens, growth, colour fades) or a frame was requested, and stops when the leaf is
 * hidden or paused. Context loss: preventDefault, tell the controller, resume on restore (three re-uploads).
 *
 * The figure's pose (Standing by default, from settings or the leaf's view) chooses the home view, the long axis
 * of the cord, the direction fronds unfurl and the default motion; everything numeric is in RENDER_TUNING.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  GLSL3,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoBlending,
  OrthographicCamera,
  Points,
  RGBAFormat,
  RawShaderMaterial,
  Scene,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  WebGLRenderer,
  type IUniform,
} from "three";
import type { Logger } from "../shared/log";
import { bucketColor, desktopGround, hexToLinear, stageColours, tintedLift } from "../shared/palette";
import type { ArrangementResult, OverlayModel, PlacementResult, RegionLabel, Vec3 } from "../shared/protocol/worker";
import type { PaletteId, Pose, StageId } from "../shared/settings";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { hazeScale, type ViewControls } from "../state/types";
import { AnimatedValue, chartExitAt, DISSOLVE_MS, DISSOLVE_SPLIT, easeInOut, easeOut, fadeShape, IntroClock, linear, MorphFollower, queryFadeAt, scatterTerms, type FadeKind, type IntroKind } from "./animation";
import { TurntableCamera, arrangementAngles, chartFitGeom, fitArrangementCamera, HomeFitCache, type CameraLeg, type FitSamples, type Framing, type StageGeom } from "./camera";
import { probeGl, type GlCaps } from "./glCaps";
import { FrameGovernor, governorEffects, type GovernorStep } from "./governor";
import { createHazeLayer, hazeColors, type HazeColourInput, type HazeLayer, type Rgb } from "./layers/haze";
import { createFirstPaintLayer, type FirstPaintLayer } from "./layers/firstPaint";
import { buildCloud, condenseTargets, paintBusy, paintState, turnStartAt, yawXZ, type Cloud, type PaintClock } from "./firstPaint";
import { createLinesLayer, LINE_FAMILY, type LineFamily, type LinesLayer } from "./layers/lines";
import { linkAlpha, stemAlpha } from "./lineAlpha";
import { SRGB_TO_LINEAR, createPointsLayer, growPointsLayer, type PointLook, type PointsLayer } from "./layers/points";
import { Picker } from "./picking";
import { COMPOSITE_FRAG, COMPOSITE_VERT, CORD_SAMPLES, SEED_FRAG, SEED_VERT } from "./shaders";
import { RENDER_TUNING } from "./tuning";

const T = RENDER_TUNING;

/**
 * A canvas hands out ONE WebGL context for its whole life. When Cortex drops a context on purpose (a leaf released
 * after 60 s hidden, Restart), the next renderer on that canvas gets the same lost context back, so the context
 * must be restored first; a lost context's getExtension returns null, so each canvas's WEBGL_lose_context is kept
 * here. Every loss on a Cortex canvas is marked restorable (preventDefault), whoever is listening at the time.
 */
const loseExts = new WeakMap<HTMLCanvasElement, WEBGL_lose_context>();
const restorable = new WeakSet<HTMLCanvasElement>();

function keepRestorable(canvas: HTMLCanvasElement, ctx: WebGL2RenderingContext): void {
  const ext = ctx.getExtension("WEBGL_lose_context");
  if (ext) loseExts.set(canvas, ext);
  if (restorable.has(canvas)) return;
  restorable.add(canvas);
  canvas.addEventListener("webglcontextlost", (e) => e.preventDefault());
}

/** Restore a context Cortex lost on purpose; resolves when it is back (or after timeoutMs, and init then falls back). */
export async function restoreLostContext(canvas: HTMLCanvasElement, timeoutMs = 2000): Promise<void> {
  const ext = loseExts.get(canvas);
  if (!ext) return;
  const ctx = canvas.getContext("webgl2");
  if (!ctx || !ctx.isContextLost()) return;
  // The loss event is queued as a task; restoring before it has fired is ignored, so let it fire first.
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (): void => {
      if (timer !== null) clearTimeout(timer);
      canvas.removeEventListener("webglcontextrestored", done);
      resolve();
    };
    timer = setTimeout(done, timeoutMs);
    canvas.addEventListener("webglcontextrestored", done);
    try {
      ext.restoreContext();
    } catch {
      done();
    }
  });
}

export type StageName = "ink" | "paper";

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  log: Logger;
  reducedMotion: boolean;
  /** Cap device pixel ratio (default 2). */
  maxDpr?: number;
  /** Stage colour, sRGB 0..1 (the composite derives the lift and vignette from the stage name). */
  background: readonly [number, number, number];
  /** The leaf's pose; defaults to the shared settings' `general.pose`. */
  pose?: Pose;
  stage?: StageName;
  /** Stage tint hue (OKLCH degrees) or null. */
  stageTint?: number | null;
  /** The Settings > Appearance theme card (a Cortex theme changes the stage colours on Ink). */
  stageTheme?: StageId;
  /** The window that owns the canvas (pop-outs): frame callbacks, timers and DPR come from it. */
  win?: Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame" | "setTimeout" | "devicePixelRatio">;
  /** Monotonic ms clock (tests inject one). */
  clock?: () => number;
}

export interface RenderStats {
  fps: number;
  frameMs: number;
  points: number;
  drawCalls: number;
}

export type RenderStatus = "ok" | "context-lost" | "no-webgl";

/** What the overlay layers need after a frame: the camera and the canvas in CSS px. */
export interface FrameInfo {
  nowMs: number;
  width: number;
  height: number;
  camera: TurntableCamera;
}

/** Scene-level bounds the controller and the label layout use. */
export interface FigureBounds {
  centre: Vec3;
  radius: number;
  brainCentre: Vec3;
  brainRadius: number;
}

/** Stage colours go to the shader as linear light (hexToRgb is 0..1, so it cannot index the byte table: that left every stage black). */
const linearOf = hexToLinear;

export class CortexRenderer {
  private gl: WebGLRenderer | null = null;
  private caps: GlCaps | null = null;
  private hdr: WebGLRenderTarget | null = null;
  private readonly scene = new Scene();
  private readonly compositeScene = new Scene();
  private readonly compositeCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private composite: RawShaderMaterial | null = null;
  private points: PointsLayer | null = null;
  private haze: HazeLayer | null = null;
  private lines: LinesLayer | null = null;
  private seed: { object: Points; material: RawShaderMaterial } | null = null;
  /** The first-paint cloud (null when none is showing). */
  private fp: { cloud: Cloud; layer: FirstPaintLayer; clock: PaintClock; targets: Uint32Array | null; replayFromMs: number | null } | null = null;
  private picker: Picker | null = null;

  readonly camera: TurntableCamera;
  readonly clock = new IntroClock();
  private readonly morph = new MorphFollower();
  private readonly form = new AnimatedValue(1);
  private readonly stateT = new AnimatedValue(1);
  private readonly others = new AnimatedValue(1);
  private readonly hazeDim = new AnimatedValue(1);
  private readonly scopeSink = new AnimatedValue(0);
  private readonly scopeFlash = new AnimatedValue(0);
  private readonly swirl = new AnimatedValue(0);
  private readonly recolour = new AnimatedValue(1);
  private readonly fade = new AnimatedValue(1);
  private readonly governor = new FrameGovernor();
  // Point-shader effects (P04).
  private readonly dissolve = new AnimatedValue(1);
  private dissolveActive = false;
  private colourSnapUntil = Number.NEGATIVE_INFINITY;
  private queryFadeStart = 0;
  private queryFadeActive = false;
  private queryFadeLast = Number.NEGATIVE_INFINITY;
  private fadeKind: FadeKind = "query";
  /** A click is waiting for the worker: the points dissolve toward the transit silhouette (ramp 0..1). */
  private readonly pending = new AnimatedValue(0);
  /** The entry style of the form morph in flight (0 plain, 1 smear, 2 burst, 3 rise) and its size. */
  private entry = { style: 0, amp: 0 };
  /** A flat chart is closing: its layout shrinks toward `exitAnchor` while fading (driven by the morph value). */
  private exitMode = false;
  private readonly exitAnchor = new Vector3();
  private exitReady = false;
  private readonly hoverOn = new AnimatedValue(0);
  private readonly streak = new AnimatedValue(0);
  private effectPalette: PaletteId = "prism";
  private exporting = false;
  private suspended = false;
  private shimmerPending = false;
  private shimmerPaced = false;
  private shimmerGen = 0;
  /** The point effects that can be switched: defaults come from RENDER_TUNING (shimmer, morph.groupChange, states.regrowOnQuery, transit.silhouette). */
  private effects: { shimmer: boolean; groupChange: "dissolve" | "travel"; regrowOnQuery: boolean; transit: boolean } = {
    shimmer: T.shimmer.on,
    groupChange: T.morph.groupChange,
    regrowOnQuery: T.states.regrowOnQuery,
    transit: T.transit.silhouette,
  };

  private pose: Pose;
  private stage: StageName;
  private stageTint: number | null;
  private stageTheme: StageId = "follow";
  private view: ViewControls | null = null;
  private count = 0;
  private placement: PlacementResult | null = null;
  private fitSamples: FitSamples | null = null;
  /** The last home fit (see HomeFitCache). */
  private homeFit = new HomeFitCache();
  private figure: FigureBounds = { centre: [0, 0, 0], radius: 5.5, brainCentre: [0, 4, 0], brainRadius: 1.6 };
  private geom: StageGeom = { width: 1, height: 1, insetLeft: 0, insetRight: 0, breakpoint: "XL" };
  private dpr = 1;
  private cssW = 1;
  private cssH = 1;
  private raf: number | null = null;
  private running = false;
  private frameRequested = true;
  private lost = false;
  private disposed = false;
  private t0 = 0;
  private lastMs = 0;
  private lastFrameInfoMs = 0;
  private fps = 0;
  private frameMs = 0;
  private fpsAcc = { n: 0, since: 0 };
  private hover = -1;
  private selected = -1;
  private active = -1;
  private pointBudget = 300_000;
  private smallBrain = false;
  private dataPresent = false;
  private lineDim = 1;
  private overlayModel: OverlayModel | null = null;
  /** The framing of the flat chart on screen (the Home view returns to it); null with no flat chart. */
  private arrangementFit: Framing | null = null;
  /** What the flat chart on screen is fitted from, so a resized stage can fit it again (null with no flat chart). */
  /** What the floating Chart card (left) and the Display popover (right) cover of the stage, CSS px; charts are fitted between them. */
  private chartCover = { left: 0, right: 0 };
  /** The arrangement on screen is a chart (the cover applies to it; the figure and the other shapes ignore the panels). */
  private arrangementChart = false;
  private arrangementCam: { camera: ArrangementResult["camera"]; angles: { yawDeg: number; pitchDeg: number } } | null = null;
  private handlers: { frame?: (f: FrameInfo) => void; status?: (s: RenderStatus, governor?: GovernorStep) => void } = {};
  private onContextLost: ((e: Event) => void) | null = null;
  private onContextRestored: (() => void) | null = null;
  private pickBusy = false;

  constructor(private readonly opts: RendererOptions) {
    this.pose = opts.pose ?? DEFAULT_SETTINGS.general.pose;
    this.stage = opts.stage ?? "ink";
    this.stageTint = opts.stageTint ?? null;
    this.stageTheme = opts.stageTheme ?? "follow";
    this.camera = new TurntableCamera(1, this.pose);
    this.camera.reduced = opts.reducedMotion;
    this.watchLongTasks();
  }

  /** End of the latest main-thread long task (performance.now() time): slow frames around it aren't the GPU's (governor). */
  private busyUntil = Number.NEGATIVE_INFINITY;
  private longTasks: PerformanceObserver | null = null;

  private watchLongTasks(): void {
    if (this.opts.clock || typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return;
    try {
      this.longTasks = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this.busyUntil = Math.max(this.busyUntil, e.startTime + e.duration);
      });
      this.longTasks.observe({ type: "longtask" });
    } catch {
      this.longTasks = null;
    }
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  private now(): number {
    return this.opts.clock ? this.opts.clock() : performance.now();
  }

  private win(): NonNullable<RendererOptions["win"]> {
    return this.opts.win ?? window;
  }

  /** Create the context and GPU objects; resolves false when WebGL2 is unavailable (fallback shown). */
  async init(): Promise<boolean> {
    try {
      const canvas = this.opts.canvas;
      await restoreLostContext(canvas);
      const gl = new WebGLRenderer({ canvas, antialias: false, alpha: false, depth: false, stencil: false, powerPreference: "high-performance", preserveDrawingBuffer: false });
      const ctx = gl.getContext() as WebGL2RenderingContext;
      keepRestorable(canvas, ctx);
      const caps = probeGl(ctx);
      if (!caps.floatTargets) {
        gl.dispose();
        this.opts.log.warn("renderer: no float render targets", { renderer: caps.renderer });
        this.handlers.status?.("no-webgl");
        return false;
      }
      this.gl = gl;
      this.caps = caps;
      gl.autoClear = false;
      gl.setClearColor(0x000000, 0);
      this.picker = new Picker(gl, caps.r32uiTarget);
      this.buildScene();
      this.t0 = this.now();
      this.attachContextEvents(canvas);
      return true;
    } catch (e) {
      this.opts.log.warn("renderer: WebGL2 unavailable", { error: String(e) });
      this.handlers.status?.("no-webgl");
      return false;
    }
  }

  private detachContextEvents(): void {
    const canvas = this.opts.canvas;
    if (this.onContextLost) canvas.removeEventListener("webglcontextlost", this.onContextLost as EventListener);
    if (this.onContextRestored) canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.onContextLost = null;
    this.onContextRestored = null;
  }

  private attachContextEvents(canvas: HTMLCanvasElement): void {
    this.onContextLost = (e) => {
      e.preventDefault();
      this.lost = true;
      this.cancelFrame();
      this.handlers.status?.("context-lost");
    };
    this.onContextRestored = () => {
      this.lost = false;
      this.picker?.dispose();
      if (this.gl && this.caps) this.picker = new Picker(this.gl, this.caps.r32uiTarget);
      this.hdr?.dispose();
      this.hdr = null;
      this.handlers.status?.("ok");
      this.invalidate();
    };
    canvas.addEventListener("webglcontextlost", this.onContextLost as EventListener);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  private buildScene(): void {
    this.points = createPointsLayer(1024);
    this.haze = createHazeLayer();
    this.lines = createLinesLayer();
    const paper = this.stage === "paper";
    this.points.setPaper(paper);
    this.haze.setPaper(paper);
    this.lines.setPaper(paper);
    if (this.view) this.lines.setAlpha(LINE_FAMILY.Stem, stemAlpha(this.view.look.stemStrength));
    this.addPointsToScene(this.points);
    this.scene.add(this.haze.object);
    for (const o of this.lines.objects) this.scene.add(o);
    // The seed ring of the intro: one sprite at the top of the brainstem.
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array([0, 0, 0]), 3));
    const material = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: SEED_VERT,
      fragmentShader: SEED_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: {
        uSeedPos: { value: new Vector3(0, T.figure.brainstemTopY, 0) },
        uSeedPx: { value: 0 },
        uSeedT: { value: 0 },
        uDpr: { value: 1 },
        uWriteScale: { value: 1 },
        uRingColor: { value: new Vector3(1, 1, 1) },
      },
    });
    const object = new Points(g, material);
    object.frustumCulled = false;
    object.renderOrder = 9;
    object.visible = false;
    this.scene.add(object);
    this.seed = { object, material };
    // Composite: one big triangle.
    const tri = new BufferGeometry();
    tri.setAttribute("position", new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.composite = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: COMPOSITE_VERT,
      fragmentShader: COMPOSITE_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
      uniforms: {
        uHdr: { value: null },
        uExposure: { value: T.stage.toneK },
        uReadScale: { value: 1 },
        uPaper: { value: 0 },
        uStage: { value: new Vector3() },
        uLift: { value: new Vector3() },
        uSize: { value: new Vector2(1, 1) },
        uLiftEllipse: { value: new Vector4() },
        uLiftPow: { value: T.stage.standingLift.power },
        uVignette: { value: new Vector4() },
        uStageOrigin: { value: new Vector2(0, 0) },
        uStageSize: { value: new Vector2(1, 1) },
      },
    });
    const mesh = new Mesh(tri, this.composite);
    mesh.frustumCulled = false;
    this.compositeScene.add(mesh);
    this.applyStageColours();
  }

  private addPointsToScene(layer: PointsLayer): void {
    this.scene.add(layer.object);
    layer.object.renderOrder = 2;
    layer.rings.active.object.renderOrder = 3;
    layer.rings.selected.object.renderOrder = 4;
    layer.rings.hover.object.renderOrder = 5;
    this.scene.add(layer.rings.active.object, layer.rings.selected.object, layer.rings.hover.object);
  }

  on(handlers: { frame?: (f: FrameInfo) => void; status?: (s: RenderStatus, governor?: GovernorStep) => void }): void {
    this.handlers = { ...this.handlers, ...handlers };
  }


  // ───────────────────────────── stage, pose, view ─────────────────────────────

  /** Ink or Paper, the stage tint and the palette's forced stage. */
  setStage(stage: StageName, tint: number | null, theme: StageId = this.stageTheme): void {
    this.stage = stage;
    this.stageTint = tint;
    this.stageTheme = theme;
    const paper = stage === "paper";
    this.points?.setPaper(paper);
    this.haze?.setPaper(paper);
    this.lines?.setPaper(paper);
    this.setUniform(this.points?.material, "uPaper", paper ? 1 : 0);
    this.setUniform(this.haze?.material, "uPaper", paper ? 1 : 0);
    for (const o of this.lines?.objects ?? []) this.setUniform(o.material as RawShaderMaterial, "uPaper", paper ? 1 : 0);
    this.applyStageColours();
    this.applyEffectColours();
    this.invalidate();
  }

  /** Switch the point effects (shimmer, grouping change style, query regrow, transit pose); omitted keys keep their value. */
  setEffects(patch: Partial<{ shimmer: boolean; groupChange: "dissolve" | "travel"; regrowOnQuery: boolean; transit: boolean }>): void {
    this.effects = { ...this.effects, ...patch };
    this.invalidate();
  }

  /** The palette whose colours tint the transit pose (coral) and the hover trail; follows the stage's Ink / Paper variant. */
  setEffectPalette(palette: PaletteId): void {
    this.effectPalette = palette;
    this.applyEffectColours();
    this.invalidate();
  }

  private applyEffectColours(): void {
    const m = this.points?.material;
    if (!m) return;
    const variant = this.stage === "paper" ? "light" : "glow";
    const lin = (rgb: readonly [number, number, number], into: Vector3): void => {
      into.set(SRGB_TO_LINEAR[Math.round(rgb[0])] as number, SRGB_TO_LINEAR[Math.round(rgb[1])] as number, SRGB_TO_LINEAR[Math.round(rgb[2])] as number);
    };
    const tint = m.uniforms.uStreakTint?.value as Vector3[] | undefined;
    if (tint) T.hover.streakSlots.forEach((slot, i) => tint[i] && lin(bucketColor("value", slot, this.effectPalette, variant), tint[i] as Vector3));
    const warm = m.uniforms.uHumanTint?.value as Vector3 | undefined;
    if (warm) lin(bucketColor("value", T.transit.tintSlot, this.effectPalette, variant), warm);
  }

  private applyStageColours(): void {
    if (!this.composite) return;
    const desktop = typeof document !== "undefined" && document.body?.classList?.contains("cxd-app") === true;
    const colours = desktop ? desktopGround(this.stageTheme, this.stage) : stageColours(this.stageTheme, this.stage);
    const lift = tintedLift(colours.lift, this.stageTint, this.stage);
    const u = this.composite.uniforms;
    (u.uStage?.value as Vector3).set(...linearOf(colours.stage));
    (u.uLift?.value as Vector3).set(...linearOf(lift));
    (u.uPaper as IUniform).value = this.stage === "paper" ? 1 : 0;
    this.layoutComposite(1);
  }

  /** Lift ellipse and vignette for the current stage size (px × `scale`). */
  private layoutComposite(scale: number): void {
    if (!this.composite) return;
    const u = this.composite.uniforms;
    const W = this.cssW * scale, H = this.cssH * scale;
    const lift = this.pose === "standing" ? T.stage.standingLift : T.stage.lyingLift;
    const cx = this.pose === "standing" ? (this.geom.insetLeft + (T.frame.standing.centreLeftPx + (this.cssW - this.geom.insetLeft - this.geom.insetRight) - T.frame.standing.centreRightPx) / 2) * scale : ("centreX" in lift ? lift.centreX * W : W / 2);
    const cy = "centreY" in lift ? lift.centreY * H : H / 2;
    (u.uLiftEllipse?.value as Vector4).set(cx, cy, lift.radiusX * W, lift.radiusY * H);
    (u.uLiftPow as IUniform).value = lift.power;
    const v = T.stage.vignette;
    (u.uVignette?.value as Vector4).set(v.radiusX, v.radiusY, v.start, v.strength);
    (u.uSize?.value as Vector2).set(W, H);
    (u.uStageSize?.value as Vector2).set(W, H);
    (u.uStageOrigin?.value as Vector2).set(0, 0);
  }

  /** The leaf's pose: Standing (brain on top, time runs down the cord) or Lying (the same skeleton turned +90°). */
  setPose(pose: Pose): void {
    if (pose === this.pose) return;
    this.pose = pose;
    this.applyPoseUniforms();
    this.layoutComposite(1);
    this.refit(0);
  }

  getPose(): Pose {
    return this.pose;
  }

  private applyPoseUniforms(): void {
    const core = this.points?.core;
    if (!core) return;
    const standing = this.pose === "standing";
    (core.uLongAxis?.value as Vector3).set(standing ? 0 : 1, standing ? 1 : 0, 0);
    // Time runs down the cord: toward -Y when standing, toward +X when lying (the standing figure turned +90°).
    (core.uTip?.value as Vector3).set(standing ? 0 : 1, standing ? -1 : 0, 0);
    // The transit pose is drawn upright (standing) or turned +90 degrees (lying): the figure's local x and y axes in the world.
    (core.uHumX?.value as Vector3).set(standing ? 1 : 0, standing ? 0 : 1, 0);
    (core.uHumY?.value as Vector3).set(standing ? 0 : -1, standing ? 1 : 0, 0);
  }

  /** Apply the leaf's view controls: pose, motion, look, morph and layers that affect drawing. */
  setView(v: ViewControls): void {
    const prev = this.view;
    this.view = v;
    this.setPose(v.pose);
    const mode = v.motion.mode;
    this.camera.setMotion(mode, v.motion.speed);
    this.camera.setKeepUpright(v.motion.keepUpright);
    const now = this.now();
    if (prev && v.shape === "chart" && this.exitReady && !this.opts.reducedMotion) {
      if (v.morph < prev.morph) this.exitMode = true;
      else if (v.morph > prev.morph) this.exitMode = false;
    } else if (v.shape !== "chart") this.exitMode = false;
    const how = this.morph.follow(v.morph, now, this.opts.reducedMotion);
    if (how === "jump" && this.opts.reducedMotion && prev && prev.morph !== v.morph) this.fade.set(1, now, T.shape.reducedDipMs, linear);
    const look = v.look;
    for (const m of [this.points?.material, this.haze?.material]) {
      this.setUniform(m, "uDotSize", look.dotSize);
      this.setUniform(m, "uGlow", this.halosOn() ? look.glow : 0);
    }
    this.setUniform(this.points?.material, "uScatter", look.scatter);
    this.lines?.setAlpha(LINE_FAMILY.Stem, stemAlpha(look.stemStrength));
    this.applySpread(look.scatter);
    this.hazeDim.set(this.hazeRest * hazeScale(v.layers, look), now, T.growth.hazeFadeSec * 1000, easeOut);
    if (this.composite) (this.composite.uniforms.uExposure as IUniform).value = T.stage.toneK * look.brightness;
    this.invalidate();
  }

  /** The Scatter slider's global body terms: cerebrum scale, cord brightness and size, body-field density. */
  private applySpread(scatter: number): void {
    const t = scatterTerms(scatter);
    const core = this.points?.core;
    if (core?.uBrainScale) core.uBrainScale.value = t.brainScale;
    this.setUniform(this.points?.material, "uCordBright", t.cordBright);
    this.setUniform(this.points?.material, "uCordSize", t.cordSize);
    this.setUniform(this.haze?.material, "uBrainScale", t.brainScale);
    this.setUniform(this.haze?.material, "uHazeDensity", t.hazeDensity);
  }

  private hazeRest = 1;

  private halosOn(): boolean {
    return governorEffects(this.governor.step).halos;
  }

  private setUniform(m: RawShaderMaterial | undefined | null, name: string, value: number): void {
    const u = m?.uniforms[name];
    if (u) u.value = value;
  }

  // ───────────────────────────── data ─────────────────────────────

  /**
   * New placement. `look` carries each ordinal's draw kind and rest intensity (from the index: notes, maps,
   * conversation fronds, single entries on the cord, undated). The cord's centre line is taken from the thread
   * haze so fronds unfurl from the right spots even when the S-curve changes.
   */
  setPlacement(p: PlacementResult, count: number, look: PointLook): void {
    if (!this.points || !this.haze) return;
    this.governor.interrupt();
    this.placement = p;
    this.count = count;
    if (count > this.points.capacity) {
      const old = this.points;
      this.scene.remove(old.object, old.rings.active.object, old.rings.selected.object, old.rings.hover.object);
      this.points = growPointsLayer(old, count);
      old.dispose();
      this.points.setPaper(this.stage === "paper");
      this.addPointsToScene(this.points);
      // A grown layer starts from default material uniforms: put the view's look and the effect colours back.
      if (this.view) this.setView(this.view);
      this.applyEffectColours();
    }
    const layer = this.points;
    layer.setCount(count);
    layer.writePlacement(p, look, count);
    this.haze.setPositions(p.haze.pos, p.haze.kind, p.haze.birth, p.haze.count, p.haze.bright);
    this.hazeAge = p.haze.tau ?? null;
    this.dataPresent = count > 0;
    this.smallBrain = false;
    this.computeFigure(p, look);
    this.applyPoseUniforms();
    this.applyFigureUniforms();
    this.buildFitSamples(p);
    this.refit(this.camera.isAtHome() ? 0 : T.fly.refitMs);
    // The first fit after load opens with a dolly: the camera pulls back from close to the home view.
    if (!this.dollied && this.fitSamples && this.fitSamples.count > 0) {
      this.dollied = true;
      if (this.camera.isAtHome()) this.camera.dollyIn(this.now(), this.opts.reducedMotion ? 0 : T.camera.introDollyMs);
    }
    this.invalidate();
  }

  private dollied = false;

  /** Update the per-point look after notes/records changed counts (small-brain boosts). */
  setSmallness(notes: number, record: number): void {
    this.smallBrain = notes < T.intensity.smallBrainNotes;
    this.setUniform(this.points?.material, "uSmallBrain", this.smallBrain ? T.intensity.smallBrainDot : 1);
    const thin = record > 0 ? Math.min(T.intensity.thinRecordMax, Math.max(1, Math.pow(T.intensity.thinRecordReference / record, T.intensity.thinRecordPower))) : 1;
    this.setUniform(this.points?.material, "uSmallRecord", record < T.intensity.smallRecordEntries ? Math.max(thin, T.intensity.smallRecordDot) : thin);
    const empty = notes + record === 0;
    this.setUniform(this.haze?.material, "uBoost", empty ? T.intensity.emptyHaze : 1);
    this.setUniform(this.haze?.material, "uBrainBoost", this.smallBrain ? T.intensity.smallBrainHaze : 1);
    this.invalidate();
  }

  private computeFigure(p: PlacementResult, look: PointLook): void {
    const standing = this.pose === "standing";
    // Centre and radius of everything placed (haze included), the brain from the note and brain-haze points.
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const eat = (x: number, y: number, z: number): void => {
      if (!Number.isFinite(x + y + z)) return;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    };
    for (let i = 0; i < p.haze.count; i++) eat(p.haze.pos[i * 3] as number, p.haze.pos[i * 3 + 1] as number, p.haze.pos[i * 3 + 2] as number);
    for (let i = 0; i < this.count; i++) eat(p.anat[i * 3] as number, p.anat[i * 3 + 1] as number, p.anat[i * 3 + 2] as number);
    if (!Number.isFinite(x0)) {
      const h = T.figure;
      x0 = -3; x1 = 3; y0 = h.undatedLowY; y1 = h.crownY; z0 = -1; z1 = 1;
    }
    const centre: Vec3 = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    const radius = Math.max(1, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2);
    // Brain: the notes' own points, else the default brain position of the pose.
    let bx = 0, by = 0, bz = 0, bn = 0;
    for (let i = 0; i < this.count; i++) {
      const k = look.kind[i] ?? 0;
      if (k !== 2 && k !== 3) continue;
      const x = p.anat[i * 3] as number, y = p.anat[i * 3 + 1] as number, z = p.anat[i * 3 + 2] as number;
      if (!Number.isFinite(x + y + z)) continue;
      bx += x; by += y; bz += z; bn++;
    }
    let brainCentre: Vec3 = standing ? [0, 4, 0.06] : [-4, 0, 0.06];
    if (bn > 0) brainCentre = [bx / bn, by / bn, bz / bn];
    let br = 0;
    for (let i = 0; i < this.count; i++) {
      const k = look.kind[i] ?? 0;
      if (k !== 2 && k !== 3) continue;
      const x = (p.anat[i * 3] as number) - brainCentre[0], y = (p.anat[i * 3 + 1] as number) - brainCentre[1], z = (p.anat[i * 3 + 2] as number) - brainCentre[2];
      if (Number.isFinite(x + y + z)) br = Math.max(br, Math.hypot(x, y, z));
    }
    this.figure = { centre, radius, brainCentre, brainRadius: br > 0.2 ? br : 1.6 };
    this.computeCord(p);
  }

  /** Cord centre line: the thread haze (or the brainstem/ring haze) binned along the long axis. */
  private computeCord(p: PlacementResult): void {
    const core = this.points?.core;
    if (!core) return;
    const axis = this.pose === "standing" ? 1 : 0;
    const names = ["thread", "ring", "brainstem"];
    const kindsList = names.map((n) => this.hazeKindIndex(n)).filter((i) => i >= 0);
    let lo = Infinity, hi = -Infinity;
    const sel: number[] = [];
    for (const k of kindsList) {
      for (let i = 0; i < p.haze.count; i++) {
        if ((p.haze.kind[i] as number) !== k) continue;
        const s = p.haze.pos[i * 3 + axis] as number;
        if (!Number.isFinite(s)) continue;
        sel.push(i);
        if (s < lo) lo = s;
        if (s > hi) hi = s;
      }
      if (sel.length > 200) break;
    }
    const samples = core.uCord?.value as Vector3[];
    const span = core.uCordSpan?.value as number[];
    if (sel.length < 8 || !(hi > lo)) {
      // No cord haze: a straight cord through the origin along the long axis.
      const a = this.pose === "standing" ? -5 : 5;
      span[0] = Math.min(-5, a);
      span[1] = 5;
      for (let i = 0; i < CORD_SAMPLES; i++) {
        const s = span[0]! + ((span[1]! - span[0]!) * i) / (CORD_SAMPLES - 1);
        (samples[i] as Vector3).set(axis === 1 ? 0 : s, axis === 1 ? s : 0, 0);
      }
      return;
    }
    span[0] = lo;
    span[1] = hi;
    const sum = new Float64Array(CORD_SAMPLES * 3);
    const cnt = new Uint32Array(CORD_SAMPLES);
    for (const i of sel) {
      const s = p.haze.pos[i * 3 + axis] as number;
      const b = Math.min(CORD_SAMPLES - 1, Math.max(0, Math.round(((s - lo) / (hi - lo)) * (CORD_SAMPLES - 1))));
      sum[b * 3] = (sum[b * 3] as number) + (p.haze.pos[i * 3] as number);
      sum[b * 3 + 1] = (sum[b * 3 + 1] as number) + (p.haze.pos[i * 3 + 1] as number);
      sum[b * 3 + 2] = (sum[b * 3 + 2] as number) + (p.haze.pos[i * 3 + 2] as number);
      cnt[b] = (cnt[b] as number) + 1;
    }
    // Fill empty bins by interpolating between the nearest filled neighbours, then place on the axis exactly.
    const filled: number[] = [];
    for (let i = 0; i < CORD_SAMPLES; i++) if ((cnt[i] as number) > 0) filled.push(i);
    for (let i = 0; i < CORD_SAMPLES; i++) {
      const s = lo + ((hi - lo) * i) / (CORD_SAMPLES - 1);
      let c: [number, number, number];
      if ((cnt[i] as number) > 0) c = [(sum[i * 3] as number) / (cnt[i] as number), (sum[i * 3 + 1] as number) / (cnt[i] as number), (sum[i * 3 + 2] as number) / (cnt[i] as number)];
      else {
        let a = -1, b = -1;
        for (const f of filled) {
          if (f < i) a = f;
          else if (f > i && b < 0) b = f;
        }
        const pick = (j: number): [number, number, number] => [(sum[j * 3] as number) / (cnt[j] as number), (sum[j * 3 + 1] as number) / (cnt[j] as number), (sum[j * 3 + 2] as number) / (cnt[j] as number)];
        if (a < 0 && b < 0) c = [0, 0, 0];
        else if (a < 0) c = pick(b);
        else if (b < 0) c = pick(a);
        else {
          const f = (i - a) / (b - a);
          const A = pick(a), B = pick(b);
          c = [A[0] + (B[0] - A[0]) * f, A[1] + (B[1] - A[1]) * f, A[2] + (B[2] - A[2]) * f];
        }
      }
      if (axis === 1) c[1] = s;
      else c[0] = s;
      (samples[i] as Vector3).set(c[0], c[1], c[2]);
    }
    // Seed ring: the top of the brainstem (the oldest end of the cord).
    const seedAt = this.pose === "standing" ? (samples[CORD_SAMPLES - 1] as Vector3) : (samples[0] as Vector3);
    (this.seed?.material.uniforms.uSeedPos?.value as Vector3 | undefined)?.copy(seedAt);
  }

  private hazeKindIndex(name: string): number {
    const kinds = this.hazeKinds;
    return kinds.indexOf(name);
  }

  /** The haze kind names in protocol order (set from shared/protocol/worker by the controller). */
  hazeKinds: readonly string[] = [];
  /** Brain-region labels of the latest role placement (the stage's region overlay reads them when it mounts). */
  regionLabels: readonly RegionLabel[] = [];

  private applyFigureUniforms(): void {
    const core = this.points?.core;
    if (!core) return;
    const f = this.figure;
    (core.uBrain?.value as Vector4).set(f.brainCentre[0], f.brainCentre[1], f.brainCentre[2], f.brainRadius);
    (this.haze?.material.uniforms.uBrainC?.value as Vector3 | undefined)?.set(f.brainCentre[0], f.brainCentre[1], f.brainCentre[2]);
    for (const m of [this.points?.material, this.haze?.material]) {
      const u = m?.uniforms.uFigure;
      if (u) (u.value as Vector4).set(f.centre[0], f.centre[1], f.centre[2], f.radius);
    }
    this.lines?.setFigure(new Vector4(f.centre[0], f.centre[1], f.centre[2], f.radius), 0);
  }

  private buildFitSamples(p: PlacementResult): void {
    const cap = T.frame.fitSamples;
    const total = p.haze.count + this.count;
    const stride = Math.max(1, Math.ceil(total / cap));
    const pos = new Float32Array(Math.ceil(total / stride) * 3 + 6);
    const data = new Uint8Array(pos.length / 3);
    let n = 0;
    const add = (x: number, y: number, z: number, d: number): void => {
      if (!Number.isFinite(x + y + z)) return;
      pos[n * 3] = x; pos[n * 3 + 1] = y; pos[n * 3 + 2] = z; data[n] = d;
      n++;
    };
    for (let i = 0; i < p.haze.count; i += stride) add(p.haze.pos[i * 3] as number, p.haze.pos[i * 3 + 1] as number, p.haze.pos[i * 3 + 2] as number, 0);
    for (let i = 0; i < this.count; i += stride) add(p.anat[i * 3] as number, p.anat[i * 3 + 1] as number, p.anat[i * 3 + 2] as number, 1);
    // The extremes, so a sparse record still frames the whole figure.
    if (p.bounds) {
      add(p.bounds.min[0], p.bounds.min[1], p.bounds.min[2], 0);
      add(p.bounds.max[0], p.bounds.max[1], p.bounds.max[2], 0);
    }
    this.fitSamples = { pos: pos.subarray(0, n * 3), count: n, data: data.subarray(0, n) };
  }

  /** Age position of each haze point on the cord (the thread takes the spine's colours by it). */
  private hazeAge: Float32Array | null = null;

  /** Colour the haze: territories from the notes' colours, the mist, the oldest age stop and the undated slate. */
  setHazeColours(input: Omit<HazeColourInput, "pos" | "kind" | "count" | "age">): void {
    const h = this.haze;
    if (!h || h.count === 0) return;
    h.setColors(hazeColors({ ...input, pos: h.positions(), kind: h.kinds(), count: h.count, age: this.hazeAge }));
    this.invalidate();
  }

  /** New colours; animate = a per-point recolour lerp (600 ms, or `ms`). */
  setColors(rgba: Uint8Array, animate: boolean, ms: number = T.states.recolourMs): void {
    if (!this.points) return;
    const now = this.now();
    const t = this.recolour.value(now);
    // During a grouping dissolve the new colours simply appear with the refill (no cross-fade of the old ones).
    const lerp = animate && !this.opts.reducedMotion && now >= this.colourSnapUntil;
    this.points.writeColors(rgba, lerp, t);
    if (lerp) {
      this.recolour.jump(0);
      this.recolour.set(1, now, ms, easeInOut);
    } else this.recolour.jump(1);
    this.invalidate();
  }

  /** New arrangement targets: "morph" (anatomy↔arranged) or "form" (arrangement→arrangement). */
  setArrangement(a: ArrangementResult | null, mode: "morph" | "form", opts: { groups?: boolean; chart?: boolean; reason?: "group"; formMs?: number; entry?: 0 | 1 | 2 | 3; relayout?: boolean } = {}): void {
    if (!this.points) return;
    const now = this.now();
    // The worker has replied: the points that were dissolving toward the silhouette land in the arrangement.
    this.endPending();
    const entryKey = (["curl", "smear", "burst", "rise"] as const)[opts.entry ?? 0] ?? "curl";
    this.entry = { style: mode === "form" && !this.opts.reducedMotion ? (opts.entry ?? 0) : 0, amp: (opts.entry ?? 0) > 0 ? T.shape.entry[entryKey] * this.figure.radius * 0.18 : 0 };
    this.exitReady = a !== null && a.camera.keepUpright && this.computeExitAnchor(a.arr);
    if (mode === "form" && opts.relayout && !opts.reason) this.queryFade("query", true);
    this.points.writeArrangement(a ? a.arr : null, mode);
    this.overlayModel = a ? a.overlay : null;
    // A change of the Group by dimension dissolves and refills instead of travelling (the shape slider still travels).
    const dissolve = mode === "form" && opts.reason === "group" && !!a && this.count > 0 && !this.opts.reducedMotion && this.effects.groupChange === "dissolve";
    this.dissolveActive = dissolve;
    if (dissolve) {
      // Positions swap at the split without travel: updateUniforms drives uForm from the dissolve's progress.
      this.form.jump(1);
      this.dissolve.jump(0);
      this.dissolve.set(1, now, DISSOLVE_MS, linear);
      this.recolour.jump(1);
      this.colourSnapUntil = now + DISSOLVE_MS;
    } else if (mode === "form") {
      if (this.opts.reducedMotion) this.form.jump(1);
      else {
        this.form.jump(0);
        this.form.set(1, now, opts.formMs ?? T.shape.formMs, easeInOut);
      }
    } else this.form.jump(1);
    if (a) {
      const c = a.camera;
      const angles = arrangementAngles(c, this.camera.heading(now).headingDeg);
      this.arrangementChart = opts.chart === true;
      const f = fitArrangementCamera(c, this.arrangementGeom(), angles);
      this.arrangementFit = c.keepUpright ? f : null;
      this.arrangementCam = c.keepUpright ? { camera: c, angles } : null;
      this.camera.setForcedUpright(c.keepUpright, c.keepUpright ? angles : null);
      // The chart owns the camera now: a later resize or home fit of the figure must not swing it back behind the chart.
      if (c.keepUpright) this.camera.leaveHome();
      // Groups fly in (back off and drop, then in and up under the figure); other shapes re-fit plainly.
      if (!(opts.groups && this.camera.groupFlight(f, now))) this.camera.fit(f, now, this.opts.reducedMotion ? 0 : T.fly.refitMs);
    } else {
      // Leaving a flat chart: the camera that faced its plane turns back to the figure's home view.
      if (this.camera.isForcedUpright()) this.camera.reset(now, this.opts.reducedMotion ? 0 : T.fly.refitMs);
      this.camera.setForcedUpright(false);
      this.arrangementFit = null;
      this.arrangementCam = null;
      this.arrangementChart = false;
      this.camera.forgetGroupFlight();
    }
    this.invalidate();
  }

  /** Top-centre of a flat chart's layout, where it shrinks to when it closes. */
  private computeExitAnchor(arr: Float32Array): boolean {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z = 0, n = 0;
    for (let i = 0; i + 2 < arr.length; i += 3) {
      const x = arr[i] as number, y = arr[i + 1] as number;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      z += arr[i + 2] as number;
      n++;
    }
    if (n === 0) return false;
    this.exitAnchor.set((x0 + x1) / 2, y0 + (y1 - y0) * T.shape.chartExit.topFrac, z / n);
    return true;
  }

  /** A click on Groups or a chart: start dissolving toward the transit silhouette on this frame; setArrangement lands them. */
  beginPending(): void {
    if (this.opts.reducedMotion || !this.points || this.count === 0 || !this.effects.transit) return;
    this.pending.set(1, this.now(), T.shape.pendingMs, easeOut);
    this.invalidate();
  }

  /** The wait is over (the arrangement arrived, or there is none to wait for). */
  endPending(): void {
    const now = this.now();
    if (this.pending.value(now) === 0 && !this.pending.busy(now)) return;
    this.pending.set(0, now, this.opts.reducedMotion ? 0 : T.shape.pendingMs, easeInOut);
    this.invalidate();
  }

  overlay(): OverlayModel | null {
    return this.overlayModel;
  }

  /** PointState bits per ordinal. `animate` fades from the previous bits over the state fade time. */
  setPointState(state: Uint32Array, from = 0, count = state.length, animate = false, fadeMs: number = T.states.fadeMs): void {
    if (!this.points) return;
    const now = this.now();
    const instant = !animate || this.opts.reducedMotion;
    this.points.writeState(state, from, count, !instant);
    if (instant) this.stateT.jump(1);
    else {
      this.stateT.jump(0);
      this.stateT.set(1, now, this.opts.reducedMotion ? T.scope.reducedCrossfadeMs : fadeMs, linear);
    }
    this.invalidate();
  }

  /** Dimming of everything not lit: 1 at rest, 0.06 selected, 0.12 traced, 0.35 previewed; haze 1 / 0.35 / 0.5. */
  setDimming(others: number, hazeDim: number, lineDim = 1, fadeMs: number = T.states.fadeMs): void {
    const now = this.now();
    this.others.set(others, now, fadeMs, linear);
    this.hazeRest = hazeDim;
    this.hazeDim.set(this.view ? hazeDim * hazeScale(this.view.layers, this.view.look) : hazeDim, now, fadeMs, linear);
    this.lineDim = lineDim;
    this.lines?.setDim(lineDim);
    this.invalidate();
  }

  /** Scope: non-members sink 25% toward the core while fading (300 ms); back to All areas they rise in 400 ms. */
  setScopeSink(on: boolean): void {
    const now = this.now();
    const ms = this.opts.reducedMotion ? 0 : on ? T.scope.sinkFadeMs : T.scope.riseMs;
    this.scopeSink.set(on ? T.scope.sink : 0, now, ms, easeInOut);
    this.invalidate();
  }

  /** A space was chosen: its members flash white, then settle (about 600 ms). Reduced motion: no flash. */
  flashScope(): void {
    if (this.opts.reducedMotion) return;
    const now = this.now();
    this.scopeFlash.jump(1);
    this.scopeFlash.set(0, now, T.scope.flashMs, easeInOut);
    this.invalidate();
  }

  /** Back to All areas: the points take a short curl-noise swirl on their way home (about 450 ms). */
  swirlHome(): void {
    if (this.opts.reducedMotion) return;
    const now = this.now();
    this.swirl.jump(0);
    this.swirl.set(1, now, T.scope.swirlMs, easeInOut);
    this.invalidate();
  }

  /** Turn the camera so a territory's heading faces the viewer (600 ms); the spin continues from there. */
  turnTo(headingDeg: number): void {
    this.camera.turnTo(headingDeg, this.now(), this.opts.reducedMotion ? 0 : T.scope.turnMs);
    this.invalidate();
  }

  setLines(family: number, positions: Float32Array, colors: Uint8Array, t: Float32Array): void {
    if (!this.lines) return;
    const f = family as LineFamily;
    this.lines.set(f, positions, colors, t);
    this.lines.drawOn(f, this.opts.reducedMotion ? 0 : T.lines.drawOnMs, this.now());
    this.invalidate();
  }

  clearLines(family: number): void {
    this.lines?.clear(family as LineFamily);
    this.invalidate();
  }

  lineSegments(family: number): { positions: Float32Array; segments: number } {
    return this.lines ? this.lines.segments(family as LineFamily) : { positions: new Float32Array(0), segments: 0 };
  }

  /**
   * The colour that points carrying the MapSource bit are pulled toward (`rgb` in sRGB 0..255) and by how much (0..1);
   * null or mix 0 switches the pull off. Hub hover lights the hub's source entries white (ink) or dark (paper) with it.
   */
  setSourceTint(rgb: readonly [number, number, number] | null, mix: number): void {
    const m = this.points?.material;
    const tint = m?.uniforms.uSourceTint;
    if (tint && rgb) (tint.value as Vector3).set(SRGB_TO_LINEAR[Math.round(rgb[0])] as number, SRGB_TO_LINEAR[Math.round(rgb[1])] as number, SRGB_TO_LINEAR[Math.round(rgb[2])] as number);
    this.setUniform(m, "uSourceTintMix", rgb ? Math.max(0, Math.min(1, mix)) : 0);
    this.invalidate();
  }

  /** Hover-emphasis groups: the grouping's row per ordinal (GroupingResult.groupOf) and the population (1 = record entry). */
  setGroups(groupOf: Uint32Array | null, pop: ArrayLike<number> | null): void {
    this.points?.writeGroups(groupOf, pop);
    this.invalidate();
  }

  /**
   * Chart / key hover emphasis: the points of grouping row `id` (the `groupOf` value; `population` 0 notes, 1 entries,
   * omitted = either) turn brighter and larger with a glow and a short palette-tinted trail along `dir` (a unit vector in
   * screen space, y down; default horizontal), and everything else dims to 35%. null ends it. Called by the chart
   * overlay's label and row hover. Under reduced motion the trail is left out and the change is not animated.
   */
  setHoverGroup(id: number | null, opts: { population?: number; dir?: readonly [number, number] } = {}): void {
    const m = this.points?.material;
    if (!m) return;
    const now = this.now();
    const reduced = this.opts.reducedMotion;
    const on = id !== null && Number.isFinite(id) && id >= 0;
    if (on) {
      this.setUniform(m, "uHoverGroup", (id as number) + 1);
      this.setUniform(m, "uHoverPop", opts.population === undefined ? -1 : opts.population === 0 ? 0 : 1);
      const dir = opts.dir ?? [1, 0];
      const len = Math.hypot(dir[0], dir[1]) || 1;
      (m.uniforms.uStreakDir?.value as Vector2 | undefined)?.set(dir[0] / len, dir[1] / len);
    } else if (this.hoverOn.target === 0) return;
    this.hoverOn.set(on ? 1 : 0, now, reduced ? 0 : T.hover.fadeMs, easeOut);
    this.streak.set(on && !reduced ? 1 : 0, now, reduced ? 0 : T.hover.fadeMs * 1.5, easeOut);
    this.invalidate();
  }

  /**
   * A query or token change: the whole figure dips to 15% over 150 ms, then regrows over 300 ms in the growth order (the
   * cord first, then the nerves, then the brain) into the new lit and dim state. Once per 400 ms while typing; off under
   * reduced motion or when `effects.regrowOnQuery` is off.
   */
  queryFade(kind: FadeKind = "query", force = false): void {
    if (!this.effects.regrowOnQuery || this.opts.reducedMotion || !this.points || this.count === 0) return;
    const now = this.now();
    if (!force && now - this.queryFadeLast < T.states.queryDebounceMs) return;
    this.queryFadeLast = now;
    this.queryFadeStart = now;
    this.fadeKind = kind;
    this.queryFadeActive = true;
    this.invalidate();
  }

  setHover(ordinal: number): void {
    if (ordinal === this.hover) return;
    this.hover = ordinal;
    this.points?.rings.hover.show(ordinal);
    this.setUniform(this.points?.material, "uHover", ordinal);
    this.invalidate();
  }

  setSelected(ordinal: number): void {
    this.selected = ordinal;
    this.points?.rings.selected.show(ordinal);
    this.setUniform(this.points?.material, "uSelected", ordinal);
    this.invalidate();
  }

  setActive(ordinal: number): void {
    this.active = ordinal;
    this.points?.rings.active.show(ordinal);
    this.invalidate();
  }

  /** Accent colour of the selection and active-note rings (linear 0..1). */
  setRingColours(selected: Rgb, active: Rgb): void {
    const set = (m: RawShaderMaterial | undefined, c: Rgb): void => {
      const u = m?.uniforms.uRingColor;
      if (u) (u.value as Vector3).set(SRGB_TO_LINEAR[Math.round(c[0])] as number, SRGB_TO_LINEAR[Math.round(c[1])] as number, SRGB_TO_LINEAR[Math.round(c[2])] as number);
    };
    set(this.points?.rings.selected.material, selected);
    set(this.points?.rings.active.material, active);
    this.invalidate();
  }

  /** Advanced › Point budget: above it, the shorter frond points are thinned by a stable hash. */
  setPointBudget(n: number): void {
    this.pointBudget = n;
    this.setUniform(this.points?.material, "uLodKeep", this.count > n && this.count > 0 ? n / this.count : 1);
    this.invalidate();
  }

  /** Revealed arrivals are born now, staggered in ordinal order, with a birth flash. */
  bornNow(from: number, count: number): void {
    if (!this.points || count <= 0) return;
    const births = this.clock.arrivalBirths(count, this.now());
    this.points.writeBirths(births, from);
    this.invalidate();
  }

  /** A sequence of growth: first open, Rebuild, Replay, or a return from release (fade in). */
  playIntro(kind: IntroKind): void {
    const now = this.now();
    this.clock.play(kind, now, this.opts.reducedMotion);
    if (this.opts.reducedMotion || kind === "return") {
      this.fade.jump(0);
      this.fade.set(1, now, T.growth.fadeInMs, linear);
    }
    this.camera.setMotionScale(this.clock.growing ? T.motion.introMotionStart : 1);
    this.invalidate();
  }

  // ───────────────────────────── first paint ─────────────────────────────

  /** A first-paint cloud is on screen (holding, turning or fading). */
  firstPaintActive(): boolean {
    return this.fp !== null;
  }

  /**
   * Show the scattered side-view brain in place of the figure while the record is read. Returns false when nothing is
   * shown (reduced motion cross-fades only, or already showing). With `replay` the figure on screen leaves first and the
   * turn is asked for at once (showcase mode); otherwise the cloud holds until `endFirstPaint()`.
   */
  startFirstPaint(opts: { replay?: boolean } = {}): boolean {
    if (this.opts.reducedMotion || this.fp || !this.gl || this.disposed) return false;
    const now = this.now();
    const cloud = buildCloud();
    const layer = createFirstPaintLayer(cloud);
    layer.setPaper(this.stage === "paper");
    layer.setDpr(this.effectiveDpr());
    const variant = this.stage === "paper" ? "light" : "glow";
    layer.setColours(T.firstPaint.slots.map((slot) => bucketColor("value", slot, this.effectPalette, variant)));
    this.scene.add(layer.object);
    this.fp = { cloud, layer, clock: { startMs: now, turnStartMs: null, cancelStartMs: null }, targets: null, replayFromMs: opts.replay && this.dataPresent ? now : null };
    if (opts.replay) this.endFirstPaint();
    this.invalidate();
    return true;
  }

  /** The record is ready: turn the cloud to the front view while its points condense onto the figure (held `holdMinMs` first). */
  endFirstPaint(): void {
    const fp = this.fp;
    if (!fp || fp.clock.turnStartMs !== null || fp.clock.cancelStartMs !== null) return;
    const now = this.now();
    // Everything is born at once: the turn replaces the cord-first growth.
    this.clock.play("return", now, true);
    this.camera.setMotionScale(1);
    const s = this.fitSamples;
    const standing = this.pose === "standing";
    // The last two samples are the placement's bounding-box corners (see buildFitSamples): points must not land there.
    const usable = s ? (s.count > 8 ? s.count - 2 : s.count) : 0;
    if (s && usable > 0) fp.targets = condenseTargets(fp.cloud, usable, (j) => (standing ? (s.pos[j * 3 + 1] as number) : -(s.pos[j * 3] as number)));
    fp.clock.turnStartMs = turnStartAt(fp.clock.startMs, now);
    this.invalidate();
  }

  /** Leave without the turn (a fresh import grows cord-first, an empty record shows its card, an error): the cloud fades out. */
  cancelFirstPaint(): void {
    const fp = this.fp;
    if (!fp || fp.clock.cancelStartMs !== null) return;
    fp.clock.cancelStartMs = this.now();
    this.invalidate();
  }

  private dropFirstPaint(): void {
    const fp = this.fp;
    if (!fp) return;
    this.scene.remove(fp.layer.object);
    fp.layer.dispose();
    this.fp = null;
  }

  /** Move the cloud for this frame and return how much of the real figure shows (1 with no cloud). */
  private updateFirstPaint(now: number): number {
    const fp = this.fp;
    if (!fp) return 1;
    const st = paintState(now, fp.clock);
    if (st.done) {
      this.dropFirstPaint();
      this.invalidate();
      return 1;
    }
    const { cloud, layer } = fp;
    const f = this.figure;
    const S = T.firstPaint.outlineHalf * f.radius;
    const cx = f.centre[0], cz = f.centre[2];
    const cy = (f.centre[1] + f.brainCentre[1]) / 2;
    // Screen-relative: the cloud's front faces the camera at yaw 0, whatever way the camera sits round the figure.
    const yaw = ((st.yawDeg + this.camera.framing(now).yawDeg) * Math.PI) / 180;
    const samples = this.fitSamples;
    const targets = st.condense > 0 ? fp.targets : null;
    const out = layer.positions;
    for (let i = 0; i < cloud.count; i++) {
      const [rx, rz] = yawXZ((cloud.local[i * 3] as number) * S, (cloud.local[i * 3 + 2] as number) * S, yaw);
      let x = cx + rx, y = cy + (cloud.local[i * 3 + 1] as number) * S, z = cz + rz;
      if (targets && samples) {
        const j = targets[i] as number;
        // Each point leaves a little apart from its neighbours (a hash of its index), so the cloud pours in rather than shrinks.
        const k = Math.max(0, Math.min(1, st.condense * 1.3 - 0.3 * ((Math.imul(i, 2654435761) >>> 0) / 4294967296)));
        const e = k * k * (3 - 2 * k);
        x += ((samples.pos[j * 3] as number) - x) * e;
        y += ((samples.pos[j * 3 + 1] as number) - y) * e;
        z += ((samples.pos[j * 3 + 2] as number) - z) * e;
      }
      out[i * 3] = x;
      out[i * 3 + 1] = y;
      out[i * 3 + 2] = z;
    }
    layer.touch();
    layer.setAlpha(st.cloudAlpha);
    layer.setCalm(st.condense);
    // Cancelled: the real figure shows as usual (it grows cord-first). Turning: it fades in under the cloud. Holding: it is
    // away; a replay over a figure on screen sends it away quickly.
    if (fp.clock.cancelStartMs !== null) return 1;
    if (st.turning) return st.figure;
    return fp.replayFromMs === null ? 0 : Math.max(0, 1 - (now - fp.replayFromMs) / T.firstPaint.figureOutMs);
  }

  flyTo(point: Vec3): void {
    this.camera.flyTo(point, this.now());
    this.invalidate();
  }

  // ───────────────────────────── size, framing ─────────────────────────────

  /** Resize to the stage: CSS px, the device pixel ratio and the parts of the stage covered by a sheet. */
  resize(width: number, height: number, dpr: number, insets: { left: number; right: number }, breakpoint: StageGeom["breakpoint"] = this.geom.breakpoint, immersive = false): void {
    this.governor.interrupt();
    const before = this.camera.framing(this.now());
    const oldW = this.cssW;
    this.cssW = Math.max(1, Math.floor(width));
    this.cssH = Math.max(1, Math.floor(height));
    this.dpr = dpr;
    this.geom = { width: this.cssW, height: this.cssH, insetLeft: insets.left, insetRight: insets.right, breakpoint, immersive, desktop: typeof document !== "undefined" && document.body?.classList?.contains("cxd-app") === true };
    this.camera.setStage(this.geom);
    this.applyBufferSize();
    this.layoutComposite(1);
    const docking = insets.right !== 0 || oldW !== this.cssW;
    this.refit(0);
    this.refitArrangement();
    if (docking && this.placement) this.camera.dockFrom(before, oldW, this.now());
    this.invalidate();
  }

  /** A resized stage fits the flat chart on screen again (square on, centred in the new free area). */
  private refitArrangement(): void {
    const a = this.arrangementCam;
    if (!a || !this.camera.isForcedUpright()) return;
    const f = fitArrangementCamera(a.camera, this.arrangementGeom(), a.angles);
    this.arrangementFit = f;
    this.camera.fit(f, this.now(), 0);
  }

  /** The stage an arrangement is fitted into: a chart keeps clear of the floating panels, anything else uses the whole stage. */
  private arrangementGeom(): StageGeom {
    return this.arrangementChart ? chartFitGeom(this.geom, this.chartCover) : this.geom;
  }

  /** The floating Chart card and Display popover rectangles' cover of the stage (left, right CSS px); the next resize refits a flat chart between them. */
  setChartCover(cover: { left: number; right: number }): void {
    this.chartCover = { left: Math.max(0, cover.left), right: Math.max(0, cover.right) };
  }

  private effectiveDpr(): number {
    const fx = governorEffects(this.governor.step, this.opts.maxDpr ?? T.stage.maxDpr);
    return Math.max(0.5, Math.min(this.dpr, fx.maxDpr));
  }

  /** The css size and pixel ratio the drawing buffer was last sized for. */
  private bufferKey = "";

  private applyBufferSize(): void {
    const gl = this.gl;
    if (!gl) return;
    const d = this.effectiveDpr();
    const w = Math.max(1, Math.round(this.cssW * d)), h = Math.max(1, Math.round(this.cssH * d));
    // three's setSize reassigns canvas.width/height, which drops and reallocates the drawing buffer even for the same
    // numbers (tens of ms): a layout event that changed nothing about the canvas (a panel moved, a morph began) skips it.
    if (this.bufferKey !== `${this.cssW}x${this.cssH}@${d}`) {
      gl.setPixelRatio(d);
      gl.setSize(this.cssW, this.cssH, false);
      this.bufferKey = `${this.cssW}x${this.cssH}@${d}`;
    }
    this.ensureHdr(w, h);
    for (const m of [this.points?.material, this.haze?.material, this.seed?.material]) this.setUniform(m, "uDpr", d);
    this.setUniform(this.points?.rings.hover.material, "uDpr", d);
    this.fp?.layer.setDpr(d);
  }

  private ensureHdr(w: number, h: number): void {
    if (this.hdr && this.hdr.width === w && this.hdr.height === h) return;
    this.hdr?.dispose();
    this.hdr = new WebGLRenderTarget(w, h, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter });
  }

  /** Refit the home view to the placed figure; `ms` > 0 animates (data changed while the user had moved on). */
  refit(ms: number): void {
    if (!this.fitSamples || this.fitSamples.count === 0) {
      this.setUniform(this.points?.material, "uRefDist", this.camera.home().distance);
      return;
    }
    const f = this.homeFit.get(this.pose, this.fitSamples, this.geom);
    this.camera.setHome(f, this.now(), this.opts.reducedMotion ? 0 : ms);
    const d = this.camera.home().distance;
    for (const m of [this.points?.material, this.haze?.material]) this.setUniform(m, "uRefDist", d);
  }

  /** Back to All areas from a scope: the camera pulls back from close to the home view (only when it is at home). */
  dollyHome(): void {
    if (this.camera.isAtHome()) this.camera.dollyIn(this.now(), this.opts.reducedMotion ? 0 : T.camera.scopeReturnDollyMs, T.camera.scopeReturnDollyFactor);
    this.invalidate();
  }

  /** Fly a scripted camera path (Showcase mode); an empty path puts the picture upright and stops it. */
  flyLegs(legs: readonly CameraLeg[]): void {
    if (legs.length === 0) this.camera.cancelLegs(this.now(), 200);
    else this.camera.flyLegs(legs, this.now());
    this.invalidate();
  }

  /** The camera's pose now, and putting it back (Showcase mode returns the camera to where it was). */
  cameraPose(): ReturnType<TurntableCamera["pose"]> {
    return this.camera.pose(this.now());
  }

  restoreCameraPose(p: ReturnType<TurntableCamera["pose"]>): void {
    this.camera.restorePose(p, this.now());
    this.invalidate();
  }

  /** Home view (H, double-click on empty stage, Reset display). */
  home(): void {
    // A flat chart's home view is the chart fitted square on, not the figure's home view.
    if (this.arrangementFit && this.camera.isForcedUpright()) this.camera.fit(this.arrangementFit, this.now(), this.opts.reducedMotion ? 0 : T.fly.inMs);
    else this.camera.reset(this.now(), this.opts.reducedMotion ? 0 : T.fly.inMs);
    this.invalidate();
  }

  figureBounds(): FigureBounds {
    return this.figure;
  }

  stageGeom(): StageGeom {
    return { ...this.geom };
  }

  // ───────────────────────────── frame loop ─────────────────────────────

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.governor.interrupt();
    this.lastMs = this.now();
    this.invalidate();
  }

  stop(): void {
    this.running = false;
    this.shimmerGen++;
    this.shimmerPending = false;
    this.cancelFrame();
  }

  private cancelFrame(): void {
    if (this.raf !== null) {
      this.win().cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  /** Ask for a frame (cheap; the loop stops on its own when nothing moves). */
  invalidate(): void {
    this.frameRequested = true;
    if (!this.running || this.raf !== null || this.lost || this.disposed || !this.gl) return;
    this.raf = this.win().requestAnimationFrame(() => {
      this.raf = null;
      this.frame();
    });
  }

  private maxFps = 0;

  /** Cap the frame rate (unfocused visible leaves: 30 fps); 0 = the display's rate. */
  setMaxFps(fps: number): void {
    this.maxFps = Math.max(0, fps);
  }

  /** Suspend motion (an unfocused or hidden leaf). */
  setSuspended(on: boolean): void {
    this.suspended = on;
    this.camera.setSuspended(on);
    if (!on) this.lastMs = this.now();
    this.invalidate();
  }

  setReducedMotion(on: boolean): void {
    (this.opts as { reducedMotion: boolean }).reducedMotion = on;
    this.camera.reduced = on;
    if (on) {
      this.dissolveActive = false;
      this.queryFadeActive = false;
      this.streak.jump(0);
    }
    this.invalidate();
  }

  private busy(now: number): boolean {
    return (
      this.frameRequested ||
      this.camera.animating(now) ||
      this.morph.anim.busy(now) ||
      this.form.busy(now) ||
      this.pending.busy(now) ||
      this.stateT.busy(now) ||
      this.others.busy(now) ||
      this.hazeDim.busy(now) ||
      this.scopeSink.busy(now) ||
      this.scopeFlash.busy(now) ||
      this.swirl.busy(now) ||
      this.recolour.busy(now) ||
      this.fade.busy(now) ||
      this.dissolveActive ||
      this.queryFadeActive ||
      this.hoverOn.busy(now) ||
      this.streak.busy(now) ||
      !this.clock.settled(now) ||
      (this.fp !== null && paintBusy(now, this.fp.clock, false))
    );
  }

  private frame(): void {
    if (this.disposed || this.lost || !this.gl || !this.running) return;
    const now = this.now();
    // An unfocused leaf caps its rate (§2.4); the frame is simply asked for again.
    if (this.maxFps > 0 && now - this.lastMs < 1000 / this.maxFps - 1) {
      this.invalidate();
      return;
    }
    const dtMs = Math.min(Math.max(0, now - this.lastMs), 1000);
    this.lastMs = now;
    this.frameRequested = false;
    // A frame that the shimmer timer asked for is paced slower than the display: it is not a slow frame.
    const floorMs = Math.max(this.maxFps > 0 ? 1000 / this.maxFps : 0, this.shimmerPaced ? 1000 / T.shimmer.fps : 0);
    this.shimmerPaced = false;
    const stepped = this.governor.frame(now, dtMs, floorMs, this.busyUntil);
    if (stepped !== null) this.applyGovernor(stepped);
    // The intro eases the camera motion in during Settle.
    if (this.clock.growing) this.camera.setMotionScale(this.clock.motionEase(now));
    else this.camera.setMotionScale(1);
    this.camera.update(now, dtMs / 1000);
    const t0 = this.now();
    this.updateUniforms(now);
    this.draw(this.hdr, null, 1);
    this.frameMs = this.now() - t0;
    this.warmPrograms();
    this.countFps(now);
    if (now - this.lastFrameInfoMs >= 1000 / 30) {
      this.lastFrameInfoMs = now;
      this.handlers.frame?.({ nowMs: now, width: this.cssW, height: this.cssH, camera: this.camera });
    }
    const going = this.busy(now);
    if (going) this.invalidate();
    else if (this.shimmerRunning()) this.scheduleShimmer();
  }

  private programsWarmed = false;

  /**
   * Once, after the first frame: compile the programs of layers that are still hidden (the fibre lines of the Groups
   * shape and the body's links) on the browser's parallel compile threads, so the first morph does not stall a frame on a
   * 40 ms link. Never blocks (compileAsync); a context without it simply compiles on first use as before.
   */
  private warmPrograms(): void {
    if (this.programsWarmed) return;
    this.programsWarmed = true;
    const gl = this.gl;
    if (!gl || typeof gl.compileAsync !== "function") return;
    try {
      void gl.compileAsync(this.scene, this.camera.camera).catch(() => undefined);
    } catch {
      /* compiled on first use */
    }
  }

  /** The twinkle runs only for a visible, focused, motion-allowed figure that has points, and never while saving a picture. */
  private shimmerOn(): boolean {
    return this.effects.shimmer && this.view?.look.shimmer !== false && !this.opts.reducedMotion && !this.exporting;
  }

  private shimmerRunning(): boolean {
    return this.shimmerOn() && this.dataPresent && this.running && !this.suspended && !this.lost;
  }

  /** At rest the shimmer alone keeps the loop alive, at a low rate (RENDER_TUNING.shimmer.fps) instead of every display frame. */
  private scheduleShimmer(): void {
    if (this.shimmerPending) return;
    this.shimmerPending = true;
    const gen = this.shimmerGen;
    const gap = Math.max(1000 / T.shimmer.fps, this.maxFps > 0 ? 1000 / this.maxFps : 0);
    this.win().setTimeout(() => {
      this.shimmerPending = false;
      if (gen !== this.shimmerGen || this.disposed) return;
      this.shimmerPaced = true;
      this.invalidate();
    }, gap);
  }

  private countFps(now: number): void {
    this.fpsAcc.n++;
    if (this.fpsAcc.since === 0) this.fpsAcc.since = now;
    if (now - this.fpsAcc.since >= 1000) {
      this.fps = (this.fpsAcc.n * 1000) / (now - this.fpsAcc.since);
      this.fpsAcc = { n: 0, since: now };
    }
  }

  private applyGovernor(step: GovernorStep): void {
    const fx = governorEffects(step, this.opts.maxDpr ?? T.stage.maxDpr);
    this.applyBufferSize();
    const look = this.view?.look;
    for (const m of [this.points?.material, this.haze?.material]) this.setUniform(m, "uGlow", fx.halos ? (look?.glow ?? 1) : 0);
    this.setUniform(this.haze?.material, "uKeep", fx.hazeKeep);
    this.handlers.status?.("ok", step);
  }

  private updateUniforms(now: number): void {
    const pts = this.points, haze = this.haze;
    if (!pts || !haze) return;
    const core = pts.core;
    const introT = this.clock.time(now);
    const growing = this.clock.growing && introT < T.growth.introSec ? 1 : 0;
    const set = (name: string, v: number): void => {
      const u = core[name];
      if (u) u.value = v;
    };
    set("uTime", (now - this.t0) / 1000);
    set("uIntro", introT);
    set("uGrowing", growing);
    set("uMorph", this.morph.anim.value(now));
    set("uForm", this.form.value(now));
    set("uStateT", this.stateT.value(now));
    set("uOthers", this.others.value(now));
    set("uScopeSink", this.scopeSink.value(now));
    set("uScopeFlash", this.scopeFlash.value(now));
    set("uSwirl", this.swirl.value(now));
    const figureMul = this.updateFirstPaint(now);
    set("uFade", this.fade.value(now) * figureMul);
    // Point effects: shimmer, the grouping dissolve (it also drives the position swap), the query dip and regrow, the transit pose.
    set("uShimmer", this.shimmerOn() ? 1 : 0);
    const dissolving = this.dissolveActive && this.dissolve.busy(now);
    if (this.dissolveActive && !dissolving) this.dissolveActive = false;
    if (dissolving) {
      const d = this.dissolve.value(now);
      set("uDissolve", d);
      set("uForm", d >= DISSOLVE_SPLIT ? 1 : 0);
    } else set("uDissolve", -1);
    if (this.queryFadeActive) {
      const q = queryFadeAt(now - this.queryFadeStart, this.fadeKind);
      set("uDipFloor", fadeShape(this.fadeKind).dipTo);
      set("uDip", q.dip);
      set("uRegrow", q.regrow);
      if (q.done) this.queryFadeActive = false;
    } else {
      set("uDip", 1);
      set("uRegrow", -1);
    }
    const transit = this.effects.transit && !this.opts.reducedMotion;
    set("uHumanW", transit ? T.transit.weight : 0);
    set("uPending", transit ? this.pending.value(now) * T.shape.pendingWeight * T.transit.weight : 0);
    set("uExit", this.exitMode && this.exitReady ? chartExitAt(this.morph.anim.value(now)) : 0);
    (core.uExitAnchor?.value as Vector3 | undefined)?.copy(this.exitAnchor);
    (core.uEntry?.value as Vector3 | undefined)?.set(this.entry.style, this.entry.amp, 0);
    this.setUniform(pts.material, "uHumanTintMix", transit ? T.transit.tint : 0);
    this.setUniform(pts.material, "uHoverOn", this.hoverOn.value(now));
    this.setUniform(pts.material, "uStreak", this.streak.value(now));
    this.setUniform(pts.material, "uRecolourT", this.recolour.value(now));
    // Depth-cue reference planes: the view-space z of the figure and the brain.
    const cam = this.camera.camera;
    cam.updateMatrixWorld();
    const fz = new Vector3(...this.figure.centre).applyMatrix4(cam.matrixWorldInverse).z;
    const bz = new Vector3(...this.figure.brainCentre).applyMatrix4(cam.matrixWorldInverse).z;
    this.setUniform(pts.material, "uFigureZ", fz);
    this.setUniform(pts.material, "uBrainZ", bz);
    this.setUniform(haze.material, "uFigureZ", fz);
    this.setUniform(haze.material, "uFade", this.fade.value(now) * figureMul);
    this.lines?.setDim(this.lineDim * figureMul);
    this.setUniform(haze.material, "uIntro", introT);
    this.setUniform(haze.material, "uMorph", this.morph.anim.value(now));
    this.setUniform(haze.material, "uHazeDim", this.hazeDim.value(now));
    this.lines?.setFigure(new Vector4(this.figure.centre[0], this.figure.centre[1], this.figure.centre[2], this.figure.radius), fz);
    this.lines?.update(now);
    // Note-link fibres brighten as the camera comes in from the home distance.
    this.lines?.setAlpha(LINE_FAMILY.Link, linkAlpha(this.camera.framing(now).distance, this.camera.home().distance));
    // Seed ring: 12 points ignite at the top of the brainstem; a ring expands 0 → 40 px and fades (0.00–0.25 s).
    if (this.seed) {
      const t = this.clock.growing ? introT / T.growth.stages[0]!.to : 1;
      const show = this.clock.growing && t >= 0 && t < 1;
      this.seed.object.visible = show;
      if (show) {
        this.setUniform(this.seed.material, "uSeedT", t);
        this.setUniform(this.seed.material, "uSeedPx", T.growth.seedRingPx * t);
      }
    }
  }

  /** Draw the scene into `hdr` and composite it to `target` (null = the canvas) at `scale` × the canvas size. */
  private draw(hdr: WebGLRenderTarget | null, target: WebGLRenderTarget | null, scale: number): void {
    const gl = this.gl;
    if (!gl || !hdr || !this.composite) return;
    gl.setRenderTarget(hdr);
    gl.setClearColor(0x000000, 0);
    gl.clear(true, false, false);
    gl.render(this.scene, this.camera.camera);
    gl.setRenderTarget(target);
    const u = this.composite.uniforms;
    (u.uHdr as IUniform).value = hdr.texture;
    this.layoutComposite(scale * this.effectiveDpr());
    // three multiplies a viewport given to the canvas by the pixel ratio, so it is given in CSS px; a render target
    // keeps the viewport it was created with. (Device-pixel sizes here drew the figure 1.25× too large at dpr 1.25.)
    if (!target) gl.setViewport(0, 0, this.cssW, this.cssH);
    gl.render(this.compositeScene, this.compositeCam);
    gl.setRenderTarget(null);
  }

  // ───────────────────────────── picking and pictures ─────────────────────────────

  /** Ordinal under the pointer (async GPU readback) or -1. */
  async pick(xCss: number, yCss: number): Promise<number> {
    const layer = this.points, picker = this.picker, gl = this.gl;
    if (!layer || !picker || !gl || this.lost || this.count === 0 || this.pickBusy) return -1;
    this.pickBusy = true;
    try {
      this.updateUniforms(this.now());
      const win = this.win();
      return await picker.pick({
        object: layer.pickObject(picker.integerIds),
        camera: this.camera.camera,
        x: xCss,
        y: yCss,
        width: this.cssW,
        height: this.cssH,
        wait: () => new Promise<void>((r) => win.setTimeout(r, 2)),
      });
    } catch {
      return -1;
    } finally {
      this.pickBusy = false;
    }
  }

  /** The canvas drawn at `scale` × (Save image: 2×), as RGBA bytes, top row first. */
  renderPixels(scale: number): { width: number; height: number; data: Uint8Array } | null {
    const gl = this.gl;
    if (!gl || this.lost || !this.caps) return null;
    const d = this.effectiveDpr() * scale;
    const maxSide = Math.min(this.caps.maxTextureSize, 8192);
    const k = Math.min(1, maxSide / Math.max(this.cssW * d, this.cssH * d));
    const w = Math.max(1, Math.round(this.cssW * d * k)), h = Math.max(1, Math.round(this.cssH * d * k));
    const hdr = new WebGLRenderTarget(w, h, { type: HalfFloatType, format: RGBAFormat, depthBuffer: false, generateMipmaps: false, minFilter: LinearFilter, magFilter: LinearFilter });
    const out = new WebGLRenderTarget(w, h, { type: UnsignedByteType, format: RGBAFormat, depthBuffer: false, generateMipmaps: false });
    const saved = { dpr: this.effectiveDpr() };
    this.exporting = true;
    try {
      this.updateUniforms(this.now());
      for (const m of [this.points?.material, this.haze?.material, this.seed?.material]) this.setUniform(m, "uDpr", d * k);
      this.setUniform(this.points?.rings.hover.material, "uDpr", d * k);
      this.draw(hdr, out, d * k / this.effectiveDpr());
      const raw = new Uint8Array(w * h * 4);
      gl.readRenderTargetPixels(out, 0, 0, w, h, raw);
      // Flip: GL rows run bottom-up.
      const data = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) data.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
      return { width: w, height: h, data };
    } finally {
      this.exporting = false;
      for (const m of [this.points?.material, this.haze?.material, this.seed?.material]) this.setUniform(m, "uDpr", saved.dpr);
      this.setUniform(this.points?.rings.hover.material, "uDpr", saved.dpr);
      this.layoutComposite(1);
      hdr.dispose();
      out.dispose();
      this.invalidate();
    }
  }

  /** PNG of the canvas at `scale`× for "Save image" (no overlays; exportPicture composites those). */
  async snapshot(scale: number): Promise<Blob> {
    const px = this.renderPixels(scale);
    if (!px) throw new Error("The graphics context is not available");
    const doc = this.opts.canvas.ownerDocument;
    const c = doc.createElement("canvas");
    c.width = px.width;
    c.height = px.height;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("A 2D canvas is not available");
    ctx.putImageData(new ImageData(new Uint8ClampedArray(px.data.buffer.slice(0) as ArrayBuffer), px.width, px.height), 0, 0);
    return new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png"));
  }

  stats(): RenderStats {
    return { fps: this.fps, frameMs: this.frameMs, points: this.count + (this.haze?.count ?? 0), drawCalls: this.gl?.info.render.calls ?? 0 };
  }

  governorStep(): GovernorStep {
    return this.governor.step;
  }

  /** CPU copies of the haze (2D fallback and framing). */
  hazeCopy(): { pos: Float32Array; kind: Uint8Array; count: number } | null {
    const h = this.haze;
    return h ? { pos: h.positions(), kind: h.kinds(), count: h.count } : null;
  }

  currentFraming(): Framing {
    return this.camera.framing(this.now());
  }

  /** Release GPU memory but keep CPU copies (a hidden leaf after 60 s). */
  releaseGpu(): void {
    this.stop();
    // This renderer is done with the canvas: its loss handler must not report "context lost" for a release.
    this.detachContextEvents();
    this.dropFirstPaint();
    this.hdr?.dispose();
    this.hdr = null;
    this.picker?.dispose();
    this.picker = null;
    this.gl?.dispose();
    this.gl?.forceContextLoss();
    this.gl = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.longTasks?.disconnect();
    this.longTasks = null;
    this.detachContextEvents();
    this.picker?.dispose();
    this.dropFirstPaint();
    this.points?.dispose();
    this.haze?.dispose();
    this.lines?.dispose();
    this.seed?.object.geometry.dispose();
    this.seed?.material.dispose();
    this.composite?.dispose();
    this.compositeScene.children.forEach((c) => (c as Mesh).geometry?.dispose());
    this.hdr?.dispose();
    this.gl?.dispose();
    this.gl?.forceContextLoss();
    this.gl = null;
    this.points = null;
    this.haze = null;
    this.lines = null;
  }
}
