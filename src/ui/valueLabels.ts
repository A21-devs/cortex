/**
 * Display labels for enum values (L7) and the number and date formats of CORTEX-UX §1.5. Owner: E12.
 * Never show a raw id or code value: speaker, source, note kind, map kind and recency, job and run result all go
 * through here. Code identifiers that differ from the words the user sees are aliased (a code "gist" is a
 * "summary", the code name for a map is "map", map recency "quiet" / "paused" reads "cooling" / "dormant").
 *
 * Formats (§1.5): thousands separators (97,519), compact counts with k (28.4k), dates "3 Nov 2026" in the date
 * format chosen in Settings › General (year omitted only inside the current year's lists), 24 h times (14:05),
 * ranges with an en dash. Month and weekday names are fixed English abbreviations so output never depends on the
 * ICU data of the Electron build ("Sept" vs "Sep").
 */
import type { DimId } from "../shared/dims";
import { isLabelDim, parseLabelDim, RESUME_DIM, ROLE_DIM } from "../shared/dims";
import type { DateFormat } from "../shared/settings";
import { spaceName } from "../shared/spaces";
import type { HubType, JobKind, NoteKind, RunRecord, SpaceId, Speaker } from "../shared/types";
import { COPY, t } from "./copy";

const ALIASES: Readonly<Record<string, string>> = {
  gist: "summary",
  hub: "map",
  quiet: "cooling",
  paused: "dormant",
  "assistant-pane": "cortex-ask",
};

function lookup(table: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** Label of an enum value (speaker, source, kind, recency …); unknown values pass through unchanged. */
export function valueLabel(value: string): string {
  const key = ALIASES[value] ?? value;
  return lookup(COPY.values, key) ?? value;
}

/** Menu label of a dimension; label-pack fields use the pack field's own label when known. */
export function dimLabel(id: DimId, packFieldLabel?: (pack: string, field: string) => string | undefined): string {
  if (id === RESUME_DIM) return COPY.dims.resumeItem;
  if (id === ROLE_DIM) return COPY.dims.function;
  if (isLabelDim(id)) {
    const { pack, field } = parseLabelDim(id);
    return packFieldLabel?.(pack, field) ?? field;
  }
  const [grain, basis] = id.split(":");
  const base = lookup(COPY.dims, grain ?? id) ?? id;
  return basis === "imported" ? `${base} · ${COPY.dims.imported}` : base;
}

/** "Claude Code", "ChatGPT", "Vault notes", ".raw" … */
export function sourceLabel(kind: string): string {
  return valueLabel(kind);
}

/** Speaker as a person: "You", "Assistant (sonnet)", "Another person", "Tool". */
export function speakerLabel(speaker: Speaker, model?: string): string {
  switch (speaker) {
    case "you":
      return t("reader.you");
    case "assistant":
      return model ? t("reader.assistant", { model }) : COPY.values.assistant;
    case "tool":
      return t("reader.tool");
    default:
      return t("reader.other");
  }
}

/** Note kind as a title word: "Decision", "Summary", "Abandoned idea"; plural for counts ("Decisions"). */
export function kindLabel(kind: NoteKind | string, plural = false): string {
  const key = ALIASES[kind] ?? kind;
  return lookup(plural ? COPY.kindsPlural : COPY.kinds, key) ?? valueLabel(kind);
}

/** "Project map" · "Area map" · "Topic map". */
export function mapKindLabel(type: HubType): string {
  return type === "project" ? t("reader.projectMap") : type === "area" ? t("reader.areaMap") : t("reader.topicMap");
}

/** Value of the Map type dimension: "Project map" · "Area map" · "Topic map" · "Not a map" (key "none"). */
export function hubTypeLabel(value: string): string {
  return value === "project" || value === "area" || value === "topic" ? mapKindLabel(value) : COPY.dims.notAMap;
}

/** Value of the Note or record dimension: "Note" · "Record entry". */
export function noteOrRecordLabel(value: string): string {
  return value === "record" ? COPY.dims.recordWord : COPY.dims.noteWord;
}

/** Job names in the ledger: label, summary, map, filing, name check, answer. */
export function jobLabel(job: JobKind | string): string {
  const key = ALIASES[job] ?? job;
  return lookup(COPY.jobs, key) ?? key;
}

/** Area display name; "No area" for none and unknown ids. */
export function areaLabel(space: SpaceId | string): string {
  return spaceName(space as SpaceId);
}

export type RunResult = "done" | "partly" | "failed" | "capped" | "stopped" | "running";

/** The Result column (§5.20): done, partly, failed, capped, stopped (and running while it runs). */
export function runResult(r: Pick<RunRecord, "status" | "noAnswer" | "labels" | "items">): RunResult {
  switch (r.status) {
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "capped":
      return "capped";
    case "stopped":
      return "stopped";
    case "nothing tagged":
      return "partly";
    default:
      return r.noAnswer > 0 && r.noAnswer < Math.max(1, r.items) ? "partly" : r.noAnswer > 0 ? "failed" : "done";
  }
}

const RESULT_KEYS = {
  done: "agents.resultDone",
  partly: "agents.resultPartly",
  failed: "agents.resultFailed",
  capped: "agents.resultCapped",
  stopped: "agents.resultStopped",
  running: "agents.resultRunning",
} as const;

export function runResultLabel(r: RunResult): string {
  return t(RESULT_KEYS[r]);
}

// ───────────────────────────── numbers ─────────────────────────────

/** 97,519 (en-GB grouping); NaN and infinities read "–". */
export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return COPY.app.loading;
  return Math.round(n).toLocaleString("en-GB");
}

/** Compact counts: 980 · 28.4k · 1.2M (only where space is tight). */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return COPY.app.loading;
  const a = Math.abs(n);
  if (a < 1000) return fmtInt(n);
  if (a < 1_000_000) return `${trimZero((n / 1000).toFixed(a < 10_000 ? 1 : a < 100_000 ? 1 : 0))}k`;
  return `${trimZero((n / 1_000_000).toFixed(a < 10_000_000 ? 1 : 0))}M`;
}

function trimZero(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** A 0..1 share as a whole percentage ("57%"). */
export function fmtPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return COPY.app.loading;
  return `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

/** File sizes: 812 bytes · 14 KB · 3.2 MB. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return COPY.app.loading;
  if (n < 1024) return t("units.bytes", { n: fmtInt(n) });
  if (n < 1024 * 1024) return t("units.kb", { n: trimZero((n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)) });
  if (n < 1024 * 1024 * 1024) return t("units.mb", { n: trimZero((n / (1024 * 1024)).toFixed(1)) });
  return t("units.gb", { n: trimZero((n / (1024 * 1024 * 1024)).toFixed(1)) });
}

/** Durations: 41 s · 3 min · 2 h 5 min. */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return COPY.app.loading;
  const s = Math.round(ms / 1000);
  if (s < 60) return t("units.seconds", { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t("units.minutes", { n: m });
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? t("units.hours", { n: h }) : t("units.hoursMinutes", { h, m: rest });
}

// ───────────────────────────── dates ─────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const DATE_FORMATS: readonly DateFormat[] = ["d MMM yyyy", "yyyy-MM-dd", "MMM d, yyyy"];

const pad2 = (n: number) => String(n).padStart(2, "0");

function valid(ms: number): boolean {
  return Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime());
}

/**
 * A calendar date in the user's format: "3 Nov 2026" · "2026-11-03" · "Nov 3, 2026". With `omitYear` set to the
 * current year, dates in that year drop it ("3 Nov") — only inside the current year's lists (§1.5).
 */
export function fmtDate(ms: number, format: DateFormat = "d MMM yyyy", omitYearIn?: number): string {
  if (!valid(ms)) return COPY.app.loading;
  const d = new Date(ms);
  const y = d.getFullYear();
  const mon = MONTHS[d.getMonth()] ?? "";
  const day = d.getDate();
  const short = omitYearIn !== undefined && omitYearIn === y;
  switch (format) {
    case "yyyy-MM-dd":
      return `${y}-${pad2(d.getMonth() + 1)}-${pad2(day)}`;
    case "MMM d, yyyy":
      return short ? `${mon} ${day}` : `${mon} ${day}, ${y}`;
    default:
      return short ? `${day} ${mon}` : `${day} ${mon} ${y}`;
  }
}

/** 24-hour time "14:05". */
export function fmtTime(ms: number): string {
  if (!valid(ms)) return COPY.app.loading;
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "3 Nov 2026, 14:52". */
export function fmtDateTime(ms: number, format: DateFormat = "d MMM yyyy", omitYearIn?: number): string {
  if (!valid(ms)) return COPY.app.loading;
  return `${fmtDate(ms, format, omitYearIn)}, ${fmtTime(ms)}`;
}

/** "Oct 2026" (Read's month headers, axis labels). */
export function fmtMonth(ms: number): string {
  if (!valid(ms)) return COPY.app.loading;
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()] ?? ""} ${d.getFullYear()}`;
}

/** "Monday 9 November" (the Today header). */
export function fmtWeekdayLong(ms: number): string {
  if (!valid(ms)) return COPY.app.loading;
  const d = new Date(ms);
  return `${WEEKDAYS_LONG[d.getDay()] ?? ""} ${d.getDate()} ${MONTHS_LONG[d.getMonth()] ?? ""}`;
}

function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/**
 * Time span of a conversation or part: "3 Nov 14:05–14:40" on one day, "3 Nov 14:05 – 4 Nov 10:12" across days.
 * The year is dropped for the current year.
 */
export function fmtSpan(from: number, to: number, format: DateFormat = "d MMM yyyy", now: number = Date.now()): string {
  if (!valid(from)) return COPY.app.loading;
  const year = new Date(now).getFullYear();
  const start = `${fmtDate(from, format, year)} ${fmtTime(from)}`;
  if (!valid(to) || to <= from) return start;
  if (sameDay(from, to)) return `${start}–${fmtTime(to)}`;
  return `${start} – ${fmtDate(to, format, year)} ${fmtTime(to)}`;
}

/** Day range "2–8 Nov 2026" (same month), "28 Oct – 3 Nov 2026", or two full dates. */
export function fmtDayRange(from: number, to: number, format: DateFormat = "d MMM yyyy"): string {
  if (!valid(from) || !valid(to)) return COPY.app.loading;
  const a = new Date(from);
  const b = new Date(to);
  if (format === "d MMM yyyy" && a.getFullYear() === b.getFullYear()) {
    if (a.getMonth() === b.getMonth()) return a.getDate() === b.getDate() ? fmtDate(to, format) : `${a.getDate()}–${fmtDate(to, format)}`;
    return `${fmtDate(from, format, a.getFullYear())} – ${fmtDate(to, format)}`;
  }
  return `${fmtDate(from, format)} – ${fmtDate(to, format)}`;
}

/** Parse an ISO string to epoch ms (NaN when missing or malformed). */
export function isoMs(iso: string | undefined | null): number {
  if (!iso) return Number.NaN;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.NaN : ms;
}
