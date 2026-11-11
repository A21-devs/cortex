/**
 * A small ZIP writer for the files Cortex hands to other people (proof folders, audit packs, record exports).
 * Plain ZIP (no ZIP64): members are stored or deflated with Node's zlib, names are UTF-8, and the archive is written
 * to a temporary file beside the target and renamed into place on `finish`, so a half-written pack never has the
 * final name. Limits are the format's own (65,535 members, 4 GiB per member and per archive); going past one throws
 * E_IO (reason zip-limit). Owner: proof-audit-export.
 */
import * as zlib from "node:zlib";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { CortexError } from "../shared/errors";

const MAX_MEMBERS = 0xffff;
const MAX_4G = 0xffffffff;

const TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3) of `bytes`: Node's own when it has one, else a plain table version. */
export function crc32Of(bytes: Uint8Array): number {
  const native = (zlib as unknown as { crc32?: (d: Uint8Array) => number }).crc32;
  if (typeof native === "function") return native(bytes) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

const tooBig = (): CortexError => new CortexError("E_IO", "the pack is too large for one zip file", { detail: { reason: "zip-limit" } });

interface Member {
  name: Buffer;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

export class ZipWriter {
  private readonly members: Member[] = [];
  private offset = 0;
  private fh: fsp.FileHandle | null = null;
  private readonly tmp: string;
  private readonly seen = new Set<string>();
  constructor(
    readonly target: string,
    private readonly stamp: Date = new Date(),
  ) {
    this.tmp = `${target}.${process.pid}-${Date.now().toString(36)}.part`;
  }

  private async write(b: Uint8Array): Promise<void> {
    if (!this.fh) this.fh = await fsp.open(this.tmp, "wx");
    let done = 0;
    while (done < b.length) {
      const { bytesWritten } = await this.fh.write(b, done, b.length - done);
      done += bytesWritten;
    }
    this.offset += b.length;
    if (this.offset > MAX_4G) throw tooBig();
  }

  /** Add one member. `name` uses "/" and has no leading slash, "..", or duplicate. */
  async add(name: string, data: Uint8Array | string): Promise<void> {
    if (!name || name.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(name) || name.includes("\\") || this.seen.has(name)) throw new CortexError("E_BAD_REQUEST", "a pack member has an unusable name", { detail: { reason: "zip-name" } });
    if (this.members.length >= MAX_MEMBERS) throw tooBig();
    this.seen.add(name);
    const raw = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (raw.length > MAX_4G) throw tooBig();
    let body: Buffer = raw;
    let method = 0;
    if (raw.length > 64) {
      const d = zlib.deflateRawSync(raw, { level: 6 });
      if (d.length < raw.length) {
        body = d;
        method = 8;
      }
    }
    const nameBytes = Buffer.from(name, "utf8");
    const { time, date } = dosTime(this.stamp);
    const m: Member = { name: nameBytes, method, crc: crc32Of(raw), compressed: body.length, size: raw.length, offset: this.offset, time, date };
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(m.crc, 14);
    h.writeUInt32LE(m.compressed, 18);
    h.writeUInt32LE(m.size, 22);
    h.writeUInt16LE(nameBytes.length, 26);
    h.writeUInt16LE(0, 28);
    await this.write(h);
    await this.write(nameBytes);
    await this.write(body);
    this.members.push(m);
  }

  /** Write the directory, flush, and move the file to its final name. Resolves to the member count and the size. */
  async finish(): Promise<{ files: number; bytes: number }> {
    const start = this.offset;
    for (const m of this.members) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(m.method, 10);
      h.writeUInt16LE(m.time, 12);
      h.writeUInt16LE(m.date, 14);
      h.writeUInt32LE(m.crc, 16);
      h.writeUInt32LE(m.compressed, 20);
      h.writeUInt32LE(m.size, 24);
      h.writeUInt16LE(m.name.length, 28);
      h.writeUInt32LE(m.offset, 42);
      await this.write(h);
      await this.write(m.name);
    }
    const size = this.offset - start;
    const e = Buffer.alloc(22);
    e.writeUInt32LE(0x06054b50, 0);
    e.writeUInt16LE(this.members.length, 8);
    e.writeUInt16LE(this.members.length, 10);
    e.writeUInt32LE(size, 12);
    e.writeUInt32LE(start, 16);
    await this.write(e);
    const fh = this.fh as fsp.FileHandle;
    await fh.sync();
    await fh.close();
    this.fh = null;
    await fsp.mkdir(path.dirname(this.target), { recursive: true });
    await fsp.rename(this.tmp, this.target);
    return { files: this.members.length, bytes: this.offset };
  }

  /** Drop the half-written file (used on any failure). */
  async abort(): Promise<void> {
    try {
      await this.fh?.close();
    } catch {
      // already closed
    }
    this.fh = null;
    await fsp.rm(this.tmp, { force: true });
  }
}
