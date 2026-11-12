/**
 * The Chart page's "Show or hide" section: one tab per axis of the chart, a checklist of that axis' values (tick box,
 * name, count and an Only link), a row of chips for everything hidden (each with a ×) and Show all. It reads and writes
 * the hidden set the stage keeps (`ui.hiddenGroups`), the same one a right-click on a chart label and the key bar edit,
 * and that set is saved with Saved charts. Every change can be undone (Ctrl Z or the toast).
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { DimId } from "../../../shared/dims";
import { checklistRows, hiddenChips, isOnlyValue, onlyValue, sameHidden, showAllOf, toggleValue, type ChecklistRow, type HiddenChip } from "../../../shared/chartHidden";
import { axisRolesFor } from "../../../shared/chartAxes";
import type { ChartSpec } from "../../../shared/protocol/worker";
import { setHiddenGroups } from "../../../state/actions";
import { visibilityParams } from "../../../state/selectors";
import { useLeaf, useServices, useShell } from "../../context";
import { t } from "../../copy";
import { Icon, SectionLabel, TextButton } from "../../primitives/buttons";
import { Segmented } from "../../primitives/controls";
import { categoryName, renamesOf } from "../../stage/ChartOverlay";
import { dimLabel } from "../../valueLabels";
import { loaded, statsKey, useLoad } from "../PageFrame";

export type AxisZone = "x" | "y";

/** The axes the checklist has tabs for: the horizontal one, and the vertical one when the form has two. */
export function showHideAxes(spec: ChartSpec): { zone: AxisZone; dim: DimId }[] {
  const out: { zone: AxisZone; dim: DimId }[] = [{ zone: "x", dim: spec.x.dim }];
  if (axisRolesFor(spec.chart).y && spec.y) out.push({ zone: "y", dim: spec.y.dim });
  return out;
}

export interface ShowHideViewProps {
  axes: { zone: AxisZone; dim: DimId }[];
  active: AxisZone;
  onTab(zone: AxisZone): void;
  /** The active axis' rows (null while they load). */
  rows: ChecklistRow[] | null;
  failed?: boolean;
  chips: { chip: HiddenChip; name: string }[];
  onToggle(row: ChecklistRow): void;
  onOnly(row: ChecklistRow): void;
  onChip(chip: HiddenChip): void;
  onShowAll(): void;
  /** Whether a row is the only one shown (its Only link then reads as pressed). */
  isOnly(row: ChecklistRow): boolean;
  /** Without its own heading (the page's collapsible header carries it). */
  bare?: boolean;
}

/** The section as drawn: no store, no worker. */
export function ShowHideView(p: ShowHideViewProps): JSX.Element {
  const axis = p.axes.find((a) => a.zone === p.active) ?? p.axes[0];
  const dimName = axis ? dimLabel(axis.dim) : "";
  return (
    <section class="cx-section cx-chart-showhide" aria-label={t("chart.showHide")}>
      {p.bare ? null : <SectionLabel>{t("chart.showHide")}</SectionLabel>}
      {p.axes.length > 1 ? (
        <Segmented<AxisZone> label={t("chart.showHideAxes")} value={p.active} options={p.axes.map((a) => ({ value: a.zone, label: dimLabel(a.dim) }))} onChange={p.onTab} />
      ) : null}
      {p.failed ? (
        <p class="cx-chart-values-note" role="alert">
          {t("chart.showHideFailed")}
        </p>
      ) : p.rows === null ? (
        <p class="cx-chart-values-note" aria-live="polite">
          {t("chart.showHideLoading")}
        </p>
      ) : p.rows.length === 0 ? (
        <p class="cx-chart-values-note">{t("chart.showHideEmpty")}</p>
      ) : (
        <ul class="cx-chart-values cx-chart-showhide-list" aria-label={t("chart.showHideList", { dim: dimName })}>
          {p.rows.map((r) => (
            <li key={r.key} class={r.shown ? "" : "is-hidden"}>
              <label class="cx-chart-value">
                <input type="checkbox" checked={r.shown} aria-label={t(r.shown ? "chart.showHideHide" : "chart.showHideShow", { name: r.label })} onChange={() => p.onToggle(r)} />
                <span class="cx-chart-value-name" title={r.label}>
                  {r.label}
                </span>
                <span class="cx-mono cx-chart-value-count">{r.count.toLocaleString("en-GB")}</span>
              </label>
              <button
                type="button"
                class={`cx-text-button cx-chart-only${p.isOnly(r) ? " is-on" : ""}`}
                aria-pressed={p.isOnly(r)}
                aria-label={t(p.isOnly(r) ? "chart.showHideAgain" : "chart.showHideOnlyLabel", { name: r.label, dim: dimName })}
                onClick={() => p.onOnly(r)}
              >
                {t("chart.showHideOnly")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div class="cx-chart-hidden-row">
        <span class="cx-row-label">{t("chart.hiddenLabel")}</span>
        {p.chips.length === 0 ? (
          <span class="cx-chart-values-note">{t("chart.hiddenNone")}</span>
        ) : (
          <div class="cx-chart-chips cx-chart-hidden-chips" role="list">
            {p.chips.map(({ chip, name }) => (
              <span key={chip.key} role="listitem" class="cx-chart-chip is-filter">
                {name}
                <button type="button" aria-label={t("chart.hiddenChip", { name })} onClick={() => p.onChip(chip)}>
                  <Icon name="close" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
      <div class="cx-chart-hidden-row">
        <TextButton disabled={p.chips.length === 0} onClick={p.onShowAll}>
          {t("chart.showAll")}
        </TextButton>
      </div>
    </section>
  );
}

interface AxisValues {
  state: "loading" | "ready" | "error";
  value: { key: string; label: string; count: number }[] | null;
}

/**
 * Every value of one axis in the chart's scope and period, notes and record together (the key's own count: one row per
 * band the stage can hide). Hidden values stay on the list so they can be ticked again. A null dimension reads nothing.
 */
function useAxisValues(dim: DimId | null, purpose: string, names: ReturnType<typeof renamesOf>): AxisValues {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const store = leaf.store;
  const ui = store.slices.ui.value;
  const view = store.slices.view.value;
  const idx = s.index.index.value;
  const load = useLoad<{ key: string; label: string; count: number }[]>(
    async (signal) => {
      if (!idx || dim === null) return [];
      const dark = !!shell.root?.ownerDocument.body.classList.contains("theme-dark");
      const mode = { kind: "categorical", dim } as const;
      const res = await s.worker.call(
        statsKey(leaf.viewId, `showhide-${purpose}`),
        "grouping",
        {
          notes: mode,
          record: mode,
          fold: false,
          hideNoValue: false,
          hiddenGroups: [],
          merges: {},
          palette: s.settings.value.appearance.palette,
          light: !dark,
          slots: s.colours.current(),
          visibility: visibilityParams(store.get("ui"), store.get("view")),
        },
        { signal },
      );
      const rows = res.legend.sections[0]?.rows ?? [];
      return rows.filter((r) => !r.aggregate).map((r) => ({ key: r.key, label: categoryName(dim, r.key, r.name, names), count: r.notes + r.record }));
    },
    [dim, idx, ui.scope, ui.period, view.layers],
  );
  const value = loaded(load) ?? null;
  return { state: load.state, value };
}

export function ChartShowHide(p: { spec: ChartSpec; bare?: boolean }): JSX.Element {
  const leaf = useLeaf();
  const shell = useShell();
  const store = leaf.store;
  const { spec } = p;
  const axes = showHideAxes(spec);
  const [tab, setTab] = useState<AxisZone>("x");
  const active = axes.find((a) => a.zone === tab) ?? (axes[0] as { zone: AxisZone; dim: DimId });
  const hidden = store.slices.ui.value.hiddenGroups;
  const names = renamesOf(spec.options);

  // Both axes' values are read (chips on either tab need their names); the checklist shows the active tab's.
  const xValues = useAxisValues(axes[0]?.dim ?? null, "x", names);
  const yValues = useAxisValues(axes[1]?.dim ?? null, "y", names);
  const got = (active.zone === "y" ? yValues : xValues).value;
  const state = active.zone === "y" ? yValues.state : xValues.state;
  const rows = got ? checklistRows(got, hidden, active.dim) : null;
  const allKeys = got ? got.map((v) => v.key) : [];
  const labelOf = (dim: DimId, key: string): string | undefined => {
    const list = axes[0]?.dim === dim ? xValues.value : axes[1]?.dim === dim ? yValues.value : undefined;
    return list?.find((v) => v.key === key)?.label;
  };

  const commit = (next: string[], notice: string) => {
    const before = store.get("ui").hiddenGroups;
    if (sameHidden(before, next)) return;
    setHiddenGroups(store, next);
    shell.pushUndo(() => {
      setHiddenGroups(store, before);
      shell.announce(t("chart.showHideUndone"));
    });
    shell.announce(notice);
  };
  const nameOf = (chip: HiddenChip): string => (chip.dim ? (labelOf(chip.dim, chip.value) ?? categoryName(chip.dim, chip.value, chip.value, names)) : chip.value);

  return (
    <ShowHideView
      bare={p.bare}
      axes={axes}
      active={active.zone}
      onTab={setTab}
      rows={rows}
      failed={state === "error"}
      chips={hiddenChips(hidden, axes.map((a) => a.dim)).map((chip) => ({ chip, name: nameOf(chip) }))}
      onToggle={(r) => commit(toggleValue(store.get("ui").hiddenGroups, active.dim, r.key), t(r.shown ? "chart.hiddenNotice" : "chart.shownNotice", { name: r.label }))}
      onOnly={(r) => {
        const cur = store.get("ui").hiddenGroups;
        commit(onlyValue(cur, active.dim, allKeys, r.key), isOnlyValue(cur, active.dim, allKeys, r.key) ? t("chart.allShownNotice") : t("chart.onlyNotice", { name: r.label }));
      }}
      isOnly={(r) => isOnlyValue(hidden, active.dim, allKeys, r.key)}
      onChip={(chip) => commit(store.get("ui").hiddenGroups.filter((k) => k !== chip.key && !(chip.dim === null && k === chip.value)), t("chart.shownNotice", { name: nameOf(chip) }))}
      onShowAll={() => commit(showAllOf(store.get("ui").hiddenGroups), t("chart.allShownNotice"))}
    />
  );
}
