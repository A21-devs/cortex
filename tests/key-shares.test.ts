/**
 * Splitting the record key: the split (passphrase asked again, the local share kept outside the vault), testing a share without
 * the key leaving, and recovery after a lost passphrase. Real key files on temp folders; no network, no model.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { dropVaultKey, heldVaultKey, recordKeyState, resetKeyring, setEncryptionConfigured } from "../src/shared/crypto/keyring";
import { decodeShare, shareChecksum, shareToQrText, shareToWords } from "../src/shared/crypto/shamir";
import { keyId, sameBytes, unwrapVaultKey } from "../src/shared/crypto/vaultKey";
import { createLocalShareStore } from "../src/node/shareStore";
import { createRecordKeyAccess } from "../src/node/vaultKeyStore";
import { nullLogger } from "../src/shared/log";
import { openStoreContext } from "../src/store/layout";
import { createRecordKey } from "../src/plugin/recordKeys";
import { createShareSet, recoverFromShares, splitRecordKey, testShares } from "../src/plugin/keyShares";
import { endShareSession, shareSession, startShareSession } from "../src/plugin/shareSession";

const dirs: string[] = [];
const tmp = (n: string): string => {
  const d = mkdtempSync(path.join(tmpdir(), `cx-shares-${n}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  endShareSession();
  resetKeyring();
});

const PASS = "correct horse battery";

async function world() {
  const vault = tmp("vault");
  const cache = tmp("cache");
  await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
  const access = createRecordKeyAccess({ vaultRoot: vault, cacheDir: cache });
  const store = createLocalShareStore(cache);
  const made = await createRecordKey(access, PASS);
  if (!made.ok) throw new Error("no key");
  setEncryptionConfigured(true);
  const { holdVaultKey } = await import("../src/shared/crypto/keyring");
  holdVaultKey(made.key);
  const id = made.envelope.keyId;
  return { vault, cache, access, store, key: Uint8Array.from(made.key), id };
}

describe("making a share set", () => {
  it("proves every group of k rebuilds the key before returning", async () => {
    const w = await world();
    const set = await createShareSet(w.key, 3, 5);
    expect(set.shares.length).toBe(5);
    expect(set.k).toBe(3);
    expect(set.keyId).toBe(w.id);
    expect(set.checksums).toEqual(set.shares.map(shareChecksum));
  });
});

describe("splitting the open record's key", () => {
  it("needs the record open and the right passphrase, then keeps share 1 outside the vault", async () => {
    const w = await world();
    dropVaultKey();
    expect(await splitRecordKey(w.access, w.store, PASS, 2, 3)).toEqual({ ok: false, reason: "closed" });
    const { holdVaultKey } = await import("../src/shared/crypto/keyring");
    holdVaultKey(w.key);
    expect(await splitRecordKey(w.access, w.store, "not the passphrase", 2, 3)).toEqual({ ok: false, reason: "wrong-passphrase" });
    expect(await w.store.read()).toBeNull();
    expect(await splitRecordKey(w.access, w.store, PASS, 1, 3)).toEqual({ ok: false, reason: "range" });
    const r = await splitRecordKey(w.access, w.store, PASS, 2, 3);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const local = await w.store.read();
    expect(local && sameBytes(local, r.set.shares[0] as Uint8Array)).toBe(true);
    // nothing of the shares or the key landed in the vault, and the cache holds only the one local share
    const inVault = JSON.stringify(readdirSync(w.vault, { recursive: true }));
    expect(inVault).not.toContain("share");
    const file = readFileSync(path.join(w.cache, "keys", "vault-share.local.json"), "utf8");
    expect(file).not.toContain(Buffer.from(w.key).toString("base64"));
    // the key is still held, unchanged
    expect(sameBytes(heldVaultKey() as Uint8Array, w.key)).toBe(true);
  });

  it("a damaged local share file reads as absent, never as a share", async () => {
    const w = await world();
    const r = await splitRecordKey(w.access, w.store, PASS, 2, 3);
    expect(r.ok).toBe(true);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(w.cache, "keys", "vault-share.local.json"), "{\"v\":1,\"share\":\"AAAA\"}\n");
    expect(await w.store.read()).toBeNull();
    writeFileSync(path.join(w.cache, "keys", "vault-share.local.json"), "not json");
    expect(await w.store.read()).toBeNull();
  });

  it("the share session keeps the shares in memory only and ends when the record locks", async () => {
    const w = await world();
    const r = await splitRecordKey(w.access, w.store, PASS, 2, 3);
    if (!r.ok) throw new Error("split failed");
    startShareSession(r.set);
    expect(shareSession()?.n).toBe(3);
    dropVaultKey();
    expect(shareSession()).toBeNull();
    expect(recordKeyState()).toBe("locked");
  });
});

describe("testing a share without showing the key", () => {
  it("proves a share with the local one (2 of 3) and says what is missing otherwise", async () => {
    const w = await world();
    const r = await splitRecordKey(w.access, w.store, PASS, 2, 3);
    if (!r.ok) throw new Error("split failed");
    const local = r.set.shares[0] as Uint8Array;
    const two = shareToWords(r.set.shares[1] as Uint8Array).join(" ");
    const three = shareToQrText(r.set.shares[2] as Uint8Array);
    const proven = await testShares([two], local, w.id);
    expect(proven).toMatchObject({ ok: true, proven: true, have: 2, need: 2, usedLocal: true });
    expect(await testShares([three], local, w.id)).toMatchObject({ ok: true, proven: true, points: [1, 3] });
    // without the local share one share only shows that it is well formed and belongs here
    expect(await testShares([two], null, w.id)).toMatchObject({ ok: true, proven: false, have: 1, need: 2 });
    expect(await testShares([two, three], null, w.id)).toMatchObject({ ok: true, proven: true, points: [2, 3] });
    // the result never carries key bytes
    expect(JSON.stringify(proven)).not.toContain(Buffer.from(w.key).toString("hex"));
    expect(Object.keys(proven as object).sort()).toEqual(["have", "need", "ok", "points", "proven", "usedLocal"]);
  });

  it("rejects an unreadable share, another record's share, mixed sets and nothing at all", async () => {
    const w = await world();
    const r = await splitRecordKey(w.access, w.store, PASS, 2, 3);
    if (!r.ok) throw new Error("split failed");
    const local = r.set.shares[0] as Uint8Array;
    const words = shareToWords(r.set.shares[1] as Uint8Array);
    expect(await testShares([words.slice(0, 20).join(" ")], local, w.id)).toMatchObject({ ok: false, reason: "unreadable", index: 0, why: "length" });
    const typo = [...words.slice(0, 5), words[5] === "able" ? "acid" : "able", ...words.slice(6)];
    expect(await testShares([typo.join(" ")], local, w.id)).toMatchObject({ ok: false, reason: "unreadable", why: "check" });
    expect(await testShares([words.join(" ")], local, "ffffffffffffffff")).toEqual({ ok: false, reason: "other-record" });
    expect(await testShares([], null, w.id)).toEqual({ ok: false, reason: "none" });
    // a second split of the same key: its share does not belong with the first set's local share
    const again = await createShareSet(w.key, 2, 3);
    const mixed = await testShares([shareToWords(again.shares[1] as Uint8Array).join(" ")], local, w.id);
    expect(mixed).toEqual({ ok: false, reason: "wrong" });
  });
});

describe("recovering after a lost passphrase", () => {
  it("rebuilds the key from the local share and one handed-out share, sets a new passphrase and opens the record", async () => {
    const w = await world();
    const r = await splitRecordKey(w.access, w.store, PASS, 2, 3);
    if (!r.ok) throw new Error("split failed");
    dropVaultKey();
    expect(recordKeyState()).toBe("locked");
    const local = await w.store.read();
    const handed = shareToWords(r.set.shares[2] as Uint8Array).join(" ");
    expect(await recoverFromShares(w.access, [handed], local, "short", { encrypted: true })).toEqual({ ok: false, reason: "weak" });
    expect(await recoverFromShares(w.access, [], null, "a new passphrase!", { encrypted: true })).toEqual({ ok: false, reason: "none" });
    expect(await recoverFromShares(w.access, [handed], null, "a new passphrase!", { encrypted: true })).toMatchObject({ ok: false, reason: "few", need: 2 });
    const done = await recoverFromShares(w.access, [handed], local, "a new passphrase!", { encrypted: true });
    expect(done).toEqual({ ok: true });
    expect(recordKeyState()).toBe("open");
    expect(sameBytes(heldVaultKey() as Uint8Array, w.key)).toBe(true);
    const env = await w.access.readEnvelope();
    if (env.state !== "ok") throw new Error("no envelope");
    expect(env.envelope.keyId).toBe(w.id);
    expect(await unwrapVaultKey(env.envelope, PASS)).toBeNull();
    const reopened = await unwrapVaultKey(env.envelope, "a new passphrase!");
    expect(reopened && sameBytes(reopened, w.key)).toBe(true);
  });

  it("refuses shares of another record or a wrong set and leaves the old passphrase working", async () => {
    const w = await world();
    const r = await splitRecordKey(w.access, w.store, PASS, 2, 3);
    if (!r.ok) throw new Error("split failed");
    dropVaultKey();
    const local = await w.store.read();
    const again = await createShareSet(w.key, 2, 3);
    const stranger = await createShareSet(new Uint8Array(32).fill(7), 2, 3);
    const otherSet = shareToWords(again.shares[1] as Uint8Array).join(" ");
    expect(await recoverFromShares(w.access, [otherSet], local, "a new passphrase!", { encrypted: true })).toEqual({ ok: false, reason: "wrong" });
    expect(await recoverFromShares(w.access, [shareToWords(stranger.shares[1] as Uint8Array).join(" ")], local, "a new passphrase!", { encrypted: true })).toMatchObject({ ok: false, reason: "mixed" });
    expect(recordKeyState()).toBe("locked");
    const env = await w.access.readEnvelope();
    if (env.state !== "ok") throw new Error("no envelope");
    expect(await unwrapVaultKey(env.envelope, PASS)).not.toBeNull();
  });

  it("restores the old envelope when the new one cannot be written", async () => {
    const w = await world();
    const r = await splitRecordKey(w.access, w.store, PASS, 2, 3);
    if (!r.ok) throw new Error("split failed");
    dropVaultKey();
    const local = await w.store.read();
    const before = await w.access.readEnvelope();
    let writes = 0;
    const flaky = {
      ...w.access,
      writeEnvelope: async (e: Parameters<typeof w.access.writeEnvelope>[0]) => {
        writes++;
        if (writes === 1) throw new Error("disk full");
        return w.access.writeEnvelope(e);
      },
    };
    const out = await recoverFromShares(flaky, [shareToWords(r.set.shares[1] as Uint8Array).join(" ")], local, "a new passphrase!", { encrypted: true });
    expect(out).toEqual({ ok: false, reason: "write" });
    expect(await w.access.readEnvelope()).toEqual(before);
    expect(recordKeyState()).toBe("locked");
  });

  it("says so when the record is not encrypted", async () => {
    const vault = tmp("v2");
    const cache = tmp("c2");
    await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
    const access = createRecordKeyAccess({ vaultRoot: vault, cacheDir: cache });
    const set = await createShareSet(new Uint8Array(32).fill(3), 2, 3);
    const w = shareToWords(set.shares[1] as Uint8Array).join(" ");
    expect(await recoverFromShares(access, [w], set.shares[0] as Uint8Array, "a new passphrase!", { encrypted: false })).toEqual({ ok: false, reason: "not-encrypted" });
    expect(decodeShare(set.shares[0] as Uint8Array).ok).toBe(true);
    expect(await keyId(new Uint8Array(32).fill(3))).toBe(set.keyId);
  });
});
