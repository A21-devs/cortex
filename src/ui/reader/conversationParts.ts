/**
 * What the conversation reader gathers from a conversation's notes: ideas, decisions, the quoted passages behind them,
 * and the small chip row under each part (topic, stage, status). The chips are read off the notes of that part; nothing
 * here asks a model for anything.
 */
import type { Citation, NoteRecord } from "../../shared/types";
import { t } from "../copy";

type Part = { n: number; title?: string; notes: readonly NoteRecord[] };

export interface PartChip {
  field: "topic" | "stage" | "status";
  text: string;
}

/** Notes of the given kinds across every part, in part order. */
export function gatherByKind(parts: readonly Part[], kinds: readonly NoteRecord["kind"][]): NoteRecord[] {
  return parts.flatMap((p) => p.notes.filter((n) => kinds.includes(n.kind)));
}

/** The notes that stay under their part's node: everything except the ideas and decisions listed by themselves. */
export function stemNotes(part: Part): NoteRecord[] {
  return part.notes.filter((n) => n.kind !== "idea" && n.kind !== "decision");
}

/** The conversation's topics as the summary stored them. */
export function topicsOf(facets: NoteRecord["facets"] | undefined): string[] {
  const v = facets?.topics;
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => x.trim()).filter((x) => x !== "");
}

/** Topic (a conversation topic this part's own text mentions), stage and status for one part. Empty when nothing says. */
export function partChips(part: Part, topics: readonly string[]): PartChip[] {
  const out: PartChip[] = [];
  const text = `${part.title ?? ""} ${part.notes.map((n) => `${n.title} ${n.text}`).join(" ")}`.toLowerCase();
  const topic = topics.find((x) => text.includes(x.toLowerCase()));
  if (topic) out.push({ field: "topic", text: topic });
  const kinds = new Set(part.notes.map((n) => n.kind));
  if (kinds.has("plan")) out.push({ field: "stage", text: t("reader.stagePlanning") });
  else if (kinds.has("idea")) out.push({ field: "stage", text: t("reader.stageExploring") });
  else if (kinds.has("question")) out.push({ field: "stage", text: t("reader.stageAsking") });
  if (kinds.has("decision")) out.push({ field: "status", text: t("reader.statusDecided") });
  else if (kinds.has("abandoned")) out.push({ field: "status", text: t("reader.statusDropped") });
  else if (kinds.has("question") || kinds.has("plan") || kinds.has("idea")) out.push({ field: "status", text: t("reader.statusOpen") });
  return out;
}

/** Each passage quoted by the conversation's notes once (first citation wins), in the order the notes cite them. */
export function uniqueSources(parts: readonly Part[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const p of parts) {
    for (const n of p.notes) {
      for (const c of n.sources) {
        const key = `${c.entryId}\u0000${c.quote}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
      }
    }
  }
  return out;
}
