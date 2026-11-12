/**
 * Cortex Desktop, renderer entry. Boots the unchanged Cortex plugin (src/main.ts) on the "obsidian" shim:
 *   1. Obsidian's DOM helpers, then the vault: every visible file listed, every note parsed (App.open);
 *   2. the plugin class constructed with the shim App and a manifest whose folder is mounted on
 *      %APPDATA%\Cortex\vaults\<vaultKey> (data.json starts as a copy of the vault's own, which is never written);
 *   3. onload, layout ready, then the Cortex view opened full-window (the last view state is restored).
 * Same cache folder (%LOCALAPPDATA%\cortex\<vaultKey>), runner, ledgers and settings schema as the plugin, so the
 * user's imports show up. Overrides two host hooks of the plugin class: the runner comes from this bundle's folder
 * (same build id as this UI), and view-only runs (--no-background, the screenshot harness) start no background work.
 * `window.cortexDesktop.probe()` reports readiness to the harness.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as nodePath from "node:path";
import { ipcRenderer, shell } from "electron";
import type { App as ObsidianApp, PluginManifest as ObsidianManifest } from "obsidian";
import type { CortexServices } from "../plugin/services";
import CortexPlugin from "../main";
import { bucketCss } from "../shared/palette";
import { hasPassphrase } from "../shared/lock";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { appLocked, lockApp } from "../state/lock";
import { t } from "../ui/copy";
import { HINT_IDS } from "../ui/deviceState";
import { CORTEX_GLYPH_PATHS } from "../ui/icons";
import { splashAutoIn, splashGate, splashLine } from "../ui/loading";
import type { DesktopConfig } from "./config";
import { hostSettingsSection, startHostLink } from "./hostLink";
import { motionHostDefault } from "./motionDefault";
import { installOsKeyBridge } from "./osKey";
import { App } from "./obsidian/app";
import { installDomHelpers } from "./obsidian/dom";
import { Notice } from "./obsidian/ui";
import { Setting } from "./obsidian/setting";

const PLUGIN_DIR = ".obsidian/plugins/cortex";
const VIEW_TYPE = "cortex-view";

interface DesktopState {
  booted: boolean;
  error: string | null;
  app: App | null;
  plugin: CortexPlugin | null;
  services: CortexServices | null;
}

const state: DesktopState = { booted: false, error: null, app: null, plugin: null, services: null };

/** `require("electron").remote` for Cortex's Save and Open dialogs (removed from Electron; served over IPC here). */
function installRemoteDialogs(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require("electron") as Record<string, unknown>;
  if (electron.remote) return;
  const remote = {
    dialog: {
      showSaveDialog: (_win: unknown, opts?: unknown) => ipcRenderer.invoke("cortex:dialog", "save", opts ?? _win),
      showOpenDialog: (winOrOpts: unknown, opts?: unknown) => ipcRenderer.invoke("cortex:dialog", "open", opts ?? winOrOpts),
    },
    getCurrentWindow: () => null,
    app: { getPath: (name: string) => ipcRenderer.sendSync("cortex:get-path", name) as string | null },
  };
  try {
    Object.defineProperty(electron, "remote", { value: remote, configurable: true });
  } catch {
    // a frozen module: Save image falls back to Downloads, Add sources to a typed path
  }
}

/**
 * Screenshot runs: the page always counts as visible. The window is never shown, and Cortex pauses a hidden view
 * (the renderer pool releases it after 60 s), so visibility changes are swallowed before Cortex hears them.
 */
function keepVisible(): void {
  Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
  Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
  document.addEventListener("visibilitychange", (e) => e.stopImmediatePropagation(), true);
  window.addEventListener("visibilitychange", (e) => e.stopImmediatePropagation(), true);
}

/** Screenshot runs: count as in use, so an idle auto-lock (Settings › Privacy › Lock) never blanks a long run. */
function keepActive(): void {
  window.setInterval(() => document.dispatchEvent(new Event("pointermove")), 20_000);
}

function openExternal(url: string): void {
  if (/^(https?:|mailto:|obsidian:)/i.test(url)) void shell.openExternal(url);
}

/** First run of this vault in the desktop: its settings start as a copy of the plugin's (the vault's file is only read). */
function adoptSettings(cfg: DesktopConfig): void {
  if (cfg.viewOnly) return; // view-only runs read through the mount and keep changes in memory
  const own = nodePath.join(cfg.dataDir, "data.json");
  const seed = nodePath.join(cfg.seedDir, "data.json");
  if (existsSync(own) || !existsSync(seed)) return;
  try {
    mkdirSync(cfg.dataDir, { recursive: true });
    copyFileSync(seed, own);
  } catch (e) {
    console.warn("[cortex-desktop] could not copy the plugin's settings; reading them in place", e);
  }
}

/** The desktop's motion default: see DesktopCortexPlugin.loadData. */
function applyMotionHostDefault<T extends { appearance?: { motion?: unknown } }>(cfg: DesktopConfig, raw: T): T {
  const marker = nodePath.join(cfg.dataDir, "motion-default.json");
  const r = motionHostDefault(raw, !cfg.shot && existsSync(marker));
  if (r.changed && !cfg.shot && !cfg.viewOnly) {
    try {
      mkdirSync(cfg.dataDir, { recursive: true });
      writeFileSync(marker, JSON.stringify({ v: 1, motion: "full" }));
      writeFileSync(nodePath.join(cfg.dataDir, "data.json"), JSON.stringify(r.settings, null, 2));
    } catch (e) {
      console.warn("[cortex-desktop] could not store the motion default", e);
    }
  }
  return r.settings;
}

/** Screenshot runs: a returning device (no tour offer, no one-time hints), or a fresh one. */
function seedDevice(app: App, cfg: DesktopConfig): void {
  if (cfg.device !== "returning") return;
  app.saveLocalStorage("cortex:hints", { v: 1, hintsSeen: [...HINT_IDS], checklist: { "add-source": true, "open-frond": true, "ask-question": true }, checklistHidden: true, tourSeen: true });
}

function layoutFile(cfg: DesktopConfig): string {
  return nodePath.join(cfg.dataDir, "workspace.json");
}

function savedLayout(cfg: DesktopConfig): { type: string; state?: Record<string, unknown> } | null {
  if (cfg.shot) return null;
  try {
    const v = JSON.parse(readFileSync(layoutFile(cfg), "utf8")) as { main?: { type?: unknown; state?: unknown } };
    if (v.main && v.main.type === VIEW_TYPE) return { type: VIEW_TYPE, ...(v.main.state && typeof v.main.state === "object" ? { state: v.main.state as Record<string, unknown> } : {}) };
  } catch {
    // no saved layout yet
  }
  return null;
}

/** How long the splash card takes to fade out (ms); the stage's first paint starts under it. */
const SPLASH_LEAVE_MS = 260;

/** The Cortex mark and wordmark above an Open button and the progress line, centred on black (the cold-open card). */
function splash(host: HTMLElement, held: boolean): { set(text: string): void; gate(): Promise<void>; leave(): void; done(): void } {
  const el = document.createElement("div");
  el.className = "cxd-splash";
  const card = document.createElement("div");
  card.className = "cxd-splash-card";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "cxd-splash-mark");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of [CORTEX_GLYPH_PATHS.outer, CORTEX_GLYPH_PATHS.inner]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  const seed = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  seed.setAttribute("cx", String(CORTEX_GLYPH_PATHS.seed.cx));
  seed.setAttribute("cy", String(CORTEX_GLYPH_PATHS.seed.cy));
  seed.setAttribute("r", String(CORTEX_GLYPH_PATHS.seed.r));
  seed.setAttribute("class", "cxd-splash-seed");
  svg.appendChild(seed);
  const word = document.createElement("div");
  word.className = "cxd-splash-word";
  word.textContent = t("rail.wordmark");
  const open = document.createElement("button");
  open.type = "button";
  open.className = "cxd-splash-open";
  open.textContent = t("splash.open");
  const stops = [1, 2, 3, 4, 5, 6].map((slot) => bucketCss("value", slot, DEFAULT_SETTINGS.appearance.palette, "glow"));
  open.style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
  const line = document.createElement("div");
  line.className = "cxd-splash-line";
  card.append(svg, word, open, line);
  el.appendChild(card);
  host.appendChild(el);
  open.focus();
  const shownAt = performance.now();
  let opened = false;
  let wake: (() => void) | null = null;
  open.addEventListener("click", () => {
    opened = true;
    open.disabled = true;
    wake?.();
  });
  return {
    set: (text) => {
      line.textContent = text;
    },
    // Resolves once the view may open: the click, or (with no lock or privacy blank on) the card's own 1.2 s.
    gate: () =>
      new Promise<void>((resolve) => {
        const check = (): void => {
          const input = { shownMs: performance.now() - shownAt, ready: true, held, opened };
          if (splashGate(input) === "go") return resolve();
          const wait = splashAutoIn(input);
          if (wait === null) wake = check;
          else setTimeout(check, wait + 4);
        };
        check();
      }),
    leave: () => {
      el.classList.add("is-leaving");
      setTimeout(() => el.remove(), SPLASH_LEAVE_MS + 60);
    },
    done: () => el.remove(),
  };
}

/** A privacy blank is on, or a lock is set: the splash waits for its Open button. */
function lockHeld(cfg: DesktopConfig): boolean {
  return !cfg.shot && appLocked.value;
}

/** A passphrase is set in this vault's Cortex settings (read from the desktop's own data.json, else the plugin's copy). */
function passphraseSet(cfg: DesktopConfig): boolean {
  if (cfg.shot) return false;
  for (const file of [nodePath.join(cfg.dataDir, "data.json"), nodePath.join(cfg.seedDir, "data.json")]) {
    try {
      const v = JSON.parse(readFileSync(file, "utf8")) as { privacy?: { lock?: { salt?: unknown; hash?: unknown } } };
      const lock = v.privacy?.lock;
      return typeof lock?.salt === "string" && typeof lock.hash === "string" && hasPassphrase({ salt: lock.salt, hash: lock.hash });
    } catch {
      // try the next file
    }
  }
  return false;
}

/** The desktop's own tab on the Settings page: the vault folder and where settings live. */
function desktopTab(cfg: DesktopConfig, services: () => CortexServices | null): { id: string; name: string; containerEl: HTMLElement; display(): void; hide(): void } {
  const containerEl = document.createElement("div");
  containerEl.className = "vertical-tab-content";
  const display = (): void => {
    containerEl.replaceChildren();
    const head = containerEl.createDiv({ cls: "cx-settings-header" });
    head.createSpan({ cls: "cx-settings-title", text: "Cortex Desktop" });
    head.createSpan({ cls: "cx-settings-version", text: `Electron ${cfg.versions.electron}` });
    new Setting(containerEl)
      .setName("Vault folder")
      .setDesc(cfg.vaultRoot)
      .addButton((b) =>
        b.setButtonText("Choose folder…").onClick(async () => {
          const r = (await ipcRenderer.invoke("cortex:choose-vault")) as { status: string; path?: string };
          if (r.status === "ok") {
            new Notice(`Opening ${r.path ?? "the vault"}…`);
            await ipcRenderer.invoke("cortex:reload");
          } else if (r.status === "not-a-vault") new Notice("That folder is not an Obsidian vault (it has no .obsidian folder).");
        }),
      );
    new Setting(containerEl)
      .setName("Settings file")
      .setDesc(cfg.viewOnly ? `${nodePath.join(cfg.dataDir, "data.json")} (view only: changes are not saved)` : nodePath.join(cfg.dataDir, "data.json"))
      .addButton((b) => b.setButtonText("Show in folder").onClick(() => void ipcRenderer.invoke("cortex:reveal", nodePath.join(cfg.dataDir, "data.json"))));
    new Setting(containerEl)
      .setName("Background work")
      .setDesc(cfg.viewOnly ? "Off in this window (view only): nothing is imported and no agent runs." : "As in Obsidian: imports and agents run in the background once the first-run step is done.");
    new Setting(containerEl).setName("Developer tools").addButton((b) => b.setButtonText("Open").onClick(() => void ipcRenderer.invoke("cortex:devtools")));
    const svc = services();
    if (svc) hostSettingsSection(containerEl, svc, (text) => new Notice(text));
  };
  return { id: "cortex-desktop", name: "Cortex Desktop", containerEl, display, hide: () => containerEl.replaceChildren() };
}

async function boot(): Promise<void> {
  installDomHelpers();
  installRemoteDialogs();
  const cfg = ipcRenderer.sendSync("cortex:config") as DesktopConfig;
  if (cfg.shot) {
    keepVisible();
    keepActive();
  }
  document.title = `Cortex · ${cfg.vaultName}`;
  document.body.classList.add("theme-dark", "cxd-app", cfg.shot ? "cxd-shot" : "cxd-window");
  const hostEl = document.querySelector<HTMLElement>(".cxd-host") ?? document.body;
  const layerEl = document.querySelector<HTMLElement>(".cxd-layer") ?? document.body;
  const s = splash(hostEl, lockHeld(cfg));
  s.set(splashLine(cfg.vaultName));
  adoptSettings(cfg);
  const app = await App.open({
    vaultRoot: cfg.vaultRoot,
    storageKey: `cortex-desktop-${cfg.vaultKey}`,
    mount: { vaultDir: PLUGIN_DIR, localDir: cfg.dataDir, seedDir: cfg.seedDir, readOnly: cfg.viewOnly },
    hostEl,
    layerEl,
    watch: !cfg.shot,
    openExternal,
    workspaceHost: {
      openInObsidian: (p) => openExternal(`obsidian://open?path=${encodeURIComponent(nodePath.join(cfg.vaultRoot, ...p.split("/")))}`),
      saveLayout: (layout) => {
        if (cfg.shot) return;
        try {
          mkdirSync(cfg.dataDir, { recursive: true });
          writeFileSync(layoutFile(cfg), JSON.stringify(layout));
        } catch (e) {
          console.warn("[cortex-desktop] could not save the layout", e);
        }
      },
    },
    onProgress: (phase, done, total) => s.set(phase === "notes" ? splashLine(cfg.vaultName, { done, total }) : splashLine(cfg.vaultName)),
  });
  state.app = app;
  console.info(`[cortex-desktop] ${cfg.vaultRoot}: ${app.loadStats?.files} files, ${app.loadStats?.markdown} notes read in ${app.loadStats?.ms} ms${cfg.viewOnly ? " (view only)" : ""}`);
  if (cfg.shot) seedDevice(app, cfg);
  app.setting.addTab(desktopTab(cfg, () => state.services));

  class DesktopCortexPlugin extends CortexPlugin {
    /**
     * Cortex Desktop plays every animation by default (the plugin keeps Follow system, because Obsidian's own
     * settings decide there). The first time a vault's settings are read here a stored "Follow system" that was never
     * chosen on purpose becomes "Full", once (a marker file remembers it); Follow system stays selectable afterwards.
     */
    override async loadData(): Promise<unknown> {
      const raw = (await super.loadData()) as { appearance?: { motion?: unknown } } | null;
      if (!raw || typeof raw !== "object") return raw;
      return applyMotionHostDefault(cfg, raw);
    }
    protected override pluginFolder(): string {
      return cfg.appDir;
    }
    protected override backgroundAllowed(): boolean {
      return !cfg.viewOnly;
    }
  }
  const manifest = { ...(cfg.manifest as unknown as ObsidianManifest), dir: PLUGIN_DIR };
  if (!cfg.shot) installOsKeyBridge(); // "This Windows account": the record key sealed with safeStorage (osKey.ts)
  const plugin = new DesktopCortexPlugin(app as unknown as ObsidianApp, manifest);
  state.plugin = plugin;
  app.plugins.plugins[manifest.id] = plugin;
  app.plugins.enabledPlugins.add(manifest.id);
  // Obsidian awaits a plugin's onload before the layout is ready.
  const component = plugin as unknown as { load(): void; unload(): void; whenLoaded(): Promise<void> };
  component.load();
  await component.whenLoaded();
  // The card holds for its Open button (or 1.2 s with nothing to unlock), then fades while the stage's first paint starts under it.
  s.set(lockHeld(cfg) ? t("splash.waiting") : splashLine(cfg.vaultName));
  await s.gate();
  // A passphrase means the window opens locked: the unlock card (the same look) takes the splash's place.
  if (passphraseSet(cfg)) lockApp();
  s.leave();
  app.workspace.setLayoutReady();
  const saved = savedLayout(cfg);
  if (saved) await app.workspace.getLeaf().setViewState({ ...saved, active: true });
  state.services = (await plugin.activateView()) ?? null;
  state.booted = true;
  // The menu bar (main.ts) sends the id of a Cortex command; it runs exactly like the palette's.
  ipcRenderer.on("cortex:command", (_e, id: unknown) => {
    if (typeof id === "string" && /^[a-z][a-z-]*$/.test(id)) app.commands.executeCommandById(`${manifest.id}:${id}`);
  });
  // The tray icon's and the quick window's status and answers (hostLink.ts); screenshot runs have neither.
  const stopHostLink = state.services && !cfg.shot ? startHostLink({ app, services: state.services, notice: (text) => void new Notice(text), runCommand: (id) => void app.commands.executeCommandById(`${manifest.id}:${id}`), version: manifest.version }) : null;
  window.addEventListener("beforeunload", () => {
    try {
      stopHostLink?.();
      app.workspace.flushLayout();
      component.unload();
    } finally {
      app.close();
    }
  });
}

interface ProbeResult {
  booted: boolean;
  phase: string | null;
  /** Everything the renderer draws (record and notes plus the haze), from renderer.stats(). */
  points: number;
  /** The record's and the notes' points only. */
  dataPoints: number;
  fps: number;
  error: string | null;
  visibility: string;
  vault: { files: number; notes: number; readMs: number } | null;
}

/** Readiness for the screenshot harness: the index phase and the points the renderer draws. */
function probe(): ProbeResult {
  let points = 0;
  let dataPoints = 0;
  let fps = 0;
  let phase: string | null = null;
  try {
    const canvas = document.querySelector("canvas.cx-canvas") as (HTMLCanvasElement & { cortexController?: { renderer?: { stats?(): { points: number; fps: number }; count?: number } | null } }) | null;
    const r = canvas?.cortexController?.renderer;
    const st = r?.stats?.();
    points = st?.points ?? 0;
    fps = Math.round((st?.fps ?? 0) * 10) / 10;
    dataPoints = typeof r?.count === "number" ? r.count : 0;
    phase = state.services?.shared.get("data").phase ?? null;
  } catch {
    // keep zeros
  }
  const ls = state.app?.loadStats;
  return { booted: state.booted, phase, points, dataPoints, fps, error: state.error, visibility: document.visibilityState, vault: ls ? { files: ls.files, notes: ls.markdown, readMs: ls.ms } : null };
}

(window as unknown as { cortexDesktop: unknown }).cortexDesktop = {
  probe,
  /** Screenshot runs: draw the cold-open card again (and dismiss it with the returned function). */
  previewSplash(line = "Reading the vault…"): () => void {
    const card = splash(document.querySelector<HTMLElement>(".cxd-host") ?? document.body, false);
    card.set(line);
    return card.done;
  },
  /** Screenshot runs: draw the quick window offscreen and save its picture into the run's folder. */
  shotLauncher(name: string, space = "All areas"): Promise<unknown> {
    return ipcRenderer.invoke("cortex:launcher-shot", name, space);
  },
  get app() {
    return state.app;
  },
  get plugin() {
    return state.plugin;
  },
};

void boot().catch((e: unknown) => {
  state.error = e instanceof Error ? `${e.message}` : String(e);
  console.error("[cortex-desktop] could not start", e);
  const host = document.querySelector<HTMLElement>(".cxd-host") ?? document.body;
  const box = document.createElement("div");
  box.className = "cxd-fatal";
  box.textContent = `Cortex Desktop could not start: ${state.error}`;
  host.appendChild(box);
});
