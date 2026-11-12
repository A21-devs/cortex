/**
 * Agents > Ledger > Label packs as a table: PACK · ENTRIES · LABELS · UNASSIGNED, the fields written under each pack's
 * name and a note of who made the labels. Pure helpers; Agents.tsx renders them. Owner: lab.
 */
import { findPack } from "../../shared/packs";

export type PackSortKey = "pack" | "entries" | "labels" | "unassigned";
export interface PackSort {
  by: PackSortKey;
  desc: boolean;
}

/** Entries first, biggest on top: what the table opens with. */
export const PACK_SORT_DEFAULT: PackSort = { by: "entries", desc: true };

export interface PackTableRow {
  key: string;
  pack: string;
  version: string;
  /** Entries carrying at least one label of the pack. */
  entries: number;
  labels: number;
  /** Fields left blank (what the ledger's unanswered count says). */
  unassigned: number;
  /** The pack's fields, by name. */
  fields: string[];
  machine: number;
  you: number;
}

export interface PackStatRow {
  pack: string;
  version: string;
  entryCount: number;
  labelCount: number;
  authors: { machine: number; you: number };
  fields: readonly { field: string; coverage: number }[];
}

/** A field's name as the pack words it (a shipped pack knows its labels; an unknown pack's key stands in). */
export function fieldName(pack: string, version: string, key: string): string {
  return findPack(pack, version)?.fields.find((f) => f.key === key)?.label ?? key;
}

export function packTableRows(packs: readonly PackStatRow[], blankBy: Readonly<Record<string, number>>): PackTableRow[] {
  return packs.map((pk) => {
    const key = `${pk.pack}@${pk.version}`;
    return {
      key,
      pack: pk.pack,
      version: pk.version,
      entries: pk.entryCount,
      labels: pk.labelCount,
      unassigned: blankBy[key] ?? 0,
      fields: pk.fields.map((f) => fieldName(pk.pack, pk.version, f.field)),
      machine: pk.authors.machine,
      you: pk.authors.you,
    };
  });
}

/** Sorted copy. Ties fall back to the pack's name, then the newer version first, so the order never jumps. */
export function sortPackRows(rows: readonly PackTableRow[], sort: PackSort): PackTableRow[] {
  const dir = sort.desc ? -1 : 1;
  const byName = (a: PackTableRow, b: PackTableRow): number => a.pack.localeCompare(b.pack) || b.version.localeCompare(a.version, undefined, { numeric: true });
  return [...rows].sort((a, b) => {
    const c = sort.by === "pack" ? a.pack.localeCompare(b.pack) : a[sort.by] - b[sort.by];
    return c !== 0 ? c * dir : byName(a, b);
  });
}

/** Who made a row's labels, for the note under LABELS. */
export function madeBy(r: Pick<PackTableRow, "machine" | "you">): "none" | "model" | "you" | "both" {
  return r.machine === 0 && r.you === 0 ? "none" : r.you === 0 ? "model" : r.machine === 0 ? "you" : "both";
}

/** The next sort when a column header is pressed: the same column flips; a new one starts biggest-first (names A to Z). */
export function nextSort(cur: PackSort, by: PackSortKey): PackSort {
  return { by, desc: cur.by === by ? !cur.desc : by !== "pack" };
}
