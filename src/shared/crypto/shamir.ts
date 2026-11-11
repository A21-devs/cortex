/**
 * Shamir secret sharing of the record's key over GF(2^8) (the AES field, polynomial 0x11B), byte by byte: any `k` of the `n`
 * shares rebuild the key, fewer than `k` give nothing about it. Randomness comes from Web Crypto; the field arithmetic is the
 * standard log/antilog form. A share is 40 bytes: version and threshold, the point, a 4-byte tag of the key's public id (so
 * shares of two different keys are told apart), the 32 share bytes and a 2-byte check. It is written as 32 words from a
 * fixed list of 1,024 (10 bits each), or as `CXS1:` and base64url for a QR code. Pure TypeScript, no I/O.
 */
import { sha256, sha256Hex } from "../sha256";
import { fromBase64, fromHex, randomBytes, toBase64, VAULT_KEY_BYTES } from "./vaultKey";
import { SHARE_WORDS, WORD_BITS, wordIndex } from "./shareWords";

// ───────────────────────────── GF(256) ─────────────────────────────

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // multiply by the generator 3 (x + 1): x*2 xor x, reduced by 0x11B
    let d = x << 1;
    if (d & 0x100) d ^= 0x11b;
    x = d ^ x;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number;
})();

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] as number) + (LOG[b] as number)] as number;
}

export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("division by zero in GF(256)");
  if (a === 0) return 0;
  return EXP[(LOG[a] as number) + 255 - (LOG[b] as number)] as number;
}

// ───────────────────────────── split / combine ─────────────────────────────

export interface RawShare {
  /** 1..255. */
  x: number;
  y: Uint8Array;
}

export const MAX_SHARES = 10;

/** Split `secret` into `n` raw shares, any `k` of which rebuild it. */
export function splitSecret(secret: Uint8Array, k: number, n: number): RawShare[] {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 2 || n < k || n > MAX_SHARES) throw new Error("a share set needs 2 <= threshold <= total <= 10");
  const out: RawShare[] = Array.from({ length: n }, (_, i) => ({ x: i + 1, y: new Uint8Array(secret.length) }));
  const coef = new Uint8Array(k);
  for (let b = 0; b < secret.length; b++) {
    coef.set(randomBytes(k - 1), 1);
    coef[0] = secret[b] as number;
    for (const s of out) {
      // Horner: ((c[k-1] x + c[k-2]) x + ...) x + c[0]
      let acc = 0;
      for (let j = k - 1; j >= 0; j--) acc = gfMul(acc, s.x) ^ (coef[j] as number);
      s.y[b] = acc;
    }
  }
  coef.fill(0);
  return out;
}

/** Rebuild the secret from raw shares (Lagrange at 0). The caller checks the result; a wrong share gives a wrong secret, not an error. */
export function combineShares(shares: readonly RawShare[]): Uint8Array {
  if (shares.length < 2) throw new Error("at least two shares are needed");
  const xs = shares.map((s) => s.x);
  if (new Set(xs).size !== xs.length || xs.some((x) => !Number.isInteger(x) || x < 1 || x > 255)) throw new Error("shares must come from different points");
  const len = (shares[0] as RawShare).y.length;
  if (shares.some((s) => s.y.length !== len)) throw new Error("shares differ in length");
  const out = new Uint8Array(len);
  for (let i = 0; i < shares.length; i++) {
    let num = 1;
    let den = 1;
    for (let j = 0; j < shares.length; j++) {
      if (i === j) continue;
      num = gfMul(num, xs[j] as number);
      den = gfMul(den, (xs[i] as number) ^ (xs[j] as number));
    }
    const lag = gfDiv(num, den);
    const y = (shares[i] as RawShare).y;
    for (let b = 0; b < len; b++) out[b] = (out[b] as number) ^ gfMul(y[b] as number, lag);
  }
  return out;
}

// ───────────────────────────── share format ─────────────────────────────

export const SHARE_VERSION = 1;
export const SHARE_BYTES = 40;
export const SHARE_WORD_COUNT = (SHARE_BYTES * 8) / WORD_BITS; // 32
export const QR_PREFIX = "CXS1:";
const BODY = 38;

/** A decoded share. */
export interface KeyShare {
  /** How many shares rebuild the key. */
  k: number;
  x: number;
  /** The first 4 bytes of the key's public id, hex (8 characters). */
  tag: string;
  y: Uint8Array;
}

function check(body: Uint8Array): Uint8Array {
  const pre = new TextEncoder().encode("cortex-key-share 1");
  const msg = new Uint8Array(pre.length + body.length);
  msg.set(pre, 0);
  msg.set(body, pre.length);
  return sha256(msg).subarray(0, 2);
}

export function encodeShare(s: KeyShare): Uint8Array {
  const tag = fromHex(s.tag);
  if (!tag || tag.length !== 4 || s.y.length !== VAULT_KEY_BYTES || s.k < 2 || s.k > 15 || s.x < 1 || s.x > 255) throw new Error("this share cannot be encoded");
  const out = new Uint8Array(SHARE_BYTES);
  out[0] = (SHARE_VERSION << 4) | s.k;
  out[1] = s.x;
  out.set(tag, 2);
  out.set(s.y, 6);
  out.set(check(out.subarray(0, BODY)), BODY);
  return out;
}

export type ShareParseFailure = "length" | "version" | "check" | "word" | "text";

/** The share inside `bytes`, or why it is not one. */
export function decodeShare(bytes: Uint8Array): { ok: true; share: KeyShare } | { ok: false; reason: ShareParseFailure } {
  if (bytes.length !== SHARE_BYTES) return { ok: false, reason: "length" };
  const want = check(bytes.subarray(0, BODY));
  if (want[0] !== bytes[BODY] || want[1] !== bytes[BODY + 1]) return { ok: false, reason: "check" };
  const head = bytes[0] as number;
  const k = head & 15;
  const x = bytes[1] as number;
  if (head >> 4 !== SHARE_VERSION || k < 2 || x < 1) return { ok: false, reason: "version" };
  return { ok: true, share: { k, x, tag: Array.from(bytes.subarray(2, 6), (b) => b.toString(16).padStart(2, "0")).join(""), y: bytes.slice(6, BODY) } };
}

/** A short code for a share: it names which share it is on a list without giving anything away (`a1b2-c3d4`). */
export function shareChecksum(bytes: Uint8Array): string {
  const pre = new TextEncoder().encode("cortex-key-share-id");
  const msg = new Uint8Array(pre.length + bytes.length);
  msg.set(pre, 0);
  msg.set(bytes, pre.length);
  const h = sha256Hex(msg).slice(0, 8);
  return `${h.slice(0, 4)}-${h.slice(4)}`;
}

// ───────────────────────────── words ─────────────────────────────

export function shareToWords(bytes: Uint8Array): string[] {
  if (bytes.length !== SHARE_BYTES) throw new Error("a share is 40 bytes");
  const words: string[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= WORD_BITS) {
      bits -= WORD_BITS;
      words.push(SHARE_WORDS[(acc >> bits) & 1023] as string);
    }
    acc &= (1 << bits) - 1;
  }
  return words;
}

/** The words of a typed or pasted share: any case, spaces, commas, dashes, line breaks and a leading "1." or "12)" on each are ignored. */
export function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\b\d+[.):]/g, " ")
    .split(/[^a-z]+/)
    .filter((w) => w.length > 0);
}

export function wordsToShare(words: readonly string[]): { ok: true; bytes: Uint8Array } | { ok: false; reason: "length" | "word"; at: number } {
  if (words.length !== SHARE_WORD_COUNT) return { ok: false, reason: "length", at: Math.min(words.length, SHARE_WORD_COUNT) };
  const out = new Uint8Array(SHARE_BYTES);
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (const [i, w] of words.entries()) {
    const v = wordIndex(w);
    if (v < 0) return { ok: false, reason: "word", at: i };
    acc = (acc << WORD_BITS) | v;
    bits += WORD_BITS;
    while (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 255;
    }
    acc &= (1 << bits) - 1;
  }
  return { ok: true, bytes: out };
}

/** The QR text of a share: `CXS1:` and base64url of its 40 bytes. */
export function shareToQrText(bytes: Uint8Array): string {
  return `${QR_PREFIX}${toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export type ShareTextResult = { ok: true; bytes: Uint8Array; share: KeyShare } | { ok: false; reason: ShareParseFailure; at?: number };

/** Read a share from what a person typed: the 32 words, or the `CXS1:` text a phone's scanner gives. */
export function parseShareText(text: string): ShareTextResult {
  const t = text.trim();
  let bytes: Uint8Array | null;
  if (t.toUpperCase().startsWith(QR_PREFIX)) {
    const b64 = t.slice(QR_PREFIX.length).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    bytes = fromBase64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    if (!bytes) return { ok: false, reason: "text" };
  } else {
    const r = wordsToShare(wordsOf(t));
    if (!r.ok) return { ok: false, reason: r.reason, at: r.at };
    bytes = r.bytes;
  }
  const d = decodeShare(bytes);
  return d.ok ? { ok: true, bytes, share: d.share } : { ok: false, reason: d.reason };
}

// ───────────────────────────── the key ─────────────────────────────

/** Split the vault key into `n` encoded shares (the first `n` points), with the key's id tag in each. `keyIdHex` is the 16-hex public id. */
export function splitVaultKey(key: Uint8Array, keyIdHex: string, k: number, n: number): Uint8Array[] {
  if (key.length !== VAULT_KEY_BYTES) throw new Error("the vault key must be 32 bytes");
  return splitSecret(key, k, n).map((s) => encodeShare({ k, x: s.x, tag: keyIdHex.slice(0, 8), y: s.y }));
}

export type CombineResult = { ok: true; key: Uint8Array; k: number } | { ok: false; reason: "few" | "mixed" };

/** Rebuild the key from decoded shares (repeats of one point count once). The caller compares its public id with the one on record before using it. */
export function combineVaultKey(shares: readonly KeyShare[]): CombineResult {
  const first = shares[0];
  if (!first) return { ok: false, reason: "few" };
  if (shares.some((s) => s.tag !== first.tag || s.k !== first.k)) return { ok: false, reason: "mixed" };
  const byX = new Map<number, KeyShare>();
  for (const s of shares) byX.set(s.x, s);
  const uniq = [...byX.values()];
  if (uniq.length < first.k) return { ok: false, reason: "few" };
  return { ok: true, key: combineShares(uniq.slice(0, first.k).map((s) => ({ x: s.x, y: s.y }))), k: first.k };
}
