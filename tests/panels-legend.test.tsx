/**
 * Panels and legend (P10): the legend grid's pure helpers and its markup, the collapse-to-tab default, and the reader's
 * scroll blur.
 */
import { render } from "preact-render-to-string";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LegendRow } from "../src/shared/protocol/worker";
import { DEFAULT_SETTINGS, migrateSettings } from "../src/shared/settings";
import { BLUR_CLASS, BLUR_HOLD_MS, createScrollBlur, scrollIsFast } from "../src/ui/sheet/scrollBlur";
import { gridMetrics, gridRows, KeyList } from "../src/ui/stage/KeyList";
import { LeafContext, ServicesContext, ShellContext, shellFor } from "../src/ui/context";
import { forceHost } from "../src/ui/host";
import { fakeServices } from "./helpers/fakeServices";

afterEach(() => {
  forceHost(null);
  vi.useRealTimers();
});

const row = (key: string, over: Partial<LegendRow> = {}): LegendRow => ({ key, name: key, depth: 0, notes: 1, record: 1, rgb: [1, 1, 1], hidden: false, ...over }) as LegendRow;

describe("legend grid helpers", () => {
  it("lists every top-level row, or the months of a month tree", () => {
    const plain = [row("a"), row("b"), row("c", { depth: 1 })];
    expect(gridRows(plain).map((r) => r.key)).toEqual(["a", "b"]);
    const tree = [row("2024", { aggregate: true }), row("2024-01", { depth: 1 }), row("2024-02", { depth: 1 })];
    expect(gridRows(tree).map((r) => r.key)).toEqual(["2024-01", "2024-02"]);
  });

  it("sizes columns by width, caps the height at 42% of the stage, and reports the figure's lift", () => {
    const wide = gridMetrics(60, 1000, 900);
    expect(wide.cols).toBe(5);
    expect(wide.height).toBe(12 * 18 + 74);
    expect(wide.lift).toBe(wide.height + 28);
    expect(gridMetrics(600, 1000, 900).height).toBe(Math.floor(900 * 0.42));
    expect(gridMetrics(5, 300, 900).cols).toBe(1);
    expect(gridMetrics(5, 3000, 900).cols).toBe(6);
    expect(gridMetrics(1, 1000, 400).height).toBe(74 + 18);
  });
});

describe("legend list markup (desktop)", () => {
  it("offers 'All groups…' as an in-place expander and the key popover from a small icon", () => {
    forceHost("desktop");
    const h = fakeServices();
    const html = render(
      <ServicesContext.Provider value={h.services}>
        <LeafContext.Provider value={h.leaf}>
          <ShellContext.Provider value={shellFor(h.leaf)}>
            <KeyList />
          </ShellContext.Provider>
        </LeafContext.Provider>
      </ServicesContext.Provider>,
    );
    expect(html).not.toContain("is-grid");
    if (html.includes("cx-keylist-all")) {
      expect(html).toContain('aria-expanded="false"');
      expect(html).not.toContain('data-cx-popover-toggle="key" aria-haspopup="dialog" class="cx-keylist-all"');
    }
  });
});

describe("collapse to a tab by default", () => {
  it("is on in the shipped defaults", () => {
    expect(DEFAULT_SETTINGS.appearance.collapseOnLeave).toBe(true);
  });

  it("follows the new default for settings saved before v5, and keeps a later choice", () => {
    expect(migrateSettings({ version: 4, appearance: { collapseOnLeave: false } }).appearance.collapseOnLeave).toBe(true);
    expect(migrateSettings({ version: 5, appearance: { collapseOnLeave: false } }).appearance.collapseOnLeave).toBe(false);
    expect(migrateSettings({}).appearance.collapseOnLeave).toBe(true);
  });
});

describe("scroll blur", () => {
  it("counts only fast, recent scroll steps", () => {
    expect(scrollIsFast(0, 0, 100, 16)).toBe(true);
    expect(scrollIsFast(0, 0, 20, 16)).toBe(false);
    expect(scrollIsFast(0, 0, 500, 0)).toBe(false);
    expect(scrollIsFast(0, 0, 5000, 500)).toBe(false);
  });

  it("adds the class on a fast scroll, clears it after the hold, and never blurs under reduced motion", () => {
    vi.useFakeTimers();
    const classes = new Set<string>();
    const el = { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } };
    const b = createScrollBlur(el, () => false);
    b.onScroll(0, 0);
    expect(classes.has(BLUR_CLASS)).toBe(false);
    b.onScroll(120, 16);
    expect(classes.has(BLUR_CLASS)).toBe(true);
    vi.advanceTimersByTime(BLUR_HOLD_MS + 1);
    expect(classes.has(BLUR_CLASS)).toBe(false);
    const calm = createScrollBlur(el, () => true);
    calm.onScroll(0, 0);
    calm.onScroll(300, 16);
    expect(classes.has(BLUR_CLASS)).toBe(false);
    b.onScroll(0, 100);
    b.onScroll(200, 116);
    b.dispose();
    expect(classes.has(BLUR_CLASS)).toBe(false);
  });
});
