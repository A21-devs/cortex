/**
 * The top of the Chart page: the Groups | Chart switch, the Keep upright camera limit (on offer whenever the page is
 * open, not only when a flat chart forces it) and, once per session, the one-click "Colour by area" offer. Owner: P09.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { setMotion } from "../../../state/actions";
import { isReducedMotion, useLeaf, useServices, useShell, type Shell } from "../../context";
import { t } from "../../copy";
import { dismissChartAreaOffer } from "../../deviceState";
import { TextButton } from "../../primitives/buttons";
import { Segmented, Toggle } from "../../primitives/controls";
import { morphAnimator } from "../../stage/ShapeBar";
import { applyAreaColour, arrangementOf, chooseArrangement, offersAreaColour, type Arrangement } from "./chartPanel";

const offered = new WeakSet<Shell>();

export function ChartPanelHeader(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const store = leaf.store;
  const v = store.slices.view.value;
  const reduced = isReducedMotion(s.settings.value.appearance.motion, shell.systemReducedMotion.value);
  const animate = morphAnimator(store, shell, () => reduced);
  // The offer belongs to the first time the page opens in a session; it stays while this page is open.
  const [offer] = useState(() => {
    if (offered.has(shell)) return false;
    offered.add(shell);
    return true;
  });
  const dismissed = s.device.value.chartAreaOfferDismissed === true;
  const showOffer = offer && offersAreaColour(v.colour.notes, dismissed);
  const arrangement = arrangementOf(v.shape);
  return (
    <div class="cx-chart-head">
      <div class="cx-row">
        <span class="cx-row-label">{t("chart.drawAs")}</span>
        <Segmented<Arrangement>
          label={t("chart.drawAs")}
          value={arrangement}
          options={[
            { value: "groups", label: t("shape.groups") },
            { value: "chart", label: t("shape.chart") },
          ]}
          onChange={(to) => chooseArrangement(store, to, animate)}
        />
      </div>
      <Toggle label={t("chart.keepUpright")} checked={v.motion.keepUpright} hint={t("chart.keepUprightNote")} onChange={(keepUpright) => setMotion(store, { keepUpright })} />
      {showOffer ? (
        <div class="cx-chart-offer" role="group" aria-label={t("chart.byAreaOffer")}>
          <button
            type="button"
            class="cx-chart-chip is-offer"
            title={t("chart.byAreaOfferNote")}
            onClick={() => {
              applyAreaColour(store);
              s.device.update(dismissChartAreaOffer);
            }}
          >
            {t("chart.byAreaOffer")}
          </button>
          <TextButton onClick={() => s.device.update(dismissChartAreaOffer)}>{t("chart.byAreaDismiss")}</TextButton>
        </div>
      ) : null}
    </div>
  );
}
