/**
 * Typed, validated settings sub-objects that later features own: `record` (seals, encryption, key shares, heir),
 * `consent` (grants, open spaces, read limits), `launcher` (tray and quick window), `captureWeb` (the opt-in loopback
 * receiver for browser add-on capture).
 *
 * One file declares them so the features stop editing settings.ts: a feature adds its fields to the interface, its
 * default to `extDefaults()` and its checks to the sanitiser below, and nothing else. settings.ts merges the result once
 * (`mergeExt`) on every load and every update; a file written before these blocks existed simply gets the defaults.
 *
 * Fail-safe, like the rest of settings: a wrong-typed value falls back to the SAFE value (a grant is required, spaces stay
 * closed, the receiver stays off), a malformed list item is dropped and reported, and a damaged encryption block marks the
 * file corrupt (rejected) because guessing "not encrypted" could lose the record.
 *
 * NEVER stored here: passphrases, keys, key shares and the capture token. They live in the local key store.
 */
import type { SettingsIssue } from "./settings";
import { sanitiseSchemas, type SchemaDraft } from "./schemas";
import { sanitiseWikiAreas, type WikiAreaRow } from "./spaces";
import { sanitiseUserSpaces, type UserSpace } from "./userSpaces";

/** A person the user trusts with one share of the vault key. Names and contact lines are typed by the user. */
export interface KeyHolder {
  name: string;
  contact: string;
  /** Which share (1-based) this person holds. */
  share: number;
  instructions: string;
  /** The code that names the share on a list (`a1b2-c3d4`); empty before a share was made. Never the share itself. */
  checksum: string;
  /** Day the person was named (`yyyy-mm-dd`); empty when not recorded. */
  namedAt: string;
}

/** A time-boxed permission for one reader to read some spaces. */
export interface ConsentGrant {
  id: string;
  purpose: string;
  spaces: string[];
  reader: string;
  /** Calendar dates, yyyy-mm-dd. */
  start: string;
  end: string;
  /** Reads used so far. */
  reads: number;
  /** 0 = no limit. */
  readLimit: number;
  revoked: boolean;
}

export interface RecordSettings {
  /** Seal the day's new entries once a day without being asked. */
  sealDaily: boolean;
  /** Whether the record on disk is encrypted, and which key-derivation version wrapped the key. */
  encryption: { enabled: boolean; kdfVersion: number };
  /** Shamir sharing of the vault key: `threshold` of `total` shares recover it. */
  shares: { threshold: number; total: number; holders: KeyHolder[]; /** Day the key was split (`yyyy-mm-dd`); empty = not split. */ splitAt: string };
  /** Who receives the hand-over bundle. Automatic release is not offered. */
  heir: { name: string; contact: string; spaces: string[]; letter: string; /** Which share goes into the hand-over bundle (0 = none, handed over separately). */ share: number; /** Day the heir was named; empty when not recorded. */ namedAt: string };
  /** An export of a source is "due" after this many days; a source id in `exportEveryBySource` overrides it. */
  exportEveryDays: number;
  exportEveryBySource: Record<string, number>;
}

export interface ConsentSettings {
  /** Models read nothing unless a live grant covers it. */
  requireGrant: boolean;
  /** Space ids (areas, user spaces, folders) that directions, exports and grants may use. Empty = everything closed. */
  openSpaces: string[];
  /** A single item may be read by a model at most `max` times. */
  itemReadLimit: { enabled: boolean; max: number };
  /** Item id -> when the owner reset that item's read count; reads at or before that moment stop counting. */
  readResets?: Record<string, string>;
  grants: ConsentGrant[];
}

export interface LauncherSettings {
  /** The system tray icon and its menu (Cortex Desktop only). */
  tray: boolean;
  /** Closing the window hides it to the tray instead of quitting (off by default; needs the tray icon). */
  keepRunning: boolean;
  /** The small always-on-top quick window, summoned by `quickShortcut` (off by default: nothing is registered with the system until the person turns it on). */
  quickWindow: boolean;
  /** An Electron accelerator such as "CommandOrControl+Shift+Space"; "" = no shortcut. */
  quickShortcut: string;
  /** The tray's "Today" line shows estimated token cost. */
  showTodayCost: boolean;
}

export interface CaptureWebSettings {
  /** The loopback receiver (127.0.0.1 only). Never on without recorded consent. */
  enabled: boolean;
  /** Version of the consent text the person accepted; 0 = not accepted. A new text raises the number and asks again. */
  consentVersion: number;
  /** When they accepted, yyyy-mm-dd. */
  consentAt: string;
  /** Hosts the add-on may read; the person can remove any. */
  sites: string[];
  /** 0 = pick a free port. */
  port: number;
}

export interface SettingsExt {
  record: RecordSettings;
  consent: ConsentSettings;
  launcher: LauncherSettings;
  captureWeb: CaptureWebSettings;
  /** The person's own named spaces (shared/userSpaces.ts). */
  userSpaces: UserSpace[];
  /** Label schemas you built (shared/schemas.ts; Agents > Ledger > Your schemas). */
  schemas: SchemaDraft[];
  /**
   * Your wiki folders and the fixed area each belongs to (Settings › Sources; shared/spaces.ts). They come before the
   * default kb/ table when a wiki note's area is decided. Empty by default.
   */
  wikiAreas: WikiAreaRow[];
}

export const EXT_KEYS = ["record", "consent", "launcher", "captureWeb", "userSpaces", "schemas", "wikiAreas"] as const;

/** The most the current consent text for the browser add-on is at; raise it when the text changes. */
export const CAPTURE_CONSENT_VERSION = 1;

export const EXT_RANGES = {
  shareTotal: [2, 10],
  exportDays: [7, 365],
  itemReads: [1, 99],
  kdfVersion: [1, 99],
  grantReads: [0, 1_000_000],
  port: [1024, 65535],
} as const;

export const DEFAULT_CAPTURE_SITES: readonly string[] = ["chatgpt.com", "claude.ai", "gemini.google.com"];

const LIMITS = { name: 80, contact: 200, instructions: 2000, letter: 8000, id: 80, purpose: 200, reader: 120, space: 120, holders: 12, grants: 200, spaces: 400, sites: 20, sourceKeys: 60 } as const;

/** Fresh defaults every call, so no caller can share or mutate another's nested objects. */
export function extDefaults(): SettingsExt {
  return {
    record: {
      sealDaily: true,
      encryption: { enabled: false, kdfVersion: 1 },
      shares: { threshold: 2, total: 3, holders: [], splitAt: "" },
      heir: { name: "", contact: "", spaces: [], letter: "", share: 0, namedAt: "" },
      exportEveryDays: 30,
      exportEveryBySource: {},
    },
    consent: { requireGrant: false, openSpaces: [], itemReadLimit: { enabled: false, max: 3 }, readResets: {}, grants: [] },
    launcher: { tray: true, keepRunning: false, quickWindow: false, quickShortcut: "CommandOrControl+Shift+Space", showTodayCost: true },
    captureWeb: { enabled: false, consentVersion: 0, consentAt: "", sites: [...DEFAULT_CAPTURE_SITES], port: 0 },
    userSpaces: [],
    schemas: [],
    wikiAreas: [],
  };
}

// ───────────────────────────── validation helpers ─────────────────────────────

type Issues = SettingsIssue[];

function plain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function wrong(issues: Issues, path: string, action: SettingsIssue["action"], problem: SettingsIssue["problem"] = "wrong-type"): void {
  issues.push({ path, problem, action });
}

/** The block itself: undefined = absent (defaults, no issue); anything but a plain object is wrong-typed. */
function block(raw: unknown, path: string, issues: Issues, action: SettingsIssue["action"] = "used-default"): Record<string, unknown> {
  if (raw === undefined) return {};
  if (plain(raw)) return raw;
  wrong(issues, path, action);
  return {};
}

function bool(raw: unknown, def: boolean, path: string, issues: Issues, safe?: boolean): boolean {
  if (raw === undefined) return def;
  if (typeof raw === "boolean") return raw;
  wrong(issues, path, safe === undefined ? "used-default" : "used-safe-value");
  return safe === undefined ? def : safe;
}

function int(raw: unknown, def: number, range: readonly [number, number], path: string, issues: Issues): number {
  if (raw === undefined) return def;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    wrong(issues, path, "used-default");
    return def;
  }
  return Math.min(range[1], Math.max(range[0], Math.round(raw)));
}

function str(raw: unknown, def: string, max: number, path: string, issues: Issues): string {
  if (raw === undefined) return def;
  if (typeof raw !== "string") {
    wrong(issues, path, "used-default");
    return def;
  }
  return raw.slice(0, max);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date, yyyy-mm-dd, or "". */
export function isIsoDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

function date(raw: unknown, path: string, issues: Issues): string {
  if (raw === undefined) return "";
  if (typeof raw === "string" && (raw === "" || isIsoDate(raw))) return raw;
  wrong(issues, path, "used-default", typeof raw === "string" ? "unknown-value" : "wrong-type");
  return "";
}

/** A list of strings: a wrong-typed list becomes `def`; items of the wrong type, blank or repeated are dropped and reported once. */
function strList(raw: unknown, def: readonly string[], max: number, itemMax: number, path: string, issues: Issues, accept: (s: string) => boolean = () => true, norm: (s: string) => string = (s) => s.trim()): string[] {
  if (raw === undefined) return [...def];
  if (!Array.isArray(raw)) {
    wrong(issues, path, "used-default");
    return [...def];
  }
  const out: string[] = [];
  let dropped = false;
  for (const item of raw) {
    const s = typeof item === "string" ? norm(item) : "";
    if (!s || s.length > itemMax || !accept(s) || out.includes(s) || out.length >= max) {
      dropped = true;
      continue;
    }
    out.push(s);
  }
  if (dropped) wrong(issues, path, "used-default", "malformed-list");
  return out;
}

function listOf<T>(raw: unknown, max: number, path: string, issues: Issues, one: (item: Record<string, unknown>) => T | null): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    wrong(issues, path, "used-default");
    return [];
  }
  const out: T[] = [];
  let dropped = false;
  for (const item of raw) {
    const v = plain(item) ? one(item) : null;
    if (v === null || out.length >= max) dropped = true;
    else out.push(v);
  }
  if (dropped) wrong(issues, path, "used-default", "malformed-list");
  return out;
}

const HOST = /^[a-z0-9]([a-z0-9.-]{0,98}[a-z0-9])?$/;
/** A bare host name (no scheme, path or port): what the browser add-on may read. */
export function isCaptureHost(s: string): boolean {
  return HOST.test(s) && !s.includes("..") && s.includes(".");
}

/** An Electron accelerator: modifiers and one key joined by "+". */
export function isAccelerator(s: string): boolean {
  return /^[A-Za-z0-9]+(\+[A-Za-z0-9]+){0,4}$/.test(s) && s.length <= 48;
}

// ───────────────────────────── sub-object sanitisers ─────────────────────────────

function holder(o: Record<string, unknown>, total: number): KeyHolder | null {
  const name = typeof o.name === "string" ? o.name.trim().slice(0, LIMITS.name) : "";
  const share = typeof o.share === "number" && Number.isInteger(o.share) ? o.share : 0;
  if (!name || share < 1 || share > total) return null;
  return {
    name,
    contact: typeof o.contact === "string" ? o.contact.slice(0, LIMITS.contact) : "",
    share,
    instructions: typeof o.instructions === "string" ? o.instructions.slice(0, LIMITS.instructions) : "",
    checksum: typeof o.checksum === "string" && /^[0-9a-f]{4}-[0-9a-f]{4}$/.test(o.checksum) ? o.checksum : "",
    namedAt: typeof o.namedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.namedAt) ? o.namedAt : "",
  };
}

function recordBlock(raw: unknown, issues: Issues): RecordSettings {
  const d = extDefaults().record;
  const r = block(raw, "record", issues);
  const enc = block(r.encryption, "record.encryption", issues, "rejected");
  const sh = block(r.shares, "record.shares", issues);
  const heir = block(r.heir, "record.heir", issues);
  const total = int(sh.total, d.shares.total, EXT_RANGES.shareTotal, "record.shares.total", issues);
  const threshold = int(sh.threshold, d.shares.threshold, [2, total], "record.shares.threshold", issues);
  const byRaw = r.exportEveryBySource;
  const by: Record<string, number> = {};
  if (byRaw !== undefined && !plain(byRaw)) wrong(issues, "record.exportEveryBySource", "used-default");
  else if (plain(byRaw)) {
    let n = 0;
    for (const [k, v] of Object.entries(byRaw)) {
      if (typeof v === "number" && Number.isFinite(v) && k.length > 0 && k.length <= 60 && n < LIMITS.sourceKeys) {
        by[k] = Math.min(EXT_RANGES.exportDays[1], Math.max(EXT_RANGES.exportDays[0], Math.round(v)));
        n++;
      } else wrong(issues, `record.exportEveryBySource.${k.slice(0, 60)}`, "used-default");
    }
  }
  // A damaged encryption block is never guessed at: it marks the file corrupt so nothing is rewritten from a guess.
  const encEnabled = enc.enabled === undefined ? d.encryption.enabled : typeof enc.enabled === "boolean" ? enc.enabled : (wrong(issues, "record.encryption.enabled", "rejected"), d.encryption.enabled);
  const kdf = enc.kdfVersion === undefined ? d.encryption.kdfVersion : typeof enc.kdfVersion === "number" && Number.isFinite(enc.kdfVersion) ? Math.min(EXT_RANGES.kdfVersion[1], Math.max(EXT_RANGES.kdfVersion[0], Math.round(enc.kdfVersion))) : (wrong(issues, "record.encryption.kdfVersion", "rejected"), d.encryption.kdfVersion);
  return {
    sealDaily: bool(r.sealDaily, d.sealDaily, "record.sealDaily", issues),
    encryption: { enabled: encEnabled, kdfVersion: kdf },
    shares: { threshold, total, holders: listOf(sh.holders, LIMITS.holders, "record.shares.holders", issues, (o) => holder(o, total)), splitAt: typeof sh.splitAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sh.splitAt) ? sh.splitAt : "" },
    heir: {
      name: str(heir.name, "", LIMITS.name, "record.heir.name", issues),
      contact: str(heir.contact, "", LIMITS.contact, "record.heir.contact", issues),
      spaces: strList(heir.spaces, [], LIMITS.spaces, LIMITS.space, "record.heir.spaces", issues),
      letter: str(heir.letter, "", LIMITS.letter, "record.heir.letter", issues),
      share: int(heir.share, 0, [0, EXT_RANGES.shareTotal[1]], "record.heir.share", issues),
      namedAt: typeof heir.namedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(heir.namedAt) ? heir.namedAt : "",
    },
    exportEveryDays: int(r.exportEveryDays, d.exportEveryDays, EXT_RANGES.exportDays, "record.exportEveryDays", issues),
    exportEveryBySource: by,
  };
}

function grant(o: Record<string, unknown>): ConsentGrant | null {
  const id = typeof o.id === "string" ? o.id.trim().slice(0, LIMITS.id) : "";
  const start = typeof o.start === "string" ? o.start : "";
  const end = typeof o.end === "string" ? o.end : "";
  // A grant without an id, a real start and a real end that does not precede it grants nothing.
  if (!id || !isIsoDate(start) || !isIsoDate(end) || end < start) return null;
  const spaces = Array.isArray(o.spaces) ? o.spaces.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= LIMITS.space).slice(0, LIMITS.spaces) : [];
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(EXT_RANGES.grantReads[1], Math.max(EXT_RANGES.grantReads[0], Math.round(v))) : 0);
  return {
    id,
    purpose: typeof o.purpose === "string" ? o.purpose.slice(0, LIMITS.purpose) : "",
    spaces: [...new Set(spaces)],
    reader: typeof o.reader === "string" ? o.reader.slice(0, LIMITS.reader) : "",
    start,
    end,
    reads: num(o.reads),
    readLimit: num(o.readLimit),
    // Anything but an explicit false counts as revoked: a damaged flag must not widen access.
    revoked: o.revoked !== false,
  };
}

function consentBlock(raw: unknown, issues: Issues): ConsentSettings {
  const d = extDefaults().consent;
  const c = block(raw, "consent", issues);
  const lim = block(c.itemReadLimit, "consent.itemReadLimit", issues);
  const grants = listOf(c.grants, LIMITS.grants, "consent.grants", issues, grant);
  const ids = new Set<string>();
  return {
    requireGrant: bool(c.requireGrant, d.requireGrant, "consent.requireGrant", issues, true),
    openSpaces: strList(c.openSpaces, [], LIMITS.spaces, LIMITS.space, "consent.openSpaces", issues),
    itemReadLimit: {
      enabled: bool(lim.enabled, d.itemReadLimit.enabled, "consent.itemReadLimit.enabled", issues, true),
      max: int(lim.max, d.itemReadLimit.max, EXT_RANGES.itemReads, "consent.itemReadLimit.max", issues),
    },
    readResets: readResets(c.readResets, issues),
    grants: grants.filter((g) => !ids.has(g.id) && ids.add(g.id)),
  };
}

/** Item id -> reset moment. A malformed entry is dropped; at most 1000 are kept (the newest). */
function readResets(raw: unknown, issues: Issues): Record<string, string> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    wrong(issues, "consent.readResets", "used-default", "wrong-type");
    return {};
  }
  const out: Record<string, string> = {};
  for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
    if (/^[a-z]_[a-z0-9]{1,40}$/.test(id) && typeof at === "string" && /^\d{4}-\d{2}-\d{2}T/.test(at) && Number.isFinite(Date.parse(at))) out[id] = at;
  }
  const keys = Object.keys(out);
  if (keys.length > 1000) for (const k of keys.sort((x, y) => ((out[x] ?? "") < (out[y] ?? "") ? -1 : 1)).slice(0, keys.length - 1000)) delete out[k];
  return out;
}

function launcherBlock(raw: unknown, issues: Issues): LauncherSettings {
  const d = extDefaults().launcher;
  const l = block(raw, "launcher", issues);
  let shortcut = str(l.quickShortcut, d.quickShortcut, 48, "launcher.quickShortcut", issues).trim();
  if (shortcut !== "" && !isAccelerator(shortcut)) {
    wrong(issues, "launcher.quickShortcut", "used-default", "unknown-value");
    shortcut = d.quickShortcut;
  }
  return {
    tray: bool(l.tray, d.tray, "launcher.tray", issues),
    keepRunning: bool(l.keepRunning, d.keepRunning, "launcher.keepRunning", issues),
    quickWindow: bool(l.quickWindow, d.quickWindow, "launcher.quickWindow", issues),
    quickShortcut: shortcut,
    showTodayCost: bool(l.showTodayCost, d.showTodayCost, "launcher.showTodayCost", issues),
  };
}

function captureWebBlock(raw: unknown, issues: Issues): CaptureWebSettings {
  const d = extDefaults().captureWeb;
  const c = block(raw, "captureWeb", issues);
  const consentVersion = int(c.consentVersion, d.consentVersion, [0, 1000], "captureWeb.consentVersion", issues);
  let enabled = bool(c.enabled, d.enabled, "captureWeb.enabled", issues, false);
  // The receiver never runs without recorded consent, whatever the file says.
  if (enabled && consentVersion === 0) {
    wrong(issues, "captureWeb.enabled", "used-safe-value", "unknown-value");
    enabled = false;
  }
  const portRaw = c.port;
  let port = d.port;
  if (portRaw !== undefined) {
    if (typeof portRaw === "number" && Number.isInteger(portRaw) && (portRaw === 0 || (portRaw >= EXT_RANGES.port[0] && portRaw <= EXT_RANGES.port[1]))) port = portRaw;
    else wrong(issues, "captureWeb.port", "used-default", typeof portRaw === "number" ? "unknown-value" : "wrong-type");
  }
  return {
    enabled,
    consentVersion,
    consentAt: date(c.consentAt, "captureWeb.consentAt", issues),
    sites: strList(c.sites, DEFAULT_CAPTURE_SITES, LIMITS.sites, 100, "captureWeb.sites", issues, isCaptureHost, (s) => s.trim().toLowerCase()),
    port,
  };
}

/** The four sub-objects from a stored settings object, validated. Absent keys take the defaults; every problem is reported. */
export function mergeExt(source: Record<string, unknown>, issues: SettingsIssue[]): SettingsExt {
  return {
    record: recordBlock(source.record, issues),
    consent: consentBlock(source.consent, issues),
    launcher: launcherBlock(source.launcher, issues),
    captureWeb: captureWebBlock(source.captureWeb, issues),
    userSpaces: sanitiseUserSpaces(source.userSpaces, issues),
    schemas: sanitiseSchemas(source.schemas, issues),
    wikiAreas: sanitiseWikiAreas(source.wikiAreas, issues),
  };
}
