/**
 * Date evidence that is produced after an import: local date seals and git first-seen dates, plus the optional
 * public timestamp of a seal (CORTEX-UX 5.14 "Date evidence", 5.27 Advanced "Date seals"). Owner: GAPS-DATA.
 *
 * Seals (setting `advanced.dateSeals.sealLocally`, on by default for new records). Entries that no block holds yet are grouped,
 * oldest first, into blocks of at most 5,000. A block is one immutable JSON file
 * `.vault-meta/cortex/seals/<computer>/<n>.json`: its number, time, the hash of the previous block of this
 * computer, a Merkle root over `sha256(id \n textSha256)` of every entry, and the entry ids. Because each block
 * names the hash of its predecessor, changing or dropping an earlier block breaks every later one (`verifyChain`).
 * `<computer>` is the first 8 hex digits of sha256(hostname), so two computers on one OneDrive never write the
 * same file. A seal proves only that the text existed on a computer you control by that time; the reader calls it
 * a "provable bound", never a date the text was written.
 *
 * Public timestamp (explicit button; the only thing here that touches the network). The hash of this computer's
 * newest block is sent to an OpenTimestamps calendar (a fingerprint, never any text); the reply is kept as a
 * standard `.ots` file beside the block. The calendar commits the hash to Bitcoin later, which the standard
 * `ots upgrade` tool completes; Cortex shows the date it asked, which is the date the calendar vouches for.
 * Every block up to and including that one gains "Timestamped publicly on <date>".
 *
 * Git first-seen. For entries whose original is a file inside the vault (raw documents and vault notes), the
 * date the file's current content first reached a git commit is an upper bound on when that content existed. It
 * counts only while the file still holds the bytes that were imported (sha256 equals the entry's source hash) and
 * a commit introduced exactly that blob (`git hash-object` applies the repository's own line-ending rules).
 * Results live in the cache (`state/git-first-seen.json`): they can always be rebuilt.
 */
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendLines, readJsonIfExists, readSealedJson, readTextIfExists, writeFileAtomic, writeJsonAtomic, writeSealedJson } from "../node/fsAtomic";
import { sha256Bytes } from "../node/hash";
import { locksDirOf, withLock } from "../node/locks";
import { mapLimit } from "../node/pool";
import { cacheWritablePath, resolveInVault, writablePath } from "../node/paths";
import { CortexError } from "../shared/errors";
import { cleanSignerName, isHex, keyFingerprint, signedStatement } from "../shared/sign";
import type { EntryRecord, IsoDate } from "../shared/types";
import { ed25519Sign, ed25519Verify, loadOrCreateSigningKey, migrateSalts, newSalt, readSalt, saveSalts } from "../node/sign";
import { CORTEX_PATHS, type StoreContext } from "./layout";
import type { LedgerStore } from "./ledger";
import { bitcoinSteps, EXPLORER_HOST, getBlockHeader, getCommitment, MAX_PROOF_BYTES, MIN_DIFFICULTY, parseOts, readCapped, upgradeProof, verifyBitcoinHeader, type CommitmentGet, type HeaderGet } from "./otsProof";

export const SEAL_BLOCK_MAX = 5000;
const SEALS_DIR = `${CORTEX_PATHS.meta}/seals`;
const BLOCK_FILE = /^(\d{6})\.json$/;
const STAMP_FILE = /^(\d{6})\.json$/;
const HOST_DIR = /^[0-9a-f]{8}$/;
const CURSOR_FILE = "state/evidence-cursor.json";
const GIT_FILE = "state/git-first-seen.json";
const MAX_GIT_FILE_BYTES = 20 * 1024 * 1024;
/** A path with no commit yet is looked at again after this long. */
const GIT_RECHECK_MS = 6 * 3600 * 1000;

/** The OpenTimestamps calendar that is asked (the project's own server). */
export const OTS_CALENDAR = "https://alice.btc.calendar.opentimestamps.org";
const OTS_MAGIC = Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex");

export const pad6 = (n: number): string => String(n).padStart(6, "0");

/** This computer's folder name under seals/. */
export function sealHostKey(hostname: string = os.hostname()): string {
  return createHash("sha256").update(hostname).digest("hex").slice(0, 8);
}

// ───────────────────────────── blocks ─────────────────────────────

export interface SealBlockV1 {
  v: 1;
  n: number;
  at: IsoDate;
  /** Hash of the previous block of this computer; "" for block 1. */
  prev: string;
  count: number;
  /** Merkle root over the entries' leaves. */
  root: string;
  ids: string[];
  /** sha256 over "n|at|prev|count|root". */
  hash: string;
}

/** Version 2: salted leaves, a public fingerprint, and an Ed25519 signature (see the header). */
export interface SealBlockV2 extends Omit<SealBlockV1, "v"> {
  v: 2;
  /** Ed25519 public key (hex) that signed this block; part of the block hash. */
  key: string;
  /** HMAC-SHA256(salt, hash), hex: the only thing a calendar is ever sent for this block. */
  fp: string;
  /** Ed25519 signature (hex) over `signedStatement(hash, by)`. */
  sig: string;
  /** Display name inside the signed statement, when the person chose one. */
  by?: string;
}

export type SealBlock = SealBlockV1 | SealBlockV2;

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const hmacHex = (saltHex: string, data: string | Buffer): string => createHmac("sha256", Buffer.from(saltHex, "hex")).update(data).digest("hex");

/** `sha256(id 
 textSha256)`: what a version 1 block commits to for one entry. */
export function sealLeaf(id: string, textSha256: string): string {
  return sha(`${id}
${textSha256}`);
}

/** The salted leaf of a version 2 block: `HMAC-SHA256(salt, id 
 textSha256)`. */
export function sealLeafV2(saltHex: string, id: string, textSha256: string): string {
  return hmacHex(saltHex, `${id}
${textSha256}`);
}

/** Pairwise sha256 up to one root; an odd node is paired with itself. An empty list has the root of "". */
export function merkleRoot(leaves: readonly string[]): string {
  if (leaves.length === 0) return sha("");
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha(`${level[i]}${level[i + 1] ?? level[i]}`));
    level = next;
  }
  return level[0] as string;
}

export function blockHash(b: Pick<SealBlockV1, "n" | "at" | "prev" | "count" | "root">): string {
  return sha(`${b.n}|${b.at}|${b.prev}|${b.count}|${b.root}`);
}

/** Version 2 hash: a different shape (it starts "2|") that also commits to the signing key. */
export function blockHashV2(b: Pick<SealBlockV2, "n" | "at" | "prev" | "count" | "root" | "key">): string {
  return sha(`2|${b.n}|${b.at}|${b.prev}|${b.count}|${b.root}|${b.key}`);
}

/** The public fingerprint of a version 2 block for its salt. */
export function publicFingerprint(saltHex: string, hash: string): string {
  return hmacHex(saltHex, Buffer.from(hash, "hex"));
}

/** What is sent to a calendar for a block, and what its .ots proof stamps. */
export function blockDigest(b: SealBlock): string {
  return b.v === 2 ? b.fp : b.hash;
}

function validBlock(raw: unknown, n: number): SealBlock | null {
  if (raw === null || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if ((b.v !== 1 && b.v !== 2) || b.n !== n || typeof b.at !== "string" || !Number.isFinite(Date.parse(b.at))) return null;
  if (typeof b.prev !== "string" || typeof b.root !== "string" || typeof b.hash !== "string" || typeof b.count !== "number") return null;
  if (!Array.isArray(b.ids) || b.ids.length !== b.count || !b.ids.every((x) => typeof x === "string")) return null;
  const base = { n, at: b.at, prev: b.prev, count: b.count, root: b.root, ids: b.ids as string[], hash: b.hash };
  if (b.v === 1) {
    const block: SealBlockV1 = { v: 1, ...base };
    return blockHash(block) === block.hash ? block : null;
  }
  if (!isHex(b.key, 32) || !isHex(b.fp, 32) || !isHex(b.sig, 64) || (b.by !== undefined && typeof b.by !== "string")) return null;
  const block: SealBlockV2 = { v: 2, ...base, key: b.key, fp: b.fp, sig: b.sig, ...(typeof b.by === "string" && b.by !== "" ? { by: b.by } : {}) };
  if (blockHashV2(block) !== block.hash) return null;
  return ed25519Verify(block.key, signedStatement(block.hash, block.by), block.sig) ? block : null;
}

async function listDir(abs: string): Promise<string[]> {
  try {
    return await fsp.readdir(abs);
  } catch {
    return [];
  }
}

/** The folder names (one per computer) under seals/. */
export async function sealHosts(vaultRoot: string): Promise<string[]> {
  return (await listDir(resolveInVault(vaultRoot, SEALS_DIR))).filter((h) => HOST_DIR.test(h)).sort();
}

/** The blocks of one computer in order. A file that does not parse or does not hash to its own name stops the list. */
export async function readSealChain(vaultRoot: string, host: string): Promise<{ blocks: SealBlock[]; broken: boolean }> {
  const dir = resolveInVault(vaultRoot, `${SEALS_DIR}/${host}`);
  const nums = (await listDir(dir)).map((f) => BLOCK_FILE.exec(f)?.[1]).filter((x): x is string => x !== undefined).map(Number).sort((a, b) => a - b);
  const blocks: SealBlock[] = [];
  let broken = false;
  for (const n of nums) {
    if (n !== blocks.length + 1) {
      broken = true;
      break;
    }
    let raw: unknown = null;
    try {
      raw = await readSealedJson<unknown>(path.join(dir, `${pad6(n)}.json`));
    } catch {
      raw = null;
    }
    const b = validBlock(raw, n);
    if (!b || b.prev !== (blocks[blocks.length - 1]?.hash ?? "")) {
      broken = true;
      break;
    }
    blocks.push(b);
  }
  return { blocks, broken };
}

// ───────────────────────────── sealing ─────────────────────────────

export interface SealRunResult {
  /** Blocks written by this call. */
  blocks: number;
  /** Entries newly sealed. */
  entries: number;
  /** Blocks on this computer now. */
  total: number;
}

async function sealedIds(vaultRoot: string): Promise<Set<string>> {
  const out = new Set<string>();
  const root = resolveInVault(vaultRoot, SEALS_DIR);
  for (const h of await listDir(root)) {
    if (!HOST_DIR.test(h)) continue;
    const { blocks } = await readSealChain(vaultRoot, h);
    for (const b of blocks) for (const id of b.ids) out.add(id);
  }
  return out;
}

/** Seal every entry no block holds yet into new blocks of this computer. Resolves quietly when another run holds the lock. */
export async function sealNewEntries(
  ctx: StoreContext,
  ledger: LedgerStore,
  opts: { now?: () => number; host?: string; maxBlock?: number; /** 1 writes the older block format (tests, tools). */ format?: 1 | 2; /** Display name put inside the signed statement. */ signAs?: string } = {},
): Promise<SealRunResult> {
  const now = opts.now ?? Date.now;
  const host = opts.host ?? sealHostKey();
  const max = Math.max(1, Math.floor(opts.maxBlock ?? SEAL_BLOCK_MAX));
  const format = opts.format ?? 2;
  const signAs = cleanSignerName(opts.signAs);
  const run = async (): Promise<SealRunResult> => {
    const have = await sealedIds(ctx.vaultRoot);
    const fresh: { id: string; sha: string; added: string }[] = [];
    for await (const e of ledger.readAll("entries")) {
      if (have.has(e.id) || typeof e.textSha256 !== "string") continue;
      have.add(e.id);
      fresh.push({ id: e.id, sha: e.textSha256, added: e.addedAt });
    }
    // Salts an earlier version kept only in the local cache are copied into the record (nothing is removed from the cache).
    await migrateSalts(ctx.cacheDir, ctx.vaultRoot).catch((e: unknown) => ctx.log.debug("salt migration skipped", { error: e instanceof Error ? e.message : String(e) }));
    const chain = await readSealChain(ctx.vaultRoot, host);
    if (chain.broken) throw new CortexError("E_IO", "the seal chain of this computer is damaged; new blocks would not link to it", { detail: { reason: "seal-chain" } });
    if (fresh.length === 0) return { blocks: 0, entries: 0, total: chain.blocks.length };
    fresh.sort((a, b) => (a.added < b.added ? -1 : a.added > b.added ? 1 : a.id < b.id ? -1 : 1));
    let prev = chain.blocks[chain.blocks.length - 1]?.hash ?? "";
    let n = chain.blocks.length;
    let blocks = 0;
    // The signing key is made the first time anything is sealed and stays on this computer.
    const signing = format === 2 ? await loadOrCreateSigningKey(ctx.cacheDir, now) : null;
    for (let i = 0; i < fresh.length; i += max) {
      const part = fresh.slice(i, i + max).sort((a, b) => (a.id < b.id ? -1 : 1));
      n++;
      const at = new Date(now()).toISOString();
      let block: SealBlock;
      if (signing) {
        const salt = newSalt();
        const body = { n, at, prev, count: part.length, root: merkleRoot(part.map((p) => sealLeafV2(salt, p.id, p.sha))), key: signing.publicKey };
        const hash = blockHashV2(body);
        block = { v: 2, ...body, ids: part.map((p) => p.id), hash, fp: publicFingerprint(salt, hash), sig: ed25519Sign(signing.seed, signedStatement(hash, signAs)), ...(signAs !== "" ? { by: signAs } : {}) };
        // the salt is kept before the block exists, so a block never lacks its salt
        await saveSalts(ctx.cacheDir, { [`${host}/${n}`]: salt }, ctx.vaultRoot);
      } else {
        const body = { n, at, prev, count: part.length, root: merkleRoot(part.map((p) => sealLeaf(p.id, p.sha))) };
        block = { v: 1, ...body, ids: part.map((p) => p.id), hash: blockHash(body) };
      }
      await writeSealedJson(writablePath(ctx.vaultRoot, `${SEALS_DIR}/${host}/${pad6(n)}.json`), block);
      prev = block.hash;
      blocks++;
    }
    ctx.log.debug("sealed entries", { blocks, entries: fresh.length });
    return { blocks, entries: fresh.length, total: n };
  };
  try {
    return await withLock(locksDirOf(ctx.cacheDir), "runner:seals", { owner: ctx.owner, staleMs: ctx.lockStaleMs, waitMs: 0 }, run);
  } catch (e) {
    if (e instanceof CortexError && e.code === "E_LOCKED") return { blocks: 0, entries: 0, total: (await readSealChain(ctx.vaultRoot, host)).blocks.length };
    throw e;
  }
}

export interface OutwardRow {
  /** What was sent: a fingerprint to a calendar, a request for a finished proof, or a block height to an explorer. */
  kind: OutKind;
  /** The service's host name. */
  to: string;
  count: number;
  /** Of `count`, how many the weekly standing consent started. */
  auto: number;
  first: IsoDate;
  last: IsoDate;
}

export interface SealStatus {
  /** Blocks on this computer. */
  blocks: number;
  /** When the newest block was made ("Sealed through <date>"). */
  lastAt?: IsoDate;
  /** Entries held by this computer's blocks. */
  entries: number;
  /** False when a block of this computer is missing, unreadable or does not link to its predecessor. */
  intact: boolean;
  /** The newest block that carries a public timestamp, when there is one. */
  published?: { n: number; at: IsoDate };
  /** Fingerprint of the key that signed the newest signed block ("a1b2 c3d4 …"). */
  key?: string;
  /** Public timestamps still waiting for Bitcoin. */
  pending: number;
  /** The newest public timestamp that was checked against a Bitcoin block. */
  confirmed?: { n: number; height: number; at: IsoDate };
  /** Everything this computer has sent to timestamp and block services. */
  outward: OutwardRow[];
}

export async function sealStatus(vaultRoot: string, host: string = sealHostKey()): Promise<SealStatus> {
  const { blocks, broken } = await readSealChain(vaultRoot, host);
  const out: SealStatus = { blocks: blocks.length, entries: blocks.reduce((a, b) => a + b.count, 0), intact: !broken, pending: 0, outward: await readOutbound(vaultRoot, host) };
  const last = blocks[blocks.length - 1];
  if (last) out.lastAt = last.at;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i] as SealBlock;
    if (b.v === 2) {
      out.key = keyFingerprint(b.key);
      break;
    }
  }
  const stamps = await readStamps(vaultRoot, host);
  const top = stamps[stamps.length - 1];
  if (top) out.published = { n: top.n, at: top.at };
  out.pending = stamps.filter((s) => !s.confirmed).length;
  const done = stamps.filter((s) => s.confirmed).pop();
  if (done?.confirmed) out.confirmed = { n: done.n, height: done.confirmed.height, at: done.confirmed.at };
  return out;
}

// ───────────────────────────── what leaves this computer ─────────────────────────────

export type OutKind = "stamp" | "check" | "header";

async function noteOutbound(ctx: StoreContext, host: string, kind: OutKind, to: string, auto: boolean, nowMs: number): Promise<void> {
  const line = `${JSON.stringify({ v: 1, at: new Date(nowMs).toISOString(), kind, to, auto })}\n`;
  try {
    await appendLines(writablePath(ctx.vaultRoot, `${SEALS_DIR}/${host}/outbound.jsonl`), line);
  } catch (e) {
    // The note comes first: when it cannot be written nothing is sent.
    throw new CortexError("E_IO", "the record of what leaves this computer could not be written; nothing was sent", { cause: e, detail: { reason: "outbound-log" } });
  }
}

/** The lines of `outbound.jsonl` grouped by what was sent and where. */
export async function readOutbound(vaultRoot: string, host: string = sealHostKey()): Promise<OutwardRow[]> {
  let text: string | null = null;
  try {
    text = await readTextIfExists(path.join(resolveInVault(vaultRoot, `${SEALS_DIR}/${host}`), "outbound.jsonl"));
  } catch {
    text = null;
  }
  const rows = new Map<string, OutwardRow>();
  for (const line of (text ?? "").split("\n")) {
    if (line === "") continue;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if ((r.kind !== "stamp" && r.kind !== "check" && r.kind !== "header") || typeof r.to !== "string" || typeof r.at !== "string" || !Number.isFinite(Date.parse(r.at))) continue;
    const key = `${r.kind}|${r.to}`;
    const cur = rows.get(key);
    if (!cur) rows.set(key, { kind: r.kind, to: r.to, count: 1, auto: r.auto === true ? 1 : 0, first: r.at, last: r.at });
    else {
      cur.count++;
      if (r.auto === true) cur.auto++;
      if (r.at < cur.first) cur.first = r.at;
      if (r.at > cur.last) cur.last = r.at;
    }
  }
  return [...rows.values()].sort((x, y) => (x.last < y.last ? 1 : x.last > y.last ? -1 : 0));
}

// ───────────────────────────── public timestamps ─────────────────────────────

/** A Bitcoin block that a stamp was checked against. */
export interface StampConfirmation {
  height: number;
  /** The block's own time. */
  at: IsoDate;
  checkedAt: IsoDate;
  /** The 80-byte block header (hex), kept so the check can be repeated with no network. */
  header: string;
  /** The work floor the header was accepted under. */
  floor: number;
}

export interface PublicStamp {
  v: 1;
  /** The block whose digest was timestamped. */
  n: number;
  at: IsoDate;
  /** The digest that was sent: a v2 block's public fingerprint, a v1 block's hash. */
  hash: string;
  calendar: string;
  /** File name of the .ots proof beside this record. */
  proof: string;
  /** Sent by the weekly standing consent rather than the button. */
  auto?: boolean;
  /** Present once the proof was completed and its Bitcoin block checked. */
  confirmed?: StampConfirmation;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Re-check, offline, that a stored confirmation still follows from the proof file and the stored header. */
async function confirmationHolds(dir: string, stamp: PublicStamp, c: StampConfirmation): Promise<boolean> {
  try {
    const parsed = parseOts(await fsp.readFile(path.join(dir, stamp.proof)));
    if (Buffer.from(parsed.digest).toString("hex") !== stamp.hash) return false;
    const step = bitcoinSteps(parsed).find((x) => x.att.height === c.height);
    if (!step) return false;
    const v = verifyBitcoinHeader(step.msg, Buffer.from(c.header, "hex"), { minDifficulty: c.floor });
    return v.ok && v.time === c.at;
  } catch {
    return false;
  }
}

function readConfirmation(raw: unknown): StampConfirmation | null {
  if (raw === null || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.height !== "number" || !Number.isInteger(c.height) || typeof c.at !== "string" || typeof c.checkedAt !== "string") return null;
  if (!isHex(c.header, 80) || typeof c.floor !== "number" || !(c.floor > 0)) return null;
  return { height: c.height, at: c.at, checkedAt: c.checkedAt, header: c.header, floor: c.floor };
}

export async function readStamps(vaultRoot: string, host: string): Promise<PublicStamp[]> {
  const dir = resolveInVault(vaultRoot, `${SEALS_DIR}/${host}/public`);
  const out: PublicStamp[] = [];
  for (const f of (await listDir(dir)).sort()) {
    const m = STAMP_FILE.exec(f);
    if (!m) continue;
    let raw: Record<string, unknown> | null = null;
    try {
      raw = await readJsonIfExists<Record<string, unknown>>(path.join(dir, f));
    } catch {
      raw = null;
    }
    if (!raw || raw.v !== 1 || raw.n !== Number(m[1]) || typeof raw.at !== "string" || typeof raw.hash !== "string" || typeof raw.calendar !== "string" || typeof raw.proof !== "string") continue;
    if (!Number.isFinite(Date.parse(raw.at)) || !/^\d{6}\.ots$/.test(raw.proof)) continue;
    const stamp: PublicStamp = { v: 1, n: raw.n, at: raw.at, hash: raw.hash, calendar: raw.calendar, proof: raw.proof, ...(raw.auto === true ? { auto: true } : {}) };
    const c = readConfirmation(raw.confirmed);
    if (c && (await confirmationHolds(dir, stamp, c))) stamp.confirmed = c;
    out.push(stamp);
  }
  return out;
}

/** Sends the digest (32 raw bytes) to the calendar and returns its reply bytes. Injected in tests. */
export type DigestPost = (url: string, digest: Uint8Array) => Promise<Uint8Array>;

/** The real POST: Node's fetch with a 20 s limit; only the digest leaves this computer. */
export const postDigest: DigestPost = async (url, digest) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      body: new Blob([digest as BlobPart]),
      headers: { Accept: "application/vnd.opentimestamps.v1", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "cortex-date-seals" },
      signal: ctl.signal,
    });
    if (!res.ok) throw new CortexError("E_IO", `the timestamp service answered ${res.status}`, { retryable: true, detail: { reason: "stamp-http", status: res.status } });
    return await readCapped(res, MAX_PROOF_BYTES);
  } catch (e) {
    if (e instanceof CortexError) throw e;
    throw new CortexError("E_IO", "the timestamp service could not be reached", { retryable: true, cause: e, detail: { reason: "stamp-network" } });
  } finally {
    clearTimeout(timer);
  }
};

export interface PublishResult {
  n: number;
  at: IsoDate;
  calendar: string;
  /** True when this block already had a public timestamp: nothing was sent. */
  already: boolean;
}

/** A complete `.ots` file: header, version, the sha256 operation, the digest, then the calendar's reply. */
export function otsFile(digestHex: string, reply: Uint8Array): Buffer {
  return Buffer.concat([OTS_MAGIC, Buffer.from([0x01, 0x08]), Buffer.from(digestHex, "hex"), Buffer.from(reply)]);
}

/** Serialises the requests that leave this computer (a manual press and the weekly pass never overlap). */
function withNetLock<T>(ctx: StoreContext, fn: () => Promise<T>): Promise<T> {
  return withLock(locksDirOf(ctx.cacheDir), "runner:seals-net", { owner: ctx.owner, staleMs: ctx.lockStaleMs, waitMs: 10_000 }, fn);
}

/** The "Timestamp publicly…" action (and the weekly pass): sends the newest block's digest and keeps the reply. */
export async function publishSeals(ctx: StoreContext, opts: { post?: DigestPost; now?: () => number; host?: string; calendar?: string; auto?: boolean } = {}): Promise<PublishResult> {
  const host = opts.host ?? sealHostKey();
  const calendar = opts.calendar ?? OTS_CALENDAR;
  const now = opts.now ?? Date.now;
  const { blocks, broken } = await readSealChain(ctx.vaultRoot, host);
  const head = blocks[blocks.length - 1];
  if (!head) throw new CortexError("E_BAD_REQUEST", "nothing is sealed yet", { detail: { reason: "no-seals" } });
  if (broken) throw new CortexError("E_IO", "the seal chain of this computer is damaged", { detail: { reason: "seal-chain" } });
  const have = (await readStamps(ctx.vaultRoot, host)).find((s) => s.n === head.n);
  if (have) return { n: have.n, at: have.at, calendar: have.calendar, already: true };
  const digest = blockDigest(head);
  return withNetLock(ctx, async () => {
    await noteOutbound(ctx, host, "stamp", hostOf(calendar), opts.auto === true, now());
    const reply = await (opts.post ?? postDigest)(`${calendar}/digest`, Buffer.from(digest, "hex"));
    if (reply.byteLength === 0 || reply.byteLength > 1_000_000) throw new CortexError("E_PARSE", "the timestamp service sent an unusable reply", { detail: { reason: "stamp-reply" } });
    const at = new Date(now()).toISOString();
    const proof = `${pad6(head.n)}.ots`;
    await writeFileAtomic(writablePath(ctx.vaultRoot, `${SEALS_DIR}/${host}/public/${proof}`), otsFile(digest, reply));
    const stamp: PublicStamp = { v: 1, n: head.n, at, hash: digest, calendar, proof, ...(opts.auto === true ? { auto: true } : {}) };
    await writeJsonAtomic(writablePath(ctx.vaultRoot, `${SEALS_DIR}/${host}/public/${pad6(head.n)}.json`), stamp);
    return { n: head.n, at, calendar, already: false };
  });
}

export interface CheckResult {
  /** Stamps looked at. */
  checked: number;
  /** Stamps now confirmed against a Bitcoin block (including ones that already were). */
  confirmed: number;
  /** Stamps the calendar has not committed to Bitcoin yet. */
  pending: number;
  /** Stamps that could not be completed or verified this time. */
  failed: number;
  /** Nothing could be asked: every request failed to reach a service. */
  unreachable: boolean;
  /** The newest confirmed block height, when any. */
  height?: number;
}

/** A stamp is looked at again by the weekly pass only after this long (a calendar needs hours). */
export const CHECK_AFTER_MS = 6 * 3600 * 1000;

async function exists(abs: string): Promise<boolean> {
  try {
    await fsp.access(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * "Check public timestamps": for each stamp not yet confirmed, ask its calendar for the completed proof (only the
 * step's hash is sent), keep the old receipt beside the new file, then check the proof against the Bitcoin block
 * header (the header comes from a public block service by height, and is stored so the check repeats offline).
 */
export async function checkPublicStamps(
  ctx: StoreContext,
  opts: { get?: CommitmentGet; header?: HeaderGet; now?: () => number; host?: string; auto?: boolean; minAgeMs?: number; minDifficulty?: number; explorerHost?: string } = {},
): Promise<CheckResult> {
  const host = opts.host ?? sealHostKey();
  const now = opts.now ?? Date.now;
  const get = opts.get ?? getCommitment;
  const getHeader = opts.header ?? getBlockHeader;
  const floor = opts.minDifficulty ?? MIN_DIFFICULTY;
  const res: CheckResult = { checked: 0, confirmed: 0, pending: 0, failed: 0, unreachable: false };
  let reached = false;
  let attempted = false;
  const dir = `${SEALS_DIR}/${host}/public`;
  const absDir = resolveInVault(ctx.vaultRoot, dir);
  return withNetLock(ctx, async () => {
    for (const stamp of await readStamps(ctx.vaultRoot, host)) {
      if (stamp.confirmed) {
        res.confirmed++;
        res.height = Math.max(res.height ?? 0, stamp.confirmed.height);
        continue;
      }
      if (opts.minAgeMs !== undefined && now() - Date.parse(stamp.at) < opts.minAgeMs) {
        res.pending++;
        continue;
      }
      res.checked++;
      try {
        const file = await fsp.readFile(path.join(absDir, stamp.proof));
        let parsed = parseOts(file);
        if (bitcoinSteps(parsed).length === 0) {
          attempted = true;
          await noteOutbound(ctx, host, "check", hostOf(stamp.calendar), opts.auto === true, now());
          const up = await upgradeProof(file, stamp.calendar, get);
          reached = true;
          if (up.upgraded === 0) {
            res.pending++;
            continue;
          }
          // Read the result back before it replaces anything, and keep the pending receipt beside it.
          const back = parseOts(up.ots);
          if (bitcoinSteps(back).length === 0 || Buffer.from(back.digest).toString("hex") !== stamp.hash) throw new CortexError("E_PARSE", "the completed proof did not read back", { detail: { reason: "ots-readback" } });
          const keep = writablePath(ctx.vaultRoot, `${dir}/${stamp.proof.replace(/\.ots$/, ".pending.ots")}`);
          if (!(await exists(keep))) await writeFileAtomic(keep, file);
          await writeFileAtomic(writablePath(ctx.vaultRoot, `${dir}/${stamp.proof}`), up.ots);
          parsed = back;
        }
        const step = bitcoinSteps(parsed).sort((x, y) => x.att.height - y.att.height)[0];
        if (!step) {
          res.pending++;
          continue;
        }
        attempted = true;
        await noteOutbound(ctx, host, "header", opts.explorerHost ?? EXPLORER_HOST, opts.auto === true, now());
        const header = Buffer.from(await getHeader(step.att.height));
        reached = true;
        const v = verifyBitcoinHeader(step.msg, header, { minDifficulty: floor });
        if (!v.ok || !v.time) {
          res.failed++;
          continue;
        }
        const confirmed: StampConfirmation = { height: step.att.height, at: v.time, checkedAt: new Date(now()).toISOString(), header: header.toString("hex"), floor };
        await writeJsonAtomic(writablePath(ctx.vaultRoot, `${dir}/${pad6(stamp.n)}.json`), { ...stamp, confirmed });
        res.confirmed++;
        res.height = Math.max(res.height ?? 0, step.att.height);
      } catch (e) {
        res.failed++;
        ctx.log.debug("checking a public timestamp failed", { code: e instanceof CortexError ? e.code : "E_INTERNAL" });
      }
    }
    res.unreachable = attempted && !reached;
    return res;
  });
}

export const WEEK_MS = 7 * 24 * 3600 * 1000;

export interface AutoStampResult {
  stamped: boolean;
  checked: boolean;
  /** Why nothing was sent, when nothing was. */
  skipped?: "none" | "recent" | "already";
}

/**
 * The weekly pass under the standing consent (the caller has checked the setting): stamp the newest block when
 * no stamp is a week old, then look again at stamps that have had time to reach Bitcoin. Never throws for a service
 * that is down; the next daily pass tries again.
 */
export async function autoTimestamp(
  ctx: StoreContext,
  opts: { post?: DigestPost; get?: CommitmentGet; header?: HeaderGet; now?: () => number; host?: string; calendar?: string; minDifficulty?: number } = {},
): Promise<AutoStampResult> {
  const host = opts.host ?? sealHostKey();
  const now = opts.now ?? Date.now;
  const out: AutoStampResult = { stamped: false, checked: false };
  const { blocks, broken } = await readSealChain(ctx.vaultRoot, host);
  const head = blocks[blocks.length - 1];
  if (!head || broken) return { ...out, skipped: "none" };
  const stamps = await readStamps(ctx.vaultRoot, host);
  const last = stamps[stamps.length - 1];
  if (stamps.some((s) => s.n === head.n)) out.skipped = "already";
  else if (last && now() - Date.parse(last.at) < WEEK_MS) out.skipped = "recent";
  else {
    try {
      await publishSeals(ctx, { auto: true, now, host, ...(opts.post ? { post: opts.post } : {}), ...(opts.calendar ? { calendar: opts.calendar } : {}) });
      out.stamped = true;
    } catch (e) {
      ctx.log.debug("the weekly timestamp was not sent", { code: e instanceof CortexError ? e.code : "E_INTERNAL" });
    }
  }
  if ((await readStamps(ctx.vaultRoot, host)).some((s) => !s.confirmed)) {
    try {
      await checkPublicStamps(ctx, { auto: true, minAgeMs: CHECK_AFTER_MS, now, host, ...(opts.get ? { get: opts.get } : {}), ...(opts.header ? { header: opts.header } : {}), ...(opts.minDifficulty !== undefined ? { minDifficulty: opts.minDifficulty } : {}) });
      out.checked = true;
    } catch (e) {
      ctx.log.debug("the weekly check did not run", { code: e instanceof CortexError ? e.code : "E_INTERNAL" });
    }
  }
  return out;
}

// ───────────────────────────── proof bundles ─────────────────────────────

export type BlockHead = Omit<SealBlockV1, "v" | "ids"> & ({ v: 1 } | { v: 2; key: string; fp: string; sig: string; by?: string });

export interface ProofBundle {
  format: "cortex-seal-proof";
  version: 1;
  computer: string;
  /** The block this proof is about, with its entry ids. */
  block: SealBlock;
  /** Version 2 only: the salt of the block that was timestamped (revealed by making this bundle). */
  salt?: string;
  /** Blocks after `block` up to the one that was timestamped (without ids): the links that join them. */
  links: BlockHead[];
  /** The public key and the exact signed text, so any Ed25519 tool can check the signature. */
  signer?: { publicKey: string; fingerprint: string; statement: string; signature: string };
  timestamp?: {
    calendar: string;
    at: IsoDate;
    /** The block (`block` or the last of `links`) whose digest was stamped. */
    n: number;
    digest: string;
    /** The .ots file, base64. */
    ots: string;
    bitcoin?: { height: number; at: IsoDate; header: string; floor: number };
  };
}

export const headOf = (b: SealBlock): BlockHead => {
  const { ids: _ids, ...rest } = b;
  return rest as BlockHead;
};

/** Everything someone else needs to check one block's date without trusting this computer. */
export async function exportProof(ctx: StoreContext, opts: { n?: number; host?: string } = {}): Promise<ProofBundle> {
  const host = opts.host ?? sealHostKey();
  const { blocks, broken } = await readSealChain(ctx.vaultRoot, host);
  if (broken) throw new CortexError("E_IO", "the seal chain of this computer is damaged", { detail: { reason: "seal-chain" } });
  const block = blocks.find((b) => b.n === (opts.n ?? blocks.length));
  if (!block) throw new CortexError("E_BAD_REQUEST", "nothing is sealed yet", { detail: { reason: "no-seals" } });
  const stamp = (await readStamps(ctx.vaultRoot, host)).find((s) => s.n >= block.n);
  const stamped = stamp ? (blocks.find((b) => b.n === stamp.n) as SealBlock) : block;
  const bundle: ProofBundle = { format: "cortex-seal-proof", version: 1, computer: host, block, links: blocks.filter((b) => b.n > block.n && b.n <= stamped.n).map(headOf) };
  if (stamp && stamped.v === 2) {
    const salt = await readSalt(ctx.cacheDir, host, stamped.n, ctx.vaultRoot);
    if (salt) bundle.salt = salt;
  }
  if (block.v === 2) bundle.signer = { publicKey: block.key, fingerprint: keyFingerprint(block.key), statement: signedStatement(block.hash, block.by), signature: block.sig };
  if (stamp) {
    const ots = await fsp.readFile(path.join(resolveInVault(ctx.vaultRoot, `${SEALS_DIR}/${host}/public`), stamp.proof));
    bundle.timestamp = {
      calendar: stamp.calendar,
      at: stamp.at,
      n: stamp.n,
      digest: stamp.hash,
      ots: ots.toString("base64"),
      ...(stamp.confirmed ? { bitcoin: { height: stamp.confirmed.height, at: stamp.confirmed.at, header: stamp.confirmed.header, floor: stamp.confirmed.floor } } : {}),
    };
  }
  return bundle;
}

export interface ProofVerdict {
  /** The block's hash follows from its fields, and (v2) its signature verifies under its key. */
  block: boolean;
  /** Each link names the hash of the block before it and is itself well formed. */
  links: boolean;
  /** Version 2: the salt turns the timestamped block's hash into the fingerprint that was stamped. Null when not applicable. */
  salt: boolean | null;
  /** The stamped digest is the one the proof file starts from. Null without a timestamp. */
  digest: boolean | null;
  /** "confirmed" only when the header carries the proof's value and real work; "pending" when the proof is not completed. */
  bitcoin: "none" | "pending" | "confirmed" | "invalid";
  height?: number;
  at?: IsoDate;
}

function headOk(h: BlockHead): boolean {
  if (h.v === 1) return blockHash(h) === h.hash;
  return blockHashV2(h) === h.hash && ed25519Verify(h.key, signedStatement(h.hash, h.by), h.sig);
}

/** Check a bundle with no network and no files of this computer. */
export function verifyProofBundle(b: ProofBundle, opts: { minDifficulty?: number } = {}): ProofVerdict {
  const verdict: ProofVerdict = { block: false, links: true, salt: null, digest: null, bitcoin: "none" };
  verdict.block = headOk(headOf(b.block));
  let prev: BlockHead = headOf(b.block);
  let stamped: BlockHead = prev;
  for (const l of b.links) {
    if (l.prev !== prev.hash || l.n !== prev.n + 1 || !headOk(l)) verdict.links = false;
    prev = l;
    stamped = l;
  }
  if (b.timestamp && stamped.n !== b.timestamp.n) verdict.links = false;
  if (stamped.v === 2 && b.timestamp) verdict.salt = typeof b.salt === "string" && isHex(b.salt, 32) && publicFingerprint(b.salt, stamped.hash) === stamped.fp;
  if (!b.timestamp) return verdict;
  const want = stamped.v === 2 ? stamped.fp : stamped.hash;
  try {
    const parsed = parseOts(Buffer.from(b.timestamp.ots, "base64"));
    verdict.digest = Buffer.from(parsed.digest).toString("hex") === want && b.timestamp.digest === want;
    const steps = bitcoinSteps(parsed);
    const claim = b.timestamp.bitcoin;
    const step = claim ? steps.find((x) => x.att.height === claim.height) : undefined;
    if (!claim || !step) {
      verdict.bitcoin = "pending";
      return verdict;
    }
    const v = verifyBitcoinHeader(step.msg, Buffer.from(claim.header, "hex"), { minDifficulty: opts.minDifficulty ?? MIN_DIFFICULTY });
    verdict.bitcoin = v.ok && v.time === claim.at ? "confirmed" : "invalid";
    if (verdict.bitcoin === "confirmed") {
      verdict.height = claim.height;
      verdict.at = v.time as string;
    }
  } catch {
    verdict.digest = false;
    verdict.bitcoin = "invalid";
  }
  return verdict;
}

// ───────────────────────────── reading, for the entry reader ─────────────────────────────

export interface SealEvidence {
  sealed?: { n: number; at: IsoDate };
  /** A public timestamp covers this entry; `height` and `blockAt` are set once it was checked against a Bitcoin block. */
  timestamped?: { at: IsoDate; height?: number; blockAt?: IsoDate };
}

interface SealIndex {
  signature: string;
  byId: Map<string, SealEvidence>;
}
const indexes = new Map<string, SealIndex>();

/** Block files never change once written, and a stamp changes only when it is confirmed (its size then changes): the listing is the cache key. */
async function sealSignature(vaultRoot: string): Promise<{ signature: string; hosts: string[] }> {
  const root = resolveInVault(vaultRoot, SEALS_DIR);
  const hosts = (await listDir(root)).filter((h) => HOST_DIR.test(h)).sort();
  const parts: string[] = [];
  for (const h of hosts) {
    const pub = path.join(root, h, "public");
    let sizes = 0;
    const names = await listDir(pub);
    for (const f of names) {
      try {
        sizes += (await fsp.stat(path.join(pub, f))).size;
      } catch {
        // gone between the listing and the stat: the next look sees it
      }
    }
    parts.push(`${h}:${(await listDir(path.join(root, h))).filter((f) => BLOCK_FILE.test(f)).length}:${names.length}:${sizes}`);
  }
  return { signature: parts.join("|"), hosts };
}

async function sealIndex(vaultRoot: string): Promise<SealIndex> {
  const { signature, hosts } = await sealSignature(vaultRoot);
  const cached = indexes.get(vaultRoot);
  if (cached && cached.signature === signature) return cached;
  const byId = new Map<string, SealEvidence>();
  for (const h of hosts) {
    const { blocks } = await readSealChain(vaultRoot, h);
    const stamps = await readStamps(vaultRoot, h);
    for (const b of blocks) {
      const stamp = stamps.filter((s) => s.n >= b.n).sort((x, y) => (x.at < y.at ? -1 : 1))[0];
      for (const id of b.ids) {
        const cur = byId.get(id) ?? {};
        if (!cur.sealed || b.at < cur.sealed.at) cur.sealed = { n: b.n, at: b.at };
        if (stamp && (!cur.timestamped || stamp.at < cur.timestamped.at)) cur.timestamped = { at: stamp.at, ...(stamp.confirmed ? { height: stamp.confirmed.height, blockAt: stamp.confirmed.at } : {}) };
        byId.set(id, cur);
      }
    }
  }
  const next = { signature, byId };
  indexes.set(vaultRoot, next);
  return next;
}

export async function sealEvidenceFor(vaultRoot: string, id: string): Promise<SealEvidence> {
  try {
    return (await sealIndex(vaultRoot)).byId.get(id) ?? {};
  } catch {
    return {};
  }
}

// ───────────────────────────── git first-seen ─────────────────────────────

interface GitRow {
  sha: string;
  at: IsoDate | null;
  checkedAt: IsoDate;
}
interface GitFile {
  v: 1;
  /** Set when the vault is not in a git repository (or git is missing): not asked again for a while. */
  noGit?: IsoDate;
  files: Record<string, GitRow>;
}

/** Runs `git` in `cwd` and resolves to its output, or null when it cannot run or fails. Injected in tests. */
export type GitRun = (args: string[], cwd: string, input?: string) => Promise<string | null>;

export const runGit: GitRun = (args, cwd, input) =>
  new Promise((resolve) => {
    const child = execFile("git", args, { cwd, maxBuffer: 1024 * 1024 * 1024, timeout: 120_000, windowsHide: true, encoding: "utf8" }, (err, stdout) => resolve(err ? null : stdout));
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });

async function readGitFile(cacheDir: string): Promise<GitFile> {
  try {
    const raw = await readJsonIfExists<GitFile>(path.join(cacheDir, GIT_FILE));
    if (raw && raw.v === 1 && raw.files && typeof raw.files === "object") return raw;
  } catch {
    /* rebuildable */
  }
  return { v: 1, files: {} };
}

/** Vault paths of the entries whose original is a file in the vault, with the hash that was imported. */
async function gitCandidates(ledger: LedgerStore): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for await (const e of ledger.readAll("entries") as AsyncIterable<EntryRecord>) {
    if (e.source !== "obsidian" && e.source !== "files" && e.source !== "written") continue;
    const p = e.sourceRef?.path;
    if (typeof p !== "string" || p === "" || path.isAbsolute(p) || /^[a-z]:/i.test(p) || p.split(/[\\/]/).includes("..") || typeof e.sourceRef.sha256 !== "string" || e.sourceRef.sha256 === "") continue;
    out.set(p.replace(/\\/g, "/"), e.sourceRef.sha256);
  }
  return out;
}

export interface GitRunResult {
  /** Files looked at in git this time. */
  checked: number;
  /** Of those, how many have a commit for their current content. */
  found: number;
}

/** Look up when the current content of each in-vault original first reached a commit. Never fails an import: callers log and go on. */
export async function updateGitEvidence(ctx: StoreContext, ledger: LedgerStore, opts: { git?: GitRun; now?: () => number } = {}): Promise<GitRunResult> {
  const git = opts.git ?? runGit;
  const nowMs = (opts.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();
  const state = await readGitFile(ctx.cacheDir);
  if (state.noGit && nowMs - Date.parse(state.noGit) < GIT_RECHECK_MS) return { checked: 0, found: 0 };
  const candidates = await gitCandidates(ledger);
  const due: { rel: string; sha: string }[] = [];
  for (const [rel, sha] of candidates) {
    const row = state.files[rel];
    if (row && row.sha === sha && (row.at !== null || nowMs - Date.parse(row.checkedAt) < GIT_RECHECK_MS)) continue;
    due.push({ rel, sha });
  }
  if (due.length === 0) return { checked: 0, found: 0 };
  // Only files that still hold the imported bytes can speak for the entries.
  // (a few at a time: each file waits on the disk, and 20,000 of them one by one took most of a minute)
  const holds = await mapLimit(due, 16, async (d): Promise<boolean> => {
    try {
      const abs = resolveInVault(ctx.vaultRoot, d.rel);
      const st = await fsp.stat(abs);
      if (!st.isFile() || st.size > MAX_GIT_FILE_BYTES) return false;
      return sha256Bytes(await fsp.readFile(abs)) === d.sha;
    } catch {
      return false; // gone or unreadable: no evidence
    }
  });
  const intact = due.filter((_, i) => holds[i] === true);
  if (intact.length === 0) return { checked: 0, found: 0 };
  const save = async (): Promise<void> => writeJsonAtomic(cacheWritablePath(ctx.cacheDir, GIT_FILE), state);
  const oids = await git(["hash-object", "--stdin-paths"], ctx.vaultRoot, `${intact.map((d) => d.rel).join("\n")}\n`);
  const oidLines = oids === null ? [] : oids.split(/\r?\n/).filter((l) => l !== "");
  if (oids === null || oidLines.length !== intact.length) {
    state.noGit = nowIso;
    await save();
    return { checked: 0, found: 0 };
  }
  delete state.noGit;
  const wanted = new Map<string, string>();
  intact.forEach((d, i) => wanted.set(d.rel, oidLines[i] as string));
  const log = await git(["-c", "core.quotepath=false", "log", "--reverse", "--no-renames", "--no-merges", "--raw", "--no-abbrev", "--diff-filter=AM", "--relative", "--format=%x01%cI"], ctx.vaultRoot);
  if (log === null) {
    state.noGit = nowIso;
    await save();
    return { checked: 0, found: 0 };
  }
  const first = new Map<string, IsoDate>();
  let when = "";
  for (const line of log.split("\n")) {
    if (line.startsWith("\u0001")) {
      when = line.slice(1).trim();
      continue;
    }
    if (!line.startsWith(":") || when === "") continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const rel = line.slice(tab + 1).replace(/\r$/, "");
    const oid = line.slice(0, tab).split(" ")[3];
    if (oid !== undefined && wanted.get(rel) === oid && !first.has(rel)) {
      const t = Date.parse(when);
      if (Number.isFinite(t)) first.set(rel, new Date(t).toISOString());
    }
  }
  let found = 0;
  for (const d of intact) {
    const at = first.get(d.rel) ?? null;
    if (at) found++;
    state.files[d.rel] = { sha: d.sha, at, checkedAt: nowIso };
  }
  await save();
  return { checked: intact.length, found };
}

/** The git date of an entry's original, when its file still holds what was imported and a commit has it. */
export async function gitEvidenceFor(cacheDir: string, rec: Pick<EntryRecord, "sourceRef">): Promise<IsoDate | undefined> {
  const p = rec.sourceRef?.path;
  if (typeof p !== "string" || p === "") return undefined;
  const row = (await readGitFile(cacheDir)).files[p.replace(/\\/g, "/")];
  return row && row.at && row.sha === rec.sourceRef.sha256 ? row.at : undefined;
}

// ───────────────────────────── the post-import step ─────────────────────────────

interface Cursor {
  v: 1;
  /** Ledger sequence the last seal pass looked at. */
  sealSeq?: number;
  /** Ledger sequence and time of the last git pass. */
  gitSeq?: number;
  gitAt?: IsoDate;
}

export interface EvidenceRunResult {
  sealed: SealRunResult | null;
  git: GitRunResult | null;
}

/**
 * What an import pass ends with: seal new entries when the person turned seals on, and refresh the git dates.
 * Each part looks at the ledger only when its sequence number moved, and neither ever fails the caller.
 */
export async function runDateEvidence(
  ctx: StoreContext,
  ledger: LedgerStore,
  opts: { seal: boolean; force?: boolean; now?: () => number; git?: GitRun; host?: string; maxBlock?: number; /** Display name placed inside each signed statement. */ signAs?: string; /** Leave the git pass for a later run (the import added no files that live in the vault). */ skipGit?: boolean },
): Promise<EvidenceRunResult> {
  const now = opts.now ?? Date.now;
  const out: EvidenceRunResult = { sealed: null, git: null };
  const cursorAbs = path.join(ctx.cacheDir, CURSOR_FILE);
  let cursor: Cursor = { v: 1 };
  try {
    const raw = await readJsonIfExists<Cursor>(cursorAbs);
    if (raw && raw.v === 1) cursor = raw;
  } catch {
    cursor = { v: 1 };
  }
  const seq = await ledger.seq();
  const store = async (): Promise<void> => writeJsonAtomic(cacheWritablePath(ctx.cacheDir, CURSOR_FILE), cursor);
  if (opts.seal && (opts.force === true || cursor.sealSeq !== seq)) {
    try {
      out.sealed = await sealNewEntries(ctx, ledger, { now, ...(opts.host !== undefined ? { host: opts.host } : {}), ...(opts.maxBlock !== undefined ? { maxBlock: opts.maxBlock } : {}), ...(opts.signAs !== undefined ? { signAs: opts.signAs } : {}) });
      cursor.sealSeq = seq;
      await store();
    } catch (e) {
      ctx.log.warn("sealing new entries failed", { code: e instanceof CortexError ? e.code : "E_INTERNAL" });
    }
  }
  const gitDue = opts.skipGit !== true && (opts.force === true || cursor.gitSeq !== seq || cursor.gitAt === undefined || now() - Date.parse(cursor.gitAt) >= GIT_RECHECK_MS);
  if (gitDue) {
    try {
      out.git = await updateGitEvidence(ctx, ledger, { now, ...(opts.git ? { git: opts.git } : {}) });
      cursor.gitSeq = seq;
      cursor.gitAt = new Date(now()).toISOString();
      await store();
    } catch (e) {
      ctx.log.warn("looking up git dates failed", { code: e instanceof CortexError ? e.code : "E_INTERNAL" });
    }
  }
  return out;
}

/** Test and tooling helper: forget cached seal indexes. */
export function resetSealCache(): void {
  indexes.clear();
}
