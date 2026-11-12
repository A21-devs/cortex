/**
 * Menus (P07): a picker opens with its checked row over the button, kept inside the window; the desktop menu bar's
 * File menu and Connect submenu come from one description; the motion stays 90 ms in the stylesheet and the shim.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { alignedMenuTop } from "../src/ui/primitives/menu";
import { MENU_FADE_MS } from "../src/desktop/obsidian/ui";
import { desktopMenu, menuCommandIds } from "../src/desktop/menu";
import { COMMAND_IDS } from "../src/plugin/commands";

describe("alignedMenuTop", () => {
  it("moves the menu up so the checked row's centre meets the button's centre", () => {
    // menu opened at 130, checked row centre at 230 (100 below the menu top), button centre at 112
    expect(alignedMenuTop(130, 230, 112, 300, 900)).toBe(12);
  });
  it("keeps the menu inside the window with a 4 px margin", () => {
    expect(alignedMenuTop(130, 230, 20, 300, 900)).toBe(4);
    expect(alignedMenuTop(130, 140, 880, 300, 900)).toBe(596);
  });
  it("never goes negative when the menu is taller than the window", () => {
    expect(alignedMenuTop(10, 400, 50, 1200, 800)).toBe(4);
  });
});

describe("menu motion", () => {
  const css = readFileSync(new URL("../src/desktop/desktop.css", import.meta.url), "utf8");
  it("fades in and out over the same 90 ms the shim waits for", () => {
    expect(MENU_FADE_MS).toBe(90);
    expect(css).toMatch(/animation: cxd-menu-in 90ms/);
    expect(css).toMatch(/transition: opacity 90ms/);
    expect(css).toMatch(/@keyframes cxd-menu-in[\s\S]*translateY\(2px\)/);
    expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation: none/);
  });
  it("fills the hovered, checked and chosen rows with the accent and white text", () => {
    expect(css).toMatch(/\.menu-item\.is-chosen[\s\S]*?background: var\(--interactive-accent\);\s*color: #fff/);
  });
});

describe("desktop menu bar: File and Connect", () => {
  it("lists every File entry as an available command", () => {
    const ids = menuCommandIds();
    for (const id of ["new-entry", "add-sources", "save-image", "export-ledger"] as const) {
      expect(ids).toContain(id);
      expect(COMMAND_IDS).toContain(id);
    }
  });
  it("keeps Connect out of the flat app menu", () => {
    const app = desktopMenu()[0];
    const flat = app?.kind === "submenu" ? app.items.flatMap((i) => (i.kind === "command" ? [i.id] : [])) : [];
    expect(flat).not.toContain("connect-agent");
  });
});
