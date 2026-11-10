/**
 * The walkthrough (SPEC F47): seven short steps that point at the figure, brain versus spine, the legend, the time
 * strip, the nav, Ask / Your AI and Add sources. Pure model: the step list, how a step finds the element it points
 * at, where the card sits next to it, and when the tour is offered on its own. Offered once after the first run
 * (per device), and any time from More and the Guide page; skippable, never blocks the figure.
 */
import type { CopyKey } from "../copy";

export type TourStepId = "figure" | "spine" | "legend" | "time" | "nav" | "ask" | "add";

export interface TourStep {
  id: TourStepId;
  title: CopyKey;
  body: CopyKey;
  /** CSS selectors for the element pointed at, tried in order; the first one on screen wins. None = the card is centred. */
  targets: readonly string[];
}

export const WALK_STEPS: readonly TourStep[] = [
  { id: "figure", title: "tour.figureTitle", body: "tour.figureBody", targets: [".cx-canvas-host"] },
  { id: "spine", title: "tour.spineTitle", body: "tour.spineBody", targets: [] },
  { id: "legend", title: "tour.legendTitle", body: "tour.legendBody", targets: [".cx-keybar"] },
  { id: "time", title: "tour.timeTitle", body: "tour.timeBody", targets: [".cx-strip"] },
  { id: "nav", title: "tour.navTitle", body: "tour.navBody", targets: [".cx-rail", ".cx-page-picker"] },
  { id: "ask", title: "tour.askTitle", body: "tour.askBody", targets: [".cx-command"] },
  { id: "add", title: "tour.addTitle", body: "tour.addBody", targets: ['.cx-nav [data-nav="add"]', ".cx-add-sources"] },
];

/** Steps for this build: the Ask step goes when Ask has not shipped. */
export function tourSteps(opts: { ask: boolean }): TourStep[] {
  return WALK_STEPS.filter((s) => s.id !== "ask" || opts.ask);
}

/** Next step index after `i` in `dir`, or null when stepping past either end (the tour is finished). */
export function stepTour(i: number, dir: 1 | -1, total: number): number | null {
  const n = i + dir;
  return n < 0 || n >= total ? null : n;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const CARD = { w: 300, h: 168, gap: 12, margin: 12 } as const;

/**
 * Where the card goes, in view-local px: beside the pointed-at box (below, else above, else to its right or left
 * where there is room), clamped inside the view; centred when there is no target or the target fills the view.
 */
export function cardPlacement(target: Box | null, view: { width: number; height: number }, card: { w: number; h: number } = CARD): { left: number; top: number } {
  const clampX = (x: number): number => Math.max(CARD.margin, Math.min(view.width - card.w - CARD.margin, x));
  const clampY = (y: number): number => Math.max(CARD.margin, Math.min(view.height - card.h - CARD.margin, y));
  const centred = { left: clampX((view.width - card.w) / 2), top: clampY((view.height - card.h) / 2) };
  if (!target || (target.width >= view.width * 0.9 && target.height >= view.height * 0.6)) return centred;
  const cx = target.left + target.width / 2 - card.w / 2;
  const below = target.top + target.height + CARD.gap;
  if (below + card.h + CARD.margin <= view.height) return { left: clampX(cx), top: below };
  const above = target.top - CARD.gap - card.h;
  if (above >= CARD.margin) return { left: clampX(cx), top: above };
  const cy = target.top + target.height / 2 - card.h / 2;
  const right = target.left + target.width + CARD.gap;
  if (right + card.w + CARD.margin <= view.width) return { left: right, top: clampY(cy) };
  const left = target.left - CARD.gap - card.w;
  if (left >= CARD.margin) return { left, top: clampY(cy) };
  return centred;
}

/** What decides whether the tour is offered on its own. */
export interface OfferInputs {
  firstRunDone: boolean;
  /** The demo brain is showing (started from the first-run card): the tour is offered there too, before setup. */
  sandbox?: boolean;
  /** Something is on the figure (the real record or the sample). */
  hasFigure: boolean;
  tourSeen: boolean;
  /** A tour is already running. */
  running: boolean;
}

/** Offered once, after the first run or when the demo brain is up, once there is something to point at; never while a tour is running. */
export function tourOffered(i: OfferInputs): boolean {
  return (i.firstRunDone || i.sandbox === true) && i.hasFigure && !i.tourSeen && !i.running;
}
