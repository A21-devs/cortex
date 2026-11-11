/**
 * The status stack on the stage (RAIL-47) for when the rail is hidden (narrow views): the same lines the rail shows,
 * bottom-anchored at the stage's bottom-left. It publishes its height as --cx-status-h on the stage, and the compass
 * rides above it, so a growing stack pushes the compass up instead of covering it. Owner: shell track.
 */
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { StatusLines } from "../nav/RailStatus";

export function StageStatus(): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const stage = el?.parentElement;
    if (!el || !stage) return;
    const publish = () => stage.style.setProperty("--cx-status-h", el.offsetHeight > 0 ? `${el.offsetHeight + 8}px` : "0px");
    publish();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      stage.style.removeProperty("--cx-status-h");
    };
  }, []);
  return (
    <div ref={ref} class="cx-stage-status" data-cx-overlay="status">
      <StatusLines />
    </div>
  );
}
