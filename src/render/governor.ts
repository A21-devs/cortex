/**
 * Frame-rate governor (CORTEX-UX §8.4, L5). Owner: E10.
 * If frames take > 22 ms for 2 s: step 1 DPR down to 1.25, step 2 halos off, step 3 haze halved — one step per
 * trigger. The first step posts one toast ("Cortex lowered detail to stay smooth. Change it in Display.") and the
 * Display popover shows a "Performance mode" line until the user resets it. Pure state machine; the renderer
 * applies `governorEffects(step)`. Frames after an idle gap (the loop was stopped) never count as slow.
 *
 * "Slow" is measured against the display, not only the 22 ms line. Frame intervals are rAF intervals, and on a
 * 30 Hz screen, or in an unfocused leaf capped at 30 fps (§2.4), every interval is 33 ms however cheap the frame
 * was. So a frame counts as slow only when it also exceeds 1.5 × the expected interval: the display's recent best
 * cadence (capped at `maxCadenceMs`), or the leaf's cap when longer (`isSlowFrame`). The first `warmupMs` after the
 * loop starts, a resize or a new placement never count, because start-up and arrangement work are not steady-state
 * slowness.
 */
import { RENDER_TUNING } from "./tuning";

export const SLOW_FRAME_MS = RENDER_TUNING.governor.slowFrameMs;
export const SLOW_WINDOW_MS = RENDER_TUNING.governor.slowWindowMs;
export const WARMUP_MS = RENDER_TUNING.governor.warmupMs;
export type GovernorStep = 0 | 1 | 2 | 3;

/** True when a frame interval is slow: over 22 ms and over slowFactor × the expected interval (display cadence or leaf cap). */
export function isSlowFrame(frameMs: number, cadenceMs: number | null, floorMs = 0): boolean {
  const g = RENDER_TUNING.governor;
  const expected = Math.max(floorMs, Math.min(cadenceMs ?? 0, g.maxCadenceMs));
  return frameMs > Math.max(SLOW_FRAME_MS, expected * g.slowFactor);
}

export class FrameGovernor {
  private slowSince: number | null = null;
  /** End of the current grace period; null = a new one starts at the next frame. */
  private graceUntil: number | null = null;
  /** The display's recent best frame interval: drops at once to a shorter one, creeps back up slowly. */
  private cadenceMs: number | null = null;
  step: GovernorStep = 0;

  /**
   * Feed one frame interval, plus the leaf's frame cap interval (0 when uncapped) and when the main thread was last
   * busy with a long task (PerformanceObserver "longtask": over 50 ms). A slow streak that overlaps main-thread work
   * starts again: that slowness is Cortex's own loading or page work, which lower drawing detail cannot help, while a
   * GPU that can't keep up leaves no long tasks. Returns the new step when it changed, else null.
   */
  frame(nowMs: number, frameMs: number, floorMs = 0, busyUntilMs = Number.NEGATIVE_INFINITY): GovernorStep | null {
    const g = RENDER_TUNING.governor;
    if (frameMs >= g.idleGapMs) {
      // The loop was idle, the tab was hidden, or the main thread was busy with loading work (index, sample,
      // arrangement): not a measurement. A new grace period starts, so the shorter frames around such work don't count.
      this.slowSince = null;
      this.graceUntil = null;
      return null;
    }
    if (frameMs >= g.minSampleMs) {
      this.cadenceMs = this.cadenceMs === null || frameMs < this.cadenceMs ? frameMs : this.cadenceMs + (frameMs - this.cadenceMs) * g.cadenceRise;
    }
    if (this.graceUntil === null) this.graceUntil = nowMs + g.warmupMs;
    if (nowMs < this.graceUntil || !isSlowFrame(frameMs, this.cadenceMs, floorMs)) {
      this.slowSince = null;
      return null;
    }
    if (this.slowSince === null || busyUntilMs >= this.slowSince - frameMs) {
      // A new streak, or main-thread work overlapped the current one (long-task reports can arrive a frame late).
      this.slowSince = nowMs;
      return null;
    }
    if (nowMs - this.slowSince < SLOW_WINDOW_MS || this.step === 3) return null;
    this.step = (this.step + 1) as GovernorStep;
    this.slowSince = null;
    return this.step;
  }

  /** Break the current slow streak and start a new grace period (a resize, a new placement, the loop restarting) without changing the step. */
  interrupt(): void {
    this.slowSince = null;
    this.graceUntil = null;
  }

  reset(): void {
    this.step = 0;
    this.slowSince = null;
    this.graceUntil = null;
  }
}

export interface GovernorEffects {
  /** Device pixel ratio cap. */
  maxDpr: number;
  halos: boolean;
  /** Fraction of the haze drawn. */
  hazeKeep: number;
}

/** What each step changes (cumulative). */
export function governorEffects(step: GovernorStep, baseMaxDpr: number = RENDER_TUNING.stage.maxDpr): GovernorEffects {
  return {
    maxDpr: step >= 1 ? Math.min(baseMaxDpr, RENDER_TUNING.governor.dprStep) : baseMaxDpr,
    halos: step < 2,
    hazeKeep: step >= 3 ? RENDER_TUNING.governor.hazeKeep : 1,
  };
}
