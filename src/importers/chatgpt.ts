/**
 * ChatGPT export importer (P1). Owner: E4.
 * Input: the export zip (or folder, or an extracted conversations.json). conversations.json (or the numbered
 * conversations-NNN.json files of newer exports) is a top-level JSON array that can be hundreds of MB, so it is
 * read with jsonStream (one conversation object at a time).
 *
 * Conversation: { title, create_time, update_time, conversation_id|id, current_node, mapping{ id → node } }.
 * Node: { id, parent, children[], message{ id, author{role}, create_time, content{content_type, parts[]},
 *         metadata{ model_slug, is_visually_hidden_from_conversation, … }, recipient } }.
 * Rules: active branch = walk current_node → root via parent, reversed. Sibling branches of the same turn are
 * stored as BranchVersions of that turn's entry. Roles: user → you; assistant → assistant (detail
 * model_slug); tool → tool (off by default); system → skipped; hidden/custom-instruction context → skipped.
 * Content: string parts joined by a blank line; code → fenced block; image and file attachments are listed
 * on the message and never stored (text only); reasoning content types skipped by default. Dates:
 * message.create_time (strong); null → conversation create_time ("conversation start", medium).
 * Privacy default: only "you" lines go to cloud models (settings privacy.withholdAssistantFrom).
 * Dedupe key: `${conversationId}:${messageId}`. Export files are keyed by sha256 in the sources manifest.
 */
import type { SourceImportStats, SourceSelector } from "../shared/protocol/runner";
import type { CortexSettings } from "../shared/settings";
import type { AttachmentRef, EntryRecord, Speaker } from "../shared/types";
import type { DiscoveredUnit, ImportContext, Importer } from "./common";
import {
  discoverExport,
  isoFromEpochSeconds,
  isRecord,
  mimeOf,
  runExportImport,
  scanJsonFiles,
  splitBranches,
  streamFileElements,
  unitSha,
  type BranchNode,
  type ExportConversation,
  type ExportFormat,
  type ExportSource,
  type ExportTurn,
  type ExportTurnVersion,
  type ExportUnit,
  type LocatedExport,
  type PreparedExport,
  type ScannedFiles,
} from "./zip";

export type ChatgptSelector = Extract<SourceSelector, { kind: "chatgpt" }>;

export interface ChatgptNode {
  id: string;
  parent?: string | null;
  children?: string[];
  message?: ChatgptMessage | null;
}

export interface ChatgptMessage {
  id: string;
  author?: { role?: string; name?: string | null };
  create_time?: number | null;
  content?: { content_type?: string; parts?: unknown[]; text?: string; language?: string; thoughts?: unknown[]; content?: unknown };
  metadata?: Record<string, unknown>;
  recipient?: string;
}

export interface ChatgptConversation {
  title?: string;
  create_time?: number;
  update_time?: number;
  conversation_id?: string;
  id?: string;
  current_node?: string;
  default_model_slug?: string;
  mapping?: Record<string, ChatgptNode>;
}

/** Node ids of the active branch, root first. Cycles and missing parents end the walk safely. */
export function activeBranch(conv: ChatgptConversation): string[] {
  const mapping = conv.mapping ?? {};
  let cur = conv.current_node;
  if (!cur || !mapping[cur]) {
    // Fallback: the most recently created leaf.
    let best: { id: string; t: number } | undefined;
    for (const n of Object.values(mapping)) {
      if ((n.children?.length ?? 0) === 0) {
        const t = n.message?.create_time ?? 0;
        if (!best || t >= best.t) best = { id: n.id, t };
      }
    }
    cur = best?.id;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  while (cur && mapping[cur] && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = mapping[cur]?.parent ?? undefined;
  }
  return out.reverse();
}

/** Visible text of a ChatGPT message ("" when it carries no text). */
export function chatgptText(msg: ChatgptMessage): string {
  const c = msg.content;
  if (!c) return "";
  if (c.content_type === "code" && typeof c.text === "string") return "```" + (c.language ?? "") + "\n" + c.text + "\n```";
  const parts: string[] = [];
  for (const p of c.parts ?? []) {
    if (typeof p === "string") parts.push(p);
    else if (isRecord(p) && p.content_type === "audio_transcription" && typeof p.text === "string") parts.push(p.text);
  }
  for (const t of Array.isArray(c.thoughts) ? c.thoughts : []) {
    if (isRecord(t) && typeof t.content === "string") parts.push(t.content);
  }
  if (parts.length === 0 && typeof c.content === "string") parts.push(c.content);
  const joined = parts.filter((p) => p.length > 0);
  if (joined.length > 0) return joined.join("\n\n");
  return typeof c.text === "string" ? c.text : "";
}

/** ChatGPT marks web citations in assistant text with private-use brackets (U+E200 … U+E201): not the model's words. */
const CITATION_MARKS = /[^]*|[-]/g;

const REASONING_TYPES = new Set(["thoughts", "reasoning_recap", "reasoning", "reasoning_trace"]);
const CONTEXT_TYPES = new Set(["user_editable_context", "model_editable_context", "system_error"]);
const TOOL_OUTPUT_TYPES = new Set(["execution_output", "tether_browsing_display", "tether_quote", "computer_output"]);

export interface ChatgptTurnOptions {
  human: Speaker;
  includeToolOutput: boolean;
  includeThinking: boolean;
}

interface Role {
  speaker: Speaker;
  detail?: string;
  hidden?: EntryRecord["hiddenByDefault"];
}

/** Who a message is, or undefined when it is not part of the conversation as the person saw it. */
function roleOf(msg: ChatgptMessage, opts: ChatgptTurnOptions): Role | undefined {
  const meta = isRecord(msg.metadata) ? msg.metadata : {};
  if (meta.is_visually_hidden_from_conversation === true) return undefined;
  const role = msg.author?.role;
  if (role === "system") return undefined;
  const type = msg.content?.content_type ?? "text";
  if (CONTEXT_TYPES.has(type)) return undefined;
  if (REASONING_TYPES.has(type)) return opts.includeThinking ? { speaker: "assistant", detail: "thinking", hidden: "tool" } : undefined;
  const toolish = role === "tool" || TOOL_OUTPUT_TYPES.has(type) || (role === "assistant" && typeof msg.recipient === "string" && msg.recipient !== "all");
  if (toolish) {
    if (!opts.includeToolOutput) return undefined;
    const name = typeof msg.author?.name === "string" && msg.author.name.length > 0 ? msg.author.name : typeof msg.recipient === "string" && msg.recipient !== "all" ? msg.recipient : "tool";
    return { speaker: "tool", detail: name, hidden: "tool" };
  }
  if (role === "user") return { speaker: opts.human };
  if (role === "assistant") {
    const model = meta.model_slug;
    return { speaker: "assistant", detail: typeof model === "string" && model.length > 0 ? model : "ChatGPT" };
  }
  return undefined;
}

/** Files named on a message: uploads (metadata.attachments) and image parts. Listed, never stored. */
function attachmentsOf(msg: ChatgptMessage): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  const meta = isRecord(msg.metadata) ? msg.metadata : {};
  for (const a of Array.isArray(meta.attachments) ? meta.attachments : []) {
    if (!isRecord(a)) continue;
    const name = typeof a.name === "string" && a.name.length > 0 ? a.name : "attachment";
    out.push({ name, bytes: typeof a.size === "number" && a.size >= 0 ? a.size : 0, mime: typeof a.mime_type === "string" && a.mime_type.length > 0 ? a.mime_type : mimeOf(name) });
  }
  for (const p of msg.content?.parts ?? []) {
    if (!isRecord(p) || p.content_type !== "image_asset_pointer") continue;
    const pointer = typeof p.asset_pointer === "string" ? p.asset_pointer : "";
    const name = pointer.split(/[/:]/).filter((x) => x.length > 0).pop() ?? "image";
    out.push({ name, bytes: typeof p.size_bytes === "number" && p.size_bytes >= 0 ? p.size_bytes : 0, mime: "image/*" });
  }
  return out;
}

/** One message as a turn of the conversation, or undefined when it is not one. */
export function chatgptTurn(convId: string, msg: ChatgptMessage, opts: ChatgptTurnOptions): ExportTurn | undefined {
  if (!isRecord(msg) || !isRecord(msg.content)) return undefined;
  const role = roleOf(msg, opts);
  if (!role) return undefined;
  let text = chatgptText(msg);
  if (role.speaker === "assistant") text = text.replace(CITATION_MARKS, "");
  const refs = attachmentsOf(msg);
  if (text.trim().length === 0 && refs.length === 0) return undefined;
  const id = typeof msg.id === "string" && msg.id.length > 0 ? msg.id : unitSha(msg).slice(0, 16);
  const turn: ExportTurn = { nativeId: id, key: `${convId}:${id}`, kind: "message", speaker: role.speaker, text, unitSha256: unitSha(msg) };
  if (role.detail !== undefined) turn.speakerDetail = role.detail;
  if (role.hidden !== undefined) turn.hidden = role.hidden;
  const at = isoFromEpochSeconds(msg.create_time);
  if (at !== undefined) turn.at = at;
  if (refs.length > 0) turn.attachments = refs;
  return turn;
}

/** A conversation's kept branch with the other branches of each turn as versions. */
export function chatgptConversation(raw: ChatgptConversation, opts: ChatgptTurnOptions, byteOffset?: number): ExportConversation {
  const nativeId =
    (typeof raw.conversation_id === "string" && raw.conversation_id.length > 0 ? raw.conversation_id : undefined) ??
    (typeof raw.id === "string" && raw.id.length > 0 ? raw.id : undefined) ??
    `c-${unitSha({ t: raw.title, c: raw.create_time }).slice(0, 16)}`;
  const mapping = isRecord(raw.mapping) ? (raw.mapping as Record<string, ChatgptNode>) : {};
  const nodes: BranchNode<ExportTurn>[] = [];
  let order = 0;
  for (const [key, node] of Object.entries(mapping)) {
    if (!isRecord(node)) continue;
    const id = typeof node.id === "string" && node.id.length > 0 ? node.id : key;
    const bn: BranchNode<ExportTurn> = { id, order: order++, time: Number.NaN };
    if (typeof node.parent === "string") bn.parent = node.parent;
    const msg = node.message;
    if (isRecord(msg)) {
      if (typeof msg.create_time === "number" && Number.isFinite(msg.create_time)) bn.time = msg.create_time * 1000;
      const turn = chatgptTurn(nativeId, msg as unknown as ChatgptMessage, opts);
      if (turn) {
        bn.value = turn;
        bn.speaker = turn.speaker;
      }
    }
    nodes.push(bn);
  }
  const leaf = typeof raw.current_node === "string" ? raw.current_node : undefined;
  const split = splitBranches(nodes, leaf);
  const turns: ExportTurn[] = [];
  for (const node of split.kept) {
    const turn = node.value as ExportTurn;
    const seen = new Set<string>([turn.text]);
    const versions: ExportTurnVersion[] = [];
    for (const v of split.versionsOf.get(node.id) ?? []) {
      const t = v.value;
      if (!t || t.text.trim().length === 0 || seen.has(t.text)) continue;
      seen.add(t.text);
      versions.push({ nativeId: t.nativeId, key: t.key, text: t.text, ...(t.at !== undefined ? { at: t.at } : {}) });
    }
    if (versions.length > 0) turn.versions = versions;
    turns.push(turn);
  }
  const conv: ExportConversation = { nativeId, title: typeof raw.title === "string" ? raw.title : "", turns };
  const created = isoFromEpochSeconds(raw.create_time);
  const updated = isoFromEpochSeconds(raw.update_time);
  if (created !== undefined) conv.createdAt = created;
  if (updated !== undefined) conv.updatedAt = updated;
  if (typeof raw.default_model_slug === "string" && raw.default_model_slug.length > 0) conv.meta = { model: raw.default_model_slug };
  if (byteOffset !== undefined) conv.byteOffset = byteOffset;
  return conv;
}

interface ChatgptPlan {
  scan: ScannedFiles;
}

export const chatgptFormat: ExportFormat<ChatgptPlan> = {
  source: "chatgpt",
  label: "ChatGPT",
  enabled: (s: CortexSettings) => s.sources.chatgpt.enabled,
  keepCopy: (s: CortexSettings) => s.sources.chatgpt.keepExportCopy,
  cursorTag: () => "",
  async prepare(src: ExportSource, loc: LocatedExport, env): Promise<PreparedExport<ChatgptPlan>> {
    const scan = await scanJsonFiles(src, loc.conversations, env.signal);
    return { units: scan.units, sha256: scan.sha256, bytes: scan.bytes, plan: { scan } };
  },
  async *units(src, _loc, prep, env, from): AsyncGenerator<ExportUnit> {
    const opts: ChatgptTurnOptions = {
      human: env.human,
      includeToolOutput: env.settings.sources.chatgpt.includeToolOutput,
      includeThinking: env.settings.sources.chatgpt.includeThinking,
    };
    for await (const el of streamFileElements<unknown>(src, prep.plan.scan.files, from, env.signal)) {
      if (el.error || !isRecord(el.value)) {
        yield { index: el.unit, error: el.error ?? "E_PARSE" };
        continue;
      }
      yield { index: el.unit, conversation: chatgptConversation(el.value as unknown as ChatgptConversation, opts, el.offset) };
    }
  },
};

export class ChatgptImporter implements Importer<ChatgptSelector> {
  readonly kind = "chatgpt" as const;
  readonly source = "chatgpt" as const;
  readonly label = "ChatGPT";

  async discover(sel: ChatgptSelector, _ctx: ImportContext): Promise<DiscoveredUnit[]> {
    return discoverExport(sel.file, this.label);
  }

  async run(sel: ChatgptSelector, ctx: ImportContext): Promise<SourceImportStats> {
    return runExportImport(ctx, sel.file, chatgptFormat);
  }
}
