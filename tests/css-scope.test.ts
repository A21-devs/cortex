import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type BuildConfig = typeof import("../scripts/build-config.mjs");
const root = path.resolve(__dirname, "..");
async function cfg(): Promise<BuildConfig> {
  return (await import(pathToFileURL(path.join(root, "scripts", "build-config.mjs")).href)) as BuildConfig;
}

describe("Cortex control styles outrank Obsidian's global form styles", () => {
  it("lifts each .cx- subject by one class and leaves keyframes and foreign classes alone", async () => {
    const { liftSpecificity } = await cfg();
    const out = liftSpecificity(".cx-a, .cx-b .cx-c:hover, .x .cx-d::before { c: red }\n@media (x) { .cx-e[role=\"a\"] { a: b } }\n@keyframes k { from { a: 1 } 50% { a: 2 } }\n.view-header { d: none }");
    expect(out).toContain(".cx-a.cx-a,");
    expect(out).toContain(".cx-b .cx-c.cx-c:hover");
    expect(out).toContain(".x .cx-d.cx-d::before");
    expect(out).toContain(".cx-e.cx-e[role=\"a\"]");
    expect(out).toContain("from { a: 1 } 50% { a: 2 }");
    expect(out).toContain(".view-header {");
  });

  it("is applied to the bundled stylesheets", async () => {
    const { cssOptions } = await cfg();
    const o = cssOptions(root);
    expect(o.plugins?.map((p) => p.name)).toContain("cortex-lift-specificity");
  });

  it("gives the bare slider track a width of its own", async () => {
    const fs = await import("node:fs/promises");
    const css = await fs.readFile(path.join(root, "src/styles/shell.css"), "utf8");
    expect(css).toMatch(/\.cx-slider\.is-bare \.cx-slider-track\s*\{[^}]*flex:\s*1 1 auto/);
  });
});
