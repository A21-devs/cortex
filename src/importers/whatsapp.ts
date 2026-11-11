/**
 * WhatsApp chat export (.txt, or the zip WhatsApp makes around it). One conversation per chat file.
 *
 * The two layouts WhatsApp writes are read: iPhone `[12/03/2024, 14:05:32] Name: text` and Android
 * `12/03/2024, 14:05 - Name: text` (24-hour or 12-hour with am/pm, any of `/ . -` between the date parts). Lines with no
 * sender (encryption notices, "X joined") and media placeholders ("image omitted") are left out; a line that
 * does not start a message continues the one before. A file name in `<attached: …>` or `… (file attached)` is
 * listed as an attachment and the file itself is never read.
 *
 * Dates: the export prints local time with no time zone, so it is read as written (medium strength). When the
 * day and month cannot be told apart in the whole file (every date has both parts 12 or below) the order is a
 * guess and the date is marked weak.
 */
import type { DateStrength, IsoDate } from "../shared/types";
import { baseName, civilToIso, conversationOf, KeyMaker, speakerResolver, stem, turnOf, type ChatExportDef, type ChatParseEnv } from "./chatExportKit";
import { mimeOf, type ExportConversation, type ExportTurn } from "./zip";

const D = "(\\d{1,4})[/.\\-](\\d{1,2})[/.\\-](\\d{1,4})";
const T = "(\\d{1,2})[:.](\\d{2})(?:[:.](\\d{2}))?(?:\\s*([AaPp])\\.?\\s?[Mm]\\.?)?";
const IOS = new RegExp(`^\\[${D},?\\s+${T}\\]\\s+(.*)$`);
const ANDROID = new RegExp(`^${D},?\\s+${T}\\s+-\\s+(.*)$`);
const MARKS = /[‎‏‪-‮]/g;

export function isWhatsAppName(name: string): boolean {
  const b = baseName(name);
  return /\.txt$/i.test(b) && (/^_chat\.txt$/i.test(b) || /^WhatsApp\s+Chat\b/i.test(b));
}

interface Header {
  a: number;
  b: number;
  c: number;
  hh: number;
  mi: number;
  ss: number;
  pm: boolean | undefined;
  rest: string;
  raw: string;
  yearFirst: boolean;
}

function header(line: string): Header | null {
  const m = IOS.exec(line) ?? ANDROID.exec(line);
  if (!m) return null;
  return { a: Number(m[1]), b: Number(m[2]), c: Number(m[3]), hh: Number(m[4]), mi: Number(m[5]), ss: m[6] === undefined ? 0 : Number(m[6]), pm: m[7] === undefined ? undefined : /p/i.test(m[7]), rest: m[8] as string, raw: line.slice(0, line.length - (m[8] as string).length), yearFirst: (m[1] as string).length === 4 };
}

type Order = "ymd" | "dmy" | "mdy";

/** Day and month order from every date of the file: a part above 12 settles it, otherwise it is a guess (day first). */
export function dateOrder(hs: readonly Pick<Header, "a" | "b">[], yearFirst: boolean): { order: Order; guessed: boolean } {
  if (yearFirst) return { order: "ymd", guessed: false };
  if (hs.some((h) => h.a > 12)) return { order: "dmy", guessed: false };
  if (hs.some((h) => h.b > 12)) return { order: "mdy", guessed: false };
  return { order: "dmy", guessed: true };
}

function when(h: Header, order: Order): IsoDate | undefined {
  let y: number;
  let mo: number;
  let d: number;
  if (order === "ymd") [y, mo, d] = [h.a, h.b, h.c];
  else {
    y = h.c < 100 ? 2000 + h.c : h.c;
    [d, mo] = order === "dmy" ? [h.a, h.b] : [h.b, h.a];
  }
  let hh = h.hh;
  if (h.pm !== undefined) hh = (hh % 12) + (h.pm ? 12 : 0);
  return civilToIso(y, mo, d, hh, h.mi, h.ss);
}

const OMITTED = /^(?:<)?(?:media|image|video|audio|sticker|gif|document|contact card|voice message|video note|location)\s+omitted(?:>)?$/i;
const DELETED = /^(?:this message was deleted|you deleted this message|<this message was edited>)$/i;
const ATTACHED = /^<attached:\s*(.+?)>$/i;
const FILE_ATTACHED = /^(.+?)\s+\(file attached\)$/i;

interface Msg {
  head: Header;
  sender: string;
  lines: string[];
}

export function parseWhatsApp(text: string, chatName: string, env: ChatParseEnv): ExportConversation | null {
  const msgs: Msg[] = [];
  const heads: Header[] = [];
  let current: Msg | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(MARKS, "").replace(/[  ]/g, " ");
    const h = header(line);
    if (h) {
      heads.push(h);
      const m = /^([^:]{1,80}?):\s(.*)$/s.exec(h.rest);
      if (m) {
        current = { head: h, sender: (m[1] as string).trim(), lines: [m[2] as string] };
        msgs.push(current);
      } else current = null; // a notice from WhatsApp itself, and its continuation lines
    } else if (current) current.lines.push(line);
  }
  if (msgs.length === 0) return null;
  const { order, guessed } = dateOrder(heads, heads[0]?.yearFirst === true);
  const strength: DateStrength = guessed ? "weak" : "medium";
  const detail = guessed ? "time as printed; day and month order guessed" : "time as printed in the export (no time zone)";
  const who = speakerResolver(env);
  const keys = new KeyMaker(`wa:${chatName}`);
  const turns: ExportTurn[] = [];
  for (const m of msgs) {
    let body = m.lines.join("\n").trim();
    const attachments: { name: string; mime: string }[] = [];
    const lines = body.split("\n");
    const kept: string[] = [];
    for (const l of lines) {
      const t = l.trim();
      const a = ATTACHED.exec(t) ?? FILE_ATTACHED.exec(t);
      if (a) attachments.push({ name: (a[1] as string).trim(), mime: mimeOf(a[1] as string) });
      else kept.push(l);
    }
    body = kept.join("\n").trim();
    if (OMITTED.test(body) || DELETED.test(body)) body = "";
    if (body === "" && attachments.length === 0) continue;
    const at = when(m.head, order);
    turns.push(turnOf({ key: keys.next(m.head.raw, m.sender, body, attachments.map((a) => a.name).join(",")), text: body, speaker: who(m.sender), at, strength, detail, attachments, raw: [m.head.raw, m.sender, body] }));
  }
  if (turns.length === 0) return null;
  return conversationOf(`wa:${chatName}`, chatName, turns);
}

function chatNameOf(member: string, env: ChatParseEnv): string {
  const s = stem(member);
  const m = /^WhatsApp\s+Chat\s*(?:with|-|–|—)?\s*(.+)$/i.exec(s);
  if (m) return (m[1] as string).trim();
  // "_chat.txt" inside a zip or folder: the container is named after the chat.
  const parent = member.includes("/") ? member.split("/").slice(-2)[0] : undefined;
  const container = parent ?? env.exportName;
  return container.replace(/^WhatsApp\s+Chat\s*(?:with|-|–|—)?\s*/i, "").trim() || "WhatsApp chat";
}

export const whatsapp: ChatExportDef = {
  key: "whatsapp",
  label: "WhatsApp",
  recognise: (names) => names.some(isWhatsAppName),
  async parse(src, env) {
    const out: ExportConversation[] = [];
    const files = src.members.map((m) => m.name).filter(isWhatsAppName).sort();
    for (const f of files) {
      const conv = parseWhatsApp(await env.reader.text(f), chatNameOf(f, env), env);
      if (conv) out.push(conv);
    }
    return out.sort((a, b) => a.nativeId.localeCompare(b.nativeId));
  },
};
