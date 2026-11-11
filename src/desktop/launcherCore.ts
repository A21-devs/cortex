/**
 * The quick window's pure parts (no Electron, so a test can check them): the shortcut the person types, what the
 * window may send to the main process, where it opens, and the words it shows. launcher.ts is the Electron side.
 *
 * The quick window is opt-in (Settings › Cortex Desktop › Tray and quick window, off by default): nothing is
 * registered with the system until it is turned on. Enter searches the record from the command line of the main
 * window; Ctrl+Enter drops the text into Ask without sending it (a model is never called from this window).
 */
import { t } from "../ui/copy";

export type LauncherMode = "find" | "ask";

export interface LauncherSubmit {
  mode: LauncherMode;
  text: string;
}

/** The longest query the window hands over. */
export const QUERY_MAX = 500;

/** The words and the area name the page shows (sent to it once the window is built). */
export interface LauncherInit {
  space: string;
  wordmark: string;
  placeholder: string;
  hint: string;
  ariaLabel: string;
}

export const LAUNCHER_SIZE = { width: 560, height: 132 } as const;

export function launcherInit(space: string): LauncherInit {
  return { space: space.trim() || t("launcher.allAreas"), wordmark: t("rail.wordmark"), placeholder: t("launcher.placeholder"), hint: t("launcher.hint"), ariaLabel: t("launcher.ariaLabel") };
}

/** Plain text, no control characters, at most QUERY_MAX long; null when nothing is left. */
export function cleanQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, QUERY_MAX).trim();
  return s === "" ? null : s;
}

/** The message from the quick window's page: untrusted, so only these two fields and two modes pass. */
export function parseLauncherSubmit(raw: unknown): LauncherSubmit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const text = cleanQuery(r.text);
  if (text === null) return null;
  return { mode: r.mode === "ask" ? "ask" : "find", text };
}

// ───────────────────────────── the shortcut ─────────────────────────────

const MODIFIER_NAMES: Readonly<Record<string, "CommandOrControl" | "Alt" | "Shift">> = {
  ctrl: "CommandOrControl",
  control: "CommandOrControl",
  cmd: "CommandOrControl",
  command: "CommandOrControl",
  cmdorctrl: "CommandOrControl",
  commandorcontrol: "CommandOrControl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

const KEY_NAMES: Readonly<Record<string, string>> = {
  space: "Space",
  spacebar: "Space",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
};

function keyName(token: string): string | null {
  const lower = token.toLowerCase();
  if (KEY_NAMES[lower]) return KEY_NAMES[lower] as string;
  if (/^[a-z0-9]$/.test(lower)) return lower.toUpperCase();
  const f = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower);
  return f ? `F${f[1]}` : null;
}

/**
 * The accelerator for what was typed ("ctrl + shift + space" gives "CommandOrControl+Shift+Space"), "" for no
 * shortcut, or null when it is not one Cortex will register: it needs Ctrl or Alt (a bare key or Shift alone would
 * take typing away from every other program) and exactly one ordinary key.
 */
export function normaliseShortcut(input: string): string | null {
  const text = input.trim();
  if (text === "") return "";
  if (text.length > 48) return null;
  const parts = text.split("+").map((p) => p.trim());
  if (parts.some((p) => p === "")) return null;
  const mods = new Set<"CommandOrControl" | "Alt" | "Shift">();
  let key: string | null = null;
  for (const p of parts) {
    const m = MODIFIER_NAMES[p.toLowerCase()];
    if (m) {
      mods.add(m);
      continue;
    }
    const k = keyName(p);
    if (k === null || key !== null) return null;
    key = k;
  }
  if (key === null || !(mods.has("CommandOrControl") || mods.has("Alt"))) return null;
  return [...(["CommandOrControl", "Alt", "Shift"] as const).filter((m) => mods.has(m)), key].join("+");
}

/** The shortcut as people read it on Windows: "Ctrl+Shift+Space". */
export function displayShortcut(accelerator: string): string {
  return accelerator.replace(/CommandOrControl|CmdOrCtrl/g, "Ctrl");
}

export interface LauncherPrefs {
  quickWindow: boolean;
  quickShortcut: string;
}

/** The accelerator to register, or null: the window is off, or it has no shortcut (it then stays out of reach). */
export function shortcutToRegister(p: LauncherPrefs): string | null {
  if (!p.quickWindow) return null;
  const a = normaliseShortcut(p.quickShortcut);
  return a === null || a === "" ? null : a;
}

// ───────────────────────────── placement ─────────────────────────────

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Centred across the display's work area, a quarter of the way down. */
export function launcherBounds(workArea: Box, size: { width: number; height: number } = LAUNCHER_SIZE): Box {
  const width = Math.min(size.width, Math.max(240, workArea.width - 40));
  const height = Math.min(size.height, Math.max(80, workArea.height - 40));
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + Math.max(20, (workArea.height - height) * 0.22)),
    width,
    height,
  };
}
