/**
 * P23 figure forms: the map-type rail (FIG-44), the role comet (FIG-46), the kind apex and its T under an area
 * (FIG-47), the bundle forms that draw them, and the résumé-item dimension (TB-06).
 */
import { describe, expect, it } from "vitest";
import { BEAM_RGB, APEX_RGB, bundleFibres, formAlpha, formFibreCount } from "../src/render/bundles";
import { SWAY } from "../src/render/controller";
import { BUILTIN_DIMS, DIM_GROUP_ORDER, builtinDim, noneNameOf, RESUME_DIM, ROLE_DIM } from "../src/shared/dims";
import type { DataIndex } from "../src/shared/index-format";
import { findPack, RESUME_PACK, STARTER_PACKS } from "../src/shared/packs";
import type { GroupBundle, VisibilityParams } from "../src/shared/protocol/worker";
import { COPY } from "../src/ui/copy";
import { dimMenuModel } from "../src/ui/primitives/dimMenu";
import { dimLabel } from "../src/ui/valueLabels";
import { APEX_KIND, computeGroupsArrangement } from "../src/worker/arrangements";
import { NO_CODE, defaultVisibility, readDim } from "../src/worker/charts/common";
import { cometLabelAt, cometLayout, railLayout, tLayout } from "../src/worker/forms";
import { buildSampleIndex } from "../src/worker/sampleIndex";
import { labelOutputSchema } from "../src/agents/schemas";
import { validateLabelOutput } from "../src/agents/validators";

const NOW = Date.UTC(2026, 10, 10);
const index: DataIndex = buildSampleIndex(20261110, NOW);
const vis: VisibilityParams = defaultVisibility(index.count);
type Args = Parameters<typeof computeGroupsArrangement>[1];
const args = (over: Partial<Args> = {}): Args => ({ kind: "groups", dim: "space", layout: "bubbles", fold: false, merges: {}, hideNoValue: false, visibility: vis, ...over });
const arrange = (over: Partial<Args> = {}) => computeGroupsArrangement(index, args(over), new Float32Array(index.count * 3));
const midY = (m: { bounds: { min: number[]; max: number[] } }): number => ((m.bounds.min[1] as number) + (m.bounds.max[1] as number)) / 2;
const midX = (m: { bounds: { min: number[]; max: number[] } }): number => ((m.bounds.min[0] as number) + (m.bounds.max[0] as number)) / 2;

describe("forms geometry", () => {
  it("rail: maps in a row above the base, a beam over the row and a cone from each map to the base", () => {
    const lay = railLayout([
      { r: 0.6, role: "map" },
      { r: 0.5, role: "map" },
      { r: 0.4, role: "map" },
      { r: 5, role: "base" },
    ])!;
    expect(lay).not.toBeNull();
    const ys = lay.centres.slice(0, 3).map((c) => c[1]);
    expect(new Set(ys).size).toBe(1);
    expect(ys[0]).toBeGreaterThan(lay.centres[3]![1] + 5);
    const xs = lay.centres.slice(0, 3).map((c) => c[0]);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(lay.bundles.filter((b) => b.form === "beam")).toHaveLength(1);
    const cones = lay.bundles.filter((b) => b.form === "cone");
    expect(cones).toHaveLength(3);
    for (const c of cones) expect(c.rb).toBe(5);
    const beam = lay.bundles.find((b) => b.form === "beam")!;
    expect(beam.a[1]).toBe(ys[0]);
    expect(beam.a[0]).toBeLessThan(xs[0]!);
    expect(beam.b[0]).toBeGreaterThan(xs[2]!);
  });

  it("rail: no map type or no base gives no rail", () => {
    expect(railLayout([{ r: 5, role: "base" }])).toBeNull();
    expect(railLayout([{ r: 1, role: "map" }])).toBeNull();
  });

  it("T: the bar runs across at one height, the apex hangs under its middle on a stem", () => {
    const lay = tLayout([3, 2, 1.5, 0.5], 3);
    const bar = lay.centres.slice(0, 3);
    expect(new Set(bar.map((c) => c[1])).size).toBe(1);
    expect(lay.centres[3]![0]).toBeCloseTo(0, 6);
    expect(lay.centres[3]![1]).toBeLessThan(-3);
    expect(Math.min(...bar.map((c) => c[0]))).toBeLessThan(0);
    expect(Math.max(...bar.map((c) => c[0]))).toBeGreaterThan(0);
    expect(lay.bundles.every((b) => b.form === "beam")).toBe(true);
    expect(lay.bundles.length).toBe(2);
  });

  it("comet: head first, tapering tail, centred, and standing swaps the axes", () => {
    const sph = [4, 3, 3, 2, 1].map((r, i) => ({ r, region: i }));
    const lay = cometLayout(sph, "horizontal");
    const xs = lay.centres.map((c) => c[0]);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(lay.radii[0]).toBe(4);
    expect(lay.radii[4]!).toBeLessThan(1);
    expect(lay.radii[4]!).toBeGreaterThan(0.5);
    const cx = (Math.min(...lay.centres.map((c, i) => c[0] - lay.radii[i]!)) + Math.max(...lay.centres.map((c, i) => c[0] + lay.radii[i]!))) / 2;
    expect(cx).toBeCloseTo(0, 6);
    const up = cometLayout(sph, "vertical");
    const ys = up.centres.map((c) => c[1]);
    expect(ys).toEqual([...ys].sort((a, b) => b - a));
    expect(up.centres[0]![1]).toBeGreaterThan(0);
    expect(lay.bundles).toHaveLength(4);
    for (const b of lay.bundles) expect(b.form).toBe("cone");
  });

  it("comet: a region name sits above the clusters lying and beside them standing", () => {
    const members = [{ c: [0, 0, 0] as [number, number, number], r: 2 }, { c: [5, 0, 0] as [number, number, number], r: 1 }];
    const lying = cometLabelAt(members, "horizontal");
    expect(lying.at[1]).toBeGreaterThan(2);
    expect(lying.align).toBe("center");
    const standing = cometLabelAt(members, "vertical");
    expect(standing.at[0]).toBeLessThan(-2);
    expect(standing.align).toBe("right");
  });
});

describe("FIG-44 map-type rail in the arrangement", () => {
  const res = arrange({ dim: "hubType" });
  it("draws a beam and a cone per map type, and puts the maps above the non-maps", () => {
    const beams = (res.bundles ?? []).filter((b) => b.form === "beam");
    const cones = (res.bundles ?? []).filter((b) => b.form === "cone");
    expect(beams).toHaveLength(1);
    expect(cones.length).toBeGreaterThan(0);
    const base = res.overlay.marks.find((m) => m.key === "none")!;
    expect(base).toBeDefined();
    for (const key of ["project", "area", "topic"]) {
      const m = res.overlay.marks.find((x) => x.key === key);
      if (m) expect(midY(m)).toBeGreaterThan(midY(base));
    }
    // The cones all open over the base sphere.
    const bc = [(base.bounds.min[0] + base.bounds.max[0]) / 2, midY(base)];
    for (const c of cones) {
      expect(c.b[0]).toBeCloseTo(bc[0] as number, 4);
      expect(c.b[1]).toBeCloseTo(bc[1] as number, 4);
    }
    expect(res.sway).toBeUndefined();
  });
  it("is the same morph target for every point a plain bubbles pack would place", () => {
    const placed = (arr: Float32Array) => arr.reduce((n, v, i) => (i % 3 === 0 && Number.isFinite(v) ? n + 1 : n), 0);
    expect(placed(res.arr)).toBe(placed(arrange({ dim: "space" }).arr));
  });
  it("keeps the beams when only the layout is not bubbles (a form is a bubbles-layout thing)", () => {
    expect((arrange({ dim: "hubType", layout: "strata" }).bundles ?? []).some((b) => b.form === "beam")).toBe(false);
  });
});

describe("FIG-47 kind apex and the T under an area", () => {
  it("keeps the apex above the other kinds with no area chosen", () => {
    const r = arrange({ dim: "kind" });
    const apex = r.overlay.marks.find((m) => m.key === APEX_KIND)!;
    for (const m of r.overlay.marks) if (m.key !== APEX_KIND) expect(midY(m)).toBeLessThan(midY(apex));
    expect((r.bundles ?? []).some((b) => b.form === "beam")).toBe(false);
  });
  it("takes the T when an area is chosen: the kinds in a bar, the apex under its middle on a beamed stem", () => {
    const scopes = ["code", "web", "data", "ai", "life", "vault", "design"] as const;
    let found = 0;
    for (const scope of scopes) {
      const r = arrange({ dim: "kind", visibility: { ...vis, scope } });
      const apex = r.overlay.marks.find((m) => m.key === APEX_KIND);
      if (!apex || r.overlay.marks.length < 3) continue;
      found++;
      const bar = r.overlay.marks.filter((m) => m.key !== APEX_KIND);
      expect(new Set(bar.map((m) => Math.round(midY(m) * 1e4))).size).toBe(1);
      expect(midY(apex)).toBeLessThan(midY(bar[0] as never));
      expect(Math.abs(midX(apex))).toBeLessThan(1e-3 + Math.max(...bar.map((m) => Math.abs(midX(m)))));
      const beams = (r.bundles ?? []).filter((b) => b.form === "beam");
      expect(beams.length).toBeGreaterThanOrEqual(1);
      expect((r.bundles ?? []).filter((b) => b.apex === true).length).toBe(r.overlay.marks.length - 1);
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe("FIG-46 role comet", () => {
  const r = arrange({ dim: ROLE_DIM });
  it("asks the stage to sway, names each used brain region once and draws strands as cones", () => {
    expect(r.sway).toBe(true);
    const names = r.overlay.items.filter((it) => it.type === "label" && it.key?.startsWith("region:"));
    expect(names.length).toBeGreaterThan(0);
    const texts = names.map((it) => (it.type === "label" ? it.text : ""));
    expect(new Set(texts).size).toBe(texts.length);
    for (const t of texts) expect(["Prefrontal", "Frontal", "Parietal", "Occipital", "Temporal", "Limbic", "Cerebellum", "Brainstem"]).toContain(t);
    expect(texts.join(" ")).not.toMatch(/brain regions/i);
    expect((r.bundles ?? []).some((b) => b.form === "cone")).toBe(true);
    // The role clusters keep their own marks (hover and tracing) but carry no label of their own.
    expect(r.overlay.marks.length).toBeGreaterThan(1);
    expect(r.overlay.items.some((it) => it.type === "label" && !it.key?.startsWith("region:") && r.overlay.marks.some((m) => m.key === it.key))).toBe(false);
  });
  it("lies along x and stands along y", () => {
    const spread = (res: ReturnType<typeof arrange>, k: 0 | 1) => {
      const v = res.overlay.marks.map((m) => (m.bounds.min[k] + m.bounds.max[k]) / 2);
      return Math.max(...v) - Math.min(...v);
    };
    const lying = arrange({ dim: ROLE_DIM, orientation: "horizontal" });
    const standing = arrange({ dim: ROLE_DIM, orientation: "vertical" });
    expect(spread(lying, 0)).toBeGreaterThan(spread(lying, 1));
    expect(spread(standing, 1)).toBeGreaterThan(spread(standing, 0));
    expect(lying.camera.radius).toBeCloseTo(standing.camera.radius, 0);
  });
  it("sways a bounded number of times so the render loop can rest", () => {
    expect(SWAY.flips).toBeGreaterThan(0);
    expect(SWAY.flips).toBeLessThan(20);
    expect(SWAY.morphMs).toBeLessThan(SWAY.holdMs);
  });
  it("does not sway other groupings", () => {
    expect(arrange({ dim: "space" }).sway).toBeUndefined();
  });
});

describe("bundle forms", () => {
  const b = (form: GroupBundle["form"], weight = 1): GroupBundle => ({ a: [0, 0, 0], b: [10, 0, 0], ra: 1, rb: 4, links: 0, weight, ...(form ? { form } : {}) });
  it("a cone is narrow at a and wide at b, a beam is bright and straight", () => {
    const cone = bundleFibres([b("cone")], "selection");
    const steps = 8;
    const perFibre = steps * 6;
    const n = cone.fibres[0]!;
    const spread = (end: "first" | "last") => {
      let lo = Infinity, hi = -Infinity;
      for (let f = 0; f < n; f++) {
        const o = f * perFibre + (end === "first" ? 1 : perFibre - 2);
        const y = cone.positions[o]!;
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
      return hi - lo;
    };
    expect(spread("last")).toBeGreaterThan(spread("first") * 3);
    expect([...cone.colors.subarray(0, 3)]).toEqual([...APEX_RGB]);
    const beam = bundleFibres([b("beam")], "selection");
    expect([...beam.colors.subarray(0, 3)]).toEqual([...BEAM_RGB]);
    expect(beam.colors[3]).toBe(255);
    // A beam runs from one end to the other.
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < beam.segments * 2; i++) {
      minX = Math.min(minX, beam.positions[i * 3]!);
      maxX = Math.max(maxX, beam.positions[i * 3]!);
    }
    expect(minX).toBeCloseTo(0, 3);
    expect(maxX).toBeCloseTo(10, 3);
  });
  it("counts and alphas stay in range", () => {
    expect(formFibreCount(1, "cone", "selection")).toBeGreaterThan(formFibreCount(0, "cone", "selection"));
    expect(formFibreCount(1, "cone", "all")).toBeGreaterThan(formFibreCount(1, "cone", "selection"));
    expect(formFibreCount(1, "cone", "all")).toBeLessThanOrEqual(48);
    expect(formAlpha(1, "beam")).toBe(255);
    expect(formAlpha(0, "cone")).toBeGreaterThan(0);
    expect(formAlpha(1, "cone")).toBeLessThan(formAlpha(0, "beam"));
  });
  it("a plain bundle is unchanged by the form support", () => {
    const plain = bundleFibres([b(undefined)], "selection");
    expect(plain.fibres[0]).toBeGreaterThan(1);
    expect([...plain.colors.subarray(0, 3)]).not.toEqual([...BEAM_RGB]);
  });
});

describe("TB-06 résumé item and the other dimensions", () => {
  it("is a model pack field the agents can fill, with a schema and a validator", async () => {
    expect(findPack("resume")).toBe(RESUME_PACK);
    expect(STARTER_PACKS).toContain(RESUME_PACK);
    expect(RESUME_PACK.writer).toBe("model");
    const key = "resume.item";
    const schema = labelOutputSchema([RESUME_PACK]);
    expect(JSON.stringify(schema)).toContain(key);
    const ok = await validateLabelOutput(
      { items: [{ target: "n_aaaaaaaaaaaaaaaa", reason: "Shows the payments migration.", fields: { [key]: { value: "payments migration", state: "set", confidence: 0.8 } } }] },
      [RESUME_PACK],
      { allowedIds: new Set(["n_aaaaaaaaaaaaaaaa"]), citedIds: new Set(), userOwned: new Set(), commentIds: new Set() } as never,
    );
    expect(ok.valid).toBe(true);
    expect(ok.labels).toHaveLength(1);
    expect(ok.labels[0]).toMatchObject({ pack: "resume", field: "item", value: "payments migration", state: "set" });
    // A value that is not text of the right shape is refused at the schema.
    const bad = await validateLabelOutput({ items: [{ target: "n_aaaaaaaaaaaaaaaa", reason: "x", fields: { [key]: { value: 12, state: "set" } } }] }, [RESUME_PACK], { allowedIds: new Set(["n_aaaaaaaaaaaaaaaa"]), citedIds: new Set(), userOwned: new Set(), commentIds: new Set() } as never);
    expect(bad.valid).toBe(false);
  });
  it("is listed under Your résumé in the dimension menu even with the pack off", () => {
    expect(DIM_GROUP_ORDER).toContain("resume");
    const model = dimMenuModel([]);
    const sec = model.sections.find((s) => s.group === "resume")!;
    expect(sec.label).toBe("Your résumé");
    expect(sec.items).toEqual([{ id: RESUME_DIM, label: "Résumé item" }]);
    // And never twice: the agents section does not repeat it when the pack is on.
    const on = dimMenuModel(STARTER_PACKS);
    expect(on.sections.find((s) => s.group === "agents")!.items.some((i) => i.id === RESUME_DIM)).toBe(false);
    expect(dimLabel(RESUME_DIM)).toBe("Résumé item");
  });
  it("reads as No value for every item when nothing has been written", () => {
    expect(noneNameOf(RESUME_DIM)).toBe("noValue");
    expect(COPY.dims.noValue).toBe("No value");
    const items = Array.from({ length: Math.min(50, index.count) }, (_, i) => i);
    const dv = readDim(index, RESUME_DIM, items);
    expect(items.every((o) => dv.codes[o] === NO_CODE)).toBe(true);
    const r = arrange({ dim: RESUME_DIM });
    expect(r.overlay.marks).toHaveLength(1);
    expect(r.overlay.marks[0]!.label).toBe("No value");
  });
  it("reads written values", () => {
    const col = { pack: "resume", packVersion: "1.0.0", field: "item", type: "text" as const, values: ["payments migration", "TypeScript tooling"], single: new Uint16Array(index.count).fill(0xffff), byUser: new Uint8Array(index.count) };
    col.single[0] = 0;
    col.single[1] = 1;
    col.single[2] = 0;
    const withLabel = { ...index, labels: [...index.labels, col] } as unknown as DataIndex;
    const dv = readDim(withLabel, RESUME_DIM, [0, 1, 2, 3]);
    expect(dv.codes[0]).not.toBe(NO_CODE);
    expect(dv.codes[0]).toBe(dv.codes[2]);
    expect(dv.codes[3]).toBe(NO_CODE);
    expect(dv.labels.slice().sort()).toEqual(["TypeScript tooling", "payments migration"].sort());
  });
  it("confirms the note-or-record, map-type and correction-kind dimensions exist", () => {
    expect(builtinDim("layer2")?.group).toBe("file");
    expect(builtinDim("hubType")?.group).toBe("agents");
    expect(builtinDim("yourFixes")?.group).toBe("you");
    expect(BUILTIN_DIMS.map((d) => d.id)).toEqual(expect.arrayContaining(["layer2", "hubType", "yourFixes"]));
    expect(dimLabel("layer2")).toBe("Note or record");
    expect(dimLabel("hubType")).toBe("Map type");
  });
});
