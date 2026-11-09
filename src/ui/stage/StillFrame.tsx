/**
 * Still frame (CORTEX-UX §2.4; H6): when the renderer pool pauses this leaf (more than 3 live Cortex views), its
 * last frame shows as a still with "Paused to save graphics memory. Click to bring this view back."; clicking
 * asks the pool for a context, which pauses the least recently used live leaf instead. Owner: E11 with E10.
 */
import type { JSX } from "preact";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";

export function StillFrame(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  return (
    <button type="button" class="cx-still" onClick={() => s.renderers.request(leaf.viewId)}>
      {t("app.stillFrame")}
    </button>
  );
}
