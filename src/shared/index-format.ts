/**
 * The in-memory/columnar "DataIndex" shared by the main thread (UI, renderer), the layout worker and the
 * runner (which builds it). FROZEN CONTRACT (owner: architect).
 *
 * Every item (record entry or note) gets an ordinal. Ordinals are allocated in ARRIVAL order from a persisted
 * id → ordinal table in the cache (`<cache>/ordinals.cxo`, shared by the runner's record builder and the
 * plugin's vault builder under the cache lock `cache:ordinals`), so rebuilds keep every existing ordinal and
 * append new ids. Ordinals are stable for the lifetime of an EPOCH; the epoch changes only on `index --full`
 * or when the table is lost. Ordinal = point index in the renderer = picking id - 1. An id that disappears
 * keeps its ordinal (flagged Excluded) until the next epoch.
 *
 * Binary file layout (cache/<vaultKey>/record.cxi and vault.cxi), little-endian:
 *   [0..4)   magic "CXI1"
 *   [4..8)   u32 header byte length H
 *   [8..8+H) header JSON (UTF-8), see IndexHeader
 *   padding to an 8-byte boundary, then blobs at the offsets named in the header (each 8-byte aligned).
 * Pure module: no DOM, no Node.
 */
import type { HubStatus, HubType, IsoDate, NoteKind, SourceKind, Speaker, SpaceId } from "./types";

export const INDEX_MAGIC = "CXI1";
export const INDEX_VERSION = 2;
/** "No value" for u32 columns. */
export const NONE32 = 0xffffffff;
/** "No value" for u16 columns. */
export const NONE16 = 0xffff;
/** "No value" for u8 columns. */
export const NONE8 = 0xff;

/** Item kinds (u8). Values are persisted: never renumber. */
export const ItemKind = {
  RecordMessage: 0,
  RecordDocument: 1,
  RecordPassage: 2,
  RecordFile: 3,
  NoteWiki: 10,
  NoteAtomic: 11,
  NoteGist: 12,
  NoteHub: 13,
} as const;
export type ItemKindValue = (typeof ItemKind)[keyof typeof ItemKind];

/** Population (u8): which part of the figure an item lives in. */
export const Population = { Note: 0, Record: 1 } as const;
export type PopulationValue = (typeof Population)[keyof typeof Population];

/** Bit flags (u32). Values are persisted: never renumber. */
export const ItemFlag = {
  Undated: 1 << 0,
  Excluded: 1 << 1,
  /**
   * Reference material, hidden by default: vault notes with `status: reference` AND documents under
   * `sources.raw.referenceFolders` (the Roblox creator docs). Never an agent target while hidden (H3, H11).
   */
  Reference: 1 << 2,
  /** Subagent / harness / tool / Ask-history / automated traffic: hidden unless the matching Layers toggle is on. */
  HiddenByDefault: 1 << 3,
  Subagent: 1 << 4,
  AssistantPane: 1 << 5,
  HasLabels: 1 << 6,
  Corrected: 1 << 7,
  Stale: 1 << 8,
  /** Note with zero valid citations ("Drawn from 0 entries"). */
  Sourceless: 1 << 9,
  /** Pinned by the user (pin/unpin corrections folded at load and on every change). */
  Pinned: 1 << 10,
  /** No area (SpaceId "none"). */
  NoArea: 1 << 11,
  Superseded: 1 << 12,
  Harness: 1 << 13,
  /** Machine-written (note, map, gist, model-titled). */
  MachineWritten: 1 << 14,
  /** Automated (sdk-prompt) session with no message typed by you: Layers › Automated sessions. */
  Automated: 1 << 15,
  /** Text staged in the local cache (live session not yet sealed into a segment): this computer only. */
  Live: 1 << 16,
} as const;

/** Enum orders used by u8 columns. Index in these arrays = stored value. Persisted: append only. */
export const SOURCE_ORDER: readonly SourceKind[] = [
  "claude-code",
  "claude-ai",
  "chatgpt",
  "gemini",
  "obsidian",
  "files",
  "written",
  "cortex-ask",
  "notion",
  "google-docs",
  "codex-cli",
  "gemini-cli",
  "cursor",
  "whatsapp",
  "telegram",
  "discord",
  "slack",
  "keep",
  "evernote",
  "roam",
  "kindle",
  "zoom",
  "outcome",
  "capture",
];
export const SPEAKER_ORDER: readonly Speaker[] = ["you", "assistant", "other", "tool"];
export const SPACE_ORDER: readonly SpaceId[] = [
  "code",
  "web",
  "data",
  "ai",
  "roblox",
  "games",
  "money",
  "design",
  "life",
  "vault",
  "none",
];
/** noteKind column values (NONE8 for record entries). Persisted: append only. */
export const NOTE_KIND_ORDER: readonly NoteKind[] = ["gist", "question", "decision", "idea", "plan", "abandoned", "concept", "wiki", "hub", "reference", "log"];
/** hubType column values (NONE8 when not a map). */
export const HUB_TYPE_ORDER: readonly HubType[] = ["project", "area", "topic"];
/** hubStatus column values (NONE8 when not a map). */
export const HUB_STATUS_ORDER: readonly HubStatus[] = ["active", "quiet", "paused"];

export type ColumnType = "u8" | "u16" | "u32" | "f32" | "f64";

/** Per-item numeric columns. Every column has exactly `count` elements. */
export interface IndexColumns {
  kind: Uint8Array;
  pop: Uint8Array;
  source: Uint8Array;
  speaker: Uint8Array;
  space: Uint8Array;
  /** Folder dictionary id (see IndexDicts.folders); NONE32 = no folder. */
  folder: Uint32Array;
  /** Conversation table row; NONE32 = not in a conversation. */
  conv: Uint32Array;
  /** Position inside the conversation; NONE32 when not applicable. */
  idx: Uint32Array;
  /** writtenAt as epoch ms; NaN when undated. */
  t: Float64Array;
  /** addedAt as epoch ms. */
  tAdded: Float64Array;
  chars: Uint32Array;
  flags: Uint32Array;
  /** Vault BFS layer 0..8 for wiki notes; NONE8 otherwise. */
  layer: Uint8Array;
  /** Parent note ordinal (decision → gist → hub); NONE32 when none. */
  parent: Uint32Array;
  /** Project dictionary id; NONE32 when none. */
  project: Uint32Array;
  /** NOTE_KIND_ORDER index (decision, question, idea …); NONE8 for record entries (H7). */
  noteKind: Uint8Array;
  /** HUB_TYPE_ORDER index for maps; NONE8 otherwise. */
  hubType: Uint8Array;
  /** HUB_STATUS_ORDER index for maps; NONE8 otherwise. */
  hubStatus: Uint8Array;
  /** Word count of the current version (Size: Words, the Data view's Words measure). */
  words: Uint32Array;
}

export type ColumnName = keyof IndexColumns;

export const COLUMN_TYPES: { readonly [K in ColumnName]: ColumnType } = {
  kind: "u8",
  pop: "u8",
  source: "u8",
  speaker: "u8",
  space: "u8",
  folder: "u32",
  conv: "u32",
  idx: "u32",
  t: "f64",
  tAdded: "f64",
  chars: "u32",
  flags: "u32",
  layer: "u8",
  parent: "u32",
  project: "u32",
  noteKind: "u8",
  hubType: "u8",
  hubStatus: "u8",
  words: "u32",
};

/** Compressed sparse rows: row i owns targets[offsets[i] .. offsets[i+1]). */
export interface Csr {
  offsets: Uint32Array;
  targets: Uint32Array;
}

/** A string table stored as UTF-8 bytes plus offsets (n+1). */
export interface StringTableData {
  offsets: Uint32Array;
  bytes: Uint8Array;
}

/** Lazily decoded string table. */
export interface StringTable {
  readonly size: number;
  get(i: number): string;
}

export interface ConversationRow {
  id: string;
  title: string;
  source: SourceKind;
  startedAt: number;
  endedAt: number;
  entryCount: number;
  space: SpaceId;
  /** Ordinal of the gist note, NONE32 when none. */
  gist: number;
}

export interface LabelColumn {
  pack: string;
  packVersion: string;
  field: string;
  type: "enum" | "multi" | "bool" | "text";
  /** Value dictionary; stored values index into it. */
  values: string[];
  /** enum/bool/text: one u16 per item (NONE16 = no label). multi: undefined. */
  single?: Uint16Array;
  /** multi: CSR of value ids per item. */
  multi?: Csr;
  /** Per item: 1 when the current value comes from a user correction. */
  byUser: Uint8Array;
}

export interface IndexDicts {
  folders: StringTable;
  projects: StringTable;
}

export interface IndexRelations {
  /** note → cited entry ordinals. */
  noteSources: Csr;
  /** hub → member note ordinals. */
  hubMembers: Csr;
  /** note → linked note ordinals (vault wikilinks + `related`), undirected edges stored once per direction. */
  noteLinks: Csr;
}

export interface IndexStats {
  notes: number;
  record: number;
  undated: number;
  conversations: number;
  firstT: number;
  lastT: number;
  bySource: Partial<Record<SourceKind, number>>;
}

export interface ColumnDesc {
  name: string;
  type: ColumnType;
  offset: number;
  length: number;
}

export interface IndexHeader {
  magic: typeof INDEX_MAGIC;
  version: typeof INDEX_VERSION;
  /** "record": built by the runner from ledgers; "vault": built by the plugin from metadataCache. */
  part: "record" | "vault" | "merged";
  builtAt: IsoDate;
  /** Ledger sequence the index reflects (monotonic per vault). */
  seq: number;
  /** Ordinal epoch (INDEX-DELTA-CONTRACT): ordinals are stable while the epoch is unchanged. */
  epoch: string;
  /** Items covered by the base file; deltas append [baseCount, count). */
  baseCount: number;
  count: number;
  blobs: ColumnDesc[];
  conversations: number;
  labels: { pack: string; packVersion: string; field: string; type: LabelColumn["type"]; values: string[] }[];
  stats: IndexStats;
}

/** The loaded, queryable index. Implemented by shared/indexCodec.ts (owner E7). */
export interface DataIndex {
  readonly header: IndexHeader;
  readonly count: number;
  readonly cols: IndexColumns;
  readonly ids: StringTable;
  readonly titles: StringTable;
  readonly dicts: IndexDicts;
  readonly convs: { readonly size: number; get(row: number): ConversationRow; rowOf(id: string): number };
  readonly rel: IndexRelations;
  readonly labels: readonly LabelColumn[];
  /** -1 when the id is not in this index. */
  ordinalOf(id: string): number;
}

/**
 * Delta for live arrivals: items [fromCount, count) appended after the loaded index, written by the runner as
 * `<cache>/record.delta.cxi`. Rejected (full reload) when its epoch differs from the loaded one.
 */
export interface IndexDelta {
  epoch: string;
  fromCount: number;
  buffer: ArrayBuffer;
}

/** In-place update of existing rows (labels, flags) without re-placing any point (`patchIndex`). */
export interface IndexPatch {
  epoch: string;
  ordinals: Uint32Array;
  /** New flags per listed ordinal. */
  flags?: Uint32Array;
  /** Label column updates: column index → one u16 value per listed ordinal (enum/bool/text). */
  labels?: { column: number; values: Uint16Array; byUser: Uint8Array }[];
}
