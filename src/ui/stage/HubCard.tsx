/**
 * Hub hover card on the stage (SPEC F9, CORTEX-UX §6.9): while the pointer rests on a map (a hub) the MemberCard lists
 * its kind, its note count and its largest member notes, just under the tooltip. It appears after a short dwell (the
 * same one the renderer waits before lighting the hub's links and sources) and goes the moment the pointer leaves.
 * Owner: E11.
 */
import type { JSX } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type { ItemMeta } from "../../plugin/indexer";
import { hubMemberList } from "../../shared/hoverModel";
import { ItemKind, type DataIndex } from "../../shared/index-format";
import { KIND_STYLE } from "../../shared/palette";
import { setSheetPreview } from "../../state/actions";
import { resolveOrdinal } from "../reader/readerKit";
import { SHELL, stageBox } from "../breakpoints";
import { useLeaf, useServices, useShell } from "../context";
import { t } from "../copy";
import { MEMBER_CARD, MemberCard } from "./MemberCard";
import { safeMeta, tooltipPosition } from "./Tooltip";

/** Dwell before the card shows, ms (matches the renderer's hub dwell). */
export const HUB_CARD_DWELL_MS = 80;

const ROW_H = 22;

export interface HubCardModel {
  kind: string;
  notes: number;
  members: { glyph: string; title: string }[];
}

/** "Project map" / "Area map" / "Topic map" for a hub type. */
export function mapKindWord(mapKind: string | undefined): string {
  return mapKind === "area" ? t("reader.areaMap") : mapKind === "topic" ? t("reader.topicMap") : t("reader.projectMap");
}

/** The card's content for a hub: its kind, its note count and the titles of its largest members (pure over the index). */
export function hubCardModel(meta: (ordinal: number) => ItemMeta | undefined, idx: DataIndex, hub: number): HubCardModel | null {
  const all = hubMemberList(idx, hub);
  if (all.length === 0) return null;
  const members = all.slice(0, MEMBER_CARD.maxRows).flatMap((o) => {
    const m = meta(o);
    if (!m || m.title.trim() === "") return [];
    const glyph = m.noteKind ? ((KIND_STYLE as Record<string, { glyph: string }>)[m.noteKind]?.glyph ?? "") : "";
    return [{ glyph, title: m.title }];
  });
  return { kind: mapKindWord(meta(hub)?.mapKind), notes: all.length, members };
}

/** Card height for a given number of rows (header, rows, "+n more" line, padding). */
export function memberCardHeight(rows: number, more: boolean): number {
  return 20 + 26 + rows * ROW_H + (more ? 22 : 0);
}

/** Top-left of the card: under the tooltip (above it when the tooltip flipped up), kept on the stage. */
export function memberCardPosition(x: number, y: number, stageW: number, stageH: number, rows: number, more: boolean): { left: number; top: number } {
  const g = SHELL.geometry.tooltip;
  const tip = tooltipPosition(x, y, g.maxW, g.estH, stageW, stageH);
  const h = memberCardHeight(rows, more);
  const w = MEMBER_CARD.width;
  const top = tip.top >= y ? tip.top + g.estH + 8 : tip.top - h - 8;
  return { left: Math.max(4, Math.min(tip.left, stageW - w - 4)), top: Math.max(4, Math.min(top, stageH - h - 4)) };
}

function useDwell(value: number | null, ms: number): number | null {
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (value === null) {
      setShown(null);
      return undefined;
    }
    const id = setTimeout(() => setShown(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return shown;
}

/**
 * The ordinal of the map the sheet has open (a map reader on top of an open sheet), or -1. While one is open, hovering
 * ANOTHER map on the stage shows that map in the sheet (a preview that never touches the stack).
 */
export function openMapOrdinal(s: Parameters<typeof resolveOrdinal>[0], ui: { sheet: { open: boolean; stack: readonly { kind: string; route?: string; id?: string }[]; index: number; collapsed?: boolean } }, index: DataIndex | null): number {
  const top = ui.sheet.open && !ui.sheet.collapsed ? ui.sheet.stack[ui.sheet.index] : undefined;
  if (!top || top.kind !== "reader" || top.route !== "map" || !top.id) return -1;
  return resolveOrdinal(s, top.id, index);
}

/** The preview the sheet should show for a hovered map (after the dwell): another map than the open one, else none. */
export function previewForHover(openMap: number, shownHub: number | null): { kind: "map"; ordinal: number } | null {
  return openMap >= 0 && shownHub !== null && shownHub !== openMap ? { kind: "map", ordinal: shownHub } : null;
}

export function HubCard(): JSX.Element | null {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const hover = leaf.store.slices.hover.value;
  const ui = leaf.store.slices.ui.value;
  const idx = s.index.index.value;
  const hub = hover && idx && hover.ordinal < idx.count && idx.cols.kind[hover.ordinal] === ItemKind.NoteHub ? hover.ordinal : null;
  const shown = useDwell(hub, HUB_CARD_DWELL_MS);
  // READ-27: with a map open in the sheet, resting on another map previews it there; leaving restores the open one.
  const openMap = openMapOrdinal(s, ui, idx);
  const preview = previewForHover(openMap, shown !== null && hub === shown ? shown : null);
  useEffect(() => {
    setSheetPreview(leaf.store, preview);
  }, [leaf, preview?.ordinal ?? -1]);
  useEffect(() => () => setSheetPreview(leaf.store, null), [leaf]);
  const model = useMemo(() => (shown !== null && idx ? hubCardModel((o) => safeMeta(s, o), idx, shown) : null), [s, idx, shown]);
  if (!hover || hub === null || shown !== hub || !model || ui.breakpoint === "Mini") return null;
  const stage = stageBox(shell.size.value, ui);
  const rows = Math.min(model.members.length, MEMBER_CARD.maxRows);
  const pos = memberCardPosition(hover.x, hover.y, stage.width, stage.height, rows, model.notes > rows);
  return <MemberCard kind={model.kind} notes={model.notes} total={model.notes} members={model.members} x={pos.left} y={pos.top} />;
}
