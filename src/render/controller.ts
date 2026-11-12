/**
 * RenderController: glue between ONE leaf's store, the shared worker and that leaf's renderer. Owner: E10.
 *  - leaf view / scope / period / tokens + settings.appearance → worker placement, grouping, arrangement and
 *    lines requests (debounced, latest-wins per (viewId, method)) → renderer.set*;
 *  - tokens / selection / hover / preview / key → PointState bits with CORTEX-UX §6.6 alphas: lit full, unlit
 *    12%, haze 5%, preview others 35%, hidden by the key 6%, outside the period 6% (Body) or removed (Groups,
 *    Chart), outside the scope 0%, active note = accent ring;
 *  - pointer events on the canvas → camera + picking → leaf hover / select / openItem;
 *  - the renderer pool decides live / paused (still frame) / released (H6);
 *  - pop-out windows (POPOUT-WINDOWS): requestAnimationFrame, listeners, visibility and DPR come from the view's
 *    own window (the canvas's ownerDocument.defaultView), and the renderer is recreated when the leaf moves;
 *  - frame-rate governor (L5): frames > 22 ms for 2 s → DPR 1.25, then halos off, then haze halved; reported on
 *    "stage:status" so the shell shows one toast and a "Performance mode" line in Display.
 * The figure's pose comes from the leaf's view state (seeded from settings `general.pose`, Standing by default).
 */
import type { CortexServices, LeafServices } from "../plugin/services";
import { ageOptions, figureOverride, figurePalette } from "../shared/colourTheme";
import { KIND_STYLE, hexToRgb, resolveStage, stageColours } from "../shared/palette";
import { HAZE_KINDS, LINE_FAMILIES, type ArrangementResult, type ColourMode, type GroupBundle, type GroupingResult, type LinesResult, type PlacementResult, type RelatedResult } from "../shared/protocol/worker";
import type { Pose, StageId } from "../shared/settings";
import { appLocked } from "../state/lock";
import { HUB_HOVER, groupPreviewSet, hubMemberList, hubSourceList } from "../shared/hoverModel";
import { ItemKind, NONE32, NONE8, Population } from "../shared/index-format";
import { clearSelection, select } from "../state/actions";
import { stemsOn } from "../state/selectors";
import { previewColour } from "../state/dimPreview";
import { consumeInstantRestore } from "../state/instantRestore";
import type { CortexStore } from "../state/store";
import type { EventBus } from "../state/events";
import type { StageEvents, LabelAnchor } from "../ui/context";
import type { CameraMoveLeg } from "../state/events";
import { prefersReducedMotion } from "./animation";
import { drawFallback, type FallbackScene } from "./fallback2d";
import { bundleFibres } from "./bundles";
import { canvasCursor, chartZoomedPastGiveWay } from "./cursor";
import { buildHubFan, fanPositions } from "./hubFan";
import { LINE_FAMILY, nearestSegment, projectSegments } from "./layers/lines";
import { lineVertexAlpha8 } from "./lineAlpha";
import { hashSeed, type PointLook } from "./layers/points";
import { CortexRenderer, type FrameInfo, type RenderStatus } from "./renderer";
import { POINT_KIND, POINT_STATE } from "./shaders";
import { RENDER_TUNING } from "./tuning";

/** Stretches of the cord (by τ) that take their own colour on the thread. */
const SPINE_BINS = 96;
import { chartStageKey, chartStageOf, type ChartStage } from "../shared/chartStage";
import { stageKeyAction, stepTarget, tracedOrder } from "./stageKeys";
import { entryStyleFor, relayoutKey } from "./entryStyle";
import type { ChartId } from "../shared/views";
import { renderPicture } from "./exportPicture";
import type { LeafRenderState } from "./rendererPool";

const T = RENDER_TUNING;
/** The role comet's sway: it holds each posture for `holdMs`, turns over `morphMs`, and rests after `flips` turns. */
export const SWAY = { holdMs: 9000, morphMs: 3800, flips: 6 } as const;

export interface RenderController {
  attach(canvas: HTMLCanvasElement, overlayHost: HTMLElement): Promise<void>;
  detach(): void;
  readonly renderer: CortexRenderer | null;
  /** Home view (H, double-click on empty stage, Reset display). */
  home(): void;
  /** "Save image…": the PNG bytes of the canvas at 2× with the overlays, or null when nothing can be drawn. */
  savePicture(): Promise<Uint8Array | null>;
}

type StageBus = EventBus<Record<string, unknown> & { [K in keyof StageEvents]: StageEvents[K] }>;

/** Draw kind and rest intensity of every ordinal, from the index (§6.5, §6.13). */
/** The strip's hover key `${start}-${end}` (ms, end exclusive) as a range, or null for anything else. */
export function parsePeriodPreview(key: string): [number, number] | null {
  const m = /^(\d+)-(\d+)$/.exec(key);
  if (!m) return null;
  const from = Number(m[1]), to = Number(m[2]);
  return to > from ? [from, to] : null;
}

export function buildLook(index: import("../shared/index-format").DataIndex, tau: Float32Array, count: number): PointLook {
  const kind = new Uint8Array(count);
  const intensity = new Float32Array(count);
  const I = T.intensity;
  const c = index.cols;
  for (let i = 0; i < count; i++) {
    const jitter = hashSeed(i + 17);
    if (c.pop[i] === Population.Note) {
      const isMap = c.hubType[i] !== NONE8;
      kind[i] = isMap ? POINT_KIND.Map : POINT_KIND.Note;
      intensity[i] = isMap ? I.map : I.note * (I.noteJitter[0] + (I.noteJitter[1] - I.noteJitter[0]) * jitter);
      continue;
    }
    const t = tau[i] as number;
    if (!Number.isFinite(t)) {
      kind[i] = POINT_KIND.Undated;
      intensity[i] = I.undated;
    } else if (c.conv[i] !== NONE32) {
      kind[i] = POINT_KIND.Frond;
      const row = index.convs.get(c.conv[i] as number);
      const idx = c.idx[i] === NONE32 ? 0 : (c.idx[i] as number);
      const u = row.entryCount > 1 ? Math.min(1, idx / (row.entryCount - 1)) : 0;
      intensity[i] = (I.frondRoot + (I.frondTip - I.frondRoot) * u) * (I.frondJitter[0] + (I.frondJitter[1] - I.frondJitter[0]) * jitter);
    } else {
      kind[i] = POINT_KIND.Cord;
      intensity[i] = I.cord;
    }
  }
  return { kind, intensity };
}

export function createRenderController(services: CortexServices, leaf: LeafServices): RenderController {
  const store: CortexStore = leaf.store;
  const viewId = leaf.viewId;
  const bus = services.bus as unknown as StageBus;
  const offs: (() => void)[] = [];
  const onEvent = <E,>(name: string, fn: (e: E) => void): (() => void) => (services.bus as unknown as { on(n: string, f: (e: unknown) => void): () => void }).on(name, (e) => fn(e as E));
  let renderer: CortexRenderer | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let host: HTMLElement | null = null;
  let win: Window = window;
  let attached = false;
  let state: LeafRenderState = "live";
  let fallback = false;
  let ro: ResizeObserver | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let layout: { width: number; height: number; insetRight: number; chartCover: { left: number; right: number } } = { width: 0, height: 0, insetRight: 0, chartCover: { left: 0, right: 0 } };
  // CHART-03: the visible stage a chart was last laid out for; a resize or a sheet change that moves it to another
  // size class asks for a new layout once the size has settled (200 ms).
  let chartStageSent = "";
  // The worker's last answers, kept so a repeat arrangement (or one computed ahead while the figure idled) is instant.
  // A key names the worker's state (epoch: every placement or colouring change), the index and the request.
  let workerEpoch = 0;
  let nextIndexId = 1;
  const indexIds = new WeakMap<object, number>();
  const arrCache = new Map<string, ArrangementResult>();
  const indexTag = (): number => {
    const i = services.index.index.value as object | null | undefined;
    if (!i) return 0;
    let n = indexIds.get(i);
    if (n === undefined) indexIds.set(i, (n = nextIndexId++));
    return n;
  };
  const cacheKey = (params: unknown): string => `${workerEpoch}|${indexTag()}|${JSON.stringify(params)}`;
  const remember = (key: string, res: ArrangementResult): void => {
    arrCache.set(key, res);
    while (arrCache.size > 6) arrCache.delete(arrCache.keys().next().value as string);
  };
  let prewarmTimer: ReturnType<typeof setTimeout> | null = null;
  // A click on Groups or a chart starts the transit dissolve only when the worker has not answered within PENDING_DELAY_MS;
  // an answer that is ready (the cache, or a fast layout) starts the morph itself, with no dip and return first.
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  const PENDING_DELAY_MS = 60;
  const dropPendingTimer = (): void => {
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = null;
  };
  let lastChartId: ChartId | null = null;
  let lastRelayout = "";
  let stageTimer: ReturnType<typeof setTimeout> | null = null;
  const chartStage = (): ChartStage | null => (layout.width > 0 && layout.height > 0 ? chartStageOf(layout.width - layout.insetRight - layout.chartCover.left - layout.chartCover.right, layout.height) : null);
  function stageChanged(): void {
    if (view().shape !== "chart" || !view().chart) return;
    if (chartStageKey(chartStage()) === chartStageSent) return;
    if (stageTimer !== null) clearTimeout(stageTimer);
    stageTimer = setTimeout(() => {
      stageTimer = null;
      if (renderer && view().shape === "chart" && chartStageKey(chartStage()) !== chartStageSent) void arrange();
    }, 200);
  }
  let placement: PlacementResult | null = null;
  /** Showcase mode's remembered camera (camera:save → camera:restore). */
  let savedPose: ReturnType<CortexRenderer["cameraPose"]> | null = null;
  let placedKey = "";
  let placedCount = 0;
  let grouping: GroupingResult | null = null;
  let colourKey = "";
  let recolourSeq = 0;
  let related: RelatedResult | null = null;
  let relatedFor = -1;
  let litSet: Uint8Array | null = null;
  let litKey = "";
  /** Bumped whenever the lit set is replaced, so the colour key (and the key bar's counts) follow the set itself, not the query that is still resolving. */
  let litVer = 0;
  let linesKey = "";
  let linesResult: LinesResult | null = null;
  /** Fibre bundles of the Groups arrangement on screen (none for the body, charts and layouts without links). */
  let groupBundleList: readonly GroupBundle[] = [];
  /** Bumped whenever the bundles change, so drawLines redraws them. */
  let bundlesSeq = 0;
  /** The point the pointer rests on (Pause while pointing), and the timer that pauses the motion after pointerRestMs. */
  let restOrd = -1;
  let restTimer: ReturnType<typeof setTimeout> | null = null;
  let pointer: { x: number; y: number; down: boolean; moved: number; sx: number; sy: number; button: number } | null = null;
  let stillUrl = "";
  /** Canvas cursor (data-cursor): chart zoomed past GIVE_WAY, checked at most 8 times a second while a chart shows. */
  let deepZoom = false;
  let lastZoomCheckMs = 0;
  let lastNeedle = -1;
  let lastNeedleMs = 0;
  let gen = 0;

  const view = () => store.get("view");
  const ui = () => store.get("ui");
  const nowMs = () => performance.now();

  // ───────────── helpers ─────────────

  const visibility = (stable: boolean) => {
    const u = ui();
    const v = view();
    const idx = services.index.index.value;
    const available = idx ? idx.count : 0;
    return {
      scope: stable ? ("all" as const) : u.scope,
      period: stable ? null : u.period,
      notes: v.layers.notes,
      vaultNotes: v.layers.vaultNotes,
      maps: v.layers.maps,
      record: v.layers.record,
      undatedCloud: v.layers.undatedCloud,
      reference: v.layers.reference,
      askHistory: v.layers.askHistory,
      subagents: v.layers.subagents,
      automated: v.layers.automated,
      revealedCount: u.revealedCount > 0 ? Math.min(available, u.revealedCount) : available,
    };
  };

  const stageName = (): "ink" | "paper" => {
    const s = services.settings.value;
    const dark = !!canvas?.ownerDocument.body.classList.contains("theme-dark");
    return resolveStage(s.appearance.stage, dark, s.appearance.palette);
  };

  const reduced = (): boolean => prefersReducedMotion(services.settings.value.appearance.motion, win as unknown as { matchMedia?: (q: string) => { matches: boolean } });

  const status = (s: RenderStatus | "arranging", governor?: number): void => {
    bus.emit("stage:status", { viewId, status: s, ...(governor !== undefined ? { governor } : {}) });
  };

  const catchWorker = (e: unknown): void => {
    const code = (e as { code?: string } | null)?.code;
    if (code === "E_CANCELLED" || code === "E_EPOCH") return;
    services.log.warn("render: worker call failed", { error: String(e) });
  };

  // ───────────── data pipeline ─────────────

  async function place(): Promise<void> {
    const idx = services.index.index.value;
    const r = renderer;
    if (!idx || !r) return;
    const v = view();
    const vis = visibility(true);
    const key = JSON.stringify([v.pose, v.placement, v.core, v.spineOrder, vis.notes, vis.vaultNotes, vis.maps, vis.record, vis.undatedCloud, vis.reference, vis.askHistory, vis.subagents, vis.automated, (services.index as { epoch?: string }).epoch ?? ""]);
    const same = key === placedKey && placement !== null;
    const myGen = ++gen;
    workerEpoch++;
    try {
      const res = await services.worker.call(viewId, "placement", {
        seed: 1,
        pose: v.pose,
        placement: v.placement,
        order: v.core,
        depthKey: "time",
        gamma: 0.6,
        spineOrder: v.spineOrder,
        visibility: vis,
        ...(Object.keys(services.colours.current().space ?? {}).length > 0 ? { areaSlots: services.colours.current().space } : {}),
        ...(same && placedCount > 0 && placedCount < idx.count ? { fromCount: placedCount } : {}),
      });
      if (myGen !== gen || !renderer) return;
      const added = idx.count - placedCount;
      const prevCount = placedCount;
      placement = res;
      placedKey = key;
      placedCount = idx.count;
      r.hazeKinds = HAZE_KINDS;
      r.regionLabels = res.labels ?? [];
      const look = buildLook(idx, res.tau, idx.count);
      r.setPlacement(res, idx.count, look);
      let notes = 0;
      for (let i = 0; i < idx.count; i++) if (idx.cols.pop[i] === Population.Note) notes++;
      r.setSmallness(notes, idx.count - notes);
      r.setPointBudget(services.settings.value.advanced.pointBudget);
      bus.emit("stage:territories", { viewId, territories: res.territories });
      bus.emit("layout:placement", { viewId, slotsKey: res.slotsKey, regions: res.labels ?? [] });
      if (same && added > 0 && prevCount > 0) r.bornNow(prevCount, added);
      // The ordinals a hover held may have moved: end it (the next pointer move starts it again).
      hubWant = -1;
      if (hubTimer !== null) clearTimeout(hubTimer);
      hubTimer = null;
      dropHub(false);
      await recolour(true);
      refreshState(false);
      void arrange();
      prewarmSoon();
      void drawLines();
      if (!attachedOnce) {
        attachedOnce = true;
        // A record that is there turns the first-paint cloud into the figure; an empty one (the first-run card) or a view
        // with no cloud (reduced motion) keeps the cord-first growth.
        if (r.firstPaintActive() && idx.count > 0) r.endFirstPaint();
        else {
          r.cancelFirstPaint();
          r.playIntro("intro");
        }
      }
    } catch (e) {
      catchWorker(e);
    }
  }
  let attachedOnce = false;

  let lastSettingsColourKey = "";
  async function recolour(force = false): Promise<void> {
    const idx = services.index.index.value;
    const r = renderer;
    if (!idx || !r || !placement) return;
    const v = view();
    const u = ui();
    const s = services.settings.value;
    const stage = stageName();
    // A dimension hovered in the key's menu stands in for the committed one until the menu closes (FIG-36).
    const pv = u.dimPreview;
    const { notes: notesMode, record: recordMode } = previewColour(v.colour, pv, u.dimPreviewPop);
    // Scope, period and a lit set (tokens, a traced set) narrow what the key counts, so they recolour and recount too.
    const lit = litSet !== null ? litSet : null;
    const key = JSON.stringify([v.colour, u.hiddenGroups, s.appearance.palette, s.appearance.ageColours, s.appearance.figureColours, s.appearance.stageTint, stage, v.groupBy, v.shape, services.colours.current(), u.scope, u.period, pv, pv === null ? "" : u.dimPreviewPop, lit !== null ? litVer : 0]);
    if (!force && key === colourKey) return;
    colourKey = key;
    workerEpoch++;
    const mySeq = ++recolourSeq;
    // Clearing an isolation / showing all relights in one frame (FIG-25); hides still fade.
    const instantRestore = consumeInstantRestore();
    try {
      const res = await services.worker.call(viewId, "grouping", {
        notes: notesMode,
        record: recordMode,
        fold: v.colour.fold,
        hideNoValue: v.colour.hideNoValue,
        hiddenGroups: u.hiddenGroups,
        merges: {},
        palette: s.appearance.palette,
        light: stage === "paper",
        age: ageOptions(s.appearance),
        // A figure colour theme recolours the particles only: the key above keeps the own palette and age ramp.
        ...(figureOverride(s.appearance) ? { figure: figureOverride(s.appearance) } : {}),
        slots: services.colours.current(),
        visibility: visibility(false),
        ...(lit !== null ? { lit } : {}),
      });
      if (!renderer || mySeq !== recolourSeq) return;
      grouping = res;
      // A palette, age-colour or theme pick in Settings recolours quickly; a Colour by change keeps the slower lerp.
      const settingsKey = `${s.appearance.palette}|${s.appearance.ageColours}|${s.appearance.figureColours}|${stage}`;
      const settingsPick = lastSettingsColourKey !== "" && lastSettingsColourKey !== settingsKey;
      lastSettingsColourKey = settingsKey;
      r.setColors(res.color, !reduced() && !instantRestore, settingsPick ? T.states.recolourSettingsMs : T.states.recolourMs);
      r.setGroups(res.groupOf, idx.cols.pop);
      store.update("legend", () => res.legend);
      // A previewed dimension is not committed: its sticky slots are kept only once the dimension is picked.
      if (pv === null && Object.keys(res.newSlots).length > 0) void services.colours.merge(res.newSlots).catch(catchWorker);
      colourHaze();
      refreshState(!instantRestore);
    } catch (e) {
      catchWorker(e);
    }
  }

  /**
   * The key's counts inside an area while the rail wordmark's lens (an area preview) holds it: a second grouping over that
   * area's items, kept for its counts alone (the figure's colours stay as they are). It runs under its own call key so the
   * figure's recolour is never superseded by it.
   */
  let lensTimer: ReturnType<typeof setTimeout> | null = null;
  let lensSeq = 0;
  function recountLens(): void {
    if (lensTimer !== null) clearTimeout(lensTimer);
    lensTimer = null;
    const pre = ui().preview;
    const area = pre && pre.kind === "area" ? pre.key : null;
    if (area === null) {
      lensSeq++;
      if (store.get("lens") !== null) store.update("lens", () => null);
      return;
    }
    lensTimer = setTimeout(() => void lensCounts(area), 120);
  }
  async function lensCounts(area: string): Promise<void> {
    const idx = services.index.index.value;
    if (!idx || !renderer) return;
    const v = view();
    const s = services.settings.value;
    const mask = new Uint8Array(idx.count);
    for (let i = 0; i < idx.count; i++) if (spaceName(idx, i) === area && (litSet === null || litSet[i] === 1)) mask[i] = 1;
    const mySeq = ++lensSeq;
    try {
      const res = await services.worker.call(`${viewId}:lens`, "grouping", {
        notes: v.colour.notes,
        record: v.colour.record,
        fold: v.colour.fold,
        hideNoValue: v.colour.hideNoValue,
        hiddenGroups: [],
        merges: {},
        palette: s.appearance.palette,
        light: stageName() === "paper",
        slots: services.colours.current(),
        visibility: visibility(false),
        lit: mask,
      });
      const pre = ui().preview;
      if (mySeq !== lensSeq || !pre || pre.kind !== "area" || pre.key !== area) return;
      store.update("lens", () => ({ area, legend: res.legend }));
    } catch (e) {
      catchWorker(e);
    }
  }

  function colourHaze(): void {
    const r = renderer, p = placement, idx = services.index.index.value;
    if (!r || !p || !idx || !grouping) return;
    const stage = stageName();
    const s = services.settings.value;
    let n = 0;
    const pos = new Float32Array(idx.count * 3);
    const rgb = new Uint8Array(idx.count * 3);
    for (let i = 0; i < idx.count; i++) {
      if (idx.cols.pop[i] !== Population.Note) continue;
      const x = p.anat[i * 3] as number;
      if (!Number.isFinite(x)) continue;
      pos[n * 3] = x;
      pos[n * 3 + 1] = p.anat[i * 3 + 1] as number;
      pos[n * 3 + 2] = p.anat[i * 3 + 2] as number;
      rgb[n * 3] = grouping.color[i * 4] as number;
      rgb[n * 3 + 1] = grouping.color[i * 4 + 1] as number;
      rgb[n * 3 + 2] = grouping.color[i * 4 + 2] as number;
      n++;
    }
    const mist = stage === "paper" ? ([120, 126, 138] as const) : ([182, 187, 211] as const);
    const tint = s.appearance.stageTint;
    // The spine's own colouring by height (the commonest colour of the entries in each stretch of the cord): the thread's beads take it.
    const bins = SPINE_BINS;
    const votes: Map<number, number>[] = Array.from({ length: bins }, () => new Map<number, number>());
    for (let i = 0; i < idx.count; i++) {
      if (idx.cols.pop[i] !== Population.Record) continue;
      const t = p.tau[i] as number;
      if (!Number.isFinite(t) || (grouping.color[i * 4 + 3] as number) < 16) continue;
      const m = votes[Math.min(bins - 1, Math.max(0, Math.floor(t * bins)))] as Map<number, number>;
      const c = ((grouping.color[i * 4] as number) << 16) | ((grouping.color[i * 4 + 1] as number) << 8) | (grouping.color[i * 4 + 2] as number);
      m.set(c, (m.get(c) ?? 0) + 1);
    }
    const spine = new Uint8Array(bins * 3);
    const have: number[] = [];
    for (let b = 0; b < bins; b++) {
      let best = -1, bn = 0;
      for (const [c, n] of votes[b] as Map<number, number>) if (n > bn) { best = c; bn = n; }
      if (best < 0) continue;
      have.push(b);
      spine[b * 3] = (best >> 16) & 255;
      spine[b * 3 + 1] = (best >> 8) & 255;
      spine[b * 3 + 2] = best & 255;
    }
    for (let b = 0; b < bins && have.length > 0; b++) {
      if (votes[b]!.size > 0) continue;
      let near = have[0] as number;
      for (const h of have) if (Math.abs(h - b) < Math.abs(near - b)) near = h;
      spine.copyWithin(b * 3, near * 3, near * 3 + 3);
    }
    r.setHazeColours({
      spine: have.length > 0 ? spine : null,
      notePos: pos,
      noteRgb: rgb,
      noteCount: n,
      mist,
      tint: tint === null ? null : hueRgb(tint, stage),
      oldest: stage === "paper" ? [120, 90, 190] : [150, 120, 230],
      undated: stage === "paper" ? [126, 128, 134] : [114, 123, 138],
    });
  }

  /** The role comet sways: it alternates lying and standing, a slow morph every SWAY_HOLD_MS, for SWAY_FLIPS turns and then rests (the loop idles). */
  let swayOrient: "horizontal" | "vertical" = "horizontal";
  let swayFlips = 0;
  let swayTimer: ReturnType<typeof setTimeout> | null = null;
  function stopSway(): void {
    if (swayTimer !== null) clearTimeout(swayTimer);
    swayTimer = null;
    swayFlips = 0;
  }
  function startSway(): void {
    const v = view();
    if (swayTimer !== null || swayFlips >= SWAY.flips || reduced() || v.motion.mode === "off") return;
    swayTimer = setTimeout(() => {
      swayTimer = null;
      if (!renderer || view().shape !== "groups") return;
      swayOrient = swayOrient === "horizontal" ? "vertical" : "horizontal";
      swayFlips++;
      void arrange(true);
    }, SWAY.holdMs);
  }

  /** Bumped by every arrange(): an answer the worker gives after a newer arrange() began (the shape went back to the body meanwhile) is stale. */
  let arrangeSeq = 0;

  async function arrange(sway = false): Promise<void> {
    const r = renderer;
    if (!r || !placement) return;
    const mySeq = ++arrangeSeq;
    const v = view();
    if (v.shape === "body") {
      dropPendingTimer();
      stopSway();
      swayOrient = "horizontal";
      lastArrangement = null;
      lastShape = "body";
      lastChartId = null;
      r.setArrangement(null, "morph");
      setBundles([]);
      return;
    }
    let shown = false;
    let pill: ReturnType<typeof setTimeout> | null = null;
    try {
      const params =
        v.shape === "groups"
          ? ({
              kind: "groups",
              dim: v.groupBy,
              layout: v.layout,
              fold: v.colour.fold,
              merges: {},
              hideNoValue: v.colour.hideNoValue,
              visibility: visibility(false),
              // Split layout: the record entries are grouped by their own dimension (the notes' own when none is chosen).
              ...(v.splitGroups && v.layers.record ? { recordDim: v.groupByRecord ?? v.groupBy } : {}),
              layoutOptions: v.layoutOptions,
              orientation: swayOrient,
            } as const)
          : v.chart
            ? ({ kind: "chart", spec: v.chart, visibility: visibility(false), ...(chartStage() ? { stage: chartStage() as ChartStage } : {}) } as const)
            : null;
      if (!params) {
        dropPendingTimer();
        r.endPending();
        return;
      }
      if (params.kind === "chart") chartStageSent = chartStageKey(chartStage());
      const usedIndex = services.index.index.value;
      const key = cacheKey(params);
      let res = arrCache.get(key);
      if (!res) {
        // The pill only shows when the worker is slow; the figure itself starts moving on the click (renderer.beginPending).
        pill = setTimeout(() => {
          pill = null;
          shown = true;
          status("arranging");
        }, 400);
        res = await services.worker.call(viewId, "arrangement", params);
        if (pill !== null) clearTimeout(pill);
        pill = null;
        if (key === cacheKey(params)) remember(key, res);
      }
      // A newer arrangement was asked for while the worker answered this one: it is not the view's any more, and laying it
      // out (with its camera fit) would put the figure and the camera somewhere the view does not say.
      if (!renderer || mySeq !== arrangeSeq) {
        if (shown) status("ok");
        return;
      }
      dropPendingTimer();
      lastArrangement = res.arr;
      // A change of Group by (same shape) dissolves and refills the points; the shape slider still travels.
      const groupChange = params.kind === "groups" && lastGroupBy !== null && v.groupBy !== lastGroupBy;
      const chartId = params.kind === "chart" ? params.spec.chart : null;
      const relayout = params.kind === "chart" && chartId === lastChartId && lastRelayout !== "" && relayoutKey(params.spec) !== lastRelayout;
      const entry = v.shape === lastShape && params.kind === "chart" ? entryStyleFor(lastChartId, chartId) : 0;
      r.setArrangement(res, v.shape === lastShape ? "form" : "morph", { groups: params.kind === "groups", chart: params.kind === "chart", ...(groupChange ? { reason: "group" as const } : {}), ...(sway ? { formMs: SWAY.morphMs } : {}), ...(entry ? { entry } : {}), ...(relayout ? { relayout } : {}) });
      lastChartId = chartId;
      lastRelayout = params.kind === "chart" ? relayoutKey(params.spec) : "";
      lastGroupBy = v.groupBy;
      if (res.sway === true && params.kind === "groups") startSway();
      else {
        stopSway();
        swayOrient = "horizontal";
      }
      setBundles(params.kind === "groups" ? (res.bundles ?? []) : []);
      lastShape = v.shape;
      bus.emit("layout:arrangement", { viewId, kind: params.kind, ...(sway ? { settleMs: SWAY.morphMs } : {}) });
      bus.emit("stage:arrangement", { viewId, sparse: res.sparse ?? [], flat: res.camera.keepUpright });
      if (params.kind === "chart" && usedIndex) bus.emit("stage:chart", { viewId, spec: params.spec, result: res, visibility: params.visibility, index: usedIndex, ...(params.stage ? { stage: params.stage } : {}) });
      if (shown) status("ok");
    } catch (e) {
      catchWorker(e);
      dropPendingTimer();
      if (pill !== null) clearTimeout(pill);
      renderer?.endPending();
      if (shown) status("ok");
    }
  }

  /** While the figure idles on the body, lay out the Groups arrangement ahead so the first click is instant. */
  function prewarmSoon(): void {
    if (prewarmTimer !== null) clearTimeout(prewarmTimer);
    prewarmTimer = setTimeout(() => {
      prewarmTimer = null;
      const r = renderer;
      const v = view();
      if (!r || !placement || v.shape !== "body" || reduced()) return;
      const params = {
        kind: "groups",
        dim: v.groupBy,
        layout: v.layout,
        fold: v.colour.fold,
        merges: {},
        hideNoValue: v.colour.hideNoValue,
        visibility: visibility(false),
        ...(v.splitGroups && v.layers.record ? { recordDim: v.groupByRecord ?? v.groupBy } : {}),
        layoutOptions: v.layoutOptions,
        orientation: swayOrient,
      } as const;
      const key = cacheKey(params);
      if (arrCache.has(key)) return;
      void services.worker
        .call(viewId, "arrangement", params)
        .then((res) => {
          if (renderer === r && key === cacheKey(params)) remember(key, res);
        })
        .catch(catchWorker);
    }, 1800);
  }
  let lastShape = "body";
  let lastGroupBy: ReturnType<typeof view>["groupBy"] | null = null;
  /** Group bundles are drawn once the morph passes this (the same threshold as the labels: CORTEX-UX §6.12). */
  const BUNDLES_MORPH = 0.85;

  function setBundles(next: readonly GroupBundle[]): void {
    if (next.length > 0 || groupBundleList.length > 0) {
      groupBundleList = next;
      bundlesSeq++;
    }
    // Always redraw: the lines key holds the shape, so a change of shape clears the previous shape's lines.
    void drawLines();
  }

  /**
   * Groups shape: fibre bundles between the group spheres, weighted by the note links that cross. They follow the
   * Lines look: Off draws none, Selection (the resting setting) draws a fan per bundle, All draws twice the fibres.
   */
  function drawBundles(mode: "off" | "selection" | "all"): void {
    const r = renderer;
    if (!r) return;
    linesResult = null;
    // The beams and cones of a figure form are part of its shape, so they stay when Lines is Off; link fibres follow the setting.
    const list = mode === "off" ? groupBundleList.filter((b) => b.form === "cone" || b.form === "beam") : groupBundleList;
    if (list.length === 0) return;
    const fibres = bundleFibres(list, mode === "off" ? "selection" : mode);
    if (fibres.segments > 0) r.setLines(LINE_FAMILY.Source, fibres.positions.subarray(0, fibres.segments * 6), fibres.colors.subarray(0, fibres.segments * 8), fibres.t.subarray(0, fibres.segments * 2));
  }

  async function drawLines(): Promise<void> {
    const r = renderer;
    if (!r || !placement) return;
    const v = view();
    const sel = store.get("selection");
    const mode = v.look.lines;
    // Lines: Selection draws only the selected item's own links (the worker's `related` answer); All draws every note's.
    const forSelection = sel !== null && sel.ordinal >= 0;
    const ownReady = forSelection && related !== null && relatedFor === sel.ordinal;
    const families: ("source" | "stem" | "link")[] = [];
    if (mode === "all") families.push("source", "link");
    if (stemsOn(v)) families.push("stem");
    // The bundles of the Groups shape do not depend on the selection; everything else keeps the old key.
    const key =
      v.shape === "groups"
        ? JSON.stringify(["groups", mode, bundlesSeq, v.morph > BUNDLES_MORPH])
        : JSON.stringify([families, mode, forSelection ? sel.ordinal : sel !== null ? -2 : -1, ownReady, v.shape, placedKey]);
    if (key === linesKey) return;
    linesKey = key;
    for (const f of [LINE_FAMILY.Source, LINE_FAMILY.Stem, LINE_FAMILY.Spoke, LINE_FAMILY.Link]) r.clearLines(f);
    spokeCache = null;
    // The fibres join the spheres where the points end up: they show once the points have (almost) arrived.
    if (v.shape === "groups") {
      drawBundles(v.morph > BUNDLES_MORPH ? mode : "off");
      // A hovered hub's fan is joined once the points have arrived (it needs the settled positions).
      if (hubHover) applyFan();
      return;
    }
    if (v.shape !== "body") return;
    try {
      const sets: LinesResult[] = [];
      if (families.length > 0) sets.push(await services.worker.call(viewId, "lines", { families, visibility: visibility(false), budget: T.lines.budget }));
      if (!renderer || key !== linesKey) return;
      const ownStart = sets.reduce((n, x) => n + x.segments, 0);
      if (ownReady && related) sets.push(related.lines);
      const merged = mergeLines(sets);
      linesResult = merged;
      for (const [name, fam] of [["source", LINE_FAMILY.Source], ["stem", LINE_FAMILY.Stem], ["spoke", LINE_FAMILY.Spoke], ["link", LINE_FAMILY.Link]] as const) {
        if ((name === "source" || name === "link") && mode === "off") continue;
        const famIdx = LINE_FAMILIES.indexOf(name);
        const idxs: number[] = [];
        for (let s = 0; s < merged.segments; s++) if (merged.family[s] === famIdx) idxs.push(s);
        if (idxs.length === 0) continue;
        const pos = new Float32Array(idxs.length * 6);
        const t = new Float32Array(idxs.length * 2);
        const col = new Uint8Array(idxs.length * 8);
        idxs.forEach((s, k) => {
          pos.set(merged.positions.subarray(s * 6, s * 6 + 6), k * 6);
          t.set(merged.t.subarray(s * 2, s * 2 + 2), k * 2);
          const o = merged.target[s] as number;
          const c = grouping ? [grouping.color[o * 4], grouping.color[o * 4 + 1], grouping.color[o * 4 + 2]] : [255, 255, 255];
          for (let e = 0; e < 2; e++) {
            // Source lines are white (the worker already drew them as curves round the torso); stems and spokes take the territory colour.
            const white = name === "source" || name === "link";
            col[k * 8 + e * 4] = white ? 255 : (c[0] as number);
            col[k * 8 + e * 4 + 1] = white ? 255 : (c[1] as number);
            col[k * 8 + e * 4 + 2] = white ? 255 : (c[2] as number);
            // The selection's own lines keep the tuned alpha; the rest dim while something is selected (render/lineAlpha.ts).
            col[k * 8 + e * 4 + 3] = lineVertexAlpha8(ownReady && s >= ownStart, sel !== null);
          }
        });
        r.setLines(fam, pos, col, t);
        if (name === "spoke") spokeCache = { pos, col, t };
      }
      // A hub is being hovered: its fan takes the spoke family over until the pointer leaves.
      if (hubHover) applyFan();
    } catch (e) {
      catchWorker(e);
    }
  }

  /** The drawn segments of several worker answers as one result (hover naming reads it). */
  function mergeLines(sets: readonly LinesResult[]): LinesResult {
    const total = sets.reduce((n, x) => n + x.segments, 0);
    const out: LinesResult = { positions: new Float32Array(total * 6), t: new Float32Array(total * 2), family: new Uint8Array(total), owner: new Uint32Array(total), target: new Uint32Array(total), segments: total };
    let at = 0;
    for (const x of sets) {
      out.positions.set(x.positions.subarray(0, x.segments * 6), at * 6);
      out.t.set(x.t.subarray(0, x.segments * 2), at * 2);
      out.family.set(x.family.subarray(0, x.segments), at);
      out.owner.set(x.owner.subarray(0, x.segments), at);
      out.target.set(x.target.subarray(0, x.segments), at);
      at += x.segments;
    }
    return out;
  }

  async function resolveLit(): Promise<void> {
    const u = ui();
    const idx = services.index.index.value;
    if (!idx) return;
    const key = JSON.stringify([u.tokens, u.scope, u.period, u.revealedCount]);
    if (key === litKey) return;
    litKey = key;
    if (u.tokens.length === 0) {
      litSet = null;
      litVer++;
      refreshState(true);
      return;
    }
    try {
      const res = await services.worker.call(viewId, "query", { tokens: u.tokens, visibility: visibility(false) });
      if (key !== litKey) return;
      const set = new Uint8Array(idx.count);
      for (let i = 0; i < res.count; i++) set[res.ordinals[i] as number] = 1;
      litSet = set;
      litVer++;
      store.update("lit", () => res.count);
      refreshState(true);
    } catch (e) {
      catchWorker(e);
    }
  }

  async function resolveRelated(): Promise<void> {
    const sel = store.get("selection");
    if (!sel) {
      related = null;
      relatedFor = -1;
      refreshState(true);
      return;
    }
    if (sel.ordinal === relatedFor) return;
    relatedFor = sel.ordinal;
    try {
      const res = await services.worker.call(viewId, "related", { ordinal: sel.ordinal });
      if (relatedFor !== sel.ordinal) return;
      related = res;
      refreshState(true);
      void drawLines();
    } catch (e) {
      catchWorker(e);
    }
  }

  /** PointState bits per ordinal (§6.6). */
  function refreshState(animate: boolean): void {
    const r = renderer, idx = services.index.index.value, p = placement;
    if (!r || !idx || !p) return;
    const u = ui();
    const vis = visibility(false);
    const state = new Uint32Array(idx.count);
    const sel = store.get("selection");
    const lit = new Uint8Array(idx.count);
    const member = new Uint8Array(idx.count);
    let anyLit = false;
    if (litSet) {
      lit.set(litSet.subarray(0, idx.count));
      anyLit = true;
    }
    if (sel && related) {
      const add = (list: Uint32Array, m: boolean): void => {
        for (const o of list) {
          if (o < idx.count) {
            lit[o] = 1;
            if (m) member[o] = 1;
          }
        }
      };
      add(related.sources, false);
      add(related.members, true);
      add(related.sameConversation, true);
      add(related.citedBy, false);
      if (sel.ordinal < idx.count) lit[sel.ordinal] = 1;
      anyLit = true;
    }
    const pre = u.preview;
    const preview = new Uint8Array(idx.count);
    let anyPreview = false;
    if (pre && pre.kind === "area") {
      for (let i = 0; i < idx.count; i++) if (spaceName(idx, i) === pre.key) preview[i] = 1;
      anyPreview = true;
    } else if (pre && pre.kind === "period") {
      // A hovered strip bar: the entries and notes written in [start, end) match, the rest dim to 35%.
      const range = parsePeriodPreview(pre.key);
      if (range) {
        const [from, to] = range;
        for (let i = 0; i < idx.count; i++) {
          const t = idx.cols.t[i] as number;
          if (Number.isFinite(t) && t >= from && t < to) preview[i] = 1;
        }
        anyPreview = true;
      }
    } else if (pre && pre.kind === "group") {
      // A hovered key chip: the members of its row stay at full colour, everything else dims like an area preview.
      const set = groupPreviewSet(grouping?.legend ?? null, grouping?.groupOf ?? null, idx.cols.pop, idx.count, pre.key);
      if (set) {
        preview.set(set);
        anyPreview = true;
      }
    }
    // A hovered hub: with nothing selected or traced it lights itself, its member notes and its revealed source entries
    // (the rest dims like a preview); the source entries also carry the MapSource bit so they read white.
    const hub = hubHover;
    const sprayed = new Uint8Array(hub ? idx.count : 0);
    if (hub) {
      for (let k = 0; k < hub.revealed && k < hub.sources.length; k++) sprayed[hub.sources[k] as number] = 1;
      if (!anyLit && !anyPreview && !sel && u.tokens.length === 0) {
        preview[hub.hub] = 1;
        for (const m of hub.members) preview[m] = 1;
        for (let k = 0; k < hub.revealed && k < hub.sources.length; k++) preview[hub.sources[k] as number] = 1;
        anyPreview = true;
      }
    }
    const hiddenRows = hiddenRowSets();
    const t0 = u.period ? u.period[0] : -Infinity;
    const t1 = u.period ? u.period[1] : Infinity;
    for (let i = 0; i < idx.count; i++) {
      if (!Number.isFinite(p.anat[i * 3] as number) || i >= vis.revealedCount) continue;
      let b = POINT_STATE.Visible;
      if (anyLit ? lit[i] : anyPreview ? preview[i] : 1) b |= POINT_STATE.Lit;
      if (member[i]) b |= POINT_STATE.Member;
      if (hub && sprayed[i]) b |= POINT_STATE.MapSource;
      if (hiddenRows && grouping) {
        const row = grouping.groupOf[i] as number;
        const rows = idx.cols.pop[i] === Population.Note ? hiddenRows.notes : hiddenRows.record;
        if (row === NONE32 ? hiddenRows.hideNoValue : rows.has(row)) b |= POINT_STATE.HiddenByKey;
      }
      const t = idx.cols.t[i] as number;
      if (u.period && Number.isFinite(t) && (t < t0 || t > t1)) b |= POINT_STATE.OutsidePeriod;
      if (u.scope !== "all" && spaceName(idx, i) !== u.scope) b |= POINT_STATE.OutsideScope;
      state[i] = b;
    }
    const traced = u.tokens.length > 0;
    const lens = anyPreview && pre?.kind === "area" && pre.strong === true;
    const dimOthers = sel ? T.stateAlpha.selectedOthers : traced ? T.stateAlpha.tracedOthers : anyPreview ? (lens ? T.stateAlpha.lensOthers : T.stateAlpha.previewOthers) : 1;
    const keyed = hiddenRows !== null && (hiddenRows.notes.size > 0 || hiddenRows.record.size > 0);
    const haze = sel ? T.stateAlpha.hazeWhileSelected : traced ? T.stateAlpha.hazeWhileTraced : lens ? T.stateAlpha.hazeWhileLens : keyed ? T.stateAlpha.hazeWhileKeyed : 1;
    const fadeMs = lens ? T.states.lensFadeMs : T.states.fadeMs;
    r.setPointState(state, 0, idx.count, animate, fadeMs);
    r.setDimming(dimOthers, haze, 1, fadeMs);
    r.setScopeSink(u.scope !== "all");
    updateAnchors();
  }

  /** A predicate for the notes and entries a hidden legend row (or "hide items without a value") hides. */
  function hiddenByKey(): (i: number) => boolean {
    const idx = services.index.index.value;
    const sets = hiddenRowSets();
    const g = grouping;
    if (!idx || !sets || !g) return () => false;
    return (i) => {
      if (i < 0 || i >= idx.count) return false;
      const row = g.groupOf[i] as number;
      return row === NONE32 ? sets.hideNoValue : (idx.cols.pop[i] === Population.Note ? sets.notes : sets.record).has(row);
    };
  }

  function hiddenRowSets(): { notes: Set<number>; record: Set<number>; hideNoValue: boolean } | null {
    const lg = store.get("legend");
    if (!lg) return null;
    const notes = new Set<number>(), record = new Set<number>();
    for (const s of lg.sections) {
      s.rows.forEach((row, i) => {
        if (!row.hidden) return;
        if (s.population !== "record") notes.add(i);
        if (s.population !== "notes") record.add(i);
      });
    }
    return { notes, record, hideNoValue: view().colour.hideNoValue };
  }

  function spaceName(idx: import("../shared/index-format").DataIndex, i: number): string {
    return SPACES[idx.cols.space[i] as number] ?? "none";
  }

  // ───────────── labels, compass ─────────────

  interface AnchorLabel {
    kind: string;
    title: string;
    count?: number;
    white?: boolean;
  }
  interface AnchorCandidate {
    ordinal: number;
    priority: number;
    label?: AnchorLabel;
    /** A member chip of the hovered hub. */
    hover?: true;
  }
  let anchorCandidates: AnchorCandidate[] = [];

  function updateAnchors(): void {
    const idx = services.index.index.value;
    const sel = store.get("selection");
    const out: AnchorCandidate[] = [];
    if (idx) {
      const seen = new Set<number>();
      const push = (o: number, p: number, label?: AnchorLabel, hover?: true): void => {
        if (o < 0 || o >= idx.count || seen.has(o)) return;
        seen.add(o);
        out.push({ ordinal: o, priority: p, ...(label ? { label } : {}), ...(hover ? { hover } : {}) });
      };
      if (sel) {
        const conv = services.index.meta(sel.ordinal)?.conversation;
        let tip = -1;
        if (related) {
          // The last message of the conversation (the list also holds the machine notes built from it).
          for (let k = related.sameConversation.length - 1; k >= 0 && tip < 0; k--) {
            const o = related.sameConversation[k] as number;
            if (idx.cols.pop[o] === Population.Record) tip = o;
          }
        }
        // A selected conversation is named once, at the tip of its frond (main.png); anything else at its own point.
        if (conv && tip >= 0) push(tip, 4, { kind: "Conversation", title: conv.title, count: conv.count, white: true });
        else push(sel.ordinal, 4);
      }
      if (related) {
        for (const o of related.sources) push(o, 3);
        for (const o of related.members) push(o, 3);
        // The notes built from a selected entry or conversation, named in the columns beside the brain.
        for (const o of Array.from(related.citedBy).slice(0, MAX_NOTE_NAMES)) push(o, 3);
      }
      if (litSet) {
        let k = 0;
        for (let i = 0; i < idx.count && k < 48; i++) if (litSet[i]) { push(i, 2); k++; }
      }
      // A hovered hub names its largest member notes: the live interaction outranks traced and always-on names, but not the
      // selection's own chips (pushed first, so their labels win and the 30-chip cap drops hover chips before them).
      if (hubHover) {
        // A legend row hidden since the hover began leaves its members unnamed too.
        const hidden = hiddenByKey();
        for (const o of hubHover.chips) if (!hidden(o)) push(o, 2.5, undefined, true);
      }
      if (view().look.names === "always") {
        for (let i = 0; i < idx.count && out.length < 48; i++) if (idx.cols.hubType[i] !== NONE8) push(i, 1);
      }
    }
    anchorCandidates = out;
  }

  function onFrame(f: FrameInfo): void {
    const idx = services.index.index.value;
    const r = renderer;
    if (!r || !idx || !placement) return;
    // Label anchors (≤ 30 Hz, the renderer throttles the callback).
    if (anchorCandidates.length > 0 || lastAnchors > 0) {
      const anchors: LabelAnchor[] = [];
      const cam = f.camera.camera;
      const morphed = view().shape !== "body" && view().morph > 0.5;
      const fig = r.figureBounds();
      const me = cam.matrixWorld.elements;
      const camPos: [number, number, number] = [me[12] as number, me[13] as number, me[14] as number];
      const camToFigure = Math.hypot(fig.centre[0] - camPos[0], fig.centre[1] - camPos[1], fig.centre[2] - camPos[2]);
      for (const c of anchorCandidates) {
        const arr = morphed && lastArrangement ? lastArrangement : placement.anat;
        const x = arr[c.ordinal * 3] as number, y = arr[c.ordinal * 3 + 1] as number, z = arr[c.ordinal * 3 + 2] as number;
        if (!Number.isFinite(x + y + z)) continue;
        const v = projectPoint(x, y, z, cam, f.width, f.height);
        if (!v) continue;
        const meta = services.index.meta(c.ordinal);
        // Depth cue for the chip: 0 on the figure's near side, 1 on its far side (distance from the camera across the figure's radius).
        const dist = Math.hypot(x - camPos[0], y - camPos[1], z - camPos[2]);
        const dz = Math.max(0, Math.min(1, 0.5 + (dist - camToFigure) / (2 * Math.max(0.001, fig.radius))));
        const noteKind = meta?.noteKind;
        const base: LabelAnchor = {
          key: String(c.ordinal),
          ordinal: c.ordinal,
          x: v.x,
          y: v.y,
          depth: dz,
          priority: c.priority,
          kind: noteKind ? kindWord(noteKind) : meta?.mapKind ? kindWord(meta.mapKind) : "",
          glyph: noteKind ? ((KIND_STYLE as Record<string, { glyph: string }>)[noteKind]?.glyph ?? "") : "",
          title: meta?.title ?? "",
          rgb: grouping ? [grouping.color[c.ordinal * 4] as number, grouping.color[c.ordinal * 4 + 1] as number, grouping.color[c.ordinal * 4 + 2] as number] : [255, 255, 255],
        };
        const l = c.label;
        if (c.hover) base.hover = true;
        anchors.push(l ? { ...base, kind: l.kind, glyph: "", title: l.title, ...(l.count !== undefined ? { count: l.count } : {}), ...(l.white ? { rgb: [255, 255, 255] as [number, number, number] } : {}) } : base);
      }
      lastAnchors = anchors.length;
      bus.emit("stage:labels", { viewId, anchors, columns: view().pose === "standing" && !morphed ? figureColumns(cam, f.width, f.height) : null });
    }
    // The dot cursor of a deep chart zoom (a cheap check, 8 Hz, only while a chart shows).
    if (f.nowMs - lastZoomCheckMs >= 125) {
      lastZoomCheckMs = f.nowMs;
      const model = view().shape === "chart" ? r.overlay() : null;
      const zoomed = model ? chartZoomedPastGiveWay(model.marks, (p) => { const v = projectPoint(p[0], p[1], p[2], f.camera.camera, f.width, f.height); return v ? { x: v.x, y: v.y, visible: true } : { x: 0, y: 0, visible: false }; }, { width: f.width, height: f.height }) : false;
      if (zoomed !== deepZoom) {
        deepZoom = zoomed;
        refreshCursor();
      }
    }
    // Compass needle: the azimuth now facing the camera, ≤ 15 Hz and not at all under reduced motion.
    if (!reduced() && f.nowMs - lastNeedleMs >= 1000 / 15) {
      const h = f.camera.heading(f.nowMs);
      const needle = (((-h.yawDeg % 360) + 360) % 360);
      if (Math.abs(needle - lastNeedle) > 0.25) {
        lastNeedle = needle;
        lastNeedleMs = f.nowMs;
        bus.emit("stage:camera", { viewId, needleDeg: needle, headingDeg: (((-h.headingDeg % 360) + 360) % 360) });
      }
    }
  }
  let lastAnchors = 0;
  /** Names for the notes built from a selection (the columns hold seven or eight chips). */
  const MAX_NOTE_NAMES = 8;
  /** "decision" → "Decision", "gist" → "Summary" (copy calls the conversation summary a summary). */
  const kindWord = (k: string): string => (k === "gist" ? "Summary" : k.charAt(0).toUpperCase() + k.slice(1));
  let lastArrangement: Float32Array | null = null;

  // ───────────── hub hover (SPEC F9) ─────────────

  /** What a hovered hub shows at once: chips for its biggest members, a fan of links, its source entries in white. */
  interface HubHover {
    hub: number;
    /** Every member note, largest first. */
    members: number[];
    /** The members named with chips: placed and shown, at most HUB_HOVER.chips. */
    chips: number[];
    /** The record entries its members are built from, oldest (top of the spine) first. */
    sources: number[];
    /** How many of `sources` are lit so far: the spray fades in from the top down. */
    revealed: number;
  }
  let hubHover: HubHover | null = null;
  /** The hub the pointer is on (-1 none). The effects start after HUB_DWELL_MS on it and stop at once when it leaves. */
  let hubWant = -1;
  let hubTimer: ReturnType<typeof setTimeout> | null = null;
  let sprayTimer: ReturnType<typeof setTimeout> | null = null;
  /** The spoke family as drawLines last set it (a selected map's own spokes), put back when a hover fan ends. */
  let spokeCache: { pos: Float32Array; col: Uint8Array; t: Float32Array } | null = null;
  const HUB_DWELL_MS = 70;
  const SPRAY_STEPS = 4;
  const SPRAY_STEP_MS = 100;
  /** How far toward white (ink) or dark (paper) the lit source entries are pulled. */
  const SPRAY_TINT_MIX = 0.8;
  const MAX_FAN = 400;

  const hubOf = (o: number): number => {
    const idx = services.index.index.value;
    return idx && o >= 0 && o < idx.count && idx.cols.kind[o] === ItemKind.NoteHub ? o : -1;
  };

  function restoreSpokes(): void {
    const r = renderer;
    if (!r) return;
    if (spokeCache) r.setLines(LINE_FAMILY.Spoke, spokeCache.pos, spokeCache.col, spokeCache.t);
    else r.clearLines(LINE_FAMILY.Spoke);
  }

  function applyFan(): void {
    const r = renderer, h = hubHover, p = placement;
    if (!r || !h || !p) return;
    // Body: the anatomy. Groups: the arrangement's points, once the morph has settled (the hub and its members are
    // then where the labels are).
    const at = fanPositions(view().shape, view().morph, BUNDLES_MORPH, p.anat, lastArrangement);
    if (!at) return;
    const open = hiddenByKey();
    const fan = buildHubFan(at, grouping?.color ?? null, h.hub, h.members.filter((m) => !open(m)).slice(0, MAX_FAN));
    if (fan.segments > 0) r.setLines(LINE_FAMILY.Spoke, fan.positions, fan.colors, fan.t);
    else restoreSpokes();
  }

  function clearSprayTimer(): void {
    if (sprayTimer !== null) clearTimeout(sprayTimer);
    sprayTimer = null;
  }

  /** Light the next quarter of the source entries (all at once under reduced motion). */
  function spray(step: number): void {
    const h = hubHover;
    if (!h) return;
    const steps = reduced() ? 1 : SPRAY_STEPS;
    h.revealed = Math.ceil((h.sources.length * (step + 1)) / steps);
    refreshState(true);
    if (step + 1 < steps) {
      sprayTimer = setTimeout(() => {
        sprayTimer = null;
        if (hubHover === h) spray(step + 1);
      }, SPRAY_STEP_MS);
    }
  }

  function startHub(o: number): void {
    const r = renderer, idx = services.index.index.value, p = placement;
    if (!r || !idx || !p) return;
    const members = hubMemberList(idx, o);
    if (members.length === 0) {
      dropHub(true);
      return;
    }
    const revealedCount = visibility(false).revealedCount;
    const drawn = (i: number): boolean => i < revealedCount && Number.isFinite(p.anat[i * 3] as number);
    const u = ui();
    const hidden = hiddenByKey();
    const named = (i: number): boolean => drawn(i) && !hidden(i) && (u.scope === "all" || spaceName(idx, i) === u.scope) && !(u.period && Number.isFinite(idx.cols.t[i] as number) && ((idx.cols.t[i] as number) < u.period[0] || (idx.cols.t[i] as number) > u.period[1]));
    const t = idx.cols.t;
    const when = (i: number): number => (Number.isFinite(t[i] as number) ? (t[i] as number) : Infinity);
    const sources = hubSourceList(idx, members)
      .filter(drawn)
      .sort((a, b) => when(a) - when(b) || a - b);
    clearSprayTimer();
    hubHover = { hub: o, members, chips: members.filter(named).slice(0, HUB_HOVER.chips), sources, revealed: 0 };
    r.setSourceTint(stageName() === "paper" ? [22, 24, 34] : [255, 255, 255], SPRAY_TINT_MIX);
    applyFan();
    spray(0);
  }

  /** Stop the hub effects; `refresh` redraws the point states and chips (false when a refresh follows anyway). */
  function dropHub(refresh: boolean): void {
    clearSprayTimer();
    if (!hubHover) return;
    hubHover = null;
    renderer?.setSourceTint(null, 0);
    restoreSpokes();
    if (refresh) refreshState(true);
  }

  /** The pointer is on `o` (-1 for no hub). Starting waits out a short dwell, so sweeping across the figure stays cheap. */
  function wantHub(o: number, immediate = false): void {
    if (o === hubWant) return;
    hubWant = o;
    if (hubTimer !== null) clearTimeout(hubTimer);
    hubTimer = null;
    if (o < 0) {
      dropHub(true);
      return;
    }
    if (immediate) {
      startHub(o);
      return;
    }
    hubTimer = setTimeout(() => {
      hubTimer = null;
      if (hubWant === o) startHub(o);
    }, HUB_DWELL_MS);
  }

  // ───────────── pointer ─────────────

  function canvasXY(e: MouseEvent): { x: number; y: number } {
    const rect = (canvas as HTMLCanvasElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  let pickPending = false;
  async function hoverAt(x: number, y: number): Promise<void> {
    const r = renderer;
    if (!r || pickPending) return;
    pickPending = true;
    try {
      const o = await r.pick(x, y);
      if (!renderer || pointer?.down) return;
      r.setHover(o);
      wantHub(hubOf(o));
      if (o >= 0) store.update("hover", () => ({ ordinal: o, x, y }));
      else if (store.get("hover")) store.update("hover", () => null);
      if (o < 0) lineHover(x, y);
      refreshCursor();
      if (view().motion.pauseWhilePointing && o !== restOrd) {
        // Pause only when the pointer stays on ONE point for pointerRestMs. Sweeping across the figure crosses a new
        // point on almost every pick, so the motion keeps going; it used to stop whenever the pointer was over it.
        restOrd = o;
        if (restTimer !== null) clearTimeout(restTimer);
        restTimer = null;
        r.camera.setResting(false);
        if (o >= 0) {
          restTimer = setTimeout(() => {
            restTimer = null;
            if (restOrd === o && renderer === r && !pointer?.down) r.camera.setResting(true);
          }, T.motion.pointerRestMs);
        }
      }
    } finally {
      pickPending = false;
    }
  }

  /** Hovering a source line names its note (the pick is `nearestSegment` over the projected segments). */
  function lineHover(x: number, y: number): void {
    const r = renderer;
    if (!r || !linesResult || view().look.lines === "off") return;
    const seg = r.lineSegments(LINE_FAMILY.Source);
    if (seg.segments === 0) return;
    const screen = projectSegments(seg.positions, seg.segments, r.camera.camera, canvas?.clientWidth ?? 1, canvas?.clientHeight ?? 1);
    const hit = nearestSegment(screen, x, y, T.lines.pickPx);
    if (hit < 0) return;
    const chord = Math.floor(hit / Math.max(1, Math.floor(seg.segments / Math.max(1, countFamily(LINE_FAMILY.Source)))));
    const owner = sourceOwners[chord];
    if (owner !== undefined) store.update("hover", () => ({ ordinal: owner, x, y }));
  }
  let sourceOwners: number[] = [];
  const countFamily = (fam: number): number => {
    const res = linesResult;
    if (!res) return 0;
    let n = 0;
    sourceOwners = [];
    for (let s = 0; s < res.segments; s++) if (res.family[s] === fam) { n++; sourceOwners.push(res.owner[s] as number); }
    return n;
  };

  /** The point Tab has stepped to (-1 = none): hovered and announced, opened by Enter. */
  let stepped = -1;
  function clearStep(): void {
    if (stepped < 0) return;
    stepped = -1;
    renderer?.setHover(-1);
    wantHub(-1);
    if (store.get("hover")) store.update("hover", () => null);
  }
  function stepTo(o: number): void {
    const r = renderer;
    if (!r) return;
    stepped = o;
    r.setHover(o);
    wantHub(hubOf(o), true);
    const arr = placement?.anat;
    const v = arr && canvas ? projectPoint(arr[o * 3] as number, arr[o * 3 + 1] as number, arr[o * 3 + 2] as number, r.camera.camera, canvas.clientWidth, canvas.clientHeight) : null;
    store.update("hover", () => ({ ordinal: o, x: v?.x ?? (canvas?.clientWidth ?? 0) / 2, y: v?.y ?? (canvas?.clientHeight ?? 0) / 2 }));
    bus.emit("stage:announce", { viewId, ordinal: o });
  }

  /** The canvas cursor from hover, drag and zoom state (`data-cursor`; stage.css draws it). */
  function refreshCursor(): void {
    const c = canvas;
    if (!c) return;
    const next = canvasCursor({ dragging: !!pointer?.down && pointer.moved > T.pointer.clickSlopPx, overTarget: store.get("hover") !== null || stepped >= 0, deepZoom });
    if (c.dataset.cursor !== next) c.dataset.cursor = next;
  }

  function wirePointer(c: HTMLCanvasElement): void {
    c.tabIndex = 0;
    const down = (e: PointerEvent): void => {
      const r = renderer;
      if (!r) return;
      const { x, y } = canvasXY(e);
      pointer = { x, y, down: true, moved: 0, sx: x, sy: y, button: e.button };
      wantHub(-1);
      c.setPointerCapture?.(e.pointerId);
      r.camera.pointerDown(x, y, e.button, e.shiftKey, nowMs());
      r.invalidate();
      refreshCursor();
    };
    const move = (e: PointerEvent): void => {
      const r = renderer;
      if (!r) return;
      const { x, y } = canvasXY(e);
      if (pointer?.down) {
        pointer.moved = Math.max(pointer.moved, Math.hypot(x - pointer.sx, y - pointer.sy));
        r.camera.pointerMove(x, y, nowMs());
        r.invalidate();
        refreshCursor();
        return;
      }
      pointer = { x, y, down: false, moved: 0, sx: x, sy: y, button: 0 };
      const t = nowMs();
      if (t - lastPick >= 1000 / T.pointer.pickHz) {
        lastPick = t;
        const mod = e.ctrlKey || e.metaKey;
        void hoverAt(x, y).then(() => {
          // Ctrl/Cmd + hover on a note: Obsidian's page preview (the shell resolves the path).
          const h = mod ? store.get("hover") : null;
          if (!h) {
            previewed = -1;
            return;
          }
          const meta = services.index.meta(h.ordinal);
          if (!meta || h.ordinal === previewed) return;
          previewed = h.ordinal;
          bus.emit("stage:point", { viewId, ordinal: h.ordinal, id: meta.id, gesture: "preview", x: e.clientX, y: e.clientY, event: e });
        });
      }
    };
    const up = async (e: PointerEvent): Promise<void> => {
      const r = renderer;
      if (!r || !pointer) return;
      const { x, y } = canvasXY(e);
      const wasClick = pointer.moved <= T.pointer.clickSlopPx && pointer.button === 0;
      pointer.down = false;
      r.camera.pointerUp(nowMs());
      c.releasePointerCapture?.(e.pointerId);
      refreshCursor();
      if (!wasClick) return;
      const o = await r.pick(x, y);
      const idx = services.index.index.value;
      if (o < 0 || !idx) {
        const t = nowMs();
        if (t - lastClick < T.pointer.dblClickMs) r.home();
        lastClick = t;
        clearSelection(store);
        return;
      }
      const meta = services.index.meta(o);
      if (!meta) return;
      // The shell decides what opens (CORTEX-UX §2.3): click selects and opens the reader, a second click on the
      // same point is the double-click, Ctrl/Cmd + click is the new-tab gesture.
      const t = nowMs();
      const dbl = t - lastClick < T.pointer.dblClickMs && store.get("selection")?.ordinal === o;
      lastClick = t;
      select(store, o, meta.id);
      bus.emit("stage:point", { viewId, ordinal: o, id: meta.id, gesture: e.ctrlKey || e.metaKey ? "ctrl-click" : dbl ? "dblclick" : "click", x: e.clientX, y: e.clientY });
    };
    const leave = (): void => {
      previewed = -1;
      renderer?.setHover(-1);
      wantHub(-1);
      renderer?.camera.setResting(false);
      restOrd = -1;
      if (restTimer !== null) clearTimeout(restTimer);
      restTimer = null;
      if (store.get("hover")) store.update("hover", () => null);
      refreshCursor();
    };
    const wheel = (e: WheelEvent): void => {
      const r = renderer;
      if (!r) return;
      e.preventDefault();
      const { x, y } = canvasXY(e);
      r.camera.wheel(e.deltaY, x, y, e.ctrlKey || e.altKey, nowMs());
      r.invalidate();
    };
    const ctx = (e: MouseEvent): void => {
      e.preventDefault();
      // A right-drag is a pan, not a menu.
      if (pointer && pointer.button === 2 && pointer.moved > T.pointer.clickSlopPx) return;
      const { x, y } = canvasXY(e);
      void renderer?.pick(x, y).then((o) => {
        const meta = o >= 0 ? services.index.meta(o) : undefined;
        if (meta) bus.emit("stage:point", { viewId, ordinal: o, id: meta.id, gesture: "context", x: e.clientX, y: e.clientY });
      });
    };
    const key = (e: KeyboardEvent): void => {
      const r = renderer;
      const a = stageKeyAction(e);
      if (!r || !a) return;
      const cx = ((canvas?.clientWidth ?? 0) - layout.insetRight) / 2;
      const cy = (canvas?.clientHeight ?? 0) / 2;
      switch (a.kind) {
        case "turn":
          r.camera.orbitBy(a.dYawDeg, a.dPitchDeg);
          break;
        case "pan":
          r.camera.panBy(a.dxPx, a.dyPx, nowMs());
          break;
        case "zoom":
          r.camera.zoomAt(a.k, cx, cy, nowMs());
          break;
        case "step": {
          const idx = services.index.index.value;
          const to = idx ? stepTarget(tracedOrder(litSet, idx.cols.words, idx.count), stepped, a.dir) : null;
          // Past either end (or nothing traced) Tab keeps its normal job: focus moves on.
          if (to === null) {
            clearStep();
            return;
          }
          stepTo(to);
          break;
        }
        case "open": {
          const o = stepped >= 0 ? stepped : (store.get("selection")?.ordinal ?? -1);
          const meta = o >= 0 ? services.index.meta(o) : undefined;
          if (!meta) return;
          select(store, o, meta.id);
          bus.emit("stage:point", { viewId, ordinal: o, id: meta.id, gesture: a.newTab ? "ctrl-click" : "click", x: 0, y: 0 });
          break;
        }
      }
      e.preventDefault();
      r.invalidate();
    };
    const blur = (): void => clearStep();
    const focusOnDown = (): void => c.focus({ preventScroll: true });
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("pointerleave", leave);
    c.addEventListener("wheel", wheel, { passive: false });
    c.addEventListener("contextmenu", ctx);
    c.addEventListener("keydown", key);
    c.addEventListener("blur", blur);
    c.addEventListener("pointerdown", focusOnDown);
    offs.push(() => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", up);
      c.removeEventListener("pointercancel", up);
      c.removeEventListener("pointerleave", leave);
      c.removeEventListener("wheel", wheel);
      c.removeEventListener("contextmenu", ctx);
      c.removeEventListener("keydown", key);
      c.removeEventListener("blur", blur);
      c.removeEventListener("pointerdown", focusOnDown);
    });
  }
  let lastPick = 0;
  let lastClick = 0;
  let previewed = -1;

  // ───────────── lifecycle ─────────────

  function applySize(): void {
    const r = renderer, c = canvas;
    if (!r || !c) return;
    const w = layout.width || c.clientWidth || c.parentElement?.clientWidth || 1;
    const h = layout.height || c.clientHeight || c.parentElement?.clientHeight || 1;
    r.setChartCover(layout.chartCover);
    r.resize(w, h, win.devicePixelRatio || 1, { left: 0, right: layout.insetRight }, ui().breakpoint, ui().immersive);
  }

  /** Its own timer: debounced() keeps only the last call, and the colour and key updates of the same change must not cancel this one. */
  let rearrangeTimer: ReturnType<typeof setTimeout> | null = null;
  function rearrangeSoon(): void {
    if (rearrangeTimer !== null) clearTimeout(rearrangeTimer);
    rearrangeTimer = setTimeout(() => {
      rearrangeTimer = null;
      void arrange();
    }, 24);
  }

  function debounced(fn: () => void, ms = 60): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  }

  async function createRenderer(): Promise<boolean> {
    const c = canvas as HTMLCanvasElement;
    const s = services.settings.value;
    const stage = stageName();
    const r = new CortexRenderer({
      canvas: c,
      log: services.log,
      reducedMotion: reduced(),
      background: backgroundOf(stage, s.appearance.stage),
      pose: view().pose,
      stage,
      stageTint: s.appearance.stageTint,
      stageTheme: s.appearance.stage,
      win,
    });
    r.hazeKinds = HAZE_KINDS;
    r.on({
      frame: onFrame,
      status: (st, gov) => {
        status(st, gov);
      },
    });
    const ok = await r.init();
    if (!ok) {
      fallback = true;
      status("no-webgl");
      return false;
    }
    renderer = r;
    r.setEffectPalette(figurePalette(s.appearance));
    r.setView(view());
    applySize();
    r.start();
    if (appLocked.value) r.stop();
    return true;
  }

  function drawStill(): void {
    // The 2D fallback: the same points seen from the pose's home direction, drawn once per data change.
    const c = canvas, idx = services.index.index.value, p = placement;
    if (!c || !p || !idx) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const stage = stageName();
    const scene: FallbackScene = {
      pose: view().pose,
      stage,
      background: { stage: stageColours(services.settings.value.appearance.stage, stage).stage, lift: stageColours(services.settings.value.appearance.stage, stage).lift },
      points: { pos: p.anat, color: grouping?.color ?? new Uint8Array(idx.count * 4).fill(200), count: idx.count },
      haze: { pos: p.haze.pos, color: new Uint8Array(p.haze.count * 4).fill(150), count: p.haze.count },
    };
    c.width = Math.max(1, c.clientWidth);
    c.height = Math.max(1, c.clientHeight);
    drawFallback(ctx, scene, { width: c.width, height: c.height, insetLeft: 0, insetRight: layout.insetRight, breakpoint: ui().breakpoint }, 1);
  }

  function onPoolState(next: LeafRenderState): void {
    const prev = state;
    state = next;
    store.update("ui", { paused: next === "paused" });
    const r = renderer;
    if (next === "live" && prev !== "live") {
      if (r) {
        r.start();
        r.setSuspended(false);
        if (prev === "released") r.playIntro("return");
      } else if (canvas && !fallback) {
        void createRenderer().then((ok) => {
          if (ok) {
            if (canvas) canvas.style.backgroundImage = "";
            void place();
            renderer?.playIntro("return");
          }
        });
      }
    } else if (next === "paused" && r) {
      r.stop();
    } else if (next === "released" && r) {
      void r.snapshot(T.pool.stillScale).then((b) => {
        const reader = new FileReader();
        reader.onload = () => {
          stillUrl = String(reader.result ?? "");
          if (canvas) {
            canvas.style.backgroundImage = `url(${stillUrl})`;
            canvas.style.backgroundSize = "100% 100%";
          }
        };
        reader.readAsDataURL(b);
      }).catch(() => undefined).finally(() => {
        // Shown again before the still was taken: the pool already made this leaf live, so keep its renderer.
        if (state !== "released" || renderer !== r) return;
        r.releaseGpu();
        renderer = null;
      });
    }
  }

  function subscribeAll(): void {
    const first = new Set<string>();
    const sub = <S>(name: string, sig: { subscribe(fn: (v: S) => void): () => void }, fn: (v: S) => void): void => {
      offs.push(
        sig.subscribe((v) => {
          if (!first.has(name)) {
            first.add(name);
            return;
          }
          fn(v);
        }),
      );
    };
    // Cortex: Lock: the renderer stops while the lock screen covers the view and picks up again on unlock.
    sub("lock", appLocked, (locked) => {
      if (!renderer) return;
      if (locked) renderer.stop();
      else if (state === "live") renderer.start();
    });
    let prevView = view();
    sub("view", store.slices.view, (v) => {
      const p = prevView;
      prevView = v;
      renderer?.setView(v);
      if (v.pose !== p.pose || v.placement !== p.placement || v.core !== p.core || v.spineOrder !== p.spineOrder || JSON.stringify(v.layers) !== JSON.stringify(p.layers)) debounced(() => void place());
      else if (v.shape !== p.shape || v.groupBy !== p.groupBy || v.layout !== p.layout || v.chart !== p.chart || v.splitGroups !== p.splitGroups || v.groupByRecord !== p.groupByRecord || v.layoutOptions.gridMarks !== p.layoutOptions.gridMarks) {
        // The click shows on this frame: the points start toward the silhouette now and land when the worker replies.
        if (v.shape !== "body" && v.shape !== p.shape) {
          dropPendingTimer();
          pendingTimer = setTimeout(() => {
            pendingTimer = null;
            renderer?.beginPending();
          }, PENDING_DELAY_MS);
        }
        // A new Group by on the figure fades the body and brings the cord back first (the grouped shapes dissolve instead).
        if (v.shape === "body" && v.groupBy !== p.groupBy) renderer?.queryFade("group", true);
        rearrangeSoon();
      }
      if (v.colour !== p.colour || v.groupBy !== p.groupBy) debounced(() => void recolour());
      if (v.look.lines !== p.look.lines || stemsOn(v) !== stemsOn(p) || v.morph > BUNDLES_MORPH !== p.morph > BUNDLES_MORPH) void drawLines();
    });
    let prevScope = ui().scope;
    let prevUi = ui();
    sub("ui", store.slices.ui, (u) => {
      const old = prevUi;
      prevUi = u;
      if (u.scope !== prevScope) {
        const from = prevScope;
        prevScope = u.scope;
        if (u.scope !== "all") renderer?.flashScope();
        else if (from !== "all") {
          renderer?.swirlHome();
          renderer?.dollyHome();
        }
        const t = placement?.territories.find((x) => x.space === u.scope);
        if (t && renderer) renderer.turnTo(-(((t.phi0 + t.phi1) / 2) * 180) / Math.PI);
      }
      // A changed query or token set dips the figure and regrows it (cord first); the renderer debounces typing.
      // The kind grouping takes the T under an area, so it is laid out again when the area changes.
      if (u.scope !== old.scope && view().shape === "groups" && view().groupBy === "kind" && view().layout === "bubbles") rearrangeSoon();
      if (u.tokens !== old.tokens) renderer?.queryFade();
      if (u.tokens !== old.tokens || u.period !== old.period || u.scope !== old.scope || u.revealedCount !== old.revealedCount) {
        debounced(() => {
          // The key recounts over the lit set once it resolves (or without it when the tokens are gone).
          void resolveLit().then(() => recolour());
          if (u.revealedCount !== old.revealedCount) void place();
        }, 30);
      }
      if (u.hiddenGroups !== old.hiddenGroups || u.scope !== old.scope || u.period !== old.period || u.dimPreview !== old.dimPreview || u.dimPreviewPop !== old.dimPreviewPop) debounced(() => void recolour());
      if (u.preview !== old.preview || u.scope !== old.scope) refreshState(true);
      if ((u.preview?.kind === "area" ? u.preview.key : null) !== (old.preview?.kind === "area" ? old.preview.key : null)) recountLens();
      if (u.breakpoint !== old.breakpoint || u.immersive !== old.immersive) applySize();
      if (u.activeNote !== old.activeNote) setActiveNote();
    });
    sub("selection", store.slices.selection, () => {
      void resolveRelated();
      const o = store.get("selection")?.ordinal ?? -1;
      renderer?.setSelected(o);
      void drawLines();
      refreshState(true);
    });
    sub("settings", services.settings.signal, () => {
      renderer?.setStage(stageName(), services.settings.value.appearance.stageTint, services.settings.value.appearance.stage);
      renderer?.setEffectPalette(figurePalette(services.settings.value.appearance));
      renderer?.setReducedMotion(reduced());
      renderer?.setPointBudget(services.settings.value.advanced.pointBudget);
      debounced(() => void recolour(true));
    });
    sub("index", services.index.index, () => debounced(() => void place(), 20));
    // No record to show (empty, or it could not be read): the scatter gives way to the card or the error.
    sub("data", services.shared.slices.data, (d) => {
      if (d.phase === "empty" || d.phase === "error") renderer?.cancelFirstPaint();
    });
    offs.push(
      onEvent("stage:layout", (e: StageEvents["stage:layout"]) => {
        if (e.viewId !== viewId) return;
        const cover = { left: Math.max(0, Math.round(e.chartCover?.left ?? 0)), right: Math.max(0, Math.round(e.chartCover?.right ?? 0)) };
        const moved = layout.width !== e.width || layout.height !== e.height || layout.insetRight !== e.insetRight || layout.chartCover.left !== cover.left || layout.chartCover.right !== cover.right;
        layout = { width: e.width, height: e.height, insetRight: e.insetRight, chartCover: cover };
        applySize();
        // The figure shifts when a panel opens or closes: a tooltip pinned to the old spot would name a point that is no longer there.
        if (moved && store.get("hover")) store.update("hover", () => null);
        stageChanged();
      }),
      onEvent("canvas:resized", (e: { viewId: string; width: number; height: number; insetRight: number }) => {
        if (e.viewId !== viewId) return;
        const moved = layout.width !== e.width || layout.height !== e.height || layout.insetRight !== e.insetRight;
        layout = { width: e.width, height: e.height, insetRight: e.insetRight, chartCover: layout.chartCover };
        applySize();
        // The figure shifts when a panel opens or closes: a tooltip pinned to the old spot would name a point that is no longer there.
        if (moved && store.get("hover")) store.update("hover", () => null);
        stageChanged();
      }),
      onEvent("intro:play", (e: { viewId: string; reason: string }) => {
        if (e.viewId !== viewId) return;
        // Showcase mode: the scatter turns into the figure again (nothing to turn with no cloud: the cord-first growth plays).
        if (e.reason === "first-paint" && renderer?.startFirstPaint({ replay: true })) return;
        renderer?.playIntro(e.reason === "rebuild" ? "rebuild" : "intro");
      }),
      onEvent("camera:move", (e: { viewId: string; legs: CameraMoveLeg[] }) => {
        if (e.viewId !== viewId || !renderer) return;
        const fig = renderer.figureBounds();
        renderer.flyLegs(
          e.legs.map((l) => {
            const { at, distance, ...rest } = l;
            let target: [number, number, number] | undefined;
            if (at === "brain") target = [...fig.brainCentre];
            else if (at === "figure") target = [...fig.centre];
            else if (at === "neck") target = [0, 1, 2].map((k) => (fig.brainCentre[k] as number) * 0.55 + (fig.centre[k] as number) * 0.45) as [number, number, number];
            else if (typeof at === "object" && placement) {
              const o = at.ordinal;
              const p = [placement.anat[o * 3], placement.anat[o * 3 + 1], placement.anat[o * 3 + 2]] as number[];
              if (p.every((x) => Number.isFinite(x))) target = [p[0] as number, p[1] as number, p[2] as number];
            }
            return { ...rest, ...(distance !== undefined ? { distanceFactor: distance } : {}), ...(target ? { target } : {}) };
          }),
        );
      }),
      onEvent("camera:save", (e: { viewId: string }) => {
        if (e.viewId === viewId && renderer) savedPose = renderer.cameraPose();
      }),
      onEvent("camera:restore", (e: { viewId: string }) => {
        // Showcase mode ended while the cold open's scatter was still on screen: it leaves, and the figure is there as it was.
        if (e.viewId === viewId && renderer?.firstPaintActive()) renderer.cancelFirstPaint();
        if (e.viewId !== viewId || !renderer || !savedPose) return;
        renderer.restoreCameraPose(savedPose);
        savedPose = null;
      }),
      onEvent("camera:fly-to", (e: { viewId: string; ordinal?: number; home?: true }) => {
        if (e.viewId !== viewId || !renderer || !placement) return;
        if (e.home) renderer.home();
        else if (e.ordinal !== undefined) {
          const o = e.ordinal;
          renderer.flyTo([placement.anat[o * 3] as number, placement.anat[o * 3 + 1] as number, placement.anat[o * 3 + 2] as number]);
        }
      }),
      onEvent("stage:turn", (e: StageEvents["stage:turn"]) => {
        if (e.viewId === viewId) renderer?.turnTo(-e.needleDeg);
      }),
      onEvent("stage:restart", (e: StageEvents["stage:restart"]) => {
        if (e.viewId !== viewId || !canvas) return;
        renderer?.dispose();
        renderer = null;
        fallback = false;
        void createRenderer().then((ok) => ok && void place());
      }),
      onEvent("palette:changed", () => debounced(() => void recolour(true))),
      onEvent("index:delta", () => debounced(() => void place(), 20)),
      onEvent("index:patched", () => debounced(() => void recolour(true))),
      onEvent("arrivals", () => debounced(() => void place(), 20)),
    );
    offs.push(services.renderers.onChange(viewId, onPoolState));
    offs.push(
      services.renderers.onFocus((id) => {
        const focused = id === viewId;
        renderer?.setSuspended(!focused);
        renderer?.setMaxFps(focused ? 0 : T.motion.unfocusedFps);
      }),
    );
  }

  function setActiveNote(): void {
    const id = ui().activeNote;
    renderer?.setActive(id ? services.index.ordinalOf(id) : -1);
  }

  return {
    get renderer() {
      return renderer;
    },
    async attach(c, overlayHost) {
      if (attached) return;
      attached = true;
      canvas = c;
      host = overlayHost;
      win = c.ownerDocument.defaultView ?? window;
      state = services.renderers.request(viewId);
      store.update("ui", { paused: state === "paused" });
      subscribeAll();
      wirePointer(c);
      const parent = c.parentElement;
      if (parent && typeof ResizeObserver !== "undefined") {
        // Applied on the next frame so resizing inside the callback never trips "ResizeObserver loop completed".
        let resizeFrame = 0;
        ro = new ResizeObserver(() => {
          if (resizeFrame) return;
          resizeFrame = win.requestAnimationFrame(() => {
            resizeFrame = 0;
            layout = { ...layout, width: parent.clientWidth, height: parent.clientHeight };
            applySize();
          });
        });
        ro.observe(parent);
      }
      const doc = c.ownerDocument;
      const vis = (): void => services.renderers.setVisible(viewId, doc.visibilityState === "visible");
      doc.addEventListener("visibilitychange", vis);
      offs.push(() => doc.removeEventListener("visibilitychange", vis));
      if (state === "paused") return;
      const ok = await createRenderer();
      if (!ok) {
        drawStill();
        return;
      }
      setActiveNote();
      // Every opening of the view starts on the scattered side-view brain; place() turns it into the figure once the record is read.
      if (!appLocked.value && !attachedOnce && renderer?.startFirstPaint()) {
        const phase = services.shared.slices.data.value.phase;
        if (phase === "empty" || phase === "error") renderer.cancelFirstPaint();
      }
      if (services.index.index.value) await place();
    },
    detach() {
      if (!attached) return;
      attached = false;
      if (timer) clearTimeout(timer);
      if (restTimer !== null) clearTimeout(restTimer);
      restTimer = null;
      if (hubTimer !== null) clearTimeout(hubTimer);
      hubTimer = null;
      if (stageTimer !== null) clearTimeout(stageTimer);
      stageTimer = null;
      if (rearrangeTimer !== null) clearTimeout(rearrangeTimer);
      rearrangeTimer = null;
      if (prewarmTimer !== null) clearTimeout(prewarmTimer);
      prewarmTimer = null;
      dropPendingTimer();
      stopSway();
      clearSprayTimer();
      hubHover = null;
      hubWant = -1;
      ro?.disconnect();
      for (const f of offs.splice(0)) f();
      services.renderers.release(viewId);
      services.worker.dropView(viewId);
      renderer?.dispose();
      renderer = null;
      void host;
      canvas = null;
      host = null;
    },
    home() {
      renderer?.home();
    },
    async savePicture() {
      const r = renderer;
      if (!r) return null;
      return renderPicture(r, host);
    },
  };
}

// ───────────── small pure helpers ─────────────

const SPACES: readonly string[] = ["code", "web", "data", "ai", "roblox", "games", "money", "design", "life", "vault", "none"];

/**
 * Where the standing figure really is on screen, for the label columns: its centre line, the pixels of one scene unit across
 * the brain (along the camera's right axis, so a turned figure still gets the right margin) and the y of the brain's lowest edge.
 */
function figureColumns(camera: import("three").Camera, w: number, h: number): { cx: number; pxPerUnit: number; brainBottom: number } | null {
  const e = camera.matrixWorld.elements;
  const a = projectPoint(0, 4, 0.06, camera, w, h);
  const b = projectPoint(e[0] as number, 4 + (e[1] as number), 0.06 + (e[2] as number), camera, w, h);
  const low = projectPoint(0, 2.74, 0, camera, w, h);
  if (!a || !b || !low) return null;
  return { cx: a.x, pxPerUnit: Math.hypot(b.x - a.x, b.y - a.y), brainBottom: low.y };
}

function projectPoint(x: number, y: number, z: number, camera: import("three").Camera, w: number, h: number): { x: number; y: number; z: number } | null {
  const m = camera.matrixWorldInverse.elements;
  const p = camera.projectionMatrix.elements;
  const vx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  const vy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  const vz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  const cx = p[0]! * vx + p[4]! * vy + p[8]! * vz + p[12]!;
  const cy = p[1]! * vx + p[5]! * vy + p[9]! * vz + p[13]!;
  const cw = p[3]! * vx + p[7]! * vy + p[11]! * vz + p[15]!;
  if (!(cw > 0)) return null;
  const nz = (p[2]! * vx + p[6]! * vy + p[10]! * vz + p[14]!) / cw;
  return { x: ((cx / cw) * 0.5 + 0.5) * w, y: (-(cy / cw) * 0.5 + 0.5) * h, z: nz };
}

/** An OKLCH-ish tint colour for the haze at a hue (degrees): a soft mid-lightness swatch. */
/** The canvas clear colour (0 to 1) of the stage in force: Paper or Ink, or a Cortex theme's own ground. */
function backgroundOf(stage: "ink" | "paper", theme: StageId): [number, number, number] {
  const [r, g, b] = hexToRgb(stageColours(theme, stage).stage);
  return [r, g, b];
}

function hueRgb(hue: number, stage: "ink" | "paper"): [number, number, number] {
  const L = stage === "paper" ? 0.5 : 0.78;
  const C = 0.08;
  const a = C * Math.cos((hue * Math.PI) / 180), b = C * Math.sin((hue * Math.PI) / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const enc = (c: number): number => Math.round(255 * Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)));
  return [enc(lin[0]!), enc(lin[1]!), enc(lin[2]!)];
}

export type { Pose };
