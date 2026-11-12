/**
 * Plugin (main thread) ↔ layout worker protocol. FROZEN CONTRACT (owner: architect).
 *
 * Transport: a classic Web Worker created from a Blob URL of the inlined worker bundle. Fallback: the same
 * handler runs on the main thread in time-sliced chunks with identical messages.
 * RPC: { t:"call", id, viewId, method, params } → { t:"result", id, ok, ... } with optional { t:"progress" }.
 * One worker serves every Cortex leaf: the index is shared, per-view results (placement, arrangement) are
 * cached per `viewId`, and stale calls are cancelled latest-wins per (viewId, method) (H6).
 *
 * Transfers (TRANSFER-DETACH): a buffer is transferred only when the typed array owns ALL of it
 * (byteOffset === 0 && byteLength === buffer.byteLength) and it is not state-owned (the worker's decoded index
 * and anatomy buffers are registered in a WeakSet). Anything else is replaced by a copy (`view.slice()`) before
 * posting. Results must own their buffers. The plugin sends `loadIndex` a COPY of the file buffer
 * (`buf.slice(0)`) and never transfers the buffer it decoded for tooltips and readers.
 */
import type { DimId, GroupLayout, LayoutOptions } from "../dims";
import type { AgeColours, PaletteId, Pose } from "../settings";
import type { IsoDate, SpaceId } from "../types";
import type { ChartId } from "../views";
import type { ChartStage } from "../chartStage";

// ───────────────────────────── shared pieces ─────────────────────────────

export type Vec3 = [number, number, number];
/** Epoch ms [t0, t1]. */
export type TimeWindow = [number, number];

/** Display-time merge mapping (global merge-groups corrections): dim → (from value → into value). */
export type MergeMap = Record<string, Record<string, string>>;

/** What the leaf shows (Layers menu + scope + period). Per-view toggles start from the global settings. */
export interface VisibilityParams {
  scope: SpaceId | "all";
  /** null = All time. Body dims points outside it to 6%; Groups and Chart give them a NaN target. */
  period: TimeWindow | null;
  notes: boolean;
  vaultNotes: boolean;
  maps: boolean;
  record: boolean;
  undatedCloud: boolean;
  reference: boolean;
  askHistory: boolean;
  subagents: boolean;
  automated: boolean;
  /** Ordinals ≥ this are held arrivals not yet shown in this leaf (H6). */
  revealedCount: number;
}

/**
 * One removable query token (CORTEX-UX §5.9). Tokens of the same kind are OR-ed; different kinds are AND-ed.
 * `set` tokens carry stable ids (Ask result sets, chart highlights); the worker maps them to ordinals.
 */
export type QueryTokenKind = "text" | "group" | "time" | "band" | "set";
export interface QueryToken {
  id: string;
  kind: QueryTokenKind;
  label: string;
  text?: string;
  dim?: DimId;
  value?: string;
  range?: TimeWindow;
  /** A time/band range that lights only record entries (the days you wrote), not notes dated in it. */
  recordsOnly?: boolean;
  ids?: string[];
}

// ───────────────────────────── placement (anatomy slots) ─────────────────────────────

/** CORTEX-UX §6 is normative for every number used by placement and the renderer (H8). */
export interface PlacementParams {
  seed: number;
  pose: Pose;
  /** Brain territories by area wedges, or by the placement pack's role → region. */
  placement: "area" | "role";
  /** At the core: oldest notes deepest (default), newest deepest, or largest first. */
  order: "oldest" | "newest" | "largest";
  /** Vault notes use their `layer` (0–8) as the depth key; machine notes use time. */
  depthKey: "time" | "layer";
  /** Territory exponent γ (count^γ); 0.6. */
  gamma: number;
  visibility: VisibilityParams;
  /** Incremental mode: keep existing slots for ordinals < fromCount, place only new ones. */
  fromCount?: number;
  /** Direction of time down the spine (view.spineOrder); missing = oldest at the brain. */
  spineOrder?: SpineOrderParam;
  /** colours.json `space` slots; territories run in slot order (CORTEX-UX §6.3). */
  areaSlots?: Readonly<Record<string, number>>;
}

export type HazeKind = "brain" | "nerve" | "thread" | "ring" | "brainstem" | "undated" | "body" | "neck";
export const HAZE_KINDS: readonly HazeKind[] = ["brain", "nerve", "thread", "ring", "brainstem", "undated", "body", "neck"];

/** Which way the spine's time runs on the body figure: oldest under the brain (default) or newest under it. */
export type SpineOrderParam = "oldest-at-brain" | "newest-at-brain";

export interface Territory {
  space: SpaceId;
  /** Azimuth range of the wedge (radians, figure-local). The compass ring draws exactly these. */
  phi0: number;
  phi1: number;
  notes: number;
}

/** A brain region's name at its cluster centroid (Placement › By role): the stage draws it boxed, with a drop line. */
export interface RegionLabel {
  text: string;
  pos: Vec3;
  kind: "region";
  /** Lower-case region id (copy key under regions.*). */
  key: string;
}

/** Marks and labels of the record family in a split Groups layout carry this key prefix (the notes' keys stay as they are). */
export const RECORD_MARK_PREFIX = "record:";

export interface PlacementResult {
  /** Body position per item (3 floats). NaN for items not placed. */
  anat: Float32Array;
  /** Birth time in the intro, seconds (0..3.6). */
  birth: Float32Array;
  /** Base sprite size multiplier per item. */
  size: Float32Array;
  /** Brain region per item (RegionId), 255 for record items. */
  region: Uint8Array;
  /** Spine position τ per record entry (NaN for notes and undated entries): age colour + the unrolled spine. */
  tau: Float32Array;
  /** Decorative haze points (not pickable); kind indexes HAZE_KINDS. */
  haze: { pos: Float32Array; kind: Uint8Array; birth: Float32Array; count: number; /** Optional per-point brightness multiplier (the cord thread follows the activity of each period). */ bright?: Float32Array; /** Optional spine position τ (0 oldest … 1 newest, as the record entries' own τ) of each point on the cord, NaN elsewhere: the cord thread takes the spine's colours by it. */ tau?: Float32Array };
  /** Local centre each point scatters from (Scatter slider), 3 floats per item. */
  centre: Float32Array;
  territories: Territory[];
  bounds: { min: Vec3; max: Vec3 };
  slotsKey: string;
  /** Role placement only: one label per used brain region, at the region's centroid. */
  labels?: RegionLabel[];
}

// ───────────────────────────── colouring (sticky slots + key) ─────────────────────────────

/** How one population is coloured (CORTEX-UX §4.4–4.5, §5.3). */
export type ColourMode =
  | { kind: "categorical"; dim: DimId }
  | { kind: "age" }
  /** One colour for the whole population: a palette slot, or any colour when `hex` ("#rrggbb") is set. */
  | { kind: "single"; slot: number; hex?: string };

export interface GroupingParams {
  notes: ColourMode;
  record: ColourMode;
  /** Fold groups beyond 8 hues into Other (mist); off lists them separately in the key, still drawn as Other. */
  fold: boolean;
  /** Hide items without a value (they fade to 0). */
  hideNoValue: boolean;
  hiddenGroups: string[];
  merges: MergeMap;
  palette: PaletteId;
  light: boolean;
  /** Age colouring (Settings > Appearance); absent = the ramp's own hues. Draws the key's gradient, never the figure under a colour theme. */
  age?: { mode: AgeColours; tintHue: number | null; chroma: number };
  /**
   * A figure colour theme (shared/colourTheme.ts): the palette and age ramp the figure's particles are drawn with instead
   * of `palette` and `age`. The key's rows, swatches and gradient keep the own ones, so the legend never follows a pick.
   */
  figure?: { palette: PaletteId; age: { mode: AgeColours; tintHue: number | null; chroma: number } };
  /** Persisted sticky slots (colours.json): dim → value → slot 1..8. */
  slots: Record<string, Record<string, number>>;
  visibility: VisibilityParams;
  /**
   * The lit set (1 per ordinal) while a token or a traced set is active: the key then counts only these items and lists
   * only the groups that have some. Absent or null = nothing narrows the key.
   */
  lit?: Uint8Array | null;
}

export interface LegendRow {
  key: string;
  name: string;
  /** 1..8 palette slot; 0 for the Other and No value buckets. */
  slot: number;
  bucket: "value" | "other" | "none";
  rgb: [number, number, number];
  notes: number;
  record: number;
  hidden: boolean;
  depth: number;
  expandable: boolean;
  /** A year row of the month tree: not a group of its own, it hides, shows and counts its months. */
  aggregate?: boolean;
  parentKey?: string;
  /** The no-value row while "Hide unsorted" is on: its items are off the figure, so the list draws it struck (it is not a hidden group). */
  dropped?: boolean;
}

/** A subfolder row under an Area or Folder group (the key's expansion of a selected group). */
export interface LegendChild {
  key: string;
  name: string;
  notes: number;
  record: number;
  /** The first row: members that sit directly in the group (no subfolder); it repeats the group's name. */
  direct?: boolean;
}

export interface LegendSection {
  population: "notes" | "record" | "both";
  dim: DimId | "age" | "single";
  rows: LegendRow[];
  /** Area and Folder dimensions: each group's subfolders by count, largest first (the direct row leads). */
  children?: Record<string, LegendChild[]>;
  /** Age mode: the ramp shown as a gradient with its first month and "today". */
  gradient?: { stops: string[]; from: number; to: number; undated: number };
  total: number;
}

export interface LegendModel {
  sections: LegendSection[];
  grandTotal: number;
  /** Set while the key is narrowed to a lit set: the number of lit items (the key shows one total, "N lit"). */
  lit?: number;
}

export interface GroupingResult {
  /** RGBA8 per item. */
  color: Uint8Array;
  /** Group row index per item within its section (NONE32 when not visible). */
  groupOf: Uint32Array;
  legend: LegendModel;
  /** Values that received a slot for the first time; the plugin persists them to colours.json. */
  newSlots: Record<string, Record<string, number>>;
}

// ───────────────────────────── arrangements & charts ─────────────────────────────

export interface AxisSpec {
  dim: DimId;
  /** Small sort toggle on the axis (CORTEX-UX §5.28). */
  sort: "date" | "name" | "count";
}

export interface ChartSpec {
  chart: ChartId;
  /** Horizontal / vertical / colour drop zones; y absent for one-axis charts. */
  x: AxisSpec;
  y: AxisSpec | null;
  colour: DimId | null;
  size: "entries" | "words";
  filter: { dim: DimId; value: string }[];
  hideNoValue: boolean;
  /** Global display merges (merge-groups corrections). */
  merges: MergeMap;
  /** Chart-local "Combine with…" (right-click an axis label): saved with the chart, never recolours the brain (L8). */
  combined: Record<string, string[]>;
  /** Top N stepper (default 20); "all" shows every category. */
  top: number | "all";
  /** Chart-specific options (ridgeline: normalise, smoothingDays 0–90, scale; lanes: show lines|bars …). */
  options: Record<string, string | number | boolean | string[]>;
  /** A map open in the reader: its sources are ringed in place with a count chip. */
  focusMap?: number;
}

export type ArrangementParams =
  | {
      kind: "groups";
      dim: DimId;
      layout: GroupLayout;
      fold: boolean;
      merges: MergeMap;
      hideNoValue: boolean;
      visibility: VisibilityParams;
      /** Split layout: record entries are grouped by this dimension in their own band under the notes (absent: one figure). */
      recordDim?: DimId;
      /** Layout-specific options (the grid's marks). */
      layoutOptions?: LayoutOptions;
      /** The role comet lies (default) or stands; the stage alternates the two while it sways. */
      orientation?: "horizontal" | "vertical";
    }
  | {
      kind: "chart";
      spec: ChartSpec;
      visibility: VisibilityParams;
      /** The visible stage in CSS px, so labels and ticks can switch columns and rows with the room they have. */
      stage?: ChartStage;
    };

/** 2D/3D annotations drawn by the overlay layer after particles settle. World-space coordinates. */
export type OverlayItem =
  | {
      type: "label";
      /** World position, or (with `screen`) CSS px from the stage's top-left corner. */
      at: Vec3;
      text: string;
      style: "box" | "tile" | "axis" | "muted" | "title";
      align?: "left" | "center" | "right";
      rotate?: number;
      key?: string;
      chip?: string;
      /** Anchored in screen space: `at` is [x, y, 0] in CSS px and the label stays put as the camera moves (the treemap's crumb). */
      screen?: true;
    }
  | { type: "line"; a: Vec3; b: Vec3; alpha: number; dashed?: boolean }
  | { type: "polyline"; points: Vec3[]; alpha: number; closed?: boolean }
  | { type: "rect"; min: Vec3; max: Vec3; alpha: number; fill?: number }
  | { type: "ring"; at: Vec3; radius: number; count: number; hue?: number };

export interface OverlayModel {
  items: OverlayItem[];
  /** Hit regions for hover/click on marks, bands and axis labels. */
  marks: { key: string; label: string; count: number; bounds: { min: Vec3; max: Vec3 } }[];
  /** A grouping by a label: the size of its smallest value group, counted before Fold (the richness hint names it). */
  thinnest?: number;
}

/**
 * A computed reading drawn ON the chart as an annotation (ORIG-07): a callout at the peak hour, a bracket on
 * the longest calendar run, the widest ribbon labelled with its count. Charts carry no canned question; the
 * text is a copy key + values rendered by the UI.
 */
export interface ChartReading {
  kind: "peak" | "run" | "widest" | "largest" | "longest" | "share";
  copyKey: string;
  values: Record<string, string | number>;
  at: Vec3;
  /** Optional span for brackets (start/end anchors). */
  to?: Vec3;
}

/**
 * A fibre bundle between two group spheres (Groups shape): `links` note links cross between the groups. Ends are
 * the sphere centres and radii in the arrangement's world frame; the renderer draws the fibres (Lines look).
 */
export interface GroupBundle {
  a: Vec3;
  b: Vec3;
  ra: number;
  rb: number;
  links: number;
  /** Links relative to the heaviest bundle, 0..1 (drives fibre count and brightness). */
  weight: number;
  /** The bundle converges on the hub apex (kind grouping): drawn in the cool apex blue. */
  apex?: boolean;
  /**
   * How the fibres are drawn (default "bundle"): "cone" runs from a narrow end at `a` and opens over the sphere at `b`,
   * "beam" is a straight, bright rail between the two points (the figure forms of the map-type, role and kind groupings).
   */
  form?: "bundle" | "cone" | "beam";
}

export interface ArrangementResult {
  /** Target position per item (3 floats); NaN = not in this arrangement (fades out). */
  arr: Float32Array;
  /** Fibre bundles between group spheres, heaviest first (Groups shape only). */
  bundles?: GroupBundle[];
  /** The arrangement is the role comet, which turns between lying and standing (the stage asks for the other `orientation`). */
  sway?: boolean;
  overlay: OverlayModel;
  camera: {
    centre: Vec3;
    radius: number;
    tiltDeg: number;
    keepUpright: boolean;
    /** A flat chart square on to the camera: half its width and height in world units, so the camera fits the rectangle itself, not the circle round it. */
    half?: { w: number; h: number };
  };
  /** At most three readings per chart. */
  readings?: ChartReading[];
  /** Categories on the horizontal axis with counts (the Top-N stepper and "Combine with…"). */
  categories?: { key: string; label: string; count: number }[];
  /** Charts: the biggest members of the cells (indices into `overlay.marks`) the layout did not name; the overlay names them once the view is zoomed in on the cell. */
  zoomMembers?: { mark: number; members: number[] }[];
  /** Groups smaller than 30 items (drawn as hollow outlined spheres with an n chip; shape-bar warning dot). */
  sparse?: { key: string; count: number }[];
  colourKey?: { key: string; label: string; rgb: [number, number, number] }[];
}

// ───────────────────────────── lines ─────────────────────────────

/** CORTEX-UX §6.10 line families. */
/**
 * Line families (CORTEX-UX §6.10, §12.6): source lines (note → its sources), conversation stems (consecutive
 * messages, off by default), map spokes (map → members, on selection only) and note links (vault note → the note it
 * links to, faint, under Lines: All). Label leaders are HTML/SVG.
 * There are no parent lines, cross-links or sequence chains.
 */
export type LineFamilyId = "source" | "stem" | "spoke" | "link";
export const LINE_FAMILIES: readonly LineFamilyId[] = ["source", "stem", "spoke", "link"];

export interface LinesParams {
  families: LineFamilyId[];
  visibility: VisibilityParams;
  /** Segment budget (60,000), sampled by priority. */
  budget: number;
}

export interface LinesResult {
  /** Pairs of 3D points. */
  positions: Float32Array;
  /** Per-vertex 0–1 draw-on parameter. */
  t: Float32Array;
  /** LINE_FAMILIES index per segment. */
  family: Uint8Array;
  /** Per segment: the note (source lines, spokes) or conversation (stems) ordinal, for hover naming. */
  owner: Uint32Array;
  /** Per segment: the source entry or member ordinal at the far end. */
  target: Uint32Array;
  segments: number;
}

// ───────────────────────────── search, selection, queries ─────────────────────────────

export interface SearchParams {
  query: string;
  limit: number;
  visibility: VisibilityParams;
}

export interface SearchResult {
  /** All matching ordinals, best first. */
  ordinals: Uint32Array;
  total: number;
  top: {
    entries: number[];
    notes: number[];
    maps: number[];
    folders: { path: string; count: number }[];
    /** "Filter by" suggestions (P21): the sources and tags (values of multi-valued label fields) among the hits, with counts. Omitted from an older worker's reply. */
    sources?: { source: string; count: number }[];
    tags?: { dim: string; value: string; count: number }[];
  };
}

export interface RelatedParams {
  ordinal: number;
}

export interface RelatedResult {
  sources: Uint32Array;
  members: Uint32Array;
  sameConversation: Uint32Array;
  citedBy: Uint32Array;
  parent: number;
  /** Line geometry for selection links (pairs of 3D points + per-vertex t + family). */
  lines: LinesResult;
}

/** Combined token query (H4): OR within a kind, AND across kinds; empty tokens = nothing lit. */
export interface QueryParams {
  tokens: QueryToken[];
  visibility: VisibilityParams;
}

export interface QueryResult {
  ordinals: Uint32Array;
  count: number;
}

// ───────────────────────────── stats for pages ─────────────────────────────

export type MeasureId = "entries" | "notes" | "both" | "words";

export type StatsParams =
  /** The time strip: bins auto (day ≤ 120 days, week, month beyond 8 years), weekly notes lane, age colour per bar. */
  | { kind: "strip"; bin: "auto" | "day" | "week" | "month"; notesLane: boolean; ageColour: boolean; visibility: VisibilityParams }
  /** The unrolled spine (Time page): fronds per conversation, voices, kind markers on the axis. */
  | { kind: "spine"; visibility: VisibilityParams }
  /** 7 × 24 weekday-by-hour rhythm grid (Time page header). */
  | { kind: "rhythm"; visibility: VisibilityParams }
  /** 24 hourly bars with the peak hour. */
  | { kind: "hours"; visibility: VisibilityParams }
  /** Voices over time and the overall share of your words ("yours: 38% of words, rising"). */
  | { kind: "voices"; visibility: VisibilityParams }
  /** Time › "When you wrote": monthly activity by area, kind lanes, day heatmap, speakers and labels over one period. */
  | { kind: "when"; labelDim: DimId; weekStart: 0 | 1; visibility: VisibilityParams }
  /** The Data view (was Tables): rows × columns × measure, including "labels over time". */
  | { kind: "data"; rows: DimId; columns: "none" | "week" | "month" | "year" | DimId; measure: MeasureId; visibility: VisibilityParams }
  /** Read list rows. */
  | { kind: "read"; view: "date" | "folder" | "source"; folder: string | null; preset: "all" | "today"; pinnedOnly: boolean; sort: "newest" | "oldest" | "size" | "title"; query: string; offset: number; limit: number; visibility: VisibilityParams }
  /** Sources page: per source counts, your words, undated. */
  | { kind: "sources"; visibility: VisibilityParams }
  /** Today preset: written today by source, new notes today. */
  | { kind: "today"; dayStart: number }
  /** Label packs table with per-field coverage (Agents). */
  | { kind: "packs"; includeSuperseded: boolean }
  /** Who made the record (Agents > Ledger > Influence): nodes and links by the set of makers behind them. */
  | { kind: "influence"; scope: InfluenceScope };

export interface TimeBin {
  start: number;
  end: number;
  entries: number;
  notes: number;
  /** Age-ramp position 0..1 of the bin's entries (mean τ), NaN when not age-coloured. */
  age: number;
}

export interface SpineFrond {
  conv: number;
  tau: number;
  messages: number;
  space: SpaceId;
  you: number;
  assistant: number;
}

/** Monthly bars stacked by group: `cells[group * months + month]` counts items. */
export interface WhenStack {
  groups: { key: string; label: string; kind: "value" | "other" | "none" }[];
  cells: number[];
}

export type WhenLaneKind = "decision" | "question" | "plan" | "abandoned";

/** The "When you wrote" series (every one over the same month axis `monthStarts`, the period or the dated range). */
export interface WhenStats {
  kind: "when";
  /** Month boundaries in epoch ms (local midnight): months + 1 entries, [] when nothing is dated. */
  monthStarts: number[];
  /** Earliest and latest dated item inside the axis (NaN when none). */
  first: number;
  last: number;
  area: WhenStack;
  /** The chosen label dimension over the same months; items without a value are left out (`unlabelled`). */
  labels: WhenStack & { dim: DimId; unlabelled: number };
  lanes: { kind: WhenLaneKind; total: number; ticks: { t: number; ordinal: number; title: string }[] }[];
  /** Record entries per day: 7 weekday rows (week start first) × weeks, row-major; `weekStarts` are local midnights. */
  days: { weekStarts: number[]; counts: number[]; max: number };
  speakers: { you: number[]; assistant: number[]; other: number[] };
  /** Record entries without a date. */
  undated: number;
}

export type StatsResult =
  | WhenStats
  | { kind: "strip"; bin: "day" | "week" | "month"; bins: TimeBin[]; undated: number; first: number; last: number }
  | {
      kind: "spine";
      fronds: SpineFrond[];
      /** Words per τ bucket above (you) and below (assistant) the centre axis. */
      voices: { tau: number; you: number; assistant: number }[];
      /** Machine-note kind markers riding the axis: ◆ decision, ? question, ▸ plan, × abandoned. */
      markers: { tau: number; kind: "decision" | "question" | "plan" | "abandoned"; ordinal: number }[];
      undated: number;
    }
  | { kind: "rhythm"; cells: Uint32Array /* 7 × 24, weekday-major (week start from settings) */; max: number }
  | { kind: "hours"; counts: Uint32Array; peakHour: number }
  | { kind: "voices"; youShare: number; trend: "rising" | "falling" | "steady"; months: { month: string; you: number; assistant: number; other: number; tool: number }[] }
  | { kind: "data"; columns: string[]; rows: { key: string; label: string; total: number; share: number; cells: number[] }[]; totals: number[] }
  | { kind: "read"; total: number; rows: { ordinal: number; count: number; youShare: number; last?: number }[]; folders: { path: string; count: number; depth: number }[] }
  | { kind: "sources"; rows: { source: string; entries: number; conversations: number; yourWords: number; words: number; undated: number }[] }
  | { kind: "today"; bySource: { source: string; entries: number }[]; newNotes: number[] }
  | {
      kind: "packs";
      packs: {
        pack: string;
        version: string;
        items: number;
        labelled: number;
        blank: number;
        /** Label values on the pack version (one per entry and field). */
        labelCount: number;
        /** Entries carrying at least one of them. */
        entryCount: number;
        /** Who made the label values: models ("machine") or your corrections ("you"). */
        authors: { machine: number; you: number };
        fields: { field: string; coverage: number }[];
      }[];
      /** Label values that sit on older pack versions (returned whether or not those versions are listed). */
      supersededLabels: number;
    }
  | {
      kind: "influence";
      scope: InfluenceScope;
      /** Nodes (notes, or every entry and note) and links (note links, and in the whole record also note citations). */
      nodes: number;
      links: number;
      /** One row per distinct set of makers (a conversation you and an assistant took part in is "you+app:…"). */
      together: { key: string; makers: string[]; nodes: number; links: number }[];
      /** One row per maker: nodes it took part in, nodes it made itself, links on its nodes. */
      byMaker: { maker: string; touched: number; made: number; links: number }[];
    };

/** Influence reads the notes alone, or the whole record. */
export type InfluenceScope = "notes" | "record";

// ───────────────────────────── RPC map & frames ─────────────────────────────

export interface WorkerInitParams {
  version: string;
  /** Monotonic clock origin so birth times line up with the renderer. */
  epoch: number;
}

export interface IndexSummary {
  count: number;
  notes: number;
  record: number;
  seq: number;
  epoch: string;
}

export interface WorkerMethods {
  init: { params: WorkerInitParams; result: { version: string } };
  loadIndex: { params: { record: ArrayBuffer; vault: ArrayBuffer | null; corrections: ArrayBuffer | null }; result: IndexSummary };
  appendIndex: { params: { epoch: string; fromCount: number; delta: ArrayBuffer }; result: IndexSummary };
  /** In-place label/flag updates of existing rows; nothing is re-placed. */
  patchIndex: { params: { epoch: string; ordinals: Uint32Array; flags?: Uint32Array }; result: IndexSummary };
  /** Search is sharded: one immutable shard per closed ledger shard plus a small live shard. */
  loadSearch: { params: { shards: ArrayBuffer[] }; result: { terms: number; docs: number } };
  addSearchShard: { params: { shard: ArrayBuffer; replacesLive: boolean }; result: { terms: number; docs: number } };
  placement: { params: PlacementParams; result: PlacementResult };
  grouping: { params: GroupingParams; result: GroupingResult };
  arrangement: { params: ArrangementParams; result: ArrangementResult };
  lines: { params: LinesParams; result: LinesResult };
  search: { params: SearchParams; result: SearchResult };
  related: { params: RelatedParams; result: RelatedResult };
  query: { params: QueryParams; result: QueryResult };
  stats: { params: StatsParams; result: StatsResult };
  /** Load the in-memory sample record (P2 sandbox) instead of the real index. */
  loadSample: { params: { seed: number }; result: IndexSummary };
}

export type WorkerMethod = keyof WorkerMethods;

export type ToWorker =
  | { [M in WorkerMethod]: { t: "call"; id: number; viewId: string; method: M; params: WorkerMethods[M]["params"] } }[WorkerMethod]
  | { t: "cancel"; id: number }
  | { t: "dropView"; viewId: string };

export type WorkerErrorCode = "E_CANCELLED" | "E_NO_INDEX" | "E_BAD_PARAMS" | "E_EPOCH" | "E_INTERNAL";

export type FromWorker =
  | { t: "result"; id: number; ok: true; result: WorkerMethods[WorkerMethod]["result"] }
  | { t: "result"; id: number; ok: false; error: { code: WorkerErrorCode; message: string } }
  | { t: "progress"; id: number; phase: string; done: number; total: number }
  | { t: "ready"; version: string };

/** True when the typed array owns its whole buffer (only then may the buffer be transferred). */
export function ownsBuffer(view: ArrayBufferView): boolean {
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength;
}

/**
 * Prepare a result for posting: typed arrays that own their buffer (and are not state-owned) are transferred;
 * any other view is replaced by a copy so the worker never detaches its own index or anatomy (TRANSFER-DETACH).
 * Returns a new value (plain objects/arrays are shallow-copied along the path) and the transfer list.
 */
export function prepareTransfer<T>(value: T, stateOwned: WeakSet<ArrayBufferLike> = new WeakSet()): { value: T; transfer: ArrayBuffer[] } {
  const transfer = new Set<ArrayBuffer>();
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 8 || v === null || typeof v !== "object") return v;
    if (ArrayBuffer.isView(v)) {
      const buf = v.buffer;
      if (buf instanceof ArrayBuffer && ownsBuffer(v) && !stateOwned.has(buf) && !transfer.has(buf)) {
        transfer.add(buf);
        return v;
      }
      const copyable = v as unknown as { slice?: () => unknown };
      return typeof copyable.slice === "function" ? copyable.slice() : v;
    }
    if (v instanceof ArrayBuffer) {
      if (stateOwned.has(v)) return v.slice(0);
      transfer.add(v);
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = walk(x, depth + 1);
    return out;
  };
  const prepared = walk(value, 0) as T;
  return { value: prepared, transfer: [...transfer] };
}

/**
 * Transferables of a value that is already safe to post (every view owns its buffer). Kept for callers that
 * build fresh results; it skips non-owning views and state-owned buffers instead of detaching them.
 */
export function collectTransferables(value: unknown, stateOwned: WeakSet<ArrayBufferLike> = new WeakSet()): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 8 || v === null || typeof v !== "object") return;
    if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof ArrayBuffer && ownsBuffer(v) && !stateOwned.has(v.buffer)) out.add(v.buffer);
      return;
    }
    if (v instanceof ArrayBuffer) {
      if (!stateOwned.has(v)) out.add(v);
      return;
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(value, 0);
  return [...out];
}

/** ISO period strings in actions are converted to epoch windows at the boundary. */
export type IsoWindow = [IsoDate, IsoDate];
