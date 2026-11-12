/**
 * Two columns (XL, L): a page (Chart, Read, Time) docked left or right, the reader in the opposite column, the stage between
 * them; the page can be parked as a slim vertical tab; Esc closes the reader first; M and S keep the single stack.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { migrateSettingsChecked } from "../src/shared/settings";
import {
  closeReader,
  closeSheet,
  openBeside,
  openPage,
  openTab,
  pushSheet,
  setPageDock,
  setPagePark,
  sheetBack,
  sheetForward,
} from "../src/state/actions";
import { captureLeafState, restoreLeafState } from "../src/state/persist";
import { createLeafStore } from "../src/state/store";
import type { Breakpoint } from "../src/state/types";
import { App } from "../src/ui/App";
import { openBesideId, PAIR, pageDock, SHELL, sheetPair, sheetSide, sheetWidth, stageBox } from "../src/ui/breakpoints";
import { shellFor } from "../src/ui/context";
import { t } from "../src/ui/copy";
import { escapeStep, runEscape } from "../src/ui/keymap";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

const READER = { kind: "reader", route: "entry", id: "e_1" } as const;
const READER2 = { kind: "reader", route: "entry", id: "e_2" } as const;

function setBp(h: FakeHarness, bp: Breakpoint): void {
  h.leaf.store.update("ui", { breakpoint: bp });
}

function ui(h: FakeHarness) {
  return h.leaf.store.get("ui");
}

function renderApp(h: FakeHarness): string {
  return render(<App services={h.services} leaf={h.leaf} />);
}

/** Read open with a reader beside it. */
function readAndReader(h: FakeHarness): void {
  openTab(h.leaf.store, "read");
  pushSheet(h.leaf.store, READER);
}

describe("two columns: when a page and a reader share the sheet", () => {
  it("pairs a reader with Read, Time or Chart at XL and L", () => {
    for (const route of ["read", "time", "chart"] as const) {
      for (const bp of ["XL", "L"] as const) {
        const h = fakeServices();
        setBp(h, bp);
        openPage(h.leaf.store, route);
        pushSheet(h.leaf.store, READER);
        const pair = sheetPair(ui(h));
        expect(pair, `${route} ${bp}`).not.toBeNull();
        expect(pair?.page.route).toBe(route);
        expect(pair?.reader.id).toBe("e_1");
      }
    }
  });

  it("keeps the single stack at M and S, for a page alone, for a reader alone and for other pages", () => {
    const h = fakeServices();
    readAndReader(h);
    for (const bp of ["M", "S", "Mini"] as const) {
      setBp(h, bp);
      expect(sheetPair(ui(h)), bp).toBeNull();
    }
    setBp(h, "XL");
    expect(sheetPair(ui(h))).not.toBeNull();
    // A page alone, then the reader popped.
    sheetBack(h.leaf.store);
    expect(sheetPair(ui(h))).toBeNull();
    // A reader alone (opened from the stage with the sheet closed).
    closeSheet(h.leaf.store);
    pushSheet(h.leaf.store, READER);
    expect(sheetPair(ui(h))).toBeNull();
    // A page the columns do not cover.
    openPage(h.leaf.store, "runs");
    pushSheet(h.leaf.store, READER);
    expect(sheetPair(ui(h))).toBeNull();
  });

  it("is off while the sheet is an edge tab, immersive, closed, or the Chart page floats as a card", () => {
    const h = fakeServices();
    readAndReader(h);
    expect(sheetPair(ui(h))).not.toBeNull();
    expect(sheetPair({ ...ui(h), immersive: true })).toBeNull();
    expect(sheetPair({ ...ui(h), sheet: { ...ui(h).sheet, collapsed: true } })).toBeNull();
    expect(sheetPair({ ...ui(h), sheet: { ...ui(h).sheet, open: false } })).toBeNull();
    const c = fakeServices();
    openPage(c.leaf.store, "chart");
    pushSheet(c.leaf.store, READER);
    expect(sheetPair({ ...ui(c), sheet: { ...ui(c).sheet, float: true } })).toBeNull();
    // Another page is not affected by the floating Chart card.
    expect(sheetPair({ ...ui(h), sheet: { ...ui(h).sheet, float: true } })).not.toBeNull();
  });

  it("finds the page under several readers", () => {
    const h = fakeServices();
    readAndReader(h);
    pushSheet(h.leaf.store, READER2);
    const pair = sheetPair(ui(h));
    expect(pair?.pageIndex).toBe(0);
    expect(pair?.reader.id).toBe("e_2");
  });

  it("needs room for both columns and a stage: narrower than that the single stack stands", () => {
    const h = fakeServices();
    readAndReader(h);
    const rail = SHELL.geometry.railW;
    const least = rail + 2 * PAIR.colMin + PAIR.stageMin;
    expect(sheetPair(ui(h), least)).not.toBeNull();
    expect(sheetPair(ui(h), least - 1)).toBeNull();
    // At the low end of L the columns shrink from their wanted widths to fit, never below their least.
    const narrow = sheetPair(ui(h), 1100);
    expect(narrow).not.toBeNull();
    expect(narrow!.pageWidth + narrow!.readerWidth + PAIR.stageMin).toBeLessThanOrEqual(1100 - rail);
    expect(narrow!.pageWidth).toBeGreaterThanOrEqual(PAIR.colMin);
    expect(narrow!.readerWidth).toBeGreaterThanOrEqual(PAIR.colMin);
    // With room to spare they keep the saved page width and the reader's own.
    const wide = sheetPair(ui(h), 1800)!;
    expect(wide.pageWidth).toBe(ui(h).sheet.width);
    expect(wide.readerWidth).toBe(PAIR.readerWidth);
  });
});

describe("two columns: sides and docking", () => {
  it("puts Read on the left with the reader on the right, and Chart (docked right by default) opposite its reader", () => {
    const h = fakeServices();
    readAndReader(h);
    const read = sheetPair(ui(h))!;
    expect([read.pageSide, read.readerSide]).toEqual(["left", "right"]);
    const c = fakeServices();
    openPage(c.leaf.store, "chart");
    pushSheet(c.leaf.store, READER);
    const chart = sheetPair(ui(c))!;
    expect([chart.pageSide, chart.readerSide]).toEqual(["right", "left"]);
  });

  it("docks Chart on the left when asked, remembered per page, and the reader takes the right column", () => {
    const h = fakeServices();
    openPage(h.leaf.store, "chart");
    expect(sheetSide(ui(h).sheet)).toBe("right");
    setPageDock(h.leaf.store, "chart", "left");
    expect(sheetSide(ui(h).sheet)).toBe("left");
    expect(pageDock(ui(h).sheet, "chart")).toBe("left");
    // Other pages keep their own docks.
    expect(pageDock(ui(h).sheet, "time")).toBe("left");
    expect(pageDock(ui(h).sheet, "read")).toBe("left");
    expect(pageDock(ui(h).sheet, "runs")).toBe("right");
    pushSheet(h.leaf.store, READER);
    const pair = sheetPair(ui(h))!;
    expect([pair.pageSide, pair.readerSide]).toEqual(["left", "right"]);
    // The dock outlives a page change.
    openPage(h.leaf.store, "time");
    openPage(h.leaf.store, "chart");
    expect(sheetSide(ui(h).sheet)).toBe("left");
  });

  it("docks Read on the right, and the left drawer styling stays with Read only", () => {
    const h = fakeServices();
    openTab(h.leaf.store, "read");
    setPageDock(h.leaf.store, "read", "right");
    expect(sheetSide(ui(h).sheet)).toBe("right");
    expect(sheetWidth(ui(h).sheet)).toBe(ui(h).sheet.width);
    const c = fakeServices();
    openPage(c.leaf.store, "chart");
    setPageDock(c.leaf.store, "chart", "left");
    // A Chart panel on the left is 400 px (not Read's 480 px drawer), and does not dim the figure.
    expect(sheetWidth(ui(c).sheet)).toBe(SHELL.geometry.sheet.default);
    expect(renderApp(c)).not.toContain("is-drawer-left");
    expect(renderApp(c)).toContain("sheet-left");
  });

  it("ignores a remembered dock below XL (M floats on its default side, S covers)", () => {
    const h = fakeServices();
    openPage(h.leaf.store, "chart");
    setPageDock(h.leaf.store, "chart", "left");
    setBp(h, "M");
    expect(sheetSide(ui(h).sheet, "M")).toBe("right");
    setBp(h, "L");
    expect(sheetSide(ui(h).sheet, "L")).toBe("left");
  });

  it("shows the dock button on a page at XL and L, naming the side it moves to, and not at M", () => {
    const h = fakeServices();
    openPage(h.leaf.store, "time");
    expect(renderApp(h)).toContain(t("sheet.dockRight", { page: "Time" }));
    setPageDock(h.leaf.store, "time", "right");
    const html = renderApp(h);
    expect(html).toContain(t("sheet.dockLeft", { page: "Time" }));
    setBp(h, "M");
    expect(renderApp(h)).not.toContain("cx-sheet-dock");
    // A page reached from inside another has no dock button either.
    const a = fakeServices();
    openPage(a.leaf.store, "runs");
    expect(renderApp(a)).not.toContain("cx-sheet-dock");
  });

  it("remembers docks with the leaf: saved only when set, restored, junk dropped", () => {
    const settings = migrateSettingsChecked(undefined).settings;
    expect("docks" in captureLeafState(createLeafStore()).sheet).toBe(false);
    const a = createLeafStore();
    setPageDock(a, "chart", "left");
    setPageDock(a, "time", "right");
    const saved = captureLeafState(a);
    expect(saved.sheet.docks).toEqual({ chart: "left", time: "right" });
    const b = createLeafStore();
    restoreLeafState(b, JSON.parse(JSON.stringify(saved)), settings);
    expect(b.get("ui").sheet.docks).toEqual({ chart: "left", time: "right" });
    const c = createLeafStore();
    restoreLeafState(c, { ...saved, sheet: { ...saved.sheet, docks: { chart: "up", read: "left", nothing: "left", time: 3 } } }, settings);
    expect(c.get("ui").sheet.docks).toEqual({ read: "left" });
    const d = createLeafStore();
    restoreLeafState(d, { ...saved, sheet: { ...saved.sheet, docks: "left" } }, settings);
    expect(d.get("ui").sheet.docks).toBeUndefined();
  });
});

describe("two columns: the stage between them", () => {
  const view = { width: 1600, height: 900 };

  it("takes each column's room on its own side", () => {
    const h = fakeServices();
    readAndReader(h);
    const pair = sheetPair(ui(h), view.width)!;
    const box = stageBox(view, ui(h));
    expect(box.insetLeft).toBe(pair.pageWidth);
    expect(box.insetRight).toBe(pair.readerWidth);
    expect(box.width).toBe(view.width - SHELL.geometry.railW - pair.pageWidth - pair.readerWidth);
    expect(box.width).toBeGreaterThanOrEqual(PAIR.stageMin);
    // Chart docked left: the same split. Chart on the right: the reader's room moves left.
    const c = fakeServices();
    openPage(c.leaf.store, "chart");
    pushSheet(c.leaf.store, READER);
    const right = stageBox(view, ui(c));
    expect(right.insetRight).toBe(sheetPair(ui(c), view.width)!.pageWidth);
    expect(right.insetLeft).toBe(PAIR.readerWidth);
  });

  it("gives the page's room back, down to the tab, when it is parked", () => {
    const h = fakeServices();
    readAndReader(h);
    const open = stageBox(view, ui(h));
    setPagePark(h.leaf.store, true);
    const parked = stageBox(view, ui(h));
    expect(parked.insetLeft).toBe(SHELL.geometry.sheet.tabW);
    expect(parked.insetRight).toBe(open.insetRight);
    expect(parked.width).toBeGreaterThan(open.width);
  });

  it("does not change a single sheet: the stage still narrows by one sheet width", () => {
    const h = fakeServices();
    openPage(h.leaf.store, "runs");
    expect(stageBox(view, ui(h)).insetRight).toBe(ui(h).sheet.width);
    setBp(h, "M");
    readAndReader(h);
    expect(stageBox(view, ui(h)).insetLeft + stageBox(view, ui(h)).insetRight).toBe(0);
  });
});

describe("two columns: closing, parking and opening beside", () => {
  it("closeReader goes back to the page, keeps forward history and clears the park", () => {
    const h = fakeServices();
    readAndReader(h);
    setPagePark(h.leaf.store, true);
    expect(closeReader(h.leaf.store)).toBe(true);
    expect(ui(h).sheet.index).toBe(0);
    expect(ui(h).sheet.stack).toHaveLength(2);
    expect(ui(h).sheet.parked).toBeFalsy();
    sheetForward(h.leaf.store);
    expect(sheetPair(ui(h))?.reader.id).toBe("e_1");
    // With several readers stacked it returns to the page, not to the previous reader.
    pushSheet(h.leaf.store, READER2);
    expect(closeReader(h.leaf.store)).toBe(true);
    expect(ui(h).sheet.index).toBe(0);
  });

  it("closeReader does nothing without a page below, or with no reader on top", () => {
    const h = fakeServices();
    pushSheet(h.leaf.store, READER);
    expect(closeReader(h.leaf.store)).toBe(false);
    expect(ui(h).sheet.index).toBe(0);
    const p = fakeServices();
    openTab(p.leaf.store, "read");
    expect(closeReader(p.leaf.store)).toBe(false);
  });

  it("parks and restores the page; changing page, going back or closing clears the park", () => {
    const h = fakeServices();
    readAndReader(h);
    setPagePark(h.leaf.store, true);
    expect(sheetPair(ui(h))?.parked).toBe(true);
    setPagePark(h.leaf.store, false);
    expect(sheetPair(ui(h))?.parked).toBe(false);
    setPagePark(h.leaf.store, true);
    sheetBack(h.leaf.store);
    expect(ui(h).sheet.parked).toBeFalsy();
    sheetForward(h.leaf.store);
    setPagePark(h.leaf.store, true);
    openTab(h.leaf.store, "time");
    expect(ui(h).sheet.parked).toBeFalsy();
    pushSheet(h.leaf.store, READER);
    setPagePark(h.leaf.store, true);
    closeSheet(h.leaf.store);
    expect(ui(h).sheet.parked).toBeFalsy();
  });

  it("a click down a page's list replaces the reader beside it instead of stacking", () => {
    const h = fakeServices();
    readAndReader(h);
    openBeside(h.leaf.store, READER2);
    expect(ui(h).sheet.stack).toEqual([{ kind: "page", route: "read" }, READER2]);
    expect(ui(h).sheet.index).toBe(1);
    // From a page alone it pushes as usual, and at M (one stack) too.
    sheetBack(h.leaf.store);
    openBeside(h.leaf.store, READER);
    expect(ui(h).sheet.stack).toEqual([{ kind: "page", route: "read" }, READER]);
    setBp(h, "M");
    openBeside(h.leaf.store, READER2);
    expect(ui(h).sheet.stack).toHaveLength(3);
  });

  it("names the open reader so the page's list can mark it", () => {
    const h = fakeServices();
    readAndReader(h);
    expect(openBesideId(ui(h))).toBe("e_1");
    pushSheet(h.leaf.store, READER2);
    expect(openBesideId(ui(h))).toBe("e_2");
    sheetBack(h.leaf.store);
    sheetBack(h.leaf.store);
    expect(openBesideId(ui(h))).toBeUndefined();
    setBp(h, "M");
    sheetForward(h.leaf.store);
    expect(openBesideId(ui(h))).toBeUndefined();
  });
});

describe("two columns: Esc closes the reader first", () => {
  it("is the reader step in two columns, the sheet step in a single stack", () => {
    const h = fakeServices();
    readAndReader(h);
    expect(escapeStep(ui(h), null, { hint: false, shapeOpen: false })).toBe("reader");
    setBp(h, "M");
    expect(escapeStep(ui(h), null, { hint: false, shapeOpen: false })).toBe("sheet");
    setBp(h, "XL");
    // Too narrow for two columns: the single stack stands, so Esc closes the sheet as before.
    expect(escapeStep(ui(h), null, { hint: false, shapeOpen: false, width: 900 })).toBe("sheet");
    expect(escapeStep(ui(h), null, { hint: false, shapeOpen: false, width: 1500 })).toBe("reader");
  });

  it("runEscape closes the reader, then the sheet", () => {
    const h = fakeServices();
    readAndReader(h);
    const shell = shellFor(h.leaf);
    expect(runEscape(h.leaf.store, shell)).toBe(true);
    expect(ui(h).sheet.open).toBe(true);
    expect(ui(h).sheet.index).toBe(0);
    expect(runEscape(h.leaf.store, shell)).toBe(true);
    expect(ui(h).sheet.open).toBe(false);
  });

  it("a popover or the console still goes before the reader", () => {
    const h = fakeServices();
    readAndReader(h);
    h.leaf.store.update("ui", (u) => ({ ...u, command: { ...u.command, consoleOpen: true } }));
    expect(escapeStep(ui(h), null, { hint: false, shapeOpen: false })).toBe("console");
  });
});

describe("two columns: what is drawn", () => {
  it("draws the page column on its dock side and the reader column opposite, around the stage", () => {
    const h = fakeServices();
    readAndReader(h);
    const html = renderApp(h);
    expect(html).toContain("has-pair");
    const page = html.indexOf("is-page-column");
    const reader = html.indexOf("is-reader-column");
    const stage = html.indexOf('class="cx-main"');
    expect(page).toBeGreaterThan(-1);
    expect(page).toBeLessThan(stage);
    expect(reader).toBeGreaterThan(stage);
    expect(html.match(/<aside/g)).toHaveLength(2);
    // Distinct ids for the two columns, the reader column has no width handle, the page column has.
    expect(html).toContain('id="cx-sheet-test-leaf"');
    expect(html).toContain('id="cx-sheet-test-leaf-reader"');
    expect(html.match(/cx-sheet-edge/g)).toHaveLength(1);
    expect(html).toContain(t("sheet.readerCloseTip"));
    expect(html).toContain(t("sheet.parkPage", { page: "Read" }));
    // Closing the reader is not the sheet's close button in that column.
    expect(html.match(new RegExp(`aria-label="${t("header.close")}"`, "g"))).toHaveLength(1);
  });

  it("mirrors it when the page docks on the right", () => {
    const h = fakeServices();
    openPage(h.leaf.store, "time");
    setPageDock(h.leaf.store, "time", "right");
    pushSheet(h.leaf.store, READER);
    const html = renderApp(h);
    const stage = html.indexOf('class="cx-main"');
    expect(html.indexOf("is-reader-column")).toBeLessThan(stage);
    expect(html.indexOf("is-page-column")).toBeGreaterThan(stage);
  });

  it("draws one sheet, the reader, at M", () => {
    const h = fakeServices();
    readAndReader(h);
    setBp(h, "M");
    const html = renderApp(h);
    expect(html).not.toContain("has-pair");
    expect(html.match(/<aside/g)).toHaveLength(1);
  });

  it("parks the page as a vertical tab with its name, and the tab brings it back", () => {
    const h = fakeServices();
    readAndReader(h);
    setPagePark(h.leaf.store, true);
    const html = renderApp(h);
    expect(html).toContain("cx-sheet-tab");
    expect(html).toContain(`aria-label="${t("sheet.tabOpen", { page: "Read" })}"`);
    expect(html.match(/<aside/g)).toHaveLength(2);
    // Only the reader keeps a body.
    expect(html.match(/cx-sheet-body/g)).toHaveLength(1);
    setPagePark(h.leaf.store, false);
    expect(renderApp(h).match(/cx-sheet-body/g)).toHaveLength(2);
  });
});
