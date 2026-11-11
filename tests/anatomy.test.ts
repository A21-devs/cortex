/**
 * Body figure anatomy and line families (P05): the spine's direction and per-month activity (FIG-05), the neck
 * sheath (FIG-06), the body field (FIG-08), note-link fibres (FIG-62) and the stem strength (FIG-70).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { linkAlpha, stemAlpha } from "../src/render/lineAlpha";
import { createLinesLayer, LINE_FAMILY } from "../src/render/layers/lines";
import { RENDER_TUNING } from "../src/render/tuning";
import { Population, type DataIndex } from "../src/shared/index-format";
import { HAZE_KINDS, LINE_FAMILIES, type PlacementParams, type PlacementResult, type VisibilityParams } from "../src/shared/protocol/worker";
import {
  activityBrightness,
  bodyFieldCount,
  brightnessAt,
  buildAnatomy,
  envelopeHalfWidth,
  FIGURE,
  HAZE_BUDGET,
  HAZE_TOTAL,
  hazeBrightness,
  orderedTau,
  spineActivity,
  type AnatomyModel,
} from "../src/worker/anatomy";
import { computeLines, LINK_CAP, strongestLinks } from "../src/worker/lines";
import { computePlacement, computeSpineTime } from "../src/worker/placement";
import { buildSampleIndex } from "../src/worker/sampleIndex";

const NOW = Date.UTC(2026, 10, 9);
const VIS = {} as VisibilityParams;
const params = (spineOrder?: "oldest-at-brain" | "newest-at-brain"): PlacementParams => ({
  seed: 7,
  pose: "standing",
  placement: "area",
  order: "oldest",
  depthKey: "time",
  gamma: 0.6,
  visibility: VIS,
  ...(spineOrder ? { spineOrder } : {}),
});

let anatomy: AnatomyModel;
let index: DataIndex;
let oldest: PlacementResult;
let newest: PlacementResult;

beforeAll(() => {
  anatomy = buildAnatomy(7, 20_000);
  index = buildSampleIndex(7, NOW);
  oldest = computePlacement(index, anatomy, params());
  newest = computePlacement(index, anatomy, params("newest-at-brain"));
}, 120_000);

describe("FIG-05 spine order", () => {
  it("swaps the first and last tau when newest sits at the brain, and keeps oldest-at-brain unchanged", () => {
    const first = FIGURE.tau.start;
    const last = FIGURE.tau.start + FIGURE.tau.span;
    expect(orderedTau("oldest-at-brain", first)).toBe(first);
    expect(orderedTau(undefined, last)).toBe(last);
    expect(orderedTau("newest-at-brain", first)).toBeCloseTo(last, 12);
    expect(orderedTau("newest-at-brain", last)).toBeCloseTo(first, 12);
    expect(orderedTau("newest-at-brain", orderedTau("newest-at-brain", 0.37))).toBeCloseTo(0.37, 12);
    expect(Number.isNaN(orderedTau("newest-at-brain", Number.NaN))).toBe(true);
  });

  it("places the newest entries higher than the oldest when the spine runs newest-at-brain, and the reverse by default", () => {
    const st = computeSpineTime(index);
    const dated: number[] = [];
    for (let i = 0; i < index.count; i++) if (Number.isFinite(st.tau[i] as number) && Number.isFinite(oldest.anat[i * 3 + 1] as number)) dated.push(i);
    dated.sort((a, b) => (st.tau[a] as number) - (st.tau[b] as number));
    expect(dated.length).toBeGreaterThan(40);
    const k = Math.max(5, Math.floor(dated.length * 0.1));
    const meanY = (res: PlacementResult, ords: number[]): number => ords.reduce((s, o) => s + (res.anat[o * 3 + 1] as number), 0) / ords.length;
    const old = dated.slice(0, k);
    const recent = dated.slice(-k);
    expect(meanY(oldest, old)).toBeGreaterThan(meanY(oldest, recent));
    expect(meanY(newest, recent)).toBeGreaterThan(meanY(newest, old));
    // The age ramp (tau in the result) is the data's own and does not change with the direction.
    for (const o of dated.slice(0, 20)) expect(newest.tau[o]).toBe(oldest.tau[o]);
  });

  it("brightens a month's stretch of the cord with its entries, monotonic in count", () => {
    let prev = -1;
    for (const c of [0, 1, 2, 5, 10, 40]) {
      const b = activityBrightness(c, 40);
      expect(b).toBeGreaterThan(prev);
      prev = b;
    }
    expect(activityBrightness(0, 40)).toBeCloseTo(0.6, 12);
    expect(activityBrightness(40, 40)).toBeCloseTo(1.4, 12);
    // Three months of 1, 4 and 9 entries, in order along the cord.
    const month = (m: number, d: number): number => Date.UTC(2026, m, d);
    const times: number[] = [month(0, 3), ...[1, 2, 3, 4].map((d) => month(1, d)), ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => month(2, d))];
    const taus = times.map((_, i) => 0.1 + (0.8 * i) / (times.length - 1));
    const act = spineActivity(times, taus);
    expect(act).not.toBeNull();
    expect(Array.from(act?.counts ?? [])).toEqual([1, 4, 9]);
    const b = Array.from(act?.bright ?? []);
    expect(b[0]).toBeLessThan(b[1] as number);
    expect(b[1]).toBeLessThan(b[2] as number);
    expect(brightnessAt(act, 0.9)).toBe(b[2]);
    expect(brightnessAt(act, 0.1)).toBe(b[0]);
    // Off the ends of the dated record the thread rests at the base.
    expect(brightnessAt(act, 0.02)).toBeCloseTo(0.6, 12);
    expect(brightnessAt(null, 0.5)).toBe(1);
  });

  it("writes a brightness for the cord thread only, mirrored for newest-at-brain", () => {
    for (const res of [oldest, newest]) {
      const bright = res.haze.bright as Float32Array;
      expect(bright.length).toBe(res.haze.count);
      const thread = HAZE_KINDS.indexOf("thread");
      let varied = false;
      for (let i = 0; i < res.haze.count; i++) {
        const v = bright[i] as number;
        if ((res.haze.kind[i] as number) === thread) {
          expect(v).toBeGreaterThanOrEqual(0.6 - 1e-6);
          expect(v).toBeLessThanOrEqual(1.4 + 1e-6);
          if (Math.abs(v - 1) > 0.01) varied = true;
        } else expect(v).toBe(1);
      }
      expect(varied).toBe(true);
    }
    // A thread point at geometric tau reads the data's tau mirrored when the spine runs newest-at-brain.
    const act = spineActivity([Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2), Date.UTC(2026, 1, 1)], [0.1, 0.15, 0.9]);
    const tau = new Float32Array([0.12, 0.88]);
    const a = hazeBrightness({ count: 2, tau }, act, "oldest-at-brain");
    const b = hazeBrightness({ count: 2, tau }, act, "newest-at-brain");
    expect(a[0]).toBeGreaterThan(a[1] as number);
    expect(b[0]).toBeLessThan(b[1] as number);
  });
});

describe("FIG-06 neck sheath and FIG-08 body field", () => {
  it("builds two columns of 120 neck points, one either side of the cord, flagged as haze", () => {
    const neck = HAZE_KINDS.indexOf("neck");
    const left: number[] = [];
    const right: number[] = [];
    for (let i = 0; i < anatomy.haze.count; i++) {
      if ((anatomy.haze.kind[i] as number) !== neck) continue;
      const x = anatomy.haze.pos[i * 3] as number;
      const y = anatomy.haze.pos[i * 3 + 1] as number;
      expect(y).toBeLessThanOrEqual(FIGURE.brainstem.bottomY + 0.1);
      expect(y).toBeGreaterThanOrEqual(FIGURE.haze.neck.bottomY - 0.1);
      (x > 0 ? left : right).push(x);
    }
    expect(left).toHaveLength(120);
    expect(right).toHaveLength(120);
    expect(HAZE_BUDGET.neck).toBe(240);
    expect(RENDER_TUNING.intensity.haze.neck).toBeCloseTo(0.06, 12);
  });

  it("sizes the body field at 0.8% of the point budget between 200 and 1,800", () => {
    expect(bodyFieldCount(100_000)).toBe(800);
    expect(bodyFieldCount(10_000)).toBe(200);
    expect(bodyFieldCount(5_000_000)).toBe(1800);
    expect(bodyFieldCount(Number.NaN)).toBe(1800);
    const body = HAZE_KINDS.indexOf("body");
    let n = 0;
    for (let i = 0; i < anatomy.haze.count; i++) {
      if ((anatomy.haze.kind[i] as number) !== body) continue;
      n++;
      const x = anatomy.haze.pos[i * 3] as number;
      const y = anatomy.haze.pos[i * 3 + 1] as number;
      expect(Math.abs(x)).toBeLessThanOrEqual(envelopeHalfWidth(y) + 1e-4);
    }
    expect(n).toBe(HAZE_BUDGET.bodyField);
    expect(RENDER_TUNING.intensity.haze.body).toBeGreaterThanOrEqual(0.02);
    expect(RENDER_TUNING.intensity.haze.body).toBeLessThanOrEqual(0.08);
  });

  it("keeps both sets in the haze buffer, away from the pickable points", () => {
    expect(anatomy.haze.count).toBe(HAZE_TOTAL);
    for (const res of [oldest, newest]) {
      // Pickable points are the index's items; the haze is a separate buffer the picker never reads.
      expect(res.anat.length).toBe(index.count * 3);
      expect(res.haze.count).toBe(HAZE_TOTAL);
      expect(res.haze.kind.length).toBe(res.haze.count);
    }
  });
});

describe("FIG-62 note-link fibres", () => {
  it("keeps each pair once, strongest first, and never more than the cap", () => {
    // A star around 0 (degree 4) and a lone pair 5-6.
    const adj: number[][] = [[1, 2, 3, 4], [0], [0], [0], [0], [6], [5]];
    const offsets = [0];
    const targets: number[] = [];
    for (const row of adj) {
      targets.push(...row);
      offsets.push(targets.length);
    }
    const all = strongestLinks(offsets, targets, adj.length, () => true);
    expect(all).toHaveLength(5);
    expect(all[all.length - 1]).toEqual([5, 6]);
    expect(strongestLinks(offsets, targets, adj.length, () => true, 2)).toHaveLength(2);
    expect(strongestLinks(offsets, targets, adj.length, (o) => o !== 0)).toEqual([[5, 6]]);
  });

  it("draws the link family from the index's note links and stays within the cap", () => {
    const res = computeLines(index, oldest.anat, { families: ["link"], visibility: VIS, budget: 60_000 }, "standing");
    expect(res.segments).toBeLessThanOrEqual(LINK_CAP);
    if (index.rel.noteLinks.targets.length > 0) expect(res.segments).toBeGreaterThan(0);
    const fam = LINE_FAMILIES.indexOf("link");
    for (let s = 0; s < res.segments; s++) {
      expect(res.family[s]).toBe(fam);
      expect(index.cols.pop[res.owner[s] as number]).toBe(Population.Note);
    }
    // Not asked for: not drawn.
    expect(computeLines(index, oldest.anat, { families: ["source"], visibility: VIS, budget: 60_000 }, "standing").family.includes(fam)).toBe(false);
  });

  it("brightens the fibres from 0.05 at home to 0.18 closer than 0.6 x home", () => {
    expect(linkAlpha(25, 25)).toBeCloseTo(0.05, 12);
    expect(linkAlpha(40, 25)).toBeCloseTo(0.05, 12);
    expect(linkAlpha(0.6 * 25, 25)).toBeCloseTo(0.18, 12);
    expect(linkAlpha(5, 25)).toBeCloseTo(0.18, 12);
    const mid = linkAlpha(0.8 * 25, 25);
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(0.18);
    expect(linkAlpha(10, 0)).toBeCloseTo(0.05, 12);
  });
});

describe("FIG-70 stem strength", () => {
  it("takes the stem alpha straight from the strength, 0 hiding them", () => {
    expect(stemAlpha(0)).toBe(0);
    expect(stemAlpha(0.1)).toBe(0.1);
    expect(stemAlpha(0.55)).toBe(0.55);
    expect(stemAlpha(3)).toBe(1);
    expect(stemAlpha(-1)).toBe(0);
    expect(stemAlpha(Number.NaN)).toBe(0);
    const layer = createLinesLayer();
    const stem = layer.objects[LINE_FAMILY.Stem];
    const uniforms = (stem?.material as unknown as { uniforms: Record<string, { value: number }> }).uniforms;
    layer.setAlpha(LINE_FAMILY.Stem, stemAlpha(0.4));
    expect(uniforms.uAlpha?.value).toBeCloseTo(0.4, 12);
    expect(uniforms.uAlphaFar?.value).toBeCloseTo(0.4, 12);
    layer.setAlpha(LINE_FAMILY.Stem, stemAlpha(0));
    expect(uniforms.uAlpha?.value).toBe(0);
    layer.dispose();
  });
});
