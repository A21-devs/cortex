/**
 * Page dock defaults and the parked tab (P-01, P-02): every rail page opens on the left, a rail click while one stands there
 * parks it as a vertical tab and opens the new page opposite, the tab swaps them back, and the Chart card stays beside a page.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { closeChartCard, closeSheet, keepChartCard, openPage, openTab, pushSheet, setPageDock, swapParked } from "../src/state/actions";
import type { Breakpoint } from "../src/state/types";
import { App } from "../src/ui/App";
import { chartCardAside, chartCardFits, defaultSheetSide, LEFT_PAGES, pageDock, PAIR_PAGES, SHELL, sheetPair, sheetSide, stageBox, stashTab } from "../src/ui/breakpoints";
import { t } from "../src/ui/copy";
import { toggleChartPage } from "../src/ui/keymap";
import { openNavItem, type NavHooks } from "../src/ui/nav/navModel";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

const READER = { kind: "reader", route: "entry", id: "e_1" } as const;
const VIEW = { width: 1512, height: 982 };
const hooks: NavHooks = { add: () => undefined, ask: () => undefined, canWrite: () => true };

const ui = (h: FakeHarness) => h.leaf.store.get("ui");
const setBp = (h: FakeHarness, bp: Breakpoint) => h.leaf.store.update("ui", { breakpoint: bp });
const html = (h: FakeHarness) => render(<App services={h.services} leaf={h.leaf} />);
const top = (h: FakeHarness) => ui(h).sheet.stack[ui(h).sheet.index];

describe("P-01: rail pages dock on the left", () => {
  it("docks every rail page left by default and the rest right", () => {
    for (const route of ["read", "time", "agents", "sources", "guide", "you", "add"] as const) {
      expect(LEFT_PAGES, route).toContain(route);
      expect(pageDock({}, route), route).toBe("left");
      expect(defaultSheetSide({ stack: [{ kind: "page", route }] }), route).toBe("left");
    }
    for (const route of ["chart", "runs", "new-entry", "change-history"] as const) expect(pageDock({}, route), route).toBe("right");
  });

  it("keeps the saved per-page choice over the default", () => {
    expect(pageDock({ docks: { time: "right" } }, "time")).toBe("right");
    expect(pageDock({ docks: { read: "right" } }, "read")).toBe("right");
    const h = fakeServices();
    openPage(h.leaf.store, "agents");
    expect(sheetSide(ui(h).sheet)).toBe("left");
    setPageDock(h.leaf.store, "agents", "right");
    expect(sheetSide(ui(h).sheet)).toBe("right");
  });

  it("keeps the narrow-window fallback: a window under XL ignores the new default", () => {
    expect(defaultSheetSide({ stack: [{ kind: "page", route: "time" }] }, "M")).toBe("right");
    expect(defaultSheetSide({ stack: [{ kind: "page", route: "read" }] }, "M")).toBe("left");
    expect(defaultSheetSide({ stack: [{ kind: "page", route: "time" }] }, "XL")).toBe("left");
  });

  it("puts the reader opposite a left page and pairs every rail page with it", () => {
    for (const route of ["time", "agents", "sources", "guide", "you"] as const) {
      expect(PAIR_PAGES).toContain(route);
      const h = fakeServices();
      openPage(h.leaf.store, route);
      pushSheet(h.leaf.store, READER);
      const pair = sheetPair(ui(h));
      expect([pair?.pageSide, pair?.readerSide], route).toEqual(["left", "right"]);
    }
  });

  it("re-centres the stage beside a left page", () => {
    const h = fakeServices();
    openPage(h.leaf.store, "time");
    const box = stageBox(VIEW, ui(h));
    expect(box.insetLeft).toBe(ui(h).sheet.width);
    expect(box.insetRight).toBe(0);
  });
});

describe("P-02: the parked tab", () => {
  it("a rail click while a left page is open parks it and opens the new page on the right", () => {
    const h = fakeServices();
    openNavItem(h.leaf.store, "navigator", hooks);
    expect(sheetSide(ui(h).sheet)).toBe("left");
    openNavItem(h.leaf.store, "timeline", hooks);
    const s = ui(h).sheet;
    expect(top(h)).toEqual({ kind: "page", route: "time" });
    expect(s.stash?.side).toBe("left");
    expect(s.stash?.stack[0]).toEqual({ kind: "page", route: "read" });
    expect(sheetSide(s)).toBe("right");
    expect(stashTab(ui(h))).not.toBeNull();
  });

  it("the stage keeps a thin strip for the tab and the page takes the other edge", () => {
    const h = fakeServices();
    openNavItem(h.leaf.store, "navigator", hooks);
    openNavItem(h.leaf.store, "timeline", hooks);
    const box = stageBox(VIEW, ui(h));
    expect(box.insetLeft).toBe(SHELL.geometry.sheet.tabW);
    expect(box.insetRight).toBe(ui(h).sheet.width);
  });

  it("draws the tab named for the parked page and the open page opposite", () => {
    const h = fakeServices();
    openNavItem(h.leaf.store, "navigator", hooks);
    openNavItem(h.leaf.store, "timeline", hooks);
    const out = html(h);
    expect(out).toContain("is-parked");
    expect(out).toContain(t("sheet.tabOpen", { page: t("pages.read") }));
    expect(out.indexOf("is-parked")).toBeLessThan(out.indexOf('class="cx-main"'));
    expect(out).toContain("sheet-right");
  });

  it("swaps back with the stack, selection and scroll key of the parked page kept, the other page taking the tab", () => {
    const h = fakeServices();
    openNavItem(h.leaf.store, "navigator", hooks);
    pushSheet(h.leaf.store, READER);
    const parkedStack = ui(h).sheet.stack;
    openNavItem(h.leaf.store, "timeline", hooks);
    swapParked(h.leaf.store);
    const s = ui(h).sheet;
    expect(s.stack).toEqual(parkedStack);
    expect(top(h)).toEqual(READER);
    expect(sheetSide(s)).toBe("left");
    expect(s.stash?.side).toBe("right");
    expect(s.stash?.stack[0]).toEqual({ kind: "page", route: "time" });
    // And again: Time comes back on the right.
    swapParked(h.leaf.store);
    expect(top(h)).toEqual({ kind: "page", route: "time" });
    expect(ui(h).sheet.stash?.side).toBe("left");
  });

  it("choosing the parked page's own destination swaps it back", () => {
    const h = fakeServices();
    openNavItem(h.leaf.store, "navigator", hooks);
    openNavItem(h.leaf.store, "timeline", hooks);
    openNavItem(h.leaf.store, "navigator", hooks);
    expect(top(h)).toEqual({ kind: "page", route: "read" });
    expect(ui(h).sheet.stash?.stack[0]).toEqual({ kind: "page", route: "time" });
  });

  it("a third page replaces the right one and the tab stays", () => {
    const h = fakeServices();
    openNavItem(h.leaf.store, "navigator", hooks);
    openNavItem(h.leaf.store, "timeline", hooks);
    openNavItem(h.leaf.store, "you", hooks);
    expect(top(h)).toEqual({ kind: "page", route: "you" });
    expect(ui(h).sheet.stash?.stack[0]).toEqual({ kind: "page", route: "read" });
    expect(sheetSide(ui(h).sheet)).toBe("right");
  });

  it("pairs nothing while a page is parked, and closing the sheet drops the tab", () => {
    const h = fakeServices();
    openNavItem(h.leaf.store, "navigator", hooks);
    openNavItem(h.leaf.store, "timeline", hooks);
    pushSheet(h.leaf.store, READER);
    expect(sheetPair(ui(h))).toBeNull();
    closeSheet(h.leaf.store);
    expect(ui(h).sheet.stash).toBeUndefined();
    expect(stashTab(ui(h))).toBeNull();
  });

  it("does not park below XL, on the right, or the page already open", () => {
    const m = fakeServices();
    setBp(m, "M");
    openNavItem(m.leaf.store, "navigator", hooks);
    openNavItem(m.leaf.store, "timeline", hooks);
    expect(ui(m).sheet.stash).toBeUndefined();
    const r = fakeServices();
    openNavItem(r.leaf.store, "timeline", hooks);
    setPageDock(r.leaf.store, "time", "right");
    openNavItem(r.leaf.store, "navigator", hooks);
    expect(ui(r).sheet.stash).toBeUndefined();
    const c = fakeServices();
    openNavItem(c.leaf.store, "navigator", hooks);
    openNavItem(c.leaf.store, "navigator", hooks);
    expect(ui(c).sheet.open).toBe(false);
    expect(ui(c).sheet.stash).toBeUndefined();
  });
});

describe("P-01: the Chart card beside a page", () => {
  const withCard = (h: FakeHarness) => h.leaf.store.update("ui", { sheet: { ...ui(h).sheet, float: true } });

  it("stays up when a rail click opens a page, drawn beside it", () => {
    const h = fakeServices();
    withCard(h);
    openPage(h.leaf.store, "chart");
    openNavItem(h.leaf.store, "timeline", hooks);
    expect(top(h)).toEqual({ kind: "page", route: "time" });
    expect(ui(h).sheet.card).toBe(true);
    expect(chartCardAside(ui(h))).toBe(true);
    const out = html(h);
    expect(out).toContain("is-card");
    // The card sits right of the left page: 168 rail + 400 page + 12 gap.
    expect(out).toContain(`left:${168 + stageBox({ width: 0, height: 0 }, ui(h)).insetLeft + 12}px`);
  });

  it("the Chart key with a page open adds the card beside it, and again takes it away", () => {
    const h = fakeServices();
    withCard(h);
    openPage(h.leaf.store, "time");
    expect(chartCardFits(ui(h))).toBe(true);
    toggleChartPage(h.leaf.store);
    expect(top(h)).toEqual({ kind: "page", route: "time" });
    expect(ui(h).sheet.card).toBe(true);
    toggleChartPage(h.leaf.store);
    expect(ui(h).sheet.card).toBeUndefined();
    expect(ui(h).sheet.open).toBe(true);
  });

  it("closing the sheet takes the card with it, and its own x leaves the page", () => {
    const h = fakeServices();
    withCard(h);
    openPage(h.leaf.store, "time");
    keepChartCard(h.leaf.store);
    closeChartCard(h.leaf.store);
    expect(ui(h).sheet.card).toBeUndefined();
    expect(top(h)).toEqual({ kind: "page", route: "time" });
    keepChartCard(h.leaf.store);
    closeSheet(h.leaf.store);
    expect(ui(h).sheet.card).toBeUndefined();
  });

  it("does not apply without the card setting, below XL, or with Chart already the page", () => {
    const off = fakeServices();
    openPage(off.leaf.store, "time");
    expect(chartCardFits(ui(off))).toBe(false);
    const m = fakeServices();
    withCard(m);
    setBp(m, "M");
    openPage(m.leaf.store, "time");
    expect(chartCardFits(ui(m))).toBe(false);
    const c = fakeServices();
    withCard(c);
    openPage(c.leaf.store, "chart");
    expect(chartCardFits(ui(c))).toBe(false);
  });

  it("opening the Chart page itself drops the card flag", () => {
    const h = fakeServices();
    withCard(h);
    openPage(h.leaf.store, "time");
    keepChartCard(h.leaf.store);
    openTab(h.leaf.store, "read");
    expect(ui(h).sheet.card).toBe(true);
    openPage(h.leaf.store, "chart");
    expect(ui(h).sheet.card).toBeUndefined();
    expect(top(h)).toEqual({ kind: "page", route: "chart" });
  });
});
