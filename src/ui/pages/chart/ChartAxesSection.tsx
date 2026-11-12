/**
 * The Chart page's Fields section: dimension chips that drag onto the axis rows, a picker per axis named for what the
 * chosen form does with it (Across and Down, Around and Rings, From and To…; a one-axis form shows one row), an Order
 * select per axis (Count, Name, Natural), the Colour picker and its colour key. Owner: P09.
 */
import { Fragment, type JSX } from "preact";
import type { DimId } from "../../../shared/dims";
import { applyPreset, axisRolesFor, DEFAULT_SERIES, ORDER_CHOICES, ORDER_COPY, presetMatches, START_PRESETS, type AxisRole, type StartPreset } from "../../../shared/chartAxes";
import type { ChartSpec } from "../../../shared/protocol/worker";
import { useLeaf, useServices, useShell } from "../../context";
import { t, type CopyKey } from "../../copy";
import { SectionLabel } from "../../primitives/buttons";
import { Select } from "../../primitives/controls";
import { dimMenuModel, enabledPacks, flatDimItems, openDimMenu } from "../../primitives/dimMenu";
import { assignZone, DIM_MIME, swapAxes, zoneName, type Zone } from "../../stage/ChartOverlay";
import { dimLabel, fmtDate } from "../../valueLabels";
import type { DateFormat } from "../../../shared/settings";
import { ChartColourKey } from "./ChartColourKey";
import { withAxisOrder } from "./chartPanel";

/** The words an axis row carries for a role ("across" → "Across"). */
export function roleLabel(role: AxisRole): string {
  return t(`chart.role${role.charAt(0).toUpperCase()}${role.slice(1)}` as CopyKey);
}

/** The label of each row of a chart, in order: its axis roles (one when the form has one axis) and Colour. */
export function fieldLabels(chart: ChartSpec["chart"]): string[] {
  const r = axisRolesFor(chart);
  return [roleLabel(r.x), ...(r.y ? [roleLabel(r.y)] : []), t("chart.colour")];
}

/** The copy key of a preset's name ("monthFolder" → chart.startMonthFolder). */
export function presetCopy(p: StartPreset): CopyKey {
  return `chart.start${p.id.charAt(0).toUpperCase()}${p.id.slice(1)}` as CopyKey;
}

/** What a preset sets, in words: the form and its two dimensions ("Matrix: Month and Folder"). */
export function presetSummary(p: StartPreset): string {
  const chart = t(`charts.${p.chart}` as CopyKey);
  const x = dimLabel(p.x);
  return p.y ? t("chart.startFromHint", { chart, x, y: dimLabel(p.y) }) : t("chart.startFromOne", { chart, x, y: p.colour ? dimLabel(p.colour) : "" });
}

/** The "Start from" chip row: one click sets the form and both axes, and can be undone. */
export function StartFromRow(p: { spec: ChartSpec; setSpec(next: ChartSpec): void }): JSX.Element {
  const shell = useShell();
  const { spec, setSpec } = p;
  const start = (preset: StartPreset) => {
    const before = spec;
    setSpec(applyPreset(spec, preset));
    shell.pushUndo(() => setSpec(before));
    shell.announce(t("chart.startFromNotice", { chart: t(`charts.${preset.chart}` as CopyKey), x: dimLabel(preset.x), y: preset.y ? dimLabel(preset.y) : preset.colour ? dimLabel(preset.colour) : "" }));
  };
  return (
    <section class="cx-section cx-chart-startfrom" aria-label={t("chart.startFrom")}>
      <SectionLabel>{t("chart.startFrom")}</SectionLabel>
      <div class="cx-chart-chips" role="group" aria-label={t("chart.startFrom")}>
        {START_PRESETS.map((preset) => {
          const on = presetMatches(spec, preset);
          return (
            <button key={preset.id} type="button" class={`cx-chart-chip cx-chart-preset${on ? " is-on" : ""}`} aria-pressed={on} title={presetSummary(preset)} onClick={() => start(preset)}>
              {t(presetCopy(preset))}
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** The words under the axes: the dated span the charts cover ("Charts cover 1 Jan 2019 to 4 Nov 2026."), or the whole record when no period is set. */
export function windowSentence(period: readonly [number, number] | null, format: DateFormat = "d MMM yyyy"): string {
  if (!period || !Number.isFinite(period[0]) || !Number.isFinite(period[1])) return t("chart.windowWhole");
  // The period's end is exclusive (midnight after the last day).
  return t("chart.windowSentence", { from: fmtDate(period[0], format), to: fmtDate(Math.max(period[0], period[1] - 1), format) });
}

export function ChartWindowSentence(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const period = leaf.store.slices.ui.value.period;
  return (
    <p class="cx-chart-window" data-testid="chart-window">
      {windowSentence(period, s.settings.value.general.dateFormat)}
    </p>
  );
}

/** What a dimension drop or pick does to the spec, shared by the Axes rows and the Colour row. */
export function useZoneControls(spec: ChartSpec, setSpec: (next: ChartSpec) => void) {
  const s = useServices();
  const shell = useShell();
  const settings = s.settings.value;
  const place = (zone: Zone, dim: DimId) => {
    const ch = assignZone(spec, zone, dim);
    setSpec(ch.spec);
    if (ch.moved) shell.notify(t("chart.zoneFallbackWhy", { zone: zoneName(ch.moved.zone), dim: dimLabel(ch.moved.dim), other: dimLabel(dim) }));
    else shell.announce(t("chart.zoneFallback", { zone: zoneName(zone), dim: dimLabel(dim) }));
  };
  const pick = (zone: Zone) => (e: MouseEvent) => {
    const current = zone === "x" ? spec.x.dim : zone === "y" ? (spec.y?.dim ?? null) : spec.colour;
    openDimMenu(e.currentTarget as HTMLElement, { app: s.app, settings, current, onPick: (dim) => place(zone, dim) });
  };
  return { place, pick };
}

type ZoneControls = ReturnType<typeof useZoneControls>;

/** One dimension row (label and picker); a drop of a dimension chip lands on it. */
function ZoneRow(p: { zone: Zone; label: string; dim: DimId | null; controls: ZoneControls }): JSX.Element {
  const { zone, label, dim, controls } = p;
  return (
    <div class="cx-chart-zone" data-zone={zone}>
      <span class="cx-row-label">{label}</span>
      <button
        type="button"
        class="cx-select"
        aria-haspopup="menu"
        aria-label={`${label}: ${dim ? dimLabel(dim) : t("chart.noFilter")}`}
        onClick={controls.pick(zone)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const d = e.dataTransfer?.getData(DIM_MIME);
          if (d) controls.place(zone, d as DimId);
        }}
      >
        <span class="cx-select-value">{dim ? dimLabel(dim) : t("chart.noFilter")}</span>
        <span class="cx-select-caret" aria-hidden="true" />
      </button>
    </div>
  );
}

/** The Colour row with the colour key under it (the first block of What shows). */
export function ChartColourRow(p: { spec: ChartSpec; setSpec(next: ChartSpec): void }): JSX.Element {
  const controls = useZoneControls(p.spec, p.setSpec);
  return (
    <>
      <ZoneRow zone="colour" label={t("chart.colour")} dim={p.spec.colour} controls={controls} />
      <ChartColourKey dim={p.spec.colour} />
    </>
  );
}

/** Start from presets and the dimension chips that drag onto the stage's drop zones (the section the page keeps collapsed). */
export function ChartFieldsList(p: { spec: ChartSpec; setSpec(next: ChartSpec): void }): JSX.Element {
  const s = useServices();
  const dims = flatDimItems(dimMenuModel(enabledPacks(s.settings.value)));
  return (
    <>
      <StartFromRow spec={p.spec} setSpec={p.setSpec} />
      <section class="cx-section" aria-label={t("chart.fields")}>
        <SectionLabel>{t("chart.fields")}</SectionLabel>
        <div class="cx-chart-chips" role="list">
          {dims.map((d) => (
            <span
              key={d.value}
              role="listitem"
              class="cx-chart-chip"
              draggable
              onDragStart={(e) => {
                e.dataTransfer?.setData(DIM_MIME, d.value);
                e.dataTransfer?.setData("text/plain", d.label);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
              }}
            >
              {d.label}
            </span>
          ))}
        </div>
      </section>
    </>
  );
}

/** The Axes section: the horizontal and vertical rows with their Order, the swap link and the dated span the charts cover. */
export function ChartAxesSection(p: { spec: ChartSpec; setSpec(next: ChartSpec): void }): JSX.Element {
  const { spec, setSpec } = p;
  const roles = axisRolesFor(spec.chart);
  const controls = useZoneControls(spec, setSpec);
  const rows: { zone: "x" | "y"; label: string; dim: DimId | null }[] = [
    { zone: "x", label: roleLabel(roles.x), dim: spec.x.dim },
    // An empty vertical row of a time form is not empty on the stage: the worker runs the series along its default dimension.
    ...(roles.y ? [{ zone: "y" as const, label: roleLabel(roles.y), dim: spec.y?.dim ?? DEFAULT_SERIES[spec.chart] ?? null }] : []),
  ];
  return (
    <section class="cx-section cx-chart-axes" aria-label={t("chart.axes")}>
      <SectionLabel>{t("chart.axes")}</SectionLabel>
      <div class="cx-chart-zones">
        {rows.map(({ zone, label, dim }) => {
          const axis = zone === "x" ? spec.x : spec.y;
          return (
            <Fragment key={zone}>
              <ZoneRow zone={zone} label={label} dim={dim} controls={controls} />
              {axis ? (
                <div class="cx-chart-zone is-order" data-zone={`${zone}-order`}>
                  <span class="cx-row-label">{t("chart.order")}</span>
                  <Select<ChartSpec["x"]["sort"]>
                    bare
                    label={`${label} · ${t("chart.order")}`}
                    value={axis.sort}
                    options={ORDER_CHOICES.map((o) => ({ value: o, label: t(ORDER_COPY[o]) }))}
                    onChange={(order) => setSpec(withAxisOrder(spec, zone, order))}
                  />
                </div>
              ) : null}
            </Fragment>
          );
        })}
      </div>
      {roles.y && spec.y ? (
        <button type="button" class="cx-chart-swap" title={t("chart.swap")} onClick={() => setSpec(swapAxes(spec))}>
          {t("chart.swapNamed", { a: roleLabel(roles.x).toLowerCase(), b: roleLabel(roles.y).toLowerCase() })}
        </button>
      ) : null}
      <ChartWindowSentence />
    </section>
  );
}
