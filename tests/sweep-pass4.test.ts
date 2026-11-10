import { describe, expect, it } from "vitest";
import { layoutLabels } from "../src/ui/stage/LabelLayer";
import { rowName } from "../src/ui/stage/KeyBar";
import type { LegendRow } from "../src/shared/protocol/worker";

describe("label layout never leaves two chips on top of each other (sweep)", () => {
  it("keeps a clear set when many anchors crowd one spot", () => {
    const anchors = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, ordinal: i, x: 300 + (i % 3) * 6, y: 200 + (i % 5) * 3, depth: 0, priority: 30 - i, kind: "Idea", glyph: "*", title: `Reuse the rain barrel next season ${i}`, rgb: [1, 1, 1] as [number, number, number] }));
    const out = layoutLabels(anchors, [], { width: 900, height: 700 }, 30, null);
    expect(out.length).toBeGreaterThan(5);
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!, b = out[j]!;
        const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(hit).toBe(false);
      }
  });
});

describe("legend row names (sweep)", () => {
  const row = (bucket: LegendRow["bucket"], name: string): LegendRow => ({ key: bucket === "none" ? "" : "x", name, slot: 0, bucket, rgb: [0, 0, 0], notes: 1, record: 0, hidden: false, depth: 0, expandable: false });
  it("names the unnamed remainder buckets instead of leaving a bare count", () => {
    expect(rowName(row("none", ""), "space")).toBe("No area");
    expect(rowName(row("other", ""), "space")).toBe("Other");
    expect(rowName(row("value", "Code"), "space")).toBe("Code");
  });
});
