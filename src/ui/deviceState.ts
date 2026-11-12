/**
 * Per-device UI state (CORTEX-UX §5.2, §5.28, §12.2): one-time hints and the first-run checklist. Stored with
 * `app.saveLocalStorage("cortex:hints")`: per device and per vault, never synced by OneDrive, never in
 * settings. "Cortex: Reset hints" clears the hints (the checklist is untouched). Owner: E11. Pure and light: the
 * eager command dispatcher imports `resetHints`.
 */
import type { App } from "obsidian";

/** One hint per surface, shown once, never stacked (the newest wins). */
export type HintId = "stage" | "strip" | "shape" | "compass" | "command" | "conversation";
export const HINT_IDS: readonly HintId[] = ["stage", "strip", "shape", "compass", "command", "conversation"];

/** Checklist items that tick themselves off from real actions. */
export type ChecklistStep = "add-source" | "open-frond" | "ask-question";
export const CHECKLIST_STEPS: readonly ChecklistStep[] = ["add-source", "open-frond", "ask-question"];

export interface DeviceState {
  v: 1;
  hintsSeen: HintId[];
  checklist: Record<ChecklistStep, boolean>;
  /** "Hide checklist" from the banner-slot card's menu. */
  checklistHidden: boolean;
  /** The walkthrough was offered (and answered, or taken) on this device: never offered again on its own. */
  tourSeen: boolean;
  /** Hover tooltip on this device: the multi-line "card" or the single "line" (default). */
  tooltipStyle: TooltipStyle;
  /** The Chart page's "Colour by area" offer was taken or dismissed: not offered again on this device. */
  chartAreaOfferDismissed?: boolean;
  /** Collapsible reader sections left open or closed on this device, by section id. */
  sectionsOpen?: Record<string, boolean>;
  /** The Display popover shows every section (off: the short list of four controls). */
  displayExpanded?: boolean;
  /** Cortex Desktop: "Fewer options" was pressed, so the Display panel hides Show, Motion and the extra sections (it opens with every section, as in the reference). */
  displayCompact?: boolean;
  /** The key popover's usage tips are hidden on this device. */
  keyTipsHidden?: boolean;
}

export type TooltipStyle = "card" | "line";

/** Open or closed state of a collapsible reader section, by section id (absent = the section's own default). */
export function sectionOpen(s: Pick<DeviceState, "sectionsOpen">, id: string, fallback: boolean): boolean {
  const v = s.sectionsOpen?.[id];
  return typeof v === "boolean" ? v : fallback;
}

export function setSectionOpen(s: DeviceState, id: string, open: boolean): DeviceState {
  if (s.sectionsOpen?.[id] === open) return s;
  return { ...s, sectionsOpen: { ...(s.sectionsOpen ?? {}), [id]: open } };
}

/** The Display popover opens compact until "All controls" is chosen; the choice is remembered on this device. */
export function displayExpanded(s: Pick<DeviceState, "displayExpanded">): boolean {
  return s.displayExpanded === true;
}

export function setDisplayExpanded(s: DeviceState, on: boolean): DeviceState {
  if (displayExpanded(s) === on) return s;
  return { ...s, displayExpanded: on };
}

/** Cortex Desktop's short Display panel (Fewer options pressed); the panel opens with every section otherwise. */
export function displayCompactOn(s: Pick<DeviceState, "displayCompact">): boolean {
  return s.displayCompact === true;
}

export function setDisplayCompact(s: DeviceState, on: boolean): DeviceState {
  if (displayCompactOn(s) === on) return s;
  return { ...s, displayCompact: on };
}

/** The key popover shows its usage tips unless this device hid them. */
export function keyTipsShown(s: Pick<DeviceState, "keyTipsHidden">): boolean {
  return s.keyTipsHidden !== true;
}

export function setKeyTipsShown(s: DeviceState, on: boolean): DeviceState {
  if (keyTipsShown(s) === on) return s;
  const { keyTipsHidden: _drop, ...rest } = s;
  return on ? rest : { ...rest, keyTipsHidden: true };
}

export const DEVICE_KEY = "cortex:hints";

export function emptyDeviceState(): DeviceState {
  return { v: 1, hintsSeen: [], checklist: { "add-source": false, "open-frond": false, "ask-question": false }, checklistHidden: false, tourSeen: false, tooltipStyle: "line" };
}

export function isHintId(x: unknown): x is HintId {
  return typeof x === "string" && (HINT_IDS as readonly string[]).includes(x);
}

export function isChecklistStep(x: unknown): x is ChecklistStep {
  return typeof x === "string" && (CHECKLIST_STEPS as readonly string[]).includes(x);
}

/** Defensive parse: unknown or malformed content starts fresh (hints are harmless to repeat). */
export function parseDeviceState(raw: unknown): DeviceState {
  const out = emptyDeviceState();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.hintsSeen)) out.hintsSeen = [...new Set(r.hintsSeen.filter(isHintId))];
  const list = r.checklist;
  if (typeof list === "object" && list !== null && !Array.isArray(list)) {
    for (const k of CHECKLIST_STEPS) out.checklist[k] = (list as Record<string, unknown>)[k] === true;
  }
  out.checklistHidden = r.checklistHidden === true;
  out.tourSeen = r.tourSeen === true;
  if (r.chartAreaOfferDismissed === true) out.chartAreaOfferDismissed = true;
  out.tooltipStyle = r.tooltipStyle === "card" ? "card" : "line";
  if (r.displayExpanded === true) out.displayExpanded = true;
  if (r.displayCompact === true) out.displayCompact = true;
  if (r.keyTipsHidden === true) out.keyTipsHidden = true;
  const open = r.sectionsOpen;
  if (typeof open === "object" && open !== null && !Array.isArray(open)) {
    const kept: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(open as Record<string, unknown>)) if (typeof v === "boolean" && k.length <= 80) kept[k] = v;
    if (Object.keys(kept).length > 0) out.sectionsOpen = kept;
  }
  return out;
}

type LocalStorageApp = Pick<App, "loadLocalStorage" | "saveLocalStorage">;

export function loadDeviceState(app: LocalStorageApp): DeviceState {
  try {
    return parseDeviceState(app.loadLocalStorage(DEVICE_KEY));
  } catch {
    return emptyDeviceState();
  }
}

export function saveDeviceState(app: LocalStorageApp, s: DeviceState): void {
  try {
    app.saveLocalStorage(DEVICE_KEY, s);
  } catch {
    // Local storage can be unavailable (private profile): hints simply show again.
  }
}

export function markHintSeen(s: DeviceState, h: HintId): DeviceState {
  return s.hintsSeen.includes(h) ? s : { ...s, hintsSeen: [...s.hintsSeen, h] };
}

export function hintSeen(s: DeviceState, h: HintId): boolean {
  return s.hintsSeen.includes(h);
}

export function tickChecklist(s: DeviceState, step: ChecklistStep): DeviceState {
  return s.checklist[step] ? s : { ...s, checklist: { ...s.checklist, [step]: true } };
}

/** "Cortex: Reset hints": every hint shows again; the checklist keeps what you did. */
export function resetHints(s: DeviceState): DeviceState {
  return s.hintsSeen.length === 0 ? s : { ...s, hintsSeen: [] };
}

/** "Hide checklist" in the banner-slot card's menu. */
export function hideChecklist(s: DeviceState): DeviceState {
  return s.checklistHidden ? s : { ...s, checklistHidden: true };
}

/** The tour was offered or taken: stop offering it. */
export function markTourSeen(s: DeviceState): DeviceState {
  return s.tourSeen ? s : { ...s, tourSeen: true };
}

/** The Chart page's "Colour by area" offer was taken or dismissed. */
export function dismissChartAreaOffer(s: DeviceState): DeviceState {
  return s.chartAreaOfferDismissed ? s : { ...s, chartAreaOfferDismissed: true };
}

export function checklistComplete(s: DeviceState, steps: readonly ChecklistStep[] = CHECKLIST_STEPS): boolean {
  return steps.every((k) => s.checklist[k]);
}
