/**
 * Index service on the plugin side (shared by every leaf). Owner: E7.
 *
 * Load path (view open, or the background tier after the first import):
 *   1. read <cache>/record.cxi (runner-built; ordinals from the shared allocator `ordinals.cxo`) — if missing or
 *      stale (the cache signal says entries, labels, notes or corrections changed after the last build) ask the
 *      runner for index.build; with no runner the files that exist are used;
 *   2. read or build <cache>/vault.cxi from metadataCache (vaultSource), allocating ordinals in the same table;
 *   3. decode + merge on the main thread (a read-only copy for tooltips and readers) and send the worker COPIES
 *      of the buffers — never the decoded ones (TRANSFER-DETACH): `record`, `vault` and one `corrections` part
 *      holding the runner's pending delta plus the live overlay of your corrections; load the search shards;
 *   4. publish the shared data status and emit "index:loaded".
 * Live updates: the cache signal → `record.delta.cxi` is appended when its epoch matches (leaves keep their own
 * revealedCount, so "Show them" in one leaf never changes another), a new epoch forces a full reload, vault edits
 * are diffed into appended rows and patches, and corrections change flags through patchIndex (Pinned, Excluded).
 */
import { signal, effect, type ReadonlySignal } from "@preact/signals-core";
import type { DataIndex } from "../shared/index-format";
import { ItemFlag, NONE32, NONE8, NOTE_KIND_ORDER, HUB_TYPE_ORDER, HUB_STATUS_ORDER, SOURCE_ORDER, SPACE_ORDER, SPEAKER_ORDER, Population } from "../shared/index-format";
import { IndexStore, PATCH_FLAGS, decodePart, encodeIndex, readIndexHeader, sampleIndexInput, type IndexPart } from "../shared/indexCodec";
import { exclusionMatcher } from "../shared/correctionsFold";
import { asCortexError } from "../shared/errors";
import type { Logger } from "../shared/log";
import type { FromRunner } from "../shared/protocol/runner";
import { toIso } from "../shared/time";
import type { HubStatus, HubType, IsoDate, NoteKind, SourceKind, Speaker } from "../shared/types";
import type { EventBus } from "../state/events";
import type { SharedStore } from "../state/store";
import type { EffectiveCorrections } from "../shared/correctionsFold";
import type { CorrectionServiceExt } from "./corrections";
import type { RunnerClient } from "./runnerClient";
import type { WorkerClient } from "./workerClient";

export interface ItemMeta {
  ordinal: number;
  id: string;
  title: string;
  kind: number;
  noteKind?: NoteKind;
  mapKind?: HubType;
  /** A map's recency (active, quiet, paused); absent for everything else. */
  hubStatus?: HubStatus;
  population: "note" | "record";
  source: SourceKind;
  speaker: Speaker;
  writtenAt?: IsoDate;
  folder: string;
  space: string;
  words: number;
  conversation?: { id: string; title: string; index: number; count: number };
  flags: number;
}

export interface IndexService {
  readonly index: ReadonlySignal<DataIndex | null>;
  /** Load caches (building what is missing) and feed the worker. Idempotent. */
  load(opts?: { force?: boolean }): Promise<void>;
  meta(ordinal: number): ItemMeta | undefined;
  /** -1 when the id is not in the loaded index. */
  ordinalOf(id: string): number;
  dispose(): void;
}

export interface IndexServiceExt extends IndexService {
  /** Ordinal epoch of the loaded index ("" before the first load; "sample" while the sample record shows). */
  readonly epoch: string;
  /** Ask the runner to fold new entries into the index (debounced, one at a time). */
  requestBuild(opts?: { full?: boolean }): Promise<void>;
  /** The sample record (M13): load it into the worker and the main-thread copy, or go back to the real index. */
  showSample(on: boolean, seed?: number): Promise<void>;
}

/** What the signal carries that the service needs. */
export interface SignalLite {
  epoch?: string;
  marks: Readonly<Record<string, number>>;
}

/**
 * The disk and Obsidian side of the service (see indexerNode.ts): the cache files, the cache signal and the
 * vault. Kept behind an interface so this module (whose types the UI imports) stays free of Node modules.
 */
export interface IndexIo {
  readRecord(): Promise<ArrayBuffer | null>;
  readDelta(): Promise<ArrayBuffer | null>;
  /** Search shards in load order (the live shard last). */
  readSearchShards(): Promise<ArrayBuffer[]>;
  /** The change counters of the cache signal ("record-index", "entries", …); empty when there is no signal. */
  marks(): Promise<Readonly<Record<string, number>>>;
  /** The record index is out of date: entries, labels, notes or corrections changed after the last build. */
  isStale(headerSeq: number): Promise<boolean>;
  /** The vault part for this ordinal epoch (the cache when it still matches, otherwise built and cached); null when vault notes are off or the allocator moved on. */
  vaultPart(recordEpoch: string): Promise<ArrayBuffer | null>;
  /** A freshly built vault part (and cached) to diff against what is loaded; null when vault notes are off. */
  rebuildVault(): Promise<ArrayBuffer | null>;
  watchCache(onSignal: (sig: SignalLite, changed: readonly string[]) => void, onError: (e: unknown) => void): () => void;
  /** Vault edits, batched; the callback may run often. */
  watchVault(onChange: () => void): () => void;
}

export interface IndexDeps {
  io: IndexIo;
  log: Logger;
  bus: EventBus;
  shared: SharedStore;
  runner: Pick<RunnerClient, "request">;
  worker: Pick<WorkerClient, "call">;
  corrections?: Pick<CorrectionServiceExt, "effective" | "load" | "refresh" | "version">;
  /** Watch the cache signal and the vault (default true; tests turn it off). */
  watch?: boolean;
  /** Debounce for runner builds asked for by signal changes (ms). */
  buildDebounceMs?: number;
  /** Minimum time between the end of one background build and the start of the next (default 10 s). */
  buildGapMs?: number;
}

const VIEW = "index";
/** Background builds start at least this long after the previous one ended. */
const MIN_BUILD_GAP_MS = 10_000;

const enumAt = <T>(order: readonly T[], code: number, fallback: T): T => (code === NONE8 ? fallback : (order[code] ?? fallback));

/** What a tooltip or reader needs to know about one item. */
export function itemMeta(index: DataIndex, ordinal: number): ItemMeta | undefined {
  if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= index.count) return undefined;
  const c = index.cols;
  if (c.kind[ordinal] === NONE8) return undefined;
  const t = c.t[ordinal]!;
  const folder = c.folder[ordinal]!;
  const conv = c.conv[ordinal]!;
  const nk = c.noteKind[ordinal]!;
  const hub = c.hubType[ordinal]!;
  const meta: ItemMeta = {
    ordinal,
    id: index.ids.get(ordinal),
    title: index.titles.get(ordinal),
    kind: c.kind[ordinal]!,
    population: c.pop[ordinal] === Population.Note ? "note" : "record",
    source: enumAt(SOURCE_ORDER, c.source[ordinal]!, "files"),
    speaker: enumAt(SPEAKER_ORDER, c.speaker[ordinal]!, "other"),
    folder: folder === NONE32 ? "" : index.dicts.folders.get(folder),
    space: enumAt(SPACE_ORDER, c.space[ordinal]!, "none"),
    words: c.words[ordinal]!,
    flags: c.flags[ordinal]!,
  };
  if (nk !== NONE8) meta.noteKind = NOTE_KIND_ORDER[nk] as NoteKind;
  if (hub !== NONE8) meta.mapKind = HUB_TYPE_ORDER[hub] as HubType;
  const hubStatus = c.hubStatus[ordinal];
  if (hub !== NONE8 && hubStatus !== undefined && hubStatus !== NONE8) meta.hubStatus = HUB_STATUS_ORDER[hubStatus] as HubStatus;
  if (Number.isFinite(t)) meta.writtenAt = toIso(t);
  if (conv !== NONE32 && conv < index.convs.size) {
    const row = index.convs.get(conv);
    const idx = c.idx[ordinal]!;
    meta.conversation = { id: row.id, title: row.title, index: idx === NONE32 ? 0 : idx, count: row.entryCount };
  }
  return meta;
}

/** Desired Pinned / Excluded bits for the rows your corrections touch (see header comment). */
export function overlayFlags(store: IndexStore, eff: EffectiveCorrections, tracked: { excluded: Set<number>; pinned: Set<number> }): { ordinals: number[]; flags: number[] } {
  const index = store.snapshot();
  const wantPin = new Set<number>();
  for (const id of eff.pinned) {
    const o = store.ordinalOf(id);
    if (o >= 0) wantPin.add(o);
  }
  const wantOut = new Set<number>();
  if (eff.excluded.size > 0) {
    const match = exclusionMatcher(eff);
    for (let o = 0; o < index.count; o++) {
      if (!store.isPresent(o) || index.cols.pop[o] !== Population.Record) continue;
      const conv = index.cols.conv[o]!;
      const folderId = index.cols.folder[o]!;
      const projectId = index.cols.project[o]!;
      const rule = match({
        id: index.ids.get(o),
        source: enumAt(SOURCE_ORDER, index.cols.source[o]!, "files"),
        folder: folderId === NONE32 ? [] : index.dicts.folders.get(folderId).split("/"),
        ...(conv !== NONE32 && conv < index.convs.size ? { conv: index.convs.get(conv).id } : {}),
        ...(projectId !== NONE32 ? { project: index.dicts.projects.get(projectId) } : {}),
      });
      if (rule) wantOut.add(o);
    }
    // Notes and entries named directly (a machine note you left out).
    for (const [target, rule] of eff.excluded) {
      if (rule.scope !== "entry") continue;
      const o = store.ordinalOf(target);
      if (o >= 0) wantOut.add(o);
    }
  }
  const ordinals: number[] = [];
  const flags: number[] = [];
  const touch = new Set<number>([...wantPin, ...wantOut, ...tracked.excluded, ...tracked.pinned]);
  for (const o of touch) {
    if (!store.isPresent(o)) continue;
    let f = store.flagsAt(o);
    const before = f;
    if (wantPin.has(o)) f |= ItemFlag.Pinned;
    else if (tracked.pinned.has(o)) f &= ~ItemFlag.Pinned;
    if (wantOut.has(o)) f |= ItemFlag.Excluded;
    else if (tracked.excluded.has(o)) f &= ~ItemFlag.Excluded;
    if (f !== before) {
      ordinals.push(o);
      flags.push(f >>> 0);
    }
  }
  tracked.pinned.clear();
  for (const o of wantPin) tracked.pinned.add(o);
  tracked.excluded.clear();
  for (const o of wantOut) tracked.excluded.add(o);
  return { ordinals, flags };
}

function overlayPart(store: IndexStore, diff: { ordinals: number[]; flags: number[] }): ArrayBuffer {
  return encodeIndex({
    part: "merged",
    seq: store.seq,
    items: [],
    conversations: [],
    noteSources: new Map(),
    hubMembers: new Map(),
    noteLinks: new Map(),
    labels: [],
    epoch: store.epoch,
    count: store.count,
    patches: diff.ordinals.map((ordinal, i) => ({ id: store.idAt(ordinal), ordinal, mask: PATCH_FLAGS, flags: diff.flags[i]! })),
  });
}

const copyOf = (b: ArrayBuffer): ArrayBuffer => b.slice(0);

/** After this many busy answers in a row a held lock is treated as a failed build (a stuck lock must show). */
const MAX_BUSY_RETRIES = 6;

export function createIndexService(deps?: IndexDeps): IndexServiceExt {
  const index = signal<DataIndex | null>(null);
  let main: IndexStore | null = null;
  let epoch = "";
  let loading: Promise<void> | null = null;
  /** The newest build attempt failed (cleared by the next one that works). */
  let buildFailed = false;
  let disposed = false;
  let sampleOn = false;
  const tracked = { excluded: new Set<number>(), pinned: new Set<number>() };
  const stops: (() => void)[] = [];
  let loadedMark = 0;
  let buildTimer: ReturnType<typeof setTimeout> | null = null;
  let building: Promise<void> | null = null;
  /** A build was asked for while one ran: run once more after it (commits that landed mid-build). */
  let buildAgain = false;
  let buildAgainFull = false;
  /** A load skipped its build for the running one: load again from the files that build wrote, once it ends. */
  let reloadAfterBuild = false;
  let lastBuildEnd = 0;
  /** Builds in a row that found the runner's lock held by someone else (reset by one that ran). */
  let busyRetries = 0;
  let overlayTimer: ReturnType<typeof setTimeout> | null = null;

  const need = (): IndexDeps => {
    if (!deps) throw asCortexError(new Error("The index is not connected to the vault"), "E_INTERNAL");
    return deps;
  };
  const worker = (d: IndexDeps, method: "loadIndex" | "appendIndex" | "patchIndex" | "loadSearch" | "addSearchShard" | "loadSample", params: unknown, transfer: Transferable[] = []): Promise<unknown> =>
    (d.worker.call as (viewId: string, m: string, p: unknown, o?: { transfer?: Transferable[] }) => Promise<unknown>)(VIEW, method, params, { transfer });

  /** Raise or clear the index-failed state (stage line, Sources > Needs attention, CORTEX-UX 5.31). */
  function setFailure(d: IndexDeps, failure: "last-good" | "none" | null): void {
    d.shared.update("data", (x) => {
      const next = { ...x };
      if (failure) next.failure = failure;
      else delete next.failure;
      return next;
    });
    d.shared.update("activity", (a) => {
      const next = { ...a };
      if (failure) next.lastWarning = "index-failed";
      else if (next.lastWarning === "index-failed") delete next.lastWarning;
      return next;
    });
  }

  function publish(d: IndexDeps, store: IndexStore, phase: "ready" | "empty"): void {
    const snap = store.snapshot();
    main = store;
    epoch = store.epoch;
    index.value = snap;
    setFailure(d, buildFailed ? "last-good" : null);
    d.shared.update("data", { phase, progress: 1, seq: store.seq, epoch: store.epoch, notes: snap.header.stats.notes, record: snap.header.stats.record, available: snap.count });
  }

  async function runnerBuild(d: IndexDeps, full: boolean): Promise<boolean> {
    const id = `index-${Date.now().toString(36)}`;
    const put = (done: number, total?: number): void => {
      const job = total !== undefined ? { id, kind: "index", phase: "build", done, total } : { id, kind: "index", phase: "build", done };
      d.shared.update("activity", (a) => ({ ...a, jobs: [...a.jobs.filter((j) => j.id !== id), job] }));
    };
    put(0);
    try {
      await d.runner.request({ cmd: "index.build", args: { full } }, { onProgress: (p: Extract<FromRunner, { t: "progress" }>) => put(p.done, p.total) });
      // Search follows the index: the live shard (new entries, notes, your fixes) is rebuilt, closed shards are kept.
      await d.runner.request({ cmd: "search.build", args: full ? { full: true } : {} }).catch((e: unknown) => {
        const code = asCortexError(e).code;
        // A busy lock is another build (a second window, a second computer-side run) finishing the same job: not a fault.
        if (code === "E_LOCKED") d.log.debug("search is being built elsewhere; the next build will follow", { error: code });
        else d.log.warn(`the runner could not build search (${code})`, { error: code });
      });
      buildFailed = false;
      busyRetries = 0;
      if (main) setFailure(d, null);
      return true;
    } catch (e) {
      const code = asCortexError(e).code;
      if (code === "E_LOCKED" && busyRetries < MAX_BUSY_RETRIES) {
        // The runner's index lock is held by another build (another window or process on the same cache). That build
        // writes the same files, so this is not a failed build: keep what is shown, and try again after the gap.
        busyRetries++;
        d.log.debug("the index is being built elsewhere; trying again later", { error: code, retry: busyRetries });
        if (!disposed) scheduleBuild(d);
        return false;
      }
      d.log.warn(`the runner could not build the index (${code})`, { error: code });
      buildFailed = true;
      if (main) setFailure(d, "last-good");
      return false;
    } finally {
      d.shared.update("activity", (a) => ({ ...a, jobs: a.jobs.filter((j) => j.id !== id) }));
    }
  }

  async function loadSearch(d: IndexDeps): Promise<void> {
    const shards = await d.io.readSearchShards();
    if (shards.length === 0) return;
    const copies = shards.map(copyOf);
    await worker(d, "loadSearch", { shards: copies }, copies);
  }

  async function doLoad(force: boolean, noBuild = false): Promise<void> {
    const d = need();
    d.shared.update("data", { phase: "loading", progress: 0 });
    let recordBuf = await d.io.readRecord();
    let header = recordBuf ? safeHeader(recordBuf) : null;
    if (!noBuild && (!header || force || (await d.io.isStale(header.seq)))) {
      if (building) {
        // A build is already running (perhaps the one that asked for this load): never wait for it here (that
        // build may be waiting for this load). Build again after it, and load what it wrote once it ends, since
        // a watcher may be off or may have taken that build's signal as its starting point.
        buildAgain = true;
        if (!header || force) reloadAfterBuild = true;
      } else {
        let ok = false;
        await track(
          d,
          runnerBuild(d, false).then((r) => {
            ok = r;
          }),
        );
        if (ok) {
          recordBuf = await d.io.readRecord();
          header = recordBuf ? safeHeader(recordBuf) : null;
        }
      }
    }
    d.shared.update("data", { progress: 0.3 });
    if (!recordBuf || !header) {
      sampleOn = false;
        const empty = new IndexStore({ part: "merged" });
      await worker(d, "loadIndex", { record: copyOf(emptyRecord(empty)), vault: null, corrections: null }, []).catch(() => undefined);
      publish(d, empty, "empty");
      if (buildFailed) setFailure(d, "none");
      d.bus.emit("index:loaded", { count: 0, seq: 0, epoch: "" });
      return;
    }
    const parts: IndexPart[] = [decodePart(recordBuf)];
    loadedMark = (await d.io.marks())["record-index"] ?? 0;
    const vaultBuf = await d.io.vaultPart(header.epoch).catch((e: unknown) => {
      d.log.warn("vault notes could not be indexed", { error: asCortexError(e).code });
      return null;
    });
    d.shared.update("data", { progress: 0.6 });
    const base = IndexStore.fromParts([...parts, ...(vaultBuf ? [decodePart(vaultBuf)] : [])], { part: "merged" });
    const next = IndexStore.fromParts([...parts, ...(vaultBuf ? [decodePart(vaultBuf)] : [])], { part: "merged" });
    const deltaBuf = await d.io.readDelta();
    if (deltaBuf) {
      try {
        const dh = readIndexHeader(deltaBuf);
        if (dh.epoch === header.epoch) next.applyPart(decodePart(deltaBuf));
      } catch {
        d.log.warn("the index delta file could not be read");
      }
    }
    if (d.corrections) {
      await d.corrections.load().catch(() => undefined);
      const ov = overlayFlags(next, d.corrections.effective(), tracked);
      if (ov.ordinals.length > 0) next.applyFlags(ov.ordinals, ov.flags);
    }
    // What the worker gets on top of record + vault: the appended rows and the patches (one part).
    const diff = base.diff(next);
    let correctionsBuf: ArrayBuffer | null = null;
    let recordForWorker = recordBuf;
    if (diff.structural) {
      recordForWorker = next.encodeRows({ rows: allRows(next), part: "record" });
    } else if (diff.appeared.length + diff.patches.length > 0 || diff.tables) {
      correctionsBuf = next.encodeRows({ rows: diff.appeared, patches: diff.patches });
    }
    const send = [copyOf(recordForWorker)];
    const vaultCopy = diff.structural ? null : vaultBuf ? copyOf(vaultBuf) : null;
    const corrCopy = correctionsBuf ? copyOf(correctionsBuf) : null;
    const transfer: Transferable[] = [...send, ...(vaultCopy ? [vaultCopy] : []), ...(corrCopy ? [corrCopy] : [])];
    await worker(d, "loadIndex", { record: send[0], vault: vaultCopy, corrections: corrCopy }, transfer);
    d.shared.update("data", { progress: 0.85 });
    await loadSearch(d).catch((e: unknown) => d.log.warn("search shards could not be loaded", { error: asCortexError(e).code }));
    sampleOn = false;
    publish(d, next, next.snapshot().count > 0 ? "ready" : "empty");
    d.bus.emit("index:loaded", { count: next.count, seq: next.seq, epoch: next.epoch });
  }

  function emptyRecord(store: IndexStore): ArrayBuffer {
    return store.encodeRows({ rows: [], part: "record" });
  }

  function allRows(store: IndexStore): number[] {
    const out: number[] = [];
    for (let o = 0; o < store.count; o++) if (store.isPresent(o)) out.push(o);
    return out;
  }

  function safeHeader(buf: ArrayBuffer): ReturnType<typeof readIndexHeader> | null {
    try {
      return readIndexHeader(buf);
    } catch {
      deps?.log.warn("record.cxi could not be read; it will be rebuilt");
      return null;
    }
  }

  /** `noBuild` (internal): read what is on disk without asking the runner, used right after a build ended. */
  function load(opts: { force?: boolean; noBuild?: boolean } = {}): Promise<void> {
    const d = need();
    if (loading && !opts.force) return loading;
    const run = doLoad(opts.force === true, opts.noBuild === true)
      .catch((e: unknown) => {
        const err = asCortexError(e);
        d.shared.update("data", { phase: "error", messageKey: "data.error" });
        setFailure(d, main ? "last-good" : "none");
        d.log.warn("the index could not be loaded", { error: err.code });
        d.bus.emit("error", { scope: "index", code: err.code });
        throw err;
      })
      .finally(() => {
        if (loading === run) loading = null;
      });
    loading = run;
    if (d.watch !== false && stops.length === 0 && !disposed) startWatching(d);
    return run;
  }

  // ───────────── live updates ─────────────

  async function applyDelta(d: IndexDeps): Promise<void> {
    if (!main || sampleOn) return;
    const buf = await d.io.readDelta();
    if (!buf) return;
    let part: IndexPart;
    try {
      part = decodePart(buf);
    } catch {
      return;
    }
    if (part.header.epoch !== main.epoch) {
      await load({ force: false }).catch(() => undefined);
      return;
    }
    const before = main.count;
    const r = main.applyPart(part);
    if (r.appeared === 0 && r.patched === 0) return;
    index.value = main.snapshot();
    const fromCount = Math.min(r.from, before);
    try {
      const copy = copyOf(buf);
      await worker(d, "appendIndex", { epoch: main.epoch, fromCount, delta: copy }, [copy]);
    } catch (e) {
      d.log.warn("the worker could not take the index delta; reloading", { error: asCortexError(e).code });
      await load({ force: false }).catch(() => undefined);
      return;
    }
    const snap = main.snapshot();
    d.shared.update("data", { seq: main.seq, notes: snap.header.stats.notes, record: snap.header.stats.record, available: snap.count });
    d.bus.emit("index:delta", { added: r.appeared, seq: main.seq, epoch: main.epoch });
    if (r.appeared > 0) d.bus.emit("arrivals", { added: r.appeared, available: snap.count });
  }

  async function applyOverlay(d: IndexDeps): Promise<void> {
    if (!main || sampleOn || !d.corrections) return;
    const ov = overlayFlags(main, d.corrections.effective(), tracked);
    if (ov.ordinals.length === 0) return;
    main.applyFlags(ov.ordinals, ov.flags);
    index.value = main.snapshot();
    const ordinals = Uint32Array.from(ov.ordinals);
    const flags = Uint32Array.from(ov.flags);
    await worker(d, "patchIndex", { epoch: main.epoch, ordinals, flags }, [ordinals.buffer, flags.buffer]);
    d.bus.emit("index:patched", { ordinals: ov.ordinals.length, epoch: main.epoch });
  }

  async function syncVault(d: IndexDeps): Promise<void> {
    if (!main || sampleOn) return;
    const part = await d.io.rebuildVault();
    if (!part) return;
    if (readIndexHeader(part).epoch !== main.epoch) {
      await load({ force: true });
      return;
    }
    const next = IndexStore.fromParts([main.encodeRows({ rows: allRows(main) }) as ArrayBuffer].map(decodePart), { part: "merged", epoch: main.epoch });
    const decoded = decodePart(part);
    next.applyPart(decoded);
    // A wiki note that vanished keeps its ordinal, flagged Excluded, until the next epoch.
    const still = new Set<string>();
    for (let i = 0; i < decoded.rows; i++) still.add(decoded.ids.get(i));
    const gone: number[] = [];
    const goneFlags: number[] = [];
    for (let o = 0; o < next.count; o++) {
      if (!next.isPresent(o) || still.has(next.idAt(o)) || !next.idAt(o).startsWith("w_")) continue;
      const f = next.flagsAt(o);
      if ((f & ItemFlag.Excluded) === 0) {
        gone.push(o);
        goneFlags.push((f | ItemFlag.Excluded) >>> 0);
      }
    }
    if (gone.length > 0) next.applyFlags(gone, goneFlags);
    const diff = main.diff(next);
    if (diff.structural) {
      await load({ force: true });
      return;
    }
    if (diff.appeared.length + diff.patches.length === 0 && !diff.tables) return;
    const delta = next.encodeRows({ rows: diff.appeared, patches: diff.patches });
    const copy = copyOf(delta);
    await worker(d, "appendIndex", { epoch: next.epoch, fromCount: Math.min(diff.from, main.count), delta: copy }, [copy]);
    main.applyPart(decodePart(delta));
    index.value = main.snapshot();
    const snap = main.snapshot();
    d.shared.update("data", { notes: snap.header.stats.notes, record: snap.header.stats.record, available: snap.count });
    d.bus.emit("index:delta", { added: diff.appeared.length, seq: main.seq, epoch: main.epoch });
    if (diff.appeared.length > 0) d.bus.emit("arrivals", { added: diff.appeared.length, available: snap.count });
  }

  function scheduleBuild(d: IndexDeps): void {
    if (sampleOn || disposed) return;
    if (building) {
      buildAgain = true;
      return;
    }
    if (buildTimer !== null) return;
    // Debounced, and spaced: a long agent run commits every few seconds and each build rescans the ledgers.
    const wait = Math.max(d.buildDebounceMs ?? 4000, lastBuildEnd + (d.buildGapMs ?? MIN_BUILD_GAP_MS) - Date.now());
    buildTimer = setTimeout(() => {
      buildTimer = null;
      void requestBuild().catch(() => undefined);
    }, wait);
    (buildTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Every runner build goes through here, so only one runs at a time (a second hits the runner's import lock and
   * fails). A build asked for meanwhile runs once after it: a full one at once, a background one after the gap.
   */
  function track(d: IndexDeps, run: Promise<void>): Promise<void> {
    building = run.finally(() => {
      building = null;
      lastBuildEnd = Date.now();
      const full = buildAgainFull;
      const again = buildAgain || full;
      const reload = reloadAfterBuild;
      buildAgain = false;
      buildAgainFull = false;
      reloadAfterBuild = false;
      if (disposed) return;
      // After any load still in flight (it read the files before this build ended), never alongside it.
      if (reload) void (loading ?? Promise.resolve()).catch(() => undefined).then(() => load({ noBuild: true })).catch(() => undefined);
      if (!again) return;
      if (full) void requestBuild({ full: true }).catch(() => undefined);
      else scheduleBuild(d);
    });
    return building;
  }

  function requestBuild(opts: { full?: boolean } = {}): Promise<void> {
    const d = need();
    if (building) {
      if (opts.full) buildAgainFull = true;
      else buildAgain = true;
      return building;
    }
    return track(
      d,
      (async () => {
        const ok = await runnerBuild(d, opts.full === true);
        if (ok && opts.full) await load({ force: false });
      })(),
    );
  }

  function startWatching(d: IndexDeps): void {
    let busy: Promise<void> = Promise.resolve();
    const queue = (fn: () => Promise<void>): void => {
      busy = busy.then(fn).catch((e: unknown) => d.log.warn("index update failed", { error: asCortexError(e).code }));
    };
    stops.push(
      d.io.watchCache(
      (sig, changed) => {
        if (disposed || sampleOn) return;
        if (changed.includes("record-index") && (sig.epoch !== main?.epoch || (sig.marks["record-index"] ?? 0) > loadedMark)) queue(() => load({ force: false }));
        else if (changed.includes("record-delta")) queue(() => applyDelta(d));
        if (changed.includes("search-index")) queue(() => loadSearch(d));
        if (changed.includes("corrections") && d.corrections) queue(async () => void (await d.corrections?.refresh()));
        if (changed.some((k) => k === "entries" || k === "staged" || k === "labels" || k === "notes" || k === "corrections")) scheduleBuild(d);
      },
      (e) => d.log.warn("the cache signal could not be read", { error: asCortexError(e).code }),
      ),
    );
    if (d.corrections) {
      let first = true;
      const stop = effect(() => {
        void d.corrections?.version.value;
        if (first) {
          first = false;
          return;
        }
        if (overlayTimer !== null) clearTimeout(overlayTimer);
        overlayTimer = setTimeout(() => {
          overlayTimer = null;
          queue(() => applyOverlay(d));
        }, 50);
      });
      stops.push(stop);
    }
    stops.push(d.io.watchVault(() => queue(() => syncVault(d))));
  }

  async function showSample(on: boolean, seed = 7): Promise<void> {
    const d = need();
    if (on) {
      const store = buildSampleIndexStore(seed);
      await worker(d, "loadSample", { seed });
      sampleOn = true;
      publish(d, store, "ready");
      d.bus.emit("index:loaded", { count: store.count, seq: 0, epoch: store.epoch });
      return;
    }
    if (!sampleOn) return;
    sampleOn = false;
    await load({ force: false });
  }

  /** The same index the worker builds for `loadSample` (shared generator), for tooltips and readers. */
  function buildSampleIndexStore(seed: number): IndexStore {
    return IndexStore.fromParts([decodePart(encodeIndex(sampleIndexInput(seed, Date.now())))], { part: "merged" });
  }

  return {
    get index(): ReadonlySignal<DataIndex | null> {
      return index;
    },
    get epoch(): string {
      return epoch;
    },
    load,
    requestBuild,
    showSample,
    meta: (ordinal) => {
      const snap = index.peek();
      return snap ? itemMeta(snap, ordinal) : undefined;
    },
    ordinalOf: (id) => main?.ordinalOf(id) ?? -1,
    dispose() {
      disposed = true;
      if (buildTimer !== null) clearTimeout(buildTimer);
      if (overlayTimer !== null) clearTimeout(overlayTimer);
      buildTimer = null;
      overlayTimer = null;
      for (const stop of stops.splice(0)) {
        try {
          stop();
        } catch {
          // keep releasing the rest
        }
      }
    },
  };
}
