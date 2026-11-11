import { describe, expect, it } from "vitest";
import { desktopGround, hexToLinear, stageColours } from "../src/shared/palette";

describe("stage ground", () => {
  it("converts hex to linear light (0..1), not by rounding the 0..1 channels", () => {
    expect(hexToLinear("#000000")).toEqual([0, 0, 0]);
    expect(hexToLinear("#ffffff")).toEqual([1, 1, 1]);
    const [r, g, b] = hexToLinear("#10203f");
    expect(r).toBeGreaterThan(0.004);
    expect(g).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
    expect(hexToLinear("#f4f2ee")[0]).toBeGreaterThan(0.85);
  });

  it("Cortex Desktop keeps Ink black and lays a window theme flat in its lift colour", () => {
    expect(desktopGround("ink", "ink")).toMatchObject({ stage: "#000000", lift: "#000000" });
    expect(desktopGround("follow", "ink")).toMatchObject({ stage: "#000000", lift: "#000000" });
    const cobalt = stageColours("cobalt", "ink");
    expect(desktopGround("cobalt", "ink")).toMatchObject({ stage: cobalt.lift, lift: cobalt.lift });
    expect(desktopGround("garnet", "ink").stage).toBe(stageColours("garnet", "ink").lift);
    expect(desktopGround("cobalt", "paper")).toEqual(stageColours("cobalt", "paper"));
  });
});
