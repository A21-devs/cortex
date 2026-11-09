/**
 * Accessibility (CORTEX-UX §8.3): the single polite aria-live region and the stage canvas's visually hidden
 * summary. Announces hover and step targets ("Decision: Lock slots while the server confirms. 3 Nov 2026.
 * Roblox."), selection, traced counts ("214 traced"), chart zone changes ("Vertical: Folder") and changes. The
 * summary is kept current: "‹n› notes in the brain coloured by area. ‹m› entries along the spine from ‹first› to
 * today. Use Tab to step through traced points." Owner: E11.
 */
import type { JSX } from "preact";

/** Collapse repeated announcements within this window (screen readers drop rapid updates anyway). */
export const ANNOUNCE_DEBOUNCE_MS = 250;

export function LiveRegion(p: { message: string }): JSX.Element {
  return (
    <div class="cx-sr-only" role="status" aria-live="polite">
      {p.message}
    </div>
  );
}

export function StageSummary(p: { id: string; text: string }): JSX.Element {
  return (
    <p id={p.id} class="cx-sr-only">
      {p.text}
    </p>
  );
}
