/**
 * Time (CORTEX-UX §5.19; ORIG-02): the record on its own time scale; set the period. Owner: E12 (page), E9
 * (statistics: worker stats "spine", "rhythm", "voices", "data").
 * Header "Time" with the Hide No area switch, tabs Charts · Spine · Data (Charts is the default and holds the monthly
 * sections of WhenSections). Spine: Save image…, the RhythmGrid (7 × 24) then the SpineFigure (360 × ~260) on the cord's own τ,
 * one brush shared with the strip, a key of kind glyphs, and the period's longest conversations as Read rows
 * ("Show all in Read"). "Hide No area". role="img" summary + Show as table. Data view: TimeData. Empty: "Nothing
 * dated in this period. Widen the period on the strip, or choose All time."
 */
import type { JSX } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import { featureOn } from "../../shared/features";
import type { StatsResult } from "../../shared/protocol/worker";
import { addToken, openTab, setPeriod } from "../../state/actions";
import { visibilityParams } from "../../state/selectors";
import { openBesideId } from "../breakpoints";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import { Button } from "../primitives/buttons";
import { Toggle } from "../primitives/controls";
import { KindGlyph, SplitBar } from "../reader/marks";
import { openReader, useIndex } from "../reader/readerKit";
import { fmtPercent } from "../valueLabels";
import { PeriodBar } from "./PeriodBar";
import { ChangeSlot, Load, PageFrame, PageTabs, setPageParams, statsKey, useChange, useFmt, useLoad } from "./PageFrame";
import { RhythmGrid } from "./RhythmGrid";
import { figureToPng, SpineFigure, type SpineStats } from "./SpineFigure";
import { TimeData } from "./TimeData";
import { WhenSections } from "./WhenSections";

/** Trend of your share of the words over the period: compare the first and last thirds (±3 points = steady). */
export function shareTrend(shares: readonly number[]): "rising" | "falling" | "steady" {
  if (shares.length < 3) return "steady";
  const third = Math.max(1, Math.floor(shares.length / 3));
  const avg = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const delta = avg(shares.slice(-third)) - avg(shares.slice(0, third));
  return delta > 0.03 ? "rising" : delta < -0.03 ? "falling" : "steady";
}

type VoicesStats = Extract<StatsResult, { kind: "voices" }>;
type RhythmStats = Extract<StatsResult, { kind: "rhythm" }>;

interface FigureData {
  spine: SpineStats;
  rhythm: RhythmStats;
  voices: VoicesStats;
}

const trendText = (x: "rising" | "falling" | "steady") => (x === "rising" ? t("time.rising") : x === "falling" ? t("time.falling") : t("time.steady"));

export type TimeTab = "charts" | "figure" | "data";

/** The page's tab from its param: the monthly charts open by default; "figure" is the Spine tab. */
export function timeTab(param: string | undefined): TimeTab {
  return param === "data" ? "data" : param === "figure" || param === "spine" ? "figure" : "charts";
}

export function Time(p: { params: Readonly<Record<string, string>> }): JSX.Element {
  const leaf = useLeaf();
  const s = useServices();
  const change = useChange();
  const tab = timeTab(p.params.tab);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // One switch for the header: both the charts and the spine leave out the entries with no area.
  const [hideNoArea, setHideNoArea] = useState(false);

  const saveImage = async () => {
    const svg = svgRef.current;
    const png = svg ? await figureToPng(svg) : null;
    if (!png) return change.post(t("errors.action"));
    const where = await s.save({ suggestedName: "cortex-spine.png", mime: "image/png", data: png });
    if (where) change.post(t("notices.savedTo", { path: where }));
  };

  return (
    <PageFrame
      subtitle={t(tab === "charts" ? "time.subtitleCharts" : "time.subtitle")}
      tabs={
        <PageTabs
          label={t("pages.time")}
          value={tab}
          options={[
            { value: "charts", label: t("time.charts") },
            { value: "figure", label: t("time.figure") },
            ...(featureOn("dataView") ? [{ value: "data" as const, label: t("time.data") }] : []),
          ]}
          onChange={(v) => setPageParams(leaf.store, { tab: v === "charts" ? null : v })}
        />
      }
      actions={
        tab === "data" ? null : (
          <>
            <Toggle label={t("time.hideNoArea")} checked={hideNoArea} onChange={setHideNoArea} inline />
            {tab === "figure" ? (
              <Button icon="saveImage" onClick={() => void saveImage()}>
                {t("time.saveImage")}
              </Button>
            ) : null}
          </>
        )
      }
    >
      {tab === "data" ? <TimeData params={p.params} /> : tab === "figure" ? <Figure svgRef={svgRef} hideNoArea={hideNoArea} /> : (
        <>
          <PeriodBar params={p.params} />
          <WhenSections hideUnsorted={hideNoArea} embedded />
        </>
      )}
      <ChangeSlot state={change} />
    </PageFrame>
  );
}

function Figure(p: { svgRef: { current: SVGSVGElement | null }; hideNoArea: boolean }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const fmt = useFmt();
  const index = useIndex(s);
  const ui = leaf.store.slices.ui.value;
  const view = leaf.store.slices.view.value;
  const vis = visibilityParams(ui, view);
  const hideNoArea = p.hideNoArea;
  const [asTable, setAsTable] = useState(false);

  const data = useLoad<FigureData>(
    async (signal) => {
      const call = <K extends "spine" | "rhythm" | "voices">(kind: K) => s.worker.call(statsKey(leaf.viewId, kind), "stats", { kind, visibility: vis }, { signal });
      const [spine, rhythm, voices] = await Promise.all([call("spine"), call("rhythm"), call("voices")]);
      if (spine.kind !== "spine" || rhythm.kind !== "rhythm" || voices.kind !== "voices") throw new Error("unexpected stats result");
      return { spine, rhythm, voices };
    },
    [JSON.stringify(vis), index],
  );

  const startOf = (conv: number): number => {
    try {
      return index && conv < index.convs.size ? index.convs.get(conv).startedAt : Number.NaN;
    } catch {
      return Number.NaN;
    }
  };

  return (
    <Load value={data} failed={t("errors.time")} rows={6}>
      {(d) => {
        const inPeriod = d.spine.fronds.filter((f) => !ui.period || (startOf(f.conv) >= ui.period[0] && startOf(f.conv) <= ui.period[1]));
        if (d.spine.fronds.length === 0) return <p class="cx-note">{t("time.empty")}</p>;
        const shares = d.voices.months.map((m) => (m.you + m.assistant > 0 ? m.you / (m.you + m.assistant) : 0));
        const trend = d.voices.trend ?? shareTrend(shares);
        const pct = Math.round(d.voices.youShare * 100);
        const summary = t("time.summary", { p: pct, trend: trendText(trend), n: inPeriod.length.toLocaleString("en-GB") });
        return (
          <div class="cx-time-figure">
            <RhythmGrid
              counts={d.rhythm.cells}
              weekStart={fmt.weekStart}
              onCell={(weekday, hour, label) => {
                addToken(leaf.store, { id: `rhythm:wd:${weekday}`, kind: "group", dim: "weekday", value: weekday, label: label.split(" ")[0] ?? label });
                addToken(leaf.store, { id: `rhythm:h:${hour}`, kind: "group", dim: "hour", value: hour, label: `${hour}:00` });
              }}
            />
            <SpineFigure
              data={d.spine}
              startOf={startOf}
              slots={safeSlots(s)}
              period={ui.period}
              hideNoArea={hideNoArea}
              onBrush={(period) => setPeriod(leaf.store, period)}
              summary={summary}
              svgRef={p.svgRef}
            />
            <p class="cx-time-voices cx-mono">{t("time.voices", { p: pct, trend: trendText(trend) })}</p>
            <div class="cx-time-key" aria-label={t("time.key")}>
              {(["decision", "question", "plan", "abandoned"] as const).map((k) => (
                <span class="cx-time-key-item">
                  <KindGlyph kind={k} />
                </span>
              ))}
              <button type="button" class="cx-text-button" onClick={() => setAsTable(!asTable)}>
                {t("time.showTable")}
              </button>
            </div>
            {asTable ? (
              <table class="cx-table" aria-label={t("time.showTable")}>
                <thead>
                  <tr>
                    <th scope="col">{t("time.month")}</th>
                    <th scope="col">{t("reader.you")}</th>
                    <th scope="col">{t("time.assistant")}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.voices.months.map((m) => (
                    <tr>
                      <th scope="row">{m.month}</th>
                      <td class="cx-mono">{m.you.toLocaleString("en-GB")}</td>
                      <td class="cx-mono">{m.assistant.toLocaleString("en-GB")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <Longest fronds={inPeriod} />
          </div>
        );
      }}
    </Load>
  );
}

function safeSlots(s: ReturnType<typeof useServices>): Readonly<Record<string, number>> | undefined {
  try {
    return s.colours.current()["space"];
  } catch {
    return undefined;
  }
}

/** The period's longest conversations as Read-style rows. */
function Longest(p: { fronds: SpineStats["fronds"] }): JSX.Element | null {
  const s = useServices();
  const leaf = useLeaf();
  const index = useIndex(s);
  const fmt = useFmt();
  // With the reader in the column beside this page, its conversation is the row marked here.
  const besideId = openBesideId(leaf.store.slices.ui.value);
  const top = useMemo(() => [...p.fronds].sort((a, b) => b.messages - a.messages).slice(0, 5), [p.fronds]);
  if (!index || top.length === 0) return null;
  return (
    <section class="cx-time-longest" aria-label={t("time.longest")}>
      <div class="cx-section-label">
        <span>{t("time.longest")}</span>
        <button type="button" class="cx-text-button" onClick={() => openTab(leaf.store, "read")}>
          {t("time.showAllRead")}
        </button>
      </div>
      {top.map((f) => {
        const row = index.convs.get(f.conv);
        const share = f.you + f.assistant > 0 ? f.you / (f.you + f.assistant) : 0;
        return (
          <button type="button" class={`cx-read-row${row.id === besideId ? " is-on" : ""}`} aria-current={row.id === besideId ? "true" : undefined} onClick={() => openReader(leaf, "conversation", row.id, -1, true)}>
            <SplitBar share={share} />
            <span class="cx-read-main">
              <span class="cx-read-line">
                <span class="cx-read-title">{row.title || t("read.untitled")}</span>
                <span class="cx-read-when cx-mono">{fmt.rel(row.startedAt)}</span>
              </span>
              <span class="cx-snippet">
                {t("read.messages", { n: f.messages.toLocaleString("en-GB") })} · {fmtPercent(share)}
              </span>
            </span>
          </button>
        );
      })}
    </section>
  );
}
