/**
 * Read page open-item highlight, typed map sections in Find and Ask, and the "paid by" column of the Lab's
 * Conversations tagged table (SPEC V13, V14, V17).
 */
import { describe, expect, it } from "vitest";
import { hubBodyText, type HubFields, type NoteRecord, type RunRecord } from "../src/shared/types";
import { machineNoteDoc } from "../src/store/searchIndex";
import { paidByOf, taggedRows } from "../src/ui/pages/labTables";
import { openItemOrdinal } from "../src/ui/pages/Read";

const st = (text: string) => ({ text, cites: [] });

describe("Read: open item", () => {
  it("takes the selected ordinal, or -1 when nothing is selected", () => {
    expect(openItemOrdinal({ ordinal: 7 })).toBe(7);
    expect(openItemOrdinal({ ordinal: 0 })).toBe(0);
    expect(openItemOrdinal(null)).toBe(-1);
    expect(openItemOrdinal(undefined)).toBe(-1);
    expect(openItemOrdinal({ ordinal: -1 })).toBe(-1);
  });
});

describe("map sections reach Find and Ask", () => {
  const hub: Pick<HubFields, "hubType" | "brief" | "sections"> = {
    hubType: "project",
    brief: [st("Importer rewrite.")],
    sections: { keyDecisions: [st("Use streaming.")], nextSteps: [st("Write the exporter.")], openQuestions: [], whatItIs: [st("ignored for a project")] },
  };

  it("joins the brief and the type's sections in reading order", () => {
    expect(hubBodyText(hub)).toBe("Importer rewrite.\nWrite the exporter.\nUse streaming.");
    expect(hubBodyText({ hubType: "project", brief: [st("b")] })).toBe("b");
  });

  it("heads each section for the Ask prompt", () => {
    expect(hubBodyText(hub, true)).toBe("Importer rewrite.\nWhat comes next:\nWrite the exporter.\nWhat was decided:\nUse streaming.");
  });

  it("tolerates a map record with no brief", () => {
    expect(hubBodyText({ hubType: "area", brief: undefined as unknown as HubFields["brief"], sections: { whatItIs: [st("A shelf.")] } })).toBe("A shelf.");
  });

  it("indexes the section text of a map note for search", () => {
    const note = { title: "Importer", text: "A project map.", hub: { ...hub, status: "active", range: ["2026-01-01", "2026-02-01"], members: [] } } as unknown as NoteRecord;
    const doc = machineNoteDoc(note);
    expect(doc.body).toContain("Write the exporter.");
    expect(doc.body).toContain("Use streaming.");
    expect(doc.body).not.toContain("ignored for a project");
    expect(machineNoteDoc({ title: "Plain", text: "Just a note." } as unknown as NoteRecord).body).toBe("Just a note.");
  });
});

describe("Lab: paid by", () => {
  it("is the shared payer of the runs, or mixed", () => {
    expect(paidByOf([{ paidBy: "plan" }, { paidBy: "plan" }])).toBe("plan");
    expect(paidByOf([{ paidBy: "api" }])).toBe("api");
    expect(paidByOf([{ paidBy: "none" }])).toBe("none");
    expect(paidByOf([{ paidBy: "plan" }, { paidBy: "api" }])).toBe("mixed");
    expect(paidByOf([{ paidBy: "plan" }, { paidBy: "none" }])).toBe("mixed");
    expect(paidByOf([])).toBe("none");
    expect(paidByOf([{ paidBy: undefined as unknown as "plan" }])).toBe("none");
  });

  it("carries the payer on each tagged row", () => {
    const run = (p: Partial<RunRecord>): RunRecord => ({ v: 1, id: "r_aaaaaaaaaaaaaaaa", job: "label", pass: 1, engine: "claude-cli", model: "haiku", where: "remote", paidBy: "plan", startedAt: "2026-11-10T09:00:00.000Z", status: "finished", targets: [], items: 1, labels: 1, declined: 0, noAnswer: 0, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensEstimated: false, costUsd: 0, priceTableDate: "2026-01-01", promptVersion: "label@2.0.0", ...p }) as RunRecord;
    const rows = taggedRows([run({ pack: "p", model: "haiku" }), run({ pack: "p", model: "haiku", paidBy: "api", startedAt: "2026-11-09T09:00:00.000Z" }), run({ pack: "q", model: "local", paidBy: "none", where: "this computer", startedAt: "2026-11-08T09:00:00.000Z" })]);
    expect(rows.map((r) => [r.model, r.paidBy])).toEqual([["haiku", "mixed"], ["local", "none"]]);
  });
});
