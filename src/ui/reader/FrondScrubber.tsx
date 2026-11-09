/**
 * Mini frond scrubber (CORTEX-UX §5.14; ORIG-12): a 360 × 14 px bar of the conversation's messages, one sliver each,
 * coloured by speaker (you amber, assistant violet, tool slate and shorter), part boundaries as ticks under the
 * bar, the current message as a white tick with a caret. Click or drag to step (the step is committed when the
 * pointer is released, so dragging across 500 messages never loads 500 readers); ←/→ step one message, PageUp /
 * PageDown ten, Home / End the ends. role="slider" with "Message 39 of 549, you, 3 Nov 14:52". Owner: E12.
 */
import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import type { Speaker } from "../../shared/types";
import { t } from "../copy";

export const SCRUBBER_WIDTH = 360;

/** Message index under a pointer x (0..width) for a bar of `count` messages. */
export function scrubIndex(x: number, width: number, count: number): number {
  if (count <= 0 || width <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.floor((x / width) * count)));
}

/** Slivers to draw: one per message, or binned by majority speaker when there are more messages than pixels. */
export function scrubberBins(speakers: readonly Speaker[], maxBins: number = SCRUBBER_WIDTH): { speaker: Speaker; from: number; to: number }[] {
  const n = speakers.length;
  if (n <= maxBins) return speakers.map((sp, i) => ({ speaker: sp, from: i, to: i }));
  const out: { speaker: Speaker; from: number; to: number }[] = [];
  for (let b = 0; b < maxBins; b++) {
    const from = Math.floor((b * n) / maxBins);
    const to = Math.max(from, Math.floor(((b + 1) * n) / maxBins) - 1);
    const counts: Record<Speaker, number> = { you: 0, assistant: 0, other: 0, tool: 0 };
    for (let i = from; i <= to; i++) counts[speakers[i] ?? "other"]++;
    const speaker = (Object.keys(counts) as Speaker[]).reduce((a, k) => (counts[k] > counts[a] ? k : a), "you");
    out.push({ speaker, from, to });
  }
  return out;
}

export interface FrondScrubberProps {
  speakers: readonly Speaker[];
  index: number;
  onStep(i: number): void;
  /** First message index of each part after the first (boundary ticks). */
  partStarts?: readonly number[];
  /** aria-valuetext for a message ("Message 39 of 549, you, 3 Nov 14:52"). */
  describe?: (i: number) => string;
  label?: string;
}

export function FrondScrubber(p: FrondScrubberProps): JSX.Element {
  const count = p.speakers.length;
  const [preview, setPreview] = useState<number | null>(null);
  const dragging = useRef(false);
  const shown = Math.max(0, Math.min(count - 1, preview ?? p.index));
  const bins = scrubberBins(p.speakers);
  const at = (e: PointerEvent): number => {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    return scrubIndex(e.clientX - r.left, r.width || SCRUBBER_WIDTH, count);
  };
  const commit = (i: number) => {
    setPreview(null);
    if (i !== p.index) p.onStep(i);
  };
  const describe = p.describe ?? ((i: number) => t("reader.position", { i: i + 1, n: count }));
  const pct = (i: number) => (count <= 1 ? 0 : (i / (count - 1)) * 100);
  return (
    <div
      class="cx-frond-scrubber"
      role="slider"
      tabIndex={0}
      aria-label={p.label ?? t("reader.inConversation")}
      aria-valuemin={1}
      aria-valuemax={Math.max(1, count)}
      aria-valuenow={shown + 1}
      aria-valuetext={describe(shown)}
      onPointerDown={(e) => {
        if (count === 0) return;
        dragging.current = true;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        setPreview(at(e));
      }}
      onPointerMove={(e) => {
        if (dragging.current) setPreview(at(e));
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
        commit(at(e));
      }}
      onPointerCancel={() => {
        dragging.current = false;
        setPreview(null);
      }}
      onKeyDown={(e) => {
        const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : e.key === "PageUp" ? 10 : e.key === "PageDown" ? -10 : 0;
        let next: number | null = null;
        if (step !== 0) next = Math.max(0, Math.min(count - 1, p.index + step));
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = count - 1;
        if (next === null) return;
        e.preventDefault();
        e.stopPropagation();
        commit(next);
      }}
    >
      <div class="cx-frond-bar" aria-hidden="true">
        {bins.map((b) => (
          <span class={`cx-frond-tick is-${b.speaker}`} />
        ))}
        <span class="cx-frond-current" style={{ left: `${pct(shown)}%` }} />
      </div>
      {p.partStarts && p.partStarts.length > 0 ? (
        <div class="cx-frond-parts" aria-hidden="true">
          {p.partStarts.map((i) => (
            <span class="cx-frond-part" style={{ left: `${pct(i)}%` }} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
