/**
 * UI state shapes. FROZEN CONTRACT (owner: architect; implementation in store.ts by E7).
 *
 * Two stores (H6):
 *  - one LEAF store per Cortex tab (CortexView calls services.createLeaf()): shape, colours, layers, scope,
 *    period, query tokens, selection, camera, sheet stack, command line. Persisted per leaf through
 *    getState/setState (LeafPersistedState); localStorage only seeds new leaves.
 *  - one SHARED store in the service container: data status, activity (runner, agents, engine), work queues and
 *    changes (receipts). Every leaf reads it.
 *
 * The status model is three separate parts (H4, CORTEX-UX §0 item 5): removable query tokens (OR within a kind,
 * AND across kinds), a separately selected item that survives tokens, and a per-view period (null = All time).
 */
import { DEFAULT_LAYOUT_OPTIONS, type DimId, type GroupLayout, type LayoutOptions } from "../shared/dims";
import type { ColourMode, LegendModel, QueryToken, TimeWindow, Vec3, ChartSpec } from "../shared/protocol/worker";
import type { EngineState, PendingGroup } from "../shared/protocol/runner";
import { emptyPlanViews, type PlanWindowId, type PlanWindowView } from "../shared/planLimits";
import type { CortexSettings, LinesMode, NamesMode, Pose } from "../shared/settings";
import type { ReceiptState, SpaceId } from "../shared/types";
import type { PageId, SheetEntry, SheetPageRoute, ShapeKind } from "../shared/views";

// ───────────────────────────── per-leaf view controls ─────────────────────────────

export interface Layers {
  notes: boolean;
  vaultNotes: boolean;
  /** Reference material (status: reference notes + reference documents); starts from settings.general.showReference. */
  reference: boolean;
  maps: boolean;
  record: boolean;
  undatedCloud: boolean;
  /** Your exchanges with Ask (count shown in the tooltip only). */
  askHistory: boolean;
  subagents: boolean;
  automated: boolean;
  haze: boolean;
}

/** The Display popover's Speed slider range (0 = still, 200%). */
export const MOTION_SPEED_RANGE = [0, 2] as const;

/** The Brain outline slider: 0 (the haze is off) to 150% of the anatomy haze's resting opacity. */
export const OUTLINE_RANGE = [0, 1.5] as const;

/** Which names the figure prints: every group, only what is lit (traced, previewed or pointed at), or only what is hovered. */
export type NamesFor = "everything" | "lit" | "hovered";
export const NAMES_FOR: readonly NamesFor[] = ["everything", "lit", "hovered"];
/** How many names the Groups shape prints: Auto declutters, Few caps at the largest dozen, All prints every one. */
export type NamesDensity = "auto" | "few" | "all";
export const NAMES_DENSITY: readonly NamesDensity[] = ["auto", "few", "all"];

/** The anatomy haze's opacity factor: 0 while the layer is off, else the Brain outline (1 = the resting opacity). */
export function hazeScale(layers: { haze: boolean }, look: { outline?: number }): number {
  if (!layers.haze) return 0;
  const o = look.outline;
  return typeof o === "number" && Number.isFinite(o) ? Math.max(OUTLINE_RANGE[0], Math.min(OUTLINE_RANGE[1], o)) : 1;
}

export interface MotionControls {
  /** Drift = sway (lying default), Spin = full turn (standing default). */
  mode: "drift" | "spin" | "off";
  /** Motion speed as a multiplier, 0 (still) to 2 (200%); 1 = 100%. */
  speed: number;
  pauseWhilePointing: boolean;
  /** Clamp orbit to ±50° yaw, ±30° pitch about the home view; on automatically for flat charts. */
  keepUpright: boolean;
}

export interface LookControls {
  dotSize: number;
  glow: number;
  brightness: number;
  /** Distance from each point's slot centre (50–150%). */
  scatter: number;
  names: NamesMode;
  lines: LinesMode;
  /** Strength of the faint line along each conversation's messages, 0 (off) to 1; saved views from before it was a number migrate true to STEM_ON_STRENGTH. */
  stemStrength: number;
  /** Names drawn over each group in Groups shapes. */
  groupLabels: boolean;
  /** Idle twinkle of the points (off under reduced motion). */
  shimmer: boolean;
  /** Anatomy haze strength as a fraction of its resting opacity, 0 (haze off) to 1.5; 1 = 100%. */
  outline: number;
  /** Names for: every group, what is lit, or only what is hovered (Groups shape). */
  namesFor: NamesFor;
  /** Names density: Auto, Few or All. */
  density: NamesDensity;
}

/** Stem strength a view had when stems were simply "on". */
export const STEM_ON_STRENGTH = 0.1;
/** Which end of the spine sits against the brain: the oldest entries (default) or the newest. */
export type SpineOrder = "oldest-at-brain" | "newest-at-brain";
export const SPINE_ORDERS: readonly SpineOrder[] = ["oldest-at-brain", "newest-at-brain"];

export interface ColourControls {
  notes: ColourMode;
  record: ColourMode;
  /** "Same colour for both": one dimension colours everything. */
  same: boolean;
  fold: boolean;
  hideNoValue: boolean;
}

export interface ViewControls {
  shape: ShapeKind;
  /** 0 = body … 1 = target shape. The shape slider drives this directly (scrubbable). */
  morph: number;
  groupBy: DimId;
  layout: GroupLayout;
  placement: "area" | "role";
  core: "oldest" | "newest" | "largest";
  pose: Pose;
  colour: ColourControls;
  layers: Layers;
  motion: MotionControls;
  look: LookControls;
  /** The leaf's chart (Chart shape and the Chart page). */
  chart: ChartSpec | null;
  /** Spine direction; no consumer yet. */
  spineOrder: SpineOrder;
  /** Dimension that groups the record entries; null = the same as the notes' groupBy. */
  groupByRecord: DimId | null;
  /** Notes and record entries are grouped by their own dimensions (off: groupByRecord is null). */
  splitGroups: boolean;
  /** Key rows follow the groups shown on the figure. */
  syncKeyToGroups: boolean;
  /** Layout-specific options (the Month grid's marks: spheres or dash rows). */
  layoutOptions: LayoutOptions;
}

/** Defaults for a new leaf, seeded from the global settings (per-view toggles then override them). */
export function defaultView(settings?: Pick<CortexSettings, "general" | "appearance">): ViewControls {
  const pose = settings?.general.pose ?? "standing";
  return {
    shape: "body",
    morph: 0,
    groupBy: "space",
    layout: "bubbles",
    placement: "area",
    core: "oldest",
    pose,
    colour: { notes: { kind: "categorical", dim: "space" }, record: { kind: "age" }, same: false, fold: true, hideNoValue: false },
    layers: {
      notes: true,
      vaultNotes: true,
      reference: settings?.general.showReference ?? false,
      maps: true,
      record: true,
      undatedCloud: true,
      askHistory: false,
      subagents: false,
      automated: false,
      haze: true,
    },
    motion: { mode: pose === "lying" ? "drift" : "spin", speed: 1, pauseWhilePointing: false, keepUpright: false },
    look: {
      dotSize: settings?.appearance.dotSize ?? 1,
      glow: settings?.appearance.glow ?? 1,
      brightness: settings?.appearance.brightness ?? 1,
      scatter: 1,
      names: settings ? (settings.appearance.namesOnFigure === "always" || (settings.appearance.namesOnFigure !== "off" && settings.appearance.namesAtRest) ? "always" : settings.appearance.namesOnFigure) : "hover",
      lines: settings?.appearance.lines ?? "selection",
      stemStrength: settings?.appearance.stems ? STEM_ON_STRENGTH : 0,
      groupLabels: true,
      shimmer: true,
      outline: 1,
      namesFor: "everything",
      density: "auto",
    },
    chart: null,
    spineOrder: "oldest-at-brain",
    groupByRecord: null,
    splitGroups: false,
    syncKeyToGroups: false,
    layoutOptions: { ...DEFAULT_LAYOUT_OPTIONS },
  };
}

export const DEFAULT_VIEW: ViewControls = defaultView();

// ───────────────────────────── per-leaf UI ─────────────────────────────

export type Breakpoint = "XL" | "L" | "M" | "S" | "Mini";

export interface SheetState {
  open: boolean;
  /** 340–560, default 400; stored per leaf. */
  width: number;
  /** Back stack (≤ 12 entries); `index` is the current entry (forward history after it). */
  stack: SheetEntry[];
  index: number;
  /** The Chart page folded to its header bar, or any other page reduced to a vertical edge tab; per leaf, not saved. */
  collapsed?: boolean;
  /** Which edge the sheet docks to; unset = the first page's own default (Read on the left, the rest on the right). Per leaf, not saved. */
  side?: SheetSide;
  /** The Chart page floats as a left card over the full-width stage (the setting Appearance › Chart panel as a floating card); mirrored from the settings, per leaf, not saved. */
  float?: boolean;
  /** Which edge each page docks to at XL and L (the dock button in a page's header); remembered per page and saved with the leaf. */
  docks?: Partial<Record<SheetPageRoute, SheetSide>>;
  /** With a reader in the opposite column, the page is parked as a slim vertical tab at its edge; per leaf, not saved. */
  parked?: boolean;
  /**
   * A rail click that opens a page while another page stands on the left parks that page as a slim vertical tab at its edge:
   * its whole back stack (so its reader, scroll and selection come back with it) and the edge it sat on. The page now open
   * takes the opposite edge; the tab swaps them. Per leaf, not saved.
   */
  stash?: { stack: SheetEntry[]; index: number; side: SheetSide };
  /** The floating Chart card stays open beside the page on the stack (it opened while the page was there, or the page opened while it was); per leaf, not saved. */
  card?: boolean;
}

export type SheetSide = "left" | "right";

/** What the sheet is previewing without touching its stack: a map the pointer rests on while another map is open. Never saved. */
export type SheetPreview = { kind: "map"; ordinal: number };

export interface CommandState {
  mode: "find" | "ask";
  text: string;
  resultsOpen: boolean;
  consoleOpen: boolean;
  consolePinned: boolean;
  /** Ask console thread id (one conversation under .raw/chats/cortex-ask/). */
  threadId: string | null;
}

export type PopoverId = "display" | "key" | "layers" | "period" | "themes";

export interface UiState {
  tab: PageId;
  sheet: SheetState;
  scope: SpaceId | "all";
  /** null = All time. */
  period: TimeWindow | null;
  tokens: QueryToken[];
  command: CommandState;
  popover: PopoverId | null;
  keyCollapsed: boolean;
  /** Left rail: "All pages" (on by default) lists every destination flat; off keeps the short list with More. */
  navFull: boolean;
  /** Left rail, short list: the "More" group is expanded. */
  navMore: boolean;
  immersive: boolean;
  breakpoint: Breakpoint;
  /** Hidden key groups as "dim=value". */
  hiddenGroups: string[];
  /** Hovering a strip bar, key chip or compass segment previews its members (others at 35%). */
  preview: { kind: "group" | "period" | "area"; key: string; /** The rail wordmark's lens: others fade to ~6% (not 35%). */ strong?: boolean } | null;
  /** Hovering a dimension in the dimension menu previews it on the figure; never saved. */
  dimPreview: DimId | null;
  /** Which population the dimension preview recolours (the key bar's Brain or Spine row; "both" = the shared row). */
  dimPreviewPop: "notes" | "record" | "both";
  /** The date span of the chart cell under the pointer (the time strip draws a brush marker for it); null when none. */
  hoverRange: [number, number] | null;
  /** Id of the note open in Obsidian's editor ("Follow the active note"); drawn with an accent ring. */
  activeNote: string | null;
  /** Held arrivals: ordinals ≥ revealedCount exist in the shared index but are not shown in this leaf yet. */
  revealedCount: number;
  /** Paused by the renderer pool (more than 3 live leaves): the still frame is shown. */
  paused: boolean;
  /** Transient entry the sheet shows in place of the open map reader (hovering another map on the stage); null when none. */
  sheetPreview: SheetPreview | null;
}

/** The selected item survives token changes; clicking empty stage clears it but keeps the tokens. */
export type Selection = { ordinal: number; id: string } | null;

export interface HoverState {
  ordinal: number;
  /** Pointer position in canvas CSS px. */
  x: number;
  y: number;
  /** Set when the pointer is on a line, not a point: the line family and the far end's ordinal. */
  line?: { family: "source" | "stem" | "spoke"; target: number };
}

export interface CameraPose {
  yawDeg: number;
  pitchDeg: number;
  /** Multiple of the home distance (0.15–4). */
  distance: number;
  target: Vec3;
}

export interface LeafSlices {
  ui: UiState;
  view: ViewControls;
  selection: Selection;
  hover: HoverState | null;
  legend: LegendModel | null;
  /** Lit count of the current tokens ("214 lit"). */
  lit: number | null;
  /** The key's counts restricted to an area while the rail wordmark's lens (an area preview) holds it; null otherwise. */
  lens: { area: string; legend: LegendModel } | null;
}

export function defaultUi(): UiState {
  return {
    tab: "brain",
    sheet: { open: false, width: 400, stack: [], index: -1 },
    scope: "all",
    period: null,
    tokens: [],
    command: { mode: "find", text: "", resultsOpen: false, consoleOpen: false, consolePinned: false, threadId: null },
    popover: null,
    keyCollapsed: false,
    navFull: true,
    navMore: false,
    immersive: false,
    breakpoint: "XL",
    hiddenGroups: [],
    preview: null,
    dimPreview: null,
    dimPreviewPop: "both",
    hoverRange: null,
    activeNote: null,
    revealedCount: 0,
    paused: false,
    sheetPreview: null,
  };
}

export const DEFAULT_UI: UiState = defaultUi();

/**
 * What a leaf persists through getState/setState (CORTEX-UX §2.2): shape, morph, colours, layers, motion, look,
 * scope, period, camera pose, sheet stack (pages and reader ids), sheet width, key collapsed, query tokens.
 */
export interface LeafPersistedState {
  v: 1;
  tab: PageId;
  view: ViewControls;
  scope: SpaceId | "all";
  period: TimeWindow | null;
  camera?: CameraPose;
  sheet: { stack: SheetEntry[]; index: number; width: number; open: boolean; docks?: Partial<Record<SheetPageRoute, SheetSide>> };
  keyCollapsed: boolean;
  tokens: QueryToken[];
  /** Left rail toggles (absent in states saved before the rail existed). `navAll` replaced the first build's `navFull`,
   *  which saved the old short-list default before anyone chose it, so that key is ignored. */
  navAll?: boolean;
  navMore?: boolean;
  /** Values hidden from the stage ("dim=value" keys); absent when nothing is hidden. */
  hidden?: string[];
}

// ───────────────────────────── shared state ─────────────────────────────

export interface DataStatus {
  phase: "idle" | "loading" | "ready" | "empty" | "error";
  /** 0..1 while loading. */
  progress: number;
  /** Copy key (ui/copy.ts) for the stage line, never free text. */
  messageKey?: string;
  /** The index could not be built or loaded (CORTEX-UX 5.31): "last-good" while an earlier index is shown, "none" when there is none. Absent when healthy. */
  failure?: "last-good" | "none";
  seq: number;
  epoch: string;
  notes: number;
  record: number;
  /** Items in the shared index (leaves reveal up to this count). */
  available: number;
}

export interface ActivityJob {
  id: string;
  /** JobKind or "import" / "index". */
  kind: string;
  phase: string;
  done: number;
  total?: number;
}

export interface ActivityState {
  jobs: ActivityJob[];
  tokensToday: number;
  /** Dollars spent today at API list prices (shown, never a limit). */
  usdToday: number;
  /** The Claude plan's 5-hour and weekly windows: use so far, the cap set for each, and when each resets. */
  plan: Record<PlanWindowId, PlanWindowView>;
  capped: boolean;
  paused: boolean;
  runner: "starting" | "child" | "worker" | "inline" | "unavailable" | "stopped";
  engine: EngineState;
  /** When agents resume after a usage limit or a retry wait. */
  resumeAt?: string;
  /** Import progress for the status bar ("importing 63%"). */
  importing?: { done: number; total?: number; /** Messages kept so far (Claude Code first import: "‹m› messages kept"). */ kept?: number };
  /** Warning code (protocol/runner.ts) of the last problem, rendered from the copy catalogue. */
  lastWarning?: string;
  /** Settings could not be trusted (SAFE-08): background work is off until the user resolves it. */
  settingsCorrupt: boolean;
}

/** Work remaining per queue (ORIG-11): "Label: 1,284 conversations waiting · Summaries: 46 · Your checks: 63". */
export interface QueueState {
  label: number;
  summaries: number;
  maps: number;
  checks: number;
  /** Per source: done / waiting / checked (stacked bar on Agents). */
  bySource: Record<string, { done: number; waiting: number; checked: number }>;
  /** What the waiting label, summary and map work is, biggest group first (from the planner; empty when unknown). */
  groups?: PendingGroup[];
}

export interface ReceiptView {
  id: string;
  askId: string;
  action: string;
  /** Written by Cortex from validated params (never model text). */
  summary: string;
  /** The model's reason, labelled as the AI's when shown. */
  reason?: string;
  state: ReceiptState;
  canUndo: boolean;
  needsApply: boolean;
  spendsBudget: boolean;
  /** Token and item estimate Cortex computed for spendsBudget actions. */
  estimate?: { tokens: number; items: number };
  at: string;
}

export interface SharedSlices {
  data: DataStatus;
  activity: ActivityState;
  queues: QueueState;
  receipts: ReceiptView[];
}

export function defaultShared(): SharedSlices {
  return {
    data: { phase: "idle", progress: 0, seq: 0, epoch: "", notes: 0, record: 0, available: 0 },
    activity: { jobs: [], tokensToday: 0, usdToday: 0, plan: emptyPlanViews(), capped: false, paused: false, runner: "stopped", engine: "ok", settingsCorrupt: false },
    queues: { label: 0, summaries: 0, maps: 0, checks: 0, bySource: {} },
    receipts: [],
  };
}
