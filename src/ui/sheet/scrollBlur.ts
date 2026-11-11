/**
 * Scroll blur for the reader (the Read drawer's entry reader): while a wheel scroll runs fast, the page softens by one
 * pixel and clears about 60 ms after the last fast scroll event. Skipped under reduced motion.
 */

/** Scroll speed (px per ms) above which the page softens. */
export const BLUR_SPEED = 2;
/** How long the blur lingers after the last fast scroll event (ms). */
export const BLUR_HOLD_MS = 60;
/** Class the sheet body carries while softened. */
export const BLUR_CLASS = "is-scroll-blur";

/** True when a scroll from `fromTop` at `fromMs` to `top` at `ms` is fast enough to blur. */
export function scrollIsFast(fromTop: number, fromMs: number, top: number, ms: number): boolean {
  const dt = ms - fromMs;
  if (dt <= 0 || dt > 120) return false;
  return Math.abs(top - fromTop) / dt > BLUR_SPEED;
}

export interface ScrollBlur {
  /** Call from the element's scroll event. */
  onScroll(top: number, nowMs?: number): void;
  /** Clear the timer and the class (unmount, route change). */
  dispose(): void;
}

/** Blur controller for one scrolling element: toggles BLUR_CLASS directly (no re-render per scroll event). */
export function createScrollBlur(el: { classList: { add(c: string): void; remove(c: string): void } }, reduced: () => boolean, hold: number = BLUR_HOLD_MS): ScrollBlur {
  let last: { top: number; ms: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    el.classList.remove(BLUR_CLASS);
  };
  return {
    onScroll(top, nowMs = Date.now()) {
      const prev = last;
      last = { top, ms: nowMs };
      if (!prev || reduced() || !scrollIsFast(prev.top, prev.ms, top, nowMs)) return;
      el.classList.add(BLUR_CLASS);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(clear, hold);
    },
    dispose: clear,
  };
}
