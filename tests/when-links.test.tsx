/**
 * Time page (PAGE-TL-08, PAGE-TL-14): the "Open as a table" links and a clicked mark's outline, with the other
 * charts stepping back. Pure: the model helpers and the charts' static markup.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import type { WhenStack } from "../src/shared/protocol/worker";
import { blockClass, DayHeat, MonthChart, pickSpan, sectionDimmed, type WhenPick } from "../src/ui/pages/WhenSections";
import { segmentsOf } from "../src/ui/pages/whenModel";
import { readFileSync } from "node:fs";

describe("a clicked mark dims the other charts", () => {
  const pick: WhenPick = { section: "area", month: 2, group: 0 };
  it("nothing picked: nothing dims", () => {
    for (const s of ["area", "lanes", "days", "speakers", "labels"] as const) expect(sectionDimmed(null, s)).toBe(false);
  });
  it("the chart that holds the pick stays; the others step back", () => {
    expect(sectionDimmed(pick, "area")).toBe(false);
    expect(sectionDimmed(pick, "lanes")).toBe(true);
    expect(sectionDimmed(pick, "days")).toBe(true);
    expect(blockClass(pick, "speakers")).toBe("cx-when-block is-dimmed");
    expect(blockClass(pick, "area")).toBe("cx-when-block");
    expect(sectionDimmed({ section: "days", day: 5 }, "days")).toBe(false);
  });
  it("dims to 0.45 in the page styles", () => {
    expect(readFileSync("src/styles/pages.css", "utf8")).toMatch(/\.cx-when-block\.is-dimmed\s*\{\s*opacity:\s*\.45/);
  });
});

describe("a clicked mark is outlined", () => {
  const monthStarts = Array.from({ length: 5 }, (_, i) => new Date(2025, i, 1).getTime());
  const stack: WhenStack = { groups: [{ key: "work", label: "Work", kind: "value" }, { key: "home", label: "Home", kind: "value" }], cells: [1, 2, 3, 4, 2, 0, 1, 1, 1, 1] };
  const base = { name: "Activity", monthStarts, stack, nameOf: (g: number) => (g === 0 ? "Work" : "Home"), fillOf: () => ({ colour: "var(--cx-cat-1)" }), hover: null, skeleton: false, onHover: () => undefined, onPick: () => undefined, onLive: () => undefined, onRange: () => undefined };
  it("draws no outline until something is picked", () => {
    expect(render(<MonthChart {...base} />)).not.toContain("cx-when-pick");
    expect(render(<MonthChart {...base} pick={null} />)).not.toContain("cx-when-pick");
  });
  it("outlines the picked segment, or the whole bar when the pick has no segment", () => {
    const seg = render(<MonthChart {...base} pick={{ month: 2, group: 0 }} />);
    const bar = render(<MonthChart {...base} pick={{ month: 2, group: null }} />);
    expect(seg.match(/cx-when-pick/g)?.length).toBe(1);
    expect(bar.match(/cx-when-pick/g)?.length).toBe(1);
    const h = (html: string) => Number(/class="cx-when-pick"[^>]*height="([\d.]+)"/.exec(html)?.[1]);
    expect(h(bar)).toBeGreaterThan(h(seg));
  });
  it("finds the vertical span of a segment and of the whole bar", () => {
    const segs = segmentsOf(stack, 5, 2, 10);
    const whole = pickSpan(segs, null)!;
    const first = pickSpan(segs, 0)!;
    expect(whole[0]).toBe(0);
    expect(first[1]).toBeLessThanOrEqual(whole[1]);
    expect(pickSpan([], null)).toBeNull();
  });
  it("outlines the picked day on the heatmap", () => {
    const weekStarts = [0, 1, 2].map((w) => new Date(2025, 0, 6 + 7 * w).getTime());
    const counts = new Array<number>(21).fill(1);
    const props = { days: { weekStarts, counts, max: 1 }, weekStart: 1 as const, skeleton: false, onLive: () => undefined, onRange: () => undefined, onPickDay: () => undefined };
    expect(render(<DayHeat {...props} />)).not.toContain("cx-when-pick");
    const day = new Date(2025, 0, 8).getTime();
    expect(render(<DayHeat {...props} pick={day} />).match(/cx-when-pick/g)?.length).toBe(1);
    expect(render(<DayHeat {...props} pick={day + 1} />)).not.toContain("cx-when-pick");
  });
  it("is a 1.5 px outline in the page styles", () => {
    expect(readFileSync("src/styles/pages.css", "utf8")).toMatch(/\.cx-when-pick\s*\{[^}]*stroke-width:\s*1\.5px/);
  });
});

describe("Open as a table links", () => {
  it("sit under the area, lanes and days charts as well as the speaker and label charts", () => {
    const src = readFileSync("src/ui/pages/WhenSections.tsx", "utf8");
    expect((src.match(/t\("when\.numbers"\)/g) ?? []).length).toBe(5);
    expect(src).toContain('openTable("day")');
  });
});
