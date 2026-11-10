/**
 * Stable and sortable identifiers. Owner: E1.
 *
 * Stable ids (same input → same id on every machine, every re-import):
 *   entry        e_ + base32(sha256(`${source}:${nativeKey}`))[0..16)
 *   conversation c_ + base32(sha256(`${source}:${nativeConversationId}`))[0..16)
 *   wiki note    w_ + base32(sha256(`obsidian:${vaultPath}`))[0..16)
 *   machine note n_ + base32(sha256(`${kind}:${key}`))[0..16)
 * Sortable ids (runs, labels, corrections, receipts, review cards, pinned views): prefix + base32 of a 48-bit
 * millisecond time followed by 32 random bits. Within one process they are strictly increasing: ids made in the
 * same millisecond (or after the clock stepped back) continue from the previous id instead of drawing new
 * random bits, so creation order holds under `compareIds` (a plain string compare breaks at the digit/letter boundary).
 * The id body alphabet is RFC 4648 base32 in lower case (a–z, 2–7); 80 bits = 16 characters exactly.
 */
import { sha256, utf8 } from "./sha256";
import type { ConversationId, CorrectionId, EntryId, LabelId, NoteId, ReceiptId, ReviewCardId, RunId, SourceKind } from "./types";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * Order two ids by creation. The base32 alphabet puts the digits 2-7 AFTER the letters, so a plain string
 * comparison (which sorts digits first) breaks the order at that boundary; this compares by alphabet position.
 * Characters outside the alphabet (prefixes, "_") compare by code unit.
 */
export function compareIds(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    const x = ALPHABET.indexOf(a[i] as string);
    const y = ALPHABET.indexOf(b[i] as string);
    if (x >= 0 && y >= 0) return x - y;
    return (a.charCodeAt(i) - b.charCodeAt(i)) || 0;
  }
  return a.length - b.length;
}

/** RFC 4648 base32, lowercase, no padding. */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decode lowercase unpadded base32 (the inverse of `base32`); throws on characters outside the alphabet. */
export function base32Decode(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new RangeError(`invalid base32 character "${ch}"`);
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out[o++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out;
}

export const ID_BODY_LENGTH = 16;
/** Any Cortex id: one lowercase prefix letter, "_", 16 base32 characters. */
export const ID_PATTERN = /^[a-z]_[a-z2-7]{16}$/;
export const ID_BODY_PATTERN = /^[a-z2-7]{16}$/;

export function hashBody(key: string): string {
  return base32(sha256(utf8(key))).slice(0, ID_BODY_LENGTH);
}

export function entryId(source: SourceKind, nativeKey: string): EntryId {
  return `e_${hashBody(`${source}:${nativeKey}`)}`;
}

export function conversationId(source: SourceKind, nativeConversationId: string): ConversationId {
  return `c_${hashBody(`${source}:${nativeConversationId}`)}`;
}

/** Vault note id from its vault-relative POSIX path (case preserved, exactly as Obsidian reports it). */
export function wikiNoteId(vaultPath: string): NoteId {
  return `w_${hashBody(`obsidian:${vaultPath}`)}`;
}

export function machineNoteId(kind: string, key: string): NoteId {
  return `n_${hashBody(`${kind}:${key}`)}`;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (typeof c?.getRandomValues !== "function") throw new Error("no secure random source (globalThis.crypto) in this environment");
  c.getRandomValues(out);
  return out;
}

/** 48-bit time + 32-bit counter state of the last sortable id made by this process. */
let lastTime = -1;
let lastRandom = 0;

const MAX_TIME = 2 ** 48 - 1;

/**
 * 16 base32 chars: 48-bit millisecond timestamp then 32 bits that are random for the first id of a millisecond
 * and incremented for later ids of the same (or an earlier) millisecond, so ids are strictly increasing.
 */
export function sortableBody(now: number = Date.now()): string {
  let t = Math.min(MAX_TIME, Math.max(0, Math.floor(Number.isFinite(now) ? now : Date.now())));
  let r: number;
  if (t <= lastTime) {
    t = lastTime;
    r = lastRandom + 1;
    if (r > 0xffffffff) {
      t = Math.min(MAX_TIME, t + 1);
      r = 0;
    }
  } else {
    const rb = randomBytes(4);
    // Keep the top bit clear so a long run of increments in one millisecond never overflows into the time.
    r = ((((rb[0] as number) & 0x7f) << 24) | ((rb[1] as number) << 16) | ((rb[2] as number) << 8) | (rb[3] as number)) >>> 0;
  }
  lastTime = t;
  lastRandom = r;
  const bytes = new Uint8Array(10);
  let tt = t;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = tt % 256;
    tt = Math.floor(tt / 256);
  }
  bytes[6] = (r >>> 24) & 0xff;
  bytes[7] = (r >>> 16) & 0xff;
  bytes[8] = (r >>> 8) & 0xff;
  bytes[9] = r & 0xff;
  return base32(bytes);
}

/** The creation time (epoch ms) encoded in a sortable id or body; NaN when malformed. */
export function sortableTime(idOrBody: string): number {
  const body = idOrBody.length === ID_BODY_LENGTH + 2 && idOrBody[1] === "_" ? idOrBody.slice(2) : idOrBody;
  if (!ID_BODY_PATTERN.test(body)) return Number.NaN;
  const bytes = base32Decode(body);
  let t = 0;
  for (let i = 0; i < 6; i++) t = t * 256 + (bytes[i] as number);
  return t;
}

export const newRunId = (now?: number): RunId => `r_${sortableBody(now)}`;
export const newLabelId = (now?: number): LabelId => `l_${sortableBody(now)}`;
export const newCorrectionId = (now?: number): CorrectionId => `k_${sortableBody(now)}`;
export const newReceiptId = (now?: number): ReceiptId => `x_${sortableBody(now)}`;
export const newReviewCardId = (now?: number): ReviewCardId => `v_${sortableBody(now)}`;

/** Normalise an absolute vault path the same way on every call (separators, case, trailing and repeated slashes). */
export function normalizeVaultRoot(vaultRootAbs: string): string {
  let s = vaultRootAbs.trim().replace(/\\/g, "/");
  // Windows long-path and device prefixes name the same folder.
  s = s.replace(/^\/\/[?.]\/(?:unc\/)?/i, (m) => (/unc\/$/i.test(m) ? "//" : ""));
  const unc = s.startsWith("//");
  s = s.replace(/\/{2,}/g, "/").replace(/\/\.(?=\/|$)/g, "");
  if (unc) s = `/${s}`;
  s = s.replace(/\/+$/, "");
  return s.toLowerCase();
}

/** Key for per-vault cache folders: base32(sha256("vault:" + normalised absolute vault path))[0..16). */
export function vaultKey(vaultRootAbs: string): string {
  return hashBody(`vault:${normalizeVaultRoot(vaultRootAbs)}`);
}

export function isId(s: unknown): s is string {
  return typeof s === "string" && ID_PATTERN.test(s);
}

export function isEntryId(s: string): s is EntryId {
  return s.startsWith("e_") && ID_PATTERN.test(s);
}

export function isNoteId(s: string): s is NoteId {
  return (s.startsWith("n_") || s.startsWith("w_")) && ID_PATTERN.test(s);
}

export function isConversationId(s: string): s is ConversationId {
  return s.startsWith("c_") && ID_PATTERN.test(s);
}

export function isRunId(s: string): s is RunId {
  return s.startsWith("r_") && ID_PATTERN.test(s);
}
