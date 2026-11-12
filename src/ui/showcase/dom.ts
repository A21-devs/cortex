/**
 * Showcase mode's hands on the window itself: the few things the tour does that no store action draws (the window's
 * tilt), and the few it keeps off the screen (the person's open menus, overlays, the pointer's tooltips). The tour opens
 * no page, tab, panel or menu of its own (the user's rule): it only puts away what the person had open and hides what
 * must not show, and what it hides is only hidden (an inline style that comes off again). Nothing here saves anything.
 */

/** Set while a driver dispatches its own events, so the tour's stop listeners do not mistake them for the person. */
let driving = 0;

/** True while the tour itself is dispatching an event (the runner's listeners ignore those). */
export function tourIsDriving(): boolean {
  return driving > 0;
}

function drive(fn: () => void): void {
  driving++;
  try {
    fn();
  } finally {
    driving--;
  }
}

/** The menus open in the document now (Obsidian's in its body, Cortex Desktop's in its layer); one fading out is not counted. */
export function openMenus(doc: Document | null | undefined): HTMLElement[] {
  if (!doc || typeof doc.querySelectorAll !== "function") return [];
  return Array.from(doc.querySelectorAll<HTMLElement>(".menu")).filter((m) => !m.classList?.contains("is-leaving"));
}

/**
 * Put away the menus open in the window: the person's as the tour starts (More, Tools, a picker, a point's menu: they
 * live outside the view, where nothing else could keep them off the tour, and the chord still fires with one open), and
 * again as it stops, as a backstop. Each is closed the way the person would
 * close it, with Esc, the one on top first (a submenu before its parent): that runs its own hide, which gives the
 * keyboard back and drops its listeners, so no invisible menu keeps the keys (or picks a row on Enter). A menu still there
 * afterwards (a host without that key) is taken off the page.
 */
export function closeMenus(doc: Document): void {
  if (typeof doc.querySelectorAll !== "function") return;
  const win = doc.defaultView as (Window & typeof globalThis) | null;
  const Key = win?.KeyboardEvent;
  for (const m of openMenus(doc).reverse()) {
    if (!Key || typeof m.dispatchEvent !== "function") break;
    if (m.isConnected === false) continue;
    drive(() => void m.dispatchEvent(new Key("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })));
  }
  for (const m of openMenus(doc)) m.remove();
}

/** A dialog is up in this window: one of Obsidian's modals or prompts, or Cortex Desktop's Settings window. */
export function modalOpen(doc: Document | null | undefined): boolean {
  if (!doc || typeof doc.querySelector !== "function") return false;
  return doc.querySelector(".modal-container") !== null;
}

/**
 * What the tour keeps off the stage while it runs (the user's rule: the figure and its charts, nothing else). The chrome
 * (rail, legend, title block, time strip) stays; these go:
 */
export const MUTED_OVERLAYS = [
  // The banner slot: the sample record, "no record yet" with Add sources, the first-run checklist card.
  ".cx-banner",
  // The start card ("Your record is empty", Add sources) and the checklist card in the banner slot.
  ".cx-first-run",
  // The walkthrough's offer and its step card.
  ".cx-tour-layer",
  // One-time hints.
  ".cx-hint",
  // The coverage note under a label grouping (Add sources, the sample record).
  ".cx-richness",
  // Toasts: receipts, arrivals, errors, the frame-rate governor's line.
  ".cx-toasts",
  // The point tooltip and a map's member card.
  ".cx-tooltip",
  ".cx-member-card",
  // The "Arranging…" pill a slow layout puts up.
  ".cx-arranging",
  // The Ask console and Find's results (the tour closes them; this keeps them off if something opens them meanwhile).
  ".cx-console",
  ".cx-find-results",
  // Every panel on the stage: the Display panel, the full key, the colour themes, the shape bar's at S and the time
  // strip's period form (the tour closes the ones it can reach; this keeps any other off).
  ".cx-popover",
].join(", ");

/** Kept off the screen in the sheet too: an error card. */
export const MUTED_ANYWHERE = [".cx-error-card"].join(", ");

/** Kept off the screen outside the view: Obsidian's page preview (Ctrl + hover over a note, raised as the chord was pressed). */
export const MUTED_IN_PAGE = [".hover-popover"].join(", ");

export interface MutedOverlays {
  /** Hide whatever matches now (the runner calls it on every step, a backstop for a host without MutationObserver). */
  sweep(): void;
  /** Show everything again, each element's inline style exactly as it was. */
  release(): void;
}

type NodeLike = Partial<Element> & Partial<ParentNode>;

/**
 * Hide the overlays the tour must not show, now and as they appear, until `release`. They are hidden in place
 * (visibility, so nothing the stage measures moves and the figure keeps its frame) and come back as they were. In the
 * sheet only an error card is touched (the tour keeps the sheet closed while it runs).
 * Outside the view, Obsidian's page preview goes too (it sits in the document's body, where the view's own overlays never are).
 */
export function muteOverlays(root: HTMLElement): MutedOverlays {
  const kept = new Map<HTMLElement, { value: string; priority: string }>();
  const doc = root.ownerDocument as Document | null | undefined;
  const hide = (el: HTMLElement, inSheetToo: boolean): void => {
    const st = el.style;
    if (!st || typeof st.setProperty !== "function" || (!inSheetToo && el.closest?.(".cx-sheet"))) return;
    if (!kept.has(el)) kept.set(el, { value: st.getPropertyValue("visibility"), priority: st.getPropertyPriority("visibility") });
    if (st.getPropertyValue("visibility") !== "hidden" || st.getPropertyPriority("visibility") !== "important") st.setProperty("visibility", "hidden", "important");
  };
  const matching = (node: NodeLike, selector: string, inSheetToo: boolean): void => {
    if (typeof node.matches === "function" && node.matches(selector)) hide(node as HTMLElement, inSheetToo);
    if (typeof node.querySelectorAll === "function") for (const el of Array.from(node.querySelectorAll<HTMLElement>(selector))) hide(el, inSheetToo);
  };
  const within = (node: NodeLike): void => {
    matching(node, MUTED_OVERLAYS, false);
    matching(node, MUTED_ANYWHERE, true);
  };
  const inPage = (node: NodeLike): void => {
    if (typeof node.matches === "function" && node.matches(MUTED_IN_PAGE)) hide(node as HTMLElement, true);
  };
  const sweep = (): void => {
    for (const el of [...kept.keys()]) if (el.isConnected === false) kept.delete(el);
    within(root);
    if (doc && typeof doc.querySelectorAll === "function") for (const el of Array.from(doc.querySelectorAll<HTMLElement>(MUTED_IN_PAGE))) hide(el, true);
  };
  sweep();
  const MO = (doc?.defaultView as (Window & typeof globalThis) | null | undefined)?.MutationObserver;
  const watch = (target: Node | null | undefined, opts: MutationObserverInit, each: (node: NodeLike) => void): MutationObserver | null => {
    if (!MO || !target) return null;
    const observer = new MO((records) => {
      for (const r of records) for (const n of Array.from(r.addedNodes)) if (n.nodeType === 1) each(n as Element);
    });
    observer.observe(target, opts);
    return observer;
  };
  const observers = [watch(root, { childList: true, subtree: true }, within), watch(doc?.body, { childList: true }, inPage)];
  return {
    sweep,
    release() {
      for (const o of observers) o?.disconnect();
      for (const [el, was] of kept) {
        if (was.value) el.style.setProperty("visibility", was.value, was.priority);
        else el.style.removeProperty("visibility");
      }
      kept.clear();
    },
  };
}

/**
 * Keep the person's pointer from raising anything on the stage while the tour runs: a pointer move does not stop the
 * tour, but the point tooltip, a map's member card, the key's hover previews and Ctrl + hover's note preview would
 * come up under it. Moves over the view are stopped before they reach it (the tour's own synthetic moves pass); the
 * same moves still count as the person being there. Returns the remover.
 */
export function holdPointer(doc: Document, root: HTMLElement): () => void {
  const types = ["pointermove", "pointerover", "pointerout", "pointerenter", "pointerleave", "mousemove", "mouseover", "mouseout", "mouseenter", "mouseleave"] as const;
  const stop = (e: Event): void => {
    if (tourIsDriving()) return;
    const target = e.target as Node | null;
    if (target && typeof root.contains === "function" && root.contains(target)) e.stopPropagation();
  };
  for (const t of types) doc.addEventListener(t, stop, true);
  return () => {
    for (const t of types) doc.removeEventListener(t, stop, true);
  };
}

/** A turn of the whole window in 3D: degrees about each axis and a zoom, over `ms`. */
export interface WindowTilt {
  rx: number;
  ry: number;
  scale: number;
  ms: number;
}

const PERSPECTIVE_PX = 1600;

/** What a window's inline style held before the tour touched it. */
export interface TiltMemory {
  transform: string;
  transition: string;
  willChange: string;
  transformOrigin: string;
}

export function rememberTilt(el: HTMLElement): TiltMemory {
  if (!el.style) return { transform: "", transition: "", willChange: "", transformOrigin: "" };
  return { transform: el.style.transform, transition: el.style.transition, willChange: el.style.willChange, transformOrigin: el.style.transformOrigin };
}

/** Turn the window (a CSS transform on its root); null (or no tilt) takes it back to rest over 400 ms. */
export function tiltWindow(el: HTMLElement, tilt: WindowTilt | null): void {
  if (!el.style) return;
  el.style.willChange = "transform";
  el.style.transformOrigin = "50% 50%";
  if (!tilt) {
    el.style.transition = "transform 400ms cubic-bezier(.2,.7,.2,1)";
    el.style.transform = "perspective(1600px) rotateX(0deg) rotateY(0deg) scale(1)";
    return;
  }
  el.style.transition = `transform ${Math.max(0, Math.round(tilt.ms))}ms cubic-bezier(.45,.05,.25,1)`;
  el.style.transform = `perspective(${PERSPECTIVE_PX}px) rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg) scale(${tilt.scale})`;
}

/** Take every trace of the tilt off the window: the inline style is exactly what it was. */
export function restoreTilt(el: HTMLElement, memory: TiltMemory): void {
  if (!el.style) return;
  el.style.transform = memory.transform;
  el.style.transition = memory.transition;
  el.style.willChange = memory.willChange;
  el.style.transformOrigin = memory.transformOrigin;
}
