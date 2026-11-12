/**
 * Preact contexts and the per-leaf shell runtime. Owner: E11.
 *  - ServicesContext / LeafContext: the shared service container and THIS leaf's services (store, viewId).
 *  - ShellContext: the leaf's UI runtime that is not persisted and not part of the leaf store contract: the view's
 *    measured size, toasts, the live-region announcement, the active one-time hint, the stage feed from the render
 *    controller (territories, compass needle, thin groups, graphics status), per-entry sheet scroll positions and
 *    the local undo stack for view changes the shell makes (Display reset, folds).
 *  - The stage bus: events between the shell and the render controller that the frozen CortexEvents map does not
 *    carry yet (docs/rfcs/E11.md §1). They ride the same EventBus under their own names.
 *  - pendingCopy: the few strings the shell needs that ui/copy.ts does not have yet (docs/rfcs/E11.md §3); the
 *    lookup prefers COPY.shell.<key> as soon as E12 adds it.
 * Components without a ShellContext provider (tests, pages that embed a primitive) get one shell per leaf.
 */
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import { signal } from "@preact/signals";
import type { Menu } from "obsidian";
import type { CortexServices, LeafServices } from "../plugin/services";
import { ItemFlag, NONE8, Population, SPACE_ORDER, type DataIndex } from "../shared/index-format";
import type { ArrangementResult, ChartSpec, StatsResult, Territory, VisibilityParams } from "../shared/protocol/worker";
import type { ChartStage } from "../shared/chartStage";
import type { CortexEvents, EventBus } from "../state/events";
import { COPY } from "./copy";
import type { HintId } from "./deviceState";

export const ServicesContext = createContext<CortexServices | null>(null);
export const LeafContext = createContext<LeafServices | null>(null);

export function useServices(): CortexServices {
  const s = useContext(ServicesContext);
  if (!s) throw new Error("Cortex services are not available outside the Cortex view");
  return s;
}

export function useLeaf(): LeafServices {
  const l = useContext(LeafContext);
  if (!l) throw new Error("Cortex leaf state is not available outside a Cortex view");
  return l;
}

// ───────────────────────────── stage bus (shell ↔ render controller) ─────────────────────────────

/** A rectangle in stage-local CSS px (the stage's top-left is the canvas's top-left). */
export interface StageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A label anchor projected by the renderer (≤ 30 Hz); the shell lays the chips out and draws them. */
export interface LabelAnchor {
  key: string;
  ordinal: number;
  /** Projected point in canvas CSS px. */
  x: number;
  y: number;
  /** 0 nearest … 1 farthest (depth fade 100% → 45%). */
  depth: number;
  /** selected 4 > the selection's notes 3 > traced 2 > largest 1. */
  priority: number;
  /** Kind word shown in --cx-stage-text-3 ("Decision", "Conversation"); may be empty. */
  kind: string;
  /** Kind glyph (§4.5), e.g. "◆", or "" for groups. */
  glyph: string;
  title: string;
  rgb: [number, number, number];
  count?: number;
  /** A member chip of a hovered hub (named together, up to HUB_HOVER.chips of them, instead of the usual cap). */
  hover?: boolean;
}

export interface StageEvents {
  /** Shell → renderer: overlay rectangles and the free stage the figure is framed in (safe frame). */
  "stage:layout": { viewId: string; width: number; height: number; insetRight: number; overlays: StageRect[]; safe: StageRect; fit?: "figure" | "brain"; /** What the floating Chart card (left) and the open Display popover (right) cover of the stage, CSS px: charts are fitted between them. */ chartCover?: { left: number; right: number } };
  "stage:camera": { viewId: string; needleDeg: number; headingDeg: number };
  /** Renderer → shell after placement: the brain's territories (the compass ring draws exactly these wedges). */
  "stage:territories": { viewId: string; territories: Territory[] };
  /** Renderer → shell, ≤ 30 Hz: label anchors for the label layer. */
  "stage:labels": { viewId: string; anchors: LabelAnchor[]; /** Where the standing figure is on screen (canvas px), when the renderer knows; the label layer falls back to its own estimate. */ columns?: { cx: number; pxPerUnit: number; brainBottom: number } | null };
  /** Renderer → shell after an arrangement: thin groups (under 30) and whether the chart is flat. */
  "stage:arrangement": { viewId: string; sparse: { key: string; count: number }[]; flat: boolean };
  /**
   * Renderer → shell after a chart arrangement (E9 RFC 1): the spec, the worker's result, the visibility the call
   * used and the index it ran against, so the chart overlay adopts it instead of asking the worker a second time.
   */
  "stage:chart": { viewId: string; spec: ChartSpec; result: ArrangementResult; visibility: VisibilityParams; index: DataIndex; /** The stage the chart was laid out for. */ stage?: ChartStage };
  /** Renderer → shell: graphics state (context loss, no WebGL2, layout in the worker, governor level 0–3). */
  "stage:status": { viewId: string; status: "ok" | "context-lost" | "no-webgl" | "arranging"; governor?: number };
  /** Renderer → shell: a gesture on a point (click, double-click, Ctrl/Cmd + click, right-click, Ctrl/Cmd + hover); x, y are client px. The shell opens what the gesture means (CORTEX-UX §2.3). */
  "stage:point": { viewId: string; ordinal: number; id: string; gesture: "click" | "dblclick" | "ctrl-click" | "context" | "preview"; x: number; y: number; event?: MouseEvent };
  /** Renderer → shell: Tab stepped to this point; the live region announces it. */
  "stage:announce": { viewId: string; ordinal: number };
  /** Shell → renderer: the banner's Restart after a driver reset. */
  "stage:restart": { viewId: string };
  /** Shell → renderer: dragging around the compass ring turns the camera to face that angle (P1). */
  "stage:turn": { viewId: string; needleDeg: number };
  /** Anyone → shell: a toast from Cortex's copy catalogue (the governor's line, background errors). */
  toast: { viewId?: string; kind: "info" | "error"; copyKey: string; values?: Record<string, string | number> };
}

export type ShellEvents = CortexEvents & StageEvents;

/** The shared bus, typed with the shell's stage events (same instance; names do not collide). */
export function stageBus(bus: EventBus): EventBus<ShellEvents> {
  return bus as unknown as EventBus<ShellEvents>;
}

// ───────────────────────────── pending copy (docs/rfcs/E11.md §3) ─────────────────────────────

export const PENDING_COPY = {
  tipMessageHint: "Click to read · double-click for the conversation",
  tipReadHint: "Click to read",
  tipVaultHint: "Click to peek · Ctrl+click to open",
  tipMapHint: "Click to read · Shift+click to trace every source",
  tipChartHint: "Click to trace",
  tipPassage: "{source} · passage {i} of {n}",
  tipVaultNote: "Vault note · layer {layer}",
  tipSourceLine: "Source line",
  tipStem: "Conversation stem",
  tipLineOf: "{title} → 1 of its {n} sources",
  stripBinTip: "{date} · {entries} entries · {notes} notes",
  sheetResize: "Sheet width",
  sheetFailed: "Cortex couldn't show this page. Everything else still works.",
  undoFailed: "Cortex couldn't undo that change. Nothing else was changed.",
  mergeFailed: "Cortex couldn't merge these groups. Nothing was changed.",
  startFailed: "Cortex couldn't save your choice, so nothing was imported or sent.",
  selectionAnnounce: "Selected: {title}",
  keyShow: "Show",
} as const;

export type PendingCopyKey = keyof typeof PENDING_COPY;

export function fill(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (values[k] !== undefined ? String(values[k]) : `{${k}}`));
}

/** A shell string: COPY.shell.<key> once E12 adds it, otherwise the UX wording above. */
export function pendingCopy(key: PendingCopyKey, values?: Record<string, string | number>): string {
  const section = (COPY as unknown as Record<string, unknown>).shell;
  const own = typeof section === "object" && section !== null ? (section as Record<string, unknown>)[key] : undefined;
  return fill(typeof own === "string" ? own : PENDING_COPY[key], values);
}

// ───────────────────────────── shell runtime ─────────────────────────────

export interface ViewSize {
  width: number;
  height: number;
}

/** What CortexView lends the UI (the leaf itself stays in the eager view class). */
export interface ViewBridge {
  /** Obsidian's own pane items (Split right, Open in new window, Close …) for the More menu and brand right-click. */
  fillPaneMenu(menu: Menu): void;
  /** Mini: move this view into the main area. */
  openInMainArea(): void;
  /** True while the leaf lives in a sidebar. */
  inSidebar(): boolean;
  /** "Cortex" or "Cortex · ‹Area›" on the tab. */
  refreshTitle(): void;
  /** Ask Obsidian to persist the workspace (the leaf's getState changed). */
  saveLayout(): void;
}

export interface ShellToast {
  id: string;
  kind: "change" | "info" | "error" | "arrivals";
  text: string;
  detail?: string;
  action?: { label: string; run(): void };
  /** "Undo change" while the toast is shown. */
  undo?: () => void | Promise<void>;
  /** Errors stay until dismissed; the rest leave after 8 s (hover pauses). */
  sticky?: boolean;
  at: number;
}

/** A transient line in the rail's status stack (notify): the auto-adjust notice, a removed highlight. */
export interface StatusLine {
  id: string;
  kind: "info" | "notice";
  text: string;
  at: number;
}

/** The status stack keeps at most this many notify lines. */
export const STATUS_LINES_MAX = 4;

export interface ActiveHint {
  id: HintId;
  /** Anchor point in view-local CSS px and the side the bubble sits on. */
  x: number;
  y: number;
  side: "above" | "below" | "left";
}

export interface StageFeed {
  territories: Territory[] | null;
  needleDeg: number | null;
  sparse: { key: string; count: number }[];
  flatChart: boolean;
  status: "ok" | "context-lost" | "no-webgl" | "arranging";
  governor: number;
}

export type StripStats = Extract<StatsResult, { kind: "strip" }>;

export class Shell {
  readonly size = signal<ViewSize>({ width: 0, height: 0 });
  readonly toasts = signal<readonly ShellToast[]>([]);
  /** Receipt ids dismissed (or expired) in this leaf. */
  readonly dismissed = signal<ReadonlySet<string>>(new Set());
  readonly announcement = signal<{ text: string; seq: number }>({ text: "", seq: 0 });
  readonly hint = signal<ActiveHint | null>(null);
  /** Transient status lines (at most four), shown bottom-anchored in the rail; the persistent ones are derived. */
  readonly statusLines = signal<readonly StatusLine[]>([]);
  /** The walkthrough (ui/walkthrough): the step being shown (0-based), or null when no tour is running. */
  readonly tour = signal<number | null>(null);
  readonly feed = signal<StageFeed>({ territories: null, needleDeg: null, sparse: [], flatChart: false, status: "ok", governor: 0 });
  /** Obsidian's theme (body.theme-dark), followed by the "Follow theme" stage. */
  readonly obsidianDark = signal(true);
  /** prefers-reduced-motion of the view's window. */
  readonly systemReducedMotion = signal(false);
  /** S breakpoint: the shape bar opened as a popover from its Shape button. */
  readonly shapeOpen = signal(false);
  /** Stops a running Replay on the time strip (set while it runs); Esc calls it. */
  stopReplay: (() => void) | null = null;
  /** The period preset last chosen in this leaf (the picker shows its name while the window still matches). */
  readonly periodPreset = signal<string | null>(null);
  /** The strip's statistics (the strip owns the request; the banner reads it for "Nothing in this period"). */
  readonly strip = signal<StripStats | null>(null);
  /** Per sheet entry scroll positions. */
  readonly scroll = new Map<string, number>();
  /** Overlay rectangles in stage-local px (key bar, shape bar, tools, compass, command line, toasts…). */
  overlayRects: StageRect[] = [];
  readonly openedAt: number;
  root: HTMLElement | null = null;
  bridge: ViewBridge | null = null;
  private seq = 0;
  private undos: { id: string; run: () => void; at: number }[] = [];
  private last = { text: "", at: 0 };
  private statusTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    readonly viewId: string,
    readonly now: () => number = () => Date.now(),
  ) {
    this.openedAt = now();
  }

  /** The window the view lives in (pop-out aware); falls back to the global object. */
  get win(): Window {
    return (this.root?.ownerDocument?.defaultView ?? (globalThis as unknown as Window)) as Window;
  }

  get doc(): Document | null {
    return this.root?.ownerDocument ?? (typeof document === "undefined" ? null : document);
  }

  nextId(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  /** Post a toast; returns its id. At most ten are kept; three show. */
  toast(t: Omit<ShellToast, "id" | "at"> & { id?: string }): string {
    const id = t.id ?? this.nextId("toast");
    const next: ShellToast = { ...t, id, at: this.now() };
    this.toasts.value = [...this.toasts.value.filter((x) => x.id !== id), next].slice(-10);
    return id;
  }

  dismissToast(id: string): void {
    if (this.toasts.value.some((t) => t.id === id)) this.toasts.value = this.toasts.value.filter((t) => t.id !== id);
    else if (!this.dismissed.value.has(id)) this.dismissed.value = new Set([...this.dismissed.value, id]);
  }

  /** Record an undoable view change made by the shell (Display reset, fold); Ctrl Z and the toast run it. */
  pushUndo(run: () => void): string {
    const id = this.nextId("undo");
    this.undos = [...this.undos.slice(-19), { id, run, at: this.now() }];
    return id;
  }

  runUndo(id: string): boolean {
    const u = this.undos.find((x) => x.id === id);
    if (!u) return false;
    this.undos = this.undos.filter((x) => x.id !== id);
    u.run();
    return true;
  }

  /** The newest local undo, if it is newer than `afterMs`. */
  latestUndo(afterMs = Number.NEGATIVE_INFINITY): { id: string; at: number } | null {
    const u = this.undos[this.undos.length - 1];
    return u && u.at >= afterMs ? { id: u.id, at: u.at } : null;
  }

  /** Polite live-region message; repeats within 250 ms collapse into one. */
  announce(text: string, debounceMs = 250): void {
    const t = text.trim();
    if (!t) return;
    const now = this.now();
    if (t === this.last.text && now - this.last.at < debounceMs) return;
    this.last = { text: t, at: now };
    this.announcement.value = { text: t, seq: this.announcement.value.seq + 1 };
  }

  /**
   * Show a transient line in the status stack and tell the live region. The same text again replaces its earlier
   * line (the timer restarts); the stack keeps the newest four. Removal at the end of `ttl` is immediate.
   */
  notify(text: string, opts: { kind?: StatusLine["kind"]; ttl?: number } = {}): string {
    const msg = text.trim();
    if (!msg) return "";
    const same = this.statusLines.value.find((l) => l.text === msg);
    const id = same?.id ?? this.nextId("status");
    const line: StatusLine = { id, kind: opts.kind ?? "notice", text: msg, at: this.now() };
    this.statusLines.value = [...this.statusLines.value.filter((l) => l.id !== id), line].slice(-STATUS_LINES_MAX);
    const live = new Set(this.statusLines.value.map((l) => l.id));
    for (const [k, h] of this.statusTimers) if (!live.has(k)) { clearTimeout(h); this.statusTimers.delete(k); }
    const old = this.statusTimers.get(id);
    if (old !== undefined) clearTimeout(old);
    this.statusTimers.set(id, setTimeout(() => this.dropStatus(id), opts.ttl ?? 6000));
    this.announce(msg);
    return id;
  }

  dropStatus(id: string): void {
    const h = this.statusTimers.get(id);
    if (h !== undefined) clearTimeout(h);
    this.statusTimers.delete(id);
    if (this.statusLines.value.some((l) => l.id === id)) this.statusLines.value = this.statusLines.value.filter((l) => l.id !== id);
  }

  dispose(): void {
    if (liveShells.get(this.viewId) === this) liveShells.delete(this.viewId);
    this.toasts.value = [];
    this.hint.value = null;
    for (const h of this.statusTimers.values()) clearTimeout(h);
    this.statusTimers.clear();
    this.statusLines.value = [];
    this.undos = [];
    this.scroll.clear();
    this.root = null;
    this.bridge = null;
  }
}

export const ShellContext = createContext<Shell | null>(null);

const fallbackShells = new WeakMap<LeafServices, Shell>();

/** The shell of a leaf (one per leaf; created on first use when no provider is present). */
export function shellFor(leaf: LeafServices): Shell {
  let s = fallbackShells.get(leaf);
  if (!s) {
    s = new Shell(leaf.viewId);
    fallbackShells.set(leaf, s);
  }
  return s;
}

const liveShells = new Map<string, Shell>();

/** Register the shell a mount created, so shellFor() and the provider agree. */
export function adoptShell(leaf: LeafServices, shell: Shell): void {
  fallbackShells.set(leaf, shell);
  liveShells.set(leaf.viewId, shell);
}

/** The shell of the mounted view with this id (commands that act on a view's overlays), or null once it is gone. */
export function shellOfView(viewId: string): Shell | null {
  return liveShells.get(viewId) ?? null;
}

export function useShell(): Shell {
  const provided = useContext(ShellContext);
  const leaf = useContext(LeafContext);
  if (provided) return provided;
  if (!leaf) throw new Error("Cortex shell is not available outside a Cortex view");
  return shellFor(leaf);
}

// ───────────────────────────── derived index counts ─────────────────────────────

export interface IndexCounts {
  notes: number;
  record: number;
  notesBySpace: Readonly<Record<string, number>>;
  recordBySpace: Readonly<Record<string, number>>;
  /** Reference material (hidden by default): "‹n› hidden" in Layers. */
  reference: number;
  subagents: number;
  askHistory: number;
  automated: number;
  /** Record entries without a date of their own (the undated cloud). */
  undated: number;
  /** Earliest and latest written date of the record (epoch ms; NaN when none). */
  firstT: number;
  lastT: number;
}

const countsCache = new WeakMap<DataIndex, IndexCounts>();

/** One pass over the index columns (≈ 1 ms for 300,000 items), cached per index object. */
export function countIndex(ix: DataIndex): IndexCounts {
  const hit = countsCache.get(ix);
  if (hit) return hit;
  const notesBySpace: Record<string, number> = {};
  const recordBySpace: Record<string, number> = {};
  let notes = 0;
  let record = 0;
  let reference = 0;
  let subagents = 0;
  let askHistory = 0;
  let automated = 0;
  let undated = 0;
  let firstT = Number.POSITIVE_INFINITY;
  let lastT = Number.NEGATIVE_INFINITY;
  const { pop, space, flags, t } = ix.cols;
  for (let i = 0; i < ix.count; i++) {
    const f = flags[i] ?? 0;
    if (f & ItemFlag.Excluded) continue;
    if (f & ItemFlag.Reference) reference++;
    if (f & ItemFlag.Subagent) subagents++;
    if (f & ItemFlag.AssistantPane) askHistory++;
    if (f & ItemFlag.Automated) automated++;
    const sp = space[i] ?? NONE8;
    const spaceId = sp === NONE8 ? "none" : (SPACE_ORDER[sp] ?? "none");
    if (pop[i] === Population.Note) {
      notes++;
      notesBySpace[spaceId] = (notesBySpace[spaceId] ?? 0) + 1;
    } else {
      record++;
      recordBySpace[spaceId] = (recordBySpace[spaceId] ?? 0) + 1;
      const ti = t[i] ?? Number.NaN;
      if (f & ItemFlag.Undated || !Number.isFinite(ti)) undated++;
      else {
        if (ti < firstT) firstT = ti;
        if (ti > lastT) lastT = ti;
      }
    }
  }
  const out: IndexCounts = {
    notes,
    record,
    notesBySpace,
    recordBySpace,
    reference,
    subagents,
    askHistory,
    automated,
    undated,
    firstT: Number.isFinite(firstT) ? firstT : Number.NaN,
    lastT: Number.isFinite(lastT) ? lastT : Number.NaN,
  };
  countsCache.set(ix, out);
  return out;
}

/** The loaded index, or null (not loaded yet, or the index service is unavailable). Reactive in components. */
export function loadedIndex(s: CortexServices): DataIndex | null {
  try {
    return s.index.index.value ?? null;
  } catch {
    return null;
  }
}

/** Counts of the loaded index, or null before it loads. */
export function indexCounts(s: CortexServices): IndexCounts | null {
  const ix = loadedIndex(s);
  return ix ? countIndex(ix) : null;
}

/** DOM ids of one leaf's regions (unique across several Cortex leaves in one window). */
export function domIds(viewId: string): { sheet: string; sheetTitle: string; stage: string; summary: string; tabs: string } {
  const v = viewId.replace(/[^a-zA-Z0-9_-]/g, "");
  return { sheet: `cx-sheet-${v}`, sheetTitle: `cx-sheet-title-${v}`, stage: `cx-stage-${v}`, summary: `cx-summary-${v}`, tabs: `cx-tabs-${v}` };
}

/** Locale number format used across the shell (en-GB grouping: 18,533). */
export function num(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-GB") : "–";
}

/** Reduced motion (§4.8): Settings › Appearance › Motion "Reduced", or "Follow system" with the OS preference. */
export function isReducedMotion(motion: "system" | "reduced" | "full", systemReduced: boolean): boolean {
  return motion === "reduced" || (motion === "system" && systemReduced);
}
