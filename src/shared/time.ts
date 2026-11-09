/**
 * Date helpers. Storage is always ISO 8601 UTC ("…Z"); display buckets use the local time zone (the worker and
 * the renderer run in the same zone as Obsidian). Owner: E1.
 */
import { CortexError } from "./errors";
import type { IsoDate } from "./types";

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

/** The range JavaScript dates can represent (±8.64e15 ms around 1970). */
const MAX_DATE_MS = 8.64e15;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/**
 * Parse an ISO 8601 date ("YYYY-MM-DD", read as UTC midnight) or date-time (with "Z" or an offset; without a
 * zone it is local time, as in JavaScript) to epoch ms. NaN for anything else, including impossible calendar
 * dates such as 2026-02-30 and non-ISO strings that Date.parse would otherwise guess at.
 */
export function parseIso(s: string | undefined | null): number {
  if (typeof s !== "string") return Number.NaN;
  const m = ISO_RE.exec(s.trim());
  if (!m) return Number.NaN;
  const [, y, mo, d, hh, mi, ss] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return Number.NaN;
  if (hh !== undefined && (Number(hh) > 23 || Number(mi) > 59 || (ss !== undefined && Number(ss) > 59))) return Number.NaN;
  const text = hh === undefined ? `${y}-${mo}-${d}T00:00:00Z` : s.trim().replace(" ", "T").replace(",", ".").toUpperCase();
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : Number.NaN;
}

/** Days in a month (1–12) of a proleptic Gregorian year. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Epoch ms → ISO string. Throws a CortexError for times JavaScript cannot represent. */
export function toIso(t: number): IsoDate {
  if (!Number.isFinite(t) || Math.abs(t) > MAX_DATE_MS) throw new CortexError("E_BAD_REQUEST", `invalid time value: ${String(t)}`);
  return new Date(t).toISOString();
}

/** Epoch ms → ISO string, or undefined for invalid input. */
export function toIsoOrUndefined(t: number | null | undefined): IsoDate | undefined {
  if (t === null || t === undefined || !Number.isFinite(t) || Math.abs(t) > MAX_DATE_MS) return undefined;
  return new Date(t).toISOString();
}

export function nowIso(): IsoDate {
  return new Date().toISOString();
}

/** Epoch seconds (ChatGPT create_time, possibly fractional) → ISO; undefined for null, invalid or out of range. */
export function epochSecondsToIso(s: number | null | undefined): IsoDate | undefined {
  if (s === null || s === undefined || !Number.isFinite(s)) return undefined;
  return toIsoOrUndefined(s * 1000);
}

/** UTC month key "YYYY-MM" used for ledger shard folders. */
export function shardMonth(iso: IsoDate): string {
  return iso.slice(0, 7);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Local-time bucket keys for grouping and charts. */
export function localDayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function localMonthKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export function localYear(t: number): number {
  return new Date(t).getFullYear();
}

/** ISO-8601 week key "YYYY-Www" (Monday start, week 1 contains the first Thursday), in local time. */
export function isoWeekKey(t: number): string {
  const d = new Date(t);
  const day = (d.getDay() + 6) % 7;
  const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day + 3);
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const week = 1 + Math.round(((thursday.getTime() - firstThursday.getTime()) / DAY_MS - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
  return `${thursday.getFullYear()}-W${pad2(week)}`;
}

/** Start of the local day containing t. */
export function startOfLocalDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Last millisecond of the local day containing t (DST-safe: the next local midnight minus 1 ms). */
export function endOfLocalDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1;
}

/** "YYYY-MM-DD" read as a LOCAL calendar day → its start in epoch ms; NaN when not a real date. */
export function parseLocalDay(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return Number.NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return Number.NaN;
  const dt = new Date(y, mo - 1, d);
  dt.setFullYear(y); // years 0–99 would otherwise map to 1900–1999
  return dt.getTime();
}

/** Local calendar day "YYYY-MM-DD" for budget accounting (resets at local midnight). */
export function budgetDay(t: number = Date.now()): string {
  return localDayKey(t);
}

const longFmt = new Map<string, Intl.DateTimeFormat>();
const shortFmt = new Map<string, Intl.DateTimeFormat>();

function formatter(cache: Map<string, Intl.DateTimeFormat>, locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = cache.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    cache.set(locale, f);
  }
  return f;
}

/** "8 November 2026" (en-GB default). */
export function formatLong(t: number, locale = "en-GB"): string {
  return formatter(longFmt, locale, { day: "numeric", month: "long", year: "numeric" }).format(t);
}

/** "8 Nov 2026". */
export function formatShort(t: number, locale = "en-GB"): string {
  return formatter(shortFmt, locale, { day: "numeric", month: "short", year: "numeric" }).format(t);
}

/** Dates found in file names such as "2026-07-23.md" or "20260723-note.md" (only real calendar dates). */
export function dateFromFilename(name: string): string | undefined {
  const re = /(?:^|[^0-9])(20\d{2})(-?)(0[1-9]|1[0-2])\2(0[1-9]|[12]\d|3[01])(?=[^0-9]|$)/g;
  for (const m of name.matchAll(re)) {
    const y = Number(m[1]);
    const mo = Number(m[3]);
    const d = Number(m[4]);
    if (d <= daysInMonth(y, mo)) return `${m[1]}-${m[3]}-${m[4]}`;
  }
  return undefined;
}
