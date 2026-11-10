/**
 * Strip dock (Cortex Desktop): the time strip folded into a small histogram box at the stage's bottom right. Resting
 * on it or focusing it expands it to the full strip (period picker, handles, axis, undated pill) over the stage's
 * bottom edge; clicking it, or starting a drag inside it, keeps it open until a click lands elsewhere. Owner: shell track.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../copy";
import { TimeStrip } from "./TimeStrip";

export function StripDock(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [hot, setHot] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hot || pinned;
  useEffect(() => {
    if (!pinned) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    const doc = el.ownerDocument;
    const onDown = (e: Event) => {
      const target = e.target as Node | null;
      if (target && !el.contains(target)) setPinned(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinned(false);
    };
    doc.addEventListener("pointerdown", onDown, true);
    doc.addEventListener("keydown", onKey, true);
    return () => {
      doc.removeEventListener("pointerdown", onDown, true);
      doc.removeEventListener("keydown", onKey, true);
    };
  }, [pinned]);
  return (
    <div
      ref={ref}
      class={`cx-strip-dock${open ? " is-open" : ""}`}
      data-cx-overlay="strip"
      onPointerEnter={() => setHot(true)}
      onPointerLeave={() => setHot(false)}
      onFocusIn={() => setHot(true)}
      onFocusOut={(e) => {
        if (!ref.current?.contains(e.relatedTarget as Node | null)) setHot(false);
      }}
      onPointerDown={() => open && setPinned(true)}
    >
      <TimeStrip mini={!open} />
      {open ? null : <button type="button" class="cx-strip-dock-hit" aria-label={t("strip.label")} onClick={() => setPinned(true)} />}
    </div>
  );
}
