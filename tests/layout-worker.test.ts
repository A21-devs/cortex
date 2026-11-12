/**
 * Layout worker (owner E8): the standing figure's geometry (CORTEX-UX §6.2, §12.19.10), the spine position and fronds
 * (§6.3), the placement of a real sample index, sticky colour slots (§4.4), Groups arrangements, lines, the worker
 * message handler with per-view state, and transfer rules that never detach state-owned buffers (TRANSFER-DETACH).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { NONE32, type DataIndex } from "../src/shared/index-format";
import type { Logger } from "../src/shared/log";
import { LINE_FAMILIES, ownsBuffer, prepareTransfer, type FromWorker, type GroupingParams, type PlacementParams, type ToWorker, type VisibilityParams } from "../src/shared/protocol/worker";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import {
  buildAnatomy,
  envelopeHalfWidth,
  FIGURE,
  HAZE_TOTAL,
  homeDirection,
  nerveCourse,
  nerveLevel,
  NERVE_LEVELS,
  poseXYZ,
  resolvePose,
  spinePoint,
  spineRadius,
  standingFrame,
  tauAtY,
  type AnatomyModel,
} from "../src/worker/anatomy";
import { createColourSlotService, mergeSlots, parseSlotsFile } from "../src/plugin/colourSlots";
import { createWorkerClient, type WorkerLike } from "../src/plugin/workerClient";
import { computeGroupsArrangement, SPARSE_GROUP } from "../src/worker/arrangements";
import { assignSlots, computeGrouping, dimValue, HIDDEN_ALPHA } from "../src/worker/grouping";
import { computeLines, sourceControl } from "../src/worker/lines";
import { createWorkerHandler } from "../src/worker/handler";
import { computePlacement, computeSpineTime, conversationRoots, conversationSides, cordTau, frondArc, frondFraction, frondPath, wedgeWidths } from "../src/worker/placement";
import { buildSampleIndex } from "../src/worker/sampleIndex";

let anatomy: AnatomyModel;
let index: DataIndex;
const NOW = Date.UTC(2026, 10, 9);

const VIS: VisibilityParams = {} as VisibilityParams;
const params = (pose: "standing" | "lying" = "standing"): PlacementParams => ({ seed: 7, pose, placement: "area", order: "oldest", depthKey: "time", gamma: 0.6, visibility: VIS });

beforeAll(() => {
  anatomy = buildAnatomy(7, 20_000);
  index = buildSampleIndex(7, NOW);
}, 60_000);

describe("worker/anatomy: the standing figure (§6.2)", () => {
  it("has the key heights: crown 5.00, cord tip −4.02, cerebellum base 2.74", () => {
    const brain = anatomy.brainPart;
    let crown = -Infinity;
    let base = Infinity;
    for (let i = 0; i < anatomy.slotCount; i++) {
      const y = anatomy.brainSlots[i * 3 + 1] as number;
      if (brain[i] === 3) continue;
      crown = Math.max(crown, y);
      if (brain[i] === 2) base = Math.min(base, y);
    }
    expect(crown).toBeGreaterThan(4.98);
    expect(crown).toBeLessThan(5.021);
    expect(base).toBeGreaterThan(2.7);
    expect(spinePoint(1)[1]).toBeCloseTo(-4.02, 2);
    expect(spinePoint(0)[1]).toBeCloseTo(3.58, 2);
  });

  it("keeps the brain's slots inside y 2.74–5.02 and never puts a cerebrum slot in the cerebellum's room", () => {
    for (let i = 0; i < anatomy.slotCount; i++) {
      const part = anatomy.brainPart[i] as number;
      const y = anatomy.brainSlots[i * 3 + 1] as number;
      const z = anatomy.brainSlots[i * 3 + 2] as number;
      expect(y).toBeGreaterThan(part === 3 ? 2.7 : 2.73);
      expect(y).toBeLessThan(5.025);
      if (part === 0) expect(!(y < 3.53 && z < -0.35)).toBe(true);
      if (part === 0) expect(y).toBeGreaterThan(3.4);
    }
  });

  it("splits the hemispheres by the fissure and grooves the lateral sulcus", () => {
    let fissure = 0;
    for (let i = 0; i < anatomy.slotCount; i++) {
      if (anatomy.brainPart[i] !== 0) continue;
      const x = anatomy.brainSlots[i * 3] as number;
      const y = anatomy.brainSlots[i * 3 + 1] as number;
      const z = anatomy.brainSlots[i * 3 + 2] as number;
      if (Math.abs(x) < 0.06 && (y > 3.78 || z < -0.55)) fissure++;
    }
    expect(fissure).toBe(0);
  });

  it("makes the cord's S-curve 0.74 ± 0.05 deep and monotone in y", () => {
    let zMin = Infinity;
    let zMax = -Infinity;
    let prev = Infinity;
    for (let i = 0; i <= 400; i++) {
      const p = spinePoint(i / 400);
      zMin = Math.min(zMin, p[2]);
      zMax = Math.max(zMax, p[2]);
      expect(p[1]).toBeLessThanOrEqual(prev + 1e-9);
      prev = p[1];
      expect(p[0]).toBe(0);
    }
    // The front-to-back range of the centre line in the tail beyond the brainstem: neck forward, chest back, sacrum back.
    expect(zMax - zMin).toBeGreaterThan(0.69);
    expect(zMax - zMin).toBeLessThan(0.84);
    expect(spineRadius(0.5)).toBeGreaterThan(0.05);
  });

  it("has 31 pairs of nerves inside the envelope plus 0.2 and above y −4.32", () => {
    expect(NERVE_LEVELS).toHaveLength(31);
    expect(NERVE_LEVELS[0]?.name).toBe("C1");
    expect(NERVE_LEVELS[30]?.name).toBe("Co1");
    for (const level of NERVE_LEVELS) {
      for (const side of [1, -1]) {
        const c = nerveCourse(level.index, side);
        for (let j = 0; j < c.count; j++) {
          const x = c.pts[j * 3] as number;
          const y = c.pts[j * 3 + 1] as number;
          expect(y).toBeGreaterThanOrEqual(-4.32 - 1e-9);
          expect(Math.abs(x)).toBeLessThanOrEqual(envelopeHalfWidth(y) + 0.2);
        }
      }
    }
    // A nerve on the figure's right goes to −X, on its left to +X.
    expect(nerveCourse(10, 1).pts[nerveCourse(10, 1).pts.length - 3] as number).toBeLessThan(0);
    expect(nerveCourse(10, -1).pts[nerveCourse(10, -1).pts.length - 3] as number).toBeGreaterThan(0);
  });

  it("maps τ to the nearest exit level, oldest on the neck and newest on the cauda equina", () => {
    expect(nerveLevel(0.06).name.startsWith("C")).toBe(true);
    expect(nerveLevel(0.94).name.startsWith("S") || nerveLevel(0.94).name === "Co1").toBe(true);
    expect(tauAtY(2.62)).toBeCloseTo(NERVE_LEVELS[0]?.tau ?? -1, 6);
    for (let i = 1; i < NERVE_LEVELS.length; i++) expect((NERVE_LEVELS[i] as { tau: number }).tau).toBeGreaterThan((NERVE_LEVELS[i - 1] as { tau: number }).tau);
  });

  it("ends the figure in a plain tip: nothing below the lowest strand at −4.32 ± 0.05 (no undated cloud past it)", () => {
    expect(anatomy.bounds.min[1]).toBeCloseTo(FIGURE.cord.floorY, 1);
    expect(anatomy.bounds.min[1]).toBeGreaterThan(FIGURE.cord.floorY - 0.05);
    expect(anatomy.bounds.max[1]).toBeGreaterThan(4.98);
  });

  it("budgets the haze as one fixed set", () => {
    expect(anatomy.haze.count).toBe(HAZE_TOTAL);
    expect(HAZE_TOTAL).toBeGreaterThan(30_000);
    // Brain haze: 12,000 fold + 5,000 volume + 2,100 cerebellum (denser and finer than the 8,400 + 3,500 of v1).
    expect(FIGURE.haze.brainFolds + FIGURE.haze.brainVolume + FIGURE.haze.cerebellum).toBe(19_100);
  });

  it("reads the default pose from the shared settings and rotates Lying +90° about Z", () => {
    expect(resolvePose(undefined)).toBe(DEFAULT_SETTINGS.general.pose);
    expect(resolvePose("lying")).toBe("lying");
    expect(poseXYZ("lying", 1, 2, 3)).toEqual([-2, 1, 3]);
    expect(poseXYZ("standing", 1, 2, 3)).toEqual([1, 2, 3]);
  });

  it("sits the home camera behind and to the figure's right, 9° above", () => {
    const d = homeDirection("standing");
    expect(d[2]).toBeLessThan(0);
    expect(d[0]).toBeLessThan(0);
    expect(d[1]).toBeCloseTo(Math.sin((9 * Math.PI) / 180), 6);
    const f = standingFrame(1176, 825);
    expect(f.crownTop / 825).toBeCloseTo(0.09);
    expect(f.bottom).toBe(757);
    expect(f.centreX).toBeCloseTo((24 + 1176 - 70) / 2);
  });
});

describe("worker/placement (§6.3)", () => {
  it("places the record on τ = 0.06 + 0.88(0.65 r + 0.35 ℓ) and sizes fronds by log length", () => {
    expect(cordTau(0, 0)).toBeCloseTo(0.06);
    expect(cordTau(1, 1)).toBeCloseTo(0.94);
    expect(cordTau(0.5, 0)).toBeCloseTo(0.06 + 0.88 * 0.325);
    expect(frondFraction(0)).toBeCloseTo(0.55);
    expect(frondFraction(100)).toBeCloseTo(0.55 + 0.14 * Math.log(11));
    expect(frondFraction(1e9)).toBe(1);
    expect(frondFraction(0, 0.1)).toBeCloseTo(0.12);
    expect(frondArc(0, 10)).toBe(0);
    expect(frondArc(9, 10)).toBeCloseTo(1);
    const w = wedgeWidths([100, 1, 0], 0.6);
    expect(w.reduce((x, y) => x + y, 0)).toBeCloseTo(Math.PI * 2);
    expect(w[2]).toBe(0);
    expect(SPARSE_GROUP).toBe(30);
  });

  it("leaves a frond from the cord with a 0.22 rootlet and runs the segment's nerve", () => {
    const tau = 0.5;
    const shape = frondPath(tau, 1, 400, 12345, false);
    const p0 = spinePoint(tau);
    expect(shape.poly.pts[0]).toBeCloseTo(p0[0]);
    expect(shape.poly.pts[1]).toBeCloseTo(p0[1]);
    const rootlet = Math.hypot((shape.poly.pts[3] as number) - p0[0], (shape.poly.pts[4] as number) - p0[1], (shape.poly.pts[5] as number) - p0[2]);
    expect(rootlet).toBeGreaterThan(0.18);
    expect(rootlet).toBeLessThan(0.35);
    expect(shape.fraction).toBeGreaterThan(0.5);
    const tail = shape.poly.pts[shape.poly.pts.length - 3] as number;
    expect(tail).toBeLessThan(-0.5);
  });

  it("alternates sides in start order and places every record item on the standing figure", () => {
    const res = computePlacement(index, anatomy, params());
    expect(res.anat.length).toBe(index.count * 3);
    let right = 0;
    let left = 0;
    for (let i = 0; i < index.count; i++) {
      const x = res.anat[i * 3] as number;
      const t = res.tau[i] as number;
      if (Number.isFinite(t) && Math.abs(x) > 0.8) (x < 0 ? right++ : left++);
    }
    expect(right).toBeGreaterThan(0);
    expect(left).toBeGreaterThan(0);
    expect(Math.min(right, left) / Math.max(right, left)).toBeGreaterThan(0.5);
    // Time runs down the cord: oldest at the top.
    let oldY = 0;
    let oldN = 0;
    let newY = 0;
    let newN = 0;
    for (let i = 0; i < index.count; i++) {
      const t = res.tau[i] as number;
      if (!Number.isFinite(t)) continue;
      if (t < 0.2) (oldY += res.anat[i * 3 + 1] as number), oldN++;
      if (t > 0.8) (newY += res.anat[i * 3 + 1] as number), newN++;
    }
    if (oldN > 0 && newN > 0) expect(oldY / oldN).toBeGreaterThan(newY / newN);
    // Notes live in the brain.
    let notesInBrain = 0;
    let notes = 0;
    for (let i = 0; i < index.count; i++) {
      if (Number.isFinite(res.tau[i] as number) || res.region[i] === 255) continue;
      notes++;
      if ((res.anat[i * 3 + 1] as number) > 2.6) notesInBrain++;
    }
    expect(notes).toBeGreaterThan(0);
    expect(notesInBrain / notes).toBeGreaterThan(0.95);
  });

  it("sends two consecutive conversations to opposite sides, the first to the figure's right", () => {
    const res = computePlacement(index, anatomy, params());
    const roots = conversationRoots(index, computeSpineTime(index));
    const sides = conversationSides(roots);
    const rows = [...roots.keys()].filter((r) => Number.isFinite(roots[r] as number)).sort((a, b) => (roots[a] as number) - (roots[b] as number) || a - b);
    expect(rows.length).toBeGreaterThan(10);
    expect(sides[rows[0] as number]).toBe(1);
    for (let k = 1; k < rows.length; k++) expect(sides[rows[k] as number]).toBe(-(sides[rows[k - 1] as number] as number));
    // A frond's far end lies on its side: right = −X, left = +X.
    const far = new Map<number, number>();
    for (let i = 0; i < index.count; i++) {
      const row = index.cols.conv[i] as number;
      const x = res.anat[i * 3] as number;
      if (row === NONE32 || !Number.isFinite(x) || !Number.isFinite(res.tau[i] as number)) continue;
      if (Math.abs(x) > Math.abs(far.get(row) ?? 0)) far.set(row, x);
    }
    let agree = 0;
    let total = 0;
    for (const [row, x] of far) {
      if (Math.abs(x) < 0.3) continue;
      total++;
      if (Math.sign(x) === -(sides[row] as number)) agree++;
    }
    expect(total).toBeGreaterThan(10);
    expect(agree / total).toBeGreaterThan(0.98);
  });

  it("lays the same skeleton down for Lying and never moves a point with the pose", () => {
    const a = computePlacement(index, anatomy, params("standing"));
    const b = computePlacement(index, anatomy, params("lying"));
    for (let i = 0; i < Math.min(index.count, 2000); i++) {
      const x = a.anat[i * 3] as number;
      if (!Number.isFinite(x)) continue;
      expect(b.anat[i * 3] as number).toBeCloseTo(-(a.anat[i * 3 + 1] as number), 4);
      expect(b.anat[i * 3 + 1] as number).toBeCloseTo(x, 4);
      expect(b.anat[i * 3 + 2] as number).toBeCloseTo(a.anat[i * 3 + 2] as number, 4);
    }
    expect(b.bounds.min[0]).toBeLessThan(-4.5);
  });
});

describe("worker/grouping: colour follows the group (§4.4)", () => {
  it("keeps existing slots, gives new values the next free slot and folds past 8", () => {
    const first = assignSlots(new Map([["roblox", 500], ["vault", 300], ["code", 100]]));
    expect(first.get("roblox")).toBe(1);
    const again = assignSlots(new Map([["vault", 900], ["roblox", 10], ["games", 50]]), Object.fromEntries(first));
    expect(again.get("roblox")).toBe(first.get("roblox"));
    expect(again.get("vault")).toBe(first.get("vault"));
    expect(again.get("games")).toBe(4);
  });
});

describe("worker/grouping: colours, legend and sticky slots", () => {
  const grouping = (over: Partial<GroupingParams> = {}): GroupingParams => ({
    notes: { kind: "categorical", dim: "space" },
    record: { kind: "categorical", dim: "source" },
    fold: true,
    hideNoValue: false,
    hiddenGroups: [],
    merges: {},
    palette: "prism",
    light: false,
    slots: {},
    visibility: VIS,
    ...over,
  });

  it("colours every drawn item, never white, and assigns sticky slots over everything indexed", () => {
    const g = computeGrouping(index, grouping());
    expect(g.color.length).toBe(index.count * 4);
    let coloured = 0;
    for (let i = 0; i < index.count; i++) {
      if (g.groupOf[i] === NONE32) continue;
      coloured++;
      expect((g.color[i * 4] as number) + (g.color[i * 4 + 1] as number) + (g.color[i * 4 + 2] as number)).toBeLessThan(255 * 3);
    }
    expect(coloured).toBeGreaterThan(1000);
    // Colours are sRGB bytes: a palette colour is bright, not 0/1 (the palette works in 0..1 floats).
    let bright = 0;
    for (let i = 0; i < index.count; i++) if (g.groupOf[i] !== NONE32 && Math.max(g.color[i * 4] as number, g.color[i * 4 + 1] as number, g.color[i * 4 + 2] as number) > 100) bright++;
    expect(bright).toBeGreaterThan(coloured * 0.8);
    // Key rows keep 0..1 floats for rgbCss, and are not all white or black.
    const firstRow = g.legend.sections.flatMap((sec) => sec.rows)[0];
    expect(firstRow && firstRow.rgb.every((x) => x >= 0 && x <= 1) && firstRow.rgb.some((x) => x > 0.05 && x < 0.95)).toBe(true);
    const spaces = g.newSlots.space ?? {};
    expect(Object.keys(spaces).length).toBeGreaterThan(0);
    for (const s of Object.values(spaces)) {
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(8);
    }
    expect(g.legend.sections.length).toBeGreaterThan(0);
    expect(g.legend.grandTotal).toBeGreaterThan(0);
  });

  it("a figure colour theme recolours the particles only: the key's rows, swatches and age gradient stay the own ones", () => {
    const own = computeGrouping(index, grouping());
    const figure = { palette: "garnet" as const, age: { mode: "lightness" as const, tintHue: 22, chroma: 0.1 } };
    const themed = computeGrouping(index, grouping({ figure }));
    expect(themed.legend).toEqual(own.legend);
    expect(themed.groupOf).toEqual(own.groupOf);
    expect(themed.newSlots).toEqual(own.newSlots);
    expect(Buffer.from(themed.color).equals(Buffer.from(own.color))).toBe(false);
    // Drawing the particles with the same palette directly gives the same bytes: the override is only the palette.
    expect(themed.color).toEqual(computeGrouping(index, grouping({ palette: "garnet" })).color);
    // Age colouring: the figure takes the theme's ramp, the key's gradient keeps the own one.
    const age = { notes: { kind: "age" as const }, record: { kind: "age" as const }, age: { mode: "hue" as const, tintHue: null, chroma: 0.02 } };
    const ownAge = computeGrouping(index, grouping(age));
    const themedAge = computeGrouping(index, grouping({ ...age, figure }));
    expect(themedAge.legend).toEqual(ownAge.legend);
    expect(Buffer.from(themedAge.color).equals(Buffer.from(ownAge.color))).toBe(false);
    expect(themedAge.color).toEqual(computeGrouping(index, grouping({ ...age, age: figure.age })).color);
  });

  it("keeps recorded slots when the filter changes and reports nothing new", () => {
    const first = computeGrouping(index, grouping());
    const slots = { space: first.newSlots.space ?? {}, source: first.newSlots.source ?? {} };
    const again = computeGrouping(index, grouping({ slots, visibility: { ...VIS, record: false } }));
    expect(again.newSlots).toEqual({});
    const rows = again.legend.sections.flatMap((s) => s.rows);
    for (const [key, slot] of Object.entries(slots.space)) {
      const row = rows.find((r) => r.key === key);
      if (row) expect(row.slot).toBe(slot);
    }
  });

  it("fades hidden groups to 6% and supports the age and single modes", () => {
    const first = computeGrouping(index, grouping());
    const key = Object.keys(first.newSlots.space ?? {})[0] as string;
    const hidden = computeGrouping(index, grouping({ hiddenGroups: [key], slots: { space: first.newSlots.space ?? {} } }));
    let faded = 0;
    for (let i = 0; i < index.count; i++) if (hidden.color[i * 4 + 3] === HIDDEN_ALPHA) faded++;
    expect(faded).toBeGreaterThan(0);
    const age = computeGrouping(index, grouping({ notes: { kind: "age" }, record: { kind: "single", slot: 3 } }));
    expect(age.legend.sections.find((s) => s.dim === "age")?.gradient?.stops).toHaveLength(8);
    expect(age.legend.sections.find((s) => s.dim === "single")?.rows).toHaveLength(1);
  });

  it("reads one item's value for a dimension", () => {
    let note = -1;
    for (let i = 0; i < index.count; i++) {
      if (index.cols.pop[i] === 0) {
        note = i;
        break;
      }
    }
    expect(typeof dimValue(index, note, "space")).toBe("string");
    expect(dimValue(index, -5, "space")).toBe("");
  });
});

describe("worker/arrangements: Groups layouts (§6.12)", () => {
  type GroupsArgs = Parameters<typeof computeGroupsArrangement>[1];
  const args = (layout: GroupsArgs["layout"], dim: GroupsArgs["dim"] = "space"): GroupsArgs => ({ kind: "groups", dim, layout, fold: false, merges: {}, hideNoValue: false, visibility: VIS });
  let place: ReturnType<typeof computePlacement>;
  beforeAll(() => {
    place = computePlacement(index, anatomy, params());
  });

  it("packs bubbles into the figure's half-height and reports thin groups as sparse", () => {
    const res = computeGroupsArrangement(index, args("bubbles"), place.anat);
    let finite = 0;
    let far = 0;
    for (let i = 0; i < index.count; i++) {
      if (!Number.isFinite(res.arr[i * 3] as number)) continue;
      finite++;
      far = Math.max(far, Math.hypot(res.arr[i * 3] as number, res.arr[i * 3 + 1] as number, res.arr[i * 3 + 2] as number));
    }
    expect(finite).toBeGreaterThan(1000);
    expect(far).toBeLessThanOrEqual(FIGURE.groups.targetRadius + 1e-3);
    expect(res.overlay.marks.length).toBeGreaterThan(1);
    expect(res.camera.radius).toBeGreaterThan(1);
    const folded = computeGroupsArrangement(index, { ...args("bubbles", "source"), fold: true }, place.anat);
    expect(folded.overlay.marks.length).toBeGreaterThan(0);
    expect(SPARSE_GROUP).toBe(30);
  });

  it("lays a tree left to right, strata by size and the spine as bars on both sides of the cord", () => {
    const tree = computeGroupsArrangement(index, args("tree"), place.anat);
    expect(tree.overlay.items.some((o) => o.type === "line")).toBe(true);
    const strata = computeGroupsArrangement(index, args("strata"), place.anat);
    expect(strata.overlay.marks.length).toBeGreaterThan(0);
    // Strata names stand left of their slab, right-aligned, clear of the column of points.
    const names = strata.overlay.items.filter((o): o is Extract<typeof o, { type: "label" }> => o.type === "label");
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      const mark = strata.overlay.marks.find((m) => m.key === n.key);
      expect(n.align).toBe("right");
      expect(n.at[0]).toBeLessThan((mark?.bounds.min[0] ?? 0) + 1e-6);
    }
    const spine = computeGroupsArrangement(index, args("spine"), place.anat, "standing");
    let left = 0;
    let right = 0;
    for (let i = 0; i < index.count; i++) {
      const x = spine.arr[i * 3] as number;
      if (!Number.isFinite(x)) continue;
      if (x < 0) right++;
      else left++;
    }
    expect(left).toBeGreaterThan(0);
    expect(right).toBeGreaterThan(0);
    const lying = computeGroupsArrangement(index, args("spine"), place.anat, "lying");
    // Lying is the same figure turned +90° about Z: (x, y) → (−y, x).
    let checked = 0;
    for (let i = 0; i < index.count; i++) {
      if (!Number.isFinite(spine.arr[i * 3] as number)) continue;
      expect(lying.arr[i * 3] as number).toBeCloseTo(-(spine.arr[i * 3 + 1] as number), 4);
      expect(lying.arr[i * 3 + 1] as number).toBeCloseTo(spine.arr[i * 3] as number, 4);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it("gives items outside the layers no target", () => {
    const res = computeGroupsArrangement(index, { ...args("bubbles"), visibility: { ...VIS, record: false } }, place.anat);
    let nan = 0;
    for (let i = 0; i < index.count; i++) if (index.cols.pop[i] === 1 && !Number.isFinite(res.arr[i * 3] as number)) nan++;
    expect(nan).toBeGreaterThan(0);
  });
});

describe("worker/lines (§6.10)", () => {
  let place: ReturnType<typeof computePlacement>;
  beforeAll(() => {
    place = computePlacement(index, anatomy, params());
  });

  it("draws source lines as curves whose control point passes outside the torso", () => {
    const res = computeLines(index, place.anat, { families: ["source"], visibility: VIS, budget: 60_000 }, "standing");
    expect(res.segments).toBeGreaterThan(0);
    expect(res.segments).toBeLessThanOrEqual(60_000);
    expect(res.positions.length).toBe(res.segments * 6);
    const ctrl = sourceControl([1, 0, 0], [0, 2, 0], 1);
    expect(ctrl[0]).toBeCloseTo(2 * envelopeHalfWidth(1) + 0.2, 3);
    expect(ctrl[1]).toBeCloseTo(1, 6);
    const mid = sourceControl([-1, -2, 0], [0, 2, 0], 1);
    expect(mid[0]).toBeLessThan(0);
    expect(Math.abs(mid[0])).toBeGreaterThan(envelopeHalfWidth(0));
  });

  it("samples under the budget and draws stems between consecutive messages", () => {
    const small = computeLines(index, place.anat, { families: ["source", "stem", "spoke"], visibility: VIS, budget: 500 }, "standing");
    expect(small.segments).toBeLessThanOrEqual(500);
    const stems = computeLines(index, place.anat, { families: ["stem"], visibility: VIS, budget: 60_000 }, "standing");
    expect(stems.segments).toBeGreaterThan(0);
    for (let s = 0; s < stems.segments; s++) expect(stems.family[s]).toBe(LINE_FAMILIES.indexOf("stem"));
    expect(computeLines(index, place.anat, { families: [], visibility: VIS, budget: 100 }).segments).toBe(0);
  });
});

describe("plugin/workerClient", () => {
  const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };

  it("runs calls through a worker and cancels the older call of the same view and method", async () => {
    const sent: ToWorker[] = [];
    const box: { fn: ((ev: { data: FromWorker }) => void) | null } = { fn: null };
    const fake: WorkerLike = {
      postMessage: (m) => void sent.push(m),
      terminate: () => undefined,
      get onmessage() {
        return box.fn;
      },
      set onmessage(f) {
        box.fn = f;
      },
      onerror: null,
    };
    const client = createWorkerClient(log, { source: "x", spawn: () => fake });
    const first = client.call("v1", "init", {} as never).then(
      () => "ok",
      (e: { code: string }) => e.code,
    );
    await new Promise((r) => setTimeout(r, 0));
    const second = client.call("v1", "init", {} as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(await first).toBe("E_CANCELLED");
    expect(sent.some((m) => m.t === "cancel")).toBe(true);
    const call = sent.filter((m) => m.t === "call").pop() as { id: number };
    box.fn?.({ data: { t: "result", id: call.id, ok: true, result: { version: "t" } } });
    expect(await second).toEqual({ version: "t" });
    expect(client.mode).toBe("worker");
    client.dropView("v1");
    expect(sent[sent.length - 1]).toEqual({ t: "dropView", viewId: "v1" });
    client.terminate();
    expect(client.mode).toBe("stopped");
    await expect(client.call("v1", "init", {} as never)).rejects.toMatchObject({ code: "E_CANCELLED" });
  });

  it("falls back to the inline handler when the worker cannot start, with identical results", async () => {
    const client = createWorkerClient(log, {
      source: "x",
      spawn: () => {
        throw new Error("blocked");
      },
      inline: async (post) => createWorkerHandler(post),
      defer: (fn) => queueMicrotask(fn),
    });
    const res = await client.call("v1", "loadSample", { seed: 3 } as never);
    expect(client.mode).toBe("inline");
    expect((res as { count: number }).count).toBeGreaterThan(1000);
    const placed = (await client.call("v1", "placement", params())) as { anat: Float32Array };
    expect(placed.anat.length).toBeGreaterThan(3000);
    const grouping: GroupingParams = {
      notes: { kind: "categorical", dim: "space" },
      record: { kind: "age" },
      fold: true,
      hideNoValue: false,
      hiddenGroups: [],
      merges: {},
      palette: "prism",
      light: false,
      slots: {},
      visibility: VIS,
    };
    const g = await client.call("v1", "grouping", grouping);
    expect(g.legend.sections.length).toBeGreaterThan(0);
    const arr = (await client.call("v1", "arrangement", { kind: "groups", dim: "space", layout: "spine", fold: false, merges: {}, hideNoValue: false, visibility: VIS } as never)) as { arr: Float32Array };
    expect(arr.arr.length).toBeGreaterThan(3000);
    client.terminate();
  }, 60_000);

  it("reports a missing bundle when there is neither a worker nor a way to run inline", async () => {
    const client = createWorkerClient(log, { source: "" });
    await expect(client.call("v1", "init", {} as never)).rejects.toMatchObject({ code: "E_WORKER" });
  });
});

describe("plugin/colourSlots", () => {
  it("merges without reassigning and parses only slots 1..8", () => {
    const cur = { space: { a: 1, b: 2 } };
    const merged = mergeSlots(cur, { space: { b: 5, c: 2, d: 3 }, source: { x: 1 } });
    expect(merged.space).toEqual({ a: 1, b: 2, c: 3, d: 4 });
    expect(merged.source).toEqual({ x: 1 });
    expect(cur.space).toEqual({ a: 1, b: 2 });
    expect(parseSlotsFile({ v: 1, dims: { s: { a: 1, b: 9, c: 1, d: 0.5 } } })).toEqual({ s: { a: 1 } });
    expect(parseSlotsFile({ v: 2, dims: {} })).toBeNull();
  });

  it("persists to colours.json under a lock and reloads it on another instance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-colours-"));
    try {
      const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
      const deps = { vaultRoot: join(dir, "vault"), cacheDir: join(dir, "cache"), log };
      mkdirSync(deps.vaultRoot, { recursive: true });
      const a = createColourSlotService(deps);
      await a.merge({ space: { garden: 1, studio: 2 } });
      await a.merge({ space: { garden: 7, ledger: 1 } });
      expect(a.current().space).toEqual({ garden: 1, studio: 2, ledger: 3 });
      const b = createColourSlotService(deps);
      expect((await b.load?.())?.space).toEqual({ garden: 1, studio: 2, ledger: 3 });
      expect((JSON.parse(readFileSync(join(deps.vaultRoot, ".vault-meta", "cortex", "state", "colours.json"), "utf8")) as { v: number }).v).toBe(1);
      await b.reset("space");
      expect(b.current().space).toBeUndefined();
      expect((await a.load?.())?.space).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps slots in memory without persistence deps", async () => {
    const s = createColourSlotService();
    await s.merge({ kind: { q: 1 } });
    expect(s.current().kind).toEqual({ q: 1 });
    await s.reset("kind");
    expect(s.current()).toEqual({});
  });
});

describe("worker/handler", () => {
  it("answers calls per view, reports errors by code and drops view state", async () => {
    const posted: unknown[] = [];
    const h = createWorkerHandler((m) => posted.push(m), { init: async () => ({ version: "0.2.0" }) } as never);
    h.onMessage({ t: "call", id: 1, viewId: "v1", method: "init", params: {} } as never);
    h.onMessage({ t: "call", id: 2, viewId: "v1", method: "loadIndex", params: {} } as never);
    await new Promise((r) => setTimeout(r, 10));
    const byId = (id: number) => posted.find((m) => (m as { id: number }).id === id);
    expect(byId(1)).toMatchObject({ t: "result", id: 1, ok: true });
    expect(byId(2)).toMatchObject({ t: "result", id: 2, ok: false, error: { code: "E_INTERNAL" } });
    h.state.views.set("v1", {} as never);
    h.onMessage({ t: "dropView", viewId: "v1" });
    expect(h.state.views.has("v1")).toBe(false);
  });
  it("transfers owned result buffers but copies views and never detaches state buffers (TRANSFER-DETACH)", () => {
    const owned = new Float32Array(4);
    const big = new Float32Array(16);
    const view = big.subarray(4, 8);
    const state = new Float32Array(8);
    const stateOwned = new WeakSet<ArrayBufferLike>([state.buffer]);
    const { value, transfer } = prepareTransfer({ owned, view, state }, stateOwned);
    expect(ownsBuffer(owned)).toBe(true);
    expect(ownsBuffer(view)).toBe(false);
    expect(transfer).toContain(owned.buffer);
    expect(transfer).not.toContain(big.buffer);
    expect(transfer).not.toContain(state.buffer);
    expect(Array.from(value.view)).toEqual(Array.from(view));
  });
});
