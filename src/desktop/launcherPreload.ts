/**
 * The quick window's preload (context isolation on, no Node in the page): three calls and nothing else.
 *   onInit(fn)   the words and the area name, sent once the page has loaded and again every time the window opens
 *   submit(..)   the typed text and the mode (Enter searches, Ctrl+Enter asks)
 *   hide()       Esc
 * The main process checks every message again (launcherCore.parseLauncherSubmit).
 */
import { contextBridge, ipcRenderer } from "electron";
import type { LauncherInit, LauncherSubmit } from "./launcherCore";

contextBridge.exposeInMainWorld("cortexLauncher", {
  onInit(fn: (init: LauncherInit) => void): void {
    ipcRenderer.on("cortex:launcher-init", (_e, init: LauncherInit) => fn(init));
    ipcRenderer.send("cortex:launcher-ready");
  },
  submit(m: LauncherSubmit): void {
    ipcRenderer.send("cortex:launcher-submit", m);
  },
  hide(): void {
    ipcRenderer.send("cortex:launcher-hide");
  },
});
