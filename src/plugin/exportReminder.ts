/**
 * Optional export reminder (Settings › Sources › "Remind me when an export is due", off by default). When on, and
 * once a day at most, one notice names the archive sources (Claude.ai, ChatGPT, Gemini …) whose next export is due,
 * judged from the ledger's last import per source (shared/exportDue.ts). It only reminds: nothing is requested, no
 * address is opened, nothing is sent. The once-a-day mark is per device (app local storage), never synced.
 */
import { Notice, type App } from "obsidian";
import { dayKey, exportStatuses, shouldRemind, type LedgerRow } from "../shared/exportDue";
import type { CortexSettings } from "../shared/settings";
import { t } from "../ui/copy";
import { exportName } from "../ui/exportText";
import type { CortexServices } from "./services";

export const REMINDER_KEY = "cortex:export-reminded";

export interface ReminderInput {
  settings: Pick<CortexSettings, "sources">;
  rows: readonly LedgerRow[];
  now: number;
  /** The day (local "yyyy-mm-dd") a reminder was last shown on this device, or null. */
  lastShown: string | null;
}

/** The notice text and today's key, or null when nothing should be shown (switch off, nothing due, already shown today). */
export function reminderFor(i: ReminderInput): { text: string; day: string } | null {
  const cfg = i.settings.sources.exportReminders;
  if (!cfg.notify) return null;
  const day = dayKey(i.now);
  const due = shouldRemind(exportStatuses(i.rows, i.now, cfg.cadenceDays), day, i.lastShown);
  if (due.length === 0) return null;
  return { text: t("notices.exportDue", { sources: due.map((s) => exportName(s.id)).join(", ") }), day };
}

type StorageApp = Pick<App, "loadLocalStorage" | "saveLocalStorage">;

/** Run the check with the live services. Never throws. */
export async function runExportReminder(app: StorageApp, s: Pick<CortexServices, "sources" | "settings" | "sandbox">, now = Date.now()): Promise<boolean> {
  try {
    if (!s.settings.value.sources.exportReminders.notify || s.sandbox.value) return false;
    const stored = app.loadLocalStorage(REMINDER_KEY);
    const r = reminderFor({ settings: s.settings.value, rows: await s.sources.list(), now, lastShown: typeof stored === "string" ? stored : null });
    if (!r) return false;
    new Notice(r.text);
    app.saveLocalStorage(REMINDER_KEY, r.day);
    return true;
  } catch {
    return false;
  }
}
