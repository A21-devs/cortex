/**
 * Change signal between the runner and the plugin (local cache folder, never synced). Owner: E2.
 * After committing ledger writes or rebuilding a cache file, the runner rewrites `<cache>/signal.json`; the
 * plugin watches the cache folder and reloads what changed. Works even when the runner was launched from a
 * Claude Code skill rather than by the plugin. Index rebuilds are debounced to idle time and write deltas
 * (record.delta.cxi) and search shards rather than whole files (REBUILD-PER-IMPORT).
 *
 * Several writes can land between two reads (two runners, a debounced watcher), so the file keeps a write
 * counter `n` and, per kind, the `n` of the last write that named it (`marks`). A reader that remembers the
 * signal it last handled gets every kind changed since with `signalChanges`, however many writes coalesced.
 * Writers serialise on the local lock "cache:signal".
 */
import { watch, type FSWatcher } from "node:fs";
import { promises as fsp } from "node:fs";
import { readJsonIfExists, writeJsonAtomic } from "../node/fsAtomic";
import { DEFAULT_STALE_MS, locksDirOf, withLock } from "../node/locks";
import { cacheWritablePath } from "../node/paths";
import type { IsoDate } from "../shared/types";
import { CACHE_REL, cacheLayout } from "./layout";

export type SignalKind =
  | "entries"
  | "staged"
  | "labels"
  | "notes"
  | "corrections"
  | "runs"
  | "reads"
  | "review"
  | "receipts"
  | "record-index"
  | "record-delta"
  /** A build found nothing to change: the record index is current up to this write (no file was rewritten). */
  | "record-checked"
  | "search-index"
  | "budget"
  | "control";

export const SIGNAL_KINDS: readonly SignalKind[] = ["entries", "staged", "labels", "notes", "corrections", "runs", "reads", "review", "receipts", "record-index", "record-delta", "record-checked", "search-index", "budget", "control"];

export interface CacheSignal {
  v: 1;
  /** Ledger seq at the time of the signal (never decreases). */
  seq: number;
  /** Ordinal epoch of the record index. */
  epoch?: string;
  at: IsoDate;
  /** What this write changed. */
  changed: SignalKind[];
  by: string;
  /** Write counter (starts again at 1 after the cache folder was cleared). */
  n: number;
  /** Per kind, the `n` of the last write that changed it. */
  marks: Partial<Record<SignalKind, number>>;
}

const isKind = (k: unknown): k is SignalKind => typeof k === "string" && (SIGNAL_KINDS as readonly string[]).includes(k);

function sanitize(raw: unknown): CacheSignal | null {
  if (raw === null || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (s.v !== 1 || typeof s.seq !== "number" || !Number.isFinite(s.seq) || typeof s.at !== "string") return null;
  const changed = Array.isArray(s.changed) ? s.changed.filter(isKind) : [];
  const n = typeof s.n === "number" && Number.isSafeInteger(s.n) && s.n >= 0 ? s.n : 0;
  const marks: Partial<Record<SignalKind, number>> = {};
  if (s.marks !== null && typeof s.marks === "object") {
    for (const [k, v] of Object.entries(s.marks as Record<string, unknown>)) if (isKind(k) && typeof v === "number" && Number.isSafeInteger(v)) marks[k] = v;
  }
  const out: CacheSignal = { v: 1, seq: s.seq, at: s.at, changed, by: typeof s.by === "string" ? s.by : "", n, marks };
  if (typeof s.epoch === "string") out.epoch = s.epoch;
  return out;
}

/** The current signal, or null when there is none (or it is unreadable: the next write repairs it). */
export async function readSignal(cacheDir: string): Promise<CacheSignal | null> {
  try {
    return sanitize(await readJsonIfExists<unknown>(cacheLayout(cacheDir).signal));
  } catch {
    return null;
  }
}

/** The cache folder must have been opened with ensureCacheDir (marker + registration). Returns what was written. */
export async function writeSignal(cacheDir: string, sig: { seq: number; epoch?: string; changed: readonly SignalKind[]; by: string }): Promise<CacheSignal> {
  return withLock(locksDirOf(cacheDir), "cache:signal", { owner: sig.by || "cortex", staleMs: DEFAULT_STALE_MS }, async () => {
    const prev = await readSignal(cacheDir);
    const n = (prev?.n ?? 0) + 1;
    const changed = [...new Set(sig.changed.filter(isKind))];
    const marks: Partial<Record<SignalKind, number>> = { ...(prev?.marks ?? {}) };
    for (const k of changed) marks[k] = n;
    const next: CacheSignal = { v: 1, seq: Math.max(prev?.seq ?? 0, Number.isFinite(sig.seq) ? sig.seq : 0), at: new Date().toISOString(), changed, by: sig.by, n, marks };
    const epoch = sig.epoch ?? prev?.epoch;
    if (epoch !== undefined) next.epoch = epoch;
    await writeJsonAtomic(cacheWritablePath(cacheDir, CACHE_REL.signal), next);
    return next;
  });
}

/**
 * Kinds changed between the signal a reader handled last and the current one. Everything counts as changed when
 * there was no previous signal, the counter restarted (cache cleared) or the index epoch changed.
 */
export function signalChanges(prev: CacheSignal | null, next: CacheSignal): SignalKind[] {
  if (!prev || next.n < prev.n || (prev.epoch !== undefined && next.epoch !== undefined && prev.epoch !== next.epoch)) return [...SIGNAL_KINDS];
  if (next.n === prev.n) return [];
  return SIGNAL_KINDS.filter((k) => (next.marks[k] ?? 0) > (prev.marks[k] ?? 0));
}

export interface SignalWatcher {
  /** Read the signal now (e.g. after the view regains focus); fires the callback when it changed. */
  check(): Promise<void>;
  close(): void;
}

/**
 * Watch `<cache>/signal.json`: fs.watch on the cache folder (debounced) plus a slow poll, because folder watches
 * can miss events (sleep, antivirus, a folder recreated by "Clear local cache"). The callback receives each new
 * signal once with the kinds changed since the previous one it saw; a throwing callback never stops the watch.
 */
export function watchSignal(
  cacheDir: string,
  onSignal: (sig: CacheSignal, changed: SignalKind[]) => void,
  opts: { debounceMs?: number; pollMs?: number; initial?: CacheSignal | null; onError?: (e: unknown) => void } = {},
): SignalWatcher {
  const debounceMs = opts.debounceMs ?? 200;
  const pollMs = opts.pollMs ?? 5000;
  let last: CacheSignal | null | undefined = opts.initial;
  let closed = false;
  let running: Promise<void> | null = null;
  let again = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;

  const run = async (): Promise<void> => {
    const sig = await readSignal(cacheDir);
    if (closed || sig === null) return;
    if (last === undefined) {
      last = sig; // baseline: the caller loaded everything already
      return;
    }
    if (last !== null && sig.n === last.n && sig.at === last.at) return;
    const changed = signalChanges(last, sig);
    last = sig;
    if (changed.length === 0) return;
    try {
      onSignal(sig, changed);
    } catch (e) {
      opts.onError?.(e);
    }
  };

  const check = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = run()
      .catch((e) => opts.onError?.(e))
      .finally(() => {
        running = null;
        if (again && !closed) {
          again = false;
          void check();
        }
      });
    return running;
  };

  const startWatch = () => {
    if (closed || watcher) return;
    try {
      watcher = watch(cacheDir, { persistent: false }, (_event, name) => {
        if (name !== null && name !== undefined && !String(name).includes("signal")) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => void check(), debounceMs);
      });
      watcher.on("error", () => {
        watcher?.close();
        watcher = null; // the poll keeps going and re-arms the watch
      });
    } catch {
      watcher = null;
    }
  };

  void fsp.mkdir(cacheDir, { recursive: true }).catch(() => undefined).then(() => {
    startWatch();
    void check();
  });
  const poll = setInterval(() => {
    startWatch();
    void check();
  }, pollMs);
  (poll as { unref?: () => void }).unref?.();

  return {
    check,
    close() {
      closed = true;
      if (debounce) clearTimeout(debounce);
      clearInterval(poll);
      watcher?.close();
      watcher = null;
    },
  };
}
