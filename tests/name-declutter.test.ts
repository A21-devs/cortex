import { describe, expect, it } from "vitest";
import { declutterNames, nameNearPointer, nameRect, type NameBox } from "../src/ui/stage/nameDeclutter";

const box = (key: string, x: number, y: number, weight: number, extra: Partial<NameBox> = {}): NameBox => ({ key, x, y, w: 40, h: 16, align: "center", weight, ...extra });

describe("declutterNames", () => {
  it("leaves names that do not overlap where they are", () => {
    const r = declutterNames([box("a", 0, 0, 5), box("b", 100, 0, 3)]);
    expect(r.get("a")).toEqual({ dy: 0, hidden: false });
    expect(r.get("b")).toEqual({ dy: 0, hidden: false });
  });

  it("keeps the bigger group in place and nudges the smaller one a line", () => {
    const r = declutterNames([box("small", 0, 4, 2), box("big", 0, 0, 9)]);
    expect(r.get("big")).toEqual({ dy: 0, hidden: false });
    const s = r.get("small");
    expect(s?.hidden).toBe(false);
    expect(Math.abs(s?.dy ?? 0)).toBe(18);
  });

  it("hides a name that still collides after the nudges", () => {
    const r = declutterNames([box("a", 0, 0, 9), box("b", 0, -18, 8), box("c", 0, 18, 7), box("d", 0, 2, 1)]);
    expect(r.get("d")?.hidden).toBe(true);
  });

  it("a winning name always shows and displaces the bigger one", () => {
    const r = declutterNames([box("big", 0, 0, 99), box("hov", 0, 0, 1, { wins: true })]);
    expect(r.get("hov")).toEqual({ dy: 0, hidden: false });
    expect(r.get("big")?.dy).not.toBe(0);
  });

  it("fixed names are never hidden", () => {
    const r = declutterNames([box("a", 0, 0, 0, { fixed: true }), box("b", 0, 0, 0, { fixed: true }), box("c", 0, 0, 0, { fixed: true }), box("d", 0, 0, 0, { fixed: true })]);
    for (const v of r.values()) expect(v.hidden).toBe(false);
  });

  it("is deterministic and breaks ties by key", () => {
    const a = declutterNames([box("b", 0, 0, 1), box("a", 0, 0, 1)]);
    const b = declutterNames([box("a", 0, 0, 1), box("b", 0, 0, 1)]);
    expect([...a]).toEqual([...b].sort((x, y) => [...a.keys()].indexOf(x[0]) - [...a.keys()].indexOf(y[0])));
    expect(a.get("a")?.dy).toBe(0);
  });

  it("measures the rectangle by alignment", () => {
    expect(nameRect({ x: 50, y: 20, w: 40, h: 10, align: "left" })).toEqual({ x0: 50, y0: 15, x1: 90, y1: 25 });
    expect(nameRect({ x: 50, y: 20, w: 40, h: 10, align: "right" }, 3).x0).toBe(10);
    expect(nameRect({ x: 50, y: 20, w: 40, h: 10, align: "center" }).x1).toBe(70);
  });
});

describe("nameNearPointer", () => {
  it("returns the nearest hidden name within reach", () => {
    const boxes = [box("a", 0, 0, 1), box("b", 30, 0, 1), box("c", 200, 0, 1)];
    const placements = new Map([
      ["a", { dy: 0, hidden: false }],
      ["b", { dy: 0, hidden: true }],
      ["c", { dy: 0, hidden: true }],
    ]);
    expect(nameNearPointer(boxes, placements, 5, 0, 40)).toBe("b");
    expect(nameNearPointer(boxes, placements, 100, 0, 40)).toBeNull();
  });
});
