/**
 * The Cortex lock's passphrase check (Cortex: Lock; P21). The passphrase is never stored: settings keep a random
 * salt and a PBKDF2-SHA-256 digest (`privacy.lock`). Pure functions over Web Crypto, so they run in Obsidian's
 * renderer, in Cortex Desktop and in tests. A lock with no stored digest is a privacy blank a click lifts.
 */
import { CURRENT_KDF_VERSION, KDF_VERSIONS } from "./crypto/vaultKey";

export interface LockRecord {
  /** Hex of the random salt ("" = no passphrase). */
  salt: string;
  /** Hex of the derived key ("" = no passphrase). */
  hash: string;
  iterations: number;
}

/**
 * PBKDF2 rounds for a new passphrase: key-derivation version 2 (600,000 rounds, OWASP's 2023 figure for SHA-256;
 * version 1 was 210,000). A stored record keeps its own `iterations`, so an older passphrase still opens and is
 * simply weaker until it is set again.
 */
export const LOCK_ITERATIONS = KDF_VERSIONS[CURRENT_KDF_VERSION] as number;
/** The rounds the first version of the lock used (what an older record holds). */
export const LEGACY_LOCK_ITERATIONS = KDF_VERSIONS[1] as number;

/** True when a stored passphrase uses fewer rounds than a new one would. */
export function lockIsOld(lock: Pick<LockRecord, "salt" | "hash" | "iterations">): boolean {
  return hasPassphrase(lock) && lock.iterations < LOCK_ITERATIONS;
}
export const SALT_BYTES = 16;
export const KEY_BITS = 256;
/** Longest passphrase accepted (keeps the derivation cheap whatever is pasted). */
export const MAX_PASSPHRASE = 256;

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** True when a passphrase has been set. */
export function hasPassphrase(lock: Pick<LockRecord, "salt" | "hash">): boolean {
  return lock.salt.length > 0 && lock.hash.length > 0;
}

function subtle(): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error("Web Crypto is not available");
  return c.subtle;
}

async function derive(passphrase: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await subtle().importKey("raw", new TextEncoder().encode(passphrase.normalize("NFKC").slice(0, MAX_PASSPHRASE)), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, KEY_BITS);
  return toHex(new Uint8Array(bits));
}

/** A new record for `passphrase`: a fresh random salt and its digest. */
export async function hashPassphrase(passphrase: string, iterations = LOCK_ITERATIONS): Promise<LockRecord> {
  const salt = new Uint8Array(SALT_BYTES);
  (globalThis as { crypto: Crypto }).crypto.getRandomValues(salt);
  return { salt: toHex(salt), hash: await derive(passphrase, salt, iterations), iterations };
}

/** Constant-time comparison of two hex strings of equal length. */
export function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Whether `passphrase` opens the lock. No stored digest: anything opens it (the lock is only a blank). */
export async function verifyPassphrase(passphrase: string, lock: LockRecord): Promise<boolean> {
  if (!hasPassphrase(lock)) return true;
  const salt = fromHex(lock.salt);
  if (!salt || !Number.isInteger(lock.iterations) || lock.iterations < 1) return false;
  try {
    return sameDigest(await derive(passphrase, salt, lock.iterations), lock.hash.toLowerCase());
  } catch {
    return false;
  }
}

/** Idle minutes → the setting's allowed values (0 = never, otherwise 1 to 240). */
export function clampAutoLock(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.min(240, Math.max(1, Math.floor(minutes)));
}

/** True when the person has been idle long enough for the auto-lock. */
export function shouldAutoLock(idleMs: number, minutes: number, alreadyLocked: boolean): boolean {
  const m = clampAutoLock(minutes);
  return m > 0 && !alreadyLocked && idleMs >= m * 60_000;
}
