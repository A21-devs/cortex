/**
 * Comet streaks inside the treemap's boxes (CHART-20): short bright heads with fading tails that move within each
 * box, more of them in boxes that hold more. Pure model and drawing; `ChartComets.tsx` runs it on the chart overlay's
 * canvas, only while a treemap is shown and visible, and not at all under reduced motion.
 */

/** A box on screen (px) with the number of entries inside. */
export interface CometBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  count: number;
}

export interface Comet {
  box: number;
  /** Head position, px. */
  x: number;
  y: number;
  /** Direction (radians) and speed (px per second). */
  angle: number;
  speed: number;
  /** Tail length, px. */
  tail: number;
}

/** Boxes narrower than this (px) get no streaks. */
export const COMET_MIN_BOX = 28;
/** Most streaks in one box and on the whole chart. */
export const COMET_PER_BOX_MAX = 6;
export const COMET_TOTAL_MAX = 150;

/** A seeded generator (mulberry32): the same boxes always get the same first streaks. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Streaks a box of this size and count gets: none for an empty or tiny box, up to six for a big, full one. */
export function cometsForBox(count: number, w: number, h: number): number {
  if (!(count > 0) || w < COMET_MIN_BOX || h < COMET_MIN_BOX) return 0;
  const room = Math.min(1, Math.sqrt(w * h) / 120);
  return Math.max(1, Math.min(COMET_PER_BOX_MAX, Math.floor(1 + (Math.log2(1 + count) / 3) * room)));
}

/** Streaks per box, within the chart's total: the fullest boxes keep theirs when the budget runs out. */
export function planComets(boxes: readonly CometBox[], total = COMET_TOTAL_MAX): number[] {
  const want = boxes.map((b) => cometsForBox(b.count, b.x1 - b.x0, b.y1 - b.y0));
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[b]!.count - boxes[a]!.count || a - b);
  const out = new Array<number>(boxes.length).fill(0);
  let left = total;
  for (const i of order) {
    const n = Math.min(want[i]!, left);
    out[i] = n;
    left -= n;
    if (left <= 0) break;
  }
  return out;
}

/** A new streak entering a box from a random edge, heading inward (or anywhere inside when `anywhere`). */
export function spawnComet(boxIndex: number, box: CometBox, rand: () => number, anywhere = false): Comet {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const angle = rand() * Math.PI * 2;
  const speed = 40 + rand() * 60;
  const tail = Math.max(10, Math.min(46, Math.min(w, h) * (0.25 + rand() * 0.25)));
  let x = box.x0 + rand() * w;
  let y = box.y0 + rand() * h;
  if (!anywhere) {
    // Start on the edge the heading comes from.
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    if (Math.abs(dx) * h >= Math.abs(dy) * w) x = dx > 0 ? box.x0 : box.x1;
    else y = dy > 0 ? box.y0 : box.y1;
  }
  return { box: boxIndex, x, y, angle, speed, tail };
}

/** The streaks for a set of boxes, scattered through them. */
export function makeComets(boxes: readonly CometBox[], seed = 1): Comet[] {
  const rand = rng(seed);
  const plan = planComets(boxes);
  const out: Comet[] = [];
  boxes.forEach((b, i) => {
    for (let k = 0; k < plan[i]!; k++) out.push(spawnComet(i, b, rand, true));
  });
  return out;
}

/** Move a streak along its heading; once its tail has left the box it starts again at an edge. */
export function stepComet(c: Comet, box: CometBox, dt: number, rand: () => number): Comet {
  const x = c.x + Math.cos(c.angle) * c.speed * dt;
  const y = c.y + Math.sin(c.angle) * c.speed * dt;
  const tx = x - Math.cos(c.angle) * c.tail;
  const ty = y - Math.sin(c.angle) * c.tail;
  const outside = (px: number, py: number) => px < box.x0 || px > box.x1 || py < box.y0 || py > box.y1;
  if (outside(x, y) && outside(tx, ty)) return spawnComet(c.box, box, rand);
  return { ...c, x, y };
}

/**
 * Carry streaks over to the same boxes after the camera moved: each keeps its place inside its box. Null when the boxes
 * are no longer the same set (a new arrangement), so the caller makes new ones.
 */
export function refitComets(comets: readonly Comet[], from: readonly CometBox[], to: readonly CometBox[]): Comet[] | null {
  if (from.length !== to.length) return null;
  const out: Comet[] = [];
  for (const c of comets) {
    const a = from[c.box];
    const b = to[c.box];
    if (!a || !b) return null;
    const u = (c.x - a.x0) / Math.max(1e-6, a.x1 - a.x0);
    const v = (c.y - a.y0) / Math.max(1e-6, a.y1 - a.y0);
    out.push({ ...c, x: b.x0 + u * (b.x1 - b.x0), y: b.y0 + v * (b.y1 - b.y0) });
  }
  return out;
}

/** Where the tail ends. */
export function tailEnd(c: Comet): { x: number; y: number } {
  return { x: c.x - Math.cos(c.angle) * c.tail, y: c.y - Math.sin(c.angle) * c.tail };
}

export interface CometInk {
  /** The white-hot head. */
  head: string;
  /** Tail colour as "r, g, b". */
  tail: string;
}

/** Draw every streak, clipped to its own box: a gradient tail fading to nothing and a small bright head. */
export function drawComets(ctx: CanvasRenderingContext2D, comets: readonly Comet[], boxes: readonly CometBox[], ink: CometInk): void {
  ctx.lineCap = "round";
  for (const c of comets) {
    const box = boxes[c.box];
    if (!box) continue;
    const e = tailEnd(c);
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
    ctx.clip();
    const g = ctx.createLinearGradient(c.x, c.y, e.x, e.y);
    g.addColorStop(0, ink.head);
    g.addColorStop(0.2, `rgba(${ink.tail}, 0.85)`);
    g.addColorStop(1, `rgba(${ink.tail}, 0)`);
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(e.x, e.y);
    ctx.stroke();
    ctx.fillStyle = ink.head;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** Screen boxes of the marks that have entries: the treemap's boxes. */
export function boxesFromMarks(marks: readonly { x0: number; y0: number; x1: number; y1: number; count: number }[]): CometBox[] {
  return marks.filter((m) => m.count > 0 && m.x1 > m.x0 && m.y1 > m.y0).map((m) => ({ x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1, count: m.count }));
}
