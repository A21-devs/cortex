/**
 * Claude.ai export importer (P1). Owner: E4.
 * Input: the export zip or folder with conversations.json (+ projects.json, users.json, possibly memories).
 * Conversation: { uuid, name, created_at, updated_at, chat_messages: [ { uuid, sender: "human"|"assistant",
 *   text, content: [{ type, text, … }], created_at, attachments: [{ file_name, file_size, extracted_content }],
 *   files: [{ file_name }], parent_message_uuid? } ] }.
 * Rules: human → you; assistant → assistant (detail "Claude"; the model is unknown). Text = joined
 * content[type=text].text, falling back to `text`. Attachments with extracted_content → "document" entries
 * (speaker you, right after the message they came with) when Settings › Sources › Claude › attachments is on;
 * images and other files are never stored, only listed on the message. projects.json → project dimension
 * (+ project documents as standalone documents). Dedupe key `${conversationUuid}:${messageUuid}`. Branches
 * (parent_message_uuid) are versions of a turn. users.json (names, e-mail) and memories are never read.
 * The shared pipeline (zip.ts: runExportImport, ExportWriter) does the recognising, hashing, resuming, secret
 * holding and writing; this file only turns Claude.ai records into ExportConversations.
 */
import type { SourceImportStats, SourceSelector } from "../shared/protocol/runner";
import type { CortexSettings } from "../shared/settings";
import type { AttachmentRef, Speaker } from "../shared/types";
import type { DiscoveredUnit, ImportContext, Importer } from "./common";
import { streamJsonArray } from "./jsonStream";
import {
  discoverExport,
  isoOrUndefined,
  isRecord,
  MAX_EXPORT_ELEMENT_BYTES,
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
  type ExportUnit,
  type LocatedExport,
  type PreparedExport,
  type ScannedFiles,
} from "./zip";

export type ClaudeAiSelector = Extract<SourceSelector, { kind: "claude-ai" }>;

export interface ClaudeAiMessage {
  uuid: string;
  sender: "human" | "assistant" | string;
  text?: string;
  content?: { type?: string; text?: string }[];
  created_at?: string;
  attachments?: { file_name?: string; file_size?: number; file_type?: string; extracted_content?: string }[];
  files?: { file_name?: string; file_name_original?: string }[];
  parent_message_uuid?: string;
}

export interface ClaudeAiConversation {
  uuid: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ClaudeAiMessage[];
  project_uuid?: string;
}

export interface ClaudeAiProject {
  uuid: string;
  name?: string;
  prompt_template?: string;
  created_at?: string;
  updated_at?: string;
  docs?: { uuid?: string; filename?: string; content?: string; created_at?: string }[];
}

/** Message text: joined text blocks, else the legacy `text` field. */
export function claudeAiText(m: ClaudeAiMessage): string {
  const blocks = (m.content ?? []).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string);
  return blocks.length > 0 ? blocks.join("\n\n") : typeof m.text === "string" ? m.text : "";
}

/** The marker Claude.ai puts in `parent_message_uuid` of a first message. */
const ROOT_PARENT = "00000000-0000-4000-8000-000000000000";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

function attachmentRefs(m: ClaudeAiMessage): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
    const name = str(a?.file_name) ?? "attachment";
    out.push({ name, bytes: typeof a?.file_size === "number" && a.file_size >= 0 ? a.file_size : 0, mime: mimeOf(str(a?.file_type) ?? name) });
  }
  for (const f of Array.isArray(m.files) ? m.files : []) {
    const name = str(f?.file_name) ?? str(f?.file_name_original) ?? "file";
    out.push({ name, bytes: 0, mime: mimeOf(name) });
  }
  return out;
}

function speakerOf(sender: unknown, human: Speaker): { speaker: Speaker; detail?: string } {
  if (sender === "human") return { speaker: human };
  if (sender === "assistant") return { speaker: "assistant", detail: "Claude" };
  return { speaker: "other" };
}

/** A conversation's turns: the kept branch, each message followed by its attachment documents. */
export function claudeAiConversation(
  raw: ClaudeAiConversation,
  human: Speaker,
  includeAttachments: boolean,
  projectNames: ReadonlyMap<string, string>,
  byteOffset?: number,
): ExportConversation {
  const nativeId = str(raw.uuid) ?? `c-${unitSha({ n: raw.name, t: raw.created_at }).slice(0, 16)}`;
  const messages = (Array.isArray(raw.chat_messages) ? raw.chat_messages : []).filter((m): m is ClaudeAiMessage => isRecord(m) && typeof m.uuid === "string");
  const ids = new Set(messages.map((m) => m.uuid));
  const linked = messages.some((m) => typeof m.parent_message_uuid === "string" && ids.has(m.parent_message_uuid));

  const build = (m: ClaudeAiMessage): ExportTurn[] => {
    const text = claudeAiText(m);
    const refs = attachmentRefs(m);
    const who = speakerOf(m.sender, human);
    const at = isoOrUndefined(m.created_at);
    const sha = unitSha(m);
    const key = `${nativeId}:${m.uuid}`;
    const out: ExportTurn[] = [];
    if (text.trim().length > 0 || refs.length > 0) {
      const turn: ExportTurn = { nativeId: m.uuid, key, kind: "message", speaker: who.speaker, text, unitSha256: sha };
      if (who.detail !== undefined) turn.speakerDetail = who.detail;
      if (at !== undefined) turn.at = at;
      if (refs.length > 0) turn.attachments = refs;
      out.push(turn);
    }
    if (includeAttachments) {
      (Array.isArray(m.attachments) ? m.attachments : []).forEach((a, i) => {
        const body = str(a?.extracted_content);
        if (body === undefined || body.trim().length === 0) return;
        const doc: ExportTurn = {
          nativeId: `${m.uuid}:attachment:${i}`,
          key: `${key}:attachment:${i}`,
          kind: "document",
          speaker: human,
          title: str(a?.file_name) ?? "attachment",
          text: body,
          atDetail: "attached to a message",
          unitSha256: unitSha(a),
        };
        if (at !== undefined) doc.at = at;
        out.push(doc);
      });
    }
    return out;
  };

  const turns: ExportTurn[] = [];
  if (!linked) {
    for (const m of messages) turns.push(...build(m));
  } else {
    const nodes: BranchNode<ExportTurn[]>[] = messages.map((m, order) => {
      const built = build(m);
      const node: BranchNode<ExportTurn[]> = { id: m.uuid, order, time: Date.parse(m.created_at ?? "") };
      const parent = m.parent_message_uuid;
      if (typeof parent === "string" && parent !== ROOT_PARENT) node.parent = parent;
      if (built.length > 0) {
        node.value = built;
        node.speaker = speakerOf(m.sender, human).speaker;
      }
      return node;
    });
    const split = splitBranches(nodes);
    for (const node of split.kept) {
      const group = node.value ?? [];
      const main = group[0];
      if (main && main.kind === "message") {
        const versions = (split.versionsOf.get(node.id) ?? [])
          .map((v) => v.value?.[0])
          .filter((v): v is ExportTurn => v !== undefined && v.kind === "message" && v.text.trim().length > 0 && v.text !== main.text)
          .map((v) => ({ nativeId: v.nativeId, key: v.key, text: v.text, ...(v.at !== undefined ? { at: v.at } : {}) }));
        if (versions.length > 0) main.versions = versions;
      }
      turns.push(...group);
    }
  }

  const conv: ExportConversation = { nativeId, title: str(raw.name) ?? "", turns };
  const created = isoOrUndefined(raw.created_at);
  const updated = isoOrUndefined(raw.updated_at);
  if (created !== undefined) conv.createdAt = created;
  if (updated !== undefined) conv.updatedAt = updated;
  const projectId = str(raw.project_uuid);
  const project = projectId !== undefined ? projectNames.get(projectId) : undefined;
  if (project !== undefined) conv.project = project;
  if (byteOffset !== undefined) conv.byteOffset = byteOffset;
  return conv;
}

/** A project's instructions and documents as entries that belong to no conversation. */
export function claudeAiProject(raw: ClaudeAiProject, human: Speaker, includeDocuments: boolean, byteOffset?: number): ExportConversation {
  const nativeId = str(raw.uuid) ?? `p-${unitSha({ n: raw.name }).slice(0, 16)}`;
  const name = str(raw.name) ?? "Untitled project";
  const turns: ExportTurn[] = [];
  const created = isoOrUndefined(raw.created_at);
  const instructions = str(raw.prompt_template);
  if (instructions !== undefined && instructions.trim().length > 0) {
    const t: ExportTurn = {
      nativeId: `${nativeId}:instructions`,
      key: `${nativeId}:instructions`,
      kind: "document",
      speaker: human,
      title: `${name}: instructions`,
      text: instructions,
      atDetail: "project",
      unitSha256: unitSha(instructions),
    };
    const at = isoOrUndefined(raw.updated_at) ?? created;
    if (at !== undefined) t.at = at;
    turns.push(t);
  }
  if (includeDocuments) {
    (Array.isArray(raw.docs) ? raw.docs : []).forEach((d, i) => {
      const body = str(d?.content);
      if (body === undefined || body.trim().length === 0) return;
      const id = str(d?.uuid) ?? `doc${i}`;
      const t: ExportTurn = {
        nativeId: `${nativeId}:${id}`,
        key: `${nativeId}:${id}`,
        kind: "document",
        speaker: human,
        title: str(d?.filename) ?? "document",
        text: body,
        atDetail: "project",
        unitSha256: unitSha(d),
      };
      const at = isoOrUndefined(d?.created_at) ?? created;
      if (at !== undefined) t.at = at;
      turns.push(t);
    });
  }
  const conv: ExportConversation = { nativeId, title: name, project: name, standalone: true, turns };
  if (created !== undefined) conv.createdAt = created;
  if (byteOffset !== undefined) conv.byteOffset = byteOffset;
  return conv;
}

interface ClaudePlan {
  scan: ScannedFiles;
  projectFile?: string;
  /** Project id → name, for conversations that carry a project_uuid. */
  projectNames: Map<string, string>;
}

async function readProjectNames(src: ExportSource, file: string | undefined, signal: AbortSignal): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (!file) return names;
  try {
    for await (const p of streamJsonArray<ClaudeAiProject>(await src.open(file), { signal, maxElementBytes: MAX_EXPORT_ELEMENT_BYTES, onSkip: () => undefined })) {
      if (isRecord(p) && typeof p.uuid === "string" && typeof p.name === "string" && p.name.length > 0) names.set(p.uuid, p.name);
    }
  } catch (e) {
    if (signal.aborted) throw e;
    // A damaged projects.json costs only the project names; the scan reports the damage.
  }
  return names;
}

export const claudeAiFormat: ExportFormat<ClaudePlan> = {
  source: "claude-ai",
  label: "Claude",
  enabled: (s: CortexSettings) => s.sources.claudeAi.enabled,
  keepCopy: (s: CortexSettings) => s.sources.claudeAi.keepExportCopy,
  cursorTag: () => "",
  async prepare(src: ExportSource, loc: LocatedExport, env): Promise<PreparedExport<ClaudePlan>> {
    const names = loc.projects ? [...loc.conversations, loc.projects] : [...loc.conversations];
    const scan = await scanJsonFiles(src, names, env.signal);
    const projectNames = await readProjectNames(src, loc.projects, env.signal);
    const projects = loc.projects ? (scan.files.find((f) => f.name === loc.projects)?.count ?? 0) : 0;
    const plan: ClaudePlan = { scan, projectNames };
    if (loc.projects) plan.projectFile = loc.projects;
    return { units: scan.units, sha256: scan.sha256, bytes: scan.bytes, projects, plan };
  },
  async *units(src, _loc, prep, env, from): AsyncGenerator<ExportUnit> {
    const { scan, projectFile, projectNames } = prep.plan;
    const includeAttachments = env.settings.sources.claudeAi.includeAttachments;
    for await (const el of streamFileElements<unknown>(src, scan.files, from, env.signal)) {
      if (el.error || !isRecord(el.value)) {
        yield { index: el.unit, error: el.error ?? "E_PARSE" };
        continue;
      }
      const conversation =
        el.file.name === projectFile
          ? claudeAiProject(el.value as unknown as ClaudeAiProject, env.human, includeAttachments, el.offset)
          : claudeAiConversation(el.value as unknown as ClaudeAiConversation, env.human, includeAttachments, projectNames, el.offset);
      yield { index: el.unit, conversation };
    }
  },
};

export class ClaudeAiImporter implements Importer<ClaudeAiSelector> {
  readonly kind = "claude-ai" as const;
  readonly source = "claude-ai" as const;
  readonly label = "Claude";

  async discover(sel: ClaudeAiSelector, _ctx: ImportContext): Promise<DiscoveredUnit[]> {
    return discoverExport(sel.file, this.label);
  }

  async run(sel: ClaudeAiSelector, ctx: ImportContext): Promise<SourceImportStats> {
    return runExportImport(ctx, sel.file, claudeAiFormat);
  }
}
