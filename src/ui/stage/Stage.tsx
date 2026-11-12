/**
 * The stage (CORTEX-UX §3.2–3.3): the WebGL canvas and every stage overlay at its z layer — label chips (5); key
 * bar, shape bar, tool column, compass, command line, banner and chart readings (10); popovers (30); Ask console
 * (32); find results (34); tooltip (40); toasts (45); one-time hints (50). Floating overlays never move the
 * scene; when the sheet pushes, they re-anchor to the new stage edges in 300 ms. Owner: E11.
 */
import type { JSX } from "preact";
import { compassVisible, railVisible } from "../breakpoints";
import { CommandLine } from "../command/CommandLine";
import type { CortexServices, LeafServices } from "../../plugin/services";
import { domIds, indexCounts, num, useLeaf, useServices, useShell } from "../context";
import { t } from "../copy";
import { dimLabel } from "../valueLabels";
import { formatShort } from "../../shared/time";
import { isDesktopHost } from "../host";
import { firstRunCardShown } from "../loading";
import { AgentButton } from "./AgentButton";
import { Banner } from "./Banner";
import { CanvasHost } from "./CanvasHost";
import { Compass } from "./Compass";
import { DisplayPopover } from "./DisplayPopover";
import { FirstRunCard } from "./FirstRunCard";
import { Hint } from "./Hints";
import { LiveRegion, StageSummary } from "./LiveRegion";
import { ArrangingPill, StageLine } from "./LoadingLines";
import { KeyBar } from "./KeyBar";
import { KeyList } from "./KeyList";
import { KeyPopover } from "./KeyPopover";
import { StageHead } from "./StageSearch";
import { StageStatus } from "./StageStatus";
import { ShapeBar } from "./ShapeBar";
import { StageCluster } from "./StageCluster";
import { StillFrame } from "./StillFrame";
import { Toasts } from "./Toasts";
import { TitleBlock } from "./TitleBlock";
import { ThemePopover } from "./ThemePopover";
import { ToolColumn } from "./ToolColumn";

export { firstRunCardShown };

/** The stage's visually hidden summary (CORTEX-UX §8.3), kept current from the index and the colour dimension. */
export function summaryText(s: CortexServices, leaf: LeafServices): string {
  const counts = indexCounts(s);
  if (!counts) return t("app.loading");
  const c = leaf.store.slices.view.value.colour.notes;
  const dim = c.kind === "categorical" ? dimLabel(c.dim).toLowerCase() : t("app.summaryAge");
  const first = Number.isFinite(counts.firstT) ? formatShort(counts.firstT) : "–";
  return t("app.summary", { notes: num(counts.notes), dim, entries: num(counts.record), first });
}

export function Stage(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const ui = leaf.store.slices.ui.value;
  const data = s.shared.slices.data.value;
  const mini = ui.breakpoint === "Mini";
  const desktop = isDesktopHost();
  const empty = firstRunCardShown(data.phase, s.settings.value.general.firstRunDone, s.sandbox.value);
  return (
    <section class="cx-stage" id={domIds(leaf.viewId).stage} aria-roledescription="3D record">
      <CanvasHost />
      <StageSummary id={domIds(leaf.viewId).summary} text={summaryText(s, leaf)} />
      <LiveRegion message={shell.announcement.value.text} />
      <StageLine />
      <ArrangingPill />
      {ui.paused ? <StillFrame /> : null}
      {mini && shell.bridge?.inSidebar() ? (
        <button type="button" class="cx-mini-open cx-glass" data-cx-overlay="mini" onClick={() => shell.bridge?.openInMainArea()}>
          {t("app.openMain")}
        </button>
      ) : null}
      {mini || ui.immersive ? null : (
        <>
          {desktop ? <KeyList /> : <KeyBar />}
          {desktop ? <StageCluster /> : <ShapeBar />}
          {desktop ? null : <ToolColumn />}
          <AgentButton />
          {desktop ? <StageHead /> : <TitleBlock />}
          {!desktop && compassVisible(ui.breakpoint, 1000) ? <Compass /> : null}
          <Banner />
          {railVisible(ui.breakpoint, ui.immersive) ? null : <StageStatus />}
          {empty ? <FirstRunCard /> : null}
          <CommandLine />
          <Toasts />
          <Hint id="stage" />
          {ui.popover === "display" ? <DisplayPopover /> : null}
          {ui.popover === "key" ? <KeyPopover /> : null}
          {ui.popover === "themes" ? <ThemePopover /> : null}
        </>
      )}
    </section>
  );
}
