/**
 * The Chart panel as a floating left card (P09): the setting's default, when the sheet floats, and that a floating card
 * leaves the stage its whole width while the docked sheet still takes its room.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import type { SheetEntry } from "../src/shared/views";
import { CHART_CARD, sheetFloats, stageBox } from "../src/ui/breakpoints";
import type { Breakpoint } from "../src/state/types";

const chart: SheetEntry = { kind: "page", route: "chart" } as SheetEntry;
const read: SheetEntry = { kind: "page", route: "read" } as SheetEntry;

function ui(over: { bp?: Breakpoint; stack?: SheetEntry[]; float?: boolean; open?: boolean; collapsed?: boolean; immersive?: boolean } = {}) {
  return {
    breakpoint: over.bp ?? "XL",
    immersive: over.immersive ?? false,
    sheet: { open: over.open ?? true, width: 400, stack: over.stack ?? [chart], index: 0, float: over.float ?? true, collapsed: over.collapsed },
  };
}

describe("Chart panel as a floating card", () => {
  it("is on by default (the reference floats the table builder at the left); off docks the sheet on the right", () => {
    expect(DEFAULT_SETTINGS.appearance.chartCard).toBe(true);
    expect(sheetFloats(ui({ float: false }))).toBe(false);
  });

  it("floats only the open Chart page at a wide breakpoint", () => {
    expect(sheetFloats(ui())).toBe(true);
    expect(sheetFloats(ui({ bp: "L" }))).toBe(true);
    expect(sheetFloats(ui({ bp: "M" }))).toBe(false);
    expect(sheetFloats(ui({ bp: "S" }))).toBe(false);
    expect(sheetFloats(ui({ stack: [read] }))).toBe(false);
    expect(sheetFloats(ui({ open: false }))).toBe(false);
    expect(sheetFloats(ui({ immersive: true }))).toBe(false);
    expect(sheetFloats(ui({ collapsed: true }))).toBe(false);
  });

  it("gives the figure the whole window while the card floats, and its room back to the docked sheet", () => {
    const view = { width: 1512, height: 982 };
    const docked = stageBox(view, ui({ float: false }) as never);
    const card = stageBox(view, ui() as never);
    expect(docked.width).toBeLessThan(card.width);
    expect(card.insetRight).toBe(0);
    expect(card.insetLeft).toBe(0);
    expect(card.width).toBe(stageBox(view, { ...ui(), sheet: { ...ui().sheet, open: false } } as never).width);
  });

  it("is a narrow card", () => {
    expect(CHART_CARD.width).toBeGreaterThanOrEqual(190);
    expect(CHART_CARD.width).toBeLessThanOrEqual(260);
  });
});

describe("the chartCard setting", () => {
  it("survives loading and falls back to the default (on) for anything that is not a boolean", async () => {
    const { migrateSettings } = await import("../src/shared/settings");
    expect(migrateSettings({ appearance: { chartCard: true } }).appearance.chartCard).toBe(true);
    expect(migrateSettings({ appearance: { chartCard: "yes" } }).appearance.chartCard).toBe(true);
    expect(migrateSettings({ appearance: { chartCard: false } }).appearance.chartCard).toBe(false);
    expect(migrateSettings({}).appearance.chartCard).toBe(true);
  });

  it("takes the new default over a stored off from before v7 (the old default), and keeps a later choice", async () => {
    const { migrateSettings } = await import("../src/shared/settings");
    expect(migrateSettings({ version: 5, appearance: { chartCard: false } }).appearance.chartCard).toBe(true);
    expect(migrateSettings({ version: 7, appearance: { chartCard: false } }).appearance.chartCard).toBe(false);
  });
});

describe("the answer of a matrix whose marks carry no label", () => {
  it("names the leader from the value its ref points at, else from the categories", async () => {
    const { buildAnswer } = await import("../src/shared/chartAnswers");
    const base = { chart: "matrix" as const, x: "kind" as const, y: null, colour: null, options: {}, placed: 100, name: (_d: string, k: string, f: string) => f || k, dimName: (d: string) => d, period: (a: number, b: number) => `${a}-${b}` };
    const ref = JSON.stringify({ x: ["kind", "map"] });
    const a = buildAnswer({ ...base, categories: [], marks: [{ label: "", count: 40, key: ref }] } as never);
    expect(a.answer?.values.name).toBe("map");
    const b = buildAnswer({ ...base, categories: [{ key: "log", label: "Log", count: 30 }], marks: [{ label: "  ", count: 30, key: "{}" }] } as never);
    expect(b.answer?.values.name).toBe("Log");
  });
});
