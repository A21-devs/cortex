/**
 * The header's More menu (CORTEX-UX §5.1, §2.2, §2.4): Reset display · Save image… · Copy data as CSV · Pin view…
 * · Open another Cortex view · Link views (P2) · Rebuild index · Reset hints · Sample record (toggle, P2) ·
 * Quick walkthrough (ui/walkthrough) · separator · Obsidian's own pane items (Split right, Open in new window, Close …)
 * rebuilt through view.onPaneMenu(menu, "more-options") and workspace.trigger("leaf-menu", menu, leaf).
 * Items that are also Obsidian commands run the command (one code path for menu, palette and hotkeys).
 * Owner: E11.
 */
import { effect } from "@preact/signals";
import type { App } from "obsidian";
import type { CortexServices, LeafServices } from "../../plugin/services";
import { featureOn } from "../../shared/features";
import type { Shell } from "../context";
import { t } from "../copy";
import { resetHints } from "../deviceState";
import { buildMenu, showAt, type MenuItemSpec } from "../primitives/menu";
import { resetDisplayWithUndo } from "../stage/DisplayPopover";
import { VIEW_TYPE_CORTEX } from "../CortexView";
import { startTour } from "../walkthrough/TourLayer";

export type MoreAction = "reset-display" | "save-image" | "copy-data" | "pin-view" | "open-another" | "link-views" | "rebuild" | "reset-hints" | "sample" | "tour" | AppMoreAction;

/** App-level items (P21): each runs the Obsidian command of the same name, so menu, palette and bar share one path. */
export type AppMoreAction = "app:about" | "app:open-settings" | "app:setup-agents" | "app:connect-agent" | "app:show-agreement" | "app:check-updates" | "app:lock";
export const APP_MORE_COMMANDS: Readonly<Record<AppMoreAction, string>> = {
  "app:about": "about",
  "app:open-settings": "open-settings",
  "app:setup-agents": "setup-agents",
  "app:connect-agent": "connect-agent",
  "app:show-agreement": "show-agreement",
  "app:check-updates": "check-updates",
  "app:lock": "lock",
};

export function moreItems(opts: { sandbox?: boolean; linked?: boolean; mini?: boolean } = {}): MenuItemSpec<MoreAction>[] {
  const items: MenuItemSpec<MoreAction>[] = [
    { value: "reset-display", label: t("more.resetDisplay"), icon: "rotate-ccw" },
    { value: "save-image", label: t("more.saveImage"), icon: "image-down" },
  ];
  if (featureOn("chartPage")) items.push({ value: "copy-data", label: t("more.copyData"), icon: "clipboard-copy" });
  if (featureOn("pinView")) items.push({ value: "pin-view", label: t("more.pinView"), icon: "pin" });
  items.push({ value: "open-another", label: t("more.openAnother"), icon: "plus" });
  if (featureOn("linkViews")) items.push({ value: "link-views", label: t("more.linkViews"), checked: opts.linked === true });
  items.push({ value: "rebuild", label: t("more.rebuild"), group: "maintenance" }, { value: "reset-hints", label: t("more.resetHints"), group: "maintenance" });
  if (featureOn("sampleRecord")) items.push({ value: "sample", label: t("more.sample"), group: "maintenance", checked: opts.sandbox === true });
  // Mini shows the brain only and hides overlays (CORTEX-UX §2.5), so the walkthrough has nowhere to draw: no item there.
  if (opts.mini !== true) items.push({ value: "tour", label: t("more.tour"), group: "maintenance" });
  items.push(
    { value: "app:about", label: t("more.about"), icon: "info", group: "app" },
    { value: "app:open-settings", label: t("more.settings"), icon: "settings", group: "app" },
    { value: "app:setup-agents", label: t("more.setupAgents"), group: "app" },
    { value: "app:connect-agent", label: t("more.connectAgent"), group: "app" },
    { value: "app:show-agreement", label: t("more.showAgreement"), group: "app" },
    { value: "app:check-updates", label: t("more.checkUpdates"), group: "app" },
    { value: "app:lock", label: t("more.lock"), icon: "lock", group: "app" },
  );
  return items;
}

/** Run an Obsidian command of this plugin by its §8.2 id (internal API, feature-detected). */
export function runCortexCommand(app: App, id: string): boolean {
  const commands = (app as unknown as { commands?: { executeCommandById?(id: string): boolean } }).commands;
  try {
    return commands?.executeCommandById?.(`cortex:${id}`) === true;
  } catch {
    return false;
  }
}

/** Open another Cortex view as a new tab in the main area. */
export async function openAnotherView(app: App): Promise<void> {
  if (runCortexCommand(app, "open-new")) return;
  const leaf = app.workspace.getLeaf("tab");
  await leaf.setViewState({ type: VIEW_TYPE_CORTEX, active: true });
}

// ───────────────────────────── Link views (P2) ─────────────────────────────

const links = new WeakMap<CortexServices, Set<LeafServices>>();

/** Leaves whose scope, period and query tokens are kept in step (More › Link views). */
export function linkedLeaves(s: CortexServices): ReadonlySet<LeafServices> {
  return links.get(s) ?? new Set();
}

export function isLinked(s: CortexServices, leaf: LeafServices): boolean {
  return links.get(s)?.has(leaf) === true;
}

export function setLinked(s: CortexServices, leaf: LeafServices, on: boolean): void {
  let set = links.get(s);
  if (!set) {
    set = new Set();
    links.set(s, set);
  }
  if (on) {
    const other = [...set][0];
    set.add(leaf);
    if (other) {
      const ui = other.store.get("ui");
      leaf.store.update("ui", { scope: ui.scope, period: ui.period, tokens: ui.tokens });
    }
  } else set.delete(leaf);
}

/** Copy scope, period and tokens from `from` to every other linked leaf (no-op when unchanged). */
export function propagateLink(s: CortexServices, from: LeafServices): void {
  const set = links.get(s);
  if (!set?.has(from)) return;
  const ui = from.store.get("ui");
  for (const other of set) {
    if (other === from) continue;
    const o = other.store.get("ui");
    if (o.scope === ui.scope && o.period === ui.period && o.tokens === ui.tokens) continue;
    other.store.update("ui", { scope: ui.scope, period: ui.period, tokens: ui.tokens });
  }
}

/**
 * Keep this leaf in step with the other linked leaves: whenever its scope, period or tokens change while it is
 * linked, the others follow. Returns the disposer, which also unlinks the leaf.
 */
export function bindLink(s: CortexServices, leaf: LeafServices): () => void {
  const stop = effect(() => {
    void leaf.store.slices.ui.value;
    propagateLink(s, leaf);
  });
  return () => {
    stop();
    setLinked(s, leaf, false);
  };
}

// ───────────────────────────── menu ─────────────────────────────

export function runMoreAction(v: MoreAction, s: CortexServices, leaf: LeafServices, shell: Shell): void {
  if (v in APP_MORE_COMMANDS) {
    runCortexCommand(s.app, APP_MORE_COMMANDS[v as AppMoreAction]);
    return;
  }
  switch (v) {
    case "reset-display":
      resetDisplayWithUndo(s, leaf, shell);
      return;
    case "save-image":
      runCortexCommand(s.app, "save-image");
      return;
    case "copy-data":
      runCortexCommand(s.app, "copy-data-csv");
      return;
    case "pin-view":
      runCortexCommand(s.app, "pin-view");
      return;
    case "open-another":
      void openAnotherView(s.app).catch((e: unknown) => s.log.warn("open another view failed", { error: String(e) }));
      return;
    case "link-views":
      setLinked(s, leaf, !isLinked(s, leaf));
      return;
    case "rebuild":
      if (!runCortexCommand(s.app, "rebuild-index")) {
        void s.runner
          .request({ cmd: "index.build", args: { full: true } })
          .then(() => s.index.load({ force: true }))
          .catch((e: unknown) => s.log.warn("rebuild failed", { error: String(e) }));
      }
      return;
    case "reset-hints":
      s.device.update(resetHints);
      return;
    case "sample":
      runCortexCommand(s.app, "toggle-sample");
      return;
    case "tour":
      startTour(s, shell);
      return;
    default:
      return;
  }
}

export function openMoreMenu(s: CortexServices, leaf: LeafServices, shell: Shell, anchor: HTMLElement): void {
  const menu = buildMenu(moreItems({ sandbox: s.sandbox.value, linked: isLinked(s, leaf), mini: leaf.store.slices.ui.value.breakpoint === "Mini" }), (v) => runMoreAction(v, s, leaf, shell));
  if (shell.bridge) {
    menu.addSeparator();
    shell.bridge.fillPaneMenu(menu);
  }
  showAt(menu, anchor);
}
