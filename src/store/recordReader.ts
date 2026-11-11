/**
 * RecordReader implementation (H5, SERVICES-CONTRACT-GAPS). Owner: E2. Runs in the plugin (Node fs).
 *
 *  - entry(ordinal): the EntryRecord through the offsets table (`<cache>/offsets.bin`, id → ledger shard + byte
 *    range, so opening a reader reads ONE line; entries appended since are scanned incrementally, a live entry is
 *    read from the stage), shown with your corrections applied (speaker, date, area/folder/project); the text of
 *    the current version; versions with their author and approval; labels with model/pack/version/date/confidence
 *    (your labels outrank, rejected ones drop out); the merged History list (imported → labelled → summarised →
 *    corrected → read); cited-by notes; the reads summary; "Where it lives"; the frond scrubber speakers; the
 *    shared-term chips for Related; held-secret markers; date evidence;
 *  - note(ordinal): NoteRecord, citations (each re-verified against its version), comments with waiting /
 *    answered state (M7), and for maps the members grouped by kind, a 12-week activity sparkline and the
 *    evidence meter per brief bullet (computed from cited speakers, SAFE-09);
 *  - conversation(convId): the frond (parts with time range and message span, notes per part, corrections
 *    inline, comments);
 *  - entryText(): segment text (SegmentCache), stage text (this computer only), a correction's version, or a
 *    `.raw/` byte range whose sha256 is verified; mismatch → {ok:false, reason:"changed-at-source"}; an OneDrive
 *    placeholder that is not on this computer → "not-local" (the reader offers Try again). Never throws.
 * Mutable lookups (notes, conversations, labels, reads) are byte searches of the ledgers that parse only the
 * lines naming the id, cached until the ledger seq moves; entry records are immutable and cached by id.
 * Pages never block: every scan reads in 1 MB chunks and yields to the UI thread.
 */
import { createYielder } from "../shared/cancel";
import { CortexError } from "../shared/errors";
import type { DataIndex } from "../shared/index-format";
import { HUB_STATUS_ORDER, HUB_TYPE_ORDER, ItemFlag, ItemKind, NONE32, NONE8, NOTE_KIND_ORDER, Population, SOURCE_ORDER, SPACE_ORDER, SPEAKER_ORDER } from "../shared/index-format";
import type { Logger } from "../shared/log";
import { nullLogger } from "../shared/log";
import { tokenize } from "../shared/text";
import { shardMonth } from "../shared/time";
import type {
  Citation,
  ConversationId,
  ConversationRecord,
  CorrectionRecord,
  EntryId,
  EntryKind,
  EntryRecord,
  IsoDate,
  LabelId,
  LabelRecord,
  NoteId,
  NoteKind,
  NoteRecord,
  ReadRecord,
  Speaker,
  VaultPath,
} from "../shared/types";
import { wikiNoteId } from "../shared/ids";
import { resolveInVault } from "../node/paths";
import { readTextIfExists, withFsRetry } from "../node/fsAtomic";
import type {
  CitationView,
  CitedByRow,
  CommentView,
  ConversationDetail,
  EntryDetail,
  HistoryItem,
  LabelView,
  NoteDetail,
  RecordReader,
  TextResult,
  VersionInfo,
} from "../plugin/services";
import { cacheLayout, correctionsPath } from "./layout";
import { gitEvidenceFor, sealEvidenceFor } from "./dateEvidence";
import { grepRecords, latestBySeq, LedgerOffsets, readLedgerSeq, streamJsonl, type ScanOptions } from "./ledger";
import { partTitlesFromMarkdown } from "./notesWriter";
import { countSecretMarkers, readConversationLines, readHeld, readText, SegmentCache, sha256Text } from "./segments";
import { readStage, readStageMeta, listStaged, stageLookup } from "./stage";

export interface RecordReaderDeps {
  vaultRoot: string;
  /** %LOCALAPPDATA%/cortex/<vaultKey> (offsets table, stage, held secrets). */
  cacheDir: string;
  /** The loaded (merged) index: ordinal → id, conversation rows, citations, columns. Null before the first load. */
  index(): DataIndex | null;
  /** The corrections log in file order (CorrectionService.list); without it the reader reads corrections.jsonl. */
  corrections?(): readonly CorrectionRecord[];
  /** True while the sample record is showing (M13): readers get index facts and "sample" text. */
  sandbox?(): boolean;
  /** The made-up text of a sample entry (plugin/sampleRecord.ts sampleTextResult); without it the sample has no text. */
  sampleText?(ordinal: number): TextResult;
  /** Vault-relative path of a legacy vault note (w_ id), from the vault source; defaults to folder + title. */
  vaultNotePath?(id: string, ordinal: number): string | undefined;
  /** How many items contain each term (worker search), for the Related chips; else counted in the conversation. */
  termCounts?(terms: readonly string[]): Promise<ReadonlyMap<string, number>>;
  log?: Logger;
  now?(): number;
}

// ───────────────────────────── small helpers ─────────────────────────────

class Lru<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly capacity: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: K, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.capacity) {
      const first = this.map.keys().next();
      if (first.done) break;
      this.map.delete(first.value);
    }
  }
  clear(): void {
    this.map.clear();
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const notFound = (what: string) => new CortexError("E_IO", `${what} not found`, { detail: { reason: "missing" } });
const monthOf = (iso: string | undefined): string | undefined => (iso && Number.isFinite(Date.parse(iso)) ? shardMonth(new Date(Date.parse(iso)).toISOString()) : undefined);
const sinceMonth = (month: string | undefined): ScanOptions["months"] => (month ? (m: string) => m >= month : undefined);
const isoOf = (t: number): IsoDate | undefined => (Number.isFinite(t) ? new Date(t).toISOString() : undefined);
const byAt = <T extends { at: string }>(a: T, b: T) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

// ───────────────────────────── corrections, as the reader needs them ─────────────────────────────

interface EditVersion {
  version: number;
  text: string;
  sha256: string;
  at: IsoDate;
  via: CorrectionRecord["via"];
  id: string;
  reason?: string;
}

interface Exclusion {
  scope: CorrectionRecord<"exclude">["payload"]["scope"];
  payload: CorrectionRecord<"exclude">["payload"];
  at: IsoDate;
  id: string;
}

export interface CorrState {
  all: readonly CorrectionRecord[];
  /** Ids of corrections that are undone (an undo of an undo restores the original). */
  undone: Set<string>;
  /** In effect: not an undo record, not undone; file order. */
  effective: CorrectionRecord[];
  byTarget: Map<string, CorrectionRecord[]>;
  edits: Map<string, EditVersion[]>;
  allEdits: Map<string, EditVersion[]>;
  excluded: Map<string, Exclusion>;
  speakers: Map<string, CorrectionRecord<"set-speaker">["payload"]>;
  dates: Map<string, IsoDate | null>;
  refiles: Map<string, CorrectionRecord<"refile">["payload"]>;
  resolvedComments: Map<string, IsoDate>;
  rejectedLabels: Set<string>;
}

/** Fold the log the way the corrections service does (undo walk from the end, then effective records in order). */
export function foldCorrectionsForReader(all: readonly CorrectionRecord[]): CorrState {
  const undone = new Set<string>();
  for (let i = all.length - 1; i >= 0; i--) {
    const r = all[i] as CorrectionRecord;
    if (undone.has(r.id)) continue;
    if (r.undoes) undone.add(r.undoes);
  }
  const st: CorrState = {
    all,
    undone,
    effective: [],
    byTarget: new Map(),
    edits: new Map(),
    allEdits: new Map(),
    excluded: new Map(),
    speakers: new Map(),
    dates: new Map(),
    refiles: new Map(),
    resolvedComments: new Map(),
    rejectedLabels: new Set(),
  };
  for (const r of all) {
    if (r.action === "edit-text") {
      const p = r.payload as CorrectionRecord<"edit-text">["payload"];
      const v: EditVersion = { version: p.version, text: p.newText, sha256: p.newTextSha256, at: r.at, via: r.via, id: r.id };
      if (r.reason !== undefined) v.reason = r.reason;
      const list = st.allEdits.get(r.target) ?? [];
      list.push(v);
      st.allEdits.set(r.target, list);
    }
    if (undone.has(r.id) || r.undoes) continue;
    st.effective.push(r);
    const list = st.byTarget.get(r.target) ?? [];
    list.push(r);
    st.byTarget.set(r.target, list);
    switch (r.action) {
      case "edit-text": {
        const p = r.payload as CorrectionRecord<"edit-text">["payload"];
        const v: EditVersion = { version: p.version, text: p.newText, sha256: p.newTextSha256, at: r.at, via: r.via, id: r.id };
        if (r.reason !== undefined) v.reason = r.reason;
        const e = st.edits.get(r.target) ?? [];
        e.push(v);
        e.sort((a, b) => a.version - b.version);
        st.edits.set(r.target, e);
        break;
      }
      case "exclude": {
        const p = r.payload as CorrectionRecord<"exclude">["payload"];
        st.excluded.set(r.target, { scope: p.scope, payload: p, at: r.at, id: r.id });
        break;
      }
      case "include":
        st.excluded.delete(r.target);
        break;
      case "set-speaker":
        st.speakers.set(r.target, r.payload as CorrectionRecord<"set-speaker">["payload"]);
        break;
      case "set-date":
        st.dates.set(r.target, (r.payload as CorrectionRecord<"set-date">["payload"]).writtenAt);
        break;
      case "refile":
        st.refiles.set(r.target, r.payload as CorrectionRecord<"refile">["payload"]);
        break;
      case "resolve-comment":
        st.resolvedComments.set((r.payload as CorrectionRecord<"resolve-comment">["payload"]).commentId, r.at);
        break;
      case "reject-label":
        st.rejectedLabels.add((r.payload as CorrectionRecord<"reject-label">["payload"]).labelId);
        break;
      default:
        break;
    }
  }
  for (const list of st.allEdits.values()) list.sort((a, b) => a.version - b.version);
  return st;
}

/** The exclusion that covers an entry (entry, its conversation, its source, folder or project), if any. */
export function exclusionFor(st: CorrState, rec: Pick<EntryRecord, "id" | "conv" | "source" | "folder" | "project">): Exclusion | null {
  for (const [target, x] of st.excluded) {
    switch (x.scope) {
      case "entry":
        if (target === rec.id) return x;
        break;
      case "conversation":
        if (rec.conv !== undefined && target === rec.conv) return x;
        break;
      case "source":
        if (target === rec.source || x.payload.sourceKind === rec.source) return x;
        break;
      case "folder": {
        const f = (x.payload.folder ?? target).replace(/\/+$/, "");
        const folder = rec.folder.join("/");
        if (f.length > 0 && (folder === f || folder.startsWith(`${f}/`))) return x;
        break;
      }
      case "project": {
        const p = x.payload.project ?? target;
        if (p.length > 0 && rec.project === p) return x;
        break;
      }
    }
  }
  return null;
}

/** An entry as the user sees it: speaker, date and filing corrections applied (the raw values stay in History). */
export function withCorrections(rec: EntryRecord, st: CorrState): EntryRecord {
  const out: EntryRecord = { ...rec };
  const sp = st.speakers.get(rec.id);
  if (sp) {
    out.speaker = sp.speaker;
    if (sp.speakerDetail !== undefined) out.speakerDetail = sp.speakerDetail;
    else delete out.speakerDetail;
  }
  if (st.dates.has(rec.id)) {
    const d = st.dates.get(rec.id);
    if (d) out.writtenAt = d;
    else delete out.writtenAt;
  }
  const rf = st.refiles.get(rec.id) ?? (rec.conv ? st.refiles.get(rec.conv) : undefined);
  if (rf) {
    if (rf.space !== undefined) out.space = rf.space;
    if (rf.folder !== undefined) out.folder = rf.folder;
    if (rf.project === null) delete out.project;
    else if (rf.project !== undefined) out.project = rf.project;
  }
  return out;
}

function commentViews(st: CorrState, targets: readonly string[], addressed: readonly string[] = [], addressedAt?: IsoDate): CommentView[] {
  const want = new Set(targets);
  const answered = new Set(addressed);
  const out: CommentView[] = [];
  for (const r of st.effective) {
    if (r.action !== "comment" || !want.has(r.target)) continue;
    const text = (r.payload as CorrectionRecord<"comment">["payload"]).text;
    const resolvedAt = st.resolvedComments.get(r.id);
    if (resolvedAt !== undefined) out.push({ id: r.id, text, state: "answered", answeredAt: resolvedAt });
    else if (answered.has(r.id)) out.push(addressedAt ? { id: r.id, text, state: "answered", answeredAt: addressedAt } : { id: r.id, text, state: "answered" });
    else out.push({ id: r.id, text, state: "waiting" });
  }
  return out;
}

// ───────────────────────────── index helpers ─────────────────────────────

const ENTRY_KIND_BY_ITEM: Partial<Record<number, EntryKind>> = {
  [ItemKind.RecordMessage]: "message",
  [ItemKind.RecordDocument]: "document",
  [ItemKind.RecordPassage]: "passage",
  [ItemKind.RecordFile]: "file",
};

function noteKindAt(idx: DataIndex, o: number): NoteKind {
  const k = idx.cols.noteKind[o];
  if (k !== undefined && k !== NONE8 && NOTE_KIND_ORDER[k]) return NOTE_KIND_ORDER[k] as NoteKind;
  switch (idx.cols.kind[o]) {
    case ItemKind.NoteHub:
      return "hub";
    case ItemKind.NoteGist:
      return "gist";
    case ItemKind.NoteWiki:
      return "wiki";
    default:
      return "concept";
  }
}

function idAt(idx: DataIndex | null, ordinal: number): string {
  if (!idx) throw new CortexError("E_BAD_REQUEST", "the index is not loaded yet", { retryable: true });
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= idx.count) throw new CortexError("E_BAD_REQUEST", "no item at this ordinal");
  return idx.ids.get(ordinal);
}

/** Members of a conversation in the index, in conversation order. */
function conversationOrdinals(idx: DataIndex, convRow: number): number[] {
  const rows: number[] = [];
  const conv = idx.cols.conv;
  for (let o = 0; o < idx.count; o++) {
    if (conv[o] === convRow && idx.cols.pop[o] === Population.Record && ((idx.cols.flags[o] ?? 0) & ItemFlag.Excluded) === 0) rows.push(o);
  }
  rows.sort((a, b) => (idx.cols.idx[a] ?? 0) - (idx.cols.idx[b] ?? 0) || a - b);
  return rows;
}

/** Note ordinals whose citations include `ordinal` (index relation noteSources, rows = item ordinals). */
function citingOrdinals(idx: DataIndex, ordinal: number): number[] | null {
  const { offsets, targets } = idx.rel.noteSources;
  if (offsets.length !== idx.count + 1) return null;
  const out: number[] = [];
  for (let row = 0; row < idx.count; row++) {
    const end = offsets[row + 1] as number;
    for (let j = offsets[row] as number; j < end; j++) {
      if (targets[j] === ordinal) {
        out.push(row);
        break;
      }
    }
  }
  return out;
}

/**
 * The sample record's conversation summary: one short sentence templated from the conversation's title, its message
 * count and the titles of its notes (deterministic; no word salad, nothing from anyone's record).
 */
export function sampleGistText(title: string, messages: number, noteTitles: readonly string[]): string {
  const name = title.trim() === "" ? "This conversation" : title.trim().replace(/[.!?]+$/, "");
  const count = `${messages.toLocaleString("en-GB")} ${messages === 1 ? "message" : "messages"}`;
  const q = (t: string): string => `“${t.replace(/[.]+$/, "")}”`;
  let tail: string;
  if (noteTitles.length === 0) tail = "no notes drawn from it yet";
  else if (noteTitles.length === 1) tail = `one note, ${q(noteTitles[0] as string)}`;
  else if (noteTitles.length === 2) tail = `two notes, ${q(noteTitles[0] as string)} and ${q(noteTitles[1] as string)}`;
  else tail = `${noteTitles.length} notes, among them ${q(noteTitles[0] as string)}, ${q(noteTitles[1] as string)} and ${q(noteTitles[2] as string)}`;
  return `${name}: ${count}, with ${tail}.`;
}

// ───────────────────────────── related terms ─────────────────────────────

function candidateTerms(text: string, max = 12): { term: string; tf: number }[] {
  const counts = new Map<string, number>();
  for (const t of tokenize(text)) {
    if (t.length < 3 || /^\d+$/.test(t)) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1))
    .slice(0, max)
    .map(([term, tf]) => ({ term, tf }));
}

/** Shared terms ranked by tf·idf: present in other items, rarer is more telling; count = other items sharing it. */
function rankShared(cands: readonly { term: string; tf: number }[], df: ReadonlyMap<string, number>, total: number, includesSelf: boolean): { term: string; count: number }[] {
  const out: { term: string; count: number; score: number }[] = [];
  for (const c of cands) {
    const n = df.get(c.term) ?? 0;
    const others = includesSelf ? n - 1 : n;
    if (others <= 0) continue;
    out.push({ term: c.term, count: others, score: c.tf * Math.log(1 + Math.max(total, n + 1) / (1 + n)) });
  }
  return out.sort((a, b) => b.score - a.score || b.count - a.count).slice(0, 5).map(({ term, count }) => ({ term, count }));
}

// ───────────────────────────── the reader ─────────────────────────────

const DATE_KIND: Record<string, EntryDetail["dateEvidence"][number]["kind"]> = {
  "source-timestamp": "source",
  "user-declared": "source",
  "filename-date": "source",
  "conversation-start": "source",
  "file-mtime": "source",
  "git-first-seen": "git",
  seal: "sealed",
  ingest: "imported",
};

const ROUTE: Record<string, string> = { "claude-cli": "Claude Code → Anthropic", "anthropic-api": "Anthropic API → Anthropic", local: "this computer", "codex-cli": "Codex CLI → OpenAI", rule: "this computer", fake: "test engine" };

export function createRecordReader(deps: RecordReaderDeps): RecordReader {
  const { vaultRoot, cacheDir } = deps;
  const log = deps.log ?? nullLogger;
  const now = () => deps.now?.() ?? Date.now();
  const segCache = new SegmentCache(vaultRoot, 48, 128 * 1024 * 1024);
  const stage = stageLookup({ cacheDir });
  const entryCache = new Lru<string, EntryRecord>(4096);
  const noteCache = new Lru<string, NoteRecord | null>(512);
  const convCache = new Lru<string, ConversationRecord | null>(256);
  let seenSeq = -1;
  let offsets: Promise<LedgerOffsets> | null = null;
  let offsetsFresh = false;
  let persisting = false;
  let fileCorrections: { seq: number; state: CorrState } | null = null;
  let listCorrections: { list: readonly CorrectionRecord[]; length: number; state: CorrState } | null = null;
  const scan = (): ScanOptions => ({ yield: createYielder(8, true) });

  /** Drop mutable caches when the ledger moved on (cheap: one small file read). */
  async function sync(): Promise<void> {
    const seq = await readLedgerSeq(vaultRoot);
    if (seq !== seenSeq) {
      seenSeq = seq;
      noteCache.clear();
      convCache.clear();
      offsetsFresh = false;
    }
  }

  async function corrections(): Promise<CorrState> {
    const fromService = deps.corrections?.();
    if (fromService) {
      if (!listCorrections || listCorrections.list !== fromService || listCorrections.length !== fromService.length) {
        listCorrections = { list: fromService, length: fromService.length, state: foldCorrectionsForReader(fromService) };
      }
      return listCorrections.state;
    }
    if (!fileCorrections || fileCorrections.seq !== seenSeq) {
      const all: CorrectionRecord[] = [];
      for await (const r of streamJsonl<CorrectionRecord>(resolveInVault(vaultRoot, correctionsPath()))) if (r && typeof r === "object" && typeof r.id === "string") all.push(r);
      fileCorrections = { seq: seenSeq, state: foldCorrectionsForReader(all) };
    }
    return fileCorrections.state;
  }

  async function entryOffsets(): Promise<LedgerOffsets> {
    if (!offsets) {
      offsets = LedgerOffsets.open({ vaultRoot, cacheDir, log }, scan());
      offsets.catch(() => {
        offsets = null;
      });
      offsetsFresh = true;
    }
    const o = await offsets;
    if (!offsetsFresh) {
      offsetsFresh = true;
      await o.update(scan());
    }
    if (o.pending >= 20_000 && !persisting) {
      persisting = true;
      void o
        .persist("plugin:reader")
        .catch((e) => log.warn("could not save the offsets table", { code: e instanceof CortexError ? e.code : "E_IO" }))
        .finally(() => {
          persisting = false;
        });
    }
    return o;
  }

  async function stagedEntry(id: string, conv?: string): Promise<EntryRecord | null> {
    const convs = conv ? [conv] : (await listStaged({ cacheDir })).map((s) => s.conv);
    for (const c of convs) {
      if (!/^c_[a-z2-7]{16}$/.test(c)) continue;
      const hit = (await readStage({ cacheDir }, c as ConversationId)).find((m) => m.entry.id === id);
      if (hit) return hit.entry;
    }
    return null;
  }

  /** The entry's record: offsets table, then a search of its month, then the live stage. */
  async function entryRecord(id: string, hint: { month?: string; conv?: string } = {}): Promise<{ record: EntryRecord; live: boolean } | null> {
    const cached = entryCache.get(id);
    if (cached) return { record: cached, live: false };
    let rec: EntryRecord | null = null;
    try {
      rec = await (await entryOffsets()).read(id);
    } catch (e) {
      log.warn("offsets table unavailable; searching the ledger", { code: e instanceof CortexError ? e.code : "E_IO" });
    }
    if (!rec) {
      const months = hint.month ? (m: string) => m === hint.month : undefined;
      const hits = await grepRecords<EntryRecord>(vaultRoot, "entries", [id], (r) => r.id === id, { ...scan(), months });
      rec = hits[0]?.record ?? null;
      if (!rec && hint.month) rec = (await grepRecords<EntryRecord>(vaultRoot, "entries", [id], (r) => r.id === id, scan()))[0]?.record ?? null;
    }
    if (rec) {
      entryCache.set(id, rec);
      return { record: rec, live: false };
    }
    const staged = await stagedEntry(id, hint.conv);
    return staged ? { record: staged, live: true } : null;
  }

  function hintFor(idx: DataIndex | null, ordinal: number): { month?: string; conv?: string } {
    if (!idx || ordinal < 0 || ordinal >= idx.count) return {};
    const out: { month?: string; conv?: string } = {};
    const t = idx.cols.tAdded[ordinal] ?? Number.NaN;
    if (Number.isFinite(t)) out.month = shardMonth(new Date(t).toISOString());
    const row = idx.cols.conv[ordinal] ?? NONE32;
    if (row !== NONE32 && row < idx.convs.size) out.conv = idx.convs.get(row).id;
    return out;
  }

  async function noteRecord(id: string): Promise<NoteRecord | null> {
    const hit = noteCache.get(id);
    if (hit !== undefined) return hit;
    const recs = await grepRecords<NoteRecord>(vaultRoot, "notes", [id], (r) => r.id === id, scan());
    const rec = latestBySeq(recs.map((h) => h.record)).get(id) ?? null;
    noteCache.set(id, rec);
    return rec;
  }

  async function notesByIds(ids: readonly string[]): Promise<Map<string, NoteRecord>> {
    const out = new Map<string, NoteRecord>();
    const missing: string[] = [];
    for (const id of ids) {
      const hit = noteCache.get(id);
      if (hit) out.set(id, hit);
      else if (hit === undefined) missing.push(id);
    }
    if (missing.length > 0) {
      const want = new Set(missing);
      const recs = await grepRecords<NoteRecord>(vaultRoot, "notes", missing, (r) => want.has(r.id), scan());
      const latest = latestBySeq(recs.map((h) => h.record));
      for (const id of missing) {
        const r = latest.get(id) ?? null;
        noteCache.set(id, r);
        if (r) out.set(id, r);
      }
    }
    return out;
  }

  async function conversationRecord(convId: string): Promise<ConversationRecord | null> {
    const hit = convCache.get(convId);
    if (hit !== undefined) return hit;
    const recs = await grepRecords<ConversationRecord>(vaultRoot, "conversations", [convId], (r) => r.id === convId, scan());
    let rec = latestBySeq(recs.map((h) => h.record)).get(convId) ?? null;
    if (!rec && /^c_[a-z2-7]{16}$/.test(convId)) rec = (await readStageMeta({ cacheDir }, convId as ConversationId))?.conversation ?? null;
    convCache.set(convId, rec);
    return rec;
  }

  async function labelsFor(targets: readonly string[], from?: string, st?: CorrState): Promise<LabelView[]> {
    const want = new Set(targets.filter((t) => t.length > 0));
    if (want.size === 0) return [];
    const hits = await grepRecords<LabelRecord>(vaultRoot, "labels", [...want], (r) => want.has(r.target), { ...scan(), months: sinceMonth(from) });
    const state = st ?? (await corrections());
    // Your labels (set-label corrections) outrank model labels on the same target, pack and field.
    const userKeys = new Map<string, LabelView>();
    for (const t of want) {
      for (const r of state.byTarget.get(t) ?? []) {
        if (r.action !== "set-label") continue;
        const p = r.payload as CorrectionRecord<"set-label">["payload"];
        const label: LabelRecord = { v: 1, id: `l_${r.id.slice(2)}` as LabelId, target: t as LabelRecord["target"], pack: p.pack, packVersion: p.packVersion, field: p.field, value: p.value, state: "set", by: { user: true, correctionId: r.id }, at: r.at };
        userKeys.set(`${t}|${p.pack}|${p.field}`, { label, byUser: true });
      }
    }
    const latest = new Map<string, LabelRecord>();
    for (const { record: l } of hits) {
      if (state.rejectedLabels.has(l.id) || l.supersededBy !== undefined || l.state === "refused" || l.state === "unanswered") continue;
      const key = `${l.target}|${l.pack}|${l.field}`;
      const prev = latest.get(key);
      if (!prev || l.at >= prev.at) latest.set(key, l);
    }
    const out: LabelView[] = [...userKeys.values()];
    for (const [key, l] of latest) if (!userKeys.has(key)) out.push({ label: l, byUser: false });
    return out.sort((a, b) => (a.label.target === b.label.target ? 0 : a.label.target.startsWith("e_") ? -1 : 1) || (a.label.pack < b.label.pack ? -1 : a.label.pack > b.label.pack ? 1 : 0) || (a.label.field < b.label.field ? -1 : 1));
  }

  async function readsOf(entryId: string, from?: string): Promise<ReadRecord[]> {
    const hits = await grepRecords<ReadRecord>(vaultRoot, "reads", [entryId], (r) => Array.isArray(r.entryIds) && r.entryIds.includes(entryId as EntryId), { ...scan(), months: sinceMonth(from) });
    return hits.map((h) => h.record);
  }

  /** The verbatim text of an entry at a version (current version when omitted). */
  async function textOf(rec: EntryRecord, st: CorrState, version?: number): Promise<TextResult> {
    if (deps.sandbox?.()) return { ok: false, reason: "sample" };
    if (exclusionFor(st, rec)) return { ok: false, reason: "excluded" };
    const edit = (v: EditVersion): TextResult => (sha256Text(v.text) === v.sha256 ? { ok: true, text: v.text, version: v.version } : { ok: false, reason: "missing" });
    if (version === undefined) {
      const edits = st.edits.get(rec.id) ?? [];
      const latest = edits[edits.length - 1];
      if (latest) return edit(latest);
    } else if (version !== 1) {
      const v = (st.allEdits.get(rec.id) ?? []).find((e) => e.version === version);
      return v ? edit(v) : { ok: false, reason: "missing" };
    }
    const r = await readText(vaultRoot, rec.text, rec.textSha256, { cache: segCache, stage, entryId: rec.id });
    return r.ok ? { ok: true, text: r.text, version: 1 } : r;
  }

  /** Ordered messages of a conversation: from the index when loaded, else from its segments and stage. */
  async function conversationOrder(convId: string, rec: ConversationRecord | null): Promise<{ id: string; speaker: Speaker; ordinal: number }[]> {
    const idx = deps.index();
    if (idx) {
      const row = idx.convs.rowOf(convId);
      if (row >= 0) {
        return conversationOrdinals(idx, row).map((o) => ({ id: idx.ids.get(o), speaker: SPEAKER_ORDER[idx.cols.speaker[o] ?? 0] ?? "you", ordinal: o }));
      }
    }
    const out: { id: string; speaker: Speaker; ordinal: number; i: number }[] = [];
    const seen = new Set<string>();
    if (rec?.segDir) {
      for (const { line } of await readConversationLines(vaultRoot, rec.segDir, segCache)) {
        seen.add(line.id);
        out.push({ id: line.id, speaker: line.sp, ordinal: idx ? idx.ordinalOf(line.id) : -1, i: line.i ?? out.length });
      }
    }
    if (/^c_[a-z2-7]{16}$/.test(convId)) {
      for (const m of await readStage({ cacheDir }, convId as ConversationId)) {
        if (seen.has(m.line.id)) continue;
        out.push({ id: m.line.id, speaker: m.line.sp, ordinal: idx ? idx.ordinalOf(m.line.id) : -1, i: m.line.i ?? Number.MAX_SAFE_INTEGER });
      }
    }
    out.sort((a, b) => a.i - b.i);
    return out.map(({ id, speaker, ordinal }) => ({ id, speaker, ordinal }));
  }

  async function related(rec: EntryRecord, text: TextResult): Promise<{ term: string; count: number }[]> {
    if (!text.ok) return [];
    const cands = candidateTerms(text.text);
    if (cands.length === 0) return [];
    const idx = deps.index();
    if (deps.termCounts) {
      try {
        const df = await deps.termCounts(cands.map((c) => c.term));
        return rankShared(cands, df, idx?.count ?? 0, true);
      } catch (e) {
        log.debug("term counts unavailable; using the conversation", { code: e instanceof CortexError ? e.code : "E_INTERNAL" });
      }
    }
    if (!rec.conv) return [];
    const conv = await conversationRecord(rec.conv);
    const texts: string[] = [];
    if (conv?.segDir) for (const { line } of await readConversationLines(vaultRoot, conv.segDir, segCache)) if (line.id !== rec.id) texts.push(line.text);
    for (const m of await readStage({ cacheDir }, rec.conv)) if (m.line.id !== rec.id) texts.push(m.line.text);
    const want = new Set(cands.map((c) => c.term));
    const df = new Map<string, number>();
    for (const t of texts) {
      const seen = new Set<string>();
      for (const tok of tokenize(t)) if (want.has(tok)) seen.add(tok);
      for (const tok of seen) df.set(tok, (df.get(tok) ?? 0) + 1);
    }
    return rankShared(cands, df, texts.length + 1, false);
  }

  function citedByFromIndex(idx: DataIndex, ordinal: number): CitedByRow[] | null {
    const rows = citingOrdinals(idx, ordinal);
    if (!rows) return null;
    const out: CitedByRow[] = [];
    for (const o of rows) {
      const flags = idx.cols.flags[o] ?? 0;
      if ((flags & (ItemFlag.Excluded | ItemFlag.Superseded)) !== 0) continue;
      const row: CitedByRow = { id: idx.ids.get(o), kind: noteKindAt(idx, o), title: idx.titles.get(o) };
      const date = isoOf(idx.cols.t[o] ?? Number.NaN);
      if (date) row.date = date;
      out.push(row);
    }
    return out;
  }

  async function citedByFromLedger(entryId: string, from?: string): Promise<{ rows: CitedByRow[]; notes: NoteRecord[] }> {
    const hits = await grepRecords<NoteRecord>(vaultRoot, "notes", [entryId], (r) => Array.isArray(r.sources) && r.sources.some((c) => c.entryId === entryId), { ...scan(), months: sinceMonth(from) });
    const notes = [...latestBySeq(hits.map((h) => h.record)).values()].filter((n) => (n.state === "current" || n.state === "stale") && n.sources.some((c) => c.entryId === entryId));
    const rows = notes.map((n) => {
      const row: CitedByRow = { id: n.id, kind: n.kind, title: n.title };
      const date = n.date ?? ("at" in n.madeBy ? n.madeBy.at : undefined);
      if (date) row.date = date;
      return row;
    });
    return { rows, notes };
  }

  function historyOf(rec: EntryRecord, st: CorrState, labels: readonly LabelView[], citing: readonly NoteRecord[], reads: readonly ReadRecord[]): HistoryItem[] {
    const out: HistoryItem[] = [{ at: rec.addedAt, kind: "imported", detail: rec.source }];
    const runs = new Map<string, HistoryItem>();
    for (const { label, byUser } of labels) {
      if (byUser || !("model" in label.by)) continue;
      const key = label.by.runId;
      const prev = runs.get(key);
      if (!prev || label.at < prev.at) runs.set(key, { at: label.at, kind: "labelled", model: label.by.model, detail: `${label.pack} ${label.packVersion}` });
    }
    out.push(...runs.values());
    for (const n of citing) {
      if (!("at" in n.madeBy)) continue;
      out.push({ at: n.madeBy.at, kind: "summarised", model: n.madeBy.model, detail: n.kind });
    }
    for (const r of st.all) {
      if (r.target !== rec.id && !(r.action === "exclude" && rec.conv !== undefined && r.target === rec.conv)) {
        continue;
      }
      if (r.undoes) {
        const target = st.all.find((x) => x.id === r.undoes);
        if (target?.action === "exclude" && !st.undone.has(r.id)) out.push({ at: r.at, kind: "included" });
        continue;
      }
      switch (r.action) {
        case "edit-text": {
          if (st.undone.has(r.id)) break;
          const p = r.payload as CorrectionRecord<"edit-text">["payload"];
          const item: HistoryItem = { at: r.at, kind: "version", version: p.version, route: r.via };
          if (r.reason !== undefined) item.detail = r.reason;
          out.push(item);
          break;
        }
        case "exclude":
          out.push({ at: r.at, kind: "excluded" });
          break;
        case "include":
          out.push({ at: r.at, kind: "included" });
          break;
        case "set-date":
        case "set-speaker":
        case "refile":
        case "set-label":
        case "reject-label":
        case "confirm":
          if (!st.undone.has(r.id)) out.push({ at: r.at, kind: "corrected", detail: r.action, route: r.via });
          break;
        default:
          break;
      }
    }
    const readGroups = new Map<string, { at: string; n: number; model: string; route: string; via: string }>();
    for (const r of reads) {
      const route = ROUTE[r.engine] ?? r.where;
      const key = `${r.model}|${r.via}|${route}`;
      const g = readGroups.get(key);
      if (!g) readGroups.set(key, { at: r.at, n: 1, model: r.model, route, via: r.via });
      else {
        g.n++;
        if (r.at > g.at) g.at = r.at;
      }
    }
    for (const g of readGroups.values()) out.push({ at: g.at, kind: "read", model: g.model, route: g.route, detail: g.n > 1 ? `${g.via} ×${g.n}` : g.via });
    return out.sort(byAt);
  }

  /** Evidence the importers could not know: the git commit of the original, a local seal, a public timestamp (store/dateEvidence.ts). */
  async function laterEvidence(rec: EntryRecord): Promise<EntryDetail["dateEvidence"]> {
    const out: EntryDetail["dateEvidence"] = [];
    const git = await gitEvidenceFor(cacheDir, rec);
    if (git) out.push({ kind: "git", at: git, strength: "bound" });
    const seal = await sealEvidenceFor(vaultRoot, rec.id);
    if (seal.sealed) out.push({ kind: "sealed", at: seal.sealed.at, strength: "provable", block: seal.sealed.n });
    if (seal.timestamped) out.push({ kind: "timestamped", at: seal.timestamped.blockAt ?? seal.timestamped.at, strength: "provable", ...(seal.timestamped.height !== undefined ? { height: seal.timestamped.height } : {}) });
    return out;
  }

  function dateEvidence(rec: EntryRecord, later: EntryDetail["dateEvidence"] = []): EntryDetail["dateEvidence"] {
    const out: EntryDetail["dateEvidence"] = [];
    for (const d of rec.dates ?? []) {
      const kind = DATE_KIND[d.type];
      if (!kind || typeof d.at !== "string") continue;
      const strength = d.strength === "strong" || d.strength === "medium" || d.strength === "bound" ? d.strength : "bound";
      out.push({ kind, at: d.at, strength: kind === "sealed" ? "provable" : strength });
    }
    if (!out.some((d) => d.kind === "imported")) out.push({ kind: "imported", at: rec.addedAt, strength: "bound" });
    for (const l of later) if (!out.some((d) => d.kind === l.kind && d.at === l.at)) out.push(l);
    return out.sort(byAt);
  }

  function storageOf(rec: EntryRecord): EntryDetail["storage"] {
    const t = rec.text;
    if (t.store === "segment") return { path: t.seg, line: t.line };
    if (t.store === "file") return { path: t.path, byteRange: [t.byteStart, t.byteEnd] };
    return { path: cacheLayout(cacheDir).stageFile(t.conv), line: t.line };
  }

  async function secretsOf(rec: EntryRecord, st: CorrState): Promise<EntryDetail["secrets"]> {
    const original = await readText(vaultRoot, rec.text, rec.textSha256, { cache: segCache, stage, entryId: rec.id });
    if (!original.ok) return [];
    const n = countSecretMarkers(original.text);
    if (n === 0) return [];
    void st;
    const held = await readHeld(cacheDir, rec.id);
    const here = new Set((held?.secrets ?? []).map((s) => s.n));
    return Array.from({ length: n }, (_, marker) => ({ marker, here: here.has(marker) }));
  }

  /** Index facts for the sample record (M13): there is no ledger behind it. */
  function sampleEntry(idx: DataIndex, ordinal: number): EntryDetail {
    const c = idx.cols;
    const t = c.t[ordinal] ?? Number.NaN;
    const added = c.tAdded[ordinal] ?? Number.NaN;
    const record: EntryRecord = {
      v: 1,
      id: idx.ids.get(ordinal) as EntryId,
      kind: ENTRY_KIND_BY_ITEM[c.kind[ordinal] ?? 0] ?? "message",
      source: SOURCE_ORDER[c.source[ordinal] ?? 0] ?? "files",
      sourceRef: { path: "", sha256: "" },
      speaker: SPEAKER_ORDER[c.speaker[ordinal] ?? 0] ?? "you",
      title: idx.titles.get(ordinal),
      text: { store: "file", path: "", byteStart: 0, byteEnd: 0 },
      textSha256: "",
      chars: c.chars[ordinal] ?? 0,
      words: c.words[ordinal] ?? 0,
      dates: [],
      existedBy: isoOf(added) ?? new Date(0).toISOString(),
      addedAt: isoOf(added) ?? new Date(0).toISOString(),
      space: SPACE_ORDER[c.space[ordinal] ?? 0] ?? "none",
      folder: [],
    };
    const written = isoOf(t);
    if (written) record.writtenAt = written;
    const detail: EntryDetail = { record, text: deps.sampleText?.(ordinal) ?? { ok: false, reason: "sample" }, versions: [], labels: [], history: [{ at: record.addedAt, kind: "imported", detail: record.source }], citedBy: [], reads: { count: 0, models: [] }, storage: { path: "" }, related: [], secrets: [], dateEvidence: [] };
    // Its place in the conversation, from the index, as the ledger path gives it (the reader's scrubber and "Open conversation").
    const convRow = c.conv[ordinal];
    if (convRow !== undefined && convRow !== NONE32 && convRow < idx.convs.size) {
      const row = idx.convs.get(convRow);
      const order = conversationOrdinals(idx, convRow);
      if (order.length > 0) {
        record.conv = row.id as ConversationId;
        detail.conversation = { id: row.id as ConversationId, title: row.title, index: Math.max(0, order.indexOf(ordinal)), count: order.length, speakers: order.map((o) => SPEAKER_ORDER[c.speaker[o] ?? 0] ?? "you") };
      }
    }
    return detail;
  }

  async function citationView(c: Citation, st: CorrState, cache: Map<string, Promise<{ rec: EntryRecord | null; texts: Map<number, TextResult> }>>): Promise<CitationView> {
    let slot = cache.get(c.entryId);
    if (!slot) {
      slot = entryRecord(c.entryId).then((found) => ({ rec: found ? withCorrections(found.record, st) : null, texts: new Map<number, TextResult>() }));
      cache.set(c.entryId, slot);
    }
    const { rec, texts } = await slot;
    const view: CitationView = { entryId: c.entryId, quote: c.quote, valid: false };
    const speaker = rec?.speaker ?? c.speaker;
    if (speaker) view.speaker = speaker;
    const date = c.date ?? rec?.writtenAt ?? rec?.addedAt;
    if (date) view.date = date;
    if (!rec) return view;
    const version = Number.isInteger(c.version) && c.version > 0 ? c.version : 1;
    let text = texts.get(version);
    if (!text) {
      // Validity is about the cited version's wording, so a left-out entry is still checked against it.
      const st2: CorrState = st.excluded.size > 0 ? { ...st, excluded: new Map() } : st;
      text = await textOf(rec, st2, version);
      texts.set(version, text);
    }
    view.valid = text.ok && typeof c.quote === "string" && c.quote.length > 0 && text.text.includes(c.quote);
    return view;
  }

  /** The made-up or legacy note at an ordinal, from the index alone (no ledger). */
  function legacyRecord(idx: DataIndex, ordinal: number, id: string): NoteRecord {
    const path = deps.vaultNotePath?.(id, ordinal) ?? guessVaultPath(idx, ordinal, id) ?? "";
    const record: NoteRecord = {
      v: 1,
      id: id as NoteId,
      seq: 0,
      kind: noteKindAt(idx, ordinal),
      title: idx.titles.get(ordinal),
      text: "",
      file: path,
      sources: [],
      madeBy: { legacy: true },
      space: SPACE_ORDER[idx.cols.space[ordinal] ?? 0] ?? "none",
      folder: idx.cols.folder[ordinal] !== undefined && idx.cols.folder[ordinal] !== NONE32 ? [idx.dicts.folders.get(idx.cols.folder[ordinal] as number)] : [],
      state: "current",
    };
    const date = isoOf(idx.cols.t[ordinal] ?? Number.NaN);
    if (date) record.date = date;
    return record;
  }

  async function legacyNote(idx: DataIndex, ordinal: number, id: string): Promise<NoteDetail> {
    return { record: legacyRecord(idx, ordinal, id), cites: [], comments: commentViews(await corrections(), [id]) };
  }

  /**
   * A map's members grouped by kind and its last-12-weeks activity, from the index (members the index does not know
   * come from the ledger). One path for the real record and for the sample record, so both read the same.
   */
  async function hubMembersFilled(idx: DataIndex | null, members: readonly string[]): Promise<{ members: NonNullable<NoteDetail["members"]>; activity: number[] }> {
    const kinds = new Map<NoteKind, string[]>();
    const dates = new Map<string, number>();
    const unknown: string[] = [];
    for (const m of members) {
      const o = idx ? idx.ordinalOf(m) : -1;
      if (idx && o >= 0) {
        if (((idx.cols.flags[o] ?? 0) & (ItemFlag.Excluded | ItemFlag.Superseded)) !== 0) continue;
        const k = noteKindAt(idx, o);
        kinds.set(k, [...(kinds.get(k) ?? []), m]);
        const t = idx.cols.t[o] ?? Number.NaN;
        if (Number.isFinite(t)) dates.set(m, t);
      } else unknown.push(m);
    }
    if (unknown.length > 0) {
      const recs = await notesByIds(unknown);
      for (const m of unknown) {
        const r = recs.get(m);
        if (!r || r.state === "excluded" || r.state === "superseded" || r.state === "hidden") continue;
        kinds.set(r.kind, [...(kinds.get(r.kind) ?? []), m]);
        const t = Date.parse(r.date ?? ("at" in r.madeBy ? r.madeBy.at : ""));
        if (Number.isFinite(t)) dates.set(m, t);
      }
    }
    const order = ["decision", "question", "idea", "plan", "abandoned", "concept", "gist", "hub", "wiki", "reference", "log"] as NoteKind[];
    const grouped = order.filter((k) => (kinds.get(k)?.length ?? 0) > 0).map((k) => ({ kind: k, count: (kinds.get(k) as string[]).length, ids: kinds.get(k) as string[] }));
    const week = 7 * 86_400_000;
    const end = now();
    const activity = new Array<number>(12).fill(0);
    for (const t of dates.values()) {
      const back = Math.floor((end - t) / week);
      if (back >= 0 && back < 12) activity[11 - back] = (activity[11 - back] ?? 0) + 1;
    }
    return { members: grouped, activity };
  }

  /** The sample record's map: hub fields (type, status, range, members, no brief) from the index relation hubMembers. */
  async function sampleHubNote(idx: DataIndex, ordinal: number, id: string): Promise<NoteDetail> {
    const d = await legacyNote(idx, ordinal, id);
    const record: NoteRecord = { ...d.record, madeBy: { legacy: true } };
    if (noteKindAt(idx, ordinal) !== "hub") return { ...d, record };
    const { offsets, targets } = idx.rel.hubMembers;
    const memberIds: string[] = [];
    if (offsets.length === idx.count + 1) for (let k = offsets[ordinal] as number; k < (offsets[ordinal + 1] as number); k++) memberIds.push(idx.ids.get(targets[k] as number));
    const ht = idx.cols.hubType[ordinal];
    const hs = idx.cols.hubStatus[ordinal];
    const filled = await hubMembersFilled(idx, memberIds);
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const m of memberIds) {
      const t = idx.cols.t[idx.ordinalOf(m)] ?? Number.NaN;
      if (Number.isFinite(t)) {
        lo = Math.min(lo, t);
        hi = Math.max(hi, t);
      }
    }
    const self = idx.cols.t[ordinal] ?? Number.NaN;
    const iso = (t: number): IsoDate => isoOf(t) ?? (new Date(0).toISOString() as IsoDate);
    record.hub = {
      hubType: (ht !== undefined && ht !== NONE8 ? HUB_TYPE_ORDER[ht] : undefined) ?? "topic",
      status: (hs !== undefined && hs !== NONE8 ? HUB_STATUS_ORDER[hs] : undefined) ?? "quiet",
      range: [iso(Number.isFinite(lo) ? lo : self), iso(Number.isFinite(hi) ? hi : self)],
      members: memberIds as NoteId[],
      brief: [],
    };
    return { ...d, record, members: filled.members, activity: filled.activity };
  }

  /** Sample record: a conversation's notes are the index notes citing any of its messages (there is no ledger). */
  function sampleConversationNotes(idx: DataIndex, convId: string, members: readonly { ordinal: number }[]): { notes: NoteRecord[]; gist: NoteRecord | null } {
    const inConv = new Set(members.map((m) => m.ordinal));
    const { offsets, targets } = idx.rel.noteSources;
    const notes: NoteRecord[] = [];
    if (offsets.length === idx.count + 1) {
      for (let o = 0; o < idx.count; o++) {
        if (idx.cols.pop[o] !== Population.Note) continue;
        let hit = false;
        for (let k = offsets[o] as number; k < (offsets[o + 1] as number) && !hit; k++) hit = inConv.has(targets[k] as number);
        if (!hit) continue;
        notes.push({ ...legacyRecord(idx, o, idx.ids.get(o)), conv: convId as ConversationId });
      }
    }
    let gist: NoteRecord | null = null;
    const row = idx.convs.rowOf(convId);
    const g = row >= 0 ? idx.convs.get(row).gist : NONE32;
    if (g !== NONE32 && g < idx.count) {
      gist = { ...legacyRecord(idx, g, idx.ids.get(g)), kind: "gist", conv: convId as ConversationId };
      const title = row >= 0 ? idx.convs.get(row).title : "";
      gist.text = sampleGistText(title, members.length, notes.filter((n) => n.kind !== "gist" && n.kind !== "hub").map((n) => n.title));
    }
    return { notes, gist };
  }

  /** A legacy note's path from the index folder and title, accepted only when it hashes to the note's id. */
  function guessVaultPath(idx: DataIndex, ordinal: number, id: string): string | undefined {
    const f = idx.cols.folder[ordinal];
    const folder = f !== undefined && f !== NONE32 ? idx.dicts.folders.get(f) : "";
    const title = idx.titles.get(ordinal);
    for (const cand of [`${folder ? `${folder}/` : ""}${title}.md`, `${folder ? `${folder}/` : ""}${title}`]) {
      if (wikiNoteId(cand) === id) return cand;
    }
    return undefined;
  }

  const reader: RecordReader = {
    async entry(ordinal) {
      await sync();
      const idx = deps.index();
      const id = idAt(idx, ordinal);
      if (deps.sandbox?.() && idx) return sampleEntry(idx, ordinal);
      if (!id.startsWith("e_")) throw new CortexError("E_BAD_REQUEST", "not a record entry");
      const hint = hintFor(idx, ordinal);
      const found = await entryRecord(id, hint);
      if (!found) throw notFound("entry");
      const st = await corrections();
      const record = withCorrections(found.record, st);
      const from = monthOf(found.record.addedAt);
      const text = await textOf(found.record, st);
      const [labels, reads, cited, conversationOrd, relatedTerms, secrets] = await Promise.all([
        labelsFor([found.record.id, found.record.conv ?? ""], from, st),
        readsOf(found.record.id, from),
        (async () => {
          const fromIdx = idx ? citedByFromIndex(idx, ordinal) : null;
          const ledger = await citedByFromLedger(found.record.id, from);
          return { rows: fromIdx ?? ledger.rows, notes: ledger.notes };
        })(),
        found.record.conv ? conversationRecord(found.record.conv).then((c) => conversationOrder(found.record.conv as string, c).then((order) => ({ c, order }))) : Promise.resolve(null),
        related(found.record, text),
        secretsOf(found.record, st),
      ]);
      const versions: VersionInfo[] = [{ version: 1, at: found.record.addedAt, by: "import", chars: found.record.chars }];
      for (const e of st.edits.get(found.record.id) ?? []) {
        const v: VersionInfo = { version: e.version, at: e.at, by: e.via === "ask" ? "ask" : "you", chars: e.text.length };
        if (e.via === "ask") v.approvedByYou = true;
        versions.push(v);
      }
      const models: string[] = [];
      let last: IsoDate | undefined;
      for (const r of [...reads].sort(byAt).reverse()) {
        if (!models.includes(r.model)) models.push(r.model);
        if (!last) last = r.at;
      }
      const detail: EntryDetail = {
        record,
        text,
        versions,
        labels,
        history: historyOf(found.record, st, labels, cited.notes, reads),
        citedBy: cited.rows,
        reads: { count: reads.length, models, ...(last ? { last } : {}), at: [...reads].sort(byAt).slice(-200).map((r) => r.at) },
        storage: storageOf(found.record),
        related: relatedTerms,
        secrets,
        dateEvidence: dateEvidence(found.record, await laterEvidence(found.record)),
      };
      if (conversationOrd && found.record.conv) {
        const pos = conversationOrd.order.findIndex((m) => m.id === found.record.id);
        const title = conversationOrd.c?.title ?? (idx && hint.conv ? idx.convs.get(idx.convs.rowOf(hint.conv)).title : "");
        const speakers = conversationOrd.order.map((m) => st.speakers.get(m.id)?.speaker ?? m.speaker);
        detail.conversation = { id: found.record.conv, title, index: Math.max(0, pos), count: conversationOrd.order.length, speakers };
      }
      return detail;
    },

    async note(ordinal) {
      await sync();
      const idx = deps.index();
      const id = idAt(idx, ordinal);
      if (id.startsWith("w_") && idx) return legacyNote(idx, ordinal, id);
      if (!id.startsWith("n_")) throw new CortexError("E_BAD_REQUEST", "not a note");
      if (deps.sandbox?.() && idx) return sampleHubNote(idx, ordinal, id);
      const rec = await noteRecord(id);
      if (!rec) throw notFound("note");
      const st = await corrections();
      const entryCacheLocal = new Map<string, Promise<{ rec: EntryRecord | null; texts: Map<number, TextResult> }>>();
      const cites = await mapLimit(rec.sources ?? [], 8, (c) => citationView(c, st, entryCacheLocal));
      const addressedAt = "at" in rec.madeBy ? rec.madeBy.at : undefined;
      const comments = commentViews(st, [id], rec.addressedComments ?? [], addressedAt);
      const detail: NoteDetail = { record: rec, cites, comments };
      if (rec.hub) {
        const filled = await hubMembersFilled(idx, rec.hub.members ?? []);
        detail.members = filled.members;
        detail.activity = filled.activity;
        detail.evidence = await mapLimit(rec.hub.brief ?? [], 4, async (s) => {
          const views = await mapLimit(s.cites ?? [], 8, (c) => citationView(c, st, entryCacheLocal));
          return { you: views.filter((v) => v.speaker === "you").length, assistant: views.filter((v) => v.speaker === "assistant").length };
        });
      }
      return detail;
    },

    async conversation(convId) {
      await sync();
      if (!/^c_[a-z2-7]{16}$/.test(convId)) throw new CortexError("E_BAD_REQUEST", "not a conversation id");
      const idx = deps.index();
      let rec = await conversationRecord(convId);
      if (!rec && idx) {
        const row = idx.convs.rowOf(convId);
        if (row >= 0) {
          const c = idx.convs.get(row);
          rec = { v: 1, id: convId as ConversationId, seq: 0, source: c.source, nativeId: "", title: c.title, titledBy: "first-line", entryCount: c.entryCount, parts: [], space: c.space, folder: [], updatedAt: isoOf(c.endedAt) ?? new Date(0).toISOString() };
          const s = isoOf(c.startedAt);
          if (s) rec.startedAt = s;
          const e = isoOf(c.endedAt);
          if (e) rec.endedAt = e;
        }
      }
      if (!rec) throw notFound("conversation");
      const st = await corrections();
      const order = await conversationOrder(convId, rec);
      const position = new Map(order.map((m, i) => [m.id, i]));
      const from = monthOf(rec.startedAt) ?? monthOf(rec.updatedAt);
      const sample = deps.sandbox?.() && idx ? sampleConversationNotes(idx, convId, order) : null;
      let notes: NoteRecord[];
      if (sample) notes = sample.notes;
      else {
        const noteHits = await grepRecords<NoteRecord>(vaultRoot, "notes", [convId], (r) => r.conv === convId, { ...scan(), months: sinceMonth(from) });
        notes = [...latestBySeq(noteHits.map((h) => h.record)).values()].filter((n) => n.state === "current" || n.state === "stale");
      }
      let gist = sample ? sample.gist : ((rec.gistNoteId ? notes.find((n) => n.id === rec?.gistNoteId) ?? (await noteRecord(rec.gistNoteId)) : null) ?? notes.find((n) => n.kind === "gist") ?? null);
      if (gist && gist.state !== "current" && gist.state !== "stale") gist = null;
      const atomic = notes.filter((n) => n.kind !== "gist" && n.kind !== "hub");
      let fileTitles: string[] = [];
      if (gist && rec.parts.some((p) => !p.title)) {
        const md = await withFsRetry(() => readTextIfExists(resolveInVault(vaultRoot, gist?.file ?? ""))).catch(() => null);
        if (md) fileTitles = partTitlesFromMarkdown(md);
      }
      const timeOf = (id: string): IsoDate | undefined => {
        const o = idx ? idx.ordinalOf(id) : -1;
        return idx && o >= 0 ? isoOf(idx.cols.t[o] ?? Number.NaN) : undefined;
      };
      const srcParts = rec.parts.length > 0 ? rec.parts : order.length > 0 ? [{ n: 1, firstEntry: order[0]?.id as EntryId, lastEntry: order[order.length - 1]?.id as EntryId, ...(rec.startedAt ? { startedAt: rec.startedAt } : {}) }] : [];
      const parts: ConversationDetail["parts"] = srcParts.map((p, i) => {
        const fromPos = position.get(p.firstEntry);
        const toPos = position.get(p.lastEntry);
        const next = srcParts[i + 1];
        const part: ConversationDetail["parts"][number] = {
          n: p.n,
          msgFrom: fromPos === undefined ? 0 : fromPos + 1,
          msgTo: toPos === undefined ? 0 : toPos + 1,
          notes: atomic.filter((nt) => (nt.part ?? srcParts[0]?.n) === p.n),
        };
        const title = p.title ?? fileTitles[i];
        if (title) part.title = title;
        const startedAt = p.startedAt ?? timeOf(p.firstEntry);
        if (startedAt) part.startedAt = startedAt;
        const endedAt = timeOf(p.lastEntry) ?? (next ? next.startedAt : rec?.endedAt);
        if (endedAt) part.endedAt = endedAt;
        return part;
      });
      const noteIds = notes.map((n) => n.id as string);
      const relevant = new Set<string>([convId, ...noteIds, ...order.map((m) => m.id)]);
      const corrections_ = st.effective.filter((r) => relevant.has(r.target) && r.action !== "comment");
      const addressed = gist?.addressedComments ?? [];
      const addressedAt = gist && "at" in gist.madeBy ? gist.madeBy.at : undefined;
      const detail: ConversationDetail = { record: rec, parts, corrections: corrections_, comments: commentViews(st, [convId, ...noteIds], addressed, addressedAt) };
      if (gist) detail.gist = gist;
      return detail;
    },

    async entryText(ordinal, version) {
      try {
        await sync();
        const idx = deps.index();
        if (deps.sandbox?.()) return deps.sampleText?.(ordinal) ?? { ok: false, reason: "sample" };
        if (!idx || !Number.isInteger(ordinal) || ordinal < 0 || ordinal >= idx.count) return { ok: false, reason: "missing" };
        const id = idx.ids.get(ordinal);
        if (!id.startsWith("e_")) return { ok: false, reason: "missing" };
        const found = await entryRecord(id, hintFor(idx, ordinal));
        if (!found) return { ok: false, reason: "missing" };
        return await textOf(found.record, await corrections(), version);
      } catch (e) {
        log.warn("entry text could not be read", { code: e instanceof CortexError ? e.code : "E_IO" });
        return { ok: false, reason: "missing" };
      }
    },

    async noteMarkdown(ordinal) {
      await sync();
      const idx = deps.index();
      const id = idAt(idx, ordinal);
      if (deps.sandbox?.()) throw new CortexError("E_BAD_REQUEST", "not available in the sample record", { detail: { reason: "sample" } });
      let rel: string | undefined;
      if (id.startsWith("w_") && idx) rel = deps.vaultNotePath?.(id, ordinal) ?? guessVaultPath(idx, ordinal, id);
      else if (id.startsWith("n_")) rel = (await noteRecord(id))?.file;
      if (!rel) throw notFound("note file");
      let text: string | null;
      try {
        text = await withFsRetry(() => readTextIfExists(resolveInVault(vaultRoot, rel as string)));
      } catch (e) {
        throw new CortexError("E_IO", "the note file is not readable on this computer", { detail: { reason: "not-local" }, cause: e });
      }
      if (text === null) throw notFound("note file");
      return text;
    },

    async conversationSlice(convId, from, to) {
      await sync();
      if (!/^c_[a-z2-7]{16}$/.test(convId)) throw new CortexError("E_BAD_REQUEST", "not a conversation id");
      const rec = await conversationRecord(convId);
      const order = await conversationOrder(convId, rec);
      const start = Math.max(0, Math.min(order.length, Math.floor(Number.isFinite(from) ? from : 0)));
      const end = Math.max(start, Math.min(order.length, Math.floor(Number.isFinite(to) ? to : order.length)));
      const st = await corrections();
      const idx = deps.index();
      const page = order.slice(start, end);
      return mapLimit(page, 8, async (m) => {
        const found = await entryRecord(m.id, { ...hintFor(idx, m.ordinal), conv: convId });
        const speaker = st.speakers.get(m.id)?.speaker ?? found?.record.speaker ?? m.speaker;
        const text: TextResult = found ? await textOf(found.record, st) : deps.sandbox?.() ? (deps.sampleText?.(m.ordinal) ?? { ok: false, reason: "sample" }) : { ok: false, reason: "missing" };
        return { ordinal: m.ordinal, speaker, text };
      });
    },

    async revealHeld(entryId, marker) {
      if (!Number.isInteger(marker) || marker < 0) return null;
      const held = await readHeld(cacheDir, entryId);
      return held?.secrets.find((s) => s.n === marker)?.text ?? null;
    },
  };
  return reader;
}
