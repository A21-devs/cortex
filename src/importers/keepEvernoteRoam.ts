/**
 * Notes exports: Google Keep (Takeout), Evernote (.enex) and Roam (JSON). Each note or page is one DOCUMENT entry
 * in the person's own voice; notes are grouped by project (a Keep label, an Evernote notebook file) and stored in
 * groups of 200. A note that changed in a newer export becomes a new version linked to the old one (the same
 * native id, a new text).
 *
 *  - Keep: `Takeout/Keep/<note>.json`. Notes in the trash are left out. Dates: the creation time is the note's
 *    date (strong); a note with only an edit time has that as an upper bound.
 *  - Evernote: the text of each note's ENML (checkboxes kept as `[ ]` / `[x]`; encrypted blocks left out, never
 *    decrypted; attachments listed by file name, their data never read). `created` is the date, `updated` an
 *    upper bound. The file is read in pieces, so a notebook with large attachments is not held whole.
 *  - Roam: `Export All › JSON`. Each page is its outline as an indented list. `create-time` is the date; a daily
 *    page without one is dated from its title (a day, medium).
 */
import type { DateStrength, IsoDate } from "../shared/types";
import { baseName, civilToIso, fingerprint, isObj, isoFromMs, noteUnits, str, stem, turnOf, type ChatExportDef, type DataReader } from "./chatExportKit";
import { htmlToText } from "./html";
import { mimeOf, type ExportConversation, type ExportSource, type ExportTurn } from "./zip";

interface Note {
  project?: string;
  turn: ExportTurn;
}

/** The note as it will be stored: a key that changes with the text, and a native id that does not. */
function noteTurn(kind: string, nativeId: string, title: string, text: string, at: IsoDate | undefined, strength: DateStrength, detail: string, human: ExportTurn["speaker"], attachments: { name: string; mime: string }[]): ExportTurn {
  const native = `${kind}:${nativeId}`;
  const t = turnOf({ key: `${native}@${fingerprint(title, text)}`, text, speaker: { speaker: human }, at, strength, detail, attachments, document: { title }, raw: [title, text] });
  t.nativeId = native;
  return t;
}

// ───────────────────────────── Google Keep ─────────────────────────────

const KEEP_FILE = /(?:^|\/)Keep\/[^/]+\.json$/i;

/**
 * The Keep notes among a list of member names: anything under a `Keep/` folder, or, when the person chose the Keep
 * folder itself (so the folder name is not part of the paths), a note `.json` that has its twin `.html` beside it.
 */
export function keepFiles(names: readonly string[]): string[] {
  const under = names.filter((n) => KEEP_FILE.test(n));
  if (under.length > 0) return under;
  const all = new Set(names.map((n) => n.toLowerCase()));
  return names.filter((n) => /\.json$/i.test(n) && all.has(n.replace(/\.json$/i, ".html").toLowerCase()));
}

export function isKeepName(names: readonly string[]): boolean {
  return keepFiles(names).length > 0;
}

function usec(v: unknown): IsoDate | undefined {
  const n = typeof v === "number" ? v : Number(str(v));
  return Number.isFinite(n) && n > 0 ? isoFromMs(Math.floor(n / 1000)) : undefined;
}

export function keepNote(o: Record<string, unknown>): { title: string; text: string; created?: IsoDate; edited?: IsoDate; label?: string; attachments: { name: string; mime: string }[] } | null {
  if (o.isTrashed === true) return null;
  const lines: string[] = [];
  if (typeof o.textContent === "string" && o.textContent.trim() !== "") lines.push(o.textContent.trim());
  if (Array.isArray(o.listContent)) {
    for (const it of o.listContent) {
      if (!isObj(it)) continue;
      const s = str(it.text).trim();
      if (s !== "") lines.push(`- [${it.isChecked === true ? "x" : " "}] ${s}`);
    }
  }
  if (Array.isArray(o.annotations)) {
    for (const a of o.annotations) {
      if (isObj(a) && /^https?:/i.test(str(a.url))) lines.push(`Link: ${str(a.url)}`);
    }
  }
  const attachments = (Array.isArray(o.attachments) ? o.attachments : []).filter(isObj).map((a) => ({ name: baseName(str(a.filePath)) || "attachment", mime: str(a.mimetype) || mimeOf(str(a.filePath)) })).slice(0, 20);
  const title = str(o.title).trim();
  const text = lines.join("\n");
  if (title === "" && text === "" && attachments.length === 0) return null;
  const label = Array.isArray(o.labels) ? o.labels.filter(isObj).map((l) => str(l.name).trim()).find((s) => s !== "") : undefined;
  const out: { title: string; text: string; created?: IsoDate; edited?: IsoDate; label?: string; attachments: { name: string; mime: string }[] } = { title, text, attachments };
  const created = usec(o.createdTimestampUsec);
  const edited = usec(o.userEditedTimestampUsec);
  if (created) out.created = created;
  if (edited) out.edited = edited;
  if (label) out.label = label;
  return out;
}

export const keep: ChatExportDef = {
  key: "keep",
  label: "Google Keep",
  countEntries: true,
  recognise: isKeepName,
  async parse(src, env) {
    const notes: Note[] = [];
    for (const f of keepFiles(src.members.map((m) => m.name)).sort()) {
      let v: unknown;
      try {
        v = await env.reader.json(f, 8 * 1024 * 1024);
      } catch {
        continue; // one damaged note does not stop the rest
      }
      if (!isObj(v)) continue;
      const n = keepNote(v);
      if (!n) continue;
      const title = n.title || stem(f);
      const at = n.created ?? n.edited;
      const strength: DateStrength = n.created ? "strong" : "bound";
      const turn = noteTurn("keep", stem(f), title, n.text, at, strength, n.created ? "Keep created" : "Keep last edited", env.human, n.attachments);
      notes.push({ ...(n.label ? { project: n.label } : {}), turn });
    }
    return noteUnits("keep", notes, "Google Keep");
  },
};

// ───────────────────────────── Evernote ─────────────────────────────

const MAX_NOTE_CHARS = 64 * 1024 * 1024;

/** `<note>…</note>` blocks of an enex file, read piece by piece. A note over the cap is skipped. */
export async function* enexNotes(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buf = "";
  let skipping = false;
  for await (const piece of chunks) {
    buf += piece;
    for (;;) {
      if (skipping) {
        const end = buf.indexOf("</note>");
        if (end < 0) {
          buf = buf.slice(-8);
          break;
        }
        buf = buf.slice(end + 7);
        skipping = false;
        continue;
      }
      const start = buf.indexOf("<note>");
      if (start < 0) {
        buf = buf.slice(-6);
        break;
      }
      const end = buf.indexOf("</note>", start);
      if (end < 0) {
        buf = buf.slice(start);
        if (buf.length > MAX_NOTE_CHARS) {
          skipping = true;
          buf = "";
        }
        break;
      }
      yield buf.slice(start, end + 7);
      buf = buf.slice(end + 7);
    }
  }
}

function between(s: string, open: string, close: string, from = 0): { text: string; end: number } | null {
  const a = s.indexOf(open, from);
  if (a < 0) return null;
  const b = s.indexOf(close, a + open.length);
  if (b < 0) return null;
  return { text: s.slice(a + open.length, b), end: b + close.length };
}

/** Resources (attachments) cut out of a note: their file names, and the note without their data. */
function withoutResources(note: string): { rest: string; names: string[] } {
  const names: string[] = [];
  let rest = "";
  let pos = 0;
  for (;;) {
    const a = note.indexOf("<resource>", pos);
    if (a < 0) break;
    const b = note.indexOf("</resource>", a);
    if (b < 0) break;
    rest += note.slice(pos, a);
    const f = between(note.slice(a, b), "<file-name>", "</file-name>");
    if (f) names.push(htmlToText(f.text).trim());
    pos = b + 11;
  }
  return { rest: rest + note.slice(pos), names: names.filter((n) => n !== "") };
}

function enexTime(s: string | undefined): IsoDate | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec((s ?? "").trim());
  return m ? civilToIso(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : undefined;
}

/** ENML (the note body) as plain text. */
export function enmlText(enml: string): string {
  const cleaned = enml
    .replace(/<en-crypt[\s\S]*?<\/en-crypt>/g, "[encrypted text left out]")
    .replace(/<en-todo\s+checked\s*=\s*["']true["'][^>]*\/?>/gi, "[x] ")
    .replace(/<en-todo[^>]*\/?>/gi, "[ ] ")
    .replace(/<en-media[^>]*\/?>/gi, "");
  return htmlToText(cleaned).trim();
}

export interface EnexNote {
  title: string;
  text: string;
  created?: IsoDate;
  updated?: IsoDate;
  attachments: string[];
}

export function parseEnexNote(raw: string): EnexNote | null {
  const { rest, names } = withoutResources(raw);
  const title = between(rest, "<title>", "</title>");
  const content = between(rest, "<content>", "</content>");
  let body = content?.text ?? "";
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(body);
  if (cdata) body = cdata[1] as string;
  else body = body.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const out: EnexNote = { title: htmlToText(title?.text ?? "").trim(), text: enmlText(body), attachments: names };
  const created = enexTime(between(rest, "<created>", "</created>")?.text);
  const updated = enexTime(between(rest, "<updated>", "</updated>")?.text);
  if (created) out.created = created;
  if (updated) out.updated = updated;
  if (out.title === "" && out.text === "" && names.length === 0) return null;
  return out;
}

export const evernote: ChatExportDef = {
  key: "evernote",
  label: "Evernote",
  countEntries: true,
  recognise: (names) => names.some((n) => /\.enex$/i.test(n)),
  async parse(src, env) {
    const notes: Note[] = [];
    for (const f of src.members.map((m) => m.name).filter((n) => /\.enex$/i.test(n)).sort()) {
      const notebook = stem(f).trim();
      for await (const raw of enexNotes(env.reader.chunks(f))) {
        const n = parseEnexNote(raw);
        if (!n) continue;
        const title = n.title || "Untitled";
        const at = n.created ?? n.updated;
        const turn = noteTurn("ev", fingerprint(notebook, title, n.created), title, n.text, at, n.created ? "strong" : "bound", n.created ? "Evernote created" : "Evernote last updated", env.human, n.attachments.map((a) => ({ name: a, mime: mimeOf(a) })));
        notes.push({ ...(notebook !== "" ? { project: notebook } : {}), turn });
      }
    }
    return noteUnits("evernote", notes, "Evernote");
  },
};

// ───────────────────────────── Roam ─────────────────────────────

const MONTHS: Readonly<Record<string, number>> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/** A daily page title ("March 1st, 2024") as that day; undefined for any other title. */
export function roamDailyTitle(title: string): IsoDate | undefined {
  const m = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th),\s+(\d{4})$/.exec(title.trim());
  const mo = m ? MONTHS[(m[1] as string).toLowerCase()] : undefined;
  return m && mo ? civilToIso(Number(m[3]), mo, Number(m[2])) : undefined;
}

function roamLines(blocks: unknown, depth: number, out: string[], budget: { n: number }): void {
  if (!Array.isArray(blocks)) return;
  for (const b of blocks) {
    if (!isObj(b) || budget.n <= 0) continue;
    budget.n--;
    const s = str(b.string).replace(/\n/g, "\n" + "  ".repeat(depth + 1));
    const heading = typeof b.heading === "number" && b.heading >= 1 && b.heading <= 3 ? "#".repeat(b.heading) + " " : "";
    if (s.trim() !== "") out.push(`${"  ".repeat(depth)}- ${heading}${s}`);
    roamLines(b.children, depth + 1, out, budget);
  }
}

function earliest(blocks: unknown, depth = 0): number | undefined {
  if (!Array.isArray(blocks) || depth > 40) return undefined;
  let best: number | undefined;
  for (const b of blocks) {
    if (!isObj(b)) continue;
    const t = typeof b["create-time"] === "number" ? b["create-time"] : undefined;
    for (const c of [t, earliest(b.children, depth + 1)]) if (c !== undefined && (best === undefined || c < best)) best = c;
  }
  return best;
}

export function looksLikeRoam(head: string): boolean {
  return /^\s*\[\s*\{/.test(head) && /"(?:title|uid)"\s*:/.test(head) && /"(?:children|create-time|edit-time|string)"\s*:/.test(head);
}

export const roam: ChatExportDef = {
  key: "roam",
  label: "Roam",
  countEntries: true,
  recognise: (names) => names.length === 1 && /\.json$/i.test(baseName(names[0] as string)) && !/^(?:result|conversations|messages|users|channels)\.json$/i.test(baseName(names[0] as string)),
  async sniff(src: ExportSource, reader: DataReader) {
    const name = src.members[0]?.name;
    return name !== undefined && looksLikeRoam(await reader.head(name));
  },
  async parse(src, env) {
    const notes: Note[] = [];
    const name = src.members[0]?.name;
    if (name === undefined) return [];
    const root = await env.reader.json(name);
    if (!Array.isArray(root)) return [];
    for (const page of root) {
      if (!isObj(page)) continue;
      const title = str(page.title).trim();
      if (title === "") continue;
      const lines: string[] = [];
      roamLines(page.children, 0, lines, { n: 200_000 });
      if (lines.length === 0) continue;
      const created = isoFromMs(page["create-time"]) ?? isoFromMs(earliest(page.children));
      const daily = roamDailyTitle(title);
      const edited = isoFromMs(page["edit-time"]);
      const at = created ?? daily ?? edited;
      const strength: DateStrength = created ? "strong" : daily ? "medium" : "bound";
      const detail = created ? "Roam created" : daily ? "daily page title" : "Roam last edited";
      notes.push({ turn: noteTurn("roam", str(page.uid) || title, title, lines.join("\n"), at, strength, detail, env.human, []) });
    }
    return noteUnits("roam", notes, "Roam");
  },
};

export type { ExportConversation };
