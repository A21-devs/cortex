/**
 * The Settings window's frame (pure): the six tabs, how every older section id maps onto them, the "All settings"
 * long list's order, arrow-key roving over the tab strip, and the cloud-folder check the Sync tab uses.
 * Shared by the settings tab (plugin) and the Open-settings helpers (ui) so both agree on the ids.
 */

import type { CortexSettings } from "./settings";

/** The workspace event that asks the Obsidian plugin to open Cortex's Settings window (an Obsidian modal); its argument is the section id. */
export const SETTINGS_WINDOW_EVENT = "cortex:open-settings-window";
/** The workspace event that closes the window again (Showcase mode shows the Appearance tab, then puts it away). */
export const SETTINGS_WINDOW_CLOSE_EVENT = "cortex:close-settings-window";

/** The six tabs of the window, in order. */
export const WINDOW_TABS = ["general", "appearance", "lock", "capture", "agents", "sync"] as const;
export type WindowTab = (typeof WINDOW_TABS)[number];

/** Every id Settings can be opened at: a tab, or one of the sections that only the long list shows. */
export type SettingsSection = WindowTab | "sources" | "privacy" | "advanced";

/** The sections of the "All settings" long list, in order. */
export const ALL_SECTIONS: readonly (WindowTab | "privacy" | "advanced")[] = ["general", "appearance", "lock", "capture", "agents", "sync", "privacy", "advanced"];

export interface SettingsTarget {
  /** The tab to show; null when the long list shows. */
  tab: WindowTab | null;
  /** Show the long list of every section (Privacy and Advanced live only there). */
  all: boolean;
  /** The section to scroll to in the long list. */
  anchor: WindowTab | "privacy" | "advanced";
}

/** Where a requested id lands: the old Sources id is the Live capture tab; Privacy and Advanced open the long list. */
export function resolveSettingsTarget(id: string | undefined | null): SettingsTarget {
  if (id === "privacy" || id === "advanced") return { tab: null, all: true, anchor: id };
  if (id === "sources") return { tab: "capture", all: false, anchor: "capture" };
  const tab = (WINDOW_TABS as readonly string[]).includes(id ?? "") ? (id as WindowTab) : "general";
  return { tab, all: false, anchor: tab };
}

/** "n of 6" counter: 1-based position of the shown tab. */
export function tabPosition(tab: WindowTab): { n: number; of: number } {
  return { n: WINDOW_TABS.indexOf(tab) + 1, of: WINDOW_TABS.length };
}

/** The tab an arrow / Home / End key moves to from `current`; null when the key does nothing. Wraps at both ends. */
export function rovingTab(current: WindowTab, key: string): WindowTab | null {
  const i = WINDOW_TABS.indexOf(current);
  const n = WINDOW_TABS.length;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return WINDOW_TABS[(i + 1) % n] ?? null;
    case "ArrowLeft":
    case "ArrowUp":
      return WINDOW_TABS[(i - 1 + n) % n] ?? null;
    case "Home":
      return WINDOW_TABS[0] ?? null;
    case "End":
      return WINDOW_TABS[n - 1] ?? null;
    default:
      return null;
  }
}

/** The cloud-sync service a folder path sits in (OneDrive, iCloud, Dropbox, Google Drive), or null. */
export function cloudFolderOf(path: string): "OneDrive" | "iCloud" | "Dropbox" | "Google Drive" | null {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)onedrive([^/]*)(\/|$)/.test(p)) return "OneDrive";
  if (/(^|\/)(icloud drive|iclouddrive|mobile documents|com~apple~clouddocs)(\/|$)/.test(p)) return "iCloud";
  if (/(^|\/)dropbox([^/]*)(\/|$)/.test(p)) return "Dropbox";
  if (/(^|\/)(google drive|googledrive|my drive)(\/|$)/.test(p)) return "Google Drive";
  return null;
}

/** Another coding agent (Codex CLI, Gemini CLI, Cursor) is on and watched. */
function agentsWatching(src: Pick<CortexSettings, "sources">["sources"]): boolean {
  return [src.codexCli, src.geminiCli, src.cursor].some((a) => a?.enabled === true && a.watch);
}

/** Live capture as one switch: on while Claude Code sessions or an added folder are being watched (what the rail's Live line reads). */
export function liveCaptureOn(s: Pick<CortexSettings, "sources">): boolean {
  const src = s.sources;
  return (src.claudeCode.enabled && src.claudeCode.watch) || src.folders.some((f) => f.enabled && f.watch) || agentsWatching(src);
}

/** True when there is something the switch could watch (Claude Code sessions or an enabled folder). */
export function liveCaptureAvailable(s: Pick<CortexSettings, "sources">): boolean {
  return s.sources.claudeCode.enabled || s.sources.folders.some((f) => f.enabled) || [s.sources.codexCli, s.sources.geminiCli, s.sources.cursor].some((a) => a?.enabled === true);
}

/** The switch's change: watching on or off for every source that is switched on, nothing else touched. */
export function applyLiveCapture(s: Pick<CortexSettings, "sources">, on: boolean): void {
  if (s.sources.claudeCode.enabled) s.sources.claudeCode.watch = on;
  for (const a of [s.sources.codexCli, s.sources.geminiCli, s.sources.cursor]) if (a?.enabled) a.watch = on;
  for (const f of s.sources.folders) if (f.enabled) f.watch = on;
}
