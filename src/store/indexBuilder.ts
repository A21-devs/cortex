/**
 * Builds `<cache>/record.cxi` (and `record.delta.cxi`) from the ledgers (runner side), and owns the ordinal
 * allocator file `<cache>/ordinals.cxo` that the plugin's vault builder shares. Owner: E7.
 *
 * `composeRecordIndex` is pure: entries, conversations, notes, labels and corrections in, one IndexBuildInput out
 * (event sourcing: exclusions, edits → counts, re-filing, speaker/date overrides; merges stay display-time only).
 * Effective labels: user labels outrank model labels; refused, unanswered, superseded, rejected and (while held)
 * unconfirmed labels do not count. Flags: Undated, Excluded, Reference, HiddenByDefault (+ Subagent, Harness,
 * AssistantPane, Automated), Corrected, Superseded, Pinned, Live, NoArea, MachineWritten, Stale, Sourceless.
 *
 * `buildRecordIndex` allocates ordinals in arrival order under the cache lock `cache:ordinals`, writes the base
 * file when there is none (or on `--full`, an epoch change, or when the change is large) and otherwise a delta
 * file `record.delta.cxi` with the rows that appeared and the in-place patches, then writes the change signal.
 */
import fsp from "node:fs/promises";
import type { CancelToken } from "../shared/cancel";
import { ItemFlag, NONE32, Population, type ConversationRow } from "../shared/index-format";
import {
  IndexStore,
  OrdinalTable,
  PATCH_LABELS,
  decodePart,
  encodeIndex,
  newEpoch,
  noteItemKind,
  readIndexHeader,
  recordItemKind,
  type IndexBuildInput,
  type IndexItemInput,
  type IndexPatchInput,
  type LabelInput,
} from "../shared/indexCodec";
import { exclusionMatcher, foldCorrections, type EffectiveCorrections } from "../shared/correctionsFold";
import { findPack } from "../shared/packs";
import type { IndexBuildResult } from "../shared/protocol/runner";
import { wordCount } from "../shared/text";
import { parseIso } from "../shared/time";
import type { ConversationRecord, CorrectionRecord, EntryRecord, LabelRecord, NoteRecord } from "../shared/types";
import { ensureCacheDir, writeFileAtomic } from "../node/fsAtomic";
import { locksDirOf, withLock } from "../node/locks";
import { cacheWritablePath, isCacheDirRegistered } from "../node/paths";
import { cacheLayout, type StoreContext } from "./layout";
import { latestBySeq, type LedgerStore } from "./ledger";
import { readSignal, writeSignal, type CacheSignal, type SignalKind } from "./signal";
import { listStaged, readStage } from "./stage";

// ───────────────────────────── the allocator file ─────────────────────────────

async function readBytes(abs: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await fsp.readFile(abs));
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return null;
    throw e;
  }
}

/** Write a cache file (atomic, minted path); registers the cache folder first when this process has not. */
export async function writeCacheFile(cacheDir: string, rel: string, bytes: Uint8Array): Promise<void> {
  if (!isCacheDirRegistered(cacheDir)) await ensureCacheDir(cacheDir);
  await writeFileAtomic(cacheWritablePath(cacheDir, rel), bytes);
}

/** Read a cache file as an ArrayBuffer of its own (null when missing). */
export async function readCacheBuffer(abs: string): Promise<ArrayBuffer | null> {
  const b = await readBytes(abs);
  if (!b) return null;
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/**
 * Run `fn` with the shared allocator table while holding `cache:ordinals`; saves the table when `fn` allocated.
 * `fresh` starts a new epoch (index --full); a missing or damaged table also starts one.
 */
export async function withOrdinals<T>(
  ctx: Pick<StoreContext, "cacheDir" | "owner" | "lockStaleMs">,
  opts: { fresh?: boolean; now?: number },
  fn: (table: OrdinalTable) => Promise<T> | T,
): Promise<{ value: T; table: OrdinalTable; newEpoch: boolean }> {
  if (!isCacheDirRegistered(ctx.cacheDir)) await ensureCacheDir(ctx.cacheDir);
  const layout = cacheLayout(ctx.cacheDir);
  return withLock(locksDirOf(ctx.cacheDir), "cache:ordinals", { owner: ctx.owner, staleMs: ctx.lockStaleMs, waitMs: 30_000 }, async () => {
    let table: OrdinalTable | null = null;
    let created = false;
    if (!opts.fresh) {
      const bytes = await readBytes(layout.ordinals);
      if (bytes) {
        try {
          table = OrdinalTable.decode(bytes);
        } catch {
          table = null;
        }
      }
    }
    if (!table) {
      table = new OrdinalTable(newEpoch(opts.now ?? Date.now()));
      table.dirty = true;
      created = true;
    }
    const value = await fn(table);
    if (table.dirty) {
      await writeFileAtomic(cacheWritablePath(ctx.cacheDir, "ordinals.cxo"), table.encode());
      table.dirty = false;
    }
    return { value, table, newEpoch: created };
  });
}

// ───────────────────────────── composing the record part ─────────────────────────────

export interface LedgerSnapshot {
  entries: readonly EntryRecord[];
  /** Latest record per id. */
  conversations: readonly ConversationRecord[];
  /** Latest record per id. */
  notes: readonly NoteRecord[];
  labels: readonly LabelRecord[];
  corrections: readonly CorrectionRecord[];
  seq: number;
}

export interface ComposeOptions {
  epoch: string;
  /** Allocate (or look up) the ordinal of an id. */
  ordinal(id: string): number;
  /** Ordinal of an id that is already allocated, -1 otherwise (relation targets in other parts). */
  peek(id: string): number;
  count(): number;
  builtAt?: string;
}

const HIDDEN_FLAG: Readonly<Record<NonNullable<EntryRecord["hiddenByDefault"]>, number>> = {
  subagent: ItemFlag.HiddenByDefault | ItemFlag.Subagent,
  harness: ItemFlag.HiddenByDefault | ItemFlag.Harness,
  "cortex-ask": ItemFlag.HiddenByDefault | ItemFlag.AssistantPane,
  tool: ItemFlag.HiddenByDefault,
  reference: ItemFlag.HiddenByDefault | ItemFlag.Reference,
  automated: ItemFlag.HiddenByDefault | ItemFlag.Automated,
};

const tOrUndefined = (iso: string | undefined | null): number | undefined => {
  if (!iso) return undefined;
  const t = parseIso(iso);
  return Number.isFinite(t) ? t : undefined;
};

interface EffLabel {
  pack: string;
  version: string;
  field: string;
  value: string | string[] | boolean;
  byUser: boolean;
  at: number;
}

/** Effective labels per target (before fan-out): user corrections outrank model labels. */
export function effectiveLabels(labels: readonly LabelRecord[], eff: EffectiveCorrections): Map<string, EffLabel[]> {
  const best = new Map<string, EffLabel>();
  const put = (target: string, l: EffLabel): void => {
    const key = `${target}|${l.pack}|${l.field}`;
    const prev = best.get(key);
    if (!prev || (l.byUser && !prev.byUser) || (l.byUser === prev.byUser && l.at >= prev.at)) best.set(key, l);
  };
  for (const r of labels) {
    if (r.supersededBy || r.value === null || eff.rejectedLabels.has(r.id)) continue;
    if (r.state !== "set" && !(r.state === "held" && eff.confirmedLabels.has(r.id))) continue;
    put(r.target, { pack: r.pack, version: r.packVersion, field: r.field, value: r.value, byUser: false, at: parseIso(r.at) || 0 });
  }
  for (const [key, value] of eff.userLabels) {
    // Clearing a label (null) hides the model's value for that field.
    if (value === null) {
      best.delete(key);
      continue;
    }
    const [target, pack, field] = key.split("|") as [string, string, string];
    const version = findPack(pack)?.version ?? "1.0.0";
    put(target, { pack, version, field, value, byUser: true, at: Number.MAX_SAFE_INTEGER });
  }
  const out = new Map<string, EffLabel[]>();
  for (const [key, l] of best) {
    const target = key.slice(0, key.indexOf("|"));
    const list = out.get(target) ?? [];
    list.push(l);
    out.set(target, list);
  }
  return out;
}

function labelType(pack: string, field: string, sample: string | string[] | boolean): LabelInput["type"] {
  const p = findPack(pack);
  const f = p?.fields.find((x) => x.key === field);
  if (f) return f.type;
  if (Array.isArray(sample)) return "multi";
  if (typeof sample === "boolean") return "bool";
  return "enum";
}

/** The record part as builder input. Pure apart from the callbacks in `opts` (the allocator). */
export function composeRecordIndex(snap: LedgerSnapshot, opts: ComposeOptions): IndexBuildInput {
  const eff = foldCorrections(snap.corrections);
  const excludedBy = exclusionMatcher(eff);
  const labelsByTarget = effectiveLabels(snap.labels, eff);
  const superseded = new Set<string>();
  for (const e of snap.entries) if (e.supersedes) superseded.add(e.supersedes);
  const convById = new Map<string, ConversationRecord>(snap.conversations.map((c) => [c.id, c]));

  const items: IndexItemInput[] = [];
  const entriesOfConv = new Map<string, string[]>();
  const rowFlags = new Map<string, number>();

  for (const e of snap.entries) {
    const fix = eff.refiles.get(e.id) ?? (e.conv !== undefined ? eff.refiles.get(e.conv) : undefined);
    const edits = eff.edits.get(e.id);
    const latestEdit = edits && edits.length > 0 ? edits[edits.length - 1] : undefined;
    const speaker = eff.speakers.get(e.id);
    const hasDate = eff.dates.has(e.id);
    const writtenAt = hasDate ? (eff.dates.get(e.id) ?? undefined) : e.writtenAt;
    const t = tOrUndefined(writtenAt);
    const space = fix?.space ?? e.space;
    const folder = fix?.folder ?? e.folder;
    const project = fix?.project !== undefined ? (fix.project ?? undefined) : e.project;
    const rule = excludedBy({ id: e.id, source: e.source, folder: e.folder, path: e.sourceRef.path, ...(e.conv !== undefined ? { conv: e.conv } : {}), ...(e.project !== undefined ? { project: e.project } : {}) });
    let flags = 0;
    if (t === undefined) flags |= ItemFlag.Undated;
    if (rule) flags |= ItemFlag.Excluded;
    if (e.hiddenByDefault) flags |= HIDDEN_FLAG[e.hiddenByDefault];
    if (superseded.has(e.id)) flags |= ItemFlag.Superseded;
    if (edits || speaker || hasDate || fix) flags |= ItemFlag.Corrected;
    if (eff.pinned.has(e.id)) flags |= ItemFlag.Pinned;
    if (e.text.store === "stage") flags |= ItemFlag.Live;
    if (space === "none") flags |= ItemFlag.NoArea;
    const conv = e.conv !== undefined ? convById.get(e.conv) : undefined;
    const item: IndexItemInput = {
      id: e.id,
      kind: recordItemKind(e.kind),
      pop: Population.Record,
      source: e.source,
      speaker: speaker?.speaker ?? e.speaker,
      space,
      folderPath: folder.join("/"),
      tAdded: parseIso(e.addedAt) || 0,
      chars: latestEdit ? latestEdit.text.length : e.chars,
      words: latestEdit ? wordCount(latestEdit.text) : e.words,
      flags,
      title: e.title ?? conv?.title ?? "",
      ordinal: opts.ordinal(e.id),
    };
    if (t !== undefined) item.t = t;
    if (e.conv !== undefined) item.conv = e.conv;
    if (e.idx !== undefined) item.idx = e.idx;
    if (project) item.project = project;
    items.push(item);
    rowFlags.set(e.id, flags);
    if (e.conv !== undefined) {
      const list = entriesOfConv.get(e.conv) ?? [];
      list.push(e.id);
      entriesOfConv.set(e.conv, list);
    }
  }

  const noteSources = new Map<string, string[]>();
  const hubMembers = new Map<string, string[]>();
  const noteLinks = new Map<string, string[]>();
  const gistOf = new Map<string, string>();
  for (const n of snap.notes) {
    const fix = eff.refiles.get(n.id);
    const t = tOrUndefined(n.date ?? ("at" in n.madeBy ? n.madeBy.at : undefined));
    const space = fix?.space ?? n.space;
    let flags = ItemFlag.MachineWritten;
    if (t === undefined) flags |= ItemFlag.Undated;
    if (n.state === "excluded" || exclusionMatcher(eff)({ id: n.id, source: "obsidian", folder: n.folder, ...(n.conv !== undefined ? { conv: n.conv } : {}), path: n.file })) flags |= ItemFlag.Excluded;
    if (n.state === "stale") flags |= ItemFlag.Stale;
    if (n.state === "superseded") flags |= ItemFlag.Superseded;
    if (n.state === "hidden") flags |= ItemFlag.HiddenByDefault;
    if (n.sources.length === 0 && n.kind !== "hub") flags |= ItemFlag.Sourceless;
    if (eff.pinned.has(n.id)) flags |= ItemFlag.Pinned;
    if (eff.comments.has(n.id) || fix) flags |= ItemFlag.Corrected;
    if (space === "none") flags |= ItemFlag.NoArea;
    const item: IndexItemInput = {
      id: n.id,
      kind: noteItemKind(n.kind),
      pop: Population.Note,
      source: "obsidian",
      speaker: "assistant",
      space,
      folderPath: (fix?.folder ?? n.folder).join("/"),
      tAdded: parseIso("at" in n.madeBy ? n.madeBy.at : n.date) || t || 0,
      chars: n.text.length,
      words: wordCount(n.text),
      flags,
      title: n.title,
      noteKind: n.kind,
      ordinal: opts.ordinal(n.id),
    };
    if (t !== undefined) item.t = t;
    if (n.conv !== undefined) item.conv = n.conv;
    if (n.parent) item.parent = n.parent;
    const project = fix?.project !== undefined ? (fix.project ?? undefined) : typeof n.facets?.project === "string" ? n.facets.project : undefined;
    if (project) item.project = project;
    if (n.hub) {
      item.hubType = n.hub.hubType;
      item.hubStatus = n.hub.status;
      hubMembers.set(n.id, n.hub.members);
    }
    items.push(item);
    rowFlags.set(n.id, flags);
    if (n.sources.length > 0) noteSources.set(n.id, [...new Set(n.sources.map((c) => c.entryId))]);
    if (n.kind === "gist" && n.conv !== undefined) gistOf.set(n.conv, n.id);
  }

  const conversations: ConversationRow[] = snap.conversations.map((c) => {
    const gist = c.gistNoteId ?? gistOf.get(c.id);
    const fix = eff.refiles.get(c.id);
    return {
      id: c.id,
      title: c.title,
      source: c.source,
      startedAt: tOrUndefined(c.startedAt) ?? Number.NaN,
      endedAt: tOrUndefined(c.endedAt) ?? Number.NaN,
      entryCount: c.entryCount,
      space: fix?.space ?? c.space,
      gist: gist ? (opts.peek(gist) >= 0 ? opts.peek(gist) : NONE32) : NONE32,
    };
  });

  // Labels: fan a conversation's labels out to its entries and gist; labels on vault notes become patch rows.
  const columns = new Map<string, { input: LabelInput; versions: string[] }>();
  const patchTargets = new Set<string>();
  const addLabel = (row: string, l: EffLabel): void => {
    const key = `${l.pack}|${l.field}`;
    let col = columns.get(key);
    if (!col) {
      col = { input: { pack: l.pack, packVersion: l.version, field: l.field, type: labelType(l.pack, l.field, l.value), byTarget: new Map() }, versions: [] };
      columns.set(key, col);
    }
    if (l.version > col.input.packVersion) col.input.packVersion = l.version;
    (col.input.byTarget as Map<string, { value: string | string[] | boolean; byUser: boolean }>).set(row, { value: l.value, byUser: l.byUser });
  };
  const known = new Set(items.map((i) => i.id));
  for (const [target, list] of labelsByTarget) {
    const rows: string[] = [];
    if (target.startsWith("c_")) {
      // a loop, not push(...list): a session with over ~120,000 entries would overflow the call stack
      for (const e of entriesOfConv.get(target) ?? []) rows.push(e);
      const g = convById.get(target)?.gistNoteId ?? gistOf.get(target);
      if (g) rows.push(g);
    } else if (known.has(target)) rows.push(target);
    else if (target.startsWith("w_")) {
      rows.push(target);
      patchTargets.add(target);
    }
    for (const row of rows) for (const l of list) addLabel(row, l);
  }
  const labelled = new Set<string>();
  for (const col of columns.values()) for (const row of col.input.byTarget.keys()) labelled.add(row);
  for (const it of items) if (labelled.has(it.id)) it.flags |= ItemFlag.HasLabels;

  const patches: IndexPatchInput[] = [...patchTargets].map((id) => ({ id, ordinal: opts.ordinal(id), mask: PATCH_LABELS }));
  return {
    part: "record",
    seq: snap.seq,
    items,
    conversations,
    noteSources,
    hubMembers,
    noteLinks,
    labels: [...columns.values()].map((c) => c.input),
    epoch: opts.epoch,
    count: opts.count(),
    builtAt: opts.builtAt ?? new Date().toISOString(),
    ordinalOf: (id) => {
      const o = opts.peek(id);
      return o >= 0 ? o : undefined;
    },
    ...(patches.length > 0 ? { patches } : {}),
  };
}

// ───────────────────────────── building the files ─────────────────────────────

export interface IndexBuilderDeps {
  store: StoreContext;
  ledger: LedgerStore;
  token: CancelToken;
  progress(done: number, total?: number): void;
  yield(): Promise<void>;
}

/** A delta larger than this share of the base (or this many rows) is folded into a new base instead. */
export const DELTA_COMPACT_SHARE = 0.25;
export const DELTA_COMPACT_MIN_ROWS = 5000;

/** Read the ledgers into a snapshot (upsert ledgers keep the latest record per id). */
export async function readLedgerSnapshot(deps: Pick<IndexBuilderDeps, "ledger" | "token" | "progress" | "yield">): Promise<LedgerSnapshot> {
  const { ledger, token } = deps;
  // The seq BEFORE the scan: a batch committed while scanning may be missing, so the snapshot must not claim it.
  const seq = await ledger.seq();
  const entries: EntryRecord[] = [];
  let n = 0;
  for await (const e of ledger.readAll("entries")) {
    entries.push(e);
    if (++n % 2000 === 0) {
      token.throwIfCancelled();
      deps.progress(n);
      await deps.yield();
    }
  }
  const conversations: ConversationRecord[] = [...latestBySeq(await collect(ledger.readAll("conversations"))).values()];
  const notes: NoteRecord[] = [...latestBySeq(await collect(ledger.readAll("notes"))).values()];
  const labels = await collect(ledger.readAll("labels"));
  token.throwIfCancelled();
  const corrections = await ledger.readCorrections();
  return { entries, conversations, notes, labels, corrections, seq };
}

/**
 * Live messages staged on this computer (stage.ts) join the index flagged Live, so the figure grows while a session
 * runs; their seal later appends the same ids to the ledger, keeping their ordinals. Ledger entries win (a sealed
 * stage whose file is not removed yet). Before this, live sessions stayed out of the figure until sealed.
 */
async function readStaged(store: Pick<StoreContext, "cacheDir" | "log">): Promise<EntryRecord[]> {
  const out: EntryRecord[] = [];
  for (const s of await listStaged(store)) {
    try {
      for (const m of await readStage(store, s.conv)) out.push(m.entry);
    } catch (e) {
      // One locked stage file (antivirus, a write in progress) must not fail the build; its next staging retries.
      store.log.warn("a live session could not be read for the index", { conv: s.conv, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

function withStaged(snap: LedgerSnapshot, staged: readonly EntryRecord[]): LedgerSnapshot {
  if (staged.length === 0) return snap;
  const known = new Set(snap.entries.map((e) => e.id));
  const extra: EntryRecord[] = [];
  for (const e of staged) {
    if (known.has(e.id)) continue;
    known.add(e.id);
    extra.push(e);
  }
  return extra.length === 0 ? snap : { ...snap, entries: [...snap.entries, ...extra] };
}

/** Signal kinds that change what the record index holds (the plugin's watcher and stale check use the same list). */
const INDEX_KINDS: readonly SignalKind[] = ["entries", "staged", "labels", "notes", "corrections"];

/**
 * A batch committed while this build ran may be missing from it, yet the build's own signal now outranks the
 * batch's mark, so nothing would build again until the next commit. Name those kinds once more after the build's
 * signal: a watching plugin builds again (at most one no-op build when the batch was in fact included).
 */
async function announceLate(store: { cacheDir: string; owner: string }, start: CacheSignal | null, written: CacheSignal, seq: number, epoch: string): Promise<void> {
  if (start && written.n < start.n) return; // the cache was cleared meanwhile: readers treat everything as changed
  const late = INDEX_KINDS.filter((k) => (written.marks[k] ?? 0) > (start?.marks[k] ?? 0));
  if (late.length > 0) await writeSignal(store.cacheDir, { seq, epoch, changed: late, by: store.owner });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

export async function buildRecordIndex(deps: IndexBuilderDeps, opts: { full: boolean }): Promise<IndexBuildResult> {
  const t0 = Date.now();
  const { store, token } = deps;
  const layout = cacheLayout(store.cacheDir);
  if (!isCacheDirRegistered(store.cacheDir)) await ensureCacheDir(store.cacheDir);
  const startSignal = await readSignal(store.cacheDir);
  // The stage BEFORE the ledger: a seal landing between the two reads leaves the staged copy in the first and the
  // ledger copy in the second (the ledger's wins), never neither. Later staging names itself ("staged").
  const staged = await readStaged(store);
  const snap = withStaged(await readLedgerSnapshot(deps), staged);
  token.throwIfCancelled();
  deps.progress(snap.entries.length, snap.entries.length + 2);
  await deps.yield();

  const composed = await withOrdinals(store, { fresh: opts.full }, (table) =>
    composeRecordIndex(snap, { epoch: table.epoch, ordinal: (id) => table.allocate(id), peek: (id) => table.get(id), count: () => table.size }),
  );
  const input = composed.value;
  const epoch = composed.table.epoch;
  token.throwIfCancelled();
  const full = encodeIndex(input);
  deps.progress(snap.entries.length + 1, snap.entries.length + 2);

  const baseBuf = opts.full || composed.newEpoch ? null : await readCacheBuffer(layout.recordIndex);
  let base: { header: ReturnType<typeof readIndexHeader>; buf: ArrayBuffer } | null = null;
  if (baseBuf) {
    try {
      const header = readIndexHeader(baseBuf);
      if (header.epoch === epoch) base = { header, buf: baseBuf };
    } catch {
      base = null;
    }
  }

  const count = input.count ?? composed.table.size;
  let result: IndexBuildResult;
  let written: CacheSignal;
  const writeBase = async (): Promise<void> => {
    await writeCacheFile(store.cacheDir, "record.cxi", new Uint8Array(full));
    await fsp.rm(layout.recordDelta, { force: true });
  };
  if (!base) {
    await writeBase();
    result = { file: layout.recordIndex, epoch, fromCount: count, count, seq: snap.seq, patched: 0, durationMs: 0 };
    written = await writeSignal(store.cacheDir, { seq: snap.seq, epoch, changed: ["record-index"], by: store.owner });
  } else {
    const before = IndexStore.fromParts([decodePart(base.buf)]);
    const after = IndexStore.fromParts([decodePart(full)]);
    const d = before.diff(after);
    const changed = d.appeared.length + d.patches.length;
    if (d.structural || changed > Math.max(DELTA_COMPACT_MIN_ROWS, before.count * DELTA_COMPACT_SHARE)) {
      await writeBase();
      result = { file: layout.recordIndex, epoch, fromCount: count, count, seq: snap.seq, patched: 0, durationMs: 0 };
      written = await writeSignal(store.cacheDir, { seq: snap.seq, epoch, changed: ["record-index"], by: store.owner });
    } else if (changed === 0 && d.tables === false) {
      // Nothing moved; keep an existing delta as it is. Still record that the index is current up to this seq and
      // this write ("record-checked" wakes no watcher): otherwise a ledger seq that moved without index changes (run
      // records synced from another computer) or a change mark the build turned out to cover would read as stale on
      // every start.
      result = { file: layout.recordDelta, epoch, fromCount: count, count, seq: snap.seq, patched: 0, durationMs: 0 };
      written = await writeSignal(store.cacheDir, { seq: snap.seq, epoch, changed: ["record-checked"], by: store.owner });
    } else {
      const delta = after.encodeRows({ rows: d.appeared, patches: d.patches });
      await writeCacheFile(store.cacheDir, "record.delta.cxi", new Uint8Array(delta));
      result = { file: layout.recordDelta, epoch, fromCount: d.appeared.length > 0 ? d.appeared[0]! : count, count, seq: snap.seq, patched: d.patches.length, durationMs: 0 };
      written = await writeSignal(store.cacheDir, { seq: snap.seq, epoch, changed: ["record-delta"], by: store.owner });
    }
  }
  // The index files are written: a failed re-announce must not report the build as failed.
  await announceLate(store, startSignal, written, snap.seq, epoch).catch((e: unknown) => store.log.warn("late changes could not be signalled", { error: e instanceof Error ? e.message : String(e) }));
  deps.progress(snap.entries.length + 2, snap.entries.length + 2);
  result.durationMs = Date.now() - t0;
  return result;
}
