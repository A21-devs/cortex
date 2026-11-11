/**
 * New entry (CORTEX-UX §5.24). Owner: E3.
 *
 * save(): writes `.raw/written/<yyyy>/<mm>/<yyyymmdd-HHmm>-<slug>.md` (store/layout.ts writtenEntryPath) through
 * a minted WritablePath (the `.raw/written/` root has its own `.gitignore` with `*`), created exclusively
 * (`-2`, `-3` on a clash), then asks the runner to import the `written` source so the new point is born at the
 * spine's tip. Undo is an exclude fix; the file stays where it is ("Left out of your record · it stays in
 * .raw/written/"). Drafts are saved per leaf every 2 s in memory and the local cache (never in the vault); the
 * sample record refuses.
 *
 * File format (read back by importers/written.ts): frontmatter cortex_id (the entry id), made_by: you, created
 * (ISO, strong date evidence), title (JSON string) and space, then the body exactly as typed.
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { CortexError } from "../shared/errors";
import { entryId } from "../shared/ids";
import type { Logger } from "../shared/log";
import { defangRunnable } from "../shared/mdSafe";
import { SPACES } from "../shared/spaces";
import { ensureCacheDir, ensureCortexRoots, errCode, readJsonIfExists, writeFileExclusive, writeJsonAtomic } from "../node/fsAtomic";
import { cacheWritablePath, writablePath } from "../node/paths";
import { writtenEntryPath } from "../store/layout";
import { listOutcomes, saveNegativeResult, saveOutcome } from "./outcomes";
import type { RunnerClient } from "./runnerClient";
import type { NewEntryService } from "./services";

export { writtenEntryPath } from "../store/layout";

export const DRAFT_SAVE_MS = 2000;
/** Longest entry accepted (the byte-range reader and the importer both stop well above this). */
export const MAX_ENTRY_CHARS = 1_000_000;
export const MAX_ENTRY_TITLE = 200;

type Draft = { title: string; body: string; space?: string };

export interface NewEntryDeps {
  vaultRoot: string;
  cacheDir: string;
  log: Logger;
  runner: Pick<RunnerClient, "request">;
  /** M13: the sample record is showing; saving refuses. */
  sandbox(): boolean;
  now?: () => Date;
}

/** The text of a written file. */
export function writtenFileText(args: { id: string; created: Date; title: string; space: string; body: string }): string {
  // The words stay as typed; only triggers that would make the vault's plugins run code are defanged (SAFE-01).
  const safe = defangRunnable(args.body);
  const body = safe.endsWith("\n") ? safe : `${safe}\n`;
  return ["---", `cortex_id: ${args.id}`, "made_by: you", `created: ${args.created.toISOString()}`, `title: ${JSON.stringify(defangRunnable(args.title).replace(/\s+/g, " "))}`, `space: ${args.space}`, "---", ""].join("\n") + body;
}

function withSuffix(rel: string, n: number): string {
  return n <= 1 ? rel : rel.replace(/\.md$/, `-${n}.md`);
}

function draftFile(viewId: string): string {
  return `drafts/new-entry-${viewId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.json`;
}

function validDraft(v: unknown): v is Draft {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return typeof d.title === "string" && typeof d.body === "string" && (d.space === undefined || typeof d.space === "string");
}

export function createNewEntryService(deps?: NewEntryDeps): NewEntryService {
  const drafts = new Map<string, Draft>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const persistFailed = (): void => deps?.log.warn("a New entry draft could not be kept in the local cache");

  if (deps) {
    // Drafts of an earlier session come back once the cache folder has been read.
    void (async () => {
      try {
        const dir = path.join(deps.cacheDir, "drafts");
        for (const name of await fsp.readdir(dir)) {
          const m = /^new-entry-(.+)\.json$/.exec(name);
          if (!m) continue;
          const d = await readJsonIfExists<unknown>(path.join(dir, name));
          if (validDraft(d) && !drafts.has(m[1] as string)) drafts.set(m[1] as string, d);
        }
      } catch {
        // no drafts folder yet
      }
    })();
  }

  const persist = (viewId: string, draft: Draft | null): void => {
    if (!deps) return;
    const prev = timers.get(viewId);
    if (prev) clearTimeout(prev);
    timers.set(
      viewId,
      setTimeout(
        () => {
          timers.delete(viewId);
          void (async () => {
            try {
              await ensureCacheDir(deps.cacheDir);
              const file = cacheWritablePath(deps.cacheDir, draftFile(viewId));
              if (draft) await writeJsonAtomic(file, draft);
              else await fsp.rm(file, { force: true });
            } catch {
              persistFailed();
            }
          })();
        },
        draft ? DRAFT_SAVE_MS : 0,
      ),
    );
  };

  return {
    async save(draft) {
      if (!deps) throw new CortexError("E_INTERNAL", "New entry is not connected to the vault");
      if (deps.sandbox()) throw new CortexError("E_BAD_REQUEST", "the sample record is showing; nothing is saved");
      const body = draft.body;
      if (body.trim().length === 0) throw new CortexError("E_BAD_REQUEST", "the entry is empty");
      if (body.length > MAX_ENTRY_CHARS) throw new CortexError("E_BAD_REQUEST", "the entry is too long");
      const title = draft.title.replace(/\s+/g, " ").trim().slice(0, MAX_ENTRY_TITLE);
      const space = SPACES.some((s) => s.id === draft.space) ? (draft.space as string) : "none";
      const at = (deps.now ?? (() => new Date()))();
      await ensureCortexRoots(deps.vaultRoot, [".raw/written"]);
      const first = writtenEntryPath(at, title || "untitled");
      for (let n = 1; n <= 99; n++) {
        const rel = withSuffix(first, n);
        const id = entryId("written", `written:${rel}`);
        const dir = path.dirname(path.join(deps.vaultRoot, ...rel.split("/")));
        await fsp.mkdir(dir, { recursive: true });
        try {
          await writeFileExclusive(writablePath(deps.vaultRoot, rel), writtenFileText({ id, created: at, title, space, body }));
        } catch (e) {
          if (e instanceof CortexError && e.detail?.exists === true) continue;
          if (errCode(e) === "EEXIST") continue;
          throw e;
        }
        try {
          await deps.runner.request({ cmd: "import", args: { sources: [{ kind: "written" }], maxSeconds: 20 } });
        } catch (e) {
          // The file is safe in .raw/written/; the next import pass picks it up.
          deps.log.warn("the new entry was saved but could not be imported yet", { code: e instanceof CortexError ? e.code : "E_INTERNAL" });
        }
        return { path: rel, entryId: id };
      }
      throw new CortexError("E_IO", "no free file name for the new entry");
    },
    async saveOutcome(input, title) {
      if (!deps) throw new CortexError("E_INTERNAL", "New entry is not connected to the vault");
      return saveOutcome(deps, input, title);
    },
    async listOutcomes() {
      return deps ? listOutcomes(deps) : { outcomes: [], negatives: [] };
    },
    async saveNegativeResult(req) {
      if (!deps) throw new CortexError("E_INTERNAL", "New entry is not connected to the vault");
      return saveNegativeResult(deps, req);
    },
    saveDraft(viewId, draft) {
      drafts.set(viewId, draft);
      persist(viewId, draft);
    },
    loadDraft: (viewId) => drafts.get(viewId) ?? null,
    clearDraft(viewId) {
      drafts.delete(viewId);
      persist(viewId, null);
    },
  };
}
