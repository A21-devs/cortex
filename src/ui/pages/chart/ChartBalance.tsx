/**
 * Controls of the Balance chart (CHART-33): which dimension has the two sides, and which value stands on each. The
 * default is you versus assistants; any other dimension takes a chosen pair (its two largest until one is chosen).
 * The pickers offer the values the chart reported for the dimension on screen.
 */
import type { JSX } from "preact";
import { balanceDim, balanceSides, withBalanceDim, withBalanceSide } from "../../../shared/balance";
import type { ChartSpec } from "../../../shared/protocol/worker";
import { useServices } from "../../context";
import { t } from "../../copy";
import { SectionLabel } from "../../primitives/buttons";
import { Select } from "../../primitives/controls";
import { openDimMenu } from "../../primitives/dimMenu";
import { categoryName, OTHER_VALUE } from "../../stage/ChartOverlay";
import { dimLabel } from "../../valueLabels";

export interface BalanceValueInfo {
  key: string;
  label: string;
  count: number;
}

export function ChartBalance(p: { spec: ChartSpec; setSpec(next: ChartSpec): void; values: readonly BalanceValueInfo[] }): JSX.Element {
  const s = useServices();
  const { spec, setSpec } = p;
  const dim = balanceDim(spec.options);
  const values = p.values.filter((v) => v.key !== OTHER_VALUE);
  const [a, b] = balanceSides(spec.options, dim, values);
  const choices = values.map((v) => ({ value: v.key, label: `${categoryName(dim, v.key, v.label)} · ${v.count.toLocaleString("en-GB")}` }));
  const side = (which: "sideA" | "sideB", label: string, key: string | null): JSX.Element => (
    <Select<string>
      label={label}
      value={key ?? ""}
      options={key === null || choices.some((c) => c.value === key) ? choices : [{ value: key, label: key }, ...choices]}
      onChange={(next) => setSpec({ ...spec, options: withBalanceSide(spec.options, which, next, [a, b]) })}
    />
  );
  return (
    <section class="cx-section" aria-label={t("chart.balanceSides")}>
      <SectionLabel>{t("chart.balanceSides")}</SectionLabel>
      <div class="cx-row">
        <span class="cx-row-label">{t("chart.balanceBy")}</span>
        <button
          type="button"
          class="cx-select"
          aria-haspopup="menu"
          aria-label={`${t("chart.balanceBy")}: ${dimLabel(dim)}`}
          onClick={(e) => openDimMenu(e.currentTarget as HTMLElement, { app: s.app, settings: s.settings.value, current: dim, onPick: (next) => setSpec({ ...spec, options: withBalanceDim(spec.options, next) }) })}
        >
          <span class="cx-select-value">{dimLabel(dim)}</span>
          <span class="cx-select-caret" aria-hidden="true" />
        </button>
      </div>
      {choices.length >= 2 ? (
        <>
          {side("sideA", t("chart.balanceFirst"), a)}
          {side("sideB", t("chart.balanceSecond"), b)}
        </>
      ) : (
        <p class="cx-chart-attach">{t("chart.balanceNeed")}</p>
      )}
    </section>
  );
}
