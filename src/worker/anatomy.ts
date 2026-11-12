/**
 * Procedural anatomy (Cortex's own geometry). Owner: E8. CORTEX-UX §6.2 (v1.2, "the figure stands") is normative.
 * EVERY geometry, camera and timing number lives in the single exported `FIGURE` object below;
 * tests/layout-worker.test.ts pins them.
 *
 * Frame (scene units, the standing figure is about 10 high): +Y up, +X the figure's LEFT, +Z the front (the face
 * looks toward +Z). The generator is written once, in this standing frame; Lying rotates the finished figure +90°
 * about Z (poseXYZ). Key heights: crown 5.00, cerebellum base 2.74, cord tip −4.02, lowest cauda nerve −4.32,
 * lowest point of the figure −4.36 (the lowest strand floor).
 *  - the brain at the top: a folded cerebrum split by its longitudinal fissure, a temporal lobe under each side, the
 *    cerebellum tucked under the back; the brainstem under it;
 *  - the spinal cord: a Catmull–Rom curve down the centre with the spine's gentle S. τ is its arc fraction, 0 at the
 *    top of the brainstem, 1 at the tip: time runs DOWN it (oldest at the brainstem, newest at the tip);
 *  - 31 exit levels, each with a pair of spinal nerves that leave the cord and arch outward and downward round a torso
 *    envelope (wider at the shoulders and hips, narrower at the waist) like ribs; the cauda equina fans out at the bottom;
 *  - undated entries lie faintly along the lowest fibres of the leaf; the cord ends in a plain tip.
 * The default pose is read from the shared settings (DEFAULT_SETTINGS), never hard-coded here.
 * Slot sets are deterministic per (seed, slot count); counts are bucketed so a growing vault keeps its slots.
 */
import { CAMERA_NUMBERS } from "../shared/cameraNumbers";
import { CortexError } from "../shared/errors";
import { Region, type RegionId } from "../shared/packs";
import type { HazeKind, SpineOrderParam, Vec3 } from "../shared/protocol/worker";
import { DEFAULT_SETTINGS, type Pose } from "../shared/settings";
import {
  arcPolyline,
  catmullRom,
  clamp,
  clamp01,
  insideSuperellipsoid,
  interpTable,
  lerp,
  pointAt,
  randomDirection,
  streamRng,
  superellipsoidRadius,
  tangentAt,
  TAU,
  wrapAngle,
  type ArcPolyline,
  type Rng,
} from "./geom";

// ───────────────────────────── the constants (one object) ─────────────────────────────

/** One group of spinal nerves: [first, last] of leave angle a0 (°), extra bend Δa (°), wrap limit φmax (°), length. */
interface NerveGroup {
  names: readonly string[];
  leave: readonly [number, number];
  bend: readonly [number, number];
  wrap: readonly [number, number];
  length: readonly [number, number];
}
const names = (p: string, n: number, from = 1): string[] => Array.from({ length: n }, (_, i) => `${p}${i + from}`);
const NERVE_GROUPS: readonly NerveGroup[] = [
  { names: names("C", 4), leave: [38, 18], bend: [16, 24], wrap: [60, 72], length: [0.6, 1.3] },
  { names: names("C", 4, 5), leave: [8, 3], bend: [34, 48], wrap: [84, 90], length: [2.25, 3.3] },
  { names: names("T", 4), leave: [3, 4], bend: [52, 60], wrap: [92, 92], length: [3.45, 3.55] },
  { names: names("T", 4, 5), leave: [5, 7], bend: [60, 58], wrap: [92, 92], length: [3.4, 3.0] },
  { names: names("T", 4, 9), leave: [8, 14], bend: [56, 50], wrap: [90, 90], length: [2.8, 2.35] },
  { names: names("L", 5), leave: [18, 42], bend: [46, 30], wrap: [90, 80], length: [2.4, 3.0] },
  { names: ["S1"], leave: [46, 46], bend: [22, 22], wrap: [76, 76], length: [2.8, 2.8] },
  { names: [...names("S", 4, 2), "Co1"], leave: [30, 45], bend: [58, 43], wrap: [70, 30], length: [1.95, 0.84] },
];

/** Exit level heights: C1–C8, T1–T12, L1–L5, S1–S5, Co1 (31). */
function exitHeights(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 8; i++) out.push(2.62 - 0.09 * i);
  for (let i = 0; i < 12; i++) out.push(1.84 - 0.2285 * i);
  for (let i = 0; i < 5; i++) out.push(-0.94 - 0.3 * i);
  for (let i = 0; i < 5; i++) out.push(-2.4 - 0.22 * i);
  out.push(-3.56);
  return out;
}

/** The 31-row nerve table: [name, exit y, leave°, bend°, wrap°, full length]. */
function nerveRows(): [string, number, number, number, number, number][] {
  const ys = exitHeights();
  const rows: [string, number, number, number, number, number][] = [];
  let k = 0;
  for (const g of NERVE_GROUPS) {
    const n = g.names.length;
    for (let i = 0; i < n; i++, k++) {
      const t = n > 1 ? i / (n - 1) : 0;
      rows.push([g.names[i] as string, ys[k] as number, lerp(g.leave[0], g.leave[1], t), lerp(g.bend[0], g.bend[1], t), lerp(g.wrap[0], g.wrap[1], t), lerp(g.length[0], g.length[1], t)]);
    }
  }
  return rows;
}

export const FIGURE = {
  /** Generation version: part of every slots key, bump when the geometry changes. */
  version: 3,
  /** Crown height (y). */
  crownY: 5.0,
  brain: {
    centre: [0, 4.0, 0.06],
    cerebrum: {
      axes: [1.42, 1.02, 1.6],
      exponent: 2.3,
      /** Nothing below this height (the flat base where the brainstem enters). */
      baseY: 3.4,
      /** Longitudinal fissure: no slots with |x| < fissureHalf over the crown (y > fissureY) and down the back (z < fissureBackZ). */
      fissureHalf: 0.06,
      fissureY: 3.78,
      fissureBackZ: -0.55,
      /** Share of cerebrum slots on the folded surface; the rest fill the inside at radius × U^0.5 × 0.86. */
      shell: 0.88,
      interiorScale: 0.86,
      interiorPower: 0.5,
      /** No cerebrum slot below this height behind this z (the cerebellum sits there). */
      cerebellumRoom: { y: 3.53, z: -0.35 },
    },
    /** Cerebrum shaping: poles narrowed, orbital surface lifted, occipital pole lowered, the fissure as a groove. */
    shape: {
      frontNarrow: 0.12,
      backNarrow: 0.1,
      poleStart: 0.3,
      poleSpan: 1.2,
      orbitalLift: 0.22,
      orbitalStart: 0.2,
      orbitalSpan: 1.0,
      underSpan: 0.8,
      occipitalLower: 0.08,
      occipitalStart: 0.8,
      occipitalSpan: 0.8,
      grooveDepth: 0.26,
      grooveWidth: 0.07,
      grooveRise: 0.2,
      grooveSpan: 1.0,
      grooveBackStart: 0.55,
      grooveBackSpan: 0.9,
    },
    /** Lateral sulcus: a slot along the line (z, y) from `from` to `to`, width `width[0]` → `width[1]`, on |x| > minAbsX. */
    sulcus: { from: [1.02, 3.55], to: [-0.46, 4.0], width: [0.045, 0.065], minAbsX: 0.5 },
    /** Gyri: a crest field f from two octaves of isotropic wave noise (16 directions each); kept with 0.04 + 0.96 f⁷. */
    folds: {
      octaves: [
        { k: 11, waves: 16, amp: 1 },
        { k: 19, waves: 16, amp: 0.4 },
      ],
      width: 0.55,
      acceptFloor: 0.04,
      acceptPower: 7,
      /** Pushed in by `relief × (mid − f)` where f < mid. */
      relief: 0.04,
      mid: 0.55,
    },
    temporal: { centre: [0.8, 3.5, 0.34], axes: [0.34, 0.31, 0.76], exponent: 2.2, poleLower: 0.1, outsideCerebrum: 0.97 },
    cerebellum: {
      centre: [0, 3.16, -0.86],
      axes: [1.02, 0.42, 0.62],
      shell: 0.85,
      fillPower: 0.4,
      /** Folia: bands round the transverse axis, slots kept with floor + (1 − floor) × ridge³. */
      folia: 20,
      foliaFloor: 0.15,
      /** Vermis notch at x = 0. */
      vermisDepth: 0.07,
      vermisHalf: 0.065,
    },
    /** Shares of the brain slot set (cerebrum, both temporal lobes, cerebellum; a few brainstem slots for By role). */
    shares: { cerebrum: 0.72, temporal: 0.1, cerebellum: 0.16, brainstem: 0.02 },
    /** Slot set size: ≥ min, ≥ slack × the busiest territory's need; bucketed so it rarely changes. */
    slots: {
      min: 20_000,
      slack: 1.15,
      max: 400_000,
      buckets: [20_000, 25_000, 32_000, 40_000, 50_000, 64_000, 80_000, 100_000, 128_000, 160_000, 200_000, 256_000, 320_000, 400_000],
    },
    /** Region tests (brain-local: f = toward the front (+Z), u = up from the centre, s = |x|), SPEC §4.2 boundaries. */
    regions: {
      prefrontal: 0.55,
      occipital: -0.55,
      frontalLow: -0.3,
      temporalSide: 0.45,
      temporalLow: -0.3,
      temporalBack: -0.55,
      limbicSide: 0.3,
      limbicLow: -0.7,
      limbicHigh: -0.2,
      limbicDepth: 0.5,
    },
    /** Scatter centre of a note: this fraction of the way from its part's centre to the slot. */
    scatterCore: 0.9,
  },
  /** Brainstem: along the cord's first stretch, from the top (y 3.58) to the first cervical exit (y 2.74). */
  brainstem: {
    topY: 3.58,
    bottomY: 2.74,
    /** The pons swells forward (+Z) by this share. */
    pons: { at: 0.3, width: 0.16, swell: 0.35 },
    /** Slot positions use the tube; `bottom` is the scatter centre of these slots. */
    bottom: [0, 2.74, -0.08],
  },
  cord: {
    /** Centre line control points (y, z), x = 0, from the top of the brainstem to the tip: the spine's S in side view. */
    control: [
      [3.58, 0.0],
      [3.3, 0.08],
      [3.02, 0.02],
      [2.78, -0.08],
      [2.5, -0.02],
      [2.22, 0.04],
      [1.9, -0.06],
      [1.3, -0.4],
      [0.55, -0.66],
      [-0.25, -0.58],
      [-0.95, -0.26],
      [-1.65, 0.02],
      [-2.35, -0.1],
      [-2.95, -0.44],
      [-3.5, -0.62],
      [-4.02, -0.5],
    ],
    /** Radius by height: [y, r] (brainstem swell, pons, cervical enlargement, lumbar enlargement, tip). */
    radius: [
      [3.58, 0.2],
      [3.35, 0.25],
      [3.0, 0.15],
      [2.7, 0.1],
      [2.15, 0.115],
      [1.5, 0.095],
      [-0.8, 0.08],
      [-1.6, 0.095],
      [-2.6, 0.07],
      [-4.02, 0.045],
    ],
    tipY: -4.02,
    /** Nothing on a nerve goes below this height. */
    floorY: -4.32,
    samples: 2000,
    /** Mist ring at each exit level: points, radius at the first → last level. */
    ring: { points: 40, radius: [0.15, 0.08] },
  },
  /** Torso envelope: half-width by height (descending y), smoothed over ±smooth; half-depth = depthRatio × width. */
  envelope: {
    y: [2.8, 2.55, 2.3, 2.05, 1.8, 1.5, 1.1, 0.5, -0.1, -0.6, -1.0, -1.4, -1.9, -2.4, -2.9, -3.4, -3.9, -4.32],
    halfWidth: [0.25, 0.35, 0.55, 0.85, 1.2, 1.65, 2.2, 2.8, 3.2, 3.4, 3.5, 3.5, 3.4, 3.2, 2.95, 2.6, 2.2, 1.9],
    smooth: 0.2,
    depthRatio: 0.4,
  },
  /** The 31 spinal nerves as [name, exit y, leave°, extra bend°, wrap limit°, full length]. */
  nerves: {
    rows: nerveRows(),
    steps: 56,
    bendPower: 2.2,
    /** After the wrap limit a nerve only descends, by at most this much more. */
    endDrop: 1.4,
    /** Hanging ends: past the wrap limit a strand descends `speed` of its step, keeps its width but drifts in by `inward` per unit of drop; the drop slows within `floorEase` of the floor. */
    hang: { inward: 0.015, floorEase: 1.5, speed: 0.95 },
    /** Guide nerves (haze): 60 + 50 × length points each (two per segment), scatter 0.01, two twigs per nerve. */
    guide: { base: 24, perLength: 22, jitter: 0.006, twigAt: [[0.62, 0.67], [0.8, 0.85]], twigPoints: 18, twigLength: 0.3, twigAngleDeg: [24, 38] },
    /**
     * Fibre net (the leaf-like body): every guide is `strands` thin strands that leave the cord at the same level but
     * swing out on slightly different courses, so together they fan across the torso instead of lying on one rib.
     * A strand's leave angle varies by ± leaveDeg, its bend and length by the scale ranges, and it runs on a shell of
     * the torso envelope between `shell` (inside the torso, so the net has depth). Strand 0 is the plain course.
     * `shellBias` < 1 crowds strands toward the outer shell (a dense, crisp leaf edge; shell never exceeds the envelope);
     * the last share of every strand (from `tipFrom` of its steps) curves in by up to `tipPull` of its reach, so its end
     * sits inside the smooth envelope instead of poking at it.
     */
    fibres: { strands: 4, leaveDeg: 26, bend: [0.8, 1.9], length: [0.7, 1.7], shell: [0.25, 0.95], shellBias: 1.0, tipFrom: 0.78, tipPull: 0, drop: [0.5, 3.4], endRise: 1.9, endBias: 1.3 },
  },
  fronds: {
    /** A rootlet of this length runs from the cord point at τ to the segment's nerve course. */
    rootlet: 0.22,
    /** Conversations sharing a segment lie side by side: offsets N(0, sigma) in height and depth, scaled from `from` to `to`. */
    ribbon: { sigma: 0.011, from: 0.3, to: 1.2 },
    /** Length fraction f = clamp(base + perLog · ln(1 + n / logScale), min, max) × U(jitter), never below `floor`. */
    length: { base: 0.55, perLog: 0.14, logScale: 10, min: 0.45, max: 1.0, jitter: [0.9, 1.1], floor: 0.12 },
    /** Message i of n sits at arc fraction (i / (n − 1))^arcPower, scatter σ = base + gain · s. */
    arcPower: 0.85,
    jitter: { base: 0.004, gain: 0.009 },
    /** The outer `outer` share of points splays down and outward by up to amount × (low + (1 − low) f). */
    splay: { outer: 0.2, amount: 0.1, low: 0.5 },
    /**
     * A long conversation is spread over several fibre strands of its segment (one per `perMessages` messages, at most
     * `max`), each a different course of the fibre net leaving the cord up to ±`rootSpread` (of the cord) from the first, messages dealt out in turn so time still runs along every
     * strand (from arc `arcFrom`, so none piles up on the cord): no strand carries a dense clump of one colour.
     */
    parts: { perMessages: 40, max: 28, rootSpread: 0.035, arcFrom: 0.1 },
    /** Points outside the torso envelope are pulled back: the excess is kept by this share. */
    edgeKeep: 0.45,
    floorMargin: 0.04,
  },
  /** Single entries sit in the cord core with radial jitter |N(0, 1)| × jitter × radius. */
  core: { jitter: 0.7 },
  /**
   * Undated entries lie faintly along the lowest fibres of the leaf (no cloud below the tip): each takes one of `variants`
   * strands of a level from `fromLevel` (L3) down to the coccyx, on either side, at arc fraction `along`, scatter `jitter`.
   * Levels near the bottom are likelier (weight ∝ 1 + `lowWeight` × depth).
   */
  undated: { fromLevel: 22, variants: 10, along: [0.1, 0.9], jitter: 0.09, lowWeight: 0.4 },
  /** Spine position τ = start + span × (rank · r + linear · ℓ) (CORTEX-UX §6.3). */
  tau: { start: 0.06, span: 0.88, rank: 0.65, linear: 0.35 },
  /**
   * Maps: placed beside their medoid note, nudged this far outward and turned by up to ±spread radians (stable per map),
   * and kept inside the surface by a negative lift, so they scatter through the brain like the reference's white sparks.
   */
  maps: { lift: -0.06, march: 0.02, maxReach: 3, nudge: 0.04, spread: 0.12 },
  haze: {
    brainFolds: 12_000,
    brainVolume: 5_000,
    cerebellum: 2_100,
    brainLips: 1_800,
    cordThread: 3_000,
    brainstem: 700,
    /** Brain fold haze: share on the cerebrum (rest on the temporal lobes); radius scale just outside the slots. */
    foldCerebrumShare: 0.85,
    surfaceScale: 1.015,
    volumePower: 0.33,
    lipOffset: [0.07, 0.02],
    lipDepth: [0.8, 1.0],
    threadReach: 0.85,
    /** Cord thread profile: radius scale at the ends and in the middle; past `fadeFrom` of the cord only `tailKeep` of the points remain at the tip. */
    threadProfile: { ends: 0.8, mid: 1.5, fadeFrom: 0.7, tailKeep: 0.12 },
    /** Vertebra beads: the thread is `count` rungs along the cord; a point's place inside its rung is pulled to the rung's centre (|2f − 1|^pull), so beads sit apart with gaps. */
    beads: { count: 44, pull: 1.7 },
    /**
     * Neck sheath (FIG-06): two faint parallel columns from the brainstem's base down to the top of the torso, ±radius
     * either side of the cord (the radius opens from the first to the last value), slightly forward of it.
     */
    neck: { points: 120, bottomY: 2.1, radius: [0.22, 0.4], jitter: 0.012, forward: 0.12 },
    /**
     * Body field (FIG-08): a sparse Gaussian cloud filling the torso envelope, shoulders included. Its size is `share`
     * of the point budget, kept between `min` and `max`; σ is `sigma` of the half-width (and half-depth) at each height.
     */
    body: { share: 0.008, min: 200, max: 1800, sigma: 0.42, topY: 2.3, bottomY: -3.9 },
    /** Spine activity (FIG-05): thread brightness = base + gain × √(count / busiest month), per month along the cord. */
    activity: { base: 0.6, gain: 0.8 },
  },
  /** Growth (intro, seconds): the cord first from the brainstem down, then the nerves outward, then the brain. */
  timing: {
    introSec: 3.6,
    rebuildSec: 0.9,
    seed: [0, 0.25],
    seedPoints: 12,
    /** A spine point at τ is born at start + span · τ (the travelling tip). */
    spine: { start: 0.25, span: 0.7 },
    frondDelay: 0.08,
    frondUnfurl: 0.45,
    barbUnfurl: 0.2,
    undated: { start: 1.3, span: 0.25 },
    anatomyHaze: [1.8, 2.7],
    bloom: { start: 1.85, span: 1.05 },
    maps: { start: 2.9, span: 0.5 },
    spinEaseIn: { start: 2.9, sec: 1.5 },
  },
  /**
   * Camera numbers for the home view (CORTEX-UX §3.2, §6.8; drawn by render/camera.ts). Standing: the camera sits
   * behind the figure, `headingDeg` round from the frontal pole toward the figure's right and `elevationDeg` above
   * the horizon, aimed at `target`. The default motion is Spin; Lying keeps drift.
   */
  camera: {
    fovDeg: CAMERA_NUMBERS.fovDeg,
    near: CAMERA_NUMBERS.near,
    far: CAMERA_NUMBERS.far,
    standing: { headingDeg: 154, elevationDeg: 9, target: [0, 0.3, -0.2], distance: 25 },
    lying: { yawDeg: 11, elevationDeg: 8 },
    spinPeriodSec: CAMERA_NUMBERS.spinPeriodSec,
    driftPeriodSec: CAMERA_NUMBERS.driftPeriodSec,
    swayDeg: CAMERA_NUMBERS.swayYawAmpDeg,
    swayPeriodSec: CAMERA_NUMBERS.swayPeriodSec,
    /** Auto-framing at the reference stage (1176 × 825). */
    framing: {
      reference: [1176, 825],
      /** The crown sits this fraction of the stage height below the stage top. */
      crownFraction: 0.09,
      /** The figure's lowest point sits this many px above the stage bottom (8 px over the command line). */
      bottomInsetPx: 68,
      centreInsetLeft: 24,
      centreInsetRight: 70,
      clearancePx: 8,
      slideStepPx: 6,
      maxSlidePx: 36,
      shrinkStep: 0.02,
      /** Lying fits its projected bounds into the stage minus these insets (left, top, right, bottom) with a margin. */
      lyingInsets: [24, 86, 70, 76],
      lyingMargin: 0.04,
    },
  },
  /** Small and sparse records (CORTEX-UX §6.13). */
  sparse: { smallRecord: 200, minFrondLength: 0.35, fewNotes: 300, fewNotesSize: 1.4 },
  /** Groups shape (CORTEX-UX §6.12; arrangements.ts). */
  groups: {
    sparseBelow: 30,
    /** Arrangements are scaled so their bounding radius is this (the figure's half-height). */
    targetRadius: 5.2,
    unit: 0.18,
    falloff: 0.45,
    tree: { levelGap: 2.2, nodeGap: 0.12 },
    spine: { columnRadius: 0.16, gap: 0.08, maxLength: 3.2, minLength: 0.25 },
    strata: { maxWidth: 8, thickness: 0.36, gap: 0.12, depth: 1.2, bend: 0.9 },
  },
  /** Line geometry (CORTEX-UX §6.10; lines.ts): source lines are quadratic curves outside the torso. */
  lines: { budget: 60_000, curveSegments: 8, /** A selection draws few lines, so each is cut finer and reads as a smooth arc. */ selectionSegments: 28, clearanceFactor: 2.0, clearanceAdd: 0.2 },
} as const;

// ───────────────────────────── haze kinds ─────────────────────────────

/** Fine haze kinds (CORTEX-UX §12.19.6). The shared protocol still lists the old coarse kinds: see HAZE_PROTOCOL_KIND. */
export const HAZE_SUBS = ["brainFolds", "brainVolume", "cerebellum", "brainLips", "nerve", "twig", "thread", "ring", "brainstem", "neck", "body"] as const;
export type HazeSub = (typeof HAZE_SUBS)[number];
export const HAZE_SUB_INDEX: Readonly<Record<HazeSub, number>> = {
  brainFolds: 0,
  brainVolume: 1,
  cerebellum: 2,
  brainLips: 3,
  nerve: 4,
  twig: 5,
  thread: 6,
  ring: 7,
  brainstem: 8,
  neck: 9,
  body: 10,
};

/** Fine haze sub-kinds onto the protocol kinds (guides and twigs share "nerve"). */
export const HAZE_PROTOCOL_KIND: Readonly<Record<HazeSub, HazeKind>> = {
  brainFolds: "brain",
  brainVolume: "brain",
  cerebellum: "brain",
  brainLips: "brain",
  nerve: "nerve",
  twig: "nerve",
  thread: "thread",
  ring: "ring",
  brainstem: "brainstem",
  neck: "neck",
  body: "body",
};
const PROTOCOL_KIND_INDEX: Readonly<Record<HazeKind, number>> = { brain: 0, nerve: 1, thread: 2, ring: 3, brainstem: 4, undated: 5, body: 6, neck: 7 };
export const HAZE_KIND_INDEX = PROTOCOL_KIND_INDEX;

const NERVE_COUNT = FIGURE.nerves.rows.length;
const GUIDE_POINTS = FIGURE.nerves.rows.reduce((n, r) => n + 2 * FIGURE.nerves.fibres.strands * Math.round(FIGURE.nerves.guide.base + FIGURE.nerves.guide.perLength * (r[5] as number)), 0);
const TWIG_POINTS = NERVE_COUNT * 2 * FIGURE.nerves.guide.twigAt.length * FIGURE.nerves.guide.twigPoints;
const RING_POINTS = NERVE_COUNT * FIGURE.cord.ring.points;

/** Body-field dots for a point budget: 1.5% of it, kept between 300 and 3,000 (FIG-08). */
export function bodyFieldCount(pointBudget: number): number {
  const b = FIGURE.haze.body;
  const raw = Math.round((Number.isFinite(pointBudget) ? pointBudget : DEFAULT_SETTINGS.advanced.pointBudget) * b.share);
  return Math.max(b.min, Math.min(b.max, raw));
}

/** Haze points per fine kind (CORTEX-UX §6.4, §12.19.6); their sum is the renderer's haze capacity. */
export const HAZE_BUDGET = {
  brainFolds: FIGURE.haze.brainFolds,
  brainVolume: FIGURE.haze.brainVolume,
  cerebellum: FIGURE.haze.cerebellum,
  brainLips: FIGURE.haze.brainLips,
  nerveGuides: GUIDE_POINTS,
  nerveTwigs: TWIG_POINTS,
  cordThread: FIGURE.haze.cordThread,
  rings: RING_POINTS,
  brainstem: FIGURE.haze.brainstem,
  neck: FIGURE.haze.neck.points * 2,
  bodyField: bodyFieldCount(DEFAULT_SETTINGS.advanced.pointBudget),
} as const;
export const HAZE_TOTAL = Object.values(HAZE_BUDGET).reduce((a, b) => a + b, 0);

// ───────────────────────────── pose ─────────────────────────────

/** A valid pose, or the shared default (DEFAULT_SETTINGS.general.pose) when the value is missing or unknown. */
export function resolvePose(p: unknown): Pose {
  return p === "standing" || p === "lying" ? p : DEFAULT_SETTINGS.general.pose;
}

/** Skeleton (standing) → world for a pose. Lying = +90° about Z: (x, y, z) → (−y, x, z). */
export function poseXYZ(pose: Pose, x: number, y: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
  if (pose === "lying") {
    out[0] = -y;
    out[1] = x;
  } else {
    out[0] = x;
    out[1] = y;
  }
  out[2] = z;
  return out;
}

/** World → skeleton (inverse of poseXYZ). */
export function unposeXYZ(pose: Pose, x: number, y: number, z: number, out: Vec3 = [0, 0, 0]): Vec3 {
  if (pose === "lying") {
    out[0] = y;
    out[1] = -x;
  } else {
    out[0] = x;
    out[1] = y;
  }
  out[2] = z;
  return out;
}

/** Skeleton → lying world. */
export function toLying(p: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  return poseXYZ("lying", p[0], p[1], p[2], out);
}

/** Lying world → skeleton (standing): −90° about Z, (x, y) → (y, −x). */
export function toStanding(p: Vec3, out: Vec3 = [0, 0, 0]): Vec3 {
  return unposeXYZ("lying", p[0], p[1], p[2], out);
}

/** Pose a packed xyz array (NaN entries stay NaN). Writes into `dst` (may equal `src`). */
export function poseArray(pose: Pose, src: Float32Array, dst: Float32Array = new Float32Array(src.length)): Float32Array {
  const n = Math.floor(src.length / 3);
  if (pose === "lying") {
    for (let i = 0; i < n; i++) {
      const x = src[i * 3] as number;
      const y = src[i * 3 + 1] as number;
      dst[i * 3] = -y;
      dst[i * 3 + 1] = x;
      dst[i * 3 + 2] = src[i * 3 + 2] as number;
    }
  } else if (dst !== src) {
    dst.set(src.subarray(0, n * 3));
  }
  return dst;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** Axis-aligned bounds of a posed box (exact: the pose is a quarter turn). */
export function poseBounds(pose: Pose, b: Bounds): Bounds {
  if (pose !== "lying") return { min: [...b.min] as Vec3, max: [...b.max] as Vec3 };
  return { min: [-b.max[1], b.min[0], b.min[2]], max: [-b.min[1], b.max[0], b.max[2]] };
}

const DEG = Math.PI / 180;

/** Unit vector from the figure toward the home camera, in world coordinates for the pose. */
export function homeDirection(pose: Pose, out: Vec3 = [0, 0, 0]): Vec3 {
  if (pose === "lying") {
    const c = FIGURE.camera.lying;
    const yaw = c.yawDeg * DEG;
    const el = c.elevationDeg * DEG;
    out[0] = Math.cos(el) * Math.sin(yaw);
    out[1] = Math.sin(el);
    out[2] = Math.cos(el) * Math.cos(yaw);
    return out;
  }
  // Heading is measured from the frontal pole (+Z) round toward the figure's right (−X): 154° is behind and to its right.
  const c = FIGURE.camera.standing;
  const h = c.headingDeg * DEG;
  const el = c.elevationDeg * DEG;
  out[0] = -Math.cos(el) * Math.sin(h);
  out[1] = Math.sin(el);
  out[2] = Math.cos(el) * Math.cos(h);
  return out;
}

/** Screen anchors of the standing home framing for a stage (CSS px, stage-local). */
export function standingFrame(stageWidth: number, stageHeight: number): { crownTop: number; bottom: number; centreX: number } {
  const f = FIGURE.camera.framing;
  return {
    crownTop: f.crownFraction * stageHeight,
    bottom: stageHeight - f.bottomInsetPx,
    centreX: (f.centreInsetLeft + stageWidth - f.centreInsetRight) / 2,
  };
}

// ───────────────────────────── spine (the cord: time) ─────────────────────────────

interface SpineModel {
  poly: ArcPolyline;
  /** Ascending heights with the matching τ and z (for y → τ and zBack(y)). */
  ysAsc: number[];
  tauAsc: number[];
  zAsc: number[];
}

function buildSpine(): SpineModel {
  const cd = FIGURE.cord;
  const nc = cd.samples;
  const pts = new Float64Array((nc + 1) * 3);
  const cy = cd.control.map((p) => p[0]);
  const cz = cd.control.map((p) => p[1]);
  for (let i = 0; i <= nc; i++) {
    const u = i / nc;
    pts[i * 3] = 0;
    pts[i * 3 + 1] = catmullRom(cy, u);
    pts[i * 3 + 2] = catmullRom(cz, u);
  }
  const poly = arcPolyline(pts);
  const ysAsc: number[] = [];
  const tauAsc: number[] = [];
  const zAsc: number[] = [];
  for (let i = poly.count - 1; i >= 0; i--) {
    const y = pts[i * 3 + 1] as number;
    if (ysAsc.length === 0 || y > (ysAsc[ysAsc.length - 1] as number) + 1e-9) {
      ysAsc.push(y);
      tauAsc.push(poly.arc[i] as number);
      zAsc.push(pts[i * 3 + 2] as number);
    }
  }
  return { poly, ysAsc, tauAsc, zAsc };
}

const SPINE = buildSpine();

/** Arc length of the cord in world units. */
export const SPINE_LENGTH = SPINE.poly.length;

/** Point on the cord centre line at spine position τ ∈ [0, 1] (0 = top of the brainstem, 1 = the tip), skeleton frame. */
export function spinePoint(tau: number, out: Vec3 = [0, 0, 0]): Vec3 {
  return pointAt(SPINE.poly, tau, out);
}

/** Unit tangent of the cord at τ, pointing down toward the tip. */
export function spineTangent(tau: number, out: Vec3 = [0, 0, 0]): Vec3 {
  return tangentAt(SPINE.poly, tau, out);
}

/** Spine position τ of the cord point at height y. */
export function tauAtY(y: number): number {
  return interpTable(SPINE.ysAsc, SPINE.tauAsc, y);
}

const RADIUS_YS = FIGURE.cord.radius.map((r) => r[0]).reverse();
const RADIUS_VS = FIGURE.cord.radius.map((r) => r[1]).reverse();

/** Cord radius at height y. */
export function radiusAtY(y: number): number {
  return interpTable(RADIUS_YS, RADIUS_VS, y);
}

/** Cord radius at τ. */
export function spineRadius(tau: number): number {
  return radiusAtY(spinePoint(clamp01(tau), scratchRoot)[1]);
}

/**
 * Where a spine position τ sits along the cord for a direction of time (FIG-05). Oldest at the brain keeps τ; newest at
 * the brain mirrors it inside the span entries use, so the first and last τ swap. NaN stays NaN. τ itself (the age
 * ramp) never changes: only the place on the cord does.
 */
export function orderedTau(order: SpineOrderParam | undefined, tau: number): number {
  if (order !== "newest-at-brain" || !Number.isFinite(tau)) return tau;
  return 2 * FIGURE.tau.start + FIGURE.tau.span - tau;
}

/** Pull a uniform τ in [0, 1) into vertebra beads: each of `beads.count` rungs keeps its points near its centre. Stays in [0, 1), monotonic. */
export function beadTau(raw: number): number {
  const { count, pull } = FIGURE.haze.beads;
  const x = Math.min(Math.max(raw, 0), 1 - 1e-9) * count;
  const rung = Math.floor(x);
  const g = 2 * (x - rung) - 1;
  const f = 0.5 + 0.5 * Math.sign(g) * Math.pow(Math.abs(g), pull);
  return (rung + f) / count;
}

/** Brightness of a thread bin with `count` entries when the busiest has `max`: 0.6 + 0.8 √(count / max). */
export function activityBrightness(count: number, max: number): number {
  const a = FIGURE.haze.activity;
  return a.base + a.gain * Math.sqrt(max > 0 ? Math.max(0, Math.min(1, count / max)) : 0);
}

/** Entries per calendar month along the cord, as a brightness for every stretch of it. */
export interface SpineActivity {
  /** Where each month's stretch of the cord starts (ascending τ); the first starts at the oldest entry. */
  starts: Float64Array;
  counts: Uint32Array;
  bright: Float64Array;
  /** The cord between these has entries; outside it the thread rests at the base brightness. */
  lo: number;
  hi: number;
}

/**
 * Bin dated record entries by month along the cord. `times` (epoch ms) ascending with `taus`, the entry's τ at each
 * (also ascending). A month owns the stretch from the middle of the gap behind it to the middle of the gap ahead.
 */
export function spineActivity(times: ArrayLike<number>, taus: ArrayLike<number>): SpineActivity | null {
  const n = Math.min(times.length, taus.length);
  if (n === 0) return null;
  const firsts: number[] = [];
  const lasts: number[] = [];
  const counts: number[] = [];
  let prevKey = Number.NaN;
  for (let k = 0; k < n; k++) {
    const d = new Date(times[k] as number);
    const key = d.getUTCFullYear() * 12 + d.getUTCMonth();
    if (key !== prevKey) {
      firsts.push(taus[k] as number);
      lasts.push(taus[k] as number);
      counts.push(0);
      prevKey = key;
    }
    lasts[lasts.length - 1] = taus[k] as number;
    counts[counts.length - 1] = (counts[counts.length - 1] as number) + 1;
  }
  const m = counts.length;
  const max = Math.max(...counts);
  const starts = new Float64Array(m);
  const bright = new Float64Array(m);
  for (let g = 0; g < m; g++) {
    starts[g] = g === 0 ? (firsts[0] as number) : ((lasts[g - 1] as number) + (firsts[g] as number)) / 2;
    bright[g] = activityBrightness(counts[g] as number, max);
  }
  return { starts, counts: Uint32Array.from(counts), bright, lo: firsts[0] as number, hi: lasts[m - 1] as number };
}

/** Thread brightness multiplier at a data-side spine position τ. */
export function brightnessAt(a: SpineActivity | null, tau: number): number {
  if (!a) return 1;
  const base = FIGURE.haze.activity.base;
  if (!Number.isFinite(tau) || tau < a.lo || tau > a.hi) return base;
  let lo = 0;
  let hi = a.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((a.starts[mid] as number) <= tau) lo = mid;
    else hi = mid - 1;
  }
  return a.bright[lo] as number;
}

/**
 * Brightness multiplier per haze point: the cord thread follows the month's activity at its place on the cord (the
 * data-side τ is the mirror of the point's own when the spine runs newest-at-brain); every other point is 1.
 */
export function hazeBrightness(haze: { count: number; tau: Float32Array }, activity: SpineActivity | null, order: SpineOrderParam | undefined): Float32Array {
  const out = new Float32Array(haze.count).fill(1);
  if (!activity) return out;
  for (let i = 0; i < haze.count; i++) {
    const t = haze.tau[i] as number;
    if (Number.isFinite(t)) out[i] = brightnessAt(activity, orderedTau(order, t));
  }
  return out;
}

// ───────────────────────────── torso envelope ─────────────────────────────

const ENV_YS = [...FIGURE.envelope.y].reverse();
const ENV_WS = [...FIGURE.envelope.halfWidth].reverse();
export const ENVELOPE_MAX_HALF_WIDTH = Math.max(...FIGURE.envelope.halfWidth);

/** Exact smoothed envelope half-width (three table lookups). */
export function envelopeHalfWidthExact(y: number): number {
  const s = FIGURE.envelope.smooth;
  return 0.5 * interpTable(ENV_YS, ENV_WS, y) + 0.25 * (interpTable(ENV_YS, ENV_WS, y + s) + interpTable(ENV_YS, ENV_WS, y - s));
}

/** Dense tables over the figure's height so nerve tracing (the hot loop of placement) reads in O(1). */
const LUT_Y0 = -6;
const LUT_Y1 = 4;
const LUT_PER_UNIT = 400;
const LUT_N = (LUT_Y1 - LUT_Y0) * LUT_PER_UNIT + 1;
const ENV_LUT = new Float64Array(LUT_N);
const ZBACK_LUT = new Float64Array(LUT_N);
for (let i = 0; i < LUT_N; i++) {
  const y = LUT_Y0 + i / LUT_PER_UNIT;
  ENV_LUT[i] = envelopeHalfWidthExact(y);
  ZBACK_LUT[i] = interpTable(SPINE.ysAsc, SPINE.zAsc, y);
}

function lut(table: Float64Array, y: number): number {
  const x = (y - LUT_Y0) * LUT_PER_UNIT;
  if (x <= 0) return table[0] as number;
  if (x >= LUT_N - 1) return table[LUT_N - 1] as number;
  const i = Math.floor(x);
  const f = x - i;
  return (table[i] as number) * (1 - f) + (table[i + 1] as number) * f;
}

/** z of the cord (the back line of the torso) at height y. */
export function zBack(y: number): number {
  return lut(ZBACK_LUT, y);
}

/** Torso half-width at height y (shoulders, waist, hips). */
export function envelopeHalfWidth(y: number): number {
  return lut(ENV_LUT, y);
}

/** Keep a point's x inside the torso envelope at height y: whatever lies beyond the smooth edge is pulled back (the excess × `keep`). */
export function clipToEnvelope(x: number, y: number, keep: number = FIGURE.fronds.edgeKeep): number {
  const w = envelopeHalfWidth(y);
  const a = Math.abs(x);
  return a <= w ? x : Math.sign(x) * (w + (a - w) * keep);
}

/** Keep a point's z inside the torso's depth at height y (the cord's back line to the front of the ellipse): the excess × `keep`. */
export function clipToDepth(z: number, y: number, keep: number = FIGURE.fronds.edgeKeep): number {
  const back = zBack(y);
  const front = back + envelopeHalfWidth(y) * FIGURE.envelope.depthRatio;
  return z > front ? front + (z - front) * keep : z < back ? back + (z - back) * keep : z;
}

/** Torso half-depth at height y; the cord runs along the back edge. */
export function envelopeHalfDepth(y: number): number {
  return envelopeHalfWidth(y) * FIGURE.envelope.depthRatio;
}

// ───────────────────────────── nerves ─────────────────────────────

export interface NerveLevel {
  /** Index 0..30 (C1 … Co1). */
  index: number;
  name: string;
  /** Exit height and the cord's τ there. */
  y: number;
  tau: number;
  /** Leave angle below the horizontal, extra bend by the tip, wrap limit (radians) and full length. */
  leave: number;
  bend: number;
  wrap: number;
  length: number;
  /** Fibre variants only: how far past the wrap limit the strand may hang (default FIGURE.nerves.endDrop). */
  drop?: number;
}

export const NERVE_LEVELS: readonly NerveLevel[] = FIGURE.nerves.rows.map((r, index) => ({
  index,
  name: r[0],
  y: r[1],
  tau: tauAtY(r[1]),
  leave: r[2] * DEG,
  bend: r[3] * DEG,
  wrap: r[4] * DEG,
  length: r[5],
}));

/** Exit levels' τ in order (31). */
export const SEGMENT_TAUS: readonly number[] = NERVE_LEVELS.map((l) => l.tau);

/** The spinal segment whose exit level is nearest the cord point at τ (edges at the midpoints between levels). */
export function nerveLevel(tau: number): NerveLevel {
  const y = spinePoint(clamp01(tau), scratchRoot)[1];
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < NERVE_LEVELS.length; i++) {
    const d = Math.abs((NERVE_LEVELS[i] as NerveLevel).y - y);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return NERVE_LEVELS[best] as NerveLevel;
}

const scratchRoot: Vec3 = [0, 0, 0];

/**
 * Trace the nerve of an exit level on `side` (+1 the figure's right = −X, −1 its left = +X) on a shell of the torso
 * envelope (1 = the envelope). It heads out sideways at the level's leave angle a0 below the horizontal and bends
 * further down as a(j) = a0 + Δa (j / steps)^2.2 while it wraps forward round the envelope ellipse until the wrap
 * limit; past the limit it only descends, by at most `endDrop` more; it never goes below `floorY`.
 * Writes steps + 1 points (xyz) into `out`, skeleton frame, and returns the number of steps taken before the wrap limit.
 */
export function traceLevel(level: NerveLevel, side: number, shell: number, floorY: number, out: Float64Array, steps: number = FIGURE.nerves.steps, endY: number = floorY): void {
  const root = spinePoint(level.tau, scratchRoot);
  out[0] = root[0];
  out[1] = root[1];
  out[2] = root[2];
  const depthK = FIGURE.envelope.depthRatio;
  const ds = level.length / steps;
  let y = root[1];
  let phi = 0;
  let extra = 0;
  const maxDrop = level.drop ?? FIGURE.nerves.endDrop;
  const hang = FIGURE.nerves.hang;
  // Past the wrap limit a strand hangs: it keeps the width it had there (it does not follow the envelope inward to a tip).
  let wHold = 0;
  for (let j = 0; j < steps; j++) {
    const a = level.leave + level.bend * Math.pow(j / steps, FIGURE.nerves.bendPower);
    const dh = Math.cos(a) * ds;
    const dv = Math.sin(a) * ds;
    if (phi < level.wrap - 1e-9) {
      const w = envelopeHalfWidth(y) * shell;
      const cp = w * Math.cos(phi);
      const sp = w * depthK * Math.sin(phi);
      phi = Math.min(phi + dh / (Math.sqrt(cp * cp + sp * sp) + 1e-6), level.wrap);
      // Eases into the strand's own end height instead of running onto the floor (where strands would pile up in a flat edge).
      y -= Math.max(0, Math.min(dv, (y - endY) * 0.5));
    } else {
      if (wHold === 0) wHold = envelopeHalfWidth(y) * shell;
      // Slows toward the floor, so the hanging ends thin out instead of piling on one line.
      // Each strand eases toward its own end height `endY` (never reaching it), so the ends are ragged, not piled on the floor.
      const soft = clamp01((y - endY) / hang.floorEase);
      const d = Math.max(1e-4, Math.min(ds * hang.speed * (0.25 + 0.75 * soft), maxDrop - extra, (y - endY) * 0.5));
      extra += d;
      y -= d;
    }
    if (y < floorY) y = floorY;
    const hanging = phi >= level.wrap - 1e-9 && wHold > 0;
    const w = hanging ? wHold * (1 - hang.inward * extra) : envelopeHalfWidth(y) * shell;
    const k = (j + 1) * 3;
    out[k] = -side * w * Math.sin(phi);
    out[k + 1] = y;
    out[k + 2] = zBack(y) + w * depthK * (1 - Math.cos(phi));
  }
}

const COURSES = new Map<number, ArcPolyline>();

/** The cached course of a level's nerve on a side (full length, shell 1) as an arc polyline. */
export function nerveCourse(level: number, side: number): ArcPolyline {
  const key = level * 2 + (side > 0 ? 1 : 0);
  let c = COURSES.get(key);
  if (!c) {
    const buf = new Float64Array((FIGURE.nerves.steps + 1) * 3);
    traceLevel(NERVE_LEVELS[level] as NerveLevel, side, 1, FIGURE.cord.floorY, buf);
    c = arcPolyline(buf);
    COURSES.set(key, c);
  }
  return c;
}

const FIBRE_COURSES = new Map<string, ArcPolyline>();

/**
 * Curve the end of a traced strand inward: from `from` of its steps on, the offset of each point from the cord's back line
 * (x, and z beyond zBack) shrinks smoothly by up to `pull`, so strands end inside the envelope in a smooth curve.
 */
function curveTip(buf: Float64Array, from: number, pull: number): void {
  const n = buf.length / 3 - 1;
  for (let j = 1; j <= n; j++) {
    const t = clamp01((j / n - from) / (1 - from));
    if (t <= 0) continue;
    const f = 1 - pull * t * t * (3 - 2 * t);
    const y = buf[j * 3 + 1] as number;
    const zb = zBack(y);
    buf[j * 3] = (buf[j * 3] as number) * f;
    buf[j * 3 + 2] = zb + ((buf[j * 3 + 2] as number) - zb) * f;
  }
}

/**
 * A variant of a level's nerve course for the fibre net (see FIGURE.nerves.fibres): `u` are four uniform
 * numbers in [0, 1) that pick the leave angle, bend, length and shell. `u` all 0.5 on shell 1 is near the plain course.
 * Cached by quantised `u`, so conversations and haze strands share the same few hundred polylines.
 */
export function fibreCourse(level: number, side: number, u0: number, u1: number, u2: number, u3: number): ArcPolyline {
  const F = FIGURE.nerves.fibres;
  const q = (v: number): number => Math.min(15, Math.max(0, Math.floor(v * 16)));
  const key = `${level}:${side > 0 ? 1 : 0}:${q(u0)}:${q(u1)}:${q(u2)}:${q(u3)}`;
  let c = FIBRE_COURSES.get(key);
  if (!c) {
    const base = NERVE_LEVELS[level] as NerveLevel;
    const v = (k: number): number => (k + 0.5) / 16;
    const variant: NerveLevel = {
      ...base,
      leave: base.leave + (2 * v(q(u0)) - 1) * F.leaveDeg * DEG,
      bend: base.bend * lerp(F.bend[0], F.bend[1], v(q(u1))),
      length: base.length * lerp(F.length[0], F.length[1], v(q(u2))),
      drop: lerp(F.drop[0], F.drop[1], (v(q(u2)) * 3.3 + v(q(u0)) * 1.7) % 1),
    };
    const buf = new Float64Array((FIGURE.nerves.steps + 1) * 3);
    const endY = FIGURE.cord.floorY + F.endRise * Math.pow((v(q(u3)) * 2.3 + v(q(u1)) * 1.7 + v(q(u0)) * 0.9) % 1, F.endBias);
    traceLevel(variant, side, lerp(F.shell[0], F.shell[1], Math.pow(v(q(u3)), F.shellBias)), FIGURE.cord.floorY, buf, FIGURE.nerves.steps, endY);
    curveTip(buf, F.tipFrom, F.tipPull);
    c = arcPolyline(buf);
    FIBRE_COURSES.set(key, c);
  }
  return c;
}

// ───────────────────────────── brain ─────────────────────────────

/** Slot parts. */
export const SlotPart = { Cerebrum: 0, Temporal: 1, Cerebellum: 2, Brainstem: 3 } as const;

interface FoldField {
  wx: Float64Array;
  wy: Float64Array;
  wz: Float64Array;
  ph: Float64Array;
  amp: Float64Array;
  count: number;
}

function makeFolds(rng: Rng): FoldField {
  const oct = FIGURE.brain.folds.octaves;
  const count = oct.reduce((n, o) => n + o.waves, 0);
  const f: FoldField = { wx: new Float64Array(count), wy: new Float64Array(count), wz: new Float64Array(count), ph: new Float64Array(count), amp: new Float64Array(count), count };
  const d: Vec3 = [0, 0, 0];
  let j = 0;
  for (const o of oct) {
    const a = o.amp / Math.sqrt(o.waves);
    for (let w = 0; w < o.waves; w++, j++) {
      randomDirection(rng, d);
      f.wx[j] = d[0] * o.k;
      f.wy[j] = d[1] * o.k;
      f.wz[j] = d[2] * o.k;
      f.ph[j] = rng.next() * TAU;
      f.amp[j] = a;
    }
  }
  return f;
}

/** Fold field at a point: 1 on a gyral crest, 0 in a sulcus. */
function foldAt(f: FoldField, x: number, y: number, z: number): number {
  let n = 0;
  for (let j = 0; j < f.count; j++) n += (f.amp[j] as number) * Math.sin(x * (f.wx[j] as number) + y * (f.wy[j] as number) + z * (f.wz[j] as number) + (f.ph[j] as number));
  return clamp01(1 - Math.abs(n) / FIGURE.brain.folds.width);
}

/** Narrow the poles, lift the orbital surface, lower the occipital pole and sink the midline into the fissure (in place). */
function shapeCerebrum(p: Vec3): void {
  const c = FIGURE.brain.centre;
  const s = FIGURE.brain.shape;
  const ax = FIGURE.brain.cerebrum.axes;
  const qx = p[0] - c[0];
  const qy = p[1] - c[1];
  const qz = p[2] - c[2];
  const front = clamp01((qz - s.poleStart) / s.poleSpan);
  const back = clamp01((-qz - s.poleStart) / s.poleSpan);
  p[0] = c[0] + qx * (1 - s.frontNarrow * front - s.backNarrow * back);
  p[1] += s.orbitalLift * clamp01((qz - s.orbitalStart) / s.orbitalSpan) * clamp01(-qy / s.underSpan);
  p[1] -= s.occipitalLower * clamp01((-qz - s.occipitalStart) / s.occipitalSpan);
  // The fissure: a groove down the midline, deepest over the crown and the back, taken along the radial direction.
  const g = Math.exp(-((qx / s.grooveWidth) ** 2));
  const top = clamp01((qy + s.grooveRise) / s.grooveSpan);
  const rear = clamp01((-qz - s.grooveBackStart) / s.grooveBackSpan);
  const depth = s.grooveDepth * g * Math.max(top, rear);
  const rl = Math.hypot(qy / ax[1], qz / ax[2]) || 1;
  p[1] -= depth * (qy / ax[1] / rl);
  p[2] -= depth * (qz / ax[2] / rl);
}

const dScratch: Vec3 = [0, 0, 0];

/**
 * A point on a folded superellipsoid surface: directions are drawn uniformly, kept with probability
 * floor + (1 − floor) · fold^power (so slots gather on the gyral crests) and pushed in at the sulci.
 * Writes the point into `out` and returns the fold value.
 */
function foldedSurfacePoint(rng: Rng, folds: FoldField, centre: readonly number[], axes: readonly number[], e: number, scale: number, shaped: boolean, out: Vec3): number {
  const fd = FIGURE.brain.folds;
  for (let attempt = 0; ; attempt++) {
    if (attempt > MAX_ATTEMPTS) throw new CortexError("E_INTERNAL", "brain surface sampling found no folds (check FIGURE.brain.folds)");
    randomDirection(rng, dScratch);
    const s = scale * superellipsoidRadius(dScratch[0], dScratch[1], dScratch[2], axes, e);
    out[0] = (centre[0] as number) + dScratch[0] * s;
    out[1] = (centre[1] as number) + dScratch[1] * s;
    out[2] = (centre[2] as number) + dScratch[2] * s;
    if (shaped) shapeCerebrum(out);
    const f = foldAt(folds, out[0], out[1], out[2]);
    if (rng.next() >= fd.acceptFloor + (1 - fd.acceptFloor) * Math.pow(f, fd.acceptPower)) continue;
    const k = 1 - fd.relief * Math.max(0, fd.mid - f);
    out[0] = (centre[0] as number) + (out[0] - (centre[0] as number)) * k;
    out[1] = (centre[1] as number) + (out[1] - (centre[1] as number)) * k;
    out[2] = (centre[2] as number) + (out[2] - (centre[2] as number)) * k;
    return f;
  }
}

const TEMPORAL_LEFT: readonly number[] = [FIGURE.brain.temporal.centre[0], FIGURE.brain.temporal.centre[1], FIGURE.brain.temporal.centre[2]];
const TEMPORAL_RIGHT: readonly number[] = [-FIGURE.brain.temporal.centre[0], FIGURE.brain.temporal.centre[1], FIGURE.brain.temporal.centre[2]];
/** Rejection loops give up after this many tries per wanted point (only reachable with broken constants). */
const MAX_ATTEMPTS = 100_000;

/** Fail clearly instead of looping forever when constants make a rejection sampler impossible. */
function checkTries(tries: number, wanted: number, what: string): void {
  if (tries > MAX_ATTEMPTS + wanted * 400) throw new CortexError("E_INTERNAL", `${what}: too many rejected samples (check FIGURE)`);
}

function insideTemporal(x: number, y: number, z: number, k: number): boolean {
  const t = FIGURE.brain.temporal;
  return insideSuperellipsoid(x, y, z, TEMPORAL_LEFT, t.axes, t.exponent, k) || insideSuperellipsoid(x, y, z, TEMPORAL_RIGHT, t.axes, t.exponent, k);
}

/** Height of the lateral sulcus line at z, and its half-width there. */
function sulcusAt(z: number): { y: number; half: number } {
  const s = FIGURE.brain.sulcus;
  const t = clamp01((z - s.from[0]) / (s.to[0] - s.from[0]));
  return { y: lerp(s.from[1], s.to[1], t), half: lerp(s.width[0], s.width[1], t) / 2 };
}

/** True inside the lateral sulcus groove (on |x| > minAbsX, within the line's half-width in the y–z plane). */
function inSulcus(x: number, y: number, z: number): boolean {
  const s = FIGURE.brain.sulcus;
  if (Math.abs(x) <= s.minAbsX) return false;
  const dz = s.to[0] - s.from[0];
  const dy = s.to[1] - s.from[1];
  const len = Math.hypot(dz, dy);
  const t = ((z - s.from[0]) * dz + (y - s.from[1]) * dy) / (len * len);
  if (t < 0 || t > 1) return false;
  const px = s.from[0] + dz * t;
  const py = s.from[1] + dy * t;
  return Math.hypot(z - px, y - py) < lerp(s.width[0], s.width[1], t) / 2;
}

/** True inside the brain's volume (cerebrum, temporal lobes or cerebellum), with a scale k on every part. */
export function insideBrain(x: number, y: number, z: number, k = 1): boolean {
  const b = FIGURE.brain;
  if (insideSuperellipsoid(x, y, z, b.centre, b.cerebrum.axes, b.cerebrum.exponent, k) && y > b.cerebrum.baseY - 0.02) return true;
  if (insideTemporal(x, y, z, k)) return true;
  return insideSuperellipsoid(x, y, z, b.cerebellum.centre, b.cerebellum.axes, 2, k);
}

/** Brain region of a slot (RegionId), from its part and its brain-local position. */
export function regionOf(part: number, x: number, y: number, z: number, interiorRadius: number): RegionId {
  if (part === SlotPart.Brainstem) return Region.Brainstem;
  if (part === SlotPart.Cerebellum) return Region.Cerebellum;
  if (part === SlotPart.Temporal) return Region.Temporal;
  const c = FIGURE.brain.centre;
  const r = FIGURE.brain.regions;
  const f = z - c[2];
  const u = y - c[1];
  const s = Math.abs(x - c[0]);
  if (interiorRadius < r.limbicDepth && s < r.limbicSide && u > r.limbicLow && u < r.limbicHigh) return Region.Limbic;
  if (s > r.temporalSide && u <= r.temporalLow && f > r.temporalBack) return Region.Temporal;
  if (f > r.prefrontal) return Region.Prefrontal;
  if (f <= r.occipital) return Region.Occipital;
  if (f > 0) return Region.Frontal;
  return Region.Parietal;
}

/** Azimuth about the brain's vertical axis: 0 at the frontal pole (+Z), increasing toward the figure's right (−X). */
export function brainAzimuth(x: number, z: number): number {
  const c = FIGURE.brain.centre;
  return wrapAngle(Math.atan2(-(x - c[0]), z - c[2]));
}

/** Bucketed brain slot count for a requirement (stable across small changes in the record). */
export function brainSlotBucket(required: number): number {
  const s = FIGURE.brain.slots;
  const need = Math.max(s.min, Math.ceil(Number.isFinite(required) ? required : s.min));
  for (const b of s.buckets) if (b >= need) return b;
  return s.max;
}

export interface AnatomyModel {
  seed: number;
  /** `<version>:<seed>:<slots>`: equal keys mean identical slot sets. */
  slotsKey: string;
  slotCount: number;
  /** Brain slot positions (xyz, skeleton frame). */
  brainSlots: Float32Array;
  brainRegion: Uint8Array;
  /** SlotPart per slot. */
  brainPart: Uint8Array;
  /** 1 on the folded cortical surface (or a lobe's shell), 0 inside. */
  brainSurface: Uint8Array;
  /** Azimuth about the brain's vertical axis: 0 at the frontal pole, increasing toward the figure's right. */
  brainPhi: Float32Array;
  /** Elevation about the brain's base centre (radians; the cerebellum is below 0). */
  brainPsi: Float32Array;
  /** 0 next to the base centre (where the brainstem enters) … 1 the outermost crown: the brain grows outward. */
  brainDepth: Float32Array;
  /** Decorative haze; `kind` indexes HAZE_KINDS (protocol), `sub` indexes HAZE_SUBS (fine); birth in intro seconds. */
  haze: { pos: Float32Array; kind: Uint8Array; sub: Uint8Array; birth: Float32Array; count: number; /** Spine position τ of each cord-thread point (NaN for every other kind). */ tau: Float32Array };
  /** The figure's extent in the skeleton frame: crown to the lowest strand, the torso's width. */
  bounds: Bounds;
}

/** The brain's base centre (where the brainstem enters): depth and elevation are measured from it. */
export const BRAIN_BASE: Vec3 = [FIGURE.brain.centre[0], FIGURE.brain.cerebrum.baseY, FIGURE.brain.centre[2]];

/** Brainstem cross-section scale at t (0 top … 1 bottom) and angle a (a = π/2 points forward, +Z). */
function stemRadius(t: number, a: number): number {
  const y = lerp(FIGURE.brainstem.topY, FIGURE.brainstem.bottomY, t);
  const ps = FIGURE.brainstem.pons;
  const swell = 1 + ps.swell * Math.exp(-(((t - ps.at) / ps.width) ** 2)) * Math.max(0, Math.sin(a));
  return radiusAtY(y) * swell;
}

/** A point inside the brainstem tube: t along it, angle a, radius share q ∈ [0, 1]. */
function stemPoint(t: number, a: number, q: number, out: Vec3): Vec3 {
  const y = lerp(FIGURE.brainstem.topY, FIGURE.brainstem.bottomY, t);
  const c = spinePoint(tauAtY(y), scratchRoot);
  const r = stemRadius(t, a) * q;
  out[0] = c[0] + Math.cos(a) * r;
  out[1] = c[1];
  out[2] = c[2] + Math.sin(a) * r;
  return out;
}

/** Build all slot sets (≥ 20,000 brain slots) and the haze for a seed. Deterministic per (seed, slot count). */
export function buildAnatomy(seed: number, brainSlotCount: number): AnatomyModel {
  const n = Math.max(1, Math.min(FIGURE.brain.slots.max, Math.floor(Number.isFinite(brainSlotCount) ? brainSlotCount : FIGURE.brain.slots.min)));
  const b = FIGURE.brain;
  const sh = b.shares;
  const nCerebellum = Math.round(n * sh.cerebellum);
  const nTemporal = Math.round((n * sh.temporal) / 2) * 2;
  const nStem = Math.max(1, Math.round(n * sh.brainstem));
  const nCerebrum = Math.max(1, n - nCerebellum - nTemporal - nStem);
  const total = nCerebrum + nTemporal + nCerebellum + nStem;
  const pos = new Float32Array(total * 3);
  const part = new Uint8Array(total);
  const surface = new Uint8Array(total);
  const interior = new Float32Array(total).fill(1);
  const rng = streamRng(seed, "brain-slots");
  const folds = makeFolds(streamRng(seed, "folds"));
  const c = b.centre;
  const p: Vec3 = [0, 0, 0];
  let k = 0;
  const push = (x: number, y: number, z: number, pt: number, surf: boolean, r: number): void => {
    pos[k * 3] = x;
    pos[k * 3 + 1] = y;
    pos[k * 3 + 2] = z;
    part[k] = pt;
    surface[k] = surf ? 1 : 0;
    interior[k] = r;
    k++;
  };
  // Cerebrum: 88% on the folded surface, 12% inside; the fissure and lateral sulcus stay empty; the base is flat;
  // nothing sits in the cerebellum's room; surface slots buried in a temporal lobe are skipped.
  const cb = b.cerebrum;
  let made = 0;
  let tries = 0;
  while (made < nCerebrum) {
    checkTries(++tries, nCerebrum, "cerebrum slots");
    foldedSurfacePoint(rng, folds, c, cb.axes, cb.exponent, 1, true, p);
    const shell = rng.next() < cb.shell;
    const r = shell ? 1 : Math.pow(rng.next(), cb.interiorPower) * cb.interiorScale;
    const x = c[0] + (p[0] - c[0]) * r;
    const y = c[1] + (p[1] - c[1]) * r;
    const z = c[2] + (p[2] - c[2]) * r;
    if (Math.abs(x - c[0]) < cb.fissureHalf && (y > cb.fissureY || z < cb.fissureBackZ)) continue;
    if (y <= cb.baseY) continue;
    if (y < cb.cerebellumRoom.y && z < cb.cerebellumRoom.z) continue;
    if (shell && inSulcus(x, y, z)) continue;
    if (shell && insideTemporal(x, y, z, 0.95)) continue;
    push(x, y, z, SlotPart.Cerebrum, shell, r);
    made++;
  }
  // Temporal lobes: surface slots only, below the lateral sulcus and outside the cerebrum.
  const tm = b.temporal;
  for (const side of [1, -1]) {
    let m = 0;
    tries = 0;
    const centre = [tm.centre[0] * side, tm.centre[1], tm.centre[2]];
    while (m < nTemporal / 2) {
      checkTries(++tries, nTemporal, "temporal slots");
      foldedSurfacePoint(rng, folds, centre, tm.axes, tm.exponent, 1, false, p);
      p[1] -= tm.poleLower * clamp01((p[2] - tm.centre[2]) / tm.axes[2]);
      if (insideSuperellipsoid(p[0], p[1], p[2], c, cb.axes, cb.exponent, tm.outsideCerebrum)) continue;
      if (p[1] >= sulcusAt(p[2]).y) continue;
      push(p[0], p[1], p[2], SlotPart.Temporal, true, 1);
      m++;
    }
  }
  // Cerebellum: ellipsoid, two lateral lobes with a vermis notch, folia as bands round the transverse axis.
  const ce = b.cerebellum;
  made = 0;
  tries = 0;
  while (made < nCerebellum) {
    checkTries(++tries, nCerebellum, "cerebellum slots");
    randomDirection(rng, dScratch);
    const s = superellipsoidRadius(dScratch[0], dScratch[1], dScratch[2], ce.axes, 2);
    const shell = rng.next() < ce.shell;
    const r = shell ? 1 : Math.pow(rng.next(), ce.fillPower);
    const x = ce.centre[0] + dScratch[0] * s * r;
    const y = ce.centre[1] + dScratch[1] * s * r;
    let z = ce.centre[2] + dScratch[2] * s * r;
    const ridge = 0.5 + 0.5 * Math.cos(ce.folia * Math.atan2(z - ce.centre[2], y - ce.centre[1]));
    if (rng.next() >= ce.foliaFloor + (1 - ce.foliaFloor) * ridge ** 3) continue;
    // The vermis: a notch 0.07 deep and 0.13 wide down the middle of the rear surface.
    if (Math.abs(x) < ce.vermisHalf && dScratch[2] < 0) {
      const notch = ce.vermisDepth * (1 - Math.abs(x) / ce.vermisHalf);
      z += notch;
    }
    push(x, y, z, SlotPart.Cerebellum, shell, r);
    made++;
  }
  // Brainstem: a few slots inside the tube, used only by Placement › By role (capture → brainstem).
  for (let i = 0; i < nStem; i++) {
    stemPoint(rng.next(), rng.next() * TAU, Math.sqrt(rng.next()), p);
    push(p[0], p[1], p[2], SlotPart.Brainstem, false, 0.5);
  }
  // Per-slot attributes.
  const region = new Uint8Array(total);
  const phi = new Float32Array(total);
  const psi = new Float32Array(total);
  const depth = new Float32Array(total);
  let maxDist = 0;
  for (let i = 0; i < total; i++) {
    const x = pos[i * 3] as number;
    const y = pos[i * 3 + 1] as number;
    const z = pos[i * 3 + 2] as number;
    region[i] = regionOf(part[i] as number, x, y, z, interior[i] as number);
    phi[i] = brainAzimuth(x, z);
    const dx = x - BRAIN_BASE[0];
    const dy = y - BRAIN_BASE[1];
    const dz = z - BRAIN_BASE[2];
    psi[i] = Math.atan2(dy, Math.hypot(dx, dz));
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    depth[i] = dist;
    if (dist > maxDist) maxDist = dist;
  }
  if (maxDist > 0) for (let i = 0; i < total; i++) depth[i] = (depth[i] as number) / maxDist;
  const haze = buildHaze(seed, folds, maxDist);
  return {
    seed,
    slotsKey: `${FIGURE.version}:${seed >>> 0}:${total}`,
    slotCount: total,
    brainSlots: pos,
    brainRegion: region,
    brainPart: part,
    brainSurface: surface,
    brainPhi: phi,
    brainPsi: psi,
    brainDepth: depth,
    haze,
    bounds: figureBounds(pos, haze.pos),
  };
}

// ───────────────────────────── haze ─────────────────────────────

/** Length of guide nerve i (the level's full length). */
export function guideLength(level: number): number {
  return (NERVE_LEVELS[level] as NerveLevel).length;
}

function buildHaze(seed: number, folds: FoldField, brainMaxDist: number): AnatomyModel["haze"] {
  const H = FIGURE.haze;
  const count = HAZE_TOTAL;
  const pos = new Float32Array(count * 3);
  const kind = new Uint8Array(count);
  const sub = new Uint8Array(count);
  const birth = new Float32Array(count);
  const htau = new Float32Array(count).fill(Number.NaN);
  const tm = FIGURE.timing;
  let k = 0;
  const push = (x: number, y: number, z: number, s: HazeSub, bt: number): void => {
    pos[k * 3] = x;
    // Strands (and their twigs) never hang below the lowest nerve: the figure ends at its floor.
    pos[k * 3 + 1] = s === "nerve" || s === "twig" ? Math.max(y, FIGURE.cord.floorY) : y;
    pos[k * 3 + 2] = z;
    kind[k] = PROTOCOL_KIND_INDEX[HAZE_PROTOCOL_KIND[s]];
    sub[k] = HAZE_SUB_INDEX[s];
    birth[k] = Math.min(tm.introSec, Math.max(0, bt));
    k++;
  };
  const b = FIGURE.brain;
  const c = b.centre;
  const cb = b.cerebrum;
  const p: Vec3 = [0, 0, 0];
  const bloom = (x: number, y: number, z: number): number => {
    const d = Math.sqrt((x - BRAIN_BASE[0]) ** 2 + (y - BRAIN_BASE[1]) ** 2 + (z - BRAIN_BASE[2]) ** 2);
    return tm.anatomyHaze[0] + (tm.anatomyHaze[1] - tm.anatomyHaze[0]) * clamp01(brainMaxDist > 0 ? d / brainMaxDist : 0);
  };
  const rb = streamRng(seed, "haze-brain");
  // Folded surface: cerebrum and temporal lobes, crest-weighted.
  const nCerebrumFolds = Math.round(H.brainFolds * H.foldCerebrumShare);
  let tries = 0;
  for (let i = 0; i < H.brainFolds; ) {
    checkTries(++tries, H.brainFolds, "brain haze");
    if (i < nCerebrumFolds) {
      foldedSurfacePoint(rb, folds, c, cb.axes, cb.exponent, H.surfaceScale, true, p);
      if (p[1] <= cb.baseY || (p[1] < cb.cerebellumRoom.y && p[2] < cb.cerebellumRoom.z)) continue;
    } else {
      const side = i % 2 === 0 ? 1 : -1;
      foldedSurfacePoint(rb, folds, [b.temporal.centre[0] * side, b.temporal.centre[1], b.temporal.centre[2]], b.temporal.axes, b.temporal.exponent, H.surfaceScale, false, p);
      if (insideSuperellipsoid(p[0], p[1], p[2], c, cb.axes, cb.exponent, b.temporal.outsideCerebrum)) continue;
    }
    push(p[0], p[1], p[2], "brainFolds", bloom(p[0], p[1], p[2]));
    i++;
  }
  // Cerebrum volume: filled toward the surface (radius × U^0.33).
  tries = 0;
  for (let i = 0; i < H.brainVolume; ) {
    checkTries(++tries, H.brainVolume, "brain haze");
    randomDirection(rb, dScratch);
    const s = superellipsoidRadius(dScratch[0], dScratch[1], dScratch[2], cb.axes, cb.exponent) * Math.pow(rb.next(), H.volumePower);
    const x = c[0] + dScratch[0] * s;
    const y = c[1] + dScratch[1] * s;
    const z = c[2] + dScratch[2] * s;
    if (y <= cb.baseY || (y < cb.cerebellumRoom.y && z < cb.cerebellumRoom.z)) continue;
    push(x, y, z, "brainVolume", bloom(x, y, z));
    i++;
  }
  // Cerebellum folia.
  const ce = b.cerebellum;
  tries = 0;
  for (let i = 0; i < H.cerebellum; ) {
    checkTries(++tries, H.cerebellum, "cerebellum haze");
    randomDirection(rb, dScratch);
    const s = superellipsoidRadius(dScratch[0], dScratch[1], dScratch[2], ce.axes, 2) * Math.pow(rb.next(), ce.fillPower);
    const x = ce.centre[0] + dScratch[0] * s;
    const y = ce.centre[1] + dScratch[1] * s;
    const z = ce.centre[2] + dScratch[2] * s;
    const ridge = 0.5 + 0.5 * Math.cos(ce.folia * Math.atan2(z - ce.centre[2], y - ce.centre[1]));
    if (rb.next() >= ce.foliaFloor + (1 - ce.foliaFloor) * ridge ** 3) continue;
    push(x, y, z, "cerebellum", bloom(x, y, z));
    i++;
  }
  // Lips of the fissure: both walls of the groove along the midline contour.
  tries = 0;
  for (let i = 0; i < H.brainLips; ) {
    checkTries(++tries, H.brainLips, "fissure haze");
    const th = rb.next() * TAU;
    const dy = Math.sin(th);
    const dz = Math.cos(th);
    const s = superellipsoidRadius(0, dy, dz, cb.axes, cb.exponent) * lerp(H.lipDepth[0], H.lipDepth[1], rb.next());
    p[0] = c[0];
    p[1] = c[1] + dy * s;
    p[2] = c[2] + dz * s;
    shapeCerebrum(p);
    const y = p[1];
    const z = p[2];
    if (y <= cb.baseY || (y < cb.cerebellumRoom.y && z < cb.cerebellumRoom.z) || !(y > cb.fissureY || z < cb.fissureBackZ)) continue;
    const x = c[0] + (rb.next() < 0.5 ? 1 : -1) * (H.lipOffset[0] + H.lipOffset[1] * rb.next());
    push(x, y, z, "brainLips", bloom(x, y, z));
    i++;
  }
  // Nerve guides: the anatomy's own 62 nerves, then two twigs from each.
  const rn = streamRng(seed, "haze-nerves");
  const g = FIGURE.nerves.guide;
  const q: Vec3 = [0, 0, 0];
  const d: Vec3 = [0, 0, 0];
  const twigs: { base: Vec3; dir: Vec3; length: number; birth: number }[] = [];
  for (const level of NERVE_LEVELS) {
    const rootBirth = tm.spine.start + tm.spine.span * level.tau + tm.frondDelay;
    for (const side of [1, -1]) {
      const npts = Math.round(g.base + g.perLength * level.length);
      let poly = nerveCourse(level.index, side);
      for (let strand = 0; strand < FIGURE.nerves.fibres.strands; strand++) {
        if (strand > 0) poly = fibreCourse(level.index, side, rn.next(), rn.next(), rn.next(), rn.next());
        for (let i = 0; i < npts; i++) {
          const s = (i + rn.next()) / npts;
          pointAt(poly, s, p);
          push(p[0] + rn.normal() * g.jitter, p[1] + rn.normal() * g.jitter, p[2] + rn.normal() * g.jitter, "nerve", rootBirth + tm.frondUnfurl * s);
        }
      }
      poly = nerveCourse(level.index, side);
      for (const [lo, hi] of g.twigAt) {
        const s = lerp(lo, hi, rn.next());
        const base = pointAt(poly, s, [0, 0, 0]);
        tangentAt(poly, s, d);
        // Toward the cord and down, 24–38° off the nerve: a twig stays inside the leaf and never pokes through its edge.
        q[0] = side * 0.5;
        q[1] = -0.6;
        q[2] = 0;
        const dot = q[0] * d[0] + q[1] * d[1] + q[2] * d[2];
        let px = q[0] - dot * d[0];
        let py = q[1] - dot * d[1];
        let pz = q[2] - dot * d[2];
        const pl = Math.hypot(px, py, pz) || 1;
        px /= pl;
        py /= pl;
        pz /= pl;
        const ang = lerp(g.twigAngleDeg[0], g.twigAngleDeg[1], rn.next()) * DEG;
        twigs.push({
          base,
          dir: [Math.cos(ang) * d[0] + Math.sin(ang) * px, Math.cos(ang) * d[1] + Math.sin(ang) * py, Math.cos(ang) * d[2] + Math.sin(ang) * pz],
          length: g.twigLength * level.length,
          birth: rootBirth + tm.frondUnfurl * s,
        });
      }
    }
  }
  for (const tw of twigs) {
    for (let i = 0; i < g.twigPoints; i++) {
      const s = (i + rn.next()) / g.twigPoints;
      const ty = tw.base[1] + tw.dir[1] * tw.length * s;
      push(clipToEnvelope(tw.base[0] + tw.dir[0] * tw.length * s, ty) + rn.normal() * g.jitter, ty + rn.normal() * g.jitter, clipToDepth(tw.base[2] + tw.dir[2] * tw.length * s, ty) + rn.normal() * g.jitter, "twig", tw.birth + 0.1 * s);
    }
  }
  // Cord thread: one bright continuous line along the whole cord.
  const rt = streamRng(seed, "haze-thread");
  for (let i = 0; i < H.cordThread; i++) {
    const raw = (i + rt.next()) / H.cordThread;
    const prof = H.threadProfile;
    let tau = beadTau(raw);
    // The column thins out over its lower end: a share of the points there moves up the cord instead (the count stays).
    if (rt.next() > lerp(1, prof.tailKeep, clamp01((tau - prof.fadeFrom) / (1 - prof.fadeFrom)))) tau = beadTau(rt.next() * prof.fadeFrom);
    spinePoint(tau, p);
    // The column swells toward the middle.
    const swell = prof.ends + (prof.mid - prof.ends) * Math.sin(Math.PI * clamp01((tau - 0.1) / 0.8));
    const r = H.threadReach * swell * radiusAtY(p[1]) * Math.sqrt(rt.next());
    const a = rt.next() * TAU;
    htau[k] = tau;
    push(p[0] + Math.cos(a) * r, p[1], p[2] + Math.sin(a) * r, "thread", tm.spine.start + tm.spine.span * tau);
  }
  // Segment rings: one faint mist ring per exit level, across the cord.
  const rr = streamRng(seed, "haze-rings");
  const ring = FIGURE.cord.ring;
  const tan: Vec3 = [0, 0, 0];
  for (const level of NERVE_LEVELS) {
    const centre = spinePoint(level.tau, [0, 0, 0]);
    spineTangent(level.tau, tan);
    // u = +X (across the body), v = tangent × u, so the ring lies across the cord.
    let vy = tan[2];
    let vz = -tan[1];
    const vl = Math.hypot(vy, vz) || 1;
    vy /= vl;
    vz /= vl;
    const radius = lerp(ring.radius[0], ring.radius[1], level.index / (NERVE_COUNT - 1));
    const off = rr.next() * TAU;
    for (let i = 0; i < ring.points; i++) {
      const a = (TAU * i) / ring.points + off;
      push(centre[0] + Math.cos(a) * radius, centre[1] + vy * Math.sin(a) * radius, centre[2] + vz * Math.sin(a) * radius, "ring", tm.spine.start + tm.spine.span * level.tau);
    }
  }
  // Brainstem: a tapering tube with the pons swelling forward; the seed ignites at its top.
  const rs = streamRng(seed, "haze-stem");
  for (let i = 0; i < H.brainstem; i++) {
    const t = rs.next();
    stemPoint(t, rs.next() * TAU, Math.sqrt(rs.next()), p);
    const bt = i < tm.seedPoints ? tm.seed[0] + (tm.seed[1] - tm.seed[0]) * 0.2 * (i / tm.seedPoints) : tm.seed[0] + (tm.seed[1] - tm.seed[0]) * t;
    push(p[0], p[1], p[2], "brainstem", bt);
  }
  // Neck sheath (FIG-06): two faint parallel columns, one either side of the cord, from the brainstem's base to the top of the torso.
  const rk = streamRng(seed, "haze-neck");
  const nk = H.neck;
  for (const side of [1, -1]) {
    for (let i = 0; i < nk.points; i++) {
      const u = (i + rk.next()) / nk.points;
      const y = lerp(FIGURE.brainstem.bottomY, nk.bottomY, u);
      const tauY = tauAtY(y);
      spinePoint(tauY, p);
      push(p[0] + side * lerp(nk.radius[0], nk.radius[1], u) + rk.normal() * nk.jitter, y + rk.normal() * nk.jitter * 0.5, p[2] + nk.forward + rk.normal() * nk.jitter, "neck", tm.spine.start + tm.spine.span * tauY);
    }
  }
  // Body field (FIG-08): a sparse Gaussian cloud shaped by the torso envelope, density following the half-width at each height.
  const rf = streamRng(seed, "haze-body");
  const bf = H.body;
  const nBody = HAZE_BUDGET.bodyField;
  tries = 0;
  for (let i = 0; i < nBody; ) {
    checkTries(++tries, nBody, "body field");
    const y = lerp(bf.bottomY, bf.topY, rf.next());
    const w = envelopeHalfWidth(y);
    if (rf.next() * ENVELOPE_MAX_HALF_WIDTH > w) continue;
    const d = envelopeHalfDepth(y);
    const x = clamp(rf.normal() * bf.sigma * w, -w, w);
    const z = zBack(y) + d + clamp(rf.normal() * bf.sigma * d, -d, d);
    push(x, y, z, "body", tm.spine.start + tm.spine.span * tauAtY(y));
    i++;
  }
  return { pos, kind, sub, birth, count: k, tau: htau };
}

/** The figure's bounds (skeleton frame): every slot and haze point (undated entries lie on the lowest strands, inside it). */
function figureBounds(slots: Float32Array, haze: Float32Array): Bounds {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const add = (arr: Float32Array): void => {
    for (let i = 0; i + 2 < arr.length; i += 3) {
      for (let d = 0; d < 3; d++) {
        const v = arr[i + d] as number;
        if (v < min[d]!) min[d] = v;
        if (v > max[d]!) max[d] = v;
      }
    }
  };
  add(slots);
  add(haze);
  return { min, max };
}

/** Outward distance from the brain centre along a unit direction to just outside the brain's volume. */
export function brainSurfaceAlong(dx: number, dy: number, dz: number): number {
  const c = FIGURE.brain.centre;
  const m = FIGURE.maps;
  let s = 0;
  while (s < m.maxReach && insideBrain(c[0] + dx * s, c[1] + dy * s, c[2] + dz * s)) s += m.march;
  return s;
}
