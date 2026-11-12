/**
 * Where Obsidian's Daily notes core plugin keeps a day's note: its folder and date format (moment tokens, the
 * common ones), turned into a vault path. Pure; the reader looks the file up and never creates it itself (creating
 * goes through Obsidian's own "daily-notes" command).
 */

export interface DailyNoteOptions {
  /** Moment-style file name format; Obsidian's default is YYYY-MM-DD. */
  format: string;
  /** Vault-relative folder; empty for the vault root. */
  folder: string;
}

export const DEFAULT_DAILY_OPTIONS: DailyNoteOptions = { format: "YYYY-MM-DD", folder: "" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number, w = 2): string => String(n).padStart(w, "0");

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
}

/** Format a local date with moment-style tokens: YYYY YY MMMM MMM MM M DD D Do dddd ddd d, and [literal text]. */
export function formatDailyName(format: string, date: Date): string {
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  const w = date.getDay();
  let out = "";
  let i = 0;
  while (i < format.length) {
    if (format[i] === "[") {
      const end = format.indexOf("]", i + 1);
      if (end > i) {
        out += format.slice(i + 1, end);
        i = end + 1;
        continue;
      }
    }
    const rest = format.slice(i);
    const hit = (["YYYY", "dddd", "MMMM", "ddd", "MMM", "YY", "MM", "DD", "Do", "M", "D", "d"] as const).find((tok) => rest.startsWith(tok));
    if (!hit) {
      out += format[i];
      i += 1;
      continue;
    }
    i += hit.length;
    switch (hit) {
      case "YYYY":
        out += pad(y, 4);
        break;
      case "YY":
        out += pad(y % 100);
        break;
      case "MMMM":
        out += MONTHS[m] ?? "";
        break;
      case "MMM":
        out += (MONTHS[m] ?? "").slice(0, 3);
        break;
      case "MM":
        out += pad(m + 1);
        break;
      case "M":
        out += String(m + 1);
        break;
      case "DD":
        out += pad(d);
        break;
      case "D":
        out += String(d);
        break;
      case "Do":
        out += ordinal(d);
        break;
      case "dddd":
        out += DAYS[w] ?? "";
        break;
      case "ddd":
        out += (DAYS[w] ?? "").slice(0, 3);
        break;
      case "d":
        out += String(w);
        break;
    }
  }
  return out;
}

/** Read the plugin's options from whatever shape they arrive in (internal plugin options or daily-notes.json). */
export function parseDailyOptions(raw: unknown): DailyNoteOptions {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const format = typeof o.format === "string" && o.format.trim() !== "" ? o.format.trim() : DEFAULT_DAILY_OPTIONS.format;
  const folder = typeof o.folder === "string" ? o.folder.replace(/[\\]/g, "/").replace(/^\/+|\/+$/g, "").trim() : "";
  return { format, folder };
}

/** The vault path of the day's note: folder (if any) + the formatted name + ".md". Never leaves the vault ("..", absolute paths). */
export function dailyNotePath(options: DailyNoteOptions, date: Date): string | null {
  const name = formatDailyName(options.format, date).replace(/[\\]/g, "/").replace(/^\/+/, "");
  const path = `${options.folder ? `${options.folder}/` : ""}${name}`;
  const full = /\.md$/i.test(path) ? path : `${path}.md`;
  if (full.split("/").some((seg) => seg === ".." || seg === "" || seg === ".")) return null;
  return full;
}
