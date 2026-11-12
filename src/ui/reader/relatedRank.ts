/**
 * Related entries for the entry reader: one search per shared term, merged and ranked by how many of the terms an entry
 * shares (more first), then by how high it ranked in those searches. Pure, so the order is tested without a worker.
 */
import { t } from "../copy";

export interface RelatedHit {
  term: string;
  /** Search hits for this term, best first. */
  ordinals: readonly number[];
}

export interface RelatedRow {
  ordinal: number;
  /** The terms this entry shares with the open one, in the order of the term chips. */
  terms: string[];
}

/** Rows ranked by shared terms; `skip` drops the open entry itself. */
export function rankRelated(hits: readonly RelatedHit[], skip: (ordinal: number) => boolean): RelatedRow[] {
  const by = new Map<number, { terms: string[]; rank: number; first: number }>();
  let seen = 0;
  for (const h of hits) {
    h.ordinals.forEach((o, position) => {
      if (skip(o)) return;
      let row = by.get(o);
      if (!row) {
        row = { terms: [], rank: 0, first: seen++ };
        by.set(o, row);
      }
      if (row.terms.includes(h.term)) return;
      row.terms.push(h.term);
      row.rank += position;
    });
  }
  return [...by.entries()]
    .sort((a, b) => b[1].terms.length - a[1].terms.length || a[1].rank / a[1].terms.length - b[1].rank / b[1].terms.length || a[1].first - b[1].first)
    .map(([ordinal, r]) => ({ ordinal, terms: r.terms }));
}

/** The rows that share `term` (all rows when it is empty), capped at `max`. */
export function filterRelated(rows: readonly RelatedRow[], term: string, max: number): RelatedRow[] {
  return (term ? rows.filter((r) => r.terms.includes(term)) : [...rows]).slice(0, max);
}

/** "a", "a and b", "a, b and c". */
export function joinTerms(terms: readonly string[]): string {
  if (terms.length <= 1) return terms[0] ?? "";
  return t("reader.listLast", { head: terms.slice(0, -1).join(", "), last: terms[terms.length - 1] ?? "" });
}
