import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Modal, Setting } from "obsidian";
import CortexPlugin from "../src/main";
import { CortexSettingsModal } from "../src/plugin/settingsModal";
import { CortexSettingTab } from "../src/plugin/settingsTab";
import { SETTINGS_WINDOW_EVENT } from "../src/shared/settingsTabs";
import { SETTINGS_COPY } from "../src/ui/copy";
import { openSettingsWindow } from "../src/ui/openSettings";
import { fakeServices } from "./helpers/fakeServices";
import { fakeApp } from "./stubs/obsidian";

type Created = { name: string; desc: string; heading: boolean; buttons: { text: string; onClickCb: (() => unknown) | null }[] }[];
const created = (): Created => (Setting as unknown as { created: Created }).created;
const root = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

function host() {
  const hh = fakeServices();
  return { hh, h: { plugin: { manifest: { version: "0.1.0" } } as never, settings: () => hh.services.settings, services: () => Promise.reject(new Error("not needed")) } };
}

describe("openSettingsWindow (both hosts)", () => {
  it("Cortex Desktop: tells the tab the section, opens its own Settings page on the Cortex tab", () => {
    const calls: string[] = [];
    const app = { workspace: { trigger: (n: string, s: string) => calls.push(`${n}:${s}`) }, setting: { branded: true, open: () => calls.push("open"), openTabById: (id: string) => calls.push(`tab:${id}`) } };
    openSettingsWindow(app, "agents");
    expect(calls).toEqual(["cortex:settings-section:agents", "open", "tab:cortex"]);
  });
  it("the plugin: asks for the window event and leaves Obsidian's own settings page alone", () => {
    const calls: string[] = [];
    const app = { workspace: { trigger: (n: string, s: string) => calls.push(`${n}:${s}`) }, setting: { open: () => calls.push("open"), openTabById: () => calls.push("tab") } };
    openSettingsWindow(app, "privacy");
    expect(calls).toEqual([`${SETTINGS_WINDOW_EVENT}:privacy`]);
  });
  it("without a workspace bus it falls back to Obsidian's page for the plugin, and never throws without any settings API", () => {
    const calls: string[] = [];
    openSettingsWindow({ setting: { open: () => calls.push("open"), openTabById: (id: string) => calls.push(id) } });
    expect(calls).toEqual(["open", "cortex"]);
    expect(() => openSettingsWindow({})).not.toThrow();
    expect(() => openSettingsWindow({ workspace: { trigger: () => { throw new Error("x"); } } })).not.toThrow();
  });
});

describe("Obsidian's Community plugins > Cortex page", () => {
  it("starts with an Open Cortex settings button, then the full list", () => {
    const { hh, h } = host();
    const app = hh.services.app as unknown as { workspace: { on?: unknown; trigger(n: string, ...a: unknown[]): void }; setting?: { close(): void } };
    const events: unknown[][] = [];
    let closed = 0;
    app.setting = { close: () => void closed++ };
    app.workspace.on = ((name: string, cb: (...a: unknown[]) => void) => (name === SETTINGS_WINDOW_EVENT ? (events.push([name]), cb) : undefined)) as never;
    app.workspace.trigger = (n: string, ...a: unknown[]) => void events.push([n, ...a]);
    const tab = new CortexSettingTab(app as never, h);
    created().length = 0;
    tab.section = "agents";
    tab.display();
    const rows = created();
    expect(rows[0]?.name).toBe(SETTINGS_COPY.window.open);
    expect(rows[0]?.buttons[0]?.text).toBe(SETTINGS_COPY.window.open);
    expect(rows[1]?.heading).toBe(true);
    expect(rows[1]?.name).toBe(SETTINGS_COPY.window.fullList);
    expect(rows.length).toBeGreaterThan(6);
    rows[0]?.buttons[0]?.onClickCb?.();
    expect(closed).toBe(1);
    expect(events.at(-1)).toEqual([SETTINGS_WINDOW_EVENT, "agents"]);
  });
});

describe("CortexSettingsModal (the same window as Cortex Desktop's)", () => {
  it("draws the six tabs, counter and rows into the modal, and its close button closes the modal", () => {
    const { hh, h } = host();
    const modal = new CortexSettingsModal(hh.services.app as never, h as never, "lock");
    modal.open();
    expect(modal.isOpen).toBe(true);
    expect((modal.modalEl as unknown as { classes: Set<string> }).classes.has("cx-settings-modal")).toBe(true);
    const win = (modal.contentEl as unknown as { children: { classes: Set<string>; allText(): string[] }[] }).children[0]!;
    expect(win.classes.has("cx-win")).toBe(true);
    const text = win.allText();
    expect(text).toContain(SETTINGS_COPY.window.tabs.lock.title);
    expect(text).toContain(SETTINGS_COPY.window.allSettings);
    for (const id of ["general", "appearance", "lock", "capture", "agents", "sync"] as const) expect(text).toContain(SETTINGS_COPY.window.tabs[id].label);
    expect(text).toContain("3 of 6");
    modal.show("privacy");
    expect(win.allText()).toContain(SETTINGS_COPY.window.allTitle);
    modal.close();
    expect(modal.isOpen).toBe(false);
  });
  it("keeps Follow theme in Obsidian (only Cortex Desktop drops it) and has no Open Cortex settings row of its own", () => {
    const { hh, h } = host();
    const tab = new CortexSettingTab(hh.services.app as never, h as never, { modal: { close: () => undefined }, section: "appearance" });
    expect(tab.desktopHost).toBe(false);
    created().length = 0;
    tab.display();
    expect(created().some((r) => r.name === SETTINGS_COPY.window.open)).toBe(false);
  });
  it("the plugin opens one window on the event and re-uses it for the next request", async () => {
    const app = fakeApp();
    const plugin = new CortexPlugin(app as never, { id: "cortex", version: "0.1.0", name: "Cortex", author: "", minAppVersion: "1.12.0", description: "" } as never);
    await plugin.onload();
    expect(app.workspace.handlers.has(SETTINGS_WINDOW_EVENT)).toBe(true);
    const open = vi.spyOn(Modal.prototype as unknown as { open(): void }, "open");
    app.workspace.trigger(SETTINGS_WINDOW_EVENT, "sync");
    expect(open).toHaveBeenCalledTimes(1);
    app.workspace.trigger(SETTINGS_WINDOW_EVENT, "agents");
    expect(open).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });
});

describe("shared styles and placement", () => {
  it("one stylesheet draws the window's inside for both hosts", () => {
    expect(read("styles.css")).toContain("settings-window.css");
    const shared = read("src/styles/settings-window.css");
    expect(shared).toContain(".cx-win-head");
    expect(shared).toContain(".cx-settings-modal");
    expect(shared).toContain(".cxd-cortex-win");
    expect(read("src/desktop/desktop.css")).not.toContain(".cx-win-head {");
  });
  it("the plugin's thin-groups notice is left-aligned in the top strip, not centred over the figure", () => {
    const css = read("src/styles/stage.css");
    const rule = css.split("\n").find((l) => l.startsWith(".cx-banner.is-thin-groups {") && l.includes("max-width")) ?? "";
    expect(rule).not.toContain("left: 50%");
    expect(rule).toContain("left: var(--cx-inset)");
    expect(css).toContain(".cx-title-block ~ .cx-banner.is-thin-groups { top: 130px; }");
  });
  it("short windows: the rail tightens in steps and the foot stays at the bottom", () => {
    const shell = read("src/styles/shell.css");
    expect(shell).not.toContain("cx-rail-mini");
    expect(shell).toMatch(/\.cx-rail-foot \{[^}]*margin-top: auto/);
    expect(shell).toContain("@media (max-height: 820px)");
    expect(shell).toContain("@media (max-height: 700px)");
    expect(read("src/styles/desktop-shell.css")).toContain("@media (max-height: 700px)");
  });
});
