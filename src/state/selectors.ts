/**
 * Pure derivations from state. Owner: E7.
 */
import type { VisibilityParams } from "../shared/protocol/worker";
import type { QueryToken } from "../shared/protocol/worker";
import type { SheetEntry } from "../shared/views";
import type { ActivityState, LookControls, QueueState, UiState, ViewControls } from "./types";

/** The sheet is reduced to a thin vertical tab at its edge (any page or reader but Chart, which folds to its header bar instead). */
export function sheetTabbed(sheet: { open?: boolean; collapsed?: boolean; stack?: readonly SheetEntry[]; index?: number }): boolean {
  if (sheet.open === false || sheet.collapsed !== true || !sheet.stack || sheet.stack.length === 0) return false;
  const top = sheet.stack[sheet.index ?? 0];
  return !!top && !(top.kind === "page" && top.route === "chart");
}

/** What the leaf shows, for every worker call (scope, period, Layers, held arrivals). */
export function visibilityParams(ui: UiState, view: ViewControls): VisibilityParams {
  const l = view.layers;
  return {
    scope: ui.scope,
    period: ui.period,
    notes: l.notes,
    vaultNotes: l.vaultNotes,
    maps: l.maps,
    record: l.record,
    undatedCloud: l.undatedCloud,
    reference: l.reference,
    askHistory: l.askHistory,
    subagents: l.subagents,
    automated: l.automated,
    revealedCount: ui.revealedCount,
  };
}

/** Held arrivals for this leaf ("‹n› new" header pill). */
export function heldArrivals(ui: UiState, available: number): number {
  // revealedCount 0 is the contract's "nothing is held" (a leaf that has no baseline yet shows the whole record).
  if (!(ui.revealedCount > 0)) return 0;
  return Math.max(0, available - ui.revealedCount);
}

/** Work remaining across queues (status bar "Cortex · 1,284 waiting"). */
export function waitingTotal(q: QueueState): number {
  return q.label + q.summaries + q.maps;
}

export type AgentChipState = "organising" | "up-to-date" | "paused" | "capped" | "offline" | "sign-in" | "missing" | "limit" | "unsafe" | "idle";

/** The agent chip / status bar state (CORTEX-UX §5.1, §5.11; engine states per M1). */
export function agentChipState(a: ActivityState): AgentChipState {
  if (a.engine === "auth") return "sign-in";
  if (a.engine === "missing") return "missing";
  if (a.engine === "unsafe") return "unsafe";
  if (a.engine === "offline") return "offline";
  if (a.engine === "limit") return "limit";
  if (a.paused) return "paused";
  if (a.capped) return "capped";
  if (a.jobs.some((j) => j.kind !== "import" && j.kind !== "index")) return "organising";
  return "idle";
}

/** Conversation stems are drawn whenever their strength is above zero. */
export function stemsOn(view: { look: Pick<LookControls, "stemStrength"> }): boolean {
  return view.look.stemStrength > 0;
}

// ───────────────────────────── chart highlights ─────────────────────────────

/** Tokens a chart click adds are ids "chart:..."; every other token (text, Ask sets, the period) is not a highlight. */
export const HIGHLIGHT_PREFIX = "chart:";

export function isHighlightToken(t: Pick<QueryToken, "id">): boolean {
  return t.id.startsWith(HIGHLIGHT_PREFIX);
}

/** The chart highlight tokens among the leaf's tokens. */
export function highlightTokens(ui: Pick<UiState, "tokens">): QueryToken[] {
  return ui.tokens.filter(isHighlightToken);
}

export function highlightCount(ui: Pick<UiState, "tokens">): number {
  return highlightTokens(ui).length;
}

// ───────────────────────────── the rail's lit summary ─────────────────────────────

/** The id of the draft text token the command line keeps while a query is typed (ui/command/Tokens.tsx DRAFT_TOKEN_ID). */
export const DRAFT_TEXT_TOKEN_ID = "draft:text";

/** What the rail's status block says about what is lit. */
export interface LitSummary {
  /** The entries lit now (null until the worker has answered). */
  count: number | null;
  /** The newest thing lit (a month, range, folder, label), or null when only a typed search is lit. */
  where: string | null;
  /** How many other things are lit besides `where`. */
  more: number;
  /** Chart highlight labels picked. */
  labels: number;
  /** A typed search holds the lit set: the block reads "<n> found" and names nothing. */
  found: boolean;
}

/**
 * The rail's status block: how many entries are lit, what lit them, how many highlighted labels are picked. A period, folder
 * or area token, a chart label or a typed query count; with nothing of those lit the block is gone (null).
 */
export function litSummary(ui: Pick<UiState, "tokens">, lit: number | null): LitSummary | null {
  const visible = ui.tokens.filter((k) => k.id !== DRAFT_TEXT_TOKEN_ID);
  const highlights = visible.filter(isHighlightToken);
  const scoped = visible.filter((k) => !isHighlightToken(k) && k.kind !== "text");
  const typed = ui.tokens.some((k) => k.id === DRAFT_TEXT_TOKEN_ID || k.kind === "text");
  if (scoped.length === 0 && highlights.length === 0) {
    return typed ? { count: lit, where: null, more: 0, labels: 0, found: true } : null;
  }
  const named = scoped.length > 0 ? scoped : highlights.slice(-1);
  const newest = scoped.length > 0 ? scoped[scoped.length - 1] : named[0];
  return { count: lit, where: newest?.label ?? null, more: scoped.length > 0 ? scoped.length - 1 : 0, labels: highlights.length, found: false };
}
