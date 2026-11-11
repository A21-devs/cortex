/**
 * Cortex's Settings window in Obsidian: the same six icon tabs, counter, "All settings" long list and rows that
 * Cortex Desktop draws (settingsTab.ts), hosted in an Obsidian modal. The tab class is the one source of truth for the
 * rows; this file only frames it (styles/settings-window.css scopes the window under `.cx-settings-modal`, so
 * Obsidian's own modal and form styles do not break it). Opened by the plugin's SETTINGS_WINDOW_EVENT handler.
 */
import { Modal, type App } from "obsidian";
import { CortexSettingTab, type SettingsTabHost } from "./settingsTab";
import type { SettingsSection } from "../shared/settingsTabs";
import { SETTINGS_COPY } from "../ui/copy";

export class CortexSettingsModal extends Modal {
  private readonly tab: CortexSettingTab;
  /** True from open until close (the plugin keeps one window and re-uses it). */
  isOpen = false;

  constructor(app: App, host: SettingsTabHost, section?: SettingsSection) {
    super(app);
    this.tab = new CortexSettingTab(app, host, { modal: { close: () => this.close() }, ...(section ? { section } : {}) });
  }

  override onOpen(): void {
    this.isOpen = true;
    this.modalEl.addClass("cx-settings-modal");
    this.modalEl.setAttr("aria-label", SETTINGS_COPY.window.label);
    this.contentEl.appendChild(this.tab.containerEl);
    this.tab.display();
  }

  override onClose(): void {
    this.isOpen = false;
    this.contentEl.empty();
  }

  /** Show another tab, or the long list at a section, in the window that is already open. */
  show(section: SettingsSection): void {
    this.tab.showSection(section);
  }
}
