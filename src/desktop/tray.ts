/**
 * Cortex Desktop's notification-area icon (Electron side; the menu itself is described in trayMenu.ts). It exists only
 * while "Notification-area icon" is on in Settings › Cortex Desktop (on by default) and never in a screenshot run.
 * A click opens the window; the menu lists what is in the record and what is waiting, and runs the same commands as
 * the menu bar. The status lines come from the renderer; nothing here reads the record.
 */
import { Menu, nativeImage, Tray, shell, type MenuItemConstructorOptions } from "electron";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { isSafeExportUrl } from "../shared/exportDue";
import { emptyTrayStatus, trayMenu, trayTooltip, type TrayHostAction, type TrayNode, type TrayStatus } from "./trayMenu";
import type { CommandId } from "../plugin/commands";

export interface TrayHost {
  appDir: string;
  /** Run a Cortex command in the main window (shows and focuses it first). */
  command(id: CommandId): void;
  action(a: TrayHostAction): void;
}

function templateOf(nodes: readonly TrayNode[], host: TrayHost): MenuItemConstructorOptions[] {
  return nodes.map((n): MenuItemConstructorOptions => {
    switch (n.kind) {
      case "separator":
        return { type: "separator" };
      case "info":
        return { label: n.label, enabled: false };
      case "submenu":
        return { label: n.label, submenu: templateOf(n.items, host) };
      case "command":
        return { label: n.label, click: () => host.command(n.id) };
      case "action":
        return { label: n.label, click: () => host.action(n.action) };
      case "check":
        return { label: n.label, type: "checkbox", checked: n.checked, click: () => host.action(n.action) };
      case "open-url":
        // Only a provider's own https page opens, in the system browser; nothing is sent.
        return { label: n.label, click: () => (isSafeExportUrl(n.url) ? void shell.openExternal(n.url) : undefined) };
    }
  });
}

export class CortexTray {
  private tray: Tray | null = null;
  private status: TrayStatus = emptyTrayStatus();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: TrayHost) {}

  get active(): boolean {
    return this.tray !== null && !this.tray.isDestroyed();
  }

  /** Show or remove the icon. Returns false when there is no icon file to draw (no icon, no tray). */
  setEnabled(on: boolean): boolean {
    if (!on) {
      this.destroy();
      return true;
    }
    if (this.active) return true;
    const file = path.join(this.host.appDir, "icon.ico");
    if (!existsSync(file)) return false;
    const image = nativeImage.createFromPath(file);
    if (image.isEmpty()) return false;
    const tray = new Tray(image);
    tray.on("click", () => this.host.action("show-window"));
    this.tray = tray;
    this.draw();
    // "Last added 16 minutes ago" stays true while the menu sits closed.
    this.timer = setInterval(() => this.draw(), 30_000);
    return true;
  }

  update(status: TrayStatus): void {
    this.status = status;
    this.draw();
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }

  private draw(): void {
    if (!this.tray || this.tray.isDestroyed()) return;
    this.tray.setToolTip(trayTooltip(this.status));
    this.tray.setContextMenu(Menu.buildFromTemplate(templateOf(trayMenu(this.status, Date.now()), this.host)));
  }
}
