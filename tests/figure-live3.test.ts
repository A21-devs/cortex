/**
 * FIGURE pass 3: what a selection draws and names, and the frond length that fills the torso (CORTEX-UX §6.3, §6.9–6.11).
 */
import { describe, expect, it } from "vitest";
import { NONE32, Population } from "../src/shared/index-format";
import { FIGURE } from "../src/worker/anatomy";
import { relatedOp } from "../src/worker/indexOps";
import { frondFraction } from "../src/worker/placement";
import { buildSampleIndex } from "../src/worker/sampleIndex";

describe("selection links (§6.9)", () => {
  const index = buildSampleIndex(7, Date.UTC(2026, 5, 1));
  const anat = new Float32Array(index.count * 3);
  for (let i = 0; i < index.count; i++) anat.set([Math.sin(i) * 2, 4 - (i % 97) * 0.09, Math.cos(i)], i * 3);
  const st = { index, views: new Map([["v", { anat }]]) } as never;

  /** A message of a conversation, where a note cites some other message of the same conversation. */
  function findEntry(): { entry: number; cited: Set<number> } {
    const c = index.cols;
    const byConv = new Map<number, number[]>();
    for (let o = 0; o < index.count; o++) {
      if (c.pop[o] !== Population.Record || c.conv[o] === NONE32) continue;
      const l = byConv.get(c.conv[o] as number) ?? [];
      l.push(o);
      byConv.set(c.conv[o] as number, l);
    }
    const src = index.rel.noteSources;
    for (const members of byConv.values()) {
      const set = new Set(members);
      const notes = new Set<number>();
      for (let n = 0; n < index.count; n++) {
        if (c.pop[n] !== Population.Note) continue;
        for (let k = src.offsets[n] as number; k < (src.offsets[n + 1] as number); k++) if (set.has(src.targets[k] as number)) notes.add(n);
      }
      if (notes.size >= 2) return { entry: members[0] as number, cited: notes };
    }
    throw new Error("the sample has no conversation with notes");
  }

  it("a message of a conversation draws the links of every note built from that conversation", () => {
    const { entry, cited } = findEntry();
    const res = relatedOp({ ordinal: entry }, st, "v");
    expect(new Set(res.citedBy)).toEqual(cited);
    const owners = new Set(Array.from(res.lines.owner.subarray(0, res.lines.segments)));
    for (const n of owners) expect(cited.has(n)).toBe(true);
    expect(owners.size).toBeGreaterThanOrEqual(2);
    expect(res.lines.segments % FIGURE.lines.selectionSegments).toBe(0);
  });

  it("draws far fewer lines than the whole record has", () => {
    const { entry } = findEntry();
    const res = relatedOp({ ordinal: entry }, st, "v");
    expect(res.lines.segments).toBeLessThan(2_000);
  });
});

describe("frond length (§6.3)", () => {
  it("runs past the middle of the nerve even for a short conversation, and the whole nerve for a long one", () => {
    expect(frondFraction(2)).toBeGreaterThan(0.5);
    expect(frondFraction(10)).toBeGreaterThan(0.6);
    expect(frondFraction(500)).toBe(1);
  });
});
