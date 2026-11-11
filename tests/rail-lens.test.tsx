/**
 * The rail's lens (P04): the wordmark's hover and wheel cycle drives a strong area preview; the key leads with the
 * previewed area and the figure fades the rest to 6%. Pure logic only (the project's unit tests run without a DOM).
 */
import { describe, expect, it } from "vitest";
import { RENDER_TUNING as T } from "../src/render/tuning";
import { LENS_WHEEL_MS } from "../src/ui/nav/RailWordmark";
import { lensRows } from "../src/ui/stage/KeyBar";
import { createWheelGate, cycleOrder, startHoverCycle, stepCycle, type Scope, type Timers } from "../src/ui/header/spaceCycle";
import type { LegendRow } from "../src/shared/protocol/worker";

describe("lens: the figure fade", () => {
  it("fades the rest to 6% in 130 ms", () => {
    expect(T.stateAlpha.lensOthers).toBe(0.06);
    expect(T.states.lensFadeMs).toBe(130);
  });
});

describe("key: the lens leads the area row", () => {
  const row = (key: string): LegendRow => ({ key, name: key, slot: 1, bucket: "value", rgb: [1, 2, 3], notes: 1, record: 0, hidden: false, depth: 0, expandable: false });
  const rows = [row("code"), row("web"), row("money")];
  it("moves the previewed area first and names it", () => {
    const l = lensRows(rows, "space", { kind: "area", key: "money" });
    expect(l.rows.map((r) => r.key)).toEqual(["money", "code", "web"]);
    expect(l.key).toBe("money");
  });
  it("leaves other keys, other previews and unknown areas alone", () => {
    expect(lensRows(rows, "kind", { kind: "area", key: "money" }).key).toBeNull();
    expect(lensRows(rows, "space", { kind: "group", key: "space=money" }).rows.map((r) => r.key)).toEqual(["code", "web", "money"]);
    expect(lensRows(rows, "space", { kind: "area", key: "games" }).key).toBeNull();
    expect(lensRows(rows, "space", null).key).toBeNull();
  });
});

describe("wordmark: the hover cycle and the wheel", () => {
  const order: Scope[] = cycleOrder(
    ["code", "web", "money"].map((id) => ({ id: id as never, name: id, slot: 1, notes: 1, entries: 0 })),
    null,
  );
  it("steps one area per notch and merges notches closer than 120 ms", () => {
    expect(LENS_WHEEL_MS).toBe(120);
    const gate = createWheelGate(LENS_WHEEL_MS);
    expect(gate(100, 1000)).toBe(1);
    expect(gate(100, 1060)).toBe(0);
    expect(gate(100, 1100)).toBe(0);
    expect(gate(-100, 1300)).toBe(-1);
    expect(stepCycle(order, "all", 1)).toBe("code");
    expect(stepCycle(order, "all", -1)).toBe("money");
  });
  it("starts after 700 ms, steps every 900 ms and restores on leave", () => {
    const queue: { at: number; fn: () => void }[] = [];
    let now = 0;
    const timers: Timers = {
      setTimeout: (fn, ms) => {
        const e = { at: now + ms, fn };
        queue.push(e);
        return e;
      },
      clearTimeout: (h) => {
        const i = queue.indexOf(h as never);
        if (i >= 0) queue.splice(i, 1);
      },
    };
    const run = (to: number): void => {
      for (;;) {
        queue.sort((a, b) => a.at - b.at);
        const next = queue[0];
        if (!next || next.at > to) break;
        queue.shift();
        now = next.at;
        next.fn();
      }
      now = to;
    };
    const seen: (Scope | null)[] = [];
    const c = startHoverCycle({ order: () => order, current: () => "all", onPreview: (s) => seen.push(s), timers });
    run(699);
    expect(seen).toEqual([]);
    run(700);
    expect(seen).toEqual(["code"]);
    run(1600);
    expect(seen).toEqual(["code", "web"]);
    c.cancel();
    expect(seen).toEqual(["code", "web", null]);
  });
});
