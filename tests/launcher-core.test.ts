/** The quick window's pure parts (desktop/launcherCore.ts), the launcher settings, and the state the renderer sends. */
import { describe, expect, it } from "vitest";
import { hostStateOf } from "../src/desktop/hostLink";
import { QUERY_MAX, cleanQuery, displayShortcut, launcherBounds, launcherInit, normaliseShortcut, parseLauncherSubmit, shortcutToRegister } from "../src/desktop/launcherCore";
import { parseHostState } from "../src/desktop/trayMenu";
import { extDefaults, isAccelerator } from "../src/shared/settingsExt";
import { appLocked } from "../src/state/lock";
import { t } from "../src/ui/copy";
import { fakeServices } from "./helpers/fakeServices";

describe("normaliseShortcut", () => {
  it("accepts what people type and writes the Electron form", () => {
    expect(normaliseShortcut("Ctrl+Shift+Space")).toBe("CommandOrControl+Shift+Space");
    expect(normaliseShortcut("ctrl + shift + space")).toBe("CommandOrControl+Shift+Space");
    expect(normaliseShortcut("Shift+Ctrl+Space")).toBe("CommandOrControl+Shift+Space");
    expect(normaliseShortcut("CommandOrControl+Alt+K")).toBe("CommandOrControl+Alt+K");
    expect(normaliseShortcut("alt+f9")).toBe("Alt+F9");
    expect(normaliseShortcut("Ctrl+1")).toBe("CommandOrControl+1");
    expect(normaliseShortcut("Control+Option+Up")).toBe("CommandOrControl+Alt+Up");
  });

  it("allows no shortcut at all", () => {
    expect(normaliseShortcut("")).toBe("");
    expect(normaliseShortcut("   ")).toBe("");
  });

  it("refuses a bare key, Shift alone, two keys, an unknown key, a Windows-key chord and junk", () => {
    for (const bad of ["K", "Space", "Shift+K", "Ctrl", "Ctrl+Shift", "Ctrl+K+L", "Ctrl+Foo", "Super+K", "Win+Space", "Ctrl++", "+K", "rm -rf /", "Ctrl+F25", "Ctrl+Enter", "Ctrl+Tab", "a".repeat(60)]) {
      expect(normaliseShortcut(bad), bad).toBeNull();
    }
  });

  it("only ever produces accelerators the settings sanitiser accepts", () => {
    for (const s of ["Ctrl+Shift+Space", "alt+f9", "Ctrl+Alt+Shift+PageDown", "CmdOrCtrl+1"]) {
      const n = normaliseShortcut(s);
      expect(n).not.toBeNull();
      expect(isAccelerator(n as string)).toBe(true);
    }
  });

  it("reads back as people say it on Windows", () => {
    expect(displayShortcut("CommandOrControl+Shift+Space")).toBe("Ctrl+Shift+Space");
    expect(displayShortcut(normaliseShortcut("alt+f9") as string)).toBe("Alt+F9");
  });
});

describe("the default is opt-in", () => {
  const d = extDefaults().launcher;

  it("keeps the quick window and the keep-running choice off, with Ctrl+Shift+Space ready", () => {
    expect(d.quickWindow).toBe(false);
    expect(d.keepRunning).toBe(false);
    expect(d.quickShortcut).toBe("CommandOrControl+Shift+Space");
    expect(normaliseShortcut(displayShortcut(d.quickShortcut))).toBe(d.quickShortcut);
  });

  it("registers nothing until the window is on and has a usable shortcut", () => {
    expect(shortcutToRegister({ quickWindow: false, quickShortcut: d.quickShortcut })).toBeNull();
    expect(shortcutToRegister({ quickWindow: true, quickShortcut: "" })).toBeNull();
    expect(shortcutToRegister({ quickWindow: true, quickShortcut: "K" })).toBeNull();
    expect(shortcutToRegister({ quickWindow: true, quickShortcut: d.quickShortcut })).toBe("CommandOrControl+Shift+Space");
    expect(shortcutToRegister({ quickWindow: true, quickShortcut: "ctrl+alt+k" })).toBe("CommandOrControl+Alt+K");
  });
});

describe("what the window may send", () => {
  it("cleans the text", () => {
    expect(cleanQuery("  hello   world \n")).toBe("hello world");
    expect(cleanQuery("a\u0000b\u0007c")).toBe("a b c");
    expect(cleanQuery("x".repeat(QUERY_MAX + 50))?.length).toBe(QUERY_MAX);
    expect(cleanQuery("   ")).toBeNull();
    expect(cleanQuery(5)).toBeNull();
    expect(cleanQuery(null)).toBeNull();
  });

  it("passes two fields and two modes, nothing else", () => {
    expect(parseLauncherSubmit({ text: " tax receipts ", mode: "find" })).toEqual({ mode: "find", text: "tax receipts" });
    expect(parseLauncherSubmit({ text: "what changed?", mode: "ask" })).toEqual({ mode: "ask", text: "what changed?" });
    expect(parseLauncherSubmit({ text: "x", mode: "run-this", extra: 1 })).toEqual({ mode: "find", text: "x" });
    expect(parseLauncherSubmit({ text: "" })).toBeNull();
    expect(parseLauncherSubmit({ mode: "find" })).toBeNull();
    expect(parseLauncherSubmit("find")).toBeNull();
    expect(parseLauncherSubmit(null)).toBeNull();
  });
});

describe("placement and words", () => {
  it("centres across the work area, a little above the middle", () => {
    const b = launcherBounds({ x: 0, y: 0, width: 1920, height: 1040 });
    expect(b.width).toBe(560);
    expect(b.x).toBe(680);
    expect(b.y).toBeGreaterThan(20);
    expect(b.y).toBeLessThan(260);
  });

  it("follows a second display and shrinks on a tiny one", () => {
    const b = launcherBounds({ x: 1920, y: -200, width: 1280, height: 720 });
    expect(b.x).toBe(1920 + (1280 - 560) / 2);
    const small = launcherBounds({ x: 0, y: 0, width: 400, height: 200 });
    expect(small.width).toBe(360);
    expect(small.x).toBe(20);
  });

  it("shows the area name, falling back to Everything, with words from the catalogue", () => {
    expect(launcherInit("Work").space).toBe("Work");
    expect(launcherInit("   ").space).toBe("Everything");
    expect(launcherInit("Work")).toMatchObject({ wordmark: "cortex", placeholder: "Ask or search", hint: t("launcher.hint"), ariaLabel: "Quick window" });
  });
});

describe("hostStateOf (what the renderer sends the main process)", () => {
  it("carries the launcher settings and the status, and survives the checks on the other side", () => {
    const { services } = fakeServices((s) => {
      s.launcher.quickWindow = true;
      s.launcher.keepRunning = true;
    });
    const now = Date.parse("2026-11-11T12:00:00Z");
    const state = hostStateOf(services, [{ id: "claude-code", kind: "claude-code", status: "watching", items: 3, yourShare: 0.5, lastImport: new Date(now - 5 * 60_000).toISOString(), storedIn: "", watching: true } as never], null, now);
    expect(state.prefs).toEqual({ tray: true, keepRunning: true, quickWindow: true, quickShortcut: "CommandOrControl+Shift+Space" });
    expect(state.status.lastAddedAt).toBe(now - 5 * 60_000);
    expect(state.status.space).toBe("All areas");
    expect(state.status.liveOn).toBe(false);
    expect(parseHostState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("sends no figures and no area name while Cortex is locked", () => {
    const { services } = fakeServices();
    appLocked.value = true;
    try {
      const state = hostStateOf(services, [], null, Date.now());
      expect(state.status).toMatchObject({ locked: true, space: "", lastAddedAt: null, waiting: 0, today: null });
      expect(state.status.exports).toEqual([]);
    } finally {
      appLocked.value = false;
    }
  });
});
