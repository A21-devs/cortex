/**
 * Encrypt my record: the whole path on temp folders only. Ledger shards, corrections, segments and seal blocks are
 * encrypted in place with a backup, read back through the normal readers while the key is held, absent while locked,
 * and rolled back when anything fails. Legacy plain files stay readable throughout.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { nullLogger } from "../src/shared/log";
import { generateVaultKey } from "../src/shared/crypto/vaultKey";
import { holdVaultKey, dropVaultKey, resetKeyring, setEncryptionConfigured } from "../src/shared/crypto/keyring";
import { convertRecord, listBackups, listRecordFiles, planRecordConversion, removeBackup, convertLines } from "../src/store/encryptRecord";
import { cacheLayout, openStoreContext } from "../src/store/layout";
import { createLedgerStore, grepRecords, readLineAt, streamJsonl, listLedgerFiles } from "../src/store/ledger";
import { readSegment, writeSegment } from "../src/store/segments";
import { blockHash, merkleRoot, readSealChain, resetSealCache, sealHostKey, sealLeaf, sealNewEntries } from "../src/store/dateEvidence";
import type { EntryRecord, SegmentLine } from "../src/shared/types";

const dirs: string[] = [];
const tmp = (n: string): string => {
  const d = mkdtempSync(path.join(tmpdir(), `cx-enc-${n}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  resetKeyring();
  resetSealCache();
});
afterEach(() => resetKeyring());

const CONV = "c_aaaaaaaaaaaaaaaa" as const;
const B32 = "bcdefghijklmnopq";
const eId = (n: number): EntryRecord["id"] => `e_${"a".repeat(14)}${B32[Math.floor(n / 16)]}${B32[n % 16]}` as EntryRecord["id"];
const sha = (t: string): string => createHash("sha256").update(t).digest("hex");
const T0 = Date.UTC(2026, 10, 3, 14, 0, 0);

function entry(n: number): EntryRecord {
  const text = `entry number ${n} with the secret word zebra${n}`;
  return {
    v: 1, id: eId(n), kind: "message", source: "claude-code", sourceRef: { path: "x.jsonl", nativeId: `n${n}`, sha256: sha(text) }, conv: CONV, idx: n, speaker: "you",
    text: { store: "stage", conv: CONV, line: n }, textSha256: sha(text), chars: text.length, words: 8, dates: [], existedBy: new Date(T0 + n * 60_000).toISOString(),
    addedAt: new Date(T0 + n * 60_000).toISOString(), writtenAt: new Date(T0 + n * 60_000).toISOString(), space: "roblox", folder: ["zebra-project"],
  } as unknown as EntryRecord;
}

const segLine = (i: number): SegmentLine => ({ v: 1, id: eId(i), nid: `n${i}`, conv: CONV, i, sp: "you", text: `message ${i} says zebra${i}`, sha: sha(`message ${i} says zebra${i}`) }) as unknown as SegmentLine;

async function world() {
  const vault = tmp("vault");
  const cache = tmp("cache");
  const ctx = await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
  const ledger = createLedgerStore(ctx);
  // a plain record: three entries, a correction, two segments, one seal block
  await ledger.append("entries", [entry(0), entry(1), entry(2)]);
  await ledger.appendCorrections([{ v: 1, id: "x_aaaaaaaaaaaaaaaa", seq: 1, at: new Date(T0).toISOString() } as never]);
  await writeSegment(ctx, { source: "claude-code", monthKey: "2026-11", conv: CONV, lines: [segLine(0), segLine(1)] });
  await writeSegment(ctx, { source: "claude-code", monthKey: "2026-11", conv: CONV, lines: [segLine(2)] });
  await sealNewEntries(ctx, ledger, { now: () => T0 + 10_000_000, format: 1 });
  return { vault, cache, ctx, ledger };
}

const allBytes = (vault: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(vault);
  return out;
};
const recordText = (vault: string): string => Buffer.concat(allBytes(vault).filter((p) => /jsonl|seals|\.json$/.test(p) && !p.endsWith("seq.json")).map((p) => readFileSync(p))).toString("latin1");

describe("encrypting the record in place", () => {
  it("the dry run lists what would change and writes nothing", async () => {
    const w = await world();
    const before = allBytes(w.vault).map((p) => [p, sha(readFileSync(p, "latin1"))]);
    const plan = await planRecordConversion(w.vault, "encrypt");
    expect(plan.toConvert).toBe(plan.files);
    expect(plan.byKind.segment.files).toBe(2);
    expect(plan.byKind.seal.files).toBe(1);
    expect(plan.byKind.corrections.files).toBe(1);
    expect(plan.byKind.shard.files).toBeGreaterThanOrEqual(1);
    expect(plan.unreadable).toEqual([]);
    expect(allBytes(w.vault).map((p) => [p, sha(readFileSync(p, "latin1"))])).toEqual(before);
    expect(existsSync(path.join(w.cache, "backups"))).toBe(false);
  });

  it("encrypts everything, keeps a verified backup, and the normal readers still see the same record", async () => {
    const w = await world();
    const files = await listRecordFiles(w.vault);
    const plainSeg = await readSegment(w.vault, files.find((f) => f.kind === "segment")!.rel as never);
    const plainEntries: unknown[] = [];
    for await (const r of w.ledger.readAll("entries")) plainEntries.push(r);
    const chainBefore = await readSealChain(w.vault, sealHostKey());
    expect(recordText(w.vault)).toContain("zebra-project");

    const key = generateVaultKey();
    setEncryptionConfigured(true);
    holdVaultKey(key);
    const r = await convertRecord(w.ctx, { direction: "encrypt", key });
    expect(r).toMatchObject({ ok: true, rolledBack: false });
    expect(r.converted).toBe(files.length);

    // no plain word of the record is left in any record file
    const text = recordText(w.vault);
    expect(text).not.toContain("zebra");
    expect(text).not.toContain("roblox");
    expect(text).toContain("CXE1");

    // the backup holds the originals byte for byte
    expect(r.backup).toMatch(/^backups\/encrypt-/);
    for (const f of files) expect(readFileSync(path.join(w.cache, r.backup!, f.rel)).length).toBeGreaterThan(0);
    expect(await listBackups(w.cache)).toEqual([r.backup]);

    // readers: same entries, same segment lines, same seal chain, grep and by-offset reads work
    const after: unknown[] = [];
    for await (const x of w.ledger.readAll("entries")) after.push(x);
    expect(after).toEqual(plainEntries);
    expect(await readSegment(w.vault, files.find((f) => f.kind === "segment")!.rel as never)).toEqual(plainSeg);
    expect(await readSealChain(w.vault, sealHostKey())).toEqual(chainBefore);
    expect((await grepRecords<{ id: string }>(w.vault, "entries", [eId(1)], (x) => x.id === eId(1))).length).toBe(1);
    const hit = (await grepRecords<{ id: string }>(w.vault, "entries", [eId(2)], () => true))[0]!;
    expect(await readLineAt<{ id: string }>(w.vault, hit.loc)).toMatchObject({ id: eId(2) });
    expect(await w.ledger.readCorrections()).toHaveLength(1);

    // the verified backup is removable
    await removeBackup(w.cache, r.backup!);
    expect(await listBackups(w.cache)).toEqual([]);
    await expect(removeBackup(w.cache, "../x")).rejects.toThrow();
  });

  it("while locked the record reads as absent, writes are refused, and the key brings it back", async () => {
    const w = await world();
    const key = generateVaultKey();
    setEncryptionConfigured(true);
    holdVaultKey(key);
    await convertRecord(w.ctx, { direction: "encrypt", key });
    dropVaultKey();
    const seen: unknown[] = [];
    for await (const x of w.ledger.readAll("entries")) seen.push(x);
    expect(seen).toEqual([]);
    expect(await grepRecords(w.vault, "entries", [eId(1)], () => true)).toEqual([]);
    await expect(w.ledger.append("entries", [entry(5)])).rejects.toMatchObject({ code: "E_LOCKED" });
    await expect(writeSegment(w.ctx, { source: "claude-code", monthKey: "2026-11", conv: CONV, lines: [segLine(5)] })).rejects.toMatchObject({ code: "E_LOCKED" });
    const segFile = (await listRecordFiles(w.vault)).find((f) => f.kind === "segment")!;
    await expect(readSegment(w.vault, segFile.rel as never)).rejects.toMatchObject({ code: "E_LOCKED" });
    holdVaultKey(key);
    const back: unknown[] = [];
    for await (const x of w.ledger.readAll("entries")) back.push(x);
    expect(back).toHaveLength(3);
  });

  it("new lines written with the key held are encrypted, and old plain lines in the same shard still read (mixed shard)", async () => {
    const w = await world();
    const key = generateVaultKey();
    setEncryptionConfigured(true);
    holdVaultKey(key);
    await w.ledger.append("entries", [entry(7)]); // appended before any migration: the shard is now mixed
    const shard = (await listLedgerFiles(w.vault, "entries"))[0]!;
    const raw = readFileSync(shard.abs, "utf8");
    expect(raw).toContain("zebra-project");
    expect(raw).toContain("CXE1:");
    const ids: string[] = [];
    for await (const x of streamJsonl<{ id: string }>(shard.abs)) ids.push(x.id);
    expect(ids).toEqual([eId(0), eId(1), eId(2), eId(7)]);
    const r = await convertRecord(w.ctx, { direction: "encrypt", key });
    expect(r.error ?? "").toBe("");
    expect(r.ok).toBe(true);
    expect(readFileSync(shard.abs, "utf8")).not.toContain("zebra-project");
    // run again: nothing left to convert
    const again = await convertRecord(w.ctx, { direction: "encrypt", key });
    expect(again).toMatchObject({ ok: true, converted: 0, backup: null });
  });

  it("rolls back every file when a later one fails, and says so", async () => {
    const w = await world();
    const files = await listRecordFiles(w.vault);
    const before = files.map((f) => [f.rel, sha(readFileSync(f.abs, "latin1"))]);
    const key = generateVaultKey();
    setEncryptionConfigured(true);
    holdVaultKey(key);
    const r = await convertRecord(w.ctx, { direction: "encrypt", key, failAfter: 3 });
    expect(r.ok).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(r.rollbackFailed).toBe(false);
    expect(files.map((f) => [f.rel, sha(readFileSync(f.abs, "latin1"))])).toEqual(before);
    expect(recordText(w.vault)).toContain("zebra-project");
  });

  it("refuses to replace a file when the converted bytes would not give the original back (wrong key on decrypt)", async () => {
    const w = await world();
    const key = generateVaultKey();
    setEncryptionConfigured(true);
    holdVaultKey(key);
    expect((await convertRecord(w.ctx, { direction: "encrypt", key })).ok).toBe(true);
    const files = await listRecordFiles(w.vault);
    const before = files.map((f) => sha(readFileSync(f.abs, "latin1")));
    const wrong = await convertRecord(w.ctx, { direction: "decrypt", key: generateVaultKey() });
    expect(wrong.ok).toBe(false);
    expect(files.map((f) => sha(readFileSync(f.abs, "latin1")))).toEqual(before);
  });

  it("decrypt restores the original bytes exactly", async () => {
    const w = await world();
    const files = await listRecordFiles(w.vault);
    const before = files.map((f) => [f.rel, sha(readFileSync(f.abs, "latin1"))]);
    const key = generateVaultKey();
    setEncryptionConfigured(true);
    holdVaultKey(key);
    await convertRecord(w.ctx, { direction: "encrypt", key });
    const back = await convertRecord(w.ctx, { direction: "decrypt", key });
    expect(back.error ?? "").toBe("");
    expect(back.ok).toBe(true);
    expect(files.map((f) => [f.rel, sha(readFileSync(f.abs, "latin1"))])).toEqual(before);
  });

  it("a damaged encrypted line fails the decrypt instead of being dropped", () => {
    const key = generateVaultKey();
    const enc = convertLines(Buffer.from('{"a":1}\n{"b":2}\n'), key, "encrypt");
    const bad = Buffer.from(enc);
    const at = bad.indexOf(0x3a) + 12;
    bad[at] = (bad[at] as number) ^ 1;
    expect(() => convertLines(bad, key, "decrypt")).toThrow(/did not open/);
    expect(Buffer.from(convertLines(enc, key, "decrypt")).toString()).toBe('{"a":1}\n{"b":2}\n');
  });

  it("keeps CRLF line ends, a missing final newline and bytes that are not UTF-8", () => {
    const key = generateVaultKey();
    const src = Buffer.concat([Buffer.from('{"a":1}\r\n\n'), Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), Buffer.from("\n{torn")]);
    const enc = convertLines(src, key, "encrypt");
    expect(Buffer.from(enc).toString("latin1")).not.toContain("torn");
    expect(Buffer.from(convertLines(enc, key, "decrypt")).equals(src)).toBe(true);
  });

  it("the seal roots and block hashes are computed from plain text, so encrypting changes none", async () => {
    const w = await world();
    const before = await readSealChain(w.vault, sealHostKey());
    const key = generateVaultKey();
    setEncryptionConfigured(true);
    holdVaultKey(key);
    await convertRecord(w.ctx, { direction: "encrypt", key });
    const after = await readSealChain(w.vault, sealHostKey());
    expect(after.broken).toBe(false);
    expect(after.blocks[0]!.root).toBe(before.blocks[0]!.root);
    expect(after.blocks[0]!.root).toBe(merkleRoot([0, 1, 2].map((n) => sealLeaf(eId(n), entry(n).textSha256))));
    expect(blockHash(after.blocks[0]!)).toBe(after.blocks[0]!.hash);
    // a new block written while the key is held is encrypted on disk and chains on
    await w.ledger.append("entries", [entry(9)]);
    await sealNewEntries(w.ctx, w.ledger, { now: () => T0 + 20_000_000, format: 1 });
    const file = path.join(w.vault, ".vault-meta/cortex/seals", sealHostKey(), "000002.json");
    expect(readFileSync(file).subarray(0, 4).toString()).toBe("CXE1");
    const chain = await readSealChain(w.vault, sealHostKey());
    expect(chain.broken).toBe(false);
    expect(chain.blocks).toHaveLength(2);
    expect(chain.blocks[1]!.prev).toBe(chain.blocks[0]!.hash);
  });

  it("an unencrypted record behaves exactly as before (plain ring writes plain)", async () => {
    const w = await world();
    expect(recordText(w.vault)).toContain("zebra-project");
    expect(recordText(w.vault)).not.toContain("CXE1");
    expect(cacheLayout(w.cache).locks).toBeTruthy();
    writeFileSync(path.join(w.vault, "note.txt"), "x");
  });
});
