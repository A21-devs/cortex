/**
 * The seal key store follows the record: the signing seed is wrapped by the vault key while the record is encrypted,
 * and the per-block salts live in the vault Cortex folder (encrypted with the record) with a migration that
 * copies salts an earlier version kept only in the cache. Temp folders only.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { nullLogger } from "../src/shared/log";
import { generateVaultKey } from "../src/shared/crypto/vaultKey";
import { dropVaultKey, holdVaultKey, resetKeyring, setEncryptionConfigured } from "../src/shared/crypto/keyring";
import { convertRecord, listRecordFiles } from "../src/store/encryptRecord";
import { openStoreContext } from "../src/store/layout";
import { createLedgerStore } from "../src/store/ledger";
import { readSealChain, resetSealCache, sealHostKey, sealNewEntries } from "../src/store/dateEvidence";
import { loadOrCreateSigningKey, migrateSalts, newSalt, readSalt, saveSalts } from "../src/node/sign";
import type { EntryRecord } from "../src/shared/types";

const dirs: string[] = [];
const tmp = (n: string): string => {
  const d = mkdtempSync(path.join(tmpdir(), `cx-keys-${n}-`));
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

const B32 = "bcdefghijklmnopq";
const eId = (n: number): EntryRecord["id"] => `e_${"a".repeat(14)}${B32[Math.floor(n / 16)]}${B32[n % 16]}` as EntryRecord["id"];
const sha = (t: string): string => createHash("sha256").update(t).digest("hex");
const T0 = Date.UTC(2026, 10, 3, 14, 0, 0);
function entry(n: number): EntryRecord {
  const text = `entry number ${n}`;
  return {
    v: 1, id: eId(n), kind: "message", source: "claude-code", sourceRef: { path: "x.jsonl", nativeId: `n${n}`, sha256: sha(text) }, conv: "c_aaaaaaaaaaaaaaaa", idx: n, speaker: "you",
    text: { store: "stage", conv: "c_aaaaaaaaaaaaaaaa", line: n }, textSha256: sha(text), chars: text.length, words: 3, dates: [], existedBy: new Date(T0 + n * 60_000).toISOString(),
    addedAt: new Date(T0 + n * 60_000).toISOString(), writtenAt: new Date(T0 + n * 60_000).toISOString(), space: "roblox", folder: ["proj"],
  } as unknown as EntryRecord;
}

async function world() {
  const vault = tmp("vault");
  const cache = tmp("cache");
  const ctx = await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
  return { vault, cache, ctx, ledger: createLedgerStore(ctx) };
}
const signingPath = (cache: string): string => path.join(cache, "keys/seal-signing.json");
const saltsPath = (vault: string, host: string): string => path.join(vault, ".vault-meta/cortex/seals", host, "salts.json");

describe("the signing seed while the record is encrypted", () => {
  it("a plain record keeps the plain version 1 file", async () => {
    const w = await world();
    const k = await loadOrCreateSigningKey(w.cache);
    const file = JSON.parse(readFileSync(signingPath(w.cache), "utf8"));
    expect(file).toMatchObject({ v: 1, seed: k.seed });
  });

  it("a new key is wrapped by the vault key and the seed is nowhere in the file", async () => {
    const w = await world();
    setEncryptionConfigured(true);
    holdVaultKey(generateVaultKey());
    const k = await loadOrCreateSigningKey(w.cache);
    const text = readFileSync(signingPath(w.cache), "utf8");
    expect(JSON.parse(text)).toMatchObject({ v: 2, publicKey: k.publicKey });
    expect(text).not.toContain(k.seed);
    const again = await loadOrCreateSigningKey(w.cache);
    expect(again).toMatchObject({ seed: k.seed, publicKey: k.publicKey, created: false });
  });

  it("a locked record cannot sign, and unlocking brings the same key back", async () => {
    const w = await world();
    const key = generateVaultKey();
    setEncryptionConfigured(true);
    holdVaultKey(key);
    const k = await loadOrCreateSigningKey(w.cache);
    dropVaultKey();
    await expect(loadOrCreateSigningKey(w.cache)).rejects.toMatchObject({ code: "E_LOCKED" });
    holdVaultKey(key);
    expect((await loadOrCreateSigningKey(w.cache)).seed).toBe(k.seed);
  });

  it("an older plain file is wrapped the first time the key is held, keeping the same key", async () => {
    const w = await world();
    const k = await loadOrCreateSigningKey(w.cache);
    setEncryptionConfigured(true);
    holdVaultKey(generateVaultKey());
    expect((await loadOrCreateSigningKey(w.cache)).publicKey).toBe(k.publicKey);
    const text = readFileSync(signingPath(w.cache), "utf8");
    expect(JSON.parse(text).v).toBe(2);
    expect(text).not.toContain(k.seed);
  });

  it("encrypting the record wraps the seed and decrypting gives the plain file back", async () => {
    const w = await world();
    await w.ledger.append("entries", [entry(0), entry(1)]);
    await sealNewEntries(w.ctx, w.ledger, { now: () => T0 + 1000 });
    const k = await loadOrCreateSigningKey(w.cache);
    expect(JSON.parse(readFileSync(signingPath(w.cache), "utf8")).v).toBe(1);

    const key = generateVaultKey();
    setEncryptionConfigured(true);
    holdVaultKey(key);
    expect((await convertRecord(w.ctx, { direction: "encrypt", key })).ok).toBe(true);
    const wrapped = readFileSync(signingPath(w.cache), "utf8");
    expect(JSON.parse(wrapped).v).toBe(2);
    expect(wrapped).not.toContain(k.seed);

    expect((await convertRecord(w.ctx, { direction: "decrypt", key })).ok).toBe(true);
    expect(JSON.parse(readFileSync(signingPath(w.cache), "utf8"))).toMatchObject({ v: 1, seed: k.seed });
  });
});

describe("the salts kept with the record", () => {
  it("sealing writes each salt into the seals folder of this computer, and the cache keeps a copy", async () => {
    const w = await world();
    await w.ledger.append("entries", [entry(0), entry(1)]);
    const host = sealHostKey();
    await sealNewEntries(w.ctx, w.ledger, { now: () => T0 + 1000 });
    const file = JSON.parse(readFileSync(saltsPath(w.vault, host), "utf8"));
    expect(file.v).toBe(1);
    const salt = file.salts["1"] as string;
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(await readSalt(w.cache, host, 1, w.vault)).toBe(salt);
    expect(await readSalt(w.cache, host, 1)).toBe(salt);
    // the chain still reads (the salts file is not a block)
    expect((await readSealChain(w.vault, host)).broken).toBe(false);
  });

  it("migration copies salts an earlier version kept only in the cache, and is safe to repeat", async () => {
    const w = await world();
    const host = sealHostKey();
    const a = newSalt();
    const b = newSalt();
    await saveSalts(w.cache, { [`${host}/1`]: a, [`${host}/2`]: b }); // the older, cache-only way
    expect(existsSync(saltsPath(w.vault, host))).toBe(false);
    expect(await migrateSalts(w.cache, w.vault)).toBe(2);
    expect(JSON.parse(readFileSync(saltsPath(w.vault, host), "utf8")).salts).toEqual({ "1": a, "2": b });
    expect(await migrateSalts(w.cache, w.vault)).toBe(0);
    // the cache copy is left alone
    expect(await readSalt(w.cache, host, 2)).toBe(b);
  });

  it("reading a salt that only the cache holds copies it into the record", async () => {
    const w = await world();
    const host = sealHostKey();
    const a = newSalt();
    await saveSalts(w.cache, { [`${host}/3`]: a });
    expect(await readSalt(w.cache, host, 3, w.vault)).toBe(a);
    expect(JSON.parse(readFileSync(saltsPath(w.vault, host), "utf8")).salts["3"]).toBe(a);
  });

  it("sealing migrates earlier cache-only salts before it makes new blocks", async () => {
    const w = await world();
    const host = sealHostKey();
    const old = newSalt();
    await saveSalts(w.cache, { [`${host}/1`]: old });
    await w.ledger.append("entries", [entry(0)]);
    await sealNewEntries(w.ctx, w.ledger, { now: () => T0 + 1000, format: 1 });
    expect(JSON.parse(readFileSync(saltsPath(w.vault, host), "utf8")).salts["1"]).toBe(old);
  });

  it("an encrypted record encrypts the salts file with it", async () => {
    const w = await world();
    const host = sealHostKey();
    await w.ledger.append("entries", [entry(0), entry(1)]);
    await sealNewEntries(w.ctx, w.ledger, { now: () => T0 + 1000 });
    const salt = (await readSalt(w.cache, host, 1, w.vault))!;
    expect(readFileSync(saltsPath(w.vault, host), "utf8")).toContain(salt);
    expect((await listRecordFiles(w.vault)).some((f) => f.rel.endsWith("/salts.json"))).toBe(true);

    const key = generateVaultKey();
    setEncryptionConfigured(true);
    holdVaultKey(key);
    expect((await convertRecord(w.ctx, { direction: "encrypt", key })).ok).toBe(true);
    expect(readFileSync(saltsPath(w.vault, host)).toString("latin1")).not.toContain(salt);
    expect(await readSalt(w.cache, host, 1, w.vault)).toBe(salt);

    // new salts written while the key is held are encrypted too
    await w.ledger.append("entries", [entry(2)]);
    await sealNewEntries(w.ctx, w.ledger, { now: () => T0 + 2000 });
    const s2 = (await readSalt(w.cache, host, 2, w.vault))!;
    expect(readFileSync(saltsPath(w.vault, host)).toString("latin1")).not.toContain(s2);

    expect((await convertRecord(w.ctx, { direction: "decrypt", key })).ok).toBe(true);
    expect(JSON.parse(readFileSync(saltsPath(w.vault, host), "utf8")).salts).toMatchObject({ "1": salt, "2": s2 });
  });

  it("a file in the seals folder that is not a block or salts is left alone by the record listing", async () => {
    const w = await world();
    const host = sealHostKey();
    mkdirSync(path.join(w.vault, ".vault-meta/cortex/seals", host), { recursive: true });
    writeFileSync(path.join(w.vault, ".vault-meta/cortex/seals", host, "notes.json"), "{}");
    expect((await listRecordFiles(w.vault)).some((f) => f.rel.endsWith("notes.json"))).toBe(false);
  });
});
