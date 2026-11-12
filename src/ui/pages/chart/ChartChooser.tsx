/**
 * The Chart page's compact chooser: two hairline grids of plain names, Shape (how things sit: boxes, bars, bubbles,
 * clusters) and Question (what a chart answers: over time, rhythm, connections), four to a row, the chosen one filled.
 * A cell's full name shows in a small pill on hover or focus. The chosen chart's question and its one-line answer sit
 * directly under the grids, so the page's reading is in view without scrolling.
 */
import type { JSX } from "preact";
import { featureOn } from "../../../shared/features";
import { CHART_CATALOGUE, type ChartId } from "../../../shared/views";
import { t, type CopyKey } from "../../copy";
import { SectionLabel } from "../../primitives/buttons";

/** The forms that are shapes of the record rather than answers over time; everything else is a question. */
export const SHAPE_CHARTS: readonly ChartId[] = ["ranked-bars", "matrix", "treemap", "icicle", "bubble-pack", "nested-bubbles", "clusters-3d"];

export type ChooserKind = "shape" | "question";

export const CHOOSER_COLUMNS = 4;

/** The two groups of cells, in the catalogue's order; charts of a later phase stay out until their phase is built. */
export function chooserGroups(phase2 = featureOn("pinView")): { kind: ChooserKind; charts: ChartId[] }[] {
  const live = CHART_CATALOGUE.filter((c) => c.phase === "P1" || phase2).map((c) => c.id);
  return [
    { kind: "shape", charts: live.filter((id) => SHAPE_CHARTS.includes(id)) },
    { kind: "question", charts: live.filter((id) => !SHAPE_CHARTS.includes(id)) },
  ];
}

/** Empty cells that complete the last row of the grid, so the hairline frame is whole. */
export function padCells(count: number, columns = CHOOSER_COLUMNS): number {
  return count % columns === 0 ? 0 : columns - (count % columns);
}

export function ChartChooser(p: { phase2: boolean; selected: ChartId | null; onChoose(id: ChartId): void; answer: { question: string; answer: string | null } | null }): JSX.Element {
  return (
    <div class="cx-chart-chooser">
      {chooserGroups(p.phase2).map((g) => (
        <section key={g.kind} class="cx-section" aria-label={t(g.kind === "shape" ? "chart.chooseShape" : "chart.chooseQuestion")}>
          <SectionLabel>{t(g.kind === "shape" ? "chart.chooseShape" : "chart.chooseQuestion")}</SectionLabel>
          <div class="cx-chart-gallery is-four" role="group" aria-label={t(g.kind === "shape" ? "chart.chooseShape" : "chart.chooseQuestion")}>
            {g.charts.map((id) => (
              <button key={id} type="button" class={`cx-chart-tile${p.selected === id ? " is-selected" : ""}`} data-tip={t(`charts.${id}` as CopyKey)} aria-pressed={p.selected === id} onClick={() => p.onChoose(id)}>
                <span>{t(`charts.${id}` as CopyKey)}</span>
              </button>
            ))}
            {Array.from({ length: padCells(g.charts.length) }, (_, i) => (
              <span key={`pad${i}`} class="cx-chart-tile is-pad" aria-hidden="true" />
            ))}
          </div>
          {g.kind === "question" && p.answer ? (
            <div class="cx-chart-answer">
              <p class="cx-chart-question">{p.answer.question}</p>
              <p class="cx-chart-answer-line" aria-live="polite">
                {p.answer.answer ?? t("answers.none")}
              </p>
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}
