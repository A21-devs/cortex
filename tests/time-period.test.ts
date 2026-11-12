import { describe, expect, it } from "vitest";
import { activePreset, brushBars, busyParam, dragWindow, endOfDay, firstBusyYear, normalisePeriod, presetPeriod, startOfDay, stepBusy, windowFractions } from "../src/ui/pages/timePeriod";
import { daysWithEntries, laneDrawn, taggedShare } from "../src/ui/pages/whenModel";

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
const bin = (y: number, m: number, entries: number) => ({ start: new Date(y, m - 1, 1).getTime(), end: new Date(y, m, 1).getTime(), entries });
const span = { first: at(2019, 3, 4), last: at(2026, 10, 28) };

describe("period chips", () => {
  it("starts From at the first year with enough entries, else at the first year that has any", () => {
    const bins = [bin(2019, 2, 3), bin(2020, 5, 20), bin(2020, 6, 40), bin(2021, 1, 200)];
    expect(firstBusyYear(bins, 50)).toBe(2020);
    expect(firstBusyYear(bins, 1)).toBe(2019);
    expect(firstBusyYear(bins, 1000)).toBe(2019);
    expect(firstBusyYear([], 50)).toBeNull();
    expect(firstBusyYear([bin(2022, 1, 0)], 50)).toBeNull();
  });

  it("maps each chip to a window ending on the newest day", () => {
    const end = endOfDay(span.last);
    expect(presetPeriod("all", span, 2020)).toBeNull();
    expect(presetPeriod("from", span, 2020)).toEqual([new Date(2020, 0, 1).getTime(), end]);
    expect(presetPeriod("from", span, null)).toBeNull();
    const d30 = presetPeriod("days30", span, null) as [number, number];
    expect(new Date(d30[0]).getDate()).toBe(29);
    expect(new Date(d30[0]).getMonth()).toBe(8);
    expect(Math.round((d30[1] - d30[0]) / 86_400_000)).toBe(30);
    const y1 = presetPeriod("year1", span, null) as [number, number];
    expect([new Date(y1[0]).getFullYear(), new Date(y1[0]).getMonth(), new Date(y1[0]).getDate()]).toEqual([2025, 9, 29]);
    const m6 = presetPeriod("months6", span, null) as [number, number];
    expect(new Date(m6[0]).getMonth()).toBe(3);
  });

  it("never starts before the first dated entry", () => {
    const tiny = { first: at(2026, 10, 20), last: at(2026, 10, 28) };
    expect((presetPeriod("years5", tiny, null) as [number, number])[0]).toBe(startOfDay(tiny.first));
  });

  it("marks the chip the period matches", () => {
    expect(activePreset(null, span, 2020)).toBe("all");
    expect(activePreset(presetPeriod("months6", span, 2020), span, 2020)).toBe("months6");
    expect(activePreset(presetPeriod("from", span, 2020), span, 2020)).toBe("from");
    expect(activePreset([at(2024, 1, 1), at(2024, 2, 1)], span, 2020)).toBeNull();
  });

  it("keeps the pressed chip marked when short data makes two windows equal", () => {
    const tiny = { first: at(2026, 10, 20), last: at(2026, 10, 28) };
    const w = presetPeriod("months6", tiny, null);
    expect(activePreset(w, tiny, null)).toBe("years5");
    expect(activePreset(w, tiny, null, "months6")).toBe("months6");
    expect(activePreset(w, tiny, null, "from")).toBe("years5");
  });
});

describe("busy-year stepper", () => {
  it("reads the param with a default of 50", () => {
    expect(busyParam(undefined)).toBe(50);
    expect(busyParam("120")).toBe(120);
    expect(busyParam("0")).toBe(50);
    expect(busyParam("x")).toBe(50);
    expect(busyParam("2.5")).toBe(50);
  });
  it("steps by ones, tens and fifties and never below 1", () => {
    expect(stepBusy(50, 1)).toBe(60);
    expect(stepBusy(50, -1)).toBe(40);
    expect(stepBusy(5, 1)).toBe(6);
    expect(stepBusy(1, -1)).toBe(1);
    expect(stepBusy(10, -1)).toBe(9);
    expect(stepBusy(100, 1)).toBe(150);
  });
});

describe("brush", () => {
  const lo = startOfDay(span.first);
  const hi = endOfDay(span.last);
  it("keeps handles from crossing and the window inside the span", () => {
    const w: [number, number] = [lo + 100, lo + 200];
    expect(dragWindow(w, "a", 500, lo, hi)).toEqual([lo + 200, lo + 200]);
    expect(dragWindow(w, "a", -500, lo, hi)).toEqual([lo, lo + 200]);
    expect(dragWindow(w, "b", -500, lo, hi)).toEqual([lo + 100, lo + 100]);
    expect(dragWindow(w, "b", 1e15, lo, hi)).toEqual([lo + 100, hi]);
    expect(dragWindow(w, "w", -1e9, lo, hi)).toEqual([lo, lo + 100]);
    expect(dragWindow(w, "w", 1e15, lo, hi)).toEqual([hi - 100, hi]);
  });
  it("turns a window over the whole span into no period", () => {
    expect(normalisePeriod([lo, hi], span)).toBeNull();
    expect(normalisePeriod([lo - 1e9, hi + 1e9], span)).toBeNull();
    expect(normalisePeriod([lo + 1e9, hi], span)).toEqual([lo + 1e9, hi]);
  });
  it("places the window as fractions of the span", () => {
    expect(windowFractions(null, 0, 100)).toEqual([0, 1]);
    expect(windowFractions([25, 50], 0, 100)).toEqual([0.25, 0.5]);
    expect(windowFractions([-10, 500], 0, 100)).toEqual([0, 1]);
  });
  it("folds bins into bars scaled to the tallest", () => {
    const bars = brushBars([bin(2020, 1, 10), bin(2020, 2, 5), bin(2022, 1, 20)], new Date(2020, 0, 1).getTime(), new Date(2023, 0, 1).getTime(), 3);
    expect(bars).toEqual([0.75, 0, 1]);
    expect(brushBars([], 0, 10, 4)).toEqual([0, 0, 0, 0]);
  });
});

describe("section sentences", () => {
  it("reports the busiest pack's share and how many others tag", () => {
    const got = taggedShare([
      { pack: "session", items: 1000, labelled: 80 },
      { pack: "para", items: 500, labelled: 200 },
      { pack: "fixes", items: 10, labelled: 0 },
    ]);
    expect(got).toEqual({ pct: 40, n: 200, total: 500, pack: "para", more: 1, rest: 300 });
    expect(taggedShare([{ pack: "session", items: 10, labelled: 0 }])).toBeNull();
    expect(taggedShare([])).toBeNull();
  });
  it("counts days with an entry and marks drawn", () => {
    expect(daysWithEntries([0, 2, 0, 1, 5])).toBe(3);
    expect(laneDrawn([{ total: 3000, ticks: new Array(1500) }, { total: 4, ticks: new Array(4) }])).toEqual({ drawn: 1504, total: 3004 });
  });
});
