/**
 * Loading surfaces on the stage and under the header (CORTEX-UX §8.4). Owner: GAPS-UI. The model is ui/loading.ts.
 *  - ProgressLine: the 2 px accent line under the header (a determinate bar, or a sweeping one with no figure yet).
 *  - StageLine: "Reading your record… 34%" at the stage's top centre over a thin fill bar (the same progress value as
 *    the header line); the first-run line and the no-WebGL line stay at the stage's lower centre.
 *  - ArrangingPill: the small glass pill "Arranging…" at the stage's top centre while the worker lays points out.
 *  - LoadingChip: the header chip "Checking for changes…" / "Indexing ‹k› of ‹n›".
 */
import type { JSX } from "preact";
import { useServices, useShell } from "../context";
import { t } from "../copy";
import { firstRunCardShown, loadingModel, type LoadingModel } from "../loading";

/** The loading model for the current state (one reader for all four surfaces). */
export function useLoading(): LoadingModel {
  const s = useServices();
  const shell = useShell();
  const data = s.shared.slices.data.value;
  return loadingModel({
    data,
    jobs: s.shared.slices.activity.value.jobs,
    firstRunCard: firstRunCardShown(data.phase, s.settings.value.general.firstRunDone, s.sandbox.value),
    stageStatus: shell.feed.value.status,
  });
}

export function ProgressLine(): JSX.Element | null {
  const m = useLoading();
  if (m.progress === null) return null;
  const pct = Math.round(m.progress * 100);
  return (
    <div class={`cx-progress-line${m.progress <= 0 ? " is-sweep" : ""}`} role="progressbar" aria-label={m.chip ?? t("app.reading")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div class="cx-progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function StageLine(): JSX.Element | null {
  const m = useLoading();
  if (!m.stageLine) return null;
  if (m.stageReading) {
    const known = m.progress !== null;
    const pct = Math.round((m.progress ?? 0) * 100);
    return (
      <div class={`cx-stage-load${known ? "" : " is-sweep"}`} role="progressbar" aria-label={t("app.reading")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? pct : undefined} data-cx-overlay="loading">
        <p class="cx-stage-load-text">{m.stageLine}</p>
        <div class="cx-stage-load-bar" aria-hidden="true">
          <div class="cx-stage-load-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }
  return (
    <p class="cx-stage-line" role="status">
      {m.stageLine}
    </p>
  );
}

export function ArrangingPill(): JSX.Element | null {
  const m = useLoading();
  if (!m.arranging) return null;
  return (
    <div class="cx-arranging cx-glass" role="status" data-cx-overlay="arranging">
      <span class="cx-spinner" aria-hidden="true" />
      <span>{t("app.arranging")}</span>
    </div>
  );
}

export function LoadingChip(p: { iconOnly?: boolean }): JSX.Element | null {
  const m = useLoading();
  if (!m.chip) return null;
  return (
    <span class={`cx-loading-chip${p.iconOnly ? " is-icon" : ""}`} role="status" title={m.chip}>
      <span class="cx-spinner" aria-hidden="true" />
      {p.iconOnly ? null : <span>{m.chip}</span>}
    </span>
  );
}
