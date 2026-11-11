/**
 * GAPS-UI: the completeness-audit gaps in the shell (CORTEX-UX §5.26 first-run step, §8.1/§8.3 stage keyboard,
 * §2.3/§5.2 point gestures, §8.4 loading surfaces, §5.24 own entries, §5.8 Replay, §5.26 Add sources, §5.30.2 find).
 */
import { render } from "preact-render-to-string";
import { describe, expect, it, vi } from "vitest";
import { ItemKind } from "../src/shared/index-format";
import { DEFAULT_SETTINGS, type CortexSettings } from "../src/shared/settings";
import { stageKeyAction, stepTarget, tracedOrder } from "../src/render/stageKeys";
import { LeafContext, ServicesContext, ShellContext, Shell, shellFor, stageBus } from "../src/ui/context";
import { revealOwnEntry } from "../src/ui/arrivals";
import { escapeStep } from "../src/ui/keymap";
import { firstRunCardShown, loadingModel } from "../src/ui/loading";
import { applyFirstRunChoice, firstRunFigures, formatTokens, longLine } from "../src/ui/modals/FirstRunModal";
import { findMatches, stepMatch } from "../src/ui/reader/Thread";
import { bindShell } from "../src/ui/mount";
import { ArrangingPill, LoadingChip, ProgressLine, StageLine } from "../src/ui/stage/LoadingLines";
import { likeThisToken, planGesture, pointMenuItems } from "../src/ui/stage/pointGestures";
import { replayFraction, replayPeriod } from "../src/ui/strip/TimeStrip";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

const phase = vi.hoisted(() => ({ value: "P2" as "P0" | "P1" | "P2" }));
vi.mock("../src/shared/features", async (orig) => {
  const m = await orig<typeof import("../src/shared/features")>();
  return { ...m, featureOn: (id: Parameters<typeof m.featureOn>[0], p = phase.value) => m.featureOn(id, p) };
});

function renderIn(h: FakeHarness, node: preact.ComponentChild, shell: Shell = shellFor(h.leaf)): string {
  return render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>
        <ShellContext.Provider value={shell}>{node}</ShellContext.Provider>
      </LeafContext.Provider>
    </ServicesContext.Provider>,
  );
}

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

interface El {
  tag: string;
  text: string;
  checked?: boolean;
  disabled?: boolean;
  children: El[];
  classes: Set<string>;
  listeners: Map<string, (() => void)[]>;
  attrs: Map<string, string>;
  allText(): string[];
  click(): void;
}
const all = (el: El, pred: (e: El) => boolean): El[] => [...(pred(el) ? [el] : []), ...el.children.flatMap((c) => all(c, pred))];
const fire = (el: El, type: string) => (el.listeners.get(type) ?? []).forEach((f) => f());

describe("first-run step (§5.26)", () => {
  const est = {
    sources: [
      { source: "obsidian", items: 10, reference: 4 },
      { source: "files", items: 7, reference: 0 },
      { source: "claude-code", items: 3, reference: 0, where: "C:\\proj" },
    ],
    conversations: 3,
    notes: 13,
    tokens: 3 * 2500 + 13 * 1100,
    days: 1,
  };

  it("narrows the estimate to the ticked sources and words the plan caps", () => {
    const all3 = { vault: true, raw: true, claudeCode: true };
    const caps = { fiveHour: 70, weekly: 70 };
    expect(firstRunFigures(est as never, all3)).toMatchObject({ conversations: 3, notes: 13, tokens: 21_800 });
    expect(firstRunFigures(est as never, { ...all3, claudeCode: false }).conversations).toBe(0);
    expect(firstRunFigures(est as never, { ...all3, vault: false, raw: false }).notes).toBe(0);
    const big = { conversations: 1330, notes: 1767, tokens: 5_270_000 };
    expect(longLine(big, caps)).toBe("About 1,330 conversations and 1,767 notes to organise: roughly 5.3 million tokens. Agents work in short passes and pause at 70% of your 5-hour limit or 70% of your weekly limit, then carry on after the reset.");
    expect(longLine({ conversations: 1, notes: 1, tokens: 3600 }, { fiveHour: null, weekly: 40 })).toContain("pause at 40% of your weekly limit,");
    expect(longLine({ conversations: 1, notes: 1, tokens: 3600 }, { fiveHour: null, weekly: null })).toContain("no plan cap");
    expect(longLine({ conversations: 0, notes: 0, tokens: 0 }, caps)).toContain("Nothing to organise yet");
    expect(formatTokens(14_300)).toBe("14,300");
  });

  it("Start records the choice and the ticked sources; Import only leaves agents off", () => {
    const s = structuredClone(DEFAULT_SETTINGS) as CortexSettings;
    applyFirstRunChoice("import-only", { vault: true, raw: false, claudeCode: true })(s);
    expect([s.general.firstRunDone, s.general.firstRunChoice, s.agents.enabled, s.sources.raw.enabled, s.sources.vault.enabled]).toEqual([true, "import-only", false, false, true]);
  });

  it("shows the source rows with counts, recomputes the card when a row is unticked, and passes the gate on Start", async () => {
    const { FirstRunModal } = await import("../src/ui/modals/FirstRunModal");
    const settings = structuredClone(DEFAULT_SETTINGS) as CortexSettings;
    const ticks: string[] = [];
    const services = {
      settings: { value: settings, update: async (fn: (s: CortexSettings) => void) => fn(settings) },
      device: { update: (_fn: unknown) => void ticks.push("tick") },
      sources: { estimate: async () => est },
    };
    const modal = new FirstRunModal({} as never, services as never);
    (modal as unknown as { open(): void }).open();
    await wait();
    const content = (modal as unknown as { contentEl: El }).contentEl;
    const text = () => content.allText().join("\n");
    expect(text()).toContain("6 notes · 4 reference notes stay hidden and are not sent");
    expect(text()).toContain("7 files · read in place; the Roblox creator docs count as reference");
    expect(text()).toContain("3 sessions · C:\\proj · text only, no tool output");
    expect(text()).toContain("Claude.ai, ChatGPT and Gemini can be added later from Add sources");
    for (const k of ["Where the text goes", "What models read", "How long it takes", "Import and organise", "Import only", "Choose…"]) expect(text()).toContain(k);
    expect(text()).toContain("About 3 conversations and 13 notes to organise: roughly 21,800 tokens. Agents work in short passes and pause at 70% of your 5-hour limit or 70% of your weekly limit, then carry on after the reset.");
    const inputs = all(content, (e) => e.tag === "input");
    // Three sources, three choices (Import and organise, No model, Import only) and the date-seal box.
    expect(inputs).toHaveLength(7);
    // Untick Claude Code: its conversations leave the card.
    (inputs[2] as El).checked = false;
    fire(inputs[2] as El, "change");
    expect(text()).toContain("About 0 conversations and 13 notes");
    // Choose Import only, then Start.
    (inputs[5] as El).checked = true;
    fire(inputs[5] as El, "change");
    const start = all(content, (e) => e.tag === "button" && e.text === "Start")[0] as El;
    start.click();
    await wait();
    expect([settings.general.firstRunDone, settings.general.firstRunChoice, settings.agents.enabled, settings.sources.claudeCode.enabled]).toEqual([true, "import-only", false, false]);
    expect(ticks).toHaveLength(1);
  });

  it("Not now changes nothing", async () => {
    const { FirstRunModal } = await import("../src/ui/modals/FirstRunModal");
    const settings = structuredClone(DEFAULT_SETTINGS) as CortexSettings;
    const services = { settings: { value: settings, update: async (fn: (s: CortexSettings) => void) => fn(settings) }, device: { update: () => undefined }, sources: { estimate: async () => est } };
    const modal = new FirstRunModal({} as never, services as never);
    (modal as unknown as { open(): void }).open();
    await wait();
    const content = (modal as unknown as { contentEl: El }).contentEl;
    (all(content, (e) => e.tag === "button" && e.text === "Not now")[0] as El).click();
    expect(settings.general.firstRunDone).toBe(false);
  });
});

describe("stage keyboard (§8.1, §8.3)", () => {
  const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => stageKeyAction({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });
  it("arrows turn, Shift arrows pan, + and - zoom", () => {
    expect(key("ArrowLeft")).toMatchObject({ kind: "turn", dYawDeg: 5 });
    expect(key("ArrowRight")).toMatchObject({ kind: "turn", dYawDeg: -5 });
    expect(key("ArrowUp")).toMatchObject({ kind: "turn", dPitchDeg: 5 });
    expect(key("ArrowDown")).toMatchObject({ kind: "turn", dPitchDeg: -5 });
    expect(key("ArrowLeft", { shiftKey: true })).toMatchObject({ kind: "pan", dxPx: -40 });
    expect(key("+")).toMatchObject({ kind: "zoom" });
    expect((key("+") as { k: number }).k).toBeLessThan(1);
    expect((key("-") as { k: number }).k).toBeGreaterThan(1);
    expect(key("a")).toBeNull();
    expect(key("ArrowLeft", { ctrlKey: true })).toBeNull();
  });
  it("Tab steps, Enter opens, Ctrl Enter opens in a new tab", () => {
    expect(key("Tab")).toEqual({ kind: "step", dir: 1 });
    expect(key("Tab", { shiftKey: true })).toEqual({ kind: "step", dir: -1 });
    expect(key("Enter")).toEqual({ kind: "open", newTab: false });
    expect(key("Enter", { ctrlKey: true })).toEqual({ kind: "open", newTab: true });
    expect(key("Enter", { metaKey: true })).toEqual({ kind: "open", newTab: true });
  });
  it("steps through traced points largest first and lets focus leave at either end", () => {
    const lit = Uint8Array.from([1, 0, 1, 1, 0]);
    const words = Uint32Array.from([10, 99, 50, 10, 70]);
    const order = tracedOrder(lit, words, 5);
    expect(order).toEqual([2, 0, 3]);
    expect(stepTarget(order, -1, 1)).toBe(2);
    expect(stepTarget(order, 2, 1)).toBe(0);
    expect(stepTarget(order, 3, 1)).toBeNull();
    expect(stepTarget(order, 2, -1)).toBeNull();
    expect(stepTarget(order, -1, -1)).toBeNull();
    expect(stepTarget([], -1, 1)).toBeNull();
    expect(tracedOrder(null, words, 5)).toEqual([]);
  });
});

describe("point gestures (§2.3, §5.2)", () => {
  const vault = { id: "w_a", kind: ItemKind.NoteWiki };
  const machine = { id: "n_a", kind: ItemKind.NoteAtomic };
  const map = { id: "n_b", kind: ItemKind.NoteHub };
  const message = { id: "e_a", kind: ItemKind.RecordMessage, conversation: { id: "c_a", title: "t", index: 3, count: 9 } };
  const doc = { id: "e_b", kind: ItemKind.RecordDocument };
  it("follows the table for every kind of item", () => {
    expect(planGesture(vault, "click")).toEqual({ kind: "reader", route: "vault-peek", pin: false });
    expect(planGesture(vault, "ctrl-click")).toEqual({ kind: "file", how: "tab" });
    expect(planGesture(vault, "dblclick")).toEqual({ kind: "file", how: "tab" });
    expect(planGesture(machine, "click")).toEqual({ kind: "reader", route: "note", pin: false });
    expect(planGesture(machine, "ctrl-click")).toEqual({ kind: "file", how: "tab" });
    expect(planGesture(machine, "dblclick")).toEqual({ kind: "reader", route: "note", pin: false });
    expect(planGesture(map, "click")).toMatchObject({ kind: "reader", route: "map" });
    expect(planGesture(message, "click")).toEqual({ kind: "reader", route: "entry", pin: false });
    expect(planGesture(message, "ctrl-click")).toEqual({ kind: "reader", route: "entry", pin: true });
    expect(planGesture(message, "dblclick")).toEqual({ kind: "reader", route: "conversation", pin: false });
    expect(planGesture(doc, "click")).toEqual({ kind: "reader", route: "entry", pin: false });
    expect(planGesture(doc, "ctrl-click")).toEqual({ kind: "reader", route: "entry", pin: true });
    expect(planGesture(doc, "dblclick")).toEqual({ kind: "reader", route: "entry", pin: false });
  });
  it("the right-click menu lists the spec's rows, with the vault-note extras last", () => {
    const base = { sources: 3, pinned: false, canPin: true, hasLike: true };
    expect(pointMenuItems({ ...base, vaultNote: false }).map((i) => i.label)).toEqual(["Open", "Trace its sources", "Trace everything like this", "Pin", "Show in Read", "Copy link"]);
    const v = pointMenuItems({ ...base, vaultNote: true });
    expect(v.slice(-2).map((i) => i.label)).toEqual(["Open in new tab", "Open to the right"]);
    const none = pointMenuItems({ ...base, vaultNote: false, sources: 0, pinned: true, canPin: false });
    expect(none[1]?.disabled).toBe(true);
    expect(none[3]).toMatchObject({ label: "Unpin", disabled: true });
  });
  it("Trace everything like this picks the kind, the folder, the area or the source", () => {
    const meta = (o: object) => ({ id: "x", title: "t", kind: 0, population: "record", source: "claude-code", speaker: "you", folder: "", space: "", words: 1, flags: 0, ordinal: 1, ...o }) as never;
    expect(likeThisToken(meta({ kind: ItemKind.NoteAtomic, noteKind: "decision" }))).toMatchObject({ dim: "kind", value: "decision" });
    expect(likeThisToken(meta({ kind: ItemKind.NoteWiki, folder: "concepts" }))).toMatchObject({ dim: "folderPath", value: "concepts" });
    expect(likeThisToken(meta({}))).toMatchObject({ dim: "source", value: "claude-code" });
  });
});

describe("loading surfaces (§8.4)", () => {
  const base = { data: { phase: "loading" as const, progress: 0.4, available: 0 }, jobs: [], firstRunCard: false, stageStatus: "ok" as const };
  it("opening: progress line and Reading your record", () => {
    const m = loadingModel(base);
    expect(m).toMatchObject({ progress: 0.4, chip: null, stageLine: "Reading your record… 40%", arranging: false });
  });
  it("the stage line carries the percentage once it is known", () => {
    expect(loadingModel({ ...base, data: { ...base.data, progress: 0.073 } }).stageLine).toBe("Reading your record… 7%");
    expect(loadingModel({ ...base, data: { ...base.data, progress: 0 } }).stageLine).toBe("Reading your record… 0%");
    expect(loadingModel({ ...base, data: { ...base.data, progress: 1.4 } }).stageLine).toBe("Reading your record… 100%");
  });
  it("first ever run: Indexing k of n, the progress line and the first-run line", () => {
    const m = loadingModel({ ...base, jobs: [{ id: "i", kind: "index", phase: "build", done: 120, total: 800 }] });
    expect(m.chip).toBe("Indexing 120 of 800");
    expect(m.progress).toBeCloseTo(0.15);
    expect(m.stageLine).toContain("First run: Cortex is reading your vault and sessions.");
  });
  it("reconcile with an index on screen: Checking for changes, no stage line", () => {
    const m = loadingModel({ ...base, data: { phase: "ready", progress: 1, available: 500 }, jobs: [{ id: "i", kind: "index", phase: "build", done: 1, total: 2 }] });
    expect(m.chip).toBe("Checking for changes…");
    expect(m.stageLine).toBeNull();
  });
  it("is quiet when ready, and yields the stage to the first-run card", () => {
    expect(loadingModel({ ...base, data: { phase: "ready", progress: 1, available: 5 } })).toMatchObject({ progress: null, chip: null, stageLine: null });
    expect(loadingModel({ ...base, firstRunCard: true }).stageLine).toBeNull();
    expect(firstRunCardShown("ready", false, false)).toBe(true);
  });
  it("arranging and no-WebGL", () => {
    expect(loadingModel({ ...base, data: { phase: "ready", progress: 1, available: 5 }, stageStatus: "arranging" }).arranging).toBe(true);
    const nw = loadingModel({ ...base, data: { phase: "ready", progress: 1, available: 5 }, stageStatus: "no-webgl" });
    expect(nw.stageLine).toContain("shows a still picture. Everything else works.");
  });
  it("renders the line, the chip, the stage line and the Arranging pill", () => {
    const h = fakeServices((s) => void (s.general.firstRunDone = true));
    h.services.shared.update("data", { phase: "loading", progress: 0.5, available: 0 });
    const shell = shellFor(h.leaf);
    const html = renderIn(h, <><ProgressLine /><StageLine /><LoadingChip /><ArrangingPill /></>, shell);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("width:50%");
    expect(html).toContain("Reading your record…");
    expect(html).not.toContain("Arranging…");
    shell.feed.value = { ...shell.feed.value, status: "arranging" };
    expect(renderIn(h, <ArrangingPill />, shell)).toContain("Arranging…");
  });
  it("posts the lowered-detail toast once when the governor steps in", () => {
    const h = fakeServices();
    const shell = new Shell(h.leaf.viewId);
    const root = { clientWidth: 1200, clientHeight: 800, ownerDocument: { defaultView: null }, getBoundingClientRect: () => ({ width: 1200, height: 800, left: 0, top: 0 }), querySelector: () => null } as unknown as HTMLElement;
    const off = bindShell(shell, h.services, h.leaf, root);
    const bus = stageBus(h.services.bus);
    bus.emit("stage:status", { viewId: h.leaf.viewId, status: "ok", governor: 0 });
    expect(shell.toasts.value).toHaveLength(0);
    bus.emit("stage:status", { viewId: h.leaf.viewId, status: "ok", governor: 1 });
    bus.emit("stage:status", { viewId: h.leaf.viewId, status: "ok", governor: 2 });
    const lowered = shell.toasts.value.filter((x) => x.text === "Cortex lowered detail to stay smooth. Change it in Display.");
    expect(lowered).toHaveLength(1);
    off();
  });
});

describe("your own entry (§5.24)", () => {
  it("is revealed up to its own ordinal when the index has it, while later arrivals stay held", () => {
    const h = fakeServices();
    const store = h.leaf.store;
    store.update("ui", { revealedCount: 5 });
    let known = -1;
    const index = { ordinalOf: () => known };
    const stop = revealOwnEntry({ bus: h.services.bus, index } as never, store, "e_mine");
    expect(store.get("ui").revealedCount).toBe(5);
    known = 7;
    h.services.bus.emit("index:delta", { added: 3, seq: 2, epoch: "x" });
    expect(store.get("ui").revealedCount).toBe(8);
    stop();
  });
  it("reveals at once when the entry is already indexed, and does nothing without a baseline", () => {
    const h = fakeServices();
    const store = h.leaf.store;
    store.update("ui", { revealedCount: 0 });
    revealOwnEntry({ bus: h.services.bus, index: { ordinalOf: () => 3 } } as never, store, "e_mine");
    expect(store.get("ui").revealedCount).toBe(0);
    store.update("ui", { revealedCount: 2 });
    revealOwnEntry({ bus: h.services.bus, index: { ordinalOf: () => 3 } } as never, store, "e_mine");
    expect(store.get("ui").revealedCount).toBe(4);
  });
});

describe("Replay (§5.8)", () => {
  it("maps the playhead to a period and back", () => {
    const range: [number, number] = [0, 10 * 86_400_000];
    expect(replayPeriod(range, 0.5)).toEqual([0, 5 * 86_400_000]);
    expect(replayPeriod(range, 0)[1]).toBe(86_400_000);
    expect(replayPeriod(range, 2)[1]).toBe(range[1]);
    expect(replayFraction(range, 2.5 * 86_400_000)).toBeCloseTo(0.25);
    expect(replayFraction(range, -5)).toBe(0);
    expect(replayFraction([5, 5], 9)).toBe(0);
  });
  it("Esc stops a running replay before anything else", () => {
    const h = fakeServices();
    const ui = h.leaf.store.get("ui");
    expect(escapeStep(ui, null, { hint: false, shapeOpen: false, replay: true })).toBe("replay");
    expect(escapeStep(ui, null, { hint: true, shapeOpen: false, replay: true })).toBe("hint");
    expect(escapeStep(ui, null, { hint: false, shapeOpen: false })).toBeNull();
  });
});

describe("Add sources (§5.26)", () => {
  const services = (over: object = {}) => ({
    settings: { value: structuredClone(DEFAULT_SETTINGS), update: async () => undefined },
    sandbox: { value: false },
    shared: { slices: { activity: { subscribe: (fn: (a: unknown) => void) => (fn({ importing: { done: 2, total: 5, kept: 31 } }), () => undefined) } } },
    sources: {
      list: async () => [{ id: "claude-code", kind: "claude-code", status: "importing", items: 5, yourShare: 0, storedIn: ".raw/chats/claude-code/", watching: true }],
      estimate: async () => ({ sources: [{ source: "claude-code", items: 5, reference: 0, where: "C:\\proj" }], conversations: 5, notes: 0, tokens: 1, days: 1 }),
      needsAttention: async () => [
        { code: "path-unreadable", count: 1, detail: "C:\\nope" },
        { code: "skipped-not-session", count: 2 },
      ],
      inspect: async () => ({ kind: "gemini", conversations: 6, projects: 0, attachments: 0, alreadyImported: 0, exchanges: 40, range: ["2025-01-01T00:00:00Z", "2026-11-01T00:00:00Z"] }),
      importNow: async () => undefined,
      pauseWatching: async () => undefined,
      ...over,
    },
  });
  it("shows the first-import progress, the read errors with Show details, and the Gemini preview wording", async () => {
    const { AddSourcesModal } = await import("../src/ui/modals/AddSourcesModal");
    const modal = new AddSourcesModal({} as never, services() as never);
    (modal as unknown as { open(): void }).open();
    await wait();
    const content = (modal as unknown as { contentEl: El }).contentEl;
    const text = content.allText().join("\n");
    expect(text).toContain("Reading 5 sessions… 2 of 5 · 31 messages kept");
    expect(text).toContain("Cortex can't read C:\\nope. Check that the folder exists and that Obsidian can open it.");
    expect(text).toContain("Skipped 2 files that aren't session logs.");
    expect(text).toContain("Show details");
    const bar = all(content, (e) => e.tag === "progress")[0] as unknown as { max: number; value: number };
    expect([bar.value, bar.max]).toEqual([2, 5]);
    (modal as unknown as { route(p: string): Promise<void> }).route("C:\\takeout.zip");
    await wait();
    const after = content.allText().join("\n");
    expect(after).toContain("40 prompts and replies, grouped into 6 conversations");
    (modal as unknown as { close(): void }).close();
  });
});

describe("find in a conversation (§5.30.2)", () => {
  it("lists the messages that hold the text, case-insensitively, and steps round the ends", () => {
    const msgs = [{ text: { ok: true, text: "Hello World" } }, { text: { ok: true, text: "nothing" } }, { text: { ok: false } }, { text: { ok: true, text: "say hello again" } }];
    expect(findMatches(msgs, 200, " HELLO ")).toEqual([200, 203]);
    expect(findMatches(msgs, 0, "")).toEqual([]);
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });
});
