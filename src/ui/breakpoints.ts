/**
 * The shell's geometry, timing and breakpoints (CORTEX-UX §2.5, §3, §4.7, §4.8). Owner: E11.
 *
 * Every layout, figure-framing and timing number the shell uses lives in ONE exported constants object, SHELL,
 * so the final numbers of CORTEX-UX §3 and §6 can be dropped in without code changes.
 *
 * Breakpoints use the Cortex view's own content box, measured with a ResizeObserver on contentEl (never the
 * window):
 *  XL ≥ 1400: everything, with the 168 px left rail; the sheet pushes the stage.
 *  L 1100–1399: the rail, compass card 124 px (ring 92), command line 560 px; the sheet pushes.
 *  M 760–1099: a narrower 136 px rail (every destination stays one click away); Live and agent chips become icons; the sheet overlays; the key
 *    bar becomes a Key button; compass 88 px without caption.
 *  S 480–759: header = glyph, page picker, scope icon, More; the sheet is full; one Tools button; the shape bar
 *    becomes a Shape button; strip 44 px without its lead; command line full width − 32; no compass.
 *  Mini < 480 wide or < 360 tall: the figure only, 32 px header, tooltips; "Open in the main area".
 *  Height < 640: strip 44 px, one key row; < 520: no compass.
 */
import type { SheetEntry, SheetPageRoute } from "../shared/views";
import { isDesktopHost } from "./host";
import { sheetTabbed } from "../state/selectors";
import type { Breakpoint, SheetSide } from "../state/types";

export { sheetTabbed };

export const SHELL = {
  geometry: {
    widths: { XL: 1400, L: 1100, M: 760, S: 480 },
    miniHeight: 360,
    shortHeight: 640,
    tinyHeight: 520,
    headerH: 44,
    /** The left rail: its width at XL and L, and the narrower one at M; S uses the header's page picker instead. */
    railW: 168,
    railWM: 136,
    /** The standalone app's rail (about 12.4% of a 1512 px window, as in the reference recordings). */
    railWDesktop: 188,
    miniHeaderH: 32,
    stripH: 64,
    stripShortH: 44,
    inset: 16,
    keyBar: { top: 12, maxFraction: 0.44, rowH: 28, padX: 16, labelW: 44, pickerW: 86, layersW: 84, chipGap: 1, moreW: 38 },
    shapeBar: { top: 12, h: 40, sliderW: 132 },
    tools: { top: 64, w: 38, button: 32 },
    banner: { top: 92, maxW: 400 },
    compass: {
      XL: { card: 140, cardH: 150, ring: 104, caption: true },
      L: { card: 124, cardH: 136, ring: 92, caption: true },
      M: { card: 100, cardH: 100, ring: 88, caption: false },
    },
    ring: { viewBox: 104, outer: 48, inner: 37, gapDeg: 1.6, scopedLift: 3 },
    command: { XL: 640, L: 560, M: 560, h: 44, sideMargin: 32 },
    toast: { w: 330, max: 3, gap: 8 },
    popover: { w: 304, gapToTools: 8, keyW: 320, keyTop: 86, keyMaxFraction: 0.6, edge: 12 },
    tooltip: { offset: 16, maxW: 300, estH: 96 },
    memberCard: { w: 260, rows: 8 },
    hint: { w: 250, gap: 10 },
    labels: {
      max: 24, h: 21, maxChars: 42, minGap: 4, anchorGap: 8, iterations: 6, overlayPad: 4,
      /** The standing figure's two label columns (§6.11): chips sit outside the brain, then outside the torso. */
      columns: { figureUnits: 9.9, fitRatio: 0.97, brainHalfUnits: 1.6, brainDepthUnits: 2.3, torsoHalfUnits: 2.2, gap: 12, cordGap: 10, cordHalfPx: 3 },
    },
    sheet: { min: 340, max: 560, default: 400, drawer: 480, headerH: 52, edge: 6, keyStep: 16, tabW: 28, miniHeaderH: 36, miniAfter: 52 },
    strip: { leadLeft: 14, leadW: 200, plotLeft: 236, plotLeftBare: 14, plotRightGap: 146, plotRightGapBare: 112, plotTop: 14, plotBottom: 50, plotBottomShort: 36, notesLane: 6, handleW: 8, minBracketW: 14, previewOthers: 0.35, selectedOthers: 0.34 },
  },
  /**
   * Figure framing in the free stage (the figure brief; CORTEX-UX §3.2 safe frame). Standing (default): the brain's
   * top about 9% below the stage top, the tip just above the command line, centred between the key bar's inset and
   * the tool column; Lying fits into the inset rectangle with a 4% margin. The camera (E10) fits to this rect.
   */
  figure: {
    standing: { left: 24, right: 70, topFraction: 0.09, bottom: 68, slideStepPx: 6, maxSlidePx: 36 },
    lying: { left: 24, top: 86, right: 70, bottom: 76, margin: 0.04 },
    /** Mini shows the brain only (crown and cerebellum), turning slowly, inside this inset on every side. */
    mini: { inset: 8 },
    overlayClearance: 8,
    shrinkStep: 0.02,
    reference: { width: 1576, height: 933, sheetOpenStageW: 1176 },
  },
  timing: {
    chipPreviewMs: 150,
    menuPreviewMs: 300,
    upToDateMs: 4000,
    toastMs: 8000,
    hintShowMs: 600,
    announceDebounceMs: 250,
    /** The shape morph: about 0.35 s toward Groups or a chart, about 0.55 s back to the figure. */
    shapeMs: 350,
    shapeBackMs: 550,
    snapMs: 150,
    /** The group label chips flash in at this morph, are gone by the second, and settle at 0.85 (the overlay fades 120 ms in, 100 ms out). */
    labelsFlash: [0.35, 0.55] as readonly [number, number],
    overlayFadeInMs: 120,
    overlayFadeOutMs: 100,
    snapWithin: 0.06,
    dockMs: 300,
    sheetOutMs: 180,
    stackMs: 260,
    labelHz: 30,
    compassHz: 15,
    stripCrossFadeMs: 250,
    replayMs: 8000,
    resizeSettleMs: 0,
    sparseUnder: 30,
  },
} as const;

export type ShellGeometry = typeof SHELL.geometry;

export function classify(width: number, height: number): Breakpoint {
  const w = SHELL.geometry.widths;
  if (width < w.S || height < SHELL.geometry.miniHeight) return "Mini";
  if (width < w.M) return "S";
  if (width < w.L) return "M";
  if (width < w.XL) return "L";
  return "XL";
}

/** The left rail shows at XL and L (never in immersive mode, which hides all chrome). */
export function railVisible(bp: Breakpoint, immersive = false): boolean {
  return !immersive && (bp === "XL" || bp === "L" || bp === "M");
}

/** The rail's width at this breakpoint (0 when it is hidden). */
export function railWidth(bp: Breakpoint, immersive = false): number {
  if (!railVisible(bp, immersive)) return 0;
  if (bp === "M") return SHELL.geometry.railWM;
  return isDesktopHost() ? SHELL.geometry.railWDesktop : SHELL.geometry.railW;
}

export type SheetMode = "push" | "overlay" | "full";

export function sheetMode(bp: Breakpoint): SheetMode {
  return bp === "XL" || bp === "L" ? "push" : bp === "M" ? "overlay" : "full";
}

/** The compass is hidden at S, in Mini and below 520 px of height. */
export function compassVisible(bp: Breakpoint, height: number): boolean {
  return bp !== "S" && bp !== "Mini" && height >= SHELL.geometry.tinyHeight;
}

export function compassSpec(bp: Breakpoint): (typeof SHELL.geometry.compass)["XL" | "L" | "M"] {
  return bp === "L" ? SHELL.geometry.compass.L : bp === "M" ? SHELL.geometry.compass.M : SHELL.geometry.compass.XL;
}

/** 64 px, or 44 px when the view is shorter than 640 px or at S; Mini has no strip. */
export function stripHeight(height: number, bp: Breakpoint): number {
  if (bp === "Mini") return 0;
  return height < SHELL.geometry.shortHeight || bp === "S" ? SHELL.geometry.stripShortH : SHELL.geometry.stripH;
}

/** Key bar rows: one row below 640 px of height. */
export function keyRows(height: number): 1 | 2 {
  return height < SHELL.geometry.shortHeight ? 1 : 2;
}

export function headerHeight(bp: Breakpoint): number {
  return bp === "Mini" ? SHELL.geometry.miniHeaderH : SHELL.geometry.headerH;
}

/** Command line width: 640 (XL), 560 (L, M), stage width − 32 at S, never wider than the stage allows. */
export function commandWidth(bp: Breakpoint, stageWidth: number): number {
  const c = SHELL.geometry.command;
  const spec = bp === "XL" ? c.XL : bp === "L" || bp === "M" ? c.L : Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(spec, stageWidth - c.sideMargin));
}

/** Width the key bar may take: ≤ 44% of the stage, so the standing figure's brain clears it. */
export function keyBarMaxWidth(stageWidth: number): number {
  return Math.floor(stageWidth * SHELL.geometry.keyBar.maxFraction);
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the camera fits into the safe frame: the whole figure, or (Mini) the brain alone. */
export type FigureFit = "figure" | "brain";

export function figureFit(bp: Breakpoint): FigureFit {
  return bp === "Mini" ? "brain" : "figure";
}

/**
 * The free stage the camera fits the figure into (stage-local CSS px). Standing is fitted by height between the
 * brain-top line and the command line's top; Lying fits the inset rectangle; Mini (no overlays) fits the brain
 * alone into the whole stage. The camera adds its own margin and, for Standing, slides then shrinks the figure
 * (SHELL.figure.standing.slideStepPx / maxSlidePx / shrinkStep) to clear the overlay rectangles.
 */
export function safeFrame(stageWidth: number, stageHeight: number, pose: "standing" | "lying", bp?: Breakpoint): Rect {
  if (bp === "Mini") {
    const m = SHELL.figure.mini.inset;
    return { x: m, y: m, w: Math.max(0, stageWidth - 2 * m), h: Math.max(0, stageHeight - 2 * m) };
  }
  if (pose === "lying") {
    const f = SHELL.figure.lying;
    return { x: f.left, y: f.top, w: Math.max(0, stageWidth - f.left - f.right), h: Math.max(0, stageHeight - f.top - f.bottom) };
  }
  const f = SHELL.figure.standing;
  const top = Math.round(stageHeight * f.topFraction);
  return { x: f.left, y: top, w: Math.max(0, stageWidth - f.left - f.right), h: Math.max(0, stageHeight - f.bottom - top) };
}

/** Viewport-relative flags the CSS needs besides the breakpoint class. */
export function viewFlags(height: number): { short: boolean; tiny: boolean } {
  return { short: height < SHELL.geometry.shortHeight, tiny: height < SHELL.geometry.tinyHeight };
}

interface ResizeObserverLike {
  observe(el: Element): void;
  disconnect(): void;
}
type ResizeObserverCtor = new (cb: (entries: readonly { contentRect: { width: number; height: number } }[]) => void) => ResizeObserverLike;

/**
 * Observe an element's content box with the ResizeObserver of the element's OWN window (pop-out windows,
 * POPOUT-WINDOWS). Calls back once with the current size, then on every change (deduplicated). Returns a
 * disconnect function. Falls back to a single measurement where ResizeObserver does not exist.
 */
export function observeSize(el: HTMLElement, cb: (width: number, height: number) => void): () => void {
  const win = (el.ownerDocument?.defaultView ?? (globalThis as unknown as Window)) as unknown as { ResizeObserver?: ResizeObserverCtor };
  let last = "";
  const emit = (w: number, h: number) => {
    const key = `${Math.round(w)}x${Math.round(h)}`;
    if (key === last) return;
    last = key;
    cb(Math.round(w), Math.round(h));
  };
  const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : { width: 0, height: 0 };
  emit(el.clientWidth || rect.width, el.clientHeight || rect.height);
  const Ctor = win.ResizeObserver;
  if (!Ctor) return () => undefined;
  // Resizes are applied on the next frame: changing layout inside the observer callback makes the browser report
  // "ResizeObserver loop completed with undelivered notifications" for every size change.
  const raf = (win as unknown as { requestAnimationFrame?: (f: () => void) => number; cancelAnimationFrame?: (h: number) => void });
  let pending = 0;
  let closed = false;
  const ro = new Ctor((entries) => {
    const e = entries[entries.length - 1];
    if (!e) return;
    const w = e.contentRect.width, h = e.contentRect.height;
    if (typeof raf.requestAnimationFrame !== "function") {
      emit(w, h);
      return;
    }
    if (pending) raf.cancelAnimationFrame?.(pending);
    pending = raf.requestAnimationFrame(() => {
      pending = 0;
      if (!closed) emit(w, h);
    });
  });
  ro.observe(el);
  return () => {
    closed = true;
    if (pending) raf.cancelAnimationFrame?.(pending);
    ro.disconnect();
  };
}

/** The sheet is folded to its header bar: only the Chart page folds, and only while it is the entry on top. */
export function sheetFolded(sheet: { collapsed?: boolean; stack?: readonly SheetEntry[]; index?: number }): boolean {
  if (sheet.collapsed !== true || !sheet.stack) return false;
  const top = sheet.stack[sheet.index ?? 0];
  return top?.kind === "page" && top.route === "chart";
}

/** The page a sheet's stack starts from (the page on its bottom entry), or undefined when it starts from a reader. */
function rootRoute(sheet: { stack?: readonly SheetEntry[] }): string | undefined {
  const first = sheet.stack?.[0];
  return first?.kind === "page" ? first.route : undefined;
}

/**
 * The pages that open on the left beside the rail by default: every rail page (Read, Time, Agents and Checks, Files,
 * You, Guide, Add). Chart and the pages reached from inside another page open on the right, as readers do.
 */
export const LEFT_PAGES: readonly SheetPageRoute[] = ["read", "time", "agents", "sources", "guide", "you", "add"];

/**
 * Where a sheet docks by default: a rail page on the left (a window narrower than XL keeps Read and Add on the left and the rest
 * on the right, as the overlay did), every other page and reader on the right. `bp` is omitted when unknown.
 */
export function defaultSheetSide(sheet: { stack?: readonly SheetEntry[] }, bp?: Breakpoint): SheetSide {
  const root = rootRoute(sheet) as SheetPageRoute | undefined;
  if (!root) return "right";
  if (bp !== undefined && sheetMode(bp) !== "push") return root === "read" || root === "add" ? "left" : "right";
  return LEFT_PAGES.includes(root) ? "left" : "right";
}

/** The page nearest the top of the stack (the one a dock choice belongs to), or undefined when only readers are on it. */
function topPageRoute(sheet: { stack?: readonly SheetEntry[]; index?: number }): SheetPageRoute | undefined {
  const stack = sheet.stack ?? [];
  for (let i = Math.min(sheet.index ?? stack.length - 1, stack.length - 1); i >= 0; i--) {
    const e = stack[i];
    if (e?.kind === "page") return e.route;
  }
  return undefined;
}

/** The page parked as a vertical tab at its edge while another opens on the opposite one (see SheetState.stash). */
export type SheetStash = { stack: readonly SheetEntry[]; index: number; side: SheetSide };

/** The parked tab is showing: wide windows only (a narrower one has no second edge), the sheet open and not folded to its own tab. */
export function stashTab(ui: { immersive?: boolean; breakpoint: Breakpoint; sheet: { open: boolean; collapsed?: boolean; stack?: readonly SheetEntry[]; index?: number; stash?: SheetStash } }): SheetStash | null {
  const stash = ui.sheet.stash;
  if (!stash || ui.immersive || !ui.sheet.open || sheetMode(ui.breakpoint) !== "push" || sheetTabbed(ui.sheet)) return null;
  return stash;
}

/**
 * The edge the sheet docks to: the one chosen for it, else the dock remembered for the page on top (XL and L only: a
 * narrower window ignores it), else the first page's default.
 */
export function sheetSide(sheet: { side?: SheetSide; stack?: readonly SheetEntry[]; index?: number; docks?: Partial<Record<SheetPageRoute, SheetSide>>; stash?: SheetStash }, bp?: Breakpoint): SheetSide {
  if (sheet.side) return sheet.side;
  // A page parked as a tab keeps its edge: the page open beside it takes the other one (XL and L).
  if (sheet.stash && (bp === undefined || sheetMode(bp) === "push")) return sheet.stash.side === "left" ? "right" : "left";
  const route = topPageRoute(sheet);
  const docked = route && (bp === undefined || sheetMode(bp) === "push") ? sheet.docks?.[route] : undefined;
  return docked ?? defaultSheetSide(sheet, bp);
}

/** The drawer is open on the left, wide: the stage steps aside, the find field goes and the figure dims (Read). */
export function drawerOpenLeft(ui: { immersive?: boolean; breakpoint: Breakpoint; sheet: { open: boolean; collapsed?: boolean; side?: SheetSide; stack?: readonly SheetEntry[]; index?: number; docks?: Partial<Record<SheetPageRoute, SheetSide>>; parked?: boolean; float?: boolean } }): boolean {
  if (ui.immersive || ui.breakpoint === "Mini" || !ui.sheet.open || sheetTabbed(ui.sheet) || sheetSide(ui.sheet, ui.breakpoint) !== "left") return false;
  // Only Read is a drawer: the Chart page or the timeline docked left leave the figure and the find field as they are, and so does a reader beside a page.
  return rootRoute(ui.sheet) === "read" && sheetPair(ui) === null;
}

// ───────────────────────────── two columns: a page and a reader (XL, L) ─────────────────────────────

/** The pages that can stay open in a column while the reader takes the other one: Chart, the navigator (Read) and the timeline. */
export const PAIR_PAGES: readonly SheetPageRoute[] = ["read", "time", "chart", "add", "agents", "sources", "guide", "you"];

/** Two-column limits: each column's least width, the least the stage keeps between them, and the reader column's width. */
export const PAIR = { colMin: 300, stageMin: 320, readerWidth: 400 } as const;

/** Where a page docks when nothing was chosen for it: every rail page on the left, the rest on the right. */
export function pageDock(sheet: { docks?: Partial<Record<SheetPageRoute, SheetSide>> }, route: SheetPageRoute): SheetSide {
  return sheet.docks?.[route] ?? (LEFT_PAGES.includes(route) ? "left" : "right");
}

export interface SheetPair {
  /** Index of the page entry in the stack, and the entry itself. */
  pageIndex: number;
  page: Extract<SheetEntry, { kind: "page" }>;
  /** The reader on top of the stack. */
  reader: Extract<SheetEntry, { kind: "reader" }>;
  pageSide: SheetSide;
  readerSide: SheetSide;
  /** The page is reduced to a slim vertical tab at its edge. */
  parked: boolean;
  /** Column widths in px (the parked page's is the tab's). */
  pageWidth: number;
  readerWidth: number;
}

/**
 * The sheet holds two columns: a page (Chart, Read, Time) docked on one side, the reader in the opposite column, the stage
 * between them. Only at XL and L, with the sheet open and not reduced to its edge tab, a reader on top of a page of
 * those, and enough width left for both columns and a stage of PAIR.stageMin; otherwise the single stack stands
 * (CORTEX-UX section 3.4). `viewWidth` is the view's width (omitted: unknown, so the room is assumed).
 */
export function sheetPair(
  ui: { breakpoint: Breakpoint; immersive?: boolean; sheet: { open: boolean; width?: number; collapsed?: boolean; stack?: readonly SheetEntry[]; index?: number; docks?: Partial<Record<SheetPageRoute, SheetSide>>; parked?: boolean; float?: boolean; stash?: SheetStash } },
  viewWidth = Number.POSITIVE_INFINITY,
): SheetPair | null {
  const sheet = ui.sheet;
  if (ui.immersive || !sheet.open || sheetMode(ui.breakpoint) !== "push" || sheetTabbed(sheet) || !sheet.stack || sheet.stash) return null;
  const index = Math.min(sheet.index ?? sheet.stack.length - 1, sheet.stack.length - 1);
  const reader = sheet.stack[index];
  if (!reader || reader.kind !== "reader") return null;
  let pageIndex = index - 1;
  while (pageIndex >= 0 && sheet.stack[pageIndex]?.kind === "reader") pageIndex--;
  const page = pageIndex >= 0 ? sheet.stack[pageIndex] : undefined;
  if (!page || page.kind !== "page" || !PAIR_PAGES.includes(page.route)) return null;
  // The Chart page as a floating left card keeps its own layout: a reader then replaces it as before.
  if (sheet.float === true && page.route === "chart") return null;
  const g = SHELL.geometry.sheet;
  const parked = sheet.parked === true;
  const room = Number.isFinite(viewWidth) ? viewWidth - railWidth(ui.breakpoint, ui.immersive) - PAIR.stageMin : Number.POSITIVE_INFINITY;
  let pageWidth = parked ? g.tabW : Math.max(PAIR.colMin, Math.min(g.max, sheet.width ?? g.default));
  let readerWidth: number = PAIR.readerWidth;
  const over = pageWidth + readerWidth - room;
  if (over > 0) {
    const cut = parked ? 0 : Math.min(over, pageWidth - PAIR.colMin);
    pageWidth -= cut;
    readerWidth -= over - cut;
    if (readerWidth < PAIR.colMin) return null;
  }
  const pageSide = pageDock(sheet, page.route);
  return { pageIndex, page, reader, pageSide, readerSide: pageSide === "left" ? "right" : "left", parked, pageWidth, readerWidth };
}

/** The id of the reader open beside a page (so the page's list can mark it), or undefined outside two columns. */
export function openBesideId(ui: Parameters<typeof sheetPair>[0]): string | undefined {
  return sheetPair(ui)?.reader.id;
}

/**
 * The Chart page floats as a bordered card on the left, over a full-width stage (the table builder of the reference): the
 * setting is on, the sheet is the open Chart page at a wide breakpoint, and it is not folded or turned into a tab. Narrow
 * windows keep the docked right sheet.
 */
export function sheetFloats(ui: { immersive?: boolean; breakpoint: Breakpoint; sheet: { open: boolean; float?: boolean; collapsed?: boolean; stack?: readonly SheetEntry[]; index?: number } }): boolean {
  if (ui.immersive || !ui.sheet.open || ui.sheet.float !== true || sheetMode(ui.breakpoint) !== "push" || sheetFolded(ui.sheet) || sheetTabbed(ui.sheet)) return false;
  const top = ui.sheet.stack?.[ui.sheet.index ?? 0];
  return top?.kind === "page" && top.route === "chart";
}

/** The floating Chart card is open beside a page (not as the page on top of the stack): wide windows, the sheet open and not a tab. */
export function chartCardAside(ui: { immersive?: boolean; breakpoint: Breakpoint; sheet: { open: boolean; card?: boolean; collapsed?: boolean; stack?: readonly SheetEntry[]; index?: number } }): boolean {
  return !ui.immersive && ui.sheet.open && ui.sheet.card === true && sheetMode(ui.breakpoint) === "push" && !sheetTabbed(ui.sheet);
}

/** The Chart key (or a click on the figure's Chart button) can bring the card up beside the page that is open: card setting on, a rail page open at XL or L. */
export function chartCardFits(ui: { immersive?: boolean; breakpoint: Breakpoint; sheet: { open: boolean; float?: boolean; card?: boolean; collapsed?: boolean; stack?: readonly SheetEntry[]; index?: number } }): boolean {
  const root = rootRoute(ui.sheet);
  return !ui.immersive && ui.sheet.open && ui.sheet.float === true && sheetMode(ui.breakpoint) === "push" && !sheetTabbed(ui.sheet) && root !== undefined && root !== "chart" && !sheetFolded(ui.sheet);
}

/** The floating Chart card: its width, and the gap it keeps from the rail and the header. */
export const CHART_CARD = { width: 244, gap: 12 } as const;

/** The stage box inside the view: below the header, above the strip, right of the rail, beside a pushing sheet (either edge). */
export function stageBox(
  view: { width: number; height: number },
  ui: { breakpoint: Breakpoint; immersive: boolean; sheet: { open: boolean; width: number; collapsed?: boolean; side?: SheetSide; stack?: readonly SheetEntry[]; index?: number; docks?: Partial<Record<SheetPageRoute, SheetSide>>; parked?: boolean; float?: boolean; stash?: SheetStash } },
): { width: number; height: number; insetRight: number; insetLeft: number; top: number } {
  const bp = ui.breakpoint;
  const top = ui.immersive ? 0 : headerHeight(bp);
  const strip = ui.immersive ? 0 : stripHeight(view.height, bp);
  const rail = railWidth(bp, ui.immersive);
  // Two columns (a page and a reader): each takes its room on its own side of the stage.
  const pair = sheetPair(ui, view.width);
  if (pair) {
    const insetLeft = (pair.pageSide === "left" ? pair.pageWidth : 0) + (pair.readerSide === "left" ? pair.readerWidth : 0);
    const insetRight = (pair.pageSide === "right" ? pair.pageWidth : 0) + (pair.readerSide === "right" ? pair.readerWidth : 0);
    return { width: Math.max(0, view.width - rail - insetLeft - insetRight), height: Math.max(0, view.height - top - strip), insetRight, insetLeft, top };
  }
  // A folded sheet (the Chart page reduced to its header bar) floats over the stage, which takes the room back.
  const push = !ui.immersive && ui.sheet.open && !sheetFolded(ui.sheet) && sheetMode(bp) === "push" && !sheetFloats(ui);
  // A tabbed sheet keeps only its thin tab at the edge.
  const room = push ? (sheetTabbed(ui.sheet) ? SHELL.geometry.sheet.tabW : clampSheetWidth(sheetWidth(ui.sheet), view.width - rail)) : 0;
  const left = sheetSide(ui.sheet, bp) === "left";
  // The page parked as a tab keeps a thin strip at its edge.
  const tab = stashTab(ui)?.side;
  const tabW = tab ? SHELL.geometry.sheet.tabW : 0;
  const insetRight = (left ? 0 : room) + (tab === "right" ? tabW : 0);
  const insetLeft = (left ? room : 0) + (tab === "left" ? tabW : 0);
  return { width: Math.max(0, view.width - rail - room - tabW), height: Math.max(0, view.height - top - strip), insetRight, insetLeft, top };
}

/**
 * What a floating (overlay) sheet covers of the stage on the right, in CSS px: the canvas keeps its size under it, so the
 * figure and the charts are fitted clear of that strip. 0 when the sheet pushes the stage aside (its room is already out
 * of the stage's width), sits on the left, is folded or tabbed, or is closed.
 */
export function sheetCover(
  view: { width: number; height: number },
  ui: { breakpoint: Breakpoint; immersive: boolean; sheet: { open: boolean; width: number; collapsed?: boolean; side?: SheetSide; stack?: readonly SheetEntry[]; index?: number; docks?: Partial<Record<SheetPageRoute, SheetSide>> } },
): number {
  const sheet = ui.sheet;
  if (ui.immersive || !sheet.open || sheetFolded(sheet) || sheetTabbed(sheet) || sheetSide(sheet, ui.breakpoint) === "left" || sheetMode(ui.breakpoint) !== "overlay") return 0;
  return clampSheetWidth(sheetWidth(sheet), view.width - railWidth(ui.breakpoint, ui.immersive));
}

/**
 * The width a sheet is drawn at: the saved one, except that a sheet still on the default width is the wide drawer
 * (SHELL.geometry.sheet.drawer) while it docks on the left (Read and what opens from it), because the folder
 * tree and the list each need room for their names. A width the person dragged to is kept as it is.
 */
export function sheetWidth(sheet: { width: number; side?: SheetSide; stack?: readonly SheetEntry[]; index?: number; docks?: Partial<Record<SheetPageRoute, SheetSide>> }): number {
  const g = SHELL.geometry.sheet;
  return sheet.width === g.default && sheetSide(sheet) === "left" && rootRoute(sheet) === "read" ? g.drawer : sheet.width;
}

/** Sheet width 340–560 (default 400), never leaving the stage narrower than the sheet's minimum. */
export function clampSheetWidth(width: number, viewWidth = Number.POSITIVE_INFINITY): number {
  const g = SHELL.geometry.sheet;
  const w = Number.isFinite(width) ? width : g.default;
  const room = Number.isFinite(viewWidth) ? Math.max(g.min, viewWidth - g.min) : g.max;
  return Math.round(Math.max(g.min, Math.min(g.max, room, w)));
}
