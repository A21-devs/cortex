/**
 * The Chart page's saved charts (P10): an inline "Name this chart" field with a Save button that stores the leaf's
 * current state (chart, axes, options, scope, period) under that name in the pinned views file, and the list of saved
 * views that carry a chart, each with Apply and Remove. The same views show in Read > Pinned. In the sample record
 * nothing is written to the vault: the views are kept for the session only.
 */
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { PinnedViewService } from "../../../plugin/services";
import type { PinnedViewRecord } from "../../../shared/types";
import { openPage } from "../../../state/actions";
import { captureLeafState, restoreLeafState } from "../../../state/persist";
import type { CortexStore } from "../../../state/store";
import type { CortexSettings } from "../../../shared/settings";
import { useLeaf, useServices, useShell } from "../../context";
import { t } from "../../copy";
import { Button, SectionLabel, TextButton } from "../../primitives/buttons";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether a saved state carries a chart (a chart spec on its view). */
export function hasChart(state: unknown): boolean {
  if (!isRecord(state) || !isRecord(state.view)) return false;
  const chart = state.view.chart;
  return isRecord(chart) && typeof chart.chart === "string";
}

/** The saved views that carry a chart, in the order given (newest first from the service). */
export function savedCharts(rows: readonly PinnedViewRecord[]): PinnedViewRecord[] {
  return rows.filter((r) => hasChart(r.state));
}

/** A name that can be saved: not blank once whitespace is collapsed. */
export function saveableName(name: string): string | null {
  const n = name.replace(/\s+/g, " ").trim();
  return n === "" ? null : n;
}

/** Save the leaf's current state under `name`; resolves to the saved record, or null when the name is blank. */
export async function saveChartAs(svc: Pick<PinnedViewService, "save">, store: CortexStore, name: string): Promise<PinnedViewRecord | null> {
  const clean = saveableName(name);
  if (clean === null) return null;
  return svc.save(clean, captureLeafState(store));
}

/** Put a saved chart back on the leaf; the Chart page stays open on it. */
export function applySavedChart(store: CortexStore, rec: PinnedViewRecord, settings: Pick<CortexSettings, "general" | "appearance">): void {
  restoreLeafState(store, rec.state, settings);
  const ui = store.get("ui");
  const top = ui.sheet.stack[ui.sheet.index];
  if (!ui.sheet.open || top?.kind !== "page" || top.route !== "chart") openPage(store, "chart");
}

/** Views kept in memory for the session (the sample record never writes to the vault). */
export function memoryViews(now: () => number = () => Date.now()): PinnedViewService {
  let rows: PinnedViewRecord[] = [];
  let n = 0;
  return {
    list: async () => [...rows],
    get: async (id) => rows.find((r) => r.id === id),
    async save(name, state) {
      const key = name.toLowerCase();
      const state_ = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
      const at = new Date(now()).toISOString();
      const old = rows.find((r) => r.name.toLowerCase() === key);
      const rec: PinnedViewRecord = { id: old?.id ?? `v_sample${++n}`, name, state: state_, at };
      rows = [rec, ...rows.filter((r) => r !== old)];
      return rec;
    },
    async remove(id) {
      rows = rows.filter((r) => r.id !== id);
    },
  };
}

const sampleViews = memoryViews();

export function SavedTables(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const svc: PinnedViewService = s.sandbox.value ? sampleViews : s.pinnedViews;
  const [rows, setRows] = useState<PinnedViewRecord[]>([]);
  const [name, setName] = useState("");
  const [failed, setFailed] = useState(false);

  const load = () => svc.list().then((all) => setRows(savedCharts(all)), (e: unknown) => s.log.warn("saved charts failed to load", { error: String(e) }));
  useEffect(() => {
    let live = true;
    svc.list().then(
      (all) => live && setRows(savedCharts(all)),
      (e: unknown) => s.log.warn("saved charts failed to load", { error: String(e) }),
    );
    return () => {
      live = false;
    };
  }, [svc]);

  const save = () => {
    setFailed(false);
    saveChartAs(svc, leaf.store, name).then(
      (rec) => {
        if (!rec) return;
        setName("");
        shell.announce(t("chart.savedNotice", { name: rec.name }));
        void load();
      },
      (e: unknown) => {
        s.log.warn("saving a chart failed", { error: String(e) });
        setFailed(true);
      },
    );
  };

  return (
    <section class="cx-section" aria-label={t("chart.savedCharts")}>
      <SectionLabel>{t("chart.savedCharts")}</SectionLabel>
      <div class="cx-chart-save">
        <input
          type="text"
          class="cx-input"
          value={name}
          maxLength={120}
          aria-label={t("chart.nameThisChart")}
          placeholder={t("chart.nameThisChart")}
          onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && saveableName(name) !== null) {
              e.preventDefault();
              save();
            }
          }}
        />
        <Button disabled={saveableName(name) === null} onClick={save}>
          {t("chart.saveChart")}
        </Button>
      </div>
      {failed ? (
        <p class="cx-chart-values-note" role="alert">
          {t("chart.saveFailed")}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p class="cx-chart-values-note">{t("chart.savedEmpty")}</p>
      ) : (
        <ul class="cx-chart-saved">
          {rows.map((r) => (
            <li key={r.id}>
              <span class="cx-chart-value-name" title={r.name}>
                {r.name}
              </span>
              <span class="cx-chart-saved-actions">
                <TextButton onClick={() => applySavedChart(leaf.store, r, s.settings.value)}>{t("chart.applySaved")}</TextButton>
                <TextButton
                  onClick={() =>
                    void svc.remove(r.id).then(load, (e: unknown) => s.log.warn("removing a saved chart failed", { error: String(e) }))
                  }
                >
                  {t("chart.removeSaved")}
                </TextButton>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
