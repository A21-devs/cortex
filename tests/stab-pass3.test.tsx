/**
 * Pass 3 leftovers (owner STAB): stage:chart adoption, id ordering, and the other small fixes recorded in
 * docs/rfcs/PASS3.md. Each describe block names the item it covers.
 */
import { existsSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { signal } from "@preact/signals";
import { render } from "preact-render-to-string";
import { describe, expect, it, vi } from "vitest";
import { createHandlers } from "../src/runner/commands";
import { COMMAND_LANES, type RunnerHost } from "../src/runner/host";
import { createCancelSource } from "../src/shared/cancel";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { ensureCortexRoots, writeFileAtomic } from "../src/node/fsAtomic";
import { assertFolderChainClear, forgetGitignoreChecks, writablePath } from "../src/node/paths";
import { discardChecks } from "../src/agents/discard";
import { countOpenChecks } from "../src/agents/scheduler";
import { nullLogger } from "../src/shared/log";
import { compareIds, newReceiptId, newReviewCardId, sortableBody } from "../src/shared/ids";
import type { ReviewCardRecord } from "../src/shared/types";
import { openStoreContext } from "../src/store/layout";
import { createLedgerStore } from "../src/store/ledger";
import type { ArrangementResult, ChartSpec } from "../src/shared/protocol/worker";
import { EventBus } from "../src/state/events";
import { createLeafStore } from "../src/state/store";
import { ServicesContext } from "../src/ui/context";
import { ReadRowView, type ReadRow } from "../src/ui/pages/Read";
import { addCombine, categoryName, ChartFeed, chartCsv, isCombined, overlayLabelText, parseRef, renamesOf, setCombinedName } from "../src/ui/stage/ChartOverlay";
import { readingText } from "../src/ui/stage/Readings";
import { defaultVisibility } from "../src/worker/charts/common";
import { runChart } from "../src/worker/charts/registry";
import { fakeServices } from "./helpers/fakeServices";
import { buildSampleIndex } from "../src/worker/sampleIndex";

const NOW = Date.UTC(2026, 10, 10);

describe("shared/ids compareIds", () => {
  it("orders ids by creation across the digit/letter boundary of the base32 alphabet", () => {
    expect("x_aaaaaaaaaaaaaaa3" < "x_aaaaaaaaaaaaaaaz").toBe(true); // a plain string compare puts the digit first: wrong
    expect(compareIds("x_aaaaaaaaaaaaaaaz", "x_aaaaaaaaaaaaaaa3")).toBeLessThan(0);
    expect(compareIds("x_aaaaaaaaaaaaaaa3", "x_aaaaaaaaaaaaaaaz")).toBeGreaterThan(0);
    expect(compareIds("x_abc", "x_abc")).toBe(0);
    expect(compareIds("x_ab", "x_abc")).toBeLessThan(0);
  });
  it("agrees with creation order for a long run of ids", () => {
    const ids = Array.from({ length: 3000 }, () => newReceiptId(NOW));
    const sorted = [...ids].sort(compareIds);
    expect(sorted).toEqual(ids);
    const bodies = Array.from({ length: 500 }, () => sortableBody(NOW));
    expect([...bodies].sort(compareIds)).toEqual(bodies);
  });
});

describe("ui/stage ChartFeed adopts the renderer's chart arrangement (E9 RFC 1)", () => {
  const spec: ChartSpec = { chart: "ranked-bars", x: { dim: "space", sort: "count" }, y: null, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options: {} };
  const result = { arr: new Float32Array([0, 0, 0, 1, 1, 1]), camera: { keepUpright: true } } as unknown as ArrangementResult;

  function rig() {
    const index = buildSampleIndex(20261110, NOW);
    const bus = new EventBus<Record<string, unknown>>();
    const calls: string[] = [];
    const store = createLeafStore();
    store.update("view", (v) => ({ ...v, shape: "chart", chart: spec }));
    const s = {
      bus,
      index: { index: signal(index) },
      worker: { call: async (id: string) => (calls.push(id), result) },
      settings: { value: { appearance: { motion: "reduce" } } },
      log: { warn: () => undefined },
    };
    const feed = new ChartFeed(s as never, { viewId: "v1", store } as never, { systemReducedMotion: signal(true) } as never);
    return { feed, bus, calls, index, store };
  }
  const vis = (store: ReturnType<typeof createLeafStore>, count: number) => {
    const u = store.get("ui");
    const l = store.get("view").layers;
    return { scope: u.scope, period: u.period, notes: l.notes, vaultNotes: l.vaultNotes, maps: l.maps, record: l.record, undatedCloud: l.undatedCloud, reference: l.reference, askHistory: l.askHistory, subagents: l.subagents, automated: l.automated, revealedCount: u.revealedCount > 0 ? Math.min(count, u.revealedCount) : count };
  };

  it("uses the event instead of a second worker call, whichever of the two arrives first", async () => {
    vi.useFakeTimers();
    try {
      const a = rig();
      const release = a.feed.acquire();
      // The renderer answered first (before the feed's debounce ran out): no worker call is made.
      a.bus.emit("stage:chart", { viewId: "v1", spec, result, visibility: vis(a.store, a.index.count), index: a.index });
      await vi.advanceTimersByTimeAsync(500);
      expect(a.calls).toEqual([]);
      expect(a.feed.value.value?.result).toBe(result);
      expect(a.feed.value.value?.placed).toBe(2);
      release();

      // An event for another view, or made with other settings, is not adopted: the feed asks the worker itself.
      const b = rig();
      const releaseB = b.feed.acquire();
      b.bus.emit("stage:chart", { viewId: "other", spec, result, visibility: vis(b.store, b.index.count), index: b.index });
      b.bus.emit("stage:chart", { viewId: "v1", spec: { ...spec, top: 5 }, result, visibility: vis(b.store, b.index.count), index: b.index });
      await vi.advanceTimersByTimeAsync(500);
      expect(b.calls).toEqual(["v1#chart"]);
      releaseB();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ui/pages Read: conversation rows show text, not a count (E12 RFC 1)", () => {
  it("falls back to the area while the snippet loads, and keeps the message count out of the visible line", () => {
    const { services } = fakeServices();
    const row: ReadRow = { ordinal: 0, id: "e_aaaaaaaaaaaaaaaa", title: "Cursor per file", ms: NOW, count: 14, youShare: 0.4, source: "claude-code", space: "code", isMap: false };
    const html = render(
      <ServicesContext.Provider value={services}>
        <ReadRowView row={row} when="2 h" tabbable onOpen={() => undefined} onFocus={() => undefined} />
      </ServicesContext.Provider>,
    );
    expect(html).toContain("Cursor per file");
    expect(html).not.toMatch(/>\s*14 messages\s*</);
    expect(html).toContain('title="14 messages"');
  });
});

describe("agents/discard: review.discard closes unanswered Checks cards (E6, Undo of propose_filing)", () => {
  const T1 = "c_aaaaaaaaaaaaaaaa";
  const T2 = "c_bbbbbbbbbbbbbbbb";
  const RUN = "r_cccccccccccccccc";

  async function ledger() {
    const root = await mkdtemp(path.join(os.tmpdir(), "cortex-stab-"));
    const vault = path.join(root, "vault");
    await mkdir(path.join(vault, ".obsidian"), { recursive: true });
    const cacheDir = path.join(root, "cortex", "abcdefghijklmnop");
    await mkdir(cacheDir, { recursive: true });
    const ctx = await openStoreContext({ vaultRoot: vault, cacheDir, owner: "test", log: nullLogger });
    return createLedgerStore(ctx);
  }
  const card = (target: string, patch: Partial<ReviewCardRecord> = {}): ReviewCardRecord => ({ v: 1, id: newReviewCardId(), kind: "filing", target, proposal: {}, createdAt: "2026-11-10T10:00:00.000Z", ...patch });

  it("dismisses by target and by run, never twice, and leaves answered or other cards alone", async () => {
    const l = await ledger();
    const a = card(T1, { runId: RUN as never });
    const b = card(T2, { runId: RUN as never });
    const other = card(T2, { kind: "label" });
    const old = card(T1, { createdAt: "2026-11-01T10:00:00.000Z" });
    await l.append("review", [a, b, other, old]);
    expect(await countOpenChecks(l)).toBe(4);
    // Narrowed by kind, target and time: only the new filing card for T1.
    expect(await discardChecks(l, { targets: [T1], kind: "filing", since: "2026-11-10T00:00:00.000Z" })).toBe(1);
    expect(await countOpenChecks(l)).toBe(3);
    expect(await discardChecks(l, { targets: [T1], kind: "filing", since: "2026-11-10T00:00:00.000Z" })).toBe(0);
    // By run.
    expect(await discardChecks(l, { runId: RUN })).toBe(1);
    expect(await countOpenChecks(l)).toBe(2);
    // A card the person already answered stands: a correction that targets it closes it first.
    await l.appendCorrections([{ v: 1, id: "k_aaaaaaaaaaaaaaaa", at: "2026-11-10T11:00:00.000Z", via: "checks", action: "confirm", target: other.id, payload: {} } as never]);
    expect(await discardChecks(l, { targets: [T2] })).toBe(0);
  });

  it("refuses a request that would dismiss everything, and malformed arguments", async () => {
    const l = await ledger();
    await expect(discardChecks(l, {})).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    await expect(discardChecks(l, { targets: [] })).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    await expect(discardChecks(l, { targets: ["not an id"] })).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    await expect(discardChecks(l, { runId: "nope" })).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    await expect(discardChecks(l, { runId: RUN, since: "yesterday-ish" })).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
  });
});

describe("runner review.discard handler", () => {
  it("is a light command and answers with the number of cards it closed", async () => {
    expect(COMMAND_LANES["review.discard"]).toBe("light");
    const root = await mkdtemp(path.join(os.tmpdir(), "cortex-stab-h-"));
    const vault = path.join(root, "vault");
    await mkdir(path.join(vault, ".obsidian"), { recursive: true });
    const cacheDir = path.join(root, "cortex", "abcdefghijklmnop");
    await mkdir(cacheDir, { recursive: true });
    const ctx = { vaultRoot: vault, vaultKey: "abcdefghijklmnop", cacheDir, settings: DEFAULT_SETTINGS, pluginVersion: "t", settingsSource: "plugin" as const };
    const rc = { id: "x", ctx, token: createCancelSource().token, host: { mode: "child", emit: () => undefined, log: nullLogger, yield: async () => undefined } as unknown as RunnerHost, progress: () => undefined, event: () => undefined };
    const h = createHandlers();
    expect(await h["review.discard"]({ targets: ["c_aaaaaaaaaaaaaaaa"] }, rc)).toEqual({ discarded: 0 });
    await expect(h["review.discard"]({}, rc)).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
  });
});

describe("combined category rename (E9, CORTEX-UX 7.4)", () => {
  const index = buildSampleIndex(20261110, NOW);
  const base: ChartSpec = { chart: "ranked-bars", x: { dim: "source", sort: "count" }, y: null, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options: {} };

  it("stores, reads and clears names in the chart options, keeping control characters and long text out", () => {
    let o = setCombinedName({}, "source", "obsidian", "  My   notes" + String.fromCharCode(7) + " ", "Obsidian");
    expect(o).toEqual({ "rename:source=obsidian": "My notes" });
    expect(renamesOf(o)).toEqual({ "source=obsidian": "My notes" });
    expect(setCombinedName(o, "source", "obsidian", "", "Obsidian")).toEqual({});
    expect(setCombinedName(o, "source", "obsidian", "Obsidian", "Obsidian")).toEqual({});
    o = setCombinedName({ other: 1 }, "source", "x", "y".repeat(200), "X");
    expect((o["rename:source=x"] as string).length).toBe(60);
    expect(o.other).toBe(1);
    expect(renamesOf({ "rename:source=a": 7, "rename:source=b": " ", plain: "x" })).toEqual({});
    expect(isCombined({ "source=a": ["b"] }, "source", "a")).toBe(true);
    expect(isCombined({ "source=a": [] }, "source", "a")).toBe(false);
    expect(isCombined({}, "source", "a")).toBe(false);
  });

  it("names the combined category in the worker's categories, only when it really is a combine", () => {
    const plain = runChart(index, base, defaultVisibility(index.count), { now: NOW });
    const cats = plain.categories ?? [];
    expect(cats.length).toBeGreaterThan(2);
    const [first, second] = [cats[0]!.key, cats[1]!.key];
    const combined = addCombine({}, "source", first, second);
    const spec: ChartSpec = { ...base, combined, options: setCombinedName({}, "source", first, "Both together", "") };
    const res = runChart(index, spec, defaultVisibility(index.count), { now: NOW });
    expect(res.categories?.find((c) => c.key === first)?.label).toBe("Both together");
    // A name on a value that heads no combine is ignored.
    const lone = runChart(index, { ...base, options: setCombinedName({}, "source", first, "Nope", "") }, defaultVisibility(index.count), { now: NOW });
    expect(lone.categories?.find((c) => c.key === first)?.label).toBe(plain.categories?.find((c) => c.key === first)?.label);
  });

  it("shows the name on labels, readings and in the CSV instead of the first value's own name", () => {
    const names = renamesOf({ "rename:source=obsidian": "Writing" });
    expect(categoryName("source", "obsidian", "obsidian", names)).toBe("Writing");
    expect(categoryName("source", "obsidian", "obsidian")).not.toBe("Writing");
    expect(overlayLabelText("Obsidian", parseRef(JSON.stringify({ x: ["source", "obsidian"] })), names)).toBe("Writing");
    expect(readingText({ kind: "peak", copyKey: "readings.peak", values: { label: "x", cat: '["source","obsidian"]' }, at: [0, 0, 0] }, names)).toContain("Writing");
    const result = { overlay: { marks: [], items: [] }, categories: [{ key: "obsidian", label: "Obsidian", count: 3 }] } as unknown as ArrangementResult;
    expect(chartCsv({ ...base, options: { "rename:source=obsidian": "Writing" } }, result, 3)).toContain("Writing");
  });
});

describe("node/paths: a linked folder is caught right before the write, not 30 s later (review leftover)", () => {
  async function vaultWithOutside() {
    const root = await mkdtemp(path.join(os.tmpdir(), "cortex-stab-p-"));
    const vault = path.join(root, "vault");
    const outside = path.join(root, "outside");
    await mkdir(path.join(vault, ".obsidian"), { recursive: true });
    await mkdir(outside, { recursive: true });
    forgetGitignoreChecks();
    return { vault, outside };
  }
  const link = (target: string, at: string): void => symlinkSync(target, at, "junction");

  it("refuses a write when a folder was swapped for a junction after the path was minted", async () => {
    const { vault, outside } = await vaultWithOutside();
    await ensureCortexRoots(vault);
    const minted = writablePath(vault, "wiki/derived/gists/x.md"); // fills the 30 s memory of "no links here"
    await mkdir(path.join(vault, "wiki", "derived", "gists"), { recursive: true });
    await writeFileAtomic(minted, "first");
    expect(existsSync(minted)).toBe(true);
    // Swap the folder for a junction that leads out of the vault.
    await rename(path.join(vault, "wiki", "derived", "gists"), path.join(vault, "wiki", "derived", "gists.old"));
    link(outside, path.join(vault, "wiki", "derived", "gists"));
    await expect(writeFileAtomic(minted, "second")).rejects.toMatchObject({ code: "E_PATH_DENIED" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("ensureCortexRoots creates nothing through a linked folder, and still makes every root with its .gitignore", async () => {
    const { vault, outside } = await vaultWithOutside();
    link(outside, path.join(vault, "wiki"));
    await expect(ensureCortexRoots(vault)).rejects.toMatchObject({ code: "E_PATH_DENIED" });
    expect(await readdir(outside)).toEqual([]);
    const clean = await vaultWithOutside();
    await ensureCortexRoots(clean.vault);
    for (const r of [".raw/chats", ".raw/written", "wiki/derived", ".vault-meta/cortex", ".obsidian/plugins/cortex"]) expect(existsSync(path.join(clean.vault, ...r.split("/"), ".gitignore")), r).toBe(true);
  });

  it("assertFolderChainClear passes real folders and folders that do not exist yet", async () => {
    const { vault } = await vaultWithOutside();
    expect(() => assertFolderChainClear(vault, ".raw/chats/new-source")).not.toThrow();
    await rm(vault, { recursive: true, force: true });
  });
});
