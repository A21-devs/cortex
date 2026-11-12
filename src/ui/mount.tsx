/**
 * Lazy entry of the UI (loaded by CortexView through dynamic import()). Owner: E11.
 * Restores the leaf's saved state (or seeds a new leaf from the global settings), creates the leaf's Shell, binds it
 * to the view (size → breakpoint, theme, reduced motion, the stage bus, overlay layout, the keyboard Scope) and
 * renders the app.
 */
import { effect } from "@preact/signals";
import { render } from "preact";
import type { Scope } from "obsidian";
import type { CortexServices, LeafServices } from "../plugin/services";
import { restoreLeafState } from "../state/persist";
import { App } from "./App";
import { keepArrivals } from "./arrivals";
import { bindLink } from "./header/MoreMenu";
import { classify, figureFit, SHELL, observeSize, safeFrame, sheetCover, stageBox } from "./breakpoints";
import { adoptShell, isReducedMotion, Shell, stageBus, type StageRect, type ViewBridge } from "./context";
import { t, type CopyKey } from "./copy";
import { registerKeymap } from "./keymap";
import { requestHint } from "./stage/Hints";
import { tickChecklist } from "./deviceState";
import { bindPointGestures } from "./stage/pointGestures";
import { morphAnimator } from "./stage/ShapeBar";
import { announceText } from "./stage/Tooltip";

export interface MountOptions {
  /** What CortexView lends the UI (pane menu, Open in the main area, sidebar test, title, layout save). */
  bridge?: ViewBridge | null;
  /** The view's keyboard Scope; Cortex keys register on it so they apply only while focus is inside the view. */
  scope?: Scope | null;
}

/** Overlay rectangles (stage-local px) of every element that marks itself as an overlay, except the first-run card. */
export function measureOverlays(root: Element): StageRect[] {
  const stage = root.querySelector(".cx-stage");
  if (!stage) return [];
  const base = stage.getBoundingClientRect();
  const out: StageRect[] = [];
  stage.querySelectorAll("[data-cx-overlay]").forEach((el) => {
    if (el.getAttribute("data-cx-overlay") === "first-run") return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    out.push({ x: Math.round(r.left - base.left), y: Math.round(r.top - base.top), w: Math.round(r.width), h: Math.round(r.height) });
  });
  return out;
}

/** Gap kept between a chart and a floating panel (CSS px). */
export const CHART_PANEL_GAP = 12;

/**
 * What the floating Chart card (left) and the open Display popover (right) cover of the stage, in CSS px from each edge of
 * the stage: charts are scaled and centred in what lies between them. A collapsed popover is only its header bar and
 * reserves nothing.
 */
export function measureChartCover(root: Element): { left: number; right: number } {
  const stage = root.querySelector(".cx-stage");
  if (!stage) return { left: 0, right: 0 };
  const base = stage.getBoundingClientRect();
  let left = 0, right = 0;
  const card = root.querySelector(".cx-sheet.is-card");
  if (card) {
    const r = card.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) left = Math.max(0, Math.round(r.right - base.left + CHART_PANEL_GAP));
  }
  const pop = stage.querySelector(".cx-popover.cx-display:not(.is-collapsed)");
  if (pop) {
    const r = pop.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) right = Math.max(0, Math.round(base.right - r.left + CHART_PANEL_GAP));
  }
  return { left, right };
}

/**
 * Wire one leaf's Shell to its view: breakpoint from the view's own box, Obsidian's theme and the OS reduced-motion
 * preference, the renderer's stage events into the shell feed, the stage layout (overlay rectangles and the safe
 * frame for the figure's current pose) back to the renderer, and the keymap. Returns the disposer.
 */
export function bindShell(shell: Shell, services: CortexServices, leaf: LeafServices, root: HTMLElement, scope: Scope | null = null): () => void {
  const offs: (() => void)[] = [];
  const store = leaf.store;
  const bus = stageBus(services.bus);
  const mine = <E extends { viewId?: string }>(fn: (e: E) => void) => (e: E) => {
    if (e.viewId === undefined || e.viewId === leaf.viewId) fn(e);
  };
  const feed = (patch: Partial<Shell["feed"]["value"]>) => {
    shell.feed.value = { ...shell.feed.value, ...patch };
  };
  let lastNeedleAt = Number.NEGATIVE_INFINITY;
  let loweredToast = false;
  const reduced = () => isReducedMotion(services.settings.value.appearance.motion, shell.systemReducedMotion.value);

  // Held arrivals: what is in the record when it loads (or the sample record) is the baseline, never an arrival.
  offs.push(keepArrivals(services, store));

  // More › Link views: linked leaves follow each other's scope, period and tokens.
  offs.push(bindLink(services, leaf));

  // Size → breakpoint (the view's own box, never the window).
  offs.push(
    observeSize(root, (width, height) => {
      shell.size.value = { width, height };
      const bp = classify(width, height);
      if (store.get("ui").breakpoint !== bp) store.update("ui", { breakpoint: bp });
    }),
  );

  // The setting "Chart panel as a floating card" rides on the sheet state, so the layout helpers (stageBox, App) read one place.
  offs.push(
    effect(() => {
      const on = services.settings.value.appearance.chartCard === true;
      const sheet = store.slices.ui.value.sheet;
      if ((sheet.float === true) !== on) store.update("ui", { sheet: { ...sheet, float: on } });
    }),
  );

  // Theme and OS preference of the window the view lives in (pop-out aware).
  const win = shell.win as Window & typeof globalThis;
  const body = shell.doc?.body;
  if (body) {
    const sync = () => {
      shell.obsidianDark.value = body.classList.contains("theme-dark");
    };
    sync();
    const MO = (win as { MutationObserver?: typeof MutationObserver }).MutationObserver;
    if (MO) {
      const mo = new MO(sync);
      mo.observe(body, { attributes: true, attributeFilter: ["class"] });
      offs.push(() => mo.disconnect());
    }
  }
  if (typeof win.matchMedia === "function") {
    const mq = win.matchMedia("(prefers-reduced-motion: reduce)");
    shell.systemReducedMotion.value = mq.matches;
    const on = (e: MediaQueryListEvent) => {
      shell.systemReducedMotion.value = e.matches;
    };
    mq.addEventListener?.("change", on);
    offs.push(() => mq.removeEventListener?.("change", on));
  }

  // Renderer → shell.
  offs.push(
    bus.on("stage:territories", mine((e) => feed({ territories: e.territories }))),
    bus.on(
      "stage:camera",
      mine((e) => {
        // The compass needle follows the spin at most 15 times a second, and not at all under reduced motion.
        if (reduced()) return;
        const now = shell.now();
        const cur = shell.feed.value.needleDeg;
        if (cur !== null && (now - lastNeedleAt < 1000 / SHELL.timing.compassHz || Math.abs(cur - e.needleDeg) <= 0.25)) return;
        lastNeedleAt = now;
        feed({ needleDeg: e.needleDeg });
      }),
    ),
    bus.on("stage:arrangement", mine((e) => feed({ sparse: e.sparse, flatChart: e.flat }))),
    bus.on(
      "stage:status",
      mine((e) => {
        const before = shell.feed.value.governor;
        feed({ status: e.status, governor: e.governor ?? 0 });
        // The frame-rate governor stepped detail down: one toast per view session (CORTEX-UX §8.4).
        if ((e.governor ?? 0) > 0 && before === 0 && !loweredToast) {
          loweredToast = true;
          shell.toast({ kind: "info", text: t("toasts.lowerDetail"), sticky: false });
        }
      }),
    ),
    // Tab on the stage stepped to a traced point: the live region says what it is (CORTEX-UX §8.3).
    bus.on(
      "stage:announce",
      mine((e) => {
        const meta = services.index.meta(e.ordinal);
        if (meta) shell.announce(announceText(meta));
      }),
    ),
    bindPointGestures(services, leaf, root),
    bus.on(
      "toast",
      mine((e) => {
        let text: string;
        try {
          text = t(e.copyKey as CopyKey, e.values);
        } catch {
          return;
        }
        shell.toast({ kind: e.kind, text, sticky: e.kind === "error" });
      }),
    ),
  );

  // Shell → renderer: the stage box, the overlay rectangles and the figure's safe frame (pose-aware).
  let lastLayout = "";
  let frame = 0;
  const raf = (cb: () => void): number => (typeof win.requestAnimationFrame === "function" ? win.requestAnimationFrame(cb) : (setTimeout(cb, 16) as unknown as number));
  const caf = (h: number): void => (typeof win.cancelAnimationFrame === "function" ? win.cancelAnimationFrame(h) : clearTimeout(h));
  const emitLayout = () => {
    frame = 0;
    const size = shell.size.value;
    if (size.width === 0 || size.height === 0) return;
    const ui = store.get("ui");
    const box = stageBox(size, ui);
    // The expanded legend grid takes the foot of the stage: the canvas host shrinks by its height, so the figure is framed in what is left.
    if (root.querySelector(".cx-stage.has-legend-grid")) {
      const hostH = (root.querySelector(".cx-canvas-host") as HTMLElement | null)?.clientHeight ?? 0;
      if (hostH > 0 && hostH < box.height) box.height = hostH;
    }
    const overlays = ui.immersive || ui.breakpoint === "Mini" ? [] : measureOverlays(root);
    shell.overlayRects = overlays;
    const safe = safeFrame(box.width, box.height, store.get("view").pose, ui.breakpoint);
    // A pushing sheet already took its room out of box.width (the stage is a flex sibling of the sheet, the canvas fills it), so
    // nothing of the canvas lies under it: reporting it again as an inset fitted every chart and the figure into a canvas
    // narrower than the stage and left them off centre. Only a floating sheet covers the canvas, and that is the inset.
    const chartCover = ui.immersive || ui.breakpoint === "Mini" ? { left: 0, right: 0 } : measureChartCover(root);
    const ev = { viewId: leaf.viewId, width: box.width, height: box.height, insetRight: sheetCover(size, ui), overlays, safe, fit: figureFit(ui.breakpoint), chartCover };
    const key = JSON.stringify(ev);
    if (key === lastLayout) return;
    lastLayout = key;
    bus.emit("stage:layout", ev);
  };
  const schedule = () => {
    if (!frame) frame = raf(emitLayout);
  };
  offs.push(
    effect(() => {
      // Read everything the layout depends on, then measure after the next render.
      void store.slices.ui.value;
      void store.slices.view.value.pose;
      void shell.size.value;
      void shell.toasts.value;
      schedule();
    }),
  );
  const MO = (win as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  if (MO) {
    const mo = new MO(schedule);
    mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "data-cx-overlay"] });
    offs.push(() => mo.disconnect());
  }
  offs.push(() => {
    if (frame) caf(frame);
  });

  // One-time hints and the self-ticking checklist (CORTEX-UX §5.2, §5.28): each surface's hint shows once per device.
  if (typeof root.addEventListener === "function") {
    let stripTimer: ReturnType<typeof setTimeout> | undefined;
    const under = (e: Event, sel: string): HTMLElement | null => ((e.target as Element | null)?.closest?.(sel) as HTMLElement | null) ?? null;
    const onOver = (e: Event) => {
      const strip = under(e, ".cx-strip");
      if (strip && !stripTimer) stripTimer = setTimeout(() => requestHint(services, shell, "strip", strip, "above"), SHELL.timing.hintShowMs);
      if (!strip && stripTimer) {
        clearTimeout(stripTimer);
        stripTimer = undefined;
      }
      const stage = under(e, ".cx-canvas-host");
      if (stage && services.settings.value.general.firstRunDone && services.shared.slices.data.value.phase !== "empty") requestHint(services, shell, "stage", { x: (e as PointerEvent).clientX - root.getBoundingClientRect().left, y: (e as PointerEvent).clientY - root.getBoundingClientRect().top }, "below");
    };
    const onFocus = (e: Event) => {
      const cmd = under(e, ".cx-command");
      if (cmd && (e.target as Element).matches?.("input, textarea, [contenteditable='true']")) requestHint(services, shell, "command", cmd, "above");
    };
    root.addEventListener("pointerover", onOver);
    root.addEventListener("focusin", onFocus);
    offs.push(() => {
      root.removeEventListener("pointerover", onOver);
      root.removeEventListener("focusin", onFocus);
      if (stripTimer) clearTimeout(stripTimer);
    });
  }
  let lastThread = store.get("ui").command.threadId;
  let lastTop = "";
  offs.push(
    effect(() => {
      const ui = store.slices.ui.value;
      const top = ui.sheet.open ? ui.sheet.stack[ui.sheet.index] : undefined;
      const topKey = top ? `${top.kind}:${top.route}` : "";
      if (topKey !== lastTop) {
        lastTop = topKey;
        if (top?.kind === "reader" && top.route === "conversation") {
          const header = root.querySelector?.<HTMLElement>(".cx-sheet-header");
          if (header) requestHint(services, shell, "conversation", header, "left");
        }
      }
      if (ui.command.threadId !== lastThread) {
        if (ui.command.threadId !== null) services.device.update((d) => tickChecklist(d, "ask-question"));
        lastThread = ui.command.threadId;
      }
    }),
  );

  // Keyboard: view-scoped, never Obsidian's global hotkeys.
  if (scope) offs.push(registerKeymap(scope, { services, leaf, shell }, morphAnimator(store, shell, reduced)));

  return () => {
    for (const off of offs.splice(0).reverse()) {
      try {
        off();
      } catch {
        // A listener that is already gone with its window is not an error.
      }
    }
  };
}

export function mountCortex(root: HTMLElement, services: CortexServices, leaf: LeafServices, savedState: unknown = null, opts: MountOptions = {}): () => void {
  if (savedState !== null) restoreLeafState(leaf.store, savedState, services.settings.value);
  const shell = new Shell(leaf.viewId);
  shell.root = root;
  shell.bridge = opts.bridge ?? null;
  adoptShell(leaf, shell);
  const unbind = bindShell(shell, services, leaf, root, opts.scope ?? null);
  render(<App services={services} leaf={leaf} shell={shell} />, root);
  return () => {
    unbind();
    render(null, root);
    shell.dispose();
  };
}
