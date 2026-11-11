/**
 * Key material on disk. The passphrase envelope lives in the vault (`.vault-meta/cortex/keys/vault-key.json`: it
 * travels with the record and opens only with the passphrase). The account-sealed copy (Electron safeStorage, "This
 * Windows account") lives in the local cache folder (`keys/vault-key.os.json`) and never leaves this computer.
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { parseEnvelope, type KeyEnvelope } from "../shared/crypto/vaultKey";
import type { EnvelopeRead, OsKeyBridge, RecordKeyAccess } from "../shared/crypto/access";
import { readTextIfExists, withFsRetry, writeFileAtomic } from "./fsAtomic";
import { cacheWritablePath, resolveInVault, writablePath } from "./paths";

export const ENVELOPE_REL = ".vault-meta/cortex/keys/vault-key.json";
const OS_REL = "keys/vault-key.os.json";

export async function readEnvelopeFile(vaultRoot: string): Promise<EnvelopeRead> {
  let text: string | null;
  try {
    text = await readTextIfExists(resolveInVault(vaultRoot, ENVELOPE_REL));
  } catch {
    return { state: "damaged" };
  }
  if (text === null) return { state: "none" };
  try {
    const env = parseEnvelope(JSON.parse(text));
    return env ? { state: "ok", envelope: env } : { state: "damaged" };
  } catch {
    return { state: "damaged" };
  }
}

export async function writeEnvelopeFile(vaultRoot: string, env: KeyEnvelope): Promise<void> {
  const abs = writablePath(vaultRoot, ENVELOPE_REL);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await writeFileAtomic(abs, `${JSON.stringify(env, null, 2)}\n`);
}

export async function removeEnvelopeFile(vaultRoot: string): Promise<void> {
  await withFsRetry(() => fsp.rm(writablePath(vaultRoot, ENVELOPE_REL), { force: true }));
}

interface OsFile {
  v: 1;
  keyId: string;
  blob: string;
}

async function readOsFile(cacheDir: string): Promise<OsFile | null> {
  try {
    const text = await readTextIfExists(path.join(cacheDir, OS_REL));
    if (text === null) return null;
    const raw = JSON.parse(text) as Partial<OsFile>;
    return raw.v === 1 && typeof raw.keyId === "string" && typeof raw.blob === "string" && raw.blob.length > 0 ? { v: 1, keyId: raw.keyId, blob: raw.blob } : null;
  } catch {
    return null;
  }
}

export interface RecordKeyAccessDeps {
  vaultRoot: string;
  cacheDir: string;
  /** The desktop shell's account sealing; absent in Obsidian. */
  os?: OsKeyBridge | null;
}

/** The Node implementation of RecordKeyAccess. */
export function createRecordKeyAccess(d: RecordKeyAccessDeps): RecordKeyAccess {
  const bridge = (): OsKeyBridge | null => d.os ?? null;
  return {
    readEnvelope: () => readEnvelopeFile(d.vaultRoot),
    writeEnvelope: (env) => writeEnvelopeFile(d.vaultRoot, env),
    removeEnvelope: () => removeEnvelopeFile(d.vaultRoot),
    async osOffered() {
      const b = bridge();
      if (!b) return false;
      try {
        return await b.available();
      } catch {
        return false;
      }
    },
    async osReady() {
      if (!(await this.osOffered())) return false;
      const [file, env] = await Promise.all([readOsFile(d.cacheDir), readEnvelopeFile(d.vaultRoot)]);
      return file !== null && env.state === "ok" && file.keyId === env.envelope.keyId;
    },
    async enrolOs(key, id) {
      const b = bridge();
      if (!b || !(await this.osOffered())) return false;
      const blob = await b.protect(key);
      if (!blob) return false;
      const abs = cacheWritablePath(d.cacheDir, OS_REL);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await writeFileAtomic(abs, `${JSON.stringify({ v: 1, keyId: id, blob } satisfies OsFile)}\n`);
      return true;
    },
    async removeOs() {
      await withFsRetry(() => fsp.rm(cacheWritablePath(d.cacheDir, OS_REL), { force: true }));
    },
    async openOs(id) {
      const b = bridge();
      if (!b) return null;
      const file = await readOsFile(d.cacheDir);
      if (!file || file.keyId !== id) return null;
      try {
        return await b.unprotect(file.blob);
      } catch {
        return null;
      }
    },
  };
}
