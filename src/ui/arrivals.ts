/**
 * Held arrivals, the leaf side (CORTEX-UX §6.7, F59). Owner: PHASE.
 *
 * A leaf shows the record as it was when it loaded: `ui.revealedCount` is the number of ordinals shown, and
 * ordinals past it are "held" (the "‹n› new" pill, the toast, Show them). Whenever a whole index is loaded
 * (first load, rebuild, entering or leaving the sample record) the baseline moves to its count, so what is
 * already in the record, and everything in the sample record, is never an arrival. Only items appended after
 * that (index:delta) are held, unless Settings › Sources › "Refresh automatically" is on, which reveals them as
 * they arrive.
 */
import type { CortexServices } from "../plugin/services";
import { revealArrivals } from "../state/actions";
import type { CortexStore } from "../state/store";

/**
 * Your own entry is never an "arrival" (CORTEX-UX §5.24): once the index has it, the leaf reveals up to its ordinal,
 * so the new point is born at the spine's tip while anything held from Claude Code stays held. Waits for the
 * index:delta that carries the entry (up to `timeoutMs`). Returns a canceller.
 */
export function revealOwnEntry(services: Pick<CortexServices, "bus" | "index">, store: CortexStore, entryId: string, timeoutMs = 60_000): () => void {
  const tryReveal = (): boolean => {
    const o = services.index.ordinalOf(entryId);
    if (o < 0) return false;
    const shown = store.get("ui").revealedCount;
    if (shown > 0 && o + 1 > shown) revealArrivals(store, o + 1);
    return true;
  };
  if (tryReveal()) return () => undefined;
  let stop: () => void = () => undefined;
  const timer = setTimeout(() => stop(), timeoutMs);
  const off = services.bus.on("index:delta", () => {
    if (tryReveal()) stop();
  });
  stop = () => {
    clearTimeout(timer);
    off();
  };
  return stop;
}

export function keepArrivals(services: Pick<CortexServices, "bus" | "shared" | "settings">, store: CortexStore): () => void {
  const available = (): number => services.shared.get("data").available;
  const rebase = (count: number): void => {
    if (store.get("ui").revealedCount !== count) revealArrivals(store, count);
  };
  // An index that is already showing when the leaf mounts is the baseline.
  if (services.shared.get("data").phase === "ready") rebase(available());
  const stopLoaded = services.bus.on("index:loaded", (e) => rebase(e.count));
  const stopDelta = services.bus.on("index:delta", () => {
    if (services.settings.value.sources.autoRefresh) rebase(available());
  });
  return () => {
    stopLoaded();
    stopDelta();
  };
}
