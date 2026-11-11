/**
 * Cortex Desktop's quick window (Electron side; the pure parts are in launcherCore.ts): a small frameless,
 * always-on-top box showing the name of the area on the stage and one "Ask or search" field. It is opt-in (Settings ›
 * Cortex Desktop › Tray and quick window): until the person turns it on there is no window and no shortcut registered
 * with the system. A global shortcut (default Ctrl+Shift+Space) shows and hides it; Esc or losing focus hides it;
 * Enter hands the text to the main window, which opens and runs it in its command line.
 *
 * The page is a local file with no Node access (context isolation, sandbox, a preload with three calls). Every
 * message it sends is checked again here (launcherCore.parseLauncherSubmit) and only accepted from this window.
 */
import { BrowserWindow, globalShortcut, ipcMain, screen, type NativeImage } from "electron";
import * as path from "node:path";
import { launcherBounds, launcherInit, LAUNCHER_SIZE, parseLauncherSubmit, shortcutToRegister, type LauncherPrefs, type LauncherSubmit } from "./launcherCore";

export interface LauncherHost {
  /** The folder of the desktop bundle (launcher.html, launcher-preload.js). */
  appDir: string;
  /** The person pressed Enter: open the main window and run it. */
  onSubmit(q: LauncherSubmit): void;
}

export type ShortcutResult = "off" | "registered" | "taken";

export class Launcher {
  private win: BrowserWindow | null = null;
  private registered: string | null = null;
  private space = "";
  private ipcDone = false;
  /** The pages (by web contents id) whose script has started and is listening. */
  private readonly ready = new Set<number>();
  /** The area name a screenshot run's window shows. */
  private shotSpace = "";

  constructor(private readonly host: LauncherHost) {}

  /** Apply the settings: (un)register the shortcut and build or drop the window. Returns how the shortcut went. */
  configure(prefs: LauncherPrefs, space: string): ShortcutResult {
    this.space = space;
    const want = shortcutToRegister(prefs);
    if (want !== this.registered) {
      if (this.registered !== null) globalShortcut.unregister(this.registered);
      this.registered = null;
      if (want !== null) {
        let ok = false;
        try {
          ok = globalShortcut.register(want, () => this.toggle());
        } catch {
          ok = false;
        }
        if (!ok) {
          this.destroyWindow();
          return "taken";
        }
        this.registered = want;
      }
    }
    if (this.registered === null) {
      this.destroyWindow();
      return want === null ? "off" : "taken";
    }
    this.ensureWindow();
    return "registered";
  }

  /** The area name changed on the stage; the window shows it the next time it opens (and now, if it is open). */
  setSpace(space: string): void {
    this.space = space;
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.sendInit(this.win);
  }

  toggle(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.hide();
    else this.show();
  }

  show(): void {
    const win = this.ensureWindow();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    win.setBounds(launcherBounds(display.workArea));
    this.sendInit(win);
    win.show();
    win.focus();
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }

  destroy(): void {
    if (this.registered !== null) globalShortcut.unregister(this.registered);
    this.registered = null;
    this.destroyWindow();
  }

  /** Screenshot runs: draw the window offscreen and return its picture; nothing is shown or registered. */
  async shotImage(space: string, dpr: number): Promise<NativeImage> {
    this.shotSpace = space;
    this.registerIpc();
    const win = this.build({ offscreen: true, dpr });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the quick window did not load")), 15_000);
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        win.webContents.once("did-finish-load", done);
      });
      await new Promise((r) => setTimeout(r, 500));
      win.webContents.invalidate();
      await new Promise((r) => setTimeout(r, 120));
      return await win.webContents.capturePage(undefined, { stayHidden: true });
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  // ───────────────────────────── the window ─────────────────────────────

  private build(o: { offscreen: boolean; dpr?: number }): BrowserWindow {
    const win = new BrowserWindow({
      width: LAUNCHER_SIZE.width,
      height: LAUNCHER_SIZE.height,
      show: false,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: !o.offscreen,
      title: "Cortex",
      backgroundColor: "#000000",
      webPreferences: {
        preload: path.join(this.host.appDir, "launcher-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
        ...(o.offscreen ? { offscreen: { deviceScaleFactor: o.dpr ?? 1 } } : {}),
      },
    });
    if (o.offscreen) win.webContents.setFrameRate(30);
    else win.setAlwaysOnTop(true, "pop-up-menu");
    win.setMenu(null);
    const id = win.webContents.id;
    win.on("closed", () => this.ready.delete(id));
    void win.loadFile(path.join(this.host.appDir, "launcher.html"));
    return win;
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = this.build({ offscreen: false });
    this.win = win;
    this.registerIpc();
    win.on("blur", () => {
      if (!win.isDestroyed()) win.hide();
    });
    win.on("closed", () => {
      if (this.win === win) this.win = null;
    });
    return win;
  }

  private destroyWindow(): void {
    const w = this.win;
    this.win = null;
    if (w && !w.isDestroyed()) w.destroy();
  }

  /** The page asks for its words when it has started (its "ready" message); before that a message would be lost. */
  private sendInit(win: BrowserWindow, space: string = this.space, pageReady = this.ready.has(win.webContents.id)): void {
    if (win.isDestroyed() || !pageReady) return;
    win.webContents.send("cortex:launcher-init", launcherInit(space));
  }

  private fromWindow(sender: Electron.WebContents): boolean {
    return this.win !== null && !this.win.isDestroyed() && sender === this.win.webContents;
  }

  private registerIpc(): void {
    if (this.ipcDone) return;
    this.ipcDone = true;
    ipcMain.on("cortex:launcher-ready", (e) => {
      this.ready.add(e.sender.id);
      const win = BrowserWindow.fromWebContents(e.sender);
      if (win && !win.isDestroyed()) this.sendInit(win, this.fromWindow(e.sender) ? this.space : this.shotSpace, true);
    });
    ipcMain.on("cortex:launcher-hide", (e) => {
      if (this.fromWindow(e.sender)) this.hide();
    });
    ipcMain.on("cortex:launcher-submit", (e, raw: unknown) => {
      if (!this.fromWindow(e.sender)) return;
      const q = parseLauncherSubmit(raw);
      if (!q) return;
      this.hide();
      this.host.onSubmit(q);
    });
  }
}
