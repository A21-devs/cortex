/**
 * The import-only pipeline the scale smoke test measures (scripts/scale.mjs) and a tiny vitest runs
 * (tests/scale-pipeline.test.ts): the in-process runner → import every source → build the index → the date
 * evidence pass (seals off, git first-seen on). No claude CLI, no agents. The caller owns the environment:
 * LOCALAPPDATA / XDG_CACHE_HOME must already point into a throwaway folder (the cache is always
 * <local app data>/cortex/<vaultKey>).
 */
import fs from "node:fs";
import path from "node:path";
import { createInlineRunner } from "../../src/runner/main";
import { createLogger, type LogLevel } from "../../src/shared/log";
import { vaultKey } from "../../src/shared/ids";
import { defaultCacheDir } from "../../src/node/platform";
import type { FromRunner, RunnerCommand, RunnerContext, SourceSelector } from "../../src/shared/protocol/runner";
import { migrateSettingsChecked } from "../../src/shared/settings";

export interface StageResult {
  name: string;
  ms: number;
  /** Highest RSS (MB) sampled while the stage ran (timer + progress frames). */
  rssMb: number;
  /** Highest RSS (MB) the process has ever reached, by the end of the stage (OS peak working set). */
  peakMb: number;
  detail: Record<string, unknown>;
}

export interface PipelineOptions {
  vault: string;
  zip: string;
  /** Called after each stage (the CLI prints progress). */
  onStage?: (s: StageResult) => void;
  /** Vault-relative notes to rewrite before the "touched" import. */
  touch?: string[];
  /** A Claude Code session file (absolute) to append a few messages to before the "session grew" import. */
  grow?: string;
  /** Skip the second and third import (tests). */
  quick?: boolean;
}

const mb = (n: number): number => Math.round((n / 1048576) * 10) / 10;
const peakMb = (): number => mb(process.resourceUsage().maxRSS * 1024);

function dirBytes(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string): void => {
    let names: fs.Dirent[] = [];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          bytes += fs.statSync(p).size;
          files++;
        } catch {
          /* gone */
        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

export async function runPipeline(o: PipelineOptions): Promise<{ stages: StageResult[]; cache: string; index: { file: string; bytes: number; count: number } }> {
  const settingsRaw = JSON.parse(fs.readFileSync(path.join(o.vault, ".obsidian", "plugins", "cortex", "data.json"), "utf8")) as unknown;
  const settings = migrateSettingsChecked(settingsRaw).settings;
  const key = vaultKey(o.vault);
  const cache = defaultCacheDir(key);
  const ctx: RunnerContext = { vaultRoot: o.vault, vaultKey: key, cacheDir: cache, settings, pluginVersion: "0.1.0", settingsSource: "data.json" };
  const frames: FromRunner[] = [];
  let lastRss = 0;
  let stageRss = 0;
  const sample = (): void => {
    lastRss = process.memoryUsage().rss;
    if (lastRss > stageRss) stageRss = lastRss;
  };
  const warnings: string[] = [];
  const log = createLogger(
    "scale",
    (level: LogLevel, _scope, msg) => {
      if (level === "warn" || level === "error") warnings.push(`${level}:${msg}`);
    },
    () => false,
  );
  const runner = createInlineRunner((f) => {
    frames.push(f);
    sample();
  }, log);
  const timer = setInterval(sample, 100);
  let n = 0;
  const request = <T>(command: RunnerCommand): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = `s${++n}`;
      const poll = setInterval(() => {
        const r = frames.find((f) => (f.t === "result" || f.t === "error") && f.id === id);
        if (!r) return;
        clearInterval(poll);
        frames.length = 0;
        if (r.t === "result") resolve(r.data as T);
        else reject(new Error(JSON.stringify(r)));
      }, 25);
      runner.send({ t: "req", id, ctx, command });
    });

  const stages: StageResult[] = [];
  const stage = async <T>(name: string, run: () => Promise<T>, detail: (r: T) => Record<string, unknown>): Promise<T> => {
    stageRss = 0;
    sample();
    const t0 = Date.now();
    const r = await run();
    sample();
    const s: StageResult = { name, ms: Date.now() - t0, rssMb: mb(stageRss), peakMb: peakMb(), detail: detail(r) };
    stages.push(s);
    o.onStage?.(s);
    return r;
  };

  interface ImportRes {
    entriesAdded: number;
    sources: { source: string; filesSeen: number; filesRead: number; entriesAdded: number; errors: unknown[] }[];
  }
  const importDetail = (r: ImportRes): Record<string, unknown> => ({
    entries: r.entriesAdded,
    filesSeen: r.sources.reduce((a, s) => a + s.filesSeen, 0),
    filesRead: r.sources.reduce((a, s) => a + s.filesRead, 0),
    errors: r.sources.reduce((a, s) => a + s.errors.length, 0),
  });
  const sources: [string, SourceSelector][] = [
    ["claude-code", { kind: "claude-code" }],
    ["vault-notes", { kind: "vault-notes" }],
    ["raw", { kind: "raw" }],
    ["chatgpt", { kind: "chatgpt", file: o.zip }],
  ];
  try {
    for (const [name, sel] of sources) await stage(`import ${name}`, () => request<ImportRes>({ cmd: "import", args: { sources: [sel] } }), importDetail);
    const built = await stage("index build (full)", () => request<{ file: string; count: number }>({ cmd: "index.build", args: { full: true } }), (r) => ({ entries: r.count }));
    // The git first-seen pass, cold: forget what the imports already looked up, then run the pass on its own.
    for (const f of ["state/git-first-seen.json", "state/evidence-cursor.json"]) fs.rmSync(path.join(cache, ...f.split("/")), { force: true });
    await stage("date evidence (git, cold)", () => request<{ gitChecked: number; gitFound: number }>({ cmd: "seals.run", args: { force: true } }), (r) => ({ gitChecked: r.gitChecked, gitFound: r.gitFound }));
    if (!o.quick) {
      await stage("re-import, nothing changed", () => request<ImportRes>({ cmd: "import", args: { sources: sources.map((s) => s[1]) } }), importDetail);
      await stage("index build (incremental)", () => request<{ count: number }>({ cmd: "index.build", args: { full: false } }), (r) => ({ entries: r.count }));
      if (o.touch && o.touch.length > 0) {
        for (const rel of o.touch) {
          const abs = path.join(o.vault, ...rel.split("/"));
          fs.appendFileSync(abs, "\nAn edit made after the first import.\n");
          const old = new Date(Date.now() - 3 * 3_600_000);
          fs.utimesSync(abs, old, old);
        }
        await stage(`re-import after touching ${o.touch.length} notes`, () => request<ImportRes>({ cmd: "import", args: { sources: [{ kind: "vault-notes" }, { kind: "raw" }] } }), importDetail);
        await stage("index build (after touch)", () => request<{ count: number }>({ cmd: "index.build", args: { full: false } }), (r) => ({ entries: r.count }));
      }
    }
    if (!o.quick && o.grow) {
      const lines = fs.readFileSync(o.grow, "utf8").split("\n", 1)[0] ?? "";
      const sid = (JSON.parse(lines) as { sessionId?: string }).sessionId ?? "s";
      const at = new Date().toISOString();
      const rows = [
        { type: "user", uuid: `grow-u-${Date.now()}`, parentUuid: null, timestamp: at, sessionId: sid, entrypoint: "cli", promptSource: "typed", turnOrigin: "human", origin: { kind: "human" }, message: { role: "user", content: "One more question about the plan?" } },
        { type: "assistant", uuid: `grow-a-${Date.now()}`, parentUuid: null, timestamp: at, sessionId: sid, message: { id: `msg_grow_${Date.now()}`, role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Here is one more answer." }] } },
      ];
      fs.appendFileSync(o.grow, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
      await stage("import after one session grew (live)", () => request<ImportRes>({ cmd: "import", args: { sources: [{ kind: "claude-code" }] } }), importDetail);
    }
    const bytes = fs.statSync(built.file).size;
    const cacheSize = dirBytes(cache);
    stages.push({ name: "sizes", ms: 0, rssMb: 0, peakMb: peakMb(), detail: { indexBytes: bytes, cacheFiles: cacheSize.files, cacheBytes: cacheSize.bytes, vaultMeta: dirBytes(path.join(o.vault, ".vault-meta")), warnings: warnings.length } });
    return { stages, cache, index: { file: built.file, bytes, count: built.count } };
  } finally {
    clearInterval(timer);
    runner.dispose();
  }
}
