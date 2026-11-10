/**
 * Global line geometry (M9; CORTEX-UX §6.10, §12.19.7). Owner: E8.
 * Three families, at most 60,000 segments, sampled deterministically when over budget, recomputed after every
 * placement or arrangement change:
 *  - source: from each note to its source entries, a quadratic curve whose control point sits level with the
 *    chord's middle, on the entry's side of the cord, at 2 × w(y) + 0.2 from the cord axis, so the curve passes
 *    outside the torso and never crosses the cord (standing frame; Lying is the same figure rotated);
 *  - stem: consecutive messages of each conversation along its frond;
 *  - spoke: a map to its member notes (straight);
 *  - link: a vault note to a note it links to (straight, faint; at most 4,000, the ones between the best-connected
 *    notes first), drawn under Lines: All.
 * Source lines and spokes for one selection come from `related` (indexOps).
 */
import type { DataIndex } from "../shared/index-format";
import { ItemKind, NONE32, Population } from "../shared/index-format";
import { LINE_FAMILIES, type LinesParams, type LinesResult, type Vec3 } from "../shared/protocol/worker";
import type { Pose } from "../shared/settings";
import { envelopeHalfWidth, FIGURE, poseXYZ, resolvePose, unposeXYZ, zBack } from "./anatomy";
import { unit3 } from "./geom";
import { layerVisible, normaliseVisibility } from "./placement";

export const LINE_BUDGET = FIGURE.lines.budget;

const FAMILY = { source: LINE_FAMILIES.indexOf("source"), stem: LINE_FAMILIES.indexOf("stem"), spoke: LINE_FAMILIES.indexOf("spoke"), link: LINE_FAMILIES.indexOf("link") } as const;

/** Most note-link fibres drawn at once (FIG-62). */
export const LINK_CAP = 4000;

/**
 * The strongest note-to-note links among `drawn` notes: each undirected pair once, ranked by the summed degree of its
 * two ends (ties by ordinal), at most `cap`. Pure over the CSR so it can be tested without an index.
 */
export function strongestLinks(offsets: ArrayLike<number>, targets: ArrayLike<number>, n: number, drawn: (o: number) => boolean, cap: number = LINK_CAP): [number, number][] {
  const deg = (o: number): number => (offsets[o + 1] as number) - (offsets[o] as number);
  const seen = new Set<number>();
  const pairs: { a: number; b: number; score: number }[] = [];
  for (let a = 0; a < n; a++) {
    if (!drawn(a)) continue;
    for (let k = offsets[a] as number; k < (offsets[a + 1] as number); k++) {
      const b = targets[k] as number;
      if (b === a || b < 0 || b >= n || !drawn(b)) continue;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = lo * n + hi;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a: lo, b: hi, score: deg(a) + deg(b) });
    }
  }
  pairs.sort((x, y) => y.score - x.score || x.a - y.a || x.b - y.b);
  return pairs.slice(0, Math.max(0, cap)).map((p) => [p.a, p.b]);
}

/**
 * Control point of a source line from `from` (the entry) to `to` (the note), skeleton frame: level with the chord's
 * middle, on the entry's side of the cord, 2 × w(y) + 0.2 from the cord axis. `fallbackSide` (±1) decides for an
 * entry exactly on the cord.
 */
export function sourceControl(from: Vec3, to: Vec3, fallbackSide: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const y = (from[1] + to[1]) / 2;
  const side = from[0] > 1e-4 ? 1 : from[0] < -1e-4 ? -1 : fallbackSide >= 0 ? 1 : -1;
  out[0] = side * (FIGURE.lines.clearanceFactor * envelopeHalfWidth(y) + FIGURE.lines.clearanceAdd);
  out[1] = y;
  out[2] = zBack(y);
  return out;
}

interface Builder {
  positions: number[];
  t: number[];
  family: number[];
  owner: number[];
  target: number[];
}

/** Candidate links, in skeleton coordinates indices into the view's body positions. */
interface Link {
  family: number;
  owner: number;
  target: number;
  /** The other end of a stem (the previous message); −1 otherwise. */
  from: number;
  /** Segments this link adds when drawn. */
  cost: number;
}

function finite(a: Float32Array, o: number): boolean {
  return Number.isFinite(a[o * 3] as number) && Number.isFinite(a[o * 3 + 1] as number) && Number.isFinite(a[o * 3 + 2] as number);
}

/** Deterministic sample: keep each link with probability `keep`, by a hash of its position in the list. */
function kept(seed: number, i: number, keep: number): boolean {
  return keep >= 1 || unit3(seed, i, 101) < keep;
}

export function computeLines(index: DataIndex, anat: Float32Array, params: LinesParams, pose: Pose = resolvePose(undefined)): LinesResult {
  const n = index.count;
  const vis = normaliseVisibility(params.visibility, n);
  const budget = Math.max(0, Math.min(LINE_BUDGET, Number.isFinite(params.budget) ? Math.floor(params.budget) : LINE_BUDGET));
  const want = new Set(params.families ?? []);
  const c = index.cols;
  const drawn = (o: number): boolean => o < n && layerVisible(index, o, vis) && finite(anat, o);
  const links: Link[] = [];
  if (want.has("source")) {
    const rel = index.rel.noteSources;
    for (let o = 0; o < n; o++) {
      if ((c.pop[o] as number) !== Population.Note || (c.kind[o] as number) === ItemKind.NoteHub || !drawn(o)) continue;
      for (let k = rel.offsets[o] as number; k < (rel.offsets[o + 1] as number); k++) {
        const s = rel.targets[k] as number;
        if (drawn(s)) links.push({ family: FAMILY.source, owner: o, target: s, from: -1, cost: FIGURE.lines.curveSegments });
      }
    }
  }
  if (want.has("stem")) {
    const byConv = new Map<number, number[]>();
    for (let o = 0; o < n; o++) {
      const row = c.conv[o] as number;
      if ((c.pop[o] as number) !== Population.Record || row === NONE32 || (c.idx[o] as number) === NONE32 || !drawn(o)) continue;
      let list = byConv.get(row);
      if (!list) byConv.set(row, (list = []));
      list.push(o);
    }
    for (const [row, list] of byConv) {
      list.sort((a, b) => (c.idx[a] as number) - (c.idx[b] as number) || a - b);
      for (let k = 0; k + 1 < list.length; k++) links.push({ family: FAMILY.stem, owner: row, target: list[k + 1] as number, from: list[k] as number, cost: 1 });
    }
  }
  if (want.has("spoke")) {
    const rel = index.rel.hubMembers;
    for (let h = 0; h < n; h++) {
      if ((c.kind[h] as number) !== ItemKind.NoteHub || !drawn(h)) continue;
      for (let k = rel.offsets[h] as number; k < (rel.offsets[h + 1] as number); k++) {
        const m = rel.targets[k] as number;
        if (m !== h && drawn(m)) links.push({ family: FAMILY.spoke, owner: h, target: m, from: -1, cost: 1 });
      }
    }
  }
  if (want.has("link")) {
    const rel = index.rel.noteLinks;
    const ok = (o: number): boolean => (c.pop[o] as number) === Population.Note && (c.kind[o] as number) !== ItemKind.NoteHub && drawn(o);
    for (const [a, b] of strongestLinks(rel.offsets, rel.targets, n, ok)) links.push({ family: FAMILY.link, owner: a, target: b, from: -1, cost: 1 });
  }
  const total = links.reduce((s, l) => s + l.cost, 0);
  const keep = total <= budget || total === 0 ? 1 : budget / total;
  const b: Builder = { positions: [], t: [], family: [], owner: [], target: [] };
  const a: Vec3 = [0, 0, 0];
  const z: Vec3 = [0, 0, 0];
  const ctrl: Vec3 = [0, 0, 0];
  const out: Vec3 = [0, 0, 0];
  const push = (p: Vec3, q: Vec3, t0: number, t1: number, l: Link): void => {
    poseXYZ(pose, p[0], p[1], p[2], out);
    b.positions.push(out[0], out[1], out[2]);
    poseXYZ(pose, q[0], q[1], q[2], out);
    b.positions.push(out[0], out[1], out[2]);
    b.t.push(t0, t1);
    b.family.push(l.family);
    b.owner.push(l.owner);
    b.target.push(l.target);
  };
  links.forEach((l, i) => {
    if (!kept(index.header.seq + 1, i, keep) || b.family.length + l.cost > budget) return;
    if (l.family === FAMILY.source) {
      // From the source entry (t = 0) to the note (t = 1), in the skeleton frame.
      unposeXYZ(pose, anat[l.target * 3] as number, anat[l.target * 3 + 1] as number, anat[l.target * 3 + 2] as number, a);
      unposeXYZ(pose, anat[l.owner * 3] as number, anat[l.owner * 3 + 1] as number, anat[l.owner * 3 + 2] as number, z);
      sourceControl(a, z, l.target % 2 === 0 ? 1 : -1, ctrl);
      const seg = FIGURE.lines.curveSegments;
      let prev: Vec3 = [a[0], a[1], a[2]];
      for (let s = 1; s <= seg; s++) {
        const u = s / seg;
        const w0 = (1 - u) * (1 - u);
        const w1 = 2 * (1 - u) * u;
        const w2 = u * u;
        const next: Vec3 = [w0 * a[0] + w1 * ctrl[0] + w2 * z[0], w0 * a[1] + w1 * ctrl[1] + w2 * z[1], w0 * a[2] + w1 * ctrl[2] + w2 * z[2]];
        push(prev, next, (s - 1) / seg, u, l);
        prev = next;
      }
    } else if (l.family === FAMILY.stem) {
      const prevOrd = l.from;
      unposeXYZ(pose, anat[prevOrd * 3] as number, anat[prevOrd * 3 + 1] as number, anat[prevOrd * 3 + 2] as number, a);
      unposeXYZ(pose, anat[l.target * 3] as number, anat[l.target * 3 + 1] as number, anat[l.target * 3 + 2] as number, z);
      push(a, z, 0, 1, l);
    } else {
      unposeXYZ(pose, anat[l.owner * 3] as number, anat[l.owner * 3 + 1] as number, anat[l.owner * 3 + 2] as number, a);
      unposeXYZ(pose, anat[l.target * 3] as number, anat[l.target * 3 + 1] as number, anat[l.target * 3 + 2] as number, z);
      push(a, z, 0, 1, l);
    }
  });
  return {
    positions: Float32Array.from(b.positions),
    t: Float32Array.from(b.t),
    family: Uint8Array.from(b.family),
    owner: Uint32Array.from(b.owner),
    target: Uint32Array.from(b.target),
    segments: b.family.length,
  };
}
