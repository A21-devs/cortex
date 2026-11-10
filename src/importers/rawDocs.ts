/**
 * `.raw/` documents importer (P0). Owner: E3.
 *
 * Reads files under `.raw/` directly from disk (Obsidian does not index dot-folders), skipping Cortex's own
 * folders (.raw/chats, .raw/written, .raw/exports) and `.raw/.manifest.json`.
 *  - .md/.txt → one "document" entry per file plus "passage" entries (splitPassages) with BYTE-range TextRefs
 *    into the original (verified by sha256 on every read: INPLACE-TEXTREF). A document that is one passage long
 *    is its own passage: no second entry is written;
 *  - reference material (H3): files under `sources.raw.referenceFolders` (default .raw/roblox/creator-docs/) get
 *    hiddenByDefault "reference" → ItemFlag.Reference: hidden with the reference filter, undated (they join the
 *    undated cloud when shown), excluded from the your-words share, the strip and Time stats, and never agent
 *    targets while hidden;
 *  - .yaml/.yml skipped by default (`skipYaml`); the API dump is skipped (`skipApiDump`); other .json larger
 *    than `maxJsonBytes` are skipped; other file types are not documents;
 *  - speaker "other" (someone else's words) unless `you.speakerBySource.raw` says "you"; Roblox creator docs
 *    carry licence "CC-BY-4.0" so the reader shows attribution;
 *  - dates: no own date → dates = [ingest bound];
 *  - space by folder (".raw/roblox/…" → roblox; otherwise vault);
 *  - entry id = entryId("files", `raw:${vaultPath}#${passageN}`); a changed file is flagged "changed at source"
 *    (docs state, shown in the reader and as "Changed on disk · import the new version?" on Sources);
 *    confirming (ctx.options.importChanged) creates new ids (`raw:${path}@${sha12}`) with `supersedes`
 *    (originals are never overwritten; old citations stay valid).
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { isCortexError } from "../shared/errors";
import { entryId } from "../shared/ids";
import type { SourceImportStats, SourceSelector } from "../shared/protocol/runner";
import type { EntryId, EntryRecord, SpaceId } from "../shared/types";
import { errCode, readJsonIfExists } from "../node/fsAtomic";
import { sha256Bytes } from "../node/hash";
import { resolveInVault } from "../node/paths";
import { cacheLayout } from "../store/layout";
import { loadSourceManifest, updateSourceManifest } from "../store/manifest";
import {
  appendInPlaceEntries,
  checkpoint,
  decideDocument,
  decodeExactUtf8,
  documentsAhead,
  docStateOrRebuild,
  documentDates,
  emptyStats,
  firstHeading,
  importPrivacy,
  isNotLocalError,
  makeEntryRecord,
  noteNotLocal,
  overDeadline,
  saveDocState,
  saveDocStateSoon,
  splitFrontmatter,
  stemOf,
  walkFiles,
  warn,
  type DiscoveredUnit,
  type DocDecision,
  type DocState,
  type ImportContext,
  type Importer,
  type WalkedFile,
} from "./common";
import { splitBytePassages } from "./passages";

export type RawSelector = Extract<SourceSelector, { kind: "raw" }>;

/** Extra options for a raw pass, passed through `ctx.options`. */
export interface RawSelectorOptions {
  /** Import the new version of changed files: true = all of them, or the listed vault paths. */
  importChanged?: boolean | readonly string[];
}

/** `<cache>/state/import-changed.json`: written by Sources › Import again (`{v:1, all:true}` or `{v:1, paths:[…]}`), consumed by the next complete raw pass. */
export function importChangedPath(cacheDir: string): string {
  return path.join(cacheLayout(cacheDir).state, "import-changed.json");
}

interface ImportChangedFile {
  v: 1;
  all?: boolean;
  paths?: string[];
}

/** Largest document read. */
export const MAX_RAW_BYTES = 20 * 1024 * 1024;
const RAW_ROOT = ".raw";
const DOC_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown", "txt", "json", "yaml", "yml"]);
const SAVE_EVERY = 200;

/** Folders under `.raw/` that belong to Cortex itself or to other tooling and are never read as documents. */
export function rawExcludedPrefixes(): string[] {
  return [".raw/chats/", ".raw/written/", ".raw/exports/", ".raw/.manifest.json"];
}

/** Is this `.raw/` file reference material (hidden by default, undated, never an agent target)? */
export function isReferencePath(vaultPath: string, referenceFolders: readonly string[]): boolean {
  return referenceFolders.some((f) => {
    const p = f.replace(/\\/g, "/");
    return vaultPath.startsWith(p.endsWith("/") ? p : `${p}/`);
  });
}

/** The Roblox API dump (skipApiDump). */
export function isApiDump(vaultPath: string): boolean {
  return /^\.raw\/roblox\/.*api[-_]?dump.*\.json$/i.test(vaultPath);
}

export function rawSpaceOf(vaultPath: string): SpaceId {
  return vaultPath.startsWith(".raw/roblox/") ? "roblox" : "vault";
}

export function rawLicenceOf(vaultPath: string): string | undefined {
  return vaultPath.startsWith(".raw/roblox/creator-docs/") ? "CC-BY-4.0 (Roblox creator documentation)" : undefined;
}

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i > p.lastIndexOf("/") ? p.slice(i + 1).toLowerCase() : "";
}

type RawSettings = ImportContext["settings"]["sources"]["raw"];

/** Why a `.raw/` file is not read as a document (undefined = it is). */
export function rawSkipReason(vaultPath: string, size: number, raw: Pick<RawSettings, "skipYaml" | "skipApiDump" | "maxJsonBytes">): string | undefined {
  const ext = extOf(vaultPath);
  if (!DOC_EXTENSIONS.has(ext)) return "type";
  if ((ext === "yaml" || ext === "yml") && raw.skipYaml) return "yaml";
  if (ext === "json" && raw.skipApiDump && isApiDump(vaultPath)) return "api-dump";
  if (ext === "json" && size > raw.maxJsonBytes) return "json-size";
  if (size > MAX_RAW_BYTES) return "size";
  if (size === 0) return "empty";
  return undefined;
}

function skipTree(rel: string, isDir: boolean): boolean {
  if (isDir) return rawExcludedPrefixes().some((p) => `${rel}/`.startsWith(p)) || path.posix.basename(rel) === ".git";
  return rawExcludedPrefixes().includes(rel);
}

function wantsChange(opt: RawSelectorOptions["importChanged"], vaultPath: string): boolean {
  return opt === true || (Array.isArray(opt) && opt.includes(vaultPath));
}

export class RawDocsImporter implements Importer<RawSelector> {
  readonly kind = "raw" as const;
  readonly source = "files" as const;
  readonly label = "Source documents";

  /** Candidate documents (readdir + stat only). Privacy rules are applied by run(), not here. */
  async discover(sel: RawSelector, ctx: ImportContext): Promise<DiscoveredUnit[]> {
    void sel;
    const raw = ctx.settings.sources.raw;
    const out: DiscoveredUnit[] = [];
    try {
      for await (const f of walkFiles(resolveInVault(ctx.store.vaultRoot, RAW_ROOT), RAW_ROOT, skipTree)) {
        if (rawSkipReason(f.rel, f.size, raw) !== undefined) continue;
        const u: DiscoveredUnit = { key: f.rel, path: f.rel, bytes: f.size, mtimeMs: f.mtimeMs };
        if (isReferencePath(f.rel, raw.referenceFolders)) u.label = "reference";
        out.push(u);
      }
    } catch {
      return out;
    }
    return out;
  }

  async run(sel: RawSelector, ctx: ImportContext): Promise<SourceImportStats> {
    void sel;
    const stats = emptyStats("files", this.label);
    const raw = ctx.settings.sources.raw;
    if (!raw.enabled) return stats;
    const root = resolveInVault(ctx.store.vaultRoot, RAW_ROOT);
    const privacy = await importPrivacy(ctx);
    const state = await docStateOrRebuild(ctx, "raw", "files", (d) => (d.nativeId?.startsWith("raw:") ? d.path : undefined));
    const asked = await readJsonIfExists<ImportChangedFile>(importChangedPath(ctx.store.cacheDir)).catch(() => null);
    const opt: RawSelectorOptions["importChanged"] = (ctx.options as RawSelectorOptions | undefined)?.importChanged ?? (asked?.all === true ? true : asked?.paths);
    const speaker = ctx.settings.you.speakerBySource.raw === "you" ? "you" : "other";
    let batch: EntryRecord[] = [];
    let dirty = 0;
    let n = 0;
    const flush = async (final = false): Promise<void> => {
      if (batch.length > 0) stats.entriesAdded += await appendInPlaceEntries(ctx, batch);
      batch = [];
      if (dirty > 0 && (final ? (await saveDocState(ctx, "raw", state), true) : await saveDocStateSoon(ctx, "raw", state))) dirty = 0;
    };
    try {
      const wanted = (f: WalkedFile): boolean => !(rawSkipReason(f.rel, f.size, raw) !== undefined || privacy.isExcluded({ source: "files", sourceId: "raw", path: f.rel }) || privacy.isOffLimits(f.abs));
      const decide = (f: WalkedFile): Promise<DocDecision> => decideDocument(ctx, f, state.files[f.rel], { allowChange: wantsChange(opt, f.rel) });
      for await (const ahead of documentsAhead(walkFiles(root, RAW_ROOT, skipTree), wanted, decide)) {
        const f = ahead.item;
        stats.filesSeen++;
        if (++n % 25 === 0 && (await checkpoint(ctx)) !== null) break;
        if (n % 200 === 0) ctx.progress({ phase: "raw", done: n, unit: "files", note: String(stats.entriesAdded + batch.length) });
        if (!ahead.wanted) {
          stats.skipped++;
          continue;
        }
        try {
          if (ahead.error !== undefined) throw ahead.error;
          const d = ahead.result as DocDecision;
          if (d.act === "skip") continue;
          if (d.act === "touch" || d.act === "changed") {
            state.files[f.rel] = d.state;
            dirty++;
            if (d.act === "changed") warn(ctx, "changed-at-source");
            continue;
          }
          stats.filesRead++;
          stats.bytesRead += d.bytes.length;
          const text = decodeExactUtf8(d.bytes);
          if (text === null) {
            stats.skipped++;
            continue;
          }
          const made = this.entriesOf(ctx, f.rel, text, d.sha, d.prev, speaker);
          for (const r of made.records) batch.push(r); // (not push(...): a huge document can yield very many passages)
          state.files[f.rel] = { path: f.rel, size: f.size, mtimeMs: f.mtimeMs, sha256: d.sha, docId: made.docId, versions: (d.prev?.versions ?? 0) + 1, importedAt: new Date(ctx.now()).toISOString() };
          dirty++;
          if (batch.length >= SAVE_EVERY) await flush();
        } catch (e) {
          if (isCortexError(e) && e.code === "E_CANCELLED") throw e;
          if (isNotLocalError(e)) noteNotLocal(ctx, f.rel);
          else warn(ctx, "import-failed");
          stats.errors.push({ file: f.rel, message: isNotLocalError(e) ? "not-local" : "E_IO" });
        }
        if (overDeadline(ctx)) {
          if (ctx.tally) ctx.tally.partial = true;
          break;
        }
      }
    } catch (e) {
      if (isCortexError(e) && e.code === "E_CANCELLED") throw e;
      // A vault without a .raw folder simply has no documents.
      if (errCode(e) !== "ENOENT") {
        warn(ctx, "path-unreadable");
        stats.errors.push({ file: RAW_ROOT, message: "path-unreadable" });
      }
    } finally {
      await flush(true);
    }
    if (!ctx.dryRun) {
      await this.updateManifest(ctx, state, stats);
      // The request is used up once a complete pass has seen every file.
      if (asked && !ctx.tally?.partial) await fsp.rm(importChangedPath(ctx.store.cacheDir), { force: true }).catch(() => undefined);
    }
    return stats;
  }

  /** The document entry (whole file) and, for long documents, one passage entry per section. */
  private entriesOf(ctx: ImportContext, rel: string, text: string, sha: string, prev: DocState | undefined, speaker: "you" | "other"): { docId: EntryId; records: EntryRecord[] } {
    const raw = ctx.settings.sources.raw;
    const addedAt = new Date(ctx.now()).toISOString();
    const docKey = `raw:${rel}${prev ? `@${sha.slice(0, 12)}` : ""}`;
    const docId = entryId("files", docKey);
    const ext = extOf(rel);
    const reference = isReferencePath(rel, raw.referenceFolders);
    const licence = rawLicenceOf(rel);
    const base = {
      source: "files" as const,
      sourceRef: { path: rel, nativeId: docKey, sha256: sha },
      speaker,
      dates: documentDates(undefined, addedAt),
      addedAt,
      space: rawSpaceOf(rel),
      folder: rel.split("/").slice(0, -1).slice(0, 6),
      ...(reference ? { hiddenByDefault: "reference" as const } : {}),
      ...(licence !== undefined ? { licence } : {}),
      ...(prev ? { supersedes: prev.docId } : {}),
    };
    const markdown = ext === "md" || ext === "markdown";
    const fm = markdown ? splitFrontmatter(text) : undefined;
    const title = ((fm ? fm.fm.title || firstHeading(fm.body) : undefined) || stemOf(rel)).slice(0, 200);
    const records: EntryRecord[] = [
      makeEntryRecord({ ...base, id: docId, kind: "document", text, textSha256: sha, textRef: { store: "file", path: rel, byteStart: 0, byteEnd: Buffer.byteLength(text, "utf8") }, title }),
    ];
    const passages = markdown || ext === "txt" ? splitBytePassages(text, raw.passageWords) : [];
    if (passages.length > 1) {
      const buf = Buffer.from(text, "utf8");
      for (const p of passages) {
        records.push(
          makeEntryRecord({
            ...base,
            id: entryId("files", `${docKey}#${p.n}`),
            kind: "passage",
            text: text.slice(p.start, p.end),
            textSha256: sha256Bytes(buf.subarray(p.byteStart, p.byteEnd)),
            textRef: { store: "file", path: rel, byteStart: p.byteStart, byteEnd: p.byteEnd },
            title: (p.heading ?? title).slice(0, 200),
            passage: { doc: docId, n: p.n, of: passages.length, ...(p.heading !== undefined ? { heading: p.heading } : {}) },
          }),
        );
      }
    }
    return { docId, records };
  }

  private async updateManifest(ctx: ImportContext, state: { files: Record<string, DocState> }, stats: SourceImportStats): Promise<void> {
    const manifest = await loadSourceManifest(ctx.store);
    const prev = manifest.sources.raw;
    const files = Object.values(state.files);
    await updateSourceManifest(ctx.store, "raw", {
      kind: "files",
      path: RAW_ROOT,
      bytes: files.reduce((s, f) => s + f.size, 0),
      importedAt: new Date(ctx.now()).toISOString(),
      entries: (prev?.entries ?? 0) + stats.entriesAdded,
      conversations: 0,
      status: files.some((f) => f.changed) ? "changed" : stats.errors.length > 0 && stats.filesRead === 0 ? "error" : "imported",
    });
  }
}
