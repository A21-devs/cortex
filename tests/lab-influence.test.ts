/**
 * Agents > Ledger > Influence: nodes and links by the set of makers behind them, read from the index alone.
 */
import { describe, expect, it } from "vitest";
import { ItemFlag, Population } from "../src/shared/index-format";
import { computeStats } from "../src/worker/stats";
import { influenceStats, makerOf, makerOrdinals, makerRank, makerScope, makerSets, sortMakers } from "../src/worker/influence";
import { buildSampleIndex } from "../src/worker/sampleIndex";

const index = buildSampleIndex(20261110, Date.UTC(2026, 10, 10));

describe("makers", () => {
  it("orders you, the assistants, the machine, tools, others", () => {
    expect(sortMakers(["tool", "machine", "app:chatgpt", "you", "other", "app:claude-code"])).toEqual(["you", "app:chatgpt", "app:claude-code", "machine", "tool", "other"]);
    expect(makerRank("app:x")).toBe(1);
    expect(makerRank("mystery")).toBe(5);
  });

  it("names a note's writer from the machine flag and an entry's from its speaker", () => {
    let note = -1;
    let machine = -1;
    for (let o = 0; o < index.count; o++) {
      if (index.cols.pop[o] !== Population.Note) continue;
      if (note < 0) note = o;
      if (machine < 0 && (index.cols.flags[o]! & ItemFlag.MachineWritten) !== 0) machine = o;
    }
    expect(note).toBeGreaterThanOrEqual(0);
    expect(["you", "machine"]).toContain(makerOf(index, note));
    if (machine >= 0) expect(makerOf(index, machine)).toBe("machine");
  });
});

describe("influence stats", () => {
  const notes = influenceStats(index, "notes");
  const record = influenceStats(index, "record");

  it("counts every node once, in the rows by set and in the rows by maker", () => {
    for (const r of [notes, record]) {
      expect(r.nodes).toBeGreaterThan(0);
      expect(r.together.reduce((a, x) => a + x.nodes, 0)).toBe(r.nodes);
      expect(r.together.reduce((a, x) => a + x.links, 0)).toBe(r.links);
      // a maker is touched by at least what it made, and no row is bigger than the reading
      for (const m of r.byMaker) {
        expect(m.touched).toBeGreaterThanOrEqual(m.made);
        expect(m.touched).toBeLessThanOrEqual(r.nodes);
        expect(m.links).toBeLessThanOrEqual(r.links);
      }
      expect(r.byMaker.reduce((a, m) => a + m.made, 0)).toBe(r.nodes);
    }
  });

  it("the notes reading holds notes only; the whole record holds more", () => {
    let nNotes = 0;
    for (let o = 0; o < index.count; o++) if (index.cols.pop[o] === Population.Note && !(index.cols.flags[o]! & ItemFlag.Excluded)) nNotes++;
    expect(notes.nodes).toBe(nNotes);
    expect(record.nodes).toBeGreaterThan(notes.nodes);
    expect(notes.together.every((r) => r.makers.length === 1)).toBe(true);
  });

  it("a conversation's entries carry the whole conversation's set, so makers appear together", () => {
    expect(record.together.some((r) => r.makers.length > 1)).toBe(true);
    const sorted = record.together.map((r) => r.nodes);
    expect(sorted).toEqual([...sorted].sort((a, b) => b - a));
  });

  it("is reachable through computeStats", () => {
    const res = computeStats(index, { kind: "influence", scope: "notes" });
    expect(res.kind).toBe("influence");
  });
});

describe("lighting a row", () => {
  it("a set key lights exactly the nodes of that set, 'has:' every node the maker is in", () => {
    const sets = makerSets(index, "record");
    const row = influenceStats(index, "record").together[0]!;
    const lit = makerOrdinals(index, "record", row.key);
    expect(lit.length).toBe(row.nodes);
    expect(lit.every((o) => sets.keys[sets.setOf[o]!] === row.key)).toBe(true);
    const maker = row.makers[0]!;
    const has = makerOrdinals(index, "record", `has:${maker}`);
    expect(has.length).toBe(influenceStats(index, "record").byMaker.find((m) => m.maker === maker)!.touched);
    expect(makerOrdinals(index, "record", "no+such")).toEqual([]);
  });

  it("knows its dimensions", () => {
    expect(makerScope("maker:notes")).toBe("notes");
    expect(makerScope("maker:record")).toBe("record");
    expect(makerScope("source")).toBeNull();
  });
});
