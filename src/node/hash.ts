/**
 * Fast hashing with node:crypto (runner and plugin). Owner: E1.
 * Digests equal those of shared/sha256.ts (the browser-safe implementation used by the worker and for ids).
 * File hashing streams in 1 MB chunks (constant memory for multi-GB exports); `sha256FileRange` verifies the
 * byte range a `.raw/` text reference points at (INPLACE-TEXTREF).
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { CortexError } from "../shared/errors";

const CHUNK = 1024 * 1024;

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha1Text(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

function hashStream(absPath: string, opts: { start?: number; end?: number }, signal?: AbortSignal): Promise<{ hex: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CortexError("E_CANCELLED", "cancelled"));
      return;
    }
    const h = createHash("sha256");
    let bytes = 0;
    const stream = createReadStream(absPath, { highWaterMark: CHUNK, ...opts });
    const onAbort = (): void => {
      stream.destroy();
      reject(new CortexError("E_CANCELLED", "cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    stream
      .on("data", (chunk) => {
        const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        bytes += b.length;
        h.update(b);
      })
      .on("error", (e) => {
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      })
      .on("end", () => {
        signal?.removeEventListener("abort", onAbort);
        resolve({ hex: h.digest("hex"), bytes });
      });
  });
}

/** Streaming sha256 of a whole file (constant memory). */
export async function sha256File(absPath: string, signal?: AbortSignal): Promise<string> {
  return (await hashStream(absPath, {}, signal)).hex;
}

/**
 * sha256 of bytes [start, end) of a file. Rejects with E_IO (detail.short = true) when the file is shorter than
 * the range, which a caller reads as "changed at source".
 */
export async function sha256FileRange(absPath: string, start: number, end: number, signal?: AbortSignal): Promise<string> {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) throw new CortexError("E_BAD_REQUEST", `invalid byte range [${start}, ${end})`);
  if (end === start) return sha256Bytes(new Uint8Array(0));
  const r = await hashStream(absPath, { start, end: end - 1 }, signal);
  if (r.bytes !== end - start) throw new CortexError("E_IO", "file is shorter than the byte range", { detail: { short: true, expected: end - start, read: r.bytes } });
  return r.hex;
}
