/**
 * "Export my record": the entries as plain files that outlast this program, chosen by area and period, with the seals
 * and anchors that cover them and a hash manifest. Owner: proof-audit-export.
 *
 * Layout of the zip:
 *   README.txt, verify.html (offline verifier, embeds manifest.json), manifest.json
 *   entries/<area>/<yyyy-mm>.md       readable text, one block per entry
 *   entries/<area>/<yyyy-mm>.jsonl    one JSON object per entry: id, dates, speaker, source, area, original text, sha256,
 *                                     the latest edited text when there is one, and the block that seals it
 *   seals/seals.json                  the seal chain of every computer (block heads) and the timestamps
 *   seals/inclusion.json              for each block holding an exported entry: its salt and every leaf, so a checker can
 *                                     recompute the root and each exported entry's leaf (leaves are HMACs, not text)
 *   seals/anchors/*.ots               the standard OpenTimestamps files
 *
 * What is left out: entries the owner excluded; entries of closed areas unless `includeClosed` (the owner saying
 * otherwise); text held back as secrets stays a marker (the originals live only in this computer's cache and are never
 * read here); live messages that are not saved yet. Text that cannot be read is listed in the manifest, never invented.
 * Optional encryption (store/exportCrypto.ts) wraps the finished zip with AES-256-GCM under a key derived (HKDF-SHA-256, a
 * fresh random salt per export) from the record's key.
 */
import { readSalt } from "../node/sign";
import { SPACES, NO_AREA } from "../shared/spaces";
import type { EntryRecord, IsoDate } from "../shared/types";
import { sealLeaf, sealLeafV2 } from "./dateEvidence";
import type { StoreContext } from "./layout";
import type { LedgerStore } from "./ledger";
import { exclusionFor, foldCorrectionsForReader, withCorrections } from "./recordReader";
import { readText, SegmentCache } from "./segments";
import { stageLookup } from "./stage";
import { fillText, gatherChain, jsonText, sha256File, writePack, type PackFile } from "./sealPack";
import { buildVerifierHtml, type VerifierStrings } from "./verifierPage";

export interface ExportOptions {
  /** Area ids to include; empty = every area. */
  areas?: readonly string[];
  /** First and last day, "YYYY-MM-DD", inclusive; the date is when it was written, else when it was added. */
  from?: string;
  to?: string;
  /** The owner chose to include areas that are not open (consent.openSpaces). */
  includeClosed?: boolean;
  /** Areas, user spaces or folders that are open; everything else is closed. */
  openSpaces?: readonly string[];
  /** A grant's spaces (areas and folders): only entries inside them are exported, whatever else is open. */
  within?: readonly string[];
  /** The most entries a grant has left to read; the newest chosen entries beyond it are left out. */
  maxEntries?: number;
  now?: () => number;
  cortexVersion?: string;
}

export interface ExportResult {
  entries: number;
  skippedClosed: number;
  excluded: number;
  unreadable: number;
  /** Entries that no block holds yet, so they carry no seal. */
  unsealed: number;
  /** Blocks whose leaves could not be listed (their salt is on another computer). */
  inclusionSkipped: number;
  files: number;
  bytes: number;
}

/** True when the area, or the folder path of the entry, is named in the open list (a folder opens everything under it). */
export function isOpenSpace(space: string, folder: readonly string[], open: readonly string[]): boolean {
  if (open.length === 0) return false;
  const set = new Set(open.map((o) => o.replace(/\/+$/, "")));
  if (set.has(space)) return true;
  const parts = [...folder];
  for (let i = parts.length; i > 0; i--) if (set.has(parts.slice(0, i).join("/"))) return true;
  return false;
}

const areaName = (id: string): string => SPACES.find((s) => s.id === id)?.name ?? NO_AREA.name;
const areaDir = (id: string): string => (id === "none" || !/^[a-z0-9-]{1,40}$/.test(id) ? "no-area" : id);
const dayOf = (e: Pick<EntryRecord, "writtenAt" | "addedAt">): IsoDate => e.writtenAt ?? e.addedAt;
const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? "";

interface Picked {
  rec: EntryRecord;
  cur: EntryRecord;
}

export function markdownBlock(cur: EntryRecord, text: string | null, edited: { text: string; version: number } | null, strings: Pick<VerifierStrings, "mdNoDate" | "mdEdited">): string {
  const when = cur.writtenAt ?? cur.addedAt;
  const head = `### ${when.slice(0, 16).replace("T", " ")} · ${cur.speaker}${cur.speakerDetail ? ` (${cur.speakerDetail})` : ""} · ${cur.source}${cur.writtenAt ? "" : ` · ${strings.mdNoDate}`}`;
  const meta = `<!-- id ${cur.id} · sha256 ${cur.textSha256}${edited ? ` · ${fillText(strings.mdEdited, { version: edited.version })}` : ""} -->`;
  const body = edited ? edited.text : (text ?? "");
  return `${head}\n${meta}\n\n${body.replace(/\r\n?/g, "\n").trimEnd()}\n\n`;
}

/** Build the export zip at `out`. Throws nothing for text that cannot be read; those entries are counted. */
export async function exportRecord(ctx: StoreContext, ledger: LedgerStore, out: string, strings: VerifierStrings, opts: ExportOptions = {}): Promise<ExportResult> {
  const now = opts.now ?? Date.now;
  const areas = new Set(opts.areas ?? []);
  const open = opts.openSpaces ?? [];
  const st = foldCorrectionsForReader(await ledger.readCorrections());
  const res: ExportResult = { entries: 0, skippedClosed: 0, excluded: 0, unreadable: 0, unsealed: 0, inclusionSkipped: 0, files: 0, bytes: 0 };

  // 1. choose
  const picked: Picked[] = [];
  const shaOf = new Map<string, string>();
  for await (const rec of ledger.readAll("entries")) {
    if (typeof rec.textSha256 === "string") shaOf.set(rec.id, rec.textSha256);
    const cur = withCorrections(rec, st);
    if (st.excluded.size > 0 && exclusionFor(st, rec) !== null) {
      res.excluded++;
      continue;
    }
    if (areas.size > 0 && !areas.has(cur.space)) continue;
    if (opts.includeClosed !== true && !isOpenSpace(cur.space, cur.folder, open)) {
      res.skippedClosed++;
      continue;
    }
    if (opts.within !== undefined && (!isOpenSpace(cur.space, cur.folder, opts.within) || !isOpenSpace(cur.space, cur.folder, open))) {
      res.skippedClosed++;
      continue;
    }
    const day = dayOf(cur).slice(0, 10);
    if (opts.from && day < opts.from) continue;
    if (opts.to && day > opts.to) continue;
    picked.push({ rec, cur });
  }
  if (opts.maxEntries !== undefined && picked.length > opts.maxEntries) {
    // A grant with a read limit: keep the oldest entries it still has room for.
    picked.sort((a, b) => (dayOf(a.cur) < dayOf(b.cur) ? -1 : dayOf(a.cur) > dayOf(b.cur) ? 1 : a.cur.id < b.cur.id ? -1 : 1));
    res.skippedClosed += picked.length - opts.maxEntries;
    picked.length = Math.max(0, opts.maxEntries);
  }
  picked.sort((a, b) => (dayOf(a.cur) < dayOf(b.cur) ? -1 : dayOf(a.cur) > dayOf(b.cur) ? 1 : (a.cur.conv ?? "") < (b.cur.conv ?? "") ? -1 : (a.cur.conv ?? "") > (b.cur.conv ?? "") ? 1 : (a.cur.idx ?? 0) - (b.cur.idx ?? 0) || (a.cur.id < b.cur.id ? -1 : 1)));

  // 2. which block seals each chosen entry
  const chain = await gatherChain(ctx);
  const chosen = new Set<string>(picked.map((p) => p.rec.id));
  const blockOf = new Map<string, { host: string; n: number }>();
  for (const [host, blocks] of chain.full) {
    for (const b of blocks) for (const id of b.ids) if (chosen.has(id) && !blockOf.has(id)) blockOf.set(id, { host, n: b.n });
  }
  res.unsealed = picked.filter((p) => !blockOf.has(p.rec.id)).length;

  // 3. write the entry files, month by month
  const files: { name: string; bytes: number; sha256: string }[] = [];
  const entryFiles: PackFile[] = [];
  const segCache = new SegmentCache(ctx.vaultRoot, 48, 64 * 1024 * 1024);
  const stage = stageLookup(ctx);
  const groups = new Map<string, Picked[]>();
  for (const p of picked) {
    const month = dayOf(p.cur).slice(0, 7);
    const key = `${areaDir(p.cur.space)}/${/^\d{4}-\d{2}$/.test(month) ? month : "undated"}`;
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  for (const [key, list] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let md = `# ${areaName(list[0]!.cur.space)} · ${key.split("/")[1]}\n\n`;
    let jl = "";
    for (const { rec, cur } of list) {
      const r = await readText(ctx.vaultRoot, rec.text, rec.textSha256, { cache: segCache, stage, entryId: rec.id });
      const text = r.ok ? r.text : null;
      if (!r.ok) res.unreadable++;
      const edits = st.edits.get(rec.id) ?? [];
      const latest = edits[edits.length - 1];
      const edited = latest ? { text: latest.text, version: latest.version, at: latest.at } : null;
      const seal = blockOf.get(rec.id);
      md += markdownBlock(cur, text, edited, strings);
      jl += `${JSON.stringify({
        id: rec.id,
        kind: rec.kind,
        source: rec.source,
        ...(baseName(rec.sourceRef.path) ? { sourceName: baseName(rec.sourceRef.path) } : {}),
        ...(rec.conv ? { conv: rec.conv, idx: rec.idx } : {}),
        speaker: cur.speaker,
        ...(cur.speakerDetail ? { speakerDetail: cur.speakerDetail } : {}),
        ...(cur.title ? { title: cur.title } : {}),
        area: cur.space,
        folder: cur.folder,
        ...(cur.project ? { project: cur.project } : {}),
        ...(cur.writtenAt ? { writtenAt: cur.writtenAt } : {}),
        addedAt: cur.addedAt,
        dates: cur.dates.map((d) => ({ type: d.type, strength: d.strength, at: d.at })),
        sha256: rec.textSha256,
        ...(text !== null ? { text } : { unreadable: true }),
        ...(edited ? { edited } : {}),
        ...(seal ? { seal: { computer: seal.host, n: seal.n } } : {}),
      })}\n`;
      res.entries++;
    }
    entryFiles.push({ name: `entries/${key}.md`, data: md }, { name: `entries/${key}.jsonl`, data: jl });
  }
  const sealFiles: PackFile[] = [];
  sealFiles.push({ name: "seals/seals.json", data: jsonText({ format: "cortex-seal-chain", version: 1, computers: chain.computers }) });

  // 4. the leaves of every block that holds an exported entry
  const needed = new Map<string, Set<number>>();
  for (const { host, n } of blockOf.values()) {
    const s = needed.get(host) ?? new Set<number>();
    s.add(n);
    needed.set(host, s);
  }
  const inclusion: { computer: string; n: number; salt?: string; ids: string[]; leaves: string[] }[] = [];
  for (const [host, ns] of needed) {
    for (const b of chain.full.get(host) ?? []) {
      if (!ns.has(b.n)) continue;
      const salt = b.v === 2 ? await readSalt(ctx.cacheDir, host, b.n, ctx.vaultRoot) : null;
      if ((b.v === 2 && !salt) || b.ids.some((id) => !shaOf.has(id))) {
        res.inclusionSkipped++;
        continue;
      }
      inclusion.push({ computer: host, n: b.n, ...(salt ? { salt } : {}), ids: b.ids, leaves: b.ids.map((id) => (b.v === 2 ? sealLeafV2(salt as string, id, shaOf.get(id) as string) : sealLeaf(id, shaOf.get(id) as string))) });
    }
  }
  sealFiles.push({ name: "seals/inclusion.json", data: jsonText({ format: "cortex-seal-inclusion", version: 1, blocks: inclusion }) });
  for (const a of chain.anchors) sealFiles.push({ name: `seals/${a.name}`, data: a.data });

  const readme: PackFile = { name: "README.txt", data: fillText(strings.readmeExport, { entries: res.entries }) };
  const content = [readme, ...entryFiles, ...sealFiles];
  for (const f of content) files.push({ name: f.name, bytes: typeof f.data === "string" ? Buffer.byteLength(f.data, "utf8") : f.data.length, sha256: sha256File(f.data) });
  const manifest = {
    format: "cortex-record-export",
    version: 1,
    createdAt: new Date(now()).toISOString(),
    ...(opts.cortexVersion ? { cortex: opts.cortexVersion } : {}),
    selection: { areas: [...areas], from: opts.from ?? null, to: opts.to ?? null, includeClosed: opts.includeClosed === true },
    counts: { entries: res.entries, skippedClosed: res.skippedClosed, excluded: res.excluded, unreadable: res.unreadable, unsealed: res.unsealed, inclusionSkipped: res.inclusionSkipped },
    files: files.map((f) => ({ path: f.name, bytes: f.bytes, sha256: f.sha256 })),
  };
  const manifestJson = jsonText(manifest);
  const pack: PackFile[] = [readme, { name: "verify.html", data: buildVerifierHtml(strings, { name: "manifest.json", json: manifestJson }) }, { name: "manifest.json", data: manifestJson }, ...entryFiles, ...sealFiles];
  const written = await writePack(out, pack, new Date(now()));
  res.files = written.files;
  res.bytes = written.bytes;
  return res;
}
