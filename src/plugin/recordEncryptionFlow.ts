/**
 * The steps behind Settings > Lock > "Encrypt my record" (and "Remove encryption"), kept apart from the Settings rows so
 * they are testable on a temp folder with a fake settings writer. Order matters and is the safety of the feature:
 *  1. check the passphrase (and the existing lock passphrase, when there is one);
 *  2. make the vault key, store its passphrase envelope and read it back (nothing else has changed yet);
 *  3. hold the key and mark the record encrypted, so every new write from here on is encrypted;
 *  4. convert the files (verified backup, per-file check, read-back, rollback: store/encryptRecord.ts);
 *  5. only after every file converted: save the settings (enabled, key version, and the lock passphrase when none was set).
 * Any failure before step 5 puts the files back, removes the envelope and leaves the record exactly as it was.
 */
import { dropVaultKey, heldVaultKey, holdVaultKey, setEncryptionConfigured, setPlainWrites } from "../shared/crypto/keyring";
import type { RecordKeyAccess } from "../shared/crypto/access";
import { CURRENT_KDF_VERSION, iterationsFor, unwrapVaultKey } from "../shared/crypto/vaultKey";
import { hasPassphrase, hashPassphrase, verifyPassphrase, type LockRecord } from "../shared/lock";
import { convertRecord, planRecordConversion, type ConvertResult, type RecordPlan } from "../store/encryptRecord";
import type { StoreContext } from "../store/layout";
import { createRecordKey, MIN_ENCRYPTION_PASSPHRASE } from "./recordKeys";

export type FlowCtx = Pick<StoreContext, "vaultRoot" | "cacheDir" | "owner" | "lockStaleMs">;

export interface FlowDeps {
  access: RecordKeyAccess;
  ctx: FlowCtx;
  /** The lock record now in settings. */
  lock(): LockRecord;
  /** Save settings (the real writer, or a fake in tests). */
  update(patch: (s: { record: { encryption: { enabled: boolean; kdfVersion: number } }; privacy: { lock: LockRecord } }) => void): Promise<void>;
  onProgress?: (done: number, total: number) => void;
  /** Test hook passed to the conversion. */
  failAfter?: number;
}

export type EncryptOutcome =
  | { ok: true; converted: number; backup: string | null }
  | { ok: false; reason: "weak" | "wrong-passphrase" | "key" | "stopped"; result?: ConvertResult; detail?: string };

/** The dry run behind "Check first". */
export function checkEncryption(ctx: FlowCtx): Promise<RecordPlan> {
  return planRecordConversion(ctx.vaultRoot, "encrypt");
}

export async function encryptMyRecord(d: FlowDeps, passphrase: string): Promise<EncryptOutcome> {
  if (passphrase.length < MIN_ENCRYPTION_PASSPHRASE) return { ok: false, reason: "weak" };
  const lock = d.lock();
  if (hasPassphrase(lock) && !(await verifyPassphrase(passphrase, lock))) return { ok: false, reason: "wrong-passphrase" };
  const made = await createRecordKey(d.access, passphrase);
  if (!made.ok) return { ok: false, reason: "key" };
  const key = made.key;
  setEncryptionConfigured(true);
  holdVaultKey(key);
  let result: ConvertResult;
  try {
    result = await convertRecord(d.ctx, { direction: "encrypt", key, ...(d.onProgress ? { onProgress: d.onProgress } : {}), ...(d.failAfter !== undefined ? { failAfter: d.failAfter } : {}) });
  } catch (e) {
    result = { ok: false, converted: 0, skipped: 0, backup: null, rolledBack: false, rollbackFailed: true, error: e instanceof Error ? e.message : "failed" };
  }
  if (!result.ok) {
    if (!result.rollbackFailed) {
      // Everything is as it was: no key file, no lock on the record.
      dropVaultKey();
      setEncryptionConfigured(false);
      await d.access.removeEnvelope().catch(() => undefined);
    }
    // With a failed rollback the envelope stays: some files may already be encrypted and need it.
    key.fill(0);
    return { ok: false, reason: "stopped", result, ...(result.error ? { detail: result.error } : {}) };
  }
  try {
    const next = hasPassphrase(lock) ? null : await hashPassphrase(passphrase);
    await d.update((s) => {
      s.record.encryption.enabled = true;
      s.record.encryption.kdfVersion = made.envelope.kdfVersion;
      if (next) s.privacy.lock = { ...s.privacy.lock, ...next };
    });
  } catch {
    // The files are encrypted and the key file exists; the plugin treats a key file as "encrypted" whatever the settings say.
  }
  // A second pass: a background runner that started before the setting was saved may have appended a few plain lines
  // behind the first pass (a runner in another process has no key; from the saved setting on it refuses to write).
  try {
    await convertRecord(d.ctx, { direction: "encrypt", key });
  } catch {
    // nothing is lost: plain lines in an encrypted record still read, and the next run converts them
  }
  key.fill(0);
  return { ok: true, converted: result.converted, backup: result.backup };
}

export type RemoveOutcome = { ok: true; converted: number } | { ok: false; reason: "locked" | "stopped"; result?: ConvertResult; detail?: string };

/** Decrypt the record again (needs the key held), then forget the key file. */
export async function removeEncryption(d: FlowDeps): Promise<RemoveOutcome> {
  const held = heldVaultKey();
  if (!held) return { ok: false, reason: "locked" };
  const key = Uint8Array.from(held);
  let result: ConvertResult;
  setPlainWrites(true); // from here on new lines are written plain; the run decrypts what is there
  try {
    result = await convertRecord(d.ctx, { direction: "decrypt", key, ...(d.onProgress ? { onProgress: d.onProgress } : {}), ...(d.failAfter !== undefined ? { failAfter: d.failAfter } : {}) });
  } catch (e) {
    result = { ok: false, converted: 0, skipped: 0, backup: null, rolledBack: false, rollbackFailed: true, error: e instanceof Error ? e.message : "failed" };
  }
  key.fill(0);
  if (!result.ok) {
    setPlainWrites(false);
    return { ok: false, reason: "stopped", result, ...(result.error ? { detail: result.error } : {}) };
  }
  // Plain again: the record no longer needs the key, so the key file and the account copy go.
  await d.update((s) => void (s.record.encryption.enabled = false)).catch(() => undefined);
  await d.access.removeOs().catch(() => undefined);
  await d.access.removeEnvelope().catch(() => undefined);
  setEncryptionConfigured(false);
  setPlainWrites(false);
  return { ok: true, converted: result.converted };
}

/** The unwrap check Settings uses before a destructive step: is `passphrase` the key's passphrase? */
export async function passphraseOpensKey(access: RecordKeyAccess, passphrase: string): Promise<boolean> {
  const r = await access.readEnvelope();
  if (r.state !== "ok") return false;
  const key = await unwrapVaultKey(r.envelope, passphrase);
  if (!key) return false;
  key.fill(0);
  return true;
}

export const CURRENT_ROUNDS = iterationsFor(CURRENT_KDF_VERSION);
