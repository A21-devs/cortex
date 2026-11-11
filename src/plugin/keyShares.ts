/**
 * Splitting the record's key among people (Settings > Lock > Split keys): make the shares, keep one on this computer, test a
 * share without showing the key, and rebuild the key from shares when the passphrase is lost. The maths is in
 * shared/crypto/shamir.ts; this file holds the steps and what each may and may not do:
 *  - a split needs the record open and the passphrase again, checks every threshold-sized group rebuilds the key, and only
 *    then keeps the local share;
 *  - a test rebuilds the key in memory, compares its public id with the one on record and drops it; it never returns the key;
 *  - recovery re-wraps the rebuilt key under a new passphrase (checked by reading it back) and opens the record.
 * No share and no key is ever written to the settings, the log or the vault.
 */
import type { RecordKeyAccess } from "../shared/crypto/access";
import { heldVaultKey, holdVaultKey, setEncryptionConfigured } from "../shared/crypto/keyring";
import { combineVaultKey, decodeShare, parseShareText, shareChecksum, splitVaultKey, type KeyShare, type ShareParseFailure } from "../shared/crypto/shamir";
import { CURRENT_KDF_VERSION, keyId, sameBytes, unwrapVaultKey, wrapVaultKey } from "../shared/crypto/vaultKey";
import type { LocalShareStore } from "../node/shareStore";
import { MIN_ENCRYPTION_PASSPHRASE } from "./recordKeys";

export interface ShareSet {
  /** How many shares rebuild the key. */
  k: number;
  n: number;
  /** The encoded shares; index 0 is share 1 (kept on this computer), the rest are handed out. */
  shares: Uint8Array[];
  checksums: string[];
  keyId: string;
}

/** Every group of `k` out of `n` indices (n is at most 10, so at most 252 groups). */
function groups(n: number, k: number): number[][] {
  const out: number[][] = [];
  const pick = (start: number, acc: number[]): void => {
    if (acc.length === k) return void out.push([...acc]);
    for (let i = start; i < n; i++) pick(i + 1, [...acc, i]);
  };
  pick(0, []);
  return out;
}

/** Make `n` shares of `key` and prove that every group of `k` rebuilds exactly this key before returning them. */
export async function createShareSet(key: Uint8Array, k: number, n: number): Promise<ShareSet> {
  const id = await keyId(key);
  const shares = splitVaultKey(key, id, k, n);
  const decoded = shares.map((s) => {
    const d = decodeShare(s);
    if (!d.ok) throw new Error("a share did not read back");
    return d.share;
  });
  for (const g of groups(n, k)) {
    const r = combineVaultKey(g.map((i) => decoded[i] as KeyShare));
    if (!r.ok || !sameBytes(r.key, key)) throw new Error("a group of shares did not rebuild the key");
    r.key.fill(0);
  }
  return { k, n, shares, checksums: shares.map((s) => shareChecksum(s)), keyId: id };
}

export type SplitResult = { ok: true; set: ShareSet } | { ok: false; reason: "closed" | "wrong-passphrase" | "range" | "write" };

/**
 * Split the open record's key. The passphrase is asked again so a walk-up cannot hand out shares from an open window. The
 * local share (point 1) is written and read back before the set is returned.
 */
export async function splitRecordKey(access: RecordKeyAccess, store: LocalShareStore, passphrase: string, k: number, n: number): Promise<SplitResult> {
  const held = heldVaultKey();
  if (!held) return { ok: false, reason: "closed" };
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 2 || n < k || n > 10) return { ok: false, reason: "range" };
  const env = await access.readEnvelope();
  if (env.state !== "ok") return { ok: false, reason: "closed" };
  const opened = await unwrapVaultKey(env.envelope, passphrase);
  if (!opened) return { ok: false, reason: "wrong-passphrase" };
  const same = sameBytes(opened, held);
  opened.fill(0);
  if (!same) return { ok: false, reason: "wrong-passphrase" };
  let set: ShareSet;
  try {
    set = await createShareSet(held, k, n);
  } catch {
    return { ok: false, reason: "write" };
  }
  try {
    await store.write(set.shares[0] as Uint8Array);
    const back = await store.read();
    if (!back || !sameBytes(back, set.shares[0] as Uint8Array)) throw new Error("the local share did not read back");
  } catch {
    await store.remove().catch(() => undefined);
    return { ok: false, reason: "write" };
  }
  return { ok: true, set };
}

export type ShareTest =
  | { ok: false; reason: "unreadable"; index: number; why: ShareParseFailure; at?: number }
  | { ok: false; reason: "other-record" | "mixed" | "wrong" | "none" }
  | { ok: true; proven: boolean; have: number; need: number; points: number[]; usedLocal: boolean };

/**
 * Test pasted shares (words or `CXS1:` text) without showing the key. The share kept on this computer counts too. With
 * enough shares the key is rebuilt in memory, its public id compared with `keyIdHex`, and the key dropped. With fewer, the
 * shares are only checked for form, check code and the record they belong to.
 */
export async function testShares(texts: readonly string[], local: Uint8Array | null, keyIdHex: string | null): Promise<ShareTest> {
  const parsed: KeyShare[] = [];
  for (const [index, text] of texts.entries()) {
    if (text.trim() === "") continue;
    const r = parseShareText(text);
    if (!r.ok) return { ok: false, reason: "unreadable", index, why: r.reason, ...(r.at !== undefined ? { at: r.at } : {}) };
    parsed.push(r.share);
  }
  let usedLocal = false;
  if (local) {
    const d = decodeShare(local);
    if (d.ok) {
      parsed.push(d.share);
      usedLocal = true;
    }
  }
  const first = parsed[0];
  if (!first) return { ok: false, reason: "none" };
  if (parsed.some((s) => s.tag !== first.tag || s.k !== first.k)) return { ok: false, reason: "mixed" };
  if (keyIdHex !== null && first.tag !== keyIdHex.slice(0, 8)) return { ok: false, reason: "other-record" };
  const points = [...new Set(parsed.map((s) => s.x))].sort((a, b) => a - b);
  if (points.length < first.k) return { ok: true, proven: false, have: points.length, need: first.k, points, usedLocal };
  const r = combineVaultKey(parsed);
  if (!r.ok) return { ok: false, reason: "mixed" };
  const id = await keyId(r.key);
  r.key.fill(0);
  if (keyIdHex !== null && id !== keyIdHex) return { ok: false, reason: "wrong" };
  return { ok: true, proven: true, have: points.length, need: first.k, points, usedLocal };
}

export type RecoverResult =
  | { ok: true }
  | { ok: false; reason: "weak" | "none" | "unreadable" | "mixed" | "few" | "other-record" | "wrong" | "write" | "not-encrypted"; index?: number; need?: number };

/**
 * Lost passphrase: rebuild the key from shares, check it against the record's public id, wrap it under `passphrase`, read the
 * new envelope back, and open the record. The old envelope is put back if the new one does not open.
 */
export async function recoverFromShares(access: RecordKeyAccess, texts: readonly string[], local: Uint8Array | null, passphrase: string, opts: { encrypted: boolean }): Promise<RecoverResult> {
  if (passphrase.length < MIN_ENCRYPTION_PASSPHRASE) return { ok: false, reason: "weak" };
  const env = await access.readEnvelope();
  if (!opts.encrypted && env.state === "none") return { ok: false, reason: "not-encrypted" };
  const parsed: KeyShare[] = [];
  for (const [index, text] of texts.entries()) {
    if (text.trim() === "") continue;
    const r = parseShareText(text);
    if (!r.ok) return { ok: false, reason: "unreadable", index };
    parsed.push(r.share);
  }
  if (local) {
    const d = decodeShare(local);
    if (d.ok) parsed.push(d.share);
  }
  const first = parsed[0];
  if (!first) return { ok: false, reason: "none" };
  if (parsed.some((s) => s.tag !== first.tag || s.k !== first.k)) return { ok: false, reason: "mixed" };
  const known = env.state === "ok" ? env.envelope.keyId : null;
  if (known !== null && first.tag !== known.slice(0, 8)) return { ok: false, reason: "other-record" };
  const r = combineVaultKey(parsed);
  if (!r.ok) return { ok: false, reason: "few", need: first.k };
  const key = r.key;
  try {
    const id = await keyId(key);
    if (id.slice(0, 8) !== first.tag || (known !== null && id !== known)) return { ok: false, reason: "wrong" };
    const next = await wrapVaultKey(key, passphrase, CURRENT_KDF_VERSION);
    const previous = env.state === "ok" ? env.envelope : null;
    try {
      await access.writeEnvelope(next);
      const back = await access.readEnvelope();
      const opened = back.state === "ok" ? await unwrapVaultKey(back.envelope, passphrase) : null;
      if (!opened || !sameBytes(opened, key)) {
        opened?.fill(0);
        throw new Error("the new envelope does not open");
      }
      opened.fill(0);
    } catch {
      if (previous) await access.writeEnvelope(previous).catch(() => undefined);
      else await access.removeEnvelope().catch(() => undefined);
      return { ok: false, reason: "write" };
    }
    setEncryptionConfigured(true);
    holdVaultKey(key);
    return { ok: true };
  } finally {
    key.fill(0);
  }
}
