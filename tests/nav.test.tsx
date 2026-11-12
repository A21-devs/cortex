/**
 * The left rail (XL, L) and the header's page picker (M, S): the item → route and view mapping, the active
 * destination derived from the sheet, the short and full lists, the persisted toggles, the dots carried over
 * from the old page tabs, the meters, and the You page (with the sample record and with an empty index).
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { setSandbox } from "../src/plugin/container";
import { featureOn, type FeatureId } from "../src/shared/features";
import { ItemFlag } from "../src/shared/index-format";
import { SHEET_PAGE_ROUTES } from "../src/shared/views";
import { openPage, openTab, pushSheet, setNavFull, setNavMore, showTodayEntries } from "../src/state/actions";
import { captureLeafState, restoreLeafState } from "../src/state/persist";
import { defaultShared } from "../src/state/types";
import { App } from "../src/ui/App";
import { railVisible, railWidth, SHELL, stageBox } from "../src/ui/breakpoints";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { t } from "../src/ui/copy";
import { PageTabs } from "../src/ui/header/PageTabs";
import { badgeText, navExtras, navMeters } from "../src/ui/nav/Nav";
import {
  activeNavItem,
  NAV_ITEM_IDS,
  NAV_TARGET,
  navAvailable,
  navPickerItems,
  navRows,
  openNavItem,
  type NavHooks,
  type NavItemId,
} from "../src/ui/nav/navModel";
import { monthLabel, pct, You, youStats } from "../src/ui/pages/You";
import { buildSampleIndex } from "../src/worker/sampleIndex";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

function hooks(): NavHooks & { calls: string[]; writable: boolean } {
  const h = { calls: [] as string[], writable: true, add: () => h.calls.push("add"), ask: () => h.calls.push("ask"), canWrite: () => h.writable };
  return h;
}

function leafStore(): ReturnType<typeof fakeServices>["leaf"]["store"] {
  return fakeServices().leaf.store;
}

const render_ = (h: FakeHarness, node: preact.ComponentChild) =>
  render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>{node}</LeafContext.Provider>
    </ServicesContext.Provider>,
  );

const WITHOUT = (...off: FeatureId[]) => (id: FeatureId) => !off.includes(id);

describe("nav: item → route and view", () => {
  const open = (id: NavItemId) => {
    const store = leafStore();
    const hk = hooks();
    openNavItem(store, id, hk);
    return { ui: store.get("ui"), hk };
  };
  const page = (id: NavItemId) => {
    const { ui } = open(id);
    return { open: ui.sheet.open, tab: ui.tab, top: ui.sheet.stack[ui.sheet.index], stack: ui.sheet.stack };
  };

  it("Brain closes the sheet", () => {
    const store = leafStore();
    openPage(store, "time");
    openNavItem(store, "brain", hooks());
    expect(store.get("ui").sheet.open).toBe(false);
    expect(store.get("ui").tab).toBe("brain");
  });
  it("Navigator opens Read; Today opens the day's note in the reader column beside Read", () => {
    expect(page("navigator").top).toEqual({ kind: "page", route: "read" });
    expect(page("today").top).toEqual({ kind: "reader", route: "today", id: "today" });
    expect(page("today").stack[0]).toEqual({ kind: "page", route: "read" });
    expect(page("today").tab).toBe("read");
  });
  it("Today lights while its note is open and closes the sheet when chosen again; its entries link is Read's Today filter", () => {
    const store = leafStore();
    openNavItem(store, "today", hooks());
    expect(activeNavItem(store.get("ui"))).toBe("today");
    showTodayEntries(store);
    const ui = store.get("ui");
    expect(ui.sheet.stack).toEqual([{ kind: "page", route: "read", params: { today: "1" } }]);
    expect(ui.sheet.index).toBe(0);
    expect(activeNavItem(ui)).toBe("today");
    openNavItem(store, "today", hooks());
    expect(store.get("ui").sheet.open).toBe(true);
    openNavItem(store, "today", hooks());
    expect(store.get("ui").sheet.open).toBe(false);
  });
  it("Write pushes the New entry page on Read, so Back returns to Read; the sample record refuses it", () => {
    const w = page("write");
    expect(w.top).toEqual({ kind: "page", route: "new-entry" });
    expect(w.stack).toHaveLength(2);
    expect(w.stack[0]).toEqual({ kind: "page", route: "read" });
    const store = leafStore();
    const hk = hooks();
    hk.writable = false;
    openNavItem(store, "write", hk);
    expect(store.get("ui").sheet.open).toBe(false);
  });
  it("Timeline and Numbers open the Time sheet's figure and data views", () => {
    expect(page("timeline").top).toEqual({ kind: "page", route: "time" });
    expect(page("numbers").top).toEqual({ kind: "page", route: "time", params: { tab: "data" } });
  });
  it("Review and Lab open the Agents sheet's checks and ledger views", () => {
    expect(page("review").top).toEqual({ kind: "page", route: "agents", params: { tab: "checks" } });
    expect(page("lab").top).toEqual({ kind: "page", route: "agents" });
  });
  it("Files opens the Sources sheet's files view; Learn the guide; You the new page", () => {
    expect(page("files").top).toEqual({ kind: "page", route: "sources", params: { tab: "files" } });
    expect(page("learn").top).toEqual({ kind: "page", route: "guide" });
    expect(page("you").top).toEqual({ kind: "page", route: "you" });
  });
  it("+ Add and Your AI call the app's flows instead of changing the sheet", () => {
    const a = open("add");
    expect(a.hk.calls).toEqual(["add"]);
    expect(a.ui.sheet.open).toBe(false);
    const q = open("ai");
    expect(q.hk.calls).toEqual(["ask"]);
    expect(q.ui.sheet.open).toBe(false);
  });
  it("every destination has a target, and every page target is a known sheet route", () => {
    expect(NAV_ITEM_IDS).toHaveLength(13);
    for (const id of NAV_ITEM_IDS) {
      const target = NAV_TARGET[id];
      expect(target).toBeDefined();
      if (target.kind === "page") expect(SHEET_PAGE_ROUTES).toContain(target.route);
      expect(t(`nav.${id}`)).not.toBe(`nav.${id}`);
    }
  });
});

describe("nav: the active destination comes from the sheet", () => {
  const active = (go: (s: ReturnType<typeof leafStore>) => void, on?: (id: FeatureId) => boolean) => {
    const store = leafStore();
    go(store);
    return activeNavItem(store.get("ui"), on);
  };
  it("is Brain with the sheet closed and for a reader opened over the stage", () => {
    expect(active(() => undefined)).toBe("brain");
    expect(active((s) => pushSheet(s, { kind: "reader", route: "entry", id: "e_1" }))).toBe("brain");
  });
  it("round-trips every destination that opens a page", () => {
    for (const id of NAV_ITEM_IDS) {
      if (id === "add" || id === "ai" || id === "brain") continue;
      const store = leafStore();
      openNavItem(store, id, hooks());
      expect(activeNavItem(store.get("ui")), id).toBe(id);
    }
  });
  it("follows Read's Today filter and keeps Navigator lit for a reader opened from Read", () => {
    expect(active((s) => openPage(s, "read", { today: "1" }))).toBe("today");
    expect(active((s) => openPage(s, "read", { tab: "folder" }))).toBe("navigator");
    expect(
      active((s) => {
        openPage(s, "read");
        pushSheet(s, { kind: "reader", route: "conversation", id: "c_1" });
      }),
    ).toBe("navigator");
  });
  it("splits Time and Agents by their sub-view, and Sources into Files and + Add", () => {
    expect(active((s) => openPage(s, "time", { tab: "data" }))).toBe("numbers");
    expect(active((s) => openPage(s, "time"))).toBe("timeline");
    expect(active((s) => openPage(s, "agents", { tab: "checks" }))).toBe("review");
    expect(active((s) => openPage(s, "agents", { tab: "access" }))).toBe("lab");
    expect(active((s) => openPage(s, "runs"))).toBe("lab");
    expect(active((s) => openPage(s, "sources", { tab: "files" }))).toBe("files");
    expect(active((s) => openPage(s, "sources", { tab: "privacy" }))).toBe("add");
  });
  it("lights Your AI for Change history and Brain for the Chart page", () => {
    expect(active((s) => openPage(s, "change-history"))).toBe("ai");
    expect(active((s) => openPage(s, "chart"))).toBe("brain");
  });
  it("does not light a destination whose feature has not shipped", () => {
    expect(active((s) => openPage(s, "agents", { tab: "checks" }), WITHOUT("checks"))).toBe("lab");
    expect(active((s) => openPage(s, "sources", { tab: "files" }), WITHOUT("sourcesFiles"))).toBe("add");
  });
});

describe("nav: short and full lists", () => {
  const names = (rows: ReturnType<typeof navRows>) => rows.map((r) => (r.kind === "more" ? "more" : r.items.join("+")));
  it("short mode lists Brain · Navigator · Write+Today · + Add · More", () => {
    expect(names(navRows(false, false))).toEqual(["brain", "navigator", "write+today", "add", "more"]);
  });
  it("More expands inline to Timeline, Numbers, You, Review, Files, Learn, Lab, Your AI", () => {
    expect(names(navRows(false, true))).toEqual(["brain", "navigator", "write+today", "add", "more", "timeline", "numbers", "you", "review", "files", "learn", "lab", "ai"]);
  });
  it("Show everything lists every destination flat, in its own order, with no More row", () => {
    expect(names(navRows(true, false))).toEqual(["brain", "navigator", "write+today", "timeline", "numbers", "you", "review", "lab", "files", "learn", "ai", "add"]);
    expect(names(navRows(true, true))).toEqual(names(navRows(true, false)));
  });
  it("leaves out a destination whose feature has not shipped, and a row that empties", () => {
    const rows = navRows(true, false, WITHOUT("newEntry", "today", "ask"));
    expect(names(rows)).not.toContain("ai");
    expect(names(rows)).not.toContain("write+today");
    expect(names(navRows(true, false, WITHOUT("newEntry")))).toContain("today");
    expect(navAvailable("review", WITHOUT("checks"))).toBe(false);
    expect(navAvailable("brain", () => false)).toBe(true);
  });
  it("the page picker (M, S) lists every destination", () => {
    expect([...navPickerItems()].sort()).toEqual([...NAV_ITEM_IDS].sort());
  });
});

describe("nav: persisted toggles", () => {
  const settings = fakeServices().services.settings.value;
  it("defaults to every page listed, with More closed", () => {
    const ui = leafStore().get("ui");
    expect([ui.navFull, ui.navMore]).toEqual([true, false]);
  });
  it("Show everything and the More group survive a save and restore", () => {
    const a = leafStore();
    setNavFull(a, false);
    setNavMore(a, true);
    const saved = captureLeafState(a);
    expect([saved.navAll, saved.navMore]).toEqual([false, true]);
    const b = leafStore();
    restoreLeafState(b, JSON.parse(JSON.stringify(saved)), settings);
    expect([b.get("ui").navFull, b.get("ui").navMore]).toEqual([false, true]);
  });
  it("an older saved state, or a damaged value, restores the defaults", () => {
    const a = leafStore();
    const saved = captureLeafState(a) as unknown as Record<string, unknown>;
    delete saved.navAll;
    delete saved.navMore;
    const b = leafStore();
    setNavFull(b, false);
    restoreLeafState(b, saved, settings);
    expect([b.get("ui").navFull, b.get("ui").navMore]).toEqual([true, false]);
    restoreLeafState(b, { ...saved, navAll: "yes", navMore: 1 }, settings);
    expect([b.get("ui").navFull, b.get("ui").navMore]).toEqual([true, false]);
    // The first build saved its short-list default as navFull:false; that key no longer counts.
    restoreLeafState(b, { ...saved, navFull: false }, settings);
    expect(b.get("ui").navFull).toBe(true);
  });
  it("accepts a persisted You page", () => {
    const a = leafStore();
    openNavItem(a, "you", hooks());
    const b = leafStore();
    restoreLeafState(b, JSON.parse(JSON.stringify(captureLeafState(a))), settings);
    expect(b.get("ui").sheet.stack).toEqual([{ kind: "page", route: "you" }]);
    expect(b.get("ui").sheet.open).toBe(true);
  });
});

describe("nav: what the old page tabs carried", () => {
  const base = defaultShared();
  it("puts the Checks badge on Review and the activity dot on Lab", () => {
    const x = navExtras({ activity: { ...base.activity, jobs: [{ id: "j", kind: "label", phase: "run", done: 0 }], runner: "child" }, queues: { ...base.queues, checks: 120 }, agentsEnabled: true, firstRunDone: true });
    expect(x.review?.badge).toBe("99+");
    expect(x.lab?.tone).toBe("running");
    expect(x.add).toBeUndefined();
  });
  it("hides both before the first run and at zero checks", () => {
    expect(navExtras({ activity: { ...base.activity, paused: true }, queues: base.queues, agentsEnabled: true, firstRunDone: false }).lab).toBeUndefined();
    expect(navExtras({ activity: base.activity, queues: base.queues, agentsEnabled: true, firstRunDone: true }).review).toBeUndefined();
    expect(badgeText(0)).toBeNull();
    expect(badgeText(7)).toBe("7");
  });
  it("puts the Sources attention dot on + Add and Files", () => {
    const x = navExtras({ activity: { ...base.activity, runner: "unavailable" }, queues: base.queues, agentsEnabled: true, firstRunDone: true });
    expect(x.add?.attention).toBe(true);
    expect(x.files?.attention).toBe(true);
    expect(x.lab?.attention).toBeUndefined();
  });
});

describe("nav: meters", () => {
  it("organised = filed over everything queued; checks done = checked over filed; none without data", () => {
    expect(navMeters([{ checked: 10, done: 30, waiting: 60 }, { checked: 0, done: 10, waiting: 0 }])).toEqual({ organised: 45, checksDone: 20 });
    expect(navMeters([{ checked: 0, done: 0, waiting: 5 }])).toEqual({ organised: 0, checksDone: null });
    expect(navMeters([])).toEqual({ organised: null, checksDone: null });
  });
});

describe("nav: the shell", () => {
  it("shows the rail at XL, L and (narrower) M, and takes its width off the stage box", () => {
    expect([railVisible("XL"), railVisible("L"), railVisible("M"), railVisible("S"), railVisible("Mini"), railVisible("XL", true)]).toEqual([true, true, true, false, false, false]);
    expect([railWidth("XL"), railWidth("L"), railWidth("M"), railWidth("S"), railWidth("M", true)]).toEqual([SHELL.geometry.railW, SHELL.geometry.railW, SHELL.geometry.railWM, 0, 0]);
    const ui = leafStore().get("ui");
    expect(stageBox({ width: 1576, height: 933 }, { ...ui, breakpoint: "XL" }).width).toBe(1576 - SHELL.geometry.railW);
    expect(stageBox({ width: 900, height: 933 }, { ...ui, breakpoint: "M" }).width).toBe(900 - SHELL.geometry.railWM);
    expect(stageBox({ width: 600, height: 933 }, { ...ui, breakpoint: "S" }).width).toBe(600);
  });
  it("lists every destination flat with Show everything on, and marks the active one", () => {
    const h = fakeServices();
    h.leaf.store.update("ui", (ui) => ({ ...ui, breakpoint: "XL" }));
    setNavFull(h.leaf.store, true);
    openNavItem(h.leaf.store, "you", hooks());
    const html = render_(h, <App services={h.services} leaf={h.leaf} />);
    const order = [...html.matchAll(/data-nav="(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["brain", "navigator", "write", "today", "timeline", "numbers", "you", "review", "lab", "files", "learn", "ai", "add"]);
    expect(html).toMatch(/data-nav="you" class="cx-nav-item is-active"[^>]*aria-current="page"/);
    expect(html).not.toContain("cx-nav-more");
  });
  it("shows More expanded inline in the short list", () => {
    const h = fakeServices();
    h.leaf.store.update("ui", (ui) => ({ ...ui, breakpoint: "L" }));
    setNavFull(h.leaf.store, false);
    setNavMore(h.leaf.store, true);
    const html = render_(h, <App services={h.services} leaf={h.leaf} />);
    expect([...html.matchAll(/data-nav="(\w+)"/g)].map((m) => m[1])).toEqual(["brain", "navigator", "write", "today", "add", "timeline", "numbers", "you", "review", "files", "learn", "lab", "ai"]);
    expect(html).toContain('aria-expanded="true"');
  });
  it("has no rail at S; the header's page picker names the active destination", () => {
    const h = fakeServices();
    h.leaf.store.update("ui", (ui) => ({ ...ui, breakpoint: "S" }));
    openNavItem(h.leaf.store, "numbers", hooks());
    const html = render_(h, <App services={h.services} leaf={h.leaf} />);
    expect(html).not.toContain("cx-rail");
    expect(html).toContain("cx-page-picker");
    expect(html).toContain("Page: Data");
    expect(html).toMatch(/class="cx-scope[ "]/);
    h.leaf.store.update("ui", (ui) => ({ ...ui, breakpoint: "XL" }));
    expect(render_(h, <PageTabs />)).toBe("");
  });
  it("moves the space chip into the rail at XL", () => {
    const h = fakeServices();
    h.leaf.store.update("ui", (ui) => ({ ...ui, breakpoint: "XL" }));
    const html = render_(h, <App services={h.services} leaf={h.leaf} />);
    expect(html.match(/class="cx-scope"/g)).toHaveLength(1);
    expect(html.indexOf("cx-rail-scope")).toBeGreaterThan(html.indexOf("cx-body"));
  });
  it("leaves openTab('brain') as the way to close the sheet", () => {
    const store = leafStore();
    openPage(store, "you");
    openTab(store, "brain");
    expect(activeNavItem(store.get("ui"))).toBe("brain");
  });
});

describe("You page", () => {
  const NOW = Date.UTC(2026, 10, 10);
  const ix = buildSampleIndex(7, NOW);

  it("counts your entries against everything, by source and by month", () => {
    const s = youStats(ix);
    expect(s.total).toBeGreaterThan(1000);
    expect(s.you + s.assistants + s.others).toBe(s.total);
    expect(s.you).toBeGreaterThan(0);
    expect(s.you).toBeLessThan(s.total);
    expect(s.bySource.reduce((n, r) => n + r.total, 0)).toBe(s.total);
    expect(s.bySource.reduce((n, r) => n + r.you, 0)).toBe(s.you);
    expect(s.byMonth.length).toBeGreaterThan(12);
    expect(s.byMonth.map((r) => r.key)).toEqual([...s.byMonth.map((r) => r.key)].sort());
    expect(s.byMonth.reduce((n, r) => n + r.total, 0)).toBeLessThanOrEqual(s.total);
    expect(youStats(ix)).toBe(s);
  });
  it("leaves out excluded material", () => {
    const before = youStats(ix).total;
    const copy = { ...ix, cols: { ...ix.cols, flags: Uint32Array.from(ix.cols.flags, (f, i) => (i === 0 ? f | ItemFlag.Excluded : f)) } };
    const after = youStats(copy as typeof ix).total;
    expect(after).toBeLessThanOrEqual(before);
  });
  it("rounds shares and labels months", () => {
    expect(pct(1, 3)).toBe(33);
    expect(pct(0, 0)).toBe(0);
    expect(monthLabel("2026-04")).toBe("Apr 2026");
  });
  it("renders with no index: the hero says there is nothing yet, the other blocks still show", () => {
    const h = fakeServices();
    const html = render_(h, <You />);
    expect(html).toContain(t("you.heroEmpty"));
    for (const k of ["you.open", "you.dates", "you.readers"] as const) expect(html).toContain(t(k));
    expect(html).not.toContain("cx-you-pct");
  });
  it("renders with the sample record: share, bar, sources, months, and sample-safe blocks", () => {
    const h = fakeServices();
    Object.defineProperty(h.services.index, "index", { value: { value: ix }, configurable: true });
    setSandbox(h.services, true);
    const html = render_(h, <You />);
    const s = youStats(ix);
    expect(html).toContain(`${pct(s.you, s.total)}%`);
    expect(html).toContain(t("you.heroLabel"));
    expect(html).toContain("cx-you-bar");
    expect(html).toContain(t("you.bySource"));
    expect(html).toContain(t("you.byMonth"));
    expect(html).toContain(t("you.datesSample"));
    expect(html).toContain(t("you.readersSample"));
    expect(html).toContain(t("you.checksNone"));
  });
  it("links to Review when checks are open", () => {
    const h = fakeServices();
    h.services.shared.update("queues", { checks: 5 });
    const html = render_(h, <You />);
    expect(featureOn("checks")).toBe(true);
    expect(html).toContain(t("you.checksOpen", { n: 5 }));
    expect(html).toContain(t("you.openReview"));
  });
});
