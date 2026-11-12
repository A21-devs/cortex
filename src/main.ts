/**
 * Cortex plugin entry. Owner: E1.
 *
 * Load budget: < 50 ms (target < 15 ms). The EAGER core (this file, settings, commands, settings tab, icons,
 * status bar text, link parsing, the view shell) only reads data.json and registers the view, ribbon icon,
 * commands, settings tab, status bar item, protocol handler, hover-link source and menus. Everything heavy —
 * the service containers, Preact UI, three.js renderer, worker source, modals — lives in the lazy chunk
 * (src/lazyEntry.ts, built apart and embedded in main.js as a string that is compiled on first use; see
 * src/lazy.ts). tests/build.test.ts checks the eager graph and its evaluation time against the real build.
 *
 * Background work (H2) is scheduled at onLayoutReady: 30 s + idle → the headless tier → AgentsClock, whether or
 * not a Cortex tab is open — but only after the first-run step (SAFE-11) and never with corrupt settings
 * (SAFE-08). The view never opens itself unless "Open Cortex when Obsidian starts" is on.
 */
import { addIcon, Notice, Plugin, type WorkspaceLeaf } from "obsidian";
import type { CortexSettings } from "./shared/settings";
import type { BackgroundServices, CortexServices, SettingsHandle } from "./plugin/services";
import { registerCommands, type CommandId } from "./plugin/commands";
import { CortexSettingTab, type SettingsTabHost } from "./plugin/settingsTab";
import { CortexSettingsModal } from "./plugin/settingsModal";
import { SETTINGS_WINDOW_CLOSE_EVENT, SETTINGS_WINDOW_EVENT, type SettingsSection } from "./shared/settingsTabs";
import { createSettingsHandle, loadSettings, type SettingsPersistence } from "./plugin/settingsStore";
import { ACTIVITY_EVENTS, createActivityTracker, scheduleBackgroundStart, windowTimers, type BackgroundSchedule } from "./plugin/background";
import { bindStatusBar, createStatusBar, type StatusBarService } from "./plugin/statusBar";
import { createNoticeService, noticeForError, noticeText, type NoticeService } from "./plugin/notices";
import { parseCortexLink, revealCortexLeaf } from "./plugin/obsidianBridge";
import { createSharedStore, type SharedStore } from "./state/store";
import { appLocked, lockApp } from "./state/lock";
import { setEncryptionConfigured, recordKeyState } from "./shared/crypto/keyring";
import { keyFilePresent } from "./plugin/recordKeys";
import { closeSettingsWindow } from "./ui/openSettings";
import { shouldAutoLock } from "./shared/lock";
import { t } from "./ui/copy";
import { CORTEX_GLYPH_SVG, CORTEX_ICON_ID } from "./ui/icons";
import { CortexView, VIEW_TYPE_CORTEX } from "./ui/CortexView";
import { lazyCommandRun, lazyContainer, lazyMount } from "./lazy";

export default class CortexPlugin extends Plugin {
  private settings!: SettingsHandle;
  private shared!: SharedStore;
  private notices!: NoticeService;
  private background: Promise<BackgroundServices> | null = null;
  private services: Promise<CortexServices> | null = null;
  private statusBar: StatusBarService | null = null;
  private schedule: BackgroundSchedule | null = null;
  private unbindStatus: (() => void) | null = null;
  private readonly activity = createActivityTracker();
  private unloaded = false;

  override async onload(): Promise<void> {
    const t0 = performance.now();
    const persistence = this.settingsPersistence();
    this.settings = createSettingsHandle(await loadSettings(persistence), persistence, () => this.onSettingsChanged());
    this.applyEncryption(true);
    this.shared = createSharedStore();
    this.notices = createNoticeService({ now: () => Date.now(), anyLeafVisible: () => this.anyLeafVisible(), show: (text) => void new Notice(text) });
    addIcon(CORTEX_ICON_ID, CORTEX_GLYPH_SVG);
    this.registerView(VIEW_TYPE_CORTEX, (leaf: WorkspaceLeaf) => new CortexView(leaf, { getServices: () => this.getServices(), loadUi: lazyMount, isLayoutReady: () => this.app.workspace.layoutReady === true }));
    this.addRibbonIcon(CORTEX_ICON_ID, "Open Cortex", () => void this.activateView());
    registerCommands(this, (id) => this.runCommand(id));
    const settingsHost: SettingsTabHost = { plugin: this, settings: () => this.settings, services: () => this.getServices() };
    this.addSettingTab(new CortexSettingTab(this.app, settingsHost));
    this.registerSettingsWindow(settingsHost);
    this.registerStatusBar();
    this.registerActivity();
    this.registerAutoLock();
    // Locking puts the Settings window away too: it sits above the lock card and must not stay readable behind a locked record.
    this.register(appLocked.subscribe((locked) => (locked ? closeSettingsWindow(this.app) : undefined)));
    this.registerBridge();
    this.app.workspace.onLayoutReady(() => this.onLayoutReady());
    if (this.settings.value.general.debug) console.debug(`[cortex] onload ${(performance.now() - t0).toFixed(1)} ms`);
  }

  override onunload(): void {
    this.unloaded = true;
    this.schedule?.cancel();
    this.schedule = null;
    this.unbindStatus?.();
    this.unbindStatus = null;
    const bg = this.background;
    const services = this.services;
    this.background = null;
    this.services = null;
    void (async () => {
      try {
        const [{ disposeBackground, disposeServices }, built, b] = await Promise.all([lazyContainer(), services?.catch(() => null), bg?.catch(() => null)]);
        if (built) disposeServices(built);
        // The clock stops BEFORE the runner goes away (its fs.watch handles close first).
        if (b) await disposeBackground(b);
      } catch (e) {
        console.warn("[cortex] unload cleanup failed", e);
      }
    })();
    this.statusBar?.dispose();
    this.statusBar = null;
  }

  /** Obsidian calls this when data.json changed on disk (OneDrive sync from another computer). */
  override async onExternalSettingsChange(): Promise<void> {
    await this.settings.reload();
  }

  private settingsPersistence(): SettingsPersistence {
    const dir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
    const adapter = this.app.vault?.adapter as unknown as { exists?(p: string): Promise<boolean>; read?(p: string): Promise<string>; write?(p: string, d: string): Promise<void> } | undefined;
    return {
      load: () => this.loadData(),
      exists: async () => (adapter?.exists ? adapter.exists(`${dir}/data.json`) : false),
      save: (s: CortexSettings) => this.saveData(s),
      backup: async () => {
        if (!adapter?.exists || !adapter.read || !adapter.write) return;
        if (!(await adapter.exists(`${dir}/data.json`))) return;
        await adapter.write(`${dir}/.data.json.bak`, await adapter.read(`${dir}/data.json`));
      },
      keepUnreadable: async () => {
        if (!adapter?.exists || !adapter.read || !adapter.write) return;
        if (!(await adapter.exists(`${dir}/data.json`))) return;
        await adapter.write(`${dir}/.data.json.unreadable`, await adapter.read(`${dir}/data.json`));
      },
    };
  }

  private registerStatusBar(): void {
    const el = this.addStatusBarItem();
    this.statusBar = createStatusBar(el, () => void this.activateView().then((s) => s && this.runCommand("open-agents")));
    this.unbindStatus = bindStatusBar(this.statusBar, this.shared, this.settings);
  }

  /**
   * "Only work while Obsidian is idle" and the idle auto-lock need to know when the person last used it. Passive, capture
   * phase. Only real input counts: an event a script dispatched (Showcase mode's pointer along the Time bars) is not the
   * person, so a tour left running does not keep the record from locking.
   */
  private registerActivity(): void {
    if (typeof document === "undefined") return;
    for (const type of ACTIVITY_EVENTS) this.registerDomEvent(document, type, (e: Event) => void (e.isTrusted !== false && this.activity.touch()), { passive: true, capture: true });
  }

  /** Cortex: Lock after N idle minutes (Settings > Privacy > Lock; 0 = never). Only while a Cortex view is open. */
  private registerAutoLock(): void {
    if (typeof window === "undefined") return;
    this.registerInterval(
      window.setInterval(() => {
        if (this.settings.corrupt) return;
        if (!shouldAutoLock(this.activity.idleMs(), this.settings.value.privacy.lock.autoLockMinutes, appLocked.value)) return;
        // An open encrypted record also locks with no Cortex view showing: the key must not outlive the idle time.
        if (this.app.workspace.getLeavesOfType(VIEW_TYPE_CORTEX).length > 0 || recordKeyState() === "open") lockApp();
      }, 15_000),
    );
  }

  private anyLeafVisible(): boolean {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE_CORTEX).some((l) => {
      const el = (l.view as { containerEl?: { isShown?: () => boolean } } | undefined)?.containerEl;
      return typeof el?.isShown === "function" ? el.isShown() : true;
    });
  }

  /** Cortex's Settings window (an Obsidian modal) opens on the workspace event the gear, the commands and the links send; one window at a time. */
  private registerSettingsWindow(host: SettingsTabHost): void {
    const ws = this.app.workspace as unknown as { on?: (name: string, cb: (...args: unknown[]) => void) => unknown };
    if (typeof ws.on !== "function") return;
    let open: CortexSettingsModal | null = null;
    this.registerEvent(
      ws.on(SETTINGS_WINDOW_EVENT, (section) => {
        const id = (typeof section === "string" ? section : "general") as SettingsSection;
        if (open?.isOpen) return open.show(id);
        open = new CortexSettingsModal(this.app, host, id);
        open.open();
      }) as never,
    );
    this.registerEvent(ws.on(SETTINGS_WINDOW_CLOSE_EVENT, () => void (open?.isOpen ? open.close() : undefined)) as never);
  }

  /** Protocol handler, hover-link source, file/editor menus and file-open: registered cheaply, resolved lazily. */
  private registerBridge(): void {
    this.registerObsidianProtocolHandler?.("cortex", (params) => {
      const link = parseCortexLink(params as Record<string, string | undefined>);
      if (!link) return;
      void this.activateView().then((s) => s?.bridge.open(link));
    });
    this.registerHoverLinkSource?.("cortex", { display: "Cortex", defaultMod: true });
    const ws = this.app.workspace as unknown as { on?: (name: string, cb: (...args: unknown[]) => void) => unknown };
    if (typeof ws.on === "function") {
      this.registerEvent(ws.on("file-open", (file) => void this.background?.then((b) => b.bus.emit("active-note", { path: (file as { path?: string } | null)?.path ?? null }))) as never);
      // §2.1: "Show in Cortex" on notes and folders, "Show this note in Cortex" in the editor menu (navigation only).
      const show = (path: string | undefined) => {
        if (!path) return;
        void this.activateView().then((s) => s?.bridge.open({ kind: "note", path }));
      };
      type MenuLike = { addItem(cb: (item: { setTitle(t: string): unknown; setIcon(i: string): unknown; onClick(f: () => void): unknown }) => void): unknown };
      this.registerEvent(
        ws.on("file-menu", (menu, file) =>
          (menu as MenuLike).addItem((item) => {
            item.setTitle("Show in Cortex");
            item.setIcon(CORTEX_ICON_ID);
            item.onClick(() => show((file as { path?: string }).path));
          }),
        ) as never,
      );
      this.registerEvent(
        ws.on("editor-menu", (menu, _editor, info) =>
          (menu as MenuLike).addItem((item) => {
            item.setTitle("Show this note in Cortex");
            item.setIcon(CORTEX_ICON_ID);
            item.onClick(() => show((info as { file?: { path?: string } | null }).file?.path));
          }),
        ) as never,
      );
    }
  }

  private onLayoutReady(): void {
    if (this.unloaded) return;
    if (this.settings.value.general.openOnStartup) void this.activateView();
    this.schedule = scheduleBackgroundStart(
      windowTimers(globalThis as unknown as Window),
      { firstRunDone: () => this.settings.value.general.firstRunDone, corrupt: () => this.settings.corrupt },
      () => void this.startBackgroundTier(),
      {
        onGated: (reason) => {
          if (reason === "corrupt") this.notices.notify("settings", t("notices.settings"));
          else this.notices.notify("first-run", t("notices.firstRun"));
        },
      },
    );
  }

  /** Build (if needed) and start the background tier. Only called with the gate open. */
  private async startBackgroundTier(): Promise<void> {
    if (!this.backgroundAllowed()) return;
    try {
      const [bg, { startBackground }] = await Promise.all([this.getBackground(), lazyContainer()]);
      if (!this.unloaded) await startBackground(bg);
      // Optional (off by default): one notice a day while an archive export is due. Builds nothing when it is off.
      if (!this.unloaded && this.settings.value.sources.exportReminders.notify) {
        void Promise.all([this.getServices(), import("./plugin/exportReminder")]).then(([s, m]) => m.runExportReminder(this.app, s), () => undefined);
      }
    } catch (e) {
      console.warn("[cortex] background start failed", e);
    }
  }

  /** An encrypted record starts locked and takes no plain writes: tell the key ring (from the setting, or from a key file in the vault). */
  private applyEncryption(atStart: boolean): void {
    const base = (this.app.vault?.adapter as { getBasePath?: () => string } | undefined)?.getBasePath?.();
    const on = this.settings.value.record?.encryption?.enabled === true || (base !== undefined && keyFilePresent(base));
    setEncryptionConfigured(on);
    if (atStart && on) lockApp();
  }

  private onSettingsChanged(): void {
    this.applyEncryption(false);
    // The first-run step writing its choice (or the settings becoming readable) opens the gate.
    this.schedule?.recheck();
  }

  /**
   * Host hooks. Obsidian uses these defaults; Cortex Desktop (src/desktop/renderer.ts) overrides them: its runner
   * lives next to its own bundle (built with the same build id), and its view-only runs start no background work.
   */
  protected pluginFolder(vaultRoot: string, path: typeof import("node:path")): string {
    return path.join(vaultRoot, this.manifest.dir ?? path.join(".obsidian", "plugins", this.manifest.id));
  }

  protected backgroundAllowed(): boolean {
    return true;
  }

  getBackground(): Promise<BackgroundServices> {
    if (!this.background) {
      const building = (async () => {
        const [{ createBackground, vaultBasePath }, path] = await Promise.all([lazyContainer(), import("node:path")]);
        const vaultRoot = vaultBasePath(this.app);
        const pluginDir = this.pluginFolder(vaultRoot, path);
        return createBackground({
          app: this.app,
          pluginDir,
          pluginVersion: this.manifest.version,
          settings: this.settings,
          shared: this.shared,
          notices: this.notices,
          ...(this.statusBar ? { statusBar: this.statusBar } : {}),
          anyLeafVisible: () => this.anyLeafVisible(),
          showNotice: (text) => void new Notice(text),
          idleMs: () => this.activity.idleMs(),
        });
      })();
      this.background = building;
      building.catch(() => {
        if (this.background === building) this.background = null; // a failed build may be retried by the next command
      });
    }
    return this.background;
  }

  getServices(): Promise<CortexServices> {
    if (!this.services) {
      const building = (async () => {
        const [bg, { createServices }] = await Promise.all([this.getBackground(), lazyContainer()]);
        return createServices(bg, { reveal: (opts) => revealCortexLeaf(this.app, opts) });
      })();
      this.services = building;
      building.catch(() => {
        if (this.services === building) this.services = null;
      });
    }
    return this.services;
  }

  private runCommand(id: CommandId): void {
    void this.withServices(async (s) => {
      const { runCommand } = await lazyCommandRun();
      await runCommand(id, s, {
        app: this.app,
        reveal: (opts) => revealCortexLeaf(this.app, opts),
        notice: (text) => void new Notice(text),
        manifest: this.manifest,
        ensureBackground: async () => {
          if (this.settings.corrupt || !this.settings.value.general.firstRunDone) return;
          await this.startBackgroundTier();
        },
      });
    });
  }

  private async withServices<T>(fn: (s: CortexServices) => T | Promise<T>): Promise<T | undefined> {
    try {
      return await fn(await this.getServices());
    } catch (e) {
      new Notice(noticeForError(e) ?? noticeText("failed"));
      return undefined;
    }
  }

  async activateView(): Promise<CortexServices | undefined> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CORTEX)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_CORTEX, active: true });
    }
    await workspace.revealLeaf(leaf);
    return this.withServices((s) => s);
  }
}
