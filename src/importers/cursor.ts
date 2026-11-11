/**
 * Cursor chat store importer (opt-in). Owner: E3.
 *
 * Cursor keeps its chats in SQLite files (VS Code's `state.vscdb`) under its user folder
 * (`%APPDATA%/Cursor/User`, `~/Library/Application Support/Cursor/User`, `~/.config/Cursor/User`):
 *   globalStorage/state.vscdb       table cursorDiskKV
 *                                   `composerData:<id>`            {composerId, name, createdAt, lastUpdatedAt,
 *                                                                   fullConversationHeadersOnly:[{bubbleId,type}]}
 *                                   `bubbleId:<id>:<bubbleId>`     {type: 1 = you, 2 = assistant, text, …}
 *   workspaceStorage/<h>/state.vscdb table ItemTable, key `workbench.panel.aichat.view.aichat.chatdata`
 *                                   {tabs:[{tabId, chatTitle, bubbles:[{type:"user"|"ai", text, id?}]}]} (older chat)
 *                                   next to it workspace.json {"folder":"file:///…/project"} names the project.
 * The files are opened READ ONLY and never written; Cursor may be running. They are read with `node:sqlite`; a
 * build whose Node has none cannot read them, and the pass says so instead of guessing. Kept: what you typed and
 * what the assistant answered. Never kept: thinking, rich-text copies, code-block diffs. Tool calls are kept only
 * with `includeToolOutput` (hidden "tool" entries). A conversation whose last-update stamp and message count have
 * not changed is not read again. Live sessions and the stage: see agentSessions.ts.
 *
 * The layout follows what current Cursor builds write; Cursor changes it between versions, so anything that does
 * not look like a chat is skipped and counted, never guessed.
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { CortexError } from "../shared/errors";
import { cursorUserDir } from "../node/platform";
import type { SourceSelector } from "../shared/protocol/runner";
import type { AgentCliSetting, CortexSettings } from "../shared/settings";
import type { DiscoveredUnit } from "./common";
import { agentCliImporter, contentNativeId, projectOfCwd, toIso, type AgentCliTool, type AgentLoadOptions, type AgentMessage, type AgentSession } from "./agentSessions";

export type CursorSelector = Extract<SourceSelector, { kind: "cursor" }>;

const MAX_TOOL_CALL_CHARS = 4000;
const MAX_TOOL_OUTPUT_CHARS = 8000;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// ───────────────────────────── pure parsing (rows → sessions) ─────────────────────────────

export interface CursorBubble {
  id: string;
  /** 1 = you, 2 = assistant (global store); "user" / "ai" in the older chat panel. */
  type: unknown;
  text?: unknown;
  createdAt?: unknown;
  model?: unknown;
  toolFormerData?: unknown;
}

function speakerOfBubble(type: unknown): "you" | "assistant" | undefined {
  if (type === 1 || type === "user" || type === "1") return "you";
  if (type === 2 || type === "ai" || type === "assistant" || type === "2") return "assistant";
  return undefined;
}

function toolText(t: unknown): { call?: string; result?: string } {
  if (!isRecord(t)) return {};
  const name = typeof t.name === "string" ? t.name : "tool";
  const params = typeof t.params === "string" ? t.params : isRecord(t.params) ? JSON.stringify(t.params) : typeof t.rawArgs === "string" ? t.rawArgs : "";
  const result = typeof t.result === "string" ? t.result : isRecord(t.result) ? JSON.stringify(t.result) : "";
  return { call: clip(`${name}${params ? `: ${params}` : ""}`, MAX_TOOL_CALL_CHARS), ...(result.trim() !== "" ? { result: clip(result, MAX_TOOL_OUTPUT_CHARS) } : {}) };
}

/** Bubbles of one conversation → messages. */
export function cursorMessages(bubbles: readonly CursorBubble[], opts: AgentLoadOptions): AgentMessage[] {
  const seen = new Map<string, number>();
  const out: AgentMessage[] = [];
  for (const b of bubbles) {
    const ts = toIso(b.createdAt);
    const text = typeof b.text === "string" ? b.text.trim() : "";
    const who = speakerOfBubble(b.type);
    if (who !== undefined && text !== "") {
      const m: AgentMessage = { nativeId: b.id !== "" ? b.id : contentNativeId(seen, ts, who, text), speaker: who, text, ...(ts !== undefined ? { ts } : {}) };
      if (who === "assistant" && typeof b.model === "string" && b.model !== "") m.speakerDetail = b.model;
      out.push(m);
    }
    if (opts.includeToolOutput && b.toolFormerData !== undefined) {
      const t = toolText(b.toolFormerData);
      if (t.call !== undefined) out.push({ nativeId: `${b.id}:call`, speaker: "tool", text: t.call, hidden: "tool", ...(ts !== undefined ? { ts } : {}) });
      if (t.result !== undefined) out.push({ nativeId: `${b.id}:result`, speaker: "tool", text: t.result, hidden: "tool", ...(ts !== undefined ? { ts } : {}) });
    }
  }
  return out;
}

/** The older chat panel's value: tabs of bubbles. */
export function parseCursorChatTabs(json: unknown, project: string | undefined, opts: AgentLoadOptions): AgentSession[] {
  if (!isRecord(json) || !Array.isArray(json.tabs)) return [];
  const sessions: AgentSession[] = [];
  for (const tab of json.tabs) {
    if (!isRecord(tab) || typeof tab.tabId !== "string" || !Array.isArray(tab.bubbles)) continue;
    const bubbles: CursorBubble[] = [];
    let i = 0;
    for (const raw of tab.bubbles) {
      if (!isRecord(raw)) continue;
      bubbles.push({ id: typeof raw.id === "string" ? raw.id : `b${i}`, type: raw.type, text: typeof raw.text === "string" && raw.text !== "" ? raw.text : raw.rawText, createdAt: raw.createdAt ?? raw.timestamp, model: raw.modelType });
      i++;
    }
    const messages = cursorMessages(bubbles, opts);
    const s: AgentSession = { nativeId: `tab:${tab.tabId}`, messages, fingerprint: `${toIso(tab.lastSendTime) ?? ""}:${bubbles.length}` };
    if (typeof tab.chatTitle === "string" && tab.chatTitle.trim() !== "") s.title = tab.chatTitle.trim();
    if (project !== undefined) s.project = project;
    sessions.push(s);
  }
  return sessions;
}

/** "file:///c%3A/Users/me/project" → "project". */
export function projectOfWorkspaceFolder(folder: unknown): string | undefined {
  if (typeof folder !== "string") return undefined;
  let p = folder.replace(/^[a-z-]+:\/\//i, "");
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep the encoded form
  }
  return projectOfCwd(p);
}

// ───────────────────────────── SQLite ─────────────────────────────

interface SqliteStatement {
  run(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
}
export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type SqliteCtor = new (file: string, opts?: { readOnly?: boolean }) => SqliteDb;

/** `node:sqlite` when this Node has it. Loaded by a computed name so bundlers leave it alone. */
export async function loadSqlite(): Promise<SqliteCtor | null> {
  try {
    const spec = "node:sqlite";
    const mod = (await import(/* @vite-ignore */ spec)) as { DatabaseSync?: SqliteCtor };
    return typeof mod.DatabaseSync === "function" ? mod.DatabaseSync : null;
  } catch {
    return null;
  }
}

function asText(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  return null;
}

function parseJson(v: unknown): unknown {
  const s = asText(v);
  if (s === null) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

function hasTable(db: SqliteDb, name: string): boolean {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** Sessions of one `state.vscdb`. `known(id, fingerprint)` says a conversation has not changed since the last pass. */
export function readCursorDb(db: SqliteDb, project: string | undefined, opts: AgentLoadOptions, known: (nativeId: string, fingerprint: string) => boolean): AgentSession[] {
  const sessions: AgentSession[] = [];
  if (hasTable(db, "cursorDiskKV")) {
    const rows = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all() as { key: string; value: unknown }[];
    const bubbleStmt = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
    for (const row of rows) {
      const data = parseJson(row.value);
      if (!isRecord(data)) continue;
      const cid = typeof data.composerId === "string" ? data.composerId : row.key.slice("composerData:".length);
      const headers = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];
      const inline = Array.isArray(data.conversation) ? data.conversation : [];
      const count = headers.length > 0 ? headers.length : inline.length;
      if (count === 0) continue;
      const fingerprint = `${toIso(data.lastUpdatedAt) ?? toIso(data.createdAt) ?? ""}:${count}`;
      if (known(cid, fingerprint)) continue;
      const bubbles: CursorBubble[] = [];
      if (headers.length > 0) {
        for (const h of headers) {
          if (!isRecord(h) || typeof h.bubbleId !== "string") continue;
          const b = parseJson((bubbleStmt.get(`bubbleId:${cid}:${h.bubbleId}`) as { value?: unknown } | undefined)?.value);
          if (isRecord(b)) bubbles.push({ id: h.bubbleId, type: b.type ?? h.type, text: b.text, createdAt: b.createdAt, model: isRecord(b.modelInfo) ? b.modelInfo.modelName : b.model, toolFormerData: b.toolFormerData });
        }
      } else {
        inline.forEach((b: unknown, i: number) => {
          if (isRecord(b)) bubbles.push({ id: typeof b.bubbleId === "string" ? b.bubbleId : `b${i}`, type: b.type, text: b.text, createdAt: b.createdAt, toolFormerData: b.toolFormerData });
        });
      }
      const s: AgentSession = { nativeId: cid, messages: cursorMessages(bubbles, opts), fingerprint };
      if (typeof data.name === "string" && data.name.trim() !== "") s.title = data.name.trim();
      if (project !== undefined) s.project = project;
      sessions.push(s);
    }
  }
  if (hasTable(db, "ItemTable")) {
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata'").get() as { value?: unknown } | undefined;
    if (row) {
      for (const s of parseCursorChatTabs(parseJson(row.value), project, opts)) {
        if (s.fingerprint !== undefined && known(s.nativeId, s.fingerprint)) continue;
        sessions.push(s);
      }
    }
  }
  return sessions;
}

export async function loadCursorFile(unit: DiscoveredUnit, opts: AgentLoadOptions, known: (nativeId: string, fingerprint: string) => boolean = () => false): Promise<AgentSession[]> {
  const Database = await loadSqlite();
  if (Database === null) throw new CortexError("E_NOT_IMPLEMENTED", "this build of Node cannot read Cursor's chat store (no node:sqlite)");
  let project: string | undefined;
  try {
    const ws = JSON.parse(await fsp.readFile(path.join(path.dirname(unit.path), "workspace.json"), "utf8")) as unknown;
    if (isRecord(ws)) project = projectOfWorkspaceFolder(ws.folder ?? ws.workspace);
  } catch {
    project = undefined;
  }
  const db = new Database(unit.path, { readOnly: true });
  try {
    return readCursorDb(db, project, opts, known);
  } finally {
    db.close();
  }
}

/** The databases under Cursor's user folder; a database and its write-ahead log count as one unit. */
export async function discoverCursorFiles(root: string): Promise<DiscoveredUnit[]> {
  const out: DiscoveredUnit[] = [];
  const candidates: string[] = [path.join(root, "globalStorage", "state.vscdb")];
  try {
    for (const d of await fsp.readdir(path.join(root, "workspaceStorage"), { withFileTypes: true })) if (d.isDirectory()) candidates.push(path.join(root, "workspaceStorage", d.name, "state.vscdb"));
  } catch {
    // no workspace folders
  }
  for (const file of candidates) {
    const st = await fsp.stat(file).catch(() => null);
    if (!st?.isFile()) continue;
    const wal = await fsp.stat(`${file}-wal`).catch(() => null);
    out.push({ key: file, path: file, bytes: st.size + (wal?.size ?? 0), mtimeMs: Math.max(st.mtimeMs, wal?.mtimeMs ?? 0), label: path.relative(root, file).replace(/\\/g, "/") });
  }
  return out;
}

export const cursorTool: AgentCliTool = {
  kind: "cursor",
  source: "cursor",
  label: "Cursor",
  setting: (s: CortexSettings): AgentCliSetting => s.sources.cursor,
  defaultDir: () => cursorUserDir(),
  discover: discoverCursorFiles,
  load: loadCursorFile,
};

export const CursorImporter = () => agentCliImporter(cursorTool);
