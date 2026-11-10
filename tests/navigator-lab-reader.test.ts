/**
 * Navigator, Lab tables and hub reader sections (SPEC V14, V17, V13): row meta lines and folder dots, the pack
 * lighting token and its worker match, the spend / tagged tables, typed map sections end to end.
 */
import { describe, expect, it } from "vitest";
import { validateHubOutput, type ValidationContext } from "../src/agents/validators";
import { HUB_OUTPUT_SCHEMA, HUB_SECTION_ALL } from "../src/agents/schemas";
import { buildHubPrompt } from "../src/agents/prompts";
import { NONE16, NONE8, type DataIndex, type LabelColumn } from "../src/shared/index-format";
import { HUB_SECTION_KEYS, type HubFields, type RunRecord } from "../src/shared/types";
import { renderHubMarkdown } from "../src/store/notesWriter";
import type { HubDoc } from "../src/shared/notesDoc";
import { PACK_TOKEN_PREFIX, packToken } from "../src/ui/pages/Agents";
import { fmtSpend, localDayKey, spendByDay, taggedNow, taggedRows } from "../src/ui/pages/labTables";
import { folderSlot, rowKindWord, rowMetaLine, shortDate } from "../src/ui/pages/Read";
import { daysBeforeNewest, hubSections, hubStatusWord, statusSentence } from "../src/ui/reader/MapReader";
import { dimKeyMatches, packOrdinals, packWildcard } from "../src/worker/indexOps";

describe("Navigator rows (V14)", () => {
  it("builds the caps meta line from source and kind", () => {
    expect(rowMetaLine("claude-code", "Conversation")).toBe("Claude Code · Conversation");
    expect(rowMetaLine("claude-code", undefined)).toBe("Claude Code");
    expect(rowKindWord({ kind: 0, population: "record", conversation: undefined }, 14)).toBe("Conversation");
    expect(rowKindWord({ kind: 1, population: "record", conversation: undefined }, 1)).toBe("Document");
    expect(rowKindWord({ kind: 3, population: "record", conversation: undefined }, 1)).toBe("File");
    expect(rowKindWord({ kind: 11, noteKind: "decision", population: "note", conversation: undefined }, 1)).toBe("Decision");
    expect(rowKindWord({ kind: 13, mapKind: "project", population: "note", conversation: undefined }, 1)).toBe("Project map");
    expect(rowKindWord({ kind: 10, population: "note", conversation: undefined }, 1)).toBe("Note");
  });

  it("formats the bold short date, adding the year only for other years", () => {
    const now = new Date(2026, 10, 10, 12).getTime();
    expect(shortDate(new Date(2026, 9, 4, 9).getTime(), now)).toBe("4 Oct");
    expect(shortDate(new Date(2025, 9, 4, 9).getTime(), now)).toBe("4 Oct 2025");
    expect(shortDate(Number.NaN, now)).toBe("");
  });

  it("picks a folder dot colour from the sticky slots, else a stable slot per top-level folder", () => {
    expect(folderSlot("proj/a", { folder: { proj: 3 } })).toBe(3);
    expect(folderSlot("proj/a", { folderPath: { "proj/a": 5, proj: 2 } })).toBe(5);
    const a = folderSlot("notes/deep");
    expect(a).toBeGreaterThanOrEqual(1);
    expect(a).toBeLessThanOrEqual(8);
    expect(folderSlot("notes/other")).toBe(a);
    expect(folderSlot("notes")).toBe(a);
  });

  it("lights a folder's subfolders too", () => {
    expect(dimKeyMatches("folderPath", "a/b", "a")).toBe(true);
    expect(dimKeyMatches("folderPath", "a", "a")).toBe(true);
    expect(dimKeyMatches("folderPath", "ab", "a")).toBe(false);
    expect(dimKeyMatches("space", "a/b", "a")).toBe(false);
  });
});

function runRec(p: Partial<RunRecord>): RunRecord {
  return {
    v: 1,
    id: "r_aaaaaaaaaaaaaaaa" as RunRecord["id"],
    job: "label",
    pass: 1,
    engine: "claude-cli",
    model: "haiku",
    where: "remote",
    paidBy: "plan",
    startedAt: "2026-11-10T09:00:00.000Z",
    status: "finished",
    targets: [],
    items: 0,
    labels: 0,
    declined: 0,
    noAnswer: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    tokensEstimated: false,
    costUsd: 0,
    priceTableDate: "2026-01-01",
    promptVersion: "label@2.0.0",
    ...p,
  } as RunRecord;
}

describe("Lab: pack lighting (F39)", () => {
  it("makes one group token per pack version on the wildcard dimension", () => {
    const t = packToken("session", "1.0.0");
    expect(t.id.startsWith(PACK_TOKEN_PREFIX)).toBe(true);
    expect(t).toMatchObject({ kind: "group", dim: "label:session/*", value: "1.0.0" });
    expect(packWildcard(t.dim)).toBe("session");
    expect(packWildcard("label:session/work")).toBeNull();
    expect(packWildcard("space")).toBeNull();
  });

  it("selects every item labelled by the pack, at that version or any", () => {
    const col = (pack: string, version: string, vals: (number | null)[]): LabelColumn => ({
      pack,
      packVersion: version,
      field: "work",
      type: "enum",
      values: ["x", "y"],
      single: Uint16Array.from(vals.map((v) => (v === null ? NONE16 : v))),
      byUser: new Uint8Array(vals.length),
    });
    const index = {
      count: 4,
      cols: { kind: Uint8Array.from([0, 0, NONE8, 0]) },
      labels: [col("session", "1.0.0", [0, null, 1, null]), col("session", "0.9.0", [null, 1, null, null]), col("other", "1.0.0", [null, null, null, 0])],
    } as unknown as DataIndex;
    expect(packOrdinals(index, "session", "1.0.0")).toEqual([0]);
    expect(packOrdinals(index, "session", "")).toEqual([0, 1]);
    expect(packOrdinals(index, "other", "1.0.0")).toEqual([3]);
    expect(packOrdinals(index, "none", "")).toEqual([]);
  });
});

describe("Lab tables (V17)", () => {
  it("totals spend and calls per local day for the last 14 days, newest first", () => {
    const now = new Date(2026, 10, 10, 15).getTime();
    const at = (y: number, m: number, d: number, h: number) => new Date(y, m, d, h).toISOString();
    const rows = spendByDay(
      [
        { startedAt: at(2026, 10, 10, 9), costUsd: 0.1 },
        { startedAt: at(2026, 10, 10, 11), costUsd: 0.25 },
        { startedAt: at(2026, 10, 8, 8), costUsd: 0 },
        { startedAt: at(2026, 9, 1, 8), costUsd: 5 },
      ],
      14,
      now,
    );
    expect(rows.map((r) => r.day)).toEqual([localDayKey(new Date(2026, 10, 10).getTime()), localDayKey(new Date(2026, 10, 8).getTime())]);
    expect(rows[0]).toMatchObject({ calls: 2 });
    expect(rows[0]?.spent).toBeCloseTo(0.35);
    expect(rows[1]).toMatchObject({ calls: 1, spent: 0 });
    expect(fmtSpend(0.35)).toBe("≈$0.35");
    expect(fmtSpend(0)).toBe("–");
    expect(spendByDay([], 14, now)).toEqual([]);
  });

  it("folds labelling runs into one row per model and pack with a NOW state", () => {
    const rows = taggedRows([
      runRec({ id: "r_bbbbbbbbbbbbbbbb" as RunRecord["id"], pack: "session", model: "haiku", startedAt: "2026-11-09T09:00:00.000Z", targets: ["c_a", "c_b"], items: 2, labels: 6, declined: 1 }),
      runRec({ id: "r_cccccccccccccccc" as RunRecord["id"], pack: "session", model: "haiku", startedAt: "2026-11-10T09:00:00.000Z", targets: ["c_b", "c_c"], items: 2, labels: 4, declined: 0, status: "running" }),
      runRec({ id: "r_dddddddddddddddd" as RunRecord["id"], pack: "session", model: "sonnet", startedAt: "2026-11-01T09:00:00.000Z", items: 3, labels: 0, status: "stopped" }),
      runRec({ id: "r_eeeeeeeeeeeeeeee" as RunRecord["id"], job: "hub", model: "sonnet", items: 1, labels: 9 }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ model: "haiku", pack: "session", conversations: 3, tagged: 10, refused: 1, now: "running" });
    expect(rows[1]).toMatchObject({ model: "sonnet", conversations: 3, tagged: 0, now: "stopped" });
    expect(taggedNow({ status: "stopped", items: 0, labels: 0 })).toBe("none");
    expect(taggedNow({ status: "finished", items: 4, labels: 0 })).toBe("none");
    expect(taggedNow({ status: "finished", items: 4, labels: 2 })).toBe("finished");
    expect(taggedRows([])).toEqual([]);
  });
});

describe("Hub reader (F35, V13)", () => {
  it("says the status word and the project status sentence", () => {
    expect(hubStatusWord("paused")).toBe("paused");
    const day = 86_400_000;
    expect(daysBeforeNewest(0, 716 * day)).toBe(716);
    expect(daysBeforeNewest(5 * day, 0)).toBe(0);
    expect(daysBeforeNewest(Number.NaN, 0)).toBeNull();
    expect(statusSentence("paused", 0, 716 * day)).toBe("Status: paused. Last activity 716 days before your most recent entry.");
    expect(statusSentence("active", day, day)).toBe("Status: active. Last activity falls on your most recent entry.");
    expect(statusSentence("active", Number.NaN, day)).toBeNull();
  });

  it("lists only the typed sections that exist, in the map type's order", () => {
    const st = (text: string) => ({ text, cites: [] });
    const project: Pick<HubFields, "hubType" | "sections"> = { hubType: "project", sections: { keyDecisions: [st("a")], nextSteps: [st("b")], openQuestions: [] } };
    expect(hubSections(project).map((s) => s.label)).toEqual(["What comes next", "What was decided"]);
    expect(hubSections({ hubType: "area", sections: { whatItIs: [st("x")], nextSteps: [st("ignored")] } }).map((s) => s.key)).toEqual(["whatItIs"]);
    expect(hubSections({ hubType: "topic", sections: { whatWasFound: [st("y")] } }).map((s) => s.label)).toEqual(["What was found"]);
    expect(hubSections({ hubType: "project" })).toEqual([]);
  });
});

describe("Hub agent sections", () => {
  const E1 = "e_aaaaaaaaaaaaaaaa";
  const TEXT = "We decided to ship the importer first and leave the exporter for later.";
  const vctx: ValidationContext = {
    allowedIds: new Set([E1]),
    entryOf: async (id) => (id === E1 ? { text: TEXT, speaker: "you", version: 1 } : undefined),
    userOwned: new Set(),
  };
  const cites = [{ id: E1, quote: "ship the importer first" }];
  const out = (sections: unknown) => ({ title: "Importer", brief: [{ text: "The importer ships first.", cites }], sections, addressedComments: [] });

  it("keeps the schema optional and names every section key", () => {
    expect(HUB_OUTPUT_SCHEMA.required).toEqual(["title", "brief", "addressedComments"]);
    expect([...HUB_SECTION_ALL].sort()).toEqual(["keyDecisions", "nextSteps", "openQuestions", "whatItIs", "whatWasFound", "whereItStands"]);
  });

  it("accepts a map with no sections (older prompt output)", async () => {
    const { sections: _omit, ...older } = out(undefined);
    const v = await validateHubOutput(older, vctx, "project");
    expect(v.valid).toBe(true);
    expect(v.doc.sections).toBeUndefined();
  });

  it("validates section statements like brief bullets and drops keys the map type does not carry", async () => {
    const v = await validateHubOutput(
      out({
        keyDecisions: [{ text: "Ship the importer first.", cites }, { text: "Ungrounded claim.", cites: [{ id: E1, quote: "this quote is not in the passage" }] }],
        whatItIs: [{ text: "Not for a project map.", cites }],
      }),
      vctx,
      "project",
    );
    expect(v.valid).toBe(true);
    expect(Object.keys(v.doc.sections ?? {})).toEqual(["keyDecisions"]);
    expect(v.doc.sections?.keyDecisions).toHaveLength(1);
    expect(v.droppedStatements).toBe(1);
    expect(v.rejected.some((r) => r.path === "$.sections.whatItIs" && r.reason === "not-allowed")).toBe(true);
  });

  it("asks the model for the sections of its map type", () => {
    const base = { id: "n_aaaaaaaaaaaaaaaa", title: "T", notes: [], quotes: [], comments: [] };
    expect(buildHubPrompt({ ...base, hubType: "project" }).prompt).toContain("nextSteps");
    expect(buildHubPrompt({ ...base, hubType: "area" }).prompt).toContain("whereItStands");
    expect(buildHubPrompt({ ...base, hubType: "topic" }).prompt).toContain("whatWasFound");
    expect([...HUB_SECTION_KEYS.project]).toEqual(["nextSteps", "openQuestions", "keyDecisions"]);
  });

  it("writes the sections into the map's file after the brief", () => {
    const cite = { entryId: E1 as never, version: 1, quote: "ship the importer first", speaker: "you" as const };
    const doc: HubDoc = {
      id: "n_aaaaaaaaaaaaaaaa" as never,
      hubType: "project",
      status: "active",
      title: "Importer",
      space: "code" as never,
      range: ["2026-11-01T00:00:00.000Z", "2026-11-09T00:00:00.000Z"] as never,
      members: [],
      madeBy: { runId: "r_aaaaaaaaaaaaaaaa", model: "sonnet", engine: "claude-cli", at: "2026-11-10T00:00:00.000Z" } as never,
      brief: [{ text: "The importer ships first.", cites: [cite] }],
      sections: { nextSteps: [{ text: "Write the exporter.", cites: [cite] }] },
      addressedComments: [],
    };
    const md = renderHubMarkdown(doc, "wiki/derived/maps/importer.md" as never).markdown;
    expect(md.indexOf("## Brief")).toBeLessThan(md.indexOf("## What comes next"));
    expect(md.indexOf("## What comes next")).toBeLessThan(md.indexOf("## Members"));
    expect(md).toContain("- Write the exporter. [^2]");
    expect(renderHubMarkdown({ ...doc, sections: undefined }, "wiki/derived/maps/importer.md" as never).markdown).not.toContain("## What comes next");
  });
});
