/**
 * Groups shape: the calendar layouts (rings by year and months by year), fibre bundles between group spheres, and
 * the group-by dimensions map status and calendar month (also a sector grain of the radial clock).
 */
import { describe, expect, it } from "vitest";
import { bundleFibres, fibreCount, FIBRE_STEPS } from "../src/render/bundles";
import { builtinDim, dateDim, GROUP_LAYOUTS, isRhythmGrain, parseDateDim, RHYTHM_GRAINS } from "../src/shared/dims";
import { HUB_STATUS_ORDER, NONE8 } from "../src/shared/index-format";
import type { GroupBundle, VisibilityParams } from "../src/shared/protocol/worker";
import { COPY } from "../src/ui/copy";
import { layoutsFor } from "../src/ui/stage/ShapeBar";
import { groupLabelPreviewKey, groupLabelTarget, pickGroupLabels } from "../src/ui/stage/GroupOverlay";
import { dimLabel } from "../src/ui/valueLabels";
import { computeGroupsArrangement, groupBundles, MAX_BUNDLES, monthCells, monthOfKey, type Group } from "../src/worker/arrangements";
import { NO_CODE, defaultVisibility, readDim } from "../src/worker/charts/common";
import { runChart } from "../src/worker/charts/registry";
import { buildSampleIndex } from "../src/worker/sampleIndex";

const NOW = Date.UTC(2026, 10, 10);
const index = buildSampleIndex(20261110, NOW);
const vis: VisibilityParams = defaultVisibility(index.count);

type Args = Parameters<typeof computeGroupsArrangement>[1];
const args = (layout: Args["layout"], dim: Args["dim"] = "month", fold = false): Args => ({ kind: "groups", dim, layout, fold, merges: {}, hideNoValue: false, visibility: vis });
const arrange = (layout: Args["layout"], dim: Args["dim"] = "month", fold = false) => computeGroupsArrangement(index, args(layout, dim, fold), new Float32Array(index.count * 3));
const finiteCount = (arr: Float32Array): number => {
  let n = 0;
  for (let i = 0; i < arr.length; i += 3) if (Number.isFinite(arr[i]! + arr[i + 1]! + arr[i + 2]!)) n++;
  return n;
};

describe("dimensions: calendar month and map status", () => {
  it("lists calendar month among the rhythm grains, written date only", () => {
    expect(RHYTHM_GRAINS).toEqual(["hour", "weekday", "monthOfYear"]);
    expect(isRhythmGrain("monthOfYear")).toBe(true);
    expect(isRhythmGrain("month")).toBe(false);
    expect(dateDim("monthOfYear", "imported")).toBe("monthOfYear");
    expect(parseDateDim("monthOfYear")).toEqual({ grain: "monthOfYear", basis: "written" });
    expect(dimLabel("monthOfYear")).toBe(COPY.dims.monthOfYear);
  });

  it("folds every year onto twelve months, January first", () => {
    const dv = readDim(index, "monthOfYear", Array.from({ length: index.count }, (_, i) => i));
    expect(dv.keys.length).toBeGreaterThan(3);
    expect(dv.keys.length).toBeLessThanOrEqual(12);
    for (const k of dv.keys) expect(k).toMatch(/^(0[1-9]|1[0-2])$/);
    const sorted = dv.keys.map((k, c) => [Number(k), dv.order[c]!, dv.labels[c]!] as const).sort((a, b) => a[1] - b[1]);
    expect(sorted.map((s) => s[0])).toEqual([...sorted.map((s) => s[0])].sort((a, b) => a - b));
    expect(dv.labels).toContain("Jan");
  });

  it("groups notes by the status of their map, in the order active, quiet, paused", () => {
    const def = builtinDim("hubStatus");
    expect(def).toMatchObject({ group: "agents", appliesTo: "notes", ordered: true, none: "noStatus" });
    expect(dimLabel("hubStatus")).toBe(COPY.dims.hubStatus);
    const items = Array.from({ length: index.count }, (_, i) => i);
    const dv = readDim(index, "hubStatus", items);
    expect(dv.keys.length).toBeGreaterThan(0);
    for (const k of dv.keys) expect(HUB_STATUS_ORDER).toContain(k);
    expect(dv.keys.map((k, c) => [dv.order[c]!, k] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1])).toEqual(HUB_STATUS_ORDER.filter((k) => dv.keys.includes(k)));
    // A note takes its map's status; every coded item is a note whose map carries a status.
    let coded = 0;
    for (let o = 0; o < index.count; o++) {
      if (dv.codes[o] === NO_CODE) continue;
      coded++;
      expect(index.cols.pop[o]).toBe(0);
    }
    expect(coded).toBeGreaterThan(50);
    expect(index.cols.hubStatus.some((s) => s !== NONE8)).toBe(true);
  });

  it("arranges bubbles by map status", () => {
    const res = arrange("bubbles", "hubStatus");
    expect(res.overlay.marks.length).toBeGreaterThan(0);
    expect(res.overlay.marks.length).toBeLessThanOrEqual(HUB_STATUS_ORDER.length + 1);
  });
});

describe("layouts: calendar rings and months by year", () => {
  it("offers them for months (both) and for the other dates (rings), never for plain categories", () => {
    expect(GROUP_LAYOUTS).toContain("wheel");
    expect(GROUP_LAYOUTS).toContain("grid");
    expect(builtinDim("month")!.layouts).toEqual(expect.arrayContaining(["wheel", "grid"]));
    expect(builtinDim("monthOfYear")!.layouts).toEqual(expect.arrayContaining(["wheel", "grid"]));
    expect(builtinDim("week")!.layouts).toContain("wheel");
    expect(builtinDim("week")!.layouts).not.toContain("grid");
    expect(builtinDim("space")!.layouts).not.toContain("wheel");
    expect(layoutsFor("month")[0]).toBe("bubbles");
  });

  it("parses month keys", () => {
    expect(monthOfKey("2026-03")).toEqual({ year: 2026, month: 3 });
    expect(monthOfKey("11")).toEqual({ year: null, month: 11 });
    expect(monthOfKey("2026-13")).toBeNull();
    expect(monthOfKey("00")).toBeNull();
    expect(monthOfKey("space")).toBeNull();
  });

  it("places every item the bubbles place, with a mark per month", () => {
    const base = arrange("bubbles");
    for (const layout of ["wheel", "grid"] as const) {
      const res = arrange(layout);
      expect(finiteCount(res.arr)).toBe(finiteCount(base.arr));
      expect(res.overlay.marks.length).toBe(base.overlay.marks.length);
      expect(res.camera.keepUpright).toBe(true);
    }
  });

  it("puts months on a grid: one row per year (oldest on top), one column per month", () => {
    const res = arrange("grid");
    const rows = new Map<string, number[]>();
    const cols = new Map<string, number[]>();
    for (const m of res.overlay.marks) {
      const k = monthOfKey(m.key);
      if (!k || k.year === null) continue;
      const cx = (m.bounds.min[0] + m.bounds.max[0]) / 2;
      const cy = (m.bounds.min[1] + m.bounds.max[1]) / 2;
      rows.set(String(k.year), [...(rows.get(String(k.year)) ?? []), cy]);
      cols.set(String(k.month), [...(cols.get(String(k.month)) ?? []), cx]);
    }
    expect(rows.size).toBeGreaterThanOrEqual(2);
    for (const ys of rows.values()) for (const y of ys) expect(y).toBeCloseTo(ys[0]!, 4);
    for (const xs of cols.values()) for (const x of xs) expect(x).toBeCloseTo(xs[0]!, 4);
    const years = [...rows.keys()].sort();
    for (let i = 1; i < years.length; i++) expect(rows.get(years[i]!)![0]!).toBeLessThan(rows.get(years[i - 1]!)![0]!);
    // Boxed year labels at the left edge, month names across the top.
    const labels = res.overlay.items.filter((o) => o.type === "label");
    for (const y of years) expect(labels.some((l) => l.type === "label" && l.text === y && l.style === "box" && l.align === "right")).toBe(true);
    expect(labels.some((l) => l.type === "label" && l.text === "Jan" && l.style === "axis")).toBe(true);
  });

  it("puts months on rings: oldest year innermost, January at the top, clockwise", () => {
    const res = arrange("wheel");
    const polar = new Map<string, { r: number; a: number }>();
    for (const m of res.overlay.marks) {
      const cx = (m.bounds.min[0] + m.bounds.max[0]) / 2;
      const cy = (m.bounds.min[1] + m.bounds.max[1]) / 2;
      polar.set(m.key, { r: Math.hypot(cx, cy), a: (Math.atan2(cx, cy) + 2 * Math.PI) % (2 * Math.PI) });
    }
    const byYear = new Map<number, { r: number; a: number; month: number }[]>();
    for (const [key, p] of polar) {
      const k = monthOfKey(key);
      if (!k || k.year === null) continue;
      byYear.set(k.year, [...(byYear.get(k.year) ?? []), { ...p, month: k.month }]);
    }
    const years = [...byYear.keys()].sort((a, b) => a - b);
    expect(years.length).toBeGreaterThanOrEqual(2);
    // Same ring for a year; rings grow with the year.
    for (const y of years) for (const p of byYear.get(y)!) expect(p.r).toBeCloseTo(byYear.get(y)![0]!.r, 4);
    for (let i = 1; i < years.length; i++) expect(byYear.get(years[i]!)![0]!.r).toBeGreaterThan(byYear.get(years[i - 1]!)![0]!.r);
    // Month m sits at angle (m − 0.5)/12 of a turn from the top, clockwise.
    for (const y of years) for (const p of byYear.get(y)!) expect(p.a).toBeCloseTo(((p.month - 0.5) / 12) * 2 * Math.PI, 3);
    // Ring outlines and boxed years.
    expect(res.overlay.items.filter((o) => o.type === "polyline").length).toBe(years.length);
    expect(res.overlay.items.some((o) => o.type === "label" && o.text === String(years[0]) && o.style === "box")).toBe(true);
  });

  it("keeps the figure inside the frame and morphs from one layout to another (same items, new targets)", () => {
    const a = arrange("wheel");
    const b = arrange("grid");
    expect(finiteCount(a.arr)).toBe(finiteCount(b.arr));
    let differs = 0;
    for (let i = 0; i < a.arr.length; i++) if (Number.isFinite(a.arr[i]!) && Math.abs(a.arr[i]! - b.arr[i]!) > 1e-3) differs++;
    expect(differs).toBeGreaterThan(0);
    for (const res of [a, b]) for (let i = 0; i < res.arr.length; i += 3) if (Number.isFinite(res.arr[i]!)) expect(Math.hypot(res.arr[i]!, res.arr[i + 1]!, res.arr[i + 2]!)).toBeLessThan(res.camera.radius * 1.5 + 1);
  });

  it("lays any other dimension round one circle or in a square-ish grid, in natural order", () => {
    for (const layout of ["wheel", "grid"] as const) {
      const res = arrange(layout, "source");
      expect(res.overlay.marks.length).toBeGreaterThan(1);
      expect(finiteCount(res.arr)).toBe(finiteCount(arrange("bubbles", "source").arr));
    }
    const month = arrange("grid", "monthOfYear");
    // Calendar month: one row, no year labels.
    const ys = new Set(month.overlay.marks.filter((m) => monthOfKey(m.key)).map((m) => Math.round(((m.bounds.min[1] + m.bounds.max[1]) / 2) * 1000)));
    expect(ys.size).toBe(1);
    const fold = arrange("wheel", "month", true);
    expect(finiteCount(fold.arr)).toBeGreaterThan(0);
  });
});

describe("calendar layouts: month keys only on month dimensions, labels inside the frame", () => {
  const g = (key: string, kind: Group["kind"] = "value"): Group => ({ key, label: key, kind, items: [0], order: 0 });
  it("reads keys as months only for the month dimensions", () => {
    const keys = ["01", "02", "03"].map((k) => g(k));
    // "03" is also an hour, a folder or a label value.
    for (const dim of ["hour", "folder", "weekday", "source"] as const) expect(monthCells(dim, keys)).toBeNull();
    expect(monthCells("monthOfYear", keys)?.cells.map((c) => c.month)).toEqual([1, 2, 3]);
    expect(monthCells("month", [g("2026-01"), g("2026-02"), g("none", "none")])?.rest.length).toBe(1);
    expect(monthCells("month", [g("2026-01"), g("oops")])).toBeNull();
  });

  it("scales the month labels with the frame once (they stay above their columns, on the camera's radius)", () => {
    const labels = (res: ReturnType<typeof arrange>) => res.overlay.items.filter((o): o is Extract<typeof o, { type: "label" }> => o.type === "label" && o.style === "axis");
    const wheel = arrange("wheel");
    expect(labels(wheel)).toHaveLength(12);
    for (const m of labels(wheel)) expect(Math.hypot(m.at[0], m.at[1], m.at[2])).toBeCloseTo(wheel.camera.radius / 1.08, 4);
    const grid = arrange("grid");
    expect(labels(grid)).toHaveLength(12);
    for (const m of labels(grid)) {
      const month = Number(/month-(\d+)/.exec(m.key ?? "")![1]);
      const cell = grid.overlay.marks.find((k) => monthOfKey(k.key)?.month === month)!;
      expect(m.at[0]).toBeCloseTo((cell.bounds.min[0] + cell.bounds.max[0]) / 2, 4);
    }
  });
});

describe("group overlay labels", () => {
  it("keeps every calendar label and only the largest group names", () => {
    const marks = Array.from({ length: 10 }, (_, i) => ({ key: `g${i}`, label: `g${i}`, count: 10 - i, bounds: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] } }));
    const items = [
      ...marks.map((m) => ({ type: "label" as const, at: [0, 0, 0] as [number, number, number], text: m.label, style: "box" as const, key: m.key })),
      { type: "label" as const, at: [0, 0, 0] as [number, number, number], text: "Jan", style: "axis" as const, key: "month-1" },
      { type: "line" as const, a: [0, 0, 0] as [number, number, number], b: [1, 0, 0] as [number, number, number], alpha: 0.1 },
    ];
    const picked = pickGroupLabels({ items, marks } as never, 3);
    expect(picked.map((l) => l.text)).toEqual(["g0", "g1", "g2", "Jan"]);
  });
});

describe("group overlay labels are clickable", () => {
  type Label = Parameters<typeof groupLabelTarget>[0];
  const label = (text: string, key?: string, style: Label["style"] = "box"): Label => ({ type: "label", at: [0, 0, 0], text, style, ...(key !== undefined ? { key } : {}) });
  const marks = [{ key: "garden" }, { key: "2024-03" }];
  it("a placed group traces its own key in the group-by dimension, like its legend chip", () => {
    const t = groupLabelTarget(label("Garden", "garden"), marks, "space", null);
    expect(t?.dim).toBe("space");
    expect(t?.row.key).toBe("garden");
    expect(t?.row.name).toBe("Garden");
    expect(groupLabelPreviewKey(t!)).toBe("space=garden");
  });
  it("uses the legend's own row when the colour key lists the group", () => {
    const row = { key: "garden", name: "The garden", slot: 1, bucket: "value" as const, rgb: [1, 2, 3] as [number, number, number], notes: 4, record: 5, hidden: false, depth: 0, expandable: false };
    const t = groupLabelTarget(label("Garden", "garden"), marks, "space", { grandTotal: 9, sections: [{ population: "both", dim: "space", rows: [row], total: 9 }] });
    expect(t?.row).toBe(row);
  });
  it("a year box of the month layouts stands for the year row; month names and unkeyed labels are plain text", () => {
    const year = groupLabelTarget(label("2024", "2024"), marks, "month", null);
    expect(year?.row.aggregate).toBe(true);
    expect(groupLabelPreviewKey(year!)).toBe(`${dateDim("year", parseDateDim("month")!.basis)}=2024`);
    expect(groupLabelTarget(label("Mar", "month-3", "axis"), marks, "month", null)).toBeNull();
    expect(groupLabelTarget(label("Title"), marks, "space", null)).toBeNull();
    expect(groupLabelTarget(label("", "garden"), marks, "space", null)).toBeNull();
    // A four-digit group key that is not a month tree's year stays a plain group when it is a placed mark.
    expect(groupLabelTarget(label("2024", "2024"), [{ key: "2024" }], "space", null)?.row.aggregate).toBeUndefined();
    expect(groupLabelTarget(label("2024", "2024"), marks, "space", null)).toBeNull();
  });
  it("every label of a real calendar arrangement resolves or is deliberately plain", () => {
    const res = arrange("wheel", "month");
    const labels = res.overlay.items.filter((i): i is Label => i.type === "label");
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) {
      const t = groupLabelTarget(l, res.overlay.marks, "month", null);
      if (l.key?.startsWith("month-")) expect(t).toBeNull();
      else if (/^\d{4}$/.test(l.key ?? "")) expect(t?.row.aggregate).toBe(true);
    }
  });
});

describe("bundles between group spheres", () => {
  it("counts each note link that crosses between two groups once", () => {
    // The sample's links stay inside one area, so area groups have none; kinds and layers cross.
    const res = arrange("bubbles", "kind");
    // The kind grouping also reports hub-apex bundles (flagged `apex`); the link bundles are the rest.
    const bundles = (res.bundles ?? []).filter((b) => b.apex !== true);
    expect(bundles.length).toBeGreaterThan(0);
    expect(bundles.length).toBeLessThanOrEqual(MAX_BUNDLES);
    expect(bundles[0]!.weight).toBe(1);
    for (let i = 1; i < bundles.length; i++) expect(bundles[i]!.links).toBeLessThanOrEqual(bundles[i - 1]!.links);
    // Brute force over the undirected note links, by the kind each end has.
    const dv = readDim(index, "kind", Array.from({ length: index.count }, (_, i) => i));
    const cross = new Map<string, number>();
    const { offsets, targets } = index.rel.noteLinks;
    for (let o = 0; o < index.count; o++) {
      for (let k = offsets[o]!; k < offsets[o + 1]!; k++) {
        const t = targets[k]!;
        if (t <= o || dv.codes[o] === NO_CODE || dv.codes[t] === NO_CODE || dv.codes[o] === dv.codes[t]) continue;
        const key = [dv.codes[o]!, dv.codes[t]!].sort((x, y) => x - y).join("|");
        cross.set(key, (cross.get(key) ?? 0) + 1);
      }
    }
    const want = [...cross.values()].sort((x, y) => y - x).slice(0, bundles.length);
    expect(bundles.map((b) => b.links)).toEqual(want);
  });

  it("reports centres and radii of real spheres, and none when nothing links across", () => {
    const res = arrange("grid");
    expect((res.bundles ?? []).length).toBeGreaterThan(0);
    expect(res.bundles!.length).toBeLessThanOrEqual(MAX_BUNDLES);
    for (const b of res.bundles ?? []) {
      expect(b.ra).toBeGreaterThan(0);
      expect(b.rb).toBeGreaterThan(0);
      expect(b.weight).toBeGreaterThan(0);
      expect(b.weight).toBeLessThanOrEqual(1);
      for (const v of [...b.a, ...b.b]) expect(Number.isFinite(v)).toBe(true);
    }
    expect(groupBundles(index, [])).toEqual([]);
    const one = [{ key: "x", label: "x", count: 1, centre: [0, 0, 0] as [number, number, number], radius: 1, hollow: true, items: [0, 1, 2] }];
    expect(groupBundles(index, one)).toEqual([]);
  });

  const bundle = (weight: number, a: [number, number, number] = [0, 0, 0], b: [number, number, number] = [5, 0, 0]): GroupBundle => ({ a, b, ra: 1, rb: 1, links: Math.round(weight * 10), weight });

  it("draws more fibres for heavier bundles, and more again for Lines: All", () => {
    expect(fibreCount(0, "selection")).toBe(2);
    expect(fibreCount(1, "selection")).toBe(14);
    expect(fibreCount(0.25, "selection")).toBeLessThan(fibreCount(1, "selection"));
    expect(fibreCount(1, "all")).toBeGreaterThan(fibreCount(1, "selection"));
    expect(fibreCount(1, "all")).toBeLessThanOrEqual(24);
    expect(fibreCount(Number.NaN, "selection")).toBe(2);
  });

  it("builds deterministic curved fibres that run from one sphere to the other", () => {
    const list = [bundle(1), bundle(0.2, [0, 4, 0], [0, 9, 3])];
    const f = bundleFibres(list, "selection");
    expect(f.fibres).toEqual([fibreCount(1, "selection"), fibreCount(0.2, "selection")]);
    expect(f.segments).toBe((f.fibres[0]! + f.fibres[1]!) * FIBRE_STEPS);
    expect(f.positions.length).toBe(f.segments * 6);
    expect(f.t.length).toBe(f.segments * 2);
    expect(f.colors.length).toBe(f.segments * 8);
    for (const v of f.positions) expect(Number.isFinite(v)).toBe(true);
    // The first fibre starts near sphere A (x ≈ 0.8 of the radius toward B) and ends near sphere B.
    expect(f.positions[0]).toBeGreaterThan(0);
    expect(f.positions[0]).toBeLessThan(2);
    const last = (f.fibres[0]! * FIBRE_STEPS - 1) * 6 + 3;
    expect(f.positions[last]).toBeGreaterThan(3);
    expect(f.positions[last]).toBeLessThan(5);
    // Draw-on runs 0 → 1 along each fibre; the heavy bundle is brighter.
    expect(f.t[0]).toBe(0);
    expect(f.t[(FIBRE_STEPS - 1) * 2 + 1]).toBe(1);
    expect(f.colors[3]).toBeGreaterThan(f.colors[(f.fibres[0]! * FIBRE_STEPS) * 8 + 3]!);
    const again = bundleFibres(list, "selection");
    expect(Array.from(again.positions)).toEqual(Array.from(f.positions));
    expect(bundleFibres(list, "all").segments).toBeGreaterThan(f.segments);
  });

  it("draws nothing for no bundles or for spheres on top of each other", () => {
    expect(bundleFibres([], "selection").segments).toBe(0);
    expect(bundleFibres([bundle(1, [1, 1, 1], [1, 1, 1])], "all").segments).toBe(0);
  });
});

describe("radial clock: calendar month sectors", () => {
  it("lays out twelve sectors with month names and a mark per sector and ring", () => {
    const res = runChart(
      index,
      { chart: "radial-clock", x: { dim: "monthOfYear", sort: "date" }, y: { dim: "space", sort: "count" }, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options: {} },
      vis,
      { now: NOW },
    );
    expect(finiteCount(res.arr)).toBeGreaterThan(0);
    const names = res.overlay.items.filter((o) => o.type === "label" && o.style === "axis").map((o) => (o.type === "label" ? o.text : ""));
    for (const m of ["Jan", "Jun", "Dec"]) expect(names).toContain(m);
    for (const m of res.overlay.marks) expect(m.key).toContain("monthOfYear");
    expect((res.readings ?? []).length).toBeGreaterThan(0);
  });
});
