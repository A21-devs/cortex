/**
 * Banner slot (CORTEX-UX §5.29, §5.28, §3.2): stage-local left 16, top 92 (under the key bar, clear of the
 * standing figure's brain), glass, at most 400 px wide: icon + one sentence + up to two buttons. One banner at a
 * time, by priority: the one-time sample banner · graphics reset (Restart) · brain has notes but no record
 * (Add sources) · every group hidden (Show all) · nothing in the period (All time) · nothing in the scope (All
 * areas) · otherwise the unfinished first-run checklist card (Hide checklist). A thin grouping (the smallest group
 * under 30 entries) is drawn as hollow spheres with an n chip and the shape bar's warning dot; the words about it
 * belong to label groupings only and live in the coverage note at the stage's top middle (Hints.tsx RichnessHint).
 * role="status". Owner: E11, P16.
 */
import type { JSX } from "preact";
import { featureOn } from "../../shared/features";
import type { LegendModel } from "../../shared/protocol/worker";
import { spaceName } from "../../shared/spaces";
import { setPeriod, setScope, showAllGroups } from "../../state/actions";
import type { DataStatus, UiState } from "../../state/types";
import { indexCounts, stageBus, useLeaf, useServices, useShell, type IndexCounts, type StageFeed, type StripStats } from "../context";
import { t } from "../copy";
import { checklistComplete, type DeviceState } from "../deviceState";
import { Button, Icon } from "../primitives/buttons";
import { openAddSources } from "../header/Header";
import { runCortexCommand } from "../header/MoreMenu";
import { checklistSteps, FirstRunCard } from "./FirstRunCard";

export type BannerKind = "sample" | "driver-reset" | "index-failed" | "index-failed-none" | "no-record" | "all-hidden" | "empty-period" | "empty-scope" | "checklist";

export function bannerText(kind: Exclude<BannerKind, "checklist">, area = ""): string {
  switch (kind) {
    case "no-record":
      return t("banners.noRecord");
    case "all-hidden":
      return t("banners.allHidden");
    case "empty-period":
      return t("banners.emptyPeriod");
    case "empty-scope":
      return t("banners.emptyScope", { area });
    case "driver-reset":
      return t("banners.driverReset");
    case "index-failed":
      return t("banners.indexFailed");
    case "index-failed-none":
      return t("banners.indexFailedNone");
    case "sample":
      return t("banners.sample");
  }
}

/** Whether the strip's bins hold anything inside the period. */
export function periodHasItems(strip: StripStats | null, period: [number, number] | null): boolean | null {
  if (!period || !strip) return null;
  return strip.bins.some((b) => b.end >= period[0] && b.start <= period[1] && b.entries + b.notes > 0);
}

export interface BannerInputs {
  sandbox: boolean;
  sampleSeen: boolean;
  feed: Pick<StageFeed, "status">;
  data: Pick<DataStatus, "phase" | "notes" | "record" | "failure">;
  ui: Pick<UiState, "hiddenGroups" | "period" | "scope">;
  legend: LegendModel | null;
  strip: StripStats | null;
  counts: IndexCounts | null;
  device: DeviceState;
  firstRunDone: boolean;
}

/** The one banner to show (pure, so the priority order is testable). */
export function pickBanner(i: BannerInputs): BannerKind | null {
  if (i.sandbox && !i.sampleSeen) return "sample";
  if (i.feed.status === "context-lost") return "driver-reset";
  if (i.data.failure) return i.data.failure === "none" ? "index-failed-none" : "index-failed";
  if (i.data.phase === "ready" && i.data.notes > 0 && i.data.record === 0) return "no-record";
  if (i.ui.hiddenGroups.length > 0 && i.legend && i.legend.sections.length > 0 && i.legend.sections.every((sec) => sec.rows.length > 0 && sec.rows.every((r) => r.hidden))) return "all-hidden";
  if (periodHasItems(i.strip, i.ui.period) === false) return "empty-period";
  if (i.ui.scope !== "all" && i.counts && (i.counts.notesBySpace[i.ui.scope] ?? 0) + (i.counts.recordBySpace[i.ui.scope] ?? 0) === 0) return "empty-scope";
  const steps = checklistSteps();
  if (i.firstRunDone && i.data.phase === "ready" && i.data.notes + i.data.record > 0 && featureOn("hints") && !i.device.checklistHidden && !checklistComplete(i.device, steps)) return "checklist";
  return null;
}

export function Banner(): JSX.Element | null {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const store = leaf.store;
  const ui = store.slices.ui.value;
  const kind = pickBanner({
    sandbox: s.sandbox.value,
    sampleSeen: false,
    feed: shell.feed.value,
    data: s.shared.slices.data.value,
    ui,
    legend: store.slices.legend.value,
    strip: shell.strip.value,
    counts: indexCounts(s),
    device: s.device.value,
    firstRunDone: s.settings.value.general.firstRunDone,
  });
  if (!kind) return null;
  if (kind === "checklist") return <FirstRunCard compact />;
  const area = ui.scope === "all" ? "" : spaceName(ui.scope);
  let actions: JSX.Element | null = null;
  switch (kind) {
    case "sample":
      actions = (
        <Button onClick={() => runCortexCommand(s.app, "toggle-sample")}>{t("banners.leaveSample")}</Button>
      );
      break;
    case "driver-reset":
      actions = (
        <Button primary onClick={() => stageBus(s.bus).emit("stage:restart", { viewId: leaf.viewId })}>
          {t("banners.restart")}
        </Button>
      );
      break;
    case "index-failed":
      actions = <Button onClick={() => runCortexCommand(s.app, "rebuild-index")}>{t("banners.rebuild")}</Button>;
      break;
    case "no-record":
      actions = (
        <Button icon="addSources" onClick={() => void openAddSources(s)}>
          {t("header.addSources")}
        </Button>
      );
      break;
    case "all-hidden":
      actions = <Button onClick={() => showAllGroups(store)}>{t("banners.showAll")}</Button>;
      break;
    case "empty-period":
      actions = <Button onClick={() => setPeriod(store, null)}>{t("banners.allTime")}</Button>;
      break;
    case "empty-scope":
      actions = <Button onClick={() => setScope(store, "all")}>{t("banners.allAreas")}</Button>;
      break;
  }
  return (
    <div class={`cx-banner cx-glass is-${kind}`} role="status" data-cx-overlay="banner">
      <Icon name={kind === "driver-reset" || kind.startsWith("index-failed") ? "warning" : "info"} class="cx-banner-icon" />
      <p class="cx-banner-text">{bannerText(kind, area)}</p>
      {actions ? <div class="cx-banner-actions">{actions}</div> : null}
    </div>
  );
}
