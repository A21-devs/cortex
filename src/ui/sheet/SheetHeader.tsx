/**
 * Sheet header, 52 px (CORTEX-UX §5.13): Back (when the stack has more than one entry; aria-label "Back to
 * ‹previous›"), a crumb with the previous entry's name and "›" (for a map, the parent map is the crumb: ORIG-06),
 * the title (15/600), page actions (28 px icon buttons) and Close. Owner: E11.
 */
import type { JSX } from "preact";
import type { SheetEntry } from "../../shared/views";
import { closeChartCard, closeReader, closeSheet, setPageDock, setPagePark, setSheetCollapsed, sheetBack } from "../../state/actions";
import { PAIR_PAGES, pageDock, sheetFloats, sheetFolded, sheetMode, type SheetPair } from "../breakpoints";
import { useLeaf } from "../context";
import { t, type CopyKey } from "../copy";
import { IconButton } from "../primitives/buttons";

/** The Chart page, as the card beside a page draws it. */
export const CHART_ENTRY: SheetEntry = { kind: "page", route: "chart" };

export function entryTitle(e: SheetEntry | undefined): string {
  if (!e) return "";
  return e.kind === "page" ? t(`pages.${e.route}` as CopyKey) : t(`routes.${e.route}` as CopyKey);
}

/**
 * `column` is set when the sheet holds two columns (a page and a reader, `pair`): the page column's header carries the dock and
 * park buttons and closes the sheet; the reader column's goes Back only through readers and closes to the page.
 */
export function SheetHeader(p: { titleId?: string; column?: "page" | "reader" | "card"; pair?: SheetPair | null } = {}): JSX.Element {
  const leaf = useLeaf();
  const ui = leaf.store.slices.ui.value;
  const sheet = ui.sheet;
  // The Chart card beside a page: its own title and close (the page stays, the figure goes back to the brain).
  if (p.column === "card") {
    const title = entryTitle(CHART_ENTRY);
    return (
      <header class="cx-sheet-header">
        <div class="cx-sheet-titles">
          <h2 class="cx-sheet-title" id={p.titleId}>{title}</h2>
        </div>
        <IconButton icon="close" label={t("header.close")} onClick={() => closeChartCard(leaf.store)} />
      </header>
    );
  }
  const pair = p.column ? p.pair ?? null : null;
  const topIndex = pair ? (p.column === "page" ? pair.pageIndex : sheet.index) : sheet.index;
  const above = sheet.index > 0 ? sheet.stack[sheet.index - 1] : undefined;
  // In the reader column Back only steps between readers: the page beside it is not "previous" there.
  const prev = pair && p.column === "reader" ? (above?.kind === "reader" ? above : undefined) : pair ? undefined : topIndex > 0 ? sheet.stack[topIndex - 1] : undefined;
  const top = sheet.stack[topIndex];
  // A page that can share the sheet with a reader (XL, L) gets the dock button: which edge it sits on, remembered per page.
  const dockable = top?.kind === "page" && PAIR_PAGES.includes(top.route) && sheetMode(ui.breakpoint) === "push" && !sheetFloats(ui) && p.column !== "reader";
  const dock = top?.kind === "page" ? (pair && p.column === "page" ? pair.pageSide : pageDock(sheet, top.route)) : "right";
  // The Chart page folds to its header bar (the figure keeps the room); the chevron turns over while it is folded.
  const foldable = top?.kind === "page" && top.route === "chart" && !pair;
  const folded = foldable && sheetFolded(sheet);
  return (
    <header class={`cx-sheet-header${top?.kind === "reader" ? " is-reader" : ""}`}>
      {prev ? <IconButton icon="back" label={t("header.back", { previous: entryTitle(prev) })} onClick={() => sheetBack(leaf.store)} /> : null}
      <div class="cx-sheet-titles">
        {prev ? <span class="cx-crumb">{entryTitle(prev)} ›</span> : null}
        <h2 class="cx-sheet-title" id={p.titleId}>{entryTitle(top)}</h2>
      </div>
      {dockable && top?.kind === "page" ? (
        <IconButton
          icon={dock === "left" ? "dockRight" : "dockLeft"}
          class="cx-sheet-dock"
          label={t(dock === "left" ? "sheet.dockRight" : "sheet.dockLeft", { page: entryTitle(top) })}
          onClick={() => setPageDock(leaf.store, top.route, dock === "left" ? "right" : "left")}
        />
      ) : null}
      {pair && p.column === "page" ? (
        <IconButton icon={pair.pageSide === "left" ? "parkLeft" : "parkRight"} class="cx-sheet-park" label={t("sheet.parkPage", { page: entryTitle(top) })} onClick={() => setPagePark(leaf.store, true)} />
      ) : null}
      {foldable ? (
        <IconButton
          icon="chevron"
          class={`cx-sheet-fold${folded ? " is-folded" : ""}`}
          label={folded ? t("chart.expandPanel") : t("chart.collapsePanel")}
          expanded={!folded}
          onClick={() => setSheetCollapsed(leaf.store, !folded)}
        />
      ) : null}
      {pair && p.column === "reader" ? (
        <IconButton icon="close" label={t("sheet.readerCloseTip")} onClick={() => closeReader(leaf.store)} />
      ) : (
        <IconButton icon="close" label={t("header.close")} onClick={() => closeSheet(leaf.store)} />
      )}
    </header>
  );
}
