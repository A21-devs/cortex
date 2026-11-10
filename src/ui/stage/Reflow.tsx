/**
 * Panel reflow (VIEW-39): a container that animates its height (160 ms, measured with a ResizeObserver) when rows
 * mount or unmount inside it, and a `Fade` that eases a conditional row in and out (opacity, blur 2 px to 0,
 * 120 ms) before it unmounts. Both are instant under reduced motion; nothing runs while the panel is still, so the
 * render loop stays idle. Used by the Display popover. Owner: E11.
 */
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

export const REFLOW_HEIGHT_MS = 160;
export const REFLOW_FADE_MS = 120;

/** Wraps the panel body: its own height follows the content's, eased. */
export function Reflow(p: { children: ComponentChildren; reduced: boolean; class?: string }): JSX.Element {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i || typeof ResizeObserver !== "function") return undefined;
    const apply = () => {
      o.style.height = `${i.offsetHeight}px`;
    };
    // The first measure is instant (no growth animation on open); later ones ease.
    o.style.transition = "none";
    apply();
    const first = requestAnimationFrame(() => {
      o.style.transition = "";
    });
    const ro = new ResizeObserver(apply);
    ro.observe(i);
    return () => {
      cancelAnimationFrame(first);
      ro.disconnect();
    };
  }, []);
  return (
    <div ref={outer} class={`cx-reflow${p.reduced ? " is-instant" : ""}${p.class ? ` ${p.class}` : ""}`} style={{ "--cx-reflow-ms": `${REFLOW_HEIGHT_MS}ms` }}>
      <div ref={inner} class="cx-reflow-inner">
        {p.children}
      </div>
    </div>
  );
}

/** What a Fade renders: "in" while shown, "out" while it leaves (not under reduced motion), null once gone. */
export function fadePhase(show: boolean, wasShown: boolean, reduced: boolean): "in" | "out" | null {
  if (show) return "in";
  return wasShown && !reduced ? "out" : null;
}

/** A conditional row: eases in on mount, eases out before it unmounts (at once under reduced motion). */
export function Fade(p: { show: boolean; reduced: boolean; children: ComponentChildren }): JSX.Element | null {
  const [, force] = useState(0);
  const was = useRef(p.show);
  if (p.show) was.current = true;
  useEffect(() => {
    if (p.show || !was.current) return undefined;
    if (p.reduced) {
      was.current = false;
      return undefined;
    }
    const id = setTimeout(() => {
      was.current = false;
      force((n) => n + 1);
    }, REFLOW_FADE_MS);
    return () => clearTimeout(id);
  }, [p.show, p.reduced]);
  const phase = fadePhase(p.show, was.current, p.reduced);
  if (phase === null) return null;
  return (
    <div class={`cx-fade is-${phase}`} aria-hidden={phase === "out" ? "true" : undefined}>
      {p.children}
    </div>
  );
}
