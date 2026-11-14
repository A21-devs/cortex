/**
 * LedgerService implementation (M4). Owner: E2. Runs in the plugin (Node fs), read-only.
 * Agents (runs, 14-day budget history, per-source done/waiting/checked), Checks (unresolved review cards and
 * today's counts), the Access log (reads aggregated per model and route: items read, first, last), change
 * history (receipts) and Ask history are read from the ledgers through small aggregate caches in
 * `<cache>/agg/` invalidated by the cache signal. Pages never scan ledgers on the UI thread.
 *
 * An aggregate is stored with a signature of the files it was built from (path, size, mtime), so a stale
 * aggregate is never served: `invalidate()` only drops the in-memory copies, the signature does the rest.
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { ensureCacheDir, errCode, readJsonIfExists, writeJsonAtomic } from "../node/fsAtomic";
import { cacheWritablePath, resolveInVault } from "../node/paths";
import type { AccessRow, AskExchange, BudgetDayView, LedgerService } from "../plugin/services";
import { CortexError } from "../shared/errors";
import { compareIds } from "../shared/ids";
import type { Logger } from "../shared/log";
import { localDayKey, parseIso } from "../shared/time";
import type {
  ConversationRecord,
  CorrectionRecord,
  EntryRecord,
  IsoDate,
  LabelRecord,
  ReadRecord,
  ReceiptRecord,
  ReviewCardRecord,
  RunRecord,
  SourceKind,
} from "../shared/types";
import { budgetPath, CACHE_REL, cacheLayout, type LedgerName } from "./layout";
import { latestBySeq, listLedgerFiles, streamJsonl } from "./ledger";
import { loadSourceManifest } from "./manifest";

export interface LedgerReaderDeps {
  vaultRoot: string;
  cacheDir: string;
  log: Logger;
  /** Clock for "today"; default Date.now. */
  now?: () => number;
}

/** Chat sources count conversations; vault notes and documents count their entries (passages join their document). */
const WORK_SOURCES: readonly SourceKind[] = ["claude-code", "chatgpt", "claude-ai", "gemini", "obsidian", "files", "notion", "google-docs", "codex-cli", "gemini-cli", "cursor", "whatsapp", "telegram", "discord", "slack", "zoom", "keep", "evernote", "roam", "kindle", "capture"];
const CONVERSATION_SOURCES: ReadonlySet<SourceKind> = new Set<SourceKind>(["claude-code", "chatgpt", "claude-ai", "gemini", "codex-cli", "gemini-cli", "cursor", "whatsapp", "telegram", "discord", "slack", "zoom", "capture"]);
const UNSURE_BELOW = 0.6;

type WorkWaiting = Awaited<ReturnType<LedgerService["workWaiting"]>>;
const ACCESS_IDS_MAX = 5000;

type Aggregate = "access" | "work" | "unanswered";

/**
 * How each aggregate is computed, by version: bump one when its counting changes, so the copy saved on disk (keyed by the
 * ledgers' sizes and times, which did not change) is not served. work v2: only the agents' work waits (leftAlone);
 * v3: the vault's notes are the agents' work again (they label them).
 */
const AGGREGATE_VERSION: Readonly<Record<Aggregate, string>> = { access: "v1", work: "v3", unanswered: "v1" };

interface Cached<T> {
  sig: string;
  value: T;
}

async function signatureOf(vaultRoot: string, ledgers: readonly (LedgerName | "corrections")[]): Promise<string> {
  const parts: string[] = [];
  for (const l of ledgers) {
    for (const f of await listLedgerFiles(vaultRoot, l)) {
      try {
        const st = await fsp.stat(f.abs);
        parts.push(`${f.file}:${st.size}:${Math.floor(st.mtimeMs)}`);
      } catch {
        parts.push(`${f.file}:gone`);
      }
    }
  }
  return parts.join("|");
}

async function* streamLedger<T>(vaultRoot: string, ledger: LedgerName | "corrections"): AsyncGenerator<T> {
  for (const f of await listLedgerFiles(vaultRoot, ledger)) yield* streamJsonl<T>(f.abs);
}

/** Corrections that still stand: those no other correction undoes. */
function standing(all: readonly CorrectionRecord[]): CorrectionRecord[] {
  const undone = new Set<string>();
  for (const c of all) if (c.undoes) undone.add(c.undoes);
  return all.filter((c) => !undone.has(c.id));
}

export function routeOf(engine: string, where: string): string {
  if (where === "this computer") return "this computer";
  if (engine === "claude-cli") return "Claude Code → Anthropic";
  if (engine === "anthropic-api") return "Anthropic API → Anthropic";
  if (engine === "codex-cli") return "Codex CLI → OpenAI";
  if (engine === "fake") return "test engine";
  return "Anthropic";
}

export function createLedgerReader(deps?: LedgerReaderDeps): LedgerService {
  const need = (): LedgerReaderDeps => {
    if (!deps) throw new CortexError("E_INTERNAL", "LedgerService was created without a vault folder");
    return deps;
  };
  const memory = new Map<Aggregate, Cached<unknown>>();

  async function cached<T>(name: Aggregate, ledgers: readonly (LedgerName | "corrections")[], build: () => Promise<T>): Promise<T> {
    const d = need();
    // The aggregate's own version leads the signature: a saved aggregate an earlier build computed another way is rebuilt.
    const sig = `${AGGREGATE_VERSION[name]}|${await signatureOf(d.vaultRoot, ledgers)}`;
    const mem = memory.get(name) as Cached<T> | undefined;
    if (mem && mem.sig === sig) return mem.value;
    const file = path.join(cacheLayout(d.cacheDir).agg, `${name}.json`);
    try {
      const disk = await readJsonIfExists<Cached<T>>(file);
      if (disk && disk.sig === sig && disk.value !== undefined) {
        memory.set(name, disk);
        return disk.value;
      }
    } catch {
      /* unreadable aggregate: rebuild */
    }
    const value = await build();
    const entry: Cached<T> = { sig, value };
    memory.set(name, entry);
    try {
      await ensureCacheDir(d.cacheDir);
      await writeJsonAtomic(cacheWritablePath(d.cacheDir, CACHE_REL.agg(name)), entry);
    } catch (e) {
      d.log.warn("could not save an aggregate", { name, code: errCode(e) });
    }
    return value;
  }

  /** Cards with whether each is still open (not resolved by a standing correction that targets it). */
  async function cards(): Promise<{ card: ReviewCardRecord; open: boolean }[]> {
    const d = need();
    const stands = standing(await collect<CorrectionRecord>(d.vaultRoot, "corrections"));
    const targeted = new Set(stands.map((c) => c.target));
    const latest = new Map<string, ReviewCardRecord>();
    for await (const rc of streamLedger<ReviewCardRecord>(d.vaultRoot, "review")) latest.set(rc.id, rc);
    return [...latest.values()].map((card) => ({ card, open: card.resolvedBy === undefined && card.dismissedAt === undefined && !targeted.has(card.id) }));
  }

  return {
    async runs(filter) {
      const d = need();
      const latest = new Map<string, RunRecord>();
      for await (const r of streamLedger<RunRecord>(d.vaultRoot, "runs")) latest.set(r.id, r);
      const from = filter.from === undefined ? Number.NEGATIVE_INFINITY : parseIso(filter.from);
      const to = filter.to === undefined ? Number.POSITIVE_INFINITY : parseIso(filter.to);
      const out: RunRecord[] = [];
      for (const r of latest.values()) {
        if (filter.job !== undefined && r.job !== filter.job) continue;
        if (filter.model !== undefined && r.model !== filter.model) continue;
        if (filter.status !== undefined && r.status !== filter.status) continue;
        const t = parseIso(r.startedAt);
        if (t < from || t > to) continue;
        out.push(r);
      }
      out.sort((a, b) => (a.startedAt === b.startedAt ? (compareIds(a.id, b.id) < 0 ? 1 : -1) : a.startedAt < b.startedAt ? 1 : -1));
      return out.slice(0, Math.max(0, filter.limit));
    },

    async budgetHistory(days) {
      const d = need();
      const n = Math.max(0, Math.floor(days));
      let raw: unknown = null;
      try {
        raw = JSON.parse(await fsp.readFile(resolveInVault(d.vaultRoot, budgetPath()), "utf8"));
      } catch (e) {
        if (errCode(e) !== "ENOENT") d.log.warn("budget file unreadable for the history", { code: errCode(e) });
      }
      const byDay = new Map<string, BudgetDayView>();
      const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
      const view = (r: Record<string, unknown>): BudgetDayView | null => {
        if (typeof r.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r.day)) return null;
        const tokens = num(r.tokens) + num(r.reserved);
        const cap = num(r.cap);
        const usd = num(r.usd);
        return { day: r.day, tokens, ...(usd > 0 ? { usd } : {}), capped: r.capped === true || r.unknown === true || (cap > 0 && tokens >= cap) };
      };
      if (raw && typeof raw === "object") {
        const b = raw as { today?: unknown; history?: unknown };
        if (Array.isArray(b.history)) {
          for (const h of b.history) {
            const v = h && typeof h === "object" ? view(h as Record<string, unknown>) : null;
            if (v) byDay.set(v.day, v);
          }
        }
        const t = b.today && typeof b.today === "object" ? view(b.today as Record<string, unknown>) : null;
        if (t) byDay.set(t.day, t);
      }
      const out: BudgetDayView[] = [];
      const clock = (d.now ?? Date.now)();
      for (let i = n - 1; i >= 0; i--) {
        const day = localDayKey(clock - i * 86_400_000);
        out.push(byDay.get(day) ?? { day, tokens: 0, capped: false });
      }
      return out;
    },

    async accessLog() {
      const d = need();
      return cached<AccessRow[]>("access", ["reads"], async () => {
        const rows = new Map<string, AccessRow & { firstT: number; lastT: number }>();
        for await (const r of streamLedger<ReadRecord>(d.vaultRoot, "reads")) {
          const route = routeOf(r.engine, r.where);
          const key = `${r.model}\u0000${route}`;
          const t = parseIso(r.at);
          const items = (r.entryIds?.length ?? 0) + (r.noteIds?.length ?? 0);
          const row = rows.get(key);
          if (!row) {
            rows.set(key, { model: r.model, route, itemsRead: items, first: r.at, last: r.at, firstT: t, lastT: t });
            continue;
          }
          row.itemsRead += items;
          if (t < row.firstT) {
            row.firstT = t;
            row.first = r.at;
          }
          if (t > row.lastT) {
            row.lastT = t;
            row.last = r.at;
          }
        }
        return [...rows.values()]
          .sort((a, b) => b.itemsRead - a.itemsRead || (a.model < b.model ? -1 : 1))
          .map(({ firstT: _f, lastT: _l, ...row }) => row);
      });
    },

    async accessIds(model, route) {
      const d = need();
      const entries = new Set<string>();
      const notes = new Set<string>();
      for await (const r of streamLedger<ReadRecord>(d.vaultRoot, "reads")) {
        if (r.model !== model || routeOf(r.engine, r.where) !== route) continue;
        for (const id of r.entryIds ?? []) if (entries.size < ACCESS_IDS_MAX) entries.add(id);
        for (const id of r.noteIds ?? []) if (notes.size < ACCESS_IDS_MAX) notes.add(id);
      }
      return { entries: [...entries], notes: [...notes] };
    },

    async checks(filter) {
      const out: ReviewCardRecord[] = [];
      for (const { card, open } of await cards()) {
        if (!open) continue;
        if (filter.kind === "unsure") {
          if (!(typeof card.confidence === "number" && card.confidence < UNSURE_BELOW)) continue;
        } else if (filter.kind !== undefined && card.kind !== filter.kind) continue;
        out.push(card);
      }
      out.sort((a, b) => (a.createdAt === b.createdAt ? (compareIds(a.id, b.id) < 0 ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
      return out.slice(0, Math.max(0, filter.limit));
    },

    async checksToday() {
      const d = need();
      const today = localDayKey((d.now ?? Date.now)());
      const all = await cards();
      const ids = new Set<string>(all.map((c) => c.card.id));
      const answered = new Set<string>();
      for (const c of standing(await collect<CorrectionRecord>(d.vaultRoot, "corrections"))) {
        if (ids.has(c.target) && localDayKey(parseIso(c.at)) === today) answered.add(c.target);
      }
      return { checked: answered.size, waiting: all.filter((c) => c.open).length };
    },

    async changes(range) {
      const d = need();
      const latest = latestBySeq(await collect<ReceiptRecord>(d.vaultRoot, "receipts"));
      return [...latest.values()].filter((r) => inRange(r.at, range)).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.seq - a.seq));
    },

    async askHistory(range) {
      const d = need();
      const asks = new Map<string, { threadId: string; question?: EntryRecord; reply?: EntryRecord }>();
      for await (const e of streamLedger<EntryRecord>(d.vaultRoot, "entries")) {
        if (e.source !== "cortex-ask") continue;
        const native = e.sourceRef?.nativeId;
        const m = typeof native === "string" ? /^(.+):(q|a)$/.exec(native) : null;
        if (!m) continue;
        const askId = m[1] as string;
        const slot = asks.get(askId) ?? { threadId: threadOf(e) };
        if (m[2] === "q") slot.question = e;
        else slot.reply = e;
        asks.set(askId, slot);
      }
      const receipts = new Map<string, ReceiptRecord[]>();
      for (const r of latestBySeq(await collect<ReceiptRecord>(d.vaultRoot, "receipts")).values()) {
        const list = receipts.get(r.askId) ?? [];
        list.push(r);
        receipts.set(r.askId, list);
      }
      const out: AskExchange[] = [];
      for (const [askId, a] of asks) {
        if (!a.question) continue;
        const at: IsoDate = a.question.writtenAt ?? a.question.addedAt;
        if (!inRange(at, range)) continue;
        out.push({
          askId,
          threadId: a.threadId,
          at,
          questionEntry: a.question.id,
          replyEntry: a.reply?.id ?? "",
          changes: (receipts.get(askId) ?? []).sort((x, y) => (x.at < y.at ? -1 : 1)),
        });
      }
      return out.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.askId < y.askId ? 1 : -1));
    },

    async packsUnanswered() {
      const d = need();
      return cached<Record<string, number>>("unanswered", ["labels"], async () => {
        // The latest record per target, pack version and field decides: a later answer clears an earlier gap.
        const latest = new Map<string, LabelRecord>();
        for await (const l of streamLedger<LabelRecord>(d.vaultRoot, "labels")) latest.set(`${l.target}|${l.pack}@${l.packVersion}|${l.field}`, l);
        const out: Record<string, number> = {};
        for (const l of latest.values()) {
          if (l.state !== "unanswered" || l.supersededBy !== undefined) continue;
          const key = `${l.pack}@${l.packVersion}`;
          out[key] = (out[key] ?? 0) + 1;
        }
        return out;
      });
    },

    async workWaiting() {
      const d = need();
      return cached<WorkWaiting>("work", ["conversations", "entries", "labels", "review", "corrections"], async () => {
        const labelled = new Set<string>();
        const labelTarget = new Map<string, string>();
        for await (const l of streamLedger<LabelRecord>(d.vaultRoot, "labels")) {
          labelled.add(l.target);
          labelTarget.set(l.id, l.target);
        }
        const checked = new Set<string>();
        // The person's own speaker fixes, as the planner reads them.
        const speakers = new Map<string, string>();
        for (const c of standing(await collect<CorrectionRecord>(d.vaultRoot, "corrections"))) {
          if (c.action === "set-speaker") {
            const sp = (c.payload as { speaker?: unknown }).speaker;
            if (typeof sp === "string") speakers.set(c.target, sp);
            continue;
          }
          if (c.action !== "confirm" && c.action !== "set-label" && c.action !== "reject-label") continue;
          checked.add(c.target);
          const p = c.payload as { labelId?: string };
          const t = p.labelId ? labelTarget.get(p.labelId) : undefined;
          if (t) checked.add(t);
        }
        const all = await cards();
        let openChecks = 0;
        for (const c of all) {
          if (c.open) openChecks++;
          else checked.add(c.card.target);
        }
        const totals = new Map<SourceKind, { checked: number; done: number; waiting: number }>();
        const bump = (source: SourceKind, id: string): void => {
          const row = totals.get(source) ?? { checked: 0, done: 0, waiting: 0 };
          if (checked.has(id)) row.checked++;
          else if (labelled.has(id)) row.done++;
          else row.waiting++;
          totals.set(source, row);
        };
        let summaries = 0;
        let label = 0;
        // What the agents leave as it is: it is never "waiting" (it would hold the queue and the Organised meter forever).
        let sessionsLeft = 0;
        let notesLeft = 0;
        const fromYou = new Set<string>();
        const visible = new Map<string, number>();
        const seen = new Set<string>();
        const docs: { source: SourceKind; unit: string }[] = [];
        // An edited note's older entry (named by the newer one) is no longer anyone's work.
        const replaced = new Set<string>();
        let first: string | undefined;
        for await (const e of streamLedger<EntryRecord>(d.vaultRoot, "entries")) {
          if (first === undefined || e.addedAt < first) first = e.addedAt;
          if (e.supersedes) replaced.add(e.supersedes);
          if (e.hiddenByDefault !== undefined) continue;
          if (e.conv !== undefined) {
            // A conversation is the agents' work only with a visible message from the person (the planner's rule): a
            // session an agent or a tool started has none.
            visible.set(e.conv, (visible.get(e.conv) ?? 0) + 1);
            if ((speakers.get(e.id) ?? e.speaker) === "you") fromYou.add(e.conv);
            continue;
          }
          if (e.source !== "obsidian" && e.source !== "files") continue;
          const unit = e.passage?.doc ?? e.id;
          if (seen.has(unit)) continue;
          seen.add(unit);
          docs.push({ source: e.source, unit });
        }
        for (const doc of docs) {
          if (replaced.has(doc.unit)) continue;
          // The vault's notes are the agents' work (they give each a role); imported files are not: those count once
          // someone labelled or checked them, otherwise they are left alone.
          if (doc.source === "obsidian") {
            bump(doc.source, doc.unit);
            if (!checked.has(doc.unit) && !labelled.has(doc.unit)) label++;
          } else if (checked.has(doc.unit) || labelled.has(doc.unit)) bump(doc.source, doc.unit);
          else notesLeft++;
        }
        const convs = latestBySeq<ConversationRecord>(await collect<ConversationRecord>(d.vaultRoot, "conversations"));
        for (const c of convs.values()) {
          if (!CONVERSATION_SOURCES.has(c.source)) continue;
          if (!fromYou.has(c.id)) {
            if (checked.has(c.id) || labelled.has(c.id)) bump(c.source, c.id);
            else sessionsLeft++;
            continue;
          }
          bump(c.source, c.id);
          if (!checked.has(c.id) && !labelled.has(c.id)) label++;
          // A summary needs two visible messages (the planner's rule).
          if (c.gistNoteId === undefined && (visible.get(c.id) ?? 0) >= 2) summaries++;
        }
        let since: IsoDate | undefined;
        try {
          const manifest = await loadSourceManifest({ vaultRoot: d.vaultRoot });
          for (const s of Object.values(manifest.sources)) if (since === undefined || s.importedAt < since) since = s.importedAt;
        } catch {
          since = undefined;
        }
        since ??= first;
        const bySource = WORK_SOURCES.flatMap((source) => {
          const row = totals.get(source);
          return row ? [{ source, ...row }] : [];
        });
        const out: WorkWaiting = { queues: { label, summaries, checks: openChecks }, bySource };
        if (sessionsLeft > 0 || notesLeft > 0) out.leftAlone = { sessions: sessionsLeft, notes: notesLeft };
        if (since !== undefined) out.since = since;
        return out;
      });
    },

    invalidate() {
      memory.clear();
    },
  };
}

async function collect<T>(vaultRoot: string, ledger: LedgerName | "corrections"): Promise<T[]> {
  const out: T[] = [];
  for await (const r of streamLedger<T>(vaultRoot, ledger)) out.push(r);
  return out;
}

function inRange(at: string, range: { from?: string; to?: string }): boolean {
  const t = parseIso(at);
  if (range.from !== undefined && t < parseIso(range.from)) return false;
  if (range.to !== undefined && t > parseIso(range.to)) return false;
  return true;
}

function threadOf(e: EntryRecord): string {
  const p = e.sourceRef?.path;
  return typeof p === "string" && p.startsWith("cortex-ask/") ? p.slice("cortex-ask/".length) : (e.conv ?? "");
}
