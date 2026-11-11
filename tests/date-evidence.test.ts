/**
 * GAPS-DATA: date seals (local blocks, public timestamp) and git first-seen dates (CORTEX-UX 5.14, 5.27),
 * from the store module through the runner command handlers to the entry reader.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandlers } from "../src/runner/commands";
import type { RunnerHost } from "../src/runner/host";
import { createCancelSource } from "../src/shared/cancel";
import { DEFAULT_SETTINGS, type CortexSettings } from "../src/shared/settings";
import type { RunnerContext } from "../src/shared/protocol/runner";
import { nullLogger } from "../src/shared/log";
import { NEVER_CANCELLED } from "../src/shared/cancel";
import type { EntryRecord } from "../src/shared/types";
import { sha256Text } from "../src/node/hash";
import { buildRecordIndex } from "../src/store/indexBuilder";
import { cacheLayout, openStoreContext } from "../src/store/layout";
import { createLedgerStore } from "../src/store/ledger";
import { createRecordReader } from "../src/store/recordReader";
import { IndexStore, decodePart } from "../src/shared/indexCodec";
import {
  blockHash,
  gitEvidenceFor,
  merkleRoot,
  publishSeals,
  readSealChain,
  resetSealCache,
  runDateEvidence,
  sealEvidenceFor,
  sealHostKey,
  sealLeaf,
  sealNewEntries,
  sealStatus,
  updateGitEvidence,
  type GitRun,
} from "../src/store/dateEvidence";
import { evidenceLine } from "../src/ui/reader/FactsGrid";
import { makeFmt } from "../src/ui/pages/PageFrame";

const dirs: string[] = [];
const tmp = (n: string): string => {
  const d = mkdtempSync(path.join(tmpdir(), `cx-de-${n}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => resetSealCache());

const B32 = "bcdefghijklmnopq";
const eId = (n: number): EntryRecord["id"] => `e_${"a".repeat(14)}${B32[Math.floor(n / 16)]}${B32[n % 16]}` as EntryRecord["id"];
const T0 = Date.UTC(2026, 10, 3, 14, 0, 0);
const SOH = String.fromCharCode(1);
const WRITTEN_NOTE = ["---", "cortex_id: e_aaaaaaaaaaaaaaab", "made_by: you", "created: 2026-11-03T14:00:00.000Z", "title: Hello", "---", "A note I wrote myself.", ""].join(String.fromCharCode(10));

function entry(n: number, extra: Record<string, unknown> = {}): EntryRecord {
  const text = `entry number ${n}`;
  const sha = sha256Text(text);
  return {
    v: 1, id: eId(n), kind: "message", source: "claude-code", sourceRef: { path: "x.jsonl", nativeId: `n${n}`, sha256: sha }, conv: "c_aaaaaaaaaaaaaaaa", idx: n, speaker: "you",
    text: { store: "stage", conv: "c_aaaaaaaaaaaaaaaa", line: n }, textSha256: sha, chars: text.length, words: 3, dates: [], existedBy: new Date(T0 + n * 60_000).toISOString(),
    addedAt: new Date(T0 + n * 60_000).toISOString(), writtenAt: new Date(T0 + n * 60_000).toISOString(), space: "roblox", folder: ["proj"], ...extra,
  } as unknown as EntryRecord;
}

async function world() {
  const vault = tmp("vault");
  const cache = tmp("cache");
  const ctx = await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
  return { vault, cache, ctx, ledger: createLedgerStore(ctx) };
}

describe("local date seals", () => {
  it("groups unsealed entries into linked blocks and seals only what is new", async () => {
    const w = await world();
    await w.ledger.append("entries", [entry(0), entry(1), entry(2)]);
    let clock = T0 + 10_000_000;
    const now = () => (clock += 1000);
    const r1 = await sealNewEntries(w.ctx, w.ledger, { now, maxBlock: 2, format: 1 });
    expect(r1).toEqual({ blocks: 2, entries: 3, total: 2 });
    const host = sealHostKey();
    const chain = await readSealChain(w.vault, host);
    expect(chain.broken).toBe(false);
    expect(chain.blocks.map((b) => [b.n, b.count])).toEqual([[1, 2], [2, 1]]);
    expect(chain.blocks[0]!.prev).toBe("");
    expect(chain.blocks[1]!.prev).toBe(chain.blocks[0]!.hash);
    expect(chain.blocks[0]!.root).toBe(merkleRoot([sealLeaf(eId(0), entry(0).textSha256), sealLeaf(eId(1), entry(1).textSha256)]));
    expect(blockHash(chain.blocks[1]!)).toBe(chain.blocks[1]!.hash);
    // nothing new: nothing written
    expect(await sealNewEntries(w.ctx, w.ledger, { now, format: 1 })).toEqual({ blocks: 0, entries: 0, total: 2 });
    await w.ledger.append("entries", [entry(3)]);
    expect(await sealNewEntries(w.ctx, w.ledger, { now, format: 1 })).toEqual({ blocks: 1, entries: 1, total: 3 });
    const st = await sealStatus(w.vault, host);
    expect(st).toMatchObject({ blocks: 3, entries: 4, intact: true });
    expect(st.lastAt).toBe(new Date(clock).toISOString());
    expect(await sealEvidenceFor(w.vault, eId(3))).toEqual({ sealed: { n: 3, at: new Date(clock).toISOString() } });
    expect((await sealEvidenceFor(w.vault, eId(0))).sealed?.n).toBe(1);
    expect(await sealEvidenceFor(w.vault, "e_zzzzzzzzzzzzzzzz")).toEqual({});
    // blocks sit in the vault's meta folder, which carries its nested .gitignore
    expect(existsSync(path.join(w.vault, ".vault-meta/cortex/.gitignore"))).toBe(true);
    expect(readdirSync(path.join(w.vault, ".vault-meta/cortex/seals", host))).toEqual(["000001.json", "000002.json", "000003.json"]);
  });

  it("a changed block breaks the chain: it is reported and new blocks are refused", async () => {
    const w = await world();
    await w.ledger.append("entries", [entry(0), entry(1)]);
    await sealNewEntries(w.ctx, w.ledger, { maxBlock: 1 });
    const host = sealHostKey();
    const f = path.join(w.vault, ".vault-meta/cortex/seals", host, "000001.json");
    const b = JSON.parse(readFileSync(f, "utf8"));
    b.at = "2020-01-01T00:00:00.000Z";
    writeFileSync(f, JSON.stringify(b));
    expect((await sealStatus(w.vault, host)).intact).toBe(false);
    await w.ledger.append("entries", [entry(2)]);
    await expect(sealNewEntries(w.ctx, w.ledger)).rejects.toMatchObject({ code: "E_IO" });
  });

  it("the earliest seal of any computer counts", async () => {
    const w = await world();
    await w.ledger.append("entries", [entry(0)]);
    await sealNewEntries(w.ctx, w.ledger, { host: "aaaaaaaa", now: () => T0 + 5_000_000 });
    // the other computer's block arrives through OneDrive: it holds the same entry, sealed earlier
    const a = JSON.parse(readFileSync(path.join(w.vault, ".vault-meta/cortex/seals/aaaaaaaa/000001.json"), "utf8"));
    const body = { n: 1, at: new Date(T0 + 1_000_000).toISOString(), prev: "", count: a.count, root: a.root };
    mkdirSync(path.join(w.vault, ".vault-meta/cortex/seals/bbbbbbbb"), { recursive: true });
    writeFileSync(path.join(w.vault, ".vault-meta/cortex/seals/bbbbbbbb/000001.json"), JSON.stringify({ v: 1, ...body, ids: a.ids, hash: blockHash(body) }));
    resetSealCache();
    expect((await sealEvidenceFor(w.vault, eId(0))).sealed).toEqual({ n: 1, at: new Date(T0 + 1_000_000).toISOString() });
  });

  it("the run after an import seals only when seals are on, and looks at the ledger only when it moved", async () => {
    const w = await world();
    await w.ledger.append("entries", [entry(0), entry(1)]);
    const off = await runDateEvidence(w.ctx, w.ledger, { seal: false, git: async () => null });
    expect(off.sealed).toBeNull();
    expect((await sealStatus(w.vault)).blocks).toBe(0);
    const on = await runDateEvidence(w.ctx, w.ledger, { seal: true, git: async () => null });
    expect(on.sealed).toMatchObject({ blocks: 1, entries: 2 });
    const again = await runDateEvidence(w.ctx, w.ledger, { seal: true, git: async () => null });
    expect(again.sealed).toBeNull();
    const forced = await runDateEvidence(w.ctx, w.ledger, { seal: true, force: true, git: async () => null });
    expect(forced.sealed).toMatchObject({ blocks: 0, entries: 0, total: 1 });
  });
});

describe("public timestamp of a seal", () => {
  it("version 1 blocks: sends only the block hash, keeps a valid .ots file, and covers the blocks up to it", async () => {
    const w = await world();
    await w.ledger.append("entries", [entry(0), entry(1)]);
    await sealNewEntries(w.ctx, w.ledger, { maxBlock: 1, now: () => T0 + 1_000_000, format: 1 });
    const host = sealHostKey();
    const head = (await readSealChain(w.vault, host)).blocks[1]!;
    const sent: { url: string; digest: Buffer }[] = [];
    const reply = Buffer.from("f010223344556677889908", "hex");
    const post = async (url: string, digest: Uint8Array) => {
      sent.push({ url, digest: Buffer.from(digest) });
      return reply;
    };
    const r = await publishSeals(w.ctx, { post, now: () => T0 + 2_000_000 });
    expect(r).toMatchObject({ n: 2, already: false, at: new Date(T0 + 2_000_000).toISOString() });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://alice.btc.calendar.opentimestamps.org/digest");
    expect(sent[0]!.digest.toString("hex")).toBe(head.hash);
    expect(sent[0]!.digest).toHaveLength(32);
    const ots = readFileSync(path.join(w.vault, ".vault-meta/cortex/seals", host, "public/000002.ots"));
    expect(ots.subarray(1, 15).toString("latin1")).toBe("OpenTimestamps");
    expect(ots.subarray(31, 33)).toEqual(Buffer.from([0x01, 0x08]));
    expect(ots.subarray(33, 65).toString("hex")).toBe(head.hash);
    expect(ots.subarray(65)).toEqual(reply);
    resetSealCache();
    for (const n of [0, 1]) expect(await sealEvidenceFor(w.vault, eId(n))).toMatchObject({ timestamped: { at: new Date(T0 + 2_000_000).toISOString() } });
    expect((await sealStatus(w.vault)).published).toEqual({ n: 2, at: new Date(T0 + 2_000_000).toISOString() });
    // asking again for the same block sends nothing
    const again = await publishSeals(w.ctx, { post });
    expect(again).toMatchObject({ n: 2, already: true });
    expect(sent).toHaveLength(1);
    // an entry sealed later is not covered until the next stamp
    await w.ledger.append("entries", [entry(2)]);
    await sealNewEntries(w.ctx, w.ledger, { format: 1 });
    resetSealCache();
    const later = await sealEvidenceFor(w.vault, eId(2));
    expect(later.sealed?.n).toBe(3);
    expect(later.timestamped).toBeUndefined();
  });

  it("refuses with nothing sealed, and a failing service leaves nothing behind", async () => {
    const w = await world();
    const post = async (): Promise<Uint8Array> => {
      throw new Error("offline");
    };
    await expect(publishSeals(w.ctx, { post })).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    await w.ledger.append("entries", [entry(0)]);
    await sealNewEntries(w.ctx, w.ledger);
    await expect(publishSeals(w.ctx, { post })).rejects.toThrow();
    expect(existsSync(path.join(w.vault, ".vault-meta/cortex/seals", sealHostKey(), "public"))).toBe(false);
    await expect(publishSeals(w.ctx, { post: async () => new Uint8Array(0) })).rejects.toMatchObject({ code: "E_PARSE" });
  });
});

describe("git first-seen", () => {
  function docEntry(n: number, rel: string, text: string): EntryRecord {
    return entry(n, { source: "files", sourceRef: { path: rel, sha256: sha256Text(text) } });
  }
  const raw = (oid: string, rel: string, when: string) => `${SOH}${when}\n\n:000000 100644 ${"0".repeat(40)} ${oid} A\t${rel}\n`;

  it("records the commit date of the current content of an imported vault file, and nothing for changed or untracked files", async () => {
    const w = await world();
    mkdirSync(path.join(w.vault, ".raw"), { recursive: true });
    writeFileSync(path.join(w.vault, ".raw/a.md"), "alpha");
    writeFileSync(path.join(w.vault, ".raw/b.md"), "bravo (changed after the import)");
    writeFileSync(path.join(w.vault, ".raw/c.md"), "charlie");
    await w.ledger.append("entries", [docEntry(0, ".raw/a.md", "alpha"), docEntry(1, ".raw/b.md", "bravo"), docEntry(2, ".raw/c.md", "charlie"), entry(3), entry(4, { source: "files", sourceRef: { path: "C:/outside/x.md", sha256: sha256Text("x") } })]);
    const calls: string[][] = [];
    const git: GitRun = async (args, _cwd, input) => {
      calls.push(args);
      if (args[0] === "hash-object") {
        // only the two files that still hold the imported bytes are asked about
        expect(input).toBe(".raw/a.md\n.raw/c.md\n");
        return `${"1".repeat(40)}\n${"3".repeat(40)}\n`;
      }
      return raw("9".repeat(40), ".raw/other.md", "2026-10-07T09:00:00+00:00") + raw("1".repeat(40), ".raw/a.md", "2026-10-08T10:30:00+02:00");
    };
    const r = await updateGitEvidence(w.ctx, w.ledger, { git, now: () => T0 });
    expect(r).toEqual({ checked: 2, found: 1 });
    expect(await gitEvidenceFor(w.cache, docEntry(0, ".raw/a.md", "alpha"))).toBe("2026-10-08T08:30:00.000Z");
    expect(await gitEvidenceFor(w.cache, docEntry(2, ".raw/c.md", "charlie"))).toBeUndefined();
    expect(await gitEvidenceFor(w.cache, docEntry(1, ".raw/b.md", "bravo"))).toBeUndefined();
    expect(await gitEvidenceFor(w.cache, entry(3))).toBeUndefined();
    // an older version of the file (other hash) is not vouched for by the newer one
    expect(await gitEvidenceFor(w.cache, docEntry(5, ".raw/a.md", "alpha v0"))).toBeUndefined();
    // looked at once: neither the found nor the not-yet-committed file is asked again within six hours
    calls.length = 0;
    expect(await updateGitEvidence(w.ctx, w.ledger, { git, now: () => T0 + 3600_000 })).toEqual({ checked: 0, found: 0 });
    expect(calls).toHaveLength(0);
    // the uncommitted file is looked at again later
    const later: GitRun = async (args) => (args[0] === "hash-object" ? `${"3".repeat(40)}\n` : raw("3".repeat(40), ".raw/c.md", "2026-11-04T10:00:00+00:00"));
    expect(await updateGitEvidence(w.ctx, w.ledger, { git: later, now: () => T0 + 7 * 3600_000 })).toEqual({ checked: 1, found: 1 });
    expect(await gitEvidenceFor(w.cache, docEntry(2, ".raw/c.md", "charlie"))).toBe("2026-11-04T10:00:00.000Z");
  });

  it("a vault outside git is noticed once and not asked again for a while", async () => {
    const w = await world();
    writeFileSync(path.join(w.vault, "n.md"), "note");
    await w.ledger.append("entries", [entry(0, { source: "obsidian", sourceRef: { path: "n.md", sha256: sha256Text("note") } })]);
    let n = 0;
    const git: GitRun = async () => {
      n++;
      return null;
    };
    expect(await updateGitEvidence(w.ctx, w.ledger, { git, now: () => T0 })).toEqual({ checked: 0, found: 0 });
    expect(await updateGitEvidence(w.ctx, w.ledger, { git, now: () => T0 + 1000 })).toEqual({ checked: 0, found: 0 });
    expect(n).toBe(1);
  });

  const hasGit = (() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasGit)("works against a real repository, using the commit that introduced the current bytes", async () => {
    const w = await world();
    const nowhere = path.join(w.vault, "none");
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test", GIT_CONFIG_GLOBAL: nowhere, GIT_CONFIG_SYSTEM: nowhere };
    const git = (args: string[], at?: string) => execFileSync("git", args, { cwd: w.vault, env: at ? { ...env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : env, stdio: "ignore" });
    git(["init", "-q"]);
    git(["config", "core.autocrlf", "false"]);
    mkdirSync(path.join(w.vault, "docs"), { recursive: true });
    writeFileSync(path.join(w.vault, "docs/one.md"), "first text\n");
    git(["add", "docs/one.md"]);
    git(["commit", "-q", "-m", "one"], "2026-09-01T08:00:00Z");
    writeFileSync(path.join(w.vault, "docs/one.md"), "second text\n");
    git(["commit", "-qam", "two"], "2026-09-15T08:00:00Z");
    const sha = sha256Text("second text\n");
    await w.ledger.append("entries", [entry(0, { source: "files", sourceRef: { path: "docs/one.md", sha256: sha } })]);
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = nowhere;
    try {
      expect(await updateGitEvidence(w.ctx, w.ledger)).toEqual({ checked: 1, found: 1 });
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    }
    // the date the CURRENT bytes were committed, not the file's first commit
    expect(await gitEvidenceFor(w.cache, entry(0, { sourceRef: { path: "docs/one.md", sha256: sha } }))).toBe("2026-09-15T08:00:00.000Z");
  });
});

describe("the entry reader shows the evidence", () => {
  it("lists a git commit, a local seal and a public timestamp with the spec's lines", async () => {
    const w = await world();
    writeFileSync(path.join(w.vault, "n.md"), "note text");
    const rec = entry(0, { source: "obsidian", sourceRef: { path: "n.md", sha256: sha256Text("note text") } });
    await w.ledger.append("entries", [rec, entry(1)]);
    await runDateEvidence(w.ctx, w.ledger, {
      seal: true,
      now: () => T0 + 9_000_000,
      git: async (args) => (args[0] === "hash-object" ? `${"5".repeat(40)}\n` : `${SOH}2026-10-07T09:00:00+00:00\n\n:000000 100644 ${"0".repeat(40)} ${"5".repeat(40)} A\tn.md\n`),
    });
    await publishSeals(w.ctx, { post: async () => Buffer.from("ff", "hex"), now: () => T0 + 9_500_000 });
    await buildRecordIndex({ store: w.ctx, ledger: w.ledger, token: NEVER_CANCELLED, progress: () => undefined, yield: async () => undefined }, { full: false });
    const buf = readFileSync(cacheLayout(w.cache).recordIndex);
    const part = decodePart(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    const snap = IndexStore.fromParts([part], { part: "merged" }).snapshot();
    const reader = createRecordReader({ vaultRoot: w.vault, cacheDir: w.cache, index: () => snap, log: nullLogger });
    const ordinal = [0, 1].find((o) => snap.ids.get(o) === rec.id) as number;
    const detail = await reader.entry(ordinal);
    expect(detail).toBeTruthy();
    const kinds = detail!.dateEvidence.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["imported", "git", "sealed", "timestamped"]));
    const sealed = detail!.dateEvidence.find((e) => e.kind === "sealed")!;
    expect(sealed).toMatchObject({ block: 1, strength: "provable" });
    const fmt = makeFmt("d MMM yyyy", 1, T0);
    expect(evidenceLine(sealed, "obsidian", fmt)).toBe("Sealed on this computer in block 1 · provable bound");
    expect(evidenceLine(detail!.dateEvidence.find((e) => e.kind === "git")!, "obsidian", fmt)).toMatch(/^Committed to git .+ · upper bound$/);
    expect(evidenceLine(detail!.dateEvidence.find((e) => e.kind === "timestamped")!, "obsidian", fmt)).toMatch(/^Timestamped publicly on .+ · provable bound$/);
    // the entry without a file in the vault gets seal evidence but no git line
    const plain = await reader.entry([0, 1].find((o) => snap.ids.get(o) !== rec.id) as number);
    expect(plain!.dateEvidence.map((e) => e.kind)).toEqual(expect.arrayContaining(["sealed", "timestamped"]));
    expect(plain!.dateEvidence.map((e) => e.kind)).not.toContain("git");
  });
});

describe("runner commands seals.run, seals.status, seals.publish", () => {
  afterEach(() => vi.unstubAllGlobals());

  function rcFor(w: { vault: string; cache: string }, sealLocally: boolean) {
    const settings: CortexSettings = structuredClone(DEFAULT_SETTINGS);
    settings.advanced.dateSeals.sealLocally = sealLocally;
    const ctx: RunnerContext = { vaultRoot: w.vault, vaultKey: "abcdefghijklmnop", cacheDir: w.cache, settings, pluginVersion: "t", settingsSource: "plugin" };
    return { id: "x", ctx, token: createCancelSource().token, host: { mode: "child", emit: () => undefined, log: nullLogger, yield: async () => undefined } as RunnerHost, progress: () => undefined, event: () => undefined };
  }

  it("seals when the setting is on, reports status, and sends a fingerprint only when asked", async () => {
    const w = await world();
    await w.ledger.append("entries", [entry(0), entry(1)]);
    const h = createHandlers();
    // off: nothing sealed, and a public timestamp has nothing to stand on
    expect(await h["seals.run"]({ force: true }, rcFor(w, false))).toMatchObject({ blocks: 0, entries: 0, total: 0 });
    await expect(h["seals.publish"]({}, rcFor(w, false))).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    const on = rcFor(w, true);
    expect(await h["seals.run"]({ force: true }, on)).toMatchObject({ blocks: 1, entries: 2, total: 1 });
    const st = await h["seals.status"]({}, on);
    expect(st).toMatchObject({ blocks: 1, entries: 2, intact: true });
    expect(st.published).toBeUndefined();
    // the request goes to the calendar with the 32-byte digest and nothing else
    const calls: { url: string; init: { method?: string; body?: unknown } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { method?: string; body?: unknown }) => {
      calls.push({ url, init });
      return new Response(new Uint8Array([0xf0, 0x01, 0x02]), { status: 200 });
    });
    const pub = await h["seals.publish"]({}, on);
    expect(pub).toMatchObject({ n: 1, already: false, calendar: "https://alice.btc.calendar.opentimestamps.org" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://alice.btc.calendar.opentimestamps.org/digest");
    expect(calls[0]!.init.method).toBe("POST");
    expect(((await new Response(calls[0]!.init.body as Blob).arrayBuffer()).byteLength)).toBe(32);
    expect((await h["seals.status"]({}, on)).published).toMatchObject({ n: 1 });
    expect(await h["seals.publish"]({}, on)).toMatchObject({ already: true });
    expect(calls).toHaveLength(1);
  });

  it("a service error or an unreachable service fails the action and writes nothing", async () => {
    const w = await world();
    await w.ledger.append("entries", [entry(0)]);
    const h = createHandlers();
    const on = rcFor(w, true);
    await h["seals.run"]({ force: true }, on);
    vi.stubGlobal("fetch", async () => new Response("no", { status: 503 }));
    await expect(h["seals.publish"]({}, on)).rejects.toMatchObject({ code: "E_IO" });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(h["seals.publish"]({}, on)).rejects.toMatchObject({ code: "E_IO" });
    expect((await h["seals.status"]({}, on)).published).toBeUndefined();
  });

  it("an import that adds entries ends with the date evidence pass, sealing them when the setting is on", async () => {
    const w = await world();
    const dir = path.join(w.vault, ".raw/written/2026/11");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "20261103-1400-hello.md"), WRITTEN_NOTE);
    const h = createHandlers();
    const res = await h.import({ sources: [{ kind: "written" }] }, rcFor(w, true));
    expect(res.entriesAdded).toBe(1);
    expect(await sealStatus(w.vault)).toMatchObject({ blocks: 1, entries: 1, intact: true });
    // seals off: the same kind of import seals nothing
    const w2 = await world();
    const dir2 = path.join(w2.vault, ".raw/written/2026/11");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(path.join(dir2, "20261103-1400-hello.md"), WRITTEN_NOTE);
    expect((await h.import({ sources: [{ kind: "written" }] }, rcFor(w2, false))).entriesAdded).toBe(1);
    expect((await sealStatus(w2.vault)).blocks).toBe(0);
  });
});
