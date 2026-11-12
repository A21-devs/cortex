/** Guide figures: the record diagram's live parts (constellation, key glyphs, ledger squares) and the by-year dot plot. */
import { readFileSync } from "node:fs";
import { render } from "preact-render-to-string";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type CortexSettings } from "../src/shared/settings";
import type { DataIndex } from "../src/shared/index-format";
import { t } from "../src/ui/copy";
import { MENU_CLASS, OPENER_PICKED_CLASS, keepOpenerRing } from "../src/ui/primitives/menu";
import { MENU_FLASH_MS } from "../src/desktop/obsidian/ui";
import { RecordDiagram } from "../src/ui/pages/guide/RecordDiagram";
import { RecordLayers } from "../src/ui/pages/guide/RecordLayers";
import { areaCounts, constellation, keyGlyphs, layerOf, layerPlot, ledgerSquares, spanWords, type RecordFacts } from "../src/ui/pages/guide/recordModel";

const DAY = 86_400_000;
const facts = (over: Partial<RecordFacts> = {}): RecordFacts => ({ seals: null, entries: null, checksOpen: 0, date: (iso) => iso.slice(0, 10), ...over });
const settings = (patch?: (s: CortexSettings) => void): CortexSettings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  patch?.(s);
  return s;
};

describe("constellation of the record", () => {
  const areas = [
    { key: "work", n: 400 },
    { key: "home", n: 90 },
    { key: "study", n: 30 },
    { key: "play", n: 12 },
    { key: "none", n: 0 },
  ];
  it("draws one dot per area that has entries, the biggest first, the same every time", () => {
    const a = constellation(areas, 176, 66);
    expect(a.dots.map((d) => d.key)).toEqual(["work", "home", "study", "play"]);
    expect(constellation(areas, 176, 66)).toEqual(a);
    for (const d of a.dots) {
      expect(d.x).toBeGreaterThanOrEqual(0);
      expect(d.x).toBeLessThanOrEqual(176);
      expect(d.y).toBeGreaterThanOrEqual(0);
      expect(d.y).toBeLessThanOrEqual(66);
    }
    expect((a.dots[0]?.r ?? 0) > (a.dots[3]?.r ?? 0)).toBe(true);
  });
  it("joins every dot after the first to a dot placed before it, and caps the number drawn", () => {
    const c = constellation(areas, 176, 66);
    expect(c.links.length).toBeGreaterThanOrEqual(c.dots.length - 1);
    for (const l of c.links) expect(l.a).toBeLessThan(l.b);
    const many = Array.from({ length: 40 }, (_, i) => ({ key: `a${i}`, n: i + 1 }));
    expect(constellation(many, 100, 60).dots).toHaveLength(14);
    expect(constellation([], 100, 60)).toEqual({ dots: [], links: [] });
  });
});

describe("ledger squares and key glyphs", () => {
  it("shows the newest eight sealed blocks, numbered, with empty places while there are fewer", () => {
    expect(ledgerSquares(0).every((q) => q.n === null)).toBe(true);
    expect(ledgerSquares(3).map((q) => q.n)).toEqual([1, 2, 3, null, null, null, null, null]);
    expect(ledgerSquares(418).map((q) => q.n)).toEqual([411, 412, 413, 414, 415, 416, 417, 418]);
    expect(ledgerSquares(Number.NaN)).toHaveLength(8);
  });
  it("draws one glyph per share and names it from the real holders", () => {
    expect(keyGlyphs(undefined)).toEqual([]);
    const g = keyGlyphs({ total: 3, holders: [{ share: 2, name: " Sam " }, { share: 3, name: "" }] });
    expect(g).toEqual([
      { share: 1, holder: null },
      { share: 2, holder: "Sam" },
      { share: 3, holder: null },
    ]);
    expect(keyGlyphs({ total: 40, holders: [] })).toHaveLength(5);
  });
});

describe("by-year dot plot", () => {
  const n = 6;
  const t0 = Date.UTC(2021, 0, 15);
  const cols = {
    kind: Uint8Array.from([0, 0, 1, 10, 12, 2]),
    t: Float64Array.from([t0, t0 + 400 * DAY, t0 + 800 * DAY, t0 + 1000 * DAY, Number.NaN, t0 + 1200 * DAY]),
    flags: Uint32Array.from([0, 0, 0, 0, 1, 1 << 3]),
  };
  it("maps item kinds to bands", () => {
    expect(layerOf(0)).toBe("conversations");
    expect(layerOf(11)).toBe("notes");
    expect(layerOf(13)).toBe("maps");
    expect(layerOf(99)).toBeNull();
  });
  it("counts dated entries per kind, leaves out undated and hidden ones, and reports the span", () => {
    const p = layerPlot(cols, n);
    expect(p.bands).toEqual([
      { kind: "conversations", n: 2 },
      { kind: "documents", n: 1 },
      { kind: "notes", n: 1 },
    ]);
    expect(p.dated).toBe(4);
    expect(p.undated).toBe(1);
    expect(p.first).toBe(t0);
    expect(p.last).toBe(t0 + 1000 * DAY);
    expect(p.dots).toHaveLength(4);
    for (const d of p.dots) {
      expect(d.x).toBeGreaterThanOrEqual(0);
      expect(d.x).toBeLessThanOrEqual(1);
      expect(d.y).toBeGreaterThanOrEqual(0);
      expect(d.y).toBeLessThanOrEqual(1);
    }
    expect(p.ticks.map((x) => x.year)).toEqual([2021, 2022, 2023]);
  });
  it("thins to the dot cap and handles an empty record", () => {
    const big = 5000;
    const t = new Float64Array(big).map((_, i) => t0 + i * DAY);
    const p = layerPlot({ kind: new Uint8Array(big), t, flags: new Uint32Array(big) }, big, 1000);
    expect(p.dated).toBe(big);
    expect(p.dots.length).toBeLessThanOrEqual(1000);
    expect(layerPlot({ kind: [], t: [], flags: [] }, 0)).toMatchObject({ dated: 0, bands: [], dots: [] });
  });
  it("words the span in years, months or under a month", () => {
    expect(spanWords(t0, t0 + 5 * 365 * DAY)).toEqual({ unit: "years", n: 5 });
    expect(spanWords(t0, t0 + 200 * DAY)).toEqual({ unit: "months", n: 7 });
    expect(spanWords(t0, t0 + 3 * DAY).unit).toBe("short");
  });
  it("counts entries per area for the constellation", () => {
    const c = areaCounts({ space: Uint8Array.from([0, 0, 1, 2]), flags: Uint32Array.from([0, 0, 0, 1 << 2]) }, 4, ["a", "b", "c"]);
    expect(Object.fromEntries(c.map((x) => [x.key, x.n]))).toEqual({ a: 2, b: 1 });
  });
});

describe("Figure 1 and Figure 2 markup", () => {
  it("draws the record diagram's live parts above the step buttons", () => {
    const html = render(
      <RecordDiagram
        settings={settings()}
        facts={facts({ seals: { blocks: 12, entries: 40, intact: true, anchoredAt: "2026-11-02T10:00:00Z" }, entries: 300, areas: [{ key: "work", n: 200 }, { key: "home", n: 100 }], shares: { threshold: 2, total: 3, splitAt: "2026-10-01", holders: [{ share: 1, name: "Ada" }] } })}
        onAction={() => undefined}
      />,
    );
    expect(html).toContain('data-figure="record"');
    expect(html.match(/data-block="/g)).toHaveLength(8);
    expect(html).toContain('data-block="12"');
    expect(html).toContain("Anchored 2026-11-02");
    expect(html).toContain("fingerprint only");
    expect(html).toContain("2 of 3 open it");
    expect(html.match(/data-share="/g)).toHaveLength(3);
    expect(html).toContain("Ada");
    expect(html).toContain("300 entries");
    expect(html).toContain("cx-fig-arrow is-accent");
    expect(html).toContain('data-node="vault"'); // the step buttons are still there
    expect(html).not.toContain("guide.record");
  });
  it("says so, and draws no frame, while nothing is known", () => {
    const html = render(<RecordDiagram settings={settings()} facts={facts()} onAction={() => undefined} />);
    expect(html).toContain("No block sealed yet");
    expect(html).toContain("Not split yet");
    expect(html).toContain("Not anchored");
    expect(html).toContain("No entries yet");
    expect(html).toContain("cx-fig-const is-empty");
  });

  const index = (n: number): DataIndex =>
    ({
      count: n,
      cols: {
        kind: Uint8Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 1 : 0)),
        t: Float64Array.from({ length: n }, (_, i) => Date.UTC(2020, 0, 1) + i * 40 * DAY),
        flags: new Uint32Array(n),
      },
    }) as unknown as DataIndex;

  it("draws the by-year figure with a legend and a caption from the live index", () => {
    const html = render(<RecordLayers index={index(60)} areas={[{ key: "work", n: 5 }]} date={(ms) => new Date(ms).toISOString().slice(0, 10)} />);
    expect(html).toContain("Your record, layer by layer");
    expect(html).toContain('data-figure="layers"');
    expect(html).toContain('data-kind="conversations"');
    expect(html).toContain('data-kind="documents"');
    expect(html).toMatch(/Conversations 40/);
    expect(html).toMatch(/Figure 2\. 60 dated entries over 7 years, from 2020-01-01 to 2026-06-18/);
    expect(html).not.toContain("guide.record");
  });
  it("says there is nothing to draw without an index or without dated entries", () => {
    expect(render(<RecordLayers index={null} areas={[]} date={String} />)).toContain("no dated entries yet");
    const undated = { count: 2, cols: { kind: Uint8Array.from([0, 0]), t: Float64Array.from([Number.NaN, Number.NaN]), flags: new Uint32Array(2) } } as unknown as DataIndex;
    const html = render(<RecordLayers index={undated} areas={[]} date={String} />);
    expect(html).toContain("no dated entries yet");
    expect(html).not.toContain("<svg");
  });
  it("reads no colour from the figure's colour theme", () => {
    const src = readFileSync(new URL("../src/ui/pages/guide/RecordLayers.tsx", import.meta.url), "utf8") + readFileSync(new URL("../src/ui/pages/guide/RecordFigure.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/figureColours|ageColours|appearance/);
    expect(t("guide.record.layers.title")).toBe("Your record, layer by layer");
  });
});

describe("menus: accent bar, chosen-row flash, opener ring", () => {
  it("holds the chosen row for 120 ms, longer than the 90 ms fade", () => {
    expect(MENU_FLASH_MS).toBe(120);
  });
  it("styles only Cortex's own menus with a solid accent bar and gives the used opener a ring", () => {
    const css = readFileSync(new URL("../src/styles/menu-accent.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.menu\.cx-menu \.menu-item\.is-chosen[\s\S]*?background: var\(--interactive-accent\)/);
    expect(css).toMatch(/\.menu\.cx-menu \.menu-item:hover/);
    expect(css).toMatch(/\.is-menu-picked/);
    expect(MENU_CLASS).toBe("cx-menu");
    expect(OPENER_PICKED_CLASS).toBe("is-menu-picked");
  });
  it("keeps the ring until the opener blurs", () => {
    const listeners: Record<string, () => void> = {};
    const classes = new Set<string>();
    const anchor = {
      isConnected: true,
      classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
      addEventListener: (e: string, fn: () => void) => void (listeners[e] = fn),
      removeEventListener: vi.fn(),
      focus: vi.fn(),
    } as unknown as HTMLElement;
    keepOpenerRing(anchor);
    expect(classes.has("is-menu-picked")).toBe(true);
    expect(anchor.focus).toHaveBeenCalled();
    listeners.blur?.();
    expect(classes.has("is-menu-picked")).toBe(false);
    keepOpenerRing({ ...anchor, isConnected: false } as unknown as HTMLElement);
  });
});
