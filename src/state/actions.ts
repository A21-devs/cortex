/**
 * Named state transitions used by UI components, commands, keyboard shortcuts, hints and Ask's executor, so
 * behaviour is replayable and view changes can be undone. Owner: E7. All act on ONE leaf store.
 */
import type { DimId } from "../shared/dims";
import type { ColourMode, QueryToken, TimeWindow } from "../shared/protocol/worker";
import type { SpaceId } from "../shared/types";
import { PAGE_ROUTE, SHEET_STACK_MAX, SHEET_WIDTH, type PageId, type ReaderRoute, type SheetEntry, type SheetPageRoute, type ShapeKind } from "../shared/views";
import type { CortexStore } from "./store";
import { markInstantRestore } from "./instantRestore";
import { isHighlightToken, sheetTabbed } from "./selectors";
import type { LookControls, MotionControls, PopoverId, SheetPreview, SheetSide, SpineOrder, ViewControls } from "./types";

// ───────────────────────────── sheet and tabs ─────────────────────────────

/** Header page: replaces the sheet stack with the page's route (§3.4 rule 1); "brain" closes the sheet. */
export function openTab(store: CortexStore, page: PageId): void {
  const route = PAGE_ROUTE[page];
  // The Brain tab closes the sheet the same way x does (a chart the Chart page opened goes back to the brain).
  if (route === null && chartPageOnTop(store)) return closeSheet(store);
  leaveChartPage(store, route);
  store.update("ui", (ui) => ({
    ...ui,
    tab: page,
    sheetPreview: null,
    // A page picked from the header or the rail docks where that page lives (Read on the left) and un-tabs the sheet.
    sheet: route === null ? { ...ui.sheet, open: false, stash: undefined, card: undefined, ...unparked(ui.sheet) } : { ...ui.sheet, open: true, stack: [{ kind: "page", route }], index: 0, side: undefined, ...(ui.sheet.collapsed ? { collapsed: false } : {}), ...unparked(ui.sheet) },
  }));
}

/** Open a sheet page from anywhere: replaces the stack (like a header page) unless `push` is set. */
export function openPage(store: CortexStore, route: SheetPageRoute, params?: Record<string, string>, push = false): void {
  const entry: SheetEntry = params ? { kind: "page", route, params } : { kind: "page", route };
  if (push) return pushSheet(store, entry);
  leaveChartPage(store, route);
  store.update("ui", (ui) => ({ ...ui, sheetPreview: null, sheet: { ...ui.sheet, open: true, stack: [entry], index: 0, side: undefined, ...(route === "chart" && ui.sheet.card ? { card: undefined } : {}), ...(ui.sheet.collapsed ? { collapsed: false } : {}), ...unparked(ui.sheet) } }));
}

/** From the Today reader: the Read page below it (or a fresh one) with its Today filter on, the list of today's entries. */
export function showTodayEntries(store: CortexStore): void {
  const ui = store.get("ui");
  const top = ui.sheet.stack[ui.sheet.index];
  const at = top?.kind === "reader" ? ui.sheet.index - 1 : ui.sheet.index;
  const below = ui.sheet.open ? ui.sheet.stack[at] : undefined;
  if (below?.kind !== "page" || below.route !== "read") return openPage(store, "read", { today: "1" });
  store.update("ui", (u) => {
    const stack = u.sheet.stack.slice(0, at);
    stack.push({ kind: "page", route: "read", params: { ...(below.params ?? {}), today: "1" } });
    return { ...u, sheetPreview: null, sheet: { ...u.sheet, stack, index: stack.length - 1 } };
  });
}

/** Push an entry (a reader opened from inside a page); forward history is dropped; capped at 12 entries. */
export function pushSheet(store: CortexStore, entry: SheetEntry): void {
  store.update("ui", (ui) => {
    // A reader opened from the stage while the sheet was closed starts a fresh stack: what was open before no longer leads here (no stale crumb or back arrow).
    const kept = ui.sheet.open ? ui.sheet.stack.slice(0, ui.sheet.index + 1) : [];
    const stack = [...kept, entry].slice(-SHEET_STACK_MAX);
    // A reader opened from the stage while the sheet was closed docks on the right; one opened inside an open sheet stays where it is.
    const side = ui.sheet.open ? ui.sheet.side : ("right" as const);
    return { ...ui, sheetPreview: null, sheet: { ...ui.sheet, open: true, stack, index: stack.length - 1, side, ...(ui.sheet.collapsed ? { collapsed: false } : {}), ...(entry.kind === "page" ? unparked(ui.sheet) : {}) } };
  });
}

export function sheetBack(store: CortexStore): void {
  store.update("ui", (ui) => (ui.sheet.index > 0 ? { ...ui, sheetPreview: null, sheet: { ...ui.sheet, index: ui.sheet.index - 1, ...unparked(ui.sheet) } } : ui));
}

/**
 * A page was opened while another stood on its edge: park that page (its whole stack) as a vertical tab. `before` is the
 * sheet as it was; the page now on top takes the opposite edge (the sheet's side follows the tab).
 */
export function parkBehind(store: CortexStore, before: { stack: readonly SheetEntry[]; index: number }, side: SheetSide): void {
  store.update("ui", (ui) => ({ ...ui, sheet: { ...ui.sheet, side: undefined, stash: { stack: [...before.stack], index: before.index, side } } }));
}

/** The vertical tab was pressed: the parked page comes back, and the page that stood open takes its place as the tab. */
export function swapParked(store: CortexStore): void {
  store.update("ui", (ui) => {
    const stash = ui.sheet.stash;
    if (!stash) return ui;
    const side: SheetSide = stash.side === "left" ? "right" : "left";
    return { ...ui, sheetPreview: null, sheet: { ...ui.sheet, open: true, stack: stash.stack, index: stash.index, side: undefined, stash: { stack: ui.sheet.stack, index: ui.sheet.index, side }, ...(ui.sheet.collapsed ? { collapsed: false } : {}) } };
  });
}

/** What a sheet change that ends two columns clears: the page parked as a tab (spread into the sheet; nothing when it was not parked). */
function unparked(sheet: { parked?: boolean }): { parked?: boolean } {
  return sheet.parked ? { parked: false } : {};
}

/**
 * Close the reader that has the second column: the page it stands beside is the entry on top again (forward history is
 * kept, so Alt + Right brings the reader back). Returns false when no page lies below the reader (nothing to go back to).
 */
export function closeReader(store: CortexStore): boolean {
  const sheet = store.get("ui").sheet;
  let i = sheet.index - 1;
  while (i >= 0 && sheet.stack[i]?.kind === "reader") i--;
  if (!sheet.open || sheet.stack[sheet.index]?.kind !== "reader" || i < 0) return false;
  store.update("ui", (ui) => ({ ...ui, sheetPreview: null, sheet: { ...ui.sheet, index: i, ...unparked(ui.sheet) } }));
  return true;
}

/** Remember which edge a page docks to (XL and L); the open sheet moves there at once. */
export function setPageDock(store: CortexStore, route: SheetPageRoute, side: SheetSide): void {
  store.update("ui", (ui) => {
    if (ui.sheet.docks?.[route] === side && ui.sheet.side === undefined) return ui;
    return { ...ui, sheet: { ...ui.sheet, docks: { ...ui.sheet.docks, [route]: side }, side: undefined } };
  });
}

/** Park the page beside an open reader as a slim vertical tab at its edge, or bring it back. */
export function setPagePark(store: CortexStore, parked: boolean): void {
  store.update("ui", (ui) => ((ui.sheet.parked ?? false) === parked ? ui : { ...ui, sheet: { ...ui.sheet, parked } }));
}

/**
 * Open a reader from a page's list. With two columns showing (a reader already stands beside the page) it takes the place of
 * that reader, so clicking down a list does not pile entries on the back stack; otherwise it is pushed as usual.
 */
export function openBeside(store: CortexStore, entry: Extract<SheetEntry, { kind: "reader" }>): void {
  const ui = store.get("ui");
  const sheet = ui.sheet;
  const top = sheet.open && !sheetTabbed(sheet) ? sheet.stack[sheet.index] : undefined;
  const below = sheet.stack[sheet.index - 1];
  if (top?.kind === "reader" && below?.kind === "page" && (ui.breakpoint === "XL" || ui.breakpoint === "L")) {
    store.update("ui", (u) => {
      const stack = u.sheet.stack.slice(0, u.sheet.index);
      stack.push(entry);
      return { ...u, sheetPreview: null, sheet: { ...u.sheet, stack, index: stack.length - 1 } };
    });
    return;
  }
  pushSheet(store, entry);
}

export function sheetForward(store: CortexStore): void {
  store.update("ui", (ui) => (ui.sheet.index < ui.sheet.stack.length - 1 ? { ...ui, sheetPreview: null, sheet: { ...ui.sheet, index: ui.sheet.index + 1 } } : ui));
}

/** Show another map's reader in the open map's place without touching the stack (hovering a map on the stage); null restores the open map. */
export function setSheetPreview(store: CortexStore, preview: SheetPreview | null): void {
  const cur = store.get("ui").sheetPreview;
  if (cur === preview || (cur && preview && cur.kind === preview.kind && cur.ordinal === preview.ordinal)) return;
  store.update("ui", { sheetPreview: preview });
}

/** Sheet pointer left it for the stage: with "Collapse when I leave" on, the sheet shrinks to its edge tab (the Chart page folds by its own chevron instead). */
export function collapseSheetOnLeave(store: CortexStore, enabled: boolean): void {
  if (!enabled) return;
  const sheet = store.get("ui").sheet;
  if (!sheet.open || sheet.collapsed || !sheetTabbed({ ...sheet, collapsed: true })) return;
  store.update("ui", (ui) => ({ ...ui, sheetPreview: null, sheet: { ...ui.sheet, collapsed: true } }));
}

/**
 * The Chart page opened the chart shape itself (the Chart tool or its key): closing the page then sends the figure back
 * to the brain. A chart already out when the page closes goes back too; a Groups figure is left on screen.
 */
const chartOpenedByPage = new WeakSet<CortexStore>();
const chartCloseHooks = new WeakMap<CortexStore, () => void>();

export function markChartOpenedByPage(store: CortexStore, on: boolean): void {
  if (on) chartOpenedByPage.add(store);
  else chartOpenedByPage.delete(store);
}

/** True once, then false: the close consumes the flag. */
export function takeChartOpenedByPage(store: CortexStore): boolean {
  return chartOpenedByPage.delete(store);
}

/** The mounted Chart page registers how its figure goes back to the brain (animated); null removes it. */
export function setChartCloseHook(store: CortexStore, hook: (() => void) | null): void {
  if (hook) chartCloseHooks.set(store, hook);
  else chartCloseHooks.delete(store);
}

function chartPageOnTop(store: CortexStore): boolean {
  const sheet = store.get("ui").sheet;
  const top = sheet.open ? sheet.stack[sheet.index] : undefined;
  return (top?.kind === "page" && top.route === "chart") || (sheet.open && sheet.card === true);
}

/**
 * Keep the floating Chart card open beside a page: a rail click while the card is up, or the Chart key while a page is
 * open. Call it before the page opens (or, for the key, instead of opening the Chart page): the card is then drawn
 * beside the page, and the page that replaces the stack does not take the chart back to the brain.
 */
export function keepChartCard(store: CortexStore): void {
  store.update("ui", (ui) => (ui.sheet.card === true ? ui : { ...ui, sheet: { ...ui.sheet, card: true } }));
}

/** The aside Chart card's x: the card goes and the figure returns to the brain; the page stays. */
export function closeChartCard(store: CortexStore): void {
  leaveChartPage(store, null);
  store.update("ui", (ui) => (ui.sheet.card ? { ...ui, sheet: { ...ui.sheet, card: undefined } } : ui));
}

/**
 * The Chart page is leaving the sheet (closed, or another page replaces it): a chart the page brought up goes back to
 * the brain with the shape-back morph (so does a chart that was already out); Groups stays. `next` is the route that replaces it.
 */
function leaveChartPage(store: CortexStore, next: SheetPageRoute | null): void {
  if (next === "chart" || !chartPageOnTop(store)) return;
  // The card stays open beside the page that replaces what was on the stack.
  if (next !== null && store.get("ui").sheet.card === true) return;
  const hook = chartCloseHooks.get(store);
  if (hook) hook();
  else if (takeChartOpenedByPage(store) || store.get("view").shape === "chart") store.update("view", { shape: "body", morph: 0 });
}

export function closeSheet(store: CortexStore): void {
  leaveChartPage(store, null);
  store.update("ui", (ui) => ({ ...ui, tab: "brain", sheetPreview: null, sheet: { ...ui.sheet, open: false, stash: undefined, card: undefined, ...(ui.sheet.collapsed ? { collapsed: false } : {}), ...unparked(ui.sheet) } }));
}

/** Collapse the sheet to its header bar (the Chart page's chevron), or restore it. */
export function setSheetCollapsed(store: CortexStore, collapsed: boolean): void {
  store.update("ui", (ui) => (ui.sheet.collapsed === collapsed ? ui : { ...ui, sheet: { ...ui.sheet, collapsed } }));
}

export function setSheetWidth(store: CortexStore, width: number): void {
  const w = Math.max(SHEET_WIDTH.min, Math.min(SHEET_WIDTH.max, Math.round(width)));
  store.update("ui", (ui) => ({ ...ui, sheet: { ...ui.sheet, width: w } }));
}

/** Open a reader for an item: selects it and pushes the reader. */
export function openItem(store: CortexStore, ordinal: number, id: string, route: ReaderRoute = "entry"): void {
  store.batch(() => {
    store.update("selection", () => ({ ordinal, id }));
    pushSheet(store, { kind: "reader", route, id });
  });
}

// ───────────────────────────── selection, tokens, period, scope ─────────────────────────────

export function select(store: CortexStore, ordinal: number, id: string): void {
  store.update("selection", () => ({ ordinal, id }));
}

/** Click on empty stage: clears the selection but keeps the tokens. */
export function clearSelection(store: CortexStore): void {
  store.update("selection", () => null);
}

export function addToken(store: CortexStore, token: QueryToken): void {
  store.update("ui", (ui) => ({ ...ui, tokens: [...ui.tokens.filter((t) => t.id !== token.id), token] }));
}

export function removeToken(store: CortexStore, id: string): void {
  store.update("ui", (ui) => ({ ...ui, tokens: ui.tokens.filter((t) => t.id !== id) }));
}

/** Remove one chart highlight; other tokens with the same id are left alone. */
export function removeHighlight(store: CortexStore, tokenId: string): void {
  store.update("ui", (ui) => ({ ...ui, tokens: ui.tokens.filter((t) => !(t.id === tokenId && isHighlightToken(t))) }));
}

/** Clear every chart highlight and keep the other tokens. */
export function clearHighlights(store: CortexStore): void {
  store.update("ui", (ui) => (ui.tokens.some(isHighlightToken) ? { ...ui, tokens: ui.tokens.filter((t) => !isHighlightToken(t)) } : ui));
}

/** Backspace in an empty command line removes the last token. */
export function removeLastToken(store: CortexStore): void {
  store.update("ui", (ui) => ({ ...ui, tokens: ui.tokens.slice(0, -1) }));
}

export function clearTokens(store: CortexStore): void {
  store.update("ui", { tokens: [] });
}

/** null = All time. */
export function setPeriod(store: CortexStore, period: TimeWindow | null): void {
  store.update("ui", { period });
}

export function setScope(store: CortexStore, scope: SpaceId | "all"): void {
  store.update("ui", { scope });
}

/** [ and ] step through areas (no wheel stepping, no click-to-cycle: ORIG-16). */
export function stepScope(order: readonly SpaceId[], cur: SpaceId | "all", dir: 1 | -1): SpaceId | "all" {
  const cycle: (SpaceId | "all")[] = ["all", ...order];
  const i = Math.max(0, cycle.indexOf(cur));
  const n = cycle.length;
  return cycle[(((i + dir) % n) + n) % n] as SpaceId | "all";
}

// ───────────────────────────── shape, colour, display ─────────────────────────────

export function setShape(store: CortexStore, shape: ShapeKind): void {
  store.update("view", { shape });
}

export function setMorph(store: CortexStore, morph: number): void {
  store.update("view", { morph: Math.max(0, Math.min(1, morph)) });
}

/** G: Body → Groups → Chart → Body (Chart only when the chart feature is on). */
export function nextShape(cur: ShapeKind, chartOn: boolean): ShapeKind {
  if (cur === "body") return "groups";
  if (cur === "groups") return chartOn ? "chart" : "body";
  return "body";
}

export function setView<K extends keyof ViewControls>(store: CortexStore, key: K, value: ViewControls[K]): void {
  store.update("view", { [key]: value } as Partial<ViewControls>);
}

export function setGroupBy(store: CortexStore, dim: DimId): void {
  store.batch(() => {
    // The key follows the grouping (LEG-09, LEG-23): always on the Groups shape, otherwise when "Key follows groups" is on.
    store.update("view", (v) => ({ ...v, groupBy: dim, ...(v.syncKeyToGroups || v.shape === "groups" ? { colour: { ...v.colour, notes: { kind: "categorical" as const, dim } } } : {}) }));
    store.update("ui", { hiddenGroups: [] });
  });
}

/** Which end of the spine sits against the brain. */
export function setSpineOrder(store: CortexStore, order: SpineOrder): void {
  store.update("view", { spineOrder: order });
}

/** The dimension that groups the record entries; null = the same as the notes. */
export function setGroupByRecord(store: CortexStore, dim: DimId | null): void {
  store.update("view", { groupByRecord: dim });
}

/** Group notes and record entries by their own dimensions; turning it off puts the record back on the notes' dimension. */
export function setSplitGroups(store: CortexStore, on: boolean): void {
  store.update("view", (v) => ({ ...v, splitGroups: on, groupByRecord: on ? v.groupByRecord : null }));
}

export function setSyncKeyToGroups(store: CortexStore, on: boolean): void {
  store.update("view", { syncKeyToGroups: on });
}

/** Hover preview of a dimension from the dimension menu; null clears it. Never saved. */
export function setDimPreview(store: CortexStore, dim: DimId | null, pop: "notes" | "record" | "both" = "both"): void {
  store.update("ui", { dimPreview: dim, dimPreviewPop: pop });
}

export function setColourMode(store: CortexStore, population: "notes" | "record", mode: ColourMode): void {
  store.update("view", (v) => ({ ...v, colour: { ...v.colour, [population]: mode } }));
}

export function setLayer(store: CortexStore, layer: keyof ViewControls["layers"], on: boolean): void {
  store.update("view", (v) => ({ ...v, layers: { ...v.layers, [layer]: on } }));
}

export function setMotion(store: CortexStore, patch: Partial<MotionControls>): void {
  store.update("view", (v) => ({ ...v, motion: { ...v.motion, ...patch } }));
}

export function setLook(store: CortexStore, patch: Partial<LookControls>): void {
  store.update("view", (v) => ({ ...v, look: { ...v.look, ...patch } }));
}

export function toggleGroup(store: CortexStore, key: string): void {
  store.update("ui", (ui) => ({ ...ui, hiddenGroups: ui.hiddenGroups.includes(key) ? ui.hiddenGroups.filter((k) => k !== key) : [...ui.hiddenGroups, key] }));
}

/** Alt + click: show only this group; Alt + click again restores all. */
export function soloGroup(store: CortexStore, key: string, allKeys: readonly string[]): void {
  store.update("ui", (ui) => {
    const others = allKeys.filter((k) => k !== key);
    const isSolo = others.length > 0 && others.every((k) => ui.hiddenGroups.includes(k)) && !ui.hiddenGroups.includes(key);
    // Clearing the isolation relights the whole figure in one frame (no tween).
    if (isSolo) markInstantRestore();
    return { ...ui, hiddenGroups: isSolo ? [] : others };
  });
}

/** Replace the hidden set (the chart panel's Show or hide list); when values come back the figure relights in one frame. */
export function setHiddenGroups(store: CortexStore, keys: readonly string[]): void {
  const cur = store.get("ui").hiddenGroups;
  if (cur.length === keys.length && cur.every((k) => keys.includes(k))) return;
  if (cur.some((k) => !keys.includes(k))) markInstantRestore();
  store.update("ui", { hiddenGroups: [...keys] });
}

/** Show every hidden group again (the "show all" banner action); the figure relights in one frame. */
export function showAllGroups(store: CortexStore): void {
  if (store.get("ui").hiddenGroups.length > 0) markInstantRestore();
  store.update("ui", { hiddenGroups: [] });
}

/** Reset display: every Display control and the camera, but not scope, period, palette or tokens. */
export function resetDisplay(store: CortexStore, defaults: ViewControls): void {
  store.update("view", (v) => ({ ...defaults, chart: v.chart }));
}

// ───────────────────────────── overlays and modes ─────────────────────────────

export function openPopover(store: CortexStore, id: PopoverId | null): void {
  store.update("ui", (ui) => ({ ...ui, popover: ui.popover === id ? null : id }));
}

export function setCommandMode(store: CortexStore, mode: "find" | "ask"): void {
  store.update("ui", (ui) => ({ ...ui, command: { ...ui.command, mode, resultsOpen: mode === "find" && ui.command.text.length > 0, consoleOpen: mode === "ask" } }));
}

export function toggleImmersive(store: CortexStore): void {
  store.update("ui", (ui) => ({ ...ui, immersive: !ui.immersive, popover: null }));
}

/** Rail: "Show everything" on lists every destination flat; off keeps the short list. */
export function setNavFull(store: CortexStore, on: boolean): void {
  store.update("ui", { navFull: on });
}

/** Rail, short list: expand or collapse the "More" group. */
export function setNavMore(store: CortexStore, on: boolean): void {
  store.update("ui", { navMore: on });
}

export function toggleKeyCollapsed(store: CortexStore): void {
  store.update("ui", (ui) => ({ ...ui, keyCollapsed: !ui.keyCollapsed }));
}

/** "Show them": reveal held arrivals up to the shared index's count (birth flashes; nothing else moves). */
export function revealArrivals(store: CortexStore, available: number): void {
  store.update("ui", { revealedCount: available });
}

export function setActiveNote(store: CortexStore, id: string | null): void {
  store.update("ui", { activeNote: id });
}
