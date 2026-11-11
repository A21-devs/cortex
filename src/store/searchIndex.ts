/**
 * Builds the search shards under `<cache>/search/` in the runner (format: shared/searchCodec.ts). Owner: E7.
 *
 * One immutable shard per closed entries-ledger shard (`e-<yyyy-mm>-<nnnnnn>.cxs`, built once per epoch), a
 * `vault.cxs` for the vault's wiki notes (rebuilt only when a file was added, removed or changed) and a small
 * `live.cxs` that is rebuilt every time: the open ledger shard, machine notes, entries corrected by you (their
 * current wording) and an empty document for everything you left out, so later shards mask earlier ones.
 * Documents carry the ordinal of the shared allocator (the merged DataIndex), so entries and notes mix.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { CancelToken } from "../shared/cancel";
import { exclusionMatcher, foldCorrections } from "../shared/correctionsFold";
import { wikiNoteId } from "../shared/ids";
import { decodeSearchIndex, encodeSearchIndex, readSearchHeader, type SearchDocInput, type SearchShard } from "../shared/searchCodec";
import { hubBodyText, type EntryRecord, type NoteRecord } from "../shared/types";
import { ensureCacheDir } from "../node/fsAtomic";
import { isCacheDirRegistered, resolveInVault } from "../node/paths";
import { cacheLayout, type StoreContext } from "./layout";
import { latestBySeq, listLedgerFiles, streamJsonl, type LedgerStore } from "./ledger";
import { readCacheBuffer, withOrdinals, writeCacheFile } from "./indexBuilder";
import { SegmentCache, readText } from "./segments";
import { writeSignal } from "./signal";
import { stageLookup } from "./stage";

export interface SearchBuildDeps {
  store: StoreContext;
  ledger: LedgerStore;
  token: CancelToken;
  progress(done: number, total?: number): void;
  yield(): Promise<void>;
}

export const LIVE_SHARD = "live";
export const VAULT_SHARD = "vault";
const YIELD_EVERY = 400;

/** Strip frontmatter and read a `title:` line (the vault's notes use plain `key: value` lines). */
export function splitNote(text: string): { title: string | undefined; body: string } {
  if (!text.startsWith("---")) return { title: undefined, body: text };
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { title: undefined, body: text };
  const t = /^title:\s*(.+)$/m.exec(m[1] ?? "");
  const title = t ? (t[1] ?? "").trim().replace(/^["']|["']$/g, "") : undefined;
  return { title: title || undefined, body: text.slice(m[0].length) };
}

interface WikiFile {
  path: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

/** wiki/** markdown files, except the machine notes (wiki/derived/ is covered by the notes ledger). */
async function listWikiFiles(vaultRoot: string, token: CancelToken): Promise<WikiFile[]> {
  const out: WikiFile[] = [];
  const walk = async (rel: string): Promise<void> => {
    token.throwIfCancelled();
    let names: import("node:fs").Dirent[];
    try {
      names = await fsp.readdir(resolveInVault(vaultRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      const child = `${rel}/${d.name}`;
      if (d.isDirectory()) {
        if (child === "wiki/derived" || d.name.startsWith(".")) continue;
        await walk(child);
      } else if (d.isFile() && /\.md$/i.test(d.name)) {
        try {
          const abs = resolveInVault(vaultRoot, child);
          const st = await fsp.stat(abs);
          out.push({ path: child, abs, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // a file that vanished while listing is simply not there
        }
      }
    }
  };
  await walk("wiki");
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The note text for search: title, body statements of a map's brief and typed sections, the machine sentence. */
export function machineNoteDoc(n: NoteRecord): { title: string; body: string } {
  const brief = n.hub ? hubBodyText(n.hub) : "";
  return { title: n.title, body: [n.text, brief].filter((s) => s.length > 0).join("\n") };
}

export async function buildSearchIndex(deps: SearchBuildDeps): Promise<{ file: string; terms: number; docs: number }> {
  const { store, ledger, token } = deps;
  if (!isCacheDirRegistered(store.cacheDir)) await ensureCacheDir(store.cacheDir);
  const layout = cacheLayout(store.cacheDir);
  const searchRel = (key: string): string => `search/${key}.cxs`;
  const builtAt = new Date().toISOString();
  const seq = await ledger.seq();

  const corrections = await ledger.readCorrections();
  const eff = foldCorrections(corrections);
  const excludedBy = exclusionMatcher(eff);
  const notes = [...latestBySeq((await collectAll(ledger.readAll("notes")))).values()];
  const wiki = await listWikiFiles(store.vaultRoot, token);

  // Ordinals: entries and notes by lookup (the index build allocated them), wiki notes allocated here if new.
  const { value: ords, table } = await withOrdinals(store, {}, (t) => {
    for (const n of notes) t.allocate(n.id);
    for (const f of wiki) t.allocate(wikiNoteId(f.path));
    return t;
  });
  void ords;
  const epoch = table.epoch;
  const cache = new SegmentCache(store.vaultRoot, 16);
  const stage = stageLookup(store);

  const textOf = async (e: EntryRecord): Promise<string> => {
    const r = await readText(store.vaultRoot, e.text, e.text.store === "file" ? e.textSha256 : "", { cache, stage, entryId: e.id });
    return r.ok ? r.text : "";
  };

  const files = await listLedgerFiles(store.vaultRoot, "entries");
  const live: SearchDocInput[] = [];
  let termsTotal = 0;
  let docsTotal = 0;
  const total = files.length + 2;

  const keepShard = async (key: string, docs: Iterable<SearchDocInput>): Promise<{ terms: number; docs: number }> => {
    const buf = encodeSearchIndex(docs, { seq, builtAt, epoch, key });
    await writeCacheFile(store.cacheDir, searchRel(key), new Uint8Array(buf));
    const h = readSearchHeader(buf);
    return { terms: h.terms, docs: h.docs };
  };

  const fresh = async (key: string): Promise<boolean> => {
    const buf = await readCacheBuffer(path.join(layout.searchDir, `${key}.cxs`));
    if (!buf) return false;
    try {
      return readSearchHeader(buf).epoch === epoch;
    } catch {
      return false;
    }
  };

  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const closed = i < files.length - 1;
    const key = `e-${f.month}-${path.basename(f.abs, ".jsonl")}`;
    const build = closed ? !(await fresh(key)) : true;
    const docs: SearchDocInput[] = [];
    let n = 0;
    for await (const e of streamJsonl<EntryRecord>(f.abs)) {
      if (++n % YIELD_EVERY === 0) {
        token.throwIfCancelled();
        await deps.yield();
      }
      const ordinal = table.get(e.id);
      if (ordinal < 0) continue;
      const rule = excludedBy({ id: e.id, source: e.source, folder: e.folder, path: e.sourceRef.path, ...(e.conv !== undefined ? { conv: e.conv } : {}), ...(e.project !== undefined ? { project: e.project } : {}) });
      const edits = eff.edits.get(e.id);
      const edit = edits && edits.length > 0 ? edits[edits.length - 1] : undefined;
      if (rule) {
        live.push({ ordinal, title: "", body: "" });
        continue;
      }
      if (edit) {
        const doc = { ordinal, title: e.title ?? "", body: edit.text };
        if (closed) live.push(doc);
        else docs.push(doc);
        continue;
      }
      if (build) docs.push({ ordinal, title: e.title ?? "", body: await textOf(e) });
    }
    if (closed) {
      if (build) {
        const r = await keepShard(key, docs);
        termsTotal += r.terms;
        docsTotal += r.docs;
      }
    } else {
      live.push(...docs);
    }
    deps.progress(i + 1, total);
  }

  // The vault's wiki notes: one shard, rebuilt when the set of files or any of them changed.
  const signature = fnv(wiki.map((w) => `${w.path}|${w.size}|${Math.floor(w.mtimeMs)}`).join("\n"));
  const vaultKey = VAULT_SHARD;
  const vaultBuf = await readCacheBuffer(path.join(layout.searchDir, `${vaultKey}.cxs`));
  let vaultFresh = false;
  if (vaultBuf) {
    try {
      const h = readSearchHeader(vaultBuf);
      vaultFresh = h.epoch === epoch && (await readSignature(layout.searchDir)) === signature;
    } catch {
      vaultFresh = false;
    }
  }
  if (!vaultFresh) {
    const docs: SearchDocInput[] = [];
    let n = 0;
    for (const f of wiki) {
      if (++n % 50 === 0) {
        token.throwIfCancelled();
        await deps.yield();
      }
      let text = "";
      try {
        text = await fsp.readFile(f.abs, "utf8");
      } catch {
        continue;
      }
      const parts = splitNote(text);
      docs.push({ ordinal: table.get(wikiNoteId(f.path)), title: parts.title ?? path.posix.basename(f.path, ".md"), body: parts.body });
    }
    const r = await keepShard(vaultKey, docs);
    await writeCacheFile(store.cacheDir, "search/vault.sig", new TextEncoder().encode(signature));
    termsTotal += r.terms;
    docsTotal += r.docs;
  }
  deps.progress(files.length + 1, total);

  for (const n of notes) {
    const ordinal = table.get(n.id);
    if (ordinal < 0) continue;
    if (n.state === "excluded" || excludedBy({ id: n.id, source: "obsidian", folder: n.folder, path: n.file, ...(n.conv !== undefined ? { conv: n.conv } : {}) })) live.push({ ordinal, title: "", body: "" });
    else live.push({ ordinal, ...machineNoteDoc(n) });
  }
  const r = await keepShard(LIVE_SHARD, live);
  termsTotal += r.terms;
  docsTotal += r.docs;
  deps.progress(total, total);
  await writeSignal(store.cacheDir, { seq, epoch, changed: ["search-index"], by: store.owner });
  return { file: path.join(layout.searchDir, `${LIVE_SHARD}.cxs`), terms: termsTotal, docs: docsTotal };
}

async function readSignature(searchDir: string): Promise<string | null> {
  try {
    return (await fsp.readFile(path.join(searchDir, "vault.sig"), "utf8")).trim();
  } catch {
    return null;
  }
}

async function collectAll<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** The decoded shards of the last read, kept briefly so a pass of many label jobs reads the files once. */
const STATS_KEEP_MS = 120_000;
let statsKept: { dir: string; stamp: string; shards: SearchShard[]; timer: ReturnType<typeof setTimeout> } | null = null;

async function loadShards(dir: string, names: readonly string[]): Promise<SearchShard[]> {
  const stat = await Promise.all(names.map((n) => fsp.stat(path.join(dir, n)).then((s) => `${n}:${s.size}:${Math.round(s.mtimeMs)}`).catch(() => n)));
  const stamp = stat.join("|");
  if (statsKept && statsKept.dir === dir && statsKept.stamp === stamp) return statsKept.shards;
  if (statsKept) clearTimeout(statsKept.timer);
  statsKept = null;
  const shards: SearchShard[] = [];
  for (const name of names) {
    try {
      const buf = await fsp.readFile(path.join(dir, name));
      shards.push(decodeSearchIndex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer));
    } catch {
      // A shard that cannot be read is skipped: the counts are a hint, never a reason to stop.
    }
  }
  const timer = setTimeout(() => {
    if (statsKept?.timer === timer) statsKept = null;
  }, STATS_KEEP_MS);
  timer.unref?.();
  statsKept = { dir, stamp, shards, timer };
  return shards;
}

/**
 * How common each of `terms` is across the record: the document counts of the local search shards (the "No model"
 * organiser ranks a conversation's words against these). Reads the shard files already on disk (kept for two minutes
 * so one pass reads them once) and looks each word up by binary search; builds nothing and sends nothing. Null when
 * there is no index yet.
 */
export async function readTermStats(cacheDir: string, terms: Iterable<string>): Promise<{ docs: number; df(term: string): number } | null> {
  const dir = cacheLayout(cacheDir).searchDir;
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith(".cxs")).sort();
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  const shards = await loadShards(dir, names);
  const counts = new Map<string, number>();
  let docs = 0;
  for (const shard of shards) {
    docs += shard.docs.length;
    for (const w of new Set(terms)) {
      const i = shard.find(w);
      if (i >= 0) counts.set(w, (counts.get(w) ?? 0) + shard.postings(i).docs.length);
    }
  }
  return docs === 0 ? null : { docs, df: (t) => counts.get(t) ?? 0 };
}
