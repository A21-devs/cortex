/**
 * App-level commands and the command bar (P21): the shared action registry and the new commands, the update
 * check's version logic, the lock (hash, verify, state, overlay), the "Filter by" tokens and tag support in the
 * token parser, the one-step "not mine" correction, the About / agreement / connect helpers and the theme cards.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTION_REGISTRY, availableActions, COMMAND_IDS, COMMANDS, registerCommands } from "../src/plugin/commands";
import { CortexSettingTab } from "../src/plugin/settingsTab";
import { clampAutoLock, fromHex, hasPassphrase, hashPassphrase, sameDigest, shouldAutoLock, toHex, verifyPassphrase } from "../src/shared/lock";
import { resolveStage, stageColours, STAGES, themeAttr, themeCardsFor, THEME_CARDS, THEME_STAGES } from "../src/shared/palette";
import { STAGE_IDS } from "../src/shared/settings";
import { checkForUpdate, compareVersions, judgeUpdate, latestReleaseUrl, parseVersion, releasesRepo, tagOf } from "../src/shared/update";
import { appLocked, clickLifts, lockApp, tryUnlock, unlockApp } from "../src/state/lock";
import { COPY, SETTINGS_COPY, t } from "../src/ui/copy";
import { filterRows, matchActions } from "../src/ui/command/CommandLine";
import { groupFindRows, GROUP_ORDER } from "../src/ui/command/FindResults";
import { markNotMine, ownMessageIds, selectedConversation } from "../src/ui/command/notMine";
import { parseSlash, SLASH_COMMANDS } from "../src/ui/command/slashCommands";
import { aboutLinks } from "../src/ui/modals/AboutModal";
import { agreementView } from "../src/ui/modals/AgreementModal";
import { connectOutcome, localEngineOffered } from "../src/ui/modals/ConnectModal";
import { APP_MORE_COMMANDS, moreItems } from "../src/ui/header/MoreMenu";
import { facetsOf, FACET_ROWS } from "../src/worker/search";
import { tagOrdinals } from "../src/worker/indexOps";
import { migrateSettings } from "../src/shared/settings";
import { fakeServices } from "./helpers/fakeServices";
import { Setting } from "./stubs/obsidian";
import type { DataIndex } from "../src/shared/index-format";
import type { CortexServices } from "../src/plugin/services";
import type { Plugin } from "obsidian";

afterEach(() => unlockApp());

describe("action registry and the new commands", () => {
  it("lists the app-level actions, each a registered command", () => {
    const ids = ACTION_REGISTRY.map((a) => a.id);
    for (const id of ["add-sources", "home-view", "display", "import-claude-code", "run-agents", "check-updates", "lock", "setup-agents"] as const) expect(ids).toContain(id);
    for (const a of ACTION_REGISTRY) expect(COMMAND_IDS, a.id).toContain(a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(availableActions().map((a) => a.id)).toEqual(ids);
  });

  it("registers Set up agents, Lock, Check for updates, About, Settings, Connect and Show what is sent", () => {
    const names = Object.fromEntries(COMMANDS.map((c) => [c.id, c.name]));
    expect(names).toMatchObject({ "setup-agents": "Set up agents", lock: "Lock", "check-updates": "Check for updates", about: "About Cortex", "open-settings": "Cortex settings", "connect-agent": "Connect an agent", "show-agreement": "Show what is sent" });
  });

  it("gives Lock Mod+Shift+L (never Mod+L) and no other command a default hotkey", () => {
    const added: { id: string; hotkeys?: { modifiers: string[]; key: string }[] }[] = [];
    registerCommands({ addCommand: (c: never) => void added.push(c) } as unknown as Pick<Plugin, "addCommand">, () => undefined);
    const withKeys = added.filter((c) => c.hotkeys);
    expect(withKeys.map((c) => c.id)).toEqual(["lock"]);
    expect(withKeys[0]?.hotkeys).toEqual([{ modifiers: ["Mod", "Shift"], key: "L" }]);
  });

  it("searches the registry by label and words, and adds the Find group order", () => {
    expect(matchActions("lock").map((a) => a.id)).toContain("lock");
    expect(matchActions("update").map((a) => a.id)).toContain("check-updates");
    expect(matchActions("claude").map((a) => a.id)).toEqual(expect.arrayContaining(["setup-agents", "import-claude-code"]));
    expect(matchActions("")).toEqual([]);
    expect(GROUP_ORDER).toEqual(["entries", "notes", "maps", "areas", "filters", "pages"]);
    const groups = groupFindRows(
      [
        { key: "a", group: "pages", icon: "play", title: "x", meta: "", action: { kind: "command", id: "lock" } },
        { key: "b", group: "filters", icon: "sources", title: "y", meta: "", action: { kind: "not-mine" } },
      ],
      new Set(),
    );
    expect(groups.map((g) => g.id)).toEqual(["filters", "pages"]);
    expect(groups[0]?.label).toBe(COPY.command.filterBy);
  });

  it("puts the app items in the More menu, each mapped to its command", () => {
    const values = moreItems().map((i) => i.value);
    for (const v of Object.keys(APP_MORE_COMMANDS)) expect(values).toContain(v);
    for (const cmd of Object.values(APP_MORE_COMMANDS)) expect(COMMAND_IDS).toContain(cmd);
  });
});

describe("update check", () => {
  it("compares versions numerically", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(parseVersion("latest")).toBeNull();
    expect(compareVersions("0.10.0", "0.9.5")).toBe(1);
    expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
    expect(compareVersions("0.1.0", "v0.2.0")).toBe(-1);
    expect(compareVersions("x", "0.1.0")).toBeNull();
  });

  it("judges current, available and unreadable tags", () => {
    expect(judgeUpdate("0.1.0", "v0.1.0")).toEqual({ kind: "current", current: "0.1.0" });
    expect(judgeUpdate("0.2.0", "0.1.9")).toEqual({ kind: "current", current: "0.2.0" });
    expect(judgeUpdate("0.1.0", "v0.2.0")).toEqual({ kind: "available", current: "0.1.0", latest: "0.2.0" });
    expect(judgeUpdate("0.1.0", "nightly")).toEqual({ kind: "unknown", current: "0.1.0" });
    expect(t("update.current", { version: "0.1.0" })).toBe("Cortex 0.1.0 is current.");
    expect(t("update.available", { version: "0.2.0" })).toBe("Cortex 0.2.0 is available. Update it in Community plugins.");
  });

  it("finds the repository from authorUrl or the constant, and refuses anything else", () => {
    expect(releasesRepo({ authorUrl: "https://github.com/someone/cortex" }, "")).toBe("someone/cortex");
    expect(releasesRepo({ authorUrl: "https://github.com/someone", id: "cortex" }, "")).toBe("someone/cortex");
    expect(releasesRepo({ authorUrl: "https://example.com/someone/cortex" }, "")).toBeNull();
    expect(releasesRepo({}, "")).toBeNull();
    expect(releasesRepo({}, "owner/repo")).toBe("owner/repo");
    expect(releasesRepo({})).toBe("A21-devs/cortex");
    expect(releasesRepo({ authorUrl: "https://github.com/a b/c" }, "")).toBeNull();
    expect(latestReleaseUrl("a/b")).toBe("https://api.github.com/repos/a/b/releases/latest");
  });

  it("makes exactly one request and judges its tag", async () => {
    const fetchJson = vi.fn(async () => ({ tag_name: "v0.3.0" }));
    expect(await checkForUpdate({ version: "0.1.0", repo: "a/b", fetchJson })).toEqual({ kind: "available", current: "0.1.0", latest: "0.3.0" });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(fetchJson).toHaveBeenCalledWith("https://api.github.com/repos/a/b/releases/latest");
    expect(await checkForUpdate({ version: "0.1.0", repo: "a/b", fetchJson: async () => ({}) })).toEqual({ kind: "unknown", current: "0.1.0" });
    await expect(checkForUpdate({ version: "0.1.0", repo: "a/b", fetchJson: async () => Promise.reject(new Error("offline")) })).rejects.toThrow();
    expect(tagOf({ tag_name: 3 })).toBeNull();
  });
});

describe("lock", () => {
  it("hashes with a random salt and never stores the passphrase", async () => {
    const a = await hashPassphrase("correct horse", 1000);
    const b = await hashPassphrase("correct horse", 1000);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(a.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(a)).not.toContain("correct horse");
    expect(hasPassphrase(a)).toBe(true);
  });

  it("verifies the right passphrase and refuses a wrong one", async () => {
    const rec = await hashPassphrase("open sesame", 1000);
    expect(await verifyPassphrase("open sesame", rec)).toBe(true);
    expect(await verifyPassphrase("open sesame ", rec)).toBe(false);
    expect(await verifyPassphrase("", rec)).toBe(false);
    expect(await verifyPassphrase("open sesame", { ...rec, salt: "zz" })).toBe(false);
    expect(await verifyPassphrase("open sesame", { ...rec, iterations: 0 })).toBe(false);
  });

  it("is a privacy blank with no passphrase", async () => {
    const none = { salt: "", hash: "", iterations: 1000 };
    expect(hasPassphrase(none)).toBe(false);
    expect(clickLifts(none)).toBe(true);
    expect(await verifyPassphrase("anything", none)).toBe(true);
  });

  it("uses safe hex helpers and a constant-time compare", () => {
    expect(toHex(Uint8Array.from([0, 15, 255]))).toBe("000fff");
    expect(fromHex("000fff")).toEqual(Uint8Array.from([0, 15, 255]));
    expect(fromHex("0g")).toBeNull();
    expect(fromHex("abc")).toBeNull();
    expect(sameDigest("ab", "ab")).toBe(true);
    expect(sameDigest("ab", "ac")).toBe(false);
    expect(sameDigest("ab", "abc")).toBe(false);
  });

  it("locks and unlocks the window state", async () => {
    const rec = await hashPassphrase("pw-1234", 1000);
    lockApp();
    expect(appLocked.value).toBe(true);
    expect(await tryUnlock("nope", rec)).toBe(false);
    expect(appLocked.value).toBe(true);
    expect(await tryUnlock("pw-1234", rec)).toBe(true);
    expect(appLocked.value).toBe(false);
    lockApp();
    expect(await tryUnlock("", { salt: "", hash: "", iterations: 1 })).toBe(true);
    expect(appLocked.value).toBe(false);
  });

  it("auto-locks only after the idle minutes, never when off or already locked", () => {
    expect(clampAutoLock(0)).toBe(0);
    expect(clampAutoLock(-3)).toBe(0);
    expect(clampAutoLock(7.9)).toBe(7);
    expect(clampAutoLock(9999)).toBe(240);
    expect(shouldAutoLock(4 * 60_000, 5, false)).toBe(false);
    expect(shouldAutoLock(5 * 60_000, 5, false)).toBe(true);
    expect(shouldAutoLock(60 * 60_000, 0, false)).toBe(false);
    expect(shouldAutoLock(60 * 60_000, 5, true)).toBe(false);
  });

  it("keeps the lock record in settings with safe defaults", () => {
    const s = migrateSettings(undefined);
    expect(s.privacy.lock).toEqual({ salt: "", hash: "", iterations: 210_000, autoLockMinutes: 0 });
    expect(migrateSettings({ version: 4, privacy: { lock: { autoLockMinutes: 10 } } }).privacy.lock.autoLockMinutes).toBe(10);
  });
});

/** A two-source, one-multi-label index with four rows (only the columns the facet code reads). */
function fakeIndex(): DataIndex {
  return {
    count: 4,
    cols: { kind: Uint8Array.from([1, 1, 1, 1]), source: Uint8Array.from([0, 0, 1, 1]) },
    labels: [{ pack: "session", packVersion: "1.0.0", field: "topics", type: "multi", values: ["alpha", "beta"], multi: { offsets: Uint32Array.from([0, 2, 3, 3, 4]), targets: Uint16Array.from([0, 1, 0, 1]) }, byUser: new Uint8Array(4) }],
  } as unknown as DataIndex;
}

describe("Find: Filter by sources and tags", () => {
  it("counts sources and tags among the hits and drops values every hit has", () => {
    const f = facetsOf(fakeIndex(), [0, 1, 2, 3]);
    expect(f.sources).toEqual([
      { source: "claude-code", count: 2 },
      { source: "claude-ai", count: 2 },
    ]);
    expect(f.tags).toEqual([
      { dim: "label:session/topics", value: "alpha", count: 2 },
      { dim: "label:session/topics", value: "beta", count: 2 },
    ]);
    const one = facetsOf(fakeIndex(), [0, 1]);
    expect(one.sources).toEqual([]);
    expect(one.tags.map((r) => r.value)).toEqual(["beta"]);
    expect(FACET_ROWS).toBe(4);
  });

  it("turns a suggestion into a source:x or tag:x group token", () => {
    const rows = filterRows({ sources: [{ source: "claude-code", count: 12 }], tags: [{ dim: "label:session/topics", value: "lighting", count: 7 }] });
    expect(rows.map((r) => r.group)).toEqual(["filters", "filters"]);
    expect(rows[0]?.meta).toBe("Source · 12");
    expect(rows[0]?.action).toEqual({ kind: "filter", token: { id: "find:source:claude-code", dim: "source", value: "claude-code", label: "Source: Claude Code" } });
    expect(rows[1]?.meta).toBe("Tag · 7");
    expect(rows[1]?.action).toEqual({ kind: "filter", token: { id: "find:tag:label:session/topics:lighting", dim: "label:session/topics", value: "lighting", label: "Tag: lighting" } });
    expect(filterRows({})).toEqual([]);
  });

  it("lets a tag token select every item carrying the value, not only the first", () => {
    const idx = fakeIndex();
    expect(tagOrdinals(idx, "label:session/topics", "alpha")).toEqual([0, 1]);
    expect(tagOrdinals(idx, "label:session/topics", "beta")).toEqual([0, 3]);
    expect(tagOrdinals(idx, "label:session/topics", "missing")).toEqual([]);
    expect(tagOrdinals(idx, "label:session/*", "")).toBeNull();
    expect(tagOrdinals(idx, "source", "claude-code")).toBeNull();
    expect(tagOrdinals(idx, "label:session/other", "alpha")).toBeNull();
  });
});

describe("/not-mine", () => {
  it("is a one-step slash command that asks no model", () => {
    const c = SLASH_COMMANDS.find((x) => x.name === "not-mine");
    expect(c?.direct).toBe("not-mine");
    expect(parseSlash("/not-mine")?.command.name).toBe("not-mine");
    expect(SLASH_COMMANDS.filter((x) => x.direct).length).toBe(1);
  });

  function harness(speakers: string[]) {
    const applied: { target: string; speaker: string }[] = [];
    const undone: string[] = [];
    const toasts: { kind: string; text: string; undo?: () => Promise<void> }[] = [];
    const meta = (ordinal: number) => ({ ordinal, id: `e_${ordinal}`, conversation: { id: "c1", title: "Plans", index: ordinal, count: speakers.length } });
    const s = {
      sandbox: { value: false },
      index: { meta },
      records: { conversationSlice: async (_id: string, from: number, to: number) => speakers.slice(from, to).map((speaker, i) => ({ ordinal: from + i, speaker })) },
      corrections: {
        apply: async (c: { target: string; payload: { speaker: string } }) => {
          applied.push({ target: c.target, speaker: c.payload.speaker });
          return { id: `k_${applied.length}` };
        },
        undo: async (id: string) => void undone.push(id),
      },
    } as unknown as CortexServices;
    const leaf = { store: { get: () => ({ ordinal: 1, id: "e_1" }) } } as never;
    const shell = { toast: (x: { kind: string; text: string; undo?: () => Promise<void> }) => void toasts.push(x), announce: () => undefined } as never;
    return { s, leaf, shell, applied, undone, toasts };
  }

  it("finds the conversation of the selection and its own messages", async () => {
    const h = harness(["you", "assistant", "you"]);
    expect(selectedConversation(h.s, { ordinal: 0, id: "e_0" })).toEqual({ id: "c1", title: "Plans", count: 3 });
    expect(selectedConversation(h.s, null)).toBeNull();
    expect(await ownMessageIds(h.s, { id: "c1", count: 3 })).toEqual(["e_0", "e_2"]);
  });

  it("sets Another person on every message filed as yours, with one Undo that restores them all", async () => {
    const h = harness(["you", "assistant", "you"]);
    const r = await markNotMine(h.s, h.leaf, h.shell);
    expect(r).toEqual({ kind: "done", changed: 2 });
    expect(h.applied).toEqual([
      { target: "e_0", speaker: "other" },
      { target: "e_2", speaker: "other" },
    ]);
    expect(h.toasts[0]?.kind).toBe("change");
    await h.toasts[0]?.undo?.();
    expect(h.undone).toEqual(["k_2", "k_1"]);
  });

  it("says so when nothing is filed as yours, and refuses in the sample record", async () => {
    const none = harness(["assistant", "tool"]);
    expect(await markNotMine(none.s, none.leaf, none.shell)).toEqual({ kind: "nothing" });
    expect(none.applied).toEqual([]);
    const sample = harness(["you"]);
    (sample.s as unknown as { sandbox: { value: boolean } }).sandbox.value = true;
    expect(await markNotMine(sample.s, sample.leaf, sample.shell)).toEqual({ kind: "failed" });
    expect(sample.applied).toEqual([]);
  });
});

describe("About, agreement and connect", () => {
  it("links the documentation and changelog only when a repository is known", () => {
    expect(aboutLinks({ authorUrl: "https://github.com/someone/cortex" })).toEqual({ docs: "https://github.com/someone/cortex#readme", changelog: "https://github.com/someone/cortex/releases" });
    expect(aboutLinks({})).toEqual({ docs: "https://github.com/A21-devs/cortex#readme", changelog: "https://github.com/A21-devs/cortex/releases" });
  });

  it("shows the current choice and what is removed before sending", () => {
    const fresh = migrateSettings(undefined);
    expect(agreementView(fresh)).toMatchObject({ chosen: false, choiceTitle: COPY.agreement.notChosen });
    const done = migrateSettings(undefined);
    done.general.firstRunDone = true;
    done.general.firstRunChoice = "import-only";
    done.agents.enabled = false;
    const v = agreementView(done);
    expect(v.chosen).toBe(true);
    expect(v.choiceTitle).toBe(COPY.firstRun.importOnly);
    expect(v.hidden).toEqual([COPY.agreement.secrets, COPY.agreement.emails, COPY.agreement.phones, COPY.agreement.personal]);
    done.general.firstRunChoice = "import-and-organise";
    done.agents.enabled = true;
    expect(agreementView(done).choiceTitle).toBe(COPY.firstRun.importOrganise);
  });

  it("reads a doctor result as connected, silent or missing", () => {
    const base = { path: "claude", flags: {}, missingMandatory: [], envKeys: [] };
    expect(connectOutcome({ claude: { ...base, version: "2.1.0", liveCheck: "ok" } }, 1.234)).toEqual({ kind: "ok", version: "2.1.0", seconds: "1.2" });
    expect(connectOutcome({ claude: { ...base, version: "2.1.0", liveCheck: "failed" } }, 1)).toEqual({ kind: "silent", version: "2.1.0" });
    expect(connectOutcome({ claude: { ...base } }, 1)).toEqual({ kind: "missing" });
  });

  it("offers the local engine only when settings carry a local block", () => {
    const s = migrateSettings(undefined);
    expect(localEngineOffered(s)).toBe(true); // the local engine exists (P20), so its block is always there
    delete (s.agents as unknown as { local?: object }).local;
    expect(localEngineOffered(s)).toBe(false);
  });
});

describe("theme cards", () => {
  it("has six dark cards and Paper with Cortex's own names, none of the reference's, and Follow only in the plugin", () => {
    expect(THEME_CARDS.map((c) => c.id)).toEqual(["follow", "ink", "vesper", "lichen", "copper", "cobalt", "flint", "garnet", "paper"]);
    expect([...STAGE_IDS]).toEqual(THEME_CARDS.map((c) => c.id));
    const names = [SETTINGS_COPY.appearance.followTheme, SETTINGS_COPY.appearance.ink, SETTINGS_COPY.appearance.vesper, SETTINGS_COPY.appearance.lichen, SETTINGS_COPY.appearance.copper, SETTINGS_COPY.appearance.cobalt, SETTINGS_COPY.appearance.flint, SETTINGS_COPY.appearance.garnet, SETTINGS_COPY.appearance.paper];
    expect(names).toEqual(["Follow theme", "Ink", "Vesper", "Lichen", "Copper", "Cobalt", "Flint", "Garnet", "Paper"]);
    expect(themeCardsFor(true).map((c) => c.id)).toContain("follow");
    expect(themeCardsFor(false).map((c) => c.id)).toEqual(["ink", "vesper", "lichen", "copper", "cobalt", "flint", "garnet", "paper"]);
  });

  it("resolves the new themes onto a dark stage with their own colours and a theme attribute", () => {
    for (const id of ["vesper", "lichen", "copper", "cobalt", "flint", "garnet"] as const) {
      expect(resolveStage(id, false, "prism")).toBe("ink");
      expect(resolveStage(id, true, "prism")).toBe("ink");
      expect(themeAttr(id, "ink")).toBe(id);
      expect(stageColours(id, "ink")).toEqual(THEME_STAGES[id]);
    }
    expect(themeAttr("ink", "ink")).toBeUndefined();
    expect(themeAttr("follow", "ink")).toBeUndefined();
    expect(themeAttr("paper", "paper")).toBeUndefined();
    // A palette that forces Paper wins over the theme.
    expect(resolveStage("vesper", true, "print")).toBe("paper");
    expect(themeAttr("vesper", "paper")).toBeUndefined();
    expect(stageColours("vesper", "paper")).toEqual(STAGES.paper);
    expect(stageColours("follow", "ink")).toEqual(STAGES.ink);
  });

  it("renders the selectable cards in Settings > Appearance and picks one on click", async () => {
    const hh = fakeServices();
    const tab = new CortexSettingTab(hh.services.app as never, { plugin: { manifest: { version: "0.1.0" } } as never, settings: () => hh.services.settings, services: () => Promise.reject(new Error("not needed")) });
    (Setting as unknown as { created: unknown[] }).created.length = 0;
    tab.section = "appearance";
    tab.display();
    type El = { classes: Set<string>; children: El[]; attrs: Map<string, string>; listeners: Map<string, (() => void)[]> };
    const grid = (tab.containerEl as unknown as El).children.find((c) => c.classes.has("cx-theme-cards"));
    expect(grid).toBeDefined();
    const cards = grid?.children ?? [];
    expect(cards.map((c) => c.attrs.get("data-theme-card"))).toEqual(["follow", "ink", "vesper", "lichen", "copper", "cobalt", "flint", "garnet", "paper"]);
    expect(cards.filter((c) => c.attrs.get("aria-checked") === "true").map((c) => c.attrs.get("data-theme-card"))).toEqual(["follow"]);
    cards.find((c) => c.attrs.get("data-theme-card") === "copper")?.listeners.get("click")?.[0]?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(hh.services.settings.value.appearance.stage).toBe("copper");
  });
});
