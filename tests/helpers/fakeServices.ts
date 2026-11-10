/**
 * A real service container over a fake Obsidian app (no worker, no runner process, no disk writes): the same
 * createBackground → createServices path the plugin uses, with in-memory settings persistence. Owner: E11.
 */
import { fakeApp } from "../stubs/obsidian";
import { createBackground, createServices } from "../../src/plugin/container";
import type { CortexServices, LeafServices } from "../../src/plugin/services";
import { createSettingsHandle } from "../../src/plugin/settingsStore";
import { migrateSettingsChecked, type CortexSettings } from "../../src/shared/settings";

export interface FakeHarness {
  services: CortexServices;
  leaf: LeafServices;
  saved: CortexSettings[];
}

export function fakeServices(patch?: (s: CortexSettings) => void): FakeHarness {
  const initial = migrateSettingsChecked(undefined);
  patch?.(initial.settings);
  const saved: CortexSettings[] = [];
  const settings = createSettingsHandle(initial, {
    load: async () => null,
    exists: async () => false,
    save: async (s) => void saved.push(s),
    backup: async () => undefined,
  });
  const bg = createBackground({
    app: fakeApp(),
    pluginDir: "C:/vault/.obsidian/plugins/cortex",
    pluginVersion: "0.1.0-test",
    settings,
    anyLeafVisible: () => true,
    showNotice: () => undefined,
    // The background work a container starts on its own (index load, runner start) finishes after a short test
    // has ended; a console line then would hit vitest while it tears down (EnvironmentTeardownError).
    logSink: () => undefined,
  });
  const services = createServices(bg);
  return { services, leaf: services.createLeaf("test-leaf"), saved };
}
