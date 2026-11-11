/**
 * Gemini CLI history importer (opt-in). Owner: E3.
 *
 * The Gemini CLI keeps its history under `~/.gemini/tmp/<project hash>/`:
 *   chats/session-<time>-<id>.json   {"sessionId","startTime","lastUpdated","messages":[{"id","timestamp","type",
 *                                     "content","model"?,"toolCalls"?,"thoughts"?}]}      type: "user" | "gemini"
 *   logs.json                        [{"sessionId","messageId","type":"user","message","timestamp"}]   what you typed
 * The chats are the conversation (your prompts and the replies); `logs.json` has only your prompts, so it is read
 * only for a project folder that has no chats. Info and error lines, and the model's "thoughts", are never kept.
 * Tool calls and their results are kept only with `includeToolOutput` (hidden "tool" entries). The folder name is
 * a hash of the project's path, so these sessions sit under the tool's name unless the file names the folder.
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { geminiCliHomeDir } from "../node/platform";
import type { SourceSelector } from "../shared/protocol/runner";
import type { AgentCliSetting, CortexSettings } from "../shared/settings";
import type { DiscoveredUnit } from "./common";
import { agentCliImporter, contentNativeId, findFiles, projectOfCwd, toIso, type AgentCliTool, type AgentLoadOptions, type AgentMessage, type AgentSession } from "./agentSessions";

export type GeminiCliSelector = Extract<SourceSelector, { kind: "gemini-cli" }>;

const MAX_TOOL_CALL_CHARS = 4000;
const MAX_TOOL_OUTPUT_CHARS = 8000;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Message content is a string, or a list of parts with `text`. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const p of content) {
    if (typeof p === "string") out.push(p);
    else if (isRecord(p) && typeof p.text === "string") out.push(p.text);
  }
  return out.join("\n").trim();
}

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!Array.isArray(result)) return "";
  const out: string[] = [];
  for (const r of result) {
    const fr = isRecord(r) && isRecord(r.functionResponse) ? r.functionResponse : undefined;
    const resp = fr && isRecord(fr.response) ? fr.response : undefined;
    const v = resp ? (typeof resp.output === "string" ? resp.output : typeof resp.error === "string" ? resp.error : JSON.stringify(resp)) : undefined;
    if (v) out.push(v);
  }
  return out.join("\n");
}

/** A chat file's parsed session; null when the JSON is not a Gemini CLI chat. */
export function parseGeminiChat(json: unknown, fallbackId: string, opts: AgentLoadOptions): AgentSession | null {
  if (!isRecord(json) || !Array.isArray(json.messages)) return null;
  const seen = new Map<string, number>();
  const messages: AgentMessage[] = [];
  for (const raw of json.messages) {
    if (!isRecord(raw)) continue;
    const ts = toIso(raw.timestamp);
    const type = raw.type;
    const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : undefined;
    const text = textOf(raw.content);
    if (type === "user" && text !== "") messages.push({ nativeId: id ?? contentNativeId(seen, ts, "you", text), speaker: "you", text, ...(ts !== undefined ? { ts } : {}) });
    else if (type === "gemini") {
      if (text !== "") {
        const m: AgentMessage = { nativeId: id ?? contentNativeId(seen, ts, "assistant", text), speaker: "assistant", text, ...(ts !== undefined ? { ts } : {}) };
        if (typeof raw.model === "string") m.speakerDetail = raw.model;
        messages.push(m);
      }
      if (opts.includeToolOutput && Array.isArray(raw.toolCalls)) {
        for (const call of raw.toolCalls) {
          if (!isRecord(call)) continue;
          const name = typeof call.name === "string" ? call.name : "tool";
          const args = isRecord(call.args) ? JSON.stringify(call.args) : "";
          const cid = typeof call.id === "string" ? call.id : undefined;
          const callText = clip(`${name}${args ? `: ${args}` : ""}`, MAX_TOOL_CALL_CHARS);
          messages.push({ nativeId: cid ? `${cid}:call` : contentNativeId(seen, ts, "tool-call", callText), speaker: "tool", text: callText, hidden: "tool", ...(ts !== undefined ? { ts } : {}) });
          const out = resultText(call.result);
          if (out.trim() !== "") messages.push({ nativeId: cid ? `${cid}:result` : contentNativeId(seen, ts, "tool-result", out), speaker: "tool", text: clip(out, MAX_TOOL_OUTPUT_CHARS), hidden: "tool", ...(ts !== undefined ? { ts } : {}) });
        }
      }
    }
  }
  const session: AgentSession = { nativeId: typeof json.sessionId === "string" && json.sessionId !== "" ? json.sessionId : fallbackId, messages };
  const cwd = typeof json.projectRoot === "string" ? json.projectRoot : typeof json.cwd === "string" ? json.cwd : undefined;
  if (cwd !== undefined) {
    session.cwd = cwd;
    const p = projectOfCwd(cwd);
    if (p !== undefined) session.project = p;
  }
  return session;
}

/** logs.json: your prompts only, grouped by session. */
export function parseGeminiLogs(json: unknown): AgentSession[] {
  if (!Array.isArray(json)) return [];
  const bySession = new Map<string, AgentMessage[]>();
  for (const raw of json) {
    if (!isRecord(raw) || raw.type !== "user" || typeof raw.sessionId !== "string" || typeof raw.message !== "string" || raw.message.trim() === "") continue;
    const ts = toIso(raw.timestamp);
    const list = bySession.get(raw.sessionId) ?? [];
    const idx = typeof raw.messageId === "number" ? raw.messageId : list.length;
    list.push({ nativeId: `log${idx}`, speaker: "you", text: raw.message.trim(), ...(ts !== undefined ? { ts } : {}) });
    bySession.set(raw.sessionId, list);
  }
  return [...bySession.entries()].map(([nativeId, messages]) => ({ nativeId, messages }));
}

export async function loadGeminiFile(unit: DiscoveredUnit, opts: AgentLoadOptions): Promise<AgentSession[]> {
  const text = await fsp.readFile(unit.path, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    // A chat is rewritten as a whole; a half-written file is read again when it changes.
    return [{ nativeId: path.basename(unit.path), messages: [], incomplete: true }];
  }
  if (path.basename(unit.path).toLowerCase() === "logs.json") return parseGeminiLogs(json);
  const s = parseGeminiChat(json, path.basename(unit.path).replace(/\.json$/i, ""), opts);
  return s ? [s] : [];
}

export async function discoverGeminiFiles(root: string): Promise<DiscoveredUnit[]> {
  const found = await findFiles(root, (rel, name) => (/(^|\/)chats\/session-[^/]*\.json$/i.test(rel) && name.endsWith(".json")) || /(^|\/)logs\.json$/i.test(rel), 5);
  const withChats = new Set(found.filter((f) => /chats[\\/]/i.test(f.label ?? "")).map((f) => path.dirname(path.dirname(f.path))));
  return found.filter((f) => path.basename(f.path).toLowerCase() !== "logs.json" || !withChats.has(path.dirname(f.path)));
}

export const geminiCliTool: AgentCliTool = {
  kind: "gemini-cli",
  source: "gemini-cli",
  label: "Gemini CLI",
  setting: (s: CortexSettings): AgentCliSetting => s.sources.geminiCli,
  defaultDir: () => geminiCliHomeDir(),
  discover: discoverGeminiFiles,
  load: loadGeminiFile,
};

export const GeminiCliImporter = () => agentCliImporter(geminiCliTool);
