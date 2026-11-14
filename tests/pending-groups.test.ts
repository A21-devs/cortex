/**
 * "865 items waiting" says what they are: the planner's pending targets in groups (the vault's notes by top folder with
 * the biggest subfolders inside, wiki notes by area, chats, chat summaries, area maps), and the Agents page names the
 * main groups one line each and sums up all the others in one line.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Engine } from "../src/agents/engine";
import type { EntryLite } from "../src/agents/jobs";
import { groupTargets } from "../src/agents/pendingGroups";
import { AgentScheduler } from "../src/agents/scheduler";
import { createCancelSource } from "../src/shared/cancel";
import { nullLogger } from "../src/shared/log";
import type { PendingGroup } from "../src/shared/protocol/runner";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import type { ConversationRecord } from "../src/shared/types";
import { createLedgerStore } from "../src/store/ledger";
import { openStoreContext } from "../src/store/layout";
import { waitingWhat } from "../src/ui/pages/Agents";

const note = (id: string, folder: string[]): EntryLite => ({ id, folder } as unknown as EntryLite);

function catalogue(): { entries: Map<string, EntryLite>; conversations: Map<string, ConversationRecord> } {
  const entries = new Map<string, EntryLite>();
  let i = 0;
  const put = (n: number, folder: string[]) => {
    for (let k = 0; k < n; k++) {
      const id = `e_${String(i++).padStart(16, "a")}`;
      entries.set(id, note(id, folder));
    }
  };
  put(130, ["Game Notes V2", "03 Animation"]);
  put(41, ["Game Notes V2", "04 Gameplay"]);
  put(40, ["Game Notes V2", "05 Lighting and Sound"]);
  put(20, ["Game Notes V2"]);
  put(11, ["Vault"]);
  put(10, ["docs", "audits"]);
  put(1, ["Animations"]);
  const conversations = new Map<string, ConversationRecord>([["c_aaaaaaaaaaaaaaaa", { id: "c_aaaaaaaaaaaaaaaa" } as unknown as ConversationRecord]]);
  return { entries, conversations };
}

describe("pending groups", () => {
  it("groups the vault's notes by top folder with the biggest subfolders inside, and the other work by kind", () => {
    const data = catalogue();
    const label = [...data.entries.keys(), "c_aaaaaaaaaaaaaaaa", "w_aaaaaaaaaaaaaaaa", "w_bbbbbbbbbbbbbbbb", "e_zzzzzzzzzzzzzzzz"];
    const groups = groupTargets({ label, gist: ["c_aaaaaaaaaaaaaaaa", "c_bbbbbbbbbbbbbbbb"], hub: ["code"] }, data, [
      { id: "w_aaaaaaaaaaaaaaaa", space: "ai" },
      { id: "w_bbbbbbbbbbbbbbbb", space: "ai" },
    ]);
    expect(groups[0]).toEqual({ what: "notes", where: "Game Notes V2", n: 231, inside: ["03 Animation", "04 Gameplay"], insideTotal: 3 });
    expect(groups.slice(1)).toEqual([
      { what: "notes", where: "Vault", n: 11 },
      { what: "notes", where: "docs", n: 10, inside: ["audits"], insideTotal: 1 },
      { what: "summaries", n: 2 },
      { what: "wiki", where: "AI", n: 2 },
      { what: "chats", n: 1 },
      { what: "maps", n: 1 },
      { what: "notes", where: "Animations", n: 1 },
      { what: "other", n: 1 },
    ]);
    // Every target is in exactly one group, so the groups add up to the number the status shows.
    expect(groups.reduce((s, g) => s + g.n, 0)).toBe(label.length + 3);
  });

  it("has nothing to say when nothing waits", () => {
    expect(groupTargets({}, { entries: new Map(), conversations: new Map() })).toEqual([]);
    expect(waitingWhat([])).toEqual({ main: [] });
  });
});

describe("what is waiting, short", () => {
  it("names the main groups one line each, then sums up all the others in one line", () => {
    const groups: PendingGroup[] = [
      { what: "notes", where: "Game Notes V2", n: 840, inside: ["03 Animation", "04 Gameplay"], insideTotal: 53 },
      { what: "notes", where: "Vault", n: 11 },
      { what: "notes", where: "docs", n: 10 },
      { what: "summaries", n: 1 },
      { what: "maps", n: 1 },
      { what: "chats", n: 1 },
      { what: "notes", where: "Animations", n: 1 },
    ];
    expect(waitingWhat(groups)).toEqual({
      main: ["840 notes to organise in Game Notes V2 (03 Animation, 04 Gameplay…)"],
      rest: "The other 25: 22 notes in Vault, docs and Animations, 1 chat, 1 chat summary and 1 area map.",
    });
  });

  it("names up to three groups that each hold a tenth of the work, and counts folders past two", () => {
    const groups: PendingGroup[] = [
      { what: "notes", where: "Projects", n: 300, inside: ["Games"], insideTotal: 1 },
      { what: "summaries", n: 250 },
      { what: "notes", where: "Areas", n: 150 },
      { what: "notes", where: "Inbox", n: 100 },
      { what: "notes", where: "Daily", n: 30 },
      { what: "notes", where: "Clippings", n: 20 },
      { what: "wiki", where: "Code", n: 1_500 },
    ];
    const w = waitingWhat(groups);
    expect(w.main).toEqual(["1,500 Code wiki notes to organise", "300 notes to organise in Projects (Games)", "250 chat summaries to write"]);
    expect(w.rest).toBe("The other 300: 300 notes in Areas, Inbox and 2 other folders.");
  });

  it("says one of a kind in the singular, and leaves a group under a tenth of the work to the one-line rest", () => {
    expect(waitingWhat([{ what: "summaries", n: 1 }])).toEqual({ main: ["1 chat summary to write"] });
    expect(waitingWhat([{ what: "chats", n: 50 }, { what: "notes", where: "docs", n: 1 }])).toEqual({ main: ["50 chats to organise"], rest: "The other 1: 1 note in docs." });
    expect(waitingWhat([{ what: "chats", n: 5 }, { what: "notes", where: "docs", n: 1 }]).main).toEqual(["5 chats to organise", "1 note to organise in docs"]);
  });
});

describe("the agents status carries the groups", () => {
  it("describes the same targets it counts, and leaves the groups out for a stand-in that cannot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cortex-pending-"));
    const vault = path.join(root, "vault");
    await mkdir(path.join(vault, ".obsidian"), { recursive: true });
    const cacheDir = path.join(root, "cortex", "abcdefghijklmnop");
    await mkdir(cacheDir, { recursive: true });
    const store = await openStoreContext({ vaultRoot: vault, cacheDir, owner: "test", log: nullLogger });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.general.firstRunDone = true;
    const engine: Engine = {
      kind: "fake",
      where: "this computer",
      paidBy: "none",
      probe: async () => ({ ok: true, version: "2.1.319 (Claude Code)", flags: {}, missingMandatory: [], detail: "ready" }),
      run: async () => ({ ok: false, error: { code: "E_INTERNAL", message: "never called", retryable: false }, durationMs: 0, started: false }),
    };
    const plan = (job: "label" | "gist", targets: string[]) => ({ job, targets, model: "haiku", estimateTokens: 100, priority: 1 });
    const seen: Record<string, readonly string[]>[] = [];
    const base = {
      store,
      ledger: createLedgerStore(store),
      settings,
      engine,
      liveCheck: null,
      token: createCancelSource().token,
      log: nullLogger,
      emit: () => undefined,
      now: () => Date.now(),
      mode: "child" as const,
      origin: "plugin" as const,
      settingsSource: "plugin" as const,
      pluginVersion: "test",
    };
    const selectTargets = async (job: string) => (job === "label" ? [plan("label", ["e_aaaaaaaaaaaaaaaa", "e_bbbbbbbbbbbbbbbb"])] : job === "gist" ? [plan("gist", ["c_aaaaaaaaaaaaaaaa"])] : []);
    const runJob = async () => {
      throw new Error("never called");
    };
    const sch = new AgentScheduler({
      ...base,
      jobs: {
        selectTargets,
        runJob,
        describePending: async (byJob) => {
          seen.push(byJob as Record<string, readonly string[]>);
          return [{ what: "notes", where: "docs", n: 2 }, { what: "summaries", n: 1 }];
        },
      },
    });
    const status = await sch.status();
    expect(status.pending).toMatchObject({ label: 2, gist: 1, hub: 0 });
    expect(seen).toEqual([{ label: ["e_aaaaaaaaaaaaaaaa", "e_bbbbbbbbbbbbbbbb"], gist: ["c_aaaaaaaaaaaaaaaa"], hub: [] }]);
    expect(status.groups).toEqual([{ what: "notes", where: "docs", n: 2 }, { what: "summaries", n: 1 }]);
    const plain = new AgentScheduler({ ...base, jobs: { selectTargets, runJob } });
    expect((await plain.status()).groups).toBeUndefined();
  }, 30_000);
});
