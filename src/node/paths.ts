/**
 * Path rules for every write Cortex makes. Owner: E1. SECURITY-CRITICAL (SAFE-02).
 *
 * The write roots are HARD-CODED here, independent of settings (data.json is synced and hand-editable):
 *   .raw/chats/  .raw/written/  wiki/derived/  .vault-meta/cortex/  .obsidian/plugins/cortex/
 * plus the local cache folder %LOCALAPPDATA%/cortex/<vaultKey>/ (registered once its `.cortex-cache` marker
 * exists). Writers accept only a branded WritablePath minted by writablePath() or cacheWritablePath(), and the
 * atomic write helpers re-assert the minted path before touching the disk (a cast cannot forge one).
 *
 * Rules: vault-relative POSIX only; no "..", ".", empty segments, drive letters, UNC, NUL, control, bidi or
 * zero-width characters; Windows-reserved names, characters and segments ending in "." or " " are rejected;
 * segments ≤ 255 characters; a deny list protects the vault's generators and configs; no new markdown file
 * whose name starts with "wiki" (the vault's case-insensitive WIKI*.md ignore rule); vault root + relative path
 * ≤ 240 characters; the nested `.gitignore` of a root can only be created by ensureCortexRoots, never replaced
 * through a minted path; and a write under a Cortex root is refused while that root's nested `.gitignore`
 * ("*") is missing (APPEND-RETRY-TMP-GITIGNORE).
 */
import { existsSync, lstatSync } from "node:fs";
import * as path from "node:path";
import { CortexError } from "../shared/errors";
import type { VaultPath } from "../shared/types";

export const MAX_ABS_PATH = 240;
export const MAX_SEGMENT = 255;

/** Every vault folder Cortex may write under (each ends with "/"). Not configurable. */
export const CORTEX_WRITE_ROOTS: readonly string[] = [".raw/chats/", ".raw/written/", "wiki/derived/", ".vault-meta/cortex/", ".obsidian/plugins/cortex/"];

/** Roots that carry a nested `.gitignore` containing "*" (created once by ensureCortexRoots). */
export const GITIGNORE_ROOTS: readonly string[] = [".raw/chats", ".raw/written", "wiki/derived", ".vault-meta/cortex", ".obsidian/plugins/cortex"];

/** Never written (case-insensitive; an entry ending in "/" is a folder prefix, otherwise a path or prefix). */
export const DENY_PREFIXES: readonly string[] = [
  "wiki/brain/",
  "wiki/brain.md",
  "wiki/brain map.canvas",
  "wiki/kb/deep/roblox/reference/",
  "wiki/kb/deep/roblox/docs/",
  ".obsidian/plugins/brain-",
  ".obsidian/graph.json",
  ".obsidian/community-plugins.json",
  ".obsidian/app.json",
  ".obsidian/workspace.json",
  ".raw/.manifest.json",
  ".git/",
  ".claude/",
];

const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(\..*)?$/i;
// Control characters, DEL, zero-width and bidi controls: never valid in a path Cortex builds.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/;

/** A path that passed the write guard. Only writablePath() / cacheWritablePath() create one. */
export type WritablePath = string & { readonly __cortexWritable: true };

/** Vaults that minted a path in this process: normalised root -> the root as given (lstat needs the real case). */
const vaults = new Map<string, string>();
const caches = new Set<string>();

const norm = (p: string): string => path.resolve(p).toLowerCase();

/** Normalise a vault-relative path; throws E_PATH_DENIED on anything suspicious. */
export function normalizeVaultPath(p: string): VaultPath {
  if (typeof p !== "string" || p.length === 0) throw new CortexError("E_PATH_DENIED", "empty path");
  if (UNSAFE_CHARS.test(p)) throw new CortexError("E_PATH_DENIED", "control or invisible character in path");
  const s = p.replace(/\\/g, "/");
  if (s.startsWith("/") || /^[a-zA-Z]:/.test(s)) throw new CortexError("E_PATH_DENIED", "absolute path not allowed");
  const segs = s.split("/");
  for (const seg of segs) {
    if (seg === "" || seg === "." || seg === "..") throw new CortexError("E_PATH_DENIED", "bad segment");
    if (seg.length > MAX_SEGMENT) throw new CortexError("E_PATH_DENIED", "segment too long");
    if (/[<>:"|?*]/.test(seg)) throw new CortexError("E_PATH_DENIED", "illegal character");
    if (RESERVED.test(seg)) throw new CortexError("E_PATH_DENIED", "reserved name");
    if (seg.endsWith(".") || seg.endsWith(" ")) throw new CortexError("E_PATH_DENIED", "segment ends with dot or space");
  }
  return segs.join("/");
}

/** Cortex-owned write roots (each ends with "/"). */
export function writeRoots(): string[] {
  return [...CORTEX_WRITE_ROOTS];
}

function isDenied(lower: string): boolean {
  return DENY_PREFIXES.some((d) => (d.endsWith("/") ? lower === d.slice(0, -1) || lower.startsWith(d) : lower === d || lower.startsWith(d)));
}

/** Throws unless `rel` is inside a Cortex root and outside the deny list. Returns the normalised path. */
export function assertWritable(rel: string, vaultRootAbs?: string): VaultPath {
  const p = normalizeVaultPath(rel);
  const lower = p.toLowerCase();
  if (isDenied(lower)) throw new CortexError("E_PATH_DENIED", `protected path: ${p}`);
  const root = CORTEX_WRITE_ROOTS.find((r) => lower.startsWith(r.toLowerCase()));
  if (root === undefined) throw new CortexError("E_PATH_DENIED", `outside Cortex write roots: ${p}`);
  if (lower === `${root.toLowerCase()}.gitignore`) throw new CortexError("E_PATH_DENIED", `the nested .gitignore of ${root} is created once and never replaced`);
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (/^wiki/i.test(base) && /\.md$/i.test(base)) throw new CortexError("E_PATH_DENIED", `file names starting with "wiki" are not allowed: ${p}`);
  if (vaultRootAbs !== undefined) {
    const total = path.resolve(vaultRootAbs).length + 1 + p.length;
    if (total > MAX_ABS_PATH) throw new CortexError("E_PATH_DENIED", `path too long (${total} > ${MAX_ABS_PATH})`);
  }
  return p;
}

/** Join a vault-relative path onto the vault root and verify the result stays inside the vault. */
export function resolveInVault(vaultRootAbs: string, rel: string): string {
  if (!path.isAbsolute(vaultRootAbs)) throw new CortexError("E_PATH_DENIED", "vault root must be absolute");
  const p = normalizeVaultPath(rel);
  const root = path.resolve(vaultRootAbs);
  const abs = path.resolve(root, ...p.split("/"));
  const back = path.relative(root, abs);
  if (back === "" || back === ".." || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) throw new CortexError("E_PATH_DENIED", "escapes vault");
  return abs;
}

/** The gitignore root containing `rel`, if any. */
export function gitignoreRootOf(rel: VaultPath): string | undefined {
  const lower = rel.toLowerCase();
  return GITIGNORE_ROOTS.find((r) => lower === r.toLowerCase() || lower.startsWith(`${r.toLowerCase()}/`));
}

/** Positive .gitignore checks are remembered briefly so a burst of writes costs one stat per root. */
const GITIGNORE_TTL_MS = 30_000;
const gitignoreSeen = new Map<string, number>();

function hasNestedGitignore(vaultRootAbs: string, root: string): boolean {
  const file = path.join(path.resolve(vaultRootAbs), ...root.split("/"), ".gitignore");
  const key = file.toLowerCase();
  const now = Date.now();
  const seen = gitignoreSeen.get(key);
  if (seen !== undefined && now - seen < GITIGNORE_TTL_MS) return true;
  if (!existsSync(file)) {
    gitignoreSeen.delete(key);
    return false;
  }
  gitignoreSeen.set(key, now);
  return true;
}

/** Forget remembered .gitignore checks (tests; after a root was removed by hand). */
export function forgetGitignoreChecks(): void {
  gitignoreSeen.clear();
  linkFreeSeen.clear();
}

/** Folders already found free of links, remembered briefly like the .gitignore checks. */
const linkFreeSeen = new Map<string, number>();

/**
 * Refuse a write whose folder chain (below the vault root) contains a symbolic link or junction: such a link
 * could send a Cortex write outside the vault (SAFE-02). Folders that do not exist yet are fine.
 */
function assertNoLinkedFolders(vaultRootAbs: string, rel: VaultPath, fresh = false): void {
  const root = path.resolve(vaultRootAbs);
  const parts = rel.split("/").slice(0, -1);
  let cur = root;
  const now = Date.now();
  for (const part of parts) {
    cur = path.join(cur, part);
    const key = cur.toLowerCase();
    const seen = linkFreeSeen.get(key);
    // A minted path is cheap to check from the memory of the last 30 s; the write itself (fresh) never is.
    if (!fresh && seen !== undefined && now - seen < GITIGNORE_TTL_MS) continue;
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return; // not created yet: nothing below it exists either
    }
    if (st.isSymbolicLink()) throw new CortexError("E_PATH_DENIED", `a linked folder is not written through: ${part}`);
    linkFreeSeen.set(key, now);
  }
}

/**
 * Check the folder chain of `rel` (a vault-relative FOLDER, below the vault root) against the disk right now:
 * a symbolic link or junction anywhere on it is refused. Used when roots are created (ensureCortexRoots) and
 * right before each write (assertMinted), so a link planted after a path was minted is still caught.
 */
export function assertFolderChainClear(vaultRootAbs: string, relFolder: string): void {
  if (!path.isAbsolute(vaultRootAbs)) throw new CortexError("E_PATH_DENIED", "vault root must be absolute");
  assertNoLinkedFolders(vaultRootAbs, `${normalizeVaultPath(relFolder)}/_`, true);
}

/** Assert + resolve + mint. Refuses a Cortex root whose nested .gitignore is missing. */
export function writablePath(vaultRootAbs: string, rel: string): WritablePath {
  if (!path.isAbsolute(vaultRootAbs)) throw new CortexError("E_PATH_DENIED", "vault root must be absolute");
  const p = assertWritable(rel, vaultRootAbs);
  const root = gitignoreRootOf(p);
  if (root !== undefined && !hasNestedGitignore(vaultRootAbs, root)) {
    throw new CortexError("E_PATH_DENIED", `missing nested .gitignore in ${root} (call ensureCortexRoots first)`);
  }
  assertNoLinkedFolders(vaultRootAbs, p);
  vaults.set(norm(vaultRootAbs), path.resolve(vaultRootAbs));
  return resolveInVault(vaultRootAbs, p) as WritablePath;
}

/** Register a cache folder after its `.cortex-cache` marker exists (node/fsAtomic.ts ensureCacheDir). */
export function registerCacheDir(cacheDirAbs: string): void {
  if (!path.isAbsolute(cacheDirAbs)) throw new CortexError("E_PATH_DENIED", "cache folder must be absolute");
  if (!existsSync(path.join(cacheDirAbs, ".cortex-cache"))) throw new CortexError("E_PATH_DENIED", "cache folder has no .cortex-cache marker");
  caches.add(norm(cacheDirAbs));
}

/** True once `cacheDirAbs` has been registered in this process. */
export function isCacheDirRegistered(cacheDirAbs: string): boolean {
  return caches.has(norm(cacheDirAbs));
}

/** Mint a path inside a registered cache folder. */
export function cacheWritablePath(cacheDirAbs: string, rel: string): WritablePath {
  if (!caches.has(norm(cacheDirAbs))) throw new CortexError("E_PATH_DENIED", "cache folder is not registered");
  const p = normalizeVaultPath(rel);
  if (p.toLowerCase() === ".cortex-cache") throw new CortexError("E_PATH_DENIED", "the cache marker is never rewritten");
  const root = path.resolve(cacheDirAbs);
  const abs = path.resolve(root, ...p.split("/"));
  const back = path.relative(root, abs);
  if (back === "" || back === ".." || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) throw new CortexError("E_PATH_DENIED", "escapes the cache folder");
  return abs as WritablePath;
}

/** Re-assert inside the write helpers: the path must lie under a registered cache folder or a vault root. */
export function assertMinted(abs: string): void {
  if (typeof abs !== "string" || !path.isAbsolute(abs)) throw new CortexError("E_PATH_DENIED", "write path must be absolute");
  const a = norm(abs);
  for (const c of caches) if (a.startsWith(c + path.sep)) return;
  for (const [, root] of vaults) {
    const rel = toVaultPath(root, abs);
    if (rel !== undefined) {
      assertWritable(rel);
      // The cached check at mint time may be up to 30 s old: look at the disk again right before the write.
      assertNoLinkedFolders(root, rel, true);
      return;
    }
  }
  throw new CortexError("E_PATH_DENIED", "write outside Cortex roots");
}

/** Convert an absolute path inside the vault to a vault-relative POSIX path (undefined when outside). */
export function toVaultPath(vaultRootAbs: string, abs: string): VaultPath | undefined {
  const rel = path.relative(path.resolve(vaultRootAbs), path.resolve(abs));
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}

/** True when `abs` lies inside the folder `dirAbs` (case-insensitive on Windows). */
export function isInside(dirAbs: string, abs: string): boolean {
  const rel = path.relative(path.resolve(dirAbs), path.resolve(abs));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
