/**
 * The scale smoke pipeline (scripts/scale.mjs) at a tiny size, through the same generator and pipeline code:
 * synthetic notes + .raw documents + Claude Code sessions + a ChatGPT zip, a git repo with 2 commits, the in-process
 * runner, import every source, build the index, the date evidence pass, then the incremental runs. Everything lives
 * in a temp folder (the cache too: LOCALAPPDATA points there). No model is called.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generate } from "../scripts/scale-gen.mjs";
import { runPipeline, type StageResult } from "./scale/pipeline";

let tmp = "";
const saved: { L: string | undefined; X: string | undefined } = { L: undefined, X: undefined };

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-scale-test-"));
  saved.L = process.env.LOCALAPPDATA;
  saved.X = process.env.XDG_CACHE_HOME;
  process.env.LOCALAPPDATA = path.join(tmp, "localappdata");
  process.env.XDG_CACHE_HOME = path.join(tmp, "localappdata");
});
afterAll(() => {
  if (saved.L === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = saved.L;
  if (saved.X === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = saved.X;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const by = (stages: StageResult[], name: string): StageResult => {
  const s = stages.find((x) => x.name === name || x.name.startsWith(name));
  if (!s) throw new Error(`no stage ${name}`);
  return s;
};
const num = (s: StageResult, k: string): number => Number(s.detail[k]);

describe("scale pipeline (tiny)", () => {
  it("imports everything, then an unchanged re-import reads nothing, and a touched note reads only itself", async () => {
    const gen = generate(tmp, { notes: 160, rawDocs: 30, bigNotes: 2, bigBytes: 30 * 1024, sessions: 5, bigSessions: 1, bigSessionBytes: 400 * 1024, conversations: 20 });
    const touch = gen.files.notes.slice(0, 12);
    const res = await runPipeline({ vault: gen.vault, zip: gen.zip, touch, grow: gen.liveSession });
    const st = res.stages;

    for (const name of ["import claude-code", "import vault-notes", "import raw", "import chatgpt"]) {
      expect(num(by(st, name), "errors")).toBe(0);
      expect(num(by(st, name), "entries")).toBeGreaterThan(0);
    }
    expect(num(by(st, "import vault-notes"), "entries")).toBe(161);
    expect(num(by(st, "index build (full)"), "entries")).toBeGreaterThan(300);
    expect(res.index.bytes).toBeGreaterThan(1000);

    // git first-seen: one batch pass found every file that is in a commit (notes and .raw documents)
    const git = by(st, "date evidence (git, cold)");
    expect(num(git, "gitChecked")).toBe(192);
    expect(num(git, "gitFound")).toBe(192);

    // nothing changed: nothing added, and only the export zip (hashed to recognise it) is read
    const again = by(st, "re-import, nothing changed");
    expect(num(again, "entries")).toBe(0);
    expect(num(again, "filesRead")).toBeLessThanOrEqual(1);
    expect(num(again, "errors")).toBe(0);

    // touched notes: exactly those are read and become new versions
    const touched = by(st, "re-import after touching");
    expect(num(touched, "entries")).toBe(12);
    expect(num(touched, "filesRead")).toBe(12);
    expect(num(by(st, "index build (after touch)"), "entries")).toBe(num(by(st, "index build (incremental)"), "entries") + 12);

    // a session that grew: the import goes through and reports no error
    expect(num(by(st, "import after one session grew"), "errors")).toBe(0);
    expect(by(st, "sizes").peakMb).toBeLessThan(1500);
  }, 180_000);
});
