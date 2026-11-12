/**
 * Chart overlay (CORTEX-UX §7.1): axes, rules, labels and outlines drawn from the worker's OverlayModel after the
 * particles settle (fade out 100 ms / in 250 ms around form changes); hover marks → tooltip; click a mark or a
 * band label → a token in the command line; a map open in the reader rings its sources in place with a count chip
 * (the worker draws the rings and the chip; no floating halo); highlights are command-line tokens, not
 * leader-lined pills (ORIG-07). Owner: E9.
 *
 * This file also holds the chart feed every chart surface shares (overlay, readings, Chart page, Copy data as CSV):
 * one arrangement per leaf and spec, asked from the worker under its own latest-wins key so the renderer's call is
 * never superseded (docs/rfcs/E9.md §1 asks for a `stage:chart` event that would make this second call
 * unnecessary), and the frame loop that reads the renderer's camera (E10) at up to 30 Hz.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { computed, effect, signal, type ReadonlySignal } from "@preact/signals";
import type { CortexServices, LeafServices } from "../../plugin/services";
import type { DataIndex } from "../../shared/index-format";
import { AXIS_FALLBACK_ORDER, builtinDim, isLabelDim, noneNameOf, parseDateDim, type DimId } from "../../shared/dims";
import { withTreemapRoot } from "../../shared/chartOptions";
import { featureOn } from "../../shared/features";
import type { ArrangementResult, ChartSpec, LegendModel, OverlayModel, QueryToken, StatsResult, Vec3 } from "../../shared/protocol/worker";
import { CortexError } from "../../shared/errors";
import { project, projectOverlay, type ScreenLabel } from "../../render/overlay";
import { countScale, giveWayOpacity, memberLabelText, pickZoomCells } from "../../shared/chartZoom";
import { visibilityParams } from "../../state/selectors";
import { addToken, removeToken, soloGroup, toggleGroup } from "../../state/actions";
import type { CortexStore } from "../../state/store";
import { rgbCss } from "../../shared/palette";
import { chartStageOf, type ChartStage } from "../../shared/chartStage";
import { isReducedMotion, pendingCopy, stageBus, useLeaf, useServices, useShell, type Shell, type StageEvents } from "../context";
import { t, type CopyKey } from "../copy";
import { areaLabel, dimLabel, fmtDayRange, hubTypeLabel, kindLabel, noteOrRecordLabel, sourceLabel, valueLabel } from "../valueLabels";
import { copyToClipboard } from "../pages/PageFrame";
import { showMenu, type MenuItemSpec } from "../primitives/menu";
import { ChartComets } from "./ChartComets";
import { BLINK_STEP_MS, blinkApplies, blinkSteps } from "./labelBlink";

// ───────────────────────────── refs, names and tokens ─────────────────────────────

/**
 * What an overlay label, a mark or a reading refers to: the JSON the worker puts in `OverlayItem.key`, mark keys and
 * `ChartReading.values.ref` (worker/charts/common.ts `ChartRef`; tests/charts.test.tsx keeps the two in step).
 */
export interface ChartRef {
  x?: [DimId, string];
  y?: [DimId, string];
  or?: [DimId, string][];
  t?: [number, number];
  zoom?: number;
  zoomMax?: number;
  cell?: number;
  copy?: string;
  span?: [number, number];
  fold?: string;
  /** Treemap drill-in: the folder path this label or box zooms into ("" = the whole tree). */
  drill?: string;
  /** Lifeline lane: [months from first to last entry, 1 while it is still active]. */
  life?: [number, number];
  /** Months of the longest gap before a row's topic came back. */
  back?: number;
  /** Lifelines Curve slice: [percent of lives that last at least this long, that length in days]. */
  curve?: [number, number];
}

/** The worker's "no value" and "Other" category keys. */
export const NONE_VALUE = "";
export const OTHER_VALUE = "__other__";
const LABEL_MAX = 24;

function isPair(v: unknown): v is [DimId, string] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string";
}

function isRange(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number" && Number.isFinite(v[0]) && Number.isFinite(v[1]);
}

/** Parse a ref key; anything that is not a ref object (or malformed fields) is dropped, never thrown. */
export function parseRef(json: string | number | undefined | null): ChartRef | null {
  if (typeof json !== "string" || json === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const ref: ChartRef = {};
  if (isPair(o.x)) ref.x = o.x;
  if (isPair(o.y)) ref.y = o.y;
  if (Array.isArray(o.or)) ref.or = o.or.filter(isPair);
  if (isRange(o.t)) ref.t = o.t;
  if (typeof o.zoom === "number") ref.zoom = o.zoom;
  if (typeof o.zoomMax === "number") ref.zoomMax = o.zoomMax;
  if (typeof o.cell === "number") ref.cell = o.cell;
  if (typeof o.copy === "string") ref.copy = o.copy;
  if (isRange(o.span)) ref.span = o.span;
  if (typeof o.fold === "string") ref.fold = o.fold;
  if (typeof o.drill === "string") ref.drill = o.drill;
  if (isRange(o.life)) ref.life = o.life;
  if (typeof o.back === "number" && Number.isFinite(o.back)) ref.back = o.back;
  if (isRange(o.curve)) ref.curve = o.curve;
  return ref;
}

export function truncateLabel(s: string, max = LABEL_MAX): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Display name of a category value: the remainder names (No area, Undated …), areas, sources, speakers and kinds go
 * through the same label tables as the rest of Cortex; anything else keeps the worker's text.
 */
export function categoryName(dim: DimId, value: string, fallback: string, names?: CategoryNames): string {
  const given = names?.[`${dim}=${value}`];
  if (given !== undefined) return given;
  if (value === OTHER_VALUE) return t("dims.other");
  if (value === NONE_VALUE) {
    const none = noneNameOf(dim);
    return none ? t(`dims.${none}` as CopyKey) : fallback;
  }
  switch (dim) {
    case "space":
      return areaLabel(value);
    case "source":
      return sourceLabel(value);
    case "speaker":
      return valueLabel(value);
    case "kind":
      return kindLabel(value);
    case "hubType":
      return hubTypeLabel(value);
    case "layer2":
      return noteOrRecordLabel(value);
    case "filing":
      return value === "filed" ? t("dims.filed") : value === "unfiled" ? t("dims.unfiled") : fallback;
    case "recency": {
      const word = valueLabel(value);
      return word.charAt(0).toUpperCase() + word.slice(1);
    }
    case "hubStatus": {
      const word = valueLabel(value);
      return word.charAt(0).toUpperCase() + word.slice(1);
    }
    default:
      return fallback;
  }
}

/** Names the person gave combined categories, keyed "‹dim›=‹value›" (the chart option `rename:‹dim›=‹value›`). */
export type CategoryNames = Readonly<Record<string, string>>;

const RENAME_PREFIX = "rename:";
export const MAX_COMBINED_NAME = 60;

/** The combined-category names stored in a chart's options. */
export function renamesOf(options: ChartSpec["options"] | undefined): CategoryNames {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(options ?? {})) {
    if (!k.startsWith(RENAME_PREFIX) || typeof v !== "string") continue;
    const name = cleanName(v);
    if (name !== "") out[k.slice(RENAME_PREFIX.length)] = name;
  }
  return out;
}

function cleanName(raw: string): string {
  return raw.replace(/[\p{Cc}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_COMBINED_NAME);
}

/** Options with the combined category `first` of `dim` named `name`; a blank name (or the first value's own name) removes the rename. */
export function setCombinedName(options: ChartSpec["options"], dim: DimId, first: string, name: string, ownName: string): ChartSpec["options"] {
  const key = `${RENAME_PREFIX}${dim}=${first}`;
  const next = { ...options };
  const clean = cleanName(name);
  if (clean === "" || clean === ownName) delete next[key];
  else next[key] = clean;
  return next;
}

const RENAME_MENU_VALUE = "cortex:rename-combined";

/**
 * Edit a label's text in place: an input appears where the label is, Enter or leaving it saves, Esc cancels. The
 * label stays hidden meanwhile; `commit` receives the typed text (the caller decides what a blank name means).
 */
export function renameInline(el: HTMLElement, current: string, commit: (name: string) => void): void {
  const doc = el.ownerDocument;
  const host = el.parentElement;
  if (!host) return;
  const input = doc.createElement("input");
  input.type = "text";
  input.className = "cx-axis-rename";
  input.value = current;
  input.maxLength = MAX_COMBINED_NAME;
  input.setAttribute("aria-label", t("chart.renameCombinedLabel"));
  input.style.transform = el.style.transform;
  el.style.visibility = "hidden";
  let done = false;
  const finish = (save: boolean): void => {
    if (done) return;
    done = true;
    const typed = input.value;
    input.remove();
    el.style.visibility = "";
    if (save) commit(typed);
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  host.appendChild(input);
  input.focus();
  input.select();
}

/** True when `first` heads a combine on `dim` in this chart (only those can be renamed). */
export function isCombined(combined: ChartSpec["combined"], dim: DimId, first: string): boolean {
  return (combined[`${dim}=${first}`]?.length ?? 0) > 0 || (combined[first]?.length ?? 0) > 0;
}

/** The text drawn for an overlay label: a copy key when the worker named one, a resolved category, else its text. */
/** A lifeline's length and status: "ongoing, 7 months", "3 months", "ongoing, 2.5 years" (24 months or more reads in years). */
export function lifeText(life: readonly [number, number]): string {
  const ongoing = life[1] === 1;
  const months = Math.max(1, Math.round(life[0]));
  if (months >= 24) return t(ongoing ? "lifeline.ongoingYears" : "lifeline.endedYears", { n: String(Math.round((months / 12) * 10) / 10) });
  if (months === 1) return t(ongoing ? "lifeline.ongoingMonth" : "lifeline.endedMonth");
  return t(ongoing ? "lifeline.ongoingMonths" : "lifeline.endedMonths", { n: months });
}

/** A length of time in whole days as words: "12 days", "1 month", "7 months", "2.5 years" (24 months or more reads in years). */
export function spanText(days: number): string {
  const d = Math.max(0, Math.round(days));
  if (d < 30) return d === 1 ? t("lifeline.spanDay") : t("lifeline.spanDays", { n: d });
  const months = Math.max(1, Math.round(d / 30.44));
  if (months >= 24) return t("lifeline.spanYears", { n: String(Math.round((months / 12) * 10) / 10) });
  return months === 1 ? t("lifeline.spanMonth") : t("lifeline.spanMonths", { n: months });
}

/** A row's name is cut to this many characters before "- back after N months", which is long itself. */
export const BACK_NAME_MAX = 14;

/** How long a row was away: "back after 7 months", "back after 1 month", "back after 2.5 years" (24 months or more reads in years). */
export function backText(name: string, months: number): string {
  const m = Math.max(1, Math.round(months));
  if (m >= 24) return t("lifeline.backYears", { name, n: String(Math.round((m / 12) * 10) / 10) });
  if (m === 1) return t("lifeline.backMonth", { name });
  return t("lifeline.backMonths", { name, n: m });
}

export function overlayLabelText(text: string, ref: ChartRef | null, names?: CategoryNames): string {
  if (ref?.copy) return t(ref.copy as CopyKey, { n: text });
  if (ref?.curve) {
    // A Lifelines Curve slice: the series and the share of its lives that last at least this long.
    const pair = ref.x ?? ref.y;
    const name = pair ? truncateLabel(categoryName(pair[0], pair[1], text, names)) : text;
    return t("lifeline.curveTip", { name, pct: ref.curve[0], span: spanText(ref.curve[1]) });
  }
  if (ref?.back !== undefined && text !== "") {
    const pair = ref.x ?? ref.y;
    return backText(truncateLabel(pair ? categoryName(pair[0], pair[1], text, names) : text, BACK_NAME_MAX), ref.back);
  }
  if (ref?.life) {
    // A lane's second label line is the status alone; a lane's name or tooltip title gets it as a suffix.
    const status = lifeText(ref.life);
    const pair = ref.x ?? ref.y;
    if (!pair || text === "") return status;
    return `${truncateLabel(categoryName(pair[0], pair[1], text, names))} · ${status}`;
  }
  const single = ref && !ref.or && !ref.t && (ref.x ? !ref.y : ref.y) ? (ref.x ?? ref.y) : undefined;
  if (single && text !== "") return truncateLabel(categoryName(single[0], single[1], text, names));
  return text;
}

function categoryToken(kind: "group" | "band", pair: [DimId, string], name: string): QueryToken {
  return { id: `chart:${kind}:${pair[0]}:${pair[1]}`, kind, dim: pair[0], value: pair[1], label: `${dimLabel(pair[0])}: ${categoryName(pair[0], pair[1], name)}` };
}

/** Tokens a ref traces: x → group, y → band (AND with x), or → several groups (OR), t → a time range. */
export function refTokens(ref: ChartRef, name?: string): QueryToken[] {
  const out: QueryToken[] = [];
  const single = [ref.x, ref.y, ref.or?.length ? ref.or : undefined].filter(Boolean).length === 1 && !ref.or;
  const nm = (pair: [DimId, string]) => (single && name !== undefined ? name : pair[1]);
  if (ref.x) out.push(categoryToken("group", ref.x, nm(ref.x)));
  if (ref.y) out.push(categoryToken("band", ref.y, nm(ref.y)));
  for (const p of ref.or ?? []) out.push(categoryToken("group", p, p[1]));
  if (ref.t) out.push({ id: `chart:time:${ref.t[0]}-${ref.t[1]}`, kind: "time", range: ref.t, label: fmtDayRange(ref.t[0], Math.max(ref.t[0], ref.t[1] - 1)) });
  return out;
}

/** True when the ref names something to trace. */
export function refTraceable(ref: ChartRef | null): ref is ChartRef {
  return ref !== null && (ref.x !== undefined || ref.y !== undefined || (ref.or?.length ?? 0) > 0 || ref.t !== undefined);
}

// ───────────────────────────── label gestures ─────────────────────────────

/** The one dimension value a band or axis label stands for; null for a title, a combined label, a time range or a fold. */
export function labelPair(ref: ChartRef | null): [DimId, string] | null {
  if (!ref || ref.or || ref.t || ref.fold !== undefined) return null;
  if (ref.x && !ref.y) return ref.x;
  if (ref.y && !ref.x) return ref.y;
  return null;
}

/** The chart-highlight tokens a label's value can own (a series is a group token, a band a band token). */
export function highlightIdsOf(pair: readonly [DimId, string]): string[] {
  return [`chart:group:${pair[0]}:${pair[1]}`, `chart:band:${pair[0]}:${pair[1]}`];
}

const isHighlightToken = (k: QueryToken): boolean => k.kind === "group" || k.kind === "band";

/** Does a highlight token for this value exist? Any highlight at all dims every label that has none. */
export function labelHighlight(tokens: readonly QueryToken[], pair: readonly [DimId, string] | null): { highlighted: boolean; dimmed: boolean } {
  const any = tokens.some(isHighlightToken);
  if (!pair || !any) return { highlighted: false, dimmed: false };
  const highlighted = tokens.some((k) => isHighlightToken(k) && k.dim === pair[0] && k.value === pair[1]);
  return { highlighted, dimmed: !highlighted };
}

/** Text on a filled chip of this colour (rgb 0..1): near-black on light fills, white on dark ones (WCAG relative luminance). */
export function chipInk(rgb: readonly [number, number, number]): string {
  const lin = (v: number) => {
    const c = Math.max(0, Math.min(1, v));
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return lum > 0.35 ? "#0b0d12" : "#ffffff";
}

/** The group's colour: the chart's own colour key when it colours by this dimension, else the Key's row, else null. */
export function labelRgb(pair: readonly [DimId, string], colourDim: DimId | null, colourKey: ArrangementResult["colourKey"], legend: LegendModel | null): [number, number, number] | null {
  if (colourDim === pair[0]) {
    const hit = colourKey?.find((c) => c.key === pair[1]);
    if (hit) return hit.rgb;
  }
  for (const sec of legend?.sections ?? []) {
    if (String(sec.dim) !== pair[0]) continue;
    const row = sec.rows.find((r) => r.key === pair[1] && r.bucket === "value");
    if (row) return row.rgb;
  }
  return null;
}

/** The count a label stands for: the x-axis category when there is one, else the marks that carry the value. */
export function labelCount(result: Pick<ArrangementResult, "categories" | "overlay">, xDim: DimId, pair: readonly [DimId, string]): number {
  if (pair[0] === xDim) {
    const cat = result.categories?.find((c) => c.key === pair[1]);
    if (cat) return cat.count;
  }
  let n = 0;
  for (const m of result.overlay.marks) {
    const ref = parseRef(m.key);
    if ((ref?.x && ref.x[0] === pair[0] && ref.x[1] === pair[1]) || (ref?.y && ref.y[0] === pair[0] && ref.y[1] === pair[1])) n += m.count;
  }
  return n;
}

/** "Alt" everywhere but on a Mac, where the key is called Option. */
export function optionKeyName(platform: string): string {
  return /mac|iphone|ipad/i.test(platform) ? t("chart.keyOption") : t("chart.keyAlt");
}

export function labelTipText(name: string, count: number): string {
  return t("chart.labelTip", { name, n: count.toLocaleString("en-GB") });
}

export function labelHintText(platform: string): string {
  return t("chart.labelHint", { key: optionKeyName(platform) });
}

/** The hidden-group key of a value ("dim=value", the shape the Key writes). */
export const hiddenKey = (pair: readonly [DimId, string]): string => `${pair[0]}=${pair[1]}`;

/** Click on a band label: Alt/Option shows only that value (again restores all); otherwise it is added as a highlight. */
export function labelClick(store: CortexStore, ref: ChartRef, text: string, alt: boolean, siblings: readonly string[]): "solo" | "highlight" {
  const pair = labelPair(ref);
  if (alt && pair) {
    soloGroup(store, hiddenKey(pair), siblings.map((v) => hiddenKey([pair[0], v])));
    return "solo";
  }
  for (const tk of refTokens(ref, text)) addToken(store, tk);
  return "highlight";
}

/** Right-click on a band label: remove its highlight when it has one, otherwise hide the band (Shift opens Combine instead). */
export function labelContext(store: CortexStore, pair: readonly [DimId, string]): "unhighlight" | "hide" {
  const ids = highlightIdsOf(pair);
  if (store.get("ui").tokens.some((k) => ids.includes(k.id))) {
    for (const id of ids) removeToken(store, id);
    return "unhighlight";
  }
  toggleGroup(store, hiddenKey(pair));
  return "hide";
}

/** The date span a hovered chart cell stands for (end inclusive, the way tokens and the strip read it). */
export function hoverSpan(ref: ChartRef | null): [number, number] | null {
  return ref?.t ? [ref.t[0], Math.max(ref.t[0], ref.t[1] - 1)] : null;
}

// ───────────────────────────── zones ─────────────────────────────

/** The chart's three drop zones: Horizontal, Vertical (outward on round charts) and Colour. */
export type Zone = "x" | "y" | "colour";
export const ZONES: readonly Zone[] = ["x", "y", "colour"];
/** Drag type of a dimension chip (Chart page Fields, the key bar's pickers). */
export const DIM_MIME = "application/x-cortex-dim";

export function isKnownDim(v: unknown): v is DimId {
  return typeof v === "string" && v !== "" && (builtinDim(v as DimId) !== undefined || isLabelDim(v as DimId) || parseDateDim(v as DimId) !== null);
}

/** The next sensible dimension after `dim` (Area → Folder → Month …), never `avoid`. */
export function nextDim(dim: DimId, avoid: DimId): DimId {
  const order = AXIS_FALLBACK_ORDER;
  const start = order.indexOf(dim);
  for (let k = 1; k <= order.length; k++) {
    const d = order[(start + k + order.length) % order.length];
    if (d !== undefined && d !== avoid && d !== dim) return d;
  }
  return "space";
}

export interface ZoneChange {
  spec: ChartSpec;
  /** The other zone that had to move so one dimension never lands on both axes (the live region announces it). */
  moved?: { zone: Zone; dim: DimId };
}

/** Put `dim` on a zone. If it would sit on both axes the other axis takes the next sensible dimension. */
export function assignZone(spec: ChartSpec, zone: Zone, dim: DimId): ZoneChange {
  if (zone === "colour") return { spec: { ...spec, colour: dim } };
  const other: Zone = zone === "x" ? "y" : "x";
  const here = zone === "x" ? spec.x : (spec.y ?? { dim, sort: "count" as const });
  const placed = { dim, sort: here.sort };
  const otherAxis = other === "x" ? spec.x : spec.y;
  let next: ChartSpec = zone === "x" ? { ...spec, x: placed } : { ...spec, y: placed };
  if (!otherAxis || otherAxis.dim !== dim) return { spec: next };
  // The displaced axis keeps its old position in the order: it moves on from `dim`, not from nothing.
  const fb = nextDim(dim, dim);
  next = other === "x" ? { ...next, x: { ...otherAxis, dim: fb } } : { ...next, y: { ...otherAxis, dim: fb } };
  return { spec: next, moved: { zone: other, dim: fb } };
}

/** Swap Horizontal and Vertical (sorts travel with their axis). A one-axis chart has nothing to swap. */
export function swapAxes(spec: ChartSpec): ChartSpec {
  return spec.y ? { ...spec, x: spec.y, y: spec.x } : spec;
}

const SORT_CYCLE = ["date", "name", "count"] as const;
/** Date → Name → Count → Date. */
export function nextSort(sort: ChartSpec["x"]["sort"]): ChartSpec["x"]["sort"] {
  return SORT_CYCLE[(SORT_CYCLE.indexOf(sort) + 1) % SORT_CYCLE.length] ?? "count";
}

export function zoneName(zone: Zone): string {
  return t(zone === "x" ? "chart.horizontal" : zone === "y" ? "chart.vertical" : "chart.colour");
}

/** Apply a dimension to a zone of the leaf's chart and tell the live region when the other axis moved. */
export function dropOnZone(leaf: LeafServices, shell: Shell, zone: Zone, dim: DimId): void {
  const cur = leaf.store.get("view").chart;
  if (!cur) return;
  const change = assignZone(cur, zone, dim);
  leaf.store.update("view", (v) => ({ ...v, chart: change.spec }));
  if (change.moved) shell.notify(t("chart.zoneFallbackWhy", { zone: zoneName(change.moved.zone), dim: dimLabel(change.moved.dim), other: dimLabel(dim) }));
  else shell.announce(t("chart.zoneFallback", { zone: zoneName(zone), dim: dimLabel(dim) }));
}

// ───────────────────────────── CSV ─────────────────────────────

/** A spreadsheet reads a cell starting with = + - @ as a formula; a leading quote keeps names inert. */
export function csvCell(s: string): string {
  const safe = /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function rowsToCsv(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  return [header, ...rows].map((r) => r.map((c) => csvCell(String(c))).join(",")).join("\n");
}

function sharePercent(count: number, total: number): string {
  return total > 0 ? (Math.round((count / total) * 1000) / 10).toFixed(1) : "0.0";
}

/** The chart's counts: cells (Horizontal, Vertical) when the marks are two-way, else one row per category or mark. */
export function chartCsv(spec: ChartSpec, result: ArrangementResult, placed: number): string {
  const count = t("time.count");
  const share = t("time.share");
  const names = renamesOf(spec.options);
  const marks = result.overlay.marks.map((m) => ({ m, ref: parseRef(m.key) }));
  const cells = marks.filter((x) => x.ref?.x && x.ref.y);
  if (cells.length > 0) {
    const yDim = spec.y?.dim ?? spec.colour ?? cells[0]?.ref?.y?.[0] ?? spec.x.dim;
    const rows = cells.map(({ m, ref }) => [categoryName(ref!.x![0], ref!.x![1], ref!.x![1], names), categoryName(ref!.y![0], ref!.y![1], ref!.y![1], names), m.count, sharePercent(m.count, placed)]);
    return rowsToCsv([dimLabel(spec.x.dim), dimLabel(yDim), count, share], rows);
  }
  const folders = spec.x.dim === "folder" || spec.x.dim === "folderPath";
  const cats = result.categories ?? [];
  if (cats.length > 0) {
    const rows = cats.map((c) => [folders && c.key !== NONE_VALUE ? c.key : categoryName(spec.x.dim, c.key, c.label, names), c.count, sharePercent(c.count, placed)]);
    return rowsToCsv([dimLabel(spec.x.dim), count, share], rows);
  }
  const rows = marks.map(({ m, ref }) => {
    const pair = ref?.x ?? ref?.y;
    return [pair ? categoryName(pair[0], pair[1], m.label, names) : m.label, m.count, sharePercent(m.count, placed)];
  });
  return rowsToCsv([dimLabel(spec.x.dim), count, share], rows);
}

/** Counts of a Groups (or Body) figure: the Data view's rows for the grouping dimension. */
export function groupsCsv(dim: DimId, res: Extract<StatsResult, { kind: "data" }>): string {
  return rowsToCsv([dimLabel(dim), t("time.count"), t("time.share")], res.rows.map((r) => [categoryName(dim, r.key, r.label), r.total, sharePercent(r.total, res.totals.reduce((a, b) => a + b, 0) || r.total)]));
}

// ───────────────────────────── the feed ─────────────────────────────

export interface ChartFeedValue {
  spec: ChartSpec;
  result: ArrangementResult;
  /** Items placed in this chart (finite positions): the denominator of a mark's share. */
  placed: number;
  /** Counts up with every arrival so a consumer can tell a new result from an old one. */
  seq: number;
}

type Renderer = NonNullable<import("../../render/renderer").CortexRenderer>;
type Camera = Renderer["camera"]["camera"];

export interface FrameInfo {
  camera: Camera;
  width: number;
  height: number;
  /** The camera, size or arrangement differs from the previous frame. */
  changed: boolean;
}

interface ControllerHandle {
  renderer: Renderer | null;
}

export const FRAME_MS = 1000 / 30;
const SETTLE_MS = 750;
const SETTLE_REDUCED_MS = 120;
const DEBOUNCE_MS = 120;

let identityCounter = 0;
const identities = new WeakMap<object, number>();
function identityOf(o: object | null): number {
  if (!o) return 0;
  let id = identities.get(o);
  if (id === undefined) identities.set(o, (id = ++identityCounter));
  return id;
}

/** A value with object keys in sorted order, so two equal questions stringify alike. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return v;
}

export function countPlaced(arr: Float32Array): number {
  let n = 0;
  for (let i = 0; i + 2 < arr.length; i += 3) if (Number.isFinite(arr[i]! + arr[i + 1]! + arr[i + 2]!)) n++;
  return n;
}

export class ChartFeed {
  readonly value = signal<ChartFeedValue | null>(null);
  /** Points have settled into the chart: the overlay and readings may show. */
  readonly settled = signal(false);
  readonly visible: ReadonlySignal<boolean>;
  private refs = 0;
  private stopEffect: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private key = "";
  private valueKey = "";
  private seq = 0;
  private frameListeners = new Set<(f: FrameInfo) => void>();
  private raf: number | null = null;
  private lastFrameAt = 0;
  private lastSig: number[] = [];
  private lastEpoch = -1;
  private offBus: (() => void) | null = null;
  /** The renderer's latest chart arrangement (E9 RFC 1): adopted when it answers the feed's current question. */
  private offered: StageEvents["stage:chart"] | null = null;
  /** The visible stage as the shell last measured it (null until a layout event arrives). */
  private stage: ChartStage | null = null;
  private current: { params: { kind: "chart"; spec: ChartSpec; visibility: ReturnType<typeof visibilityParams> }; key: string } | null = null;

  constructor(
    private readonly s: CortexServices,
    private readonly leaf: LeafServices,
    private readonly shell: Shell,
  ) {
    const view = leaf.store.slices.view;
    this.visible = computed(() => this.settled.value && this.value.value !== null && view.value.shape === "chart" && view.value.morph > 0.85);
  }

  acquire(): () => void {
    if (this.refs++ === 0) this.start();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (--this.refs === 0) this.stop();
    };
  }

  private start(): void {
    const store = this.leaf.store;
    const bus = stageBus(this.s.bus);
    const offChart = bus.on("stage:chart", (e) => {
      if (e.viewId !== this.leaf.viewId) return;
      this.offered = e;
      this.tryAdopt();
    });
    // The visible stage (canvas minus the sheet), so a chart this feed asks the worker for itself is laid out for the
    // same stage as the particles the renderer placed (CHART-03).
    const offLayout = bus.on("stage:layout", (e) => {
      if (e.viewId !== this.leaf.viewId) return;
      this.stage = e.width > 0 && e.height > 0 ? chartStageOf(e.width - e.insetRight, e.height) : null;
    });
    this.offBus = () => {
      offChart();
      offLayout();
    };
    this.stopEffect = effect(() => {
      const v = store.slices.view.value;
      const ui = store.slices.ui.value;
      const idx = this.s.index.index.value;
      if (v.shape !== "chart" || !v.chart || !idx) {
        this.key = "";
        this.current = null;
        this.value.value = null;
        this.settled.value = false;
        return;
      }
      const params = { kind: "chart" as const, spec: v.chart, visibility: visibilityParams(ui, v) };
      const key = JSON.stringify([params, identityOf(idx), idx.count]);
      if (key === this.key) return;
      this.key = key;
      this.current = { params, key };
      this.settled.value = false;
      if (this.tryAdopt()) return;
      this.schedule(params, key);
    });
  }

  /**
   * Use the renderer's arrangement for the current question instead of asking the worker again. It counts only when
   * it was made for the same spec, the same visibility (revealed count 0 means "all") and the same index.
   */
  private tryAdopt(): boolean {
    const e = this.offered;
    const cur = this.current;
    const idx = this.s.index.index.peek();
    if (!e || !cur || !idx || e.index !== idx || cur.key !== this.key) return false;
    const norm = (vis: Record<string, unknown>, spec: ChartSpec): string => {
      const rc = typeof vis.revealedCount === "number" && vis.revealedCount > 0 ? Math.min(idx.count, vis.revealedCount) : idx.count;
      return JSON.stringify([canonical({ ...vis, revealedCount: rc }), canonical(spec)]);
    };
    if (norm(e.visibility as unknown as Record<string, unknown>, e.spec) !== norm(cur.params.visibility as unknown as Record<string, unknown>, cur.params.spec)) return false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.abort = null;
    this.publish(cur.params.spec, e.result, cur.key);
    return true;
  }

  private publish(spec: ChartSpec, result: ArrangementResult, key: string): ChartFeedValue {
    const next: ChartFeedValue = { spec, result, placed: countPlaced(result.arr), seq: ++this.seq };
    this.value.value = next;
    this.valueKey = key;
    const reduced = isReducedMotion(this.s.settings.value.appearance.motion, this.shell.systemReducedMotion.value);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      if (key === this.key) this.settled.value = true;
    }, reduced ? SETTLE_REDUCED_MS : SETTLE_MS);
    return next;
  }

  private stop(): void {
    this.stopEffect?.();
    this.stopEffect = null;
    this.offBus?.();
    this.offBus = null;
    this.offered = null;
    this.current = null;
    for (const t0 of [this.timer, this.settleTimer]) if (t0) clearTimeout(t0);
    this.timer = this.settleTimer = null;
    this.abort?.abort();
    this.abort = null;
    this.key = "";
    this.value.value = null;
    this.settled.value = false;
    this.stopFrames();
  }

  private schedule(params: { kind: "chart"; spec: ChartSpec; visibility: ReturnType<typeof visibilityParams> }, key: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.compute(params, key), DEBOUNCE_MS);
  }

  private async compute(params: { kind: "chart"; spec: ChartSpec; visibility: ReturnType<typeof visibilityParams> }, key: string): Promise<ChartFeedValue | null> {
    this.abort?.abort();
    const ac = new AbortController();
    this.abort = ac;
    try {
      const stage = this.offered?.stage ?? this.stage;
      const asked = stage ? { ...params, stage } : params;
      const result = await this.s.worker.call(`${this.leaf.viewId}#chart`, "arrangement", asked, { signal: ac.signal });
      if (ac.signal.aborted || key !== this.key) return null;
      return this.publish(params.spec, result, key);
    } catch (e) {
      if (!(e instanceof CortexError && e.code === "E_CANCELLED")) this.s.log.warn("chart feed failed", { error: String(e) });
      return null;
    }
  }

  /** The current chart's result, computing it now when it is not ready (Copy data as CSV, Ask). */
  async ensure(): Promise<ChartFeedValue | null> {
    const v = this.leaf.store.get("view");
    if (v.shape !== "chart" || !v.chart) return null;
    const params = { kind: "chart" as const, spec: v.chart, visibility: visibilityParams(this.leaf.store.get("ui"), v) };
    const idx = this.s.index.index.value;
    if (!idx) return null;
    const key = JSON.stringify([params, identityOf(idx), idx.count]);
    const cur = this.value.peek();
    if (cur && this.valueKey === key) return cur;
    this.key = key;
    this.current = { params, key };
    if (this.tryAdopt()) return this.value.peek();
    return this.compute(params, key);
  }

  // ───────────── frames ─────────────

  /** Subscribe to camera frames (≤ 30 Hz, only while the chart is visible). */
  onFrame(fn: (f: FrameInfo) => void): () => void {
    this.frameListeners.add(fn);
    this.startFrames();
    return () => {
      this.frameListeners.delete(fn);
      if (this.frameListeners.size === 0) this.stopFrames();
    };
  }

  /** Make the next frame report `changed` (a new arrangement or a size change). */
  invalidate(): void {
    this.lastEpoch = -1;
  }

  private startFrames(): void {
    if (this.raf !== null) return;
    const win = this.shell.win;
    const tick = (now: number) => {
      this.raf = win.requestAnimationFrame(tick);
      if (now - this.lastFrameAt < FRAME_MS) return;
      this.lastFrameAt = now;
      this.frame();
    };
    this.raf = win.requestAnimationFrame(tick);
  }

  private stopFrames(): void {
    if (this.raf !== null) this.shell.win.cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  private frame(): void {
    if (this.frameListeners.size === 0 || !this.visible.peek()) return;
    const canvas = this.shell.root?.querySelector<HTMLCanvasElement & { cortexController?: ControllerHandle }>(".cx-canvas-host canvas");
    const camera = canvas?.cortexController?.renderer?.camera?.camera;
    if (!canvas || !camera) return;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (width <= 0 || height <= 0) return;
    const sig = [...camera.matrixWorldInverse.elements, ...camera.projectionMatrix.elements, width, height];
    const epoch = this.value.peek()?.seq ?? 0;
    let changed = epoch !== this.lastEpoch || sig.length !== this.lastSig.length;
    if (!changed) for (let i = 0; i < sig.length; i++) if (sig[i] !== this.lastSig[i]) { changed = true; break; }
    this.lastSig = sig;
    this.lastEpoch = epoch;
    const info: FrameInfo = { camera, width, height, changed };
    for (const fn of Array.from(this.frameListeners)) fn(info);
  }
}

const feeds = new WeakMap<LeafServices, ChartFeed>();

export function chartFeedFor(s: CortexServices, leaf: LeafServices, shell: Shell): ChartFeed {
  let f = feeds.get(leaf);
  if (!f) feeds.set(leaf, (f = new ChartFeed(s, leaf, shell)));
  return f;
}

/** The leaf's chart feed (running while any consumer is mounted) and its current value. */
export function useChartFeed(): { feed: ChartFeed; value: ChartFeedValue | null; visible: boolean } {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const feed = chartFeedFor(s, leaf, shell);
  useEffect(() => feed.acquire(), [feed]);
  return { feed, value: feed.value.value, visible: feed.visible.value };
}

// ───────────────────────────── hit testing ─────────────────────────────

export interface ScreenMark {
  key: string;
  label: string;
  count: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
}

/** Screen rectangles of the overlay's marks (corners projected; marks behind the camera are dropped). */
export function projectMarks(model: OverlayModel, camera: Camera, width: number, height: number): ScreenMark[] {
  const out: ScreenMark[] = [];
  for (const m of model.marks) {
    const { min, max } = m.bounds;
    const corners: Vec3[] = [min, max, [min[0], max[1], min[2]], [max[0], min[1], max[2]]];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, ok = true;
    for (const c of corners) {
      const p = project(c, camera, width, height);
      if (!p.visible) ok = false;
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
    if (ok) out.push({ key: m.key, label: m.label, count: m.count, x0, y0, x1, y1, area: (x1 - x0) * (y1 - y0) });
  }
  return out;
}

/** The smallest mark under the point (so a cell wins over the band that holds it). */
export function markAt(marks: readonly ScreenMark[], x: number, y: number): ScreenMark | null {
  let best: ScreenMark | null = null;
  for (const m of marks) if (x >= m.x0 && x <= m.x1 && y >= m.y0 && y <= m.y1 && (!best || m.area < best.area)) best = m;
  return best;
}

// ───────────────────────────── the component ─────────────────────────────

interface LabelEl {
  el: HTMLElement;
  at: Vec3;
  align: "left" | "center" | "right";
  rotate: number;
  style: ScreenLabel["style"];
  zoom: number | undefined;
  zoomMax: number | undefined;
  cell: number | undefined;
  /** Anchored in screen space (CSS px from the stage's top-left): the treemap's crumb. */
  screen: boolean;
  /** The value a band label stands for (highlight chips and dimming follow the tokens). */
  pair: [DimId, string] | null;
}

/** What semantic zoom keeps per arrangement: the cells nobody named at layout time and their biggest members. */
interface ZoomState {
  seq: number;
  members: Map<number, number[]>;
}

/** Width of one character of a member title (CSS px), for the room a title takes. */
const MEMBER_LABEL_CHAR_PX = 7;

/** Reserve the room of a title of `chars` characters standing at (x, y); false, and nothing reserved, when it would touch one already placed. */
export function placeTitle(placed: { x0: number; y0: number; x1: number; y1: number }[], x: number, y: number, chars: number): boolean {
  const box = { x0: x - 4, y0: y - 9, x1: x + chars * MEMBER_LABEL_CHAR_PX + 4, y1: y + 9 };
  if (placed.some((q) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0)) return false;
  placed.push(box);
  return true;
}

/**
 * Name the members of the cells under the view that the layout did not name (semantic zoom, shared/chartZoom.ts):
 * for every unnamed cell that is on screen and big enough, up to the caps, a label per biggest member, drawn in the
 * pooled elements of `host`. Returns the cells named, so their counts can give way. While the chart is zoomed out
 * this costs one projection pass over the unnamed cells (the layout's `zoomMembers`).
 */
export function nameZoomedCells(cur: ChartFeedValue, f: FrameInfo, index: DataIndex | null, state: { current: ZoomState | null }, pool: HTMLElement[], host: HTMLElement | null): Set<number> {
  const named = new Set<number>();
  const hide = (from: number): void => {
    for (let i = from; i < pool.length; i++) (pool[i] as HTMLElement).style.display = "none";
  };
  if (!host || !index) return named;
  const marks = cur.result.overlay.marks;
  let st = state.current;
  if (!st || st.seq !== cur.seq) {
    const members = new Map<number, number[]>();
    for (const z of cur.result.zoomMembers ?? []) if (marks[z.mark] && z.members.length > 0) members.set(z.mark, z.members);
    st = state.current = { seq: cur.seq, members };
  }
  const cells = st.members.size === 0 ? [] : pickZoomCells(marks, st.members, (p: Vec3) => project(p, f.camera, f.width, f.height), { width: f.width, height: f.height });
  if (cells.length === 0) {
    hide(0);
    return named;
  }
  const doc = host.ownerDocument;
  let used = 0;
  // Screen rectangles of the titles already placed: a title never lands on another (a big tile holds many members).
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const mark of cells) {
    for (const o of st.members.get(mark) ?? []) {
      if (o >= index.count) continue;
      const text = memberLabelText(index.titles.get(o));
      if (text === "") continue;
      const p = project([(cur.result.arr[o * 3] as number) + 0.02, cur.result.arr[o * 3 + 1] as number, (cur.result.arr[o * 3 + 2] as number) + 0.04], f.camera, f.width, f.height);
      if (p.visible && !placeTitle(placed, p.x, p.y, text.length)) continue;
      let el = pool[used];
      if (!el) {
        el = doc.createElement("span");
        el.className = "cx-axis-label is-muted";
        host.appendChild(el);
        pool.push(el);
      }
      used += 1;
      if (!p.visible) {
        el.style.display = "none";
        continue;
      }
      if (el.textContent !== text) el.textContent = text;
      el.style.display = "";
      el.style.opacity = String(Math.max(0.45, 1 - 0.55 * p.depth));
      el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(0%, -50%)`;
      named.add(mark);
    }
  }
  hide(used);
  return named;
}

/** Folder-icicle labels toggle their row; the others trace. Combine is offered from axis labels of the x dimension. */
export function toggleFold(options: ChartSpec["options"], path: string, open: boolean): ChartSpec["options"] {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const collapsed = list(options.collapsed).filter((p) => p !== path);
  const expanded = list(options.expanded).filter((p) => p !== path);
  if (open) collapsed.push(path);
  else expanded.push(path);
  return { ...options, collapsed, expanded };
}

/** Zoom the treemap into a folder path ("" = back to the whole tree): its crumb segments and its boxes with folders inside. */
export function drillTreemap(store: CortexStore, root: string): void {
  store.update("view", (v) => (v.chart && v.chart.chart === "treemap" ? { ...v, chart: { ...v.chart, options: withTreemapRoot(v.chart.options, root) } } : v));
}

/** Add `others` to the combine of `first` on `dim` (key "‹dim›=‹first›", the shape the worker reads). */
export function addCombine(combined: ChartSpec["combined"], dim: DimId, first: string, other: string): ChartSpec["combined"] {
  const key = `${dim}=${first}`;
  const cur = combined[key] ?? [];
  if (cur.includes(other) || other === first) return combined;
  return { ...combined, [key]: [...cur, other] };
}

interface Tip {
  x: number;
  y: number;
  name: string;
  count: number;
  share: string;
  span: string;
}

export function ChartOverlay(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const { feed, value, visible } = useChartFeed();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const zoomState = useRef<ZoomState | null>(null);
  const zoomPool = useRef<HTMLElement[]>([]);
  const latest = useRef({ value, visible });
  latest.current = { value, visible };
  const [tip, setTip] = useState<Tip | null>(null);
  const [labelTip, setLabelTip] = useState<{ x: number; y: number; text: string; hint: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  // Highlight chips follow the tokens (and the colours the Key shows): re-read here so the label styling effect re-runs.
  const tokensNow = leaf.store.slices.ui.value.tokens;
  const legendNow = leaf.store.slices.legend.value;

  // Dimension chips dragged over the stage show the three drop zones.
  useEffect(() => {
    const doc = shell.doc;
    if (!doc) return undefined;
    const start = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes(DIM_MIME)) setDragging(true);
    };
    const end = () => setDragging(false);
    doc.addEventListener("dragstart", start);
    doc.addEventListener("dragend", end);
    doc.addEventListener("drop", end);
    return () => {
      doc.removeEventListener("dragstart", start);
      doc.removeEventListener("dragend", end);
      doc.removeEventListener("drop", end);
    };
  }, [shell]);

  // Copy data as CSV: the palette command, the More menu and the Chart page all arrive as a bus "command".
  useEffect(() => bindCopyCsv(s.bus, leaf.viewId, () => void copyDataAsCsv(s, leaf, shell, feed)), [s, leaf, shell, feed]);

  // Labels: one element per overlay label, rebuilt when a new arrangement lands, moved on every camera frame.
  const labelEls = useRef<LabelEl[]>([]);
  useEffect(() => {
    const host = labelsRef.current;
    if (!host) return undefined;
    host.replaceChildren();
    labelEls.current = [];
    if (!value) return undefined;
    const doc = host.ownerDocument;
    const spec = value.spec;
    const tokens = featureOn("highlightTokens");
    const folds = featureOn("chartShape");
    const names = renamesOf(spec.options);
    for (const item of value.result.overlay.items) {
      if (item.type !== "label") continue;
      const ref = parseRef(item.key);
      const text = overlayLabelText(item.text, ref, names);
      if (text === "") continue;
      const link = (refTraceable(ref) && tokens) || (ref?.fold !== undefined && folds) || ref?.drill !== undefined;
      const el = doc.createElement(link ? "button" : "span");
      el.className = `cx-axis-label is-${item.style}${link ? " is-link" : ""}`;
      el.textContent = text;
      el.dataset.cxLabelKey = item.key; // Save image reads the resolved text back from here (render/exportPicture.ts)
      if (el instanceof HTMLButtonElement) {
        el.type = "button";
        el.addEventListener("click", (e) => {
          if (!ref) return;
          if (ref.drill !== undefined) {
            drillTreemap(leaf.store, ref.drill);
            return;
          }
          if (ref.fold !== undefined) {
            const open = value.result.overlay.items.some((o) => o.type === "label" && parseRef(o.key)?.x?.[1]?.startsWith(`${ref.fold}/`));
            leaf.store.update("view", (v) => (v.chart ? { ...v, chart: { ...v.chart, options: toggleFold(v.chart.options, ref.fold!, open) } } : v));
            return;
          }
          if (!tokens) return;
          const pair = labelPair(ref);
          const siblings = pair ? value.result.overlay.items.flatMap((o) => (o.type === "label" ? [labelPair(parseRef(o.key))] : [])).filter((x): x is [DimId, string] => x !== null && x[0] === pair[0]).map((x) => x[1]) : [];
          labelClick(leaf.store, ref, item.text, e.altKey, [...new Set(siblings)]);
        });
        // Hovering a band label says what a click, a right-click and an Alt-click do.
        const pair = labelPair(ref);
        if (pair && tokens) {
          el.addEventListener("pointerenter", () => {
            const host = labelsRef.current;
            if (!host) return;
            const hr = host.getBoundingClientRect();
            const r = el.getBoundingClientRect();
            const cur = latest.current.value;
            setLabelTip({
              x: r.left - hr.left,
              y: r.bottom - hr.top,
              text: labelTipText(text, cur ? labelCount(cur.result, cur.spec.x.dim, pair) : 0),
              hint: labelHintText(shell.win.navigator?.platform ?? ""),
            });
          });
          el.addEventListener("pointerleave", () => setLabelTip(null));
        }
        const renamable = featureOn("combineValues") && !!ref?.x && ref.x[0] === spec.x.dim && isCombined(spec.combined, ref.x[0], ref.x[1]);
        const rename = (): void => {
          if (!renamable || !ref?.x) return;
          const [dim, first] = ref.x;
          renameInline(el, text, (name) => {
            const before = leaf.store.get("view").chart;
            if (!before) return;
            const own = categoryName(dim, first, first);
            const next = setCombinedName(before.options, dim, first, name, own);
            if (JSON.stringify(next) === JSON.stringify(before.options)) return;
            leaf.store.update("view", (v) => (v.chart ? { ...v, chart: { ...v.chart, options: setCombinedName(v.chart.options, dim, first, name, own) } } : v));
            shell.pushUndo(() => leaf.store.update("view", (v) => ({ ...v, chart: before })));
          });
        };
        if (renamable) el.addEventListener("dblclick", rename);
        el.addEventListener("contextmenu", (e) => {
          const bandPair = labelPair(ref);
          // Right-click removes a highlight or hides the band; Shift + right-click keeps Combine with… (and Rename…).
          if (tokens && bandPair && !e.shiftKey) {
            e.preventDefault();
            setLabelTip(null);
            labelContext(leaf.store, bandPair);
            return;
          }
          if (!featureOn("combineValues") || !ref?.x || ref.x[0] !== spec.x.dim) return;
          e.preventDefault();
          const [dim, first] = ref.x;
          const others = (value.result.categories ?? []).filter((c) => c.key !== first && c.key !== OTHER_VALUE).slice(0, 40);
          if (others.length === 0 && !renamable) return;
          const items: MenuItemSpec[] = others.map((c) => ({ value: c.key, label: categoryName(dim, c.key, c.label, names), group: "combine", groupLabel: t("chart.combineWith") }));
          if (renamable) items.unshift({ value: RENAME_MENU_VALUE, label: t("chart.renameCombined"), group: "rename" });
          showMenu(
            items,
            el,
            (other) => {
              if (other === RENAME_MENU_VALUE) return rename();
              const before = leaf.store.get("view").chart;
              if (!before) return;
              leaf.store.update("view", (v) => (v.chart ? { ...v, chart: { ...v.chart, combined: addCombine(v.chart.combined, dim, first, other) } } : v));
              shell.pushUndo(() => leaf.store.update("view", (v) => ({ ...v, chart: before })));
            },
          );
        });
      }
      host.appendChild(el);
      labelEls.current.push({ el, at: item.at, align: item.align ?? "center", rotate: item.rotate ?? 0, style: item.style, zoom: ref?.zoom, zoomMax: ref?.zoomMax, cell: ref?.cell, screen: item.screen === true, pair: link ? labelPair(ref) : null });
    }
    feed.invalidate();
    return () => {
      host.replaceChildren();
      setLabelTip(null);
    };
  }, [value, leaf, shell, feed]);

  // Highlighted band labels become filled chips in their group's colour; every other band label steps back to 40%.
  useEffect(() => {
    for (const l of labelEls.current) {
      const st = labelHighlight(tokensNow, l.pair);
      l.el.classList.toggle("is-highlighted", st.highlighted);
      l.el.classList.toggle("is-dimmed", st.dimmed);
      if (st.highlighted && l.pair) {
        const rgb = labelRgb(l.pair, value?.spec.colour ?? null, value?.result.colourKey, legendNow);
        if (rgb) {
          l.el.style.setProperty("--cx-chip", rgbCss(rgb));
          l.el.style.setProperty("--cx-chip-ink", chipInk(rgb));
        } else {
          l.el.style.removeProperty("--cx-chip");
          l.el.style.removeProperty("--cx-chip-ink");
        }
      }
    }
    feed.invalidate();
  }, [value, tokensNow, legendNow, feed]);

  // Semantic zoom for the cells the layout left unnamed: their members are named once the view is zoomed in on them.
  useEffect(() => {
    zoomState.current = null;
    const pool = zoomPool.current;
    return () => {
      zoomRef.current?.replaceChildren();
      pool.length = 0;
    };
  }, [value]);

  // Frames: project the overlay, draw rules on the canvas, move the labels.
  const marksRef = useRef<ScreenMark[]>([]);
  useEffect(() => {
    return feed.onFrame((f) => {
      const cur = latest.current.value;
      const canvas = canvasRef.current;
      if (!cur || !canvas || !f.changed) return;
      const dpr = shell.win.devicePixelRatio || 1;
      const w = Math.round(f.width * dpr), h = Math.round(f.height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const ink = getComputedStyle(canvas).getPropertyValue("--cx-stage-text-2").trim() || "#c3c8d1";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, f.width, f.height);
      ctx.lineWidth = 1;
      const screen = projectOverlay(cur.result.overlay, f.camera, f.width, f.height);
      for (const it of screen) {
        ctx.setLineDash([]);
        ctx.strokeStyle = ink;
        ctx.fillStyle = ink;
        switch (it.type) {
          case "line":
            ctx.globalAlpha = it.alpha;
            ctx.setLineDash(it.dashed ? [4, 3] : []);
            ctx.beginPath();
            ctx.moveTo(it.x0, it.y0);
            ctx.lineTo(it.x1, it.y1);
            ctx.stroke();
            break;
          case "polyline":
            ctx.globalAlpha = it.alpha;
            ctx.beginPath();
            for (let i = 0; i + 1 < it.points.length; i += 2) {
              if (i === 0) ctx.moveTo(it.points[0]!, it.points[1]!);
              else ctx.lineTo(it.points[i]!, it.points[i + 1]!);
            }
            if (it.closed) ctx.closePath();
            ctx.stroke();
            break;
          case "rect":
            if (it.fill > 0) {
              ctx.globalAlpha = it.fill;
              ctx.fillRect(it.x0, it.y0, it.x1 - it.x0, it.y1 - it.y0);
            }
            ctx.globalAlpha = it.alpha;
            ctx.strokeRect(it.x0, it.y0, it.x1 - it.x0, it.y1 - it.y0);
            break;
          case "ring":
            if (it.hue !== undefined) {
              // A coloured ring is a solid dot (the lifeline focus ribbon and halo).
              ctx.globalAlpha = 0.9;
              ctx.fillStyle = `hsl(${Math.round(it.hue)}, 78%, 64%)`;
              ctx.beginPath();
              ctx.arc(it.x, it.y, Math.max(1.5, it.r), 0, Math.PI * 2);
              ctx.fill();
              break;
            }
            ctx.globalAlpha = 0.75;
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(it.x, it.y, Math.max(2, it.r), 0, Math.PI * 2);
            ctx.stroke();
            ctx.lineWidth = 1;
            break;
          default:
            break;
        }
      }
      ctx.globalAlpha = 1;
      const named = nameZoomedCells(cur, f, s.index.index.peek(), zoomState, zoomPool.current, zoomRef.current);
      for (const l of labelEls.current) {
        const p = l.screen ? { x: l.at[0], y: l.at[1], visible: true, depth: 0 } : project(l.at, f.camera, f.width, f.height);
        let show = p.visible;
        if (show && (l.zoom !== undefined || l.zoomMax !== undefined)) {
          const q = project([l.at[0], l.at[1] + 1, l.at[2]], f.camera, f.width, f.height);
          const perUnit = Math.hypot(q.x - p.x, q.y - p.y);
          // Semantic zoom: a cell's count shows from 18 px and gives way to its member labels once the cell is big.
          if (l.zoom !== undefined && perUnit * l.zoom < 18) show = false;
          if (l.zoomMax !== undefined && perUnit * l.zoomMax >= 18) show = false;
        }
        // A cell the overlay has just named gives its count way, as the layout's own named cells do.
        if (show && l.cell !== undefined && l.zoomMax === undefined && named.has(l.cell)) show = false;
        if (!show) {
          l.el.style.display = "none";
          continue;
        }
        const ax = l.align === "left" ? 0 : l.align === "right" ? -100 : -50;
        l.el.style.display = "";
        let fade = 1;
        let grow = 1;
        if (l.zoom !== undefined || l.zoomMax !== undefined) {
          // A count grows with its cell (up to 1.8x) and fades out over the give-way band instead of switching off.
          const q = project([l.at[0], l.at[1] + 1, l.at[2]], f.camera, f.width, f.height);
          const perUnit = Math.hypot(q.x - p.x, q.y - p.y);
          if (l.zoom !== undefined) grow = countScale(perUnit * l.zoom);
          if (l.zoomMax !== undefined) fade = giveWayOpacity(perUnit * l.zoomMax);
        }
        l.el.style.opacity = String(Math.max(0.45, 1 - 0.55 * p.depth) * fade);
        l.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(${ax}%, -50%)${l.rotate ? ` rotate(${l.rotate}deg)` : ""}${grow > 1 ? ` scale(${grow.toFixed(2)})` : ""}`;
      }
      marksRef.current = projectMarks(cur.result.overlay, f.camera, f.width, f.height);
    });
  }, [feed, shell, s]);

  // Hover tooltip and click-to-trace on the marks; the canvas belongs to the renderer, so listen beside it.
  useEffect(() => {
    const host = rootRef.current?.closest(".cx-canvas-host");
    const canvas = host?.querySelector("canvas");
    if (!canvas) return undefined;
    let down: { x: number; y: number } | null = null;
    const local = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    // The hovered cell's dates go to the time strip's brush marker (only a changed span is written).
    const publishRange = (r: [number, number] | null) => {
      const cur = leaf.store.get("ui").hoverRange;
      if (cur === r || (cur && r && cur[0] === r[0] && cur[1] === r[1])) return;
      leaf.store.update("ui", { hoverRange: r });
    };
    const clearHover = () => {
      setTip(null);
      publishRange(null);
    };
    const onMove = (e: PointerEvent) => {
      const cur = latest.current;
      if (!cur.visible || !cur.value) return clearHover();
      const p = local(e);
      const hit = markAt(marksRef.current, p.x, p.y);
      if (!hit) return clearHover();
      const ref = parseRef(hit.key);
      publishRange(hoverSpan(ref));
      const win = leaf.store.get("ui").period;
      setTip({
        x: p.x,
        y: p.y,
        name: overlayLabelText(hit.label, ref, renamesOf(cur.value.spec.options)) || hit.label,
        count: hit.count,
        share: sharePercent(hit.count, cur.value.placed),
        span: ref?.span ? fmtDayRange(ref.span[0], ref.span[1]) : win ? fmtDayRange(win[0], Math.max(win[0], win[1] - 1)) : t("strip.allTime"),
      });
    };
    const onDown = (e: PointerEvent) => {
      down = local(e);
    };
    const onUp = (e: PointerEvent) => {
      const start = down;
      down = null;
      const cur = latest.current;
      if (!start || !cur.visible || !cur.value || !featureOn("chartShape") || e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return;
      const p = local(e);
      if (Math.hypot(p.x - start.x, p.y - start.y) > 4) return;
      const hit = markAt(marksRef.current, p.x, p.y);
      const ref = hit ? parseRef(hit.key) : null;
      // A treemap box with folders inside zooms into its top-level folder; Alt keeps the usual trace.
      if (ref?.drill !== undefined && !e.altKey && cur.value.spec.chart === "treemap") {
        drillTreemap(leaf.store, ref.drill);
        return;
      }
      if (!hit || !refTraceable(ref)) return;
      // A click on a particle selects it (the renderer picks asynchronously); only a click on the mark itself traces.
      const before = leaf.store.get("selection");
      shell.win.setTimeout(() => {
        if (leaf.store.get("selection") !== before) return;
        for (const tk of refTokens(ref, hit.label)) addToken(leaf.store, tk);
      }, 160);
    };
    const onLeave = clearHover;
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    return () => {
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      publishRange(null);
    };
  }, [leaf, shell]);

  const reduced = isReducedMotion(s.settings.value.appearance.motion, shell.systemReducedMotion.value);
  // Waves labels flicker for a few hundred ms while the waves lay out, then stay on (CHART-37).
  useEffect(() => {
    const host = labelsRef.current;
    if (!host || !value || !blinkApplies(value.spec.chart)) return undefined;
    const steps = blinkSteps(reduced);
    if (steps.length === 0) return undefined;
    let i = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      host.classList.toggle("is-blink-off", !steps[i]);
      i += 1;
      if (i < steps.length) timer = setTimeout(tick, BLINK_STEP_MS);
    };
    tick();
    return () => {
      if (timer) clearTimeout(timer);
      host.classList.remove("is-blink-off");
    };
  }, [value, reduced]);
  const transition = reduced ? "opacity 120ms linear" : visible ? "opacity 250ms linear" : "opacity 100ms linear";
  const chartOn = leaf.store.slices.view.value.shape === "chart" && leaf.store.slices.view.value.chart !== null;
  const onDrop = (zone: Zone) => (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const dim = e.dataTransfer?.getData(DIM_MIME);
    if (isKnownDim(dim)) dropOnZone(leaf, shell, zone, dim);
  };
  return (
    <div class={`cx-chart-stage${dragging && chartOn ? " is-dragging" : ""}`}>
      <div ref={rootRef} class="cx-chart-layer" style={{ opacity: visible ? 1 : 0, transition }} aria-hidden="true">
        <ChartComets feed={feed} value={value} win={shell.win} active={visible && !reduced && value?.spec.chart === "treemap"} />
        <canvas ref={canvasRef} class="cx-chart-overlay" />
        <div ref={labelsRef} class="cx-chart-labels" />
        <div ref={zoomRef} class="cx-chart-labels" />
        {visible && labelTip ? (
          <div class="cx-chart-tip cx-chart-label-tip" role="tooltip" style={{ left: `${labelTip.x}px`, top: `${labelTip.y + 6}px` }}>
            <div class="cx-chart-tip-name">{labelTip.text}</div>
            <div class="cx-chart-tip-hint">{labelTip.hint}</div>
          </div>
        ) : null}
        {visible && tip ? (
          <div class="cx-chart-tip" style={{ left: `${tip.x + 16}px`, top: `${tip.y + 16}px` }}>
            <div class="cx-chart-tip-name">{tip.name}</div>
            <div class="cx-chart-tip-line cx-mono">{`${t("sources.count", { n: tip.count.toLocaleString("en-GB") })} · ${tip.share}%`}</div>
            <div class="cx-chart-tip-line">{tip.span}</div>
            <div class="cx-chart-tip-hint">{pendingCopy("tipChartHint")}</div>
          </div>
        ) : null}
      </div>
      {dragging && chartOn
        ? ZONES.map((z) => (
            <div key={z} class={`cx-chart-drop is-${z}`} onDragOver={(e) => e.preventDefault()} onDrop={onDrop(z)}>
              <span>{zoneName(z)}</span>
            </div>
          ))
        : null}
    </div>
  );
}

// ───────────────────────────── Copy data as CSV ─────────────────────────────

/** The bus "command" handler for Copy data as CSV (palette, More menu and the Chart page all emit it). */
export function bindCopyCsv(bus: Pick<CortexServices["bus"], "on">, viewId: string, run: () => void): () => void {
  return bus.on("command", (ev) => {
    if (ev.viewId === viewId && ev.id === "copy-data-csv") run();
  });
}

/** The text Copy data as CSV puts on the clipboard: the chart's counts, or the grouping's counts outside a chart. */
export async function csvForLeaf(s: CortexServices, leaf: LeafServices, feed: ChartFeed): Promise<string | null> {
  const view = leaf.store.get("view");
  if (view.shape === "chart" && view.chart) {
    const v = await feed.ensure();
    return v ? chartCsv(v.spec, v.result, v.placed) : null;
  }
  const res = await s.worker.call(`${leaf.viewId}#csv`, "stats", { kind: "data", rows: view.groupBy, columns: "none", measure: "entries", visibility: visibilityParams(leaf.store.get("ui"), view) });
  return res.kind === "data" ? groupsCsv(view.groupBy, res) : null;
}

export async function copyDataAsCsv(s: CortexServices, leaf: LeafServices, shell: Shell, feed: ChartFeed): Promise<void> {
  try {
    const csv = await csvForLeaf(s, leaf, feed);
    const ok = csv !== null && (await copyToClipboard(csv));
    if (ok) shell.toast({ kind: "info", text: t("time.copied") });
    else shell.toast({ kind: "error", text: t("errors.action"), sticky: true });
  } catch (e) {
    s.log.warn("copy data as CSV failed", { error: String(e) });
    shell.toast({ kind: "error", text: t("errors.action"), sticky: true });
  }
}
