/**
 * The renderer's side of the tray icon and the quick window (the Electron side is hostShell.ts). Once Cortex has
 * started it
 *   - works out the status lines (trayMenu.buildTrayStatus) from the services and sends them, with the launcher
 *     settings, to the main process as "cortex:host-state" (debounced, and only when something changed);
 *   - answers what a click in the tray asks ("cortex:tray-action": live capture on or off);
 *   - runs the quick window's Enter ("cortex:launcher-query") in the command line: Enter searches the record, and
 *     Ctrl+Enter puts the text in Ask without sending it (this path never calls a model);
 *   - tells the person when another program already holds the shortcut.
 * It also draws the "Tray and quick window" rows of Cortex Desktop's settings tab. Nothing here is sent anywhere
 * but to the main process of this same app.
 */
import { ipcRenderer } from "electron";
import type { App as ObsidianApp } from "obsidian";
import { mostRecentCortexLeaf, revealCortexLeaf, waitForLeafStore } from "../plugin/obsidianBridge";
import type { CortexServices, SourceRow } from "../plugin/services";
import { CAPTURE_CONSENT_VERSION } from "../shared/settingsExt";
import { lastUpdateVerdict, onVerdict } from "../shared/update";
import { appLocked } from "../state/lock";
import type { CortexStore } from "../state/store";
import { t } from "../ui/copy";
import { scopeLabel } from "../ui/header/ScopePicker";
import { displayShortcut, normaliseShortcut, parseLauncherSubmit, type LauncherSubmit } from "./launcherCore";
import { Setting } from "./obsidian/setting";
import { buildTrayStatus, type HostState } from "./trayMenu";

export interface HostLinkDeps {
  app: unknown;
  services: CortexServices;
  notice(text: string): void;
  runCommand(id: string): void;
  /** The installed version (the manifest's); the tray's foot line shows it. */
  version?: string;
}

type LeafStoreOwner = { leafStore?(): CortexStore | null };

/** The command line of the most recent Cortex view, once it has mounted. */
function currentStore(app: unknown): CortexStore | null {
  try {
    const leaf = mostRecentCortexLeaf(app as ObsidianApp);
    return (leaf?.view as unknown as LeafStoreOwner | undefined)?.leafStore?.() ?? null;
  } catch {
    return null;
  }
}

/** Pure enough to test: the message for the main process from the services' current values. */
export function hostStateOf(s: CortexServices, rows: readonly SourceRow[], store: CortexStore | null, now: number, extra: { lastAnchoredAt?: number | null; version?: string } = {}): HostState {
  const settings = s.settings.value;
  const locked = appLocked.value;
  const queues = s.shared.slices.queues.value;
  const activity = s.shared.slices.activity.value;
  const l = settings.launcher;
  return {
    status: buildTrayStatus({
      locked,
      liveOn: settings.captureWeb.enabled,
      rows,
      bySource: queues.bySource,
      waiting: queues.label,
      tokensToday: activity.tokensToday,
      usdToday: activity.usdToday,
      showTodayCost: l.showTodayCost,
      cadenceOverrides: settings.record.exportEveryBySource,
      now,
      space: locked ? "" : scopeLabel(store?.get("ui").scope ?? "all"),
      lastAnchoredAt: extra.lastAnchoredAt ?? null,
      ...(extra.version ? { version: extra.version, verdict: lastUpdateVerdict() } : {}),
      engine: activity.engine,
      capPct: lowestCap(settings.agents.planCaps),
    }),
    prefs: { tray: l.tray, keepRunning: l.keepRunning, quickWindow: l.quickWindow, quickShortcut: l.quickShortcut },
  };
}

/** The lowest share an agent stops at, across the plan's two windows; null when neither has a cap on. */
export function lowestCap(caps: { fiveHour: { on: boolean; pct: number }; weekly: { on: boolean; pct: number } }): number | null {
  const on = [caps.fiveHour, caps.weekly].filter((c) => c.on && Number.isFinite(c.pct)).map((c) => c.pct);
  return on.length > 0 ? Math.min(...on) : null;
}

/** When the seal chain was last stamped in public (epoch ms), from the runner; null when there is none or it cannot say. */
async function readAnchoredAt(s: CortexServices): Promise<number | null> {
  if (s.sandbox.value) return null;
  try {
    const st = await s.runner.request({ cmd: "seals.status", args: {} });
    const at = st.published ? Date.parse(st.published.at) : Number.NaN;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** Put a quick-window query into the command line of the main view. */
async function runQuery(app: unknown, q: LauncherSubmit): Promise<void> {
  const view = await revealCortexLeaf(app as ObsidianApp, {});
  const store = view ? await waitForLeafStore(view, 15_000) : null;
  if (!store) return;
  store.update("ui", (ui) => ({ ...ui, command: { ...ui.command, mode: q.mode, text: q.text, resultsOpen: q.mode === "find", consoleOpen: q.mode === "ask" } }));
  const root = view?.contentEl as (HTMLElement & { querySelector?(s: string): Element | null }) | undefined;
  const focus = (): boolean => {
    const input = root?.querySelector?.('[role="search"] [role="combobox"], [role="combobox"]') as HTMLElement | null | undefined;
    input?.focus?.();
    return Boolean(input);
  };
  if (!focus()) setTimeout(focus, 80);
}

/** Start sending the state and answering the tray and the quick window. Returns a function that stops it. */
export function startHostLink(d: HostLinkDeps): () => void {
  let rows: SourceRow[] = [];
  let sent = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let boundStore: CortexStore | null = null;
  let unbindStore: (() => void) | null = null;
  let tick = 0;
  let anchoredAt: number | null = null;

  const push = (): void => {
    timer = null;
    const json = JSON.stringify(hostStateOf(d.services, rows, boundStore ?? currentStore(d.app), Date.now(), { lastAnchoredAt: anchoredAt, ...(d.version ? { version: d.version } : {}) }));
    if (json === sent) return;
    sent = json;
    ipcRenderer.send("cortex:host-state", JSON.parse(json) as HostState);
  };
  const soon = (): void => {
    if (timer === null) timer = setTimeout(push, 300);
  };
  const refreshRows = async (): Promise<void> => {
    try {
      rows = await d.services.sources.list();
    } catch {
      // keep the last rows
    }
    anchoredAt = await readAnchoredAt(d.services);
    soon();
  };
  const bindStore = (): void => {
    const store = currentStore(d.app);
    if (!store || store === boundStore) return;
    boundStore = store;
    unbindStore?.();
    let scope: string | null = null;
    unbindStore = store.slices.ui.subscribe((ui) => {
      if (ui.scope !== scope) {
        scope = ui.scope;
        soon();
      }
    });
  };

  const stops = [d.services.settings.signal, d.services.shared.slices.queues, d.services.shared.slices.activity, appLocked].map((sig) => sig.subscribe(soon));
  stops.push(onVerdict(soon));

  const onAction = (_e: unknown, a: unknown): void => {
    if (a === "toggle-live") void toggleLive(d);
  };
  const onQuery = (_e: unknown, raw: unknown): void => {
    const q = parseLauncherSubmit(raw);
    if (q) void runQuery(d.app, q);
  };
  const onShortcut = (_e: unknown, what: unknown): void => {
    if (what === "taken") d.notice(t("hostSettings.shortcutTaken"));
  };
  ipcRenderer.on("cortex:tray-action", onAction);
  ipcRenderer.on("cortex:launcher-query", onQuery);
  ipcRenderer.on("cortex:launcher-shortcut", onShortcut);

  bindStore();
  void refreshRows();
  // The sources list changes slowly (an import finishing); the area name needs the view to exist first.
  const every = setInterval(() => {
    bindStore();
    if (++tick % 12 === 0) void refreshRows();
  }, 5000);

  return () => {
    clearInterval(every);
    if (timer !== null) clearTimeout(timer);
    for (const stop of stops) stop();
    unbindStore?.();
    ipcRenderer.removeListener("cortex:tray-action", onAction);
    ipcRenderer.removeListener("cortex:launcher-query", onQuery);
    ipcRenderer.removeListener("cortex:launcher-shortcut", onShortcut);
  };
}

/** Live capture from the tray: off needs nothing; on needs the consent given in Settings (opened if it is missing). */
async function toggleLive(d: HostLinkDeps): Promise<void> {
  const c = d.services.settings.value.captureWeb;
  if (!c.enabled && c.consentVersion < CAPTURE_CONSENT_VERSION) {
    d.notice(t("tray.liveNeedsConsent"));
    d.runCommand("open-settings");
    return;
  }
  await d.services.settings.update((s) => {
    s.captureWeb.enabled = !c.enabled;
  });
}

/** The "Tray and quick window" rows of Cortex Desktop's settings tab. */
export function hostSettingsSection(container: HTMLElement, s: CortexServices, notice: (text: string) => void): void {
  const set = (fn: (l: CortexServices["settings"]["value"]["launcher"]) => void): void => {
    void s.settings.update((all) => fn(all.launcher));
  };
  const l = s.settings.value.launcher;
  new Setting(container).setName(t("hostSettings.heading")).setHeading();
  new Setting(container)
    .setName(t("hostSettings.tray"))
    .setDesc(t("hostSettings.trayDesc"))
    .addToggle((c) => c.setValue(l.tray).onChange((v) => set((x) => void (x.tray = v))));
  new Setting(container)
    .setName(t("hostSettings.keepRunning"))
    .setDesc(t("hostSettings.keepRunningDesc"))
    .addToggle((c) => c.setValue(l.keepRunning).onChange((v) => set((x) => void (x.keepRunning = v))));
  new Setting(container)
    .setName(t("hostSettings.quickWindow"))
    .setDesc(t("hostSettings.quickWindowDesc"))
    .addToggle((c) => c.setValue(l.quickWindow).onChange((v) => set((x) => void (x.quickWindow = v))));
  new Setting(container)
    .setName(t("hostSettings.quickShortcut"))
    .setDesc(t("hostSettings.quickShortcutDesc"))
    .addText((c) => {
      c.setValue(displayShortcut(l.quickShortcut));
      // Checked when the field is left or Enter is pressed, not on every key (a half-typed shortcut is not an error).
      c.inputEl.addEventListener("change", () => {
        const a = normaliseShortcut(c.getValue());
        if (a === null) {
          notice(t("hostSettings.shortcutBad"));
          c.setValue(displayShortcut(s.settings.value.launcher.quickShortcut));
          return;
        }
        c.setValue(displayShortcut(a));
        set((x) => void (x.quickShortcut = a));
      });
    });
  new Setting(container)
    .setName(t("hostSettings.todayCost"))
    .setDesc(t("hostSettings.todayCostDesc"))
    .addToggle((c) => c.setValue(l.showTodayCost).onChange((v) => set((x) => void (x.showTodayCost = v))));
}
