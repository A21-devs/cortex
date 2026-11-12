/**
 * pkg-09 entry and conversation readers (H-02): Edit and History as text links, "Read the full thread", Pin and Focus in
 * the brain as text actions; Related ranks up to 8 entries by shared terms and says which; the conversation gathers its
 * ideas and decisions, tags each part, and lists the quoted passages behind the note with the model-note caption.
 */
import { readFileSync } from "node:fs";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import type { ConversationDetail, EntryDetail } from "../src/plugin/services";
import type { Citation, ConversationRecord, EntryRecord, NoteRecord } from "../src/shared/types";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { t } from "../src/ui/copy";
import { ConversationView } from "../src/ui/reader/ConversationReader";
import { EntryView } from "../src/ui/reader/EntryReader";
import { gatherByKind, partChips, stemNotes, topicsOf, uniqueSources } from "../src/ui/reader/conversationParts";
import { filterRelated, joinTerms, rankRelated } from "../src/ui/reader/relatedRank";
import { fakeServices } from "./helpers/fakeServices";

const h = fakeServices();
const draw = (node: preact.ComponentChild) =>
  render(
    <ServicesContext.Provider value={h.services}>
      <LeafContext.Provider value={h.leaf}>{node}</LeafContext.Provider>
    </ServicesContext.Provider>,
  );

describe("Related ranking", () => {
  const hits = [
    { term: "sex", ordinals: [5, 6, 7, 1] },
    { term: "violence", ordinals: [6, 8, 1] },
    { term: "society", ordinals: [6, 5, 9] },
  ];
  it("puts the entries sharing the most terms first and lists the terms in chip order", () => {
    const rows = rankRelated(hits, (o) => o === 1);
    expect(rows[0]).toEqual({ ordinal: 6, terms: ["sex", "violence", "society"] });
    expect(rows[1]).toEqual({ ordinal: 5, terms: ["sex", "society"] });
    expect(rows.map((r) => r.ordinal)).toEqual([6, 5, 8, 7, 9]);
  });
  it("never lists the open entry and counts a term once", () => {
    const rows = rankRelated([{ term: "a", ordinals: [2, 2, 3] }], (o) => o === 3);
    expect(rows).toEqual([{ ordinal: 2, terms: ["a"] }]);
  });
  it("breaks ties by search position, then by first appearance", () => {
    const rows = rankRelated([{ term: "a", ordinals: [4, 3] }, { term: "b", ordinals: [9] }], () => false);
    expect(rows.map((r) => r.ordinal)).toEqual([4, 9, 3]);
  });
  it("filters by a term chip and caps at 8", () => {
    const many = Array.from({ length: 20 }, (_, i) => i);
    const rows = rankRelated([{ term: "x", ordinals: many }, { term: "y", ordinals: [3, 4] }], () => false);
    expect(filterRelated(rows, "", 8)).toHaveLength(8);
    expect(filterRelated(rows, "y", 8).map((r) => r.ordinal)).toEqual([3, 4]);
    expect(filterRelated(rows, "zzz", 8)).toEqual([]);
  });
  it("joins terms as a, b and c", () => {
    expect(joinTerms([])).toBe("");
    expect(joinTerms(["a"])).toBe("a");
    expect(joinTerms(["a", "b"])).toBe("a and b");
    expect(joinTerms(["sex", "violence", "society"])).toBe("sex, violence and society");
  });
});

const note = (over: Partial<NoteRecord> & { id: string; kind: NoteRecord["kind"] }): NoteRecord =>
  ({
    v: 1,
    seq: 1,
    title: over.id,
    text: `text of ${over.id}`,
    file: "wiki/derived/x.md",
    sources: [],
    madeBy: { runId: "r_1", model: "claude-sonnet-5-5", engine: "api", at: "2026-05-02T10:00:00Z" },
    space: "none",
    folder: [],
    state: "current",
    ...over,
  }) as unknown as NoteRecord;

const cite = (n: number, quote = `quote ${n}`): Citation => ({ entryId: `e_${String(n).padStart(16, "0")}`, version: 1, quote, speaker: "you", date: "2026-05-01T10:00:00Z" });

describe("conversation parts", () => {
  const parts = [
    { n: 1, title: "Login logo plan", notes: [note({ id: "n_1", kind: "plan", sources: [cite(1), cite(2)] }), note({ id: "n_2", kind: "decision", text: "Keep the circle logo", sources: [cite(2)] })] },
    { n: 2, title: "Chart configurator", notes: [note({ id: "n_3", kind: "idea", sources: [cite(3)] }), note({ id: "n_4", kind: "question" }), note({ id: "n_5", kind: "idea", sources: [cite(1)] })] },
  ];
  it("gathers ideas and decisions in part order", () => {
    expect(gatherByKind(parts, ["idea"]).map((n) => n.id)).toEqual(["n_3", "n_5"]);
    expect(gatherByKind(parts, ["decision"]).map((n) => n.id)).toEqual(["n_2"]);
  });
  it("keeps the other notes under their part", () => {
    expect(stemNotes(parts[0]!).map((n) => n.id)).toEqual(["n_1"]);
    expect(stemNotes(parts[1]!).map((n) => n.id)).toEqual(["n_4"]);
  });
  it("tags each part with a topic its text mentions, a stage and a status", () => {
    expect(partChips(parts[0]!, ["chart", "login logo"]).map((c) => `${c.field}:${c.text}`)).toEqual(["topic:login logo", "stage:Planning", "status:Decided"]);
    expect(partChips(parts[1]!, ["chart"]).map((c) => `${c.field}:${c.text}`)).toEqual(["topic:chart", "stage:Exploring", "status:Undecided"]);
    expect(partChips({ n: 3, notes: [] }, ["chart"])).toEqual([]);
  });
  it("marks a given-up idea as given up", () => {
    expect(partChips({ n: 1, notes: [note({ id: "n_9", kind: "abandoned" })] }, []).map((c) => c.text)).toEqual(["Given up"]);
  });
  it("lists each quoted passage once", () => {
    expect(uniqueSources(parts).map((c) => c.quote)).toEqual(["quote 1", "quote 2", "quote 3"]);
  });
  it("reads the stored topics", () => {
    expect(topicsOf(undefined)).toEqual([]);
    expect(topicsOf({ topics: ["a", " b "], work: "building" })).toEqual(["a", "b"]);
    expect(topicsOf({ topics: "solo" })).toEqual(["solo"]);
  });
});

const conversationDetail = (): ConversationDetail => {
  const gist = note({ id: "n_gist", kind: "gist", text: "A planning session.", facets: { work: "building", topics: ["login logo"] } });
  return {
    record: { v: 1, id: "c_aaaaaaaaaaaaaaaa", seq: 1, source: "claude-code", nativeId: "x", title: "Login logo", titledBy: "model", entryCount: 4, parts: [], space: "none", folder: [], updatedAt: "2026-05-02T10:00:00Z", startedAt: "2026-05-01T10:00:00Z", endedAt: "2026-05-01T11:00:00Z" } as unknown as ConversationRecord,
    gist,
    parts: [
      { n: 1, title: "Login logo plan", msgFrom: 1, msgTo: 2, notes: [note({ id: "n_1", kind: "plan", text: "Plan the login logo", sources: [cite(1)] }), note({ id: "n_2", kind: "decision", text: "Keep the circle logo", sources: [cite(2, "keep the circle")] })] },
      { n: 2, title: "Charts", msgFrom: 3, msgTo: 4, notes: [note({ id: "n_3", kind: "idea", text: "Let users reorder the pie charts", sources: [cite(3)] })] },
    ],
    corrections: [],
    comments: [],
  };
};

describe("conversation reader sections", () => {
  const html = draw(<ConversationView id="c_aaaaaaaaaaaaaaaa" detail={conversationDetail()} reload={() => undefined} />);
  it("names who tagged the conversation", () => {
    expect(html).toContain(t("reader.convTaggedBy", { model: "sonnet" }));
  });
  it("tags every part with topic, stage and status chips", () => {
    expect(html).toContain('data-field="topic"');
    expect(html).toContain('data-field="stage"');
    expect(html).toContain('data-field="status"');
    expect(html).toContain("Planning");
    expect(html).toContain("Decided");
    expect(html).toContain("Exploring");
  });
  it("gathers Ideas and Decisions into their own lists, and not again under the parts", () => {
    expect(html).toContain('id="cx-sec-conv-ideas"');
    expect(html).toContain('id="cx-sec-conv-decisions"');
    expect(html.match(/Keep the circle logo/g)).toHaveLength(1);
    expect(html.match(/Let users reorder the pie charts/g)).toHaveLength(1);
    expect(html).toContain("Plan the login logo");
  });
  it("counts the quoted passages and keeps them folded", () => {
    expect(html).toContain("Quoted passages (3)");
    expect(html).not.toContain("keep the circle");
  });
  it("carries the model-note caption with the show-source link and Pin and Focus as text actions", () => {
    expect(html).toContain(t("reader.convNoteCaption"));
    expect(html).toContain(t("reader.showSource"));
    expect(html).toContain("cx-text-actions");
    expect(html).toContain(t("reader.readFull"));
  });
  it("shows no ideas, decisions or passages sections for a conversation without notes", () => {
    const d = conversationDetail();
    d.parts = d.parts.map((p) => ({ ...p, notes: [] }));
    const bare = draw(<ConversationView id="c_aaaaaaaaaaaaaaaa" detail={d} reload={() => undefined} />);
    expect(bare).not.toContain("cx-sec-conv-ideas");
    expect(bare).not.toContain("Quoted passages");
  });
  it("lists your corrections in one section", () => {
    const d = conversationDetail();
    d.corrections = [{ v: 1, id: "x_1", target: "c_aaaaaaaaaaaaaaaa", action: "comment", payload: { text: "Not what I meant" }, at: "2026-05-03T10:00:00Z", via: "reader" } as never];
    const out = draw(<ConversationView id="c_aaaaaaaaaaaaaaaa" detail={d} reload={() => undefined} />);
    expect(out).toContain(t("reader.youSteppedIn"));
    expect(out).toContain("Not what I meant");
  });
});

const entryRecord = (): EntryRecord =>
  ({ v: 1, id: "e_aaaaaaaaaaaaaaaa", kind: "message", source: "claude-code", sourceRef: { path: "x" }, speaker: "you", text: { kind: "inline" }, textSha256: "", chars: 5, words: 1, dates: [], existedBy: "2026-05-01T10:00:00Z", addedAt: "2026-05-01T10:00:00Z", writtenAt: "2026-05-01T10:00:00Z", space: "none", folder: [], conv: "c_aaaaaaaaaaaaaaaa" }) as unknown as EntryRecord;

const entryDetail = (): EntryDetail =>
  ({
    record: entryRecord(),
    text: { ok: true, text: "Hello there", version: 1 },
    versions: [],
    labels: [],
    history: [],
    citedBy: [],
    reads: { count: 0, models: [] },
    storage: { path: "" },
    related: [{ term: "hello", count: 3 }, { term: "there", count: 2 }],
    secrets: [],
    dateEvidence: [],
    conversation: { id: "c_aaaaaaaaaaaaaaaa", title: "A chat", index: 0, count: 4, speakers: ["you", "assistant", "you", "assistant"], parts: [] },
  }) as unknown as EntryDetail;

describe("entry reader text actions", () => {
  const html = draw(<EntryView id="e_aaaaaaaaaaaaaaaa" ordinal={0} detail={entryDetail()} reload={() => undefined} />);
  it("has Edit and History links at the title and jumps to the history section", () => {
    expect(html).toContain("cx-head-links");
    expect(html).toContain(`>${t("reader.editLink")}<`);
    expect(html).toContain('id="cx-sec-history"');
  });
  it("has Read the full thread, and Pin and Focus in the brain as text beside the icon pair", () => {
    expect(html).toContain(`>${t("reader.readFull")}<`);
    expect(html).toContain("cx-text-actions");
    expect(html).toContain(t("reader.focusInBrain"));
    expect(html).toContain("cx-text-icons");
  });
  it("draws the Related section with a filter chip per term", () => {
    expect(html).toContain('id="cx-sec-related"');
    expect(html).toContain("cx-term");
  });
  it("leaves Read the full thread out for an entry with no conversation", () => {
    const d = entryDetail();
    delete (d as { conversation?: unknown }).conversation;
    expect(draw(<EntryView id="e_aaaaaaaaaaaaaaaa" ordinal={0} detail={d} reload={() => undefined} />)).not.toContain(t("reader.readFull"));
  });
});

describe("styles", () => {
  const css = readFileSync(new URL("../src/styles/reader-entry.css", import.meta.url), "utf8");
  const entry = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  it("is imported after desktop-shell.css and swaps the icon pair for text at 340 px", () => {
    expect(entry.indexOf("reader-entry.css")).toBeGreaterThan(entry.indexOf("desktop-shell.css"));
    expect(css).toContain("@container (min-width: 340px)");
    expect(css).toMatch(/\.cx-text-icons \{ display: none; \}/);
  });
  it("lets related rows wrap their second line", () => {
    expect(css).toMatch(/\.cx-related-rows \.cx-row > \.cx-row-meta \{[^}]*white-space: normal/);
  });
});
