/**
 * View-scoped keyboard map (CORTEX-UX §8.1). Owner: E11.
 *
 * The view sets `this.scope = new Scope(this.app.scope)` and the UI registers these keys there
 * (registerKeymap), so they apply only while focus is inside Cortex and never override Obsidian's global hotkeys;
 * every action also exists as an Obsidian command (§8.2). Obsidian's Scope matches modifiers exactly and returns
 * the first matching handler's result: a handler returns `false` when it handled the key (Obsidian then calls
 * preventDefault) and `true` when it declines (the key reaches the focused field untouched). Letters register in
 * upper case so they also match by virtual key on non-Latin layouts.
 *
 * "?", "/" and single letters are ignored while focus is in a text field; Space and Enter are ignored while focus
 * is on a control (a focused button keeps its own Space). Esc runs the ladder of §8.1: the topmost hint, popover,
 * console or sheet, then the input, then the tokens, then the selection.
 */
import type { Scope } from "obsidian";
import type { CommandId } from "../plugin/commands";
import type { CortexServices, LeafServices } from "../plugin/services";
import { featureOn } from "../shared/features";
import { SPACE_ORDER } from "../shared/index-format";
import type { Pose } from "../shared/settings";
import type { PageId, ShapeKind } from "../shared/views";
import * as A from "../state/actions";
import type { CortexStore } from "../state/store";
import type { Selection, UiState } from "../state/types";
import { pendingCopy, type Shell } from "./context";
import { chartCardAside, chartCardFits, sheetPair } from "./breakpoints";

export type Modifier = "Mod" | "Shift" | "Alt";

export type KeyAction =
  | CommandId
  | "toggle-motion"
  | "focus-find"
  | "focus-ask"
  | "next-shape"
  | "names"
  | "lines"
  | "open-page"
  | "sheet-back"
  | "sheet-forward"
  | "undo"
  | "redo"
  | "chart-page"
  | "guide";

export interface KeyBinding {
  modifiers: Modifier[];
  key: string;
  /** A §8.2 command, or a view-only action. */
  action: KeyAction;
  /** For open-page: 1–5 → Brain, Read, Time, Agents, Sources. */
  arg?: string;
  /** Not handled while a text field has focus. */
  notInText?: boolean;
  /** Not handled while a button-like control has focus (it keeps its own Space / Enter). */
  notOnControl?: boolean;
}

export const KEYMAP: readonly KeyBinding[] = [
  { modifiers: ["Mod"], key: "k", action: "focus-find" },
  { modifiers: [], key: "/", action: "focus-find", notInText: true },
  { modifiers: ["Mod", "Shift"], key: "k", action: "focus-ask" },
  { modifiers: [], key: " ", action: "toggle-motion", notInText: true, notOnControl: true },
  { modifiers: [], key: "h", action: "home-view", notInText: true },
  { modifiers: [], key: "f", action: "frame-selection", notInText: true },
  { modifiers: [], key: "o", action: "display", notInText: true },
  { modifiers: [], key: "c", action: "chart-page", notInText: true },
  { modifiers: [], key: "g", action: "next-shape", notInText: true },
  { modifiers: [], key: "l", action: "names", notInText: true },
  { modifiers: [], key: "k", action: "lines", notInText: true },
  { modifiers: [], key: "i", action: "toggle-immersive", notInText: true },
  { modifiers: [], key: "?", action: "guide", notInText: true },
  { modifiers: [], key: "[", action: "previous-area", notInText: true },
  { modifiers: [], key: "]", action: "next-area", notInText: true },
  ...["1", "2", "3", "4", "5"].map((n): KeyBinding => ({ modifiers: ["Alt"], key: n, action: "open-page", arg: n })),
  { modifiers: ["Alt"], key: "ArrowLeft", action: "sheet-back" },
  { modifiers: ["Alt"], key: "ArrowRight", action: "sheet-forward" },
  { modifiers: ["Mod"], key: "z", action: "undo", notInText: true },
  { modifiers: ["Mod", "Shift"], key: "z", action: "redo", notInText: true },
];

/** Alt 1 … Alt 5. */
export const PAGE_BY_DIGIT = { "1": "brain", "2": "read", "3": "time", "4": "agents", "5": "sources" } as const satisfies Record<string, PageId>;

/** Keys that must stay free for Obsidian (checked by tests): Ctrl 1–8 tab switching is never bound. */
export function conflictsWithObsidian(b: KeyBinding): boolean {
  return b.modifiers.length === 1 && b.modifiers[0] === "Mod" && /^[1-8]$/.test(b.key);
}

/** Printable keys that are not letters or digits: their Shift (and AltGr) state belongs to the layout. */
function isSymbolKey(key: string): boolean {
  return key.length === 1 && !/[a-z0-9 ]/i.test(key);
}

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** AltGr on Windows arrives as Ctrl + Alt; symbol keys typed with it count as unmodified. */
  altGraph?: boolean;
}

/** Find the binding for a keyboard event. */
export function bindingFor(e: KeyEventLike, inText: boolean): KeyBinding | undefined {
  const symbol = isSymbolKey(e.key);
  const altGr = symbol && (e.altGraph === true || (e.ctrlKey && e.altKey && !e.metaKey));
  const mod = !altGr && (e.ctrlKey || e.metaKey);
  const alt = !altGr && e.altKey;
  return KEYMAP.find((b) => {
    if (b.notInText && inText) return false;
    const want = new Set(b.modifiers);
    if (want.has("Mod") !== mod || want.has("Alt") !== alt) return false;
    if (!symbol && want.has("Shift") !== e.shiftKey) return false;
    return b.key.toLowerCase() === e.key.toLowerCase();
  });
}

/** Obsidian Scope registrations for a binding: [modifiers, key] pairs (deduplicated by registerKeymap). */
export function scopeRegistrations(b: KeyBinding): [Modifier[] | ("Ctrl" | "Alt" | "Shift")[], string][] {
  const key = /^[a-z]$/.test(b.key) ? b.key.toUpperCase() : b.key;
  if (!isSymbolKey(b.key)) return [[b.modifiers, key]];
  // Layout variants: "?" is Shift + "/" on US and UK keyboards, "/" is Shift + 7 on German ones, AltGr = Ctrl + Alt.
  return [
    [b.modifiers, key],
    [[...b.modifiers, "Shift"], key],
    [["Ctrl", "Alt"], key],
  ];
}

interface ElementLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?(name: string): string | null;
  closest?(selector: string): unknown;
  type?: string;
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number", "date", "time", "datetime-local", "month", "week"]);

/** True when focus is in something that takes typed text. */
export function isTextTarget(target: unknown): boolean {
  const el = target as ElementLike | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") return TEXT_INPUT_TYPES.has((el.type ?? "text").toLowerCase());
  if (el.isContentEditable === true) return true;
  const role = el.getAttribute?.("role");
  return role === "textbox" || role === "combobox" || role === "searchbox";
}

/** True when focus is on a control that handles Space / Enter itself. */
export function isControlTarget(target: unknown): boolean {
  const el = target as ElementLike | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "button" || tag === "a" || tag === "summary" || tag === "input" || tag === "select" || tag === "textarea") return true;
  const role = el.getAttribute?.("role") ?? "";
  return ["button", "switch", "tab", "radio", "checkbox", "slider", "menuitem", "option", "separator", "link"].includes(role);
}

// ───────────────────────────── Esc ladder ─────────────────────────────

export type EscapeStep = "hint" | "replay" | "popover" | "immersive" | "console" | "results" | "reader" | "sheet" | "input" | "tokens" | "selection" | null;

/** What Esc does next (§8.1): the topmost overlay, then the input, the tokens and the selection. */
export function escapeStep(ui: UiState, selection: Selection, extra: { hint: boolean; shapeOpen: boolean; replay?: boolean; width?: number }): EscapeStep {
  if (extra.hint) return "hint";
  if (extra.replay) return "replay";
  if (ui.popover !== null || extra.shapeOpen) return "popover";
  if (ui.immersive) return "immersive";
  if (ui.command.consoleOpen) return "console";
  if (ui.command.resultsOpen) return "results";
  // Two columns: the reader that has the second column closes first, the page stays.
  if (ui.sheet.open && sheetPair(ui, extra.width || undefined) !== null) return "reader";
  if (ui.sheet.open) return "sheet";
  if (ui.command.text.length > 0) return "input";
  if (ui.tokens.length > 0) return "tokens";
  if (selection !== null) return "selection";
  return null;
}

export function runEscape(store: CortexStore, shell: Shell): boolean {
  const ui = store.get("ui");
  const step = escapeStep(ui, store.get("selection"), { hint: shell.hint.value !== null, shapeOpen: shell.shapeOpen.value, replay: shell.stopReplay !== null, width: shell.size.value.width });
  switch (step) {
    case "hint":
      shell.hint.value = null;
      return true;
    case "replay":
      shell.stopReplay?.();
      return true;
    case "popover":
      shell.shapeOpen.value = false;
      if (ui.popover !== null) store.update("ui", { popover: null });
      return true;
    case "immersive":
      A.toggleImmersive(store);
      return true;
    case "console":
      store.update("ui", (u) => ({ ...u, command: { ...u.command, consoleOpen: false, consolePinned: false } }));
      return true;
    case "results":
      store.update("ui", (u) => ({ ...u, command: { ...u.command, resultsOpen: false } }));
      return true;
    case "reader":
      A.closeReader(store);
      return true;
    case "sheet":
      A.closeSheet(store);
      return true;
    case "input":
      store.update("ui", (u) => ({ ...u, command: { ...u.command, text: "", resultsOpen: false } }));
      return true;
    case "tokens":
      A.clearTokens(store);
      return true;
    case "selection":
      A.clearSelection(store);
      return true;
    default:
      return false;
  }
}

// ───────────────────────────── actions ─────────────────────────────

export interface KeyContext {
  services: CortexServices;
  leaf: LeafServices;
  shell: Shell;
}

/** The motion a pose starts with: Spin standing (default), Drift lying (§5.6, figure brief). */
export function motionModeFor(pose: Pose): "spin" | "drift" {
  return pose === "lying" ? "drift" : "spin";
}

/** The shape on screen: the target once the morph is past halfway, otherwise the body. */
export function shownShape(shape: ShapeKind, morph: number): ShapeKind {
  return shape !== "body" && morph >= 0.5 ? shape : "body";
}

/** Focus the command line's input (Find or Ask) after the next render. */
export function focusCommandLine(shell: Shell): void {
  const go = () => {
    const el = shell.root?.querySelector<HTMLElement>(".cx-command input, .cx-command textarea, .cx-command [contenteditable='true']");
    el?.focus();
  };
  const raf = (shell.win as Partial<Window>).requestAnimationFrame;
  if (typeof raf === "function") raf.call(shell.win, go);
  else setTimeout(go, 0);
}

/** Toggle the Chart page: closes it when it is the sheet's current entry. */
export function toggleChartPage(store: CortexStore): void {
  const sheet = store.get("ui").sheet;
  const top = sheet.open ? sheet.stack[sheet.index] : undefined;
  const ui = store.get("ui");
  if (top?.kind === "page" && top.route === "chart") A.closeSheet(store);
  else if (chartCardAside(ui)) A.closeChartCard(store);
  else {
    // The page brings the chart up itself; closing it then returns the figure to the brain (unless a chart or groups were already out).
    const v = store.get("view");
    A.markChartOpenedByPage(store, !(v.shape !== "body" && v.morph >= 0.5));
    // With a page open the Chart card comes up beside it instead of replacing it.
    if (chartCardFits(ui)) A.keepChartCard(store);
    else A.openPage(store, "chart");
  }
}

export async function undoLast(ctx: KeyContext): Promise<void> {
  const receipts = ctx.services.shared.get("receipts").filter((r) => r.canUndo && r.state === "applied");
  const last = receipts[receipts.length - 1];
  const lastAt = last ? Date.parse(last.at) : Number.NEGATIVE_INFINITY;
  const local = ctx.shell.latestUndo();
  if (local && (!last || local.at >= lastAt)) {
    ctx.shell.runUndo(local.id);
    return;
  }
  if (!last) return;
  try {
    await ctx.services.assistant.undo(last.id);
  } catch (e) {
    ctx.services.log.warn("undo failed", { error: String(e) });
    ctx.shell.toast({ kind: "error", text: pendingCopy("undoFailed"), sticky: true });
  }
}

export async function redoLast(ctx: KeyContext): Promise<void> {
  try {
    await ctx.services.assistant.redo();
  } catch (e) {
    ctx.services.log.warn("redo failed", { error: String(e) });
  }
}

/**
 * Run a key action on this leaf. Returns false when the action does not apply here (its feature is not shipped,
 * or there is nothing to act on), so the key can pass through.
 */
export function runKeyAction(action: KeyAction, arg: string | undefined, ctx: KeyContext, animateMorph?: (to: number) => void): boolean {
  const store = ctx.leaf.store;
  const bus = ctx.services.bus;
  const viewId = ctx.leaf.viewId;
  const v = store.get("view");
  switch (action) {
    case "focus-find":
      A.setCommandMode(store, "find");
      focusCommandLine(ctx.shell);
      return true;
    case "focus-ask":
      if (!featureOn("ask")) return false;
      A.setCommandMode(store, "ask");
      focusCommandLine(ctx.shell);
      return true;
    case "toggle-motion":
      A.setMotion(store, { mode: v.motion.mode === "off" ? motionModeFor(v.pose) : "off" });
      return true;
    case "home-view":
      bus.emit("camera:fly-to", { viewId, home: true });
      return true;
    case "frame-selection": {
      const sel = store.get("selection");
      if (!sel) return false;
      bus.emit("camera:fly-to", { viewId, ordinal: sel.ordinal });
      return true;
    }
    case "display":
      A.openPopover(store, "display");
      return true;
    case "chart-page":
    case "toggle-chart":
      if (!featureOn("chartPage")) return false;
      toggleChartPage(store);
      return true;
    case "next-shape": {
      const next = A.nextShape(shownShape(v.shape, v.morph), featureOn("chartShape"));
      const go = animateMorph ?? ((to: number) => A.setMorph(store, to));
      if (next === "body") go(0);
      else {
        A.setShape(store, next);
        go(1);
      }
      return true;
    }
    case "names":
      A.setLook(store, { names: v.look.names === "always" ? "hover" : "always" });
      return true;
    case "lines":
      if (!featureOn("lines")) return false;
      A.setLook(store, { lines: v.look.lines === "all" ? "selection" : "all" });
      return true;
    case "toggle-immersive":
      A.toggleImmersive(store);
      return true;
    case "guide":
      if (!featureOn("guide")) return false;
      A.openPage(store, "guide");
      return true;
    case "previous-area":
    case "next-area":
      A.setScope(store, A.stepScope(SPACE_ORDER, store.get("ui").scope, action === "next-area" ? 1 : -1));
      return true;
    case "open-page": {
      const page = arg ? (PAGE_BY_DIGIT as Record<string, PageId>)[arg] : undefined;
      if (!page) return false;
      A.openTab(store, page);
      return true;
    }
    case "sheet-back":
      if (store.get("ui").sheet.index <= 0) return false;
      A.sheetBack(store);
      return true;
    case "sheet-forward": {
      const s = store.get("ui").sheet;
      if (s.index >= s.stack.length - 1) return false;
      A.sheetForward(store);
      return true;
    }
    case "undo":
      void undoLast(ctx);
      return true;
    case "redo":
      void redoLast(ctx);
      return true;
    default:
      return false;
  }
}

/** Handle one key event from the view's Scope. Returns Obsidian's convention: false = handled. */
export function handleScopeKey(evt: KeyboardEvent, ctx: KeyContext, animateMorph?: (to: number) => void): boolean {
  if (evt.isComposing) return true;
  const target = evt.target;
  const inText = isTextTarget(target);
  if (evt.key === "Escape") {
    if (inText) return true;
    return runEscape(ctx.leaf.store, ctx.shell) ? false : true;
  }
  const altGraph = typeof evt.getModifierState === "function" ? evt.getModifierState("AltGraph") : false;
  const b = bindingFor({ key: evt.key, ctrlKey: evt.ctrlKey, metaKey: evt.metaKey, shiftKey: evt.shiftKey, altKey: evt.altKey, altGraph }, inText);
  if (!b) return true;
  if (b.notOnControl && isControlTarget(target)) return true;
  return runKeyAction(b.action, b.arg, ctx, animateMorph) ? false : true;
}

/** Register every binding (and Esc) on the view's Scope; returns an unregister function. */
export function registerKeymap(scope: Scope, ctx: KeyContext, animateMorph?: (to: number) => void): () => void {
  const seen = new Set<string>();
  const handlers: ReturnType<Scope["register"]>[] = [];
  const handler = (evt: KeyboardEvent): boolean => handleScopeKey(evt, ctx, animateMorph);
  const add = (mods: string[], key: string) => {
    const id = `${[...mods].sort().join("+")}|${key}`;
    if (seen.has(id)) return;
    seen.add(id);
    handlers.push(scope.register(mods as Parameters<Scope["register"]>[0], key, handler));
  };
  for (const b of KEYMAP) for (const [mods, key] of scopeRegistrations(b)) add(mods, key);
  add([], "Escape");
  return () => {
    for (const h of handlers) {
      try {
        scope.unregister(h);
      } catch {
        // The scope may already be gone with its view.
      }
    }
  };
}
