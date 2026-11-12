/**
 * seal-date-v2: sealing by default, salted v2 blocks, Ed25519 signing (RFC 8032 vectors), the public-timestamp
 * check against a Bitcoin block header, the weekly standing consent and the proof bundle. No test touches the
 * network: calendars and block services are injected fakes.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createHandlers } from "../src/runner/commands";
import type { RunnerHost } from "../src/runner/host";
import { createCancelSource } from "../src/shared/cancel";
import { nullLogger } from "../src/shared/log";
import type { RunnerContext } from "../src/shared/protocol/runner";
import { DEFAULT_SETTINGS, type CortexSettings } from "../src/shared/settings";
import { cleanSignerName, keyFingerprint, signedStatement } from "../src/shared/sign";
import type { EntryRecord } from "../src/shared/types";
import { sha256Text } from "../src/node/hash";
import { ed25519FromSeed, ed25519Sign, ed25519Verify, loadOrCreateSigningKey, newEd25519, readSalt } from "../src/node/sign";
import {
  autoTimestamp,
  blockDigest,
  blockHashV2,
  checkPublicStamps,
  exportProof,
  merkleRoot,
  publicFingerprint,
  publishSeals,
  readOutbound,
  readSealChain,
  resetSealCache,
  sealEvidenceFor,
  sealHostKey,
  sealLeaf,
  sealNewEntries,
  sealStatus,
  verifyProofBundle,
  type SealBlockV2,
} from "../src/store/dateEvidence";
import { applyOp, bitcoinSteps, MIN_DIFFICULTY, parseOts, pendingSteps, serializeOts, targetOf, upgradeProof, verifyBitcoinHeader, type TsNode } from "../src/store/otsProof";
import { cacheLayout, openStoreContext } from "../src/store/layout";
import { createLedgerStore } from "../src/store/ledger";
import { createAgentsClock } from "../src/plugin/agentsClock";
import { outwardAccessRows } from "../src/ui/pages/AccessLog";
import { evidenceLine } from "../src/ui/reader/FactsGrid";
import { makeFmt } from "../src/ui/pages/PageFrame";

const dirs: string[] = [];
const tmp = (n: string): string => {
  const d = mkdtempSync(path.join(tmpdir(), `cx-sv2-${n}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetSealCache();
});

const B32 = "bcdefghijklmnopq";
const eId = (n: number): EntryRecord["id"] => `e_${"a".repeat(14)}${B32[Math.floor(n / 16)]}${B32[n % 16]}` as EntryRecord["id"];
const T0 = Date.UTC(2026, 10, 3, 14, 0, 0);
const DAY = 24 * 3600 * 1000;
/** A work floor low enough for a header mined in a few hashes (the real floor is MIN_DIFFICULTY). */
const EASY = 1e-12;

function entry(n: number): EntryRecord {
  const text = `secret entry number ${n}`;
  const sha = sha256Text(text);
  return {
    v: 1, id: eId(n), kind: "message", source: "claude-code", sourceRef: { path: "x.jsonl", nativeId: `n${n}`, sha256: sha }, conv: "c_aaaaaaaaaaaaaaaa", idx: n, speaker: "you",
    text: { store: "stage", conv: "c_aaaaaaaaaaaaaaaa", line: n }, textSha256: sha, chars: text.length, words: 3, dates: [], existedBy: new Date(T0 + n * 60_000).toISOString(),
    addedAt: new Date(T0 + n * 60_000).toISOString(), writtenAt: new Date(T0 + n * 60_000).toISOString(), space: "roblox", folder: ["proj"],
  } as unknown as EntryRecord;
}

async function world() {
  const vault = tmp("vault");
  const cache = tmp("cache");
  const ctx = await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
  return { vault, cache, ctx, ledger: createLedgerStore(ctx) };
}

const sha256 = (b: Uint8Array): Buffer => createHash("sha256").update(b).digest();
const sha256d = (b: Uint8Array): Buffer => sha256(sha256(b));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

// ───────────────────────────── Ed25519 ─────────────────────────────

describe("Ed25519 (node:crypto) against the RFC 8032 test vectors", () => {
  const vectors = [
    {
      name: "TEST 1 (empty message)",
      seed: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      pub: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      msg: "",
      sig: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    },
    {
      name: "TEST 2 (one byte)",
      seed: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
      pub: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
      msg: "72",
      sig: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
    },
    {
      name: "TEST 3 (two bytes)",
      seed: "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
      pub: "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
      msg: "af82",
      sig: "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
    },
  ];
  for (const v of vectors) {
    it(v.name, () => {
      expect(ed25519FromSeed(v.seed).publicKey).toBe(v.pub);
      const msg = Buffer.from(v.msg, "hex");
      expect(ed25519Sign(v.seed, msg)).toBe(v.sig);
      expect(ed25519Verify(v.pub, msg, v.sig)).toBe(true);
    });
  }

  it("rejects a changed message, a changed signature and another key; a made key round-trips", () => {
    const k = newEd25519();
    const sig = ed25519Sign(k.seed, "hello");
    expect(ed25519Verify(k.publicKey, "hello", sig)).toBe(true);
    expect(ed25519Verify(k.publicKey, "hellO", sig)).toBe(false);
    expect(ed25519Verify(k.publicKey, "hello", `${sig.slice(0, 127)}${sig[127] === "0" ? "1" : "0"}`)).toBe(false);
    expect(ed25519Verify(newEd25519().publicKey, "hello", sig)).toBe(false);
    expect(ed25519Verify("zz", "hello", sig)).toBe(false);
    expect(() => ed25519FromSeed("00")).toThrow();
  });
});

describe("what is signed and how a key is named", () => {
  it("builds a plain statement with an optional, cleaned name", () => {
    const h = "ab".repeat(32);
    expect(signedStatement(h)).toBe(`cortex-seal-signature 2\n${h}`);
    expect(signedStatement(h, "  Sam\n Rao ")).toBe(`cortex-seal-signature 2\n${h}\nsigned by: Sam Rao`);
    expect(cleanSignerName("a\u0000b\tc")).toBe("a b c");
    expect(cleanSignerName("x".repeat(500))).toHaveLength(80);
    expect(cleanSignerName(undefined)).toBe("");
  });

  it("names a key by grouped hex of sha256 of its public key", () => {
    const pub = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    const fp = keyFingerprint(pub);
    expect(fp).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){4}$/);
    expect(fp.replace(/ /g, "")).toBe(sha256(Buffer.from(pub, "hex")).toString("hex").slice(0, 20));
  });
});

// ───────────────────────────── version 2 blocks ─────────────────────────────

describe("version 2 blocks", () => {
  it("salt the leaves, sign the block, keep the salt and the key out of the vault, and chain after version 1", async () => {
    const w = await world();
    await w.ledger.append("entries", [entry(0), entry(1)]);
    const host = sealHostKey();
    await sealNewEntries(w.ctx, w.ledger, { format: 1, now: () => T0 + 1000 }); // an older block first
    await w.ledger.append("entries", [entry(2), entry(3)]);
    const r = await sealNewEntries(w.ctx, w.ledger, { now: () => T0 + 2000, signAs: "Ari" });
    expect(r).toEqual({ blocks: 1, entries: 2, total: 2 });
    const chain = await readSealChain(w.vault, host);
    expect(chain.broken).toBe(false);
    const [b1, b2] = chain.blocks;
    expect(b1!.v).toBe(1);
    const v2 = b2 as SealBlockV2;
    expect(v2.v).toBe(2);
    expect(v2.prev).toBe(b1!.hash);
    expect(v2.by).toBe("Ari");
    // the root is NOT the unsalted root: a guessed text cannot be tested against it
    expect(v2.root).not.toBe(merkleRoot([sealLeaf(eId(2), entry(2).textSha256), sealLeaf(eId(3), entry(3).textSha256)].sort()));
    // the salt is kept with the record (and as a copy in the local key store); the signing seed is only in the cache
    const salt = await readSalt(w.cache, host, 2, w.vault);
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(await readSalt(w.cache, host, 2)).toBe(salt);
    expect(await readSalt(w.cache, host, 1, w.vault)).toBeNull(); // a version 1 block has no salt
    const sealsDir = path.join(w.vault, ".vault-meta/cortex/seals", host);
    const all = readdirSync(sealsDir).filter((f) => f !== "salts.json").map((f) => readFileSync(path.join(sealsDir, f), "utf8")).join("");
    expect(all).not.toContain(salt!);
    expect(JSON.parse(readFileSync(path.join(sealsDir, "salts.json"), "utf8")).salts["2"]).toBe(salt);
    const seed = JSON.parse(readFileSync(path.join(w.cache, "keys/seal-signing.json"), "utf8")).seed as string;
    expect(all).not.toContain(seed);
    expect(readFileSync(path.join(sealsDir, "salts.json"), "utf8")).not.toContain(seed);
    // public fingerprint = HMAC(salt, hash); signature verifies under the block's key and names the key in the hash
    expect(v2.fp).toBe(publicFingerprint(salt!, v2.hash));
    expect(v2.hash).toBe(blockHashV2(v2));
    expect(ed25519Verify(v2.key, signedStatement(v2.hash, "Ari"), v2.sig)).toBe(true);
    expect(blockDigest(v2)).toBe(v2.fp);
    expect(blockDigest(b1!)).toBe(b1!.hash);
    // a different block gets a different salt
    await w.ledger.append("entries", [entry(4)]);
    await sealNewEntries(w.ctx, w.ledger);
    expect(await readSalt(w.cache, host, 3, w.vault)).not.toBe(salt);
    const st = await sealStatus(w.vault, host);
    expect(st).toMatchObject({ blocks: 3, entries: 5, intact: true, pending: 0 });
    expect(st.key).toBe(keyFingerprint(v2.key));
    expect(st.outward).toEqual([]);
  });

  it("make the key once and reuse it; a damaged key file is replaced, never half-used", async () => {
    const w = await world();
    const a = await loadOrCreateSigningKey(w.cache);
    expect(a.created).toBe(true);
    const b = await loadOrCreateSigningKey(w.cache);
    expect(b).toMatchObject({ created: false, seed: a.seed, publicKey: a.publicKey });
    const file = path.join(w.cache, "keys/seal-signing.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.publicKey = "00".repeat(32); // does not follow from the seed
    writeFileSync(file, JSON.stringify(raw));
    const c = await loadOrCreateSigningKey(w.cache);
    expect(c.created).toBe(true);
    expect(c.publicKey).not.toBe(a.publicKey);
  });

  it("break the chain when the key, the signature or the time is altered", async () => {
    const w = await world();
    await w.ledger.append("entries", [entry(0)]);
    await sealNewEntries(w.ctx, w.ledger, { now: () => T0 });
    const host = sealHostKey();
    const f = path.join(w.vault, ".vault-meta/cortex/seals", host, "000001.json");
    const orig = readFileSync(f, "utf8");
    const tamper = async (fn: (b: Record<string, unknown>) => void): Promise<boolean> => {
      const b = JSON.parse(orig);
      fn(b);
      writeFileSync(f, JSON.stringify(b));
      return (await readSealChain(w.vault, host)).broken;
    };
    expect(await tamper(() => undefined)).toBe(false);
    expect(await tamper((b) => (b.key = newEd25519().publicKey))).toBe(true); // the key is part of the hash
    expect(await tamper((b) => (b.sig = `${(b.sig as string).slice(0, 120)}00000000`))).toBe(true);
    expect(await tamper((b) => (b.at = "2020-01-01T00:00:00.000Z"))).toBe(true);
    expect(await tamper((b) => (b.by = "Someone else"))).toBe(true); // the name is inside the signed text
    // a re-signed block under another key still cannot keep the hash
    const other = newEd25519();
    expect(
      await tamper((b) => {
        b.key = other.publicKey;
        b.hash = blockHashV2(b as never);
        b.sig = ed25519Sign(other.seed, signedStatement(b.hash as string));
      }),
    ).toBe(false); // a self-consistent block under its own key reads fine ...
    // ... but it is a different key: the fingerprint on You changes, which is what a person compares
    expect((await sealStatus(w.vault, host)).key).toBe(keyFingerprint(other.publicKey));
  });

  it("the key store survives Clear cache", async () => {
    const w = await world();
    await w.ledger.append("entries", [entry(0)]);
    await sealNewEntries(w.ctx, w.ledger);
    const settings: CortexSettings = structuredClone(DEFAULT_SETTINGS);
    const ctx: RunnerContext = { vaultRoot: w.vault, vaultKey: "abcdefghijklmnop", cacheDir: w.cache, settings, pluginVersion: "t", settingsSource: "plugin" };
    const rc = { id: "x", ctx, token: createCancelSource().token, host: { mode: "child", emit: () => undefined, log: nullLogger, yield: async () => undefined } as RunnerHost, progress: () => undefined, event: () => undefined };
    await createHandlers()["cache.clear"]({}, rc);
    expect(existsSync(path.join(w.cache, "keys/seal-signing.json"))).toBe(true);
    expect(existsSync(path.join(w.cache, "keys/seal-salts.json"))).toBe(true);
  });
});

// ───────────────────────────── the block header check ─────────────────────────────

describe("the Bitcoin block header check", () => {
  const GENESIS = "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";
  const GENESIS_ROOT = "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a";

  it("accepts the real genesis header (merkle root, work, time) and refuses what does not match", () => {
    const h = Buffer.from(GENESIS, "hex");
    // header bytes hold the merkle root in internal byte order, which is how timestamp proofs reach it
    const v = verifyBitcoinHeader(h.subarray(36, 68), h, { minDifficulty: 1 });
    expect(v).toMatchObject({ ok: true, time: "2009-01-03T18:15:05.000Z", blockHash: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f" });
    expect(GENESIS_ROOT).toBe(Buffer.from(h.subarray(36, 68)).toString("hex"));
    // ... the block explorers show it reversed ("4a5e1e4b...")
    expect(Buffer.from(GENESIS_ROOT, "hex").reverse().toString("hex")).toBe("4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b");
    expect(verifyBitcoinHeader(Buffer.alloc(32, 1), h, { minDifficulty: 1 })).toMatchObject({ ok: false, why: "merkle-root" });
    expect(verifyBitcoinHeader(h.subarray(36, 68), h.subarray(0, 79), { minDifficulty: 1 })).toMatchObject({ ok: false, why: "length" });
    const noWork = Buffer.from(h);
    noWork.writeUInt32LE(0, 76); // a different nonce: the hash no longer meets the target
    expect(verifyBitcoinHeader(noWork.subarray(36, 68), noWork, { minDifficulty: 1 })).toMatchObject({ ok: false, why: "work" });
    // difficulty 1 is far below the floor of any block a timestamp could name today
    expect(verifyBitcoinHeader(h.subarray(36, 68), h)).toMatchObject({ ok: false, why: "floor" });
    expect(MIN_DIFFICULTY).toBeGreaterThanOrEqual(1e9);
  });

  it("decodes compact targets", () => {
    expect(targetOf(0x1d00ffff)).toBe(0xffffn << 208n);
    expect(targetOf(0x207fffff)).toBe(0x7fffffn << 232n);
    expect(targetOf(0x1d800000)).toBeNull(); // negative flag
    expect(targetOf(0x1d000000)).toBeNull(); // zero mantissa
  });
});

// ───────────────────────────── a fake calendar and chain ─────────────────────────────

const CAL = "https://alice.btc.calendar.opentimestamps.org";
const A = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");
const Bk = Buffer.from("a1a2a3a4a5a6a7a8a9aaabacadaeafb0", "hex");

const leaf = (n: Partial<TsNode>): TsNode => ({ attestations: [], ops: [], ...n });
/** The reply a calendar gives to POST /digest: append A, sha256, then "pending". */
const pendingTree = (): TsNode => leaf({ ops: [{ tag: 0xf0, arg: A, child: leaf({ ops: [{ tag: 0x08, child: leaf({ attestations: [{ kind: "pending", uri: CAL }] }) }] }) }] });
const tree = (root: TsNode): Buffer => serializeOts({ fileOp: 0x08, digest: new Uint8Array(32), root }).subarray(65);
/** The commitment the calendar later knows: sha256(digest || A). */
const commitmentOf = (digestHex: string): Buffer => sha256(Buffer.concat([Buffer.from(digestHex, "hex"), A]));

/** A header whose merkle root is `root`, mined at the easiest target so a test does it in a few hashes. */
function mineHeader(root: Uint8Array, time: number): Buffer {
  const h = Buffer.alloc(80);
  h.writeUInt32LE(0x20000000, 0);
  Buffer.from(root).copy(h, 36);
  h.writeUInt32LE(time, 68);
  h.writeUInt32LE(0x207fffff, 72);
  const target = targetOf(0x207fffff)!;
  for (let nonce = 0; ; nonce++) {
    h.writeUInt32LE(nonce, 76);
    if (BigInt(`0x${Buffer.from(sha256d(h)).reverse().toString("hex")}`) <= target) return h;
  }
}

/** What the calendar answers for the commitment once it is in a Bitcoin block: append B, sha256, "bitcoin at HEIGHT". */
function completedTree(height: number): { reply: Buffer } {
  return { reply: tree(leaf({ ops: [{ tag: 0xf0, arg: Bk, child: leaf({ ops: [{ tag: 0x08, child: leaf({ attestations: [{ kind: "bitcoin", height }] }) }] }) }] })) };
}
const rootFor = (commitment: Buffer): Buffer => sha256(Buffer.concat([commitment, Bk]));

async function sealedAndStamped(opts: { entries?: number; formatOne?: boolean } = {}) {
  const w = await world();
  await w.ledger.append("entries", Array.from({ length: opts.entries ?? 2 }, (_, i) => entry(i)));
  await sealNewEntries(w.ctx, w.ledger, { now: () => T0, ...(opts.formatOne ? { format: 1 as const } : {}) });
  const sent: { url: string; digest: Buffer }[] = [];
  const post = async (url: string, digest: Uint8Array): Promise<Uint8Array> => {
    sent.push({ url, digest: Buffer.from(digest) });
    return tree(pendingTree());
  };
  const host = sealHostKey();
  const stamp = await publishSeals(w.ctx, { post, now: () => T0 + 1000 });
  const head = (await readSealChain(w.vault, host)).blocks.at(-1)!;
  return { w, host, sent, post, stamp, head };
}

describe("public timestamps of version 2 blocks", () => {
  it("send the public fingerprint, never the block hash, and log what left", async () => {
    const { w, host, sent, head } = await sealedAndStamped();
    expect(head.v).toBe(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.digest.toString("hex")).toBe((head as SealBlockV2).fp);
    expect(sent[0]!.digest.toString("hex")).not.toBe(head.hash);
    const ots = parseOts(readFileSync(path.join(w.vault, ".vault-meta/cortex/seals", host, "public/000001.ots")));
    expect(hex(ots.digest)).toBe((head as SealBlockV2).fp);
    expect(pendingSteps(ots)).toHaveLength(1);
    expect(hex(pendingSteps(ots)[0]!.msg)).toBe(hex(commitmentOf((head as SealBlockV2).fp)));
    const out = await readOutbound(w.vault, host);
    expect(out).toEqual([{ kind: "stamp", to: "alice.btc.calendar.opentimestamps.org", count: 1, auto: 0, first: new Date(T0 + 1000).toISOString(), last: new Date(T0 + 1000).toISOString() }]);
    // the log holds no digest and no text
    const log = readFileSync(path.join(w.vault, ".vault-meta/cortex/seals", host, "outbound.jsonl"), "utf8");
    expect(log).not.toContain((head as SealBlockV2).fp);
    expect(log).not.toContain("secret entry");
  });

  it("upgrade the pending receipt, verify it against the block header, and keep the old receipt", async () => {
    const { w, host, head } = await sealedAndStamped();
    const digest = blockDigest(head);
    const commitment = commitmentOf(digest);
    const { reply } = completedTree(850_123);
    const header = mineHeader(rootFor(commitment), Math.floor(T0 / 1000) + 3600);
    const calls: string[] = [];
    const headers: number[] = [];
    const get = async (url: string): Promise<Uint8Array | null> => {
      calls.push(url);
      return reply;
    };
    const getHeader = async (h: number): Promise<Uint8Array> => {
      headers.push(h);
      return header;
    };
    const dir = path.join(w.vault, ".vault-meta/cortex/seals", host, "public");
    const before = readFileSync(path.join(dir, "000001.ots"));
    const r = await checkPublicStamps(w.ctx, { get, header: getHeader, now: () => T0 + DAY, minDifficulty: EASY });
    expect(r).toMatchObject({ checked: 1, confirmed: 1, pending: 0, failed: 0, unreachable: false, height: 850_123 });
    // only the commitment hash went to the calendar, only the height to the block service
    expect(calls).toEqual([`${CAL}/timestamp/${hex(commitment)}`]);
    expect(headers).toEqual([850_123]);
    // the new file replaced the pending one, the old one stays beside it
    expect(readdirSync(dir).sort()).toEqual(["000001.json", "000001.ots", "000001.pending.ots"]);
    expect(readFileSync(path.join(dir, "000001.pending.ots"))).toEqual(before);
    const done = parseOts(readFileSync(path.join(dir, "000001.ots")));
    expect(hex(done.digest)).toBe(digest);
    expect(pendingSteps(done)).toHaveLength(0);
    expect(bitcoinSteps(done)[0]).toMatchObject({ att: { height: 850_123 } });
    expect(hex(bitcoinSteps(done)[0]!.msg)).toBe(hex(rootFor(commitment)));
    // status and the reader's evidence say "confirmed", from the stored proof and header, offline
    resetSealCache();
    const st = await sealStatus(w.vault, host);
    expect(st).toMatchObject({ pending: 0, confirmed: { n: 1, height: 850_123 } });
    expect(st.confirmed!.at).toBe(new Date((Math.floor(T0 / 1000) + 3600) * 1000).toISOString());
    expect(await sealEvidenceFor(w.vault, eId(0))).toMatchObject({ timestamped: { height: 850_123 } });
    expect(st.outward.map((o) => [o.kind, o.to, o.count]).sort()).toEqual([
      ["check", "alice.btc.calendar.opentimestamps.org", 1],
      ["header", "blockstream.info", 1],
      ["stamp", "alice.btc.calendar.opentimestamps.org", 1],
    ]);
    // a second check asks nothing
    calls.length = 0;
    const again = await checkPublicStamps(w.ctx, { get, header: getHeader, now: () => T0 + 2 * DAY, minDifficulty: EASY });
    expect(again).toMatchObject({ checked: 0, confirmed: 1 });
    expect(calls).toEqual([]);
  });

  it("keep the receipt and say pending while the calendar has not committed yet", async () => {
    const { w, host } = await sealedAndStamped();
    const dir = path.join(w.vault, ".vault-meta/cortex/seals", host, "public");
    const before = readFileSync(path.join(dir, "000001.ots"));
    const r = await checkPublicStamps(w.ctx, { get: async () => null, header: async () => Buffer.alloc(80), now: () => T0 + DAY });
    expect(r).toMatchObject({ checked: 1, confirmed: 0, pending: 1, failed: 0, unreachable: false });
    expect(readFileSync(path.join(dir, "000001.ots"))).toEqual(before);
    expect(readdirSync(dir).sort()).toEqual(["000001.json", "000001.ots"]);
    expect((await sealStatus(w.vault, host)).pending).toBe(1);
  });

  it("refuse a header that does not carry the proof's value, and a header below the work floor", async () => {
    const { w, host, head } = await sealedAndStamped();
    const commitment = commitmentOf(blockDigest(head));
    const { reply } = completedTree(850_123);
    const wrong = mineHeader(Buffer.alloc(32, 7), Math.floor(T0 / 1000));
    const r1 = await checkPublicStamps(w.ctx, { get: async () => reply, header: async () => wrong, now: () => T0 + DAY, minDifficulty: EASY });
    expect(r1).toMatchObject({ confirmed: 0, failed: 1 });
    expect((await sealStatus(w.vault, host)).confirmed).toBeUndefined();
    // the proof file was completed, so the next check only needs the header; the real floor refuses an easy header
    const easy = mineHeader(rootFor(commitment), Math.floor(T0 / 1000));
    const r2 = await checkPublicStamps(w.ctx, { get: async () => reply, header: async () => easy, now: () => T0 + DAY });
    expect(r2).toMatchObject({ confirmed: 0, failed: 1 });
    const r3 = await checkPublicStamps(w.ctx, { get: async () => reply, header: async () => easy, now: () => T0 + DAY, minDifficulty: EASY });
    expect(r3).toMatchObject({ confirmed: 1, failed: 0 });
  });

  it("report an unreachable service and change nothing", async () => {
    const { w, host } = await sealedAndStamped();
    const down = async (): Promise<never> => {
      throw new Error("offline");
    };
    const r = await checkPublicStamps(w.ctx, { get: down, header: down, now: () => T0 + DAY });
    expect(r).toMatchObject({ confirmed: 0, failed: 1, unreachable: true });
    expect(readdirSync(path.join(w.vault, ".vault-meta/cortex/seals", host, "public")).sort()).toEqual(["000001.json", "000001.ots"]);
  });

  it("ignore a reply that leads nowhere near Bitcoin, and never contact another calendar", async () => {
    const { w, head } = await sealedAndStamped();
    const file = readFileSync(path.join(w.vault, ".vault-meta/cortex/seals", sealHostKey(), "public/000001.ots"));
    const junk = tree(leaf({ attestations: [{ kind: "pending", uri: CAL }] }));
    expect(await upgradeProof(file, CAL, async () => junk)).toMatchObject({ upgraded: 0, stillPending: 1, asked: 1 });
    const other = vi.fn(async () => null);
    expect(await upgradeProof(file, "https://bob.btc.calendar.opentimestamps.org", other)).toMatchObject({ upgraded: 0, asked: 0, stillPending: 1 });
    expect(other).not.toHaveBeenCalled();
    void head;
  });
});

describe("reading proofs safely", () => {
  it("round-trips a tree and refuses broken or hostile input without crashing", () => {
    const d = new Uint8Array(32).fill(5);
    const file = serializeOts({ fileOp: 0x08, digest: d, root: pendingTree() });
    expect(serializeOts(parseOts(file))).toEqual(file);
    expect(() => parseOts(file.subarray(0, file.length - 3))).toThrow();
    expect(() => parseOts(Buffer.concat([file, Buffer.from([0])]))).toThrow();
    expect(() => parseOts(Buffer.from("not a proof"))).toThrow();
    // a path of 400 nested operations is refused, not recursed into
    const deep = Buffer.concat([file.subarray(0, 65), Buffer.alloc(400, 0x08), Buffer.from([0x00])]);
    expect(() => parseOts(deep)).toThrow();
    // a calendar address with odd characters is refused
    const evil = serializeOts({ fileOp: 0x08, digest: d, root: leaf({ attestations: [{ kind: "pending", uri: "https://x/<script>" }] }) });
    expect(() => parseOts(evil)).toThrow();
  });

  it("computes operations the standard way", () => {
    const m = Buffer.from("abcd", "hex");
    expect(hex(applyOp(0x08, undefined, m)!)).toBe(hex(sha256(m)));
    expect(hex(applyOp(0xf0, Buffer.from("ff", "hex"), m)!)).toBe("abcdff");
    expect(hex(applyOp(0xf1, Buffer.from("ff", "hex"), m)!)).toBe("ffabcd");
    expect(applyOp(0x67, undefined, m)).toBeNull(); // keccak is not computed: the branch is left alone
  });
});

// ───────────────────────────── the weekly standing consent ─────────────────────────────

describe("timestamp automatically each week", () => {
  it("sends once a week, marks the send as automatic, and checks later with the same consent", async () => {
    const w = await world();
    await w.ledger.append("entries", [entry(0)]);
    await sealNewEntries(w.ctx, w.ledger, { now: () => T0 });
    const sent: Buffer[] = [];
    const post = async (_u: string, d: Uint8Array): Promise<Uint8Array> => {
      sent.push(Buffer.from(d));
      return tree(pendingTree());
    };
    const host = sealHostKey();
    const r1 = await autoTimestamp(w.ctx, { post, now: () => T0 + 1000, get: async () => null });
    expect(r1).toMatchObject({ stamped: true });
    expect(sent).toHaveLength(1);
    // the same day: nothing more is sent, and a stamp this young is not asked about
    const r2 = await autoTimestamp(w.ctx, { post, now: () => T0 + 2000, get: async () => null });
    expect(r2).toMatchObject({ stamped: false, skipped: "already" });
    // new entries a few days later: not yet a week
    await w.ledger.append("entries", [entry(1)]);
    await sealNewEntries(w.ctx, w.ledger, { now: () => T0 + 3 * DAY });
    const r3 = await autoTimestamp(w.ctx, { post, now: () => T0 + 3 * DAY + 1000, get: async () => null });
    expect(r3).toMatchObject({ stamped: false, skipped: "recent" });
    expect(sent).toHaveLength(1);
    // eight days after the first stamp: the newest block goes out
    const r4 = await autoTimestamp(w.ctx, { post, now: () => T0 + 8 * DAY, get: async () => null });
    expect(r4).toMatchObject({ stamped: true });
    expect(sent).toHaveLength(2);
    const out = await readOutbound(w.vault, host);
    const stamps = out.find((o) => o.kind === "stamp")!;
    expect(stamps).toMatchObject({ count: 2, auto: 2 });
    // the checks since were asked about the first stamp (older than six hours) as automatic ones
    const checks = out.find((o) => o.kind === "check")!;
    expect(checks.auto).toBe(checks.count);
    const st = await sealStatus(w.vault, host);
    expect(st.published).toMatchObject({ n: 2 });
  });

  it("does nothing with nothing sealed, and a service that is down is not an error", async () => {
    const w = await world();
    expect(await autoTimestamp(w.ctx, { post: async () => new Uint8Array(1) })).toMatchObject({ stamped: false, skipped: "none" });
    await w.ledger.append("entries", [entry(0)]);
    await sealNewEntries(w.ctx, w.ledger);
    const post = async (): Promise<Uint8Array> => {
      throw new Error("offline");
    };
    expect(await autoTimestamp(w.ctx, { post })).toMatchObject({ stamped: false });
  });

  function rcWith(w: { vault: string; cache: string }, patch: (s: CortexSettings) => void) {
    const settings: CortexSettings = structuredClone(DEFAULT_SETTINGS);
    patch(settings);
    const ctx: RunnerContext = { vaultRoot: w.vault, vaultKey: "abcdefghijklmnop", cacheDir: w.cache, settings, pluginVersion: "t", settingsSource: "plugin" };
    return { id: "x", ctx, token: createCancelSource().token, host: { mode: "child", emit: () => undefined, log: nullLogger, yield: async () => undefined } as RunnerHost, progress: () => undefined, event: () => undefined };
  }

  it("the command honours the standing consent: off by default, revocable, and gated on sealing", async () => {
    const w = await world();
    await w.ledger.append("entries", [entry(0)]);
    const h = createHandlers();
    expect(DEFAULT_SETTINGS.advanced.dateSeals).toEqual({ sealLocally: true, weeklyStamp: false, signAs: "" });
    await h["seals.run"]({ force: true }, rcWith(w, () => undefined));
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response(new Uint8Array(tree(pendingTree())), { status: 200 });
    });
    // consent not given: no request at all
    expect(await h["seals.auto"]({}, rcWith(w, () => undefined))).toEqual({ enabled: false, stamped: false, checked: false });
    expect(calls).toEqual([]);
    // given
    const on = rcWith(w, (s) => void (s.advanced.dateSeals.weeklyStamp = true));
    expect(await h["seals.auto"]({}, on)).toMatchObject({ enabled: true, stamped: true });
    expect(calls).toEqual([`${CAL}/digest`]);
    // revoked: nothing more, even a week later
    calls.length = 0;
    expect(await h["seals.auto"]({}, rcWith(w, () => undefined))).toMatchObject({ enabled: false });
    expect(calls).toEqual([]);
    // the Access log's data names it as an outward route, automatic
    const st = await h["seals.status"]({}, on);
    expect(st.outward).toEqual([expect.objectContaining({ kind: "stamp", to: "alice.btc.calendar.opentimestamps.org", count: 1, auto: 1 })]);
    // "Check public timestamps" through the command: the calendar says not yet
    vi.stubGlobal("fetch", async () => new Response("pending", { status: 404 }));
    expect(await h["seals.check"]({}, on)).toMatchObject({ checked: 1, pending: 1, confirmed: 0 });
  });
});

// ───────────────────────────── the daily settle ─────────────────────────────

describe("the clock settles seals quietly", () => {
  it("runs the seal and the weekly pass at start and once each day, even with no import", async () => {
    vi.useFakeTimers();
    try {
      let now = new Date(2026, 10, 3, 9, 0, 0).getTime();
      const seals = vi.fn(async () => undefined);
      const weekly = vi.fn(async () => undefined);
      const clock = createAgentsClock({
        now: () => now,
        isBlocked: () => true,
        idleMs: () => 0,
        runAgents: async () => undefined,
        runImport: async () => undefined,
        runSeals: seals,
        runWeeklyStamp: weekly,
        watchTranscripts: () => () => undefined,
        tickMs: 1000,
      });
      clock.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(seals).toHaveBeenCalledTimes(1);
      expect(weekly).toHaveBeenCalledTimes(1);
      // later the same day: no more
      now = new Date(2026, 10, 3, 18, 0, 0).getTime();
      await vi.advanceTimersByTimeAsync(2000);
      expect(seals).toHaveBeenCalledTimes(1);
      // the next day after 03:00: one more settle
      now = new Date(2026, 10, 4, 4, 0, 0).getTime();
      await vi.advanceTimersByTimeAsync(2000);
      expect(seals).toHaveBeenCalledTimes(2);
      expect(weekly).toHaveBeenCalledTimes(2);
      clock.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failing settle never stops the clock", async () => {
    vi.useFakeTimers();
    try {
      const clock = createAgentsClock({
        now: () => new Date(2026, 10, 3, 9, 0, 0).getTime(),
        isBlocked: () => true,
        idleMs: () => 0,
        runAgents: async () => undefined,
        runImport: async () => undefined,
        runSeals: async () => {
          throw new Error("boom");
        },
        watchTranscripts: () => () => undefined,
      });
      clock.start();
      await vi.advanceTimersByTimeAsync(10);
      expect(clock.running).toBe(true);
      clock.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ───────────────────────────── proof bundles ─────────────────────────────

describe("proof bundles", () => {
  it("carry the key, the signature, the salt of the stamped block and the confirmation, and verify on their own", async () => {
    const { w, host, head } = await sealedAndStamped();
    const commitment = commitmentOf(blockDigest(head));
    const { reply } = completedTree(850_123);
    const header = mineHeader(rootFor(commitment), Math.floor(T0 / 1000) + 3600);
    await checkPublicStamps(w.ctx, { get: async () => reply, header: async () => header, now: () => T0 + DAY, minDifficulty: EASY });
    const b = await exportProof(w.ctx, { host });
    expect(b.block.n).toBe(1);
    expect(b.salt).toBe(await readSalt(w.cache, host, 1));
    expect(b.signer).toMatchObject({ publicKey: (head as SealBlockV2).key, fingerprint: keyFingerprint((head as SealBlockV2).key) });
    expect(ed25519Verify(b.signer!.publicKey, b.signer!.statement, b.signer!.signature)).toBe(true);
    expect(b.timestamp?.bitcoin).toMatchObject({ height: 850_123 });
    const v = verifyProofBundle(JSON.parse(JSON.stringify(b)), { minDifficulty: EASY });
    expect(v).toMatchObject({ block: true, links: true, salt: true, digest: true, bitcoin: "confirmed", height: 850_123 });
    // the default floor does not accept this easy header; a tampered bundle fails each part
    expect(verifyProofBundle(b).bitcoin).toBe("invalid");
    const bad = JSON.parse(JSON.stringify(b));
    bad.salt = "00".repeat(32);
    expect(verifyProofBundle(bad, { minDifficulty: EASY }).salt).toBe(false);
    const bad2 = JSON.parse(JSON.stringify(b));
    bad2.block.at = "2020-01-01T00:00:00.000Z";
    expect(verifyProofBundle(bad2, { minDifficulty: EASY }).block).toBe(false);
  });

  it("join an earlier block to the later block that was stamped, revealing only that block's salt", async () => {
    const w = await world();
    const host = sealHostKey();
    await w.ledger.append("entries", [entry(0)]);
    await sealNewEntries(w.ctx, w.ledger, { now: () => T0 });
    await w.ledger.append("entries", [entry(1)]);
    await sealNewEntries(w.ctx, w.ledger, { now: () => T0 + 1000 });
    await publishSeals(w.ctx, { post: async () => tree(pendingTree()), now: () => T0 + 2000 });
    const b = await exportProof(w.ctx, { n: 1 });
    expect(b.links.map((l) => l.n)).toEqual([2]);
    expect(b.timestamp?.n).toBe(2);
    expect(b.salt).toBe(await readSalt(w.cache, host, 2));
    expect(b.salt).not.toBe(await readSalt(w.cache, host, 1));
    expect(verifyProofBundle(b)).toMatchObject({ block: true, links: true, salt: true, digest: true, bitcoin: "pending" });
    const broken = JSON.parse(JSON.stringify(b));
    broken.links[0].prev = "00".repeat(32);
    expect(verifyProofBundle(broken).links).toBe(false);
  });

  it("work for a version 1 block (no salt, no signature)", async () => {
    const { w, head } = await sealedAndStamped({ formatOne: true });
    expect(head.v).toBe(1);
    const b = await exportProof(w.ctx);
    expect(b.salt).toBeUndefined();
    expect(b.signer).toBeUndefined();
    expect(verifyProofBundle(b)).toMatchObject({ block: true, links: true, salt: null, digest: true, bitcoin: "pending" });
  });
});

// ───────────────────────────── what the pages say ─────────────────────────────

describe("what the pages say", () => {
  it("lists timestamp traffic as access rows without reads to trace", () => {
    const rows = outwardAccessRows([
      { kind: "stamp", to: "alice.btc.calendar.opentimestamps.org", count: 3, auto: 2, first: "2026-11-01T10:00:00.000Z", last: "2026-11-20T10:00:00.000Z" },
      { kind: "header", to: "blockstream.info", count: 1, auto: 0, first: "2026-11-02T10:00:00.000Z", last: "2026-11-02T10:00:00.000Z" },
    ]);
    expect(rows.map((r) => [r.model, r.route, r.itemsRead])).toEqual([
      ["Timestamp fingerprint (2 automatic)", "alice.btc.calendar.opentimestamps.org · fingerprint only", 3],
      ["Block lookup", "blockstream.info · block number only", 1],
    ]);
  });

  it("says confirmed with the Bitcoin block once a timestamp was checked, and keeps the pending wording before", () => {
    const fmt = makeFmt("d MMM yyyy", 1, T0);
    expect(evidenceLine({ kind: "timestamped", at: "2026-11-03T14:00:00.000Z", strength: "provable" }, "x", fmt)).toMatch(/^Timestamped publicly on .+ · provable bound$/);
    expect(evidenceLine({ kind: "timestamped", at: "2026-11-03T15:00:00.000Z", strength: "provable", height: 850123 }, "x", fmt)).toMatch(/^Confirmed in Bitcoin block 850123 on .+ · provable bound$/);
  });
});
