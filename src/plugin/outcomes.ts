/**
 * Outcomes and negative results on disk (shared/outcomes.ts holds the pure parts).
 *
 *  - saveOutcome(): `.raw/written/outcomes/<yyyy>/<mm>/<stamp>-<slug>.md`, created exclusively, then the runner imports
 *    the written source (the file comes back as an entry of source "outcome", dated, sealed with the other new entries).
 *  - listOutcomes(): reads those files back (the files are the source of truth, nothing is cached) and the names in
 *    the negative-results folder.
 *  - saveNegativeResult(): `.vault-meta/cortex/negative-results/<yyyymmdd>-<slug>.md` plus `<name>.sha256`. The folder is
 *    local, never imported, and Cortex sends nothing from it. A note that carries a Cortex id is refused.
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { CortexError } from "../shared/errors";
import { entryId } from "../shared/ids";
import type { Logger } from "../shared/log";
import {
  localDay,
  negativeFileName,
  NEGATIVE_DIR,
  normaliseOutcome,
  outcomeFileText,
  outcomeMoment,
  outcomePath,
  OUTCOMES_DIR,
  parseOutcomeText,
  stripRecordIds,
  type NegativeSaved,
  type OutcomeList,
  type OutcomeSummary,
} from "../shared/outcomes";
import { ensureCortexRoots, errCode, writeFileExclusive } from "../node/fsAtomic";
import { sha256Text } from "../node/hash";
import { writablePath } from "../node/paths";
import type { RunnerClient } from "./runnerClient";

export interface OutcomeDeps {
  vaultRoot: string;
  log: Logger;
  runner: Pick<RunnerClient, "request">;
  /** The sample record is showing; nothing is saved. */
  sandbox(): boolean;
  now?: () => Date;
}

const MAX_OUTCOME_FILE = 64 * 1024;
const MAX_OUTCOME_FILES = 2000;

function withSuffix(rel: string, n: number): string {
  return n <= 1 ? rel : rel.replace(/\.md$/, `-${n}.md`);
}

export async function saveOutcome(deps: OutcomeDeps, raw: unknown, rawTitle: string): Promise<{ path: string; entryId: string }> {
  if (deps.sandbox()) throw new CortexError("E_BAD_REQUEST", "the sample record is showing; nothing is saved");
  const now = (deps.now ?? (() => new Date()))();
  const input = normaliseOutcome(raw, localDay(now));
  if (!input) throw new CortexError("E_BAD_REQUEST", "the outcome is incomplete");
  const title = rawTitle.replace(/\s+/g, " ").trim().slice(0, 200) || input.direction;
  const at = outcomeMoment(input.on, now);
  await ensureCortexRoots(deps.vaultRoot, [".raw/written"]);
  const first = outcomePath(at, input.direction);
  for (let n = 1; n <= 99; n++) {
    const rel = withSuffix(first, n);
    const id = entryId("written", `written:${rel}`);
    await fsp.mkdir(path.dirname(path.join(deps.vaultRoot, ...rel.split("/"))), { recursive: true });
    try {
      await writeFileExclusive(writablePath(deps.vaultRoot, rel), outcomeFileText({ id, created: at, title, input }));
    } catch (e) {
      if (e instanceof CortexError && e.detail?.exists === true) continue;
      if (errCode(e) === "EEXIST") continue;
      throw e;
    }
    try {
      await deps.runner.request({ cmd: "import", args: { sources: [{ kind: "written" }], maxSeconds: 20 } });
    } catch (e) {
      deps.log.warn("the outcome was saved but could not be imported yet", { code: e instanceof CortexError ? e.code : "E_INTERNAL" });
    }
    return { path: rel, entryId: id };
  }
  throw new CortexError("E_IO", "no free file name for the outcome");
}

async function* mdFiles(dir: string, rel: string, depth = 0): AsyncGenerator<{ abs: string; rel: string }> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const abs = path.join(dir, name);
    let st;
    try {
      st = await fsp.lstat(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (depth < 3) yield* mdFiles(abs, `${rel}/${name}`, depth + 1);
    } else if (st.isFile() && name.toLowerCase().endsWith(".md") && st.size <= MAX_OUTCOME_FILE) yield { abs, rel: `${rel}/${name}` };
  }
}

export async function listOutcomes(deps: Pick<OutcomeDeps, "vaultRoot">): Promise<OutcomeList> {
  const outcomes: OutcomeSummary[] = [];
  for await (const f of mdFiles(path.join(deps.vaultRoot, ...OUTCOMES_DIR.split("/")), OUTCOMES_DIR)) {
    if (outcomes.length >= MAX_OUTCOME_FILES) break;
    try {
      const o = parseOutcomeText(f.rel, await fsp.readFile(f.abs, "utf8"));
      if (o) outcomes.push(o);
    } catch {
      // an unreadable file is skipped
    }
  }
  const negatives: string[] = [];
  try {
    for (const name of await fsp.readdir(path.join(deps.vaultRoot, ...NEGATIVE_DIR.split("/")))) if (name.toLowerCase().endsWith(".md")) negatives.push(name);
  } catch {
    // no folder yet
  }
  outcomes.sort((a, b) => (a.on === b.on ? (a.path < b.path ? 1 : -1) : a.on < b.on ? 1 : -1));
  return { outcomes, negatives };
}

/** Write the note and its fingerprint. The caller shows the text first; what is written is exactly `text`. */
export async function saveNegativeResult(deps: Pick<OutcomeDeps, "vaultRoot" | "sandbox">, req: { on: string; direction: string; text: string }): Promise<NegativeSaved> {
  if (deps.sandbox()) throw new CortexError("E_BAD_REQUEST", "the sample record is showing; nothing is saved");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.on) || req.text.trim().length === 0 || req.text.length > 20_000) throw new CortexError("E_BAD_REQUEST", "the note is incomplete");
  if (stripRecordIds(req.text) !== req.text) throw new CortexError("E_BAD_REQUEST", "a negative result never carries a record id");
  await ensureCortexRoots(deps.vaultRoot, [".vault-meta/cortex"]);
  await fsp.mkdir(path.join(deps.vaultRoot, ...NEGATIVE_DIR.split("/")), { recursive: true });
  const name = negativeFileName(req.on, req.direction);
  const rel = `${NEGATIVE_DIR}/${name}`;
  const fingerprint = sha256Text(req.text);
  try {
    await writeFileExclusive(writablePath(deps.vaultRoot, rel), req.text);
  } catch (e) {
    if ((e instanceof CortexError && e.detail?.exists === true) || errCode(e) === "EEXIST") return { path: rel, fingerprint, existed: true };
    throw e;
  }
  try {
    await writeFileExclusive(writablePath(deps.vaultRoot, `${rel}.sha256`), `${fingerprint}  ${name}\n`);
  } catch (e) {
    if (!((e instanceof CortexError && e.detail?.exists === true) || errCode(e) === "EEXIST")) throw e;
  }
  return { path: rel, fingerprint, existed: false };
}
