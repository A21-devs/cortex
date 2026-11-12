/**
 * Time › Figure, "When you wrote" (SPEC V15; B 20.7–23, C 8.4–19.5): five sections that share ONE period.
 *   1 Activity by area   monthly bars stacked by area (outlined, Unsorted hollow); hover = a full-height outlined
 *                        column and a preview in the brain; click = lock that month (a time token) with the status
 *                        line "N in ‹Month yyyy› · Clear" (or "N with ‹label› in ‹Month yyyy›" on a segment);
 *   2 Lanes              decisions, open questions, plans and rejections as ticks along time, a tooltip each;
 *   3 Days you wrote     a 7-row × weeks heatmap;
 *   4 By speaker         monthly bars you · assistants · other, with an undated footnote;
 *   5 Labels over time   monthly bars stacked by a chosen label field (kind, project, … any label pack field).
 * Dragging across ANY of them sets the leaf's period: every section re-ranges to it (the header shows the range),
 * the strip's brush follows and the brain lights it (points outside the period dim). While a new range is counted
 * grey skeleton bars stand in for at most 300 ms. Series come from the worker (stats "when"). Owner: E12.
 */
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { DimId } from "../../shared/dims";
import { KIND_STYLE } from "../../shared/palette";
import { STARTER_PACKS } from "../../shared/packs";
import type { WhenLaneKind, WhenStack, WhenStats } from "../../shared/protocol/worker";
import { addToken, removeToken, setPeriod } from "../../state/actions";
import type { CortexStore } from "../../state/store";
import { visibilityParams } from "../../state/selectors";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import { Select } from "../primitives/controls";
import { areaSlot } from "../reader/marks";
import { useIndex } from "../reader/readerKit";
import { areaLabel, dimLabel, kindLabel, valueLabel } from "../valueLabels";
import { copyToClipboard, ErrorCard, setPageParams, statsKey, useFmt, useLoad } from "./PageFrame";
import { weekdayLabels } from "./RhythmGrid";
import {
  axisTicks,
  columnOf,
  dayText,
  daysCsv,
  daysWithEntries,
  heatLevel,
  labelChoices,
  laneDrawn,
  lanesCsv,
  monthSpanPeriod,
  monthText,
  monthTotals,
  rangeText,
  segmentAt,
  segmentsOf,
  skeletonHeights,
  stackCsv,
  taggedShare,
  timeSpanPeriod,
  weekMonthLabels,
  type Segment,
} from "./whenModel";

const W = 360;
const BAR_H = 110;
const AXIS_H = 16;
/** Local midnight `n` calendar days after `ms` (DST-exact, unlike adding n × 24 h). */
export function addDaysMs(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}
/** A press that moves further than this many CSS px is a drag, not a click. */
const DRAG_PX = 4;
/** Grey skeleton bars stand in for at most this long while a new range is counted (SPEC V15). */
export const SKELETON_CAP_MS = 300;

type Period = [number, number];

/** The preview key the renderer reads ("from-to", to exclusive); a period [a, b] covers b + 1. */
export function previewKey(p: Period): string {
  return `${Math.round(p[0])}-${Math.round(p[1]) + 1}`;
}

/** The status line of a locked selection. */
export function lockText(n: number, month: string, label?: string): string {
  const num = n.toLocaleString("en-GB");
  return label ? t("when.withLabel", { n: num, label, month }) : t("when.inMonth", { n: num, month });
}

export interface LockGroup {
  dim: DimId;
  value: string;
  label: string;
  /** More values of the same dimension the segment stands for (the speaker bar "others" is other + tool). */
  alsoValues?: readonly string[];
}

const isLockLabel = (id: string): boolean => id === "when:label" || id.startsWith("when:label+");

/** Lock a month or day in the brain: a time token, plus a group token when a segment was clicked (AND across kinds). */
/** `recordsOnly` lights just the record entries in the range (a day on the heatmap counts entries you wrote, so only those light). */
export function lockTokens(store: CortexStore, range: Period, text: string, group?: LockGroup, recordsOnly = false): void {
  store.batch(() => {
    store.update("ui", (ui) => ({ ...ui, tokens: ui.tokens.filter((k) => !isLockLabel(k.id)) }));
    addToken(store, { id: "when:time", kind: "time", label: text, range, ...(recordsOnly ? { recordsOnly: true } : {}) });
    if (group) {
      addToken(store, { id: "when:label", kind: "group", dim: group.dim, value: group.value, label: group.label });
      (group.alsoValues ?? []).forEach((v, i) => addToken(store, { id: `when:label+${i + 1}`, kind: "group", dim: group.dim, value: v, label: group.label }));
    }
  });
}

export function clearLockTokens(store: CortexStore): void {
  store.batch(() => {
    removeToken(store, "when:time");
    store.update("ui", (ui) => ({ ...ui, tokens: ui.tokens.filter((k) => !isLockLabel(k.id)) }));
  });
}

/** The charts of the page a click can pick a mark in. */
export type WhenSection = "area" | "lanes" | "days" | "speakers" | "labels";

/** The mark a click lit: a month (and the segment of its stack when one was hit) or a day of the heatmap. */
export type WhenPick = { section: "area" | "speakers" | "labels"; month: number; group: number | null } | { section: "days"; day: number };

/** Charts that do not hold the picked mark step back to 0.45 so the one that does reads first (nothing picked: none dims). */
export function blockClass(pick: WhenPick | null, section: WhenSection): string {
  return `cx-when-block${sectionDimmed(pick, section) ? " is-dimmed" : ""}`;
}

export function sectionDimmed(pick: WhenPick | null, section: WhenSection): boolean {
  return pick !== null && pick.section !== section;
}

/** The vertical span (0..1 of the bar scale) of the outline a pick draws on a month's stack: the segment, or the whole bar. */
export function pickSpan(segs: readonly Segment[], group: number | null): [number, number] | null {
  const own = group === null ? segs : segs.filter((x) => x.g === group);
  if (own.length === 0) return null;
  return [Math.min(...own.map((x) => x.y0)), Math.max(...own.map((x) => x.y1))];
}

// ───────────────────────────── pointer gestures ─────────────────────────────

interface Gesture {
  /** Hover position (viewBox units), null when the pointer leaves. */
  onHover(pt: { x: number; y: number } | null): void;
  onTap(pt: { x: number; y: number }): void;
  /** A drag from x a to x b (viewBox units); `final` on release. */
  onSpan(a: number, b: number, final: boolean): void;
}

/** Pointer handlers for one chart: hover, tap, and a drag across it; coordinates are in the chart's viewBox units. */
function useGesture(box: { w: number; h: number }, g: Gesture) {
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const [span, setSpan] = useState<[number, number] | null>(null);
  const gRef = useRef(g);
  gRef.current = g;
  const point = (e: PointerEvent) => {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    const sx = box.w / Math.max(1, r.width || box.w);
    const sy = box.h / Math.max(1, r.height || box.h);
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy, px: sx };
  };
  return {
    span,
    handlers: {
      onPointerDown: (e: PointerEvent) => {
        if (e.button !== undefined && e.button !== 0) return;
        const pt = point(e);
        press.current = { x: pt.x, y: pt.y, dragging: false };
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      },
      onPointerMove: (e: PointerEvent) => {
        const pt = point(e);
        const p = press.current;
        if (!p) return gRef.current.onHover(pt);
        if (!p.dragging && Math.abs(pt.x - p.x) / pt.px > DRAG_PX) p.dragging = true;
        if (p.dragging) {
          setSpan([p.x, pt.x]);
          gRef.current.onSpan(p.x, pt.x, false);
        }
      },
      onPointerUp: (e: PointerEvent) => {
        const p = press.current;
        press.current = null;
        if (!p) return;
        const pt = point(e);
        (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
        setSpan(null);
        if (p.dragging) gRef.current.onSpan(p.x, pt.x, true);
        else gRef.current.onTap(pt);
      },
      onPointerCancel: () => {
        press.current = null;
        setSpan(null);
        gRef.current.onSpan(0, 0, false);
        gRef.current.onHover(null);
      },
      onPointerLeave: () => {
        if (!press.current) gRef.current.onHover(null);
      },
    },
  };
}

// ───────────────────────────── charts ─────────────────────────────

interface Fill {
  /** CSS colour; null = the hollow "no value" group. */
  colour: string | null;
  /** The lighter top edge of solid bars. */
  edge?: string;
}

interface MonthChartProps {
  name: string;
  monthStarts: readonly number[];
  stack: WhenStack;
  fillOf(g: number): Fill;
  /** Display name of a stacked group (tooltips). */
  nameOf(g: number): string;
  /** Outlined thin bars (areas, labels) or solid bars with a lighter top edge (speakers). */
  solid?: boolean;
  hover: number | null;
  skeleton: boolean;
  onHover(m: number | null): void;
  /** A click on a month; `group` is the segment under the pointer (null above the bar). */
  onPick(m: number, group: number | null): void;
  onLive(period: Period | null): void;
  onRange(period: Period): void;
  /** The month (and segment) a click picked: drawn with a 1.5 px outline. */
  pick?: { month: number; group: number | null } | null;
}

export function MonthChart(p: MonthChartProps): JSX.Element {
  const months = p.monthStarts.length - 1;
  const totals = useMemo(() => monthTotals(p.stack, months), [p.stack, months]);
  const scale = Math.max(1, ...totals);
  const bw = W / Math.max(1, months);
  const gap = Math.min(0.5, bw * 0.2);
  const ticks = useMemo(() => axisTicks(p.monthStarts), [p.monthStarts]);
  const segs = useMemo(() => Array.from({ length: months }, (_, m) => segmentsOf(p.stack, months, m, scale)), [p.stack, months, scale]);
  const colOf = (x: number) => columnOf(x / W, months);
  const { handlers, span } = useGesture(
    { w: W, h: BAR_H + AXIS_H },
    {
      onHover: (pt) => p.onHover(pt ? colOf(pt.x) : null),
      onTap: (pt) => {
        const m = colOf(pt.x);
        const seg = segmentAt(segs[m] ?? [], (BAR_H - pt.y) / BAR_H);
        p.onPick(m, seg ? seg.g : null);
      },
      onSpan: (a, b, final) => {
        const period = monthSpanPeriod(p.monthStarts, colOf(a), colOf(b));
        if (final && period) p.onRange(period);
        else p.onLive(period && (a !== 0 || b !== 0) ? period : null);
      },
    },
  );
  const sel = span ? ([Math.min(colOf(span[0]), colOf(span[1])), Math.max(colOf(span[0]), colOf(span[1]))] as const) : null;
  const barX = (m: number) => m * bw + gap / 2;
  const barW = Math.max(0.5, bw - gap);
  const skel = skeletonHeights(months);
  return (
    <svg class="cx-when-svg" viewBox={`0 0 ${W} ${BAR_H + AXIS_H}`} role="img" aria-label={t("when.chartLabel", { name: p.name })} {...handlers}>
      {p.skeleton
        ? skel.map((h, m) => <rect class="cx-when-skel" x={barX(m)} y={BAR_H - h * BAR_H} width={barW} height={h * BAR_H} />)
        : segs.map((list, m) =>
            list.map((s) => <Bar seg={s} x={barX(m)} w={barW} fill={p.fillOf(s.g)} solid={p.solid === true} tip={t("when.segmentTip", { month: monthText(p.monthStarts[m] as number), group: p.nameOf(s.g), n: s.n.toLocaleString("en-GB") })} />),
          )}
      {!p.skeleton && p.pick && p.pick.month >= 0 && p.pick.month < months ? (() => {
        const sp = pickSpan(segs[p.pick.month] ?? [], p.pick.group);
        return sp ? <rect class="cx-when-pick" x={barX(p.pick.month)} y={BAR_H - sp[1] * BAR_H} width={barW} height={Math.max(1, (sp[1] - sp[0]) * BAR_H)} /> : null;
      })() : null}
      {!p.skeleton && sel ? <rect class="cx-when-span" x={sel[0] * bw} y={0} width={(sel[1] - sel[0] + 1) * bw} height={BAR_H} /> : null}
      {!p.skeleton && p.hover !== null && p.hover >= 0 && p.hover < months ? (
        <rect class="cx-when-hover" x={p.hover * bw} y={0.5} width={bw} height={BAR_H - 1}>
          <title>{t("when.monthTip", { month: monthText(p.monthStarts[p.hover] as number), n: (totals[p.hover] ?? 0).toLocaleString("en-GB") })}</title>
        </rect>
      ) : null}
      {ticks.map((tk) => (
        <text class="cx-when-tick" x={tk.i * bw} y={BAR_H + 12}>
          {tk.label}
        </text>
      ))}
    </svg>
  );
}

function Bar(p: { seg: Segment; x: number; w: number; fill: Fill; solid: boolean; tip: string }): JSX.Element {
  const y = BAR_H - p.seg.y1 * BAR_H;
  const h = Math.max(1, (p.seg.y1 - p.seg.y0) * BAR_H);
  if (p.fill.colour === null)
    return (
      <rect class="cx-when-bar is-hollow" x={p.x} y={y} width={p.w} height={h}>
        <title>{p.tip}</title>
      </rect>
    );
  if (p.solid)
    return (
      <g>
        <rect class="cx-when-bar is-solid" x={p.x} y={y} width={p.w} height={h} fill={p.fill.colour}>
          <title>{p.tip}</title>
        </rect>
        <rect x={p.x} y={y} width={p.w} height={Math.min(1, h)} fill={p.fill.edge ?? p.fill.colour} />
      </g>
    );
  return (
    <rect class="cx-when-bar" x={p.x} y={y} width={p.w} height={h} fill={p.fill.colour} stroke={p.fill.colour}>
      <title>{p.tip}</title>
    </rect>
  );
}

const LANE_NAME: Readonly<Record<WhenLaneKind, string>> = {
  decision: "when.laneDecision",
  question: "when.laneQuestion",
  plan: "when.lanePlan",
  abandoned: "when.laneAbandoned",
};

export function Lane(p: {
  lane: WhenStats["lanes"][number];
  from: number;
  to: number;
  skeleton: boolean;
  onLive(period: Period | null): void;
  onRange(period: Period): void;
}): JSX.Element {
  const slot = KIND_STYLE[p.lane.kind].slot;
  const x = (ms: number) => ((ms - p.from) / Math.max(1, p.to - p.from)) * W;
  const fmt = useFmt();
  const { handlers, span } = useGesture(
    { w: W, h: 16 },
    {
      onHover: () => undefined,
      onTap: () => undefined,
      onSpan: (a, b, final) => {
        const period = timeSpanPeriod(a / W, b / W, p.from, p.to);
        if (final && period) p.onRange(period);
        else p.onLive(period && (a !== 0 || b !== 0) ? period : null);
      },
    },
  );
  return (
    <div class="cx-when-lane">
      <span class="cx-when-lane-name">
        <span class="cx-when-lane-swatch" style={{ background: `var(--cx-cat-${slot})` }} aria-hidden="true" />
        {t(LANE_NAME[p.lane.kind] as "when.laneDecision")}
        <span class="cx-mono cx-when-lane-n">{p.lane.total.toLocaleString("en-GB")}</span>
      </span>
      <svg class="cx-when-svg cx-when-lane-svg" viewBox={`0 0 ${W} 16`} role="img" aria-label={t("when.laneTotal", { n: p.lane.total.toLocaleString("en-GB") }) + " · " + t(LANE_NAME[p.lane.kind] as "when.laneDecision")} {...handlers}>
        <line class="cx-when-track" x1={0} x2={W} y1={8} y2={8} />
        {p.skeleton
          ? null
          : p.lane.ticks.map((k) => (
              <rect class="cx-when-lane-tick" x={Math.max(0, Math.min(W - 2, x(k.t) - 1))} y={4} width={2} height={8} fill={`var(--cx-cat-${slot})`} stroke="transparent" stroke-width={4}>
                <title>{t("when.tickTip", { title: k.title || "…", date: fmt.date(k.t) })}</title>
              </rect>
            ))}
        {span ? <rect class="cx-when-span" x={Math.min(span[0], span[1])} y={0} width={Math.abs(span[1] - span[0])} height={16} /> : null}
      </svg>
    </div>
  );
}

const CELL = 9;
const PITCH = 11;
const LABEL_W = 26;
const HEAT_TOP = 14;

export function DayHeat(p: {
  days: WhenStats["days"];
  weekStart: 0 | 1;
  skeleton: boolean;
  onLive(period: Period | null): void;
  onRange(period: Period): void;
  onPickDay(day: number, n: number): void;
  /** The day a click picked (local midnight): drawn with a 1.5 px outline. */
  pick?: number | null;
}): JSX.Element {
  const weeks = p.days.weekStarts.length;
  const vbW = LABEL_W + weeks * PITCH;
  const vbH = HEAT_TOP + 7 * PITCH;
  const names = weekdayLabels(p.weekStart);
  const monthLabels = useMemo(() => weekMonthLabels(p.days.weekStarts), [p.days.weekStarts]);
  const colOf = (x: number) => Math.max(0, Math.min(weeks - 1, Math.floor((x - LABEL_W) / PITCH)));
  const rowOf = (y: number) => Math.max(0, Math.min(6, Math.floor((y - HEAT_TOP) / PITCH)));
  const spanPeriod = (a: number, b: number): Period | null => {
    if (weeks === 0) return null;
    const lo = Math.min(colOf(a), colOf(b));
    const hi = Math.max(colOf(a), colOf(b));
    return [p.days.weekStarts[lo] as number, addDaysMs(p.days.weekStarts[hi] as number, 7) - 1];
  };
  const { handlers, span } = useGesture(
    { w: vbW, h: vbH },
    {
      onHover: () => undefined,
      onTap: (pt) => {
        if (weeks === 0 || pt.x < LABEL_W || pt.y < HEAT_TOP) return;
        const w = colOf(pt.x);
        const r = rowOf(pt.y);
        p.onPickDay(addDaysMs(p.days.weekStarts[w] as number, r), p.days.counts[r * weeks + w] ?? 0);
      },
      onSpan: (a, b, final) => {
        const period = spanPeriod(a, b);
        if (final && period) p.onRange(period);
        else p.onLive(period && (a !== 0 || b !== 0) ? period : null);
      },
    },
  );
  const sel = span ? ([Math.min(colOf(span[0]), colOf(span[1])), Math.max(colOf(span[0]), colOf(span[1]))] as const) : null;
  const pickedCell = (() => {
    if (p.pick === null || p.pick === undefined) return null;
    for (let w = 0; w < weeks; w++) for (let r = 0; r < 7; r++) if (addDaysMs(p.days.weekStarts[w] as number, r) === p.pick) return { w, r };
    return null;
  })();
  const cells: JSX.Element[] = [];
  for (let w = 0; w < weeks; w++) {
    for (let r = 0; r < 7; r++) {
      const n = p.days.counts[r * weeks + w] ?? 0;
      const lvl = p.skeleton ? 0 : heatLevel(n, p.days.max);
      const dayMs = addDaysMs(p.days.weekStarts[w] as number, r);
      cells.push(
        <rect class={`cx-when-cell is-${lvl}${p.skeleton ? " is-skel" : ""}`} x={LABEL_W + w * PITCH} y={HEAT_TOP + r * PITCH} width={CELL} height={CELL} rx={1.5}>
          {p.skeleton ? null : <title>{t("when.dayTip", { date: dayText(dayMs), n: n.toLocaleString("en-GB") })}</title>}
        </rect>,
      );
    }
  }
  return (
    <svg class="cx-when-svg cx-when-heat" viewBox={`0 0 ${vbW} ${vbH}`} style={{ width: `${vbW}px` }} role="img" aria-label={t("when.chartLabel", { name: t("when.days") })} {...handlers}>
      {monthLabels.map((l) => (
        <text class="cx-when-tick" x={LABEL_W + l.w * PITCH} y={9}>
          {l.label}
        </text>
      ))}
      {[0, 2, 4].map((r) => (
        <text class="cx-when-tick" x={0} y={HEAT_TOP + r * PITCH + 8}>
          {names[r]}
        </text>
      ))}
      {cells}
      {!p.skeleton && pickedCell ? <rect class="cx-when-pick" x={LABEL_W + pickedCell.w * PITCH - 0.5} y={HEAT_TOP + pickedCell.r * PITCH - 0.5} width={CELL + 1} height={CELL + 1} rx={2} /> : null}
      {!p.skeleton && sel ? <rect class="cx-when-span" x={LABEL_W + sel[0] * PITCH} y={HEAT_TOP} width={(sel[1] - sel[0] + 1) * PITCH} height={7 * PITCH} /> : null}
    </svg>
  );
}

// ───────────────────────────── the sections ─────────────────────────────

function Legend(p: { items: { label: string; fill: Fill }[] }): JSX.Element {
  return (
    <ul class="cx-when-legend">
      {p.items.map((it) => (
        <li>
          <span class={`cx-when-dot${it.fill.colour === null ? " is-hollow" : ""}`} style={it.fill.colour === null ? undefined : { background: it.fill.colour }} aria-hidden="true" />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

/** How long the "Copied" confirmation stays on a section's CSV action. */
const COPIED_MS = 1600;

function SectionHead(p: { title: string; range: string; csv?: () => string }): JSX.Element {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
  const copy = async () => {
    const ok = await copyToClipboard((p.csv as () => string)());
    if (!alive.current) return;
    setState(ok ? "copied" : "failed");
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  };
  return (
    <div class="cx-when-head">
      <span class="cx-when-dash" aria-hidden="true" />
      <span class="cx-when-title">{p.title}</span>
      <span class="cx-when-range cx-mono">{p.range}</span>
      {p.csv ? (
        <button type="button" class="cx-text-button cx-when-copy" aria-label={t("when.copyCsvFor", { name: p.title })} onClick={() => void copy()}>
          {state === "copied" ? t("when.csvCopied") : state === "failed" ? t("errors.action") : t("when.copyCsv")}
        </button>
      ) : null}
    </div>
  );
}

/** A stack with its Unsorted (no value) group removed. */
export function withoutNone(stack: WhenStack, months: number): WhenStack {
  const keep = stack.groups.map((g, i) => ({ g, i })).filter((x) => x.g.kind !== "none");
  if (keep.length === stack.groups.length) return stack;
  return { groups: keep.map((x) => x.g), cells: keep.flatMap((x) => stack.cells.slice(x.i * months, (x.i + 1) * months)) };
}

/** The label text of a stacked group in a dimension. */
export function groupText(dim: DimId, g: WhenStack["groups"][number], noLabel: string): string {
  if (g.kind === "none") return dim === "space" ? t("when.unsorted") : noLabel;
  if (g.kind === "other") return t("when.other");
  if (dim === "space") return areaLabel(g.key);
  if (dim === "kind") return kindLabel(g.key);
  if (dim === "source" || dim === "speaker") return valueLabel(g.key);
  return g.label || g.key;
}

/** `embedded`: the page above already carries the title and the intro line (Time › Charts), so the block starts at the charts. */
export function WhenSections(p: { hideUnsorted: boolean; embedded?: boolean }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const fmt = useFmt();
  const index = useIndex(s);
  const ui = leaf.store.slices.ui.value;
  const view = leaf.store.slices.view.value;
  const vis = visibilityParams(ui, view);
  const [labelDimId, setLabelDimId] = useState<DimId>("kind");
  const [hover, setHover] = useState<number | null>(null);
  const [picked, setPicked] = useState<WhenPick | null>(null);
  const live = useRef<string | null>(null);

  const data = useLoad<WhenStats>(
    async (signal) => {
      const r = await s.worker.call(statsKey(leaf.viewId, "when"), "stats", { kind: "when", labelDim: labelDimId, weekStart: fmt.weekStart, visibility: vis }, { signal });
      if (r.kind !== "when") throw new Error("unexpected stats result");
      return r;
    },
    [JSON.stringify(vis), labelDimId, fmt.weekStart, index],
  );

  // Which packs tagged how much (the lanes only fill from tagged notes); the whole record, not the period.
  const packs = useLoad<ReturnType<typeof taggedShare>>(
    async (signal) => {
      const r = await s.worker.call(statsKey(leaf.viewId, "whenPacks"), "stats", { kind: "packs", includeSuperseded: false }, { signal });
      return r.kind === "packs" ? taggedShare(r.packs) : null;
    },
    [index],
  );
  const tagged = packs.state === "ready" ? packs.value : null;

  // Skeleton bars while a new range is counted, never longer than SKELETON_CAP_MS.
  const [skeleton, setSkeleton] = useState(false);
  const loading = data.state === "loading";
  useEffect(() => {
    if (!loading) return setSkeleton(false);
    setSkeleton(true);
    const id = setTimeout(() => setSkeleton(false), SKELETON_CAP_MS);
    return () => clearTimeout(id);
  }, [loading]);

  const setPreview = (period: Period | null) => {
    const key = period ? previewKey(period) : null;
    if (live.current === key) return;
    live.current = key;
    leaf.store.update("ui", { preview: key ? { kind: "period", key } : null });
  };
  useEffect(() => () => {
    if (live.current !== null) leaf.store.update("ui", { preview: null });
  }, []);

  // The status line reads the lock token itself, so it survives a remount and follows removal from the token chips.
  const lockedText = ui.tokens.find((k) => k.id === "when:time")?.label ?? null;
  const locked = lockedText !== null;
  // The outline and the dimmed charts follow the lock: removing its chip (or a second click) lets go of the pick.
  useEffect(() => {
    if (!locked) setPicked(null);
  }, [locked]);
  const clearLock = () => {
    setPicked(null);
    clearLockTokens(leaf.store);
  };
  const lock = (range: Period, text: string, group?: LockGroup, recordsOnly = false) => lockTokens(leaf.store, range, text, group, recordsOnly);
  const setRange = (period: Period) => {
    setPreview(null);
    setPeriod(leaf.store, period);
  };

  if (data.state === "error") return <ErrorCard message={t("errors.time")} retry={data.retry} />;
  const d = data.state === "ready" ? data.value : data.state === "loading" ? data.previous : undefined;
  if (!d) {
    return (
      <section class="cx-when" aria-busy="true" aria-label={t("when.title")}>
        <div class="cx-section-label">
          <span>{t("when.title")}</span>
        </div>
        <svg class="cx-when-svg" viewBox={`0 0 ${W} ${BAR_H + AXIS_H}`} aria-label={t("when.loading")}>
          {skeletonHeights(24).map((h, m) => (
            <rect class="cx-when-skel" x={m * (W / 24) + 0.25} y={BAR_H - h * BAR_H} width={W / 24 - 0.5} height={h * BAR_H} />
          ))}
        </svg>
      </section>
    );
  }

  const months = d.monthStarts.length - 1;
  const from = months > 0 ? (d.monthStarts[0] as number) : 0;
  const to = months > 0 ? (d.monthStarts[months] as number) : 0;
  const range = ui.period ? rangeText(ui.period[0], ui.period[1]) : Number.isFinite(d.first) ? rangeText(d.first, d.last) : "";
  const slots = (() => {
    try {
      return s.colours.current()["space"];
    } catch {
      return undefined;
    }
  })();
  const colourOfArea = (g: WhenStack["groups"][number]): Fill => {
    if (g.kind === "none") return { colour: null };
    if (g.kind === "other") return { colour: "var(--cx-cat-other)" };
    const slot = areaSlot(g.key, slots);
    return { colour: slot === null ? "var(--cx-none)" : `var(--cx-cat-${slot})` };
  };
  const colourOfRank = (stack: WhenStack, g: number): Fill => {
    const grp = stack.groups[g];
    if (!grp || grp.kind === "none") return { colour: null };
    if (grp.kind === "other") return { colour: "var(--cx-cat-other)" };
    const rank = stack.groups.slice(0, g).filter((x) => x.kind === "value").length;
    return { colour: `var(--cx-cat-${(rank % 8) + 1})` };
  };

  const area = p.hideUnsorted ? withoutNone(d.area, months) : d.area;
  const labelsStack = d.labels;
  const labelName = (() => {
    const choice = labelChoices(index?.labels ?? []).find((c) => c.id === labelDimId);
    return dimLabel(labelDimId, (pack, field) => (choice?.pack === pack ? STARTER_PACKS.find((x) => x.id === pack)?.fields.find((f) => f.key === field)?.label : undefined));
  })();
  const labelOptions = labelChoices(index?.labels ?? []).map((c) => ({
    value: c.id as string,
    label: dimLabel(c.id, (pack, field) => STARTER_PACKS.find((x) => x.id === pack)?.fields.find((f) => f.key === field)?.label ?? (c.pack === pack ? field : undefined)),
  }));
  if (!labelOptions.some((o) => o.value === labelDimId)) labelOptions.unshift({ value: labelDimId, label: labelName });

  const speakerStack: WhenStack = {
    groups: [
      { key: "you", label: t("when.you"), kind: "value" },
      { key: "assistant", label: t("when.assistants"), kind: "value" },
      { key: "other", label: t("when.others"), kind: "value" },
    ],
    cells: [...d.speakers.you, ...d.speakers.assistant, ...d.speakers.other],
  };
  const speakerFill: Fill[] = [
    { colour: "var(--cx-you-fill)", edge: "var(--cx-you)" },
    { colour: "var(--cx-assistant-fill)", edge: "var(--cx-assistant)" },
    { colour: "var(--cx-voice-other)", edge: "var(--cx-voice-other)" },
  ];

  const monthRange = (m: number): Period => [d.monthStarts[m] as number, (d.monthStarts[m + 1] as number) - 1];
  const hoverMonth = (m: number | null) => {
    setHover(m);
    setPreview(m !== null && m >= 0 && m < months ? monthRange(m) : null);
  };
  /** Click on a month: lock it (and the segment's group when there is one); a second click on the same month clears. */
  const pick = (stack: WhenStack, dim: DimId, section: "area" | "speakers" | "labels") => (m: number, gi: number | null) => {
    const range = monthRange(m);
    const month = monthText(range[0]);
    const g = gi === null ? undefined : stack.groups[gi];
    const withGroup = g && g.kind === "value" ? g : undefined;
    const n = withGroup ? (stack.cells[(gi as number) * months + m] ?? 0) : (monthTotals(stack, months)[m] ?? 0);
    const text = lockText(n, month, withGroup ? groupText(dim, withGroup, "") : undefined);
    if (locked && lockedText === text) return clearLock();
    setPicked({ section, month: m, group: withGroup ? gi : null });
    lock(range, text, withGroup ? { dim, value: withGroup.key, label: groupText(dim, withGroup, ""), alsoValues: dim === "speaker" && withGroup.key === "other" ? ["tool"] : undefined } : undefined);
  };
  const pickDay = (day: number, n: number) => {
    const text = t("when.inDay", { n: n.toLocaleString("en-GB"), date: dayText(day) });
    if (locked && lockedText === text) return clearLock();
    setPicked({ section: "days", day });
    lock([day, addDaysMs(day, 1) - 1], text, undefined, true);
  };

  const openTable = (rows = "month") => setPageParams(leaf.store, { tab: "data", rows });
  const rangeAll = months > 0;
  const noLabel = t("when.labelNone", { label: labelName.toLowerCase() });
  return (
    <section class="cx-when" aria-label={t("when.title")} aria-busy={loading ? "true" : undefined}>
      {p.embedded && !ui.period ? null : (
        <div class="cx-section-label">
          <span>{p.embedded ? "" : t("when.title")}</span>
          {ui.period ? (
            <button type="button" class="cx-text-button" onClick={() => setPeriod(leaf.store, null)}>
              {t("when.resetRange")}
            </button>
          ) : null}
        </div>
      )}
      {p.embedded ? null : <p class="cx-when-hint">{t("when.hint")}</p>}
      {locked && lockedText ? (
        <p class="cx-when-status" role="status">
          <span>{lockedText}</span>
          <button type="button" class="cx-text-button" onClick={clearLock}>
            {t("when.clear")}
          </button>
        </p>
      ) : null}
      {!rangeAll ? (
        <p class="cx-note">{t("when.empty")}</p>
      ) : (
        <>
          <div class={blockClass(picked, "area")}>
            <SectionHead title={t("when.activity")} range={range} csv={() => stackCsv(d.monthStarts, area, (g) => groupText("space", area.groups[g] as WhenStack["groups"][number], ""), t("when.csvMonth"))} />
            <p class="cx-when-sentence">{t("when.activityNote", { n: monthTotals(d.area, months).reduce((a, b) => a + b, 0).toLocaleString("en-GB") })}</p>
            <MonthChart
              name={t("when.activity")}
              monthStarts={d.monthStarts}
              stack={area}
              fillOf={(g) => colourOfArea(area.groups[g] as WhenStack["groups"][number])}
              nameOf={(g) => groupText("space", area.groups[g] as WhenStack["groups"][number], "")}
              hover={hover}
              skeleton={skeleton}
              onHover={hoverMonth}
              onPick={pick(area, "space", "area")}
              pick={picked?.section === "area" ? picked : null}
              onLive={setPreview}
              onRange={setRange}
            />
            <p class="cx-when-sentence">{t("when.scaleNote", { n: Math.max(0, ...monthTotals(area, months)).toLocaleString("en-GB") })}</p>
            <Legend items={area.groups.map((g) => ({ label: groupText("space", g, ""), fill: colourOfArea(g) }))} />
            <div class="cx-when-foot">
              <button type="button" class="cx-text-button" onClick={() => openTable()}>
                {t("when.numbers")}
              </button>
            </div>
          </div>

          <div class={blockClass(picked, "lanes")}>
            <SectionHead title={t("when.lanes")} range={range} csv={() => lanesCsv(d.lanes, (k) => t(LANE_NAME[k as WhenLaneKind] as "when.laneDecision"), [t("when.csvKind"), t("when.csvDate"), t("when.csvTitle")])} />
            <p class="cx-when-sentence">
              {tagged
                ? t("when.taggedNote", {
                    p: tagged.pct,
                    n: tagged.n.toLocaleString("en-GB"),
                    total: tagged.total.toLocaleString("en-GB"),
                    pack: tagged.pack,
                    more: tagged.more > 0 ? t("when.taggedMore", { k: tagged.more }) : "",
                    rest: tagged.rest > 0 ? t("when.taggedRest", { k: tagged.rest.toLocaleString("en-GB") }) : "",
                  })
                : t("when.taggedNone")}
            </p>
            {d.lanes.map((lane) => (
              <Lane lane={lane} from={from} to={to} skeleton={skeleton} onLive={setPreview} onRange={setRange} />
            ))}
            {laneDrawn(d.lanes).total > 0 ? (
              <p class="cx-when-sentence">{t("when.drawnNote", { drawn: laneDrawn(d.lanes).drawn.toLocaleString("en-GB"), total: laneDrawn(d.lanes).total.toLocaleString("en-GB") })}</p>
            ) : null}
            <div class="cx-when-foot">
              <button type="button" class="cx-text-button" onClick={() => openTable()}>
                {t("when.numbers")}
              </button>
            </div>
          </div>

          <div class={blockClass(picked, "days")}>
            <SectionHead title={t("when.days")} range={range} csv={() => daysCsv(d.days, addDaysMs, [t("when.csvDate"), t("when.csvEntries")])} />
            <p class="cx-when-sentence">{t("when.daysNote", { n: daysWithEntries(d.days.counts).toLocaleString("en-GB") })}</p>
            <div class="cx-when-heat-wrap">
              <DayHeat days={d.days} weekStart={fmt.weekStart} skeleton={skeleton} onLive={setPreview} onRange={setRange} onPickDay={pickDay} pick={picked?.section === "days" ? picked.day : null} />
            </div>
            <div class="cx-when-foot">
              <button type="button" class="cx-text-button" onClick={() => openTable("day")}>
                {t("when.numbers")}
              </button>
            </div>
          </div>

          <div class={blockClass(picked, "speakers")}>
            <SectionHead title={t("when.speakers")} range={range} csv={() => stackCsv(d.monthStarts, speakerStack, (g) => speakerStack.groups[g]?.label ?? "", t("when.csvMonth"))} />
            <MonthChart
              name={t("when.speakers")}
              monthStarts={d.monthStarts}
              stack={speakerStack}
              solid
              fillOf={(g) => speakerFill[g] as Fill}
              nameOf={(g) => speakerStack.groups[g]?.label ?? ""}
              hover={hover}
              skeleton={skeleton}
              onHover={hoverMonth}
              onPick={pick(speakerStack, "speaker", "speakers")}
              pick={picked?.section === "speakers" ? picked : null}
              onLive={setPreview}
              onRange={setRange}
            />
            <Legend items={speakerStack.groups.map((g, i) => ({ label: g.label, fill: speakerFill[i] as Fill }))} />
            <div class="cx-when-foot">
              <button type="button" class="cx-text-button" onClick={() => setPageParams(leaf.store, { tab: "data", rows: "month" })}>
                {t("when.numbers")}
              </button>
              {d.undated > 0 ? <span class="cx-when-note">{t("when.undatedNote", { n: d.undated.toLocaleString("en-GB") })}</span> : null}
            </div>
          </div>

          <div class={blockClass(picked, "labels")}>
            <SectionHead title={t("when.labels")} range={range} csv={() => stackCsv(d.monthStarts, labelsStack, (g) => groupText(labelDimId, labelsStack.groups[g] as WhenStack["groups"][number], noLabel), t("when.csvMonth"))} />
            <div class="cx-when-labelrow">
              <Select<string> label={t("when.labelSelect")} value={labelDimId} options={labelOptions} onChange={(v) => setLabelDimId(v as DimId)} />
            </div>
            <MonthChart
              name={`${t("when.labels")} · ${labelName}`}
              monthStarts={d.monthStarts}
              stack={labelsStack}
              fillOf={(g) => colourOfRank(labelsStack, g)}
              nameOf={(g) => groupText(labelDimId, labelsStack.groups[g] as WhenStack["groups"][number], noLabel)}
              hover={hover}
              skeleton={skeleton}
              onHover={hoverMonth}
              onPick={pick(labelsStack, labelDimId, "labels")}
              pick={picked?.section === "labels" ? picked : null}
              onLive={setPreview}
              onRange={setRange}
            />
            <Legend items={labelsStack.groups.map((g, i) => ({ label: groupText(labelDimId, g, noLabel), fill: colourOfRank(labelsStack, i) }))} />
            <div class="cx-when-foot">
              <button type="button" class="cx-text-button" onClick={() => setPageParams(leaf.store, { tab: "data", rows: "month" })}>
                {t("when.numbers")}
              </button>
              {labelsStack.unlabelled > 0 ? <span class="cx-when-note">{t("when.unlabelledNote", { n: labelsStack.unlabelled.toLocaleString("en-GB"), label: labelName.toLowerCase() })}</span> : null}
              {d.undated > 0 ? <span class="cx-when-note">{t("when.undatedNote", { n: d.undated.toLocaleString("en-GB") })}</span> : null}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
