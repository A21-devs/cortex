/**
 * Your own spaces: a name you choose, the areas and folders it gathers, and an optional look (a colour theme and a
 * data palette). They sit beside the ten fixed areas (shared/spaces.ts, which this file leaves alone): the wordmark and
 * the space cycle list them after the areas, choosing one lights its members on the figure and shows its look as a
 * temporary preview, and Settings > General edits the list.
 *
 * Stored in settings (`userSpaces`, validated by `sanitiseUserSpaces` on every load like the other typed blocks). The
 * `open` flag is the consent package's: a space is closed to models until the person opens it, and a damaged flag reads
 * as closed. Pure: no DOM, no settings handle.
 */
import type { QueryToken } from "./protocol/worker";
import { SPACE_ORDER } from "./index-format";
import { PALETTES, TINT_IDS, TINT_PALETTES, type TintId } from "./palette";
import type { Appearance } from "./colourTheme";
import { applyColourTheme } from "./colourTheme";
import type { PaletteId, SettingsIssue } from "./settings";
import { SPACES } from "./spaces";
import type { SpaceId } from "./types";

export interface UserSpace {
  /** Stable, lower-case, unique within the list ("my-garden"); the cycle and the consent grants refer to it. */
  id: string;
  /** What the wordmark shows. */
  name: string;
  /** The built-in areas it gathers (never "none"). */
  areas: SpaceId[];
  /** Folder paths it gathers, as the Folder path grouping spells them ("kb/money"): everything inside counts. */
  folders: string[];
  /** A colour theme (window and data colours together) shown while this space is chosen. Absent = leave the look alone. */
  theme?: TintId;
  /** Data colours shown while this space is chosen; wins over the theme's palette. Absent = the theme's, or none. */
  palette?: PaletteId;
  /** Open to models (the consent package reads it). Closed unless set to exactly true. */
  open: boolean;
}

export const USER_SPACE_LIMITS = { spaces: 24, name: 40, id: 40, folders: 24, folder: 200 } as const;

/** A scope that names a user space: "user:<id>". The ten areas and "all" keep their own ids. */
export type UserScope = `user:${string}`;
export const USER_SCOPE_PREFIX = "user:";

export function userScope(id: string): UserScope {
  return `${USER_SCOPE_PREFIX}${id}`;
}
export function isUserScope(scope: string): scope is UserScope {
  return scope.startsWith(USER_SCOPE_PREFIX) && scope.length > USER_SCOPE_PREFIX.length;
}
export function userScopeId(scope: UserScope): string {
  return scope.slice(USER_SCOPE_PREFIX.length);
}

const AREA_IDS: readonly SpaceId[] = SPACE_ORDER.filter((id) => id !== "none");
const PALETTE_IDS: ReadonlySet<string> = new Set([...PALETTES, ...TINT_PALETTES].map((p) => p.id));

export function isTintId(v: unknown): v is TintId {
  return typeof v === "string" && (TINT_IDS as readonly string[]).includes(v);
}
export function isPaletteId(v: unknown): v is PaletteId {
  return typeof v === "string" && PALETTE_IDS.has(v);
}

/** "kb\\money/" -> "kb/money": forward slashes, no leading or trailing slash, no empty or dot parts. "" when nothing is left. */
export function normaliseFolder(raw: string): string {
  const parts = raw
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p !== "" && p !== "." && p !== "..");
  return parts.join("/").slice(0, USER_SPACE_LIMITS.folder);
}

/** A lower-case id from a name ("My garden!" -> "my-garden"); "space" when the name has no letters or digits. */
export function slugFor(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, USER_SPACE_LIMITS.id - 4);
  return s === "" ? "space" : s;
}

/** An id for `name` that no entry of `taken` uses ("my-garden", then "my-garden-2", ...). */
export function uniqueId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugFor(name);
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${used.size + 1}`;
}

/** A fresh, empty space with a unique id. The name is trimmed and cut to the limit. */
export function newUserSpace(existing: readonly UserSpace[], name: string): UserSpace {
  const clean = cleanName(name) || "Space";
  return { id: uniqueId(clean, existing.map((u) => u.id)), name: clean, areas: [], folders: [], open: false };
}

function cleanName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, USER_SPACE_LIMITS.name);
}

// ───────────────────────────── storage validation ─────────────────────────────

function plain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function one(o: Record<string, unknown>, issues: SettingsIssue[], i: number): UserSpace | null {
  const path = `userSpaces.${i}`;
  const name = typeof o.name === "string" ? cleanName(o.name) : "";
  if (name === "") return null;
  const rawId = typeof o.id === "string" ? o.id.trim().toLowerCase() : "";
  const id = /^[a-z0-9][a-z0-9-]{0,39}$/.test(rawId) ? rawId : "";
  if (id === "") return null;
  const areas: SpaceId[] = [];
  if (o.areas !== undefined && !Array.isArray(o.areas)) issues.push({ path: `${path}.areas`, problem: "wrong-type", action: "used-default" });
  else for (const a of (o.areas as unknown[] | undefined) ?? []) if (typeof a === "string" && (AREA_IDS as readonly string[]).includes(a) && !areas.includes(a as SpaceId)) areas.push(a as SpaceId);
  const folders: string[] = [];
  if (o.folders !== undefined && !Array.isArray(o.folders)) issues.push({ path: `${path}.folders`, problem: "wrong-type", action: "used-default" });
  else
    for (const f of (o.folders as unknown[] | undefined) ?? []) {
      const n = typeof f === "string" ? normaliseFolder(f) : "";
      if (n !== "" && !folders.includes(n) && folders.length < USER_SPACE_LIMITS.folders) folders.push(n);
    }
  const out: UserSpace = { id, name, areas, folders, open: o.open === true };
  if (o.theme !== undefined) {
    if (isTintId(o.theme)) out.theme = o.theme;
    else issues.push({ path: `${path}.theme`, problem: "unknown-value", action: "used-default" });
  }
  if (o.palette !== undefined) {
    if (isPaletteId(o.palette)) out.palette = o.palette;
    else issues.push({ path: `${path}.palette`, problem: "unknown-value", action: "used-default" });
  }
  if (o.open !== undefined && typeof o.open !== "boolean") issues.push({ path: `${path}.open`, problem: "wrong-type", action: "used-safe-value" });
  return out;
}

/**
 * The stored list, validated: absent = none; a wrong-typed value = none (reported); an item without a usable name or id,
 * a repeated id, or one past the limit is dropped (reported once); unknown areas, palettes and themes are dropped from
 * the item; a damaged `open` flag reads as closed.
 */
export function sanitiseUserSpaces(raw: unknown, issues: SettingsIssue[]): UserSpace[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push({ path: "userSpaces", problem: "wrong-type", action: "used-default" });
    return [];
  }
  const out: UserSpace[] = [];
  const seen = new Set<string>();
  let dropped = false;
  raw.forEach((item, i) => {
    const v = plain(item) ? one(item, issues, i) : null;
    if (v === null || seen.has(v.id) || out.length >= USER_SPACE_LIMITS.spaces) {
      dropped = true;
      return;
    }
    seen.add(v.id);
    out.push(v);
  });
  if (dropped) issues.push({ path: "userSpaces", problem: "malformed-list", action: "used-default" });
  return out;
}

// ───────────────────────────── members as one line of text ─────────────────────────────

/** "Money, kb/web, Life" -> the areas it names (by name or id, any case) and the rest as folders. */
export function parseMembers(text: string): { areas: SpaceId[]; folders: string[] } {
  const areas: SpaceId[] = [];
  const folders: string[] = [];
  for (const piece of text.split(/[,;\n]/)) {
    const word = piece.trim();
    if (word === "") continue;
    const key = word.toLowerCase();
    const area = SPACES.find((s) => s.id === key || s.name.toLowerCase() === key);
    if (area) {
      if (!areas.includes(area.id)) areas.push(area.id);
      continue;
    }
    const f = normaliseFolder(word);
    if (f !== "" && !folders.includes(f) && folders.length < USER_SPACE_LIMITS.folders) folders.push(f);
  }
  return { areas, folders };
}

/** The inverse of `parseMembers`: area names, then folders, joined with ", ". */
export function formatMembers(space: Pick<UserSpace, "areas" | "folders">): string {
  const names = space.areas.map((a) => SPACES.find((s) => s.id === a)?.name ?? a);
  return [...names, ...space.folders].join(", ");
}

// ───────────────────────────── scoping the figure ─────────────────────────────

/** Ids of the tokens a chosen space puts on the figure start with this, so they can be told from the person's own. */
export const USER_SPACE_TOKEN_PREFIX = "userspace:";

export function isUserSpaceToken(t: Pick<QueryToken, "id">): boolean {
  return t.id.startsWith(USER_SPACE_TOKEN_PREFIX);
}

/** The group tokens that light a space's members (OR within the kind): one per area and one per folder. */
export function userSpaceTokens(space: UserSpace): QueryToken[] {
  const out: QueryToken[] = [];
  for (const a of space.areas) {
    const name = SPACES.find((s) => s.id === a)?.name ?? a;
    out.push({ id: `${USER_SPACE_TOKEN_PREFIX}${space.id}:area:${a}`, kind: "group", label: name, dim: "space", value: a });
  }
  for (const f of space.folders) out.push({ id: `${USER_SPACE_TOKEN_PREFIX}${space.id}:folder:${f}`, kind: "group", label: f, dim: "folderPath", value: f });
  return out;
}

/**
 * The real scope to set when a space is chosen: its one area when that is all it holds (the compass turns to it), else
 * "all" with its members lit by tokens. A space with no members scopes nothing.
 */
export function userSpaceScope(space: UserSpace): SpaceId | "all" {
  return space.areas.length === 1 && space.folders.length === 0 ? (space.areas[0] as SpaceId) : "all";
}

/**
 * The space currently chosen, read back from the figure's own state (no extra state to keep in step): its tokens are
 * present, and the scope is the one `userSpaceScope` would set. Anything else (the person moved to another area,
 * removed a chip) means no space is chosen.
 */
export function activeUserSpace(tokens: readonly Pick<QueryToken, "id">[], scope: SpaceId | "all", spaces: readonly UserSpace[]): UserSpace | null {
  for (const sp of spaces) {
    const prefix = `${USER_SPACE_TOKEN_PREFIX}${sp.id}:`;
    if (!tokens.some((t) => t.id.startsWith(prefix))) continue;
    if (userSpaceScope(sp) === scope) return sp;
  }
  return null;
}

/** Tokens of the figure with every space token removed (the person's own stay). */
export function withoutUserSpaceTokens<T extends Pick<QueryToken, "id">>(tokens: readonly T[]): T[] {
  return tokens.filter((t) => !isUserSpaceToken(t));
}

/** Tokens after choosing `space` (or none): the person's own tokens plus the space's members. */
export function tokensFor(tokens: readonly QueryToken[], space: UserSpace | null): QueryToken[] {
  const keep = withoutUserSpaceTokens(tokens);
  return space ? [...keep, ...userSpaceTokens(space)] : keep;
}

// ───────────────────────────── the temporary look ─────────────────────────────

/** Whether a space carries a look of its own. */
export function hasLook(space: UserSpace | null | undefined): space is UserSpace & ({ theme: TintId } | { palette: PaletteId }) {
  return !!space && (space.theme !== undefined || space.palette !== undefined);
}

/** The body of a settings preview: the space's colour theme, then its data palette on top. Nothing without a look. */
export function applyUserSpaceLook(appearance: Appearance, space: UserSpace): void {
  if (space.theme !== undefined) applyColourTheme(appearance, space.theme);
  if (space.palette !== undefined) appearance.palette = space.palette;
}

// ───────────────────────────── the wordmark's typed swap ─────────────────────────────

/**
 * The frames of a short typed swap from `prev` to `next`: the old word is deleted from the end (in at most `maxDelete`
 * steps, so a long name does not hold the swap up), then the new one is typed a letter at a time. The last frame is
 * `next`; equal words give just that frame.
 */
export function typedFrames(prev: string, next: string, maxDelete = 4): string[] {
  if (prev === next) return [next];
  const frames: string[] = [];
  if (prev !== "") {
    const steps = Math.min(maxDelete, prev.length);
    for (let i = 1; i <= steps; i++) frames.push(prev.slice(0, Math.floor((prev.length * (steps - i)) / steps)));
  }
  for (let i = 1; i <= next.length; i++) frames.push(next.slice(0, i));
  if (frames.length === 0 || frames[frames.length - 1] !== next) frames.push(next);
  return frames;
}

/** Milliseconds per frame so the whole swap takes about `totalMs` (never faster than 16 ms, never slower than 45 ms). */
export function typedFrameMs(frameCount: number, totalMs = 380): number {
  return Math.max(16, Math.min(45, Math.round(totalMs / Math.max(1, frameCount))));
}
