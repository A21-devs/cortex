/**
 * Your own vault notes outside wiki/ (daily notes and other notes you write in Obsidian) → record. Owner: E3.
 * The runner reads them from disk (respecting Obsidian's excluded files and sources.vault.excludeFolders) and
 * COPIES their text into segments (M6): a note you keep editing becomes a new entry version linked by
 * `supersedes`, at most once per file per hour of quiet, so old citations stay valid and nothing points into a
 * file that changes under it. Speaker you; date = `created` frontmatter or the file name date (medium), else
 * the first-seen bound. wiki/** notes are interpretations and belong to the plugin's vault index instead.
 *
 *  - `status: reference` notes are kept but hidden by default (hiddenByDefault "reference") and never sent;
 *  - ids: entryId("obsidian", `note:${path}`); a new version: `note:${path}@${sha12}` with `supersedes`;
 *  - detected secrets are replaced in the copy and the originals held on this computer (DocumentBatch);
 *  - dot-folders, `.raw/`, `wiki/`, the settings' excluded folders and Obsidian's "Excluded files" are never read.
 */
import { isCortexError } from "../shared/errors";
import { entryId } from "../shared/ids";
import type { SourceImportStats, SourceSelector } from "../shared/protocol/runner";
import type { DateEvidence, EntryId, SpaceId } from "../shared/types";
import { readJsonIfExists } from "../node/fsAtomic";
import { resolveInVault } from "../node/paths";
import { loadSourceManifest, updateSourceManifest } from "../store/manifest";
import {
  checkpoint,
  createDocumentBatch,
  documentsAhead,
  decideDocument,
  docStateOrRebuild,
  documentDates,
  emptyStats,
  firstHeading,
  frontmatterDate,
  importPrivacy,
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

export type VaultNotesSelector = Extract<SourceSelector, { kind: "vault-notes" }>;

/** Minimum quiet time before a changed note becomes a new version. */
export const VERSION_QUIET_MS = 60 * 60_000;
/** Notes larger than this are not read (they are not notes). */
export const MAX_NOTE_BYTES = 4 * 1024 * 1024;
const FLUSH_EVERY = 150;

/** Notes that are record entries: markdown outside wiki/, outside dot-folders and Cortex's own roots. */
export function isUserNotePath(vaultPath: string, excludeFolders: readonly string[]): boolean {
  if (!vaultPath.toLowerCase().endsWith(".md")) return false;
  if (vaultPath.startsWith("wiki/") || vaultPath.startsWith(".") || vaultPath.includes("/.")) return false;
  return !excludeFolders.some((f) => vaultPath.startsWith(f));
}

/**
 * Obsidian's "Excluded files" (`userIgnoreFilters` in .obsidian/app.json): `/regex/flags` or a text the path
 * contains. Unusable entries are ignored.
 */
export function ignoreFilterMatcher(filters: readonly unknown[]): (vaultPath: string) => boolean {
  const tests: ((p: string) => boolean)[] = [];
  for (const f of filters) {
    if (typeof f !== "string" || f.length === 0) continue;
    const re = /^\/(.+)\/([a-z]*)$/.exec(f);
    if (re) {
      try {
        const rx = new RegExp(re[1] as string, (re[2] ?? "").replace(/[^dgimsuvy]/g, ""));
        tests.push((p) => rx.test(p));
      } catch {
        // an invalid pattern excludes nothing
      }
    } else tests.push((p) => p.includes(f));
  }
  return (p) => tests.some((t) => t(p));
}

async function obsidianIgnore(vaultRoot: string): Promise<(p: string) => boolean> {
  try {
    const app = await readJsonIfExists<{ userIgnoreFilters?: unknown }>(resolveInVault(vaultRoot, ".obsidian/app.json"));
    return ignoreFilterMatcher(Array.isArray(app?.userIgnoreFilters) ? app.userIgnoreFilters : []);
  } catch {
    return () => false;
  }
}

/** Date a note claims for itself: `created`/`date` frontmatter, else a date in the file name (daily notes). */
export function noteDateClaim(fm: Record<string, string>, vaultPath: string): { at: string; type: DateEvidence["type"]; detail: string } | undefined {
  for (const key of ["created", "date"]) {
    const at = frontmatterDate(fm[key]);
    if (at !== undefined) return { at, type: "user-declared", detail: key };
  }
  const m = /(?:^|[^\d])(\d{4})-(\d{2})-(\d{2})(?!\d)/.exec(stemOf(vaultPath));
  if (m) {
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    const at = frontmatterDate(day);
    if (at !== undefined) return { at, type: "filename-date", detail: "file name" };
  }
  return undefined;
}

function walkSkip(settingsFolders: readonly string[], ignored: (p: string) => boolean): (rel: string, isDir: boolean) => boolean {
  return (rel, isDir) => {
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    if (name.startsWith(".") || name === "node_modules") return true;
    if (isDir) return rel === "wiki" || settingsFolders.some((f) => `${rel}/`.startsWith(f)) || ignored(`${rel}/`);
    return !isUserNotePath(rel, settingsFolders) || ignored(rel);
  };
}

interface Pending {
  rel: string;
  next: DocState;
}

export class VaultNotesImporter implements Importer<VaultNotesSelector> {
  readonly kind = "vault-notes" as const;
  readonly source = "obsidian" as const;
  readonly label = "Your vault notes";

  async discover(sel: VaultNotesSelector, ctx: ImportContext): Promise<DiscoveredUnit[]> {
    void sel;
    const skip = walkSkip(ctx.settings.sources.vault.excludeFolders, await obsidianIgnore(ctx.store.vaultRoot));
    const out: DiscoveredUnit[] = [];
    try {
      for await (const f of walkFiles(ctx.store.vaultRoot, "", skip)) {
        if (f.size > 0 && f.size <= MAX_NOTE_BYTES) out.push({ key: f.rel, path: f.rel, bytes: f.size, mtimeMs: f.mtimeMs });
      }
    } catch {
      return out;
    }
    return out;
  }

  async run(sel: VaultNotesSelector, ctx: ImportContext): Promise<SourceImportStats> {
    void sel;
    const stats = emptyStats("obsidian", this.label);
    const vault = ctx.settings.sources.vault;
    if (!vault.enabled) return stats;
    const privacy = await importPrivacy(ctx);
    const skip = walkSkip(vault.excludeFolders, await obsidianIgnore(ctx.store.vaultRoot));
    const state = await docStateOrRebuild(ctx, "vault", "obsidian", (d) => (d.nativeId?.startsWith("note:") ? d.path : undefined));
    const batch = createDocumentBatch(ctx, "obsidian", "notes");
    let pending: Pending[] = [];
    let n = 0;
    let touched = 0;
    const flush = async (final = false): Promise<void> => {
      const records = await batch.flush({ space: "vault", folder: [] });
      const written = new Set<EntryId>(records.map((r) => r.id));
      const known = (await ledgerEntryIndex(ctx)).ids;
      for (const p of pending) {
        if (written.has(p.next.docId) || known.has(p.next.docId)) {
          state.files[p.rel] = p.next;
          touched++;
        }
      }
      stats.entriesAdded += records.length;
      pending = [];
      if (touched > 0 && (final ? (await saveDocState(ctx, "vault", state), true) : await saveDocStateSoon(ctx, "vault", state))) touched = 0;
    };
    try {
      const wanted = (f: WalkedFile): boolean => !(f.size === 0 || f.size > MAX_NOTE_BYTES || privacy.isExcluded({ source: "obsidian", sourceId: "vault", path: f.rel }) || privacy.isOffLimits(f.abs));
      const decide = (f: WalkedFile): Promise<DocDecision> => decideDocument(ctx, f, state.files[f.rel], { allowChange: true, quietMs: VERSION_QUIET_MS });
      for await (const ahead of documentsAhead(walkFiles(ctx.store.vaultRoot, "", skip), wanted, decide)) {
        const f = ahead.item;
        stats.filesSeen++;
        if (++n % 25 === 0 && (await checkpoint(ctx)) !== null) break;
        if (n % 200 === 0) ctx.progress({ phase: "vault-notes", done: n, unit: "notes", note: String(stats.entriesAdded) });
        if (!ahead.wanted) {
          stats.skipped++;
          continue;
        }
        try {
          if (ahead.error !== undefined) throw ahead.error;
          const prev = state.files[f.rel];
          const d = ahead.result as DocDecision;
          if (d.act === "skip") continue;
          if (d.act === "touch" || d.act === "changed") {
            state.files[f.rel] = d.state;
            touched++;
            continue;
          }
          stats.filesRead++;
          stats.bytesRead += d.bytes.length;
          const next = this.addNote(ctx, batch, f.rel, d.bytes.toString("utf8").replace(/^﻿/, ""), d.sha, d.prev, f);
          pending.push({ rel: f.rel, next });
          if (batch.size >= FLUSH_EVERY) await flush();
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
      warn(ctx, "path-unreadable");
      stats.errors.push({ file: "vault", message: "path-unreadable" });
    } finally {
      await flush(true);
    }
    if (!ctx.dryRun) {
      const prev = (await loadSourceManifest(ctx.store)).sources.vault;
      await updateSourceManifest(ctx.store, "vault", {
        kind: "obsidian",
        path: ".",
        bytes: Object.values(state.files).reduce((s, x) => s + x.size, 0),
        importedAt: new Date(ctx.now()).toISOString(),
        entries: (prev?.entries ?? 0) + stats.entriesAdded,
        conversations: 0,
        status: stats.errors.length > 0 && stats.filesRead === 0 ? "error" : "imported",
      });
    }
    return stats;
  }

  /** Queue the entry of one note version; returns the state to record once it is written. */
  private addNote(ctx: ImportContext, batch: DocumentBatch, rel: string, text: string, sha: string, prev: DocState | undefined, f: { size: number; mtimeMs: number }): DocState {
    const { fm, body } = splitFrontmatter(text);
    const addedAt = new Date(ctx.now()).toISOString();
    const key = `note:${rel}${prev ? `@${sha.slice(0, 12)}` : ""}`;
    const id = entryId("obsidian", key);
    const claim = noteDateClaim(fm, rel);
    const dirs = rel.split("/").slice(0, -1);
    batch.add({
      id,
      kind: "document",
      nativeId: key,
      speaker: "you",
      text,
      title: (fm.title || firstHeading(body) || stemOf(rel)).slice(0, 200),
      sourceRef: { path: rel, nativeId: key, sha256: sha },
      dates: documentDates(claim, addedAt),
      ...(claim ? { writtenAt: claim.at } : {}),
      ...(fm.status?.toLowerCase() === "reference" ? { hiddenByDefault: "reference" as const } : {}),
      ...(prev ? { supersedes: prev.docId } : {}),
      space: "vault" satisfies SpaceId,
      folder: dirs.length > 0 ? dirs.slice(0, 6) : ["Vault"],
    });
    return { path: rel, size: f.size, mtimeMs: f.mtimeMs, sha256: sha, docId: id, versions: (prev?.versions ?? 0) + 1, importedAt: addedAt };
  }
}
