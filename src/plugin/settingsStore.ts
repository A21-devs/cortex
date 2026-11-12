/**
 * The SettingsHandle (SERVICES-CONTRACT-GAPS, SAFE-08). Owner: E1. Part of the eager core: tiny.
 *  - `signal` publishes every change (settings tab, commands, onExternalSettingsChange from OneDrive);
 *  - `update()` replaces the object (never mutates in place). Updates run one at a time in call order, each
 *    patching the latest value; the patched object is re-validated with the fail-safe migration (a wrong type
 *    or a malformed list is refused, numbers are clamped to SETTING_RANGES, model aliases must be plain tokens);
 *    then `.data.json.bak` (dot name) is written first, then data.json through Obsidian's saveData, and only
 *    then does the signal change. A failed save leaves the old value in place and rejects;
 *  - while `corrupt` is true nothing is saved and background work stays off until the user resolves it, either
 *    by fixing the file (reload) or with `useDefaults()`, which keeps the unreadable file as
 *    `.data.json.unreadable` (the last good `.data.json.bak` is never overwritten by an unreadable file);
 *  - `reload()` (onExternalSettingsChange) re-reads data.json; an identical result notifies nobody.
 * The control.json kill switch that matches agents.paused and the privacy settings is written by the
 * background tier (plugin/container.ts) when it sees the change.
 */
import { signal } from "@preact/signals-core";
import { CortexError } from "../shared/errors";
import { DEFAULT_SETTINGS, isValidModelAlias, migrateSettingsChecked, SETTING_RANGES, type CortexSettings, type MigratedSettings, type ModelRole } from "../shared/settings";
import type { SettingsHandle } from "./services";

export interface SettingsPersistence {
  /** Raw data.json content (null when absent). Throws when the file exists but cannot be read or parsed. */
  load(): Promise<unknown>;
  /** True when data.json exists on disk (distinguishes "absent" from "unreadable"). */
  exists(): Promise<boolean>;
  save(s: CortexSettings): Promise<void>;
  /** Copy the current data.json to `.data.json.bak` (atomically). */
  backup(): Promise<void>;
  /** Keep the current (unreadable) data.json as `.data.json.unreadable` before defaults replace it. */
  keepUnreadable?(): Promise<void>;
}

/** The handle with the one extra operation the corrupt-settings screen needs (see docs/rfcs/E1.md). */
export interface CortexSettingsHandle extends SettingsHandle {
  /** Replace unreadable settings with the defaults (first-run step again; nothing runs until it is done). */
  useDefaults(): Promise<void>;
}

function unreadable(): MigratedSettings {
  const m = migrateSettingsChecked(undefined);
  m.settings.agents.paused = true;
  m.settings.agents.enabled = false;
  return { settings: m.settings, issues: [{ path: "", problem: "unreadable", action: "rejected" }], corrupt: true };
}

export async function loadSettings(p: SettingsPersistence): Promise<MigratedSettings> {
  let raw: unknown;
  try {
    raw = await p.load();
  } catch {
    return unreadable();
  }
  if (raw === null || raw === undefined) {
    let present = false;
    try {
      present = await p.exists();
    } catch {
      present = true; // cannot tell: fail closed
    }
    return present ? unreadable() : migrateSettingsChecked(undefined);
  }
  return migrateSettingsChecked(raw);
}

function clamp(n: number, [lo, hi]: readonly [number, number]): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Check a patched settings object before it is saved: the same fail-safe migration as loading (anything it
 * would have to repair is refused), numbers clamped to the settings tab's ranges, model aliases validated.
 */
export function checkPatched(next: CortexSettings): CortexSettings {
  const m = migrateSettingsChecked(JSON.parse(JSON.stringify(next)) as unknown);
  if (m.corrupt || m.issues.length > 0) {
    const first = m.issues[0];
    throw new CortexError("E_SETTINGS", `refused settings change: ${first ? `${first.path || "settings"} ${first.problem}` : "invalid"}`, { detail: { issues: m.issues.length } });
  }
  const s = m.settings;
  for (const w of [s.agents.planCaps.fiveHour, s.agents.planCaps.weekly]) w.pct = Math.round(clamp(w.pct, SETTING_RANGES.planCapPct));
  s.agents.concurrency = Math.round(clamp(s.agents.concurrency, SETTING_RANGES.concurrency));
  s.agents.local.timeoutSec = Math.round(clamp(s.agents.local.timeoutSec, SETTING_RANGES.localTimeoutSec));
  s.advanced.pointBudget = Math.round(clamp(s.advanced.pointBudget, SETTING_RANGES.pointBudget));
  s.appearance.dotSize = clamp(s.appearance.dotSize, SETTING_RANGES.dotSize);
  s.appearance.glow = clamp(s.appearance.glow, SETTING_RANGES.glow);
  s.appearance.brightness = clamp(s.appearance.brightness, SETTING_RANGES.brightness);
  for (const role of Object.keys(s.agents.models) as ModelRole[]) {
    if (!isValidModelAlias(s.agents.models[role])) throw new CortexError("E_SETTINGS", `refused settings change: model alias for ${role} is not a plain name`);
  }
  return s;
}

function sameSettings(a: CortexSettings, b: CortexSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createSettingsHandle(initial: MigratedSettings, p: SettingsPersistence, onChange?: (s: CortexSettings) => void): CortexSettingsHandle {
  const sig = signal<CortexSettings>(initial.settings);
  let corrupt = initial.corrupt;
  let issues = initial.issues;
  // Showcase mode's temporary look: the stored settings wait here while a patched copy is shown (never saved or announced).
  let stored: CortexSettings | null = null;
  const dropPreview = (): void => {
    if (stored === null) return;
    const back = stored;
    stored = null;
    sig.value = back;
  };
  // One operation at a time, in call order (a failed one never blocks the next).
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
  const notify = (s: CortexSettings): void => {
    try {
      onChange?.(s);
    } catch {
      // A listener's failure never undoes a saved change.
    }
  };

  const save = async (next: CortexSettings): Promise<void> => {
    try {
      await p.backup();
    } catch {
      // A failed backup never blocks the user's change; the save below is what matters.
    }
    await p.save(next);
  };

  return {
    get value() {
      return sig.value;
    },
    signal: sig,
    get corrupt() {
      return corrupt;
    },
    get issues() {
      return issues;
    },
    preview(patch) {
      if (corrupt) return;
      const base = stored ?? sig.value;
      const next = JSON.parse(JSON.stringify(base)) as CortexSettings;
      patch(next);
      stored = base;
      sig.value = next;
    },
    endPreview: dropPreview,
    update(patch) {
      return serial(async () => {
        dropPreview();
        if (corrupt) throw new CortexError("E_SETTINGS", "settings are unreadable: resolve them before saving");
        const next = JSON.parse(JSON.stringify(sig.value)) as CortexSettings;
        patch(next);
        const checked = checkPatched(next);
        if (sameSettings(checked, sig.value)) return;
        await save(checked);
        // A preview started while this saved kept the old settings to go back to: it ends here, on what was saved.
        stored = null;
        sig.value = checked;
        notify(checked);
      });
    },
    reload() {
      return serial(async () => {
        dropPreview();
        const m = await loadSettings(p);
        // A preview started while the file was read stands on the settings from before it: the comparison and the
        // value go by those, and the preview ends on what was read.
        const shown = stored ?? sig.value;
        const changed = m.corrupt !== corrupt || !sameSettings(m.settings, shown);
        corrupt = m.corrupt;
        issues = m.issues;
        if (!changed) return;
        stored = null;
        sig.value = m.settings;
        notify(m.settings);
      });
    },
    useDefaults() {
      return serial(async () => {
        dropPreview();
        if (!corrupt) return;
        if (p.keepUnreadable) {
          try {
            await p.keepUnreadable();
          } catch {
            // The unreadable file is replaced either way; keeping a copy is a courtesy.
          }
        }
        const fresh = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as CortexSettings;
        await p.save(fresh);
        corrupt = false;
        issues = [];
        stored = null;
        sig.value = fresh;
        notify(fresh);
      });
    },
  };
}
