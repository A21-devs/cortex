/**
 * Entry reader context (P18): the title and kind line while the body loads, the "Source · folder" line, the
 * conversation part sentence, labels by pack ("not labelled yet"), and collapsible counted sections that remember
 * their state on this device.
 */
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import type { EntryDetail, LabelView } from "../src/plugin/services";
import { SESSION_PACK } from "../src/shared/packs";
import type { EntryRecord, LabelRecord } from "../src/shared/types";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { emptyDeviceState, parseDeviceState, sectionOpen, setSectionOpen } from "../src/ui/deviceState";
import { EntryView, PackTable } from "../src/ui/reader/EntryReader";
import { labelFields } from "../src/ui/reader/readerKit";
import { connectedRecordIds, folderPathOf, labelsByPack, partSentence, sourceFolderText } from "../src/ui/reader/entryContext";
import { Section } from "../src/ui/reader/marks";
import { ReaderOpening } from "../src/ui/reader/readerKit";
import { fakeServices } from "./helpers/fakeServices";

const h = fakeServices();
const wrapWith = (services: unknown, node: preact.ComponentChild) =>
  render(
    <ServicesContext.Provider value={services as never}>
      <LeafContext.Provider value={h.leaf}>{node}</LeafContext.Provider>
    </ServicesContext.Provider>,
  );
const wrap = (node: preact.ComponentChild) => wrapWith(h.services, node);

const record = (over: Partial<EntryRecord> = {}): EntryRecord =>
  ({
    v: 1,
    id: "e_aaaaaaaaaaaaaaaa",
    kind: "message",
    source: "claude-code",
    sourceRef: { path: "x" },
    speaker: "you",
    text: { kind: "inline" },
    textSha256: "",
    chars: 5,
    words: 1,
    dates: [],
    existedBy: "2026-05-01T10:00:00Z",
    addedAt: "2026-05-01T10:00:00Z",
    writtenAt: "2026-05-01T10:00:00Z",
    space: "none",
    folder: ["work", "cortex"],
    ...over,
  }) as unknown as EntryRecord;

const detail = (r: EntryRecord, over: Partial<EntryDetail> = {}): EntryDetail => ({
  record: r,
  text: { ok: true, text: "Hello there", version: 1 },
  versions: [],
  labels: [],
  history: [],
  citedBy: [],
  reads: { count: 0, models: [] },
  storage: { path: "" },
  related: [],
  secrets: [],
  dateEvidence: [],
  ...over,
});

const label = (field: string, value: string, over: Partial<LabelRecord> = {}, byUser = false): LabelView => ({
  byUser,
  label: { v: 1, id: `l_${field}`, target: "c_x", pack: "session", packVersion: "1.0.0", field, value, state: "set", by: byUser ? { user: true } : { model: "claude-haiku-4-5", runId: "r_1", engine: "claude-code" }, at: "2026-05-02T10:00:00Z", ...over } as unknown as LabelRecord,
});

describe("early title while the body loads (READ-02)", () => {
  it("draws the title, source and date from the index and keeps Opening… in the body slot", () => {
    const meta = { ordinal: 3, id: "e_aaaaaaaaaaaaaaaa", title: "Fixing the layout worker", kind: 0, population: "record", source: "claude-code", speaker: "you", writtenAt: "2026-05-01T10:00:00Z", folder: "work/cortex", space: "none", words: 4, flags: 0 };
    const svc = { ...h.services, index: { index: h.services.index.index, ordinalOf: () => 3, meta: () => meta, load: async () => undefined, dispose: () => undefined } };
    const html = wrapWith(svc, <ReaderOpening ordinal={3} />);
    expect(html).toContain("Fixing the layout worker");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Opening…");
    expect(html).toContain("cx-reader-title");
  });
  it("is just the placeholder when the index knows nothing about the ordinal", () => {
    const html = wrap(<ReaderOpening ordinal={-1} />);
    expect(html).toContain("Opening…");
    expect(html).not.toContain("cx-reader-title");
  });
});

describe("source and folder line (READ-05)", () => {
  it("joins the source and the folder path, and names the inbox when the entry has no folder", () => {
    expect(folderPathOf(record())).toBe("work/cortex");
    expect(sourceFolderText(record())).toBe("Claude Code · work/cortex");
    expect(sourceFolderText(record({ folder: [] }))).toBe("Claude Code · Inbox");
  });
  it("shows in the entry reader, the folder as a link that filters Read", () => {
    const html = wrap(<EntryView id="e_aaaaaaaaaaaaaaaa" ordinal={0} detail={detail(record())} reload={() => undefined} />);
    expect(html).toContain("cx-source-folder");
    expect(html).toContain("work/cortex");
    expect(html).toContain("Show this folder in Read");
    expect(wrap(<EntryView id="e_aaaaaaaaaaaaaaaa" ordinal={0} detail={detail(record({ folder: [] }))} reload={() => undefined} />)).toContain("Inbox");
  });
});

describe("conversation part sentence (READ-13)", () => {
  const short = (m: string) => (/(haiku|sonnet|opus)/i.exec(m)?.[1] ?? m).toLowerCase();
  const conv = (parts: { n: number; title?: string }[], titledBy: "model" | "user" = "model") =>
    ({
      record: { titledBy },
      gist: { madeBy: { model: "claude-sonnet-5-5", at: "2026-05-02T10:00:00Z" } },
      parts: parts.map((p) => ({ ...p, msgFrom: 1, msgTo: 2 })),
    }) as never;
  it("names the part, the count and the title, and who titled it", () => {
    const d = conv([{ n: 1, title: "Setting up" }, { n: 2, title: "Fixing the build" }]);
    expect(partSentence(d, 2, short)?.text).toBe("Part 2 of 2: “Fixing the build”, titled by sonnet");
    expect(partSentence(conv([{ n: 1, title: "A" }, { n: 2, title: "B" }], "user"), 1, short)?.text).toBe("Part 1 of 2: “A”, titled by you");
  });
  it("is hidden for one part, an unknown part or no part number", () => {
    expect(partSentence(conv([{ n: 1, title: "Only" }]), 1, short)).toBeNull();
    expect(partSentence(conv([{ n: 1 }, { n: 2 }]), 7, short)).toBeNull();
    expect(partSentence(conv([{ n: 1 }, { n: 2 }]), undefined, short)).toBeNull();
    expect(partSentence(conv([{ n: 1 }, { n: 2 }]), 2, short)?.text).toBe("Part 2 of 2");
  });
});

describe("labels by pack (READ-16)", () => {
  it("lists every field of every pack that applies as a row: 'blank', a + to add, and the pack with its version", () => {
    const { blocks, setCount } = labelsByPack([], { inConversation: true });
    expect(setCount).toBe(0);
    expect(blocks.map((b) => b.pack.id)).toContain("session");
    expect(blocks.every((b) => b.set === 0)).toBe(true);
    const plain = render(<PackTable blocks={blocks} />);
    expect(plain).toContain("blank");
    expect(plain).toContain("session · 1.0.0");
    expect(plain).not.toContain("cx-blank-add");
    const html = render(<PackTable blocks={blocks} onAdd={() => undefined} />);
    const rows = (html.match(/<tr data-pack=/g) ?? []).length;
    expect(rows).toBe(blocks.reduce((n, b) => n + b.rows.length, 0));
    expect((html.match(/cx-blank-add/g) ?? []).length).toBe(rows);
    expect(html).toContain("Field");
    expect(html).toContain("Pack");
    expect(html).not.toMatch(/no labels yet|Save a copy|Tags \d+%/);
  });
  it("keeps a muted blank row (with its +) beside a set value in the same pack", () => {
    const first = SESSION_PACK.fields[0]?.key ?? "work";
    const { blocks } = labelsByPack([label(first, "debug")], { inConversation: true });
    const html = render(<PackTable blocks={blocks} onAdd={() => undefined} />);
    expect(html).toContain("debug");
    expect(html).toContain("is-blank");
    expect(html).toContain(`data-field="${first}"`);
  });
  it("shows set values with their author; your own label wins over a model's", () => {
    const first = SESSION_PACK.fields[0]?.key ?? "work";
    const { blocks, setCount } = labelsByPack([label(first, "debug"), label(first, "build", {}, true)], { inConversation: true });
    expect(setCount).toBe(1);
    const row = blocks.find((b) => b.pack.id === "session")?.rows.find((r) => r.field === first);
    expect(row?.value).toMatchObject({ text: "build", byUser: true });
    const html = render(<PackTable blocks={blocks} />);
    expect(html).toContain("build");
    expect(html).toContain("is-yours");
    expect(html).toContain("Field");
  });
  it("opens the editor on every pack shown in the table (a conversation's fields include the résumé pack)", () => {
    const fields = labelFields([], { entryId: "e_aaaaaaaaaaaaaaaa", conversationId: "c_x" });
    expect(fields.map((f) => f.pack.id)).toEqual(expect.arrayContaining(["session", "resume", "correction"]));
    const { blocks } = labelsByPack([], { inConversation: true });
    for (const b of blocks) expect(fields.some((f) => f.pack.id === b.pack.id), b.pack.id).toBe(true);
  });
  it("counts in the section heading", () => {
    const html = wrap(<EntryView id="e_aaaaaaaaaaaaaaaa" ordinal={0} detail={detail(record({ conv: "c_x" as never }), { labels: [label("work", "debug")] })} reload={() => undefined} />);
    expect(html).toContain("Labels by pack (1)");
    expect(html).toContain("debug");
  });
});

describe("collapsible counted sections (READ-17)", () => {
  it("renders a counted heading with aria-expanded and hides the body when closed", () => {
    const open = wrap(
      <Section id="cx-sec-test-a" collapsible defaultOpen count={2} label="Connected notes">
        <p>BODY</p>
      </Section>,
    );
    expect(open).toContain("Connected notes (2)");
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("BODY");
    const closed = wrap(
      <Section id="cx-sec-test-b" collapsible defaultOpen={false} count={0} label="Model activity">
        <p>BODY</p>
      </Section>,
    );
    expect(closed).toContain("Model activity (0)");
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("BODY");
  });
  it("remembers the choice per section id on this device", () => {
    h.services.device.update((d) => setSectionOpen(d, "cx-sec-test-c", false));
    const html = wrap(
      <Section id="cx-sec-test-c" collapsible defaultOpen label="Remembered">
        <p>BODY</p>
      </Section>,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("BODY");
    h.services.device.update((d) => setSectionOpen(d, "cx-sec-test-c", true));
    expect(wrap(<Section id="cx-sec-test-c" collapsible defaultOpen={false} label="Remembered"><p>BODY</p></Section>)).toContain("BODY");
  });
  it("persists through the device state parse and ignores junk", () => {
    const s = setSectionOpen(emptyDeviceState(), "cx-sec-folder", true);
    expect(sectionOpen(parseDeviceState(JSON.parse(JSON.stringify(s))), "cx-sec-folder", false)).toBe(true);
    expect(sectionOpen(emptyDeviceState(), "cx-sec-folder", false)).toBe(false);
    expect(parseDeviceState({ sectionsOpen: { a: true, b: "no", c: 3 } }).sectionsOpen).toEqual({ a: true });
    expect(parseDeviceState({ sectionsOpen: [true] }).sectionsOpen).toBeUndefined();
  });
  it("the entry reader carries every section with its count and 'Nothing yet' when empty", () => {
    const html = wrap(<EntryView id="e_aaaaaaaaaaaaaaaa" ordinal={0} detail={detail(record())} reload={() => undefined} />);
    expect(html).toContain("Folder");
    expect(html).toContain("Connected records (0)");
    expect(html).toContain("Connected notes (0)");
    expect(html).toContain("Model activity (0)");
    expect(html).toContain("Nothing yet");
  });
  it("model activity counts reads and model labels", () => {
    const html = wrap(<EntryView id="e_aaaaaaaaaaaaaaaa" ordinal={0} detail={detail(record(), { reads: { count: 2, models: ["claude-sonnet-5-5"], last: "2026-05-03T10:00:00Z" } })} reload={() => undefined} />);
    expect(html).toContain("Model activity (2)");
  });
  it("connected record ids drop the entry itself and repeats and keep the replaced entry first", () => {
    expect(connectedRecordIds("e_a", [["e_a", "e_b", "e_c"], ["e_b", "e_d"]], "e_old")).toEqual(["e_old", "e_b", "e_c", "e_d"]);
    expect(connectedRecordIds("e_a", [], undefined)).toEqual([]);
    expect(connectedRecordIds("e_a", [["e_1", "e_2", "e_3"]], undefined, 2)).toEqual(["e_1", "e_2"]);
  });
});
