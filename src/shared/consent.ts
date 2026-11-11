/**
 * Consent, pure: who may read what, and for how long. No file, no clock of its own, no settings handle.
 *
 *  - Open spaces. Every area, user space and folder starts closed. `consent.openSpaces` names the open ones (area ids and
 *    folder paths); a user space is open when its own `open` flag is set. `effectiveOpenSpaces` flattens both into the one
 *    list of areas and folders that directions trials, exports and grants read (an entry is open when its area, or any
 *    folder above it, is on that list).
 *  - Grants. A grant names a purpose, the spaces it covers, who reads (one model, any model, or an export), a start and an
 *    end day, and an optional limit on how many items may be read. It covers an entry only when the entry's space is both
 *    named by the grant and open. With "Require a grant" on, a model reads nothing a live grant does not cover.
 *  - Read limit. With "Most any item may be read by a model" on, an item that was sent that many times is left out, until the
 *    owner resets that one item.
 *
 * Counting reads (the runner's ReadRecords) and enforcing them (jobs) live in agents/grants.ts.
 */
import type { ConsentGrant, ConsentSettings } from "./settingsExt";
import { localDayKey } from "./time";
import type { EngineKind } from "./types";
import type { UserSpace } from "./userSpaces";

/** The readers a grant can name. "any-model" matches every model engine; "export" is the record export. */
export const READER_IDS = ["any-model", "claude-cli", "codex-cli", "anthropic-api", "local", "export"] as const;
export type ReaderId = (typeof READER_IDS)[number];

/** What actually reads: an engine kind, or an export. The plain-rules engine is not a reader (no model, nothing leaves the code). */
export type Reader = Exclude<EngineKind, "rule"> | "export";

export function isReaderId(s: string): s is ReaderId {
  return (READER_IDS as readonly string[]).includes(s);
}

/** The reader an engine counts as, or null for the plain-rules engine, which no grant is needed for. */
export function readerOfEngine(kind: EngineKind): Reader | null {
  return kind === "rule" ? null : kind;
}

/** True when a grant naming `granted` lets `reader` read. An unknown name matches nothing. */
export function readerMatches(granted: string, reader: Reader): boolean {
  if (reader === "export") return granted === "export";
  if (granted === "any-model") return true;
  return granted === reader;
}

// ───────────────────────────── places ─────────────────────────────

/** Where an item sits: its area and the folder path it was filed under. */
export interface Place {
  space: string;
  folder: readonly string[];
}

const trimSlash = (s: string): string => s.replace(/\/+$/, "");

/** True when the area, or any folder above the item, is on the list. An empty list is nothing. */
export function inList(place: Place, list: readonly string[]): boolean {
  if (list.length === 0) return false;
  const set = new Set(list.map(trimSlash));
  if (set.has(place.space)) return true;
  for (let i = place.folder.length; i > 0; i--) if (set.has(place.folder.slice(0, i).join("/"))) return true;
  return false;
}

/** A user space's members as the areas-and-folders list. */
export function membersOf(space: Pick<UserSpace, "areas" | "folders">): string[] {
  return [...space.areas, ...space.folders.map(trimSlash)];
}

/** Names in a list that are user-space ids become that space's areas and folders; everything else stays as it is. */
export function expandSpaces(tokens: readonly string[], userSpaces: readonly UserSpace[]): string[] {
  const out = new Set<string>();
  for (const t of tokens) {
    const sp = userSpaces.find((u) => u.id === t);
    if (sp) for (const m of membersOf(sp)) out.add(m);
    else out.add(trimSlash(t));
  }
  return [...out];
}

/** The areas and folders that are open: the owner's list, plus the members of every user space marked open. */
export function effectiveOpenSpaces(consent: Pick<ConsentSettings, "openSpaces"> | undefined, userSpaces: readonly UserSpace[] = []): string[] {
  const out = new Set<string>(expandSpaces(consent?.openSpaces ?? [], userSpaces));
  for (const sp of userSpaces) if (sp.open === true) for (const m of membersOf(sp)) out.add(m);
  return [...out];
}

/** True when the item is in an open space. */
export function isOpenPlace(place: Place, consent: Pick<ConsentSettings, "openSpaces"> | undefined, userSpaces: readonly UserSpace[] = []): boolean {
  return inList(place, effectiveOpenSpaces(consent, userSpaces));
}

// ───────────────────────────── grants ─────────────────────────────

export type GrantState = "live" | "revoked" | "expired" | "upcoming" | "used-up";

/** Items read under a grant so far: what the settings hold, or what the read log counts, whichever is more. */
export function grantUsed(g: Pick<ConsentGrant, "reads">, counted: number): number {
  return Math.max(g.reads, counted);
}

export function grantState(g: ConsentGrant, today: string, used: number): GrantState {
  if (g.revoked) return "revoked";
  if (today < g.start) return "upcoming";
  if (today > g.end) return "expired";
  if (g.readLimit > 0 && used >= g.readLimit) return "used-up";
  return "live";
}

/** The grants that are in force today for a reader (state "live" and the reader named). */
export function liveGrants(consent: Pick<ConsentSettings, "grants">, reader: Reader, today: string, counted: ReadonlyMap<string, number> = new Map()): ConsentGrant[] {
  return consent.grants.filter((g) => readerMatches(g.reader, reader) && grantState(g, today, grantUsed(g, counted.get(g.id) ?? 0)) === "live");
}

/** True when this grant covers the place: named by the grant, and open. */
export function grantCovers(g: Pick<ConsentGrant, "spaces">, place: Place, consent: Pick<ConsentSettings, "openSpaces">, userSpaces: readonly UserSpace[]): boolean {
  return inList(place, expandSpaces(g.spaces, userSpaces)) && isOpenPlace(place, consent, userSpaces);
}

/** The grant id for a new grant: `g-` plus the day and a counter, never reused (revoked grants stay listed). */
export function newGrantId(existing: readonly Pick<ConsentGrant, "id">[], day: string): string {
  const taken = new Set(existing.map((g) => g.id));
  const base = `g-${day.replace(/-/g, "")}`;
  for (let n = 1; n < 1000; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
  return `${base}-${taken.size + 1}`;
}

export const GRANT_LIMITS = { purposeMin: 3, days: [1, 365], reads: [0, 100_000] } as const;

export interface GrantDraft {
  purpose: string;
  spaces: readonly string[];
  reader: string;
  /** First day (yyyy-mm-dd). */
  start: string;
  /** Number of days it lasts, counting the first. */
  days: number;
  /** 0 = no limit. */
  readLimit: number;
}

export type GrantProblem = "purpose" | "spaces" | "reader" | "closed" | "days" | "start";

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return localDayKey(new Date(y, m - 1, d + n, 12).getTime());
}

/** Check a draft and build the grant, or say what is wrong. Spaces that are not open cannot be granted. */
export function makeGrant(draft: GrantDraft, existing: readonly ConsentGrant[], open: readonly string[], userSpaces: readonly UserSpace[]): { ok: true; grant: ConsentGrant } | { ok: false; problem: GrantProblem } {
  const purpose = draft.purpose.replace(/\s+/g, " ").trim().slice(0, 200);
  if ([...purpose].length < GRANT_LIMITS.purposeMin) return { ok: false, problem: "purpose" };
  if (!isReaderId(draft.reader)) return { ok: false, problem: "reader" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.start)) return { ok: false, problem: "start" };
  if (!Number.isInteger(draft.days) || draft.days < GRANT_LIMITS.days[0] || draft.days > GRANT_LIMITS.days[1]) return { ok: false, problem: "days" };
  const spaces = [...new Set(draft.spaces.map((s) => s.trim()).filter((s) => s !== ""))];
  if (spaces.length === 0) return { ok: false, problem: "spaces" };
  // Every named space must be open: a grant can use only what the owner opened.
  const expanded = (s: string): string[] => expandSpaces([s], userSpaces);
  const isOpen = (m: string): boolean => inList({ space: m, folder: m.split("/") }, open);
  if (!spaces.every((s) => expanded(s).length > 0 && expanded(s).every(isOpen))) return { ok: false, problem: "closed" };
  const readLimit = Number.isFinite(draft.readLimit) ? Math.min(GRANT_LIMITS.reads[1], Math.max(0, Math.round(draft.readLimit))) : 0;
  return {
    ok: true,
    grant: { id: newGrantId(existing, draft.start), purpose, spaces, reader: draft.reader, start: draft.start, end: addDays(draft.start, draft.days - 1), reads: 0, readLimit, revoked: false },
  };
}

/** Revoke a grant. It stays listed (its dates and reads are history); it simply grants nothing. */
export function revokeGrant(consent: Pick<ConsentSettings, "grants">, id: string): boolean {
  const g = consent.grants.find((x) => x.id === id);
  if (!g || g.revoked) return false;
  g.revoked = true;
  return true;
}

// ───────────────────────────── read limit ─────────────────────────────

/** The limit in force: null when "Most any item may be read by a model" is off. */
export function itemLimit(consent: Pick<ConsentSettings, "itemReadLimit">): number | null {
  return consent.itemReadLimit.enabled ? consent.itemReadLimit.max : null;
}

/** "read 3 of 3": reads since the owner's reset for that item, against the limit. `reads` are ISO times of each read. */
export function readsSince(reads: readonly string[], resetAt: string | undefined): number {
  return resetAt === undefined ? reads.length : reads.filter((at) => at > resetAt).length;
}

export function atLimit(count: number, limit: number | null): boolean {
  return limit !== null && count >= limit;
}

/** Reset one item: reads before this moment stop counting. */
export function resetItem(consent: ConsentSettings, entryId: string, at: string): void {
  const resets = (consent.readResets ??= {});
  resets[entryId] = at;
  const keys = Object.keys(resets);
  // Bounded like every stored list: the oldest resets go first.
  if (keys.length > RESET_MAX) for (const k of keys.sort((a, b) => ((resets[a] ?? "") < (resets[b] ?? "") ? -1 : 1)).slice(0, keys.length - RESET_MAX)) delete resets[k];
}

export const RESET_MAX = 1000;

// ───────────────────────────── the record's own account of a change ─────────────────────────────

export type ConsentChange =
  | { kind: "grant-added"; grant: ConsentGrant }
  | { kind: "grant-revoked"; grant: ConsentGrant }
  | { kind: "spaces-opened"; spaces: readonly string[] }
  | { kind: "spaces-closed"; spaces: readonly string[] }
  | { kind: "nothing-open" }
  | { kind: "require-grant"; on: boolean }
  | { kind: "read-limit"; on: boolean; max: number }
  | { kind: "item-reset"; id: string };

/** Which areas, spaces and folders are open or closed in a changed list: the ones that differ. */
export function diffSpaces(before: readonly string[], after: readonly string[]): { opened: string[]; closed: string[] } {
  const b = new Set(before);
  const a = new Set(after);
  return { opened: after.filter((x) => !b.has(x)), closed: before.filter((x) => !a.has(x)) };
}

// ───────────────────────────── what the read log says (runner answer) ─────────────────────────────

/** Items most often sent to a model, and what each grant has used. Counts only: never text. */
export interface ConsentReads {
  /** The read limit in force (null = off). */
  limit: number | null;
  /** Grant id -> items read under it. */
  grants: Record<string, number>;
  /** The most-read items, most first: id, times sent since its reset, and a short label (a title, never text). */
  items: { id: string; n: number; label: string }[];
  /** Every item at the limit (up to 2000 ids), for the "at limit" filter. */
  atLimit: string[];
}
