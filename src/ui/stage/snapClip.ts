/**
 * Snap-clip for a scrolling panel body (the Display panel): when the content is taller than the room the panel has,
 * the scroll area is cut at the bottom of the last row that fits whole, so the row above the footer is never sliced
 * in half at rest (the rows below scroll into view). `snapClipHeight` and `rowBottoms` are pure; `useSnapClip` wires
 * them to a scroll element with a ResizeObserver, so nothing runs while the panel is still (the render loop stays idle).
 */
import type { RefObject } from "preact";
import { useLayoutEffect } from "preact/hooks";

/**
 * The height to clip a scroll area to: the lowest row bottom (measured from the content's top) that, with `pad`
 * of bottom padding, still fits in `avail`. Null when everything fits (no clip) or no row ends within reach.
 */
export function snapClipHeight(bottoms: readonly number[], avail: number, pad = 0): number | null {
  let last = 0;
  let best = 0;
  for (const b of bottoms) {
    if (b > last) last = b;
    if (b + pad <= avail && b > best) best = b;
  }
  if (last + pad <= avail + 0.5) return null;
  return best > 0 ? best + pad : null;
}

interface RowLike {
  children: ArrayLike<RowLike>;
  classList: { contains(c: string): boolean };
  getBoundingClientRect(): { bottom: number; height: number };
}

/** Bottoms of the panel's rows relative to `origin` (the content's top). Wrapper blocks (Fade, Reflow) are looked through; section labels are not cut points. */
export function rowBottoms(root: RowLike, origin: number): number[] {
  const out: number[] = [];
  const walk = (el: RowLike): void => {
    for (let i = 0; i < el.children.length; i++) {
      const c = el.children[i] as RowLike;
      if (c.classList.contains("cx-fade") || c.classList.contains("cx-reflow") || c.classList.contains("cx-reflow-inner") || c.classList.contains("cx-popover-body")) walk(c);
      else if (!c.classList.contains("cx-section-label")) {
        // A section label is never a place to cut: it would strand a heading at the bottom with its rows scrolled away.
        const r = c.getBoundingClientRect();
        if (r.height > 0) out.push(r.bottom - origin);
      }
    }
  };
  walk(root);
  return out;
}

/** Keep `scroll` clipped at a row boundary inside its popover's height budget (max-height); re-measures when the content or the window changes size. */
export function useSnapClip(scroll: RefObject<HTMLElement>): void {
  useLayoutEffect(() => {
    const el = scroll.current;
    const pop = el?.closest<HTMLElement>(".cx-popover");
    if (!el || !pop) return undefined;
    const win = el.ownerDocument.defaultView;
    if (!win) return undefined;
    const apply = (): void => {
      const cs = win.getComputedStyle(pop);
      const max = parseFloat(cs.maxHeight);
      el.style.maxHeight = "";
      if (!Number.isFinite(max)) return;
      const keep = el.scrollTop;
      // Room for the scroll area: the popover's height budget minus everything else in the popover (header, footer, padding).
      const border = cs.boxSizing === "border-box" ? 0 : pop.offsetHeight - pop.clientHeight;
      const avail = max + border - (pop.offsetHeight - el.offsetHeight);
      const origin = el.getBoundingClientRect().top - el.scrollTop;
      const h = snapClipHeight(rowBottoms(el as unknown as RowLike, origin), avail);
      if (h !== null) el.style.maxHeight = `${Math.floor(h)}px`;
      el.scrollTop = keep;
    };
    apply();
    let raf = 0;
    const later = (): void => {
      win.cancelAnimationFrame(raf);
      raf = win.requestAnimationFrame(apply);
    };
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(later) : null;
    const inner = el.querySelector(".cx-reflow-inner");
    if (ro && inner) ro.observe(inner);
    win.addEventListener("resize", later);
    return () => {
      win.cancelAnimationFrame(raf);
      ro?.disconnect();
      win.removeEventListener("resize", later);
      el.style.maxHeight = "";
    };
  }, [scroll]);
}
