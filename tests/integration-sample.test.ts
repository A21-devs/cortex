/**
 * End to end, headless, on throwaway data: scripts/sample-data.mjs → importers (in the in-process runner) →
 * record index build → decode → layout worker placement (Standing by default) → renderer framing.
 * Nothing touches a real vault; the cache lives in a temp folder; no model is called.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInlineRunner } from "../src/runner/main";
import { consoleSink, createLogger } from "../src/shared/log";
import { defaultCacheDir } from "../src/node/platform";
import { vaultKey } from "../src/shared/ids";
import { decodeIndex } from "../src/shared/indexCodec";
import type { FromRunner, RunnerCommand, RunnerContext } from "../src/shared/protocol/runner";
import { DEFAULT_SETTINGS, migrateSettingsChecked } from "../src/shared/settings";
import { METHODS, createWorkerHandler } from "../src/worker/handler";
import { HAZE_KINDS } from "../src/shared/protocol/worker";
import type { VisibilityParams } from "../src/shared/protocol/worker";
import { defaultView } from "../src/state/types";

const root = path.resolve(__dirname, "..");
let tmp = "";
let vault = "";
let cache = "";
let savedEnv: { L: string | undefined; X: string | undefined } = { L: undefined, X: undefined };

function ctxOf(): RunnerContext {
  const raw = JSON.parse(fs.readFileSync(path.join(vault, ".obsidian", "plugins", "cortex", "data.json"), "utf8")) as unknown;
  const settings = migrateSettingsChecked(raw).settings;
  return { vaultRoot: vault, vaultKey: vaultKey(vault), cacheDir: cache, settings, pluginVersion: "0.1.0", settingsSource: "data.json" };
}

function request<T>(runner: ReturnType<typeof createInlineRunner>, frames: FromRunner[], command: RunnerCommand, id: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      const r = frames.find((f) => (f.t === "result" || f.t === "error") && f.id === id);
      if (r) {
        clearInterval(poll);
        if (r.t === "result") resolve(r.data as T);
        else reject(new Error(JSON.stringify(r)));
      } else if (Date.now() - t0 > 60_000) {
        clearInterval(poll);
        reject(new Error("timeout " + id));
      }
    }, 20);
    runner.send({ t: "req", id, ctx: ctxOf(), command });
  });
}

describe("sample record: import → index → layout → framing", () => {
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-int-"));
    vault = path.join(tmp, "vault");
    // The cache is always <local app data>/cortex/<vaultKey> (SAFE-02): point "local app data" at the temp folder.
    savedEnv = { L: process.env.LOCALAPPDATA, X: process.env.XDG_CACHE_HOME };
    process.env.LOCALAPPDATA = path.join(tmp, "localappdata");
    process.env.XDG_CACHE_HOME = path.join(tmp, "localappdata");
    cache = defaultCacheDir(vaultKey(vault));
    execFileSync(process.execPath, [path.join(root, "scripts", "sample-data.mjs"), "--out", vault, "--sessions", "10", "--messages", "10", "--notes", "40"], { stdio: "ignore" });
  });
  afterAll(() => {
    if (savedEnv.L === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = savedEnv.L;
    if (savedEnv.X === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = savedEnv.X;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("defaults to the Standing pose in settings and in a new leaf's view", () => {
    expect(DEFAULT_SETTINGS.general.pose).toBe("standing");
    expect(defaultView(DEFAULT_SETTINGS).pose).toBe("standing");
    // A stored "lying" from an older build reads as Standing until the person picks a pose.
    const old = migrateSettingsChecked({ version: 3, general: { pose: "lying" } }).settings;
    expect(old.general.pose).toBe("standing");
    const chosen = migrateSettingsChecked({ version: 4, general: { pose: "lying", poseChosen: true } }).settings;
    expect(chosen.general.pose).toBe("lying");
  });

  it("imports the sample sources, builds the index, and lays it out as a standing figure", async () => {
    const frames: FromRunner[] = [];
    const runner = createInlineRunner((f) => frames.push(f), createLogger("test", consoleSink, () => false));
    try {
      const imp = await request<{ entriesAdded: number; sources: { errors: unknown[] }[] }>(runner, frames, { cmd: "import", args: { sources: [{ kind: "raw" }, { kind: "vault-notes" }, { kind: "claude-code" }] } }, "i1");
      expect(imp.entriesAdded).toBeGreaterThan(0);
      for (const s of imp.sources) expect(s.errors).toEqual([]);
      const built = await request<{ file: string; count: number }>(runner, frames, { cmd: "index.build", args: { full: true } }, "i2");
      expect(built.count).toBeGreaterThan(10);
      const bytes = fs.readFileSync(built.file);
      const index = decodeIndex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      expect(index.count).toBe(built.count);

      // Layout worker: load the real index and place it as the default (Standing) figure.
      const handler = createWorkerHandler(() => undefined, undefined, true);
      const record = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const summary = await METHODS.loadIndex({ record, vault: null, corrections: null }, handler.state, 1, "v1");
      expect(summary.count).toBe(built.count);
      const pose = defaultView(DEFAULT_SETTINGS).pose;
      expect(pose).toBe("standing");
      const placed = await METHODS.placement({ seed: 7, pose, placement: "area", order: "oldest", depthKey: "time", gamma: 0.6, visibility: {} as VisibilityParams }, handler.state, 2, "v1");
      expect(placed.anat.length).toBe(built.count * 3);
      const finite = [...placed.anat].filter((v) => Number.isFinite(v)).length;
      expect(finite).toBeGreaterThan(built.count * 3 * 0.5);
      // Standing: the crown is at the top of the figure and the cord runs down (CORTEX-UX section 6.2).
      expect(placed.bounds.max[1]).toBeGreaterThan(4);
      expect(placed.bounds.min[1]).toBeLessThan(-3);
      expect(placed.haze.count).toBeGreaterThan(1000);
      const kinds = new Set(placed.haze.kind);
      for (const k of kinds) expect(k).toBeLessThan(HAZE_KINDS.length);
      expect([...kinds].map((k) => HAZE_KINDS[k])).toEqual(expect.arrayContaining(["brain", "thread", "ring"]));
    } finally {
      runner.dispose();
    }
  });
});
