/**
 * Pinned views (CORTEX-UX §7.4, P2): "Pin view…" stores the whole leaf state (shape, chart, zones, sorts, local
 * combines, colours, layers, scope, period, camera) under a name in `.vault-meta/cortex/views.json`, written
 * atomically under a local lock. They appear in Read › Pinned only with Copy link
 * (`obsidian://cortex?view=<id>`; opening a link only navigates). Loaded states are validated by
 * state/persist.ts before use. Owner: E1.
 *
 *  - Pinning under a name that already exists (case-insensitive) updates that view and keeps its id, so a copied
 *    link keeps working.
 *  - Rows this version cannot read are kept in the file untouched (a newer Cortex on another computer may have
 *    written them); nothing is deleted except by remove().
 *  - An unreadable views.json is never overwritten: it is kept next to it as `views.unreadable-<time>.json`
 *    before a new file is written. OneDrive conflict copies are never merged.
 */
import { CortexError } from "../shared/errors";
import { sortableBody } from "../shared/ids";
import type { Logger } from "../shared/log";
import type { PinnedViewRecord } from "../shared/types";
import { ensureCacheDir, ensureCortexRoots, readTextIfExists, writeFileAtomic, writeJsonAtomic } from "../node/fsAtomic";
import { DEFAULT_STALE_MS, locksDirOf, withLock } from "../node/locks";
import { resolveInVault, writablePath } from "../node/paths";
import { CORTEX_PATHS, pinnedViewsPath } from "../store/layout";
import type { PinnedViewService } from "./services";

/** Pinned view ids: "v_" + 16 base32 characters (accepted by the link parser and Ask's `pin`). */
export const PINNED_VIEW_ID = /^v_[a-z2-7]{16}$/;
export const MAX_VIEW_NAME = 120;
export const MAX_VIEW_STATE_BYTES = 256 * 1024;
export const MAX_PINNED_VIEWS = 500;

export interface PinnedViewsFile {
  v: 1;
  views: unknown[];
}

export interface PinnedViewDeps {
  vaultRoot: string;
  cacheDir: string;
  log: Logger;
  now?: () => number;
  lockStaleMs?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A stored row this version understands, or null. */
export function parsePinnedView(raw: unknown): PinnedViewRecord | null {
  if (!isRecord(raw)) return null;
  const { id, name, state, at } = raw;
  if (typeof id !== "string" || !PINNED_VIEW_ID.test(id)) return null;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > MAX_VIEW_NAME) return null;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return null;
  if (!isRecord(state)) return null;
  return { id, name, state, at };
}

/** Normalise a view name: single spaces, trimmed, at most 120 characters; throws when empty. */
export function cleanViewName(name: string): string {
  const n = String(name).replace(/\s+/g, " ").trim();
  if (n.length === 0) throw new CortexError("E_BAD_REQUEST", "a pinned view needs a name");
  return n.length > MAX_VIEW_NAME ? n.slice(0, MAX_VIEW_NAME).trimEnd() : n;
}

type Loaded = { kind: "ok"; rows: unknown[] } | { kind: "absent" } | { kind: "unreadable"; text: string };

function stamp(t: number): string {
  return new Date(t).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

export function createPinnedViewService(deps: PinnedViewDeps): PinnedViewService {
  const now = deps.now ?? (() => Date.now());
  const file = (): string => resolveInVault(deps.vaultRoot, pinnedViewsPath());

  const load = async (): Promise<Loaded> => {
    const text = await readTextIfExists(file());
    if (text === null) return { kind: "absent" };
    try {
      const v = JSON.parse(text) as unknown;
      if (isRecord(v) && v.v === 1 && Array.isArray(v.views)) return { kind: "ok", rows: v.views };
      return { kind: "unreadable", text };
    } catch {
      return { kind: "unreadable", text };
    }
  };

  const readable = async (): Promise<PinnedViewRecord[]> => {
    const l = await load();
    if (l.kind === "unreadable") {
      deps.log.warn("views.json is unreadable; pinned views are hidden until it is fixed");
      return [];
    }
    if (l.kind === "absent") return [];
    const out: PinnedViewRecord[] = [];
    for (const r of l.rows) {
      const p = parsePinnedView(r);
      if (p) out.push(p);
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  };

  /** Read-modify-write under the local lock; `change` returns the new rows and a result. */
  const mutate = async <T>(change: (rows: unknown[]) => { rows: unknown[]; result: T }): Promise<T> => {
    await ensureCortexRoots(deps.vaultRoot, [CORTEX_PATHS.meta]);
    await ensureCacheDir(deps.cacheDir);
    return withLock(locksDirOf(deps.cacheDir), "state:views", { owner: "plugin", staleMs: deps.lockStaleMs ?? DEFAULT_STALE_MS }, async (lock) => {
      const l = await load();
      let rows: unknown[] = [];
      if (l.kind === "ok") rows = l.rows;
      else if (l.kind === "unreadable") {
        const aside = writablePath(deps.vaultRoot, `${CORTEX_PATHS.meta}/views.unreadable-${stamp(now())}.json`);
        await writeFileAtomic(aside, l.text);
        deps.log.warn("kept an unreadable views.json aside before writing a new one");
      }
      const { rows: next, result } = change(rows);
      if (!(await lock.verify())) throw new CortexError("E_LOCKED", "lost the pinned views lock", { retryable: true });
      const body: PinnedViewsFile = { v: 1, views: next };
      await writeJsonAtomic(writablePath(deps.vaultRoot, pinnedViewsPath()), body);
      return result;
    });
  };

  return {
    list: () => readable(),
    async get(id) {
      if (!PINNED_VIEW_ID.test(id)) return undefined;
      return (await readable()).find((v) => v.id === id);
    },
    async save(name, state) {
      const clean = cleanViewName(name);
      if (!isRecord(state)) throw new CortexError("E_BAD_REQUEST", "a pinned view stores a view state object");
      const json = JSON.stringify(state);
      if (typeof json !== "string" || json.length > MAX_VIEW_STATE_BYTES) throw new CortexError("E_BAD_REQUEST", "this view is too large to pin");
      const stored = JSON.parse(json) as Record<string, unknown>;
      return mutate((rows) => {
        const at = new Date(now()).toISOString();
        const key = clean.toLowerCase();
        const i = rows.findIndex((r) => {
          const p = parsePinnedView(r);
          return p !== null && p.name.toLowerCase() === key;
        });
        if (i >= 0) {
          const prev = parsePinnedView(rows[i]) as PinnedViewRecord;
          const rec: PinnedViewRecord = { id: prev.id, name: clean, state: stored, at };
          const next = [...rows];
          next[i] = rec;
          return { rows: next, result: rec };
        }
        if (rows.length >= MAX_PINNED_VIEWS) throw new CortexError("E_BAD_REQUEST", `at most ${MAX_PINNED_VIEWS} pinned views`);
        const rec: PinnedViewRecord = { id: `v_${sortableBody(now())}`, name: clean, state: stored, at };
        return { rows: [...rows, rec], result: rec };
      });
    },
    async remove(id) {
      if (!PINNED_VIEW_ID.test(id)) return;
      const current = await load();
      if (current.kind !== "ok" || !current.rows.some((r) => parsePinnedView(r)?.id === id)) return;
      await mutate((rows) => ({ rows: rows.filter((r) => parsePinnedView(r)?.id !== id), result: undefined }));
    },
  };
}
