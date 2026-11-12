/**
 * Time strip (CORTEX-UX §5.8): 64 px under the stage only (44 px when short or at S). Lead (x 14–214): replay
 * (P2), "Time", the period picker (All time · Last 7 / 30 / 90 days · This year · Last year · Custom…) and
 * "‹n› entries · ‹m› notes". Notes lane: weekly ticks in the machine colour. Histogram: one bar per week (per day
 * ≤ 120 days, per month beyond 8 years), LOG scale by default (Settings › Appearance › Strip scale), bars in the
 * age colour of their entries. Axis: year guides, month labels, "today". Period brush: two handles, scrim outside.
 * Bracket over the selected conversation's dates. Undated pill at the right end ("Undated ‹n›"). Hover previews a
 * bin (others 35%), click adds a time token, drag sets the leaf's period (inside the period it moves it), double-click
 * = All time. Handles are sliders and the bars a list (keyboard). Data: worker stats {kind:"strip"}. Owner: E11.
 *
 * Everything that can be computed without the DOM is exported and pure: geometry, bin layout, hit tests, the
 * brush drag, labels and the selection's span.
 */
import type { JSX } from "preact";
import { useComputed } from "@preact/signals";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { featureOn } from "../../shared/features";
import { hubMemberList, hubSourceList } from "../../shared/hoverModel";
import { ItemKind, Population, NONE32, type DataIndex } from "../../shared/index-format";
import { ageOptions } from "../../shared/colourTheme";
import { ageColor, rgbCss } from "../../shared/palette";
import type { QueryToken, TimeBin, TimeWindow } from "../../shared/protocol/worker";
import { addToken, setPeriod } from "../../state/actions";
import { visibilityParams } from "../../state/selectors";
import { observeSize, SHELL, stripHeight, type Rect } from "../breakpoints";
import { loadedIndex, pendingCopy, useLeaf, useServices, useShell, type StripStats } from "../context";
import { t } from "../copy";
import { openAddSources } from "../header/Header";
import { Icon } from "../primitives/buttons";
import { showMenu } from "../primitives/menu";
import { PeriodPopover } from "./PeriodPopover";

export type PeriodPreset = "all" | "7" | "30" | "90" | "this-year" | "last-year";

const DAY = 86_400_000;

/** The period window for a preset (local days; null = All time). */
export function presetWindow(preset: PeriodPreset, now = Date.now()): [number, number] | null {
  switch (preset) {
    case "all":
      return null;
    case "7":
    case "30":
    case "90":
      return [now - Number(preset) * DAY, now];
    case "this-year":
      return [new Date(new Date(now).getFullYear(), 0, 1).getTime(), now];
    case "last-year": {
      const y = new Date(now).getFullYear() - 1;
      return [new Date(y, 0, 1).getTime(), new Date(y + 1, 0, 1).getTime() - 1];
    }
  }
}

/** Bin size rule: day when the span ≤ 120 days, month beyond 8 years, else week. */
export function binFor(spanMs: number): "day" | "week" | "month" {
  const days = spanMs / DAY;
  return days <= 120 ? "day" : days > 8 * 365 ? "month" : "week";
}

// ───────────────────────────── geometry (pure) ─────────────────────────────

export interface StripLayout {
  /** The lead (replay, title, picker, counts) shows; hidden at S. */
  lead: boolean;
  plot: Rect;
  /** Height of the notes lane at the top of the plot. */
  lane: number;
  height: number;
  /** Cortex Desktop's folded histogram: bars only, no lead, lane, axis, handles or pills. */
  mini?: boolean;
}

/** The folded strip's layout: a small box that is all plot. */
export function miniStripLayout(width: number): StripLayout {
  return { lead: false, mini: true, plot: { x: 0, y: 3, w: Math.max(0, width), h: 38 }, lane: 0, height: 44 };
}

/** The plot rectangle inside the strip: x 236 → width − 146, y 14 → 50 (y 14 → 36 when short); S has no lead. */
export function stripLayout(width: number, height: number, bp: "XL" | "L" | "M" | "S" | "Mini"): StripLayout {
  const g = SHELL.geometry.strip;
  const h = stripHeight(height, bp === "Mini" ? "S" : bp);
  const bare = bp === "S" || bp === "Mini";
  const x = bare ? g.plotLeftBare : g.plotLeft;
  const right = bare ? g.plotRightGapBare : g.plotRightGap;
  const bottom = h <= SHELL.geometry.stripShortH ? g.plotBottomShort : g.plotBottom;
  return { lead: !bare, plot: { x, y: g.plotTop, w: Math.max(0, width - x - right), h: Math.max(0, bottom - g.plotTop) }, lane: g.notesLane, height: h };
}

/** The time axis the plot covers: the first entry to today (or the last entry when it is later). */
export function axisRange(stats: Pick<StripStats, "first" | "last">, now: number): [number, number] | null {
  if (!Number.isFinite(stats.first)) return null;
  const end = Math.max(Number.isFinite(stats.last) ? stats.last : stats.first, now);
  return [stats.first, Math.max(end, stats.first + DAY)];
}

export function timeToX(t0: number, range: readonly [number, number], plot: Rect): number {
  return plot.x + ((t0 - range[0]) / (range[1] - range[0])) * plot.w;
}

export function xToTime(x: number, range: readonly [number, number], plot: Rect): number {
  const f = plot.w <= 0 ? 0 : Math.max(0, Math.min(1, (x - plot.x) / plot.w));
  return range[0] + f * (range[1] - range[0]);
}

export interface BarRect {
  i: number;
  x: number;
  w: number;
  /** 0..1 of the bar area's height. */
  h: number;
}

/** Bar heights on the log (default) or linear scale; a non-empty bin is never shorter than 1/36 of the plot. */
export function barHeight(entries: number, max: number, scale: "log" | "linear"): number {
  if (entries <= 0 || max <= 0) return 0;
  const f = scale === "log" ? Math.log1p(entries) / Math.log1p(max) : entries / max;
  return Math.max(1 / 36, Math.min(1, f));
}

/** One bar per bin with a 1 px gap between neighbours. */
export function barLayout(bins: readonly TimeBin[], range: readonly [number, number], plot: Rect, scale: "log" | "linear"): BarRect[] {
  const max = bins.reduce((m, b) => Math.max(m, b.entries), 0);
  return bins.map((b, i) => {
    const x0 = timeToX(b.start, range, plot);
    const x1 = timeToX(b.end, range, plot);
    return { i, x: x0, w: Math.max(1, x1 - x0 - 1), h: barHeight(b.entries, max, scale) };
  });
}

/** The bin under a time (binary search; bins are sorted and do not overlap), or -1. */
/** The period Replay shows at fraction `f` of the way along the record: from the first day to the playhead. */
export function replayPeriod(range: readonly [number, number], f: number): TimeWindow {
  const k = Math.max(0, Math.min(1, f));
  return [range[0], range[0] + Math.max(DAY, k * (range[1] - range[0]))];
}

/** Where the playhead is along the record (0..1) for a time on the axis. */
export function replayFraction(range: readonly [number, number], time: number): number {
  const span = range[1] - range[0];
  return span <= 0 ? 0 : Math.max(0, Math.min(1, (time - range[0]) / span));
}

export function binAt(bins: readonly TimeBin[], time: number): number {
  let lo = 0;
  let hi = bins.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = bins[mid] as TimeBin;
    if (time < b.start) hi = mid - 1;
    else if (time >= b.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export type BrushMode = "new" | "move" | "start" | "end";

/** Which part of the brush a press at x grabs: a handle (±6 px), the inside of the period, or a new period. */
export function brushHit(x: number, period: TimeWindow | null, range: readonly [number, number], plot: Rect): BrushMode {
  const [p0, p1] = period ?? range;
  const x0 = timeToX(p0, range, plot);
  const x1 = timeToX(p1, range, plot);
  const reach = SHELL.geometry.strip.handleW - 2;
  if (Math.abs(x - x0) <= reach) return "start";
  if (Math.abs(x - x1) <= reach) return "end";
  if (period && x > x0 && x < x1) return "move";
  return "new";
}

/** The period after dragging from `anchor` to `time`, keeping at least one day. Null clears nothing. */
export function dragPeriod(mode: BrushMode, anchor: number, time: number, start: TimeWindow, range: readonly [number, number]): TimeWindow {
  const clamp = (v: number) => Math.max(range[0], Math.min(range[1], v));
  switch (mode) {
    case "new": {
      const a = clamp(anchor);
      const b = clamp(time);
      return a <= b ? [a, Math.max(b, a + DAY)] : [b, a];
    }
    case "move": {
      const span = start[1] - start[0];
      const d = Math.max(range[0] - start[0], Math.min(range[1] - start[1], time - anchor));
      return [start[0] + d, start[0] + d + span];
    }
    case "start":
      return [Math.min(clamp(time), start[1] - DAY), start[1]];
    case "end":
      return [start[0], Math.max(clamp(time), start[0] + DAY)];
  }
}

/** Keyboard step for a brush handle: a bin, Shift a month, Page Up / Down a year. */
export function handleStep(key: string, shift: boolean, binMs: number): number {
  if (key === "PageUp") return 365 * DAY;
  if (key === "PageDown") return -365 * DAY;
  const sign = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
  return sign * (shift ? 30 * DAY : binMs);
}

/** The bracket over the bars for a date span: at least 14 px wide. */
export function bracketRect(span: readonly [number, number] | null, range: readonly [number, number], plot: Rect): { x: number; w: number } | null {
  if (!span || !Number.isFinite(span[0]) || !Number.isFinite(span[1])) return null;
  const x0 = timeToX(span[0], range, plot);
  const x1 = timeToX(span[1], range, plot);
  const w = Math.max(SHELL.geometry.strip.minBracketW, x1 - x0);
  return { x: Math.max(plot.x, Math.min(plot.x + plot.w - w, x0 - (w - (x1 - x0)) / 2)), w };
}

/** The union range of the active time tokens (a clicked day or month, a bar or a band of the chart); null when there is none. */
export function tokenSpan(tokens: readonly QueryToken[]): [number, number] | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const k of tokens) {
    if (k.kind !== "time" || !k.range) continue;
    const [a, b] = k.range;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    lo = Math.min(lo, a, b);
    hi = Math.max(hi, a, b);
  }
  return Number.isFinite(lo) ? [lo, hi] : null;
}

/** The marker a hovered bar or chart cell leaves on the strip: a thin line (a band when the range is wide) and its date. */
export function brushMarker(span: readonly [number, number] | null, range: readonly [number, number], plot: Rect): { x: number; w: number } | null {
  if (!span || !Number.isFinite(span[0]) || !Number.isFinite(span[1])) return null;
  const x0 = timeToX(span[0], range, plot);
  const x1 = timeToX(Math.max(span[0], span[1]), range, plot);
  if (x1 < plot.x || x0 > plot.x + plot.w) return null;
  const a = Math.max(plot.x, Math.min(plot.x + plot.w, x0));
  return { x: a, w: Math.max(0, Math.min(plot.x + plot.w, x1) - a) };
}

/** First and last dated moment of the selected item's conversation (or the item alone); null when undated. */
export function selectionSpan(ix: DataIndex | null, ordinal: number): [number, number] | null {
  if (!ix || ordinal < 0 || ordinal >= ix.count) return null;
  const c = ix.cols;
  let conv = c.conv[ordinal] as number;
  if (conv === NONE32) {
    const parent = c.parent[ordinal] as number;
    if (parent !== NONE32 && parent < ix.count) conv = c.conv[parent] as number;
  }
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  const take = (i: number) => {
    const v = c.t[i] as number;
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  };
  if (conv === NONE32) take(ordinal);
  else for (let i = 0; i < ix.count; i++) if (c.conv[i] === conv && c.pop[i] === Population.Record) take(i);
  return Number.isFinite(lo) ? [lo, hi] : null;
}

/** First and last dated moment among the record entries a map's notes are built from (CORTEX-UX §6.9: its source span); null when none is dated. */
export function hubSourceSpan(ix: DataIndex | null, hub: number): [number, number] | null {
  if (!ix || hub < 0 || hub >= ix.count || ix.cols.kind[hub] !== ItemKind.NoteHub) return null;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const e of hubSourceList(ix, hubMemberList(ix, hub), Number.POSITIVE_INFINITY)) {
    const v = ix.cols.t[e] as number;
    if (!Number.isFinite(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return Number.isFinite(lo) ? [lo, hi] : null;
}

const fmt = (ms: number, o: Intl.DateTimeFormatOptions) => new Date(ms).toLocaleDateString("en-GB", o);

/** "2 Nov 2026" (day and week bins), "Nov 2026" (month bins). */
export function binDate(bin: "day" | "week" | "month", start: number): string {
  return bin === "month" ? fmt(start, { month: "short", year: "numeric" }) : fmt(start, { day: "numeric", month: "short", year: "numeric" });
}

export function binTip(bin: "day" | "week" | "month", b: TimeBin): string {
  const values = { date: binDate(bin, b.start), entries: b.entries.toLocaleString("en-GB"), notes: b.notes.toLocaleString("en-GB") };
  return bin === "week" ? t("strip.weekTip", values) : pendingCopy("stripBinTip", values);
}

/** "3–4 Nov" or "28 Oct – 4 Nov" for the bracket label. */
export function spanLabel(span: readonly [number, number]): string {
  const a = new Date(span[0]);
  const b = new Date(span[1]);
  if (a.toDateString() === b.toDateString()) return fmt(span[0], { day: "numeric", month: "short" });
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) return `${a.getDate()}–${fmt(span[1], { day: "numeric", month: "short" })}`;
  return `${fmt(span[0], { day: "numeric", month: "short" })} – ${fmt(span[1], { day: "numeric", month: "short" })}`;
}

/** The picker's current name: a preset while the window still matches it, otherwise the dates. */
export function periodLabel(period: TimeWindow | null, preset: string | null): string {
  if (period === null) return t("strip.allTime");
  const named: Record<string, string> = { "7": t("strip.last7"), "30": t("strip.last30"), "90": t("strip.last90"), "this-year": t("strip.thisYear"), "last-year": t("strip.lastYear") };
  if (preset && named[preset]) return named[preset] as string;
  return `${fmt(period[0], { day: "numeric", month: "short" })} – ${fmt(period[1], { day: "numeric", month: "short", year: "numeric" })}`;
}

/** Entries and notes inside a period (all bins when null). */
export function countsIn(bins: readonly TimeBin[], period: TimeWindow | null): { entries: number; notes: number } {
  let entries = 0;
  let notes = 0;
  for (const b of bins) {
    if (period && (b.end <= period[0] || b.start > period[1])) continue;
    entries += b.entries;
    notes += b.notes;
  }
  return { entries, notes };
}

// ───────────────────────────── drawing ─────────────────────────────

export interface StripPaint {
  width: number;
  layout: StripLayout;
  range: readonly [number, number];
  bins: readonly TimeBin[];
  bin: "day" | "week" | "month";
  scale: "log" | "linear";
  now: number;
  period: TimeWindow | null;
  hover: number;
  span: readonly [number, number] | null;
  /** The active time tokens' range: a second, wider bracket around the inner one. */
  outer?: readonly [number, number] | null;
  /** The date span of the hovered bar or chart cell: a thin brush marker with its date. */
  brush?: readonly [number, number] | null;
  colours: { bar: string; text: string; machine: string; scrim: string; line: string; bracket: string };
  mono: string;
  /** Bar colour of a bin (age colour or the neutral). */
  barColour(b: TimeBin): string;
}

function drawAxis(ctx: CanvasRenderingContext2D, p: StripPaint): void {
  const { plot } = p.layout;
  const yAxis = plot.y + plot.h + 11;
  ctx.font = `10.5px ${p.mono}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = p.colours.text;
  ctx.strokeStyle = p.colours.line;
  const first = new Date(p.range[0]);
  const last = new Date(p.range[1]);
  const pxPerMonth = (plot.w / Math.max(1, p.range[1] - p.range[0])) * 30.4 * DAY;
  ctx.textAlign = "left";
  ctx.fillText(fmt(p.range[0], { month: "short", year: "numeric" }), plot.x, yAxis);
  let lastLabel = plot.x + 52;
  for (let y = first.getFullYear() + 1; y <= last.getFullYear(); y++) {
    const x = timeToX(new Date(y, 0, 1).getTime(), p.range, plot);
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x + 0.5, plot.y);
    ctx.lineTo(x + 0.5, plot.y + plot.h);
    ctx.stroke();
    ctx.setLineDash([]);
    if (x > lastLabel) {
      ctx.fillText(String(y), x + 3, yAxis);
      lastLabel = x + 34;
    }
  }
  if (pxPerMonth >= 34) {
    for (let d = new Date(first.getFullYear(), first.getMonth() + 1, 1); d.getTime() < p.range[1]; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      if (d.getMonth() === 0) continue;
      const x = timeToX(d.getTime(), p.range, plot);
      if (x > lastLabel && x < plot.x + plot.w - 70) {
        ctx.fillText(fmt(d.getTime(), { month: "short" }), x + 3, yAxis);
        lastLabel = x + 28;
      }
    }
  }
  const nx = Math.min(plot.x + plot.w, timeToX(p.now, p.range, plot));
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(nx, plot.y + plot.h + 2);
  ctx.lineTo(nx - 3.5, plot.y + plot.h + 8);
  ctx.lineTo(nx + 3.5, plot.y + plot.h + 8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = p.colours.text;
  ctx.textAlign = "right";
  ctx.fillText(t("strip.today"), plot.x + plot.w + 62, yAxis);
}

/** Paint the strip's plot: notes lane, bars, axis, scrim outside the period and the bracket. */
export function drawStrip(ctx: CanvasRenderingContext2D, p: StripPaint): void {
  const { plot, lane } = p.layout;
  ctx.clearRect(0, 0, p.width, p.layout.height);
  const bars = barLayout(p.bins, p.range, plot, p.scale);
  const barTop = plot.y + lane + 2;
  const barH = plot.h - lane - 2;
  const maxNotes = p.bins.reduce((m, b) => Math.max(m, b.notes), 0);
  const dimmed = (b: TimeBin) => (p.span !== null && (b.end < p.span[0] || b.start > p.span[1])) || (p.hover >= 0 && p.bins[p.hover] !== b);
  p.bins.forEach((b, i) => {
    const r = bars[i] as BarRect;
    const h = Math.max(1, r.h * barH * (p.layout.mini ? 0.72 : 1));
    ctx.globalAlpha = p.hover >= 0 || p.span ? (dimmed(b) ? (p.hover >= 0 ? SHELL.geometry.strip.previewOthers : SHELL.geometry.strip.selectedOthers) : 1) : 1;
    ctx.fillStyle = p.barColour(b);
    // The folded histogram reads as one mass of fine bars (no gap between neighbours); the open strip keeps its 1 px gaps.
    ctx.fillRect(r.x, barTop + barH - h, p.layout.mini ? r.w + 1 : r.w, h);
    if (!p.layout.mini && b.notes > 0 && maxNotes > 0) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = p.colours.machine;
      ctx.fillRect(r.x, plot.y + lane - Math.max(1, (b.notes / maxNotes) * 5), Math.max(2, Math.min(2, r.w)), Math.max(1, (b.notes / maxNotes) * 5));
    }
  });
  ctx.globalAlpha = 1;
  if (p.layout.mini) {
    // the folded histogram stands on a one-pixel baseline across its whole width
    ctx.fillStyle = p.colours.text;
    ctx.globalAlpha = 0.4;
    ctx.fillRect(0, Math.round(plot.y + plot.h), p.width, 1);
    // and carries the brush's two upright handles: at the period's ends, else at the first and last bar
    const first = p.bins[0];
    const last = p.bins[p.bins.length - 1];
    const lo = p.period ? p.period[0] : first?.start;
    const hi = p.period ? p.period[1] : last?.end;
    if (lo !== undefined && hi !== undefined) {
      ctx.globalAlpha = 0.75;
      for (const at of [lo, hi]) ctx.fillRect(Math.max(0, Math.min(p.width - 1, Math.round(timeToX(at, p.range, plot)))), plot.y, 1, plot.h + 1);
    }
    ctx.globalAlpha = 1;
  }
  if (p.hover >= 0) {
    const r = bars[p.hover];
    if (r) {
      ctx.fillStyle = "rgba(255,255,255,.08)";
      ctx.fillRect(r.x - 1, plot.y, r.w + 2, plot.h);
      ctx.strokeStyle = "rgba(255,255,255,.4)";
      ctx.strokeRect(r.x - 0.5, plot.y + 0.5, r.w + 1, plot.h - 1);
    }
  }
  if (!p.layout.mini) {
    ctx.font = `10px ${p.mono}`;
    ctx.fillStyle = p.colours.text;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(t("strip.notesLane"), plot.x + 12, plot.y - 1);
    drawAxis(ctx, p);
  }
  if (p.period) {
    ctx.fillStyle = p.colours.scrim;
    const x0 = timeToX(p.period[0], p.range, plot);
    const x1 = timeToX(p.period[1], p.range, plot);
    ctx.fillRect(plot.x, plot.y, Math.max(0, x0 - plot.x), plot.h);
    ctx.fillRect(x1, plot.y, Math.max(0, plot.x + plot.w - x1), plot.h);
  }
  if (p.brush) {
    const m = brushMarker(p.brush, p.range, plot);
    if (m) {
      ctx.strokeStyle = p.colours.bracket;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      if (m.w >= 4) {
        ctx.fillStyle = p.colours.bracket;
        ctx.globalAlpha = 0.1;
        ctx.fillRect(m.x, plot.y, m.w, plot.h);
        ctx.globalAlpha = 0.7;
      }
      const lx = Math.round(m.x) + 0.5;
      ctx.beginPath();
      ctx.moveTo(lx, plot.y);
      ctx.lineTo(lx, plot.y + plot.h);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.font = `10px ${p.mono}`;
      ctx.fillStyle = p.colours.bracket;
      ctx.textBaseline = "top";
      const label = spanLabel(p.brush);
      const room = plot.x + plot.w - lx;
      ctx.textAlign = room < 80 ? "right" : "left";
      ctx.fillText(label, room < 80 ? lx - 4 : lx + 4, plot.y + plot.h - 12);
    }
  }
  if (p.outer) {
    const ob = bracketRect(p.outer, p.range, plot);
    if (ob) {
      const o = 3;
      ctx.strokeStyle = p.colours.bracket;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ob.x - o, plot.y + 3 - o);
      ctx.lineTo(ob.x - o, plot.y - o);
      ctx.lineTo(ob.x + ob.w + o, plot.y - o);
      ctx.lineTo(ob.x + ob.w + o, plot.y + 3 - o);
      ctx.stroke();
      ctx.lineWidth = 1;
      if (!p.span) {
        ctx.font = `10.5px ${p.mono}`;
        ctx.fillStyle = p.colours.bracket;
        ctx.textBaseline = "middle";
        bracketLabel(ctx, spanLabel(p.outer), ob.x - o, ob.x + ob.w + o, plot, plot.y - 1);
      }
    }
  }
  const br = bracketRect(p.span, p.range, plot);
  if (br) {
    ctx.strokeStyle = p.colours.bracket;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(br.x, plot.y + 3);
    ctx.lineTo(br.x, plot.y);
    ctx.lineTo(br.x + br.w, plot.y);
    ctx.lineTo(br.x + br.w, plot.y + 3);
    ctx.stroke();
    ctx.lineWidth = 1;
    if (p.span) {
      ctx.font = `10.5px ${p.mono}`;
      ctx.fillStyle = p.colours.bracket;
      ctx.textBaseline = "middle";
      bracketLabel(ctx, spanLabel(p.span), br.x, br.x + br.w, plot, plot.y + 1);
    }
  }
}

/** A bracket's label: left of the bracket when it fits inside the plot, else right of it, else left out (never clipped by the strip's edge). */
export function bracketLabel(ctx: CanvasRenderingContext2D, label: string, left: number, right: number, plot: { x: number; w: number }, y: number): void {
  const w = ctx.measureText(label)?.width ?? label.length * 6;
  if (left - 6 - w >= plot.x) {
    ctx.textAlign = "right";
    ctx.fillText(label, left - 6, y);
  } else if (right + 6 + w <= plot.x + plot.w) {
    ctx.textAlign = "left";
    ctx.fillText(label, right + 6, y);
  }
}

// ───────────────────────────── component ─────────────────────────────

function cssVar(el: Element, name: string, fallback: string): string {
  try {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

function dayStart(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).getTime();
}

function dayEnd(iso: string): number {
  return dayStart(iso) + DAY - 1;
}

const PRESETS: { value: PeriodPreset; label: () => string }[] = [
  { value: "all", label: () => t("strip.allTime") },
  { value: "7", label: () => t("strip.last7") },
  { value: "30", label: () => t("strip.last30") },
  { value: "90", label: () => t("strip.last90") },
  { value: "this-year", label: () => t("strip.thisYear") },
  { value: "last-year", label: () => t("strip.lastYear") },
];

export function TimeStrip(props: { mini?: boolean } = {}): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const store = leaf.store;
  const ui = store.slices.ui.value;
  const view = store.slices.view.value;
  const selection = store.slices.selection.value;
  const settings = s.settings.value;
  const ix = loadedIndex(s);
  const rootRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [stats, setStats] = useState<StripStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState(-1);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const drag = useRef<{ mode: BrushMode; anchor: number; start: TimeWindow; x0: number; moved: boolean; id: number } | null>(null);
  const bp = ui.breakpoint;
  const viewHeight = shell.size.value.height || Number.POSITIVE_INFINITY;
  const layout = useMemo(() => (props.mini ? miniStripLayout(width) : stripLayout(width, viewHeight, bp)), [width, viewHeight, bp, props.mini]);
  const layersKey = JSON.stringify(view.layers);
  const ageMode = view.colour.record.kind === "age";
  const now = Date.now();

  useEffect(() => {
    const el = rootRef.current;
    return el ? observeSize(el, (w) => setWidth(w)) : undefined;
  }, []);

  // The strip's data: the whole record in the current scope and Layers (the period is the brush, not a filter).
  useEffect(() => {
    let live = true;
    // An empty record is normal: there is nothing to count, so nothing to ask the worker.
    if (!ix || ix.count === 0) {
      setStats(null);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const vis = { ...visibilityParams(store.get("ui"), store.get("view")), period: null };
    s.worker
      .call(`${leaf.viewId}#strip`, "stats", { kind: "strip", bin: "auto", notesLane: true, ageColour: ageMode, visibility: vis })
      .then((res) => {
        if (!live || res.kind !== "strip") return;
        setStats(res);
        shell.strip.value = res;
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!live) return;
        s.log.warn("time strip statistics failed", { error: String(e) });
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [s, leaf, shell, ix, ui.scope, ui.revealedCount, layersKey, ageMode]);

  const range = stats ? axisRange(stats, now) : null;
  const bins = stats?.bins ?? [];
  const binKind = stats?.bin ?? "week";
  const selectedSpan = useMemo(() => (selection ? selectionSpan(ix, selection.ordinal) : null), [ix, selection?.ordinal]);
  // A hovered map brackets the dates of its source entries for as long as the pointer is on it (it outranks the selection's bracket).
  const hubOrdinal = useComputed(() => {
    const h = store.slices.hover.value;
    const idx = loadedIndex(s);
    return h && idx && h.ordinal >= 0 && h.ordinal < idx.count && idx.cols.kind[h.ordinal] === ItemKind.NoteHub ? h.ordinal : -1;
  }).value;
  const hubSpan = useMemo(() => (hubOrdinal >= 0 ? hubSourceSpan(ix, hubOrdinal) : null), [ix, hubOrdinal]);
  const span = hubSpan ?? selectedSpan;
  // Time tokens (a clicked day, month, bar or band) add the outer bracket; the chart cell under the pointer leaves a brush marker.
  const outer = useMemo(() => tokenSpan(ui.tokens), [ui.tokens]);
  const hoverRange = ui.hoverRange;

  // Paint (a 250 ms cross-fade on scope change is the canvas' CSS opacity transition).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !range || width === 0) return;
    const dpr = shell.win.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(layout.height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const text = cssVar(canvas, "--cx-stage-text-3", "#9ea5b1");
    const neutral = cssVar(canvas, "--cx-stage-text-3", "#9ea5b1");
    const light = shell.obsidianDark.value === false || settings.appearance.stage === "paper";
    const ageOpts = ageOptions(settings.appearance);
    drawStrip(ctx, {
      width,
      layout,
      range,
      bins,
      bin: binKind,
      scale: settings.appearance.stripScale,
      now,
      period: ui.period,
      hover,
      span,
      outer,
      brush: hover >= 0 && bins[hover] ? [(bins[hover] as TimeBin).start, (bins[hover] as TimeBin).end - 1] : hoverRange,
      colours: { bar: neutral, text, machine: cssVar(canvas, "--cx-machine", "#b8a6ff"), scrim: cssVar(canvas, "--cx-scrim", "rgba(6,7,10,.55)"), line: cssVar(canvas, "--cx-glass-line-strong", "rgba(255,255,255,.17)"), bracket: cssVar(canvas, "--cx-stage-text-1", "#ffffff") },
      mono: cssVar(canvas, "--cx-font-mono", "monospace"),
      barColour: (b) => (ageMode && !Number.isNaN(b.age) ? rgbCss(ageColor(b.age, light, ageOpts.mode, ageOpts.tintHue, ageOpts.chroma)) : `${neutral}8c`),
    });
  }, [stats, width, layout, hover, ui.period, span, outer, hoverRange, settings.appearance.stripScale, settings.appearance.ageColours, settings.appearance.palette, settings.appearance.stage, settings.appearance.stageTint, ageMode, shell.obsidianDark.value]);

  const plot = layout.plot;
  const localX = (e: PointerEvent | MouseEvent): number => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientX - r.left + plot.x;
  };
  const preview = (i: number) => {
    setHover(i);
    const b = i >= 0 ? bins[i] : undefined;
    store.update("ui", { preview: b ? { kind: "period", key: `${b.start}-${b.end}` } : null });
  };
  const trace = (i: number) => {
    const b = bins[i];
    if (!b) return;
    const label = binKind === "week" ? t("strip.weekToken", { date: binDate("week", b.start) }) : binDate(binKind, b.start);
    addToken(store, { id: `time:${b.start}-${b.end}`, kind: "time", label, range: [b.start, b.end - 1] });
  };
  /** Drag the playhead (anywhere on the plot while Replay runs): the replay follows the pointer, then carries on from there. */
  const scrub = (e: PointerEvent) => {
    const run = replayRun.current;
    if (!run || !range) return;
    run.frac = replayFraction(range, xToTime(localX(e), range, plot));
    setPlayFrac(run.frac);
    setPeriod(store, replayPeriod(range, run.frac));
  };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 || !range) return;
    const run = replayRun.current;
    if (run) {
      run.scrubbing = true;
      run.id = e.pointerId;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      scrub(e);
      return;
    }
    const x = localX(e);
    const mode = brushHit(x, ui.period, range, plot);
    drag.current = { mode, anchor: xToTime(x, range, plot), start: ui.period ?? [range[0], range[1]], x0: e.clientX, moved: false, id: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!range) return;
    if (replayRun.current?.scrubbing) {
      scrub(e);
      return;
    }
    const x = localX(e);
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return;
      d.moved = true;
      setPeriod(store, dragPeriod(d.mode, d.anchor, xToTime(x, range, plot), d.start, range));
      return;
    }
    const i = binAt(bins, xToTime(x, range, plot));
    if (i !== hover) preview(i);
  };
  const onUp = (e: PointerEvent) => {
    const run = replayRun.current;
    if (run?.scrubbing && run.id === e.pointerId) {
      run.scrubbing = false;
      run.t0 = shell.now() - run.frac * SHELL.timing.replayMs;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      return;
    }
    const d = drag.current;
    drag.current = null;
    if (!d || d.id !== e.pointerId) return;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (!d.moved && range) trace(binAt(bins, xToTime(localX(e), range, plot)));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const next = Math.max(0, Math.min(bins.length - 1, (hover < 0 ? (e.key === "ArrowLeft" ? bins.length : -1) : hover) + (e.key === "ArrowRight" ? 1 : -1)));
      preview(bins.length ? next : -1);
    } else if (e.key === "Enter" && hover >= 0) {
      e.preventDefault();
      trace(hover);
    }
  };
  const binMs = bins[0] ? bins[0].end - bins[0].start : 7 * DAY;
  const moveHandle = (which: "start" | "end", e: KeyboardEvent) => {
    if (!range) return;
    const step = handleStep(e.key, e.shiftKey, binMs);
    if (step === 0) return;
    e.preventDefault();
    const cur: TimeWindow = ui.period ?? [range[0], range[1]];
    const to = (which === "start" ? cur[0] : cur[1]) + step;
    setPeriod(store, dragPeriod(which, 0, to, cur, range));
  };

  const stopReplay = useRef<(() => void) | null>(null);
  /** The running Replay: when it started, how far it is, and whether the playhead is being dragged. */
  const replayRun = useRef<{ t0: number; frac: number; scrubbing: boolean; id: number } | null>(null);
  const [playFrac, setPlayFrac] = useState<number | null>(null);
  const replay = () => {
    if (stopReplay.current) {
      stopReplay.current();
      return;
    }
    if (!range) return;
    const before = store.get("ui").period;
    const run = { t0: shell.now(), frac: 0, scrubbing: false, id: -1 };
    replayRun.current = run;
    let raf = 0;
    const done = () => {
      shell.win.cancelAnimationFrame?.(raf);
      stopReplay.current = null;
      replayRun.current = null;
      shell.stopReplay = null;
      setReplaying(false);
      setPlayFrac(null);
      setPeriod(store, before);
    };
    const tick = () => {
      // While the playhead is held, the person sets the position; otherwise it advances over replayMs.
      if (!run.scrubbing) run.frac = Math.min(1, (shell.now() - run.t0) / SHELL.timing.replayMs);
      setPlayFrac(run.frac);
      setPeriod(store, replayPeriod(range, run.frac));
      if (run.frac >= 1 && !run.scrubbing) done();
      else raf = shell.win.requestAnimationFrame(tick);
    };
    stopReplay.current = done;
    // Esc stops it (the Esc ladder asks the shell).
    shell.stopReplay = done;
    setReplaying(true);
    tick();
  };
  useEffect(() => () => stopReplay.current?.(), []);

  const openPicker = (anchor: HTMLElement) => {
    showMenu(
      [
        ...PRESETS.map((p) => ({ value: p.value as string, label: p.label(), checked: p.value === "all" ? ui.period === null : shell.periodPreset.value === p.value && ui.period !== null, group: "presets" })),
        { value: "custom", label: t("strip.custom"), group: "custom" },
      ],
      anchor,
      (v) => {
        if (v === "custom") {
          setPickerOpen(true);
          return;
        }
        setPickerOpen(false);
        shell.periodPreset.value = v === "all" ? null : v;
        setPeriod(store, presetWindow(v as PeriodPreset));
      },
    );
  };

  const counts = countsIn(bins, ui.period);
  const handleX = (time: number) => (range ? timeToX(time, range, plot) : plot.x);
  const hasData = bins.length > 0 && range !== null;
  const sel = ui.period ?? (range ? ([range[0], range[1]] as TimeWindow) : null);
  const tipBin = hover >= 0 ? bins[hover] : undefined;
  const tipX = tipBin && range ? Math.min(width - 230, Math.max(4, timeToX(tipBin.start, range, plot) - 90)) : 0;

  return (
    <section ref={rootRef} class={`cx-strip${loading ? " is-loading" : ""}${layout.mini ? " is-mini" : ""}`} role="group" aria-label={t("strip.label")} style={{ height: `${layout.height}px` }} onMouseLeave={() => hover >= 0 && !drag.current && preview(-1)}>
      {layout.mini ? null : layout.lead ? (
        <div class="cx-strip-lead">
          <div class="cx-strip-row">
            {featureOn("replay") ? (
              <button type="button" class={`cx-replay${replaying ? " is-on" : ""}`} aria-label={t("strip.replay")} aria-pressed={replaying} title={t("strip.replay")} onClick={replay}>
                <Icon name={replaying ? "close" : "play"} />
              </button>
            ) : null}
            <span class="cx-strip-title">{t("strip.time")}</span>
            <button type="button" class="cx-picker" aria-haspopup="menu" aria-expanded={pickerOpen} onClick={(e) => openPicker(e.currentTarget as HTMLElement)}>
              {periodLabel(ui.period, shell.periodPreset.value)}
              <Icon name="chevron" />
            </button>
          </div>
          <span class="cx-strip-counts">{t("strip.counts", { entries: counts.entries.toLocaleString("en-GB"), notes: counts.notes.toLocaleString("en-GB") })}</span>
          {pickerOpen ? (
            <PeriodPopover
              from={sel ? new Date(sel[0]).toISOString().slice(0, 10) : ""}
              to={sel ? new Date(sel[1]).toISOString().slice(0, 10) : ""}
              onApply={([from, to]) => {
                shell.periodPreset.value = null;
                setPeriod(store, [dayStart(from), dayEnd(to)]);
                setPickerOpen(false);
              }}
              onClose={() => setPickerOpen(false)}
            />
          ) : null}
        </div>
      ) : (
        <button type="button" class="cx-picker is-bare" aria-haspopup="menu" onClick={(e) => openPicker(e.currentTarget as HTMLElement)}>
          {periodLabel(ui.period, shell.periodPreset.value)}
        </button>
      )}
      <div
        class="cx-strip-plot"
        style={{ left: `${plot.x}px`, width: `${plot.w}px`, top: 0, height: `${layout.height}px` }}
        tabIndex={hasData ? 0 : -1}
        role="listbox"
        aria-label={t("strip.label")}
        aria-activedescendant={hover >= 0 ? `cx-bin-${leaf.viewId}-${hover}` : undefined}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDblClick={() => {
          shell.periodPreset.value = null;
          setPeriod(store, null);
        }}
        onKeyDown={onKey}
      >
        <canvas ref={canvasRef} class="cx-strip-canvas" style={{ left: `${-plot.x}px`, width: `${width}px`, height: `${layout.height}px` }} aria-hidden="true" />
        {loading ? <div class="cx-strip-skeleton" aria-hidden="true" /> : null}
        {!loading && !hasData ? (
          <p class="cx-strip-empty">
            {t("strip.none")} <button type="button" class="cx-text-button" onClick={() => void openAddSources(s)}>{t("header.addSources")}</button>
          </p>
        ) : null}
        {hasData && !layout.mini ? (
          <>
            {([["start", sel?.[0]], ["end", sel?.[1]]] as const).map(([which, time]) => (
              <div
                key={which}
                class="cx-strip-handle"
                role="slider"
                tabIndex={0}
                aria-label={which === "start" ? t("strip.from") : t("strip.to")}
                aria-valuemin={range?.[0]}
                aria-valuemax={range?.[1]}
                aria-valuenow={time}
                aria-valuetext={time === undefined ? undefined : fmt(time, { day: "numeric", month: "short", year: "numeric" })}
                style={{ left: `${handleX(time ?? plot.x) - plot.x - SHELL.geometry.strip.handleW / 2}px`, top: `${plot.y - 4}px`, height: `${plot.h + 8}px` }}
                onKeyDown={(e) => moveHandle(which, e as KeyboardEvent)}
              />
            ))}
            {playFrac !== null && range ? (
              <div
                class="cx-playhead"
                role="slider"
                aria-label={t("strip.playhead")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(playFrac * 100)}
                style={{ left: `${timeToX(range[0] + playFrac * (range[1] - range[0]), range, plot) - plot.x - 1}px`, top: `${plot.y - 4}px`, height: `${plot.h + 8}px` }}
              />
            ) : null}
            <ul class="cx-sr-only">
              {bins.map((b, i) => (
                <li key={b.start} id={`cx-bin-${leaf.viewId}-${i}`} role="option" aria-selected={i === hover}>
                  {binTip(binKind, b)}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {tipBin ? (
          <div class="cx-strip-tip cx-glass" role="presentation" style={{ left: `${tipX - plot.x}px`, bottom: `${layout.height + 6}px` }}>
            {binTip(binKind, tipBin)}
          </div>
        ) : null}
      </div>
      {layout.mini ? null : <button
        type="button"
        class="cx-undated-pill"
        title={t("strip.undatedTip", { n: (stats?.undated ?? 0).toLocaleString("en-GB") })}
        disabled={(stats?.undated ?? 0) === 0}
        onClick={() => addToken(store, { id: "undated", kind: "group", dim: "day", value: "", label: t("strip.undated", { n: (stats?.undated ?? 0).toLocaleString("en-GB") }) })}
      >
        <span class="cx-dot" aria-hidden="true" />
        {t("strip.undated", { n: (stats?.undated ?? 0).toLocaleString("en-GB") })}
      </button>}
    </section>
  );
}
