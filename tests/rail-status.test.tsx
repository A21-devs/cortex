/**
 * The rail's status stack and activity ring: Shell.notify (a transient line plus the live region), the persistent lit
 * line, the removal line, the lit-labels Clear that leaves other tokens alone, the stack order, and the ring that
 * shows while background work runs.
 */
import { render } from "preact-render-to-string";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addToken, clearHighlights } from "../src/state/actions";
import { highlightCount } from "../src/state/selectors";
import { LeafContext, ServicesContext, ShellContext, Shell, STATUS_LINES_MAX } from "../src/ui/context";
import { t } from "../src/ui/copy";
import { ActivityRing, activityBusy, RING_DASHES } from "../src/ui/nav/ActivityRing";
import { litLine, removedHighlights, StatusLines, stackItems, unlitLine } from "../src/ui/nav/RailStatus";
import { assignZone } from "../src/ui/stage/ChartOverlay";
import { fakeServices } from "./helpers/fakeServices";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Shell.notify", () => {
  it("adds a line, announces it and removes it when the ttl ends", () => {
    const shell = new Shell("v1");
    shell.notify("Vertical switched to Folder", { ttl: 6000 });
    expect(shell.statusLines.value.map((l) => l.text)).toEqual(["Vertical switched to Folder"]);
    expect(shell.announcement.value.text).toBe("Vertical switched to Folder");
    vi.advanceTimersByTime(5999);
    expect(shell.statusLines.value).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(shell.statusLines.value).toHaveLength(0);
  });
  it("replaces the same text and keeps the newest four", () => {
    const shell = new Shell("v1");
    shell.notify("same");
    shell.notify("same");
    expect(shell.statusLines.value).toHaveLength(1);
    for (let i = 0; i < 6; i++) shell.notify(`line ${i}`);
    expect(shell.statusLines.value).toHaveLength(STATUS_LINES_MAX);
    expect(shell.statusLines.value.map((l) => l.text)).toEqual(["line 2", "line 3", "line 4", "line 5"]);
  });
  it("clears its timers and lines on dispose", () => {
    const shell = new Shell("v1");
    shell.notify("gone");
    shell.dispose();
    expect(shell.statusLines.value).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("highlight lines", () => {
  const tokens = [
    { id: "chart:group:space:claude", kind: "group" as const, label: "Claude Code" },
    { id: "chart:group:space:vault", kind: "group" as const, label: "Vault" },
  ];
  it("names the newest label and counts the others", () => {
    expect(litLine([])).toBeNull();
    expect(litLine(tokens.slice(0, 1))).toBe(t("rail.litOne", { label: "Claude Code" }));
    expect(litLine(tokens)).toBe(t("rail.litMany", { label: "Vault", n: 1 }));
    expect(litLine(tokens)).toContain("Vault is lit, plus 1 more");
  });
  it("reports the label that went and the entries now shown", () => {
    const gone = removedHighlights(tokens, tokens.slice(0, 1));
    expect(gone.map((g) => g.label)).toEqual(["Vault"]);
    expect(unlitLine(gone, 1234)).toBe(t("rail.unlit", { label: "Vault", count: "1,234" }));
    expect(unlitLine(removedHighlights(tokens, []), 9)).toBe(t("rail.unlitMany", { n: 2, count: 9 }));
    expect(unlitLine([], 5)).toBeNull();
    expect(removedHighlights(tokens, tokens)).toEqual([]);
  });
  it("Clear on the lit labels drops only the highlights", () => {
    const store = fakeServices().leaf.store;
    addToken(store, tokens[0]!);
    addToken(store, tokens[1]!);
    addToken(store, { id: "text:cat", kind: "text", label: "cat", text: "cat" });
    expect(highlightCount(store.get("ui"))).toBe(2);
    clearHighlights(store);
    expect(highlightCount(store.get("ui"))).toBe(0);
    expect(store.get("ui").tokens.map((k) => k.id)).toEqual(["text:cat"]);
  });
});

describe("status stack", () => {
  const note = (id: string, at: number) => ({ id, kind: "notice" as const, text: id, at });
  it("puts the newest notice at the bottom, then the lit line, then provenance on top", () => {
    const items = stackItems([note("a", 1), note("b", 2)], "lit text", "built from 3");
    expect(items.map((i) => i.id)).toEqual(["b", "a", "lit", "provenance"]);
    expect(stackItems([], null, null)).toEqual([]);
  });
  function mount(setup: (h: ReturnType<typeof fakeServices>, shell: Shell) => void): string {
    const h = fakeServices();
    const shell = new Shell("v-test");
    setup(h, shell);
    return render(
      <ServicesContext.Provider value={h.services}>
        <LeafContext.Provider value={h.leaf}>
          <ShellContext.Provider value={shell}>
            <StatusLines />
            <ActivityRing />
          </ShellContext.Provider>
        </LeafContext.Provider>
      </ServicesContext.Provider>,
    );
  }
  it("renders nothing with nothing to say", () => {
    expect(mount(() => undefined)).toBe("");
  });
  it("shows the lit block with two highlights and a notice from notify", () => {
    const html = mount((h, shell) => {
      addToken(h.leaf.store, { id: "chart:group:space:claude", kind: "group", label: "Claude Code" });
      addToken(h.leaf.store, { id: "chart:group:space:vault", kind: "group", label: "Vault" });
      shell.notify("Vertical switched to Folder: Day already sits on the other axis.");
    });
    expect(html).toContain("in Vault");
    expect(html).toContain("2 highlighted labels");
    expect(html).toContain("Vertical switched to Folder");
  });
});

describe("auto-adjust notice", () => {
  it("assignZone reports which axis moved, and the copy says why", () => {
    const spec = { chart: "bar", x: { dim: "month", sort: "date" }, y: { dim: "space", sort: "count" }, colour: "space", measure: "entries" } as unknown as Parameters<typeof assignZone>[0];
    const ch = assignZone(spec, "x", "space");
    expect(ch.moved?.zone).toBe("y");
    const line = t("chart.zoneFallbackWhy", { zone: "Vertical", dim: "Folder", other: "Day" });
    expect(line).toBe("Vertical switched to Folder: Day already sits on the other axis.");
  });
});

describe("activity ring", () => {
  const idle = { data: { phase: "ready" as const }, jobs: [], stageStatus: "ok" as const };
  it("is busy for an index job, an agent job, an import, a load or an arrangement", () => {
    expect(activityBusy(idle)).toBe(false);
    expect(activityBusy({ ...idle, data: { phase: "loading" } })).toBe(true);
    expect(activityBusy({ ...idle, jobs: [{ id: "j", kind: "index", done: 1 }] as never })).toBe(true);
    expect(activityBusy({ ...idle, jobs: [{ id: "j", kind: "summary", done: 0 }] as never })).toBe(true);
    expect(activityBusy({ ...idle, importing: { done: 1 } })).toBe(true);
    expect(activityBusy({ ...idle, stageStatus: "arranging" })).toBe(true);
  });
  it("draws nine dashes while loading and nothing when idle", () => {
    const h = fakeServices();
    const tree = (
      <ServicesContext.Provider value={h.services}>
        <LeafContext.Provider value={h.leaf}>
          <ActivityRing />
        </LeafContext.Provider>
      </ServicesContext.Provider>
    );
    h.services.shared.update("data", { phase: "ready" });
    expect(render(tree)).toBe("");
    h.services.shared.update("data", { phase: "loading", progress: 0.2 });
    const html = render(tree);
    expect(html).toContain("cx-activity-ring");
    expect(html).toContain("stroke-dasharray");
    expect(RING_DASHES).toBe(9);
  });
});
