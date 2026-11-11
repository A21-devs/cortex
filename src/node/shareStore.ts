/**
 * The one key share that stays on this computer. It lives in the local cache folder (`keys/vault-share.local.json`), never
 * inside the vault, so a synced vault carries no share. One share alone opens nothing: it takes the threshold's worth.
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { decodeShare, SHARE_BYTES } from "../shared/crypto/shamir";
import { fromBase64, toBase64 } from "../shared/crypto/vaultKey";
import { readTextIfExists, withFsRetry, writeFileAtomic } from "./fsAtomic";
import { cacheWritablePath } from "./paths";

const REL = "keys/vault-share.local.json";

export interface LocalShareStore {
  /** The 40 share bytes, or null when none is kept (or the file is damaged). */
  read(): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): Promise<void>;
  remove(): Promise<void>;
}

export function createLocalShareStore(cacheDir: string): LocalShareStore {
  return {
    async read() {
      try {
        const text = await readTextIfExists(path.join(cacheDir, REL));
        if (text === null) return null;
        const raw = JSON.parse(text) as { v?: unknown; share?: unknown };
        if (raw.v !== 1 || typeof raw.share !== "string") return null;
        const bytes = fromBase64(raw.share);
        return bytes && bytes.length === SHARE_BYTES && decodeShare(bytes).ok ? bytes : null;
      } catch {
        return null;
      }
    },
    async write(bytes) {
      const abs = cacheWritablePath(cacheDir, REL);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await writeFileAtomic(abs, `${JSON.stringify({ v: 1, share: toBase64(bytes) })}\n`);
    },
    async remove() {
      await withFsRetry(() => fsp.rm(cacheWritablePath(cacheDir, REL), { force: true }));
    },
  };
}
