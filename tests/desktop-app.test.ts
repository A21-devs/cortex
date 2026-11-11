/**
 * Cortex Desktop's app shell: the menu bar description (src/desktop/menu.ts), the "Quick walkthrough" command the Help
 * menu runs, the app icon files and the packaging script's settings, and the example steps file for the screenshot
 * harness. Pure: no Electron.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packIco } from "../scripts/ico.mjs";
import { COMMAND_IDS, COMMANDS, commandAvailable, registerCommands } from "../src/plugin/commands";
import { desktopMenu, menuCommandIds, type MenuNode } from "../src/desktop/menu";
import { parseStepsText } from "../src/desktop/shotSteps";
import { COPY, t, type CopyKey } from "../src/ui/copy";
import type { LeafServices } from "../src/plugin/services";
import { adoptShell, Shell, shellOfView } from "../src/ui/context";
import { Plugin as FakePlugin } from "./stubs/obsidian";

const root = path.resolve(__dirname, "..");

function walk(nodes: readonly MenuNode[], out: MenuNode[] = []): MenuNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.kind === "submenu") walk(n.items, out);
  }
  return out;
}

function entriesOf(label: string): string[] {
  const m = desktopMenu().find((x) => x.kind === "submenu" && x.label === label);
  return m?.kind === "submenu" ? m.items.flatMap((i) => (i.kind === "role" ? [i.role] : i.kind === "action" ? [i.action] : i.kind === "command" ? [i.id] : [])) : [];
}

describe("desktop menu bar", () => {
  const menu = desktopMenu();

  it("has the app, File, Edit, View, Window and Help menus", () => {
    expect(menu.map((m) => (m.kind === "submenu" ? m.label : ""))).toEqual([COPY.desktopMenu.app, COPY.desktopMenu.file, COPY.desktopMenu.edit, COPY.desktopMenu.view, COPY.desktopMenu.window, COPY.desktopMenu.help]);
  });

  it("puts the app commands in the app menu, in order, with Lock on Ctrl+L and Quit on Ctrl+Q", () => {
    const app = menu[0];
    const items = app?.kind === "submenu" ? app.items : [];
    expect(entriesOf(COPY.desktopMenu.app)).toEqual(["about", "check-updates", "open-settings", "setup-agents", "show-agreement", "lock", "quit"]);
    expect(items.flatMap((i) => (i.kind === "command" || i.kind === "action" ? [i.label] : []))).toEqual(["About Cortex", "Check for updates…", "Settings…", "Set up agents…", "Show my consent…", "Lock", "Quit"]);
    const lock = items.find((i) => i.kind === "command" && i.id === "lock");
    const quit = items.find((i) => i.kind === "action" && i.action === "quit");
    expect(lock && "accelerator" in lock ? lock.accelerator : null).toBe("CmdOrCtrl+L");
    expect(quit && "accelerator" in quit ? quit.accelerator : null).toBe("CmdOrCtrl+Q");
  });

  it("has the standard Edit, View, Window and Help entries", () => {
    expect(entriesOf(COPY.desktopMenu.edit)).toEqual(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
    expect(entriesOf(COPY.desktopMenu.view)).toEqual(["zoomIn", "zoomOut", "resetZoom", "full-screen", "toggle-immersive", "showcase", "reload", "devtools"]);
    expect(entriesOf(COPY.desktopMenu.window)).toEqual(["minimize", "close"]);
    expect(entriesOf(COPY.desktopMenu.help)).toEqual(["open-guide", "start-tour"]);
  });

  it("makes Connect a submenu of agents and gives File its four entries", () => {
    const app = menu[0];
    const connect = app?.kind === "submenu" ? app.items.find((i) => i.kind === "submenu") : undefined;
    expect(connect?.kind === "submenu" ? connect.label : "").toBe(COPY.desktopMenu.connect);
    expect(connect?.kind === "submenu" ? connect.items.flatMap((i) => (i.kind === "command" ? [i.id] : [])) : []).toEqual(["connect-agent", "open-agents"]);
    expect(entriesOf(COPY.desktopMenu.file)).toEqual(["new-entry", "add-sources", "save-image", "export-ledger"]);
  });

  it("only runs registered, available Cortex commands", () => {
    const ids = menuCommandIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(COMMAND_IDS, id).toContain(id);
      expect(commandAvailable(id), id).toBe(true);
    }
    expect(ids).toEqual(expect.arrayContaining(["about", "check-updates", "open-settings", "setup-agents", "connect-agent", "show-agreement", "lock", "toggle-immersive", "open-guide", "start-tour", "new-entry", "add-sources", "save-image", "export-ledger"]));
  });

  it("has a label for every entry, no repeated accelerator, and nothing Mac-only", () => {
    const accelerators: string[] = [];
    for (const n of walk(menu)) {
      if (n.kind === "separator") continue;
      expect(n.label.trim(), JSON.stringify(n)).not.toBe("");
      expect(n.label).not.toMatch(/^desktopMenu\./);
      expect(n.label).not.toMatch(/services|hide others|hide cortex/i);
      if ("accelerator" in n && n.accelerator) accelerators.push(n.accelerator);
    }
    expect(new Set(accelerators).size).toBe(accelerators.length);
  });

  it("takes every label from the copy file", () => {
    for (const key of Object.keys(COPY.desktopMenu)) expect(t(`desktopMenu.${key}` as CopyKey)).not.toBe(`desktopMenu.${key}`);
  });
});

describe("the Quick walkthrough command", () => {
  it("is registered as start-tour with the More menu's wording", () => {
    expect(COMMANDS.find((c) => c.id === "start-tour")?.name).toBe(COPY.more.tour);
    const p = new FakePlugin({}, { id: "cortex", version: "0.1.0" });
    registerCommands(p as never, () => undefined);
    expect((p as unknown as { commands: { id: string }[] }).commands.map((c) => c.id)).toContain("start-tour");
  });

  it("finds the shell of a mounted view and forgets it on dispose", () => {
    const leaf = { viewId: "v-desktop-test" } as unknown as LeafServices;
    const shell = new Shell("v-desktop-test");
    expect(shellOfView("v-desktop-test")).toBeNull();
    adoptShell(leaf, shell);
    expect(shellOfView("v-desktop-test")).toBe(shell);
    shell.dispose();
    expect(shellOfView("v-desktop-test")).toBeNull();
  });
});

describe("app icon and packaging", () => {
  it("packs PNG entries into an ICO container", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const ico = packIco([
      { size: 16, png },
      { size: 256, png },
    ]);
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    expect(ico.readUInt8(6)).toBe(16);
    expect(ico.readUInt8(6 + 16)).toBe(0); // 256 is stored as 0
    expect(ico.readUInt32LE(6 + 8)).toBe(png.length);
    expect(ico.readUInt32LE(6 + 12)).toBe(6 + 32);
    expect(ico.subarray(6 + 32, 6 + 32 + 4).equals(png.subarray(0, 4))).toBe(true);
    expect(ico.length).toBe(6 + 32 + 2 * png.length);
  });

  it("ships a real multi-size icon drawn from the glyph", () => {
    const file = path.join(root, "src", "desktop", "assets", "cortex.ico");
    expect(existsSync(file)).toBe(true);
    const ico = readFileSync(file);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(5);
    const sides: number[] = [];
    for (let i = 0; i < count; i++) {
      const o = 6 + i * 16;
      sides.push(ico.readUInt8(o) || 256);
      const len = ico.readUInt32LE(o + 8);
      const at = ico.readUInt32LE(o + 12);
      expect(ico.subarray(at, at + 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(at + len).toBeLessThanOrEqual(ico.length);
    }
    expect(sides).toEqual(expect.arrayContaining([16, 32, 48, 256]));
    const png = readFileSync(path.join(root, "src", "desktop", "assets", "cortex.png"));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(512);
  });

  it("has the package script and the packager as a dev dependency", () => {
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.scripts["desktop:package"]).toBe("node scripts/package-desktop.mjs");
    expect(pkg.devDependencies["@electron/packager"]).toBeTruthy();
    const script = readFileSync(path.join(root, "scripts", "package-desktop.mjs"), "utf8");
    expect(script).toMatch(/executableName: "Cortex"/);
    expect(script).toMatch(/platform: "win32"/);
    expect(script).toMatch(/cortex\.ico/);
  });
});

describe("example steps: every rail page", () => {
  const file = path.join(root, "docs", "research", "desktop-steps-pages.json");
  it.skipIf(!existsSync(file))("opens and captures Brain, Read, Write, Today, Time, Data, Yours, Checks, Agents, Files, Guide and Ask", () => {
    const steps = parseStepsText(readFileSync(file, "utf8"));
    const pages = ["Brain", "Read", "Write", "Today", "Time", "Data", "Yours", "Checks", "Agents", "Files", "Guide", "Ask"];
    const captures = steps.flatMap((s) => (s.kind === "capture" ? [s.path] : []));
    expect(captures).toEqual(pages.map((p, i) => `pages/${String(i + 1).padStart(2, "0")}-${p.toLowerCase()}.png`));
    const clicks = steps.flatMap((s) => (s.kind === "eval" ? [s.js] : []));
    expect(clicks).toHaveLength(pages.length);
    pages.forEach((p, i) => expect(clicks[i]).toContain(JSON.stringify(p)));
  });
});
