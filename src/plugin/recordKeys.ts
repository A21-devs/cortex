/**
 * The plugin's side of record encryption: the desktop shell's account sealing (Electron safeStorage, set on
 * `globalThis.__cortexOsKey` by desktop/renderer.ts; absent in Obsidian), the key service the lock card and Settings
 * use, and the steps Settings runs (enable, passphrase change, raising the key strength, removal).
 */
import { existsSync } from "node:fs";
import * as path from "node:path";
import { holdVaultKey, heldVaultKey, setEncryptionConfigured } from "../shared/crypto/keyring";
import type { OsKeyBridge, RecordKeyAccess } from "../shared/crypto/access";
import { CURRENT_KDF_VERSION, envelopeIsOld, generateVaultKey, keyId, unwrapVaultKey, wrapVaultKey, type KeyEnvelope } from "../shared/crypto/vaultKey";

/** The desktop shell's bridge, or null (Obsidian, tests, a shell without safeStorage). */
export function desktopOsKey(): OsKeyBridge | null {
  const b = (globalThis as { __cortexOsKey?: OsKeyBridge }).__cortexOsKey;
  return b && typeof b.available === "function" ? b : null;
}

export type EnableResult = { ok: true; envelope: KeyEnvelope; key: Uint8Array } | { ok: false; reason: "weak" | "write" };

/** Minimum length for the passphrase that protects the key. */
export const MIN_ENCRYPTION_PASSPHRASE = 8;

/**
 * Make a new vault key, wrap it under `passphrase`, store the envelope and check it reads back and opens to the same key.
 * The key is returned (the caller holds it for the migration); nothing is held or enabled here.
 */
export async function createRecordKey(access: RecordKeyAccess, passphrase: string): Promise<EnableResult> {
  if (passphrase.length < MIN_ENCRYPTION_PASSPHRASE) return { ok: false, reason: "weak" };
  const key = generateVaultKey();
  const envelope = await wrapVaultKey(key, passphrase, CURRENT_KDF_VERSION);
  try {
    await access.writeEnvelope(envelope);
    const back = await access.readEnvelope();
    if (back.state !== "ok") throw new Error("envelope unreadable");
    const opened = await unwrapVaultKey(back.envelope, passphrase);
    if (!opened || (await keyId(opened)) !== envelope.keyId) throw new Error("envelope does not open");
    opened.fill(0);
  } catch {
    key.fill(0);
    await access.removeEnvelope().catch(() => undefined);
    return { ok: false, reason: "write" };
  }
  return { ok: true, envelope, key };
}

/**
 * Change the passphrase that wraps the key (the vault key itself stays, so no data is rewritten). Needs the current
 * passphrase to be right; works while the key is held or not. False when the current passphrase is wrong or the write fails.
 */
export async function rewrapRecordKey(access: RecordKeyAccess, current: string, next: string, kdfVersion = CURRENT_KDF_VERSION): Promise<boolean> {
  if (next.length < MIN_ENCRYPTION_PASSPHRASE) return false;
  const r = await access.readEnvelope();
  if (r.state !== "ok") return false;
  const key = await unwrapVaultKey(r.envelope, current);
  if (!key) return false;
  try {
    const env = await wrapVaultKey(key, next, kdfVersion);
    const previous = r.envelope;
    await access.writeEnvelope(env);
    const back = await access.readEnvelope();
    const ok = back.state === "ok" && (await unwrapVaultKey(back.envelope, next)) !== null;
    if (!ok) {
      await access.writeEnvelope(previous); // keep the old envelope rather than lose the key
      return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    key.fill(0);
  }
}

/** True when the stored envelope uses fewer PBKDF2 rounds than today's setting. */
export async function envelopeNeedsRaise(access: RecordKeyAccess): Promise<boolean> {
  const r = await access.readEnvelope();
  return r.state === "ok" && envelopeIsOld(r.envelope);
}

/** Seal the held key for this Windows account (needs the key held). */
export async function allowAccountUnlock(access: RecordKeyAccess): Promise<boolean> {
  const key = heldVaultKey();
  const r = await access.readEnvelope();
  if (!key || r.state !== "ok") return false;
  return access.enrolOs(key, r.envelope.keyId);
}

/** The state a freshly enabled record starts in: configured and open (the key is held). */
export function openFreshRecord(key: Uint8Array): void {
  setEncryptionConfigured(true);
  holdVaultKey(key);
}

/** True when the vault holds a key file: the record is encrypted whatever the settings say (a damaged settings file never opens it to plain writes). */
export function keyFilePresent(vaultRoot: string): boolean {
  try {
    return existsSync(path.join(vaultRoot, ".vault-meta", "cortex", "keys", "vault-key.json"));
  } catch {
    return false;
  }
}
