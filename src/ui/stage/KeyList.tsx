/**
 * Legend list (Cortex Desktop): the key as a compact vertical list at the stage's bottom left, replacing the key
 * bar's horizontal chips. Per section a small-caps heading (the section's name and colouring; one click opens the
 * same dimension menu as the key bar's picker), then one row per top-level group: dot, name, count. A click selects
 * the group (a second click clears), the eye hides it, right-click opens the chip menu, Shift + click traces. The
 * footer "All groups…" expands the list IN PLACE into a scrollable multi-column grid across the stage's foot ("Fewer"
 * folds it back) and the figure steps up to make room; a small key icon beside Layers opens the key popover (filter,
 * per-group switches, single colour). An age key shows its ramp. Layers sits at the heading's right end. Owner: shell track.
 *
 * The heading carries the key's total at its right ("N matching" while the figure is narrowed to a lit set; the counts
 * recount inside an area while the rail wordmark's lens holds one). A section that holds both layers prints two figures
 * per row under a "notes · record" caption. Notes sections: the chosen row is a filled pill, the others sit at 40% in
 * normal type, and an Area or Folder row lists its subfolders under it. Record-by sections: a click shows or hides the
 * group, Shift + click keeps only it. Under the list: the three help lines (the Usage tips switch) and a standing
 * "Show every group" button. "Hide unsorted" draws the no-value row struck.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { LegendChild, LegendModel, LegendRow, LegendSection } from "../../shared/protocol/worker";
import { rgbCss } from "../../shared/palette";
import { openPopover, setDimPreview, showAllGroups, soloGroup, toggleGroup } from "../../state/actions";
import { chartCardAside, SHELL, sheetFloats, stageBox } from "../breakpoints";
import { num, useLeaf, useServices, useShell } from "../context";
import { t } from "../copy";
import { keyTipsShown } from "../deviceState";
import { Icon } from "../primitives/buttons";
import { openDimMenu } from "../primitives/dimMenu";
import { AgeKey, anyHidden, applyKeyOption, chipCount, chipMenu, groupKey, keyOptionItems, lensCounts, lensRows, modeLabel, pickColourDim, placeholderSections, populationLabel, rowCount, rowName, sectionMode, selectedRow, traceGroup } from "./KeyBar";
import { OpenBadge } from "./KeyConsent";
import { openLayersMenu } from "./LayersMenu";
import { childRowsFor, soloScope } from "./KeyPopover";

/** Rows shown per section before the footer: fewer when two sections share the list or the window is short. */
export function listRows(sections: number, height: number): number {
  const room = Math.floor((height - 330) / 18);
  return Math.max(3, Math.min(sections > 1 ? 6 : 8, room));
}

/** Every group the expanded legend lists: a month tree flattens to its months, anything else to its top-level rows. */
export function gridRows(rows: readonly LegendRow[]): LegendRow[] {
  return rows.some((r) => r.aggregate) ? rows.filter((r) => !r.aggregate) : rows.filter((r) => r.depth === 0);
}

const GRID_COL_W = 190;
const GRID_ROW_H = 18;
const GRID_CHROME_H = 74;
const GRID_EDGE = 16;
const GRID_GAP = 12;

/** The expanded grid's columns, its height, and how far the figure's area must shrink (the grid plus its margins). */
export function gridMetrics(count: number, stageWidth: number, stageHeight: number): { cols: number; height: number; lift: number } {
  const cols = Math.max(1, Math.min(6, Math.floor((stageWidth - 2 * GRID_EDGE) / GRID_COL_W)));
  const wanted = Math.ceil(count / cols) * GRID_ROW_H + GRID_CHROME_H;
  const height = Math.max(GRID_CHROME_H + GRID_ROW_H, Math.min(wanted, Math.floor(stageHeight * 0.42)));
  return { cols, height, lift: height + GRID_EDGE + GRID_GAP };
}

/**
 * The count a key row shows. A section that holds both layers says "notes · entries" while both layers are on
 * (compact above 9,999: "1,880 · 10.0k"); with one layer hidden it names just the other layer's count, and a section
 * of one layer always shows that layer's count.
 */
export function keyRowCount(r: Pick<LegendRow, "notes" | "record">, population: LegendSection["population"], layers: { notes: boolean; record: boolean } = { notes: true, record: true }): string {
  if (population !== "both") return chipCount(rowCount(r, population));
  if (layers.notes && layers.record) return `${chipCount(r.notes)} · ${chipCount(r.record)}`;
  if (layers.notes) return chipCount(r.notes);
  if (layers.record) return chipCount(r.record);
  return chipCount(r.notes + r.record);
}

/** How a click on a row behaves: a Record-by section shows or hides the group, every other section chooses it. */
export function clickBehaviour(sec: Pick<LegendSection, "population" | "dim">): "toggle" | "select" {
  return sec.population === "record" && sec.dim !== "age" && sec.dim !== "single" ? "toggle" : "select";
}

export interface RowLook {
  /** Name struck through, dot hollow, eye shown as off. */
  struck: boolean;
  /** The row sits back (about 40%): another row is chosen, the lens holds another, or a toggled-off group fades. */
  dim: boolean;
}

/**
 * How a row reads. With a row chosen the others only fade (their groups are hidden by the choice, not struck); a group
 * the reader hid, and the no-value row while Hide unsorted is on, are struck. `selected` is null in a toggling section.
 */
export function rowLook(r: Pick<LegendRow, "key" | "hidden" | "dropped">, behaviour: "toggle" | "select", selected: string | null, lensKey: string | null = null): RowLook {
  const other = selected !== null && selected !== r.key;
  const struck = r.dropped === true || (r.hidden && !other);
  const lensDim = lensKey !== null && r.key !== lensKey;
  return { struck, dim: other || lensDim || (behaviour === "toggle" && r.hidden) };
}

/** The heading's total: the lens's own while an area holds the key, "N matching" while lit, else the whole key. */
export function keyTotalLabel(legend: Pick<LegendModel, "grandTotal" | "lit">, lens: LegendModel | null): string {
  if (lens) return chipCount(lens.grandTotal);
  return legend.lit !== undefined ? t("key.matching", { n: chipCount(legend.lit) }) : chipCount(legend.grandTotal);
}

/** The footer under a section's list: what is left out ("{n} more") or, when everything shows, the full count. */
export function listFooter(total: number, shown: number): string {
  return shown < total ? t("key.moreN", { n: num(total - shown) }) : t("key.allN", { n: num(total) });
}

/** The count of a subfolder row; the direct row (members that sit in no subfolder) counts like the group itself. */
export function childCount(c: LegendChild, population: LegendSection["population"], layers: { notes: boolean; record: boolean }): string {
  return keyRowCount(c, population, layers);
}

export function KeyList(): JSX.Element | null {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const store = leaf.store;
  const ui = store.slices.ui.value;
  const view = store.slices.view.value;
  const legend = store.slices.legend.value ?? placeholderSections();
  const loading = store.slices.legend.value === null;
  // The rail wordmark's lens holds an area: the rows recount inside it (the worker's second, colour-free grouping).
  const lensSlice = store.slices.lens.value;
  const lensLegend = lensSlice !== null && ui.preview?.kind === "area" && ui.preview.key === lensSlice.area ? lensSlice.legend : null;
  const tips = keyTipsShown(s.device.value);
  // Year rows of a month tree the reader has opened here ("population|year"); the list opens with every year closed.
  const [openYears, setOpenYears] = useState<ReadonlySet<string>>(new Set());
  // The section opened into the grid (by index), or null while the list is compact.
  const [grid, setGrid] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const height = shell.size.value.height || SHELL.figure.reference.height;
  const sections = legend.sections;
  const gridSec = grid !== null ? sections[grid] : undefined;
  const gridList = gridSec ? gridRows(gridSec.rows) : [];
  const metrics = gridSec ? gridMetrics(gridList.length, stageBox(shell.size.value, ui).width || 900, height) : null;
  const lift = metrics ? metrics.lift : 0;
  // The figure's area gives the grid its room: the stage reports it to the canvas host, which refits upward.
  useEffect(() => {
    const stage = rootRef.current?.closest(".cx-stage") as HTMLElement | null;
    if (!stage || lift <= 0) return undefined;
    stage.style.setProperty("--cx-legend-lift", `${lift}px`);
    stage.classList.add("has-legend-grid");
    return () => {
      stage.style.removeProperty("--cx-legend-lift");
      stage.classList.remove("has-legend-grid");
    };
  }, [lift]);
  // A grid whose section vanished (the colouring changed to an age key, the index emptied) folds back.
  useEffect(() => {
    if (grid !== null && !gridSec) setGrid(null);
  }, [grid, gridSec]);
  // The Chart card sits over the legend's corner (floating, or beside a page): the legend steps away while it is open,
  // so nothing of it, not even the foot button, shows under or below the card.
  if (sheetFloats(ui) || chartCardAside(ui)) return null;
  if (sections.length === 0 && !loading) return null;
  const max = listRows(sections.length, height);
  return (
    <div ref={rootRef} class={`cx-keylist${metrics ? " is-grid" : ""}`} style={metrics ? { "--cx-grid-cols": String(metrics.cols), "--cx-grid-h": `${metrics.height}px` } : undefined} role="group" aria-label={t("key.label")} data-cx-overlay="key">
      {loading && sections.length === 0 ? <p class="cx-keylist-empty">{t("app.loading")}</p> : null}
      {sections.map((sec, si) => {
        if (grid !== null && si !== grid) return null;
        const mode = sectionMode(view, sec);
        const isAge = mode.kind === "age" || sec.dim === "age";
        const dim = String(sec.dim);
        // The rail wordmark's lens on an area key: the previewed area leads, the rest sit back.
        const lensed = lensRows(
          sec.rows.filter((r) => r.depth === 0),
          dim,
          ui.preview,
        );
        const top = lensed.rows;
        const behaviour = clickBehaviour(sec);
        // A Record-by section toggles groups, so a lone visible group there is not a "chosen" row.
        const selected = behaviour === "select" ? (selectedRow(sec.rows)?.key ?? null) : null;
        const base = top.slice(0, max);
        const shown = selected !== null && !base.some((r) => r.key === selected) ? [...base.slice(0, Math.max(0, max - 1)), ...top.filter((r) => r.key === selected)] : base;
        const total = Math.max(top.length, gridRows(sec.rows).length);
        const twoFigures = sec.population === "both" && view.layers.notes && view.layers.record;
        // Plain click and Shift + click: chosen / traced in a notes section, shown or hidden / kept alone in a Record-by one.
        const choose = (e: { shiftKey: boolean }, r: LegendRow) => {
          const key = groupKey(dim, r.key);
          const scope = soloScope(sec.rows, r).map((k) => groupKey(dim, k));
          if (behaviour === "toggle") {
            if (e.shiftKey) soloGroup(store, key, scope);
            else toggleGroup(store, key);
          } else if (e.shiftKey) traceGroup(store, dim, r);
          else soloGroup(store, key, scope);
        };
        const hint = t(behaviour === "toggle" ? "key.toggleHint" : "key.chipHint");
        const anyExpandable = shown.some((r) => r.expandable);
        const last = si === sections.length - 1;
        const pick = (e: MouseEvent) =>
          openDimMenu(e.currentTarget as HTMLElement, {
            app: s.app,
            settings: s.settings.value,
            current: mode.kind === "categorical" ? mode.dim : null,
            onPick: (d) => pickColourDim(store, sec.population, d),
            extras: keyOptionItems(view.colour, sec.population, mode, view.syncKeyToGroups),
            onExtra: (x) => applyKeyOption(store, sec.population, x),
            onHover: (d) => setDimPreview(store, d, sec.population === "both" || view.colour.same ? "both" : sec.population),
          });
        return (
          <div key={`${sec.population}-${si}`} class="cx-keylist-section" data-population={sec.population}>
            <div class="cx-keylist-headrow">
              <button type="button" class="cx-keylist-head" aria-haspopup="menu" aria-label={`${populationLabel(sec.population)}: ${modeLabel(mode, sec.dim)}`} onClick={(e) => pick(e as unknown as MouseEvent)}>
                <span>{sections.length > 1 ? `${populationLabel(sec.population)} · ${modeLabel(mode, sec.dim)}` : modeLabel(mode, sec.dim)}</span>
                <Icon name="chevron" class="cx-select-caret-icon" />
              </button>
              <span class="cx-keylist-tools">
                {si === 0 && !loading && !isAge ? (
                  <span class="cx-keylist-sum" title={t("key.total", { n: num(lensLegend ? lensLegend.grandTotal : legend.grandTotal) })} data-testid="key-total">
                    {keyTotalLabel(legend, lensLegend)}
                  </span>
                ) : null}
                {!isAge && top.length > 0 ? (
                  <button type="button" class="cx-keylist-layers" data-cx-popover-toggle="key" aria-haspopup="dialog" title={t("key.keyOptions")} aria-label={t("key.keyOptions")} onClick={() => openPopover(store, "key")}>
                    <Icon name="key" />
                  </button>
                ) : null}
                {last || grid !== null ? (
                  <button type="button" class="cx-keylist-layers" aria-haspopup="menu" title={t("key.layers")} aria-label={t("key.layers")} onClick={(e) => openLayersMenu(s, leaf, e.currentTarget as HTMLElement)}>
                    <Icon name="layers" />
                  </button>
                ) : null}
              </span>
            </div>
            {twoFigures && !isAge && top.length > 0 ? <p class="cx-keylist-cols">{t("key.columns")}</p> : null}
            {grid === si && !isAge ? (
              <ul class="cx-keylist-grid" aria-label={populationLabel(sec.population)}>
                {gridList.map((r) => {
                  const name = rowName(r, dim);
                  const isSel = selected === r.key;
                  const look = rowLook(r, behaviour, selected);
                  const none = r.bucket === "none" || look.struck;
                  const tip = t("key.chipTip", { group: name, notes: num(r.notes), entries: num(r.record) });
                  return (
                    <li key={r.key} class={`cx-keylist-row${isSel ? " is-selected" : ""}${look.struck ? " is-hidden" : ""}${look.dim ? " is-dim" : ""}`}>
                      <button
                        type="button"
                        class="cx-keylist-item"
                        aria-pressed={isSel}
                        aria-label={tip}
                        title={`${tip}
${hint}`}
                        onClick={(e) => choose(e, r)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          chipMenu(s, leaf, shell, sec, r, top, { x: e.clientX, y: e.clientY }, e.currentTarget as HTMLElement);
                        }}
                        onPointerEnter={() => store.update("ui", { preview: { kind: "group", key: groupKey(dim, r.key) } })}
                        onPointerLeave={() => store.update("ui", { preview: null })}
                      >
                        <span class={`cx-key-dot${none ? " is-hollow" : ""}`} style={none ? { borderColor: rgbCss(r.rgb) } : { background: rgbCss(r.rgb) }} />
                        <span class="cx-keylist-name">{name}</span>
                        <OpenBadge dim={dim} rowKey={r.key} quiet />
                        <span class="cx-keylist-count">{keyRowCount(lensCounts(lensLegend, sec, r), sec.population, view.layers)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : isAge ? (
              <AgeKey sec={sec} />
            ) : top.length === 0 ? (
              <p class="cx-keylist-empty">{loading ? t("app.loading") : t("key.nothing")}</p>
            ) : (
              <ul class="cx-keylist-rows">
                {shown.flatMap((top1: LegendRow) => {
                  const yearKey = `${sec.population}|${top1.key}`;
                  const isOpen = top1.expandable && openYears.has(yearKey);
                  const kids = isOpen ? sec.rows.filter((c) => c.parentKey === top1.key) : [];
                  const subs = childRowsFor(sec, top1, selected);
                  const rowsOut = [top1, ...kids].map((r: LegendRow) => {
                    const name = rowName(r, dim);
                    const isSel = selected === r.key;
                    const look = rowLook(r, behaviour, selected, lensed.key);
                    const none = r.bucket === "none" || look.struck;
                    const tip = t("key.chipTip", { group: name, notes: num(r.notes), entries: num(r.record) });
                    const child = r !== top1;
                    return (
                      <li key={r.key} class={`cx-keylist-row${isSel ? " is-selected" : ""}${look.struck ? " is-hidden" : ""}${look.dim ? " is-dim" : ""}${lensed.key === r.key ? " is-lens" : ""}${child ? " is-child" : ""}`}>
                        {r.expandable && !child ? (
                          <button
                            type="button"
                            class={`cx-disclosure${isOpen ? " is-open" : ""}`}
                            aria-expanded={isOpen}
                            aria-label={t(isOpen ? "key.collapseGroup" : "key.expandGroup", { name })}
                            onClick={() => {
                              const next = new Set(openYears);
                              if (isOpen) next.delete(yearKey);
                              else next.add(yearKey);
                              setOpenYears(next);
                            }}
                          />
                        ) : anyExpandable || child ? (
                          <span class="cx-disclosure-space" aria-hidden="true" />
                        ) : null}
                        <button
                          type="button"
                          class="cx-keylist-item"
                          aria-pressed={isSel}
                          aria-label={tip}
                          title={`${tip}
${hint}`}
                          onClick={(e) => choose(e, r)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            chipMenu(s, leaf, shell, sec, r, top, { x: e.clientX, y: e.clientY }, e.currentTarget as HTMLElement);
                          }}
                          onPointerEnter={() => store.update("ui", { preview: { kind: "group", key: groupKey(dim, r.key) } })}
                          onPointerLeave={() => store.update("ui", { preview: null })}
                        >
                          <span class={`cx-key-dot${none ? " is-hollow" : ""}`} style={none ? { borderColor: rgbCss(r.rgb) } : { background: rgbCss(r.rgb) }} />
                          <span class="cx-keylist-name">{name}</span>
                        <OpenBadge dim={dim} rowKey={r.key} quiet />
                          <span class="cx-keylist-count">{keyRowCount(lensCounts(lensLegend, sec, r), sec.population, view.layers)}</span>
                        </button>
                        <button
                          type="button"
                          class="cx-keylist-eye"
                          tabIndex={-1}
                          aria-label={r.dropped ? t("key.unsortedTip") : t(r.hidden ? "key.showGroup" : "key.hideGroup", { name })}
                          title={r.dropped ? t("key.unsortedTip") : t(r.hidden ? "key.showGroup" : "key.hideGroup", { name })}
                          onClick={() => (r.dropped ? applyKeyOption(store, sec.population, "key:hideNoValue") : toggleGroup(store, groupKey(dim, r.key)))}
                        >
                          <Icon name={look.struck ? "eyeOff" : "eye"} />
                        </button>
                      </li>
                    );
                  });
                  // The chosen Area or Folder row opens its subfolders under it: largest first, the direct members leading.
                  const subRows = subs.map((c) => (
                    <li key={`${top1.key}>${c.key}`} class="cx-keylist-row cx-keylist-sub" aria-label={t("key.subfolders", { name: rowName(top1, dim) })}>
                      <span class="cx-keylist-name">{c.direct ? rowName(top1, dim) : c.name}</span>
                      <span class="cx-keylist-count">{childCount(c, sec.population, view.layers)}</span>
                    </li>
                  ));
                  return [...rowsOut, ...subRows];
                })}
              </ul>
            )}
            {grid === si ? (
              <button type="button" class="cx-keylist-all" aria-expanded="true" onClick={() => setGrid(null)}>
                {t("key.fewer")}
              </button>
            ) : !isAge && top.length > 0 ? (
              <button type="button" class="cx-keylist-all" aria-expanded="false" onClick={() => setGrid(si)}>
                {listFooter(total, shown.length)}
              </button>
            ) : null}
          </div>
        );
      })}
      {tips && grid === null && view.shape !== "chart" && sections.length > 0 ? (
        <div class="cx-keylist-help" role="note">
          <p>{t("key.tipPoint")}</p>
          <p>{t("key.tipDrag")}</p>
          <p>
            <strong>{t("key.helpSpine")}</strong>
            {` · ${t(view.spineOrder === "newest-at-brain" ? "key.helpSpineNewest" : "key.helpSpineOldest")}`}
          </p>
        </div>
      ) : null}
      {grid === null && sections.length > 0 ? (
        <button
          type="button"
          class={`cx-keylist-showall${anyHidden(ui.hiddenGroups) ? "" : " is-idle"}`}
          aria-disabled={!anyHidden(ui.hiddenGroups)}
          onClick={() => {
            if (anyHidden(ui.hiddenGroups)) showAllGroups(store);
          }}
        >
          {t("key.showEvery")}
        </button>
      ) : null}
    </div>
  );
}
