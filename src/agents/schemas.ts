/**
 * JSON schemas of what each job's model must return. Owner: E6.
 * These are passed to `claude --json-schema` and re-checked by validators.ts. The model returns data only:
 * ids it may cite are restricted to the ones it was shown (checked in validators), quotes must be exact
 * substrings of at least 12 characters or 3 non-stopword words, label values must be in the pack's enum, and
 * no string may carry markdown structure (validators drop fields with injection signals: shared/mdSafe.ts).
 * Nothing in an output is ever executed or used as a path.
 *
 * Every schema is closed (`additionalProperties: false`, own properties only: SAFE-15). Limits here are the
 * outer bound; validators.ts applies the finer rules (ids from the shown set, exact quotes, part order,
 * attribution, injection signals) and drops only the offending field or statement.
 */
import { ACTION_CALL_SCHEMA, MAX_ACTIONS_PER_REPLY } from "../shared/actions";
import { ATOMIC_KINDS } from "../shared/notesDoc";
import { fieldKey, LABEL_MULTI_DEFAULT_MAX, LABEL_MULTI_ITEM_MAX, LABEL_TEXT_MAX } from "../shared/packs";
import { SPACES } from "../shared/spaces";
import { HUB_SECTION_KEYS, type ConversationId, type HubSectionKey, type HubType, type LabelId, type LabelRecord, type LabelValue, type NoteId, type PackDef, type SpaceId, type VaultPath } from "../shared/types";
import type { JsonSchema } from "../shared/validate";

// ───────────────────────────── Checks card proposals (ReviewCardRecord.proposal) ─────────────────────────────
// The shapes the jobs write into `ReviewCardRecord.proposal`, by card kind. Pure types: the Checks page (E12) and
// check answers (E7) may import them type-only. Every string is Cortex's own or validated model output.

/** A label run's suggestion for one pack ("session 1.0.0 suggests" · one row per field). */
export interface LabelCardProposal {
  kind: "label";
  pack: string;
  version: string;
  fields: { field: string; value: LabelValue; state: LabelRecord["state"]; confidence?: number; labelId: LabelId }[];
  /** Fields dropped because the model's value carried link or code syntax (SAFE-01), as schema paths. */
  dropped?: { path: string; signals: string }[];
}

/** A summary or map a run wrote (Looks right · Correct). */
export interface NoteCardProposal {
  kind: "note";
  noteId: NoteId;
  conv?: ConversationId;
  mapKind?: HubType;
  title: string;
  /** The gist sentence, or the map's brief joined by line breaks. */
  text: string;
  /** Atomic notes in the summary, or members of the map. */
  notes: number;
  /** Statements dropped because their quotes could not be found. */
  dropped: number;
  /** Paths of fields dropped for link or code syntax (SAFE-01). */
  injection?: string[];
}

/** A suggested place (never applied without Confirm). */
export interface FilingCardProposal {
  kind: "filing";
  area: SpaceId;
  folder?: string;
  project?: string | null;
}

/** Another person's message that names you ("That's me" · "Not me"). */
export interface MentionCardProposal {
  kind: "mention";
  /** Which of your names or handles it contains. */
  name: string;
  /** Exact span of the stored text around the mention. */
  quote: string;
}

/** A derived note you edited in Obsidian: Cortex kept yours; the agents' new version waits here (Keep mine · Use theirs). */
export interface ConflictCardProposal {
  kind: "conflict";
  noteId: NoteId;
  path: VaultPath;
  /** The new version as Cortex would have written it (inert markdown), for the side-by-side diff. */
  markdown: string;
}

export type CardProposal = LabelCardProposal | NoteCardProposal | FilingCardProposal | MentionCardProposal | ConflictCardProposal;

export const ENTRY_ID_PATTERN = "^e_[a-z2-7]{16}$";
/** Anything a citation may point at: a record entry, a machine note or a vault note. */
export const CITABLE_ID_PATTERN = "^[enw]_[a-z2-7]{16}$";
/** A label target: a conversation, a machine note, a wiki note or a record entry (a vault note outside wiki/ is one). */
export const LABEL_TARGET_PATTERN = "^[cnwe]_[a-z2-7]{16}$";
/** A filing target: a conversation, an entry or a note. */
export const FILING_TARGET_PATTERN = "^[cenw]_[a-z2-7]{16}$";
export const COMMENT_ID_PATTERN = "^k_[a-z2-7]{16}$";

/** Longest model reason shown behind "Why?" on a Checks card (M5). */
export const REASON_MAX = 140;
/** Longest one-sentence gist (the sheet subtitle). */
export const GIST_MAX = 300;
/** Most parts in a summary's frond and notes per part. */
export const MAX_PARTS = 12;
export const MAX_NOTES_PER_PART = 12;
/** A map's brief: 3–5 bullets (the validator keeps a brief with at least one valid bullet). */
export const MIN_BRIEF = 1;
export const MAX_BRIEF = 5;
/** Statements in one typed section of a map (next steps, open questions…). */
export const MAX_SECTION = 5;
export const MAX_CITES = 6;

const cite = (idPattern: string = CITABLE_ID_PATTERN): JsonSchema => ({
  type: "object",
  properties: { id: { type: "string", pattern: idPattern }, quote: { type: "string", minLength: 3, maxLength: 400 } },
  required: ["id", "quote"],
  additionalProperties: false,
});

const confidence: JsonSchema = { type: "number", minimum: 0, maximum: 1 };
const reason: JsonSchema = { type: "string", maxLength: REASON_MAX };
const addressed: JsonSchema = { type: "array", items: { type: "string", pattern: COMMENT_ID_PATTERN }, maxItems: 50 };

const statement = (max: number, maxLen = 600): JsonSchema => ({
  type: "array",
  maxItems: max,
  items: {
    type: "object",
    properties: { text: { type: "string", minLength: 3, maxLength: maxLen }, cites: { type: "array", items: cite(ENTRY_ID_PATTERN), minItems: 1, maxItems: MAX_CITES } },
    required: ["text", "cites"],
    additionalProperties: false,
  },
});

/** Schema of one pack field's value, as the model must emit it. */
export function fieldValueSchema(f: PackDef["fields"][number]): JsonSchema {
  switch (f.type) {
    case "enum":
      return { type: ["string", "null"], enum: [...(f.values ?? []), null] };
    case "multi":
      return { type: ["array", "null"], items: { type: "string", minLength: 1, maxLength: LABEL_MULTI_ITEM_MAX }, maxItems: f.maxValues ?? LABEL_MULTI_DEFAULT_MAX };
    case "bool":
      return { type: ["boolean", "null"] };
    case "text":
      return { type: ["string", "null"], maxLength: LABEL_TEXT_MAX };
  }
}

/** label job: one object per target with values for every field of every requested pack, plus a short reason. */
export function labelOutputSchema(packs: readonly PackDef[]): JsonSchema {
  const fieldProps: Record<string, JsonSchema> = {};
  for (const p of packs) {
    for (const f of p.fields) {
      fieldProps[fieldKey(p.id, f.key)] = {
        type: "object",
        properties: { value: fieldValueSchema(f), state: { type: "string", enum: ["set", "refused", "unanswered"] }, confidence },
        required: ["value", "state"],
        additionalProperties: false,
      };
    }
  }
  return {
    type: "object",
    properties: {
      items: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          properties: {
            target: { type: "string", pattern: LABEL_TARGET_PATTERN },
            fields: { type: "object", properties: fieldProps, additionalProperties: false },
            /** One line shown behind "Why?" on the Checks card (M5). */
            reason,
          },
          required: ["target", "fields"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  };
}

/** The summary as a frond (ORIG-05): one sentence, facets, parts with their notes. */
export const GIST_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 3, maxLength: 120 },
    gist: { type: "string", minLength: 10, maxLength: GIST_MAX },
    facets: {
      type: "object",
      properties: {
        work: { type: ["string", "null"], enum: ["debug", "build", "research", "write", "set up", "plan", null] },
        outcome: { type: ["string", "null"], enum: ["shipped", "partly done", "abandoned", "blocked", "still open", null] },
        topics: { type: "array", items: { type: "string", minLength: 1, maxLength: LABEL_MULTI_ITEM_MAX }, maxItems: 5 },
      },
      required: ["topics"],
      additionalProperties: false,
    },
    parts: {
      type: "array",
      minItems: 1,
      maxItems: MAX_PARTS,
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 120 },
          firstId: { type: "string", pattern: ENTRY_ID_PATTERN },
          lastId: { type: "string", pattern: ENTRY_ID_PATTERN },
          notes: {
            type: "array",
            maxItems: MAX_NOTES_PER_PART,
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: [...ATOMIC_KINDS] },
                text: { type: "string", minLength: 3, maxLength: 400 },
                cites: { type: "array", items: cite(ENTRY_ID_PATTERN), minItems: 1, maxItems: MAX_CITES },
              },
              required: ["kind", "text", "cites"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "firstId", "lastId", "notes"],
        additionalProperties: false,
      },
    },
    addressedComments: addressed,
    confidence,
    reason,
  },
  required: ["title", "gist", "facets", "parts", "addressedComments"],
  additionalProperties: false,
};

/** Every typed section key a map may carry (the validator keeps only those its map type allows). */
export const HUB_SECTION_ALL: readonly HubSectionKey[] = [...new Set(Object.values(HUB_SECTION_KEYS).flat())];

/** Optional typed sections of a map (SPEC V13): project maps next steps, open questions, key decisions; area maps what it is, where it stands; topic maps what was found. */
const HUB_SECTIONS_SCHEMA: JsonSchema = {
  type: "object",
  properties: Object.fromEntries(HUB_SECTION_ALL.map((k) => [k, statement(MAX_SECTION, 400)])),
  additionalProperties: false,
};

/** A map's brief (ORIG-06): 3–5 cited bullets, plus the typed sections of its map type. */
export const HUB_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    title: { type: "string", minLength: 3, maxLength: 120 },
    brief: { ...statement(MAX_BRIEF, 400), minItems: MIN_BRIEF },
    sections: HUB_SECTIONS_SCHEMA,
    addressedComments: addressed,
    confidence,
    reason,
  },
  required: ["title", "brief", "addressedComments"],
  additionalProperties: false,
};

/** Areas a filing suggestion may name (never "none": the items already have no area). */
export const FILING_AREAS: readonly string[] = SPACES.map((s) => s.id);

export const FILING_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    proposals: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        properties: {
          target: { type: "string", pattern: FILING_TARGET_PATTERN },
          area: { type: "string", enum: [...FILING_AREAS] },
          folder: { type: "string", minLength: 1, maxLength: 200 },
          project: { type: ["string", "null"], maxLength: LABEL_TEXT_MAX },
          confidence,
          reason,
        },
        required: ["target", "area", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["proposals"],
  additionalProperties: false,
};

export const NAME_CHECK_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: { mentions: { type: "array", maxItems: 500, items: cite(ENTRY_ID_PATTERN) } },
  required: ["mentions"],
  additionalProperties: false,
};

/** What Ask's model must return (passed to --json-schema): reply, citations and at most 8 registry calls. */
export const ANSWER_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    reply: { type: "string", minLength: 1, maxLength: 4000 },
    citations: { type: "array", items: cite(), maxItems: 20 },
    actions: { type: "array", items: ACTION_CALL_SCHEMA, maxItems: MAX_ACTIONS_PER_REPLY },
    /** Optional stated reason per action, shown labelled as the AI's words. */
    reasons: { type: "array", items: { type: ["string", "null"], maxLength: 200 }, maxItems: MAX_ACTIONS_PER_REPLY },
  },
  required: ["reply", "citations", "actions"],
  additionalProperties: false,
};

/**
 * The outer shape Ask's reply is validated against first: actions are checked ONE BY ONE afterwards (each against
 * the registry's closed schema), so one malformed or extra action is declined on its own instead of discarding
 * the whole reply.
 */
export const ANSWER_SHAPE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    reply: { type: "string", maxLength: 4000 },
    citations: { type: "array", items: cite(), maxItems: 20 },
    actions: { type: "array", maxItems: 32, items: { type: "object" } },
    reasons: { type: "array", maxItems: 32, items: { type: ["string", "null"] } },
  },
  required: ["reply", "citations", "actions"],
  additionalProperties: false,
};
