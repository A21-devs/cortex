# RFC LIVE: findings from running the core in the real Obsidian

Owner: LIVE. No shared contract changed; this records what was added next to the contracts.

1. **New file `src/shared/cameraNumbers.ts`** (not one of the frozen contracts). `CAMERA_NUMBERS` {fovDeg, near, far, spinPeriodSec, driftPeriodSec, swayYawAmpDeg, swayPeriodSec} is now the one source for `render/tuning.ts` (`camera`, `motion`) and `worker/anatomy.ts` `FIGURE.camera`. Both layers may import `shared`. Architect: please add it to ARCHITECTURE section 5.
2. **Visibility contract, stated once**: `VisibilityParams.revealedCount <= 0` (or not finite) means nothing is held. `placement.normaliseVisibility` already did this; `charts/common.isVisible` and `search.makeVisibility` now do too. Before, a fresh leaf (revealedCount 0) counted zero entries on the strip, in search and in charts.
3. **Colour bytes**: `worker/grouping.ts` wrote `Math.round(0..1 float)` into the per-item `color` bytes (near black). The per-item buffer now holds sRGB bytes; key rows keep 0..1 floats (what `rgbCss` reads).
4. **Dev handle**: `CanvasHost` sets `canvas.cortexController` (the `RenderController`) for console inspection (`renderer.currentFraming()`, `stats()`). Nothing in Cortex reads it.
5. **Build**: `scripts/build-config.mjs` lifts every `.cx-` CSS rule by one class (`liftSpecificity`) so Obsidian's global `button:not(.clickable-icon)` and input styles cannot override Cortex controls. The partials stay readable.
6. **Strip period preview key** (already emitted by `TimeStrip`): `ui.preview = { kind: "period", key: "<startMs>-<endMs>" }`, end exclusive. The renderer now honours it (`parsePeriodPreview`).
