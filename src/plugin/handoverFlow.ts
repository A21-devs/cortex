/**
 * The steps behind Settings > Lock > "Who holds which share" and "Heir or custodian": writing the dated entry that records a
 * designation (through New entry, then the seal run, so the day stands), saving a hand-over sheet, and building the hand-over
 * bundle (an encrypted export, the heir's share, a read-me and the offline reader, in one zip). Nothing here releases
 * anything: every step is something the owner starts, and the bundle goes only where the owner saves it.
 */
import * as os from "node:os";
import * as path from "node:path";
import { promises as fsp } from "node:fs";
import { randomBytes } from "node:crypto";
import { heldVaultKey, recordKeyState } from "../shared/crypto/keyring";
import { decodeShare, shareChecksum } from "../shared/crypto/shamir";
import { SPACES } from "../shared/spaces";
import { decryptExportBytes, encryptExportBytes, ENCRYPT_MAX_BYTES } from "../store/exportCrypto";
import { writePack, type PackFile } from "../store/sealPack";
import type { RecordedEntry } from "./handoverRecord";
import { buildReadme, buildSheetHtml, type SheetInput } from "./handoverSheet";
import { stamp } from "./packs";
import { chooseSavePath, type SaveDeps } from "./saveFile";
import type { CortexServices } from "./services";
import { verifierStrings } from "./verifierStrings";

/** Today as `yyyy-mm-dd` in local time. */
export function today(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export type RecordOutcome = { ok: true } | { ok: false; reason: "sample" | "failed"; detail: string };

/** Add the entry to the record (a written entry, imported at once) and seal it, so a block holds it from today. */
export async function recordSealed(sv: Pick<CortexServices, "sandbox" | "newEntry" | "runner">, e: RecordedEntry): Promise<RecordOutcome> {
  if (sv.sandbox.value) return { ok: false, reason: "sample", detail: "" };
  try {
    await sv.newEntry.save({ title: e.title, body: e.body });
    const r = await sv.runner.request({ cmd: "seals.run", args: { force: true } });
    if (r.entries < 1) return { ok: false, reason: "failed", detail: "" };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "failed", detail: err instanceof Error ? err.message.replace(/[.\s]+$/, "") : "" };
  }
}

/** Save one share's sheet where the owner chooses. Resolves to the path, or null when cancelled. */
export async function saveSheet(sv: Pick<CortexServices, "save">, input: SheetInput): Promise<string | null> {
  return sv.save({ suggestedName: `cortex-share-${input.x}-${stamp()}.html`, mime: "text/html", data: buildSheetHtml(input) });
}

export type BundleResult = { ok: true; path: string; entries: number } | { ok: false; reason: "closed" | "cancelled" | "empty" | "failed" | "sample" };

export interface BundleInput {
  name: string;
  letter: string;
  /** Area ids to include; empty = every area. */
  areas: readonly string[];
  /** The share that goes inside, as its 40 bytes, with its point and the set's size; null = none inside. */
  share: { bytes: Uint8Array; x: number } | null;
  n: number;
  k: number;
  now?: Date;
}

/**
 * The hand-over bundle. The export runs through the background program (the same one as "Export my record"), is encrypted with a
 * key derived from the record's key, opened again to check, and only then put into the zip with the reader and the read-me.
 * The temporary files live in the system's temp folder and are removed at the end, whatever happens.
 */
export async function buildHandoverBundle(sv: CortexServices, input: BundleInput, deps: Pick<SaveDeps, "dialog" | "home" | "exists"> = {}): Promise<BundleResult> {
  if (sv.sandbox.value) return { ok: false, reason: "sample" };
  const key = heldVaultKey();
  if (!key || recordKeyState() !== "open") return { ok: false, reason: "closed" };
  const out = await chooseSavePath({ suggestedName: `cortex-handover-${stamp()}.zip`, mime: "application/zip" }, deps);
  if (!out) return { ok: false, reason: "cancelled" };
  const tmp = path.join(os.tmpdir(), `cortex-handover-${randomBytes(6).toString("hex")}.zip`);
  try {
    const known = new Set(SPACES.map((s) => s.id as string));
    const r = await sv.runner.request({
      cmd: "export.record",
      args: { out: tmp, strings: verifierStrings(), areas: input.areas.filter((a) => known.has(a)), includeClosed: true, openSpaces: [] },
    });
    if (r.entries === 0) return { ok: false, reason: "empty" };
    const stat = await fsp.stat(tmp);
    if (stat.size > ENCRYPT_MAX_BYTES) return { ok: false, reason: "failed" };
    const plain = await fsp.readFile(tmp);
    const enc = encryptExportBytes(plain, key);
    const back = decryptExportBytes(enc, key);
    if (!back || !Buffer.from(back).equals(plain)) return { ok: false, reason: "failed" };
    const date = today(input.now);
    const files: PackFile[] = [];
    let shareFile: string | null = null;
    if (input.share) {
      const d = decodeShare(input.share.bytes);
      if (d.ok) {
        shareFile = `share-${input.share.x}.html`;
        files.push({ name: shareFile, data: buildSheetHtml({ holder: input.name, contact: "", instructions: "", x: input.share.x, n: input.n, k: input.k, checksum: shareChecksum(input.share.bytes), share: input.share.bytes, date }) });
      }
    }
    const hasLetter = input.letter.trim().length > 0;
    files.unshift({ name: "README.txt", data: buildReadme({ name: input.name, date, entries: r.entries, n: input.n, k: input.k, shareFile, hasLetter }) });
    files.push({ name: "record.cortexenc", data: enc }, { name: "reader.html", data: (await import("./handoverReader")).buildReaderHtml() });
    if (hasLetter) files.push({ name: "letter.txt", data: `${input.letter.replace(/\r?\n/g, "\r\n")}\r\n` });
    await writePack(out, files);
    return { ok: true, path: out, entries: r.entries };
  } catch {
    return { ok: false, reason: "failed" };
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
  }
}
