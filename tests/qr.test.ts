/**
 * The QR encoder: sizes by version, the fixed patterns, the format information (BCH-checked, both copies), capacity limits, a
 * pinned module hash that catches any change in output, and the SVG. The codes were also decoded with an independent reader
 * (OpenCV's QR detector) for every version 1 to 6 while the encoder was written; that run needs Python and is not part of
 * the test suite.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { qrCapacity, qrMatrix, qrSvg } from "../src/shared/qr";

const text = (n: number): string => "q".repeat(n);

function formatBits(m: boolean[][], copy: 1 | 2): number {
  const n = m.length;
  const at = (x: number, y: number): number => ((m[y] as boolean[])[x] ? 1 : 0);
  let v = 0;
  if (copy === 1) {
    for (let i = 0; i <= 5; i++) v |= at(8, i) << i;
    v |= at(8, 7) << 6;
    v |= at(8, 8) << 7;
    v |= at(7, 8) << 8;
    for (let i = 9; i < 15; i++) v |= at(14 - i, 8) << i;
  } else {
    for (let i = 0; i < 8; i++) v |= at(n - 1 - i, 8) << i;
    for (let i = 8; i < 15; i++) v |= at(8, n - 15 + i) << i;
  }
  return v;
}

/** The mask (0-7) whose level-M format word equals `bits`, or -1. */
function maskOf(bits: number): number {
  for (let mask = 0; mask < 8; mask++) {
    let rem = mask;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    if ((((mask << 10) | rem) ^ 0x5412) === bits) return mask;
  }
  return -1;
}

describe("the QR encoder", () => {
  it("picks the smallest version: 21, 25, 29, 33, 37 and 41 modules", () => {
    const sizes = [1, 14, 15, 26, 27, 42, 43, 62, 63, 84, 85, 106].map((n) => (qrMatrix(text(n)) as boolean[][]).length);
    expect(sizes).toEqual([21, 21, 25, 25, 29, 29, 33, 33, 37, 37, 41, 41]);
  });

  it("capacity is 14, 26, 42, 62, 84 and 106 bytes for versions 1 to 6; longer text does not fit", () => {
    expect([1, 2, 3, 4, 5, 6].map(qrCapacity)).toEqual([14, 26, 42, 62, 84, 106]);
    expect(qrMatrix(text(107))).toBeNull();
    expect(qrCapacity(7)).toBe(0);
  });

  it("has the three finder patterns, the timing lines and the dark module", () => {
    const m = qrMatrix("CXS1:test") as boolean[][];
    const n = m.length;
    const finder = (x0: number, y0: number): boolean => {
      for (let dy = 0; dy < 7; dy++)
        for (let dx = 0; dx < 7; dx++) {
          const edge = dx === 0 || dx === 6 || dy === 0 || dy === 6;
          const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
          if ((m[y0 + dy] as boolean[])[x0 + dx] !== (edge || core)) return false;
        }
      return true;
    };
    expect(finder(0, 0) && finder(n - 7, 0) && finder(0, n - 7)).toBe(true);
    for (let i = 8; i < n - 8; i++) {
      expect((m[6] as boolean[])[i]).toBe(i % 2 === 0);
      expect((m[i] as boolean[])[6]).toBe(i % 2 === 0);
    }
    expect((m[n - 8] as boolean[])[8]).toBe(true);
  });

  it("writes valid, equal format information twice, and the alignment pattern from version 2", () => {
    for (const len of [5, 20, 40, 60, 80, 100]) {
      const m = qrMatrix(text(len)) as boolean[][];
      const a = formatBits(m, 1);
      const b = formatBits(m, 2);
      expect(a).toBe(b);
      expect(maskOf(a)).toBeGreaterThanOrEqual(0);
      if (m.length >= 25) {
        const c = m.length - 7;
        expect((m[c] as boolean[])[c]).toBe(true);
        expect((m[c - 1] as boolean[])[c]).toBe(false);
        expect((m[c - 2] as boolean[])[c]).toBe(true);
      }
    }
  });

  it("is deterministic, and its output is pinned for a share-sized text", () => {
    const t = "CXS1:AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKA";
    const a = qrMatrix(t) as boolean[][];
    expect(JSON.stringify(a)).toBe(JSON.stringify(qrMatrix(t)));
    expect(a.length).toBe(33);
    const bits = a.map((row) => row.map((d) => (d ? "1" : "0")).join("")).join("\n");
    expect(createHash("sha256").update(bits).digest("hex").slice(0, 16)).toBe("f1a09ead5dae644b");
  });

  it("draws an SVG with a quiet zone, an accessible name and no script", () => {
    const m = qrMatrix("hello") as boolean[][];
    const svg = qrSvg(m, { title: "A <code>", px: 100 });
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${m.length + 8} ${m.length + 8}"`);
    expect(svg).toContain("<title>A &lt;code></title>");
    expect(svg).not.toMatch(/<script|onload|href=/i);
  });
});
