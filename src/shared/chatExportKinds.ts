/**
 * The source kinds of the chat, notes and reading exports (importers/extra/chatExports.ts). One list, so the
 * settings, the Sources page, the sheet and the importers never drift apart.
 */
export const CHAT_EXPORT_KEYS = ["whatsapp", "telegram", "discord", "slack", "keep", "evernote", "roam", "kindle", "zoom"] as const;

export type ChatExportKey = (typeof CHAT_EXPORT_KEYS)[number];

export function isChatExportKey(x: unknown): x is ChatExportKey {
  return typeof x === "string" && (CHAT_EXPORT_KEYS as readonly string[]).includes(x);
}
