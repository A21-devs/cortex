/**
 * Cortex Desktop opens the panel with every section, as the reference does, hanging 8 px under the stage cluster so the
 * button that opened it stays visible: FORM (the Body to Groups slider, Order at the Body end, Spacing 0 to 100% on
 * look.scatter, Notes and Record switches with counts), GROUPS (Notes by, an indented Layout, Record by with "Same as
 * notes" first, a Labels row of two pickers, Hide unsorted), COLOUR (Colour by, "Your colour", swatch strip), SHOW (Body,
 * Labels, All links, Agent conversations), MOTION (Rotation, Speed to 200%, Keep upright) and DRAWN (Links, Scaffold
 * 0 to 100% on the conversation threads' strength, Dot size). Below them a collapsed "Theme and data colours" block
 * (Colour theme, Stage tint, Data colours), then the chart switch, LOOK, POINTS, tooltip style and Area scope. "Fewer
 * options" in the footer hides SHOW, MOTION and those extra sections ("More options" brings them back). The body scrolls
 * under a sticky footer of text links (Fewer or More options, Quick walkthrough, Explore the sample record, Reset); the
 * choice is remembered per device. The Obsidian plugin keeps the layout below
 * and gains the same COLOUR and SHOW sections and footer links under "All controls".
 *
 * The panel opens with a Body / Groups switch (the 1.4 s morph), then on Cortex Desktop a Colour theme select with a
 * Stage tint slider and the "Data colours" list (seven named rows, writes only the palette; the Obsidian plugin
 * lists the same rows under "All controls"). "Names for" (Everything, What is lit, Hovered only) and "Density"
 * (Auto, Few, All) replace the Names toggle; Points gains "Brain outline" (0 to 150%: the anatomy haze's
 * strength, 0 = haze off). A chevron in the header collapses the panel to its title bar.
 *
 * Display popover (CORTEX-UX §5.6; ORIG-13): how the points are drawn and how the figure moves, 304 px, opened
 * from the tool column (O); its right edge sits 8 px left of the tool column, top aligned to its button. It opens
 * compact (Scatter, Names, Lines, Keep upright) with an "All controls" / "Fewer controls" disclosure whose state is
 * remembered on this device (deviceState.displayExpanded). Expanded it adds Points (Dot size 50–250%, Glow 0–200%,
 * Brightness 25–200%, Shimmer), Conversation threads (0–100%), Motion (Spin · Drift · Off, the pose's own motion
 * first; Speed 0–200%; Pause while pointing), "Spine runs" (only while the figure is the body), the grouping rows
 * (only in Groups: Group by, or Notes by and Record by once "Separate record" is on; Group names) and the tooltip
 * style. Rows that depend on the state fade in and out while the panel's height eases (Reflow). Changes apply live
 * to this leaf only. The header's reset restores Display and the camera (not scope, period, palette or tokens) and
 * posts "Display reset · Undo change". When the frame-rate governor lowered detail, a "Performance mode" line
 * appears. Shape lives in the shape bar, colour and layers in the key bar. Owner: E11.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { CortexServices, LeafServices } from "../../plugin/services";
import { builtinDim, isLabelDim, parseLabelDim, type DimId, type LabelDim } from "../../shared/dims";
import { featureOn } from "../../shared/features";
import { paletteById, sliderToTint, themeCardsFor, tintToSlider, TINT_SLIDER } from "../../shared/palette";
import { SETTING_RANGES, type LinesMode, type PaletteId, type StageId } from "../../shared/settings";
import type { ColourMode } from "../../shared/protocol/worker";
import type { PackDef } from "../../shared/types";
import { openPopover, resetDisplay, setColourMode, setDimPreview, setGroupByRecord, setLayer, setLook, setMotion, setShape, setSplitGroups, setSpineOrder, setView, toggleImmersive } from "../../state/actions";
import type { CortexStore } from "../../state/store";
import { defaultView, MOTION_SPEED_RANGE, NAMES_DENSITY, NAMES_FOR, OUTLINE_RANGE, type MotionControls, type NamesDensity, type NamesFor, type SheetState, type SpineOrder, type ViewControls } from "../../state/types";
import { SHELL } from "../breakpoints";
import { indexCounts, isReducedMotion, num, useLeaf, useServices, useShell, type IndexCounts, type Shell } from "../context";
import { t } from "../copy";
import { displayCompactOn, displayExpanded, setDisplayCompact, setDisplayExpanded } from "../deviceState";
import { ScopePicker } from "../header/ScopePicker";
import { isDesktopHost } from "../host";
import { motionModeFor, toggleChartPage } from "../keymap";
import { panelTitleClass, usePanelBusy } from "../loading";
import { chooseGroupBy } from "../pages/chart/ChartGroupsSection";
import { Icon, IconButton, SectionLabel } from "../primitives/buttons";
import { Popover, Segmented, Select, Slider, Toggle } from "../primitives/controls";
import { dimMenuModel, enabledPacks, openDimMenu } from "../primitives/dimMenu";
import { showMenu, type MenuItemSpec } from "../primitives/menu";
import { startTour } from "../walkthrough/TourLayer";
import { dimLabel } from "../valueLabels";
import { DataColoursList } from "./DataColoursList";
import { pickColourDim } from "./KeyBar";
import { setBrainOutline, setHazeLayer } from "./LayersMenu";
import { singleHex, Swatches } from "./KeyPopover";
import { Fade, Reflow } from "./Reflow";
import { useSnapClip } from "./snapClip";
import { animateMorph, foldSparse, gridMarkItems, LAYOUT_LABEL, layoutsFor, ShapeControls } from "./ShapeBar";

export const SCATTER_RANGE = [0.5, 1.5] as const;

/** Speed as stored: a multiplier between 0 (still) and 2 (200%), rounded to a whole percent. */
export function clampSpeed(x: number): number {
  if (!Number.isFinite(x)) return 1;
  return Math.round(Math.max(MOTION_SPEED_RANGE[0], Math.min(MOTION_SPEED_RANGE[1], x)) * 100) / 100;
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** Reset display with a toast and Undo (also from More and the command). */
export function resetDisplayWithUndo(s: CortexServices, leaf: LeafServices, shell: Shell): void {
  const before = leaf.store.get("view");
  resetDisplay(leaf.store, defaultView(s.settings.value));
  s.bus.emit("camera:fly-to", { viewId: leaf.viewId, home: true });
  const undoId = shell.pushUndo(() => leaf.store.update("view", () => before));
  shell.toast({ kind: "change", text: t("display.resetToast"), undo: () => void shell.runUndo(undoId) });
}

/** The motion choices, the pose's own motion first (Spin standing, Drift lying). */
export function motionOptions(pose: "standing" | "lying"): { value: MotionControls["mode"]; label: string }[] {
  const first = motionModeFor(pose);
  const second = first === "spin" ? "drift" : "spin";
  return [
    { value: first, label: t(`display.${first}`) },
    { value: second, label: t(`display.${second}`) },
    { value: "off", label: t("display.off") },
  ];
}

/** "Spine runs" only applies while the figure is the body: the order moves the cord's ends, nothing else. */
export function spineOrderShown(v: Pick<ViewControls, "morph">): boolean {
  return v.morph === 0;
}

/** The grouping rows (Group by, Separate record, Group names) belong to the Groups shape. */
export function groupingShown(v: Pick<ViewControls, "shape">): boolean {
  return v.shape === "groups";
}

export interface RecordDimChoice {
  id: DimId;
  label: string;
}

/**
 * What the record can be grouped by: fields it shares with the notes, and fields only the record has (speaker,
 * conversation, and pack fields written for entries or conversations). Notes-only fields are left out.
 */
export function recordDimChoices(packs: readonly PackDef[]): { shared: RecordDimChoice[]; recordOnly: RecordDimChoice[] } {
  const model = dimMenuModel(packs);
  const shared: RecordDimChoice[] = [...model.date.grains, ...model.date.rhythm].map((g) => ({ id: g.id, label: g.label }));
  const recordOnly: RecordDimChoice[] = [];
  for (const sec of model.sections) {
    for (const it of sec.items) {
      if (isLabelDim(it.id)) {
        const pack = packs.find((p) => p.id === parseLabelDim(it.id as LabelDim).pack);
        const toNotes = pack?.appliesTo.includes("note") ?? true;
        const toRecord = pack ? pack.appliesTo.some((x) => x === "entry" || x === "conversation") : true;
        if (toNotes && toRecord) shared.push(it);
        else if (toRecord) recordOnly.push(it);
        continue;
      }
      const def = builtinDim(it.id);
      if (def?.appliesTo === "both") shared.push(it);
      else if (def?.appliesTo === "record") recordOnly.push(it);
    }
  }
  return { shared, recordOnly };
}

/** The menu items for the record select: two sections, the current dimension checked. */
export function recordDimItems(packs: readonly PackDef[], current: DimId | null, withSame = false): MenuItemSpec<string>[] {
  const c = recordDimChoices(packs);
  const row = (group: string, groupLabel: string) => (d: RecordDimChoice): MenuItemSpec<string> => ({ value: d.id, label: d.label, checked: d.id === current, group, groupLabel });
  // "Same as notes" leads when asked for, in a group of its own so the menu draws a divider under it.
  const same: MenuItemSpec<string>[] = withSame ? [{ value: SAME_AS_NOTES, label: t("display.sameAsNotes"), checked: current === null, group: "same" }] : [];
  return [...same, ...c.shared.map(row("shared", t("display.shared"))), ...c.recordOnly.map(row("record", t("display.recordOnly")))];
}

/** The menu value of the Record by select's first row. */
export const SAME_AS_NOTES = "same:notes";

/** Hover options for a dimension menu: resting on a row previews it on the figure, closing the menu ends the preview. */
export function previewMenu(store: CortexStore, pop: "notes" | "record" | "both" = "notes"): { onHover(v: string | null): void; onHide(): void } {
  return {
    onHover: (v) => setDimPreview(store, v !== null && !v.startsWith("dim:") ? (v as DimId) : null, pop),
    onHide: () => setDimPreview(store, null),
  };
}

const LINES_MODES: readonly LinesMode[] = ["off", "selection", "all"];

/** The Body / Groups switch morphs over this long (ms), both ways. */
export const MODE_SWITCH_MS = 1400;

/** Where the switch goes from here: to Groups from the body half of the morph, back to the body from the Groups half. */
export function modeSwitchTarget(morph: number): 0 | 1 {
  return morph >= 0.5 ? 0 : 1;
}

const NAMES_FOR_LABEL: Record<NamesFor, "display.namesEverything" | "display.namesLit" | "display.namesHovered"> = { everything: "display.namesEverything", lit: "display.namesLit", hovered: "display.namesHovered" };
const DENSITY_LABEL: Record<NamesDensity, "display.densityAuto" | "display.densityFew" | "display.densityAll"> = { auto: "display.densityAuto", few: "display.densityFew", all: "display.densityAll" };

/** Choosing Names for also settles the chips on the figure: Everything keeps them always on, the others only on what is lit. */
export function namesForPatch(namesFor: NamesFor): { namesFor: NamesFor; names: "always" | "hover" } {
  return { namesFor, names: namesFor === "everything" ? "always" : "hover" };
}

/** The Stage tint slider's caption: Off, or the hue in degrees. */
export function tintLabel(v: number): string {
  const hue = sliderToTint(v);
  return hue === null ? t("display.tintOff") : t("display.tintDeg", { n: hue });
}

/** The Body / Groups switch at the top of the panel: one click morphs the figure over 1.4 s, and back. */
function ViewSwitch(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const store = leaf.store;
  const v = store.slices.view.value;
  const reduced = isReducedMotion(s.settings.value.appearance.motion, shell.systemReducedMotion.value);
  const on = v.morph >= 0.5;
  const flip = () => {
    const to = modeSwitchTarget(store.get("view").morph);
    if (to === 1 && store.get("view").shape === "body") setShape(store, "groups");
    void animateMorph(store, to, { ms: MODE_SWITCH_MS, win: shell.win, reduced });
  };
  return (
    <div class="cx-row cx-view-switch">
      <span class="cx-row-label">{t("display.viewMode")}</span>
      <span class="cx-view-switch-ends">
        <button type="button" class={`cx-view-end${on ? "" : " is-on"}`} aria-pressed={!on} onClick={() => on && flip()}>
          {t("display.viewBody")}
        </button>
        <button type="button" role="switch" aria-checked={on} aria-label={t("display.viewSwitch")} class={`cx-toggle${on ? " is-on" : ""}`} onClick={flip}>
          <span class="cx-toggle-knob" />
        </button>
        <button type="button" class={`cx-view-end${on ? " is-on" : ""}`} aria-pressed={on} onClick={() => !on && flip()}>
          {t("display.viewGroups")}
        </button>
      </span>
    </div>
  );
}

/** The Chart switch mirrors the sheet: on while the sheet's current entry is the Chart page. */
export function chartSheetOpen(sheet: Pick<SheetState, "open" | "stack" | "index">): boolean {
  const top = sheet.open ? sheet.stack[sheet.index] : undefined;
  return top?.kind === "page" && top.route === "chart";
}

/** What the Colour by select says: One colour, Date ramp, or the dimension's name. */
export function colourChoiceLabel(mode: ColourMode): string {
  if (mode.kind === "single") return t("display.colourOne");
  if (mode.kind === "age") return t("display.colourAge");
  return dimLabel(mode.dim);
}

/** The "Your colour" row's value: the live hex while one colour is used, else "follows the figure". */
export function yourColourText(mode: ColourMode, palette: PaletteId): string {
  return mode.kind === "single" ? singleHex(mode, palette).toUpperCase() : t("display.followsFigure");
}

/** The Display panel colours the whole figure at once: both populations take the same mode. */
export function setColourEverywhere(store: CortexStore, mode: ColourMode): void {
  store.batch(() => {
    setColourMode(store, "notes", mode);
    setColourMode(store, "record", mode);
  });
}

/** A swatch or the hex field: one colour (a palette slot, or any colour) for every point. */
export function pickSingleColour(store: CortexStore, slot: number, hex?: string): void {
  setColourEverywhere(store, hex === undefined ? { kind: "single", slot } : { kind: "single", slot, hex });
}

/** The count a SHOW row carries ("Record 18,533"); null while the index is not loaded. */
export function showCounts(c: IndexCounts | null): { notes: number | null; record: number | null; agent: number | null } {
  return c ? { notes: c.notes, record: c.record, agent: c.askHistory } : { notes: null, record: null, agent: null };
}

/** How far out the Spacing slider reaches: 100% = the top of the Scatter range (150% of the rest spread). */
export const SPREAD_MAX = SCATTER_RANGE[1] - 1;

/** The Spacing slider's value (0 to 1) for a stored Scatter: 0 is the resting figure, so a view that was tightened shows 0. */
export function spreadFromScatter(scatter: number): number {
  if (!Number.isFinite(scatter)) return 0;
  return Math.max(0, Math.min(1, Math.round(((scatter - 1) / SPREAD_MAX) * 100) / 100));
}

/** The Scatter a Spacing value stores: 0 keeps the resting figure, 1 spreads it to the top of the range. */
export function scatterFromSpread(spread: number): number {
  const s = Number.isFinite(spread) ? Math.max(0, Math.min(1, spread)) : 0;
  return Math.round((1 + s * SPREAD_MAX) * 1000) / 1000;
}

/** The Rotation switch: on while the figure turns at all. */
export function rotationOn(motion: Pick<MotionControls, "mode">): boolean {
  return motion.mode !== "off";
}

/** Switching Rotation on brings back the pose's own motion (Spin standing, Drift lying); off stops it. */
export function setRotation(store: CortexStore, on: boolean): void {
  const v = store.get("view");
  setMotion(store, { mode: on ? motionModeFor(v.pose) : "off" });
}

/** Links on or off: off draws none, on draws the selection's (or keeps All when it is already on). */
export function linesWithLinks(cur: LinesMode, on: boolean): LinesMode {
  return on ? (cur === "off" ? "selection" : cur) : "off";
}

/** All links on or off: on draws every link, off falls back to the selection's. */
export function linesWithAll(on: boolean): LinesMode {
  return on ? "all" : "selection";
}

/** Notes by: groups the notes by this field and recolours them at once (both populations while one colour serves both). */
export function chooseNotesBy(store: CortexStore, dim: DimId): void {
  store.batch(() => {
    chooseGroupBy(store, dim);
    pickColourDim(store, "notes", dim);
  });
}

/**
 * Record by: null is "same as the notes" (the record joins the notes' groups and takes their colour); a field groups the
 * record by it and recolours it at once, so the key gains a Record by section of its own.
 */
export function chooseRecordBy(store: CortexStore, dim: DimId | null): void {
  store.batch(() => {
    if (dim === null) {
      setSplitGroups(store, false);
      store.update("view", (v) => ({ ...v, colour: { ...v.colour, record: v.colour.notes } }));
      return;
    }
    store.update("view", (v) => ({ ...v, splitGroups: true, groupByRecord: dim, colour: { ...v.colour, same: false, record: { kind: "categorical", dim } } }));
  });
}

/** What the Record by select says: the field, or "Same as notes" while the record follows the notes. */
export function recordByLabel(v: Pick<ViewControls, "splitGroups" | "groupByRecord">): string {
  return v.splitGroups && v.groupByRecord ? dimLabel(v.groupByRecord) : t("display.sameAsNotes");
}

/** A switch row whose label carries a small count. */
function CountToggle(p: { label: string; count: number | null; checked: boolean; onChange(on: boolean): void }): JSX.Element {
  return (
    <div class="cx-row cx-toggle-row">
      <span class="cx-row-label">
        {p.label}
        {p.count !== null ? <span class="cx-row-count">{num(p.count)}</span> : null}
      </span>
      <button type="button" role="switch" aria-checked={p.checked} aria-label={p.count !== null ? `${p.label} ${num(p.count)}` : p.label} class={`cx-toggle${p.checked ? " is-on" : ""}`} onClick={() => p.onChange(!p.checked)}>
        <span class="cx-toggle-knob" />
      </button>
    </div>
  );
}

export function DisplayPopover(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const store = leaf.store;
  const v = store.slices.view.value;
  const ui = store.slices.ui.value;
  const settings = s.settings.value;
  const feed = shell.feed.value;
  const flat = feed.flatChart && v.shape === "chart" && v.morph > 0.5;
  const desktop = isDesktopHost();
  // Desktop opens with every section and offers "Fewer options" (the reference's panel); the plugin opens short.
  const expanded = desktop ? !displayCompactOn(s.device.value) : displayExpanded(s.device.value);
  const reduced = isReducedMotion(settings.appearance.motion, shell.systemReducedMotion.value);
  const close = () => openPopover(store, null);
  const busy = usePanelBusy("display");
  const g = SHELL.geometry;
  const pointsOn = featureOn("pointControls");
  const linesOn = featureOn("lines");
  const namesForced = paletteById(settings.appearance.palette).forcesNames;
  const recordOn = v.layers.record;
  const split = recordOn && v.splitGroups;
  const palette = settings.appearance.palette;
  const counts = showCounts(indexCounts(s));
  const mode = v.colour.notes;
  const [collapsed, setCollapsed] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const appearance = settings.appearance;
  const themeOptions = themeCardsFor(!desktop).map((c) => ({ value: c.id, label: t(`display.theme.${c.id}` as "display.theme.ink") }));
  const colourLook = (
    <>
      <Select label={t("display.colourTheme")} value={desktop && appearance.stage === "follow" ? "ink" : appearance.stage} options={themeOptions} onChange={(x: StageId) => void s.settings.update((d) => void (d.appearance.stage = x)).catch(() => undefined)} />
      <Slider
        label={t("display.stageTint")}
        value={tintToSlider(appearance.stageTint)}
        min={TINT_SLIDER[0]}
        max={TINT_SLIDER[1]}
        step={1}
        format={tintLabel}
        onInput={(x) => s.settings.preview?.((d) => void (d.appearance.stageTint = sliderToTint(x)))}
        onRelease={(x) => void s.settings.update((d) => void (d.appearance.stageTint = sliderToTint(x))).catch(() => undefined)}
      />
      <SectionLabel>{t("display.dataColours")}</SectionLabel>
      <DataColoursList />
      <p class="cx-popover-foot">{t("display.dataColoursHint")}</p>
    </>
  );
  useEffect(
    () => () => {
      if (store.get("ui").dimPreview !== null) setDimPreview(store, null);
    },
    [store],
  );
  const pickNotes = (e: MouseEvent) => {
    const sparse = shell.feed.value.sparse;
    const extras: MenuItemSpec[] = [
      ...(desktop && sparse.length > 0
        ? [{ value: "sparse:label", label: sparse.length === 1 ? t("shape.sparseOne") : t("shape.sparse", { k: sparse.length }), disabled: true, group: "sparse" }, { value: "sparse:fold", label: t("shape.foldSparse"), group: "sparse", icon: "triangle-alert" }]
        : []),
      ...(desktop && layoutsFor(v.groupBy).includes("grid") ? gridMarkItems(v.layoutOptions.gridMarks) : []),
    ];
    openDimMenu(e.currentTarget as HTMLElement, {
      app: s.app,
      settings,
      current: v.groupBy,
      onPick: (dim) => (desktop ? chooseNotesBy(store, dim) : chooseGroupBy(store, dim)),
      extras,
      onExtra: (x) => {
        if (x === "sparse:fold") foldSparse(store, shell);
        else if (x.startsWith("gridMarks:")) setView(store, "layoutOptions", { ...store.get("view").layoutOptions, gridMarks: x.slice(10) === "rows" ? "rows" : "spheres" });
      },
      menu: previewMenu(store),
    });
  };
  const pickRecord = (e: MouseEvent) =>
    showMenu(
      recordDimItems(enabledPacks(settings), v.groupByRecord),
      e.currentTarget as HTMLElement,
      (x) => setGroupByRecord(store, x as DimId),
      previewMenu(store, "record"),
    );
  const pickRecordBy = (e: MouseEvent) =>
    showMenu(
      recordDimItems(enabledPacks(settings), v.splitGroups ? v.groupByRecord : null, true),
      e.currentTarget as HTMLElement,
      (x) => chooseRecordBy(store, x === SAME_AS_NOTES ? null : (x as DimId)),
      previewMenu(store, "record"),
    );
  const pickColour = (e: MouseEvent) =>
    openDimMenu(e.currentTarget as HTMLElement, {
      app: s.app,
      settings,
      current: mode.kind === "categorical" ? mode.dim : null,
      onPick: (dim) => pickColourDim(store, "both", dim),
      extras: [
        { value: "colour:one", label: t("display.colourOne"), checked: mode.kind === "single", group: "mode" },
        { value: "colour:age", label: t("display.colourAge"), checked: mode.kind === "age", group: "mode" },
      ],
      onExtra: (x) => {
        if (x === "colour:one") pickSingleColour(store, mode.kind === "single" ? mode.slot : 1, mode.kind === "single" ? mode.hex : undefined);
        else if (x === "colour:age") setColourEverywhere(store, { kind: "age" });
      },
      onHover: (d) => setDimPreview(store, d, "both"),
    });
  const dimRow = (label: string, value: string, onClick: (e: MouseEvent) => void) => (
    <div class="cx-row">
      <span class="cx-row-label">{label}</span>
      <button type="button" class="cx-select" aria-haspopup="menu" aria-label={`${label}: ${value}`} onClick={(e) => onClick(e as unknown as MouseEvent)}>
        <span class="cx-select-value">{value}</span>
        <span class="cx-select-caret" aria-hidden="true" />
      </button>
    </div>
  );
  const spineOptions: { value: SpineOrder; label: string }[] = [
    { value: "oldest-at-brain", label: t(desktop ? "display.orderOldest" : "display.spineOldest") },
    { value: "newest-at-brain", label: t(desktop ? "display.orderNewest" : "display.spineNewest") },
  ];
  const orderRow = (
    <Fade show={spineOrderShown(v)} reduced={reduced}>
      <Select label={desktop ? t("display.order") : t("display.spineRuns")} value={v.spineOrder} options={spineOptions} onChange={(x) => setSpineOrder(store, x)} />
    </Fade>
  );
  const colourSection = (
    <>
      <SectionLabel>{t("display.colour")}</SectionLabel>
      {dimRow(t("display.colourBy"), colourChoiceLabel(mode), pickColour)}
      <div class="cx-row cx-your-colour">
        <span class="cx-row-label">{t("display.yourColour")}</span>
        <span class={`cx-your-colour-value${mode.kind === "single" ? " is-hex" : ""}`}>{yourColourText(mode, palette)}</span>
      </div>
      <Swatches strip mode={mode} onPick={(slot) => pickSingleColour(store, slot)} onHex={(hex) => pickSingleColour(store, mode.kind === "single" ? mode.slot : 1, hex)} />
    </>
  );
  const showSection = (
    <>
      <SectionLabel>{t("display.show")}</SectionLabel>
      <CountToggle label={t("layers.notes")} count={counts.notes} checked={v.layers.notes} onChange={(on) => setLayer(store, "notes", on)} />
      <CountToggle label={t("layers.record")} count={counts.record} checked={v.layers.record} onChange={(on) => setLayer(store, "record", on)} />
      {featureOn("ask") ? <CountToggle label={t("display.agentConversations")} count={counts.agent} checked={v.layers.askHistory} onChange={(on) => setLayer(store, "askHistory", on)} /> : null}
    </>
  );
  const motionSection = (
    <>
      <SectionLabel>{t("display.motion")}</SectionLabel>
      <Segmented label={t("display.motion")} value={v.motion.mode} options={motionOptions(v.pose)} onChange={(x) => setMotion(store, { mode: x })} />
      <Slider label={t("display.speed")} value={v.motion.speed} min={MOTION_SPEED_RANGE[0]} max={MOTION_SPEED_RANGE[1]} step={0.01} ariaScale={100} format={pct} onInput={(x) => setMotion(store, { speed: clampSpeed(x) })} />
      <Toggle label={t("display.pauseWhilePointing")} checked={v.motion.pauseWhilePointing} onChange={(x) => setMotion(store, { pauseWhilePointing: x })} />
      {desktop ? <Toggle label={t("display.keepUpright")} checked={v.motion.keepUpright || flat} disabled={flat} hint={t("display.keepUprightNote")} onChange={(x) => setMotion(store, { keepUpright: x })} /> : null}
      {desktop ? (
        <div class="cx-display-tools">
          <button type="button" class="cx-display-tool" onClick={() => s.bus.emit("camera:fly-to", { viewId: leaf.viewId, home: true })}>
            <Icon name="home" />
            <span>{t("tools.home")}</span>
          </button>
          <button type="button" class="cx-display-tool" onClick={() => toggleImmersive(store)}>
            <Icon name="immersive" />
            <span>{t("tools.immersive")}</span>
          </button>
        </div>
      ) : null}
    </>
  );
  const dotSizeSlider = <Slider label={t(desktop ? "display.pointSize" : "display.dotSize")} value={v.look.dotSize} min={SETTING_RANGES.dotSize[0]} max={SETTING_RANGES.dotSize[1]} step={0.01} ariaScale={100} format={pct} onInput={(x) => setLook(store, { dotSize: x })} />;
  const pointsSection = pointsOn ? (
    <>
      <SectionLabel>{t("display.points")}</SectionLabel>
      <Slider label={t("display.brainOutline")} value={v.look.outline} min={OUTLINE_RANGE[0]} max={OUTLINE_RANGE[1]} step={0.01} ariaScale={100} format={pct} onInput={(x) => setBrainOutline(store, x)} onThumbDoubleClick={() => setBrainOutline(store, 1)} />
      {desktop ? null : dotSizeSlider}
      <Slider label={t("display.glow")} value={v.look.glow} min={SETTING_RANGES.glow[0]} max={SETTING_RANGES.glow[1]} step={0.01} ariaScale={100} format={pct} onInput={(x) => setLook(store, { glow: x })} />
      <Slider label={t("display.brightness")} value={v.look.brightness} min={SETTING_RANGES.brightness[0]} max={SETTING_RANGES.brightness[1]} step={0.01} ariaScale={100} format={pct} onInput={(x) => setLook(store, { brightness: x })} />
      <Toggle label={t("display.shimmer")} checked={v.look.shimmer} onChange={(x) => setLook(store, { shimmer: x })} />
    </>
  ) : null;
  const namesSelects = (
    <>
      <Select
        label={t("display.namesFor")}
        value={namesForced ? "everything" : v.look.namesFor}
        options={NAMES_FOR.map((m) => ({ value: m, label: t(NAMES_FOR_LABEL[m]) }))}
        onChange={(x) => setLook(store, namesForPatch(x))}
      />
      <Select label={t("display.density")} value={v.look.density} options={NAMES_DENSITY.map((m) => ({ value: m, label: t(DENSITY_LABEL[m]) }))} onChange={(x) => setLook(store, { density: x })} />
      {namesForced ? <p class="cx-popover-foot">{t("display.namesForNote")}</p> : null}
    </>
  );
  const linesSelect = linesOn ? (
    <Select
      label={t("display.lines")}
      value={v.look.lines}
      options={LINES_MODES.map((m) => ({ value: m, label: t(m === "off" ? "display.linesOff" : m === "selection" ? "display.linesSelection" : "display.linesAll") }))}
      onChange={(x) => setLook(store, { lines: x })}
    />
  ) : null;
  const threadsSlider = linesOn ? <Slider label={t("display.threads")} value={v.look.stemStrength} min={0} max={1} step={0.01} ariaScale={100} format={pct} onInput={(x) => setLook(store, { stemStrength: x })} /> : null;
  const tooltipSection = (
    <>
      <SectionLabel>{t("overlays.tooltipStyle")}</SectionLabel>
      <Segmented
        label={t("overlays.tooltipStyle")}
        value={s.device.value.tooltipStyle}
        options={[
          { value: "card", label: t("overlays.tooltipCard") },
          { value: "line", label: t("overlays.tooltipLine") },
        ]}
        onChange={(x) => s.device.update((d) => (d.tooltipStyle === x ? d : { ...d, tooltipStyle: x }))}
      />
      <p class="cx-popover-foot">{t("overlays.tooltipNote")}</p>
    </>
  );
  // ── Cortex Desktop: FORM, GROUPS, COLOUR, SHOW, MOTION and DRAWN are all open at once; the rest sits lower ──
  const formSection = (
    <>
      <SectionLabel>{t("display.form")}</SectionLabel>
      <ShapeControls inPopover sliderOnly />
      {orderRow}
      {pointsOn ? <Slider label={t("display.spread")} value={spreadFromScatter(v.look.scatter)} min={0} max={1} step={0.01} ariaScale={100} format={pct} onInput={(x) => setLook(store, { scatter: scatterFromSpread(x) })} onThumbDoubleClick={() => setLook(store, { scatter: 1 })} /> : null}
      <CountToggle label={t("layers.notes")} count={counts.notes} checked={v.layers.notes} onChange={(on) => setLayer(store, "notes", on)} />
      <CountToggle label={t("layers.record")} count={counts.record} checked={v.layers.record} onChange={(on) => setLayer(store, "record", on)} />
    </>
  );
  const labelsRow = (
    <div class="cx-row cx-pair-row">
      <span class="cx-row-label">{t("display.labels")}</span>
      <span class="cx-pair">
        <Select
          bare
          label={t("display.namesFor")}
          value={namesForced ? "everything" : v.look.namesFor}
          options={NAMES_FOR.map((m) => ({ value: m, label: t(NAMES_FOR_LABEL[m]) }))}
          onChange={(x) => setLook(store, namesForPatch(x))}
        />
        <Select bare label={t("display.density")} value={v.look.density} options={NAMES_DENSITY.map((m) => ({ value: m, label: t(DENSITY_LABEL[m]) }))} onChange={(x) => setLook(store, { density: x })} />
      </span>
    </div>
  );
  const groupsSection = (
    <>
      <SectionLabel>{t("display.grouping")}</SectionLabel>
      {dimRow(t("display.notesBy"), dimLabel(v.groupBy), pickNotes)}
      {layoutsFor(v.groupBy).length > 1 ? (
        <Select indent label={t("shape.layout")} value={v.layout} options={layoutsFor(v.groupBy).map((l) => ({ value: l, label: t(LAYOUT_LABEL[l]) }))} onChange={(x) => setView(store, "layout", x)} />
      ) : null}
      {dimRow(t("display.recordBy"), recordByLabel(v), pickRecordBy)}
      {labelsRow}
      <Toggle label={t("display.hideUnsorted")} checked={v.colour.hideNoValue} onChange={(x) => setView(store, "colour", { ...v.colour, hideNoValue: x })} />
    </>
  );
  const bodyOn = v.layers.haze && v.look.outline > 0;
  const desktopShow = (
    <>
      <SectionLabel>{t("display.show")}</SectionLabel>
      <Toggle label={t("display.body")} checked={bodyOn} onChange={(on) => setHazeLayer(store, on)} />
      <Toggle label={t("display.labels")} checked={v.look.groupLabels} onChange={(on) => setLook(store, { groupLabels: on })} />
      {linesOn ? <Toggle label={t("display.allLinks")} checked={v.look.lines === "all"} onChange={(on) => setLook(store, { lines: linesWithAll(on) })} /> : null}
      {featureOn("ask") ? <CountToggle label={t("display.agentConversations")} count={counts.agent} checked={v.layers.askHistory} onChange={(on) => setLayer(store, "askHistory", on)} /> : null}
      <Toggle label={t("display.searchOnStage")} checked={appearance.searchOnStage !== false} onChange={(on) => void s.settings.update((d) => void (d.appearance.searchOnStage = on)).catch(() => undefined)} />
    </>
  );
  const desktopMotion = (
    <>
      <SectionLabel>{t("display.motion")}</SectionLabel>
      <Toggle label={t("display.turning")} checked={rotationOn(v.motion)} onChange={(on) => setRotation(store, on)} />
      <Slider label={t("display.speed")} value={v.motion.speed} min={MOTION_SPEED_RANGE[0]} max={MOTION_SPEED_RANGE[1]} step={0.01} ariaScale={100} format={pct} onInput={(x) => setMotion(store, { speed: clampSpeed(x) })} />
      <Toggle label={t("display.keepUpright")} checked={v.motion.keepUpright || flat} disabled={flat} hint={t("display.keepUprightNote")} onChange={(x) => setMotion(store, { keepUpright: x })} />
    </>
  );
  const desktopDrawn = (
    <>
      <SectionLabel>{t("display.drawn")}</SectionLabel>
      {linesOn ? <Toggle label={t("display.links")} checked={v.look.lines !== "off"} onChange={(on) => setLook(store, { lines: linesWithLinks(v.look.lines, on) })} /> : null}
      {linesOn ? <Slider label={t("display.scaffold")} value={v.look.stemStrength} min={0} max={1} step={0.01} ariaScale={100} format={pct} onInput={(x) => setLook(store, { stemStrength: x })} /> : null}
      {dotSizeSlider}
    </>
  );
  const appearanceBlock = (
    <>
      <button type="button" class={`cx-display-disclosure${appearanceOpen ? " is-open" : ""}`} aria-expanded={appearanceOpen} onClick={() => setAppearanceOpen(!appearanceOpen)}>
        <span>{t("display.appearance")}</span>
        <Icon name="chevron" class="cx-select-caret-icon" />
      </button>
      {appearanceOpen ? colourLook : null}
    </>
  );
  const moreBlock = (
    <>
      <SectionLabel>{t("display.look")}</SectionLabel>
      {featureOn("chartPage") ? <Toggle label={t("display.chart")} checked={chartSheetOpen(ui.sheet)} onChange={() => toggleChartPage(store)} /> : null}
      <Segmented label={t("display.motionStyle")} value={v.motion.mode} options={motionOptions(v.pose)} onChange={(x) => setMotion(store, { mode: x })} />
      <Toggle label={t("display.pauseWhilePointing")} checked={v.motion.pauseWhilePointing} onChange={(x) => setMotion(store, { pauseWhilePointing: x })} />
      {linesSelect}
      {namesForced ? <p class="cx-popover-foot">{t("display.namesForNote")}</p> : null}
      {pointsSection}
      <div class="cx-display-tools">
        <button type="button" class="cx-display-tool" onClick={() => s.bus.emit("camera:fly-to", { viewId: leaf.viewId, home: true })}>
          <Icon name="home" />
          <span>{t("tools.home")}</span>
        </button>
        <button type="button" class="cx-display-tool" onClick={() => toggleImmersive(store)}>
          <Icon name="immersive" />
          <span>{t("tools.immersive")}</span>
        </button>
      </div>
      {tooltipSection}
      <SectionLabel>{t("compass.label")}</SectionLabel>
      <div class="cx-display-scope">
        <ScopePicker />
      </div>
    </>
  );
  const toggleExpanded = () => s.device.update((d) => (desktop ? setDisplayCompact(d, expanded) : setDisplayExpanded(d, !expanded)));
  const sampleOn = s.sandbox.value;
  const links = (
    <nav class="cx-display-links" aria-label={t("display.footerLabel")}>
      <button
        type="button"
        class="cx-display-link"
        onClick={() => {
          close();
          startTour(s, shell);
        }}
      >
        {t("display.footerTour")}
      </button>
      {featureOn("sampleRecord") ? (
        <button type="button" class="cx-display-link" onClick={() => s.bus.emit("command", { viewId: leaf.viewId, id: "toggle-sample" })}>
          {t(sampleOn ? "display.footerSampleLeave" : "display.footerSample")}
        </button>
      ) : null}
    </nav>
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  useSnapClip(scrollRef);
  return (
    <Popover
      id="display"
      label={t("display.title")}
      class={`cx-display${collapsed ? " is-collapsed" : ""}`}
      style={desktop ? undefined : { right: `${g.inset + g.tools.w + g.popover.gapToTools}px`, top: `${g.tools.top}px` }}
      onClose={close}
    >
      <header class={panelTitleClass(busy)}>
        <IconButton icon="chevron" class={`cx-display-collapse${collapsed ? " is-collapsed" : ""}`} label={t(collapsed ? "display.expand" : "display.collapse")} onClick={() => setCollapsed(!collapsed)} />
        <h3>{t("display.title")}</h3>
        <IconButton icon="reset" label={t("display.reset")} onClick={() => resetDisplayWithUndo(s, leaf, shell)} />
        <IconButton icon="close" label={t("display.close")} onClick={close} />
      </header>
      {collapsed ? null : <div class="cx-display-scroll" ref={scrollRef}>
        <Reflow reduced={reduced}>
          <div class="cx-popover-body">
            {desktop ? (
              <>
                {formSection}
                {groupsSection}
                {colourSection}
                <Fade show={expanded} reduced={reduced}>
                  {desktopShow}
                  {desktopMotion}
                </Fade>
                {desktopDrawn}
                {appearanceBlock}
                <Fade show={expanded} reduced={reduced}>
                  {moreBlock}
                </Fade>
              </>
            ) : (
              <>
                <ViewSwitch />
                {pointsOn ? <Slider label={t("display.scatter")} value={v.look.scatter} min={SCATTER_RANGE[0]} max={SCATTER_RANGE[1]} step={0.01} ariaScale={100} format={pct} onInput={(x) => setLook(store, { scatter: x })} /> : null}
                {namesSelects}
                {linesSelect}
                <Toggle label={t("display.keepUpright")} checked={v.motion.keepUpright || flat} disabled={flat} hint={t("display.keepUprightNote")} onChange={(x) => setMotion(store, { keepUpright: x })} />
                <Fade show={expanded} reduced={reduced}>
                  {colourLook}
                  {colourSection}
                  {showSection}
                  {pointsSection}
                  {threadsSlider}
                  {motionSection}
                  {orderRow}
                  <Fade show={groupingShown(v)} reduced={reduced}>
                    <SectionLabel>{t("display.grouping")}</SectionLabel>
                    <Fade show={recordOn} reduced={reduced}>
                      <Toggle label={t("display.split")} checked={v.splitGroups} onChange={(on) => setSplitGroups(store, on)} />
                    </Fade>
                    {dimRow(split ? t("display.notesBy") : t("display.groupBy"), dimLabel(v.groupBy), pickNotes)}
                    <Fade show={split} reduced={reduced}>
                      {dimRow(t("display.recordBy"), v.groupByRecord ? dimLabel(v.groupByRecord) : t("chart.sameAsNotes"), pickRecord)}
                    </Fade>
                    <Toggle label={t("display.groupNames")} checked={v.look.groupLabels} onChange={(x) => setLook(store, { groupLabels: x })} />
                  </Fade>
                  {tooltipSection}
                </Fade>
                <button type="button" class="cx-display-more" aria-expanded={expanded} onClick={toggleExpanded}>
                  {t(expanded ? "display.fewerControls" : "display.allControls")}
                </button>
              </>
            )}
            {feed.governor > 0 ? <p class="cx-performance">{t("display.performance")}</p> : null}
          </div>
        </Reflow>
      </div>}
      {collapsed ? null : <footer class="cx-display-foot">
        {links}
        <div class="cx-display-foot-row">
          <button type="button" class="cx-display-link" onClick={() => resetDisplayWithUndo(s, leaf, shell)}>
            {t("display.footerReset")}
          </button>
          {desktop ? (
            <button type="button" class="cx-display-toggle" aria-expanded={expanded} onClick={toggleExpanded}>
              {t(expanded ? "display.fewerOptions" : "display.moreOptions")}
            </button>
          ) : null}
        </div>
        {desktop ? null : <p class="cx-popover-foot">{t("display.onlyThisView")}</p>}
      </footer>}
    </Popover>
  );
}
