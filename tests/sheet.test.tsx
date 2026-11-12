/**
 * P17 sheet and Read navigator: instant page switches, the left drawer, the collapsed edge tab, the left column's
 * Recent / Everything / Pinned / folder rows, the list heading, the two-level scroll structure and the map hover preview.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { collapseSheetOnLeave, openPage, openTab, pushSheet, setSheetCollapsed, setSheetPreview, sheetBack } from "../src/state/actions";
import { App } from "../src/ui/App";
import { defaultSheetSide, drawerOpenLeft, sheetSide, sheetCover, sheetTabbed, sheetWidth, SHELL, stageBox } from "../src/ui/breakpoints";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { PINNED_SECTION_MAX, ReadNav, readNavState, readSelection, selectionHeading, setNavFolderOpen, treeRows } from "../src/ui/pages/Read";
import { previewForHover } from "../src/ui/stage/HubCard";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

function renderApp(h: FakeHarness): string {
  return render(<App services={h.services} leaf={h.leaf} />);
}

const view = { width: 1600, height: 900 };
const FOLDERS = [
  { path: "Projects", count: 10, depth: 0 },
  { path: "Projects/Alpha", count: 6, depth: 1 },
  { path: "Projects/Alpha/Notes", count: 3, depth: 2 },
  { path: "Projects/Beta", count: 4, depth: 1 },
  { path: "Reading", count: 5, depth: 0 },
];

function renderNav(h: FakeHarness, owner: object, selection: Parameters<typeof ReadNav>[0]["selection"]): string {
  return render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>
        <ReadNav owner={owner} tree={FOLDERS} everything={7747} pinned={1} selection={selection} width={32} recent={[{ ordinal: 1, title: "A chat", count: 4 }]} openOrdinal={-1} onEverything={() => undefined} onPinned={() => undefined} onFolder={() => undefined} onOpenRecent={() => undefined} />
      </LeafContext.Provider>
    </ServicesContext.Provider>,
  );
}

describe("sheet: instant page switches (SYS-17)", () => {
  it("draws no page animation when switching pages, and keeps the same sheet element", () => {
    const h = fakeServices();
    openTab(h.leaf.store, "time");
    const first = renderApp(h);
    expect(first).toContain("cx-sheet-page");
    expect(first).not.toContain("is-animated");
    expect(first).not.toContain("is-animate-pages");
    openPage(h.leaf.store, "guide");
    const second = renderApp(h);
    expect(second).not.toContain("is-animated");
    expect(second).toContain('id="cx-sheet-test-leaf"');
  });

  it("animates the page swap only when Animate page changes is on", () => {
    const h = fakeServices((s) => void (s.appearance.animatePageChanges = true));
    openTab(h.leaf.store, "time");
    const html = renderApp(h);
    expect(html).toContain("is-animate-pages");
    expect(html).toContain("cx-sheet-page is-animated");
  });
});

describe("sheet: left drawer (PAGE-NAV-01)", () => {
  it("docks Read and every rail page on the left and the pages reached from inside another on the right", () => {
    const h = fakeServices();
    openTab(h.leaf.store, "read");
    expect(sheetSide(h.leaf.store.get("ui").sheet)).toBe("left");
    openTab(h.leaf.store, "time");
    expect(sheetSide(h.leaf.store.get("ui").sheet)).toBe("left");
    openPage(h.leaf.store, "runs");
    expect(sheetSide(h.leaf.store.get("ui").sheet)).toBe("right");
    expect(defaultSheetSide({ stack: [{ kind: "reader", route: "entry", id: "e_1" }] })).toBe("right");
  });

  it("pushes the stage right with an inset on the left, not the right", () => {
    const h = fakeServices();
    openTab(h.leaf.store, "read");
    const ui = h.leaf.store.get("ui");
    const box = stageBox(view, ui);
    expect(box.insetLeft).toBe(SHELL.geometry.sheet.drawer);
    expect(box.insetRight).toBe(0);
    expect(box.width).toBe(view.width - 168 - SHELL.geometry.sheet.drawer);
    openPage(h.leaf.store, "runs");
    const right = stageBox(view, h.leaf.store.get("ui"));
    expect(right.insetRight).toBe(h.leaf.store.get("ui").sheet.width);
    expect(right.insetLeft).toBe(0);
  });

  it("tells the canvas about a sheet only when the sheet floats over it", () => {
    const h = fakeServices();
    openTab(h.leaf.store, "time");
    const ui = h.leaf.store.get("ui");
    // Pushing (XL, L): the stage is already narrower by the sheet, nothing lies under it.
    expect(sheetCover(view, { ...ui, breakpoint: "XL", immersive: false })).toBe(0);
    expect(stageBox(view, { ...ui, breakpoint: "XL", immersive: false }).width).toBe(view.width - 168 - ui.sheet.width);
    // Floating (M): the canvas keeps its width and the figure fits clear of the sheet's strip.
    expect(sheetCover({ width: 900, height: 700 }, { ...ui, breakpoint: "M", immersive: false })).toBe(ui.sheet.width);
    expect(sheetCover({ width: 900, height: 700 }, { ...ui, breakpoint: "M", immersive: true })).toBe(0);
    expect(sheetCover({ width: 900, height: 700 }, { ...ui, breakpoint: "M", immersive: false, sheet: { ...ui.sheet, open: false } })).toBe(0);
  });

  it("draws the left drawer wider than the default sheet, but keeps a width the person chose", () => {
    const g = SHELL.geometry.sheet;
    expect(sheetWidth({ width: g.default, stack: [{ kind: "page", route: "read" }] })).toBe(g.drawer);
    expect(sheetWidth({ width: g.default, stack: [{ kind: "page", route: "time" }] })).toBe(g.default);
    expect(sheetWidth({ width: 520, stack: [{ kind: "page", route: "read" }] })).toBe(520);
    expect(sheetWidth({ width: g.default, side: "right", stack: [{ kind: "page", route: "read" }] })).toBe(g.default);
  });

  it("puts the sheet before the stage, dims the figure and hides the find field while open on the left", () => {
    const h = fakeServices();
    openTab(h.leaf.store, "read");
    const html = renderApp(h);
    expect(html).toContain("sheet-left");
    expect(html).toContain("is-drawer-left");
    const at = html.indexOf("cx-sheet is-push is-left");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(html.indexOf('class="cx-main"'));
    expect(drawerOpenLeft(h.leaf.store.get("ui"))).toBe(true);
    openTab(h.leaf.store, "time");
    expect(drawerOpenLeft(h.leaf.store.get("ui"))).toBe(false);
    expect(renderApp(h)).not.toContain("is-drawer-left");
  });

  it("a reader opened from the stage while the sheet was closed docks on the right", () => {
    const h = fakeServices();
    openTab(h.leaf.store, "read");
    openTab(h.leaf.store, "brain");
    pushSheet(h.leaf.store, { kind: "reader", route: "entry", id: "e_1" });
    expect(sheetSide(h.leaf.store.get("ui").sheet)).toBe("right");
    // Inside an open Read drawer a reader stays where the drawer is.
    openTab(h.leaf.store, "read");
    pushSheet(h.leaf.store, { kind: "reader", route: "entry", id: "e_2" });
    expect(sheetSide(h.leaf.store.get("ui").sheet)).toBe("left");
  });
});

describe("sheet: collapsed edge tab (PAGE-NAV-02)", () => {
  it("collapses on leave only when the setting is on, and never for the Chart page", () => {
    const h = fakeServices();
    openTab(h.leaf.store, "read");
    collapseSheetOnLeave(h.leaf.store, false);
    expect(h.leaf.store.get("ui").sheet.collapsed).toBeFalsy();
    collapseSheetOnLeave(h.leaf.store, true);
    expect(h.leaf.store.get("ui").sheet.collapsed).toBe(true);
    const c = fakeServices();
    openPage(c.leaf.store, "chart");
    collapseSheetOnLeave(c.leaf.store, true);
    expect(c.leaf.store.get("ui").sheet.collapsed).toBeFalsy();
  });

  it("renders a 28 px tab with the page name, keeps 28 px of the stage, and re-opens", () => {
    const h = fakeServices();
    openTab(h.leaf.store, "read");
    collapseSheetOnLeave(h.leaf.store, true);
    const ui = h.leaf.store.get("ui");
    expect(sheetTabbed(ui.sheet)).toBe(true);
    expect(stageBox(view, ui).insetLeft).toBe(SHELL.geometry.sheet.tabW);
    const html = renderApp(h);
    expect(html).toContain("is-tab");
    expect(html).toContain("cx-sheet-tab");
    expect(html).toContain('aria-label="Open Read"');
    expect(html).not.toContain("cx-sheet-body");
    expect(drawerOpenLeft(ui)).toBe(false);
    setSheetCollapsed(h.leaf.store, false);
    const open = h.leaf.store.get("ui");
    expect(sheetTabbed(open.sheet)).toBe(false);
    expect(renderApp(h)).toContain("cx-sheet-body");
    expect(stageBox(view, open).insetLeft).toBe(sheetWidth(open.sheet));
  });

  it("opening another page, or a reader, un-tabs the sheet", () => {
    const h = fakeServices();
    openTab(h.leaf.store, "read");
    collapseSheetOnLeave(h.leaf.store, true);
    pushSheet(h.leaf.store, { kind: "reader", route: "entry", id: "e_1" });
    expect(h.leaf.store.get("ui").sheet.collapsed).toBeFalsy();
    collapseSheetOnLeave(h.leaf.store, true);
    openPage(h.leaf.store, "guide");
    expect(h.leaf.store.get("ui").sheet.collapsed).toBeFalsy();
  });
});

describe("read: the left column (PAGE-NAV-03, 04, 06)", () => {
  it("picks Everything, Pinned or a folder; a folder wins over Pinned", () => {
    expect(readSelection(null, false)).toEqual({ kind: "everything" });
    expect(readSelection(null, true)).toEqual({ kind: "pinned" });
    expect(readSelection("Projects/Alpha", true)).toEqual({ kind: "folder", path: "Projects/Alpha" });
  });

  it("starts with the top level open (its children show) and deeper levels closed", () => {
    const rows = treeRows(FOLDERS, new Map(), null);
    expect(rows.map((r) => r.path)).toEqual(["Projects", "Projects/Alpha", "Projects/Beta", "Reading"]);
    expect(rows.find((r) => r.path === "Projects")).toMatchObject({ hasChildren: true, expanded: true });
    expect(rows.find((r) => r.path === "Projects/Alpha")).toMatchObject({ hasChildren: true, expanded: false });
    expect(rows.find((r) => r.path === "Reading")).toMatchObject({ hasChildren: false, expanded: false });
  });

  it("a chevron opens and closes children, and the folders above a selection stay open", () => {
    const st = readNavState({});
    setNavFolderOpen(st, "Projects/Alpha", true);
    expect(treeRows(FOLDERS, st.folders, null).map((r) => r.path)).toContain("Projects/Alpha/Notes");
    setNavFolderOpen(st, "Projects", false);
    expect(treeRows(FOLDERS, st.folders, null).map((r) => r.path)).toEqual(["Projects", "Reading"]);
    expect(treeRows(FOLDERS, new Map(), "Projects/Alpha/Notes").map((r) => r.path)).toContain("Projects/Alpha/Notes");
  });

  it("keeps the open and closed state per leaf", () => {
    const a = {}, b = {};
    readNavState(a).recentOpen = false;
    expect(readNavState(a).recentOpen).toBe(false);
    expect(readNavState(b).recentOpen).toBe(true);
  });

  it("draws the Everything and Pinned rows with counts above Recent (with its count) and the folders", () => {
    const h = fakeServices();
    const owner = {};
    const html = renderNav(h, owner, { kind: "pinned" });
    expect(html).toContain("Recent");
    expect(html).toContain("A chat");
    expect(html).toContain("Everything");
    expect(html).toContain("7,747");
    expect(html).toContain("Projects");
    expect(html).toContain("Beta");
    expect(html).not.toContain("Notes</span>");
    expect(html).toContain('aria-label="Collapse Projects"');
    expect(html).toContain('aria-label="Expand Alpha"');
    // The Pinned row is the selected one.
    const pinnedRow = html.slice(html.lastIndexOf('role="treeitem"', html.indexOf(">Pinned<")));
    expect(pinnedRow.startsWith('role="treeitem" aria-selected="true"')).toBe(true);
    // Recent collapses with its chevron, leaving the folder rows.
    readNavState(owner).recentOpen = false;
    const closed = renderNav(h, owner, { kind: "everything" });
    expect(closed).not.toContain("A chat");
    expect(closed).toContain('aria-expanded="false"');
  });
});

describe("read: list heading (PAGE-NAV-07)", () => {
  it("names the selection with its item count", () => {
    expect(selectionHeading({ kind: "everything" }, 7747)).toEqual({ name: "Everything", count: "7,747 items" });
    expect(selectionHeading({ kind: "pinned" }, 1)).toEqual({ name: "Pinned", count: "1 item" });
    expect(selectionHeading({ kind: "folder", path: "Projects/Alpha" }, 6)).toEqual({ name: "Alpha", count: "6 items" });
    expect(PINNED_SECTION_MAX).toBeGreaterThan(0);
  });
});

describe("sheet: two-level scroll (READ-20)", () => {
  it("lets the header scroll away inside the body, except on the Chart page", () => {
    const h = fakeServices();
    openTab(h.leaf.store, "time");
    const html = renderApp(h);
    expect(html).toContain("cx-sheet-body has-head");
    expect(html.indexOf('class="cx-sheet-header"')).toBeGreaterThan(html.indexOf("cx-sheet-body"));
    const c = fakeServices();
    openPage(c.leaf.store, "chart");
    const chart = renderApp(c);
    expect(chart.indexOf('class="cx-sheet-header"')).toBeLessThan(chart.indexOf("cx-sheet-body"));
    expect(chart).not.toContain("has-head");
  });
});

describe("sheet: map hover preview (READ-27)", () => {
  it("previews another map only while a map reader is open", () => {
    expect(previewForHover(5, 9)).toEqual({ kind: "map", ordinal: 9 });
    expect(previewForHover(5, 5)).toBeNull();
    expect(previewForHover(5, null)).toBeNull();
    expect(previewForHover(-1, 9)).toBeNull();
  });

  it("sets and clears without changing the stack, and any stack move clears it", () => {
    const h = fakeServices();
    const store = h.leaf.store;
    openTab(store, "read");
    pushSheet(store, { kind: "reader", route: "map", id: "h_1" });
    const before = store.get("ui").sheet;
    setSheetPreview(store, { kind: "map", ordinal: 7 });
    expect(store.get("ui").sheetPreview).toEqual({ kind: "map", ordinal: 7 });
    expect(store.get("ui").sheet.stack).toHaveLength(before.stack.length);
    expect(store.get("ui").sheet.index).toBe(before.index);
    setSheetPreview(store, null);
    expect(store.get("ui").sheetPreview).toBeNull();
    expect(store.get("ui").sheet.stack).toEqual(before.stack);
    // Clicking the hovered map commits it with a push, which ends the preview.
    setSheetPreview(store, { kind: "map", ordinal: 7 });
    pushSheet(store, { kind: "reader", route: "map", id: "h_2" });
    expect(store.get("ui").sheetPreview).toBeNull();
    expect(store.get("ui").sheet.stack).toHaveLength(before.stack.length + 1);
    setSheetPreview(store, { kind: "map", ordinal: 3 });
    sheetBack(store);
    expect(store.get("ui").sheetPreview).toBeNull();
  });

  it("draws no Preview tag while nothing is previewed", () => {
    const h = fakeServices();
    openTab(h.leaf.store, "read");
    pushSheet(h.leaf.store, { kind: "reader", route: "map", id: "h_1" });
    expect(renderApp(h)).not.toContain("cx-preview-tag");
  });
});
