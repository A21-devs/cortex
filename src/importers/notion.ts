/**
 * Notion export importer (zip or unzipped folder of markdown and csv). Owner: E3.
 *
 * Notion's "Export › Markdown & CSV" writes every page as `<Title> <32 hex id>.md`, the sub-pages of a page into
 * a folder of the same name, and every database as `<Name> <id>.csv` (and an `_all.csv` twin). Read here:
 *  - markdown pages as documents (long ones also as passages), the text exactly as exported;
 *  - database tables as one document each (the csv text; a table over `sources.raw.maxJsonBytes` is skipped);
 *  - the page tree: `project` = the top page or database, `folder` = ["Notion", ...ancestors];
 *  - dates the page itself names in its property lines (Created, Last edited, Date …) at the strength the page
 *    gives (a day or a minute, no time zone); without one the page has only the export time as an upper bound.
 * Images and attachments are never read. A big workspace comes as a zip of zip parts: those are opened as one.
 */
import type { SourceImportStats, SourceSelector } from "../shared/protocol/runner";
import type { IsoDate } from "../shared/types";
import { splitFrontmatter, type DiscoveredUnit, type ImportContext, type Importer } from "./common";
import { discoverExport } from "./zip";
import { readMemberBytes, runDocExport, type DocExportFormat, type ParsedPage } from "./exportDocs";
import type { ExportMember, ExportSource } from "./zip";

export type NotionSelector = Extract<SourceSelector, { kind: "notion" }>;

const ID_STEM = /^(.*?)\s+([0-9a-f]{32})(_all)?$/i;

export interface NotionName {
  /** The title without the id. */
  title: string;
  id?: string;
  all: boolean;
}

/** "Roadmap 0123456789abcdef0123456789abcdef" → { title: "Roadmap", id }. */
export function notionName(stem: string): NotionName {
  const m = ID_STEM.exec(stem);
  if (!m) return { title: stem.trim() || "Untitled", all: false };
  const out: NotionName = { title: (m[1] as string).trim() || "Untitled", id: (m[2] as string).toLowerCase(), all: m[3] !== undefined };
  return out;
}

function stemOf(seg: string): string {
  const i = seg.lastIndexOf(".");
  return i > 0 ? seg.slice(0, i) : seg;
}

/** Does this list of member names look like a Notion markdown export? */
export function looksLikeNotion(names: readonly string[]): boolean {
  let hits = 0;
  for (const n of names) {
    const base = n.slice(n.lastIndexOf("/") + 1);
    if (/\.(md|csv)$/i.test(base) && ID_STEM.test(stemOf(base))) hits++;
    if (hits >= 1) return true;
  }
  return false;
}

/** A single wrapper folder around everything ("Export-<uuid>/") is not part of the page tree. */
export function wrapperOf(names: readonly string[]): string {
  const firsts = new Set<string>();
  for (const n of names) {
    const i = n.indexOf("/");
    if (i < 0) return "";
    firsts.add(n.slice(0, i));
  }
  if (firsts.size !== 1) return "";
  const only = [...firsts][0] as string;
  return ID_STEM.test(only) ? "" : `${only}/`;
}

export interface NotionPageRef {
  member: ExportMember;
  /** Path below the wrapper, "/"-separated. */
  rel: string;
  csv: boolean;
  /** Folder titles above the page, outermost first. */
  ancestors: string[];
  name: NotionName;
}

/** The pages of an export: markdown files and database tables, with their place in the tree. */
export function notionPages(members: readonly ExportMember[]): NotionPageRef[] {
  const wrapper = wrapperOf(members.map((m) => m.name));
  const all = members
    .filter((m) => /\.(md|csv)$/i.test(m.name))
    .map((m) => {
      const rel = m.name.slice(wrapper.length);
      const segs = rel.split("/");
      const file = segs[segs.length - 1] as string;
      return { member: m, rel, csv: /\.csv$/i.test(file), ancestors: segs.slice(0, -1).map((s) => notionName(s).title), name: notionName(stemOf(file)) } satisfies NotionPageRef;
    });
  // "<Name> <id>_all.csv" repeats "<Name> <id>.csv" (the default view): keep the plain one when both exist.
  const plain = new Set(all.filter((p) => p.csv && !p.name.all && p.name.id !== undefined).map((p) => p.name.id));
  return all.filter((p) => !(p.csv && p.name.all && p.name.id !== undefined && plain.has(p.name.id)));
}

const MONTHS: Readonly<Record<string, number>> = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11, jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

/** "March 1, 2024 10:00 AM", "March 1, 2024", "2024-03-01" → an ISO time (read as UTC: the page names no time zone). */
export function parseNotionDate(raw: string): IsoDate | undefined {
  const s = raw.replace(/^@/, "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  let y: number;
  let mo: number;
  let d: number;
  let hh = 0;
  let mm = 0;
  if (m) {
    y = Number(m[1]);
    mo = Number(m[2]) - 1;
    d = Number(m[3]);
    if (m[4] !== undefined) {
      hh = Number(m[4]);
      mm = Number(m[5]);
    }
  } else {
    m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?)?/.exec(s);
    if (!m) return undefined;
    const month = MONTHS[(m[1] as string).toLowerCase()];
    if (month === undefined) return undefined;
    y = Number(m[3]);
    mo = month;
    d = Number(m[2]);
    if (m[4] !== undefined) {
      hh = Number(m[4]) % 12;
      mm = Number(m[5]);
      if (m[6] !== undefined && /p/i.test(m[6])) hh += 12;
      else if (m[6] === undefined) hh = Number(m[4]);
    }
  }
  const t = Date.UTC(y, mo, d, hh, mm);
  const back = new Date(t);
  // Refuse a day that does not exist (February 30 rolls over in Date.UTC).
  if (!Number.isFinite(t) || back.getUTCMonth() !== mo || back.getUTCDate() !== d || y < 1990 || y > 2200) return undefined;
  return back.toISOString();
}

const DATE_KEYS: readonly { key: RegExp; detail: string }[] = [
  { key: /^created( time| at| on)?$/i, detail: "Created" },
  { key: /^(date|written|published)$/i, detail: "Date" },
  { key: /^(last edited( time| at| on)?|updated|modified)$/i, detail: "Last edited" },
];

/** The date a page names in its property block (the `Key: value` lines under the title), oldest-claiming key first. */
export function notionPageDate(text: string): { at: IsoDate; detail: string } | undefined {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i] as string).trim() === "") i++;
  if (i < lines.length && /^#\s/.test(lines[i] as string)) i++;
  while (i < lines.length && (lines[i] as string).trim() === "") i++;
  const props: [string, string][] = [];
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "") break;
    const m = /^([A-Za-z][A-Za-z0-9 _-]{0,40}):\s*(.*)$/.exec(line);
    if (!m) return undefined; // not a property block: the first body paragraph
    props.push([m[1] as string, m[2] as string]);
  }
  for (const k of DATE_KEYS) {
    const hit = props.find(([key]) => k.key.test(key.trim()));
    const at = hit ? parseNotionDate(hit[1]) : undefined;
    if (at !== undefined) return { at, detail: k.detail };
  }
  return undefined;
}

function titleOf(text: string, fallback: string): string {
  const fm = splitFrontmatter(text);
  const h = /^#\s+(.+?)\s*#*\s*$/m.exec(fm.body);
  return (h?.[1] ?? fallback).trim() || fallback;
}

const refCache = new WeakMap<ExportSource, Map<string, NotionPageRef>>();

function refsOf(src: ExportSource): Map<string, NotionPageRef> {
  let m = refCache.get(src);
  if (!m) {
    m = new Map(notionPages(src.members).map((p) => [p.member.name, p]));
    refCache.set(src, m);
  }
  return m;
}

export const notionFormat: DocExportFormat = {
  source: "notion",
  label: "Notion",
  stateName: "notion",
  enabled: (s) => s.sources.notion.enabled,
  pages: (members) => notionPages(members).map((p) => p.member),
  async read(src: ExportSource, member: ExportMember, ctx: ImportContext): Promise<ParsedPage | null> {
    const ref = refsOf(src).get(member.name);
    if (!ref) return null;
    if (ref.csv && member.size > ctx.settings.sources.raw.maxJsonBytes) return null;
    const bytes = await readMemberBytes(src, member.name);
    const text = bytes.toString("utf8").replace(/^﻿/, "");
    if (text.trim() === "") return null;
    const project = ref.ancestors[0] ?? ref.name.title;
    const page: ParsedPage = {
      key: ref.name.id !== undefined ? `${ref.name.id}${ref.csv ? ":csv" : ""}` : ref.rel,
      title: ref.csv ? ref.name.title : titleOf(text, ref.name.title),
      text,
      path: ref.rel,
      project,
      folder: ref.ancestors,
      passages: !ref.csv,
    };
    const claim = ref.csv ? undefined : notionPageDate(text);
    if (claim) page.claim = { at: claim.at, type: "source-timestamp", detail: claim.detail };
    return page;
  },
};

export class NotionImporter implements Importer<NotionSelector> {
  readonly kind = "notion" as const;
  readonly source = "notion" as const;
  readonly label = "Notion";

  async discover(sel: NotionSelector, _ctx: ImportContext): Promise<DiscoveredUnit[]> {
    return discoverExport(sel.file, this.label);
  }

  async run(sel: NotionSelector, ctx: ImportContext): Promise<SourceImportStats> {
    return runDocExport(ctx, sel.file, notionFormat);
  }
}
