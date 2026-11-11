/**
 * Export containers and the shared write path of the export importers. Owner: E4.
 *
 * 1. ZIP reader (`openZip`): random access with positioned reads — End Of Central Directory, ZIP64 locator and
 *    record, the central directory — then one entry at a time streamed through zlib.createInflateRaw() (method 8)
 *    or as stored (method 0), size- and CRC-32-checked. Never loads an archive into memory, never extracts to disk;
 *    entry names are data only and never become paths. Multi-GB / ZIP64 archives, prepended data (self-extracting
 *    stubs), UTF-8, Info-ZIP Unicode Path and CP437 names are handled; encrypted entries, split archives and
 *    methods other than 0/8 are refused with E_PARSE.
 * 2. Export sources (`openExportSource`): a zip, an extracted folder or a single JSON file behind one interface.
 * 3. Recognition (`locateExport`, `identifyExport`): which service an export came from and where its data lives,
 *    by structure first and by the first record's shape when the structure is ambiguous.
 * 4. The export pipeline (`runExportImport`, `ExportWriter`): the local adapter for E3's ConversationBatch
 *    (docs/rfcs/E4.md) — kept branch with versions, attachments, document entries, supersedes on edited
 *    re-exports, held secrets, orphan adoption, batched ledger appends, resume cursors and the manifest.
 *
 * Errors carry fixed text and codes, never export content (SAFE-17).
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { createInflateRaw } from "node:zlib";
import { errCode, withFsRetry, writeJsonAtomic } from "../node/fsAtomic";
import { sha256Text } from "../node/hash";
import { ByteLineSplitter, trimCr } from "../node/lineSplitter";
import { locksDirOf, withLock } from "../node/locks";
import { cacheWritablePath, resolveInVault } from "../node/paths";
import { CortexError, isCortexError } from "../shared/errors";
import { conversationId, entryId } from "../shared/ids";
import type { ExportImportStats, InspectResult, RunnerErrorCode, SourceImportStats, WarningCode } from "../shared/protocol/runner";
import { scanSecrets, SECRET_MARKER } from "../shared/secrets";
import type { CortexSettings } from "../shared/settings";
import { firstLineTitle, normalizeWhitespace } from "../shared/text";
import type {
  AttachmentRef,
  BranchVersion,
  ConversationId,
  ConversationPart,
  ConversationRecord,
  CorrectionRecord,
  DateEvidence,
  DateStrength,
  EntryId,
  EntryKind,
  EntryRecord,
  IsoDate,
  SegmentLine,
  SourceKind,
  SourceManifest,
  Speaker,
  TextRef,
  VaultPath,
} from "../shared/types";
import { ledgerMonthDir, segmentDir } from "../store/layout";
import { loadSourceManifest, updateSourceManifest } from "../store/manifest";
import { readSegment, writeSegment } from "../store/segments";
import { emptyStats, makeEntryRecord, toSegmentLine, type DiscoveredUnit, type ImportContext, type PendingMessage } from "./common";
import { isNeverRead } from "./folders";
import { JsonArrayScanner, streamJsonArray, streamJsonArrayElements, type SkippedElement } from "./jsonStream";

// ═════════════════════════════ 1. ZIP reader ═════════════════════════════

export interface ZipEntry {
  /** Entry name as stored ("/" separators, no leading "./" or "/"). Data only: never a filesystem path. */
  name: string;
  compressedSize: number;
  size: number;
  method: number;
  /** Offset of the local file header (already corrected for prepended data). */
  localHeaderOffset: number;
  crc32: number;
  isDirectory: boolean;
  encrypted: boolean;
}

export interface ZipArchive {
  readonly path: string;
  /** Archive size in bytes. */
  readonly size: number;
  readonly entries: readonly ZipEntry[];
  find(name: string): ZipEntry | undefined;
  /** Stream the uncompressed bytes of an entry (size and CRC-32 verified at the end). */
  open(entry: ZipEntry, opts?: { verifyCrc?: boolean }): Promise<Readable>;
  close(): Promise<void>;
}

export interface OpenZipOptions {
  /** Refuse archives listing more entries than this (default 1,000,000). */
  maxEntries?: number;
  /** Refuse a central directory larger than this (default 512 MB). */
  maxCentralDirectoryBytes?: number;
}

export const EOCD_SIGNATURE = 0x06054b50;
export const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
export const ZIP64_EOCD_SIGNATURE = 0x06064b50;
export const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
export const LOCAL_HEADER_SIGNATURE = 0x04034b50;

const EOCD_SIZE = 22;
const LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIZE = 56;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const MAX_COMMENT = 0xffff;

// CRC-32 (IEEE 802.3), slicing-by-8.
const CRC_TABLES: Uint32Array = (() => {
  const t = new Uint32Array(256 * 8);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n]!;
    for (let k = 1; k < 8; k++) {
      c = t[c & 0xff]! ^ (c >>> 8);
      t[k * 256 + n] = c >>> 0;
    }
  }
  return t;
})();

/** CRC-32 of `bytes`, continuing from `previous` (the CRC of the bytes before them). */
export function crc32(bytes: Uint8Array, previous = 0): number {
  const t = CRC_TABLES;
  let crc = ~previous >>> 0;
  let i = 0;
  const n = bytes.length;
  while (n - i >= 8) {
    const a = (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) ^ crc;
    const b = bytes[i + 4]! | (bytes[i + 5]! << 8) | (bytes[i + 6]! << 16) | (bytes[i + 7]! << 24);
    crc =
      t[1792 + (a & 0xff)]! ^
      t[1536 + ((a >>> 8) & 0xff)]! ^
      t[1280 + ((a >>> 16) & 0xff)]! ^
      t[1024 + (a >>> 24)]! ^
      t[768 + (b & 0xff)]! ^
      t[512 + ((b >>> 8) & 0xff)]! ^
      t[256 + ((b >>> 16) & 0xff)]! ^
      t[b >>> 24]!;
    i += 8;
  }
  while (i < n) crc = t[(crc ^ bytes[i++]!) & 0xff]! ^ (crc >>> 8);
  return ~crc >>> 0;
}

const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

function decodeCp437(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return s;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function decodeName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return Buffer.from(bytes).toString("utf8");
  // No flag: many writers still store UTF-8; a valid UTF-8 sequence is almost never meaningful CP437.
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return decodeCp437(bytes);
  }
}

/** Normalise an entry or member name for matching: "/" separators, no leading "./" or "/". */
export function normaliseMemberName(name: string): string {
  return name.replace(/\\/g, "/").replace(/^(?:\.\/|\/)+/, "");
}

function zipError(message: string): CortexError {
  return new CortexError("E_PARSE", message);
}

function u64(buf: Buffer, at: number): number {
  const v = buf.readBigUInt64LE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw zipError("the archive records an impossible size");
  return Number(v);
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let off = 0;
  while (off < length) {
    const { bytesRead } = await fh.read(buf, off, length - off, position + off);
    if (bytesRead === 0) throw zipError("the archive is truncated");
    off += bytesRead;
  }
  return buf;
}

interface CentralDirectory {
  entries: ZipEntry[];
}

async function readCentralDirectory(fh: FileHandle, size: number, opts: OpenZipOptions): Promise<CentralDirectory> {
  if (size < EOCD_SIZE) throw zipError("not a zip archive");
  const tailLen = Math.min(size, EOCD_SIZE + MAX_COMMENT + LOCATOR_SIZE);
  const tail = await readAt(fh, size - tailLen, tailLen);
  let eocd = -1;
  for (let p = tailLen - EOCD_SIZE; p >= 0; p--) {
    if (tail.readUInt32LE(p) !== EOCD_SIGNATURE) continue;
    if (p + EOCD_SIZE + tail.readUInt16LE(p + 20) === tailLen) {
      eocd = p;
      break;
    }
    if (eocd < 0) eocd = p; // closest to the end, in case the comment length is wrong
  }
  if (eocd < 0) throw zipError("not a zip archive");
  const eocdAbs = size - tailLen + eocd;
  const disk = tail.readUInt16LE(eocd + 4);
  const cdDisk = tail.readUInt16LE(eocd + 6);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  let recordAbs = -1;
  if (eocd >= LOCATOR_SIZE && tail.readUInt32LE(eocd - LOCATOR_SIZE) === ZIP64_EOCD_LOCATOR_SIGNATURE) {
    if (tail.readUInt32LE(eocd - LOCATOR_SIZE + 16) > 1) throw zipError("split archives are not supported");
    const stated = u64(tail, eocd - LOCATOR_SIZE + 8);
    const expected = eocdAbs - LOCATOR_SIZE - ZIP64_EOCD_SIZE;
    for (const at of stated === expected ? [stated] : [stated, expected]) {
      if (at < 0 || at + ZIP64_EOCD_SIZE > size) continue;
      const rec = await readAt(fh, at, ZIP64_EOCD_SIZE);
      if (rec.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) continue;
      if (rec.readUInt32LE(16) !== 0 || rec.readUInt32LE(20) !== 0) throw zipError("split archives are not supported");
      cdSize = u64(rec, 40);
      cdOffset = u64(rec, 48);
      recordAbs = at;
      break;
    }
    if (recordAbs < 0) throw zipError("the archive's ZIP64 record is missing");
  } else if ((disk !== 0 && disk !== 0xffff) || (cdDisk !== 0 && cdDisk !== 0xffff)) {
    throw zipError("split archives are not supported");
  }
  const maxCd = opts.maxCentralDirectoryBytes ?? 512 * 1024 * 1024;
  if (cdSize > maxCd) throw zipError("the archive's directory is too large");
  // Prepended data (a self-extracting stub) shifts every stored offset by the same amount.
  const cdEnd = recordAbs >= 0 ? recordAbs : eocdAbs;
  const shifted = cdEnd - (cdOffset + cdSize);
  if (shifted < 0) throw zipError("the archive's directory is damaged");
  let shift = 0;
  let cd: Buffer | undefined;
  for (const s of shifted > 0 ? [shifted, 0] : [0]) {
    if (cdOffset + s + cdSize > size) continue;
    const buf = await readAt(fh, cdOffset + s, cdSize);
    if (cdSize === 0 || buf.readUInt32LE(0) === CENTRAL_HEADER_SIGNATURE) {
      cd = buf;
      shift = s;
      break;
    }
  }
  if (!cd) throw zipError("the archive's directory is damaged");
  const maxEntries = opts.maxEntries ?? 1_000_000;
  const entries: ZipEntry[] = [];
  // Walk by size, not by the recorded count: some writers wrap the 16-bit count above 65,535 entries.
  for (let p = 0; p + CENTRAL_HEADER_SIZE <= cd.length; ) {
    if (cd.readUInt32LE(p) !== CENTRAL_HEADER_SIGNATURE) break; // e.g. a digital signature record follows
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let compressedSize = cd.readUInt32LE(p + 20);
    let uncompressed = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const externalAttrs = cd.readUInt32LE(p + 38);
    let localHeaderOffset = cd.readUInt32LE(p + 42);
    const end = p + CENTRAL_HEADER_SIZE + nameLen + extraLen + commentLen;
    if (end > cd.length) throw zipError("the archive's directory is damaged");
    const nameBytes = cd.subarray(p + CENTRAL_HEADER_SIZE, p + CENTRAL_HEADER_SIZE + nameLen);
    const extra = cd.subarray(p + CENTRAL_HEADER_SIZE + nameLen, p + CENTRAL_HEADER_SIZE + nameLen + extraLen);
    let unicodeName: string | undefined;
    for (let q = 0; q + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(q);
      const len = extra.readUInt16LE(q + 2);
      const body = extra.subarray(q + 4, Math.min(extra.length, q + 4 + len));
      if (id === 0x0001) {
        let r = 0;
        if (uncompressed === 0xffffffff && r + 8 <= body.length) {
          uncompressed = u64(body, r);
          r += 8;
        }
        if (compressedSize === 0xffffffff && r + 8 <= body.length) {
          compressedSize = u64(body, r);
          r += 8;
        }
        if (localHeaderOffset === 0xffffffff && r + 8 <= body.length) localHeaderOffset = u64(body, r);
      } else if (id === 0x7075 && body.length >= 5 && body[0] === 1 && body.readUInt32LE(1) === crc32(nameBytes)) {
        unicodeName = body.subarray(5).toString("utf8");
      }
      q += 4 + len;
    }
    const raw = unicodeName ?? decodeName(nameBytes, (flags & 0x800) !== 0);
    const isDirectory = /[\\/]$/.test(raw) || ((externalAttrs & 0x10) !== 0 && uncompressed === 0 && compressedSize === 0);
    entries.push({
      name: normaliseMemberName(raw),
      compressedSize,
      size: uncompressed,
      method,
      localHeaderOffset: localHeaderOffset + shift,
      crc32: crc,
      isDirectory,
      encrypted: (flags & 0x1) !== 0,
    });
    if (entries.length > maxEntries) throw zipError("the archive lists too many files");
    p = end;
  }
  return { entries };
}

/** Counts bytes and the CRC of an entry as it streams; fails at the end on any mismatch. */
class EntryCheck extends Transform {
  private crc = 0;
  private bytes = 0;

  constructor(
    private readonly entry: ZipEntry,
    private readonly verifyCrc: boolean,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.entry.size) {
      callback(zipError("an archive entry is larger than recorded"));
      return;
    }
    if (this.verifyCrc) this.crc = crc32(chunk, this.crc);
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    if (this.bytes !== this.entry.size) callback(zipError("an archive entry is shorter than recorded"));
    else if (this.verifyCrc && this.crc !== this.entry.crc32) callback(zipError("an archive entry is damaged (CRC mismatch)"));
    else callback();
  }
}

class ZipFile implements ZipArchive {
  private readonly byName = new Map<string, ZipEntry>();
  private closed = false;

  constructor(
    readonly path: string,
    private readonly fh: FileHandle,
    readonly size: number,
    readonly entries: readonly ZipEntry[],
  ) {
    for (const e of entries) if (!this.byName.has(e.name)) this.byName.set(e.name, e);
  }

  find(name: string): ZipEntry | undefined {
    return this.byName.get(normaliseMemberName(name));
  }

  async open(entry: ZipEntry, opts: { verifyCrc?: boolean } = {}): Promise<Readable> {
    if (this.closed) throw new CortexError("E_BAD_REQUEST", "the archive is closed");
    if (entry.isDirectory) throw new CortexError("E_BAD_REQUEST", "an archive folder has no content");
    if (entry.encrypted) throw zipError("the archive is encrypted");
    if (entry.method !== 0 && entry.method !== 8) throw zipError(`compression method ${entry.method} is not supported`);
    if (entry.localHeaderOffset + LOCAL_HEADER_SIZE > this.size) throw zipError("the archive is truncated");
    const head = await readAt(this.fh, entry.localHeaderOffset, LOCAL_HEADER_SIZE);
    if (head.readUInt32LE(0) !== LOCAL_HEADER_SIGNATURE) throw zipError("the archive's entry header is damaged");
    const dataStart = entry.localHeaderOffset + LOCAL_HEADER_SIZE + head.readUInt16LE(26) + head.readUInt16LE(28);
    if (dataStart + entry.compressedSize > this.size) throw zipError("the archive is truncated");
    if (entry.method === 0 && entry.compressedSize !== entry.size) throw zipError("the archive's entry header is damaged");
    const check = new EntryCheck(entry, opts.verifyCrc !== false);
    const raw: Readable =
      entry.compressedSize === 0
        ? Readable.from([])
        : createReadStream(this.path, { start: dataStart, end: dataStart + entry.compressedSize - 1, highWaterMark: 1 << 20 });
    const inflate = entry.method === 8 ? createInflateRaw() : undefined;
    const fail = (e: unknown): void => {
      if (!check.destroyed) check.destroy(isCortexError(e) ? e : zipError("an archive entry is damaged"));
    };
    raw.on("error", fail);
    inflate?.on("error", fail);
    check.on("close", () => {
      raw.destroy();
      inflate?.destroy();
    });
    if (inflate) raw.pipe(inflate).pipe(check);
    else raw.pipe(check);
    return check;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.fh.close();
  }
}

/** Open a zip archive for random access. Fails with E_PARSE when the file is not a usable zip. */
export async function openZip(absPath: string, opts: OpenZipOptions = {}): Promise<ZipArchive> {
  const fh = await fsp.open(absPath, "r");
  try {
    const size = (await fh.stat()).size;
    const { entries } = await readCentralDirectory(fh, size, opts);
    return new ZipFile(absPath, fh, size, entries);
  } catch (e) {
    await fh.close().catch(() => undefined);
    throw e;
  }
}

// ═════════════════════════════ 2. Export sources ═════════════════════════════

export type ExportForm = "zip" | "folder" | "file";

export interface ExportMember {
  /** "/"-separated name relative to the export root (data only). */
  name: string;
  size: number;
}

/** A dropped or chosen export: a zip, an extracted folder, or one JSON file. */
export interface ExportSource {
  readonly path: string;
  readonly form: ExportForm;
  readonly members: readonly ExportMember[];
  /** Absolute file of a member (folder and file forms); undefined inside a zip. */
  fileOf(name: string): string | undefined;
  open(name: string): Promise<Readable>;
  close(): Promise<void>;
}

export interface OpenExportOptions {
  /** Stop listing a folder after this many files (default 250,000). */
  maxMembers?: number;
  /** Folder depth limit (default 12). */
  maxDepth?: number;
}

function noMember(): CortexError {
  return new CortexError("E_BAD_REQUEST", "the export has no such file");
}

async function looksLikeZip(absPath: string): Promise<boolean> {
  if (/\.zip$/i.test(absPath)) return true;
  const fh = await fsp.open(absPath, "r");
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await fh.read(head, 0, 4, 0);
    return bytesRead === 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5 || head[2] === 7) && head[3] === head[2] + 1;
  } finally {
    await fh.close();
  }
}

async function zipSource(absPath: string): Promise<ExportSource> {
  const zip = await openZip(absPath);
  const members = zip.entries.filter((e) => !e.isDirectory).map((e) => ({ name: e.name, size: e.size }));
  return {
    path: absPath,
    form: "zip",
    members,
    fileOf: () => undefined,
    async open(name) {
      const entry = zip.find(name);
      if (!entry || entry.isDirectory) throw noMember();
      return zip.open(entry);
    },
    close: () => zip.close(),
  };
}

async function folderSource(root: string, opts: OpenExportOptions): Promise<ExportSource> {
  const maxMembers = opts.maxMembers ?? 250_000;
  const maxDepth = opts.maxDepth ?? 12;
  const members: ExportMember[] = [];
  const files = new Map<string, string>();
  const queue: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: "", depth: 0 }];
  walk: for (let qi = 0; qi < queue.length; qi++) {
    const dir = queue[qi] as { abs: string; rel: string; depth: number };
    let dirents;
    try {
      dirents = await fsp.readdir(dir.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue; // never follow links out of the chosen folder
      const abs = path.join(dir.abs, d.name);
      const rel = dir.rel ? `${dir.rel}/${d.name}` : d.name;
      if (isNeverRead(abs)) continue;
      if (d.isDirectory()) {
        if (dir.depth < maxDepth) queue.push({ abs, rel, depth: dir.depth + 1 });
      } else if (d.isFile()) {
        const st = await fsp.stat(abs).catch(() => null);
        if (!st) continue;
        members.push({ name: rel, size: st.size });
        files.set(rel, abs);
        if (members.length >= maxMembers) break walk;
      }
    }
  }
  return {
    path: root,
    form: "folder",
    members,
    fileOf: (name) => files.get(normaliseMemberName(name)),
    async open(name) {
      const abs = files.get(normaliseMemberName(name));
      if (!abs) throw noMember();
      return createReadStream(abs, { highWaterMark: 1 << 20 });
    },
    close: async () => undefined,
  };
}

function fileSource(absPath: string, size: number): ExportSource {
  const name = path.basename(absPath);
  return {
    path: absPath,
    form: "file",
    members: [{ name, size }],
    fileOf: (n) => (normaliseMemberName(n) === name ? absPath : undefined),
    async open(n) {
      if (normaliseMemberName(n) !== name) throw noMember();
      return createReadStream(absPath, { highWaterMark: 1 << 20 });
    },
    close: async () => undefined,
  };
}

/** Open an export given as a .zip, an extracted folder or a single JSON file. */
export async function openExportSource(absPath: string, opts: OpenExportOptions = {}): Promise<ExportSource> {
  const st = await fsp.stat(absPath);
  if (st.isDirectory()) return folderSource(absPath, opts);
  if (!st.isFile()) throw zipError("the export is neither a file nor a folder");
  if (await looksLikeZip(absPath)) return zipSource(absPath);
  return fileSource(absPath, st.size);
}

// ═════════════════════════════ 3. Recognition ═════════════════════════════

export type ExportKind = InspectResult["kind"];
export type ExportSourceKind = Exclude<ExportKind, "unknown">;

/** Where an export's data lives, from member names alone. */
export interface LocatedExport {
  /** Best guess from structure; "unknown" when only content can tell (see identifyExport). */
  kind: ExportKind;
  /** conversations.json (or numbered conversations-N.json) in reading order. */
  conversations: string[];
  /** Claude.ai projects.json next to conversations.json. */
  projects?: string;
  /** Gemini Apps activity as JSON / as HTML (Takeout). */
  geminiJson?: string;
  geminiHtml?: string;
  /** The archive is a Google Takeout. */
  takeout: boolean;
}

const CONVERSATIONS_FILE = /^conversations(?:[-_ ]?\d+)?\.json$/i;
const CHATGPT_MARKERS = new Set(["chat.html", "message_feedback.json", "shared_conversations.json", "user.json", "model_comparisons.json"]);
const CLAUDE_MARKERS = new Set(["users.json", "projects.json", "memories.json"]);
const GEMINI_FOLDER = /^(gemini apps|gemini|bard)$/i;
const naturalOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function splitName(name: string): { folder: string; base: string } {
  const i = name.lastIndexOf("/");
  return i < 0 ? { folder: "", base: name } : { folder: name.slice(0, i), base: name.slice(i + 1) };
}

/** Recognise an export from member names (pure). */
export function locateExport(memberNames: readonly string[]): LocatedExport {
  const names = memberNames.map(normaliseMemberName);
  const conversationsByFolder = new Map<string, string[]>();
  const basesByFolder = new Map<string, Map<string, string>>();
  let geminiJson: string | undefined;
  let geminiHtml: string | undefined;
  let takeout = false;
  for (const name of names) {
    const { folder, base } = splitName(name);
    let bases = basesByFolder.get(folder);
    if (!bases) basesByFolder.set(folder, (bases = new Map()));
    bases.set(base.toLowerCase(), name);
    if (CONVERSATIONS_FILE.test(base)) {
      const list = conversationsByFolder.get(folder) ?? [];
      list.push(name);
      conversationsByFolder.set(folder, list);
    }
    if (/(^|\/)takeout\//i.test(name) || base.toLowerCase() === "archive_browser.html") takeout = true;
    const parent = splitName(folder).base.replace(/[-_]+/g, " ");
    if (GEMINI_FOLDER.test(parent)) {
      const lower = base.toLowerCase();
      const better = (cur: string | undefined) => !cur || (/activ/i.test(base) && !/activ/i.test(splitName(cur).base));
      if (lower.endsWith(".json") && better(geminiJson)) geminiJson = name;
      if ((lower.endsWith(".html") || lower.endsWith(".htm")) && better(geminiHtml)) geminiHtml = name;
    }
  }
  const out: LocatedExport = { kind: "unknown", conversations: [], takeout };
  if (geminiJson) out.geminiJson = geminiJson;
  if (geminiHtml) out.geminiHtml = geminiHtml;
  const folders = [...conversationsByFolder.keys()].sort((a, b) => a.split("/").length - b.split("/").length || naturalOrder.compare(a, b));
  const folder = folders[0];
  if (folder !== undefined) {
    out.conversations = [...(conversationsByFolder.get(folder) ?? [])].sort(naturalOrder.compare);
    const bases = basesByFolder.get(folder) ?? new Map<string, string>();
    const projects = bases.get("projects.json");
    if (projects) out.projects = projects;
    if ([...CHATGPT_MARKERS].some((m) => bases.has(m))) out.kind = "chatgpt";
    else if ([...CLAUDE_MARKERS].some((m) => bases.has(m))) out.kind = "claude-ai";
  } else if (geminiJson || geminiHtml) {
    out.kind = "gemini";
  }
  return out;
}

function isRecordLike(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** The service a JSON member belongs to, from its first element; "empty" for an empty list. */
export async function sniffExportKind(src: ExportSource, member: string, signal?: AbortSignal): Promise<ExportKind | "empty"> {
  try {
    const opts = signal ? { signal, maxElementBytes: 512 * 1024 * 1024 } : { maxElementBytes: 512 * 1024 * 1024 };
    for await (const first of streamJsonArray<unknown>(await src.open(member), opts)) {
      if (!isRecordLike(first)) return "unknown";
      if (isRecordLike(first.mapping)) return "chatgpt";
      if (Array.isArray(first.chat_messages)) return "claude-ai";
      if (typeof first.title === "string" && typeof first.time === "string" && ("header" in first || "products" in first)) return "gemini";
      return "unknown";
    }
    return "empty";
  } catch (e) {
    if (isCortexError(e) && e.code === "E_CANCELLED") throw e;
    return "unknown";
  }
}

export interface IdentifiedExport {
  kind: ExportKind;
  loc: LocatedExport;
  /** Why the export cannot be imported as it is. */
  problem?: WarningCode;
}

/** Recognise an opened export: structure first, then the first record's shape when structure is ambiguous. */
export async function identifyExport(src: ExportSource, signal?: AbortSignal): Promise<IdentifiedExport> {
  const loc = locateExport(src.members.map((m) => m.name));
  if (loc.kind === "chatgpt" || loc.kind === "claude-ai") return { kind: loc.kind, loc };
  const first = loc.conversations[0];
  if (first !== undefined) {
    const sniffed = await sniffExportKind(src, first, signal);
    if (sniffed === "chatgpt" || sniffed === "claude-ai") return { kind: sniffed, loc: { ...loc, kind: sniffed } };
    if (sniffed === "empty" && !loc.geminiJson) return { kind: "unknown", loc, problem: "export-empty" };
  }
  if (loc.geminiJson) return { kind: "gemini", loc: { ...loc, kind: "gemini" } };
  if (loc.geminiHtml) return { kind: "gemini", loc: { ...loc, kind: "gemini" }, problem: "takeout-html" };
  if (loc.takeout) return { kind: "gemini", loc: { ...loc, kind: "gemini" }, problem: "export-empty" };
  // One JSON file dropped on its own: decide by content.
  const only = src.members.length === 1 ? src.members[0] : undefined;
  if (only && /\.json$/i.test(only.name) && first === undefined) {
    const sniffed = await sniffExportKind(src, only.name, signal);
    if (sniffed === "gemini") return { kind: "gemini", loc: { ...loc, kind: "gemini", geminiJson: only.name } };
    if (sniffed === "chatgpt" || sniffed === "claude-ai") return { kind: sniffed, loc: { ...loc, kind: sniffed, conversations: [only.name] } };
    if (sniffed === "empty") return { kind: "unknown", loc, problem: "export-empty" };
  }
  return { kind: "unknown", loc, problem: "export-not-recognised" };
}

// ═════════════════════════════ 4. Export pipeline ═════════════════════════════

/** An alternative wording of a kept turn (an edit or a regeneration on another branch). */
export interface ExportTurnVersion {
  nativeId: string;
  /** Dedupe key: the entry id this wording would have as a kept turn. */
  key: string;
  text: string;
  at?: IsoDate;
}

/** One entry-to-be of a conversation (a message, or the text of an attachment). */
export interface ExportTurn {
  nativeId: string;
  /** Dedupe key within the source (`entryId(source, key)`). */
  key: string;
  kind: Extract<EntryKind, "message" | "document">;
  speaker: Speaker;
  speakerDetail?: string;
  /** Document title (attachment or file name). */
  title?: string;
  /** Verbatim text as exported. */
  text: string;
  at?: IsoDate;
  /** How strongly `at` dates the words (default strong). */
  atStrength?: DateStrength;
  /** Where `at` came from (DateEvidence.detail). */
  atDetail?: string;
  hidden?: EntryRecord["hiddenByDefault"];
  attachments?: AttachmentRef[];
  versions?: ExportTurnVersion[];
  /** sha256 hex of the unit as read (the message object's JSON). */
  unitSha256: string;
}

/** A normalised conversation of an export: the kept branch only, in order. */
export interface ExportConversation {
  nativeId: string;
  /** Native title ("" when the service has none). */
  title: string;
  createdAt?: IsoDate;
  updatedAt?: IsoDate;
  /** Project name (project dimension, folder). */
  project?: string;
  /** Stable project id (preview counts). */
  projectKey?: string;
  meta?: Record<string, string>;
  turns: ExportTurn[];
  /** Byte offset of the conversation in its file (SourceRef.byteOffset). */
  byteOffset?: number;
  /**
   * Entries that belong to no conversation (Claude.ai project documents): stored in a segment folder of their own
   * (`conversationId(source, nativeId)`), with no ConversationRecord.
   */
  standalone?: boolean;
}

/** One resumable unit of an export, numbered in a deterministic order. */
export interface ExportUnit {
  index: number;
  conversation?: ExportConversation;
  /** Set when the unit could not be read (it is counted, reported and skipped). */
  error?: RunnerErrorCode;
}

export interface FormatEnv {
  settings: CortexSettings;
  signal: AbortSignal;
  /** Speaker of the person's own side (Settings › Privacy › Which speaker is you). */
  human: Speaker;
  /** The record as it stands (set before `units` runs). */
  state?: ExportRecordState;
}

export interface PreparedExport<P> {
  /** Units this export yields (resume cursors count them). */
  units: number;
  /** sha256 of the data files in reading order (the manifest key; zip and folder forms agree). */
  sha256: string;
  /** Uncompressed bytes of the data files. */
  bytes: number;
  /** Projects listed by the export itself (Claude.ai projects.json). */
  projects?: number;
  plan: P;
}

/** What each export format plugs into the shared pipeline. */
export interface ExportFormat<P = unknown> {
  readonly source: ExportSourceKind;
  readonly label: string;
  enabled(settings: CortexSettings): boolean;
  keepCopy(settings: CortexSettings): boolean;
  /** Settings that change unit numbering are part of the resume cursor (Gemini's grouping gap). */
  cursorTag(settings: CortexSettings): string;
  /** Formats that are not one of the three chat services recognise their own export (importers/extra/chatExports.ts). */
  identify?(src: ExportSource, signal: AbortSignal): Promise<IdentifiedExport>;
  /** One fast pass: count units and hash the data files. */
  prepare(src: ExportSource, loc: LocatedExport, env: FormatEnv): Promise<PreparedExport<P>>;
  /** Units from `from` on, in the order `prepare` counted them. */
  units(src: ExportSource, loc: LocatedExport, prep: PreparedExport<P>, env: FormatEnv, from: number): AsyncIterable<ExportUnit>;
}

export type { ExportImportStats };

export function humanSpeaker(settings: CortexSettings, source: SourceKind): Speaker {
  return settings.you?.speakerBySource?.[source] === "other" ? "other" : "you";
}

export function isoOrUndefined(v: unknown): IsoDate | undefined {
  if (typeof v !== "string" || v.length === 0) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  heic: "image/heic", bmp: "image/bmp", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv",
  json: "application/json", html: "text/html", htm: "text/html", xml: "application/xml", py: "text/x-python",
  js: "text/javascript", ts: "text/x-typescript", wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg",
  webm: "video/webm", mp4: "video/mp4", mov: "video/quicktime", zip: "application/zip",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** MIME type from a file name (or a bare type like "pdf"), else `fallback`. */
export function mimeOf(name: string, fallback = "application/octet-stream"): string {
  const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] ?? name).toLowerCase();
  return MIME_BY_EXT[ext] ?? fallback;
}

/** sha256 hex of a value's JSON (the "unit as read" of a parsed message). */
export function unitSha(value: unknown): string {
  return sha256Text(JSON.stringify(value) ?? "");
}

// ───────────────────────────── the record as it stands ─────────────────────────────

interface KnownEntry {
  conv?: ConversationId;
  idx?: number;
  supersedes?: EntryId;
  nativeId?: string;
  addedAt: string;
}

export interface ExportExclusions {
  /** The whole source is left out. */
  source: boolean;
  conversations: ReadonlySet<string>;
  projects: ReadonlySet<string>;
  folders: readonly string[];
}

/** What the ledgers already hold for one source, loaded once per pass. */
export interface ExportRecordState {
  readonly source: SourceKind;
  /** Latest ConversationRecord per conversation. */
  readonly records: Map<ConversationId, ConversationRecord>;
  /** Every entry of this source. */
  readonly entries: Map<EntryId, KnownEntry>;
  readonly byConv: Map<ConversationId, EntryId[]>;
  /** Latest entry per native id for entries outside conversations (project documents). */
  readonly standalone: Map<string, { id: EntryId; addedAt: string }>;
  readonly exclusions: ExportExclusions;
}

/** Fold exclusions: an exclude is active unless an active undo or include reverses it (M2). */
export function exportExclusions(corrections: readonly CorrectionRecord[], source: SourceKind): ExportExclusions {
  const undoneBy = new Map<string, CorrectionRecord[]>();
  const includedBy = new Map<string, CorrectionRecord[]>();
  for (const c of corrections) {
    if (typeof c.undoes === "string") undoneBy.set(c.undoes, [...(undoneBy.get(c.undoes) ?? []), c]);
    if (c.action === "include") {
      const target = (c.payload as { excludeCorrectionId?: unknown } | undefined)?.excludeCorrectionId;
      if (typeof target === "string") includedBy.set(target, [...(includedBy.get(target) ?? []), c]);
    }
  }
  const memo = new Map<string, boolean>();
  const active = (c: CorrectionRecord, guard: Set<string>): boolean => {
    const known = memo.get(c.id);
    if (known !== undefined) return known;
    if (guard.has(c.id)) return true;
    guard.add(c.id);
    let on = !(undoneBy.get(c.id) ?? []).some((u) => active(u, guard));
    if (on && c.action === "exclude") on = !(includedBy.get(c.id) ?? []).some((i) => active(i, guard));
    guard.delete(c.id);
    memo.set(c.id, on);
    return on;
  };
  const out = { source: false, conversations: new Set<string>(), projects: new Set<string>(), folders: [] as string[] };
  for (const c of corrections) {
    if (c.action !== "exclude" || !active(c, new Set())) continue;
    const p = (c.payload ?? {}) as { scope?: unknown; sourceKind?: unknown; project?: unknown; folder?: unknown };
    const forOther = typeof p.sourceKind === "string" && p.sourceKind !== source;
    switch (p.scope) {
      case "conversation":
        out.conversations.add(c.target);
        break;
      case "source":
        if (p.sourceKind === source || c.target === source) out.source = true;
        break;
      case "project":
        if (!forOther) out.projects.add(typeof p.project === "string" ? p.project : c.target);
        break;
      case "folder":
        if (!forOther) out.folders.push(typeof p.folder === "string" ? p.folder : c.target);
        break;
      default:
        break;
    }
  }
  return out;
}

function folderExcluded(folder: readonly string[], excluded: readonly string[]): boolean {
  if (folder.length === 0 || excluded.length === 0) return false;
  const f = folder.join("/");
  return excluded.some((x) => x.length > 0 && (f === x || f.startsWith(x.endsWith("/") ? x : `${x}/`)));
}

/** Stream one ledger, parsing only lines that mention the source (ids and refs never contain text). */
async function* scanLedger<T>(ctx: ImportContext, ledger: "entries" | "conversations", source: SourceKind): AsyncGenerator<T> {
  const needle = Buffer.from(JSON.stringify(source));
  const decoder = new TextDecoder();
  for (const month of await ctx.ledger.months(ledger)) {
    const dir = resolveInVault(ctx.store.vaultRoot, ledgerMonthDir(ledger, month));
    for (const name of await ctx.ledger.shards(ledger, month)) {
      const found: T[] = [];
      const splitter = new ByteLineSplitter(0);
      try {
        for await (const chunk of createReadStream(path.join(dir, name), { highWaterMark: 1 << 20 })) {
          ctx.token.throwIfCancelled();
          splitter.push(chunk as Buffer, (line) => {
            const bytes = trimCr(line.bytes);
            if (bytes.length === 0 || Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(needle) < 0) return;
            try {
              found.push(JSON.parse(decoder.decode(bytes)) as T);
            } catch {
              // a torn line from an interrupted append: ignored, as by every ledger reader
            }
          });
          for (const r of found) yield r;
          found.length = 0;
        }
      } catch (e) {
        if (errCode(e) === "ENOENT") continue;
        throw e;
      }
    }
  }
}

/** Load what the ledgers hold for `source` (one streaming pass over two ledgers + the corrections). */
export async function loadExportState(ctx: ImportContext, source: SourceKind): Promise<ExportRecordState> {
  const records = new Map<ConversationId, ConversationRecord>();
  for await (const r of scanLedger<ConversationRecord>(ctx, "conversations", source)) {
    if (r?.source !== source || typeof r.id !== "string") continue;
    const prev = records.get(r.id);
    if (!prev || (r.seq ?? 0) >= (prev.seq ?? 0)) records.set(r.id, r);
  }
  const entries = new Map<EntryId, KnownEntry>();
  const byConv = new Map<ConversationId, EntryId[]>();
  const standalone = new Map<string, { id: EntryId; addedAt: string }>();
  for await (const e of scanLedger<EntryRecord>(ctx, "entries", source)) {
    if (e?.source !== source || typeof e.id !== "string" || entries.has(e.id)) continue;
    const known: KnownEntry = { addedAt: typeof e.addedAt === "string" ? e.addedAt : "" };
    if (e.conv) known.conv = e.conv;
    if (typeof e.idx === "number") known.idx = e.idx;
    if (e.supersedes) known.supersedes = e.supersedes;
    if (e.sourceRef?.nativeId) known.nativeId = e.sourceRef.nativeId;
    entries.set(e.id, known);
    if (e.conv) byConv.set(e.conv, [...(byConv.get(e.conv) ?? []), e.id]);
    else if (known.nativeId) {
      const prev = standalone.get(known.nativeId);
      if (!prev || prev.addedAt <= known.addedAt) standalone.set(known.nativeId, { id: e.id, addedAt: known.addedAt });
    }
  }
  const exclusions = exportExclusions(await ctx.ledger.readCorrections(), source);
  return { source, records, entries, byConv, standalone, exclusions };
}

// ───────────────────────────── branches ─────────────────────────────

/** A node of a conversation tree (ChatGPT mapping, Claude.ai parent links). */
export interface BranchNode<T> {
  id: string;
  /** Parent node id; unknown ids and self-references make the node a root. */
  parent?: string;
  /** Stable source order (array or mapping position): breaks ties. */
  order: number;
  /** Epoch ms, NaN when unknown. */
  time: number;
  /** Undefined for nodes that are not turns (roots, hidden context, empty or skipped messages). */
  value?: T;
  speaker?: Speaker;
}

export interface BranchSplit<T> {
  /** Turns of the kept branch, root first. */
  kept: BranchNode<T>[];
  /** Kept node id → turns of other branches at the same position with the same speaker, oldest first. */
  versionsOf: Map<string, BranchNode<T>[]>;
}

/**
 * Split a conversation tree into the kept branch (root → `leafId`, or → the newest leaf) and versions: every
 * turn on another branch becomes an earlier wording of the kept turn at the same position with the same speaker
 * (or the nearest earlier kept turn of that speaker). Cycles and dangling parents are tolerated.
 */
export function splitBranches<T>(nodes: readonly BranchNode<T>[], leafId?: string): BranchSplit<T> {
  const byId = new Map<string, BranchNode<T>>();
  for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n);
  const parentOf = (n: BranchNode<T>): BranchNode<T> | undefined => (n.parent !== undefined && n.parent !== n.id ? byId.get(n.parent) : undefined);
  const hasChild = new Set<string>();
  for (const n of byId.values()) {
    const p = parentOf(n);
    if (p) hasChild.add(p.id);
  }
  const rank = (n: BranchNode<T>): number => (Number.isFinite(n.time) ? n.time : Number.NEGATIVE_INFINITY);
  let leaf = leafId !== undefined ? byId.get(leafId) : undefined;
  if (!leaf) {
    for (const n of byId.values()) {
      if (hasChild.has(n.id)) continue;
      if (!leaf || rank(n) > rank(leaf) || (rank(n) === rank(leaf) && n.order > leaf.order)) leaf = n;
    }
  }
  if (!leaf) {
    // Every node has a child (a cycle): start from the newest one.
    for (const n of byId.values()) if (!leaf || rank(n) > rank(leaf) || (rank(n) === rank(leaf) && n.order > leaf.order)) leaf = n;
  }
  const path: BranchNode<T>[] = [];
  const onPath = new Set<string>();
  for (let cur = leaf; cur && !onPath.has(cur.id); cur = parentOf(cur)) {
    onPath.add(cur.id);
    path.push(cur);
  }
  path.reverse();
  const kept = path.filter((n) => n.value !== undefined);
  const versionsOf = new Map<string, BranchNode<T>[]>();
  if (byId.size === path.length) return { kept, versionsOf };
  // Turns from the root down to and including each node (iterative, memoised, cycle-safe).
  const depth = new Map<string, number>();
  const turnsTo = (start: BranchNode<T>): number => {
    const chain: BranchNode<T>[] = [];
    const seen = new Set<string>();
    let base = 0;
    for (let cur: BranchNode<T> | undefined = start; cur; cur = parentOf(cur)) {
      const d = depth.get(cur.id);
      if (d !== undefined) {
        base = d;
        break;
      }
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      chain.push(cur);
    }
    for (let k = chain.length - 1; k >= 0; k--) {
      const node = chain[k] as BranchNode<T>;
      base += node.value !== undefined ? 1 : 0;
      depth.set(node.id, base);
    }
    return depth.get(start.id) ?? 0;
  };
  for (const n of byId.values()) {
    if (onPath.has(n.id) || n.value === undefined || kept.length === 0) continue;
    let t = Math.min(turnsTo(n) - 1, kept.length - 1);
    while (t >= 0 && kept[t]?.speaker !== n.speaker) t--;
    const target = t >= 0 ? kept[t] : undefined;
    if (!target) continue;
    const list = versionsOf.get(target.id) ?? [];
    list.push(n);
    versionsOf.set(target.id, list);
  }
  for (const list of versionsOf.values()) list.sort((a, b) => rank(a) - rank(b) || a.order - b.order);
  return { kept, versionsOf };
}

// ───────────────────────────── the writer ─────────────────────────────

export type WriteOutcome =
  | { kind: "added"; entries: number; secrets: number; created: boolean }
  /** No new entries; the conversation record changed (title, span) or was missing. */
  | { kind: "updated" }
  /** Everything is already in the record. */
  | { kind: "here" }
  /** The record holds newer content for this conversation (an older export): left as it is. */
  | { kind: "newer-here"; recordUpdatedAt: IsoDate }
  | { kind: "excluded" }
  | { kind: "empty" };

export interface ExportWriterOptions {
  source: ExportSourceKind;
  /** Absolute path of the export (SourceRef.path). */
  exportPath: string;
  human: Speaker;
  /** Count only: no segment, ledger, held or manifest writes. */
  dryRun: boolean;
  keepSecretsLocal: boolean;
}

/** A new part starts after this much silence (CORTEX-UX: a gap of more than 6 hours). */
export const PART_GAP_MS = 6 * 3_600_000;
/** An export is older for a conversation when the record ends this much later than the export does. */
export const NEWER_TOLERANCE_MS = 1_000;
const FLUSH_ENTRIES = 2_000;
const FLUSH_CONVERSATIONS = 200;
const FLUSH_MS = 3_000;
const SEGMENT_FILE = /^\d{4}\.jsonl\.gz$/;
const DATE_FIELD: Readonly<Record<ExportSourceKind, string>> = { "claude-ai": "created_at", chatgpt: "create_time", gemini: "time" };

interface HeldSpans {
  secrets: string[];
  kinds: string[];
}

/**
 * `<cache>/held/<id>.json`: originals of the secrets replaced by SECRET_MARKER in the vault copy, in marker order
 * (RecordReader.revealHeld(entryId, n) returns `text.secrets[n]`). Never synced.
 */
export interface HeldSecretsFile {
  v: 1;
  /** Entry id (text and versions) or conversation id (title). */
  id: string;
  at: IsoDate;
  text?: HeldSpans;
  title?: HeldSpans;
  /** By BranchVersion.nativeId. */
  versions?: Record<string, HeldSpans>;
}

interface Placed {
  turn: ExportTurn;
  id: EntryId;
  pos: number;
}

type SegmentRef = { store: "segment"; seg: VaultPath; line: number };

function isoMs(v: IsoDate | undefined): number {
  return v === undefined ? Number.NaN : Date.parse(v);
}

function monthKeyOf(ms: number, now: number): string {
  const t = Number.isFinite(ms) ? ms : now;
  const iso = new Date(t).toISOString();
  return /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : new Date(now).toISOString().slice(0, 7);
}

function monthOfSegDir(segDir: string, source: SourceKind, conv: ConversationId): string | undefined {
  const m = /^\.raw\/chats\/([^/]+)\/(\d{4}-\d{2})\/([^/]+)$/.exec(segDir);
  return m && m[1] === source && m[3] === conv ? m[2] : undefined;
}

/** Parts: a new part after more than 6 hours of silence (times in kept order; undated turns join the current part). */
export function computeParts(ids: readonly EntryId[], times: readonly number[]): { parts: ConversationPart[]; partOf: number[] } {
  const parts: ConversationPart[] = [];
  const partOf: number[] = [];
  let lastT = Number.NaN;
  for (let j = 0; j < ids.length; j++) {
    const t = times[j] ?? Number.NaN;
    const id = ids[j] as EntryId;
    const current = parts[parts.length - 1];
    if (!current || (Number.isFinite(t) && Number.isFinite(lastT) && t - lastT > PART_GAP_MS)) {
      const part: ConversationPart = { n: parts.length + 1, firstEntry: id, lastEntry: id };
      if (Number.isFinite(t)) part.startedAt = new Date(t).toISOString();
      parts.push(part);
    } else {
      current.lastEntry = id;
      if (current.startedAt === undefined && Number.isFinite(t)) current.startedAt = new Date(t).toISOString();
    }
    partOf.push(parts.length);
    if (Number.isFinite(t)) lastT = t;
  }
  return { parts, partOf };
}

function sameParts(a: readonly ConversationPart[], b: readonly ConversationPart[]): boolean {
  return a.length === b.length && a.every((p, i) => p.firstEntry === b[i]?.firstEntry && p.lastEntry === b[i]?.lastEntry && p.startedAt === b[i]?.startedAt);
}

/**
 * Writes normalised export conversations into the record: one immutable segment per conversation per pass,
 * EntryRecords and an upserted ConversationRecord (ledger appends batched). Local adapter for E3's
 * ConversationBatch until it carries versions, attachments, documents and supersedes (docs/rfcs/E4.md).
 */
export class ExportWriter {
  private entryBuf: EntryRecord[] = [];
  private convBuf: ConversationRecord[] = [];
  private lastFlushAt: number;
  /** Secrets replaced in text bound for the vault during this pass. */
  secretsHeld = 0;

  constructor(
    private readonly ctx: ImportContext,
    private readonly state: ExportRecordState,
    private readonly opts: ExportWriterOptions,
  ) {
    this.lastFlushAt = ctx.now();
  }

  /** Records waiting for the next ledger append. */
  get pending(): number {
    return this.entryBuf.length + this.convBuf.length;
  }

  needsFlush(): boolean {
    if (this.entryBuf.length >= FLUSH_ENTRIES || this.convBuf.length >= FLUSH_CONVERSATIONS) return true;
    return this.pending > 0 && this.ctx.now() - this.lastFlushAt >= FLUSH_MS;
  }

  /** Append buffered EntryRecords, then the ConversationRecords (whose seq is set here). */
  async flush(): Promise<void> {
    const entries = this.entryBuf;
    const convs = this.convBuf;
    this.entryBuf = [];
    this.convBuf = [];
    this.lastFlushAt = this.ctx.now();
    if (this.opts.dryRun) return;
    if (entries.length > 0) await this.ctx.ledger.append("entries", entries);
    if (convs.length > 0) {
      const seq = (await this.ctx.ledger.seq()) + 1;
      for (const r of convs) r.seq = seq;
      await this.ctx.ledger.append("conversations", convs);
    }
  }

  async write(conv: ExportConversation): Promise<WriteOutcome> {
    const { source } = this.opts;
    const ex = this.state.exclusions;
    const convId = conversationId(source, conv.nativeId);
    const folder = conv.project ? [conv.project] : [];
    if (ex.source || ex.conversations.has(convId) || (conv.project !== undefined && ex.projects.has(conv.project)) || folderExcluded(folder, ex.folders)) {
      return { kind: "excluded" };
    }
    const seen = new Set<EntryId>();
    const placed: Placed[] = [];
    for (const turn of conv.turns) {
      if (turn.text.trim().length === 0 && !(turn.attachments && turn.attachments.length > 0)) continue;
      const id = entryId(source, turn.key);
      if (seen.has(id)) continue; // a duplicated message id in a damaged export: first one wins
      seen.add(id);
      placed.push({ turn, id, pos: placed.length });
    }
    if (placed.length === 0) return { kind: "empty" };
    return conv.standalone ? this.writeDocuments(conv, convId, folder, placed) : this.writeConversation(conv, convId, folder, placed);
  }

  private protect(text: string): { text: string; held?: HeldSpans } {
    if (!this.opts.keepSecretsLocal || text.length === 0) return { text };
    const scan = scanSecrets(text, { highConfidenceOnly: true, replacement: SECRET_MARKER });
    if (scan.count === 0) return { text };
    return { text: scan.text, held: { secrets: scan.spans.map((s) => text.slice(s.start, s.end)), kinds: scan.spans.map((s) => s.id) } };
  }

  private dates(at: IsoDate | undefined, strength: DateStrength, detail: string, fallback: IsoDate | undefined, addedAt: IsoDate): { dates: DateEvidence[]; writtenAt?: IsoDate } {
    const dates: DateEvidence[] = [];
    let writtenAt: IsoDate | undefined;
    if (at !== undefined) {
      dates.push({ type: "source-timestamp", strength, at, detail });
      if (strength === "strong" || strength === "medium") writtenAt = at;
    } else if (fallback !== undefined) {
      dates.push({ type: "conversation-start", strength: "medium", at: fallback, detail: "conversation start" });
      writtenAt = fallback;
    }
    dates.push({ type: "ingest", strength: "bound", at: addedAt, detail: "first imported" });
    return writtenAt === undefined ? { dates } : { dates, writtenAt };
  }

  /** Lines of segments in `segDir` that no ledger line points at (an interrupted pass): reused, never rewritten. */
  private async adoptable(segDir: VaultPath): Promise<Map<string, { seg: VaultPath; line: number; sha: string }>> {
    const out = new Map<string, { seg: VaultPath; line: number; sha: string }>();
    if (this.opts.dryRun) return out;
    let names: string[];
    try {
      names = (await fsp.readdir(resolveInVault(this.ctx.store.vaultRoot, segDir))).filter((n) => SEGMENT_FILE.test(n)).sort();
    } catch {
      return out;
    }
    for (const n of names) {
      const rel = `${segDir}/${n}`;
      let lines: SegmentLine[];
      try {
        lines = await readSegment(this.ctx.store.vaultRoot, rel);
      } catch {
        continue;
      }
      if (lines.length === 0 || lines.some((l) => this.state.entries.has(l.id))) continue;
      lines.forEach((l, k) => {
        if (!out.has(l.id)) out.set(l.id, { seg: rel, line: k, sha: l.sha });
      });
    }
    return out;
  }

  private async writeHeld(files: readonly HeldSecretsFile[]): Promise<void> {
    if (this.opts.dryRun) return;
    for (const f of files) await writeJsonAtomic(cacheWritablePath(this.ctx.store.cacheDir, `held/${f.id}.json`), f);
  }

  /** Place one text: reuse an adoptable orphan line with the same id and text, else append a new line. */
  private place(
    id: EntryId,
    msg: PendingMessage,
    conv: ConversationId | undefined,
    i: number,
    adopt: Map<string, { seg: VaultPath; line: number; sha: string }>,
    lines: SegmentLine[],
    refs: SegmentRef[],
  ): { ref: SegmentRef; sha: string } {
    const sha = sha256Text(msg.text);
    const orphan = adopt.get(id);
    if (orphan && orphan.sha === sha) return { ref: { store: "segment", seg: orphan.seg, line: orphan.line }, sha };
    lines.push(toSegmentLine(id, msg, conv, i, sha));
    const ref: SegmentRef = { store: "segment", seg: "", line: lines.length - 1 };
    refs.push(ref);
    return { ref, sha };
  }

  private sourceRef(turn: ExportTurn, byteOffset: number | undefined): EntryRecord["sourceRef"] {
    const ref: EntryRecord["sourceRef"] = { path: this.opts.exportPath, nativeId: turn.nativeId, sha256: turn.unitSha256 };
    if (byteOffset !== undefined) ref.byteOffset = byteOffset;
    return ref;
  }

  private effectiveSequence(convId: ConversationId): (EntryId | undefined)[] {
    const ids = this.state.byConv.get(convId) ?? [];
    const superseded = new Set<string>();
    for (const id of ids) {
      const s = this.state.entries.get(id)?.supersedes;
      if (s) superseded.add(s);
    }
    const seq: (EntryId | undefined)[] = [];
    for (const id of ids) {
      const e = this.state.entries.get(id);
      if (!e || e.idx === undefined || e.idx < 0 || superseded.has(id)) continue;
      const cur = seq[e.idx];
      if (cur === undefined || (this.state.entries.get(cur)?.addedAt ?? "") <= e.addedAt) seq[e.idx] = id;
    }
    return seq;
  }

  private async writeConversation(conv: ExportConversation, convId: ConversationId, folder: string[], placed: Placed[]): Promise<WriteOutcome> {
    const { source } = this.opts;
    const record = this.state.records.get(convId);
    const times = placed.map((p) => isoMs(p.turn.at));
    const dated = times.filter((t) => Number.isFinite(t));
    const lastMs = dated.length > 0 ? Math.max(...dated) : isoMs(conv.updatedAt);
    const firstMs = dated.length > 0 ? Math.min(...dated) : isoMs(conv.createdAt);
    if (record?.endedAt !== undefined && Number.isFinite(lastMs) && isoMs(record.endedAt) > lastMs + NEWER_TOLERANCE_MS) {
      return { kind: "newer-here", recordUpdatedAt: record.updatedAt };
    }
    const now = this.ctx.now();
    const addedAt = new Date(now).toISOString();
    const ids = placed.map((p) => p.id);
    const { parts, partOf } = computeParts(ids, times);
    const fresh = placed.filter((p) => !this.state.entries.has(p.id));
    const prepared = fresh.map((p) => ({ p, main: this.protect(p.turn.text) }));

    // Title: native, else the first line of the person's first message (after secrets are replaced).
    const heldFiles: HeldSecretsFile[] = [];
    let title: string;
    let titledBy: ConversationRecord["titledBy"];
    if (record && (record.titledBy === "user" || record.titledBy === "model")) {
      title = record.title;
      titledBy = record.titledBy;
    } else {
      const native = this.protect(normalizeWhitespace(conv.title));
      if (native.text.length > 0) {
        title = native.text;
        titledBy = "native";
        if (native.held) heldFiles.push({ v: 1, id: convId, at: addedAt, title: native.held });
      } else {
        const first = placed.find((p) => p.turn.kind === "message" && p.turn.speaker === this.opts.human) ?? placed.find((p) => p.turn.kind === "message") ?? placed[0];
        title = first ? firstLineTitle(this.protect(first.turn.text).text) : "";
        if (title.length === 0 && first?.turn.title) title = first.turn.title;
        titledBy = "first-line";
      }
    }
    const recMonth = record?.segDir ? monthOfSegDir(record.segDir, source, convId) : undefined;
    const monthKey = recMonth ?? monthKeyOf(firstMs, now);
    const segDir = segmentDir(source, monthKey, convId);
    const eff = record || this.state.byConv.has(convId) ? this.effectiveSequence(convId) : [];
    const next: ConversationRecord = {
      v: 1,
      id: convId,
      seq: 0,
      source,
      nativeId: conv.nativeId,
      title,
      titledBy,
      entryCount: Math.max(placed.length, eff.length),
      parts,
      space: record?.space ?? "none",
      folder: record && record.folder.length > 0 ? record.folder : folder,
      segDir,
      updatedAt: addedAt,
    };
    const startedAt = Number.isFinite(firstMs) ? new Date(firstMs).toISOString() : undefined;
    const endedAt = Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : undefined;
    if (startedAt) next.startedAt = startedAt;
    if (endedAt) next.endedAt = endedAt;
    const project = conv.project ?? record?.project;
    if (project) next.project = project;
    if (conv.meta && Object.keys(conv.meta).length > 0) next.meta = conv.meta;
    else if (record?.meta) next.meta = record.meta;
    if (record?.gistNoteId) next.gistNoteId = record.gistNoteId;

    if (fresh.length === 0) {
      const changed =
        !record ||
        record.title !== next.title ||
        record.titledBy !== next.titledBy ||
        record.startedAt !== next.startedAt ||
        record.endedAt !== next.endedAt ||
        record.entryCount !== next.entryCount ||
        record.project !== next.project ||
        record.segDir !== next.segDir ||
        !sameParts(record.parts ?? [], next.parts);
      if (!changed) return { kind: "here" };
      await this.writeHeld(heldFiles);
      this.secretsHeld += heldFiles.reduce((n, f) => n + (f.title?.secrets.length ?? 0), 0);
      this.queueRecord(next);
      return { kind: "updated" };
    }

    const adopt = await this.adoptable(segDir);
    const lines: SegmentLine[] = [];
    const refs: SegmentRef[] = [];
    const records: EntryRecord[] = [];
    const inConv = new Set(ids);
    let secrets = heldFiles.reduce((n, f) => n + (f.title?.secrets.length ?? 0), 0);
    for (const { p, main } of prepared) {
      const t = p.turn;
      const pending: PendingMessage = { nativeId: t.nativeId, speaker: t.speaker, text: main.text, sourceRef: this.sourceRef(t, conv.byteOffset) };
      if (t.speakerDetail !== undefined) pending.speakerDetail = t.speakerDetail;
      if (t.at !== undefined) pending.ts = t.at;
      const placedText = this.place(p.id, pending, convId, p.pos, adopt, lines, refs);
      const held: HeldSecretsFile = { v: 1, id: p.id, at: addedAt };
      if (main.held) {
        held.text = main.held;
        secrets += main.held.secrets.length;
      }
      const branches: BranchVersion[] = [];
      for (const v of t.versions ?? []) {
        const vid = entryId(source, v.key);
        if (vid === p.id || inConv.has(vid) || this.state.entries.has(vid)) continue; // recorded wordings stay entries
        const vt = this.protect(v.text);
        if (vt.text.trim().length === 0) continue;
        const vmsg: PendingMessage = { nativeId: v.nativeId, speaker: t.speaker, text: vt.text, sourceRef: { path: this.opts.exportPath, nativeId: v.nativeId, sha256: sha256Text(v.text) } };
        if (t.speakerDetail !== undefined) vmsg.speakerDetail = t.speakerDetail;
        if (v.at !== undefined) vmsg.ts = v.at;
        const vp = this.place(vid, vmsg, convId, p.pos, adopt, lines, refs);
        const bv: BranchVersion = { nativeId: v.nativeId, text: vp.ref, textSha256: vp.sha };
        if (v.at !== undefined) bv.at = v.at;
        branches.push(bv);
        if (vt.held) {
          held.versions = { ...(held.versions ?? {}), [v.nativeId]: vt.held };
          secrets += vt.held.secrets.length;
        }
      }
      if (held.text || held.versions) heldFiles.push(held);
      const { dates, writtenAt } = this.dates(t.at, t.atStrength ?? "strong", t.atDetail ?? DATE_FIELD[source], conv.createdAt, addedAt);
      const rec = makeEntryRecord({
        id: p.id,
        kind: t.kind,
        source,
        sourceRef: pending.sourceRef,
        text: main.text,
        textSha256: placedText.sha,
        textRef: placedText.ref,
        speaker: t.speaker,
        ...(t.speakerDetail !== undefined ? { speakerDetail: t.speakerDetail } : {}),
        conv: convId,
        idx: p.pos,
        part: partOf[p.pos] ?? 1,
        ...(t.title !== undefined ? { title: this.protect(t.title).text } : {}),
        ...(writtenAt !== undefined ? { writtenAt } : {}),
        dates,
        addedAt,
        space: next.space,
        folder: next.folder,
        ...(project ? { project } : {}),
        ...(t.hidden !== undefined ? { hiddenByDefault: t.hidden } : {}),
      });
      if (t.attachments && t.attachments.length > 0) rec.attachments = t.attachments;
      if (branches.length > 0) rec.branches = branches;
      const replaced = eff[p.pos];
      if (replaced !== undefined && replaced !== p.id && !inConv.has(replaced)) rec.supersedes = replaced;
      records.push(rec);
    }

    if (!this.opts.dryRun) {
      await this.writeHeld(heldFiles); // originals first: a crash must never lose a replaced secret
      if (lines.length > 0) {
        const written = await writeSegment(this.ctx.store, { source, monthKey, conv: convId, lines });
        for (const r of refs) r.seg = written.path;
      }
    }
    for (const rec of records) {
      this.entryBuf.push(rec);
      this.remember(rec);
    }
    this.queueRecord(next);
    this.secretsHeld += secrets;
    return { kind: "added", entries: records.length, secrets, created: !record };
  }

  private async writeDocuments(conv: ExportConversation, folderId: ConversationId, folder: string[], placed: Placed[]): Promise<WriteOutcome> {
    const { source } = this.opts;
    const fresh = placed.filter((p) => !this.state.entries.has(p.id));
    if (fresh.length === 0) return { kind: "here" };
    const now = this.ctx.now();
    const addedAt = new Date(now).toISOString();
    const times = placed.map((p) => isoMs(p.turn.at)).filter((t) => Number.isFinite(t));
    const created = isoMs(conv.createdAt);
    const monthKey = monthKeyOf(Number.isFinite(created) ? created : times.length > 0 ? Math.min(...times) : Number.NaN, now);
    const adopt = await this.adoptable(segmentDir(source, monthKey, folderId));
    const lines: SegmentLine[] = [];
    const refs: SegmentRef[] = [];
    const records: EntryRecord[] = [];
    const heldFiles: HeldSecretsFile[] = [];
    let secrets = 0;
    for (const p of fresh) {
      const t = p.turn;
      const main = this.protect(t.text);
      const pending: PendingMessage = { nativeId: t.nativeId, speaker: t.speaker, text: main.text, sourceRef: this.sourceRef(t, conv.byteOffset) };
      if (t.at !== undefined) pending.ts = t.at;
      const placedText = this.place(p.id, pending, undefined, p.pos, adopt, lines, refs);
      if (main.held) {
        heldFiles.push({ v: 1, id: p.id, at: addedAt, text: main.held });
        secrets += main.held.secrets.length;
      }
      const { dates, writtenAt } = this.dates(t.at, t.atStrength ?? "bound", t.atDetail ?? "uploaded", undefined, addedAt);
      const rec = makeEntryRecord({
        id: p.id,
        kind: t.kind,
        source,
        sourceRef: pending.sourceRef,
        text: main.text,
        textSha256: placedText.sha,
        textRef: placedText.ref,
        speaker: t.speaker,
        ...(t.title !== undefined ? { title: this.protect(t.title).text } : {}),
        ...(writtenAt !== undefined ? { writtenAt } : {}),
        dates,
        addedAt,
        space: "none",
        folder,
        ...(conv.project ? { project: conv.project } : {}),
        ...(t.hidden !== undefined ? { hiddenByDefault: t.hidden } : {}),
      });
      if (t.attachments && t.attachments.length > 0) rec.attachments = t.attachments;
      const previous = this.state.standalone.get(t.nativeId);
      if (previous && previous.id !== p.id) rec.supersedes = previous.id;
      records.push(rec);
    }
    if (!this.opts.dryRun) {
      await this.writeHeld(heldFiles);
      if (lines.length > 0) {
        const written = await writeSegment(this.ctx.store, { source, monthKey, conv: folderId, lines });
        for (const r of refs) r.seg = written.path;
      }
    }
    for (const rec of records) {
      this.entryBuf.push(rec);
      this.remember(rec);
    }
    this.secretsHeld += secrets;
    return { kind: "added", entries: records.length, secrets, created: false };
  }

  private remember(rec: EntryRecord): void {
    const known: KnownEntry = { addedAt: rec.addedAt };
    if (rec.conv) known.conv = rec.conv;
    if (rec.idx !== undefined) known.idx = rec.idx;
    if (rec.supersedes) known.supersedes = rec.supersedes;
    if (rec.sourceRef.nativeId) known.nativeId = rec.sourceRef.nativeId;
    this.state.entries.set(rec.id, known);
    if (rec.conv) this.state.byConv.set(rec.conv, [...(this.state.byConv.get(rec.conv) ?? []), rec.id]);
    else if (known.nativeId) this.state.standalone.set(known.nativeId, { id: rec.id, addedAt: rec.addedAt });
  }

  private queueRecord(rec: ConversationRecord): void {
    this.convBuf.push(rec);
    this.state.records.set(rec.id, rec);
  }
}

// ───────────────────────────── the pass ─────────────────────────────

/** Why an export cannot be read at `file`, from the path alone (never-read list and Off limits rows). */
export function checkExportPath(file: unknown, settings: CortexSettings): WarningCode | undefined {
  if (typeof file !== "string" || file.length === 0 || !path.isAbsolute(file) || /[\u0000-\u001f]/.test(file)) return "path-unreadable";
  if (isNeverRead(file)) return "path-unreadable";
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  const target = fold(path.resolve(file));
  for (const row of settings.privacy?.offLimits ?? []) {
    if (typeof row?.path !== "string" || !path.isAbsolute(row.path)) continue;
    const limit = fold(path.resolve(row.path));
    const prefix = limit.endsWith(path.sep) ? limit : limit + path.sep;
    if (target === limit || target.startsWith(prefix)) return "path-unreadable";
  }
  return undefined;
}

/** Warning code for a failure to open an export. */
export function openProblem(e: unknown): WarningCode {
  if (isCortexError(e)) return e.code === "E_PARSE" ? "export-not-recognised" : "path-unreadable";
  return "path-unreadable";
}

export function exportKey(source: ExportSourceKind, sha256: string): string {
  return `${source}:${sha256}`;
}

function encodeCursor(tag: string, n: number): string {
  return tag ? `${tag}:${n}` : String(n);
}

/** Where a paused import of the same export resumes (0 = from the start). */
export function resumeFrom(prior: SourceManifest["sources"][string] | undefined, tag: string, units: number): number {
  if (!prior || prior.status === "imported" || !prior.resume || typeof prior.resume.cursor !== "string") return 0;
  const raw = prior.resume.cursor;
  const at = raw.lastIndexOf(":");
  const gotTag = at < 0 ? "" : raw.slice(0, at);
  const n = Number(at < 0 ? raw : raw.slice(at + 1));
  if (gotTag !== tag || !Number.isInteger(n) || n < 0 || n > units) return 0;
  return n;
}

export function exportStats(source: ExportSourceKind, label: string): ExportImportStats {
  return { ...emptyStats(source, label), secretsHeld: 0, partial: false, excluded: 0 };
}

/** Discover an export selector's single unit (stat only). */
export async function discoverExport(file: string, label: string): Promise<DiscoveredUnit[]> {
  if (typeof file !== "string" || !path.isAbsolute(file)) return [];
  try {
    const st = await fsp.stat(file);
    return [{ key: file, path: file, bytes: st.isFile() ? st.size : 0, mtimeMs: st.mtimeMs, label }];
  } catch {
    return [];
  }
}

/** Copy the export's data into `<cache>/exports/` (never the vault, SAFE-07); a failure only logs. */
async function keepExportCopy(ctx: ImportContext, src: ExportSource, loc: LocatedExport, source: ExportSourceKind, sha: string): Promise<void> {
  const tag = `${source}-${sha.slice(0, 16)}`;
  const copies: { from: string; to: string }[] = [];
  if (src.form === "zip") copies.push({ from: src.path, to: `exports/${tag}.zip` });
  else {
    for (const m of [...loc.conversations, loc.projects, loc.geminiJson]) {
      const from = m ? src.fileOf(m) : undefined;
      if (from) copies.push({ from, to: `exports/${tag}-${path.basename(from).replace(/[^A-Za-z0-9._-]/g, "_")}` });
    }
  }
  for (const c of copies) {
    try {
      const dest = cacheWritablePath(ctx.store.cacheDir, c.to);
      if (await fsp.stat(dest).then(() => true, () => false)) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.cortex-tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
      try {
        await fsp.copyFile(c.from, tmp);
        await withFsRetry(() => fsp.rename(tmp, dest));
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => undefined);
      }
    } catch (e) {
      ctx.log.warn("could not keep a copy of the export", { source, code: errCode(e) ?? (isCortexError(e) ? e.code : "error") });
    }
  }
}

type StopReason = "cancelled" | "deadline" | "paused" | "limit" | "error";

async function stopReason(ctx: ImportContext, stats: ExportImportStats): Promise<StopReason | undefined> {
  if (ctx.token.cancelled) return "cancelled";
  if (ctx.deadline !== undefined && ctx.now() >= ctx.deadline) return "deadline";
  if (ctx.maxEntries !== undefined && stats.entriesAdded >= ctx.maxEntries) return "limit";
  if (!(await ctx.mayContinue())) return "paused";
  return undefined;
}

function tally(stats: ExportImportStats, out: WriteOutcome, conv: ExportConversation): void {
  switch (out.kind) {
    case "added":
      stats.entriesAdded += out.entries;
      if (!conv.standalone) stats.conversationsTouched++;
      break;
    case "updated":
      stats.conversationsTouched++;
      break;
    case "here":
    case "newer-here":
      if (!conv.standalone) stats.skipped++;
      break;
    case "excluded":
      stats.excluded++;
      break;
    case "empty":
      break;
  }
}

function fail(stats: ExportImportStats, code: string): ExportImportStats {
  stats.errors.push({ file: stats.source, message: code });
  return stats;
}

/**
 * Import one export file (zip, folder or JSON file) through `format`: recognise, hash and count, resume from the
 * manifest cursor, write conversation by conversation (control file re-read before every unit), save the cursor
 * at every ledger flush, and record the result in `.vault-meta/cortex/sources.json`. Problems the person can act
 * on come back as `errors` codes; cancellation throws E_CANCELLED after everything done so far is saved.
 */
export async function runExportImport<P>(ctx: ImportContext, file: string, format: ExportFormat<P>): Promise<ExportImportStats> {
  const stats = exportStats(format.source, format.label);
  if (!format.enabled(ctx.settings)) {
    ctx.log.info("export source is turned off in settings", { source: format.source });
    return stats;
  }
  const blocked = checkExportPath(file, ctx.settings);
  if (blocked) return fail(stats, blocked);
  stats.filesSeen = 1;
  if (ctx.dryRun) return importExport(ctx, file, format, stats);
  try {
    return await withLock(locksDirOf(ctx.store.cacheDir), `import:${format.source}`, { owner: ctx.store.owner, staleMs: ctx.store.lockStaleMs, waitMs: 2_000 }, () =>
      importExport(ctx, file, format, stats),
    );
  } catch (e) {
    if (isCortexError(e) && e.code === "E_LOCKED") return fail(stats, "E_LOCKED");
    throw e;
  }
}

async function importExport<P>(ctx: ImportContext, file: string, format: ExportFormat<P>, stats: ExportImportStats): Promise<ExportImportStats> {
  let src: ExportSource;
  try {
    src = await openExportSource(file);
  } catch (e) {
    return fail(stats, openProblem(e));
  }
  try {
    const signal = ctx.token.signal;
    const id = format.identify ? await format.identify(src, signal) : await identifyExport(src, signal);
    const problem = id.problem ?? (id.kind !== format.source ? "export-not-recognised" : undefined);
    if (problem) return fail(stats, problem);
    const env: FormatEnv = { settings: ctx.settings, signal, human: humanSpeaker(ctx.settings, format.source) };
    ctx.progress({ phase: "checking", done: 0, unit: "conversations" });
    let prep: PreparedExport<P>;
    try {
      prep = await format.prepare(src, id.loc, env);
    } catch (e) {
      if (isCortexError(e) && e.code === "E_PARSE") return fail(stats, "export-not-recognised");
      throw e;
    }
    stats.filesRead = 1;
    if (prep.units === 0) return fail(stats, "export-empty");
    const key = exportKey(format.source, prep.sha256);
    const dry = ctx.dryRun === true;
    const prior = dry ? undefined : (await loadSourceManifest(ctx.store)).sources[key];
    const tag = format.cursorTag(ctx.settings);
    const start = resumeFrom(prior, tag, prep.units);
    const state = await loadExportState(ctx, format.source);
    env.state = state;
    if (!dry && format.keepCopy(ctx.settings)) await keepExportCopy(ctx, src, id.loc, format.source, prep.sha256);
    const writer = new ExportWriter(ctx, state, { source: format.source, exportPath: src.path, human: env.human, dryRun: dry, keepSecretsLocal: ctx.settings.privacy.keepSecretsLocal });
    const base = { entries: prior?.entries ?? 0, conversations: prior?.conversations ?? 0 };
    const save = async (status: "imported" | "paused" | "error", cursor: number, error?: string): Promise<void> => {
      if (dry) return;
      const at = new Date(ctx.now()).toISOString();
      await updateSourceManifest(ctx.store, key, {
        kind: format.source,
        path: src.path,
        sha256: prep.sha256,
        bytes: prep.bytes,
        importedAt: at,
        entries: base.entries + stats.entriesAdded,
        conversations: base.conversations + stats.conversationsTouched,
        status,
        error,
        resume: status === "imported" ? undefined : { cursor: encodeCursor(tag, cursor), at },
      });
    };

    let next = start;
    let durable = start;
    let stop: StopReason | undefined;
    let failure: unknown;
    ctx.progress({ phase: "importing", done: start, total: prep.units, unit: "conversations" });
    try {
      for await (const unit of format.units(src, id.loc, prep, env, start)) {
        stop = await stopReason(ctx, stats);
        if (stop) break;
        if (unit.error) stats.errors.push({ file: `${format.source}:${unit.index}`, message: unit.error });
        else if (unit.conversation) tally(stats, await writer.write(unit.conversation), unit.conversation);
        next = unit.index + 1;
        ctx.progress({ phase: "importing", done: next, total: prep.units, unit: "conversations" });
        if (writer.needsFlush()) {
          await writer.flush();
          durable = next;
          await save("paused", durable);
        }
        await ctx.yield();
      }
    } catch (e) {
      if (isCortexError(e) && e.code === "E_CANCELLED") stop = "cancelled";
      else {
        failure = e;
        stop = "error";
      }
    }
    try {
      await writer.flush();
      durable = next;
    } catch (e) {
      failure ??= e;
      stop = "error";
    }
    stats.secretsHeld = writer.secretsHeld;
    stats.bytesRead = prep.bytes;
    const code = failure === undefined ? undefined : isCortexError(failure) ? failure.code : "E_INTERNAL";
    if (stop === undefined && durable < prep.units) stop = "error"; // the data ended early (a damaged file)
    if (stop) {
      stats.partial = true;
      if (code) stats.errors.push({ file: format.source, message: code });
      await save(stop === "error" ? "error" : "paused", durable, code);
    } else {
      await save("imported", durable);
    }
    ctx.log.info("export import pass", { source: format.source, added: stats.entriesAdded, conversations: stats.conversationsTouched, skipped: stats.skipped, partial: stats.partial });
    if (stop === "cancelled") throw new CortexError("E_CANCELLED", "cancelled");
    if (failure !== undefined && !isCortexError(failure)) throw failure;
    return stats;
  } finally {
    await src.close().catch(() => undefined);
  }
}

// ───────────────────────────── shared by the JSON formats ─────────────────────────────

/** Largest single conversation (or activity record) read; a bigger one is reported and skipped. */
export const MAX_EXPORT_ELEMENT_BYTES = 512 * 1024 * 1024;

/** One JSON list of an export (a conversations file, projects.json, MyActivity.json), counted. */
export interface ScannedFile {
  name: string;
  /** Complete elements. */
  count: number;
  /** The file ends before its list does (a cut-off download): its complete elements are still read. */
  truncated: boolean;
}

export interface ScannedFiles {
  files: ScannedFile[];
  /** Elements over all files (one unit each unless a format groups them). */
  units: number;
  bytes: number;
  /** sha256 of the files' bytes in the order given. */
  sha256: string;
  truncated: boolean;
}

function cancelledError(): CortexError {
  return new CortexError("E_CANCELLED", "cancelled");
}

/**
 * One fast pass over the lists: count their elements without parsing any and hash every byte. A file that ends
 * early is counted up to its last complete element and flagged; a file that is not a JSON list fails (E_PARSE).
 */
export async function scanJsonFiles(src: ExportSource, names: readonly string[], signal?: AbortSignal): Promise<ScannedFiles> {
  const hash = createHash("sha256");
  const files: ScannedFile[] = [];
  let bytes = 0;
  const sink: Parameters<JsonArrayScanner["push"]>[1] = [];
  for (const name of names) {
    const scanner = new JsonArrayScanner(Number.POSITIVE_INFINITY, MAX_EXPORT_ELEMENT_BYTES);
    const input = await src.open(name);
    try {
      for await (const raw of input) {
        if (signal?.aborted) throw cancelledError();
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
        hash.update(chunk);
        bytes += chunk.length;
        if (!scanner.finished) {
          scanner.push(chunk, sink);
          sink.length = 0;
        }
      }
    } finally {
      if (!input.destroyed) input.destroy();
    }
    let truncated = false;
    try {
      scanner.end();
    } catch (e) {
      if (!isCortexError(e) || e.code !== "E_PARSE") throw e;
      truncated = true;
    }
    files.push({ name, count: scanner.count, truncated });
  }
  return { files, units: files.reduce((n, f) => n + f.count, 0), bytes, sha256: hash.digest("hex"), truncated: files.some((f) => f.truncated) };
}

/** One element read by `streamFileElements`. */
export interface FileElement<T> {
  file: ScannedFile;
  /** Position over all files (the unit number when each element is a unit). */
  unit: number;
  /** Position in its file. */
  index: number;
  /** Byte offset in its file. */
  offset: number;
  /** Undefined when the element could not be read (too large or not valid JSON). */
  value?: T;
  error?: RunnerErrorCode;
}

/**
 * Stream the elements of the scanned lists from element number `from` on, one parsed element at a time. An element
 * that is too large or invalid comes back with `error` set. After the last complete element of a truncated file
 * the stream ends with E_PARSE (no content in the message), so a pass reports the damage after saving what it read.
 */
export async function* streamFileElements<T>(src: ExportSource, files: readonly ScannedFile[], from: number, signal?: AbortSignal): AsyncGenerator<FileElement<T>> {
  let base = 0;
  let truncated = false;
  for (const file of files) {
    const end = base + file.count;
    if (file.truncated) truncated = true;
    if (from >= end) {
      base = end;
      continue;
    }
    const pending: SkippedElement[] = [];
    const opts = {
      maxElementBytes: MAX_EXPORT_ELEMENT_BYTES,
      skip: Math.max(0, from - base),
      onSkip: (s: SkippedElement) => void pending.push(s),
      ...(signal ? { signal } : {}),
    };
    const bad = (s: SkippedElement): FileElement<T> => ({ file, unit: base + s.index, index: s.index, offset: s.offset, error: "E_PARSE" });
    try {
      for await (const el of streamJsonArrayElements<T>(await src.open(file.name), opts)) {
        for (const s of pending.splice(0)) yield bad(s);
        yield { file, unit: base + el.index, index: el.index, offset: el.offset, value: el.value };
      }
    } catch (e) {
      if (!(file.truncated && isCortexError(e) && e.code === "E_PARSE")) throw e;
    }
    for (const s of pending.splice(0)) yield bad(s);
    base = end;
  }
  if (truncated) throw new CortexError("E_PARSE", "the export file ended before its list was complete");
}

/** Epoch seconds (ChatGPT) to an ISO date; undefined for missing, zero or absurd values. */
export function isoFromEpochSeconds(v: unknown): IsoDate | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  const ms = v * 1000;
  if (ms < Date.UTC(1990, 0, 1) || ms > Date.UTC(2200, 0, 1)) return undefined;
  return new Date(ms).toISOString();
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return isRecordLike(x);
}

/** sha256 over chunks in order (for `prepare`). */
export function createChunkHash(): { update(chunk: Uint8Array): void; digest(): string } {
  const h = createHash("sha256");
  return { update: (c) => void h.update(c), digest: () => h.digest("hex") };
}

/** The text of a TextRef placeholder never leaves this module: refs are complete once a segment is written. */
export type { TextRef };
