/**
 * Optional encryption of a finished record export. Only well-known primitives from Node: AES-256-GCM (a fresh random
 * 96-bit nonce per file, the frame format of shared/crypto/vaultKey.ts), a key derived with HKDF-SHA-256 from the
 * record's key and a fresh random 16-byte salt per export, so no two exports share a key. Owner: proof-audit-export.
 *
 * File layout: "CXX1" + 16 salt bytes + one AES-GCM file frame. Tested with round trips, a wrong key, and a changed
 * byte; it runs only on a file Cortex just wrote (a record export), never on stored record data.
 */
import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import { writeExternalFileAtomic } from "../node/fsAtomic";
import { openFrameSync, sealFrameSync } from "../node/vaultCipher";
import { CortexError } from "../shared/errors";

export const EXPORT_MAGIC = Buffer.from("CXX1", "ascii");
const SALT_BYTES = 16;
/** One AES-GCM frame holds the whole file, so the largest export that can be encrypted in memory. */
export const ENCRYPT_MAX_BYTES = 1024 * 1024 * 1024;
const INFO = Buffer.from("cortex record export v1", "utf8");

function exportKey(vaultKey: Uint8Array, salt: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", vaultKey, salt, INFO, 32));
}

/** magic "CXX1" + 16 random salt bytes + one AES-256-GCM file frame (fresh random nonce) under HKDF-SHA-256(record key, salt). */
export function encryptExportBytes(plain: Uint8Array, vaultKey: Uint8Array): Uint8Array {
  if (vaultKey.length !== 32) throw new CortexError("E_BAD_REQUEST", "the record key is not 32 bytes");
  const salt = randomBytes(SALT_BYTES);
  const frame = sealFrameSync(exportKey(vaultKey, salt), plain, "file");
  return Buffer.concat([EXPORT_MAGIC, salt, frame]);
}

/** The plain bytes, or null when this is not an encrypted export, the key is wrong, or any byte was changed. */
export function decryptExportBytes(bytes: Uint8Array, vaultKey: Uint8Array): Uint8Array | null {
  if (bytes.length < EXPORT_MAGIC.length + SALT_BYTES || !Buffer.from(bytes.subarray(0, 4)).equals(EXPORT_MAGIC)) return null;
  const salt = bytes.subarray(4, 4 + SALT_BYTES);
  return openFrameSync(exportKey(vaultKey, salt), bytes.subarray(4 + SALT_BYTES), "file");
}

/**
 * Encrypt a finished export in place of the plain zip: the result is `<zip>.cortexenc`. The ciphertext is opened again in
 * memory and compared with the original, written, read back from disk and compared by hash, and only then is the plain
 * zip removed. Any failure leaves the plain zip as it was and removes the partial file.
 */
export async function encryptExportFile(zipPath: string, vaultKey: Uint8Array): Promise<string> {
  const st = await fsp.stat(zipPath);
  if (st.size > ENCRYPT_MAX_BYTES) throw new CortexError("E_IO", "the export is too large to encrypt in one piece", { detail: { reason: "encrypt-size" } });
  const plain = await fsp.readFile(zipPath);
  const target = `${zipPath}.cortexenc`;
  const enc = encryptExportBytes(plain, vaultKey);
  const back = decryptExportBytes(enc, vaultKey);
  if (!back || !Buffer.from(back).equals(plain)) throw new CortexError("E_IO", "the encrypted copy did not open again", { detail: { reason: "encrypt-verify" } });
  try {
    await writeExternalFileAtomic(target, enc);
    const onDisk = await fsp.readFile(target);
    if (createHash("sha256").update(onDisk).digest("hex") !== createHash("sha256").update(enc).digest("hex")) throw new CortexError("E_IO", "the encrypted file did not read back", { detail: { reason: "encrypt-readback" } });
  } catch (e) {
    await fsp.rm(target, { force: true });
    throw e;
  }
  await fsp.rm(zipPath, { force: true });
  return target;
}

