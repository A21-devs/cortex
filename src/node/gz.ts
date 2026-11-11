/**
 * Gzip helpers for record segments (`*.jsonl.gz`). Owner: E1.
 * Segments are small (one conversation's new lines per import), so whole-buffer zlib calls on the libuv thread
 * pool are fine; nothing here blocks the event loop. Decompression is capped (a damaged or hostile file cannot
 * exhaust memory) and a truncated or corrupt file fails with E_PARSE instead of a raw zlib error.
 */
import { promises as fsp } from "node:fs";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { CortexError } from "../shared/errors";
import { errCode, withFsRetry, writeFileExclusive } from "./fsAtomic";
import type { WritablePath } from "./paths";
import { decodeFile, encodeFile } from "./vaultCipher";

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

/** Largest decompressed segment Cortex accepts (a segment holds one conversation's new lines). */
export const MAX_GUNZIP_BYTES = 512 * 1024 * 1024;

export async function gzipText(text: string, level = 6): Promise<Uint8Array> {
  return new Uint8Array(await gzipAsync(Buffer.from(text, "utf8"), { level }));
}

/** Gunzip to UTF-8 text; concatenated gzip members are supported. */
export async function gunzipToText(bytes: Uint8Array, maxBytes = MAX_GUNZIP_BYTES): Promise<string> {
  try {
    const out = await gunzipAsync(bytes, { maxOutputLength: maxBytes });
    return out.toString("utf8");
  } catch (e) {
    const code = errCode(e);
    if (code === "ERR_BUFFER_TOO_LARGE") throw new CortexError("E_PARSE", `gzip data expands beyond ${maxBytes} bytes`, { cause: e });
    throw new CortexError("E_PARSE", `gzip data is truncated or corrupt (${code ?? "unknown"})`, { cause: e, detail: { code: code ?? "unknown" } });
  }
}

/** Write an immutable gzip file (exclusive create: never replaces an existing segment). Returns its size. */
export async function writeGzipExclusive(absPath: WritablePath, text: string): Promise<number> {
  // While the record is encrypted the gzip bytes are wrapped in one AES-256-GCM file frame (vaultCipher.ts); locked: E_LOCKED.
  const gz = encodeFile(await gzipText(text));
  await writeFileExclusive(absPath, gz);
  return gz.byteLength;
}

/** Read and gunzip a file (ENOENT and other I/O errors propagate unchanged; bad data is E_PARSE). */
export async function readGzipText(absPath: string, maxBytes = MAX_GUNZIP_BYTES): Promise<string> {
  const bytes = await withFsRetry(() => fsp.readFile(absPath), 3);
  return gunzipToText(decodeFile(bytes), maxBytes);
}
