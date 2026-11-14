/**
 * The store (owner E2): layout paths, size-rolled ledger shards (LEDGER-SHARD-SIZE), immutable segments with
 * numbers taken from the folder (SEGMENT-SEQ-DEADLOCK), byte-range text refs verified by sha (INPLACE-TEXTREF),
 * the control file failing closed, the budget's reserve/settle (BUDGET-RESERVE), and the derived-note templates:
 * CORTEX-UX §5.15's summary format with every model string inert (SAFE-01) and conflict hashing
 * (DERIVED-NOTE-SHA). Everything runs in the OS temp folder.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyBudget, reserve, settle } from "../src/agents/budget";
import { nullLogger } from "../src/shared/log";
import { injectionSignals, mdInert } from "../src/shared/mdSafe";
import type { GistDoc } from "../src/shared/notesDoc";
import type { ConversationRecord, CorrectionRecord, EntryRecord, LabelRecord, ReadRecord, ReceiptRecord, ReviewCardRecord, RunRecord, SegmentLine } from "../src/shared/types";
import { openControlGate, readControl, writeControl } from "../src/store/control";
import { cursorPlan, loadCursors, saveCursors } from "../src/store/cursors";
import { createLedgerStore } from "../src/store/ledger";
import { createLedgerReader } from "../src/store/ledgerReader";
import { createRecordReader } from "../src/store/recordReader";
import { loadSourceManifest, updateSourceManifest } from "../src/store/manifest";
import { readSignal, SIGNAL_KINDS, signalChanges, writeSignal } from "../src/store/signal";
import { dueForSeal, listStaged, sealStage, stageLookup, stageMessages, type StagedMessage } from "../src/store/stage";
import { cacheLayout, gistNotePath, ledgerShardPath, mapNotePath, openStoreContext, segmentPath, SHARD_ROLL_BYTES, writtenEntryPath } from "../src/store/layout";
import { mergeForeignFrontmatter, ownedHash, renderGistMarkdown, renderHubMarkdown, shortDay, splitFrontmatter } from "../src/store/notesWriter";
import { holdSecrets, nextSegmentSeq, readHeld, readText, writeSegment } from "../src/store/segments";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "cortex-store-"));
const CONV = "c_aaaaaaaaaaaaaaaa" as const;

describe("store/layout", () => {
  it("keeps paths short and inside the Cortex roots", () => {
    expect(segmentPath("claude-code", "2026-11", CONV, 3)).toBe(".raw/chats/claude-code/2026-11/c_aaaaaaaaaaaaaaaa/0003.jsonl.gz");
    expect(ledgerShardPath("entries", "2026-11", 2)).toMatch(/^\.vault-meta\/cortex\/entries\/2026-11\/0+2\.jsonl$/);
    expect(gistNotePath(2026, CONV, "Locking slots while trades confirm")).toMatch(/^wiki\/derived\/gists\/2026\//);
    expect(mapNotePath("project", "Roblox inventory")).toMatch(/^wiki\/derived\/maps\/project\//);
    expect(writtenEntryPath(new Date(2026, 10, 9, 14, 5), "A thought")).toMatch(/^\.raw\/written\/2026\/11\/20261109-1405-a-thought\.md$/);
    expect(cacheLayout("C:/cache").locks).toContain("locks");
    expect(SHARD_ROLL_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe("store/segments", () => {
  it("numbers segments from the folder and never replaces one", async () => {
    const vault = await tmp();
    const ctx = await openStoreContext({ vaultRoot: vault, cacheDir: await tmp(), owner: "test", log: nullLogger });
    const line = (i: number): SegmentLine => ({ v: 1, id: `e_${"a".repeat(15)}${"bcdefg"[i] ?? "h"}` as SegmentLine["id"], nid: `n${i}`, conv: CONV, i, sp: "you", text: `message ${i}`, sha: createHash("sha256").update(`message ${i}`).digest("hex") } as unknown as SegmentLine);
    const a = await writeSegment(ctx, { source: "claude-code", monthKey: "2026-11", conv: CONV, lines: [line(0)] });
    const b = await writeSegment(ctx, { source: "claude-code", monthKey: "2026-11", conv: CONV, lines: [line(1)] });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(await nextSegmentSeq(vault, path.posix.dirname(b.path) as never)).toBe(3);
    const r = await readText(vault, { store: "segment", seg: b.path, line: 0 }, "");
    expect(r).toEqual({ ok: true, text: "message 1" });
  });
  it("verifies byte-range file refs by sha and reports changes at source", async () => {
    const vault = await tmp();
    await mkdir(path.join(vault, ".raw", "docs"), { recursive: true });
    const text = "intro\nThe passage é\nrest";
    await writeFile(path.join(vault, ".raw", "docs", "a.md"), text);
    const start = Buffer.byteLength("intro\n");
    const end = start + Buffer.byteLength("The passage é");
    const sha = createHash("sha256").update(Buffer.from(text).subarray(start, end)).digest("hex");
    const ref = { store: "file" as const, path: ".raw/docs/a.md" as never, byteStart: start, byteEnd: end };
    expect(await readText(vault, ref, sha)).toEqual({ ok: true, text: "The passage é" });
    await writeFile(path.join(vault, ".raw", "docs", "a.md"), text.replace("passage", "pasSage"));
    expect(await readText(vault, ref, sha)).toEqual({ ok: false, reason: "changed-at-source" });
    expect(await readText(vault, { ...ref, path: ".raw/docs/missing.md" as never }, sha)).toEqual({ ok: false, reason: "missing" });
  });
});

describe("store/control (fail closed)", () => {
  it("treats an unreadable control file as paused", async () => {
    const vault = await tmp();
    await mkdir(path.join(vault, ".vault-meta", "cortex", "state"), { recursive: true });
    await writeFile(path.join(vault, ".vault-meta", "cortex", "state", "control.json"), "{not json");
    expect((await readControl({ vaultRoot: vault })).paused).toBe(true);
  });
});

describe("agents/budget (BUDGET-RESERVE)", () => {
  it("reserves before a call and settles to the real usage", () => {
    const day = "2026-11-09";
    let s = emptyBudget(day);
    const caps = { fiveHour: 70, weekly: 70 };
    const r1 = reserve(s, caps, "a", 600, day);
    expect(r1.decision.ok).toBe(true);
    s = r1.state;
    expect(reserve(s, caps, "b", 600, day).decision.ok).toBe(true); // reservations only account for calls in flight; they are not a limit
    expect(s.today.reserved).toBe(600);
    s = settle(s, "a", { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } as never, true, day);
    expect(s.today.reserved).toBe(0);
    expect(s.today.tokens).toBe(150);
    const now = Date.parse("2026-11-09T12:00:00Z");
    const held = { ...s, plan: { weekly: { pct: 80, resetsAt: now + 1000, seenAt: now } } };
    expect(reserve(held, caps, "c", 600, day, now).decision.ok).toBe(false);
    expect(reserve(held, { fiveHour: 70, weekly: null }, "c", 600, day, now).decision.ok).toBe(true);
  });
});

const madeBy = { runId: "r_aaaaaaaaaaaaaaaa", model: "claude-sonnet-5-5", engine: "claude-cli", at: "2026-11-04T10:00:00.000Z" } as GistDoc["madeBy"];
const doc = (text: string, gist = "You traced item duplication to two trades resolving in the same frame."): GistDoc => ({
  id: "n_aaaaaaaaaaaaaaaa" as GistDoc["id"],
  conv: CONV,
  title: "Inventory",
  space: "roblox",
  madeBy,
  gist,
  facets: { work: "debug", outcome: "shipped", project: "roblox-inventory", topics: ["trading", "inventory"] },
  parts: [
    {
      n: 1,
      title: "Reproducing the duplication",
      startedAt: "2026-11-03T14:05:00.000Z",
      endedAt: "2026-11-03T14:40:00.000Z",
      msgFrom: 1,
      msgTo: 38,
      notes: [{ id: "n_bbbbbbbbbbbbbbbb" as GistDoc["id"], kind: "question", text, blockId: "n-4f2a", cites: [{ entryId: "e_q3k2v7m4c5x2a7pd" as never, version: 1, quote: "why do items dup", speaker: "you", date: "2026-11-03T14:06:00.000Z" }] }],
    },
  ],
  addressedComments: [],
});

describe("store/notesWriter (CORTEX-UX §5.15, SAFE-01)", () => {
  it("writes the summary template: facets in frontmatter, machine callout, timeline, block refs, footnote links", () => {
    const md = renderGistMarkdown(doc("Why do items duplicate in trades?"), "wiki/derived/gists/2026/x.md" as never, { timeZone: "UTC" }).markdown;
    expect(md).toContain("cortex_kind: summary");
    expect(md).toContain("cortex_project: roblox-inventory");
    expect(md).toContain("cortex_topics: [trading, inventory]");
    expect(md).toContain("> [!cortex-machine] Machine summary · claude-sonnet-5-5 · run r_aaaaaaaaaaaaaaaa");
    expect(md).toContain("## Timeline");
    expect(md).toContain("### 3 Nov 14:05–14:40 · Reproducing the duplication");
    expect(md).toContain("- question: Why do items duplicate in trades? [^1] ^n-4f2a");
    expect(md).toContain("[^1]: [e_q3k2v7m4c5x2a7pd v1](obsidian://cortex?entry=e_q3k2v7m4c5x2a7pd) · you · 3 Nov 2026");
    expect(md).not.toContain("why do items dup");
    for (const key of splitFrontmatter(md).fields.map(([k]) => k)) expect(["made_by", "conversation", "space"].includes(key) || key.startsWith("cortex_")).toBe(true);
  });
  it("makes injected markdown and Dataview inert (SAFE-01 contract)", () => {
    const evil = ["`$= dv.el('p', 1)`", "```dataviewjs\nalert(1)\n```", "[[Secret note]]", "![x](https://evil/x.png)", "<script>alert(1)</script>", "key:: value", "[click](javascript:alert(1))", "# Heading", "- list"];
    for (const e of evil) {
      expect(injectionSignals(e).length + (/^[#-]/.test(e) ? 1 : 0)).toBeGreaterThan(0);
      const inert = mdInert(e);
      expect(inert).not.toMatch(/(^|[^\\])`/);
      expect(inert).not.toMatch(/(^|[^\\])\[\[/);
      expect(inert).not.toMatch(/(^|[^\\])\$=/);
      expect(inert).not.toMatch(/(^|[^\\])::/);
      expect(inert).not.toMatch(/(^|[^\\])</);
      expect(inert).not.toMatch(/\n/);
      expect(inert).not.toMatch(/^[#-] /);
    }
    const md = renderGistMarkdown(doc("```dataviewjs\nalert(1)\n```", "$= dv.current()"), "wiki/derived/gists/2026/x.md" as never).markdown;
    expect(md).not.toContain("```dataviewjs");
    expect(md).not.toMatch(/(^|[^\\])\$=/m);
  });
  it("hashes only Cortex-owned content and keeps foreign frontmatter keys", () => {
    const md = renderGistMarkdown(doc("A question?"), "wiki/derived/gists/2026/x.md" as never).markdown;
    const withForeign = md.replace("---\n", "---\nlayer: 3\ntags: [x]\n");
    expect(ownedHash(withForeign)).toBe(ownedHash(md));
    expect(ownedHash(md.replace("A question?", "An edited question?"))).not.toBe(ownedHash(md));
    const next = renderGistMarkdown(doc("A new question?"), "wiki/derived/gists/2026/x.md" as never).markdown;
    expect(mergeForeignFrontmatter(withForeign, next)).toContain("layer: 3");
    const hub = renderHubMarkdown({ id: "n_cccccccccccccccc", hubType: "project", status: "active", range: ["2026-10-14T00:00:00.000Z", "2026-11-08T00:00:00.000Z"], members: [], brief: [{ text: "Slots lock while trades confirm", cites: [] }], madeBy, space: "roblox", title: "Roblox inventory", addressedComments: [] } as never, "wiki/derived/maps/project/roblox-inventory.md" as never).markdown;
    expect(hub).toContain("cortex_kind: map");
    expect(hub).toContain("cortex_map_kind: project");
    expect(shortDay("2026-11-03T14:05:00Z", true)).toBe("3 Nov 2026");
  });
});

// ───────────────────────────── ledger, cursors, manifest, signal, control, stage, readers ─────────────────────────────

const ctxOf = async () => {
  const vault = await tmp();
  const cache = await tmp();
  return { vault, cache, ctx: await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger }) };
};
const eid = (n: number) => `e_${"a".repeat(15)}${"bcdefghijklmnopq"[n]}` as SegmentLine["id"];
const msg = (n: number, text: string, extra: Record<string, unknown> = {}): StagedMessage => {
  const sha = createHash("sha256").update(text).digest("hex");
  const line = { v: 1, id: eid(n), nid: `n${n}`, conv: CONV, i: n, ts: "2026-11-03T14:05:00.000Z", sp: "you", text, sha } as SegmentLine;
  const entry = {
    v: 1, id: eid(n), kind: "message", source: "claude-code", sourceRef: { path: "x.jsonl", nativeId: `n${n}`, sha256: sha }, conv: CONV, idx: n, speaker: "you",
    text: { store: "stage", conv: CONV, line: n }, textSha256: sha, chars: text.length, words: 1, dates: [], existedBy: "2026-11-03T14:05:00.000Z", addedAt: "2026-11-03T14:05:00.000Z",
    space: "roblox", folder: [], ...extra,
  } as unknown as EntryRecord;
  return { line, entry };
};

describe("store/ledger", () => {
  it("appends per month, reads back in order and answers has()", async () => {
    const { ctx } = await ctxOf();
    const store = createLedgerStore(ctx);
    const e1 = msg(0, "one", { addedAt: "2026-10-30T10:00:00.000Z" }).entry;
    const e2 = msg(1, "two", { addedAt: "2026-11-02T10:00:00.000Z" }).entry;
    await store.append("entries", [e1, e2]);
    expect(await store.months("entries")).toEqual(["2026-10", "2026-11"]);
    expect((await store.readShard("entries", "2026-11")).records.map((r) => r.id)).toEqual([e2.id]);
    const all: string[] = [];
    for await (const r of store.readAll("entries")) all.push(r.id);
    expect(all).toEqual([e1.id, e2.id]);
    expect([...(await store.has("entries", [e1.id, eid(9)]))]).toEqual([e1.id]);
    const before = await store.seq();
    await store.append("entries", [msg(2, "three").entry]);
    expect(await store.seq()).toBeGreaterThan(before);
    expect(ledgerShardPath("entries", "2026-11", 1)).toBe(".vault-meta/cortex/entries/2026-11/000001.jsonl");
  });
  it("keeps the corrections log append-only and ignores a torn last line", async () => {
    const { ctx, vault } = await ctxOf();
    const store = createLedgerStore(ctx);
    const c = { v: 1, id: "k_aaaaaaaaaaaaaaaa", at: "2026-11-05T00:00:00.000Z", via: "reader", action: "pin", target: eid(0), payload: {} } as unknown as CorrectionRecord;
    await store.appendCorrections([c]);
    await appendFile(path.join(vault, ".vault-meta", "cortex", "corrections.jsonl"), '{"v":1,"id":"k_torn');
    expect((await store.readCorrections()).map((x) => x.id)).toEqual([c.id]);
    await store.appendCorrections([{ ...c, id: "k_bbbbbbbbbbbbbbbb" as CorrectionRecord["id"] }]);
    expect((await store.readCorrections()).map((x) => x.id)).toEqual([c.id, "k_bbbbbbbbbbbbbbbb"]);
  });
});

describe("store/cursors and manifest", () => {
  it("moves a cursor forward only, unless the file was replaced, and plans reads", async () => {
    const { ctx } = await ctxOf();
    const cur = (offset: number, size: number, mtimeMs = 1) => ({ path: "a.jsonl", size, mtimeMs, offset, line: offset, emitted: 0, updatedAt: "2026-11-03T00:00:00.000Z" });
    await saveCursors(ctx, { a: cur(100, 100) });
    await saveCursors(ctx, { a: cur(40, 100) });
    expect((await loadCursors(ctx)).files.a?.offset).toBe(100);
    await saveCursors(ctx, { a: cur(0, 30, 2) });
    expect((await loadCursors(ctx)).files.a?.size).toBe(30);
    expect(cursorPlan(undefined, 10, 1)).toEqual({ from: 0, reset: true });
    expect(cursorPlan(cur(10, 10), 25, 2)).toEqual({ from: 10, reset: false });
    expect(cursorPlan(cur(10, 10), 5, 2)).toEqual({ from: 0, reset: true });
    expect(cursorPlan(cur(10, 10), 10, 1)).toBeNull();
  });
  it("upserts source rows and keeps stored fields", async () => {
    const { ctx } = await ctxOf();
    await updateSourceManifest(ctx, "s1", { kind: "claude-code", path: "C:/x", entries: 5 });
    await updateSourceManifest(ctx, "s1", { kind: "claude-code", path: "C:/x", status: "watching" });
    const m = await loadSourceManifest(ctx);
    expect(m.sources.s1).toMatchObject({ entries: 5, status: "watching" });
  });
});

describe("store/signal and control", () => {
  it("tells which kinds changed and resets everything for a first read", async () => {
    const { cache } = await ctxOf();
    expect(await readSignal(cache)).toBeNull();
    const a = await writeSignal(cache, { seq: 1, changed: ["entries"], by: "test" });
    const b = await writeSignal(cache, { seq: 2, changed: ["labels"], by: "test" });
    expect(signalChanges(a, b)).toEqual(["labels"]);
    expect(signalChanges(b, b)).toEqual([]);
    expect(signalChanges(null, b)).toEqual([...SIGNAL_KINDS]);
    expect((await readSignal(cache))?.seq).toBe(2);
  });
  it("rewrites the signal after every committed ledger batch, naming its kind and the new seq", async () => {
    const { ctx, cache } = await ctxOf();
    const store = createLedgerStore(ctx);
    const seq1 = await store.append("entries", [msg(0, "one").entry]);
    const s1 = await readSignal(cache);
    expect(s1?.changed).toEqual(["entries"]);
    expect(s1?.seq).toBe(seq1);
    await store.append("conversations", [{ v: 1, id: CONV, source: "claude-code" } as unknown as ConversationRecord]);
    const s2 = await readSignal(cache);
    expect(s2?.changed).toEqual(["entries"]);
    expect(signalChanges(s1, s2 as NonNullable<typeof s2>)).toEqual(["entries"]);
    await store.append("runs", [{ v: 1, id: "r_aaaaaaaaaaaaaaaa" } as unknown as RunRecord]);
    expect((await readSignal(cache))?.changed).toEqual(["runs"]);
    const c = { v: 1, id: "k_aaaaaaaaaaaaaaaa", at: "2026-11-05T00:00:00.000Z", via: "reader", action: "pin", target: eid(0), payload: {} } as unknown as CorrectionRecord;
    const seq4 = await store.appendCorrections([c]);
    const s4 = await readSignal(cache);
    expect(s4?.changed).toEqual(["corrections"]);
    expect(s4?.seq).toBe(seq4);
    expect(seq4).toBe(await store.seq());
    // Nothing committed, nothing signalled.
    await store.append("labels", []);
    expect((await readSignal(cache))?.n).toBe(s4?.n);
  });
  it("signals staged live messages without moving the ledger seq", async () => {
    const { ctx, cache } = await ctxOf();
    expect(await stageMessages(ctx, CONV, [msg(0, "live one")])).toBe(1);
    const s = await readSignal(cache);
    expect(s?.changed).toEqual(["staged"]);
    expect(s?.seq).toBe(0);
    expect(await stageMessages(ctx, CONV, [msg(0, "live one")])).toBe(0);
    expect((await readSignal(cache))?.n).toBe(s?.n);
  });
  it("pauses, stops a running job when privacy changes, and fails closed on a bad file", async () => {
    const { ctx, vault } = await ctxOf();
    expect((await readControl(ctx)).paused).toBe(false);
    const gate = await openControlGate(ctx);
    expect(gate.initial).toEqual({ ok: true });
    await writeControl(ctx, { privacyChanged: true });
    expect(await gate.check()).toEqual({ ok: false, reason: "privacy-changed" });
    const paused = await writeControl(ctx, { paused: true });
    expect(paused.paused).toBe(true);
    expect((await openControlGate(ctx)).initial).toEqual({ ok: false, reason: "paused" });
    await writeFile(path.join(vault, ".vault-meta", "cortex", "state", "control.json"), "{not json");
    expect((await readControl(ctx)).paused).toBe(true);
  });
});

describe("store/stage (live sessions)", () => {
  it("stages, reads text from the stage, seals into a segment and rewrites the refs", async () => {
    const { ctx, vault } = await ctxOf();
    expect(await stageMessages(ctx, CONV, [msg(0, "first"), msg(1, "second")])).toBe(2);
    expect(await stageMessages(ctx, CONV, [msg(1, "second"), msg(2, "third")])).toBe(1);
    expect((await listStaged(ctx)).map((s) => [s.conv, s.messages])).toEqual([[CONV, 3]]);
    expect(await stageLookup(ctx)(CONV, 1)).toBe("second");
    expect(dueForSeal(await listStaged(ctx), Date.now() + 60 * 60_000, 30)).toEqual([CONV]);
    expect(dueForSeal(await listStaged(ctx), Date.now(), 30)).toEqual([]);
    const sealed = await sealStage(ctx, CONV);
    expect(sealed.entries).toBe(3);
    expect(await listStaged(ctx)).toEqual([]);
    const recs: EntryRecord[] = [];
    for await (const r of createLedgerStore(ctx).readAll("entries")) recs.push(r);
    expect(recs.map((r) => r.text.store)).toEqual(["segment", "segment", "segment"]);
    const first = recs[0] as EntryRecord;
    expect(await readText(vault, first.text, first.textSha256)).toEqual({ ok: true, text: "first" });
    expect(await sealStage(ctx, CONV)).toEqual({ entries: 0 });
  });
  it("refuses a staged message whose hash does not match", async () => {
    const { ctx } = await ctxOf();
    const bad = msg(0, "text");
    bad.line = { ...bad.line, text: "tampered" };
    await expect(stageMessages(ctx, CONV, [bad])).rejects.toThrow(/sha256/);
  });
});

describe("store/ledgerReader (Agents, Checks, Access log, changes, Ask history)", () => {
  it("serves runs (latest record wins), the access log, checks, work waiting and history", async () => {
    const { ctx, vault, cache } = await ctxOf();
    const store = createLedgerStore(ctx);
    const now = Date.parse("2026-11-09T12:00:00.000Z");
    const run = (id: string, status: string, startedAt: string): RunRecord => ({ v: 1, id, job: "label", engine: "claude-cli", model: "claude-haiku-4.5", where: "remote", paidBy: "plan", startedAt, status, items: 3 }) as unknown as RunRecord;
    await store.append("runs", [run("r_aaaaaaaaaaaaaaaa", "running", "2026-11-09T10:00:00.000Z"), run("r_aaaaaaaaaaaaaaaa", "finished", "2026-11-09T10:00:00.000Z"), run("r_bbbbbbbbbbbbbbbb", "failed", "2026-11-08T10:00:00.000Z")]);
    const read = (at: string, ids: string[]): ReadRecord => ({ v: 1, runId: "r_aaaaaaaaaaaaaaaa", model: "claude-haiku-4.5", engine: "claude-cli", where: "remote", entryIds: ids, noteIds: [], policy: "full", chars: 10, redactions: 0, withheld: 0, via: "job", origin: "plugin", at }) as unknown as ReadRecord;
    await store.append("reads", [read("2026-11-01T09:00:00.000Z", [eid(0), eid(1)]), read("2026-11-09T11:00:00.000Z", [eid(2)])]);
    const conv = (id: string, source: string, seq: number, extra = {}): ConversationRecord => ({ v: 1, id, seq, source, nativeId: id, title: "t", titledBy: "native", entryCount: 1, parts: [], space: "roblox", folder: [], updatedAt: "2026-11-02T00:00:00.000Z", ...extra }) as unknown as ConversationRecord;
    await store.append("conversations", [conv("c_aaaaaaaaaaaaaaaa", "claude-code", 1), conv("c_bbbbbbbbbbbbbbbb", "chatgpt", 2, { gistNoteId: "n_aaaaaaaaaaaaaaaa" }), conv("c_cccccccccccccccc", "chatgpt", 3)]);
    const label = { v: 1, id: "l_aaaaaaaaaaaaaaaa", target: "c_bbbbbbbbbbbbbbbb", pack: "session", packVersion: "1", field: "work", value: "debug", state: "set", by: { model: "m", runId: "r_aaaaaaaaaaaaaaaa", engine: "claude-cli" }, at: "2026-11-09T10:00:00.000Z" } as unknown as LabelRecord;
    await store.append("labels", [label]);
    const card = (id: string, target: string, confidence: number): ReviewCardRecord => ({ v: 1, id, kind: "label", target, proposal: {}, confidence, createdAt: "2026-11-09T10:30:00.000Z" }) as unknown as ReviewCardRecord;
    await store.append("review", [card("v_aaaaaaaaaaaaaaaa", "c_bbbbbbbbbbbbbbbb", 0.4), card("v_bbbbbbbbbbbbbbbb", "c_aaaaaaaaaaaaaaaa", 0.9)]);
    await store.appendCorrections([{ v: 1, id: "k_aaaaaaaaaaaaaaaa", at: "2026-11-09T11:30:00.000Z", via: "checks", action: "confirm", target: "v_bbbbbbbbbbbbbbbb", payload: {} } as unknown as CorrectionRecord]);
    const ask = (n: number, nativeId: string, sp: string): EntryRecord => ({ ...msg(n, "q").entry, source: "cortex-ask", conv: "c_dddddddddddddddd", speaker: sp, sourceRef: { path: "cortex-ask/t1", nativeId, sha256: "x" }, addedAt: "2026-11-09T11:45:00.000Z" }) as unknown as EntryRecord;
    await store.append("entries", [ask(5, "ask1:q", "you"), ask(6, "ask1:a", "assistant")]);
    // The conversations' messages: c_aaaa and c_cccc have one from the person (the agents' work); c_eeee is a session an
    // agent started (no message from the person), and one note comes from another source: both are left alone.
    const said = (n: number, conv: string, source: string, sp: string): EntryRecord => ({ ...msg(n, `m${n}`).entry, source, conv, speaker: sp, sourceRef: { path: `${source}/${conv}`, nativeId: `${conv}:${n}`, sha256: "x" }, addedAt: "2026-11-09T11:40:00.000Z" }) as unknown as EntryRecord;
    const doc = (n: number, source: string, extra: Record<string, unknown> = {}): EntryRecord => {
      const d = { ...msg(n, `doc ${n}`).entry, kind: "document", source, sourceRef: { path: `Notes/n${n}.md`, nativeId: `note:n${n}`, sha256: "x" }, addedAt: "2026-11-09T11:40:00.000Z", ...extra } as unknown as EntryRecord & { conv?: string };
      delete d.conv;
      return d;
    };
    // A vault note, its edited version (the older entry no longer waits), and an imported file (not the agents' work).
    const note = doc(12, "obsidian");
    await store.append("conversations", [conv("c_eeeeeeeeeeeeeeee", "claude-code", 4)]);
    await store.append("entries", [said(7, "c_aaaaaaaaaaaaaaaa", "claude-code", "you"), said(8, "c_aaaaaaaaaaaaaaaa", "claude-code", "assistant"), said(9, "c_cccccccccccccccc", "chatgpt", "you"), said(10, "c_cccccccccccccccc", "chatgpt", "assistant"), said(11, "c_eeeeeeeeeeeeeeee", "claude-code", "assistant"), note, doc(13, "obsidian", { supersedes: eid(12) }), doc(14, "files")]);
    await store.append("receipts", [{ v: 1, id: "x_aaaaaaaaaaaaaaaa", seq: 1, askId: "ask1", action: "set-view", params: {}, summary: "s", targets: 1, state: "applied", corrections: [], expiresAt: null, at: "2026-11-09T11:46:00.000Z" } as unknown as ReceiptRecord]);
    await mkdir(path.join(vault, ".vault-meta", "cortex", "state"), { recursive: true });
    await writeFile(path.join(vault, ".vault-meta", "cortex", "state", "budget.json"), JSON.stringify({ v: 1, today: { day: "2026-11-09", tokens: 500, reserved: 0, usd: 0, calls: 1, open: {} }, history: [{ day: "2026-11-08", tokens: 1_000_000, usd: 0, calls: 9, cap: 1_000_000 }] }));

    const svc = createLedgerReader({ vaultRoot: vault, cacheDir: cache, log: nullLogger, now: () => now });
    const runs = await svc.runs({ limit: 10 });
    expect(runs.map((r) => [r.id, r.status])).toEqual([["r_aaaaaaaaaaaaaaaa", "finished"], ["r_bbbbbbbbbbbbbbbb", "failed"]]);
    expect((await svc.runs({ status: "failed", limit: 10 })).length).toBe(1);
    expect((await svc.runs({ limit: 1 })).length).toBe(1);

    const access = await svc.accessLog();
    expect(access).toEqual([{ model: "claude-haiku-4.5", route: "Claude Code → Anthropic", itemsRead: 3, first: "2026-11-01T09:00:00.000Z", last: "2026-11-09T11:00:00.000Z" }]);
    expect(await createLedgerReader({ vaultRoot: vault, cacheDir: cache, log: nullLogger }).accessLog()).toEqual(access);

    expect((await svc.checks({ limit: 10 })).map((c) => c.id)).toEqual(["v_aaaaaaaaaaaaaaaa"]);
    expect((await svc.checks({ kind: "unsure", limit: 10 })).length).toBe(1);
    expect(await svc.checksToday()).toEqual({ checked: 1, waiting: 1 });

    const work = await svc.workWaiting();
    // Waiting: c_cccc and the vault note's current version (the agents give vault notes a role).
    expect(work.queues).toEqual({ label: 2, summaries: 2, checks: 1 });
    expect(work.bySource).toEqual([{ source: "claude-code", checked: 1, done: 0, waiting: 0 }, { source: "chatgpt", checked: 0, done: 1, waiting: 1 }, { source: "obsidian", checked: 0, done: 0, waiting: 1 }]);
    // Never waiting: the agent's own session and the imported file are named apart.
    expect(work.leftAlone).toEqual({ sessions: 1, notes: 1 });
    // A count an earlier build saved (same ledgers, no version in its key) is computed again, never served.
    const aggFile = path.join(cache, "agg", "work.json");
    const saved = JSON.parse(await readFile(aggFile, "utf8")) as { sig: string; value: { queues: { label: number } } };
    expect(saved.sig.startsWith("v3|")).toBe(true);
    await writeFile(aggFile, JSON.stringify({ sig: `v2|${saved.sig.slice("v3|".length)}`, value: { ...saved.value, queues: { ...saved.value.queues, label: 1670 } } }));
    expect((await createLedgerReader({ vaultRoot: vault, cacheDir: cache, log: nullLogger, now: () => now }).workWaiting()).queues.label).toBe(2);

    expect(await svc.budgetHistory(3)).toEqual([{ day: "2026-11-07", tokens: 0, capped: false }, { day: "2026-11-08", tokens: 1_000_000, capped: true }, { day: "2026-11-09", tokens: 500, capped: false }]);

    expect((await svc.changes({})).map((c) => c.id)).toEqual(["x_aaaaaaaaaaaaaaaa"]);
    const asks = await svc.askHistory({});
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ askId: "ask1", threadId: "t1", questionEntry: eid(5), replyEntry: eid(6) });
    expect(asks[0]?.changes).toHaveLength(1);
  });
  it("says so when it was created without a vault", async () => {
    await expect(createLedgerReader().runs({ limit: 1 })).rejects.toThrow(/vault folder/);
  });
});

describe("store/segments held secrets", () => {
  it("keeps a held secret in the cache folder and reads it back", async () => {
    const { ctx, cache } = await ctxOf();
    await holdSecrets(ctx, eid(0), [{ text: "sk-test-123", kind: "api-key" }]);
    expect(JSON.stringify(await readHeld(cache, eid(0)))).toContain("sk-test-123");
    expect(await readHeld(cache, eid(1))).toBeNull();
  });
});

describe("store/recordReader", () => {
  it("reveals a held secret by marker, and reports missing text instead of throwing", async () => {
    const { ctx, vault, cache } = await ctxOf();
    await holdSecrets(ctx, eid(0), [{ text: "sk-test-123", kind: "api-key" }]);
    const reader = createRecordReader({ vaultRoot: vault, cacheDir: cache, index: () => null, log: nullLogger });
    const held = await readHeld(cache, eid(0));
    const n = held?.secrets[0]?.n ?? -1;
    expect(await reader.revealHeld(eid(0), n)).toBe("sk-test-123");
    expect(await reader.revealHeld(eid(0), 99)).toBeNull();
    expect(await reader.revealHeld(eid(0), -1)).toBeNull();
    expect(await reader.entryText(0)).toEqual({ ok: false, reason: "missing" });
    await expect(reader.conversationSlice("c_zzzzzzzzzzzzzzzz", 0, 5)).resolves.toEqual([]);
  });
});
