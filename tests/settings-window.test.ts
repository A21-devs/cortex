import { describe, expect, it } from "vitest";
import { ALL_SECTIONS, WINDOW_TABS, applyLiveCapture, cloudFolderOf, liveCaptureAvailable, liveCaptureOn, resolveSettingsTarget, rovingTab, tabPosition } from "../src/shared/settingsTabs";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { SETTINGS_COPY } from "../src/ui/copy";

describe("settings window frame", () => {
  it("has six tabs in the recorded order and a long list that adds Privacy and Advanced", () => {
    expect(WINDOW_TABS).toEqual(["general", "appearance", "lock", "capture", "agents", "sync"]);
    expect(ALL_SECTIONS).toEqual([...WINDOW_TABS, "privacy", "advanced"]);
    for (const id of WINDOW_TABS) {
      expect(SETTINGS_COPY.window.tabs[id].label.length).toBeGreaterThan(0);
      expect(SETTINGS_COPY.window.tabs[id].sub.endsWith(".")).toBe(true);
    }
  });

  it("maps every old section id onto a tab or the long list", () => {
    expect(resolveSettingsTarget("sources")).toEqual({ tab: "capture", all: false, anchor: "capture" });
    expect(resolveSettingsTarget("sync")).toEqual({ tab: "sync", all: false, anchor: "sync" });
    expect(resolveSettingsTarget("lock").tab).toBe("lock");
    expect(resolveSettingsTarget("privacy")).toEqual({ tab: null, all: true, anchor: "privacy" });
    expect(resolveSettingsTarget("advanced")).toEqual({ tab: null, all: true, anchor: "advanced" });
    expect(resolveSettingsTarget("nonsense").tab).toBe("general");
    expect(resolveSettingsTarget(undefined).tab).toBe("general");
  });

  it("counts tabs and roves with the arrow keys, wrapping at both ends", () => {
    expect(tabPosition("appearance")).toEqual({ n: 2, of: 6 });
    expect(tabPosition("sync")).toEqual({ n: 6, of: 6 });
    expect(rovingTab("general", "ArrowRight")).toBe("appearance");
    expect(rovingTab("general", "ArrowLeft")).toBe("sync");
    expect(rovingTab("sync", "ArrowRight")).toBe("general");
    expect(rovingTab("lock", "Home")).toBe("general");
    expect(rovingTab("lock", "End")).toBe("sync");
    expect(rovingTab("lock", "a")).toBeNull();
  });
});

describe("cloud folder check", () => {
  it("names the sync service a path sits in", () => {
    expect(cloudFolderOf("C:/Users/me/OneDrive/Notes/vault")).toBe("OneDrive");
    expect(cloudFolderOf("C:/Users/me/OneDrive - Contoso/vault")).toBe("OneDrive");
    expect(cloudFolderOf(String.raw`C:\Users\me\OneDrive\Notes`)).toBe("OneDrive");
    expect(cloudFolderOf("/Users/me/Library/Mobile Documents/com~apple~CloudDocs/v")).toBe("iCloud");
    expect(cloudFolderOf("/home/me/Dropbox/notes")).toBe("Dropbox");
    expect(cloudFolderOf("G:/My Drive/notes")).toBe("Google Drive");
    expect(cloudFolderOf("C:/Users/me/AppData/Local/cortex/cache")).toBeNull();
  });
});

describe("live capture switch", () => {
  it("reads and sets watching for what is switched on, and is unavailable when nothing is", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.sources.claudeCode.enabled = false;
    s.sources.folders = [];
    expect(liveCaptureAvailable(s)).toBe(false);
    expect(liveCaptureOn(s)).toBe(false);
    s.sources.claudeCode.enabled = true;
    s.sources.claudeCode.watch = true;
    s.sources.folders = [{ id: "x", path: "x", label: "x", extensions: ["md"], space: "none", enabled: true, watch: false }, { id: "y", path: "y", label: "y", extensions: ["md"], space: "none", enabled: false, watch: false }];
    expect(liveCaptureAvailable(s)).toBe(true);
    expect(liveCaptureOn(s)).toBe(true);
    applyLiveCapture(s, false);
    expect(liveCaptureOn(s)).toBe(false);
    expect(s.sources.claudeCode.watch).toBe(false);
    applyLiveCapture(s, true);
    expect(s.sources.folders[0]?.watch).toBe(true);
    expect(s.sources.folders[1]?.watch).toBe(false);
    expect(liveCaptureOn(s)).toBe(true);
  });
});

import { PALETTES, paletteDots, paletteRamp } from "../src/shared/palette";
import { PALETTE_ORDER, radioStep } from "../src/plugin/settingsAppearance";
import { migrateSettings } from "../src/shared/settings";
import { defaultView } from "../src/state/types";
import { RENDER_TUNING } from "../src/render/tuning";

describe("data colour swatches", () => {
  it("lists every palette once, in the swatch order", () => {
    expect([...PALETTE_ORDER].sort()).toEqual(PALETTES.map((p) => p.id).sort());
    expect(PALETTE_ORDER).toHaveLength(7);
  });

  it("builds an eight-slot ramp and five theme-card dots from the active palette", () => {
    const ramp = paletteRamp("prism");
    expect(ramp.startsWith("linear-gradient(90deg, #7ab9fd")).toBe(true);
    expect(ramp.split("#").length - 1).toBe(8);
    expect(paletteDots("prism", 5)).toEqual(["#7ab9fd", "#deb125", "#f58ebc", "#cbd871", "#2eeafd"]);
    expect(paletteDots("prism", 2, true)[0]).toBe("#156ec3");
    expect(paletteDots("print", 5)).toHaveLength(5);
  });

  it("steps a radio group with the arrow keys, wrapping", () => {
    expect(radioStep(7, 6, "ArrowRight")).toBe(0);
    expect(radioStep(7, 0, "ArrowLeft")).toBe(6);
    expect(radioStep(7, 3, "Home")).toBe(0);
    expect(radioStep(7, 3, "End")).toBe(6);
    expect(radioStep(7, 3, "x")).toBeNull();
    expect(radioStep(0, 0, "ArrowRight")).toBeNull();
  });
});

describe("names on the resting body", () => {
  it("is off by default and seeds the view's Names mode", () => {
    const s = migrateSettings(undefined);
    expect(s.appearance.namesAtRest).toBe(false);
    expect(defaultView(s).look.names).toBe("hover");
    s.appearance.namesAtRest = true;
    expect(defaultView(s).look.names).toBe("always");
    s.appearance.namesOnFigure = "off";
    expect(defaultView(s).look.names).toBe("off");
  });

  it("reads an old Always as names on the resting body", () => {
    const old = migrateSettings({ version: 4, appearance: { namesOnFigure: "always" } });
    expect(old.appearance.namesAtRest).toBe(true);
    const chosen = migrateSettings({ version: 4, appearance: { namesOnFigure: "always", namesAtRest: false } });
    expect(chosen.appearance.namesAtRest).toBe(false);
  });
});

describe("recolour timing", () => {
  it("recolours a settings pick faster than a Colour by change", () => {
    expect(RENDER_TUNING.states.recolourSettingsMs).toBe(150);
    expect(RENDER_TUNING.states.recolourMs).toBe(600);
  });
});
