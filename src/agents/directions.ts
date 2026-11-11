/**
 * Direction trials (LAB-10): the user writes a purpose and a model drafts a few short directions toward it, under
 * up to three arms that differ only in what the model is given:
 *   record  — passages the user wrote, picked for relevance to the purpose (never anything left out or off limits);
 *   placebo — neutral passages on unrelated subjects, bundled with Cortex (no record text leaves the computer);
 *   none    — nothing: the model alone.
 * Comparing the arms shows whether the record changed what the model suggested. Each arm is one `directions` run
 * (RunRecord.experiment holds purpose, arm and the drafted directions); every drafted direction also waits in
 * Checks as a "direction" card (accept, edit, dismiss) and is never applied by itself.
 *
 * This module is pure: request normalisation, the placebo pool, relevance scoring, the output schema, the prompt
 * and the validator. agents/jobs.ts does the reading (privacy policy, redaction, ReadRecord, budget) and writing.
 */
import { injectionSignals } from "../shared/mdSafe";
import { bare, DIRECTION_MAX_CHARS, DIRECTION_MIN_CHARS, DIRECTIONS_ASKED, DIRECTIONS_MAX, oneLine } from "../shared/directions";
import type { DirectionArm } from "../shared/types";
import { formatIssues, validate, type JsonSchema } from "../shared/validate";
import { DATA_RULES, makeBoundary, PROMPT_VERSIONS, renderDataBlock, type BuiltPrompt, type PromptItem, type PromptOptions } from "./prompts";
import type { Rejection } from "./validators";

export * from "../shared/directions";

/** Passages given to the record arm, and to the placebo arm (so the arms differ in content, not in size). */
export const RECORD_PASSAGES = 12;
export const PLACEBO_PASSAGE_COUNT = 6;
/** One passage's excerpt, in characters. */
export const PASSAGE_CHARS = 700;
/** Messages read from the record to find relevant passages (bounds the work on a large record). */
export const RECORD_READ_LIMIT = 400;
/** Passage ids a direction may name as what it builds on. */
export const PASSAGE_ID_PATTERN = "^[a-z]_[a-z0-9]{1,16}$";

// ───────────────────────────── relevance ─────────────────────────────

const STOP = new Set(
  "about above after again also among because been before being between both could does done each from have into just like make many more most much must only other over said same should some such than that their them then there these they this those through under until upon very want were what when where which while will with within without would your yours towards toward able need needs find finding get getting help better".split(" "),
);

/** The distinctive words of a purpose: lower case, at least 4 letters, no common words, no repeats. */
export function purposeTerms(purpose: string): string[] {
  const out: string[] = [];
  for (const w of purpose.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) ?? []) {
    const word = w.replace(/^['-]+|['-]+$/g, "");
    if (word.length < 4 || STOP.has(word) || out.includes(word)) continue;
    out.push(word);
  }
  return out;
}

/** How many distinct purpose words a text contains (whole words, case-insensitive). */
export function relevance(terms: readonly string[], text: string): number {
  if (terms.length === 0) return 0;
  const words = new Set((text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []).map((w) => w.replace(/^['-]+|['-]+$/g, "")));
  let n = 0;
  for (const term of terms) if (words.has(term) || words.has(`${term}s`) || (term.endsWith("s") && words.has(term.slice(0, -1)))) n++;
  return n;
}

export interface RankedPassage<T> {
  item: T;
  score: number;
}

/** The `n` passages with the most purpose words (ties: the order given, which jobs.ts sets newest first). Passages with no match are not returned. */
export function rankPassages<T extends { text: string; title?: string }>(terms: readonly string[], candidates: readonly T[], n: number): RankedPassage<T>[] {
  const scored: RankedPassage<T>[] = [];
  for (const [i, c] of candidates.entries()) {
    const score = relevance(terms, c.text) * 2 + relevance(terms, c.title ?? "");
    if (score > 0) scored.push({ item: c, score: score + (candidates.length - i) / (candidates.length + 1) / 10 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, Math.max(0, n));
}

// ───────────────────────────── placebo ─────────────────────────────

export interface PlaceboPassage {
  id: string;
  title: string;
  text: string;
}

/** Neutral passages on unrelated subjects. They carry no record text and no claim about the user. */
export const PLACEBO_POOL: readonly PlaceboPassage[] = [
  { id: "p_tide", title: "Reading a tide table", text: "A tide table lists the predicted height of the water at a harbour for each hour of the day. The heights come from adding together many regular cycles, the largest of which follow the moon. Local shape matters too: a narrow estuary can raise the peak well above what the open sea would show, and a strong wind can shift the real level by more than a foot. Harbour pilots treat the table as a starting point and check the gauge on the quay before they commit a deep-draught vessel to the channel." },
  { id: "p_bread", title: "Why dough rests", text: "Bread dough is left to rest so that two slow processes can finish. Enzymes in the flour break some of the starch into simple sugars that the yeast can use, and the gluten network relaxes so that it stretches without tearing. A cool dough rests for many hours and tastes more complex because the bacteria that live alongside the yeast have time to produce mild acids. A warm dough is ready within the hour but has a flatter flavour and a coarser crumb." },
  { id: "p_tram", title: "A tram timetable", text: "Tram timetables are built around the turnaround at each end of the line. A vehicle that arrives at the terminus needs several minutes for the driver to change ends, for passengers to leave and board, and for the track signals to clear. If the timetable allows too little time the delay carries into the return journey and then into every later departure. Planners therefore add a small buffer at the terminus and accept that the tram will sometimes wait there rather than leave late." },
  { id: "p_glacier", title: "Measuring a glacier", text: "Surveyors measure a glacier by planting stakes in the ice along a line from the top to the snout and returning to read them. Each stake shows how much surface has melted since the last visit, and its slow drift downhill shows how fast the ice flows. Snow pits dug beside the stakes record how much new snow fell over the winter. Together the readings give a yearly balance of what was gained at the top and lost at the bottom." },
  { id: "p_bell", title: "Casting a bell", text: "A bell founder makes a clay mould in two parts, the core inside and a hollow cope outside, and leaves a gap between them the shape of the finished bell. Molten bronze is poured into the gap and the whole assembly cools for days. The pitch of the bell depends on its thickness at several points, so after casting the founder shaves metal from the inside wall with a lathe until the main tones sit in tune with one another." },
  { id: "p_post", title: "Sorting the post", text: "Before machines read addresses, mail was sorted by hand into pigeonholes arranged by region. A clerk learned the order of towns along each railway line and could place a letter in the right slot without reading more than the last word. Mail trains carried sorting carriages so that the work was done in transit and bags were ready for each stop. The system depended on memory, rhythm and an unchanging map of the lines." },
  { id: "p_lighthouse", title: "Lighthouse lenses", text: "A lighthouse lens is built from rings of glass prisms that bend the light from a small flame or lamp into a narrow horizontal beam. The prisms replace a thick solid lens that would be far too heavy, and they lose very little light to absorption. The lens floats on a bath of mercury or rolls on bearings so that a modest clockwork motor can turn it, and the turning produces the pattern of flashes that identifies each light." },
  { id: "p_cheese", title: "The rind of a cheese", text: "The rind of a hard cheese forms as the surface dries and a community of moulds and bacteria settles on it. Cheesemakers wash or brush the rind on a schedule to steer which organisms win, and the choice changes the colour, the smell and how quickly the inside ripens. A cheese stored in a damp cellar grows a soft, sticky surface, while the same cheese in drier air forms a firm, pale crust that keeps for longer." },
];

/**
 * The placebo passages for a purpose: the pool entries that share the fewest words with it (ties in pool order), so
 * the placebo is not accidentally relevant, in the pool's order.
 */
export function pickPlacebo(purpose: string, n: number = PLACEBO_PASSAGE_COUNT): PlaceboPassage[] {
  const terms = purposeTerms(purpose);
  const scored = PLACEBO_POOL.map((p, i) => ({ p, i, s: relevance(terms, `${p.title} ${p.text}`) }));
  return scored
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, Math.max(0, n))
    .sort((a, b) => a.i - b.i)
    .map((x) => x.p);
}

// ───────────────────────────── schema, prompt, validator ─────────────────────────────

export const DIRECTIONS_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    directions: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          // Length is judged per direction by the validator, so one short or long item does not discard the whole reply.
          text: { type: "string", minLength: 1, maxLength: 1000 },
          from: { type: "array", maxItems: 3, items: { type: "string", pattern: PASSAGE_ID_PATTERN } },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  required: ["directions"],
  additionalProperties: false,
};

const SYSTEM_BASE = [
  "You help the person who owns this record find ways forward. They write a purpose; you propose a few short directions they could take toward it.",
  'The line with kind "purpose" is what the person wants, in their own words.',
  `Return {"directions": [{"text", "from"}]}: ${DIRECTIONS_ASKED} items. Each text is one plain sentence of at most ${DIRECTION_MAX_CHARS} characters naming a concrete thing to try, read, build or ask. No lists, no markdown, no links, no code, no claims about the person's past.`,
];
const SYSTEM_PASSAGES = [
  'Lines with kind "passage" are reading material. Use them where they help.',
  'In "from", list the ids of the passages a direction builds on (at most 3, only ids shown); leave "from" out when it builds on none.',
];
const SYSTEM_ALONE = ['Leave "from" out.'];

export function buildDirectionsPrompt(purpose: string, arm: DirectionArm, passages: readonly PromptItem[], opts: PromptOptions = {}): BuiltPrompt {
  const boundary = opts.boundary ?? makeBoundary();
  const system = [...SYSTEM_BASE, ...(arm === "none" ? SYSTEM_ALONE : SYSTEM_PASSAGES), "", DATA_RULES].join("\n");
  const lines: PromptItem[] = [{ id: "purpose", kind: "purpose", text: purpose }, ...(arm === "none" ? [] : passages.map((p) => ({ ...p, kind: "passage" })))];
  const prompt = [arm === "none" ? "Propose directions toward this purpose." : `Propose directions toward this purpose, with these ${passages.length} passages.`, renderDataBlock(lines, boundary)].join("\n");
  const ids = arm === "none" ? [] : passages.map((p) => p.id);
  return { system, prompt, schema: DIRECTIONS_OUTPUT_SCHEMA, version: PROMPT_VERSIONS.directions, allowedIds: new Set(ids) };
}

export interface DirectionDraft {
  text: string;
  from?: string[];
}

export interface DirectionsValidation {
  directions: DirectionDraft[];
  rejected: Rejection[];
  valid: boolean;
  issues?: string;
}

/** Validate a reply: schema, plain one-line sentences of 8 to 200 characters, no injection signals, no repeats, ids from the shown set only. */
export function validateDirectionsOutput(output: unknown, allowed: ReadonlySet<string>): DirectionsValidation {
  const r = validate<{ directions: { text: string; from?: string[] }[] }>(DIRECTIONS_OUTPUT_SCHEMA, output, 40);
  if (!r.ok) return { directions: [], rejected: r.issues.map((i) => ({ path: i.path, reason: "schema" as const, detail: i.message })), valid: false, issues: formatIssues(r.issues) };
  const rejected: Rejection[] = [];
  const out: DirectionDraft[] = [];
  const seen = new Set<string>();
  for (const [i, d] of r.value.directions.entries()) {
    const path = `$.directions[${i}]`;
    const signals = injectionSignals(d.text);
    if (signals.length > 0) {
      rejected.push({ path: `${path}.text`, reason: "injection-signal", detail: signals.join(" ") });
      continue;
    }
    const text = bare(oneLine(d.text));
    const n = [...text].length;
    if (n < DIRECTION_MIN_CHARS || n > DIRECTION_MAX_CHARS) {
      rejected.push({ path: `${path}.text`, reason: "schema", detail: n < DIRECTION_MIN_CHARS ? "too short" : "too long" });
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      rejected.push({ path, reason: "duplicate" });
      continue;
    }
    if (out.length >= DIRECTIONS_MAX) {
      rejected.push({ path, reason: "too-many-actions" });
      continue;
    }
    seen.add(key);
    const draft: DirectionDraft = { text };
    const from: string[] = [];
    for (const [j, id] of (d.from ?? []).entries()) {
      if (!allowed.has(id)) rejected.push({ path: `${path}.from[${j}]`, reason: "unknown-id" });
      else if (!from.includes(id)) from.push(id);
    }
    if (from.length > 0) draft.from = from;
    out.push(draft);
  }
  if (out.length === 0) return { directions: [], rejected, valid: false, issues: `none of the directions could be used: each must be one plain sentence of ${DIRECTION_MIN_CHARS} to ${DIRECTION_MAX_CHARS} characters, with no markdown, links or code` };
  return { directions: out, rejected, valid: true };
}

