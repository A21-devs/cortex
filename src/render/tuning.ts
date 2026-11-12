/**
 * Every geometry, camera and timing number the renderer uses, in ONE exported object (owner: E10).
 *
 * The values are CORTEX-UX v1.2: §3.2 safe frame, §4.8 motion, §6.2 geometry, §6.5 sprites, §6.6 states, §6.7
 * growth, §6.8 camera, §6.10 lines, §8.4 governor. The standing figure is the default pose and Spin the default
 * motion; the default pose itself is read from the shared settings (`general.pose`) or the leaf's view state and
 * never from here. Other files re-export views of this object under their historical names (CAMERA_DEFAULTS,
 * SCOPE_TIMING, STATE_ALPHA, INTRO_STAGES …), so callers and tests keep working.
 *
 * Conventions used by every number below:
 *  - world: +Y up; the figure's long axis is the cord (standing: along Y, brainstem on top; lying: along X);
 *  - camera yaw is the angle of the camera around the world Y axis, measured so the camera sits at
 *    target + d·(cos p·sin y, −sin p, cos p·cos y); yaw 0 looks down −Z. Pitch < 0 puts the camera above the
 *    target looking down. The prototype's "heading h, elevation e" equals yaw −h, pitch −e;
 *  - screen numbers are CSS px of the stage (the canvas area left of the sheet), y down.
 */
import { CAMERA_NUMBERS } from "../shared/cameraNumbers";
import type { Breakpoint } from "../state/types";

/** Anchored rectangle of a stage overlay (CORTEX-UX §3.2), resolved against the stage size by `overlayRects`. */
export interface OverlaySpec {
  name: string;
  anchor: "tl" | "tr" | "bl" | "br" | "bc";
  /** Offsets from the anchored edges, CSS px. */
  dx: number;
  dy: number;
  /** Width; a function of the stage width for the key bar (≤ 44% of the stage). */
  w: number | ((stageW: number) => number);
  h: number;
}

const keyBarW = (w: number): number => Math.min(0.44 * w, 693);

export const RENDER_TUNING = {
  /** Pose-specific home views, framing rules and default motion. The default pose is read from the shared
   *  settings (`general.pose`), never from here. */
  poses: {
    standing: {
      /** Behind the figure, 26° round toward its right side (heading 154° from the frontal pole) and 9° above
       *  (§6.8). Heading h and elevation e are camera yaw −h and pitch −e. */
      home: { yawDeg: -154, pitchDeg: -9 },
      /** Aim point of the home view (§6.8). */
      aim: [0, 0.3, -0.2] as const,
      longAxis: [0, 1, 0] as const,
      defaultMotion: "spin" as const,
      fit: "height" as const,
    },
    lying: {
      home: { yawDeg: 11, pitchDeg: -8 },
      longAxis: [1, 0, 0] as const,
      defaultMotion: "drift" as const,
      fit: "rect" as const,
    },
  },

  /** The standing figure's key heights and torso envelope in scene units (CORTEX-UX §6.2; +Y up, the figure is
   *  about 10 high). Used for the lines' routing, the still silhouette, the 2D fallback and the framing tests. */
  figure: {
    crownY: 5.0,
    cerebellumBaseY: 2.74,
    brainstemTopY: 3.58,
    cordTipY: -4.02,
    lowestNerveY: -4.32,
    /** The lowest point of the figure (the lowest strands: floor −4.32 less the −0.04 margin); undated entries lie on the fibres above it. */
    undatedLowY: -4.36,
    /** Torso envelope: half-width w(y) at these heights, interpolated and smoothed over ±0.2; half-depth 0.40 w. */
    envelope: {
      y: [2.8, 2.55, 2.3, 2.05, 1.8, 1.5, 1.1, 0.5, -0.1, -0.6, -1.0, -1.4, -1.9, -2.4, -2.9, -3.4, -3.9, -4.32],
      halfWidth: [0.25, 0.5, 0.95, 1.5, 1.95, 2.3, 2.55, 2.7, 2.7, 2.6, 2.45, 2.25, 1.95, 1.6, 1.2, 0.8, 0.45, 0.2],
      smoothing: 0.2,
      depthRatio: 0.4,
    },
  },

  /** Home framing (CORTEX-UX §3.2 safe frame; the user's brief: reference viewport 1576 × 933, stage 1176 px wide
   *  with the reader open, crown 8–10% below the stage top, the tip just above the time strip). */
  frame: {
    referenceView: { width: 1576, height: 933 },
    referenceStage: { width: 1176, height: 825 },
    standing: {
      /** The brain's crown sits at this fraction of the stage height (y 74 at the reference size). */
      topFrac: 0.09,
      /** The lowest point (the cauda strands) sits this far above the stage bottom: 8 px above the command line. */
      bottomClearPx: 68,
      /** Horizontal centre = (left + stageWidth − right) / 2: the free stage between the key bar edge and tools. */
      centreLeftPx: 24,
      centreRightPx: 70,
      /** Robust horizontal extent of the data (percentiles), so one stray point never moves the figure. */
      extentPercentile: 0.003,
      /** If the silhouette comes within this gap of an overlay, slide away from it along x in steps (up to the
       *  maximum), then shrink about the centre in steps (§3.2). */
      overlayGapPx: 8,
      slideStepPx: 6,
      maxSlidePx: 36,
      shrinkStep: 0.02,
      maxShrinkSteps: 15,
    },
    lying: { left: 24, top: 86, right: 70, bottom: 76, margin: 0.04 },
    /** Mini shows the brain only: samples at or above this height (the cerebellum's base is 2.74) are fitted, with this margin. */
    mini: { brainBaseY: 2.4, margin: 0.06 },
    /** Re-fit to an arrangement's sphere with this margin (CORTEX-UX §6.8: bounds + 8%). */
    refitMargin: 0.08,
    /** Samples projected when fitting (strided over data and haze, plus the extreme points). */
    fitSamples: 6000,
  },

  /** Stage overlays per breakpoint (stage-local CSS px), avoided by the standing fit (CORTEX-UX §3.2, §2.5). */
  overlays: {
    XL: [
      { name: "key bar", anchor: "tl", dx: 16, dy: 12, w: keyBarW, h: 66 },
      { name: "shape bar", anchor: "tr", dx: 16, dy: 12, w: 420, h: 40 },
      { name: "tool column", anchor: "tr", dx: 16, dy: 64, w: 38, h: 272 },
      { name: "compass", anchor: "bl", dx: 16, dy: 16, w: 140, h: 150 },
      { name: "command line", anchor: "bc", dx: 0, dy: 16, w: 640, h: 44 },
    ],
    L: [
      { name: "key bar", anchor: "tl", dx: 16, dy: 12, w: keyBarW, h: 66 },
      { name: "shape bar", anchor: "tr", dx: 16, dy: 12, w: 420, h: 40 },
      { name: "tool column", anchor: "tr", dx: 16, dy: 64, w: 38, h: 272 },
      { name: "compass", anchor: "bl", dx: 16, dy: 16, w: 124, h: 134 },
      { name: "command line", anchor: "bc", dx: 0, dy: 16, w: 560, h: 44 },
    ],
    M: [
      { name: "key button", anchor: "tl", dx: 16, dy: 12, w: 72, h: 32 },
      { name: "shape bar", anchor: "tr", dx: 16, dy: 12, w: 420, h: 40 },
      { name: "tool column", anchor: "tr", dx: 16, dy: 64, w: 38, h: 272 },
      { name: "compass", anchor: "bl", dx: 16, dy: 16, w: 88, h: 98 },
      { name: "command line", anchor: "bc", dx: 0, dy: 16, w: 560, h: 44 },
    ],
    S: [
      { name: "shape button", anchor: "tr", dx: 16, dy: 12, w: 72, h: 32 },
      { name: "tools button", anchor: "tr", dx: 16, dy: 52, w: 32, h: 32 },
      { name: "command line", anchor: "bc", dx: 0, dy: 16, w: (w: number) => Math.max(0, w - 32), h: 44 },
    ],
    Mini: [],
  } as Readonly<Record<Breakpoint, readonly OverlaySpec[]>>,

  /** Cortex Desktop's chrome (no key bar, shape bar, tool column, compass or command line): the top-right icon cluster,
   *  the bottom-left legend and the folded histogram at the bottom right. */
  desktopOverlays: [
    { name: "cluster", anchor: "tr", dx: 16, dy: 12, w: 110, h: 36 },
    { name: "legend", anchor: "bl", dx: 16, dy: 16, w: 240, h: 270 },
    { name: "histogram", anchor: "br", dx: 16, dy: 16, w: 132, h: 44 },
  ] as readonly OverlaySpec[],

  /** Camera (CORTEX-UX §6.8). */
  camera: {
    fovDeg: CAMERA_NUMBERS.fovDeg,
    near: CAMERA_NUMBERS.near,
    far: CAMERA_NUMBERS.far,
    minDistanceFactor: 0.15,
    maxDistanceFactor: 4,
    pitchLimitDeg: 75,
    uprightYawDeg: 50,
    uprightPitchDeg: 30,
    /** Degrees of orbit per CSS px dragged, and per arrow key press. */
    orbitDegPerPx: 0.3,
    keyTurnDeg: 5,
    keyPanPx: 40,
    keyZoom: 1.15,
    /** Wheel: distance × exp(deltaY × this); Ctrl/Alt (fine) uses a quarter of it. */
    wheelZoomPerPx: 0.0015,
    fineWheelFactor: 0.25,
    pinchZoomPower: 1,
    /** Orbit inertia: the drag's release velocity (mean of its last 3 moves) decays with this time constant; it stops
     *  below `inertiaStopRad` radians per 60 Hz frame. */
    inertiaTauMs: 350,
    inertiaStopRad: 0.0005,
    inertiaSamples: 3,
    /** A release more than this long after the last move carries no velocity (the pointer was held still). */
    inertiaIdleMs: 90,
    /** Cap on the carried velocity (about 210 degrees of coast at the cap). */
    inertiaMaxDegPerMs: 0.6,
    /** Opening dolly: start at this share of the home distance and ease out to home over `introDollyMs`. */
    introDollyMs: 450,
    introDollyFactor: 0.35,
    /** Return from a scope to all areas: the camera starts at this share of the home distance and eases out. */
    scopeReturnDollyFactor: 0.7,
    scopeReturnDollyMs: 300,
    /** Group-change flight (an arrangement into Groups): back off and drop, then fly in and up under the figure. */
    groupFlight: true,
    groupFlightBackMs: 300,
    groupFlightInMs: 500,
    groupFlightBackFactor: 1.3,
    groupFlightDrop: 0.15,
    groupFlightPitchDeg: 12,
  },

  /** Motion (CORTEX-UX §6.8, §2.4). */
  motion: {
    driftYawAmpDeg: 26,
    driftPitchAmpDeg: 3,
    driftPeriodSec: CAMERA_NUMBERS.driftPeriodSec,
    spinPeriodSec: CAMERA_NUMBERS.spinPeriodSec,
    pauseAfterDragMs: 600,
    pointerRestMs: 300,
    resumeMs: 600,
    /** Keep upright: the spin becomes a sway, yaw = h ± this over `swayPeriodSec`, pitch 0 (§6.8). */
    swayYawAmpDeg: CAMERA_NUMBERS.swayYawAmpDeg,
    swayPeriodSec: CAMERA_NUMBERS.swayPeriodSec,
    /** The spin (or drift) is already turning on the first frame of the intro (0.2 of full speed) and reaches full
     *  speed 0.5 s in, so the cord and brain are seen turning while they grow. */
    introMotionStart: 0.2,
    introMotionRampMs: 500,
    /** Visible leaves that are not focused cap at this rate and pause their motion. */
    unfocusedFps: 30,
    /** Frame delta clamp on resume (hidden leaf). */
    maxFrameDeltaMs: 50,
  },

  /** Camera flights (CORTEX-UX §6.8, §3.4). */
  fly: { inMs: 520, outMs: 380, distanceFactor: 0.5, refitMs: 400, dockMs: 300 },

  /** Growth (CORTEX-UX §6.7, the user's growth order: cord from the brainstem down, nerves outward, brain). */
  growth: {
    introSec: 3.6,
    rebuildSec: 0.9,
    stages: [
      { name: "seed", from: 0.0, to: 0.25 },
      { name: "spine", from: 0.25, to: 0.95 },
      { name: "fronds", from: 0.55, to: 1.8 },
      { name: "body", from: 1.0, to: 1.8 },
      { name: "bloom", from: 1.8, to: 3.0 },
      { name: "settle", from: 2.9, to: 3.6 },
    ],
    /** Cord points are born at spineStart + spineSpan × τ behind a bright travelling tip. */
    spineStart: 0.25,
    spineSpan: 0.7,
    seedPoints: 12,
    seedRingPx: 40,
    /** Fronds unroll from a 60° curl over 0.45 s, starting 0.08 s after the tip passes their root. */
    unfurlDeg: 60,
    unfurlSec: 0.45,
    frondDelaySec: 0.08,
    /** Haze fades in instead of flashing. */
    hazeFadeSec: 0.4,
    birthFlashMs: 220,
    birthFlashSize: 2.2,
    /** Revealed arrivals are born over this window, in ordinal order. */
    arrivalStaggerSec: 0.3,
    /** Reduced motion and a leaf returning from release: points fade in. */
    fadeInMs: 200,
  },

  /** Scope turn (CORTEX-UX §6.7, ORIG-16). */
  scope: { turnMs: 600, sinkFadeMs: 300, riseMs: 400, refitBelow: 0.4, refitMs: 600, sink: 0.25, reducedCrossfadeMs: 120, flashMs: 600, swirlMs: 450, swirlAmp: 0.6 },

  /** Shapes (CORTEX-UX §6.12, §4.8). */
  shape: {
    /** Anatomy to Groups about 0.35 s; the follower's jump animation (back about 0.55 s) matches the UI's morph. */
    morphMs: 350,
    morphBackMs: 550,
    /** Chart to chart (form morph). */
    formMs: 250,
    formLift: 0.3,
    curlAmp: 0.35,
    /** Per-chart entry style of a form morph: a horizontal smear, a diagonal burst, an upward rise (extra shader terms). */
    entry: { smear: 1.6, burst: 1.1, rise: 1.0, curl: 0.5 },
    /** A click starts dissolving toward the transit silhouette on its first frame, before the worker replies: ramp
     *  time, and the share of the silhouette's weight it reaches while it waits. */
    pendingMs: 140,
    pendingWeight: 0.7,
    /** A flat chart closing shrinks toward a small rectangle near the top while it fades, then the points travel home. */
    chartExit: { shrink: 0.22, fadeTo: 0.2, shrinkMs: 140, backMs: 260, topFrac: 0.85 },
    /** A store morph jump larger than this animates (a click); smaller steps follow the slider live. */
    morphJump: 0.08,
    overlayFadeOutMs: 100,
    overlayFadeInMs: 120,
    labelsAtMorph: 0.85,
    reducedDipMs: 120,
  },

  /** Colour-state timing (CORTEX-UX §5.12, §6.6). */
  states: {
    fadeMs: 150,
    /** The wordmark lens fades non-members over about 8 frames. */
    lensFadeMs: 130,
    recolourMs: 600,
    /** A palette, age-colour or theme pick in Settings recolours the figure about as fast as the rest of the app (a Colour by change keeps recolourMs). */
    recolourSettingsMs: 150,
    /** A changed query or token set dips the whole figure, then regrows it cord first, nerves, brain (off under reduced motion). */
    regrowOnQuery: true,
    queryDipTo: 0.15,
    queryDipMs: 150,
    queryRegrowMs: 300,
    /** Typing triggers the dip at most once per this many ms. */
    queryDebounceMs: 400,
    /** Soft edge of the regrow wave, in growth-clock seconds. */
    queryRegrowSoftSec: 0.6,
    /** A change of Group by: the body fades to about nothing over 300 ms, then the cord returns first, the brain a
     *  little later (the regrow wave runs in growth order: cord, nerves, brain, body field). */
    groupDipTo: 0.02,
    groupDipMs: 300,
    groupRegrowMs: 450,
  },

  /** Transitions of the point layer that are not the shape morph. */
  morph: {
    /** A change of the Group by dimension: points dissolve and refill ("dissolve"), or travel to their new places ("travel"). */
    groupChange: "dissolve" as "dissolve" | "travel",
    dissolveOutMs: 120,
    dissolveInMs: 300,
    /** Share of points (by a stable hash) that fade out; the rest shrink. */
    dissolveFade: 0.85,
    dissolveShrink: 0.45,
  },

  /** Idle twinkle of the data points (off under reduced motion and while exporting). */
  shimmer: { on: true, amp: 0.18, jitter: 0.002, rate: 2.3, fps: 24 },

  /**
   * Transit silhouette: part-way through a body → groups / chart morph the points are drawn toward a humanoid pose
   * (parts below, in the figure's own units, x right and y up) with weight `weight` × sin²(π e), tinted `tint`
   * toward the palette's `tintSlot` colour. shape 0 = ring (cx, cy, radius, 0), 1 = filled rectangle (x0, y0, x1, y1),
   * 2 = limb drawn on both sides (x0, y0, x1, y1 on the right side, mirrored for the left), `width` its thickness.
   */
  transit: {
    silhouette: true,
    weight: 0.6,
    tint: 0.12,
    tintSlot: 6,
    depth: 0.25,
    parts: [
      { shape: 0, weight: 0.1, a: [0, 4.05, 0.8, 0], width: 0.14 },
      { shape: 1, weight: 0.26, a: [-1.15, 0.7, 1.15, 3.0], width: 0 },
      { shape: 2, weight: 0.28, a: [1.25, 2.9, 2.5, -0.8], width: 0.34 },
      { shape: 2, weight: 0.36, a: [0.55, 0.6, 0.85, -4.1], width: 0.55 },
    ],
  },

  /**
   * Spread (the Display "Scatter" slider s) also moves the whole body: below 100% the cerebrum shrinks to
   * brainBase + brainGain × s, cord points get brightness 1 + (1 − s) × cordBright and size 1 + (1 − s) × cordSize, and
   * the body field's density is 1 + (1 − s) × haze; above 100% it does the opposite, clamped to the ranges here.
   */
  spread: { brainBase: 0.85, brainGain: 0.15, cordBright: 0.8, cordSize: 0.5, haze: 1, brightRange: [0.5, 1.8], sizeRange: [0.7, 1.5], hazeRange: [0.4, 2] },

  /** Hover emphasis of a chart row or label (renderer.setHoverGroup): the group glows and trails, the rest dims. */
  hover: { dim: 0.35, boost: 1.6, size: 1.3, glow: 0.07, glowPx: 5, streakPx: 9, fadeMs: 140, streakSlots: [1, 2, 3, 5, 7, 8] },

  /**
   * Colour-state multipliers (CORTEX-UX §6.6, §12.6). A selection dims everything else to 6% and the haze to 35%;
   * a traced set dims the rest to 12% and the haze to 50%; previews dim others to 35%. Outside the scope a point
   * sinks 25% toward the brain's core (record: the cord axis) while fading to 0.
   */
  stateAlpha: {
    selectedOthers: 0.06,
    hazeWhileSelected: 0.35,
    selectedGroupBoost: 3.2,
    /** Members of a selected group are drawn at this multiple of their size. */
    selectedGroupSize: 2.0,
    tracedOthers: 0.12,
    hazeWhileTraced: 0.5,
    previewOthers: 0.35,
    /** The rail wordmark's lens (a strong area preview): everything outside the area fades to this. */
    lensOthers: 0.06,
    /** The same lens: the anatomy haze (brain, torso and the cord thread's beads) drops to this so only the isolated area stays lit. */
    hazeWhileLens: 0.06,
    hiddenByKey: 0.06,
    /** Legend rows hidden (a group isolated): the anatomy haze draws this much brighter, so the figure keeps its body while its entries are hidden. */
    hazeWhileKeyed: 1.8,
    outsidePeriod: 0.06,
    outsideScope: 0,
    scopeSink: 0.25,
    /** A map (a topic, project or area summary) is a small steady white spark, brighter than a note; it never pulses. */
    mapBoost: 1.5,
    mapSourcesBoost: 1.6,
    mapSourcesTint: 0.5,
    thinGroup: 0.5,
    /** In flight (morph): lifted toward warm white by this × sin(π m). */
    inFlightWarm: 0.25,
    /** Hover, selection and birth flashes draw a white core whose peak reaches this (before tone mapping). */
    whitePeak: 0.9,
    hoverSize: 2,
    selectedSize: 2.4,
  },

  /**
   * Sprites (CORTEX-UX §6.5): alpha = intensity × (core peak × exp(−d²/2σc²) + halo peak × Glow × exp(−d²/2σh²)),
   * d in CSS px; sizes × Dot size × (d0/d)^0.35 with d0 the home distance; sprites clamped to 1–24 CSS px × DPR.
   */
  sprites: {
    record: { sigmaCore: 0.55, sigmaHalo: 2.2, corePeak: 0.105, haloPeak: 0.006 },
    note: { sigmaCore: 0.55, sigmaHalo: 2.4, corePeak: 0.55, haloPeak: 0.03 },
    /** A map is a spark: a bright core under twice a note's and a faint tight halo, never a soft disc (the old 6.5 px halo hit the 24 px cap). */
    map: { sigmaCore: 0.9, sigmaHalo: 2.8, corePeak: 0.9, haloPeak: 0.06 },
    minPx: 1,
    maxPx: 24,
    distancePower: 0.35,
    /** Sprite radius in σ (the halo is cut smoothly at the sprite edge). */
    extentSigma: 3,
  },

  /** Per-kind intensity (CORTEX-UX §6.5, §6.13). */
  intensity: {
    frondRoot: 0.6,
    frondTip: 0.36,
    frondJitter: [0.85, 1.15] as const,
    cord: 1.0,
    note: 2.1,
    cerebellum: 1.0,
    noteJitter: [0.75, 1.2] as const,
    noteRimBase: 0.7,
    noteRimGain: 1.1,
    noteInside: 0.7,
    map: 1.0,
    /** Maps are drawn this much toward white, keeping a faint tint of their area. */
    mapWhite: 0.6,
    undated: 0.14,
    /** Haze rest intensity by kind name (§6.5). `brain` is the weighted mean of the folds (0.80 × (0.6 + rim²)), lips (0.55), volume (0.12) and cerebellum
     *  (0.50) kinds; `nerve` the mean of the guides' 0.24 → 0.13 gradient and the twigs' 0.16; `thread` the cord thread. */
    haze: { brain: 0.8, nerve: 0.16, thread: 0.9, ring: 0.2, brainstem: 0.55, undated: 0.04, body: 0.05, neck: 0.06, vertebra: 0.22 },
    /** Nerve guides fade from root to tip: intensity 0.24 at the cord to 0.13 at the end (`mean` is the table's `nerve`); `tipRadius` is the distance from the cord axis that counts as the tip. */
    nerveGuide: { root: 0.2, tip: 0.08, mean: 0.13, tipRadius: 1.8 },
    /** Brain haze colour: 60% territory + 40% mist; brainstem haze: 60% oldest age stop + 40% mist. */
    hazeTerritoryMix: 0.6,
    /** Fewer than 300 notes: brain dots × 1.4 and the brain haze × 1.5; no data at all: haze × 1.5. */
    smallBrainNotes: 300,
    smallBrainDot: 1.4,
    smallBrainHaze: 1.5,
    emptyHaze: 1.5,
    /** Fewer than 200 record entries: fronds read as fronds (minimum length is the worker's; dots × 1.2 here). */
    smallRecordEntries: 200,
    smallRecordDot: 1.2,
    /** A record thinner than the reference picture (about 105,000 frond points, the mockups) draws its record dots a little larger, so the
     *  figure keeps its body: size × (reference / entries)^power, between 1 and `thinRecordMax`. */
    thinRecordReference: 105_000,
    thinRecordPower: 0.3,
    thinRecordMax: 1.2,
  },

  /**
   * Fibre look of the figure's body (the conversation fronds and the nerve haze): a thin, pale strand with tiny bright
   * specks along it. A frond point keeps `colourKeep` of its colour (the rest is its own luminance), is drawn at
   * `size` × and `intensity` ×; `speckShare` of the points are specks: full colour lifted `speckLift` toward white,
   * `speckSize` × the size and `speckBoost` × the brightness. A selected or traced group draws at full colour.
   * The haze's nerve and body points get `hazeSpeckShare` specks of `hazeSpeckSize` × and `hazeSpeckBoost` ×.
   */
  fibre: { colourKeep: 0.75, size: 0.5, intensity: 0.8, speckShare: 0.07, speckSize: 1.25, speckBoost: 2.2, speckLift: 0.25, hazeSpeckShare: 0.035, cordSize: 0.7, hazeSpeckSize: 1.4, hazeSpeckBoost: 2.4 },

  /** Line families (CORTEX-UX §6.10). */
  lines: {
    /** Source lines are quadratic curves whose control point sits level with the chord's middle, on the entry's
     *  side of the cord, at `ctrlWidthFactor` × w(y) + `ctrlOffset` from the cord axis (outside the torso). */
    ctrlWidthFactor: 2,
    ctrlOffset: 0.2,
    minSteps: 4,
    maxSteps: 16,
    sourceAlpha: 0.5,
    sourceAlphaFar: 0.34,
    stemAlpha: 0.1,
    spokeAlpha: 0.55,
    /** Note-link fibres: alpha 0.05 with the camera at home, rising to 0.18 once it is closer than `linkZoom` × home. */
    linkAlpha: 0.05,
    linkAlphaNear: 0.18,
    linkZoom: 0.6,
    drawOnMs: 280,
    pickPx: 4,
    budget: 60_000,
    capacity: 80_000,
  },

  /** Selection rings (CORTEX-UX §6.6): hover white 1.5 px at r 7.5 + 1 px at 32% r 13; selected 2 px accent;
   *  the active note 1.5 px accent. */
  rings: {
    hover: [
      { r: 7.5, w: 1.5, a: 1 },
      { r: 13, w: 1, a: 0.32 },
    ],
    selected: [{ r: 8.5, w: 2, a: 1 }],
    active: [{ r: 7.5, w: 1.5, a: 1 }],
    gain: 2.2,
  },

  /** Hover, picking and pointer gestures (CORTEX-UX §5.2, §5.12). */
  pointer: { hoverStillMs: 60, pickHz: 30, pickWindowPx: 9, pickRenderPx: 33, pickMinSizePx: 6, pickAlphaMin: 0.2, clickSlopPx: 4, dblClickMs: 320, lineHoverDebounceMs: 120 },

  /** Stage background (prototype: a tall soft lift behind the standing figure and a corner vignette). */
  stage: {
    standingLift: { radiusX: 0.46, radiusY: 0.8, power: 1.6 },
    lyingLift: { centreX: 0.47, centreY: 0.5, radiusX: 0.62, radiusY: 0.75, power: 1.6 },
    vignette: { radiusX: 0.62, radiusY: 0.75, start: 0.75, strength: 0.35 },
    /** Tone map: out = 1 − exp(−k × Brightness × hdr). */
    toneK: 1.35,
    paperAlpha: 0.7,
    paperCoreScale: 1.3,
    maxDpr: 2,
  },

  /** Frame-rate governor (CORTEX-UX §8.4). */
  // A frame is slow only when it is over slowFrameMs AND over slowFactor × the expected interval. The expected interval
  // is the display's own recent cadence, capped at maxCadenceMs, or the leaf's frame cap when that is longer. So a 30 Hz
  // screen or an unfocused leaf capped at 30 fps never counts as slow. cadenceRise: how fast the cadence estimate
  // creeps up per frame (it drops at once). The first warmupMs after the loop starts, a resize or a new placement
  // never count.
  governor: { slowFrameMs: 22, slowWindowMs: 2000, dprStep: 1.25, hazeKeep: 0.5, idleGapMs: 250, warmupMs: 3000, slowFactor: 1.5, maxCadenceMs: 28, cadenceRise: 0.002, minSampleMs: 4 },

  /** Renderer pool (CORTEX-UX §2.4). */
  pool: { maxLive: 3, hiddenReleaseMs: 60_000, stillRefreshMs: 2000, stillScale: 0.5 },

  /** Save image (CORTEX-UX §7.4). */
  picture: { scale: 2 },

  /**
   * First paint (cold open, showcase "figure" step): before the record is ready a loose cloud of points fills a
   * SIDE-view brain outline (yaw 90°) with two bright comet fans; when the record is ready the cloud turns to the front
   * view over `turnMs` while its points condense onto the figure, and the figure fades in under it. `holdMinMs` keeps the
   * cloud on screen long enough to be read when the record is already cached. Reduced motion draws no cloud at all.
   */
  firstPaint: {
    points: 2600,
    cometPoints: 150,
    /** Fade-in of the cloud (ms), and the least time it is held before the turn starts. */
    fadeInMs: 320,
    holdMinMs: 600,
    turnMs: 1100,
    yawDeg: 90,
    /** Half-length of the side-view brain outline as a share of the figure radius. */
    outlineHalf: 0.5,
    /** The point sprite (CSS px) and its peak alpha; comet points are larger and brighter. */
    sizePx: 2.1,
    cometSizePx: 3.2,
    alpha: 0.9,
    cometAlpha: 1,
    /** Cloud alpha fades out over the last share of the turn; the figure fades in over the last `figureShare` of it. */
    cloudFadeFrom: 0.62,
    figureFrom: 0.3,
    /** The points start condensing after this share of the turn (the yaw starts at once). */
    condenseFrom: 0.12,
    /** The real figure leaves this fast when the first paint is replayed over a figure already on screen (ms). */
    figureOutMs: 200,
    /** Cancelling (a fresh import grows cord-first, an empty record shows its card): the cloud fades out over this (ms). */
    cancelMs: 280,
    /** Palette slots (value bucket) of the cloud: body points cycle through them, comets use the first. */
    slots: [1, 2, 3, 4, 5, 6],
  },
} as const;

/** Resolve the overlay rectangles of a breakpoint against a stage of `w` × `h` CSS px. */
export function overlayRects(bp: Breakpoint, w: number, h: number, desktop = false): { name: string; x0: number; y0: number; x1: number; y1: number }[] {
  return (desktop && bp !== "Mini" ? RENDER_TUNING.desktopOverlays : RENDER_TUNING.overlays[bp]).map((o) => {
    const ow = typeof o.w === "function" ? o.w(w) : o.w;
    let x0: number;
    let y0: number;
    switch (o.anchor) {
      case "tl":
        x0 = o.dx;
        y0 = o.dy;
        break;
      case "tr":
        x0 = w - o.dx - ow;
        y0 = o.dy;
        break;
      case "bl":
        x0 = o.dx;
        y0 = h - o.dy - o.h;
        break;
      case "br":
        x0 = w - o.dx - ow;
        y0 = h - o.dy - o.h;
        break;
      case "bc":
        x0 = (w - ow) / 2;
        y0 = h - o.dy - o.h;
        break;
    }
    return { name: o.name, x0, y0, x1: x0 + ow, y1: y0 + o.h };
  });
}
