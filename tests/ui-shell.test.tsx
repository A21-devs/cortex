/**
 * The shell (owner E11; CORTEX-UX §2.5, §3, §5.1–§5.12, §8): left rail (XL, L) or page picker (M, S), the stage
 * overlays, the single sheet, breakpoints, the keyboard map, first-run checklist and hints, and display copy.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it, vi } from "vitest";
import { openPage, openTab, setMotion } from "../src/state/actions";
import { defaultView } from "../src/state/types";
import { App } from "../src/ui/App";
import { classify, compassVisible, figureFit, safeFrame, SHELL, sheetMode, stageBox, stripHeight } from "../src/ui/breakpoints";
import { LeafContext, ServicesContext, Shell, stageBus } from "../src/ui/context";
import { bindingFor, conflictsWithObsidian, KEYMAP, motionModeFor, PAGE_BY_DIGIT } from "../src/ui/keymap";
import { bindShell } from "../src/ui/mount";
import { isCordAnchor, labelColumns, layoutLabels } from "../src/ui/stage/LabelLayer";
import { setPose } from "../src/ui/stage/ShapeBar";
import { ToolColumn } from "../src/ui/stage/ToolColumn";
import { barHeight, barLayout, binAt, bracketRect, brushHit, dragPeriod, handleStep, presetWindow, stripLayout } from "../src/ui/strip/TimeStrip";
import { badgeText } from "../src/ui/header/PageTabs";
import { DisplayPopover } from "../src/ui/stage/DisplayPopover";
import { FirstRunCard } from "../src/ui/stage/FirstRunCard";
import { Hint, HINT_KEYS, nextHint } from "../src/ui/stage/Hints";
import { parsePeriod } from "../src/ui/strip/PeriodPopover";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

// The P1 surfaces (hints, point controls, checklist) are phase gated; these tests run the full build.
const phase = vi.hoisted(() => ({ value: "P2" as "P0" | "P1" | "P2" }));
vi.mock("../src/shared/features", async (orig) => {
  const m = await orig<typeof import("../src/shared/features")>();
  return { ...m, featureOn: (id: Parameters<typeof m.featureOn>[0], p = phase.value) => m.featureOn(id, p) };
});

function renderIn(h: FakeHarness, node: preact.ComponentChild): string {
  return render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>{node}</LeafContext.Provider>
    </ServicesContext.Provider>,
  );
}

describe("ui/App (§3)", () => {
  it("renders the left rail instead of header tabs at XL, and the sheet only when open", () => {
    const h = fakeServices();
    h.leaf.store.update("ui", (ui) => ({ ...ui, breakpoint: "XL" }));
    const html = renderIn(h, <App services={h.services} leaf={h.leaf} />);
    expect(html).toContain("cx-rail");
    expect(html).toContain('role="navigation"');
    for (const name of ["Brain", "Read", "Write", "Today", "Time", "Data", "Yours", "Checks", "Agents", "Files", "Guide", "Ask", "Add sources", "All pages"]) expect(html).toContain(`>${name}<`);
    expect(html).not.toContain("cx-page-picker");
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('id="cx-sheet-');
    openTab(h.leaf.store, "time");
    expect(renderIn(h, <App services={h.services} leaf={h.leaf} />)).toMatch(/data-nav="timeline" class="cx-nav-item is-active"/);
    h.leaf.store.update("ui", (ui) => ({ ...ui, navFull: false }));
    // With All pages off, Timeline lives in More: the closed group shows that something inside it is open, and expanded it lights Timeline.
    expect(renderIn(h, <App services={h.services} leaf={h.leaf} />)).toContain("cx-nav-more has-active");
    h.leaf.store.update("ui", (ui) => ({ ...ui, navMore: true }));
    expect(renderIn(h, <App services={h.services} leaf={h.leaf} />)).toMatch(/data-nav="timeline" class="cx-nav-item is-active"/);
    h.leaf.store.update("ui", (ui) => ({ ...ui, navMore: false }));
    const withSheet = renderIn(h, <App services={h.services} leaf={h.leaf} />);
    expect(withSheet).toContain('id="cx-sheet-test-leaf"');
    expect(withSheet).toContain("Your record month by month");
    openPage(h.leaf.store, "guide");
    expect(renderIn(h, <App services={h.services} leaf={h.leaf} />)).toContain("Fronds are conversations");
  });
  it("shows the empty-state card with the self-ticking checklist before the first run", () => {
    const h = fakeServices();
    const html = renderIn(h, <FirstRunCard />);
    expect(html).toContain("Your record is empty");
    expect(html).toContain("Open one conversation frond");
    expect(html).toContain("Double-click a branch off the spine");
    expect(html).not.toMatch(/tour/i);
  });
});

describe("ui/stage/DisplayPopover (§5.6)", () => {
  it("holds only Points and Motion, with a 0–200% speed slider", () => {
    const h = fakeServices();
    setPose(h.leaf.store, "standing");
    h.services.device.update((d) => ({ ...d, displayExpanded: true }));
    const html = renderIn(h, <DisplayPopover />);
    for (const s of ["Dot size", "Glow", "Brightness", "Scatter", "Drift", "Spin", "Speed", "100%", "Pause while pointing", "Keep upright", "Only this view changes."]) expect(html).toContain(s);
    expect(html).not.toMatch(/Turning|Spread|Limit rotation|Point size|Names on the figure|Conversation stems/);
  });
});

describe("ui/stage/Hints (§5.2)", () => {
  it("shows a surface's hint once per device", () => {
    const h = fakeServices();
    expect(Object.keys(HINT_KEYS)).toEqual(["stage", "strip", "shape", "compass", "command", "conversation"]);
    expect(nextHint([], "strip")).toBe("strip");
    expect(nextHint(["strip"], "strip")).toBeNull();
    expect(renderIn(h, <Hint id="command" />)).toContain("Press Tab to ask instead of find");
    h.services.device.update((d) => ({ ...d, hintsSeen: ["command"] }));
    expect(renderIn(h, <Hint id="command" />)).toBe("");
  });
});

describe("ui/breakpoints (§2.5)", () => {
  it("classifies the view's own size and docks the sheet accordingly", () => {
    expect(classify(1576, 933)).toBe("XL");
    expect(classify(1200, 900)).toBe("L");
    expect(classify(900, 900)).toBe("M");
    expect(classify(600, 900)).toBe("S");
    expect(classify(400, 900)).toBe("Mini");
    expect(classify(1576, 300)).toBe("Mini");
    expect(sheetMode("XL")).toBe("push");
    expect(sheetMode("M")).toBe("overlay");
    expect(sheetMode("S")).toBe("full");
    expect(compassVisible("XL", 500)).toBe(false);
    expect(stripHeight(600, "XL")).toBe(44);
    expect(stripHeight(933, "XL")).toBe(64);
  });
});

describe("ui/keymap (§8.1)", () => {
  it("binds the view-scoped keys without taking Obsidian's tab switching", () => {
    expect(KEYMAP.some(conflictsWithObsidian)).toBe(false);
    expect(bindingFor({ key: "k", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, false)?.action).toBe("focus-find");
    expect(bindingFor({ key: "K", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false }, false)?.action).toBe("focus-ask");
    expect(bindingFor({ key: "3", ctrlKey: false, metaKey: false, shiftKey: false, altKey: true }, false)?.arg).toBe("3");
    expect(PAGE_BY_DIGIT["3"]).toBe("time");
    expect(bindingFor({ key: "h", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, true)).toBeUndefined();
    expect(bindingFor({ key: "?", ctrlKey: false, metaKey: false, shiftKey: true, altKey: false }, false)?.action).toBe("guide");
  });
});

describe("header and strip helpers", () => {
  it("caps the checks badge and parses custom periods", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(63)).toBe("63");
    expect(badgeText(150)).toBe("99+");
    expect(parsePeriod("2026-11-02", "2026-11-08")).toEqual(["2026-11-02", "2026-11-08"]);
    expect(parsePeriod("2026-11-08", "2026-11-02")).toBeNull();
  });
});

describe("the standing figure (CORTEX-UX §3.2, §6, §12.19)", () => {
  it("takes its pose and motion from the shared view state, and Spin leads when standing", () => {
    expect(defaultView({ general: { pose: "standing" }, appearance: {} } as never).pose).toBe("standing");
    expect(defaultView({ general: { pose: "standing" }, appearance: {} } as never).motion.mode).toBe("spin");
    expect(motionModeFor("standing")).toBe("spin");
    expect(motionModeFor("lying")).toBe("drift");
    const h = fakeServices();
    setPose(h.leaf.store, "lying");
    expect(h.leaf.store.get("view").motion.mode).toBe("drift");
    setPose(h.leaf.store, "standing");
    expect(h.leaf.store.get("view").motion.mode).toBe("spin");
    setMotion(h.leaf.store, { mode: "off" });
    setPose(h.leaf.store, "lying");
    expect(h.leaf.store.get("view").motion.mode).toBe("off");
  });
  it("names the motion tool Spin standing and Drift lying, under one tool id", () => {
    const h = fakeServices();
    setPose(h.leaf.store, "standing");
    expect(renderIn(h, <ToolColumn />)).toContain("Spin · Space");
    setPose(h.leaf.store, "lying");
    expect(renderIn(h, <ToolColumn />)).toContain("Drift · Space");
    expect(bindingFor({ key: " ", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, false)?.action).toBe("toggle-motion");
  });
  it("frames the standing figure by height: the brain 9% down, the tip clear of the command line", () => {
    const f = safeFrame(1176, 825, "standing");
    expect(f.y).toBe(Math.round(825 * SHELL.figure.standing.topFraction));
    expect(f.y + f.h).toBe(825 - SHELL.figure.standing.bottom);
    expect(f.x + f.w / 2).toBe((24 + 1176 - 70) / 2);
    expect(safeFrame(1176, 825, "lying").y).toBe(SHELL.figure.lying.top);
    expect(safeFrame(420, 400, "standing", "Mini")).toEqual({ x: 8, y: 8, w: 404, h: 384 });
    expect(figureFit("Mini")).toBe("brain");
    expect(figureFit("XL")).toBe("figure");
  });
  it("puts label chips in two columns either side of the brain and outside the torso", () => {
    const frame = safeFrame(1176, 825, "standing");
    const cols = labelColumns("standing", { x: frame.x, y: frame.y, w: frame.w, h: frame.h });
    expect(labelColumns("lying", frame)).toBeNull();
    expect(cols).not.toBeNull();
    if (!cols) return;
    const anchor = (key: string, x: number, y: number, ordinal = 1) => ({ key, ordinal, x, y, depth: 0, priority: 1, kind: "Decision", glyph: "◆", title: "A decision", rgb: [1, 1, 1] as [number, number, number] });
    const brainY = frame.y + 40;
    const torsoY = cols.brainBottom + 200;
    const size = { width: 1176, height: 825 };
    const [a, b, c] = layoutLabels([anchor("a", cols.cx - 20, brainY), anchor("b", cols.cx + 20, brainY, 2), anchor("c", cols.cx - 10, torsoY, 3)], [], size, 24, cols);
    const k = SHELL.geometry.labels.columns;
    expect(a && a.x + a.w).toBeLessThan(cols.cx - k.brainHalfUnits * cols.pxPerUnit);
    expect(b && b.x).toBeGreaterThan(cols.cx + k.brainHalfUnits * cols.pxPerUnit);
    expect(c && c.x + c.w).toBeLessThan(cols.cx - k.torsoHalfUnits * cols.pxPerUnit);
    expect(isCordAnchor(anchor("cord:T4", cols.cx, torsoY))).toBe(true);
    const seg = layoutLabels([anchor("segment:T4", cols.cx - 1, torsoY)], [], size, 24, cols)[0];
    expect(seg && seg.x + seg.w).toBeLessThan(cols.cx);
    expect(seg && seg.x + seg.w).toBeGreaterThan(cols.cx - 40);
  });
});

describe("bindShell (view and renderer)", () => {
  function fakeRoot(width: number, height: number): HTMLElement {
    return { clientWidth: width, clientHeight: height, ownerDocument: { defaultView: null }, getBoundingClientRect: () => ({ width, height, left: 0, top: 0 }), querySelector: () => null } as unknown as HTMLElement;
  }
  it("sets the breakpoint from the view box and tells the renderer the pose's safe frame", async () => {
    const h = fakeServices();
    setPose(h.leaf.store, "standing");
    const shell = new Shell(h.leaf.viewId);
    const events: { width: number; height: number; safe: { y: number }; fit?: string }[] = [];
    stageBus(h.services.bus).on("stage:layout", (e) => events.push(e));
    const off = bindShell(shell, h.services, h.leaf, fakeRoot(1576, 933));
    expect(h.leaf.store.get("ui").breakpoint).toBe("XL");
    await new Promise((r) => setTimeout(r, 60));
    const box = stageBox({ width: 1576, height: 933 }, h.leaf.store.get("ui"));
    const last = events[events.length - 1];
    expect(last?.width).toBe(box.width);
    expect(last?.height).toBe(box.height);
    expect(last?.safe.y).toBe(Math.round(box.height * SHELL.figure.standing.topFraction));
    expect(last?.fit).toBe("figure");
    off();
  });
  it("feeds the compass needle at most 15 times a second, ignores other leaves, and stops under reduced motion", () => {
    const h = fakeServices();
    let clock = 1000;
    const shell = new Shell(h.leaf.viewId, () => clock);
    const off = bindShell(shell, h.services, h.leaf, fakeRoot(1200, 800));
    const bus = stageBus(h.services.bus);
    const camera = (viewId: string, needleDeg: number) => bus.emit("stage:camera", { viewId, needleDeg, headingDeg: 0 });
    camera(h.leaf.viewId, 10);
    expect(shell.feed.value.needleDeg).toBe(10);
    clock += 20;
    camera(h.leaf.viewId, 40);
    expect(shell.feed.value.needleDeg).toBe(10);
    clock += 80;
    camera(h.leaf.viewId, 40);
    expect(shell.feed.value.needleDeg).toBe(40);
    camera("someone-else", 200);
    expect(shell.feed.value.needleDeg).toBe(40);
    shell.systemReducedMotion.value = true;
    clock += 500;
    camera(h.leaf.viewId, 90);
    expect(shell.feed.value.needleDeg).toBe(40);
    off();
  });
});

describe("time strip geometry", () => {
  const day = 86_400_000;
  const plot = { x: 236, y: 14, w: 1000, h: 36 };
  const range: [number, number] = [0, 1000 * day];
  it("lays the plot out like the spec at the reference size and drops the lead at S", () => {
    const xl = stripLayout(1176, 933, "XL");
    expect(xl.plot).toEqual({ x: 236, y: 14, w: 1176 - 236 - 146, h: 36 });
    expect(xl.height).toBe(64);
    expect(stripLayout(900, 600, "M").plot.h).toBe(22);
    const s = stripLayout(600, 900, "S");
    expect(s.lead).toBe(false);
    expect(s.plot.x).toBe(14);
    expect(s.height).toBe(44);
  });
  it("scales bars on a log axis, never hides a non-empty bin, and hit-tests bins", () => {
    expect(barHeight(0, 100, "log")).toBe(0);
    expect(barHeight(1, 1_000_000, "log")).toBeGreaterThanOrEqual(1 / 36);
    expect(barHeight(100, 100, "linear")).toBe(1);
    const bins = [0, 1, 2].map((i) => ({ start: i * day, end: (i + 1) * day, entries: i + 1, notes: 0, age: Number.NaN }));
    const bars = barLayout(bins, [0, 3 * day], { x: 0, y: 0, w: 300, h: 36 }, "linear");
    expect(bars.map((b) => Math.round(b.x))).toEqual([0, 100, 200]);
    expect(binAt(bins, 1.5 * day)).toBe(1);
    expect(binAt(bins, 5 * day)).toBe(-1);
  });
  it("drags the period: a new one, a move, a handle; handles step by bin, month and year", () => {
    expect(brushHit(plot.x + 500, null, range, plot)).toBe("new");
    expect(brushHit(plot.x + 250, [250 * day, 500 * day], range, plot)).toBe("start");
    expect(brushHit(plot.x + 400, [250 * day, 500 * day], range, plot)).toBe("move");
    expect(dragPeriod("new", 100 * day, 300 * day, [0, 0], range)).toEqual([100 * day, 300 * day]);
    expect(dragPeriod("new", 300 * day, 100 * day, [0, 0], range)).toEqual([100 * day, 300 * day]);
    expect(dragPeriod("move", 10 * day, 30 * day, [100 * day, 200 * day], range)).toEqual([120 * day, 220 * day]);
    expect(dragPeriod("start", 0, 999 * day, [100 * day, 200 * day], range)).toEqual([199 * day, 200 * day]);
    expect(handleStep("ArrowRight", false, 7 * day)).toBe(7 * day);
    expect(handleStep("ArrowLeft", true, 7 * day)).toBe(-30 * day);
    expect(handleStep("PageUp", false, 7 * day)).toBe(365 * day);
  });
  it("keeps the bracket at least 14 px wide and the presets in local days", () => {
    expect(bracketRect([100 * day, 100 * day], range, plot)?.w).toBe(14);
    expect(bracketRect(null, range, plot)).toBeNull();
    expect(presetWindow("all")).toBeNull();
    const now = Date.UTC(2026, 10, 9, 12);
    expect(presetWindow("30", now)).toEqual([now - 30 * day, now]);
  });
});
