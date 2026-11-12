/**
 * Time › Charts header: period chips (From first busy year · All · 5 years · 1 year · 6 months · 30 days), the busy-year
 * stepper ("Starts at the first year with [50] or more entries"), a small two-handle brush and its date caption.
 * All of it reads and writes the leaf's `ui.period`, the same one the strip's brush and every chart share, so a
 * change anywhere shows everywhere. The brush's bars come from the strip statistics of the whole record (never
 * narrowed by the period); a drag shows a draft window and sets the period on release.
 */
import type { JSX } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import type { TimeBin } from "../../shared/protocol/worker";
import { setPeriod } from "../../state/actions";
import { visibilityParams } from "../../state/selectors";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import { setPageParams, statsKey, useLoad } from "./PageFrame";
import { useIndex } from "../reader/readerKit";
import { dayText } from "./whenModel";
import {
  PRESETS,
  activePreset,
  brushBars,
  busyParam,
  dragWindow,
  endOfDay,
  firstBusyYear,
  normalisePeriod,
  presetPeriod,
  startOfDay,
  stepBusy,
  windowFractions,
  type BrushHandle,
  type PeriodPreset,
} from "./timePeriod";

const DAY_MS = 86_400_000;
const BAR_COUNT = 120;

interface Span {
  first: number;
  last: number;
  bins: TimeBin[];
}

const chipLabel = (p: PeriodPreset, year: number | null): string =>
  p === "from" ? t("when.chipFrom", { year: year ?? "" }) : p === "all" ? t("when.chipAll") : p === "years5" ? t("when.chipYears5") : p === "year1" ? t("when.chipYear1") : p === "months6" ? t("when.chipMonths6") : t("when.chipDays30");

export function PeriodBar(p: { params: Readonly<Record<string, string>> }): JSX.Element | null {
  const s = useServices();
  const leaf = useLeaf();
  const index = useIndex(s);
  const ui = leaf.store.slices.ui.value;
  const view = leaf.store.slices.view.value;
  const busy = busyParam(p.params.busy);
  const [draft, setDraft] = useState<[number, number] | null>(null);
  const [chosen, setChosen] = useState<PeriodPreset | null>(null);
  const track = useRef<HTMLDivElement | null>(null);
  const vis = visibilityParams(ui, view);

  const span = useLoad<Span | null>(
    async (signal) => {
      if (!index || index.count === 0) return null;
      const r = await s.worker.call(statsKey(leaf.viewId, "periodBar"), "stats", { kind: "strip", bin: "auto", notesLane: true, ageColour: false, visibility: { ...vis, period: null } }, { signal });
      if (r.kind !== "strip" || !Number.isFinite(r.first) || !Number.isFinite(r.last)) return null;
      return { first: r.first, last: r.last, bins: r.bins };
    },
    [index, ui.scope, ui.revealedCount, JSON.stringify({ ...vis, period: null })],
  );
  const data = span.state === "ready" ? span.value : span.state === "loading" ? span.previous : undefined;
  const bars = useMemo(() => (data ? brushBars(data.bins, startOfDay(data.first), endOfDay(data.last), BAR_COUNT) : []), [data]);
  if (!data) return null;

  const lo = startOfDay(data.first);
  const hi = endOfDay(data.last);
  const fromYear = firstBusyYear(data.bins, busy);
  const active = activePreset(ui.period, data, fromYear, chosen);
  const win: [number, number] = draft ?? (ui.period ? [ui.period[0], ui.period[1]] : [lo, hi]);
  const [fa, fb] = windowFractions(win, lo, hi);
  const commit = (w: [number, number]) => setPeriod(leaf.store, normalisePeriod(w, data));
  const choose = (preset: PeriodPreset) => {
    setChosen(preset);
    setPeriod(leaf.store, presetPeriod(preset, data, fromYear));
  };
  const setBusy = (n: number) => {
    setPageParams(leaf.store, { busy: n === 50 ? null : String(n) });
    // "From" follows the threshold: the year it means may change.
    if (active === "from") setPeriod(leaf.store, presetPeriod("from", data, firstBusyYear(data.bins, n)));
  };

  const startDrag = (handle: BrushHandle) => (e: PointerEvent) => {
    const el = track.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = el.getBoundingClientRect();
    const per = (hi - lo) / Math.max(1, rect.width);
    const origin: [number, number] = [win[0], win[1]];
    const x0 = e.clientX;
    let last: [number, number] = origin;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      last = dragWindow(origin, handle, (ev.clientX - x0) * per, lo, hi);
      setDraft(last);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      setDraft(null);
      if (last !== origin) commit(last);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  /** Dragging on the bars away from the window draws a new one. */
  const startNew = (e: PointerEvent) => {
    const el = track.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const at = (x: number) => lo + Math.min(1, Math.max(0, (x - rect.left) / Math.max(1, rect.width))) * (hi - lo);
    const anchor = at(e.clientX);
    let last: [number, number] | null = null;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const b = at(ev.clientX);
      last = [Math.min(anchor, b), Math.max(anchor, b)];
      setDraft(last);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      setDraft(null);
      if (last && last[1] - last[0] >= DAY_MS) commit([startOfDay(last[0]), endOfDay(last[1])]);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };

  const keyHandle = (handle: "a" | "b") => (e: KeyboardEvent) => {
    const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (dir === 0) return;
    e.preventDefault();
    commit(dragWindow(win, handle, dir * (e.shiftKey ? 30 : 7) * DAY_MS, lo, hi));
  };

  return (
    <div class="cx-pb" role="group" aria-label={t("when.periodLabel")}>
      <div class="cx-pb-chips" role="group" aria-label={t("when.periodLabel")}>
        {PRESETS.filter((x) => x !== "from" || fromYear !== null).map((x) => (
          <button type="button" class={`cx-pb-chip${active === x ? " is-on" : ""}`} aria-pressed={active === x} onClick={() => choose(x)}>
            {chipLabel(x, fromYear)}
          </button>
        ))}
      </div>
      <div class="cx-pb-step">
        <span>{t("when.startsAt")}</span>
        <button type="button" class="cx-pb-stepbtn" aria-label={t("when.fewer")} disabled={busy <= 1} onClick={() => setBusy(stepBusy(busy, -1))}>
          −
        </button>
        <input
          class="cx-pb-num cx-mono"
          type="number"
          min={1}
          value={busy}
          aria-label={t("when.startsAt") + " " + t("when.startsAtEnd")}
          onChange={(e) => setBusy(busyParam((e.currentTarget as HTMLInputElement).value))}
        />
        <button type="button" class="cx-pb-stepbtn" aria-label={t("when.more")} onClick={() => setBusy(stepBusy(busy, 1))}>
          +
        </button>
        <span>{t("when.startsAtEnd")}</span>
      </div>
      <div class="cx-pb-brush" ref={track} onPointerDown={startNew}>
        <svg class="cx-pb-bars" viewBox={`0 0 ${BAR_COUNT} 20`} preserveAspectRatio="none" aria-hidden="true">
          {bars.map((h, i) => (h > 0 ? <rect x={i} y={20 - Math.max(1.5, h * 20)} width={0.8} height={Math.max(1.5, h * 20)} /> : null))}
        </svg>
        <div class="cx-pb-win" style={{ left: `${fa * 100}%`, width: `${Math.max(0, fb - fa) * 100}%` }} onPointerDown={startDrag("w")}>
          <span
            class="cx-pb-handle is-a"
            role="slider"
            tabIndex={0}
            aria-label={t("time.brushStart")}
            aria-valuemin={lo}
            aria-valuemax={win[1]}
            aria-valuenow={win[0]}
            aria-valuetext={dayText(win[0])}
            onPointerDown={startDrag("a")}
            onKeyDown={keyHandle("a")}
          />
          <span
            class="cx-pb-handle is-b"
            role="slider"
            tabIndex={0}
            aria-label={t("time.brushEnd")}
            aria-valuemin={win[0]}
            aria-valuemax={hi}
            aria-valuenow={win[1]}
            aria-valuetext={dayText(win[1])}
            onPointerDown={startDrag("b")}
            onKeyDown={keyHandle("b")}
          />
        </div>
      </div>
      <p class="cx-pb-caption cx-mono">{t("when.rangeTo", { from: dayText(win[0]), to: dayText(win[1]) })}</p>
    </div>
  );
}
