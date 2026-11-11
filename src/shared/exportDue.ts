/**
 * Export reminders (Add to your record, Sources). Archive sources (Claude.ai, ChatGPT, Gemini) arrive as an
 * export the person requests from the provider, so nothing refreshes them until they ask again. This module is
 * pure: a catalogue of those sources (provider page, default cadence), and the arithmetic that turns "when did the
 * last export arrive" (the ledger's last import for the source) into days ago, days until the next one is due, a
 * due flag and a "due this month" flag. No clock reads, no network, no storage: callers pass `now`.
 *
 * "Request an export" only opens the provider's own export page in the default browser on a click; nothing is sent.
 * A source that has never arrived is not "due": someone who never added ChatGPT is not nagged about it.
 *
 * Importer packages that add an archive source append one line to EXTRA_EXPORT_SOURCES (and the wording to
 * COPY.addSources.sources in ui/copy.ts); no other shared file changes.
 */

export const DEFAULT_ARCHIVE_CADENCE_DAYS = 30;
export const CADENCE_RANGE = [1, 365] as const;

export interface ExportSource {
  /** The ledger row id (SourceRow.id) whose last import says when the last export arrived. */
  id: string;
  /** The provider's own page for requesting an export (https only). */
  exportUrl: string;
  /** Days between exports; absent = DEFAULT_ARCHIVE_CADENCE_DAYS. */
  cadenceDays?: number;
}

/** The archive sources Cortex reads today. */
export const BUILTIN_EXPORT_SOURCES: readonly ExportSource[] = [
  { id: "claude-ai", exportUrl: "https://claude.ai/settings/data-privacy-controls" },
  { id: "chatgpt", exportUrl: "https://chatgpt.com/#settings/DataControls" },
  { id: "gemini", exportUrl: "https://takeout.google.com/" },
];

/** Archive sources added by importer packages (src/importers/extra). One line each. */
export const EXTRA_EXPORT_SOURCES: readonly ExportSource[] = [
  { id: "notion", exportUrl: "https://www.notion.so/" },
  { id: "google-docs", exportUrl: "https://takeout.google.com/" },
  { id: "whatsapp", exportUrl: "https://faq.whatsapp.com/" },
  { id: "telegram", exportUrl: "https://desktop.telegram.org/" },
  { id: "discord", exportUrl: "https://support.discord.com/" },
  { id: "slack", exportUrl: "https://slack.com/help/" },
  { id: "keep", exportUrl: "https://takeout.google.com/" },
  { id: "evernote", exportUrl: "https://help.evernote.com/" },
  { id: "roam", exportUrl: "https://roamresearch.com/" },
  { id: "kindle", exportUrl: "https://www.amazon.com/kindle" },
  { id: "zoom", exportUrl: "https://zoom.us/recording" },
];

export function exportSources(): readonly ExportSource[] {
  return [...BUILTIN_EXPORT_SOURCES, ...EXTRA_EXPORT_SOURCES];
}

export function exportSourceOf(id: string): ExportSource | undefined {
  return exportSources().find((s) => s.id === id);
}

/** Only an https page without credentials may be opened for "Request an export". */
export function isSafeExportUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.username === "" && u.password === "" && u.hostname.includes(".");
  } catch {
    return false;
  }
}

/** The cadence for a source: the person's override when it is a whole number in range, else the catalogue's. */
export function cadenceFor(source: Pick<ExportSource, "id" | "cadenceDays">, overrides: Readonly<Record<string, unknown>> = {}): number {
  const o = overrides[source.id];
  if (typeof o === "number" && Number.isInteger(o) && o >= CADENCE_RANGE[0] && o <= CADENCE_RANGE[1]) return o;
  const d = source.cadenceDays;
  return typeof d === "number" && Number.isInteger(d) && d >= CADENCE_RANGE[0] ? d : DEFAULT_ARCHIVE_CADENCE_DAYS;
}

export interface ExportStatus {
  id: string;
  /** Whole days since the last export arrived; null when none has. */
  daysAgo: number | null;
  cadenceDays: number;
  /** Days until the next export is due; negative once overdue; null when none has arrived. */
  dueInDays: number | null;
  /** The cadence has run out. */
  due: boolean;
  /** The next export falls due on or before the last day of the current month (overdue counts). */
  dueThisMonth: boolean;
  exportUrl: string;
}

const DAY_MS = 86_400_000;

function endOfMonth(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1;
}

/** Status of one archive source from the ledger's last-arrived date (an ISO string, or undefined for never). */
export function exportStatus(source: ExportSource, lastArrived: string | undefined, now: number, overrides: Readonly<Record<string, unknown>> = {}): ExportStatus {
  const cadenceDays = cadenceFor(source, overrides);
  const last = lastArrived ? Date.parse(lastArrived) : Number.NaN;
  if (!Number.isFinite(last)) return { id: source.id, daysAgo: null, cadenceDays, dueInDays: null, due: false, dueThisMonth: false, exportUrl: source.exportUrl };
  const daysAgo = Math.max(0, Math.floor((now - last) / DAY_MS));
  const dueInDays = cadenceDays - daysAgo;
  const nextDue = last + cadenceDays * DAY_MS;
  return { id: source.id, daysAgo, cadenceDays, dueInDays, due: dueInDays <= 0, dueThisMonth: nextDue <= endOfMonth(now), exportUrl: source.exportUrl };
}

/** A row from the sources list: only its id and last import matter here. */
export interface LedgerRow {
  id: string;
  lastImport?: string | undefined;
}

/** Statuses for every archive source, in catalogue order. */
export function exportStatuses(rows: readonly LedgerRow[], now: number, overrides: Readonly<Record<string, unknown>> = {}, sources: readonly ExportSource[] = exportSources()): ExportStatus[] {
  const byId = new Map(rows.map((r) => [r.id, r.lastImport]));
  return sources.map((s) => exportStatus(s, byId.get(s.id), now, overrides));
}

/** The "Due this month" group: most overdue first. */
export function dueThisMonth(statuses: readonly ExportStatus[]): ExportStatus[] {
  return statuses.filter((s) => s.dueThisMonth).sort((a, b) => (a.dueInDays ?? 0) - (b.dueInDays ?? 0));
}

/** Whether a notification is worth showing: something is due now and today's reminder has not been shown. */
export function shouldRemind(statuses: readonly ExportStatus[], today: string, lastShownDay: string | null): ExportStatus[] {
  if (lastShownDay === today) return [];
  return statuses.filter((s) => s.due);
}

/** "2026-11-11" in local time: the once-a-day key for the reminder. */
export function dayKey(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Open the provider's own export page. Click-only; returns false (and opens nothing) for an unsafe address. */
export function requestExport(url: string, open: (url: string) => void): boolean {
  if (!isSafeExportUrl(url)) return false;
  open(url);
  return true;
}
