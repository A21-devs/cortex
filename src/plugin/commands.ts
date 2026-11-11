/**
 * Obsidian commands: exactly the CORTEX-UX §8.2 ids (L2). Owner: E1. Part of the eager core: registration only;
 * dispatch lives in plugin/commandRun.ts (loaded on first use). Obsidian prefixes ids with "cortex:" and shows
 * names as "Cortex: <name>". One default hotkey (Lock, Mod+Shift+L; Obsidian keeps Mod+L). Every in-view key (§8.1) also exists here so it can be bound
 * globally. Hotkeys bind to ids, so ids never change after release.
 *
 * Commands of features that have not shipped in this build (shared/features.ts, ARCHITECTURE §19) use
 * checkCallback (always false) and stay out of the palette. Save image… and Copy data as CSV ship with the Chart page (
 * P1), so the two share the `chartPage` gate.
 */
import type { Command, Plugin } from "obsidian";
import { BUILD_PHASE, featureOn, type FeatureId, type Phase } from "../shared/features";
import type { CopyKey } from "../ui/copy";

export const COMMANDS = [
  { id: "open", name: "Open" },
  { id: "open-new", name: "Open in a new tab" },
  { id: "find", name: "Find in the record" },
  { id: "ask", name: "Ask", feature: "ask" },
  { id: "add-sources", name: "Add sources" },
  { id: "show-active-note", name: "Show the current note" },
  { id: "open-read", name: "Open Read" },
  { id: "open-time", name: "Open Time" },
  { id: "open-agents", name: "Open Agents" },
  { id: "open-checks", name: "Open checks", feature: "checks" },
  { id: "open-sources", name: "Open Sources" },
  { id: "open-guide", name: "Open the guide", feature: "guide" },
  { id: "open-today", name: "Show today", feature: "today" },
  { id: "new-entry", name: "New entry", feature: "newEntry" },
  { id: "change-history", name: "Change history", feature: "ask" },
  { id: "toggle-chart", name: "Toggle chart", feature: "chartShape" },
  { id: "display", name: "Display controls" },
  { id: "toggle-motion", name: "Spin on or off" },
  { id: "home-view", name: "Home view" },
  { id: "frame-selection", name: "Frame the selection" },
  { id: "clear", name: "Clear traced and selected" },
  { id: "next-area", name: "Next area" },
  { id: "previous-area", name: "Previous area" },
  { id: "show-arrivals", name: "Show held arrivals", feature: "liveArrivals" },
  { id: "import-claude-code", name: "Import Claude Code sessions now" },
  { id: "run-agents", name: "Run agents now" },
  { id: "pause-agents", name: "Pause agents" },
  { id: "resume-agents", name: "Resume agents" },
  { id: "rebuild-index", name: "Rebuild the index" },
  { id: "pin-view", name: "Pin view", feature: "pinView" },
  { id: "save-image", name: "Save image", feature: "chartPage" },
  { id: "export-ledger", name: "Export ledger", feature: "agentsLedger" },
  { id: "prove-entry", name: "Prove this entry" },
  { id: "audit-pack", name: "Audit pack" },
  { id: "export-record", name: "Export my record" },
  { id: "open-export", name: "Open an encrypted export" },
  { id: "copy-data-csv", name: "Copy data as CSV", feature: "chartPage" },
  { id: "reset-hints", name: "Reset hints", feature: "hints" },
  { id: "toggle-sample", name: "Explore or leave the sample record", feature: "sampleRecord" },
  { id: "reset-display", name: "Reset display" },
  { id: "toggle-immersive", name: "Immersive mode" },
  { id: "showcase", name: "Showcase mode" },
  { id: "setup-agents", name: "Set up agents" },
  { id: "connect-agent", name: "Connect an agent" },
  { id: "show-agreement", name: "Show what is sent" },
  { id: "check-updates", name: "Check for updates" },
  { id: "lock", name: "Lock", hotkeys: [{ modifiers: ["Mod", "Shift"], key: "L" }] },
  { id: "encrypt-record", name: "Encrypt my record" },
  { id: "about", name: "About Cortex" },
  { id: "start-tour", name: "Quick walkthrough" },
  { id: "open-settings", name: "Cortex settings" },
] as const satisfies readonly { id: string; name: string; feature?: FeatureId; hotkeys?: readonly { modifiers: readonly ("Mod" | "Shift" | "Alt" | "Ctrl" | "Meta")[]; key: string }[] }[];

export type CommandId = (typeof COMMANDS)[number]["id"];
export const COMMAND_IDS: readonly CommandId[] = COMMANDS.map((c) => c.id);

const BY_ID: ReadonlyMap<string, { id: CommandId; name: string; feature?: FeatureId }> = new Map(COMMANDS.map((c) => [c.id, c as { id: CommandId; name: string; feature?: FeatureId }]));

export function isCommandId(s: unknown): s is CommandId {
  return typeof s === "string" && BY_ID.has(s);
}

/** The feature a command waits for (undefined = shipped in every phase). */
export function commandFeature(id: CommandId): FeatureId | undefined {
  return BY_ID.get(id)?.feature;
}

/** True when the command is part of this build (its feature, if any, is on). */
export function commandAvailable(id: CommandId): boolean {
  const f = commandFeature(id);
  return f === undefined || featureOn(f);
}

/**
 * Register every command; `run` dispatches by id (plugin/commandRun.ts, loaded lazily by main.ts).
 *
 * A command whose feature is on in this build gets a plain `callback`: Obsidian's command line interface
 * (`command id=cortex:…`) and the palette both run it with no Cortex leaf active. Only a command whose feature
 * has not shipped (an earlier `phase`) uses `checkCallback`, which keeps it out of the palette.
 */
export function registerCommands(plugin: Pick<Plugin, "addCommand">, run: (id: CommandId) => void, phase: Phase = BUILD_PHASE): void {
  for (const c of COMMANDS) {
    const feature = (c as { feature?: FeatureId }).feature;
    if (feature === undefined || featureOn(feature, phase)) {
      const hotkeys = (c as { hotkeys?: Command["hotkeys"] }).hotkeys;
      plugin.addCommand({ id: c.id, name: c.name, callback: () => run(c.id), ...(hotkeys ? { hotkeys: hotkeys.map((h) => ({ ...h, modifiers: [...h.modifiers] })) } : {}) });
    } else {
      plugin.addCommand({ id: c.id, name: c.name, checkCallback: () => false });
    }
  }
}

/**
 * The action commands the command bar (Find, "Pages and actions") and the header More menu run: ONE list, so the
 * palette-style bar never drifts from the commands above. `copy` is the label's key in ui/copy.ts; `words` are
 * extra search words. Each entry runs the Obsidian command `cortex:<id>` (menu, palette and bar share one code path).
 */
export interface ActionEntry {
  id: CommandId;
  copy: CopyKey;
  words?: string;
}

export const ACTION_REGISTRY: readonly ActionEntry[] = [
  { id: "add-sources", copy: "actions.addSources", words: "import connect chats" },
  { id: "home-view", copy: "actions.homeView", words: "reset camera" },
  { id: "display", copy: "actions.display", words: "view settings" },
  { id: "import-claude-code", copy: "actions.importNow", words: "claude code sessions" },
  { id: "run-agents", copy: "actions.runAgents", words: "organise label" },
  { id: "check-updates", copy: "actions.checkUpdates", words: "version release" },
  { id: "lock", copy: "actions.lock", words: "privacy hide" },
  { id: "setup-agents", copy: "actions.setupAgents", words: "engine claude" },
  { id: "connect-agent", copy: "actions.connectAgent", words: "sign in claude" },
  { id: "show-agreement", copy: "actions.showAgreement", words: "privacy consent data" },
  { id: "audit-pack", copy: "actions.auditPack", words: "seals proof check verify" },
  { id: "export-record", copy: "actions.exportRecord", words: "backup markdown zip save entries" },
  { id: "open-export", copy: "actions.openExport", words: "decrypt cortexenc unlock export zip" },
  { id: "open-settings", copy: "actions.openSettings", words: "preferences" },
];

/** The registry entries available in this build (their command's feature is on), in order. */
export function availableActions(phase: Phase = BUILD_PHASE): ActionEntry[] {
  return ACTION_REGISTRY.filter((a) => {
    const f = commandFeature(a.id);
    return f === undefined || featureOn(f, phase);
  });
}
