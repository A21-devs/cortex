/**
 * Tooltip (CORTEX-UX §5.12, §4.9): a glass-strong card at pointer + (16, 16), flipped near the edges of the
 * visible stage, shown as soon as the renderer reports a hover (it waits for 60 ms of stillness); a 3 px colour bar
 * on the left in the point's colour. Formats per item kind:
 *  message: title ≤ 60 · "Claude Code · 39 / 549" · "3 Nov 2026, 14:52 · Roblox" · "Click to read · double-click
 *    for the conversation"; document passage: title · ".raw · passage 3 of 12" · "No date of its own · Roblox" ·
 *    "Click to read"; machine note: kind glyph + text · kind · date and area · "Click to read"; vault note: title ·
 *    "Vault note" · "folder · Area" · "Click to peek · Ctrl+click to open"; map: ✦ + title · "Project map · Area" ·
 *    date · "Click to read · Shift+click to trace every source"; a hovered line: "Source line" or "Conversation
 *    stem" and what it joins.
 * Item facts come from the index (IndexService.meta); the line under a hover and the point's colour come with the
 * hover when the renderer provides them (docs/rfcs/E11.md §2). Owner: E11.
 *
 * Two styles, per device (device state `tooltipStyle`, set in the Display popover): "line" (default) is one dark line with a
 * 1 px light border, "title · date · field", clipped with an ellipsis at 420 px; "card" is the glass card above. Both follow the
 * pointer's own hover reports (no dwell). The field follows the active grouping or colour dimension (`tooltipDim`, `fieldFor`):
 * folder path for Folder, the area for Area, "Oct 2026" for a month, "Project map, cooling" for a map, else the kind; the card
 * shows it as one more line when it adds something.
 */
import type { JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { ItemMeta } from "../../plugin/indexer";
import type { CortexServices } from "../../plugin/services";
import type { DimId } from "../../shared/dims";
import { ItemKind } from "../../shared/index-format";
import { ageColor, rgbCss, type Rgb } from "../../shared/palette";
import type { ChartSpec, LegendModel } from "../../shared/protocol/worker";
import { spaceName } from "../../shared/spaces";
import { formatShort } from "../../shared/time";
import { truncate } from "../../shared/text";
import type { SpaceId } from "../../shared/types";
import type { ShapeKind } from "../../shared/views";
import type { HoverState } from "../../state/types";
import { SHELL, stageBox } from "../breakpoints";
import { indexCounts, num, pendingCopy, useLeaf, useServices, useShell, type IndexCounts } from "../context";
import { t } from "../copy";
import { fmtMonth, mapKindLabel, speakerLabel, valueLabel } from "../valueLabels";

const GLYPH: Record<string, string> = { decision: "◆", question: "?", plan: "▸", abandoned: "×", idea: "✶", concept: "◎", gist: "≡", summary: "≡" };

/** Optional extras a renderer may attach to the hover (docs/rfcs/E11.md §2). */
export interface HoverExtras {
  rgb?: [number, number, number];
  line?: { family: "source" | "stem" | "spoke"; owner: number; target: number; of?: number };
}

export interface TooltipModel {
  title: string;
  lines: { text: string; mono?: boolean }[];
  hint?: string;
  /** The item's date ("3 Nov 2026"), when it has one (the one-line tooltip's second part). */
  date?: string;
  /** The grouping-aware field: what the active grouping or colour says about this item (the one-line tooltip's last part). */
  field?: string;
}

/** The one-line tooltip's widest extent, and the height the first paint assumes before it is measured. */
export const LINE_TOOLTIP = { maxW: 420, estH: 28 } as const;

function cap(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** "3 Nov 2026, 14:52". */
export function dateTime(ms: number): string {
  if (!Number.isFinite(ms)) return t("reader.noDate");
  const time = new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${formatShort(ms)}, ${time}`;
}

function area(space: string): string {
  return spaceName(space as SpaceId);
}

/** "Project map, cooling": a map's type and recency. */
function mapField(meta: ItemMeta): string {
  const kind = meta.mapKind ? cap(mapKindLabel(meta.mapKind)) : cap(valueLabel("map"));
  return meta.hubStatus ? t("overlays.mapField", { kind, status: valueLabel(meta.hubStatus) }) : kind;
}

/** What the item is: the kind of note, the source of an entry, the type and recency of a map. */
function kindField(meta: ItemMeta): string {
  switch (meta.kind) {
    case ItemKind.RecordMessage:
    case ItemKind.RecordDocument:
    case ItemKind.RecordPassage:
    case ItemKind.RecordFile:
      return valueLabel(meta.source);
    case ItemKind.NoteHub:
      return mapField(meta);
    case ItemKind.NoteWiki:
      return cap(valueLabel("wiki"));
    default:
      return cap(valueLabel(meta.noteKind ?? "summary"));
  }
}

/** The dimension the tooltip's last field follows: the grouping while a groups or chart shape shows, else what colours this population. */
export function tooltipDim(shape: ShapeKind, morph: number, groupBy: DimId, chart: ChartSpec | null, legend: LegendModel | null, population: "note" | "record"): DimId | null {
  const shaped = morph > SHELL.timing.snapWithin;
  if (shaped && shape === "groups") return groupBy;
  if (shaped && shape === "chart" && chart) return chart.colour ?? chart.x.dim;
  const pop = population === "note" ? "notes" : "record";
  const sec = legend?.sections.find((x) => x.population === pop || x.population === "both");
  return sec && sec.dim !== "age" && sec.dim !== "single" ? sec.dim : null;
}

/** The item's value on a dimension, worded for a tooltip: the folder path, the area, "Oct 2026" for a month, "Project map, cooling" for a map; the kind when the dimension has no value for it. */
export function fieldFor(dim: DimId | null, meta: ItemMeta): string {
  if (dim === null) return kindField(meta);
  const when = meta.writtenAt ? Date.parse(meta.writtenAt) : Number.NaN;
  switch (dim) {
    case "space":
      return area(meta.space);
    case "filing":
      return t(meta.space === "none" ? "dims.unfiled" : "dims.filed");
    case "folder":
    case "folderPath":
      return meta.folder || kindField(meta);
    case "source":
      return valueLabel(meta.source);
    case "speaker":
      return speakerLabel(meta.speaker);
    case "conversation":
      return meta.conversation?.title ?? kindField(meta);
    case "map":
    case "hubStatus":
      return meta.kind === ItemKind.NoteHub ? mapField(meta) : kindField(meta);
    case "day":
    case "week":
    case "month":
    case "year":
    case "hour":
    case "weekday":
    case "monthOfYear": {
      if (!Number.isFinite(when)) return t("reader.noDate");
      const d = new Date(when);
      if (dim === "day" || dim === "week") return formatShort(when);
      if (dim === "month") return fmtMonth(when);
      if (dim === "year") return String(d.getFullYear());
      if (dim === "hour") return `${String(d.getHours()).padStart(2, "0")}:00`;
      return d.toLocaleDateString("en-GB", dim === "weekday" ? { weekday: "long" } : { month: "long" });
    }
    default:
      return kindField(meta);
  }
}

/** The tooltip's lines for an item (pure). `dim` is the active grouping or colour dimension (see tooltipDim). */
export function tooltipModel(meta: ItemMeta, dim: DimId | null = null): TooltipModel {
  const base = baseModel(meta);
  const when = meta.writtenAt ? Date.parse(meta.writtenAt) : Number.NaN;
  const field = fieldFor(dim, meta);
  const seen = [base.title, ...base.lines.map((l) => l.text)].join(" ");
  // The card shows the grouping's field as one more line only when it tells something the card does not already say.
  const lines = dim !== null && !seen.includes(field) ? [...base.lines, { text: field }] : base.lines;
  return { ...base, lines, field, ...(Number.isFinite(when) ? { date: formatShort(when) } : {}) };
}

/** The one-line tooltip's text: "title · date · field" (a hovered line has no date or field: "title · what it joins"). */
export function lineText(model: TooltipModel): string {
  const parts = model.field === undefined ? [model.title, ...model.lines.map((l) => l.text)] : [model.title, model.date, model.field];
  return parts.filter((x): x is string => typeof x === "string" && x.length > 0).join(" · ");
}

function baseModel(meta: ItemMeta): TooltipModel {
  const when = meta.writtenAt ? Date.parse(meta.writtenAt) : Number.NaN;
  const place = area(meta.space);
  switch (meta.kind) {
    case ItemKind.RecordMessage: {
      const c = meta.conversation;
      const where = c ? `${valueLabel(meta.source)} · ${num(c.index + 1)} / ${num(c.count)}` : valueLabel(meta.source);
      return { title: truncate(meta.title, 60), lines: [{ text: where, mono: true }, { text: `${dateTime(when)} · ${place}` }], hint: pendingCopy("tipMessageHint") };
    }
    case ItemKind.RecordDocument:
    case ItemKind.RecordPassage:
    case ItemKind.RecordFile: {
      const c = meta.conversation;
      const where = c && c.count > 1 ? pendingCopy("tipPassage", { source: valueLabel(meta.source), i: num(c.index + 1), n: num(c.count) }) : valueLabel(meta.source);
      const date = Number.isFinite(when) ? formatShort(when) : t("reader.noDate");
      return { title: truncate(meta.title, 60), lines: [{ text: where }, { text: `${date} · ${place}` }], hint: pendingCopy("tipReadHint") };
    }
    case ItemKind.NoteHub: {
      const kind = meta.mapKind ? cap(valueLabel(meta.mapKind)) : cap(valueLabel("map"));
      const lines = [{ text: `${kind} · ${place}` }];
      if (Number.isFinite(when)) lines.push({ text: formatShort(when) });
      return { title: `✦ ${truncate(meta.title, 58)}`, lines, hint: pendingCopy("tipMapHint") };
    }
    case ItemKind.NoteWiki:
      return { title: truncate(meta.title, 60), lines: [{ text: cap(valueLabel("wiki")) }, { text: `${meta.folder || "/"} · ${place}` }], hint: pendingCopy("tipVaultHint") };
    default: {
      const k = meta.noteKind ?? "summary";
      const glyph = GLYPH[k] ?? "";
      const date = Number.isFinite(when) ? formatShort(when) : t("reader.noDate");
      return { title: `${glyph ? `${glyph} ` : ""}${truncate(meta.title, 58)}`, lines: [{ text: cap(valueLabel(k)) }, { text: `${date} · ${place}` }], hint: pendingCopy("tipReadHint") };
    }
  }
}

/** A line's tooltip: which family and what it joins. */
export function lineModel(line: NonNullable<HoverExtras["line"]>, owner: ItemMeta | undefined): TooltipModel {
  if (line.family === "stem") return { title: pendingCopy("tipStem"), lines: owner ? [{ text: owner.conversation?.title ?? owner.title }] : [] };
  const of = line.of ?? 0;
  return { title: pendingCopy("tipSourceLine"), lines: owner ? [{ text: pendingCopy("tipLineOf", { title: truncate(owner.title, 48), n: num(of) }) }] : [] };
}

/** The live-region sentence for a hovered or stepped-to item ("Decision: Lock slots…. 3 Nov 2026. Roblox."). */
export function announceText(meta: ItemMeta): string {
  const when = meta.writtenAt ? Date.parse(meta.writtenAt) : Number.NaN;
  const kind = meta.noteKind ? `${cap(valueLabel(meta.noteKind))}: ` : "";
  const date = Number.isFinite(when) ? `${formatShort(when)}. ` : "";
  return `${kind}${truncate(meta.title, 80)}. ${date}${area(meta.space)}.`;
}

/** The bar colour: the renderer's when given, else the item's key colour (area for notes, age for the record). */
export function barColour(meta: ItemMeta, extras: HoverExtras, legend: LegendModel | null, counts: IndexCounts | null, light: boolean): Rgb {
  if (extras.rgb) return extras.rgb;
  const pop = meta.population === "note" ? "notes" : "record";
  const sec = legend?.sections.find((x) => x.population === pop || x.population === "both");
  if (sec && sec.dim === "space") {
    const row = sec.rows.find((r) => r.key === meta.space);
    if (row) return row.rgb;
  }
  if (meta.population === "record" && counts && Number.isFinite(counts.firstT) && counts.lastT > counts.firstT && meta.writtenAt) {
    const tau = (Date.parse(meta.writtenAt) - counts.firstT) / (counts.lastT - counts.firstT);
    return ageColor(Math.max(0, Math.min(1, tau)), light);
  }
  return ageColor(undefined, light);
}

/** Top-left of the card: pointer + 16, flipped to the other side near the visible stage's edges. */
export function tooltipPosition(x: number, y: number, w: number, h: number, stageW: number, stageH: number): { left: number; top: number } {
  const o = SHELL.geometry.tooltip.offset;
  let left = x + o;
  let top = y + o;
  if (left + w > stageW - 4) left = Math.max(4, x - o - w);
  if (top + h > stageH - 4) top = Math.max(4, y - o - h);
  return { left, top };
}

export function safeMeta(s: CortexServices, ordinal: number): ItemMeta | undefined {
  try {
    return s.index.meta(ordinal);
  } catch {
    return undefined;
  }
}

export function Tooltip(): JSX.Element | null {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const ref = useRef<HTMLDivElement>(null);
  const hover = leaf.store.slices.hover.value as (HoverState & HoverExtras) | null;
  const ui = leaf.store.slices.ui.value;
  const view = leaf.store.slices.view.value;
  const lineMode = s.device.value.tooltipStyle !== "card";
  const stage = stageBox(shell.size.value, ui);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !hover) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    const pos = tooltipPosition(hover.x, hover.y, r.width, r.height, stage.width, stage.height);
    el.style.left = `${pos.left}px`;
    el.style.top = `${pos.top}px`;
  });
  if (!hover) return null;
  const meta = safeMeta(s, hover.ordinal);
  let model: TooltipModel | null = null;
  if (hover.line) model = lineModel(hover.line, safeMeta(s, hover.line.owner));
  else if (meta) model = tooltipModel(meta, tooltipDim(view.shape, view.morph, view.groupBy, view.chart, leaf.store.slices.legend.value, meta.population));
  if (!model) return null;
  const light = !shell.obsidianDark.value;
  const bar = meta ? barColour(meta, hover, leaf.store.slices.legend.value, indexCounts(s), light) : ([1, 1, 1] as Rgb);
  const g = SHELL.geometry.tooltip;
  const pos = tooltipPosition(hover.x, hover.y, lineMode ? LINE_TOOLTIP.maxW : g.maxW, lineMode ? LINE_TOOLTIP.estH : g.estH, stage.width, stage.height);
  if (lineMode) {
    // One line, no dwell: it is placed with the pointer's own report and clipped with an ellipsis at 420 px.
    return (
      <div ref={ref} class="cx-tooltip is-line" role="tooltip" style={{ left: `${pos.left}px`, top: `${pos.top}px` }}>
        <span class="cx-tooltip-bar" style={{ background: rgbCss(bar) }} aria-hidden="true" />
        <span class="cx-tooltip-text">{lineText(model)}</span>
      </div>
    );
  }
  return (
    <div ref={ref} class="cx-tooltip" role="tooltip" style={{ left: `${pos.left}px`, top: `${pos.top}px` }}>
      <span class="cx-tooltip-bar" style={{ background: rgbCss(bar) }} aria-hidden="true" />
      <div class="cx-tooltip-title">{model.title}</div>
      {model.lines.map((l, i) => (
        <div key={i} class={`cx-tooltip-line${l.mono ? " is-mono" : ""}`}>
          {l.text}
        </div>
      ))}
      {model.hint ? <div class="cx-tooltip-hint">{model.hint}</div> : null}
    </div>
  );
}
