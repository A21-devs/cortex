/**
 * Importer framework. Owner: E3.
 *
 * An importer turns one source into immutable record segments + EntryRecords + ConversationRecords.
 * Contract for every importer:
 *  1. idempotent: re-running over the same input adds nothing (stable ids + dedupe against the ledger);
 *  2. incremental: append-only sources keep cursors; export files are keyed by sha256 in the manifest;
 *  3. streaming: never hold a whole multi-GB source in memory; yield via ctx.yield() between units;
 *  4. text-only by default: user and assistant text; tool output, thinking, subagents are settings;
 *  5. originals untouched: segments are written once (exclusive create); nothing in the source is modified;
 *  6. privacy: honours the settings exclusions (claudeCode.excludeProjects, vault/raw excludeFolders), the Off
 *     limits rows and the never-read list, AND exclude corrections of scope conversation or wider, before
 *     reading anything (M2) — see `importPrivacy()`;
 *  7. kill switches: re-read control.json before every unit (SAFE-03) and stop when paused (`checkpoint()`);
 *  8. secrets (SAFE-10): high-confidence secrets in text bound for the vault are replaced by
 *     "[secret kept on this computer]" and the originals are stored under <cache>/held/ (never synced);
 *  9. crash safety (SEGMENT-SEQ-DEADLOCK): before writing a conversation, adopt orphan segments (segments whose
 *     line ids are all missing from the ledger) by appending their EntryRecords; segment numbers come from the
 *     conversation folder, never from the cursor;
 * 10. live sessions: complete messages are staged locally (store/stage.ts) and sealed later; the open trailing
 *     assistant message is held back;
 * 11. bounded passes: honour maxSeconds (CLI default 90 s) and report `partial` so the caller runs again.
 *
 * Everything the framework keeps per pass (conversation records, the ledger id index, privacy rules, staged
 * messages) lives in a WeakMap keyed by the ImportContext, so contexts built by hand in tests keep working.
 *
 * Held secrets (`<cache>/held/<entryId>.json`, read by RecordReader.revealHeld): {v:1, entry, at, markers:
 * [{n, at, text, line, kind}]} where `n` is the 0-based number of the marker in the stored text, `at` its
 * character offset in the STORED text, `text` the exact original span the marker replaced, `line` the original
 * text line that contained it, and `kind` the detector id. The file is written before the text is published.
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import type { CancelToken } from "../shared/cancel";
import { CortexError } from "../shared/errors";
import { conversationId, entryId as makeEntryId, isEntryId } from "../shared/ids";
import { latestById } from "../shared/jsonl";
import type { Logger } from "../shared/log";
import type { SourceImportStats, SourceSelector, WarningCode } from "../shared/protocol/runner";
import { scanSecrets } from "../shared/secrets";
import type { CortexSettings } from "../shared/settings";
import { wordCount } from "../shared/text";
import { shardMonth } from "../shared/time";
import type {
  AttachmentRef,
  BranchVersion,
  ConversationId,
  ConversationPart,
  ConversationRecord,
  CorrectionRecord,
  DateEvidence,
  EntryId,
  EntryKind,
  EntryRecord,
  IsoDate,
  SegmentLine,
  SourceKind,
  SourceRef,
  SpaceId,
  Speaker,
  TextRef,
  VaultPath,
} from "../shared/types";
import { errCode, readJsonIfExists, withFsRetry, writeJsonAtomic } from "../node/fsAtomic";
import { sha256Bytes, sha256Text } from "../node/hash";
import { readAhead, type Ahead } from "../node/pool";
import { cacheWritablePath, resolveInVault } from "../node/paths";
import type { LedgerStore } from "../store/ledger";
import { cacheLayout, segmentDir, type StoreContext } from "../store/layout";
import { readSegment, writeSegment } from "../store/segments";
import { dueForSeal, listStaged, readStage, sealStage, stageMessages, type StagedConversation, type StagedMessage } from "../store/stage";

export interface ImportProgress {
  phase: string;
  done: number;
  total?: number;
  unit?: string;
  note?: string;
}

export interface ImportContext {
  store: StoreContext;
  ledger: LedgerStore;
  settings: CortexSettings;
  /** Re-read control.json; false = stop now (paused or privacy changed since the pass started). */
  mayContinue(): Promise<boolean>;
  /** Deadline (epoch ms) from maxSeconds; importers stop cleanly after the current unit. */
  deadline?: number;
  token: CancelToken;
  log: Logger;
  progress(p: ImportProgress): void;
  /** Cooperative yield (no-op in the child process; real yield when running inline in Obsidian). */
  yield(): Promise<void>;
  now(): number;
  /** Entry ids already in the ledger for a conversation (dedupe after a lost cursor). */
  knownEntryIds(conv: ConversationId): Promise<ReadonlySet<EntryId>>;
  /** Stop after this many new entries (tests, sample runs). */
  maxEntries?: number;
  dryRun?: boolean;
  /** Counters behind ImportResult.staged / secretsHeld / partial and the pass's warnings (E3 addition). */
  tally?: ImportTally;
  /** Live-session stage; defaults to store/stage.ts (E3 addition, injectable for tests). */
  stage?: StageAdapter;
  /** Raw selectors may carry extra options through this map (see RawSelectorOptions in rawDocs.ts). */
  options?: Readonly<Record<string, unknown>>;
}

export interface DiscoveredUnit {
  key: string;
  path: string;
  bytes: number;
  mtimeMs: number;
  label?: string;
}

export interface Importer<S extends SourceSelector = SourceSelector> {
  readonly kind: S["kind"];
  readonly source: SourceKind;
  readonly label: string;
  discover(sel: S, ctx: ImportContext): Promise<DiscoveredUnit[]>;
  run(sel: S, ctx: ImportContext): Promise<SourceImportStats>;
}

export function emptyStats(source: SourceKind, label: string): SourceImportStats {
  return { source, label, filesSeen: 0, filesRead: 0, entriesAdded: 0, conversationsTouched: 0, skipped: 0, bytesRead: 0, errors: [] };
}

// ───────────────────────────── tally, warnings, stop conditions ─────────────────────────────

export interface ImportTally {
  staged: number;
  secretsHeld: number;
  /** A bound (maxSeconds, maxEntries) or a kill switch stopped the pass early: run again to continue. */
  partial: boolean;
  /** Warning code → count, emitted as runner `warning` events at the end of the pass. */
  warnings: Map<WarningCode | "import-failed", number>;
  /** Vault paths (or absolute paths) that could not be read because OneDrive has not downloaded them. */
  notLocal: Set<string>;
  /** New entries written or staged in this pass (for maxEntries). */
  added: number;
  /** Conversations that received new entries (for conversationsTouched across importers). */
  conversations: Set<string>;
  /** Words added per source id (Sources › your words; see sourceIdOf). */
  words: Map<string, { words: number; yourWords: number; entries: number }>;
}

export function newTally(): ImportTally {
  return { staged: 0, secretsHeld: 0, partial: false, warnings: new Map(), notLocal: new Set(), added: 0, conversations: new Set(), words: new Map() };
}

function tallyOf(ctx: ImportContext): ImportTally {
  ctx.tally ??= newTally();
  return ctx.tally;
}

/** Count a warning from the fixed catalogue (SAFE-17: codes and counts only, never text). */
export function warn(ctx: ImportContext, code: WarningCode | "import-failed", n = 1): void {
  const t = tallyOf(ctx);
  t.warnings.set(code, (t.warnings.get(code) ?? 0) + n);
}

/** Record an unreadable OneDrive placeholder (Sources › Needs attention › Fetch now). */
export function noteNotLocal(ctx: ImportContext, p: string): void {
  tallyOf(ctx).notLocal.add(p);
  warn(ctx, "not-local");
}

/** Errors that mean "the file is a cloud placeholder that is not on this computer" rather than "missing". */
export function isNotLocalError(e: unknown): boolean {
  const c = errCode(e);
  return c !== undefined && !["ENOENT", "ENOTDIR", "EISDIR", "EACCES", "EPERM", "EMFILE", "ENFILE"].includes(c);
}

export type StopReason = "deadline" | "paused" | "max-entries";

/**
 * Between units: cancellation throws E_CANCELLED (nothing half-written: cursors only move after a flush);
 * a deadline, the entry limit or a kill switch returns a reason and marks the pass partial.
 */
export async function checkpoint(ctx: ImportContext): Promise<StopReason | null> {
  ctx.token.throwIfCancelled();
  await ctx.yield();
  const t = tallyOf(ctx);
  if (ctx.maxEntries !== undefined && t.added >= ctx.maxEntries) {
    t.partial = true;
    return "max-entries";
  }
  if (ctx.deadline !== undefined && ctx.now() >= ctx.deadline) {
    t.partial = true;
    return "deadline";
  }
  if (!(await ctx.mayContinue())) {
    t.partial = true;
    return "paused";
  }
  return null;
}

/** Cheap check inside a unit (no file reads): cancellation and the deadline only. */
export function overDeadline(ctx: ImportContext): boolean {
  ctx.token.throwIfCancelled();
  return ctx.deadline !== undefined && ctx.now() >= ctx.deadline;
}

// ───────────────────────────── stage adapter ─────────────────────────────

/** The live-session stage (store/stage.ts by default). */
export interface StageAdapter {
  stage(store: StoreContext, conv: ConversationId, items: readonly StagedMessage[]): Promise<number>;
  read(store: StoreContext, conv: ConversationId): Promise<StagedMessage[]>;
  list(store: StoreContext): Promise<StagedConversation[]>;
  seal(store: StoreContext, conv: ConversationId): Promise<{ entries: number; segment?: string }>;
}

export const STORE_STAGE: StageAdapter = {
  stage: stageMessages,
  read: readStage,
  list: listStaged,
  seal: sealStage,
};

function stageOf(ctx: ImportContext): StageAdapter {
  return ctx.stage ?? STORE_STAGE;
}

export { dueForSeal };

// ───────────────────────────── privacy (M2, SAFE-02) ─────────────────────────────

/** Never read, whatever the settings say (CORTEX-UX §5.22 Off limits, SPEC §7.9). */
export const NEVER_READ: readonly RegExp[] = [
  /(^|[\\/])\.env(\.[^\\/]*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])(node_modules|\.git|\.obsidian|\.claude|Excalidraw)([\\/]|$)/i,
  /(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /(^|[\\/])(credentials|secrets?)\.(json|ya?ml|toml|ini|txt)$/i,
  // Browser profiles, mail and password stores.
  /[\\/]AppData[\\/](Local|Roaming)[\\/](Google[\\/]Chrome|Microsoft[\\/]Edge|Mozilla[\\/]Firefox|BraveSoftware|Opera Software|Vivaldi)([\\/]|$)/i,
  /[\\/]AppData[\\/](Local|Roaming)[\\/](Thunderbird|Microsoft[\\/]Outlook|Packages[\\/]microsoft\.windowscommunicationsapps)([\\/]|$)/i,
  /[\\/]AppData[\\/](Local|Roaming)[\\/](1Password|Bitwarden|KeePass|KeePassXC|Dashlane|LastPass)([\\/]|$)/i,
];

export function isNeverRead(p: string): boolean {
  return NEVER_READ.some((re) => re.test(p));
}

/** Normalise a path for prefix comparisons: forward slashes, no trailing slash, lower case on Windows. */
export function normPathKey(p: string): string {
  const s = p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

function underPrefix(p: string, prefix: string): boolean {
  const a = normPathKey(p);
  const b = normPathKey(prefix);
  return b.length > 0 && (a === b || a.startsWith(`${b}/`));
}

export interface ExclusionQuery {
  source?: SourceKind;
  /** Source id (see sourceIdOf): "claude-code", "vault", "raw", "folder:<id>", … */
  sourceId?: string;
  conv?: ConversationId;
  /** Claude Code project slug or a project name. */
  project?: string;
  /** Vault path (vault sources) or absolute path (folders) of the unit. */
  path?: string;
}

export interface ImportPrivacy {
  /** SAFE-10: replace detected secrets in vault copies and keep the originals in <cache>/held/. */
  readonly keepSecretsLocal: boolean;
  /** Left out by an exclude correction (scope conversation, source, folder or project) or a settings list. */
  isExcluded(q: ExclusionQuery): boolean;
  /**
   * Off limits: the fixed never-read list plus the user's rows (paths; app names never match a path).
   * `userRowsOnly` skips the fixed list (Claude Code transcripts live under ~/.claude, which the fixed list
   * names for every other source).
   */
  isOffLimits(p: string, opts?: { userRowsOnly?: boolean }): boolean;
}

interface FoldedExclusions {
  conversations: Set<string>;
  sources: Set<string>;
  folders: string[];
  projects: Set<string>;
}

/** Fold exclude/include corrections the way the index builder does (undo cancels; an undo of an undo restores). */
export function foldExclusions(records: readonly CorrectionRecord[]): FoldedExclusions {
  const undone = new Set<string>();
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i] as CorrectionRecord;
    if (undone.has(r.id)) continue;
    if (r.undoes) undone.add(r.undoes);
  }
  const active = new Map<string, CorrectionRecord<"exclude">>();
  for (const r of records) {
    if (undone.has(r.id) || r.undoes) continue;
    if (r.action === "exclude") active.set(r.id, r as CorrectionRecord<"exclude">);
    else if (r.action === "include") active.delete((r as CorrectionRecord<"include">).payload.excludeCorrectionId);
  }
  const out: FoldedExclusions = { conversations: new Set(), sources: new Set(), folders: [], projects: new Set() };
  for (const r of active.values()) {
    const p = r.payload;
    switch (p?.scope) {
      case "conversation":
        out.conversations.add(r.target);
        break;
      case "source":
        out.sources.add(p.sourceKind ?? r.target);
        break;
      case "folder":
        out.folders.push(p.folder ?? r.target);
        break;
      case "project":
        out.projects.add((p.project ?? r.target).toLowerCase());
        break;
      default:
        break; // entry scope is applied at index time
    }
  }
  return out;
}

export function buildImportPrivacy(settings: CortexSettings, corrections: readonly CorrectionRecord[]): ImportPrivacy {
  const folded = foldExclusions(corrections);
  const settingsFolders = [...settings.sources.vault.excludeFolders, ...settings.sources.raw.excludeFolders];
  const projects = new Set([...folded.projects, ...settings.sources.claudeCode.excludeProjects.map((s) => s.toLowerCase())]);
  const offLimits = settings.privacy.offLimits.map((r) => r.path).filter((p) => p.trim().length > 0 && /[\\/]/.test(p));
  return {
    keepSecretsLocal: settings.privacy.keepSecretsLocal,
    isExcluded(q) {
      if (q.conv !== undefined && folded.conversations.has(q.conv)) return true;
      if (q.source !== undefined && folded.sources.has(q.source)) return true;
      if (q.sourceId !== undefined && folded.sources.has(q.sourceId)) return true;
      if (q.project !== undefined && projects.has(q.project.toLowerCase())) return true;
      if (q.path !== undefined) {
        for (const f of folded.folders) if (underPrefix(q.path, f)) return true;
        for (const f of settingsFolders) if (underPrefix(q.path, f)) return true;
      }
      return false;
    },
    isOffLimits(p, opts) {
      if (!opts?.userRowsOnly && isNeverRead(p)) return true;
      return offLimits.some((row) => underPrefix(p, row));
    },
  };
}

/** Privacy rules for this pass (corrections read once). */
export async function importPrivacy(ctx: ImportContext): Promise<ImportPrivacy> {
  const c = cacheOf(ctx);
  c.privacy ??= ctx.ledger.readCorrections().then((records) => buildImportPrivacy(ctx.settings, records));
  return c.privacy;
}

// ───────────────────────────── held secrets (SAFE-10) ─────────────────────────────

export const SECRET_MARKER = "[secret kept on this computer]";

export interface HeldMarker {
  /** 0-based number of the marker among the markers Cortex inserted in this entry's stored text. */
  n: number;
  /** Character offset of the marker in the STORED text. */
  at: number;
  /** The exact original span the marker replaced. */
  text: string;
  /** The original text line that contained the span. */
  line: string;
  /** Detector id (shared/secrets.ts), e.g. "anthropic". */
  kind: string;
}

export interface HeldSecretsFile {
  v: 1;
  entry: EntryId;
  at: IsoDate;
  markers: HeldMarker[];
}

/** Replace high-confidence secrets with the marker (pure). With `enabled` false the text is returned untouched. */
export function protectSecrets(text: string, enabled: boolean): { text: string; markers: HeldMarker[] } {
  if (!enabled || text.length === 0) return { text, markers: [] };
  const scan = scanSecrets(text, { highConfidenceOnly: true, replacement: SECRET_MARKER });
  if (scan.count === 0) return { text, markers: [] };
  const markers: HeldMarker[] = [];
  let delta = 0;
  scan.spans.forEach((s, n) => {
    const lineStart = text.lastIndexOf("\n", s.start - 1) + 1;
    const nl = text.indexOf("\n", s.end);
    const lineEnd = nl < 0 ? text.length : nl;
    markers.push({ n, at: s.start + delta, text: text.slice(s.start, s.end), line: text.slice(lineStart, lineEnd).replace(/\r$/, ""), kind: s.id });
    delta += SECRET_MARKER.length - (s.end - s.start);
  });
  return { text: scan.text, markers };
}

/** `<cache>/held/<entryId>.json` (absolute). */
export function heldFilePath(cacheDir: string, id: EntryId): string {
  return path.join(cacheLayout(cacheDir).held, `${id}.json`);
}

async function writeHeld(ctx: ImportContext, id: EntryId, markers: readonly HeldMarker[]): Promise<void> {
  if (markers.length === 0 || ctx.dryRun) return;
  const file: HeldSecretsFile = { v: 1, entry: id, at: new Date(ctx.now()).toISOString(), markers: [...markers] };
  await writeJsonAtomic(cacheWritablePath(ctx.store.cacheDir, `held/${id}.json`), file);
}

/** The original span behind marker `n` of an entry, or null when it is not kept on this computer. */
export async function readHeldSecret(cacheDir: string, id: string, n: number): Promise<string | null> {
  if (!isEntryId(id)) return null;
  try {
    const f = await readJsonIfExists<HeldSecretsFile>(heldFilePath(cacheDir, id));
    if (!f || f.v !== 1 || !Array.isArray(f.markers)) return null;
    const m = f.markers.find((x) => x.n === n);
    return m && typeof m.text === "string" ? m.text : null;
  } catch {
    return null;
  }
}

// ───────────────────────────── entry records ─────────────────────────────

export interface NewEntryArgs {
  id: EntryId;
  kind: EntryKind;
  source: SourceKind;
  sourceRef: SourceRef;
  text: string;
  textSha256: string;
  textRef: TextRef;
  speaker: Speaker;
  speakerDetail?: string;
  conv?: ConversationId;
  idx?: number;
  part?: number;
  title?: string;
  writtenAt?: IsoDate;
  dates: DateEvidence[];
  addedAt: IsoDate;
  space: SpaceId;
  folder: string[];
  project?: string;
  hiddenByDefault?: EntryRecord["hiddenByDefault"];
  attachments?: AttachmentRef[];
  branches?: BranchVersion[];
  supersedes?: EntryId;
  passage?: EntryRecord["passage"];
  licence?: string;
}

/** Build an EntryRecord with derived fields (chars, words, existedBy). */
export function makeEntryRecord(a: NewEntryArgs): EntryRecord {
  const rec: EntryRecord = {
    v: 1,
    id: a.id,
    kind: a.kind,
    source: a.source,
    sourceRef: a.sourceRef,
    speaker: a.speaker,
    text: a.textRef,
    textSha256: a.textSha256,
    chars: a.text.length,
    words: wordCount(a.text),
    dates: a.dates,
    existedBy: existedByOf(a.dates, a.addedAt),
    addedAt: a.addedAt,
    space: a.space,
    folder: a.folder,
  };
  if (a.conv !== undefined) rec.conv = a.conv;
  if (a.idx !== undefined) rec.idx = a.idx;
  if (a.part !== undefined) rec.part = a.part;
  if (a.speakerDetail !== undefined) rec.speakerDetail = a.speakerDetail;
  if (a.title !== undefined) rec.title = a.title;
  if (a.writtenAt !== undefined) rec.writtenAt = a.writtenAt;
  if (a.project !== undefined) rec.project = a.project;
  if (a.hiddenByDefault !== undefined) rec.hiddenByDefault = a.hiddenByDefault;
  if (a.attachments !== undefined && a.attachments.length > 0) rec.attachments = a.attachments;
  if (a.branches !== undefined && a.branches.length > 0) rec.branches = a.branches;
  if (a.supersedes !== undefined) rec.supersedes = a.supersedes;
  if (a.passage !== undefined) rec.passage = a.passage;
  if (a.licence !== undefined) rec.licence = a.licence;
  return rec;
}

/** Latest-possible bound: the earliest of the ingest time and every bound-type evidence (seal, git first-seen). */
function existedByOf(dates: readonly DateEvidence[], addedAt: IsoDate): IsoDate {
  let best = Date.parse(addedAt);
  for (const d of dates) {
    if (d.type !== "ingest" && d.type !== "seal" && d.type !== "git-first-seen") continue;
    const t = Date.parse(d.at);
    if (Number.isFinite(t) && t < best) best = t;
  }
  return Number.isFinite(best) ? new Date(best).toISOString() : addedAt;
}

/** Date evidence for a message: its source timestamp (strong) and the ingest bound. */
export function messageDates(ts: IsoDate | undefined, addedAt: IsoDate, evidence: DateEvidence["type"] = "source-timestamp"): DateEvidence[] {
  const out: DateEvidence[] = [];
  if (ts !== undefined && Number.isFinite(Date.parse(ts))) out.push({ type: evidence, strength: evidence === "conversation-start" ? "medium" : "strong", at: ts });
  out.push({ type: "ingest", strength: "bound", at: addedAt });
  return out;
}

/** Which Sources row an entry belongs to (Sources page, agg counts, "Remove source…"). */
export function sourceIdOf(e: Pick<EntryRecord, "source" | "sourceRef">): string {
  switch (e.source) {
    case "obsidian":
      return "vault";
    case "files": {
      const nid = e.sourceRef.nativeId;
      if (nid !== undefined && nid.startsWith("folder:")) return `folder:${nid.slice(7, nid.indexOf(":", 7) > 0 ? nid.indexOf(":", 7) : undefined)}`;
      return "raw";
    }
    default:
      return e.source;
  }
}

function tallyWords(ctx: ImportContext, recs: readonly EntryRecord[]): void {
  const t = tallyOf(ctx);
  for (const r of recs) {
    const id = sourceIdOf(r);
    const w = t.words.get(id) ?? { words: 0, yourWords: 0, entries: 0 };
    w.words += r.words;
    if (r.speaker === "you" && r.hiddenByDefault !== "reference") w.yourWords += r.words;
    w.entries += 1;
    t.words.set(id, w);
  }
}

// ───────────────────────────── per-pass caches ─────────────────────────────

export interface KnownConversation {
  ids: Set<EntryId>;
  maxIdx: number;
}

export interface KnownDocument {
  id: EntryId;
  source: SourceKind;
  kind: EntryKind;
  path: string;
  nativeId?: string;
  sha256: string;
  addedAt: IsoDate;
  supersedes?: EntryId;
}

/** What the entries ledger already holds (built lazily by ONE streaming pass, then kept current). */
export interface LedgerEntryIndex {
  ids: Set<EntryId>;
  conversations: Map<ConversationId, KnownConversation>;
  /** Document entries (kind "document") per `${source}|${sourceRef.path}`, in ledger order. */
  documents: Map<string, KnownDocument[]>;
  /** Words per source id over the whole ledger (rebuilds the Sources aggregate when the cache lost it). */
  words: Map<string, { words: number; yourWords: number; entries: number }>;
}

interface PassCache {
  privacy?: Promise<ImportPrivacy>;
  conversations?: Promise<Map<string, ConversationRecord>>;
  ledgerIndex?: Promise<LedgerEntryIndex>;
  /** When each document state file was last written this pass (see saveDocStateSoon). */
  docStateSavedAt?: Map<string, number>;
}

const passCaches = new WeakMap<ImportContext, PassCache>();

function cacheOf(ctx: ImportContext): PassCache {
  let c = passCaches.get(ctx);
  if (!c) {
    c = {};
    passCaches.set(ctx, c);
  }
  return c;
}

export function documentKey(source: SourceKind, p: string): string {
  return `${source}|${p}`;
}

function indexRecord(ix: LedgerEntryIndex, e: EntryRecord): void {
  ix.ids.add(e.id);
  if (e.conv !== undefined) {
    let k = ix.conversations.get(e.conv);
    if (!k) {
      k = { ids: new Set(), maxIdx: -1 };
      ix.conversations.set(e.conv, k);
    }
    k.ids.add(e.id);
    if (typeof e.idx === "number" && e.idx > k.maxIdx) k.maxIdx = e.idx;
  }
  if (e.kind === "document" && e.sourceRef && typeof e.sourceRef.path === "string") {
    const key = documentKey(e.source, e.sourceRef.path);
    const list = ix.documents.get(key) ?? [];
    const d: KnownDocument = { id: e.id, source: e.source, kind: e.kind, path: e.sourceRef.path, sha256: e.sourceRef.sha256, addedAt: e.addedAt };
    if (e.sourceRef.nativeId !== undefined) d.nativeId = e.sourceRef.nativeId;
    if (e.supersedes !== undefined) d.supersedes = e.supersedes;
    list.push(d);
    ix.documents.set(key, list);
  }
  if (typeof e.words === "number") {
    const sid = sourceIdOf(e);
    const w = ix.words.get(sid) ?? { words: 0, yourWords: 0, entries: 0 };
    w.words += e.words;
    if (e.speaker === "you" && e.hiddenByDefault !== "reference") w.yourWords += e.words;
    w.entries += 1;
    ix.words.set(sid, w);
  }
}

/** The entries-ledger index of this pass (one streaming read, only when an importer needs it). */
export async function ledgerEntryIndex(ctx: ImportContext): Promise<LedgerEntryIndex> {
  const c = cacheOf(ctx);
  c.ledgerIndex ??= (async () => {
    const ix: LedgerEntryIndex = { ids: new Set(), conversations: new Map(), documents: new Map(), words: new Map() };
    let n = 0;
    for await (const e of ctx.ledger.readAll("entries")) {
      if (e && typeof e === "object" && typeof e.id === "string") indexRecord(ix, e);
      if (++n % 5000 === 0) {
        ctx.token.throwIfCancelled();
        await ctx.yield();
      }
    }
    return ix;
  })();
  return c.ledgerIndex;
}

/** Ids already known for a conversation (ledger only). */
export async function knownIdsFromLedger(ctx: ImportContext, conv: ConversationId): Promise<ReadonlySet<EntryId>> {
  return (await ledgerEntryIndex(ctx)).conversations.get(conv)?.ids ?? new Set<EntryId>();
}

/** Keep this pass's caches current after writing entries (later lookups must see them). */
function noteEntriesWritten(ctx: ImportContext, recs: readonly EntryRecord[]): void {
  const c = cacheOf(ctx);
  if (!c.ledgerIndex) return;
  void c.ledgerIndex.then((ix) => {
    for (const r of recs) indexRecord(ix, r);
  });
}

/** The latest ConversationRecord of a conversation (the conversations ledger is read once per pass). */
export async function existingConversation(ctx: ImportContext, conv: ConversationId): Promise<ConversationRecord | undefined> {
  const c = cacheOf(ctx);
  c.conversations ??= (async () => {
    const all: ConversationRecord[] = [];
    for await (const r of ctx.ledger.readAll("conversations")) if (r && typeof r.id === "string" && typeof r.seq === "number") all.push(r);
    return latestById(all);
  })();
  return (await c.conversations).get(conv);
}

function rememberConversation(ctx: ImportContext, rec: ConversationRecord): void {
  // Not loaded yet: the first lookup reads the ledger, which already holds this record.
  void cacheOf(ctx).conversations?.then((m) => m.set(rec.id, rec));
}

/** Staged messages of a conversation on this computer ([] when nothing is staged or the stage is unreadable). */
export async function stagedMessages(ctx: ImportContext, conv: ConversationId): Promise<StagedMessage[]> {
  try {
    return await stageOf(ctx).read(ctx.store, conv);
  } catch (e) {
    if (errCode(e) === "ENOENT") return [];
    throw e;
  }
}

/**
 * The idx the next NEW message of a conversation gets: one past everything known in the ledger, the stage and
 * the latest conversation record (used when a cursor was lost or is stale).
 */
export async function nextIdxFor(ctx: ImportContext, conv: ConversationId, opts: { staged?: readonly StagedMessage[] } = {}): Promise<number> {
  const prev = await existingConversation(ctx, conv);
  const known = (await ledgerEntryIndex(ctx)).conversations.get(conv);
  let next = Math.max(prev?.entryCount ?? 0, (known?.maxIdx ?? -1) + 1);
  for (const s of opts.staged ?? (await stagedMessages(ctx, conv))) if (typeof s.entry.idx === "number") next = Math.max(next, s.entry.idx + 1);
  return next;
}

// ───────────────────────────── segments and batches ─────────────────────────────

/** A message ready to be appended to a conversation in this pass. */
export interface PendingMessage {
  nativeId: string;
  speaker: Speaker;
  speakerDetail?: string;
  text: string;
  ts?: IsoDate;
  part?: number;
  hiddenByDefault?: EntryRecord["hiddenByDefault"];
  sourceRef: SourceRef;
  /** Stable id; default entryId(source, `${conversation nativeId}:${nativeId}`). */
  id?: EntryId;
  /** Default "message". */
  kind?: EntryKind;
  title?: string;
  /** Default: the source timestamp (strong) + the ingest bound. */
  dates?: DateEvidence[];
  /** Default: `ts` when present. */
  writtenAt?: IsoDate;
  attachments?: AttachmentRef[];
  branches?: BranchVersion[];
  supersedes?: EntryId;
  passage?: EntryRecord["passage"];
  licence?: string;
  /** Per-entry overrides of the conversation's (or group's) area, folder and project. */
  space?: SpaceId;
  folder?: string[];
  project?: string;
}

/** Most uncompressed text one segment file receives; larger passes write several segments. */
export const SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
/** Ledger appends are chunked so a shard never grows far past SHARD_ROLL_BYTES in one append. */
const LEDGER_CHUNK_BYTES = 2 * 1024 * 1024;

/** Build the SegmentLine for a pending message (pure). */
export function toSegmentLine(id: EntryId, msg: PendingMessage, conv: ConversationId | undefined, i: number, sha: string): SegmentLine {
  const line: SegmentLine = { v: 1, id, nid: msg.nativeId, sp: msg.speaker, text: msg.text, sha };
  if (conv !== undefined) line.conv = conv;
  line.i = i;
  if (msg.ts !== undefined) line.ts = msg.ts;
  if (msg.speakerDetail !== undefined) line.model = msg.speakerDetail;
  return line;
}

/** "YYYY-MM" of a segment folder `.raw/chats/<source>/<yyyy-mm>/<conv>`. */
export function monthOfSegDir(segDir: string | undefined): string | undefined {
  const m = segDir ? /^\.raw\/chats\/[^/]+\/(\d{4}-\d{2})\/c_[a-z2-7]{16}$/.exec(segDir) : null;
  return m?.[1];
}

function monthKeyFor(ts: string | undefined, now: number): string {
  const t = ts !== undefined ? Date.parse(ts) : Number.NaN;
  return shardMonth(new Date(Number.isFinite(t) ? t : now).toISOString());
}

/** Append records in chunks (each chunk under the ledger's own lock). Returns the ledger seq after the last chunk. */
export async function appendChunked<L extends "entries" | "conversations">(ctx: ImportContext, ledger: L, records: readonly (L extends "entries" ? EntryRecord : ConversationRecord)[]): Promise<number> {
  let seq = 0;
  let chunk: (L extends "entries" ? EntryRecord : ConversationRecord)[] = [];
  let bytes = 0;
  for (const r of records) {
    const b = JSON.stringify(r).length + 1;
    if (chunk.length > 0 && bytes + b > LEDGER_CHUNK_BYTES) {
      seq = await ctx.ledger.append(ledger, chunk as never);
      chunk = [];
      bytes = 0;
    }
    chunk.push(r);
    bytes += b;
  }
  if (chunk.length > 0) seq = await ctx.ledger.append(ledger, chunk as never);
  return seq;
}

/** Split lines into segment-sized groups (never splitting one line). */
function segmentGroups<T extends { text: string }>(lines: readonly T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const l of lines) {
    const b = l.text.length * 1.1 + 200;
    if (cur.length > 0 && bytes + b > SEGMENT_MAX_BYTES) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(l);
    bytes += b;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** ConversationRecord.meta key holding the highest segment number this conversation has committed. */
export const META_SEGMENTS = "segments";

function segNumber(name: string): number {
  const m = /^(\d{4})\.jsonl\.gz$/.exec(name);
  return m ? Number(m[1]) : 0;
}

/**
 * Orphan segments of a conversation folder (written by an interrupted pass: every line id unknown to the
 * ledger). Only segments that may be orphans are read: numbers above the last committed one recorded on the
 * conversation record (`meta.segments`), or, for records without it, files newer than the record.
 */
async function orphanSegmentsOf(ctx: ImportContext, segDir: VaultPath, prev: ConversationRecord | undefined, known: () => Promise<ReadonlySet<EntryId>>): Promise<SuspectScan> {
  const none: SuspectScan = { orphans: [], committed: new Set() };
  let names: string[];
  const abs = resolveInVault(ctx.store.vaultRoot, segDir);
  try {
    names = (await fsp.readdir(abs)).filter((n) => segNumber(n) > 0).sort();
  } catch {
    return none;
  }
  if (names.length === 0) return none;
  const committed = Number(prev?.meta?.[META_SEGMENTS] ?? Number.NaN);
  const suspects: string[] = [];
  if (prev === undefined) suspects.push(...names);
  else if (Number.isFinite(committed)) suspects.push(...names.filter((n) => segNumber(n) > committed));
  else {
    const since = Date.parse(prev.updatedAt);
    for (const n of names) {
      const st = await fsp.stat(path.join(abs, n)).catch(() => null);
      if (st && st.mtimeMs > since + 1) suspects.push(n);
    }
  }
  if (suspects.length === 0) return none;
  const ids = await known();
  const out: SuspectScan = { orphans: [], committed: new Set() };
  for (const n of suspects) {
    const seg = `${segDir}/${n}`;
    let lines: SegmentLine[];
    try {
      lines = await readSegment(ctx.store.vaultRoot, seg);
    } catch (e) {
      if (isNotLocalError(e)) noteNotLocal(ctx, seg);
      continue;
    }
    if (lines.length === 0) continue;
    if (lines.every((l) => !ids.has(l.id))) out.orphans.push({ seg, lines });
    // Entries appended but the conversation record not yet: these ids are committed, never write them again.
    else for (const l of lines) if (ids.has(l.id)) out.committed.add(l.id);
  }
  return out;
}

interface SuspectScan {
  orphans: { seg: VaultPath; lines: SegmentLine[] }[];
  committed: Set<string>;
}

/** Highest segment number present in a conversation folder (0 when none). */
async function highestSegment(ctx: ImportContext, segDir: VaultPath): Promise<number> {
  try {
    return Math.max(0, ...(await fsp.readdir(resolveInVault(ctx.store.vaultRoot, segDir))).map(segNumber));
  } catch {
    return 0;
  }
}

interface PreparedEntry {
  id: EntryId;
  msg: PendingMessage;
  text: string;
  sha: string;
  idx?: number;
  held: HeldMarker[];
}

function prepare(privacy: ImportPrivacy, items: readonly { id: EntryId; msg: PendingMessage; idx?: number }[]): PreparedEntry[] {
  return items.map((it) => {
    const p = protectSecrets(it.msg.text, privacy.keepSecretsLocal);
    const prepared: PreparedEntry = { id: it.id, msg: it.msg, text: p.text, sha: sha256Text(p.text), held: p.markers };
    if (it.idx !== undefined) prepared.idx = it.idx;
    return prepared;
  });
}

async function holdAll(ctx: ImportContext, prepared: readonly PreparedEntry[]): Promise<void> {
  const t = tallyOf(ctx);
  for (const p of prepared) {
    if (p.held.length === 0) continue;
    await writeHeld(ctx, p.id, p.held);
    t.secretsHeld += p.held.length;
    warn(ctx, "secret-held", p.held.length);
  }
}

interface EntryBase {
  source: SourceKind;
  conv?: ConversationId;
  space: SpaceId;
  folder: string[];
  project?: string;
  addedAt: IsoDate;
  /** Apply the secret marker to titles too (keepSecretsLocal). */
  protectTitles: boolean;
}

function entryFor(p: PreparedEntry, base: EntryBase, ref: TextRef): EntryRecord {
  const m = p.msg;
  const args: NewEntryArgs = {
    id: p.id,
    kind: m.kind ?? "message",
    source: base.source,
    sourceRef: m.sourceRef,
    text: p.text,
    textSha256: p.sha,
    textRef: ref,
    speaker: m.speaker,
    dates: m.dates ?? messageDates(m.ts, base.addedAt),
    addedAt: base.addedAt,
    space: m.space ?? base.space,
    folder: m.folder ?? base.folder,
  };
  if (base.conv !== undefined) args.conv = base.conv;
  if (p.idx !== undefined) args.idx = p.idx;
  if (m.part !== undefined) args.part = m.part;
  if (m.speakerDetail !== undefined) args.speakerDetail = m.speakerDetail;
  if (m.title !== undefined) args.title = protectSecrets(m.title, base.protectTitles).text;
  const written = m.writtenAt ?? m.ts;
  if (written !== undefined) args.writtenAt = written;
  const project = m.project ?? base.project;
  if (project !== undefined) args.project = project;
  if (m.hiddenByDefault !== undefined) args.hiddenByDefault = m.hiddenByDefault;
  if (m.attachments !== undefined) args.attachments = m.attachments;
  if (m.branches !== undefined) args.branches = m.branches;
  if (m.supersedes !== undefined) args.supersedes = m.supersedes;
  if (m.passage !== undefined) args.passage = m.passage;
  if (m.licence !== undefined) args.licence = m.licence;
  return makeEntryRecord(args);
}

/** Rebuild an EntryRecord from an orphan segment line when this pass no longer has the message itself. */
function entryFromOrphanLine(line: SegmentLine, seg: VaultPath, lineNo: number, base: EntryBase & { sourcePath: string }): EntryRecord {
  const args: NewEntryArgs = {
    id: line.id,
    kind: "message",
    source: base.source,
    sourceRef: { path: base.sourcePath, nativeId: line.nid, sha256: line.sha },
    text: line.text,
    textSha256: line.sha,
    textRef: { store: "segment", seg, line: lineNo },
    speaker: line.sp,
    dates: messageDates(line.ts, base.addedAt),
    addedAt: base.addedAt,
    space: base.space,
    folder: base.folder,
  };
  if (base.conv !== undefined) args.conv = base.conv;
  if (typeof line.i === "number") args.idx = line.i;
  if (line.model !== undefined) args.speakerDetail = line.model;
  if (line.ts !== undefined) args.writtenAt = line.ts;
  if (base.project !== undefined) args.project = base.project;
  return makeEntryRecord(args);
}

function mergeParts(prev: readonly ConversationPart[], added: readonly Pick<EntryRecord, "id" | "part" | "writtenAt">[]): ConversationPart[] {
  const parts = prev.map((p) => ({ ...p }));
  for (const e of added) {
    const n = e.part ?? parts[parts.length - 1]?.n ?? 0;
    const p = parts.find((x) => x.n === n);
    if (!p) {
      const np: ConversationPart = { n, firstEntry: e.id, lastEntry: e.id };
      if (e.writtenAt !== undefined) np.startedAt = e.writtenAt;
      parts.push(np);
      parts.sort((a, b) => a.n - b.n);
    } else {
      p.lastEntry = e.id;
      if (p.startedAt === undefined && e.writtenAt !== undefined) p.startedAt = e.writtenAt;
    }
  }
  return parts;
}

function minIso(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Date.parse(b) < Date.parse(a) ? b : a;
}

function maxIso(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

export type ConversationMeta = Omit<ConversationRecord, "v" | "seq" | "entryCount" | "parts" | "updatedAt"> & { parts?: ConversationRecord["parts"] };

/**
 * Collects one conversation's new messages during a pass and flushes them as ONE new segment (number derived
 * from the conversation folder, exclusive create; passes over ~8 MB of text write several) + EntryRecords + an
 * upserted ConversationRecord (with segDir). Live sessions flush to the local stage instead (store/stage.ts).
 * Used by every importer of conversations.
 */
export interface ConversationBatch {
  readonly conv: ConversationId;
  add(msg: PendingMessage): void;
  /** Number of new messages waiting. */
  readonly size: number;
  /** idx the next new message will get (startIdx + messages written or staged so far). */
  readonly nextIdx: number;
  /** Adjust waiting messages before a flush (e.g. mark an automated session's entries). */
  forEachPending(fn: (msg: PendingMessage) => void): void;
  /** Write segment, ledger lines and the conversation record. Returns entries written (or staged). */
  flush(meta: ConversationMeta): Promise<number>;
}

export interface ConversationBatchOptions {
  /** Stage complete messages on this computer instead of writing a segment (LIVE-SESSION-SEMANTICS). */
  live: boolean;
  /**
   * The caller read these messages past a valid cursor, so they cannot be in the ledger yet: skip the ledger
   * lookup (the stage and orphan segments are still checked). Default false: dedupe against the ledger whenever
   * the conversation may already have entries.
   */
  fresh?: boolean;
}

/**
 * @param startIdx idx of the first NEW message (messages already known are dropped and take no idx); pass
 *                 `await nextIdxFor(ctx, conv)` when the importer keeps no counter of its own.
 */
export function createConversationBatch(ctx: ImportContext, conv: ConversationId, startIdx: number, opts: ConversationBatchOptions): ConversationBatch {
  let pending: PendingMessage[] = [];
  let nextIdx = startIdx;
  return {
    conv,
    get size() {
      return pending.length;
    },
    get nextIdx() {
      return nextIdx;
    },
    add(msg) {
      pending.push(msg);
    },
    forEachPending(fn) {
      for (const m of pending) fn(m);
    },
    async flush(meta) {
      const msgs = pending;
      pending = [];
      if (meta.id !== conv) throw new CortexError("E_INTERNAL", "conversation batch flushed with another conversation's record");
      const privacy = await importPrivacy(ctx);
      if (privacy.isExcluded({ source: meta.source, conv, ...(meta.project !== undefined ? { project: meta.project } : {}) })) return 0;
      const t = tallyOf(ctx);
      const prev = await existingConversation(ctx, conv);
      const firstTs = msgs.find((m) => m.ts !== undefined)?.ts;
      const monthKey = monthOfSegDir(prev?.segDir) ?? monthOfSegDir(meta.segDir) ?? monthKeyFor(meta.startedAt ?? firstTs, ctx.now());
      const segDir = prev?.segDir ?? segmentDir(meta.source, monthKey, conv);
      const staged = opts.live || prev === undefined || prev.entryCount === 0 ? await stagedMessages(ctx, conv) : [];
      // Dedupe: ids on the stage, twice in this batch, or (unless the caller vouches) already in the ledger.
      const seen = new Set<string>(staged.map((s) => s.entry.id));
      let known: ReadonlySet<EntryId> | undefined;
      const knownIds = async (): Promise<ReadonlySet<EntryId>> => (known ??= await ctx.knownEntryIds(conv));
      // A folder without a record means an interrupted first write: always consult the ledger then.
      const checkLedger = (prev === undefined && (await folderExists(ctx, segDir))) || (!opts.fresh && (prev !== undefined || staged.length > 0));
      const fresh: { id: EntryId; msg: PendingMessage }[] = [];
      for (const m of msgs) {
        const id = m.id ?? makeEntryId(meta.source, `${meta.nativeId}:${m.nativeId}`);
        if (seen.has(id)) continue;
        if (checkLedger && (await knownIds()).has(id)) continue;
        seen.add(id);
        fresh.push({ id, msg: m });
      }
      const room = ctx.maxEntries !== undefined ? Math.max(0, ctx.maxEntries - t.added) : Number.POSITIVE_INFINITY;
      if (fresh.length > room) {
        fresh.length = room;
        t.partial = true;
      }
      const titleChanged = prev !== undefined && (prev.title !== meta.title || prev.titledBy !== meta.titledBy);
      const changedMeta = prev !== undefined && metaChanged(prev, meta);
      if (fresh.length === 0 && (prev === undefined || (!titleChanged && !changedMeta))) return 0;
      const prepared = prepare(privacy, fresh.map((f) => ({ ...f, idx: nextIdx++ })));
      const addedAt = new Date(ctx.now()).toISOString();
      const base: EntryBase = { source: meta.source, conv, space: meta.space, folder: meta.folder, addedAt, protectTitles: privacy.keepSecretsLocal, ...(meta.project !== undefined ? { project: meta.project } : {}) };
      if (ctx.dryRun) {
        t.added += prepared.length;
        if (prepared.length > 0) t.conversations.add(conv);
        return prepared.length;
      }
      await holdAll(ctx, prepared);
      const records: EntryRecord[] = [];
      let segments = Number(prev?.meta?.[META_SEGMENTS] ?? 0) || 0;
      if (opts.live) {
        const offset = staged.length;
        const items: StagedMessage[] = prepared.map((p, i) => ({
          line: toSegmentLine(p.id, { ...p.msg, text: p.text }, conv, p.idx ?? 0, p.sha),
          entry: entryFor(p, base, { store: "stage", conv, line: offset + i }),
        }));
        if (items.length > 0) t.staged += await stageOf(ctx).stage(ctx.store, conv, items);
        for (const it of items) records.push(it.entry);
      } else {
        // Orphans first (SEGMENT-SEQ-DEADLOCK): their lines may already hold some of these messages.
        const scan = await orphanSegmentsOf(ctx, segDir, prev, knownIds);
        const orphans = scan.orphans;
        const inOrphan = new Map<string, { seg: VaultPath; line: number }>();
        for (const o of orphans) o.lines.forEach((l, i) => inOrphan.set(l.id, { seg: o.seg, line: i }));
        const adopted = new Set<string>(scan.committed);
        for (const p of prepared) {
          if (scan.committed.has(p.id)) continue;
          const at = inOrphan.get(p.id);
          if (!at) continue;
          records.push(entryFor(p, base, { store: "segment", seg: at.seg, line: at.line }));
          adopted.add(p.id);
        }
        const sourcePath = msgs[0]?.sourceRef.path ?? "";
        for (const o of orphans) {
          o.lines.forEach((l, i) => {
            if (adopted.has(l.id) || seen.has(l.id)) return;
            records.push(entryFromOrphanLine(l, o.seg, i, { ...base, sourcePath }));
            adopted.add(l.id);
          });
        }
        for (const group of segmentGroups(prepared.filter((p) => !adopted.has(p.id)))) {
          const lines = group.map((p) => toSegmentLine(p.id, { ...p.msg, text: p.text }, conv, p.idx ?? 0, p.sha));
          const seg = await writeSegment(ctx.store, { source: meta.source, monthKey, conv, lines });
          segments = Math.max(segments, seg.seq);
          group.forEach((p, i) => records.push(entryFor(p, base, { store: "segment", seg: seg.path, line: i })));
        }
        if (orphans.length > 0 || scan.committed.size > 0) segments = Math.max(segments, await highestSegment(ctx, segDir));
        records.sort((a, b) => (a.idx ?? 0) - (b.idx ?? 0));
        if (records.length > 0) await appendChunked(ctx, "entries", records);
        noteEntriesWritten(ctx, records);
      }
      t.added += records.length;
      if (records.length > 0) t.conversations.add(conv);
      tallyWords(ctx, records);
      // Live passes rewrite the conversation record only when something material changed (a new conversation,
      // its title or meta, a new part); counts and end times are brought up to date when the stage is sealed.
      const prevParts = prev?.parts ?? [];
      const parts = meta.parts ?? mergeParts(prevParts, records);
      const material = prev === undefined || titleChanged || changedMeta || parts.length !== prevParts.length;
      if (!opts.live || material) {
        const rec = conversationRecord(ctx, prev, meta, { parts, segDir, added: records, segments, nextIdx, protectTitle: privacy.keepSecretsLocal });
        await ctx.ledger.append("conversations", [rec]);
        rememberConversation(ctx, rec);
      }
      return records.length;
    },
  };
}

async function folderExists(ctx: ImportContext, dir: VaultPath): Promise<boolean> {
  try {
    return (await fsp.stat(resolveInVault(ctx.store.vaultRoot, dir))).isDirectory();
  } catch {
    return false;
  }
}

function metaChanged(prev: ConversationRecord, meta: ConversationMeta): boolean {
  if (prev.space !== meta.space || prev.project !== meta.project) return true;
  if (prev.folder.join("/") !== meta.folder.join("/")) return true;
  const a = prev.meta ?? {};
  const b = meta.meta ?? {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete(META_SEGMENTS);
  for (const k of keys) if (a[k] !== b[k]) return true;
  return false;
}

/** Build the upserted record: Cortex-owned fields from this pass, foreign fields (gistNoteId) carried over. */
function conversationRecord(
  ctx: ImportContext,
  prev: ConversationRecord | undefined,
  meta: ConversationMeta,
  x: { parts: ConversationPart[]; segDir: VaultPath; added: readonly EntryRecord[]; segments: number; nextIdx: number; protectTitle: boolean },
): ConversationRecord {
  let started = minIso(prev?.startedAt, meta.startedAt);
  let ended = maxIso(prev?.endedAt, meta.endedAt);
  let maxIdx = -1;
  for (const r of x.added) {
    started = minIso(started, r.writtenAt);
    ended = maxIso(ended, r.writtenAt);
    if (typeof r.idx === "number" && r.idx > maxIdx) maxIdx = r.idx;
  }
  const now = ctx.now();
  const metaOut: Record<string, string> = { ...(meta.meta ?? {}) };
  if (x.segments > 0) metaOut[META_SEGMENTS] = String(x.segments);
  const rec: ConversationRecord = {
    v: 1,
    id: meta.id,
    seq: Math.max(now, (prev?.seq ?? 0) + 1),
    source: meta.source,
    nativeId: meta.nativeId,
    title: protectSecrets(meta.title, x.protectTitle).text,
    titledBy: meta.titledBy,
    entryCount: Math.max(prev?.entryCount ?? 0, maxIdx + 1, x.nextIdx),
    parts: x.parts,
    space: meta.space,
    folder: meta.folder,
    segDir: x.segDir,
    updatedAt: new Date(now).toISOString(),
  };
  if (started !== undefined) rec.startedAt = started;
  if (ended !== undefined) rec.endedAt = ended;
  if (meta.project !== undefined) rec.project = meta.project;
  if (Object.keys(metaOut).length > 0) rec.meta = metaOut;
  const gist = meta.gistNoteId ?? prev?.gistNoteId;
  if (gist !== undefined) rec.gistNoteId = gist;
  return rec;
}

/**
 * Seal staged live conversations into ONE segment each (store/stage.ts) once they have been idle long enough,
 * or all of them (`all`, the daily seal), then bring their conversation records up to date. Conversations left
 * out since they were staged are not sealed: their text stays on this computer.
 */
export async function sealStagedConversations(ctx: ImportContext, opts: { all: boolean; idleMinutes: number; source?: SourceKind }): Promise<{ conversations: number; entries: number }> {
  if (ctx.dryRun) return { conversations: 0, entries: 0 };
  const stage = stageOf(ctx);
  let list: StagedConversation[];
  try {
    list = await stage.list(ctx.store);
  } catch (e) {
    if (errCode(e) === "ENOENT") return { conversations: 0, entries: 0 };
    throw e;
  }
  const due = opts.all ? list.map((s) => s.conv) : dueForSeal(list, ctx.now(), opts.idleMinutes);
  const privacy = await importPrivacy(ctx);
  let conversations = 0;
  let entries = 0;
  for (const conv of due) {
    ctx.token.throwIfCancelled();
    const prev = await existingConversation(ctx, conv);
    if (opts.source !== undefined && prev !== undefined && prev.source !== opts.source) continue;
    if (privacy.isExcluded({ conv, ...(prev ? { source: prev.source } : {}), ...(prev?.project !== undefined ? { project: prev.project } : {}) })) continue;
    const staged = await stagedMessages(ctx, conv);
    if (staged.length === 0) continue;
    const r = await stage.seal(ctx.store, conv);
    conversations++;
    entries += r.entries;
    const sealed = staged.map((s) => s.entry);
    noteEntriesWritten(ctx, sealed);
    if (!prev) continue;
    let ended = prev.endedAt;
    let maxIdx = -1;
    for (const e of sealed) {
      ended = maxIso(ended, e.writtenAt);
      if (typeof e.idx === "number" && e.idx > maxIdx) maxIdx = e.idx;
    }
    const segDir = prev.segDir ?? (r.segment ? r.segment.slice(0, r.segment.lastIndexOf("/")) : undefined);
    const metaOut: Record<string, string> = { ...(prev.meta ?? {}) };
    if (segDir !== undefined) {
      const highest = await highestSegment(ctx, segDir);
      if (highest > 0) metaOut[META_SEGMENTS] = String(highest);
    }
    const rec: ConversationRecord = {
      ...prev,
      seq: Math.max(ctx.now(), prev.seq + 1),
      parts: mergeParts(prev.parts, sealed),
      entryCount: Math.max(prev.entryCount, maxIdx + 1),
      updatedAt: new Date(ctx.now()).toISOString(),
    };
    if (ended !== undefined) rec.endedAt = ended;
    if (segDir !== undefined) rec.segDir = segDir;
    if (Object.keys(metaOut).length > 0) rec.meta = metaOut;
    await ctx.ledger.append("conversations", [rec]);
    rememberConversation(ctx, rec);
  }
  return { conversations, entries };
}

// ───────────────────────────── document batches (no conversation) ─────────────────────────────

/** Entries that are not conversation messages (vault notes, folders, new entries): copied into segments. */
export interface DocumentBatch {
  add(msg: PendingMessage & { id: EntryId }): void;
  readonly size: number;
  /** Write one segment per ~8 MB plus the ledger lines; returns the records written. */
  flush(base: { space: SpaceId; folder: string[]; project?: string }): Promise<EntryRecord[]>;
}

/**
 * Segment folder of a document group: `.raw/chats/<source>/<yyyy-mm>/<c_…>/` where the folder id is derived
 * from (source, group, month), so each pass adds one immutable segment to its month's folder.
 */
export function documentGroupDir(source: SourceKind, group: string, now: number): { monthKey: string; folderId: ConversationId; dir: VaultPath } {
  const monthKey = shardMonth(new Date(now).toISOString());
  const folderId = conversationId(source, `group:${group}:${monthKey}`);
  return { monthKey, folderId, dir: segmentDir(source, monthKey, folderId) };
}

export function createDocumentBatch(ctx: ImportContext, source: SourceKind, group: string): DocumentBatch {
  let pending: (PendingMessage & { id: EntryId })[] = [];
  return {
    get size() {
      return pending.length;
    },
    add(msg) {
      pending.push(msg);
    },
    async flush(base) {
      const msgs = pending;
      pending = [];
      if (msgs.length === 0) return [];
      const privacy = await importPrivacy(ctx);
      const ix = await ledgerEntryIndex(ctx);
      const seen = new Set<string>();
      const fresh: { id: EntryId; msg: PendingMessage }[] = [];
      for (const m of msgs) {
        if (ix.ids.has(m.id) || seen.has(m.id)) continue;
        seen.add(m.id);
        fresh.push({ id: m.id, msg: m });
      }
      if (fresh.length === 0) return [];
      const t = tallyOf(ctx);
      const room = ctx.maxEntries !== undefined ? Math.max(0, ctx.maxEntries - t.added) : Number.POSITIVE_INFINITY;
      if (fresh.length > room) {
        fresh.length = room;
        t.partial = true;
      }
      const prepared = prepare(privacy, fresh);
      if (ctx.dryRun) {
        t.added += prepared.length;
        return [];
      }
      await holdAll(ctx, prepared);
      const addedAt = new Date(ctx.now()).toISOString();
      const { monthKey, folderId } = documentGroupDir(source, group, ctx.now());
      const records: EntryRecord[] = [];
      const b: EntryBase = { source, space: base.space, folder: base.folder, addedAt, protectTitles: privacy.keepSecretsLocal, ...(base.project !== undefined ? { project: base.project } : {}) };
      for (const g of segmentGroups(prepared)) {
        const lines = g.map((p, i) => toSegmentLine(p.id, { ...p.msg, text: p.text }, undefined, i, p.sha));
        for (const l of lines) delete l.i;
        const seg = await writeSegment(ctx.store, { source, monthKey, conv: folderId, lines });
        g.forEach((p, i) => records.push(entryFor(p, b, { store: "segment", seg: seg.path, line: i })));
      }
      await appendChunked(ctx, "entries", records);
      noteEntriesWritten(ctx, records);
      t.added += records.length;
      tallyWords(ctx, records);
      return records;
    },
  };
}

/** Append entries whose text stays in place (`.raw/` byte ranges): ledger lines only. */
export async function appendInPlaceEntries(ctx: ImportContext, records: readonly EntryRecord[]): Promise<number> {
  if (records.length === 0) return 0;
  const ix = await ledgerEntryIndex(ctx);
  const seen = new Set<string>();
  const fresh = records.filter((r) => {
    if (ix.ids.has(r.id) || seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
  if (fresh.length === 0) return 0;
  const t = tallyOf(ctx);
  if (!ctx.dryRun) {
    await appendChunked(ctx, "entries", fresh);
    noteEntriesWritten(ctx, fresh);
  }
  t.added += fresh.length;
  tallyWords(ctx, fresh);
  return fresh.length;
}

// ───────────────────────────── document state (machine-local) ─────────────────────────────

/** What Cortex last imported from one document (raw docs, folders, vault notes, new entries). */
export interface DocState {
  /** Vault path (vault sources) or absolute path (folders). */
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
  /** Document entry of the current version. */
  docId: EntryId;
  versions: number;
  importedAt: IsoDate;
  /** Set when the file changed on disk and the new version is not imported yet. */
  changed?: { sha256: string; size: number; mtimeMs: number; seenAt: IsoDate };
}

export interface DocStateFile {
  v: 1;
  files: Record<string, DocState>;
}

/** `<cache>/state/docs-<name>.json` (rebuildable from the ledger; never synced). */
export function docStatePath(cacheDir: string, name: string): string {
  return path.join(cacheLayout(cacheDir).state, `docs-${name}.json`);
}

export async function loadDocState(cacheDir: string, name: string): Promise<DocStateFile | null> {
  try {
    const f = await readJsonIfExists<DocStateFile>(docStatePath(cacheDir, name));
    return f && f.v === 1 && typeof f.files === "object" && f.files !== null ? f : null;
  } catch {
    return null;
  }
}

export async function saveDocState(ctx: ImportContext, name: string, state: DocStateFile): Promise<void> {
  if (ctx.dryRun) return;
  await writeJsonAtomic(cacheWritablePath(ctx.store.cacheDir, `state/docs-${name}.json`), state);
  (cacheOf(ctx).docStateSavedAt ??= new Map()).set(name, ctx.now());
}

/** A pass writes the whole state file at most this often while it runs (and once more at its end). */
export const DOC_STATE_SAVE_MS = 5000;

/**
 * Mid-pass save of a document state file, at most once per DOC_STATE_SAVE_MS. The state is a cache that the next
 * pass rebuilds from the ledger, and a note already in the ledger is recognised by its id, so a pass that stops
 * between saves only repeats cheap lookups. Rewriting the whole file after every 150 notes was quadratic: 17,000
 * notes meant 113 rewrites of a growing multi-megabyte file. Returns whether it wrote (callers keep their dirty
 * count otherwise); the final save at the end of the pass uses saveDocState.
 */
export async function saveDocStateSoon(ctx: ImportContext, name: string, state: DocStateFile): Promise<boolean> {
  const last = cacheOf(ctx).docStateSavedAt?.get(name);
  if (last !== undefined && ctx.now() - last < DOC_STATE_SAVE_MS) return false;
  await saveDocState(ctx, name, state);
  return true;
}

/**
 * The document state of a source, rebuilt from the ledger when the cache lost it: the newest version per path
 * (size and mtime unknown, so the next stat compares hashes).
 */
export async function docStateOrRebuild(ctx: ImportContext, name: string, source: SourceKind, keyOf: (d: KnownDocument) => string | undefined): Promise<DocStateFile> {
  const cur = await loadDocState(ctx.store.cacheDir, name);
  if (cur) return cur;
  const ix = await ledgerEntryIndex(ctx);
  const files: Record<string, DocState> = {};
  for (const list of ix.documents.values()) {
    const versions = list.filter((d) => d.source === source);
    if (versions.length === 0) continue;
    const superseded = new Set(versions.map((d) => d.supersedes).filter((x): x is EntryId => x !== undefined));
    const latest = [...versions].reverse().find((d) => !superseded.has(d.id)) ?? (versions[versions.length - 1] as KnownDocument);
    const key = keyOf(latest);
    if (key === undefined) continue;
    files[key] = { path: latest.path, size: -1, mtimeMs: -1, sha256: latest.sha256, docId: latest.id, versions: versions.length, importedAt: latest.addedAt };
  }
  return { v: 1, files };
}

// ───────────────────────────── small helpers shared by importers ─────────────────────────────

/** Split `---` frontmatter from a markdown text (body offsets in characters). */
export function splitFrontmatter(text: string): { fm: Record<string, string>; body: string; bodyStart: number } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fm: {}, body: text, bodyStart: 0 };
  const fm: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    let v = kv[2] ?? "";
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      if (v.startsWith('"')) {
        try {
          v = JSON.parse(v) as string;
        } catch {
          v = v.slice(1, -1);
        }
      } else v = v.slice(1, -1).replace(/''/g, "'");
    }
    fm[kv[1] as string] = v;
  }
  return { fm, body: text.slice(m[0].length), bodyStart: m[0].length };
}

/** A date from frontmatter: "YYYY-MM-DD" (day level) or a full ISO timestamp; undefined when invalid. */
export function frontmatterDate(v: string | undefined): IsoDate | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(t) ? s : undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?$/.test(s)) {
    const t = Date.parse(s.replace(" ", "T"));
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  }
  return undefined;
}

/** The first `# Heading` of a markdown body, or undefined. */
export function firstHeading(body: string): string | undefined {
  const m = /^#[ \t]+(.+?)[ \t#]*$/m.exec(body);
  return m?.[1]?.trim() || undefined;
}

/** File name without its extension. */
export function stemOf(p: string): string {
  const base = p.replace(/\\/g, "/").split("/").pop() ?? p;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

// ───────────────────────────── document sources: walking and versioning ─────────────────────────────

export interface WalkedFile {
  /** POSIX path below the walked root, prefixed with `relPrefix`. */
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

/**
 * Files below `rootAbs` in a stable order, depth first. `skip` decides per entry (a directory returning true is
 * not entered). Symbolic links and junctions are never followed, so a link cannot lead out of the folder or
 * around a loop. Unreadable folders and files that vanish are skipped; a missing root throws.
 */
/** Files stat-ed at once while walking a folder. */
const STAT_BATCH = 32;

export async function* walkFiles(rootAbs: string, relPrefix: string, skip: (rel: string, isDir: boolean) => boolean): AsyncGenerator<WalkedFile> {
  const stack: { abs: string; rel: string }[] = [{ abs: rootAbs, rel: relPrefix.replace(/\/+$/, "") }];
  let first = true;
  while (stack.length > 0) {
    const dir = stack.pop() as { abs: string; rel: string };
    let entries: import("node:fs").Dirent[];
    try {
      entries = await withFsRetry(() => fsp.readdir(dir.abs, { withFileTypes: true }));
    } catch (e) {
      if (first) throw e;
      continue;
    }
    first = false;
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: { abs: string; rel: string }[] = [];
    const files: { rel: string; abs: string }[] = [];
    for (const d of entries) {
      if (d.isSymbolicLink()) continue;
      const rel = dir.rel === "" ? d.name : `${dir.rel}/${d.name}`;
      const abs = path.join(dir.abs, d.name);
      if (d.isDirectory()) {
        if (!skip(rel, true)) subdirs.push({ abs, rel });
        continue;
      }
      if (!d.isFile() || skip(rel, false)) continue;
      files.push({ rel, abs });
    }
    // Stat a folder's files a few at a time (each stat waits on the disk), yielding in name order.
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      const chunk = files.slice(i, i + STAT_BATCH);
      const stats = await Promise.all(chunk.map((f) => fsp.stat(f.abs).catch(() => null)));
      for (let k = 0; k < chunk.length; k++) {
        const st = stats[k];
        const f = chunk[k] as { rel: string; abs: string };
        if (st?.isFile()) yield { rel: f.rel, abs: f.abs, size: st.size, mtimeMs: st.mtimeMs };
      }
    }
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i] as { abs: string; rel: string });
  }
}

/** Largest document file read into memory in one piece (md, txt, code, csv, html …). */
export const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/** What to do with one document file (raw documents, folders, vault notes, written entries). */
export type DocDecision =
  | { act: "skip" }
  /** Same bytes as the imported version: only the stat changed. */
  | { act: "touch"; state: DocState }
  /** Different bytes and the new version was not confirmed: flag "changed on disk", import nothing. */
  | { act: "changed"; state: DocState }
  /** New file, or a changed file whose new version is wanted. */
  | { act: "import"; bytes: Buffer; sha: string; prev?: DocState };

export interface DecideOptions {
  /** Import a changed file as a new version (otherwise it is only flagged). */
  allowChange: boolean;
  /** A changed file younger than this is left for a later pass (notes that are still being edited). */
  quietMs?: number;
}

/**
 * Compare a file with what was imported. The bytes are read only when the stat differs from the recorded one,
 * so an unchanged tree costs one stat per file.
 */
export async function decideDocument(ctx: ImportContext, f: { abs: string; size: number; mtimeMs: number }, prev: DocState | undefined, opts: DecideOptions): Promise<DocDecision> {
  // Documents are read whole; anything beyond this is left alone instead of exhausting memory (huge inputs).
  if (f.size > MAX_DOCUMENT_BYTES) return { act: "skip" };
  const seen = prev?.changed ?? prev;
  if (prev && seen && seen.size === f.size && seen.mtimeMs === f.mtimeMs && !(prev.changed && opts.allowChange)) return { act: "skip" };
  if (prev && opts.quietMs !== undefined && opts.allowChange && ctx.now() - f.mtimeMs < opts.quietMs) return { act: "skip" };
  const bytes = await withFsRetry(() => fsp.readFile(f.abs));
  const sha = sha256Bytes(bytes);
  if (!prev) return { act: "import", bytes, sha };
  if (sha === prev.sha256) {
    const state: DocState = { ...prev, size: f.size, mtimeMs: f.mtimeMs };
    delete state.changed;
    return { act: "touch", state };
  }
  if (!opts.allowChange) return { act: "changed", state: { ...prev, changed: { sha256: sha, size: f.size, mtimeMs: f.mtimeMs, seenAt: new Date(ctx.now()).toISOString() } } };
  return { act: "import", bytes, sha, prev };
}

/** Document reads in flight ahead of the importer's loop (see node/pool.ts). */
export const READ_AHEAD = 8;
/** Only files up to this size are read ahead; bigger ones are read when the loop reaches them (bounded memory). */
export const READ_AHEAD_MAX_BYTES = 1024 * 1024;

/**
 * The document files of a walk with their decisions, read a few at a time ahead of the loop that consumes them
 * (one await per file made a 17,000-note import wait on the disk for most of its time). `wanted` is the loop's
 * own pre-filter: unwanted files get no decision. Order, and the per-file `prev` state, are unchanged: a path
 * occurs once per walk, so deciding it early cannot see a different state.
 */
export function documentsAhead(files: AsyncIterable<WalkedFile>, wanted: (f: WalkedFile) => boolean, decide: (f: WalkedFile) => Promise<DocDecision>): AsyncGenerator<Ahead<WalkedFile, DocDecision>> {
  return readAhead(files, { limit: READ_AHEAD, wanted, eager: (f) => f.size <= READ_AHEAD_MAX_BYTES }, decide);
}

/** Decode UTF-8 text only when it round-trips byte for byte (so byte ranges computed on the text stay exact). */
export function decodeExactUtf8(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");
  return Buffer.byteLength(text, "utf8") === bytes.length && Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

/** Date evidence for a document: a day-level or exact claim from the note itself (medium) plus the ingest bound. */
export function documentDates(claim: { at: IsoDate; type: DateEvidence["type"]; detail?: string } | undefined, addedAt: IsoDate): DateEvidence[] {
  const out: DateEvidence[] = [];
  if (claim) {
    const e: DateEvidence = { type: claim.type, strength: "medium", at: claim.at };
    if (claim.detail !== undefined) e.detail = claim.detail;
    out.push(e);
  }
  out.push({ type: "ingest", strength: "bound", at: addedAt });
  return out;
}

// ───────────────────────────── OneDrive placeholders (Sources › Needs attention) ─────────────────────────────

export interface NotLocalFile {
  v: 1;
  /** Importer key → files that were not on this computer when last read (at most 500 each). */
  bySource: Record<string, string[]>;
}

/** `<cache>/state/not-local.json` (read by SourcesService: the count and "Fetch now"). */
export function notLocalFilePath(cacheDir: string): string {
  return path.join(cacheLayout(cacheDir).state, "not-local.json");
}

/**
 * Run an importer and keep the list of files it found only as OneDrive placeholders, replacing what the same
 * importer listed on its last pass. The list holds paths only (SAFE-17).
 */
export async function trackNotLocal<T>(ctx: ImportContext, key: string, run: () => Promise<T>): Promise<T> {
  const before = new Set(tallyOf(ctx).notLocal);
  const result = await run();
  if (ctx.dryRun) return result;
  const found = [...tallyOf(ctx).notLocal].filter((p) => !before.has(p)).slice(0, 500);
  try {
    const cur = (await readJsonIfExists<NotLocalFile>(notLocalFilePath(ctx.store.cacheDir))) ?? { v: 1 as const, bySource: {} };
    const had = cur.bySource?.[key] ?? [];
    if (had.length === 0 && found.length === 0) return result;
    const next: NotLocalFile = { v: 1, bySource: { ...(cur.bySource ?? {}) } };
    if (found.length > 0) next.bySource[key] = found;
    else delete next.bySource[key];
    await writeJsonAtomic(cacheWritablePath(ctx.store.cacheDir, "state/not-local.json"), next);
  } catch (e) {
    ctx.log.warn("could not keep the list of files that are not on this computer", { code: errCode(e) ?? "E_IO" });
  }
  return result;
}
