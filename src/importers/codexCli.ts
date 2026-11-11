/**
 * Codex CLI session importer (opt-in). Owner: E3.
 *
 * Codex keeps one rollout file per session: `<CODEX_HOME or ~/.codex>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`
 * (and `archived_sessions/`). Each line is JSON. Shapes read here, both generations of the format:
 *   {"type":"session_meta","payload":{"id","cwd","timestamp",…}}             the session id and working folder
 *   {"type":"response_item","timestamp","payload":{"type":"message","role","content":[{"text"}]}}   the conversation
 *   {"type":"response_item","payload":{"type":"function_call"|"function_call_output"|…}}           tool traffic
 *   {"type":"event_msg","payload":{"type":"user_message"|"agent_message","message"}}               only used when
 *                                                                              a file has no response_item messages
 *   older files: {"id","timestamp"} first line, then {"type":"message","role","content"} lines.
 * Kept: what you typed and what the assistant answered. Never kept: reasoning, system and developer text, the
 * environment and instruction blocks Codex injects as "user" turns, token counts. Tool calls and their output are
 * kept only with `includeToolOutput` (hidden "tool" entries). Live files and the stage: see agentSessions.ts.
 */
import { createReadStream } from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { codexHomeDir } from "../node/platform";
import type { SourceSelector } from "../shared/protocol/runner";
import type { AgentCliSetting, CortexSettings } from "../shared/settings";
import type { DiscoveredUnit } from "./common";
import { agentCliImporter, contentNativeId, findFiles, projectOfCwd, toIso, type AgentCliTool, type AgentLoadOptions, type AgentMessage, type AgentSession } from "./agentSessions";

export type CodexSelector = Extract<SourceSelector, { kind: "codex-cli" }>;

const MAX_TOOL_CALL_CHARS = 4000;
const MAX_TOOL_OUTPUT_CHARS = 8000;

/** Text Codex puts in the "user" role that the person did not type. */
const HARNESS_START = /^\s*(<environment_context>|<user_instructions>|<permissions instructions>|<INSTRUCTIONS>|<turn_aborted>|<user_shell_command>|# AGENTS\.md instructions|<recent_conversation>|<collaboration_mode>)/;

export function isCodexHarnessText(text: string): boolean {
  return HARNESS_START.test(text);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c === "string") parts.push(c);
    else if (isRecord(c) && typeof c.text === "string") parts.push(c.text);
  }
  return parts.join("\n").trim();
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Incremental reader of one rollout file: feed lines, then `finish()`. */
export class CodexRollout {
  private id: string | undefined;
  private cwd: string | undefined;
  private readonly seen = new Map<string, number>();
  private readonly responseMessages: AgentMessage[] = [];
  private readonly eventMessages: AgentMessage[] = [];
  private readonly tools: { at: number; msg: AgentMessage }[] = [];
  private bad = 0;
  private lastBad = false;

  constructor(private readonly fallbackId: string, private readonly opts: AgentLoadOptions) {}

  push(line: string): void {
    const t = line.trim();
    if (t === "") return;
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      this.bad++;
      this.lastBad = true;
      return;
    }
    this.lastBad = false;
    if (!isRecord(obj)) return;
    const ts = toIso(obj.timestamp);
    const type = obj.type;
    const payload = isRecord(obj.payload) ? obj.payload : undefined;
    if (type === "session_meta" && payload) {
      if (typeof payload.id === "string") this.id ??= payload.id;
      if (typeof payload.cwd === "string") this.cwd ??= payload.cwd;
      return;
    }
    if (type === undefined && typeof obj.id === "string" && obj.role === undefined) {
      // Older first line: {"id","timestamp","instructions"}
      this.id ??= obj.id;
      return;
    }
    if (type === "response_item" && payload) {
      this.item(payload, ts);
      return;
    }
    if (type === "event_msg" && payload) {
      const kind = payload.type;
      const text = typeof payload.message === "string" ? payload.message.trim() : "";
      if (text === "") return;
      if (kind === "user_message") this.eventMessages.push({ nativeId: contentNativeId(this.seen, ts, "you", text), speaker: "you", text, ...(ts !== undefined ? { ts } : {}) });
      else if (kind === "agent_message") this.eventMessages.push({ nativeId: contentNativeId(this.seen, ts, "assistant", text), speaker: "assistant", text, ...(ts !== undefined ? { ts } : {}) });
      return;
    }
    if (typeof type === "string" && (type === "message" || type === "function_call" || type === "function_call_output" || type === "local_shell_call" || type === "custom_tool_call" || type === "custom_tool_call_output")) {
      this.item(obj, ts);
    }
  }

  private item(p: Record<string, unknown>, ts: IsoOrUndefined): void {
    const kind = p.type;
    if (kind === "message") {
      const role = p.role;
      const text = textOfContent(p.content);
      if (text === "" || (role !== "user" && role !== "assistant")) return;
      if (role === "user" && isCodexHarnessText(text)) return;
      const speaker = role === "user" ? "you" : "assistant";
      this.responseMessages.push({ nativeId: contentNativeId(this.seen, ts, speaker, text), speaker, text, ...(ts !== undefined ? { ts } : {}) });
      return;
    }
    if (kind === "function_call" || kind === "local_shell_call" || kind === "custom_tool_call") {
      const name = typeof p.name === "string" ? p.name : kind === "local_shell_call" ? "shell" : "tool";
      const args = typeof p.arguments === "string" ? p.arguments : typeof p.input === "string" ? p.input : isRecord(p.action) ? JSON.stringify(p.action) : "";
      const text = clip(`${name}${args ? `: ${args}` : ""}`, MAX_TOOL_CALL_CHARS);
      this.tools.push({ at: this.responseMessages.length, msg: { nativeId: contentNativeId(this.seen, ts, "tool-call", text), speaker: "tool", text, hidden: "tool", ...(ts !== undefined ? { ts } : {}) } });
      return;
    }
    if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      const out = typeof p.output === "string" ? p.output : isRecord(p.output) && typeof p.output.content === "string" ? p.output.content : "";
      if (out.trim() === "") return;
      const text = clip(out, MAX_TOOL_OUTPUT_CHARS);
      this.tools.push({ at: this.responseMessages.length, msg: { nativeId: contentNativeId(this.seen, ts, "tool-result", text), speaker: "tool", text, hidden: "tool", ...(ts !== undefined ? { ts } : {}) } });
    }
  }

  finish(endedWithNewline: boolean): AgentSession {
    const base = this.responseMessages.length > 0 ? this.responseMessages : this.eventMessages;
    const messages: AgentMessage[] = [];
    if (this.opts.includeToolOutput && this.responseMessages.length > 0) {
      let t = 0;
      for (let i = 0; i <= base.length; i++) {
        while (t < this.tools.length && (this.tools[t] as { at: number }).at <= i) messages.push((this.tools[t++] as { msg: AgentMessage }).msg);
        if (i < base.length) messages.push(base[i] as AgentMessage);
      }
    } else messages.push(...base);
    const session: AgentSession = { nativeId: this.id ?? this.fallbackId, messages };
    const project = projectOfCwd(this.cwd);
    if (this.cwd !== undefined) session.cwd = this.cwd;
    if (project !== undefined) session.project = project;
    // A last line that does not parse and has no newline after it is a line still being written.
    if (this.lastBad && !endedWithNewline) session.incomplete = true;
    return session;
  }
}

type IsoOrUndefined = string | undefined;

/** "rollout-2026-03-01T10-00-00-<uuid>.jsonl" → the uuid at the end; the whole stem otherwise. */
export function codexSessionIdOfFile(file: string): string {
  const stem = path.basename(file).replace(/\.jsonl$/i, "");
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(stem);
  return m ? (m[1] as string).toLowerCase() : stem;
}

async function endsWithNewline(file: string, size: number): Promise<boolean> {
  if (size === 0) return true;
  const { open } = await import("node:fs/promises");
  const fh = await open(file, "r");
  try {
    const b = Buffer.alloc(1);
    await fh.read(b, 0, 1, size - 1);
    return b[0] === 0x0a;
  } finally {
    await fh.close();
  }
}

export async function loadCodexFile(unit: DiscoveredUnit, opts: AgentLoadOptions): Promise<AgentSession[]> {
  const rollout = new CodexRollout(codexSessionIdOfFile(unit.path), opts);
  const rl = createInterface({ input: createReadStream(unit.path, { encoding: "utf8", highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  for await (const line of rl) rollout.push(line);
  return [rollout.finish(await endsWithNewline(unit.path, unit.bytes))];
}

export const codexCliTool: AgentCliTool = {
  kind: "codex-cli",
  source: "codex-cli",
  label: "Codex CLI",
  setting: (s: CortexSettings): AgentCliSetting => s.sources.codexCli,
  defaultDir: () => codexHomeDir(),
  discover: (root) => findFiles(root, (_rel, name) => /^rollout-.*\.jsonl$/i.test(name)),
  load: loadCodexFile,
};

export const CodexCliImporter = () => agentCliImporter(codexCliTool);
