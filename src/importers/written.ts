/**
 * Entries written inside Cortex (Write page) → record. Owner: E3.
 * The plugin saves `.raw/written/<yyyy>/<mm>/<stamp>-<slug>.md` (frontmatter: cortex_id, made_by: you, created,
 * title, space); this importer turns each file into one "document" entry (speaker you, source "written", date =
 * the save time recorded in the file, strong evidence). The text stays in the file as a byte range (the body,
 * verified by sha256 on every read). Edits after saving become new versions through corrections, never file
 * rewrites: a file that changes on disk is only flagged ("Changed on disk") and nothing new is imported.
 * Entry id = the file's `cortex_id` when it is a well-formed entry id, else entryId("written", `written:${path}`)
 * (the same value NewEntryService writes).
 * Files under `.raw/written/outcomes/` (shared/outcomes.ts) are the same shape with source "outcome": how an accepted
 * direction turned out.
 */
import { isCortexError } from "../shared/errors";
import { entryId, ID_PATTERN } from "../shared/ids";
import type { SourceImportStats, SourceSelector } from "../shared/protocol/runner";
import { isOutcomePath } from "../shared/outcomes";
import { SPACES } from "../shared/spaces";
import type { DateEvidence, EntryId, EntryRecord, SpaceId } from "../shared/types";
import { errCode } from "../node/fsAtomic";
import { sha256Bytes } from "../node/hash";
import { resolveInVault } from "../node/paths";
import { loadSourceManifest, updateSourceManifest } from "../store/manifest";
import {
  appendInPlaceEntries,
  checkpoint,
  decideDocument,
  decodeExactUtf8,
  docStateOrRebuild,
  emptyStats,
  firstHeading,
  frontmatterDate,
  importPrivacy,
  isNotLocalError,
  makeEntryRecord,
  noteNotLocal,
  saveDocState,
  splitFrontmatter,
  stemOf,
  walkFiles,
  warn,
  type DiscoveredUnit,
  type ImportContext,
  type Importer,
} from "./common";

export type WrittenSelector = Extract<SourceSelector, { kind: "written" }>;

const WRITTEN_ROOT = ".raw/written";
const MAX_WRITTEN_BYTES = 4 * 1024 * 1024;

function writtenSkip(rel: string, isDir: boolean): boolean {
  return !isDir && !rel.toLowerCase().endsWith(".md");
}

/** The id a written file gets: its `cortex_id` when well formed, else the one derived from its path. */
export function writtenIdOf(rel: string, cortexId: string | undefined): EntryId {
  return cortexId !== undefined && cortexId.startsWith("e_") && ID_PATTERN.test(cortexId) ? (cortexId as EntryId) : entryId("written", `written:${rel}`);
}

export class WrittenImporter implements Importer<WrittenSelector> {
  readonly kind = "written" as const;
  readonly source = "written" as const;
  readonly label = "Written in Cortex";

  async discover(sel: WrittenSelector, ctx: ImportContext): Promise<DiscoveredUnit[]> {
    void sel;
    const out: DiscoveredUnit[] = [];
    try {
      for await (const f of walkFiles(resolveInVault(ctx.store.vaultRoot, WRITTEN_ROOT), WRITTEN_ROOT, writtenSkip)) {
        if (f.size > 0 && f.size <= MAX_WRITTEN_BYTES) out.push({ key: f.rel, path: f.rel, bytes: f.size, mtimeMs: f.mtimeMs });
      }
    } catch {
      return out;
    }
    return out;
  }

  async run(sel: WrittenSelector, ctx: ImportContext): Promise<SourceImportStats> {
    void sel;
    const stats = emptyStats("written", this.label);
    if (!ctx.settings.sources.written.enabled) return stats;
    const privacy = await importPrivacy(ctx);
    const state = await docStateOrRebuild(ctx, "written", "written", (d) => (d.nativeId?.startsWith("written:") ? d.path : undefined));
    const records: EntryRecord[] = [];
    let dirty = 0;
    let n = 0;
    try {
      for await (const f of walkFiles(resolveInVault(ctx.store.vaultRoot, WRITTEN_ROOT), WRITTEN_ROOT, writtenSkip)) {
        stats.filesSeen++;
        if (++n % 25 === 0 && (await checkpoint(ctx)) !== null) break;
        if (f.size === 0 || f.size > MAX_WRITTEN_BYTES || privacy.isOffLimits(f.abs) || privacy.isExcluded({ source: "written", sourceId: "written", path: f.rel })) {
          stats.skipped++;
          continue;
        }
        try {
          const d = await decideDocument(ctx, f, state.files[f.rel], { allowChange: false });
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
          const rec = this.entryOf(ctx, f.rel, text, d.bytes, d.sha, f.mtimeMs);
          records.push(rec);
          state.files[f.rel] = { path: f.rel, size: f.size, mtimeMs: f.mtimeMs, sha256: d.sha, docId: rec.id, versions: 1, importedAt: new Date(ctx.now()).toISOString() };
          dirty++;
        } catch (e) {
          if (isCortexError(e) && e.code === "E_CANCELLED") throw e;
          if (isNotLocalError(e)) noteNotLocal(ctx, f.rel);
          else warn(ctx, "import-failed");
          stats.errors.push({ file: f.rel, message: isNotLocalError(e) ? "not-local" : "E_IO" });
        }
      }
    } catch (e) {
      if (isCortexError(e) && e.code === "E_CANCELLED") throw e;
      // No .raw/written folder yet: nothing has been written in Cortex.
      if (errCode(e) !== "ENOENT") {
        warn(ctx, "path-unreadable");
        stats.errors.push({ file: WRITTEN_ROOT, message: "path-unreadable" });
      }
    } finally {
      stats.entriesAdded += await appendInPlaceEntries(ctx, records);
      if (dirty > 0) await saveDocState(ctx, "written", state);
    }
    if (!ctx.dryRun && stats.filesSeen > 0) {
      const prev = (await loadSourceManifest(ctx.store)).sources.written;
      const files = Object.values(state.files);
      await updateSourceManifest(ctx.store, "written", {
        kind: "written",
        path: WRITTEN_ROOT,
        bytes: files.reduce((s, x) => s + x.size, 0),
        importedAt: new Date(ctx.now()).toISOString(),
        entries: (prev?.entries ?? 0) + stats.entriesAdded,
        conversations: 0,
        status: files.some((x) => x.changed) ? "changed" : "imported",
      });
    }
    return stats;
  }

  private entryOf(ctx: ImportContext, rel: string, text: string, bytes: Buffer, sha: string, mtimeMs: number): EntryRecord {
    const { fm, body, bodyStart } = splitFrontmatter(text);
    const addedAt = new Date(ctx.now()).toISOString();
    const created = frontmatterDate(fm.created);
    const dates: DateEvidence[] =
      created !== undefined
        ? [{ type: "source-timestamp", strength: "strong", at: created }, { type: "ingest", strength: "bound", at: addedAt }]
        : [{ type: "file-mtime", strength: "weak", at: new Date(mtimeMs).toISOString() }, { type: "ingest", strength: "bound", at: addedAt }];
    const byteStart = Buffer.byteLength(text.slice(0, bodyStart), "utf8");
    const byteEnd = bytes.length;
    const space: SpaceId = SPACES.some((s) => s.id === fm.space) ? (fm.space as SpaceId) : "none";
    const rec = makeEntryRecord({
      id: writtenIdOf(rel, fm.cortex_id),
      kind: "document",
      source: isOutcomePath(rel) ? "outcome" : "written",
      sourceRef: { path: rel, nativeId: `written:${rel}`, sha256: sha },
      text: body,
      textSha256: sha256Bytes(bytes.subarray(byteStart, byteEnd)),
      textRef: { store: "file", path: rel, byteStart, byteEnd },
      speaker: "you",
      title: (fm.title || firstHeading(body) || stemOf(rel)).slice(0, 200),
      dates,
      addedAt,
      space,
      folder: [isOutcomePath(rel) ? "Outcomes" : "Written here"],
    });
    if (created !== undefined) rec.writtenAt = created;
    return rec;
  }
}
