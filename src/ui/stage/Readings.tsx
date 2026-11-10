/**
 * Chart readings (ORIG-07): up to three computed annotations drawn ON the chart — a callout at the peak hour, a
 * bracket on the longest calendar run, the widest ribbon labelled with its count — from ArrangementResult.readings
 * (copy keys readings.*). No canned question and no answer caption: the user asks with "Ask about this chart".
 * Owner: E9.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { project } from "../../render/overlay";
import type { DimId } from "../../shared/dims";
import type { ChartReading } from "../../shared/protocol/worker";
import { t, type CopyKey } from "../copy";
import { categoryName, parseRef, renamesOf, useChartFeed, type CategoryNames } from "./ChartOverlay";

/** "21:00 · peak", "23 days", "1,284": the copy key filled with the reading's values (category names resolved). */
export function readingText(r: ChartReading, names?: CategoryNames): string {
  const values: Record<string, string | number> = { ...r.values };
  const cat = readingCategory(r);
  if (cat && typeof values.label === "string") values.label = categoryName(cat[0], cat[1], values.label, names);
  return t(r.copyKey as CopyKey, values);
}

/** The `[dimension, value]` a reading names, when the worker sent one. */
export function readingCategory(r: ChartReading): [DimId, string] | null {
  const raw = r.values.cat;
  if (typeof raw !== "string") return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string" ? [v[0] as DimId, v[1]] : null;
  } catch {
    return null;
  }
}

/** The ref of a reading (what Trace traces), or null. */
export function readingRef(r: ChartReading): ReturnType<typeof parseRef> {
  return parseRef(r.values.ref);
}

interface ScreenReading {
  key: string;
  text: string;
  x: number;
  y: number;
  /** Bracket end. */
  x2?: number;
  y2?: number;
}

/** The leader's offset from the annotated point (up and to the right), in CSS px. */
const LEADER = { dx: 16, dy: -14 } as const;

export function Readings(): JSX.Element {
  const { feed, value, visible } = useChartFeed();
  const [placed, setPlaced] = useState<ScreenReading[]>([]);
  const latest = useRef(value);
  latest.current = value;
  useEffect(
    () =>
      feed.onFrame((f) => {
        const cur = latest.current;
        if (!f.changed || !cur) return;
        const out: ScreenReading[] = [];
        const names = renamesOf(cur.spec.options);
        (cur.result.readings ?? []).forEach((r, i) => {
          const a = project(r.at, f.camera, f.width, f.height);
          if (!a.visible) return;
          const item: ScreenReading = { key: `${i}:${r.kind}`, text: readingText(r, names), x: a.x, y: a.y };
          if (r.to) {
            const b = project(r.to, f.camera, f.width, f.height);
            if (b.visible) {
              item.x2 = b.x;
              item.y2 = b.y;
            }
          }
          out.push(item);
        });
        setPlaced((prev) => (sameReadings(prev, out) ? prev : out));
      }),
    [feed],
  );
  return (
    <div class="cx-readings" aria-hidden="true" style={{ opacity: visible ? 1 : 0 }}>
      {placed.map((r) =>
        r.x2 !== undefined && r.y2 !== undefined ? (
          <div key={r.key} class="cx-reading is-bracket" style={bracketStyle(r)}>
            <span class="cx-reading-text cx-mono">{r.text}</span>
          </div>
        ) : (
          <div key={r.key} class="cx-reading is-callout" style={{ transform: `translate(${r.x.toFixed(1)}px, ${r.y.toFixed(1)}px)` }}>
            <span class="cx-reading-dot" />
            <span class="cx-reading-leader" style={{ width: `${Math.hypot(LEADER.dx, LEADER.dy).toFixed(1)}px`, transform: `rotate(${(Math.atan2(LEADER.dy, LEADER.dx) * 180) / Math.PI}deg)` }} />
            <span class="cx-reading-text cx-mono" style={{ left: `${LEADER.dx}px`, top: `${LEADER.dy}px` }}>
              {r.text}
            </span>
          </div>
        ),
      )}
    </div>
  );
}

function sameReadings(a: readonly ScreenReading[], b: readonly ScreenReading[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => r.key === b[i]!.key && r.text === b[i]!.text && Math.abs(r.x - b[i]!.x) < 0.5 && Math.abs(r.y - b[i]!.y) < 0.5 && r.x2 === b[i]!.x2 && r.y2 === b[i]!.y2);
}

/** A bracket is a thin bar between its two anchors with the label centred over it. */
export function bracketStyle(r: { x: number; y: number; x2?: number; y2?: number }): Record<string, string> {
  const x2 = r.x2 ?? r.x, y2 = r.y2 ?? r.y;
  const len = Math.hypot(x2 - r.x, y2 - r.y);
  const deg = (Math.atan2(y2 - r.y, x2 - r.x) * 180) / Math.PI;
  return { transform: `translate(${r.x.toFixed(1)}px, ${r.y.toFixed(1)}px) rotate(${deg.toFixed(2)}deg)`, width: `${len.toFixed(1)}px` };
}
