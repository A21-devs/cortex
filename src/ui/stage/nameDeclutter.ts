/**
 * Screen-space declutter for the names the Groups shape and the Body's regions print over the figure. Pure: the
 * overlay measures each name, projects its anchor, and asks for a verdict per name. Names are placed by priority
 * (wins first, then the bigger group); a name that would overprint one already placed tries a nudge of one line up,
 * then one line down; if it still collides it stays hidden until the pointer comes near its sphere or it is
 * hovered, traced or previewed (a win).
 */

export interface NameBox {
  key: string;
  /** Projected anchor (CSS px) and the name's measured size. */
  x: number;
  y: number;
  w: number;
  h: number;
  align: "left" | "center" | "right";
  /** Bigger first: the group's entry count. Ties break by key. */
  weight: number;
  /** Hovered, selected, traced or pinned: always shown, placed before everything else. */
  wins?: boolean;
  /** Axis text and boxed years: always shown (placed with the wins, never hidden). */
  fixed?: boolean;
  /** Traced, previewed or otherwise lit: "What is lit" names it. */
  lit?: boolean;
  /** Under the pointer or near it: "Hovered only" names it. */
  hovered?: boolean;
}

/** Names for: every group, only what is lit, or only what is hovered (mirrors state/types NamesFor). */
export type NamesForMode = "everything" | "lit" | "hovered";
/** Density: Auto (declutter), Few (the largest dozen), All (every name, none hidden). */
export type NamesDensityMode = "auto" | "few" | "all";

/** Names printed at most for each density (Auto leaves the overlay's own cap). */
export const FEW_NAMES = 12;
export function densityCap(density: NamesDensityMode, autoCap: number): number {
  return density === "few" ? Math.min(FEW_NAMES, autoCap) : density === "all" ? Number.POSITIVE_INFINITY : autoCap;
}

/**
 * The names to place for a "Names for" choice. Everything keeps all; What is lit keeps the lit ones (and the
 * hovered, wins and fixed ones so a pointed-at name still shows); Hovered only keeps the hovered ones. Fixed names
 * (axis text, boxed years) always stay. Re-run whenever the lit set changes.
 */
export function namesForFilter<T extends NameBox>(boxes: readonly T[], namesFor: NamesForMode): T[] {
  if (namesFor === "everything") return [...boxes];
  return boxes.filter((b) => b.fixed || b.hovered || (namesFor === "lit" && (b.lit || b.wins)));
}

/** The keys of the boxes that are lit, from the groups the highlights name (traced or previewed `pk`s). */
export function litKeys(boxes: readonly (Pick<NameBox, "key"> & { pk?: string | null })[], litPks: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const b of boxes) if (b.pk && litPks.has(b.pk)) out.add(b.key);
  return out;
}

export interface NamePlacement {
  /** Vertical nudge in px (0, -line or +line) and whether the name stays hidden. */
  dy: number;
  hidden: boolean;
}

/** Gap kept between two names, in px. */
export const NAME_GAP_PX = 2;

/** The name's rectangle at its anchor, shifted by dy. */
export function nameRect(b: Pick<NameBox, "x" | "y" | "w" | "h" | "align">, dy = 0): { x0: number; y0: number; x1: number; y1: number } {
  const x0 = b.align === "left" ? b.x : b.align === "right" ? b.x - b.w : b.x - b.w / 2;
  const y0 = b.y - b.h / 2 + dy;
  return { x0, y0, x1: x0 + b.w, y1: y0 + b.h };
}

function hits(a: { x0: number; y0: number; x1: number; y1: number }, b: { x0: number; y0: number; x1: number; y1: number }, gap: number): boolean {
  return a.x0 < b.x1 + gap && b.x0 < a.x1 + gap && a.y0 < b.y1 + gap && b.y0 < a.y1 + gap;
}

/**
 * Verdicts by key. Deterministic for the same input. `line` is the nudge step (the name's line height by default,
 * taken per name).
 */
export function declutterNames(boxes: readonly NameBox[], gap: number = NAME_GAP_PX, showAll = false): Map<string, NamePlacement> {
  const order = [...boxes].sort((a, b) => Number(!!b.wins) - Number(!!a.wins) || Number(!!b.fixed) - Number(!!a.fixed) || b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const out = new Map<string, NamePlacement>();
  for (const b of order) {
    const line = b.h + gap;
    const mustShow = showAll || !!b.wins || !!b.fixed;
    let verdict: NamePlacement | null = null;
    for (const dy of [0, -line, line]) {
      const r = nameRect(b, dy);
      if (!placed.some((p) => hits(r, p, gap))) {
        verdict = { dy, hidden: false };
        placed.push(r);
        break;
      }
    }
    if (!verdict) {
      if (mustShow) {
        verdict = { dy: 0, hidden: false };
        placed.push(nameRect(b, 0));
      } else verdict = { dy: 0, hidden: true };
    }
    out.set(b.key, verdict);
  }
  return out;
}

/**
 * The hidden name whose anchor is nearest the pointer within `reach` px, or null: pointing at a sphere brings its
 * name back.
 */
export function nameNearPointer(boxes: readonly Pick<NameBox, "key" | "x" | "y">[], placements: ReadonlyMap<string, NamePlacement>, px: number, py: number, reach: number): string | null {
  let best: string | null = null;
  let bestD = reach;
  for (const b of boxes) {
    if (!placements.get(b.key)?.hidden) continue;
    const d = Math.hypot(b.x - px, b.y - py);
    if (d <= bestD) {
      bestD = d;
      best = b.key;
    }
  }
  return best;
}
