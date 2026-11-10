/**
 * What every chart gets on top of its own layout, added by `ChartBuilder.finish`:
 *  - Counts: the count in each cell, bar or group (the chart's marks) when the Counts option is on. A count is a
 *    label that shows from 18 px on screen (`ChartRef.zoom`), so a zoomed-out chart stays clean.
 *  - Semantic zoom: for the busiest cells, the titles of their biggest members, placed at the particles' own spots and
 *    shown only once the cell is ≈ 120 px across (`GIVE_WAY` × 120 px = 18 px). The cell's count then gives way
 *    (`ChartRef.zoomMax`), so zooming in turns "42" into the notes themselves. Always on; the limits keep the label
 *    count small (`MEMBER_LABEL_CAP`), so a very dense chart labels its busiest cells only; the overlay names the
 *    other cells once the view is zoomed in on them (`ArrangementResult.zoomMembers` carries their members).
 *  - Links: a thin line for each link between two notes that the chart places (Links option), thinned evenly past
 *    `LINK_CAP` lines.
 * Type-only imports from ./common: common calls this, so a value import would be circular.
 */
import { countsOn, linksOn } from "../../shared/chartOptions";
import { GIVE_WAY, MEMBER_LABEL_MAX, MEMBERS_PER_CELL, memberLabelText } from "../../shared/chartZoom";
import type { ChartBuilder, ChartRef } from "./common";

export { GIVE_WAY, MEMBER_LABEL_MAX, MEMBERS_PER_CELL };

export const COUNT_LABEL_CAP = 1000;
export const MEMBER_LABEL_CAP = 400;
/** Members handed to the overlay for the cells left unnamed (the busiest cells first). */
export const ZOOM_MEMBER_CAP = 20000;
export const LINK_CAP = 1500;

const countFmt = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });

interface MarkBox {
  index: number;
  count: number;
  /** The cell's smaller side in world units (width over 2.2 so "1,234" fits, height as is). */
  fit: number;
  /** The cell's own size for the member threshold. */
  side: number;
  cx: number;
  cy: number;
  cz: number;
}

function markBoxes(b: ChartBuilder): MarkBox[] {
  const out: MarkBox[] = [];
  b.marks.forEach((m, index) => {
    const w = m.bounds.max[0] - m.bounds.min[0];
    const h = m.bounds.max[1] - m.bounds.min[1];
    if (!(m.count > 0) || !(w > 1e-4) || !(h > 1e-4)) return;
    out.push({ index, count: m.count, fit: Math.min(w / 2.2, h), side: Math.min(w, h), cx: (m.bounds.min[0] + m.bounds.max[0]) / 2, cy: (m.bounds.min[1] + m.bounds.max[1]) / 2, cz: m.bounds.max[2] + 0.02 });
  });
  return out;
}

/** Member ordinals per mark index (the marks the layout filled its particles into), at most `MEMBERS_PER_CELL` each, biggest first. */
export function membersByMark(b: ChartBuilder): Map<number, number[]> {
  const all = new Map<number, number[]>();
  const members = b.p.members;
  for (let i = 0; i < members.length; i++) {
    const o = members[i]!;
    const m = b.markOf[o]!;
    if (m < 0 || Number.isNaN(b.arr[o * 3]!)) continue;
    const list = all.get(m);
    if (list) list.push(o);
    else all.set(m, [o]);
  }
  const words = b.p.index.cols.words;
  for (const [m, list] of all) {
    if (list.length > MEMBERS_PER_CELL) {
      list.sort((a, c) => words[c]! - words[a]! || a - c);
      all.set(m, list.slice(0, MEMBERS_PER_CELL));
    }
  }
  return all;
}

function memberLabels(b: ChartBuilder, boxes: readonly MarkBox[]): Set<number> {
  const labelled = new Set<number>();
  const byMark = membersByMark(b);
  if (byMark.size === 0) return labelled;
  const titles = b.p.index.titles;
  let budget = MEMBER_LABEL_CAP;
  const order = boxes.filter((m) => byMark.has(m.index)).sort((a, c) => c.count - a.count || a.index - c.index);
  for (const box of order) {
    if (budget <= 0) break;
    const zoom = box.side * GIVE_WAY;
    let any = false;
    for (const o of byMark.get(box.index)!) {
      if (budget <= 0) break;
      const text = memberLabelText(titles.get(o));
      if (text === "") continue;
      b.label([b.arr[o * 3]! + 0.02, b.arr[o * 3 + 1]!, b.arr[o * 3 + 2]! + 0.04], text, "muted", "left", { zoom });
      budget -= 1;
      any = true;
    }
    if (any) labelled.add(box.index);
  }
  // The cells left unnamed (the budget ran out): hand their members to the overlay, which names them once zoomed in.
  let spare = ZOOM_MEMBER_CAP;
  for (const box of order) {
    if (labelled.has(box.index)) continue;
    const members = byMark.get(box.index)!;
    if (members.length > spare) break;
    spare -= members.length;
    b.zoomMembers.push({ mark: box.index, members });
  }
  return labelled;
}

function cellCounts(b: ChartBuilder, boxes: readonly MarkBox[], labelled: ReadonlySet<number>): void {
  const order = boxes.slice().sort((a, c) => c.count - a.count || a.index - c.index).slice(0, COUNT_LABEL_CAP);
  for (const box of order) {
    const ref: ChartRef = { zoom: box.fit, cell: box.index };
    if (labelled.has(box.index)) ref.zoomMax = box.side * GIVE_WAY;
    b.label([box.cx, box.cy, box.cz], countFmt.format(Math.round(box.count)), "muted", "center", ref);
  }
}

/** Lines between the placed notes that link to each other (each pair once), evenly thinned past `LINK_CAP`. */
export function linkLines(b: ChartBuilder): number {
  const { offsets, targets } = b.p.index.rel.noteLinks;
  const n = b.p.index.count;
  if (offsets.length < n + 1) return 0;
  const arr = b.arr;
  const members = b.p.members;
  const wanted = (o: number, t: number) => t > o && t < n && !Number.isNaN(arr[t * 3]!);
  let total = 0;
  for (let i = 0; i < members.length; i++) {
    const o = members[i]!;
    if (Number.isNaN(arr[o * 3]!)) continue;
    for (let k = offsets[o]!; k < offsets[o + 1]!; k++) if (wanted(o, targets[k]!)) total += 1;
  }
  if (total === 0) return 0;
  const stride = Math.max(1, Math.ceil(total / LINK_CAP));
  let seen = 0;
  let drawn = 0;
  for (let i = 0; i < members.length; i++) {
    const o = members[i]!;
    if (Number.isNaN(arr[o * 3]!)) continue;
    for (let k = offsets[o]!; k < offsets[o + 1]!; k++) {
      const t = targets[k]!;
      if (!wanted(o, t)) continue;
      const take = seen % stride === 0;
      seen += 1;
      if (!take) continue;
      const a: [number, number, number] = [arr[o * 3]!, arr[o * 3 + 1]!, arr[o * 3 + 2]!];
      const c: [number, number, number] = [arr[t * 3]!, arr[t * 3 + 1]!, arr[t * 3 + 2]!];
      if (Math.abs(a[0] - c[0]) + Math.abs(a[1] - c[1]) + Math.abs(a[2] - c[2]) < 1e-4) continue;
      b.line(a, c, 0.22);
      drawn += 1;
    }
  }
  return drawn;
}

export function addAnnotations(b: ChartBuilder): void {
  const spec = b.p.spec;
  const boxes = markBoxes(b);
  const labelled = memberLabels(b, boxes);
  if (!b.ownCounts && countsOn(spec.chart, spec.options)) cellCounts(b, boxes, labelled);
  if (linksOn(spec.chart, spec.options)) linkLines(b);
}
