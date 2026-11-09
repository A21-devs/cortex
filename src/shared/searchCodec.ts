/**
 * Binary full-text search shards (pure; built by the runner, decoded in the worker). Owner: E7.
 *
 * Layout (little-endian): "CXS1" | u32 headerLen | header JSON | sections at the 4-aligned offsets the header
 * names: `docs` (u32 × docs, ascending ordinals: every document this shard speaks for, including empty ones) |
 * term offsets (u32 × (terms+1)) | term bytes (UTF-8, sorted in JavaScript string order) | posting offsets
 * (u32 × (terms+1)) | postings: per term a run of (varint delta doc ordinal, u8 field mask: 1 = title, 2 = body).
 * Doc ordinal = ordinal in the merged DataIndex (the shared allocator, so record entries and vault notes mix).
 *
 * Shards are immutable and ordered: a document listed in a LATER shard masks every earlier posting for the
 * same ordinal (a corrected entry, an excluded item written as an empty document, a vault note that changed).
 */
import { CortexError } from "./errors";
import { tokenize } from "./text";

export const SEARCH_MAGIC = "CXS1";

/** Field mask bits in postings. */
export const FIELD_TITLE = 1;
export const FIELD_BODY = 2;

/** At most this many characters of a body are indexed (a pasted log must not dominate a shard). */
export const MAX_BODY_CHARS = 200_000;

export interface SearchIndexHeader {
  docs: number;
  terms: number;
  seq: number;
  builtAt: string;
  /** Ordinal epoch the doc ordinals belong to ("" = unknown: the worker treats the shard as foreign). */
  epoch: string;
  /** Stable shard key (file name stem). */
  key: string;
}

/** One decoded shard. */
export interface SearchShard {
  readonly header: SearchIndexHeader;
  /** Number of terms. */
  readonly size: number;
  /** Ordinals this shard speaks for (ascending). */
  readonly docs: Uint32Array;
  termAt(i: number): string;
  /** Binary search for an exact term; -1 when absent. */
  find(term: string): number;
  /** Range [from, to) of terms starting with `prefix`. */
  prefixRange(prefix: string): [number, number];
  postings(i: number): { docs: Uint32Array; fields: Uint8Array };
}

/** The shards the worker searches, in order, with the masking rule applied. */
export interface SearchIndexData {
  /** Aggregate: docs = ordinals spoken for, terms = sum over shards, newest seq/builtAt, the shared epoch. */
  readonly header: SearchIndexHeader;
  readonly shards: readonly SearchShard[];
  /** Index of the LAST shard that lists the ordinal (its postings are the valid ones); -1 when none. */
  owner(ordinal: number): number;
}

/** Combine shards (later shards mask earlier ones). Shards of a different epoch than the first are dropped. */
export function combineShards(shards: readonly SearchShard[]): SearchIndexData {
  const epoch = shards[0]?.header.epoch ?? "";
  const kept = shards.filter((s) => s.header.epoch === epoch);
  let max = -1;
  for (const s of kept) if (s.docs.length > 0) max = Math.max(max, s.docs[s.docs.length - 1]!);
  const owner = new Int32Array(max + 1).fill(-1);
  kept.forEach((s, i) => {
    for (let k = 0; k < s.docs.length; k++) owner[s.docs[k]!] = i;
  });
  let docs = 0;
  for (let o = 0; o < owner.length; o++) if (owner[o]! >= 0) docs++;
  const header: SearchIndexHeader = {
    docs,
    terms: kept.reduce((n, s) => n + s.size, 0),
    seq: kept.reduce((n, s) => Math.max(n, s.header.seq), 0),
    builtAt: kept.reduce((b, s) => (s.header.builtAt > b ? s.header.builtAt : b), ""),
    epoch,
    key: "combined",
  };
  return { header, shards: kept, owner: (o) => (o >= 0 && o < owner.length ? owner[o]! : -1) };
}

export interface SearchDocInput {
  ordinal: number;
  title: string;
  body: string;
}

interface StoredSearchHeader extends SearchIndexHeader {
  magic: typeof SEARCH_MAGIC;
  at: { docs: number; termOffsets: number; termBytes: number; termBytesLength: number; postOffsets: number; postBytes: number; postBytesLength: number };
}

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const align4 = (n: number): number => (n + 3) & ~3;

/** LEB128 unsigned varint writer/reader used by postings. */
export function writeVarint(out: number[], value: number): void {
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

export function readVarint(bytes: Uint8Array, pos: number): [value: number, next: number] {
  let result = 0;
  let shift = 0;
  let p = pos;
  for (;;) {
    if (p >= bytes.length || shift > 28) throw new CortexError("E_PARSE", "search shard is damaged (varint)");
    const b = bytes[p++] as number;
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result >>> 0, p];
}

/** Growable byte buffer for postings. */
class Bytes {
  buf = new Uint8Array(1 << 16);
  len = 0;
  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + extra));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  varint(value: number): void {
    this.ensure(5);
    let v = value >>> 0;
    while (v >= 0x80) {
      this.buf[this.len++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    this.buf[this.len++] = v;
  }
  byte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b;
  }
  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
}

/** Terms of one document with their field masks. */
export function documentTerms(title: string, body: string): Map<string, number> {
  const terms = new Map<string, number>();
  for (const t of tokenize(title)) terms.set(t, (terms.get(t) ?? 0) | FIELD_TITLE);
  const b = body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;
  for (const t of tokenize(b)) terms.set(t, (terms.get(t) ?? 0) | FIELD_BODY);
  return terms;
}

/** Encode documents as one immutable shard. A document with no text still masks earlier shards. */
export function encodeSearchIndex(docs: Iterable<SearchDocInput>, header: Omit<SearchIndexHeader, "docs" | "terms" | "epoch" | "key"> & { epoch?: string; key?: string }): ArrayBuffer {
  const postings = new Map<string, number[]>();
  const docSet = new Set<number>();
  for (const d of docs) {
    if (!Number.isInteger(d.ordinal) || d.ordinal < 0 || d.ordinal > 0xfffffffe) throw new CortexError("E_BAD_REQUEST", "invalid search document ordinal");
    docSet.add(d.ordinal);
    for (const [term, mask] of documentTerms(d.title, d.body)) {
      let list = postings.get(term);
      if (!list) {
        list = [];
        postings.set(term, list);
      }
      list.push(d.ordinal, mask);
    }
  }
  const docList = Uint32Array.from([...docSet].sort((a, b) => a - b));
  const terms = [...postings.keys()].sort();
  const termBytes = new Bytes();
  const termOffsets = new Uint32Array(terms.length + 1);
  const post = new Bytes();
  const postOffsets = new Uint32Array(terms.length + 1);
  terms.forEach((term, i) => {
    termBytes.bytes(ENC.encode(term));
    termOffsets[i + 1] = termBytes.len;
    const pairs = postings.get(term)!;
    const order = new Uint32Array(pairs.length / 2);
    for (let k = 0; k < order.length; k++) order[k] = k;
    order.sort((a, b) => pairs[a * 2]! - pairs[b * 2]!);
    let prev = 0;
    let k = 0;
    while (k < order.length) {
      const ord = pairs[order[k]! * 2]!;
      let mask = pairs[order[k]! * 2 + 1]!;
      k++;
      while (k < order.length && pairs[order[k]! * 2] === ord) mask |= pairs[order[k++]! * 2 + 1]!;
      post.varint(ord - prev);
      post.byte(mask);
      prev = ord;
    }
    postOffsets[i + 1] = post.len;
  });

  const at = { docs: 0, termOffsets: 0, termBytes: 0, termBytesLength: termBytes.len, postOffsets: 0, postBytes: 0, postBytesLength: post.len };
  const full: Omit<StoredSearchHeader, "at"> = {
    magic: SEARCH_MAGIC,
    docs: docList.length,
    terms: terms.length,
    seq: header.seq,
    builtAt: header.builtAt,
    epoch: header.epoch ?? "",
    key: header.key ?? "",
  };
  let base = align4(8 + 512);
  let json = new Uint8Array(0);
  for (let iter = 0; iter < 8; iter++) {
    at.docs = base;
    at.termOffsets = align4(at.docs + docList.byteLength);
    at.termBytes = at.termOffsets + termOffsets.byteLength;
    at.postOffsets = align4(at.termBytes + termBytes.len);
    at.postBytes = at.postOffsets + postOffsets.byteLength;
    json = ENC.encode(JSON.stringify({ ...full, at }));
    if (8 + json.length <= base) break;
    base = align4(8 + json.length + 128);
  }
  if (8 + json.length > base) throw new CortexError("E_INTERNAL", "search header did not converge");
  const total = at.postBytes + post.len;
  const out = new ArrayBuffer(total);
  const u8 = new Uint8Array(out);
  u8.set(ENC.encode(SEARCH_MAGIC), 0);
  new DataView(out).setUint32(4, base - 8, true);
  u8.set(json, 8);
  u8.fill(0x20, 8 + json.length, base);
  u8.set(new Uint8Array(docList.buffer, docList.byteOffset, docList.byteLength), at.docs);
  u8.set(new Uint8Array(termOffsets.buffer), at.termOffsets);
  u8.set(termBytes.buf.subarray(0, termBytes.len), at.termBytes);
  u8.set(new Uint8Array(postOffsets.buffer), at.postOffsets);
  u8.set(post.buf.subarray(0, post.len), at.postBytes);
  return out;
}

function damaged(what: string): CortexError {
  return new CortexError("E_PARSE", `search shard is damaged (${what})`);
}

function checkOffsets(o: Uint32Array, total: number, what: string): void {
  if (o[0] !== 0 || o[o.length - 1] !== total) throw damaged(what);
  for (let i = 1; i < o.length; i++) if (o[i]! < o[i - 1]!) throw damaged(what);
}

/** Read only the header (cheap). */
export function readSearchHeader(buffer: ArrayBuffer): SearchIndexHeader {
  return parseHeader(buffer);
}

function parseHeader(buffer: ArrayBuffer): StoredSearchHeader {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) throw damaged("too short");
  const u8 = new Uint8Array(buffer);
  if (DEC.decode(u8.subarray(0, 4)) !== SEARCH_MAGIC) throw damaged("magic");
  const len = new DataView(buffer).getUint32(4, true);
  if (8 + len > buffer.byteLength) throw damaged("header length");
  let h: StoredSearchHeader;
  try {
    h = JSON.parse(DEC.decode(u8.subarray(8, 8 + len))) as StoredSearchHeader;
  } catch {
    throw damaged("header JSON");
  }
  const a = h?.at;
  if (h?.magic !== SEARCH_MAGIC || typeof h.docs !== "number" || typeof h.terms !== "number" || typeof a !== "object" || a === null) throw damaged("header");
  const fits = (off: number, bytes: number): boolean => Number.isInteger(off) && off >= 8 + len && off % 4 === 0 && off + bytes <= buffer.byteLength;
  if (
    !fits(a.docs, h.docs * 4) ||
    !fits(a.termOffsets, (h.terms + 1) * 4) ||
    !(a.termBytes >= 8 + len && a.termBytes + a.termBytesLength <= buffer.byteLength) ||
    !fits(a.postOffsets, (h.terms + 1) * 4) ||
    !(a.postBytes >= 8 + len && a.postBytes + a.postBytesLength <= buffer.byteLength)
  ) {
    throw damaged("sections");
  }
  if (typeof h.epoch !== "string") h.epoch = "";
  if (typeof h.key !== "string") h.key = "";
  return h;
}

/** Decode one shard (views over `buffer`). Throws CortexError E_PARSE on a damaged file. */
export function decodeSearchIndex(buffer: ArrayBuffer): SearchShard {
  const h = parseHeader(buffer);
  const a = h.at;
  const docs = new Uint32Array(buffer, a.docs, h.docs);
  const termOffsets = new Uint32Array(buffer, a.termOffsets, h.terms + 1);
  const termBytes = new Uint8Array(buffer, a.termBytes, a.termBytesLength);
  const postOffsets = new Uint32Array(buffer, a.postOffsets, h.terms + 1);
  const postBytes = new Uint8Array(buffer, a.postBytes, a.postBytesLength);
  checkOffsets(termOffsets, a.termBytesLength, "terms");
  checkOffsets(postOffsets, a.postBytesLength, "postings");
  const header: SearchIndexHeader = { docs: h.docs, terms: h.terms, seq: h.seq, builtAt: h.builtAt, epoch: h.epoch, key: h.key };
  const size = h.terms;
  const termAt = (i: number): string => (i >= 0 && i < size ? DEC.decode(termBytes.subarray(termOffsets[i]!, termOffsets[i + 1]!)) : "");
  /** First index whose term is >= s. */
  const lowerBound = (s: string): number => {
    let lo = 0;
    let hi = size;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (termAt(mid) < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return {
    header,
    size,
    docs,
    termAt,
    find(term) {
      const i = lowerBound(term);
      return i < size && termAt(i) === term ? i : -1;
    },
    prefixRange(prefix) {
      if (prefix.length === 0) return [0, size];
      return [lowerBound(prefix), lowerBound(prefix + "￿")];
    },
    postings(i) {
      if (!(i >= 0 && i < size)) return { docs: new Uint32Array(0), fields: new Uint8Array(0) };
      const from = postOffsets[i]!;
      const to = postOffsets[i + 1]!;
      const outDocs: number[] = [];
      const outFields: number[] = [];
      let p = from;
      let prev = 0;
      while (p < to) {
        const [delta, next] = readVarint(postBytes, p);
        if (next >= to) throw damaged("postings");
        prev += delta;
        outDocs.push(prev);
        outFields.push(postBytes[next]!);
        p = next + 1;
      }
      return { docs: Uint32Array.from(outDocs), fields: Uint8Array.from(outFields) };
    },
  };
}
