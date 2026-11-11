/**
 * Google Docs importer: a Google Takeout (Drive) export, an unzipped folder of it, a folder of documents, or one
 * .docx file. Owner: E3.
 *
 * Takeout writes each Google Doc as `Takeout/Drive/<folders>/<Name>.docx` (the default) or `.html`. Read here:
 *  - .docx: the text of `word/document.xml` (paragraphs, headings as markdown `#`, list items as `-`, tables as
 *    rows joined by ` | `), and the dates in `docProps/core.xml`: the creation time is the page's own date, the
 *    last-modified time only an upper bound. No macros, embedded files or images are ever read or run;
 *  - .html: the text of the page (the same extractor as the chat exports); it carries no dates;
 *  - the folder tree: `project` = the top folder under Drive (none for a loose document), `folder` = ["Google Docs", ...].
 * The docx is a zip inside the export's own zip, so it is read from memory by a small zip reader here (stored and
 * deflated members only, no zip64, no encryption, a hard cap on what is inflated). Spreadsheets, slides, `.gdoc`
 * shortcuts and the Takeout bookkeeping files are not documents and are left alone.
 */
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import type { SourceImportStats, SourceSelector } from "../shared/protocol/runner";
import type { IsoDate } from "../shared/types";
import { htmlToText } from "./html";
import { type DiscoveredUnit, type ImportContext, type Importer } from "./common";
import { readMemberBytes, runDocExport, type DocExportFormat, type ParsedPage } from "./exportDocs";
import { discoverExport, type ExportMember, type ExportSource } from "./zip";

export type GoogleDocsSelector = Extract<SourceSelector, { kind: "google-docs" }>;

/** Most a docx part may inflate to (a text part of a real document is far smaller). */
export const MAX_DOCX_PART_BYTES = 64 * 1024 * 1024;

// ───────────────────────────── a small in-memory zip reader ─────────────────────────────

/** The named members of a zip held in memory ({} entries that are missing, encrypted, zip64 or too large are left out). */
export function readZipMembers(buf: Buffer, names: readonly string[], cap = MAX_DOCX_PART_BYTES): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const want = new Set(names.map((n) => n.toLowerCase()));
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return out;
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || p === 0xffffffff) return out;
  for (let n = 0; n < total && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const comp = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8").replace(/\\/g, "/");
    p += 46 + nameLen + extraLen + commentLen;
    if (!want.has(name.toLowerCase()) || out.has(name) || (flags & 1) !== 0 || size > cap || local + 30 > buf.length) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + comp > buf.length) continue;
    const data = buf.subarray(start, start + comp);
    try {
      if (method === 0) out.set(name, Buffer.from(data));
      else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: cap }));
    } catch {
      // a damaged part is left out
    }
  }
  return out;
}

// ───────────────────────────── word/document.xml → text ─────────────────────────────

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const TOKEN = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:t(?:\s[^>]*)?\/>|<w:tab\s*\/>|<w:(?:br|cr)\b[^>]*\/>|<w:pStyle\s+w:val="([^"]*)"\s*\/>|<w:numPr>|<(\/?)w:(p|tbl|tr|tc)\b[^>]*?(\/?)>/g;

/** The text of a docx body. */
export function docxText(xml: string): string {
  type Para = { text: string; style: string; list: boolean };
  const blocks: { text: string; list: boolean }[] = [];
  const cellStack: string[][] = [];
  const rowStack: string[][] = [];
  let para: Para | null = null;
  const emit = (text: string, list: boolean): void => {
    const top = cellStack[cellStack.length - 1];
    if (top) top.push(text);
    else blocks.push({ text, list });
  };
  for (const m of xml.matchAll(TOKEN)) {
    if (m[4] !== undefined) {
      const closing = m[3] === "/";
      const tag = m[4];
      if (m[5] === "/") continue; // <w:p/>: an empty paragraph
      if (tag === "p") {
        if (!closing) para = { text: "", style: "", list: false };
        else if (para) {
          const text = para.text.replace(/[ \t]+$/g, "");
          const h = /^(?:Heading\s*(\d)|Title)$/i.exec(para.style);
          if (text.trim() !== "") {
            if (h) emit(`${"#".repeat(h[1] !== undefined ? Math.min(6, Number(h[1])) : 1)} ${text.trim()}`, false);
            else emit(para.list ? `- ${text.trim()}` : text, para.list);
          }
          para = null;
        }
      } else if (tag === "tc") {
        if (!closing) cellStack.push([]);
        else {
          const cell = (cellStack.pop() ?? []).join(" ").trim();
          rowStack[rowStack.length - 1]?.push(cell);
        }
      } else if (tag === "tr") {
        if (!closing) rowStack.push([]);
        else {
          const row = rowStack.pop() ?? [];
          if (row.some((c) => c !== "")) emit(row.join(" | "), false);
        }
      }
    } else if (m[2] !== undefined) {
      if (para) para.style = m[2];
    } else if (m[0] === "<w:numPr>") {
      if (para) para.list = true;
    } else if (/^<w:tab/.test(m[0])) {
      if (para) para.text += "\t";
    } else if (/^<w:(br|cr)/.test(m[0])) {
      if (para) para.text += "\n";
    } else if (para) para.text += decodeXml(m[1] ?? "");
  }
  const out: string[] = [];
  blocks.forEach((b, i) => {
    out.push(i > 0 && b.list && (blocks[i - 1] as { list: boolean }).list ? `\n${b.text}` : i > 0 ? `\n\n${b.text}` : b.text);
  });
  return out.join("").trim();
}

export interface DocxCore {
  title?: string;
  created?: IsoDate;
  modified?: IsoDate;
}

function isoOf(v: string | undefined): IsoDate | undefined {
  if (v === undefined) return undefined;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) && t > Date.UTC(1990, 0, 1) && t < Date.UTC(2200, 0, 1) ? new Date(t).toISOString() : undefined;
}

/** docProps/core.xml. */
export function docxCore(xml: string): DocxCore {
  const get = (tag: string): string | undefined => {
    const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(xml);
    return m ? decodeXml(m[1] as string).trim() : undefined;
  };
  const out: DocxCore = {};
  const title = get("dc:title");
  if (title) out.title = title;
  const created = isoOf(get("dcterms:created"));
  const modified = isoOf(get("dcterms:modified"));
  if (created) out.created = created;
  if (modified) out.modified = modified;
  return out;
}

// ───────────────────────────── the export ─────────────────────────────

const DOC_EXT = /\.(docx|html?)$/i;

export interface GoogleDocRef {
  member: ExportMember;
  /** Path below `Takeout/Drive/`. */
  rel: string;
  ancestors: string[];
  stem: string;
  html: boolean;
  /** A lone .docx: its members are the document itself. */
  single: boolean;
}

function trimTakeout(name: string): string {
  const n = name.replace(/^Takeout\/Drive\//i, "").replace(/^Takeout\//i, "");
  return n;
}

/** Does this list of members hold Google Docs (a Takeout Drive tree, or documents)? */
export function looksLikeGoogleDocs(names: readonly string[]): boolean {
  if (names.some((n) => n.toLowerCase() === "word/document.xml")) return true;
  const docs = names.filter((n) => DOC_EXT.test(n) && !/(^|\/)archive_browser\.html$/i.test(n) && !/(^|\/)~\$/.test(n));
  if (docs.length === 0) return false;
  return names.some((n) => /^Takeout\/Drive\//i.test(n)) || docs.some((n) => /\.docx$/i.test(n));
}

export function googleDocPages(members: readonly ExportMember[], exportPath = ""): GoogleDocRef[] {
  if (members.some((m) => m.name.toLowerCase() === "word/document.xml")) {
    const m = members.find((x) => x.name.toLowerCase() === "word/document.xml") as ExportMember;
    return [{ member: m, rel: path.basename(exportPath) || "document.docx", ancestors: [], stem: path.basename(exportPath).replace(/\.[^.]+$/, "") || "Document", html: false, single: true }];
  }
  const out: GoogleDocRef[] = [];
  for (const m of members) {
    if (!DOC_EXT.test(m.name) || /(^|\/)archive_browser\.html$/i.test(m.name) || /(^|\/)~\$/.test(m.name)) continue;
    const rel = trimTakeout(m.name);
    const segs = rel.split("/");
    const file = segs[segs.length - 1] as string;
    out.push({ member: m, rel, ancestors: segs.slice(0, -1), stem: file.replace(/\.[^.]+$/, ""), html: /\.html?$/i.test(file), single: false });
  }
  return out;
}

const refCache = new WeakMap<ExportSource, Map<string, GoogleDocRef>>();

function refsOf(src: ExportSource): Map<string, GoogleDocRef> {
  let m = refCache.get(src);
  if (!m) {
    m = new Map(googleDocPages(src.members, src.path).map((p) => [p.member.name, p]));
    refCache.set(src, m);
  }
  return m;
}

function titleOfHtml(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? htmlToText(m[1] as string).trim() : "";
  return t !== "" ? t : undefined;
}

export const googleDocsFormat: DocExportFormat = {
  source: "google-docs",
  label: "Google Docs",
  stateName: "google-docs",
  enabled: (s) => s.sources.googleDocs.enabled,
  pages: (members) => googleDocPages(members).map((p) => p.member),
  async read(src: ExportSource, member: ExportMember): Promise<ParsedPage | null> {
    const ref = refsOf(src).get(member.name);
    if (!ref) return null;
    const folder = ref.ancestors;
    const base = { folder, ...(ref.ancestors[0] !== undefined ? { project: ref.ancestors[0] } : {}), path: ref.rel };
    if (ref.html) {
      const html = (await readMemberBytes(src, member.name)).toString("utf8");
      const text = htmlToText(html);
      return text.trim() === "" ? null : { ...base, key: ref.rel, title: titleOfHtml(html) ?? ref.stem, text, passages: false };
    }
    let docx: Map<string, Buffer>;
    if (ref.single) {
      docx = new Map();
      for (const n of ["word/document.xml", "docProps/core.xml"]) {
        try {
          docx.set(n, await readMemberBytes(src, n, MAX_DOCX_PART_BYTES));
        } catch {
          // no such part
        }
      }
    } else {
      docx = readZipMembers(await readMemberBytes(src, member.name), ["word/document.xml", "docProps/core.xml"]);
    }
    const body = docx.get("word/document.xml");
    if (!body) return null;
    const text = docxText(body.toString("utf8"));
    if (text === "") return null;
    const core = docxCore(docx.get("docProps/core.xml")?.toString("utf8") ?? "");
    const page: ParsedPage = { ...base, key: ref.rel, title: core.title && core.title.toLowerCase() !== "untitled" ? core.title : ref.stem, text, passages: true };
    if (core.created) {
      page.claim = { at: core.created, type: "source-timestamp", detail: "document properties: created" };
      if (core.modified) page.bound = { at: core.modified, detail: "document properties: last modified" };
    } else if (core.modified) page.bound = { at: core.modified, detail: "document properties: last modified" };
    return page;
  },
};

export class GoogleDocsImporter implements Importer<GoogleDocsSelector> {
  readonly kind = "google-docs" as const;
  readonly source = "google-docs" as const;
  readonly label = "Google Docs";

  async discover(sel: GoogleDocsSelector, _ctx: ImportContext): Promise<DiscoveredUnit[]> {
    return discoverExport(sel.file, this.label);
  }

  async run(sel: GoogleDocsSelector, ctx: ImportContext): Promise<SourceImportStats> {
    return runDocExport(ctx, sel.file, googleDocsFormat);
  }
}
