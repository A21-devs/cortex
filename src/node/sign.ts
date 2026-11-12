/**
 * Ed25519 (RFC 8032) on node:crypto, plus the local key store for seal signing and salts. Owner: seal-date-v2.
 *
 * Nothing is implemented here beyond key encoding: signing and verifying are Node's own. Keys are held as raw
 * bytes (32-byte seed, 32-byte public key) and wrapped in the fixed PKCS#8 / SPKI prefixes Node needs.
 *
 * The signing key lives in `<cache>/keys/seal-signing.json` on THIS computer only (never inside the vault, so it
 * never syncs, and the "Clear cache" action leaves it alone), written with owner-only permissions where the system
 * supports them. While the record is encrypted the seed is wrapped by the vault key (file version 2: the seed is an
 * AES-GCM frame, the public key stays readable); a plain version 1 file is wrapped the first time the key is held
 * and unwrapped again when the record is decrypted.
 *
 * The salts (one random 32-byte salt per sealed block) are part of the record: they live beside the blocks in
 * `<vault>/.vault-meta/cortex/seals/<computer>/salts.json`, written like a block (encrypted when the record is).
 * `<cache>/keys/seal-salts.json` is the older home and stays as a copy; `migrateSalts` copies it across. Losing the
 * salts costs only the ability to recompute a block's public fingerprint; blocks, chain and signatures still verify.
 */
import { createPrivateKey, createPublicKey, randomBytes, sign as edSign, verify as edVerify } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { CortexError } from "../shared/errors";
import { looksLikeFrame } from "../shared/crypto/vaultKey";
import { heldVaultKey, recordKeyState } from "../shared/crypto/keyring";
import { isHex } from "../shared/sign";
import { cacheWritablePath, resolveInVault, writablePath } from "./paths";
import { readJsonIfExists, readSealedJson, writeFileAtomic, writeSealedJson } from "./fsAtomic";
import { openFrameSync, sealFrameSync, writeKey } from "./vaultCipher";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface Ed25519Keys {
  /** 32 bytes, hex. */
  seed: string;
  /** 32 bytes, hex. */
  publicKey: string;
}

export function ed25519FromSeed(seedHex: string): Ed25519Keys {
  if (!isHex(seedHex, 32)) throw new Error("an Ed25519 seed is 32 bytes");
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(priv).export({ format: "der", type: "spki" });
  return { seed: seedHex, publicKey: Buffer.from(spki).subarray(spki.length - 32).toString("hex") };
}

export function newEd25519(): Ed25519Keys {
  return ed25519FromSeed(randomBytes(32).toString("hex"));
}

/** The 64-byte signature of `message` as hex. Ed25519 is deterministic: the same seed and message give the same bytes. */
export function ed25519Sign(seedHex: string, message: Uint8Array | string): string {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
  return edSign(null, typeof message === "string" ? Buffer.from(message, "utf8") : message, priv).toString("hex");
}

export function ed25519Verify(publicKeyHex: string, message: Uint8Array | string, signatureHex: string): boolean {
  if (!isHex(publicKeyHex, 32) || !isHex(signatureHex, 64)) return false;
  try {
    const pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    return edVerify(null, typeof message === "string" ? Buffer.from(message, "utf8") : message, pub, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

// ───────────────────────────── the local key store ─────────────────────────────

const KEYS_DIR = "keys";
const SIGNING_FILE = `${KEYS_DIR}/seal-signing.json`;
const SALTS_FILE = `${KEYS_DIR}/seal-salts.json`;

interface SigningFile {
  v: 1;
  seed: string;
  publicKey: string;
  createdAt: string;
}
interface SigningFileV2 {
  v: 2;
  /** base64 of an AES-256-GCM "file" frame holding the 32-byte seed. */
  wrapped: string;
  publicKey: string;
  createdAt: string;
}
interface SaltsFile {
  v: 1;
  /** "<computer>/<block number>" → 32-byte hex salt. */
  salts: Record<string, string>;
}

async function ownerOnly(abs: string): Promise<void> {
  try {
    await fsp.chmod(abs, 0o600);
  } catch {
    // systems without POSIX modes: the folder lives under the person's own profile
  }
}

/** The key to wrap with: null while the record is plain (or writes are plain) or locked. */
function wrapKey(): Uint8Array | null {
  try {
    return writeKey();
  } catch {
    return null;
  }
}

function wrapSeed(key: Uint8Array, seedHex: string): string {
  return Buffer.from(sealFrameSync(key, Buffer.from(seedHex, "hex"), "file")).toString("base64");
}

function unwrapSeed(key: Uint8Array, wrapped: string): string | null {
  const frame = Buffer.from(wrapped, "base64");
  if (!looksLikeFrame(frame)) return null;
  const plain = openFrameSync(key, frame, "file");
  return plain && plain.length === 32 ? Buffer.from(plain).toString("hex") : null;
}

async function writeSigningFile(cacheDir: string, file: SigningFile | SigningFileV2): Promise<void> {
  await fsp.mkdir(path.join(cacheDir, KEYS_DIR), { recursive: true });
  const target = cacheWritablePath(cacheDir, SIGNING_FILE);
  await writeFileAtomic(target, `${JSON.stringify(file, null, 2)}\n`);
  await ownerOnly(target);
}

async function readSigningFile(cacheDir: string): Promise<SigningFile | SigningFileV2 | null> {
  try {
    const raw = await readJsonIfExists<SigningFile | SigningFileV2>(path.join(cacheDir, SIGNING_FILE));
    if (raw && raw.v === 1 && isHex(raw.seed, 32) && isHex(raw.publicKey, 32)) return raw;
    if (raw && raw.v === 2 && typeof raw.wrapped === "string" && isHex(raw.publicKey, 32)) return raw;
  } catch {
    // an unreadable file is treated as missing
  }
  return null;
}

/**
 * The signing key of this computer; made (once) the first time something is sealed. While the record is encrypted
 * the seed on disk is wrapped by the vault key: a locked record cannot sign (E_LOCKED), and a plain file found while
 * the key is held is wrapped on the spot.
 */
export async function loadOrCreateSigningKey(cacheDir: string, now: () => number = Date.now): Promise<Ed25519Keys & { createdAt: string; created: boolean }> {
  const raw = await readSigningFile(cacheDir);
  if (raw && raw.v === 2) {
    const key = heldVaultKey();
    if (key) {
      const seed = unwrapSeed(key, raw.wrapped);
      // A file whose public key does not follow from its seed is not used (it would sign blocks nobody can verify).
      if (seed && ed25519FromSeed(seed).publicKey === raw.publicKey) return { seed, publicKey: raw.publicKey, createdAt: raw.createdAt, created: false };
    }
    if (recordKeyState() === "locked") throw new CortexError("E_LOCKED", "the record is encrypted and locked", { detail: { reason: "record-locked" } });
    // a plain record (decrypted elsewhere) or a wrapped seed nobody can open: a new key; old blocks carry their own key and still verify
  } else if (raw && ed25519FromSeed(raw.seed).publicKey === raw.publicKey) {
    const k = wrapKey();
    if (k) await writeSigningFile(cacheDir, { v: 2, wrapped: wrapSeed(k, raw.seed), publicKey: raw.publicKey, createdAt: raw.createdAt });
    return { seed: raw.seed, publicKey: raw.publicKey, createdAt: raw.createdAt, created: false };
  }
  const k = newEd25519();
  const createdAt = new Date(now()).toISOString();
  const wk = writeKey(); // throws E_LOCKED while the record is encrypted and locked
  await writeSigningFile(cacheDir, wk ? { v: 2, wrapped: wrapSeed(wk, k.seed), publicKey: k.publicKey, createdAt } : { v: 1, seed: k.seed, publicKey: k.publicKey, createdAt });
  return { ...k, createdAt, created: true };
}

/**
 * Wrap ("encrypt") or unwrap ("decrypt") the stored seed with `key`; used by the record conversion so the seed
 * follows the record. Idempotent; true when the file changed. No key file is not an error.
 */
export async function convertSigningKey(cacheDir: string, key: Uint8Array, dir: "encrypt" | "decrypt"): Promise<boolean> {
  const raw = await readSigningFile(cacheDir);
  if (!raw) return false;
  if (dir === "encrypt") {
    if (raw.v === 2) return false;
    await writeSigningFile(cacheDir, { v: 2, wrapped: wrapSeed(key, raw.seed), publicKey: raw.publicKey, createdAt: raw.createdAt });
    return true;
  }
  if (raw.v === 1) return false;
  const seed = unwrapSeed(key, raw.wrapped);
  if (!seed || ed25519FromSeed(seed).publicKey !== raw.publicKey) throw new CortexError("E_PARSE", "the stored signing key did not open (wrong key or damaged)", { detail: { reason: "decrypt-failed" } });
  await writeSigningFile(cacheDir, { v: 1, seed, publicKey: raw.publicKey, createdAt: raw.createdAt });
  return true;
}

/** The public half only, when a key exists. */
export async function readSigningPublicKey(cacheDir: string): Promise<string | null> {
  return (await readSigningFile(cacheDir))?.publicKey ?? null;
}

async function readCacheSalts(cacheDir: string): Promise<SaltsFile> {
  try {
    const raw = await readJsonIfExists<SaltsFile>(path.join(cacheDir, SALTS_FILE));
    if (raw && raw.v === 1 && raw.salts && typeof raw.salts === "object") return raw;
  } catch {
    // a damaged salts file is replaced; blocks made with lost salts keep verifying without their fingerprint
  }
  return { v: 1, salts: {} };
}

// ───────────────────────────── the salts, kept with the record ─────────────────────────────

const SEALS_REL = ".vault-meta/cortex/seals";
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const saltsRel = (host: string): string => `${SEALS_REL}/${host}/salts.json`;

async function readVaultSalts(vaultRoot: string, host: string): Promise<SaltsFile> {
  if (!HOST_RE.test(host)) return { v: 1, salts: {} };
  try {
    const raw = await readSealedJson<SaltsFile>(resolveInVault(vaultRoot, saltsRel(host)));
    if (raw && raw.v === 1 && raw.salts && typeof raw.salts === "object") return raw;
  } catch {
    // locked or damaged: the older copy in the cache is tried next
  }
  return { v: 1, salts: {} };
}

/** Add block-number → salt pairs to one computer's file in the record (encrypted while the record is). */
async function writeVaultSalts(vaultRoot: string, host: string, add: Readonly<Record<string, string>>): Promise<number> {
  const cur = await readVaultSalts(vaultRoot, host);
  let changed = 0;
  for (const [n, v] of Object.entries(add)) {
    if (isHex(v, 32) && cur.salts[n] !== v) {
      cur.salts[n] = v;
      changed++;
    }
  }
  if (changed === 0) return 0;
  await fsp.mkdir(resolveInVault(vaultRoot, `${SEALS_REL}/${host}`), { recursive: true });
  await writeSealedJson(writablePath(vaultRoot, saltsRel(host)), cur);
  return changed;
}

/** "<host>/<n>" keyed salts grouped by computer. */
function groupByHost(salts: Readonly<Record<string, string>>): Map<string, Record<string, string>> {
  const byHost = new Map<string, Record<string, string>>();
  for (const [k, v] of Object.entries(salts)) {
    const at = k.lastIndexOf("/");
    if (at <= 0 || !isHex(v, 32)) continue;
    const host = k.slice(0, at);
    if (!HOST_RE.test(host)) continue;
    const m = byHost.get(host) ?? {};
    m[k.slice(at + 1)] = v;
    byHost.set(host, m);
  }
  return byHost;
}

export const newSalt = (): string => randomBytes(32).toString("hex");

/**
 * Keep the salts of freshly made blocks (one write for the whole batch), keys "<computer>/<block number>". With a
 * `vaultRoot` they are kept with the record, which is their home; the cache copy is always written too.
 */
export async function saveSalts(cacheDir: string, add: Readonly<Record<string, string>>, vaultRoot?: string): Promise<void> {
  const cur = await readCacheSalts(cacheDir);
  for (const [k, v] of Object.entries(add)) if (isHex(v, 32)) cur.salts[k] = v;
  await fsp.mkdir(path.join(cacheDir, KEYS_DIR), { recursive: true });
  const target = cacheWritablePath(cacheDir, SALTS_FILE);
  await writeFileAtomic(target, `${JSON.stringify(cur)}\n`);
  await ownerOnly(target);
  if (vaultRoot) for (const [host, m] of groupByHost(add)) await writeVaultSalts(vaultRoot, host, m);
}

/**
 * Copy every salt the cache holds into the record (the vault's seals folder), leaving the cache copy alone. Safe to
 * repeat; quietly stops while an encrypted record is locked. Returns how many salts were added.
 */
export async function migrateSalts(cacheDir: string, vaultRoot: string): Promise<number> {
  const cache = await readCacheSalts(cacheDir);
  let added = 0;
  for (const [host, m] of groupByHost(cache.salts)) {
    try {
      added += await writeVaultSalts(vaultRoot, host, m);
    } catch (e) {
      if (e instanceof CortexError && e.code === "E_LOCKED") return added;
      throw e;
    }
  }
  return added;
}

/** One block's salt: from the record when `vaultRoot` is given and it holds it, else from the cache copy (which is then copied across). */
export async function readSalt(cacheDir: string, host: string, n: number, vaultRoot?: string): Promise<string | null> {
  if (vaultRoot) {
    const v = (await readVaultSalts(vaultRoot, host)).salts[String(n)];
    if (isHex(v, 32)) return v;
  }
  const s = (await readCacheSalts(cacheDir)).salts[`${host}/${n}`];
  if (!isHex(s, 32)) return null;
  if (vaultRoot) await writeVaultSalts(vaultRoot, host, { [String(n)]: s }).catch(() => undefined);
  return s;
}
