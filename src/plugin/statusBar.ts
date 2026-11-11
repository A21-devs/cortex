/**
 * Obsidian status bar item "Cortex · …" (CORTEX-UX §5.11, §8.4; M1 engine states). Owner: E1.
 * Registered in onload (cheap); its text follows the shared store and the settings whether or not a Cortex tab
 * is open. Glyph + text; click (or Enter / Space: the item is a keyboard-reachable button) opens Cortex on the
 * Agents page; tooltip "‹used› of ‹cap› tokens used today". Every string comes from ui/copy.ts.
 *
 * Precedence: unreadable settings → set up (before the first-run step) → importing ‹p›% → indexing ‹p›% →
 * engine states (sign-in, not found, agents off, offline, usage limit) → paused → cap reached → organising ‹n› →
 * agents turned off ("Import only") → ‹n› waiting → up to date.
 */
import { effect } from "@preact/signals-core";
import { setIcon } from "obsidian";
import { COPY, t } from "../ui/copy";
import { planTip } from "../ui/planText";
import { planCapsOf, withCaps } from "../shared/planLimits";
import { CORTEX_ICON_ID } from "../ui/icons";
import type { ActivityState, QueueState } from "../state/types";
import type { SharedStore } from "../state/store";
import { agentChipState, waitingTotal } from "../state/selectors";
import type { SettingsHandle } from "./services";

export interface StatusBarModel {
  text: string;
  tooltip: string;
}

export interface StatusInputs {
  activity: ActivityState;
  queues: QueueState;
  firstRunDone: boolean;
  /** "Organise automatically" (agents.enabled). */
  agentsEnabled: boolean;
}

/** Texts ui/copy.ts does not carry yet (requested from E12 in docs/rfcs/E1.md); the catalogue wins once present. */
const EXTRA = {
  settings: "Cortex · check settings",
  importingNoTotal: "Cortex · importing",
  indexingNoTotal: "Cortex · indexing",
  limit: "Cortex · usage limit reached",
  unsafe: "Cortex · agents off",
  off: "Cortex · agents off",
} as const;

function statusText(key: keyof typeof EXTRA): string {
  const fromCopy = (COPY.statusBar as Readonly<Record<string, string>>)[key];
  return typeof fromCopy === "string" ? fromCopy : EXTRA[key];
}

const nf = new Intl.NumberFormat("en-GB");
const fmt = (n: number): string => nf.format(Math.max(0, Math.round(n)));

function pct(done: number, total: number | undefined): number | undefined {
  if (total === undefined || !Number.isFinite(total) || total <= 0) return undefined;
  return Math.max(0, Math.min(100, Math.floor((100 * Math.max(0, done)) / total)));
}

/** Pure text and tooltip for the status bar item. */
export function statusBarModel(i: StatusInputs): StatusBarModel {
  const a = i.activity;
  const tokens = t("statusBar.tip", { used: fmt(a.tokensToday), plan: planTip(a.plan) });
  if (a.settingsCorrupt) return { text: statusText("settings"), tooltip: t("notices.settings") };
  if (!i.firstRunDone) return { text: t("statusBar.setUp"), tooltip: t("notices.firstRun") };
  if (a.importing) {
    const p = pct(a.importing.done, a.importing.total);
    return { text: p === undefined ? statusText("importingNoTotal") : t("statusBar.importing", { p }), tooltip: tokens };
  }
  const indexing = a.jobs.find((j) => j.kind === "index");
  if (indexing) {
    const p = pct(indexing.done, indexing.total);
    return { text: p === undefined ? statusText("indexingNoTotal") : t("statusBar.indexing", { p }), tooltip: tokens };
  }
  switch (agentChipState(a)) {
    case "sign-in":
      return { text: t("statusBar.signIn"), tooltip: t("agents.signIn") };
    case "missing":
      return { text: t("statusBar.missing"), tooltip: t("notices.missing") };
    case "unsafe":
      return { text: statusText("unsafe"), tooltip: t("agents.unsafe") };
    case "offline":
      return { text: t("statusBar.offline"), tooltip: t("agents.offline") };
    case "limit":
      return { text: statusText("limit"), tooltip: t("notices.limit") };
    case "paused":
      return { text: t("statusBar.paused"), tooltip: tokens };
    case "capped":
      return { text: t("statusBar.capped"), tooltip: tokens };
    case "organising":
      return { text: t("statusBar.organising", { n: a.jobs.filter((j) => j.kind !== "import" && j.kind !== "index").length }), tooltip: tokens };
    default:
      break;
  }
  if (!i.agentsEnabled) return { text: statusText("off"), tooltip: t("agents.off") };
  const waiting = waitingTotal(i.queues);
  return { text: waiting > 0 ? t("statusBar.waiting", { n: fmt(waiting) }) : t("statusBar.upToDate"), tooltip: tokens };
}

export interface StatusBarService {
  update(model: StatusBarModel): void;
  /** The last model shown (for tests and diagnostics). */
  readonly current: StatusBarModel | null;
  dispose(): void;
}

/** The parts of Obsidian's status bar element this module uses. */
export interface StatusBarElement {
  setText(t: string): void;
  setAttr?(k: string, v: string | number | boolean | null): void;
  addClass?(...cls: string[]): void;
  createSpan?(o?: { cls?: string; text?: string }): StatusBarElement;
  addEventListener?(type: string, fn: (e: Event) => void): void;
  removeEventListener?(type: string, fn: (e: Event) => void): void;
}

/**
 * Wraps the element returned by plugin.addStatusBarItem(): a glyph and a text span, button semantics for the
 * keyboard and screen readers, and the tooltip through aria-label (Obsidian shows aria-label as a tooltip). The
 * accessible name carries the visible text too, so a screen reader hears the state and the tokens.
 */
export function createStatusBar(el: StatusBarElement, onClick: () => void): StatusBarService {
  el.addClass?.("cx-status-bar", "mod-clickable");
  el.setAttr?.("role", "button");
  el.setAttr?.("tabindex", "0");
  el.setAttr?.("data-tooltip-position", "top");
  let textEl: StatusBarElement = el;
  if (el.createSpan) {
    const icon = el.createSpan({ cls: "cx-status-bar-icon" });
    try {
      setIcon(icon as unknown as HTMLElement, CORTEX_ICON_ID);
    } catch {
      // The icon is decoration; the text carries the state.
    }
    icon.setAttr?.("aria-hidden", "true");
    textEl = el.createSpan({ cls: "cx-status-bar-text" });
  }
  const click = (): void => onClick();
  const key = (e: Event): void => {
    const k = (e as KeyboardEvent).key;
    if (k === "Enter" || k === " ") {
      e.preventDefault();
      onClick();
    }
  };
  el.addEventListener?.("click", click);
  el.addEventListener?.("keydown", key);
  let current: StatusBarModel | null = null;
  let disposed = false;
  return {
    update(m) {
      if (disposed) return;
      if (current && current.text === m.text && current.tooltip === m.tooltip) return;
      current = m;
      textEl.setText(m.text);
      el.setAttr?.("aria-label", `${m.text}. ${m.tooltip}`);
    },
    get current() {
      return current;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      el.removeEventListener?.("click", click);
      el.removeEventListener?.("keydown", key);
    },
  };
}

/**
 * Keep the status bar in step with the shared store and the settings. Returns a disposer. Also mirrors the
 * settings into the activity slice (paused, the plan caps, unreadable settings), so every surface that reads
 * the activity agrees with the status bar; the runner's budget events report the plan's use.
 */
export function bindStatusBar(status: StatusBarService, shared: SharedStore, settings: SettingsHandle): () => void {
  const mirror = effect(() => {
    const s = settings.signal.value;
    const corrupt = settings.corrupt;
    const a = shared.slices.activity.peek();
    const plan = withCaps(a.plan, planCapsOf(s.agents.planCaps));
    if (a.paused !== s.agents.paused || a.settingsCorrupt !== corrupt || JSON.stringify(a.plan) !== JSON.stringify(plan)) {
      shared.update("activity", { paused: s.agents.paused, settingsCorrupt: corrupt, plan });
    }
  });
  const render = effect(() => {
    const s = settings.signal.value;
    status.update(
      statusBarModel({
        activity: shared.slices.activity.value,
        queues: shared.slices.queues.value,
        firstRunDone: s.general.firstRunDone,
        agentsEnabled: s.agents.enabled,
      }),
    );
  });
  return () => {
    mirror();
    render();
  };
}
