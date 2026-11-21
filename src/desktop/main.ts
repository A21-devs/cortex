/**
 * Cortex Desktop, Electron main process. Opens one dark window that runs the Cortex plugin code outside Obsidian
 * (src/desktop/renderer.ts with the "obsidian" shim), and drives the screenshot harness (scripts/desktop-shot.mjs).
 *
 * Window: background #000, hidden title bar with Windows' own buttons drawn over the right end of Cortex's 44 px
 * header, minimum 1100 × 700, size / position / maximised remembered in %APPDATA%\Cortex\window.json, an application
 * menu (menu.ts: Cortex, Edit, View, Window, Help; the hidden title bar draws no bar, so Alt, F10 or a right click on the
 * title strip pop it up; items run the matching Cortex command in the page) and Ctrl+Shift+I / F12 developer tools,
 * Ctrl+R / F5 reload, F11 full screen). The page is a trusted local
 * bundle with Node access (like Obsidian): navigation away from it and new windows are refused; http(s), mailto
 * and obsidian links open in the system.
 *
 * Settings: %APPDATA%\Cortex\desktop.json keeps the chosen vault; each vault's Cortex settings live in
 * %APPDATA%\Cortex\vaults\<vaultKey>\data.json (first read from the vault's own plugin data.json, never written).
 *
 * Screenshot runs (--shot): a throw-away profile and a window that is never shown. By default it uses Electron's
 * offscreen rendering, driven at 60 frames a second (a hidden window is painted too, but Chromium gives it about
 * one frame a second); timers are never throttled and the page always counts as visible (renderer.ts), so the
 * figure keeps animating. Wait until the index is loaded and the figure has points, let the growth settle, run
 * the steps, capturePage() to PNGs (DOM and WebGL together), write shot-report.json, exit 0 (or 1 with the reason).
 * A stand-in agents status (--agents-status, or an agentsStatus step) is read and checked before the app is waited
 * for and handed to the page, which applies it as the runner's own status (renderer.ts); the runner is not asked.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, screen, session, shell, type MenuItemConstructorOptions, type Rectangle } from "electron";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { vaultKey } from "../shared/ids";
import type { AgentsStatusResult } from "../shared/protocol/runner";
import { DEFAULT_VAULT_NAME, parseLaunchArgs, type DesktopConfig, type LaunchOptions, type ShotOptions } from "./config";
import { HostShell } from "./hostShell";
import { desktopMenu, type MenuNode } from "./menu";
import { loadStatusFiles, parseStepsText, readAgentsStatus, StepError, type ShotStep } from "./shotSteps";

const APP_DIR = __dirname;
const CORTEX_HOME = path.join(app.getPath("appData"), "Cortex");
const MIN_W = 1100;
const MIN_H = 700;
const HEADER_H = 32;

let launch: LaunchOptions;
try {
  launch = parseLaunchArgs(process.argv.slice(1));
} catch (e) {
  process.stderr.write(`cortex-desktop: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}

app.setName("Cortex");
let ownProfile: string | null = null;
/** False when another Cortex Desktop window already runs (it is focused instead). */
let primary = true;
if (launch.shot) {
  const profile = launch.shot.profile ?? (ownProfile = mkdtempSync(path.join(os.tmpdir(), "cortex-shot-")));
  app.setPath("userData", profile);
  app.commandLine.appendSwitch("force-device-scale-factor", String(launch.shot.dpr));
  // A window that is never shown must still paint and animate at full rate.
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
} else {
  app.setPath("userData", CORTEX_HOME);
  primary = app.requestSingleInstanceLock();
  if (!primary) app.quit();
}

// ───────────────────────────── small stores ─────────────────────────────

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, file);
  } catch (e) {
    console.warn("[cortex-desktop] could not save", file, e);
  }
}

interface DesktopPrefs {
  vault?: string;
}

const prefsFile = path.join(CORTEX_HOME, "desktop.json");
const windowFile = path.join(CORTEX_HOME, "window.json");

function isVault(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && statSync(path.join(dir, ".obsidian")).isDirectory();
  } catch {
    return false;
  }
}

let currentVault: string = path.resolve(launch.vault ?? readJson<DesktopPrefs>(prefsFile)?.vault ?? path.join(app.getPath("documents"), DEFAULT_VAULT_NAME));

const MANIFEST = readJson<DesktopConfig["manifest"]>(path.join(APP_DIR, "manifest.json")) ?? { id: "cortex", name: "Cortex", version: app.getVersion(), minAppVersion: "1.12.0", description: "", author: "Cortex" };

function configFor(vaultRoot: string): DesktopConfig {
  const key = vaultKey(vaultRoot);
  return {
    manifest: MANIFEST,
    vaultRoot,
    vaultKey: key,
    vaultName: path.basename(vaultRoot),
    appDir: APP_DIR,
    dataDir: path.join(CORTEX_HOME, "vaults", key),
    seedDir: path.join(vaultRoot, ".obsidian", "plugins", "cortex"),
    viewOnly: launch.viewOnly,
    shot: launch.shot !== null,
    device: launch.shot ? launch.shot.device : null,
    versions: { app: app.getVersion(), electron: process.versions.electron ?? "", chrome: process.versions.chrome ?? "", node: process.versions.node ?? "" },
  };
}

// ───────────────────────────── safety ─────────────────────────────

const EXTERNAL = /^(https?:|mailto:|obsidian:)/i;

function openExternalSafe(url: string): void {
  if (EXTERNAL.test(url)) void shell.openExternal(url);
}

app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (ev, url) => {
    if (url === contents.getURL()) return;
    ev.preventDefault();
    openExternalSafe(url);
  });
});

// ───────────────────────────── IPC ─────────────────────────────

function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.on("cortex:config", (e) => {
    e.returnValue = configFor(currentVault);
  });
  ipcMain.on("cortex:get-path", (e, name: unknown) => {
    const allowed = ["downloads", "documents", "desktop", "home", "pictures", "temp"] as const;
    e.returnValue = typeof name === "string" && (allowed as readonly string[]).includes(name) ? app.getPath(name as (typeof allowed)[number]) : null;
  });
  ipcMain.handle("cortex:choose-vault", async () => {
    const win = getWindow();
    const opts = { title: "Choose your Obsidian vault folder", defaultPath: currentVault, properties: ["openDirectory"] as ("openDirectory")[] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const chosen = r.canceled ? null : (r.filePaths[0] ?? null);
    if (!chosen) return { status: "cancelled" };
    if (!isVault(chosen)) return { status: "not-a-vault", path: chosen };
    currentVault = path.resolve(chosen);
    if (!launch.shot) writeJson(prefsFile, { ...(readJson<DesktopPrefs>(prefsFile) ?? {}), vault: currentVault });
    return { status: "ok", path: currentVault };
  });
  ipcMain.handle("cortex:reload", () => {
    getWindow()?.webContents.reload();
  });
  ipcMain.handle("cortex:dialog", async (_e, kind: unknown, opts: unknown) => {
    const win = getWindow();
    const o = (opts && typeof opts === "object" ? opts : {}) as Electron.SaveDialogOptions & Electron.OpenDialogOptions;
    if (kind === "save") return win ? dialog.showSaveDialog(win, o) : dialog.showSaveDialog(o);
    if (kind === "open") return win ? dialog.showOpenDialog(win, o) : dialog.showOpenDialog(o);
    return { canceled: true, filePaths: [] };
  });
  ipcMain.handle("cortex:reveal", (_e, p: unknown) => {
    if (typeof p === "string" && path.isAbsolute(p)) shell.showItemInFolder(p);
  });
  ipcMain.handle("cortex:open-external", (_e, url: unknown) => {
    if (typeof url === "string") openExternalSafe(url);
  });
  // The record's vault key sealed for this Windows account (safeStorage). Strings in, strings out; nothing is kept here.
  ipcMain.handle("cortex:os-key", (_e, op: unknown, data: unknown) => {
    try {
      if (op === "available") return !launch.shot && safeStorage.isEncryptionAvailable();
      if (launch.shot || !safeStorage.isEncryptionAvailable() || typeof data !== "string" || data.length > 4096) return null;
      if (op === "protect") return safeStorage.encryptString(data).toString("base64");
      if (op === "unprotect") return safeStorage.decryptString(Buffer.from(data, "base64"));
    } catch {
      // the system refused: the caller reads null as "not available"
    }
    return null;
  });
  ipcMain.handle("cortex:devtools", () => {
    getWindow()?.webContents.toggleDevTools();
  });
}

// ───────────────────────────── the menu bar ─────────────────────────────

/** Commands from the menu go to the page, which runs `cortex:<id>` (renderer.ts listens for "cortex:command"). */
function menuItems(nodes: readonly MenuNode[], getWindow: () => BrowserWindow | null): MenuItemConstructorOptions[] {
  return nodes.map((n): MenuItemConstructorOptions => {
    switch (n.kind) {
      case "separator":
        return { type: "separator" };
      case "submenu":
        return { label: n.label, submenu: menuItems(n.items, getWindow) };
      case "role":
        return { role: n.role, label: n.label, ...(n.accelerator ? { accelerator: n.accelerator } : {}) };
      case "command":
        return {
          label: n.label,
          ...(n.accelerator ? { accelerator: n.accelerator } : {}),
          click: () => {
            const win = getWindow();
            if (!win || win.isDestroyed()) return;
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
            win.webContents.send("cortex:command", n.id);
          },
        };
      case "action":
        return {
          label: n.label,
          ...(n.accelerator ? { accelerator: n.accelerator } : {}),
          click: () => {
            const win = getWindow();
            if (n.action === "quit") app.quit();
            else if (!win || win.isDestroyed()) return;
            else if (n.action === "full-screen") win.setFullScreen(!win.isFullScreen());
            else if (n.action === "reload") win.webContents.reload();
            else win.webContents.toggleDevTools();
          },
        };
    }
  });
}

/** The application menu (Windows: the bar under the title bar; Alt shows it while it is hidden). */
function buildAppMenu(getWindow: () => BrowserWindow | null): Menu {
  return Menu.buildFromTemplate(menuItems(desktopMenu(), getWindow));
}

// ───────────────────────────── the window ─────────────────────────────

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

function visible(b: Rectangle): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y < a.y + a.height - 40 && b.y + 20 > a.y;
  });
}

function savedState(): WindowState {
  const s = readJson<WindowState>(windowFile);
  const fallback: WindowState = { width: 1512, height: 982 };
  if (!s || !Number.isFinite(s.width) || !Number.isFinite(s.height)) return fallback;
  const st: WindowState = { width: Math.max(MIN_W, Math.round(s.width)), height: Math.max(MIN_H, Math.round(s.height)), maximized: s.maximized === true };
  if (Number.isFinite(s.x) && Number.isFinite(s.y) && visible({ x: s.x as number, y: s.y as number, width: st.width, height: st.height })) {
    st.x = Math.round(s.x as number);
    st.y = Math.round(s.y as number);
  }
  return st;
}

function rememberState(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = (): void => {
    if (win.isDestroyed()) return;
    const maximized = win.isMaximized();
    const b = maximized || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    writeJson(windowFile, { x: b.x, y: b.y, width: b.width, height: b.height, maximized });
  };
  const soon = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  win.on("resize", soon);
  win.on("move", soon);
  win.on("maximize", soon);
  win.on("unmaximize", soon);
  win.on("close", () => {
    if (timer) clearTimeout(timer);
    save();
  });
}

function createWindow(shot: ShotOptions | null): BrowserWindow {
  const state = shot ? null : savedState();
  const win = new BrowserWindow({
    width: shot ? shot.width : state!.width,
    height: shot ? shot.height : state!.height,
    ...(state && state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    useContentSize: shot !== null,
    ...(shot ? { frame: false, resizable: true, enableLargerThanScreen: true } : { minWidth: MIN_W, minHeight: MIN_H }),
    show: false,
    title: "Cortex",
    ...(existsSync(path.join(APP_DIR, "icon.ico")) ? { icon: path.join(APP_DIR, "icon.ico") } : {}),
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    paintWhenInitiallyHidden: true,
    ...(shot ? {} : { titleBarStyle: "hidden" as const, titleBarOverlay: { color: "#000000", symbolColor: "#c3c8d1", height: HEADER_H } }),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
      // Offscreen rendering has its own scale factor (force-device-scale-factor covers the hidden mode).
      ...(shot?.mode === "offscreen" ? { offscreen: { deviceScaleFactor: shot.dpr } } : {}),
    },
  });
  // Windows clamps a new window to the work area; a size set afterwards may be larger than the screen.
  if (shot) win.setContentSize(shot.width, shot.height);
  if (shot?.mode === "offscreen") win.webContents.setFrameRate(60);
  // The hidden title bar draws no menu bar: Alt on its own (or F10) and a right click on the title strip open the
  // same menu as a pop-up under the strip, as Windows' own menu bar does.
  let altAlone = false;
  const popUpMenu = (x: number, y: number): void => {
    if (!shot && !win.isDestroyed()) buildAppMenu(() => win).popup({ window: win, x, y });
  };
  if (!shot) {
    win.on("system-context-menu", (event, point) => {
      event.preventDefault();
      popUpMenu(Math.round(point.x), Math.round(point.y));
    });
  }
  win.webContents.on("before-input-event", (event, input) => {
    if (!shot) {
      if (input.key === "Alt") {
        if (input.type === "keyDown") altAlone = !input.isAutoRepeat;
        else if (input.type === "keyUp" && altAlone) {
          altAlone = false;
          popUpMenu(8, HEADER_H);
          event.preventDefault();
          return;
        }
      } else if (input.type === "keyDown") {
        altAlone = false;
      }
      if (input.type === "keyDown" && input.key === "F10" && !input.control && !input.shift && !input.alt) {
        popUpMenu(8, HEADER_H);
        event.preventDefault();
        return;
      }
    }
    if (input.type !== "keyDown") return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    if ((ctrl && input.shift && key === "i") || key === "f12") {
      win.webContents.toggleDevTools();
      event.preventDefault();
    } else if ((ctrl && key === "r" && !input.shift) || key === "f5") {
      win.webContents.reload();
      event.preventDefault();
    } else if (key === "f11" && !shot) {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });
  if (!shot) {
    rememberState(win);
    // "Keep running in the tray when closed" (Settings › Cortex Desktop): the close button hides the window instead.
    win.on("close", (e) => {
      if (hostShell?.hideInsteadOfQuit()) {
        e.preventDefault();
        win.hide();
      }
    });
    win.once("ready-to-show", () => {
      if (state?.maximized) win.maximize();
      win.show();
      if (launch.devtools) win.webContents.openDevTools({ mode: "detach" });
    });
  }
  void win.loadFile(path.join(APP_DIR, "index.html"));
  return win;
}

// ───────────────────────────── screenshot runs ─────────────────────────────

/** What renderer.ts's probe() reports. */
interface Probe {
  booted: boolean;
  phase: string | null;
  points: number;
  dataPoints: number;
  fps: number;
  error: string | null;
  visibility: string;
  vault: { files: number; notes: number; readMs: number } | null;
}

interface Capture {
  path: string;
  width: number;
  height: number;
  bytes: number;
  /** Share of pixels brighter than near-black (a black or empty frame is about 0). */
  lit: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function insideFolder(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function probe(win: BrowserWindow): Promise<Probe | null> {
  try {
    return (await win.webContents.executeJavaScript("window.cortexDesktop ? window.cortexDesktop.probe() : null", true)) as Probe | null;
  } catch {
    return null;
  }
}

async function waitReady(win: BrowserWindow, timeoutMs: number): Promise<Probe> {
  const deadline = Date.now() + timeoutMs;
  let last: Probe | null = null;
  for (;;) {
    last = (await probe(win)) ?? last;
    if (last?.error) throw new Error(`the app reported an error: ${last.error}`);
    if (last && (last.phase === "ready" || last.phase === "empty") && last.points > 0) return last;
    if (Date.now() > deadline) throw new Error(`not ready after ${timeoutMs} ms (phase ${last?.phase ?? "none"}, ${last?.points ?? 0} points)`);
    await sleep(250);
  }
}

function litShare(bitmap: Buffer): number {
  let lit = 0;
  const n = Math.floor(bitmap.length / 4);
  // BGRA; sample every 7th pixel (plenty for a share).
  let seen = 0;
  for (let i = 0; i < n; i += 7) {
    const o = i * 4;
    const y = 0.114 * (bitmap[o] as number) + 0.587 * (bitmap[o + 1] as number) + 0.299 * (bitmap[o + 2] as number);
    if (y > 24) lit++;
    seen++;
  }
  return seen > 0 ? lit / seen : 0;
}

async function capture(win: BrowserWindow, file: string): Promise<Capture> {
  if (launch.shot?.mode === "offscreen") win.webContents.invalidate();
  await sleep(50);
  const img = await win.webContents.capturePage(undefined, { stayHidden: true });
  if (img.isEmpty()) throw new Error("capturePage returned an empty image");
  const png = img.toPNG();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, png);
  const size = img.getSize();
  return { path: file, width: size.width, height: size.height, bytes: png.length, lit: Math.round(litShare(img.toBitmap()) * 1000) / 1000 };
}

async function click(win: BrowserWindow, selector: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const find = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`;
  for (;;) {
    const r = (await win.webContents.executeJavaScript(find, true)) as { x: number; y: number; w: number; h: number } | null;
    if (r && r.w > 0 && r.h > 0) {
      const x = Math.round(r.x);
      const y = Math.round(r.y);
      win.webContents.sendInputEvent({ type: "mouseMove", x, y });
      win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
      win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
      await sleep(150);
      return;
    }
    if (r) {
      await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`, true);
      await sleep(150);
      return;
    }
    if (Date.now() > deadline) throw new Error(`no element matches ${selector}`);
    await sleep(100);
  }
}

/** The steps file, with the status file of every agentsStatus step read and checked now (names are relative to the steps file). */
function loadSteps(file: string): ShotStep[] {
  const dir = path.dirname(path.resolve(file));
  return loadStatusFiles(parseStepsText(readFileSync(file, "utf8")), (name) => readFileSync(path.resolve(dir, name), "utf8"));
}

/**
 * Hand a stand-in agents status to the page, which checks it and applies it to the shared store as the runner's own
 * status (renderer.ts applyAgentsStatus); the queues it set come back for the report.
 */
async function applyAgentsStatus(win: BrowserWindow, status: AgentsStatusResult): Promise<unknown> {
  const r = (await win.webContents.executeJavaScript(`window.cortexDesktop.applyAgentsStatus(${JSON.stringify(status)})`, true)) as { ok?: boolean; error?: string; queues?: unknown } | null;
  if (!r?.ok) throw new Error(`the agents status was not applied: ${r?.error ?? "the page did not answer"}`);
  await sleep(150);
  return r.queues ?? null;
}

async function runShot(win: BrowserWindow, shot: ShotOptions): Promise<number> {
  const t0 = Date.now();
  const out = path.resolve(shot.out);
  const report: Record<string, unknown> = { ok: false, vault: currentVault, size: { width: shot.width, height: shot.height, dpr: shot.dpr }, mode: shot.mode, captures: [] as Capture[], steps: [] as unknown[], console: [] as string[] };
  const consoleLines = report.console as string[];
  win.webContents.on("console-message", (details) => {
    const level = (details as unknown as { level?: string }).level ?? "info";
    if ((level === "warning" || level === "error") && consoleLines.length < 200) consoleLines.push(`[${level}] ${String((details as unknown as { message?: string }).message ?? "").slice(0, 500)}`);
  });
  win.webContents.on("render-process-gone", (_e, d) => consoleLines.push(`[fatal] renderer gone: ${d.reason}`));
  let code = 1;
  try {
    mkdirSync(out, { recursive: true });
    if (insideFolder(out, currentVault)) throw new StepError("--out must be outside the vault");
    const status = shot.agentsStatus ? readAgentsStatus(shot.agentsStatus, (name) => readFileSync(path.resolve(name), "utf8"), "--agents-status") : null;
    const steps: ShotStep[] = shot.steps ? loadSteps(shot.steps) : [];
    const ready = await waitReady(win, shot.timeoutMs);
    report.ready = { ...ready, afterMs: Date.now() - t0 };
    if (status) report.agentsStatus = { file: shot.agentsStatus, queues: await applyAgentsStatus(win, status) };
    await sleep(shot.settleMs);
    let captured = false;
    for (const [i, step] of steps.entries()) {
      const entry: Record<string, unknown> = { step: i + 1, kind: step.kind };
      switch (step.kind) {
        case "wait":
          await sleep(step.ms);
          break;
        case "click":
          await click(win, step.selector, step.timeoutMs);
          break;
        case "eval":
          entry.result = JSON.stringify(await win.webContents.executeJavaScript(step.js, true))?.slice(0, 2000) ?? null;
          break;
        case "size":
          win.setContentSize(step.width, step.height);
          await sleep(500);
          break;
        case "agentsStatus":
          if (!step.status) throw new StepError(`step ${i + 1}: the agents status was not read`);
          if (step.file) entry.file = step.file;
          entry.result = await applyAgentsStatus(win, step.status);
          break;
        case "capture": {
          const file = path.isAbsolute(step.path) ? step.path : path.join(out, step.path);
          if (insideFolder(file, currentVault)) throw new StepError(`step ${i + 1}: captures never go into the vault`);
          (report.captures as Capture[]).push(await capture(win, file));
          captured = true;
          break;
        }
      }
      (report.steps as unknown[]).push(entry);
    }
    if (!captured) (report.captures as Capture[]).push(await capture(win, path.join(out, "cortex.png")));
    const final = await probe(win);
    report.final = final;
    report.ok = true;
    code = 0;
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    code = 1;
  }
  report.elapsedMs = Date.now() - t0;
  try {
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, "shot-report.json"), JSON.stringify(report, null, 2));
  } catch {
    // the report also goes to stdout
  }
  process.stdout.write(`${JSON.stringify({ ok: report.ok, error: report.error ?? null, captures: report.captures, ready: report.ready ?? null, final: report.final ?? null, elapsedMs: report.elapsedMs })}\n`);
  return code;
}

// ───────────────────────────── start ─────────────────────────────

let mainWindow: BrowserWindow | null = null;
/** The tray icon and the quick window (hostShell.ts); built once the app is ready. */
let hostShell: HostShell | null = null;

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on("before-quit", () => {
  hostShell?.markQuitting();
});

app.on("will-quit", () => {
  hostShell?.dispose();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("quit", () => {
  if (ownProfile) {
    try {
      rmSync(ownProfile, { recursive: true, force: true });
    } catch {
      // Chromium may still hold a file; the OS cleans the temp folder
    }
  }
});

void app.whenReady().then(async () => {
  if (!primary) return;
  // Screenshot runs have no menu; the app has one (Windows shows it under the title bar, Alt toggles it while hidden).
  Menu.setApplicationMenu(launch.shot ? null : buildAppMenu(() => mainWindow));
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "clipboard-sanitized-write"));
  registerIpc(() => mainWindow);
  hostShell = new HostShell({ appDir: APP_DIR, getWindow: () => mainWindow, shotOut: launch.shot ? path.resolve(launch.shot.out) : null, dpr: launch.shot?.dpr ?? 1 });
  hostShell.registerIpc();
  if (!isVault(currentVault)) {
    if (launch.shot) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: `not an Obsidian vault: ${currentVault}` })}\n`);
      app.exit(1);
      return;
    }
    const r = await dialog.showMessageBox({ type: "warning", title: "Cortex", message: `This folder is not an Obsidian vault:\n${currentVault}`, buttons: ["Choose folder…", "Quit"], defaultId: 0, cancelId: 1 });
    if (r.response !== 0) {
      app.quit();
      return;
    }
    const pick = await dialog.showOpenDialog({ title: "Choose your Obsidian vault folder", properties: ["openDirectory"] });
    const chosen = pick.canceled ? null : (pick.filePaths[0] ?? null);
    if (!chosen || !isVault(chosen)) {
      app.quit();
      return;
    }
    currentVault = path.resolve(chosen);
    writeJson(prefsFile, { ...(readJson<DesktopPrefs>(prefsFile) ?? {}), vault: currentVault });
  }
  if (!existsSync(path.join(APP_DIR, "renderer.js"))) {
    dialog.showErrorBox("Cortex", "The desktop bundle is missing. Run `npm run desktop:build`.");
    app.exit(1);
    return;
  }
  mainWindow = createWindow(launch.shot);
  if (launch.shot) {
    const shot = launch.shot;
    mainWindow.webContents.once("did-finish-load", () => {
      void runShot(mainWindow as BrowserWindow, shot).then((code) => {
        app.exit(code);
      });
    });
    mainWindow.webContents.once("did-fail-load", (_e, _code, desc) => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: `page failed to load: ${desc}` })}\n`);
      app.exit(1);
    });
  }
});
