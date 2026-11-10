/**
 * The single source of truth for where Cortex keeps things on disk. Owner: E2.
 * Every other module asks this file for paths; nobody hand-builds a vault path. Paths are CONSTANTS, not
 * settings (SAFE-02): the write guard (node/paths.ts) allows exactly these roots.
 *
 *   .raw/chats/<source>/<yyyy-mm>/<conv-id>/<seq4>.jsonl.gz       record segments (immutable; folder fixed per conversation)
 *   .raw/written/<yyyy>/<mm>/<yyyymmdd-HHmm>-<slug>.md             entries written in Cortex (New entry)
 *   wiki/derived/gists/<yyyy>/<conv8>-<slug>.md                    conversation summaries + their notes
 *   wiki/derived/maps/<project|area|topic>/<slug>.md               machine maps (code: hubs)
 *   .vault-meta/cortex/<ledger>/<yyyy-mm>/<nnnnnn>.jsonl           append-only ledgers, size-rolled shards (~8 MB)
 *   .vault-meta/cortex/corrections.jsonl                           user corrections (single file)
 *   .vault-meta/cortex/state/{seq,budget,control,colours}.json     small shared state (rewritten atomically)
 *   .vault-meta/cortex/sources.json, views.json                    sources manifest, pinned views
 *   .vault-meta/cortex/trash/<note-id>/<sha8>.md                   previous bytes of tombstoned derived notes
 *   %LOCALAPPDATA%/cortex/<vaultKey>/                              local cache: indexes, search shards, locks,
 *                                                                  cursors, queue, live stage, held secrets,
 *                                                                  export copies, aggregates, logs (never synced)
 * Each vault root carries a nested .gitignore "*" (ensureCortexRoots); the vault's root .gitignore is never
 * touched. There is no `.raw/inbox/` and no `.raw/exports/` (export copies, when kept, stay in the local cache).
 */
import * as path from "node:path";
import { CortexError } from "../shared/errors";
import type { Logger } from "../shared/log";
import type { ConversationId, EntryId, NoteId, SourceKind, VaultPath } from "../shared/types";
import { SOURCE_KINDS } from "../shared/types";
import { slugify } from "../shared/text";
import { ensureCacheDir, ensureCortexRoots } from "../node/fsAtomic";
import { DEFAULT_STALE_MS } from "../node/locks";

export const CORTEX_PATHS = {
  chats: ".raw/chats",
  written: ".raw/written",
  derived: "wiki/derived",
  meta: ".vault-meta/cortex",
  plugin: ".obsidian/plugins/cortex",
} as const;

export type LedgerName = "entries" | "conversations" | "notes" | "labels" | "runs" | "reads" | "review" | "receipts";
export const LEDGERS: readonly LedgerName[] = ["entries", "conversations", "notes", "labels", "runs", "reads", "review", "receipts"];

export function isLedgerName(s: string): s is LedgerName {
  return (LEDGERS as readonly string[]).includes(s);
}

/** A ledger shard is closed (immutable, uploaded once by OneDrive) when the next batch would take it past this. */
export const SHARD_ROLL_BYTES = 8 * 1024 * 1024;

/** Month folder names ("2026-11") and file names of ledger shards and record segments. */
export const MONTH_DIR_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const SHARD_FILE_RE = /^(\d{6})\.jsonl$/;
export const SEGMENT_FILE_RE = /^(\d{4})\.jsonl\.gz$/;
const ID_RE = /^[a-z]_[a-z2-7]{16}$/;

export interface StoreContext {
  vaultRoot: string;
  /** Always %LOCALAPPDATA%/cortex/<vaultKey>; registered for minting. */
  cacheDir: string;
  /** Lock owner label, e.g. "runner:1234" or "plugin". */
  owner: string;
  log: Logger;
  /** Lock stale limit: 60 s for child and worker runners, ≥ 5 min inline. */
  lockStaleMs: number;
}

/**
 * Create the vault roots (with nested .gitignore) and the cache folder (with its marker), then the context.
 * Refuses relative folders and a cache inside the vault (caches, locks and staged text must never sync).
 */
export async function openStoreContext(args: { vaultRoot: string; cacheDir: string; owner: string; log: Logger; lockStaleMs?: number }): Promise<StoreContext> {
  if (!path.isAbsolute(args.vaultRoot)) throw new CortexError("E_PATH_DENIED", "vault folder must be absolute");
  if (!path.isAbsolute(args.cacheDir)) throw new CortexError("E_PATH_DENIED", "cache folder must be absolute");
  const rel = path.relative(path.resolve(args.vaultRoot), path.resolve(args.cacheDir));
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new CortexError("E_PATH_DENIED", "the cache folder must be outside the vault");
  }
  const staleMs = args.lockStaleMs ?? DEFAULT_STALE_MS;
  if (!Number.isFinite(staleMs) || staleMs < 1000) throw new CortexError("E_BAD_REQUEST", "lock stale limit must be at least 1 s");
  await ensureCortexRoots(args.vaultRoot);
  await ensureCacheDir(args.cacheDir);
  return { vaultRoot: args.vaultRoot, cacheDir: args.cacheDir, owner: args.owner, log: args.log, lockStaleMs: staleMs };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function assertMonth(monthKey: string): void {
  if (!MONTH_DIR_RE.test(monthKey)) throw new CortexError("E_INTERNAL", `bad month key ${JSON.stringify(monthKey)}`);
}

function assertId(id: string, what: string): void {
  if (!ID_RE.test(id)) throw new CortexError("E_INTERNAL", `bad ${what} id`);
}

/** Segment folder of a conversation: source + the month of its first message (stable for its lifetime). */
export function segmentDir(source: SourceKind, monthKey: string, conv: ConversationId): VaultPath {
  if (!SOURCE_KINDS.includes(source)) throw new CortexError("E_INTERNAL", "unknown source kind");
  assertMonth(monthKey);
  assertId(conv, "conversation");
  return `${CORTEX_PATHS.chats}/${source}/${monthKey}/${conv}`;
}

export function segmentPath(source: SourceKind, monthKey: string, conv: ConversationId, seq: number): VaultPath {
  if (!Number.isInteger(seq) || seq < 1 || seq > 9999) throw new CortexError("E_INTERNAL", "segment number out of range");
  return `${segmentDir(source, monthKey, conv)}/${pad(seq, 4)}.jsonl.gz`;
}

/** Parse a segment folder (`.raw/chats/<source>/<yyyy-mm>/<conv>`) or a segment file path inside it. */
export function parseSegmentPath(p: VaultPath): { source: SourceKind; monthKey: string; conv: ConversationId; dir: VaultPath; seq?: number } | null {
  const parts = p.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  if (parts.length < 5 || `${parts[0]}/${parts[1]}` !== CORTEX_PATHS.chats) return null;
  const [, , source, monthKey, conv, file] = parts;
  if (!source || !monthKey || !conv || parts.length > 6) return null;
  if (!SOURCE_KINDS.includes(source as SourceKind) || !MONTH_DIR_RE.test(monthKey) || !conv.startsWith("c_") || !ID_RE.test(conv)) return null;
  const dir = `${CORTEX_PATHS.chats}/${source}/${monthKey}/${conv}`;
  if (file === undefined) return { source: source as SourceKind, monthKey, conv: conv as ConversationId, dir };
  const m = SEGMENT_FILE_RE.exec(file);
  if (!m) return null;
  return { source: source as SourceKind, monthKey, conv: conv as ConversationId, dir, seq: Number(m[1]) };
}

export function ledgerDir(ledger: LedgerName): VaultPath {
  if (!isLedgerName(ledger)) throw new CortexError("E_INTERNAL", "unknown ledger");
  return `${CORTEX_PATHS.meta}/${ledger}`;
}

export function ledgerMonthDir(ledger: LedgerName, month: string): VaultPath {
  assertMonth(month);
  return `${ledgerDir(ledger)}/${month}`;
}

export function ledgerShardPath(ledger: LedgerName, month: string, n: number): VaultPath {
  if (!Number.isInteger(n) || n < 1 || n > 999_999) throw new CortexError("E_INTERNAL", "shard number out of range");
  return `${ledgerMonthDir(ledger, month)}/${pad(n, 6)}.jsonl`;
}

export const correctionsPath = (): VaultPath => `${CORTEX_PATHS.meta}/corrections.jsonl`;
export const seqPath = (): VaultPath => `${CORTEX_PATHS.meta}/state/seq.json`;
export const budgetPath = (): VaultPath => `${CORTEX_PATHS.meta}/state/budget.json`;
export const controlPath = (): VaultPath => `${CORTEX_PATHS.meta}/state/control.json`;
export const coloursPath = (): VaultPath => `${CORTEX_PATHS.meta}/state/colours.json`;
export const pinnedViewsPath = (): VaultPath => `${CORTEX_PATHS.meta}/views.json`;
export const sourcesManifestPath = (): VaultPath => `${CORTEX_PATHS.meta}/sources.json`;

export function trashDir(noteId: NoteId): VaultPath {
  assertId(noteId, "note");
  return `${CORTEX_PATHS.meta}/trash/${noteId}`;
}

/** `trash/<note-id>/<sha8>.md`; `suffix` > 1 only when two different files share the first 8 hex digits. */
export function trashPath(noteId: NoteId, sha256: string, suffix = 1): VaultPath {
  if (!/^[0-9a-f]{8,64}$/.test(sha256)) throw new CortexError("E_INTERNAL", "bad trash hash");
  return `${trashDir(noteId)}/${sha256.slice(0, 8)}${suffix > 1 ? `-${suffix}` : ""}.md`;
}

/**
 * `wiki/derived/gists/<yyyy>/<conv8>-<slug>.md`. The 8 id characters come first so a summary's file name is
 * stable when its title changes; a body that happens to start with "wiki" gets a "c" prefix because the vault
 * hides `WIKI*.md` (and the write guard refuses such names).
 */
export function gistNotePath(year: number, conv: ConversationId, title: string, suffix = 1): VaultPath {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) throw new CortexError("E_INTERNAL", "bad year");
  assertId(conv, "conversation");
  const stem = conv.slice(2, 10);
  const head = /^wiki/i.test(stem) ? `c${stem}` : stem;
  return `${CORTEX_PATHS.derived}/gists/${year}/${head}-${slugify(title, 40)}${suffix > 1 ? `-${suffix}` : ""}.md`;
}

export function mapNotePath(kind: "project" | "area" | "topic", title: string, suffix = 1): VaultPath {
  if (kind !== "project" && kind !== "area" && kind !== "topic") throw new CortexError("E_INTERNAL", "bad map kind");
  return `${CORTEX_PATHS.derived}/maps/${kind}/${slugify(title, 48)}${suffix > 1 ? `-${suffix}` : ""}.md`;
}

/** The same derived-note path with a "-n" suffix (n ≥ 2) before ".md"; n = 1 returns the path unchanged. */
export function suffixedNotePath(p: VaultPath, n: number): VaultPath {
  if (!Number.isInteger(n) || n <= 1) return p;
  return /\.md$/i.test(p) ? `${p.slice(0, -3)}-${n}.md` : `${p}-${n}`;
}

/** `.raw/written/<yyyy>/<mm>/<yyyymmdd-HHmm>-<slug>.md` (CORTEX-UX §5.24); a clash gets "-2", "-3" when written. */
export function writtenEntryPath(at: Date, title: string): VaultPath {
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `${CORTEX_PATHS.written}/${at.getFullYear()}/${pad(at.getMonth() + 1)}/${stamp}-${slugify(title, 32)}.md`;
}

// ───────────────────────────── cache (absolute paths, outside OneDrive) ─────────────────────────────

export interface CacheLayout {
  dir: string;
  recordIndex: string;
  recordDelta: string;
  vaultIndex: string;
  /** Shared id → ordinal allocator (lock "cache:ordinals"). */
  ordinals: string;
  /** Entries ledger id → shard + byte range (one-line reader lookups; store/ledger.ts LedgerOffsets). */
  offsets: string;
  /** entry ordinal → read count, models, last date. */
  reads: string;
  searchDir: string;
  signal: string;
  locks: string;
  /** cursors.json, queue.json (machine-local). */
  state: string;
  /** Complete messages of live sessions, staged until sealed. */
  stage: string;
  /** Original text of detected secrets (SAFE-10). */
  held: string;
  /** Optional copies of export files (never in the vault). */
  exports: string;
  /** Aggregates for the ledger reader. */
  agg: string;
  logs: string;
  tmp: string;
  slots(key: string): string;
  /** `stage/<conv>.jsonl`. */
  stageFile(conv: ConversationId): string;
  /** `held/<entry-id>.json`. */
  heldFile(entry: EntryId): string;
}

export function cacheLayout(cacheDir: string): CacheLayout {
  return {
    dir: cacheDir,
    recordIndex: path.join(cacheDir, "record.cxi"),
    recordDelta: path.join(cacheDir, "record.delta.cxi"),
    vaultIndex: path.join(cacheDir, "vault.cxi"),
    ordinals: path.join(cacheDir, "ordinals.cxo"),
    offsets: path.join(cacheDir, "offsets.bin"),
    reads: path.join(cacheDir, "reads.cxr"),
    searchDir: path.join(cacheDir, "search"),
    signal: path.join(cacheDir, "signal.json"),
    locks: path.join(cacheDir, "locks"),
    state: path.join(cacheDir, "state"),
    stage: path.join(cacheDir, "stage"),
    held: path.join(cacheDir, "held"),
    exports: path.join(cacheDir, "exports"),
    agg: path.join(cacheDir, "agg"),
    logs: path.join(cacheDir, "logs"),
    tmp: path.join(cacheDir, "tmp"),
    slots: (key: string) => path.join(cacheDir, `slots-${key}.bin`),
    stageFile: (conv: ConversationId) => {
      assertId(conv, "conversation");
      return path.join(cacheDir, "stage", `${conv}.jsonl`);
    },
    heldFile: (entry: EntryId) => {
      assertId(entry, "entry");
      return path.join(cacheDir, "held", `${entry}.json`);
    },
  };
}

/** Cache-relative paths (for cacheWritablePath). */
export const CACHE_REL = {
  signal: "signal.json",
  offsets: "offsets.bin",
  cursors: "state/cursors.json",
  /** A ledger aggregate (LedgerService): `agg/<name>.json`. */
  agg: (name: "access" | "work" | "unanswered"): string => `agg/${name}.json`,
  stage: (conv: ConversationId): string => {
    assertId(conv, "conversation");
    return `stage/${conv}.jsonl`;
  },
  held: (entry: EntryId): string => {
    assertId(entry, "entry");
    return `held/${entry}.json`;
  },
} as const;

/** File names "Clear local cache" may delete (never a recursive delete; SAFE-02). */
export const CLEARABLE_CACHE_FILES: readonly string[] = ["record.cxi", "record.delta.cxi", "vault.cxi", "vault.cxi.key", "ordinals.cxo", "offsets.bin", "reads.cxr", "signal.json"];
