/**
 * Importer group: chat, notes and reading exports a person downloaded (WhatsApp, Telegram, Discord, Slack,
 * Google Keep, Evernote, Roam, Kindle clippings, Zoom chats and transcripts). Local parsers only: the person hands
 * Cortex a file, a folder or a zip; nothing is fetched. Each export runs through the shared export pass (the same
 * screening and stable ids as the chat services), and each is recognised by `import.inspect` for the Add to your
 * record sheet. The formats live in importers/whatsapp.ts, telegram.ts, discord.ts, slack.ts,
 * keepEvernoteRoam.ts and kindleZoom.ts; the shared kit is importers/chatExportKit.ts.
 */
import { ChatExportImporter, inspectorOf, type ChatExportDef } from "../chatExportKit";
import { discord } from "../discord";
import { evernote, keep, roam } from "../keepEvernoteRoam";
import { kindle, zoom } from "../kindleZoom";
import { slack } from "../slack";
import { telegram } from "../telegram";
import { whatsapp } from "../whatsapp";
import type { ExtraImporter, ExtraImporterGroup } from "./index";

/** Most specific first: `inspect` tries the first one whose names fit. */
export const CHAT_EXPORT_DEFS: readonly ChatExportDef[] = [whatsapp, telegram, discord, slack, keep, evernote, kindle, zoom, roam];

export const chatExports: ExtraImporterGroup = {
  name: "chatExports",
  importers: Object.fromEntries(CHAT_EXPORT_DEFS.map((d) => [d.key, new ChatExportImporter(d) as unknown as ExtraImporter])),
  inspectors: CHAT_EXPORT_DEFS.map(inspectorOf),
};
