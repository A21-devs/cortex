/**
 * The chart's colour key: a wrapped inline list of a dot and a name for each value of the Colour field, capped at 24
 * with "+N". The dots are the stage key's own colours when that key is showing this dimension; otherwise the page asks
 * the worker how the dimension would be coloured (the same call the figure's key uses), so the key never invents a hue.
 */
import type { JSX } from "preact";
import type { DimId } from "../../../shared/dims";
import { capKey, type KeyDot } from "../../../shared/chartAxes";
import { rgbCss } from "../../../shared/palette";
import { visibilityParams } from "../../../state/selectors";
import { useLeaf, useServices, useShell } from "../../context";
import { t } from "../../copy";
import { loaded, useLoad } from "../PageFrame";
import { legendDots } from "./chartPanel";

export function ChartColourKey(p: { dim: DimId | null }): JSX.Element | null {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const store = leaf.store;
  const dim = p.dim;
  const onStage = dim ? legendDots(store.slices.legend.value, dim) : null;
  const idx = s.index.index.value;
  const asked = useLoad<KeyDot[]>(
    async (signal) => {
      if (!dim || onStage || !idx) return [];
      const settings = s.settings.value;
      const dark = !!shell.root?.ownerDocument.body.classList.contains("theme-dark");
      const mode = { kind: "categorical", dim } as const;
      const res = await s.worker.call(
        `${leaf.viewId}#colourkey`,
        "grouping",
        {
          notes: mode,
          record: mode,
          fold: store.get("view").colour.fold,
          hideNoValue: false,
          hiddenGroups: [],
          merges: {},
          palette: settings.appearance.palette,
          light: !dark,
          slots: s.colours.current(),
          visibility: visibilityParams(store.get("ui"), store.get("view")),
        },
        { signal },
      );
      const section = res.legend.sections[0];
      return section ? section.rows.filter((r) => r.depth === 0 && !r.aggregate).map((r) => ({ key: r.key, name: r.name, rgb: r.rgb })) : [];
    },
    [dim, onStage !== null, idx],
  );
  if (!dim) return null;
  const dots = onStage ?? loaded(asked) ?? [];
  if (dots.length === 0) return null;
  const { shown, more } = capKey(dots);
  return (
    <ul class="cx-chart-key" aria-label={t("chart.colourKey")}>
      {shown.map((d) => (
        <li key={d.key} class="cx-chart-key-item">
          <span class="cx-chart-key-dot" style={{ background: rgbCss(d.rgb) }} aria-hidden="true" />
          <span>{d.name}</span>
        </li>
      ))}
      {more > 0 ? <li class="cx-chart-key-more">{t("chart.colourKeyMore", { n: more })}</li> : null}
    </ul>
  );
}
