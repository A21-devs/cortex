/**
 * The lock and the key: unlocking with the passphrase and with this Windows account, Lock now dropping the key, the
 * envelope on disk, passphrase changes, and the whole Encrypt my record / Remove encryption flow on temp folders.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OsKeyBridge } from "../src/shared/crypto/access";
import { dropVaultKey, encryptionConfigured, heldVaultKey, recordKeyState, resetKeyring, setEncryptionConfigured } from "../src/shared/crypto/keyring";
import { generateVaultKey, toBase64, fromBase64, wrapVaultKey } from "../src/shared/crypto/vaultKey";
import { hashPassphrase, type LockRecord } from "../src/shared/lock";
import { nullLogger } from "../src/shared/log";
import { createRecordKeyAccess, ENVELOPE_REL } from "../src/node/vaultKeyStore";
import { createDesktopOsKeyForTest } from "./helpers/osKey";
import { allowAccountUnlock, createRecordKey, rewrapRecordKey } from "../src/plugin/recordKeys";
import { checkEncryption, encryptMyRecord, removeEncryption } from "../src/plugin/recordEncryptionFlow";
import { appLocked, clickLifts, lockApp, recordOpen, tryUnlock, tryUnlockWithAccount, unlockApp } from "../src/state/lock";
import { nextStep, startStep, unlockMethods } from "../src/ui/stage/lockCard";
import { cacheLayout, openStoreContext } from "../src/store/layout";
import { createLedgerStore, listLedgerFiles } from "../src/store/ledger";
import { listBackups } from "../src/store/encryptRecord";
import { readSegment, writeSegment } from "../src/store/segments";
import type { EntryRecord, SegmentLine } from "../src/shared/types";

const dirs: string[] = [];
const tmp = (n: string): string => {
  const d = mkdtempSync(path.join(tmpdir(), `cx-flow-${n}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  resetKeyring();
  unlockApp();
});
afterEach(() => {
  resetKeyring();
  unlockApp();
});

const CONV = "c_aaaaaaaaaaaaaaaa" as const;
const sha = (t: string): string => createHash("sha256").update(t).digest("hex");
const eId = (n: number): EntryRecord["id"] => `e_${"a".repeat(14)}${"bcdefghijklmnopq"[n % 16]}${"bcdefghijklmnopq"[Math.floor(n / 16)]}` as EntryRecord["id"];
const entry = (n: number): EntryRecord =>
  ({ v: 1, id: eId(n), kind: "message", source: "claude-code", sourceRef: { path: "x.jsonl", nativeId: `n${n}`, sha256: sha(`t${n}`) }, conv: CONV, idx: n, speaker: "you", text: { store: "stage", conv: CONV, line: n }, textSha256: sha(`t${n}`), chars: 2, words: 1, dates: [], existedBy: "2026-11-03T14:00:00.000Z", addedAt: "2026-11-03T14:00:00.000Z", writtenAt: "2026-11-03T14:00:00.000Z", space: "zebra-space", folder: ["x"] }) as unknown as EntryRecord;
const segLine = (i: number): SegmentLine => ({ v: 1, id: eId(i), nid: `n${i}`, conv: CONV, i, sp: "you", text: `words ${i}`, sha: sha(`words ${i}`) }) as unknown as SegmentLine;

async function world(osAvailable = true) {
  const vault = tmp("vault");
  const cache = tmp("cache");
  const ctx = await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
  const ledger = createLedgerStore(ctx);
  await ledger.append("entries", [entry(0), entry(1)]);
  await writeSegment(ctx, { source: "claude-code", monthKey: "2026-11", conv: CONV, lines: [segLine(0)] });
  const os = createDesktopOsKeyForTest(osAvailable);
  const access = createRecordKeyAccess({ vaultRoot: vault, cacheDir: cache, os });
  return { vault, cache, ctx, ledger, access, os };
}

function settingsBox(lock: LockRecord = { salt: "", hash: "", iterations: 210_000 }) {
  const s = { record: { encryption: { enabled: false, kdfVersion: 1 } }, privacy: { lock: { ...lock, autoLockMinutes: 0 } } };
  return { s, update: async (patch: (x: typeof s) => void) => void patch(s), lock: () => s.privacy.lock as LockRecord };
}

describe("the key file", () => {
  it("stores the passphrase envelope in the vault and reads it back; a damaged file is reported, not guessed at", async () => {
    const w = await world();
    expect((await w.access.readEnvelope()).state).toBe("none");
    const made = await createRecordKey(w.access, "a long enough passphrase");
    expect(made.ok).toBe(true);
    const r = await w.access.readEnvelope();
    expect(r.state).toBe("ok");
    writeFileSync(path.join(w.vault, ENVELOPE_REL), "{ not json");
    expect((await w.access.readEnvelope()).state).toBe("damaged");
    await w.access.removeEnvelope();
    expect((await w.access.readEnvelope()).state).toBe("none");
  }, 20_000);

  it("refuses a short passphrase and writes nothing", async () => {
    const w = await world();
    expect(await createRecordKey(w.access, "short")).toEqual({ ok: false, reason: "weak" });
    expect((await w.access.readEnvelope()).state).toBe("none");
  });

  it("changing the passphrase wraps the same key again: the old one stops working, the new one opens", async () => {
    const w = await world();
    const made = await createRecordKey(w.access, "first passphrase");
    if (!made.ok) throw new Error("no key");
    expect(await rewrapRecordKey(w.access, "wrong passphrase", "second passphrase")).toBe(false);
    expect(await rewrapRecordKey(w.access, "first passphrase", "short")).toBe(false);
    expect(await rewrapRecordKey(w.access, "first passphrase", "second passphrase")).toBe(true);
    setEncryptionConfigured(true);
    expect(await tryUnlock("first passphrase", { salt: "", hash: "", iterations: 1 }, w.access)).toBe(false);
    expect(await tryUnlock("second passphrase", { salt: "", hash: "", iterations: 1 }, w.access)).toBe(true);
    expect(Buffer.from(heldVaultKey() as Uint8Array).equals(Buffer.from(made.key))).toBe(true); // the same vault key
  }, 40_000);
});

describe("unlock and lock", () => {
  it("an unencrypted record: the passphrase check is the old one and Lock now drops nothing", async () => {
    const rec = await hashPassphrase("hello there", 1000);
    lockApp();
    expect(await tryUnlock("nope", rec)).toBe(false);
    expect(appLocked.value).toBe(true);
    expect(await tryUnlock("hello there", rec)).toBe(true);
    expect(appLocked.value).toBe(false);
    expect(clickLifts({ salt: "", hash: "" })).toBe(true);
  });

  it("an encrypted record opens with the passphrase, 'Lock now' drops the key, a wrong passphrase leaves it shut", async () => {
    const w = await world();
    const made = await createRecordKey(w.access, "open sesame please");
    if (!made.ok) throw new Error("no key");
    made.key.fill(0);
    setEncryptionConfigured(true);
    lockApp();
    expect(recordKeyState()).toBe("locked");
    expect(clickLifts({ salt: "", hash: "" })).toBe(false); // a click no longer lifts an encrypted lock
    expect(await tryUnlock("wrong wrong", { salt: "", hash: "", iterations: 1 }, w.access)).toBe(false);
    expect(await tryUnlock("open sesame please", { salt: "", hash: "", iterations: 1 })).toBe(false); // no access, no unlock
    expect(appLocked.value).toBe(true);
    expect(recordKeyState()).toBe("locked");
    expect(await tryUnlock("open sesame please", { salt: "", hash: "", iterations: 1 }, w.access)).toBe(true);
    expect(appLocked.value).toBe(false);
    expect(recordKeyState()).toBe("open");
    expect(recordOpen.value).toBe(true);
    lockApp();
    expect(heldVaultKey()).toBeNull();
    expect(recordOpen.value).toBe(false);
    expect(recordKeyState()).toBe("locked");
  }, 30_000);

  it("a damaged key file never opens anything", async () => {
    const w = await world();
    mkdirSync(path.dirname(path.join(w.vault, ENVELOPE_REL)), { recursive: true });
    writeFileSync(path.join(w.vault, ENVELOPE_REL), "garbage");
    setEncryptionConfigured(true);
    lockApp();
    expect(await tryUnlock("anything at all", { salt: "", hash: "", iterations: 1 }, w.access)).toBe(false);
    expect(recordKeyState()).toBe("locked");
  });

  it("this Windows account: sealed once, opens without the passphrase, refuses a copy for another key, and can be withdrawn", async () => {
    const w = await world();
    const made = await createRecordKey(w.access, "windows account test");
    if (!made.ok) throw new Error("no key");
    setEncryptionConfigured(true);
    expect(await w.access.osReady()).toBe(false); // nothing sealed yet
    lockApp();
    expect(await tryUnlockWithAccount(w.access)).toBe(false);
    // unlock with the passphrase, then allow the account
    expect(await tryUnlock("windows account test", { salt: "", hash: "", iterations: 1 }, w.access)).toBe(true);
    expect(await allowAccountUnlock(w.access)).toBe(true);
    expect(await w.access.osReady()).toBe(true);
    const blob = readFileSync(path.join(w.cache, "keys", "vault-key.os.json"), "utf8");
    expect(blob).not.toContain(Buffer.from(made.key).toString("hex"));
    lockApp();
    expect(heldVaultKey()).toBeNull();
    expect(await tryUnlockWithAccount(w.access)).toBe(true);
    expect(recordKeyState()).toBe("open");
    // a sealed copy of some other key is not accepted
    lockApp();
    const stray = generateVaultKey();
    const strayBlob = await w.os.protect(stray);
    writeFileSync(path.join(w.cache, "keys", "vault-key.os.json"), JSON.stringify({ v: 1, keyId: (await w.access.readEnvelope()).state === "ok" ? ((await w.access.readEnvelope()) as { envelope: { keyId: string } }).envelope.keyId : "", blob: strayBlob }));
    expect(await tryUnlockWithAccount(w.access)).toBe(false);
    expect(recordKeyState()).toBe("locked");
    await w.access.removeOs();
    expect(await w.access.osReady()).toBe(false);
  }, 30_000);

  it("the account method is hidden where the system cannot seal keys", async () => {
    const w = await world(false);
    expect(await w.access.osOffered()).toBe(false);
    const made = await createRecordKey(w.access, "no windows here");
    if (!made.ok) throw new Error("no key");
    setEncryptionConfigured(true);
    expect(await tryUnlock("no windows here", { salt: "", hash: "", iterations: 1 }, w.access)).toBe(true);
    expect(await allowAccountUnlock(w.access)).toBe(false);
    expect(await w.access.osReady()).toBe(false);
  }, 20_000);
});

describe("the unlock card's methods", () => {
  const none = { salt: "", hash: "" };
  it("an encrypted record has no blank lift: the account (when ready) and the passphrase", () => {
    expect(unlockMethods(none, { encrypted: true }).map((m) => m.id)).toEqual(["passphrase"]);
    expect(unlockMethods(none, { encrypted: true, account: true }).map((m) => m.id)).toEqual(["account", "passphrase"]);
    expect(startStep(unlockMethods(none, { encrypted: true }))).toBe("secret");
    const both = unlockMethods(none, { encrypted: true, account: true });
    expect(startStep(both)).toBe("choose");
    expect(nextStep("choose", "use-secret", both)).toBe("secret");
    expect(nextStep("secret", "cancel", both)).toBe("choose");
  });
  it("a plain record keeps today's list", () => {
    expect(unlockMethods(none).map((m) => m.id)).toEqual(["blank"]);
    expect(unlockMethods({ salt: "ab", hash: "cd" }).map((m) => m.id)).toEqual(["passphrase"]);
  });
});

describe("Encrypt my record, start to finish", () => {
  it("the dry run changes nothing", async () => {
    const w = await world();
    const plan = await checkEncryption(w.ctx);
    expect(plan.toConvert).toBe(plan.files);
    expect(encryptionConfigured()).toBe(false);
    expect((await w.access.readEnvelope()).state).toBe("none");
    expect(await listBackups(w.cache)).toEqual([]);
  });

  it("encrypts, keeps a backup, saves the settings, and the record reads while open and not while locked", async () => {
    const w = await world();
    const box = settingsBox();
    const out = await encryptMyRecord({ access: w.access, ctx: w.ctx, lock: box.lock, update: box.update }, "a good passphrase");
    expect(out).toMatchObject({ ok: true });
    expect(box.s.record.encryption).toEqual({ enabled: true, kdfVersion: 2 });
    expect(box.s.privacy.lock.hash).not.toBe(""); // no lock passphrase yet: the encryption passphrase became the lock
    expect(recordKeyState()).toBe("open");
    expect((await listBackups(w.cache)).length).toBe(1);
    const seen: unknown[] = [];
    for await (const r of w.ledger.readAll("entries")) seen.push(r);
    expect(seen).toHaveLength(2);
    // a new entry written now is encrypted on disk
    await w.ledger.append("entries", [entry(5)]);
    const shard = (await listLedgerFiles(w.vault, "entries"))[0]!;
    expect(readFileSync(shard.abs, "utf8")).not.toContain("zebra-space");
    lockApp();
    const locked: unknown[] = [];
    for await (const r of w.ledger.readAll("entries")) locked.push(r);
    expect(locked).toEqual([]);
    // unlock through the card's path and read the lot back, including the encrypted segment
    expect(await tryUnlock("a good passphrase", box.lock(), w.access)).toBe(true);
    const all: unknown[] = [];
    for await (const r of w.ledger.readAll("entries")) all.push(r);
    expect(all).toHaveLength(3);
    const segs = (await listBackups(w.cache)).length;
    expect(segs).toBe(1);
    expect((await readSegment(w.vault, ".raw/chats/claude-code/2026-11/c_aaaaaaaaaaaaaaaa/0001.jsonl.gz" as never)).map((l) => l.text)).toEqual(["words 0"]);
  }, 60_000);

  it("with a lock passphrase already set, the same passphrase is required", async () => {
    const w = await world();
    const rec = await hashPassphrase("existing lock", 1000);
    const box = settingsBox({ ...rec });
    expect(await encryptMyRecord({ access: w.access, ctx: w.ctx, lock: box.lock, update: box.update }, "different one here")).toEqual({ ok: false, reason: "wrong-passphrase" });
    expect(recordKeyState()).toBe("plain");
    expect((await w.access.readEnvelope()).state).toBe("none");
    expect(await encryptMyRecord({ access: w.access, ctx: w.ctx, lock: box.lock, update: box.update }, "short")).toEqual({ ok: false, reason: "weak" });
  }, 20_000);

  it("a failure part-way puts every file back, removes the key file and leaves the record plain", async () => {
    const w = await world();
    const files = await listLedgerFiles(w.vault, "entries");
    const before = readFileSync(files[0]!.abs, "latin1");
    const box = settingsBox();
    const out = await encryptMyRecord({ access: w.access, ctx: w.ctx, lock: box.lock, update: box.update, failAfter: 2 }, "a good passphrase");
    expect(out).toMatchObject({ ok: false, reason: "stopped" });
    expect(readFileSync(files[0]!.abs, "latin1")).toBe(before);
    expect(box.s.record.encryption.enabled).toBe(false);
    expect((await w.access.readEnvelope()).state).toBe("none");
    expect(encryptionConfigured()).toBe(false);
    expect(recordKeyState()).toBe("plain");
    // plain writes work again
    await w.ledger.append("entries", [entry(6)]);
    expect(readFileSync(files[0]!.abs, "utf8")).toContain("zebra-space");
  }, 60_000);

  it("Remove encryption decrypts everything, drops the key file and the account copy, and the ring goes plain", async () => {
    const w = await world();
    const box = settingsBox();
    expect((await encryptMyRecord({ access: w.access, ctx: w.ctx, lock: box.lock, update: box.update }, "remove me later")).ok).toBe(true);
    await allowAccountUnlock(w.access);
    const out = await removeEncryption({ access: w.access, ctx: w.ctx, lock: box.lock, update: box.update });
    expect(out).toMatchObject({ ok: true });
    expect(box.s.record.encryption.enabled).toBe(false);
    expect((await w.access.readEnvelope()).state).toBe("none");
    expect(await w.access.osReady()).toBe(false);
    expect(recordKeyState()).toBe("plain");
    const files = await listLedgerFiles(w.vault, "entries");
    expect(readFileSync(files[0]!.abs, "utf8")).toContain("zebra-space");
    const seen: unknown[] = [];
    for await (const r of w.ledger.readAll("entries")) seen.push(r);
    expect(seen).toHaveLength(2);
  }, 60_000);

  it("Remove encryption needs the key: locked, it refuses", async () => {
    const w = await world();
    const box = settingsBox();
    await encryptMyRecord({ access: w.access, ctx: w.ctx, lock: box.lock, update: box.update }, "remove me later");
    dropVaultKey();
    expect(await removeEncryption({ access: w.access, ctx: w.ctx, lock: box.lock, update: box.update })).toEqual({ ok: false, reason: "locked" });
    expect(cacheLayout(w.cache).locks).toBeTruthy();
  }, 40_000);
});

describe("the bridge helpers", () => {
  it("base64 round-trips a key", () => {
    const k = generateVaultKey();
    expect(Buffer.from(fromBase64(toBase64(k)) as Uint8Array).equals(Buffer.from(k))).toBe(true);
  });
  it("wrapVaultKey results never contain the key", async () => {
    const k = generateVaultKey();
    const env = await wrapVaultKey(k, "x".repeat(10), 1);
    expect(JSON.stringify(env)).not.toContain(Buffer.from(k).toString("hex"));
    const os: OsKeyBridge = createDesktopOsKeyForTest(true);
    expect(await os.available()).toBe(true);
  });
});
