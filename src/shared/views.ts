/**
 * Header tabs, sheet pages, reader kinds, shapes and the chart catalogue. FROZEN CONTRACT (owner: architect).
 *
 * The information architecture is CORTEX-UX §3 and §5 (binding): ONE right-hand sheet that holds every page and
 * reader in a back stack, a bottom command line, and the Chart page opened from the tool column. Navigation is a
 * left rail of thirteen destinations at XL and L (src/ui/nav/navModel.ts maps each to a route and sub-view) and
 * a page picker in the header at M and S. There is no second dock. Ids are functional and stable; every display
 * string lives in src/ui/copy.ts.
 */

// ───────────────────────────── pages and sheet routes (CORTEX-UX §12.2) ─────────────────────────────

/** Header pages (CORTEX-UX §5.1). "brain" closes the sheet; the other four open their page in the sheet. */
export type PageId = "brain" | "read" | "time" | "agents" | "sources";
export const PAGE_IDS: readonly PageId[] = ["brain", "read", "time", "agents", "sources"];

/**
 * Sheet routes that take parameters but no item id. `guide` opens from the header's "?" icon, `chart` from the
 * tool column (C), `change-history` (tabs Changes · Ask history) from the console, `runs` (the full runs ledger)
 * from Agents, `new-entry` from Read, `you` from the rail (your share of the record, what waits for you).
 */
export type SheetPageRoute = "read" | "time" | "agents" | "sources" | "chart" | "guide" | "new-entry" | "change-history" | "runs" | "you" | "add";
export const SHEET_PAGE_ROUTES: readonly SheetPageRoute[] = ["read", "time", "agents", "sources", "chart", "guide", "new-entry", "change-history", "runs", "you", "add"];

/** Reader routes, keyed by a stable item id. `map` is a machine map of content (code identifiers say "hub"). */
export type ReaderRoute = "entry" | "conversation" | "note" | "map" | "vault-peek" | "thread" | "today";
export const READER_ROUTES: readonly ReaderRoute[] = ["entry", "conversation", "note", "map", "vault-peek", "thread", "today"];

export type SheetRoute = SheetPageRoute | ReaderRoute;
export const SHEET_ROUTES: readonly SheetRoute[] = [...SHEET_PAGE_ROUTES, ...READER_ROUTES];

/** The route a header page opens (null = close the sheet). */
export const PAGE_ROUTE: Readonly<Record<PageId, SheetPageRoute | null>> = { brain: null, read: "read", time: "time", agents: "agents", sources: "sources" };

/** Read (CORTEX-UX §5.18): segments, plus two filter toggles (Pinned only, Today) that are not segments. */
export type ReadView = "date" | "folder" | "source";
/** Time (§5.19): the monthly charts (the default), the spine laid flat ("figure"), or the Data view (the numbers behind every chart). */
export type TimeView = "charts" | "figure" | "data";
/** Agents (§5.20): Ledger · Checks · Access log. */
export type AgentsView = "ledger" | "checks" | "access";
/** Sources (§5.22): Sources · Files · Privacy. */
export type SourcesView = "sources" | "files" | "privacy";
/** Change history (§5.30.5): Changes · Ask history. */
export type HistoryView = "changes" | "ask";

/** Sub-views per route; `open_view` and links may only name these (closed schema, SAFE-15). */
export const ROUTE_VIEWS = {
  read: ["date", "folder", "source"],
  time: ["charts", "figure", "data"],
  agents: ["ledger", "checks", "access"],
  sources: ["sources", "files", "privacy"],
  "change-history": ["changes", "ask"],
} as const satisfies Partial<Record<SheetPageRoute, readonly string[]>>;

/** Read's filter toggles (Today is a preset of Read, not a page). */
export type ReadToggle = "pinned" | "today";

/** One entry of the sheet's back stack. Readers are keyed by stable id (never by ordinal) so the stack persists. */
export type SheetEntry =
  | { kind: "page"; route: SheetPageRoute; params?: Readonly<Record<string, string>> }
  | { kind: "reader"; route: ReaderRoute; id: string };

/** Every page and reader docks in the single sheet (push, overlay or full mode by breakpoint, §3.4). */
export const SHEET_STACK_MAX = 12;
export const SHEET_WIDTH = { default: 400, min: 340, max: 560 } as const;

// ───────────────────────────── shapes ─────────────────────────────

/** Shape bar targets (CORTEX-UX §5.4, §6.12): every point morphs between Body and Groups or Chart. */
export type ShapeKind = "body" | "groups" | "chart";
export const SHAPES: readonly ShapeKind[] = ["body", "groups", "chart"];

// ───────────────────────────── chart catalogue ─────────────────────────────

/** CORTEX-UX §7.2: one catalogue, four groups. There is no split into "forms" and "answers". */
export type ChartGroup = "compare" | "time" | "rhythm" | "connections";
export const CHART_GROUP_ORDER: readonly ChartGroup[] = ["compare", "time", "rhythm", "connections"];

export type ChartId =
  | "ranked-bars"
  | "matrix"
  | "treemap"
  | "icicle"
  | "bubble-pack"
  | "nested-bubbles"
  | "stream"
  | "bands"
  | "ridgeline"
  | "calendar-heatmap"
  | "timeline-lanes"
  | "arc-diagram"
  | "diverging-area"
  | "two-sides"
  | "beeswarm"
  | "radial-clock"
  | "radial-heatmap"
  | "alluvial"
  | "chord"
  | "clusters-3d";

export interface ChartDef {
  id: ChartId;
  group: ChartGroup;
  phase: "P1" | "P2";
  /** Flat charts switch "Keep upright" on automatically (orbit clamped to ±50° yaw, ±30° pitch). */
  flat: boolean;
}

export const CHART_CATALOGUE: readonly ChartDef[] = [
  { id: "ranked-bars", group: "compare", phase: "P1", flat: true },
  { id: "matrix", group: "compare", phase: "P1", flat: true },
  { id: "treemap", group: "compare", phase: "P1", flat: true },
  { id: "icicle", group: "compare", phase: "P1", flat: true },
  { id: "bubble-pack", group: "compare", phase: "P1", flat: false },
  { id: "nested-bubbles", group: "compare", phase: "P2", flat: false },
  { id: "stream", group: "time", phase: "P1", flat: true },
  { id: "bands", group: "time", phase: "P1", flat: true },
  { id: "ridgeline", group: "time", phase: "P1", flat: true },
  { id: "calendar-heatmap", group: "time", phase: "P1", flat: true },
  { id: "timeline-lanes", group: "time", phase: "P1", flat: true },
  { id: "arc-diagram", group: "time", phase: "P2", flat: true },
  { id: "diverging-area", group: "time", phase: "P1", flat: true },
  { id: "two-sides", group: "time", phase: "P1", flat: true },
  { id: "beeswarm", group: "time", phase: "P2", flat: true },
  { id: "radial-clock", group: "rhythm", phase: "P1", flat: true },
  { id: "radial-heatmap", group: "rhythm", phase: "P2", flat: true },
  { id: "alluvial", group: "connections", phase: "P1", flat: true },
  { id: "chord", group: "connections", phase: "P2", flat: true },
  { id: "clusters-3d", group: "connections", phase: "P1", flat: false },
];

export const CHART_IDS: readonly ChartId[] = CHART_CATALOGUE.map((c) => c.id);

export function chartDef(id: ChartId): ChartDef {
  const d = CHART_CATALOGUE.find((c) => c.id === id);
  if (!d) throw new Error(`unknown chart ${id}`);
  return d;
}

export function chartsInGroup(group: ChartGroup): ChartDef[] {
  return CHART_CATALOGUE.filter((c) => c.group === group);
}
