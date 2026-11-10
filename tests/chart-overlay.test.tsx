/**
 * Chart labels and the time strip (CHART-05..08, CHART-29, CHART-40): highlight chips, right-click remove or hide,
 * Alt-click solo, the label tooltip wording, and the strip's outer bracket and brush marker from time tokens and the
 * hovered chart cell. Everything here is pure (no DOM): the label gestures act on a leaf store.
 */
import { describe, expect, it } from "vitest";
import type { DimId } from "../src/shared/dims";
import type { QueryToken } from "../src/shared/protocol/worker";
import { createLeafStore } from "../src/state/store";
import { addToken } from "../src/state/actions";
import { defaultUi } from "../src/state/types";
import { chipInk, highlightIdsOf, hiddenKey, hoverSpan, labelClick, labelContext, labelCount, labelHighlight, labelHintText, labelPair, labelRgb, labelTipText, optionKeyName, parseRef, refTokens } from "../src/ui/stage/ChartOverlay";
import { brushMarker, drawStrip, stripLayout, tokenSpan, type StripPaint } from "../src/ui/strip/TimeStrip";

const ref = (o: object) => parseRef(JSON.stringify(o));
type Pair = [DimId, string];

describe("labelPair", () => {
  it("names the one value a band or axis label stands for", () => {
    expect(labelPair(ref({ x: ["space", "work"] }))).toEqual(["space", "work"]);
    expect(labelPair(ref({ y: ["source", "chat"] }))).toEqual(["source", "chat"]);
  });
  it("gives nothing for a title, a cell, a time range, a combined label or a fold", () => {
    expect(labelPair(null)).toBeNull();
    expect(labelPair(ref({ x: ["space", "a"], y: ["source", "b"] }))).toBeNull();
    expect(labelPair(ref({ t: [1, 2] }))).toBeNull();
    expect(labelPair(ref({ or: [["space", "a"], ["space", "b"]] }))).toBeNull();
    expect(labelPair(ref({ fold: "a/b", x: ["folder", "a/b"] }))).toBeNull();
  });
});

describe("highlight chips and dimming (CHART-05)", () => {
  const work: Pair = ["space", "work"];
  const tokens = (r: object, label = "Work") => refTokens(ref(r)!, label);
  it("no highlight: nothing is a chip and nothing is dimmed", () => {
    expect(labelHighlight([], ["space", "work"])).toEqual({ highlighted: false, dimmed: false });
  });
  it("a highlighted value is a chip; every other label is dimmed", () => {
    const tk = tokens({ x: work });
    expect(labelHighlight(tk, ["space", "work"])).toEqual({ highlighted: true, dimmed: false });
    expect(labelHighlight(tk, ["space", "home"])).toEqual({ highlighted: false, dimmed: true });
    expect(labelHighlight(tk, ["source", "work"])).toEqual({ highlighted: false, dimmed: true });
  });
  it("highlights accumulate and a band token counts too", () => {
    const tk = [...tokens({ x: work }), ...tokens({ y: ["source", "chat"] }, "Chat")];
    expect(labelHighlight(tk, ["source", "chat"]).highlighted).toBe(true);
    expect(labelHighlight(tk, ["space", "work"]).highlighted).toBe(true);
  });
  it("time tokens are not highlights", () => {
    const time: QueryToken = { id: "when:time", kind: "time", label: "Nov", range: [1, 2] };
    expect(labelHighlight([time], ["space", "work"])).toEqual({ highlighted: false, dimmed: false });
  });
  it("the chip takes the chart's own colour key, else the Key's row", () => {
    expect(labelRgb(["space", "work"], "space", [{ key: "work", label: "Work", rgb: [0.1, 0.2, 0.3] }], null)).toEqual([0.1, 0.2, 0.3]);
    const legend = {
      grandTotal: 1,
      sections: [{ population: "notes" as const, dim: "space" as const, total: 1, rows: [{ key: "work", name: "Work", slot: 1, bucket: "value" as const, rgb: [0.5, 0.5, 0.5] as [number, number, number], notes: 1, record: 0, hidden: false, depth: 0, expandable: false }] }],
    };
    expect(labelRgb(["space", "work"], null, undefined, legend)).toEqual([0.5, 0.5, 0.5]);
    expect(labelRgb(["space", "none"], null, undefined, legend)).toBeNull();
  });
  it("picks contrasting text for the chip", () => {
    expect(chipInk([0.95, 0.9, 0.3])).toBe("#0b0d12");
    expect(chipInk([0.1, 0.15, 0.4])).toBe("#ffffff");
  });
});

describe("right-click and Alt-click on a band label (CHART-06, CHART-07)", () => {
  const pair: Pair = ["space", "work"];
  const r = ref({ x: pair })!;
  it("right-click on a plain label hides that band, and again shows it", () => {
    const store = createLeafStore();
    expect(labelContext(store, pair)).toBe("hide");
    expect(store.get("ui").hiddenGroups).toEqual([hiddenKey(pair)]);
    expect(labelContext(store, pair)).toBe("hide");
    expect(store.get("ui").hiddenGroups).toEqual([]);
  });
  it("right-click on a highlighted label removes the highlight and hides nothing", () => {
    const store = createLeafStore();
    labelClick(store, r, "Work", false, ["work", "home"]);
    addToken(store, { id: "when:time", kind: "time", label: "Nov", range: [1, 2] });
    expect(store.get("ui").tokens.map((k) => k.id)).toContain(highlightIdsOf(pair)[0]);
    expect(labelContext(store, pair)).toBe("unhighlight");
    expect(store.get("ui").tokens.map((k) => k.id)).toEqual(["when:time"]);
    expect(store.get("ui").hiddenGroups).toEqual([]);
  });
  it("a plain click highlights; Alt-click shows only that value, again restores all", () => {
    const store = createLeafStore();
    expect(labelClick(store, r, "Work", false, ["work", "home", "play"])).toBe("highlight");
    expect(store.get("ui").tokens).toHaveLength(1);
    expect(labelClick(store, r, "Work", true, ["work", "home", "play"])).toBe("solo");
    expect([...store.get("ui").hiddenGroups].sort()).toEqual(["space=home", "space=play"]);
    expect(store.get("ui").tokens).toHaveLength(1);
    labelClick(store, r, "Work", true, ["work", "home", "play"]);
    expect(store.get("ui").hiddenGroups).toEqual([]);
  });
});

describe("label tooltip (CHART-08)", () => {
  it("says the name and the count on one line", () => {
    expect(labelTipText("Money", 2740)).toBe("Money · 2,740 entries");
  });
  it("names the Alt key Option on a Mac", () => {
    expect(optionKeyName("MacIntel")).toBe("Option");
    expect(optionKeyName("Win32")).toBe("Alt");
    expect(labelHintText("MacIntel")).toBe("Click to highlight · right-click to hide · Option-click for only this");
    expect(labelHintText("Linux x86_64")).toContain("Alt-click");
  });
  it("counts the x category, else the marks that carry the value", () => {
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    const overlay = {
      items: [],
      marks: [
        { key: JSON.stringify({ x: ["month", "a"], y: ["space", "work"] }), label: "", count: 3, bounds },
        { key: JSON.stringify({ x: ["month", "b"], y: ["space", "work"] }), label: "", count: 4, bounds },
      ],
    };
    const result = { overlay, categories: [{ key: "a", label: "A", count: 9 }] };
    expect(labelCount(result, "month", ["month", "a"])).toBe(9);
    expect(labelCount(result, "month", ["space", "work"])).toBe(7);
  });
});

describe("hovered chart cell range", () => {
  it("is the cell's day span with the end inclusive", () => {
    expect(hoverSpan(ref({ t: [1000, 2000] }))).toEqual([1000, 1999]);
    expect(hoverSpan(ref({ x: ["space", "a"] }))).toBeNull();
    expect(hoverSpan(null)).toBeNull();
  });
  it("is part of the leaf's ui state and starts empty", () => {
    expect(defaultUi().hoverRange).toBeNull();
  });
});

describe("time strip bracket and brush (CHART-29, CHART-40)", () => {
  const DAY = 86_400_000;
  const t0 = Date.UTC(2026, 0, 1);
  const tok = (a: number, b: number): QueryToken => ({ id: `time:${a}`, kind: "time", label: "x", range: [a, b] });
  it("takes a span from the union of the active time tokens", () => {
    expect(tokenSpan([])).toBeNull();
    expect(tokenSpan([tok(t0, t0 + DAY)])).toEqual([t0, t0 + DAY]);
    expect(tokenSpan([tok(t0 + 5 * DAY, t0 + 6 * DAY), tok(t0, t0 + DAY), { id: "g", kind: "group", label: "g", dim: "space", value: "a" }])).toEqual([t0, t0 + 6 * DAY]);
  });
  it("places a brush marker inside the plot, nothing outside it", () => {
    const layout = stripLayout(900, 64, "XL");
    const range: [number, number] = [t0, t0 + 100 * DAY];
    const m = brushMarker([t0 + 50 * DAY, t0 + 50 * DAY], range, layout.plot)!;
    expect(m.x).toBeCloseTo(layout.plot.x + layout.plot.w / 2, 3);
    expect(m.w).toBe(0);
    expect(brushMarker([t0 + 200 * DAY, t0 + 201 * DAY], range, layout.plot)).toBeNull();
    expect(brushMarker(null, range, layout.plot)).toBeNull();
  });

  const PLAIN = new Set(["fillStyle", "strokeStyle", "lineWidth", "globalAlpha", "font", "textAlign", "textBaseline"]);
  function paint(extra: Partial<StripPaint>) {
    const layout = stripLayout(900, 64, "XL");
    const calls: { fn: string; args: unknown[] }[] = [];
    const ctx = new Proxy({}, {
      get: (_o, k) => (PLAIN.has(String(k)) ? undefined : (...args: unknown[]) => void calls.push({ fn: String(k), args })),
      set: () => true,
    }) as unknown as CanvasRenderingContext2D;
    const p: StripPaint = {
      width: 900,
      layout,
      range: [t0, t0 + 100 * DAY],
      bins: [],
      bin: "week",
      scale: "linear",
      now: t0 + 100 * DAY,
      period: null,
      hover: -1,
      span: null,
      colours: { bar: "#999", text: "#999", machine: "#a0f", scrim: "#000", line: "#333", bracket: "#fff" },
      mono: "monospace",
      barColour: () => "#999",
      ...extra,
    };
    drawStrip(ctx, p);
    return { calls, layout };
  }
  const tops = (calls: { fn: string; args: unknown[] }[], y: number) => calls.filter((c) => c.fn === "lineTo" && c.args[1] === y);

  it("draws no bracket without a span, a token range or a brush", () => {
    const { calls, layout } = paint({});
    expect(tops(calls, layout.plot.y)).toHaveLength(0);
    expect(tops(calls, layout.plot.y - 3)).toHaveLength(0);
  });
  it("a token range adds the outer bracket, 3 px outside where the inner bracket sits", () => {
    const { calls, layout } = paint({ outer: [t0 + 10 * DAY, t0 + 20 * DAY] });
    expect(tops(calls, layout.plot.y - 3).length).toBeGreaterThan(0);
    expect(calls.some((c) => c.fn === "fillText" && /Jan/.test(String(c.args[0])))).toBe(true);
  });
  it("with an inner bracket too, both are drawn", () => {
    const { calls, layout } = paint({ span: [t0 + 12 * DAY, t0 + 14 * DAY], outer: [t0 + 10 * DAY, t0 + 20 * DAY] });
    expect(tops(calls, layout.plot.y - 3).length).toBeGreaterThan(0);
    expect(tops(calls, layout.plot.y).length).toBeGreaterThan(0);
  });
  it("a hovered span draws a thin vertical line and its date", () => {
    const { calls, layout } = paint({ brush: [t0 + 30 * DAY, t0 + 30 * DAY] });
    expect(calls.filter((c) => c.fn === "lineTo" && c.args[1] === layout.plot.y + layout.plot.h).length).toBeGreaterThan(0);
    expect(calls.some((c) => c.fn === "fillText" && /Jan|Feb/.test(String(c.args[0])))).toBe(true);
  });
});
