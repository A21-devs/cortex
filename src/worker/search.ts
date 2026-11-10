/**
 * Search queries inside the worker over the loaded search shards and the DataIndex. Owner: E7.
 * CORTEX-UX §5.9: matching uses titles, text, label values and folder names. AND semantics across terms; the last
 * term matches as a prefix while it is being typed. Ranking: title hits > label and folder hits > body hits,
 * then recency (undated last). Results are filtered by the leaf's visibility (scope, period, Layers, held
 * arrivals, exclusions).
 * A shard only counts when its epoch is the index's epoch and it owns the ordinal (later shards mask earlier
 * ones). Without usable shards (index still building, the sample record) titles are searched instead.
 */
import { ItemFlag, ItemKind, NONE16, NONE32, NONE8, NOTE_KIND_ORDER, Population, SOURCE_ORDER, SPACE_ORDER, type DataIndex } from "../shared/index-format";
import type { SearchParams, SearchResult, VisibilityParams } from "../shared/protocol/worker";
import { FIELD_BODY, FIELD_TITLE, type SearchIndexData, type SearchShard } from "../shared/searchCodec";
import { tokenize } from "../shared/text";

/** Match from a label value or a folder name (scored between title and body). */
export const FIELD_LABEL = 4;
export const FIELD_FOLDER = 8;

/** A prefix that matches more terms than this is cut off (it would read most of the index). */
export const MAX_PREFIX_TERMS = 4096;
/** Rows per group in the results popover. */
export const TOP_ROWS = 5;

/** Normalised query terms (shared tokenizer) with the last term marked as prefix. */
export function parseQuery(q: string): { terms: string[]; prefix: string | null } {
  const raw = q.trim();
  const terms = tokenize(raw);
  const endsWithSpace = /\s$/.test(q);
  if (terms.length === 0) return { terms: [], prefix: null };
  return endsWithSpace ? { terms, prefix: null } : { terms: terms.slice(0, -1), prefix: terms[terms.length - 1] ?? null };
}

// ───────────────────────────── visibility ─────────────────────────────

/** noteKind column value of "hub" (vault maps of content and machine maps). */
export const HUB_NOTE_KIND = NOTE_KIND_ORDER.indexOf("hub");

/**
 * What a leaf shows (VisibilityParams): held arrivals, absent and excluded rows, superseded items, the scope,
 * the period (undated items fall outside any period) and the Layers toggles. Hidden-by-default traffic is shown
 * only when the toggle for its reason is on; harness lines and tool output have no toggle.
 */
export function makeVisibility(index: DataIndex, vis: VisibilityParams): (o: number) => boolean {
  const c = index.cols;
  const scope = vis.scope === "all" ? -1 : SPACE_ORDER.indexOf(vis.scope);
  const p0 = vis.period ? vis.period[0] : Number.NEGATIVE_INFINITY;
  const p1 = vis.period ? vis.period[1] : Number.POSITIVE_INFINITY;
  const hasPeriod = vis.period !== null;
  // revealedCount <= 0 (or missing) means nothing is held (the documented contract; same rule as normaliseVisibility).
  const limit = Number.isFinite(vis.revealedCount) && vis.revealedCount > 0 ? Math.min(index.count, Math.floor(vis.revealedCount)) : index.count;
  return (o: number): boolean => {
    if (!(o >= 0 && o < limit)) return false;
    const kind = c.kind[o]!;
    if (kind === NONE8) return false;
    const f = c.flags[o]!;
    if ((f & (ItemFlag.Excluded | ItemFlag.Superseded)) !== 0) return false;
    if (scope >= 0 && c.space[o] !== scope) return false;
    if (hasPeriod) {
      const t = c.t[o]!;
      if (!(t >= p0 && t <= p1)) return false;
    }
    if ((f & ItemFlag.Reference) !== 0 && !vis.reference) return false;
    if ((f & ItemFlag.Subagent) !== 0 && !vis.subagents) return false;
    if ((f & ItemFlag.AssistantPane) !== 0 && !vis.askHistory) return false;
    if ((f & ItemFlag.Automated) !== 0 && !vis.automated) return false;
    if ((f & ItemFlag.HiddenByDefault) !== 0) {
      const reasons = f & (ItemFlag.Subagent | ItemFlag.AssistantPane | ItemFlag.Automated | ItemFlag.Reference);
      if (reasons === 0) return false;
    }
    if (c.pop[o] === Population.Note) {
      if (kind === ItemKind.NoteHub) return vis.maps;
      if (kind === ItemKind.NoteWiki) return vis.vaultNotes && (c.noteKind[o] !== HUB_NOTE_KIND || vis.maps);
      return vis.notes;
    }
    if (!vis.record) return false;
    if ((f & ItemFlag.Undated) !== 0 && !vis.undatedCloud) return false;
    return true;
  };
}

// ───────────────────────────── per-index caches ─────────────────────────────

interface IndexCaches {
  titleTerms?: Map<string, number[]>;
  labelTokens?: { tokens: string[][] }[];
  folderTokens?: string[][];
}
const CACHES = new WeakMap<DataIndex, IndexCaches>();
function caches(index: DataIndex): IndexCaches {
  let c = CACHES.get(index);
  if (!c) {
    c = {};
    CACHES.set(index, c);
  }
  return c;
}

function titleTerms(index: DataIndex): Map<string, number[]> {
  const cc = caches(index);
  if (cc.titleTerms) return cc.titleTerms;
  const map = new Map<string, number[]>();
  for (let o = 0; o < index.count; o++) {
    if (index.cols.kind[o] === NONE8) continue;
    const seen = new Set<string>();
    for (const t of tokenize(index.titles.get(o))) {
      if (seen.has(t)) continue;
      seen.add(t);
      let l = map.get(t);
      if (!l) {
        l = [];
        map.set(t, l);
      }
      l.push(o);
    }
  }
  cc.titleTerms = map;
  return map;
}

function labelTokens(index: DataIndex): { tokens: string[][] }[] {
  const cc = caches(index);
  cc.labelTokens ??= index.labels.map((l) => ({ tokens: l.values.map((v) => tokenize(v)) }));
  return cc.labelTokens;
}

function folderTokens(index: DataIndex): string[][] {
  const cc = caches(index);
  if (!cc.folderTokens) {
    const out: string[][] = [];
    for (let i = 0; i < index.dicts.folders.size; i++) out.push(tokenize(index.dicts.folders.get(i)));
    cc.folderTokens = out;
  }
  return cc.folderTokens;
}

const termMatches = (tokens: readonly string[], term: string, prefix: boolean): boolean => tokens.some((t) => (prefix ? t.startsWith(term) : t === term));

// ───────────────────────────── matching ─────────────────────────────

/** Shards usable for this index (same non-empty epoch). */
function usableShards(data: SearchIndexData | null, index: DataIndex): { shards: readonly SearchShard[]; owner: (o: number) => number } | null {
  if (!data || data.shards.length === 0) return null;
  if (index.header.epoch === "" || data.header.epoch !== index.header.epoch) return null;
  return { shards: data.shards, owner: (o) => data.owner(o) };
}

/** Ordinal → field mask for one query term across shards, labels and folders. */
function matchTerm(data: SearchIndexData | null, index: DataIndex, term: string, prefix: boolean): Map<number, number> {
  const out = new Map<number, number>();
  const add = (o: number, m: number): void => {
    out.set(o, (out.get(o) ?? 0) | m);
  };
  const usable = usableShards(data, index);
  if (usable) {
    usable.shards.forEach((shard, s) => {
      let from: number;
      let to: number;
      if (prefix) [from, to] = shard.prefixRange(term);
      else {
        from = shard.find(term);
        to = from + 1;
      }
      if (from < 0) return;
      to = Math.min(to, from + MAX_PREFIX_TERMS);
      for (let i = from; i < to; i++) {
        const p = shard.postings(i);
        for (let k = 0; k < p.docs.length; k++) {
          const o = p.docs[k]!;
          if (o < index.count && usable.owner(o) === s) add(o, p.fields[k]! & (FIELD_TITLE | FIELD_BODY));
        }
      }
    });
  } else {
    const tt = titleTerms(index);
    if (prefix) {
      for (const [t, list] of tt) if (t.startsWith(term)) for (const o of list) add(o, FIELD_TITLE);
    } else for (const o of tt.get(term) ?? []) add(o, FIELD_TITLE);
  }
  // Label values.
  const lt = labelTokens(index);
  index.labels.forEach((l, li) => {
    const hit = new Set<number>();
    lt[li]!.tokens.forEach((toks, vid) => {
      if (termMatches(toks, term, prefix)) hit.add(vid);
    });
    if (hit.size === 0) return;
    if (l.single) {
      for (let o = 0; o < index.count; o++) {
        const v = l.single[o]!;
        if (v !== NONE16 && hit.has(v)) add(o, FIELD_LABEL);
      }
    } else if (l.multi) {
      const m = l.multi;
      for (let o = 0; o < index.count; o++) {
        for (let k = m.offsets[o]!; k < m.offsets[o + 1]!; k++) {
          if (hit.has(m.targets[k]!)) {
            add(o, FIELD_LABEL);
            break;
          }
        }
      }
    }
  });
  // Folder names.
  const ft = folderTokens(index);
  const folders = new Set<number>();
  ft.forEach((toks, id) => {
    if (termMatches(toks, term, prefix)) folders.add(id);
  });
  if (folders.size > 0) {
    const col = index.cols.folder;
    for (let o = 0; o < index.count; o++) {
      const f = col[o]!;
      if (f !== NONE32 && folders.has(f)) add(o, FIELD_FOLDER);
    }
  }
  return out;
}

const termScore = (m: number): number => ((m & FIELD_TITLE) !== 0 ? 4 : 0) + ((m & (FIELD_LABEL | FIELD_FOLDER)) !== 0 ? 2 : 0) + ((m & FIELD_BODY) !== 0 ? 1 : 0);

/**
 * Every ordinal matching the query (AND across terms, last term as a prefix unless the query ends in a space)
 * with its score; not filtered by visibility. Used by `search` and by text tokens in `query`.
 */
export function matchQuery(data: SearchIndexData | null, index: DataIndex, query: string): Map<number, number> {
  const { terms, prefix } = parseQuery(query);
  const parts: { term: string; prefix: boolean }[] = terms.map((t) => ({ term: t, prefix: false }));
  if (prefix !== null) parts.push({ term: prefix, prefix: true });
  if (parts.length === 0) return new Map();
  const maps = parts.map((p) => matchTerm(data, index, p.term, p.prefix));
  maps.sort((a, b) => a.size - b.size);
  const [first, ...rest] = maps;
  const out = new Map<number, number>();
  if (!first) return out;
  for (const [o, m] of first) {
    let score = termScore(m);
    let all = true;
    for (const other of rest) {
      const mm = other.get(o);
      if (mm === undefined) {
        all = false;
        break;
      }
      score += termScore(mm);
    }
    if (all) out.set(o, score);
  }
  return out;
}

/** Folder dictionary entries whose name matches every query term. */
function matchingFolders(index: DataIndex, query: string): Set<number> {
  const { terms, prefix } = parseQuery(query);
  const ft = folderTokens(index);
  const out = new Set<number>();
  if (terms.length === 0 && prefix === null) return out;
  ft.forEach((toks, id) => {
    if (terms.every((t) => termMatches(toks, t, false)) && (prefix === null || termMatches(toks, prefix, true))) out.add(id);
  });
  return out;
}

/** Rows per "Filter by" kind. */
export const FACET_ROWS = 4;

/**
 * "Filter by" suggestions for a set of hits: the sources and the tags (every value of a multi-valued label field,
 * the session pack's topics) that appear among them, most common first. A value that every hit already carries
 * is left out (picking it would change nothing).
 */
export function facetsOf(index: DataIndex, hits: readonly number[]): { sources: { source: string; count: number }[]; tags: { dim: string; value: string; count: number }[] } {
  const bySource = new Map<number, number>();
  for (const o of hits) {
    const s = index.cols.source[o]!;
    if (s !== NONE8) bySource.set(s, (bySource.get(s) ?? 0) + 1);
  }
  const sources = [...bySource]
    .filter(([, n]) => n < hits.length)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, FACET_ROWS)
    .map(([s, count]) => ({ source: SOURCE_ORDER[s] ?? "", count }))
    .filter((r) => r.source !== "");
  const byTag = new Map<string, { dim: string; value: string; count: number }>();
  for (const col of index.labels) {
    const multi = col.multi;
    if (!multi) continue;
    const dim = `label:${col.pack}/${col.field}`;
    for (const o of hits) {
      for (let k = multi.offsets[o]!; k < multi.offsets[o + 1]!; k++) {
        const value = col.values[multi.targets[k]!];
        if (value === undefined || value === "") continue;
        const key = `${dim}|${value}`;
        const row = byTag.get(key);
        if (row) row.count += 1;
        else byTag.set(key, { dim, value, count: 1 });
      }
    }
  }
  const tags = [...byTag.values()]
    .filter((r) => r.count < hits.length)
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, FACET_ROWS + 1);
  return { sources, tags };
}

export function runSearch(data: SearchIndexData | null, index: DataIndex, params: SearchParams): SearchResult {
  const empty: SearchResult = { ordinals: new Uint32Array(0), total: 0, top: { entries: [], notes: [], maps: [], folders: [] } };
  const scores = matchQuery(data, index, params.query);
  const visible = makeVisibility(index, params.visibility);
  const hits: number[] = [];
  for (const o of scores.keys()) if (visible(o)) hits.push(o);
  const t = index.cols.t;
  hits.sort((a, b) => {
    const s = scores.get(b)! - scores.get(a)!;
    if (s !== 0) return s;
    const ta = t[a]!;
    const tb = t[b]!;
    const na = Number.isNaN(ta);
    const nb = Number.isNaN(tb);
    if (na !== nb) return na ? 1 : -1;
    if (!na && ta !== tb) return tb - ta;
    return b - a;
  });
  const top: SearchResult["top"] = { entries: [], notes: [], maps: [], folders: [] };
  const c = index.cols;
  for (const o of hits) {
    if (c.pop[o] === Population.Record) {
      if (top.entries.length < TOP_ROWS) top.entries.push(o);
    } else if (c.kind[o] === ItemKind.NoteHub || c.noteKind[o] === HUB_NOTE_KIND) {
      if (top.maps.length < TOP_ROWS) top.maps.push(o);
    } else if (top.notes.length < TOP_ROWS) top.notes.push(o);
    if (top.entries.length >= TOP_ROWS && top.notes.length >= TOP_ROWS && top.maps.length >= TOP_ROWS) break;
  }
  const folders = matchingFolders(index, params.query);
  if (folders.size > 0) {
    const counts = new Map<number, number>();
    for (let o = 0; o < index.count; o++) {
      const f = c.folder[o]!;
      if (f !== NONE32 && folders.has(f) && visible(o)) counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    top.folders = [...counts]
      .sort((a, b) => b[1] - a[1] || index.dicts.folders.get(a[0]).localeCompare(index.dicts.folders.get(b[0])))
      .slice(0, TOP_ROWS)
      .map(([f, count]) => ({ path: index.dicts.folders.get(f), count }));
  }
  if (hits.length > 1) {
    const f = facetsOf(index, hits);
    if (f.sources.length > 0) top.sources = f.sources;
    if (f.tags.length > 0) top.tags = f.tags;
  }
  if (hits.length === 0 && top.folders.length === 0) return empty;
  const limit = params.limit > 0 ? Math.floor(params.limit) : hits.length;
  return { ordinals: Uint32Array.from(hits.slice(0, limit)), total: hits.length, top };
}
