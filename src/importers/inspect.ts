/**
 * `import.inspect` (M11): what is this dropped or chosen export? Owner: E4.
 * Opens the zip (random-access ZIP64 reader, no extraction) or folder, recognises the service from its
 * structure (Claude.ai: conversations.json + users.json/projects.json; ChatGPT: conversations.json with
 * `mapping`; Gemini Takeout: My Activity/Gemini Apps/MyActivity.json — HTML instead of JSON is reported), and
 * returns the preview the Add sources dialog shows: conversations, date range, projects, attachments, how many
 * are already here (by stable id), and whether a NEWER export of the same service was imported before.
 * Reads only structure and counts; returns warning codes, never text from the export (SAFE-17).
 *
 * The counts are what an import would write: the kept branch of each conversation, attachments listed on those
 * messages, Gemini exchanges grouped by the current time-gap setting.
 */
import { isCortexError } from "../shared/errors";
import { conversationId } from "../shared/ids";
import type { InspectArgs, InspectResult, WarningCode } from "../shared/protocol/runner";
import type { ConversationId, IsoDate, SourceKind } from "../shared/types";
import { loadSourceManifest } from "../store/manifest";
import { chatgptConversation, type ChatgptConversation } from "./chatgpt";
import { claudeAiConversation, type ClaudeAiConversation } from "./claudeAi";
import type { ImportContext } from "./common";
import { inspectExtra } from "./extra";
import { gapOf, planGemini } from "./gemini";
import {
  checkExportPath,
  identifyExport,
  isRecord,
  loadExportState,
  NEWER_TOLERANCE_MS,
  openExportSource,
  openProblem,
  scanJsonFiles,
  streamFileElements,
  type ExportConversation,
  type ExportSource,
  type ExportSourceKind,
  type LocatedExport,
  type ScannedFile,
} from "./zip";

function empty(kind: InspectResult["kind"], problem?: WarningCode): InspectResult {
  const out: InspectResult = { kind, conversations: 0, projects: 0, attachments: 0, alreadyImported: 0 };
  if (problem !== undefined) out.problem = problem;
  return out;
}

interface Counts {
  conversations: number;
  projects: number;
  attachments: number;
  ids: Set<ConversationId>;
  first?: number;
  last?: number;
  truncated?: boolean;
  skippedActivity?: number;
  exchanges?: number;
}

function widen(c: Counts, iso: IsoDate | undefined): void {
  const t = iso === undefined ? Number.NaN : Date.parse(iso);
  if (!Number.isFinite(t)) return;
  c.first = c.first === undefined ? t : Math.min(c.first, t);
  c.last = c.last === undefined ? t : Math.max(c.last, t);
}

function addConversation(c: Counts, source: ExportSourceKind, conv: ExportConversation): void {
  c.conversations++;
  c.ids.add(conversationId(source, conv.nativeId));
  widen(c, conv.createdAt);
  widen(c, conv.updatedAt);
  for (const t of conv.turns) {
    widen(c, t.at);
    c.attachments += t.attachments?.length ?? 0;
  }
}

async function countJsonConversations(src: ExportSource, loc: LocatedExport, kind: "claude-ai" | "chatgpt", ctx: ImportContext): Promise<Counts> {
  const signal = ctx.token.signal;
  const names = kind === "claude-ai" && loc.projects ? [...loc.conversations, loc.projects] : [...loc.conversations];
  const scan = await scanJsonFiles(src, names, signal);
  const counts: Counts = { conversations: 0, projects: 0, attachments: 0, ids: new Set() };
  if (loc.projects) counts.projects = scan.files.find((f) => f.name === loc.projects)?.count ?? 0;
  const conversationFiles = scan.files.filter((f) => f.name !== loc.projects);
  if (conversationFiles.some((f: ScannedFile) => f.truncated)) counts.truncated = true;
  const names2 = new Map<string, string>();
  try {
    for await (const el of streamFileElements<unknown>(src, conversationFiles, 0, signal)) {
      if (el.error || !isRecord(el.value)) continue;
      const conv =
        kind === "chatgpt"
          ? chatgptConversation(el.value as unknown as ChatgptConversation, { human: "you", includeToolOutput: false, includeThinking: false })
          : claudeAiConversation(el.value as unknown as ClaudeAiConversation, "you", false, names2);
      addConversation(counts, kind, conv);
      if (counts.conversations % 200 === 0) await ctx.yield();
    }
  } catch (e) {
    // A cut-off file: the complete conversations are counted, the import reports the damage.
    if (!(conversationFiles.some((f: ScannedFile) => f.truncated) && isCortexError(e) && e.code === "E_PARSE")) throw e;
  }
  return counts;
}

async function countGemini(src: ExportSource, loc: LocatedExport, ctx: ImportContext): Promise<Counts> {
  const counts: Counts = { conversations: 0, projects: 0, attachments: 0, ids: new Set() };
  if (!loc.geminiJson) return counts;
  const scan = await scanJsonFiles(src, [loc.geminiJson], ctx.token.signal);
  const plan = await planGemini(src, scan.files[0] as ScannedFile, gapOf(ctx.settings), ctx.token.signal);
  counts.conversations = plan.groups.length;
  counts.attachments = plan.attachments;
  if ((scan.files[0] as ScannedFile).truncated) counts.truncated = true;
  let skipped = 0;
  for (const u of plan.unitOf) if (u < 0) skipped++;
  if (skipped > 0) counts.skippedActivity = skipped;
  counts.exchanges = plan.unitOf.length - skipped;
  for (const g of plan.groups) counts.ids.add(conversationId("gemini", `g:${g.firstKey}`));
  if (plan.range) {
    widen(counts, plan.range[0]);
    widen(counts, plan.range[1]);
  }
  return counts;
}

/** Is a newer export of this service already in the record? The date it was imported, if so. */
async function newerImportedAt(ctx: ImportContext, source: SourceKind, exportNewest: number | undefined, records: Iterable<{ endedAt?: IsoDate }>): Promise<IsoDate | undefined> {
  if (exportNewest === undefined) return undefined;
  let recordNewest = Number.NEGATIVE_INFINITY;
  for (const r of records) {
    const t = r.endedAt === undefined ? Number.NaN : Date.parse(r.endedAt);
    if (Number.isFinite(t) && t > recordNewest) recordNewest = t;
  }
  if (recordNewest <= exportNewest + NEWER_TOLERANCE_MS) return undefined;
  let importedAt: string | undefined;
  try {
    for (const row of Object.values((await loadSourceManifest(ctx.store)).sources)) {
      if (row.kind === source && row.status === "imported" && (importedAt === undefined || row.importedAt > importedAt)) importedAt = row.importedAt;
    }
  } catch {
    // the manifest is only for the date shown
  }
  return importedAt ?? new Date(recordNewest).toISOString();
}

export async function inspectExport(args: InspectArgs, ctx: ImportContext): Promise<InspectResult> {
  const blocked = checkExportPath(args.file, ctx.settings);
  if (blocked) return empty("unknown", blocked);
  let src: ExportSource;
  try {
    src = await openExportSource(args.file);
  } catch (e) {
    if (isCortexError(e) && e.code === "E_CANCELLED") throw e;
    return empty("unknown", openProblem(e));
  }
  try {
    const id = await identifyExport(src, ctx.token.signal);
    // Notes and documents exports (importers/extra) are tried after the chat services. A Takeout with no Gemini
    // activity (a Drive-only Takeout) is reported by identifyExport as an empty Gemini export, so it is tried too.
    if (id.kind === "unknown" || (id.kind === "gemini" && id.problem === "export-empty")) {
      const extra = await inspectExtra(args.file, src.members.map((m) => m.name), ctx);
      if (extra) return extra;
    }
    if (id.kind === "unknown") return empty("unknown", id.problem ?? "export-not-recognised");
    if (id.problem) return empty(id.kind, id.problem);
    let counts: Counts;
    try {
      counts = id.kind === "gemini" ? await countGemini(src, id.loc, ctx) : await countJsonConversations(src, id.loc, id.kind, ctx);
    } catch (e) {
      if (isCortexError(e) && e.code === "E_PARSE") return empty(id.kind, "export-not-recognised");
      throw e;
    }
    if (counts.conversations === 0 && counts.projects === 0) return empty(id.kind, "export-empty");
    const out = empty(id.kind);
    out.conversations = counts.conversations;
    out.projects = counts.projects;
    out.attachments = counts.attachments;
    if (counts.truncated) out.truncated = true;
    if (counts.skippedActivity !== undefined) out.skippedActivity = counts.skippedActivity;
    if (counts.exchanges !== undefined) out.exchanges = counts.exchanges;
    if (counts.first !== undefined && counts.last !== undefined) out.range = [new Date(counts.first).toISOString(), new Date(counts.last).toISOString()];
    const state = await loadExportState(ctx, id.kind);
    for (const cid of counts.ids) if (state.records.has(cid)) out.alreadyImported++;
    const older = await newerImportedAt(ctx, id.kind, counts.last, state.records.values());
    if (older !== undefined) out.olderThanImportedAt = older;
    return out;
  } finally {
    await src.close().catch(() => undefined);
  }
}

/** Recognise a service from the member names of a zip or folder (pure, unit-testable). */
export function recogniseExport(members: readonly string[]): InspectResult["kind"] {
  const lower = members.map((m) => m.replace(/\\/g, "/").toLowerCase());
  if (lower.some((m) => m.endsWith("my activity/gemini apps/myactivity.json") || m.endsWith("my activity/gemini apps/myactivity.html"))) return "gemini";
  const hasConversations = lower.some((m) => m === "conversations.json" || m.endsWith("/conversations.json"));
  if (hasConversations && lower.some((m) => m.endsWith("chat.html") || m.endsWith("message_feedback.json") || m.endsWith("shared_conversations.json"))) return "chatgpt";
  if (hasConversations && lower.some((m) => m.endsWith("users.json") || m.endsWith("projects.json"))) return "claude-ai";
  return "unknown";
}
