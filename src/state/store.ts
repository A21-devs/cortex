/**
 * Signal stores (@preact/signals-core). Owner: E7.
 *  - createLeafStore(): one per Cortex tab (shape, colours, scope, period, tokens, selection, sheet stack …);
 *  - createSharedStore(): one per plugin (data status, activity, queues, changes).
 * Components read slices through @preact/signals; the renderer controller subscribes with `effect`. Writes go
 * through `update` so slices stay immutable (new object per change) and can be batched.
 */
import { batch, signal, type Signal } from "@preact/signals-core";
import type { LeafSlices, SharedSlices } from "./types";
import { defaultShared, defaultUi, DEFAULT_VIEW } from "./types";

export interface SliceStore<S extends object> {
  readonly slices: { readonly [K in keyof S]: Signal<S[K]> };
  get<K extends keyof S>(slice: K): S[K];
  /** Shallow-merge a patch (objects) or replace via function. */
  update<K extends keyof S>(slice: K, patch: Partial<S[K]> | ((prev: S[K]) => S[K])): void;
  batch(fn: () => void): void;
}

/** The per-leaf store. */
export interface CortexStore extends SliceStore<LeafSlices> {
  /** Snapshot of ui/view/selection for view-change undo (Ask's view actions, Reset display). */
  snapshot(): Pick<LeafSlices, "ui" | "view" | "selection">;
  restore(s: Pick<LeafSlices, "ui" | "view" | "selection">): void;
}

export type SharedStore = SliceStore<SharedSlices>;

function createSliceStore<S extends object>(base: S): SliceStore<S> {
  const slices = {} as { [K in keyof S]: Signal<S[K]> };
  for (const k of Object.keys(base) as (keyof S)[]) slices[k] = signal(base[k]);
  return {
    slices,
    get: (k) => slices[k].value,
    update(k, patch) {
      const sig = slices[k];
      const prev = sig.value;
      if (typeof patch === "function") {
        sig.value = (patch as (p: typeof prev) => typeof prev)(prev);
      } else if (prev !== null && typeof prev === "object" && !Array.isArray(prev)) {
        sig.value = { ...(prev as object), ...(patch as object) } as typeof prev;
      } else {
        sig.value = patch as typeof prev;
      }
    },
    batch: (fn) => batch(fn),
  };
}

export function initialLeafSlices(): LeafSlices {
  return { ui: defaultUi(), view: { ...DEFAULT_VIEW }, selection: null, hover: null, legend: null, lit: null, lens: null };
}

export function createLeafStore(init: Partial<LeafSlices> = {}): CortexStore {
  const s = createSliceStore<LeafSlices>({ ...initialLeafSlices(), ...init });
  return {
    ...s,
    snapshot: () => ({ ui: s.slices.ui.value, view: s.slices.view.value, selection: s.slices.selection.value }),
    restore(snap) {
      batch(() => {
        s.slices.ui.value = snap.ui;
        s.slices.view.value = snap.view;
        s.slices.selection.value = snap.selection;
      });
    },
  };
}

export function createSharedStore(init: Partial<SharedSlices> = {}): SharedStore {
  return createSliceStore<SharedSlices>({ ...defaultShared(), ...init });
}
