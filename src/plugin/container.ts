/**
 * Builds the service containers lazily. Owner: E1. Nothing here runs during plugin load.
 *  - createBackground(): the headless tier (settings, runner client, agents clock, status bar, notices, ledger
 *    reader, shared store, event bus). No Preact, no three.js, no worker, and no disk access when it is built.
 *    Its wiring folds runner events into the shared store (engine, budget, jobs, warnings), raises the throttled
 *    background notices, keeps control.json in step with Pause and the privacy settings, and refreshes the
 *    agents status after work finished, at local midnight and every 10 minutes.
 *  - startBackground(): only after the first-run step and with readable settings (SAFE-11, SAFE-08): reconciles
 *    control.json, starts the runner, seeds the status and starts the AgentsClock (startup import, transcript
 *    watching, idle and nightly agents).
 *  - createServices(bg): the UI tier for views, REUSING the background instances; per-leaf stores (H6).
 *  - disposeBackground / disposeServices: onunload; the clock stops BEFORE the runner (its fs.watch handles
 *    close first), then every subscription, watcher and timer is released.
 * The cache folder is always %LOCALAPPDATA%/cortex/<vaultKey> (SAFE-02: never a setting).
 */
import type { App } from "obsidian";
import { apiVersion, FileSystemAdapter } from "obsidian";
import { effect, signal, type Signal } from "@preact/signals-core";
import { CortexError, errorMessage } from "../shared/errors";
import { featureOn } from "../shared/features";
import { vaultKey as computeVaultKey } from "../shared/ids";
import { createVaultPathResolver } from "../store/vaultPaths";
import { consoleSink, createLogger, createRingSink, teeSink, type LogEntry, type Logger, type LogSink } from "../shared/log";
import type { FromRunner, ImportResult, IndexBuildResult, PendingGroup, RunnerEvent, SourceSelector } from "../shared/protocol/runner";
import type { CortexSettings } from "../shared/settings";
import { EventBus } from "../state/events";
import { createLeafStore, createSharedStore, type SharedStore } from "../state/store";
import { defaultView, type ActivityJob, type ActivityState } from "../state/types";
import { errCode } from "../node/fsAtomic";
import { createRecordKeyAccess } from "../node/vaultKeyStore";
import { recordKeyState, subscribeKeyring } from "../shared/crypto/keyring";
import { desktopOsKey } from "./recordKeys";
import * as path from "node:path";
import { claudeProjectsDir, codexHomeDir, cursorUserDir, defaultCacheDir, geminiCliHomeDir, watchTree } from "../node/platform";
import { openStoreContext, type StoreContext } from "../store/layout";
import { readControl, writeControl } from "../store/control";
import { createLedgerReader } from "../store/ledgerReader";
import { createLedgerStore } from "../store/ledger";
import { DEFAULT_STALE_MS } from "../node/locks";
import { ownedHash, writeDerivedNote } from "../store/notesWriter";
import { createRecordReader } from "../store/recordReader";
import { createRendererPool } from "../render/rendererPool";
import type { CortexView } from "../ui/CortexView";
import { t } from "../ui/copy";
import { createAgentsClock } from "./agentsClock";
import { watchVaultNoteFiles } from "./vaultSource";
import { createCaptureService } from "./captureServer";
import { createAssistantExecutor } from "./aiExecutor";
import { createActivityTracker } from "./background";
import { createColourSlotService } from "./colourSlots";
import { createNodeCorrectionService } from "./correctionsNode";
import { createSampleRecord, sampleTextResult } from "./sampleRecord";
import { exportDiagnostics, saveFile } from "./saveFile";
import { createDeviceHandle } from "./deviceHandle";
import { createNodeIndexService } from "./indexerNode";
import { createNewEntryService } from "./newEntry";
import { createNoticeService, type NoticeService } from "./notices";
import { createBridge } from "./obsidianBridge";
import { createPinnedViewService } from "./pinnedViews";
import { createResumeService } from "./resumeService";
import { createRunnerClient } from "./runnerClient";
import type { BackgroundServices, CortexServices, LeafServices, SettingsHandle } from "./services";
import { createSourcesService } from "./sourcesService";
import type { StatusBarService } from "./statusBar";
import { createWorkerClient } from "./workerClient";

export interface BackgroundDeps {
  app: App;
  /** Absolute path of the plugin folder (…/.obsidian/plugins/cortex). */
  pluginDir: string;
  pluginVersion: string;
  settings: SettingsHandle;
  /** The status bar item registered in onload (bound to `shared` by main.ts). */
  statusBar?: StatusBarService;
  /** The shared store created in onload (so the status bar follows it from the start). */
  shared?: SharedStore;
  /** The notice service created in onload (one throttle for the whole session). */
  notices?: NoticeService;
  anyLeafVisible(): boolean;
  showNotice(text: string): void;
  /** Milliseconds since the last user input anywhere in Obsidian ("Only work while Obsidian is idle"). */
  idleMs?(): number;
  now?(): number;
  /** Where log lines go besides the ring (default: the developer console). Tests pass a quiet sink. */
  logSink?: LogSink;
}

/** How often the agents status is refreshed while background work runs (besides events and midnight). */
export const STATUS_REFRESH_MS = 10 * 60_000;
/** Status refreshes after bursts of runner events are coalesced. */
export const STATUS_DEBOUNCE_MS = 2_000;

interface Internal {
  deps: BackgroundDeps;
  ring: ReturnType<typeof createRingSink>;
  disposers: (() => void)[];
  started: boolean;
  disposed: boolean;
  store: Promise<StoreContext> | null;
  /** The switches last written to control.json by this session. */
  control: { paused: boolean; privacy: string } | null;
  controlChain: Promise<void>;
  statusTimer: ReturnType<typeof setTimeout> | null;
}

const internals = new WeakMap<BackgroundServices, Internal>();
const sandboxes = new WeakMap<CortexServices, Signal<boolean>>();

function internalOf(bg: BackgroundServices): Internal {
  const st = internals.get(bg);
  if (!st) throw new CortexError("E_INTERNAL", "background services were not created by createBackground");
  return st;
}

export function vaultBasePath(app: App): string {
  const adapter = app.vault.adapter;
  if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
  throw new CortexError("E_INTERNAL", "Cortex needs the desktop app (a vault on the file system)");
}

/** The import selectors for one clock pass: what the user turned on, and what this build ships. */
export function importSelectors(s: CortexSettings, reason: "startup" | "watch" | "seal" | "vault"): SourceSelector[] {
  const out: SourceSelector[] = [];
  // A note changed in the vault outside wiki/: the vault's notes (and what was written in Cortex) only, not the transcripts.
  if (reason === "vault") {
    if (s.sources.vault.enabled) out.push({ kind: "vault-notes" });
    if (s.sources.written.enabled && featureOn("newEntry")) out.push({ kind: "written" });
    return out;
  }
  if (s.sources.claudeCode.enabled) out.push({ kind: "claude-code" });
  // Other coding agents: opt-in, watched like Claude Code (stage at once, seal when idle).
  if (s.sources.codexCli.enabled) out.push({ kind: "codex-cli" });
  if (s.sources.geminiCli.enabled) out.push({ kind: "gemini-cli" });
  if (s.sources.cursor.enabled) out.push({ kind: "cursor" });
  // Live capture: turns the browser add-on posted to the loopback receiver wait in a local spool; this reads them.
  if (s.sources.capture.enabled) out.push({ kind: "capture" });
  if (reason !== "startup") return out;
  if (s.sources.raw.enabled) out.push({ kind: "raw" });
  if (s.sources.vault.enabled) out.push({ kind: "vault-notes" });
  if (s.sources.written.enabled && featureOn("newEntry")) out.push({ kind: "written" });
  if (featureOn("folderSources")) for (const f of s.sources.folders) if (f.enabled) out.push({ kind: "folder", id: f.id });
  return out;
}

/** Settings whose change must stop a running job before it sends more text (control.json privacyRev). */
export function privacySignature(s: CortexSettings): string {
  return JSON.stringify({
    privacy: s.privacy,
    skipReference: s.agents.skipReference,
    vaultExclude: s.sources.vault.excludeFolders,
    rawExclude: s.sources.raw.excludeFolders,
    rawReference: s.sources.raw.referenceFolders,
    ccExclude: s.sources.claudeCode.excludeProjects,
    ccContent: [s.sources.claudeCode.includeSubagents, s.sources.claudeCode.includeToolOutput, s.sources.claudeCode.includeThinking],
    agentContent: [s.sources.codexCli.includeToolOutput, s.sources.geminiCli.includeToolOutput, s.sources.cursor.includeToolOutput],
  });
}

const importsInFlight = new WeakMap<SharedStore, number>();

/** Run an import while the status bar shows "importing ‹p›%" (overlapping imports share the indicator). */
export async function trackImport<T>(shared: SharedStore, run: (onProgress: (p: { done: number; total?: number; note?: string }) => void) => Promise<T>): Promise<T> {
  importsInFlight.set(shared, (importsInFlight.get(shared) ?? 0) + 1);
  if (!shared.get("activity").importing) shared.update("activity", { importing: { done: 0 } });
  try {
    return await run((p) => {
      const kept = p.note !== undefined && /^\d+$/.test(p.note) ? Number(p.note) : undefined;
      const importing = { done: p.done, ...(p.total !== undefined && Number.isFinite(p.total) ? { total: p.total } : {}), ...(kept !== undefined ? { kept } : {}) };
      shared.update("activity", { importing });
    });
  } finally {
    const n = (importsInFlight.get(shared) ?? 1) - 1;
    importsInFlight.set(shared, n);
    if (n <= 0) {
      importsInFlight.delete(shared);
      shared.update("activity", (a) => {
        const next = { ...a };
        delete next.importing;
        return next;
      });
    }
  }
}

/** Run an index build while the status bar shows "indexing ‹p›%". */
export async function trackIndexBuild(shared: SharedStore, run: (onProgress: (p: { done: number; total?: number }) => void) => Promise<IndexBuildResult>): Promise<IndexBuildResult> {
  const id = `index-${Date.now().toString(36)}`;
  const put = (done: number, total?: number): void => {
    const job: ActivityJob = total !== undefined ? { id, kind: "index", phase: "build", done, total } : { id, kind: "index", phase: "build", done };
    shared.update("activity", (a) => ({ ...a, jobs: [...a.jobs.filter((j) => j.id !== id), job] }));
  };
  put(0);
  try {
    return await run((p) => put(p.done, p.total));
  } finally {
    shared.update("activity", (a) => ({ ...a, jobs: a.jobs.filter((j) => j.id !== id) }));
  }
}

/**
 * Fold one runner event into the shared store. Idempotent per event (jobs are keyed by run id), so a second
 * listener applying the same event changes nothing.
 */
export function foldRunnerEvent(shared: SharedStore, ev: RunnerEvent): void {
  switch (ev.kind) {
    case "engine-state":
      shared.update("activity", (a) => {
        const next = { ...a, engine: ev.state };
        if (ev.resumeAt !== undefined) next.resumeAt = ev.resumeAt;
        else delete next.resumeAt;
        return next;
      });
      return;
    case "budget":
      shared.update("activity", { tokensToday: ev.tokensToday, ...(ev.usdToday !== undefined ? { usdToday: ev.usdToday } : {}), plan: ev.plan, capped: ev.capped });
      return;
    case "job-started":
      shared.update("activity", (a) => ({ ...a, jobs: [...a.jobs.filter((j) => j.id !== ev.runId), { id: ev.runId, kind: ev.job, phase: "running", done: 0, total: ev.targets }] }));
      return;
    case "job-finished":
      shared.update("activity", (a) => ({ ...a, jobs: a.jobs.filter((j) => j.id !== ev.runId) }));
      return;
    case "warning":
      shared.update("activity", { lastWarning: ev.code });
      return;
    default:
      return;
  }
}

/** The background notice an event deserves (transitions only; `before` is the activity before folding). */
export function noticeForEvent(ev: RunnerEvent, before: { capped: boolean; engine: string }): { kind: "imported" | "capped" | "engine" | "limit" | "runner"; text: string } | null {
  switch (ev.kind) {
    case "entries-added":
      if (!ev.live && ev.conversations > 0 && ev.sources.includes("claude-code")) return { kind: "imported", text: t("notices.imported", { n: ev.conversations }) };
      return null;
    case "budget":
      return ev.capped && !before.capped ? { kind: "capped", text: t("notices.capped") } : null;
    case "engine-state":
      if (ev.state === before.engine) return null;
      if (ev.state === "auth") return { kind: "engine", text: t("notices.signIn") };
      if (ev.state === "missing") return { kind: "engine", text: t("notices.missing") };
      if (ev.state === "limit") return { kind: "limit", text: t("notices.limit") };
      return null;
    case "warning":
      return ev.code === "runner-unavailable" ? { kind: "runner", text: t("warnings.runner-unavailable") } : null;
    default:
      return null;
  }
}

/**
 * Apply an agents.status result to the shared store (the activity and the queues the Agents page reads). Cortex
 * Desktop's screenshot harness applies its stand-in status through this too (src/desktop/shotSteps.ts, agentsStatus).
 */
export function applyStatus(shared: SharedStore, r: { tokensToday: number; usdToday: number; plan: ActivityState["plan"]; capped: boolean; engine: CortexSettings extends never ? never : import("../shared/protocol/runner").EngineState; resumeAt?: string; pending: Record<string, number>; groups?: PendingGroup[]; checks: number }): void {
  shared.batch(() => {
    shared.update("activity", (a) => {
      const next = { ...a, tokensToday: r.tokensToday, usdToday: r.usdToday, plan: r.plan, capped: r.capped, engine: r.engine };
      if (r.resumeAt !== undefined) next.resumeAt = r.resumeAt;
      else delete next.resumeAt;
      return next;
    });
    shared.update("queues", { label: r.pending.label ?? 0, summaries: r.pending.gist ?? 0, maps: r.pending.hub ?? 0, checks: r.checks, groups: r.groups ?? [] });
  });
}

/**
 * Watch the session folders for the clock, following the settings (folder, on/off, watch): Claude Code's
 * transcripts, and the opt-in logs of Codex CLI, Gemini CLI and Cursor. A folder is watched only while its source
 * is on and set to watch; Cursor's databases change often, so they settle for longer before a pass runs.
 */
function transcriptWatcher(settings: SettingsHandle, log: Logger): (onChange: () => void) => () => void {
  interface Target {
    dir: string;
    ext: readonly string[];
    debounceMs: number;
  }
  const targets = (s: CortexSettings): Target[] => {
    const out: Target[] = [];
    const cc = s.sources.claudeCode;
    if (cc.enabled && cc.watch) out.push({ dir: claudeProjectsDir(cc.projectsDir), ext: [".jsonl"], debounceMs: 1000 });
    const other = (c: CortexSettings["sources"]["codexCli"], dflt: string, ext: readonly string[], debounceMs: number): void => {
      if (c.enabled && c.watch) out.push({ dir: c.dir.trim() !== "" && path.isAbsolute(c.dir.trim()) ? c.dir.trim() : dflt, ext, debounceMs });
    };
    other(s.sources.codexCli, codexHomeDir(), [".jsonl"], 1000);
    other(s.sources.geminiCli, geminiCliHomeDir(), [".json"], 2000);
    other(s.sources.cursor, cursorUserDir(), [".vscdb", ".vscdb-wal"], 5000);
    return out;
  };
  return (onChange) => {
    let key = "";
    let closers: (() => void)[] = [];
    const stop = effect(() => {
      const want = targets(settings.signal.value);
      const next = JSON.stringify(want);
      if (next === key) return;
      for (const c of closers) c();
      key = next;
      closers = want.map((t) =>
        watchTree(t.dir, onChange, {
          filter: (rel) => t.ext.some((e) => rel.toLowerCase().endsWith(e)),
          debounceMs: t.debounceMs,
          onError: (e) => log.warn("session watcher stopped", { code: errCode(e) ?? "unknown" }),
        }),
      );
    });
    return () => {
      stop();
      for (const c of closers) c();
    };
  };
}

/** Build the headless tier. Synchronous and free of disk access (it may run before the first-run step). */
export function createBackground(deps: BackgroundDeps): BackgroundServices {
  const vaultRoot = vaultBasePath(deps.app);
  const key = computeVaultKey(vaultRoot);
  const settings = deps.settings;
  const now = deps.now ?? (() => Date.now());
  const cacheDir = defaultCacheDir(key);
  const ring = createRingSink(200, "warn", now);
  const log = createLogger("plugin", teeSink(deps.logSink ?? consoleSink, ring.sink), () => settings.value.general.debug);
  const bus = new EventBus();
  const shared = deps.shared ?? createSharedStore();
  const getSettings = (): CortexSettings => settings.value;
  const runner = createRunnerClient({ pluginDir: deps.pluginDir, vaultRoot, vaultKey: key, cacheDir, pluginVersion: deps.pluginVersion, getSettings, bus, log: log.child("runner") });
  const idle = deps.idleMs ?? createActivityTracker(now).idleMs;
  let nudgeImport: (() => void) | null = null;
  const clock = createAgentsClock({
    now,
    isBlocked: () => {
      const s = settings.value;
      const a = shared.get("activity");
      // A locked encrypted record takes no new data: the clock waits for the key (imports and agent passes would be refused).
      return settings.corrupt || !s.general.firstRunDone || s.agents.paused || a.capped || a.engine !== "ok" || recordKeyState() === "locked";
    },
    idleMs: () => idle(),
    // True when the pass finished some work: the clock runs another pass at its next tick until one finds nothing.
    runAgents: async (reason) => {
      const r = await runner.request({ cmd: "agents.run", args: { reason } });
      return Array.isArray(r?.runs) && r.runs.some((x) => x.status === "finished");
    },
    runImport: async (reason) => {
      const sources = importSelectors(settings.value, reason);
      if (sources.length === 0) return;
      await trackImport(shared, (onProgress) => runner.request({ cmd: "import", args: reason === "seal" ? { sources, seal: true } : { sources } }, { onProgress }));
    },
    runSeals: async () => {
      const s = settings.value;
      if (settings.corrupt || !s.general.firstRunDone || !s.advanced.dateSeals.sealLocally) return;
      await runner.request({ cmd: "seals.run", args: {} });
    },
    runWeeklyStamp: async () => {
      const d = settings.value.advanced.dateSeals;
      if (settings.corrupt || !settings.value.general.firstRunDone || !d.sealLocally || !d.weeklyStamp) return;
      await runner.request({ cmd: "seals.auto", args: {} });
    },
    // Notes outside wiki/ created or changed while Cortex is open are imported a few seconds later (not only at startup).
    watchVaultNotes: (onChange) => watchVaultNoteFiles(deps.app, () => {
      if (settings.value.sources.vault.enabled) onChange();
    }),
    watchTranscripts: (onChange) => {
      // The capture receiver nudges the same debounced pass when it has spooled new turns.
      nudgeImport = onChange;
      const close = transcriptWatcher(settings, log.child("watch"))(onChange);
      return () => {
        nudgeImport = null;
        close();
      };
    },
    schedule: () => {
      const a = settings.value.agents;
      return { onlyWhenIdle: a.onlyWhenIdle, idleStartSec: a.idleStartSec, nightly: a.nightly, deferWhileBusyMs: 0 };
    },
    log: log.child("clock"),
  });
  const status: StatusBarService = deps.statusBar ?? { update: () => undefined, current: null, dispose: () => undefined };
  const notices = deps.notices ?? createNoticeService({ now, anyLeafVisible: deps.anyLeafVisible, show: deps.showNotice });
  const bg: BackgroundServices = {
    app: deps.app,
    pluginDir: deps.pluginDir,
    pluginVersion: deps.pluginVersion,
    vaultRoot,
    vaultKey: key,
    cacheDir,
    settings,
    bus,
    log,
    shared,
    runner,
    clock,
    status,
    notices,
    ledger: createLedgerReader({ vaultRoot, cacheDir, log: log.child("ledger") }),
    capture: createCaptureService({
      cacheDir,
      settings,
      log: log.child("capture"),
      now,
      save: (req) => saveFile(req, { notice: (text) => st?.deps.showNotice(text) }),
      onSpooled: () => nudgeImport?.(),
    }),
  };
  const st: Internal = { deps, ring, disposers: [], started: false, disposed: false, store: null, control: null, controlChain: Promise.resolve(), statusTimer: null };
  internals.set(bg, st);

  // The capture receiver follows the settings (on, off, port) once background work has started.
  st.disposers.push(
    effect(() => {
      void settings.signal.value;
      if (st.started && !st.disposed) void bg.capture?.sync();
    }),
  );

  // Runner events → shared store, notices and a coalesced status refresh.
  st.disposers.push(
    bus.on("runner:frame", (f: FromRunner) => {
      if (f.t !== "event") return;
      const before = shared.get("activity");
      foldRunnerEvent(shared, f.event);
      const n = noticeForEvent(f.event, before);
      if (n) notices.notify(n.kind, n.text);
      const k = f.event.kind;
      if (k === "job-finished" || k === "entries-added" || k === "review-cards" || k === "labels-added" || k === "notes-written") scheduleStatus(bg, STATUS_DEBOUNCE_MS);
    }),
  );

  // Settings → "settings:changed" for every leaf, and control.json for running jobs.
  let first = true;
  st.disposers.push(
    effect(() => {
      const s = settings.signal.value;
      if (first) {
        first = false;
        return;
      }
      bus.emit("settings:changed", {});
      void syncControl(bg, s);
    }),
  );
  return bg;
}

/** True once startBackground ran for these services. */
export function isBackgroundStarted(bg: BackgroundServices): boolean {
  return internals.get(bg)?.started === true;
}

/** The store context for plugin-side writes (control.json, pinned views); opened once, after consent. */
function storeContext(bg: BackgroundServices): Promise<StoreContext> {
  const st = internalOf(bg);
  if (!st.store) {
    st.store = openStoreContext({ vaultRoot: bg.vaultRoot, cacheDir: bg.cacheDir, owner: "plugin", log: bg.log.child("store") });
    st.store.catch(() => {
      st.store = null; // retry on the next call
    });
  }
  return st.store;
}

/** Keep control.json in step with Pause and the privacy settings (plugin-owned write, serialised). */
function syncControl(bg: BackgroundServices, s: CortexSettings): Promise<void> {
  const st = internalOf(bg);
  st.controlChain = st.controlChain.then(async () => {
    if (!st.started || st.disposed || bg.settings.corrupt || !s.general.firstRunDone || st.control === null) return;
    const privacy = privacySignature(s);
    const paused = s.agents.paused;
    const privacyChanged = privacy !== st.control.privacy;
    if (paused === st.control.paused && !privacyChanged) return;
    try {
      await writeControl(await storeContext(bg), { paused, privacyChanged });
      st.control = { paused, privacy };
    } catch (e) {
      bg.log.warn("could not update control.json", { code: errCode(e) ?? (e as { code?: unknown }).code ?? "unknown" });
    }
  });
  return st.controlChain;
}

/** At start: make control.json say what the settings say (a pause made on another computer is honoured too). */
async function reconcileControl(bg: BackgroundServices): Promise<void> {
  const st = internalOf(bg);
  const s = bg.settings.value;
  const ctx = await storeContext(bg);
  const cur = await readControl(ctx);
  if (cur.paused !== s.agents.paused) await writeControl(ctx, { paused: s.agents.paused });
  st.control = { paused: s.agents.paused, privacy: privacySignature(s) };
}

/** Ask the runner for the agents status and apply it (errors are logged; the next refresh tries again). */
export async function refreshStatus(bg: BackgroundServices): Promise<void> {
  const st = internalOf(bg);
  if (!st.started || st.disposed) return;
  try {
    const r = await bg.runner.request({ cmd: "agents.status", args: {} });
    if (st.disposed) return;
    applyStatus(bg.shared, r);
    bg.shared.update("activity", { runner: bg.runner.mode });
  } catch (e) {
    bg.shared.update("activity", { runner: bg.runner.mode });
    bg.log.debug("agents status unavailable", { code: (e as { code?: unknown }).code ?? "unknown" });
  }
}

function msToNextMidnight(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - now;
}

/** Refresh the status after `delayMs` (coalesced); then keep refreshing at midnight and every 10 minutes. */
function scheduleStatus(bg: BackgroundServices, delayMs: number): void {
  const st = internalOf(bg);
  if (!st.started || st.disposed) return;
  if (st.statusTimer !== null) {
    if (delayMs >= STATUS_DEBOUNCE_MS) return; // a refresh is already due soon enough
    clearTimeout(st.statusTimer);
  }
  st.statusTimer = setTimeout(() => {
    st.statusTimer = null;
    void refreshStatus(bg).finally(() => {
      if (st.disposed || st.statusTimer !== null) return;
      const now = (st.deps.now ?? Date.now)();
      st.statusTimer = setTimeout(() => {
        st.statusTimer = null;
        scheduleStatus(bg, 0);
      }, Math.min(STATUS_REFRESH_MS, msToNextMidnight(now) + 5_000));
    });
  }, Math.max(0, delayMs));
}

/**
 * Start background work (after the first-run step, with readable settings): control.json, runner, status, then
 * the agents clock. Runs once; failures of one step are logged and the others still run.
 */
export async function startBackground(bg: BackgroundServices): Promise<void> {
  const st = internalOf(bg);
  if (st.started || st.disposed) return;
  if (bg.settings.corrupt || !bg.settings.value.general.firstRunDone) throw new CortexError("E_SETTINGS", "background work waits for the first-run step and readable settings");
  st.started = true;
  try {
    await reconcileControl(bg);
  } catch (e) {
    bg.log.warn("could not reconcile control.json", { code: errCode(e) ?? (e as { code?: unknown }).code ?? "unknown" });
  }
  if (st.disposed) return;
  try {
    const mode = await bg.runner.start();
    bg.shared.update("activity", { runner: mode });
  } catch (e) {
    bg.shared.update("activity", { runner: bg.runner.mode });
    bg.log.warn("runner did not start", { code: (e as { code?: unknown }).code ?? "unknown", message: errorMessage(e).slice(0, 200) });
  }
  if (st.disposed) return;
  scheduleStatus(bg, 0);
  try {
    bg.clock.start();
  } catch (e) {
    bg.log.error("agents clock did not start", { code: (e as { code?: unknown }).code ?? "unknown", message: errorMessage(e).slice(0, 200) });
  }
  // Live capture listens only when the person turned it on (and agreed) on this computer.
  void bg.capture?.sync().catch((e: unknown) => bg.log.warn("capture receiver did not start", { code: (e as { code?: unknown }).code ?? "unknown" }));
}

/** Stop background work: the clock first (its watchers close), then subscriptions, then the runner. */
export async function disposeBackground(bg: BackgroundServices): Promise<void> {
  const st = internals.get(bg);
  if (!st || st.disposed) return;
  st.disposed = true;
  try {
    bg.clock.stop();
  } catch (e) {
    bg.log.warn("agents clock stop failed", { message: errorMessage(e).slice(0, 200) });
  }
  if (st.statusTimer !== null) clearTimeout(st.statusTimer);
  st.statusTimer = null;
  for (const d of st.disposers.splice(0)) {
    try {
      d();
    } catch {
      // keep releasing the rest
    }
  }
  try {
    await bg.capture?.stop();
  } catch {
    // the receiver was not listening
  }
  try {
    bg.runner.cancelAll();
  } catch {
    // nothing in flight
  }
  try {
    await bg.runner.stop();
  } catch (e) {
    bg.log.warn("runner stop failed", { message: errorMessage(e).slice(0, 200) });
  }
  bg.status.dispose();
  bg.bus.clear();
}

/** Recent warnings and errors of this session (Export diagnostics). */
export function recentLog(bg: BackgroundServices): LogEntry[] {
  return internals.get(bg)?.ring.entries() ?? [];
}

export interface ServicesOptions {
  /** Reveal a Cortex leaf (main.ts passes its own; the bridge defaults to revealCortexLeaf). */
  reveal?(opts: { newLeaf?: boolean }): Promise<CortexView | null>;
}

/** Build the UI tier on top of the background tier (first view open, a command, a link). */
export function createServices(bg: BackgroundServices, opts: ServicesOptions = {}): CortexServices {
  const st = internals.get(bg);
  const sandbox = signal(false);
  const leaves = new Map<string, LeafServices>();
  const worker = createWorkerClient(bg.log.child("worker"));
  let services: CortexServices | null = null;
  const bridge = createBridge({
    app: bg.app,
    services: () => {
      if (!services) throw new CortexError("E_INTERNAL", "services are still being built");
      return services;
    },
    showNotice: st?.deps.showNotice ?? (() => undefined),
    ...(opts.reveal ? { reveal: opts.reveal } : {}),
  });
  // The store context is built without touching the disk; startBackground / storeContext(bg) create the folders.
  const storeCtx: StoreContext = { vaultRoot: bg.vaultRoot, cacheDir: bg.cacheDir, owner: "plugin", log: bg.log.child("store"), lockStaleMs: DEFAULT_STALE_MS };
  const ledgerStore = createLedgerStore(storeCtx);
  const corrections = createNodeCorrectionService({
    ctx: storeCtx,
    ledger: ledgerStore,
    settings: bg.settings,
    sandbox: () => sandbox.peek(),
    log: bg.log.child("corrections"),
    applyTheirs: async (card) => {
      const p = card.proposal as { path: string; markdown: string };
      await writeDerivedNote(storeCtx, { path: p.path, markdown: p.markdown, ownedSha256: ownedHash(p.markdown) }, undefined, { overwriteUserEdits: true });
    },
  });
  void corrections.load().catch((e: unknown) => bg.log.warn("corrections did not load", { message: errorMessage(e).slice(0, 200) }));
  const index = createNodeIndexService({
    app: bg.app as never,
    vaultRoot: bg.vaultRoot,
    cacheDir: bg.cacheDir,
    owner: "plugin",
    settings: bg.settings,
    log: bg.log.child("index"),
    bus: bg.bus,
    shared: bg.shared,
    runner: bg.runner,
    worker,
    corrections,
  });
  const records = createRecordReader({
    vaultRoot: bg.vaultRoot,
    cacheDir: bg.cacheDir,
    index: () => index.index.peek(),
    corrections: () => corrections.list(),
    sandbox: () => sandbox.peek(),
    sampleText: sampleTextResult,
    vaultNotePath: (() => {
      const find = createVaultPathResolver(() => (bg.app.vault as unknown as { getMarkdownFiles?(): { path: string }[] }).getMarkdownFiles?.().map((f) => f.path) ?? []);
      return (id: string) => find(id);
    })(),
    log: bg.log.child("records"),
  });
  const save: CortexServices["save"] = (req) => saveFile(req, { notice: (text) => st?.deps.showNotice(text) });
  const colours = createColourSlotService({ vaultRoot: bg.vaultRoot, cacheDir: bg.cacheDir, log: bg.log.child("colours") });
  void colours.load?.().catch(() => undefined);
  const recordKeys = createRecordKeyAccess({ vaultRoot: bg.vaultRoot, cacheDir: bg.cacheDir, os: desktopOsKey() });
  // Unlocking an encrypted record: read it again (the index loaded while it was closed knew nothing of it).
  subscribeKeyring((state) => {
    if (state === "open") void index.load({ force: true }).catch(() => undefined);
  });
  const built: CortexServices = {
    ...bg,
    index,
    worker,
    records,
    corrections,
    assistant: createAssistantExecutor({
      runner: bg.runner,
      ledger: ledgerStore,
      reader: bg.ledger,
      corrections,
      index,
      worker,
      records,
      settings: bg.settings,
      shared: bg.shared,
      leaves: { store: (viewId) => leaves.get(viewId)?.store },
      sandbox: () => sandbox.peek(),
      log: bg.log.child("assistant"),
    }),
    renderers: createRendererPool(),
    colours,
    save,
    exportDiagnostics: () => exportDiagnostics(bg, { notice: (text) => st?.deps.showNotice(text), recent: () => recentLog(bg), obsidianVersion: typeof apiVersion === "string" ? apiVersion : "unknown" }),
    bridge,
    device: createDeviceHandle(bg.app, () => bg.log.warn("device state could not be saved")),
    sources: createSourcesService({
      app: bg.app,
      vaultRoot: bg.vaultRoot,
      cacheDir: bg.cacheDir,
      log: bg.log.child("sources"),
      settings: bg.settings,
      runner: bg.runner,
      corrections,
      index: () => index.index.peek(),
      importing: () => bg.shared.get("activity").importing !== undefined,
      sandbox: () => sandbox.peek(),
      health: () => {
        const failure = bg.shared.get("data").failure;
        return { ...(failure ? { indexFailure: failure } : {}), runner: bg.shared.get("activity").runner };
      },
      save,
    }),
    newEntry: createNewEntryService({ vaultRoot: bg.vaultRoot, cacheDir: bg.cacheDir, log: bg.log.child("new-entry"), runner: bg.runner, sandbox: () => sandbox.peek() }),
    pinnedViews: createPinnedViewService({ vaultRoot: bg.vaultRoot, cacheDir: bg.cacheDir, log: bg.log.child("views") }),
    resume: createResumeService({
      cacheDir: bg.cacheDir,
      log: bg.log.child("resume"),
      sandbox: () => sandbox.peek(),
      // Entries holding every word, over the whole record (not what a leaf happens to show); the last word is not a prefix.
      search: async (terms) => {
        const res = await worker.call("resume:check", "search", { query: `${terms.join(" ")} `, limit: 5, visibility: { scope: "all", period: null, notes: true, vaultNotes: true, maps: false, record: true, undatedCloud: true, reference: false, askHistory: false, subagents: false, automated: false, revealedCount: 0 } });
        const out: { id: string; title: string }[] = [];
        for (let i = 0; i < res.ordinals.length && out.length < 3; i++) {
          const m = index.meta(res.ordinals[i] as number);
          if (m && /^(e|n|w)_/.test(m.id) && m.source !== "cortex-ask") out.push({ id: m.id, title: m.title });
        }
        return out;
      },
    }),
    sandbox,
    recordKeys,
    leafStore: () => [...leaves.values()].at(-1)?.store,
    createLeaf(viewId) {
      leaves.get(viewId)?.dispose();
      const store = createLeafStore({ view: defaultView(bg.settings.value) });
      let disposed = false;
      const leaf: LeafServices = {
        viewId,
        store,
        dispose: () => {
          if (disposed) return;
          disposed = true;
          if (leaves.get(viewId) === leaf) leaves.delete(viewId);
          try {
            worker.dropView(viewId);
          } catch {
            // the worker may already be gone
          }
        },
      };
      leaves.set(viewId, leaf);
      return leaf;
    },
  };
  services = built;
  sandboxes.set(built, sandbox);
  const sampleRecord = createSampleRecord({ index, setSandbox: (on) => setSandbox(built, on), sandbox, log: bg.log.child("sample") });
  const stopCommands = bg.bus.on("command", (ev) => {
    // Building the sample record is heavy: start it after the command has returned, so the command itself is instant.
    if (ev.id === "toggle-sample") setTimeout(() => void sampleRecord.toggle().catch((e: unknown) => bg.log.warn("sample record toggle failed", { message: errorMessage(e).slice(0, 200) })), 0);
  });
  commandStops.set(built, stopCommands);
  // The UI tier is built when the first view opens: load the record (the index also follows the cache signal).
  void Promise.resolve()
    .then(() => index.load())
    .catch((e: unknown) => bg.log.warn("index did not load", { message: errorMessage(e).slice(0, 200) }));
  leafRegistries.set(built, leaves);
  return built;
}

const commandStops = new WeakMap<CortexServices, () => void>();
const leafRegistries = new WeakMap<CortexServices, Map<string, LeafServices>>();

/** Turn the sample record sandbox on or off (M13; the sample record's owner calls this after loading it). */
export function setSandbox(s: CortexServices, on: boolean): void {
  const sig = sandboxes.get(s);
  if (!sig) throw new CortexError("E_INTERNAL", "services were not created by createServices");
  sig.value = on;
}

/** Release the UI tier (leaves, worker, renderers, index, bridge). The background tier is disposed separately. */
export function disposeServices(s: CortexServices): void {
  commandStops.get(s)?.();
  for (const leaf of [...(leafRegistries.get(s)?.values() ?? [])]) leaf.dispose();
  const release = (x: unknown): void => {
    const o = x as { dispose?: () => void; terminate?: () => void } | null;
    try {
      if (typeof o?.dispose === "function") o.dispose();
      else if (typeof o?.terminate === "function") o.terminate();
    } catch {
      // keep releasing the rest
    }
  };
  for (const x of [s.bridge, s.renderers, s.worker, s.index, s.assistant, s.corrections, s.colours, s.records, s.sources, s.newEntry]) release(x);
}
