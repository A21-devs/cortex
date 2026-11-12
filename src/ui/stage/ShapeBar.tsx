/**
 * Shape bar (CORTEX-UX §5.4, §6.12, §5.29): a 40 px glass bar (stage-local right 16, top 12): body icon + "Body",
 * a 132 px scrubbable slider (ticks at 25/50/75%; dragging scrubs the morph live; releasing within 6% of an end
 * snaps there in 150 ms; clicking an end label animates there in 1.4 s; double-click on the thumb toggles ends;
 * ←/→ 5%, Shift 1%, Home/End), the target icon + name ("Groups", or "Chart" in P1), a divider, the picker ("by
 * Area ▾" with the Layout section Bubbles · Tree · Along the spine · Strata; or the chart catalogue grouped
 * Compare / Over time / Rhythm / Connections, phase-gated) and an overflow menu (⋯) with Pose (Standing · Lying),
 * At the core and Placement: shape controls live only here (ORIG-13). A warning dot sits on the picker when the
 * grouping has groups under 30; its menu then opens with "‹k› groups have fewer than 30 items" and "Fold groups
 * under 30 into Other" (ORIG-18; no sentence banner). role="slider" with aria-valuetext "Body" / "Halfway to
 * Groups" / "Groups". At S the bar collapses to a "Shape" button that opens it as a popover. Owner: E11.
 */
import type { JSX } from "preact";
import { builtinDim, GROUP_LAYOUTS, ROLE_DIM, type DimId, type GroupLayout } from "../../shared/dims";
import { BUILD_PHASE, featureOn, type Phase } from "../../shared/features";
import type { ChartSpec } from "../../shared/protocol/worker";
import type { Pose } from "../../shared/settings";
import { CHART_CATALOGUE, CHART_GROUP_ORDER, chartDef, type ChartDef, type ChartId, type ShapeKind } from "../../shared/views";
import { keepChartCard, openPage, setGroupBy, setMorph, setMotion, setShape, setView } from "../../state/actions";
import type { CortexStore } from "../../state/store";
import { chartCardFits, SHELL } from "../breakpoints";
import { isReducedMotion, useLeaf, useServices, useShell, type Shell } from "../context";
import { t } from "../copy";
import { dimLabel } from "../valueLabels";
import { motionModeFor } from "../keymap";
import { Icon, IconButton } from "../primitives/buttons";
import { Popover, Slider } from "../primitives/controls";
import { openDimMenu } from "../primitives/dimMenu";
import { showMenu, type MenuItemSpec } from "../primitives/menu";
import { requestHint } from "./Hints";

export function morphValueText(morph: number, target: ShapeKind): string {
  const name = target === "chart" ? t("shape.chart") : t("shape.groups");
  if (morph <= SHELL.timing.snapWithin) return t("shape.body");
  if (morph >= 1 - SHELL.timing.snapWithin) return name;
  return t("shape.halfway", { target: name });
}

/** Snap within 6% of an end on release. */
export function snapMorph(m: number): number {
  const w = SHELL.timing.snapWithin;
  return m <= w ? 0 : m >= 1 - w ? 1 : m;
}

/** CSS cubic-bezier easing as a function of t ∈ [0, 1] (Newton iterations with a bisection fallback). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sy = (u: number) => ((ay * u + by) * u + cy) * u;
  const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let u = x;
    for (let i = 0; i < 8; i++) {
      const err = sx(u) - x;
      if (Math.abs(err) < 1e-6) return sy(u);
      const d = dx(u);
      if (Math.abs(d) < 1e-6) break;
      u -= err / d;
    }
    let lo = 0;
    let hi = 1;
    u = x;
    for (let i = 0; i < 30; i++) {
      const v = sx(u);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return sy(u);
  };
}

/** --cx-ease-inout. */
export const easeInOut = cubicBezier(0.62, 0.02, 0.33, 0.98);

const running = new WeakMap<CortexStore, () => void>();

/** Stop a programmatic morph (the user grabbed the slider). */
export function cancelMorph(store: CortexStore): void {
  running.get(store)?.();
  running.delete(store);
}

/**
 * Animate the morph to `to` over `ms` with --cx-ease-inout, frame by frame in the view's window. Under reduced
 * motion (or ms ≤ 0) the value jumps. Returns a cancel function.
 */
export function animateMorph(store: CortexStore, to: number, opts: { ms: number; win: Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame"> | null; reduced: boolean; now?: () => number }): () => void {
  cancelMorph(store);
  const from = store.get("view").morph;
  const target = Math.max(0, Math.min(1, to));
  const raf = opts.win && typeof opts.win.requestAnimationFrame === "function" ? opts.win : null;
  if (opts.reduced || opts.ms <= 0 || !raf || Math.abs(target - from) < 1e-4) {
    setMorph(store, target);
    return () => undefined;
  }
  const now = opts.now ?? (() => Date.now());
  const start = now();
  let handle = 0;
  let live = true;
  const step = () => {
    if (!live) return;
    const k = Math.min(1, (now() - start) / opts.ms);
    setMorph(store, from + (target - from) * easeInOut(k));
    if (k < 1) handle = raf.requestAnimationFrame(step);
    else {
      live = false;
      running.delete(store);
    }
  };
  const cancel = () => {
    if (!live) return;
    live = false;
    raf.cancelAnimationFrame(handle);
  };
  running.set(store, cancel);
  handle = raf.requestAnimationFrame(step);
  return cancel;
}

/** How long a click's morph takes: out to Groups or a chart is quicker than the way back to the figure. */
export function shapeMsFor(from: number, to: number): number {
  return to < from ? SHELL.timing.shapeBackMs : SHELL.timing.shapeMs;
}

/** The morph animator bound to a leaf (keyboard G, end labels, snapping). */
export function morphAnimator(store: CortexStore, shell: Shell, reduced: () => boolean): (to: number, ms?: number) => void {
  return (to, ms) => void animateMorph(store, to, { ms: ms ?? shapeMsFor(store.get("view").morph, to), win: shell.win, reduced: reduced() });
}

const PHASES: readonly Phase[] = ["P0", "P1", "P2"];

/** A chart is offered once its phase has shipped (and the Chart shape itself, P1). */
export function chartAvailable(def: ChartDef, phase: Phase = BUILD_PHASE): boolean {
  return featureOn("chartShape", phase) && PHASES.indexOf(def.phase) <= PHASES.indexOf(phase);
}

/** A chart spec for a newly chosen chart: axes kept from the current chart, otherwise seeded by its group. */
export function chartSpecFor(id: ChartId, prev: ChartSpec | null, groupBy: DimId): ChartSpec {
  const def = chartDef(id);
  if (prev) return { ...prev, chart: id };
  const x = def.group === "time" ? { dim: "week" as DimId, sort: "date" as const } : def.group === "rhythm" ? { dim: "hour" as DimId, sort: "date" as const } : { dim: groupBy, sort: "count" as const };
  return { chart: id, x, y: null, colour: null, size: "entries", filter: [], hideNoValue: false, merges: {}, combined: {}, top: 20, options: {} };
}

export function chartMenuItems(current: ChartId | null): MenuItemSpec<ChartId>[] {
  const items: MenuItemSpec<ChartId>[] = [];
  for (const g of CHART_GROUP_ORDER) {
    for (const def of CHART_CATALOGUE.filter((c) => c.group === g && chartAvailable(c))) items.push({ value: def.id, label: t(`charts.${def.id}`), group: g, groupLabel: t(`chart.${g}`), checked: def.id === current });
  }
  return items;
}

/** Layouts offered for a dimension (Bubbles is P0; Tree, Along the spine and Strata ship in P1). */
export function layoutsFor(dim: DimId): GroupLayout[] {
  const allowed = builtinDim(dim)?.layouts ?? GROUP_LAYOUTS;
  return GROUP_LAYOUTS.filter((l) => allowed.includes(l) && (l === "bubbles" || featureOn("groupLayouts")));
}

export const LAYOUT_LABEL: Record<GroupLayout, "shape.bubbles" | "shape.tree" | "shape.spine" | "shape.strata" | "shape.wheel" | "shape.grid"> = {
  bubbles: "shape.bubbles",
  tree: "shape.tree",
  spine: "shape.spine",
  strata: "shape.strata",
  wheel: "shape.wheel",
  grid: "shape.grid",
};

/** Layout-section items for the grid's marks (one of two, checked). */
export function gridMarkItems(current: "spheres" | "rows"): MenuItemSpec[] {
  return (["spheres", "rows"] as const).map((m) => ({ value: `gridMarks:${m}`, label: t(m === "rows" ? "shape.gridRows" : "shape.gridSpheres"), checked: current === m, group: "gridMarks", groupLabel: t("shape.gridMarks") }));
}

/** Change the pose; the motion follows when it was the old pose's own motion (Spin standing, Drift lying). */
export function setPose(store: CortexStore, pose: Pose): void {
  const v = store.get("view");
  if (v.pose === pose) return;
  store.batch(() => {
    setView(store, "pose", pose);
    if (v.motion.mode === motionModeFor(v.pose)) setMotion(store, { mode: motionModeFor(pose) });
  });
}

export function overflowItems(v: { pose: Pose; core: "oldest" | "newest" | "largest"; placement: "area" | "role" }): MenuItemSpec[] {
  return [
    { value: "pose:standing", label: t("shape.standing"), checked: v.pose === "standing", group: "pose", groupLabel: t("shape.pose") },
    { value: "pose:lying", label: t("shape.lying"), checked: v.pose === "lying", group: "pose", groupLabel: t("shape.pose") },
    { value: "core:oldest", label: t("shape.oldest"), checked: v.core === "oldest", group: "core", groupLabel: t("shape.core") },
    { value: "core:newest", label: t("shape.newest"), checked: v.core === "newest", group: "core", groupLabel: t("shape.core") },
    { value: "core:largest", label: t("shape.largest"), checked: v.core === "largest", group: "core", groupLabel: t("shape.core") },
    { value: "placement:area", label: t("shape.byArea"), checked: v.placement === "area", group: "placement", groupLabel: t("shape.placement") },
    { value: "placement:role", label: t("shape.byRole"), checked: v.placement === "role", group: "placement", groupLabel: t("shape.placement") },
  ];
}

export function applyOverflow(store: CortexStore, value: string): void {
  const [kind, arg] = value.split(":");
  if (kind === "pose" && (arg === "standing" || arg === "lying")) setPose(store, arg);
  else if (kind === "core" && (arg === "oldest" || arg === "newest" || arg === "largest")) setView(store, "core", arg);
  else if (kind === "placement" && (arg === "area" || arg === "role")) {
    setView(store, "placement", arg);
    // By role: the key lists the finer brain regions (Function (anatomy)) while the grouping is still the default Area, and goes back with By area.
    const by = store.get("view").groupBy;
    if (arg === "role" && by === "space") setGroupBy(store, ROLE_DIM);
    else if (arg === "area" && by === ROLE_DIM) setGroupBy(store, "space");
  }
}

/** Fold groups under 30 into Other, with a toast and Undo. */
export function foldSparse(store: CortexStore, shell: Shell): void {
  const before = store.get("view").colour;
  setView(store, "colour", { ...before, fold: true });
  const undoId = shell.pushUndo(() => setView(store, "colour", before));
  shell.toast({ kind: "change", text: t("shape.foldSparse"), undo: () => void shell.runUndo(undoId) });
}

/** `sliderOnly` (the Display panel's FORM section): the two ends, the slider and the pose menu, without the group picker. */
export function ShapeControls(p: { inPopover?: boolean; sliderOnly?: boolean }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const store = leaf.store;
  const v = store.slices.view.value;
  const settings = s.settings.value;
  const reduced = isReducedMotion(settings.appearance.motion, shell.systemReducedMotion.value);
  const chartOn = featureOn("chartShape");
  const target: ShapeKind = v.shape === "chart" && chartOn ? "chart" : "groups";
  const sparse = target === "groups" || target === "chart" ? shell.feed.value.sparse : [];
  const go = (to: number, ms: number = shapeMsFor(v.morph, to)) => {
    if (v.shape === "body" || (v.shape === "chart" && !chartOn)) setShape(store, target);
    void animateMorph(store, to, { ms, win: shell.win, reduced });
  };
  const bp = store.slices.ui.value.breakpoint;
  const onPicker = (anchor: HTMLElement) => {
    const lead: MenuItemSpec[] = sparse.length > 0 ? [{ value: "sparse:label", label: sparse.length === 1 ? t("shape.sparseOne") : t("shape.sparse", { k: sparse.length }), disabled: true, group: "sparse" }, { value: "sparse:fold", label: t("shape.foldSparse"), group: "sparse", icon: "triangle-alert" }] : [];
    if (target === "chart") {
      showMenu([...lead, ...chartMenuItems(v.chart?.chart ?? null)] as MenuItemSpec[], anchor, (x) => {
        if (x === "sparse:fold") return foldSparse(store, shell);
        if (!CHART_CATALOGUE.some((c) => c.id === x)) return;
        setView(store, "chart", chartSpecFor(x as ChartId, v.chart, v.groupBy));
        setShape(store, "chart");
        void animateMorph(store, 1, { ms: shapeMsFor(store.get("view").morph, 1), win: shell.win, reduced });
        if ((bp === "XL" || bp === "L") && featureOn("chartPage")) (chartCardFits(store.get("ui")) ? keepChartCard(store) : openPage(store, "chart"));
      });
      return;
    }
    const layouts = layoutsFor(v.groupBy);
    const extras: MenuItemSpec[] = [
      ...lead,
      ...layouts.map((l) => ({ value: `layout:${l}`, label: t(LAYOUT_LABEL[l]), checked: v.layout === l, group: "layout", groupLabel: t("shape.layout") })),
      // The Month grid's marks: spheres, or banded dash rows that keep the row colours.
      ...(layouts.includes("grid") ? gridMarkItems(v.layoutOptions.gridMarks) : []),
    ];
    openDimMenu(anchor, {
      app: s.app,
      settings,
      current: v.groupBy,
      onPick: (dim) => {
        setGroupBy(store, dim);
        if (!layoutsFor(dim).includes(v.layout)) setView(store, "layout", "bubbles");
      },
      extras,
      onExtra: (x) => {
        if (x === "sparse:fold") foldSparse(store, shell);
        else if (x.startsWith("layout:")) setView(store, "layout", x.slice(7) as GroupLayout);
        else if (x.startsWith("gridMarks:")) setView(store, "layoutOptions", { ...store.get("view").layoutOptions, gridMarks: x.slice(10) === "rows" ? "rows" : "spheres" });
      },
    });
  };
  const pickerLabel = target === "chart" ? (v.chart ? t(`charts.${v.chart.chart}`) : t("chart.gallery")) : t("shape.by", { dim: dimLabel(v.groupBy) });
  return (
    <div class={`cx-shape-controls${p.inPopover ? " in-popover" : ""}${p.sliderOnly ? " is-slider-only" : ""}`}>
      <button type="button" class={`cx-shape-end${v.morph < 0.5 ? " is-on" : ""}`} onClick={() => go(0)}>
        <Icon name="body" />
        <span>{t("shape.body")}</span>
      </button>
      <Slider
        bare
        class="cx-shape-slider"
        label={t("shape.overflow")}
        value={v.morph}
        min={0}
        max={1}
        step={0.01}
        ariaScale={100}
        ticks={[0.25, 0.5, 0.75]}
        valueText={(m) => morphValueText(m, target)}
        onDragStart={(): void => {
          const el = shell.root?.querySelector<HTMLElement>(".cx-shapebar");
          if (el) requestHint(s, shell, "shape", el, "below");
        }}
        onInput={(m) => {
          cancelMorph(store);
          if (v.shape === "body" || (v.shape === "chart" && !chartOn)) setShape(store, target);
          setMorph(store, m);
        }}
        onRelease={(m) => {
          const snapped = snapMorph(m);
          if (snapped !== m) go(snapped, SHELL.timing.snapMs);
        }}
        onThumbDoubleClick={() => go(v.morph >= 0.5 ? 0 : 1)}
      />
      <button type="button" class={`cx-shape-end${v.morph >= 0.5 ? " is-on" : ""}`} onClick={() => go(1)}>
        <Icon name={target === "chart" ? "chart" : "groups"} />
        <span>{target === "chart" ? t("shape.chart") : t("shape.groups")}</span>
      </button>
      {p.sliderOnly ? null : (
        <>
          <span class="cx-vsep" aria-hidden="true" />
          <button type="button" class="cx-shape-picker" aria-haspopup="menu" onClick={(e) => onPicker(e.currentTarget as HTMLElement)}>
            <span>{pickerLabel}</span>
            {sparse.length > 0 ? <span class="cx-warn-dot" title={t("shape.sparse", { k: sparse.length })} aria-label={t("shape.sparse", { k: sparse.length })} /> : null}
            <Icon name="chevron" class="cx-select-caret-icon" />
          </button>
        </>
      )}
      <IconButton icon="more" label={t("shape.overflow")} hasPopup="menu" onClick={(e) => showMenu(overflowItems(v), e.currentTarget as HTMLElement, (x) => applyOverflow(store, x))} />
    </div>
  );
}

export function ShapeBar(): JSX.Element {
  const leaf = useLeaf();
  const shell = useShell();
  const bp = leaf.store.slices.ui.value.breakpoint;
  if (bp === "S") {
    const open = shell.shapeOpen.value;
    return (
      <div class="cx-shapebar is-collapsed" data-cx-overlay="shape">
        <IconButton icon="body" size={32} label={t("shape.button")} pressed={open} hasPopup="dialog" expanded={open} popoverToggle="shape" onClick={() => (shell.shapeOpen.value = !open)} />
        {open ? (
          <Popover id="shape" label={t("shape.button")} class="cx-shape-popover" onClose={() => (shell.shapeOpen.value = false)}>
            <ShapeControls inPopover />
          </Popover>
        ) : null}
      </div>
    );
  }
  return (
    <div class="cx-shapebar cx-glass" role="group" aria-label={t("shape.button")} data-cx-overlay="shape">
      <ShapeControls />
    </div>
  );
}
