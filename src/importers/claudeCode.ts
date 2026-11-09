/**
 * Claude Code transcripts importer (P0, primary source). Owner: E3.
 *
 * Discovery: <projectsDir>/<slug>/*.jsonl (top-level sessions); with includeSubagents also
 * <slug>/<session>/subagents/*.jsonl and <slug>/<session>/workflows/**.jsonl. The project folder of
 * Cortex's own headless runs (slug of %LOCALAPPDATA%/cortex/agent-cwd) is always excluded. Files are imported
 * OLDEST first: Claude Code deletes old transcripts on its own schedule, so those are the ones at risk.
 *
 * Algorithm per file (streaming, constant memory; largest file seen: 290 MB):
 *  1. cursorPlan(cursor, size, mtime) → skip / read from offset / reset (cursors live in the local cache).
 *  2. fs.createReadStream(start=offset) → ByteLineSplitter (node/lineSplitter.ts): byte offsets per line, so the
 *     cursor always lands on a line start; never parse past the last "\n" (live files end mid-line).
 *  3. peekType() first: housekeeping types are skipped without JSON.parse, and so are tool-result lines while
 *     tool output is off (a byte search for the `"toolUseResult":` key, which cannot occur unescaped inside a
 *     JSON string); then JSON.parse and classifyLine().
 *  4. Merge consecutive assistant events with the same messageId into one message (streamed blocks). The
 *     trailing open assistant message of a LIVE file is held back (cursor stays at its first line, and the
 *     cursor's mtime is set to -1 so the next pass re-reads it). Complete messages of a live session (file
 *     changed within liveIdleMinutes) — and of any conversation that already has staged messages — go to the
 *     local STAGE now and are sealed into one segment when the session goes idle or at the daily seal
 *     (LIVE-SESSION-SEMANTICS, SAFE-07).
 *  5. Entry id = entryId("claude-code", `${sessionId}:${firstLineUuid}`); after a lost or stale cursor the batch
 *     dedupes against the ledger (knownEntryIds) and the stage.
 *  6. Conversation id = conversationId("claude-code", sessionId); a subagent transcript is its own conversation
 *     (`${sessionId}/${file stem}`, meta.parent = the session's conversation) so each idx sequence stays
 *     monotonic while parent and subagent grow independently. Title: custom-title > ai-title > first "you" line
 *     (≤ 80 chars). Parts: compaction boundary or > 6 h gap. Space via settings spaceMap (project slug → area),
 *     else "none" (No area).
 *  7. Flush per conversation through ConversationBatch (one immutable segment per pass; a huge first import
 *     flushes every ~16 MB of text), then save cursors (batched; a lost cursor only costs a dedupe re-scan).
 *  8. A top-level conversation with no "you" message is automated (sdk prompts): its entries get hiddenByDefault
 *     "automated" (ItemFlag.Automated; Layers › Automated sessions) and meta.automated = "yes"; never agent
 *     targets by default.
 *  9. Tool output and thinking follow includeToolOutput / includeThinking (one setting each); harness lines are
 *     never imported.
 */
import { createReadStream, promises as fsp } from "node:fs";
import * as path from "node:path";
import { isCortexError } from "../shared/errors";
import { conversationId, entryId } from "../shared/ids";
import type { SourceImportStats, SourceSelector } from "../shared/protocol/runner";
import { firstLineTitle } from "../shared/text";
import type { ConversationId, ConversationRecord, EntryRecord, FileCursor, IsoDate, SpaceId } from "../shared/types";
import { sha256Bytes } from "../node/hash";
import { ByteLineSplitter, peekType, trimCr, type ByteLine } from "../node/lineSplitter";
import { agentCwd, claudeProjectSlug, claudeProjectsDir } from "../node/platform";
import { cursorPlan, loadCursors, saveCursors } from "../store/cursors";
import { loadSourceManifest, updateSourceManifest } from "../store/manifest";
import { classifyLine, SKIP_TYPES, type CcEvent, type CcHidden, type CcOptions, type CcRawLine } from "./claudeCodeClassify";
import {
  checkpoint,
  createConversationBatch,
  emptyStats,
  existingConversation,
  importPrivacy,
  isNotLocalError,
  nextIdxFor,
  noteNotLocal,
  overDeadline,
  sealStagedConversations,
  stagedMessages,
  warn,
  type ConversationMeta,
  type DiscoveredUnit,
  type ImportContext,
  type Importer,
  type PendingMessage,
} from "./common";

export type ClaudeCodeSelector = Extract<SourceSelector, { kind: "claude-code" }>;

export interface ClaudeCodeFile extends DiscoveredUnit {
  projectSlug: string;
  /** The session the file belongs to (a subagent file: its parent session). */
  sessionId: string;
  isSubagent: boolean;
  /** Subagent / workflow transcripts: the file stem, e.g. "agent-a1". */
  agentKey?: string;
}

/** A new part starts after this much silence (or at a compaction boundary). */
export const PART_GAP_MS = 6 * 3_600_000;
/** Flush a session mid-file once this much text is waiting (bounded memory on a first import). */
export const FLUSH_TEXT_BYTES = 16 * 1024 * 1024;
const TOOL_USE_RESULT_KEY = new TextEncoder().encode('"toolUseResult":');
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;

/** The conversation id of a transcript file. */
export function claudeCodeConversation(f: Pick<ClaudeCodeFile, "sessionId" | "agentKey">): { conv: ConversationId; nativeId: string } {
  const nativeId = f.agentKey ? `${f.sessionId}/${f.agentKey}` : f.sessionId;
  return { conv: conversationId("claude-code", nativeId), nativeId };
}

/** List transcript files (cheap: readdir + stat only). */
export async function discoverClaudeCodeFiles(projectsDir: string, opts: { includeSubagents: boolean; excludeProjects: readonly string[] }): Promise<ClaudeCodeFile[]> {
  const out: ClaudeCodeFile[] = [];
  const ownSlug = claudeProjectSlug(agentCwd()).toLowerCase();
  const excluded = new Set(opts.excludeProjects.map((s) => s.toLowerCase()));
  let projects: string[] = [];
  try {
    projects = await fsp.readdir(projectsDir);
  } catch {
    return out;
  }
  for (const slug of projects.sort()) {
    if (slug.toLowerCase() === ownSlug || excluded.has(slug.toLowerCase())) continue;
    const dir = path.join(projectsDir, slug);
    let names: string[] = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const full = path.join(dir, name);
      if (name.endsWith(".jsonl")) {
        const st = await fsp.stat(full).catch(() => null);
        const sessionId = name.slice(0, -6);
        if (st?.isFile() && SESSION_ID.test(sessionId)) out.push({ key: full, path: full, bytes: st.size, mtimeMs: st.mtimeMs, projectSlug: slug, sessionId, isSubagent: false });
      } else if (opts.includeSubagents && SESSION_ID.test(name)) {
        for (const subdir of ["subagents", "workflows"]) {
          const sd = path.join(full, subdir);
          const subs = await fsp.readdir(sd, { recursive: true }).catch(() => [] as string[]);
          for (const s of subs.map(String).sort()) {
            if (!s.endsWith(".jsonl")) continue;
            const sf = path.join(sd, s);
            const st = await fsp.stat(sf).catch(() => null);
            if (!st?.isFile()) continue;
            const agentKey = `${subdir === "workflows" ? "workflow-" : ""}${s.replace(/\\/g, "/").replace(/\.jsonl$/, "").replace(/[^A-Za-z0-9._-]+/g, "-")}`.slice(0, 120);
            out.push({ key: sf, path: sf, bytes: st.size, mtimeMs: st.mtimeMs, projectSlug: slug, sessionId: name, isSubagent: true, agentKey });
          }
        }
      }
    }
  }
  return out;
}

/** "claude-obsidian" from `C:\Users\…\claude-obsidian`; the slug when the working folder is unknown. */
export function projectLabel(slug: string, cwd: string | undefined): string {
  const base = cwd ? cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : undefined;
  return base && base.length > 0 ? base.slice(0, 80) : slug.slice(0, 80);
}

/** Area of a Claude Code project (settings table; unknown projects have no area). */
export function spaceOfProject(slug: string, spaceMap: Readonly<Record<string, SpaceId>>): SpaceId {
  if (Object.hasOwn(spaceMap, slug)) return spaceMap[slug] as SpaceId;
  const lower = slug.toLowerCase();
  for (const [k, v] of Object.entries(spaceMap)) if (k.toLowerCase() === lower) return v;
  return "none";
}

/** Byte-level substring test (no decoding). */
export function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  const lim = hay.length - needle.length;
  outer: for (let i = 0; i <= lim; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Per-file working state while reading. */
interface SessionState {
  title?: string;
  titledBy?: ConversationRecord["titledBy"];
  meta: Record<string, string>;
  part: number;
  partHasEntries: boolean;
  pendingBoundary: boolean;
  /** Where the pending boundary line starts (a resume point before it re-reads the boundary). */
  boundary?: { offset: number; line: number };
  lastTs?: number;
  sawYou: boolean;
  firstText?: string;
}

interface OpenMessage {
  ev: Extract<CcEvent, { kind: "message" }>;
  texts: string[];
  firstLineStart: number;
  firstLineNo: number;
  firstLineSha: string;
}

interface FileOutcome {
  read: boolean;
  bytes: number;
  added: number;
  newConversation: boolean;
  stop: boolean;
  cursor?: FileCursor;
}

const HIDDEN_MAP: Record<CcHidden, NonNullable<EntryRecord["hiddenByDefault"]>> = { harness: "harness", tool: "tool", subagent: "subagent" };

export class ClaudeCodeImporter implements Importer<ClaudeCodeSelector> {
  readonly kind = "claude-code" as const;
  readonly source = "claude-code" as const;
  readonly label = "Claude Code";

  async discover(sel: ClaudeCodeSelector, ctx: ImportContext): Promise<DiscoveredUnit[]> {
    const cc = ctx.settings.sources.claudeCode;
    const files = await discoverClaudeCodeFiles(claudeProjectsDir(cc.projectsDir), { includeSubagents: cc.includeSubagents, excludeProjects: cc.excludeProjects });
    const wanted = sel.projects?.map((p) => p.toLowerCase());
    return wanted ? files.filter((f) => wanted.includes(f.projectSlug.toLowerCase())) : files;
  }

  async run(sel: ClaudeCodeSelector, ctx: ImportContext): Promise<SourceImportStats> {
    const stats = emptyStats("claude-code", this.label);
    const cc = ctx.settings.sources.claudeCode;
    const projectsDir = claudeProjectsDir(cc.projectsDir);
    try {
      await fsp.access(projectsDir);
    } catch (e) {
      if (isNotLocalError(e)) noteNotLocal(ctx, projectsDir);
      else warn(ctx, "path-unreadable");
      stats.errors.push({ file: "projects", message: "path-unreadable" });
      return stats;
    }
    const files = ((await this.discover(sel, ctx)) as ClaudeCodeFile[]).sort((a, b) => a.mtimeMs - b.mtimeMs || a.key.localeCompare(b.key));
    stats.filesSeen = files.length;
    const privacy = await importPrivacy(ctx);
    const cursors = (await loadCursors(ctx.store)).files;
    const dirty: Record<string, FileCursor> = {};
    let dirtyCount = 0;
    let lastSave = ctx.now();
    const saveDirty = async (force: boolean): Promise<void> => {
      if (ctx.dryRun || dirtyCount === 0) return;
      if (!force && dirtyCount < 25 && ctx.now() - lastSave < 5000) return;
      const batch = { ...dirty };
      for (const k of Object.keys(dirty)) delete dirty[k];
      dirtyCount = 0;
      lastSave = ctx.now();
      await saveCursors(ctx.store, batch);
    };
    const opts: CcOptions = { includeThinking: cc.includeThinking, includeToolCalls: cc.includeToolOutput, includeToolResults: cc.includeToolOutput, includeHarness: false };
    let newConversations = 0;
    let done = 0;
    let lastProgress = 0;
    try {
      for (const f of files) {
        if (overDeadline(ctx)) {
          if (ctx.tally) ctx.tally.partial = true;
          break;
        }
        done++;
        const { conv } = claudeCodeConversation(f);
        if (privacy.isExcluded({ source: "claude-code", sourceId: "claude-code", conv, project: f.projectSlug }) || privacy.isOffLimits(f.path, { userRowsOnly: true })) {
          stats.skipped++;
          continue;
        }
        let outcome: FileOutcome;
        try {
          outcome = await this.importFile(ctx, f, cursors[f.key], opts);
        } catch (e) {
          if (isCortexError(e) && e.code === "E_CANCELLED") throw e;
          const code = isCortexError(e) ? e.code : isNotLocalError(e) ? "not-local" : "E_IO";
          if (code === "not-local") noteNotLocal(ctx, f.path);
          else warn(ctx, "import-failed");
          ctx.log.warn("claude-code import failed", { session: f.sessionId, code });
          stats.errors.push({ file: `${f.projectSlug}/${f.agentKey ? `${f.sessionId}/${f.agentKey}` : f.sessionId}.jsonl`, message: code });
          continue;
        }
        if (outcome.read) {
          stats.filesRead++;
          if (ctx.now() - lastProgress >= 250 || done === files.length) {
            lastProgress = ctx.now();
            ctx.progress({ phase: "claude-code", done, total: files.length, unit: "sessions", note: String(stats.entriesAdded + outcome.added) });
          }
        }
        stats.bytesRead += outcome.bytes;
        stats.entriesAdded += outcome.added;
        if (outcome.added > 0) stats.conversationsTouched++;
        if (outcome.newConversation) newConversations++;
        if (outcome.cursor) {
          cursors[f.key] = outcome.cursor;
          dirty[f.key] = outcome.cursor;
          dirtyCount++;
        }
        await saveDirty(false);
        if (outcome.stop) break;
      }
      ctx.progress({ phase: "claude-code", done, total: files.length, unit: "sessions", note: String(stats.entriesAdded) });
      const sealed = await sealStagedConversations(ctx, { all: ctx.options?.seal === true, idleMinutes: cc.liveIdleMinutes, source: "claude-code" });
      if (sealed.conversations > 0) ctx.log.info("sealed live sessions", { conversations: sealed.conversations, entries: sealed.entries });
    } finally {
      await saveDirty(true);
    }
    if (!ctx.dryRun) {
      const manifest = await loadSourceManifest(ctx.store);
      const prev = manifest.sources["claude-code"];
      await updateSourceManifest(ctx.store, "claude-code", {
        kind: "claude-code",
        path: projectsDir,
        bytes: files.reduce((s, f) => s + f.bytes, 0),
        importedAt: new Date(ctx.now()).toISOString(),
        entries: (prev?.entries ?? 0) + stats.entriesAdded,
        conversations: (prev?.conversations ?? 0) + newConversations,
        status: stats.errors.length > 0 && stats.filesRead === 0 && files.length > 0 ? "error" : cc.watch ? "watching" : "imported",
      });
    }
    return stats;
  }

  /** Read one transcript from its cursor; flush its new messages; return the new cursor. */
  private async importFile(ctx: ImportContext, f: ClaudeCodeFile, cursor: FileCursor | undefined, opts: CcOptions): Promise<FileOutcome> {
    const nothing: FileOutcome = { read: false, bytes: 0, added: 0, newConversation: false, stop: false };
    const cc = ctx.settings.sources.claudeCode;
    let st;
    try {
      st = await fsp.stat(f.path);
    } catch (e) {
      if (isNotLocalError(e)) noteNotLocal(ctx, f.path);
      return nothing;
    }
    const plan = cursorPlan(cursor, st.size, st.mtimeMs);
    if (!plan) return nothing;
    // Kill switches before reading anything (SAFE-03).
    if ((await checkpoint(ctx)) !== null) return { ...nothing, stop: true };
    const { conv, nativeId } = claudeCodeConversation(f);
    const live = ctx.now() - st.mtimeMs < cc.liveIdleMinutes * 60_000;
    const prev = await existingConversation(ctx, conv);
    const staged = await stagedMessages(ctx, conv);
    const useStage = live || staged.length > 0;
    const stagedNext = staged.reduce((m, s) => Math.max(m, (s.entry.idx ?? -1) + 1), 0);
    const knownCount = Math.max(prev?.entryCount ?? 0, stagedNext);
    const fromStart = plan.from === 0;
    const brandNew = prev === undefined && staged.length === 0 && cursor === undefined;
    // A cursor is current when nothing was written for this conversation after it was saved.
    const current = cursor !== undefined && !plan.reset && knownCount <= cursor.emitted;
    const startIdx = current ? cursor.emitted : brandNew ? 0 : await nextIdxFor(ctx, conv, { staged });
    const batch = createConversationBatch(ctx, conv, startIdx, { live: useStage, fresh: current || brandNew });

    const state = initialState(prev, staged.map((s) => s.entry), fromStart);
    state.meta.projectSlug = f.projectSlug;
    state.meta.sessionId = f.sessionId;
    if (f.isSubagent) {
      state.meta.parent = conversationId("claude-code", f.sessionId);
      if (f.agentKey) state.meta.agent = f.agentKey;
    }

    const splitter = new ByteLineSplitter(plan.from);
    const decoder = new TextDecoder("utf-8");
    let lineNo = fromStart ? 0 : (cursor?.line ?? 0);
    let open: OpenMessage | undefined;
    let stopAt: { offset: number; line: number } | undefined;
    let added = 0;
    let pendingText = 0;
    let parsedLines = 0;
    let sessionLines = 0;
    let badLines = 0;
    let lastUuid = cursor?.lastUuid;
    let bytes = 0;

    const emit = (ev: Extract<CcEvent, { kind: "message" }>, text: string, at: { start: number; sha: string }): void => {
      const t = ev.ts !== undefined ? Date.parse(ev.ts) : Number.NaN;
      if (Number.isFinite(t) && state.lastTs !== undefined && t - state.lastTs > PART_GAP_MS) state.pendingBoundary = true;
      if (state.pendingBoundary) {
        if (state.partHasEntries) state.part++;
        state.pendingBoundary = false;
        delete state.boundary;
      }
      const nid = ev.nativeId || `off:${at.start}`;
      if (ev.speaker === "you") state.sawYou = true;
      if (state.firstText === undefined && text.trim()) state.firstText = text;
      if (state.title === undefined && ev.speaker === "you" && !ev.hidden) {
        const tl = firstLineTitle(text, 80);
        if (tl) {
          state.title = tl;
          state.titledBy = "first-line";
        }
      }
      const msg: PendingMessage = {
        id: entryId("claude-code", `${f.sessionId}:${nid}`),
        nativeId: nid,
        speaker: ev.speaker,
        text,
        part: state.part,
        sourceRef: { path: f.path, nativeId: nid, byteOffset: at.start, sha256: at.sha },
      };
      if (ev.speakerDetail !== undefined) msg.speakerDetail = ev.speakerDetail;
      if (ev.ts !== undefined) msg.ts = ev.ts;
      if (ev.hidden !== undefined) msg.hiddenByDefault = HIDDEN_MAP[ev.hidden];
      if (ev.attachments && ev.attachments.length > 0) msg.attachments = ev.attachments;
      batch.add(msg);
      pendingText += text.length;
      state.partHasEntries = true;
      if (Number.isFinite(t)) state.lastTs = Math.max(state.lastTs ?? t, t);
      lastUuid = nid;
    };
    const closeOpen = (): void => {
      if (!open) return;
      const o = open;
      open = undefined;
      emit(o.ev, o.texts.join("\n\n"), { start: o.firstLineStart, sha: o.firstLineSha });
    };
    /** Where the next pass must start so nothing pending is lost: before an open message or a pending boundary. */
    const resumePoint = (offset: number, line: number): { offset: number; line: number } => {
      let at = { offset, line };
      if (open && open.firstLineStart < at.offset) at = { offset: open.firstLineStart, line: open.firstLineNo };
      if (state.pendingBoundary && state.boundary && state.boundary.offset < at.offset) at = { ...state.boundary };
      return at;
    };

    const onLine = (line: ByteLine): void => {
      if (stopAt !== undefined) return;
      lineNo++;
      const raw = trimCr(line.bytes);
      if (raw.length === 0) return;
      const type = peekType(raw, 4096);
      if (type !== undefined && SKIP_TYPES.has(type)) {
        parsedLines++;
        sessionLines++;
      } else if (type === "user" && !opts.includeToolResults && containsBytes(raw, TOOL_USE_RESULT_KEY)) {
        // Tool output is never parsed while it is not imported; message merging follows events, not lines.
        parsedLines++;
        sessionLines++;
      } else {
        let obj: CcRawLine | null = null;
        try {
          const parsed: unknown = JSON.parse(decoder.decode(raw));
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) obj = parsed as CcRawLine;
        } catch {
          obj = null;
        }
        if (obj === null) badLines++;
        else {
          parsedLines++;
          if (typeof obj.type === "string" || typeof obj.sessionId === "string") sessionLines++;
          for (const ev of classifyLine(obj, opts, f.isSubagent)) {
            switch (ev.kind) {
              case "skip":
                break;
              case "meta":
                if (ev.cwd) state.meta.cwd = ev.cwd;
                if (ev.gitBranch) state.meta.gitBranch = ev.gitBranch;
                if (ev.entrypoint) state.meta.entrypoint = ev.entrypoint;
                break;
              case "title":
                if (ev.by === "user") {
                  state.title = ev.title.slice(0, 200);
                  state.titledBy = "user";
                } else if (state.titledBy !== "user") {
                  state.title = ev.title.slice(0, 200);
                  state.titledBy = "model";
                }
                break;
              case "part-boundary":
                closeOpen();
                if (!state.pendingBoundary) state.boundary = { offset: line.start, line: lineNo - 1 };
                state.pendingBoundary = true;
                break;
              case "message": {
                if (ev.speaker === "assistant" && ev.messageId !== undefined && open && open.ev.messageId === ev.messageId && open.ev.hidden === ev.hidden) {
                  open.texts.push(ev.text);
                  break;
                }
                closeOpen();
                const sha = sha256Bytes(raw);
                if (ev.speaker === "assistant" && ev.messageId !== undefined) open = { ev, texts: [ev.text], firstLineStart: line.start, firstLineNo: lineNo - 1, firstLineSha: sha };
                else emit(ev, ev.text, { start: line.start, sha });
                break;
              }
            }
          }
        }
      }
      if ((lineNo % 2000 === 0 && overDeadline(ctx)) || (ctx.maxEntries !== undefined && (ctx.tally?.added ?? 0) + batch.size >= ctx.maxEntries)) {
        stopAt = { offset: line.end, line: lineNo };
        if (ctx.tally) ctx.tally.partial = true;
      }
    };

    const meta = (): ConversationMeta => conversationMeta(f, conv, nativeId, state, cc.spaceMap, prev);
    const flushNow = async (): Promise<void> => {
      if (!state.sawYou && !f.isSubagent) batch.forEachPending((m) => void (m.hiddenByDefault ??= "automated"));
      added += await batch.flush(meta());
      pendingText = 0;
    };

    const stream = createReadStream(f.path, { start: plan.from, highWaterMark: 1 << 20 });
    try {
      for await (const chunk of stream) {
        const buf = chunk as Buffer;
        bytes += buf.length;
        splitter.push(buf, onLine);
        if (stopAt !== undefined) break;
        // Bounded memory on huge first imports: write what is complete (a lost cursor only costs a dedupe).
        if (pendingText >= FLUSH_TEXT_BYTES) await flushNow();
      }
    } finally {
      stream.destroy();
    }

    if (fromStart && ((parsedLines === 0 && badLines > 0) || (parsedLines > 0 && sessionLines === 0))) {
      // Not a session log: remember its size so it is not read again until it changes.
      warn(ctx, "skipped-not-session");
      return { read: true, bytes, added: 0, newConversation: false, stop: false, cursor: makeCursor(f, st, { offset: st.size, line: lineNo }, conv, cursor?.emitted ?? 0, lastUuid, ctx.now()) };
    }
    const reachedEnd = stopAt === undefined;
    // An idle file's last message is complete; a live file's open message is held back for the next pass.
    if (reachedEnd && open && !live) closeOpen();
    const heldBack = reachedEnd && open !== undefined;
    const resume = reachedEnd ? resumePoint(splitter.consumed, lineNo) : resumePoint(stopAt?.offset ?? splitter.consumed, stopAt?.line ?? lineNo);
    await flushNow();
    const next = makeCursor(f, st, resume, conv, batch.nextIdx, lastUuid, ctx.now());
    // A held-back message or boundary must be re-read even if the file never changes again.
    if (heldBack || !reachedEnd || resume.offset < splitter.consumed) next.mtimeMs = -1;
    return { read: true, bytes, added, newConversation: prev === undefined && added > 0, stop: !reachedEnd, cursor: next };
  }
}

function makeCursor(f: ClaudeCodeFile, st: { size: number; mtimeMs: number }, at: { offset: number; line: number }, conv: ConversationId, emitted: number, lastUuid: string | undefined, now: number): FileCursor {
  const c: FileCursor = { path: f.path, size: st.size, mtimeMs: st.mtimeMs, offset: at.offset, line: at.line, conv, emitted, updatedAt: new Date(now).toISOString() };
  if (lastUuid !== undefined) c.lastUuid = lastUuid;
  return c;
}

function initialState(prev: ConversationRecord | undefined, stagedEntries: readonly EntryRecord[], fromStart: boolean): SessionState {
  const meta: Record<string, string> = {};
  for (const [k, v] of Object.entries(prev?.meta ?? {})) if (k !== "segments" && typeof v === "string") meta[k] = v;
  const state: SessionState = { meta, part: 0, partHasEntries: false, pendingBoundary: false, sawYou: meta.automated === "no" };
  if (prev && prev.titledBy !== "native") {
    state.title = prev.title;
    state.titledBy = prev.titledBy;
  }
  if (fromStart) return state;
  state.part = prev?.parts[prev.parts.length - 1]?.n ?? 0;
  state.partHasEntries = (prev?.entryCount ?? 0) > 0 || stagedEntries.length > 0;
  let last = prev?.endedAt !== undefined ? Date.parse(prev.endedAt) : Number.NaN;
  for (const e of stagedEntries) {
    if (typeof e.part === "number" && e.part > state.part) state.part = e.part;
    const t = e.writtenAt !== undefined ? Date.parse(e.writtenAt) : Number.NaN;
    if (Number.isFinite(t) && (!Number.isFinite(last) || t > last)) last = t;
    if (e.speaker === "you") state.sawYou = true;
  }
  if (Number.isFinite(last)) state.lastTs = last;
  return state;
}

function conversationMeta(f: ClaudeCodeFile, conv: ConversationId, nativeId: string, state: SessionState, spaceMap: Readonly<Record<string, SpaceId>>, prev: ConversationRecord | undefined): ConversationMeta {
  const project = projectLabel(f.projectSlug, state.meta.cwd);
  const meta: Record<string, string> = { ...state.meta };
  if (!f.isSubagent) meta.automated = state.sawYou ? "no" : "yes";
  let title = state.title;
  let titledBy = state.titledBy;
  if (title === undefined) {
    const tl = state.firstText !== undefined ? firstLineTitle(state.firstText, 80) : "";
    title = tl || (prev?.title ?? project);
    titledBy = tl ? "first-line" : (prev?.titledBy ?? "first-line");
  }
  const m: ConversationMeta = {
    id: conv,
    source: "claude-code",
    nativeId,
    title,
    titledBy: titledBy ?? "first-line",
    space: spaceOfProject(f.projectSlug, spaceMap),
    folder: [project],
    project,
    meta,
  };
  if (prev?.segDir !== undefined) m.segDir = prev.segDir;
  return m;
}

/** First-run estimate helper: sessions per project (top-level files only unless subagents are on). */
export async function countClaudeCodeSessions(projectsDir: string, opts: { includeSubagents: boolean; excludeProjects: readonly string[] }): Promise<{ sessions: number; bytes: number; projects: number; newest?: IsoDate }> {
  const files = await discoverClaudeCodeFiles(projectsDir, opts);
  const top = files.filter((f) => !f.isSubagent);
  const newest = files.reduce((m, f) => Math.max(m, f.mtimeMs), 0);
  const out: { sessions: number; bytes: number; projects: number; newest?: IsoDate } = {
    sessions: opts.includeSubagents ? files.length : top.length,
    bytes: files.reduce((s, f) => s + f.bytes, 0),
    projects: new Set(files.map((f) => f.projectSlug)).size,
  };
  if (newest > 0) out.newest = new Date(newest).toISOString();
  return out;
}
