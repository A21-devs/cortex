/**
 * Cortex's own sources manifest (`.vault-meta/cortex/sources.json`). Owner: E2.
 * Cortex does not edit the vault's tracked `.raw/.manifest.json` (other skills own it). Export imports keep a
 * resume cursor here so Pause means "cancel now, resume later" (M11).
 *
 * A damaged manifest is never overwritten blindly: the update moves it aside to `sources.damaged-<time>.json`
 * (nothing is deleted; Export diagnostics can include it), logs a warning, and starts a fresh manifest. Losing
 * the manifest costs only re-checks: imports are idempotent and export files are keyed by sha256.
 */
import { promises as fsp } from "node:fs";
import { readJsonIfExists, withFsRetry, writeJsonAtomic } from "../node/fsAtomic";
import { locksDirOf, withLock } from "../node/locks";
import { resolveInVault, writablePath } from "../node/paths";
import { CortexError } from "../shared/errors";
import type { SourceKind, SourceManifest } from "../shared/types";
import { SOURCE_KINDS } from "../shared/types";
import { CORTEX_PATHS, sourcesManifestPath, type StoreContext } from "./layout";

export type ManifestSource = SourceManifest["sources"][string];

const STATUSES: readonly ManifestSource["status"][] = ["imported", "watching", "paused", "error", "excluded", "changed"];

function emptyManifest(): SourceManifest {
  return { v: 1, sources: {} };
}

function validSource(v: unknown): ManifestSource | null {
  if (v === null || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  if (!SOURCE_KINDS.includes(s.kind as SourceKind) || typeof s.path !== "string") return null;
  if (typeof s.bytes !== "number" || !Number.isFinite(s.bytes) || s.bytes < 0) return null;
  if (typeof s.importedAt !== "string" || !STATUSES.includes(s.status as ManifestSource["status"])) return null;
  const entries = typeof s.entries === "number" && Number.isFinite(s.entries) ? s.entries : 0;
  const conversations = typeof s.conversations === "number" && Number.isFinite(s.conversations) ? s.conversations : 0;
  const out: ManifestSource = { kind: s.kind as SourceKind, path: s.path, bytes: s.bytes, importedAt: s.importedAt, entries, conversations, status: s.status as ManifestSource["status"] };
  if (typeof s.sha256 === "string") out.sha256 = s.sha256;
  if (typeof s.error === "string") out.error = s.error;
  const r = s.resume as Record<string, unknown> | undefined;
  if (r && typeof r === "object" && typeof r.cursor === "string" && typeof r.at === "string") out.resume = { cursor: r.cursor, at: r.at };
  return out;
}

/** Keep the valid rows of a parsed manifest; null when the file is not a v1 manifest at all. */
function sanitize(raw: unknown): SourceManifest | null {
  if (raw === null || typeof raw !== "object") return null;
  const m = raw as { v?: unknown; sources?: unknown };
  if (m.v !== 1 || m.sources === null || typeof m.sources !== "object" || Array.isArray(m.sources)) return null;
  const out = emptyManifest();
  for (const [k, v] of Object.entries(m.sources as Record<string, unknown>)) {
    const s = validSource(v);
    if (s) out.sources[k] = s;
  }
  return out;
}

/** The manifest as stored; an absent or unreadable file reads as empty (readers never fail on it). */
export async function loadSourceManifest(ctx: Pick<StoreContext, "vaultRoot">): Promise<SourceManifest> {
  try {
    return sanitize(await readJsonIfExists<unknown>(resolveInVault(ctx.vaultRoot, sourcesManifestPath()))) ?? emptyManifest();
  } catch {
    return emptyManifest();
  }
}

async function readForUpdate(ctx: StoreContext): Promise<SourceManifest> {
  const abs = resolveInVault(ctx.vaultRoot, sourcesManifestPath());
  let parsed: unknown;
  try {
    parsed = await readJsonIfExists<unknown>(abs);
  } catch {
    parsed = undefined; // unparseable
  }
  if (parsed === null) return emptyManifest();
  const m = parsed === undefined ? null : sanitize(parsed);
  if (m) return m;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const aside = writablePath(ctx.vaultRoot, `${CORTEX_PATHS.meta}/sources.damaged-${stamp}.json`);
  await withFsRetry(() => fsp.rename(abs, aside)).catch(() => undefined);
  ctx.log.warn("sources manifest was damaged; kept it aside and started a new one");
  return emptyManifest();
}

/** Upsert one source row under the manifest lock; unspecified fields keep their stored (or default) values. */
export async function updateSourceManifest(
  ctx: StoreContext,
  key: string,
  patch: Partial<ManifestSource> & Pick<ManifestSource, "kind" | "path">,
): Promise<SourceManifest> {
  if (typeof key !== "string" || key.length === 0) throw new CortexError("E_BAD_REQUEST", "manifest key must be a non-empty string");
  return withLock(locksDirOf(ctx.cacheDir), "state:sources", { owner: ctx.owner, staleMs: ctx.lockStaleMs }, async () => {
    const cur = await readForUpdate(ctx);
    const prev = cur.sources[key];
    const next: ManifestSource = {
      bytes: 0,
      importedAt: new Date().toISOString(),
      entries: 0,
      conversations: 0,
      status: "imported",
      ...prev,
      ...patch,
    };
    // `resume: undefined` in a patch clears a finished export's resume point.
    if ("resume" in patch && patch.resume === undefined) delete next.resume;
    if ("error" in patch && patch.error === undefined) delete next.error;
    const valid = validSource(next);
    if (!valid) throw new CortexError("E_BAD_REQUEST", "invalid manifest row");
    cur.sources[key] = valid;
    await writeJsonAtomic(writablePath(ctx.vaultRoot, sourcesManifestPath()), cur);
    return cur;
  });
}
