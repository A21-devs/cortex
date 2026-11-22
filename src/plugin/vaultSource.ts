/**
 * Vault notes as brain items, read from Obsidian's metadataCache (never re-parsing 7,000 files). Owner: E7.
 *
 *  - wiki/** → notes (id w_ + hash(path)); noteKind from the `type` frontmatter through VAULT_TYPE_KIND
 *    (shared/vaultKinds.ts: moc → hub/map, reference → reference, log → log, otherwise wiki). Machine notes
 *    (wiki/derived/, frontmatter cortex_id) are not built here: the record part carries them under their NoteRecord
 *    ids, and links from vault notes to them resolve to those ids. Notes OUTSIDE wiki/ written by the user are
 *    record entries owned by the runner's `vault-notes` importer, not by this builder;
 *  - ordinals come from the shared allocator table (`<cache>/ordinals.cxo`, lock `cache:ordinals`) so a rebuild
 *    never moves an existing point (INDEX-DELTA-CONTRACT);
 *  - respects Obsidian's Excluded files (`userIgnoreFilters`: agents/, commands/, hooks/, skills/, _templates/,
 *    root docs) and settings.sources.vault.excludeFolders; Settings › Sources › vault off builds an empty part;
 *  - `status: reference` → ItemFlag.Reference (hidden unless Layers › Reference); `layer` → the layer column (the
 *    depth key for vault notes); created/updated/date → the note's date (medium evidence, day level); `related`
 *    and resolvedLinks → noteLinks (undirected, each pair stored in both directions, deduplicated);
 *  - space = spaceOfWikiPath (your wiki folders from settings first, then the longest-prefix area table, then folder
 *    names); words are estimated from the file size (the text is not read here);
 *  - built in time slices (≤ 8 ms, then yield to the host) and cached to <cache>/vault.cxi keyed by (file count,
 *    newest mtime, settings, area rules); refreshed on metadataCache "changed"/"resolved", vault
 *    "create"/"rename"/"delete" and a change of your wiki folders' areas (watchWikiAreas).
 */
import type { ReadonlySignal } from "@preact/signals-core";
import type { App, EventRef, TAbstractFile, TFile } from "obsidian";
import { ItemFlag, ItemKind, Population, type ConversationRow } from "../shared/index-format";
import { encodeIndex, type IndexItemInput } from "../shared/indexCodec";
import { wikiNoteId } from "../shared/ids";
import type { CortexSettings } from "../shared/settings";
import { AREA_RULES_VERSION, spaceOfWikiPath } from "../shared/spaces";
import { vaultNoteKind } from "../shared/vaultKinds";
import { readCacheBuffer, withOrdinals, writeCacheFile } from "../store/indexBuilder";
import { cacheLayout, type StoreContext } from "../store/layout";
import type { NoteKind } from "../shared/types";

export interface VaultNoteInfo {
  path: string;
  id: string;
  title: string;
  isDerived: boolean;
  isRecord: boolean;
}

/** The part of `App` this module needs (tests pass a hand-made one). */
export type VaultApp = Pick<App, "vault" | "metadataCache">;

export const WIKI_ROOT = "wiki/";
export const DERIVED_ROOT = "wiki/derived/";
export const SLICE_MS = 8;

const matcherCache = new Map<string, RegExp | null>();

function filterRegex(f: string): RegExp | null {
  if (matcherCache.has(f)) return matcherCache.get(f) ?? null;
  let re: RegExp | null = null;
  const m = /^\/(.+)\/([a-z]*)$/.exec(f);
  if (m) {
    try {
      re = new RegExp(m[1] ?? "", (m[2] ?? "").replace(/[^dgimsuy]/g, ""));
    } catch {
      re = null;
    }
  }
  matcherCache.set(f, re);
  return re;
}

/** Obsidian's Excluded files: a `/regex/` or text the path contains; a trailing slash names a folder. */
export function isIgnoredPath(path: string, ignoreFilters: readonly string[], extra: readonly string[]): boolean {
  for (const f of [...ignoreFilters, ...extra]) {
    if (typeof f !== "string" || f.length === 0) continue;
    const re = filterRegex(f);
    if (re) {
      if (re.test(path)) return true;
    } else if (f.endsWith("/")) {
      if (path.startsWith(f) || path.includes(`/${f}`)) return true;
    } else if (path === f || path.includes(f)) return true;
  }
  return false;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function dayTime(v: unknown): number | undefined {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : undefined;
  const s = asString(v);
  if (!s) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) {
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
    return Number.isFinite(t) ? t : undefined;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

function wikiLinkTarget(v: unknown): string | undefined {
  const s = asString(v);
  if (!s) return undefined;
  const m = /^\[\[([^\]|#]+)/.exec(s);
  return (m ? m[1] : s)?.trim() || undefined;
}

function frontmatterOf(app: VaultApp, file: TFile): Record<string, unknown> {
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  return fm && typeof fm === "object" ? (fm as Record<string, unknown>) : {};
}

/** Machine-note id behind a vault path (frontmatter cortex_id), or null for an ordinary note. */
function machineIdOf(fm: Record<string, unknown>): string | null {
  const id = asString(fm.cortex_id);
  return id && /^n_[a-z2-7]{16}$/.test(id) ? id : null;
}

/** Which vault files are brain items (and which of those are the user's own wiki notes). */
export function listVaultNotes(app: VaultApp, settings: Pick<CortexSettings, "sources">): TFile[] {
  if (!settings.sources.vault.enabled) return [];
  const filters = ignoreFiltersOf(app);
  const extra = settings.sources.vault.excludeFolders;
  return app.vault
    .getMarkdownFiles()
    .filter((f) => f.path.startsWith(WIKI_ROOT) && !f.path.startsWith(DERIVED_ROOT) && !isIgnoredPath(f.path, filters, extra))
    .filter((f) => machineIdOf(frontmatterOf(app, f)) === null)
    .sort((a, b) => a.stat.ctime - b.stat.ctime || (a.path < b.path ? -1 : 1));
}

function ignoreFiltersOf(app: VaultApp): string[] {
  const getConfig = (app.vault as unknown as { getConfig?: (k: string) => unknown }).getConfig;
  const v = typeof getConfig === "function" ? getConfig.call(app.vault, "userIgnoreFilters") : undefined;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** What a rebuild of vault.cxi depends on: the file set and its newest change, plus the settings that filter and place it. */
export function vaultCacheKey(app: VaultApp, settings: Pick<CortexSettings, "sources" | "wikiAreas">): string {
  const files = listVaultNotes(app, settings);
  let newest = 0;
  for (const f of files) newest = Math.max(newest, f.stat.mtime);
  // The area rules too (their version and your wiki folders' areas): a part built when a folder fell into Vault, or
  // into another area, is rebuilt once its folder has an area of its own.
  return JSON.stringify([files.length, newest, settings.sources.vault.enabled, settings.sources.vault.excludeFolders, ignoreFiltersOf(app), AREA_RULES_VERSION, settings.wikiAreas]);
}

export interface VaultBuildOptions {
  store: Pick<StoreContext, "cacheDir" | "owner" | "lockStaleMs">;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** Yield to the host between slices (default: a macrotask). */
  yieldNow?: () => Promise<void>;
  now?: () => number;
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function ageOf(file: TFile): number {
  return file.stat.ctime > 0 ? file.stat.ctime : file.stat.mtime;
}

/** Build the vault part of the index (ArrayBuffer in DataIndex binary format). Time-sliced. */
export async function buildVaultIndex(app: VaultApp, settings: CortexSettings, opts: VaultBuildOptions): Promise<ArrayBuffer> {
  const now = opts.now ?? Date.now;
  const pause = opts.yieldNow ?? defaultYield;
  const files = listVaultNotes(app, settings);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const idOfPath = (p: string): string | null => {
    const f = byPath.get(p);
    if (f) return wikiNoteId(f.path);
    if (!p.startsWith(DERIVED_ROOT)) return null;
    const derived = app.vault.getAbstractFileByPath(p);
    return derived && "extension" in derived ? machineIdOf(frontmatterOf(app, derived as TFile)) : null;
  };

  const { value: ordinals, table } = await withOrdinals(opts.store, {}, (t) => {
    const out = new Map<string, number>();
    for (const f of files) out.set(f.path, t.allocate(wikiNoteId(f.path)));
    return out;
  });
  void ordinals;

  const items: IndexItemInput[] = [];
  const noteLinks = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    if (a === b) return;
    const la = noteLinks.get(a) ?? [];
    if (!la.includes(b)) la.push(b);
    noteLinks.set(a, la);
    const lb = noteLinks.get(b) ?? [];
    if (!lb.includes(a)) lb.push(a);
    noteLinks.set(b, lb);
  };
  let sliceStart = now();
  let done = 0;
  for (const f of files) {
    if (opts.signal?.aborted) throw new DOMException("vault index build cancelled", "AbortError");
    const fm = frontmatterOf(app, f);
    const id = wikiNoteId(f.path);
    const rel = f.path.slice(WIKI_ROOT.length);
    const kind: NoteKind = vaultNoteKind(fm.type, fm.status);
    const t = dayTime(fm.created) ?? dayTime(fm.date) ?? dayTime(fm.updated);
    const slash = rel.lastIndexOf("/");
    const space = spaceOfWikiPath(rel, settings.wikiAreas);
    let flags = 0;
    if (t === undefined) flags |= ItemFlag.Undated;
    if (kind === "reference" || asString(fm.status)?.toLowerCase() === "reference") flags |= ItemFlag.Reference;
    if (space === "none") flags |= ItemFlag.NoArea;
    const layer = typeof fm.layer === "number" ? fm.layer : Number(fm.layer);
    const item: IndexItemInput = {
      id,
      kind: ItemKind.NoteWiki,
      pop: Population.Note,
      source: "obsidian",
      speaker: "you",
      space,
      folderPath: slash > 0 ? rel.slice(0, slash) : "",
      tAdded: ageOf(f),
      chars: f.stat.size,
      words: Math.round(f.stat.size / 6),
      flags,
      title: asString(fm.title) ?? f.basename,
      noteKind: kind,
      ordinal: table.get(id),
    };
    if (t !== undefined) item.t = t;
    if (Number.isInteger(layer) && layer >= 0 && layer < 255) item.layer = layer;
    const project = asString(fm.project);
    if (project) item.project = project;
    items.push(item);

    const resolved = app.metadataCache.resolvedLinks?.[f.path];
    if (resolved) {
      for (const target of Object.keys(resolved)) {
        const other = idOfPath(target);
        if (other) link(id, other);
      }
    }
    const related = fm.related;
    for (const r of Array.isArray(related) ? related : related === undefined ? [] : [related]) {
      const name = wikiLinkTarget(r);
      if (!name) continue;
      const dest = app.metadataCache.getFirstLinkpathDest(name, f.path);
      const other = dest ? idOfPath(dest.path) : null;
      if (other) link(id, other);
    }
    done++;
    if (now() - sliceStart >= SLICE_MS) {
      opts.onProgress?.(done, files.length);
      await pause();
      sliceStart = now();
    }
  }
  opts.onProgress?.(files.length, files.length);
  const conversations: ConversationRow[] = [];
  return encodeIndex({
    part: "vault",
    seq: 0,
    items,
    conversations,
    noteSources: new Map(),
    hubMembers: new Map(),
    noteLinks,
    labels: [],
    epoch: table.epoch,
    count: table.size,
    builtAt: new Date(now()).toISOString(),
    ordinalOf: (id) => {
      const o = table.get(id);
      return o >= 0 ? o : undefined;
    },
  });
}

/** The cached vault part when it still matches this key and the allocator's epoch; null otherwise. */
export async function readVaultCache(cacheDir: string, key: string, epoch: string): Promise<ArrayBuffer | null> {
  const layout = cacheLayout(cacheDir);
  const keyBuf = await readCacheBuffer(`${layout.vaultIndex}.key`);
  if (!keyBuf) return null;
  try {
    const saved = JSON.parse(new TextDecoder().decode(keyBuf)) as { key?: string; epoch?: string };
    if (saved.key !== key || saved.epoch !== epoch) return null;
  } catch {
    return null;
  }
  return readCacheBuffer(layout.vaultIndex);
}

export async function writeVaultCache(cacheDir: string, key: string, epoch: string, part: ArrayBuffer): Promise<void> {
  await writeCacheFile(cacheDir, "vault.cxi", new Uint8Array(part));
  await writeCacheFile(cacheDir, "vault.cxi.key", new TextEncoder().encode(JSON.stringify({ key, epoch })));
}

const WATCH_DEBOUNCE_MS = 2000;

/**
 * The notes OUTSIDE wiki/ (the runner's `vault-notes` importer owns them): calls `onChange` when a Markdown note there is
 * created, changed, renamed or deleted, so the clock imports it while Cortex is open. wiki/ notes are left to watchVault
 * (the vault part's own live path); hidden folders (.raw, .vault-meta, .obsidian) raise no vault events. The caller
 * debounces. Returns an unsubscribe function; a host without vault events watches nothing.
 */
export function watchVaultNoteFiles(app: Pick<App, "vault">, onChange: () => void): () => void {
  const vault = app.vault as unknown as { on?(name: string, cb: (...a: never[]) => unknown): EventRef; offref?(ref: EventRef): void };
  if (typeof vault?.on !== "function" || typeof vault.offref !== "function") return () => undefined;
  const outsideWiki = (path: unknown): boolean => typeof path === "string" && path.toLowerCase().endsWith(".md") && !path.startsWith(WIKI_ROOT);
  const seen = (f: TAbstractFile | null | undefined, oldPath?: unknown): void => {
    // A note moved into or out of wiki/ changes both sides: either path outside wiki/ is enough.
    if ((f && outsideWiki(f.path)) || outsideWiki(oldPath)) onChange();
  };
  const refs = (["create", "modify", "delete"] as const).map((name) => (vault.on as NonNullable<typeof vault.on>)(name, ((f: TAbstractFile) => seen(f)) as never));
  refs.push(vault.on("rename", ((f: TAbstractFile, oldPath: string) => seen(f, oldPath)) as never));
  return () => {
    for (const r of refs.splice(0)) vault.offref?.(r);
  };
}

/** Subscribe to vault/metadata changes; returns an unsubscribe function. Changes are batched for 2 s. */
export function watchVault(app: VaultApp, onChange: (files: TFile[]) => void, debounceMs = WATCH_DEBOUNCE_MS): () => void {
  const touched = new Map<string, TFile>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    timer = null;
    const files = [...touched.values()];
    touched.clear();
    if (files.length > 0) {
      try {
        onChange(files);
      } catch {
        // a throwing listener never stops the watch
      }
    }
  };
  const note = (f: TAbstractFile | null | undefined): void => {
    if (!f || !("extension" in f)) return;
    const file = f as TFile;
    if (file.extension !== "md" || !file.path.startsWith(WIKI_ROOT) || file.path.startsWith(DERIVED_ROOT)) return;
    touched.set(file.path, file);
    if (timer === null) timer = setTimeout(flush, debounceMs);
  };
  const refs: { off: () => void }[] = [];
  const on = (src: { on(name: string, cb: (...a: never[]) => unknown): EventRef; offref(ref: EventRef): void }, name: string, cb: (...a: never[]) => unknown): void => {
    if (typeof src?.on !== "function") return; // a host without vault events (tests, headless)
    const ref = src.on(name, cb);
    refs.push({ off: () => src.offref(ref) });
  };
  const mc = app.metadataCache as unknown as Parameters<typeof on>[0];
  const vault = app.vault as unknown as Parameters<typeof on>[0];
  on(mc, "changed", ((f: TAbstractFile) => note(f)) as never);
  on(mc, "resolved", (() => {
    // Links resolved after a bulk change: touch every note already waiting so the batch is rebuilt once.
    if (touched.size > 0 && timer === null) timer = setTimeout(flush, debounceMs);
  }) as never);
  on(vault, "create", ((f: TAbstractFile) => note(f)) as never);
  on(vault, "delete", ((f: TAbstractFile) => note(f)) as never);
  on(vault, "rename", ((f: TAbstractFile) => note(f)) as never);
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    touched.clear();
    for (const r of refs.splice(0)) r.off();
  };
}

/**
 * Your wiki folders' areas (settings `wikiAreas`) changed: the vault part must be built again, as after a vault edit,
 * because the notes' areas come from them. Calls `onChange` once the rows have stopped changing for `debounceMs` (typing a
 * folder saves on every key); any other settings change, and the value the part was built with, call nothing. Settings
 * without a signal (a plain object in tests) are not watched. Returns an unsubscribe function.
 */
export function watchWikiAreas(settings: { readonly signal?: ReadonlySignal<Pick<CortexSettings, "wikiAreas">> }, onChange: () => void, debounceMs = WATCH_DEBOUNCE_MS): () => void {
  const sig = settings.signal;
  if (!sig) return () => undefined;
  let last = JSON.stringify(sig.peek().wikiAreas);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = sig.subscribe((s) => {
    const next = JSON.stringify(s.wikiAreas);
    if (next === last) return;
    last = next;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        onChange();
      } catch {
        // a throwing listener never stops the watch
      }
    }, debounceMs);
  });
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    stop();
  };
}
