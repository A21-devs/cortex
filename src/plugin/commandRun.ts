/**
 * Command dispatch (lazy; loaded on the first command). Owner: E1.
 * Maps every CORTEX-UX §8.2 command id to a named state action on one Cortex leaf (state/actions.ts), a runner
 * request, a settings change or a modal. Nothing here is evaluated during plugin load.
 *
 *  - Palette commands act on the active Cortex leaf, else the most recently used one, else a new one (a new leaf
 *    mounts asynchronously; dispatch waits for its store). Keyboard bindings (ui/keymap.ts) pass their own leaf
 *    as `host.target`.
 *  - Consent (SAFE-11): before the first-run step, "Import Claude Code sessions now" and "Run agents now" open
 *    the first-run step instead of doing anything; unreadable settings refuse with their notice.
 *  - The sample record (M13): imports, agent runs, New entry and Pin view refuse with "Not available in the
 *    sample record."
 *  - Commands whose work lives inside a leaf's UI (Save image…, Copy data as CSV, the sample record toggle) are
 *    published on the bus as a leaf command (`onLeafCommand`), which the owning UI handles.
 *  - Long-running global commands (import, agents, rebuild) ignore a repeat while the first is still running.
 *  - Failures become catalogue notices (plugin/notices.ts noticeForError); cancellations say nothing.
 */
import { TFile, type App } from "obsidian";
import { SPACE_ORDER } from "../shared/index-format";
import * as A from "../state/actions";
import type { EventBus } from "../state/events";
import { captureLeafState } from "../state/persist";
import type { CortexStore } from "../state/store";
import { defaultView } from "../state/types";
import { agentChipState } from "../state/selectors";
import { t } from "../ui/copy";
import { resetHints } from "../ui/deviceState";
import type { CortexView } from "../ui/CortexView";
import type { CommandId } from "./commands";
import { trackImport, trackIndexBuild } from "./container";
import { noticeForError, noticeText } from "./notices";
import { waitForLeafStore } from "./obsidianBridge";
import type { CortexServices } from "./services";
import { effectiveOpenSpaces } from "../shared/consent";
import { lockApp } from "../state/lock";
import { runUpdateCheck } from "./updateCheck";

/** Leaf-UI commands published on the bus (handled by the leaf's UI owners; see docs/rfcs/E1.md). */
export type LeafUiCommand = "save-image" | "copy-data-csv" | "toggle-sample";
export interface LeafCommandEvent {
  /** The leaf the command is for (the active or most recent Cortex leaf). */
  viewId: string;
  id: LeafUiCommand;
}

/** Publish a leaf command (the owning leaf's UI performs it). */
export function emitLeafCommand(bus: EventBus, ev: LeafCommandEvent): void {
  bus.emit("command", ev);
}

/** Subscribe to leaf commands; returns the unsubscribe function. */
export function onLeafCommand(bus: EventBus, fn: (ev: LeafCommandEvent) => void): () => void {
  return bus.on("command", fn);
}

export interface CommandTarget {
  viewId: string;
  store: CortexStore;
  /** The view, when known (used to focus the command line). */
  view?: CortexView;
}

export interface CommandHost {
  app: App;
  /** Reveal the most recent Cortex leaf (or a new one) and return its view. */
  reveal(opts?: { newLeaf?: boolean }): Promise<CortexView | null>;
  /** Show a notice (direct feedback to the command). */
  notice(text: string): void;
  /** The leaf a key binding came from; palette commands leave it out. */
  target?: CommandTarget;
  /** Start the background tier now if its gate is open (agents and imports need it). */
  ensureBackground?(): Promise<void>;
  /** How long to wait for a new leaf to mount (default 15 s). */
  mountTimeoutMs?: number;
  /** The plugin manifest (About and Check for updates read the repository from authorUrl). */
  manifest?: { id?: string; version?: string; authorUrl?: string; description?: string };
}

/** Run another Cortex command by its id (modal buttons use the one dispatch path). */
function runCortexCommandById(app: App, id: string): void {
  (app as unknown as { commands?: { executeCommandById?(id: string): boolean } }).commands?.executeCommandById?.(`cortex:${id}`);
}

const inflight = new Set<CommandId>();

async function once(id: CommandId, fn: () => Promise<void>): Promise<void> {
  if (inflight.has(id)) return;
  inflight.add(id);
  try {
    await fn();
  } finally {
    inflight.delete(id);
  }
}

/** The first-run step (before consent) or Add sources: E11's header owns both flows. */
async function openSetup(s: CortexServices): Promise<void> {
  const { openAddSources } = await import("../ui/header/Header");
  await openAddSources(s);
}

/** Refuse what the sample record, a missing first-run step or unreadable settings do not allow. Returns true when refused. */
async function refuseRecordWork(s: CortexServices, host: CommandHost): Promise<boolean> {
  if (s.sandbox.value) {
    host.notice(t("ask.sample"));
    return true;
  }
  if (s.settings.corrupt) {
    host.notice(t("notices.settings"));
    return true;
  }
  if (!s.settings.value.general.firstRunDone) {
    await openSetup(s);
    return true;
  }
  return false;
}

/** Why agents cannot run right now, as catalogue text (null = they can). */
export function agentsBlockedText(s: Pick<CortexServices, "settings" | "shared">): string | null {
  if (s.settings.value.agents.paused) return t("agents.paused");
  const a = s.shared.get("activity");
  switch (agentChipState(a)) {
    case "sign-in":
      return t("agents.signIn");
    case "missing":
      return t("notices.missing");
    case "unsafe":
      return t("agents.unsafe");
    case "limit":
      return t("notices.limit");
    case "capped":
      return t("agents.capped");
    default:
      return null;
  }
}

function focusCommandLine(view: CortexView | undefined): void {
  const root = view?.contentEl as (HTMLElement & { querySelector?: (s: string) => Element | null }) | undefined;
  if (!root || typeof root.querySelector !== "function") return;
  const tryFocus = (): boolean => {
    const input = root.querySelector('[role="search"] [role="combobox"], [role="combobox"]') as HTMLElement | null;
    if (input && typeof input.focus === "function") {
      input.focus();
      return true;
    }
    return false;
  };
  if (!tryFocus()) setTimeout(tryFocus, 50);
}

async function resolveTarget(host: CommandHost, newLeaf = false): Promise<CommandTarget | null> {
  if (host.target && !newLeaf) return host.target;
  const view = await host.reveal({ newLeaf });
  if (!view) return null;
  const store = await waitForLeafStore(view, host.mountTimeoutMs ?? 15_000);
  return store ? { viewId: view.viewId, store, view } : null;
}

/** Run a command; never throws (failures become notices). */
export async function runCommand(id: CommandId, s: CortexServices, host: CommandHost): Promise<void> {
  try {
    await dispatch(id, s, host);
  } catch (e) {
    const text = noticeForError(e);
    if (text !== null) host.notice(text);
    s.log.warn("command failed", { id, code: (e as { code?: unknown }).code ?? "unknown" });
  }
}

async function dispatch(id: CommandId, s: CortexServices, host: CommandHost): Promise<void> {
  // ── Global commands: no leaf needed. ──
  switch (id) {
    case "open":
      await host.reveal({});
      return;
    case "open-new":
      await host.reveal({ newLeaf: true });
      return;
    case "add-sources":
      await openSetup(s);
      return;
    case "import-claude-code":
      await once(id, async () => {
        if (await refuseRecordWork(s, host)) return;
        if (!s.settings.value.sources.claudeCode.enabled) {
          // The source is turned off: show where to turn it on instead of reading it anyway.
          const target = await resolveTarget(host);
          if (target) A.openTab(target.store, "sources");
          return;
        }
        await host.ensureBackground?.();
        await trackImport(s.shared, (onProgress) => s.runner.request({ cmd: "import", args: { sources: [{ kind: "claude-code" }] } }, { onProgress }));
      });
      return;
    case "run-agents":
      await once(id, async () => {
        if (await refuseRecordWork(s, host)) return;
        const blocked = agentsBlockedText(s);
        if (blocked !== null) {
          host.notice(blocked);
          return;
        }
        await host.ensureBackground?.();
        if (s.clock.running) s.clock.poke("manual");
        else await s.runner.request({ cmd: "agents.run", args: { reason: "manual" } });
      });
      return;
    case "pause-agents":
    case "resume-agents":
      await s.settings.update((x) => void (x.agents.paused = id === "pause-agents"));
      return;
    case "rebuild-index":
      await once(id, async () => {
        if (s.sandbox.value) {
          host.notice(t("ask.sample"));
          return;
        }
        await trackIndexBuild(s.shared, (onProgress) => s.runner.request({ cmd: "index.build", args: { full: true } }, { onProgress }));
        await s.index.load({ force: true });
      });
      return;
    case "reset-hints":
      s.device.update(resetHints);
      return;
    case "lock":
      lockApp();
      return;
    case "check-updates":
      await once(id, async () => {
        await runUpdateCheck(host.app, { ...(host.manifest ?? {}), version: host.manifest?.version ?? s.pluginVersion });
      });
      return;
    case "setup-agents": {
      // Before the first-run step there is no engine configured: that step is the setup. After it, the Agents settings.
      if (!s.settings.value.general.firstRunDone && !s.settings.corrupt) {
        await openSetup(s);
        return;
      }
      const { openCortexSettings } = await import("../ui/pages/PageFrame");
      openCortexSettings(host.app, "agents");
      return;
    }
    case "encrypt-record": {
      // The flow needs a passphrase and a confirmation: it lives in Settings > Lock (check first, backup, encrypt, undo on failure).
      const { openCortexSettings } = await import("../ui/pages/PageFrame");
      openCortexSettings(host.app, "lock");
      return;
    }
    case "open-settings": {
      const { openCortexSettings } = await import("../ui/pages/PageFrame");
      openCortexSettings(host.app, "general");
      return;
    }
    case "about": {
      const { AboutModal } = await import("../ui/modals/AboutModal");
      new AboutModal(host.app, { version: host.manifest?.version ?? s.pluginVersion, ...(host.manifest?.description ? { description: host.manifest.description } : {}), ...(host.manifest?.authorUrl ? { authorUrl: host.manifest.authorUrl } : {}), ...(host.manifest?.id ? { id: host.manifest.id } : {}) }, (cmd) => runCortexCommandById(host.app, cmd)).open();
      return;
    }
    case "export-ledger": {
      // The Agents page's Export ledger button, reachable from the File menu with no page open.
      try {
        const { runsToCsv } = await import("../ui/pages/Agents");
        const runs = await s.ledger.runs({ limit: 100_000 });
        const where = await s.save({ suggestedName: "cortex-ledger.csv", mime: "text/csv", data: runsToCsv(runs) });
        if (where) host.notice(t("agents.exported"));
      } catch {
        host.notice(t("errors.action"));
      }
      return;
    }
    case "audit-pack": {
      const { makeAuditPack } = await import("./packs");
      await makeAuditPack(s, host.notice);
      return;
    }
    case "export-record": {
      if (s.sandbox.value) {
        host.notice(t("proof.sample"));
        return;
      }
      const [{ ExportRecordModal }, { exportMyRecord }, { recordKeyState }] = await Promise.all([import("../ui/modals/ExportRecordModal"), import("./packs"), import("../shared/crypto/keyring")]);
      new ExportRecordModal(host.app, {
        openSpaces: effectiveOpenSpaces(s.settings.value.consent, s.settings.value.userSpaces ?? []),
        canEncrypt: recordKeyState() === "open",
        onExport: (choice) => void exportMyRecord(s, choice, host.notice),
      }).open();
      return;
    }
    case "open-export": {
      if (s.sandbox.value) {
        host.notice(t("proof.sample"));
        return;
      }
      const [{ OpenExportModal }, { openEncryptedExport }] = await Promise.all([import("../ui/modals/OpenExportModal"), import("./packs")]);
      new OpenExportModal(host.app, { onOpen: (file) => void openEncryptedExport(s, file, host.notice) }).open();
      return;
    }
    case "prove-entry": {
      // The entry open in the reader of this leaf (the sheet's current reader entry).
      const target = await resolveTarget(host);
      const sheet = target?.store.get("ui").sheet;
      const cur = sheet ? sheet.stack[sheet.index] : undefined;
      if (!cur || cur.kind !== "reader" || cur.route !== "entry") {
        host.notice(t("proof.needEntry"));
        return;
      }
      const { proveEntry } = await import("./packs");
      await proveEntry(s, cur.id, host.notice);
      return;
    }
    case "show-agreement": {
      const { AgreementModal } = await import("../ui/modals/AgreementModal");
      new AgreementModal(host.app, () => s.settings.value, (chosen) => {
        if (!chosen) void openSetup(s);
        else void import("../ui/pages/PageFrame").then((m) => m.openCortexSettings(host.app, "agents"));
      }).open();
      return;
    }
    case "connect-agent": {
      const { ConnectModal } = await import("../ui/modals/ConnectModal");
      new ConnectModal(host.app, s, {
        openSetup: () => void openSetup(s),
        openAgentSettings: () => void import("../ui/pages/PageFrame").then((m) => m.openCortexSettings(host.app, "agents")),
      }).open();
      return;
    }
    case "toggle-sample": {
      // The sample record belongs to the whole window, not to one leaf: it works with no Cortex leaf active
      // (the command line interface has none). A leaf is shown for the person to see it, but never waited for.
      let viewId = host.target?.viewId ?? "";
      if (!host.target) {
        const view = await host.reveal({}).catch(() => null);
        if (view) viewId = view.viewId;
      }
      emitLeafCommand(s.bus, { viewId, id });
      return;
    }
    default:
      break;
  }

  // ── Leaf commands: act on one Cortex leaf. ──
  const target = await resolveTarget(host);
  if (!target) {
    s.log.warn("no Cortex leaf could be opened for the command", { id });
    host.notice(noticeText("failed"));
    return;
  }
  const { store, viewId } = target;
  switch (id) {
    case "find":
      A.setCommandMode(store, "find");
      focusCommandLine(target.view);
      return;
    case "ask":
      A.setCommandMode(store, "ask");
      focusCommandLine(target.view);
      return;
    case "show-active-note": {
      const file = host.app.workspace.getActiveFile();
      if (file instanceof TFile && file.extension.toLowerCase() === "md") await s.bridge.open({ kind: "note", path: file.path });
      return;
    }
    case "open-read":
      A.openTab(store, "read");
      return;
    case "open-time":
      A.openTab(store, "time");
      return;
    case "open-agents":
      A.openTab(store, "agents");
      return;
    case "open-sources":
      A.openTab(store, "sources");
      return;
    case "open-checks":
      store.batch(() => {
        A.openTab(store, "agents");
        A.openPage(store, "agents", { tab: "checks" });
      });
      return;
    case "open-today":
      store.batch(() => {
        A.openTab(store, "read");
        A.openPage(store, "read", { today: "1" });
      });
      return;
    case "open-guide":
      A.openPage(store, "guide");
      return;
    case "start-tour": {
      // The desktop's Help menu: the same walkthrough as the Guide page and the More menu.
      const [{ shellOfView }, { startTour }] = await Promise.all([import("../ui/context"), import("../ui/walkthrough/TourLayer")]);
      const shell = shellOfView(viewId);
      if (shell) startTour(s, shell);
      return;
    }
    case "change-history":
      A.openPage(store, "change-history");
      return;
    case "new-entry":
      if (s.sandbox.value) {
        host.notice(t("ask.sample"));
        return;
      }
      store.batch(() => {
        A.openTab(store, "read");
        A.openPage(store, "new-entry", undefined, true);
      });
      return;
    case "toggle-chart": {
      // Chart is a shape the figure morphs into: back to the body means morph 0, into it means a chart and morph 1.
      const v = store.get("view");
      if (v.shape === "chart" && v.morph > 0.5) {
        A.setMorph(store, 0);
        return;
      }
      if (!v.chart) {
        const { specForChart } = await import("../ui/pages/ChartPage");
        A.setView(store, "chart", specForChart("ranked-bars", null, v.groupBy));
      }
      A.setShape(store, "chart");
      A.setMorph(store, 1);
      return;
    }
    case "display":
      A.openPopover(store, store.get("ui").popover === "display" ? null : "display");
      return;
    case "toggle-motion": {
      const v = store.get("view");
      A.setMotion(store, { mode: v.motion.mode === "off" ? (v.pose === "lying" ? "drift" : "spin") : "off" });
      return;
    }
    case "home-view":
      s.bus.emit("camera:fly-to", { viewId, home: true });
      return;
    case "frame-selection": {
      const sel = store.get("selection");
      if (sel) s.bus.emit("camera:fly-to", { viewId, ordinal: sel.ordinal });
      return;
    }
    case "clear":
      store.batch(() => {
        A.clearTokens(store);
        A.clearSelection(store);
      });
      return;
    case "next-area":
    case "previous-area":
      A.setScope(store, A.stepScope(SPACE_ORDER, store.get("ui").scope, id === "next-area" ? 1 : -1));
      return;
    case "show-arrivals":
      A.revealArrivals(store, s.shared.get("data").available);
      return;
    case "reset-display":
      A.resetDisplay(store, defaultView(s.settings.value));
      return;
    case "toggle-immersive":
      A.toggleImmersive(store);
      return;
    case "showcase": {
      // The hands-free tour (ui/showcase): read-only, so it also runs in the sample record. Any key or click stops it.
      const [{ shellOfView }, { toggleShowcase }] = await Promise.all([import("../ui/context"), import("../ui/showcase/runner")]);
      const shell = shellOfView(viewId);
      if (shell) toggleShowcase(s, { viewId, store }, shell);
      return;
    }
    case "pin-view": {
      if (s.sandbox.value) {
        host.notice(t("ask.sample"));
        return;
      }
      const state = captureLeafState(store);
      const { CorrectionModal } = await import("../ui/modals/CorrectionModals");
      new CorrectionModal(host.app, {
        kind: "pin-view",
        onSave: (name: string) => {
          void s.pinnedViews.save(name, state).then(
            (rec) => host.notice(t("changes.pinned", { title: rec.name })),
            (e: unknown) => {
              const text = noticeForError(e);
              if (text !== null) host.notice(text);
            },
          );
        },
      }).open();
      return;
    }
    case "save-image":
    case "copy-data-csv":
      emitLeafCommand(s.bus, { viewId, id });
      return;
    default:
      return;
  }
}
