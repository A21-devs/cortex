/**
 * Reading, upgrading and checking OpenTimestamps proofs (the standard `.ots` format). Owner: seal-date-v2.
 *
 * A proof is a tree: from the timestamped digest, operations (append, prepend, hash) lead step by step to
 * attestations. A calendar first answers with a PENDING attestation ("ask me again later"); once the calendar has
 * committed its batch to Bitcoin, asking again returns the rest of the path, ending in a BITCOIN attestation: the
 * value reached there must equal the merkle root of the named block. Cortex:
 *  - parses the tree (bounded: size, depth, node count; unknown operations make a branch unverifiable, never a crash);
 *  - `upgradeProof` asks the named calendar for each pending step (only the step's hash is sent), merges the reply
 *    into the tree and drops the pending mark it answers;
 *  - `verifyBitcoinHeader` checks, with no network, that the value equals the merkle root inside an 80-byte block
 *    header and that the header carries real proof of work, and reads the block time from it.
 * What an offline header check cannot show is that the header sits on the best chain; the work floor
 * (MIN_DIFFICULTY) makes a forged header cost far more than any Cortex timestamp is worth, and the reader still
 * calls the date a "provable bound".
 */
import { createHash } from "node:crypto";
import { CortexError } from "../shared/errors";

export const OTS_HEADER_MAGIC = Buffer.from("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294", "hex");
const TAG_PENDING = "83dfe30d2ef90c8e";
const TAG_BITCOIN = "0588960d73d71901";
export const MAX_PROOF_BYTES = 1_000_000;
const MAX_DEPTH = 256;
const MAX_NODES = 100_000;
const URI_OK = /^[a-zA-Z0-9.\-_:/]{1,1000}$/;

export type Attestation = { kind: "pending"; uri: string } | { kind: "bitcoin"; height: number } | { kind: "unknown"; tag: string; payload: Uint8Array };
export interface OpNode {
  tag: number;
  arg?: Uint8Array;
  child: TsNode;
}
export interface TsNode {
  attestations: Attestation[];
  ops: OpNode[];
}
export interface ParsedOts {
  /** Operation that hashed the file (0x08 = sha256) and the digest of the timestamped thing. */
  fileOp: number;
  digest: Uint8Array;
  root: TsNode;
}

const bad = (why: string): CortexError => new CortexError("E_PARSE", `the timestamp proof is unusable (${why})`, { detail: { reason: "ots-parse" } });

class Reader {
  pos = 0;
  nodes = 0;
  constructor(readonly buf: Uint8Array) {}
  byte(): number {
    const b = this.buf[this.pos++];
    if (b === undefined) throw bad("it ends early");
    return b;
  }
  bytes(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.buf.length) throw bad("it ends early");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  varuint(): number {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      v += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return v;
      shift += 7;
      if (shift > 49) throw bad("a number is too long");
    }
  }
  varbytes(): Uint8Array {
    return this.bytes(this.varuint());
  }
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

function readAttestation(r: Reader): Attestation {
  const tag = hex(r.bytes(8));
  const payload = r.varbytes();
  const sub = new Reader(payload);
  if (tag === TAG_PENDING) {
    const uri = Buffer.from(sub.varbytes()).toString("utf8");
    if (!sub.done || !URI_OK.test(uri)) throw bad("a calendar address is malformed");
    return { kind: "pending", uri };
  }
  if (tag === TAG_BITCOIN) {
    const height = sub.varuint();
    if (!sub.done) throw bad("a block height is malformed");
    return { kind: "bitcoin", height };
  }
  return { kind: "unknown", tag, payload: Uint8Array.from(payload) };
}

const UNARY = new Set([0x08, 0x03, 0x02, 0x67, 0xf2, 0xf3]);
const BINARY = new Set([0xf0, 0xf1]);

function readNode(r: Reader, depth: number): TsNode {
  if (depth > MAX_DEPTH || ++r.nodes > MAX_NODES) throw bad("it is too deep");
  const node: TsNode = { attestations: [], ops: [] };
  const item = (tag: number): void => {
    if (tag === 0x00) {
      node.attestations.push(readAttestation(r));
      return;
    }
    if (!UNARY.has(tag) && !BINARY.has(tag)) throw bad(`an operation (${tag}) is not known`);
    const arg = BINARY.has(tag) ? Uint8Array.from(r.varbytes()) : undefined;
    if (arg !== undefined && arg.length === 0) throw bad("an operation has no argument");
    node.ops.push({ tag, ...(arg ? { arg } : {}), child: readNode(r, depth + 1) });
  };
  let tag = r.byte();
  while (tag === 0xff) {
    item(r.byte());
    tag = r.byte();
  }
  item(tag);
  return node;
}

/** Parse a complete `.ots` file. */
export function parseOts(file: Uint8Array): ParsedOts {
  if (file.length > MAX_PROOF_BYTES) throw bad("it is too large");
  const r = new Reader(file);
  if (hex(r.bytes(OTS_HEADER_MAGIC.length)) !== OTS_HEADER_MAGIC.toString("hex")) throw bad("it is not an OpenTimestamps file");
  if (r.varuint() !== 1) throw bad("an unknown version");
  const fileOp = r.byte();
  if (fileOp !== 0x08) throw bad("the file was not hashed with sha256");
  const digest = Uint8Array.from(r.bytes(32));
  const root = readNode(r, 0);
  if (!r.done) throw bad("extra bytes follow");
  return { fileOp, digest, root };
}

/** Parse what a calendar sends for one step: a bare tree that starts at the step's value. */
export function parseTimestampTree(bytes: Uint8Array): TsNode {
  if (bytes.length > MAX_PROOF_BYTES) throw bad("a reply is too large");
  const r = new Reader(bytes);
  const root = readNode(r, 0);
  if (!r.done) throw bad("extra bytes follow a reply");
  return root;
}

// ───────────────────────────── writing ─────────────────────────────

function varuint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}

function writeAttestation(a: Attestation): number[] {
  let tag: string;
  let payload: number[];
  if (a.kind === "pending") {
    tag = TAG_PENDING;
    const uri = [...Buffer.from(a.uri, "utf8")];
    payload = [...varuint(uri.length), ...uri];
  } else if (a.kind === "bitcoin") {
    tag = TAG_BITCOIN;
    payload = varuint(a.height);
  } else {
    tag = a.tag;
    payload = [...a.payload];
  }
  return [0x00, ...Buffer.from(tag, "hex"), ...varuint(payload.length), ...payload];
}

const attKey = (a: Attestation): string => Buffer.from(writeAttestation(a)).toString("hex");
const opKey = (o: OpNode): string => `${o.tag}:${o.arg ? hex(o.arg) : ""}`;

function writeNode(n: TsNode, out: number[]): void {
  const items: (() => void)[] = [];
  for (const a of [...n.attestations].sort((x, y) => (attKey(x) < attKey(y) ? -1 : attKey(x) > attKey(y) ? 1 : 0))) items.push(() => out.push(...writeAttestation(a)));
  for (const o of [...n.ops].sort((x, y) => (opKey(x) < opKey(y) ? -1 : opKey(x) > opKey(y) ? 1 : 0))) {
    items.push(() => {
      out.push(o.tag);
      if (o.arg) out.push(...varuint(o.arg.length), ...o.arg);
      writeNode(o.child, out);
    });
  }
  if (items.length === 0) throw bad("a step has nothing in it");
  items.forEach((w, i) => {
    if (i < items.length - 1) out.push(0xff);
    w();
  });
}

export function serializeOts(p: ParsedOts): Buffer {
  const out: number[] = [];
  writeNode(p.root, out);
  return Buffer.concat([OTS_HEADER_MAGIC, Buffer.from([0x01, p.fileOp]), Buffer.from(p.digest), Buffer.from(out)]);
}

// ───────────────────────────── walking ─────────────────────────────

/** The value after one operation, or null when Cortex does not compute it (the branch is then left alone). */
export function applyOp(tag: number, arg: Uint8Array | undefined, msg: Uint8Array): Uint8Array | null {
  switch (tag) {
    case 0x08:
      return createHash("sha256").update(msg).digest();
    case 0x02:
      return createHash("sha1").update(msg).digest();
    case 0x03:
      try {
        return createHash("ripemd160").update(msg).digest();
      } catch {
        return null; // OpenSSL builds without the legacy provider
      }
    case 0xf0:
      return arg ? Buffer.concat([msg, arg]) : null;
    case 0xf1:
      return arg ? Buffer.concat([arg, msg]) : null;
    case 0xf2:
      return Buffer.from(msg).reverse();
    case 0xf3:
      return Buffer.from(Buffer.from(msg).toString("hex"), "utf8");
    default:
      return null; // keccak256 and anything later
  }
}

export interface Located<T> {
  node: TsNode;
  msg: Uint8Array;
  att: T;
}

type PendingAtt = Extract<Attestation, { kind: "pending" }>;
type BitcoinAtt = Extract<Attestation, { kind: "bitcoin" }>;

function walk(node: TsNode, msg: Uint8Array, visit: (node: TsNode, msg: Uint8Array) => void): void {
  visit(node, msg);
  for (const o of node.ops) {
    const next = applyOp(o.tag, o.arg, msg);
    if (next) walk(o.child, next, visit);
  }
}

export function pendingSteps(p: ParsedOts): Located<PendingAtt>[] {
  const out: Located<PendingAtt>[] = [];
  walk(p.root, p.digest, (node, msg) => {
    for (const att of node.attestations) if (att.kind === "pending") out.push({ node, msg, att });
  });
  return out;
}

export function bitcoinSteps(p: ParsedOts): Located<BitcoinAtt>[] {
  const out: Located<BitcoinAtt>[] = [];
  walk(p.root, p.digest, (node, msg) => {
    for (const att of node.attestations) if (att.kind === "bitcoin") out.push({ node, msg, att });
  });
  return out;
}

function hasBitcoin(n: TsNode): boolean {
  return n.attestations.some((a) => a.kind === "bitcoin") || n.ops.some((o) => hasBitcoin(o.child));
}

function mergeNode(into: TsNode, from: TsNode): void {
  const have = new Set(into.attestations.map(attKey));
  for (const a of from.attestations) if (!have.has(attKey(a))) into.attestations.push(a);
  for (const o of from.ops) {
    const same = into.ops.find((x) => opKey(x) === opKey(o));
    if (same) mergeNode(same.child, o.child);
    else into.ops.push(o);
  }
}

// ───────────────────────────── upgrading ─────────────────────────────

/** Asks `url` for a step's completed path. null = the calendar has not committed it to Bitcoin yet. Injected in tests. */
export type CommitmentGet = (url: string) => Promise<Uint8Array | null>;

const normalUri = (u: string): string => u.replace(/\/+$/, "").toLowerCase();

export interface UpgradeResult {
  /** The proof to keep: the input when nothing changed. */
  ots: Buffer;
  /** Pending steps replaced by a completed path. */
  upgraded: number;
  /** Pending steps that stay pending (the calendar said "not yet", or belongs to a calendar that was not asked). */
  stillPending: number;
  /** Requests made, for the access log. */
  asked: number;
}

/**
 * Ask the named calendar for each pending step of its own and merge the answers in. Calendars other than
 * `calendar` are never contacted. A reply that does not lead to a Bitcoin attestation is ignored.
 */
export async function upgradeProof(file: Uint8Array, calendar: string, get: CommitmentGet): Promise<UpgradeResult> {
  const parsed = parseOts(file);
  const steps = pendingSteps(parsed);
  let upgraded = 0;
  let stillPending = 0;
  let asked = 0;
  const cal = normalUri(calendar);
  for (const s of steps) {
    if (normalUri(s.att.uri) !== cal) {
      stillPending++;
      continue;
    }
    asked++;
    const reply = await get(`${s.att.uri.replace(/\/+$/, "")}/timestamp/${hex(s.msg)}`);
    if (!reply) {
      stillPending++;
      continue;
    }
    const tree = parseTimestampTree(reply);
    if (!hasBitcoin(tree)) {
      stillPending++;
      continue;
    }
    s.node.attestations = s.node.attestations.filter((a) => a !== s.att);
    mergeNode(s.node, tree);
    upgraded++;
  }
  if (upgraded === 0) return { ots: Buffer.from(file), upgraded, stillPending, asked };
  return { ots: serializeOts(parsed), upgraded, stillPending, asked };
}

// ───────────────────────────── the block header check ─────────────────────────────

/** Mainnet difficulty never was below this while OpenTimestamps existed; a header claiming less is not believed. */
export const MIN_DIFFICULTY = 1e10;
const MAX_TARGET = 0xffffn << 208n;

export interface HeaderCheck {
  ok: boolean;
  /** Block time from the header (ISO), when ok. */
  time?: string;
  /** Hash of the block (display order), when the header parsed. */
  blockHash?: string;
  why?: "length" | "merkle-root" | "target" | "work" | "floor";
}

const sha256d = (b: Uint8Array): Buffer => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();

export function targetOf(bits: number): bigint | null {
  const exp = bits >>> 24;
  const mant = bits & 0x7fffff;
  if ((bits & 0x800000) !== 0 || mant === 0) return null;
  const t = exp <= 3 ? BigInt(mant >> (8 * (3 - exp))) : BigInt(mant) << BigInt(8 * (exp - 3));
  return t === 0n || t > (1n << 256n) - 1n ? null : t;
}

/**
 * True when `msg` is the merkle root inside `header` (80 bytes) and the header's hash meets its own target, which
 * must also be at least as hard as `minDifficulty`. Pure and offline.
 */
export function verifyBitcoinHeader(msg: Uint8Array, header: Uint8Array, opts: { minDifficulty?: number } = {}): HeaderCheck {
  if (header.length !== 80) return { ok: false, why: "length" };
  const h = Buffer.from(header);
  const blockHash = Buffer.from(sha256d(h)).reverse().toString("hex");
  if (!h.subarray(36, 68).equals(Buffer.from(msg))) return { ok: false, blockHash, why: "merkle-root" };
  const target = targetOf(h.readUInt32LE(72));
  if (target === null) return { ok: false, blockHash, why: "target" };
  if (BigInt(`0x${blockHash}`) > target) return { ok: false, blockHash, why: "work" };
  // (difficulty may be fractional only so a test can mine a header at the easiest target)
  const floor = (MAX_TARGET * 10n ** 15n) / BigInt(Math.max(1, Math.ceil((opts.minDifficulty ?? MIN_DIFFICULTY) * 1e15)));
  if (target > floor) return { ok: false, blockHash, why: "floor" };
  return { ok: true, blockHash, time: new Date(h.readUInt32LE(68) * 1000).toISOString() };
}

// ───────────────────────────── the network halves (injected in tests) ─────────────────────────────

/** Fetches the 80-byte header of the Bitcoin block at a height. Only the height leaves this computer. */
export type HeaderGet = (height: number) => Promise<Uint8Array>;

/** A public block explorer with the Esplora interface; asked for a block height and a block hash, nothing else. */
export const EXPLORER = "https://blockstream.info/api";
export const EXPLORER_HOST = "blockstream.info";

/** A reply's body, read in pieces and refused as soon as it passes `max` bytes (a service cannot make this computer hold more). */
export async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const bad = (): CortexError => new CortexError("E_PARSE", "the service sent an unusable reply", { detail: { reason: "stamp-reply" } });
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw bad();
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    if (all.length > max) throw bad();
    return all;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw bad();
    }
    parts.push(value);
  }
  return new Uint8Array(Buffer.concat(parts));
}

async function getBytes(url: string, accept: string): Promise<{ status: number; body: Uint8Array }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(url, { headers: { Accept: accept, "User-Agent": "cortex-date-seals" }, signal: ctl.signal });
    return { status: res.status, body: await readCapped(res, MAX_PROOF_BYTES) };
  } catch (e) {
    if (e instanceof CortexError) throw e;
    throw new CortexError("E_IO", "the timestamp service could not be reached", { retryable: true, cause: e, detail: { reason: "stamp-network" } });
  } finally {
    clearTimeout(timer);
  }
}

export const getCommitment: CommitmentGet = async (url) => {
  const { status, body } = await getBytes(url, "application/vnd.opentimestamps.v1");
  if (status === 404) return null;
  if (status < 200 || status >= 300) throw new CortexError("E_IO", `the timestamp service answered ${status}`, { retryable: true, detail: { reason: "stamp-http", status } });
  return body;
};

export const getBlockHeader: HeaderGet = async (height) => {
  if (!Number.isInteger(height) || height < 0 || height > 10_000_000) throw new CortexError("E_BAD_REQUEST", "not a block height", { detail: { reason: "height" } });
  const a = await getBytes(`${EXPLORER}/block-height/${height}`, "text/plain");
  const blockHash = Buffer.from(a.body).toString("utf8").trim();
  if (a.status !== 200 || !/^[0-9a-f]{64}$/.test(blockHash)) throw new CortexError("E_IO", "the block service had no such block", { retryable: true, detail: { reason: "header-http", status: a.status } });
  const b = await getBytes(`${EXPLORER}/block/${blockHash}/header`, "text/plain");
  const headerHex = Buffer.from(b.body).toString("utf8").trim();
  if (b.status !== 200 || !/^[0-9a-f]{160}$/.test(headerHex)) throw new CortexError("E_IO", "the block service sent an unusable header", { retryable: true, detail: { reason: "header-http", status: b.status } });
  const header = Buffer.from(headerHex, "hex");
  if (Buffer.from(sha256d(header)).reverse().toString("hex") !== blockHash) throw new CortexError("E_PARSE", "the block header does not match its hash", { detail: { reason: "header-hash" } });
  return header;
};
