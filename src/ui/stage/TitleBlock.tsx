/**
 * Title block (stage overlay): the page name in bold with a dim "‹n› notes · ‹m› links" line under it, at the stage's
 * top-left below the key bar, with no background. The counts are the loaded index's notes and the links between them
 * (the vault's wiki links, each pair counted once). Hidden in Immersive mode (the Stage does not mount the overlays
 * there), on narrow stages and until an index is loaded. It slips aside while the floating Chart card is open. On Cortex
 * Desktop it sits in the stage's top-left row beside the on-stage search field (StageSearch.tsx). Owner: P16.
 */
import type { JSX } from "preact";
import { ItemFlag, Population, type DataIndex } from "../../shared/index-format";
import type { Breakpoint } from "../../state/types";
import { chartCardAside, sheetFloats, stageBox } from "../breakpoints";
import { countIndex, loadedIndex, num, useLeaf, useServices, useShell } from "../context";
import { t } from "../copy";

/** The block needs this much stage width; narrower stages keep the figure clear. */
export const TITLE_MIN_STAGE_W = 600;

const linkCache = new WeakMap<DataIndex, number>();

/** Links between notes (excluded notes dropped). The relation stores each pair in both directions, so a pair counts once. */
export function linkCount(ix: DataIndex): number {
  const hit = linkCache.get(ix);
  if (hit !== undefined) return hit;
  const { offsets, targets } = ix.rel.noteLinks;
  const { pop, flags } = ix.cols;
  const rows = Math.min(ix.count, Math.max(0, offsets.length - 1));
  let directed = 0;
  for (let row = 0; row < rows; row++) {
    if (pop[row] !== Population.Note || ((flags[row] ?? 0) & ItemFlag.Excluded) !== 0) continue;
    for (let k = offsets[row] as number; k < (offsets[row + 1] as number); k++) {
      const to = targets[k] as number;
      if (to < ix.count && to !== row && pop[to] === Population.Note && ((flags[to] ?? 0) & ItemFlag.Excluded) === 0) directed++;
    }
  }
  const out = Math.round(directed / 2);
  linkCache.set(ix, out);
  return out;
}

/** "1 note" · "691 notes"; "1 link" · "2,086 links". */
export function countsLine(notes: number, links: number): string {
  const n = t(notes === 1 ? "overlays.notesOne" : "overlays.notesMany", { n: num(notes) });
  const l = t(links === 1 ? "overlays.linksOne" : "overlays.linksMany", { n: num(links) });
  return `${n} · ${l}`;
}

/** Whether the block shows on this stage. */
export function titleBlockVisible(bp: Breakpoint, stageWidth: number, immersive: boolean): boolean {
  return !immersive && bp !== "S" && bp !== "Mini" && stageWidth >= TITLE_MIN_STAGE_W;
}

export function TitleBlock(): JSX.Element | null {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const ui = leaf.store.slices.ui.value;
  const width = stageBox(shell.size.value, ui).width;
  if (!titleBlockVisible(ui.breakpoint, width, ui.immersive)) return null;
  const ix = loadedIndex(s);
  if (!ix) return null;
  const counts = countIndex(ix);
  return (
    <div class={`cx-title-block${sheetFloats(ui) || chartCardAside(ui) ? " is-aside" : ""}`} data-cx-overlay="title">
      <h2 class="cx-title-block-name">{t("overlays.pageName")}</h2>
      <p class="cx-title-block-counts">{countsLine(counts.notes, linkCount(ix))}</p>
    </div>
  );
}
