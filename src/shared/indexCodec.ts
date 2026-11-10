/**
 * The binary DataIndex (format: index-format.ts): encode, decode, merge, and the growable IndexStore that the
 * layout worker and the plugin keep in step with the cache files. Owner: E7. Pure (no DOM, no Node): it runs in
 * the runner, on the main thread and in the worker.
 *
 * PARTS. Every `.cxi` file is a part: rows stored densely with an explicit `ord` blob (stored row → global
 * ordinal). The runner's record part, the plugin's vault part and live deltas therefore interleave in the one
 * ordinal space that `ordinals.cxo` allocates in arrival order (INDEX-DELTA-CONTRACT), and an ordinal never
 * moves while its epoch lasts. Blob names: `ord`; `c.<column>` (IndexColumns); `ids.o/.b`, `titles.o/.b`
 * (UTF-8 string tables); `dict.folders.*`, `dict.projects.*`; the conversation table `cv.*`; relations
 * `r.src|r.hub|r.lnk .o/.t` (CSR, targets are global ordinals); labels `l<i>.s` (u16) or `l<i>.mo/.mt` (multi)
 * plus `l<i>.u` (set by you). The header JSON carries the frozen IndexHeader plus `x` {rows, patches}.
 *
 * PATCH ROWS (`p.*` blobs) update rows that already exist without re-placing anything: per row a mask of
 * PATCH_FLAGS · PATCH_SIZE (chars, words) · PATCH_TITLE · PATCH_REL · PATCH_LABELS and the new values. The record
 * builder uses them for in-place changes and for labels whose target is a vault note (a row of another part).
 *
 * STRUCTURAL vs PATCHABLE. kind, pop, source, speaker, space, folder, conv, idx, t, tAdded, layer, parent,
 * project, noteKind, hubType and hubStatus decide where a point sits, so changing them for an existing ordinal
 * needs a reload of the worker (`loadIndex`); flags, chars, words, title, relations, labels and the conversation
 * table are patchable (`appendIndex` with patch rows, `patchIndex` for flags).
 *
 * ABSENT ROWS. An ordinal that no loaded part provides (an id another part owns but has not delivered yet, or
 * one that vanished) is a row with kind = pop = NONE8 and flags = Excluded, so every consumer that honours
 * Excluded skips it.
 */
import { CortexError } from "./errors";
import {
  COLUMN_TYPES,
  HUB_STATUS_ORDER,
  HUB_TYPE_ORDER,
  INDEX_MAGIC,
  INDEX_VERSION,
  ItemFlag,
  ItemKind,
  NONE16,
  NONE32,
  NONE8,
  NOTE_KIND_ORDER,
  Population,
  SOURCE_ORDER,
  SPACE_ORDER,
  SPEAKER_ORDER,
  type ColumnDesc,
  type ColumnName,
  type ColumnType,
  type ConversationRow,
  type Csr,
  type DataIndex,
  type IndexColumns,
  type IndexHeader,
  type IndexRelations,
  type IndexStats,
  type ItemKindValue,
  type LabelColumn,
  type PopulationValue,
  type StringTable,
} from "./index-format";
import { base32 } from "./ids";
import { gaussian, mulberry32 } from "./rng";
import { SAMPLE_AREAS } from "./spaces";
import { DAY_MS } from "./time";
import type { HubStatus, HubType, NoteKind, SourceKind, SpaceId, Speaker } from "./types";

// ───────────────────────────── constants and small helpers ─────────────────────────────

/** Patch-row mask bits. */
export const PATCH_FLAGS = 1;
export const PATCH_SIZE = 2;
export const PATCH_TITLE = 4;
export const PATCH_REL = 8;
export const PATCH_LABELS = 16;
export const PATCH_ALL = PATCH_FLAGS | PATCH_SIZE | PATCH_TITLE | PATCH_REL | PATCH_LABELS;

/** Column order inside files and stores (the frozen COLUMN_TYPES order). */
export const COLUMN_NAMES: readonly ColumnName[] = Object.keys(COLUMN_TYPES) as ColumnName[];

/** Columns whose change for an existing ordinal moves a point (needs `loadIndex`). */
export const STRUCTURAL_COLUMNS: readonly ColumnName[] = [
  "kind", "pop", "source", "speaker", "space", "folder", "conv", "idx", "t", "tAdded", "layer", "parent", "project", "noteKind", "hubType", "hubStatus",
];

/** Values of an absent row (see the file header). */
const ABSENT: { readonly [K in ColumnName]: number } = {
  kind: NONE8,
  pop: NONE8,
  source: NONE8,
  speaker: NONE8,
  space: NONE8,
  folder: NONE32,
  conv: NONE32,
  idx: NONE32,
  t: Number.NaN,
  tAdded: Number.NaN,
  chars: 0,
  flags: ItemFlag.Excluded,
  layer: NONE8,
  parent: NONE32,
  project: NONE32,
  noteKind: NONE8,
  hubType: NONE8,
  hubStatus: NONE8,
  words: 0,
};

type NumArray = Uint8Array | Uint16Array | Uint32Array | Float32Array | Float64Array;
type MutableCols = { -readonly [K in ColumnName]: IndexColumns[K] };

const BYTES: Readonly<Record<ColumnType, number>> = { u8: 1, u16: 2, u32: 4, f32: 4, f64: 8 };
const ENC = new TextEncoder();
const DEC = new TextDecoder();
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function assertLittleEndian(): void {
  if (!LITTLE_ENDIAN) throw new CortexError("E_INTERNAL", "Cortex index files need a little-endian platform");
}

function alloc(type: ColumnType, n: number): NumArray {
  switch (type) {
    case "u8":
      return new Uint8Array(n);
    case "u16":
      return new Uint16Array(n);
    case "u32":
      return new Uint32Array(n);
    case "f32":
      return new Float32Array(n);
    case "f64":
      return new Float64Array(n);
  }
}

function viewOf(type: ColumnType, buffer: ArrayBuffer, offset: number, length: number): NumArray {
  switch (type) {
    case "u8":
      return new Uint8Array(buffer, offset, length);
    case "u16":
      return new Uint16Array(buffer, offset, length);
    case "u32":
      return new Uint32Array(buffer, offset, length);
    case "f32":
      return new Float32Array(buffer, offset, length);
    case "f64":
      return new Float64Array(buffer, offset, length);
  }
}

const align8 = (n: number): number => (n + 7) & ~7;

function codeMap<T extends string>(order: readonly T[]): Map<string, number> {
  return new Map(order.map((v, i) => [v, i]));
}
const SOURCE_CODE = codeMap(SOURCE_ORDER);
const SPEAKER_CODE = codeMap(SPEAKER_ORDER);
const SPACE_CODE = codeMap(SPACE_ORDER);
const NOTE_KIND_CODE = codeMap(NOTE_KIND_ORDER);
const HUB_TYPE_CODE = codeMap(HUB_TYPE_ORDER);
const HUB_STATUS_CODE = codeMap(HUB_STATUS_ORDER);

export const sourceCode = (s: SourceKind | undefined): number => (s === undefined ? NONE8 : (SOURCE_CODE.get(s) ?? NONE8));
export const speakerCode = (s: Speaker | undefined): number => (s === undefined ? NONE8 : (SPEAKER_CODE.get(s) ?? NONE8));
export const spaceCode = (s: SpaceId | undefined): number => (s === undefined ? NONE8 : (SPACE_CODE.get(s) ?? NONE8));
export const noteKindCode = (k: NoteKind | undefined): number => (k === undefined ? NONE8 : (NOTE_KIND_CODE.get(k) ?? NONE8));
export const hubTypeCode = (k: HubType | undefined): number => (k === undefined ? NONE8 : (HUB_TYPE_CODE.get(k) ?? NONE8));
export const hubStatusCode = (k: HubStatus | undefined): number => (k === undefined ? NONE8 : (HUB_STATUS_CODE.get(k) ?? NONE8));

/** True for an ordinal that no loaded part provides (see the file header). */
export function isAbsent(index: DataIndex, ordinal: number): boolean {
  return !(ordinal >= 0 && ordinal < index.count) || index.cols.kind[ordinal] === NONE8;
}

/** An empty conversation row value (used when a row index is out of range). */
const NO_CONVERSATION: ConversationRow = { id: "", title: "", source: "obsidian", startedAt: Number.NaN, endedAt: Number.NaN, entryCount: 0, space: "none", gist: NONE32 };

// ───────────────────────────── byte arenas and string tables ─────────────────────────────

class ByteArena {
  bytes: Uint8Array;
  used = 0;
  constructor(
    cap = 1024,
    private readonly onGrow?: (b: ArrayBufferLike) => void,
  ) {
    this.bytes = new Uint8Array(cap);
    onGrow?.(this.bytes.buffer);
  }
  reserve(extra: number): void {
    if (this.used + extra <= this.bytes.length) return;
    const cap = Math.max(this.bytes.length * 2, this.used + extra, 1024);
    const next = new Uint8Array(cap);
    next.set(this.bytes.subarray(0, this.used));
    this.bytes = next;
    this.onGrow?.(next.buffer);
  }
  /** Appends UTF-8 bytes of `s`; returns the start offset (length = used - start). */
  appendString(s: string): number {
    const start = this.used;
    if (s.length === 0) return start;
    this.reserve(s.length * 3);
    const r = ENC.encodeInto(s, this.bytes.subarray(this.used));
    this.used += r.written;
    return start;
  }
  appendBytes(b: Uint8Array): number {
    const start = this.used;
    if (b.length === 0) return start;
    this.reserve(b.length);
    this.bytes.set(b, this.used);
    this.used += b.length;
    return start;
  }
}

/** Collects strings into an offsets (n + 1) + bytes table for writing. */
class StringsWriter {
  private readonly arena = new ByteArena(4096);
  private offsets: Uint32Array = new Uint32Array(64);
  private n = 0;
  private push(end: number): void {
    if (this.n + 2 > this.offsets.length) {
      const next = new Uint32Array(this.offsets.length * 2);
      next.set(this.offsets);
      this.offsets = next;
    }
    this.n++;
    this.offsets[this.n] = end;
  }
  add(s: string): void {
    this.arena.appendString(s);
    this.push(this.arena.used);
  }
  addBytes(b: Uint8Array): void {
    this.arena.appendBytes(b);
    this.push(this.arena.used);
  }
  finish(): { offsets: Uint32Array; bytes: Uint8Array } {
    return { offsets: this.offsets.slice(0, this.n + 1), bytes: this.arena.bytes.slice(0, this.arena.used) };
  }
}

/** A string table over UTF-8 bytes + offsets (n + 1), decoded lazily. */
export class Utf8Table implements StringTable {
  constructor(
    readonly offsets: Uint32Array,
    readonly bytes: Uint8Array,
  ) {}
  get size(): number {
    return Math.max(0, this.offsets.length - 1);
  }
  get(i: number): string {
    if (!(i >= 0 && i < this.size)) return "";
    const a = this.offsets[i]!;
    const b = this.offsets[i + 1]!;
    return b > a ? DEC.decode(this.bytes.subarray(a, b)) : "";
  }
  bytesAt(i: number): Uint8Array {
    if (!(i >= 0 && i < this.size)) return new Uint8Array(0);
    return this.bytes.subarray(this.offsets[i]!, this.offsets[i + 1]!);
  }
}

class ListTable implements StringTable {
  constructor(private readonly values: readonly string[]) {}
  get size(): number {
    return this.values.length;
  }
  get(i: number): string {
    return this.values[i] ?? "";
  }
}

/** Insertion-ordered string dictionary (stable ids). */
class Dict {
  readonly values: string[] = [];
  private readonly index = new Map<string, number>();
  constructor(seed: readonly string[] = []) {
    for (const s of seed) this.id(s);
  }
  id(s: string): number {
    let i = this.index.get(s);
    if (i === undefined) {
      i = this.values.length;
      this.values.push(s);
      this.index.set(s, i);
    }
    return i;
  }
  find(s: string): number {
    return this.index.get(s) ?? -1;
  }
  get size(): number {
    return this.values.length;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ───────────────────────────── writer ─────────────────────────────

/** Header as stored: the frozen IndexHeader plus this codec's extension. */
export interface StoredHeader extends IndexHeader {
  x: { rows: number; patches: number };
}

const MAGIC_BYTES = ENC.encode(INDEX_MAGIC);

class CxiWriter {
  private readonly blobs: { name: string; type: ColumnType; data: NumArray }[] = [];
  add(name: string, type: ColumnType, data: NumArray): void {
    this.blobs.push({ name, type, data });
  }
  strings(prefix: string, t: { offsets: Uint32Array; bytes: Uint8Array }): void {
    this.add(`${prefix}.o`, "u32", t.offsets);
    this.add(`${prefix}.b`, "u8", t.bytes);
  }
  csr(prefix: string, c: Csr): void {
    this.add(`${prefix}.o`, "u32", c.offsets);
    this.add(`${prefix}.t`, "u32", c.targets);
  }
  finish(header: Omit<StoredHeader, "blobs">): ArrayBuffer {
    assertLittleEndian();
    let base = align8(8 + 1024);
    let json = new Uint8Array(0);
    let descs: ColumnDesc[] = [];
    let end = base;
    for (let iter = 0; iter < 8; iter++) {
      descs = [];
      let off = base;
      for (const b of this.blobs) {
        off = align8(off);
        descs.push({ name: b.name, type: b.type, offset: off, length: b.data.length });
        off += b.data.length * BYTES[b.type];
      }
      end = off;
      json = ENC.encode(JSON.stringify({ ...header, blobs: descs }));
      if (8 + json.length <= base) break;
      base = align8(8 + json.length + 256);
    }
    if (8 + json.length > base) throw new CortexError("E_INTERNAL", "index header did not converge");
    const out = new ArrayBuffer(align8(end));
    const u8 = new Uint8Array(out);
    u8.set(MAGIC_BYTES, 0);
    new DataView(out).setUint32(4, base - 8, true);
    u8.set(json, 8);
    u8.fill(0x20, 8 + json.length, base);
    this.blobs.forEach((b, i) => {
      const d = descs[i]!;
      u8.set(new Uint8Array(b.data.buffer, b.data.byteOffset, b.data.byteLength), d.offset);
    });
    return out;
  }
}

// ───────────────────────────── reading parts ─────────────────────────────

export interface PartConversations {
  readonly size: number;
  readonly ids: Utf8Table;
  readonly titles: Utf8Table;
  readonly start: Float64Array;
  readonly end: Float64Array;
  readonly count: Uint32Array;
  readonly gist: Uint32Array;
  readonly source: Uint8Array;
  readonly space: Uint8Array;
}

export interface PartPatch {
  readonly rows: number;
  readonly ord: Uint32Array;
  readonly mask: Uint8Array;
  readonly flags: Uint32Array;
  readonly chars: Uint32Array;
  readonly words: Uint32Array;
  readonly titles: Utf8Table;
  readonly rel: IndexRelations;
  readonly labels: LabelColumn[];
}

/** A decoded part: stored rows (not yet placed at their ordinals) plus optional patch rows. */
export interface IndexPart {
  readonly header: StoredHeader;
  readonly rows: number;
  /** Global ordinal of each stored row. */
  readonly ord: Uint32Array;
  readonly cols: IndexColumns;
  readonly ids: Utf8Table;
  readonly titles: Utf8Table;
  readonly folders: Utf8Table;
  readonly projects: Utf8Table;
  readonly convs: PartConversations;
  readonly rel: IndexRelations;
  readonly labels: LabelColumn[];
  readonly patch: PartPatch | null;
}

function damaged(what: string): CortexError {
  return new CortexError("E_PARSE", `index file is damaged (${what})`);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse and validate only the header (cheap; used to compare files without decoding them). */
export function readIndexHeader(buffer: ArrayBuffer): StoredHeader {
  assertLittleEndian();
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) throw damaged("too short");
  const u8 = new Uint8Array(buffer);
  for (let i = 0; i < 4; i++) if (u8[i] !== MAGIC_BYTES[i]) throw damaged("magic");
  const len = new DataView(buffer).getUint32(4, true);
  if (8 + len > buffer.byteLength) throw damaged("header length");
  let header: unknown;
  try {
    header = JSON.parse(DEC.decode(u8.subarray(8, 8 + len)));
  } catch {
    throw damaged("header JSON");
  }
  if (!isObj(header)) throw damaged("header");
  if (header.magic !== INDEX_MAGIC || header.version !== INDEX_VERSION) throw damaged("version");
  if (!Array.isArray(header.blobs) || !Array.isArray(header.labels) || !isObj(header.stats) || !isObj(header.x)) throw damaged("header fields");
  if (typeof header.epoch !== "string" || typeof header.count !== "number" || typeof header.conversations !== "number") throw damaged("header fields");
  const x = header.x;
  if (typeof x.rows !== "number" || typeof x.patches !== "number" || x.rows < 0 || x.patches < 0) throw damaged("row counts");
  for (const b of header.blobs as unknown[]) {
    if (!isObj(b) || typeof b.name !== "string" || typeof b.offset !== "number" || typeof b.length !== "number" || typeof b.type !== "string" || !(b.type in BYTES)) throw damaged("blob table");
    const bytes = b.length * BYTES[b.type as ColumnType];
    if (b.offset % 8 !== 0 || b.offset < 8 + len || b.offset + bytes > buffer.byteLength || b.length < 0) throw damaged(`blob ${b.name}`);
  }
  return header as unknown as StoredHeader;
}

class BlobReader {
  private readonly map: Map<string, ColumnDesc>;
  constructor(
    private readonly buffer: ArrayBuffer,
    header: StoredHeader,
  ) {
    this.map = new Map(header.blobs.map((d) => [d.name, d]));
  }
  has(name: string): boolean {
    return this.map.has(name);
  }
  get(name: string, type: ColumnType, length?: number): NumArray {
    const d = this.map.get(name);
    if (!d) throw damaged(`missing ${name}`);
    if (d.type !== type) throw damaged(`type of ${name}`);
    if (length !== undefined && d.length !== length) throw damaged(`length of ${name}`);
    return viewOf(type, this.buffer, d.offset, d.length);
  }
  table(prefix: string, size: number): Utf8Table {
    const offsets = this.get(`${prefix}.o`, "u32", size + 1) as Uint32Array;
    const bytes = this.get(`${prefix}.b`, "u8") as Uint8Array;
    checkOffsets(offsets, bytes.length, prefix);
    return new Utf8Table(offsets, bytes);
  }
  csr(prefix: string, rows: number): Csr {
    const offsets = this.get(`${prefix}.o`, "u32", rows + 1) as Uint32Array;
    const targets = this.get(`${prefix}.t`, "u32") as Uint32Array;
    checkOffsets(offsets, targets.length, prefix);
    return { offsets, targets };
  }
}

function checkOffsets(offsets: Uint32Array, total: number, what: string): void {
  if (offsets.length === 0 || offsets[0] !== 0 || offsets[offsets.length - 1] !== total) throw damaged(`offsets of ${what}`);
  for (let i = 1; i < offsets.length; i++) if (offsets[i]! < offsets[i - 1]!) throw damaged(`offsets of ${what}`);
}

function readLabels(r: BlobReader, header: StoredHeader, prefix: string, rows: number): LabelColumn[] {
  return header.labels.map((l, i) => {
    if (!isObj(l) || typeof l.pack !== "string" || typeof l.field !== "string" || !Array.isArray(l.values)) throw damaged("label header");
    const values = l.values.map((v) => String(v));
    const byUser = r.get(`${prefix}${i}.u`, "u8", rows) as Uint8Array;
    if (l.type === "multi") {
      const multi = r.csr(`${prefix}${i}.m`, rows);
      for (let k = 0; k < multi.targets.length; k++) if (multi.targets[k]! >= values.length) throw damaged("label value");
      return { pack: l.pack, packVersion: String(l.packVersion), field: l.field, type: "multi", values, multi, byUser };
    }
    if (l.type !== "enum" && l.type !== "bool" && l.type !== "text") throw damaged("label type");
    const single = r.get(`${prefix}${i}.s`, "u16", rows) as Uint16Array;
    for (let k = 0; k < rows; k++) {
      const v = single[k]!;
      if (v !== NONE16 && v >= values.length) throw damaged("label value");
    }
    return { pack: l.pack, packVersion: String(l.packVersion), field: l.field, type: l.type, values, single, byUser };
  });
}

/** Decode one part file (zero-copy views over `buffer`). Throws CortexError E_PARSE on a damaged file. */
export function decodePart(buffer: ArrayBuffer): IndexPart {
  const header = readIndexHeader(buffer);
  const r = new BlobReader(buffer, header);
  const rows = header.x.rows;
  const ord = r.get("ord", "u32", rows) as Uint32Array;
  const cols = {} as MutableCols;
  for (const name of COLUMN_NAMES) (cols as Record<ColumnName, NumArray>)[name] = r.get(`c.${name}`, COLUMN_TYPES[name], rows);
  const ids = r.table("ids", rows);
  const titles = r.table("titles", rows);
  const folders = r.has("dict.folders.o") ? r.table("dict.folders", (r.get("dict.folders.o", "u32") as Uint32Array).length - 1) : new Utf8Table(new Uint32Array([0]), new Uint8Array(0));
  const projects = r.has("dict.projects.o") ? r.table("dict.projects", (r.get("dict.projects.o", "u32") as Uint32Array).length - 1) : new Utf8Table(new Uint32Array([0]), new Uint8Array(0));
  const nc = header.conversations;
  const convs: PartConversations = {
    size: nc,
    ids: r.table("cv.id", nc),
    titles: r.table("cv.title", nc),
    start: r.get("cv.start", "f64", nc) as Float64Array,
    end: r.get("cv.end", "f64", nc) as Float64Array,
    count: r.get("cv.count", "u32", nc) as Uint32Array,
    gist: r.get("cv.gist", "u32", nc) as Uint32Array,
    source: r.get("cv.source", "u8", nc) as Uint8Array,
    space: r.get("cv.space", "u8", nc) as Uint8Array,
  };
  for (let k = 0; k < rows; k++) {
    const f = cols.folder[k]!;
    if (f !== NONE32 && f >= folders.size) throw damaged("folder id");
    const p = cols.project[k]!;
    if (p !== NONE32 && p >= projects.size) throw damaged("project id");
    const c = cols.conv[k]!;
    if (c !== NONE32 && c >= nc) throw damaged("conversation row");
  }
  const rel: IndexRelations = { noteSources: r.csr("r.src", rows), hubMembers: r.csr("r.hub", rows), noteLinks: r.csr("r.lnk", rows) };
  const labels = readLabels(r, header, "l", rows);
  let patch: PartPatch | null = null;
  const pn = header.x.patches;
  if (pn > 0) {
    patch = {
      rows: pn,
      ord: r.get("p.ord", "u32", pn) as Uint32Array,
      mask: r.get("p.mask", "u8", pn) as Uint8Array,
      flags: r.get("p.flags", "u32", pn) as Uint32Array,
      chars: r.get("p.chars", "u32", pn) as Uint32Array,
      words: r.get("p.words", "u32", pn) as Uint32Array,
      titles: r.table("p.titles", pn),
      rel: { noteSources: r.csr("p.r.src", pn), hubMembers: r.csr("p.r.hub", pn), noteLinks: r.csr("p.r.lnk", pn) },
      labels: readLabels(r, header, "p.l", pn),
    };
  }
  return { header, rows, ord, cols, ids, titles, folders, projects, convs, rel, labels, patch };
}

// ───────────────────────────── building parts from builder input ─────────────────────────────

/** One item as the builders produce it (strings resolved to dictionaries during encoding). */
export interface IndexItemInput {
  id: string;
  kind: ItemKindValue;
  pop: PopulationValue;
  source: SourceKind;
  speaker: Speaker;
  space: SpaceId;
  /** Folder path ("" = no folder). */
  folderPath: string;
  /** Conversation id (a row of `conversations`). */
  conv?: string;
  idx?: number;
  /** writtenAt (epoch ms); undefined or NaN = undated. */
  t?: number;
  tAdded: number;
  chars: number;
  flags: number;
  layer?: number;
  /** Parent note id (decision → gist → map). */
  parent?: string;
  project?: string;
  title: string;
  /** Global ordinal; default: `firstOrdinal + position`. */
  ordinal?: number;
  noteKind?: NoteKind;
  hubType?: HubType;
  hubStatus?: HubStatus;
  words?: number;
}

/** A patch row: the complete patchable state named by `mask` (relations and labels come from the input maps). */
export interface IndexPatchInput {
  id: string;
  ordinal: number;
  mask: number;
  flags?: number;
  chars?: number;
  words?: number;
  title?: string;
}

export interface LabelInput {
  pack: string;
  packVersion: string;
  field: string;
  type: LabelColumn["type"];
  /** Seed for the value dictionary (keeps value ids stable across builds); new values are appended. */
  values?: readonly string[];
  byTarget: ReadonlyMap<string, { value: string | string[] | boolean; byUser: boolean }>;
}

export interface IndexBuildInput {
  part: IndexHeader["part"];
  seq: number;
  items: readonly IndexItemInput[];
  conversations: readonly ConversationRow[];
  /** note id → cited entry ids; hub id → member note ids; note id → linked note ids. */
  noteSources: ReadonlyMap<string, readonly string[]>;
  hubMembers: ReadonlyMap<string, readonly string[]>;
  noteLinks: ReadonlyMap<string, readonly string[]>;
  /** Effective labels: target id → value per (pack, field). */
  labels: readonly LabelInput[];
  /** Ordinal epoch of the allocator these ordinals come from ("" for a standalone index). */
  epoch?: string;
  /** Ordinal of the first item when items carry no explicit ordinal (default 0). */
  firstOrdinal?: number;
  /** Allocator size when built (header.count); default max ordinal + 1. */
  count?: number;
  /** header.baseCount (a delta file names its base's count here); default `count`. */
  baseCount?: number;
  builtAt?: string;
  /** Resolves ids of other parts (relation targets, parents); default: the items of this input. */
  ordinalOf?: (id: string) => number | undefined;
  patches?: readonly IndexPatchInput[];
  /** Seeds for the folder and project dictionaries (stable ids across builds). */
  dicts?: { folders?: readonly string[]; projects?: readonly string[] };
}

function toLabelStrings(v: string | string[] | boolean): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "boolean") return [v ? "true" : "false"];
  return [v];
}

function computePartStats(cols: IndexColumns, rows: number, conversations: number): IndexStats {
  const stats: IndexStats = { notes: 0, record: 0, undated: 0, conversations, firstT: Number.NaN, lastT: Number.NaN, bySource: {} };
  for (let i = 0; i < rows; i++) {
    const kind = cols.kind[i]!;
    if (kind === NONE8 || (cols.flags[i]! & ItemFlag.Excluded) !== 0) continue;
    if (cols.pop[i] === Population.Note) stats.notes++;
    else if (cols.pop[i] === Population.Record) {
      stats.record++;
      const src = SOURCE_ORDER[cols.source[i]!];
      if (src) stats.bySource[src] = (stats.bySource[src] ?? 0) + 1;
      const t = cols.t[i]!;
      if (Number.isNaN(t)) stats.undated++;
      else {
        if (!(t >= stats.firstT)) stats.firstT = t;
        if (!(t <= stats.lastT)) stats.lastT = t;
      }
    }
  }
  return stats;
}

function csrFromLists(lists: readonly (readonly number[] | Uint32Array | undefined)[]): Csr {
  const offsets = new Uint32Array(lists.length + 1);
  let total = 0;
  for (let i = 0; i < lists.length; i++) {
    total += lists[i]?.length ?? 0;
    offsets[i + 1] = total;
  }
  const targets = new Uint32Array(total);
  let o = 0;
  for (const l of lists) {
    if (!l) continue;
    for (let k = 0; k < l.length; k++) targets[o++] = l[k]!;
  }
  return { offsets, targets };
}

function writeLabelBlobs(w: CxiWriter, prefix: string, cols: readonly { type: LabelColumn["type"]; single?: Uint16Array; multi?: Csr; byUser: Uint8Array }[]): void {
  cols.forEach((c, i) => {
    if (c.type === "multi") w.csr(`${prefix}${i}.m`, c.multi ?? { offsets: new Uint32Array(1), targets: new Uint32Array(0) });
    else w.add(`${prefix}${i}.s`, "u16", c.single ?? new Uint16Array(0));
    w.add(`${prefix}${i}.u`, "u8", c.byUser);
  });
}

function writeConversations(w: CxiWriter, rows: readonly ConversationRow[]): void {
  const n = rows.length;
  const ids = new StringsWriter();
  const titles = new StringsWriter();
  const start = new Float64Array(n);
  const end = new Float64Array(n);
  const count = new Uint32Array(n);
  const gist = new Uint32Array(n);
  const source = new Uint8Array(n);
  const space = new Uint8Array(n);
  rows.forEach((c, i) => {
    ids.add(c.id);
    titles.add(c.title);
    start[i] = c.startedAt;
    end[i] = c.endedAt;
    count[i] = Math.max(0, Math.min(NONE32 - 1, Math.floor(c.entryCount))) >>> 0;
    gist[i] = c.gist;
    source[i] = sourceCode(c.source);
    space[i] = spaceCode(c.space);
  });
  w.strings("cv.id", ids.finish());
  w.strings("cv.title", titles.finish());
  w.add("cv.start", "f64", start);
  w.add("cv.end", "f64", end);
  w.add("cv.count", "u32", count);
  w.add("cv.gist", "u32", gist);
  w.add("cv.source", "u8", source);
  w.add("cv.space", "u8", space);
}

const u32 = (n: number | undefined, fallback = 0): number => (n === undefined || !Number.isFinite(n) || n < 0 ? fallback : Math.min(NONE32 - 1, Math.floor(n)));

/** Encode builder output as one part file. */
export function encodeIndex(input: IndexBuildInput): ArrayBuffer {
  const items = input.items;
  const rows = items.length;
  const first = input.firstOrdinal ?? 0;
  const ordOf = (it: IndexItemInput, r: number): number => (it.ordinal !== undefined ? it.ordinal : first + r);
  const local = new Map<string, number>();
  items.forEach((it, r) => local.set(it.id, ordOf(it, r)));
  const resolve = (id: string): number | undefined => local.get(id) ?? input.ordinalOf?.(id);
  const folders = new Dict(input.dicts?.folders ?? []);
  const projects = new Dict(input.dicts?.projects ?? []);
  const convRow = new Map<string, number>();
  input.conversations.forEach((c, i) => convRow.set(c.id, i));

  const ord = new Uint32Array(rows);
  const cols = {} as MutableCols;
  for (const name of COLUMN_NAMES) (cols as Record<ColumnName, NumArray>)[name] = alloc(COLUMN_TYPES[name], rows);
  const ids = new StringsWriter();
  const titles = new StringsWriter();
  let maxOrd = -1;
  for (let r = 0; r < rows; r++) {
    const it = items[r]!;
    const o = ordOf(it, r);
    if (!Number.isInteger(o) || o < 0 || o >= NONE32) throw new CortexError("E_BAD_REQUEST", `invalid ordinal for ${it.id}`);
    ord[r] = o;
    if (o > maxOrd) maxOrd = o;
    cols.kind[r] = it.kind;
    cols.pop[r] = it.pop;
    cols.source[r] = sourceCode(it.source);
    cols.speaker[r] = speakerCode(it.speaker);
    cols.space[r] = spaceCode(it.space);
    cols.folder[r] = it.folderPath ? folders.id(it.folderPath) : NONE32;
    cols.conv[r] = it.conv !== undefined ? (convRow.get(it.conv) ?? NONE32) : NONE32;
    cols.idx[r] = it.idx !== undefined ? u32(it.idx, NONE32) : NONE32;
    cols.t[r] = it.t === undefined ? Number.NaN : it.t;
    cols.tAdded[r] = it.tAdded;
    cols.chars[r] = u32(it.chars);
    cols.flags[r] = it.flags >>> 0;
    cols.layer[r] = it.layer !== undefined && it.layer >= 0 && it.layer < NONE8 ? Math.floor(it.layer) : NONE8;
    cols.parent[r] = it.parent !== undefined ? (resolve(it.parent) ?? NONE32) : NONE32;
    cols.project[r] = it.project ? projects.id(it.project) : NONE32;
    cols.noteKind[r] = noteKindCode(it.noteKind);
    cols.hubType[r] = hubTypeCode(it.hubType);
    cols.hubStatus[r] = hubStatusCode(it.hubStatus);
    cols.words[r] = u32(it.words);
    ids.add(it.id);
    titles.add(it.title);
  }
  const resolveList = (list: readonly string[] | undefined): number[] | undefined => {
    if (!list || list.length === 0) return undefined;
    const out: number[] = [];
    const seen = new Set<number>();
    for (const id of list) {
      const o = resolve(id);
      if (o !== undefined && !seen.has(o)) {
        seen.add(o);
        out.push(o);
      }
    }
    return out;
  };
  const relOf = (ids2: readonly string[]): IndexRelations => ({
    noteSources: csrFromLists(ids2.map((id) => resolveList(input.noteSources.get(id)))),
    hubMembers: csrFromLists(ids2.map((id) => resolveList(input.hubMembers.get(id)))),
    noteLinks: csrFromLists(ids2.map((id) => resolveList(input.noteLinks.get(id)))),
  });
  const rowIds = items.map((it) => it.id);
  const rel = relOf(rowIds);

  // Labels: dictionaries seeded for stable ids, then values per row and per patch row.
  const labelDicts = input.labels.map((l) => new Dict(l.values ?? []));
  const labelCols = (targetIds: readonly string[]) =>
    input.labels.map((l, li) => {
      const dict = labelDicts[li]!;
      const n = targetIds.length;
      const byUser = new Uint8Array(n);
      if (l.type === "multi") {
        const lists: number[][] = [];
        for (let r = 0; r < n; r++) {
          const v = l.byTarget.get(targetIds[r]!);
          if (!v) {
            lists.push([]);
            continue;
          }
          const ids3 = [...new Set(toLabelStrings(v.value))].map((s) => dict.id(s));
          lists.push(ids3);
          byUser[r] = v.byUser ? 1 : 0;
        }
        return { type: l.type, multi: csrFromLists(lists), byUser };
      }
      const single = new Uint16Array(n).fill(NONE16);
      for (let r = 0; r < n; r++) {
        const v = l.byTarget.get(targetIds[r]!);
        if (!v) continue;
        const s = toLabelStrings(v.value)[0];
        if (s === undefined) continue;
        const id = dict.id(s);
        if (id >= NONE16) continue;
        single[r] = id;
        byUser[r] = v.byUser ? 1 : 0;
      }
      return { type: l.type, single, byUser };
    });
  const rowLabels = labelCols(rowIds);
  const patches = input.patches ?? [];
  const patchIds = patches.map((p) => p.id);
  const patchLabels = patches.length > 0 ? labelCols(patchIds) : [];

  const count = Math.max(input.count ?? 0, maxOrd + 1);
  const w = new CxiWriter();
  w.add("ord", "u32", ord);
  for (const name of COLUMN_NAMES) w.add(`c.${name}`, COLUMN_TYPES[name], (cols as Record<ColumnName, NumArray>)[name]);
  w.strings("ids", ids.finish());
  w.strings("titles", titles.finish());
  const fw = new StringsWriter();
  for (const f of folders.values) fw.add(f);
  w.strings("dict.folders", fw.finish());
  const pw = new StringsWriter();
  for (const p of projects.values) pw.add(p);
  w.strings("dict.projects", pw.finish());
  writeConversations(w, input.conversations);
  w.csr("r.src", rel.noteSources);
  w.csr("r.hub", rel.hubMembers);
  w.csr("r.lnk", rel.noteLinks);
  writeLabelBlobs(w, "l", rowLabels);
  if (patches.length > 0) {
    const pn = patches.length;
    const pord = new Uint32Array(pn);
    const mask = new Uint8Array(pn);
    const flags = new Uint32Array(pn);
    const chars = new Uint32Array(pn);
    const words = new Uint32Array(pn);
    const ptitles = new StringsWriter();
    patches.forEach((p, i) => {
      pord[i] = p.ordinal;
      mask[i] = p.mask & PATCH_ALL;
      flags[i] = (p.flags ?? 0) >>> 0;
      chars[i] = u32(p.chars);
      words[i] = u32(p.words);
      ptitles.add(p.title ?? "");
    });
    w.add("p.ord", "u32", pord);
    w.add("p.mask", "u8", mask);
    w.add("p.flags", "u32", flags);
    w.add("p.chars", "u32", chars);
    w.add("p.words", "u32", words);
    w.strings("p.titles", ptitles.finish());
    const prel = relOf(patchIds);
    w.csr("p.r.src", prel.noteSources);
    w.csr("p.r.hub", prel.hubMembers);
    w.csr("p.r.lnk", prel.noteLinks);
    writeLabelBlobs(w, "p.l", patchLabels);
  }
  return w.finish({
    magic: INDEX_MAGIC,
    version: INDEX_VERSION,
    part: input.part,
    builtAt: input.builtAt ?? new Date().toISOString(),
    seq: input.seq,
    epoch: input.epoch ?? "",
    baseCount: input.baseCount ?? count,
    count,
    conversations: input.conversations.length,
    labels: input.labels.map((l, i) => ({ pack: l.pack, packVersion: l.packVersion, field: l.field, type: l.type, values: labelDicts[i]!.values })),
    stats: computePartStats(cols, rows, input.conversations.length),
    x: { rows, patches: patches.length },
  });
}

// ───────────────────────────── the growable store ─────────────────────────────

/** A growable u32 arena with one (start, len) slice per ordinal (relations and multi labels). */
class SliceArena {
  start: Uint32Array;
  len: Uint32Array;
  data: Uint32Array;
  used = 0;
  garbage = 0;
  constructor(
    cap: number,
    private readonly reg: (b: ArrayBufferLike) => void,
  ) {
    this.start = new Uint32Array(cap);
    this.len = new Uint32Array(cap);
    this.data = new Uint32Array(256);
    reg(this.start.buffer);
    reg(this.len.buffer);
    reg(this.data.buffer);
  }
  grow(cap: number, n: number): void {
    const s = new Uint32Array(cap);
    s.set(this.start.subarray(0, n));
    const l = new Uint32Array(cap);
    l.set(this.len.subarray(0, n));
    this.start = s;
    this.len = l;
    this.reg(s.buffer);
    this.reg(l.buffer);
  }
  get(o: number): Uint32Array {
    const n = this.len[o]!;
    return n === 0 ? EMPTY_U32 : this.data.subarray(this.start[o]!, this.start[o]! + n);
  }
  set(o: number, values: ArrayLike<number>, live: number): void {
    this.garbage += this.len[o]!;
    const n = values.length;
    if (n === 0) {
      this.start[o] = 0;
      this.len[o] = 0;
      return;
    }
    if (this.used + n > this.data.length) {
      if (this.garbage > this.used / 2) this.compact(live);
      if (this.used + n > this.data.length) {
        const next = new Uint32Array(Math.max(this.data.length * 2, this.used + n));
        next.set(this.data.subarray(0, this.used));
        this.data = next;
        this.reg(next.buffer);
      }
    }
    for (let k = 0; k < n; k++) this.data[this.used + k] = values[k]!;
    this.start[o] = this.used;
    this.len[o] = n;
    this.used += n;
  }
  clear(from: number, to: number): void {
    for (let o = from; o < to; o++) this.garbage += this.len[o]!;
    this.len.fill(0, from, to);
    this.start.fill(0, from, to);
  }
  compact(live: number): void {
    let total = 0;
    for (let o = 0; o < live; o++) total += this.len[o]!;
    const next = new Uint32Array(Math.max(256, total * 2));
    let at = 0;
    for (let o = 0; o < live; o++) {
      const n = this.len[o]!;
      if (n === 0) continue;
      next.set(this.data.subarray(this.start[o]!, this.start[o]! + n), at);
      this.start[o] = at;
      at += n;
    }
    this.data = next;
    this.used = at;
    this.garbage = 0;
    this.reg(next.buffer);
  }
  /** Materialise a CSR over [0, n). */
  toCsr(n: number): Csr {
    const offsets = new Uint32Array(n + 1);
    let total = 0;
    for (let o = 0; o < n; o++) {
      total += this.len[o]!;
      offsets[o + 1] = total;
    }
    const targets = new Uint32Array(total);
    for (let o = 0; o < n; o++) {
      const k = this.len[o]!;
      if (k > 0) targets.set(this.data.subarray(this.start[o]!, this.start[o]! + k), offsets[o]!);
    }
    return { offsets, targets };
  }
}

const EMPTY_U32 = new Uint32Array(0);

interface StoreLabel {
  key: string;
  pack: string;
  packVersion: string;
  field: string;
  type: LabelColumn["type"];
  dict: Dict;
  single: Uint16Array | null;
  multi: SliceArena | null;
  byUser: Uint8Array;
}

/** Labels waiting for a row another part has not delivered yet: per store column, the values as strings. */
type PendingLabels = Map<string, { type: LabelColumn["type"]; pack: string; packVersion: string; field: string; values: string[]; byUser: boolean }>;

/** Strings (ids, titles) with one slice per ordinal in a byte arena. */
class StringSlices {
  start: Uint32Array;
  len: Uint32Array;
  readonly arena: ByteArena;
  private live = 0;
  constructor(
    cap: number,
    private readonly reg: (b: ArrayBufferLike) => void,
  ) {
    this.start = new Uint32Array(cap);
    this.len = new Uint32Array(cap);
    this.arena = new ByteArena(4096, reg);
    reg(this.start.buffer);
    reg(this.len.buffer);
  }
  grow(cap: number, n: number): void {
    const s = new Uint32Array(cap);
    s.set(this.start.subarray(0, n));
    const l = new Uint32Array(cap);
    l.set(this.len.subarray(0, n));
    this.start = s;
    this.len = l;
    this.reg(s.buffer);
    this.reg(l.buffer);
  }
  bytes(o: number): Uint8Array {
    const n = this.len[o]!;
    return n === 0 ? EMPTY_U8 : this.arena.bytes.subarray(this.start[o]!, this.start[o]! + n);
  }
  get(o: number): string {
    const n = this.len[o]!;
    return n === 0 ? "" : DEC.decode(this.arena.bytes.subarray(this.start[o]!, this.start[o]! + n));
  }
  setBytes(o: number, b: Uint8Array): void {
    this.live -= this.len[o]!;
    this.start[o] = this.arena.appendBytes(b);
    this.len[o] = b.length;
    this.live += b.length;
  }
  setString(o: number, s: string): void {
    this.live -= this.len[o]!;
    const start = this.arena.appendString(s);
    this.start[o] = start;
    this.len[o] = this.arena.used - start;
    this.live += this.len[o]!;
  }
  clear(from: number, to: number): void {
    for (let o = from; o < to; o++) this.live -= this.len[o]!;
    this.len.fill(0, from, to);
    this.start.fill(0, from, to);
  }
  maybeCompact(n: number): void {
    if (this.arena.used < 1 << 20 || this.arena.used < this.live * 2) return;
    const next = new Uint8Array(Math.max(4096, this.live * 2));
    let at = 0;
    for (let o = 0; o < n; o++) {
      const k = this.len[o]!;
      if (k === 0) continue;
      next.set(this.arena.bytes.subarray(this.start[o]!, this.start[o]! + k), at);
      this.start[o] = at;
      at += k;
    }
    this.arena.bytes = next;
    this.arena.used = at;
    this.reg(next.buffer);
  }
}

const EMPTY_U8 = new Uint8Array(0);

export interface ApplyResult {
  /** Rows that were absent before (new arrivals). */
  appeared: number;
  /** Smallest ordinal that appeared (count when none). */
  from: number;
  /** Patch rows applied to present rows. */
  patched: number;
}

export interface StoreOptions {
  epoch?: string;
  part?: IndexHeader["part"];
  /** Called for every buffer the store allocates (the worker registers them as state-owned: TRANSFER-DETACH). */
  onBuffer?: (b: ArrayBufferLike) => void;
}

/**
 * The live index: parts placed at their ordinals, growable for arrivals, patchable in place, and readable as a
 * DataIndex snapshot (zero-copy column views; relations materialised on first use).
 */
export class IndexStore {
  epoch: string;
  seq = 0;
  builtAt = "";
  readonly part: IndexHeader["part"];
  private n = 0;
  private cap = 0;
  private c: MutableCols;
  private readonly ids: StringSlices;
  private readonly titles: StringSlices;
  private hashTab: Int32Array = new Int32Array(0);
  private hashUsed = 0;
  readonly folders = new Dict();
  readonly projects = new Dict();
  private readonly convRows: ConversationRow[] = [];
  private readonly convIndex = new Map<string, number>();
  private readonly rels: { src: SliceArena; hub: SliceArena; lnk: SliceArena };
  private readonly labelCols: StoreLabel[] = [];
  private readonly labelKey = new Map<string, number>();
  private readonly pending = new Map<number, PendingLabels>();
  private snap: DataIndex | null = null;
  private readonly reg: (b: ArrayBufferLike) => void;

  constructor(opts: StoreOptions = {}) {
    this.epoch = opts.epoch ?? "";
    this.part = opts.part ?? "merged";
    this.reg = opts.onBuffer ?? (() => undefined);
    this.c = {} as MutableCols;
    for (const name of COLUMN_NAMES) {
      const a = alloc(COLUMN_TYPES[name], 0);
      (this.c as Record<ColumnName, NumArray>)[name] = a;
    }
    this.ids = new StringSlices(0, this.reg);
    this.titles = new StringSlices(0, this.reg);
    this.rels = { src: new SliceArena(0, this.reg), hub: new SliceArena(0, this.reg), lnk: new SliceArena(0, this.reg) };
  }

  /** Assemble a store from parts, in order (later parts overlay earlier ones). */
  static fromParts(parts: readonly IndexPart[], opts: StoreOptions = {}): IndexStore {
    const s = new IndexStore(opts);
    for (const p of parts) s.applyPart(p);
    return s;
  }

  get count(): number {
    return this.n;
  }

  isPresent(o: number): boolean {
    return o >= 0 && o < this.n && this.c.kind[o] !== NONE8;
  }

  flagsAt(o: number): number {
    return o >= 0 && o < this.n ? this.c.flags[o]! : ItemFlag.Excluded;
  }

  idAt(o: number): string {
    return o >= 0 && o < this.n ? this.ids.get(o) : "";
  }

  titleAt(o: number): string {
    return o >= 0 && o < this.n ? this.titles.get(o) : "";
  }

  /** Ordinal of an id (-1 when unknown). */
  ordinalOf(id: string): number {
    if (this.hashTab.length === 0 || id.length === 0) return -1;
    const b = ENC.encode(id);
    const mask = this.hashTab.length - 1;
    let i = fnv1a(b) & mask;
    for (;;) {
      const v = this.hashTab[i]!;
      if (v === 0) return -1;
      const o = v - 1;
      if (o < this.n && bytesEqual(this.ids.bytes(o), b)) return o;
      i = (i + 1) & mask;
    }
  }

  get conversations(): readonly ConversationRow[] {
    return this.convRows;
  }

  // ── capacity ──

  private grow(n: number): void {
    if (n <= this.cap) return;
    // Always keep spare room: a snapshot view then never spans its whole buffer, so even an unregistered
    // store can never have a buffer detached by a transfer (TRANSFER-DETACH).
    const cap = Math.max(n + 64, Math.ceil(this.cap * 1.5), 256);
    for (const name of COLUMN_NAMES) {
      const prev = (this.c as Record<ColumnName, NumArray>)[name];
      const next = alloc(COLUMN_TYPES[name], cap);
      next.set(prev.subarray(0, this.n) as never);
      (this.c as Record<ColumnName, NumArray>)[name] = next;
      this.reg(next.buffer);
    }
    this.ids.grow(cap, this.n);
    this.titles.grow(cap, this.n);
    this.rels.src.grow(cap, this.n);
    this.rels.hub.grow(cap, this.n);
    this.rels.lnk.grow(cap, this.n);
    for (const l of this.labelCols) {
      if (l.single) {
        const s = new Uint16Array(cap).fill(NONE16);
        s.set(l.single.subarray(0, this.n));
        l.single = s;
        this.reg(s.buffer);
      }
      if (l.multi) l.multi.grow(cap, this.n);
      const u = new Uint8Array(cap);
      u.set(l.byUser.subarray(0, this.n));
      l.byUser = u;
      this.reg(u.buffer);
    }
    this.cap = cap;
  }

  /** Grow the ordinal range to `n` (new rows are absent). */
  setCount(n: number): void {
    if (n <= this.n) return;
    this.grow(n);
    const from = this.n;
    for (const name of COLUMN_NAMES) (this.c as Record<ColumnName, NumArray>)[name].fill(ABSENT[name], from, n);
    this.ids.clear(from, n);
    this.titles.clear(from, n);
    this.rels.src.clear(from, n);
    this.rels.hub.clear(from, n);
    this.rels.lnk.clear(from, n);
    for (const l of this.labelCols) {
      l.single?.fill(NONE16, from, n);
      l.multi?.clear(from, n);
      l.byUser.fill(0, from, n);
    }
    this.n = n;
    this.snap = null;
  }

  // ── id hash ──

  private hashInsert(o: number): void {
    if ((this.hashUsed + 1) * 2 > this.hashTab.length) this.rehash(Math.max(1024, this.hashTab.length * 2));
    const b = this.ids.bytes(o);
    if (b.length === 0) return;
    const mask = this.hashTab.length - 1;
    let i = fnv1a(b) & mask;
    for (;;) {
      const v = this.hashTab[i]!;
      if (v === 0) break;
      if (v - 1 === o) return;
      i = (i + 1) & mask;
    }
    this.hashTab[i] = o + 1;
    this.hashUsed++;
  }

  private rehash(size: number): void {
    let s = 1024;
    while (s < size) s *= 2;
    this.hashTab = new Int32Array(s);
    this.hashUsed = 0;
    for (let o = 0; o < this.n; o++) if (this.c.kind[o] !== NONE8) this.hashInsert(o);
  }

  // ── labels ──

  private labelColumn(pack: string, packVersion: string, field: string, type: LabelColumn["type"]): StoreLabel {
    const key = `${pack}|${packVersion}|${field}`;
    const at = this.labelKey.get(key);
    if (at !== undefined) return this.labelCols[at]!;
    const cap = this.cap;
    const col: StoreLabel = {
      key,
      pack,
      packVersion,
      field,
      type,
      dict: new Dict(),
      single: type === "multi" ? null : new Uint16Array(cap).fill(NONE16),
      multi: type === "multi" ? new SliceArena(cap, this.reg) : null,
      byUser: new Uint8Array(cap),
    };
    if (col.single) this.reg(col.single.buffer);
    this.reg(col.byUser.buffer);
    this.labelKey.set(key, this.labelCols.length);
    this.labelCols.push(col);
    return col;
  }

  private setLabel(col: StoreLabel, o: number, values: readonly string[], byUser: boolean): void {
    if (col.type === "multi") {
      const ids = values.map((v) => col.dict.id(v));
      col.multi!.set(o, ids, this.n);
    } else {
      const v = values[0];
      const id = v === undefined ? NONE16 : col.dict.id(v);
      col.single![o] = id >= NONE16 ? NONE16 : id;
    }
    col.byUser[o] = values.length > 0 && byUser ? 1 : 0;
  }

  private labelValues(col: StoreLabel, o: number): string[] {
    if (col.type === "multi") return Array.from(col.multi!.get(o), (id) => col.dict.values[id] ?? "");
    const v = col.single![o]!;
    return v === NONE16 ? [] : [col.dict.values[v] ?? ""];
  }

  private hasAnyLabel(o: number): boolean {
    for (const l of this.labelCols) {
      if (l.single ? l.single[o] !== NONE16 : l.multi!.len[o]! > 0) return true;
    }
    return false;
  }

  private refreshLabelFlag(o: number): void {
    const f = this.c.flags[o]!;
    this.c.flags[o] = this.hasAnyLabel(o) ? f | ItemFlag.HasLabels : f & ~ItemFlag.HasLabels;
  }

  /** Values of one part label column at row `r` as strings. */
  private static partLabelStrings(l: LabelColumn, r: number): string[] {
    if (l.type === "multi") {
      const m = l.multi!;
      const out: string[] = [];
      for (let k = m.offsets[r]!; k < m.offsets[r + 1]!; k++) out.push(l.values[m.targets[k]!] ?? "");
      return out;
    }
    const v = l.single![r]!;
    return v === NONE16 ? [] : [l.values[v] ?? ""];
  }

  // ── applying parts ──

  /** Place a part's rows at their ordinals and apply its patch rows. Throws E_BAD_REQUEST on another epoch. */
  applyPart(part: IndexPart): ApplyResult {
    const h = part.header;
    if (this.epoch === "" && this.n === 0) this.epoch = h.epoch;
    else if (h.epoch !== this.epoch) throw new CortexError("E_BAD_REQUEST", `E_EPOCH: part epoch ${h.epoch} does not match ${this.epoch}`);
    if (h.part !== "vault") {
      this.seq = Math.max(this.seq, h.seq);
      if (h.builtAt > this.builtAt) this.builtAt = h.builtAt;
    } else if (this.builtAt === "") this.builtAt = h.builtAt;
    this.snap = null;

    // Tables first: conversations (upsert by id), dictionary and label maps.
    const convMap = new Uint32Array(part.convs.size);
    for (let i = 0; i < part.convs.size; i++) {
      const row: ConversationRow = {
        id: part.convs.ids.get(i),
        title: part.convs.titles.get(i),
        source: SOURCE_ORDER[part.convs.source[i]!] ?? "obsidian",
        startedAt: part.convs.start[i]!,
        endedAt: part.convs.end[i]!,
        entryCount: part.convs.count[i]!,
        space: SPACE_ORDER[part.convs.space[i]!] ?? "none",
        gist: part.convs.gist[i]!,
      };
      const at = this.convIndex.get(row.id);
      if (at === undefined) {
        convMap[i] = this.convRows.length;
        this.convIndex.set(row.id, this.convRows.length);
        this.convRows.push(row);
      } else {
        convMap[i] = at;
        this.convRows[at] = row;
      }
    }
    const folderMap = new Int32Array(part.folders.size).fill(-1);
    const projectMap = new Int32Array(part.projects.size).fill(-1);
    const mapDict = (map: Int32Array, table: Utf8Table, dict: Dict, id: number): number => {
      if (id === NONE32 || id >= map.length) return NONE32;
      let v = map[id]!;
      if (v < 0) {
        v = dict.id(table.get(id));
        map[id] = v;
      }
      return v;
    };
    const cols = part.labels.map((l) => this.labelColumn(l.pack, l.packVersion, l.field, l.type));

    let appeared = 0;
    let from = Number.POSITIVE_INFINITY;
    let maxOrd = -1;
    for (let r = 0; r < part.rows; r++) if (part.ord[r]! > maxOrd) maxOrd = part.ord[r]!;
    if (maxOrd + 1 > this.n) this.setCount(maxOrd + 1);
    const pc = part.cols;
    const sc = this.c;
    for (let r = 0; r < part.rows; r++) {
      const o = part.ord[r]!;
      const was = sc.kind[o] !== NONE8;
      sc.kind[o] = pc.kind[r]!;
      sc.pop[o] = pc.pop[r]!;
      sc.source[o] = pc.source[r]!;
      sc.speaker[o] = pc.speaker[r]!;
      sc.space[o] = pc.space[r]!;
      sc.folder[o] = mapDict(folderMap, part.folders, this.folders, pc.folder[r]!);
      sc.conv[o] = pc.conv[r] === NONE32 ? NONE32 : (convMap[pc.conv[r]!] ?? NONE32);
      sc.idx[o] = pc.idx[r]!;
      sc.t[o] = pc.t[r]!;
      sc.tAdded[o] = pc.tAdded[r]!;
      sc.chars[o] = pc.chars[r]!;
      sc.flags[o] = pc.flags[r]!;
      sc.layer[o] = pc.layer[r]!;
      sc.parent[o] = pc.parent[r]!;
      sc.project[o] = mapDict(projectMap, part.projects, this.projects, pc.project[r]!);
      sc.noteKind[o] = pc.noteKind[r]!;
      sc.hubType[o] = pc.hubType[r]!;
      sc.hubStatus[o] = pc.hubStatus[r]!;
      sc.words[o] = pc.words[r]!;
      this.ids.setBytes(o, part.ids.bytesAt(r));
      this.titles.setBytes(o, part.titles.bytesAt(r));
      this.setRel(o, part.rel, r);
      part.labels.forEach((l, li) => this.setLabel(cols[li]!, o, IndexStore.partLabelStrings(l, r), l.byUser[r] === 1));
      if (!was) {
        appeared++;
        if (o < from) from = o;
        this.hashInsert(o);
        const p = this.pending.get(o);
        if (p) {
          this.pending.delete(o);
          for (const v of p.values()) this.setLabel(this.labelColumn(v.pack, v.packVersion, v.field, v.type), o, v.values, v.byUser);
        }
      }
      this.refreshLabelFlag(o);
    }
    let patched = 0;
    const pt = part.patch;
    if (pt) {
      const pcols = pt.labels.map((l) => this.labelColumn(l.pack, l.packVersion, l.field, l.type));
      for (let i = 0; i < pt.rows; i++) {
        const o = pt.ord[i]!;
        const m = pt.mask[i]!;
        if (!this.isPresent(o)) {
          if ((m & PATCH_LABELS) !== 0) {
            let p = this.pending.get(o);
            if (!p) {
              p = new Map();
              this.pending.set(o, p);
            }
            pt.labels.forEach((l, li) => p!.set(pcols[li]!.key, { type: l.type, pack: l.pack, packVersion: l.packVersion, field: l.field, values: IndexStore.partLabelStrings(l, i), byUser: l.byUser[i] === 1 }));
          }
          continue;
        }
        if ((m & PATCH_FLAGS) !== 0) sc.flags[o] = pt.flags[i]!;
        if ((m & PATCH_SIZE) !== 0) {
          sc.chars[o] = pt.chars[i]!;
          sc.words[o] = pt.words[i]!;
        }
        if ((m & PATCH_TITLE) !== 0) this.titles.setBytes(o, pt.titles.bytesAt(i));
        if ((m & PATCH_REL) !== 0) this.setRel(o, pt.rel, i);
        if ((m & PATCH_LABELS) !== 0) pt.labels.forEach((l, li) => this.setLabel(pcols[li]!, o, IndexStore.partLabelStrings(l, i), l.byUser[i] === 1));
        this.refreshLabelFlag(o);
        patched++;
      }
    }
    this.ids.maybeCompact(this.n);
    this.titles.maybeCompact(this.n);
    return { appeared, from: appeared > 0 ? from : this.n, patched };
  }

  private setRel(o: number, rel: IndexRelations, r: number): void {
    const slice = (c: Csr): Uint32Array => c.targets.subarray(c.offsets[r]!, c.offsets[r + 1]!);
    this.rels.src.set(o, slice(rel.noteSources), this.n);
    this.rels.hub.set(o, slice(rel.hubMembers), this.n);
    this.rels.lnk.set(o, slice(rel.noteLinks), this.n);
  }

  /** Copy every present row of any DataIndex (generic, slower than applyPart). */
  applyIndex(index: DataIndex): ApplyResult {
    if (this.epoch === "" && this.n === 0) this.epoch = index.header.epoch;
    else if (index.header.epoch !== this.epoch) throw new CortexError("E_BAD_REQUEST", `E_EPOCH: index epoch ${index.header.epoch} does not match ${this.epoch}`);
    if (index.header.part !== "vault") this.seq = Math.max(this.seq, index.header.seq);
    if (index.header.builtAt > this.builtAt) this.builtAt = index.header.builtAt;
    this.snap = null;
    const convMap = new Uint32Array(index.convs.size);
    for (let i = 0; i < index.convs.size; i++) {
      const row = { ...index.convs.get(i) };
      const at = this.convIndex.get(row.id);
      if (at === undefined) {
        convMap[i] = this.convRows.length;
        this.convIndex.set(row.id, this.convRows.length);
        this.convRows.push(row);
      } else {
        convMap[i] = at;
        this.convRows[at] = row;
      }
    }
    if (index.count > this.n) this.setCount(index.count);
    const cols = index.labels.map((l) => this.labelColumn(l.pack, l.packVersion, l.field, l.type));
    const ic = index.cols;
    const sc = this.c;
    let appeared = 0;
    let from = Number.POSITIVE_INFINITY;
    for (let o = 0; o < index.count; o++) {
      if (ic.kind[o] === NONE8) continue;
      const was = sc.kind[o] !== NONE8;
      for (const name of STRUCTURAL_COLUMNS) {
        if (name === "folder" || name === "project" || name === "conv") continue;
        (sc as Record<ColumnName, NumArray>)[name][o] = (ic as Record<ColumnName, NumArray>)[name][o]!;
      }
      sc.chars[o] = ic.chars[o]!;
      sc.words[o] = ic.words[o]!;
      sc.flags[o] = ic.flags[o]!;
      const f = ic.folder[o]!;
      sc.folder[o] = f === NONE32 ? NONE32 : this.folders.id(index.dicts.folders.get(f));
      const p = ic.project[o]!;
      sc.project[o] = p === NONE32 ? NONE32 : this.projects.id(index.dicts.projects.get(p));
      const cv = ic.conv[o]!;
      sc.conv[o] = cv === NONE32 ? NONE32 : (convMap[cv] ?? NONE32);
      this.ids.setString(o, index.ids.get(o));
      this.titles.setString(o, index.titles.get(o));
      this.setRel(o, index.rel, o);
      index.labels.forEach((l, li) => this.setLabel(cols[li]!, o, IndexStore.partLabelStrings(l, o), l.byUser[o] === 1));
      this.refreshLabelFlag(o);
      if (!was) {
        appeared++;
        if (o < from) from = o;
        this.hashInsert(o);
      }
    }
    return { appeared, from: appeared > 0 ? from : this.n, patched: 0 };
  }

  /** Replace the flags of present rows (patchIndex); HasLabels stays as the labels say. */
  applyFlags(ordinals: ArrayLike<number>, flags: ArrayLike<number>): number {
    let n = 0;
    const len = Math.min(ordinals.length, flags.length);
    for (let i = 0; i < len; i++) {
      const o = ordinals[i]!;
      if (!this.isPresent(o)) continue;
      const keep = this.c.flags[o]! & ItemFlag.HasLabels;
      this.c.flags[o] = ((flags[i]! & ~ItemFlag.HasLabels) | keep) >>> 0;
      n++;
    }
    if (n > 0) this.snap = null;
    return n;
  }

  // ── reading ──

  private stats(): IndexStats {
    return computePartStats(this.c, this.n, this.convRows.length);
  }

  /** The current state as a DataIndex (cached until the next change). */
  snapshot(): DataIndex {
    if (this.snap) return this.snap;
    const n = this.n;
    const cols = {} as MutableCols;
    for (const name of COLUMN_NAMES) (cols as Record<ColumnName, NumArray>)[name] = (this.c as Record<ColumnName, NumArray>)[name].subarray(0, n);
    const ids = this.ids;
    const titles = this.titles;
    const convs = this.convRows.slice();
    const convIndex = this.convIndex;
    const rels = this.rels;
    let rel: IndexRelations | null = null;
    const labels: LabelColumn[] = this.labelCols.map((l) => {
      const values = l.dict.values.slice();
      if (l.type === "multi") {
        let multi: Csr | null = null;
        const arena = l.multi!;
        return {
          pack: l.pack,
          packVersion: l.packVersion,
          field: l.field,
          type: l.type,
          values,
          get multi(): Csr {
            multi ??= arena.toCsr(n);
            return multi;
          },
          byUser: l.byUser.subarray(0, n),
        };
      }
      return { pack: l.pack, packVersion: l.packVersion, field: l.field, type: l.type, values, single: l.single!.subarray(0, n), byUser: l.byUser.subarray(0, n) };
    });
    const header: IndexHeader = {
      magic: INDEX_MAGIC,
      version: INDEX_VERSION,
      part: this.part,
      builtAt: this.builtAt,
      seq: this.seq,
      epoch: this.epoch,
      baseCount: n,
      count: n,
      blobs: [],
      conversations: convs.length,
      labels: labels.map((l) => ({ pack: l.pack, packVersion: l.packVersion, field: l.field, type: l.type, values: l.values })),
      stats: this.stats(),
    };
    const store = this;
    const snap: DataIndex = {
      header,
      count: n,
      cols,
      ids: { size: n, get: (i: number) => (i >= 0 && i < n ? ids.get(i) : "") },
      titles: { size: n, get: (i: number) => (i >= 0 && i < n ? titles.get(i) : "") },
      dicts: { folders: new ListTable(this.folders.values.slice()), projects: new ListTable(this.projects.values.slice()) },
      convs: {
        size: convs.length,
        get: (row: number) => convs[row] ?? NO_CONVERSATION,
        rowOf: (id: string) => {
          const r = convIndex.get(id);
          return r !== undefined && r < convs.length ? r : -1;
        },
      },
      get rel(): IndexRelations {
        rel ??= { noteSources: rels.src.toCsr(n), hubMembers: rels.hub.toCsr(n), noteLinks: rels.lnk.toCsr(n) };
        return rel;
      },
      labels,
      ordinalOf: (id: string) => {
        const o = store.ordinalOf(id);
        return o >= 0 && o < n ? o : -1;
      },
    };
    this.snap = snap;
    return snap;
  }

  /** Relation targets of one row (a view; copy before keeping it). */
  relOf(kind: "noteSources" | "hubMembers" | "noteLinks", o: number): Uint32Array {
    if (o < 0 || o >= this.n) return EMPTY_U32;
    const a = kind === "noteSources" ? this.rels.src : kind === "hubMembers" ? this.rels.hub : this.rels.lnk;
    return a.get(o);
  }

  // ── encoding rows back out (plugin → worker deltas) ──

  /**
   * Encode rows and patch rows of this store as a part (dictionaries, the conversation table and every label
   * column are written whole, so the receiving store maps them by value).
   */
  encodeRows(opts: { rows: ArrayLike<number>; patches?: readonly { ordinal: number; mask: number }[]; part?: IndexHeader["part"] }): ArrayBuffer {
    const rows = Array.from(opts.rows).filter((o) => this.isPresent(o));
    const patches = (opts.patches ?? []).filter((p) => this.isPresent(p.ordinal));
    const n = rows.length;
    const w = new CxiWriter();
    w.add("ord", "u32", Uint32Array.from(rows));
    const sub = {} as MutableCols;
    for (const name of COLUMN_NAMES) {
      const src = (this.c as Record<ColumnName, NumArray>)[name];
      const out = alloc(COLUMN_TYPES[name], n);
      for (let r = 0; r < n; r++) out[r] = src[rows[r]!]!;
      (sub as Record<ColumnName, NumArray>)[name] = out;
      w.add(`c.${name}`, COLUMN_TYPES[name], out);
    }
    const ids = new StringsWriter();
    const titles = new StringsWriter();
    for (const o of rows) {
      ids.addBytes(this.ids.bytes(o));
      titles.addBytes(this.titles.bytes(o));
    }
    w.strings("ids", ids.finish());
    w.strings("titles", titles.finish());
    const fw = new StringsWriter();
    for (const f of this.folders.values) fw.add(f);
    w.strings("dict.folders", fw.finish());
    const pw = new StringsWriter();
    for (const p of this.projects.values) pw.add(p);
    w.strings("dict.projects", pw.finish());
    writeConversations(w, this.convRows);
    const relCsr = (arena: SliceArena, list: readonly number[]): Csr => csrFromLists(list.map((o) => arena.get(o)));
    w.csr("r.src", relCsr(this.rels.src, rows));
    w.csr("r.hub", relCsr(this.rels.hub, rows));
    w.csr("r.lnk", relCsr(this.rels.lnk, rows));
    const labelBlobs = (list: readonly number[]) =>
      this.labelCols.map((l) => {
        const byUser = new Uint8Array(list.length);
        list.forEach((o, r) => (byUser[r] = l.byUser[o]!));
        if (l.type === "multi") return { type: l.type, multi: csrFromLists(list.map((o) => l.multi!.get(o))), byUser };
        const single = new Uint16Array(list.length);
        list.forEach((o, r) => (single[r] = l.single![o]!));
        return { type: l.type, single, byUser };
      });
    writeLabelBlobs(w, "l", labelBlobs(rows));
    if (patches.length > 0) {
      const po = patches.map((p) => p.ordinal);
      w.add("p.ord", "u32", Uint32Array.from(po));
      w.add("p.mask", "u8", Uint8Array.from(patches.map((p) => p.mask & PATCH_ALL)));
      w.add("p.flags", "u32", Uint32Array.from(po.map((o) => this.c.flags[o]!)));
      w.add("p.chars", "u32", Uint32Array.from(po.map((o) => this.c.chars[o]!)));
      w.add("p.words", "u32", Uint32Array.from(po.map((o) => this.c.words[o]!)));
      const pt = new StringsWriter();
      for (const o of po) pt.addBytes(this.titles.bytes(o));
      w.strings("p.titles", pt.finish());
      w.csr("p.r.src", relCsr(this.rels.src, po));
      w.csr("p.r.hub", relCsr(this.rels.hub, po));
      w.csr("p.r.lnk", relCsr(this.rels.lnk, po));
      writeLabelBlobs(w, "p.l", labelBlobs(po));
    }
    return w.finish({
      magic: INDEX_MAGIC,
      version: INDEX_VERSION,
      part: opts.part ?? "merged",
      builtAt: this.builtAt || new Date().toISOString(),
      seq: this.seq,
      epoch: this.epoch,
      baseCount: this.n,
      count: this.n,
      conversations: this.convRows.length,
      labels: this.labelCols.map((l) => ({ pack: l.pack, packVersion: l.packVersion, field: l.field, type: l.type, values: l.dict.values.slice() })),
      stats: computePartStats(sub, n, this.convRows.length),
      x: { rows: n, patches: patches.length },
    });
  }

  // ── comparing (plugin side) ──

  /**
   * Compare this store (what the worker holds) with `next` (what it should hold): rows that appeared, patch rows
   * for patchable changes, or `structural` when only a reload can bring the worker in line.
   */
  diff(next: IndexStore): StoreDiff {
    const out: StoreDiff = { structural: false, appeared: [], patches: [], from: next.count, tables: false };
    const fail = (reason: string): StoreDiff => ({ ...out, structural: true, reason });
    if (next.epoch !== this.epoch) return fail("epoch");
    if (next.count < this.n) return fail("count shrank");
    const tr = (from: Dict, to: Dict): Int32Array => {
      const m = new Int32Array(from.size);
      for (let i = 0; i < from.size; i++) m[i] = to.find(from.values[i]!);
      return m;
    };
    const fmap = tr(this.folders, next.folders);
    const pmap = tr(this.projects, next.projects);
    const cmap = new Int32Array(this.convRows.length);
    this.convRows.forEach((c, i) => (cmap[i] = next.convIndex.get(c.id) ?? -1));
    // Label columns: matched by key; a column that disappears is structural.
    const lmaps: { a: StoreLabel; b: StoreLabel | null; vmap: Int32Array }[] = [];
    for (const a of this.labelCols) {
      const bi = next.labelKey.get(a.key);
      const b = bi === undefined ? null : next.labelCols[bi]!;
      if (!b || b.type !== a.type) {
        for (let o = 0; o < this.n; o++) if (a.single ? a.single[o] !== NONE16 : a.multi!.len[o]! > 0) return fail("label column removed");
        continue;
      }
      lmaps.push({ a, b, vmap: tr(a.dict, b.dict) });
    }
    const extra = next.labelCols.filter((b) => !this.labelKey.has(b.key));
    const sameNum = (x: number, y: number): boolean => x === y || (Number.isNaN(x) && Number.isNaN(y));
    const a = this.c;
    const b = next.c;
    for (let o = 0; o < this.n; o++) {
      const ap = a.kind[o] !== NONE8;
      const bp = b.kind[o] !== NONE8;
      if (!ap && !bp) continue;
      if (ap && !bp) return fail("row vanished");
      if (!ap && bp) {
        out.appeared.push(o);
        continue;
      }
      if (
        a.kind[o] !== b.kind[o] ||
        a.pop[o] !== b.pop[o] ||
        a.source[o] !== b.source[o] ||
        a.speaker[o] !== b.speaker[o] ||
        a.space[o] !== b.space[o] ||
        a.idx[o] !== b.idx[o] ||
        !sameNum(a.t[o]!, b.t[o]!) ||
        !sameNum(a.tAdded[o]!, b.tAdded[o]!) ||
        a.layer[o] !== b.layer[o] ||
        a.parent[o] !== b.parent[o] ||
        a.noteKind[o] !== b.noteKind[o] ||
        a.hubType[o] !== b.hubType[o] ||
        a.hubStatus[o] !== b.hubStatus[o]
      ) {
        return fail(`row ${o} moved`);
      }
      const af = a.folder[o]!;
      if ((af === NONE32 ? NONE32 : fmap[af]) !== b.folder[o]) return fail(`row ${o} refiled`);
      const apr = a.project[o]!;
      if ((apr === NONE32 ? NONE32 : pmap[apr]) !== b.project[o]) return fail(`row ${o} project`);
      const ac = a.conv[o]!;
      if ((ac === NONE32 ? NONE32 : cmap[ac]) !== b.conv[o]) return fail(`row ${o} conversation`);
      let mask = 0;
      if (a.flags[o] !== b.flags[o]) mask |= PATCH_FLAGS;
      if (a.chars[o] !== b.chars[o] || a.words[o] !== b.words[o]) mask |= PATCH_SIZE;
      if (!bytesEqual(this.titles.bytes(o), next.titles.bytes(o))) mask |= PATCH_TITLE;
      if (!sameU32(this.rels.src.get(o), next.rels.src.get(o)) || !sameU32(this.rels.hub.get(o), next.rels.hub.get(o)) || !sameU32(this.rels.lnk.get(o), next.rels.lnk.get(o))) mask |= PATCH_REL;
      for (const m of lmaps) {
        if (m.a.byUser[o] !== m.b!.byUser[o]) {
          mask |= PATCH_LABELS;
          break;
        }
        if (m.a.single) {
          const v = m.a.single[o]!;
          if ((v === NONE16 ? NONE16 : m.vmap[v]) !== m.b!.single![o]) {
            mask |= PATCH_LABELS;
            break;
          }
        } else {
          const va = m.a.multi!.get(o);
          const vb = m.b!.multi!.get(o);
          if (va.length !== vb.length || va.some((v, k) => m.vmap[v] !== vb[k])) {
            mask |= PATCH_LABELS;
            break;
          }
        }
      }
      if ((mask & PATCH_LABELS) === 0) {
        for (const e of extra) {
          if (e.single ? e.single[o] !== NONE16 : e.multi!.len[o]! > 0) {
            mask |= PATCH_LABELS;
            break;
          }
        }
      }
      if (mask !== 0) out.patches.push({ ordinal: o, mask });
    }
    for (let o = this.n; o < next.count; o++) if (b.kind[o] !== NONE8) out.appeared.push(o);
    if (out.appeared.length > 0) out.from = out.appeared[0]!;
    out.tables = !sameConversations(this.convRows, next.convRows);
    return out;
  }

  /** Values of a label column for a row, as strings (tests and the plugin's overlay). */
  labelsOf(o: number): { pack: string; field: string; values: string[]; byUser: boolean }[] {
    if (!this.isPresent(o)) return [];
    return this.labelCols
      .map((l) => ({ pack: l.pack, field: l.field, values: this.labelValues(l, o), byUser: l.byUser[o] === 1 }))
      .filter((l) => l.values.length > 0);
  }
}

export interface StoreDiff {
  structural: boolean;
  reason?: string;
  /** Ordinals present in `next` but not before (ascending). */
  appeared: number[];
  /** Present rows with patchable changes. */
  patches: { ordinal: number; mask: number }[];
  /** Smallest appeared ordinal (`next.count` when none): the placement's incremental `fromCount`. */
  from: number;
  /** The conversation table changed. */
  tables: boolean;
}

function sameU32(a: Uint32Array, b: Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameConversations(a: readonly ConversationRow[], b: readonly ConversationRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.title !== y.title || x.entryCount !== y.entryCount || x.gist !== y.gist || x.space !== y.space || x.source !== y.source) return false;
    if (!(x.startedAt === y.startedAt || (Number.isNaN(x.startedAt) && Number.isNaN(y.startedAt)))) return false;
    if (!(x.endedAt === y.endedAt || (Number.isNaN(x.endedAt) && Number.isNaN(y.endedAt)))) return false;
  }
  return true;
}

// ───────────────────────────── DataIndex conveniences ─────────────────────────────

/** Decode one file into a DataIndex whose row i is ordinal i (rows no part provides are absent). */
export function decodeIndex(buffer: ArrayBuffer): DataIndex {
  return IndexStore.fromParts([decodePart(buffer)], { part: readIndexHeader(buffer).part }).snapshot();
}

/**
 * Combine the runner-built record index and the plugin-built vault index into one DataIndex. Both use the shared
 * ordinal allocator, so rows are overlaid at their ordinals; vault rows win where both claim one (they never
 * should). Label tables keyed by item are resolved across both. Throws E_BAD_REQUEST when the epochs differ.
 */
export function mergeIndexes(record: DataIndex, vault: DataIndex | null): DataIndex {
  const s = new IndexStore({ part: "merged", epoch: record.header.epoch });
  s.applyIndex(record);
  if (vault) s.applyIndex(vault);
  return s.snapshot();
}

/** An index with zero items (first run, before any import). */
export function emptyIndex(part: IndexHeader["part"] = "merged"): DataIndex {
  return new IndexStore({ part }).snapshot();
}

/** Item kind of a record entry kind (EntryRecord.kind). */
export function recordItemKind(kind: "message" | "document" | "passage" | "file"): ItemKindValue {
  switch (kind) {
    case "message":
      return ItemKind.RecordMessage;
    case "document":
      return ItemKind.RecordDocument;
    case "passage":
      return ItemKind.RecordPassage;
    case "file":
      return ItemKind.RecordFile;
  }
}

/** Item kind of a machine note kind (NoteRecord.kind). Vault notes are built as NoteWiki by the vault source. */
export function noteItemKind(kind: NoteKind): ItemKindValue {
  if (kind === "gist") return ItemKind.NoteGist;
  if (kind === "hub") return ItemKind.NoteHub;
  return ItemKind.NoteAtomic;
}

// ───────────────────────────── the sample record (M13, P2) ─────────────────────────────

/** Ordinal epoch of the sample record (search shards of the real record never apply to it). */
export const SAMPLE_EPOCH = "sample";
export const SAMPLE_COUNTS = { entries: 30_000, notes: 3_500, years: 3 } as const;

const SAMPLE_VERBS = ["Planning", "Fixing", "Sorting", "Choosing", "Measuring", "Drafting", "Checking", "Reworking", "Pricing", "Comparing", "Scheduling", "Tidying"];
const SAMPLE_NOTE_FRAMES: Readonly<Record<"decision" | "question" | "idea" | "plan" | "abandoned" | "concept", readonly string[]>> = {
  decision: ["Keep the {n} simple", "Go with the second {n}", "Do the {n} first"],
  question: ["Which {n} lasts longer?", "Is the {n} worth it?", "When should the {n} start?"],
  idea: ["Pair the {n} with the {m}", "A smaller {n} for the corner", "Reuse the {n} next season"],
  plan: ["{N} this weekend", "Order parts for the {n}", "Book time for the {n}"],
  abandoned: ["Dropped the second {n}", "No more {n} this year", "Parked the {n} for now"],
  concept: ["How the {n} works", "What makes a good {n}", "The {n} in short"],
};
const SAMPLE_NOTE_KINDS = Object.keys(SAMPLE_NOTE_FRAMES) as (keyof typeof SAMPLE_NOTE_FRAMES)[];
const SAMPLE_ROLES = ["capture", "plan", "reference", "idea", "draft", "map", "log", "reflection", "howto", "knowledge", "decision"];
const SAMPLE_WORK = ["debug", "build", "research", "write", "set up", "plan"];
const SAMPLE_OUTCOME = ["shipped", "partly done", "abandoned", "blocked", "still open"];
const SAMPLE_SOURCES: readonly (readonly [SourceKind, number])[] = [
  ["claude-code", 0.5],
  ["claude-ai", 0.2],
  ["chatgpt", 0.21],
  ["gemini", 0.09],
];
/** Relative activity per hour of the day (mornings and evenings). */
const SAMPLE_HOURS = [0, 0, 0, 0, 0, 0, 1, 2, 4, 5, 4, 3, 3, 3, 3, 3, 3, 4, 5, 6, 7, 6, 4, 2];

type LabelMap<V> = Map<string, { value: V; byUser: boolean }>;

/**
 * The codec input of the sample record: about 30,000 entries and 3,500 notes over three years in six invented
 * areas, deterministic for (seed, day of `now`). Nothing in it comes from anyone's record. Built by the worker
 * (`loadSample`) and by the plugin for its own copy (tooltips, readers), which therefore always agree.
 */
export function sampleIndexInput(seed: number, now: number): IndexBuildInput {
  const rand = mulberry32(Math.imul(seed >>> 0, 2654435761) + 97);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  const end = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  const start = end - SAMPLE_COUNTS.years * 365 * DAY_MS;
  let counter = 0;
  const newId = (prefix: string): string => {
    const b = new Uint8Array(10);
    let c = ++counter;
    for (let i = 4; i >= 0; i--) {
      b[i] = c % 256;
      c = Math.floor(c / 256);
    }
    for (let i = 5; i < 10; i++) b[i] = Math.floor(rand() * 256);
    return `${prefix}_${base32(b).slice(0, 16)}`;
  };
  const totalWeight = SAMPLE_AREAS.reduce((n, a) => n + a.weight, 0);
  const pickArea = (): (typeof SAMPLE_AREAS)[number] => {
    let r = rand() * totalWeight;
    for (const a of SAMPLE_AREAS) {
      r -= a.weight;
      if (r <= 0) return a;
    }
    return SAMPLE_AREAS[SAMPLE_AREAS.length - 1]!;
  };
  const pickSource = (): SourceKind => {
    let r = rand();
    for (const [s, w] of SAMPLE_SOURCES) {
      r -= w;
      if (r <= 0) return s;
    }
    return "claude-code";
  };
  const bursts = Array.from({ length: 48 }, () => start + rand() * (end - start));
  const hourTotal = SAMPLE_HOURS.reduce((a, b) => a + b, 0);
  const pickTime = (): number => {
    let t = rand() < 0.7 ? pick(bursts) + gaussian(rand) * 9 * DAY_MS : start + rand() * (end - start);
    t = Math.min(end - DAY_MS, Math.max(start, t));
    const day = Math.floor(t / DAY_MS) * DAY_MS;
    let r = rand() * hourTotal;
    let hour = 0;
    for (; hour < 23; hour++) {
      r -= SAMPLE_HOURS[hour]!;
      if (r <= 0) break;
    }
    return day + hour * 3_600_000 + Math.floor(rand() * 3_600_000);
  };

  const items: IndexItemInput[] = [];
  const conversations: ConversationRow[] = [];
  const noteSources = new Map<string, string[]>();
  const hubMembers = new Map<string, string[]>();
  const noteLinks = new Map<string, string[]>();
  const work: LabelMap<string> = new Map();
  const outcome: LabelMap<string> = new Map();
  const projectLabel: LabelMap<string> = new Map();
  const topics: LabelMap<string[]> = new Map();
  const roles: LabelMap<string> = new Map();
  const gistOf = new Map<string, string>();
  const notesByProject = new Map<string, string[]>();
  const notesByTopic = new Map<string, string[]>();
  const timeOf = new Map<string, number>();
  let notes = 0;
  let entries = 0;
  const noteBudget = SAMPLE_COUNTS.notes - 400;
  const entryTarget = SAMPLE_COUNTS.entries - 1_500;

  while (entries < entryTarget) {
    const area = pickArea();
    const project = pick(area.projects);
    const noun = pick(area.nouns);
    const source = pickSource();
    const len = Math.min(320, Math.max(2, Math.round(Math.exp(gaussian(rand) * 0.9 + 2.3))), entryTarget - entries + 1);
    const convId = newId("c");
    const t0 = pickTime();
    const folder = `${area.name}/${project}`;
    const ids: string[] = [];
    let t = t0;
    for (let i = 0; i < len; i++) {
      const speaker: Speaker = i % 2 === 0 ? "you" : "assistant";
      const words = speaker === "you" ? 8 + Math.floor(rand() * 60) : 40 + Math.floor(rand() * 400);
      const subagent = source === "claude-code" && speaker === "assistant" && len > 12 && rand() < 0.08;
      const id = newId("e");
      ids.push(id);
      items.push({
        id,
        kind: ItemKind.RecordMessage,
        pop: Population.Record,
        source,
        speaker,
        space: area.space,
        folderPath: folder,
        conv: convId,
        idx: i,
        t,
        tAdded: t + 60_000,
        chars: Math.round(words * 5.6),
        words,
        flags: subagent ? ItemFlag.Subagent | ItemFlag.HiddenByDefault : 0,
        project,
        title: i === 0 ? `${cap(noun)}: where to start` : "",
      });
      t += 30_000 + Math.floor(rand() * 300_000);
    }
    entries += len;
    const title = `${pick(SAMPLE_VERBS)} the ${noun}`;
    conversations.push({ id: convId, title, source, startedAt: t0, endedAt: t, entryCount: len, space: area.space, gist: NONE32 });
    const convTopics = [...new Set([noun, pick(area.nouns)])];
    const w = { value: pick(SAMPLE_WORK), byUser: false };
    const oc = { value: pick(SAMPLE_OUTCOME), byUser: rand() < 0.03 };
    const pl = { value: project, byUser: false };
    const tp = { value: convTopics, byUser: false };
    // Messages inherit their conversation's labels.
    for (const id of [convId, ...ids]) {
      work.set(id, w);
      outcome.set(id, oc);
      projectLabel.set(id, pl);
      topics.set(id, tp);
    }
    if (len < 6 || notes >= noteBudget) continue;
    const gist = newId("n");
    gistOf.set(convId, gist);
    timeOf.set(gist, t0);
    items.push({
      id: gist,
      kind: ItemKind.NoteGist,
      pop: Population.Note,
      source,
      speaker: "assistant",
      space: area.space,
      folderPath: folder,
      conv: convId,
      t: t0,
      tAdded: t + 1_800_000,
      chars: 600,
      words: 100,
      flags: ItemFlag.MachineWritten,
      project,
      title,
      noteKind: "gist",
    });
    notes++;
    noteSources.set(gist, Array.from({ length: Math.min(len, 3 + Math.floor(rand() * 4)) }, () => pick(ids)));
    roles.set(gist, { value: "log", byUser: false });
    work.set(gist, w);
    outcome.set(gist, oc);
    topics.set(gist, tp);
    const projNotes = notesByProject.get(project) ?? [];
    notesByProject.set(project, projNotes);
    projNotes.push(gist);
    const atomic = Math.floor(rand() * 3) + (len > 30 ? 2 : 0);
    const usedTitles = new Set<string>();
    for (let k = 0; k < atomic && notes < noteBudget; k++) {
      const kind = pick(SAMPLE_NOTE_KINDS);
      const frame = pick(SAMPLE_NOTE_FRAMES[kind]);
      const second = pick(area.nouns);
      const fill = (f: string): string => f.replace("{n}", noun).replace("{m}", second).replace("{N}", cap(noun));
      // Two notes of one conversation never share a title: take the kind's next unused frame (no extra random draws,
      // so the rest of the sample is unchanged), and number the rare fourth repeat.
      const frames = SAMPLE_NOTE_FRAMES[kind];
      let text = fill(frame);
      for (let f = 1; f < frames.length && usedTitles.has(text); f++) text = fill(frames[(frames.indexOf(frame) + f) % frames.length] as string);
      for (let n = 2; usedTitles.has(text); n++) text = `${fill(frame)} (${n})`;
      usedTitles.add(text);
      const nid = newId("n");
      const nt = t0 + Math.floor(rand() * Math.max(1, t - t0));
      timeOf.set(nid, nt);
      items.push({
        id: nid,
        kind: ItemKind.NoteAtomic,
        pop: Population.Note,
        source,
        speaker: "assistant",
        space: area.space,
        folderPath: folder,
        conv: convId,
        t: nt,
        tAdded: t + 1_800_000,
        chars: text.length,
        words: text.split(" ").length,
        flags: ItemFlag.MachineWritten,
        parent: gist,
        project,
        title: text,
        noteKind: kind,
      });
      notes++;
      noteSources.set(nid, Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(ids)));
      roles.set(nid, { value: kind === "decision" || kind === "plan" || kind === "idea" ? kind : pick(SAMPLE_ROLES), byUser: false });
      projNotes.push(nid);
      for (const topic of convTopics) {
        const list = notesByTopic.get(topic) ?? [];
        list.push(nid);
        notesByTopic.set(topic, list);
      }
    }
  }
  // Documents and passages (files and written entries), some without a date of their own.
  while (entries < SAMPLE_COUNTS.entries) {
    const area = pickArea();
    const project = pick(area.projects);
    const noun = pick(area.nouns);
    const dated = rand() < 0.7;
    const t = pickTime();
    const words = 120 + Math.floor(rand() * 900);
    const written = rand() < 0.4;
    items.push({
      id: newId("e"),
      kind: written ? ItemKind.RecordDocument : ItemKind.RecordPassage,
      pop: Population.Record,
      source: written ? "written" : "files",
      speaker: "you",
      space: area.space,
      folderPath: `${area.name}/${project}`,
      t: dated ? t : undefined,
      tAdded: t + DAY_MS,
      chars: Math.round(words * 5.6),
      words,
      flags: dated ? 0 : ItemFlag.Undated,
      project,
      title: `${cap(noun)} notes`,
    });
    entries++;
  }
  // Maps: a project map per project with notes, an area map per area, topic maps for the busiest topics.
  const hubs: { id: string; title: string; type: HubType; members: string[]; space: SpaceId; folder: string }[] = [];
  for (const area of SAMPLE_AREAS) {
    const projectMaps: string[] = [];
    for (const project of area.projects) {
      const members = notesByProject.get(project) ?? [];
      if (members.length === 0) continue;
      const id = newId("n");
      projectMaps.push(id);
      hubs.push({ id, title: project, type: "project", members: members.slice(0, 200), space: area.space, folder: `${area.name}/${project}` });
    }
    hubs.push({ id: newId("n"), title: area.name, type: "area", members: projectMaps, space: area.space, folder: area.name });
  }
  for (const [topic, members] of [...notesByTopic].sort((a, b) => b[1].length - a[1].length).slice(0, 30)) {
    const area = SAMPLE_AREAS.find((a) => a.nouns.includes(topic)) ?? SAMPLE_AREAS[0]!;
    hubs.push({ id: newId("n"), title: cap(topic), type: "topic", members: members.slice(0, 120), space: area.space, folder: area.name });
  }
  for (const h of hubs) {
    let last = Number.NEGATIVE_INFINITY;
    for (const m of h.members) last = Math.max(last, timeOf.get(m) ?? Number.NEGATIVE_INFINITY);
    if (!Number.isFinite(last)) last = end - DAY_MS;
    timeOf.set(h.id, last);
    const status: HubStatus = end - last < 30 * DAY_MS ? "active" : end - last < 120 * DAY_MS ? "quiet" : "paused";
    items.push({
      id: h.id,
      kind: ItemKind.NoteHub,
      pop: Population.Note,
      source: "obsidian",
      speaker: "assistant",
      space: h.space,
      folderPath: h.folder,
      t: last,
      tAdded: last + DAY_MS,
      chars: 900,
      words: 150,
      flags: ItemFlag.MachineWritten,
      title: h.title,
      noteKind: "hub",
      hubType: h.type,
      hubStatus: status,
    });
    hubMembers.set(h.id, h.members);
    roles.set(h.id, { value: "map", byUser: false });
    notes++;
  }
  // Vault-like notes in layers, linked within their area, fill the brain to the target count.
  const wikiByArea = new Map<string, string[]>();
  while (notes < SAMPLE_COUNTS.notes) {
    const area = pickArea();
    const noun = pick(area.nouns);
    const id = newId("w");
    const t = pickTime();
    const layer = Math.min(8, 2 + Math.floor(Math.abs(gaussian(rand)) * 2.2));
    items.push({
      id,
      kind: ItemKind.NoteWiki,
      pop: Population.Note,
      source: "obsidian",
      speaker: "you",
      space: area.space,
      folderPath: area.name,
      t,
      tAdded: t,
      chars: 2_000,
      words: 340,
      flags: 0,
      layer,
      title: `${cap(noun)} (${area.name.toLowerCase()})`,
      noteKind: layer <= 2 ? "hub" : "wiki",
    });
    const list = wikiByArea.get(area.name) ?? [];
    list.push(id);
    wikiByArea.set(area.name, list);
    roles.set(id, { value: pick(SAMPLE_ROLES), byUser: false });
    notes++;
  }
  for (const list of wikiByArea.values()) {
    for (const id of list) {
      for (let k = 2 + Math.floor(rand() * 3); k > 0; k--) {
        const other = pick(list);
        if (other === id) continue;
        const a = noteLinks.get(id) ?? [];
        a.push(other);
        noteLinks.set(id, a);
        const b = noteLinks.get(other) ?? [];
        b.push(id);
        noteLinks.set(other, b);
      }
    }
  }
  // Arrival order: ordinals follow tAdded (stable), as the allocator would have assigned them.
  const sorted = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => a.it.tAdded - b.it.tAdded || a.i - b.i)
    .map((x, ordinal) => ({ ...x.it, ordinal }));
  const ordinalById = new Map(sorted.map((it) => [it.id, it.ordinal]));
  return {
    part: "merged",
    seq: 0,
    epoch: SAMPLE_EPOCH,
    builtAt: new Date(end).toISOString(),
    items: sorted,
    conversations: conversations.map((c) => ({ ...c, gist: ordinalById.get(gistOf.get(c.id) ?? "") ?? NONE32 })),
    noteSources,
    hubMembers,
    noteLinks,
    labels: [
      { pack: "session", packVersion: "1.0.0", field: "work", type: "enum", values: SAMPLE_WORK, byTarget: work },
      { pack: "session", packVersion: "1.0.0", field: "outcome", type: "enum", values: SAMPLE_OUTCOME, byTarget: outcome },
      { pack: "session", packVersion: "1.0.0", field: "project", type: "text", byTarget: projectLabel },
      { pack: "session", packVersion: "1.0.0", field: "topics", type: "multi", byTarget: topics },
      { pack: "placement", packVersion: "1.0.0", field: "role", type: "enum", byTarget: roles },
    ],
  };
}

// ───────────────────────────── the ordinal allocator table (`ordinals.cxo`) ─────────────────────────────

export const ORDINAL_MAGIC = "CXO1";

/**
 * id → ordinal, allocated in arrival order and never reused inside an epoch (INDEX-DELTA-CONTRACT). The pure part
 * of `<cache>/ordinals.cxo`; the file handling (lock `cache:ordinals`, atomic write) is `store/indexBuilder.ts`.
 * File: "CXO1" | u32 header length | header JSON {epoch, count, createdAt} | ids, one per line, in ordinal order.
 */
export class OrdinalTable {
  readonly ids: string[] = [];
  private readonly map = new Map<string, number>();
  /** Ids added since the table was loaded or created (what a save must persist). */
  dirty = false;

  constructor(
    public epoch: string,
    public readonly createdAt: string = new Date().toISOString(),
  ) {}

  get size(): number {
    return this.ids.length;
  }

  /** -1 when the id has no ordinal. */
  get(id: string): number {
    return this.map.get(id) ?? -1;
  }

  /** The ordinal of `id`, allocating the next one when it is new. */
  allocate(id: string): number {
    const have = this.map.get(id);
    if (have !== undefined) return have;
    if (id.length === 0 || /[\r\n]/.test(id)) throw new CortexError("E_BAD_REQUEST", "an item id must be a non-empty single line");
    const o = this.ids.length;
    if (o >= NONE32 - 1) throw new CortexError("E_BAD_REQUEST", "the ordinal space is full");
    this.ids.push(id);
    this.map.set(id, o);
    this.dirty = true;
    return o;
  }

  encode(): Uint8Array {
    const enc = new TextEncoder();
    const header = enc.encode(JSON.stringify({ epoch: this.epoch, count: this.ids.length, createdAt: this.createdAt }));
    const body = enc.encode(this.ids.length > 0 ? `${this.ids.join("\n")}\n` : "");
    const out = new Uint8Array(8 + header.length + body.length);
    out.set(enc.encode(ORDINAL_MAGIC), 0);
    new DataView(out.buffer).setUint32(4, header.length, true);
    out.set(header, 8);
    out.set(body, 8 + header.length);
    return out;
  }

  /** Damaged or foreign bytes throw E_PARSE: the caller starts a new epoch (every ordinal then moves once). */
  static decode(bytes: Uint8Array): OrdinalTable {
    const bad = (why: string): CortexError => new CortexError("E_PARSE", `ordinal table: ${why}`);
    if (bytes.length < 8) throw bad("too short");
    const dec = new TextDecoder("utf-8", { fatal: true });
    if (dec.decode(bytes.subarray(0, 4)) !== ORDINAL_MAGIC) throw bad("not an ordinal table");
    const hl = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    if (8 + hl > bytes.length) throw bad("header runs past the end");
    let header: { epoch?: unknown; count?: unknown; createdAt?: unknown };
    try {
      header = JSON.parse(dec.decode(bytes.subarray(8, 8 + hl)));
    } catch {
      throw bad("unreadable header");
    }
    if (typeof header.epoch !== "string" || header.epoch.length === 0 || typeof header.count !== "number") throw bad("incomplete header");
    const t = new OrdinalTable(header.epoch, typeof header.createdAt === "string" ? header.createdAt : "");
    const text = bytes.length > 8 + hl ? dec.decode(bytes.subarray(8 + hl)) : "";
    if (text.length > 0) {
      for (const id of text.slice(0, -1).split("\n")) {
        if (t.map.has(id)) throw bad("duplicate id");
        t.map.set(id, t.ids.length);
        t.ids.push(id);
      }
    }
    if (t.ids.length !== header.count) throw bad("count does not match");
    t.dirty = false;
    return t;
  }
}

/** A fresh epoch name (the epoch changes on `index --full` or when the table is lost). */
export function newEpoch(now: number = Date.now(), rand: () => number = Math.random): string {
  const b = new Uint8Array(8);
  let t = Math.floor(now);
  for (let i = 4; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  for (let i = 5; i < 8; i++) b[i] = Math.floor(rand() * 256);
  return `ep_${base32(b).slice(0, 12)}`;
}
