/**
 * Synchronous SHA-256 (FIPS 180-4) in plain TypeScript, so ids and hashes are computed identically in the
 * runner, the plugin, the layout worker and tests. `Sha256` hashes incrementally (constant memory, any chunk
 * sizes); `sha256()` is the one-shot form. For multi-GB files the runner uses node:crypto (src/node/hash.ts),
 * which produces the same digests. Owner: E1.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19] as const;

const encoder = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

/** Incremental SHA-256: `update()` any number of times, then `digest()` once. */
export class Sha256 {
  private readonly h = new Uint32Array(H0);
  private readonly w = new Uint32Array(64);
  private readonly block = new Uint8Array(64);
  private readonly blockView = new DataView(this.block.buffer);
  private blockLen = 0;
  /** Total bytes hashed so far (exact up to 2^53). */
  private total = 0;
  private finished = false;

  update(input: Uint8Array | string): this {
    if (this.finished) throw new Error("Sha256: update() after digest()");
    const data = typeof input === "string" ? utf8(input) : input;
    this.total += data.length;
    let off = 0;
    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, data.length);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      off = take;
      if (this.blockLen === 64) {
        this.compress(this.blockView, 0);
        this.blockLen = 0;
      }
    }
    if (off < data.length) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      while (data.length - off >= 64) {
        this.compress(view, off);
        off += 64;
      }
      if (off < data.length) {
        this.block.set(data.subarray(off), 0);
        this.blockLen = data.length - off;
      }
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.finished) throw new Error("Sha256: digest() called twice");
    this.finished = true;
    const bitsHi = Math.floor((this.total * 8) / 0x100000000);
    const bitsLo = (this.total * 8) >>> 0;
    this.block[this.blockLen++] = 0x80;
    if (this.blockLen > 56) {
      this.block.fill(0, this.blockLen);
      this.compress(this.blockView, 0);
      this.blockLen = 0;
    }
    this.block.fill(0, this.blockLen);
    this.blockView.setUint32(56, bitsHi, false);
    this.blockView.setUint32(60, bitsLo, false);
    this.compress(this.blockView, 0);
    const out = new Uint8Array(32);
    const ov = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) ov.setUint32(i * 4, this.h[i] as number, false);
    return out;
  }

  private compress(view: DataView, off: number): void {
    const w = this.w;
    const h = this.h;
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] as number;
      const w2 = w[i - 2] as number;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = ((h[0] as number) + a) >>> 0;
    h[1] = ((h[1] as number) + b) >>> 0;
    h[2] = ((h[2] as number) + c) >>> 0;
    h[3] = ((h[3] as number) + d) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0;
    h[5] = ((h[5] as number) + f) >>> 0;
    h[6] = ((h[6] as number) + g) >>> 0;
    h[7] = ((h[7] as number) + hh) >>> 0;
  }
}

/** SHA-256 digest of bytes (or a string, UTF-8 encoded). */
export function sha256(input: Uint8Array | string): Uint8Array {
  return new Sha256().update(input).digest();
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function sha256Hex(input: Uint8Array | string): string {
  return toHex(sha256(input));
}
