/**
 * Obsidian's `Plugin` for Cortex Desktop. Registration calls land in the shim's App (commands, views, the
 * settings tab); the ribbon icon and the status bar item are created but not shown (no Obsidian chrome).
 * loadData / saveData read and write `<manifest.dir>/data.json` through the vault adapter, which mounts that
 * folder on the desktop's own data folder (see vault.ts): the vault's copy is only ever read.
 */
import { Component } from "./component";
import type { PluginSettingTab } from "./setting";
import type { View, WorkspaceLeaf } from "./workspace";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion?: string;
  description?: string;
  author?: string;
  isDesktopOnly?: boolean;
  /** Vault-relative folder of the plugin (".obsidian/plugins/<id>"). */
  dir?: string;
}

export interface Command {
  id: string;
  name: string;
  icon?: string;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
  editorCallback?: (...args: unknown[]) => unknown;
  editorCheckCallback?: (...args: unknown[]) => boolean | void;
  hotkeys?: unknown[];
}

export interface PluginHostApp {
  commands: { addCommand(c: Command): void; removeCommand(id: string): void };
  setting: { addSettingTab(tab: PluginSettingTab): void; removeTab(id: string): void };
  workspace: { registerView(type: string, creator: (leaf: WorkspaceLeaf) => View): void; unregisterView(type: string): void };
  vault: { adapter: { exists(p: string): Promise<boolean>; read(p: string): Promise<string>; write(p: string, data: string): Promise<void> } };
  protocolHandlers: Map<string, (params: Record<string, string>) => unknown>;
  chrome: { statusBarEl: HTMLElement; ribbonEl: HTMLElement };
}

export class Plugin extends Component {
  constructor(
    readonly app: PluginHostApp,
    readonly manifest: PluginManifest,
  ) {
    super();
  }

  private get dataPath(): string {
    return `${this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`}/data.json`;
  }

  /** data.json, or null when there is none. A file that exists but does not parse throws. */
  async loadData(): Promise<unknown> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.dataPath))) return null;
    return JSON.parse(await adapter.read(this.dataPath)) as unknown;
  }

  async saveData(data: unknown): Promise<void> {
    await this.app.vault.adapter.write(this.dataPath, JSON.stringify(data, null, 2));
  }

  addCommand(command: Command): Command {
    const full: Command = { ...command, id: `${this.manifest.id}:${command.id}`, name: `${this.manifest.name}: ${command.name}` };
    this.app.commands.addCommand(full);
    this.register(() => this.app.commands.removeCommand(full.id));
    return full;
  }

  removeCommand(commandId: string): void {
    this.app.commands.removeCommand(`${this.manifest.id}:${commandId}`);
  }

  addSettingTab(tab: PluginSettingTab): void {
    this.app.setting.addSettingTab(tab);
    this.register(() => this.app.setting.removeTab(this.manifest.id));
  }

  registerView(type: string, creator: (leaf: WorkspaceLeaf) => View): void {
    this.app.workspace.registerView(type, creator);
    this.register(() => this.app.workspace.unregisterView(type));
  }

  /** The ribbon is Obsidian chrome: the icon exists (so callers can style it) but is not shown. */
  addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const el = document.createElement("div");
    el.className = "side-dock-ribbon-action clickable-icon";
    el.setAttribute("aria-label", title);
    el.dataset.icon = icon;
    el.addEventListener("click", callback);
    this.app.chrome.ribbonEl.appendChild(el);
    this.register(() => el.remove());
    return el;
  }

  /** The status bar is Obsidian chrome too: the item lives in a hidden bar. */
  addStatusBarItem(): HTMLElement {
    const el = document.createElement("div");
    el.className = "status-bar-item";
    this.app.chrome.statusBarEl.appendChild(el);
    this.register(() => el.remove());
    return el;
  }

  registerObsidianProtocolHandler(action: string, handler: (params: Record<string, string>) => unknown): void {
    this.app.protocolHandlers.set(action, handler);
    this.register(() => this.app.protocolHandlers.delete(action));
  }

  registerHoverLinkSource(_id: string, _info: unknown): void {}

  registerExtensions(_extensions: string[], _viewType: string): void {}

  registerMarkdownPostProcessor(_postProcessor: unknown): void {}

  registerMarkdownCodeBlockProcessor(_language: string, _handler: unknown): void {}

  registerEditorExtension(_extension: unknown): void {}

  registerEditorSuggest(_suggest: unknown): void {}

  onExternalSettingsChange?(): unknown;
}
