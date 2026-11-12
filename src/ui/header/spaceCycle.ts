/**
 * Space chip cycling (SPEC F13 / V4). Pure logic for the chip's three extra ways to change area, so it can be tested
 * without a DOM: click = next, mouse wheel = step, and a hover preview that cycles through the areas after the
 * pointer has rested on the chip (leaving restores). The menu (caret), [ ] and the compass are unchanged.
 */
import type { SpaceId } from "../../shared/types";
import { userScope, type UserScope, type UserSpace } from "../../shared/userSpaces";
import type { IndexCounts } from "../context";
import type { AreaRow } from "./ScopePicker";

/** An area, "all", or one of the person's own spaces ("user:<id>", shared/userSpaces.ts). */
export type Scope = SpaceId | "all" | UserScope;

/** Rest on the chip this long before the preview starts, then step this often. */
export const HOVER_DELAY_MS = 700;
export const HOVER_STEP_MS = 900;
/** Wheel notches closer together than this count as one step (a smooth-scroll burst stays readable). */
export const WHEEL_GAP_MS = 90;

/**
 * "All areas", then every area worth landing on in menu order, then "No area" when something sits in it, then the
 * person's own spaces (those that gather something) in the order they keep them.
 */
export function cycleOrder(rows: readonly AreaRow[], counts: IndexCounts | null, userSpaces: readonly Pick<UserSpace, "id" | "areas" | "folders">[] = []): Scope[] {
  const out: Scope[] = ["all", ...rows.map((r) => r.id)];
  const none = counts ? (counts.notesBySpace.none ?? 0) + (counts.recordBySpace.none ?? 0) : 0;
  if (none > 0) out.push("none");
  // A space with nothing in it has nothing to show, so the cycle skips it.
  for (const u of userSpaces) if (u.areas.length + u.folders.length > 0) out.push(userScope(u.id));
  return out;
}

/** The scope `dir` steps from `cur` around the cycle; a scope outside the cycle starts from "all". */
export function stepCycle(order: readonly Scope[], cur: Scope, dir: 1 | -1): Scope {
  if (order.length === 0) return cur;
  const i = Math.max(0, order.indexOf(cur));
  const n = order.length;
  return order[(((i + dir) % n) + n) % n] as Scope;
}

/**
 * Where a plain click on the rail wordmark lands: the area the word is previewing when a hover or wheel preview is showing
 * (what you see is what you keep), else the next area after the current one, wrapping from the last back to All areas.
 */
export function clickTarget(order: readonly Scope[], current: Scope, lens: Scope | null): Scope {
  return lens ?? stepCycle(order, current, 1);
}

/** Wheel notch → step direction (down = next), or 0 when it arrives inside the gap of the previous step. */
export function wheelStep(deltaY: number, lastStepAt: number, now: number, gapMs: number = WHEEL_GAP_MS): 1 | -1 | 0 {
  if (deltaY === 0 || now - lastStepAt < gapMs) return 0;
  return deltaY > 0 ? 1 : -1;
}

/**
 * A wheel gate: a step only after a quiet gap, and every event renews the gap, so one trackpad flick (a long run of
 * closely spaced events) is one step while separate mouse-wheel notches each step.
 */
export function createWheelGate(gapMs: number = WHEEL_GAP_MS): (deltaY: number, now: number) => 1 | -1 | 0 {
  let last = Number.NEGATIVE_INFINITY;
  return (deltaY, now) => {
    const dir = wheelStep(deltaY, last, now, gapMs);
    if (deltaY !== 0) last = now;
    return dir;
  };
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export interface HoverCycle {
  /** Leave the chip: stop, and tell the caller to restore. */
  cancel(): void;
}

/**
 * Start a hover preview: after `delayMs` show the area after the current one, then the next every `stepMs`.
 * `onPreview(scope)` is called for each shown area, and `onPreview(null)` once when the cycle is cancelled after it
 * had started (nothing is called when the pointer leaves before the delay).
 */
export function startHoverCycle(p: {
  order: () => readonly Scope[];
  current: () => Scope;
  onPreview(scope: Scope | null): void;
  delayMs?: number;
  stepMs?: number;
  timers?: Timers;
}): HoverCycle {
  const timers: Timers = p.timers ?? { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (h) => globalThis.clearTimeout(h as number) };
  let handle: unknown = null;
  let shown: Scope | null = null;
  let stopped = false;
  const step = (): void => {
    if (stopped) return;
    shown = stepCycle(p.order(), shown ?? p.current(), 1);
    p.onPreview(shown);
    handle = timers.setTimeout(step, p.stepMs ?? HOVER_STEP_MS);
  };
  handle = timers.setTimeout(step, p.delayMs ?? HOVER_DELAY_MS);
  return {
    cancel(): void {
      if (stopped) return;
      stopped = true;
      if (handle !== null) timers.clearTimeout(handle);
      handle = null;
      if (shown !== null) p.onPreview(null);
      shown = null;
    },
  };
}
