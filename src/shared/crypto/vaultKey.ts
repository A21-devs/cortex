/**
 * The record's encryption key and the frame every encrypted piece is written in (Encrypt my record). Pure functions
 * over Web Crypto, so they run in Obsidian's renderer, in Cortex Desktop and in tests; nothing here is invented:
 * AES-256-GCM with a fresh random 12-byte nonce per frame, PBKDF2-HMAC-SHA-256 to turn a passphrase into the key that
 * wraps the vault key, SHA-256 for the key's public name.
 *
 * Frame (binary): "CXE1" (4 bytes) | version (1) | kind (1) | nonce (12) | ciphertext | tag (16). The first six bytes
 * are the header and are bound to the ciphertext as additional data, so changing the version, the kind or any byte of
 * the body fails the tag check. A "file" frame wraps a whole file (a segment, a seal block); a "line" frame wraps one
 * ledger line and is written as text, "CXE1:" and the frame in base64, so a shard stays one frame per line and the
 * byte offsets the record index keeps still point at whole lines.
 *
 * The vault key is 32 random bytes. It is never stored in the clear: the passphrase envelope (below) holds it wrapped
 * by a key derived from the passphrase (the kdfVersion says how many PBKDF2 rounds), and Cortex Desktop also keeps
 * a copy wrapped by Electron's safeStorage (this Windows account) outside the vault.
 */

export const FRAME_MAGIC = [0x43, 0x58, 0x45, 0x31] as const; // "CXE1"
export const FRAME_VERSION = 1;
export const HEADER_BYTES = 6;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const FRAME_OVERHEAD = HEADER_BYTES + NONCE_BYTES + TAG_BYTES;
export const VAULT_KEY_BYTES = 32;
/** Prefix of an encrypted ledger line (text form of a "line" frame). */
export const LINE_PREFIX = "CXE1:";

export type FrameKind = "file" | "line";
const KIND_BYTE: Record<FrameKind, number> = { file: 1, line: 2 };

/** PBKDF2 rounds per key-derivation version. Version 1 is what the passphrase lock has used; version 2 is current. */
export const KDF_VERSIONS: Readonly<Record<number, number>> = { 1: 210_000, 2: 600_000 };
export const CURRENT_KDF_VERSION = 2;
export const MIN_ITERATIONS = 100_000;
export const MAX_ITERATIONS = 5_000_000;
export const SALT_BYTES = 16;
/** Longest passphrase used (the same limit as the lock). */
export const MAX_PASSPHRASE = 256;

// ───────────────────────────── bytes ─────────────────────────────

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array | null {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array | null {
  if (typeof text !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  try {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function webCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error("Web Crypto is not available");
  return c;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  webCrypto().getRandomValues(out);
  return out;
}

/** A fresh random vault key. */
export function generateVaultKey(): Uint8Array {
  return randomBytes(VAULT_KEY_BYTES);
}

/** Constant-time equality of two byte strings. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

// ───────────────────────────── frames ─────────────────────────────

export function frameHeader(kind: FrameKind): Uint8Array {
  return Uint8Array.from([...FRAME_MAGIC, FRAME_VERSION, KIND_BYTE[kind]]);
}

export interface ParsedFrame {
  kind: FrameKind;
  header: Uint8Array;
  nonce: Uint8Array;
  /** Ciphertext followed by the 16-byte tag. */
  body: Uint8Array;
}

/** True when `bytes` start with the frame magic. */
export function looksLikeFrame(bytes: Uint8Array): boolean {
  return bytes.length >= FRAME_OVERHEAD && bytes[0] === FRAME_MAGIC[0] && bytes[1] === FRAME_MAGIC[1] && bytes[2] === FRAME_MAGIC[2] && bytes[3] === FRAME_MAGIC[3];
}

/** The pieces of a frame, or null when it is not one this version reads. */
export function parseFrame(bytes: Uint8Array): ParsedFrame | null {
  if (!looksLikeFrame(bytes) || bytes[4] !== FRAME_VERSION) return null;
  const k = bytes[5];
  const kind: FrameKind | null = k === KIND_BYTE.file ? "file" : k === KIND_BYTE.line ? "line" : null;
  if (kind === null) return null;
  return { kind, header: bytes.subarray(0, HEADER_BYTES), nonce: bytes.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES), body: bytes.subarray(HEADER_BYTES + NONCE_BYTES) };
}

async function aesKey(raw: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  if (raw.length !== VAULT_KEY_BYTES) throw new Error("the vault key must be 32 bytes");
  return webCrypto().subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, usage);
}

/** Encrypt `plain` into a frame of `kind` with a fresh random nonce. */
export async function sealFrame(key: Uint8Array, plain: Uint8Array, kind: FrameKind): Promise<Uint8Array> {
  const header = frameHeader(kind);
  const nonce = randomBytes(NONCE_BYTES);
  const ct = new Uint8Array(await webCrypto().subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource, additionalData: header as BufferSource, tagLength: 128 }, await aesKey(key, ["encrypt"]), plain as BufferSource));
  const out = new Uint8Array(HEADER_BYTES + NONCE_BYTES + ct.length);
  out.set(header, 0);
  out.set(nonce, HEADER_BYTES);
  out.set(ct, HEADER_BYTES + NONCE_BYTES);
  return out;
}

/** Decrypt a frame; null when it is not a frame, has the wrong kind, the key is wrong, or any byte was changed. */
export async function openFrame(key: Uint8Array, frame: Uint8Array, kind?: FrameKind): Promise<Uint8Array | null> {
  const p = parseFrame(frame);
  if (!p || (kind !== undefined && p.kind !== kind)) return null;
  try {
    return new Uint8Array(await webCrypto().subtle.decrypt({ name: "AES-GCM", iv: p.nonce as BufferSource, additionalData: p.header as BufferSource, tagLength: 128 }, await aesKey(key, ["decrypt"]), p.body as BufferSource));
  } catch {
    return null;
  }
}

/** The text form of a line frame: "CXE1:" and base64. */
export function lineText(frame: Uint8Array): string {
  return LINE_PREFIX + toBase64(frame);
}

/** The frame inside a line's text, or null when the text is not an encrypted line. */
export function lineFrame(text: string): Uint8Array | null {
  if (!text.startsWith(LINE_PREFIX)) return null;
  return fromBase64(text.slice(LINE_PREFIX.length));
}

/** A key's public name: the first 8 bytes of SHA-256("cortex-key-id" + key), in hex. It says which key without giving the key away. */
export async function keyId(key: Uint8Array): Promise<string> {
  const data = new Uint8Array(13 + key.length);
  data.set(new TextEncoder().encode("cortex-key-id"), 0);
  data.set(key, 13);
  return toHex(new Uint8Array(await webCrypto().subtle.digest("SHA-256", data as BufferSource)).subarray(0, 8));
}

// ───────────────────────────── passphrase envelope ─────────────────────────────

/** The file that holds the vault key wrapped by a passphrase. It carries no secret that opens without the passphrase. */
export interface KeyEnvelope {
  v: 1;
  kdf: "PBKDF2-SHA256";
  kdfVersion: number;
  iterations: number;
  salt: string;
  nonce: string;
  /** AES-256-GCM of the vault key (48 bytes with the tag), hex. */
  wrapped: string;
  keyId: string;
}

export function iterationsFor(kdfVersion: number): number {
  const n = KDF_VERSIONS[kdfVersion];
  if (n === undefined) throw new Error(`unknown key derivation version ${kdfVersion}`);
  return n;
}

async function passphraseKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const subtle = webCrypto().subtle;
  const base = await subtle.importKey("raw", new TextEncoder().encode(passphrase.normalize("NFKC").slice(0, MAX_PASSPHRASE)) as BufferSource, "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function wrapAad(id: string, kdfVersion: number, iterations: number): Uint8Array {
  return new TextEncoder().encode(`cortex-vault-key 1|${id}|${kdfVersion}|${iterations}`);
}

/** Wrap `key` under `passphrase`. A fresh salt and nonce every time. */
export async function wrapVaultKey(key: Uint8Array, passphrase: string, kdfVersion: number = CURRENT_KDF_VERSION): Promise<KeyEnvelope> {
  if (passphrase.length === 0) throw new Error("a passphrase is required");
  const iterations = iterationsFor(kdfVersion);
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const id = await keyId(key);
  const kek = await passphraseKey(passphrase, salt, iterations);
  const ct = new Uint8Array(await webCrypto().subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource, additionalData: wrapAad(id, kdfVersion, iterations) as BufferSource, tagLength: 128 }, kek, key as BufferSource));
  return { v: 1, kdf: "PBKDF2-SHA256", kdfVersion, iterations, salt: toHex(salt), nonce: toHex(nonce), wrapped: toHex(ct), keyId: id };
}

/** The vault key inside an envelope, or null when the passphrase is wrong or the envelope was changed. */
export async function unwrapVaultKey(env: KeyEnvelope, passphrase: string): Promise<Uint8Array | null> {
  const salt = fromHex(env.salt);
  const nonce = fromHex(env.nonce);
  const wrapped = fromHex(env.wrapped);
  if (!salt || !nonce || !wrapped || nonce.length !== NONCE_BYTES) return null;
  try {
    const kek = await passphraseKey(passphrase, salt, env.iterations);
    const key = new Uint8Array(await webCrypto().subtle.decrypt({ name: "AES-GCM", iv: nonce as BufferSource, additionalData: wrapAad(env.keyId, env.kdfVersion, env.iterations) as BufferSource, tagLength: 128 }, kek, wrapped as BufferSource));
    if (key.length !== VAULT_KEY_BYTES) return null;
    return (await keyId(key)) === env.keyId ? key : null;
  } catch {
    return null;
  }
}

/** Check an envelope read from disk: the right shape and parameters in range (a hostile file cannot ask for endless rounds). */
export function parseEnvelope(raw: unknown): KeyEnvelope | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || r.kdf !== "PBKDF2-SHA256") return null;
  const { kdfVersion, iterations, salt, nonce, wrapped, keyId: id } = r;
  if (typeof kdfVersion !== "number" || !Number.isInteger(kdfVersion) || kdfVersion < 1) return null;
  if (typeof iterations !== "number" || !Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) return null;
  if (typeof salt !== "string" || typeof nonce !== "string" || typeof wrapped !== "string" || typeof id !== "string") return null;
  const s = fromHex(salt);
  const n = fromHex(nonce);
  const w = fromHex(wrapped);
  if (!s || s.length < 8 || s.length > 64 || !n || n.length !== NONCE_BYTES || !w || w.length !== VAULT_KEY_BYTES + TAG_BYTES) return null;
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  return { v: 1, kdf: "PBKDF2-SHA256", kdfVersion, iterations, salt: salt.toLowerCase(), nonce: nonce.toLowerCase(), wrapped: wrapped.toLowerCase(), keyId: id };
}

/** True when the envelope uses fewer rounds than the current version asks for (offer to raise it on the next unlock). */
export function envelopeIsOld(env: Pick<KeyEnvelope, "kdfVersion" | "iterations">): boolean {
  return env.kdfVersion < CURRENT_KDF_VERSION || env.iterations < iterationsFor(CURRENT_KDF_VERSION);
}
