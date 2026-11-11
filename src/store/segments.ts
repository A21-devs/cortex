/**
 * Record segments: the verbatim text store. Owner: E2.
 * A segment is an immutable gzip JSONL file of SegmentLines for one conversation and one import pass (or one
 * seal of a live session). Segments are never rewritten, so OneDrive uploads each file once.
 *
 * Sequence numbers (SEGMENT-SEQ-DEADLOCK): the next number is derived from the conversation FOLDER (highest
 * existing NNNN + 1) under a per-conversation lock, never from the import cursor, and the file is published
 * with an exclusive create (link(tmp, final) → EEXIST), never rename-over. A segment whose line ids are all
 * missing from the ledger is an orphan of an interrupted pass: the importer adopts it (appends its
 * EntryRecords) before writing anything new for that conversation.
 *
 * In-place text (INPLACE-TEXTREF): `.raw/` originals are read as BYTE ranges and verified against the entry's
 * sha256 on every read; a mismatch is reported as "changed-at-source", never shown as verbatim text.
 *
 * Held secrets (SAFE-10): the importer replaces each high-confidence secret in text bound for the vault with
 * HELD_SECRET_MARKER and keeps the original under `<cache>/held/<entry-id>.json` (never synced), in marker order;
 * readers reveal marker n on this computer only (RecordReader.revealHeld).
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { gunzipToText, writeGzipExclusive } from "../node/gz";
import { errCode, withFsRetry, writeJsonAtomic } from "../node/fsAtomic";
import { decodeFile } from "../node/vaultCipher";
import { locksDirOf, withLock } from "../node/locks";
import { cacheWritablePath, resolveInVault, writablePath } from "../node/paths";
import { CortexError } from "../shared/errors";
import type { ConversationId, EntryId, IsoDate, SegmentLine, SourceKind, TextRef, VaultPath } from "../shared/types";
import { CACHE_REL, cacheLayout, CORTEX_PATHS, MONTH_DIR_RE, SEGMENT_FILE_RE, segmentDir, segmentPath, type StoreContext } from "./layout";

export interface WriteSegmentArgs {
  source: SourceKind;
  /** Month of the conversation's first message (fixes the folder for the conversation's lifetime). */
  monthKey: string;
  conv: ConversationId;
  lines: readonly SegmentLine[];
}

const ENTRY_ID_RE = /^e_[a-z2-7]{16}$/;
/** Largest byte range a `.raw/` reference may span (a passage, never a whole archive). */
const MAX_REF_BYTES = 64 * 1024 * 1024;

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function readdirSafe(abs: string): Promise<string[]> {
  try {
    return await fsp.readdir(abs);
  } catch (e) {
    if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return [];
    throw e;
  }
}

/** Segment files of a conversation folder, oldest first. */
export async function listSegments(vaultRoot: string, dir: VaultPath): Promise<VaultPath[]> {
  const names = (await readdirSafe(resolveInVault(vaultRoot, dir))).filter((n) => SEGMENT_FILE_RE.test(n));
  return names.sort().map((n) => `${dir}/${n}`);
}

/**
 * The segment folder a conversation already has under its source (any month), or null for a new conversation.
 * The folder is fixed at first import, so later passes (and seals of live sessions) must reuse it.
 */
export async function findSegmentDir(vaultRoot: string, source: SourceKind, conv: ConversationId): Promise<VaultPath | null> {
  const base = `${CORTEX_PATHS.chats}/${source}`;
  const months = (await readdirSafe(resolveInVault(vaultRoot, base))).filter((m) => MONTH_DIR_RE.test(m)).sort();
  for (const month of months) {
    const dir = segmentDir(source, month, conv);
    try {
      if ((await fsp.stat(resolveInVault(vaultRoot, dir))).isDirectory()) return dir;
    } catch {
      // not in this month
    }
  }
  return null;
}

/** Highest existing segment number in a conversation folder + 1 (1 for a new folder). */
export async function nextSegmentSeq(vaultRoot: string, dir: VaultPath): Promise<number> {
  let max = 0;
  for (const n of await readdirSafe(resolveInVault(vaultRoot, dir))) {
    const m = SEGMENT_FILE_RE.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function validateLine(l: SegmentLine, conv: ConversationId, i: number): void {
  if (l === null || typeof l !== "object" || l.v !== 1) throw new CortexError("E_INTERNAL", `segment line ${i} is not a v1 line`);
  if (typeof l.id !== "string" || !ENTRY_ID_RE.test(l.id)) throw new CortexError("E_INTERNAL", `segment line ${i} has a bad entry id`);
  if (typeof l.text !== "string") throw new CortexError("E_INTERNAL", `segment line ${i} has no text`);
  if (l.conv !== undefined && l.conv !== conv) throw new CortexError("E_INTERNAL", `segment line ${i} belongs to another conversation`);
  if (l.sha !== sha256Text(l.text)) throw new CortexError("E_INTERNAL", `segment line ${i} has a wrong sha256`);
}

/**
 * Write one new immutable segment. The number comes from the folder; an existing file is never replaced. Every
 * line is checked (v1, entry id, conversation, sha256 of its text) before anything is written.
 */
export async function writeSegment(ctx: StoreContext, args: WriteSegmentArgs): Promise<{ path: VaultPath; seq: number; bytes: number }> {
  if (args.lines.length === 0) throw new CortexError("E_INTERNAL", "refusing to write an empty segment");
  const seen = new Set<string>();
  args.lines.forEach((l, i) => {
    validateLine(l, args.conv, i);
    if (seen.has(l.id)) throw new CortexError("E_INTERNAL", `segment line ${i} repeats an entry id`);
    seen.add(l.id);
  });
  const dir = segmentDir(args.source, args.monthKey, args.conv);
  const text = args.lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  return withLock(locksDirOf(ctx.cacheDir), `segdir:${dir}`, { owner: ctx.owner, staleMs: ctx.lockStaleMs }, async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const seq = await nextSegmentSeq(ctx.vaultRoot, dir);
      const rel = segmentPath(args.source, args.monthKey, args.conv, seq);
      try {
        const bytes = await writeGzipExclusive(writablePath(ctx.vaultRoot, rel), text);
        return { path: rel, seq, bytes };
      } catch (e) {
        if (e instanceof CortexError && e.detail?.exists === true) continue; // another computer took this number
        throw e;
      }
    }
    throw new CortexError("E_IO", "could not allocate a segment number", { retryable: true });
  });
}

/**
 * Every line of a segment at its own position (null where a line is not a valid SegmentLine), so TextRef line
 * numbers stay exact even around a damaged line.
 */
export async function readSegmentLines(vaultRoot: string, seg: VaultPath): Promise<(SegmentLine | null)[]> {
  const raw = await withFsRetry(() => fsp.readFile(resolveInVault(vaultRoot, seg)));
  const text = await gunzipToText(decodeFile(raw)); // an encrypted segment opens with the key; a legacy plain one reads as before
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.map((p) => {
    const line = p.endsWith("\r") ? p.slice(0, -1) : p;
    try {
      const v = JSON.parse(line) as SegmentLine;
      return v !== null && typeof v === "object" && typeof v.id === "string" && typeof v.text === "string" ? v : null;
    } catch {
      return null;
    }
  });
}

/** The valid lines of a segment, in order (positions shift past a damaged line: use readSegmentLines for refs). */
export async function readSegment(vaultRoot: string, seg: VaultPath): Promise<SegmentLine[]> {
  return (await readSegmentLines(vaultRoot, seg)).filter((l): l is SegmentLine => l !== null);
}

/** Segments of a conversation folder whose line ids are all unknown to the ledger (interrupted passes). */
export async function orphanSegments(vaultRoot: string, dir: VaultPath, known: ReadonlySet<string>): Promise<VaultPath[]> {
  const out: VaultPath[] = [];
  for (const rel of await listSegments(vaultRoot, dir)) {
    let lines: SegmentLine[];
    try {
      lines = await readSegment(vaultRoot, rel);
    } catch {
      continue; // not on this computer yet; the next pass looks again
    }
    if (lines.length > 0 && lines.every((l) => !known.has(l.id))) out.push(rel);
  }
  return out;
}

/** Approximate memory of decoded lines (UTF-16 text plus object overhead). */
function weigh(lines: readonly (SegmentLine | null)[]): number {
  let n = 0;
  for (const l of lines) n += 160 + (l ? l.text.length * 2 + l.id.length * 2 + l.nid.length * 2 : 0);
  return n;
}

/**
 * Small LRU of decompressed segments for readers (reader, thread, Read rows, agent prompts), bounded by count
 * AND by approximate memory; concurrent requests for the same segment share one read.
 */
export class SegmentCache {
  private readonly map = new Map<string, { lines: (SegmentLine | null)[]; bytes: number }>();
  private readonly inflight = new Map<string, Promise<(SegmentLine | null)[]>>();
  private bytes = 0;

  constructor(
    private readonly vaultRoot: string,
    private readonly capacity = 32,
    private readonly maxBytes = 96 * 1024 * 1024,
  ) {}

  /** Lines at their positions (null for a damaged line). */
  async lines(seg: VaultPath): Promise<(SegmentLine | null)[]> {
    const hit = this.map.get(seg);
    if (hit) {
      this.map.delete(seg);
      this.map.set(seg, hit);
      return hit.lines;
    }
    const pending = this.inflight.get(seg);
    if (pending) return pending;
    const p = readSegmentLines(this.vaultRoot, seg)
      .then((lines) => {
        const bytes = weigh(lines);
        if (bytes <= this.maxBytes) {
          this.map.set(seg, { lines, bytes });
          this.bytes += bytes;
          this.evict();
        }
        return lines;
      })
      .finally(() => this.inflight.delete(seg));
    this.inflight.set(seg, p);
    return p;
  }

  /** Valid lines only, in order. */
  async get(seg: VaultPath): Promise<SegmentLine[]> {
    return (await this.lines(seg)).filter((l): l is SegmentLine => l !== null);
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  private evict(): void {
    while (this.map.size > this.capacity || this.bytes > this.maxBytes) {
      const first = this.map.keys().next();
      if (first.done) break;
      const v = this.map.get(first.value);
      this.map.delete(first.value);
      this.bytes -= v?.bytes ?? 0;
    }
  }
}

export type ReadTextResult = { ok: true; text: string } | { ok: false; reason: "changed-at-source" | "not-local" | "missing" };

/** Reads staged lines of a live session (store/stage.ts stageLookup); injected so readers work on this computer only. */
export type StageLookup = (conv: ConversationId, line: number) => Promise<string | undefined>;

export interface ReadTextOptions {
  cache?: SegmentCache;
  stage?: StageLookup;
  /** The entry the reference belongs to: a segment line with another id is reported missing (stale ref). */
  entryId?: string;
}

function failure(e: unknown): ReadTextResult {
  const code = errCode(e);
  // ENOENT / ENOTDIR: the file is gone. Anything else (EIO, cloud-provider errors, sharing violations that
  // outlived the retries, a gzip of a placeholder) means the bytes are not readable on this computer right now.
  return { ok: false, reason: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "not-local" };
}

/**
 * Resolve the verbatim text behind a TextRef. Never throws.
 *  - segment: the line at `ref.line`; with `entryId` its id must match; with `expectedSha` the line's text must
 *    hash to it (a damaged or foreign line reads as missing);
 *  - file: a `.raw/` byte range whose sha256 must equal `expectedSha` ("changed-at-source" otherwise);
 *  - stage: a live message staged on this computer (missing elsewhere or after its seal).
 */
export async function readText(vaultRoot: string, ref: TextRef, expectedSha: string, opts: ReadTextOptions = {}): Promise<ReadTextResult> {
  try {
    if (ref.store === "segment") {
      if (!Number.isInteger(ref.line) || ref.line < 0) return { ok: false, reason: "missing" };
      const lines = opts.cache ? await opts.cache.lines(ref.seg) : await readSegmentLines(vaultRoot, ref.seg);
      const line = lines[ref.line];
      if (!line) return { ok: false, reason: "missing" };
      if (opts.entryId !== undefined && line.id !== opts.entryId) return { ok: false, reason: "missing" };
      if (expectedSha && line.sha !== expectedSha && sha256Text(line.text) !== expectedSha) return { ok: false, reason: "missing" };
      return { ok: true, text: line.text };
    }
    if (ref.store === "stage") {
      if (!Number.isInteger(ref.line) || ref.line < 0 || !opts.stage) return { ok: false, reason: "missing" };
      const text = await opts.stage(ref.conv, ref.line);
      if (text === undefined) return { ok: false, reason: "missing" };
      if (expectedSha && sha256Text(text) !== expectedSha) return { ok: false, reason: "missing" };
      return { ok: true, text };
    }
    const { byteStart, byteEnd } = ref;
    if (!Number.isInteger(byteStart) || !Number.isInteger(byteEnd) || byteStart < 0 || byteEnd < byteStart || byteEnd - byteStart > MAX_REF_BYTES) {
      return { ok: false, reason: "missing" };
    }
    const abs = resolveInVault(vaultRoot, ref.path);
    const fh = await withFsRetry(() => fsp.open(abs, "r"));
    try {
      const len = byteEnd - byteStart;
      const buf = Buffer.alloc(len);
      let got = 0;
      while (got < len) {
        const { bytesRead } = await fh.read(buf, got, len - got, byteStart + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      const bytes = buf.subarray(0, got);
      if (got !== len || createHash("sha256").update(bytes).digest("hex") !== expectedSha) return { ok: false, reason: "changed-at-source" };
      return { ok: true, text: bytes.toString("utf8") };
    } finally {
      await fh.close();
    }
  } catch (e) {
    return failure(e);
  }
}

/** Every line of a conversation's segment folder, deduplicated by entry id, in conversation order (`i`, then file order). */
export async function readConversationLines(vaultRoot: string, segDir: VaultPath, cache?: SegmentCache): Promise<{ line: SegmentLine; seg: VaultPath; n: number }[]> {
  const out: { line: SegmentLine; seg: VaultPath; n: number; order: number }[] = [];
  const seen = new Set<string>();
  let order = 0;
  for (const seg of await listSegments(vaultRoot, segDir)) {
    const lines = cache ? await cache.lines(seg) : await readSegmentLines(vaultRoot, seg);
    lines.forEach((line, n) => {
      if (!line || seen.has(line.id)) return;
      seen.add(line.id);
      out.push({ line, seg, n, order: order++ });
    });
  }
  out.sort((a, b) => (a.line.i ?? Number.MAX_SAFE_INTEGER) - (b.line.i ?? Number.MAX_SAFE_INTEGER) || a.order - b.order);
  return out.map(({ line, seg, n }) => ({ line, seg, n }));
}

/** Absolute folder of a segment (for orphan scans by the importer). */
export function segmentFolderAbs(vaultRoot: string, dir: VaultPath): string {
  return resolveInVault(vaultRoot, dir);
}

// ───────────────────────────── held secrets (SAFE-10) ─────────────────────────────

/** What the importer writes in place of a secret (shared/secrets.ts scanSecrets' default replacement). */
export const HELD_SECRET_MARKER = "[secret kept on this computer]";

export interface HeldSecrets {
  v: 1;
  entry: EntryId;
  at: IsoDate;
  /** Originals in marker order: marker n of the stored text replaced `secrets[n].text`. */
  secrets: { n: number; text: string; kind?: string }[];
}

/** Number of secret markers in a stored text. */
export function countSecretMarkers(text: string): number {
  let n = 0;
  for (let i = text.indexOf(HELD_SECRET_MARKER); i >= 0; i = text.indexOf(HELD_SECRET_MARKER, i + HELD_SECRET_MARKER.length)) n++;
  return n;
}

/**
 * Keep the originals of an entry's secrets on this computer (`<cache>/held/<entry-id>.json`, atomic replace).
 * Called by the importer right after it replaced them with HELD_SECRET_MARKER (in the same order).
 */
export async function holdSecrets(ctx: Pick<StoreContext, "cacheDir">, entry: EntryId, secrets: readonly { text: string; kind?: string }[]): Promise<void> {
  if (!ENTRY_ID_RE.test(entry)) throw new CortexError("E_INTERNAL", "bad entry id for held secrets");
  if (secrets.length === 0) return;
  const file: HeldSecrets = {
    v: 1,
    entry,
    at: new Date().toISOString(),
    secrets: secrets.map((s, n) => (s.kind === undefined ? { n, text: String(s.text) } : { n, text: String(s.text), kind: s.kind })),
  };
  await fsp.mkdir(cacheLayout(ctx.cacheDir).held, { recursive: true });
  await writeJsonAtomic(cacheWritablePath(ctx.cacheDir, CACHE_REL.held(entry)), file);
}

/** The held originals of an entry, or null when none are kept on this computer (or the file is unreadable). */
export async function readHeld(cacheDir: string, entry: string): Promise<HeldSecrets | null> {
  if (!ENTRY_ID_RE.test(entry)) return null;
  let text: string;
  try {
    text = await fsp.readFile(path.join(cacheLayout(cacheDir).held, `${entry}.json`), "utf8");
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(text) as HeldSecrets;
    if (v?.v !== 1 || v.entry !== entry || !Array.isArray(v.secrets)) return null;
    const secrets = v.secrets.filter((s) => s !== null && typeof s === "object" && Number.isInteger(s.n) && typeof s.text === "string");
    return { ...v, secrets };
  } catch {
    return null;
  }
}
