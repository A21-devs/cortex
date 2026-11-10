/**
 * Time › Figure, the spine laid flat (CORTEX-UX §5.19; ORIG-02): 360 × 260 on the cord's own τ. Fronds (one tick
 * per conversation, length ∝ log messages, coloured by area) rise above the axis; your words (amber) and the
 * assistant's (violet) are mirrored around it; machine-note kind markers ride the axis (◆ decision, ? question,
 * ▸ plan, × abandoned). One brush, shared with the strip, sets the period. Owner: E12; data from worker stats
 * "spine".
 */
import type { JSX } from "preact";
import { useRef } from "preact/hooks";
import type { StatsResult } from "../../shared/protocol/worker";
import { t } from "../copy";
import { areaSlot } from "../reader/marks";

export const SPINE_FIGURE = { width: 360, height: 260 } as const;
export type SpineStats = Extract<StatsResult, { kind: "spine" }>;

const AXIS_Y = 150;
const FROND_BASE = 100;
const VOICE_H = 44;
const BRUSH_Y = 214;
const BRUSH_H = 18;

/** x position (px) of τ ∈ [0, 1] across the figure, with 8 px of inset at both ends. */
export function tauToX(tau: number, width: number = SPINE_FIGURE.width): number {
  const inset = 8;
  return inset + Math.max(0, Math.min(1, tau)) * (width - 2 * inset);
}

/** The inverse of tauToX. */
export function xToTau(x: number, width: number = SPINE_FIGURE.width): number {
  const inset = 8;
  return Math.max(0, Math.min(1, (x - inset) / (width - 2 * inset)));
}

/** Frond tick length (px) for a conversation of n messages: ∝ log(1 + n), capped at 40 px. */
export function tickLength(n: number): number {
  return Math.min(40, 6 * Math.log1p(Math.max(0, n)));
}

/** A frond with the time of its conversation's first message, for mapping the brush to a period. */
export interface TimedFrond {
  tau: number;
  ms: number;
}

/** Period [from, to] for a brush between two τ positions: the times of the nearest fronds. */
export function periodFromBrush(fronds: readonly TimedFrond[], tauA: number, tauB: number): [number, number] | null {
  if (fronds.length === 0) return null;
  const near = (tau: number) => fronds.reduce((best, f) => (Math.abs(f.tau - tau) < Math.abs(best.tau - tau) ? f : best), fronds[0] as TimedFrond);
  const a = near(Math.min(tauA, tauB)).ms;
  const b = near(Math.max(tauA, tauB)).ms;
  return a === b ? null : [Math.min(a, b), Math.max(a, b)];
}

/** τ extent of a period: the first and last frond whose time falls inside it. */
export function brushFromPeriod(fronds: readonly TimedFrond[], period: readonly [number, number] | null): [number, number] | null {
  if (!period) return null;
  const inside = fronds.filter((f) => f.ms >= period[0] && f.ms <= period[1]);
  if (inside.length === 0) return null;
  return [Math.min(...inside.map((f) => f.tau)), Math.max(...inside.map((f) => f.tau))];
}

const MARKER_GLYPH = { decision: "◆", question: "?", plan: "▸", abandoned: "×" } as const;

export interface SpineFigureProps {
  data: SpineStats;
  /** Start time of each conversation row (by SpineFrond.conv) and the area-slot map. */
  startOf(conv: number): number;
  slots?: Readonly<Record<string, number>>;
  period: readonly [number, number] | null;
  hideNoArea: boolean;
  onBrush(period: [number, number] | null): void;
  summary: string;
  svgRef?: { current: SVGSVGElement | null };
}

export function SpineFigure(p: SpineFigureProps): JSX.Element {
  const { width, height } = SPINE_FIGURE;
  const timed: TimedFrond[] = p.data.fronds.map((f) => ({ tau: f.tau, ms: p.startOf(f.conv) })).filter((f) => Number.isFinite(f.ms));
  const brush = brushFromPeriod(timed, p.period);
  const maxVoice = p.data.voices.reduce((m, v) => Math.max(m, v.you, v.assistant), 0) || 1;
  const area = (pick: "you" | "assistant", dir: -1 | 1): string => {
    if (p.data.voices.length === 0) return "";
    const pts = p.data.voices.map((v) => `${tauToX(v.tau).toFixed(1)},${(AXIS_Y + dir * (v[pick] / maxVoice) * VOICE_H).toFixed(1)}`);
    const first = tauToX(p.data.voices[0]?.tau ?? 0).toFixed(1);
    const last = tauToX(p.data.voices[p.data.voices.length - 1]?.tau ?? 1).toFixed(1);
    return `M${first},${AXIS_Y} L${pts.join(" L")} L${last},${AXIS_Y} Z`;
  };
  const drag = useRef<number | null>(null);
  const tauAt = (e: PointerEvent): number => {
    const svg = e.currentTarget as SVGSVGElement;
    const box = svg.getBoundingClientRect();
    return xToTau(((e.clientX - box.left) / Math.max(1, box.width)) * width);
  };
  const onDown = (e: PointerEvent) => {
    drag.current = tauAt(e);
    (e.currentTarget as SVGSVGElement).setPointerCapture?.(e.pointerId);
  };
  const onUp = (e: PointerEvent) => {
    const from = drag.current;
    drag.current = null;
    if (from === null) return;
    const to = tauAt(e);
    p.onBrush(Math.abs(to - from) < 0.01 ? null : periodFromBrush(timed, from, to));
  };
  const onKey = (e: KeyboardEvent) => {
    if (!brush || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const step = (e.key === "ArrowRight" ? 1 : -1) * 0.05;
    const next = periodFromBrush(timed, Math.max(0, brush[0] + step), Math.min(1, brush[1] + step));
    if (next) p.onBrush(next);
  };
  return (
    <figure class="cx-spine-figure">
      <svg
        ref={p.svgRef}
        class="cx-spine-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={p.summary}
        tabIndex={0}
        onPointerDown={onDown}
        onPointerUp={onUp}
        onKeyDown={onKey}
      >
        <title>{t("time.figure2")}</title>
        <path d={area("you", -1)} fill="var(--cx-you)" opacity="0.7" />
        <path d={area("assistant", 1)} fill="var(--cx-assistant)" opacity="0.7" />
        <line x1={tauToX(0)} x2={tauToX(1)} y1={AXIS_Y} y2={AXIS_Y} stroke="var(--cx-line-strong)" stroke-width="1" />
        {p.data.fronds
          .filter((f) => !(p.hideNoArea && f.space === "none"))
          .map((f) => {
            const slot = areaSlot(f.space, p.slots);
            const x = tauToX(f.tau);
            const inside = !brush || (f.tau >= brush[0] && f.tau <= brush[1]);
            const tip = t("time.tickTip", { title: `${Math.round(f.tau * 100)}%`, n: f.messages, area: f.space });
            return (
              <line x1={x} x2={x} y1={FROND_BASE} y2={FROND_BASE - tickLength(f.messages)} stroke={slot ? `var(--cx-cat-${slot}-glow)` : "var(--cx-text-3)"} stroke-width="1.5" stroke-linecap="round" opacity={inside ? 0.95 : 0.25}>
                <title>{tip}</title>
              </line>
            );
          })}
        {p.data.markers.map((m) => (
          <text x={tauToX(m.tau)} y={AXIS_Y + 3} text-anchor="middle" font-size="9" fill="var(--cx-text-1)">
            {MARKER_GLYPH[m.kind]}
          </text>
        ))}
        <rect x={tauToX(0)} y={BRUSH_Y} width={tauToX(1) - tauToX(0)} height={BRUSH_H} rx="3" fill="var(--cx-chrome-alt)" stroke="var(--cx-line)" />
        {brush ? (
          <rect x={tauToX(brush[0])} y={BRUSH_Y} width={Math.max(2, tauToX(brush[1]) - tauToX(brush[0]))} height={BRUSH_H} rx="3" fill="var(--cx-accent-soft)" stroke="var(--cx-accent)">
            <title>{t("time.brush")}</title>
          </rect>
        ) : null}
      </svg>
      <figcaption class="cx-note">{t("time.scale")}</figcaption>
    </figure>
  );
}

/** Rasterise the figure to PNG bytes (resolving the CSS variables it uses); null when the browser cannot. */
export async function figureToPng(svg: SVGSVGElement, scale = 2): Promise<Uint8Array | null> {
  try {
    const style = getComputedStyle(svg);
    const xml = new XMLSerializer().serializeToString(svg).replace(/var\((--[a-z0-9-]+)\)/g, (_m, name: string) => style.getPropertyValue(name).trim() || "#888888");
    const withNs = xml.includes("xmlns=") ? xml : xml.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
    const img = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image"));
    });
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(withNs)}`;
    await loaded;
    const canvas = document.createElement("canvas");
    canvas.width = SPINE_FIGURE.width * scale;
    canvas.height = SPINE_FIGURE.height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = getComputedStyle(svg).getPropertyValue("--cx-chrome").trim() || "#1c1c1c";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}
