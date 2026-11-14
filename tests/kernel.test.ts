/**
 * Kernel (owner E1): shared utilities, the plugin entry, commands and the service container.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCancelSource } from "../src/shared/cancel";
import { asCortexError, CortexError, notImplemented } from "../src/shared/errors";
import { base32, entryId, conversationId, isEntryId, newRunId, vaultKey, wikiNoteId, sortableBody } from "../src/shared/ids";
import { parseJsonl, splitLines, latestById, toJsonl } from "../src/shared/jsonl";
import { createLogger } from "../src/shared/log";
import { hash32, mulberry32, unitFromString } from "../src/shared/rng";
import { sha256Hex } from "../src/shared/sha256";
import { firstLineTitle, slugify, tokenize, wordCount } from "../src/shared/text";
import { dateFromFilename, isoWeekKey, parseIso, shardMonth, formatLong } from "../src/shared/time";
import { validate } from "../src/shared/validate";
import * as fs from "node:fs";
import * as path from "node:path";
import { COMMAND_IDS, COMMANDS, commandAvailable, registerCommands } from "../src/plugin/commands";
import { BACKGROUND_DELAY_MS, scheduleBackgroundStart } from "../src/plugin/background";
import { createNoticeService, NOTICE_THROTTLE_MS } from "../src/plugin/notices";
import { parseCortexLink } from "../src/plugin/obsidianBridge";
import { statusBarModel } from "../src/plugin/statusBar";
import { DEFAULT_SETTINGS, migrateSettingsChecked } from "../src/shared/settings";
import { loadDeviceState, markHintSeen, parseDeviceState, saveDeviceState, tickChecklist } from "../src/ui/deviceState";
import CortexPlugin from "../src/main";
import { fakeServices } from "./helpers/fakeServices";
import { Plugin as FakePlugin, fakeApp } from "./stubs/obsidian";

describe("shared/sha256 + ids", () => {
  it("matches the SHA-256 test vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
  it("base32 follows RFC 4648 (lowercase, unpadded)", () => {
    expect(base32(new TextEncoder().encode("foobar"))).toBe("mzxw6ytboi");
  });
  it("stable ids are deterministic and well formed", () => {
    const a = entryId("claude-code", "s1:u1");
    expect(a).toBe(entryId("claude-code", "s1:u1"));
    expect(a).not.toBe(entryId("chatgpt", "s1:u1"));
    expect(isEntryId(a)).toBe(true);
    expect(conversationId("chatgpt", "c1")).toMatch(/^c_[a-z2-7]{16}$/);
    expect(wikiNoteId("wiki/kb/x.md")).toMatch(/^w_[a-z2-7]{16}$/);
    expect(vaultKey("C:\\Vault\\")).toBe(vaultKey("c:/vault"));
  });
  it("sortable ids sort by creation time", () => {
    expect(sortableBody(1000) < sortableBody(2000)).toBe(true);
    expect(newRunId()).toMatch(/^r_[a-z2-7]{16}$/);
  });
});

describe("shared/validate", () => {
  it("reports issues with paths", () => {
    const schema = { type: "object" as const, properties: { n: { type: "integer" as const, minimum: 1 } }, required: ["n"], additionalProperties: false };
    expect(validate(schema, { n: 2 }).ok).toBe(true);
    const bad = validate(schema, { n: 0, x: 1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues.map((i) => i.path)).toEqual(["$.n", "$.x"]);
  });
});

describe("shared/jsonl", () => {
  it("keeps an incomplete trailing line as carry", () => {
    const r = splitLines('{"a":1}\n{"b":2}\r\n{"c":');
    expect(r.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(r.carry).toBe('{"c":');
    expect(parseJsonl('{"a":1}\nnot json\n').bad).toEqual([2]);
    expect(toJsonl([{ a: 1 }])).toBe('{"a":1}\n');
    expect(latestById([{ id: "x", seq: 1, v: "old" }, { id: "x", seq: 2, v: "new" }]).get("x")?.v).toBe("new");
  });
});

describe("shared/time", () => {
  it("parses, buckets and formats", () => {
    expect(parseIso("2026-11-09")).toBe(Date.UTC(2026, 10, 9));
    expect(Number.isNaN(parseIso(undefined))).toBe(true);
    expect(shardMonth("2026-11-09T10:00:00.000Z")).toBe("2026-11");
    expect(isoWeekKey(new Date(2026, 10, 9, 12).getTime())).toBe("2026-W46");
    expect(dateFromFilename("2026-07-23.md")).toBe("2026-07-23");
    expect(dateFromFilename("notes.md")).toBeUndefined();
    expect(formatLong(Date.UTC(2026, 10, 8, 12))).toBe("8 November 2026");
  });
});

describe("shared/text", () => {
  it("makes safe slugs and clean titles", () => {
    expect(slugify("Wiki notes: a plan!")).toBe("n-wiki-notes-a-plan");
    expect(slugify("Éclair & Co")).toBe("eclair-co");
    expect(firstLineTitle("\n**Bold** start with [[Link|alias]]\nsecond")).toBe("Bold start with alias");
    expect(wordCount("one two-three four")).toBe(3);
    expect(tokenize("The Roblox API and luau")).toEqual(["roblox", "api", "luau"]);
  });
});

describe("shared/rng", () => {
  it("is deterministic", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a()]).toEqual([b(), b()]);
    expect(hash32("x")).toBe(hash32("x"));
    expect(unitFromString("y")).toBeGreaterThanOrEqual(0);
  });
});

describe("shared/errors + cancel + log", () => {
  it("normalises errors and stub calls", () => {
    expect(() => notImplemented("x")).toThrow(CortexError);
    expect(asCortexError(new Error("boom")).code).toBe("E_INTERNAL");
    expect(new CortexError("E_NOT_IMPLEMENTED", "x").toInfo().code).toBe("E_INTERNAL");
  });
  it("cancels cooperatively", () => {
    const src = createCancelSource();
    expect(src.token.cancelled).toBe(false);
    src.cancel();
    expect(() => src.token.throwIfCancelled()).toThrow(/cancelled/);
    const child = createCancelSource(src.token);
    expect(child.token.cancelled).toBe(true);
  });
  it("gates debug logs", () => {
    const seen: string[] = [];
    const log = createLogger("t", (lvl, _s, msg) => seen.push(`${lvl}:${msg}`), () => false);
    log.debug("hidden");
    log.info("shown");
    expect(seen).toEqual(["info:shown"]);
  });
});

describe("plugin/commands (CORTEX-UX §8.2)", () => {
  it("registers exactly the command ids of the UX table, gated ones through checkCallback", () => {
    const p = new FakePlugin({}, { id: "cortex", version: "0.1.0" });
    registerCommands(p as never, () => undefined);
    const ux = fs.readFileSync(path.join(__dirname, "..", "docs", "CORTEX-UX.md"), "utf8");
    const table = ux.slice(ux.indexOf("### 8.2 Obsidian commands"), ux.indexOf("### 8.3"));
    const uxIds = [...table.matchAll(/\| `([a-z-]+)` \|/g)].map((m) => m[1]);
    expect(uxIds.length).toBe(COMMAND_IDS.length);
    expect(p.commands.map((c) => c.id).sort()).toEqual([...uxIds].sort());
    expect([...COMMAND_IDS].sort()).toEqual([...uxIds].sort());
    // At the shipped P2 build every gated command is a plain callback (the CLI and the palette run it with no
    // Cortex leaf active); an earlier phase keeps the unshipped ones out of the palette through checkCallback.
    const gated = COMMANDS.filter((c) => "feature" in c).map((c) => c.id).sort();
    expect(gated).toEqual(["ask", "change-history", "copy-data-csv", "export-ledger", "new-entry", "open-checks", "open-guide", "open-today", "pin-view", "reset-hints", "save-image", "show-arrivals", "toggle-chart", "toggle-sample"]);
    const ran: string[] = [];
    const q = new FakePlugin({}, { id: "cortex", version: "0.1.0" });
    registerCommands(q as never, (id) => ran.push(id));
    for (const id of gated) {
      const c = q.commands.find((x) => x.id === id);
      expect(c?.callback, id).toBeTypeOf("function");
      expect(c?.checkCallback, id).toBeUndefined();
      expect(commandAvailable(id as never), id).toBe(true);
    }
    q.commands.find((x) => x.id === "toggle-sample")?.callback?.();
    expect(ran).toEqual(["toggle-sample"]);
    const early = new FakePlugin({}, { id: "cortex", version: "0.1.0" });
    registerCommands(early as never, () => undefined, "P0");
    expect(early.commands.find((c) => c.id === "ask")?.checkCallback?.(true)).toBe(false);
    expect(early.commands.find((c) => c.id === "ask")?.callback).toBeUndefined();
    const p1 = new FakePlugin({}, { id: "cortex", version: "0.1.0" });
    registerCommands(p1 as never, () => undefined, "P1");
    expect(p1.commands.find((c) => c.id === "ask")?.callback).toBeTypeOf("function");
    expect(p1.commands.find((c) => c.id === "toggle-sample")?.checkCallback?.(true)).toBe(false);
    expect(p.commands.find((c) => c.id === "open")?.callback).toBeTypeOf("function");
  });
});

describe("main (plugin entry)", () => {
  it("onload registers view, ribbon, commands, settings tab, status bar and link handler without starting services", async () => {
    const app = fakeApp();
    const plugin = new CortexPlugin(app as never, { id: "cortex", version: "0.1.0", name: "Cortex", author: "", minAppVersion: "1.12.0", description: "" } as never);
    const t0 = performance.now();
    await plugin.onload();
    const ms = performance.now() - t0;
    const fake = plugin as unknown as FakePlugin;
    expect(fake.views.has("cortex-view")).toBe(true);
    expect(fake.ribbons[0]?.icon).toBe("cortex-glyph");
    expect(fake.commands.length).toBe(COMMAND_IDS.length);
    expect(fake.settingTabs.length).toBe(1);
    expect(fake.statusItems.length).toBe(1);
    expect(fake.protocolHandlers.has("cortex")).toBe(true);
    expect(fake.hoverSources.has("cortex")).toBe(true);
    expect(app.workspace.handlers.has("file-menu")).toBe(true);
    expect(app.workspace.handlers.has("editor-menu")).toBe(true);
    expect(ms).toBeLessThan(50);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("watches user input for the idle rule, and unloads without building any service", async () => {
    vi.stubGlobal("document", {});
    const plugin = new CortexPlugin(fakeApp() as never, { id: "cortex", version: "0.1.0", name: "Cortex", author: "", minAppVersion: "1.12.0", description: "" } as never);
    await plugin.onload();
    const fake = plugin as unknown as FakePlugin;
    expect(fake.domEvents.map((e) => e.type).sort()).toEqual(["keydown", "pointerdown", "pointermove", "touchstart", "wheel"]);
    expect(() => plugin.onunload()).not.toThrow();
  });

  it("counts only real input as the person being there: an event a script dispatched (Showcase mode's pointer on the Time bars) keeps nothing from going idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      vi.stubGlobal("document", {});
      const plugin = new CortexPlugin(fakeApp() as never, { id: "cortex", version: "0.1.0", name: "Cortex", author: "", minAppVersion: "1.12.0", description: "" } as never);
      await plugin.onload();
      const fake = plugin as unknown as FakePlugin;
      const move = fake.domEvents.find((e) => e.type === "pointermove")?.cb as (e: { isTrusted: boolean }) => void;
      const idle = (): number => (plugin as unknown as { activity: { idleMs(): number } }).activity.idleMs();
      vi.setSystemTime(1_060_000);
      expect(idle()).toBe(60_000);
      move({ isTrusted: false });
      expect(idle()).toBe(60_000);
      move({ isTrusted: true });
      expect(idle()).toBe(0);
      plugin.onunload();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("plugin/container", () => {
  it("builds the two tiers from the vault path with per-leaf stores and the new services", () => {
    const { services: s, leaf } = fakeServices();
    expect(s.vaultRoot).toBe("C:/vault");
    expect(s.vaultKey).toMatch(/^[a-z2-7]{16}$/);
    expect(s.cacheDir).toContain(s.vaultKey);
    expect(leaf.store.get("ui").tab).toBe("brain");
    const other = s.createLeaf("second");
    expect(other.store).not.toBe(leaf.store);
    for (const k of ["device", "sources", "newEntry", "pinnedViews", "records", "ledger", "colours"] as const) expect(s[k]).toBeDefined();
  });
});

describe("plugin/background (SAFE-11, BG-IMPORT-UNWIRED)", () => {
  it("starts background work only after the first-run step, never when settings are corrupt", () => {
    const timers: { cb: () => void; ms: number }[] = [];
    const fakeTimers = { setTimeout: (cb: () => void, ms: number) => (timers.push({ cb, ms }), timers.length), clearTimeout: () => undefined, requestIdle: (cb: () => void) => (cb(), 0) };
    let firstRunDone = false;
    let started = 0;
    scheduleBackgroundStart(fakeTimers as never, { firstRunDone: () => firstRunDone, corrupt: () => false }, () => started++);
    for (const t of timers.splice(0)) t.cb();
    expect(started).toBe(0);
    firstRunDone = true;
    scheduleBackgroundStart(fakeTimers as never, { firstRunDone: () => firstRunDone, corrupt: () => true }, () => started++);
    for (const t of timers.splice(0)) t.cb();
    expect(started).toBe(0);
    scheduleBackgroundStart(fakeTimers as never, { firstRunDone: () => firstRunDone, corrupt: () => false }, () => started++);
    expect(timers[0]?.ms).toBe(BACKGROUND_DELAY_MS);
    for (const t of timers.splice(0)) t.cb();
    expect(started).toBe(1);
  });
});

describe("plugin/obsidianBridge links (SAFE-17)", () => {
  it("accepts only navigation with validated parameters", () => {
    expect(parseCortexLink({ entry: "e_aaaaaaaaaaaaaaaa" })).toEqual({ kind: "entry", id: "e_aaaaaaaaaaaaaaaa" });
    expect(parseCortexLink({ entry: "e_bad" })).toBeNull();
    expect(parseCortexLink({ view: "v_aaaaaaaaaaaaaaaa" })).toEqual({ kind: "view", id: "v_aaaaaaaaaaaaaaaa" });
    expect(parseCortexLink({ view: "../x" })).toBeNull();
    expect(parseCortexLink({ period: "2026-11-02..2026-11-08" })).toEqual({ kind: "period", start: "2026-11-02", end: "2026-11-08" });
    expect(parseCortexLink({ period: "2026-11-08..2026-11-02" })).toBeNull();
    expect(parseCortexLink({ import: "claude-code" } as never)).toBeNull();
  });
});

describe("plugin/notices + statusBar (§5.11)", () => {
  it("throttles notices per kind and only while no Cortex leaf is visible", () => {
    let now = 0;
    const shown: string[] = [];
    let visible = false;
    const n = createNoticeService({ now: () => now, anyLeafVisible: () => visible, show: (t) => shown.push(t) });
    n.notify("capped", "a");
    n.notify("capped", "b");
    now += NOTICE_THROTTLE_MS + 1;
    n.notify("capped", "c");
    visible = true;
    now += NOTICE_THROTTLE_MS + 1;
    n.notify("capped", "d");
    expect(shown).toEqual(["a", "c"]);
  });
  it("says set up before the first-run step", () => {
    const { services } = fakeServices();
    const m = statusBarModel({ activity: services.shared.get("activity"), queues: services.shared.get("queues"), firstRunDone: false, agentsEnabled: true });
    expect(m.text).toBe("Cortex · set up");
  });
});

describe("shared/settings fail-safe migration (SAFE-08, §12.10)", () => {
  it("defaults follow CORTEX-UX §5.27", () => {
    const s = DEFAULT_SETTINGS;
    expect(s.agents.planCaps).toEqual({ fiveHour: { on: true, pct: 70 }, weekly: { on: true, pct: 70 } });
    expect(s.agents.models).toEqual({ labels: "haiku", summaries: "sonnet", maps: "opus", ask: "sonnet" });
    expect(s.agents.applyAskWithoutConfirm).toBe(false);
    expect(s.agents.skipReference).toBe(true);
    expect(s.privacy.withholdAssistantFrom).toEqual({ chatgpt: true, gemini: true, "claude-ai": false, "claude-code": false });
    expect(s.privacy.keepSecretsLocal).toBe(true);
    expect(s.appearance.stageTint).toBeNull();
    expect(s.general.openOnStartup).toBe(false);
    expect(s.general.firstRunDone).toBe(false);
    expect("paths" in s).toBe(false);
  });
  it("uses safe values for wrong types and rejects malformed exclusion lists", () => {
    const m = migrateSettingsChecked({ version: 3, agents: { enabled: "yes", applyAskWithoutConfirm: 1 }, privacy: { withholdAssistantFrom: { chatgpt: "no" }, redact: { secrets: 0 } } });
    expect(m.settings.agents.enabled).toBe(false);
    expect(m.settings.agents.applyAskWithoutConfirm).toBe(false);
    expect(m.settings.privacy.withholdAssistantFrom.chatgpt).toBe(true);
    expect(m.settings.privacy.redact.secrets).toBe(true);
    expect(m.corrupt).toBe(false);
    const bad = migrateSettingsChecked({ version: 3, privacy: { offLimits: [{ path: 1 }] } });
    expect(bad.corrupt).toBe(true);
    expect(bad.settings.agents.paused).toBe(true);
    expect(bad.settings.agents.enabled).toBe(false);
    expect(migrateSettingsChecked("garbage").corrupt).toBe(true);
  });
  it("upgrades earlier development keys", () => {
    const m = migrateSettingsChecked({ version: 2, agents: { autoOrganise: false, askChangesWithoutApply: true }, privacy: { keepRepliesLocal: { chatgpt: false }, namesThatMeanYou: ["ari"] }, appearance: { names: "always", stageTint: -1 }, runner: { nodePath: "C:/node.exe" } });
    expect(m.settings.agents.enabled).toBe(false);
    expect(m.settings.agents.applyAskWithoutConfirm).toBe(true);
    expect(m.settings.privacy.withholdAssistantFrom.chatgpt).toBe(false);
    expect(m.settings.you.names).toEqual(["ari"]);
    expect(m.settings.appearance.namesOnFigure).toBe("always");
    expect(m.settings.appearance.stageTint).toBeNull();
    expect(m.settings.advanced.nodePath).toBe("C:/node.exe");
  });
});

describe("ui/deviceState (per-device hints and checklist)", () => {
  it("parses defensively and stores through app local storage", () => {
    const app = fakeApp();
    expect(parseDeviceState({ hintsSeen: ["stage", "bogus"], checklist: { "add-source": true } }).hintsSeen).toEqual(["stage"]);
    let s = loadDeviceState(app);
    s = tickChecklist(markHintSeen(s, "strip"), "open-frond");
    saveDeviceState(app, s);
    expect(loadDeviceState(app).hintsSeen).toEqual(["strip"]);
    expect(loadDeviceState(app).checklist["open-frond"]).toBe(true);
  });
});

describe("plugin/settingsStore (SAFE-08)", () => {
  const persistence = (saved: unknown[]) => ({
    load: async () => null,
    exists: async () => false,
    save: async (s: unknown) => void saved.push(s),
    backup: async () => undefined,
  });
  it("refuses to save over unreadable settings until the defaults are chosen", async () => {
    const { createSettingsHandle, loadSettings } = await import("../src/plugin/settingsStore");
    const saved: unknown[] = [];
    let kept = 0;
    const p = { ...persistence(saved), load: async () => Promise.reject(new Error("bad json")), exists: async () => true, keepUnreadable: async () => void kept++ };
    const h = createSettingsHandle(await loadSettings(p), p);
    expect(h.corrupt).toBe(true);
    expect(h.value.agents.paused).toBe(true);
    await expect(h.update((s) => void (s.general.debug = true))).rejects.toThrow();
    expect(saved.length).toBe(0);
    await h.useDefaults();
    expect(kept).toBe(1);
    expect(h.corrupt).toBe(false);
    expect(saved.length).toBe(1);
  });
  it("saves changes in call order and tells the listener once per change", async () => {
    const { createSettingsHandle } = await import("../src/plugin/settingsStore");
    const saved: unknown[] = [];
    const seen: boolean[] = [];
    const h = createSettingsHandle(migrateSettingsChecked(undefined), persistence(saved), (s) => seen.push(s.general.debug));
    await Promise.all([h.update((s) => void (s.general.debug = true)), h.update((s) => void (s.general.debug = true)), h.update((s) => void (s.general.debug = false))]);
    expect(seen).toEqual([true, false]);
    expect(saved.length).toBe(2);
  });
});

describe("plugin/container helpers", () => {
  it("selects imports from what is turned on, and only the claude-code source for live passes", async () => {
    const { importSelectors, foldRunnerEvent, noticeForEvent } = await import("../src/plugin/container");
    const s = structuredClone(DEFAULT_SETTINGS);
    s.sources.claudeCode.enabled = true;
    expect(importSelectors(s, "watch")).toEqual([{ kind: "claude-code" }]);
    // A note changed in the vault outside wiki/: the vault's notes only, never the transcripts; nothing when the vault is off.
    s.sources.vault.enabled = true;
    expect(importSelectors(s, "vault").map((x) => x.kind)).toContain("vault-notes");
    expect(importSelectors(s, "vault").map((x) => x.kind)).not.toContain("claude-code");
    s.sources.vault.enabled = false;
    expect(importSelectors(s, "vault").map((x) => x.kind)).not.toContain("vault-notes");
    s.sources.claudeCode.enabled = false;
    expect(importSelectors(s, "seal")).toEqual([]);
    const { services } = fakeServices();
    const plan = { fiveHour: { window: "fiveHour", pct: 71, capPct: 70, resetsAt: 1, stale: false, atCap: true }, weekly: { window: "weekly", pct: null, capPct: 70, resetsAt: null, stale: false, atCap: false } };
    foldRunnerEvent(services.shared, { kind: "budget", tokensToday: 5, plan, capped: true } as never);
    expect(services.shared.get("activity").capped).toBe(true);
    expect(services.shared.get("activity").plan.fiveHour.pct).toBe(71);
    const before = { capped: false, engine: "ok" };
    expect(noticeForEvent({ kind: "budget", tokensToday: 5, plan, capped: true } as never, before)?.kind).toBe("capped");
    expect(noticeForEvent({ kind: "budget", tokensToday: 5, plan, capped: true } as never, { ...before, capped: true })).toBeNull();
    expect(noticeForEvent({ kind: "engine-state", state: "auth" } as never, before)?.kind).toBe("engine");
  });
  it("keeps Pause in the settings and answers commands through the catalogue", async () => {
    const { runCommand } = await import("../src/plugin/commandRun");
    const { services } = fakeServices();
    const shown: string[] = [];
    await runCommand("pause-agents", services, { app: services.app, reveal: async () => null, notice: (x) => void shown.push(x) });
    expect(services.settings.value.agents.paused).toBe(true);
    await runCommand("resume-agents", services, { app: services.app, reveal: async () => null, notice: (x) => void shown.push(x) });
    expect(services.settings.value.agents.paused).toBe(false);
  });
  it("runs the sample record toggle with no active or mounted Cortex leaf (Obsidian CLI: command id=cortex:toggle-sample)", async () => {
    const { runCommand } = await import("../src/plugin/commandRun");
    const { services } = fakeServices();
    const seen: { viewId: string; id: string }[] = [];
    services.bus.on("command", (ev) => void seen.push(ev));
    const shown: string[] = [];
    // no leaf at all
    await runCommand("toggle-sample", services, { app: services.app, reveal: async () => null, notice: (x) => void shown.push(x) });
    // revealing the leaf fails
    await runCommand("toggle-sample", services, { app: services.app, reveal: async () => Promise.reject(new Error("no leaf")), notice: (x) => void shown.push(x) });
    // a view that never mounts a store must not stall the toggle
    const view = { viewId: "v-test", leafStore: () => null } as never;
    const t0 = Date.now();
    await runCommand("toggle-sample", services, { app: services.app, reveal: async () => view, notice: (x) => void shown.push(x), mountTimeoutMs: 20_000 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(seen.map((e) => e.id)).toEqual(["toggle-sample", "toggle-sample", "toggle-sample"]);
    expect(seen[2]?.viewId).toBe("v-test");
    expect(shown).toEqual([]);
  });
  it("says so when a leaf command cannot find or open a Cortex leaf", async () => {
    const { runCommand } = await import("../src/plugin/commandRun");
    const { services } = fakeServices();
    const shown: string[] = [];
    await runCommand("open-read", services, { app: services.app, reveal: async () => null, notice: (x) => void shown.push(x) });
    expect(shown.length).toBe(1);
  });
});

describe("plugin/saveFile + pinnedViews names", () => {
  it("makes Windows-safe names and unique Downloads paths", async () => {
    const { safeFileName, downloadsFallbackPath } = await import("../src/plugin/saveFile");
    expect(safeFileName("a/b:c?.png")).toBe("a_b_c_.png");
    expect(safeFileName("CON.txt")).toBe("_CON.txt");
    expect(safeFileName("  ..  ")).toBe("cortex-export");
    const taken = new Set([path.join("D", "x.png"), path.join("D", "x (2).png")]);
    expect(downloadsFallbackPath("x.png", (p) => taken.has(p), "H", "D")).toBe(path.join("D", "x (3).png"));
  });
  it("normalises view names and rejects empty ones", async () => {
    const { cleanViewName } = await import("../src/plugin/pinnedViews");
    expect(cleanViewName("  my   view ")).toBe("my view");
    expect(() => cleanViewName("   ")).toThrow();
    expect(cleanViewName("x".repeat(300)).length).toBe(120);
  });
});
