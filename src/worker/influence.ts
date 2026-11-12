/**
 * Influence (Agents > Ledger): who made the record. Every node (a note, or any entry) has a set of makers: you, the
 * assistant of an app (`app:claude-code`), a tool, someone else, or the machine (notes Cortex's agents wrote).
 * A note's set is its writer. In the whole record an entry carries the set of its whole conversation, so "you and
 * Claude Code" is one row, not two. A link (a note link, and in the whole record a note's citation of an entry)
 * belongs to the union of its two ends' sets. Read from the index alone: no model is asked anything.
 */
import { ItemFlag, NONE32, Population, SOURCE_ORDER, SPEAKER_ORDER, type DataIndex } from "../shared/index-format";
import type { InfluenceScope, StatsResult } from "../shared/protocol/worker";

export type InfluenceStats = Extract<StatsResult, { kind: "influence" }>;

const NAMED_RANK: Readonly<Record<string, number>> = { you: 0, machine: 2, tool: 3, other: 4 };

/** you first, then the assistants (by name), then the machine, tools and others. */
export function makerRank(maker: string): number {
  return maker.startsWith("app:") ? 1 : (NAMED_RANK[maker] ?? 5);
}

export function sortMakers(makers: Iterable<string>): string[] {
  return [...makers].sort((a, b) => makerRank(a) - makerRank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Who wrote one node. */
export function makerOf(index: DataIndex, o: number): string {
  const c = index.cols;
  if (c.pop[o] === Population.Note) return (c.flags[o]! & ItemFlag.MachineWritten) !== 0 ? "machine" : "you";
  const speaker = SPEAKER_ORDER[c.speaker[o]!];
  if (speaker === "assistant") return `app:${SOURCE_ORDER[c.source[o]!] ?? "other"}`;
  return speaker === "you" || speaker === "tool" ? speaker : "other";
}

/** Everything in the record except what you excluded: reference notes and automated traffic are part of who made it. */
function eligible(index: DataIndex, o: number): boolean {
  return !(index.cols.flags[o]! & ItemFlag.Excluded);
}

export interface MakerSets {
  /** Per ordinal: index into `keys`, or -1 when the node is not part of this reading. */
  setOf: Int32Array;
  /** Distinct set keys ("you", "you+app:claude-code"). */
  keys: string[];
  makers: string[][];
  /** Per ordinal: the node's own maker (only meaningful where setOf >= 0). */
  own: string[];
}

/** The set of makers of every node in the reading. */
export function makerSets(index: DataIndex, scope: InfluenceScope): MakerSets {
  const n = index.count;
  const c = index.cols;
  const own = new Array<string>(n);
  const byConv = new Map<number, Set<string>>();
  for (let o = 0; o < n; o++) {
    if (!eligible(index, o)) continue;
    own[o] = makerOf(index, o);
    if (scope === "record" && c.pop[o] !== Population.Note && c.conv[o] !== NONE32) {
      const set = byConv.get(c.conv[o]!) ?? new Set<string>();
      set.add(own[o]!);
      byConv.set(c.conv[o]!, set);
    }
  }
  const setOf = new Int32Array(n).fill(-1);
  const keys: string[] = [];
  const makers: string[][] = [];
  const ids = new Map<string, number>();
  for (let o = 0; o < n; o++) {
    if (!eligible(index, o)) continue;
    const isNote = c.pop[o] === Population.Note;
    if (scope === "notes" && !isNote) continue;
    const list = scope === "record" && !isNote && c.conv[o] !== NONE32 ? sortMakers(byConv.get(c.conv[o]!)!) : [own[o]!];
    const key = list.join("+");
    let id = ids.get(key);
    if (id === undefined) {
      id = keys.length;
      ids.set(key, id);
      keys.push(key);
      makers.push(list);
    }
    setOf[o] = id;
  }
  return { setOf, keys, makers, own };
}

/** Each link once, as the pair of ordinals it joins (note links; in the whole record also a note's citations). */
function forEachLink(index: DataIndex, scope: InfluenceScope, sets: MakerSets, visit: (a: number, b: number) => void): void {
  const { offsets, targets } = index.rel.noteLinks;
  for (let o = 0; o < index.count; o++) {
    if (sets.setOf[o]! < 0) continue;
    for (let k = offsets[o]!; k < offsets[o + 1]!; k++) {
      const t = targets[k]!;
      if (t > o && t < index.count && sets.setOf[t]! >= 0) visit(o, t);
    }
  }
  if (scope !== "record") return;
  const cites = index.rel.noteSources;
  for (let o = 0; o < index.count; o++) {
    if (sets.setOf[o]! < 0) continue;
    for (let k = cites.offsets[o]!; k < cites.offsets[o + 1]!; k++) {
      const t = cites.targets[k]!;
      if (t < index.count && sets.setOf[t]! >= 0) visit(o, t);
    }
  }
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return a === b ? [...a] : sortMakers(new Set([...a, ...b]));
}

export function influenceStats(index: DataIndex, scope: InfluenceScope): InfluenceStats {
  const sets = makerSets(index, scope);
  const together = new Map<string, { key: string; makers: string[]; nodes: number; links: number }>();
  const row = (list: readonly string[]) => {
    const key = list.join("+");
    let r = together.get(key);
    if (!r) {
      r = { key, makers: [...list], nodes: 0, links: 0 };
      together.set(key, r);
    }
    return r;
  };
  const maker = new Map<string, { maker: string; touched: number; made: number; links: number }>();
  const mrow = (m: string) => {
    let r = maker.get(m);
    if (!r) {
      r = { maker: m, touched: 0, made: 0, links: 0 };
      maker.set(m, r);
    }
    return r;
  };
  let nodes = 0;
  let links = 0;
  for (let o = 0; o < index.count; o++) {
    const id = sets.setOf[o]!;
    if (id < 0) continue;
    nodes++;
    row(sets.makers[id]!).nodes++;
    for (const m of sets.makers[id]!) mrow(m).touched++;
    mrow(sets.own[o]!).made++;
  }
  forEachLink(index, scope, sets, (a, b) => {
    links++;
    const list = union(sets.makers[sets.setOf[a]!]!, sets.makers[sets.setOf[b]!]!);
    row(list).links++;
    for (const m of list) mrow(m).links++;
  });
  const byNodes = <T extends { nodes: number; key: string }>(a: T, b: T) => b.nodes - a.nodes || (a.key < b.key ? -1 : 1);
  return {
    kind: "influence",
    scope,
    nodes,
    links,
    together: [...together.values()].sort((a, b) => byNodes(a, b) || b.links - a.links),
    byMaker: [...maker.values()].sort((a, b) => b.touched - a.touched || makerRank(a.maker) - makerRank(b.maker) || (a.maker < b.maker ? -1 : 1)),
  };
}

/** Ordinals a row lights: a set key ("you+app:claude-code") selects exactly that set; "has:<maker>" every node the maker took part in. */
export function makerOrdinals(index: DataIndex, scope: InfluenceScope, value: string): number[] {
  const sets = makerSets(index, scope);
  const out: number[] = [];
  const wanted = value.startsWith("has:") ? null : sets.keys.indexOf(value);
  const maker = value.startsWith("has:") ? value.slice(4) : "";
  if (wanted !== null && wanted < 0) return out;
  for (let o = 0; o < index.count; o++) {
    const id = sets.setOf[o]!;
    if (id < 0) continue;
    if (wanted !== null ? id === wanted : sets.makers[id]!.includes(maker)) out.push(o);
  }
  return out;
}

/** Whether a group token's dimension is an influence one, and which reading it is. */
export function makerScope(dim: string): InfluenceScope | null {
  return dim === "maker:notes" ? "notes" : dim === "maker:record" ? "record" : null;
}
