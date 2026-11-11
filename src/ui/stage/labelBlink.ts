/**
 * Waves labels flicker in while the waves lay out again (CHART-37): for a few hundred milliseconds they alternate on
 * and off, then stay on. Pure schedule; ChartOverlay plays it on the labels layer, and not at all under reduced motion.
 */
import type { ChartId } from "../../shared/views";

/** How long the flicker lasts and how long each on or off step is (ms). */
export const BLINK_MS = 480;
export const BLINK_STEP_MS = 80;

/** Charts whose labels flicker when they lay out: the waves (ridgeline). */
export function blinkApplies(chart: ChartId): boolean {
  return chart === "ridgeline";
}

/**
 * Visibility of the labels at each step, one step every `stepMs`: off, on, off, on … and a last step that stays on.
 * Empty (no flicker) under reduced motion.
 */
export function blinkSteps(reduced: boolean, durationMs = BLINK_MS, stepMs = BLINK_STEP_MS): boolean[] {
  if (reduced || !(durationMs > 0) || !(stepMs > 0)) return [];
  const pairs = Math.max(1, Math.floor(durationMs / (2 * stepMs)));
  const steps: boolean[] = [];
  for (let i = 0; i < pairs * 2; i++) steps.push(i % 2 === 1);
  steps.push(true);
  return steps;
}
