/**
 * The service containers. FROZEN CONTRACT (owner: architect). Construction lives in plugin/container.ts (E1).
 *
 * Two tiers (H2, BG-IMPORT-UNWIRED):
 *  - BackgroundServices: built at onLayoutReady + 30 s idle WITHOUT Preact, three.js or the worker: settings,
 *    runner client, the agents clock (imports promptly so Claude Code's own cleanup never deletes an unimported
 *    session), the status bar item, throttled notices and the ledger reader. Runs whether or not a Cortex tab is
 *    open, and only after the first-run step (SAFE-11).
 *  - CortexServices: the UI tier, created on first view open; it REUSES the background instances.
 * Per leaf (H6): CortexView calls createLeaf() for its own store; the index, worker, runner, settings,
 * corrections and ledger are shared.
 */
import type { App } from "obsidian";
import type { ReadonlySignal } from "@preact/signals-core";
import type { Logger } from "../shared/log";
import type { CortexSettings, MigratedSettings } from "../shared/settings";
import type {
  ConversationRecord,
  CorrectionRecord,
  EntryRecord,
  IsoDate,
  LabelRecord,
  NoteKind,
  NoteRecord,
  ReceiptRecord,
  ReviewCardRecord,
  PinnedViewRecord,
  RunRecord,
  SourceKind,
  Speaker,
} from "../shared/types";
import type { EstimateResult, ImportResult, InspectResult, SourceSelector, WarningCode } from "../shared/protocol/runner";
import type { DeviceState } from "../ui/deviceState";
import type { EventBus } from "../state/events";
import type { CortexStore, SharedStore } from "../state/store";
import type { RendererPool } from "../render/rendererPool";
import type { AgentsClock } from "./agentsClock";
import type { AssistantExecutor } from "./aiExecutor";
import type { CorrectionService } from "./corrections";
import type { NegativeSaved, OutcomeInput, OutcomeList } from "../shared/outcomes";
import type { IndexService } from "./indexer";
import type { ResumeService } from "../shared/resume";
import type { NoticeService } from "./notices";
import type { ObsidianBridge } from "./obsidianBridge";
import type { RecordKeyAccess } from "../shared/crypto/access";
import type { CaptureService } from "../shared/capture";
import type { RunnerClient } from "./runnerClient";
import type { StatusBarService } from "./statusBar";
import type { WorkerClient } from "./workerClient";

// ───────────────────────────── settings ─────────────────────────────

export interface SettingsHandle {
  readonly value: CortexSettings;
  /** Every change (settings tab, commands, onExternalSettingsChange from OneDrive) is published here. */
  readonly signal: ReadonlySignal<CortexSettings>;
  /** SAFE-08: data.json could not be trusted; background work is off and saveData is blocked until resolved. */
  readonly corrupt: boolean;
  readonly issues: MigratedSettings["issues"];
  /** Replace the settings object (never mutate in place); writes `.data.json.bak` first, then data.json. */
  update(patch: (s: CortexSettings) => void): Promise<void>;
  /**
   * Show a patched copy of the settings without saving or announcing it (Showcase mode's colour themes); `endPreview`
   * puts the stored ones back. Any `update`, `reload` or `useDefaults` ends a preview first and works on the stored values.
   */
  preview?(patch: (s: CortexSettings) => void): void;
  endPreview?(): void;
  /** Re-read data.json (onExternalSettingsChange): reload → migrate → set. */
  reload(): Promise<void>;
  /** Replace unreadable settings with the defaults; keeps `.data.json.unreadable` first. No-op when not corrupt. */
  useDefaults(): Promise<void>;
}

// ───────────────────────────── record reader (E2: store/recordReader.ts) ─────────────────────────────

export type TextResult =
  | { ok: true; text: string; version: number }
  /** not-local = OneDrive Files-On-Demand has not downloaded the file; changed-at-source = sha mismatch. */
  | { ok: false; reason: "changed-at-source" | "not-local" | "missing" | "excluded" | "sample" };

export interface VersionInfo {
  version: number;
  at: IsoDate;
  /** "import" = the imported wording; corrections name who made them. */
  by: "import" | "you" | "ask";
  approvedByYou?: boolean;
  chars: number;
}

export interface LabelView {
  label: LabelRecord;
  /** Model run (pack, version, model, date, confidence) or your own correction. */
  byUser: boolean;
}

/** One row of the merged History list (ORIG-12): imported → labelled by haiku → corrected by you → read by sonnet. */
export interface HistoryItem {
  at: IsoDate;
  kind: "imported" | "labelled" | "summarised" | "corrected" | "read" | "excluded" | "included" | "version";
  model?: string;
  route?: string;
  version?: number;
  detail?: string;
}

export interface CitedByRow {
  id: string;
  kind: NoteKind;
  title: string;
  date?: IsoDate;
}

export interface EntryDetail {
  record: EntryRecord;
  text: TextResult;
  versions: VersionInfo[];
  labels: LabelView[];
  history: HistoryItem[];
  citedBy: CitedByRow[];
  /** From the reads cache (`reads.cxr`, E7): how many model calls read this entry. */
  reads: { count: number; models: string[]; last?: IsoDate; /** When each model call read it (the newest 200, oldest first): the read limit counts from these. */ at?: IsoDate[] };
  /** "Where it lives": store path and line or byte range. */
  storage: { path: string; line?: number; byteRange?: [number, number] };
  /** The frond scrubber: speaker per message of the conversation and this entry's position. */
  conversation?: { id: string; title: string; index: number; count: number; speakers: Speaker[] };
  /** Shared-term chips for Related ("trade 4 · slot 2"). */
  related: { term: string; count: number }[];
  /** Secret markers in the stored text (lock chip "secret kept on this computer"). */
  secrets: { marker: number; here: boolean }[];
  /** Date evidence rows for "How this date is known". */
  dateEvidence: { kind: "source" | "imported" | "git" | "sealed" | "timestamped"; at: IsoDate; strength: "strong" | "medium" | "bound" | "provable"; /** Sealed: the block number on this computer. */ block?: number; /** Timestamped: the Bitcoin block it was confirmed in, once checked. */ height?: number }[];
}

export interface CommentView {
  id: string;
  text: string;
  state: "waiting" | "answered";
  answeredAt?: IsoDate;
}

export interface CitationView {
  entryId: string;
  quote: string;
  speaker?: Speaker;
  date?: IsoDate;
  /** False when the cited version's text no longer contains the quote (shown, never hidden). */
  valid: boolean;
}

export interface NoteDetail {
  record: NoteRecord;
  cites: CitationView[];
  comments: CommentView[];
  /** Maps: member notes grouped by kind with counts and a 12-week activity sparkline. */
  members?: { kind: NoteKind; count: number; ids: string[] }[];
  activity?: number[];
  /** Evidence meter per brief bullet: quotes from you vs from the assistant (computed by Cortex). */
  evidence?: { you: number; assistant: number }[];
}

export interface ConversationDetail {
  record: ConversationRecord;
  gist?: NoteRecord;
  /** Frond nodes: time range, message span and the notes extracted from each part. */
  parts: { n: number; title?: string; startedAt?: IsoDate; endedAt?: IsoDate; msgFrom: number; msgTo: number; notes: NoteRecord[] }[];
  /** Your corrections, shown inline at the node they changed. */
  corrections: CorrectionRecord[];
  comments: CommentView[];
}

export interface RecordReader {
  entry(ordinal: number): Promise<EntryDetail>;
  note(ordinal: number): Promise<NoteDetail>;
  conversation(convId: string): Promise<ConversationDetail>;
  /** Verbatim text of an entry (current version unless `version` given). Never throws for missing text. */
  entryText(ordinal: number, version?: number): Promise<TextResult>;
  /** Markdown of a vault note for the peek (rendered by Obsidian's MarkdownRenderer: vault notes only). */
  noteMarkdown(ordinal: number): Promise<string>;
  /** Messages of a conversation for the Thread reader (200 at a time, Earlier / Later, §5.30.2). */
  conversationSlice(convId: string, from: number, to: number): Promise<{ ordinal: number; speaker: Speaker; text: TextResult }[]>;
  /**
   * "Show on this computer" (§5.30.7): the original line a secret marker replaced, read from
   * %LOCALAPPDATA%/cortex/<vaultKey>/held/ (never synced). null on another computer ("kept on another computer").
   */
  revealHeld(entryId: string, marker: number): Promise<string | null>;
}

// ───────────────────────────── ledger reader (E2: store/ledgerReader.ts) ─────────────────────────────

export interface AccessRow {
  model: string;
  /** e.g. "Claude Code → Anthropic". */
  route: string;
  itemsRead: number;
  first: IsoDate;
  last: IsoDate;
}

export interface BudgetDayView {
  day: string;
  tokens: number;
  /** API-equivalent dollars spent that day (the budget file's running total). */
  usd?: number;
  capped: boolean;
}

export interface AskExchange {
  askId: string;
  threadId: string;
  at: IsoDate;
  questionEntry: string;
  replyEntry: string;
  changes: ReceiptRecord[];
}

/** Agents page, Checks, Access log, change history and Ask history read through here (M4), backed by caches. */
export interface LedgerService {
  runs(filter: { job?: string; model?: string; status?: string; from?: IsoDate; to?: IsoDate; limit: number }): Promise<RunRecord[]>;
  budgetHistory(days: number): Promise<BudgetDayView[]>;
  /** Agents › Label packs: fields a model was asked about and left unanswered, per "pack@version" (current labels only). */
  packsUnanswered(): Promise<Record<string, number>>;
  accessLog(): Promise<AccessRow[]>;
  /** The entry and note ids a model read over one route (Agents › Access log › trace). At most 5,000 of each. */
  accessIds(model: string, route: string): Promise<{ entries: string[]; notes: string[] }>;
  checks(filter: { kind?: ReviewCardRecord["kind"] | "unsure"; limit: number }): Promise<ReviewCardRecord[]>;
  checksToday(): Promise<{ checked: number; waiting: number }>;
  /**
   * Agents › Work waiting: per queue and per source (checked by you, done, waiting), since the first import. Only what
   * the agents take counts as waiting; `leftAlone` names what they leave as it is (sessions with no message from the
   * person, notes from other sources), so neither the queue nor the Organised meter waits on it.
   */
  workWaiting(): Promise<{ since?: IsoDate; queues: { label: number; summaries: number; checks: number }; bySource: { source: string; checked: number; done: number; waiting: number }[]; leftAlone?: { sessions: number; notes: number } }>;
  changes(range: { from?: IsoDate; to?: IsoDate }): Promise<ReceiptRecord[]>;
  askHistory(range: { from?: IsoDate; to?: IsoDate }): Promise<AskExchange[]>;
  /** Drop cached aggregates after a cache signal. */
  invalidate(): void;
}

// ───────────────────────────── per-device state, sources, new entries, pinned views ─────────────────────────────

/** One-time hints and the first-run checklist (ui/deviceState.ts; app.saveLocalStorage, never synced). */
export interface DeviceHandle {
  readonly value: DeviceState;
  readonly signal: ReadonlySignal<DeviceState>;
  update(fn: (s: DeviceState) => DeviceState): void;
}

/** One row of Sources › Sources and of Add sources (§5.22, §5.26). */
export interface SourceRow {
  id: string;
  kind: SourceKind;
  status: "connected" | "watching" | "importing" | "imported" | "not-added" | "attention";
  items: number;
  /** Share of this source's words that are yours (0..1). */
  yourShare: number;
  lastImport?: IsoDate;
  /** Vault folder that holds the copies, e.g. ".raw/chats/claude-code/" (shown with "not tracked by git"). */
  storedIn: string;
  watching: boolean;
}
export interface FileRow {
  path: string;
  name: string;
  bytes: number;
  versions: number;
  state: "unchanged" | "changed";
  exportable: boolean;
}
export interface AttentionRow {
  code: WarningCode;
  count: number;
  detail?: string;
  action?: "show-details" | "show" | "fetch-now" | "export-diagnostics" | "rebuild-index";
}
/** Sources page and Add sources (plugin/sourcesService.ts, E3). Every action goes through the runner or corrections. */
export interface SourcesService {
  list(): Promise<SourceRow[]>;
  files(): Promise<FileRow[]>;
  needsAttention(): Promise<AttentionRow[]>;
  /** First-run step: counts and the backlog estimate before anything is imported (runner import.estimate). */
  estimate(): Promise<EstimateResult>;
  inspect(file: string): Promise<InspectResult>;
  /** Import one source now and report what happened (counts, secrets held, skips). */
  importNow(source: SourceSelector, onProgress?: (p: { done: number; total?: number; kept?: number }) => void): Promise<ImportResult>;
  /** "Ask per file" in Add sources: the files of a chosen folder with these extensions. */
  listFolderFiles(root: string, extensions: readonly string[]): Promise<string[]>;
  saveFolderSpeakers(folderId: string, files: Record<string, "you" | "other">): Promise<void>;
  pauseWatching(id: string, paused: boolean): Promise<void>;
  /** Remove source… = stop watching + leave out everything it imported (nothing is deleted). */
  remove(id: string): Promise<void>;
  reveal(id: string): void;
  fetchNow(): Promise<void>;
  exportFile(path: string): Promise<void>;
}

/** New entry (§5.24): writes .raw/written/<yyyy>/<mm>/<yyyymmdd-HHmm>-<slug>.md; Undo is an exclude fix. */
export interface NewEntryService {
  save(draft: { title: string; body: string; space?: string }): Promise<{ path: string; entryId: string }>;
  /** Per-leaf drafts saved every 2 s. */
  saveDraft(viewId: string, draft: { title: string; body: string; space?: string }): void;
  loadDraft(viewId: string): { title: string; body: string; space?: string } | null;
  clearDraft(viewId: string): void;
  /** How an accepted direction turned out: a dated entry of source "outcome" (shared/outcomes.ts). */
  saveOutcome(input: OutcomeInput, title: string): Promise<{ path: string; entryId: string }>;
  /** The outcomes saved so far and the notes in the negative-results folder. */
  listOutcomes(): Promise<OutcomeList>;
  /** Write a record-free note and its fingerprint to the local negative-results folder. Nothing is sent. */
  saveNegativeResult(req: { on: string; direction: string; text: string }): Promise<NegativeSaved>;
}

/** Pinned views (§7.4) in .vault-meta/cortex/views.json; links obsidian://cortex?view=<id> only navigate. */
export interface PinnedViewService {
  list(): Promise<PinnedViewRecord[]>;
  save(name: string, state: unknown): Promise<PinnedViewRecord>;
  remove(id: string): Promise<void>;
  get(id: string): Promise<PinnedViewRecord | undefined>;
}

// ───────────────────────────── containers ─────────────────────────────

export interface BackgroundServices {
  readonly app: App;
  readonly pluginDir: string;
  readonly pluginVersion: string;
  readonly vaultRoot: string;
  readonly vaultKey: string;
  /** Always %LOCALAPPDATA%/cortex/<vaultKey> (never a setting: SAFE-02). */
  readonly cacheDir: string;
  readonly settings: SettingsHandle;
  readonly bus: EventBus;
  readonly log: Logger;
  readonly shared: SharedStore;
  readonly runner: RunnerClient;
  readonly clock: AgentsClock;
  readonly status: StatusBarService;
  readonly notices: NoticeService;
  readonly ledger: LedgerService;
  /** Live capture (loopback receiver for the browser add-on). */
  readonly capture?: CaptureService;
}

export interface LeafServices {
  readonly viewId: string;
  readonly store: CortexStore;
  dispose(): void;
}

export interface CortexServices extends BackgroundServices {
  readonly index: IndexService;
  readonly worker: WorkerClient;
  readonly records: RecordReader;
  readonly corrections: CorrectionService;
  readonly assistant: AssistantExecutor;
  readonly renderers: RendererPool;
  readonly colours: ColourSlotService;
  readonly bridge: ObsidianBridge;
  readonly device: DeviceHandle;
  readonly sources: SourcesService;
  readonly newEntry: NewEntryService;
  readonly pinnedViews: PinnedViewService;
  /** Your resume (Add sources): kept apart from the record, checked claim by claim against it. */
  readonly resume?: ResumeService;
  /** The newest open Cortex view's state, for what opens a page from outside a view (Add sources from a command). */
  readonly leafStore?: () => CortexStore | undefined;
  /** Save a file the person asked for (system dialog or Downloads); resolves to the written path, or null if cancelled. */
  save(req: { suggestedName: string; mime: string; data: Uint8Array | string }): Promise<string | null>;
  /** Export diagnostics (Settings > Advanced, and the banner when the background worker is off): works without the runner; resolves to the written path, or null if cancelled. */
  exportDiagnostics(): Promise<string | null>;
  /** M13: the sample record is showing; corrections, changes, New entry, importers and agents refuse. */
  readonly sandbox: ReadonlySignal<boolean>;
  /** The record's key material (passphrase envelope, this Windows account's sealed copy); what the lock card and Settings > Lock use. */
  readonly recordKeys?: RecordKeyAccess;
  createLeaf(viewId: string): LeafServices;
}

export type SlotMap = Record<string, Record<string, number>>;

export interface ColourSlotService {
  current(): SlotMap;
  /** Read colours.json into memory (call once at start; `current()` is synchronous). */
  load?(): Promise<SlotMap>;
  /** Merge slots the worker assigned (never reassigns an existing value). */
  merge(newSlots: SlotMap): Promise<void>;
  /** Drop one dimension's slots (Settings › Appearance "Recolour groups"). */
  reset(dim: string): Promise<void>;
}
