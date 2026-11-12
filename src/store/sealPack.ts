/**
 * What the three packs (proof folder, audit pack, record export) share: the seal chain of every computer as plain
 * block heads (no entry ids, no text), the public timestamps with their .ots files, the salts a checker needs to
 * recompute a stamped fingerprint, and the zip writer wrapper. Owner: proof-audit-export.
 */
import { createHash } from "node:crypto";
import { ZipWriter } from "../node/zip";
import { readSalt } from "../node/sign";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { resolveInVault } from "../node/paths";
import { keyFingerprint } from "../shared/sign";
import type { IsoDate } from "../shared/types";
import { headOf, pad6, readSealChain, readStamps, sealHosts, type BlockHead, type PublicStamp, type SealBlock } from "./dateEvidence";
import { CORTEX_PATHS, type StoreContext } from "./layout";

export interface PackFile {
  /** Path inside the pack, "/" separated. */
  name: string;
  data: string | Uint8Array;
}

export interface PackStamp {
  n: number;
  at: IsoDate;
  /** The digest that was stamped (the public fingerprint of a version 2 block, the hash of a version 1 block). */
  digest: string;
  calendar: string;
  /** The .ots file, base64. */
  ots: string;
  /** Version 2 only: the salt of the stamped block (it turns the block hash into the stamped fingerprint). */
  salt?: string;
  auto?: boolean;
  bitcoin?: { height: number; at: IsoDate; header: string; floor: number };
}

export interface PackComputer {
  computer: string;
  blocks: BlockHead[];
  stamps: PackStamp[];
}

export interface GatheredChain {
  computers: PackComputer[];
  /** The .ots files by pack name ("anchors/<computer>-<n>.ots"). */
  anchors: PackFile[];
  /** Computers whose chain does not read cleanly (damaged or missing blocks); their blocks stop at the damage. */
  damaged: string[];
  /** Timestamps left out because the salt of their block is on another computer. */
  stampsWithoutSalt: number;
  /** The full blocks (with ids) by computer, for callers that need membership. */
  full: Map<string, SealBlock[]>;
}

const SEALS_DIR = `${CORTEX_PATHS.meta}/seals`;

export const sha256File = (b: Uint8Array | string): string => createHash("sha256").update(typeof b === "string" ? Buffer.from(b, "utf8") : b).digest("hex");

/** The seal chain of every computer that wrote into this vault. */
export async function gatherChain(ctx: StoreContext): Promise<GatheredChain> {
  const out: GatheredChain = { computers: [], anchors: [], damaged: [], stampsWithoutSalt: 0, full: new Map() };
  for (const host of await sealHosts(ctx.vaultRoot)) {
    const { blocks, broken } = await readSealChain(ctx.vaultRoot, host);
    if (broken) out.damaged.push(host);
    out.full.set(host, blocks);
    const stamps: PackStamp[] = [];
    for (const s of await readStamps(ctx.vaultRoot, host)) {
      const head = blocks.find((b) => b.n === s.n);
      if (!head) continue;
      let salt: string | null = null;
      if (head.v === 2) {
        salt = await readSalt(ctx.cacheDir, host, s.n, ctx.vaultRoot);
        if (!salt) {
          out.stampsWithoutSalt++;
          continue;
        }
      }
      let ots: Buffer;
      try {
        ots = await fsp.readFile(path.join(resolveInVault(ctx.vaultRoot, `${SEALS_DIR}/${host}/public`), s.proof));
      } catch {
        continue;
      }
      out.anchors.push({ name: `anchors/${host}-${pad6(s.n)}.ots`, data: ots });
      stamps.push(stampRow(s, ots, salt));
    }
    out.computers.push({ computer: host, blocks: blocks.map(headOf), stamps });
  }
  return out;
}

function stampRow(s: PublicStamp, ots: Buffer, salt: string | null): PackStamp {
  return {
    n: s.n,
    at: s.at,
    digest: s.hash,
    calendar: s.calendar,
    ots: ots.toString("base64"),
    ...(salt ? { salt } : {}),
    ...(s.auto ? { auto: true } : {}),
    ...(s.confirmed ? { bitcoin: { height: s.confirmed.height, at: s.confirmed.at, header: s.confirmed.header, floor: s.confirmed.floor } } : {}),
  };
}

/** The signing keys seen in a chain, by fingerprint, with the first block each signed and how many. */
export function keysOf(computers: readonly PackComputer[]): { publicKey: string; fingerprint: string; computer: string; firstBlock: number; blocks: number }[] {
  const rows = new Map<string, { publicKey: string; fingerprint: string; computer: string; firstBlock: number; blocks: number }>();
  for (const c of computers) {
    for (const b of c.blocks) {
      if (b.v !== 2) continue;
      const k = `${c.computer}|${b.key}`;
      const r = rows.get(k);
      if (r) r.blocks++;
      else rows.set(k, { publicKey: b.key, fingerprint: keyFingerprint(b.key), computer: c.computer, firstBlock: b.n, blocks: 1 });
    }
  }
  return [...rows.values()];
}

/** Write the files into a zip at `out` (a temporary file first, renamed when complete). */
export async function writePack(out: string, files: readonly PackFile[], stamp?: Date): Promise<{ files: number; bytes: number }> {
  const zip = new ZipWriter(out, stamp);
  try {
    for (const f of files) await zip.add(f.name, f.data);
    return await zip.finish();
  } catch (e) {
    await zip.abort();
    throw e;
  }
}

/** `{n}` fill-in for the pack texts. */
export function fillText(s: string, vars: Record<string, string | number> = {}): string {
  return s.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

export const jsonText = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
