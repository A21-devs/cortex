/**
 * Guide › "Your record, layer by layer": the person's own record as a figure. The mini constellation (one dot per
 * area) sits above a by-year dot plot: one band for each kind of entry, one dot for each entry at the date it was
 * written, a year axis, a legend with counts and a caption that says how long the record runs. Everything is read
 * from the loaded index; with no index or no dated entry it says so instead of drawing an empty frame. The colours are
 * Cortex's fixed category colours, never the figure's colour theme. Pure view over `layerPlot` (recordModel.ts).
 */
import type { JSX } from "preact";
import { useMemo } from "preact/hooks";
import type { DataIndex } from "../../../shared/index-format";
import { COPY, t } from "../../copy";
import { ConstellationMark } from "./RecordFigure";
import { layerPlot, spanWords, type LayerKind, type LayerPlot, type RecordFacts } from "./recordModel";

export interface RecordLayersProps {
  index: DataIndex | null;
  areas: RecordFacts["areas"];
  /** The person's date format applied to epoch ms. */
  date(ms: number): string;
}

const W = 392;
const BAND = 22;
const GAP = 4;
const LEFT = 8;
const RIGHT = 8;
const TOP = 118;
const CAT: Readonly<Record<LayerKind, string>> = {
  conversations: "var(--cx-cat-1)",
  documents: "var(--cx-cat-2)",
  passages: "var(--cx-cat-3)",
  files: "var(--cx-cat-5)",
  notes: "var(--cx-cat-8)",
  summaries: "var(--cx-cat-7)",
  maps: "var(--cx-cat-6)",
};

export function kindName(k: LayerKind): string {
  return COPY.guide.record.layers.kinds[k];
}

/** "5 years", "8 months", "under a month". */
export function spanText(first: number, last: number): string {
  const s = spanWords(first, last);
  return s.unit === "years" ? t("guide.record.layers.spanYears", { n: s.n }) : s.unit === "months" ? t("guide.record.layers.spanMonths", { n: s.n }) : t("guide.record.layers.spanShort");
}

export function RecordLayers(p: RecordLayersProps): JSX.Element {
  const plot: LayerPlot | null = useMemo(() => (p.index ? layerPlot(p.index.cols, p.index.count) : null), [p.index]);
  const empty = !plot || plot.dated === 0;
  const plotW = W - LEFT - RIGHT;
  const height = empty ? 0 : TOP + plot.bands.length * (BAND + GAP) + 26;
  return (
    <section class="cx-guide-card cx-record-layers" data-demo="layers" aria-labelledby="cx-layers-title">
      <h3 id="cx-layers-title">{t("guide.record.layers.title")}</h3>
      <p>{t("guide.record.layers.intro")}</p>
      {empty ? (
        <p class="cx-note cx-layers-empty">{t("guide.record.layers.empty")}</p>
      ) : (
        <figure class="cx-rec-figure" data-figure="layers">
          <div class="cx-fig-scroll">
            <svg class="cx-fig" viewBox={`0 0 ${W} ${height}`} role="img" aria-label={t("guide.record.layers.label")}>
              <ConstellationMark areas={p.areas} x={W / 2 - 100} y={6} w={200} h={96} />
              {plot.bands.map((b, i) => (
                <g key={b.kind} data-band={b.kind}>
                  <rect x={LEFT} y={TOP + i * (BAND + GAP)} width={plotW} height={BAND} rx={3} class="cx-fig-band" />
                </g>
              ))}
              {plot.dots.map((d, i) => (
                <circle cx={LEFT + 4 + d.x * (plotW - 8)} cy={TOP + d.band * (BAND + GAP) + 3 + d.y * (BAND - 6)} r={1.1} fill={CAT[plot.bands[d.band]?.kind ?? "notes"]} key={i} />
              ))}
              {plot.ticks.map((tick) => (
                <text x={LEFT + 4 + tick.x * (plotW - 8)} y={height - 6} class="cx-fig-tiny is-mid" key={tick.year}>
                  {tick.year}
                </text>
              ))}
            </svg>
          </div>
          <ul class="cx-fig-legend" aria-label={t("guide.record.layers.label")}>
            {plot.bands.map((b) => (
              <li class="cx-fig-key" data-kind={b.kind}>
                <span class="cx-fig-swatch" style={{ background: CAT[b.kind] }} aria-hidden="true" />
                {t("guide.record.layers.legendItem", { kind: kindName(b.kind), n: b.n.toLocaleString("en-US") })}
              </li>
            ))}
          </ul>
          <figcaption class="cx-note">
            {t("guide.record.layers.caption", { n: plot.dated.toLocaleString("en-US"), span: spanText(plot.first, plot.last), first: p.date(plot.first), last: p.date(plot.last) })}
            {plot.undated > 0 ? ` ${t("guide.record.layers.undated", { n: plot.undated.toLocaleString("en-US") })}` : ""}
          </figcaption>
        </figure>
      )}
    </section>
  );
}
