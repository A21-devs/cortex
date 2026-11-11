/**
 * FIGURE polish (F2): the leaf has a smooth outline, undated entries lie faintly along its lowest fibres (no cloud past
 * the tip) and a big conversation is spread over several strands instead of one colour clump.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { NONE32, Population, type DataIndex } from "../src/shared/index-format";
import type { PlacementParams, PlacementResult, VisibilityParams } from "../src/shared/protocol/worker";
import { buildAnatomy, clipToDepth, clipToEnvelope, envelopeHalfWidth, fibreCourse, FIGURE, HAZE_SUB_INDEX, zBack, type AnatomyModel } from "../src/worker/anatomy";
import { computePlacement, isUndatedRecord } from "../src/worker/placement";
import { buildSampleIndex } from "../src/worker/sampleIndex";

/** The widest the envelope is from y up to the longest hang above it: a strand hangs at the width it had higher up. */
function bell(y: number): number {
  let w = 0;
  for (let d = 0; d <= FIGURE.nerves.fibres.drop[1] + 0.2; d += 0.1) w = Math.max(w, envelopeHalfWidth(y + d));
  return w;
}

const params: PlacementParams = { seed: 7, pose: "standing", placement: "area", order: "oldest", depthKey: "time", gamma: 0.6, visibility: {} as VisibilityParams };

let anatomy: AnatomyModel;
let index: DataIndex;
let res: PlacementResult;

beforeAll(() => {
  anatomy = buildAnatomy(7, 20_000);
  index = buildSampleIndex(7, Date.UTC(2026, 10, 9));
  res = computePlacement(index, anatomy, params);
}, 90_000);

describe("leaf outline", () => {
  it("pulls whatever lies beyond the envelope back toward it and leaves the inside alone", () => {
    const w = envelopeHalfWidth(0);
    expect(clipToEnvelope(w * 0.5, 0)).toBe(w * 0.5);
    expect(clipToEnvelope(-w * 0.5, 0)).toBe(-w * 0.5);
    expect(clipToEnvelope(w + 1, 0)).toBeCloseTo(w + FIGURE.fronds.edgeKeep, 9);
    expect(clipToEnvelope(-(w + 1), 0)).toBeCloseTo(-(w + FIGURE.fronds.edgeKeep), 9);
    const inside = zBack(0) + 0.1;
    expect(clipToDepth(inside, 0)).toBe(inside);
    const front = zBack(0) + w * FIGURE.envelope.depthRatio;
    expect(clipToDepth(front + 1, 0)).toBeCloseTo(front + FIGURE.fronds.edgeKeep, 9);
    expect(clipToDepth(zBack(0) - 1, 0)).toBeCloseTo(zBack(0) - FIGURE.fronds.edgeKeep, 9);
  });

  it("keeps every fibre strand inside the envelope, its end curved in (no shell beyond 1)", () => {
    expect(FIGURE.nerves.fibres.shell[1]).toBeLessThanOrEqual(1);
    let curved = 0;
    for (let k = 0; k < 40; k++) {
      const u = (n: number): number => ((k * 7 + n * 13) % 16) / 16 + 0.01;
      const poly = fibreCourse(8 + (k % 20), k % 2 === 0 ? 1 : -1, u(1), u(2), u(3), u(4));
      const n = poly.pts.length / 3;
      for (let i = 0; i < n; i++) {
        const x = poly.pts[i * 3] as number;
        const y = poly.pts[i * 3 + 1] as number;
        // A strand hangs at the width it had where it left the leaf: inside the bell the envelope makes from above.
        expect(Math.abs(x)).toBeLessThanOrEqual(bell(y) + 1e-6);
      }
      // The end never flares outward: it holds its width or drifts in.
      const ex = Math.abs(poly.pts[(n - 1) * 3] as number);
      const mx = Math.abs(poly.pts[(n - 6) * 3] as number);
      if (ex <= mx + 1e-9) curved++;
    }
    expect(curved).toBeGreaterThanOrEqual(25);
  });

  it("lets fibres hang: their ends are spread over a long stretch of height, never below the floor", () => {
    const ys: number[] = [];
    for (let q = 0; q < 16; q++) {
      const c = fibreCourse(10, 1, 0.5, 0.5, (q + 0.5) / 16, 0.9);
      const y = c.pts[(c.pts.length / 3 - 1) * 3 + 1] as number;
      expect(y).toBeGreaterThanOrEqual(FIGURE.cord.floorY - 1e-6);
      ys.push(y);
    }
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.8);
  });

  it("keeps the haze strands and twigs inside the leaf (the outline has no spikes) and above the floor", () => {
    const h = anatomy.haze;
    let checked = 0;
    for (let i = 0; i < h.count; i++) {
      const s = h.sub[i];
      if (s !== HAZE_SUB_INDEX.nerve && s !== HAZE_SUB_INDEX.twig) continue;
      const x = h.pos[i * 3] as number;
      const y = h.pos[i * 3 + 1] as number;
      expect(Math.abs(x)).toBeLessThanOrEqual(bell(y) * 1.03 + 0.05);
      expect(y).toBeGreaterThanOrEqual(FIGURE.cord.floorY - 1e-6);
      checked++;
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it("keeps placed record points inside the envelope", () => {
    let outside = 0;
    let total = 0;
    for (let i = 0; i < index.count; i++) {
      if (index.cols.pop[i] !== Population.Record || !Number.isFinite(res.tau[i] as number)) continue;
      const y = res.anat[i * 3 + 1] as number;
      if (y > 2.3) continue;
      total++;
      if (Math.abs(res.anat[i * 3] as number) > envelopeHalfWidth(y) * 1.05 + 0.04) outside++;
    }
    expect(total).toBeGreaterThan(1000);
    expect(outside / total).toBeLessThan(0.002);
  });
});

describe("undated entries", () => {
  it("lie along the lowest fibres: counted, placed, inside the leaf, none in a cloud past the tip", () => {
    const undated: number[] = [];
    for (let i = 0; i < index.count; i++) if (index.cols.pop[i] === Population.Record && isUndatedRecord(index, i)) undated.push(i);
    expect(undated.length).toBeGreaterThan(100);
    const voxels = new Set<string>();
    const first = FIGURE.nerves.rows[FIGURE.undated.fromLevel] as unknown as [string, number];
    for (const i of undated) {
      const x = res.anat[i * 3] as number;
      const y = res.anat[i * 3 + 1] as number;
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(res.anat[i * 3 + 2] as number)).toBe(true);
      expect(y).toBeGreaterThanOrEqual(FIGURE.cord.floorY - FIGURE.fronds.floorMargin - 1e-6);
      expect(y).toBeLessThanOrEqual(first[1] + 0.1);
      expect(Math.abs(x)).toBeLessThanOrEqual(bell(y) * 1.03 + 0.05);
      voxels.add(`${Math.floor(x / 0.25)},${Math.floor(y / 0.25)},${Math.floor((res.anat[i * 3 + 2] as number) / 0.25)}`);
    }
    // Spread along the fibres, not piled in one blob: many occupied cells, none holding a tenth of them.
    expect(voxels.size).toBeGreaterThan(undated.length / 8);
    const counts = new Map<string, number>();
    for (const i of undated) {
      const k = `${Math.floor((res.anat[i * 3] as number) / 0.25)},${Math.floor((res.anat[i * 3 + 1] as number) / 0.25)},${Math.floor((res.anat[i * 3 + 2] as number) / 0.25)}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBeLessThan(undated.length / 10);
  });

  it("is deterministic per seed", () => {
    const again = computePlacement(index, anatomy, params);
    for (let i = 0; i < index.count; i++) if (index.cols.pop[i] === Population.Record && isUndatedRecord(index, i)) expect(again.anat[i * 3 + 1]).toBe(res.anat[i * 3 + 1]);
  });

  it("leaves the figure with no point below the lowest strand's floor", () => {
    expect(anatomy.bounds.min[1]).toBeGreaterThan(FIGURE.cord.floorY - 0.05);
    let lowest = Infinity;
    for (let i = 0; i < index.count; i++) {
      const y = res.anat[i * 3 + 1] as number;
      if (Number.isFinite(y) && y < lowest) lowest = y;
    }
    expect(lowest).toBeGreaterThanOrEqual(FIGURE.cord.floorY - FIGURE.fronds.floorMargin - 0.05);
  });
});

describe("big conversations", () => {
  it("are spread over several strands, so none makes a colour clump", () => {
    const byConv = new Map<number, number[]>();
    for (let i = 0; i < index.count; i++) {
      const row = index.cols.conv[i] as number;
      if (index.cols.pop[i] !== Population.Record || row === NONE32 || !Number.isFinite(res.tau[i] as number)) continue;
      let l = byConv.get(row);
      if (!l) byConv.set(row, (l = []));
      l.push(i);
    }
    const big = [...byConv.values()].filter((l) => l.length >= 100 && (res.tau[l[0] as number] as number) > 0.2);
    expect(big.length).toBeGreaterThan(2);
    for (const l of big) {
      const cells = new Set<string>();
      for (const i of l) cells.add([0, 1, 2].map((d) => Math.floor((res.anat[i * 3 + d] as number) / 0.2)).join(","));
      expect(cells.size).toBeGreaterThan(l.length / 8);
    }
    expect(FIGURE.fronds.parts.max).toBeGreaterThan(8);
  });
});
