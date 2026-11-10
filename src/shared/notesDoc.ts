/**
 * Content of machine-written notes after validation, before rendering to markdown. FROZEN CONTRACT
 * (owner: architect). Produced by agents/validators.ts (E6) from model JSON; rendered by store/notesWriter.ts
 * (E2); read back by the readers (E12) through RecordReader.note()/conversation() (plugin/services.ts).
 *
 * Shapes follow CORTEX-UX §5.15–5.16:
 *  - a conversation summary is a FROND: one gist sentence, machine facets, and a timeline of parts (time range +
 *    message span), each part carrying the notes extracted from it;
 *  - a map (code: hub) is an INDEX: a brief of 3–5 cited bullets over member notes grouped by kind.
 * Every string here is model text and is made inert (shared/mdSafe.ts) before it reaches a markdown file.
 */
import type { Citation, ConversationId, CorrectionId, HubSectionKey, HubStatus, HubType, IsoDate, MadeBy, NoteId, SpaceId } from "./types";

export type AtomicKind = "question" | "decision" | "idea" | "plan" | "abandoned" | "concept";
export const ATOMIC_KINDS: readonly AtomicKind[] = ["decision", "question", "idea", "plan", "abandoned", "concept"];

export interface AtomicNoteDoc {
  id: NoteId;
  kind: AtomicKind;
  text: string;
  /** Block id inside the gist file, e.g. "n-4f2a". */
  blockId: string;
  cites: Citation[];
}

/** One node of the frond: a conversation part with its time range and message span. */
export interface GistPartDoc {
  n: number;
  title: string;
  startedAt?: IsoDate;
  endedAt?: IsoDate;
  /** 1-based message span within the conversation. */
  msgFrom: number;
  msgTo: number;
  notes: AtomicNoteDoc[];
}

/** Machine facets (session pack values) shown once as dashed chips and written to cortex_* frontmatter. */
export interface GistFacets {
  work?: string;
  outcome?: string;
  project?: string;
  topics: string[];
}

export interface GistDoc {
  id: NoteId;
  conv: ConversationId;
  title: string;
  space: SpaceId;
  date?: IsoDate;
  madeBy: Extract<MadeBy, { runId: string }>;
  /** One sentence (≤ 300 characters): the sheet subtitle under the dotted machine rule. */
  gist: string;
  facets: GistFacets;
  parts: GistPartDoc[];
  /** Open comments on this summary or its notes that this run answered (M7). */
  addressedComments: CorrectionId[];
}

export interface HubStatementDoc {
  text: string;
  cites: Citation[];
}

export interface HubDoc {
  id: NoteId;
  hubType: HubType;
  status: HubStatus;
  title: string;
  space: SpaceId;
  range: [IsoDate, IsoDate];
  within?: NoteId;
  members: NoteId[];
  madeBy: Extract<MadeBy, { runId: string }>;
  /** 3–5 bullets; each must cite at least one passage. */
  brief: HubStatementDoc[];
  /** Typed sections (next steps, open questions…), each statement citing passages like a brief bullet. */
  sections?: Partial<Record<HubSectionKey, HubStatementDoc[]>>;
  addressedComments: CorrectionId[];
}

/**
 * Frontmatter keys Cortex writes and OWNS (all free in this vault; never the taken keys such as type/tags/status).
 * Other keys found in a derived note (e.g. `layer` stamped by the vault's own scripts) are preserved on rewrite
 * and never count as a user edit (DERIVED-NOTE-SHA).
 */
export const CORTEX_FRONTMATTER_KEYS = [
  "cortex_id",
  "cortex_kind",
  "cortex_map_kind",
  "cortex_status",
  "cortex_sources",
  "cortex_work",
  "cortex_outcome",
  "cortex_project",
  "cortex_topics",
  "cortex_range",
  "cortex_run",
  "cortex_state",
  "made_by",
  "conversation",
  "space",
] as const;
export type CortexFrontmatterKey = (typeof CORTEX_FRONTMATTER_KEYS)[number];
