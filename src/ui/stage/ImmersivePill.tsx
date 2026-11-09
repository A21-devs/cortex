/**
 * Immersive mode (CORTEX-UX §3.4 rule 8): header, key bar, compass, strip, command line, tools and sheet hide;
 * only the stage and this small "Leave immersive (Esc)" pill remain (stage-local right 16, top 12). Owner: E11.
 */
import type { JSX } from "preact";
import { toggleImmersive } from "../../state/actions";
import { useLeaf } from "../context";
import { t } from "../copy";

export function ImmersivePill(): JSX.Element {
  const leaf = useLeaf();
  return (
    <button type="button" class="cx-immersive-pill" onClick={() => toggleImmersive(leaf.store)}>
      {t("app.leaveImmersive")}
    </button>
  );
}
