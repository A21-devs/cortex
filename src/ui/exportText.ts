/**
 * Wording for export reminders (shared/exportDue.ts): "Arrived 8 days ago · due in 22 days", the provider's name,
 * and the click that opens the provider's own export page in the default browser (both hosts: Obsidian and Cortex
 * Desktop open `window.open` addresses in the system browser). Nothing is sent; the page is just opened.
 */
import { requestExport, type ExportStatus } from "../shared/exportDue";
import { EXPORT_SOURCE_COPY, t } from "./copy";

export function exportName(id: string): string {
  return EXPORT_SOURCE_COPY[id]?.name ?? id;
}

export function exportHowTo(id: string): string {
  return EXPORT_SOURCE_COPY[id]?.how ?? "";
}

/** "Arrived 8 days ago · due in 22 days"; "Nothing has arrived yet" before the first export. */
export function arrivalText(s: Pick<ExportStatus, "daysAgo" | "dueInDays">): string {
  if (s.daysAgo === null || s.dueInDays === null) return t("addSources.arrivedNever");
  const arrived = s.daysAgo === 0 ? t("addSources.arrivedToday") : s.daysAgo === 1 ? t("addSources.arrivedYesterday") : t("addSources.arrivedDays", { n: s.daysAgo });
  const due = s.dueInDays < 0 ? t("addSources.overdue", { n: -s.dueInDays }) : s.dueInDays === 0 ? t("addSources.dueToday") : s.dueInDays === 1 ? t("addSources.dueTomorrow") : t("addSources.dueIn", { n: s.dueInDays });
  return `${arrived} · ${due}`;
}

/** Open the provider's export page; false when the address is not a plain https page. */
export function openExportPage(s: Pick<ExportStatus, "exportUrl">): boolean {
  return requestExport(s.exportUrl, (url) => void window.open(url, "_blank", "noopener"));
}
