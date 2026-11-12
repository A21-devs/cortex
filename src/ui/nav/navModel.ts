/**
 * The left rail's model: thirteen destinations, what each opens, which one is active, and the two list layouts
 * (short and "Show everything"). Pure data and functions, so the rail, the header's page picker (M and S) and the
 * tests share one mapping. Every destination reuses an existing surface; "You" is the only page that is new.
 *
 *   Brain      closes the sheet (stage only)
 *   Navigator  Read, tree and list browser
 *   Write      the New entry page (a push on Read, so Back returns to Read)
 *   Today      the day's note in the reader column beside Read (its "Today's entries" link is Read's Today filter)
 *   + Add      the Add sources flow (a modal; the Sources page also lights this row)
 *   Timeline   Time, figure view          Numbers  Time, data view
 *   You        the You page
 *   Review     Agents, checks view        Lab      Agents, ledger view
 *   Files      Sources, files view
 *   Learn      the guide
 *   Your AI    the Ask console in the command line
 *
 * The active destination is derived from the sheet's current page (and its params), never stored. Choosing the
 * destination whose page is already on top of the sheet closes the sheet again (openNavItem toggles).
 */
import { featureOn, type FeatureId } from "../../shared/features";
import { PAGE_ROUTE, type PageId, type ReaderRoute, type SheetEntry, type SheetPageRoute } from "../../shared/views";
import { closeSheet, openBeside, openPage, keepChartCard, openTab, parkBehind, swapParked } from "../../state/actions";
import { sheetTabbed } from "../../state/selectors";
import { sheetFloats, sheetFolded, sheetMode, sheetSide } from "../breakpoints";
import type { CortexStore } from "../../state/store";
import type { UiState } from "../../state/types";

export type NavItemId = "brain" | "navigator" | "write" | "today" | "add" | "timeline" | "numbers" | "you" | "review" | "lab" | "files" | "learn" | "ai";

export const NAV_ITEM_IDS: readonly NavItemId[] = ["brain", "navigator", "write", "today", "add", "timeline", "numbers", "you", "review", "lab", "files", "learn", "ai"];

/** What choosing a destination does. */
export type NavTarget =
  /** Close the sheet: the stage alone. */
  | { kind: "stage" }
  /** Open a sheet page (replacing the stack), optionally under a header page family and with sub-view params. */
  | { kind: "page"; route: SheetPageRoute; family?: PageId; params?: Readonly<Record<string, string>>; pushOnFamily?: boolean; reader?: { route: ReaderRoute; id: string } }
  /** The Add sources flow (needs the services: a modal). */
  | { kind: "add" }
  /** Ask mode in the command line, focused (needs the shell). */
  | { kind: "ask" };

export const NAV_TARGET: Readonly<Record<NavItemId, NavTarget>> = {
  brain: { kind: "stage" },
  navigator: { kind: "page", route: "read", family: "read" },
  write: { kind: "page", route: "new-entry", family: "read", pushOnFamily: true },
  today: { kind: "page", route: "read", family: "read", reader: { route: "today", id: "today" } },
  add: { kind: "add" },
  timeline: { kind: "page", route: "time", family: "time" },
  numbers: { kind: "page", route: "time", family: "time", params: { tab: "data" } },
  you: { kind: "page", route: "you" },
  review: { kind: "page", route: "agents", family: "agents", params: { tab: "checks" } },
  lab: { kind: "page", route: "agents", family: "agents" },
  files: { kind: "page", route: "sources", family: "sources", params: { tab: "files" } },
  learn: { kind: "page", route: "guide" },
  ai: { kind: "ask" },
};

/** The feature gate of each destination (an item whose feature has not shipped is left out, never greyed). */
export const NAV_FEATURE: Readonly<Partial<Record<NavItemId, FeatureId>>> = {
  write: "newEntry",
  today: "today",
  numbers: "dataView",
  review: "checks",
  lab: "agentsLedger",
  files: "sourcesFiles",
  learn: "guide",
  ai: "ask",
};

/** Per-page hue: the palette slot (1–8, the --cx-cat-N tokens) of each destination's active bar. */
export const NAV_SLOT: Readonly<Record<NavItemId, number>> = {
  brain: 1,
  navigator: 2,
  numbers: 3,
  timeline: 4,
  learn: 5,
  you: 6,
  lab: 7,
  add: 8,
  write: 2,
  today: 4,
  review: 3,
  files: 5,
  ai: 6,
};

type FeatureCheck = (id: FeatureId) => boolean;

export function navAvailable(id: NavItemId, on: FeatureCheck = featureOn): boolean {
  const f = NAV_FEATURE[id];
  return f === undefined || on(f);
}

/** A row of the rail: one destination, a pair that share a row (Write and Today), or the "More" toggle. */
export type NavRow = { kind: "items"; items: readonly NavItemId[] } | { kind: "more" };

/** Short list, in order: Brain · Navigator · Write/Today · + Add · More (which expands to the rest, below). */
export const NAV_SHORT_ORDER: readonly (NavItemId | readonly NavItemId[])[] = ["brain", "navigator", ["write", "today"], "add"];
export const NAV_MORE_ORDER: readonly NavItemId[] = ["timeline", "numbers", "you", "review", "files", "learn", "lab", "ai"];
/** "Show everything": every destination, flat. */
export const NAV_FULL_ORDER: readonly (NavItemId | readonly NavItemId[])[] = ["brain", "navigator", ["write", "today"], "timeline", "numbers", "you", "review", "lab", "files", "learn", "ai", "add"];

function rowsOf(order: readonly (NavItemId | readonly NavItemId[])[], on: FeatureCheck): NavRow[] {
  const rows: NavRow[] = [];
  for (const entry of order) {
    const items = (typeof entry === "string" ? [entry] : [...entry]).filter((id) => navAvailable(id, on));
    if (items.length > 0) rows.push({ kind: "items", items });
  }
  return rows;
}

/**
 * The rail's rows. Short mode lists the short order, then a More row; when More is open the rest follow inline.
 * Full mode ("Show everything") lists every destination flat and has no More row.
 */
export function navRows(full: boolean, more: boolean, on: FeatureCheck = featureOn): NavRow[] {
  if (full) return rowsOf(NAV_FULL_ORDER, on);
  const rows = rowsOf(NAV_SHORT_ORDER, on);
  const rest = rowsOf(NAV_MORE_ORDER, on);
  if (rest.length === 0) return rows;
  rows.push({ kind: "more" });
  return more ? [...rows, ...rest] : rows;
}

/** Every destination that is available, in the order the page picker (M, S) lists them: the full order, flattened. */
export function navPickerItems(on: FeatureCheck = featureOn): NavItemId[] {
  return navRows(true, false, on).flatMap((r) => (r.kind === "items" ? [...r.items] : []));
}

function pageEntry(e: SheetEntry | undefined): Extract<SheetEntry, { kind: "page" }> | undefined {
  return e?.kind === "page" ? e : undefined;
}

/**
 * The destination to light for the current sheet: Brain when the sheet is closed or holds only a reader; else the
 * nearest page at or below the current entry (a reader opened from Read keeps Navigator lit). Read's Today filter
 * lights Today; New entry lights Write; Time's data view lights Numbers; Agents' checks tab lights Review and its
 * other tabs and the full runs ledger light Lab; Sources' files tab lights Files and its other tabs light + Add;
 * Change history belongs to Your AI; the Chart page belongs to Brain.
 */
export function activeNavItem(ui: Pick<UiState, "sheet">, on: FeatureCheck = featureOn): NavItemId | null {
  const { sheet } = ui;
  if (!sheet.open) return "brain";
  const here = sheet.stack[Math.min(sheet.index, sheet.stack.length - 1)];
  if (here?.kind === "reader" && here.route === "today") return "today";
  let page: Extract<SheetEntry, { kind: "page" }> | undefined;
  for (let i = Math.min(sheet.index, sheet.stack.length - 1); i >= 0 && !page; i--) page = pageEntry(sheet.stack[i]);
  if (!page) return "brain";
  const tab = page.params?.tab;
  switch (page.route) {
    case "read":
      return page.params?.today === "1" ? "today" : "navigator";
    case "new-entry":
      return "write";
    case "time":
      return tab === "data" && on("dataView") ? "numbers" : "timeline";
    case "agents":
      return tab === "checks" && on("checks") && on("agentsLedger") ? "review" : "lab";
    case "runs":
      return "lab";
    case "sources":
      return tab === "files" && on("sourcesFiles") ? "files" : "add";
    case "you":
      return "you";
    case "add":
      return "add";
    case "guide":
      return "learn";
    case "change-history":
      return "ai";
    case "chart":
      return "brain";
  }
}

/** The destination's own page is the sheet's current entry (a reader pushed over it does not count). */
export function isOpenOnTop(ui: Pick<UiState, "sheet">, id: NavItemId): boolean {
  const target = NAV_TARGET[id];
  if (target.kind !== "page" || target.reader || !ui.sheet.open) return false;
  const top = ui.sheet.stack[Math.min(ui.sheet.index, ui.sheet.stack.length - 1)];
  return top?.kind === "page" && activeNavItem(ui) === id;
}

function isReaderOnTop(ui: Pick<UiState, "sheet">, r: { route: ReaderRoute; id: string }): boolean {
  if (!ui.sheet.open) return false;
  const top = ui.sheet.stack[Math.min(ui.sheet.index, ui.sheet.stack.length - 1)];
  return top?.kind === "reader" && top.route === r.route && top.id === r.id;
}

/** What opening a destination needs from the app; `add` and `ask` are not store transitions. */
export interface NavHooks {
  /** + Add: open the Add sources flow. */
  add(): void;
  /** Your AI: put the command line into ask mode and focus it. */
  ask(): void;
  /** Write: false when writing is refused (the sample record), after telling the person. */
  canWrite?(): boolean;
}

/** The route of the page a stack starts from, or undefined when it starts from a reader. */
function rootPageOf(stack: readonly SheetEntry[] | undefined): SheetPageRoute | undefined {
  const first = stack?.[0];
  return first?.kind === "page" ? first.route : undefined;
}

/**
 * The edge a page stands on when a rail click may park it: the sheet is open at XL or L on a rail page (not Chart, not a
 * floating card, not folded or already a tab) with no other page parked. Undefined when nothing is to be parked.
 */
function parkableSide(ui: UiState): "left" | "right" | undefined {
  const sheet = ui.sheet;
  if (!sheet.open || ui.immersive || sheet.stash || sheetMode(ui.breakpoint) !== "push" || sheetTabbed(sheet) || sheetFolded(sheet) || sheetFloats(ui)) return undefined;
  const root = rootPageOf(sheet.stack);
  if (!root || root === "chart") return undefined;
  const side = sheetSide(sheet, ui.breakpoint);
  return side === "left" ? side : undefined;
}

/** Open a destination. Page destinations go through the same actions as the commands, so Back and persistence work. */
export function openNavItem(store: CortexStore, id: NavItemId, hooks: NavHooks): void {
  const target = NAV_TARGET[id];
  switch (target.kind) {
    case "stage":
      openTab(store, "brain");
      return;
    case "add":
      hooks.add();
      return;
    case "ask":
      hooks.ask();
      return;
    case "page": {
      // Choosing the page that is already open on top of the sheet closes the sheet (a toggle); so does Today's open note.
      if (isOpenOnTop(store.get("ui"), id) || (target.reader && isReaderOnTop(store.get("ui"), target.reader))) {
        closeSheet(store);
        return;
      }
      if (id === "write" && hooks.canWrite && !hooks.canWrite()) return;
      // The page parked as a tab comes back when its own destination is chosen again.
      const parkedRoot = rootPageOf(store.get("ui").sheet.stash?.stack);
      if (parkedRoot && parkedRoot === (target.family ? PAGE_ROUTE[target.family] : target.route) && !target.params && !target.reader && !target.pushOnFamily) {
        swapParked(store);
        return;
      }
      const before = store.get("ui");
      const parkSide = parkableSide(before);
      // The Chart card stays up beside the page that opens (it does not give its place to it).
      if (sheetFloats(before)) keepChartCard(store);
      store.batch(() => {
        if (target.family) openTab(store, target.family);
        if (target.pushOnFamily) openPage(store, target.route, undefined, true);
        else if (target.params || !target.family) openPage(store, target.route, target.params ? { ...target.params } : undefined);
        if (target.reader) openBeside(store, { kind: "reader", route: target.reader.route, id: target.reader.id });
        // A rail click while a page stands on the left parks that page as a tab; the new page opens on the opposite edge.
        const now = store.get("ui").sheet;
        if (parkSide && now.open && rootPageOf(now.stack) !== rootPageOf(before.sheet.stack)) parkBehind(store, before.sheet, parkSide);
      });
      return;
    }
  }
}
