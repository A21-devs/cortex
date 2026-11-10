/**
 * Package 7: space switching on the chip (click, wheel, hover cycle), the loading percentage, the walkthrough
 * (model, offer, rendering, More and Guide entries, device state) and the render-side space flash and swirl.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it, vi } from "vitest";
import { setSandbox } from "../src/plugin/container";
import { RENDER_TUNING } from "../src/render/tuning";
import { POINTS_VERT } from "../src/render/shaders";
import { createCoreUniforms } from "../src/render/layers/points";
import { SPACE_ORDER } from "../src/shared/index-format";
import { ServicesContext, LeafContext, ShellContext, shellFor } from "../src/ui/context";
import { COPY, t } from "../src/ui/copy";
import { emptyDeviceState, markTourSeen, parseDeviceState } from "../src/ui/deviceState";
import { areaRows, ScopePicker } from "../src/ui/header/ScopePicker";
import { moreItems } from "../src/ui/header/MoreMenu";
import { createWheelGate, cycleOrder, startHoverCycle, stepCycle, wheelStep, HOVER_DELAY_MS, HOVER_STEP_MS, type Scope, type Timers } from "../src/ui/header/spaceCycle";
import { loadingModel } from "../src/ui/loading";
import { endTour, startTour, TourLayer } from "../src/ui/walkthrough/TourLayer";
import { CARD, cardPlacement, stepTour, tourOffered, tourSteps, WALK_STEPS } from "../src/ui/walkthrough/tourModel";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

function renderIn(h: FakeHarness, node: preact.ComponentChild, shell = shellFor(h.leaf)): string {
  return render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>
        <ShellContext.Provider value={shell}>{node}</ShellContext.Provider>
      </LeafContext.Provider>
    </ServicesContext.Provider>,
  );
}

/** A fake clock for the hover cycle. */
function clock(): Timers & { advance(ms: number): void } {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout(fn, ms) {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(h) {
      pending.delete(h as number);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

describe("space chip: the cycle", () => {
  const rows = areaRows(undefined, null);
  const order = cycleOrder(rows, null);

  it("starts at All areas, lists the areas in menu order, and adds No area only when something is in it", () => {
    expect(order[0]).toBe("all");
    expect(order.slice(1)).toEqual(rows.map((r) => r.id));
    expect(order).not.toContain("none");
    const counts = { notes: 1, record: 1, notesBySpace: { none: 1 }, recordBySpace: {} } as never;
    expect(cycleOrder(rows, counts).at(-1)).toBe("none");
  });

  it("steps forward and back around the cycle and wraps", () => {
    expect(stepCycle(order, "all", 1)).toBe(order[1]);
    expect(stepCycle(order, "all", -1)).toBe(order.at(-1));
    expect(stepCycle(order, order.at(-1) as Scope, 1)).toBe("all");
    expect(stepCycle(order, order[2] as Scope, -1)).toBe(order[1]);
    expect(stepCycle([], "all", 1)).toBe("all");
    // An area that has dropped out of the list starts over from All areas.
    expect(stepCycle(["all", "code"], "web", 1)).toBe("code");
  });

  it("the wheel steps once per burst: down is next, up is previous", () => {
    expect(wheelStep(100, Number.NEGATIVE_INFINITY, 1000)).toBe(1);
    expect(wheelStep(-100, Number.NEGATIVE_INFINITY, 1000)).toBe(-1);
    expect(wheelStep(100, 1000, 1030)).toBe(0);
    expect(wheelStep(100, 1000, 1100)).toBe(1);
    expect(wheelStep(0, Number.NEGATIVE_INFINITY, 1000)).toBe(0);
  });

  it("a long trackpad flick is one step: every event renews the gap", () => {
    const gate = createWheelGate();
    const dirs: number[] = [];
    for (let t0 = 1000; t0 < 1800; t0 += 16) dirs.push(gate(40, t0)); // 50 events 16 ms apart
    expect(dirs.filter((d) => d !== 0)).toEqual([1]);
    expect(gate(40, 2500)).toBe(1); // a separate notch after a pause steps again
    expect(gate(0, 3000)).toBe(0);
  });

  it("hover: nothing before the delay, then one area every step, and leaving restores", () => {
    const c = clock();
    const seen: (Scope | null)[] = [];
    const h = startHoverCycle({ order: () => order, current: () => "all", onPreview: (s) => seen.push(s), timers: c });
    c.advance(HOVER_DELAY_MS - 1);
    expect(seen).toEqual([]);
    c.advance(1);
    expect(seen).toEqual([order[1]]);
    c.advance(HOVER_STEP_MS);
    c.advance(HOVER_STEP_MS);
    expect(seen).toEqual([order[1], order[2], order[3]]);
    h.cancel();
    expect(seen.at(-1)).toBeNull();
    c.advance(10_000);
    expect(seen).toHaveLength(4);
  });

  it("hover: leaving before the delay does nothing at all", () => {
    const c = clock();
    const onPreview = vi.fn();
    startHoverCycle({ order: () => order, current: () => "all", onPreview, timers: c }).cancel();
    c.advance(10_000);
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("hover starts from the current area", () => {
    const c = clock();
    const seen: (Scope | null)[] = [];
    startHoverCycle({ order: () => order, current: () => order[3] as Scope, onPreview: (s) => seen.push(s), timers: c });
    c.advance(HOVER_DELAY_MS);
    expect(seen).toEqual([order[4]]);
  });
});

describe("space chip: markup", () => {
  it("a name button (click = next) and a caret button that opens the menu, inside one chip", () => {
    const h = fakeServices();
    const html = renderIn(h, <ScopePicker />);
    expect(html).toContain('class="cx-scope"');
    expect(html).toContain('class="cx-scope-main"');
    expect(html).toContain('class="cx-scope-menu"');
    expect(html).toContain(`aria-label="${t("header.scopeMenu")}"`);
    expect(html).toContain(t("header.allAreas"));
    expect(html).toContain(`title="${t("header.scopeTip")}"`);
  });

  it("the small icon stays one button (its click opens the menu)", () => {
    const html = renderIn(fakeServices(), <ScopePicker iconOnly />);
    expect(html).toContain("cx-scope is-icon");
    expect(html).not.toContain("cx-scope-menu");
  });

  it("shows the real scope, not a stale preview", () => {
    const h = fakeServices();
    h.leaf.store.update("ui", { scope: SPACE_ORDER[0]! });
    const html = renderIn(h, <ScopePicker />);
    expect(html).toContain(`data-scope="${SPACE_ORDER[0]}"`);
  });
});

describe("render: the new space flashes, returning to All swirls", () => {
  it("has tuning, uniforms and shader code for both", () => {
    expect(RENDER_TUNING.scope.flashMs).toBeGreaterThanOrEqual(500);
    expect(RENDER_TUNING.scope.flashMs).toBeLessThanOrEqual(700);
    expect(RENDER_TUNING.scope.swirlMs).toBeGreaterThan(300);
    const u = createCoreUniforms();
    expect(u.uScopeFlash?.value).toBe(0);
    expect(u.uSwirl?.value).toBe(0);
    expect(POINTS_VERT).toContain("uniform float uScopeFlash");
    expect(POINTS_VERT).toContain("uniform float uSwirl");
    // Rest state (both 0) leaves the points exactly where they were: the swirl is scaled by sin(PI * uSwirl).
    expect(POINTS_VERT).toContain("sin(PI * uSwirl)");
  });
});

describe("loading line: Reading your record… N%", () => {
  const base = { data: { phase: "loading" as const, progress: 0.25, available: 0 }, jobs: [], firstRunCard: false, stageStatus: "ok" as const };
  it("carries the percentage", () => {
    expect(loadingModel(base).stageLine).toBe("Reading your record… 25%");
    expect(t("app.readingPct", { p: 5 })).toBe("Reading your record… 5%");
  });
  it("keeps the plain line, the first-run line and quiet states", () => {
    expect(loadingModel({ ...base, jobs: [{ id: "i", kind: "index", phase: "build", done: 1, total: 2 }] }).stageLine).toContain("First run");
    expect(loadingModel({ ...base, data: { phase: "ready", progress: 1, available: 3 } }).stageLine).toBeNull();
  });
});

describe("tour: model", () => {
  it("has seven steps, in order, each with its own copy", () => {
    expect(WALK_STEPS.map((s) => s.id)).toEqual(["figure", "spine", "legend", "time", "nav", "ask", "add"]);
    for (const s of WALK_STEPS) {
      expect(t(s.title)).not.toBe(s.title);
      expect(t(s.body)).not.toBe(s.body);
    }
    expect(tourSteps({ ask: true })).toHaveLength(7);
    expect(tourSteps({ ask: false }).map((s) => s.id)).not.toContain("ask");
  });

  it("steps within the list and finishes off either end", () => {
    expect(stepTour(0, 1, 7)).toBe(1);
    expect(stepTour(3, -1, 7)).toBe(2);
    expect(stepTour(6, 1, 7)).toBeNull();
    expect(stepTour(0, -1, 7)).toBeNull();
  });

  it("places the card below a target, above it when there is no room, beside it, and centred without one", () => {
    const view = { width: 1000, height: 700 };
    const strip = { left: 0, top: 400, width: 200, height: 40 };
    expect(cardPlacement(strip, view).top).toBe(452);
    const bottom = { left: 100, top: 640, width: 200, height: 40 };
    expect(cardPlacement(bottom, view).top).toBe(640 - CARD.gap - CARD.h);
    const rail = { left: 0, top: 0, width: 168, height: 700 };
    expect(cardPlacement(rail, view).left).toBe(168 + CARD.gap);
    const c = cardPlacement(null, view);
    expect(c.left).toBe((1000 - CARD.w) / 2);
    // Never outside the view.
    const edge = cardPlacement({ left: 980, top: 10, width: 20, height: 20 }, view);
    expect(edge.left + CARD.w).toBeLessThanOrEqual(view.width - CARD.margin);
    // A target that fills the stage is not pointed at: the card is centred.
    expect(cardPlacement({ left: 0, top: 0, width: 1000, height: 700 }, view)).toEqual(c);
  });

  it("is offered once, after the first run, when there is something to point at", () => {
    const ok = { firstRunDone: true, hasFigure: true, tourSeen: false, running: false };
    expect(tourOffered(ok)).toBe(true);
    expect(tourOffered({ ...ok, firstRunDone: false })).toBe(false);
    // The demo brain started from the first-run card gets the offer too, before setup is done.
    expect(tourOffered({ ...ok, firstRunDone: false, sandbox: true })).toBe(true);
    expect(tourOffered({ ...ok, firstRunDone: false, sandbox: true, tourSeen: true })).toBe(false);
    expect(tourOffered({ ...ok, firstRunDone: false, sandbox: true, hasFigure: false })).toBe(false);
    expect(tourOffered({ ...ok, hasFigure: false })).toBe(false);
    expect(tourOffered({ ...ok, tourSeen: true })).toBe(false);
    expect(tourOffered({ ...ok, running: true })).toBe(false);
  });
});

describe("tour: device state", () => {
  it("remembers that it was offered, and survives a malformed file", () => {
    expect(emptyDeviceState().tourSeen).toBe(false);
    expect(markTourSeen(emptyDeviceState()).tourSeen).toBe(true);
    expect(parseDeviceState({ tourSeen: true }).tourSeen).toBe(true);
    expect(parseDeviceState({ tourSeen: "yes" }).tourSeen).toBe(false);
    expect(parseDeviceState(null).tourSeen).toBe(false);
  });
});

describe("tour: the layer", () => {
  const ready = (h: FakeHarness) => {
    h.services.shared.update("data", { phase: "ready", progress: 1, available: 10, notes: 4, record: 6 });
  };

  it("offers itself once the figure is up after the first run", () => {
    const h = fakeServices((s) => void (s.general.firstRunDone = true));
    ready(h);
    const html = renderIn(h, <TourLayer />);
    expect(html).toContain(t("tour.offerTitle"));
    expect(html).toContain(t("tour.start"));
    expect(html).toContain(t("tour.later"));
  });

  it("is offered over the demo brain started from the first-run card, once", () => {
    const h = fakeServices();
    setSandbox(h.services, true);
    expect(h.services.settings.value.general.firstRunDone).toBe(false);
    const shell = shellFor(h.leaf);
    expect(renderIn(h, <TourLayer />, shell)).toContain(t("tour.offerTitle"));
    startTour(h.services, shell);
    endTour(h.services, shell);
    expect(renderIn(h, <TourLayer />, shell)).toBe("");
  });

  it("stays quiet before the first run, with an empty index, and after it has been answered", () => {
    const early = fakeServices();
    ready(early);
    expect(renderIn(early, <TourLayer />)).toBe("");
    const empty = fakeServices((s) => void (s.general.firstRunDone = true));
    expect(renderIn(empty, <TourLayer />)).toBe("");
    const seen = fakeServices((s) => void (s.general.firstRunDone = true));
    ready(seen);
    seen.services.device.update(markTourSeen);
    expect(renderIn(seen, <TourLayer />)).toBe("");
  });

  it("starting marks it seen and shows step 1 of 7 with Next, Skip and the demo offer", () => {
    const h = fakeServices((s) => void (s.general.firstRunDone = true));
    ready(h);
    const shell = shellFor(h.leaf);
    startTour(h.services, shell);
    expect(h.services.device.value.tourSeen).toBe(true);
    expect(shell.tour.value).toBe(0);
    const html = renderIn(h, <TourLayer />, shell);
    expect(html).toContain(t("tour.progress", { n: 1, total: 7 }));
    expect(html).toContain(t("tour.figureTitle"));
    expect(html).toContain(t("tour.next"));
    expect(html).toContain(t("tour.skip"));
    expect(html).not.toContain(t("tour.back"));
    expect(html).toContain(t("tour.demo"));
    expect(html).not.toContain(t("tour.offerTitle"));
  });

  it("the last step says Done, offers Back and the demo brain; Skip ends it", () => {
    const h = fakeServices((s) => void (s.general.firstRunDone = true));
    const shell = shellFor(h.leaf);
    shell.tour.value = 6;
    const html = renderIn(h, <TourLayer />, shell);
    expect(html).toContain(t("tour.addTitle"));
    expect(html).toContain(t("tour.done"));
    expect(html).toContain(t("tour.back"));
    expect(html).toContain(t("tour.demo"));
    endTour(h.services, shell);
    expect(shell.tour.value).toBeNull();
  });

  it("middle steps have no demo button, and the sample record never offers itself", () => {
    const h = fakeServices((s) => void (s.general.firstRunDone = true));
    const shell = shellFor(h.leaf);
    shell.tour.value = 3;
    expect(renderIn(h, <TourLayer />, shell)).not.toContain(t("tour.demo"));
    shell.tour.value = 0;
    setSandbox(h.services, true);
    expect(renderIn(h, <TourLayer />, shell)).not.toContain(t("tour.demo"));
  });
});

describe("tour: entry points", () => {
  it("More has Quick walkthrough", () => {
    expect(moreItems().map((i) => i.value)).toContain("tour");
    expect(moreItems().find((i) => i.value === "tour")?.label).toBe(COPY.more.tour);
  });
  it("Mini has no room to draw the walkthrough, so More does not offer it there", () => {
    expect(moreItems({ mini: true }).map((i) => i.value)).not.toContain("tour");
    expect(moreItems({ mini: false }).map((i) => i.value)).toContain("tour");
  });
  it("the empty state's sample button is the demo brain", () => {
    expect(COPY.firstRun.explore).toBe("Show a demo brain");
  });
});
