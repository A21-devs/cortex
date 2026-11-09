/**
 * Background tier scheduling (H2, BG-IMPORT-UNWIRED, SAFE-11). Owner: E1. Part of the eager core: tiny and
 * free of imports.
 *
 * At onLayoutReady the plugin schedules `setTimeout(30 s) → requestIdleCallback → start()`. start() builds the
 * headless service subset (settings, runner client, agents clock, ledger reader, status bar, notices) through
 * plugin/container.ts, WITHOUT evaluating Preact, three.js or the worker, and starts the AgentsClock: a
 * startup import (Claude Code + .raw/), then fs.watch-debounced imports and idle/nightly agents.
 *
 * Gate (SAFE-11): nothing is imported and no agent runs until `settings.general.firstRunDone` is true and the
 * settings are not corrupt. When the start is due while the gate is closed, the schedule waits in "gated"
 * (onGated reports why, for the status bar and the one first-run notice) and `recheck()` — called on every
 * settings change — starts it as soon as the gate opens. If the gate opens before the delay has passed because
 * the user just finished the first-run step, the start happens at once instead of waiting out the delay.
 *
 * The activity tracker records the last pointer or keyboard input anywhere in Obsidian (main window and
 * pop-outs) for the agents clock's "Only work while Obsidian is idle".
 *
 * onunload: clock.stop() (closing its fs.watch handles) BEFORE runner.stop(). The UI tier reuses these
 * instances (CortexServices extends BackgroundServices).
 */

export const BACKGROUND_DELAY_MS = 30_000;
export const IDLE_TIMEOUT_MS = 5_000;

export interface BackgroundTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** requestIdleCallback when present; otherwise a short timeout. */
  requestIdle(fn: () => void, timeoutMs: number): unknown;
  cancelIdle?(handle: unknown): void;
}

export interface BackgroundGate {
  firstRunDone(): boolean;
  corrupt(): boolean;
}

export type GateReason = "first-run" | "corrupt";
export type BackgroundState = "waiting" | "gated" | "starting" | "started" | "cancelled";

export interface BackgroundSchedule {
  readonly state: BackgroundState;
  /** Re-evaluate the gate (settings changed). Starts when the start is due or consent was just given. */
  recheck(): void;
  cancel(): void;
}

export interface ScheduleOptions {
  delayMs?: number;
  /** Called each time the start was due (or rechecked) while the gate was closed. */
  onGated?(reason: GateReason): void;
}

/** Why the gate is closed (corrupt settings win over a missing first-run step), or null when open. */
export function gateReason(gate: BackgroundGate): GateReason | null {
  if (gate.corrupt()) return "corrupt";
  if (!gate.firstRunDone()) return "first-run";
  return null;
}

/**
 * Schedule the background start. It runs at most once, even when no Cortex tab is open, and only while the
 * gate is open. The returned schedule is cancelled from onunload (plugin.register).
 */
export function scheduleBackgroundStart(timers: BackgroundTimers, gate: BackgroundGate, start: () => void, opts: ScheduleOptions = {}): BackgroundSchedule {
  const delayMs = Math.max(0, opts.delayMs ?? BACKGROUND_DELAY_MS);
  let state: BackgroundState = "waiting";
  let timer: unknown = null;
  let idle: unknown = null;
  const openAtSchedule = gateReason(gate) === null;

  const gated = (reason: GateReason): void => {
    state = "gated";
    try {
      opts.onGated?.(reason);
    } catch {
      // reporting is best effort
    }
  };

  const go = (): void => {
    state = "starting";
    idle = timers.requestIdle(() => {
      idle = null;
      if (state !== "starting") return;
      const reason = gateReason(gate);
      if (reason !== null) {
        gated(reason);
        return;
      }
      state = "started";
      start();
    }, IDLE_TIMEOUT_MS);
  };

  timer = timers.setTimeout(() => {
    timer = null;
    if (state !== "waiting") return;
    const reason = gateReason(gate);
    if (reason !== null) gated(reason);
    else go();
  }, delayMs);

  return {
    get state() {
      return state;
    },
    recheck() {
      if (state !== "waiting" && state !== "gated") return;
      const reason = gateReason(gate);
      if (reason !== null) {
        if (state === "gated") gated(reason);
        return;
      }
      // Open now: start when it was due already, or when consent arrived during the delay.
      if (state === "gated" || !openAtSchedule) {
        if (timer !== null) {
          timers.clearTimeout(timer);
          timer = null;
        }
        go();
      }
    },
    cancel() {
      if (state === "cancelled") return;
      state = "cancelled";
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      if (idle !== null) timers.cancelIdle?.(idle);
      idle = null;
    },
  };
}

type IdleWindow = Pick<Window, "setTimeout" | "clearTimeout"> & {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/** Browser timers with requestIdleCallback feature detection (bound to the main window). */
export function windowTimers(win: IdleWindow): BackgroundTimers {
  const hasIdle = typeof win.requestIdleCallback === "function";
  return {
    setTimeout: (fn, ms) => win.setTimeout(fn, ms),
    clearTimeout: (h) => win.clearTimeout(h as number),
    requestIdle: (fn, timeoutMs) => (hasIdle ? (win.requestIdleCallback as NonNullable<IdleWindow["requestIdleCallback"]>)(fn, { timeout: timeoutMs }) : win.setTimeout(fn, 250)),
    cancelIdle: (h) => {
      if (hasIdle && typeof win.cancelIdleCallback === "function") win.cancelIdleCallback(h as number);
      else win.clearTimeout(h as number);
    },
  };
}

export interface ActivityTracker {
  /** Record user input now (pointer, keyboard, wheel). */
  touch(): void;
  /** Milliseconds since the last recorded input (since creation when there was none). */
  idleMs(): number;
}

export function createActivityTracker(now: () => number = () => Date.now()): ActivityTracker {
  let last = now();
  return {
    touch() {
      last = now();
    },
    idleMs() {
      return Math.max(0, now() - last);
    },
  };
}

/** DOM events that count as the user being active (registered passive and in the capture phase). */
export const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
