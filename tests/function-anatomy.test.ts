/**
 * Function (anatomy) (G-01): Group by lists the finer brain regions a note's placement role lands in, with the
 * remainder named "(none)"; the comet's boxed names stay the coarse regions; By role placement uses the same names.
 */
import { describe, expect, it } from "vitest";
import { noneNameOf, ROLE_DIM } from "../src/shared/dims";
import { Population, type DataIndex } from "../src/shared/index-format";
import { PLACEMENT_PACK, Region, ROLE_TO_REGION, SUBREGIONS, subregionByKey, subregionOfRole } from "../src/shared/packs";
import { defaultView } from "../src/state/types";
import { applyOverflow } from "../src/ui/stage/ShapeBar";
import { fakeServices } from "./helpers/fakeServices";
import { COPY } from "../src/ui/copy";
import { dimMenuModel, flatDimItems } from "../src/ui/primitives/dimMenu";
import { dimLabel } from "../src/ui/valueLabels";
import { computeGroupsArrangement } from "../src/worker/arrangements";
import { defaultVisibility, NO_CODE, readDim } from "../src/worker/charts/common";
import { computeGrouping } from "../src/worker/grouping";
import { buildSampleIndex } from "../src/worker/sampleIndex";

const index: DataIndex = buildSampleIndex(20261110, Date.UTC(2026, 10, 10));

/** The sample index with a placement/role column: the first items carry roles in turn, one carries a value outside the pack, the rest nothing. */
function withRoles(): { idx: DataIndex; roles: string[]; notes: number[] } {
  const roles = ["decision", "idea", "plan", "draft", "fix", "howto", "synthesis", "map", "reflection", "log"];
  const values = [...roles, "not-a-role"];
  const single = new Uint16Array(index.count).fill(0xffff);
  const notes: number[] = [];
  for (let i = 0; i < index.count && notes.length < 61; i++) if (index.cols.pop[i] === Population.Note) notes.push(i);
  for (let k = 0; k < 60; k++) single[notes[k]!] = k % roles.length;
  single[notes[60]!] = roles.length;
  const col = { pack: "placement", packVersion: "9.0.0", field: "role", type: "enum" as const, values, single, byUser: new Uint8Array(index.count) };
  return { idx: { ...index, labels: [...index.labels, col] } as unknown as DataIndex, roles, notes };
}

describe("the finer regions", () => {
  it("cover every placement role once, inside the brain region the figure places that role in", () => {
    const roles = PLACEMENT_PACK.fields[0]!.values!;
    for (const role of roles) {
      const sub = subregionOfRole(role);
      expect(sub, role).toBeDefined();
      expect(sub!.region).toBe(ROLE_TO_REGION[role]);
    }
    expect(SUBREGIONS.flatMap((s) => s.roles).sort()).toEqual([...roles].sort());
    expect(new Set(SUBREGIONS.map((s) => s.key)).size).toBe(SUBREGIONS.length);
    expect(subregionOfRole("nope")).toBeUndefined();
    expect(subregionByKey("broca")?.region).toBe(Region.Frontal);
  });

  it("have a copy name each, the same as the worker's", () => {
    for (const s of SUBREGIONS) expect(COPY.regions[s.key as keyof typeof COPY.regions], s.key).toBe(s.name);
  });

  it("are listed low to high inside a brain region (the order By role placement stacks them in)", () => {
    const seen = new Map<number, number>();
    for (const s of SUBREGIONS) {
      const last = seen.get(s.region) ?? -1;
      expect(SUBREGIONS.indexOf(s)).toBeGreaterThan(last);
      seen.set(s.region, SUBREGIONS.indexOf(s));
    }
    // Regions are contiguous in the table.
    const regionOrder = SUBREGIONS.map((s) => s.region);
    expect(regionOrder).toEqual([...regionOrder].sort((a, b) => a - b));
  });
});

describe("the Function (anatomy) dimension", () => {
  it("is the placement role field in Group by, named Function (anatomy), with (none) for unplaced notes", () => {
    expect(dimLabel(ROLE_DIM)).toBe("Function (anatomy)");
    const model = dimMenuModel([PLACEMENT_PACK]);
    const items = flatDimItems(model).filter((i) => i.value === ROLE_DIM);
    expect(items).toHaveLength(1);
    expect(items[0]!.label).toBe("Function (anatomy)");
    expect(items[0]!.group).toBe("agents");
    expect(noneNameOf(ROLE_DIM)).toBe("noFunction");
    expect(COPY.dims.noFunction).toBe("(none)");
    // Other label fields keep the pack's own label and the common remainder.
    expect(noneNameOf("label:session/work")).toBe("noLabel");
  });

  it("reads each role as its finer region and leaves other values and unlabelled items without one", () => {
    const { idx, notes } = withRoles();
    const all = Array.from({ length: idx.count }, (_, i) => i);
    const dv = readDim(idx, ROLE_DIM, all);
    const keyOf = (k: number) => (dv.codes[notes[k]!] === NO_CODE ? "" : dv.keys[dv.codes[notes[k]!]!]);
    expect(keyOf(0)).toBe("ventromedial");
    expect(keyOf(1)).toBe("frontopolar");
    expect(keyOf(2)).toBe("dorsolateral");
    expect(keyOf(3)).toBe("broca");
    expect(keyOf(4)).toBe("premotor");
    expect(keyOf(5)).toBe("premotor");
    expect(keyOf(60)).toBe("");
    const code = dv.codes[notes[0]!]!;
    expect(dv.labels[code]).toBe("Ventromedial prefrontal");
  });

  it("lists region rows in the key with counts and a (none) bucket", () => {
    const { idx } = withRoles();
    const res = computeGrouping(idx, {
      notes: { kind: "categorical", dim: ROLE_DIM },
      record: { kind: "age" },
      fold: false,
      hideNoValue: false,
      hiddenGroups: [],
      merges: {},
      palette: "prism",
      light: false,
      slots: {},
      visibility: defaultVisibility(idx.count),
    });
    const rows = res.legend.sections.flatMap((x) => x.rows);
    const by = new Map(rows.map((r) => [r.key, r]));
    expect(by.get("premotor")?.name).toBe("Premotor cortex");
    expect(by.get("premotor")?.notes).toBe(12);
    expect(by.get("ventromedial")?.notes).toBe(6);
    // Unlabelled notes and a value outside the pack share the unnamed remainder row (the key names it "(none)").
    const none = rows.find((r) => r.bucket === "none");
    expect(none).toBeDefined();
    expect(none!.notes).toBeGreaterThan(0);
  });

  it("clusters the comet by brain region, one cluster per finer region, and names the coarse regions", () => {
    const { idx } = withRoles();
    const res = computeGroupsArrangement(
      idx,
      { kind: "groups", dim: ROLE_DIM, layout: "bubbles", fold: false, merges: {}, hideNoValue: false, visibility: defaultVisibility(idx.count) },
      new Float32Array(idx.count * 3),
    );
    const keys = res.overlay.marks.map((m) => m.key);
    expect(keys).toContain("ventromedial");
    expect(keys).toContain("premotor");
    expect(keys).not.toContain("plan");
    const names = res.overlay.items.flatMap((it) => (it.type === "label" && it.key?.startsWith("region:") ? [it.key] : []));
    expect(names).toContain("region:prefrontal");
    expect(names).toContain("region:frontal");
    expect(defaultView().placement).toBe("area");
  });
});

describe("By role placement and the key", () => {
  it("lists the finer regions in the key while the grouping is the default Area, and goes back with By area", () => {
    const store = fakeServices().leaf.store;
    expect(store.get("view").groupBy).toBe("space");
    applyOverflow(store, "placement:role");
    expect(store.get("view").placement).toBe("role");
    expect(store.get("view").groupBy).toBe(ROLE_DIM);
    applyOverflow(store, "placement:area");
    expect(store.get("view").placement).toBe("area");
    expect(store.get("view").groupBy).toBe("space");
  });

  it("leaves a grouping the person chose alone", () => {
    const store = fakeServices().leaf.store;
    store.update("view", { groupBy: "folder" });
    applyOverflow(store, "placement:role");
    expect(store.get("view").groupBy).toBe("folder");
    applyOverflow(store, "placement:area");
    expect(store.get("view").groupBy).toBe("folder");
  });
});
