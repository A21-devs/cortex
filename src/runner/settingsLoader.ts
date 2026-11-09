/**
 * Build a RunnerContext outside Obsidian (CLI/skill mode): find the vault, read the plugin's data.json
 * (read-only), derive the vault key and cache folder. Owner: E5.
 *
 * FAIL CLOSED (SETTINGS-FAIL-OPEN, SAFE-08): data.json is read up to 3 times over ~300 ms (Obsidian's saveData
 * or a OneDrive sync may be mid-write). If the file exists but still cannot be parsed or trusted, the run fails
 * with E_SETTINGS — it never falls back to defaults (which would mean "not paused, organise, nothing excluded").
 * Only a MISSING file uses the defaults. The source used is recorded on every RunRecord (settingsSource).
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { CortexError } from "../shared/errors";
import { vaultKey } from "../shared/ids";
import type { RunnerContext } from "../shared/protocol/runner";
import { migrateSettingsChecked } from "../shared/settings";
import { defaultCacheDir } from "../node/platform";
import { RUNNER_VERSION } from "./host";

/** Walk up from `start` to the first folder that contains `.obsidian/`. */
export function findVaultRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(dir, ".obsidian"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Read and parse data.json with retries; throws E_SETTINGS when it exists but cannot be trusted. */
export function readSettingsFile(dataJson: string, tries = 3, delayMs = 100): { raw: unknown; source: "data.json" | "defaults" } {
  if (!existsSync(dataJson)) return { raw: undefined, source: "defaults" };
  for (let i = 0; i < tries; i++) {
    try {
      return { raw: JSON.parse(readFileSync(dataJson, "utf8")), source: "data.json" };
    } catch {
      if (i < tries - 1) sleepSync(delayMs);
    }
  }
  throw new CortexError("E_SETTINGS", "settings unreadable", { detail: { code: "settings-unreadable" } });
}

export function loadRunnerContext(vaultArg: string | undefined, runnerFile: string): RunnerContext {
  const vaultRoot = vaultArg ? path.resolve(vaultArg) : findVaultRoot(path.dirname(runnerFile));
  if (!vaultRoot || !existsSync(path.join(vaultRoot, ".obsidian"))) {
    throw new CortexError("E_BAD_REQUEST", "vault not found: pass --vault <path to the vault folder>");
  }
  const { raw, source } = readSettingsFile(path.join(vaultRoot, ".obsidian", "plugins", "cortex", "data.json"));
  const m = migrateSettingsChecked(raw);
  if (m.corrupt) throw new CortexError("E_SETTINGS", "settings unreadable", { detail: { code: "settings-unreadable" } });
  const key = vaultKey(vaultRoot);
  return { vaultRoot, vaultKey: key, cacheDir: defaultCacheDir(key), settings: m.settings, pluginVersion: RUNNER_VERSION, settingsSource: source };
}
