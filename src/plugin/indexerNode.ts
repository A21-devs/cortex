/**
 * The disk-backed side of the index service: cache files, the cache signal, the vault part. Owner: E7.
 * Kept apart from indexer.ts so the types the UI imports never pull Node modules into the browser typecheck; the
 * container builds the service from here.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { CortexSettings } from "../shared/settings";
import { readIndexHeader } from "../shared/indexCodec";
import { readCacheBuffer } from "../store/indexBuilder";
import { cacheLayout } from "../store/layout";
import { readLedgerSeq } from "../store/ledger";
import { readSignal, watchSignal } from "../store/signal";
import { createIndexService, type IndexDeps, type IndexIo, type IndexServiceExt } from "./indexer";
import { buildVaultIndex, readVaultCache, vaultCacheKey, watchVault, writeVaultCache, type VaultApp } from "./vaultSource";

/** Changes after the last build that make the record index out of date. */
const STALE_KINDS = ["entries", "staged", "labels", "notes", "corrections"] as const;

export interface NodeIndexIoDeps {
  app: VaultApp;
  vaultRoot: string;
  cacheDir: string;
  owner: string;
  lockStaleMs?: number;
  settings: { readonly value: CortexSettings };
}

export function createNodeIndexIo(nd: NodeIndexIoDeps): IndexIo {
  const layout = cacheLayout(nd.cacheDir);
  const store = { cacheDir: nd.cacheDir, owner: nd.owner, lockStaleMs: nd.lockStaleMs ?? 60_000 };
  const enabled = (): boolean => nd.settings.value.sources.vault.enabled;

  async function build(epoch: string | null): Promise<ArrayBuffer | null> {
    if (!enabled()) return null;
    const key = vaultCacheKey(nd.app, nd.settings.value);
    if (epoch !== null) {
      const cached = await readVaultCache(nd.cacheDir, key, epoch);
      if (cached) return cached;
    }
    const part = await buildVaultIndex(nd.app, nd.settings.value, { store });
    const built = readIndexHeader(part).epoch;
    if (epoch !== null && built !== epoch) return null;
    await writeVaultCache(nd.cacheDir, key, built, part);
    return part;
  }

  return {
    readRecord: () => readCacheBuffer(layout.recordIndex),
    readDelta: () => readCacheBuffer(layout.recordDelta),
    async readSearchShards() {
      let names: string[];
      try {
        names = (await fsp.readdir(layout.searchDir)).filter((n) => n.endsWith(".cxs"));
      } catch {
        return [];
      }
      const order = (n: string): string => (n === "live.cxs" ? "~live" : n);
      names.sort((a, b) => (order(a) < order(b) ? -1 : 1));
      const out: ArrayBuffer[] = [];
      for (const n of names) {
        const b = await readCacheBuffer(path.join(layout.searchDir, n));
        if (b) out.push(b);
      }
      return out;
    },
    async marks() {
      return (await readSignal(nd.cacheDir))?.marks ?? {};
    },
    async isStale(headerSeq) {
      const sig = await readSignal(nd.cacheDir);
      const ledgerSeq = await readLedgerSeq(nd.vaultRoot);
      if (!sig) return headerSeq < ledgerSeq;
      const built = Math.max(sig.marks["record-index"] ?? 0, sig.marks["record-delta"] ?? 0, sig.marks["record-checked"] ?? 0);
      if (STALE_KINDS.some((k) => (sig.marks[k] ?? 0) > built)) return true;
      // Commits the signal never heard of: a runner from before every commit signalled (whose imports never reached
      // the index), or one stopped between the two writes. The ledger moved past both the index and the signal.
      return headerSeq < ledgerSeq && sig.seq < ledgerSeq;
    },
    vaultPart: (epoch) => build(epoch),
    rebuildVault: () => build(null),
    watchCache(onSignal, onError) {
      const w = watchSignal(nd.cacheDir, (sig, changed) => onSignal(sig, changed), { onError });
      return () => w.close();
    },
    watchVault: (onChange) => watchVault(nd.app, () => onChange()),
  };
}

export interface NodeIndexDeps extends Omit<IndexDeps, "io">, NodeIndexIoDeps {}

export function createNodeIndexService(nd: NodeIndexDeps): IndexServiceExt {
  const { app, vaultRoot, cacheDir, owner, lockStaleMs, settings, ...rest } = nd;
  return createIndexService({ ...rest, io: createNodeIndexIo({ app, vaultRoot, cacheDir, owner, settings, ...(lockStaleMs !== undefined ? { lockStaleMs } : {}) }) });
}
