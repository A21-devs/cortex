/**
 * Cortex core record types. FROZEN CONTRACT (owner: architect). Change only through an RFC (ARCHITECTURE §0.3),
 * because every module (runner, worker, plugin, UI) depends on these shapes.
 *
 * Pure types only: no runtime imports, no DOM, no Node. Safe to import from any bundle.
 *
 * Naming: "Entry" = an original unit of the record (verbatim words). "Note" = a machine-written
 * interpretation (or a legacy wiki note). "Hub" (code identifier) = a machine map of content over many notes;
 * every user-visible string calls it a "map" (project map, area map, topic map). "Space" (code identifier) =
 * a top-level area; the UI says "Area". On disk every record line carries `v` (schema version).
 */

// ───────────────────────────── ids ─────────────────────────────

/** ISO 8601 UTC timestamp, e.g. "2026-11-08T21:17:34.123Z". Day-only values use "YYYY-MM-DD". */
export type IsoDate = string;
/** "e_" + 16 base32 chars of sha256(source + ":" + nativeKey). Stable across re-imports. */
export type EntryId = `e_${string}`;
/** "c_" + 16 base32 chars of sha256(source + ":" + nativeConversationId). */
export type ConversationId = `c_${string}`;
/** "n_" machine notes (gists, atomic notes, hubs); "w_" legacy vault notes (hash of vault path). */
export type NoteId = `n_${string}` | `w_${string}`;
export type ItemId = EntryId | NoteId;
export type RunId = `r_${string}`;
export type LabelId = `l_${string}`;
export type CorrectionId = `k_${string}`;
export type ReceiptId = `x_${string}`;
export type ReviewCardId = `v_${string}`;
/** Vault-relative POSIX path, never absolute, never containing "..". */
export type VaultPath = string;

// ───────────────────────────── enums ─────────────────────────────

export type Speaker = "you" | "assistant" | "other" | "tool";
export const SPEAKERS: readonly Speaker[] = ["you", "assistant", "other", "tool"];

export type SourceKind =
  | "claude-code"
  | "claude-ai"
  | "chatgpt"
  | "gemini"
  | "obsidian"
  | "files"
  | "written"
  | "cortex-ask"
  /** Notes and documents exports (importers/extra/notesDocs.ts). */
  | "notion"
  | "google-docs"
  /** Other coding agents' session logs (importers/extra/agentCli.ts). */
  | "codex-cli"
  | "gemini-cli"
  | "cursor"
  /** Chat, notes and reading exports (importers/extra/chatExports.ts). */
  | "whatsapp"
  | "telegram"
  | "discord"
  | "slack"
  | "keep"
  | "evernote"
  | "roam"
  | "kindle"
  | "zoom"
  /** How an accepted direction turned out (shared/outcomes.ts): a dated entry under .raw/written/outcomes/. */
  | "outcome"
  /** Finished turns posted by the hand-installed browser add-on (plugin/captureServer.ts); opt-in, off by default. */
  | "capture";
export const SOURCE_KINDS: readonly SourceKind[] = [
  "claude-code",
  "claude-ai",
  "chatgpt",
  "gemini",
  "obsidian",
  "files",
  "written",
  "cortex-ask",
  "notion",
  "google-docs",
  "codex-cli",
  "gemini-cli",
  "cursor",
  "whatsapp",
  "telegram",
  "discord",
  "slack",
  "keep",
  "evernote",
  "roam",
  "kindle",
  "zoom",
  "outcome",
  "capture",
];

export type EntryKind = "message" | "document" | "passage" | "file";

/** Persisted order in index-format NOTE_KIND_ORDER. "abandoned" = an idea or plan that was given up. */
export type NoteKind =
  | "gist"
  | "question"
  | "decision"
  | "idea"
  | "plan"
  | "abandoned"
  | "concept"
  | "wiki"
  | "hub"
  | "reference"
  | "log";

/** Map kinds (UI: project map, area map, topic map), following the vault's own MOC convention (type: moc). */
export type HubType = "project" | "area" | "topic";
/** Recency of a map's members; UI labels: active / cooling / dormant (only a Read filter). */
export type HubStatus = "active" | "quiet" | "paused";

/** Space ids in their fixed order (also the brain wedge order). "none" is the bucket shown as "No area". */
export type SpaceId =
  | "code"
  | "web"
  | "data"
  | "ai"
  | "roblox"
  | "games"
  | "money"
  | "design"
  | "life"
  | "vault"
  | "none";

// ───────────────────────────── dating ─────────────────────────────

export type DateEvidenceType =
  | "source-timestamp"
  | "user-declared"
  | "filename-date"
  | "conversation-start"
  | "git-first-seen"
  | "seal"
  | "ingest"
  | "file-mtime";

export type DateStrength = "strong" | "medium" | "bound" | "weak";

export interface DateEvidence {
  type: DateEvidenceType;
  strength: DateStrength;
  at: IsoDate;
  /** Free text, e.g. the frontmatter key or file name the date came from. */
  detail?: string;
}

// ───────────────────────────── record (originals) ─────────────────────────────

/**
 * Where the verbatim text of an entry lives (M6, INPLACE-TEXTREF).
 *  - segment: immutable gzip JSONL under .raw/chats/ (chats, user folders, vault notes outside wiki/, written);
 *  - file: a BYTE range inside a `.raw/` original (the vault treats .raw/ as immutable). Every read verifies
 *    sha256(bytes) === textSha256; a mismatch is reported as "changed at source", never shown as verbatim;
 *  - stage: a complete message of a live session staged in the local cache (this computer only) until the
 *    session is sealed into a segment (ARCHITECTURE §9.1).
 */
export type TextRef =
  | { store: "segment"; seg: VaultPath; line: number }
  | { store: "file"; path: VaultPath; byteStart: number; byteEnd: number }
  | { store: "stage"; conv: ConversationId; line: number };

export interface SourceRef {
  /** Original location: absolute path for external sources, vault path for in-vault sources. */
  path: string;
  /** Native id inside the source (Claude Code line uuid, ChatGPT node id, ...). */
  nativeId?: string;
  byteOffset?: number;
  /** sha256 hex of the original unit as read (line bytes or file bytes). */
  sha256: string;
}

export interface AttachmentRef {
  name: string;
  bytes: number;
  mime: string;
  /** Vault path of the stored copy, if one was kept. */
  path?: VaultPath;
}

/** An alternative wording of the same turn (ChatGPT regenerations / edited prompts). */
export interface BranchVersion {
  nativeId: string;
  text: TextRef;
  textSha256: string;
  at?: IsoDate;
}

/**
 * One line in `.vault-meta/cortex/entries/<yyyy-mm>/<nnnnnn>.jsonl` (month = addedAt; shards roll at ~8 MB).
 * Immutable once written. Later changes (edits, exclusions, re-filing, speaker fixes) are CorrectionRecords
 * applied at index time. A changed source file yields NEW entries that name the old one in `supersedes`.
 */
export interface EntryRecord {
  v: 1;
  id: EntryId;
  kind: EntryKind;
  source: SourceKind;
  sourceRef: SourceRef;
  conv?: ConversationId;
  /** 0-based position of the entry inside its conversation. */
  idx?: number;
  /** Part number (compaction boundary or > 6 h gap starts a new part). */
  part?: number;
  speaker: Speaker;
  /** e.g. the assistant model id, the subagent label, "sdk prompt". */
  speakerDetail?: string;
  /** Document or file title; conversations carry their title on ConversationRecord. */
  title?: string;
  text: TextRef;
  textSha256: string;
  chars: number;
  words: number;
  /** Claimed authoring time (strong or medium evidence only). Undefined = undated. */
  writtenAt?: IsoDate;
  dates: DateEvidence[];
  /** Latest-possible bound (min of ingest, seal, git first-seen). */
  existedBy: IsoDate;
  addedAt: IsoDate;
  space: SpaceId;
  folder: string[];
  project?: string;
  attachments?: AttachmentRef[];
  branches?: BranchVersion[];
  /**
   * Hidden unless the matching Layers toggle is on: subagent traffic, harness lines, Ask history, tool output,
   * reference documents (`sources.raw.referenceFolders`) and automated (sdk-prompt) sessions. Hidden items are
   * never agent targets unless their toggle is on (ARCHITECTURE §10.2).
   */
  hiddenByDefault?: "subagent" | "harness" | "cortex-ask" | "tool" | "reference" | "automated";
  /** Earlier entry this one replaces (the source changed); citations into the old one stay valid. */
  supersedes?: EntryId;
  /** Document passage: index of this passage within its document and the document id. */
  passage?: { doc: EntryId; n: number; of: number; heading?: string };
  /** CC-BY or other licence note shown in the reader (e.g. Roblox creator docs). */
  licence?: string;
}

export interface ConversationPart {
  n: number;
  title?: string;
  firstEntry: EntryId;
  lastEntry: EntryId;
  startedAt?: IsoDate;
}

/**
 * One line in `.vault-meta/cortex/conversations/YYYY-MM.jsonl` (month of first import).
 * Upsert semantics: the line with the highest `seq` for an id wins.
 */
export interface ConversationRecord {
  v: 1;
  id: ConversationId;
  seq: number;
  source: SourceKind;
  nativeId: string;
  title: string;
  titledBy: "native" | "user" | "model" | "first-line";
  startedAt?: IsoDate;
  endedAt?: IsoDate;
  entryCount: number;
  parts: ConversationPart[];
  space: SpaceId;
  folder: string[];
  project?: string;
  /** Source-specific metadata, e.g. { cwd, gitBranch, projectSlug, entrypoint }. Never message text. */
  meta?: Record<string, string>;
  /** Segment folder of this conversation (`.raw/chats/<source>/<yyyy-mm>/<conv>/`), fixed at first import. */
  segDir?: VaultPath;
  gistNoteId?: NoteId;
  updatedAt: IsoDate;
}

/** One line of a record segment `.raw/chats/<source>/<yyyy-mm>/<conv>/<seq4>.jsonl.gz`. */
export interface SegmentLine {
  v: 1;
  id: EntryId;
  /** Native id (Claude Code uuid of the first line of the message, ChatGPT node id, ...). */
  nid: string;
  conv?: ConversationId;
  i?: number;
  ts?: IsoDate;
  sp: Speaker;
  model?: string;
  /** Verbatim text. Never edited after write. */
  text: string;
  /** sha256 hex of `text` (UTF-8). */
  sha: string;
}

// ───────────────────────────── notes (interpretations) ─────────────────────────────

export interface Citation {
  entryId: EntryId;
  /** Entry version the quote was validated against (1 = imported wording). */
  version: number;
  /** MUST be an exact substring of that version's text. */
  quote: string;
  speaker?: Speaker;
  date?: IsoDate;
}

export type MadeBy =
  | { runId: RunId; model: string; engine: EngineKind; pack?: string; at: IsoDate }
  | { legacy: true };

/**
 * One bullet of a map's brief. The evidence meter (quotes from you vs from the assistant) is COMPUTED by Cortex
 * from the cited entries' speakers, never taken from the model (SAFE-09).
 */
export interface HubStatement {
  text: string;
  cites: Citation[];
}

/**
 * The typed sections of a map (SPEC V13), by key. Project maps: nextSteps, openQuestions, keyDecisions. Area maps:
 * whatItIs, whereItStands. Topic maps: whatWasFound. Each statement cites passages like a brief bullet.
 */
export type HubSectionKey = "nextSteps" | "openQuestions" | "keyDecisions" | "whatItIs" | "whereItStands" | "whatWasFound";
export type HubSections = Partial<Record<HubSectionKey, HubStatement[]>>;

/** The section keys each map type may carry, in reading order. */
export const HUB_SECTION_KEYS: Readonly<Record<HubType, readonly HubSectionKey[]>> = {
  project: ["nextSteps", "openQuestions", "keyDecisions"],
  area: ["whatItIs", "whereItStands"],
  topic: ["whatWasFound"],
};

/** Plain-English names of the section keys, for the model-facing text of a map (never shown in the UI). */
export const HUB_SECTION_PLAIN: Readonly<Record<HubSectionKey, string>> = {
  nextSteps: "What comes next",
  openQuestions: "Open questions",
  keyDecisions: "What was decided",
  whatItIs: "What this area holds",
  whereItStands: "Where it stands",
  whatWasFound: "What was found",
};

/**
 * Everything a map says, as text: the brief bullets, then each typed section's statements in the map type's reading
 * order (keys another map type owns are ignored, as the reader does). `labelled` heads each section with its name (for the Ask prompt); unlabelled is the plain statements (search).
 */
export function hubBodyText(hub: Pick<HubFields, "hubType" | "brief" | "sections">, labelled = false): string {
  const lines: string[] = (hub.brief ?? []).map((b) => b.text);
  for (const key of HUB_SECTION_KEYS[hub.hubType] ?? []) {
    const items = hub.sections?.[key];
    if (!Array.isArray(items) || items.length === 0) continue;
    const texts = items.map((i) => i.text).filter((x) => typeof x === "string" && x.length > 0);
    if (texts.length === 0) continue;
    if (labelled) lines.push(`${HUB_SECTION_PLAIN[key]}:`);
    lines.push(...texts);
  }
  return lines.join("\n");
}

/** A machine map of content (CORTEX-UX §5.16): a brief of 3–5 cited bullets over member notes grouped by kind. */
export interface HubFields {
  hubType: HubType;
  status: HubStatus;
  range: [IsoDate, IsoDate];
  /** Parent map, shown as the sheet breadcrumb. */
  within?: NoteId;
  members: NoteId[];
  brief: HubStatement[];
  /** Typed sections the map's agent wrote (absent on maps written before they existed). */
  sections?: HubSections;
}

/** One line in `.vault-meta/cortex/notes/<yyyy-mm>/<nnnnnn>.jsonl`. Upsert by id (highest `seq` wins). */
export interface NoteRecord {
  v: 1;
  id: NoteId;
  seq: number;
  kind: NoteKind;
  title: string;
  /** Short body (atomic notes: the statement itself; gists: the "what happened" paragraph). */
  text: string;
  /** Markdown file that holds the note (wiki/derived/...), plus block id for atomic notes. */
  file: VaultPath;
  blockId?: string;
  date?: IsoDate;
  sources: Citation[];
  parent?: NoteId;
  conv?: ConversationId;
  /** Atomic notes: the conversation part (frond node) they hang off. */
  part?: number;
  madeBy: MadeBy;
  space: SpaceId;
  folder: string[];
  /** "excluded" = rewritten to a tombstone after the user left its sources out (previous bytes in trash/). */
  state: "current" | "stale" | "superseded" | "hidden" | "excluded";
  supersededBy?: NoteId;
  hub?: HubFields;
  /** Machine facets written to cortex_* frontmatter (session work/outcome/topics …). */
  facets?: Record<string, string | string[]>;
  /** User comments (corrections) the latest run answered (M7: gists and maps). */
  addressedComments?: CorrectionId[];
  /**
   * sha256 of the note BODY plus the Cortex-owned frontmatter keys as Cortex last wrote them (DERIVED-NOTE-SHA).
   * Keys other tools add (layer, tags …) are merged and kept on rewrite and never count as a user edit.
   */
  ownedSha256?: string;
}

// ───────────────────────────── labels & packs ─────────────────────────────

export type PackTarget = "entry" | "conversation" | "note";
export type PackFieldType = "enum" | "multi" | "text" | "bool";

export interface PackField {
  key: string;
  label: string;
  description: string;
  type: PackFieldType;
  values?: string[];
  /** Instruction given to the model for this field. */
  prompt: string;
  /** Free-text multi fields (topics) are capped to this many values. */
  maxValues?: number;
}

export interface PackDef {
  id: string;
  version: string;
  description: string;
  appliesTo: PackTarget[];
  fields: PackField[];
  /**
   * "model": filled by agent runs; "user": only by your corrections (fixes@1.0.0); "derived": computed by Cortex
   * from the vault's own settings (para@1.0.0 from wiki-mode), never by a model.
   */
  writer: "model" | "user" | "derived";
}

export type LabelValue = string | string[] | boolean | null;

export type LabelBy =
  | { model: string; runId: RunId; engine: EngineKind }
  | { user: true; correctionId: CorrectionId };

/** One line in `.vault-meta/cortex/labels/YYYY-MM.jsonl`. */
export interface LabelRecord {
  v: 1;
  id: LabelId;
  /** Conversation, note or entry id. */
  target: ConversationId | NoteId | EntryId;
  targetVersion?: number;
  pack: string;
  packVersion: string;
  field: string;
  value: LabelValue;
  /** "held" = Settings › Agents › After labelling = Hold everything for Checks: does not count until confirmed. */
  state: "set" | "refused" | "unanswered" | "held";
  confidence?: number;
  by: LabelBy;
  at: IsoDate;
  supersededBy?: LabelId;
}

// ───────────────────────────── corrections (user outranks models) ─────────────────────────────

export type CorrectionVia = "reader" | "ask" | "checks" | "map-flag" | "key" | "read" | "sources" | "settings";

export type CorrectionAction =
  | "edit-text"
  | "set-label"
  | "reject-label"
  | "merge-groups"
  | "split-group"
  | "exclude"
  | "include"
  | "set-date"
  | "set-speaker"
  | "refile"
  | "comment"
  | "resolve-comment"
  | "confirm"
  | "pin"
  | "unpin";

/** Payload shapes by action. */
export interface CorrectionPayloads {
  /** `version` is assigned when the correction is written (max existing + 1, under the corrections lock) and
   *  never renumbered by an undo (SAFE-13). */
  "edit-text": { newText: string; newTextSha256: string; fromVersion: number; version: number };
  "set-label": { pack: string; packVersion: string; field: string; value: LabelValue };
  "reject-label": { labelId: LabelId };
  "merge-groups": { dim: string; from: string; into: string; as?: string };
  "split-group": { mergeCorrectionId: CorrectionId };
  /**
   * Scopes source, folder and project ALSO write the matching settings exclusion under the same change, so the
   * importers stop reading; Undo reverses both (M2). `settingsKey` names what was added.
   */
  exclude: { scope: "entry" | "conversation" | "source" | "folder" | "project"; sourceKind?: SourceKind; folder?: string; project?: string; settingsKey?: string };
  include: { excludeCorrectionId: CorrectionId };
  "set-date": { writtenAt: IsoDate | null };
  "set-speaker": { speaker: Speaker; speakerDetail?: string };
  refile: { space?: SpaceId; folder?: string[]; project?: string | null };
  comment: { statementKey?: string; text: string };
  "resolve-comment": { commentId: CorrectionId; runId: RunId };
  /** `text`: an accepted (possibly edited) direction from a direction check. */
  confirm: { labelId?: LabelId; noteId?: NoteId; text?: string };
  pin: Record<string, never>;
  unpin: Record<string, never>;
}

/** One line in `.vault-meta/cortex/corrections.jsonl` (append-only, never compacted away). */
export interface CorrectionRecord<A extends CorrectionAction = CorrectionAction> {
  v: 1;
  id: CorrectionId;
  at: IsoDate;
  via: CorrectionVia;
  action: A;
  target: string;
  payload: CorrectionPayloads[A];
  reason?: string;
  /** This correction reverses another (undo). */
  undoes?: CorrectionId;
}

// ───────────────────────────── agents: runs, reads, review ─────────────────────────────

/**
 * "codex-cli": the person's own Codex CLI, run headless (agents/codexCli.ts). "rule": the No model organiser
 * (agents/ruleLabels.ts), which labels with plain rules on this computer and sends nothing anywhere.
 */
export type EngineKind = "claude-cli" | "anthropic-api" | "local" | "fake" | "codex-cli" | "rule";
export type JobKind = "label" | "gist" | "hub" | "filing" | "name-check" | "answer" | "directions";

/** What a direction trial gave the model: passages from your record, neutral unrelated passages (a placebo), or nothing. */
export type DirectionArm = "record" | "placebo" | "none";

/** The trial a `directions` run carried out (RunRecord.experiment): your purpose, what the model was given, what it drafted. */
export interface DirectionsExperiment {
  purpose: string;
  arm: DirectionArm;
  /** Short directions the model drafted; each also waits in Checks as a card. Empty until the run has finished. */
  directions: { text: string; from?: string[] }[];
  /** Passages shown to the model: record entries, neutral passages, or none. */
  passages: number;
}
export type RunStatus = "running" | "finished" | "stopped" | "failed" | "capped" | "nothing tagged";

/** One line in `.vault-meta/cortex/runs/YYYY-MM.jsonl`; a run is written at start and again at finish. */
export interface RunRecord {
  v: 1;
  id: RunId;
  job: JobKind;
  pack?: string;
  pass: number;
  engine: EngineKind;
  model: string;
  where: "remote" | "this computer";
  paidBy: "plan" | "api" | "none";
  startedAt: IsoDate;
  finishedAt?: IsoDate;
  status: RunStatus;
  /** Ids of the conversations/notes this run processed. */
  targets: string[];
  items: number;
  labels: number;
  /** Items the model declined to label (UI "Declined"). */
  declined: number;
  /** Items the model left without an answer (UI "No answer"). */
  noAnswer: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  /** True when token counts are estimates (engine did not report usage). */
  tokensEstimated: boolean;
  costUsd: number;
  priceTableDate: string;
  promptVersion: string;
  /** Which settings the run used (SETTINGS-FAIL-OPEN): the plugin's request, data.json, or defaults (no file). */
  settingsSource?: "plugin" | "data.json" | "defaults";
  /** --effort passed for the call. */
  effort?: "low" | "medium" | "high";
  /** Only on `directions` runs. */
  experiment?: DirectionsExperiment;
  error?: { code: string; message: string };
}

/** One line in `.vault-meta/cortex/reads/YYYY-MM.jsonl`: every AI read is logged. */
export interface ReadRecord {
  v: 1;
  runId: RunId;
  model: string;
  engine: EngineKind;
  where: "remote" | "this computer";
  entryIds: EntryId[];
  noteIds: NoteId[];
  /** Which privacy policy filtered the text, e.g. "replies-withheld+redacted", "full+redacted". */
  policy: string;
  chars: number;
  /** Spans replaced by the redactor before sending (SAFE-06). */
  redactions: number;
  /** Lines withheld because replies are kept local for their source. */
  withheld: number;
  via: "job" | "ask";
  /** Who started the run: the plugin's clock or the /cortex-organise skill (shown in the ledger, §12.8). */
  origin: "plugin" | "skill";
  /** Prompt version, e.g. "label@1.0.0" (run detail line). */
  promptVersion?: string;
  /** The grants that covered this read (Settings > Privacy > Grants); absent when no grant was needed. */
  grants?: string[];
  at: IsoDate;
}

/** "conflict" = the user edited a machine note in Obsidian; Cortex kept their version (M5). */
export type ReviewCardKind = "label" | "note" | "filing" | "mention" | "conflict" | "direction";

/** One line in `.vault-meta/cortex/review/<yyyy-mm>/<nnnnnn>.jsonl` (the Checks tab); resolution is a correction. */
export interface ReviewCardRecord {
  v: 1;
  id: ReviewCardId;
  kind: ReviewCardKind;
  target: string;
  proposal: unknown;
  model?: string;
  runId?: RunId;
  confidence?: number;
  /** The model's one-line reason (≤ 140 characters, from the output schema), shown behind "Why?". */
  reason?: string;
  createdAt: IsoDate;
  resolvedBy?: CorrectionId;
  /** Set by the runner's `review.discard` (Undo of an Ask change): the card is closed without an answer. */
  dismissedAt?: IsoDate;
}

// ───────────────────────────── changes (receipts) ─────────────────────────────

export type ReceiptState = "proposed" | "applied" | "undone" | "rejected" | "failed";

/**
 * One line in `.vault-meta/cortex/receipts/<yyyy-mm>/<nnnnnn>.jsonl` (the month's size-rolled shards, LEDGER-SHARD-
 * SIZE; upsert by id, highest seq wins). The UI
 * calls these "changes" ("Undo change", "Change history"). Only data-changing actions are persisted; view
 * changes live in the leaf's undo stack for the session.
 */
export interface ReceiptRecord {
  v: 1;
  id: ReceiptId;
  seq: number;
  askId: string;
  action: string;
  params: unknown;
  /** Written by Cortex from validated params and resolved targets (titles, counts, diff); never model text. */
  summary: string;
  /** The model's stated reason, if any, shown labelled as the AI's words. */
  reason?: string;
  targets: number;
  state: ReceiptState;
  corrections: CorrectionId[];
  /** null = Undo never expires (every data-changing change, SAFE-04). */
  expiresAt: IsoDate | null;
  at: IsoDate;
}

// ───────────────────────────── sources manifest & cursors ─────────────────────────────

/** `.vault-meta/cortex/sources.json`: what was imported from where (replaces editing .raw/.manifest.json). */
export interface SourceManifest {
  v: 1;
  sources: Record<
    string,
    {
      kind: SourceKind;
      path: string;
      sha256?: string;
      bytes: number;
      importedAt: IsoDate;
      entries: number;
      conversations: number;
      status: "imported" | "watching" | "paused" | "error" | "excluded" | "changed";
      /** Warning code from the fixed catalogue (protocol/runner.ts WarningCode). */
      error?: string;
      /** Export imports: where a paused import resumes (M11). */
      resume?: { cursor: string; at: IsoDate };
    }
  >;
}

/**
 * Per-file incremental read position for append-only sources (Claude Code JSONL). Machine-local: cursors live
 * in the cache (`<cache>/state/cursors.json`). Losing them costs only a re-scan: ids are stable, the ledger
 * dedupes, and the next segment number is derived from the conversation folder, never from the cursor.
 */
export interface FileCursor {
  path: string;
  size: number;
  mtimeMs: number;
  /** Byte offset of the first unconsumed byte (always at a line start, counted in raw bytes). */
  offset: number;
  line: number;
  lastUuid?: string;
  conv?: ConversationId;
  /** Entries emitted so far for this file's conversation (keeps idx monotonic across runs). */
  emitted: number;
  updatedAt: IsoDate;
}

/** `<cache>/state/cursors.json`. */
export interface CursorState {
  v: 1;
  files: Record<string, FileCursor>;
}

// ───────────────────────────── small shared state files ─────────────────────────────

/**
 * `.vault-meta/cortex/state/colours.json`: sticky colour slots per dimension (M8). Written by the plugin only;
 * slots are assigned once by rank over everything indexed and kept across filters, scopes and periods.
 */
export interface ColourSlotsFile {
  v: 1;
  dims: Record<string, Record<string, number>>;
}

/**
 * `.vault-meta/cortex/state/control.json`: the live kill switches (SAFE-03). Written by the plugin together with
 * the matching setting; every runner re-reads it before each engine call and each import unit.
 */
export interface ControlState {
  v: 1;
  paused: boolean;
  /** Bumped on every privacy change (exclusions, replies kept local, redaction); a running job whose rev differs stops. */
  privacyRev: number;
  at: IsoDate;
}

/** `.vault-meta/cortex/views.json`: pinned views (CORTEX-UX §5.28 "Pin view"; listed in Read › Pinned). */
export interface PinnedViewRecord {
  id: string;
  name: string;
  /** A LeafPersistedState (state/types.ts), validated by the UI on load. */
  state: unknown;
  at: IsoDate;
}
