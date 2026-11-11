/**
 * Ask: questions and changes (CORTEX-UX §5.10, §12.7). Owner: E6.
 *
 * ask(question, {threadId, viewId, onlyVerb}) → AsyncIterable<AskEvent>:
 *   1. retrieval: worker search over the record + the leaf's context (scope, period, tokens, selection) →
 *      ≤ 40 candidates as ids and titles only (H10: the RUNNER reads text, applies the privacy policy and writes
 *      the ReadRecord, so there is one enforcement point);
 *   2. runner "ai.ask" with the console thread → progress events from a fixed catalogue ("Reading 38 passages…"),
 *      cancellable by Stop (`cancel(askId)`), timeout agents.askTimeoutSec (90 s);
 *   3. every action is re-validated here (validateActionCall) plus semantic checks (ids exist, ≤ 500 targets,
 *      ≤ 200 for refresh, dims known, ranges sane, a slash command's onlyVerb); at most 8 actions per reply;
 *      invalid ones show as declined with a catalogue reason;
 *   4. view actions apply at once (undo = the leaf's view snapshot, session only); data actions follow
 *      needsApply() (include and correct_entry always ask; refresh and propose_filing show an Apply card with
 *      Cortex's own token and item estimate); applying writes CorrectionRecords (via "ask") and a change
 *      (ReceiptRecord) whose summary Cortex writes from validated params and resolved targets, never from model
 *      text; a model `reason` is stored separately and shown labelled "The AI's reason";
 *   5. Undo of a data change never expires (Change history keeps it); redo() re-applies the last undone change;
 *   6. the runner stores the exchange as record entries of source `cortex-ask` under .raw/chats/cortex-ask/
 *      (drawn only when the leaf's Layers › Ask history is on) and never offers them back to agent jobs or
 *      retrieval by default.
 *
 * The executor takes its collaborators (AssistantDeps): the runner client, the receipts ledger, the ledger reader,
 * the corrections service, the index, the worker, the record reader, the settings, the shared store (budget) and
 * a port to the leaf stores. It never writes a file itself: machine notes are written by the runner's notes writer
 * (the agent jobs that `refresh` queues) and left-out notes are placed by the corrections service.
 */
import { ACTION_CALL_SCHEMA, ACTION_SPECS, MAX_ACTIONS_PER_REPLY, MAX_ITEMS_PER_ACTION, MAX_REFRESH_ITEMS, needsApply, verbAllowed, type ActionCall, type ActionName, type OnlyVerb } from "../shared/actions";
import { builtinDim, isLabelDim, type DimId } from "../shared/dims";
import { CortexError, isCortexError } from "../shared/errors";
import { compareIds, newReceiptId, sortableBody } from "../shared/ids";
import { NONE32, NOTE_KIND_ORDER, SPACE_ORDER } from "../shared/index-format";
import type { Logger } from "../shared/log";
import { findPack, labelValueFits, normaliseLabelValue } from "../shared/packs";
import type { AiAskArgs, AiAskResult, AiCandidate, AiContextSnapshot, AiTurn } from "../shared/protocol/runner";
import type { QueryToken, TimeWindow } from "../shared/protocol/worker";
import { sha256Hex } from "../shared/sha256";
import { SOURCE_KINDS, type CorrectionId, type IsoDate, type LabelValue, type ReceiptRecord, type ReceiptState, type SpaceId } from "../shared/types";
import { formatIssues, validate } from "../shared/validate";
import { chartDef, PAGE_IDS, type PageId, type ReaderRoute, type SheetPageRoute } from "../shared/views";
import { addToken, closeSheet, openPage, openTab, pushSheet } from "../state/actions";
import { visibilityParams } from "../state/selectors";
import type { CortexStore, SharedStore } from "../state/store";
import type { ReceiptView } from "../state/types";
import { t } from "../ui/copy";
import { chartAvailable, chartSpecFor } from "../ui/stage/ShapeBar";
import type { CorrectionService } from "./corrections";
import type { IndexService } from "./indexer";
import type { RunnerClient } from "./runnerClient";
import type { AskExchange, LedgerService, RecordReader, SettingsHandle } from "./services";
import type { WorkerClient } from "./workerClient";

// ───────────────────────────── contract ─────────────────────────────

export type DeclineReason = "invalid" | "too-broad" | "not-allowed" | "too-many-actions";
export type ActionCheck = { ok: true; call: ActionCall; changesData: boolean; needsApply: boolean } | { ok: false; reason: DeclineReason; detail?: string; count?: number };

export interface ValidateOptions {
  /** Settings › Agents › "Apply Ask's changes without asking". */
  applyWithoutConfirm?: boolean;
  /** A slash command's verb: every other verb is rejected. */
  onlyVerb?: OnlyVerb;
}

/** Schema-level validation of a model-proposed action, plus the item limits, onlyVerb and the Apply rule. */
export function validateActionCall(raw: unknown, opts: ValidateOptions = {}): ActionCheck {
  const r = validate<ActionCall>(ACTION_CALL_SCHEMA, raw);
  if (!r.ok) return { ok: false, reason: "invalid", detail: formatIssues(r.issues) };
  const call = r.value;
  if (!verbAllowed(call.action, opts.onlyVerb)) return { ok: false, reason: "not-allowed" };
  const p = call.params as { targets?: unknown[]; ids?: unknown[] };
  const n = Math.max(p.targets?.length ?? 0, p.ids?.length ?? 0);
  if (n > MAX_ITEMS_PER_ACTION) return { ok: false, reason: "too-broad", count: n };
  return { ok: true, call, changesData: ACTION_SPECS[call.action].changesData, needsApply: needsApply(call.action, opts.applyWithoutConfirm ?? false) };
}

/** Validate a whole reply's action list (≤ 8 actions). */
export function validateActions(raws: readonly unknown[], opts: ValidateOptions = {}): ActionCheck[] {
  const checks = raws.slice(0, MAX_ACTIONS_PER_REPLY).map((r) => validateActionCall(r, opts));
  for (let i = MAX_ACTIONS_PER_REPLY; i < raws.length; i++) checks.push({ ok: false, reason: "too-many-actions" });
  return checks;
}

/** A resolved refresh target set larger than this is "Too broad". */
export function refreshTooBroad(resolvedItems: number): boolean {
  return resolvedItems > MAX_REFRESH_ITEMS;
}

export type AskErrorCode = "timeout" | "missing" | "auth" | "capped" | "paused" | "offline" | "limit" | "invalid-reply" | "too-broad" | "not-allowed" | "cancelled" | "sample" | "no-grant";

/** Progress and error texts come from the copy catalogue (ask.*, agents.*), never model text. */
export type AskEvent =
  | { kind: "progress"; key: "reading" | "thinking" | "still-working"; askId: string; count?: number }
  | { kind: "reply"; outcome: AskOutcome }
  | { kind: "error"; code: AskErrorCode; raw?: string; resumeAt?: string };

export interface AskOutcome {
  askId: string;
  reply: string;
  citations: { ordinal: number; id: string; quote: string }[];
  changes: ReceiptView[];
  declined: { reason: string; count?: number }[];
  droppedStatements: number;
}

export interface AskExchangeView {
  askId: string;
  threadId: string;
  /** The stored question and reply entries (each can be left out like any entry). */
  questionEntry: string;
  replyEntry: string;
  at: IsoDate;
  question: string;
  reply: string;
  changes: ReceiptView[];
}

export type ChangeFilter = "view" | "data" | "agents";

/** What Undo would also revert (a later change that touched the same item). */
export interface UndoPreview {
  alsoUndoes: { id: string; at: string; summary: string }[];
}

export interface AssistantExecutor {
  ask(question: string, opts: { threadId: string; viewId: string; onlyVerb?: OnlyVerb; chart?: boolean }): AsyncIterable<AskEvent>;
  cancel(askId: string): void;
  apply(receiptId: string): Promise<ReceiptView>;
  reject(receiptId: string): Promise<ReceiptView>;
  /** `both` also undoes later changes that touched the same item (see undoPreview). */
  undo(receiptId: string, opts?: { both?: boolean }): Promise<ReceiptView>;
  undoPreview(receiptId: string): Promise<UndoPreview>;
  /** Ctrl Shift Z: re-apply the last undone change. */
  redo(): Promise<ReceiptView | null>;
  /** Change history (§5.30.5): changes by day with their state, filterable by View · Data · Agents. */
  changes(range: { from?: IsoDate; to?: IsoDate; filter?: ChangeFilter }): Promise<ReceiptView[]>;
  /** Ask history: past exchanges by day. */
  history(range: { from?: IsoDate; to?: IsoDate }): Promise<AskExchangeView[]>;
  /** Up to three "Try" suggestions generated from the user's own recent record (ORIG-08). */
  suggestions(): Promise<string[]>;
}

/** Where the leaf stores are reached from (the container owns them). */
export interface AskLeafPort {
  store(viewId: string): CortexStore | undefined;
}

export interface AssistantDeps {
  runner: Pick<RunnerClient, "request">;
  /** The receipts ledger (upsert by id, highest seq wins). */
  ledger: { append(ledger: "receipts", records: readonly ReceiptRecord[]): Promise<number> };
  reader: Pick<LedgerService, "changes" | "askHistory" | "invalidate">;
  corrections: Pick<CorrectionService, "apply" | "undo" | "exclude" | "include" | "list" | "leftOut">;
  index: Pick<IndexService, "index" | "meta" | "ordinalOf">;
  worker: Pick<WorkerClient, "call">;
  records: Pick<RecordReader, "entryText">;
  settings: Pick<SettingsHandle, "value">;
  /** Receipts slice (the console) and the activity slice (today's tokens against the cap). */
  shared: SharedStore;
  leaves: AskLeafPort;
  sandbox: () => boolean;
  now?: () => number;
  log?: Logger;
}

// ───────────────────────────── limits and helpers ─────────────────────────────

const CANDIDATE_MAX = 40;
const HISTORY_TURNS = 20;
const STILL_WORKING_MS = 20_000;
const RECEIPT_SLICE_MAX = 60;
const DAY_MS = 86_400_000;
const ENGINE_REPLY_SLACK_MS = 15_000;
const VIEW_VERBS: ReadonlySet<ActionName> = new Set<ActionName>(["trace", "set_period", "open_view", "arrange", "make_chart"]);

/**
 * Sheet params for an open_view tab. Read's "today" and "pinned" are filter toggles, not tabs (views.ts ReadToggle):
 * passed as `tab` they fell back to the date list, so "open today" showed every entry.
 */
export function viewParams(tab: string | undefined): Record<string, string> | undefined {
  if (!tab) return undefined;
  return tab === "today" || tab === "pinned" ? { [tab]: "1" } : { tab };
}
const BUDGET_VERBS: ReadonlySet<ActionName> = new Set<ActionName>(["refresh", "propose_filing"]);
const READER_ROUTES: readonly string[] = ["entry", "conversation", "note", "map", "vault-peek", "thread"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Local midnight of an ISO date, or NaN. A date such as 2026-02-31 is rejected rather than rolled over. */
function dayStart(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return Number.NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(y, mo, d);
  return dt.getFullYear() === y && dt.getMonth() === mo && dt.getDate() === d ? dt.getTime() : Number.NaN;
}

function dayKey(ms: number): IsoDate {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** "2–8 Nov 2026" within one month, "30 Oct – 2 Nov 2026" across months, the year on both ends across years. */
export function rangeText(a: number, b: number): string {
  const x = new Date(a);
  const y = new Date(b);
  const part = (d: Date, year: boolean): string => `${d.getDate()} ${MONTHS[d.getMonth()]}${year ? ` ${d.getFullYear()}` : ""}`;
  if (x.getFullYear() !== y.getFullYear()) return `${part(x, true)} – ${part(y, true)}`;
  if (x.getMonth() !== y.getMonth()) return `${part(x, false)} – ${part(y, true)}`;
  return x.getDate() === y.getDate() ? part(y, true) : `${x.getDate()}–${part(y, true)}`;
}

const trim = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function dimKnown(dim: string): boolean {
  if (isLabelDim(dim as DimId)) return /^label:[a-z0-9-]+\/[A-Za-z0-9_-]+$/.test(dim);
  return builtinDim(dim as DimId) !== undefined || /^(day|week|month|year)(:imported)?$|^(hour|weekday)$/.test(dim);
}

/** Cortex's own estimate for re-reading conversations: ≈ 3.5 characters per token plus the summary's output. */
export function estimateRefresh(words: readonly number[]): { tokens: number; items: number } {
  let tokens = 0;
  for (const w of words) tokens += Math.min(14_000, Math.ceil((Math.max(0, w) * 5.5 + 3_500) / 3.5) + 1_600) + 300;
  return { tokens, items: words.length };
}

function fmtTokens(n: number): string {
  const rounded = n >= 1_000 ? Math.round(n / 1_000) * 1_000 : Math.round(n / 10) * 10;
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

interface ResolvedAction {
  call: ActionCall;
  summary: string;
  /** Item keys the change touches, used to tell a later change to the same thing. */
  keys: string[];
  targets: number;
  /** Action-specific data kept in the receipt (resolved ids, never model text). */
  data: Record<string, unknown>;
  estimate?: { tokens: number; items: number };
}

type Resolve = { ok: true; value: ResolvedAction } | { ok: false; reason: DeclineReason; count?: number };
const decline = (reason: DeclineReason, count?: number): Resolve => ({ ok: false, reason, ...(count !== undefined ? { count } : {}) });
const accept = (v: ResolvedAction): Resolve => ({ ok: true, value: v });

/** Persisted shape of ReceiptRecord.params. */
interface ReceiptParams {
  call: ActionCall;
  data: Record<string, unknown>;
  keys: string[];
  estimate?: { tokens: number; items: number };
  queued?: string[];
}

/** A change made or loaded this session; view changes live only here. */
interface SessionChange {
  record: ReceiptRecord;
  viewId: string;
  snapshot?: ReturnType<CortexStore["snapshot"]>;
}

function paramsOf(rec: ReceiptRecord): ReceiptParams | null {
  const p = rec.params as Partial<ReceiptParams> | null;
  if (!p || typeof p !== "object" || !p.call || typeof p.call !== "object") return null;
  return { call: p.call, data: p.data ?? {}, keys: p.keys ?? [], ...(p.estimate ? { estimate: p.estimate } : {}), ...(p.queued ? { queued: p.queued } : {}) };
}

function filterOf(rec: ReceiptRecord): ChangeFilter {
  if (VIEW_VERBS.has(rec.action as ActionName)) return "view";
  return BUDGET_VERBS.has(rec.action as ActionName) ? "agents" : "data";
}

// ───────────────────────────── the executor ─────────────────────────────

/**
 * Executor over real collaborators. Called without them (a container that has not been wired yet, see
 * docs/rfcs/E6.md) Ask reports "missing" and nothing else happens.
 */
export function createAssistantExecutor(deps?: AssistantDeps): AssistantExecutor {
  return deps ? new Executor(deps) : createUnwiredExecutor();
}

function createUnwiredExecutor(): AssistantExecutor {
  const unwired = (): never => {
    throw new CortexError("E_INTERNAL", "the assistant has no services yet");
  };
  return {
    async *ask() {
      yield { kind: "error", code: "missing" };
    },
    cancel: () => undefined,
    apply: async () => unwired(),
    reject: async () => unwired(),
    undo: async () => unwired(),
    undoPreview: async () => ({ alsoUndoes: [] }),
    redo: async () => null,
    changes: async () => [],
    history: async () => [],
    suggestions: async () => [],
  };
}

class Executor implements AssistantExecutor {
  private readonly session = new Map<string, SessionChange>();
  private readonly undone: string[] = [];
  private readonly threads = new Map<string, AiTurn[]>();
  private readonly running = new Map<string, AbortController>();
  private readonly seqs = new Map<string, number>();

  constructor(private readonly d: AssistantDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  // ───────────── ask ─────────────

  cancel(askId: string): void {
    this.running.get(askId)?.abort();
  }

  async *ask(question: string, opts: { threadId: string; viewId: string; onlyVerb?: OnlyVerb; chart?: boolean }): AsyncGenerator<AskEvent> {
    const d = this.d;
    const text = question.trim();
    if (d.sandbox()) return void (yield { kind: "error", code: "sample" });
    if (text.length === 0) return void (yield { kind: "error", code: "invalid-reply" });
    const agents = d.settings.value.agents;
    if (agents.paused) return void (yield { kind: "error", code: "paused" });
    if (d.shared.get("activity").capped && agents.askCountsTowardCap) return void (yield { kind: "error", code: "capped" });
    const store = d.leaves.store(opts.viewId);
    const askId = `a_${sortableBody(this.now())}`;
    const threadId = /^[A-Za-z0-9_-]{1,80}$/.test(opts.threadId) ? opts.threadId : `t_${sortableBody(this.now())}`;
    const candidates = await this.candidates(text, opts.viewId, store);
    yield { kind: "progress", key: "reading", askId, count: candidates.length };
    const timeoutSec = Math.max(10, Math.min(600, Math.round(agents.askTimeoutSec)));
    const args: AiAskArgs = {
      askId,
      threadId,
      question: text,
      context: this.context(store),
      candidates,
      history: (this.threads.get(threadId) ?? []).slice(-HISTORY_TURNS),
      timeoutSec,
      ...(opts.onlyVerb !== undefined ? { onlyVerb: opts.onlyVerb } : {}),
      ...(opts.chart && store?.get("view").chart ? { chart: this.chartOf(store) } : {}),
    };
    const ctl = new AbortController();
    this.running.set(askId, ctl);
    let timedOut = false;
    const guard = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, timeoutSec * 1000 + ENGINE_REPLY_SLACK_MS);
    const request = d.runner.request({ cmd: "ai.ask", args }, { signal: ctl.signal }).then(
      (value) => ({ value }) as const,
      (error: unknown) => ({ error }) as const,
    );
    let still: ReturnType<typeof setTimeout> | undefined;
    let settled: Awaited<typeof request>;
    try {
      const stillWorking = new Promise<"still">((res) => {
        still = setTimeout(() => res("still"), STILL_WORKING_MS);
      });
      const first = await Promise.race([request, stillWorking]);
      if (first === "still") {
        yield { kind: "progress", key: "still-working", askId };
        settled = await request;
      } else settled = first;
    } finally {
      clearTimeout(guard);
      if (still) clearTimeout(still);
      this.running.delete(askId);
    }
    if ("error" in settled) return void (yield timedOut ? { kind: "error", code: "timeout" } : this.errorEvent(settled.error, ctl.signal.aborted));
    const res = settled.value as AiAskResult & { reasons?: (string | null)[]; raw?: string };
    if (res.reply.length === 0 && res.actions.length === 0) {
      const raw = typeof res.raw === "string" ? res.raw.slice(0, 4_000) : undefined;
      return void (yield { kind: "error", code: "invalid-reply", ...(raw !== undefined ? { raw } : {}) });
    }
    const outcome = await this.finish(askId, res, store, opts);
    const turns = this.threads.get(threadId) ?? [];
    turns.push({ role: "you", text: trim(text, 2_000) }, { role: "assistant", text: trim(res.reply, 2_000) });
    this.threads.set(threadId, turns.slice(-HISTORY_TURNS));
    yield { kind: "reply", outcome };
  }

  private errorEvent(e: unknown, aborted: boolean): AskEvent {
    if (isCortexError(e)) {
      switch (e.code) {
        case "E_TIMEOUT":
          return { kind: "error", code: "timeout" };
        case "E_CANCELLED":
          return { kind: "error", code: "cancelled" };
        case "E_ENGINE_MISSING":
        case "E_NODE_MISSING":
          return { kind: "error", code: "missing" };
        case "E_ENGINE_AUTH":
          return { kind: "error", code: "auth" };
        case "E_BUDGET_CAPPED":
          return { kind: "error", code: "capped" };
        case "E_ENGINE_LIMIT": {
          const at = e.detail?.["resumeAt"];
          return { kind: "error", code: "limit", ...(typeof at === "string" ? { resumeAt: at } : {}) };
        }
        case "E_PAUSED":
          return { kind: "error", code: e.detail?.["reason"] === "no-grant" ? "no-grant" : "paused" };
        default:
          return { kind: "error", code: "offline" };
      }
    }
    this.d.log?.warn("ask failed", { message: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    return { kind: "error", code: aborted ? "cancelled" : "offline" };
  }

  private chartOf(store: CortexStore): NonNullable<AiAskArgs["chart"]> {
    const c = store.get("view").chart;
    const period = store.get("ui").period;
    return {
      chart: c?.chart ?? "",
      ...(c?.x ? { x: c.x.dim } : {}),
      ...(c?.y ? { y: c.y.dim } : {}),
      ...(c?.colour ? { colour: c.colour } : {}),
      ...(period ? { period: [dayKey(period[0]), dayKey(period[1])] as [IsoDate, IsoDate] } : {}),
    };
  }

  /** What the leaf shows, for the model: scope, period, selection, grouping and the values it may name. */
  private context(store: CortexStore | undefined): AiContextSnapshot {
    const today = dayKey(this.now());
    if (!store) return { space: "all", page: "brain", vocabulary: { space: [...SPACE_ORDER] }, today };
    const ui = store.get("ui");
    const sel = store.get("selection");
    const idx = this.d.index.index.peek();
    const vocabulary: Record<string, string[]> = { space: [...SPACE_ORDER] };
    if (idx) {
      const take = (table: { size: number; get(i: number): string }): string[] => {
        const out: string[] = [];
        for (let i = 0; i < Math.min(table.size, 40); i++) {
          const v = table.get(i);
          if (v) out.push(v);
        }
        return out;
      };
      vocabulary["project"] = take(idx.dicts.projects);
      vocabulary["folder"] = take(idx.dicts.folders);
    }
    return {
      space: ui.scope,
      page: ui.tab,
      ...(ui.period ? { period: [dayKey(ui.period[0]), dayKey(ui.period[1])] as [IsoDate, IsoDate] } : {}),
      ...(sel ? { selection: sel.id } : {}),
      groupBy: store.get("view").groupBy,
      vocabulary,
      today,
    };
  }

  /** Retrieval: ids and titles only, best first, never the console's own earlier exchanges. */
  private async candidates(question: string, viewId: string, store: CortexStore | undefined): Promise<AiCandidate[]> {
    const d = this.d;
    const out: AiCandidate[] = [];
    const seen = new Set<string>();
    const push = (ordinal: number): void => {
      if (out.length >= CANDIDATE_MAX) return;
      const m = d.index.meta(ordinal);
      if (!m || seen.has(m.id) || m.source === "cortex-ask" || !/^(e|n|w)_/.test(m.id)) return;
      seen.add(m.id);
      out.push({ id: m.id as AiCandidate["id"], kind: m.mapKind !== undefined ? "map" : m.population === "note" ? "note" : "entry", title: trim(m.title, 120) });
    };
    const sel = store?.get("selection");
    if (sel) push(sel.ordinal);
    if (store) {
      try {
        const res = await d.worker.call(`${viewId}:ask`, "search", { query: question, limit: CANDIDATE_MAX, visibility: visibilityParams(store.get("ui"), store.get("view")) });
        for (let i = 0; i < res.ordinals.length && out.length < CANDIDATE_MAX; i++) push(res.ordinals[i] as number);
      } catch (e) {
        d.log?.warn("ask retrieval failed", { message: e instanceof Error ? e.message.slice(0, 160) : "unknown" });
      }
    }
    return out;
  }

  // ───────────── reply → changes ─────────────

  private async finish(askId: string, res: AiAskResult & { reasons?: (string | null)[] }, store: CortexStore | undefined, opts: { viewId: string; onlyVerb?: OnlyVerb }): Promise<AskOutcome> {
    const d = this.d;
    const checks = validateActions(res.actions, { applyWithoutConfirm: d.settings.value.agents.applyAskWithoutConfirm, ...(opts.onlyVerb !== undefined ? { onlyVerb: opts.onlyVerb } : {}) });
    const declined: { reason: string; count?: number }[] = res.rejectedActions.map((r) => ({ reason: r.reason }));
    const changes: ReceiptView[] = [];
    for (let i = 0; i < checks.length; i++) {
      const check = checks[i] as ActionCheck;
      if (!check.ok) {
        declined.push({ reason: check.reason, ...(check.count !== undefined ? { count: check.count } : {}) });
        continue;
      }
      const resolved = await this.resolve(check.call, store, opts.viewId);
      if (!resolved.ok) {
        declined.push({ reason: resolved.reason, ...(resolved.count !== undefined ? { count: resolved.count } : {}) });
        continue;
      }
      const raw = res.reasons?.[i];
      const reason = typeof raw === "string" && raw.trim().length > 0 ? trim(raw.trim().replace(/\s+/g, " "), 400) : undefined;
      try {
        changes.push(await this.record(askId, resolved.value, reason, check.needsApply, store, opts.viewId));
      } catch (e) {
        d.log?.warn("a change could not be applied", { action: check.call.action, message: e instanceof Error ? e.message.slice(0, 160) : "unknown" });
        declined.push({ reason: "invalid" });
      }
    }
    return { askId, reply: res.reply, citations: res.citations.map((c, i) => ({ ordinal: i + 1, id: c.id, quote: c.quote })), changes, declined, droppedStatements: res.droppedStatements };
  }

  /** Write the receipt (data changes persist), then apply at once unless the action waits for Apply. */
  private async record(askId: string, r: ResolvedAction, reason: string | undefined, waits: boolean, store: CortexStore | undefined, viewId: string): Promise<ReceiptView> {
    const params: ReceiptParams = { call: r.call, data: r.data, keys: r.keys, ...(r.estimate ? { estimate: r.estimate } : {}) };
    const rec: ReceiptRecord = {
      v: 1,
      id: newReceiptId(this.now()),
      seq: 1,
      askId,
      action: r.call.action,
      params,
      summary: r.summary,
      ...(reason !== undefined ? { reason } : {}),
      targets: r.targets,
      state: "proposed",
      corrections: [],
      expiresAt: null,
      at: new Date(this.now()).toISOString(),
    };
    const change: SessionChange = { record: rec, viewId };
    this.session.set(rec.id, change);
    if (waits) {
      await this.persist(change);
      return this.view(rec);
    }
    return this.view((await this.run(change, store)).record);
  }

  // ───────────── semantic checks ─────────────

  private exists(id: string): boolean {
    if (this.d.index.ordinalOf(id) >= 0) return true;
    const idx = this.d.index.index.peek();
    return idx !== null && id.startsWith("c_") && idx.convs.rowOf(id) >= 0;
  }

  private titleOf(id: string): string {
    const ord = this.d.index.ordinalOf(id);
    const m = ord >= 0 ? this.d.index.meta(ord) : undefined;
    if (m?.title) return trim(m.title, 80);
    const idx = this.d.index.index.peek();
    const row = idx && id.startsWith("c_") ? idx.convs.rowOf(id) : -1;
    return idx && row >= 0 ? trim(idx.convs.get(row).title || id, 80) : id;
  }

  /** The conversations (and loose notes) behind a selection or a period, for refresh and propose_filing. */
  private async items(store: CortexStore | undefined, viewId: string, scope: "selection" | "period" | "no-area", period?: [IsoDate, IsoDate]): Promise<{ ids: string[]; words: number[] } | null> {
    const d = this.d;
    if (!store) return null;
    const ui = store.get("ui");
    const sel = store.get("selection");
    const tokens: QueryToken[] = [];
    if (scope === "period") {
      const a = period ? dayStart(period[0]) : (ui.period?.[0] ?? Number.NaN);
      const b = period ? dayStart(period[1]) + DAY_MS - 1 : (ui.period?.[1] ?? Number.NaN);
      if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
      tokens.push({ id: "ask-period", kind: "time", label: "period", range: [a, b] });
    } else if (scope === "selection") {
      if (ui.tokens.length === 0 && !sel) return null;
      tokens.push(...ui.tokens);
    }
    const ordinals: number[] = [];
    if (scope === "selection" && ui.tokens.length === 0 && sel) ordinals.push(sel.ordinal);
    else {
      const res = await d.worker.call(`${viewId}:ask`, "query", { tokens, visibility: visibilityParams(ui, store.get("view")) });
      for (let i = 0; i < res.ordinals.length; i++) ordinals.push(res.ordinals[i] as number);
    }
    const words = new Map<string, number>();
    for (const o of ordinals) {
      const m = d.index.meta(o);
      if (!m || m.source === "cortex-ask") continue;
      if (scope === "no-area" && m.space !== "none") continue;
      const key = m.conversation?.id ?? (m.population === "note" ? m.id : undefined);
      if (key === undefined || !/^(c|n)_/.test(key)) continue;
      words.set(key, (words.get(key) ?? 0) + m.words);
    }
    return { ids: [...words.keys()], words: [...words.values()] };
  }

  private async resolve(call: ActionCall, store: CortexStore | undefined, viewId: string): Promise<Resolve> {
    const d = this.d;
    const settings = d.settings.value;
    switch (call.action) {
      case "trace": {
        if (!store) return decline("not-allowed");
        const p = call.params;
        const ids = (p.ids ?? []).filter((id) => this.exists(id));
        if (!p.query && ids.length === 0 && (p.filters?.length ?? 0) === 0) return decline("invalid");
        if ((p.filters ?? []).some((f) => !dimKnown(f.dim))) return decline("invalid");
        const tokens = this.traceTokens(p, ids);
        const ui = store.get("ui");
        let entries = 0;
        let notes = 0;
        try {
          const res = await d.worker.call(`${viewId}:ask`, "query", { tokens: [...ui.tokens, ...tokens], visibility: visibilityParams(ui, store.get("view")) });
          for (let i = 0; i < res.ordinals.length; i++) {
            const m = d.index.meta(res.ordinals[i] as number);
            if (m?.population === "note") notes++;
            else if (m) entries++;
          }
        } catch {
          entries = ids.length;
        }
        const range = ui.period ? rangeText(ui.period[0], ui.period[1]) : t("read.allTime");
        return accept({ call, summary: t("changes.traced", { entries, notes, range }), keys: [], targets: entries + notes, data: { tokens } });
      }
      case "set_period": {
        const a = dayStart(call.params.start);
        const b = dayStart(call.params.end);
        if (Number.isNaN(a) || Number.isNaN(b) || b < a) return decline("invalid");
        const window: TimeWindow = [a, b + DAY_MS - 1];
        return accept({ call, summary: t("changes.period", { range: rangeText(a, b) }), keys: [], targets: 0, data: { window } });
      }
      case "open_view": {
        if (!store) return decline("not-allowed");
        const p = call.params;
        if (READER_ROUTES.includes(p.view)) {
          if (!p.id || !this.exists(p.id)) return decline("invalid");
        } else if (p.id !== undefined) return decline("invalid");
        return accept({ call, summary: t("changes.opened", { page: p.id ? this.titleOf(p.id) : p.view }), keys: [], targets: 0, data: {} });
      }
      case "arrange": {
        if (!store || !dimKnown(call.params.by)) return decline("invalid");
        return accept({ call, summary: t("changes.arranged", { dim: call.params.by }), keys: [], targets: 0, data: {} });
      }
      case "make_chart": {
        if (!store) return decline("not-allowed");
        const p = call.params;
        if (!chartAvailable(chartDef(p.chart))) return decline("not-allowed");
        if ([p.x, p.y, p.colour, p.filter?.dim].some((dim) => dim !== undefined && !dimKnown(dim))) return decline("invalid");
        return accept({ call, summary: t("changes.charted", { chart: t(`charts.${p.chart}`) }), keys: [], targets: 0, data: {} });
      }
      case "correct_entry": {
        const p = call.params;
        const ord = d.index.ordinalOf(p.entryId);
        if (ord < 0) return decline("invalid");
        const cur = await d.records.entryText(ord);
        if (!cur.ok || cur.text === p.newText) return decline("invalid");
        return accept({ call, summary: t("changes.corrected"), keys: [p.entryId], targets: 1, data: { fromVersion: cur.version } });
      }
      case "set_date": {
        const p = call.params;
        if (!this.exists(p.target)) return decline("invalid");
        if (p.date !== null && Number.isNaN(dayStart(p.date))) return decline("invalid");
        return accept({ call, summary: t("changes.redated", { date: p.date === null ? "—" : p.date.slice(0, 10) }), keys: [p.target], targets: 1, data: {} });
      }
      case "set_speaker": {
        if (!this.exists(call.params.target)) return decline("invalid");
        return accept({ call, summary: t("changes.speaker", { speaker: call.params.speaker }), keys: [call.params.target], targets: 1, data: {} });
      }
      case "set_label": {
        const p = call.params;
        const def = findPack(p.pack)?.fields.find((f) => f.key === p.field);
        if (!def) return decline("invalid");
        const value = normaliseLabelValue(def, p.value);
        if (!labelValueFits(def, value)) return decline("invalid");
        const targets = [...new Set(p.targets)].filter((id) => this.exists(id));
        if (targets.length === 0) return decline("invalid");
        return accept({ call, summary: t("changes.relabelled", { n: targets.length }), keys: targets, targets: targets.length, data: { targets, value } });
      }
      case "merge_groups": {
        const p = call.params;
        if (!dimKnown(p.dim) || p.from === p.into) return decline("invalid");
        return accept({ call, summary: t("changes.merged", { a: trim(p.from, 60), b: trim(p.into, 60) }), keys: [`${p.dim}:${p.from}`, `${p.dim}:${p.into}`], targets: 1, data: {} });
      }
      case "refile": {
        const p = call.params;
        if (!this.exists(p.target)) return decline("invalid");
        if (p.area === undefined && p.folder === undefined && p.project === undefined) return decline("invalid");
        if (p.area !== undefined && !(SPACE_ORDER as readonly string[]).includes(p.area)) return decline("invalid");
        const place = trim(p.area ?? p.folder ?? p.project ?? "none", 80);
        return accept({ call, summary: t("changes.refiled", { place }), keys: [p.target], targets: 1, data: {} });
      }
      case "exclude": {
        const p = call.params;
        if (p.scope === "source" ? !(SOURCE_KINDS as readonly string[]).includes(p.target) : !this.exists(p.target)) return decline("invalid");
        if (d.corrections.leftOut().some((l) => l.target === p.target)) return decline("invalid");
        return accept({ call, summary: t("changes.leftOut", { title: p.scope === "source" ? p.target : this.titleOf(p.target) }), keys: [p.target], targets: 1, data: {} });
      }
      case "include": {
        const left = d.corrections.leftOut().find((l) => l.target === call.params.target);
        if (!left) return decline("invalid");
        return accept({ call, summary: t("changes.broughtBack", { title: this.titleOf(left.target) }), keys: [left.target], targets: 1, data: { excludeCorrectionId: left.correctionId } });
      }
      case "pin": {
        if (!this.exists(call.params.target)) return decline("invalid");
        return accept({ call, summary: t("changes.pinned", { title: this.titleOf(call.params.target) }), keys: [call.params.target], targets: 1, data: {} });
      }
      case "refresh":
      case "propose_filing": {
        if (!settings.agents.enabled || settings.agents.paused) return decline("not-allowed");
        const period = call.action === "refresh" ? call.params.period : undefined;
        const found = await this.items(store, viewId, call.params.scope, period);
        if (!found || found.ids.length === 0) return decline("invalid");
        if (found.ids.length > (call.action === "refresh" ? MAX_REFRESH_ITEMS : MAX_ITEMS_PER_ACTION)) return decline("too-broad", found.ids.length);
        const estimate = estimateRefresh(found.words);
        const summary = call.action === "refresh" ? t("changes.queued", { n: found.ids.length, tokens: fmtTokens(estimate.tokens) }) : t("changes.suggested", { n: found.ids.length });
        return accept({ call, summary, keys: found.ids, targets: found.ids.length, data: { ids: found.ids }, estimate });
      }
    }
  }

  private traceTokens(p: { query?: string; ids?: string[]; filters?: { dim: DimId; value: string }[] }, ids: string[]): QueryToken[] {
    const seq = this.now().toString(36);
    const out: QueryToken[] = [];
    if (p.query) out.push({ id: `ask-${seq}-q`, kind: "text", label: trim(p.query, 60), text: p.query });
    if (ids.length > 0) out.push({ id: `ask-${seq}-s`, kind: "set", label: ids.length === 1 ? this.titleOf(ids[0] as string) : String(ids.length), ids });
    (p.filters ?? []).forEach((f, i) => out.push({ id: `ask-${seq}-g${i}`, kind: "group", label: trim(f.value, 60), dim: f.dim, value: f.value }));
    return out;
  }

  // ───────────── running a change ─────────────

  private async persist(change: SessionChange): Promise<void> {
    if (!VIEW_VERBS.has(change.record.action as ActionName)) {
      await this.d.ledger.append("receipts", [change.record]);
      this.d.reader.invalidate();
    }
    this.publish();
  }

  private async setState(change: SessionChange, state: ReceiptState, patch: Partial<ReceiptRecord> = {}): Promise<SessionChange> {
    const seq = (this.seqs.get(change.record.id) ?? change.record.seq) + 1;
    this.seqs.set(change.record.id, seq);
    change.record = { ...change.record, ...patch, state, seq };
    this.session.set(change.record.id, change);
    await this.persist(change);
    return change;
  }

  /** Apply a proposed (or redone) change. A failure leaves the receipt "failed". */
  private async run(change: SessionChange, store: CortexStore | undefined): Promise<SessionChange> {
    const d = this.d;
    if (d.sandbox()) throw new CortexError("E_BAD_REQUEST", t("ask.sample"));
    const p = paramsOf(change.record);
    if (!p) throw new CortexError("E_BAD_REQUEST", "the change has no parameters");
    try {
      if (VIEW_VERBS.has(p.call.action)) {
        const target = store ?? d.leaves.store(change.viewId);
        if (!target) throw new CortexError("E_BAD_REQUEST", "the view is gone");
        change.snapshot = target.snapshot();
        this.applyView(p.call, p, target);
        return await this.setState(change, "applied");
      }
      const done = await this.applyData(change.record, p.call, p);
      return await this.setState(change, "applied", { corrections: done.corrections, ...(done.queued ? { params: { ...p, queued: done.queued } } : {}) });
    } catch (e) {
      await this.setState(change, "failed").catch(() => undefined);
      throw e;
    }
  }

  private applyView(call: ActionCall, p: ReceiptParams, store: CortexStore): void {
    switch (call.action) {
      case "trace":
        store.batch(() => {
          for (const tok of (p.data["tokens"] as QueryToken[] | undefined) ?? []) addToken(store, tok);
        });
        return;
      case "set_period":
        store.update("ui", { period: p.data["window"] as TimeWindow });
        return;
      case "open_view": {
        const { view, tab, id } = call.params;
        if (id !== undefined) {
          const ord = this.d.index.ordinalOf(id);
          if (ord >= 0) store.update("selection", () => ({ ordinal: ord, id }));
          pushSheet(store, { kind: "reader", route: view as ReaderRoute, id });
        } else if ((PAGE_IDS as readonly string[]).includes(view)) {
          openTab(store, view as PageId);
          const extra = viewParams(tab);
          if (extra) store.update("ui", (ui) => ({ ...ui, sheet: { ...ui.sheet, stack: ui.sheet.stack.map((e, i) => (i === ui.sheet.index && e.kind === "page" ? { ...e, params: { ...(e.params ?? {}), ...extra } } : e)) } }));
        } else openPage(store, view as SheetPageRoute, viewParams(tab));
        if (view === "brain") closeSheet(store);
        return;
      }
      case "arrange":
        store.batch(() => {
          store.update("view", (v) => ({ ...v, groupBy: call.params.by, shape: "groups", morph: 1, ...(call.params.layout ? { layout: call.params.layout } : {}) }));
          store.update("ui", { hiddenGroups: [] });
        });
        return;
      case "make_chart": {
        const q = call.params;
        const base = chartSpecFor(q.chart, store.get("view").chart, store.get("view").groupBy);
        const spec = {
          ...base,
          chart: q.chart,
          ...(q.x ? { x: { dim: q.x, sort: base.x.sort } } : {}),
          ...(q.y ? { y: { dim: q.y, sort: "count" as const } } : {}),
          ...(q.colour ? { colour: q.colour } : {}),
          ...(q.size ? { size: q.size } : {}),
          ...(q.filter ? { filter: [q.filter] } : {}),
        };
        store.update("view", (v) => ({ ...v, chart: spec, shape: "chart", morph: 1 }));
        return;
      }
      default:
        return;
    }
  }

  private async applyData(rec: ReceiptRecord, call: ActionCall, p: ReceiptParams): Promise<{ corrections: CorrectionId[]; queued?: string[] }> {
    const c = this.d.corrections;
    const reason = `ask:${rec.id}`;
    const ids: CorrectionId[] = [];
    switch (call.action) {
      case "correct_entry":
        ids.push((await c.apply({ via: "ask", action: "edit-text", target: call.params.entryId, reason, payload: { newText: call.params.newText, newTextSha256: sha256Hex(call.params.newText), fromVersion: Number(p.data["fromVersion"]), version: 0 } })).id);
        break;
      case "set_date":
        ids.push((await c.apply({ via: "ask", action: "set-date", target: call.params.target, reason, payload: { writtenAt: call.params.date } })).id);
        break;
      case "set_speaker":
        ids.push((await c.apply({ via: "ask", action: "set-speaker", target: call.params.target, reason, payload: { speaker: call.params.speaker } })).id);
        break;
      case "set_label": {
        const pack = findPack(call.params.pack);
        if (!pack) throw new CortexError("E_BAD_REQUEST", "unknown pack");
        for (const target of (p.data["targets"] as string[] | undefined) ?? []) {
          ids.push((await c.apply({ via: "ask", action: "set-label", target, reason, payload: { pack: pack.id, packVersion: pack.version, field: call.params.field, value: p.data["value"] as LabelValue } })).id);
        }
        break;
      }
      case "merge_groups":
        ids.push((await c.apply({ via: "ask", action: "merge-groups", target: call.params.dim, reason, payload: { dim: call.params.dim, from: call.params.from, into: call.params.into } })).id);
        break;
      case "refile": {
        const q = call.params;
        const payload: { space?: SpaceId; folder?: string[]; project?: string | null } = {};
        if (q.area !== undefined) payload.space = q.area as SpaceId;
        if (q.folder !== undefined) payload.folder = q.folder.split("/").filter((s) => s.length > 0);
        if (q.project !== undefined) payload.project = q.project;
        ids.push((await c.apply({ via: "ask", action: "refile", target: q.target, reason, payload })).id);
        break;
      }
      case "exclude":
        ids.push((await c.exclude(call.params.target, call.params.scope, "ask")).id);
        break;
      case "include":
        ids.push((await c.include(String(p.data["excludeCorrectionId"]) as CorrectionId, "ask")).id);
        break;
      case "pin":
        ids.push((await c.apply({ via: "ask", action: "pin", target: call.params.target, reason, payload: {} })).id);
        break;
      case "refresh":
      case "propose_filing": {
        const agents = this.d.settings.value.agents;
        if (!agents.enabled || agents.paused) throw new CortexError("E_PAUSED", "agents are off or paused");
        const res = await this.d.runner.request({ cmd: "agents.enqueue", args: { jobs: call.action === "refresh" ? ["label", "gist"] : ["filing"], targets: (p.data["ids"] as string[] | undefined) ?? [], reason: "refresh" } });
        return { corrections: ids, queued: res.queued };
      }
      default:
        throw new CortexError("E_BAD_REQUEST", "that action is not a data change");
    }
    return { corrections: ids };
  }

  // ───────────── apply, reject, undo, redo ─────────────

  private async find(id: string): Promise<SessionChange> {
    const hit = this.session.get(id);
    if (hit) return hit;
    const rec = (await this.d.reader.changes({})).find((r) => r.id === id);
    if (!rec) throw new CortexError("E_BAD_REQUEST", "that change is not in the history");
    const change: SessionChange = { record: rec, viewId: "" };
    this.session.set(id, change);
    return change;
  }

  async apply(receiptId: string): Promise<ReceiptView> {
    const change = await this.find(receiptId);
    if (change.record.state !== "proposed") throw new CortexError("E_BAD_REQUEST", "that change is not waiting for Apply");
    return this.view((await this.run(change, undefined)).record);
  }

  async reject(receiptId: string): Promise<ReceiptView> {
    const change = await this.find(receiptId);
    if (change.record.state !== "proposed") throw new CortexError("E_BAD_REQUEST", "that change is not waiting for Apply");
    return this.view((await this.setState(change, "rejected")).record);
  }

  /** Later applied changes that touched the same items (Undo then asks for "Undo both"). */
  private async later(change: SessionChange): Promise<SessionChange[]> {
    const mine = new Set(paramsOf(change.record)?.keys ?? []);
    if (mine.size === 0) return [];
    const all = new Map<string, SessionChange>();
    for (const r of await this.d.reader.changes({})) all.set(r.id, this.session.get(r.id) ?? { record: r, viewId: "" });
    for (const [id, c] of this.session) all.set(id, c);
    const out: SessionChange[] = [];
    for (const c of all.values()) {
      const r = c.record;
      if (r.id === change.record.id || r.state !== "applied") continue;
      if (r.at < change.record.at || (r.at === change.record.at && compareIds(r.id, change.record.id) < 0)) continue;
      if ((paramsOf(r)?.keys ?? []).some((k) => mine.has(k))) out.push(c);
    }
    return out.sort((a, b) => (a.record.at < b.record.at ? 1 : a.record.at > b.record.at ? -1 : compareIds(a.record.id, b.record.id) < 0 ? 1 : -1));
  }

  async undoPreview(receiptId: string): Promise<UndoPreview> {
    const change = await this.find(receiptId);
    return { alsoUndoes: (await this.later(change)).map((c) => ({ id: c.record.id, at: c.record.at, summary: c.record.summary })) };
  }

  async undo(receiptId: string, opts: { both?: boolean } = {}): Promise<ReceiptView> {
    const change = await this.find(receiptId);
    if (change.record.state !== "applied") throw new CortexError("E_BAD_REQUEST", "that change is not applied");
    const later = await this.later(change);
    if (later.length > 0 && !opts.both) throw new CortexError("E_BAD_REQUEST", "a later change touched the same item", { detail: { alsoUndoes: later.map((c) => c.record.id) } });
    for (const c of later) await this.undoOne(c);
    return this.view((await this.undoOne(change)).record);
  }

  private async undoOne(change: SessionChange): Promise<SessionChange> {
    const rec = change.record;
    const p = paramsOf(rec);
    if (p && VIEW_VERBS.has(p.call.action)) {
      const store = this.d.leaves.store(change.viewId);
      if (!store || !change.snapshot) throw new CortexError("E_BAD_REQUEST", "the view is gone");
      store.restore(change.snapshot);
    } else {
      if (p?.queued && p.queued.length > 0) await this.d.runner.request({ cmd: "agents.dequeue", args: { ids: p.queued } });
      // Checks the filing jobs already wrote and nobody has answered yet go too, so Undo leaves nothing behind.
      const filed = p?.call.action === "propose_filing" ? ((p.data["ids"] as string[] | undefined) ?? []) : [];
      if (filed.length > 0) await this.d.runner.request({ cmd: "review.discard", args: { targets: filed, kind: "filing", since: rec.at } });
      const reversed = new Set(this.d.corrections.list().flatMap((r) => (r.undoes !== undefined ? [r.undoes] : [])));
      for (const id of [...rec.corrections].reverse()) if (!reversed.has(id)) await this.d.corrections.undo(id, "ask");
    }
    const next = await this.setState(change, "undone");
    this.undone.push(rec.id);
    return next;
  }

  async redo(): Promise<ReceiptView | null> {
    while (this.undone.length > 0) {
      const change = this.session.get(this.undone.pop() as string);
      if (change && change.record.state === "undone") return this.view((await this.run(change, undefined)).record);
    }
    return null;
  }

  // ───────────── history, suggestions, views ─────────────

  private view(rec: ReceiptRecord): ReceiptView {
    const estimate = paramsOf(rec)?.estimate;
    return {
      id: rec.id,
      askId: rec.askId,
      action: rec.action,
      summary: rec.summary,
      ...(rec.reason !== undefined ? { reason: rec.reason } : {}),
      state: rec.state,
      canUndo: rec.state === "applied",
      needsApply: rec.state === "proposed",
      spendsBudget: BUDGET_VERBS.has(rec.action as ActionName),
      ...(estimate ? { estimate } : {}),
      at: rec.at,
    };
  }

  private publish(): void {
    const list = [...this.session.values()].map((c) => c.record).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : compareIds(a.id, b.id) < 0 ? -1 : 1));
    this.d.shared.update("receipts", () => list.slice(-RECEIPT_SLICE_MAX).map((r) => this.view(r)));
  }

  async changes(range: { from?: IsoDate; to?: IsoDate; filter?: ChangeFilter }): Promise<ReceiptView[]> {
    const rows = new Map<string, ReceiptRecord>();
    for (const r of await this.d.reader.changes({ ...(range.from !== undefined ? { from: range.from } : {}), ...(range.to !== undefined ? { to: range.to } : {}) })) rows.set(r.id, r);
    for (const [id, c] of this.session) {
      const day = c.record.at.slice(0, 10);
      if ((range.from === undefined || day >= range.from.slice(0, 10)) && (range.to === undefined || day <= range.to.slice(0, 10))) rows.set(id, c.record);
    }
    return [...rows.values()]
      .filter((r) => range.filter === undefined || filterOf(r) === range.filter)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : compareIds(a.id, b.id) < 0 ? 1 : -1))
      .map((r) => this.view(r));
  }

  async history(range: { from?: IsoDate; to?: IsoDate }): Promise<AskExchangeView[]> {
    const d = this.d;
    const exchanges: AskExchange[] = await d.reader.askHistory(range);
    const read = async (entry: string): Promise<string> => {
      const ord = entry ? d.index.ordinalOf(entry) : -1;
      if (ord < 0) return "";
      const r = await d.records.entryText(ord);
      return r.ok ? r.text : "";
    };
    const out: AskExchangeView[] = [];
    for (const x of exchanges) out.push({ askId: x.askId, threadId: x.threadId, questionEntry: x.questionEntry, replyEntry: x.replyEntry, at: x.at, question: await read(x.questionEntry), reply: await read(x.replyEntry), changes: x.changes.map((r) => this.view(this.session.get(r.id)?.record ?? r)) });
    return out;
  }

  /** Up to three "Try" prompts from the record itself, without a model call (CORTEX-UX §5.10). */
  async suggestions(): Promise<string[]> {
    const idx = this.d.index.index.peek();
    if (!idx || idx.count === 0 || this.d.sandbox()) return [];
    const now = this.now();
    const today = new Date(now);
    const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const out: string[] = [];
    let longest: { title: string; n: number } | undefined;
    for (let i = 0; i < idx.convs.size; i++) {
      const row = idx.convs.get(i);
      if (row.title && row.endedAt >= midnight - DAY_MS && row.endedAt < midnight && (!longest || row.entryCount > longest.n)) longest = { title: row.title, n: row.entryCount };
    }
    if (longest) out.push(t("ask.tryDecided", { title: trim(longest.title, 60) }));
    const weekEnd = midnight - ((today.getDay() + 6) % 7) * DAY_MS;
    const questionKind = NOTE_KIND_ORDER.indexOf("question");
    const open = new Map<string, number>();
    const lastTouch = new Map<number, number>();
    const c = idx.cols;
    for (let i = 0; i < idx.count; i++) {
      const when = c.t[i] as number;
      if (c.noteKind[i] === questionKind && questionKind >= 0 && when >= weekEnd - 7 * DAY_MS && when < weekEnd) {
        const space = SPACE_ORDER[c.space[i] as number];
        if (space && space !== "none") open.set(space, (open.get(space) ?? 0) + 1);
      }
      const project = c.project[i] as number;
      if (project !== NONE32 && !Number.isNaN(when)) lastTouch.set(project, Math.max(lastTouch.get(project) ?? 0, when));
    }
    const busiest = [...open.entries()].sort((a, b) => b[1] - a[1])[0];
    if (busiest) out.push(t("ask.tryOpen", { area: busiest[0] }));
    const active = [...lastTouch.entries()].filter(([, at]) => at >= now - 90 * DAY_MS).sort((a, b) => a[1] - b[1])[0];
    if (active) out.push(t("ask.tryProject", { project: idx.dicts.projects.get(active[0]) }));
    return out.slice(0, 3);
  }
}
