/**
 * Slack workspace export (zip or folder): `users.json`, `channels.json` (and `groups.json`, `mpims.json`,
 * `dms.json`), and per channel a folder of day files `<channel>/YYYY-MM-DD.json`. One conversation per channel,
 * messages in time order. Joins, leaves, topic changes and the like are left out.
 *
 * Mentions and links in the text are turned into readable text (`<@U123>` becomes `@name`, `<url|label>` becomes
 * `label (url)`); nothing is fetched. A message is "you" when the person's name or handle from Settings › You
 * matches the sender. `ts` is exact (strong).
 */
import { baseName, conversationOf, isObj, isoFromMs, speakerResolver, str, turnOf, type ChatExportDef } from "./chatExportKit";
import { mimeOf, type ExportConversation, type ExportTurn } from "./zip";

const DAY_FILE = /^(?:.*\/)?([^/]+)\/(\d{4}-\d{2}-\d{2})\.json$/;
const SKIP_SUBTYPES = new Set([
  "channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name", "channel_archive", "channel_unarchive",
  "group_join", "group_leave", "group_topic", "group_purpose", "group_name", "group_archive", "group_unarchive", "pinned_item", "unpinned_item",
  "reminder_add", "tombstone", "thread_broadcast_hidden",
]);

export function isSlackName(names: readonly string[]): boolean {
  return names.some((n) => DAY_FILE.test(n));
}

/** Slack's message markup as plain text. */
export function slackText(t: string, users: ReadonlyMap<string, string>, channels: ReadonlyMap<string, string>): string {
  return t
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, label?: string) => `@${users.get(id) ?? label ?? id}`)
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, label?: string) => `#${label ?? channels.get(id) ?? id}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, "$1")
    .replace(/<((?:https?:|mailto:)[^>|]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<((?:https?:|mailto:)[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function nameOfUser(u: Record<string, unknown>): string {
  const p = isObj(u.profile) ? u.profile : {};
  return str(p.display_name) || str(p.real_name) || str(u.real_name) || str(u.name) || str(u.id);
}

async function listOf(env: { reader: { json(n: string): Promise<unknown> } }, names: readonly string[], file: string): Promise<Record<string, unknown>[]> {
  const hit = names.find((n) => baseName(n).toLowerCase() === file);
  if (!hit) return [];
  try {
    const v = await env.reader.json(hit);
    return Array.isArray(v) ? v.filter(isObj) : [];
  } catch {
    return [];
  }
}

export const slack: ChatExportDef = {
  key: "slack",
  label: "Slack",
  recognise: isSlackName,
  async parse(src, env) {
    const names = src.members.map((m) => m.name);
    const users = new Map<string, string>();
    for (const u of await listOf(env, names, "users.json")) if (str(u.id) !== "") users.set(str(u.id), nameOfUser(u));
    // Channel folder name → id and display title.
    const channels = new Map<string, string>();
    const meta = new Map<string, { id: string; title: string }>();
    for (const file of ["channels.json", "groups.json", "mpims.json"]) {
      for (const c of await listOf(env, names, file)) {
        const name = str(c.name);
        const id = str(c.id);
        if (name === "") continue;
        if (id !== "") channels.set(id, name);
        meta.set(name, { id: id || name, title: `#${name}` });
      }
    }
    for (const d of await listOf(env, names, "dms.json")) {
      const id = str(d.id);
      if (id === "") continue;
      const members = Array.isArray(d.members) ? d.members.map((m) => users.get(str(m)) ?? str(m)).filter((s) => s !== "") : [];
      meta.set(id, { id, title: members.length > 0 ? `Direct message with ${members.join(", ")}` : "Direct message" });
    }
    const who = speakerResolver(env);
    const byChannel = new Map<string, string[]>();
    for (const n of names) {
      const m = DAY_FILE.exec(n);
      if (!m) continue;
      const list = byChannel.get(m[1] as string) ?? [];
      list.push(n);
      byChannel.set(m[1] as string, list);
    }
    const out: ExportConversation[] = [];
    for (const [folder, files] of [...byChannel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const info = meta.get(folder);
      const native = `sl:${info?.id ?? folder}`;
      const turns: ExportTurn[] = [];
      for (const f of files.sort()) {
        let day: unknown;
        try {
          day = await env.reader.json(f);
        } catch {
          continue; // one damaged day does not stop the channel
        }
        if (!Array.isArray(day)) continue;
        for (const m of day) {
          if (!isObj(m) || (str(m.type) !== "message" && str(m.type) !== "")) continue;
          const sub = str(m.subtype);
          if (SKIP_SUBTYPES.has(sub)) continue;
          const ts = str(m.ts);
          const ms = Number(ts) * 1000;
          if (ts === "" || !Number.isFinite(ms)) continue;
          const text = slackText(str(m.text), users, channels).trim();
          const files2 = Array.isArray(m.files) ? m.files.filter(isObj) : [];
          const attachments = files2.slice(0, 20).map((x) => ({ name: str(x.name) || str(x.title) || "file", mime: str(x.mimetype) || mimeOf(str(x.name)), bytes: Number(x.size) || 0 }));
          if (text === "" && attachments.length === 0) continue;
          const p = isObj(m.user_profile) ? m.user_profile : {};
          const bot = isObj(m.bot_profile) ? str(m.bot_profile.name) : "";
          const sender = users.get(str(m.user)) ?? (str(p.display_name) || str(p.real_name) || bot || str(m.username) || str(m.user));
          turns.push(turnOf({ key: `${native}:${ts}`, text, speaker: who(sender), at: isoFromMs(ms), strength: "strong", detail: "Slack ts", attachments, raw: [ts, str(m.user), text] }));
        }
      }
      if (turns.length === 0) continue;
      turns.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
      out.push(conversationOf(native, info?.title ?? `#${folder}`, turns));
    }
    return out;
  },
};
