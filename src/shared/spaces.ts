/**
 * Areas (code identifier: spaces): the ten top-level areas in their fixed order, plus the "No area" bucket.
 * A wiki note's area comes from `spaceOfWikiPath` alone: first your own wiki folders (Settings › Sources, stored as
 * `wikiAreas` and validated by `sanitiseWikiAreas`), then the default area table for kb/-style vaults (in both the
 * longest matching folder wins, folder + "/"), then the area words of the note's folder names. Cortex never runs the
 * vault's generator scripts.
 * The sample record (M13) reuses six of the area ids under six invented names; `spaceName(id, { sample })`
 * gives the name to show while the sample is open.
 * Owner: E7 (index & state).
 */
import type { SettingsIssue } from "./settings";
import type { SpaceId } from "./types";

export interface SpaceDef {
  id: SpaceId;
  /** Short display name used in chips and legends. */
  name: string;
  /** Long name of the matching vault area. */
  area: string;
  /** Prefixes relative to `wiki/` (no leading or trailing slash). */
  wikiPrefixes: readonly string[];
}

export const SPACES: readonly SpaceDef[] = [
  {
    id: "code",
    name: "Code",
    area: "Software and Computer Science",
    wikiPrefixes: [
      "kb/programming-foundations", "kb/dsa", "kb/languages", "kb/architecture", "kb/deep/cpp", "kb/deep/csharp",
      "kb/deep/java", "kb/deep/javascript", "kb/deep/python", "kb/deep/php", "kb/deep/sql", "kb/deep/typescript",
      "kb/deep/unix", "kb/deep/cs-systems", "kb/deep/apis", "kb/deep/app-making",
    ],
  },
  {
    id: "web",
    name: "Web",
    area: "Web",
    wikiPrefixes: ["kb/web-frontend", "kb/web-backend", "kb/deep/css", "kb/deep/html", "kb/deep/web-advanced", "kb/deep/web-vfx", "kb/deep/web3d"],
  },
  { id: "data", name: "Data", area: "Data and Infrastructure", wikiPrefixes: ["kb/databases", "kb/devops-cloud"] },
  {
    id: "ai",
    name: "AI",
    area: "Artificial Intelligence",
    wikiPrefixes: ["kb/ai-ml-foundations", "kb/llms-genai", "kb/deep/ai-advanced", "kb/deep/nn-math"],
  },
  { id: "roblox", name: "Roblox", area: "Roblox", wikiPrefixes: ["kb/deep/roblox", "kb/deep/luau"] },
  { id: "games", name: "Games", area: "3D, Games and Media", wikiPrefixes: ["kb/3d-graphics", "kb/deep/media-production", "kb/applied-specialized"] },
  { id: "money", name: "Money", area: "Business and Money", wikiPrefixes: ["kb/business", "kb/money", "kb/re-structuring"] },
  { id: "design", name: "Design", area: "Design and Psychology", wikiPrefixes: ["kb/design", "kb/psychology"] },
  { id: "life", name: "Life", area: "Life and Civics", wikiPrefixes: ["kb/life", "kb/government", "kb/guides"] },
  { id: "vault", name: "Vault", area: "Vault and Tools", wikiPrefixes: [] },
];

/** The bucket for items without an area; shown as "No area" (never "Unsorted"). */
export const NO_AREA: SpaceDef = { id: "none", name: "No area", area: "No area", wikiPrefixes: [] };

/** One of the ten fixed areas (never the "No area" bucket). */
export type AreaId = Exclude<SpaceId, "none">;

/** The ten fixed area ids in their fixed order. */
export const AREA_IDS: readonly AreaId[] = SPACES.map((s) => s.id).filter((id): id is AreaId => id !== "none");

export function isAreaId(v: unknown): v is AreaId {
  return typeof v === "string" && (AREA_IDS as readonly string[]).includes(v);
}

/**
 * Words in a folder's name that name an area, for folders the area table does not list: a vault grows new folders
 * (kb/library/ai, kb/code-library/python…) and their notes belong in the area their name says, not in Vault. Only whole
 * words of folder names count (split at anything not a letter or digit), never a note's own file name.
 */
export const AREA_WORDS: Readonly<Record<string, SpaceId>> = {
  code: "code", coding: "code", programming: "code", software: "code", cs: "code", dsa: "code", algorithms: "code", languages: "code",
  architecture: "code", python: "code", node: "code", nodejs: "code", javascript: "code", typescript: "code", react: "code",
  docker: "code", git: "code", cpp: "code", csharp: "code", java: "code", php: "code", rust: "code", golang: "code", unix: "code",
  linux: "code", apis: "code", api: "code",
  web: "web", frontend: "web", backend: "web", css: "web", html: "web", web3d: "web",
  data: "data", databases: "data", database: "data", sql: "data", devops: "data", cloud: "data", infrastructure: "data", infra: "data",
  ai: "ai", ml: "ai", llm: "ai", llms: "ai", genai: "ai", nn: "ai", neural: "ai",
  roblox: "roblox", luau: "roblox",
  games: "games", game: "games", gaming: "games", "3d": "games", graphics: "games", media: "games", animation: "games", unity: "games",
  unreal: "games", blender: "games",
  money: "money", business: "money", finance: "money", investing: "money", marketing: "money", sales: "money", startup: "money",
  startups: "money", economics: "money",
  design: "design", psychology: "design", ux: "design", ui: "design",
  life: "life", government: "life", guides: "life", health: "life", fitness: "life", travel: "life", civics: "life", law: "life",
};

/** The area a folder path's names point to, deepest folder first (the most specific name wins); null when none does. */
export function spaceOfFolderNames(folders: readonly string[]): SpaceId | null {
  for (let i = folders.length - 1; i >= 0; i--) {
    for (const word of (folders[i] as string).toLowerCase().split(/[^a-z0-9]+/)) {
      const id = word ? AREA_WORDS[word] : undefined;
      if (id) return id;
    }
  }
  return null;
}

/**
 * Bump when the built-in folder → area rules change, so a cached vault part built under the old rules is rebuilt (your
 * own wiki folders are part of that cache's key themselves).
 */
export const AREA_RULES_VERSION = 2;

// ───────────────────────────── your wiki folders' areas ─────────────────────────────

/**
 * One of your rows (Settings › Sources › Wiki folders and their areas): a folder inside wiki/ and the area its notes,
 * and the notes of every folder inside it, belong to.
 */
export interface WikiAreaRow {
  /** Path relative to `wiki/` ("notes/recipes"): forward slashes, no leading or trailing slash, matched as written. */
  folder: string;
  area: AreaId;
}

export const WIKI_AREA_LIMITS = { rows: 100, folder: 200 } as const;

/** " \\notes\\ recipes/ " -> "notes/recipes": forward slashes, parts trimmed, no empty, "." or ".." parts. "" when nothing is left. */
export function normaliseWikiFolder(raw: string): string {
  return raw
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p !== "" && p !== "." && p !== "..")
    .join("/");
}

/**
 * The stored rows, validated on every load (like the other typed settings blocks): absent = none; a wrong-typed value =
 * none (reported); folders are normalised without a report; a row without a folder, with a folder longer than the limit
 * or with an area that is not one of the ten is dropped, a folder already listed keeps its first row, and rows past the
 * limit are dropped. Any drop is reported once.
 */
export function sanitiseWikiAreas(raw: unknown, issues: SettingsIssue[]): WikiAreaRow[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push({ path: "wikiAreas", problem: "wrong-type", action: "used-default" });
    return [];
  }
  const out: WikiAreaRow[] = [];
  const seen = new Set<string>();
  let dropped = false;
  for (const item of raw) {
    const o = typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
    const folder = typeof o.folder === "string" ? normaliseWikiFolder(o.folder) : "";
    const area = o.area;
    if (folder === "" || folder.length > WIKI_AREA_LIMITS.folder || !isAreaId(area) || seen.has(folder) || out.length >= WIKI_AREA_LIMITS.rows) {
      dropped = true;
      continue;
    }
    seen.add(folder);
    out.push({ folder, area });
  }
  if (dropped) issues.push({ path: "wikiAreas", problem: "malformed-list", action: "used-default" });
  return out;
}

// ───────────────────────────── a wiki note's area ─────────────────────────────

interface FolderArea {
  folder: string;
  area: SpaceId;
}

/** The default area table for kb/-style vaults, as rows. */
const DEFAULT_WIKI_TABLE: readonly FolderArea[] = SPACES.flatMap((s) => s.wikiPrefixes.map((folder) => ({ folder, area: s.id })));

/** The area of the longest folder of `rows` that the path sits inside (folder + "/"), or null when none does. */
function longestFolder(relToWiki: string, rows: readonly FolderArea[]): SpaceId | null {
  let best = -1;
  let id: SpaceId | null = null;
  for (const r of rows) {
    if (r.folder.length > best && relToWiki.startsWith(`${r.folder}/`)) {
      best = r.folder.length;
      id = r.area;
    }
  }
  return id;
}

/**
 * Space of a wiki note from its path relative to `wiki/` (e.g. "kb/deep/roblox/x.md"). The one place that decides it:
 * your own wiki folders first (`wikiAreas` from settings; the longest matching folder wins), then the default area
 * table for kb/ vaults (longest prefix wins), then the area its folders' names say, else Vault.
 */
export function spaceOfWikiPath(relToWiki: string, yours: readonly WikiAreaRow[]): SpaceId {
  return longestFolder(relToWiki, yours) ?? longestFolder(relToWiki, DEFAULT_WIKI_TABLE) ?? spaceOfFolderNames(relToWiki.split("/").slice(0, -1)) ?? "vault";
}

/**
 * Default Claude Code project-slug → space table (editable in Settings). Empty: project folders differ on every
 * computer, so each person maps their own (an entry looks like "C--Users-you-Projects-notes": "vault").
 */
export const DEFAULT_CLAUDE_CODE_SPACES: Readonly<Record<string, SpaceId>> = {};

/** Space of a Claude Code project slug: the settings table first (exact, then longest slug prefix), else none. */
export function spaceOfProjectSlug(slug: string, table: Readonly<Record<string, SpaceId>> = DEFAULT_CLAUDE_CODE_SPACES): SpaceId {
  const exact = table[slug];
  if (exact) return exact;
  let best = -1;
  let id: SpaceId = "none";
  for (const [k, v] of Object.entries(table)) {
    if (k.length > best && slug.startsWith(k + "-")) {
      best = k.length;
      id = v;
    }
  }
  return id;
}

// ───────────────────────────── the sample record's invented areas ─────────────────────────────

export interface SampleArea {
  /** Invented display name (no real record behind it). */
  name: string;
  /** Area id the sample borrows for placement and colour. */
  space: SpaceId;
  projects: readonly string[];
  /** Things the made-up conversations are about (titles, topics, notes). */
  nouns: readonly string[];
  /** Relative share of the sample's conversations. */
  weight: number;
}

export const SAMPLE_AREAS: readonly SampleArea[] = [
  {
    name: "Garden",
    space: "life",
    projects: ["Back beds", "Allotment", "Greenhouse", "Orchard row"],
    nouns: ["raised bed", "compost", "seedlings", "tomato trellis", "rain barrel", "herb spiral", "mulch", "frost cloth", "pea netting", "soil test", "pruning", "bulb planting"],
    weight: 22,
  },
  {
    name: "Studio",
    space: "design",
    projects: ["Spring prints", "Portrait series", "Clay corner", "Window display"],
    nouns: ["lighting rig", "colour study", "canvas prep", "sketchbook", "glaze test", "frame order", "gallery wall", "photo shoot", "print run", "ink wash", "model sheet", "palette"],
    weight: 16,
  },
  {
    name: "Ledger",
    space: "money",
    projects: ["Household budget", "Side shop", "Tax year", "Savings plan"],
    nouns: ["monthly budget", "invoice batch", "tax folder", "savings goal", "receipt scan", "rent split", "insurance renewal", "utility bills", "spending review", "price list", "quarter close", "refund claim"],
    weight: 14,
  },
  {
    name: "Workshop",
    space: "code",
    projects: ["Bookshelf", "Tool wall", "Bench rebuild", "Garden gate"],
    nouns: ["router jig", "bench vise", "dovetail joint", "shelf bracket", "sharpening", "dust collector", "clamp rack", "drawer slides", "finish sanding", "cut list", "tool chest", "glue up"],
    weight: 20,
  },
  {
    name: "Travel",
    space: "games",
    projects: ["Coast walk", "Rail loop", "Island week", "Mountain huts"],
    nouns: ["rail pass", "packing list", "ferry times", "hostel booking", "route map", "visa form", "day hike", "night train", "border crossing", "museum pass", "local market", "rain plan"],
    weight: 12,
  },
  {
    name: "Reading",
    space: "ai",
    projects: ["Book club", "Poetry month", "Essay notes", "Series reread"],
    nouns: ["chapter notes", "reading list", "margin quotes", "library holds", "essay draft", "poetry night", "translation", "series order", "author talk", "index cards", "review draft", "glossary"],
    weight: 16,
  },
];

/** Names shown for the borrowed area ids while the sample record is open. */
export const SAMPLE_SPACE_NAMES: Readonly<Partial<Record<SpaceId, string>>> = Object.fromEntries(SAMPLE_AREAS.map((a) => [a.space, a.name]));

/** Display name of an area; pass `{ sample: true }` while the sample record is open. */
export function spaceName(id: SpaceId, opts: { sample?: boolean } = {}): string {
  if (opts.sample) {
    const s = SAMPLE_SPACE_NAMES[id];
    if (s) return s;
  }
  return SPACES.find((s) => s.id === id)?.name ?? NO_AREA.name;
}
