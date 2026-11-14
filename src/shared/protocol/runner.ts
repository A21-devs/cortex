/**
 * Plugin ↔ runner protocol. FROZEN CONTRACT (owner: architect).
 *
 * Transport A (default): the plugin spawns `node cortex-runner.js serve` and exchanges one JSON object
 * per line: frames `ToRunner` on the child's stdin, frames `FromRunner` on its stdout. stderr is free-form
 * diagnostics (copied to cache/logs/runner.log). Stdin EOF means the parent is gone: the runner cancels
 * everything and exits within 2 s.
 * Transport B (fallback, no system Node): the runner bundle runs in a Node-integrated Web Worker (Obsidian 1.15
 * creates its windows with nodeIntegrationInWorker), exchanging the SAME frames over postMessage; only if that
 * probe fails does it run inline on the UI thread (`createInlineRunner`, concurrency 1, no agents).
 * Transport C (Claude Code skill / terminal): `node cortex-runner.js <command> [--flags] [--json]`;
 * with --json the same `FromRunner` frames are printed as JSON lines.
 *
 * SAFE-17: frames carry only counts, ids, enum codes and Cortex-built paths. Error and warning text comes from a
 * fixed catalogue (WarningCode, RunnerErrorCode) and never echoes record text or parser input, because the
 * skill's output is read by a tool-enabled Claude Code session.
 */
import type { ConsentReads } from "../consent";
import type { DimId } from "../dims";
import type { PlanWindowId, PlanWindowView } from "../planLimits";
import type { ScreenedSummary } from "../personDetail";
import type { CortexSettings } from "../settings";
import type { DirectionArm, EntryId, IsoDate, JobKind, NoteId, RunId, ReviewCardKind, RunStatus, SourceKind } from "../types";
import type { ActionCall, OnlyVerb } from "../actions";

export const RUNNER_PROTOCOL_VERSION = 2;

// ───────────────────────────── commands ─────────────────────────────

export type SourceSelector =
  | { kind: "claude-code"; projects?: string[] }
  | { kind: "claude-ai"; file: string }
  | { kind: "chatgpt"; file: string }
  | { kind: "gemini"; file: string }
  | { kind: "raw" }
  | { kind: "folder"; id: string }
  | { kind: "written" }
  /** User notes outside wiki/ (daily notes …): copied into segments; a changed note becomes a new version. */
  | { kind: "vault-notes" }
  /** A Notion export (.zip or unzipped folder of markdown and csv). */
  | { kind: "notion"; file: string }
  /** Google Docs: a Takeout (Drive) export or a folder of .docx / .html documents. */
  | { kind: "google-docs"; file: string }
  /** Other coding agents' session logs on this computer; opt-in (settings.sources.codexCli / geminiCli / cursor). */
  | { kind: "codex-cli" }
  | { kind: "gemini-cli" }
  | { kind: "cursor" }
  /** Turns the browser add-on posted to the loopback receiver (spooled in the local cache; opt-in, settings.sources.capture). */
  | { kind: "capture" }
  /** Chat, notes and reading exports a person downloaded (a zip, a folder or the file itself): read locally, nothing is fetched. */
  | { kind: "whatsapp"; file: string }
  | { kind: "telegram"; file: string }
  | { kind: "discord"; file: string }
  | { kind: "slack"; file: string }
  | { kind: "keep"; file: string }
  | { kind: "evernote"; file: string }
  | { kind: "roam"; file: string }
  | { kind: "kindle"; file: string }
  | { kind: "zoom"; file: string };

export interface ImportArgs {
  sources: SourceSelector[];
  /** Only read source units newer than this (incremental sources ignore it; cursors rule). */
  since?: IsoDate;
  dryRun?: boolean;
  /** Safety valve for tests/sample runs. */
  maxEntries?: number;
  /** Stop cleanly after this long (CLI default 90 s so a skill's foreground call never outlives its tool timeout). */
  maxSeconds?: number;
  /** Resume a paused export import from its manifest cursor. */
  resume?: boolean;
  /** Seal live sessions now (daily seal, or the user closing Obsidian). */
  seal?: boolean;
  /** Import the new version of raw documents that changed on disk: all of them, or these vault paths. */
  importChanged?: boolean | string[];
}

export interface AgentsRunArgs {
  reason: "idle" | "nightly" | "manual" | "skill" | "refresh";
  jobs?: JobKind[];
  /** Restrict to these conversation/note ids (Your AI "refresh this week"). */
  targets?: string[];
  maxJobs?: number;
  /** Additional per-invocation token ceiling (the daily cap always applies). */
  maxTokens?: number;
  maxSeconds?: number;
  dryRun?: boolean;
  /** With jobs ["directions"]: the purpose and what each arm of the trial is given (agents/directions.ts validates it). */
  experiment?: { purpose: string; arms: DirectionArm[] };
}

/** Queue work without running it now (Ask "refresh", Checks re-runs); the scheduler picks it up. */
export interface AgentsEnqueueArgs {
  jobs: JobKind[];
  targets: string[];
  reason: "refresh" | "comment" | "manual";
}

export interface AiContextSnapshot {
  space: string;
  page: string;
  period?: [IsoDate, IsoDate];
  selection?: string;
  groupBy?: DimId;
  /** Dimension values the model may reference in actions (spaces, folders, label values). */
  vocabulary: Record<string, string[]>;
  today: IsoDate;
}

/**
 * A retrieved candidate (H10): ids and titles only. The RUNNER reads the text, applies the privacy policy
 * (replies kept local, redaction) and writes the ReadRecord, so the policy has one enforcement point.
 */
export interface AiCandidate {
  id: EntryId | NoteId;
  kind: "entry" | "note" | "map";
  title: string;
}

export interface AiTurn {
  role: "you" | "assistant";
  text: string;
}

export interface AiAskArgs {
  askId: string;
  /** Exchanges of one console thread share an id and one conversation under .raw/chats/cortex-ask/. */
  threadId: string;
  question: string;
  context: AiContextSnapshot;
  candidates: AiCandidate[];
  /** Earlier turns of the thread (redacted by the runner before sending). */
  history: AiTurn[];
  timeoutSec: number;
  /** A slash command's verb: the model may return only this action (CORTEX-UX §5.10, §12.7). */
  onlyVerb?: OnlyVerb;
  /** "Ask about this chart": the chart's state, attached as data. */
  chart?: { chart: string; x?: string; y?: string; colour?: string; period?: [IsoDate, IsoDate] };
}

/**
 * First-run step (CORTEX-UX §5.26, §12.13): a dry run that counts what each source would bring and estimates the
 * backlog BEFORE anything is imported or sent. Reads directory listings and file sizes only.
 */
export interface EstimateArgs {
  sources: SourceSelector[];
}

export interface SourceEstimate {
  source: SourceKind;
  /** e.g. sessions, conversations, notes, files. */
  items: number;
  /** Reference notes or documents that stay hidden and are never sent. */
  reference: number;
  /** Absolute folder shown in the row (Claude Code projects folder). */
  where?: string;
}

export interface EstimateResult {
  sources: SourceEstimate[];
  conversations: number;
  notes: number;
  /** Rough tokens to label and summarise the backlog. */
  tokens: number;
}

export interface InspectArgs {
  /** Absolute path of a dropped or chosen export (.zip or folder). */
  file: string;
}

export interface InspectResult {
  kind: "claude-ai" | "chatgpt" | "gemini" | "unknown";
  conversations: number;
  range?: [IsoDate, IsoDate];
  projects: number;
  attachments: number;
  alreadyImported: number;
  /** Set when an export of the same service with newer content was imported before. */
  olderThanImportedAt?: IsoDate;
  problem?: WarningCode;
  /** The file ends before its list does; `conversations` counts the complete ones. */
  truncated?: boolean;
  /** Gemini only: exchanges left out because they are not prompts (feedback lines, "Used Gemini Apps"). */
  skippedActivity?: number;
  /** Gemini only: prompt-and-reply exchanges that will be imported (the preview says "‹n› prompts and replies"). */
  exchanges?: number;
}

/** Dismiss open Checks cards (Undo of an Ask `propose_filing`): name a run or the targets, and optionally narrow by kind and time. */
export interface ReviewDiscardArgs {
  runId?: string;
  targets?: string[];
  kind?: ReviewCardKind;
  /** Only cards created at or after this time. */
  since?: string;
}

export type RunnerCommand =
  | { cmd: "doctor"; args: { live?: boolean } }
  | { cmd: "import"; args: ImportArgs }
  | { cmd: "index.build"; args: { full?: boolean } }
  | { cmd: "search.build"; args: { full?: boolean } }
  | { cmd: "agents.run"; args: AgentsRunArgs }
  | { cmd: "agents.status"; args: Record<string, never> }
  | { cmd: "agents.enqueue"; args: AgentsEnqueueArgs }
  | { cmd: "agents.dequeue"; args: { ids: string[] } }
  | { cmd: "review.discard"; args: ReviewDiscardArgs }
  | { cmd: "ai.ask"; args: AiAskArgs }
  | { cmd: "import.inspect"; args: InspectArgs }
  | { cmd: "import.estimate"; args: EstimateArgs }
  /** Delete only known cache file names inside the marker-bearing cache folder (never a recursive delete). */
  | { cmd: "cache.clear"; args: Record<string, never> }
  | { cmd: "ledger.compact"; args: { month?: string } }
  /** Date evidence (CORTEX-UX 5.14, 5.27): seal new entries when seals are on, and refresh git first-seen dates. */
  | { cmd: "seals.run"; args: { force?: boolean } }
  | { cmd: "seals.status"; args: Record<string, never> }
  /** The explicit "Timestamp publicly..." action: sends a hash of this computer's newest seal block, never text. */
  | { cmd: "seals.publish"; args: Record<string, never> }
  /** "Check public timestamps": asks the named calendar for each pending proof (a hash only) and verifies it against the Bitcoin block header. */
  | { cmd: "seals.check"; args: Record<string, never> }
  /** The weekly pass under the standing consent (refused unless `advanced.dateSeals.weeklyStamp` is on). */
  | { cmd: "seals.auto"; args: Record<string, never> }
  /** A proof bundle for one block (the newest when `n` is omitted); the block's salt is revealed only here. */
  | { cmd: "seals.proof"; args: { n?: number } }
  /**
   * The three packs (store/proof.ts, auditPack.ts, exportRecord.ts): each writes one zip at `out`, an absolute path the
   * person chose in the save dialog (never inside .obsidian or the record's own folder). `strings` is the offline
   * verifier's text and the pack README texts (ui/copy.ts, group `verifier`). Nothing leaves this computer.
   */
  | { cmd: "proof.entry"; args: { id: string; out: string; strings: Record<string, string> } }
  | { cmd: "audit.pack"; args: { out: string; strings: Record<string, string> } }
  | { cmd: "export.record"; args: { out: string; strings: Record<string, string>; areas: string[]; from?: string; to?: string; includeClosed: boolean; openSpaces: string[] } }
  /** "Screened on this computer": what the personal-detail screen would replace in what may be sent (read-only). */
  | { cmd: "privacy.screened"; args: { proposeNames?: boolean } }
  /** Reads counted from the read log: per grant, per item, and the items at the read limit (read-only, counts only). */
  | { cmd: "consent.reads"; args: Record<string, never> };

export type RunnerCommandName = RunnerCommand["cmd"];

/** Settings + environment the runner needs; sent with every request so the child is stateless. */
export interface RunnerContext {
  vaultRoot: string;
  vaultKey: string;
  cacheDir: string;
  settings: CortexSettings;
  /** Plugin version, for the runs ledger. */
  pluginVersion: string;
  /** Where these settings came from (recorded on every RunRecord). */
  settingsSource: "plugin" | "data.json" | "defaults";
}

// ───────────────────────────── results ─────────────────────────────

export interface SourceImportStats {
  source: SourceKind;
  label: string;
  filesSeen: number;
  filesRead: number;
  entriesAdded: number;
  conversationsTouched: number;
  skipped: number;
  bytesRead: number;
  errors: { file: string; message: string }[];
}

/** Stats of one export import (Claude.ai, ChatGPT, Gemini). */
export interface ExportImportStats extends SourceImportStats {
  /** Secrets replaced in the vault copy and kept on this computer (SAFE-10). */
  secretsHeld: number;
  /** True when the pass stopped early (deadline, pause, limit, cancel or error); run again to continue. */
  partial: boolean;
  /** Conversations left out by the person's exclusions. */
  excluded: number;
}

export interface ImportResult {
  entriesAdded: number;
  conversationsTouched: number;
  /** Complete messages of live sessions staged locally (visible now, sealed later). */
  staged: number;
  /** Secrets replaced in the vault copy and kept on this computer (SAFE-10). */
  secretsHeld: number;
  sources: SourceImportStats[];
  /** Ledger sequence after the import. */
  seq: number;
  /** True when maxSeconds stopped the pass early (run again to continue). */
  partial: boolean;
  durationMs: number;
}

export interface DoctorCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  node: string;
  runner: string;
  build: string;
  claude: {
    path: string;
    version?: string;
    flags: Record<string, boolean>;
    /** Mandatory isolation flags the CLI rejected: agents stay off while this is non-empty (SAFE-05). */
    missingMandatory: string[];
    /** Names (never values) of the environment variables a model call would receive (ENV-INHERIT). */
    envKeys: string[];
    liveCheck?: "ok" | "failed" | "skipped";
  };
  checks: DoctorCheck[];
}

export interface AgentsRunResult {
  runs: { runId: RunId; job: JobKind; status: RunStatus; tokens: number; costUsd: number; targets: number }[];
  tokensToday: number;
  /** Where the plan's 5-hour and weekly windows stand against their caps. */
  plan: Record<PlanWindowId, PlanWindowView>;
  capped: boolean;
  queued: number;
}

export interface AgentsStatusResult {
  day: string;
  tokensToday: number;
  /** Tokens reserved by calls in flight (BUDGET-RESERVE). */
  tokensReserved: number;
  /** Dollars spent today at API list prices (shown, never a limit). */
  usdToday: number;
  plan: Record<PlanWindowId, PlanWindowView>;
  capped: boolean;
  paused: boolean;
  engine: EngineState;
  resumeAt?: IsoDate;
  pending: Record<JobKind, number>;
  /** What the pending label, summary and map work is, biggest group first (absent before the first run). */
  groups?: PendingGroup[];
  /** Checks waiting (unresolved review cards). */
  checks: number;
  lastRun?: { runId: RunId; job: JobKind; status: RunStatus; finishedAt?: IsoDate };
}

/**
 * One group of the agents' pending work, so "865 items waiting" can say what they are: the vault's notes by their top
 * folder ("Vault" holds the notes at the vault's top level), wiki notes by area, chats to label, chat summaries and area
 * maps; "other" is a target the planner's catalogue no longer knows.
 */
export interface PendingGroup {
  what: "notes" | "wiki" | "chats" | "summaries" | "maps" | "other";
  /** The notes' top folder, or the wiki notes' area name. */
  where?: string;
  /** The biggest subfolders inside `where`, biggest first (at most two). */
  inside?: string[];
  /** How many subfolders hold the group's notes (more than `inside` names). */
  insideTotal?: number;
  n: number;
}

export interface AiAskResult {
  askId: string;
  runId: RunId;
  reply: string;
  citations: { id: EntryId | NoteId; quote: string }[];
  /** Schema-valid action proposals (at most 8). The plugin re-validates and executes (never the runner). */
  actions: ActionCall[];
  rejectedActions: { reason: string }[];
  /** Statements dropped because their quote could not be found. */
  droppedStatements: number;
  /** The question and reply were stored as record entries (source cortex-ask). */
  stored: { conv: string; entries: EntryId[] };
  tokens: number;
  /** The model's reason per returned action (aligned with `actions`; null when none). */
  reasons?: (string | null)[];
  /** The raw model reply when it could not be used at all ("Show the raw reply"); `reply` is then empty. */
  raw?: string;
}

export interface IndexBuildResult {
  file: string;
  /** Ordinal epoch; unchanged unless --full or the ordinal table was lost. */
  epoch: string;
  /** First ordinal of the delta file `record.delta.cxi` ([fromCount, count)); equals count when none. */
  fromCount: number;
  count: number;
  seq: number;
  /** Ordinals whose labels or flags changed in place (sent to the worker as patchIndex). */
  patched: number;
  durationMs: number;
}

export interface RunnerResultMap {
  doctor: DoctorResult;
  import: ImportResult;
  "index.build": IndexBuildResult;
  "search.build": { file: string; terms: number; docs: number; durationMs: number };
  "agents.run": AgentsRunResult;
  "agents.status": AgentsStatusResult;
  "agents.enqueue": { queued: string[] };
  "agents.dequeue": { removed: number };
  "review.discard": { discarded: number };
  "ai.ask": AiAskResult;
  "import.inspect": InspectResult;
  "import.estimate": EstimateResult;
  "cache.clear": { files: number; bytes: number };
  "ledger.compact": { files: number; bytesBefore: number; bytesAfter: number };
  "seals.run": { blocks: number; entries: number; total: number; gitChecked: number; gitFound: number };
  "seals.status": {
    blocks: number;
    entries: number;
    intact: boolean;
    lastAt?: string;
    published?: { n: number; at: string };
    /** Fingerprint of the signing key ("a1b2 c3d4 …"). */
    key?: string;
    /** Public timestamps still waiting for Bitcoin. */
    pending?: number;
    confirmed?: { n: number; height: number; at: string };
    /** What this computer sent to timestamp and block services: one row per kind and host. */
    outward?: { kind: "stamp" | "check" | "header"; to: string; count: number; auto: number; first: string; last: string }[];
  };
  "seals.publish": { n: number; at: string; calendar: string; already: boolean };
  "seals.check": { checked: number; confirmed: number; pending: number; failed: number; unreachable: boolean; height?: number };
  "seals.auto": { enabled: boolean; stamped: boolean; checked: boolean };
  "seals.proof": { n: number; json: string };
  "proof.entry": { files: number; bytes: number; block: number; stamped: boolean; confirmed: boolean };
  "audit.pack": { files: number; bytes: number; blocks: number; anchors: number };
  "export.record": { files: number; bytes: number; entries: number; skippedClosed: number; excluded: number; unreadable: number; unsealed: number; /** The grant the export was made under (Require a grant is on). */ grant?: string };
  "privacy.screened": ScreenedSummary;
  "consent.reads": ConsentReads;
}

// ───────────────────────────── errors ─────────────────────────────

export type RunnerErrorCode =
  | "E_BAD_REQUEST"
  | "E_PROTOCOL"
  | "E_LOCKED"
  | "E_CANCELLED"
  | "E_TIMEOUT"
  | "E_NODE_MISSING"
  | "E_ENGINE_MISSING"
  | "E_ENGINE_AUTH"
  /** Subscription usage limit (5-hour or weekly window): pause the scheduler until `resumeAt`, never retry. */
  | "E_ENGINE_LIMIT"
  | "E_ENGINE_FAILED"
  /** data.json exists but cannot be read or trusted: import and agents refuse to run (fail closed). */
  | "E_SETTINGS"
  | "E_BUDGET_CAPPED"
  | "E_PAUSED"
  | "E_VALIDATION"
  | "E_PATH_DENIED"
  | "E_IO"
  | "E_PARSE"
  | "E_INTERNAL";

export interface RunnerErrorInfo {
  code: RunnerErrorCode;
  message: string;
  retryable: boolean;
  detail?: Record<string, unknown>;
}

// ───────────────────────────── events ─────────────────────────────

/** Engine health shown by the agent chip, the status bar and the Agents status card (M1). */
export type EngineState = "ok" | "offline" | "auth" | "missing" | "limit" | "unsafe";

/** Fixed warning catalogue; UI copy per code lives in ui/copy.ts (warnings.*). */
export type WarningCode =
  | "node-missing"
  | "runner-unavailable"
  | "index-failed"
  | "onedrive-conflict-copy"
  | "not-local"
  | "changed-at-source"
  | "settings-unreadable"
  | "export-not-recognised"
  | "export-older"
  | "export-empty"
  | "takeout-html"
  | "export-truncated"
  | "path-unreadable"
  | "skipped-not-session"
  | "secret-held"
  | "injection-signal"
  | "cli-flag-rejected";

export type RunnerEvent =
  | { kind: "entries-added"; count: number; conversations: number; sources: SourceKind[]; seq: number; live: boolean }
  | { kind: "index-built"; file: string; seq: number; count: number }
  | { kind: "search-built"; file: string; seq: number }
  | { kind: "job-started"; job: JobKind; runId: RunId; targets: number; model: string }
  | { kind: "job-finished"; job: JobKind; runId: RunId; status: RunStatus; tokens: number; costUsd: number }
  | { kind: "budget"; day: string; tokensToday: number; usdToday?: number; plan: Record<PlanWindowId, PlanWindowView>; capped: boolean }
  | { kind: "labels-added"; count: number; seq: number }
  | { kind: "notes-written"; paths: string[]; seq: number }
  | { kind: "review-cards"; count: number }
  | { kind: "engine-state"; state: EngineState; resumeAt?: IsoDate }
  | { kind: "warning"; code: WarningCode; detail?: Record<string, string | number> };

// ───────────────────────────── frames ─────────────────────────────

export type ToRunner =
  | { t: "req"; id: string; ctx: RunnerContext; command: RunnerCommand }
  | { t: "cancel"; id: string }
  | { t: "ping"; n: number }
  | { t: "shutdown" };

export type FromRunner =
  | { t: "hello"; protocol: typeof RUNNER_PROTOCOL_VERSION; runner: string; build: string; node: string; pid: number; mode: "child" | "worker" | "inline" | "cli" }
  | { t: "progress"; id: string; phase: string; done: number; total?: number; unit?: string; note?: string }
  | { t: "event"; id?: string; event: RunnerEvent }
  | { t: "result"; id: string; ok: true; cmd: RunnerCommandName; data: RunnerResultMap[RunnerCommandName] }
  | { t: "error"; id?: string; error: RunnerErrorInfo }
  | { t: "pong"; n: number }
  | { t: "log"; level: "debug" | "info" | "warn" | "error"; msg: string };

/** Max bytes of one frame line; larger frames are a protocol error (results reference files instead). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/**
 * Watchdog (WATCHDOG-THROTTLE): the parent pings every 15 s; the child is restarted only when an OUTSTANDING ping
 * (pong.n matched to the last ping's n) is unanswered for 30 s measured from when it was actually sent. Any
 * stdout frame counts as a sign of life, and the check is suspended while document.visibilityState is "hidden"
 * (Obsidian's renderer timers are throttled then); the child's exit event still restarts it.
 */
export const PING_INTERVAL_MS = 15_000;
export const PING_TIMEOUT_MS = 30_000;
/** After a cancel the runner must answer within this time or be killed. */
export const CANCEL_GRACE_MS = 5_000;

export function isFromRunner(x: unknown): x is FromRunner {
  if (typeof x !== "object" || x === null) return false;
  const t = (x as { t?: unknown }).t;
  return t === "hello" || t === "progress" || t === "event" || t === "result" || t === "error" || t === "pong" || t === "log";
}

export function isToRunner(x: unknown): x is ToRunner {
  if (typeof x !== "object" || x === null) return false;
  const t = (x as { t?: unknown }).t;
  return t === "req" || t === "cancel" || t === "ping" || t === "shutdown";
}
