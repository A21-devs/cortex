/**
 * The main process's side of the tray icon and the quick window, kept out of main.ts. The renderer sends one message,
 * "cortex:host-state" (the status lines and the launcher settings; trayMenu.parseHostState checks it), whenever
 * either changes. This class turns it into the tray icon and menu (tray.ts) and the quick window and its global
 * shortcut (launcher.ts), and sends back what a click asks for:
 *   "cortex:command"        run a Cortex command (the same channel the menu bar uses)
 *   "cortex:tray-action"    "toggle-live" (live capture on or off)
 *   "cortex:launcher-query" the quick window's Enter: { mode, text }, run in the command line
 *   "cortex:launcher-shortcut"  "taken" when another program already holds the shortcut
 * Screenshot runs build no tray and register no shortcut; `cortex:launcher-shot` draws the quick window offscreen
 * into the run's output folder so it can be looked at.
 */
import { app, BrowserWindow, globalShortcut, ipcMain } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { CommandId } from "../plugin/commands";
import { Launcher, type ShortcutResult } from "./launcher";
import type { LauncherSubmit } from "./launcherCore";
import { CortexTray } from "./tray";
import { DEFAULT_PREFS, parseHostState, type TrayHostAction, type TrayPrefs, type TrayStatus } from "./trayMenu";

export interface HostShellOptions {
  appDir: string;
  getWindow: () => BrowserWindow | null;
  /** The screenshot run's output folder, or null outside a screenshot run. */
  shotOut: string | null;
  dpr: number;
}

export class HostShell {
  private prefs: TrayPrefs = { ...DEFAULT_PREFS };
  private status: TrayStatus | null = null;
  private quitting = false;
  private lastShortcut: ShortcutResult = "off";
  private readonly tray: CortexTray;
  private readonly launcher: Launcher;

  constructor(private readonly o: HostShellOptions) {
    this.tray = new CortexTray({ appDir: o.appDir, command: (id) => this.command(id), action: (a) => this.action(a) });
    this.launcher = new Launcher({ appDir: o.appDir, onSubmit: (q) => this.query(q) });
  }

  /** The window, brought to the front (restored from the tray or minimised). */
  showMain(): BrowserWindow | null {
    const win = this.o.getWindow();
    if (!win || win.isDestroyed()) return null;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }

  private command(id: CommandId): void {
    this.showMain()?.webContents.send("cortex:command", id);
  }

  private action(a: TrayHostAction): void {
    if (a === "quit") {
      app.quit();
    } else if (a === "show-window") {
      this.showMain();
    } else {
      this.o.getWindow()?.webContents.send("cortex:tray-action", a);
    }
  }

  private query(q: LauncherSubmit): void {
    this.showMain()?.webContents.send("cortex:launcher-query", q);
  }

  /** Closing the window hides it when "Keep running in the tray when closed" is on and the icon is there. */
  hideInsteadOfQuit(): boolean {
    return !this.quitting && this.prefs.keepRunning && this.prefs.tray && this.tray.active;
  }

  markQuitting(): void {
    this.quitting = true;
  }

  registerIpc(): void {
    ipcMain.on("cortex:host-state", (e, raw: unknown) => {
      const win = this.o.getWindow();
      if (this.o.shotOut !== null || !win || e.sender !== win.webContents) return;
      const state = parseHostState(raw);
      if (!state) return;
      this.apply(state.status, state.prefs);
    });
    if (this.o.shotOut !== null) {
      const out = this.o.shotOut;
      ipcMain.handle("cortex:launcher-shot", async (_e, name: unknown, space: unknown) => {
        if (typeof name !== "string" || !/^[\w.-]{1,60}\.png$/.test(name)) throw new Error("the quick window picture needs a plain .png name");
        const image = await this.launcher.shotImage(typeof space === "string" ? space.slice(0, 80) : "", this.o.dpr);
        if (image.isEmpty()) throw new Error("the quick window picture is empty");
        const file = path.join(out, name);
        mkdirSync(out, { recursive: true });
        const png = image.toPNG();
        writeFileSync(file, png);
        return { path: file, ...image.getSize(), bytes: png.length };
      });
    }
  }

  private apply(status: TrayStatus, prefs: TrayPrefs): void {
    this.status = status;
    this.prefs = prefs;
    this.tray.setEnabled(prefs.tray);
    this.tray.update(status);
    const result = this.launcher.configure({ quickWindow: prefs.quickWindow, quickShortcut: prefs.quickShortcut }, status.space);
    this.launcher.setSpace(status.space);
    if (result === "taken" && this.lastShortcut !== "taken") this.o.getWindow()?.webContents.send("cortex:launcher-shortcut", "taken");
    this.lastShortcut = result;
  }

  /** The last status the renderer sent (for diagnostics and tests). */
  get current(): TrayStatus | null {
    return this.status;
  }

  dispose(): void {
    this.launcher.destroy();
    this.tray.destroy();
    globalShortcut.unregisterAll();
  }
}
