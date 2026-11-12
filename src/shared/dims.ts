/**
 * Dimensions used by colouring, grouping, charts and the Data view. FROZEN CONTRACT (owner: architect).
 *
 * The dimension menu is grouped by PROVENANCE, Cortex's own organising idea (CORTEX-UX §7.3, §12.5):
 *   Date ▸                 ONE date dimension: a granularity sub-menu (Day, Week, Month, Year; Rhythm ▸ Hour,
 *                          Weekday) with a Written · Imported switch at its foot (the basis);
 *   From the file          Area, Folder, Folder path, Layer;
 *   From the conversation  Source, Project, Conversation, Speaker;
 *   From the agents        Kind, Map and every enabled model-written pack field (dashed icon);
 *   From you               Your labels, Your fixes (solid icon);
 * and a final "All fields…" item that opens a searchable list with each field's source and coverage. Display
 * strings live in src/ui/copy.ts (dims.*, dimGroups.*). Remainders take their own names (CORTEX-UX §4.4):
 * folded groups → "Other" (mist), missing values → No area, Undated, No project, No kind, No map (slate).
 * "Note or record" (layer2) is a File dimension: it splits the figure into the two populations (the brain and the
 * spine), so a chart can compare vault notes with your record entries. "Your fixes" is the per-entry correction kind
 * (the correction pack's `fixes`). "Your résumé" is a menu section of its own holding the Résumé item dimension (the
 * model-written resume pack's `item`; every item reads "No value" until the agents have filled some).
 */

import type { PackDef } from "./types";

/** Granularity of the one date dimension. */
export type DateGrain = "day" | "week" | "month" | "year" | "hour" | "weekday" | "monthOfYear";
/** Which date: when it was written (evidence-backed) or when Cortex imported it. */
export type DateBasis = "written" | "imported";
/** "week" = written; "week:imported" = imported. Rhythm grains (hour, weekday) always use the written date. */
export type DateDim = DateGrain | `${"day" | "week" | "month" | "year"}:imported`;
/** Area is the vault's own area map ("space" in code; one area dimension, §12.5). */
export type FileDim = "space" | "folder" | "folderPath" | "layer" | "layer2" | "filing" | "recency";
export type ConversationDim = "source" | "project" | "conversation" | "speaker";
/** Machine-made dimensions: note kind and the map a note belongs to. */
export type AgentDim = "kind" | "map" | "hubStatus" | "hubType";
/** Your own decisions: labels you set on any field, and the correction pack's "Your fixes". */
export type YouDim = "yourLabels" | "yourFixes";
/** A label-pack field: "label:<pack>/<field>", e.g. "label:session/work". */
export type LabelDim = `label:${string}/${string}`;
/** The makers behind a node (Agents > Influence): "maker:notes" or "maker:record"; a token's value is a set of makers ("you+app:claude-code") or "has:<maker>". */
export type MakerDim = `maker:${"notes" | "record"}`;
export type DimId = DateDim | FileDim | ConversationDim | AgentDim | YouDim | LabelDim | MakerDim;

/** Menu sections (ids; display text in copy.ts). "date" is the single Date ▸ item above the sections. */
export type DimGroup = "date" | "file" | "conversation" | "agents" | "you" | "resume";
export const DIM_GROUP_ORDER: readonly DimGroup[] = ["date", "file", "conversation", "agents", "you", "resume"];

/** Filing: an item is filed once it sits in an area (every area but "No area"). Value keys, in order. */
export const FILING_VALUES = ["filed", "unfiled"] as const;
export type FilingValue = (typeof FILING_VALUES)[number];

/** Recency: how long before your newest entry an item was written. Value keys, in order. */
export const RECENCY_VALUES = ["active", "cooling", "dormant"] as const;
export type RecencyValue = (typeof RECENCY_VALUES)[number];
/** The Read thresholds (Read's Maps menu, a map's status): active within 30 days of your newest entry, cooling to 120 days, dormant beyond. */
export const RECENCY_ACTIVE_DAYS = 30;
export const RECENCY_COOLING_DAYS = 120;

/** The recency of something written `days` days before your newest entry (the one rule Read and the Recency dimension share). */
export function recencyOfDays(days: number): RecencyValue {
  return days <= RECENCY_ACTIVE_DAYS ? "active" : days <= RECENCY_COOLING_DAYS ? "cooling" : "dormant";
}

/** Entries a value of a label grouping needs before the grouping reads well (the richness hint's target, SPEC grouping-hints). */
export const RICHNESS_TARGET = 100;

/** A grouping by something a model or the person wrote (a label field, Your labels, Your fixes), as opposed to a date, folder or area. */
export function isLabelBased(dim: DimId): boolean {
  return isLabelDim(dim) || dim === "yourLabels" || dim === "yourFixes";
}

/** The résumé-item dimension: the model-written `resume` pack's `item` field. Always offered; without values every item reads "No value". */
export const RESUME_DIM = "label:resume/item" as const satisfies LabelDim;
/** The placement pack's role field: grouping by it takes the comet form (Groups shape, bubbles layout). */
export const ROLE_DIM = "label:placement/role" as const satisfies LabelDim;

/** Layouts of the Groups shape (CORTEX-UX §6.12). Role placement is Placement › By role, not a layout. */
export type GroupLayout = "bubbles" | "tree" | "spine" | "strata" | "wheel" | "grid";
export const GROUP_LAYOUTS: readonly GroupLayout[] = ["bubbles", "tree", "spine", "strata", "wheel", "grid"];

/** Per-layout options of the Groups shape. */
export interface LayoutOptions {
  /** Month grid: each cell is a sphere, or a few short horizontal dash rows that keep the row colours. */
  gridMarks: "spheres" | "rows";
}
export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = { gridMarks: "spheres" };

/** Remainder names (copy keys under values.*). */
export type NoneName = "noStatus" | "noArea" | "undated" | "noProject" | "noKind" | "noMap" | "noFolder" | "noLayer" | "noSource" | "noSpeaker" | "noConversation" | "noLabel" | "noValue" | "noFunction";

export interface DimDef {
  id: DimId;
  group: DimGroup;
  /** Copy key of the bucket for items without a value. */
  none: NoneName;
  /** Values have an intrinsic order (time, layer) rather than count order. */
  ordered: boolean;
  /** Hierarchical (folder paths): key rows and the key popover show a tree. */
  hierarchical?: boolean;
  layouts: readonly GroupLayout[];
  appliesTo: "notes" | "record" | "both";
}

export const DATE_GRAINS: readonly ("day" | "week" | "month" | "year")[] = ["day", "week", "month", "year"];
export const RHYTHM_GRAINS: readonly ("hour" | "weekday" | "monthOfYear")[] = ["hour", "weekday", "monthOfYear"];
export const DATE_BASES: readonly DateBasis[] = ["written", "imported"];

/** Rhythm grains read the written date only and fold every year onto one cycle (hour, weekday, month of the year). */
export function isRhythmGrain(g: DateGrain): g is "hour" | "weekday" | "monthOfYear" {
  return g === "hour" || g === "weekday" || g === "monthOfYear";
}

/** Every date dimension offers the wheel; the grid fits months (a year per row) and the month of the year (one row). */
const dateDef = (id: DateDim): DimDef => ({
  id,
  group: "date",
  none: "undated",
  ordered: true,
  layouts: id === "month" || id === "month:imported" || id === "monthOfYear" ? ["bubbles", "spine", "wheel", "grid"] : ["bubbles", "spine", "wheel"],
  appliesTo: "both",
});

export const BUILTIN_DIMS: readonly DimDef[] = [
  ...DATE_GRAINS.map((g) => dateDef(g)),
  ...RHYTHM_GRAINS.map((g) => dateDef(g)),
  ...DATE_GRAINS.map((g) => dateDef(`${g}:imported`)),
  { id: "space", group: "file", none: "noArea", ordered: true, layouts: ["bubbles", "spine", "strata"], appliesTo: "both" },
  { id: "folder", group: "file", none: "noFolder", ordered: false, layouts: ["bubbles", "tree", "strata"], appliesTo: "both" },
  { id: "folderPath", group: "file", none: "noFolder", ordered: false, hierarchical: true, layouts: ["tree", "bubbles"], appliesTo: "both" },
  { id: "layer", group: "file", none: "noLayer", ordered: true, layouts: ["bubbles", "strata"], appliesTo: "notes" },
  { id: "layer2", group: "file", none: "noLayer", ordered: true, layouts: ["bubbles", "strata"], appliesTo: "both" },
  { id: "filing", group: "file", none: "noValue", ordered: true, layouts: ["bubbles", "strata"], appliesTo: "both" },
  { id: "recency", group: "file", none: "undated", ordered: true, layouts: ["bubbles", "strata"], appliesTo: "both" },
  { id: "source", group: "conversation", none: "noSource", ordered: true, layouts: ["bubbles", "spine", "strata"], appliesTo: "both" },
  { id: "project", group: "conversation", none: "noProject", ordered: false, layouts: ["bubbles", "spine", "strata"], appliesTo: "both" },
  { id: "conversation", group: "conversation", none: "noConversation", ordered: false, layouts: ["bubbles", "spine"], appliesTo: "record" },
  { id: "speaker", group: "conversation", none: "noSpeaker", ordered: true, layouts: ["bubbles", "spine", "strata"], appliesTo: "record" },
  { id: "kind", group: "agents", none: "noKind", ordered: true, layouts: ["bubbles", "strata"], appliesTo: "both" },
  { id: "map", group: "agents", none: "noMap", ordered: false, layouts: ["bubbles", "strata"], appliesTo: "notes" },
  { id: "hubStatus", group: "agents", none: "noStatus", ordered: true, layouts: ["bubbles", "strata"], appliesTo: "notes" },
  { id: "hubType", group: "agents", none: "noMap", ordered: true, layouts: ["bubbles", "strata"], appliesTo: "notes" },
  { id: "yourLabels", group: "you", none: "noLabel", ordered: false, layouts: ["bubbles", "strata"], appliesTo: "both" },
  { id: "yourFixes", group: "you", none: "noLabel", ordered: false, layouts: ["bubbles", "strata"], appliesTo: "both" },
];

/**
 * The dimensions that can group record entries (the Record by select): `shared` fields the notes have too, and
 * `recordOnly` fields that exist only for entries and conversations (speaker, conversation, and label-pack fields
 * whose pack applies to entries or conversations but not to notes). Pass the packs to include (enabled model packs
 * plus the user's own); label dimensions follow the built-in ones.
 */
export function recordDims(packs: readonly PackDef[] = []): { shared: DimId[]; recordOnly: DimId[] } {
  const shared: DimId[] = BUILTIN_DIMS.filter((d) => d.appliesTo === "both").map((d) => d.id);
  const recordOnly: DimId[] = BUILTIN_DIMS.filter((d) => d.appliesTo === "record").map((d) => d.id);
  for (const p of packs) {
    const onRecord = p.appliesTo.includes("entry") || p.appliesTo.includes("conversation");
    if (!onRecord) continue;
    const list = p.appliesTo.includes("note") ? shared : recordOnly;
    for (const f of p.fields) list.push(labelDim(p.id, f.key));
  }
  return { shared, recordOnly };
}

/** The date dimension for a grain and basis (rhythm grains always use the written date). */
export function dateDim(grain: DateGrain, basis: DateBasis): DateDim {
  if (basis === "imported" && !isRhythmGrain(grain)) return `${grain}:imported`;
  return grain;
}

export function parseDateDim(d: DimId): { grain: DateGrain; basis: DateBasis } | null {
  if (!isDateDim(d)) return null;
  const [grain, basis] = d.split(":") as [DateGrain, string | undefined];
  return { grain, basis: basis === "imported" ? "imported" : "written" };
}

export function isDateDim(d: DimId): d is DateDim {
  return builtinDim(d)?.group === "date";
}

export function isLabelDim(d: DimId): d is LabelDim {
  return d.startsWith("label:");
}

export function labelDim(pack: string, field: string): LabelDim {
  return `label:${pack}/${field}`;
}

export function parseLabelDim(d: LabelDim): { pack: string; field: string } {
  const body = d.slice("label:".length);
  const slash = body.indexOf("/");
  return { pack: body.slice(0, slash), field: body.slice(slash + 1) };
}

export function builtinDim(id: DimId): DimDef | undefined {
  return BUILTIN_DIMS.find((d) => d.id === id);
}

/** Copy key (under dims.*) of the bucket for items without a value in `dim`: the résumé item says "No value", other label fields "No label". */
export function noneNameOf(dim: DimId): NoneName | undefined {
  const b = builtinDim(dim);
  if (b) return b.none;
  if (dim === RESUME_DIM) return "noValue";
  if (dim === ROLE_DIM) return "noFunction";
  return isLabelDim(dim) ? "noLabel" : undefined;
}

/** When one dimension would land on two chart zones, the other zone takes the next one (Area → Folder → Month). */
export const AXIS_FALLBACK_ORDER: readonly DimId[] = ["space", "folder", "month", "source", "speaker"];
