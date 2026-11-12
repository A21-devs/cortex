/**
 * Your schemas (Agents > Ledger): label schemas you build yourself, kept beside the built-in packs. A schema has fields
 * (a name and what its answers look like), a working copy and saved versions. Nothing here asks a model anything: a
 * schema is a design until a pack run uses a version, and a version a run used stays as it was (frozen). This build
 * keeps and shows the drafts; running them is a later step, so every version is still open to being replaced.
 *
 * Stored in settings (`schemas`, validated by `sanitiseSchemas` on every load). Pure: no DOM, no settings handle.
 */
import type { SettingsIssue } from "./settings";
import type { PackDef, PackField, PackFieldType } from "./types";

export interface SchemaVersion {
  /** 1, 2, 3 … in the order saved. */
  n: number;
  savedAt: string;
  fields: PackField[];
  /** A run used this version: it can no longer change. Nothing sets it in this build. */
  frozen?: boolean;
}

export interface SchemaDraft {
  id: string;
  name: string;
  /** The working copy: what the editor shows, saved or not. */
  fields: PackField[];
  versions: SchemaVersion[];
  archived: boolean;
  /** The built-in pack it was copied from, if any (its existing labels give the coverage). */
  from?: { pack: string; version: string };
  createdAt: string;
}

export const SCHEMA_LIMITS = { schemas: 40, name: 60, id: 60, fields: 24, fieldLabel: 40, values: 24, value: 40, versions: 50, importBytes: 200_000 } as const;
const TYPES: readonly PackFieldType[] = ["enum", "multi", "bool", "text"];

const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** A key for a field from its name: "Main topic" -> "main_topic"; unique among `taken`. */
export function fieldKeyFor(label: string, taken: ReadonlySet<string>): string {
  const base = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "field";
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
  return key;
}

function cleanField(raw: unknown, taken: Set<string>): PackField | null {
  if (!plain(raw)) return null;
  const label = text(raw.label, SCHEMA_LIMITS.fieldLabel);
  if (label === "") return null;
  const type: PackFieldType = TYPES.includes(raw.type as PackFieldType) ? (raw.type as PackFieldType) : "text";
  const key = typeof raw.key === "string" && /^[a-z0-9_]{1,40}$/.test(raw.key) && !taken.has(raw.key) ? raw.key : fieldKeyFor(label, taken);
  taken.add(key);
  const field: PackField = { key, label, description: text(raw.description, 200), type, prompt: text(raw.prompt, 300) };
  if (type === "enum" || type === "multi") {
    const seen = new Set<string>();
    const values = (Array.isArray(raw.values) ? raw.values : []).map((v) => text(v, SCHEMA_LIMITS.value)).filter((v) => v !== "" && !seen.has(v) && !!seen.add(v)).slice(0, SCHEMA_LIMITS.values);
    field.values = values;
  }
  return field;
}

export function cleanFields(raw: unknown): PackField[] {
  const taken = new Set<string>();
  const out: PackField[] = [];
  for (const f of Array.isArray(raw) ? raw : []) {
    const one = cleanField(f, taken);
    if (one) out.push(one);
    if (out.length >= SCHEMA_LIMITS.fields) break;
  }
  return out;
}

function cleanDraft(raw: unknown): SchemaDraft | null {
  if (!plain(raw)) return null;
  const id = typeof raw.id === "string" && /^[a-z0-9-]{1,60}$/.test(raw.id) ? raw.id : "";
  const name = text(raw.name, SCHEMA_LIMITS.name);
  if (id === "" || name === "") return null;
  const versions: SchemaVersion[] = [];
  for (const v of (Array.isArray(raw.versions) ? raw.versions : []).slice(0, SCHEMA_LIMITS.versions)) {
    if (!plain(v) || typeof v.n !== "number" || !Number.isInteger(v.n) || v.n < 1) continue;
    versions.push({ n: v.n, savedAt: text(v.savedAt, 40), fields: cleanFields(v.fields), ...(v.frozen === true ? { frozen: true } : {}) });
  }
  const from = plain(raw.from) && typeof raw.from.pack === "string" && typeof raw.from.version === "string" ? { pack: raw.from.pack.slice(0, 60), version: raw.from.version.slice(0, 20) } : undefined;
  return { id, name, fields: cleanFields(raw.fields), versions, archived: raw.archived === true, ...(from ? { from } : {}), createdAt: text(raw.createdAt, 40) };
}

/** The stored list, validated: a damaged item is dropped and reported, the rest kept. */
export function sanitiseSchemas(raw: unknown, issues: SettingsIssue[]): SchemaDraft[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push({ path: "schemas", problem: "wrong-type", action: "used-default" });
    return [];
  }
  const out: SchemaDraft[] = [];
  const seen = new Set<string>();
  let dropped = false;
  for (const item of raw) {
    const d = cleanDraft(item);
    if (d === null || seen.has(d.id) || out.length >= SCHEMA_LIMITS.schemas) {
      dropped = true;
      continue;
    }
    seen.add(d.id);
    out.push(d);
  }
  if (dropped) issues.push({ path: "schemas", problem: "malformed-list", action: "used-default" });
  return out;
}

// ───────────────────────────── making and changing drafts ─────────────────────────────

function freshId(existing: readonly SchemaDraft[], seed: string): string {
  const base = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "schema";
  const taken = new Set(existing.map((d) => d.id));
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

/** "My schema", then "My schema 2" … : a name no other draft has. */
export function freshName(existing: readonly SchemaDraft[], base: string): string {
  const taken = new Set(existing.map((d) => d.name.toLowerCase()));
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} ${i}`;
  return name.slice(0, SCHEMA_LIMITS.name);
}

export function newDraft(existing: readonly SchemaDraft[], baseName: string, now: Date): SchemaDraft {
  const name = freshName(existing, baseName);
  return { id: freshId(existing, name), name, fields: [], versions: [], archived: false, createdAt: now.toISOString() };
}

/** A draft that starts as a copy of a built-in pack's fields. The pack itself is never touched. */
export function draftFromPack(pack: PackDef, existing: readonly SchemaDraft[], baseName: string, now: Date): SchemaDraft {
  const d = newDraft(existing, baseName, now);
  return { ...d, fields: cleanFields(pack.fields.map((f) => ({ ...f }))), from: { pack: pack.id, version: pack.version } };
}

/** A draft from the text of a file: `{ "name": "...", "fields": [{ "label", "type", "values" }] }`. Null when it cannot be read. */
export function draftFromFile(raw: string, existing: readonly SchemaDraft[], now: Date): SchemaDraft | null {
  if (raw.length > SCHEMA_LIMITS.importBytes) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!plain(data)) return null;
  const fields = cleanFields(data.fields);
  const name = text(data.name ?? data.id, SCHEMA_LIMITS.name);
  if (fields.length === 0 || name === "") return null;
  const d = newDraft(existing, name, now);
  return { ...d, fields };
}

const sameFields = (a: readonly PackField[], b: readonly PackField[]): boolean => JSON.stringify(a) === JSON.stringify(b);

export type SchemaState = "unsaved" | "changed" | "saved";

/** "unsaved": never saved; "changed": the working copy differs from the newest saved version; "saved": they match. */
export function schemaState(d: SchemaDraft): SchemaState {
  const last = d.versions[d.versions.length - 1];
  if (!last) return "unsaved";
  return sameFields(last.fields, d.fields) ? "saved" : "changed";
}

/** Save the working copy as the next version (nothing when it has no fields, or equals the newest version). */
export function saveVersion(d: SchemaDraft, now: Date): SchemaDraft {
  if (d.fields.length === 0 || schemaState(d) === "saved" || d.versions.length >= SCHEMA_LIMITS.versions) return d;
  const last = d.versions[d.versions.length - 1];
  const n = (last?.n ?? 0) + 1;
  return { ...d, versions: [...d.versions, { n, savedAt: now.toISOString(), fields: d.fields.map((f) => ({ ...f })) }] };
}

/** How many versions a run has frozen. */
export function frozenCount(d: SchemaDraft): number {
  return d.versions.filter((v) => v.frozen === true).length;
}

/**
 * Coverage from labels that already exist: entries labelled by the built-in pack this draft was copied from, while it
 * still holds at least one of that pack's fields. Anything else has no labels yet, so 0.
 */
export function schemaCoverage(d: SchemaDraft, packs: readonly { pack: string; version: string; entryCount: number; fields: readonly { field: string }[] }[]): number {
  if (!d.from) return 0;
  const row = packs.find((p) => p.pack === d.from!.pack && p.version === d.from!.version);
  if (!row) return 0;
  const keep = new Set(d.fields.map((f) => f.key));
  return row.fields.some((f) => keep.has(f.field)) ? row.entryCount : 0;
}

/** Replace one draft in the list (by id). */
export function replaceDraft(list: readonly SchemaDraft[], next: SchemaDraft): SchemaDraft[] {
  return list.map((d) => (d.id === next.id ? next : d));
}

/** Rename, refusing an empty name or one another draft has. */
export function renameDraft(list: readonly SchemaDraft[], id: string, name: string): SchemaDraft[] {
  const clean = text(name, SCHEMA_LIMITS.name);
  if (clean === "" || list.some((d) => d.id !== id && d.name.toLowerCase() === clean.toLowerCase())) return [...list];
  return list.map((d) => (d.id === id ? { ...d, name: clean } : d));
}
