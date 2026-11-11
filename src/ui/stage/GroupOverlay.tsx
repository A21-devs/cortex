/**
 * Groups shape overlay: what the arrangement draws besides the points. Group names above their spheres, the boxed
 * years and month names of the calendar layouts, ring outlines, month dividers and the tree's leaders. The worker
 * puts all of it in the arrangement's overlay model; charts draw their own model in ChartOverlay, this draws the
 * Groups model. It shows once the points have settled and the morph has passed 0.85 (CORTEX-UX §6.12), follows
 * the camera at up to 30 Hz while it is visible and does nothing while it is not.
 */
import type { JSX } from "preact";
import { useEffect, useMemo, useRef } from "preact/hooks";
import { effect, signal } from "@preact/signals";
import { project, projectOverlay } from "../../render/overlay";
import { parseDateDim, type DimId } from "../../shared/dims";
import { RECORD_MARK_PREFIX, type LegendModel, type LegendRow, type OverlayItem, type OverlayModel, type RegionLabel } from "../../shared/protocol/worker";
import type { CortexStore } from "../../state/store";
import { isReducedMotion, useLeaf, useServices, useShell } from "../context";
import { t } from "../copy";
import { SHELL } from "../breakpoints";
import { categoryName } from "./ChartOverlay";
import { RichnessHint } from "./Hints";
import { groupKey, rowDimension, traceGroup } from "./KeyBar";
import { declutterNames, densityCap, nameNearPointer, nameRect, namesForFilter, NAME_GAP_PX, type NameBox, type NamePlacement } from "./nameDeclutter";

/** The overlay shows once the morph has passed this. */
export const GROUP_OVERLAY_MORPH = 0.85;
/** Group names drawn at most (the largest groups); the calendar's years and months are always drawn. */
export const MAX_GROUP_LABELS = 60;
/** Brain-region labels show while the figure is (still) the body. */
export const REGION_MORPH_MAX = 0.05;
/** Length of a region label's drop line and the number of ticks along it (screen px). */
export const DROP_LINE_PX = 120;
export const DROP_LINE_TICKS = 5;
/** How close (px) the pointer must come to a hidden name's sphere to bring the name back. */
export const NAME_REACH_PX = 34;
const FRAME_MS = 1000 / 30;
const SETTLE_MS = 750;
const SETTLE_REDUCED_MS = 120;

/** The label items to draw: every label of a model, except the names of all but the largest `cap` groups. */
export function pickGroupLabels(model: OverlayModel, cap: number = MAX_GROUP_LABELS): Extract<OverlayItem, { type: "label" }>[] {
  const counts = new Map(model.marks.map((m) => [m.key, m.count] as const));
  const keep = new Set([...model.marks].sort((a, b) => b.count - a.count).slice(0, cap).map((m) => m.key));
  const out: Extract<OverlayItem, { type: "label" }>[] = [];
  for (const it of model.items) {
    if (it.type !== "label" || it.text === "") continue;
    if (it.key !== undefined && counts.has(it.key) && !keep.has(it.key)) continue;
    out.push(it);
  }
  return out;
}

/** A label that stands for a group: the legend row to trace (the KeyBar path) and the dimension it lives in. */
export interface GroupLabelTarget {
  dim: string;
  row: LegendRow;
}

/**
 * The group a Groups-shape label names, or null for labels that are only axis text (month names). A placed group's
 * label carries its key; a year box of the calendar layouts has no group of its own and stands for the year row of
 * the month tree. The legend's own row is used when the colour key lists it, so a click traces exactly what the chip does.
 */
export function groupLabelTarget(item: Extract<OverlayItem, { type: "label" }>, marks: readonly { key: string }[], notesDim: DimId, legend: LegendModel | null, recordDim: DimId | null = null): GroupLabelTarget | null {
  const full = item.key;
  if (full === undefined || full === "" || item.text === "") return null;
  // The record family of a split layout: its keys carry a prefix and its dimension is the record's own.
  const isRecord = full.startsWith(RECORD_MARK_PREFIX);
  const key = isRecord ? full.slice(RECORD_MARK_PREFIX.length) : full;
  const groupBy: DimId = isRecord ? (recordDim ?? notesDim) : notesDim;
  const fromLegend = (dim: string, k: string): LegendRow | undefined => legend?.sections.find((s) => String(s.dim) === dim)?.rows.find((r) => r.key === k);
  const synthetic = (k: string, aggregate: boolean): LegendRow => ({ key: k, name: item.text, slot: 0, bucket: "value", rgb: [128, 128, 128], notes: 0, record: 0, hidden: false, depth: 0, expandable: false, ...(aggregate ? { aggregate: true } : {}) });
  if (marks.some((m) => m.key === full)) return { dim: groupBy, row: fromLegend(groupBy, key) ?? synthetic(key, false) };
  if (/^\d{4}$/.test(key) && parseDateDim(groupBy)?.grain === "month") return { dim: groupBy, row: fromLegend(groupBy, key) ?? synthetic(key, true) };
  return null;
}

/** The preview key (the chip's `dim=value`) of a label's group. */
export function groupLabelPreviewKey(target: GroupLabelTarget): string {
  return groupKey(rowDimension(target.dim, target.row), target.row.key);
}

/** Hover a label: preview its group after the chip's delay; leave it: clear that preview (and only that one). */
function previewOf(store: CortexStore, key: string, on: boolean): void {
  if (on) store.update("ui", { preview: { kind: "group", key } });
  else if (store.get("ui").preview?.key === key) store.update("ui", { preview: null });
}

interface Handle {
  renderer: { overlay(): OverlayModel | null; regionLabels?: readonly RegionLabel[]; camera: { camera: Parameters<typeof project>[1] } } | null;
}

interface LabelEl {
  el: HTMLElement;
  at: [number, number, number];
  align: "left" | "center" | "right";
  key: string;
  /** The group's entry count (bigger names are placed first); `fixed` names (years, axis text) are never hidden. */
  weight: number;
  fixed: boolean;
  /** The chip's `dim=value` preview key of a group name, for the hovered, previewed and traced checks. */
  pk: string | null;
  /** Measured size in px (0 until the first draw). */
  w: number;
  h: number;
  /** The group's centroid (the middle of its sphere), where the leader from a boxed name ends. */
  centre?: [number, number, number];
}

/** A hairline leader is drawn when the name stands this far (px) from the group's centroid, or was nudged. */
export const LEADER_MIN_PX = 26;

/** The leader from a placed name's box to its group's centroid, or null when the name sits close enough to read as attached. */
export function leaderFor(box: { x: number; y: number; w: number; h: number; align: "left" | "center" | "right" }, dy: number, centre: { x: number; y: number }, min: number = LEADER_MIN_PX): { x0: number; y0: number; x1: number; y1: number } | null {
  const r = nameRect(box, dy);
  const ex = Math.max(r.x0, Math.min(r.x1, centre.x));
  const ey = Math.max(r.y0, Math.min(r.y1, centre.y));
  const far = Math.hypot(centre.x - ex, centre.y - ey) >= min;
  return far || dy !== 0 ? { x0: ex, y0: ey, x1: centre.x, y1: centre.y } : null;
}

export function GroupOverlay(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const regionsRef = useRef<HTMLDivElement>(null);
  // The smallest value group of a label grouping, from the arrangement: the richness hint reads it.
  const thinnest = useMemo(() => signal<number | null>(null), []);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const host = labelsRef.current;
    const regionHost = regionsRef.current;
    if (!root || !canvas || !host || !regionHost) return undefined;
    const view = leaf.store.slices.view;
    const doc = host.ownerDocument;
    let model: OverlayModel | null = null;
    let settled = false;
    let mode: "off" | "groups" | "regions" = "off";
    let regions: RegionLabel[] = [];
    let regionEls: LabelEl[] = [];
    let labelsOn = true;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let raf: number | null = null;
    let lastAt = 0;
    let lastSig = "";
    let els: LabelEl[] = [];
    let previewing: string | null = null;
    // Name declutter: the name under the pointer, the one the pointer is near, the last plain layout and boxes.
    let hoverKey: string | null = null;
    let pointerKey: string | null = null;
    let winSig = "";
    let lastNameSig = "";
    let lastBoxes: NameBox[] = [];
    let lastBase: Map<string, NamePlacement> = new Map();
    let moveOn = false;
    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    const endPreview = (): void => {
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = null;
      if (previewing !== null) previewOf(leaf.store, previewing, false);
      previewing = null;
    };

    const stageCanvas = (): (HTMLCanvasElement & { cortexController?: Handle }) | null => root.closest(".cx-canvas-host")?.querySelector<HTMLCanvasElement & { cortexController?: Handle }>("canvas.cx-canvas") ?? null;
    const reduced = (): boolean => isReducedMotion(s.settings.value.appearance.motion, shell.systemReducedMotion.value);

    const clear = (): void => {
      endPreview();
      host.replaceChildren();
      els = [];
      lastSig = "";
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    };

    const setHover = (key: string | null): void => {
      if (hoverKey === key) return;
      hoverKey = key;
      lastSig = "";
      if (mode !== "off") draw();
    };

    /** Names that always show: hovered, previewed from a chip or strip, or traced (a group token). */
    const isWinner = (l: LabelEl, ui: { preview: { kind: string; key: string } | null; tokens: readonly { id: string }[] }): boolean =>
      l.key === hoverKey || l.key === pointerKey || (l.pk !== null && ((ui.preview?.kind === "group" && ui.preview.key === l.pk) || ui.tokens.some((tk) => tk.id === `group:${l.pk}`)));

    /** Lit: traced (a group token) or previewed from a chip or strip. */
    const isLit = (l: LabelEl, ui: { preview: { kind: string; key: string } | null; tokens: readonly { id: string }[] }): boolean =>
      l.pk !== null && ((ui.preview?.kind === "group" && ui.preview.key === l.pk) || ui.tokens.some((tk) => tk.id === `group:${l.pk}`));

    /**
     * Project, measure and declutter a list of names, then write their transforms: bigger first, a collision nudges a
     * line up or down, and a name that still collides hides until the pointer comes near its sphere.
     */
    /** The last groups layout: each name's projected anchor, nudge and verdict (the leaders read it). */
    let lastPlaced: { l: LabelEl; x: number; y: number; dy: number; hidden: boolean }[] = [];
    const place = (list: readonly LabelEl[], cam: Parameters<typeof project>[1], width: number, height: number, groupsMode = false): void => {
      const ui = leaf.store.get("ui");
      const look = leaf.store.get("view").look;
      const live: { l: LabelEl; x: number; y: number; depth: number }[] = [];
      for (const l of list) {
        const p = project(l.at, cam, width, height);
        if (!p.visible) {
          l.el.style.display = "none";
          continue;
        }
        l.el.style.display = "";
        if (l.w === 0) {
          l.w = l.el.offsetWidth;
          l.h = l.el.offsetHeight;
        }
        live.push({ l, x: p.x, y: p.y, depth: p.depth });
      }
      const boxes: NameBox[] = live.map(({ l, x, y }) => ({ key: l.key, x, y, w: l.w, h: l.h, align: l.align, weight: l.weight, fixed: l.fixed, wins: l.key !== pointerKey && isWinner(l, ui), lit: isLit(l, ui), hovered: l.key === hoverKey }));
      // Names for (groups only): the filter re-runs with the lit set on every layout, so a trace or preview renames at once.
      const run = (bs: readonly NameBox[]): Map<string, NamePlacement> => {
        const kept = groupsMode ? namesForFilter(bs, look.namesFor) : bs;
        const m = declutterNames(kept, NAME_GAP_PX, groupsMode && look.density === "all");
        for (const b of bs) if (!m.has(b.key)) m.set(b.key, { dy: 0, hidden: true });
        return m;
      };
      const base = run(boxes);
      let final = base;
      if (pointerKey !== null && base.get(pointerKey)?.hidden) {
        final = run(boxes.map((b) => (b.key === pointerKey ? { ...b, wins: true, hovered: true } : b)));
      }
      lastBoxes = boxes;
      lastBase = base;
      lastPlaced = [];
      for (const { l, x, y, depth } of live) {
        const v = final.get(l.key);
        const ax = l.align === "left" ? 0 : l.align === "right" ? -100 : -50;
        l.el.style.visibility = v?.hidden ? "hidden" : "";
        l.el.style.opacity = String(Math.max(0.45, 1 - 0.55 * depth));
        l.el.style.transform = `translate(${x.toFixed(1)}px, ${(y + (v?.dy ?? 0)).toFixed(1)}px) translate(${ax}%, -50%)`;
        lastPlaced.push({ l, x, y, dy: v?.dy ?? 0, hidden: !!v?.hidden });
      }
    };

    const onPointerMove = (ev: PointerEvent): void => {
      const st = stageCanvas();
      if (!st) return;
      const r = st.getBoundingClientRect();
      const hit = nameNearPointer(lastBoxes, lastBase, ev.clientX - r.left, ev.clientY - r.top, NAME_REACH_PX);
      if (hit === pointerKey) return;
      pointerKey = hit;
      lastSig = "";
      draw();
    };
    const onPointerOut = (): void => {
      if (pointerKey === null) return;
      pointerKey = null;
      lastSig = "";
      draw();
    };
    const watchPointer = (on: boolean): void => {
      if (on === moveOn) return;
      const st = stageCanvas();
      if (!st) return;
      moveOn = on;
      if (on) {
        st.addEventListener("pointermove", onPointerMove);
        st.addEventListener("pointerleave", onPointerOut);
      } else {
        st.removeEventListener("pointermove", onPointerMove);
        st.removeEventListener("pointerleave", onPointerOut);
        pointerKey = null;
        hoverKey = null;
      }
    };

    const rebuild = (): void => {
      clear();
      if (!model) return;
      const groupBy = leaf.store.get("view").groupBy;
      const counts = new Map(model.marks.map((m) => [m.key, m.count] as const));
      const look = leaf.store.get("view").look;
      const centres = new Map(model.marks.map((m) => [m.key, [(m.bounds.min[0] + m.bounds.max[0]) / 2, (m.bounds.min[1] + m.bounds.max[1]) / 2, (m.bounds.min[2] + m.bounds.max[2]) / 2] as [number, number, number]] as const));
      for (const item of pickGroupLabels(model, densityCap(look.density, MAX_GROUP_LABELS))) {
        const target = groupLabelTarget(item, model.marks, groupBy, leaf.store.get("legend"), leaf.store.get("view").groupByRecord);
        const el = doc.createElement(target ? "button" : "span");
        el.className = `cx-axis-label is-${item.style}${target ? " is-link" : ""}`;
        // Kinds, map types, areas and sources go through the same names as the key (the worker's text is the fallback).
        el.textContent = target && !target.row.aggregate ? categoryName(target.dim as DimId, target.row.key, item.text) : item.text;
        if (item.chip) {
          // The record family of a split layout: a small suffix chip after the name.
          const chip = doc.createElement("span");
          chip.className = "cx-axis-chip";
          chip.textContent = item.chip === "record" ? t("shape.recordChip") : item.chip;
          el.appendChild(chip);
        }
        el.dataset.cxLabelKey = item.key ?? "";
        const key = item.key ?? `${item.text}@${item.at.join(",")}`;
        const entry: LabelEl = { el, at: item.at, align: item.align ?? "center", key, weight: counts.get(item.key ?? "") ?? 0, fixed: !counts.has(item.key ?? ""), pk: target ? groupLabelPreviewKey(target) : null, w: 0, h: 0, ...(centres.has(item.key ?? "") ? { centre: centres.get(item.key ?? "") as [number, number, number] } : {}) };
        el.addEventListener("pointerenter", () => setHover(key));
        el.addEventListener("pointerleave", () => setHover(null));
        if (target && el instanceof HTMLButtonElement) {
          // The same trace as the legend chip (Shift + click there); hover previews after the chip's delay.
          el.type = "button";
          const pk = groupLabelPreviewKey(target);
          el.addEventListener("click", () => {
            endPreview();
            traceGroup(leaf.store, target.dim, target.row);
          });
          el.addEventListener("pointerenter", () => {
            if (hoverTimer) clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => {
              previewing = pk;
              previewOf(leaf.store, pk, true);
            }, SHELL.timing.chipPreviewMs);
          });
          el.addEventListener("pointerleave", endPreview);
          el.addEventListener("blur", endPreview);
        }
        host.appendChild(el);
        els.push(entry);
      }
    };

    const draw = (): void => {
      const ctl = stageCanvas()?.cortexController;
      const cam = ctl?.renderer?.camera.camera;
      const stage = stageCanvas();
      if (mode === "off" || !cam || !stage || (mode === "groups" && !model)) return;
      const width = stage.clientWidth, height = stage.clientHeight;
      if (width <= 0 || height <= 0) return;
      const e = cam.matrixWorldInverse.elements.concat(cam.projectionMatrix.elements);
      const sig = `${e.join(",")},${width},${height}`;
      if (sig === lastSig) return;
      lastSig = sig;
      const dpr = shell.win.devicePixelRatio || 1;
      const w = Math.round(width * dpr), h = Math.round(height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = 1;
      const ink = getComputedStyle(canvas).getPropertyValue("--cx-stage-text-2").trim() || "#c3c8d1";
      ctx.strokeStyle = ink;
      for (const it of mode === "groups" ? projectOverlay(model, cam, width, height) : []) {
        if (it.type === "line") {
          ctx.globalAlpha = it.alpha;
          ctx.setLineDash(it.dashed ? [4, 3] : []);
          ctx.beginPath();
          ctx.moveTo(it.x0, it.y0);
          ctx.lineTo(it.x1, it.y1);
          ctx.stroke();
        } else if (it.type === "polyline") {
          ctx.globalAlpha = it.alpha;
          ctx.setLineDash([]);
          ctx.beginPath();
          for (let i = 0; i + 1 < it.points.length; i += 2) {
            if (i === 0) ctx.moveTo(it.points[0] as number, it.points[1] as number);
            else ctx.lineTo(it.points[i] as number, it.points[i + 1] as number);
          }
          if (it.closed) ctx.closePath();
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      if (mode === "regions") {
        // Each region label drops a thin vertical line with five small ticks (40% opacity), 120 px long.
        const half = 9;
        place(regionEls, cam, width, height);
        for (const l of regionEls) {
          const p = project(l.at, cam, width, height);
          if (!p.visible || l.el.style.visibility === "hidden") continue;
          if (!labelsOn) continue;
          ctx.globalAlpha = 0.4;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y + half);
          ctx.lineTo(p.x, p.y + half + DROP_LINE_PX);
          for (let i = 1; i <= DROP_LINE_TICKS; i++) {
            const ty = p.y + half + (DROP_LINE_PX * i) / DROP_LINE_TICKS;
            ctx.moveTo(p.x - 3, ty);
            ctx.lineTo(p.x + 3, ty);
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        return;
      }
      place(els, cam, width, height, true);
      if (labelsOn) {
        // Hairline leaders from the boxed names to their groups' centroids (a name that sits right over its sphere needs none).
        ctx.strokeStyle = ink;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        for (const pl of lastPlaced) {
          if (pl.hidden || !pl.l.centre) continue;
          const c = project(pl.l.centre, cam, width, height);
          if (!c.visible) continue;
          const ld = leaderFor({ x: pl.x, y: pl.y, w: pl.l.w, h: pl.l.h, align: pl.l.align }, pl.dy, c);
          if (!ld) continue;
          ctx.moveTo(ld.x0, ld.y0);
          ctx.lineTo(ld.x1, ld.y1);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
      }
    };

    const stopFrames = (): void => {
      if (raf !== null) shell.win.cancelAnimationFrame(raf);
      raf = null;
    };
    const startFrames = (): void => {
      if (raf !== null) return;
      const tick = (now: number): void => {
        raf = shell.win.requestAnimationFrame(tick);
        if (now - lastAt < FRAME_MS) return;
        lastAt = now;
        draw();
      };
      raf = shell.win.requestAnimationFrame(tick);
    };

    /** Region labels (Placement › By role): one boxed name per used brain region, following its projected centroid. */
    const rebuildRegions = (): void => {
      regionHost.replaceChildren();
      regionEls = [];
      for (const r of regions) {
        const el = doc.createElement("span");
        el.className = "cx-axis-label is-box is-region";
        el.textContent = t(`regions.${r.key}` as Parameters<typeof t>[0]);
        el.dataset.cxRegion = r.key;
        regionHost.appendChild(el);
        el.addEventListener("pointerenter", () => setHover(r.key));
        el.addEventListener("pointerleave", () => setHover(null));
        regionEls.push({ el, at: r.pos, align: "center", key: r.key, weight: 0, fixed: false, pk: null, w: 0, h: 0 });
      }
      lastSig = "";
    };

    const apply = (): void => {
      const v = view.peek();
      // The Labels toggle (Look): group, region and year names hide; month names (axis text) stay.
      if (v.look.groupLabels !== labelsOn) {
        labelsOn = v.look.groupLabels;
        lastSig = "";
      }
      const nameSig = `${v.look.namesFor}|${v.look.density}`;
      if (nameSig !== lastNameSig) {
        const densityChanged = lastNameSig !== "" && lastNameSig.split("|")[1] !== v.look.density;
        lastNameSig = nameSig;
        lastSig = "";
        // A new density changes which groups get a name at all: build the names again.
        if (densityChanged && model) rebuild();
      }
      host.classList.toggle("is-groups-off", !labelsOn);
      regionHost.classList.toggle("is-groups-off", !labelsOn);
      // Mid-morph the chips flash once (morph 0.35 to 0.55), then settle at 0.85.
      const flashing = model !== null && !reduced() && v.shape === "groups" && v.morph >= SHELL.timing.labelsFlash[0] && v.morph <= SHELL.timing.labelsFlash[1];
      const next: typeof mode =
        (model !== null && settled && v.shape === "groups" && v.morph > GROUP_OVERLAY_MORPH) || flashing ? "groups" : v.placement === "role" && v.morph < REGION_MORPH_MAX && regions.length > 0 ? "regions" : "off";
      host.style.display = next === "groups" ? "" : "none";
      regionHost.style.display = next === "regions" ? "" : "none";
      if (next === mode) {
        if (next !== "off" && lastSig === "") draw();
        return;
      }
      mode = next;
      const on = next !== "off";
      watchPointer(on);
      lastBoxes = [];
      lastBase = new Map();
      root.style.transition = reduced() ? "opacity 120ms linear" : on ? `opacity ${SHELL.timing.overlayFadeInMs}ms linear` : `opacity ${SHELL.timing.overlayFadeOutMs}ms linear`;
      root.style.opacity = on ? "1" : "0";
      // Labels take the pointer only while the overlay shows; the layer itself never does, so drags reach the canvas.
      root.classList.toggle("is-off", !on);
      if (!on) endPreview();
      if (on) {
        lastSig = "";
        draw();
        startFrames();
      } else stopFrames();
    };

    // A role placement that finished before this overlay mounted left its labels on the renderer.
    regions = [...(stageCanvas()?.cortexController?.renderer?.regionLabels ?? [])];
    rebuildRegions();
    const stopView = effect(() => {
      void view.value;
      apply();
    });
    // A traced group or a previewed chip wins its name's place: redo the layout when that set changes (not per frame).
    const stopUi = effect(() => {
      const u = leaf.store.slices.ui.value;
      const sig = `${u.preview?.kind}:${u.preview?.key}|${u.tokens.map((tk) => tk.id).join(",")}`;
      if (sig === winSig) return;
      winSig = sig;
      if (mode === "groups") {
        lastSig = "";
        draw();
      }
    });
    const stopBus = s.bus.on("layout:arrangement", (e) => {
      if (e.viewId !== leaf.viewId) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      settled = false;
      model = null;
      thinnest.value = null;
      apply();
      if (e.kind !== "groups") {
        clear();
        return;
      }
      model = (stageCanvas()?.cortexController?.renderer?.overlay() ?? null);
      thinnest.value = model?.thinnest ?? null;
      rebuild();
      settleTimer = setTimeout(() => {
        settled = true;
        apply();
      }, reduced() ? SETTLE_REDUCED_MS : (e.settleMs ?? SETTLE_MS));
    });
    const stopPlace = s.bus.on("layout:placement", (e) => {
      if (e.viewId !== leaf.viewId) return;
      regions = e.regions ?? [];
      rebuildRegions();
      apply();
    });
    return () => {
      stopView();
      stopUi();
      watchPointer(false);
      stopBus();
      stopPlace();
      regionHost.replaceChildren();
      stopFrames();
      endPreview();
      if (settleTimer) clearTimeout(settleTimer);
      host.replaceChildren();
    };
  }, [s, leaf, shell, thinnest]);

  return (
    <div class="cx-chart-stage">
      <div ref={rootRef} class="cx-chart-layer is-off" style={{ opacity: 0 }} aria-hidden="true">
        <canvas ref={canvasRef} class="cx-chart-overlay" />
        <div ref={labelsRef} class="cx-chart-labels is-groups" />
        <div ref={regionsRef} class="cx-chart-labels is-groups" style={{ display: "none" }} />
      </div>
      <RichnessHint thinnest={thinnest} />
    </div>
  );
}
