/**
 * How the lock and Settings reach the record's key material without knowing about files: `RecordKeyAccess` is
 * implemented in Node (node/vaultKeyStore.ts) and handed to the UI through the services. The unlock functions are
 * pure over it, so the passphrase and "This Windows account" paths are testable with a fake.
 */
import { holdVaultKey } from "./keyring";
import { keyId, unwrapVaultKey, type KeyEnvelope } from "./vaultKey";

/** Electron's safeStorage (this Windows account), reached through the desktop shell. Absent in Obsidian. */
export interface OsKeyBridge {
  /** True when the system can protect a key for this account. */
  available(): Promise<boolean>;
  /** The key sealed for this account (opaque base64), or null when the system refuses. */
  protect(key: Uint8Array): Promise<string | null>;
  /** The key back from an opaque blob, or null. */
  unprotect(blob: string): Promise<Uint8Array | null>;
}

export type EnvelopeRead = { state: "none" } | { state: "ok"; envelope: KeyEnvelope } | { state: "damaged" };

export interface RecordKeyAccess {
  readEnvelope(): Promise<EnvelopeRead>;
  /** Write the passphrase envelope (atomically). */
  writeEnvelope(env: KeyEnvelope): Promise<void>;
  removeEnvelope(): Promise<void>;
  /** True when this computer holds an account-sealed copy of the key AND the system can open it. */
  osReady(): Promise<boolean>;
  /** True when the desktop shell offers account-sealed keys at all. */
  osOffered(): Promise<boolean>;
  /** Seal `key` for this account and store the blob outside the vault. False when the system refuses. */
  enrolOs(key: Uint8Array, id: string): Promise<boolean>;
  removeOs(): Promise<void>;
  /** The key the account-sealed copy holds (checked against `id`), or null. */
  openOs(id: string): Promise<Uint8Array | null>;
}

export type UnlockResult = "ok" | "wrong" | "damaged" | "none";

/** Open the record with a passphrase: unwraps the vault key and holds it. "wrong" leaves the ring locked. */
export async function unlockRecordWithPassphrase(passphrase: string, access: RecordKeyAccess): Promise<UnlockResult> {
  const r = await access.readEnvelope();
  if (r.state === "none") return "none";
  if (r.state === "damaged") return "damaged";
  const key = await unwrapVaultKey(r.envelope, passphrase);
  if (!key) return "wrong";
  holdVaultKey(key);
  key.fill(0);
  return "ok";
}

/** Open the record with this Windows account's sealed copy. */
export async function unlockRecordWithOs(access: RecordKeyAccess): Promise<UnlockResult> {
  const r = await access.readEnvelope();
  if (r.state === "none") return "none";
  if (r.state === "damaged") return "damaged";
  const key = await access.openOs(r.envelope.keyId);
  if (!key) return "wrong";
  if ((await keyId(key)) !== r.envelope.keyId) {
    key.fill(0);
    return "wrong";
  }
  holdVaultKey(key);
  key.fill(0);
  return "ok";
}
