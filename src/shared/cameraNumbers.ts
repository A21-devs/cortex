/**
 * The camera numbers both the layout worker (worker/anatomy.ts FIGURE.camera) and the renderer (render/tuning.ts)
 * need: the ONE place they are written. Owner: E10 (see docs/rfcs/LIVE.md). CORTEX-UX §6.8.
 */
export const CAMERA_NUMBERS = {
  fovDeg: 30,
  near: 0.1,
  far: 200,
  spinPeriodSec: 16,
  driftPeriodSec: 12,
  /** Keep upright: the spin becomes a sway of this many degrees either side of the heading. */
  swayYawAmpDeg: 26,
  swayPeriodSec: 40,
} as const;
