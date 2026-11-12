/**
 * "Encrypt my record" (and its reverse): converts the record's files in place between plain and encrypted, with a
 * dry run first, a verified backup, a check of every converted file before it replaces the original, a read-back
 * after, and a rollback of everything on any failure. What is converted (the whole record, nothing derived):
 *  - ledger shards and the corrections file: one AES-256-GCM frame per line ("CXE1:" + base64), so a shard keeps its
 *    lines (the byte offsets the index keeps still point at whole lines) and appends stay appends;
 *  - segments (`*.jsonl.gz`) and seal blocks (`seals/<computer>/NNNNNN.json`): one file frame per file.
 * The cache (index, staged live messages, held secrets) is derived and local and is not part of the record; `.raw/`
 * source files are the person's originals and are never touched.
 *
 * Seal roots are computed from entry ids and the sha256 of each entry's plain text (kept in the segment line and
 * the ledger), never from stored bytes, so encrypting changes no root and no seal block's hash.
 *
 * Temp-folder tested only; nothing here runs unless the person starts it with the key held.
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { CortexError } from "../shared/errors";
import { looksLikeFrame } from "../shared/crypto/vaultKey";
import { errCode, withFsRetry, writeFileAtomic } from "../node/fsAtomic";
import { locksDirOf, withLock } from "../node/locks";
import { cacheWritablePath, resolveInVault, writablePath } from "../node/paths";
import { convertSigningKey } from "../node/sign";
import { decodeLineBytesWith, encodeLineBytesWith, isEncryptedLine, openFrameSync, sealFrameSync } from "../node/vaultCipher";
import { LEDGERS, SEGMENT_FILE_RE, type StoreContext } from "./layout";
import { ledgerMonths, listLedgerFiles } from "./ledger";

export type RecordFileKind = "shard" | "corrections" | "segment" | "seal";
export type Direction = "encrypt" | "decrypt";

export interface RecordFile {
  kind: RecordFileKind;
  /** Vault-relative path. */
  rel: string;
  abs: string;
  /** The lock name that guards writes to it ("" for immutable files). */
  lock: string;
}

/** A seal block, or the computer's salts file (kept with the record, so it converts with it). */
const SEAL_FILE_RE = /^(?:\d{6}|salts)\.json$/;
const BACKUPS_DIR = "backups";

async function listDir(abs: string): Promise<string[]> {
  try {
    return await fsp.readdir(abs);
  } catch {
    return [];
  }
}

async function isDir(abs: string): Promise<boolean> {
  try {
    return (await fsp.stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

/** Every file of the record, in a fixed order (segments, seal blocks, corrections, then ledger shards). */
export async function listRecordFiles(vaultRoot: string): Promise<RecordFile[]> {
  const out: RecordFile[] = [];
  // segments: .raw/chats/<source>/<month>/<conv>/NNNN.jsonl.gz
  const chats = ".raw/chats";
  for (const source of await listDir(resolveInVault(vaultRoot, chats))) {
    for (const month of await listDir(resolveInVault(vaultRoot, `${chats}/${source}`))) {
      for (const conv of await listDir(resolveInVault(vaultRoot, `${chats}/${source}/${month}`))) {
        const dir = `${chats}/${source}/${month}/${conv}`;
        for (const n of (await listDir(resolveInVault(vaultRoot, dir))).sort()) {
          if (SEGMENT_FILE_RE.test(n)) out.push({ kind: "segment", rel: `${dir}/${n}`, abs: resolveInVault(vaultRoot, `${dir}/${n}`), lock: "" });
        }
      }
    }
  }
  // seal blocks (the private chain only; public/ proofs are for outside readers and stay as they are)
  const seals = ".vault-meta/cortex/seals";
  for (const host of await listDir(resolveInVault(vaultRoot, seals))) {
    const hostDir = `${seals}/${host}`;
    if (!(await isDir(resolveInVault(vaultRoot, hostDir)))) continue;
    for (const n of (await listDir(resolveInVault(vaultRoot, hostDir))).sort()) {
      if (SEAL_FILE_RE.test(n)) out.push({ kind: "seal", rel: `${hostDir}/${n}`, abs: resolveInVault(vaultRoot, `${hostDir}/${n}`), lock: "" });
    }
  }
  for (const f of await listLedgerFiles(vaultRoot, "corrections")) out.push({ kind: "corrections", rel: f.file, abs: f.abs, lock: "ledger:corrections" });
  for (const ledger of LEDGERS) {
    for (const month of await ledgerMonths(vaultRoot, ledger)) {
      for (const f of await listLedgerFiles(vaultRoot, ledger, (m) => m === month)) out.push({ kind: "shard", rel: f.file, abs: f.abs, lock: `ledger:${ledger}/${month}` });
    }
  }
  return out;
}

// ───────────────────────────── conversion ─────────────────────────────

const NL = 0x0a;

/** Convert a shard's bytes line by line. A line already in the wanted form is kept; the end (newline or none) is kept. */
export function convertLines(bytes: Uint8Array, key: Uint8Array, dir: Direction): Uint8Array {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  const parts: Buffer[] = [];
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(NL, at);
    const end = nl < 0 ? buf.length : nl;
    const line = buf.subarray(at, end);
    if (line.length === 0) parts.push(Buffer.alloc(0));
    else if (dir === "encrypt") parts.push(isEncryptedLine(line) ? Buffer.from(line) : Buffer.from(encodeLineBytesWith(key, line)));
    else if (isEncryptedLine(line)) {
      const plain = decodeLineBytesWith(key, line);
      if (plain === null) throw new CortexError("E_PARSE", "an encrypted line did not open (wrong key or damaged)", { detail: { reason: "decrypt-failed" } });
      parts.push(Buffer.from(plain));
    } else parts.push(Buffer.from(line));
    if (nl >= 0) parts.push(Buffer.from([NL]));
    at = end + 1;
  }
  return Buffer.concat(parts);
}

/** Convert a whole-file piece (a segment, a seal block). */
export function convertFile(bytes: Uint8Array, key: Uint8Array, dir: Direction): Uint8Array {
  if (dir === "encrypt") return looksLikeFrame(bytes) ? bytes : sealFrameSync(key, bytes, "file");
  if (!looksLikeFrame(bytes)) return bytes;
  const plain = openFrameSync(key, bytes, "file");
  if (!plain) throw new CortexError("E_PARSE", "an encrypted file did not open (wrong key or damaged)", { detail: { reason: "decrypt-failed" } });
  return plain;
}

export function convertBytes(kind: RecordFileKind, bytes: Uint8Array, key: Uint8Array, dir: Direction): Uint8Array {
  return kind === "shard" || kind === "corrections" ? convertLines(bytes, key, dir) : convertFile(bytes, key, dir);
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Whether a file's bytes already are in the form `dir` produces (nothing to do). */
export function alreadyConverted(kind: RecordFileKind, bytes: Uint8Array, dir: Direction): boolean {
  if (kind === "shard" || kind === "corrections") {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
    let at = 0;
    while (at < buf.length) {
      const nl = buf.indexOf(NL, at);
      const end = nl < 0 ? buf.length : nl;
      const line = buf.subarray(at, end);
      if (line.length > 0 && isEncryptedLine(line) !== (dir === "encrypt")) return false;
      at = end + 1;
    }
    return true;
  }
  return looksLikeFrame(bytes) === (dir === "encrypt");
}

// ───────────────────────────── plan (dry run) ─────────────────────────────

export interface KindCount {
  files: number;
  bytes: number;
  /** Files that are already in the wanted form. */
  done: number;
}

export interface RecordPlan {
  direction: Direction;
  files: number;
  bytes: number;
  /** Files the run would convert. */
  toConvert: number;
  byKind: Record<RecordFileKind, KindCount>;
  /** Files that could not be read (the run would stop on them). */
  unreadable: string[];
}

const emptyKinds = (): Record<RecordFileKind, KindCount> => ({ shard: { files: 0, bytes: 0, done: 0 }, corrections: { files: 0, bytes: 0, done: 0 }, segment: { files: 0, bytes: 0, done: 0 }, seal: { files: 0, bytes: 0, done: 0 } });

/** The dry run: what a run would convert, without writing anything. */
export async function planRecordConversion(vaultRoot: string, direction: Direction): Promise<RecordPlan> {
  const files = await listRecordFiles(vaultRoot);
  const plan: RecordPlan = { direction, files: files.length, bytes: 0, toConvert: 0, byKind: emptyKinds(), unreadable: [] };
  for (const f of files) {
    let bytes: Buffer;
    try {
      bytes = await withFsRetry(() => fsp.readFile(f.abs), 3);
    } catch {
      plan.unreadable.push(f.rel);
      continue;
    }
    const k = plan.byKind[f.kind];
    k.files++;
    k.bytes += bytes.length;
    plan.bytes += bytes.length;
    if (alreadyConverted(f.kind, bytes, direction)) k.done++;
    else plan.toConvert++;
  }
  return plan;
}

// ───────────────────────────── the run ─────────────────────────────

export interface ConvertOptions {
  direction: Direction;
  /** The vault key (held by the caller; never stored here). */
  key: Uint8Array;
  /** Folder under the cache for the backup; default `backups/<direction>-<stamp>`. */
  backupName?: string;
  onProgress?: (done: number, total: number) => void;
  /** Test hook: throws after this many files were replaced (to exercise the rollback). */
  failAfter?: number;
  now?: () => number;
}

export interface ConvertResult {
  ok: boolean;
  converted: number;
  /** Files already in the wanted form. */
  skipped: number;
  /** Cache-relative backup folder (null when nothing needed converting). */
  backup: string | null;
  rolledBack: boolean;
  /** Set when the rollback itself failed: the backup folder still holds every original. */
  rollbackFailed: boolean;
  error?: string;
}

type Ctx = Pick<StoreContext, "vaultRoot" | "cacheDir" | "owner" | "lockStaleMs">;

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "z").toLowerCase();
}

async function readOnce(abs: string): Promise<Buffer> {
  return withFsRetry(() => fsp.readFile(abs), 3);
}

/** Copy `bytes` to the backup (atomic) and check the copy hashes the same. */
async function backUp(ctx: Ctx, backupRel: string, f: RecordFile, bytes: Uint8Array): Promise<void> {
  const rel = `${backupRel}/${f.rel}`;
  const abs = cacheWritablePath(ctx.cacheDir, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await writeFileAtomic(abs, bytes);
  if (sha(await readOnce(abs)) !== sha(bytes)) throw new CortexError("E_IO", `the backup copy of ${f.rel} does not match`);
}

/**
 * Convert the record. Every file is backed up (and the copy checked) before it changes; each converted file is opened
 * again in memory and compared with the original before it replaces it, and read back from disk after. Any failure
 * restores every file already replaced from the backup; the result says whether that worked.
 */
export async function convertRecord(ctx: Ctx, opts: ConvertOptions): Promise<ConvertResult> {
  const files = await listRecordFiles(ctx.vaultRoot);
  const stampText = stamp((opts.now ?? Date.now)());
  const backupRel = `${BACKUPS_DIR}/${opts.backupName ?? `${opts.direction}-${stampText}`}`;
  const replaced: RecordFile[] = [];
  let skipped = 0;
  let wroteBackup = false;
  let seedChanged = false;
  const total = files.length;
  const lockOpts = { owner: ctx.owner, staleMs: ctx.lockStaleMs };
  const locksDir = locksDirOf(ctx.cacheDir);

  const one = async (f: RecordFile): Promise<void> => {
    const original = await readOnce(f.abs);
    if (alreadyConverted(f.kind, original, opts.direction)) {
      skipped++;
      return;
    }
    await backUp(ctx, backupRel, f, original);
    wroteBackup = true;
    const converted = convertBytes(f.kind, original, opts.key, opts.direction);
    // Check before replacing: opened again, the converted bytes must be the same plain bytes the original holds.
    const plainBefore = sha(convertBytes(f.kind, original, opts.key, "decrypt"));
    if (sha(convertBytes(f.kind, converted, opts.key, "decrypt")) !== plainBefore) throw new CortexError("E_IO", `${f.rel} did not convert faithfully`);
    await writeFileAtomic(writablePath(ctx.vaultRoot, f.rel), converted);
    replaced.push(f);
    // Read back from disk and check again.
    const disk = await readOnce(f.abs);
    if (sha(disk) !== sha(converted) || sha(convertBytes(f.kind, disk, opts.key, "decrypt")) !== plainBefore) {
      throw new CortexError("E_IO", `${f.rel} did not read back as written`);
    }
    if (opts.failAfter !== undefined && replaced.length >= opts.failAfter) throw new CortexError("E_INTERNAL", "stopped for the test");
  };

  try {
    let done = 0;
    for (const f of files) {
      if (f.lock) await withLock(locksDir, f.lock, lockOpts, () => one(f));
      else await one(f);
      opts.onProgress?.(++done, total);
    }
    // The signing seed in the cache follows the record: wrapped by the vault key on the way in, plain again on the way out.
    seedChanged = await convertSigningKey(ctx.cacheDir, opts.key, opts.direction);
    return { ok: true, converted: replaced.length, skipped, backup: wroteBackup ? backupRel : null, rolledBack: false, rollbackFailed: false };
  } catch (e) {
    let rollbackFailed = false;
    // Put each replaced file back by converting its current bytes the other way (not by copying the original over it),
    // so a line appended after the file was converted is kept.
    const opposite: Direction = opts.direction === "encrypt" ? "decrypt" : "encrypt";
    if (seedChanged) {
      try {
        await convertSigningKey(ctx.cacheDir, opts.key, opposite);
      } catch {
        rollbackFailed = true;
      }
    }
    for (const r of [...replaced].reverse()) {
      try {
        const restore = async (): Promise<void> => {
          const current = await readOnce(r.abs);
          await writeFileAtomic(writablePath(ctx.vaultRoot, r.rel), convertBytes(r.kind, current, opts.key, opposite));
        };
        if (r.lock) await withLock(locksDir, r.lock, lockOpts, restore);
        else await restore();
      } catch {
        rollbackFailed = true;
      }
    }
    return {
      ok: false,
      converted: 0,
      skipped,
      backup: wroteBackup ? backupRel : null,
      rolledBack: replaced.length > 0 && !rollbackFailed,
      rollbackFailed,
      error: e instanceof CortexError ? e.message : errCode(e) ?? (e instanceof Error ? e.message : "failed"),
    };
  }
}

// ───────────────────────────── backups ─────────────────────────────

/** Backup folders (cache-relative) left by earlier runs, oldest first. */
export async function listBackups(cacheDir: string): Promise<string[]> {
  const names = await listDir(path.join(cacheDir, BACKUPS_DIR));
  return names.filter((n) => /^(encrypt|decrypt)-/.test(n)).sort().map((n) => `${BACKUPS_DIR}/${n}`);
}

/** Delete one backup folder (a plain copy of the record before encryption is a plaintext copy: delete it once the result is checked). */
export async function removeBackup(cacheDir: string, rel: string): Promise<void> {
  if (!new RegExp(`^${BACKUPS_DIR}/(encrypt|decrypt)-[A-Za-z0-9]+$`).test(rel)) throw new CortexError("E_PATH_DENIED", "not a Cortex backup folder");
  await withFsRetry(() => fsp.rm(path.join(cacheDir, rel), { recursive: true, force: true }));
}
