/**
 * User-chosen folders importer (P1). Owner: E3. (There is no `.raw/inbox/` drop folder: exports are dropped on
 * the Add sources dialog instead — M16.)
 *
 * Only the extensions chosen for the folder (FolderSourceSetting.extensions; md, txt, code, json, csv, html):
 * md/txt (document + passages), code (document, mono), json/csv (document; json > maxJsonBytes skipped), html
 * (text extracted). Images are not read. Never read (privacy defaults, plus the user's Off limits rows): .env,
 * key files, *.pem, .ssh, node_modules, .git, .obsidian, .claude, Excalidraw/, files > 20 MB.
 * Text is COPIED into segments at import (M6, INPLACE-TEXTREF): working files change constantly, so a changed
 * file becomes a NEW entry version linked by `supersedes` (at most once per ten quiet minutes) and old
 * citations stay valid. Speaker: the folder's setting (`you.speakerBySource["folder:<id>"]`); "ask" uses the
 * answers the Add sources dialog saved per file (`<cache>/state/folder-speakers-<id>.json`); a file with no
 * answer yet is left for later, never guessed.
 */
import * as path from "node:path";
import { isCortexError } from "../shared/errors";
import { entryId } from "../shared/ids";
import type { SourceImportStats, SourceSelector } from "../shared/protocol/runner";
import type { FolderSourceSetting } from "../shared/settings";
import type { DateEvidence, EntryId, Speaker } from "../shared/types";
import { readJsonIfExists } from "../node/fsAtomic";
import { cacheLayout } from "../store/layout";
import { loadSourceManifest, updateSourceManifest } from "../store/manifest";
import {
  checkpoint,
  createDocumentBatch,
  decideDocument,
  documentsAhead,
  docStateOrRebuild,
  documentDates,
  emptyStats,
  firstHeading,
  importPrivacy,
  isNeverRead,
  isNotLocalError,
  ledgerEntryIndex,
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
  type DocumentBatch,
  type ImportContext,
  type Importer,
  type WalkedFile,
} from "./common";
import { htmlToText } from "./html";
import { splitPassages } from "./passages";
import { noteDateClaim } from "./vaultNotes";

export { isNeverRead, NEVER_READ } from "./common";

export type FolderSelector = Extract<SourceSelector, { kind: "folder" }>;

export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "md", "markdown", "txt", "py", "js", "ts", "tsx", "jsx", "lua", "luau", "cs", "java", "c", "cpp", "h", "go", "rs", "sh", "ps1", "css",
  "json", "yaml", "yml", "csv", "html", "htm",
]);
const CODE_EXTENSIONS = ["py", "js", "ts", "tsx", "jsx", "lua", "luau", "cs", "java", "c", "cpp", "h", "go", "rs", "sh", "ps1", "css"];

/** The file types the Add sources dialog offers, as the extensions stored in FolderSourceSetting.extensions. */
export const FOLDER_FILE_TYPES = ["md", "txt", "code", "json", "csv", "html"] as const;
export type FolderFileType = (typeof FOLDER_FILE_TYPES)[number];

export function expandFileTypes(types: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of types) {
    const k = t.toLowerCase().replace(/^\./, "");
    if (k === "code") for (const c of CODE_EXTENSIONS) out.add(c);
    else if (k === "md") ["md", "markdown"].forEach((x) => out.add(x));
    else if (k === "html") ["html", "htm"].forEach((x) => out.add(x));
    else if (k.length > 0) out.add(k);
  }
  return [...out];
}

/** Largest file read from a chosen folder. */
export const MAX_FOLDER_FILE_BYTES = 20 * 1024 * 1024;
/** A changed working file becomes a new version only after this much quiet. */
export const FOLDER_QUIET_MS = 10 * 60_000;
const FLUSH_EVERY = 100;

/** `<cache>/state/folder-speakers-<id>.json`: the per-file answers of "Ask per file". */
export function folderSpeakersPath(cacheDir: string, folderId: string): string {
  return path.join(cacheLayout(cacheDir).state, `folder-speakers-${folderId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export interface FolderSpeakersFile {
  v: 1;
  files: Record<string, "you" | "other">;
}

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i > p.lastIndexOf("/") ? p.slice(i + 1).toLowerCase() : "";
}

/** Is this file read for the folder? (extension chosen, not on the never-read list, not too large.) */
export function folderFileWanted(rel: string, size: number, folder: Pick<FolderSourceSetting, "extensions">, maxJsonBytes: number): boolean {
  const ext = extOf(rel);
  if (!TEXT_EXTENSIONS.has(ext) || !folder.extensions.map((e) => e.toLowerCase()).includes(ext)) return false;
  if (size === 0 || size > MAX_FOLDER_FILE_BYTES) return false;
  return !(ext === "json" && size > maxJsonBytes);
}

function speakerChoice(ctx: ImportContext, id: string): "you" | "other" | "ask" {
  const c = ctx.settings.you.speakerBySource[`folder:${id}`];
  return c === "you" || c === "ask" ? c : "other";
}

interface Pending {
  rel: string;
  next: DocState;
}

export class FolderImporter implements Importer<FolderSelector> {
  readonly kind = "folder" as const;
  readonly source = "files" as const;
  readonly label = "Folders";

  private folderOf(sel: FolderSelector, ctx: ImportContext): FolderSourceSetting | undefined {
    return ctx.settings.sources.folders.find((f) => f.id === sel.id);
  }

  /** Candidate files (readdir + stat only; the never-read list applies, the Off limits rows apply in run()). */
  async discover(sel: FolderSelector, ctx: ImportContext): Promise<DiscoveredUnit[]> {
    const folder = this.folderOf(sel, ctx);
    const out: DiscoveredUnit[] = [];
    if (!folder) return out;
    const maxJson = ctx.settings.sources.raw.maxJsonBytes;
    try {
      for await (const f of walkFiles(folder.path, "", (rel) => isNeverRead(path.join(folder.path, rel)))) {
        if (folderFileWanted(f.rel, f.size, folder, maxJson)) out.push({ key: f.rel, path: f.abs, bytes: f.size, mtimeMs: f.mtimeMs, label: f.rel });
      }
    } catch {
      return out;
    }
    return out;
  }

  async run(sel: FolderSelector, ctx: ImportContext): Promise<SourceImportStats> {
    const stats = emptyStats("files", this.label);
    const folder = this.folderOf(sel, ctx);
    if (!folder || !folder.enabled) return stats;
    const sourceId = `folder:${folder.id}`;
    const privacy = await importPrivacy(ctx);
    if (privacy.isExcluded({ source: "files", sourceId, path: folder.path }) || privacy.isOffLimits(folder.path)) {
      stats.skipped++;
      return stats;
    }
    const maxJson = ctx.settings.sources.raw.maxJsonBytes;
    const choice = speakerChoice(ctx, folder.id);
    const answers = choice === "ask" ? ((await readJsonIfExists<FolderSpeakersFile>(folderSpeakersPath(ctx.store.cacheDir, folder.id)).catch(() => null))?.files ?? {}) : {};
    const stateName = `folder-${folder.id}`;
    const state = await docStateOrRebuild(ctx, stateName, "files", (d) => {
      const prefix = `folder:${folder.id}:`;
      return d.nativeId?.startsWith(prefix) ? d.nativeId.slice(prefix.length).replace(/@[0-9a-f]{12}$/, "") : undefined;
    });
    const batch = createDocumentBatch(ctx, "files", sourceId);
    let pending: Pending[] = [];
    let dirty = 0;
    let n = 0;
    const flush = async (final = false): Promise<void> => {
      const records = await batch.flush({ space: folder.space, folder: [folder.label] });
      const written = new Set<EntryId>(records.map((r) => r.id));
      const known = (await ledgerEntryIndex(ctx)).ids;
      for (const p of pending) {
        if (written.has(p.next.docId) || known.has(p.next.docId)) {
          state.files[p.rel] = p.next;
          dirty++;
        }
      }
      stats.entriesAdded += records.length;
      pending = [];
      if (dirty > 0 && (final ? (await saveDocState(ctx, stateName, state), true) : await saveDocStateSoon(ctx, stateName, state))) dirty = 0;
    };
    try {
      const speakerOf = (f: WalkedFile): Speaker | undefined => (choice === "ask" ? answers[f.rel] : choice);
      const wanted = (f: WalkedFile): boolean => folderFileWanted(f.rel, f.size, folder, maxJson) && !privacy.isExcluded({ source: "files", sourceId, path: f.abs }) && !privacy.isOffLimits(f.abs) && speakerOf(f) !== undefined;
      const decide = (f: WalkedFile): Promise<DocDecision> => decideDocument(ctx, f, state.files[f.rel], { allowChange: true, quietMs: FOLDER_QUIET_MS });
      for await (const ahead of documentsAhead(walkFiles(folder.path, "", (rel) => isNeverRead(path.join(folder.path, rel))), wanted, decide)) {
        const f = ahead.item;
        stats.filesSeen++;
        if (++n % 25 === 0 && (await checkpoint(ctx)) !== null) break;
        if (n % 200 === 0) ctx.progress({ phase: sourceId, done: n, unit: "files", note: String(stats.entriesAdded) });
        const speaker = ahead.wanted ? speakerOf(f) : undefined;
        if (!ahead.wanted || speaker === undefined) {
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
            continue;
          }
          stats.filesRead++;
          stats.bytesRead += d.bytes.length;
          const next = this.addFile(ctx, batch, folder, f, d.bytes.toString("utf8").replace(/^﻿/, ""), d.sha, d.prev, speaker);
          if (next) pending.push({ rel: f.rel, next });
          else stats.skipped++;
          if (batch.size >= FLUSH_EVERY) await flush();
        } catch (e) {
          if (isCortexError(e) && e.code === "E_CANCELLED") throw e;
          if (isNotLocalError(e)) noteNotLocal(ctx, f.abs);
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
      warn(ctx, "path-unreadable");
      stats.errors.push({ file: folder.label, message: "path-unreadable" });
    } finally {
      await flush(true);
    }
    if (!ctx.dryRun) {
      const prev = (await loadSourceManifest(ctx.store)).sources[sourceId];
      await updateSourceManifest(ctx.store, sourceId, {
        kind: "files",
        path: folder.path,
        bytes: Object.values(state.files).reduce((s, x) => s + x.size, 0),
        importedAt: new Date(ctx.now()).toISOString(),
        entries: (prev?.entries ?? 0) + stats.entriesAdded,
        conversations: 0,
        status: stats.errors.length > 0 && stats.filesRead === 0 && stats.filesSeen > 0 ? "error" : folder.watch ? "watching" : "imported",
      });
    }
    return stats;
  }

  /** Queue the document (and passage) entries of one file version; null when the file has no text. */
  private addFile(
    ctx: ImportContext,
    batch: DocumentBatch,
    folder: FolderSourceSetting,
    f: { rel: string; abs: string; size: number; mtimeMs: number },
    rawText: string,
    sha: string,
    prev: DocState | undefined,
    speaker: Speaker,
  ): DocState | null {
    const ext = extOf(f.rel);
    const html = ext === "html" || ext === "htm";
    const text = html ? htmlToText(rawText) : rawText;
    if (text.trim().length === 0) return null;
    const markdown = ext === "md" || ext === "markdown";
    const fm = markdown ? splitFrontmatter(text) : undefined;
    const addedAt = new Date(ctx.now()).toISOString();
    const docKey = `folder:${folder.id}:${f.rel}${prev ? `@${sha.slice(0, 12)}` : ""}`;
    const docId = entryId("files", docKey);
    const claim = fm ? noteDateClaim(fm.fm, f.rel) : undefined;
    const dates: DateEvidence[] = documentDates(claim, addedAt);
    if (!claim) dates.unshift({ type: "file-mtime", strength: "weak", at: new Date(f.mtimeMs).toISOString() });
    const title = ((fm ? fm.fm.title || firstHeading(fm.body) : undefined) || stemOf(f.rel) + (ext && !markdown ? `.${ext}` : "")).slice(0, 200);
    const dirs = f.rel.split("/").slice(0, -1);
    const common = {
      speaker,
      dates,
      ...(claim ? { writtenAt: claim.at } : {}),
      space: folder.space,
      folder: [folder.label, ...dirs].slice(0, 6),
      sourceRef: { path: f.abs, nativeId: docKey, sha256: sha },
    };
    batch.add({ ...common, id: docId, kind: "document", nativeId: docKey, text, title, ...(prev ? { supersedes: prev.docId } : {}) });
    const passages = markdown || ext === "txt" ? splitPassages(text, ctx.settings.sources.raw.passageWords) : [];
    if (passages.length > 1) {
      for (const p of passages) {
        batch.add({
          ...common,
          id: entryId("files", `${docKey}#${p.n}`),
          kind: "passage",
          nativeId: `${docKey}#${p.n}`,
          text: text.slice(p.start, p.end),
          title: (p.heading ?? title).slice(0, 200),
          passage: { doc: docId, n: p.n, of: passages.length, ...(p.heading !== undefined ? { heading: p.heading } : {}) },
        });
      }
    }
    return { path: f.abs, size: f.size, mtimeMs: f.mtimeMs, sha256: sha, docId, versions: (prev?.versions ?? 0) + 1, importedAt: addedAt };
  }
}
