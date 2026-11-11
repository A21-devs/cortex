/**
 * The synchronous Node side of record encryption: the same frames as shared/crypto/vaultKey.ts (AES-256-GCM, fresh
 * random nonce per frame, the six header bytes bound as additional data), built on node:crypto so the ledger's line
 * readers and writers can use them without turning every callback async. The key comes from the ring
 * (shared/crypto/keyring.ts) unless a caller passes one (migration, tests).
 *
 * What the readers and writers see:
 *  - plain ring ("plain"): everything is written and read as before; an encrypted frame cannot be read and is absent;
 *  - locked ring: nothing can be written (E_LOCKED), encrypted data reads as absent (lines) or fails (files);
 *  - open ring: new lines and files are written encrypted; encrypted and legacy plain data both read.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CortexError } from "../shared/errors";
import { FRAME_OVERHEAD, LINE_PREFIX, NONCE_BYTES, TAG_BYTES, frameHeader, looksLikeFrame, parseFrame, type FrameKind } from "../shared/crypto/vaultKey";
import { heldVaultKey, plainWrites, recordKeyState } from "../shared/crypto/keyring";

const ALG = "aes-256-gcm";

/** Encrypt `plain` into a frame of `kind` under `key` (a fresh nonce each call). */
export function sealFrameSync(key: Uint8Array, plain: Uint8Array, kind: FrameKind): Uint8Array {
  const header = frameHeader(kind);
  const nonce = randomBytes(NONCE_BYTES);
  const c = createCipheriv(ALG, key, nonce, { authTagLength: TAG_BYTES });
  c.setAAD(header);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const out = Buffer.alloc(header.length + NONCE_BYTES + ct.length + TAG_BYTES);
  out.set(header, 0);
  out.set(nonce, header.length);
  out.set(ct, header.length + NONCE_BYTES);
  out.set(c.getAuthTag(), header.length + NONCE_BYTES + ct.length);
  return out;
}

/** Decrypt a frame; null when it is not a frame, has the wrong kind, the key is wrong or any byte was changed. */
export function openFrameSync(key: Uint8Array, frame: Uint8Array, kind?: FrameKind): Uint8Array | null {
  const p = parseFrame(frame);
  if (!p || (kind !== undefined && p.kind !== kind) || p.body.length < TAG_BYTES) return null;
  try {
    const d = createDecipheriv(ALG, key, p.nonce, { authTagLength: TAG_BYTES });
    d.setAAD(p.header);
    d.setAuthTag(p.body.subarray(p.body.length - TAG_BYTES));
    return Buffer.concat([d.update(p.body.subarray(0, p.body.length - TAG_BYTES)), d.final()]);
  } catch {
    return null;
  }
}

function locked(): CortexError {
  return new CortexError("E_LOCKED", "the record is encrypted and locked", { detail: { reason: "record-locked" } });
}

/** The key to write with: null while the record is plain; throws while it is encrypted and locked. */
export function writeKey(): Uint8Array | null {
  const s = recordKeyState();
  if (s === "plain" || (s === "open" && plainWrites())) return null;
  const k = heldVaultKey();
  if (!k) throw locked();
  return k;
}

// ───────────────────────────── ledger lines ─────────────────────────────

/** True when `bytes` are the text form of an encrypted line ("CXE1:" first). */
export function isEncryptedLine(bytes: Uint8Array): boolean {
  if (bytes.length < LINE_PREFIX.length + 4) return false;
  for (let i = 0; i < LINE_PREFIX.length; i++) if (bytes[i] !== LINE_PREFIX.charCodeAt(i)) return false;
  return true;
}

/** One line as it goes to disk under `key`: "CXE1:" + base64(frame). A null key writes the line as it is. */
export function encodeLineWith(key: Uint8Array | null, line: string): string {
  if (key === null) return line;
  return encodeLineBytesWith(key, Buffer.from(line, "utf8"));
}

/** The same for a line held as bytes (the migration keeps a line's bytes exactly, valid UTF-8 or not). */
export function encodeLineBytesWith(key: Uint8Array, line: Uint8Array): string {
  return LINE_PREFIX + Buffer.from(sealFrameSync(key, line, "line")).toString("base64");
}

/** A line to write now: encrypted while the ring is open, as it is while plain, E_LOCKED while locked. */
export function encodeLine(line: string): string {
  return encodeLineWith(writeKey(), line);
}

/** The plain bytes of a line read from disk under `key`: legacy plain lines pass through; an encrypted line that cannot be opened is null. */
export function decodeLineBytesWith(key: Uint8Array | null, bytes: Uint8Array): Uint8Array | null {
  if (!isEncryptedLine(bytes)) return bytes;
  if (!key) return null;
  const frame = Buffer.from(Buffer.from(bytes.subarray(LINE_PREFIX.length)).toString("latin1").trim(), "base64");
  return openFrameSync(key, frame, "line");
}

/** decodeLineBytesWith under the ring's key. */
export function decodeLineBytes(bytes: Uint8Array): Uint8Array | null {
  return decodeLineBytesWith(heldVaultKey(), bytes);
}

// ───────────────────────────── whole files ─────────────────────────────

/** A file's bytes as they go to disk under `key` (a null key leaves them as they are). */
export function encodeFileWith(key: Uint8Array | null, bytes: Uint8Array): Uint8Array {
  return key === null ? bytes : sealFrameSync(key, bytes, "file");
}

export function encodeFile(bytes: Uint8Array): Uint8Array {
  return encodeFileWith(writeKey(), bytes);
}

/**
 * A file's plain bytes. A file that is not a frame is returned as it is (legacy plain files stay readable). An
 * encrypted file with no key throws E_LOCKED; one that fails the tag check throws E_PARSE.
 */
export function decodeFileWith(key: Uint8Array | null, bytes: Uint8Array): Uint8Array {
  if (!looksLikeFrame(bytes) || bytes.length < FRAME_OVERHEAD) return bytes;
  if (!key) throw locked();
  const plain = openFrameSync(key, bytes, "file");
  if (!plain) throw new CortexError("E_PARSE", "an encrypted file did not open (wrong key or damaged)", { detail: { reason: "decrypt-failed" } });
  return plain;
}

export function decodeFile(bytes: Uint8Array): Uint8Array {
  return decodeFileWith(heldVaultKey(), bytes);
}

/** True when a file's first bytes say it is an encrypted frame. */
export function isEncryptedFile(bytes: Uint8Array): boolean {
  return looksLikeFrame(bytes);
}
