/**
 * The key's dimension menu previews a dimension while it is pointed at (FIG-36): openDimMenu hands the menu a
 * hover callback that reports a dimension (never a basis switch or option) and clears on leave and on close.
 */
import { describe, expect, it, vi } from "vitest";
import type { ShowMenuOptions } from "../src/ui/primitives/menu";

const captured: { opts: ShowMenuOptions<string> | undefined } = { opts: undefined };

vi.mock("../src/ui/primitives/menu", () => ({
  showMenu: (_items: unknown, _anchor: unknown, _onPick: unknown, opts?: ShowMenuOptions<string>) => {
    captured.opts = opts;
  },
}));

import { DIM_HOVER_MS, DIM_MENU, openDimMenu } from "../src/ui/primitives/dimMenu";
import { setDimPreview } from "../src/state/actions";
import { createLeafStore } from "../src/state/store";

const settings = { agents: { enabledPacks: {} } } as never;

describe("dimension menu hover preview", () => {
  it("reports a hovered dimension after the 80 ms delay, and null for anything else", () => {
    const seen: (string | null)[] = [];
    openDimMenu({} as HTMLElement, { app: {} as never, settings, current: "space", onPick: () => undefined, onHover: (d) => seen.push(d) });
    const o = captured.opts as ShowMenuOptions<string>;
    expect(o.hoverDelayMs).toBe(DIM_HOVER_MS);
    expect(DIM_HOVER_MS).toBe(80);
    o.onHover?.("folder");
    o.onHover?.(DIM_MENU.basisImported);
    o.onHover?.(null);
    expect(seen).toEqual(["folder", null, null]);
  });

  it("clears the preview when the menu closes", () => {
    const seen: (string | null)[] = [];
    let hidden = 0;
    openDimMenu({} as HTMLElement, { app: {} as never, settings, current: null, onPick: () => undefined, onHover: (d) => seen.push(d), menu: { onHide: () => hidden++ } });
    const o = captured.opts as ShowMenuOptions<string>;
    o.onHover?.("source");
    o.onHide?.();
    expect(seen).toEqual(["source", null]);
    expect(hidden).toBe(1);
  });

  it("adds no hover handling when the caller does not ask for it", () => {
    openDimMenu({} as HTMLElement, { app: {} as never, settings, current: null, onPick: () => undefined });
    expect(captured.opts).toBeUndefined();
  });

  it("keeps the preview in the store, for one population, and clears it", () => {
    const s = createLeafStore();
    setDimPreview(s, "source", "record");
    expect(s.get("ui")).toMatchObject({ dimPreview: "source", dimPreviewPop: "record" });
    setDimPreview(s, null);
    expect(s.get("ui")).toMatchObject({ dimPreview: null, dimPreviewPop: "both" });
  });
});

import { previewColour } from "../src/state/dimPreview";

describe("the colour modes drawn during a preview", () => {
  const colour = { notes: { kind: "categorical", dim: "space" } as const, record: { kind: "age" } as const, same: false };
  it("changes nothing without a preview, and shares the Brain's mode when the colours are shared", () => {
    expect(previewColour(colour, null, "both")).toEqual({ notes: colour.notes, record: colour.record });
    expect(previewColour({ ...colour, same: true }, null, "both")).toEqual({ notes: colour.notes, record: colour.notes });
  });
  it("previews on the population whose picker is open", () => {
    const hov = { kind: "categorical", dim: "kind" };
    expect(previewColour(colour, "kind", "notes")).toEqual({ notes: hov, record: colour.record });
    expect(previewColour(colour, "kind", "record")).toEqual({ notes: colour.notes, record: hov });
    expect(previewColour(colour, "kind", "both")).toEqual({ notes: hov, record: hov });
    expect(previewColour({ ...colour, same: true }, "kind", "both")).toEqual({ notes: hov, record: hov });
  });
});
