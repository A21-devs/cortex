/**
 * Starter label packs, derived from THIS vault and these sessions [V] (ORIG-15). Owner: E6.
 *  - session@1.0.0: what kind of work a conversation (any source) was and how it ended, its project and topics;
 *  - placement@1.0.0: the role a note plays, used by Placement › By role in the body (role → brain region);
 *  - para@1.0.0 "PARA (from wiki-mode)": not written by a model — read from the vault's own wiki-mode setting
 *    (.vault-meta/mode.json, absent = generic → the pack shows nothing); off by default;
 *  - correction@1.0.0, field `fixes`, "Your fixes": why you corrected something; written only by you;
 *  - resume@1.0.0, field `item`, "Résumé item": the résumé item a note or conversation evidences; off by default.
 * A pack version is immutable once shipped: change values or prompts by publishing a new version; labels from
 * superseded versions stop counting (shown only with "Include superseded labels" on Agents).
 *
 * Pure module (shared layer): no DOM, no Node. The helpers below are the single definition of what a valid label
 * value is, used by the label job's validator (agents/validators.ts), Ask's `set_label` check
 * (plugin/aiExecutor.ts) and the PARA derivation of the vault index.
 */
import type { LabelValue, NoteKind, PackDef, PackField, PackTarget } from "./types";

export const SESSION_PACK: PackDef = {
  id: "session",
  version: "1.0.0",
  description: "What kind of work a conversation was, how it ended, and what it was about.",
  appliesTo: ["conversation"],
  writer: "model",
  fields: [
    {
      key: "work",
      label: "Work",
      description: "The main kind of work in the conversation.",
      type: "enum",
      values: ["debug", "build", "research", "write", "set up", "plan"],
      prompt: "Pick the one kind of work that best describes the conversation as a whole.",
    },
    {
      key: "outcome",
      label: "Outcome",
      description: "Where the work stood when the conversation ended.",
      type: "enum",
      values: ["shipped", "partly done", "abandoned", "blocked", "still open"],
      prompt: "How did the work stand at the end of the conversation?",
    },
    {
      key: "project",
      label: "Project",
      description: "The repository or project the conversation worked on.",
      type: "text",
      prompt: "Name the repository or project in 1-4 words (prefer the folder name shown in the data), or null.",
    },
    {
      key: "topics",
      label: "Topics",
      description: "Short lowercase topics, at most five.",
      type: "multi",
      maxValues: 5,
      prompt: "List up to five short lowercase topics (1-3 words each).",
    },
  ],
};

export const PLACEMENT_PACK: PackDef = {
  id: "placement",
  version: "1.0.0",
  description: "The role a note plays, used to place it in a brain region.",
  appliesTo: ["note"],
  writer: "model",
  fields: [
    {
      key: "role",
      label: "Role",
      description: "The function the note serves in the knowledge base.",
      type: "enum",
      values: [
        "capture", "creative", "plan", "reference", "idea", "draft", "map", "log", "reflection",
        "howto", "knowledge", "project", "source", "synthesis", "decision", "fix", "system",
      ],
      prompt: "Which single role best describes how this note is used?",
    },
  ],
};

export const PARA_PACK: PackDef = {
  id: "para",
  version: "1.0.0",
  description: "Projects, areas, resources and archives, read from the vault's wiki-mode setting.",
  appliesTo: ["note"],
  writer: "derived",
  fields: [
    {
      key: "para",
      label: "PARA",
      description: "Where wiki-mode files the note (only when the vault's mode is PARA).",
      type: "enum",
      values: ["projects", "areas", "resources", "archives"],
      prompt: "",
    },
  ],
};

/** correction@1.0.0, field `fixes`, shown as "Your fixes" (CORTEX-UX §12.5). */
export const FIXES_PACK: PackDef = {
  id: "correction",
  version: "1.0.0",
  description: "Why you corrected something. Written only by you.",
  appliesTo: ["entry", "conversation", "note"],
  writer: "user",
  fields: [
    {
      key: "fixes",
      label: "Your fixes",
      description: "What was wrong.",
      type: "enum",
      values: ["wrong fact", "wrong date", "wrong speaker", "wrong place", "not mine", "same as", "other"],
      prompt: "",
    },
  ],
};

/**
 * resume@1.0.0, field `item`: the part of the person's working life a note or conversation is evidence for (a job,
 * a project they shipped, a skill, a credential). Model-written and off by default; the dimension menu always
 * lists it under "Your résumé" and every item reads "No value" until the agents have filled some.
 */
export const RESUME_PACK: PackDef = {
  id: "resume",
  version: "1.0.0",
  description: "Which part of your working life a note or conversation is evidence for.",
  appliesTo: ["note", "conversation"],
  writer: "model",
  fields: [
    {
      key: "item",
      label: "Résumé item",
      description: "The job, project, skill or credential this shows evidence of.",
      type: "text",
      prompt: "If this shows real evidence of the person's work (a role they held, a project they built or shipped, a skill they used, a credential), name that résumé item in 2-6 words, for example \"payments migration\" or \"TypeScript tooling\"; otherwise null.",
    },
  ],
};

export const STARTER_PACKS: readonly PackDef[] = [SESSION_PACK, PLACEMENT_PACK, PARA_PACK, FIXES_PACK, RESUME_PACK];

export function findPack(id: string, version?: string): PackDef | undefined {
  return STARTER_PACKS.find((p) => p.id === id && (version === undefined || p.version === version));
}

/** A field of a pack by key. */
export function packField(pack: PackDef, key: string): PackField | undefined {
  return pack.fields.find((f) => f.key === key);
}

/** Key of one pack field in model output and in the label schema, e.g. "session.work". */
export function fieldKey(pack: string, field: string): string {
  return `${pack}.${field}`;
}

/**
 * Packs a MODEL fills for a kind of target, as switched on in Settings › Agents › Label packs (`pack id →
 * version`, "off" disables). User-written (correction) and derived (PARA) packs are never sent to a model.
 */
export function enabledModelPacks(target: PackTarget, enabled: Readonly<Record<string, string>>): PackDef[] {
  return STARTER_PACKS.filter((p) => p.writer === "model" && p.appliesTo.includes(target) && enabled[p.id] === p.version);
}

/** Longest free-text value a label may carry (project names; the Ask schema allows 80 for `refile.project`). */
export const LABEL_TEXT_MAX = 80;
/** Longest single value of a multi field (a topic). */
export const LABEL_MULTI_ITEM_MAX = 40;
/** Default cap for multi fields without their own `maxValues`. */
export const LABEL_MULTI_DEFAULT_MAX = 8;

function cleanText(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Canonical form of a value for a field: text trimmed and collapsed; multi values (topics) trimmed, lower-cased,
 * de-duplicated in order and capped at the field's `maxValues`; empty strings and empty lists become null.
 * Values of the wrong type are returned unchanged so `labelValueFits` can reject them.
 */
export function normaliseLabelValue(field: PackField, value: LabelValue): LabelValue {
  if (value === null) return null;
  switch (field.type) {
    case "enum":
    case "text": {
      if (typeof value !== "string") return value;
      const s = cleanText(value);
      return s.length === 0 ? null : s;
    }
    case "multi": {
      if (!Array.isArray(value)) return value;
      const out: string[] = [];
      for (const v of value) {
        if (typeof v !== "string") return value;
        const s = cleanText(v).toLowerCase();
        if (s.length > 0 && !out.includes(s)) out.push(s);
      }
      const capped = out.slice(0, field.maxValues ?? LABEL_MULTI_DEFAULT_MAX);
      return capped.length === 0 ? null : capped;
    }
    case "bool":
      return value;
  }
}

/** Does `value` fit the field: an enum value, a list of short strings within the cap, a boolean, short text, or null? */
export function labelValueFits(field: PackField, value: LabelValue): boolean {
  if (value === null) return true;
  switch (field.type) {
    case "enum":
      return typeof value === "string" && (field.values ?? []).includes(value);
    case "text":
      return typeof value === "string" && value.length > 0 && value.length <= LABEL_TEXT_MAX;
    case "multi":
      return (
        Array.isArray(value) &&
        value.length <= (field.maxValues ?? LABEL_MULTI_DEFAULT_MAX) &&
        value.every((v) => typeof v === "string" && v.length > 0 && v.length <= LABEL_MULTI_ITEM_MAX)
      );
    case "bool":
      return typeof value === "boolean";
  }
}

/** Brain region ids used by placement (owner E8). */
export const Region = {
  Prefrontal: 0,
  Frontal: 1,
  Parietal: 2,
  Occipital: 3,
  Temporal: 4,
  Limbic: 5,
  Cerebellum: 6,
  Brainstem: 7,
} as const;
export type RegionId = (typeof Region)[keyof typeof Region];

/** placement/role → region. */
export const ROLE_TO_REGION: Readonly<Record<string, RegionId>> = {
  plan: Region.Prefrontal, decision: Region.Prefrontal, project: Region.Prefrontal, idea: Region.Prefrontal,
  draft: Region.Frontal, fix: Region.Frontal, howto: Region.Frontal, system: Region.Frontal,
  map: Region.Parietal, synthesis: Region.Parietal,
  creative: Region.Occipital,
  reference: Region.Temporal, source: Region.Temporal, knowledge: Region.Temporal,
  reflection: Region.Limbic,
  log: Region.Cerebellum,
  capture: Region.Brainstem,
};

/** Region of a placement role, undefined for a value outside the pack. */
export function regionOfRole(role: string): RegionId | undefined {
  return Object.hasOwn(ROLE_TO_REGION, role) ? ROLE_TO_REGION[role] : undefined;
}

/**
 * The finer regions of Function (anatomy): each placement role lands in one named part of its brain region (the
 * coarse region above stays the one the figure places by). Ordered low to high inside a region, which is also the
 * order By role placement stacks them in. `name` is the row and label text (copy.ts `regions.<key>` says the same).
 */
export interface Subregion {
  key: string;
  name: string;
  region: RegionId;
  roles: readonly string[];
}
export const SUBREGIONS: readonly Subregion[] = [
  { key: "orbitofrontal", name: "Orbitofrontal cortex", region: Region.Prefrontal, roles: ["project"] },
  { key: "ventromedial", name: "Ventromedial prefrontal", region: Region.Prefrontal, roles: ["decision"] },
  { key: "frontopolar", name: "Frontopolar cortex", region: Region.Prefrontal, roles: ["idea"] },
  { key: "dorsolateral", name: "Dorsolateral prefrontal", region: Region.Prefrontal, roles: ["plan"] },
  { key: "broca", name: "Broca's area", region: Region.Frontal, roles: ["draft"] },
  { key: "premotor", name: "Premotor cortex", region: Region.Frontal, roles: ["howto", "fix", "system"] },
  { key: "angular", name: "Angular gyrus", region: Region.Parietal, roles: ["synthesis"] },
  { key: "superiorparietal", name: "Superior parietal lobule", region: Region.Parietal, roles: ["map"] },
  { key: "visual", name: "Visual cortex", region: Region.Occipital, roles: ["creative"] },
  { key: "inferiortemporal", name: "Inferior temporal", region: Region.Temporal, roles: ["reference"] },
  { key: "medialtemporal", name: "Medial temporal", region: Region.Temporal, roles: ["knowledge"] },
  { key: "superiortemporal", name: "Superior temporal", region: Region.Temporal, roles: ["source"] },
  { key: "cingulate", name: "Cingulate cortex", region: Region.Limbic, roles: ["reflection"] },
  { key: "cerebellum", name: "Cerebellum", region: Region.Cerebellum, roles: ["log"] },
  { key: "brainstem", name: "Brainstem", region: Region.Brainstem, roles: ["capture"] },
];

const SUBREGION_OF_ROLE: ReadonlyMap<string, Subregion> = new Map(SUBREGIONS.flatMap((s) => s.roles.map((r): [string, Subregion] => [r, s])));
const SUBREGION_BY_KEY: ReadonlyMap<string, Subregion> = new Map(SUBREGIONS.map((s) => [s.key, s]));

/** The finer region of a placement role, undefined for a value outside the pack. */
export function subregionOfRole(role: string): Subregion | undefined {
  return SUBREGION_OF_ROLE.get(role);
}

/** A finer region by its key, undefined for an unknown key. */
export function subregionByKey(key: string): Subregion | undefined {
  return SUBREGION_BY_KEY.get(key);
}

/**
 * The placement role a MACHINE note has by construction (its kind already says what it is), so Placement ›
 * By role can place summaries, maps and atomic notes without a model call. Vault notes get their role from the
 * placement pack; "wiki" (a plain vault note) has no implied role.
 */
export const ROLE_OF_NOTE_KIND: Readonly<Partial<Record<NoteKind, string>>> = {
  gist: "log",
  question: "knowledge",
  decision: "decision",
  idea: "idea",
  plan: "plan",
  abandoned: "reflection",
  concept: "knowledge",
  hub: "map",
  reference: "reference",
  log: "log",
};

// ───────────────────────────── PARA (derived from wiki-mode) ─────────────────────────────

export type ParaValue = "projects" | "areas" | "resources" | "archives";
export const PARA_VALUES: readonly ParaValue[] = ["projects", "areas", "resources", "archives"];

/**
 * PARA bucket of a vault note from wiki-mode's folders (`wiki/projects/…`, `wiki/areas/…`, `wiki/resources/…`,
 * `wiki/archives/…`), only when `.vault-meta/mode.json` names the PARA mode. Any other mode (generic, LYT,
 * Zettelkasten, or no file) yields null: the pack then shows nothing and says why in the dimension menu.
 */
export function paraOfPath(vaultPath: string, mode: string | null | undefined): ParaValue | null {
  if ((mode ?? "").trim().toLowerCase() !== "para") return null;
  const p = vaultPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const m = /^wiki\/([^/]+)\//i.exec(p);
  const top = m?.[1]?.toLowerCase();
  return PARA_VALUES.find((v) => v === top) ?? null;
}
