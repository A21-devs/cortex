/**
 * The sheet (CORTEX-UX §3.4, §5.13): ONE right-hand container for every page and reader, with a back stack of
 * ≤ 12 entries (Alt ← / Alt →), scroll position remembered per entry, skeleton blocks for ≤ 300 ms while data
 * loads (the pages' Load), inline error cards with Try again (also for a page that throws while drawing). Push
 * mode (XL, L) narrows the stage (the scene re-centres; the camera does not move); overlay mode (M) floats with a
 * left shadow; full mode (S) covers the view below the header. Width 340–560 px, draggable left edge (arrow keys
 * step 16, double-click resets to 400), stored per leaf. role="complementary". Owner: E11 (container); pages and
 * readers: E12, E9 (Chart), E6 (Ask history).
 *
 * Two columns (XL, L; CORTEX-UX section 3.4): with a reader on top of Chart, Read or Time the sheet is drawn twice. The page
 * column sits on the page's dock side (`column="page"`), the reader in the opposite column (`column="reader"`), the stage
 * between them; the page can be parked as a slim vertical tab. App picks the columns (sheetPair); M and S keep one stack.
 */
import { Component, type ComponentChildren, type JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { SheetEntry } from "../../shared/views";
import { closeSheet, collapseSheetOnLeave, setPagePark, setSheetCollapsed, setSheetWidth, swapParked } from "../../state/actions";
import { CHART_CARD, clampSheetWidth, railWidth, SHELL, stageBox, sheetFloats, sheetFolded, sheetSide, sheetTabbed, sheetWidth, stashTab, type SheetMode, type SheetPair } from "../breakpoints";
import { domIds, isReducedMotion, pendingCopy, useLeaf, useServices, useShell } from "../context";
import { t } from "../copy";
import { SHEET_PAGES } from "../pages";
import { ErrorCard } from "../pages/PageFrame";
import { IconButton } from "../primitives/buttons";
import { ReaderRouter } from "../reader/Reader";
import { metaOf } from "../reader/readerKit";
import { createScrollBlur, type ScrollBlur } from "./scrollBlur";
import { CHART_ENTRY, entryTitle, SheetHeader } from "./SheetHeader";

/** A stable key for a sheet entry (its scroll position is remembered under it). */
export function entryKey(e: SheetEntry | undefined, index: number): string {
  if (!e) return `none-${index}`;
  return e.kind === "page" ? `page:${e.route}:${JSON.stringify(e.params ?? {})}` : `reader:${e.route}:${JSON.stringify((e as { id?: unknown }).id ?? (e as { ordinal?: unknown }).ordinal ?? "")}`;
}

interface BoundaryProps {
  children?: ComponentChildren;
  message: string;
  onError?(e: unknown): void;
}

/** Catches a page or reader that throws while drawing, so the rest of Cortex keeps working. */
export class SheetBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  override componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
    this.setState({ failed: true });
  }

  override render(): JSX.Element | ComponentChildren {
    if (this.state.failed) return <ErrorCard message={this.props.message} retry={() => this.setState({ failed: false })} />;
    return this.props.children;
  }
}

/**
 * The page a rail click parked while it opened another: a slim vertical tab at the edge it sat on (the reference's "Navigator"
 * tab), named for the page. A press swaps it with the page now open; the page returns with its stack, scroll and selection.
 */
export function ParkedTab(p: { mode: SheetMode }): JSX.Element | null {
  const leaf = useLeaf();
  const ui = leaf.store.slices.ui.value;
  const stash = stashTab(ui);
  if (!stash) return null;
  const root = stash.stack.find((e) => e.kind === "page") ?? stash.stack[stash.index];
  const title = entryTitle(root);
  const ids = domIds(leaf.viewId);
  return (
    <aside id={`${ids.sheet}-parked`} class={`cx-sheet is-${p.mode} is-${stash.side} is-tab is-parked`} role="complementary" aria-label={title}>
      <button type="button" class="cx-sheet-tab" aria-expanded="false" aria-label={t("sheet.tabOpen", { page: title })} title={t("sheet.tabOpen", { page: title })} onClick={() => swapParked(leaf.store)}>
        <span class="cx-sheet-tab-label">{title}</span>
      </button>
    </aside>
  );
}

/** Pointer travel (px) beyond which a press on the figure is a drag, not a click. */
const CLICK_SLOP = 5;

export function Sheet(p: { mode: SheetMode; column?: "page" | "reader" | "card"; pair?: SheetPair | null }): JSX.Element {
  const leaf = useLeaf();
  const services = useServices();
  const shell = useShell();
  const ui = leaf.store.slices.ui.value;
  const sheet = ui.sheet;
  const aside = p.column === "card";
  const pair = p.column && !aside ? p.pair ?? null : null;
  // In two columns the page column draws the page entry and the reader column the one on top; the Chart card beside a page draws the Chart page.
  const entryIndex = pair && p.column === "page" ? pair.pageIndex : sheet.index;
  const entry = aside ? CHART_ENTRY : sheet.stack[entryIndex];
  const key = entryKey(entry, entryIndex);
  const body = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const baseIds = domIds(leaf.viewId);
  const ids = p.column === "reader" || aside ? { ...baseIds, sheet: `${baseIds.sheet}-${p.column}`, sheetTitle: `${baseIds.sheetTitle}-${p.column}` } : baseIds;
  const side = aside ? "left" : pair ? (p.column === "page" ? pair.pageSide : pair.readerSide) : sheetSide(sheet, ui.breakpoint);
  // The tab at the edge: the whole sheet collapsed, or the page column parked beside its reader.
  const tabbed = aside ? false : pair ? p.column === "page" && pair.parked : sheetTabbed(sheet);
  // Every page but Chart (which folds to its header bar) lets its header scroll away with the content.
  const headerScrolls = !(entry?.kind === "page" && entry.route === "chart");
  const miniAfter = SHELL.geometry.sheet.miniAfter;
  const [scrolled, setScrolled] = useState(false);

  // Scroll position per entry: restore when an entry becomes current, remember when leaving it.
  useEffect(() => {
    const el = body.current;
    if (!el) return undefined;
    el.scrollTop = shell.scroll.get(key) ?? 0;
    setScrolled(el.scrollTop > miniAfter);
    return () => {
      // A body removed with the sheet (collapsed to its tab) reads 0: its last drawn position was kept by onScroll.
      if (el.isConnected) shell.scroll.set(key, el.scrollTop);
    };
  }, [key, tabbed]);

  // A fast wheel scroll in a reader softens the page for a moment (not under reduced motion).
  const blur = useRef<ScrollBlur | null>(null);
  useEffect(() => {
    const el = body.current;
    if (!el) return undefined;
    const b = createScrollBlur(el, () => isReducedMotion(services.settings.value.appearance.motion, shell.systemReducedMotion.value));
    blur.current = b;
    return () => {
      b.dispose();
      blur.current = null;
    };
  }, [tabbed]);

  // "Collapse when I leave": a pointer press on the figure shrinks the sheet to its edge tab.
  useEffect(() => {
    const stage = root.current?.ownerDocument?.getElementById(ids.stage);
    if (!stage || tabbed || pair || aside) return undefined;
    // A click on the figure leaves the page; a drag (orbiting the figure) does not.
    let from: { x: number; y: number } | null = null;
    const down = (e: Event) => {
      const pe = e as PointerEvent;
      from = (e.target as Element | null)?.closest?.(".cx-canvas-host") ? { x: pe.clientX, y: pe.clientY } : null;
    };
    const up = (e: Event) => {
      const pe = e as PointerEvent;
      const start = from;
      from = null;
      if (!start || Math.hypot(pe.clientX - start.x, pe.clientY - start.y) > CLICK_SLOP) return;
      collapseSheetOnLeave(leaf.store, services.settings.value.appearance.collapseOnLeave);
    };
    stage.addEventListener("pointerdown", down);
    stage.addEventListener("pointerup", up);
    return () => {
      stage.removeEventListener("pointerdown", down);
      stage.removeEventListener("pointerup", up);
    };
  }, [leaf, tabbed, ids.stage, pair !== null]);

  // A map hovered on the stage shows in place of the open map (no stack change); anything else draws the entry itself.
  const previewMeta = ui.sheetPreview && entry?.kind === "reader" && entry.route === "map" ? metaOf(services, ui.sheetPreview.ordinal) : undefined;
  const previewId = previewMeta && !(entry?.kind === "reader" && previewMeta.id === entry.id) ? previewMeta.id : undefined;

  /** Width the sheet may share with the stage: the view's, less the left rail. */
  const room = () => (shell.size.value.width ? shell.size.value.width - railWidth(ui.breakpoint, ui.immersive) : Number.POSITIVE_INFINITY);
  const startDrag = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);
    const startX = e.clientX;
    const startW = pair ? pair.pageWidth : sheetWidth(sheet);
    const dir = side === "left" ? -1 : 1;
    const move = (ev: PointerEvent) => setSheetWidth(leaf.store, clampSheetWidth(startW + dir * (startX - ev.clientX), room()));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const step = SHELL.geometry.sheet.keyStep;
  const onEdgeKey = (e: KeyboardEvent) => {
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
    const d = e.key === grow ? step : e.key === shrink ? -step : 0;
    if (d === 0) return;
    e.preventDefault();
    setSheetWidth(leaf.store, clampSheetWidth((pair ? pair.pageWidth : sheetWidth(sheet)) + d, room()));
  };

  const Page = entry?.kind === "page" ? SHEET_PAGES[entry.route] : undefined;
  const folded = !pair && !aside && sheetFolded(sheet);
  const title = entryTitle(entry);
  const animated = services.settings.value.appearance.animatePageChanges;
  // The Chart page as a floating left card (setting): own scroll and border over the full-width stage.
  const card = aside || (!pair && sheetFloats(ui));
  const cls = `cx-sheet is-${p.mode} is-${side}${folded ? " is-folded" : ""}${tabbed ? " is-tab" : ""}${card ? " is-card" : ""}${pair ? ` is-pair is-${p.column}-column` : ""}`;
  // An overlay on the left starts at the rail's edge, not the window's.
  const leftOffset = p.mode === "overlay" && side === "left" ? { left: `${railWidth(ui.breakpoint, ui.immersive)}px` } : undefined;
  const style = card
    ? { width: `${CHART_CARD.width}px`, left: `${railWidth(ui.breakpoint, ui.immersive) + (aside ? stageBox(shell.size.value, ui).insetLeft : 0) + CHART_CARD.gap}px` }
    : pair
      ? { width: `${p.column === "page" ? pair.pageWidth : pair.readerWidth}px` }
      : p.mode === "full"
        ? undefined
        : { width: `${sheetWidth(sheet)}px`, ...leftOffset };

  if (tabbed) {
    // The thin vertical tab at the edge: the page's name, turned on its side; a press brings the sheet back.
    return (
      <aside ref={root} id={ids.sheet} class={cls} role="complementary" aria-labelledby={ids.sheetTitle} style={pair ? undefined : leftOffset}>
        <button type="button" class="cx-sheet-tab" aria-expanded="false" aria-label={t("sheet.tabOpen", { page: title })} title={t("sheet.tabOpen", { page: title })} onClick={() => (pair ? setPagePark(leaf.store, false) : setSheetCollapsed(leaf.store, false))}>
          <span class="cx-sheet-tab-label" id={ids.sheetTitle}>{title}</span>
        </button>
      </aside>
    );
  }
  const header = <SheetHeader titleId={ids.sheetTitle} column={p.column} pair={pair} />;
  const pageKey = previewId ? `preview:${previewId}` : key;
  // The page fade replays when the entry changes, not each time a page rewrites its own params (a filter, a tab).
  const animKey = entry?.kind === "page" ? `page:${entry.route}:${entryIndex}` : key;
  return (
    <aside ref={root} id={ids.sheet} class={cls} role="complementary" aria-labelledby={ids.sheetTitle} style={style}>
      {p.mode === "full" || card || p.column === "reader" ? null : (
        <div
          class="cx-sheet-edge"
          role="separator"
          aria-orientation="vertical"
          aria-label={pendingCopy("sheetResize")}
          aria-valuemin={SHELL.geometry.sheet.min}
          aria-valuemax={SHELL.geometry.sheet.max}
          aria-valuenow={pair ? pair.pageWidth : sheetWidth(sheet)}
          tabIndex={0}
          onPointerDown={startDrag}
          onKeyDown={onEdgeKey}
          onDblClick={() => setSheetWidth(leaf.store, SHELL.geometry.sheet.default)}
        />
      )}
      {headerScrolls ? null : header}
      {headerScrolls && scrolled ? (
        <div class="cx-sheet-mini">
          <span class="cx-sheet-mini-title">{title}</span>
          <IconButton icon="close" label={t("sheet.miniClose", { page: title })} onClick={() => closeSheet(leaf.store)} />
        </div>
      ) : null}
      <div
        ref={body}
        class={`cx-sheet-body${headerScrolls ? " has-head" : ""}`}
        onScroll={(e) => {
          shell.scroll.set(key, (e.currentTarget as HTMLElement).scrollTop);
          if (entry?.kind === "reader") blur.current?.onScroll((e.currentTarget as HTMLElement).scrollTop);
          const on = (e.currentTarget as HTMLElement).scrollTop > miniAfter;
          if (on !== scrolled) setScrolled(on);
        }}
      >
        {headerScrolls ? header : null}
        <div class={`cx-sheet-page${animated ? " is-animated" : ""}`} key={previewId ? pageKey : animKey}>
          {previewId ? (
            <div class="cx-preview-tag" role="status">
              <span class="cx-preview-pill">{t("sheet.previewTag")}</span>
              <span class="cx-preview-hint">{t("sheet.previewHint")}</span>
            </div>
          ) : null}
          <SheetBoundary key={pageKey} message={pendingCopy("sheetFailed")} onError={(err) => leaf.store.get("ui") && shell.toast({ kind: "error", text: pendingCopy("sheetFailed"), detail: err instanceof Error ? err.message : String(err), sticky: true })}>
            {previewId ? <ReaderRouter entry={{ kind: "reader", route: "map", id: previewId }} /> : entry?.kind === "reader" ? <ReaderRouter entry={entry} /> : Page ? <Page params={entry?.kind === "page" ? entry.params ?? {} : {}} /> : null}
          </SheetBoundary>
        </div>
      </div>
    </aside>
  );
}
