/**
 * Key bar (CORTEX-UX §5.3): two rows in one glass bar at the stage's top left (left 16, top 12), at most 44% of
 * the stage wide so the standing figure's brain clears it.
 *  Brain row: "Brain", the colour picker (dimension menu by provenance + key options; default Area), one chip per
 *    coloured group in slot order (dot, name, note count, compact above 9,999) and a final "+‹n›" chip for the
 *    chips that do not fit (opens the key popover); Other is one chip, No area a hollow slate dot.
 *  Spine row: "Spine", the picker (default Age); with Age: the earliest month, the age ramp, "today", a divider and
 *    "Undated ‹n›"; with a categorical dimension, chips as above. At its right end the Layers ▾ button.
 *  "Same colour for both" merges the rows into "Everything by [Area ▾]". A chevron collapses the bar to "Brain by
 *    Area · Spine by Age" (stored per leaf). One row below 640 px of height; at M a single "Key" button.
 * Chips: hover 150 ms previews (+40%); a click SELECTS the group (a lighter pill, the siblings at 40%, the figure shows
 * only it) and a second click clears it; the eye on a chip, H and the menu hide or show it; Shift + click traces (a
 * token); "Show every group" ends the chips while anything is hidden. Right-click → Trace · Show only this · Hide ·
 * Show in Read · Merge with… (the GLOBAL merge-groups fix, P1, L8). The picker's menu previews a dimension on hover.
 * Keyboard: one toolbar, ←/→ move, Space selects, H hides, Alt + Space solos, Enter traces. Before the index is ready
 * the chips show grey dots and "–". Owner: E11.
 */
import type { JSX } from "preact";
import { useRef } from "preact/hooks";
import type { CortexServices, LeafServices } from "../../plugin/services";
import { dateDim, noneNameOf, parseDateDim, type DimId } from "../../shared/dims";
import { featureOn } from "../../shared/features";
import { rgbCss } from "../../shared/palette";
import type { ColourMode, LegendModel, LegendRow, LegendSection } from "../../shared/protocol/worker";
import { addToken, openPage, openPopover, setColourMode, setDimPreview, setSyncKeyToGroups, setView, showAllGroups, soloGroup, toggleGroup, toggleKeyCollapsed } from "../../state/actions";
import type { CortexStore } from "../../state/store";
import { keyBarMaxWidth, keyRows, SHELL, stageBox } from "../breakpoints";
import { num, pendingCopy, useLeaf, useServices, useShell, type Shell } from "../context";
import { t, type CopyKey } from "../copy";
import { dimLabel } from "../valueLabels";
import { Icon, IconButton } from "../primitives/buttons";
import { rovingKeyDown, useRoving } from "../primitives/controls";
import { openDimMenu } from "../primitives/dimMenu";
import { showMenu, type MenuItemSpec } from "../primitives/menu";
import { openLayersMenu } from "./LayersMenu";

/** Room kept for the grand total ("12.4k items") beside the collapse button. */
export const KEY_TOTAL_W = 64;

/** Room kept for the "Show every group" chip at the end of the chips while anything is hidden or isolated. */
export const SHOW_ALL_W = 104;

/** Note count as shown on a chip (compact above 9,999: "28.4k"). */
export function chipCount(n: number): string {
  return n > 9999 ? `${(n / 1000).toFixed(1)}k` : num(n);
}

/** The hidden-group key of a legend row ("dim=value"). */
export function groupKey(dim: string, key: string): string {
  return `${dim}=${key}`;
}

/** The one visible row of a set of rows (the others hidden): the isolated, selected group. Null with fewer than two rows. */
export function isolatedRow(scope: readonly LegendRow[]): LegendRow | null {
  if (scope.length < 2) return null;
  const on = scope.filter((r) => !r.hidden);
  return on.length === 1 ? (on[0] as LegendRow) : null;
}

/**
 * The rail wordmark's lens on an area key: while an area is previewed and the row lists areas, that area's chip leads
 * the row (the rest keep their order and sit back). Other keys and other previews leave the rows alone.
 */
export function lensRows(rows: readonly LegendRow[], dim: string, preview: { kind: string; key: string } | null): { rows: LegendRow[]; key: string | null } {
  if (dim !== "space" || !preview || preview.kind !== "area") return { rows: rows.slice(), key: null };
  const at = rows.findIndex((r) => r.key === preview.key);
  if (at < 0) return { rows: rows.slice(), key: null };
  const out = rows.slice();
  out.unshift(...out.splice(at, 1));
  return { rows: out, key: preview.key };
}

/** The counts a row shows while the rail wordmark's lens holds an area: the lens legend's own, zero where the area has none of it. */
export function lensCounts(lens: LegendModel | null, sec: Pick<LegendSection, "population" | "dim">, r: Pick<LegendRow, "key" | "notes" | "record">): Pick<LegendRow, "notes" | "record"> {
  if (!lens) return r;
  const ls = lens.sections.find((x) => x.population === sec.population && x.dim === sec.dim);
  if (!ls) return r;
  const hit = ls.rows.find((x) => x.key === r.key);
  return hit ? { notes: hit.notes, record: hit.record } : { notes: 0, record: 0 };
}

/**
 * The selected group of a section: the one top-level row left showing, or, in a month tree, the one month. The
 * selection is the isolation itself (soloGroup), so it survives re-renders and shows the same in the bar and the popover.
 */
export function selectedRow(rows: readonly LegendRow[]): LegendRow | null {
  const top = isolatedRow(rows.filter((r) => r.depth === 0));
  if (top) return top;
  return rows.some((r) => r.aggregate) ? isolatedRow(rows.filter((r) => !r.aggregate)) : null;
}

/** True when something is hidden or isolated: the key then offers "Show every group". */
export function anyHidden(hiddenGroups: readonly string[]): boolean {
  return hiddenGroups.length > 0;
}

/** The count a chip shows: notes in the Brain row, entries in the Spine row, both when unsplit. */
export function rowCount(r: Pick<LegendRow, "notes" | "record">, population: LegendSection["population"]): number {
  return population === "notes" ? r.notes : population === "record" ? r.record : r.notes + r.record;
}

/** Estimated chip width at 12 px / 11 px mono (deterministic, so overflow does not depend on layout reads). */
export function chipWidth(name: string, count: string): number {
  return 8 + 8 + 6 + Math.ceil(name.length * 6.6) + 6 + Math.ceil(count.length * 6.7) + 9 + SHELL.geometry.keyBar.chipGap;
}

/** How many chips fit in `available` px; the rest collapse into "+n". */
export function fitChips(rows: readonly LegendRow[], population: LegendSection["population"], available: number): { shown: LegendRow[]; more: number } {
  let used = 0;
  const shown: LegendRow[] = [];
  for (const [i, r] of rows.entries()) {
    const w = chipWidth(r.name, chipCount(rowCount(r, population)));
    const reserve = i < rows.length - 1 ? SHELL.geometry.keyBar.moreW : 0;
    if (used + w + reserve > available && shown.length > 0) return { shown, more: rows.length - shown.length };
    used += w;
    shown.push(r);
  }
  return { shown, more: 0 };
}

export function populationLabel(p: LegendSection["population"]): string {
  return p === "record" ? t("key.spine") : p === "notes" ? t("key.brain") : t("key.everything");
}

export function modeLabel(mode: ColourMode | undefined, dim?: LegendSection["dim"]): string {
  if (mode?.kind === "age" || dim === "age") return t("key.age");
  if (mode?.kind === "single" || dim === "single") return t("key.singleColour").replace(/…$/, "");
  return dimLabel((mode?.kind === "categorical" ? mode.dim : dim) as DimId);
}

/** Earliest month for the age key ("Feb 2023"). */
export function monthLabel(ms: number): string {
  if (!Number.isFinite(ms)) return t("app.loading");
  return new Date(ms).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

/** The dimension a row's value belongs to: a year row of the month tree holds years, not months. */
export function rowDimension(dim: string, row: LegendRow): string {
  if (!row.aggregate) return dim;
  const date = parseDateDim(dim as DimId);
  return date ? dateDim("year", date.basis) : dim;
}

export function traceGroup(store: CortexStore, dimension: string, row: LegendRow): void {
  const dim = rowDimension(dimension, row);
  addToken(store, { id: `group:${groupKey(dim, row.key)}`, kind: "group", label: `${dimLabel(dim as DimId)}: ${row.name}`, dim: dim as DimId, value: row.key });
}

/** Show in Read: trace the group and open Read on the matching tab. */
export function showGroupInRead(store: CortexStore, dimension: string, row: LegendRow): void {
  const dim = rowDimension(dimension, row);
  traceGroup(store, dimension, row);
  const tab = dim === "folder" || dim === "folderPath" || dim === "space" ? "folder" : dim === "source" ? "source" : "date";
  openPage(store, "read", { tab, dim, value: row.key });
}

/** Merge with… (the global merge-groups fix): applied at once as your fix, with a toast and Undo. */
export async function mergeGroups(s: CortexServices, shell: Shell, dim: string, from: LegendRow, into: LegendRow): Promise<void> {
  try {
    const c = await s.corrections.apply({ via: "key", action: "merge-groups", target: dim, payload: { dim, from: from.key, into: into.key } });
    shell.toast({
      kind: "change",
      text: t("changes.merged", { a: from.name, b: into.name }),
      undo: async () => {
        await s.corrections.undo(c.id, "key");
      },
    });
  } catch (e) {
    s.log.warn("merge failed", { error: String(e) });
    shell.toast({ kind: "error", text: pendingCopy("mergeFailed"), sticky: true });
  }
}

export function chipMenu(s: CortexServices, leaf: LeafServices, shell: Shell, sec: LegendSection, row: LegendRow, all: readonly LegendRow[], at: { x: number; y: number }, anchor: HTMLElement): void {
  const dim = String(sec.dim);
  const store = leaf.store;
  const key = groupKey(dim, row.key);
  const allKeys = all.map((r) => groupKey(dim, r.key));
  const items: MenuItemSpec[] = [
    { value: "trace", label: t("key.trace") },
    { value: "only", label: t("key.only") },
    { value: "hide", label: row.hidden ? pendingCopy("keyShow") : t("key.hide") },
    { value: "read", label: t("key.showInRead") },
  ];
  const others = all.filter((r) => r.key !== row.key && r.bucket === "value");
  if (featureOn("corrections") && row.bucket === "value" && others.length > 0) {
    items.push({ value: "merge", label: t("key.mergeWith"), group: "merge", submenu: others.map((r) => ({ value: `merge:${r.key}`, label: r.name })) });
  }
  showMenu(
    items,
    anchor,
    (v) => {
      if (v === "trace") traceGroup(store, dim, row);
      else if (v === "only") soloGroup(store, key, allKeys);
      else if (v === "hide") toggleGroup(store, key);
      else if (v === "read") showGroupInRead(store, dim, row);
      else if (v.startsWith("merge:")) {
        const into = others.find((r) => `merge:${r.key}` === v);
        if (into) void mergeGroups(s, shell, dim, row, into);
      }
    },
    { at },
  );
}

/** A legend row's name: the worker leaves the "Other" and "no value" buckets unnamed, so they get their copy here. */
export function rowName(r: LegendRow, dim: string): string {
  if (r.name) return r.name;
  if (r.bucket === "other") return t("dims.other");
  if (r.bucket === "none") {
    const none = noneNameOf(dim as DimId);
    return t(`dims.${none ?? "noLabel"}` as CopyKey);
  }
  return r.name;
}

export function KeyChip(p: { row: LegendRow; dim: string; population: LegendSection["population"]; selected?: boolean; lens?: boolean; onToggle(): void; onSolo(): void; onTrace(): void; onMenu(e: MouseEvent): void; onPreview(on: boolean): void }): JSX.Element {
  const r = p.row;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const name = rowName(r, p.dim);
  const tip = t("key.chipTip", { group: name, notes: num(r.notes), entries: num(r.record) });
  const colour = rgbCss(r.rgb);
  const selected = p.selected === true;
  const cls = ["cx-key-chip", selected ? "is-selected" : "", r.hidden ? "is-hidden" : "", r.bucket === "none" ? "is-none" : "", r.bucket === "other" ? "is-other" : ""].filter(Boolean).join(" ");
  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  // A plain click selects the group (shows only it; clicking it again clears); the eye, H and the menu hide or show it.
  return (
    <span
      class={`cx-key-chipset${selected ? " is-selected" : ""}${p.lens === true ? " is-lens" : ""}${r.hidden ? " is-hidden" : ""}`}
      onPointerEnter={() => {
        clearTimer();
        timer.current = setTimeout(() => p.onPreview(true), SHELL.timing.chipPreviewMs);
      }}
      onPointerLeave={() => {
        clearTimer();
        p.onPreview(false);
      }}
    >
      <button
        type="button"
        data-roving=""
        class={cls}
        aria-pressed={selected}
        aria-label={tip}
        title={`${tip}
${t("key.chipHint")}`}
        onClick={(e) => (e.shiftKey ? p.onTrace() : p.onSolo())}
        onContextMenu={(e) => {
          e.preventDefault();
          p.onMenu(e as unknown as MouseEvent);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            p.onTrace();
          } else if (e.key === " " && e.altKey) {
            e.preventDefault();
            p.onSolo();
          } else if ((e.key === "h" || e.key === "H") && !e.altKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            p.onToggle();
          }
        }}
      >
        <span class={`cx-key-dot${r.bucket === "none" || r.hidden ? " is-hollow" : ""}`} style={r.bucket === "none" || r.hidden ? { borderColor: colour } : { background: colour }} />
        <span class="cx-key-name">{name}</span>
        <span class="cx-key-count">{chipCount(rowCount(r, p.population))}</span>
      </button>
      <button type="button" class="cx-key-eye" tabIndex={-1} aria-label={t(r.hidden ? "key.showGroup" : "key.hideGroup", { name })} title={t(r.hidden ? "key.showGroup" : "key.hideGroup", { name })} onClick={() => p.onToggle()}>
        <Icon name={r.hidden ? "eyeOff" : "eye"} />
      </button>
    </span>
  );
}

/**
 * The age key's right-hand label: "today" under the Spine; the last month of the ramp under the Brain (A 11.20), which
 * spans the notes' and the record's dates. The shared key ("both") says "today" when that month is this one.
 */
export function ageEndLabel(population: LegendSection["population"], g: LegendSection["gradient"] | undefined, now: number = Date.now()): string {
  if (population === "record" || !g || !Number.isFinite(g.to)) return t("key.today");
  if (population === "both") {
    const a = new Date(g.to);
    const b = new Date(now);
    if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return t("key.today");
  }
  return monthLabel(g.to);
}

export function AgeKey(p: { sec: LegendSection }): JSX.Element {
  const g = p.sec.gradient;
  const stops = g && g.stops.length > 1 ? `linear-gradient(90deg, ${g.stops.join(", ")})` : "var(--cx-age-ramp)";
  return (
    <span class="cx-age-key">
      <span class="cx-age-from">{g ? monthLabel(g.from) : t("app.loading")}</span>
      <span class="cx-age-ramp" style={{ background: stops }} aria-hidden="true" />
      <span class="cx-age-to">{ageEndLabel(p.sec.population, g)}</span>
      <span class="cx-age-undated">
        <span class="cx-key-dot is-undated" aria-hidden="true" />
        {t("key.undated", { n: g ? num(g.undated) : t("app.loading") })}
      </span>
    </span>
  );
}

export function sectionMode(view: { colour: { notes: ColourMode; record: ColourMode } }, sec: LegendSection): ColourMode {
  return sec.population === "record" ? view.colour.record : view.colour.notes;
}

/** The key option values added under the dimension menu. */
export function keyOptionItems(colour: { same: boolean; fold: boolean; hideNoValue: boolean }, population: LegendSection["population"], mode?: ColourMode, syncKeyToGroups?: boolean): MenuItemSpec[] {
  // Colour by date (the age ramp) is offered for the Brain as well as the Spine (F64).
  const items: MenuItemSpec[] = [{ value: "key:age", label: t("key.age"), group: "age", ...(mode ? { checked: mode.kind === "age" } : {}) }];
  items.push(
    { value: "key:same", label: t("key.sameColour"), checked: colour.same, group: "options" },
    { value: "key:fold", label: t("key.fold"), checked: colour.fold, group: "options" },
    { value: "key:hideNoValue", label: t("key.hideNoValue"), checked: colour.hideNoValue, group: "options" },
    ...(syncKeyToGroups !== undefined ? [{ value: "key:sync", label: t("key.followGroups"), checked: syncKeyToGroups, group: "options" }] : []),
    { value: "key:single", label: t("key.singleColour"), group: "options" },
    { value: "key:all-groups", label: t("key.allGroups"), group: "groups" },
  );
  return items;
}

export function applyKeyOption(store: CortexStore, population: LegendSection["population"], value: string): void {
  const colour = store.get("view").colour;
  const pops: ("notes" | "record")[] = population === "both" || colour.same ? ["notes", "record"] : [population];
  switch (value) {
    case "key:age":
      store.batch(() => {
        for (const pop of pops) setColourMode(store, pop, { kind: "age" });
      });
      return;
    case "key:same":
      setView(store, "colour", { ...colour, same: !colour.same, record: !colour.same ? colour.notes : colour.record });
      return;
    case "key:fold":
      setView(store, "colour", { ...colour, fold: !colour.fold });
      return;
    case "key:hideNoValue":
      setView(store, "colour", { ...colour, hideNoValue: !colour.hideNoValue });
      return;
    case "key:sync": {
      // Turning it on colours the notes by the current grouping at once; the key then follows every later grouping.
      const on = !store.get("view").syncKeyToGroups;
      store.batch(() => {
        setSyncKeyToGroups(store, on);
        if (on) setColourMode(store, "notes", { kind: "categorical", dim: store.get("view").groupBy });
      });
      return;
    }
    case "key:single":
      for (const pop of pops) setColourMode(store, pop, { kind: "single", slot: 1 });
      store.update("ui", { popover: "key" });
      return;
    case "key:all-groups":
      store.update("ui", { popover: "key" });
      return;
  }
}

export function pickColourDim(store: CortexStore, population: LegendSection["population"], dim: DimId): void {
  const colour = store.get("view").colour;
  const mode: ColourMode = { kind: "categorical", dim };
  if (population === "both" || colour.same) {
    store.batch(() => {
      setColourMode(store, "notes", mode);
      setColourMode(store, "record", mode);
    });
  } else setColourMode(store, population, mode);
}

export function placeholderSections(): LegendModel {
  return { grandTotal: 0, sections: [] };
}

export function KeyBar(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const ref = useRef<HTMLDivElement>(null);
  useRoving(ref);
  const store = leaf.store;
  const ui = store.slices.ui.value;
  const view = store.slices.view.value;
  const legend = store.slices.legend.value ?? placeholderSections();
  const lensSlice = store.slices.lens.value;
  const lensLegend = lensSlice !== null && ui.preview?.kind === "area" && ui.preview.key === lensSlice.area ? lensSlice.legend : null;
  const size = shell.size.value;
  if (ui.breakpoint === "M") {
    return (
      <div class="cx-keybar is-button" data-cx-overlay="key">
        <button type="button" class="cx-key-button cx-glass" aria-haspopup="dialog" aria-expanded={ui.popover === "key"} data-cx-popover-toggle="key" onClick={() => openPopover(store, "key")}>
          <Icon name="key" />
          <span>{t("key.keyButton")}</span>
        </button>
      </div>
    );
  }
  const notesLabel = modeLabel(view.colour.notes);
  const recordLabel = modeLabel(view.colour.record);
  if (ui.keyCollapsed) {
    return (
      <div ref={ref} class="cx-keybar cx-glass is-collapsed" role="toolbar" aria-label={t("key.label")} data-cx-overlay="key">
        <span class="cx-key-summary">{view.colour.same ? `${t("key.everything")} ${notesLabel}` : t("key.collapsed", { brain: notesLabel, spine: recordLabel })}</span>
        <IconButton icon="chevron" roving label={t("key.expand")} class="cx-key-expand" onClick={() => toggleKeyCollapsed(store)} />
      </div>
    );
  }
  const stage = stageBox(size, ui);
  const maxWidth = keyBarMaxWidth(stage.width || SHELL.figure.reference.sheetOpenStageW);
  const kb = SHELL.geometry.keyBar;
  const one = keyRows(size.height || SHELL.figure.reference.height) === 1;
  const sections: LegendSection[] =
    legend.sections.length > 0
      ? legend.sections.filter((sec) => !(one && sec.population === "record" && legend.sections.length > 1))
      : view.colour.same
        ? [{ population: "both", dim: view.colour.notes.kind === "categorical" ? view.colour.notes.dim : "space", rows: [], total: 0 }]
        : [
            { population: "notes", dim: view.colour.notes.kind === "categorical" ? view.colour.notes.dim : "space", rows: [], total: 0 },
            ...(one ? [] : [{ population: "record" as const, dim: "age" as const, rows: [], total: 0 }]),
          ];
  const loading = store.slices.legend.value === null;
  // "Show every group" ends the first row that lists chips (the Spine row is often the age ramp, which has none).
  const showAllAt = anyHidden(ui.hiddenGroups) ? sections.findIndex((sec) => sectionMode(view, sec).kind !== "age" && sec.dim !== "age" && sec.rows.some((r) => r.depth === 0)) : -1;
  return (
    <div ref={ref} class="cx-keybar cx-glass" role="toolbar" aria-label={t("key.label")} data-cx-overlay="key" style={{ maxWidth: `${maxWidth}px` }} onKeyDown={(e) => rovingKeyDown(e as unknown as KeyboardEvent, ref.current, "horizontal")}>
      {sections.map((sec, si) => {
        const mode = sectionMode(view, sec);
        const last = si === sections.length - 1;
        const isAge = mode.kind === "age" || sec.dim === "age";
        const lensed = lensRows(
          sec.rows.filter((r) => r.depth === 0),
          String(sec.dim),
          ui.preview,
        );
        // The wordmark's lens recounts the chips inside the held area.
        const top = lensLegend ? lensed.rows.map((r) => ({ ...r, ...lensCounts(lensLegend, sec, r) })) : lensed.rows;
        const available = maxWidth - kb.padX - kb.labelW - kb.pickerW - (last ? kb.layersW : 0) - (si === 0 ? 24 + KEY_TOTAL_W : 0) - (si === showAllAt ? SHOW_ALL_W : 0);
        const fit = fitChips(top, sec.population, available);
        const dim = String(sec.dim);
        const allKeys = top.map((r) => groupKey(dim, r.key));
        const selected = selectedRow(sec.rows)?.key ?? null;
        return (
          <div key={`${sec.population}-${si}`} class="cx-key-row" data-population={sec.population}>
            <span class="cx-key-label">{populationLabel(sec.population)}</span>
            <button
              type="button"
              data-roving=""
              class="cx-key-picker"
              aria-haspopup="menu"
              aria-label={`${populationLabel(sec.population)}: ${modeLabel(mode, sec.dim)}`}
              draggable={mode.kind === "categorical"}
              onDragStart={(e) => {
                // Same type as the Chart page's chips (stage/ChartOverlay.tsx DIM_MIME): drop on a chart zone to use the dimension.
                if (mode.kind === "categorical") e.dataTransfer?.setData("application/x-cortex-dim", String(mode.dim));
              }}
              onClick={(e) =>
                openDimMenu(e.currentTarget as HTMLElement, {
                  app: s.app,
                  settings: s.settings.value,
                  current: mode.kind === "categorical" ? mode.dim : null,
                  onPick: (d) => pickColourDim(store, sec.population, d),
                  extras: keyOptionItems(view.colour, sec.population, mode, view.syncKeyToGroups),
                  onExtra: (x) => applyKeyOption(store, sec.population, x),
                  // Pointing at a dimension recolours the figure live; closing the menu puts it back (FIG-36).
                  onHover: (d) => setDimPreview(store, d, sec.population === "both" || view.colour.same ? "both" : sec.population),
                })
              }
            >
              <span>{modeLabel(mode, sec.dim)}</span>
              <Icon name="chevron" class="cx-select-caret-icon" />
            </button>
            {loading ? (
              isAge ? (
                <AgeKey sec={sec} />
              ) : (
                <span class="cx-key-chip is-loading">
                  <span class="cx-key-dot is-loading" />
                  <span class="cx-key-count">{t("app.loading")}</span>
                </span>
              )
            ) : isAge ? (
              <AgeKey sec={sec} />
            ) : top.length === 0 ? (
              <span class="cx-key-empty">{t("key.nothing")}</span>
            ) : (
              <span class={`cx-key-chips${selected !== null ? " has-selected" : ""}${lensed.key !== null ? " has-lens" : ""}`}>
                {fit.shown.map((r) => (
                  <KeyChip
                    key={r.key}
                    row={r}
                    dim={dim}
                    population={sec.population}
                    selected={selected === r.key}
                    lens={lensed.key === r.key}
                    onToggle={() => toggleGroup(store, groupKey(dim, r.key))}
                    onSolo={() => soloGroup(store, groupKey(dim, r.key), allKeys)}
                    onTrace={() => traceGroup(store, dim, r)}
                    onMenu={(e) => chipMenu(s, leaf, shell, sec, r, top, { x: e.clientX, y: e.clientY }, e.currentTarget as HTMLElement)}
                    onPreview={(on) => store.update("ui", { preview: on ? { kind: "group", key: groupKey(dim, r.key) } : null })}
                  />
                ))}
                {fit.more > 0 ? (
                  <button type="button" data-roving="" class="cx-key-more" title={t("key.allGroups")} aria-label={`${t("key.allGroups")} (+${fit.more})`} data-cx-popover-toggle="key" onClick={() => openPopover(store, "key")}>
                    +{fit.more}
                  </button>
                ) : null}
                {si === showAllAt ? (
                  <button type="button" data-roving="" class="cx-key-showall" onClick={() => showAllGroups(store)}>
                    {t("key.showEvery")}
                  </button>
                ) : null}
              </span>
            )}
            {last ? (
              <button type="button" data-roving="" class="cx-key-layers" aria-haspopup="menu" onClick={(e) => openLayersMenu(s, leaf, e.currentTarget as HTMLElement)}>
                <Icon name="layers" />
                <span>{t("key.layers")}</span>
                <Icon name="chevron" class="cx-select-caret-icon" />
              </button>
            ) : null}
            {si === 0 && !loading ? (
              <span class="cx-key-total" title={legend.lit !== undefined ? t("key.matching", { n: num(legend.lit) }) : t("key.total", { n: num(legend.grandTotal) })} data-testid="key-total">
                {legend.lit !== undefined ? t("key.matching", { n: chipCount(legend.lit) }) : t("key.total", { n: chipCount(legend.grandTotal) })}
              </span>
            ) : null}
            {si === 0 ? <IconButton icon="chevron" roving label={t("key.collapse")} class="cx-key-collapse" onClick={() => toggleKeyCollapsed(store)} /> : null}
          </div>
        );
      })}
    </div>
  );
}
