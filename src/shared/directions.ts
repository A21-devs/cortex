/**
 * Direction trials, the parts the plugin UI shares with the runner (no prompt text here, so the plugin bundle stays small):
 * request normalisation, the limits, the "direction" Checks card, and the directions you accepted. See agents/directions.ts.
 */
import { injectionSignals } from "./mdSafe";
import { undoneIds } from "./correctionsFold";
import type { CorrectionRecord, DirectionArm } from "./types";

export const DIRECTION_ARMS: readonly DirectionArm[] = ["record", "placebo", "none"];

export const PURPOSE_MIN = 6;
export const PURPOSE_MAX = 400;
/** Directions asked for per run, and the most kept from a reply. */
export const DIRECTIONS_ASKED = "3 to 5";
export const DIRECTIONS_MAX = 5;
export const DIRECTION_MIN_CHARS = 8;
export const DIRECTION_MAX_CHARS = 200;
export interface DirectionsRequest {
  purpose: string;
  arms: DirectionArm[];
}

/** Collapse whitespace and control characters (a purpose and a direction are single lines everywhere). */
export function oneLine(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

/** The purpose as sent: one line, 6 to 400 characters. Null when it is not usable. */
export function normalisePurpose(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const p = oneLine(raw);
  const n = [...p].length;
  return n >= PURPOSE_MIN && n <= PURPOSE_MAX ? p : null;
}

/** A well-formed request (a purpose and at least one distinct known arm, in the fixed order), or null. */
export function normaliseRequest(raw: unknown): DirectionsRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { purpose?: unknown; arms?: unknown };
  const purpose = normalisePurpose(r.purpose);
  if (purpose === null || !Array.isArray(r.arms)) return null;
  const arms = DIRECTION_ARMS.filter((a) => (r.arms as unknown[]).includes(a));
  return arms.length > 0 ? { purpose, arms } : null;
}

/** Strip a leading list marker a model sometimes adds ("- ", "1. ", "• "). */
export function bare(s: string): string {
  return s.replace(/^\s*(?:[-*•–]|\d{1,2}[.)])\s+/, "");
}

/** One direction as stored or edited: a single plain line of 8 to 200 characters with no injection signal, or null. */
export function cleanDirection(raw: unknown): string | null {
  if (typeof raw !== "string" || injectionSignals(raw).length > 0) return null;
  const text = bare(oneLine(raw));
  const n = [...text].length;
  return n >= DIRECTION_MIN_CHARS && n <= DIRECTION_MAX_CHARS ? text : null;
}

// ───────────────────────────── the Checks card ─────────────────────────────

/** What a "direction" Checks card proposes (ReviewCardRecord.proposal). */
export interface DirectionCardProposal {
  kind: "direction";
  purpose: string;
  arm: DirectionArm;
  text: string;
  /** Passage ids the model said it built on (record arm: entry ids). */
  from?: string[];
}

/** A direction you accepted, from the corrections log: the text as you left it. */
export interface AcceptedDirection {
  cardId: string;
  text: string;
  at: string;
}

const CHECK_TAG = /^check:([^:]+):(\w+)/;

/** Directions accepted through Checks (confirm, or confirm after an edit), newest first; an undone answer drops out. */
export function acceptedDirections(records: readonly CorrectionRecord[]): AcceptedDirection[] {
  const undone = undoneIds(records);
  const out: AcceptedDirection[] = [];
  for (const r of records) {
    if (r.action !== "confirm" || undone.has(r.id) || r.undoes !== undefined) continue;
    const m = r.reason ? CHECK_TAG.exec(r.reason) : null;
    const text = (r.payload as { text?: unknown }).text;
    if (!m || m[1] !== r.target || typeof text !== "string" || text.length === 0) continue;
    out.push({ cardId: r.target, text, at: r.at });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
