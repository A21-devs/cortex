/**
 * Opens Cortex's Settings window at a tab or section, in either host. Cortex Desktop has its own Settings page
 * (app.setting, `branded`): the tab is told which section to show and the page opens on it. In Obsidian the plugin
 * listens for SETTINGS_WINDOW_EVENT and opens the same window as a modal (src/plugin/settingsModal.ts); Obsidian's
 * own Settings page is only the short Community plugins > Cortex entry. The one entry point for the gear, the
 * commands and every "Open settings" link.
 */
import { SETTINGS_WINDOW_CLOSE_EVENT, SETTINGS_WINDOW_EVENT, type SettingsSection } from "../shared/settingsTabs";

interface SettingPage {
  branded?: boolean;
  open?(): void;
  openTabById?(id: string): unknown;
}

export function openSettingsWindow(app: unknown, section: SettingsSection = "general"): void {
  const a = app as { workspace?: { trigger?(name: string, ...data: unknown[]): void }; setting?: SettingPage };
  try {
    if (a.setting?.branded === true) {
      a.workspace?.trigger?.("cortex:settings-section", section);
      a.setting.open?.();
      a.setting.openTabById?.("cortex");
      return;
    }
    if (typeof a.workspace?.trigger === "function") {
      a.workspace.trigger(SETTINGS_WINDOW_EVENT, section);
      return;
    }
    // An Obsidian without a workspace event bus: Obsidian's own page for the plugin.
    a.setting?.open?.();
    a.setting?.openTabById?.("cortex");
  } catch {
    // An Obsidian without the internal settings API: nothing to open.
  }
}

/** Put Cortex's Settings window away (the lock closes it). Does nothing when it is not open. */
export function closeSettingsWindow(app: unknown): void {
  const a = app as { workspace?: { trigger?(name: string, ...data: unknown[]): void }; setting?: SettingPage & { close?(): void } };
  try {
    if (a.setting?.branded === true) a.setting.close?.();
    else a.workspace?.trigger?.(SETTINGS_WINDOW_CLOSE_EVENT);
  } catch {
    // An Obsidian without the internal settings API: nothing to close.
  }
}
