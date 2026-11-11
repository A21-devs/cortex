/**
 * Importer group: other coding agents' session logs (Codex CLI, Gemini CLI, Cursor). All three are opt-in
 * (settings.sources.codexCli / geminiCli / cursor, off by default) and share the live-capture engine in
 * ../agentSessions.ts: complete messages are staged at once and sealed into one segment when the session is idle.
 */
import { CodexCliImporter } from "../codexCli";
import { CursorImporter } from "../cursor";
import { GeminiCliImporter } from "../geminiCli";
import type { ExtraImporterGroup } from "./index";

export const agentCli: ExtraImporterGroup = {
  name: "agentCli",
  importers: {
    "codex-cli": CodexCliImporter(),
    "gemini-cli": GeminiCliImporter(),
    cursor: CursorImporter(),
  },
};
