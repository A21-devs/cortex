import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles/pages.css", import.meta.url), "utf8");

describe("pages.css, the Read list", () => {
  it("keeps every row and day heading at its own height inside the scrolling list", () => {
    // Rows carry a min-height; without this a short list column squeezes them and their text overlaps.
    expect(css).toMatch(/\.cx-read-list > \* \{ flex-shrink: 0; \}/);
  });

  it("stacks the Data page's three selects as full-width label rows", () => {
    expect(css).toMatch(/\.cx-data-controls \{[^}]*flex-direction: column/);
    expect(css).toMatch(/\.cx-data-controls > \.cx-row \{ width: 100%; \}/);
  });

  it("draws no rule under a panel's title row", () => {
    expect(css).toMatch(/\.cx-sheet \.cx-sheet-header[^{]*\{ border-bottom-color: transparent; \}/);
  });
});
