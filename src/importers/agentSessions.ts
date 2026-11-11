/**
 * Shared engine of the opt-in session importers for other coding agents (Codex CLI, Gemini CLI, Cursor). Owner: E3.
 *
 * Each tool contributes only a `discover` (which files hold sessions) and a `load` (one file or database → parsed
 * sessions). Everything that matters for safety is here, once, and mirrors the Claude Code importer:
 *  - nothing is read until the person turns the tool on (`sources.<tool>.enabled`, off by default);
 *  - a session that changed within `liveIdleMinutes` goes to the local STAGE at once (visible immediately, this
 *    computer only) and is sealed into ONE immutable segment when it has been idle that long, or at the daily seal;
 *  - tool output is never imported unless `includeToolOutput` (then it is a hidden "tool" entry); harness text
 *    (injected instructions, environment blocks) is never imported;
 *  - a file is read again only when its size or modification time changed (cursors in the local cache); ids are
 *    stable, so a lost cursor only costs a dedupe against the ledger;
 *  - exclusions (corrections, the Off limits rows) apply before anything is written.
 * The text of a session is copied into the record's own segments; the original log is only ever read.
 */
import * as path from "node:path";
import { isCortexError } from "../shared/errors";
import { conversationId } from "../shared/ids";
import type { SourceImportStats } from "../shared/protocol/runner";
import type { AgentCliSetting, CortexSettings } from "../shared/settings";
import { firstLineTitle } from "../shared/text";
import type { FileCursor, IsoDate, SourceKind, SpaceId, Speaker } from "../shared/types";
import { sha256Text } from "../node/hash";
import { loadCursors, saveCursors } from "../store/cursors";
import { loadSourceManifest, updateSourceManifest } from "../store/manifest";
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
import { promises as fsp } from "node:fs";

export type AgentCliKind = "codex-cli" | "gemini-cli" | "cursor" | "capture";

/** One message of a parsed session, in the tool's own order. */
export interface AgentMessage {
  /** Stable inside the session: a tool id, or time + hash of the text. */
  nativeId: string;
  speaker: Speaker;
  speakerDetail?: string;
  text: string;
  ts?: IsoDate;
  /** "tool": tool calls and results (kept only when the tool's includeToolOutput is on). */
  hidden?: "tool";
}

export interface AgentSession {
  nativeId: string;
  title?: string;
  /** The project the work was in (last folder name of the working folder). */
  project?: string;
  cwd?: string;
  messages: AgentMessage[];
  /** The last line was still being written: read the file again next pass. */
  incomplete?: boolean;
  /** Changes whenever the session grew; lets a database with many sessions skip the unchanged ones. */
  fingerprint?: string;
}

export interface AgentLoadOptions {
  includeToolOutput: boolean;
}

export interface AgentCliTool {
  readonly kind: AgentCliKind;
  readonly source: SourceKind;
  readonly label: string;
  setting(s: CortexSettings): AgentCliSetting;
  /** The tool's usual folder when the setting is empty. */
  defaultDir(): string;
  /** The files that hold sessions under `root` (stat only; nothing is read). */
  discover(root: string): Promise<DiscoveredUnit[]>;
  /**
   * Parse one file into sessions. May throw; the pass records the failure and goes on. `known(id, fingerprint)`
   * says a session of a many-session file has not changed since the last pass (it may then be left out).
   */
  load(unit: DiscoveredUnit, opts: AgentLoadOptions, known: (nativeId: string, fingerprint: string) => boolean): Promise<AgentSession[]>;
}

export function agentRoot(tool: AgentCliTool, s: CortexSettings): string {
  const dir = tool.setting(s).dir.trim();
  return dir !== "" && path.isAbsolute(dir) ? dir : tool.defaultDir();
}

/** A message id from time and text, made unique inside a session by an occurrence counter. */
export function contentNativeId(seen: Map<string, number>, ts: string | undefined, role: string, text: string): string {
  const base = `${ts ?? ""}:${role}:${sha256Text(text).slice(0, 12)}`;
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n === 0 ? base : `${base}#${n}`;
}

/** The last folder name of a working folder, either separator ("C:\\Users\\me\\proj" → "proj"). */
export function projectOfCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last !== undefined && last.trim() !== "" ? last.trim() : undefined;
}

/** "2026-03-01T10:00:00.000Z" from an ISO string, epoch seconds or milliseconds; undefined when it is none of them. */
export function toIso(v: unknown): IsoDate | undefined {
  let t = Number.NaN;
  if (typeof v === "number" && Number.isFinite(v)) t = v < 1e11 ? v * 1000 : v;
  else if (typeof v === "string" && v.trim() !== "") t = /^\d+$/.test(v.trim()) ? toMs(Number(v.trim())) : Date.parse(v);
  return Number.isFinite(t) && t > 0 && t < 4.1e12 ? new Date(t).toISOString() : undefined;
}

function toMs(n: number): number {
  return n < 1e11 ? n * 1000 : n;
}

function spaceOfProject(project: string | undefined, spaceMap: Readonly<Record<string, SpaceId>>): SpaceId {
  if (project === undefined) return "none";
  const hit = Object.entries(spaceMap).find(([k]) => k.toLowerCase() === project.toLowerCase());
  return hit ? hit[1] : "none";
}

function sessionMeta(tool: AgentCliTool, s: AgentSession, spaceMap: Readonly<Record<string, SpaceId>>, prevSegDir: string | undefined, prevTitle: { title: string; by: ConversationMeta["titledBy"] } | undefined): ConversationMeta {
  const firstYou = s.messages.find((m) => m.speaker === "you" && m.hidden === undefined);
  const fromText = firstYou ? firstLineTitle(firstYou.text, 80) : "";
  const title = (s.title ?? "").trim() !== "" ? (s.title as string).trim().slice(0, 200) : fromText || prevTitle?.title || s.project || tool.label;
  const titledBy: ConversationMeta["titledBy"] = (s.title ?? "").trim() !== "" ? "native" : "first-line";
  const meta: Record<string, string> = {};
  if (s.cwd !== undefined) meta.cwd = s.cwd;
  meta.tool = tool.label;
  // The same field Claude Code sessions carry, so "Projects to skip" also holds back what agents may send later.
  if (s.project !== undefined) meta.projectSlug = s.project;
  meta.automated = firstYou ? "no" : "yes";
  const project = s.project ?? tool.label;
  const m: ConversationMeta = {
    id: conversationId(tool.source, s.nativeId),
    source: tool.source,
    nativeId: s.nativeId,
    title,
    titledBy,
    space: spaceOfProject(s.project, spaceMap),
    folder: [project],
    project,
    meta,
  };
  if (prevSegDir !== undefined) m.segDir = prevSegDir;
  return m;
}

/** The pass over one tool's sessions. */
export async function runAgentCli(tool: AgentCliTool, ctx: ImportContext): Promise<SourceImportStats> {
  const stats = emptyStats(tool.source, tool.label);
  const setting = tool.setting(ctx.settings);
  if (!setting.enabled) return stats;
  const root = agentRoot(tool, ctx.settings);
  let units: DiscoveredUnit[];
  try {
    units = await tool.discover(root);
  } catch (e) {
    if (isNotLocalError(e)) noteNotLocal(ctx, root);
    else warn(ctx, "path-unreadable");
    stats.errors.push({ file: tool.kind, message: "path-unreadable" });
    return stats;
  }
  units.sort((a, b) => a.mtimeMs - b.mtimeMs || a.key.localeCompare(b.key));
  stats.filesSeen = units.length;
  const privacy = await importPrivacy(ctx);
  const cursors = (await loadCursors(ctx.store)).files;
  const dirty: Record<string, FileCursor> = {};
  let newConversations = 0;
  const opts: AgentLoadOptions = { includeToolOutput: setting.includeToolOutput };
  const liveMs = setting.liveIdleMinutes * 60_000;
  const save = async (): Promise<void> => {
    if (ctx.dryRun || Object.keys(dirty).length === 0) return;
    const batch = { ...dirty };
    for (const k of Object.keys(dirty)) delete dirty[k];
    await saveCursors(ctx.store, batch);
  };
  const cursorOf = (p: string, size: number, mtimeMs: number, emitted: number, conv: FileCursor["conv"], fingerprint?: string): FileCursor => {
    const c: FileCursor = { path: p, size, mtimeMs, offset: 0, line: 0, emitted, updatedAt: new Date(ctx.now()).toISOString() };
    if (conv !== undefined) c.conv = conv;
    if (fingerprint !== undefined) c.lastUuid = fingerprint;
    return c;
  };
  try {
    let done = 0;
    for (const u of units) {
      if (overDeadline(ctx)) {
        if (ctx.tally) ctx.tally.partial = true;
        break;
      }
      done++;
      if (privacy.isOffLimits(u.path, { userRowsOnly: true })) {
        stats.skipped++;
        continue;
      }
      const cur = cursors[u.key];
      if (cur !== undefined && cur.size === u.bytes && cur.mtimeMs === u.mtimeMs) continue;
      if ((await checkpoint(ctx)) !== null) break;
      let sessions: AgentSession[];
      try {
        sessions = await tool.load(u, opts, (id, fp) => cursors[`${u.key}#${id}`]?.lastUuid === fp);
      } catch (e) {
        if (isCortexError(e) && e.code === "E_CANCELLED") throw e;
        if (isNotLocalError(e)) noteNotLocal(ctx, u.path);
        else warn(ctx, "import-failed");
        ctx.log.warn(`${tool.kind} import failed`, { code: isCortexError(e) ? e.code : "E_IO" });
        stats.errors.push({ file: path.basename(u.path), message: isNotLocalError(e) ? "not-local" : isCortexError(e) ? e.code : "E_IO" });
        continue;
      }
      stats.filesRead++;
      stats.bytesRead += u.bytes;
      let incompleteUnit = false;
      for (const s of sessions) {
        const conv = conversationId(tool.source, s.nativeId);
        const fpKey = `${u.key}#${s.nativeId}`;
        if (s.fingerprint !== undefined && cursors[fpKey]?.lastUuid === s.fingerprint) continue;
        if (privacy.isExcluded({ source: tool.source, sourceId: tool.kind, conv, ...(s.project !== undefined ? { project: s.project } : {}), path: u.path })) {
          stats.skipped++;
          continue;
        }
        if (s.incomplete === true) incompleteUnit = true;
        if (s.messages.length === 0) continue;
        const live = ctx.now() - u.mtimeMs < liveMs;
        const prev = await existingConversation(ctx, conv);
        const staged = await stagedMessages(ctx, conv);
        const startIdx = await nextIdxFor(ctx, conv, { staged });
        const batch = createConversationBatch(ctx, conv, startIdx, { live: live || staged.length > 0 });
        for (const m of s.messages) {
          if (m.hidden === "tool" && !opts.includeToolOutput) continue;
          const msg: PendingMessage = { nativeId: m.nativeId, speaker: m.speaker, text: m.text, sourceRef: { path: u.path, nativeId: m.nativeId, sha256: sha256Text(m.text) } };
          if (m.speakerDetail !== undefined) msg.speakerDetail = m.speakerDetail;
          if (m.ts !== undefined) msg.ts = m.ts;
          if (m.hidden !== undefined) msg.hiddenByDefault = m.hidden;
          batch.add(msg);
        }
        const meta = sessionMeta(tool, s, ctx.settings.sources.claudeCode.spaceMap, prev?.segDir, prev && prev.titledBy !== "native" ? { title: prev.title, by: prev.titledBy } : undefined);
        const added = await batch.flush(meta);
        stats.entriesAdded += added;
        if (added > 0) stats.conversationsTouched++;
        if (prev === undefined && added > 0) newConversations++;
        if (s.incomplete !== true && s.fingerprint !== undefined) dirty[fpKey] = cursorOf(u.path, u.bytes, u.mtimeMs, batch.nextIdx, conv, s.fingerprint);
      }
      // A unit is read again only when it changes; one whose last line was still being written is read again at once.
      dirty[u.key] = cursorOf(u.path, u.bytes, incompleteUnit ? -1 : u.mtimeMs, sessions.length, undefined);
      if (Object.keys(dirty).length >= 25) await save();
      if (done % 20 === 0) ctx.progress({ phase: tool.kind, done, total: units.length, unit: "sessions", note: String(stats.entriesAdded) });
    }
    ctx.progress({ phase: tool.kind, done, total: units.length, unit: "sessions", note: String(stats.entriesAdded) });
    const sealed = await sealStagedConversations(ctx, { all: ctx.options?.seal === true, idleMinutes: setting.liveIdleMinutes, source: tool.source });
    if (sealed.conversations > 0) ctx.log.info("sealed live sessions", { source: tool.kind, conversations: sealed.conversations, entries: sealed.entries });
  } finally {
    await save();
  }
  if (!ctx.dryRun) {
    const prev = (await loadSourceManifest(ctx.store)).sources[tool.kind];
    await updateSourceManifest(ctx.store, tool.kind, {
      kind: tool.source,
      path: root,
      bytes: units.reduce((s, f) => s + f.bytes, 0),
      importedAt: new Date(ctx.now()).toISOString(),
      entries: (prev?.entries ?? 0) + stats.entriesAdded,
      conversations: (prev?.conversations ?? 0) + newConversations,
      status: stats.errors.length > 0 && stats.filesRead === 0 && units.length > 0 ? "error" : setting.watch ? "watching" : "imported",
    });
  }
  return stats;
}

/** The Importer of a tool: opt-in, so `discover` lists nothing while the tool is off. */
export function agentCliImporter(tool: AgentCliTool): Importer {
  return {
    kind: tool.kind,
    source: tool.source,
    label: tool.label,
    async discover(_sel, ctx) {
      if (!tool.setting(ctx.settings).enabled) return [];
      return tool.discover(agentRoot(tool, ctx.settings)).catch(() => []);
    },
    run: (_sel, ctx) => runAgentCli(tool, ctx),
  } as Importer;
}

/** A directory listing helper: files under `root` (any depth ≤ `depth`) whose name matches. */
export async function findFiles(root: string, match: (rel: string, name: string) => boolean, depth = 6): Promise<DiscoveredUnit[]> {
  const out: DiscoveredUnit[] = [];
  const walk = async (dir: string, rel: string, d: number): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (d < depth) await walk(abs, r, d + 1);
      } else if (e.isFile() && match(r, e.name)) {
        const st = await fsp.stat(abs).catch(() => null);
        if (st) out.push({ key: abs, path: abs, bytes: st.size, mtimeMs: st.mtimeMs, label: r });
      }
    }
  };
  await walk(root, "", 0);
  return out;
}
