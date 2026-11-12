/**
 * Directions out, outcomes and negative results (the lab loop): the pure parts the plugin UI, the vault writers and
 * the tests share. No prompt text, no node imports.
 *
 *  - Directions out: the directions you accepted, as one sentence each. The export carries nothing else: never a
 *    passage of the record, never an id, never a title (directionsExportText). Each export is also kept as a dated
 *    entry so you can see exactly what left.
 *  - An outcome: how an accepted direction turned out (held, did not hold, inconclusive), what was tried, a date and
 *    an optional file name. It is saved as a dated entry of source "outcome" under `.raw/written/outcomes/`, linked
 *    to the direction by the check card id in its frontmatter, and comes back through the written importer.
 *  - A negative result: for "did not hold", a note with no record in it (the direction, what was tried, the result,
 *    the date) written to a local folder with its fingerprint. Cortex sends nothing.
 */
import { injectionSignals, defangRunnable } from "./mdSafe";
import { oneLine } from "./directions";
import { slugify } from "./text";

export const OUTCOME_RESULTS = ["held", "did-not-hold", "inconclusive"] as const;
export type OutcomeResult = (typeof OUTCOME_RESULTS)[number];

export const TRIED_MIN = 3;
export const TRIED_MAX = 2000;
export const FILE_NAME_MAX = 200;

/** Where outcome entries live (inside the written root, so the written importer finds them). */
export const OUTCOMES_DIR = ".raw/written/outcomes";
/** Where negative-result notes are kept (a Cortex write root; never imported into the record). */
export const NEGATIVE_DIR = ".vault-meta/cortex/negative-results";

export function isOutcomePath(rel: string): boolean {
  return rel.replace(/\\/g, "/").startsWith(`${OUTCOMES_DIR}/`);
}

export function isOutcomeResult(v: unknown): v is OutcomeResult {
  return typeof v === "string" && (OUTCOME_RESULTS as readonly string[]).includes(v);
}

/** What the form collects. */
export interface OutcomeInput {
  /** The Checks card of the accepted direction. */
  cardId: string;
  /** The direction as accepted: one sentence. */
  direction: string;
  result: OutcomeResult;
  /** What was tried, in your words (may run to a few lines). */
  tried: string;
  /** The day it was tried, "YYYY-MM-DD". */
  on: string;
  /** Optional: the name of a file that holds the evidence (the name only, never its contents). */
  file?: string;
}

function validDay(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** A well-formed outcome, or null. `today` ("YYYY-MM-DD") bounds the date: an outcome cannot be from the future. */
export function normaliseOutcome(raw: unknown, today: string): OutcomeInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.cardId !== "string" || !/^[\w.-]{1,80}$/.test(r.cardId)) return null;
  if (typeof r.direction !== "string" || typeof r.tried !== "string" || !isOutcomeResult(r.result) || !validDay(r.on)) return null;
  if (r.on > today) return null;
  const direction = oneLine(r.direction);
  if (direction.length === 0 || direction.length > 400 || injectionSignals(direction).length > 0) return null;
  const tried = r.tried.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  const n = [...tried].length;
  if (n < TRIED_MIN || n > TRIED_MAX) return null;
  const out: OutcomeInput = { cardId: r.cardId, direction, result: r.result, tried, on: r.on };
  if (typeof r.file === "string" && r.file.trim() !== "") {
    const name = oneLine(r.file).replace(/^.*[\\/]/, "").slice(0, FILE_NAME_MAX);
    if (name.length > 0) out.file = name;
  }
  return out;
}

/** The moment an outcome is dated: now when it is today's, else midday UTC of that day. */
export function outcomeMoment(on: string, now: Date): Date {
  return on === localDay(now) ? now : new Date(`${on}T12:00:00.000Z`);
}

/** "YYYY-MM-DD" of a Date in local time. */
export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `.raw/written/outcomes/<yyyy>/<mm>/<yyyymmdd-HHmm>-<slug>.md`. */
export function outcomePath(at: Date, direction: string): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`;
  return `${OUTCOMES_DIR}/${at.getFullYear()}/${p(at.getMonth() + 1)}/${stamp}-${slugify(direction, 32)}.md`;
}

/** The entry title: "Held: <direction>". */
export function outcomeTitle(result: OutcomeResult, direction: string, label: (r: OutcomeResult) => string): string {
  return `${label(result)}: ${direction}`.slice(0, 200);
}

/** The text of an outcome file: frontmatter the importer and the outcomes list read back, then the body as typed. */
export function outcomeFileText(args: { id: string; created: Date; title: string; input: OutcomeInput }): string {
  const i = args.input;
  const head = [
    "---",
    `cortex_id: ${args.id}`,
    "made_by: you",
    `created: ${args.created.toISOString()}`,
    `title: ${JSON.stringify(defangRunnable(args.title).replace(/\s+/g, " "))}`,
    "space: none",
    "entry_kind: outcome",
    `outcome_for: ${JSON.stringify(i.cardId)}`,
    `outcome: ${i.result}`,
    `outcome_date: ${i.on}`,
    `outcome_direction: ${JSON.stringify(defangRunnable(i.direction))}`,
    ...(i.file !== undefined ? [`outcome_file: ${JSON.stringify(defangRunnable(i.file))}`] : []),
    "---",
    "",
  ].join("\n");
  const body = `${defangRunnable(i.tried)}\n`;
  return head + body;
}

/** What the lists read from an outcome file. */
export interface OutcomeSummary {
  path: string;
  entryId: string;
  cardId: string;
  result: OutcomeResult;
  on: string;
  direction: string;
  tried: string;
  file?: string;
  /** The note made public for this outcome (a "did not hold" one), when there is one. */
  negative?: string;
}

/** Read an outcome back from the frontmatter map and body of its file (see importers/common splitFrontmatter). */
export function outcomeFromFile(path: string, fm: Readonly<Record<string, string>>, body: string): OutcomeSummary | null {
  const result = fm.outcome;
  if (fm.entry_kind !== "outcome" || !isOutcomeResult(result) || !fm.outcome_for || !fm.cortex_id) return null;
  const on = fm.outcome_date;
  if (!validDay(on)) return null;
  const out: OutcomeSummary = { path, entryId: fm.cortex_id, cardId: fm.outcome_for, result, on, direction: fm.outcome_direction ?? "", tried: body.trim() };
  if (fm.outcome_file) out.file = fm.outcome_file;
  return out;
}

/** Read an outcome file's text (frontmatter then body); null when it is not an outcome file. */
export function parseOutcomeText(path: string, text: string): OutcomeSummary | null {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    let v = kv[2] ?? "";
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      try {
        v = JSON.parse(v) as string;
      } catch {
        v = v.slice(1, -1);
      }
    }
    fm[kv[1] as string] = v;
  }
  return outcomeFromFile(path, fm, text.slice(m[0].length));
}

export interface OutcomeList {
  outcomes: OutcomeSummary[];
  /** File names in the negative-results folder (".md" notes only). */
  negatives: string[];
}

export interface NegativeSaved {
  /** Vault path of the note. */
  path: string;
  /** SHA-256 of the note's exact text, hex. */
  fingerprint: string;
  /** True when this note was already there (nothing was written). */
  existed: boolean;
}

/** The newest outcome of each direction, by date then path. */
export function latestByDirection(list: readonly OutcomeSummary[]): Map<string, OutcomeSummary> {
  const m = new Map<string, OutcomeSummary>();
  for (const o of list) {
    const cur = m.get(o.cardId);
    if (!cur || o.on > cur.on || (o.on === cur.on && o.path > cur.path)) m.set(o.cardId, o);
  }
  return m;
}

// ───────────────────────────── directions out ─────────────────────────────

/** What a direction row needs for the export (the sentence and when it was accepted). */
export interface OutDirection {
  text: string;
  at: string;
}

/**
 * The export, as markdown: a heading, the date and one bullet per direction. Only the direction sentences go in.
 * `head` and `lead` are the caller's copy (src/ui/copy.ts) so this file holds no UI strings.
 */
export function directionsExportText(dirs: readonly OutDirection[], opts: { head: string; lead: string; day: string }): string {
  const lines = [`# ${opts.head}`, "", `${opts.lead} ${opts.day}`, ""];
  for (const d of dirs) lines.push(`- ${stripRecordIds(oneLine(d.text)).trim()}`);
  return `${lines.join("\n")}\n`;
}

/** The title and day of an export entry. */
export function exportEntryTitle(head: string, day: string): string {
  return `${head} · ${day}`;
}

// ───────────────────────────── negative results ─────────────────────────────

const ID_LIKE = /\b[a-z]_[a-z2-7]{16}\b/g;

/** Take the shapes of Cortex ids out of a text (a negative result never names a record item). */
export function stripRecordIds(text: string): string {
  return text.replace(ID_LIKE, "").replace(/[ \t]{2,}/g, " ");
}

/** The note made public: the direction, what was tried, the result and the date. Nothing else. */
export function negativeNoteText(o: Pick<OutcomeInput, "direction" | "tried" | "on" | "result">, labels: { head: string; direction: string; tried: string; result: string; date: string; resultText: string }): string {
  return [
    `# ${labels.head}`,
    "",
    `**${labels.direction}** ${stripRecordIds(oneLine(o.direction))}`,
    "",
    `**${labels.result}** ${labels.resultText}`,
    "",
    `**${labels.date}** ${o.on}`,
    "",
    `**${labels.tried}**`,
    "",
    `${defangRunnable(stripRecordIds(o.tried))}`,
    "",
  ].join("\n");
}

/** `<yyyymmdd>-<slug>.md` inside the negative-results folder. */
export function negativeFileName(on: string, direction: string): string {
  return `${on.replace(/-/g, "")}-${slugify(direction, 40)}.md`;
}
