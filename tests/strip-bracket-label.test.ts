import { describe, expect, it } from "vitest";
import { bracketLabel } from "../src/ui/strip/TimeStrip";

function ctxOf(width: number) {
  const calls: { text: string; x: number; align: string }[] = [];
  const ctx = {
    textAlign: "left",
    measureText: () => ({ width }),
    fillText(text: string, x: number) {
      calls.push({ text, x, align: this.textAlign });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe("bracketLabel", () => {
  const plot = { x: 0, w: 132 };
  it("sits left of the bracket when it fits", () => {
    const { ctx, calls } = ctxOf(40);
    bracketLabel(ctx, "17 May", 100, 110, plot, 5);
    expect(calls).toEqual([{ text: "17 May", x: 94, align: "right" }]);
  });
  it("moves right of the bracket when the left edge would clip it", () => {
    const { ctx, calls } = ctxOf(40);
    bracketLabel(ctx, "17 May", 10, 14, plot, 5);
    expect(calls).toEqual([{ text: "17 May", x: 20, align: "left" }]);
  });
  it("is left out when neither side has room", () => {
    const { ctx, calls } = ctxOf(100);
    bracketLabel(ctx, "17 May", 50, 60, plot, 5);
    expect(calls).toEqual([]);
  });
});
