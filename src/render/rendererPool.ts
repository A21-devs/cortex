/**
 * Renderer pool (H6, CORTEX-UX §2.4). Owner: E10.
 *  - at most MAX_LIVE (3) live WebGL2 contexts across all Cortex leaves, least recently used first out;
 *  - a hidden live leaf gives its context up before a visible one does;
 *  - a visible leaf pushed out shows its last frame as a still with "Paused to save graphics memory. Click to bring
 *    this view back."; clicking it calls request(), which pauses the least recently used live leaf instead;
 *  - a leaf hidden for HIDDEN_RELEASE_MS (60 s) releases its GPU buffers and rebuilds them from the shared data
 *    when shown again (target < 300 ms);
 *  - the focused leaf renders at full rate; other visible leaves cap at 30 fps and pause their motion.
 * The pool decides; each leaf's RenderController obeys. Pure bookkeeping lives in LruPool (unit-tested); the pool
 * runs its own release timer.
 */
import { RENDER_TUNING } from "./tuning";

export const MAX_LIVE = RENDER_TUNING.pool.maxLive;
export const HIDDEN_RELEASE_MS = RENDER_TUNING.pool.hiddenReleaseMs;

export type LeafRenderState = "live" | "paused" | "released";

/** LRU bookkeeping of live renderers; no GPU work here. */
export class LruPool {
  private readonly live: string[] = [];
  private readonly hiddenSince = new Map<string, number>();

  constructor(private readonly max = MAX_LIVE) {}

  /**
   * A leaf wants to render (most recently used). Returns the leaf that must give up its context to make room, or
   * null: a hidden live leaf first (the one hidden longest), else the least recently used.
   */
  acquire(viewId: string): string | null {
    const i = this.live.indexOf(viewId);
    if (i >= 0) {
      this.live.splice(i, 1);
      this.live.push(viewId);
      return null;
    }
    this.live.push(viewId);
    if (this.live.length <= this.max) return null;
    let victim = -1;
    let oldest = Infinity;
    for (let k = 0; k < this.live.length - 1; k++) {
      const since = this.hiddenSince.get(this.live[k] as string);
      if (since !== undefined && since < oldest) {
        oldest = since;
        victim = k;
      }
    }
    if (victim < 0) victim = 0;
    const [out] = this.live.splice(victim, 1);
    return out ?? null;
  }

  /** Mark used without acquiring (focus): only live leaves move. */
  touch(viewId: string): void {
    const i = this.live.indexOf(viewId);
    if (i >= 0 && i !== this.live.length - 1) {
      this.live.splice(i, 1);
      this.live.push(viewId);
    }
  }

  release(viewId: string): void {
    const i = this.live.indexOf(viewId);
    if (i >= 0) this.live.splice(i, 1);
  }

  forget(viewId: string): void {
    this.release(viewId);
    this.hiddenSince.delete(viewId);
  }

  isLive(viewId: string): boolean {
    return this.live.includes(viewId);
  }

  setHidden(viewId: string, hidden: boolean, now: number): void {
    if (hidden) {
      if (!this.hiddenSince.has(viewId)) this.hiddenSince.set(viewId, now);
    } else this.hiddenSince.delete(viewId);
  }

  isHidden(viewId: string): boolean {
    return this.hiddenSince.has(viewId);
  }

  /** Live leaves hidden long enough to release their GPU buffers. */
  dueForRelease(now: number): string[] {
    const out: string[] = [];
    for (const [id, since] of this.hiddenSince) if (now - since >= HIDDEN_RELEASE_MS && this.live.includes(id)) out.push(id);
    return out;
  }

  /** Earliest time a hidden live leaf becomes due, or null. */
  nextDue(): number | null {
    let t: number | null = null;
    for (const [id, since] of this.hiddenSince) {
      if (!this.live.includes(id)) continue;
      const due = since + HIDDEN_RELEASE_MS;
      if (t === null || due < t) t = due;
    }
    return t;
  }

  liveIds(): readonly string[] {
    return this.live;
  }
}

export interface RendererPool {
  /** A leaf wants a context (opening, shown again, the still frame clicked). Returns its state ("live"). */
  request(viewId: string): LeafRenderState;
  setVisible(viewId: string, visible: boolean): void;
  setFocused(viewId: string): void;
  focused(): string | null;
  isLive(viewId: string): boolean;
  /** The leaf closed: forget it. */
  release(viewId: string): void;
  /** Subscribe to state changes of a leaf (paused by another leaf, released after 60 s hidden, live again). */
  onChange(viewId: string, fn: (state: LeafRenderState) => void): () => void;
  /** Subscribe to focus changes (unfocused leaves cap at 30 fps and pause motion). */
  onFocus(fn: (viewId: string | null) => void): () => void;
  /** Release leaves hidden for 60 s (also run by the pool's own timer). */
  sweep(now: number): void;
  dispose(): void;
}

export interface PoolTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: PoolTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createRendererPool(now: () => number = () => Date.now(), max = MAX_LIVE, timers: PoolTimers = defaultTimers): RendererPool {
  const lru = new LruPool(max);
  const listeners = new Map<string, Set<(s: LeafRenderState) => void>>();
  const focusListeners = new Set<(id: string | null) => void>();
  let focusedId: string | null = null;
  let timer: unknown = null;
  let disposed = false;
  /** Leaves that gave their context up while hidden: they come back by themselves when shown again. */
  const released = new Set<string>();

  const notify = (id: string, s: LeafRenderState): void => {
    const set = listeners.get(id);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(s);
      } catch (e) {
        // One leaf's failure must not stop the others from hearing about the change; surface it asynchronously.
        queueMicrotask(() => {
          throw e;
        });
      }
    }
  };

  const schedule = (): void => {
    if (disposed) return;
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    const due = lru.nextDue();
    if (due === null) return;
    timer = timers.setTimeout(() => {
      timer = null;
      pool.sweep(now());
    }, Math.max(0, due - now()) + 5);
  };

  const pool: RendererPool = {
    request(viewId) {
      const wasLive = lru.isLive(viewId);
      released.delete(viewId);
      const evicted = lru.acquire(viewId);
      if (evicted) {
        const hidden = lru.isHidden(evicted);
        if (hidden) released.add(evicted);
        notify(evicted, hidden ? "released" : "paused");
      }
      if (!wasLive) notify(viewId, "live");
      schedule();
      return "live";
    },
    setVisible(viewId, visible) {
      lru.setHidden(viewId, !visible, now());
      // A leaf released after 60 s hidden rebuilds as soon as it is shown again (§2.4); without this the stage
      // stayed on its still frame for good once Obsidian had been behind another window for a minute.
      if (visible && released.has(viewId) && listeners.has(viewId)) {
        pool.request(viewId);
        return;
      }
      schedule();
    },
    setFocused(viewId) {
      lru.touch(viewId);
      if (focusedId === viewId) return;
      focusedId = viewId;
      for (const fn of [...focusListeners]) fn(viewId);
    },
    focused: () => focusedId,
    isLive: (viewId) => lru.isLive(viewId),
    release(viewId) {
      lru.forget(viewId);
      released.delete(viewId);
      listeners.delete(viewId);
      if (focusedId === viewId) {
        focusedId = null;
        for (const fn of [...focusListeners]) fn(null);
      }
      schedule();
    },
    onChange(viewId, fn) {
      const set = listeners.get(viewId) ?? new Set();
      set.add(fn);
      listeners.set(viewId, set);
      return () => {
        set.delete(fn);
      };
    },
    onFocus(fn) {
      focusListeners.add(fn);
      return () => {
        focusListeners.delete(fn);
      };
    },
    sweep(t) {
      for (const id of lru.dueForRelease(t)) {
        lru.release(id);
        released.add(id);
        notify(id, "released");
      }
      schedule();
    },
    dispose() {
      disposed = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      listeners.clear();
      focusListeners.clear();
    },
  };
  return pool;
}
