import { describe, expect, it } from "vitest";
import { rowBottoms, snapClipHeight } from "../src/ui/stage/snapClip";

type Node = { classes: string[]; top: number; height: number; kids: Node[] };
const el = (classes: string, top: number, height: number, kids: Node[] = []): Node => ({ classes: classes.split(" "), top, height, kids });
type Wrapped = { children: Wrapped[]; classList: { contains(c: string): boolean }; getBoundingClientRect(): { bottom: number; height: number } };
const wrap = (n: Node): Wrapped => ({
  children: n.kids.map(wrap),
  classList: { contains: (c: string) => n.classes.includes(c) },
  getBoundingClientRect: () => ({ bottom: n.top + n.height, height: n.height }),
});

describe("snapClipHeight", () => {
  it("cuts at the last row that fits whole", () => {
    expect(snapClipHeight([24, 50, 76, 102], 90)).toBe(76);
    expect(snapClipHeight([24, 50, 76, 102], 102)).toBeNull();
    expect(snapClipHeight([24, 50, 76, 102], 500)).toBeNull();
  });
  it("leaves the area alone when no row ends within reach", () => {
    expect(snapClipHeight([200, 230], 100)).toBeNull();
    expect(snapClipHeight([], 100)).toBeNull();
  });
  it("is stable: a clip at a row bottom is its own fixed point", () => {
    const rows = [28, 56, 84, 112, 140];
    const h = snapClipHeight(rows, 120) as number;
    expect(h).toBe(112);
    expect(snapClipHeight(rows, h)).toBe(112);
  });
});

describe("rowBottoms", () => {
  it("looks through Fade and Reflow wrappers and skips section labels, and reports bottoms relative to the content's top", () => {
    const body = el("cx-popover-body", 100, 200, [
      el("cx-section-label", 100, 20),
      el("cx-fade is-in", 122, 100, [el("cx-row", 122, 24), el("cx-fade is-in", 150, 60, [el("cx-row", 150, 28), el("cx-display-tools", 180, 28)])]),
      el("cx-hidden", 300, 0),
    ]);
    const root = el("cx-reflow", 100, 200, [el("cx-reflow-inner", 100, 200, [body])]);
    expect(rowBottoms(wrap(root), 100)).toEqual([46, 78, 108]);
  });
});
