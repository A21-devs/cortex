/**
 * Telegram Desktop export (result.json, alone or inside its folder or zip). One conversation per chat.
 *
 * Both layouts are read: one chat (`{ name, type, id, messages: [...] }`) and a whole-account export
 * (`chats.list` and `left_chats.list`, each with messages). Service lines (joins, pins, calls) are left out. A message's text may be a
 * string or a list of strings and entities; it is read as plain text. Files, photos and stickers are listed by
 * name and never read. When the export names the account owner, that person's messages are "you"; otherwise a
 * sender is "you" only when the name matches Settings › You.
 *
 * Dates: `date_unixtime` is exact (strong); without it `date` has no time zone and is read as written (medium).
 */
import type { DateStrength } from "../shared/types";
import { baseName, civilToIso, conversationOf, isoFromMs, isObj, KeyMaker, speakerResolver, str, turnOf, type ChatExportDef } from "./chatExportKit";
import { mimeOf, type ExportConversation, type ExportTurn } from "./zip";

export function isTelegramName(name: string): boolean {
  return /^result\.json$/i.test(baseName(name));
}

/** A message's text as plain text: strings, and the `text` of each entity, in order. */
export function telegramText(t: unknown): string {
  if (typeof t === "string") return t;
  if (!Array.isArray(t)) return "";
  return t.map((p) => (typeof p === "string" ? p : isObj(p) ? str(p.text) : "")).join("");
}

function attachmentsOf(m: Record<string, unknown>): { name: string; mime: string }[] {
  const out: { name: string; mime: string }[] = [];
  const named = (v: unknown, fallback: string): void => {
    const s = str(v);
    if (s === "" || s.startsWith("(")) {
      // "(File not included. …)": the export left the file out; the message still had one.
      out.push({ name: str(m.file_name) || fallback, mime: str(m.mime_type) || "application/octet-stream" });
      return;
    }
    const name = str(m.file_name) || baseName(s);
    out.push({ name, mime: str(m.mime_type) || mimeOf(name) });
  };
  if ("file" in m) named(m.file, str(m.media_type) || "file");
  if ("photo" in m) named(m.photo, "photo");
  return out.slice(0, 2);
}

function whenOf(m: Record<string, unknown>): { at: string | undefined; strength: DateStrength; detail: string } {
  const unix = Number(str(m.date_unixtime));
  const exact = Number.isFinite(unix) && unix > 0 ? isoFromMs(unix * 1000) : undefined;
  if (exact) return { at: exact, strength: "strong", detail: "Telegram date_unixtime" };
  const d = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(str(m.date));
  const at = d ? civilToIso(Number(d[1]), Number(d[2]), Number(d[3]), Number(d[4]), Number(d[5]), Number(d[6])) : undefined;
  return { at, strength: "medium", detail: "time as printed in the export (no time zone)" };
}

export const telegram: ChatExportDef = {
  key: "telegram",
  label: "Telegram",
  recognise: (names) => names.some(isTelegramName),
  async parse(src, env) {
    const out: ExportConversation[] = [];
    for (const file of src.members.map((m) => m.name).filter(isTelegramName).sort()) {
      const root = await env.reader.json(file);
      if (!isObj(root)) continue;
      const chats: Record<string, unknown>[] = [];
      for (const bag of [root.chats, root.left_chats]) {
        if (isObj(bag) && Array.isArray(bag.list)) for (const c of bag.list) if (isObj(c)) chats.push(c);
      }
      if (Array.isArray(root.messages)) chats.push(root);
      // The account owner, when a whole-account export names them.
      const mineIds: string[] = [];
      const mineNames: string[] = [];
      const me = root.personal_information;
      if (isObj(me)) {
        const uid = str(me.user_id);
        if (uid !== "") mineIds.push(`user${uid}`);
        const full = `${str(me.first_name)} ${str(me.last_name)}`.trim();
        if (full !== "") mineNames.push(full);
      }
      const who = speakerResolver(env, mineNames);
      for (const chat of chats) {
        const messages = Array.isArray(chat.messages) ? chat.messages : [];
        const title = str(chat.name) || (str(chat.type) === "saved_messages" ? "Saved messages" : "Telegram chat");
        const native = `tg:${str(chat.id) || title}`;
        const keys = new KeyMaker(native);
        const turns: ExportTurn[] = [];
        for (const m of messages) {
          if (!isObj(m) || str(m.type) !== "message") continue;
          const text = telegramText(m.text).trim();
          const attachments = attachmentsOf(m);
          if (text === "" && attachments.length === 0) continue;
          const name = str(m.from) || str(m.actor);
          const id = str(m.id);
          const key = id !== "" ? `${native}:${id}` : keys.next(str(m.date_unixtime) || str(m.date), name, text);
          const sp = mineIds.includes(str(m.from_id)) ? { speaker: env.human } : who(name);
          const w = whenOf(m);
          turns.push(turnOf({ key, text, speaker: sp, at: w.at, strength: w.strength, detail: w.detail, attachments, raw: [m.id, m.date, name, text] }));
        }
        if (turns.length > 0) out.push(conversationOf(native, title, turns));
      }
    }
    return out.sort((a, b) => a.nativeId.localeCompare(b.nativeId));
  },
};
