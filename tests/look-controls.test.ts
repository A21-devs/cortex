import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("look pass: controls, menus and the Settings window", () => {
  it("fills the checked row of a pick-one menu only, so a checklist shows marks, not a wall of accent", () => {
    const css = read("src/desktop/desktop.css");
    expect(css).toContain(":not(:has(.menu-item.mod-checked ~ .menu-item.mod-checked))");
    expect(css).toContain(".menu:has(.mod-checked) .menu-item {\n  padding-left: 22px;");
  });

  it("squares the desktop toggles and gives selects a chevron", () => {
    const css = read("src/styles/desktop-shell.css");
    expect(css).toMatch(/\.cx-root\.is-desktop \.cx-toggle \{[^}]*border-radius: 3px/);
    expect(css).toContain(".cx-select > .cx-select-caret::before");
  });

  it("draws the Settings window's toggles, selects and tabs like the Display panel's", () => {
    const css = read("src/styles/settings-window.css");
    expect(css).toMatch(/checkbox-container\.checkbox-container \{[^}]*border-radius: 3px/);
    expect(css).toContain("select.dropdown");
    expect(css).toContain(".cx-win-tab.is-active::after");
  });

  it("opens each Settings tab at its top rather than at the last tab's scroll position", () => {
    const src = read("src/plugin/settingsTab.ts");
    const at = src.indexOf("private selectTab(");
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 520)).toContain("this.bodyEl.scrollTop = 0");
  });
});
