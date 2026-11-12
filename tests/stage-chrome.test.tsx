/**
 * Stage chrome on Cortex Desktop (pkg-03): the title block beside the on-stage search field, the always-visible Ask
 * caption, grammatical arrival lines and the top-centre loading line with its fill bar.
 */
import { render } from "preact-render-to-string";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, migrateSettings } from "../src/shared/settings";
import { forceHost } from "../src/ui/host";
import { LeafContext, ServicesContext, ShellContext, shellFor } from "../src/ui/context";
import { t } from "../src/ui/copy";
import { loadingModel } from "../src/ui/loading";
import { AgentButton, readerOpenRight } from "../src/ui/stage/AgentButton";
import { StageLine } from "../src/ui/stage/LoadingLines";
import { clearStageDraft, commandBarResting, flipStageMode, setStageDraft, stageSearchVisible, StageHead, StageSearch, STAGE_SEARCH_MIN_STAGE_W } from "../src/ui/stage/StageSearch";
import { arrivalsText } from "../src/ui/stage/Toasts";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

afterEach(() => forceHost(null));

function renderIn(h: FakeHarness, node: preact.ComponentChild): string {
  const shell = shellFor(h.leaf);
  shell.size.value = { width: 1512, height: 982 };
  return render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>
        <ShellContext.Provider value={shell}>{node}</ShellContext.Provider>
      </LeafContext.Provider>
    </ServicesContext.Provider>,
  );
}

const ui = (over: Record<string, unknown> = {}) => ({ immersive: false, breakpoint: "XL" as const, sheet: { open: false, width: 380 }, ...over }) as Parameters<typeof stageSearchVisible>[0];

describe("on-stage search setting", () => {
  it("defaults on and survives a stored file that lacks it", () => {
    expect(DEFAULT_SETTINGS.appearance.searchOnStage).toBe(true);
    expect(migrateSettings({ version: 7, appearance: { frosted: false } }).appearance.searchOnStage).toBe(true);
    expect(migrateSettings({ version: 7, appearance: { searchOnStage: false } }).appearance.searchOnStage).toBe(false);
  });
  it("has its strings", () => {
    expect(t("display.searchOnStage")).toBe("Search on the stage");
    expect(t("overlays.searchPlaceholder")).toBe("Search your brain…");
    expect(t("overlays.askToggle")).toBe("Ask instead");
  });
});

describe("stageSearchVisible", () => {
  it("shows on a wide stage and goes with the setting, Immersive, a narrow stage and the Read drawer", () => {
    expect(stageSearchVisible(ui(), 1300, true)).toBe(true);
    expect(stageSearchVisible(ui(), 1300, false)).toBe(false);
    expect(stageSearchVisible(ui({ immersive: true }), 1300, true)).toBe(false);
    expect(stageSearchVisible(ui(), STAGE_SEARCH_MIN_STAGE_W - 1, true)).toBe(false);
    const drawer = ui({ sheet: { open: true, width: 380, side: "left", stack: [{ kind: "page", route: "read" }], index: 0 } });
    expect(stageSearchVisible(drawer, 1300, true)).toBe(false);
  });
});

describe("command bar resting", () => {
  const idle = { desktop: true, tokens: 0, text: "", consoleOpen: false, resultsOpen: false, stageSearch: true };
  it("rests on Desktop until invoked, and a draft typed on the stage does not bring it out", () => {
    expect(commandBarResting(idle)).toBe(true);
    expect(commandBarResting({ ...idle, text: "nietzsche" })).toBe(true);
    expect(commandBarResting({ ...idle, text: "nietzsche", stageSearch: false })).toBe(false);
  });
  it("comes out for traced tokens, the Ask console and open results, and never rests in the plugin", () => {
    expect(commandBarResting({ ...idle, tokens: 1 })).toBe(false);
    expect(commandBarResting({ ...idle, consoleOpen: true })).toBe(false);
    expect(commandBarResting({ ...idle, resultsOpen: true })).toBe(false);
    expect(commandBarResting({ ...idle, desktop: false })).toBe(false);
  });
});

describe("StageSearch", () => {
  it("renders only on Desktop, with the placeholder, and shows the clear x once it holds text", () => {
    const h = fakeServices();
    expect(renderIn(h, <StageSearch />)).toBe("");
    forceHost("desktop");
    const html = renderIn(h, <StageSearch />);
    expect(html).toContain("cx-stage-search");
    expect(html).toContain('placeholder="Search your brain…"');
    expect(html).toContain("cx-stage-search-ask");
    expect(html).not.toContain("cx-stage-search-clear");
    setStageDraft(h.leaf.store, "nietzsche");
    const typed = renderIn(h, <StageSearch />);
    expect(typed).toContain('value="nietzsche"');
    expect(typed).toContain("cx-stage-search-clear");
  });
  it("shares its draft with the Find bar and never opens the results or sends anything by itself", () => {
    const h = fakeServices();
    setStageDraft(h.leaf.store, "kant");
    const c = h.leaf.store.get("ui").command;
    expect(c.text).toBe("kant");
    expect(c.resultsOpen).toBe(false);
    expect(c.consoleOpen).toBe(false);
    clearStageDraft(h.leaf.store);
    expect(h.leaf.store.get("ui").command.text).toBe("");
  });
  it("the chat button only flips the mode: no console opens and the text stays", () => {
    const h = fakeServices();
    setStageDraft(h.leaf.store, "what did I decide");
    flipStageMode(h.leaf.store);
    let c = h.leaf.store.get("ui").command;
    expect(c).toMatchObject({ mode: "ask", consoleOpen: false, text: "what did I decide" });
    flipStageMode(h.leaf.store);
    c = h.leaf.store.get("ui").command;
    expect(c).toMatchObject({ mode: "find", consoleOpen: false, text: "what did I decide" });
  });
  it("flips to Ask with the Ask placeholder", () => {
    const h = fakeServices();
    forceHost("desktop");
    h.leaf.store.update("ui", (u) => ({ ...u, command: { ...u.command, mode: "ask" } }));
    const html = renderIn(h, <StageSearch />);
    expect(html).toContain("is-ask");
    expect(html).toContain("Ask a question");
    expect(html).toContain('aria-pressed="true"');
  });
  it("is off with the setting", () => {
    const h = fakeServices((s) => void (s.appearance.searchOnStage = false));
    forceHost("desktop");
    expect(renderIn(h, <StageSearch />)).toBe("");
  });
  it("StageHead holds the field even when no index is loaded yet (the title waits for it)", () => {
    const h = fakeServices();
    forceHost("desktop");
    const html = renderIn(h, <StageHead />);
    expect(html).toContain("cx-stage-head");
    expect(html).toContain("cx-stage-search");
    expect(html).not.toContain("cx-title-block");
  });
});

describe("Ask caption", () => {
  it("stays in the markup at rest and steps back while a reader is open at the right edge", () => {
    const h = fakeServices();
    const rest = renderIn(h, <AgentButton />);
    expect(rest).toContain(">Ask<");
    expect(rest).not.toContain("is-reader-open");
    h.leaf.store.update("ui", (u) => ({ ...u, sheet: { ...u.sheet, open: true, side: "right", stack: [{ kind: "reader", id: "r", ordinal: 1 } as never], index: 0 } }));
    expect(renderIn(h, <AgentButton />)).toContain("is-reader-open");
  });
  it("readerOpenRight is false for a page on the right and for a reader on the left", () => {
    expect(readerOpenRight(ui())).toBe(false);
    expect(readerOpenRight(ui({ sheet: { open: true, width: 380, side: "right", stack: [{ kind: "page", route: "chart" }], index: 0 } }))).toBe(false);
    expect(readerOpenRight(ui({ sheet: { open: true, width: 380, side: "left", stack: [{ kind: "reader", id: "r", ordinal: 1 }], index: 0 } }))).toBe(false);
    expect(readerOpenRight(ui({ sheet: { open: true, width: 380, side: "right", stack: [{ kind: "reader", id: "r", ordinal: 1 }], index: 0 } }))).toBe(true);
  });
});

describe("arrivals text", () => {
  it("is grammatical for any count", () => {
    expect(arrivalsText(1, 0)).toBe("1 new item in your record");
    expect(arrivalsText(3, 0)).toBe("3 new items in your record");
    expect(arrivalsText(1, 1)).toBe("1 new entry from 1 Claude Code session");
    expect(arrivalsText(1, 2)).toBe("1 new entry from 2 Claude Code sessions");
    expect(arrivalsText(4, 1)).toBe("4 new entries from 1 Claude Code session");
    expect(arrivalsText(4, 2)).toBe("4 new entries from 2 Claude Code sessions");
    expect(arrivalsText(1200, 0)).toBe("1,200 new items in your record");
  });
});

describe("loading line", () => {
  const base = { data: { phase: "loading" as const, progress: 0.34, available: 0 }, jobs: [], firstRunCard: false, stageStatus: "ok" as const };
  it("marks the reading line, with its percentage, for the top-centre bar", () => {
    const m = loadingModel(base);
    expect(m).toMatchObject({ stageReading: true, stageLine: "Reading your record… 34%", progress: 0.34 });
  });
  it("keeps the first-run and no-WebGL lines where they were", () => {
    expect(loadingModel({ ...base, jobs: [{ id: "i", kind: "index", phase: "build", done: 1, total: 9 }] }).stageReading).toBe(false);
    expect(loadingModel({ ...base, stageStatus: "no-webgl" }).stageReading).toBe(false);
    expect(loadingModel({ ...base, data: { ...base.data, available: 5 } }).stageReading).toBe(false);
  });
  it("renders the words over a fill bar that follows the percentage", () => {
    const h = fakeServices();
    h.services.shared.slices.data.value = { ...h.services.shared.slices.data.value, phase: "loading", progress: 0.34, available: 0 };
    h.services.settings.value.general.firstRunDone = true;
    const html = renderIn(h, <StageLine />);
    expect(html).toContain("cx-stage-load-text");
    expect(html).toContain("Reading your record… 34%");
    expect(html).toContain("width:34%");
    expect(html).toContain('aria-valuenow="34"');
  });
});
