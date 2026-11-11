/**
 * "No model": the rule-based organiser. Owner: no-model-engines.
 *
 * With no model the record is still organised, less well. Plain rules read the text on this computer and write
 * the same labels a model would, stamped with the engine "rule" so every screen can show a dashed "rule" chip and
 * a later model run replaces them (a model label is newer, so it wins; a rule label never counts as "already
 * labelled", so the model still gets its turn). Nothing leaves this computer and nothing is ever sent anywhere:
 * this file has no network, no process and no model.
 *
 * What the rules know:
 *  - project: the conversation's own project (from its folder or working directory), else the folder it sits in;
 *  - topics: the most telling words of the conversation, ranked against how common each word is across the whole
 *    record (the local search index's document counts, else the batch itself);
 *  - work: a plain guess at what kind of talk it was (a question, a plan or code) from its opening words;
 *  - role (notes): a guess from the note's folder and title;
 *  - maps: one entry per project, listing the titles of its conversations.
 *
 * Pure module: no DOM, no Node, no I/O. The job (agents/jobs.ts runLabel / runHub) feeds it text and writes the
 * records. Rule output is always a guess; it never answers a field it cannot answer (an outcome, say), so a
 * model has nothing to contradict.
 */
import { LABEL_MULTI_ITEM_MAX, LABEL_TEXT_MAX, SESSION_PACK, PLACEMENT_PACK, labelValueFits, normaliseLabelValue } from "../shared/packs";
import { tokenize } from "../shared/text";
import type { ConversationRecord, EngineKind, JobKind, LabelRecord, LabelValue, NoteRecord } from "../shared/types";
import type { Engine, EngineProbe, EngineRequest, EngineResult } from "./engine";

/** The name rule runs and rule labels carry in the model slot. */
export const RULE_MODEL = "rule";

/** The jobs the rules can do; summaries, filing and the name check need a model. */
export const RULE_JOBS: ReadonlySet<JobKind> = new Set<JobKind>(["label", "hub"]);

/** Does this label come from the rule organiser (not from a model, not from you)? */
export function isRuleLabel(l: { by: LabelRecord["by"] }): boolean {
  return "engine" in l.by && l.by.engine === "rule";
}

/** Was this note (a map) written by the rule organiser? */
export function isRuleNote(n: Pick<NoteRecord, "madeBy">): boolean {
  return "engine" in n.madeBy && n.madeBy.engine === "rule";
}

/** The engine a No model pass hands the scheduler. It never answers a call: the rules do not talk to a model. */
export class RuleEngine implements Engine {
  readonly kind: EngineKind = "rule";
  readonly where = "this computer" as const;
  readonly paidBy = "none" as const;

  async probe(): Promise<EngineProbe> {
    return { ok: true, version: "rule", flags: {}, missingMandatory: [], detail: "ready" };
  }

  async run(_req: EngineRequest): Promise<EngineResult> {
    return { ok: false, error: { code: "E_ENGINE_MISSING", message: "no model is chosen", retryable: false, reason: "no-model" }, durationMs: 0, started: false };
  }
}

// ───────────────────────────── project ─────────────────────────────

/** A user's home folder is where a session ran, not what it worked on. */
const HOME_LIKE = /^(?:[a-z]:)?[\\/](?:users|home)[\\/][^\\/]+[\\/]?$/i;

function lastSegment(p: string): string {
  const parts = p.split(/[\\/]+/).filter((x) => x.length > 0);
  return parts[parts.length - 1] ?? "";
}

function cleanName(s: string): string | undefined {
  const c = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (c.length === 0) return undefined;
  return c.length > LABEL_TEXT_MAX ? c.slice(0, LABEL_TEXT_MAX).trim() : c;
}

/** The project a conversation belongs to: its own project, else the folder it ran in, else the folder it sits in. */
export function ruleProject(conv: Pick<ConversationRecord, "project" | "meta" | "folder">): string | undefined {
  if (conv.project) {
    const p = cleanName(conv.project);
    if (p) return p;
  }
  const cwd = conv.meta?.cwd;
  if (cwd && !HOME_LIKE.test(cwd)) {
    const p = cleanName(lastSegment(cwd));
    if (p) return p;
  }
  const f = conv.folder?.[conv.folder.length - 1];
  if (f) return cleanName(f);
  return undefined;
}

// ───────────────────────────── topics ─────────────────────────────

/** Document counts of the record's words (the local search index), or the batch's own counts. */
export interface TermStats {
  /** Documents the counts speak for. */
  docs: number;
  /** In how many documents the word occurs (0 = unknown word). */
  df(term: string): number;
}

/** Counts over a batch of word sets (used when no search index exists yet, and by tests). */
export function statsOfBatch(sets: readonly ReadonlySet<string>[]): TermStats {
  const counts = new Map<string, number>();
  for (const s of sets) for (const w of s) counts.set(w, (counts.get(w) ?? 0) + 1);
  return { docs: sets.length, df: (t) => counts.get(t) ?? 0 };
}

/** Words that are plumbing, not topics (ids, hashes, numbers, tool names that every session mentions). */
function usable(w: string): boolean {
  if (w.length < 3 || w.length > LABEL_MULTI_ITEM_MAX) return false;
  if (/^\d+$/.test(w)) return false;
  if (w.length >= 8 && /\d/.test(w) && /[a-f]/.test(w)) return false;
  return !FILLER.has(w);
}

const FILLER = new Set([
  "please", "thanks", "thank", "okay", "yes", "just", "like", "also", "need", "want", "make", "does", "doing", "done", "get", "got", "use", "using", "used",
  "can", "could", "would", "should", "let", "lets", "now", "new", "one", "two", "way", "thing", "things", "something", "really", "right", "good", "great",
  "sure", "look", "see", "try", "going", "work", "works", "working", "file", "files", "code", "here", "there", "then", "than", "them", "they", "you", "your",
  "claude", "assistant", "user", "message", "answer", "question", "help", "hello", "hey", "will", "well", "much", "many", "more", "most", "some", "any",
]);

/** Count the usable words of a text (the same word breaks as the search index). */
export function termCounts(text: string, into: Map<string, number> = new Map(), weight = 1): Map<string, number> {
  for (const w of tokenize(text)) if (usable(w)) into.set(w, (into.get(w) ?? 0) + weight);
  return into;
}

/**
 * The most telling words: frequent here and not everywhere. A word counts when it also occurs elsewhere in the
 * record (a lone identifier is not a topic) and is not in most documents. Without any counts (a tiny record) the
 * word frequency alone decides, with a floor of two mentions.
 */
export function rankTopics(counts: ReadonlyMap<string, number>, stats: TermStats | null, max = 5): string[] {
  const scored: { w: string; score: number }[] = [];
  const n = stats?.docs ?? 0;
  const rich = stats !== null && n >= 8;
  for (const [w, tf] of counts) {
    let idf = 1;
    if (rich && stats) {
      const df = stats.df(w);
      if (df < 2 || df > Math.max(3, n * 0.3)) continue;
      idf = Math.log(1 + n / df);
    } else if (tf < 2) continue;
    scored.push({ w, score: tf * idf });
  }
  scored.sort((a, b) => b.score - a.score || (a.w < b.w ? -1 : 1));
  return scored.slice(0, max).map((s) => s.w);
}

// ───────────────────────────── kind of talk ─────────────────────────────

/** The three plain guesses (the spec's question, plan, code) and the session pack's `work` value each stands for. */
export type TalkKind = "question" | "plan" | "code";

const CODE_FENCE = /```|~~~/;
const CODE_WORDS = /\b(function|class|const|import|export|stack ?trace|traceback|exception|compile[rd]?|refactor|implement|npm|pnpm|pip|git|commit|typescript|javascript|python|bug|error|fails?|failing|crash(?:es|ed)?|regex|api|sql|css|html|json|test(?:s|ing)?|build)\b/gi;
const DEBUG_WORDS = /\b(error|bug|exception|traceback|stack ?trace|crash(?:es|ed)?|fails?|failing|broken|not working|doesn'?t work|fix)\b/i;
const PLAN_WORDS = /\b(plan|roadmap|outline|strategy|milestones?|steps? to|proposal|schedule|priorit(?:y|ies|ise|ize)|design(?:ing)? (?:a|the)|architecture|spec)\b/i;
const SETUP_WORDS = /\b(install|set ?up|configure|configuration|environment|deploy|upgrade|migrate)\b/i;
const WRITE_WORDS = /\b(write|draft|rewrite|essay|email|blog|letter|summari[sz]e|proofread|translate)\b/i;
const QUESTION_START = /^\s*(?:how|what|why|when|where|who|which|can|could|is|are|does|do|should|would|will)\b/i;

/** A guess at the kind of talk from its title and opening words, or null when nothing points one way. */
export function guessTalk(title: string, opening: string): { kind: TalkKind; work: string } | null {
  const text = `${title}\n${opening}`.slice(0, 4000);
  const codeHits = (text.match(CODE_WORDS) ?? []).length + (CODE_FENCE.test(text) ? 3 : 0);
  if (codeHits >= 3 || CODE_FENCE.test(text)) return { kind: "code", work: DEBUG_WORDS.test(text) ? "debug" : SETUP_WORDS.test(text) ? "set up" : "build" };
  if (PLAN_WORDS.test(text)) return { kind: "plan", work: "plan" };
  const first = opening.trim();
  // A question that only mentions a failure is still a question; real code (fences, several code words) was decided above.
  if (QUESTION_START.test(first) || /\?\s*$/.test(first.split("\n")[0] ?? "")) return { kind: "question", work: "research" };
  if (SETUP_WORDS.test(text)) return { kind: "code", work: "set up" };
  if (WRITE_WORDS.test(text)) return { kind: "plan", work: "write" };
  if (codeHits >= 1) return { kind: "code", work: DEBUG_WORDS.test(text) ? "debug" : "build" };
  if (/\?/.test(first.slice(0, 300))) return { kind: "question", work: "research" };
  return null;
}

// ───────────────────────────── notes ─────────────────────────────

const ROLE_RULES: readonly { role: string; re: RegExp }[] = [
  { role: "map", re: /(^|[\\/ _-])(_?index|moc|map|hub)([\\/ ._-]|$)/i },
  { role: "log", re: /(^|[\\/ _-])(log|daily|journal|changelog|diary)([\\/ ._-]|$)|\b\d{4}-\d{2}-\d{2}\b/i },
  { role: "decision", re: /(^|[\\/ _-])(decisions?|adr)([\\/ ._-]|$)/i },
  { role: "plan", re: /(^|[\\/ _-])(plans?|roadmap|todo|tasks?|backlog)([\\/ ._-]|$)/i },
  { role: "howto", re: /(^|[\\/ _-])(how-?to|guides?|tutorials?|runbooks?)([\\/ ._-]|$)/i },
  { role: "reference", re: /(^|[\\/ _-])(references?|docs?|manuals?|specs?|api)([\\/ ._-]|$)/i },
  { role: "idea", re: /(^|[\\/ _-])(ideas?|brainstorms?)([\\/ ._-]|$)/i },
  { role: "draft", re: /(^|[\\/ _-])(drafts?|wip)([\\/ ._-]|$)/i },
  { role: "reflection", re: /(^|[\\/ _-])(reflections?|retro(?:spective)?s?|thoughts)([\\/ ._-]|$)/i },
  { role: "project", re: /(^|[\\/ _-])(projects?)([\\/ ._-]|$)/i },
  { role: "source", re: /(^|[\\/ _-])(sources?|clippings?|raw|inbox)([\\/ ._-]|$)/i },
];

/** A guess at a vault note's role from its folder and title, or null (never a wrong confident answer). */
export function ruleRole(path: string, title: string): string | undefined {
  const values = new Set(PLACEMENT_PACK.fields[0]?.values ?? []);
  for (const r of ROLE_RULES) if (values.has(r.role) && (r.re.test(path) || r.re.test(title))) return r.role;
  return undefined;
}

// ───────────────────────────── the labels ─────────────────────────────

export interface RuleField {
  field: string;
  value: LabelValue;
}

/** What the rules can say about one conversation (only fields they can answer; checked against the pack). */
export function ruleSessionFields(conv: Pick<ConversationRecord, "project" | "meta" | "folder" | "title">, opening: string, counts: ReadonlyMap<string, number>, stats: TermStats | null): RuleField[] {
  const out: RuleField[] = [];
  const add = (key: string, raw: LabelValue): void => {
    const f = SESSION_PACK.fields.find((x) => x.key === key);
    if (!f) return;
    const v = normaliseLabelValue(f, raw);
    if (v !== null && labelValueFits(f, v)) out.push({ field: key, value: v });
  };
  const work = guessTalk(conv.title, opening);
  if (work) add("work", work.work);
  const project = ruleProject(conv);
  if (project) add("project", project);
  const topics = rankTopics(counts, stats, 5);
  if (topics.length > 0) add("topics", topics);
  return out;
}

/** The note role the rules found, as a field list (empty when there is none). */
export function ruleNoteFields(path: string, title: string): RuleField[] {
  const role = ruleRole(path, title);
  return role ? [{ field: "role", value: role }] : [];
}

// ───────────────────────────── maps ─────────────────────────────

/** How many titles a rule map lists, and the fewest conversations a project needs to earn one. */
export const RULE_MAP = { minConversations: 3, maxTitles: 12, perPass: 12, titleChars: 120 } as const;

export interface RuleMapSpec {
  /** Lower-cased project name (the map's key). */
  key: string;
  title: string;
  /** Titles of the project's conversations, newest first, de-duplicated. */
  titles: string[];
  conversations: string[];
  count: number;
  /** The area most of its conversations sit in ("none" when they have none). */
  space: string;
  /** First and last conversation time (epoch ms; 0 when none is dated). */
  from: number;
  to: number;
}

function cleanTitle(s: string): string {
  const c = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return c.length > RULE_MAP.titleChars ? `${c.slice(0, RULE_MAP.titleChars - 1).trim()}…` : c;
}

/** One map per project that has enough conversations, listing their titles (newest first). */
export function ruleMapSpecs(items: readonly { id: string; title: string; project: string | undefined; at: number; space?: string }[]): RuleMapSpec[] {
  const by = new Map<string, { name: Map<string, number>; spaces: Map<string, number>; rows: { id: string; title: string; at: number }[] }>();
  for (const it of items) {
    if (!it.project) continue;
    const key = it.project.trim().toLowerCase();
    if (key.length === 0) continue;
    const acc = by.get(key) ?? { name: new Map<string, number>(), spaces: new Map<string, number>(), rows: [] };
    acc.name.set(it.project.trim(), (acc.name.get(it.project.trim()) ?? 0) + 1);
    const sp = it.space ?? "none";
    acc.spaces.set(sp, (acc.spaces.get(sp) ?? 0) + 1);
    acc.rows.push({ id: it.id, title: cleanTitle(it.title), at: it.at });
    by.set(key, acc);
  }
  const out: RuleMapSpec[] = [];
  for (const [key, acc] of by) {
    if (acc.rows.length < RULE_MAP.minConversations) continue;
    acc.rows.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
    const seen = new Set<string>();
    const titles: string[] = [];
    for (const r of acc.rows) {
      const k = r.title.toLowerCase();
      if (r.title.length === 0 || seen.has(k)) continue;
      seen.add(k);
      titles.push(r.title);
    }
    const name = [...acc.name.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? key;
    const space = [...acc.spaces.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? "none";
    const dated = acc.rows.map((r) => r.at).filter((n) => Number.isFinite(n) && n > 0);
    out.push({ key, title: name, titles: titles.slice(0, RULE_MAP.maxTitles), conversations: acc.rows.map((r) => r.id), count: acc.rows.length, space, from: dated.length > 0 ? Math.min(...dated) : 0, to: dated.length > 0 ? Math.max(...dated) : 0 });
  }
  out.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
  return out.slice(0, RULE_MAP.perPass);
}
