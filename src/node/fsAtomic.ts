/**
 * OneDrive-safe file writes. Owner: E1.
 *  - Rewritable files (state, notes, caches): write a temp file in the same folder, fsync, then rename over the
 *    target, retrying EPERM/EBUSY/EACCES caused by OneDrive or antivirus scans. Temp names start with "." so
 *    Obsidian never indexes them, and a failed write never leaves its temp file behind.
 *  - Append-only JSONL: whole lines in one write under the caller's lock. Opening retries transient sharing
 *    errors; a write that fails part-way is rolled back to the previous size, so a line is appended whole or not
 *    at all. If the file ends in an incomplete line (a crashed writer), the new lines start on a fresh line.
 *  - Immutable files (segments): `writeFileExclusive` publishes with link(tmp, final), which fails with EEXIST,
 *    so immutability never depends on a lock (SEGMENT-SEQ-DEADLOCK, SAFE-14). Where hard links are unavailable
 *    it falls back to an exclusive copy (still EEXIST-safe).
 *  - Every Cortex root gets its nested `.gitignore` ("*") once (ensureCortexRoots, create-only); writablePath()
 *    refuses roots without it. The vault's root .gitignore is never edited.
 * All Cortex writers take a WritablePath (node/paths.ts) and re-assert it. The single exception is
 * `writeExternalFileAtomic`, reserved for a destination the user chose in a Save dialog (plugin/saveFile.ts).
 */
import { constants as fsConstants, promises as fsp } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { CortexError } from "../shared/errors";
import { assertFolderChainClear, assertMinted, GITIGNORE_ROOTS, registerCacheDir, type WritablePath } from "./paths";
import { decodeFile, encodeFile } from "./vaultCipher";

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY", "EAGAIN", "EMFILE", "ENFILE"]);
/** Temp files younger than this are never cleaned (their writer may still be running). */
export const TEMP_MAX_AGE_MS = 10 * 60_000;
export const GITIGNORE_BODY = "*\n";
export const CACHE_MARKER = ".cortex-cache";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function errCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

/** True for errors that a retry may fix (Windows sharing violations, antivirus and sync locks, fd pressure). */
export function isTransientFsError(e: unknown): boolean {
  const c = errCode(e);
  return c !== undefined && RETRY_CODES.has(c);
}

/** Retry an fs operation on transient errors: `retries` extra tries, backoff 50 ms × 2ⁿ with ±25 % jitter. */
export async function withFsRetry<T>(fn: () => Promise<T>, retries = 6, baseMs = 50): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt < retries && isTransientFsError(e)) {
        const delay = baseMs * 2 ** attempt;
        await sleep(delay * (0.75 + Math.random() * 0.5));
        continue;
      }
      throw e;
    }
  }
}

export async function ensureDir(absDir: string): Promise<void> {
  await withFsRetry(() => fsp.mkdir(absDir, { recursive: true }));
}

async function createOnly(file: string, body: string): Promise<boolean> {
  try {
    await withFsRetry(() => fsp.writeFile(file, body, { flag: "wx" }));
    return true;
  } catch (e) {
    if (errCode(e) === "EEXIST") return false;
    throw e;
  }
}

/**
 * Create Cortex roots with their nested `.gitignore` = "*" (create-only: an existing file, the user's or an
 * earlier run's, is kept). `roots` defaults to all of them; pass a subset to create only what is needed.
 */
export async function ensureCortexRoots(vaultRootAbs: string, roots: readonly string[] = GITIGNORE_ROOTS): Promise<void> {
  if (!path.isAbsolute(vaultRootAbs)) throw new CortexError("E_PATH_DENIED", "vault root must be absolute");
  for (const root of roots) {
    if (!GITIGNORE_ROOTS.includes(root)) throw new CortexError("E_PATH_DENIED", `not a Cortex root: ${root}`);
    // Never create folders or the .gitignore through a link: a junction on the way would put them outside the vault.
    assertFolderChainClear(vaultRootAbs, root);
    const dir = path.join(vaultRootAbs, ...root.split("/"));
    await ensureDir(dir);
    assertFolderChainClear(vaultRootAbs, root);
    await createOnly(path.join(dir, ".gitignore"), GITIGNORE_BODY);
  }
}

/** Create the local cache folder with its `.cortex-cache` marker and register it for minting. */
export async function ensureCacheDir(cacheDirAbs: string): Promise<void> {
  if (!path.isAbsolute(cacheDirAbs)) throw new CortexError("E_PATH_DENIED", "cache folder must be absolute");
  await ensureDir(cacheDirAbs);
  await createOnly(path.join(cacheDirAbs, CACHE_MARKER), "Cortex cache: safe to delete; Cortex rebuilds it.\n");
  registerCacheDir(cacheDirAbs);
}

const TEMP_RE = /^\..*\.cortex-tmp-(\d+)-[a-z0-9]+$/;

function tempName(absPath: string): string {
  return path.join(path.dirname(absPath), `.${path.basename(absPath)}.cortex-tmp-${process.pid}-${randomBytes(5).toString("hex")}`);
}

/** Write `data` to a new temp file next to `absPath`, fsync it, and return its name (removed on failure). */
async function writeTemp(absPath: string, data: string | Uint8Array): Promise<string> {
  await ensureDir(path.dirname(absPath));
  const tmp = tempName(absPath);
  let fh: fsp.FileHandle | null = null;
  try {
    fh = await withFsRetry(() => fsp.open(tmp, "wx"));
    await fh.writeFile(data);
    await fh.sync();
    await fh.close();
    fh = null;
    return tmp;
  } catch (e) {
    await fh?.close().catch(() => undefined);
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw new CortexError("E_IO", `cannot write ${path.basename(absPath)}: ${String(errCode(e) ?? e)}`, { retryable: isTransientFsError(e), cause: e });
  }
}

/** Make a rename durable on POSIX (Windows cannot open a directory for fsync; NTFS journals the rename). */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const dh = await fsp.open(dir, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    // Best effort: some file systems refuse fsync on directories.
  }
}

async function replaceWith(tmp: string, absPath: string, retries: number): Promise<void> {
  try {
    await withFsRetry(() => fsp.rename(tmp, absPath), retries);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw new CortexError("E_IO", `atomic write failed: ${String(errCode(e) ?? e)}`, { retryable: true, cause: e });
  }
  await syncDir(path.dirname(absPath));
}

/** Atomic replace: temp file + fsync + rename, with retries for transient Windows locks. */
export async function writeFileAtomic(absPath: WritablePath, data: string | Uint8Array, opts: { retries?: number } = {}): Promise<void> {
  assertMinted(absPath);
  const tmp = await writeTemp(absPath, data);
  await replaceWith(tmp, absPath, opts.retries ?? 6);
}

/**
 * Atomic replace for a destination the USER chose (Save dialog, Downloads fallback). Never used for vault or
 * cache files, which go through writeFileAtomic and a minted path.
 */
export async function writeExternalFileAtomic(absPath: string, data: string | Uint8Array): Promise<void> {
  if (typeof absPath !== "string" || !path.isAbsolute(absPath)) throw new CortexError("E_PATH_DENIED", "save path must be absolute");
  const tmp = await writeTemp(absPath, data);
  await replaceWith(tmp, absPath, 6);
}

const LINK_UNSUPPORTED = new Set(["ENOTSUP", "ENOSYS", "EXDEV", "EINVAL", "EMLINK", "EOPNOTSUPP"]);
/** Volumes (drive roots) where hard links failed; exclusive writes there use the copy fallback at once. */
const noLinkVolumes = new Set<string>();

function existsError(): CortexError {
  return new CortexError("E_IO", "file already exists (immutable)", { detail: { exists: true } });
}

async function publishByCopy(tmp: string, absPath: string): Promise<void> {
  try {
    await withFsRetry(() => fsp.copyFile(tmp, absPath, fsConstants.COPYFILE_EXCL), 3);
  } catch (e) {
    if (errCode(e) === "EEXIST") throw existsError();
    throw new CortexError("E_IO", `exclusive write failed: ${String(errCode(e) ?? e)}`, { retryable: true, cause: e });
  }
  try {
    const fh = await fsp.open(absPath, "r+");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // The copy is complete; fsync is best effort here.
  }
}

/**
 * Publish an immutable file: temp + fsync + link(tmp, final). Fails with a CortexError ("E_IO",
 * detail.exists = true) when the target already exists; never replaces it.
 */
export async function writeFileExclusive(absPath: WritablePath, data: string | Uint8Array): Promise<void> {
  assertMinted(absPath);
  const tmp = await writeTemp(absPath, data);
  const volume = path.parse(path.resolve(absPath)).root.toLowerCase();
  try {
    if (noLinkVolumes.has(volume)) {
      await publishByCopy(tmp, absPath);
      return;
    }
    try {
      await withFsRetry(() => fsp.link(tmp, absPath), 3);
    } catch (e) {
      const code = errCode(e);
      if (code === "EEXIST") throw existsError();
      if (code !== undefined && (LINK_UNSUPPORTED.has(code) || code === "EPERM" || code === "EACCES")) {
        noLinkVolumes.add(volume);
        await publishByCopy(tmp, absPath);
        return;
      }
      throw new CortexError("E_IO", `exclusive write failed: ${String(code ?? e)}`, { retryable: true, cause: e });
    }
    await syncDir(path.dirname(absPath));
  } finally {
    await withFsRetry(() => fsp.rm(tmp, { force: true }), 3).catch(() => undefined);
  }
}

export async function writeJsonAtomic(absPath: WritablePath, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  if (typeof text !== "string") throw new CortexError("E_INTERNAL", "value cannot be stored as JSON");
  await writeFileAtomic(absPath, `${text}\n`);
}

/** JSON that is part of the record (a seal block): written as one encrypted file frame while the record is encrypted (E_LOCKED while it is locked). */
export async function writeSealedJson(absPath: WritablePath, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  if (typeof text !== "string") throw new CortexError("E_INTERNAL", "value cannot be stored as JSON");
  await writeFileAtomic(absPath, encodeFile(Buffer.from(`${text}\n`, "utf8")));
}

/** Read JSON written by writeSealedJson or plainly (a legacy file); null when missing. An encrypted file with no key throws E_LOCKED. */
export async function readSealedJson<T>(absPath: string): Promise<T | null> {
  let bytes: Buffer;
  try {
    bytes = await withFsRetry(() => fsp.readFile(absPath), 3);
  } catch (e) {
    if (errCode(e) === "ENOENT") return null;
    throw e;
  }
  const text = Buffer.from(decodeFile(bytes)).toString("utf8").replace(/^﻿/, "");
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new CortexError("E_PARSE", `invalid JSON in ${path.basename(absPath)}`, { cause: e });
  }
}

async function writeAll(fh: fsp.FileHandle, buf: Buffer): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off, null);
    if (bytesWritten <= 0) throw new CortexError("E_IO", "short write");
    off += bytesWritten;
  }
}

/**
 * Append whole lines (the caller holds the file's lock). `text` must end with "\n". Either every byte of
 * `text` is appended or the file is rolled back to its previous size.
 */
export async function appendLines(absPath: WritablePath, text: string): Promise<void> {
  if (text.length === 0) return;
  if (!text.endsWith("\n")) throw new CortexError("E_INTERNAL", "appendLines requires complete lines");
  assertMinted(absPath);
  await ensureDir(path.dirname(absPath));
  const fh = await withFsRetry(() => fsp.open(absPath, "a+"));
  let size = 0;
  let wrote = false;
  try {
    size = (await fh.stat()).size;
    let payload = Buffer.from(text, "utf8");
    if (size > 0) {
      const last = Buffer.alloc(1);
      const { bytesRead } = await fh.read(last, 0, 1, size - 1);
      if (bytesRead === 1 && last[0] !== 0x0a) payload = Buffer.concat([Buffer.from("\n"), payload]);
    }
    wrote = true;
    await writeAll(fh, payload);
    await fh.datasync();
    wrote = false;
  } catch (e) {
    await fh.close().catch(() => undefined);
    if (wrote) await withFsRetry(() => fsp.truncate(absPath, size), 3).catch(() => undefined);
    throw new CortexError("E_IO", `append failed: ${String(errCode(e) ?? e)}`, { retryable: isTransientFsError(e), cause: e });
  }
  await fh.close();
}

export async function readTextIfExists(absPath: string): Promise<string | null> {
  try {
    const text = await withFsRetry(() => fsp.readFile(absPath, "utf8"), 3);
    return text.startsWith("﻿") ? text.slice(1) : text;
  } catch (e) {
    if (errCode(e) === "ENOENT") return null;
    throw e;
  }
}

export async function readJsonIfExists<T>(absPath: string): Promise<T | null> {
  const text = await readTextIfExists(absPath);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new CortexError("E_PARSE", `invalid JSON in ${path.basename(absPath)}`, { cause: e });
  }
}

export async function exists(absPath: string): Promise<boolean> {
  try {
    await fsp.access(absPath);
    return true;
  } catch {
    return false;
  }
}

/** True while a process with this pid exists (EPERM = exists but belongs to another user). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === "EPERM";
  }
}

/**
 * Remove stray temp files left by a crash: only Cortex's own ".*.cortex-tmp-<pid>-<hex>" names that are older
 * than 10 minutes AND whose writer pid is no longer alive (another runner may still be writing the rest).
 * Returns the number of files removed.
 */
export async function cleanTempFiles(absDir: string, now = Date.now()): Promise<number> {
  let n = 0;
  let names: string[];
  try {
    names = await fsp.readdir(absDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const m = TEMP_RE.exec(name);
    if (!m) continue;
    const full = path.join(absDir, name);
    try {
      const st = await fsp.stat(full);
      if (!st.isFile() || now - st.mtimeMs < TEMP_MAX_AGE_MS || pidAlive(Number(m[1]))) continue;
      await withFsRetry(() => fsp.rm(full, { force: true }), 3);
      n++;
    } catch {
      // vanished meanwhile, or still locked: try again next time
    }
  }
  return n;
}
