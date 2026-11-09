/**
 * Ask's action registry (CORTEX-UX §5.10, §12.7). FROZEN CONTRACT (owner: architect). This file is the source of
 * truth for the action vocabulary; the UX table mirrors it, and new verbs are added only by RFC with closed
 * schemas.
 *
 * The model never touches files: it returns `ActionCall` objects as JSON data inside `{ reply, citations[],
 * actions[] }`. The runner validates them against these schemas; the plugin re-validates (validateActionCall),
 * checks semantics (ids exist, dims known, ranges sane, at most MAX_ITEMS_PER_ACTION targets, the slash
 * command's `onlyVerb`), asks for Apply per the flags below, executes through its own services, writes the
 * change text itself from validated parameters and resolved targets (never from model text; a model `reason` is
 * stored separately and shown labelled), and logs data changes as CorrectionRecords.
 *
 * Flags (SAFE-04):
 *  - changesData: include, exclude, set_label, set_speaker, set_date, refile, merge_groups, correct_entry wait for
 *    Apply unless Settings › Agents › "Apply Ask's changes without asking" is on;
 *  - alwaysConfirm: include (it can re-admit material left out for privacy) and correct_entry (new wording) wait
 *    for Apply even when that setting is on;
 *  - spendsBudget: refresh and propose_filing always show an Apply card with Cortex's own estimate (stricter than
 *    the UX table, see ARCHITECTURE §20); `refresh` takes only a selection or a period, at most 200 items.
 * Undo of a data change never expires.
 */
import type { JsonSchema } from "./validate";
import type { DimId, GroupLayout } from "./dims";
import type { IsoDate, LabelValue, Speaker } from "./types";
import { CHART_IDS, PAGE_IDS, ROUTE_VIEWS, SHEET_ROUTES, type ChartId, type PageId, type SheetRoute } from "./views";
import { GROUP_LAYOUTS } from "./dims";

/** One reply may carry at most this many actions. */
export const MAX_ACTIONS_PER_REPLY = 8;
/** A single data-changing action may touch at most this many items ("Too broad" otherwise). */
export const MAX_ITEMS_PER_ACTION = 500;
/** `refresh` may queue at most this many items. */
export const MAX_REFRESH_ITEMS = 200;

export interface ActionParamsMap {
  /** Trace matches; adds a token. Undo: removes the token. */
  trace: { query?: string; ids?: string[]; filters?: { dim: DimId; value: string }[] };
  /** Set the period for every view of this leaf. Undo: previous period. */
  set_period: { start: IsoDate; end: IsoDate };
  /** Open a page or reader (navigation only). Undo: Back. */
  open_view: { view: PageId | SheetRoute; tab?: string; id?: string };
  /** Groups shape by a dimension. Undo: previous shape. */
  arrange: { by: DimId; layout?: GroupLayout };
  /** Build a chart. Undo: previous view. */
  make_chart: { chart: ChartId; x?: DimId; y?: DimId; colour?: DimId; size?: "entries" | "words"; filter?: { dim: DimId; value: string } };
  /** New version of an entry's wording; the first wording stays in History. Undo: restores the previous version. */
  correct_entry: { entryId: string; newText: string; reason?: string };
  /** Your date overrides the evidence. Undo: removes the override. */
  set_date: { target: string; date: IsoDate | null };
  /** Your speaker overrides. Undo: removes the override. */
  set_speaker: { target: string; speaker: Speaker };
  /** Your label (≤ 500 targets), which models must keep. Undo: removes your labels. */
  set_label: { targets: string[]; pack: string; field: string; value: LabelValue };
  /** Display mapping of one group into another; nothing moves on disk. Undo: deletes the mapping. */
  merge_groups: { dim: DimId; from: string; into: string };
  /** Display filing override. Undo: removes the override. */
  refile: { target: string; area?: string; folder?: string; project?: string | null };
  /** Leave out an entry, conversation or source (nothing is deleted, §5.30.4). Undo: brings it back exactly. */
  exclude: { target: string; scope: "entry" | "conversation" | "source" };
  /** Bring back something left out. Undo: leaves it out again. Always waits for Apply. */
  include: { target: string };
  /** Queue agent jobs for a selection or a period (≤ 200 items; Apply card with Cortex's estimate). Undo: cancels jobs not yet run. */
  refresh: { scope: "selection" | "period"; period?: [IsoDate, IsoDate] };
  /** Create filing checks (Apply card with Cortex's estimate). Undo: discards the checks. */
  propose_filing: { scope: "no-area" | "selection" };
  /** Pin an item or view so it appears under Read › Pinned only. Undo: unpins. */
  pin: { target: string };
}

export type ActionName = keyof ActionParamsMap;

export type ActionCall = { [K in ActionName]: { action: K; params: ActionParamsMap[K] } }[ActionName];

export type UndoKind = "remove-token" | "restore-view" | "back" | "correction" | "cancel-jobs" | "discard-checks";

export interface ActionSpec {
  name: ActionName;
  /** Changes the record's data (logged as a fix); waits for Apply unless the setting says otherwise. */
  changesData: boolean;
  /** Waits for Apply even when "Apply Ask's changes without asking" is on. */
  alwaysConfirm: boolean;
  /** Spends tokens: always an Apply card with Cortex's own estimate. */
  spendsBudget: boolean;
  undo: UndoKind;
  /** Shown to the model in the system prompt. */
  description: string;
  params: JsonSchema;
}

const str = (maxLength = 400): JsonSchema => ({ type: "string", minLength: 1, maxLength });
const isoDate: JsonSchema = { type: "string", minLength: 4, maxLength: 40, pattern: "^\\d{4}-\\d{2}-\\d{2}" };
const isoPair: JsonSchema = { type: "array", items: isoDate, minItems: 2, maxItems: 2 };
const id: JsonSchema = { type: "string", pattern: "^[cenwv]_[a-z2-7]{16}$" };
const dim: JsonSchema = { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Za-z]+$|^label:[a-z0-9-]+/[A-Za-z0-9_-]+$" };
const dimValue: JsonSchema = {
  type: "object",
  properties: { dim, value: str(200) },
  required: ["dim", "value"],
  additionalProperties: false,
};
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const ROUTE_TABS = [...new Set(Object.values(ROUTE_VIEWS).flat()), "pinned", "today"];

const spec = (name: ActionName, flags: Pick<ActionSpec, "changesData" | "alwaysConfirm" | "spendsBudget" | "undo">, description: string, params: JsonSchema): ActionSpec => ({ name, ...flags, description, params });
const VIEW = { changesData: false, alwaysConfirm: false, spendsBudget: false } as const;
const DATA = { changesData: true, alwaysConfirm: false, spendsBudget: false, undo: "correction" } as const;

export const ACTION_SPECS: Readonly<Record<ActionName, ActionSpec>> = {
  trace: spec("trace", { ...VIEW, undo: "remove-token" }, "Trace matching items on the figure (adds a removable token).", obj({ query: str(200), ids: { type: "array", items: id, maxItems: MAX_ITEMS_PER_ACTION }, filters: { type: "array", items: dimValue, maxItems: 6 } })),
  set_period: spec("set_period", { ...VIEW, undo: "restore-view" }, "Limit every view of this tab to a period (ISO dates).", obj({ start: isoDate, end: isoDate }, ["start", "end"])),
  open_view: spec(
    "open_view",
    { ...VIEW, undo: "back" },
    "Open a page or reader (navigation only; it can never start an import, an agent run or a change).",
    obj({ view: { type: "string", enum: [...new Set<string>([...PAGE_IDS, ...SHEET_ROUTES])] }, tab: { type: "string", enum: ROUTE_TABS }, id }, ["view"]),
  ),
  arrange: spec("arrange", { ...VIEW, undo: "restore-view" }, "Pull the points into groups by a dimension, with an optional layout.", obj({ by: dim, layout: { type: "string", enum: [...GROUP_LAYOUTS] } }, ["by"])),
  make_chart: spec(
    "make_chart",
    { ...VIEW, undo: "restore-view" },
    "Arrange the figure as a chart with its axes.",
    obj({ chart: { type: "string", enum: [...CHART_IDS] }, x: dim, y: dim, colour: dim, size: { type: "string", enum: ["entries", "words"] }, filter: dimValue }, ["chart"]),
  ),
  correct_entry: spec(
    "correct_entry",
    { ...DATA, alwaysConfirm: true },
    "Save a corrected wording of one record entry as a new version (the first wording stays in History).",
    obj({ entryId: { type: "string", pattern: "^e_[a-z2-7]{16}$" }, newText: str(20000), reason: str(400) }, ["entryId", "newText"]),
  ),
  set_date: spec("set_date", DATA, "Set the date the user says an entry was written (null removes the override).", obj({ target: id, date: { anyOf: [isoDate, { type: "null" }] } }, ["target", "date"])),
  set_speaker: spec("set_speaker", DATA, "Set who wrote an entry.", obj({ target: id, speaker: { type: "string", enum: ["you", "assistant", "other", "tool"] } }, ["target", "speaker"])),
  set_label: spec(
    "set_label",
    DATA,
    "Set a label field on conversations, notes or entries as the user's own decision.",
    obj(
      {
        targets: { type: "array", items: id, minItems: 1, maxItems: MAX_ITEMS_PER_ACTION },
        pack: { type: "string", pattern: "^[a-z0-9-]{1,40}$" },
        field: { type: "string", pattern: "^[A-Za-z0-9_-]{1,40}$" },
        value: { anyOf: [{ type: "string", maxLength: 200 }, { type: "array", items: { type: "string", maxLength: 80 }, maxItems: 8 }, { type: "boolean" }, { type: "null" }] },
      },
      ["targets", "pack", "field", "value"],
    ),
  ),
  merge_groups: spec("merge_groups", DATA, "Show one group as part of another everywhere (display only; nothing is moved or rewritten).", obj({ dim, from: str(200), into: str(200) }, ["dim", "from", "into"])),
  refile: spec("refile", DATA, "Show an item under another area, folder or project (display only).", obj({ target: id, area: str(40), folder: str(200), project: { anyOf: [str(80), { type: "null" }] } }, ["target"])),
  exclude: spec("exclude", DATA, "Leave an entry, conversation or source out of the figure, search, notes and agents (nothing is deleted).", obj({ target: str(300), scope: { type: "string", enum: ["entry", "conversation", "source"] } }, ["target", "scope"])),
  include: spec("include", { ...DATA, alwaysConfirm: true }, "Bring back something that was left out (always asks the user first).", obj({ target: str(300) }, ["target"])),
  refresh: spec(
    "refresh",
    { changesData: false, alwaysConfirm: false, spendsBudget: true, undo: "cancel-jobs" },
    `Queue the agents to re-read the selection or a period (at most ${MAX_REFRESH_ITEMS} items; never everything).`,
    obj({ scope: { type: "string", enum: ["selection", "period"] }, period: isoPair }, ["scope"]),
  ),
  propose_filing: spec(
    "propose_filing",
    { changesData: false, alwaysConfirm: false, spendsBudget: true, undo: "discard-checks" },
    "Draft suggested places as checks (nothing is applied).",
    obj({ scope: { type: "string", enum: ["no-area", "selection"] } }, ["scope"]),
  ),
  pin: spec("pin", { ...VIEW, undo: "correction" }, "Pin an item so it appears under Read › Pinned only.", obj({ target: id }, ["target"])),
};

export const ACTION_NAMES = Object.keys(ACTION_SPECS) as ActionName[];

/** Schema of one action call as the model must emit it. */
export const ACTION_CALL_SCHEMA: JsonSchema = {
  anyOf: ACTION_NAMES.map((name) => ({
    type: "object",
    properties: { action: { const: name }, params: ACTION_SPECS[name].params },
    required: ["action", "params"],
    additionalProperties: false,
  })),
};

/** Does this call need the user's Apply click, given "Apply Ask's changes without asking"? */
export function needsApply(name: ActionName, applyWithoutConfirm: boolean): boolean {
  const s = ACTION_SPECS[name];
  if (s.alwaysConfirm || s.spendsBudget) return true;
  if (!s.changesData) return false;
  return !applyWithoutConfirm;
}

/** A slash command's verb (or, for /correct, its family: text, date or speaker). */
export type OnlyVerb = ActionName | readonly ActionName[];

/** A slash command sends `onlyVerb`; any other verb in the reply is rejected ("Not allowed"). */
export function verbAllowed(name: ActionName, onlyVerb?: OnlyVerb): boolean {
  if (onlyVerb === undefined) return true;
  return typeof onlyVerb === "string" ? name === onlyVerb : onlyVerb.includes(name);
}
