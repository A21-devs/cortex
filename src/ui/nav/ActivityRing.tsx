/**
 * Activity ring (RAIL-34): a small ring of nine dashes at the rail's foot, turning once every 1.2 s and pulsing in
 * opacity while any background work runs (the index job, agent jobs, an import, the worker arranging the figure).
 * While it shows it reserves 30 px above the meters. With nothing running it is not drawn at all, so the render
 * loop and the compositor stay idle. Reduced motion shows it still (CSS). Owner: shell track.
 */
import type { JSX } from "preact";
import type { ActivityState, DataStatus } from "../../state/types";
import { useServices, useShell } from "../context";
import { t } from "../copy";

export interface ActivityInputs {
  data: Pick<DataStatus, "phase">;
  jobs: ActivityState["jobs"];
  importing?: ActivityState["importing"];
  stageStatus: "ok" | "context-lost" | "no-webgl" | "arranging";
}

/** True while something is working in the background (pure). */
export function activityBusy(i: ActivityInputs): boolean {
  return i.data.phase === "loading" || i.jobs.length > 0 || i.importing !== undefined || i.stageStatus === "arranging";
}

/** Dashes in the ring and the geometry that draws them (nine equal dashes round a circle of radius 10). */
export const RING_DASHES = 9;
const RING_R = 10;
const RING_LEN = 2 * Math.PI * RING_R;
export const RING_DASH = { dash: Math.round((RING_LEN / RING_DASHES) * 0.46 * 100) / 100, gap: Math.round((RING_LEN / RING_DASHES) * 0.54 * 100) / 100 } as const;

export function useActivityBusy(): boolean {
  const s = useServices();
  const shell = useShell();
  const a = s.shared.slices.activity.value;
  return activityBusy({ data: s.shared.slices.data.value, jobs: a.jobs, importing: a.importing, stageStatus: shell.feed.value.status });
}

export function ActivityRing(): JSX.Element | null {
  const busy = useActivityBusy();
  if (!busy) return null;
  return (
    <div class="cx-activity-ring" role="status" aria-label={t("rail.busy")} title={t("rail.busy")}>
      <svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" focusable="false">
        <circle cx="14" cy="14" r={RING_R} fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-dasharray={`${RING_DASH.dash} ${RING_DASH.gap}`} />
      </svg>
    </div>
  );
}
