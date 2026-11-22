/**
 * Agent jobs: what each job reads, asks, validates and writes. Owner: E6.
 *
 * | job        | input                                 | output                                       | role      | trigger                          |
 * | label      | one conversation or note (or batch)   | labels for enabled packs + a reason          | labels    | new/changed, debounced 5 min     |
 * | gist       | one conversation + its open comments  | summary frond (gist, facets, parts + notes)  | summaries | conversation idle 30 min / ended |
 * | hub        | a map's member notes + open comments  | map brief (3–5 cited bullets)                | maps      | nightly, or members change > 10% |
 * | filing     | items with no area                    | Checks cards (suggestions, never applied)    | labels    | nightly / propose_filing         |
 * | name-check | names that mean you                   | mentions in other people's words             | labels    | on demand (Settings › Privacy)   |
 * | answer     | an Ask question                       | reply + citations + actions                  | ask       | interactive (`runAnswer`)        |
 *
 * Eligible targets (H11), the SAME set the work-remaining readout counts: never items flagged Excluded,
 * Reference, Automated or HiddenByDefault (subagent, harness, Ask history, tool) unless the matching setting or
 * Layers toggle makes them visible; never Ask history at all by default (stored-injection loop, SAFE-09).
 * Order: newest conversations first, then non-reference vault notes by layer (shallow first).
 *
 * Every job: select targets → read text (privacy policy + redaction, here in the runner) → append ReadRecord →
 * reserve budget → RunRecord(running) → engine (re-reading control.json first) → validate → write labels /
 * notes (notesWriter) / Checks cards → settle budget → RunRecord(final) → events.
 * `runJob` owns that whole sequence, including the budget reservation and both RunRecord lines; the scheduler
 * (E5) orders plans, applies concurrency, retries failed runs with back-off and maps error codes to engine states,
 * and must not reserve budget for a plan itself. Invalid output gets ONE repair call inside `runJob`.
 * Checks cards (M5): each label or gist run appends one ReviewCardRecord per target (kind label or note) with
 * confidence and the model's ≤ 140-character reason; with agents.reviewMode "hold" labels are written with
 * state "held" and do not count until confirmed.
 * Comments (M7): open comment corrections on a summary or its notes are passed to the next gist run as
 * constraints (on stdin), a new comment re-queues the gist, and the run must list what it answered in
 * addressedComments (stored on the NoteRecord, shown as waiting / answered in the reader).
 * Messages are never labelled individually (they inherit their conversation's labels).
 *
 * Data access: one catalogue of the ledgers (entries, conversations, notes, labels, runs, review cards and the
 * folded corrections) is built per runner request and kept coherent with this module's own writes; record text
 * is read per message through its TextRef (segments, verified `.raw/` byte ranges, the local stage) or taken from
 * the user's latest edit. Nothing here logs record text, prompts or model output (privacy).
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import type { CancelToken } from "../shared/cancel";
import { asCortexError, CortexError } from "../shared/errors";
import { featureOn } from "../shared/features";
import { conversationId, entryId as makeEntryId, isConversationId, isEntryId, isNoteId, machineNoteId, newLabelId, newReviewCardId, newRunId, wikiNoteId } from "../shared/ids";
import type { Logger } from "../shared/log";
import type { GistDoc, HubDoc } from "../shared/notesDoc";
import { ATOMIC_KINDS } from "../shared/notesDoc";
import { enabledModelPacks, SESSION_PACK } from "../shared/packs";
import type { AgentsRunArgs, AiAskArgs, AiAskResult, AiCandidate, RunnerErrorCode, RunnerEvent } from "../shared/protocol/runner";
import { scanSecrets } from "../shared/secrets";
import { DEFAULT_SETTINGS, isValidModelAlias, type CortexSettings, type ModelRole } from "../shared/settings";
import { sha256Hex } from "../shared/sha256";
import { SPACES, spaceOfWikiPath } from "../shared/spaces";
import { firstLineTitle, wordCount } from "../shared/text";
import { DAY_MS, parseIso } from "../shared/time";
import type {
  Citation,
  DirectionArm,
  ControlState,
  ConversationId,
  ConversationRecord,
  CorrectionId,
  CorrectionRecord,
  EntryId,
  EntryKind,
  EntryRecord,
  HubStatus,
  HubType,
  IsoDate,
  JobKind,
  LabelRecord,
  LabelValue,
  NoteId,
  NoteRecord,
  PackDef,
  ReadRecord,
  ReviewCardRecord,
  RunRecord,
  RunStatus,
  SegmentLine,
  SourceKind,
  SpaceId,
  Speaker,
  TextRef,
  VaultPath,
} from "../shared/types";
import { hubBodyText } from "../shared/types";
import { resolveInVault } from "../node/paths";
import { readControl as readControlFile, mayContinue } from "../store/control";
import { gistNotePath, mapNotePath, segmentDir, type StoreContext } from "../store/layout";
import type { LedgerStore } from "../store/ledger";
import { renderGistMarkdown, renderHubMarkdown, writeDerivedNote, type RenderedNote, type WriteOutcome } from "../store/notesWriter";
import { readText as readTextRef, SegmentCache, writeSegment as writeSegmentFile, type WriteSegmentArgs } from "../store/segments";
import { readStage } from "../store/stage";
import { cacheLayout } from "../store/layout";
import { readTermStats } from "../store/searchIndex";
import { budgetEvent, budgetStatus, cappedMessage, capsOf, reserveBudget, settleBudget, type BudgetDecision, type BudgetState } from "./budget";
import type { Engine, EngineResult, EngineUsage } from "./engine";
import { buildDirectionsPrompt, normaliseRequest, pickPlacebo, PASSAGE_CHARS, purposeTerms, rankPassages, RECORD_PASSAGES, RECORD_READ_LIMIT, relevance, validateDirectionsOutput, PLACEBO_PASSAGE_COUNT, type DirectionCardProposal } from "./directions";
import { openGate, refusalMessage, type ReadGate } from "./grants";
import { effectiveOpenSpaces, inList, readerOfEngine, type Place } from "../shared/consent";
import { isOffLimits, policyFor, prepareForCloud, redact, type PrivacyPolicy } from "./privacy";
import { isRuleNote, ruleMapSpecs, ruleNoteFields, RULE_MODEL, ruleSessionFields, statsOfBatch, termCounts, type RuleField, type TermStats } from "./ruleLabels";
import {
  buildAnswerPrompt,
  buildFilingPrompt,
  buildGistPrompt,
  buildHubPrompt,
  buildLabelPrompt,
  buildNameCheckPrompt,
  excerpt,
  fitToBudget,
  JOB_EFFORT,
  promptChars,
  PROMPT_VERSIONS,
  PROMPT_LIMITS,
  repairPrompt,
  windowAround,
  type BuiltPrompt,
  type PromptItem,
} from "./prompts";
import { FILING_AREAS, type ConflictCardProposal, type FilingCardProposal, type LabelCardProposal, type MentionCardProposal, type NoteCardProposal } from "./schemas";
import {
  findQuote,
  injectionRejections,
  nameIn,
  validateAnswerOutput,
  validateFilingOutput,
  validateGistOutput,
  validateHubOutput,
  validateLabelOutput,
  validateNameCheckOutput,
  type CitedEntry,
  type LabelDraft,
  type Rejection,
  type ShownMessage,
  type ValidationContext,
} from "./validators";

// ───────────────────────────── context and plans ─────────────────────────────

/** Why the scheduler runs, and which jobs or targets it was asked for (AgentsRunArgs, the queue). */
export interface JobTrigger {
  reason: AgentsRunArgs["reason"];
  /** Jobs named explicitly (name-check and filing only run when named, or at the nightly pass for filing). */
  jobs?: readonly JobKind[];
  /** Explicit targets ("refresh this week", propose_filing, Checks re-runs): eligibility still applies. */
  targets?: readonly string[];
  /** A direction trial's purpose and arms (jobs ["directions"]; set by the scheduler from the run request). */
  experiment?: { purpose: string; arms: readonly DirectionArm[] };
}

/** Store functions a job uses. Defaults are the real store; tests and special transports may substitute some. */
export interface JobIo {
  readText(ref: TextRef, sha: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  writeNote(note: RenderedNote, expectedOwnedSha: string | undefined): Promise<WriteOutcome>;
  writeSegment(args: WriteSegmentArgs): Promise<{ path: VaultPath; seq: number; bytes: number }>;
  readControl(): Promise<ControlState>;
  reserve(callId: string, estimate: number): Promise<BudgetDecision>;
  settle(callId: string, usage: EngineUsage | null, startedCall: boolean): Promise<BudgetState>;
  /** A vault file as text (wiki notes), null when missing. */
  readVaultFile(rel: VaultPath): Promise<string | null>;
  /** Markdown notes under wiki/ that may be agent material (derived notes and generated scaffolding excluded). */
  listWikiNotes(): Promise<WikiNoteFile[]>;
}

export interface WikiNoteFile {
  path: VaultPath;
  mtimeMs: number;
  size: number;
}

export interface JobContext {
  engine: Engine;
  ledger: LedgerStore;
  store: StoreContext;
  settings: CortexSettings;
  /** privacyRev the run started with (control.json); a different value abandons the job (SAFE-03). */
  privacyRev: number;
  token: CancelToken;
  log: Logger;
  emit(event: RunnerEvent): void;
  trigger?: JobTrigger;
  /** Who started the work, recorded on every ReadRecord (default "plugin"). */
  origin?: "plugin" | "skill";
  /** Which settings the run used, recorded on every RunRecord. */
  settingsSource?: RunRecord["settingsSource"];
  /** Plugin version recorded on every RunRecord (set by the scheduler). */
  pluginVersion?: string;
  /** Pass deadline (epoch ms), when bounded (set by the scheduler). */
  deadline?: number;
  /** Prompt version per job (RunRecord.promptVersion; set by the scheduler). */
  promptVersions?: Readonly<Record<JobKind, string>>;
  /** Clock (tests); Date.now by default. */
  now?: () => number;
  io?: Partial<JobIo>;
}

export interface JobPlan {
  job: JobKind;
  /** Conversation/note ids handled in one engine call (label jobs batch small conversations). */
  targets: string[];
  model: string;
  estimateTokens: number;
  priority: number;
  /** Direction trials: what this one run asks and what its arm gives the model (`targets` is just ["arm:<arm>"]). */
  experiment?: { purpose: string; arm: DirectionArm };
}

/** Map recency from its newest member vs the user's newest entry: ≤30 d active, ≤120 d quiet (UI: cooling), else paused (UI: dormant). */
export function hubStatus(newestMemberMs: number, newestEntryMs: number): HubStatus {
  const days = (newestEntryMs - newestMemberMs) / 86_400_000;
  if (days <= 30) return "active";
  if (days <= 120) return "quiet";
  return "paused";
}

// ───────────────────────────── tunables ─────────────────────────────

/** Debounce before a changed conversation is relabelled. */
export const LABEL_DEBOUNCE_MS = 5 * 60_000;
/** A conversation is summarised once it has been quiet this long. */
export const GIST_IDLE_MS = 30 * 60_000;
/** Conversations or notes in one label call. */
export const LABEL_BATCH_MAX = 8;
/** Items in one filing call / one name-check call. */
export const FILING_BATCH_MAX = 40;
export const NAME_CHECK_BATCH_MAX = 30;
/** "Other" entries scanned locally for your names per selection. */
export const NAME_SCAN_MAX = 3_000;
/** A target whose last three runs failed is not selected again until it changes or is asked for. */
export const MAX_FAILED_RUNS = 3;
/** Filing is not proposed again for an item that got a filing check within this window. */
export const FILING_REPROPOSE_MS = 30 * DAY_MS;
/** Thresholds for maps (members are atomic notes from summaries). */
export const MAP_RULES = {
  project: { conversations: 2, members: 4 },
  area: { conversations: 2, members: 6 },
  topic: { conversations: 3, members: 5 },
  /** Most maps of one kind (largest first). */
  perKind: 40,
  /** Members in one prompt (newest first). */
  promptMembers: 150,
  /** Passages in one prompt. */
  promptPassages: 120,
  /** A member set that changed by more than this share is refreshed outside the nightly pass. */
  changeShare: 0.1,
} as const;
/** Expected output tokens per call, added to Cortex's input estimate. */
const EXPECTED_OUTPUT: Readonly<Record<JobKind, number>> = { label: 160, gist: 1_600, hub: 800, filing: 60, "name-check": 40, answer: 700, directions: 450 };
/** Per-target output for a label batch. */
const LABEL_OUTPUT_PER_TARGET = 140;
const ROLE_OF_JOB: Readonly<Record<JobKind, ModelRole>> = { label: "labels", gist: "summaries", hub: "maps", filing: "labels", "name-check": "labels", answer: "ask", directions: "ask" };
/** A catalogue is rebuilt when the ledger moved on and it is older than this. */
const DATA_MAX_AGE_MS = 60_000;

/** Cortex's own token estimate: ≈ 3.5 characters per token plus the expected output. */
export function estimateCallTokens(chars: number, job: JobKind, outputTokens = EXPECTED_OUTPUT[job]): number {
  return Math.ceil(chars / 3.5) + outputTokens;
}

/** The model alias for a job, validated (a malformed alias falls back to the default for its role). */
export function modelFor(job: JobKind, settings: CortexSettings): string {
  // No model: the rules do the work and the run record says so. The Codex CLI picks its own model unless one is named.
  if (settings.agents.engine === "none") return RULE_MODEL;
  if (settings.agents.engine === "codex-cli") return isValidModelAlias(settings.agents.codex.model) ? settings.agents.codex.model : "codex";
  const role = ROLE_OF_JOB[job];
  const m = settings.agents.models[role];
  return typeof m === "string" && isValidModelAlias(m) ? m : DEFAULT_SETTINGS.agents.models[role];
}

// ───────────────────────────── corrections (the user outranks models) ─────────────────────────────

export interface JobCorrections {
  /** target → scope; sources by kind; folders and projects by value. */
  excluded: Map<string, { scope: string; by: CorrectionId }>;
  excludedSources: Set<string>;
  excludedFolders: string[];
  excludedProjects: Set<string>;
  /** entry → latest active user version. */
  edits: Map<string, { version: number; text: string }>;
  speakers: Map<string, Speaker>;
  dates: Map<string, IsoDate | null>;
  /** `${target}|${pack}|${field}` → user value. */
  userLabels: Map<string, LabelValue>;
  refiles: Map<string, { space?: SpaceId; folder?: string[]; project?: string | null }>;
  /** target → comments (with their time, for "a new comment re-queues the summary"). */
  comments: Map<string, { id: CorrectionId; text: string; at: IsoDate; resolved: boolean }[]>;
}

/**
 * Fold the corrections log (the same rules as plugin/corrections.ts foldCorrections, which the runner cannot
 * import): an undo cancels what it names, an undo of an undo restores it, later corrections win.
 */
export function foldJobCorrections(records: readonly CorrectionRecord[]): JobCorrections {
  const undone = new Set<string>();
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i] as CorrectionRecord;
    if (undone.has(r.id)) continue;
    if (r.undoes) undone.add(r.undoes);
  }
  const c: JobCorrections = {
    excluded: new Map(),
    excludedSources: new Set(),
    excludedFolders: [],
    excludedProjects: new Set(),
    edits: new Map(),
    speakers: new Map(),
    dates: new Map(),
    userLabels: new Map(),
    refiles: new Map(),
    comments: new Map(),
  };
  const folderByCorrection = new Map<string, string>();
  const projectByCorrection = new Map<string, string>();
  for (const r of records) {
    if (undone.has(r.id) || r.undoes) continue;
    switch (r.action) {
      case "exclude": {
        const p = r.payload as CorrectionRecord<"exclude">["payload"];
        c.excluded.set(r.target, { scope: p.scope, by: r.id });
        if (p.scope === "source") c.excludedSources.add(p.sourceKind ?? r.target);
        if (p.scope === "folder") {
          const f = (p.folder ?? r.target).replace(/\\/g, "/");
          c.excludedFolders.push(f);
          folderByCorrection.set(r.id, f);
        }
        if (p.scope === "project") {
          const pr = (p.project ?? r.target).toLowerCase();
          c.excludedProjects.add(pr);
          projectByCorrection.set(r.id, pr);
        }
        break;
      }
      case "include": {
        const p = r.payload as CorrectionRecord<"include">["payload"];
        const ex = c.excluded.get(r.target);
        c.excluded.delete(r.target);
        const by = p.excludeCorrectionId ?? ex?.by;
        if (by !== undefined) {
          const f = folderByCorrection.get(by);
          if (f !== undefined) c.excludedFolders = c.excludedFolders.filter((x) => x !== f);
          const pr = projectByCorrection.get(by);
          if (pr !== undefined) c.excludedProjects.delete(pr);
        }
        c.excludedSources.delete(r.target);
        break;
      }
      case "edit-text": {
        const p = r.payload as CorrectionRecord<"edit-text">["payload"];
        const prev = c.edits.get(r.target);
        if (!prev || p.version >= prev.version) c.edits.set(r.target, { version: p.version, text: p.newText });
        break;
      }
      case "set-speaker":
        c.speakers.set(r.target, (r.payload as CorrectionRecord<"set-speaker">["payload"]).speaker);
        break;
      case "set-date":
        c.dates.set(r.target, (r.payload as CorrectionRecord<"set-date">["payload"]).writtenAt);
        break;
      case "set-label": {
        const p = r.payload as CorrectionRecord<"set-label">["payload"];
        c.userLabels.set(`${r.target}|${p.pack}|${p.field}`, p.value);
        break;
      }
      case "refile":
        c.refiles.set(r.target, r.payload as CorrectionRecord<"refile">["payload"]);
        break;
      case "comment": {
        const list = c.comments.get(r.target) ?? [];
        list.push({ id: r.id, text: (r.payload as CorrectionRecord<"comment">["payload"]).text, at: r.at, resolved: false });
        c.comments.set(r.target, list);
        break;
      }
      case "resolve-comment": {
        const p = r.payload as CorrectionRecord<"resolve-comment">["payload"];
        for (const list of c.comments.values()) for (const k of list) if (k.id === p.commentId) k.resolved = true;
        break;
      }
      default:
        break;
    }
  }
  return c;
}

// ───────────────────────────── the per-request catalogue ─────────────────────────────

/** What jobs need of an EntryRecord (the text itself is read per message through `text`). */
export interface EntryLite {
  id: EntryId;
  conv?: ConversationId;
  idx?: number;
  speaker: Speaker;
  speakerDetail?: string;
  hidden?: EntryRecord["hiddenByDefault"];
  at?: IsoDate;
  addedAt: IsoDate;
  text: TextRef;
  sha: string;
  chars: number;
  kind: EntryKind;
  source: SourceKind;
  title?: string;
  space: SpaceId;
  folder: string[];
  project?: string;
  /** The older version of the same source file this entry replaces (a vault note edited after its import). */
  supersedes?: EntryId;
}

export interface JobData {
  builtAt: number;
  seq: number;
  entries: Map<string, EntryLite>;
  /** Conversation → its entries in conversation order. */
  byConv: Map<string, EntryLite[]>;
  conversations: Map<string, ConversationRecord>;
  notes: Map<string, NoteRecord>;
  /** Conversation → its current summary note. */
  gistOf: Map<string, NoteRecord>;
  /** Conversation → its current atomic notes. */
  atomicOf: Map<string, NoteRecord[]>;
  /** `${target}|${pack}|${field}` → the latest label. */
  labels: Map<string, LabelRecord>;
  /** `${target}|${pack}@${version}` → when it was last labelled. */
  labelledAt: Map<string, IsoDate>;
  /** `${job}|${target}` → finish times of failed runs, oldest first. */
  failures: Map<string, IsoDate[]>;
  /** target → newest filing card time. */
  filingCards: Map<string, IsoDate>;
  /** entries that already have a mention card. */
  mentionCards: Set<string>;
  corrections: JobCorrections;
  /** Newest written date of any visible record entry (map recency). */
  newestEntryMs: number;
}

interface RunCache {
  data?: JobData;
  building?: Promise<JobData>;
  wiki?: Promise<WikiNoteLite[]>;
  segments: SegmentCache;
}

const CACHES = new WeakMap<LedgerStore, RunCache>();

function cacheOf(ctx: JobContext): RunCache {
  let c = CACHES.get(ctx.ledger);
  if (!c) {
    c = { segments: new SegmentCache(ctx.store.vaultRoot, 64) };
    CACHES.set(ctx.ledger, c);
  }
  return c;
}

const nowOf = (ctx: JobContext) => (ctx.now ? ctx.now() : Date.now());
const isoNow = (ctx: JobContext) => new Date(nowOf(ctx)).toISOString();

function toLite(e: EntryRecord): EntryLite {
  const l: EntryLite = { id: e.id, speaker: e.speaker, addedAt: e.addedAt, text: e.text, sha: e.textSha256, chars: e.chars, kind: e.kind, source: e.source, space: e.space, folder: e.folder ?? [] };
  if (e.conv !== undefined) l.conv = e.conv;
  if (e.idx !== undefined) l.idx = e.idx;
  if (e.speakerDetail !== undefined) l.speakerDetail = e.speakerDetail;
  if (e.hiddenByDefault !== undefined) l.hidden = e.hiddenByDefault;
  if (e.writtenAt !== undefined) l.at = e.writtenAt;
  if (e.title !== undefined) l.title = e.title;
  if (e.project !== undefined) l.project = e.project;
  if (e.supersedes !== undefined) l.supersedes = e.supersedes;
  return l;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

async function buildJobData(ctx: JobContext): Promise<JobData> {
  const seq = await ctx.ledger.seq();
  const entries = new Map<string, EntryLite>();
  const byConv = new Map<string, EntryLite[]>();
  let n = 0;
  for await (const e of ctx.ledger.readAll("entries")) {
    if (++n % 5_000 === 0) ctx.token.throwIfCancelled();
    if (!isObj(e) || typeof e.id !== "string" || entries.has(e.id) || !isObj(e.text)) continue;
    const lite = toLite(e);
    entries.set(e.id, lite);
    if (lite.conv) {
      const list = byConv.get(lite.conv) ?? [];
      list.push(lite);
      byConv.set(lite.conv, list);
    }
  }
  for (const list of byConv.values()) list.sort((a, b) => (a.idx ?? Number.MAX_SAFE_INTEGER) - (b.idx ?? Number.MAX_SAFE_INTEGER) || parseIso(a.at) - parseIso(b.at));

  const conversations = new Map<string, ConversationRecord>();
  for await (const c of ctx.ledger.readAll("conversations")) {
    if (!isObj(c) || typeof c.id !== "string") continue;
    const prev = conversations.get(c.id);
    if (!prev || (c.seq ?? 0) >= (prev.seq ?? 0)) conversations.set(c.id, c);
  }
  const notes = new Map<string, NoteRecord>();
  for await (const r of ctx.ledger.readAll("notes")) {
    if (!isObj(r) || typeof r.id !== "string") continue;
    const prev = notes.get(r.id);
    if (!prev || (r.seq ?? 0) >= (prev.seq ?? 0)) notes.set(r.id, r);
  }
  const labels = new Map<string, LabelRecord>();
  const labelledAt = new Map<string, IsoDate>();
  for await (const l of ctx.ledger.readAll("labels")) {
    if (!isObj(l) || typeof l.target !== "string") continue;
    trackLabel(labels, labelledAt, l);
  }
  const runs = new Map<string, RunRecord>();
  for await (const r of ctx.ledger.readAll("runs")) if (isObj(r) && typeof r.id === "string") runs.set(r.id, r);
  const failures = new Map<string, IsoDate[]>();
  for (const r of runs.values()) trackRun(failures, r);
  const filingCards = new Map<string, IsoDate>();
  const mentionCards = new Set<string>();
  for await (const v of ctx.ledger.readAll("review")) {
    if (!isObj(v) || typeof v.target !== "string") continue;
    trackCard(filingCards, mentionCards, v);
  }
  const corrections = foldJobCorrections(await ctx.ledger.readCorrections());
  const data: JobData = { builtAt: nowOf(ctx), seq, entries, byConv, conversations, notes, gistOf: new Map(), atomicOf: new Map(), labels, labelledAt, failures, filingCards, mentionCards, corrections, newestEntryMs: Number.NEGATIVE_INFINITY };
  indexNotes(data);
  for (const e of entries.values()) {
    if (!visibleForJobs(e, data, ctx.settings)) continue;
    const t = parseIso(effectiveDate(e, data));
    if (Number.isFinite(t) && t > data.newestEntryMs) data.newestEntryMs = t;
  }
  return data;
}

/** Suffix of the `labelledAt` key that remembers when the rules last labelled a target. */
const RULE_KEY = "#rule";

function trackLabel(labels: Map<string, LabelRecord>, labelledAt: Map<string, IsoDate>, l: LabelRecord): void {
  const key = `${l.target}|${l.pack}|${l.field}`;
  const prev = labels.get(key);
  if (!prev || l.at >= prev.at) labels.set(key, l);
  // A rule label (No model) never counts as "already labelled": the model still gets its turn. It has its own key.
  const vk = `${l.target}|${l.pack}@${l.packVersion}${"engine" in l.by && l.by.engine === "rule" ? RULE_KEY : ""}`;
  const at = labelledAt.get(vk);
  if (!at || l.at > at) labelledAt.set(vk, l.at);
}

function trackRun(failures: Map<string, IsoDate[]>, r: RunRecord): void {
  if (r.status !== "failed" || !Array.isArray(r.targets)) return;
  const at = r.finishedAt ?? r.startedAt;
  for (const t of r.targets) {
    const key = `${r.job}|${t}`;
    const list = failures.get(key) ?? [];
    if (!list.includes(at)) list.push(at);
    list.sort();
    failures.set(key, list);
  }
}

function trackCard(filingCards: Map<string, IsoDate>, mentionCards: Set<string>, v: ReviewCardRecord): void {
  if (v.kind === "filing") {
    const prev = filingCards.get(v.target);
    if (!prev || v.createdAt > prev) filingCards.set(v.target, v.createdAt);
  } else if (v.kind === "mention") mentionCards.add(v.target);
}

function indexNotes(data: JobData): void {
  data.gistOf.clear();
  data.atomicOf.clear();
  for (const n of data.notes.values()) {
    if (!n.conv || n.state !== "current") continue;
    if (n.kind === "gist") data.gistOf.set(n.conv, n);
    else if ((ATOMIC_KINDS as readonly string[]).includes(n.kind)) {
      const list = data.atomicOf.get(n.conv) ?? [];
      list.push(n);
      data.atomicOf.set(n.conv, list);
    }
  }
}

/** The catalogue for this request: built once, reused while fresh, kept coherent with this module's writes. */
export async function loadJobData(ctx: JobContext): Promise<JobData> {
  const cache = cacheOf(ctx);
  const cur = cache.data;
  if (cur && nowOf(ctx) - cur.builtAt < DATA_MAX_AGE_MS) return cur;
  if (cur && (await ctx.ledger.seq()) === cur.seq) {
    cur.builtAt = nowOf(ctx);
    return cur;
  }
  if (!cache.building) {
    cache.building = buildJobData(ctx).finally(() => {
      cache.building = undefined;
    });
  }
  const data = await cache.building;
  cache.data = data;
  return data;
}

/** Record our own writes in the catalogue so the next plan in the same request sees them. */
function noteWrites(data: JobData, w: { labels?: readonly LabelRecord[]; notes?: readonly NoteRecord[]; runs?: readonly RunRecord[]; cards?: readonly ReviewCardRecord[]; entries?: readonly EntryRecord[]; conversations?: readonly ConversationRecord[]; seq?: number }): void {
  for (const l of w.labels ?? []) trackLabel(data.labels, data.labelledAt, l);
  for (const r of w.runs ?? []) trackRun(data.failures, r);
  for (const v of w.cards ?? []) trackCard(data.filingCards, data.mentionCards, v);
  for (const e of w.entries ?? []) {
    if (data.entries.has(e.id)) continue;
    const lite = toLite(e);
    data.entries.set(e.id, lite);
    if (lite.conv) data.byConv.set(lite.conv, [...(data.byConv.get(lite.conv) ?? []), lite]);
  }
  for (const c of w.conversations ?? []) data.conversations.set(c.id, c);
  if (w.notes && w.notes.length > 0) {
    for (const n of w.notes) data.notes.set(n.id, n);
    indexNotes(data);
  }
  if (w.seq !== undefined) data.seq = w.seq;
}

// ───────────────────────────── eligibility ─────────────────────────────

function effectiveDate(e: EntryLite, data: JobData): IsoDate | undefined {
  const d = data.corrections.dates.get(e.id);
  return d === undefined ? e.at : (d ?? undefined);
}

function effectiveSpeaker(e: EntryLite, data: JobData): Speaker {
  return data.corrections.speakers.get(e.id) ?? e.speaker;
}

function folderExcluded(folder: readonly string[], excluded: readonly string[]): boolean {
  if (excluded.length === 0 || folder.length === 0) return false;
  const p = folder.join("/");
  return excluded.some((f) => p === f || p.startsWith(`${f.replace(/\/+$/, "")}/`));
}

/** An entry may be sent to a model by a job: not left out, not reference (unless allowed), not hidden traffic. */
export function visibleForJobs(e: EntryLite, data: JobData, settings: CortexSettings): boolean {
  const c = data.corrections;
  if (c.excluded.has(e.id) || (e.conv && c.excluded.has(e.conv)) || c.excludedSources.has(e.source)) return false;
  if (folderExcluded(e.folder, c.excludedFolders)) return false;
  if (e.project && c.excludedProjects.has(e.project.toLowerCase())) return false;
  switch (e.hidden) {
    case undefined:
      return true;
    case "tool":
      return e.source === "chatgpt" ? settings.sources.chatgpt.includeToolOutput : settings.sources.claudeCode.includeToolOutput;
    case "subagent":
      return settings.sources.claudeCode.includeSubagents;
    case "reference":
      return !settings.agents.skipReference;
    case "harness":
    case "automated":
    case "cortex-ask":
      return false;
  }
}

function conversationExcluded(conv: ConversationRecord, data: JobData): boolean {
  const c = data.corrections;
  if (c.excluded.has(conv.id) || c.excludedSources.has(conv.source)) return true;
  if (folderExcluded(conv.folder ?? [], c.excludedFolders)) return true;
  return conv.project !== undefined && c.excludedProjects.has(conv.project.toLowerCase());
}

/** The consent gate of the pass being planned, by settings object: advisory, so planning does not choose work a gate would refuse. */
const PLANNING = new WeakMap<CortexSettings, ReadGate>();

/** Visible messages of a conversation in order (empty when the conversation itself may not be a target). */
export function eligibleMessages(convId: string, data: JobData, settings: CortexSettings): EntryLite[] {
  const conv = data.conversations.get(convId);
  if (!conv || conv.source === "cortex-ask" || conversationExcluded(conv, data)) return [];
  const all = data.byConv.get(convId) ?? [];
  if (all.length > 0 && all.every((e) => e.hidden === "automated")) return [];
  // Planning only: while a pass is being planned, items the consent gate would refuse are not planned for (the read itself is gated again in readEntries).
  const planning = PLANNING.get(settings);
  const msgs = all.filter((e) => visibleForJobs(e, data, settings) && (planning === undefined || planning.check(e).ok));
  return msgs.some((e) => effectiveSpeaker(e, data) === "you") ? msgs : [];
}

function effectiveSpace(conv: ConversationRecord, data: JobData): SpaceId {
  return data.corrections.refiles.get(conv.id)?.space ?? conv.space;
}

function lastActivityMs(conv: ConversationRecord, msgs: readonly EntryLite[]): number {
  const times = [parseIso(conv.endedAt), parseIso(conv.updatedAt), ...msgs.slice(-3).map((m) => parseIso(m.addedAt))].filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : 0;
}

function recentlyFailed(data: JobData, job: JobKind, target: string, sinceIso: string | undefined): boolean {
  const list = data.failures.get(`${job}|${target}`) ?? [];
  const since = sinceIso ?? "";
  return list.filter((at) => at > since).length >= MAX_FAILED_RUNS;
}

function forcedTargets(ctx: JobContext): Set<string> | null {
  const t = ctx.trigger?.targets;
  return t && t.length > 0 ? new Set(t) : null;
}

function explicitlyAsked(ctx: JobContext, job: JobKind): boolean {
  return ctx.trigger?.jobs?.includes(job) ?? false;
}

// ───────────────────────────── vault notes (wiki/) ─────────────────────────────

export interface WikiNoteLite {
  id: NoteId;
  path: VaultPath;
  mtimeMs: number;
  title: string;
  status?: string;
  type?: string;
  layer?: number;
  space: SpaceId;
}

/** Folders under wiki/ that hold Cortex's own notes or generated scaffolding, never agent material. */
export const WIKI_SKIP_PREFIXES: readonly string[] = ["wiki/derived/", "wiki/brain/"];
const WIKI_SKIP_FILES = new Set(["wiki/Brain.md"]);

/** Minimal frontmatter reader for the keys jobs need (flat `key: value` lines). */
export function readFrontmatter(markdown: string): Record<string, string> {
  const text = markdown.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end < 0) return {};
  const out: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m || m[1] === undefined) continue;
    let v = (m[2] ?? "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Body of a note without its frontmatter. */
export function stripFrontmatter(markdown: string): string {
  const text = markdown.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return text;
  const after = text.indexOf("\n", end + 4);
  return after < 0 ? "" : text.slice(after + 1);
}

async function defaultListWikiNotes(ctx: JobContext): Promise<WikiNoteFile[]> {
  const root = ctx.store.vaultRoot;
  const exclude = ctx.settings.sources.vault.excludeFolders.map((f) => f.replace(/\\/g, "/"));
  const out: WikiNoteFile[] = [];
  const walk = async (rel: string): Promise<void> => {
    ctx.token.throwIfCancelled();
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = await fsp.readdir(path.join(root, ...rel.split("/")), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (d.name.startsWith(".")) continue;
      const child = `${rel}/${d.name}`;
      if (d.isDirectory()) {
        if (WIKI_SKIP_PREFIXES.some((p) => `${child}/`.startsWith(p)) || exclude.some((f) => `${child}/`.startsWith(f))) continue;
        await walk(child);
      } else if (d.isFile() && d.name.toLowerCase().endsWith(".md") && !WIKI_SKIP_FILES.has(child) && !exclude.some((f) => child.startsWith(f))) {
        try {
          const st = await fsp.stat(path.join(root, ...child.split("/")));
          out.push({ path: child, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // vanished between readdir and stat
        }
      }
    }
  };
  await walk("wiki");
  return out;
}

async function readHead(abs: string, bytes: number): Promise<string> {
  const fh = await fsp.open(abs, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

/** Vault notes with the frontmatter keys jobs need, cached for the request. */
export async function wikiNotes(ctx: JobContext): Promise<WikiNoteLite[]> {
  const all = await wikiNotesAll(ctx);
  const gate = await gateOf(ctx);
  // Consent: notes no live grant covers (or read as often as allowed) are not offered to a model.
  return gate.active ? all.filter((n) => gate.check({ id: n.id, space: n.space, folder: [] }).ok) : all;
}

async function wikiNotesAll(ctx: JobContext): Promise<WikiNoteLite[]> {
  const cache = cacheOf(ctx);
  if (!cache.wiki) {
    cache.wiki = (async () => {
      const files = await io(ctx).listWikiNotes();
      const out: WikiNoteLite[] = [];
      for (const [i, f] of files.entries()) {
        if (i % 200 === 0) ctx.token.throwIfCancelled();
        let fm: Record<string, string> = {};
        try {
          fm = readFrontmatter(await readHead(resolveInVault(ctx.store.vaultRoot, f.path), 4096));
        } catch {
          continue;
        }
        const layer = Number(fm.layer);
        // The same area the figure shows: your wiki folders (this request's settings) first, then the default table.
        const n: WikiNoteLite = { id: wikiNoteId(f.path), path: f.path, mtimeMs: f.mtimeMs, title: fm.title || path.posix.basename(f.path, ".md"), space: spaceOfWikiPath(f.path.slice("wiki/".length), ctx.settings.wikiAreas) };
        if (fm.status) n.status = fm.status.toLowerCase();
        if (fm.type) n.type = fm.type.toLowerCase();
        if (Number.isInteger(layer)) n.layer = layer;
        out.push(n);
      }
      return out;
    })();
  }
  return cache.wiki;
}

// ───────────────────────────── io ─────────────────────────────

function io(ctx: JobContext): JobIo {
  const o = ctx.io ?? {};
  const cache = cacheOf(ctx);
  return {
    readText:
      o.readText ??
      (async (ref, sha) =>
        readTextRef(ctx.store.vaultRoot, ref, sha, {
          cache: cache.segments,
          stage: async (conv, line) => {
            try {
              return (await readStage(ctx.store, conv))[line]?.line.text;
            } catch {
              return undefined;
            }
          },
        })),
    writeNote: o.writeNote ?? ((note, sha) => writeDerivedNote(ctx.store, note, sha)),
    writeSegment: o.writeSegment ?? ((args) => writeSegmentFile(ctx.store, args)),
    readControl: o.readControl ?? (() => readControlFile(ctx.store)),
    reserve: o.reserve ?? ((id, est) => reserveBudget(ctx.store, capsOf(ctx.settings), id, est)),
    settle: o.settle ?? ((id, usage, started) => settleBudget(ctx.store, id, usage, started)),
    readVaultFile:
      o.readVaultFile ??
      (async (rel) => {
        try {
          return await fsp.readFile(resolveInVault(ctx.store.vaultRoot, rel), "utf8");
        } catch {
          return null;
        }
      }),
    listWikiNotes: o.listWikiNotes ?? (() => defaultListWikiNotes(ctx)),
  };
}

/** Current wording of an entry (the user's latest edit, else the stored text) with its version. */
export async function currentText(ctx: JobContext, data: JobData, e: EntryLite): Promise<{ text: string; version: number } | null> {
  const edit = data.corrections.edits.get(e.id);
  if (edit) return { text: edit.text, version: edit.version };
  const r = await io(ctx).readText(e.text, e.sha);
  return r.ok ? { text: r.text, version: 1 } : null;
}

interface ShownEntry {
  lite: EntryLite;
  text: string;
  version: number;
  speaker: Speaker;
  date?: IsoDate;
}

const GATES = new WeakMap<JobContext, Promise<ReadGate>>();

/**
 * The consent gate of this run (agents/grants.ts): counts reads from the read log once, then answers per item. Quiet
 * (nothing is read from the log) when "Require a grant" and the read limit are both off, or when the plain-rules engine runs.
 */
export function gateOf(ctx: JobContext): Promise<ReadGate> {
  let g = GATES.get(ctx);
  if (!g) {
    g = openGate({ consent: ctx.settings.consent, userSpaces: ctx.settings.userSpaces, reader: readerOfEngine(ctx.engine.kind), now: nowOf(ctx), records: () => ctx.ledger.readAll("reads") });
    GATES.set(ctx, g);
  }
  return g;
}

async function readEntries(ctx: JobContext, data: JobData, list: readonly EntryLite[]): Promise<ShownEntry[]> {
  const out: ShownEntry[] = [];
  const gate = await gateOf(ctx);
  for (const [i, e] of list.entries()) {
    if (i % 50 === 0) ctx.token.throwIfCancelled();
    // Consent: an item no live grant covers, or that has been read as often as allowed, is not read at all.
    if (gate.active && !gate.take(e).ok) continue;
    const t = await currentText(ctx, data, e);
    if (!t || t.text.trim().length === 0) continue;
    const s: ShownEntry = { lite: e, text: t.text, version: t.version, speaker: effectiveSpeaker(e, data) };
    const d = effectiveDate(e, data);
    if (d !== undefined) s.date = d;
    out.push(s);
  }
  return out;
}

function promptItemOf(s: ShownEntry): PromptItem {
  const it: PromptItem = { id: s.lite.id, kind: "message", speaker: s.speaker, text: s.text };
  if (s.date) it.date = s.date.slice(0, 16).replace("T", " ");
  return it;
}

/** Apply the privacy policy (replies kept local, redaction of text and titles) to items bound for the model. */
function shield(items: readonly PromptItem[], policy: PrivacyPolicy): { items: PromptItem[]; redactions: number; withheld: number } {
  const p = prepareForCloud(
    items.map((it) => ({ ...it, speaker: it.speaker ?? ("other" as Speaker) })),
    policy,
  );
  const out = p.items.map((it, i): PromptItem => {
    const copy: PromptItem = { ...it };
    if (items[i]?.speaker === undefined) delete copy.speaker;
    return copy;
  });
  return { items: out, redactions: p.redactions, withheld: p.withheld };
}

function redactText(s: string, policy: PrivacyPolicy): { text: string; redactions: number } {
  return redact(s, policy);
}

function vctxOf(allowed: ReadonlySet<string>, shown: ReadonlyMap<string, CitedEntry>, userOwned: ReadonlySet<string> = new Set(), openComments?: ReadonlySet<string>): ValidationContext {
  const v: ValidationContext = { allowedIds: allowed, entryOf: async (id) => shown.get(id), userOwned };
  if (openComments) v.openComments = openComments;
  return v;
}

function citedOf(s: ShownEntry): CitedEntry {
  const c: CitedEntry = { text: s.text, speaker: s.speaker, version: s.version };
  if (s.date) c.date = s.date;
  return c;
}

// ───────────────────────────── target selection ─────────────────────────────

/** Pending, ELIGIBLE work for a job kind, newest first (reads ledgers + corrections; never calls a model). */
export async function selectTargets(job: JobKind, ctx: JobContext, limit: number): Promise<JobPlan[]> {
  if (limit <= 0) return [];
  const gate = await gateOf(ctx);
  if (gate.active) PLANNING.set(ctx.settings, gate);
  else PLANNING.delete(ctx.settings);
  const data = await loadJobData(ctx);
  const now = nowOf(ctx);
  switch (job) {
    case "label":
      return planLabels(ctx, data, limit, now);
    case "gist":
      return planGists(ctx, data, limit, now);
    case "hub":
      if (ctx.engine.kind === "rule") return featureOn("maps") || forcedTargets(ctx) !== null || explicitlyAsked(ctx, "hub") ? planRuleMaps(ctx, data, limit) : [];
      return featureOn("maps") || forcedTargets(ctx) !== null || explicitlyAsked(ctx, "hub") ? planMaps(ctx, data, limit) : [];
    case "filing":
      return ctx.trigger?.reason === "nightly" || explicitlyAsked(ctx, "filing") || forcedTargets(ctx) !== null ? planFiling(ctx, data, limit, now) : [];
    case "name-check":
      return explicitlyAsked(ctx, "name-check") ? planNameCheck(ctx, data, limit) : [];
    case "directions":
      return planDirections(ctx);
    case "answer":
      // Ask runs interactively through runAnswer (runner command ai.ask), never from the queue.
      return [];
  }
}

/** Plans for explicit targets (Ask refresh, propose_filing, Checks re-runs): eligibility applies, timing does not. */
export async function planTargets(job: JobKind, targets: readonly string[], ctx: JobContext, limit = 200): Promise<JobPlan[]> {
  return selectTargets(job, { ...ctx, trigger: { reason: ctx.trigger?.reason ?? "refresh", jobs: [job], targets } }, limit);
}

function labelPending(data: JobData, target: string, packs: readonly PackDef[], changedAt: string | undefined, rules = false): boolean {
  for (const p of packs) {
    if (p.fields.every((f) => data.corrections.userLabels.has(`${target}|${p.id}|${f.key}`))) continue;
    const key = `${target}|${p.id}@${p.version}`;
    const at = data.labelledAt.get(key);
    if (rules) {
      // No model: the rules only fill what no model has labelled, and look again when the target changed.
      if (at) continue;
      const ruled = data.labelledAt.get(`${key}${RULE_KEY}`);
      if (!ruled || (changedAt && changedAt > ruled)) return true;
      continue;
    }
    if (!at) return true;
    if (changedAt && changedAt > at) return true;
  }
  return false;
}

function convChars(msgs: readonly EntryLite[]): number {
  return msgs.reduce((n, m) => n + m.chars + 80, 0);
}

async function planLabels(ctx: JobContext, data: JobData, limit: number, now: number): Promise<JobPlan[]> {
  const forced = forcedTargets(ctx);
  const model = modelFor("label", ctx.settings);
  const rules = ctx.engine.kind === "rule";
  const plans: JobPlan[] = [];
  const convPacks = enabledModelPacks("conversation", ctx.settings.agents.enabledPacks);
  if (convPacks.length > 0) {
    const cands: { id: string; chars: number; t: number }[] = [];
    for (const conv of data.conversations.values()) {
      if (forced && !forced.has(conv.id)) continue;
      const msgs = eligibleMessages(conv.id, data, ctx.settings);
      if (msgs.length === 0) continue;
      const last = lastActivityMs(conv, msgs);
      if (!forced) {
        if (now - last < LABEL_DEBOUNCE_MS) continue;
        if (!labelPending(data, conv.id, convPacks, conv.updatedAt, rules)) continue;
        if (recentlyFailed(data, "label", conv.id, conv.updatedAt)) continue;
      }
      cands.push({ id: conv.id, chars: Math.min(convChars(msgs), PROMPT_LIMITS.labelTarget), t: parseIso(conv.endedAt ?? conv.startedAt ?? conv.updatedAt) || last });
    }
    cands.sort((a, b) => b.t - a.t);
    batch(cands, plans, limit, model, "label");
  }
  if (plans.length >= limit) return plans.slice(0, limit);
  const notePacks = enabledModelPacks("note", ctx.settings.agents.enabledPacks);
  if (notePacks.length > 0) {
    const notes = await wikiNotes(ctx);
    const cands: { id: string; chars: number; layer: number; t: number }[] = [];
    for (const n of notes) {
      if (forced && !forced.has(n.id)) continue;
      if (n.status === "reference" && ctx.settings.agents.skipReference) continue;
      if (data.corrections.excluded.has(n.id)) continue;
      const changed = new Date(n.mtimeMs).toISOString();
      if (!forced && !labelPending(data, n.id, notePacks, changed, rules)) continue;
      if (!forced && recentlyFailed(data, "label", n.id, changed)) continue;
      cands.push({ id: n.id, chars: 2_200, layer: n.layer ?? 99, t: n.mtimeMs });
    }
    cands.sort((a, b) => a.layer - b.layer || b.t - a.t);
    batch(cands, plans, limit, model, "label");
  }
  if (plans.length >= limit) return plans.slice(0, limit);
  // The vault's notes outside wiki/ (documents the vault-notes importer wrote): the same note packs, newest first, each
  // read through the consent gate like any entry. The rule organiser has no reading of them, so it leaves them.
  if (notePacks.length > 0 && !rules) {
    const cands: { id: string; chars: number; t: number }[] = [];
    for (const e of vaultDocuments(data, ctx.settings)) {
      if (forced && !forced.has(e.id)) continue;
      if (!forced && !labelPending(data, e.id, notePacks, e.addedAt, rules)) continue;
      if (!forced && recentlyFailed(data, "label", e.id, e.addedAt)) continue;
      cands.push({ id: e.id, chars: Math.min(e.chars, VAULT_DOC_CHARS) + 200, t: parseIso(e.at ?? e.addedAt) });
    }
    cands.sort((a, b) => b.t - a.t);
    batch(cands, plans, limit, model, "label");
  }
  return plans.slice(0, limit);
}

/** At most this much of a vault note goes to the label model (its head, as for wiki notes). */
const VAULT_DOC_CHARS = 2_000;

/**
 * The vault's notes outside wiki/ the agents may label: documents from the vault (source obsidian), current versions
 * only (an edited note's older entry is left), visible to jobs (not left out, not reference unless allowed) and, while
 * a pass is planned, ones the consent gate would read.
 */
export function vaultDocuments(data: JobData, settings: CortexSettings): EntryLite[] {
  const replaced = new Set<string>();
  for (const e of data.entries.values()) if (e.supersedes) replaced.add(e.supersedes);
  const planning = PLANNING.get(settings);
  const out: EntryLite[] = [];
  for (const e of data.entries.values()) {
    if (e.kind !== "document" || e.source !== "obsidian" || e.conv !== undefined || replaced.has(e.id)) continue;
    if (!visibleForJobs(e, data, settings) || (planning !== undefined && !planning.check(e).ok)) continue;
    out.push(e);
  }
  return out;
}

function batch(cands: readonly { id: string; chars: number }[], plans: JobPlan[], limit: number, model: string, job: JobKind): void {
  let cur: { ids: string[]; chars: number } = { ids: [], chars: 0 };
  const flush = () => {
    if (cur.ids.length === 0) return;
    plans.push({ job, targets: cur.ids, model, estimateTokens: estimateCallTokens(cur.chars + 2_500, job, LABEL_OUTPUT_PER_TARGET * cur.ids.length), priority: plans.length });
    cur = { ids: [], chars: 0 };
  };
  for (const c of cands) {
    if (plans.length >= limit) return;
    if (cur.ids.length >= LABEL_BATCH_MAX || (cur.ids.length > 0 && cur.chars + c.chars > PROMPT_LIMITS.labelBatch)) flush();
    if (plans.length >= limit) return;
    cur.ids.push(c.id);
    cur.chars += c.chars;
  }
  if (plans.length < limit) flush();
}

function openCommentsFor(data: JobData, targets: readonly string[], addressed: ReadonlySet<string>): { id: CorrectionId; text: string; at: IsoDate }[] {
  const out: { id: CorrectionId; text: string; at: IsoDate }[] = [];
  for (const t of targets) for (const k of data.corrections.comments.get(t) ?? []) if (!k.resolved && !addressed.has(k.id)) out.push({ id: k.id, text: k.text, at: k.at });
  return out;
}

function gistCommentTargets(data: JobData, convId: string): string[] {
  const gist = data.gistOf.get(convId);
  return [machineNoteId("gist", convId), ...(gist ? [gist.id] : []), ...(data.atomicOf.get(convId) ?? []).map((n) => n.id)];
}

function planGists(ctx: JobContext, data: JobData, limit: number, now: number): JobPlan[] {
  const forced = forcedTargets(ctx);
  const model = modelFor("gist", ctx.settings);
  const cands: { id: string; chars: number; t: number }[] = [];
  for (const conv of data.conversations.values()) {
    if (forced && !forced.has(conv.id)) continue;
    const msgs = eligibleMessages(conv.id, data, ctx.settings);
    if (msgs.length < 2) continue;
    const last = lastActivityMs(conv, msgs);
    const gist = data.gistOf.get(conv.id);
    if (!forced) {
      if (now - last < GIST_IDLE_MS) continue;
      const madeAt = gist && "at" in gist.madeBy ? gist.madeBy.at : undefined;
      const addressed = new Set<string>(gist?.addressedComments ?? []);
      const freshComments = openCommentsFor(data, gistCommentTargets(data, conv.id), addressed).some((k) => !madeAt || k.at > madeAt);
      const stale = !gist || !madeAt || conv.updatedAt > madeAt;
      if (!stale && !freshComments) continue;
      if (recentlyFailed(data, "gist", conv.id, conv.updatedAt)) continue;
    }
    cands.push({ id: conv.id, chars: Math.min(convChars(msgs), PROMPT_LIMITS.gist), t: parseIso(conv.endedAt ?? conv.startedAt ?? conv.updatedAt) || last });
  }
  cands.sort((a, b) => b.t - a.t);
  return cands.slice(0, limit).map((c, i) => ({ job: "gist" as const, targets: [c.id], model, estimateTokens: estimateCallTokens(c.chars + 3_500, "gist"), priority: i }));
}

// ───────────────────────────── maps ─────────────────────────────

export interface MapSpec {
  id: NoteId;
  hubType: HubType;
  key: string;
  title: string;
  space: SpaceId;
  members: NoteId[];
  conversations: ConversationId[];
  within?: NoteId;
}

function labelValueOf(data: JobData, target: string, pack: string, field: string): LabelValue | undefined {
  const user = data.corrections.userLabels.get(`${target}|${pack}|${field}`);
  if (user !== undefined) return user;
  const l = data.labels.get(`${target}|${pack}|${field}`);
  return l && l.state === "set" ? l.value : undefined;
}

/** The project a conversation belongs to: your label, else the session label, else the importer's project. */
export function conversationProject(data: JobData, conv: ConversationRecord): string | undefined {
  const refiled = data.corrections.refiles.get(conv.id)?.project;
  if (refiled !== undefined) return refiled ?? undefined;
  const v = labelValueOf(data, conv.id, SESSION_PACK.id, "project");
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return conv.project;
}

/** Candidate maps from summarised conversations (projects, areas, topics) with their members. */
export function mapSpecs(data: JobData, settings: CortexSettings): MapSpec[] {
  type Acc = { key: string; titles: Map<string, number>; convs: Set<ConversationId>; members: NoteRecord[]; spaces: Map<SpaceId, number> };
  const acc: Record<HubType, Map<string, Acc>> = { project: new Map(), area: new Map(), topic: new Map() };
  const add = (type: HubType, raw: string, conv: ConversationRecord, space: SpaceId, notes: readonly NoteRecord[]) => {
    const key = raw.trim().toLowerCase();
    if (key.length === 0) return;
    const a: Acc = acc[type].get(key) ?? { key, titles: new Map(), convs: new Set(), members: [], spaces: new Map() };
    a.titles.set(raw.trim(), (a.titles.get(raw.trim()) ?? 0) + 1);
    if (!a.convs.has(conv.id)) {
      a.convs.add(conv.id);
      a.members.push(...notes);
    }
    a.spaces.set(space, (a.spaces.get(space) ?? 0) + 1);
    acc[type].set(key, a);
  };
  for (const [convId, notes] of data.atomicOf) {
    const conv = data.conversations.get(convId);
    if (!conv || notes.length === 0) continue;
    if (eligibleMessages(convId, data, settings).length === 0) continue;
    const space = effectiveSpace(conv, data);
    const project = conversationProject(data, conv);
    if (project) add("project", project, conv, space, notes);
    if (space !== "none") add("area", space, conv, space, notes);
    const topics = new Set<string>();
    const tl = labelValueOf(data, convId, SESSION_PACK.id, "topics");
    if (Array.isArray(tl)) for (const t of tl) topics.add(t);
    const gist = data.gistOf.get(convId);
    const ft = gist?.facets?.topics;
    if (Array.isArray(ft)) for (const t of ft) topics.add(t);
    for (const t of topics) add("topic", t, conv, space, notes);
  }
  const specs: MapSpec[] = [];
  const areaIds = new Map<string, NoteId>();
  for (const type of ["area", "project", "topic"] as const) {
    const rule = MAP_RULES[type];
    const list = [...acc[type].values()]
      .filter((a) => a.convs.size >= rule.conversations && a.members.length >= rule.members)
      .sort((a, b) => b.members.length - a.members.length || (a.key < b.key ? -1 : 1))
      .slice(0, MAP_RULES.perKind);
    for (const a of list) {
      const id = machineNoteId("hub", `${type}:${a.key}`);
      const space = [...a.spaces.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? "none";
      const title = type === "area" ? (SPACES.find((s) => s.id === a.key)?.area ?? a.key) : ([...a.titles.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? a.key);
      const members = [...new Set(a.members.map((m) => m.id))];
      const spec: MapSpec = { id, hubType: type, key: a.key, title, space, members, conversations: [...a.convs] };
      if (type === "area") areaIds.set(a.key, id);
      else if (type === "project" && areaIds.has(space)) spec.within = areaIds.get(space) as NoteId;
      specs.push(spec);
    }
  }
  return specs;
}

function memberChange(prev: readonly string[], next: readonly string[]): number {
  const a = new Set(prev);
  const b = new Set(next);
  let diff = 0;
  for (const x of a) if (!b.has(x)) diff++;
  for (const x of b) if (!a.has(x)) diff++;
  return diff / Math.max(1, a.size);
}

function planMaps(ctx: JobContext, data: JobData, limit: number): JobPlan[] {
  const forced = forcedTargets(ctx);
  const nightly = ctx.trigger?.reason === "nightly";
  const model = modelFor("hub", ctx.settings);
  const cands: { spec: MapSpec; score: number }[] = [];
  for (const spec of mapSpecs(data, ctx.settings)) {
    if (forced && !forced.has(spec.id)) continue;
    if (data.corrections.excluded.has(spec.id)) continue;
    const existing = data.notes.get(spec.id);
    const madeAt = existing && "at" in existing.madeBy ? existing.madeBy.at : undefined;
    const change = existing?.hub ? memberChange(existing.hub.members, spec.members) : 1;
    const flags = openCommentsFor(data, [spec.id], new Set(existing?.addressedComments ?? [])).some((k) => !madeAt || k.at > madeAt);
    if (!forced) {
      const due = !existing || existing.state !== "current" || change > MAP_RULES.changeShare || flags || (nightly && change > 0);
      if (!due) continue;
      if (recentlyFailed(data, "hub", spec.id, madeAt)) continue;
    }
    cands.push({ spec, score: flags ? 2 : change });
  }
  cands.sort((a, b) => b.score - a.score || b.spec.members.length - a.spec.members.length);
  return cands.slice(0, limit).map((c, i) => ({
    job: "hub" as const,
    targets: [c.spec.id],
    model,
    estimateTokens: estimateCallTokens(Math.min(c.spec.members.length * 420 + 4_000, PROMPT_LIMITS.hubNotes + PROMPT_LIMITS.hubQuotes), "hub"),
    priority: i,
  }));
}

// ───────────────────────────── filing and name check ─────────────────────────────

function planFiling(ctx: JobContext, data: JobData, limit: number, now: number): JobPlan[] {
  const forced = forcedTargets(ctx);
  const model = modelFor("filing", ctx.settings);
  const ids: { id: string; t: number }[] = [];
  for (const conv of data.conversations.values()) {
    if (forced && !forced.has(conv.id)) continue;
    if (effectiveSpace(conv, data) !== "none" || data.corrections.refiles.has(conv.id)) continue;
    if (eligibleMessages(conv.id, data, ctx.settings).length === 0) continue;
    const carded = data.filingCards.get(conv.id);
    if (!forced && carded && now - parseIso(carded) < FILING_REPROPOSE_MS) continue;
    ids.push({ id: conv.id, t: parseIso(conv.endedAt ?? conv.startedAt ?? conv.updatedAt) || 0 });
  }
  ids.sort((a, b) => b.t - a.t);
  const plans: JobPlan[] = [];
  for (let i = 0; i < ids.length && plans.length < limit; i += FILING_BATCH_MAX) {
    const chunk = ids.slice(i, i + FILING_BATCH_MAX).map((x) => x.id);
    plans.push({ job: "filing", targets: chunk, model, estimateTokens: estimateCallTokens(chunk.length * 700 + 2_000, "filing", 60 * chunk.length), priority: plans.length });
  }
  return plans;
}

/** Your names and handles, trimmed and de-duplicated (≥ 2 characters each). */
export function namesOf(settings: CortexSettings): string[] {
  const out: string[] = [];
  for (const n of [...settings.you.names, ...settings.you.handles]) {
    const t = n.trim();
    if (t.length >= 2 && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

async function planNameCheck(ctx: JobContext, data: JobData, limit: number): Promise<JobPlan[]> {
  const names = namesOf(ctx.settings);
  if (names.length === 0) return [];
  const forced = forcedTargets(ctx);
  const model = modelFor("name-check", ctx.settings);
  const others = [...data.entries.values()]
    .filter((e) => (!forced || forced.has(e.id)) && !data.mentionCards.has(e.id) && effectiveSpeaker(e, data) === "other" && visibleForJobs(e, data, ctx.settings) && !policyFor(e.source, ctx.settings).withholdAssistant)
    .sort((a, b) => parseIso(b.at ?? b.addedAt) - parseIso(a.at ?? a.addedAt))
    .slice(0, NAME_SCAN_MAX);
  const hits: string[] = [];
  for (const [i, e] of others.entries()) {
    if (i % 100 === 0) ctx.token.throwIfCancelled();
    const t = await currentText(ctx, data, e);
    if (t && nameIn(t.text, names) !== null) hits.push(e.id);
    if (hits.length >= limit * NAME_CHECK_BATCH_MAX) break;
  }
  const plans: JobPlan[] = [];
  for (let i = 0; i < hits.length && plans.length < limit; i += NAME_CHECK_BATCH_MAX) {
    const chunk = hits.slice(i, i + NAME_CHECK_BATCH_MAX);
    plans.push({ job: "name-check", targets: chunk, model, estimateTokens: estimateCallTokens(chunk.length * 800 + 1_500, "name-check", 40 * chunk.length), priority: plans.length });
  }
  return plans;
}

// ───────────────────────────── running a job ─────────────────────────────

class RunState {
  readonly run: RunRecord;
  private calls = 0;

  constructor(
    private readonly ctx: JobContext,
    job: JobKind,
    model: string,
    targets: readonly string[],
    promptVersion: string,
    pack?: string,
  ) {
    const startedAt = isoNow(ctx);
    this.run = {
      v: 1,
      id: newRunId(nowOf(ctx)),
      job,
      pass: 1,
      engine: ctx.engine.kind,
      model,
      where: ctx.engine.where,
      paidBy: ctx.engine.paidBy,
      startedAt,
      status: "running",
      targets: [...targets],
      items: targets.length,
      labels: 0,
      declined: 0,
      noAnswer: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      tokensEstimated: false,
      costUsd: 0,
      priceTableDate: startedAt.slice(0, 10),
      promptVersion,
      effort: JOB_EFFORT[job],
    };
    if (pack !== undefined) this.run.pack = pack;
    if (ctx.settingsSource !== undefined) this.run.settingsSource = ctx.settingsSource;
  }

  nextCallId(): string {
    this.calls++;
    return `${this.run.id}:${this.calls}`;
  }

  async start(): Promise<void> {
    await this.ctx.ledger.append("runs", [{ ...this.run }]);
    this.ctx.emit({ kind: "job-started", job: this.run.job, runId: this.run.id, targets: this.run.targets.length, model: this.run.model });
  }

  addUsage(u: EngineUsage | undefined, estimate: number): void {
    if (!u) {
      this.run.tokensIn += estimate;
      this.run.tokensEstimated = true;
      return;
    }
    this.run.tokensIn += u.inputTokens;
    this.run.tokensOut += u.outputTokens;
    this.run.tokensCacheRead += u.cacheReadTokens;
    this.run.tokensCacheWrite += u.cacheWriteTokens;
    this.run.costUsd += u.costUsd;
    if (u.estimated) this.run.tokensEstimated = true;
  }

  get tokens(): number {
    const r = this.run;
    return r.tokensIn + r.tokensOut + r.tokensCacheRead + r.tokensCacheWrite;
  }

  async finish(status: RunStatus, error?: { code: string; message: string }): Promise<RunRecord> {
    this.run.status = status;
    this.run.finishedAt = isoNow(this.ctx);
    if (error) this.run.error = error;
    const rec = { ...this.run, targets: [...this.run.targets] };
    try {
      await this.ctx.ledger.append("runs", [rec]);
    } catch (e) {
      this.ctx.log.error("could not record the run's result", { runId: rec.id, code: asCortexError(e).code });
    }
    this.ctx.emit({ kind: "job-finished", job: rec.job, runId: rec.id, status, tokens: this.tokens, costUsd: rec.costUsd });
    return rec;
  }
}

type CallOutcome = { ok: true; output: unknown; rawText: string; modelUsed: string } | { ok: false; status: RunStatus; error: { code: RunnerErrorCode; message: string; retryable: boolean }; rawText?: string };

interface ReadDraft {
  entryIds: EntryId[];
  noteIds: NoteId[];
  policy: string;
  redactions: number;
  withheld: number;
}

/** One engine call: kill switches, budget reservation, read log, the call, settlement and usage. */
async function callModel(ctx: JobContext, rs: RunState, built: BuiltPrompt, reads: ReadDraft, opts: { via: "job" | "ask"; timeoutMs: number; outputTokens: number; countsTowardCap: boolean }): Promise<CallOutcome> {
  const i = io(ctx);
  const control = await i.readControl();
  const may = mayContinue(control, ctx.privacyRev);
  if (!may.ok) {
    return { ok: false, status: "stopped", error: { code: "E_PAUSED", message: may.reason === "paused" ? "agents are paused" : "privacy settings changed during the run", retryable: false } };
  }
  if (ctx.token.cancelled) return { ok: false, status: "stopped", error: { code: "E_CANCELLED", message: "cancelled", retryable: false } };
  // Consent: every item in this call must have been taken from the gate (entries) or be covered now (notes).
  const gate = await gateOf(ctx);
  if (gate.active) {
    const wiki = reads.noteIds.length > 0 ? new Map((await wikiNotesAll(ctx)).map((n) => [n.id as string, n])) : new Map<string, WikiNoteLite>();
    const data = reads.noteIds.length > 0 ? await loadJobData(ctx) : null;
    const v = gate.assertRead([...reads.entryIds, ...reads.noteIds], (id): (Place & { id: string }) | undefined => {
      const n = wiki.get(id);
      if (n) return { id, space: n.space, folder: [] };
      // A note Cortex made sits where the conversation it was made from sits.
      const made = data?.notes.get(id);
      const conv = made?.conv ? data?.conversations.get(made.conv) : undefined;
      return data && conv ? { id, space: effectiveSpace(conv, data), folder: conv.folder ?? [] } : undefined;
    });
    if (!v.ok) return { ok: false, status: "stopped", error: { code: "E_PAUSED", message: refusalMessage(v.why), retryable: false } };
  }
  const estimate = estimateCallTokens(promptChars(built), rs.run.job, opts.outputTokens);
  const callId = rs.nextCallId();
  if (opts.countsTowardCap) {
    const d = await i.reserve(callId, estimate);
    if (!d.ok) return { ok: false, status: "capped", error: { code: "E_BUDGET_CAPPED", message: cappedMessage(d.block), retryable: false } };
  }
  const read: ReadRecord = {
    v: 1,
    runId: rs.run.id,
    model: rs.run.model,
    engine: ctx.engine.kind,
    where: ctx.engine.where,
    entryIds: reads.entryIds,
    noteIds: reads.noteIds,
    policy: reads.policy,
    chars: promptChars(built),
    redactions: reads.redactions,
    withheld: reads.withheld,
    via: opts.via,
    origin: ctx.origin ?? "plugin",
    promptVersion: built.version,
    at: isoNow(ctx),
  };
  const grantIds = gate.active ? gate.grantsFor([...reads.entryIds, ...reads.noteIds]) : [];
  if (grantIds.length > 0) read.grants = grantIds;
  let res: EngineResult;
  let started = false;
  try {
    await ctx.ledger.append("reads", [read]);
    if (gate.active) gate.logged(read);
    started = true;
    res = await ctx.engine.run({
      runId: rs.run.id,
      job: rs.run.job,
      model: rs.run.model,
      system: built.system,
      prompt: built.prompt,
      schema: built.schema,
      timeoutMs: opts.timeoutMs,
      maxUsd: ctx.settings.agents.perCallMaxUsd,
      effort: JOB_EFFORT[rs.run.job],
      signal: ctx.token.signal,
    });
  } catch (e) {
    const ce = asCortexError(e);
    res = { ok: false, error: { code: ce.toInfo().code, message: ce.message, retryable: ce.retryable }, durationMs: 0 };
  }
  if (opts.countsTowardCap) {
    try {
      const st = await i.settle(callId, res.usage ?? null, started);
      ctx.emit(budgetEvent(budgetStatus(st, capsOf(ctx.settings))));
    } catch (e) {
      ctx.log.warn("could not settle the budget", { runId: rs.run.id, code: asCortexError(e).code });
    }
  }
  rs.addUsage(res.usage, started ? estimate : 0);
  if (!res.ok) {
    const code = res.error.code;
    const status: RunStatus = code === "E_CANCELLED" || code === "E_PAUSED" ? "stopped" : code === "E_BUDGET_CAPPED" ? "capped" : "failed";
    const out: CallOutcome = { ok: false, status, error: res.error };
    if (res.rawText !== undefined) out.rawText = res.rawText;
    return out;
  }
  if (res.modelUsed && res.modelUsed !== rs.run.model) rs.run.model = res.modelUsed;
  return { ok: true, output: res.output, rawText: res.rawText, modelUsed: res.modelUsed || rs.run.model };
}

interface Validated<V> {
  value: V;
  modelUsed: string;
}

/** Call, validate, and repair once with Cortex's description of what was wrong. */
async function callValidated<V extends { valid: boolean; issues?: string }>(
  ctx: JobContext,
  rs: RunState,
  built: BuiltPrompt,
  reads: ReadDraft,
  validateOut: (output: unknown) => Promise<V>,
  opts: { via: "job" | "ask"; timeoutMs: number; outputTokens: number; countsTowardCap?: boolean },
): Promise<{ ok: true; result: Validated<V> } | { ok: false; status: RunStatus; error: { code: RunnerErrorCode; message: string; retryable: boolean }; rawText?: string }> {
  let prompt = built;
  let lastRaw: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await callModel(ctx, rs, prompt, reads, { via: opts.via, timeoutMs: opts.timeoutMs, outputTokens: opts.outputTokens, countsTowardCap: opts.countsTowardCap ?? true });
    if (!r.ok) {
      if (r.error.code === "E_VALIDATION" && attempt === 0) {
        lastRaw = r.rawText;
        prompt = repairPrompt(built, "the reply was not a JSON object");
        continue;
      }
      const fail: { ok: false; status: RunStatus; error: { code: RunnerErrorCode; message: string; retryable: boolean }; rawText?: string } = { ok: false, status: r.status, error: r.error };
      const raw = r.rawText ?? lastRaw;
      if (raw !== undefined) fail.rawText = raw;
      return fail;
    }
    lastRaw = r.rawText;
    const v = await validateOut(r.output);
    if (v.valid) return { ok: true, result: { value: v, modelUsed: r.modelUsed } };
    prompt = repairPrompt(built, v.issues ?? "the reply did not match the schema");
  }
  const fail: { ok: false; status: RunStatus; error: { code: RunnerErrorCode; message: string; retryable: boolean }; rawText?: string } = {
    ok: false,
    status: "failed",
    error: { code: "E_VALIDATION", message: "the model's reply did not match what Cortex can use, twice", retryable: false },
  };
  if (lastRaw !== undefined) fail.rawText = lastRaw;
  return fail;
}

function madeBy(rs: RunState, ctx: JobContext, model: string, pack?: string): Extract<NoteRecord["madeBy"], { runId: string }> {
  const m: Extract<NoteRecord["madeBy"], { runId: string }> = { runId: rs.run.id, model, engine: ctx.engine.kind, at: isoNow(ctx) };
  if (pack !== undefined) m.pack = pack;
  return m;
}

function injectionCard(ctx: JobContext, rs: RunState, target: string, kind: ReviewCardRecord["kind"], proposal: unknown, rejected: readonly Rejection[]): ReviewCardRecord | null {
  const inj = injectionRejections(rejected);
  if (inj.length === 0) return null;
  ctx.emit({ kind: "warning", code: "injection-signal", detail: { runId: rs.run.id, fields: inj.length } });
  return { v: 1, id: newReviewCardId(nowOf(ctx)), kind, target, proposal, model: rs.run.model, runId: rs.run.id, createdAt: isoNow(ctx) };
}

/** Execute one planned job end to end and return its final RunRecord. Never throws for model or data problems. */
export async function runJob(plan: JobPlan, ctx: JobContext): Promise<RunRecord> {
  const held: { rs?: RunState } = {};
  const track: Track = (r) => {
    held.rs = r;
  };
  try {
    const data = await loadJobData(ctx);
    switch (plan.job) {
      case "label":
        if (ctx.engine.kind === "rule") return await runRuleLabel(plan, ctx, data, track);
        return await runLabel(plan, ctx, data, track);
      case "gist":
        return await runGist(plan, ctx, data, track);
      case "hub":
        if (ctx.engine.kind === "rule") return await runRuleHub(plan, ctx, data, track);
        return await runHub(plan, ctx, data, track);
      case "filing":
        return await runFiling(plan, ctx, data, track);
      case "name-check":
        return await runNameCheck(plan, ctx, data, track);
      case "directions":
        return await runDirections(plan, ctx, data, track);
      case "answer": {
        const r = new RunState(ctx, "answer", plan.model, plan.targets, PROMPT_VERSIONS.answer);
        return await r.finish("failed", { code: "E_BAD_REQUEST", message: "Ask runs through the ai.ask command, not the queue" });
      }
    }
  } catch (e) {
    const ce = asCortexError(e);
    const state = held.rs ?? new RunState(ctx, plan.job, plan.model, plan.targets, PROMPT_VERSIONS[plan.job]);
    if (ce.code === "E_CANCELLED") return state.finish("stopped", { code: "E_CANCELLED", message: "cancelled" });
    ctx.log.error("job failed", { job: plan.job, code: ce.code });
    return state.finish("failed", { code: ce.toInfo().code, message: ce.message });
  }
}

/** A plan whose targets all became ineligible: nothing is sent and nothing is recorded. */
function skippedRun(ctx: JobContext, plan: JobPlan, version: string): RunRecord {
  const r = new RunState(ctx, plan.job, plan.model, plan.targets, version).run;
  return { ...r, status: "finished", finishedAt: r.startedAt, items: 0 };
}

type Track = (rs: RunState) => void;

// ───────────────────────────── label ─────────────────────────────

async function runLabel(plan: JobPlan, ctx: JobContext, data: JobData, track: Track): Promise<RunRecord> {
  const isConv = plan.targets.every((t) => isConversationId(t));
  const isDoc = !isConv && plan.targets.every((t) => data.entries.get(t)?.kind === "document");
  const packs = enabledModelPacks(isConv ? "conversation" : "note", ctx.settings.agents.enabledPacks);
  if (packs.length === 0) return skippedRun(ctx, plan, PROMPT_VERSIONS.label);
  const targets: { id: string; title: string; items: PromptItem[]; kind: "conversation" | "note"; date?: string }[] = [];
  const shown = new Map<string, CitedEntry>();
  const reads: ReadDraft = { entryIds: [], noteIds: [], policy: "", redactions: 0, withheld: 0 };
  const policies = new Set<string>();
  if (isConv) {
    for (const id of plan.targets) {
      const conv = data.conversations.get(id);
      const msgs = eligibleMessages(id, data, ctx.settings);
      if (!conv || msgs.length === 0) continue;
      const entries = await readEntries(ctx, data, msgs);
      if (entries.length === 0) continue;
      const policy = policyFor(conv.source, ctx.settings);
      policies.add(policy.name);
      const fitted = fitToBudget(entries.map(promptItemOf), PROMPT_LIMITS.labelTarget, { you: 1200, other: 400, minYou: 200, minOther: 80 });
      const sh = shield(fitted, policy);
      const title = redactText(conv.title, policy);
      reads.redactions += sh.redactions + title.redactions;
      reads.withheld += sh.withheld;
      for (const it of sh.items) reads.entryIds.push(it.id as EntryId);
      for (const e of entries) shown.set(e.lite.id, citedOf(e));
      const t: (typeof targets)[number] = { id, title: title.text, items: sh.items, kind: "conversation" };
      if (conv.startedAt) t.date = conv.startedAt.slice(0, 10);
      targets.push(t);
    }
  } else if (isDoc) {
    // Vault notes outside wiki/: read through the consent gate (and logged) like any entry, the head of the note
    // without its frontmatter, redacted under its source's policy.
    const lites = plan.targets.map((t) => data.entries.get(t)).filter((e): e is EntryLite => e !== undefined && visibleForJobs(e, data, ctx.settings));
    for (const doc of await readEntries(ctx, data, lites)) {
      const body = excerpt(stripFrontmatter(doc.text).trim(), VAULT_DOC_CHARS);
      if (body.length === 0) continue;
      const policy = policyFor(doc.lite.source, ctx.settings);
      policies.add(policy.name);
      const r = redactText(body, policy);
      const title = redactText(doc.lite.title ?? doc.lite.folder.join("/"), policy);
      reads.redactions += r.redactions + title.redactions;
      reads.entryIds.push(doc.lite.id);
      targets.push({ id: doc.lite.id, title: title.text, items: [{ id: doc.lite.id, kind: "note-text", text: r.text }], kind: "note" });
    }
  } else {
    const notes = new Map((await wikiNotes(ctx)).map((n) => [n.id, n]));
    const policy = policyFor("obsidian", ctx.settings);
    policies.add(policy.name);
    for (const id of plan.targets) {
      const n = notes.get(id as NoteId);
      if (!n || data.corrections.excluded.has(id) || (n.status === "reference" && ctx.settings.agents.skipReference)) continue;
      const md = await io(ctx).readVaultFile(n.path);
      if (md === null) continue;
      const body = excerpt(stripFrontmatter(md).trim(), 2_000);
      const r = redactText(body, policy);
      const title = redactText(n.title, policy);
      reads.redactions += r.redactions + title.redactions;
      reads.noteIds.push(n.id);
      targets.push({ id, title: title.text, items: [{ id, kind: "note-text", text: r.text }], kind: "note" });
    }
  }
  if (targets.length === 0) return skippedRun(ctx, plan, PROMPT_VERSIONS.label);
  reads.policy = [...policies].join(", ");
  const built = buildLabelPrompt(packs, targets);
  const rs = new RunState(ctx, "label", plan.model, targets.map((t) => t.id), built.version, packs.map((p) => p.id).join("+"));
  track(rs);
  await rs.start();
  const userOwned = new Set<string>();
  for (const t of targets) for (const p of packs) for (const f of p.fields) if (data.corrections.userLabels.has(`${t.id}|${p.id}|${f.key}`)) userOwned.add(`${t.id}|${p.id}|${f.key}`);
  const out = await callValidated(ctx, rs, built, reads, (o) => validateLabelOutput(o, packs, vctxOf(built.allowedIds, shown, userOwned)), {
    via: "job",
    timeoutMs: ctx.settings.agents.perCallTimeoutSec * 1000,
    outputTokens: LABEL_OUTPUT_PER_TARGET * targets.length,
  });
  if (!out.ok) return rs.finish(out.status, { code: out.error.code, message: out.error.message });
  const v = out.result.value;
  // Targets the model skipped: every field unanswered, so the work-waiting count moves on (relabelled on change).
  const drafts: LabelDraft[] = [...v.labels];
  for (const t of targets) {
    if (v.targets.has(t.id)) continue;
    for (const p of packs) for (const f of p.fields) if (!userOwned.has(`${t.id}|${p.id}|${f.key}`)) drafts.push({ target: t.id as LabelDraft["target"], pack: p.id, packVersion: p.version, field: f.key, value: null, state: "unanswered" });
  }
  const hold = ctx.settings.agents.reviewMode === "hold";
  const at = isoNow(ctx);
  const by = { model: out.result.modelUsed, runId: rs.run.id, engine: ctx.engine.kind };
  const records: LabelRecord[] = drafts.map((d) => {
    const conv = data.conversations.get(d.target);
    const rec: LabelRecord = { v: 1, id: newLabelId(nowOf(ctx)), ...d, state: hold && d.state === "set" ? "held" : d.state, by, at };
    if (conv) rec.targetVersion = conv.seq;
    return rec;
  });
  const cards: ReviewCardRecord[] = [];
  for (const t of targets) {
    const mine = records.filter((r) => r.target === t.id);
    if (mine.length === 0) continue;
    const confs = mine.map((r) => r.confidence).filter((c): c is number => c !== undefined);
    const dropped = injectionRejections(v.rejected).filter((r) => r.target === t.id);
    for (const p of packs) {
      const fields = mine.filter((r) => r.pack === p.id);
      if (fields.length === 0) continue;
      const proposal: LabelCardProposal = {
        kind: "label",
        pack: p.id,
        version: p.version,
        fields: fields.map((r) => {
          const f: LabelCardProposal["fields"][number] = { field: r.field, value: r.value, state: r.state, labelId: r.id };
          if (r.confidence !== undefined) f.confidence = r.confidence;
          return f;
        }),
      };
      if (dropped.length > 0) proposal.dropped = dropped.map((d) => ({ path: d.path, signals: d.detail ?? "" }));
      const card: ReviewCardRecord = { v: 1, id: newReviewCardId(nowOf(ctx)), kind: "label", target: t.id, proposal, model: out.result.modelUsed, runId: rs.run.id, createdAt: at };
      if (confs.length > 0) card.confidence = Math.min(...confs);
      const why = v.reasons.get(t.id);
      if (why) card.reason = why;
      cards.push(card);
    }
  }
  if (injectionRejections(v.rejected).length > 0) ctx.emit({ kind: "warning", code: "injection-signal", detail: { runId: rs.run.id, fields: injectionRejections(v.rejected).length } });
  const seq = await ctx.ledger.append("labels", records);
  if (cards.length > 0) await ctx.ledger.append("review", cards);
  noteWrites(data, { labels: records, cards, seq });
  const set = records.filter((r) => r.state === "set" || r.state === "held").length;
  rs.run.labels = set;
  rs.run.declined = records.filter((r) => r.state === "refused").length;
  rs.run.noAnswer = records.filter((r) => r.state === "unanswered").length;
  ctx.emit({ kind: "labels-added", count: records.length, seq });
  if (cards.length > 0) ctx.emit({ kind: "review-cards", count: cards.length });
  return rs.finish(set > 0 ? "finished" : "nothing tagged");
}

// ───────────────────────────── no model: the rule organiser ─────────────────────────────

/** Prompt version of the rule organiser's run records ("what produced this"). */
const RULE_VERSION = "rule-1";
/** At most this much of a conversation's text is read for its topic words. */
const RULE_TEXT_CHARS = 8_000;
/** The opening words the kind-of-talk guess looks at. */
const RULE_OPENING_CHARS = 1_500;

/** Every record the rules wrote carries this "by", so screens can mark it and a model run can supersede it. */
function ruleBy(rs: RunState, ctx: JobContext): LabelRecord["by"] {
  return { model: RULE_MODEL, runId: rs.run.id, engine: ctx.engine.kind };
}

/** Words of each target ranked against the record's word counts (the local search index, else this batch). */
async function ruleStats(ctx: JobContext, counts: readonly ReadonlyMap<string, number>[]): Promise<TermStats | null> {
  const terms = new Set<string>();
  for (const c of counts) for (const w of c.keys()) terms.add(w);
  if (terms.size === 0) return null;
  const fromIndex = await readTermStats(ctx.store.cacheDir, terms).catch(() => null);
  return fromIndex ?? statsOfBatch(counts.map((c) => new Set(c.keys())));
}

/** Label job with no model: project, topics and a kind-of-talk guess for conversations; a role guess for notes. */
async function runRuleLabel(plan: JobPlan, ctx: JobContext, data: JobData, track: Track): Promise<RunRecord> {
  const isConv = plan.targets.every((t) => isConversationId(t));
  const packs = enabledModelPacks(isConv ? "conversation" : "note", ctx.settings.agents.enabledPacks).filter((p) => p.id === SESSION_PACK.id || p.id === "placement");
  if (packs.length === 0) return skippedRun(ctx, plan, RULE_VERSION);
  const targets: { id: string; fields: RuleField[] }[] = [];
  if (isConv) {
    const pending: { id: string; conv: ConversationRecord; opening: string; counts: Map<string, number> }[] = [];
    for (const id of plan.targets) {
      const conv = data.conversations.get(id);
      const msgs = eligibleMessages(id, data, ctx.settings);
      if (!conv || msgs.length === 0) continue;
      const entries = await readEntries(ctx, data, msgs);
      if (entries.length === 0) continue;
      const mine = entries.filter((e) => e.speaker === "you");
      const lead = (mine.length > 0 ? mine : entries)
        .slice(0, 3)
        .map((e) => e.text)
        .join("\n")
        .slice(0, RULE_OPENING_CHARS);
      const counts = termCounts(conv.title, new Map(), 3);
      let used = 0;
      for (const e of entries) {
        if (used >= RULE_TEXT_CHARS) break;
        const part = e.text.slice(0, RULE_TEXT_CHARS - used);
        termCounts(part, counts, e.speaker === "you" ? 2 : 1);
        used += part.length;
      }
      pending.push({ id, conv, opening: lead, counts });
    }
    const stats = await ruleStats(ctx, pending.map((p) => p.counts));
    for (const p of pending) targets.push({ id: p.id, fields: ruleSessionFields(p.conv, p.opening, p.counts, stats) });
  } else {
    const notes = new Map((await wikiNotes(ctx)).map((n) => [n.id, n]));
    for (const id of plan.targets) {
      const n = notes.get(id as NoteId);
      if (!n || data.corrections.excluded.has(id) || (n.status === "reference" && ctx.settings.agents.skipReference)) continue;
      targets.push({ id, fields: ruleNoteFields(n.path, n.title) });
    }
  }
  if (targets.length === 0) return skippedRun(ctx, plan, RULE_VERSION);
  const rs = new RunState(ctx, "label", RULE_MODEL, targets.map((t) => t.id), RULE_VERSION, packs.map((p) => p.id).join("+"));
  track(rs);
  await rs.start();
  const at = isoNow(ctx);
  const by = ruleBy(rs, ctx);
  const records: LabelRecord[] = [];
  for (const t of targets) {
    const conv = data.conversations.get(t.id);
    for (const p of packs) {
      for (const f of p.fields) {
        if (data.corrections.userLabels.has(`${t.id}|${p.id}|${f.key}`)) continue;
        // A model's answer stands: the rules only write where no model has.
        const cur = data.labels.get(`${t.id}|${p.id}|${f.key}`);
        if (cur && !("engine" in cur.by && cur.by.engine === "rule") && cur.state !== "unanswered") continue;
        const got = t.fields.find((x) => x.field === f.key);
        const rec: LabelRecord = {
          v: 1,
          id: newLabelId(nowOf(ctx)),
          target: t.id as LabelRecord["target"],
          pack: p.id,
          packVersion: p.version,
          field: f.key,
          value: got ? got.value : null,
          state: got ? "set" : "unanswered",
          by,
          at,
        };
        if (conv) rec.targetVersion = conv.seq;
        records.push(rec);
      }
    }
  }
  const seq = await ctx.ledger.append("labels", records);
  noteWrites(data, { labels: records, seq });
  const set = records.filter((r) => r.state === "set").length;
  rs.run.labels = set;
  rs.run.noAnswer = records.length - set;
  ctx.emit({ kind: "labels-added", count: records.length, seq });
  return rs.finish(set > 0 ? "finished" : "nothing tagged");
}

/** The maps the rules would write now: a project with enough conversations gets one listing their titles. */
function ruleMapPlans(ctx: JobContext, data: JobData): ReturnType<typeof ruleMapSpecs> {
  const items: { id: string; title: string; project: string | undefined; at: number; space: string }[] = [];
  for (const conv of data.conversations.values()) {
    if (eligibleMessages(conv.id, data, ctx.settings).length === 0) continue;
    const at = parseIso(conv.endedAt ?? conv.startedAt ?? conv.updatedAt);
    items.push({ id: conv.id, title: conv.title, project: conversationProject(data, conv), at: Number.isFinite(at) ? at : 0, space: effectiveSpace(conv, data) });
  }
  return ruleMapSpecs(items);
}

function ruleMapId(key: string): NoteId {
  return machineNoteId("hub", `project:${key}`);
}

/** A rule map is due when it is new or its titles changed; a map a model wrote, or one you left out, is never touched. */
function planRuleMaps(ctx: JobContext, data: JobData, limit: number): JobPlan[] {
  const plans: JobPlan[] = [];
  for (const spec of ruleMapPlans(ctx, data)) {
    const id = ruleMapId(spec.key);
    if (data.corrections.excluded.has(id)) continue;
    const existing = data.notes.get(id);
    if (existing && (!isRuleNote(existing) || existing.state !== "current")) continue;
    if (existing?.hub && existing.hub.brief.map((b) => b.text).join("\n") === spec.titles.join("\n")) continue;
    plans.push({ job: "hub", targets: [id], model: RULE_MODEL, estimateTokens: 0, priority: plans.length });
  }
  return plans.slice(0, limit);
}

/** Map job with no model: one project map listing the titles of its conversations, marked as a rule map. */
async function runRuleHub(plan: JobPlan, ctx: JobContext, data: JobData, track: Track): Promise<RunRecord> {
  const id = (plan.targets[0] ?? "") as NoteId;
  const spec = ruleMapPlans(ctx, data).find((s) => ruleMapId(s.key) === id);
  if (!spec || data.corrections.excluded.has(id)) return skippedRun(ctx, plan, RULE_VERSION);
  const existing = data.notes.get(id);
  if (existing && (!isRuleNote(existing) || existing.state !== "current")) return skippedRun(ctx, plan, RULE_VERSION);
  const rs = new RunState(ctx, "hub", RULE_MODEL, [id], RULE_VERSION);
  track(rs);
  await rs.start();
  const first = new Date(spec.from > 0 ? spec.from : nowOf(ctx)).toISOString();
  const last = new Date(spec.to > 0 ? spec.to : nowOf(ctx)).toISOString();
  const newestEntry = Number.isFinite(data.newestEntryMs) ? data.newestEntryMs : nowOf(ctx);
  const brief = spec.titles.map((text) => ({ text, cites: [] as Citation[] }));
  const doc: HubDoc = {
    id,
    hubType: "project",
    status: hubStatus(parseIso(last), newestEntry),
    title: spec.title,
    space: spec.space as SpaceId,
    range: [first, last],
    members: [],
    madeBy: madeBy(rs, ctx, RULE_MODEL),
    brief,
    addressedComments: [],
  };
  const filePath = existing?.file ?? mapNotePath("project", spec.title);
  const rendered = renderHubMarkdown(doc, filePath, []);
  const outcome = await io(ctx).writeNote(rendered, existing?.state === "current" ? existing.ownedSha256 : undefined);
  // A file you edited is left alone: the rules never ask for a check.
  if (!outcome.written) return rs.finish("finished");
  const rec: NoteRecord = {
    v: 1,
    id,
    seq: nextSeq(data, id),
    kind: "hub",
    title: spec.title,
    text: brief.map((b) => b.text).join("\n"),
    file: outcome.path,
    date: last,
    sources: [],
    madeBy: doc.madeBy,
    space: doc.space,
    folder: [],
    state: "current",
    hub: { hubType: "project", status: doc.status, range: doc.range, members: [], brief },
    addressedComments: [],
    ownedSha256: outcome.ownedSha256,
  };
  const seq = await ctx.ledger.append("notes", [rec]);
  noteWrites(data, { notes: [rec], seq });
  ctx.emit({ kind: "notes-written", paths: [outcome.path], seq });
  return rs.finish("finished");
}

// ───────────────────────────── summary ─────────────────────────────

/** Gist parts kept on the summary's NoteRecord (RFC E6-2: `NoteRecord.parts`; written as an extra field until then). */
export interface GistPartRecord {
  n: number;
  title: string;
  firstEntry: EntryId;
  lastEntry: EntryId;
  startedAt?: IsoDate;
  endedAt?: IsoDate;
  msgFrom: number;
  msgTo: number;
}

function nextSeq(data: JobData, id: string): number {
  return (data.notes.get(id)?.seq ?? 0) + 1;
}

function uniqueCites(list: readonly Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of list) {
    const k = `${c.entryId}\u0000${c.quote}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

async function runGist(plan: JobPlan, ctx: JobContext, data: JobData, track: Track): Promise<RunRecord> {
  const convId = plan.targets[0] ?? "";
  const conv = data.conversations.get(convId);
  const msgs = eligibleMessages(convId, data, ctx.settings);
  if (!conv || msgs.length === 0) return skippedRun(ctx, plan, PROMPT_VERSIONS.gist);
  const entries = await readEntries(ctx, data, msgs);
  if (entries.length < 2) return skippedRun(ctx, plan, PROMPT_VERSIONS.gist);
  const policy = policyFor(conv.source, ctx.settings);
  const fitted = fitToBudget(entries.map(promptItemOf), PROMPT_LIMITS.gist);
  const sh = shield(fitted, policy);
  const gistId = machineNoteId("gist", conv.id);
  const existing = data.notes.get(gistId);
  const addressed = new Set<string>(existing?.addressedComments ?? []);
  const comments = openCommentsFor(data, gistCommentTargets(data, conv.id), addressed);
  let redactions = sh.redactions;
  const shownComments = comments.map((k) => {
    const r = redactText(k.text, policy);
    redactions += r.redactions;
    return { id: k.id, text: r.text };
  });
  const title = redactText(conv.title, policy);
  redactions += title.redactions;
  const gp: Parameters<typeof buildGistPrompt>[0] = { id: conv.id, title: title.text, items: sh.items, openComments: shownComments };
  if (conv.startedAt) gp.date = conv.startedAt.slice(0, 10);
  const built = buildGistPrompt(gp);
  const shownIds = new Set(sh.items.map((it) => it.id));
  const shownEntries = entries.filter((e) => shownIds.has(e.lite.id));
  const cited = new Map(shownEntries.map((e) => [e.lite.id as string, citedOf(e)]));
  const messages: ShownMessage[] = shownEntries.map((e, i) => {
    const m: ShownMessage = { id: e.lite.id, idx: e.lite.idx ?? i };
    if (e.date) m.at = e.date;
    return m;
  });
  const rs = new RunState(ctx, "gist", plan.model, [conv.id], built.version);
  track(rs);
  await rs.start();
  const reads: ReadDraft = { entryIds: [...shownIds] as EntryId[], noteIds: [], policy: policy.name, redactions, withheld: sh.withheld };
  const out = await callValidated(ctx, rs, built, reads, (o) => validateGistOutput(o, vctxOf(built.allowedIds, cited, new Set(), new Set(comments.map((k) => k.id))), { conv: conv.id, messages, fallbackTitle: conv.title }), {
    via: "job",
    timeoutMs: ctx.settings.agents.perCallTimeoutSec * 1000,
    outputTokens: EXPECTED_OUTPUT.gist,
  });
  if (!out.ok) return rs.finish(out.status, { code: out.error.code, message: out.error.message });
  const v = out.result.value;
  const vdoc = v.doc;
  if (!vdoc) return rs.finish("failed", { code: "E_VALIDATION", message: "the summary had no usable parts" });
  const space = effectiveSpace(conv, data);
  const project = conversationProject(data, conv);
  const doc: GistDoc = { id: gistId, conv: conv.id, space, madeBy: madeBy(rs, ctx, out.result.modelUsed), ...vdoc, facets: { ...vdoc.facets, ...(project ? { project } : {}) } };
  const year = new Date(parseIso(doc.date) || nowOf(ctx)).getUTCFullYear();
  const filePath = existing?.file ?? gistNotePath(year, conv.id, doc.title);
  const rendered = renderGistMarkdown(doc, filePath);
  const outcome = await io(ctx).writeNote(rendered, existing?.state === "current" ? existing.ownedSha256 : undefined);
  const at = isoNow(ctx);
  const cards: ReviewCardRecord[] = [];
  const atomicCount = doc.parts.reduce((n, p) => n + p.notes.length, 0);
  if (!outcome.written && outcome.reason === "user-edited") {
    const proposal: ConflictCardProposal = { kind: "conflict", noteId: gistId, path: outcome.path, markdown: rendered.markdown.slice(0, 200_000) };
    cards.push({ v: 1, id: newReviewCardId(nowOf(ctx)), kind: "conflict", target: gistId, proposal, model: out.result.modelUsed, runId: rs.run.id, createdAt: at });
    await ctx.ledger.append("review", cards);
    noteWrites(data, { cards });
    ctx.emit({ kind: "review-cards", count: cards.length });
    return rs.finish("finished");
  }
  const notePath = outcome.path;
  const ownedSha256 = outcome.written ? outcome.ownedSha256 : rendered.ownedSha256;
  const folder = conv.folder ?? [];
  const parts: GistPartRecord[] = doc.parts.map((p, i) => {
    const span = v.spans[i];
    const r: GistPartRecord = { n: p.n, title: p.title, firstEntry: (span?.firstEntry ?? msgs[0]?.id) as EntryId, lastEntry: (span?.lastEntry ?? msgs[msgs.length - 1]?.id) as EntryId, msgFrom: p.msgFrom, msgTo: p.msgTo };
    if (p.startedAt) r.startedAt = p.startedAt;
    if (p.endedAt) r.endedAt = p.endedAt;
    return r;
  });
  const allCites = uniqueCites(doc.parts.flatMap((p) => p.notes.flatMap((n) => n.cites)));
  const gistRec: NoteRecord & { parts: GistPartRecord[] } = {
    v: 1,
    id: gistId,
    seq: nextSeq(data, gistId),
    kind: "gist",
    title: doc.title,
    text: doc.gist,
    file: notePath,
    sources: allCites,
    conv: conv.id,
    madeBy: doc.madeBy,
    space,
    folder,
    state: "current",
    facets: { ...(doc.facets.work ? { work: doc.facets.work } : {}), ...(doc.facets.outcome ? { outcome: doc.facets.outcome } : {}), ...(doc.facets.project ? { project: doc.facets.project } : {}), topics: doc.facets.topics },
    addressedComments: doc.addressedComments,
    ownedSha256,
    parts,
  };
  if (doc.date) gistRec.date = doc.date;
  const noteRecs: NoteRecord[] = [gistRec];
  const keep = new Set<string>();
  for (const p of doc.parts) {
    for (const n of p.notes) {
      keep.add(n.id);
      const rec: NoteRecord = {
        v: 1,
        id: n.id,
        seq: nextSeq(data, n.id),
        kind: n.kind,
        title: firstLineTitle(n.text, 80),
        text: n.text,
        file: notePath,
        blockId: n.blockId,
        sources: n.cites,
        parent: gistId,
        conv: conv.id,
        part: p.n,
        madeBy: doc.madeBy,
        space,
        folder,
        state: "current",
      };
      const d = n.cites.map((c) => c.date).filter((x): x is string => x !== undefined).sort()[0] ?? p.startedAt;
      if (d) rec.date = d;
      noteRecs.push(rec);
    }
  }
  for (const old of data.atomicOf.get(conv.id) ?? []) {
    if (keep.has(old.id)) continue;
    noteRecs.push({ ...old, seq: old.seq + 1, state: "superseded", supersededBy: gistId });
  }
  const proposal: NoteCardProposal = { kind: "note", noteId: gistId, conv: conv.id, title: doc.title, text: doc.gist, notes: atomicCount, dropped: v.droppedNotes };
  const card: ReviewCardRecord = { v: 1, id: newReviewCardId(nowOf(ctx)), kind: "note", target: gistId, proposal, model: out.result.modelUsed, runId: rs.run.id, createdAt: at };
  if (v.confidence !== undefined) card.confidence = v.confidence;
  if (v.reason) card.reason = v.reason;
  cards.push(card);
  const inj = injectionCard(ctx, rs, gistId, "note", { kind: "note", noteId: gistId, conv: conv.id, title: doc.title, text: doc.gist, notes: atomicCount, dropped: v.droppedNotes, injection: injectionRejections(v.rejected).map((r) => r.path) } satisfies NoteCardProposal, v.rejected);
  if (inj) cards.push(inj);
  const seq = await ctx.ledger.append("notes", noteRecs);
  await ctx.ledger.append("review", cards);
  noteWrites(data, { notes: noteRecs, cards, seq });
  ctx.emit({ kind: "notes-written", paths: [notePath], seq });
  ctx.emit({ kind: "review-cards", count: cards.length });
  return rs.finish("finished");
}

// ───────────────────────────── map ─────────────────────────────

const PASSAGE_PAD = 240;

async function runHub(plan: JobPlan, ctx: JobContext, data: JobData, track: Track): Promise<RunRecord> {
  const id = plan.targets[0] ?? "";
  const spec = mapSpecs(data, ctx.settings).find((s) => s.id === id);
  if (!spec || data.corrections.excluded.has(id)) return skippedRun(ctx, plan, PROMPT_VERSIONS.hub);
  const members = spec.members
    .map((m) => data.notes.get(m))
    .filter((n): n is NoteRecord => n !== undefined && n.state === "current")
    .sort((a, b) => parseIso(b.date) - parseIso(a.date));
  const shownMembers = members.slice(0, MAP_RULES.promptMembers);
  const general = policyFor("claude-code", ctx.settings);
  let redactions = 0;
  let withheld = 0;
  let notesChars = 0;
  const noteItems: PromptItem[] = [];
  for (const n of shownMembers) {
    if (notesChars > PROMPT_LIMITS.hubNotes) break;
    const r = redactText(excerpt(n.text, 300), general);
    redactions += r.redactions;
    const it: PromptItem = { id: n.id, kind: n.kind, text: r.text };
    if (n.date) it.date = n.date.slice(0, 10);
    noteItems.push(it);
    notesChars += r.text.length + 80;
  }
  // Passages: each cited entry once, as a window around the quotes its notes rest on.
  const wanted = new Map<string, string[]>();
  for (const n of shownMembers) for (const c of n.sources) if (!wanted.has(c.entryId) || (wanted.get(c.entryId)?.length ?? 0) < 3) wanted.set(c.entryId, [...(wanted.get(c.entryId) ?? []), c.quote]);
  const passages: PromptItem[] = [];
  const cited = new Map<string, CitedEntry>();
  let quoteChars = 0;
  for (const [eid, quotes] of wanted) {
    if (passages.length >= MAP_RULES.promptPassages || quoteChars > PROMPT_LIMITS.hubQuotes) break;
    const lite = data.entries.get(eid);
    if (!lite || !visibleForJobs(lite, data, ctx.settings)) continue;
    const [s] = await readEntries(ctx, data, [lite]);
    if (!s) continue;
    const policy = policyFor(lite.source, ctx.settings);
    if (policy.withholdAssistant && s.speaker !== "you") {
      withheld++;
      continue;
    }
    const windows = quotes
      .map((q) => findQuote(s.text, q))
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .map((m) => windowAround(s.text, m.start, m.end, PASSAGE_PAD));
    const text = s.text.length <= 1_200 ? s.text : windows.length > 0 ? windows.join(" … ") : excerpt(s.text, 600);
    const r = redactText(text, policy);
    redactions += r.redactions;
    const it: PromptItem = { id: eid, speaker: s.speaker, text: r.text };
    if (s.date) it.date = s.date.slice(0, 10);
    passages.push(it);
    cited.set(eid, citedOf(s));
    quoteChars += r.text.length + 80;
  }
  if (passages.length === 0) return skippedRun(ctx, plan, PROMPT_VERSIONS.hub);
  const existing = data.notes.get(spec.id);
  const comments = openCommentsFor(data, [spec.id], new Set(existing?.addressedComments ?? [])).map((k) => {
    const r = redactText(k.text, general);
    redactions += r.redactions;
    return { id: k.id, text: r.text };
  });
  const title = redactText(spec.title, general);
  const built = buildHubPrompt({ id: spec.id, hubType: spec.hubType, title: title.text, notes: noteItems, quotes: passages, comments });
  const rs = new RunState(ctx, "hub", plan.model, [spec.id], built.version);
  track(rs);
  await rs.start();
  const reads: ReadDraft = { entryIds: passages.map((p) => p.id as EntryId), noteIds: noteItems.map((n) => n.id as NoteId), policy: general.name, redactions: redactions + title.redactions, withheld };
  const out = await callValidated(ctx, rs, built, reads, (o) => validateHubOutput(o, vctxOf(built.allowedIds, cited, new Set(), new Set(comments.map((k) => k.id))), spec.hubType), {
    via: "job",
    timeoutMs: ctx.settings.agents.perCallTimeoutSec * 1000,
    outputTokens: EXPECTED_OUTPUT.hub,
  });
  if (!out.ok) return rs.finish(out.status, { code: out.error.code, message: out.error.message });
  const v = out.result.value;
  const dates = members.map((m) => parseIso(m.date)).filter(Number.isFinite);
  const first = dates.length > 0 ? new Date(Math.min(...dates)).toISOString() : isoNow(ctx);
  const last = dates.length > 0 ? new Date(Math.max(...dates)).toISOString() : isoNow(ctx);
  const newestEntry = Number.isFinite(data.newestEntryMs) ? data.newestEntryMs : nowOf(ctx);
  const doc: HubDoc = {
    id: spec.id,
    hubType: spec.hubType,
    status: hubStatus(parseIso(last), newestEntry),
    title: spec.title,
    space: spec.space,
    range: [first, last],
    members: spec.members,
    madeBy: madeBy(rs, ctx, out.result.modelUsed),
    brief: v.doc.brief,
    ...(v.doc.sections ? { sections: v.doc.sections } : {}),
    addressedComments: v.doc.addressedComments,
  };
  if (spec.within) doc.within = spec.within;
  const filePath = existing?.file ?? mapNotePath(spec.hubType, spec.title);
  const counts = new Map<string, number>();
  for (const m of members) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
  const rendered = renderHubMarkdown(doc, filePath, [...counts.entries()].map(([kind, count]) => ({ kind, count })));
  const outcome = await io(ctx).writeNote(rendered, existing?.state === "current" ? existing.ownedSha256 : undefined);
  const at = isoNow(ctx);
  if (!outcome.written && outcome.reason === "user-edited") {
    const proposal: ConflictCardProposal = { kind: "conflict", noteId: spec.id, path: outcome.path, markdown: rendered.markdown.slice(0, 200_000) };
    const cards: ReviewCardRecord[] = [{ v: 1, id: newReviewCardId(nowOf(ctx)), kind: "conflict", target: spec.id, proposal, model: out.result.modelUsed, runId: rs.run.id, createdAt: at }];
    await ctx.ledger.append("review", cards);
    noteWrites(data, { cards });
    ctx.emit({ kind: "review-cards", count: 1 });
    return rs.finish("finished");
  }
  const rec: NoteRecord = {
    v: 1,
    id: spec.id,
    seq: nextSeq(data, spec.id),
    kind: "hub",
    title: spec.title,
    text: doc.brief.map((b) => b.text).join("\n"),
    file: outcome.path,
    date: last,
    sources: uniqueCites([...doc.brief, ...Object.values(doc.sections ?? {}).flat()].flatMap((b) => b.cites)),
    madeBy: doc.madeBy,
    space: spec.space,
    folder: [],
    state: "current",
    hub: { hubType: spec.hubType, status: doc.status, range: doc.range, members: spec.members, brief: doc.brief, ...(doc.sections ? { sections: doc.sections } : {}), ...(spec.within ? { within: spec.within } : {}) },
    addressedComments: doc.addressedComments,
    ownedSha256: outcome.written ? outcome.ownedSha256 : rendered.ownedSha256,
  };
  const proposal: NoteCardProposal = { kind: "note", noteId: spec.id, mapKind: spec.hubType, title: spec.title, text: rec.text, notes: members.length, dropped: v.droppedStatements };
  const cards: ReviewCardRecord[] = [{ v: 1, id: newReviewCardId(nowOf(ctx)), kind: "note", target: spec.id, proposal, model: out.result.modelUsed, runId: rs.run.id, createdAt: at, ...(v.confidence !== undefined ? { confidence: v.confidence } : {}), ...(v.reason ? { reason: v.reason } : {}) }];
  const inj = injectionCard(ctx, rs, spec.id, "note", { ...proposal, injection: injectionRejections(v.rejected).map((r) => r.path) } satisfies NoteCardProposal, v.rejected);
  if (inj) cards.push(inj);
  const seq = await ctx.ledger.append("notes", [rec]);
  await ctx.ledger.append("review", cards);
  noteWrites(data, { notes: [rec], cards, seq });
  ctx.emit({ kind: "notes-written", paths: [outcome.path], seq });
  ctx.emit({ kind: "review-cards", count: cards.length });
  return rs.finish("finished");
}

// ───────────────────────────── filing ─────────────────────────────

async function runFiling(plan: JobPlan, ctx: JobContext, data: JobData, track: Track): Promise<RunRecord> {
  const items: PromptItem[] = [];
  const reads: ReadDraft = { entryIds: [], noteIds: [], policy: "", redactions: 0, withheld: 0 };
  const policies = new Set<string>();
  for (const id of plan.targets) {
    const conv = data.conversations.get(id);
    if (!conv || effectiveSpace(conv, data) !== "none") continue;
    const msgs = eligibleMessages(id, data, ctx.settings);
    if (msgs.length === 0) continue;
    const mine = msgs.filter((m) => effectiveSpeaker(m, data) === "you").slice(0, 2);
    const shown = await readEntries(ctx, data, mine);
    const policy = policyFor(conv.source, ctx.settings);
    policies.add(policy.name);
    const text = shown.map((s) => excerpt(s.text, 300)).join(" … ");
    const where = conv.meta?.cwd ? path.win32.basename(conv.meta.cwd.replace(/[\\/]+$/, "")) : undefined;
    const r = redactText(`${where ? `[folder: ${where}] ` : ""}${text}`, policy);
    const title = redactText(conv.title, policy);
    reads.redactions += r.redactions + title.redactions;
    for (const s of shown) reads.entryIds.push(s.lite.id);
    const it: PromptItem = { id, kind: "conversation", title: title.text, text: r.text };
    if (conv.startedAt) it.date = conv.startedAt.slice(0, 10);
    items.push(it);
  }
  if (items.length === 0) return skippedRun(ctx, plan, PROMPT_VERSIONS.filing);
  reads.policy = [...policies].join(", ");
  const known = new Set<string>();
  for (const c of data.conversations.values()) {
    const f = (c.folder ?? []).join("/");
    if (f.length > 0) known.add(f);
    if (known.size >= 80) break;
  }
  const built = buildFilingPrompt(items, FILING_AREAS, [...known]);
  const rs = new RunState(ctx, "filing", plan.model, items.map((i) => i.id), built.version);
  track(rs);
  await rs.start();
  const out = await callValidated(ctx, rs, built, reads, (o) => validateFilingOutput(o, vctxOf(built.allowedIds, new Map()), { knownFolders: known }), {
    via: "job",
    timeoutMs: ctx.settings.agents.perCallTimeoutSec * 1000,
    outputTokens: 60 * items.length,
  });
  if (!out.ok) return rs.finish(out.status, { code: out.error.code, message: out.error.message });
  const at = isoNow(ctx);
  const cards: ReviewCardRecord[] = out.result.value.proposals.map((p) => {
    const proposal: FilingCardProposal = { kind: "filing", area: p.area as SpaceId };
    if (p.folder !== undefined) proposal.folder = p.folder;
    if (p.project !== undefined) proposal.project = p.project;
    const card: ReviewCardRecord = { v: 1, id: newReviewCardId(nowOf(ctx)), kind: "filing", target: p.target, proposal, model: out.result.modelUsed, runId: rs.run.id, confidence: p.confidence, createdAt: at };
    if (p.reason) card.reason = p.reason;
    return card;
  });
  if (cards.length > 0) {
    await ctx.ledger.append("review", cards);
    noteWrites(data, { cards });
    ctx.emit({ kind: "review-cards", count: cards.length });
  }
  rs.run.noAnswer = items.length - cards.length;
  return rs.finish(cards.length > 0 ? "finished" : "nothing tagged");
}

// ───────────────────────────── name check ─────────────────────────────

async function runNameCheck(plan: JobPlan, ctx: JobContext, data: JobData, track: Track): Promise<RunRecord> {
  const names = namesOf(ctx.settings);
  if (names.length === 0) return skippedRun(ctx, plan, PROMPT_VERSIONS["name-check"]);
  const items: PromptItem[] = [];
  const cited = new Map<string, CitedEntry>();
  const reads: ReadDraft = { entryIds: [], noteIds: [], policy: "", redactions: 0, withheld: 0 };
  const policies = new Set<string>();
  for (const id of plan.targets) {
    const lite = data.entries.get(id);
    if (!lite || !isEntryId(id) || data.mentionCards.has(id) || !visibleForJobs(lite, data, ctx.settings) || effectiveSpeaker(lite, data) !== "other") continue;
    const policy = policyFor(lite.source, ctx.settings);
    if (policy.withholdAssistant) continue;
    const [s] = await readEntries(ctx, data, [lite]);
    if (!s) continue;
    const name = nameIn(s.text, names);
    if (name === null) continue;
    const at = s.text.toLowerCase().indexOf(name.toLowerCase());
    const window = s.text.length <= 900 ? s.text : windowAround(s.text, Math.max(0, at), Math.max(0, at) + name.length, 380);
    // The window is redacted like any text sent to a model; if your own patterns hide a name, that hit is dropped.
    const r = redactText(window, policy);
    reads.redactions += r.redactions;
    policies.add(policy.name);
    reads.entryIds.push(lite.id);
    const it: PromptItem = { id, speaker: "other", text: r.text };
    if (s.date) it.date = s.date.slice(0, 10);
    items.push(it);
    cited.set(id, citedOf(s));
  }
  if (items.length === 0) return skippedRun(ctx, plan, PROMPT_VERSIONS["name-check"]);
  reads.policy = [...policies].join(", ");
  const built = buildNameCheckPrompt(names, items);
  const rs = new RunState(ctx, "name-check", plan.model, items.map((i) => i.id), built.version);
  track(rs);
  await rs.start();
  const out = await callValidated(ctx, rs, built, reads, (o) => validateNameCheckOutput(o, vctxOf(built.allowedIds, cited), names), {
    via: "job",
    timeoutMs: ctx.settings.agents.perCallTimeoutSec * 1000,
    outputTokens: 40 * items.length,
  });
  if (!out.ok) return rs.finish(out.status, { code: out.error.code, message: out.error.message });
  const at = isoNow(ctx);
  const cards: ReviewCardRecord[] = out.result.value.mentions.map((m) => {
    const proposal: MentionCardProposal = { kind: "mention", name: m.name, quote: m.quote };
    return { v: 1, id: newReviewCardId(nowOf(ctx)), kind: "mention", target: m.entryId, proposal, model: out.result.modelUsed, runId: rs.run.id, createdAt: at };
  });
  if (cards.length > 0) {
    await ctx.ledger.append("review", cards);
    noteWrites(data, { cards });
    ctx.emit({ kind: "review-cards", count: cards.length });
  }
  rs.run.labels = cards.length;
  return rs.finish(cards.length > 0 ? "finished" : "nothing tagged");
}

// ───────────────────────────── direction trials ─────────────────────────────

/** One plan per arm of the request's trial (nothing unless the trigger names a valid purpose and arms). */
function planDirections(ctx: JobContext): JobPlan[] {
  const req = ctx.trigger?.jobs?.includes("directions") ? normaliseRequest(ctx.trigger.experiment) : null;
  if (!req) return [];
  const model = modelFor("directions", ctx.settings);
  return req.arms.map((arm, i) => {
    const chars = arm === "record" ? RECORD_PASSAGES * PASSAGE_CHARS : arm === "placebo" ? PLACEBO_PASSAGE_COUNT * 600 : 0;
    return { job: "directions" as const, targets: [`arm:${arm}`], model, estimateTokens: estimateCallTokens(chars + req.purpose.length + 1_500, "directions"), priority: i, experiment: { purpose: req.purpose, arm } };
  });
}

/** The user's own passages most relevant to the purpose, excerpted, with the privacy policy and redaction applied. */
async function recordPassages(ctx: JobContext, data: JobData, purpose: string, reads: ReadDraft): Promise<PromptItem[]> {
  const terms = purposeTerms(purpose);
  if (terms.length === 0) return [];
  const mine = (e: EntryLite) => effectiveSpeaker(e, data) === "you" || e.source === "written";
  const titleOf = (e: EntryLite) => `${e.title ?? ""} ${e.conv ? (data.conversations.get(e.conv)?.title ?? "") : ""} ${e.folder.join(" ")} ${e.project ?? ""}`;
  // Only spaces the owner opened (Settings > Privacy > Open spaces): everything else stays out of the record arm.
  const open = effectiveOpenSpaces(ctx.settings.consent, ctx.settings.userSpaces);
  const pool = [...data.entries.values()]
    .filter((e) => isEntryId(e.id) && mine(e) && inList(e, open) && visibleForJobs(e, data, ctx.settings) && !isOffLimits(e.folder.join("/"), ctx.settings))
    .map((e) => ({ e, pre: relevance(terms, titleOf(e)), t: parseIso(e.at ?? e.addedAt) || 0 }))
    .sort((a, b) => b.pre - a.pre || b.t - a.t)
    .slice(0, RECORD_READ_LIMIT)
    .map((x) => x.e);
  const shown = await readEntries(ctx, data, pool);
  const ranked = rankPassages(
    terms,
    shown.map((s) => ({ s, text: s.text, title: titleOf(s.lite) })),
    RECORD_PASSAGES,
  );
  const out: PromptItem[] = [];
  const policies = new Set<string>();
  for (const { item } of ranked) {
    const s = item.s;
    const policy = policyFor(s.lite.source, ctx.settings);
    const lower = s.text.toLowerCase();
    const first = terms.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    const window = s.text.length <= PASSAGE_CHARS ? s.text : windowAround(s.text, first, first + 1, Math.floor(PASSAGE_CHARS / 2));
    const sh = shield([{ ...promptItemOf(s), text: window }], policy);
    reads.redactions += sh.redactions;
    reads.withheld += sh.withheld;
    const it = sh.items[0];
    if (!it) continue;
    policies.add(policy.name);
    reads.entryIds.push(s.lite.id);
    out.push(it);
  }
  reads.policy = [...policies].join(", ");
  return out;
}

async function runDirections(plan: JobPlan, ctx: JobContext, data: JobData, track: Track): Promise<RunRecord> {
  const exp = plan.experiment;
  if (!exp) return skippedRun(ctx, plan, PROMPT_VERSIONS.directions);
  const reads: ReadDraft = { entryIds: [], noteIds: [], policy: exp.arm === "placebo" ? "bundled placebo, no record text" : "no record text", redactions: 0, withheld: 0 };
  let items: PromptItem[] = [];
  if (exp.arm === "record") items = await recordPassages(ctx, data, exp.purpose, reads);
  else if (exp.arm === "placebo") items = pickPlacebo(exp.purpose).map((p) => ({ id: p.id, kind: "passage", title: p.title, text: p.text }));
  const built = buildDirectionsPrompt(exp.purpose, exp.arm, items);
  const rs = new RunState(ctx, "directions", plan.model, reads.entryIds, built.version);
  rs.run.experiment = { purpose: exp.purpose, arm: exp.arm, directions: [], passages: items.length };
  track(rs);
  await rs.start();
  // Nothing relevant (or allowed) in the record: asking would just repeat the "nothing" arm under the wrong name.
  if (exp.arm === "record" && items.length === 0) return rs.finish("nothing tagged");
  const out = await callValidated(ctx, rs, built, reads, async (o) => validateDirectionsOutput(o, built.allowedIds), {
    via: "job",
    timeoutMs: ctx.settings.agents.perCallTimeoutSec * 1000,
    outputTokens: EXPECTED_OUTPUT.directions,
  });
  if (!out.ok) return rs.finish(out.status, { code: out.error.code, message: out.error.message });
  const v = out.result.value;
  const at = isoNow(ctx);
  const cards: ReviewCardRecord[] = v.directions.map((d) => {
    const proposal: DirectionCardProposal = { kind: "direction", purpose: exp.purpose, arm: exp.arm, text: d.text };
    if (d.from) proposal.from = d.from;
    return { v: 1, id: newReviewCardId(nowOf(ctx)), kind: "direction", target: rs.run.id, proposal, model: out.result.modelUsed, runId: rs.run.id, createdAt: at };
  });
  if (injectionRejections(v.rejected).length > 0) ctx.emit({ kind: "warning", code: "injection-signal", detail: { runId: rs.run.id, fields: injectionRejections(v.rejected).length } });
  await ctx.ledger.append("review", cards);
  noteWrites(data, { cards });
  ctx.emit({ kind: "review-cards", count: cards.length });
  rs.run.experiment = { purpose: exp.purpose, arm: exp.arm, directions: v.directions.map((d) => ({ text: d.text, ...(d.from ? { from: d.from } : {}) })), passages: items.length };
  rs.run.labels = cards.length;
  return rs.finish("finished");
}

// ───────────────────────────── Ask (answer) ─────────────────────────────

/** Extra result fields carried with `ai.ask` until RFC E6-1 adds them to AiAskResult. */
export interface AiAskExtras {
  /** The model's reason per returned action (aligned with `actions`; null when none). */
  reasons?: (string | null)[];
  /** The raw model reply when it could not be used at all ("Show the raw reply"); `reply` is then empty. */
  raw?: string;
}

export const ASK_LIMITS = { question: 4_000, candidates: 40, history: 20, turnChars: 2_000, minTimeoutSec: 10, maxTimeoutSec: 600, rawChars: 4_000 } as const;

/** Stored copy of Ask text: high-confidence secrets never reach the vault (OneDrive sync is egress, SAFE-10). */
function storedAskText(text: string, settings: CortexSettings): string {
  return settings.privacy.keepSecretsLocal ? scanSecrets(text, { highConfidenceOnly: true, replacement: "[secret removed]" }).text : text;
}

function candidateKind(id: string): "entry" | "note" | "vault" | null {
  if (isEntryId(id)) return "entry";
  if (isNoteId(id)) return id.startsWith("w_") ? "vault" : "note";
  return null;
}

async function findWikiNotes(ctx: JobContext, ids: ReadonlySet<string>): Promise<Map<string, WikiNoteLite>> {
  const out = new Map<string, WikiNoteLite>();
  if (ids.size === 0) return out;
  for (const n of await wikiNotes(ctx)) if (ids.has(n.id)) out.set(n.id, n);
  return out;
}

/**
 * Ask in the runner (`ai.ask`): read the candidates' text under the privacy policy, log the read, call the
 * model within the budget, validate the reply (citations against the exact version, actions one by one against
 * the registry and the slash command's verb), and store the exchange as two record entries of source
 * `cortex-ask`. Throws CortexError for engine, budget and kill-switch failures (the runner turns them into error
 * frames); an unusable reply comes back with `raw` and an empty `reply`.
 */
export async function runAnswer(args: AiAskArgs, ctx: JobContext): Promise<AiAskResult & AiAskExtras> {
  const question = args.question.trim().slice(0, ASK_LIMITS.question);
  if (question.length === 0) throw new CortexError("E_BAD_REQUEST", "empty question");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(args.threadId) || !/^[A-Za-z0-9_-]{1,80}$/.test(args.askId)) throw new CortexError("E_BAD_REQUEST", "bad thread or ask id");
  const data = await loadJobData(ctx);
  const settings = ctx.settings;
  const candidates = args.candidates.slice(0, ASK_LIMITS.candidates).filter((c: AiCandidate) => candidateKind(c.id) !== null);
  const wiki = await findWikiNotes(ctx, new Set(candidates.filter((c) => c.id.startsWith("w_")).map((c) => c.id)));
  const items: PromptItem[] = [];
  const cited = new Map<string, CitedEntry>();
  const reads: ReadDraft = { entryIds: [], noteIds: [], policy: "", redactions: 0, withheld: 0 };
  const policies = new Set<string>();
  let chars = 0;
  for (const c of candidates) {
    if (chars > PROMPT_LIMITS.answer) break;
    const kind = candidateKind(c.id);
    if (kind === "entry") {
      const lite = data.entries.get(c.id);
      if (!lite || !visibleForJobs(lite, data, settings)) continue;
      const [s] = await readEntries(ctx, data, [lite]);
      if (!s) continue;
      const policy = policyFor(lite.source, settings);
      policies.add(policy.name);
      const sh = shield([{ ...promptItemOf(s), kind: "passage", text: excerpt(s.text, PROMPT_LIMITS.answerItem) }], policy);
      const it = sh.items[0];
      if (!it) continue;
      if (lite.conv) {
        const title = data.conversations.get(lite.conv)?.title;
        if (title) {
          const t = redactText(title, policy);
          it.title = t.text;
          reads.redactions += t.redactions;
        }
      }
      reads.redactions += sh.redactions;
      reads.withheld += sh.withheld;
      reads.entryIds.push(lite.id);
      items.push(it);
      if (sh.withheld === 0) cited.set(c.id, citedOf(s));
      chars += it.text.length + 120;
    } else if (kind === "note") {
      const n = data.notes.get(c.id);
      if (!n || n.state !== "current" || data.corrections.excluded.has(n.id) || (n.conv && (data.corrections.excluded.has(n.conv) || eligibleMessages(n.conv, data, settings).length === 0))) continue;
      const policy = policyFor("claude-code", settings);
      policies.add(policy.name);
      const body = n.hub ? hubBodyText(n.hub, true) : n.text;
      const r = redactText(excerpt(body, PROMPT_LIMITS.answerItem), policy);
      const t = redactText(n.title, policy);
      reads.redactions += r.redactions + t.redactions;
      reads.noteIds.push(n.id);
      const it: PromptItem = { id: n.id, kind: n.kind === "gist" ? "summary" : n.kind === "hub" ? "map" : n.kind, title: t.text, text: r.text };
      if (n.date) it.date = n.date.slice(0, 10);
      items.push(it);
      cited.set(n.id, { text: body, speaker: "assistant" });
      chars += r.text.length + 120;
    } else {
      const w = wiki.get(c.id);
      if (!w || data.corrections.excluded.has(w.id) || (w.status === "reference" && settings.agents.skipReference)) continue;
      const md = await io(ctx).readVaultFile(w.path);
      if (md === null) continue;
      const body = stripFrontmatter(md).trim();
      const policy = policyFor("obsidian", settings);
      policies.add(policy.name);
      const r = redactText(excerpt(body, PROMPT_LIMITS.answerItem), policy);
      const t = redactText(w.title, policy);
      reads.redactions += r.redactions + t.redactions;
      reads.noteIds.push(w.id);
      items.push({ id: w.id, kind: "vault note", title: t.text, text: r.text });
      cited.set(w.id, { text: body, speaker: "you" });
      chars += r.text.length + 120;
    }
  }
  const askPolicy = policyFor("cortex-ask", settings);
  policies.add(askPolicy.name);
  reads.policy = [...policies].join(", ");
  const q = redactText(question, askPolicy);
  reads.redactions += q.redactions;
  const history = args.history.slice(-ASK_LIMITS.history).map((t) => {
    const r = redactText(excerpt(t.text, ASK_LIMITS.turnChars), askPolicy);
    reads.redactions += r.redactions;
    return { role: t.role, text: r.text };
  });
  const vocabulary: Record<string, string[]> = {};
  for (const [k, values] of Object.entries(args.context.vocabulary)) {
    vocabulary[k] = values.slice(0, 200).map((v) => {
      const r = redactText(String(v).slice(0, 120), askPolicy);
      reads.redactions += r.redactions;
      return r.text;
    });
  }
  const snapshot = { ...args.context, vocabulary };
  const actx: Parameters<typeof buildAnswerPrompt>[2] = { snapshot, history };
  if (args.onlyVerb !== undefined) actx.onlyVerb = args.onlyVerb;
  if (args.chart) actx.chart = args.chart;
  const built = buildAnswerPrompt(q.text, items, actx);
  const model = modelFor("answer", settings);
  const rs = new RunState(ctx, "answer", model, [...reads.entryIds, ...reads.noteIds], built.version);
  await rs.start();
  const timeoutSec = Math.max(ASK_LIMITS.minTimeoutSec, Math.min(ASK_LIMITS.maxTimeoutSec, Math.round(args.timeoutSec)));
  const vopts: { onlyVerb?: typeof args.onlyVerb } = {};
  if (args.onlyVerb !== undefined) vopts.onlyVerb = args.onlyVerb;
  const out = await callValidated(ctx, rs, built, reads, (o) => validateAnswerOutput(o, vctxOf(built.allowedIds, cited), vopts), {
    via: "ask",
    timeoutMs: timeoutSec * 1000,
    outputTokens: EXPECTED_OUTPUT.answer,
    countsTowardCap: settings.agents.askCountsTowardCap,
  });
  if (!out.ok) {
    if (out.error.code === "E_VALIDATION") {
      await rs.finish("failed", { code: out.error.code, message: out.error.message });
      const res: AiAskResult & AiAskExtras = { askId: args.askId, runId: rs.run.id, reply: "", citations: [], actions: [], rejectedActions: [{ reason: "invalid-reply" }], droppedStatements: 0, stored: { conv: "", entries: [] }, tokens: rs.tokens };
      if (out.rawText !== undefined) res.raw = out.rawText.slice(0, ASK_LIMITS.rawChars);
      return res;
    }
    await rs.finish(out.status, { code: out.error.code, message: out.error.message });
    throw new CortexError(out.error.code, out.error.message, { retryable: out.error.retryable });
  }
  const v = out.result.value;
  let stored: AiAskResult["stored"] = { conv: "", entries: [] };
  try {
    stored = await storeExchange(ctx, data, args, question, v.reply, out.result.modelUsed);
  } catch (e) {
    // The reply is still shown; only Ask history misses this exchange.
    ctx.log.error("could not store the Ask exchange", { askId: args.askId, code: asCortexError(e).code });
  }
  await rs.finish("finished");
  return {
    askId: args.askId,
    runId: rs.run.id,
    reply: v.reply,
    citations: v.citations.map((c) => ({ id: c.id as EntryId, quote: c.quote })),
    actions: v.actions,
    rejectedActions: v.rejectedActions.map((r) => ({ reason: r.reason })),
    droppedStatements: v.droppedStatements,
    stored,
    tokens: rs.tokens,
    reasons: v.reasons,
  };
}

/** Write the exchange as record entries of source cortex-ask: one immutable segment per exchange. */
async function storeExchange(ctx: JobContext, data: JobData, args: AiAskArgs, question: string, reply: string, model: string): Promise<AiAskResult["stored"]> {
  const conv = conversationId("cortex-ask", args.threadId);
  const prev = data.conversations.get(conv);
  const now = isoNow(ctx);
  const month = prev?.segDir ? (/\/(\d{4}-\d{2})\//.exec(prev.segDir)?.[1] ?? now.slice(0, 7)) : now.slice(0, 7);
  const idx0 = Math.max(prev?.entryCount ?? 0, data.byConv.get(conv)?.length ?? 0);
  const space: SpaceId = (SPACES.some((s) => s.id === args.context.space) ? args.context.space : "none") as SpaceId;
  const lines: SegmentLine[] = [];
  const recs: EntryRecord[] = [];
  const parts: { sp: Speaker; nid: string; text: string }[] = [{ sp: "you", nid: `${args.askId}:q`, text: storedAskText(question, ctx.settings) }];
  if (reply.trim().length > 0) parts.push({ sp: "assistant", nid: `${args.askId}:a`, text: storedAskText(reply, ctx.settings) });
  for (const [i, p] of parts.entries()) {
    const id = makeEntryId("cortex-ask", `${args.threadId}:${p.nid}`);
    const sha = sha256Hex(p.text);
    const line: SegmentLine = { v: 1, id, nid: p.nid, conv, i: idx0 + i, ts: now, sp: p.sp, text: p.text, sha };
    if (p.sp === "assistant") line.model = model;
    lines.push(line);
  }
  const seg = await io(ctx).writeSegment({ source: "cortex-ask", monthKey: month, conv, lines });
  for (const [i, l] of lines.entries()) {
    const rec: EntryRecord = {
      v: 1,
      id: l.id,
      kind: "message",
      source: "cortex-ask",
      sourceRef: { path: `cortex-ask/${args.threadId}`, nativeId: l.nid, sha256: l.sha },
      conv,
      idx: l.i ?? idx0 + i,
      part: 1,
      speaker: l.sp,
      text: { store: "segment", seg: seg.path, line: i },
      textSha256: l.sha,
      chars: l.text.length,
      words: wordCount(l.text),
      writtenAt: now,
      dates: [{ type: "source-timestamp", strength: "strong", at: now }],
      existedBy: now,
      addedAt: now,
      space,
      folder: [],
      hiddenByDefault: "cortex-ask",
    };
    if (l.sp === "assistant") rec.speakerDetail = model;
    recs.push(rec);
  }
  const first = recs[0];
  const last = recs[recs.length - 1];
  const seqE = await ctx.ledger.append("entries", recs);
  const convRec: ConversationRecord = {
    v: 1,
    id: conv,
    seq: (prev?.seq ?? 0) + 1,
    source: "cortex-ask",
    nativeId: args.threadId,
    title: prev?.title ?? (firstLineTitle(question, 80) || "Ask"),
    titledBy: prev?.titledBy ?? "first-line",
    startedAt: prev?.startedAt ?? now,
    endedAt: now,
    entryCount: idx0 + recs.length,
    parts: [{ n: 1, firstEntry: prev?.parts[0]?.firstEntry ?? (first?.id as EntryId), lastEntry: last?.id as EntryId, startedAt: prev?.parts[0]?.startedAt ?? now }],
    space: prev?.space ?? space,
    folder: [],
    meta: { thread: args.threadId },
    segDir: segmentDir("cortex-ask", month, conv),
    updatedAt: now,
  };
  const seq = await ctx.ledger.append("conversations", [convRec]);
  noteWrites(data, { entries: recs, conversations: [convRec], seq: Math.max(seq, seqE) });
  ctx.emit({ kind: "entries-added", count: recs.length, conversations: 1, sources: ["cortex-ask"], seq, live: false });
  return { conv, entries: recs.map((r) => r.id) };
}
