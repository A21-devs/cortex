/**
 * "Prove this entry": one entry's text, everything that ties it to a sealed block, and the offline verifier page.
 * Owner: proof-audit-export (depends on seal-date-v2: salted blocks, signatures, anchors).
 *
 * A proof names the entry's ORIGINAL text (the bytes that were sealed, never an edited version). The verifier recomputes
 *   sha256(text)  ->  leaf = HMAC(salt, id, newline, sha256)  ->  Merkle path  ->  block root  ->  block hash and signature
 *   ->  links to the stamped block  ->  fingerprint  ->  the .ots proof  ->  a Bitcoin block header's work and time.
 * The bundle reveals the salt of the entry's block (needed for the leaf) and of the stamped block; both reveal nothing
 * about other entries, whose leaves stay HMACs. Block heads carry no entry ids and no other entry's text.
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { CortexError } from "../shared/errors";
import { resolveInVault } from "../node/paths";
import { readSalt } from "../node/sign";
import { keyFingerprint, signedStatement } from "../shared/sign";
import type { EntryRecord, IsoDate } from "../shared/types";
import { headOf, merkleRoot, readSealChain, readStamps, sealHostKey, sealHosts, sealLeaf, sealLeafV2, sealNewEntries, type BlockHead, type PublicStamp, type SealBlock } from "./dateEvidence";
import { CORTEX_PATHS, type StoreContext } from "./layout";
import type { LedgerStore } from "./ledger";
import { readText, SegmentCache, sha256Text } from "./segments";
import { stageLookup } from "./stage";
import { buildVerifierHtml, type VerifierStrings } from "./verifierPage";
import { fillText, jsonText, type PackFile, type PackStamp } from "./sealPack";

export interface PathStep {
  /** The sibling's hash. */
  h: string;
  /** True when the sibling sits on the left of the running hash. */
  left: boolean;
}

export interface EntryProof {
  format: "cortex-entry-proof";
  version: 1;
  createdAt: IsoDate;
  computer: string;
  entry: { id: string; sha256: string; text: string; speaker: string; source: string; title?: string; writtenAt?: IsoDate; addedAt: IsoDate; space: string };
  /** The block that holds the entry, as a head (no ids). */
  block: BlockHead;
  /** Version 2: the salt of `block`, needed to recompute the entry's leaf. */
  leafSalt?: string;
  /** Position of the entry's leaf among the block's leaves, and how many there are. */
  index: number;
  count: number;
  path: PathStep[];
  /** Blocks after `block` up to the one that was stamped. */
  links: BlockHead[];
  signer?: { publicKey: string; fingerprint: string; statement: string; signature: string };
  timestamp?: PackStamp;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The sibling path from leaf `index` to the root, the inverse of dateEvidence.merkleRoot (an odd node pairs with itself). */
export function merklePath(leaves: readonly string[], index: number): PathStep[] {
  const out: PathStep[] = [];
  let level = [...leaves];
  let i = index;
  while (level.length > 1) {
    out.push({ h: level[i % 2 === 0 ? i + 1 : i - 1] ?? (level[i] as string), left: i % 2 === 1 });
    const next: string[] = [];
    for (let j = 0; j < level.length; j += 2) next.push(sha(`${level[j]}${level[j + 1] ?? level[j]}`));
    level = next;
    i = Math.floor(i / 2);
  }
  return out;
}

interface Found {
  host: string;
  blocks: SealBlock[];
  block: SealBlock;
}

async function findBlock(ctx: StoreContext, id: string, prefer: string): Promise<Found | null> {
  const hosts = (await sealHosts(ctx.vaultRoot)).sort((a, b) => (a === prefer ? -1 : b === prefer ? 1 : a < b ? -1 : 1));
  for (const host of hosts) {
    const { blocks } = await readSealChain(ctx.vaultRoot, host);
    const block = blocks.find((b) => b.ids.includes(id));
    if (block) return { host, blocks, block };
  }
  return null;
}

export interface ProofOptions {
  host?: string;
  now?: () => number;
  /** Seal entries no block holds yet first (the normal daily seal), so a fresh entry can be proved. Default false. */
  sealFirst?: boolean;
}

const fail = (reason: string, msg: string): CortexError => new CortexError("E_IO", msg, { detail: { reason } });

/** Build the proof of one entry, or throw E_IO with detail.reason: not-found, not-sealed, salt-elsewhere, text-missing, text-changed, seal-chain. */
export async function buildEntryProof(ctx: StoreContext, ledger: LedgerStore, id: string, opts: ProofOptions = {}): Promise<EntryProof> {
  const host = opts.host ?? sealHostKey();
  const now = opts.now ?? Date.now;
  let rec: EntryRecord | null = null;
  for await (const e of ledger.readAll("entries")) {
    if (e.id === id) {
      rec = e;
      break;
    }
  }
  if (!rec) throw fail("not-found", "that entry is not in the record");
  let found = await findBlock(ctx, id, host);
  if (!found && opts.sealFirst) {
    await sealNewEntries(ctx, ledger, { now, host });
    found = await findBlock(ctx, id, host);
  }
  if (!found) throw fail("not-sealed", "that entry is not sealed yet");
  const { blocks, block } = found;

  // every leaf of the block: the entry hashes of its ids
  const want = new Set(block.ids);
  const shas = new Map<string, string>();
  for await (const e of ledger.readAll("entries")) {
    if (want.has(e.id) && typeof e.textSha256 === "string" && !shas.has(e.id)) {
      shas.set(e.id, e.textSha256);
      if (shas.size === want.size) break;
    }
  }
  if (shas.size !== want.size) throw fail("seal-chain", "an entry of the block is missing from the record");
  let leafSalt: string | null = null;
  if (block.v === 2) {
    leafSalt = await readSalt(ctx.cacheDir, found.host, block.n, ctx.vaultRoot);
    if (!leafSalt) throw fail("salt-elsewhere", "the salt of that block is kept on the computer that sealed it");
  }
  const leaves = block.ids.map((x) => (block.v === 2 ? sealLeafV2(leafSalt as string, x, shas.get(x) as string) : sealLeaf(x, shas.get(x) as string)));
  if (merkleRoot(leaves) !== block.root) throw fail("seal-chain", "the entry hashes no longer give the block's root");
  const index = block.ids.indexOf(id);

  // the original text, exactly as sealed
  const r = await readText(ctx.vaultRoot, rec.text, rec.textSha256, { cache: new SegmentCache(ctx.vaultRoot, 4, 16 * 1024 * 1024), stage: stageLookup(ctx), entryId: rec.id });
  if (!r.ok) throw fail("text-missing", "the original text of that entry cannot be read");
  if (sha256Text(r.text) !== rec.textSha256) throw fail("text-changed", "the original text is not valid text; it cannot be shown exactly");

  const proof: EntryProof = {
    format: "cortex-entry-proof",
    version: 1,
    createdAt: new Date(now()).toISOString(),
    computer: found.host,
    entry: {
      id: rec.id,
      sha256: rec.textSha256,
      text: r.text,
      speaker: rec.speaker,
      source: rec.source,
      ...(rec.title ? { title: rec.title } : {}),
      ...(rec.writtenAt ? { writtenAt: rec.writtenAt } : {}),
      addedAt: rec.addedAt,
      space: rec.space,
    },
    block: headOf(block),
    ...(leafSalt ? { leafSalt } : {}),
    index,
    count: leaves.length,
    path: merklePath(leaves, index),
    links: [],
  };
  if (block.v === 2) proof.signer = { publicKey: block.key, fingerprint: keyFingerprint(block.key), statement: signedStatement(block.hash, block.by), signature: block.sig };

  // the earliest stamp that covers this block (a confirmed one first)
  const stamps = (await readStamps(ctx.vaultRoot, found.host)).filter((s) => s.n >= block.n);
  const stamp: PublicStamp | undefined = stamps.find((s) => s.confirmed) ?? stamps[0];
  const stamped = stamp ? blocks.find((b) => b.n === stamp.n) : undefined;
  if (stamp && stamped) {
    const salt = stamped.v === 2 ? await readSalt(ctx.cacheDir, found.host, stamped.n, ctx.vaultRoot) : null;
    if (stamped.v !== 2 || salt) {
      const ots = await fsp.readFile(path.join(resolveInVault(ctx.vaultRoot, `${CORTEX_PATHS.meta}/seals/${found.host}/public`), stamp.proof));
      proof.links = blocks.filter((b) => b.n > block.n && b.n <= stamped.n).map(headOf);
      proof.timestamp = {
        n: stamp.n,
        at: stamp.at,
        digest: stamp.hash,
        calendar: stamp.calendar,
        ots: ots.toString("base64"),
        ...(salt ? { salt } : {}),
        ...(stamp.auto ? { auto: true } : {}),
        ...(stamp.confirmed ? { bitcoin: { height: stamp.confirmed.height, at: stamp.confirmed.at, header: stamp.confirmed.header, floor: stamp.confirmed.floor } } : {}),
      };
    }
  }
  return proof;
}

/** The files of the proof folder: the proof, the text, the block, the signature, the .ots file, the verifier page and a note. */
export function proofPackFiles(p: EntryProof, strings: VerifierStrings): PackFile[] {
  const json = jsonText(p);
  const files: PackFile[] = [
    { name: "README.txt", data: fillText(strings.readmeProof, { id: p.entry.id, block: p.block.n }) },
    { name: "verify.html", data: buildVerifierHtml(strings, { name: "proof.json", json }) },
    { name: "proof.json", data: json },
    { name: "entry.txt", data: p.entry.text },
    { name: "block.json", data: jsonText(p.block) },
  ];
  if (p.signer) files.push({ name: "signature.txt", data: `key: ${p.signer.publicKey}\nfingerprint: ${p.signer.fingerprint}\nsigned text:\n${p.signer.statement}\nsignature: ${p.signer.signature}\n` });
  if (p.timestamp) files.push({ name: "timestamp.ots", data: Buffer.from(p.timestamp.ots, "base64") });
  return files;
}
