/**
 * The Chart page with Groups chosen: one place for the grouped figure's controls, which also live on the shape bar and
 * the key menu (they share the same state, so a change here shows there).
 *  - Form: the morph slider, the order at the core, "Group the record separately" (and its record select), "Hide items
 *    without a value";
 *  - Layout and grouping: Group by and Layout.
 */
import type { JSX } from "preact";
import { GROUP_LAYOUTS, type DimId, type GroupLayout } from "../../../shared/dims";
import { setGroupBy, setGroupByRecord, setMorph, setSplitGroups, setView } from "../../../state/actions";
import type { CortexStore } from "../../../state/store";
import { isReducedMotion, useLeaf, useServices, useShell } from "../../context";
import { t } from "../../copy";
import { SectionLabel } from "../../primitives/buttons";
import { Select, Slider, Toggle } from "../../primitives/controls";
import { openDimMenu } from "../../primitives/dimMenu";
import { cancelMorph, layoutsFor, morphAnimator, morphValueText, snapMorph } from "../../stage/ShapeBar";
import { dimLabel } from "../../valueLabels";

const LAYOUT_COPY = {
  bubbles: "shape.bubbles",
  tree: "shape.tree",
  spine: "shape.spine",
  strata: "shape.strata",
  wheel: "shape.wheel",
  grid: "shape.grid",
} as const satisfies Record<GroupLayout, string>;

/** The layouts the Layout select offers for a dimension, in the shape bar's order. */
export function layoutChoices(dim: DimId): GroupLayout[] {
  const allowed = layoutsFor(dim);
  return GROUP_LAYOUTS.filter((l) => allowed.includes(l));
}

/** Choose the dimension that groups the notes; a layout the new dimension does not offer falls back to Bubbles. */
export function chooseGroupBy(store: CortexStore, dim: DimId): void {
  setGroupBy(store, dim);
  if (!layoutsFor(dim).includes(store.get("view").layout)) setView(store, "layout", "bubbles");
}

export function ChartGroupsSection(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const store = leaf.store;
  const v = store.slices.view.value;
  const settings = s.settings.value;
  const reduced = isReducedMotion(settings.appearance.motion, shell.systemReducedMotion.value);
  const animate = morphAnimator(store, shell, () => reduced);
  const pickGroup = (e: MouseEvent) => openDimMenu(e.currentTarget as HTMLElement, { app: s.app, settings, current: v.groupBy, onPick: (dim) => chooseGroupBy(store, dim) });
  const pickRecord = (e: MouseEvent) => openDimMenu(e.currentTarget as HTMLElement, { app: s.app, settings, current: v.groupByRecord ?? v.groupBy, onPick: (dim) => setGroupByRecord(store, dim) });
  const dimButton = (label: string, value: string, onClick: (e: MouseEvent) => void) => (
    <div class="cx-row">
      <span class="cx-row-label">{label}</span>
      <button type="button" class="cx-select" aria-haspopup="menu" aria-label={`${label}: ${value}`} onClick={(e) => onClick(e as unknown as MouseEvent)}>
        <span class="cx-select-value">{value}</span>
        <span class="cx-select-caret" aria-hidden="true" />
      </button>
    </div>
  );
  const layouts = layoutChoices(v.groupBy);
  return (
    <>
      <section class="cx-section" aria-label={t("chart.groupsForm")}>
        <SectionLabel>{t("chart.groupsForm")}</SectionLabel>
        <Slider
          label={t("shape.groups")}
          value={v.morph}
          min={0}
          max={1}
          step={0.01}
          ariaScale={100}
          ticks={[0.25, 0.5, 0.75]}
          format={(m) => morphValueText(m, "groups")}
          valueText={(m) => morphValueText(m, "groups")}
          onInput={(m) => {
            cancelMorph(store);
            setMorph(store, m);
          }}
          onRelease={(m) => {
            const snapped = snapMorph(m);
            if (snapped !== m) animate(snapped, 150);
          }}
        />
        <Select
          label={t("chart.coreOrder")}
          value={v.core}
          options={[
            { value: "oldest", label: t("shape.oldest") },
            { value: "newest", label: t("shape.newest") },
            { value: "largest", label: t("shape.largest") },
          ]}
          onChange={(core) => setView(store, "core", core)}
        />
        {v.layers.record ? <Toggle label={t("chart.splitRecord")} checked={v.splitGroups} onChange={(on) => setSplitGroups(store, on)} /> : null}
        <Toggle label={t("chart.hideNoValue")} checked={v.colour.hideNoValue} onChange={(hideNoValue) => setView(store, "colour", { ...v.colour, hideNoValue })} />
      </section>
      <section class="cx-section" aria-label={t("chart.groupsArrangement")}>
        <SectionLabel>{t("chart.groupsArrangement")}</SectionLabel>
        {dimButton(v.layers.record && v.splitGroups ? t("chart.notesBy") : t("chart.groupBy"), dimLabel(v.groupBy), pickGroup)}
        {v.layers.record && v.splitGroups ? dimButton(t("chart.recordBy"), v.groupByRecord ? dimLabel(v.groupByRecord) : t("chart.sameAsNotes"), pickRecord) : null}
        <Select label={t("shape.layout")} value={v.layout} options={layouts.map((l) => ({ value: l, label: t(LAYOUT_COPY[l]) }))} onChange={(layout) => setView(store, "layout", layout)} />
      </section>
    </>
  );
}
