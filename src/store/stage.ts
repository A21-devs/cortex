/**
 * Live-session staging in the LOCAL cache (SAFE-07, LIVE-SESSION-SEMANTICS). Owner: E2.
 *
 * Rule: complete messages of a live Claude Code session are imported AT ONCE into `<cache>/stage/<conv>.jsonl`
 * (SegmentLine + EntryRecord pairs), indexed with ItemFlag.Live and readable through TextRef {store:"stage"} on
 * this computer only, so the figure grows live without touching OneDrive. The trailing open assistant message is
 * held back by the importer (its first line stays at the cursor). When the session has been idle for
 * liveIdleMinutes (10), or at the daily seal, `sealStage` writes ONE immutable segment plus the ledger lines and
 * removes the stage file; ids are stable, so sealed entries keep their ordinals.
 *
 * Stage file lines (JSON, one per line, appended under the lock "stage:<conv>"):
 *   {"t":"meta","v":1,"source","segDir","conversation"?,"at"}   where the seal goes; the latest snapshot of the
 *                                                                conversation record (never written to the ledger
 *                                                                while live)
 *   {"t":"msg","v":1,"n","line":SegmentLine,"entry":EntryRecord,"at"}   n = the TextRef stage line
 *   {"t":"sealed","v":1,"seg","at"}                            the segment is published (crash recovery)
 * A seal that dies after publishing the segment resumes from the "sealed" line: the segment is reused and entry
 * lines already in the ledger are not appended twice. Before writing a conversation directly (not live), the
 * importer seals its stage first.
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { appendLines, errCode, withFsRetry } from "../node/fsAtomic";
import { locksDirOf, withLock } from "../node/locks";
import { cacheWritablePath } from "../node/paths";
import type { CancelToken } from "../shared/cancel";
import { CortexError } from "../shared/errors";
import { shardMonth } from "../shared/time";
import type { ConversationId, ConversationRecord, EntryRecord, IsoDate, SegmentLine, SourceKind, VaultPath } from "../shared/types";
import { SOURCE_KINDS } from "../shared/types";
import { CACHE_REL, cacheLayout, parseSegmentPath, segmentDir, type StoreContext } from "./layout";
import { createLedgerStore, endsWithNewline, shardOf, type LedgerStore } from "./ledger";
import { findSegmentDir, listSegments, readSegmentLines, sha256Text, writeSegment, type StageLookup } from "./segments";
import { writeSignal } from "./signal";

export interface StagedMessage {
  line: SegmentLine;
  entry: EntryRecord;
}

export interface StagedConversation {
  conv: ConversationId;
  messages: number;
  /** When the newest message was staged (the session's last activity as Cortex saw it). */
  lastAt: string;
  source?: SourceKind;
  segDir?: VaultPath;
}

/** Where a live conversation will be sealed, and its latest conversation record. */
export interface StageMeta {
  source: SourceKind;
  /** The conversation's segment folder (ConversationRecord.segDir), fixed at first import. */
  segDir: VaultPath;
  /** Snapshot appended to the conversations ledger at the seal (seq and updatedAt are set then). */
  conversation?: ConversationRecord;
}

interface ParsedStage {
  meta: StageMeta | null;
  msgs: (StagedMessage & { n: number; at: string })[];
  sealed: { seg: VaultPath } | null;
}

const CONV_RE = /^c_[a-z2-7]{16}$/;

function parseStage(text: string, conv: ConversationId): ParsedStage {
  const out: ParsedStage = { meta: null, msgs: [], sealed: null };
  const parts = text.split("\n");
  parts.pop(); // "" after the last newline, or a line still being written
  const seen = new Set<string>();
  for (const raw of parts) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length === 0) continue;
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a torn line from a crash
    }
    if (v === null || typeof v !== "object" || v.v !== 1) continue;
    if (v.t === "meta" && typeof v.segDir === "string" && SOURCE_KINDS.includes(v.source as SourceKind)) {
      const meta: StageMeta = { source: v.source as SourceKind, segDir: v.segDir };
      if (v.conversation && typeof v.conversation === "object") meta.conversation = v.conversation as ConversationRecord;
      out.meta = meta;
    } else if (v.t === "msg" && Number.isInteger(v.n)) {
      const l = v.line as SegmentLine | undefined;
      const e = v.entry as EntryRecord | undefined;
      if (!l || !e || typeof l.id !== "string" || l.id !== e.id || typeof l.text !== "string" || seen.has(l.id)) continue;
      if (e.conv !== undefined && e.conv !== conv) continue;
      seen.add(l.id);
      out.msgs.push({ line: l, entry: e, n: v.n as number, at: typeof v.at === "string" ? v.at : "" });
    } else if (v.t === "sealed" && typeof v.seg === "string") {
      out.sealed = { seg: v.seg };
    }
  }
  out.msgs.sort((a, b) => a.n - b.n);
  return out;
}

async function readStageFile(cacheDir: string, conv: ConversationId): Promise<{ text: string; mtimeMs: number; size: number } | null> {
  const abs = cacheLayout(cacheDir).stageFile(conv);
  try {
    const [text, st] = await Promise.all([withFsRetry(() => fsp.readFile(abs, "utf8")), fsp.stat(abs)]);
    return { text, mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) {
    if (errCode(e) === "ENOENT") return null;
    throw e;
  }
}

function stageLock(ctx: StoreContext, conv: ConversationId) {
  return { dir: locksDirOf(ctx.cacheDir), target: `stage:${conv}`, opts: { owner: ctx.owner, staleMs: ctx.lockStaleMs } };
}

function checkConv(conv: ConversationId): void {
  if (!CONV_RE.test(conv)) throw new CortexError("E_INTERNAL", "bad conversation id for the stage");
}

/** The segment folder for a conversation without a recorded one: its existing folder, else the first message's month. */
async function deriveMeta(ctx: Pick<StoreContext, "vaultRoot">, conv: ConversationId, first: StagedMessage): Promise<StageMeta> {
  const source = first.entry.source;
  const existing = await findSegmentDir(ctx.vaultRoot, source, conv);
  if (existing) return { source, segDir: existing };
  const when = first.line.ts ?? first.entry.writtenAt ?? first.entry.addedAt;
  const t = Date.parse(when);
  const month = shardMonth(new Date(Number.isFinite(t) ? t : Date.now()).toISOString());
  return { source, segDir: segmentDir(source, month, conv) };
}

/**
 * Stage complete messages of a live conversation. Messages already staged (same entry id) are skipped; each new
 * one gets the next stage line number, and its EntryRecord's text becomes {store:"stage", conv, line: n}. `meta`
 * (recommended on every call) records the segment folder and the latest conversation record for the seal; when
 * a stage has no meta yet, the conversation's existing segment folder (or its first message's month) is used.
 * Returns the number of newly staged messages.
 */
export async function stageMessages(ctx: StoreContext, conv: ConversationId, items: readonly StagedMessage[], meta?: StageMeta): Promise<number> {
  checkConv(conv);
  if (meta) {
    const p = parseSegmentPath(meta.segDir);
    if (!p || p.conv !== conv || p.source !== meta.source || p.seq !== undefined) throw new CortexError("E_INTERNAL", "stage meta names another conversation's folder");
  }
  items.forEach((it, i) => {
    const { line, entry } = it;
    if (!line || !entry || line.id !== entry.id || !/^e_[a-z2-7]{16}$/.test(line.id)) throw new CortexError("E_INTERNAL", `staged message ${i} has mismatched ids`);
    if ((line.conv !== undefined && line.conv !== conv) || (entry.conv !== undefined && entry.conv !== conv)) throw new CortexError("E_INTERNAL", `staged message ${i} belongs to another conversation`);
    if (typeof line.text !== "string" || line.sha !== sha256Text(line.text)) throw new CortexError("E_INTERNAL", `staged message ${i} has a wrong sha256`);
    if (entry.textSha256 !== line.sha) throw new CortexError("E_INTERNAL", `staged message ${i} has an entry hash that does not match its text`);
  });
  const lk = stageLock(ctx, conv);
  const added = await withLock(lk.dir, lk.target, lk.opts, async () => {
    const file = await readStageFile(ctx.cacheDir, conv);
    const parsed = file ? parseStage(file.text, conv) : { meta: null, msgs: [], sealed: null };
    if (parsed.sealed) throw new CortexError("E_LOCKED", "this conversation's stage is being sealed; seal it before staging more", { retryable: true });
    const known = new Set(parsed.msgs.map((m) => m.entry.id));
    let n = parsed.msgs.reduce((mx, m) => Math.max(mx, m.n + 1), 0);
    const at = new Date().toISOString();
    const out: string[] = [];
    const first = items.find((it) => !known.has(it.entry.id));
    let nextMeta: StageMeta | null = meta ?? null;
    if (!nextMeta && !parsed.meta && first) nextMeta = await deriveMeta(ctx, conv, first);
    if (nextMeta) out.push(JSON.stringify({ t: "meta", v: 1, source: nextMeta.source, segDir: nextMeta.segDir, ...(nextMeta.conversation ? { conversation: nextMeta.conversation } : {}), at }));
    let staged = 0;
    for (const it of items) {
      if (known.has(it.entry.id)) continue;
      known.add(it.entry.id);
      const line: SegmentLine = { ...it.line, conv };
      const entry: EntryRecord = { ...it.entry, conv, text: { store: "stage", conv, line: n } };
      out.push(JSON.stringify({ t: "msg", v: 1, n, line, entry, at }));
      n++;
      staged++;
    }
    if (out.length === 0 || (staged === 0 && !meta)) return 0;
    const abs = cacheWritablePath(ctx.cacheDir, CACHE_REL.stage(conv));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    if (!(await endsWithNewline(abs))) await appendLines(abs, "\n");
    await appendLines(abs, out.map((l) => `${l}\n`).join(""));
    return staged;
  });
  // Live messages join the record index (indexBuilder withStaged) without a ledger commit, so they announce
  // themselves: the plugin builds again and the figure grows while the session runs. The ledger seq does not move.
  if (added > 0) {
    try {
      await writeSignal(ctx.cacheDir, { seq: 0, changed: ["staged"], by: ctx.owner });
    } catch (e) {
      ctx.log.warn("the cache signal could not be written", { error: errCode(e) ?? "unknown" });
    }
  }
  return added;
}

/** Staged messages of a conversation in stage-line order (empty when nothing is staged on this computer). */
export async function readStage(ctx: Pick<StoreContext, "cacheDir">, conv: ConversationId): Promise<StagedMessage[]> {
  checkConv(conv);
  const file = await readStageFile(ctx.cacheDir, conv);
  if (!file) return [];
  return parseStage(file.text, conv).msgs.map(({ line, entry }) => ({ line, entry }));
}

/** Where a staged conversation will be sealed and its latest record snapshot (null when nothing is staged). */
export async function readStageMeta(ctx: Pick<StoreContext, "cacheDir">, conv: ConversationId): Promise<StageMeta | null> {
  checkConv(conv);
  const file = await readStageFile(ctx.cacheDir, conv);
  return file ? parseStage(file.text, conv).meta : null;
}

export async function listStaged(ctx: Pick<StoreContext, "cacheDir">): Promise<StagedConversation[]> {
  let names: string[];
  try {
    names = await fsp.readdir(cacheLayout(ctx.cacheDir).stage);
  } catch (e) {
    if (errCode(e) === "ENOENT") return [];
    throw e;
  }
  const out: StagedConversation[] = [];
  for (const name of names.sort()) {
    const m = /^(c_[a-z2-7]{16})\.jsonl$/.exec(name);
    if (!m) continue;
    const conv = m[1] as ConversationId;
    const file = await readStageFile(ctx.cacheDir, conv).catch(() => null);
    if (!file) continue;
    const parsed = parseStage(file.text, conv);
    const newest = parsed.msgs.reduce((mx, x) => (x.at > mx ? x.at : mx), "");
    const row: StagedConversation = { conv, messages: parsed.msgs.length, lastAt: newest || new Date(file.mtimeMs).toISOString() };
    if (parsed.meta) {
      row.source = parsed.meta.source;
      row.segDir = parsed.meta.segDir;
    }
    out.push(row);
  }
  return out;
}

/** Sessions idle long enough to seal. */
export function dueForSeal(staged: readonly StagedConversation[], now: number, idleMinutes: number): ConversationId[] {
  return staged.filter((s) => now - Date.parse(s.lastAt) >= idleMinutes * 60_000).map((s) => s.conv);
}

async function removeStageFile(ctx: StoreContext, conv: ConversationId): Promise<void> {
  const abs = cacheWritablePath(ctx.cacheDir, CACHE_REL.stage(conv));
  await withFsRetry(() => fsp.rm(abs, { force: true }));
}

/** The newest segment of the folder when it holds exactly `ids` (a seal that published but did not record it). */
async function segmentHolding(vaultRoot: string, segDir: VaultPath, ids: readonly string[]): Promise<VaultPath | null> {
  const segs = await listSegments(vaultRoot, segDir);
  const newest = segs[segs.length - 1];
  if (!newest) return null;
  try {
    const lines = await readSegmentLines(vaultRoot, newest);
    const have = lines.map((l) => l?.id);
    return have.length === ids.length && ids.every((id, i) => have[i] === id) ? newest : null;
  } catch {
    return null;
  }
}

/**
 * Seal: one segment + EntryRecords (text refs pointing into the new segment) + the conversation snapshot, then
 * delete the stage file. Safe to call again after a crash at any point.
 */
export async function sealStage(ctx: StoreContext, conv: ConversationId, opts: { ledger?: LedgerStore } = {}): Promise<{ entries: number; segment?: string }> {
  checkConv(conv);
  const lk = stageLock(ctx, conv);
  return withLock(lk.dir, lk.target, lk.opts, async () => {
    const file = await readStageFile(ctx.cacheDir, conv);
    if (!file) return { entries: 0 };
    const parsed = parseStage(file.text, conv);
    if (parsed.msgs.length === 0) {
      await removeStageFile(ctx, conv);
      return { entries: 0 };
    }
    const meta = parsed.meta ?? (await deriveMeta(ctx, conv, parsed.msgs[0] as StagedMessage));
    const where = parseSegmentPath(meta.segDir);
    if (!where || where.conv !== conv || where.seq !== undefined) throw new CortexError("E_INTERNAL", "stage meta names a bad segment folder");
    const ledger = opts.ledger ?? createLedgerStore(ctx);
    const ids = parsed.msgs.map((m) => m.entry.id);

    let seg: VaultPath | null = null;
    if (parsed.sealed) {
      const p = parseSegmentPath(parsed.sealed.seg);
      if (p && p.dir === where.dir && p.seq !== undefined) seg = parsed.sealed.seg;
    }
    seg ??= await segmentHolding(ctx.vaultRoot, where.dir, ids);
    if (!seg) {
      const lines = parsed.msgs.map((m) => ({ ...m.line, conv }));
      seg = (await writeSegment(ctx, { source: where.source, monthKey: where.monthKey, conv, lines })).path;
    }
    if (!parsed.sealed) {
      const abs = cacheWritablePath(ctx.cacheDir, CACHE_REL.stage(conv));
      if (!(await endsWithNewline(abs))) await appendLines(abs, "\n");
      await appendLines(abs, `${JSON.stringify({ t: "sealed", v: 1, seg, at: new Date().toISOString() })}\n`);
    }

    const lines = await readSegmentLines(ctx.vaultRoot, seg);
    const position = new Map<string, number>();
    lines.forEach((l, i) => {
      if (l) position.set(l.id, i);
    });
    const missing = ids.filter((id) => !position.has(id));
    if (missing.length > 0) throw new CortexError("E_IO", "the sealed segment does not hold every staged message", { retryable: true });

    // A resumed seal may already have appended some entry lines: never append an entry twice.
    const months = new Set(parsed.msgs.map((m) => shardOf("entries", m.entry)));
    const already = parsed.sealed ? await ledger.has("entries", ids, { months: (mo) => months.has(mo) }) : new Set<string>();
    const records: EntryRecord[] = parsed.msgs
      .filter((m) => !already.has(m.entry.id))
      .map((m) => ({ ...m.entry, conv, text: { store: "segment" as const, seg: seg as VaultPath, line: position.get(m.entry.id) as number } }));
    if (records.length > 0) await ledger.append("entries", records);
    if (meta.conversation) {
      const seq = (await ledger.seq()) + 1;
      const updatedAt: IsoDate = new Date().toISOString();
      await ledger.append("conversations", [{ ...meta.conversation, id: conv, segDir: where.dir, seq, updatedAt }]);
    }
    await removeStageFile(ctx, conv);
    ctx.log.debug("sealed live conversation", { conv, entries: records.length });
    return { entries: records.length, segment: seg };
  });
}

/** Seal every staged conversation idle for `idleMinutes` (0 = all of them, the nightly seal). */
export async function sealDue(ctx: StoreContext, idleMinutes: number, opts: { now?: number; ledger?: LedgerStore; token?: CancelToken } = {}): Promise<{ conv: ConversationId; entries: number; segment?: string; error?: string }[]> {
  const now = opts.now ?? Date.now();
  const staged = await listStaged(ctx);
  const due = idleMinutes <= 0 ? staged.map((s) => s.conv) : dueForSeal(staged, now, idleMinutes);
  const ledger = opts.ledger ?? createLedgerStore(ctx);
  const out: { conv: ConversationId; entries: number; segment?: string; error?: string }[] = [];
  for (const conv of due) {
    opts.token?.throwIfCancelled();
    try {
      const r = await sealStage(ctx, conv, { ledger });
      out.push(r.segment === undefined ? { conv, entries: r.entries } : { conv, entries: r.entries, segment: r.segment });
    } catch (e) {
      const code = e instanceof CortexError ? e.code : "E_IO";
      ctx.log.warn("sealing a live conversation failed", { conv, code });
      out.push({ conv, entries: 0, error: code });
    }
  }
  return out;
}

/**
 * Text of staged lines for readers on this computer (TextRef {store:"stage"}). Parsed stage files are kept while
 * their size and mtime are unchanged, so paging through a live thread reads each file once.
 */
export function stageLookup(ctx: Pick<StoreContext, "cacheDir">, capacity = 16): StageLookup {
  const cache = new Map<ConversationId, { size: number; mtimeMs: number; byLine: Map<number, string> }>();
  return async (conv, line) => {
    if (!CONV_RE.test(conv)) return undefined;
    const abs = cacheLayout(ctx.cacheDir).stageFile(conv);
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      cache.delete(conv);
      return undefined;
    }
    let hit = cache.get(conv);
    if (!hit || hit.size !== st.size || hit.mtimeMs !== st.mtimeMs) {
      const file = await readStageFile(ctx.cacheDir, conv).catch(() => null);
      if (!file) return undefined;
      hit = { size: file.size, mtimeMs: file.mtimeMs, byLine: new Map(parseStage(file.text, conv).msgs.map((m) => [m.n, m.line.text])) };
      cache.delete(conv);
      cache.set(conv, hit);
      while (cache.size > capacity) {
        const first = cache.keys().next();
        if (first.done) break;
        cache.delete(first.value);
      }
    }
    return hit.byLine.get(line);
  };
}
