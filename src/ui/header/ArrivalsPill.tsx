/**
 * Held arrivals (CORTEX-UX §5.1, §5.11, §6.7; H6): an accent-outlined "‹n› new" pill while new entries exist in
 * the shared index but are not yet shown in THIS leaf. Click → revealArrivals: each new point is born in its slot
 * with a birth flash; nothing else moves; other leaves are unaffected. Live arrivals ship in P1
 * (features.liveArrivals); before that, and with Settings › Sources › "Refresh automatically" on, new entries
 * are revealed as they arrive (App). Owner: E11.
 */
import type { JSX } from "preact";
import { featureOn } from "../../shared/features";
import { revealArrivals } from "../../state/actions";
import { heldArrivals } from "../../state/selectors";
import { num, useLeaf, useServices } from "../context";
import { t } from "../copy";
import { isDesktopHost } from "../host";
import { arrivalsText } from "../stage/Toasts";

export function ArrivalsPill(): JSX.Element | null {
  const s = useServices();
  const leaf = useLeaf();
  const available = s.shared.slices.data.value.available;
  const n = heldArrivals(leaf.store.slices.ui.value, available);
  if (!featureOn("liveArrivals") || n <= 0) return null;
  // Cortex Desktop: the only place new arrivals are announced is the rail's foot line, in full words, with a "Show" action.
  if (isDesktopHost()) {
    const line = arrivalsText(n, 0);
    return (
      <button type="button" class="cx-arrivals is-line" title={t("toasts.arrivalsWhy")} aria-label={`${line}. ${t("toasts.showThem")}`} onClick={() => revealArrivals(leaf.store, available)}>
        {line} <span class="cx-arrivals-show">{t("toasts.arrivalsShow")}</span>
      </button>
    );
  }
  const label = t("header.arrivals", { n: num(n) });
  return (
    <button type="button" class="cx-arrivals" title={t("toasts.arrivalsWhy")} aria-label={`${label}. ${t("toasts.showThem")}`} onClick={() => revealArrivals(leaf.store, available)}>
      {label}
    </button>
  );
}
