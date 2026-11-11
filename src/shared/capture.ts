/**
 * Live capture, the parts that need no disk and no socket (plugin/captureServer.ts and importers/capture.ts use
 * them; tests/live-capture.test.ts covers them).
 *
 * The receiver listens on 127.0.0.1 only and takes one kind of request: a finished turn (or a few) posted by the
 * hand-installed browser add-on, with the per-install token in an Authorization header. This file holds:
 *  - the sites the add-on may read and the hosts that mean each one;
 *  - the shape of a post, checked field by field (anything else is refused, never repaired);
 *  - the request checks that need no secret (the peer is this computer, the Host header names the loopback
 *    address, the Origin is the add-on's or absent), and the counters of what was refused and why.
 */
import type { CaptureSiteId } from "./settings";
import { sha256Hex } from "./sha256";

export const CAPTURE_PROTOCOL = 1;
export const CAPTURE_HOST = "127.0.0.1";
export const CAPTURE_DEFAULT_PORT = 47831;
/** The largest body the receiver reads. Bigger is refused before it is parsed. */
export const CAPTURE_MAX_BODY_BYTES = 1_000_000;
export const CAPTURE_MAX_TURNS_PER_POST = 40;
export const CAPTURE_MAX_TEXT_CHARS = 120_000;
export const CAPTURE_MAX_ID_CHARS = 200;
export const CAPTURE_MAX_TITLE_CHARS = 200;
/** A caller that sends this many requests with a wrong or missing token inside one minute is answered 429 for the rest of it. */
export const CAPTURE_BAD_TOKEN_LIMIT = 12;

export interface CaptureSite {
  id: CaptureSiteId;
  /** Shown to the person (Sources and the add-on's own page). */
  label: string;
  /** Host names the add-on reads for this site (no scheme, no path). */
  hosts: readonly string[];
}

/** The fixed list. The add-on may narrow it (you can remove a site there); it cannot add one. */
export const CAPTURE_SITES: readonly CaptureSite[] = [
  { id: "chatgpt", label: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com"] },
  { id: "claude", label: "Claude", hosts: ["claude.ai"] },
  { id: "gemini", label: "Gemini", hosts: ["gemini.google.com"] },
];

export function isCaptureSite(v: unknown): v is CaptureSiteId {
  return typeof v === "string" && CAPTURE_SITES.some((s) => s.id === v);
}

export function captureSiteLabel(id: CaptureSiteId): string {
  return CAPTURE_SITES.find((s) => s.id === id)?.label ?? id;
}

// ───────────────────────────── what a post looks like ─────────────────────────────

export type CaptureRole = "user" | "assistant";

export interface CaptureTurn {
  /** The site's own message id when it has one, else a hash the add-on makes; stable for that turn. */
  id: string;
  role: CaptureRole;
  text: string;
  /** When the turn finished, as the add-on saw it (ISO; absent = the receiver's clock). */
  at?: string;
}

export interface CapturePost {
  site: CaptureSiteId;
  /** The site's own conversation id (from the address), never the address itself. */
  conversation: string;
  title?: string;
  turns: CaptureTurn[];
}

export type PostProblem = "not-json" | "bad-shape" | "bad-site" | "bad-conversation" | "no-turns" | "too-many-turns" | "bad-turn" | "text-too-long";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A clean single-line id: printable, no path characters, bounded. */
export function cleanId(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s.length === 0 || s.length > CAPTURE_MAX_ID_CHARS) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@=+-]*$/.test(s)) return undefined;
  return s;
}

function isoOrUndefined(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) && t > 0 && t < 4.1e12 ? new Date(t).toISOString() : undefined;
}

/** Check a parsed body. Nothing is repaired: a post is taken as it is or refused with the first problem found. */
export function parseCapturePost(raw: unknown): { ok: true; post: CapturePost } | { ok: false; problem: PostProblem } {
  if (!isObj(raw)) return { ok: false, problem: "bad-shape" };
  if (raw.v !== CAPTURE_PROTOCOL) return { ok: false, problem: "bad-shape" };
  if (!isCaptureSite(raw.site)) return { ok: false, problem: "bad-site" };
  const conversation = cleanId(raw.conversation);
  if (conversation === undefined) return { ok: false, problem: "bad-conversation" };
  if (!Array.isArray(raw.turns) || raw.turns.length === 0) return { ok: false, problem: "no-turns" };
  if (raw.turns.length > CAPTURE_MAX_TURNS_PER_POST) return { ok: false, problem: "too-many-turns" };
  const turns: CaptureTurn[] = [];
  for (const t of raw.turns) {
    if (!isObj(t)) return { ok: false, problem: "bad-turn" };
    const id = cleanId(t.id);
    if (id === undefined || (t.role !== "user" && t.role !== "assistant") || typeof t.text !== "string") return { ok: false, problem: "bad-turn" };
    if (t.text.length > CAPTURE_MAX_TEXT_CHARS) return { ok: false, problem: "text-too-long" };
    if (t.text.trim() === "") continue;
    const turn: CaptureTurn = { id, role: t.role, text: t.text };
    const at = isoOrUndefined(t.at);
    if (at !== undefined) turn.at = at;
    turns.push(turn);
  }
  if (turns.length === 0) return { ok: false, problem: "no-turns" };
  const post: CapturePost = { site: raw.site, conversation, turns };
  if (typeof raw.title === "string" && raw.title.trim() !== "") post.title = raw.title.replace(/[\r\n\t]+/g, " ").trim().slice(0, CAPTURE_MAX_TITLE_CHARS);
  return { ok: true, post };
}

/** The spool file stem of one conversation: a hash, so no text from a page ever becomes part of a path. */
export function conversationKey(site: CaptureSiteId, conversation: string): string {
  return sha256Hex(`capture:${site}:${conversation}`).slice(0, 32);
}

// ───────────────────────────── request checks ─────────────────────────────

export type RefusalReason = "not-loopback" | "bad-host" | "bad-origin" | "no-token" | "bad-token" | "paused" | "site-off" | "too-large" | "bad-request" | "rate-limited";

const LOOPBACK_PEERS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Is the peer of the socket this computer? An unknown address counts as not. */
export function isLoopbackPeer(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && LOOPBACK_PEERS.has(remoteAddress);
}

/** The Host header a loopback request carries: the address or "localhost", with this receiver's port. A name that resolves here by a trick (DNS rebinding) is refused. */
export function hostHeaderOk(host: string | undefined, port: number): boolean {
  if (host === undefined) return false;
  const h = host.trim().toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

/** The add-on's own origin, or none (a command-line check). A page of a web site is never the add-on: a web origin is refused. */
export function originOk(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") return true;
  return /^(chrome|moz|safari-web)-extension:\/\/[A-Za-z0-9._-]+$/.test(origin);
}

export interface RequestFacts {
  remoteAddress: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  port: number;
}

/** The checks that need no secret. The first reason found, or null. */
export function checkRequestShape(f: RequestFacts): RefusalReason | null {
  if (!isLoopbackPeer(f.remoteAddress)) return "not-loopback";
  if (!hostHeaderOk(f.host, f.port)) return "bad-host";
  if (!originOk(f.origin)) return "bad-origin";
  return null;
}

/** "Bearer <token>" → the token; undefined when the header is missing or not that form. */
export function bearerOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const m = /^Bearer[ \t]+([A-Za-z0-9_-]{16,128})$/.exec(header.trim());
  return m ? m[1] : undefined;
}

// ───────────────────────────── counters ─────────────────────────────

export interface CaptureCounts {
  /** Turns taken and written to the spool. */
  accepted: number;
  /** Turns already held (same turn id): dropped, not written twice. */
  duplicates: number;
  /** Requests refused, by reason. */
  refused: Record<RefusalReason, number>;
  /** ISO of the last turn taken; "" when none. */
  lastAt: string;
}

export const REFUSAL_REASONS: readonly RefusalReason[] = ["not-loopback", "bad-host", "bad-origin", "no-token", "bad-token", "paused", "site-off", "too-large", "bad-request", "rate-limited"];

export function emptyCounts(): CaptureCounts {
  return { accepted: 0, duplicates: 0, refused: Object.fromEntries(REFUSAL_REASONS.map((r) => [r, 0])) as Record<RefusalReason, number>, lastAt: "" };
}

export function totalRefused(c: Pick<CaptureCounts, "refused">): number {
  return REFUSAL_REASONS.reduce((n, r) => n + (c.refused[r] ?? 0), 0);
}

/** A counters object read back from disk: unknown fields dropped, numbers clamped. */
export function sanitiseCounts(raw: unknown): CaptureCounts {
  const out = emptyCounts();
  if (!isObj(raw)) return out;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1e9) : 0);
  out.accepted = num(raw.accepted);
  out.duplicates = num(raw.duplicates);
  if (isObj(raw.refused)) for (const r of REFUSAL_REASONS) out.refused[r] = num(raw.refused[r]);
  if (typeof raw.lastAt === "string" && isoOrUndefined(raw.lastAt) !== undefined) out.lastAt = raw.lastAt;
  return out;
}

/** A valid port for the receiver (1024 to 65535); the default for anything else. */
export function validPort(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1024 && v <= 65535 ? v : CAPTURE_DEFAULT_PORT;
}

// ───────────────────────────── what Sources talks to ─────────────────────────────

export interface CaptureSiteStatus {
  id: CaptureSiteId;
  label: string;
  hosts: readonly string[];
  approved: boolean;
}

export interface CaptureStatus {
  /** The receiver is listening right now. */
  running: boolean;
  enabled: boolean;
  paused: boolean;
  port: number;
  address: string;
  sites: CaptureSiteStatus[];
  counts: CaptureCounts;
  /** Turns waiting in the spool for the next import pass. */
  waiting: number;
  consentAt: string;
  /** Why the receiver is not listening although capture is on. */
  problem?: "port-in-use" | "failed" | "other-computer";
}

export interface CaptureService {
  status(): Promise<CaptureStatus>;
  /** Consent was shown and accepted in Sources: sets the consent time and the approved sites, makes the token, starts listening. */
  turnOn(sites: readonly CaptureSiteId[]): Promise<CaptureStatus>;
  turnOff(): Promise<CaptureStatus>;
  setPaused(paused: boolean): Promise<void>;
  setSite(id: CaptureSiteId, approved: boolean): Promise<void>;
  setPort(port: number): Promise<void>;
  /** The token, for the person to copy into the add-on. Never logged. */
  token(): Promise<string>;
  /** A new token; the add-on is refused until it has it. */
  newToken(): Promise<void>;
  /** Save the add-on as a zip (no token inside it). Resolves to the saved path, or null when cancelled. */
  saveAddon(): Promise<string | null>;
  resetCounts(): Promise<void>;
  /** Start listening if settings say so (called once at start and after any settings change). */
  sync(): Promise<void>;
  stop(): Promise<void>;
}

