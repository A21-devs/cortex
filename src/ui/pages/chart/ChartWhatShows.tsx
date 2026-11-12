/**
 * The Chart page's What shows block: Colour with its key, Size, Filter and Hide unsorted. Choosing a field in Filter
 * opens a scrollable checklist of that field's values (counts, largest first, the largest FILTER_SHOWN when there are
 * more) with the note and the hint under it; the ticked values are the chart's `filter`, and the chips stay as the
 * summary (each with a ×).
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { DimId } from "../../../shared/dims";
import type { ChartSpec } from "../../../shared/protocol/worker";
import { visibilityParams } from "../../../state/selectors";
import { useLeaf, useServices } from "../../context";
import { t } from "../../copy";
import { Icon, SectionLabel, TextButton } from "../../primitives/buttons";
import { Segmented, Toggle } from "../../primitives/controls";
import { openDimMenu } from "../../primitives/dimMenu";
import { categoryName } from "../../stage/ChartOverlay";
import { dimLabel } from "../../valueLabels";
import { loaded, statsKey, useLoad } from "../PageFrame";
import { ChartColourRow } from "./ChartAxesSection";
import { activeFilterDim, clearKept, filterChoices, FILTER_SHOWN, isKept, toggleKept, type FilterValue } from "./chartFilter";

export interface FilterChecklistProps {
  dim: DimId;
  /** null while the values load. */
  values: FilterValue[] | null;
  failed?: boolean;
  spec: ChartSpec;
  setSpec(next: ChartSpec): void;
  /** "Keep all": the field's ticks go and the list closes. */
  onKeepAll(): void;
}

/** The checklist as drawn: no store, no worker. */
export function FilterChecklist(p: FilterChecklistProps): JSX.Element {
  const dimName = dimLabel(p.dim);
  const choices = p.values ? filterChoices(p.values) : null;
  const fmt = (n: number) => n.toLocaleString("en-GB");
  return (
    <div class="cx-chart-filter-list" data-testid="chart-filter-list">
      {p.failed ? (
        <p class="cx-chart-values-note" role="alert">
          {t("chart.showHideFailed")}
        </p>
      ) : choices === null ? (
        <p class="cx-chart-values-note" aria-live="polite">
          {t("chart.filterLoading")}
        </p>
      ) : choices.rows.length === 0 ? (
        <p class="cx-chart-values-note">{t("chart.showHideEmpty")}</p>
      ) : (
        <>
          <ul class="cx-chart-values cx-chart-filter-values" aria-label={t("chart.filterListFor", { dim: dimName })}>
            {choices.rows.map((r) => (
              <li key={r.key}>
                <label class="cx-chart-value">
                  <input type="checkbox" checked={isKept(p.spec, p.dim, r.key)} aria-label={t("chart.filterTickValue", { name: r.label })} onChange={() => p.setSpec(toggleKept(p.spec, p.dim, r.key))} />
                  <span class="cx-chart-value-name" title={r.label}>
                    {r.label}
                  </span>
                  <span class="cx-mono cx-chart-value-count">{fmt(r.count)}</span>
                </label>
              </li>
            ))}
          </ul>
          <p class="cx-chart-values-footer">
            {t("chart.filterOf", { n: fmt(choices.total) })}
            {choices.cut ? ` · ${t("chart.filterLargest", { n: fmt(FILTER_SHOWN) })}` : ""}
          </p>
        </>
      )}
      <div class="cx-chart-filter-foot">
        <TextButton onClick={p.onKeepAll}>
          {t("chart.filterKeepAll")}
        </TextButton>
        <span class="cx-chart-values-note">{t("chart.filterTick")}</span>
      </div>
    </div>
  );
}

/** The values of one field in the chart's scope and period (the same read the old Filter menu made). */
function useFilterValues(dim: DimId | null): { values: FilterValue[] | null; failed: boolean } {
  const s = useServices();
  const leaf = useLeaf();
  const store = leaf.store;
  const ui = store.slices.ui.value;
  const view = store.slices.view.value;
  const idx = s.index.index.value;
  const load = useLoad<FilterValue[]>(
    async (signal) => {
      if (!idx || dim === null) return [];
      const res = await s.worker.call(statsKey(leaf.viewId, "filter"), "stats", { kind: "data", rows: dim, columns: "none", measure: "entries", visibility: visibilityParams(store.get("ui"), store.get("view")) }, { signal });
      if (res.kind !== "data") return [];
      return res.rows.map((r) => ({ key: r.key, label: categoryName(dim, r.key, r.label), count: r.total }));
    },
    [dim, idx, ui.scope, ui.period, view.layers],
  );
  return { values: loaded(load) ?? null, failed: load.state === "error" };
}

export function ChartWhatShows(p: { spec: ChartSpec; setSpec(next: ChartSpec): void }): JSX.Element {
  const s = useServices();
  const { spec, setSpec } = p;
  const [picked, setPicked] = useState<DimId | null>(null);
  const dim = activeFilterDim(picked, spec);
  const { values, failed } = useFilterValues(dim);
  const pickField = (e: MouseEvent) => {
    openDimMenu(e.currentTarget as HTMLElement, { app: s.app, settings: s.settings.value, current: dim, onPick: (d) => setPicked(d) });
  };
  return (
    <section class="cx-section cx-chart-whatshows" aria-label={t("chart.whatShows")}>
      <SectionLabel>{t("chart.whatShows")}</SectionLabel>
      <div class="cx-chart-zones">
        <ChartColourRow spec={spec} setSpec={setSpec} />
        <div class="cx-chart-zone">
          <span class="cx-row-label">{t("chart.size")}</span>
          <Segmented
            label={t("chart.size")}
            value={spec.size}
            options={[
              { value: "entries", label: t("time.count") },
              { value: "words", label: t("chart.words") },
            ]}
            onChange={(size) => setSpec({ ...spec, size })}
          />
        </div>
        <div class="cx-chart-zone">
          <span class="cx-row-label">{t("chart.filter")}</span>
          <button type="button" class="cx-select" aria-haspopup="menu" aria-label={`${t("chart.filter")}: ${dim ? dimLabel(dim) : t("chart.noFilter")}`} onClick={(e) => pickField(e as unknown as MouseEvent)}>
            <span class="cx-select-value">{dim ? dimLabel(dim) : t("chart.noFilter")}</span>
            <span class="cx-select-caret" aria-hidden="true" />
          </button>
        </div>
      </div>
      {spec.filter.length > 0 ? (
        <div class="cx-chart-filters cx-chart-filter-chips">
          {spec.filter.map((f) => (
            <span key={`${f.dim}=${f.value}`} class="cx-chart-chip is-filter">
              {`${dimLabel(f.dim)} = ${categoryName(f.dim, f.value, f.value)}`}
              <button type="button" aria-label={t("header.close")} onClick={() => setSpec({ ...spec, filter: spec.filter.filter((x) => x !== f) })}>
                <Icon name="close" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {dim ? <FilterChecklist dim={dim} values={values} failed={failed} spec={spec} setSpec={setSpec} onKeepAll={() => { setSpec(clearKept(spec, dim)); setPicked(null); }} /> : null}
      <Toggle label={t("chart.hideNoValue")} checked={spec.hideNoValue} onChange={(hideNoValue) => setSpec({ ...spec, hideNoValue })} />
    </section>
  );
}
