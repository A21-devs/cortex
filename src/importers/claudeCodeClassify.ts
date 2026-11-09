/**
 * Claude Code transcript line classification (pure). Owner: E3.
 *
 * Verified against the user's transcripts (Claude Code 2.1.319, structure only — keys, types and counts, never
 * text — 2026-11-09):
 *  - line types: user, assistant, attachment, system, custom-title, ai-title, agent-name, plus housekeeping
 *    (api-request, api-request-blob, api-request-shape, atis-latch, last-prompt, queue-operation,
 *    bridge-session, tools-used, relocated, mode, permission-mode, file-history-snapshot/-delta, cost-state);
 *  - "api-request-blob" lines repeat request content: never import them (duplicates);
 *  - assistant replies are streamed one content block per line, sharing `message.id`; the blocks of one message
 *    can be interleaved with the tool results its tool calls produced: merge text blocks of consecutive message
 *    EVENTS (skipped lines do not end a message, another message does);
 *  - who wrote a user line (origin markers by entrypoint):
 *      claude-desktop: `promptSource: "sdk"` + `origin.kind: "human"` (newer lines add `turnOrigin: "human"`)
 *        — the person typing in the desktop app (median 70 characters);
 *      cli: `promptSource: "typed"` + `turnOrigin: "human"` — the person in the terminal;
 *      sdk-cli: `promptSource: "sdk"` + `turnOrigin: "sdk"`, no origin — headless automation (`claude -p`);
 *      task notifications: `turnOrigin: "task_notification"` / `promptSource: "system"` /
 *        `origin.kind: "task-notification"`; messages from other sessions: `origin.kind: "peer"`;
 *      no markers at all: "[Request interrupted by user…]" markers and compaction summaries in current
 *        versions; typed text in old versions (kept as the user's unless it matches a harness pattern);
 *  - harness wrappers start with tags such as <task-notification>, <command-name>, <local-command-stdout>;
 *  - user-queued prompts arrive as attachment lines {type:"queued_command", prompt, commandMode, origin}; the
 *    prompt is a string or content blocks; commandMode "task-notification" and origin "peer" are machine text;
 *  - compaction writes both a system "compact_boundary" line and a user line with isCompactSummary (the
 *    summary, machine text): both are part boundaries;
 *  - timestamps are ISO UTC with "Z"; a live file may end in a partial line (callers keep it for later).
 */
import type { AttachmentRef, Speaker } from "../shared/types";

export interface CcOptions {
  includeThinking: boolean;
  includeToolCalls: boolean;
  includeToolResults: boolean;
  includeHarness: boolean;
}

export interface CcRawLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  message?: { id?: string; role?: string; model?: string; content?: unknown };
  promptSource?: string;
  turnOrigin?: string;
  origin?: { kind?: string } | null;
  entrypoint?: string;
  cwd?: string;
  gitBranch?: string;
  agentId?: string;
  subtype?: string;
  customTitle?: string;
  aiTitle?: string;
  agentName?: string;
  summary?: string;
  attachment?: { type?: string; prompt?: unknown; commandMode?: string; origin?: { kind?: string } | null } | null;
  toolUseResult?: unknown;
}

export type CcHidden = "harness" | "tool" | "subagent";

export type CcEvent =
  | {
      kind: "message";
      speaker: Speaker;
      speakerDetail?: string;
      text: string;
      /** Line uuid (first line of a merged assistant message). */
      nativeId: string;
      /** Assistant message id used to merge streamed blocks. */
      messageId?: string;
      ts?: string;
      hidden?: CcHidden;
      /** Images the person attached (metadata only: Cortex keeps the text, never the image). */
      attachments?: AttachmentRef[];
    }
  | { kind: "title"; title: string; by: "user" | "model" }
  | { kind: "part-boundary"; ts?: string }
  | { kind: "meta"; cwd?: string; gitBranch?: string; entrypoint?: string; sessionId?: string }
  | { kind: "skip"; reason: string };

/** Housekeeping line types that never carry conversation text. */
export const SKIP_TYPES: ReadonlySet<string> = new Set([
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "atis-latch",
  "last-prompt",
  "queue-operation",
  "bridge-session",
  "tools-used",
  "relocated",
  "mode",
  "permission-mode",
  "file-history-snapshot",
  "file-history-delta",
  "cost-state",
  "agent-name",
  "progress",
]);

/** Wrapper tags inserted by the harness rather than typed by a person. */
export const HARNESS_TAGS: ReadonlySet<string> = new Set([
  "system-reminder",
  "task-notification",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "command-message",
  "command-name",
  "command-args",
  "command-contents",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  "user-prompt-submit-hook",
  "tool-use-error",
]);

/** Whole-message texts the harness writes into user turns. */
export const HARNESS_TEXTS: readonly RegExp[] = [/^\[Request interrupted by user[^\]\n]*\]$/];

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  source?: { type?: string; media_type?: string; data?: unknown };
}

function blocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content.filter((b) => typeof b === "object" && b !== null) as Block[]) : [];
}

/** Concatenate text blocks (or the string content) of a message. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  return blocks(content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n\n");
}

/** Image blocks of a message as attachment metadata (the image itself is never kept). */
export function imageAttachments(content: unknown): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  for (const b of blocks(content)) {
    if (b.type !== "image") continue;
    const mime = typeof b.source?.media_type === "string" && /^image\/[\w.+-]+$/.test(b.source.media_type) ? b.source.media_type : "image/*";
    const data = b.source?.data;
    const bytes = typeof data === "string" ? Math.floor((data.length * 3) / 4) : 0;
    const ext = mime === "image/*" ? "img" : (mime.split("/")[1] ?? "img").replace(/[^a-z0-9]/gi, "").slice(0, 8) || "img";
    out.push({ name: `image-${out.length + 1}.${ext}`, bytes, mime });
  }
  return out;
}

const LEADING_TAG = /^\s*<([a-zA-Z][a-zA-Z0-9_-]*)[\s>]/;

export function leadingTag(text: string): string | undefined {
  return LEADING_TAG.exec(text)?.[1];
}

/** "/name args" from a slash-command wrapper, or undefined. */
export function slashCommandText(text: string): string | undefined {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return undefined;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? "";
  const cmd = name.startsWith("/") ? name : `/${name}`;
  return args ? `${cmd} ${args}` : cmd;
}

function isToolResultOnly(content: unknown): boolean {
  const bs = blocks(content);
  return bs.length > 0 && bs.every((b) => b.type === "tool_result");
}

function isHarnessText(text: string): boolean {
  const s = text.trim();
  return HARNESS_TEXTS.some((re) => re.test(s));
}

/** Who wrote a user-role line (see the marker table in the header). */
export function userSpeaker(line: CcRawLine): { speaker: Speaker; detail?: string; hidden?: CcHidden } {
  const kind = line.origin?.kind;
  if (line.turnOrigin === "task_notification" || line.promptSource === "system" || kind === "task-notification") {
    return { speaker: "other", detail: "harness", hidden: "harness" };
  }
  if (line.turnOrigin === "human") return { speaker: "you" };
  if (line.turnOrigin === "sdk") return { speaker: "other", detail: "automated prompt", hidden: "harness" };
  if (kind === "human") return { speaker: "you" };
  if (kind === "peer") return { speaker: "other", detail: "another session", hidden: "harness" };
  // An origin Cortex does not know yet: never attributed to the user, never dropped.
  if (typeof kind === "string" && kind.length > 0) return { speaker: "other", detail: kind.slice(0, 40) };
  if (line.promptSource === "typed") return { speaker: "you" };
  if (line.promptSource === "sdk") return { speaker: "other", detail: "automated prompt", hidden: "harness" };
  // Older lines without origin markers: plain text typed in a session is the user's.
  return { speaker: "you" };
}

function queuedSpeaker(a: NonNullable<CcRawLine["attachment"]>): { speaker: Speaker; detail?: string; hidden?: CcHidden } {
  const kind = a.origin?.kind;
  const promptMode = a.commandMode === undefined || a.commandMode === "prompt";
  if (promptMode && (kind === undefined || kind === "human")) return { speaker: "you" };
  if (kind === "peer") return { speaker: "other", detail: "another session", hidden: "harness" };
  return { speaker: "other", detail: "harness", hidden: "harness" };
}

/** Classify one parsed transcript line into zero or more events. */
export function classifyLine(line: CcRawLine, opts: CcOptions, isSubagentFile: boolean): CcEvent[] {
  const type = line.type ?? "";
  const ts = typeof line.timestamp === "string" ? line.timestamp : undefined;
  if (SKIP_TYPES.has(type)) return [{ kind: "skip", reason: `type:${type}` }];
  if (type === "custom-title" && typeof line.customTitle === "string" && line.customTitle.trim()) return [{ kind: "title", title: line.customTitle.trim(), by: "user" }];
  if (type === "ai-title" && typeof line.aiTitle === "string" && line.aiTitle.trim()) return [{ kind: "title", title: line.aiTitle.trim(), by: "model" }];
  if (type === "summary" && typeof line.summary === "string" && line.summary.trim()) return [{ kind: "title", title: line.summary.trim(), by: "model" }];
  if (type === "system") {
    return line.subtype === "compact_boundary" ? [{ kind: "part-boundary", ...(ts ? { ts } : {}) }] : [{ kind: "skip", reason: `system:${line.subtype ?? "?"}` }];
  }
  const nativeId = typeof line.uuid === "string" ? line.uuid : "";
  const subagent: CcHidden | undefined = isSubagentFile || line.isSidechain === true ? "subagent" : undefined;
  const events: CcEvent[] = [];
  if (line.cwd || line.gitBranch || line.entrypoint) {
    events.push({
      kind: "meta",
      ...(typeof line.cwd === "string" && line.cwd ? { cwd: line.cwd } : {}),
      ...(typeof line.gitBranch === "string" && line.gitBranch ? { gitBranch: line.gitBranch } : {}),
      ...(typeof line.entrypoint === "string" && line.entrypoint ? { entrypoint: line.entrypoint } : {}),
      ...(typeof line.sessionId === "string" && line.sessionId ? { sessionId: line.sessionId } : {}),
    });
  }

  if (type === "attachment") {
    const a = line.attachment;
    if (a?.type === "queued_command") {
      const text = typeof a.prompt === "string" ? a.prompt : messageText(a.prompt);
      if (!text.trim()) return [...events, { kind: "skip", reason: "queued:empty" }];
      const who = queuedSpeaker(a);
      if (who.hidden === "harness" && !opts.includeHarness) return [...events, { kind: "skip", reason: "queued:harness" }];
      const slash = who.speaker === "you" && /^\/[\w:.-]+(\s|$)/.test(text.trim());
      const hidden = who.hidden ?? subagent;
      events.push({
        kind: "message",
        speaker: subagent && who.speaker === "you" ? "other" : who.speaker,
        ...(subagent && who.speaker === "you" ? { speakerDetail: "parent agent" } : who.detail ? { speakerDetail: who.detail } : slash ? { speakerDetail: "slash command" } : {}),
        ...(hidden ? { hidden } : {}),
        text,
        nativeId,
        ...(ts ? { ts } : {}),
      });
      return events;
    }
    return [...events, { kind: "skip", reason: `attachment:${a?.type ?? "?"}` }];
  }

  if (type === "user") {
    if (line.isMeta) return [...events, { kind: "skip", reason: "meta" }];
    const content = line.message?.content;
    if (line.isCompactSummary) {
      events.push({ kind: "part-boundary", ...(ts ? { ts } : {}) });
      if (opts.includeHarness) {
        events.push({ kind: "message", speaker: "other", speakerDetail: "compaction summary", text: messageText(content), nativeId, hidden: "harness", ...(ts ? { ts } : {}) });
      }
      return events;
    }
    if (line.toolUseResult !== undefined || isToolResultOnly(content)) {
      if (!opts.includeToolResults) return [...events, { kind: "skip", reason: "tool-result" }];
      const out = toolResultText(content);
      if (!out.trim()) return [...events, { kind: "skip", reason: "tool-result-empty" }];
      events.push({ kind: "message", speaker: "tool", speakerDetail: "tool output", text: out, nativeId, hidden: "tool", ...(ts ? { ts } : {}) });
      return events;
    }
    let text = messageText(content);
    if (!text.trim()) return [...events, { kind: "skip", reason: "empty" }];
    const who = userSpeaker(line);
    let speaker = who.speaker;
    let detail = who.detail;
    let hidden: CcHidden | undefined = who.hidden ?? subagent;
    const tag = leadingTag(text);
    if (tag && HARNESS_TAGS.has(tag)) {
      const cmd = tag === "command-message" || tag === "command-name" ? slashCommandText(text) : undefined;
      if (cmd && who.speaker === "you") {
        text = cmd;
        detail = "slash command";
      } else {
        speaker = "other";
        detail = "harness";
        hidden = "harness";
      }
    } else if (isHarnessText(text)) {
      speaker = "other";
      detail = "harness";
      hidden = "harness";
    }
    if (hidden === "harness" && !opts.includeHarness) return [...events, { kind: "skip", reason: "harness" }];
    if (subagent && speaker === "you") {
      speaker = "other";
      detail = "parent agent";
    }
    const attachments = speaker === "you" ? imageAttachments(content) : [];
    events.push({
      kind: "message",
      speaker,
      text,
      nativeId,
      ...(detail ? { speakerDetail: detail } : {}),
      ...(hidden ? { hidden } : {}),
      ...(ts ? { ts } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    return events;
  }

  if (type === "assistant") {
    if (line.isApiErrorMessage) return [...events, { kind: "skip", reason: "api-error" }];
    const model = line.message?.model;
    if (model === "<synthetic>" && !opts.includeHarness) return [...events, { kind: "skip", reason: "synthetic" }];
    const bs = blocks(line.message?.content);
    const parts: string[] = [];
    for (const b of bs) {
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "thinking" && opts.includeThinking && typeof b.thinking === "string") parts.push(b.thinking);
      else if (b.type === "tool_use" && opts.includeToolCalls && b.name) parts.push(`${b.name}: ${shortInput(b.input)}`);
    }
    const text = parts.join("\n\n");
    if (!text.trim()) return [...events, { kind: "skip", reason: "no-text-blocks" }];
    const synthetic = model === "<synthetic>";
    events.push({
      kind: "message",
      speaker: synthetic ? "other" : "assistant",
      ...(synthetic ? { speakerDetail: "harness" } : model ? { speakerDetail: model } : {}),
      text,
      nativeId,
      ...(line.message?.id ? { messageId: line.message.id } : {}),
      ...(synthetic ? { hidden: "harness" as const } : subagent ? { hidden: subagent } : {}),
      ...(ts ? { ts } : {}),
    });
    return events;
  }
  return [...events, { kind: "skip", reason: `type:${type || "none"}` }];
}

function shortInput(input: unknown): string {
  try {
    const s = JSON.stringify(input) ?? "";
    return s.length > 160 ? s.slice(0, 159) + "…" : s;
  } catch {
    return "";
  }
}

function toolResultText(content: unknown): string {
  const out: string[] = [];
  for (const b of blocks(content) as (Block & { content?: unknown })[]) {
    if (b.type !== "tool_result") continue;
    if (typeof b.content === "string") out.push(b.content);
    else out.push(messageText(b.content));
  }
  const s = out.join("\n\n");
  return s.length > 4000 ? s.slice(0, 3999) + "…" : s;
}
