/**
 * Shared harness for the importer tests of the notes and agent packages: a tiny zip writer (stored or deflated
 * members) and a real store in temp folders (a vault, a cache, the ledger). Synthetic data only.
 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";
import { knownIdsFromLedger, type ImportContext } from "../../src/importers/common";
import { NEVER_CANCELLED } from "../../src/shared/cancel";
import { nullLogger } from "../../src/shared/log";
import { DEFAULT_SETTINGS, type CortexSettings } from "../../src/shared/settings";
import type { EntryRecord } from "../../src/shared/types";
import { createLedgerStore } from "../../src/store/ledger";
import { openStoreContext } from "../../src/store/layout";
import { readText } from "../../src/store/segments";
import { crc32, EOCD_SIGNATURE } from "../../src/importers/zip";

export const tmpDir = (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), "cortex-np-"));

export interface ZipMember {
  name: string;
  data: Buffer | string;
  deflate?: boolean;
}

export function buildZip(members: readonly ZipMember[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const m of members) {
    const raw = Buffer.isBuffer(m.data) ? m.data : Buffer.from(m.data, "utf8");
    const body = m.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(m.name, "utf8");
    const crc = crc32(raw) >>> 0;
    const method = m.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD_SIGNATURE, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

export async function writeZip(members: readonly ZipMember[], dir?: string): Promise<string> {
  const d = dir ?? (await tmpDir());
  const file = path.join(d, "export.zip");
  await fsp.writeFile(file, buildZip(members));
  return file;
}

export function settingsWith(patch?: (s: CortexSettings) => void): CortexSettings {
  const s = structuredClone(DEFAULT_SETTINGS) as CortexSettings;
  patch?.(s);
  return s;
}

export interface Harness {
  vault: string;
  cache: string;
  ctx: ImportContext;
  entries(): Promise<EntryRecord[]>;
  text(e: EntryRecord): Promise<string | null>;
  /** A new pass over the same store (settings may change between passes). */
  next(patch?: (s: CortexSettings) => void, extra?: Partial<ImportContext>): ImportContext;
}

export async function harness(patch?: (s: CortexSettings) => void, extra?: Partial<ImportContext>): Promise<Harness> {
  const vault = await tmpDir();
  const cache = await tmpDir();
  const store = await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
  const ledger = createLedgerStore(store);
  const make = (s: CortexSettings, more?: Partial<ImportContext>): ImportContext => {
    const ctx: ImportContext = {
      store,
      ledger,
      settings: s,
      mayContinue: async () => true,
      token: NEVER_CANCELLED,
      log: nullLogger,
      progress: () => undefined,
      yield: async () => undefined,
      now: () => Date.now(),
      knownEntryIds: (conv) => knownIdsFromLedger(ctx, conv),
      ...more,
    };
    return ctx;
  };
  return {
    vault,
    cache,
    ctx: make(settingsWith(patch), extra),
    next: (p, more) => make(settingsWith(p ?? patch), more ?? extra),
    async entries() {
      const out: EntryRecord[] = [];
      for await (const e of ledger.readAll("entries")) out.push(e);
      return out.sort((a, b) => (a.conv ?? "").localeCompare(b.conv ?? "") || (a.idx ?? 0) - (b.idx ?? 0));
    },
    async text(e) {
      const r = await readText(vault, e.text, e.textSha256);
      return r.ok ? r.text : null;
    },
  };
}
