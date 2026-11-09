/**
 * Import cursors. Owner: E2.
 * Machine-local (LOCKS-SHARED-SYNCED): `<cache>/state/cursors.json`, keyed by absolute local paths, rewritten
 * atomically under the local lock after each import batch. Losing it costs only a re-scan: entry ids are stable,
 * the importer dedupes against the ledger, and segment numbers come from the conversation folder. A damaged file
 * therefore reads as empty (never as an error), and malformed rows are dropped one by one.
 */
import { readJsonIfExists, writeJsonAtomic } from "../node/fsAtomic";
import { locksDirOf, withLock } from "../node/locks";
import { cacheWritablePath } from "../node/paths";
import type { CursorState, FileCursor } from "../shared/types";
import { CACHE_REL, cacheLayout, type StoreContext } from "./layout";
import * as path from "node:path";

export function emptyCursorState(): CursorState {
  return { v: 1, files: {} };
}

function cursorsAbs(ctx: Pick<StoreContext, "cacheDir">): string {
  return path.join(cacheLayout(ctx.cacheDir).state, "cursors.json");
}

const nonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** A cursor row as stored, or null when any field is unusable. */
export function validCursor(v: unknown): FileCursor | null {
  if (v === null || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  if (typeof c.path !== "string" || c.path.length === 0) return null;
  if (!nonNegInt(c.size) || !nonNegInt(c.offset) || !nonNegInt(c.line) || !nonNegInt(c.emitted)) return null;
  if (typeof c.mtimeMs !== "number" || !Number.isFinite(c.mtimeMs)) return null;
  if (c.offset > c.size) return null;
  if (typeof c.updatedAt !== "string") return null;
  const out: FileCursor = { path: c.path, size: c.size, mtimeMs: c.mtimeMs, offset: c.offset, line: c.line, emitted: c.emitted, updatedAt: c.updatedAt };
  if (typeof c.lastUuid === "string") out.lastUuid = c.lastUuid;
  if (typeof c.conv === "string" && /^c_[a-z2-7]{16}$/.test(c.conv)) out.conv = c.conv as FileCursor["conv"];
  return out;
}

function sanitize(raw: unknown): CursorState {
  const out = emptyCursorState();
  if (raw === null || typeof raw !== "object") return out;
  const s = raw as { v?: unknown; files?: unknown };
  if (s.v !== 1 || s.files === null || typeof s.files !== "object") return out;
  for (const [k, v] of Object.entries(s.files as Record<string, unknown>)) {
    const c = validCursor(v);
    if (c) out.files[k] = c;
  }
  return out;
}

async function readState(ctx: Pick<StoreContext, "cacheDir">): Promise<CursorState> {
  try {
    return sanitize(await readJsonIfExists<unknown>(cursorsAbs(ctx)));
  } catch {
    return emptyCursorState();
  }
}

export async function loadCursors(ctx: Pick<StoreContext, "cacheDir">): Promise<CursorState> {
  return readState(ctx);
}

function lockOpts(ctx: StoreContext) {
  return { owner: ctx.owner, staleMs: ctx.lockStaleMs };
}

/**
 * Merge `updates` into the stored state under the cursors lock (concurrent runners never lose updates). A cursor
 * replaces the stored one when it moved forward, or when the file was truncated or replaced (smaller size, or
 * an offset reset to 0 for a different mtime): a slower runner can never move a cursor backwards.
 */
export async function saveCursors(ctx: StoreContext, updates: Record<string, FileCursor>): Promise<CursorState> {
  return withLock(locksDirOf(ctx.cacheDir), "state:cursors", lockOpts(ctx), async () => {
    const cur = await readState(ctx);
    for (const [k, raw] of Object.entries(updates)) {
      const v = validCursor(raw);
      if (!v) continue;
      const prev = cur.files[k];
      const replaced = prev !== undefined && (v.size < prev.size || (v.offset === 0 && v.mtimeMs !== prev.mtimeMs));
      if (!prev || v.offset >= prev.offset || replaced) cur.files[k] = v;
    }
    await writeJsonAtomic(cacheWritablePath(ctx.cacheDir, CACHE_REL.cursors), cur);
    return cur;
  });
}

/** Forget cursors (a removed source, a file that no longer exists). */
export async function removeCursors(ctx: StoreContext, keys: readonly string[]): Promise<CursorState> {
  return withLock(locksDirOf(ctx.cacheDir), "state:cursors", lockOpts(ctx), async () => {
    const cur = await readState(ctx);
    let changed = false;
    for (const k of keys) {
      if (k in cur.files) {
        delete cur.files[k];
        changed = true;
      }
    }
    if (changed) await writeJsonAtomic(cacheWritablePath(ctx.cacheDir, CACHE_REL.cursors), cur);
    return cur;
  });
}

/** Decide how to read a file given its cursor: from scratch (truncated/replaced), from offset, or skip. */
export function cursorPlan(cursor: FileCursor | undefined, size: number, mtimeMs: number): { from: number; reset: boolean } | null {
  if (!cursor) return { from: 0, reset: true };
  if (size < cursor.offset || size < cursor.size) return { from: 0, reset: true };
  if (size === cursor.size && mtimeMs === cursor.mtimeMs) return null;
  if (size === cursor.offset) return null;
  return { from: cursor.offset, reset: false };
}
