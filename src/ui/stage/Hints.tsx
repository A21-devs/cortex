/**
 * One-time hints (CORTEX-UX §5.2, §5.28, §3.5, §4.9; ORIG-09): the first time each surface is used, a 250 px hint
 * bubble appears next to it once and never again: stage (first hover after the first import), time strip (a hover
 * of 600 ms), shape bar (first drag of the slider), compass (first hover), command line (first focus),
 * conversation reader (first open). Per device (ui/deviceState.ts), never stacked (the newest wins), dismissed by
 * "Got it", Esc or the next action; "Cortex: Reset hints" brings them back. role="note", announced once through
 * the live region. Hints ship in P1 (features.hints). The walkthrough is ui/walkthrough. Owner: E11.
 */
import type { JSX } from "preact";
import { useContext, useEffect, useRef } from "preact/hooks";
import { signal, type ReadonlySignal } from "@preact/signals";
import type { CortexServices } from "../../plugin/services";
import { isLabelBased, RICHNESS_TARGET, type DimId } from "../../shared/dims";
import { featureOn } from "../../shared/features";
import { openAddSources } from "../header/Header";
import { runCortexCommand } from "../header/MoreMenu";
import { SHELL } from "../breakpoints";
import { LeafContext, useLeaf, useServices, useShell, type ActiveHint, type Shell } from "../context";
import { t } from "../copy";
import type { SpineOrder } from "../../state/types";
import { markHintSeen, type HintId } from "../deviceState";

export const HINT_KEYS = {
  stage: "hints.stage",
  strip: "hints.strip",
  shape: "hints.shape",
  compass: "hints.compass",
  command: "hints.command",
  conversation: "hints.conversation",
} as const satisfies Record<HintId, `hints.${string}`>;

/** The hint to show for a surface event, or null once it has been seen. */
export function nextHint(seen: readonly HintId[], surface: HintId): HintId | null {
  return seen.includes(surface) ? null : surface;
}

/** The hint's text; the stage hint names the end of the spine that sits by the brain (the Spine order setting). */
export function hintText(id: HintId, spineOrder: SpineOrder = "oldest-at-brain"): string {
  if (id === "stage" && spineOrder === "newest-at-brain") return t("hints.stageNewest");
  return t(HINT_KEYS[id]);
}

type Side = ActiveHint["side"];

/** Where a hint points, in view-local px, from an element's rectangle and the side the bubble sits on. */
export function hintAnchor(rect: { left: number; top: number; right: number; bottom: number; width: number }, root: { left: number; top: number }, side: Side): { x: number; y: number } {
  const cx = rect.left - root.left + Math.min(rect.width / 2, 40);
  if (side === "below") return { x: cx, y: rect.bottom - root.top };
  if (side === "left") return { x: rect.left - root.left, y: rect.top - root.top + 24 };
  return { x: cx, y: rect.top - root.top };
}

/**
 * Show a surface's hint if it has never been shown on this device (and hints have shipped). The newest hint
 * replaces any other. Returns true when it showed.
 */
export function requestHint(s: CortexServices, shell: Shell, id: HintId, anchor: HTMLElement | { x: number; y: number }, side: Side = "above"): boolean {
  if (!featureOn("hints")) return false;
  if (nextHint(s.device.value.hintsSeen, id) === null) return false;
  let pos: { x: number; y: number };
  if ("getBoundingClientRect" in anchor) {
    const rootRect = shell.root?.getBoundingClientRect() ?? { left: 0, top: 0 };
    pos = hintAnchor(anchor.getBoundingClientRect(), rootRect, side);
  } else pos = anchor;
  shell.hint.value = { id, x: pos.x, y: pos.y, side };
  s.device.update((d) => markHintSeen(d, id));
  shell.announce(hintText(id));
  return true;
}

/** Bubble geometry: 250 px wide, its 12 px pointer 34 px from the left edge, 10 px from the surface. */
export function bubbleStyle(h: Pick<ActiveHint, "x" | "y" | "side">, view: { width: number; height: number }): { left: number; top?: number; bottom?: number } {
  const w = SHELL.geometry.hint.w;
  const gap = SHELL.geometry.hint.gap;
  if (h.side === "left") return { left: Math.max(8, h.x - w - gap), top: Math.max(8, h.y - 24) };
  const left = Math.max(8, Math.min(view.width - w - 8, h.x - 34));
  return h.side === "below" ? { left, top: h.y + gap } : { left, bottom: Math.max(8, view.height - h.y + gap) };
}

/** The active hint of this leaf (one at a time), positioned in the view. */
export function HintLayer(): JSX.Element | null {
  const shell = useShell();
  const leaf = useContext(LeafContext);
  const h = shell.hint.value;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!h) return undefined;
    const doc = shell.doc;
    if (!doc) return undefined;
    // The next action dismisses: any press outside the bubble after it appeared.
    const onDown = (e: Event) => {
      const target = e.target as Node | null;
      if (ref.current && target && ref.current.contains(target)) return;
      shell.hint.value = null;
    };
    const h1 = shell.win.setTimeout(() => doc.addEventListener("pointerdown", onDown, true), 0);
    return () => {
      shell.win.clearTimeout(h1);
      doc.removeEventListener("pointerdown", onDown, true);
    };
  }, [h]);
  if (!h) return null;
  const style = bubbleStyle(h, shell.size.value);
  return (
    <div
      ref={ref}
      class={`cx-hint is-${h.side}`}
      role="note"
      style={{ left: `${style.left}px`, top: style.top === undefined ? undefined : `${style.top}px`, bottom: style.bottom === undefined ? undefined : `${style.bottom}px` }}
      onKeyDown={(e) => {
        if (e.key === "Escape") shell.hint.value = null;
      }}
    >
      <p>{hintText(h.id, leaf?.store.slices.view.value.spineOrder)}</p>
      <button type="button" class="cx-text-button" onClick={() => (shell.hint.value = null)}>
        {t("hints.gotIt")}
      </button>
    </div>
  );
}

/** A surface's hint rendered in place (used where a surface hosts its own bubble). */
export function Hint(p: { id: HintId; anchor?: DOMRect }): JSX.Element | null {
  const s = useServices();
  if (!featureOn("hints") || s.device.value.hintsSeen.includes(p.id)) return null;
  return (
    <div class="cx-hint is-inline" role="note" style={p.anchor ? { left: `${p.anchor.left}px`, top: `${p.anchor.bottom + SHELL.geometry.hint.gap}px` } : undefined}>
      <p>{hintText(p.id)}</p>
      <button type="button" class="cx-text-button" onClick={() => s.device.update((d) => markHintSeen(d, p.id))}>
        {t("hints.gotIt")}
      </button>
    </div>
  );
}

// ───────────────────────────── richness hint ─────────────────────────────

/** Whether the richness note is on show. */
export const richnessShowing = signal(false);

export interface RichnessInput {
  shape: string;
  morph: number;
  groupBy: DimId;
  /** The record entries' own dimension while they are grouped apart, else null. */
  recordDim: DimId | null;
  /** The smallest value group of the grouping, from the arrangement (before Fold); null or absent when it has no value groups. */
  thinnest: number | null | undefined;
  /** Target entries a value (RICHNESS_TARGET). */
  target?: number;
}

/**
 * The thinnest value size to name, or null when the note stays away: not the Groups shape (a chart card, the body),
 * a grouping that is not by a label field (a date, folder or area groups read fine thin), or every value already
 * reaches the target. It has no dismiss: it goes when the grouping changes.
 */
export function richnessHint(i: RichnessInput): number | null {
  if (i.shape !== "groups" || i.morph <= 0.5) return null;
  if (!isLabelBased(i.groupBy) && !(i.recordDim !== null && isLabelBased(i.recordDim))) return null;
  if (i.thinnest === null || i.thinnest === undefined) return null;
  if (i.thinnest >= (i.target ?? RICHNESS_TARGET)) return null;
  return i.thinnest;
}

/**
 * The coverage note at the stage's top middle under a label grouping: two borderless, centred lines, what a value needs to
 * read well and where the smallest stands, then two text links (more sources, the sample).
 */
export function RichnessHint(p: { thinnest: ReadonlySignal<number | null> }): JSX.Element | null {
  const s = useServices();
  const leaf = useLeaf();
  const v = leaf.store.slices.view.value;
  const recordDim = v.splitGroups && v.layers.record ? (v.groupByRecord ?? v.groupBy) : null;
  const m = richnessHint({ shape: v.shape, morph: v.morph, groupBy: v.groupBy, recordDim, thinnest: p.thinnest.value });
  useEffect(() => {
    richnessShowing.value = m !== null;
    return () => {
      richnessShowing.value = false;
    };
  }, [m !== null]);
  if (m === null) return null;
  return (
    <div class="cx-richness" role="status" data-cx-overlay="richness">
      <p class="cx-richness-text">{t("overlays.richness", { n: RICHNESS_TARGET, m })}</p>
      <p class="cx-richness-links">
        <button type="button" class="cx-text-button" onClick={() => void openAddSources(s)}>
          {t("overlays.richnessAdd")}
        </button>
        <span class="cx-richness-dot" aria-hidden="true">
          {"·"}
        </span>
        <button type="button" class="cx-text-button" onClick={() => runCortexCommand(s.app, "toggle-sample")}>
          {t("overlays.richnessSample")}
        </button>
      </p>
    </div>
  );
}
