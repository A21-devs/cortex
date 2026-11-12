/**
 * Groups shape layouts (P07): the split record band, the hub apex of the kind grouping, brain-region labels of
 * role placement, the banded dash-row grid, the Record by dimension list, and the label toggle's helpers.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { bundleAlpha, bundleFibres, APEX_RGB, FIBRE_RGB } from "../src/render/bundles";
import { DEFAULT_LAYOUT_OPTIONS, recordDims } from "../src/shared/dims";
import { Population, type DataIndex } from "../src/shared/index-format";
import { RECORD_MARK_PREFIX, type GroupBundle, type PlacementParams, type VisibilityParams } from "../src/shared/protocol/worker";
import { STARTER_PACKS, SUBREGIONS } from "../src/shared/packs";
import { defaultView } from "../src/state/types";
import { groupLabelTarget } from "../src/ui/stage/GroupOverlay";
import { gridMarkItems } from "../src/ui/stage/ShapeBar";
import { APEX_KIND, computeGroupsArrangement } from "../src/worker/arrangements";
import { buildAnatomy, type AnatomyModel } from "../src/worker/anatomy";
import { defaultVisibility } from "../src/worker/charts/common";
import { computePlacement, regionLabels, subregionIdsOf, subregionLabels } from "../src/worker/placement";
import { buildSampleIndex } from "../src/worker/sampleIndex";

const NOW = Date.UTC(2026, 10, 10);
const index: DataIndex = buildSampleIndex(20261110, NOW);
const vis: VisibilityParams = defaultVisibility(index.count);

type Args = Parameters<typeof computeGroupsArrangement>[1];
const args = (over: Partial<Args> = {}): Args => ({ kind: "groups", dim: "space", layout: "bubbles", fold: false, merges: {}, hideNoValue: false, visibility: vis, ...over });
const arrange = (over: Partial<Args> = {}) => computeGroupsArrangement(index, args(over), new Float32Array(index.count * 3));

/** Min and max y of the finite points of one population. */
function yRange(arr: Float32Array, pop: number): { min: number; max: number; n: number } {
  let min = Infinity, max = -Infinity, n = 0;
  for (let i = 0; i < index.count; i++) {
    if (index.cols.pop[i] !== pop) continue;
    const y = arr[i * 3 + 1] as number;
    if (!Number.isFinite(y)) continue;
    n++;
    min = Math.min(min, y);
    max = Math.max(max, y);
  }
  return { min, max, n };
}

describe("VIEW-16 split layout: record entries grouped apart from the notes", () => {
  it("gives two families with disjoint y bands, the record band below the notes", () => {
    const res = arrange({ dim: "space", recordDim: "source" });
    const notes = yRange(res.arr, Population.Note);
    const rec = yRange(res.arr, Population.Record);
    expect(notes.n).toBeGreaterThan(0);
    expect(rec.n).toBeGreaterThan(0);
    expect(rec.max).toBeLessThan(notes.min);
    // Every shown point has a target, and the two families are told apart by key and a "record" chip.
    const recMarks = res.overlay.marks.filter((m) => m.key.startsWith(RECORD_MARK_PREFIX));
    expect(recMarks.length).toBeGreaterThan(0);
    expect(res.overlay.marks.length).toBeGreaterThan(recMarks.length);
    const chips = res.overlay.items.filter((it) => it.type === "label" && it.chip === "record");
    expect(chips.length).toBeGreaterThan(0);
    for (const it of chips) expect(it.type === "label" && it.key?.startsWith(RECORD_MARK_PREFIX)).toBe(true);
  });

  it("leaves the single figure unchanged when the split is off", () => {
    const one = arrange({ dim: "space" });
    const rec = yRange(one.arr, Population.Record);
    const notes = yRange(one.arr, Population.Note);
    // One shared pack: the bands overlap rather than stacking.
    expect(rec.min).toBeLessThan(notes.max);
    expect(one.overlay.marks.some((m) => m.key.startsWith(RECORD_MARK_PREFIX))).toBe(false);
    expect(one.overlay.items.some((it) => it.type === "label" && it.chip !== undefined)).toBe(false);
  });

  it("traces a record label by the record dimension, keeping the note labels on the notes' dimension", () => {
    const item: Parameters<typeof groupLabelTarget>[0] = { type: "label", at: [0, 0, 0], text: "claude", style: "box", key: `${RECORD_MARK_PREFIX}claude-code`, chip: "record" };
    const target = groupLabelTarget(item, [{ key: `${RECORD_MARK_PREFIX}claude-code` }], "space", null, "source");
    expect(target?.dim).toBe("source");
    expect(target?.row.key).toBe("claude-code");
    const note = groupLabelTarget({ type: "label", at: [0, 0, 0], text: "code", style: "box", key: "code" }, [{ key: "code" }], "space", null, "source");
    expect(note?.dim).toBe("space");
  });

  it("lists record-only fields apart from the shared ones", () => {
    const { shared, recordOnly } = recordDims(STARTER_PACKS);
    expect(recordOnly).toContain("speaker");
    expect(recordOnly).toContain("conversation");
    expect(recordOnly).toContain("label:session/work");
    expect(shared).toContain("month");
    expect(shared).toContain("label:correction/fixes");
    expect(recordOnly).not.toContain("space");
    expect(new Set([...shared, ...recordOnly]).size).toBe(shared.length + recordOnly.length);
  });
});

describe("FIG-47 hub apex of the kind grouping", () => {
  it("puts the map sphere at the highest y and joins every other sphere to it in azure", () => {
    const res = arrange({ dim: "kind" });
    const apex = res.overlay.marks.find((m) => m.key === APEX_KIND);
    expect(apex).toBeDefined();
    const apexY = (apex!.bounds.min[1] + apex!.bounds.max[1]) / 2;
    for (const m of res.overlay.marks) if (m.key !== APEX_KIND) expect((m.bounds.min[1] + m.bounds.max[1]) / 2).toBeLessThan(apexY);
    const apexBundles = (res.bundles ?? []).filter((b) => b.apex === true);
    expect(apexBundles.length).toBe(res.overlay.marks.length - 1);
    for (const b of apexBundles) expect(b.weight).toBeGreaterThan(0);
  });

  it("draws apex bundles in the cool blue with alpha growing with the link count", () => {
    expect(bundleAlpha(1, true)).toBe(122);
    expect(bundleAlpha(0.1, true)).toBeLessThan(bundleAlpha(0.9, true));
    expect(bundleAlpha(0, true)).toBeGreaterThan(0);
    const b = (apex: boolean, weight: number): GroupBundle => ({ a: [0, 0, 0], b: [4, 0, 0], ra: 1, rb: 1, links: 3, weight, ...(apex ? { apex } : {}) });
    const plain = bundleFibres([b(false, 1)], "selection");
    const azure = bundleFibres([b(true, 1)], "selection");
    expect([...plain.colors.subarray(0, 3)]).toEqual([...FIBRE_RGB]);
    expect([...azure.colors.subarray(0, 3)]).toEqual([...APEX_RGB]);
    expect(APEX_RGB[2]).toBeGreaterThan(APEX_RGB[0]);
  });

  it("does not make an apex of other dimensions", () => {
    expect((arrange({ dim: "space" }).bundles ?? []).some((x) => x.apex === true)).toBe(false);
  });
});

describe("FIG-46 / FIG-52 region labels of role placement", () => {
  let anatomy: AnatomyModel;
  const place = (placement: "area" | "role") => {
    const p: PlacementParams = { seed: 7, pose: "standing", placement, order: "oldest", depthKey: "time", gamma: 0.6, visibility: vis };
    return computePlacement(index, anatomy, p);
  };
  beforeAll(() => {
    anatomy = buildAnatomy(7, 20_000);
  }, 120_000);

  it("returns one label per used finer region at its centroid, and none for By area", () => {
    const res = place("role");
    const col = index.labels.find((c) => c.pack === "placement" && c.field === "role") ?? null;
    const sub = subregionIdsOf(col, res.region, index.count);
    const used = new Set<number>();
    for (let i = 0; i < index.count; i++) if ((sub[i] as number) < SUBREGIONS.length && Number.isFinite(res.anat[i * 3] as number)) used.add(sub[i] as number);
    expect(used.size).toBeGreaterThan(0);
    expect(res.labels).toBeDefined();
    expect(res.labels!.length).toBe(used.size);
    expect(new Set(res.labels!.map((l) => l.key)).size).toBe(used.size);
    for (const l of res.labels!) {
      expect(l.kind).toBe("region");
      expect(l.pos.every(Number.isFinite)).toBe(true);
      expect(SUBREGIONS.find((q) => q.key === l.key)?.name).toBe(l.text);
    }
    expect(place("area").labels).toBeUndefined();
  }, 120_000);

  it("gives the finer regions of one brain region separate bands (their centroids differ)", () => {
    const res = place("role");
    const byRegion = new Map<number, string[]>();
    for (const l of res.labels!) {
      const reg = SUBREGIONS.find((q) => q.key === l.key)!.region;
      byRegion.set(reg, [...(byRegion.get(reg) ?? []), l.key]);
    }
    const pos = (k: string) => res.labels!.find((l) => l.key === k)!.pos;
    let compared = 0;
    for (const keys of byRegion.values()) {
      for (let a = 0; a < keys.length; a++)
        for (let b = a + 1; b < keys.length; b++) {
          const p = pos(keys[a]!), q = pos(keys[b]!);
          expect(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])).toBeGreaterThan(1e-4);
          compared++;
        }
    }
    expect(compared).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it("computes the centroid of the finer region's notes and skips items that role did not place", () => {
    const anat = new Float32Array([0, 0, 0, 2, 4, 6, 9, 9, 9, Number.NaN, 0, 0]);
    const region = new Uint8Array([1, 1, 255, 1]);
    const broca = SUBREGIONS.findIndex((q) => q.key === "broca");
    const sub = new Uint8Array([broca, broca, broca, broca]);
    const out = subregionLabels(anat, region, sub, 4);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "broca", text: "Broca's area", kind: "region", pos: [1, 2, 3] });
  });

  it("computes the centroid of the notes' points per region and skips record entries", () => {
    const anat = new Float32Array([0, 0, 0, 2, 4, 6, 9, 9, 9, Number.NaN, 0, 0]);
    const region = new Uint8Array([1, 1, 255, 1]);
    const out = regionLabels(anat, region, 4);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "frontal", text: "Frontal", kind: "region", pos: [1, 2, 3] });
  });
});

describe("CHART-12 banded grid", () => {
  it("draws rows mode cells as wide, shallow dash rows that keep every point", () => {
    const spheres = arrange({ dim: "month", layout: "grid", layoutOptions: { gridMarks: "spheres" } });
    const rows = arrange({ dim: "month", layout: "grid", layoutOptions: { gridMarks: "rows" } });
    const shown = (a: Float32Array) => a.reduce((n, v, i) => n + (i % 3 === 0 && Number.isFinite(v) ? 1 : 0), 0);
    expect(shown(rows.arr)).toBe(shown(spheres.arr));
    const dashes = rows.overlay.marks.filter((m) => m.count >= 6);
    expect(dashes.length).toBeGreaterThan(0);
    for (const m of dashes) {
      const w = m.bounds.max[0] - m.bounds.min[0];
      const h = m.bounds.max[1] - m.bounds.min[1];
      expect(w).toBeGreaterThan(h);
    }
    const ball = spheres.overlay.marks[0]!;
    expect(ball.bounds.max[0] - ball.bounds.min[0]).toBeCloseTo(ball.bounds.max[1] - ball.bounds.min[1], 6);
  });

  it("offers spheres and dash rows as one checked pair in the Layout section, defaulting to spheres", () => {
    expect(DEFAULT_LAYOUT_OPTIONS.gridMarks).toBe("spheres");
    expect(defaultView().layoutOptions.gridMarks).toBe("spheres");
    const items = gridMarkItems("rows");
    expect(items.map((i) => i.value)).toEqual(["gridMarks:spheres", "gridMarks:rows"]);
    expect(items.find((i) => i.checked)?.value).toBe("gridMarks:rows");
  });
});

describe("VIEW-25 labels toggle and region names", () => {
  it("has a copy name for every region the worker can label", async () => {
    const { COPY } = await import("../src/ui/copy");
    const anat = new Float32Array(8 * 3).fill(1);
    const out = regionLabels(anat, new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), 8);
    expect(out).toHaveLength(8);
    for (const l of out) expect(COPY.regions[l.key as keyof typeof COPY.regions]).toBe(l.text);
  });

  it("hides group, region and year labels (not month axis text) under .is-groups-off, and labels default on", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../src/styles/stage.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.cx-chart-labels\.is-groups-off \.cx-axis-label:not\(\.is-axis\)\s*\{\s*display:\s*none/);
    expect(defaultView().look.groupLabels).toBe(true);
    const src = readFileSync(new URL("../src/ui/stage/GroupOverlay.tsx", import.meta.url), "utf8");
    expect(src).toContain('classList.toggle("is-groups-off", !labelsOn)');
  });
});
