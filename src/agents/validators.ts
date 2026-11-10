/**
 * Output validation: schema check, id allow-list, exact-quote check, pack enum check, injection signals,
 * speaker attribution. Owner: E6.
 *  - The user outranks models: labels on fields that carry an active user correction are dropped here, before
 *    anything is written (never-overwrite-corrections rule).
 *  - A quote counts only when it is an exact substring (re-flowed whitespace tolerated) of at least 12 characters
 *    or 3 words that are not all stopwords (SAFE-15). The stored quote is the exact span of the stored text.
 *  - Speaker and "assistant only" are COMPUTED from the cited entries' speakers; a statement attributed to "you"
 *    must cite at least one entry whose speaker is "you" (SAFE-09).
 *  - Any field with an injection signal ($=, dataviewjs, ```, <script, <iframe, javascript:, obsidian://, ](,
 *    ![, [[ or ::) is dropped and reported (SAFE-01): the job turns the rejection into a Checks card plus a warning
 *    event. Quotes are exempt: they are verified substrings of the record, never written into a markdown file.
 * Validators never throw for bad model output: they return what survived plus the rejections, and `valid: false`
 * when nothing usable is left (the job then makes one repair call, then fails with E_VALIDATION).
 */
import { ACTION_CALL_SCHEMA, ACTION_SPECS, MAX_ACTIONS_PER_REPLY, MAX_ITEMS_PER_ACTION, verbAllowed, type ActionCall, type OnlyVerb } from "../shared/actions";
import { machineNoteId } from "../shared/ids";
import { injectionSignals } from "../shared/mdSafe";
import type { AtomicKind, AtomicNoteDoc, GistDoc, GistFacets, GistPartDoc, HubDoc, HubStatementDoc } from "../shared/notesDoc";
import { fieldKey, labelValueFits, normaliseLabelValue } from "../shared/packs";
import { HUB_SECTION_KEYS, type Citation, type ConversationId, type CorrectionId, type EntryId, type HubSectionKey, type HubType, type IsoDate, type LabelRecord, type LabelValue, type PackDef, type Speaker } from "../shared/types";
import { formatIssues, validate, type JsonSchema, type ValidationIssue } from "../shared/validate";
import { ANSWER_SHAPE_SCHEMA, FILING_AREAS, FILING_OUTPUT_SCHEMA, GIST_OUTPUT_SCHEMA, HUB_OUTPUT_SCHEMA, HUB_SECTION_ALL, labelOutputSchema, LABEL_TARGET_PATTERN, NAME_CHECK_OUTPUT_SCHEMA, REASON_MAX } from "./schemas";

export interface QuoteMatch {
  start: number;
  end: number;
  /** The exact original span (may differ from the model's quote in whitespace only). */
  exact: string;
}

const STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "it", "this", "that", "with", "as", "at", "by", "be", "we", "i", "you"]);

/** A quote long enough to be evidence: ≥ 12 characters, or ≥ 3 words that are not all stopwords. */
export function isSubstantialQuote(q: string): boolean {
  const t = q.trim();
  if (t.length >= 12) return true;
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length >= 3 && words.some((w) => !STOPWORDS.has(w));
}

/**
 * Locate `quote` in `text`: exact substring first; otherwise a match where runs of whitespace are treated
 * as equal (models often re-flow line breaks). Returns null when the quote is not in the text or too short.
 */
export function findQuote(text: string, quote: string): QuoteMatch | null {
  const q = quote.trim();
  if (!isSubstantialQuote(q)) return null;
  const i = text.indexOf(q);
  if (i >= 0) return { start: i, end: i + q.length, exact: q };
  const parts = q.split(/\s+/).filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (parts.length === 0) return null;
  const re = new RegExp(parts.join("\\s+"), "u");
  const m = re.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length, exact: m[0] } : null;
}

/** Who a statement rests on, from its cited entries (never from the model). */
export function evidenceOf(speakers: readonly Speaker[]): { you: number; assistant: number; assistantOnly: boolean } {
  const you = speakers.filter((s) => s === "you").length;
  const assistant = speakers.filter((s) => s === "assistant").length;
  return { you, assistant, assistantOnly: speakers.length > 0 && you === 0 };
}

const YOU_START = /^\s*(?:you|your|you've|you'd|you'll)\b/i;
const YOU_VERB =
  /\byou(?:'ve|'d|'ll)?\s+(?:(?:also|then|finally|later|first|eventually|had|have|did|didn't|never|still)\s+){0,2}(?:decided|decide|chose|chosen|choose|said|say|wrote|asked|ask|wanted|want|agreed|planned|plan|picked|rejected|dropped|abandoned|confirmed|preferred|prefer|noted|concluded|realised|realized|insisted|proposed|suggested|requested|accepted|approved|settled|committed|refused|declined|believe|believed|think|thought)\b/i;

/** A statement that says the person decided, chose, asked, said … (it must cite one of their own lines). */
export function attributesToYou(text: string): boolean {
  return YOU_START.test(text) || YOU_VERB.test(text);
}

/** What validators need to know about a cited entry or note (its CURRENT version). */
export interface CitedEntry {
  text: string;
  speaker: Speaker;
  /** Version the text is (1 = the imported wording). */
  version?: number;
  /** Written date, shown with the quote. */
  date?: IsoDate;
}

export interface ValidationContext {
  allowedIds: ReadonlySet<string>;
  /** Current text and speaker of a cited entry/note version (for quote and attribution checks). */
  entryOf(id: string): Promise<CitedEntry | undefined>;
  /** Fields with an active user correction, as `${target}|${pack}|${field}`. */
  userOwned: ReadonlySet<string>;
  /** Comment corrections shown to the model; `addressedComments` may only name these. */
  openComments?: ReadonlySet<string>;
}

export type RejectionReason =
  | "schema"
  | "unknown-id"
  | "quote-not-found"
  | "quote-too-short"
  | "enum"
  | "user-owned"
  | "injection-signal"
  | "attribution"
  | "duplicate"
  | "order"
  | "no-name"
  | "not-allowed"
  | "too-broad"
  | "too-many-actions";

export interface Rejection {
  path: string;
  reason: RejectionReason;
  /** Cortex's own words (schema paths, signal patterns); never model text. */
  detail?: string;
  /** The label target the rejected field belonged to (label output only). */
  target?: string;
}

/** Rejections Cortex turns into a Checks card and a warning (SAFE-01). */
export function injectionRejections(rejected: readonly Rejection[]): Rejection[] {
  return rejected.filter((r) => r.reason === "injection-signal");
}

function schemaRejections(issues: readonly ValidationIssue[]): Rejection[] {
  return issues.map((i) => ({ path: i.path, reason: "schema" as const, detail: i.message }));
}

/** Collapse whitespace and control characters (model strings are single lines everywhere Cortex shows them). */
function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A model string, or null (recorded) when it carries an injection signal or is empty. */
function cleanString(path: string, s: string | null | undefined, rejected: Rejection[]): string | null {
  if (s === null || s === undefined) return null;
  const signals = injectionSignals(s);
  if (signals.length > 0) {
    rejected.push({ path, reason: "injection-signal", detail: signals.join(" ") });
    return null;
  }
  const t = oneLine(s);
  return t.length > 0 ? t : null;
}

function clamp01(n: number | undefined): number | undefined {
  return n === undefined || !Number.isFinite(n) ? undefined : Math.max(0, Math.min(1, n));
}

/** Validate one model citation against the shown set and the entry's current text. */
async function checkCitation(path: string, c: { id: string; quote: string }, vctx: ValidationContext, rejected: Rejection[]): Promise<Citation | null> {
  if (!vctx.allowedIds.has(c.id)) {
    rejected.push({ path: `${path}.id`, reason: "unknown-id" });
    return null;
  }
  const e = await vctx.entryOf(c.id);
  if (!e) {
    rejected.push({ path: `${path}.id`, reason: "unknown-id" });
    return null;
  }
  if (!isSubstantialQuote(c.quote)) {
    rejected.push({ path: `${path}.quote`, reason: "quote-too-short" });
    return null;
  }
  const m = findQuote(e.text, c.quote);
  if (!m) {
    rejected.push({ path: `${path}.quote`, reason: "quote-not-found" });
    return null;
  }
  const out: Citation = { entryId: c.id as EntryId, version: e.version ?? 1, quote: m.exact, speaker: e.speaker };
  if (e.date !== undefined) out.date = e.date;
  return out;
}

/** Validate a cited statement: its text, at least one valid citation, and attribution to you. */
async function checkStatement(path: string, text: string, cites: readonly { id: string; quote: string }[], vctx: ValidationContext, rejected: Rejection[]): Promise<{ text: string; cites: Citation[] } | null> {
  const t = cleanString(`${path}.text`, text, rejected);
  if (t === null) return null;
  const valid: Citation[] = [];
  const seen = new Set<string>();
  for (const [j, c] of cites.entries()) {
    const v = await checkCitation(`${path}.cites[${j}]`, c, vctx, rejected);
    if (!v) continue;
    const key = `${v.entryId}\u0000${v.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(v);
  }
  if (valid.length === 0) return null;
  if (attributesToYou(t) && !valid.some((c) => c.speaker === "you")) {
    rejected.push({ path: `${path}.text`, reason: "attribution" });
    return null;
  }
  return { text: t, cites: valid };
}

function validated<T>(schema: JsonSchema, output: unknown): { ok: true; value: T } | { ok: false; issues: ValidationIssue[] } {
  const r = validate<T>(schema, output, 40);
  return r.ok ? { ok: true, value: r.value } : { ok: false, issues: r.issues };
}

// ───────────────────────────── labels ─────────────────────────────

interface LabelOutput {
  items: { target: string; fields: Record<string, { value: LabelValue; state: "set" | "refused" | "unanswered"; confidence?: number }>; reason?: string }[];
}

export type LabelDraft = Omit<LabelRecord, "id" | "by" | "at" | "v">;

export interface LabelValidation {
  labels: LabelDraft[];
  /** Target → the model's one-line reason (≤ 140 characters). */
  reasons: Map<string, string>;
  /** Targets the output answered (the job records the others as unanswered). */
  targets: Set<string>;
  rejected: Rejection[];
  /** False when the output failed its schema (repair once, then E_VALIDATION). */
  valid: boolean;
  /** Schema issues for the repair prompt (Cortex's words). */
  issues?: string;
}

export async function validateLabelOutput(output: unknown, packs: readonly PackDef[], vctx: ValidationContext): Promise<LabelValidation> {
  const r = validated<LabelOutput>(labelOutputSchema(packs), output);
  if (!r.ok) return { labels: [], reasons: new Map(), targets: new Set(), rejected: schemaRejections(r.issues), valid: false, issues: formatIssues(r.issues) };
  const all: Rejection[] = [];
  const labels: LabelDraft[] = [];
  const reasons = new Map<string, string>();
  const seen = new Set<string>();
  const targetRe = new RegExp(LABEL_TARGET_PATTERN);
  for (const [i, item] of r.value.items.entries()) {
    const base = `$.items[${i}]`;
    if (!vctx.allowedIds.has(item.target) || !targetRe.test(item.target)) {
      all.push({ path: `${base}.target`, reason: "unknown-id" });
      continue;
    }
    if (seen.has(item.target)) {
      all.push({ path: `${base}.target`, reason: "duplicate", target: item.target });
      continue;
    }
    seen.add(item.target);
    // Rejections inside this item carry its target, so the job can attach them to the right Checks card.
    const rejected: Rejection[] = [];
    for (const p of packs) {
      for (const f of p.fields) {
        const key = fieldKey(p.id, f.key);
        const path = `${base}.fields.${key}`;
        if (vctx.userOwned.has(`${item.target}|${p.id}|${f.key}`)) {
          rejected.push({ path, reason: "user-owned" });
          continue;
        }
        const got = Object.hasOwn(item.fields, key) ? item.fields[key] : undefined;
        let state: LabelDraft["state"] = got?.state ?? "unanswered";
        let value: LabelValue = null;
        if (got && state === "set") {
          value = normaliseLabelValue(f, got.value);
          if (typeof value === "string" && f.type !== "enum") {
            const signals = injectionSignals(value);
            if (signals.length > 0) {
              // The whole field is dropped (SAFE-01); the job raises a check and a warning.
              rejected.push({ path: `${path}.value`, reason: "injection-signal", detail: signals.join(" ") });
              continue;
            }
          } else if (Array.isArray(value)) {
            const kept: string[] = [];
            for (const [j, v] of value.entries()) {
              const c = cleanString(`${path}.value[${j}]`, v, rejected);
              if (c !== null) kept.push(c);
            }
            value = kept.length > 0 ? kept : null;
          }
          if (value === null) state = "unanswered";
          else if (!labelValueFits(f, value)) {
            rejected.push({ path, reason: "enum" });
            continue;
          }
        }
        const draft: LabelDraft = { target: item.target as LabelDraft["target"], pack: p.id, packVersion: p.version, field: f.key, value: state === "set" ? value : null, state };
        const conf = clamp01(got?.confidence);
        if (conf !== undefined) draft.confidence = conf;
        labels.push(draft);
      }
    }
    const why = cleanString(`${base}.reason`, item.reason, rejected);
    if (why !== null) reasons.set(item.target, why.slice(0, REASON_MAX));
    for (const rj of rejected) all.push({ ...rj, target: item.target });
  }
  return { labels, reasons, targets: seen, rejected: all, valid: true };
}

// ───────────────────────────── summary (gist) ─────────────────────────────

interface GistOutput {
  title: string;
  gist: string;
  facets: { work?: string | null; outcome?: string | null; topics: string[] };
  parts: { title: string; firstId: string; lastId: string; notes: { kind: AtomicKind; text: string; cites: { id: string; quote: string }[] }[] }[];
  addressedComments: string[];
  confidence?: number;
  reason?: string;
}

/** One shown message of the conversation, in conversation order. */
export interface ShownMessage {
  id: string;
  /** 0-based position inside the conversation (the stem's message number − 1). */
  idx: number;
  at?: IsoDate;
}

export interface GistValidationOptions {
  conv: ConversationId;
  /** The messages the model was shown, in order. */
  messages: readonly ShownMessage[];
  /** Used when the model's title was dropped. */
  fallbackTitle: string;
}

export interface GistValidation {
  doc: Omit<GistDoc, "id" | "conv" | "madeBy" | "space"> | null;
  /** First and last entry of each part (for the conversation's frond). */
  spans: { n: number; firstEntry: EntryId; lastEntry: EntryId }[];
  confidence?: number;
  reason?: string;
  /** Notes dropped because their quotes failed or they carried an injection signal. */
  droppedNotes: number;
  rejected: Rejection[];
  valid: boolean;
  issues?: string;
}

/** Stable text key of a note (so the same statement keeps its id, comments and citations across runs). */
export function noteTextKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Stable id of an atomic note of a conversation. */
export function atomicNoteId(conv: string, kind: AtomicKind, text: string): ReturnType<typeof machineNoteId> {
  return machineNoteId(kind, `${conv}:${noteTextKey(text)}`);
}

function blockIdFor(id: string, used: Set<string>): string {
  const body = id.slice(2);
  for (let len = 4; len <= body.length; len++) {
    const b = `n-${body.slice(0, len)}`;
    if (!used.has(b)) {
      used.add(b);
      return b;
    }
  }
  let k = 2;
  while (used.has(`n-${body}-${k}`)) k++;
  const b = `n-${body}-${k}`;
  used.add(b);
  return b;
}

export async function validateGistOutput(output: unknown, vctx: ValidationContext, opts: GistValidationOptions): Promise<GistValidation> {
  const r = validated<GistOutput>(GIST_OUTPUT_SCHEMA, output);
  if (!r.ok) return { doc: null, spans: [], droppedNotes: 0, rejected: schemaRejections(r.issues), valid: false, issues: formatIssues(r.issues) };
  const o = r.value;
  const rejected: Rejection[] = [];
  const gist = cleanString("$.gist", o.gist, rejected);
  if (gist === null) return { doc: null, spans: [], droppedNotes: 0, rejected, valid: false, issues: "$.gist must be one plain sentence without links, code or markup" };
  const title = cleanString("$.title", o.title, rejected) ?? opts.fallbackTitle;
  const topics: string[] = [];
  for (const [i, tpc] of o.facets.topics.entries()) {
    const c = cleanString(`$.facets.topics[${i}]`, tpc, rejected);
    const low = c?.toLowerCase();
    if (low && !topics.includes(low)) topics.push(low);
  }
  const facets: GistFacets = { topics: topics.slice(0, 5) };
  if (o.facets.work) facets.work = o.facets.work;
  if (o.facets.outcome) facets.outcome = o.facets.outcome;

  // Parts: positions in the shown message order, sorted, overlaps trimmed, gaps closed so the stem is continuous.
  const pos = new Map<string, number>();
  opts.messages.forEach((m, i) => pos.set(m.id, i));
  type Span = { first: number; last: number; title: string | null; notes: GistOutput["parts"][number]["notes"]; path: string };
  const spans: Span[] = [];
  for (const [i, p] of o.parts.entries()) {
    const path = `$.parts[${i}]`;
    const a = pos.get(p.firstId);
    const b = pos.get(p.lastId);
    if (a === undefined || b === undefined || !vctx.allowedIds.has(p.firstId) || !vctx.allowedIds.has(p.lastId)) {
      rejected.push({ path, reason: "unknown-id" });
      continue;
    }
    if (a > b) {
      rejected.push({ path, reason: "order" });
      continue;
    }
    spans.push({ first: a, last: b, title: cleanString(`${path}.title`, p.title, rejected), notes: p.notes, path });
  }
  spans.sort((x, y) => x.first - y.first || x.last - y.last);
  const merged: Span[] = [];
  for (const s of spans) {
    const prev = merged[merged.length - 1];
    if (prev && s.first <= prev.last) {
      if (s.last <= prev.last) {
        // Entirely inside the previous part: its notes join that part.
        prev.notes = [...prev.notes, ...s.notes];
        rejected.push({ path: s.path, reason: "order" });
        continue;
      }
      s.first = prev.last + 1;
    }
    merged.push(s);
  }
  if (merged.length === 0 || opts.messages.length === 0) return { doc: null, spans: [], droppedNotes: 0, rejected, valid: false, issues: "$.parts must name the first and last message of each part with ids from the data" };
  (merged[0] as Span).first = 0;
  for (let i = 1; i < merged.length; i++) (merged[i - 1] as Span).last = (merged[i] as Span).first - 1;
  (merged[merged.length - 1] as Span).last = opts.messages.length - 1;

  const usedBlocks = new Set<string>();
  const seenNotes = new Set<string>();
  let droppedNotes = 0;
  const parts: GistPartDoc[] = [];
  const outSpans: GistValidation["spans"] = [];
  for (const [i, s] of merged.entries()) {
    const n = i + 1;
    const first = opts.messages[s.first] as ShownMessage;
    const last = opts.messages[s.last] as ShownMessage;
    const notes: AtomicNoteDoc[] = [];
    for (const [j, note] of s.notes.entries()) {
      const st = await checkStatement(`${s.path}.notes[${j}]`, note.text, note.cites, vctx, rejected);
      if (!st) {
        droppedNotes++;
        continue;
      }
      const key = `${note.kind}\u0000${noteTextKey(st.text)}`;
      if (seenNotes.has(key)) continue;
      seenNotes.add(key);
      const id = atomicNoteId(opts.conv, note.kind, st.text);
      notes.push({ id, kind: note.kind, text: st.text, blockId: blockIdFor(id, usedBlocks), cites: st.cites });
    }
    const part: GistPartDoc = { n, title: s.title ?? `Part ${n}`, msgFrom: first.idx + 1, msgTo: last.idx + 1, notes };
    if (first.at) part.startedAt = first.at;
    if (last.at) part.endedAt = last.at;
    parts.push(part);
    outSpans.push({ n, firstEntry: first.id as EntryId, lastEntry: last.id as EntryId });
  }
  const addressedComments: CorrectionId[] = [];
  for (const [i, k] of o.addressedComments.entries()) {
    if (!vctx.openComments?.has(k)) rejected.push({ path: `$.addressedComments[${i}]`, reason: "unknown-id" });
    else if (!addressedComments.includes(k as CorrectionId)) addressedComments.push(k as CorrectionId);
  }
  const doc: GistValidation["doc"] = { title, gist, facets, parts, addressedComments };
  const firstAt = opts.messages[0]?.at;
  if (firstAt) doc.date = firstAt;
  const out: GistValidation = { doc, spans: outSpans, droppedNotes, rejected, valid: true };
  const conf = clamp01(o.confidence);
  if (conf !== undefined) out.confidence = conf;
  const why = cleanString("$.reason", o.reason, rejected);
  if (why !== null) out.reason = why.slice(0, REASON_MAX);
  return out;
}

// ───────────────────────────── map (hub) ─────────────────────────────

interface HubOutput {
  title: string;
  brief: { text: string; cites: { id: string; quote: string }[] }[];
  sections?: Partial<Record<HubSectionKey, { text: string; cites: { id: string; quote: string }[] }[]>>;
  addressedComments: string[];
  confidence?: number;
  reason?: string;
}

export interface HubValidation {
  doc: Omit<HubDoc, "id" | "madeBy" | "space" | "members" | "range" | "hubType" | "status">;
  confidence?: number;
  reason?: string;
  droppedStatements: number;
  rejected: Rejection[];
  /** False when the schema failed or no bullet survived. */
  valid: boolean;
  issues?: string;
}

/** `hubType` limits the typed sections to the ones that map type carries (SPEC V13); omitted, every section key is kept. */
export async function validateHubOutput(output: unknown, vctx: ValidationContext, hubType?: HubType): Promise<HubValidation> {
  const r = validated<HubOutput>(HUB_OUTPUT_SCHEMA, output);
  if (!r.ok) return { doc: { title: "", brief: [], addressedComments: [] }, droppedStatements: 0, rejected: schemaRejections(r.issues), valid: false, issues: formatIssues(r.issues) };
  const o = r.value;
  const rejected: Rejection[] = [];
  const title = cleanString("$.title", o.title, rejected) ?? "";
  const brief: HubStatementDoc[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const [i, b] of o.brief.entries()) {
    const st = await checkStatement(`$.brief[${i}]`, b.text, b.cites, vctx, rejected);
    if (!st) {
      dropped++;
      continue;
    }
    const key = noteTextKey(st.text);
    if (seen.has(key)) continue;
    seen.add(key);
    brief.push(st);
  }
  const allowed = new Set<HubSectionKey>(hubType ? HUB_SECTION_KEYS[hubType] : HUB_SECTION_ALL);
  const sections: NonNullable<HubDoc["sections"]> = {};
  for (const key of HUB_SECTION_ALL) {
    const raw = o.sections?.[key];
    if (!raw || raw.length === 0) continue;
    if (!allowed.has(key)) {
      rejected.push({ path: `$.sections.${key}`, reason: "not-allowed" });
      continue;
    }
    const kept: HubStatementDoc[] = [];
    const seenHere = new Set<string>();
    for (const [i, b] of raw.entries()) {
      const st = await checkStatement(`$.sections.${key}[${i}]`, b.text, b.cites, vctx, rejected);
      if (!st) {
        dropped++;
        continue;
      }
      const k = noteTextKey(st.text);
      if (seenHere.has(k)) continue;
      seenHere.add(k);
      kept.push(st);
    }
    if (kept.length > 0) sections[key] = kept;
  }
  const addressedComments: CorrectionId[] = [];
  for (const [i, k] of o.addressedComments.entries()) {
    if (!vctx.openComments?.has(k)) rejected.push({ path: `$.addressedComments[${i}]`, reason: "unknown-id" });
    else if (!addressedComments.includes(k as CorrectionId)) addressedComments.push(k as CorrectionId);
  }
  const out: HubValidation = { doc: { title, brief, ...(Object.keys(sections).length > 0 ? { sections } : {}), addressedComments }, droppedStatements: dropped, rejected, valid: brief.length > 0 };
  if (brief.length === 0) out.issues = "$.brief needs at least one bullet whose quotes are copied exactly from the passages";
  const conf = clamp01(o.confidence);
  if (conf !== undefined) out.confidence = conf;
  const why = cleanString("$.reason", o.reason, rejected);
  if (why !== null) out.reason = why.slice(0, REASON_MAX);
  return out;
}

// ───────────────────────────── filing ─────────────────────────────

export interface FilingProposal {
  target: string;
  area: string;
  folder?: string;
  project?: string | null;
  confidence: number;
  reason?: string;
}

interface FilingOutput {
  proposals: { target: string; area: string; folder?: string; project?: string | null; confidence: number; reason?: string }[];
}

export async function validateFilingOutput(output: unknown, vctx: ValidationContext, opts: { knownFolders: ReadonlySet<string> }): Promise<{ proposals: FilingProposal[]; rejected: Rejection[]; valid: boolean; issues?: string }> {
  const r = validated<FilingOutput>(FILING_OUTPUT_SCHEMA, output);
  if (!r.ok) return { proposals: [], rejected: schemaRejections(r.issues), valid: false, issues: formatIssues(r.issues) };
  const rejected: Rejection[] = [];
  const proposals: FilingProposal[] = [];
  const seen = new Set<string>();
  for (const [i, p] of r.value.proposals.entries()) {
    const path = `$.proposals[${i}]`;
    if (!vctx.allowedIds.has(p.target)) {
      rejected.push({ path: `${path}.target`, reason: "unknown-id" });
      continue;
    }
    if (seen.has(p.target)) {
      rejected.push({ path: `${path}.target`, reason: "duplicate" });
      continue;
    }
    if (!FILING_AREAS.includes(p.area)) {
      rejected.push({ path: `${path}.area`, reason: "enum" });
      continue;
    }
    seen.add(p.target);
    const out: FilingProposal = { target: p.target, area: p.area, confidence: clamp01(p.confidence) ?? 0 };
    if (p.folder !== undefined) {
      if (opts.knownFolders.has(p.folder)) out.folder = p.folder;
      else rejected.push({ path: `${path}.folder`, reason: "enum" });
    }
    if (p.project !== undefined) {
      if (p.project === null) out.project = null;
      else {
        const c = cleanString(`${path}.project`, p.project, rejected);
        if (c !== null) out.project = c.slice(0, 80);
      }
    }
    const why = cleanString(`${path}.reason`, p.reason, rejected);
    if (why !== null) out.reason = why.slice(0, REASON_MAX);
    proposals.push(out);
  }
  return { proposals, rejected, valid: true };
}

// ───────────────────────────── name check ─────────────────────────────

export interface MentionHit {
  entryId: EntryId;
  /** The exact span of the stored text. */
  quote: string;
  /** Which of your names or handles it contains. */
  name: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The first of `names` that occurs in `text` as a whole word (case-insensitive), or null. */
export function nameIn(text: string, names: readonly string[]): string | null {
  for (const n of names) {
    const t = n.trim();
    if (t.length < 2) continue;
    if (new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(t)}(?![\\p{L}\\p{N}_])`, "iu").test(text)) return t;
  }
  return null;
}

export async function validateNameCheckOutput(output: unknown, vctx: ValidationContext, names: readonly string[]): Promise<{ mentions: MentionHit[]; rejected: Rejection[]; valid: boolean; issues?: string }> {
  const r = validated<{ mentions: { id: string; quote: string }[] }>(NAME_CHECK_OUTPUT_SCHEMA, output);
  if (!r.ok) return { mentions: [], rejected: schemaRejections(r.issues), valid: false, issues: formatIssues(r.issues) };
  const rejected: Rejection[] = [];
  const mentions: MentionHit[] = [];
  const seen = new Set<string>();
  for (const [i, m] of r.value.mentions.entries()) {
    const path = `$.mentions[${i}]`;
    const c = await checkCitation(path, m, vctx, rejected);
    if (!c) continue;
    const name = nameIn(c.quote, names);
    if (name === null) {
      rejected.push({ path: `${path}.quote`, reason: "no-name" });
      continue;
    }
    if (seen.has(c.entryId)) continue;
    seen.add(c.entryId);
    mentions.push({ entryId: c.entryId, quote: c.quote, name });
  }
  return { mentions, rejected, valid: true };
}

// ───────────────────────────── Ask (answer) ─────────────────────────────

export interface AnswerCitation {
  id: string;
  /** Exact span of the cited text. */
  quote: string;
  speaker?: Speaker;
  date?: IsoDate;
}

export interface AnswerValidation {
  reply: string;
  citations: AnswerCitation[];
  actions: ActionCall[];
  /** The model's reason per accepted action (aligned with `actions`), null when none. */
  reasons: (string | null)[];
  rejectedActions: { index: number; reason: "invalid" | "not-allowed" | "too-broad" | "too-many-actions" }[];
  droppedStatements: number;
  rejected: Rejection[];
  valid: boolean;
  issues?: string;
}

interface AnswerShape {
  reply: string;
  citations: { id: string; quote: string }[];
  actions: unknown[];
  reasons?: (string | null)[];
}

const MARKER = /\[(\d{1,2})\]/g;

/** Split a reply into sentences (each keeps its trailing whitespace; citation markers after a period stay with it). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    cur += ch;
    i++;
    if (ch === "\n" || ch === "." || ch === "!" || ch === "?") {
      if (ch !== "\n") {
        // Keep closing quotes/brackets and citation markers that follow the stop with this sentence.
        const tail = /^(?:["'”’)\]]|\s*\[\d{1,2}\])+/.exec(text.slice(i));
        if (tail) {
          cur += tail[0];
          i += tail[0].length;
        }
        // "3.5", "e.g.x" or a path: not the end of a sentence.
        if (i < text.length && !/\s/.test(text[i] as string)) continue;
      }
      const ws = /^\s*/.exec(text.slice(i))?.[0] ?? "";
      cur += ws;
      i += ws.length;
      out.push(cur);
      cur = "";
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Drop every sentence that rests on a citation that failed validation (or names one that does not exist), and
 * renumber the surviving markers to the kept citations' positions.
 */
export function dropStatements(reply: string, renumber: ReadonlyMap<number, number>): { reply: string; dropped: number } {
  let dropped = 0;
  const kept: string[] = [];
  for (const s of splitSentences(reply)) {
    const markers = [...s.matchAll(MARKER)].map((m) => Number(m[1]));
    if (markers.some((n) => !renumber.has(n))) {
      dropped++;
      continue;
    }
    kept.push(s.replace(MARKER, (_m, d: string) => `[${renumber.get(Number(d)) ?? d}]`));
  }
  return { reply: kept.join("").trim(), dropped };
}

/** Text of a reply as Cortex shows it: control characters removed, at most three line breaks in a row. */
function cleanReply(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function actionItems(call: ActionCall): number {
  const p = call.params as { targets?: unknown[]; ids?: unknown[] };
  return Math.max(p.targets?.length ?? 0, p.ids?.length ?? 0);
}

export async function validateAnswerOutput(output: unknown, vctx: ValidationContext, opts: { onlyVerb?: OnlyVerb } = {}): Promise<AnswerValidation> {
  const r = validated<AnswerShape>(ANSWER_SHAPE_SCHEMA, output);
  if (!r.ok) return { reply: "", citations: [], actions: [], reasons: [], rejectedActions: [], droppedStatements: 0, rejected: schemaRejections(r.issues), valid: false, issues: formatIssues(r.issues) };
  const o = r.value;
  const rejected: Rejection[] = [];
  const citations: AnswerCitation[] = [];
  const renumber = new Map<number, number>();
  const seen = new Map<string, number>();
  for (const [i, c] of o.citations.entries()) {
    const path = `$.citations[${i}]`;
    if (!vctx.allowedIds.has(c.id)) {
      rejected.push({ path: `${path}.id`, reason: "unknown-id" });
      continue;
    }
    const e = await vctx.entryOf(c.id);
    if (!e) {
      rejected.push({ path: `${path}.id`, reason: "unknown-id" });
      continue;
    }
    if (!isSubstantialQuote(c.quote)) {
      rejected.push({ path: `${path}.quote`, reason: "quote-too-short" });
      continue;
    }
    const m = findQuote(e.text, c.quote);
    if (!m) {
      rejected.push({ path: `${path}.quote`, reason: "quote-not-found" });
      continue;
    }
    const key = `${c.id}\u0000${m.exact}`;
    const prev = seen.get(key);
    if (prev !== undefined) {
      renumber.set(i + 1, prev);
      continue;
    }
    const cite: AnswerCitation = { id: c.id, quote: m.exact, speaker: e.speaker };
    if (e.date !== undefined) cite.date = e.date;
    citations.push(cite);
    seen.set(key, citations.length);
    renumber.set(i + 1, citations.length);
  }
  const { reply, dropped } = dropStatements(cleanReply(o.reply), renumber);

  const actions: ActionCall[] = [];
  const reasons: (string | null)[] = [];
  const rejectedActions: AnswerValidation["rejectedActions"] = [];
  for (const [i, raw] of o.actions.entries()) {
    if (i >= MAX_ACTIONS_PER_REPLY) {
      rejectedActions.push({ index: i, reason: "too-many-actions" });
      continue;
    }
    const v = validate<ActionCall>(ACTION_CALL_SCHEMA, raw);
    if (!v.ok) {
      rejectedActions.push({ index: i, reason: "invalid" });
      continue;
    }
    if (!Object.hasOwn(ACTION_SPECS, v.value.action)) {
      rejectedActions.push({ index: i, reason: "invalid" });
      continue;
    }
    if (!verbAllowed(v.value.action, opts.onlyVerb)) {
      rejectedActions.push({ index: i, reason: "not-allowed" });
      continue;
    }
    if (actionItems(v.value) > MAX_ITEMS_PER_ACTION) {
      rejectedActions.push({ index: i, reason: "too-broad" });
      continue;
    }
    actions.push(v.value);
    const why = o.reasons?.[i];
    reasons.push(typeof why === "string" && oneLine(why).length > 0 ? oneLine(why).slice(0, 200) : null);
  }
  return { reply, citations, actions, reasons, rejectedActions, droppedStatements: dropped, rejected, valid: true };
}
