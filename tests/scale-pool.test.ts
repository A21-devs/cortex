/** Scale fixes: bounded concurrency helpers, the throttled state save, and the batched git pass (see docs/ARCHITECTURE.md section 23). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mapLimit, readAhead } from "../src/node/pool";
import { DOC_STATE_SAVE_MS, saveDocState, saveDocStateSoon, walkFiles, type ImportContext } from "../src/importers/common";
import { openStoreContext } from "../src/store/layout";
import { createLedgerStore } from "../src/store/ledger";
import { runDateEvidence, updateGitEvidence, type GitRun } from "../src/store/dateEvidence";
import { nullLogger } from "../src/shared/log";
import { sha256Text } from "../src/node/hash";
import type { EntryRecord } from "../src/shared/types";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(path.join(tmpdir(), "cortex-scale-unit-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function* numbers(n: number): AsyncGenerator<number> {
  for (let i = 0; i < n; i++) yield i;
}

describe("node/pool", () => {
  it("mapLimit keeps the order of the input and never runs more than `limit` at once", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([...Array(40).keys()], 5, async (i) => {
      running++;
      peak = Math.max(peak, running);
      await sleep(i % 3);
      running--;
      return i * 2;
    });
    expect(out).toEqual([...Array(40).keys()].map((i) => i * 2));
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
    expect(await mapLimit([], 4, async (x) => x)).toEqual([]);
  });

  it("readAhead yields in order, starts reads ahead but only `limit` of them, and captures errors", async () => {
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const got: { item: number; wanted: boolean; result?: number; error?: unknown }[] = [];
    for await (const a of readAhead(numbers(30), { limit: 6, wanted: (n) => n % 10 !== 5 }, async (n) => {
      started.push(n);
      running++;
      peak = Math.max(peak, running);
      await sleep(2);
      running--;
      if (n === 7) throw new Error("boom");
      return n + 100;
    })) {
      got.push(a);
    }
    expect(got.map((g) => g.item)).toEqual([...Array(30).keys()]);
    expect(got.filter((g) => !g.wanted).map((g) => g.item)).toEqual([5, 15, 25]);
    expect(started).not.toContain(5);
    expect(got[7]?.error).toBeInstanceOf(Error);
    expect(got[8]?.result).toBe(108);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
  });

  it("readAhead reads big items only when the loop reaches them, and stops cleanly when the consumer stops", async () => {
    const started: number[] = [];
    const seen: number[] = [];
    const gen = readAhead(numbers(20), { limit: 8, wanted: () => true, eager: (n) => n !== 3 }, async (n) => {
      started.push(n);
      return n;
    });
    for await (const a of gen) {
      seen.push(a.item);
      if (a.item === 2) {
        // 3 is "big": not started while it waited in the window
        expect(started).not.toContain(3);
        expect(started.length).toBeLessThanOrEqual(9);
      }
      if (a.item === 4) break;
    }
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(started).toContain(3);
    expect(started.length).toBeLessThanOrEqual(13);
  });
});

describe("walkFiles", () => {
  it("lists the files of a folder in name order with their sizes, after stat-ing them in batches", async () => {
    const root = tmp();
    mkdirSync(path.join(root, "sub"), { recursive: true });
    const names: string[] = [];
    for (let i = 0; i < 70; i++) {
      const n = `f-${String(i).padStart(3, "0")}.md`;
      names.push(n);
      writeFileSync(path.join(root, n), "x".repeat(i + 1));
    }
    writeFileSync(path.join(root, "sub", "inner.md"), "abc");
    const seen: { rel: string; size: number }[] = [];
    for await (const f of walkFiles(root, "", () => false)) seen.push({ rel: f.rel, size: f.size });
    expect(seen.map((s) => s.rel)).toEqual([...names, "sub/inner.md"]);
    expect(seen[69]?.size).toBe(70);
  });
});

async function fakeCtx(now: { t: number }): Promise<{ ctx: ImportContext }> {
  const store = await openStoreContext({ vaultRoot: tmp(), cacheDir: tmp(), owner: "test", log: nullLogger });
  return { ctx: { store, now: () => now.t, dryRun: false } as unknown as ImportContext };
}

describe("document state saves", () => {
  it("saveDocStateSoon writes at most once per interval during a pass; saveDocState (the end of the pass) always writes", async () => {
    const now = { t: 1_000_000 };
    const { ctx } = await fakeCtx(now);
    const state = { v: 1 as const, files: {} };
    expect(await saveDocStateSoon(ctx, "t", state)).toBe(true); // first save of the pass
    expect(await saveDocStateSoon(ctx, "t", state)).toBe(false);
    now.t += DOC_STATE_SAVE_MS - 1;
    expect(await saveDocStateSoon(ctx, "t", state)).toBe(false);
    now.t += 2;
    expect(await saveDocStateSoon(ctx, "t", state)).toBe(true);
    // another state file has its own clock
    expect(await saveDocStateSoon(ctx, "u", state)).toBe(true);
    await saveDocState(ctx, "t", state);
    expect(await saveDocStateSoon(ctx, "t", state)).toBe(false);
  });
});

function docEntry(i: number): EntryRecord {
  const text = `note ${i}`;
  return {
    id: `e_${String(i).padStart(16, "0")}`,
    seq: 0,
    source: "obsidian",
    kind: "document",
    speaker: "you",
    addedAt: "2026-01-01T00:00:00.000Z",
    dates: [{ type: "ingest", strength: "bound", at: "2026-01-01T00:00:00.000Z" }],
    text: { store: "segment", seg: "x", line: 0 },
    textSha256: sha256Text(text),
    sourceRef: { path: `notes/n-${i}.md`, nativeId: `note:notes/n-${i}.md`, sha256: sha256Text(text) },
    space: "vault",
    folder: ["notes"],
  } as unknown as EntryRecord;
}

describe("git first-seen pass", () => {
  it("asks git a fixed number of times however many files there are (never one process per file)", async () => {
    const vault = tmp();
    const cache = tmp();
    mkdirSync(path.join(vault, "notes"), { recursive: true });
    const N = 400;
    const entries: EntryRecord[] = [];
    for (let i = 0; i < N; i++) {
      writeFileSync(path.join(vault, "notes", `n-${i}.md`), `note ${i}`);
      entries.push(docEntry(i));
    }
    const ctx = await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
    const ledger = createLedgerStore(ctx);
    await ledger.append("entries", entries);
    const calls: string[][] = [];
    const git: GitRun = async (args, _cwd, input) => {
      calls.push(args);
      if (args[0] === "hash-object") {
        return (input ?? "")
          .split("\n")
          .filter((l) => l !== "")
          .map((_, i) => `oid${i}`)
          .join("\n");
      }
      return ""; // an empty log: no commit has the files
    };
    const r = await updateGitEvidence(ctx, ledger, { git });
    expect(r.checked).toBe(N);
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(calls.map((c) => (c[0] === "hash-object" ? "hash-object" : "log"))).toEqual(["hash-object", "log"]);
  });

  it("skipGit leaves the git pass (and its cursor) for a later run", async () => {
    const vault = tmp();
    const cache = tmp();
    mkdirSync(path.join(vault, "notes"), { recursive: true });
    writeFileSync(path.join(vault, "notes", "n-0.md"), "note 0");
    const ctx = await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
    const ledger = createLedgerStore(ctx);
    await ledger.append("entries", [docEntry(0)]);
    const calls: string[][] = [];
    const git: GitRun = async (args) => {
      calls.push(args);
      return args[0] === "hash-object" ? "oid0" : "";
    };
    expect((await runDateEvidence(ctx, ledger, { seal: false, skipGit: true, git })).git).toBeNull();
    expect(calls).toEqual([]);
    expect((await runDateEvidence(ctx, ledger, { seal: false, git })).git).toMatchObject({ checked: 1 });
    expect(calls.length).toBe(2);
  });
});
