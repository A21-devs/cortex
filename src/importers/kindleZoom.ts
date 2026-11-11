/**
 * Reading and meeting exports: Kindle clippings (`My Clippings.txt`) and Zoom chats and transcripts.
 *
 * Kindle: each highlight is one DOCUMENT entry, grouped by book (the project). A highlight is the book author's
 * text that the person chose, so it is "another person" (named after the author); the person's own notes take the
 * person's speaker. Bookmarks carry no text and are left out. "Added on" is printed without a time zone and is
 * read as written (medium). Clippings are read in English ("Your Highlight on …", "Added on …"); another language's
 * clippings file is reported as not recognised.
 *
 * Zoom: a saved chat (`10:05:03  From Name to Everyone: text`) or a transcript (`.vtt`, cues of `Name: text`,
 * neighbouring cues of one speaker joined). Neither carries a date, so it comes from the file or folder name when
 * that has one (`GMT20240301-120000_…`, `2024-03-01 12.00.00 …`): a day with the time as written is medium, the
 * transcript's offsets from a start time are medium, from a day alone weak. With no date in the name the only date
 * is when the export was saved, which is an upper bound and never the date of the words.
 */
import type { DateStrength, IsoDate } from "../shared/types";
import { baseName, civilToIso, conversationOf, fingerprint, KeyMaker, noteUnits, speakerResolver, stem, turnOf, type ChatExportDef, type ChatParseEnv } from "./chatExportKit";
import type { ExportConversation, ExportTurn } from "./zip";

// ───────────────────────────── Kindle ─────────────────────────────

const KINDLE_FILE = /^my clippings(?: \(\d+\))?\.txt$/i;
const MONTHS: Readonly<Record<string, number>> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/** "Monday, March 4, 2024 10:15:22 PM" or "Monday, 4 March 2024 22:15:22" as written (no time zone). */
export function kindleDate(raw: string): IsoDate | undefined {
  const s = raw.trim().replace(/^[A-Za-z]+,\s*/, "");
  let m = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec(s);
  let mo: number | undefined;
  let d: number;
  let y: number;
  let hh: number;
  let mi: number;
  let ss: number;
  let ap: string | undefined;
  if (m) {
    mo = MONTHS[(m[1] as string).toLowerCase()];
    [d, y, hh, mi, ss, ap] = [Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), m[7]];
  } else {
    m = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec(s);
    if (!m) return undefined;
    mo = MONTHS[(m[2] as string).toLowerCase()];
    [d, y, hh, mi, ss, ap] = [Number(m[1]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), m[7]];
  }
  if (mo === undefined) return undefined;
  if (ap !== undefined) hh = (hh % 12) + (/p/i.test(ap) ? 12 : 0);
  return civilToIso(y, mo, d, hh, mi, ss);
}

export interface Clipping {
  book: string;
  author: string;
  kind: "highlight" | "note" | "bookmark";
  where: string;
  at?: IsoDate;
  text: string;
}

export function parseClippings(text: string): Clipping[] {
  const out: Clipping[] = [];
  for (const block of text.replace(/^﻿/, "").split(/\n={5,}\s*(?:\n|$)/)) {
    const lines = block.split("\n");
    while (lines.length > 0 && (lines[0] as string).trim() === "") lines.shift();
    if (lines.length < 2) continue;
    const titleLine = (lines[0] as string).trim();
    const meta = /^-\s*Your\s+(Highlight|Note|Bookmark)\b(.*)$/i.exec((lines[1] as string).trim());
    if (!meta) continue;
    const added = /Added on\s+(.+)$/i.exec(meta[2] as string);
    const parts = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(titleLine);
    const loc = /\blocation\s+([\d-]+)/i.exec(meta[2] as string)?.[1] ?? /\bpage\s+([\w-]+)/i.exec(meta[2] as string)?.[1] ?? "";
    const clip: Clipping = {
      book: ((parts?.[1] ?? titleLine) || "Untitled").trim(),
      author: (parts?.[2] ?? "").trim(),
      kind: (meta[1] as string).toLowerCase() as Clipping["kind"],
      where: loc,
      text: lines.slice(2).join("\n").trim(),
    };
    const at = added ? kindleDate(added[1] as string) : undefined;
    if (at) clip.at = at;
    out.push(clip);
  }
  return out;
}

export const kindle: ChatExportDef = {
  key: "kindle",
  label: "Kindle highlights",
  countEntries: true,
  recognise: (names) => names.some((n) => KINDLE_FILE.test(baseName(n))),
  async parse(src, env) {
    const notes: { project?: string; turn: ExportTurn }[] = [];
    for (const f of src.members.map((m) => m.name).filter((n) => KINDLE_FILE.test(baseName(n))).sort()) {
      const clips = parseClippings(await env.reader.text(f));
      const keys = new KeyMaker("kindle");
      for (const c of clips) {
        if (c.kind === "bookmark" || c.text === "") continue;
        const own = c.kind === "note";
        const sp = own ? { speaker: env.human } : { speaker: "other" as const, detail: (c.author || c.book).slice(0, 120) };
        const key = keys.next(c.book, c.kind, c.where, c.at, c.text);
        const turn = turnOf({ key, text: c.text, speaker: sp, at: c.at, strength: "medium", detail: "Added on (no time zone)", document: { title: c.author ? `${c.book} (${c.author})` : c.book }, raw: [c.book, c.kind, c.where, c.at, c.text] });
        notes.push({ project: c.book, turn });
      }
    }
    return noteUnits("kindle", notes, "Kindle highlights");
  },
};

// ───────────────────────────── Zoom ─────────────────────────────

export function isZoomName(names: readonly string[]): boolean {
  return names.some((n) => {
    const b = baseName(n);
    if (/^WhatsApp/i.test(b) || /^_chat\.txt$/i.test(b)) return false;
    return /\.vtt$/i.test(b) || /^meeting_saved_chat\.txt$/i.test(b) || /^GMT\d{8}-\d{6}.*chat.*\.txt$/i.test(b);
  });
}

/** The start of a meeting from a file or folder name: a day and, when named, a time. */
export function zoomStart(name: string): { day: [number, number, number]; time?: [number, number, number]; utc: boolean } | null {
  const parts = name.split("/").reverse();
  for (const p of parts) {
    const g = /GMT(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(p);
    if (g) return { day: [Number(g[1]), Number(g[2]), Number(g[3])], time: [Number(g[4]), Number(g[5]), Number(g[6])], utc: true };
    const a = /(\d{4})-(\d{2})-(\d{2})[ T_-]+(\d{2})[.:](\d{2})[.:](\d{2})/.exec(p);
    if (a) return { day: [Number(a[1]), Number(a[2]), Number(a[3])], time: [Number(a[4]), Number(a[5]), Number(a[6])], utc: false };
    const d = /(\d{4})-(\d{2})-(\d{2})/.exec(p);
    if (d) return { day: [Number(d[1]), Number(d[2]), Number(d[3])], utc: false };
  }
  return null;
}

const CHAT_LINE = /^(\d{1,2}):(\d{2}):(\d{2})\s+From\s+(.+?)(?:\s+to\s+(.+?))?\s*:\s?(.*)$/;

export function parseZoomChat(text: string, member: string, env: ChatParseEnv): ExportConversation | null {
  const start = zoomStart(member);
  const who = speakerResolver(env);
  const title = stem(member).replace(/_/g, " ").trim() || "Zoom chat";
  const native = `zoom:${fingerprint(member)}`;
  const keys = new KeyMaker(native);
  const msgs: { h: number; m: number; s: number; name: string; text: string[] }[] = [];
  let cur: (typeof msgs)[number] | null = null;
  for (const line of text.split("\n")) {
    const m = CHAT_LINE.exec(line.replace(/\t/g, " "));
    if (m) {
      cur = { h: Number(m[1]), m: Number(m[2]), s: Number(m[3]), name: (m[4] as string).trim(), text: [m[6] as string] };
      msgs.push(cur);
    } else if (cur && line.trim() !== "") cur.text.push(line);
  }
  const turns: ExportTurn[] = [];
  for (const m of msgs) {
    const body = m.text.join("\n").trim();
    if (body === "") continue;
    let at: IsoDate | undefined;
    let strength: DateStrength = "bound";
    let detail = "time the export was saved";
    if (start) {
      at = civilToIso(start.day[0], start.day[1], start.day[2], m.h, m.m, m.s);
      strength = "medium";
      detail = "day from the file name, time as written in the chat";
    } else if (env.exportTime) at = env.exportTime;
    turns.push(turnOf({ key: keys.next(`${m.h}:${m.m}:${m.s}`, m.name, body), text: body, speaker: who(m.name), at, strength, detail, raw: [m.h, m.m, m.s, m.name, body] }));
  }
  return turns.length > 0 ? conversationOf(native, title, turns) : null;
}

const CUE = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})\s+-->\s+/;

export function parseZoomTranscript(text: string, member: string, env: ChatParseEnv): ExportConversation | null {
  const start = zoomStart(member);
  const who = speakerResolver(env);
  const title = stem(member).replace(/_/g, " ").trim() || "Zoom transcript";
  const native = `zoom:${fingerprint(member)}`;
  const lines = text.split("\n");
  const cues: { ms: number; name: string; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CUE.exec(lines[i] as string);
    if (!m) continue;
    const ms = ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);
    const body: string[] = [];
    for (i++; i < lines.length && (lines[i] as string).trim() !== ""; i++) body.push(lines[i] as string);
    const joined = body.join(" ").trim();
    const v = /^<v\s+([^>]+)>(.*?)(?:<\/v>)?$/.exec(joined);
    const c = v ?? /^([^:]{1,60}):\s+(.*)$/.exec(joined);
    cues.push(c ? { ms, name: (c[1] as string).trim(), text: (c[2] as string).trim() } : { ms, name: "", text: joined });
  }
  // Neighbouring cues of one speaker are one thing said.
  const said: { ms: number; name: string; text: string }[] = [];
  for (const c of cues) {
    const last = said[said.length - 1];
    if (last && last.name === c.name) last.text += ` ${c.text}`;
    else if (c.text !== "") said.push({ ...c });
  }
  const keys = new KeyMaker(native);
  const turns: ExportTurn[] = [];
  for (const s of said) {
    if (s.text.trim() === "") continue;
    let at: IsoDate | undefined;
    let strength: DateStrength = "bound";
    let detail = "time the export was saved";
    if (start) {
      const t = start.time ?? [0, 0, 0];
      const base = civilToIso(start.day[0], start.day[1], start.day[2], t[0], t[1], t[2]);
      if (base) {
        at = new Date(Date.parse(base) + s.ms).toISOString();
        strength = start.time ? "medium" : "weak";
        detail = start.time ? "start time from the file name plus the cue's offset" : "day from the file name plus the cue's offset";
      }
    } else if (env.exportTime) at = env.exportTime;
    turns.push(turnOf({ key: keys.next(s.ms, s.name, s.text), text: s.text.trim(), speaker: who(s.name), at, strength, detail, raw: [s.ms, s.name, s.text] }));
  }
  return turns.length > 0 ? conversationOf(native, title, turns) : null;
}

export const zoom: ChatExportDef = {
  key: "zoom",
  label: "Zoom",
  recognise: isZoomName,
  async parse(src, env) {
    const out: ExportConversation[] = [];
    for (const f of src.members.map((m) => m.name).filter((n) => isZoomName([n])).sort()) {
      const text = await env.reader.text(f);
      const conv = /\.vtt$/i.test(f) ? parseZoomTranscript(text, f, env) : parseZoomChat(text, f, env);
      if (conv) out.push(conv);
    }
    return out.sort((a, b) => a.nativeId.localeCompare(b.nativeId));
  },
};
