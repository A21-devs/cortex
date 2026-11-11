/**
 * Discord data package ("Request all of my data"): `messages/index.json` and, per channel,
 * `messages/c<channel id>/channel.json` with `messages.json` or `messages.csv` (older packages: `messages.csv`
 * only). One conversation per channel. The package holds only what the person wrote, so every message takes the
 * person's own speaker. The server name becomes the project.
 *
 * Attachments are listed by file name taken from the link; the links are never opened. Timestamps carry their
 * offset (strong); one without is read as written (medium).
 */
import type { DateStrength } from "../shared/types";
import { baseName, civilToIso, conversationOf, isObj, parseCsv, str, turnOf, type ChatExportDef } from "./chatExportKit";
import { mimeOf, type ExportConversation, type ExportTurn } from "./zip";

const CHANNEL_FILE = /(?:^|\/)messages\/c?(\d+)\/messages\.(json|csv)$/i;

export function isDiscordName(names: readonly string[]): boolean {
  if (names.some((n) => CHANNEL_FILE.test(n) || /(?:^|\/)messages\/index\.json$/i.test(n))) return true;
  // One file dropped on its own.
  return names.length === 1 && /^messages\.(json|csv)$/i.test(baseName(names[0] as string));
}

/** "2024-03-01 10:15:00.123000+00:00" → exact time; without an offset it is read as written. */
export function discordTime(raw: string): { at: string | undefined; strength: DateStrength } {
  const s = raw.trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s);
  if (zoned) {
    const t = Date.parse(s);
    return Number.isFinite(t) && t > 0 ? { at: new Date(t).toISOString(), strength: "strong" } : { at: undefined, strength: "strong" };
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  return { at: m ? civilToIso(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)) : undefined, strength: "medium" };
}

function attachmentNames(raw: unknown): { name: string; mime: string }[] {
  const s = str(raw).trim();
  if (s === "") return [];
  return s
    .split(/[\s,]+/)
    .filter((u) => u.length > 0)
    .slice(0, 20)
    .map((u) => {
      let n = u.split("?")[0] as string;
      n = baseName(n);
      try {
        n = decodeURIComponent(n);
      } catch {
        // keep the raw name
      }
      return { name: n || "attachment", mime: mimeOf(n) };
    });
}

interface Row {
  id: string;
  time: string;
  text: string;
  attachments: string;
}

function rowsOf(file: string, text: string): Row[] {
  if (/\.json$/i.test(file)) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      return [];
    }
    if (!Array.isArray(v)) return [];
    return v.filter(isObj).map((o) => ({ id: str(o.ID ?? o.id), time: str(o.Timestamp ?? o.timestamp), text: str(o.Contents ?? o.contents ?? o.content), attachments: str(o.Attachments ?? o.attachments) }));
  }
  const rows = parseCsv(text);
  const head = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (n: string): number => head.indexOf(n);
  const [ci, ct, cc, ca] = [col("id"), col("timestamp"), col("contents"), col("attachments")];
  if (ci < 0 || ct < 0 || cc < 0) return [];
  return rows.slice(1).map((r) => ({ id: r[ci] ?? "", time: r[ct] ?? "", text: r[cc] ?? "", attachments: ca >= 0 ? (r[ca] ?? "") : "" }));
}

export const discord: ChatExportDef = {
  key: "discord",
  label: "Discord",
  recognise: isDiscordName,
  async parse(src, env) {
    const names = src.members.map((m) => m.name);
    let index: Record<string, unknown> = {};
    const idx = names.find((n) => /(?:^|\/)messages\/index\.json$/i.test(n));
    if (idx) {
      try {
        const v = await env.reader.json(idx);
        if (isObj(v)) index = v;
      } catch {
        // channel names are a nicety; the channels are read without them
      }
    }
    const files = names.filter((n) => CHANNEL_FILE.test(n) || (names.length === 1 && /^messages\.(json|csv)$/i.test(baseName(n)))).sort();
    // A channel with both messages.json and messages.csv is read once (json first).
    const done = new Set<string>();
    const out: ExportConversation[] = [];
    for (const f of files) {
      const m = CHANNEL_FILE.exec(f);
      const channel = m ? (m[1] as string) : "channel";
      if (done.has(channel)) continue;
      done.add(channel);
      let info: Record<string, unknown> = {};
      const dir = f.slice(0, f.lastIndexOf("/") + 1);
      if (names.includes(`${dir}channel.json`)) {
        try {
          const v = await env.reader.json(`${dir}channel.json`);
          if (isObj(v)) info = v;
        } catch {
          // the channel's own description is optional
        }
      }
      const rows = rowsOf(f, await env.reader.text(f));
      const turns: ExportTurn[] = [];
      const native = `dc:${str(info.id) || channel}`;
      for (const r of rows) {
        const attachments = attachmentNames(r.attachments);
        const text = r.text.trim();
        if (r.id === "" || (text === "" && attachments.length === 0)) continue;
        const w = discordTime(r.time);
        turns.push(turnOf({ key: `${native}:${r.id}`, text, speaker: { speaker: env.human }, at: w.at, strength: w.strength, detail: "Discord Timestamp", attachments, raw: [r.id, r.time, text] }));
      }
      if (turns.length === 0) continue;
      turns.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
      const guild = isObj(info.guild) ? str(info.guild.name) : "";
      const title = str(index[channel]) || str(info.name) || `Channel ${channel}`;
      const conv = conversationOf(native, title, turns);
      if (guild !== "") conv.project = guild.slice(0, 120);
      out.push(conv);
    }
    return out.sort((a, b) => a.nativeId.localeCompare(b.nativeId));
  },
};
