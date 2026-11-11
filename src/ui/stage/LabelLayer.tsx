/**
 * Name chips on the figure (CORTEX-UX §5.12, §6.11, §4.9): HTML chips over the canvas for traced, found and
 * selected items and a selection's notes (Names "On hover"), or the largest groups and maps (Names "Always"); at
 * most 24 at once, chosen by priority (selected > the selection's notes > traced > largest) then nearness. The
 * renderer projects the anchors (stage:labels, ≤ 30 Hz); this layer drops anchors under overlay rectangles, places
 * the chips with 6 iterations of a small screen-space repulsion (4 px apart, 8 px from their anchor, off the
 * overlays), joins each to its point with a 1 px leader at 42% white and fades them with depth (100% → 45%).
 * In the standing figure the chips go in two columns either side of the brain (each at its anchor's height) and outside the torso below it; cord segment names sit beside the cord. Updates go straight to the DOM through refs (no Preact render per frame). A chip: 21 px, 3 px colour bar, kind
 * glyph, kind word, title (≤ 42 characters). Owner: E11.
 */
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { HUB_HOVER } from "../../shared/hoverModel";
import { rgbCss } from "../../shared/palette";
import { SHELL, safeFrame, stageBox } from "../breakpoints";
import { stageBus, useLeaf, useServices, useShell, type LabelAnchor, type StageRect } from "../context";

export const MAX_CHIPS = SHELL.geometry.labels.max;

export interface PlacedLabel {
  anchor: LabelAnchor;
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
}

const L = SHELL.geometry.labels;

export function labelText(a: LabelAnchor): string {
  return a.title.length > L.maxChars ? `${a.title.slice(0, L.maxChars - 1)}…` : a.title;
}

/** Estimated chip width at 11.5 px (bar, glyph, kind word, title, optional count). */
export function labelWidth(a: LabelAnchor): number {
  const charW = 6.4;
  return 3 + 6 + (a.glyph ? 12 + 6 : 0) + (a.kind ? Math.ceil(a.kind.length * charW) + 6 : 0) + Math.ceil(labelText(a).length * charW) + (a.count !== undefined ? 8 + String(a.count).length * 6.7 : 0) + 8;
}

/** The chips each "Names for" choice keeps: everything, what is lit (selected, the selection's notes, traced, a hovered hub), or only what is hovered or selected. */
export function chipsForNames(anchors: readonly LabelAnchor[], namesFor: "everything" | "lit" | "hovered"): LabelAnchor[] {
  if (namesFor === "everything") return [...anchors];
  if (namesFor === "lit") return anchors.filter((a) => a.hover === true || a.priority >= 2);
  return anchors.filter((a) => a.hover === true || a.priority >= 4);
}

/** How many chips each density allows: Few a third, Auto the usual cap, All twice it (candidates stop at 48). */
export function chipCap(density: "auto" | "few" | "all", base: number = MAX_CHIPS): number {
  return density === "few" ? Math.max(1, Math.round(base / 3)) : density === "all" ? base * 2 : base;
}

function inside(x: number, y: number, r: StageRect, pad = 0): boolean {
  return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, gap: number): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/**
 * The standing figure's label columns (§6.11), in canvas px: the figure's centre line, the pixel size of one scene
 * unit, and the y of the brain's lowest edge. Chips sit outside the brain beside it, and outside the torso below it.
 */
export interface LabelColumns {
  cx: number;
  pxPerUnit: number;
  brainBottom: number;
}

/** Columns for the Standing pose from the free stage the figure is fitted into; null for Lying and for Mini. */
export function labelColumns(pose: "standing" | "lying", frame: StageRect | null): LabelColumns | null {
  if (pose !== "standing" || !frame || frame.w <= 0 || frame.h <= 0) return null;
  const c = L.columns;
  const pxPerUnit = (frame.h * c.fitRatio) / c.figureUnits;
  return { cx: frame.x + frame.w / 2, pxPerUnit, brainBottom: frame.y + c.brainDepthUnits * pxPerUnit };
}

/** Segment names ("T4") and other cord anchors sit beside the cord rather than in a column. */
export function isCordAnchor(a: LabelAnchor): boolean {
  return a.key.startsWith("cord:") || a.key.startsWith("segment:");
}

function columnX(a: LabelAnchor, w: number, col: LabelColumns): number {
  const c = L.columns;
  const left = a.x < col.cx || (a.x === col.cx && a.ordinal % 2 === 0);
  if (isCordAnchor(a)) return left ? col.cx - c.cordHalfPx - c.cordGap - w : col.cx + c.cordHalfPx + c.cordGap;
  const half = (a.y <= col.brainBottom ? c.brainHalfUnits : c.torsoHalfUnits) * col.pxPerUnit;
  return left ? col.cx - half - c.gap - w : col.cx + half + c.gap;
}

/** Choose and place the chips (pure). `columns` puts them in the standing figure's two columns. */
export function layoutLabels(anchors: readonly LabelAnchor[], rects: readonly StageRect[], size: { width: number; height: number }, max: number = MAX_CHIPS, columns: LabelColumns | null = null): PlacedLabel[] {
  const chosen = anchors
    // A chip without a name says nothing (sample messages and untitled entries have none): it is not drawn at all.
    .filter((a) => a.title.trim() !== "" && Number.isFinite(a.x) && Number.isFinite(a.y) && a.x >= 0 && a.y >= 0 && a.x <= size.width && a.y <= size.height && !rects.some((r) => inside(a.x, a.y, r, L.overlayPad)))
    .sort((a, b) => b.priority - a.priority || a.depth - b.depth)
    .slice(0, max);
  const placed: PlacedLabel[] = chosen.map((a) => {
    const w = labelWidth(a);
    if (columns) return { anchor: a, w, h: L.h, x: columnX(a, w, columns), y: a.y - L.h / 2, opacity: 1 - 0.55 * Math.max(0, Math.min(1, a.depth)) };
    const right = a.x + L.anchorGap + w <= size.width - 4;
    return { anchor: a, w, h: L.h, x: right ? a.x + L.anchorGap : a.x - L.anchorGap - w, y: a.y - L.h / 2, opacity: 1 - 0.55 * Math.max(0, Math.min(1, a.depth)) };
  });
  for (let it = 0; it < L.iterations; it++) {
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      if (!p) continue;
      for (let j = i + 1; j < placed.length; j++) {
        const q = placed[j];
        if (!q || !overlaps(p, q, L.minGap)) continue;
        const dy = p.y + p.h / 2 - (q.y + q.h / 2);
        const push = (p.h + L.minGap - Math.abs(dy)) / 2 + 0.5;
        const dir = dy === 0 ? (i < j ? -1 : 1) : Math.sign(dy);
        p.y += dir * push;
        q.y -= dir * push;
      }
      for (const r of rects) {
        if (!overlaps(p, r as { x: number; y: number; w: number; h: number }, L.minGap)) continue;
        const up = r.y - L.minGap - p.h;
        const down = r.y + r.h + L.minGap;
        p.y = Math.abs(up - p.y) < Math.abs(down - p.y) ? up : down;
      }
      p.x = Math.max(4, Math.min(size.width - p.w - 4, p.x));
      p.y = Math.max(4, Math.min(size.height - p.h - 4, p.y));
    }
  }
  // The relaxation above is a few cheap iterations and can leave chips on top of each other. A final greedy pass,
  // in priority order, keeps a chip only if it can stand clear of the ones already kept (nudged up or down in whole
  // rows); a chip that cannot is dropped, so no two chips ever overlap.
  const kept: PlacedLabel[] = [];
  const clear = (p: PlacedLabel): boolean =>
    p.y >= 4 && p.y + p.h <= size.height - 4 && !kept.some((k) => overlaps(p, k, L.minGap)) && !rects.some((r) => overlaps(p, r as { x: number; y: number; w: number; h: number }, L.minGap));
  for (const p of placed) {
    const y0 = p.y;
    const row = p.h + L.minGap;
    let ok = clear(p);
    for (let step = 1; !ok && step <= 6; step++) {
      for (const dir of [-1, 1]) {
        p.y = y0 + dir * step * row;
        if ((ok = clear(p))) break;
      }
    }
    if (ok) kept.push(p);
  }
  return kept;
}

/** The leader joins the anchor to the nearest point of the chip's outline. */
export function leaderEnd(p: PlacedLabel): { x: number; y: number } {
  const ax = p.anchor.x;
  const ay = p.anchor.y;
  return { x: Math.max(p.x, Math.min(p.x + p.w, ax)), y: Math.max(p.y, Math.min(p.y + p.h, ay)) };
}

const SVG_NS = "http://www.w3.org/2000/svg";

function renderLabels(host: HTMLElement, svg: SVGSVGElement, placed: readonly PlacedLabel[], cache: Map<string, HTMLElement>): void {
  const doc = host.ownerDocument;
  const keep = new Set<string>();
  for (const p of placed) {
    const a = p.anchor;
    keep.add(a.key);
    let el = cache.get(a.key);
    if (!el) {
      el = doc.createElement("div");
      el.className = "cx-label-chip";
      const bar = doc.createElement("i");
      bar.className = "cx-label-bar";
      const glyph = doc.createElement("span");
      glyph.className = "cx-label-glyph";
      const kind = doc.createElement("span");
      kind.className = "cx-label-kind";
      const title = doc.createElement("span");
      title.className = "cx-label-title";
      const count = doc.createElement("span");
      count.className = "cx-label-count";
      el.append(bar, glyph, kind, title, count);
      host.appendChild(el);
      cache.set(a.key, el);
    }
    const [bar, glyph, kind, title, count] = Array.from(el.children) as HTMLElement[];
    if (bar) bar.style.background = rgbCss(a.rgb);
    if (glyph) {
      glyph.textContent = a.glyph;
      glyph.hidden = !a.glyph;
    }
    if (kind) {
      kind.textContent = a.kind;
      kind.hidden = !a.kind;
    }
    if (title) title.textContent = labelText(a);
    if (count) {
      count.textContent = a.count === undefined ? "" : a.count.toLocaleString("en-GB");
      count.hidden = a.count === undefined;
    }
    el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    el.style.opacity = p.opacity.toFixed(2);
  }
  for (const [key, el] of cache) {
    if (keep.has(key)) continue;
    el.remove();
    cache.delete(key);
  }
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  for (const p of placed) {
    const end = leaderEnd(p);
    const line = doc.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", p.anchor.x.toFixed(1));
    line.setAttribute("y1", p.anchor.y.toFixed(1));
    line.setAttribute("x2", end.x.toFixed(1));
    line.setAttribute("y2", end.y.toFixed(1));
    line.setAttribute("opacity", p.opacity.toFixed(2));
    svg.appendChild(line);
  }
}

export function LabelLayer(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const host = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const cache = new Map<string, HTMLElement>();
    let pending: LabelAnchor[] | null = null;
    let measured: LabelColumns | null = null;
    let frame = 0;
    const flush = () => {
      frame = 0;
      const el = host.current;
      const lines = svg.current;
      if (!el || !lines || !pending) return;
      const size = { width: el.clientWidth, height: el.clientHeight };
      const ui = leaf.store.get("ui");
      const box = stageBox(shell.size.value, ui);
      const free = ui.breakpoint === "Mini" ? null : safeFrame(box.width || size.width, box.height || size.height, leaf.store.get("view").pose, ui.breakpoint);
      const pose = leaf.store.get("view").pose;
      const cols = pose === "standing" && measured ? measured : labelColumns(pose, free);
      // A hovered hub names its member notes together (about 30); otherwise the usual cap.
      const look = leaf.store.get("view").look;
      const max = chipCap(look.density, pending.some((a) => a.hover) ? Math.max(MAX_CHIPS, HUB_HOVER.chips) : MAX_CHIPS);
      renderLabels(el, lines, layoutLabels(chipsForNames(pending, look.namesFor), shell.overlayRects, size, max, cols), cache);
      pending = null;
    };
    const off = stageBus(s.bus).on("stage:labels", (e) => {
      if (e.viewId !== leaf.viewId) return;
      pending = e.anchors;
      measured = e.columns ?? null;
      if (frame === 0) frame = shell.win.requestAnimationFrame?.(flush) ?? 0;
      if (frame === 0) flush();
    });
    return () => {
      off();
      if (frame) shell.win.cancelAnimationFrame?.(frame);
      for (const el of cache.values()) el.remove();
      cache.clear();
    };
  }, [s, leaf]);
  return (
    <div ref={host} class="cx-labels" aria-hidden="true">
      <svg ref={svg} class="cx-label-leaders" />
    </div>
  );
}
