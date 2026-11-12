/**
 * Showcase mode: a hands-free performance of the figure and the charts, looping until stopped. Nothing on screen says
 * it is running: the window simply starts moving, every chrome element stays as the person has it, and the beats
 * (registry.ts) cut about every half second with calmer holds only on the figure. It shows the figure and the charts
 * drawn on it, nothing else (the user's rule): no page or tab (not even Chart or Time), never Settings, the add sheet, a
 * reader, the Display panel or any other panel, a menu, the start card, a banner, a hint, the walkthrough, a toast, an
 * error, a tooltip, a note preview or a dialog. As it starts the panels and menus the person had open are put away
 * (and come back on stop, the menus excepted); while it runs the overlays are hidden in place (dom.ts muteOverlays) and
 * a toast posted meanwhile waits until it ends.
 *
 * Toggled by Ctrl+0 then Ctrl+9 (chord.ts), by the "Showcase mode" command and by Cortex Desktop's View menu. One tour
 * runs at a time. It does not start while the app is locked or a dialog is open, and it ends by itself when the lock
 * comes up (the idle auto-lock included) or a dialog opens. Any key, click or wheel stops it and puts the previous view,
 * shape, chart, panels, theme, palette (a space's own look included), scope, selection, camera and scroll back exactly;
 * the key, press or wheel that stops it does nothing else (no hotkey, no click on what is under the pointer, no zoom).
 * Read-only by construction: the steps only move the view (in-memory store actions and renderer events), the colours
 * are shown through the settings preview (never saved), a grouping's colours are a preview too (never written to the
 * record's colour file), the entries it picks are only selected (never opened or recorded as reads), and no agent or
 * model is ever called.
 */
import { Scope } from "obsidian";
import { applyColourTheme, COLOUR_THEME_IDS, type ColourThemeId } from "../../shared/colourTheme";
import { Population, SPACE_ORDER } from "../../shared/index-format";
import type { CortexServices, LeafServices } from "../../plugin/services";
import { DATA_COLOUR_IDS } from "../../shared/palette";
import type { PaletteId } from "../../shared/settings";
import type { SpaceId } from "../../shared/types";
import { activeUserSpace, applyUserSpaceLook, hasLook, type UserSpace } from "../../shared/userSpaces";
import { appLocked } from "../../state/lock";
import type { ViewControls } from "../../state/types";
import { indexCounts, isReducedMotion, loadedIndex, shellOfView, stageBus, type Shell, type ShellToast } from "../context";
import { animateMorph, cancelMorph } from "../stage/ShapeBar";
import { createChord, type Chord } from "./chord";
import { closeMenus, holdPointer, modalOpen, muteOverlays, rememberTilt, restoreTilt, tiltWindow, tourIsDriving } from "./dom";
import { buildShowcase, offeredCharts, offeredLayouts, type ShowcaseCtx, type ShowcaseEnv, type ShowcaseStep, type TourEntry } from "./registry";

type Leaf = Pick<LeafServices, "viewId" | "store">;

interface Run {
  stop(): void;
  startedAt: number;
}

const runs = new WeakMap<Shell, Run>();
/** The shells with a tour running (at most one: two tours would fight over the one settings preview). */
const active = new Set<Shell>();
/** A camera still to be handed back after a tour ended (the view it returned to is being laid out again). */
const pendingCamera = new WeakMap<Shell, () => void>();

/** How long after the body comes back its pose goes back (the controller lays the view out 24 ms after a change). */
const CAMERA_BODY_MS = 60;
/** The longest wait for the worker to lay a returned shape out before the pose goes back anyway. */
const CAMERA_WAIT_MS = 4000;
/** How long after that a further layout of the same view (a chart re-fitted to the stage's new size) still gets the pose back. */
const CAMERA_LINGER_MS = 700;
/** The longest the press that stopped the tour is waited on for its release. */
const PRESS_HOLD_MS = 5000;
/** After that release, how long its click and its context menu are still waited for. */
const PRESS_TAIL_MS = 300;
/** The wheel resting this long ends the gesture that stopped the tour. */
const WHEEL_REST_MS = 250;
/** The longest a wheel gesture that stopped the tour is held (a trackpad's glide included). */
const WHEEL_HOLD_MS = 2000;
/** A modifier pressed alone is not a key that stops the tour (the chord itself is held with one). */
const MODIFIER_KEYS: readonly string[] = ["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"];

export function showcaseRunning(shell: Shell): boolean {
  return runs.has(shell);
}

/** True while a tour runs in any view. A view whose tour lost its window (closed mid-tour) is let go here. */
export function anyShowcaseRunning(): boolean {
  for (const sh of [...active]) {
    if (sh.root?.isConnected) continue;
    runs.get(sh)?.stop();
    active.delete(sh);
  }
  return active.size > 0;
}

/** The tour for this record: what the build offers, narrowed to areas that hold something and themes the settings can preview. */
export function showcaseEnv(s: CortexServices): ShowcaseEnv {
  const counts = indexCounts(s);
  const areas = counts ? SPACE_ORDER.filter((a) => (counts.notesBySpace[a] ?? 0) + (counts.recordBySpace[a] ?? 0) > 0) : [];
  const order: ColourThemeId[] = [...COLOUR_THEME_IDS.filter((id) => id !== "default"), "default"];
  // The data palettes other than the one in use (the tour ends by showing the person's own again).
  const own = s.settings.value.appearance.palette;
  const palettes = typeof s.settings.preview === "function" ? DATA_COLOUR_IDS.filter((id) => id !== own).slice(0, 4) : [];
  return {
    layouts: offeredLayouts(),
    charts: offeredCharts(),
    themes: typeof s.settings.preview === "function" ? order : [],
    areas,
    palettes,
  };
}

/** Entries for the tour to select on the figure, spread through the record's own entries (the whole index when it has none). */
function pickTourEntries(s: CortexServices, n: number): TourEntry[] {
  const ix = loadedIndex(s);
  if (!ix || ix.count === 0 || n <= 0) return [];
  let pool: number[] = [];
  for (let i = 0; i < ix.count; i++) if (ix.cols.pop[i] === Population.Record) pool.push(i);
  if (pool.length === 0) pool = Array.from({ length: ix.count }, (_, i) => i);
  const out: TourEntry[] = [];
  const seen = new Set<string>();
  for (let k = 0; k < n; k++) {
    // Evenly through the pool, each a different entry.
    const ordinal = pool[Math.min(pool.length - 1, Math.floor(((k + 0.5) * pool.length) / n))] as number;
    const id = ix.ids.get(ordinal);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ordinal, id });
  }
  return out;
}

/**
 * The press that stopped the tour does nothing else: its release, click and context menu are kept from the page, each
 * once. The stage takes a bare release for a click (it would select and open the point under the pointer, or clear the
 * selection the stop has just put back), a click would press what is under the pointer, and a right press would bring up
 * a point's menu. Held until a moment after the release (when its click and menu have come), or a few seconds without one.
 */
function swallowPress(doc: Document, win: Window): void {
  const types = ["pointerup", "mouseup", "click", "auxclick", "contextmenu"] as const;
  const eaten = new Set<string>();
  let timer: number | undefined;
  const off = (): void => {
    for (const type of types) doc.removeEventListener(type, eat, true);
    if (timer !== undefined) win.clearTimeout(timer);
    timer = undefined;
  };
  const endIn = (ms: number): void => {
    if (timer !== undefined) win.clearTimeout(timer);
    timer = win.setTimeout(off, ms);
  };
  function eat(e: Event): void {
    if (tourIsDriving() || eaten.has(e.type)) return;
    eaten.add(e.type);
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
    if (e.type === "pointerup" || e.type === "mouseup") endIn(PRESS_TAIL_MS);
  }
  for (const type of types) doc.addEventListener(type, eat, true);
  endIn(PRESS_HOLD_MS);
}

/**
 * The wheel gesture that stopped the tour does nothing else: the rest of its stream (a trackpad's glide, a fast wheel's
 * notches) is kept from the page until the wheel rests, so it neither zooms the camera the stop has just put back nor
 * counts as the person's next move (which would hand a waiting camera back before the view is laid out).
 */
function swallowWheel(doc: Document, win: Window): void {
  const until = Date.now() + WHEEL_HOLD_MS;
  let timer: number | undefined;
  const off = (): void => {
    doc.removeEventListener("wheel", eat, true);
    if (timer !== undefined) win.clearTimeout(timer);
    timer = undefined;
  };
  const restIn = (): void => {
    if (timer !== undefined) win.clearTimeout(timer);
    timer = win.setTimeout(off, WHEEL_REST_MS);
  };
  function eat(e: Event): void {
    if (tourIsDriving()) return;
    if (Date.now() > until) {
      off();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    restIn();
  }
  doc.addEventListener("wheel", eat, { capture: true, passive: false });
  restIn();
}

/**
 * Keep every hotkey off while the tour runs: a scope on top of the app's keymap takes each key first. Cortex Desktop's
 * keymap listens on the window, ahead of the tour's own listener on the document (and Obsidian's may too), so without it
 * the key that stops the tour would run its hotkey as well: Ctrl+Z would undo the last Ask change (a write), "/" would
 * focus Find, an app hotkey could open a dialog. The scope has no parent, so no other scope is asked. `take` sees each
 * key and says whether to swallow it (a modifier alone, a repeat and the tour's own Esc to a menu it opened are let be);
 * the key then goes on to the tour's listener, which stops the tour. Returns the remover.
 */
function holdHotkeys(app: unknown, take: (evt: KeyboardEvent) => boolean): () => void {
  const keymap = (app as { keymap?: { pushScope?(scope: Scope): void; popScope?(scope: Scope): void } } | null | undefined)?.keymap;
  if (typeof keymap?.pushScope !== "function" || typeof keymap.popScope !== "function") return () => undefined;
  const scope = new Scope();
  // false: handled (the keymap prevents the key's default and asks no one else).
  scope.register(null, null, (evt) => (take(evt) ? false : undefined));
  try {
    keymap.pushScope(scope);
  } catch {
    return () => undefined;
  }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    try {
      keymap.popScope?.(scope);
    } catch {
      // The keymap went with its app.
    }
  };
}

/** Elements under `root` that are scrolled away from their top, with where they are (put back when the tour stops). */
function scrollPositions(root: HTMLElement | null): Map<Element, number> {
  const out = new Map<Element, number>();
  if (!root?.querySelectorAll) return out;
  for (const el of Array.from(root.querySelectorAll("*"))) if (el.scrollTop > 0) out.set(el, el.scrollTop);
  return out;
}

/** The person's space whose colour look is on screen now (the settings show exactly that look), or null. */
function lookOnScreen(s: CortexServices, leafUi: { tokens: readonly { id: string }[]; scope: SpaceId | "all" }): UserSpace | null {
  const space = activeUserSpace(leafUi.tokens, leafUi.scope, s.settings.value.userSpaces ?? []);
  if (!hasLook(space)) return null;
  const now = s.settings.value.appearance;
  const probe = JSON.parse(JSON.stringify(now)) as typeof now;
  applyUserSpaceLook(probe, space);
  return JSON.stringify(probe) === JSON.stringify(now) ? space : null;
}

/** Would going from `a` to `b` lay the figure out again (the controller's own test: shape, grouping, layout, chart)? */
export function arrangementChanges(a: ViewControls, b: ViewControls): boolean {
  return a.shape !== b.shape || a.groupBy !== b.groupBy || a.layout !== b.layout || a.chart !== b.chart || a.splitGroups !== b.splitGroups || a.groupByRecord !== b.groupByRecord || a.layoutOptions.gridMarks !== b.layoutOptions.gridMarks;
}

/**
 * Start the tour on a leaf. Returns false when it cannot run (a tour already running, locked, a dialog open, no window).
 * `source` is one lap or a function that builds the lap for a number (the default: a new lap, in a new order, each time round).
 */
export function startShowcase(
  s: CortexServices,
  leaf: Leaf,
  shell: Shell,
  source: readonly ShowcaseStep[] | ((lap: number) => ShowcaseStep[]) = (lap) => buildShowcase(showcaseEnv(s), lap + 1),
): boolean {
  const doc = shell.doc;
  if (runs.has(shell) || anyShowcaseRunning() || appLocked.value || !doc || modalOpen(doc)) return false;
  const build = typeof source === "function" ? source : () => [...source];
  let steps = build(0);
  if (steps.length === 0) return false;
  // A camera the last tour has not handed back yet goes back now, before this tour keeps it.
  pendingCamera.get(shell)?.();
  const win = shell.win;
  const store = leaf.store;
  const bus = stageBus(s.bus);
  const viewId = leaf.viewId;
  const snap = store.snapshot();
  // At S the shape bar opens as a panel of its own (the shell holds it, not the store): it closes with the other panels
  // (settle) and opens again on stop.
  const shapeWasOpen = shell.shapeOpen.value;
  const root = shell.root;
  // A menu the person had open (More with Settings and Lock, Tools, a picker, a point's menu) is put away: menus live
  // outside the view, where nothing could keep one off the tour, and the chord still fires with one open. After the
  // snapshot, so an Esc that reaches the view instead changes nothing the stop does not put back.
  closeMenus(doc);
  // The overlays go first, so the tour's first frame already shows the figure alone.
  const muted = root ? muteOverlays(root) : null;
  const tiltMemory = root ? rememberTilt(root) : null;
  const scrolls = scrollPositions(root);
  const reduced = (): boolean => isReducedMotion(s.settings.value.appearance.motion, shell.systemReducedMotion.value);
  // The person's own look: one of their spaces with a colour theme or palette shows it through the same settings preview
  // the tour uses, so "back to the person's colours" puts that look back, not just the stored settings. Only when it
  // was on screen as the tour began (a real settings change since choosing the space ends that look).
  const spaceLook = lookOnScreen(s, snap.ui);
  const ownLook = (): void => {
    s.settings.endPreview?.();
    if (spaceLook) s.settings.preview?.((x) => applyUserSpaceLook(x.appearance, spaceLook));
  };
  let live = true;
  const timers = new Set<number>();
  const after = (ms: number, fn: () => void): void => {
    const id = win.setTimeout(() => {
      timers.delete(id);
      if (!live) return;
      try {
        fn();
      } catch {
        // A flourish that cannot run (the element is gone) is skipped.
      }
    }, Math.max(0, ms));
    timers.add(id);
  };
  const ctx: ShowcaseCtx = {
    store,
    // Read at each step: a record that finishes loading while the tour runs is toured from then on.
    get count(): number {
      return loadedIndex(s)?.count ?? 0;
    },
    base: snap.view,
    grow: () => bus.emit("intro:play", { viewId, reason: (loadedIndex(s)?.count ?? 0) > 0 ? "first-paint" : "replay" }),
    home: () => bus.emit("camera:fly-to", { viewId, home: true }),
    camera: (legs) => bus.emit("camera:move", { viewId, legs }),
    morph: (to, ms) => void animateMorph(store, to, { ms, win, reduced: reduced() }),
    theme: (id) => s.settings.preview?.((x) => applyColourTheme(x.appearance, id)),
    entries: (n) => pickTourEntries(s, n),
    after,
    ...(typeof s.settings.preview === "function"
      ? { palette: (id: PaletteId | null) => (id === null ? ownLook() : s.settings.preview?.((x) => void (x.appearance.figureColours = id))) }
      : {}),
    ...(root
      ? {
          tilt: (tilt) => tiltWindow(root, tilt),
        }
      : {}),
  };
  bus.emit("camera:save", { viewId });
  let lap = 0;
  let i = 0;
  let timer: number | undefined;
  const startedAt = Date.now();

  /** The next step this host and record can show: passed over without a pause when one cannot (at most two laps, so the loop always ends). */
  const nextStep = (): ShowcaseStep | null => {
    for (let guard = 0; guard <= steps.length * 2 + 2; guard++) {
      if (i >= steps.length) {
        lap++;
        steps = build(lap);
        i = 0;
        if (steps.length === 0) return null;
      }
      const step = steps[i++] as ShowcaseStep;
      if (step.available?.(ctx) === false) continue;
      return step;
    }
    return null;
  };

  const tick = (): void => {
    if (!live) return;
    // The view went away, the lock came up (the idle auto-lock too) or a dialog opened: the tour ends and the view comes back.
    if (!shell.root?.isConnected || appLocked.value || modalOpen(doc)) {
      stop();
      return;
    }
    muted?.sweep();
    const step = nextStep();
    if (!step) {
      timer = win.setTimeout(tick, 800);
      return;
    }
    try {
      step.run(ctx);
    } catch {
      // A step that cannot run on this record (an empty index) is skipped; the tour goes on.
    }
    timer = win.setTimeout(tick, step.hold);
  };

  // The key, press or wheel that stops the tour does nothing else: it is kept from the page (the stage, a focused field,
  // the chord), and its hotkey never ran (holdHotkeys).
  /** A key of the person's (not the tour's own, a modifier alone or a held key repeating). */
  const persons = (e: KeyboardEvent): boolean => !tourIsDriving() && !e.repeat && !MODIFIER_KEYS.includes(e.key);
  /** One that stops the tour: any of theirs once the first moment is past (the chord's own keys are still coming up). */
  const stopsTour = (e: KeyboardEvent): boolean => persons(e) && Date.now() - startedAt >= 400;
  const onKey = (e: KeyboardEvent): void => {
    if (!stopsTour(e)) return;
    e.preventDefault();
    e.stopPropagation();
    stop();
  };
  /** The keymap's turn (ahead of the document in Cortex Desktop): every key of the person's is swallowed, so no hotkey runs. */
  const onHotkey = (e: KeyboardEvent): boolean => {
    if (!persons(e)) return false;
    // The tour's listener on the document stops the tour as the key goes by; should a keymap keep the key from the
    // document, the tour stops just after instead (so any key always stops it).
    if (stopsTour(e)) win.setTimeout(stop, 0);
    return true;
  };
  const onPointer = (e: Event): void => {
    if (tourIsDriving()) return;
    e.stopPropagation();
    swallowPress(doc, win);
    stop();
  };
  const onWheel = (e: Event): void => {
    if (tourIsDriving() || Date.now() - startedAt < 400) return;
    // Not on to the canvas, which would zoom the camera the stop puts back; the rest of the gesture is held too.
    e.preventDefault();
    e.stopPropagation();
    swallowWheel(doc, win);
    stop();
  };

  // What the tour holds while it runs (listeners and subscriptions), let go when it stops.
  const holds: (() => void)[] = [];
  // Toasts wait until the tour ends: one posted while it runs (the frame-rate governor's, an error) is kept and shown after.
  const heldToasts: ShellToast[] = [...shell.toasts.value];

  /**
   * Hand the person's camera back. When the view it returns to is laid out again (its shape, grouping, layout or chart
   * differ from the tour's last), the controller re-arranges it a moment after the store is restored and that re-fit
   * would carry the camera off the pose: the pose then goes back once that layout has landed (the body's straight after
   * the controller's 24 ms, a shape's when the worker answers), and again after any further layout of the same view in
   * the moment after (a chart re-fitted to the stage's new size). The person's own first press, wheel or key puts it
   * back at once and ends the wait.
   */
  const returnCamera = (rearranged: boolean): void => {
    if (!rearranged) {
      bus.emit("camera:restore", { viewId });
      return;
    }
    const body = snap.view.shape === "body";
    let done = false;
    let laid = false;
    let wait: number | undefined;
    const putBack = (keepForLater: boolean): void => {
      bus.emit("camera:restore", { viewId });
      // Kept once more, for a further layout of the same view in the next moment.
      if (keepForLater) bus.emit("camera:save", { viewId });
    };
    const inputs = ["pointerdown", "wheel", "keydown"] as const;
    const onInput = (): void => flush();
    let offLayout: () => void = () => undefined;
    const end = (): void => {
      if (done) return;
      done = true;
      if (wait !== undefined) win.clearTimeout(wait);
      offLayout();
      for (const type of inputs) doc.removeEventListener(type, onInput, true);
      if (pendingCamera.get(shell) === flush) pendingCamera.delete(shell);
    };
    function flush(): void {
      if (done) return;
      if (!laid) putBack(false);
      end();
    }
    if (body) wait = win.setTimeout(flush, CAMERA_BODY_MS);
    else {
      offLayout = bus.on("layout:arrangement", (e) => {
        if (done || e.viewId !== viewId) return;
        putBack(true);
        laid = true;
        if (wait !== undefined) win.clearTimeout(wait);
        wait = win.setTimeout(end, CAMERA_LINGER_MS);
      });
      wait = win.setTimeout(flush, CAMERA_WAIT_MS);
    }
    for (const type of inputs) doc.addEventListener(type, onInput, true);
    pendingCamera.set(shell, flush);
  };

  const stop = (): void => {
    if (!live) return;
    live = false;
    if (timer !== undefined) win.clearTimeout(timer);
    for (const id of timers) win.clearTimeout(id);
    timers.clear();
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("pointerdown", onPointer, true);
    doc.removeEventListener("wheel", onWheel, true);
    // The hotkeys come back first, so the Esc below reaches a menu that came up meanwhile.
    for (const off of holds.splice(0)) off();
    runs.delete(shell);
    active.delete(shell);
    cancelMorph(store);
    // Whatever the tour put up goes away: the colour previews and the window's tilt (and any menu that came up meanwhile).
    closeMenus(doc);
    ownLook();
    if (root && tiltMemory) restoreTilt(root, tiltMemory);
    // The same view, panels and selection as before; what the window measures (breakpoint, paused, arrivals, the open note) stays current.
    const now = store.get("ui");
    const rearranged = arrangementChanges(store.get("view"), snap.view);
    store.restore({
      ui: { ...snap.ui, breakpoint: now.breakpoint, paused: now.paused, revealedCount: now.revealedCount, activeNote: now.activeNote, preview: null, dimPreview: null, hoverRange: null },
      view: snap.view,
      selection: snap.selection,
    });
    if (shapeWasOpen) shell.shapeOpen.value = true;
    // The overlays come back, and the toasts that waited show now.
    muted?.release();
    if (heldToasts.length > 0) shell.toasts.value = [...shell.toasts.value, ...heldToasts].slice(-10);
    bus.emit("camera:move", { viewId, legs: [] });
    returnCamera(rearranged);
    // The panels that come back are drawn a moment later: their scroll goes back then.
    const putScrollBack = (): void => {
      for (const [el, top] of scrolls) if (el.isConnected) el.scrollTop = top;
    };
    putScrollBack();
    win.requestAnimationFrame?.(putScrollBack);
  };

  runs.set(shell, { stop, startedAt });
  active.add(shell);
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("pointerdown", onPointer, true);
  doc.addEventListener("wheel", onWheel, { capture: true, passive: false });
  holds.push(holdHotkeys(s.app, onHotkey));
  if (heldToasts.length > 0) shell.toasts.value = [];
  holds.push(
    shell.toasts.subscribe((list) => {
      if (list.length === 0) return;
      for (const tt of list) {
        const at = heldToasts.findIndex((h) => h.id === tt.id);
        if (at >= 0) heldToasts.splice(at, 1);
        heldToasts.push(tt);
      }
      shell.toasts.value = [];
    }),
  );
  // The shape bar's own panel at S stays shut while the tour runs (closed now, and again if anything opens it).
  holds.push(
    shell.shapeOpen.subscribe((open) => {
      if (open) shell.shapeOpen.value = false;
    }),
  );
  // No tooltip or member card: what was under the pointer is let go, and nothing new comes up (holdPointer).
  if (store.get("hover") !== null) store.update("hover", () => null);
  holds.push(
    store.slices.hover.subscribe((h) => {
      if (h !== null) store.update("hover", () => null);
    }),
  );
  if (root) holds.push(holdPointer(doc, root));
  // The lock (Lock now, or the idle auto-lock) ends the tour at once; its card is never toured over.
  holds.push(
    appLocked.subscribe((locked) => {
      if (locked) stop();
    }),
  );
  tick();
  return true;
}

export function stopShowcase(shell: Shell): void {
  runs.get(shell)?.stop();
}

/** How long the command and the menu wait for a dialog that is closing (the command palette the command came from) before trying once more. */
const RETRY_AFTER_DIALOG_MS = 300;

/** The command and the menu entry: start it, or stop it when it is running. */
export function toggleShowcase(s: CortexServices, leaf: Leaf, shell: Shell): void {
  if (showcaseRunning(shell)) {
    stopShowcase(shell);
    return;
  }
  if (startShowcase(s, leaf, shell)) return;
  // Started from the command palette, its own dialog may still be on its way out: one more try once it has gone.
  if (modalOpen(shell.doc)) shell.win.setTimeout(() => void (!modalOpen(shell.doc) && startShowcase(s, leaf, shell)), RETRY_AFTER_DIALOG_MS);
}

/**
 * Is this leaf the one the keyboard belongs to: on screen, not behind a dialog, and not behind another Cortex view that
 * has the focus? With the focus outside every Cortex view (the page, an editor) it is the view last focused (`focused`,
 * the renderer pool's), or any view on screen when that one is not.
 */
export function leafOwnsKeys(shell: Shell, focused: string | null = null): boolean {
  const root = shell.root;
  const doc = shell.doc;
  if (!root || !doc || !root.isConnected || root.getClientRects().length === 0) return false;
  const focus = doc.activeElement;
  if (focus?.closest?.(".modal-container")) return false;
  const other = focus?.closest?.(".cx-root");
  if (other) return other === root || root.contains(other);
  if (focused === null || focused === shell.viewId) return true;
  const theirs = shellOfView(focused)?.root;
  return !theirs || !theirs.isConnected || theirs.getClientRects().length === 0;
}

/**
 * Listen for the chord on the view's document (capture, so it sees the keys before the page, a focused field and the
 * stage; a keymap that listens on the window, as Cortex Desktop's does, sees them first, which is why the tour holds the
 * hotkeys itself while it runs). Returns the remover. `owns` lets a test stand in for the layout check.
 */
export function installShowcaseKeys(s: CortexServices, leaf: Leaf, shell: Shell, opts: { owns?: (shell: Shell) => boolean; now?: () => number; chord?: Chord } = {}): () => void {
  const doc = shell.doc;
  if (!doc) return () => undefined;
  const chord = opts.chord ?? createChord();
  const now = opts.now ?? Date.now;
  const owns = opts.owns ?? ((sh: Shell) => leafOwnsKeys(sh, s.renderers?.focused?.() ?? null));
  const onKey = (e: KeyboardEvent): void => {
    // A running tour (here or in another view) stops on any key itself; the chord starts again only from a fresh Ctrl+0.
    if (showcaseRunning(shell) || anyShowcaseRunning()) {
      chord.reset();
      return;
    }
    if (!owns(shell)) return;
    if (chord.feed(e, now()) !== "fire") return;
    e.preventDefault();
    e.stopPropagation();
    startShowcase(s, leaf, shell);
  };
  doc.addEventListener("keydown", onKey, true);
  return () => doc.removeEventListener("keydown", onKey, true);
}
