/**
 * Your resume (Add sources › Your resume): one file the person hands Cortex. Its text is kept apart from the
 * record, in the local cache folder (`documents/resume.json`, this computer only, never synced and never an entry),
 * and a claims check is queued: each line of it is searched for in the record and marked Supported, Partly
 * supported or Not found with the entries it rests on. The check runs here, on this computer, with no model, so
 * the resume is never sent anywhere. The result shows in Checks; the Add sources block shows the last check date.
 * Owner: E3 (flows).
 */
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { signal } from "@preact/signals-core";
import { CortexError } from "../shared/errors";
import type { Logger } from "../shared/log";
import { checkClaims, parseResumeFile, resumeExtension, RESUME_MAX_BYTES, statusOf, type RecordSearch, type ResumeFile, type ResumeService, type ResumeStatus } from "../shared/resume";
import { ensureCacheDir, readTextIfExists, writeJsonAtomic } from "../node/fsAtomic";
import { resumeText } from "../node/documentText";
import { cacheWritablePath } from "../node/paths";

export const RESUME_FILE = "documents/resume.json";

export interface ResumeDeps {
  cacheDir: string;
  log: Logger;
  /** Entries of the record holding all of these words (best first, a few at most). */
  search: RecordSearch;
  sandbox?: () => boolean;
  now?: () => number;
  /** Start the queued check straight after add() (default true; tests turn it off). */
  autoRun?: boolean;
}

export function createResumeService(deps: ResumeDeps): ResumeService {
  const now = deps.now ?? Date.now;
  const version = signal(0);
  const file = (): ReturnType<typeof cacheWritablePath> => cacheWritablePath(deps.cacheDir, RESUME_FILE);
  let running: Promise<ResumeStatus | null> | null = null;

  const load = async (): Promise<ResumeFile | null> => {
    await ensureCacheDir(deps.cacheDir);
    const text = await readTextIfExists(file());
    if (text === null) return null;
    try {
      return parseResumeFile(JSON.parse(text));
    } catch {
      return null;
    }
  };
  const save = async (f: ResumeFile): Promise<void> => {
    await ensureCacheDir(deps.cacheDir);
    await writeJsonAtomic(file(), f);
    version.value++;
  };

  const run = async (): Promise<ResumeStatus | null> => {
    const f = await load();
    if (!f) return null;
    await save({ ...f, state: "checking" });
    try {
      const check = await checkClaims(f.text, deps.search, { now });
      const done: ResumeFile = { ...f, state: "done", check };
      await save(done);
      return statusOf(done);
    } catch (e) {
      deps.log.warn("the resume check failed", { message: e instanceof Error ? e.message.slice(0, 160) : "unknown" });
      const failed: ResumeFile = { ...f, state: "failed" };
      await save(failed);
      return statusOf(failed);
    }
  };

  const check = (): Promise<ResumeStatus | null> => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    version,
    async status() {
      const f = await load();
      return f ? statusOf(f) : null;
    },
    async add(source) {
      if (deps.sandbox?.()) throw new CortexError("E_BAD_REQUEST", "the sample record is showing");
      const ext = resumeExtension(source);
      if (!ext) throw new CortexError("E_BAD_REQUEST", "a resume is a .pdf, .docx, .txt or .md file");
      const size = (await stat(source)).size;
      if (size === 0 || size > RESUME_MAX_BYTES) throw new CortexError("E_BAD_REQUEST", "this file is empty or too large for a resume");
      const text = resumeText(await readFile(source), ext);
      const f: ResumeFile = { v: 1, name: path.basename(source).slice(0, 200), addedAt: new Date(now()).toISOString(), chars: text.length, text, state: "queued" };
      await save(f);
      if (deps.autoRun !== false) {
        void check().catch((e: unknown) => deps.log.warn("the resume check could not start", { message: e instanceof Error ? e.message.slice(0, 160) : "unknown" }));
      }
      return statusOf(f);
    },
    check,
    async remove() {
      const f = await load();
      if (!f) return;
      // The text is dropped, not just hidden: what stays is an empty marker the parser ignores.
      await ensureCacheDir(deps.cacheDir);
      await writeJsonAtomic(file(), { v: 0 });
      version.value++;
    },
  };
}
