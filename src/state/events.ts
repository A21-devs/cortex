/**
 * Typed event bus for cross-module notifications that are not state (one-shot happenings). Owner: E7.
 * State lives in signals (store.ts); events say "something happened". Leaf-specific events carry `viewId`.
 */
import type { FromRunner } from "../shared/protocol/runner";
import type { RegionLabel } from "../shared/protocol/worker";
import type { ReceiptView } from "./types";

/**
 * One leg of a scripted camera move (Showcase mode). `yawDeg` and `pitchDeg` are turns away from the home heading and pitch,
 * `distance` a multiple of the home distance, `at` what it looks at ("home" the home aim, "brain", "neck" (between the brain and the figure's middle), "figure", or one record's
 * point), `roll` the turn of the picture about the line of sight (0 upright), `ms` the leg's length.
 */
export interface CameraMoveLeg {
  yawDeg?: number;
  pitchDeg?: number;
  distance?: number;
  at?: "home" | "brain" | "neck" | "figure" | { ordinal: number };
  rollDeg?: number;
  ms: number;
  ease?: "inout" | "out" | "linear";
}

export interface CortexEvents {
  "index:loaded": { count: number; seq: number; epoch: string };
  "index:delta": { added: number; seq: number; epoch: string };
  "index:patched": { ordinals: number; epoch: string };
  /** New items reached the shared index; each leaf decides whether to show them (revealedCount / "Show them"). */
  arrivals: { added: number; available: number };
  /** `regions`: the brain-region labels Placement › By role produced (empty for By area). */
  "layout:placement": { viewId: string; slotsKey: string; regions?: RegionLabel[] };
  "layout:arrangement": { viewId: string; kind: "groups" | "chart"; /** How long the points travel before the labels come back, when longer than the usual morph (the role comet's sway). */ settleMs?: number };
  "runner:frame": FromRunner;
  "camera:fly-to": { viewId: string; ordinal: number } | { viewId: string; home: true };
  /** Showcase mode: fly a scripted path of camera legs (dolly, orbit, comet tilt, fly-through); `legs: []` stops it. */
  "camera:move": { viewId: string; legs: CameraMoveLeg[] };
  /** Showcase mode: remember the camera pose, and put it back when the tour ends. */
  "camera:save": { viewId: string };
  "camera:restore": { viewId: string };
  "canvas:resized": { viewId: string; width: number; height: number; insetRight: number };
  "palette:changed": Record<string, never>;
  "settings:changed": Record<string, never>;
  "ai:receipt": ReceiptView;
  "intro:play": { viewId: string; reason: "first-open" | "rebuild" | "replay" | "first-paint" };
  /** Obsidian's active file changed (Follow the active note). */
  "active-note": { path: string | null };
  /** A first-run checklist step or one-time hint happened. */
  "checklist:step": { step: "add-source" | "open-frond" | "ask-question" };
  /** A problem worth a line in Export diagnostics and the status bar (code from the runner's warning catalogue). */
  warning: { code: string; detail?: Record<string, unknown> };
  /** A palette command that the owning leaf's UI performs. */
  command: { viewId: string; id: "save-image" | "copy-data-csv" | "toggle-sample" };
  error: { scope: string; code: string };
}

type Handler<T> = (payload: T) => void;

export class EventBus<E extends object = CortexEvents> {
  private readonly handlers = new Map<keyof E, Set<Handler<never>>>();

  on<K extends keyof E>(event: K, fn: Handler<E[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(fn as Handler<never>);
    return () => set?.delete(fn as Handler<never>);
  }

  once<K extends keyof E>(event: K, fn: Handler<E[K]>): () => void {
    const off = this.on(event, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as Handler<E[K]>)(payload);
      } catch (e) {
        console.error(`[cortex] handler for ${String(event)} failed`, e);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
