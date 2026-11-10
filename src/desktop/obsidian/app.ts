/**
 * Obsidian's `App` for Cortex Desktop: vault, metadataCache, workspace, keymap and scope, settings page,
 * commands, local storage and the protocol handlers, put together by App.open() for one vault folder.
 * open() loads every visible file and parses every note before it returns, so Cortex never reads a half-built
 * metadata cache (vault.cxi is built from it).
 */
import { Keymap, Scope } from "./component";
import { setShimContext } from "./context";
import { setRendererHost } from "./markdownRenderer";
import { MetadataCache, type MetadataLoadStats } from "./metadataCache";
import type { Command } from "./plugin";
import { SettingsPage } from "./setting";
import { FileSystemAdapter, Vault, type PluginDataMount } from "./vault";
import { Workspace, type WorkspaceHost } from "./workspace";

export interface AppOptions {
  vaultRoot: string;
  /** Per-vault prefix for local storage (Obsidian keys localStorage by vault too). */
  storageKey: string;
  /** The plugin's data folder mount (data.json lives outside the vault). */
  mount: PluginDataMount;
  /** The element that becomes the workspace (fills the window). */
  hostEl: HTMLElement;
  /** Where menus, modals, notices and the settings page are attached. */
  layerEl: HTMLElement;
  workspaceHost: WorkspaceHost;
  /** Open an external URL in the system browser. */
  openExternal(url: string): void;
  /** Watch the vault for changes (off in the screenshot harness, which wants a fixed picture). */
  watch: boolean;
  onProgress?(phase: "files" | "notes", done: number, total: number): void;
}

class Commands {
  readonly commands: Record<string, Command> = {};

  addCommand(c: Command): void {
    this.commands[c.id] = c;
  }

  removeCommand(id: string): void {
    delete this.commands[id];
  }

  listCommands(): Command[] {
    return Object.values(this.commands);
  }

  findCommand(id: string): Command | undefined {
    return this.commands[id];
  }

  /** Run a command by its full id ("cortex:open-read"); false when it does not exist or is not available. */
  executeCommandById(id: string): boolean {
    const c = this.commands[id];
    if (!c) return false;
    try {
      if (c.callback) {
        void c.callback();
        return true;
      }
      if (c.checkCallback) {
        if (c.checkCallback(true) === false) return false;
        c.checkCallback(false);
        return true;
      }
    } catch (e) {
      console.error(`[cortex-desktop] command ${id} failed`, e);
    }
    return false;
  }
}

export class App {
  readonly vault: Vault;
  readonly metadataCache: MetadataCache;
  readonly workspace: Workspace;
  readonly scope = new Scope();
  readonly keymap: Keymap;
  readonly setting = new SettingsPage();
  readonly commands = new Commands();
  readonly protocolHandlers = new Map<string, (params: Record<string, string>) => unknown>();
  readonly plugins: { plugins: Record<string, unknown>; enabledPlugins: Set<string> } = { plugins: {}, enabledPlugins: new Set() };
  readonly chrome: { statusBarEl: HTMLElement; ribbonEl: HTMLElement };
  readonly isMobile = false;
  lastEvent: UIEvent | null = null;
  readonly appId: string;
  loadStats: MetadataLoadStats | null = null;
  private detachKeymap: (() => void) | null = null;

  private constructor(private readonly opts: AppOptions) {
    this.appId = opts.storageKey;
    this.vault = new Vault(new FileSystemAdapter(opts.vaultRoot, opts.mount));
    this.metadataCache = new MetadataCache(this.vault);
    this.keymap = new Keymap(this.scope);
    this.workspace = new Workspace(this, opts.hostEl, opts.workspaceHost);
    const hidden = document.createElement("div");
    hidden.className = "cxd-hidden-chrome";
    hidden.hidden = true;
    const statusBarEl = document.createElement("div");
    statusBarEl.className = "status-bar";
    const ribbonEl = document.createElement("div");
    ribbonEl.className = "side-dock-ribbon";
    hidden.append(statusBarEl, ribbonEl);
    opts.layerEl.appendChild(hidden);
    this.chrome = { statusBarEl, ribbonEl };
  }

  /** Open a vault folder: list its files, parse its notes, wire the keymap and the shim's globals. */
  static async open(opts: AppOptions): Promise<App> {
    const app = new App(opts);
    setShimContext({ keymap: app.keymap, layer: () => opts.layerEl });
    setRendererHost({
      resourceFor: (linkpath, sourcePath) => {
        const f = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
        return f ? app.vault.getResourcePath(f) : null;
      },
      openLink: (linktext, sourcePath) => void app.workspace.openLinkText(linktext, sourcePath),
      openExternal: (url) => opts.openExternal(url),
    });
    await app.vault.load();
    opts.onProgress?.("files", app.vault.getFiles().length, app.vault.getFiles().length);
    app.loadStats = await app.metadataCache.initialize((done, total) => opts.onProgress?.("notes", done, total));
    if (opts.watch) {
      app.vault.onChanges = (c) => app.metadataCache.applyChanges(c);
      app.vault.startWatching();
    }
    app.detachKeymap = app.keymap.attach(window);
    const remember = (e: Event): void => {
      app.lastEvent = e as UIEvent;
    };
    window.addEventListener("pointerdown", remember, true);
    window.addEventListener("keydown", remember, true);
    return app;
  }

  /** Obsidian's per-vault local storage (JSON in window.localStorage). */
  loadLocalStorage(key: string): unknown {
    try {
      const raw = window.localStorage.getItem(`${this.appId}-${key}`);
      return raw === null ? null : (JSON.parse(raw) as unknown);
    } catch {
      return null;
    }
  }

  saveLocalStorage(key: string, data: unknown): void {
    const k = `${this.appId}-${key}`;
    if (data === null || data === undefined) window.localStorage.removeItem(k);
    else window.localStorage.setItem(k, JSON.stringify(data));
  }

  openWithDefaultApp(path: string): Promise<void> {
    this.opts.openExternal(new URL(`file:///${this.vault.adapter.getFullPath(path).replace(/\\/g, "/")}`).href);
    return Promise.resolve();
  }

  close(): void {
    this.workspace.flushLayout();
    this.vault.stopWatching();
    this.detachKeymap?.();
    this.detachKeymap = null;
    setShimContext(null);
  }
}
