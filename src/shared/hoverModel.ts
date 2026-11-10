/**
 * Pure models behind hover on the stage (SPEC F9 hub hover, F43 provenance line; CORTEX-UX §6.9). No DOM, no GL, so the
 * renderer's controller, the stage overlays and the tests share one reading of the index relations.
 *  - hubMemberList / hubSourceList: a hub's member notes (largest first) and the record entries those notes are built from.
 *  - provenanceOf: the one-line status for an item ("Source of N notes", "Built from N entries").
 *  - groupPreviewSet: the points a hovered key chip stands for.
 * Owner: E10/E11.
 */
import { ItemKind, NONE32, NONE8, Population, type DataIndex } from "./index-format";
import type { LegendModel } from "./protocol/worker";

/** Hub hover: how many member chips are named, and the ceiling on source entries lit. */
export const HUB_HOVER = { chips: 30, maxSources: 8000 } as const;

const validItem = (idx: DataIndex, o: number): boolean => Number.isInteger(o) && o >= 0 && o < idx.count && idx.cols.kind[o] !== NONE8;

/** A hub's member notes (the hub itself, unknown and out-of-range ordinals dropped), largest first, then by ordinal. */
export function hubMemberList(idx: DataIndex, hub: number): number[] {
  if (!validItem(idx, hub) || idx.cols.kind[hub] !== ItemKind.NoteHub) return [];
  const { offsets, targets } = idx.rel.hubMembers;
  if (hub + 1 >= offsets.length) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (let k = offsets[hub] as number; k < (offsets[hub + 1] as number); k++) {
    const m = targets[k] as number;
    if (m === hub || seen.has(m) || !validItem(idx, m)) continue;
    seen.add(m);
    out.push(m);
  }
  const words = idx.cols.words;
  out.sort((a, b) => (words[b] as number) - (words[a] as number) || a - b);
  return out;
}

/** The distinct record entries the given notes cite, in the order first met, at most `cap`. */
export function hubSourceList(idx: DataIndex, notes: readonly number[], cap: number = HUB_HOVER.maxSources): number[] {
  const { offsets, targets } = idx.rel.noteSources;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const n of notes) {
    if (n + 1 >= offsets.length) continue;
    for (let k = offsets[n] as number; k < (offsets[n + 1] as number); k++) {
      const s = targets[k] as number;
      if (seen.has(s) || !validItem(idx, s) || idx.cols.pop[s] !== Population.Record) continue;
      seen.add(s);
      out.push(s);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** How many notes cite each item (rows of noteSources inverted once per loaded index; rebuilt if the index grew in place). */
const citedCounts = new WeakMap<DataIndex, Uint32Array>();

export function citedByCount(idx: DataIndex, o: number): number {
  let counts = citedCounts.get(idx);
  if (!counts || counts.length !== idx.count) {
    counts = new Uint32Array(idx.count);
    const { offsets, targets } = idx.rel.noteSources;
    const rows = Math.min(idx.count, Math.max(0, offsets.length - 1));
    for (let row = 0; row < rows; row++) {
      for (let k = offsets[row] as number; k < (offsets[row + 1] as number); k++) {
        const t = targets[k] as number;
        if (t < idx.count) counts[t] = (counts[t] as number) + 1;
      }
    }
    citedCounts.set(idx, counts);
  }
  return o >= 0 && o < counts.length ? (counts[o] as number) : 0;
}

export type Provenance =
  /** A record entry: how many notes are built from it. */
  | { kind: "entry"; notes: number }
  /** A note or a hub: how many record entries it is built from (all of them sit in the spine below the brain). */
  | { kind: "built"; entries: number };

/** What the stage's one-line status says about an item, or null when there is nothing to say. */
export function provenanceOf(idx: DataIndex, o: number): Provenance | null {
  if (!validItem(idx, o)) return null;
  if (idx.cols.pop[o] === Population.Record) {
    const notes = citedByCount(idx, o);
    return notes > 0 ? { kind: "entry", notes } : null;
  }
  const notes = idx.cols.kind[o] === ItemKind.NoteHub ? hubMemberList(idx, o) : [o];
  const entries = hubSourceList(idx, notes, Number.MAX_SAFE_INTEGER).length;
  return entries > 0 ? { kind: "built", entries } : null;
}

/**
 * The points a hovered key chip stands for, as a 0/1 mask over the items, or null when the chip matches no row. The chip's
 * key is `dim=rowKey`; `groupOf` is each item's row in the section that colours its population (the Brain row for notes,
 * the Spine row for entries, or the one shared section). Rows nested under the hovered one (a folder's subfolders) count too.
 */
export function groupPreviewSet(legend: LegendModel | null, groupOf: Uint32Array | null, pop: ArrayLike<number>, count: number, key: string): Uint8Array | null {
  if (!legend || !groupOf) return null;
  const want: { notes: Set<number>; record: Set<number> } = { notes: new Set(), record: new Set() };
  let found = false;
  for (const sec of legend.sections) {
    const rows = sec.rows;
    const own = new Set<string>();
    rows.forEach((row) => {
      if (`${String(sec.dim)}=${row.key}` === key) own.add(row.key);
    });
    if (own.size === 0) continue;
    // Nested rows: anything whose parent chain reaches a hovered row.
    for (let grew = true; grew; ) {
      grew = false;
      for (const row of rows) {
        if (row.parentKey === undefined || !own.has(row.parentKey) || own.has(row.key)) continue;
        own.add(row.key);
        grew = true;
      }
    }
    rows.forEach((row, i) => {
      if (!own.has(row.key)) return;
      found = true;
      if (sec.population !== "record") want.notes.add(i);
      if (sec.population !== "notes") want.record.add(i);
    });
  }
  if (!found) return null;
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const row = groupOf[i] as number;
    if (row === NONE32) continue;
    if ((pop[i] === Population.Note ? want.notes : want.record).has(row)) out[i] = 1;
  }
  return out;
}
