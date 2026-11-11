/**
 * Shared pass for exports of notes and documents (Notion zip, Google Docs / Takeout). Owner: E3.
 *
 * An export is a zip or an unzipped folder (the same reader the chat exports use: nothing is extracted to disk,
 * member names are data and never become paths). A format supplies which members are pages (`pages`) and how to
 * read one (`read`); this module does everything else, the way the folders importer does:
 *  - each page becomes a DOCUMENT entry (plus passages for long ones) copied into the record's own segments;
 *  - a page that was imported before is skipped when its text is unchanged, and becomes a NEW version linked by
 *    `supersedes` when it changed (so a newer export of the same workspace adds only what changed, and old
 *    citations stay valid);
 *  - dates come from the export itself (a date the page names, or the document's own properties) at the strength
 *    the source gives them; the time the export was made is only an upper bound, never the date of the writing;
 *  - the page tree is kept: `project` = the top page or folder, `folder` = the ancestors.
 * Nothing is sent anywhere; `settings.privacy` and the corrections still apply.
 */
import { createWriteStream, promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { isCortexError } from "../shared/errors";
import { entryId } from "../shared/ids";
import type { SourceImportStats } from "../shared/protocol/runner";
import type { CortexSettings } from "../shared/settings";
import type { DateEvidence, EntryId, IsoDate, SourceKind, SpaceId, Speaker } from "../shared/types";
import { sha256Text } from "../node/hash";
import { loadSourceManifest, updateSourceManifest } from "../store/manifest";
import {
  checkpoint,
  createDocumentBatch,
  docStateOrRebuild,
  documentDates,
  emptyStats,
  importPrivacy,
  ledgerEntryIndex,
  overDeadline,
  saveDocState,
  warn,
  type DocState,
  type ImportContext,
} from "./common";
import { splitPassages } from "./passages";
import { checkExportPath, openExportSource, openProblem, type ExportMember, type ExportSource } from "./zip";

/** Largest page read from an export (bigger ones are skipped and counted). */
export const MAX_EXPORT_PAGE_BYTES = 32 * 1024 * 1024;

export interface ParsedPage {
  /** Stable across exports of the same workspace (a Notion page id, a Takeout path). */
  key: string;
  title: string;
  /** The page's text, as it will be stored. */
  text: string;
  /** Where it sits in the export (shown as the original location). */
  path: string;
  project?: string;
  /** Ancestors, outermost first (the source's own name is added by the caller). */
  folder: string[];
  /** A date the page itself names, at day or minute precision. */
  claim?: { at: IsoDate; type: DateEvidence["type"]; detail?: string };
  /** The latest the writing can date from (a last-modified time): an upper bound only. */
  bound?: { at: IsoDate; detail: string };
  /** Split into passages at headings (markdown pages). */
  passages: boolean;
}

export interface DocExportFormat {
  readonly source: SourceKind;
  readonly label: string;
  /** Machine-local state name (`<cache>/state/docs-<name>.json`). */
  readonly stateName: string;
  enabled(s: CortexSettings): boolean;
  /** The members of the export that are pages. */
  pages(members: readonly ExportMember[]): ExportMember[];
  /** Read one page; null when it has no text. */
  read(src: ExportSource, member: ExportMember, ctx: ImportContext): Promise<ParsedPage | null>;
}

const FLUSH_EVERY = 100;

/**
 * Open an export. Notion wraps a big export as a zip of zips ("Export-….zip" holding "…-Part-1.zip"): when every
 * member is itself a zip, each is copied to a private temporary folder and the parts are read as one export
 * (member names get the part's name as a prefix, so nothing collides). The copies are deleted when it closes.
 */
export async function openDocExport(file: string): Promise<ExportSource> {
  const src = await openExportSource(file);
  const zips = src.members.filter((m) => /\.zip$/i.test(m.name));
  if (zips.length === 0 || zips.length !== src.members.length || zips.length > 64) return src;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cortex-parts-"));
  const parts: { prefix: string; src: ExportSource }[] = [];
  const cleanup = async (): Promise<void> => {
    for (const p of parts) await p.src.close().catch(() => undefined);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    let i = 0;
    for (const z of zips) {
      const copy = path.join(dir, `part-${i++}.zip`);
      await pipeline(await src.open(z.name), createWriteStream(copy));
      parts.push({ prefix: `${z.name.replace(/\.zip$/i, "")}/`, src: await openExportSource(copy) });
    }
  } catch (e) {
    await cleanup();
    await src.close().catch(() => undefined);
    throw e;
  }
  await src.close().catch(() => undefined);
  const owner = (name: string): { prefix: string; src: ExportSource } | undefined => parts.find((p) => name.startsWith(p.prefix));
  return {
    path: file,
    form: "zip",
    members: parts.flatMap((p) => p.src.members.map((m) => ({ name: p.prefix + m.name, size: m.size }))),
    fileOf: () => undefined,
    open(name) {
      const p = owner(name);
      if (!p) return Promise.reject(new Error("the export has no such file"));
      return p.src.open(name.slice(p.prefix.length));
    },
    close: cleanup,
  };
}

function speakerOf(ctx: ImportContext, source: SourceKind): Speaker {
  return ctx.settings.you.speakerBySource[source] === "other" ? "other" : "you";
}

/** The bytes of a member, capped (a zip bomb or an enormous file is refused, not read). */
export async function readMemberBytes(src: ExportSource, name: string, cap = MAX_EXPORT_PAGE_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  const stream = await src.open(name);
  try {
    for await (const c of stream) {
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
      n += b.length;
      if (n > cap) throw new RangeError("page too large");
      chunks.push(b);
    }
  } finally {
    (stream as { destroy?: () => void }).destroy?.();
  }
  return Buffer.concat(chunks);
}

export async function runDocExport(ctx: ImportContext, file: string, format: DocExportFormat): Promise<SourceImportStats> {
  const stats = emptyStats(format.source, format.label);
  if (!format.enabled(ctx.settings)) return stats;
  const blocked = checkExportPath(file, ctx.settings);
  if (blocked) {
    warn(ctx, blocked);
    stats.errors.push({ file: format.label, message: blocked });
    return stats;
  }
  const privacy = await importPrivacy(ctx);
  if (privacy.isExcluded({ source: format.source, sourceId: format.source, path: file })) {
    stats.skipped++;
    return stats;
  }
  let src: ExportSource;
  try {
    src = await openDocExport(file);
  } catch (e) {
    if (isCortexError(e) && e.code === "E_CANCELLED") throw e;
    const code = openProblem(e);
    warn(ctx, code);
    stats.errors.push({ file: format.label, message: code });
    return stats;
  }
  const exportStat = await fsp.stat(file).catch(() => null);
  const exportTime: IsoDate | undefined = exportStat ? new Date(exportStat.mtimeMs).toISOString() : undefined;
  const prefix = `${format.source}:`;
  const state = await docStateOrRebuild(ctx, format.stateName, format.source, (d) => (d.nativeId?.startsWith(prefix) ? d.nativeId.slice(prefix.length).replace(/@[0-9a-f]{12}$/, "") : undefined));
  const batch = createDocumentBatch(ctx, format.source, format.source);
  const speaker = speakerOf(ctx, format.source);
  const pages = format.pages(src.members);
  stats.filesSeen = pages.length;
  let pending: { key: string; next: DocState }[] = [];
  const flush = async (): Promise<void> => {
    const records = await batch.flush({ space: "none" as SpaceId, folder: [format.label] });
    const written = new Set<EntryId>(records.map((r) => r.id));
    const known = (await ledgerEntryIndex(ctx)).ids;
    for (const p of pending) if (written.has(p.next.docId) || known.has(p.next.docId)) state.files[p.key] = p.next;
    stats.entriesAdded += records.length;
    pending = [];
  };
  try {
    let n = 0;
    for (const member of pages) {
      if (++n % 25 === 0 && (await checkpoint(ctx)) !== null) break;
      if (member.size > MAX_EXPORT_PAGE_BYTES) {
        stats.skipped++;
        continue;
      }
      try {
        const page = await format.read(src, member, ctx);
        if (page === null || page.text.trim() === "") {
          stats.skipped++;
          continue;
        }
        stats.filesRead++;
        stats.bytesRead += member.size;
        const sha = sha256Text(page.text);
        const prev = state.files[page.key];
        if (prev && prev.sha256 === sha) continue;
        const next = addPage(ctx, batch, format, page, sha, prev, speaker, exportTime);
        pending.push({ key: page.key, next });
        if (batch.size >= FLUSH_EVERY) await flush();
      } catch (e) {
        if (isCortexError(e) && e.code === "E_CANCELLED") throw e;
        warn(ctx, "import-failed");
        stats.errors.push({ file: member.name.slice(member.name.lastIndexOf("/") + 1), message: "E_IO" });
      }
      if (n % 200 === 0) ctx.progress({ phase: format.source, done: n, total: pages.length, unit: "pages", note: String(stats.entriesAdded) });
      if (overDeadline(ctx)) {
        if (ctx.tally) ctx.tally.partial = true;
        break;
      }
    }
  } finally {
    await src.close().catch(() => undefined);
    await flush();
    await saveDocState(ctx, format.stateName, state);
  }
  if (!ctx.dryRun) {
    const prev = (await loadSourceManifest(ctx.store)).sources[format.source];
    await updateSourceManifest(ctx.store, format.source, {
      kind: format.source,
      path: file,
      bytes: exportStat?.size ?? 0,
      importedAt: new Date(ctx.now()).toISOString(),
      entries: (prev?.entries ?? 0) + stats.entriesAdded,
      conversations: 0,
      status: stats.errors.length > 0 && stats.filesRead === 0 && pages.length > 0 ? "error" : "imported",
    });
  }
  return stats;
}

/** Queue the document (and passage) entries of one page version. */
function addPage(ctx: ImportContext, batch: ReturnType<typeof createDocumentBatch>, format: DocExportFormat, page: ParsedPage, sha: string, prev: DocState | undefined, speaker: Speaker, exportTime: IsoDate | undefined): DocState {
  const addedAt = new Date(ctx.now()).toISOString();
  const docKey = `${format.source}:${page.key}${prev ? `@${sha.slice(0, 12)}` : ""}`;
  const docId = entryId(format.source, docKey);
  const dates: DateEvidence[] = documentDates(page.claim, addedAt);
  // The export's own time is the latest the writing can date from: an upper bound, never its date.
  if (page.bound !== undefined) dates.splice(dates.length - 1, 0, { type: "file-mtime", strength: "bound", at: page.bound.at, detail: page.bound.detail });
  if (exportTime !== undefined) dates.splice(dates.length - 1, 0, { type: "file-mtime", strength: "bound", at: exportTime, detail: "time of the export" });
  const folder = [format.label, ...page.folder].slice(0, 6);
  const common = {
    speaker,
    dates,
    ...(page.claim ? { writtenAt: page.claim.at } : {}),
    folder,
    ...(page.project !== undefined ? { project: page.project } : {}),
    sourceRef: { path: page.path, nativeId: docKey, sha256: sha },
  };
  const title = page.title.slice(0, 200);
  batch.add({ ...common, id: docId, kind: "document", nativeId: docKey, text: page.text, title, ...(prev ? { supersedes: prev.docId } : {}) });
  const passages = page.passages ? splitPassages(page.text, ctx.settings.sources.raw.passageWords) : [];
  if (passages.length > 1) {
    for (const p of passages) {
      batch.add({
        ...common,
        id: entryId(format.source, `${docKey}#${p.n}`),
        kind: "passage",
        nativeId: `${docKey}#${p.n}`,
        text: page.text.slice(p.start, p.end),
        title: (p.heading ?? title).slice(0, 200),
        passage: { doc: docId, n: p.n, of: passages.length, ...(p.heading !== undefined ? { heading: p.heading } : {}) },
      });
    }
  }
  return { path: page.path, size: page.text.length, mtimeMs: -1, sha256: sha, docId, versions: (prev?.versions ?? 0) + 1, importedAt: addedAt };
}
