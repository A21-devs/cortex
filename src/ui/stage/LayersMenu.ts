/**
 * The key bar's "Layers" checklist menu (ORIG-13; CORTEX-UX §5.3): Notes · Vault notes · Reference material
 * ("‹n› hidden" at the right) · Maps (P1) · Record · Undated cloud · Ask history (P1; its count only in the
 * row's tooltip, "‹n› Ask exchanges") · Subagent traffic and Automated sessions (only when imported) · separator ·
 * Anatomy haze. Defaults: all on except Reference material, Ask history, Subagent traffic and Automated sessions.
 * Per view; each starts from the global setting (M12). Owner: E11.
 */
import type { CortexServices, LeafServices } from "../../plugin/services";
import { featureOn } from "../../shared/features";
import { setLayer, setLook } from "../../state/actions";
import type { CortexStore } from "../../state/store";
import { OUTLINE_RANGE, type Layers } from "../../state/types";
import { indexCounts, num, type IndexCounts } from "../context";
import { t } from "../copy";
import { showMenu, type MenuItemSpec } from "../primitives/menu";

export const LAYER_ORDER: readonly (keyof Layers)[] = ["notes", "vaultNotes", "reference", "maps", "record", "undatedCloud", "askHistory", "subagents", "automated", "haze"];

const LABEL: Record<keyof Layers, "layers.notes" | "layers.vaultNotes" | "layers.reference" | "layers.maps" | "layers.record" | "layers.undatedCloud" | "layers.askHistory" | "layers.subagents" | "layers.automated" | "layers.haze"> = {
  notes: "layers.notes",
  vaultNotes: "layers.vaultNotes",
  reference: "layers.reference",
  maps: "layers.maps",
  record: "layers.record",
  undatedCloud: "layers.undatedCloud",
  askHistory: "layers.askHistory",
  subagents: "layers.subagents",
  automated: "layers.automated",
  haze: "layers.haze",
};

/** Whether a layer is offered: phase-gated layers, and imported-only traffic that exists (or is on). */
export function layerOffered(k: keyof Layers, layers: Layers, counts: IndexCounts | null): boolean {
  if (k === "maps") return featureOn("maps");
  if (k === "askHistory") return featureOn("ask");
  if (k === "subagents") return layers.subagents || (counts?.subagents ?? 0) > 0;
  if (k === "automated") return layers.automated || (counts?.automated ?? 0) > 0;
  return true;
}

export function layerItems(layers: Layers, counts: IndexCounts | null = null): MenuItemSpec<keyof Layers>[] {
  return LAYER_ORDER.filter((k) => layerOffered(k, layers, counts)).map((k) => ({
    value: k,
    label: t(LABEL[k]),
    checked: layers[k],
    group: k === "haze" ? "haze" : "data",
    detail: k === "reference" && !layers.reference && counts && counts.reference > 0 ? t("layers.hiddenCount", { n: num(counts.reference) }) : undefined,
  }));
}

/** The Ask history row's tooltip ("‹n› Ask exchanges"). */
export function askHistoryTip(counts: IndexCounts | null): string | null {
  return counts && counts.askHistory > 0 ? t("layers.askTip", { n: num(counts.askHistory) }) : null;
}

/** The Brain outline slider (Display > Points): 0 puts the anatomy haze layer off, anything above it puts it on. */
export function setBrainOutline(store: CortexStore, outline: number): void {
  const o = Number.isFinite(outline) ? Math.max(OUTLINE_RANGE[0], Math.min(OUTLINE_RANGE[1], Math.round(outline * 100) / 100)) : 1;
  store.batch(() => {
    setLook(store, { outline: o });
    setLayer(store, "haze", o > 0);
  });
}

/** The Anatomy haze row: turning it on while the outline sits at 0 brings the outline back to 100%. */
export function setHazeLayer(store: CortexStore, on: boolean): void {
  const outline = store.get("view").look.outline;
  if (on && outline <= 0) setBrainOutline(store, 1);
  else setLayer(store, "haze", on);
}

export function openLayersMenu(s: CortexServices, leaf: LeafServices, anchor: HTMLElement): void {
  const layers = leaf.store.get("view").layers;
  const counts = indexCounts(s);
  const menu = showMenu(layerItems(layers, counts), anchor, (k) => (k === "haze" ? setHazeLayer(leaf.store, !layers[k]) : setLayer(leaf.store, k, !layers[k])));
  const tip = askHistoryTip(counts);
  if (tip) {
    // Native menus have no tooltips API; the row's element carries a title where Obsidian exposes it.
    const items = (menu as unknown as { items?: { dom?: HTMLElement; titleEl?: HTMLElement }[] }).items ?? [];
    const row = items.find((i) => i.titleEl?.textContent === t("layers.askHistory"));
    row?.dom?.setAttribute("title", tip);
  }
}
