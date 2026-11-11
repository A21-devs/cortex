/**
 * Pure helpers behind the entry reader's context lines and sections (P18): the "Source · folder" line, the
 * conversation part sentence, the per-pack label table and the lists that feed the collapsible sections.
 * No DOM, no services: everything here is testable on plain data.
 */
import type { ConversationDetail, LabelView } from "../../plugin/services";
import { STARTER_PACKS } from "../../shared/packs";
import type { EntryRecord, LabelValue, PackDef, PackTarget } from "../../shared/types";
import { t } from "../copy";
import { sourceLabel } from "../valueLabels";

/** "a/b/c" of a record's folder; "" when it sits at the top (the inbox of its source). */
export function folderPathOf(r: Pick<EntryRecord, "folder">): string {
  return r.folder.filter((x) => x.length > 0).join("/");
}

/** "Claude Code · Inbox" or "Obsidian · notes/ideas". */
export function sourceFolderText(r: Pick<EntryRecord, "folder" | "source">): string {
  const path = folderPathOf(r);
  return t("reader.sourceFolderLine", { source: sourceLabel(r.source), folder: path === "" ? t("reader.inboxFolder") : path });
}

/**
 * "Part 1 of 2: “title”, titled by sonnet" for an entry inside a conversation with more than one part; null for
 * a single part, no part number, or a part number the conversation does not have. A conversation you renamed
 * says "titled by you".
 */
export function partSentence(d: Pick<ConversationDetail, "parts" | "record" | "gist">, part: number | undefined, shortModel: (m: string) => string): { text: string; n: number } | null {
  if (part === undefined || d.parts.length <= 1) return null;
  const idx = d.parts.findIndex((x) => x.n === part);
  const found = idx >= 0 ? d.parts[idx] : undefined;
  if (!found) return null;
  const i = idx + 1;
  const n = d.parts.length;
  const title = found.title?.trim();
  if (!title) return { text: t("reader.partNoteUntitled", { i, n }), n: found.n };
  const madeBy = d.gist && "model" in d.gist.madeBy ? shortModel(d.gist.madeBy.model) : undefined;
  const who = d.record.titledBy === "user" ? t("reader.partNoteYou") : madeBy;
  return { text: who ? t("reader.partNote", { i, n, title, who }) : t("reader.partNoteBare", { i, n, title }), n: found.n };
}

export interface PackValue {
  text: string;
  byUser: boolean;
  held: boolean;
  /** "you" or the model that set it ("rule" when plain rules guessed it, with no model). */
  who: string;
  /** Guessed by the No model rules: a model run replaces it. */
  rule?: boolean;
}

export interface PackRow {
  field: string;
  label: string;
  value: PackValue | null;
}

export interface PackBlock {
  pack: PackDef;
  rows: PackRow[];
  /** Values set in this pack. */
  set: number;
}

function valueText(v: LabelValue): string {
  if (v === null) return "";
  if (Array.isArray(v)) return v.join(" · ");
  if (typeof v === "boolean") return t(v ? "reader.yes" : "reader.no");
  return v;
}

/**
 * Per installed pack, per field: the current value (your own label over a model's, the newest otherwise;
 * superseded, refused and empty labels do not count) or null for "not labelled yet". Packs that apply to entries or
 * their conversation are listed; a pack with a value on this entry always is.
 */
export function labelsByPack(labels: readonly LabelView[], opts: { inConversation: boolean; packs?: readonly PackDef[] }): { blocks: PackBlock[]; setCount: number } {
  const best = new Map<string, LabelView>();
  for (const l of labels) {
    const r = l.label;
    if (r.supersededBy || (r.state !== "set" && r.state !== "held") || r.value === null || (Array.isArray(r.value) && r.value.length === 0)) continue;
    const key = `${r.pack}/${r.field}`;
    const cur = best.get(key);
    if (!cur || (l.byUser && !cur.byUser) || (l.byUser === cur.byUser && Date.parse(r.at) > Date.parse(cur.label.at))) best.set(key, l);
  }
  const targets: PackTarget[] = opts.inConversation ? ["entry", "conversation"] : ["entry"];
  const blocks: PackBlock[] = [];
  let setCount = 0;
  for (const pack of opts.packs ?? STARTER_PACKS) {
    const applies = pack.appliesTo.some((x) => targets.includes(x));
    const has = pack.fields.some((f) => best.has(`${pack.id}/${f.key}`));
    if (!applies && !has) continue;
    const rows: PackRow[] = pack.fields.map((f) => {
      const l = best.get(`${pack.id}/${f.key}`);
      if (!l) return { field: f.key, label: f.label, value: null };
      const by = l.label.by;
      const rule = "engine" in by && by.engine === "rule";
      return { field: f.key, label: f.label, value: { text: valueText(l.label.value), byUser: l.byUser, held: l.label.state === "held", who: "model" in by ? by.model : t("reader.you"), ...(rule ? { rule: true } : {}) } };
    });
    const set = rows.filter((x) => x.value !== null).length;
    setCount += set;
    blocks.push({ pack, rows, set });
  }
  return { blocks, setCount };
}

/** Record ids cited together with this entry by the notes that cite it, plus the entry it replaced; never itself. */
export function connectedRecordIds(self: string, cites: readonly (readonly string[])[], supersedes?: string, cap = 12): string[] {
  const out: string[] = [];
  const add = (id: string | undefined) => {
    if (id && id !== self && !out.includes(id)) out.push(id);
  };
  add(supersedes);
  for (const group of cites) for (const id of group) add(id);
  return out.slice(0, cap);
}
