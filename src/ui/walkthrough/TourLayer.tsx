/**
 * The walkthrough layer (SPEC F47): a ring around the element a step points at and a small card beside it with
 * Back / Next / Skip, and "Show a demo brain" on the first and last steps while the real record is showing.
 * Also the one-time offer after the first run ("Want a quick look around?"). Everything is skippable and nothing
 * blocks: the layer ignores the pointer except on its own card, the figure stays live underneath, Esc or Skip ends
 * it. The step index lives on the shell (`shell.tour`); "seen" lives with the device state. Owner: package 7.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { CortexServices } from "../../plugin/services";
import { featureOn } from "../../shared/features";
import { useLeaf, useServices, useShell, type Shell } from "../context";
import { t } from "../copy";
import { markTourSeen } from "../deviceState";
import { Button } from "../primitives/buttons";
import { cardPlacement, CARD, stepTour, tourOffered, tourSteps, type Box } from "./tourModel";

/** Start the walkthrough at its first step (More menu, Guide page, the offer). */
export function startTour(s: CortexServices, shell: Shell): void {
  s.device.update(markTourSeen);
  shell.tour.value = 0;
}

/** End the tour (Skip, Done, Esc). */
export function endTour(s: CortexServices, shell: Shell): void {
  s.device.update(markTourSeen);
  shell.tour.value = null;
}

/** The first element on screen among the selectors, or null. */
function findTarget(root: ParentNode, selectors: readonly string[]): Element | null {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el && el.getBoundingClientRect().width > 0) return el;
  }
  return null;
}

export function TourLayer(): JSX.Element | null {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const layer = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const idx = shell.tour.value;
  const ui = leaf.store.slices.ui.value;
  const data = s.shared.slices.data.value;
  const size = shell.size.value;
  const steps = tourSteps({ ask: featureOn("ask") });
  const step = idx === null ? null : steps[Math.min(idx, steps.length - 1)];

  // Find and measure what this step points at (again when the view resizes or the sheet moves the stage).
  useEffect(() => {
    if (!step || !layer.current) return setBox(null);
    const host = layer.current.parentElement;
    const el = host ? findTarget(host, step.targets) : null;
    if (!el) return setBox(null);
    const base = layer.current.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setBox({ left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height });
  }, [step?.id, size.width, size.height, ui.sheet.open, ui.breakpoint]);

  // Esc ends the tour from anywhere in the view, not only while the card has focus (the figure stays clickable).
  const running = idx !== null;
  useEffect(() => {
    const host = layer.current?.parentElement;
    if (!running || !host) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !e.defaultPrevented) endTour(s, shell);
    };
    host.addEventListener("keydown", onKey);
    return () => host.removeEventListener("keydown", onKey);
  }, [running]);

  // Move focus to the card's primary button as each step opens, so the keyboard drives the tour.
  useEffect(() => {
    if (step) next.current?.focus({ preventScroll: true });
  }, [step?.id]);

  const offered = tourOffered({
    firstRunDone: s.settings.value.general.firstRunDone,
    sandbox: s.sandbox.value,
    hasFigure: s.sandbox.value || (data.phase === "ready" && data.notes + data.record > 0),
    tourSeen: s.device.value.tourSeen,
    running: idx !== null,
  });

  if (!step || idx === null) {
    if (!offered) return null;
    return (
      <div ref={layer} class="cx-tour-layer">
        <section class="cx-tour-offer" role="note" aria-label={t("tour.label")}>
          <h3 class="cx-tour-title">{t("tour.offerTitle")}</h3>
          <p class="cx-tour-body">{t("tour.offerBody")}</p>
          <div class="cx-tour-actions">
            <Button primary onClick={() => startTour(s, shell)}>
              {t("tour.start")}
            </Button>
            <Button onClick={() => endTour(s, shell)}>{t("tour.later")}</Button>
          </div>
        </section>
      </div>
    );
  }

  const last = idx >= steps.length - 1;
  const at = cardPlacement(box, size.width > 0 ? size : { width: 900, height: 600 });
  const demo = !s.sandbox.value && featureOn("sampleRecord") && (idx === 0 || last);
  const go = (dir: 1 | -1): void => {
    const n = stepTour(idx, dir, steps.length);
    if (n === null) {
      if (dir === 1) endTour(s, shell);
      return;
    }
    shell.tour.value = n;
  };
  return (
    <div ref={layer} class="cx-tour-layer">
      {box ? <div class="cx-tour-ring" aria-hidden="true" style={{ left: `${box.left - 4}px`, top: `${box.top - 4}px`, width: `${box.width + 8}px`, height: `${box.height + 8}px` }} /> : null}
      <section
        class="cx-tour-card"
        role="dialog"
        aria-label={t("tour.label")}
        style={{ left: `${at.left}px`, top: `${at.top}px`, width: `${CARD.w}px` }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            endTour(s, shell);
          } else if (e.key === "ArrowRight") go(1);
          else if (e.key === "ArrowLeft") go(-1);
        }}
      >
        <p class="cx-tour-progress">{t("tour.progress", { n: idx + 1, total: steps.length })}</p>
        <h3 class="cx-tour-title">{t(step.title)}</h3>
        <p class="cx-tour-body">{step.id === "spine" && leaf.store.slices.view.value.spineOrder === "newest-at-brain" ? t("tour.spineBodyNewest") : t(step.body)}</p>
        {demo ? (
          <p class="cx-tour-demo">
            <span>{t("tour.demoNote")} </span>
            <button
              type="button"
              class="cx-text-button"
              onClick={() => {
                s.bus.emit("command", { viewId: leaf.viewId, id: "toggle-sample" });
                endTour(s, shell);
              }}
            >
              {t("tour.demo")}
            </button>
          </p>
        ) : null}
        <div class="cx-tour-actions">
          <button type="button" class="cx-text-button" onClick={() => endTour(s, shell)}>
            {t("tour.skip")}
          </button>
          <span class="cx-header-spacer" />
          {idx > 0 ? <Button onClick={() => go(-1)}>{t("tour.back")}</Button> : null}
          <button type="button" ref={next} class="cx-button is-primary" onClick={() => go(1)}>
            <span>{last ? t("tour.done") : t("tour.next")}</span>
          </button>
        </div>
      </section>
    </div>
  );
}
