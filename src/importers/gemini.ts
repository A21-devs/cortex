/**
 * Gemini (Google Takeout "My Activity") importer (P2). Owner: E4.
 * Input: Takeout zip or folder; file "My Activity/Gemini Apps/MyActivity.json" (JSON chosen at export). A Takeout
 * made with the HTML format is recognised and reported (`takeout-html`), not imported: its dates are written in
 * the viewer's language and time zone, so they cannot be read back reliably.
 * Record: { title: "Prompted <prompt>", time, safeHtmlItem?: [{ html }], products?, … }.
 * Rules: prompt = title minus the leading verb ("Prompted "); reply = HTML stripped to text. No conversation
 * ids exist: group records into conversations when consecutive records are < gapMinutes apart (lower
 * fidelity; flagged in the source row). Dedupe key `${time}:${sha256(prompt)}`. Records that are not an exchange
 * (no prompt verb, no reply: "Used Gemini Apps", feedback lines) are left out. Files and images named on a
 * record are listed on the prompt and never stored.
 *
 * Streaming: takeout lists newest first and a group's records are usually next to each other, so units are
 * numbered in the order their last record appears in the file and a group is built as soon as it is complete.
 * `prepare` keeps only an index, a time and a key per exchange; text is held only for groups still being read.
 */
import { sha256Text } from "../node/hash";
import { CortexError, isCortexError } from "../shared/errors";
import type { SourceImportStats, SourceSelector } from "../shared/protocol/runner";
import type { CortexSettings } from "../shared/settings";
import type { AttachmentRef, IsoDate, Speaker } from "../shared/types";
import type { DiscoveredUnit, ImportContext, Importer } from "./common";
import { htmlToText } from "./html";
import {
  discoverExport,
  isoOrUndefined,
  isRecord,
  mimeOf,
  runExportImport,
  scanJsonFiles,
  streamFileElements,
  unitSha,
  type ExportConversation,
  type ExportFormat,
  type ExportSource,
  type ExportTurn,
  type ExportUnit,
  type LocatedExport,
  type PreparedExport,
  type ScannedFile,
} from "./zip";

export type GeminiSelector = Extract<SourceSelector, { kind: "gemini" }>;

export interface GeminiActivity {
  title?: string;
  time?: string;
  safeHtmlItem?: { html?: string }[];
  header?: string;
  description?: string;
  attachedFiles?: unknown[];
  imageFile?: unknown;
}

const PROMPT_PREFIX = /^(Prompted|Asked|Said)\s+/i;

export function geminiPrompt(a: GeminiActivity): string {
  return (a.title ?? "").replace(PROMPT_PREFIX, "").trim();
}

/** The reply as text: the HTML items stripped, else the description field. */
export function geminiReply(a: GeminiActivity): string {
  const html = (Array.isArray(a.safeHtmlItem) ? a.safeHtmlItem : []).map((i) => (typeof i?.html === "string" ? i.html : "")).filter((h) => h.length > 0);
  if (html.length > 0) return htmlToText(html.join("\n\n"));
  return typeof a.description === "string" ? htmlToText(a.description) : "";
}

/** Is this record a prompt (and reply), rather than a line of other activity? */
export function isGeminiExchange(a: unknown): a is GeminiActivity {
  if (!isRecord(a)) return false;
  const rec = a as GeminiActivity;
  if (typeof rec.title === "string" && PROMPT_PREFIX.test(rec.title)) return true;
  return geminiReply(rec).length > 0 && geminiPrompt(rec).length > 0;
}

/** Group activities (any order) into conversations by time gaps; each group sorted oldest first. */
export function groupGeminiActivities(items: readonly GeminiActivity[], gapMinutes: number): GeminiActivity[][] {
  const dated = items
    .map((a) => ({ a, t: Date.parse(a.time ?? "") }))
    .filter((x) => Number.isFinite(x.t))
    .sort((x, y) => x.t - y.t);
  const groups: GeminiActivity[][] = [];
  let lastT = Number.NEGATIVE_INFINITY;
  for (const { a, t } of dated) {
    if (groups.length === 0 || t - lastT > gapMinutes * 60_000) groups.push([]);
    (groups[groups.length - 1] as GeminiActivity[]).push(a);
    lastT = t;
  }
  return groups;
}

/** Dedupe key of an exchange: its time and the hash of its prompt. */
export function geminiKey(a: GeminiActivity): string {
  return `${typeof a.time === "string" ? a.time : ""}:${sha256Text(geminiPrompt(a))}`;
}

function attachmentNames(a: GeminiActivity): AttachmentRef[] {
  const names: string[] = [];
  for (const f of Array.isArray(a.attachedFiles) ? a.attachedFiles : []) {
    if (typeof f === "string" && f.length > 0) names.push(f);
    else if (isRecord(f) && typeof f.name === "string" && f.name.length > 0) names.push(f.name);
  }
  if (typeof a.imageFile === "string" && a.imageFile.length > 0) names.push(a.imageFile);
  return names.map((name) => ({ name, bytes: 0, mime: mimeOf(name) }));
}

export interface GeminiRecord {
  a: GeminiActivity;
  /** Position in the file. */
  idx: number;
  offset: number;
}

const timeOf = (r: GeminiRecord): number => {
  const t = Date.parse(r.a.time ?? "");
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};

/** One group of exchanges as a conversation: prompt and reply turns, oldest first. */
export function geminiConversation(records: readonly GeminiRecord[], gapMinutes: number, human: Speaker = "you"): ExportConversation {
  const sorted = [...records].sort((x, y) => timeOf(x) - timeOf(y) || x.idx - y.idx);
  const first = sorted[0] as GeminiRecord;
  const turns: ExportTurn[] = [];
  for (const r of sorted) {
    const key = geminiKey(r.a);
    const at = isoOrUndefined(r.a.time);
    const sha = unitSha(r.a);
    const prompt: ExportTurn = { nativeId: key, key, kind: "message", speaker: human, text: geminiPrompt(r.a), unitSha256: sha };
    if (at !== undefined) prompt.at = at;
    const refs = attachmentNames(r.a);
    if (refs.length > 0) prompt.attachments = refs;
    turns.push(prompt);
    const reply = geminiReply(r.a);
    if (reply.length > 0) {
      const t: ExportTurn = { nativeId: `${key}:reply`, key: `${key}:reply`, kind: "message", speaker: "assistant", speakerDetail: "Gemini", text: reply, unitSha256: sha };
      if (at !== undefined) t.at = at;
      turns.push(t);
    }
  }
  const conv: ExportConversation = { nativeId: `g:${geminiKey(first.a)}`, title: "", turns, meta: { grouping: `time gap of ${gapMinutes} minutes` }, byteOffset: first.offset };
  const created = isoOrUndefined(first.a.time);
  const last = sorted[sorted.length - 1];
  const updated = last ? isoOrUndefined(last.a.time) : undefined;
  if (created !== undefined) conv.createdAt = created;
  if (updated !== undefined) conv.updatedAt = updated;
  return conv;
}

interface GeminiGroup {
  /** First and last position in the file (units are numbered by `last`). */
  first: number;
  last: number;
  firstKey: string;
}

export interface GeminiPlan {
  file: ScannedFile;
  /** Element position → unit number, -1 for records that belong to no conversation. */
  unitOf: Int32Array;
  /** In unit order. */
  groups: GeminiGroup[];
  /** Files and images named on the exchanges. */
  attachments: number;
  /** Oldest and newest dated exchange. */
  range?: [IsoDate, IsoDate];
}

export function gapOf(s: CortexSettings): number {
  const g = s.sources.gemini.gapMinutes;
  return Number.isFinite(g) && g > 0 ? g : 30;
}

/**
 * One parsing pass over the file keeping only a position, a time and a key per exchange, then the grouping.
 * Undated exchanges form one group of their own at the end of the numbering.
 */
export async function planGemini(src: ExportSource, file: ScannedFile, gapMinutes: number, signal: AbortSignal): Promise<GeminiPlan> {
  const unitOf = new Int32Array(file.count).fill(-1);
  const exchanges: { idx: number; t: number; key: string }[] = [];
  let attachments = 0;
  try {
    for await (const el of streamFileElements<unknown>(src, [file], 0, signal)) {
      if (el.error || !isGeminiExchange(el.value)) continue;
      const a = el.value;
      attachments += attachmentNames(a).length;
      exchanges.push({ idx: el.index, t: Date.parse(a.time ?? ""), key: geminiKey(a) });
    }
  } catch (e) {
    // A cut-off file: every complete record was read; the import reports the damage after saving them.
    if (!(file.truncated && isCortexError(e) && e.code === "E_PARSE")) throw e;
  }
  const dated = exchanges.filter((e) => Number.isFinite(e.t)).sort((x, y) => x.t - y.t || x.idx - y.idx);
  const undated = exchanges.filter((e) => !Number.isFinite(e.t));
  const buckets: { idx: number; key: string }[][] = [];
  let lastT = Number.NEGATIVE_INFINITY;
  for (const e of dated) {
    if (buckets.length === 0 || e.t - lastT > gapMinutes * 60_000) buckets.push([]);
    (buckets[buckets.length - 1] as { idx: number; key: string }[]).push(e);
    lastT = e.t;
  }
  if (undated.length > 0) buckets.push(undated.sort((x, y) => x.idx - y.idx));
  const raw = buckets.map((b) => ({
    members: b,
    first: b.reduce((m, e) => Math.min(m, e.idx), Number.POSITIVE_INFINITY),
    last: b.reduce((m, e) => Math.max(m, e.idx), -1),
    firstKey: (b[0] as { key: string }).key,
  }));
  raw.sort((x, y) => x.last - y.last);
  const groups: GeminiGroup[] = [];
  raw.forEach((g, unit) => {
    for (const m of g.members) unitOf[m.idx] = unit;
    groups.push({ first: g.first, last: g.last, firstKey: g.firstKey });
  });
  const plan: GeminiPlan = { file, unitOf, groups, attachments };
  if (dated.length > 0) plan.range = [new Date((dated[0] as { t: number }).t).toISOString(), new Date((dated[dated.length - 1] as { t: number }).t).toISOString()];
  return plan;
}

export const geminiFormat: ExportFormat<GeminiPlan> = {
  source: "gemini",
  label: "Gemini",
  enabled: (s: CortexSettings) => s.sources.gemini.enabled,
  keepCopy: (s: CortexSettings) => s.sources.gemini.keepExportCopy,
  cursorTag: (s: CortexSettings) => `gap${gapOf(s)}`,
  async prepare(src: ExportSource, loc: LocatedExport, env): Promise<PreparedExport<GeminiPlan>> {
    if (!loc.geminiJson) throw new CortexError("E_PARSE", "the export has no Gemini activity file");
    const scan = await scanJsonFiles(src, [loc.geminiJson], env.signal);
    const plan = await planGemini(src, scan.files[0] as ScannedFile, gapOf(env.settings), env.signal);
    return { units: plan.groups.length, sha256: scan.sha256, bytes: scan.bytes, plan };
  },
  async *units(src, _loc, prep, env, from): AsyncGenerator<ExportUnit> {
    const { file, unitOf, groups } = prep.plan;
    if (from >= groups.length) return;
    const gap = gapOf(env.settings);
    let startAt = Number.POSITIVE_INFINITY;
    for (let u = from; u < groups.length; u++) startAt = Math.min(startAt, (groups[u] as GeminiGroup).first);
    const open = new Map<number, GeminiRecord[]>();
    for await (const el of streamFileElements<unknown>(src, [file], startAt, env.signal)) {
      const unit = unitOf[el.index] ?? -1;
      if (el.error || unit < from || !isGeminiExchange(el.value)) continue;
      const list = open.get(unit) ?? [];
      list.push({ a: el.value, idx: el.index, offset: el.offset });
      open.set(unit, list);
      if (el.index === (groups[unit] as GeminiGroup).last) {
        open.delete(unit);
        yield { index: unit, conversation: geminiConversation(list, gap, env.human) };
      }
    }
  },
};

export class GeminiImporter implements Importer<GeminiSelector> {
  readonly kind = "gemini" as const;
  readonly source = "gemini" as const;
  readonly label = "Gemini";

  async discover(sel: GeminiSelector, _ctx: ImportContext): Promise<DiscoveredUnit[]> {
    return discoverExport(sel.file, this.label);
  }

  async run(sel: GeminiSelector, ctx: ImportContext): Promise<SourceImportStats> {
    return runExportImport(ctx, sel.file, geminiFormat);
  }
}
