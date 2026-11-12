/**
 * P16 stage overlays: the title block, the one-line tooltip and its grouping-aware field, the thin-groups banner, the
 * Ask button and the panel header's busy underline.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import type { ItemMeta } from "../src/plugin/indexer";
import type { DimId } from "../src/shared/dims";
import { ItemFlag, ItemKind, Population, type DataIndex } from "../src/shared/index-format";
import type { LegendModel } from "../src/shared/protocol/worker";
import { LeafContext, ServicesContext, ShellContext, shellFor } from "../src/ui/context";
import { emptyDeviceState, parseDeviceState } from "../src/ui/deviceState";
import { panelBusy, panelTitleClass, usePanelBusy } from "../src/ui/loading";
import { AgentButton, openAsk } from "../src/ui/stage/AgentButton";
import { COPY } from "../src/ui/copy";
import { pickBanner, type BannerInputs } from "../src/ui/stage/Banner";
import { TitleBlock, countsLine, linkCount, titleBlockVisible } from "../src/ui/stage/TitleBlock";
import { fieldFor, lineText, tooltipDim, tooltipModel } from "../src/ui/stage/Tooltip";
import { fakeServices, type FakeHarness } from "./helpers/fakeServices";

function renderIn(h: FakeHarness, node: preact.ComponentChild, shell = shellFor(h.leaf)): string {
  return render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>
        <ShellContext.Provider value={shell}>{node}</ShellContext.Provider>
      </LeafContext.Provider>
    </ServicesContext.Provider>,
  );
}

/** A four-item index: notes 0..2 (0–1 and 1–2 linked, each pair stored both ways) and one record entry. */
function tinyIndex(excludeNote2 = false): DataIndex {
  const pop = Uint8Array.from([Population.Note, Population.Note, Population.Note, Population.Record]);
  const flags = Uint8Array.from([0, 0, excludeNote2 ? ItemFlag.Excluded : 0, 0]);
  return {
    count: 4,
    cols: { pop, flags, space: new Uint8Array(4).fill(255), t: new Float64Array(4).fill(Number.NaN) },
    rel: { noteLinks: { offsets: Uint32Array.from([0, 1, 3, 4, 4]), targets: Uint32Array.from([1, 0, 2, 1]) } },
  } as unknown as DataIndex;
}

const note = (over: Partial<ItemMeta> = {}): ItemMeta => ({
  ordinal: 1,
  id: "n_1",
  title: "Lock slots",
  kind: ItemKind.NoteAtomic,
  noteKind: "decision",
  population: "note",
  source: "files",
  speaker: "other",
  writtenAt: "2026-10-15T12:00:00.000Z",
  folder: "Projects/Atlas",
  space: "work",
  words: 120,
  flags: 0,
  ...over,
});

describe("title block", () => {
  it("counts notes and the links between them once per pair, skipping excluded notes", () => {
    expect(linkCount(tinyIndex())).toBe(2);
    expect(linkCount(tinyIndex(true))).toBe(1);
    expect(countsLine(691, 2086)).toBe("691 notes · 2,086 links");
    expect(countsLine(1, 1)).toBe("1 note · 1 link");
  });

  it("shows the page name and the counts, and hides in Immersive mode and on narrow stages", () => {
    const base = fakeServices();
    const services = Object.create(base.services, { index: { value: { index: { value: tinyIndex() } } } }) as FakeHarness["services"];
    const h: FakeHarness = { ...base, services };
    const shell = shellFor(h.leaf);
    shell.size.value = { width: 1400, height: 900 };
    const html = renderIn(h, <TitleBlock />, shell);
    expect(html).toContain("cx-title-block");
    expect(html).toContain(">Brain<");
    expect(html).toContain("3 notes · 2 links");
    expect(titleBlockVisible("XL", 1200, true)).toBe(false);
    expect(titleBlockVisible("XL", 500, false)).toBe(false);
    expect(titleBlockVisible("S", 900, false)).toBe(false);
    expect(titleBlockVisible("L", 900, false)).toBe(true);
    shell.size.value = { width: 700, height: 900 };
    expect(renderIn(h, <TitleBlock />, shell)).toBe("");
  });
});

describe("one-line tooltip and its grouping-aware field", () => {
  it("ends with the folder path under a Folder grouping", () => {
    const m = tooltipModel(note(), "folderPath");
    expect(lineText(m)).toBe("◆ Lock slots · 15 Oct 2026 · Projects/Atlas");
    expect(fieldFor("folder", note({ kind: ItemKind.RecordMessage, folder: "" }))).not.toBe("");
  });

  it("ends with 'Mon YYYY' under a month grouping and the area under an Area grouping", () => {
    expect(lineText(tooltipModel(note(), "month"))).toMatch(/ · Oct 2026$/);
    expect(fieldFor("space", note())).toBe(fieldFor("space", note({ folder: "" })));
    expect(lineText(tooltipModel(note(), "space"))).toMatch(/ · \S/);
    expect(fieldFor("year", note())).toBe("2026");
    expect(fieldFor("month", note({ writtenAt: undefined }))).toBe("No date of its own");
  });

  it("says a map's type and recency, and the kind otherwise", () => {
    const hub = note({ kind: ItemKind.NoteHub, noteKind: "hub", mapKind: "project", hubStatus: "quiet", title: "Atlas" });
    expect(fieldFor("map", hub)).toBe("Project map, cooling");
    expect(lineText(tooltipModel(hub, "hubStatus"))).toMatch(/^✦ Atlas · 15 Oct 2026 · Project map, cooling$/);
    expect(fieldFor("map", note())).toBe("Decision");
    expect(fieldFor(null, note())).toBe("Decision");
    expect(fieldFor("source", note({ kind: ItemKind.RecordMessage, source: "claude-code" }))).toMatch(/Claude/);
  });

  it("adds the field to the card as one more line only when it tells something new", () => {
    const plain = tooltipModel(note(), null);
    expect(plain.lines).toHaveLength(2);
    const byFolder = tooltipModel(note(), "folderPath");
    expect(byFolder.lines.map((l) => l.text)).toContain("Projects/Atlas");
    expect(tooltipModel(note(), "space").lines).toHaveLength(2);
  });

  it("follows the grouping while Groups or Chart shows, else the colour dimension", () => {
    const legend = (dim: DimId | "age"): LegendModel => ({ grandTotal: 0, sections: [{ population: "notes", dim, rows: [], total: 0 }] });
    expect(tooltipDim("groups", 1, "folderPath", null, legend("space"), "note")).toBe("folderPath");
    expect(tooltipDim("groups", 0, "folderPath", null, legend("space"), "note")).toBe("space");
    expect(tooltipDim("body", 0, "folderPath", null, legend("month"), "note")).toBe("month");
    expect(tooltipDim("body", 0, "space", null, legend("age"), "note")).toBeNull();
    expect(tooltipDim("body", 0, "space", null, null, "record")).toBeNull();
  });

  it("is a per-device setting that defaults to the line", () => {
    expect(emptyDeviceState().tooltipStyle).toBe("line");
    expect(parseDeviceState({ tooltipStyle: "card" }).tooltipStyle).toBe("card");
    expect(parseDeviceState({ tooltipStyle: "banana" }).tooltipStyle).toBe("line");
    expect(parseDeviceState(null).tooltipStyle).toBe("line");
  });
});

describe("thin groupings have no banner", () => {
  const base = (over: Partial<BannerInputs> = {}): BannerInputs => ({
    sandbox: false,
    sampleSeen: false,
    feed: { status: "ok" } as never,
    data: { phase: "ready", notes: 5, record: 5, failure: undefined } as never,
    ui: { hiddenGroups: [], period: null, scope: "all" } as never,
    legend: null,
    strip: null,
    counts: null,
    device: { ...emptyDeviceState(), checklistHidden: true },
    firstRunDone: true,
    ...over,
  });

  it("says nothing about thin groups for area, folder or date groupings (the coverage note is for label fields only)", () => {
    expect(pickBanner(base())).toBeNull();
    expect(Object.keys(COPY.overlays)).not.toContain("thinGroups");
  });

  it("yields to the banners that come first", () => {
    expect(pickBanner(base({ data: { phase: "ready", notes: 5, record: 0 } as never }))).toBe("no-record");
  });
});

describe("Ask button", () => {
  it("renders with its caption and opens the Ask console like Ctrl+Shift+K", () => {
    const h = fakeServices();
    const html = renderIn(h, <AgentButton />);
    expect(html).toContain("cx-agent-button");
    expect(html).toContain("cx-agent-pill");
    expect(html).toContain(">Ask<");
    const shell = shellFor(h.leaf);
    openAsk(h.leaf.store, shell);
    const ui = h.leaf.store.get("ui");
    expect(ui.command.mode).toBe("ask");
    expect(ui.command.consoleOpen).toBe(true);
  });

  it("is hidden in Immersive mode", () => {
    const h = fakeServices();
    h.leaf.store.update("ui", { immersive: true });
    expect(renderIn(h, <AgentButton />)).toBe("");
  });
});

describe("panel header underline", () => {
  const idle: Parameters<typeof panelBusy>[1] = { data: { phase: "ready", progress: 1, available: 5 }, jobs: [], stageStatus: "ok" };

  it("is busy while the worker arranges the stage (display, key, chart) or the record is read (index)", () => {
    expect(panelBusy("display", idle)).toBe(false);
    expect(panelBusy("display", { ...idle, stageStatus: "arranging" })).toBe(true);
    expect(panelBusy("key", { ...idle, stageStatus: "arranging" })).toBe(true);
    expect(panelBusy("index", { ...idle, data: { ...idle.data, phase: "loading" } })).toBe(true);
    expect(panelBusy("index", idle)).toBe(false);
  });

  it("puts the busy class on the header while the panel's request runs", () => {
    expect(panelTitleClass(false)).toBe("cx-popover-title");
    expect(panelTitleClass(true)).toBe("cx-popover-title is-busy");
    const h = fakeServices();
    const shell = shellFor(h.leaf);
    const Probe = () => <header class={panelTitleClass(usePanelBusy("display"))}>x</header>;
    expect(renderIn(h, <Probe />, shell)).not.toContain("is-busy");
    shell.feed.value = { ...shell.feed.value, status: "arranging" };
    expect(renderIn(h, <Probe />, shell)).toContain("is-busy");
  });
});
