/**
 * Chart page (CORTEX-UX §5.25, §7, P1). The chart itself is drawn by the particles on the stage; this page holds
 * its controls. Owner: E9. Order, top to bottom (the reading stays in view on a vault with many values):
 *  - Groups | Chart switch and upright limit (chart/ChartPanelHeader.tsx); for Treemap and Icicle the Folders section
 *    (Boxes | Tree, folder tree; chart/ChartFolders.tsx).
 *  - Axes: Across · Order · Bands · Order, the swap link and the dated span the charts cover (chart/ChartAxesSection.tsx).
 *  - What shows: Colour with its key, Size, Filter (a field opens a checklist of its values with counts; the ticks are
 *    the filter, the chips the summary) and "Hide items without a value" (chart/ChartWhatShows.tsx). Show or hide is a
 *    collapsed section (chart/ChartDisclosure.tsx), below the readings.
 *  - The chooser: Shape and Question grids of plain names, the chosen chart's question and one-line answer directly
 *    under them (chart/ChartChooser.tsx); then that chart's options (§7.2).
 *  - Readings (≤ 3), each with Trace; Ask about this chart (attaches the chart's state); Start from and the dimension
 *    chips (collapsed); the value list with Combine and the Largest select (chart/ChartMergeList.tsx); saved charts
 *    (chart/SavedTables.tsx).
 *  - Actions Pin view… · Save image… · Copy data as CSV · Show as table (Time › Data, pre-filtered).
 */
import type { JSX } from "preact";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { type DimId } from "../../shared/dims";
import { countsDefault, linksAvailable, waveSmoothing, waveWindowChoices, waveWindowDays } from "../../shared/chartOptions";
import { featureOn } from "../../shared/features";
import type { ChartSpec } from "../../shared/protocol/worker";
import { CHART_CATALOGUE, CHART_GROUP_ORDER, type ChartId } from "../../shared/views";
import { openPage, setChartCloseHook, setCommandMode, setShape, setView, addToken } from "../../state/actions";
import { isReducedMotion, useLeaf, useServices, useShell } from "../context";
import { t, type CopyKey } from "../copy";
import { runCortexCommand } from "../header/MoreMenu";
import { Button, SectionLabel, TextButton } from "../primitives/buttons";
import { Segmented, Slider, Toggle } from "../primitives/controls";
import { chartSpecFor, morphAnimator } from "../stage/ShapeBar";
import { nextDim, refTokens, useChartFeed, renamesOf } from "../stage/ChartOverlay";
import { readingRef, readingText } from "../stage/Readings";
import { answerTextOf } from "../stage/answers";
import { balanceDim } from "../../shared/balance";
import { dimLabel, fmtDayRange } from "../valueLabels";
import { ChartAxesSection, ChartFieldsList } from "./chart/ChartAxesSection";
import { ChartChooser } from "./chart/ChartChooser";
import { ChartDisclosure } from "./chart/ChartDisclosure";
import { ChartWhatShows } from "./chart/ChartWhatShows";
import { ChartBalance } from "./chart/ChartBalance";
import { ChartFolders, isFolderAxis } from "./chart/ChartFolders";
import { ChartGroupsSection } from "./chart/ChartGroupsSection";
import { ChartMergeList } from "./chart/ChartMergeList";
import { ChartPanelHeader } from "./chart/ChartPanelHeader";
import { ChartShowHide } from "./chart/ChartShowHide";
import { arrangementOf, closeChartToBrain, openChartShape } from "./chart/chartPanel";
import { SavedTables } from "./chart/SavedTables";
import { PageFrame } from "./PageFrame";
import { ROW_DIMS } from "./TimeData";

export const TOP_N = { default: 20, min: 5, max: 60 } as const;

export function clampTopN(n: number): number {
  return Math.max(TOP_N.min, Math.min(TOP_N.max, Math.round(n)));
}

/** The dimension the other zone takes when both would get `dim` (Area → Folder → Month …). */
export function zoneFallback(dim: DimId, avoid: DimId = dim): DimId {
  return nextDim(dim, avoid);
}

/** Gallery tiles by group, P2 charts only when their phase is built. */
export function galleryGroups(phase2 = featureOn("pinView")): { group: (typeof CHART_GROUP_ORDER)[number]; charts: string[] }[] {
  return CHART_GROUP_ORDER.map((group) => ({
    group,
    charts: CHART_CATALOGUE.filter((c) => c.group === group && (c.phase === "P1" || phase2)).map((c) => c.id),
  }));
}

// ───────────────────────────── spec helpers ─────────────────────────────

/** The spec for a newly chosen chart: axes carry over inside a group, otherwise they are seeded from the new group; chart options never carry. */
export function specForChart(id: ChartId, prev: ChartSpec | null, groupBy: DimId): ChartSpec {
  const fresh = chartSpecFor(id, null, groupBy);
  if (!prev) return fresh;
  const sameGroup = CHART_CATALOGUE.find((c) => c.id === prev.chart)?.group === CHART_CATALOGUE.find((c) => c.id === id)?.group;
  const kept = { size: prev.size, filter: prev.filter, hideNoValue: prev.hideNoValue, merges: prev.merges, combined: prev.combined, top: prev.top };
  return sameGroup ? { ...fresh, ...kept, x: prev.x, y: prev.y, colour: prev.colour } : { ...fresh, ...kept };
}

/** Chart-specific options (§7.2); the chart's id decides which controls the page shows. `when` hides a control (Window only applies once Smoothing is on). */
export type OptionControl = { when?: (options: ChartSpec["options"]) => boolean } & (
  | { kind: "toggle"; key: string; label: CopyKey; fallback: boolean }
  | { kind: "slider"; key: string; label: CopyKey; min: number; max: number; fallback: number }
  | { kind: "choice"; key: string; label: CopyKey; choices: { value: string; label: CopyKey }[]; fallback: string }
);

/** The Show rows select of the Lifelines and Arc diagram: which rows come first (Longest, Recent, Most). */
const ROWS_SHOW: OptionControl = {
  kind: "choice",
  key: "rows",
  label: "chart.showRows",
  choices: [{ value: "longest", label: "chart.rowsLongest" }, { value: "recent", label: "chart.rowsRecent" }, { value: "most", label: "chart.rowsMost" }],
  fallback: "most",
};

export const CHART_OPTIONS: Readonly<Partial<Record<ChartId, readonly OptionControl[]>>> = {
  matrix: [{ kind: "toggle", key: "counts", label: "chart.counts", fallback: true }, { kind: "toggle", key: "perspective", label: "chart.perspective", fallback: true }],
  treemap: [{ kind: "toggle", key: "allLevels", label: "chart.showAllLevels", fallback: false }],
  "nested-bubbles": [{ kind: "choice", key: "form", label: "chart.arrange", choices: [{ value: "rows", label: "chart.shellsRows" }, { value: "nested", label: "chart.shellsNested" }], fallback: "rows" }],
  bands: [{ kind: "choice", key: "grain", label: "chart.bandSegments", choices: [{ value: "auto", label: "chart.segmentsAuto" }, { value: "week", label: "chart.segmentsWeek" }, { value: "month", label: "chart.segmentsMonth" }], fallback: "auto" }],
  ridgeline: [
    { kind: "choice", key: "scale", label: "chart.scale", choices: [{ value: "linear", label: "chart.linear" }, { value: "sqrt", label: "chart.sqrt" }, { value: "log", label: "chart.log" }], fallback: "linear" },
    {
      kind: "choice",
      key: "smoothing",
      label: "chart.smoothing",
      choices: [
        { value: "none", label: "chart.smoothNone" },
        { value: "moving", label: "chart.movingAverage" },
        { value: "exponential", label: "chart.exponentialAverage" },
      ],
      fallback: "none",
    },
    {
      kind: "choice",
      key: "windowDays",
      label: "chart.window",
      choices: [{ value: "7", label: "chart.days7" }, { value: "30", label: "chart.days30" }, { value: "90", label: "chart.days90" }],
      fallback: "30",
      when: (o) => waveSmoothing(o) !== "none",
    },
    { kind: "toggle", key: "normalise", label: "chart.normalise", fallback: false },
  ],
  "timeline-lanes": [{ kind: "choice", key: "show", label: "chart.show", choices: [{ value: "lines", label: "chart.showLines" }, { value: "blocks", label: "chart.showBlocks" }, { value: "dots", label: "chart.showDots" }, { value: "density", label: "chart.showDensity" }, { value: "curve", label: "chart.showCurve" }], fallback: "lines" }, ROWS_SHOW],
  "arc-diagram": [{ kind: "slider", key: "minGapDays", label: "chart.minimumGap", min: 1, max: 365, fallback: 7 }, ROWS_SHOW],
  "diverging-area": [{ kind: "choice", key: "measure", label: "chart.measure", choices: [{ value: "words", label: "chart.words" }, { value: "messages", label: "chart.messages" }], fallback: "words" }],
  beeswarm: [{ kind: "choice", key: "size", label: "chart.size", choices: [{ value: "messages", label: "chart.messages" }, { value: "words", label: "chart.words" }], fallback: "messages" }],
  chord: [{ kind: "choice", key: "weight", label: "chart.weight", choices: [{ value: "shared", label: "chart.sharedConversations" }, { value: "links", label: "chart.links" }], fallback: "shared" }],
};

/**
 * Every control the page shows for a chart: its own options, then Counts (every chart; on by default where the count is
 * the point) and Links (every chart that is not itself a drawing of connections).
 */
export function optionsFor(id: ChartId): readonly OptionControl[] {
  const own = CHART_OPTIONS[id] ?? [];
  const out: OptionControl[] = [...own];
  if (!own.some((o) => o.key === "counts")) out.push({ kind: "toggle", key: "counts", label: "chart.counts", fallback: countsDefault(id) });
  if (linksAvailable(id)) out.push({ kind: "toggle", key: "links", label: "chart.links", fallback: false });
  return out;
}

/** Charts with the Folders checklist. */
export const FOLDER_CHARTS: readonly ChartId[] = ["treemap", "icicle"];

/** Folder paths unticked in the checklist (the subtree goes with them). */
export function excludedFolders(spec: ChartSpec): string[] {
  const v = spec.options.excludedFolders;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Untick or tick a folder: an unticked folder removes its particles from this chart. */
export function setFolderIncluded(spec: ChartSpec, path: string, included: boolean): ChartSpec {
  const rest = excludedFolders(spec).filter((p) => p !== path);
  return { ...spec, options: { ...spec.options, excludedFolders: included ? rest : [...rest, path] } };
}

/** A folder is shown unticked when it or any ancestor is excluded. */
export function folderIncluded(spec: ChartSpec, path: string): boolean {
  return !excludedFolders(spec).some((ex) => path === ex || path.startsWith(`${ex}/`));
}

/** "Calendar heatmap by Source, 2 Oct – today": what Ask receives as the attached chart. */
export function chartDescription(spec: ChartSpec, period: [number, number] | null): string {
  const by = spec.colour ?? spec.y?.dim ?? spec.x.dim;
  const when = period ? `${fmtDayRange(period[0], Math.max(period[0], period[1] - 1))}` : t("strip.allTime");
  return `${t(`charts.${spec.chart}` as CopyKey)} · ${dimLabel(by)}, ${when}`;
}

/** The Time › Data page that shows these numbers: rows from the chart's horizontal dimension, columns from the second. */
export function tableParams(spec: ChartSpec): Record<string, string> {
  const rows = (ROW_DIMS as readonly string[]).includes(spec.x.dim) ? spec.x.dim : "space";
  const second = spec.y?.dim ?? spec.colour;
  const cols = second && (["space", "source", "speaker", "kind"] as string[]).includes(second) && second !== rows ? second : null;
  return { view: "data", rows, ...(cols ? { cols } : {}), measure: spec.size === "words" ? "words" : "entries" };
}

// ───────────────────────────── the page ─────────────────────────────

export function ChartPage(_p: { params: Readonly<Record<string, string>> }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const store = leaf.store;
  const view = store.slices.view.value;
  const ui = store.slices.ui.value;
  const spec = view.chart;
  const { value } = useChartFeed();
  const settings = s.settings.value;
  const reduced = isReducedMotion(settings.appearance.motion, shell.systemReducedMotion.value);
  const phase2 = featureOn("pinView");

  const setSpec = (next: ChartSpec) => setView(store, "chart", next);
  const justChose = useRef(false);
  const choose = (id: ChartId) => {
    justChose.current = true;
    setView(store, "chart", specForChart(id, view.chart, view.groupBy));
    setShape(store, "chart");
    morphAnimator(store, shell, () => reduced)(1);
  };
  // Opening the page brings the chart up; closing it (the × or the Chart key) sends the figure back to the brain when the page opened it.
  useEffect(() => {
    const animate = morphAnimator(store, shell, () => reduced);
    openChartShape(store, animate);
    setChartCloseHook(store, () => void closeChartToBrain(store, (to) => animate(to), (fn, ms) => setTimeout(fn, ms), isReducedMotion(s.settings.value.appearance.motion, shell.systemReducedMotion.value) ? 0 : undefined));
    return () => setChartCloseHook(store, null);
  }, [store]);
  const arrangement = arrangementOf(view.shape);

  const readings = value?.result.readings ?? [];
  const answer = useMemo(() => (value && spec && value.spec.chart === spec.chart ? answerTextOf(value) : null), [value, spec?.chart]);
  // A pick from the chooser brings its question and answer into view (the panel scrolls; the answer is what the pick is for).
  useEffect(() => {
    if (!justChose.current || !answer) return;
    justChose.current = false;
    const el = shell.root?.querySelector(".cx-chart-answer") as (HTMLElement & { scrollIntoView?: (o?: ScrollIntoViewOptions) => void }) | null | undefined;
    el?.scrollIntoView?.({ block: "nearest" });
  }, [answer?.question, answer?.answer]);
  // The values and folders the chart reported for the spec on screen (not an older chart's, while a new one is computed).
  const cats = spec && value && (value.spec.chart === spec.chart || (FOLDER_CHARTS.includes(value.spec.chart) && FOLDER_CHARTS.includes(spec.chart))) && value.spec.x.dim === spec.x.dim ? (value.result.categories ?? []) : [];
  const isFolderChart = spec !== null && FOLDER_CHARTS.includes(spec.chart);
  const byFolderTree = spec !== null && isFolderChart && isFolderAxis(spec);
  const options = spec ? optionsFor(spec.chart).filter((o) => !o.when || o.when(spec.options)) : [];
  const hiddenCount = ui.hiddenGroups.length;
  const askLabel = spec ? `${t("chart.askAbout")}: ${chartDescription(spec, ui.period)}` : t("chart.askAbout");

  return (
    <PageFrame subtitle={spec ? chartDescription(spec, ui.period) : t("chart.gallery")} label={t("chart.gallery")}>
      <ChartPanelHeader />
      {arrangement === "groups" ? <ChartGroupsSection /> : null}
      {spec && arrangement === "chart" ? (
        <>
          {isFolderChart ? <ChartFolders spec={spec} setSpec={setSpec} categories={cats} /> : null}
          {!byFolderTree ? <ChartAxesSection spec={spec} setSpec={setSpec} /> : null}
          <ChartWhatShows spec={spec} setSpec={setSpec} />
          <ChartChooser phase2={phase2} selected={spec.chart} onChoose={choose} answer={answer} />
          {options.length > 0 ? (
            <section class="cx-section" aria-label={t("chart.options")}>
              <SectionLabel>{t("chart.options")}</SectionLabel>
              {options.map((o) => {
                const set = (v: string | number | boolean) => setSpec({ ...spec, options: { ...spec.options, [o.key]: v } });
                const cur = spec.options[o.key];
                if (o.kind === "toggle") return <Toggle key={o.key} label={t(o.label)} checked={typeof cur === "boolean" ? cur : o.fallback} onChange={set} />;
                if (o.kind === "slider") {
                  const n = typeof cur === "number" ? cur : o.fallback;
                  return <Slider key={o.key} label={t(o.label)} value={n} min={o.min} max={o.max} step={1} format={(v) => (v === 0 && o.min === 0 ? t("time.none") : String(v))} onInput={set} />;
                }
                if (o.key === "windowDays") {
                  // What the chart really smooths over (an older saved chart carries its own number of days).
                  const days = waveWindowChoices(spec.options).map((n) => ({ value: String(n), label: t("chart.daysN", { n }) }));
                  return (
                    <div key={o.key} class="cx-chart-opt">
                      <span class="cx-row-label">{t(o.label)}</span>
                      <Segmented label={t(o.label)} value={String(waveWindowDays(spec.options))} options={days} onChange={set} />
                    </div>
                  );
                }
                const v = typeof cur === "string" ? cur : o.fallback;
                return (
                  <div key={o.key} class="cx-chart-opt">
                    <span class="cx-row-label">{t(o.label)}</span>
                    <Segmented label={t(o.label)} value={v} options={o.choices.map((c) => ({ value: c.value, label: t(c.label) }))} onChange={set} />
                  </div>
                );
              })}
            </section>
          ) : null}
          {spec.chart === "two-sides" ? (
            <ChartBalance spec={spec} setSpec={setSpec} values={value && balanceDim(value.spec.options) === balanceDim(spec.options) ? (value.result.categories ?? []) : []} />
          ) : null}
          {spec.chart === "radial-clock" ? (
            <section class="cx-section" aria-label={t("chart.hourOrWeekday")}>
              <Segmented
                label={t("chart.hourOrWeekday")}
                value={spec.x.dim === "weekday" || spec.x.dim === "monthOfYear" ? spec.x.dim : "hour"}
                options={[
                  { value: "hour", label: dimLabel("hour") },
                  { value: "weekday", label: dimLabel("weekday") },
                  { value: "monthOfYear", label: dimLabel("monthOfYear") },
                ]}
                onChange={(d) => setSpec({ ...spec, x: { ...spec.x, dim: d } })}
              />
            </section>
          ) : null}

          <section class="cx-section" aria-label={t("chart.readings")}>
            <SectionLabel>{t("chart.readings")}</SectionLabel>
            <ul class="cx-chart-readings">
              {readings.map((r, i) => {
                const ref = readingRef(r);
                return (
                  <li key={`${i}:${r.kind}`} class="cx-chart-reading">
                    <span class="cx-mono">{readingText(r, renamesOf(value?.spec.options))}</span>
                    {ref ? (
                      <TextButton
                        onClick={() => {
                          for (const tk of refTokens(ref)) addToken(store, tk);
                        }}
                      >
                        {t("chart.trace")}
                      </TextButton>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <Button
              icon="info"
              onClick={() => {
                setCommandMode(store, "ask");
                runCortexCommand(s.app, "ask");
              }}
            >
              <span title={askLabel}>{t("chart.askAbout")}</span>
            </Button>
            <p class="cx-chart-attach">{askLabel}</p>
          </section>

          {!byFolderTree ? (
            <ChartDisclosure title={t("chart.showHide")} summary={hiddenCount > 0 ? t("chart.hiddenSummary", { n: hiddenCount }) : undefined}>
              <ChartShowHide spec={spec} bare />
            </ChartDisclosure>
          ) : null}
          {!byFolderTree ? (
            <ChartDisclosure title={t("chart.startAndFields")}>
              <ChartFieldsList spec={spec} setSpec={setSpec} />
            </ChartDisclosure>
          ) : null}

          {!byFolderTree ? <ChartMergeList spec={spec} setSpec={setSpec} categories={cats} /> : null}

          <SavedTables />

          <section class="cx-section cx-row-buttons" aria-label={t("chart.options")}>
            {phase2 ? (
              <Button icon="pin" onClick={() => void runCortexCommand(s.app, "pin-view")}>
                {t("chart.pinView")}
              </Button>
            ) : null}
            <Button icon="saveImage" onClick={() => s.bus.emit("command", { viewId: leaf.viewId, id: "save-image" })}>
              {t("chart.saveImage")}
            </Button>
            <Button icon="copyData" onClick={() => s.bus.emit("command", { viewId: leaf.viewId, id: "copy-data-csv" })}>
              {t("chart.copyCsv")}
            </Button>
            <Button icon="data" onClick={() => openPage(store, "time", tableParams(spec), true)}>
              {t("chart.showTable")}
            </Button>
          </section>
        </>
      ) : null}
    </PageFrame>
  );
}
