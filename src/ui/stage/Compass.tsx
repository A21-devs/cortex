/**
 * Compass (CORTEX-UX §5.7, §6.7; ORIG-16; P1): a glass card (stage-local left 16, bottom 16; 140 × 150) with a ring
 * of the brain's territories seen from above: outer radius 48, inner 37 in a 104 px ring, one segment per coloured
 * area in slot order clockwise from 12 o'clock, 1.6° gaps, segment angle ∝ notes^0.6, exactly the wedges placement
 * returns (stage:territories) or, before they arrive, the same rule over the index counts. Centre: notes in scope
 * (mono 13/600) over "notes". A white heading needle on the rim points at the territory facing the camera
 * (stage:camera). It is THE scope gesture: clicking a segment scopes to that area (the figure turns that wedge
 * toward the viewer, the needle swings with it; the segment extends 3 px, others drop to 28%); clicking the centre
 * or the scoped segment returns to All areas. Dragging around the ring turns the camera without changing scope
 * (P1, stage:turn). Under the ring: the scope name and a chevron (the scope menu). In Groups and Chart the needle
 * hides and the ring dims to 50%. role="radiogroup"; segments role="radio"; arrows move, Enter scopes. L: card
 * 124 (ring 92); M: 88 without caption; hidden at S and below 520 px of height. Owner: E11.
 */
import type { JSX } from "preact";
import { useRef } from "preact/hooks";
import { featureOn } from "../../shared/features";
import { bucketCss } from "../../shared/palette";
import type { PaletteId } from "../../shared/settings";
import type { Territory } from "../../shared/protocol/worker";
import { spaceName } from "../../shared/spaces";
import type { SpaceId } from "../../shared/types";
import { setScope } from "../../state/actions";
import { compassSpec, SHELL } from "../breakpoints";
import { indexCounts, num, stageBus, useLeaf, useServices, useShell, type IndexCounts } from "../context";
import { t } from "../copy";
import { shownShape } from "../keymap";
import { Icon } from "../primitives/buttons";
import { openScopeMenu } from "../header/ScopePicker";
import { requestHint } from "./Hints";

const TAU = Math.PI * 2;

/** Arc path for a ring segment (angles in radians, 0 = 12 o'clock, clockwise). */
export function ringSegmentPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => `${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

export interface CompassSegment {
  space: SpaceId | "other";
  /** Clockwise from 12 o'clock, radians, gaps already taken out. */
  a0: number;
  a1: number;
  notes: number;
  entries: number;
  slot: number;
  bucket: "value" | "other" | "none";
}

/**
 * Segments from the index counts: coloured areas in slot order, then one Other segment for areas beyond the
 * palette, then No area; each sized ∝ notes^γ (γ = 0.6, as placement) around the full circle with 1.6° gaps.
 */
export function compassSegments(counts: IndexCounts | null, slots: Readonly<Record<string, number>> | undefined, gamma = 0.6, gapDeg: number = SHELL.geometry.ring.gapDeg): CompassSegment[] {
  if (!counts) return [];
  const coloured: { space: SpaceId | "other"; notes: number; entries: number; slot: number; bucket: CompassSegment["bucket"] }[] = [];
  let otherNotes = 0;
  let otherEntries = 0;
  for (const [space, notes] of Object.entries(counts.notesBySpace)) {
    if (space === "none" || notes <= 0) continue;
    const slot = slots?.[space] ?? 0;
    const entries = counts.recordBySpace[space] ?? 0;
    if (slot > 0) coloured.push({ space: space as SpaceId, notes, entries, slot, bucket: "value" });
    else {
      otherNotes += notes;
      otherEntries += entries;
    }
  }
  coloured.sort((a, b) => a.slot - b.slot);
  if (otherNotes > 0) coloured.push({ space: "other", notes: otherNotes, entries: otherEntries, slot: 0, bucket: "other" });
  const none = counts.notesBySpace.none ?? 0;
  if (none > 0) coloured.push({ space: "none", notes: none, entries: counts.recordBySpace.none ?? 0, slot: 0, bucket: "none" });
  if (coloured.length === 0) return [];
  const weights = coloured.map((c) => Math.pow(c.notes, gamma));
  const sum = weights.reduce((a, b) => a + b, 0);
  const gap = coloured.length > 1 ? (gapDeg * Math.PI) / 180 : 0;
  const free = TAU - gap * coloured.length;
  let a = 0;
  return coloured.map((c, i) => {
    const span = (free * (weights[i] ?? 0)) / sum;
    const seg: CompassSegment = { ...c, a0: a + gap / 2, a1: a + gap / 2 + span };
    a += span + gap;
    return seg;
  });
}

/** Segments from the territories placement returned (their azimuth spans, in their order). */
export function territorySegments(territories: readonly Territory[], counts: IndexCounts | null, slots: Readonly<Record<string, number>> | undefined, gapDeg: number = SHELL.geometry.ring.gapDeg): CompassSegment[] {
  const gap = territories.length > 1 ? (gapDeg * Math.PI) / 180 : 0;
  const norm = (x: number) => ((x % TAU) + TAU) % TAU;
  return territories.map((tr) => {
    const slot = tr.space === "none" ? 0 : (slots?.[tr.space] ?? 0);
    const a0 = norm(tr.phi0);
    let a1 = norm(tr.phi1);
    if (a1 <= a0) a1 += TAU;
    return {
      space: tr.space,
      a0: a0 + gap / 2,
      a1: Math.max(a0 + gap / 2 + 0.001, a1 - gap / 2),
      notes: tr.notes,
      entries: counts?.recordBySpace[tr.space] ?? 0,
      slot,
      bucket: tr.space === "none" ? "none" : slot > 0 ? "value" : "other",
    };
  });
}

/** Angle (clockwise from 12 o'clock, degrees) of a pointer position around the ring centre. */
export function pointerAngle(x: number, y: number, cx: number, cy: number): number {
  const a = (Math.atan2(x - cx, cy - y) * 180) / Math.PI;
  return (a + 360) % 360;
}

function segColour(seg: CompassSegment, palette: PaletteId): string {
  return bucketCss(seg.bucket, seg.slot, palette, "glow");
}

export function Compass(): JSX.Element | null {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; moved: boolean } | null>(null);
  const store = leaf.store;
  const ui = store.slices.ui.value;
  const view = store.slices.view.value;
  const feed = shell.feed.value;
  const settings = s.settings.value;
  if (!featureOn("compass")) return null;
  const counts = indexCounts(s);
  let slots: Readonly<Record<string, number>> | undefined;
  try {
    slots = s.colours.current().space;
  } catch {
    slots = undefined;
  }
  const segs = feed.territories && feed.territories.length > 0 ? territorySegments(feed.territories, counts, slots) : compassSegments(counts, slots);
  const spec = compassSpec(ui.breakpoint);
  const g = SHELL.geometry.ring;
  const c = g.viewBox / 2;
  const scope = ui.scope;
  const body = shownShape(view.shape, view.morph) === "body";
  const palette = settings.appearance.palette;
  const inScope = !counts ? 0 : scope === "all" ? counts.notes : (counts.notesBySpace[scope] ?? 0);
  const allNone = counts !== null && counts.notes > 0 && (counts.notesBySpace.none ?? 0) === counts.notes;
  const empty = !counts || counts.notes === 0;
  const pick = (seg: CompassSegment) => {
    if (seg.space === "other") return;
    setScope(store, scope === seg.space ? "all" : seg.space);
  };
  const preview = (seg: CompassSegment | null) => store.update("ui", { preview: seg && seg.space !== "other" ? { kind: "area", key: seg.space } : null });
  const caption = empty ? t("compass.empty") : allNone ? t("compass.allNoArea") : scope === "all" ? t("header.allAreas") : spaceName(scope);
  const needle = body && feed.needleDeg !== null ? feed.needleDeg : null;
  const bus = stageBus(s.bus);
  const onPointerDown = (e: PointerEvent) => {
    if (!featureOn("compassDrag") || e.button !== 0 || !body) return;
    const target = e.target as Element | null;
    if (!target?.closest?.(".cx-compass-seg")) return;
    drag.current = { id: e.pointerId, moved: false };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    const svg = ref.current?.querySelector("svg");
    if (!d || d.id !== e.pointerId || !svg) return;
    const r = svg.getBoundingClientRect();
    const deg = pointerAngle(e.clientX - r.left, e.clientY - r.top, r.width / 2, r.height / 2);
    if (!d.moved) {
      d.moved = true;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    }
    bus.emit("stage:turn", { viewId: leaf.viewId, needleDeg: deg });
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    if (d && d.id === e.pointerId && d.moved) e.preventDefault();
    drag.current = d && d.moved ? { id: -1, moved: true } : null;
  };
  return (
    <div
      ref={ref}
      class={`cx-compass cx-glass${spec.caption ? "" : " is-small"}${body ? "" : " is-dim"}`}
      style={{ width: `${spec.card}px` }}
      data-cx-overlay="compass"
      onPointerEnter={() => {
        if (ref.current) requestHint(s, shell, "compass", ref.current, "above");
      }}
    >
      <div class="cx-compass-ring" role="radiogroup" aria-label={t("compass.label")} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <svg viewBox={`0 0 ${g.viewBox} ${g.viewBox}`} width={spec.ring} height={spec.ring} aria-hidden="true">
          {segs.length === 0 ? <circle cx={c} cy={c} r={(g.outer + g.inner) / 2} fill="none" stroke-width={g.outer - g.inner} class="cx-compass-empty" style={allNone ? { stroke: bucketCss("none", 0, palette, "glow") } : undefined} /> : null}
          {segs.map((seg) => {
            const scoped = scope === seg.space;
            const lift = scoped ? g.scopedLift : 0;
            return (
              <path
                key={seg.space}
                class={`cx-compass-seg${scoped ? " is-scoped" : ""}${scope !== "all" && !scoped ? " is-muted" : ""}`}
                d={ringSegmentPath(c, c, g.inner, g.outer + lift, seg.a0, seg.a1)}
                fill={segColour(seg, palette)}
              />
            );
          })}
          {needle !== null ? (
            <g class="cx-compass-needle" transform={`rotate(${needle.toFixed(1)} ${c} ${c})`}>
              <path d={`M ${c} ${c - g.outer - 3} L ${c - 3.2} ${c - g.outer - 8.5} L ${c + 3.2} ${c - g.outer - 8.5} Z`} />
            </g>
          ) : null}
        </svg>
        {segs.map((seg, i) => {
          const mid = (seg.a0 + seg.a1) / 2;
          const r = ((g.outer + g.inner) / 2 / g.viewBox) * spec.ring;
          const x = spec.ring / 2 + r * Math.sin(mid);
          const y = spec.ring / 2 - r * Math.cos(mid);
          const name = seg.space === "other" ? t("key.other") : spaceName(seg.space);
          const tip = t("compass.tip", { area: name, notes: num(seg.notes), entries: num(seg.entries) });
          return (
            <button
              key={seg.space}
              type="button"
              role="radio"
              class="cx-compass-hit"
              aria-checked={scope === seg.space}
              aria-label={tip}
              title={tip}
              disabled={seg.space === "other"}
              tabIndex={scope === seg.space || (scope === "all" && i === 0) ? 0 : -1}
              style={{ left: `${x}px`, top: `${y}px` }}
              onClick={() => {
                if (drag.current?.moved) {
                  drag.current = null;
                  return;
                }
                pick(seg);
              }}
              onPointerEnter={() => preview(seg)}
              onPointerLeave={() => preview(null)}
              onFocus={() => preview(seg)}
              onBlur={() => preview(null)}
              onKeyDown={(e) => {
                const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                if (dir !== 0) {
                  e.preventDefault();
                  const list = Array.from(ref.current?.querySelectorAll<HTMLElement>(".cx-compass-hit:not([disabled])") ?? []);
                  const k = list.indexOf(e.currentTarget as HTMLElement);
                  list[(k + dir + list.length) % list.length]?.focus();
                } else if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pick(seg);
                }
              }}
            />
          );
        })}
        <button type="button" class="cx-compass-centre" aria-label={`${t("header.allAreas")}: ${num(inScope)} ${t("compass.notes")}`} title={allNone ? t("compass.allNoAreaTip") : undefined} onClick={() => setScope(store, "all")}>
          <span class="cx-compass-count">{counts ? num(inScope) : t("app.loading")}</span>
          <span class="cx-compass-unit">{t("compass.notes")}</span>
        </button>
      </div>
      {spec.caption ? (
        <button type="button" class="cx-compass-caption" aria-haspopup="menu" title={allNone ? t("compass.allNoAreaTip") : undefined} onClick={(e) => openScopeMenu(e.currentTarget as HTMLElement, store, slots, counts, s.settings.value.userSpaces ?? [])}>
          <span>{caption}</span>
          <Icon name="chevron" class="cx-select-caret-icon" />
        </button>
      ) : null}
    </div>
  );
}
