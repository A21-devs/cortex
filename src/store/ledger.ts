/**
 * Append-only JSONL ledgers in `.vault-meta/cortex/`. Owner: E2.
 *
 * Shards roll by SIZE within a month (LEDGER-SHARD-SIZE, SAFE-07): `<ledger>/<yyyy-mm>/000001.jsonl`, closed when
 * the next batch would take it past ~8 MB and never appended again, so OneDrive uploads each closed shard once and
 * a first import of a large backlog never produces one huge, constantly re-uploaded file. Appends go to the newest
 * shard of the month under that month's lock (local cache locks); a shard whose last line was cut short by a
 * crash gets a newline first, so the torn line stays one unparseable line and never swallows the next record.
 * Readers stream shards (never readFile of a whole shard) and skip an incomplete trailing line.
 * The ledger sequence number (`state/seq.json`) increases with every committed batch so caches can tell whether
 * they are stale, and every committed batch then rewrites the cache signal (`<cache>/signal.json`) naming its
 * kind, so a plugin watching the cache rebuilds its index after an import, a label run or a fix (signal.ts). Upsert ledgers (conversations, notes, receipts) resolve by highest `seq`, ties by file order.
 *
 * Readers that must not rescan on every call use:
 *  - `LedgerTail`: incremental scanning of bytes appended since the last call (a vanished, shrunk or replaced
 *    file reports a reset);
 *  - `grepLedger`: a byte-level search for ids that parses only the lines that contain them;
 *  - `LedgerOffsets`: the entries ledger's id → shard + byte range table, persisted as `<cache>/offsets.bin`.
 * `compactLedgers` (runner command `ledger.compact`) rewrites closed months of upsert ledgers to their latest
 * records and trims the access log to Settings › Privacy › "Keep the access log".
 */
import { createReadStream, promises as fsp } from "node:fs";
import * as path from "node:path";
import { appendLines, ensureCacheDir, errCode, readJsonIfExists, readTextIfExists, withFsRetry, writeFileAtomic, writeJsonAtomic } from "../node/fsAtomic";
import { ByteLineSplitter, trimCr } from "../node/lineSplitter";
import { decodeLineBytes, encodeLineWith, writeKey } from "../node/vaultCipher";
import { heldVaultKey } from "../shared/crypto/keyring";
import { locksDirOf, withLock } from "../node/locks";
import { cacheWritablePath, resolveInVault, writablePath } from "../node/paths";
import type { CancelToken } from "../shared/cancel";
import { CortexError } from "../shared/errors";
import type { Logger } from "../shared/log";
import { nullLogger } from "../shared/log";
import type { AccessLogRetention } from "../shared/settings";
import { nowIso, parseIso, shardMonth } from "../shared/time";
import type {
  ConversationRecord,
  CorrectionRecord,
  EntryRecord,
  LabelRecord,
  NoteRecord,
  ReadRecord,
  ReceiptRecord,
  ReviewCardRecord,
  RunRecord,
  VaultPath,
} from "../shared/types";
import {
  CACHE_REL,
  cacheLayout,
  CORTEX_PATHS,
  correctionsPath,
  ledgerDir,
  ledgerMonthDir,
  ledgerShardPath,
  LEDGERS,
  MONTH_DIR_RE,
  SEGMENT_FILE_RE,
  seqPath,
  SHARD_FILE_RE,
  SHARD_ROLL_BYTES,
  type LedgerName,
  type StoreContext,
} from "./layout";
import { writeSignal, type SignalKind } from "./signal";

export interface LedgerRecordMap {
  entries: EntryRecord;
  conversations: ConversationRecord;
  notes: NoteRecord;
  labels: LabelRecord;
  runs: RunRecord;
  reads: ReadRecord;
  review: ReviewCardRecord;
  receipts: ReceiptRecord;
}

/** Ledgers whose records are upserts: the record with the highest `seq` for an id wins. */
export const UPSERT_LEDGERS: readonly LedgerName[] = ["conversations", "notes", "receipts"];

/** Which timestamp decides a record's month. */
function shardTimestamp(ledger: LedgerName, rec: unknown): string | undefined {
  const r = rec as Record<string, unknown>;
  switch (ledger) {
    case "entries":
      return r.addedAt as string | undefined;
    case "conversations":
      return r.updatedAt as string | undefined;
    case "notes": {
      const mb = r.madeBy as Record<string, unknown> | undefined;
      return (mb && typeof mb.at === "string" ? mb.at : undefined) ?? (r.date as string | undefined);
    }
    case "labels":
    case "reads":
    case "receipts":
      return r.at as string | undefined;
    case "runs":
      return r.startedAt as string | undefined;
    case "review":
      return r.createdAt as string | undefined;
    default:
      return undefined;
  }
}

/**
 * The month folder ("YYYY-MM", UTC) a record is filed under. A record without a valid timestamp (a legacy note,
 * a writer bug) is filed under the current month so it stays readable.
 */
export function shardOf<L extends LedgerName>(ledger: L, rec: LedgerRecordMap[L], now: number = Date.now()): string {
  const iso = shardTimestamp(ledger, rec);
  const t = typeof iso === "string" ? parseIso(iso) : Number.NaN;
  const month = Number.isFinite(t) ? shardMonth(new Date(t).toISOString()) : shardMonth(new Date(now).toISOString());
  return MONTH_DIR_RE.test(month) ? month : shardMonth(new Date(now).toISOString());
}

export interface ShardRead<T> {
  records: T[];
  /** "<file>:<line>" of lines that failed to parse. */
  bad: string[];
}

/** Where one ledger line lives: `[start, end)` bytes of `file`, `end` just after its "\n". */
export interface LineLoc {
  file: VaultPath;
  start: number;
  end: number;
}

const decoder = new TextDecoder();

/** Stream one JSONL file as parsed records (bad lines reported, an incomplete last line ignored). */
export async function* streamJsonl<T>(abs: string, bad: string[] = []): AsyncGenerator<T> {
  let stream;
  try {
    await fsp.access(abs);
    stream = createReadStream(abs, { highWaterMark: 1 << 16 });
  } catch {
    return;
  }
  const splitter = new ByteLineSplitter(0);
  let lineNo = 0;
  const out: T[] = [];
  try {
    for await (const chunk of stream) {
      splitter.push(chunk as Buffer, (line) => {
        lineNo++;
        const raw = trimCr(line.bytes);
        if (raw.length === 0) return;
        const bytes = decodeLineBytes(raw);
        if (bytes === null) {
          // An encrypted line: absent while the record is locked, damaged when a key is held and it still does not open.
          if (heldVaultKey()) bad.push(`${path.basename(abs)}:${lineNo}`);
          return;
        }
        try {
          out.push(JSON.parse(decoder.decode(bytes)) as T);
        } catch {
          bad.push(`${path.basename(abs)}:${lineNo}`);
        }
      });
      while (out.length > 0) yield out.shift() as T;
    }
  } finally {
    stream.destroy();
  }
}

// ───────────────────────────── files ─────────────────────────────

export interface LedgerFile {
  month: string;
  /** Vault path of the shard (or of corrections.jsonl). */
  file: VaultPath;
  abs: string;
}

async function readdirSafe(abs: string): Promise<string[]> {
  try {
    return await fsp.readdir(abs);
  } catch (e) {
    if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return [];
    throw e;
  }
}

/** Month keys present for a ledger, ascending. */
export async function ledgerMonths(vaultRoot: string, ledger: LedgerName): Promise<string[]> {
  return (await readdirSafe(resolveInVault(vaultRoot, ledgerDir(ledger)))).filter((n) => MONTH_DIR_RE.test(n)).sort();
}

/** Shard numbers of a month, ascending (OneDrive conflict copies such as "000001-PC.jsonl" are ignored). */
async function shardNumbers(vaultRoot: string, ledger: LedgerName, month: string): Promise<number[]> {
  const names = await readdirSafe(resolveInVault(vaultRoot, ledgerMonthDir(ledger, month)));
  const out: number[] = [];
  for (const n of names) {
    const m = SHARD_FILE_RE.exec(n);
    if (m) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
}

/** Every shard of a ledger in read order (months ascending, shards ascending), optionally only some months. */
export async function listLedgerFiles(vaultRoot: string, ledger: LedgerName | "corrections", months?: (month: string) => boolean): Promise<LedgerFile[]> {
  if (ledger === "corrections") {
    const abs = resolveInVault(vaultRoot, correctionsPath());
    try {
      await fsp.access(abs);
      return [{ month: "", file: correctionsPath(), abs }];
    } catch {
      return [];
    }
  }
  const out: LedgerFile[] = [];
  for (const month of await ledgerMonths(vaultRoot, ledger)) {
    if (months && !months(month)) continue;
    for (const n of await shardNumbers(vaultRoot, ledger, month)) {
      const file = ledgerShardPath(ledger, month, n);
      out.push({ month, file, abs: resolveInVault(vaultRoot, file) });
    }
  }
  return out;
}

/** Read one ledger line by its location and parse it (null when the bytes are gone or not JSON). */
export async function readLineAt<T>(vaultRoot: string, loc: LineLoc): Promise<T | null> {
  const len = loc.end - loc.start;
  if (!Number.isInteger(loc.start) || loc.start < 0 || len <= 0 || len > 64 * 1024 * 1024) return null;
  let fh;
  try {
    fh = await fsp.open(resolveInVault(vaultRoot, loc.file), "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, loc.start);
    let bytes: Uint8Array = buf.subarray(0, bytesRead);
    if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0a) bytes = bytes.subarray(0, bytes.length - 1);
    bytes = trimCr(bytes);
    if (bytes.length === 0) return null;
    const plain = decodeLineBytes(bytes);
    if (plain === null) return null;
    return JSON.parse(decoder.decode(plain)) as T;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

// ───────────────────────────── grep ─────────────────────────────

export interface GrepHit {
  /** The whole line (without its line break). */
  text: string;
  loc: LineLoc;
}

export interface ScanOptions {
  /** Only these months (ledger folders); corrections ignore it. */
  months?: (month: string) => boolean;
  token?: CancelToken;
  /** Cooperative yield between chunks (UI-thread callers). */
  yield?: () => Promise<void>;
}

const CHUNK = 1 << 20;
const ENCRYPTED_MARK = Buffer.from("CXE1:");

/** The slow half of grepLedger for a chunk that holds encrypted lines: every line is opened (plain lines pass) and searched. */
function grepEncryptedLines(complete: Buffer, bufStart: number, file: string, pats: readonly Buffer[]): GrepHit[] {
  const hits: GrepHit[] = [];
  let ls = 0;
  while (ls < complete.length) {
    const le = complete.indexOf(0x0a, ls);
    if (le < 0) break;
    const raw = trimCr(complete.subarray(ls, le));
    const plain = raw.length === 0 ? null : decodeLineBytes(raw);
    if (plain !== null) {
      const view = Buffer.from(plain.buffer, plain.byteOffset, plain.length);
      if (pats.some((p) => view.indexOf(p) >= 0)) hits.push({ text: decoder.decode(plain), loc: { file, start: bufStart + ls, end: bufStart + le + 1 } });
    }
    ls = le + 1;
  }
  return hits;
}

/**
 * Byte-level search: yields every complete line that contains at least one of `needles`, parsing nothing. Callers
 * parse the hits and check the field they care about (a needle may also occur inside another field).
 */
export async function* grepLedger(vaultRoot: string, ledger: LedgerName | "corrections", needles: readonly string[], opts: ScanOptions = {}): AsyncGenerator<GrepHit> {
  const pats = [...new Set(needles.filter((n) => n.length > 0))].map((n) => Buffer.from(n, "utf8"));
  if (pats.length === 0) return;
  for (const f of await listLedgerFiles(vaultRoot, ledger, opts.months)) {
    opts.token?.throwIfCancelled();
    let fh;
    try {
      fh = await fsp.open(f.abs, "r");
    } catch {
      continue; // vanished (compaction) or not on this computer
    }
    try {
      const chunk = Buffer.allocUnsafe(CHUNK);
      let carry: Buffer = Buffer.alloc(0);
      let carryStart = 0;
      let pos = 0;
      for (;;) {
        opts.token?.throwIfCancelled();
        const { bytesRead } = await fh.read(chunk, 0, CHUNK, pos);
        if (bytesRead === 0) break;
        const bufStart = carry.length > 0 ? carryStart : pos;
        const buf = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        pos += bytesRead;
        const lastNl = buf.lastIndexOf(0x0a);
        if (lastNl < 0) {
          carry = Buffer.from(buf);
          carryStart = bufStart;
          continue;
        }
        const complete = buf.subarray(0, lastNl + 1);
        if (complete.indexOf(ENCRYPTED_MARK) >= 0) {
          // Encrypted lines hide their words from a byte search: open each line, then look for the needles.
          const found = grepEncryptedLines(complete, bufStart, f.file, pats);
          carry = Buffer.from(buf.subarray(lastNl + 1));
          carryStart = bufStart + lastNl + 1;
          for (const h of found) yield h;
          await opts.yield?.();
          continue;
        }
        const lines = new Map<number, number>();
        for (const p of pats) {
          let i = complete.indexOf(p);
          while (i >= 0) {
            const ls = i === 0 ? 0 : complete.lastIndexOf(0x0a, i - 1) + 1;
            const le = complete.indexOf(0x0a, i);
            lines.set(ls, le);
            i = complete.indexOf(p, le + 1);
          }
        }
        const hits = [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([ls, le]) => ({ text: decoder.decode(trimCr(complete.subarray(ls, le))), loc: { file: f.file, start: bufStart + ls, end: bufStart + le + 1 } }));
        carry = Buffer.from(buf.subarray(lastNl + 1));
        carryStart = bufStart + lastNl + 1;
        for (const h of hits) yield h;
        await opts.yield?.();
      }
    } finally {
      await fh.close();
    }
  }
}

/** Parse grep hits as records, keeping those `keep` accepts (bad lines are skipped). */
export async function grepRecords<T>(vaultRoot: string, ledger: LedgerName | "corrections", needles: readonly string[], keep: (rec: T) => boolean, opts: ScanOptions = {}): Promise<{ record: T; loc: LineLoc }[]> {
  const out: { record: T; loc: LineLoc }[] = [];
  for await (const hit of grepLedger(vaultRoot, ledger, needles, opts)) {
    let rec: T;
    try {
      rec = JSON.parse(hit.text) as T;
    } catch {
      continue;
    }
    if (rec !== null && typeof rec === "object" && keep(rec)) out.push({ record: rec, loc: hit.loc });
  }
  return out;
}

/** Latest record per id among upsert records (highest seq; ties go to the later line). */
export function latestBySeq<T extends { id: string; seq?: number }>(records: Iterable<T>): Map<string, T> {
  const out = new Map<string, T>();
  for (const r of records) {
    const prev = out.get(r.id);
    if (!prev || (r.seq ?? 0) >= (prev.seq ?? 0)) out.set(r.id, r);
  }
  return out;
}

// ───────────────────────────── incremental tail ─────────────────────────────

export interface TailLine {
  /** Line bytes without the line break. Valid only during the callback (the buffer is reused). */
  bytes: Uint8Array;
  loc: LineLoc;
}

export interface TailFileState {
  file: VaultPath;
  /** Bytes consumed (always at a line start). */
  scanned: number;
  /** File identity; a replaced file (atomic rename, OneDrive download) gets a new one. */
  ino: string | null;
}

/**
 * Incremental reader of one ledger (or corrections.jsonl): `update` delivers only lines appended since the last
 * call. When a known file vanished, shrank or was replaced, `update` returns `reset: true` without delivering
 * anything: the caller drops what it folded and calls `update` again (which then starts from zero).
 */
export class LedgerTail {
  private files = new Map<VaultPath, TailFileState>();

  constructor(
    private readonly vaultRoot: string,
    readonly ledger: LedgerName | "corrections",
  ) {}

  reset(): void {
    this.files.clear();
  }

  snapshot(): TailFileState[] {
    return [...this.files.values()].map((f) => ({ ...f }));
  }

  restore(state: readonly TailFileState[]): void {
    this.files = new Map(state.map((f) => [f.file, { ...f }]));
  }

  async update(onLine: (line: TailLine) => void, opts: ScanOptions = {}): Promise<{ reset: boolean; lines: number }> {
    const current = await listLedgerFiles(this.vaultRoot, this.ledger);
    const present = new Set(current.map((f) => f.file));
    for (const known of this.files.keys()) {
      if (!present.has(known)) {
        this.files.clear();
        return { reset: true, lines: 0 };
      }
    }
    const stats: { f: LedgerFile; size: number; ino: string | null }[] = [];
    for (const f of current) {
      let st;
      try {
        st = await fsp.stat(f.abs, { bigint: true });
      } catch {
        this.files.clear();
        return { reset: true, lines: 0 };
      }
      const ino = st.ino === 0n ? null : String(st.ino);
      const size = Number(st.size);
      const prev = this.files.get(f.file);
      if (prev && (size < prev.scanned || (prev.ino !== null && ino !== null && prev.ino !== ino))) {
        this.files.clear();
        return { reset: true, lines: 0 };
      }
      stats.push({ f, size, ino });
    }
    let lines = 0;
    const buf = Buffer.allocUnsafe(CHUNK);
    for (const { f, size, ino } of stats) {
      const prev = this.files.get(f.file) ?? { file: f.file, scanned: 0, ino };
      if (size <= prev.scanned) {
        this.files.set(f.file, { ...prev, ino: prev.ino ?? ino });
        continue;
      }
      let fh;
      try {
        fh = await fsp.open(f.abs, "r");
      } catch {
        this.files.clear();
        return { reset: true, lines: 0 };
      }
      const splitter = new ByteLineSplitter(prev.scanned);
      try {
        let pos = prev.scanned;
        while (pos < size) {
          opts.token?.throwIfCancelled();
          const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - pos), pos);
          if (bytesRead === 0) break;
          splitter.push(buf.subarray(0, bytesRead), (line) => {
            const raw = trimCr(line.bytes);
            if (raw.length === 0) return;
            const bytes = decodeLineBytes(raw);
            if (bytes === null) return; // an encrypted line while locked (or damaged): not part of the record this process can see
            lines++;
            onLine({ bytes, loc: { file: f.file, start: line.start, end: line.end } });
          });
          pos += bytesRead;
          await opts.yield?.();
        }
      } finally {
        await fh.close();
      }
      this.files.set(f.file, { file: f.file, scanned: splitter.consumed, ino });
    }
    return { reset: false, lines };
  }
}

/** Parse a tail line (null for a torn or foreign line). */
export function parseTailLine<T>(line: TailLine): T | null {
  try {
    const v = JSON.parse(decoder.decode(line.bytes)) as unknown;
    return v !== null && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
}

// ───────────────────────────── the store ─────────────────────────────

export interface LedgerStore {
  /** Append records (grouped per month, each month under its lock, shards rolled by size). Returns the new seq. */
  append<L extends LedgerName>(ledger: L, records: readonly LedgerRecordMap[L][]): Promise<number>;
  readShard<L extends LedgerName>(ledger: L, month: string): Promise<ShardRead<LedgerRecordMap[L]>>;
  /** Month keys present for a ledger, ascending. */
  months(ledger: LedgerName): Promise<string[]>;
  /** Shard files of a month, ascending (closed shards first). */
  shards(ledger: LedgerName, month: string): Promise<string[]>;
  /** Stream every record of a ledger, oldest shard first. */
  readAll<L extends LedgerName>(ledger: L): AsyncIterable<LedgerRecordMap[L]>;
  /** Which of `ids` already have a record (`id` field) in a ledger; `months` narrows the search. */
  has(ledger: LedgerName, ids: readonly string[], opts?: ScanOptions): Promise<Set<string>>;
  appendCorrections(records: readonly CorrectionRecord[]): Promise<number>;
  /**
   * SAFE-13: build corrections from the log as it is under the corrections lock (e.g. assign an edit's version
   * as max existing + 1) and append them before the lock is released. Returns the appended records and seq.
   */
  appendCorrectionsWith(build: (existing: readonly CorrectionRecord[]) => readonly CorrectionRecord[] | Promise<readonly CorrectionRecord[]>): Promise<{ records: CorrectionRecord[]; seq: number }>;
  readCorrections(): Promise<CorrectionRecord[]>;
  /** Current ledger sequence (0 when nothing was ever written). */
  seq(): Promise<number>;
}

async function fileSize(abs: string): Promise<number> {
  try {
    return (await fsp.stat(abs)).size;
  } catch (e) {
    if (errCode(e) === "ENOENT") return 0;
    throw e;
  }
}

/** True when the file is missing, empty or ends with "\n" (safe to append whole lines to). */
export async function endsWithNewline(abs: string): Promise<boolean> {
  let fh;
  try {
    fh = await fsp.open(abs, "r");
  } catch (e) {
    if (errCode(e) === "ENOENT") return true;
    throw e;
  }
  try {
    const st = await fh.stat();
    if (st.size === 0) return true;
    const b = Buffer.alloc(1);
    await fh.read(b, 0, 1, st.size - 1);
    return b[0] === 0x0a;
  } finally {
    await fh.close();
  }
}

function serialise(records: readonly unknown[]): string[] {
  return records.map((r) => {
    const line = JSON.stringify(r);
    if (typeof line !== "string") throw new CortexError("E_INTERNAL", "ledger record is not JSON-serialisable");
    return line;
  });
}

async function readSeqFile(vaultRoot: string, log: Logger): Promise<number | null> {
  try {
    const s = await readJsonIfExists<{ seq?: unknown }>(resolveInVault(vaultRoot, seqPath()));
    if (s === null) return 0;
    if (typeof s.seq === "number" && Number.isSafeInteger(s.seq) && s.seq >= 0) return s.seq;
    log.warn("ledger seq file has no valid seq");
    return null;
  } catch {
    log.warn("ledger seq file is unreadable");
    return null;
  }
}

/** The signal kind each ledger's commits announce (conversation records are part of the record index). */
const LEDGER_SIGNAL: Readonly<Record<LedgerName, SignalKind>> = {
  entries: "entries",
  conversations: "entries",
  notes: "notes",
  labels: "labels",
  runs: "runs",
  reads: "reads",
  review: "review",
  receipts: "receipts",
};

export function createLedgerStore(ctx: StoreContext): LedgerStore {
  const locksDir = locksDirOf(ctx.cacheDir);
  const lockOpts = { owner: ctx.owner, staleMs: ctx.lockStaleMs };
  const log = ctx.log ?? nullLogger;

  async function bumpSeq(): Promise<number> {
    return withLock(locksDir, "state:seq", lockOpts, async () => {
      const abs = writablePath(ctx.vaultRoot, seqPath());
      // An unreadable seq restarts above any plausible earlier value, so the sequence never goes backwards.
      const cur = (await readSeqFile(ctx.vaultRoot, log)) ?? Date.now();
      const next = cur + 1;
      await writeJsonAtomic(abs, { seq: next, at: nowIso() });
      return next;
    });
  }

  /** Append whole lines to the month's newest shard, rolling to a new shard before one would pass the limit. */
  async function appendMonth(ledger: LedgerName, month: string, lines: readonly string[]): Promise<void> {
    await withLock(locksDir, `ledger:${ledger}/${month}`, lockOpts, async () => {
      const nums = await shardNumbers(ctx.vaultRoot, ledger, month);
      let n = nums.length > 0 ? (nums[nums.length - 1] as number) : 1;
      let abs = writablePath(ctx.vaultRoot, ledgerShardPath(ledger, month, n));
      let size = await fileSize(abs);
      if (size > 0 && !(await endsWithNewline(abs))) {
        await appendLines(abs, "\n"); // a torn line from a crash stays one bad line of its own
        size += 1;
      }
      let batch = "";
      let batchBytes = 0;
      const key = writeKey();
      for (const plainLine of lines) {
        const line = encodeLineWith(key, plainLine);
        const text = `${line}\n`;
        const bytes = Buffer.byteLength(text, "utf8");
        if (size + batchBytes > 0 && size + batchBytes + bytes > SHARD_ROLL_BYTES) {
          if (batchBytes > 0) await appendLines(abs, batch);
          n++;
          abs = writablePath(ctx.vaultRoot, ledgerShardPath(ledger, month, n));
          size = await fileSize(abs);
          batch = "";
          batchBytes = 0;
        }
        batch += text;
        batchBytes += bytes;
      }
      if (batchBytes > 0) await appendLines(abs, batch);
    });
  }

  async function appendCorrectionLines(lines: readonly string[]): Promise<void> {
    const abs = writablePath(ctx.vaultRoot, correctionsPath());
    if (!(await endsWithNewline(abs))) await appendLines(abs, "\n");
    if (lines.length > 0) {
      const key = writeKey();
      await appendLines(abs, lines.map((l) => `${encodeLineWith(key, l)}\n`).join(""));
    }
  }

  async function readCorrectionsFile(): Promise<CorrectionRecord[]> {
    const out: CorrectionRecord[] = [];
    for await (const r of streamJsonl<CorrectionRecord>(resolveInVault(ctx.vaultRoot, correctionsPath()))) {
      if (r !== null && typeof r === "object") out.push(r);
    }
    return out;
  }

  /**
   * Tell watchers what a committed batch changed. Before this, nothing but index and search builds wrote the
   * signal, so imports never reached an open view's index. A failed signal never fails the commit: the plugin's
   * stale check also compares the signal's seq with the ledger's.
   */
  async function signalCommit(kind: SignalKind, seq: number): Promise<void> {
    try {
      await writeSignal(ctx.cacheDir, { seq, changed: [kind], by: ctx.owner });
    } catch (e) {
      log.warn("the cache signal could not be written", { error: errCode(e) ?? "unknown" });
    }
  }

  const store: LedgerStore = {
    async append(ledger, records) {
      if (records.length === 0) return store.seq();
      writeKey(); // an encrypted record that is locked takes no new lines (E_LOCKED) before anything is written
      const now = Date.now();
      const byMonth = new Map<string, unknown[]>();
      for (const r of records) {
        const m = shardOf(ledger, r, now);
        const list = byMonth.get(m) ?? [];
        list.push(r);
        byMonth.set(m, list);
      }
      for (const month of [...byMonth.keys()].sort()) await appendMonth(ledger, month, serialise(byMonth.get(month) ?? []));
      const seq = await bumpSeq();
      await signalCommit(LEDGER_SIGNAL[ledger], seq);
      return seq;
    },
    async readShard(ledger, month) {
      const records: LedgerRecordMap[typeof ledger][] = [];
      const bad: string[] = [];
      for (const f of await listLedgerFiles(ctx.vaultRoot, ledger, (m) => m === month)) {
        for await (const r of streamJsonl<LedgerRecordMap[typeof ledger]>(f.abs, bad)) records.push(r);
      }
      return { records, bad };
    },
    months: (ledger) => ledgerMonths(ctx.vaultRoot, ledger),
    async shards(ledger, month) {
      return (await shardNumbers(ctx.vaultRoot, ledger, month)).map((n) => `${String(n).padStart(6, "0")}.jsonl`);
    },
    async *readAll(ledger) {
      for (const f of await listLedgerFiles(ctx.vaultRoot, ledger)) yield* streamJsonl<LedgerRecordMap[typeof ledger]>(f.abs);
    },
    async has(ledger, ids, opts = {}) {
      const want = new Set(ids);
      const found = new Set<string>();
      if (want.size === 0) return found;
      const hits = await grepRecords<{ id?: unknown }>(ctx.vaultRoot, ledger, [...want], (r) => typeof r.id === "string" && want.has(r.id), opts);
      for (const h of hits) found.add(h.record.id as string);
      return found;
    },
    async appendCorrections(records) {
      if (records.length === 0) return store.seq();
      writeKey();
      const lines = serialise(records);
      await withLock(locksDir, "ledger:corrections", lockOpts, () => appendCorrectionLines(lines));
      const seq = await bumpSeq();
      await signalCommit("corrections", seq);
      return seq;
    },
    async appendCorrectionsWith(build) {
      const appended = await withLock(locksDir, "ledger:corrections", lockOpts, async () => {
        const recs = [...(await build(await readCorrectionsFile()))];
        if (recs.length > 0) await appendCorrectionLines(serialise(recs));
        return recs;
      });
      if (appended.length === 0) return { records: appended, seq: await store.seq() };
      const seq = await bumpSeq();
      await signalCommit("corrections", seq);
      return { records: appended, seq };
    },
    readCorrections: readCorrectionsFile,
    async seq() {
      return (await readSeqFile(ctx.vaultRoot, log)) ?? 0;
    },
  };
  return store;
}

/** Read the ledger sequence without a StoreContext (plugin readers). 0 when missing or unreadable. */
export async function readLedgerSeq(vaultRoot: string): Promise<number> {
  return (await readSeqFile(vaultRoot, nullLogger)) ?? 0;
}

// ───────────────────────────── entries offsets (`<cache>/offsets.bin`) ─────────────────────────────

const OFFSETS_MAGIC = "CXF1";
const OFFSETS_VERSION = 1;
const ENTRY_ID_LEN = 18;
const ENTRY_ID_RE = /^e_[a-z2-7]{16}$/;
const ID_KEY = Buffer.from('"id":"', "latin1");

interface OffsetsHeader {
  magic: typeof OFFSETS_MAGIC;
  v: typeof OFFSETS_VERSION;
  ledger: "entries";
  builtAt: string;
  count: number;
  /** Shard table: the `file` column indexes into it; `scanned`/`ino` resume the tail. */
  files: TailFileState[];
}

/** The entry id of a ledger line without JSON.parse when `id` is the first key after `v` (how Cortex writes). */
function quickEntryId(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.length, 96));
  const i = head.indexOf(ID_KEY);
  if (i < 0 || head.length < i + ID_KEY.length + ENTRY_ID_LEN + 1) return null;
  for (let k = 1; k < i; k++) if (head[k] === 0x7b || head[k] === 0x5b) return null; // nested object or array first
  const s = i + ID_KEY.length;
  if (head[s + ENTRY_ID_LEN] !== 0x22) return null;
  const id = head.toString("latin1", s, s + ENTRY_ID_LEN);
  return ENTRY_ID_RE.test(id) ? id : null;
}

function entryIdOfLine(bytes: Uint8Array): string | null {
  const quick = quickEntryId(bytes);
  if (quick !== null) return quick;
  try {
    const rec = JSON.parse(decoder.decode(bytes)) as { id?: unknown };
    return typeof rec.id === "string" && ENTRY_ID_RE.test(rec.id) ? rec.id : null;
  } catch {
    return null;
  }
}

function compareIdAt(ids: Uint8Array, row: number, key: Uint8Array): number {
  const o = row * ENTRY_ID_LEN;
  for (let k = 0; k < ENTRY_ID_LEN; k++) {
    const d = (ids[o + k] as number) - (key[k] as number);
    if (d !== 0) return d;
  }
  return 0;
}

const align = (n: number, a: number) => Math.ceil(n / a) * a;

/**
 * id → (shard, byte range) for the entries ledger, so opening a reader reads ONE line. A sorted, persisted base
 * (binary search over fixed-width ids) plus the entries appended since, scanned incrementally. Duplicate ids
 * (a re-appended batch after a crash) resolve to their first line: entry records are immutable.
 */
export class LedgerOffsets {
  private fileTable: VaultPath[] = [];
  private fileIndex = new Map<VaultPath, number>();
  private ids = new Uint8Array(0);
  private fileCol = new Uint16Array(0);
  private startCol = new Uint32Array(0);
  private lenCol = new Uint32Array(0);
  private baseCount = 0;
  private extra = new Map<string, { f: number; s: number; l: number }>();
  private readonly tail: LedgerTail;
  private dirtySincePersist = 0;

  private constructor(
    private readonly vaultRoot: string,
    private readonly cacheDir: string,
    private readonly log: Logger,
  ) {
    this.tail = new LedgerTail(vaultRoot, "entries");
  }

  /** Load `<cache>/offsets.bin` when valid, then scan whatever was appended since. */
  static async open(args: { vaultRoot: string; cacheDir: string; log?: Logger }, opts: ScanOptions = {}): Promise<LedgerOffsets> {
    const o = new LedgerOffsets(args.vaultRoot, args.cacheDir, args.log ?? nullLogger);
    await o.load();
    await o.update(opts);
    return o;
  }

  get size(): number {
    return this.baseCount + this.extra.size;
  }

  /** Lines indexed since the last persist (callers persist when this grows large). */
  get pending(): number {
    return this.dirtySincePersist;
  }

  private fileId(file: VaultPath): number {
    let i = this.fileIndex.get(file);
    if (i === undefined) {
      i = this.fileTable.length;
      if (i >= 0xffff) throw new CortexError("E_INTERNAL", "too many ledger shards for the offsets table");
      this.fileTable.push(file);
      this.fileIndex.set(file, i);
    }
    return i;
  }

  private clear(): void {
    this.fileTable = [];
    this.fileIndex.clear();
    this.ids = new Uint8Array(0);
    this.fileCol = new Uint16Array(0);
    this.startCol = new Uint32Array(0);
    this.lenCol = new Uint32Array(0);
    this.baseCount = 0;
    this.extra.clear();
    this.tail.reset();
  }

  private baseRow(id: string): number {
    const key = Buffer.from(id, "latin1");
    let lo = 0;
    let hi = this.baseCount - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = compareIdAt(this.ids, mid, key);
      if (c === 0) return mid;
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /** Scan entries appended since the last call; a rewritten ledger rebuilds the table from zero. */
  async update(opts: ScanOptions = {}): Promise<void> {
    const onLine = (line: TailLine) => {
      const id = entryIdOfLine(line.bytes);
      if (id === null || this.baseRow(id) >= 0 || this.extra.has(id)) return;
      this.extra.set(id, { f: this.fileId(line.loc.file), s: line.loc.start, l: line.loc.end - line.loc.start });
      this.dirtySincePersist++;
    };
    let r = await this.tail.update(onLine, opts);
    if (r.reset) {
      this.log.info("entries ledger changed underneath the offsets table; rebuilding");
      this.clear();
      r = await this.tail.update(onLine, opts);
    }
  }

  locate(id: string): LineLoc | null {
    if (!ENTRY_ID_RE.test(id)) return null;
    const row = this.baseRow(id);
    if (row >= 0) {
      const file = this.fileTable[this.fileCol[row] as number];
      if (file === undefined) return null;
      const start = this.startCol[row] as number;
      return { file, start, end: start + (this.lenCol[row] as number) };
    }
    const x = this.extra.get(id);
    if (!x) return null;
    const file = this.fileTable[x.f];
    return file === undefined ? null : { file, start: x.s, end: x.s + x.l };
  }

  /** The entry's ledger record, or null when unknown (or when the table is stale for it). */
  async read(id: string): Promise<EntryRecord | null> {
    const loc = this.locate(id);
    if (!loc) return null;
    const rec = await readLineAt<EntryRecord>(this.vaultRoot, loc);
    return rec && rec.id === id ? rec : null;
  }

  private async load(): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(cacheLayout(this.cacheDir).offsets);
    } catch {
      return;
    }
    try {
      if (bytes.length < 8 || bytes.toString("latin1", 0, 4) !== OFFSETS_MAGIC) throw new Error("magic");
      const hl = bytes.readUInt32LE(4);
      const header = JSON.parse(bytes.toString("utf8", 8, 8 + hl)) as OffsetsHeader;
      if (header.v !== OFFSETS_VERSION || header.ledger !== "entries" || !Array.isArray(header.files) || !Number.isInteger(header.count)) throw new Error("header");
      const n = header.count;
      let off = align(8 + hl, 8);
      const need = align(off + n * ENTRY_ID_LEN, 4) + align(n * 2, 4) + n * 8;
      if (bytes.length < need) throw new Error("truncated");
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer;
      this.ids = new Uint8Array(ab, off, n * ENTRY_ID_LEN);
      off = align(off + n * ENTRY_ID_LEN, 4);
      this.fileCol = new Uint16Array(ab, off, n);
      off = align(off + n * 2, 4);
      this.startCol = new Uint32Array(ab, off, n);
      off += n * 4;
      this.lenCol = new Uint32Array(ab, off, n);
      this.baseCount = n;
      this.fileTable = header.files.map((f) => f.file);
      this.fileIndex = new Map(this.fileTable.map((f, i) => [f, i]));
      this.tail.restore(header.files);
    } catch {
      this.log.warn("offsets table unreadable; rebuilding from the ledger");
      this.clear();
    }
  }

  /** Write the merged table to `<cache>/offsets.bin` (atomic replace under the cache lock). */
  async persist(owner: string): Promise<void> {
    await ensureCacheDir(this.cacheDir);
    const rows: { id: string; f: number; s: number; l: number }[] = [];
    for (let r = 0; r < this.baseCount; r++) {
      rows.push({ id: Buffer.from(this.ids.subarray(r * ENTRY_ID_LEN, (r + 1) * ENTRY_ID_LEN)).toString("latin1"), f: this.fileCol[r] as number, s: this.startCol[r] as number, l: this.lenCol[r] as number });
    }
    for (const [id, x] of this.extra) rows.push({ id, ...x });
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const files = this.tail.snapshot();
    const tailIndex = new Map(files.map((f) => [f.file, f]));
    const header: OffsetsHeader = {
      magic: OFFSETS_MAGIC,
      v: OFFSETS_VERSION,
      ledger: "entries",
      builtAt: nowIso(),
      count: rows.length,
      files: this.fileTable.map((file) => tailIndex.get(file) ?? { file, scanned: 0, ino: null }),
    };
    // Files the tail knows but no row references still carry their scan position.
    for (const f of files) if (!this.fileIndex.has(f.file)) header.files.push(f);
    const hb = Buffer.from(JSON.stringify(header), "utf8");
    const n = rows.length;
    let off = align(8 + hb.length, 8);
    const idOff = off;
    off = align(off + n * ENTRY_ID_LEN, 4);
    const fileOff = off;
    off = align(off + n * 2, 4);
    const startOff = off;
    off += n * 4;
    const lenOff = off;
    off += n * 4;
    const out = Buffer.alloc(off);
    out.write(OFFSETS_MAGIC, 0, "latin1");
    out.writeUInt32LE(hb.length, 4);
    hb.copy(out, 8);
    const fileCol = new Uint16Array(out.buffer, out.byteOffset + fileOff, n);
    const startCol = new Uint32Array(out.buffer, out.byteOffset + startOff, n);
    const lenCol = new Uint32Array(out.buffer, out.byteOffset + lenOff, n);
    rows.forEach((r, i) => {
      out.write(r.id, idOff + i * ENTRY_ID_LEN, "latin1");
      fileCol[i] = r.f;
      startCol[i] = r.s;
      lenCol[i] = r.l;
    });
    await withLock(locksDirOf(this.cacheDir), "cache:offsets", { owner }, () => writeFileAtomic(cacheWritablePath(this.cacheDir, CACHE_REL.offsets), out));
    this.dirtySincePersist = 0;
  }
}

/** Build or refresh `<cache>/offsets.bin` (runner after an import; the plugin's reader also keeps it fresh). */
export async function buildEntryOffsets(ctx: Pick<StoreContext, "vaultRoot" | "cacheDir" | "owner" | "log">, opts: ScanOptions = {}): Promise<{ entries: number }> {
  const o = await LedgerOffsets.open(ctx, opts);
  await o.persist(ctx.owner);
  return { entries: o.size };
}

// ───────────────────────────── OneDrive conflict copies ─────────────────────────────

const STATE_FILES = ["seq", "budget", "control", "colours"];

/**
 * OneDrive conflict copies of Cortex's own files ("000001-LAPTOP.jsonl", "control-LAPTOP.json" …). They are
 * never merged; Sources › Needs attention lists them. Segment folders are scanned only on request (many folders).
 */
export async function findConflictCopies(vaultRoot: string, opts: { segments?: boolean } = {}): Promise<VaultPath[]> {
  const out: VaultPath[] = [];
  const meta = CORTEX_PATHS.meta;
  for (const n of await readdirSafe(resolveInVault(vaultRoot, meta))) {
    if (/^corrections-.+\.jsonl$/i.test(n) || /^(sources|views)-.+\.json$/i.test(n)) out.push(`${meta}/${n}`);
  }
  for (const n of await readdirSafe(resolveInVault(vaultRoot, `${meta}/state`))) {
    if (STATE_FILES.some((s) => new RegExp(`^${s}-.+\\.json$`, "i").test(n))) out.push(`${meta}/state/${n}`);
  }
  for (const ledger of LEDGERS) {
    for (const month of await ledgerMonths(vaultRoot, ledger)) {
      for (const n of await readdirSafe(resolveInVault(vaultRoot, ledgerMonthDir(ledger, month)))) {
        if (/^\d{6}-.+\.jsonl$/i.test(n)) out.push(`${ledgerMonthDir(ledger, month)}/${n}`);
      }
    }
  }
  if (opts.segments) {
    const chats = CORTEX_PATHS.chats;
    for (const source of await readdirSafe(resolveInVault(vaultRoot, chats))) {
      if (source.startsWith(".")) continue;
      for (const month of await readdirSafe(resolveInVault(vaultRoot, `${chats}/${source}`))) {
        if (!MONTH_DIR_RE.test(month)) continue;
        for (const conv of await readdirSafe(resolveInVault(vaultRoot, `${chats}/${source}/${month}`))) {
          if (!/^c_[a-z2-7]{16}$/.test(conv)) continue;
          for (const n of await readdirSafe(resolveInVault(vaultRoot, `${chats}/${source}/${month}/${conv}`))) {
            if (/^\d{4}-.+\.jsonl\.gz$/i.test(n) && !SEGMENT_FILE_RE.test(n)) out.push(`${chats}/${source}/${month}/${conv}/${n}`);
          }
        }
      }
    }
  }
  return out.sort();
}

// ───────────────────────────── compaction (`ledger.compact`) ─────────────────────────────

export interface CompactResult {
  files: number;
  bytesBefore: number;
  bytesAfter: number;
}

const RETENTION_DAYS: Record<AccessLogRetention, number | null> = { forever: null, "1y": 365, "90d": 90 };

/**
 * Explicit maintenance (runner `ledger.compact`, CLI `compact`):
 *  - closed months (before the current UTC month, or exactly `month`) of the upsert ledgers and of `runs` are
 *    rewritten to their latest record per id, in their original order, re-rolled at 8 MB;
 *  - the access log (`reads`) keeps only records inside `accessLogRetention` (whole months older than the
 *    cutoff are removed; the month containing the cutoff is rewritten).
 * Entries, labels, review cards and corrections are never touched. Each month is rewritten under its ledger
 * lock, so appends wait; readers see either the old or the new shards and resolve upserts by seq either way.
 */
export async function compactLedgers(ctx: StoreContext, opts: { month?: string; accessLogRetention?: AccessLogRetention; now?: number; token?: CancelToken } = {}): Promise<CompactResult> {
  const now = opts.now ?? Date.now();
  const currentMonth = shardMonth(new Date(now).toISOString());
  if (opts.month !== undefined && !MONTH_DIR_RE.test(opts.month)) throw new CortexError("E_BAD_REQUEST", "month must be YYYY-MM");
  const result: CompactResult = { files: 0, bytesBefore: 0, bytesAfter: 0 };
  const locksDir = locksDirOf(ctx.cacheDir);
  const lockOpts = { owner: ctx.owner, staleMs: ctx.lockStaleMs };

  async function rewriteMonth(ledger: LedgerName, month: string, select: (records: { rec: Record<string, unknown>; line: string }[]) => string[]): Promise<void> {
    await withLock(locksDir, `ledger:${ledger}/${month}`, lockOpts, async () => {
      opts.token?.throwIfCancelled();
      const files = await listLedgerFiles(ctx.vaultRoot, ledger, (m) => m === month);
      if (files.length === 0) return;
      const records: { rec: Record<string, unknown>; line: string }[] = [];
      let before = 0;
      let bad = 0;
      for (const f of files) {
        before += await fileSize(f.abs);
        const text = (await readTextIfExists(f.abs)) ?? "";
        for (const raw of text.split("\n")) {
          const rawLine = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          if (rawLine.trim().length === 0) continue;
          const opened = decodeLineBytes(Buffer.from(rawLine, "utf8"));
          if (opened === null) throw new CortexError("E_LOCKED", "the record is locked: compaction needs the key", { detail: { reason: "record-locked" } });
          const line = Buffer.from(opened).toString("utf8");
          try {
            const rec = JSON.parse(line) as unknown;
            if (rec !== null && typeof rec === "object") records.push({ rec: rec as Record<string, unknown>, line });
            else bad++;
          } catch {
            bad++; // torn lines are dropped by the rewrite; they were never readable
          }
        }
      }
      const kept = select(records);
      if (kept.length === records.length && bad === 0) return; // nothing superseded, expired or torn
      // Re-roll the kept lines into shards 1..k, replacing each atomically, then remove the shards beyond k.
      const shards: string[] = [];
      let cur = "";
      const writeWith = writeKey();
      for (const plainLine of kept) {
        const text = `${encodeLineWith(writeWith, plainLine)}\n`;
        if (cur.length > 0 && Buffer.byteLength(cur, "utf8") + Buffer.byteLength(text, "utf8") > SHARD_ROLL_BYTES) {
          shards.push(cur);
          cur = "";
        }
        cur += text;
      }
      if (cur.length > 0) shards.push(cur);
      let after = 0;
      for (let i = 0; i < shards.length; i++) {
        const text = shards[i] as string;
        await writeFileAtomic(writablePath(ctx.vaultRoot, ledgerShardPath(ledger, month, i + 1)), text);
        after += Buffer.byteLength(text, "utf8");
      }
      for (const n of await shardNumbers(ctx.vaultRoot, ledger, month)) {
        if (n <= shards.length) continue;
        const abs = writablePath(ctx.vaultRoot, ledgerShardPath(ledger, month, n));
        await withFsRetry(() => fsp.rm(abs, { force: true }));
      }
      if (shards.length === 0) {
        await withFsRetry(() => fsp.rmdir(resolveInVault(ctx.vaultRoot, ledgerMonthDir(ledger, month)))).catch(() => undefined);
      }
      result.files += files.length;
      result.bytesBefore += before;
      result.bytesAfter += after;
    });
  }

  const latestOnly = (useSeq: boolean) => (records: { rec: Record<string, unknown>; line: string }[]) => {
    const winner = new Map<string, number>();
    records.forEach((r, i) => {
      const id = typeof r.rec.id === "string" ? r.rec.id : `#${i}`;
      const prev = winner.get(id);
      if (prev === undefined) {
        winner.set(id, i);
        return;
      }
      const prevSeq = Number((records[prev] as { rec: Record<string, unknown> }).rec.seq ?? 0);
      const seq = Number(r.rec.seq ?? 0);
      if (!useSeq || seq >= prevSeq) winner.set(id, i);
    });
    const keep = new Set(winner.values());
    return records.filter((_, i) => keep.has(i)).map((r) => r.line);
  };

  for (const ledger of [...UPSERT_LEDGERS, "runs"] as LedgerName[]) {
    for (const month of await ledgerMonths(ctx.vaultRoot, ledger)) {
      if (opts.month !== undefined ? month !== opts.month : month >= currentMonth) continue;
      await rewriteMonth(ledger, month, latestOnly(ledger !== "runs"));
    }
  }

  const days = RETENTION_DAYS[opts.accessLogRetention ?? "forever"];
  if (days !== null) {
    const cutoff = now - days * 86_400_000;
    for (const month of await ledgerMonths(ctx.vaultRoot, "reads")) {
      const [y, m] = month.split("-").map(Number) as [number, number];
      const monthEnd = Date.UTC(y, m, 1);
      const monthStart = Date.UTC(y, m - 1, 1);
      if (monthStart >= cutoff) continue;
      await rewriteMonth("reads", month, (records) =>
        monthEnd <= cutoff ? [] : records.filter((r) => {
          const t = parseIso(typeof r.rec.at === "string" ? r.rec.at : undefined);
          return !Number.isFinite(t) || t >= cutoff;
        }).map((r) => r.line),
      );
    }
  }
  return result;
}
