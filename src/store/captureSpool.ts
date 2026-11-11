/**
 * Live capture, the local side (node only): the per-install token, the spool of turns the browser add-on posted,
 * and the counters of what the receiver refused. Everything lives in the machine-local cache under `capture/`
 * (never in the vault, never synced); "Clear local cache" does not touch it.
 *
 *   capture/token.json          { v, token, createdAt }   owner-only where the system has modes
 *   capture/counts.json         the counters (shared/capture.ts CaptureCounts)
 *   capture/spool/<site>/<conversationKey>.jsonl
 *       {"t":"meta","site","conversation","title"?,"at"}      first line (a later meta line replaces the title)
 *       {"t":"turn","id","role","text","at","rx"}             one per finished turn, in arrival order
 *
 * The spool is only a waiting room: importers/capture.ts reads it through the same engine as the other live
 * sources (screening, staging, sealing), and prunes a file once it has been read and left alone for a while.
 * Names on disk come from a hash of the site and conversation id, never from page text.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { CAPTURE_SITES, conversationKey, emptyCounts, sanitiseCounts, type CaptureCounts, type CapturePost, type CaptureTurn } from "../shared/capture";
import type { CaptureSiteId } from "../shared/settings";
import { appendLines, ensureCacheDir, readJsonIfExists, readTextIfExists, writeFileAtomic } from "../node/fsAtomic";
import { cacheWritablePath } from "../node/paths";

const DIR = "capture";
const TOKEN_FILE = `${DIR}/token.json`;
const COUNTS_FILE = `${DIR}/counts.json`;
export const SPOOL_DIR = `${DIR}/spool`;

export interface CaptureDirs {
  root: string;
  spool: string;
}

export function captureDirs(cacheDir: string): CaptureDirs {
  return { root: path.join(cacheDir, DIR), spool: path.join(cacheDir, SPOOL_DIR) };
}

// ───────────────────────────── token ─────────────────────────────

interface TokenFile {
  v: 1;
  token: string;
  createdAt: string;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

async function ownerOnly(abs: string): Promise<void> {
  try {
    await fsp.chmod(abs, 0o600);
  } catch {
    // systems without POSIX modes: the cache lives under the person's own profile
  }
}

export const newToken = (): string => randomBytes(32).toString("base64url");

async function writeToken(cacheDir: string, token: string, now: number): Promise<void> {
  await ensureCacheDir(cacheDir);
  const target = cacheWritablePath(cacheDir, TOKEN_FILE);
  const file: TokenFile = { v: 1, token, createdAt: new Date(now).toISOString() };
  await writeFileAtomic(target, `${JSON.stringify(file)}\n`);
  await ownerOnly(target);
}

/** The install's token; made (once) the first time capture is turned on. */
export async function loadOrCreateToken(cacheDir: string, now: () => number = Date.now): Promise<string> {
  try {
    const raw = await readJsonIfExists<TokenFile>(path.join(cacheDir, TOKEN_FILE));
    if (raw && raw.v === 1 && typeof raw.token === "string" && TOKEN_RE.test(raw.token)) return raw.token;
  } catch {
    // a damaged token file is replaced: the add-on then needs the new one
  }
  const token = newToken();
  await writeToken(cacheDir, token, now());
  return token;
}

/** Make a new token; the add-on stops being accepted until it is given the new one. */
export async function rotateToken(cacheDir: string, now: () => number = Date.now): Promise<string> {
  const token = newToken();
  await writeToken(cacheDir, token, now());
  return token;
}

/** Compare in constant time (over digests, so the lengths never differ). */
export function tokenMatches(expected: string, supplied: string | undefined): boolean {
  if (supplied === undefined) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(a, b);
}

// ───────────────────────────── counters ─────────────────────────────

export async function loadCounts(cacheDir: string): Promise<CaptureCounts> {
  try {
    return sanitiseCounts(await readJsonIfExists<unknown>(path.join(cacheDir, COUNTS_FILE)));
  } catch {
    return emptyCounts();
  }
}

export async function saveCounts(cacheDir: string, counts: CaptureCounts): Promise<void> {
  await ensureCacheDir(cacheDir);
  await writeFileAtomic(cacheWritablePath(cacheDir, COUNTS_FILE), `${JSON.stringify(counts)}\n`);
}

// ───────────────────────────── spool ─────────────────────────────

export interface SpoolTurnLine {
  t: "turn";
  id: string;
  role: CaptureTurn["role"];
  text: string;
  at: string;
  rx: string;
}

export interface SpoolMetaLine {
  t: "meta";
  site: CaptureSiteId;
  conversation: string;
  title?: string;
  at: string;
}

export interface SpoolConversation {
  site: CaptureSiteId;
  conversation: string;
  title?: string;
  /** The turns in arrival order, ids unique. */
  turns: SpoolTurnLine[];
}

/** One spool file's text → the conversation; a line that does not parse is skipped (a torn last line is normal after a crash). */
export function parseSpool(text: string): SpoolConversation | null {
  let meta: SpoolMetaLine | undefined;
  let title: string | undefined;
  const turns: SpoolTurnLine[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof o !== "object" || o === null) continue;
    const r = o as Record<string, unknown>;
    if (r.t === "meta" && typeof r.site === "string" && CAPTURE_SITES.some((s) => s.id === r.site) && typeof r.conversation === "string") {
      meta ??= r as unknown as SpoolMetaLine;
      if (typeof r.title === "string" && r.title !== "") title = r.title;
    } else if (r.t === "turn" && typeof r.id === "string" && typeof r.text === "string" && (r.role === "user" || r.role === "assistant") && typeof r.at === "string") {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      turns.push({ t: "turn", id: r.id, role: r.role, text: r.text, at: r.at, rx: typeof r.rx === "string" ? r.rx : r.at });
    }
  }
  if (!meta) return null;
  const out: SpoolConversation = { site: meta.site, conversation: meta.conversation, turns };
  if (title !== undefined) out.title = title;
  return out;
}

export interface AppendResult {
  added: number;
  duplicates: number;
}

/** A spool of one cache folder. Appends are serialised, and the ids already held are remembered per file. */
export class Spool {
  private readonly ids = new Map<string, Set<string>>();
  private readonly titles = new Map<string, string>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cacheDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Add the turns of one post that the spool does not hold yet (matched by turn id). */
  append(post: CapturePost): Promise<AppendResult> {
    const run = this.chain.then(() => this.appendNow(post));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async appendNow(post: CapturePost): Promise<AppendResult> {
    const key = conversationKey(post.site, post.conversation);
    const rel = `${SPOOL_DIR}/${post.site}/${key}.jsonl`;
    const abs = path.join(this.cacheDir, rel);
    let known = this.ids.get(rel);
    if (known === undefined) {
      known = new Set<string>();
      const existing = await readTextIfExists(abs);
      if (existing !== null) {
        const conv = parseSpool(existing);
        for (const t of conv?.turns ?? []) known.add(t.id);
        if (conv?.title !== undefined) this.titles.set(rel, conv.title);
      }
      this.ids.set(rel, known);
      // Bounded: a long session of many conversations keeps the most recent ones.
      if (this.ids.size > 256) {
        const first = this.ids.keys().next().value;
        if (first !== undefined && first !== rel) {
          this.ids.delete(first);
          this.titles.delete(first);
        }
      }
    }
    const rx = new Date(this.now()).toISOString();
    const fresh = post.turns.filter((t) => !known.has(t.id));
    const duplicates = post.turns.length - fresh.length;
    const exists = (await fsp.stat(abs).catch(() => null))?.isFile() === true;
    const lines: string[] = [];
    if (!exists) lines.push(JSON.stringify({ t: "meta", site: post.site, conversation: post.conversation, ...(post.title !== undefined ? { title: post.title } : {}), at: rx } satisfies SpoolMetaLine));
    else if (post.title !== undefined && post.title !== this.titles.get(rel)) lines.push(JSON.stringify({ t: "meta", site: post.site, conversation: post.conversation, title: post.title, at: rx } satisfies SpoolMetaLine));
    if (post.title !== undefined) this.titles.set(rel, post.title);
    for (const t of fresh) {
      lines.push(JSON.stringify({ t: "turn", id: t.id, role: t.role, text: t.text, at: t.at ?? rx, rx } satisfies SpoolTurnLine));
      known.add(t.id);
    }
    if (lines.length > 0) {
      await ensureCacheDir(this.cacheDir);
      await appendLines(cacheWritablePath(this.cacheDir, rel), `${lines.join("\n")}\n`);
    }
    return { added: fresh.length, duplicates };
  }
}

/** The spool files of the approved sites: stat only. */
export async function listSpool(cacheDir: string, sites: readonly CaptureSiteId[]): Promise<{ site: CaptureSiteId; abs: string; bytes: number; mtimeMs: number }[]> {
  const out: { site: CaptureSiteId; abs: string; bytes: number; mtimeMs: number }[] = [];
  for (const site of sites) {
    const dir = path.join(captureDirs(cacheDir).spool, site);
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names.sort()) {
      if (!/^[0-9a-f]{32}\.jsonl$/.test(n)) continue;
      const abs = path.join(dir, n);
      const st = await fsp.stat(abs).catch(() => null);
      if (st?.isFile()) out.push({ site, abs, bytes: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

/** How many turns wait in the spool for the approved sites (for the panel); counts lines, reads nothing into memory at once. */
export async function spoolTurnCount(cacheDir: string, sites: readonly CaptureSiteId[]): Promise<number> {
  let n = 0;
  for (const f of await listSpool(cacheDir, sites)) {
    const text = await readTextIfExists(f.abs);
    if (text !== null) n += parseSpool(text)?.turns.length ?? 0;
  }
  return n;
}
