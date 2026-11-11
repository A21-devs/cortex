/**
 * Stage hover: the key chip's group preview, hub hover (members, source entries, link fan, member card, chips) and the
 * provenance line. Pure models over the sample index; the controller wires them to the renderer.
 */
import { describe, expect, it } from "vitest";
import { SAMPLE_SEED } from "../src/plugin/sampleRecord";
import { buildHubFan, fanPositions, HUB_FAN_ALPHA } from "../src/render/hubFan";
import { RENDER_TUNING } from "../src/render/tuning";
import { citedByCount, groupPreviewSet, HUB_HOVER, hubMemberList, hubSourceList, provenanceOf } from "../src/shared/hoverModel";
import { ItemKind, NONE32, NONE8, Population } from "../src/shared/index-format";
import type { LegendModel, LegendRow } from "../src/shared/protocol/worker";
import { hubCardModel, memberCardHeight, memberCardPosition } from "../src/ui/stage/HubCard";
import { layoutLabels } from "../src/ui/stage/LabelLayer";
import { provenanceText } from "../src/ui/stage/ProvenanceLine";
import { MEMBER_CARD } from "../src/ui/stage/MemberCard";
import { buildSampleIndex } from "../src/worker/sampleIndex";
import type { LabelAnchor } from "../src/ui/context";

const index = buildSampleIndex(SAMPLE_SEED, Date.UTC(2026, 5, 1));

const row = (key: string, extra: Partial<LegendRow> = {}): LegendRow => ({ key, name: key, slot: 1, bucket: "value", rgb: [200, 100, 50], notes: 0, record: 0, hidden: false, depth: 0, expandable: false, ...extra });

describe("legend chip hover: groupPreviewSet", () => {
  // 6 items: notes 0,1,2 then record 3,4,5
  const pop = [Population.Note, Population.Note, Population.Note, Population.Record, Population.Record, Population.Record];
  it("marks the members of the hovered row in a shared section", () => {
    const legend: LegendModel = { sections: [{ population: "both", dim: "space", rows: [row("code"), row("web")], total: 6 }], grandTotal: 6 };
    const groupOf = Uint32Array.from([0, 1, 0, 1, 0, NONE32]);
    expect(Array.from(groupPreviewSet(legend, groupOf, pop, 6, "space=code") as Uint8Array)).toEqual([1, 0, 1, 0, 1, 0]);
    expect(Array.from(groupPreviewSet(legend, groupOf, pop, 6, "space=web") as Uint8Array)).toEqual([0, 1, 0, 1, 0, 0]);
  });
  it("reads each population from its own section when the brain and the spine are coloured apart", () => {
    const legend: LegendModel = {
      sections: [
        { population: "notes", dim: "space", rows: [row("code"), row("web")], total: 3 },
        { population: "record", dim: "source", rows: [row("web"), row("code")], total: 3 },
      ],
      grandTotal: 6,
    };
    const groupOf = Uint32Array.from([0, 1, 0, 0, 1, 1]);
    // "space=web" is a Brain row only: the notes with row 1; no spine entry matches.
    expect(Array.from(groupPreviewSet(legend, groupOf, pop, 6, "space=web") as Uint8Array)).toEqual([0, 1, 0, 0, 0, 0]);
    // "source=web" is a Spine row (index 0): the entries with row 0.
    expect(Array.from(groupPreviewSet(legend, groupOf, pop, 6, "source=web") as Uint8Array)).toEqual([0, 0, 0, 1, 0, 0]);
  });
  it("includes rows nested under the hovered one", () => {
    const legend: LegendModel = { sections: [{ population: "both", dim: "folder", rows: [row("a", { expandable: true }), row("a/b", { depth: 1, parentKey: "a" }), row("c")], total: 6 }], grandTotal: 6 };
    const groupOf = Uint32Array.from([0, 1, 2, 1, 2, 0]);
    expect(Array.from(groupPreviewSet(legend, groupOf, pop, 6, "folder=a") as Uint8Array)).toEqual([1, 1, 0, 1, 0, 1]);
  });
  it("is null with no legend, no grouping or an unknown chip", () => {
    const legend: LegendModel = { sections: [{ population: "both", dim: "space", rows: [row("code")], total: 1 }], grandTotal: 1 };
    expect(groupPreviewSet(null, new Uint32Array(6), pop, 6, "space=code")).toBeNull();
    expect(groupPreviewSet(legend, null, pop, 6, "space=code")).toBeNull();
    expect(groupPreviewSet(legend, new Uint32Array(6), pop, 6, "space=nothing")).toBeNull();
  });
});

function firstHub(min = 3): number {
  const { offsets } = index.rel.hubMembers;
  for (let i = 0; i < index.count; i++) if (index.cols.kind[i] === ItemKind.NoteHub && (offsets[i + 1] as number) - (offsets[i] as number) >= min) return i;
  return -1;
}

describe("hub hover: members and sources", () => {
  it("lists a hub's members largest first without itself or duplicates", () => {
    const hub = firstHub();
    expect(hub).toBeGreaterThanOrEqual(0);
    const members = hubMemberList(index, hub);
    expect(members.length).toBeGreaterThan(0);
    expect(members).not.toContain(hub);
    expect(new Set(members).size).toBe(members.length);
    for (let i = 1; i < members.length; i++) expect(index.cols.words[members[i - 1] as number] as number).toBeGreaterThanOrEqual(index.cols.words[members[i] as number] as number);
    for (const m of members) expect(index.cols.kind[m]).not.toBe(NONE8);
  });
  it("is empty for anything that is not a hub", () => {
    let note = -1;
    for (let i = 0; i < index.count && note < 0; i++) if (index.cols.kind[i] === ItemKind.NoteAtomic) note = i;
    expect(hubMemberList(index, note)).toEqual([]);
    expect(hubMemberList(index, -1)).toEqual([]);
    expect(hubMemberList(index, index.count + 5)).toEqual([]);
  });
  it("collects the distinct record entries the members cite", () => {
    const members = hubMemberList(index, firstHub());
    const sources = hubSourceList(index, members);
    expect(new Set(sources).size).toBe(sources.length);
    for (const s of sources) expect(index.cols.pop[s]).toBe(Population.Record);
    const brute = new Set<number>();
    const { offsets, targets } = index.rel.noteSources;
    for (const m of members) for (let k = offsets[m] as number; k < (offsets[m + 1] as number); k++) if (index.cols.pop[targets[k] as number] === Population.Record) brute.add(targets[k] as number);
    expect(new Set(sources)).toEqual(brute);
    expect(hubSourceList(index, members, 2).length).toBeLessThanOrEqual(2);
  });
  it("names at most HUB_HOVER.chips members as chips, and lays out that many chips in one go", () => {
    expect(HUB_HOVER.chips).toBe(30);
    const anchors: LabelAnchor[] = Array.from({ length: 40 }, (_, i) => ({
      key: String(i), ordinal: i, x: 40 + (i % 2) * 400, y: 30 + i * 22, depth: (i % 10) / 10, priority: 5, kind: "Decision", glyph: "◆", title: `Member note ${i}`, rgb: [200, 120, 80], hover: true,
    }));
    const placed = layoutLabels(anchors, [], { width: 900, height: 1000 }, HUB_HOVER.chips);
    expect(placed.length).toBeLessThanOrEqual(HUB_HOVER.chips);
    expect(placed.length).toBeGreaterThan(24);
    for (const p of placed) expect(p.opacity).toBeGreaterThanOrEqual(0.44);
  });
});

describe("hub hover: link fan", () => {
  const anat = new Float32Array([0, 0, 0, 1, 1, 0, 2, 0, 1, Number.NaN, 0, 0]);
  const colour = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255]);
  it("draws one straight segment per placed member, hub colour to member colour", () => {
    const fan = buildHubFan(anat, colour, 0, [1, 2, 3]);
    expect(fan.segments).toBe(2);
    expect(Array.from(fan.positions.subarray(0, 6))).toEqual([0, 0, 0, 1, 1, 0]);
    expect(Array.from(fan.colors.subarray(0, 8)).slice(0, 3)).toEqual([255, 0, 0]);
    expect(Array.from(fan.colors.subarray(4, 7))).toEqual([0, 255, 0]);
    expect(Array.from(fan.colors.subarray(12, 15))).toEqual([0, 0, 255]);
    expect(Array.from(fan.t)).toEqual([0, 1, 0, 1]);
  });
  it("lands on the fan alpha once the spoke family's own alpha is applied", () => {
    const fan = buildHubFan(anat, colour, 0, [1]);
    expect((fan.colors[3] as number) / 255 * RENDER_TUNING.lines.spokeAlpha).toBeCloseTo(HUB_FAN_ALPHA, 2);
    expect(fan.colors[7]).toBe(fan.colors[3]);
  });
  it("draws nothing when the hub is not placed, and tolerates missing colours", () => {
    expect(buildHubFan(anat, colour, 3, [1, 2]).segments).toBe(0);
    expect(buildHubFan(anat, null, 0, [1]).segments).toBe(1);
    expect(buildHubFan(anat, colour, 0, [99]).segments).toBe(0);
  });
});

describe("hub hover: where the fan is drawn", () => {
  const body = new Float32Array([0, 0, 0, 1, 1, 1]);
  const arranged = new Float32Array([5, 5, 5, 9, 9, 9]);
  it("uses the anatomy in the Body shape", () => {
    expect(fanPositions("body", 0, 0.85, body, null)).toBe(body);
    expect(fanPositions("body", 0, 0.85, body, arranged)).toBe(body);
  });
  it("uses the arrangement's points in Groups once the morph has settled", () => {
    expect(fanPositions("groups", 1, 0.85, body, arranged)).toBe(arranged);
    expect(fanPositions("groups", 0.6, 0.85, body, arranged)).toBeNull();
    expect(fanPositions("groups", 1, 0.85, body, null)).toBeNull();
    const fan = buildHubFan(arranged, null, 0, [1]);
    expect(Array.from(fan.positions)).toEqual([5, 5, 5, 9, 9, 9]);
  });
  it("fans over a chart's arrangement once it has settled", () => {
    expect(fanPositions("chart", 1, 0.85, body, arranged)).toBe(arranged);
    expect(fanPositions("chart", 0.5, 0.85, body, arranged)).toBeNull();
    expect(fanPositions("chart", 1, 0.85, body, null)).toBeNull();
  });
});

describe("hub hover: member card", () => {
  it("names the hub's kind, its note count and its largest members", () => {
    const hub = firstHub();
    const total = hubMemberList(index, hub).length;
    const model = hubCardModel(
      (o) => ({ ordinal: o, id: String(o), title: `Title ${o}`, kind: index.cols.kind[o] as number, population: "note", source: "obsidian", speaker: "you", folder: "", space: "code", words: 1, flags: 0, ...(o === hub ? { mapKind: "area" as const } : {}) }),
      index,
      hub,
    );
    expect(model?.notes).toBe(total);
    expect(model?.kind).toBe("Area map");
    expect(model?.members.length).toBe(Math.min(total, MEMBER_CARD.maxRows));
  });
  it("is null for a note", () => {
    expect(hubCardModel(() => undefined, index, 0)).toBeNull();
  });
  it("sits under the tooltip, flips above it near the bottom and stays on the stage", () => {
    const rows = 8;
    const h = memberCardHeight(rows, true);
    const open = memberCardPosition(100, 100, 1000, 700, rows, true);
    expect(open.top).toBeGreaterThan(100);
    const low = memberCardPosition(100, 680, 1000, 700, rows, true);
    expect(low.top + h).toBeLessThanOrEqual(700);
    const right = memberCardPosition(990, 100, 1000, 700, rows, true);
    expect(right.left + MEMBER_CARD.width).toBeLessThanOrEqual(1000);
    expect(right.left).toBeGreaterThanOrEqual(4);
  });
});

describe("provenance line", () => {
  it("counts the notes built from a record entry", () => {
    let entry = -1;
    for (let i = 0; i < index.count && entry < 0; i++) if (index.cols.pop[i] === Population.Record && citedByCount(index, i) > 0) entry = i;
    expect(entry).toBeGreaterThanOrEqual(0);
    const p = provenanceOf(index, entry);
    expect(p).toEqual({ kind: "entry", notes: citedByCount(index, entry) });
    // brute force
    let n = 0;
    const { offsets, targets } = index.rel.noteSources;
    for (let r = 0; r < index.count; r++) for (let k = offsets[r] as number; k < (offsets[r + 1] as number); k++) if (targets[k] === entry) n++;
    expect(citedByCount(index, entry)).toBe(n);
  });
  it("counts the record entries a note or a hub is built from", () => {
    const hub = firstHub();
    const p = provenanceOf(index, hub);
    expect(p?.kind).toBe("built");
    expect((p as { entries: number }).entries).toBe(hubSourceList(index, hubMemberList(index, hub), Number.MAX_SAFE_INTEGER).length);
    let note = -1;
    const { offsets } = index.rel.noteSources;
    for (let i = 0; i < index.count && note < 0; i++) if (index.cols.pop[i] === Population.Note && index.cols.kind[i] !== ItemKind.NoteHub && (offsets[i + 1] as number) > (offsets[i] as number)) note = i;
    expect(note).toBeGreaterThanOrEqual(0);
    expect(provenanceOf(index, note)?.kind).toBe("built");
  });
  it("says nothing for an item with no relations or an unknown ordinal", () => {
    expect(provenanceOf(index, -1)).toBeNull();
    expect(provenanceOf(index, index.count)).toBeNull();
  });
  it("words the line, singular and plural", () => {
    expect(provenanceText(null)).toBeNull();
    expect(provenanceText({ kind: "entry", notes: 1 })).toBe("Source of 1 note");
    expect(provenanceText({ kind: "entry", notes: 12 })).toBe("Source of 12 notes");
    expect(provenanceText({ kind: "built", entries: 1 })).toBe("Built from 1 entry, which sits in the spine below the brain");
    expect(provenanceText({ kind: "built", entries: 1234 })).toContain("1,234 entries, all in the spine below the brain");
  });
});

describe("review fixes", () => {
  it("keeps the selection's chips ahead of a hovered hub's when the cap bites", () => {
    const mk = (i: number, priority: number, hover?: true): LabelAnchor => ({ key: String(i), ordinal: i, x: 40 + (i % 2) * 400, y: 30 + (i % 40) * 24, depth: 0, priority, kind: "Decision", glyph: "", title: `Note ${i}`, rgb: [200, 120, 80], ...(hover ? { hover } : {}) });
    const anchors = [...Array.from({ length: 30 }, (_, i) => mk(i, 2.5, true)), mk(30, 4), mk(31, 3)];
    const placed = layoutLabels(anchors, [], { width: 900, height: 1000 }, HUB_HOVER.chips);
    const keys = placed.map((p) => p.anchor.key);
    expect(keys).toContain("30");
    expect(keys).toContain("31");
  });
  it("rebuilds cited-by counts when the item count changes", () => {
    const grown = { ...index, count: index.count + 1 } as typeof index;
    // a fresh object has no cache; counts for items below the old count agree with the original
    const probe = Array.from({ length: Math.min(index.count, 50) }, (_, o) => o);
    for (const o of probe) expect(citedByCount(grown, o)).toBe(citedByCount(index, o));
  });
});
