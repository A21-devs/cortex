/**
 * Notion and Google Docs importers: name and tree rules, dates, the in-memory docx reader, whole passes over
 * synthetic exports (zip, zip of zips, folder, one docx), versions on a newer export, inspect and the registry.
 * Every export here is built in a temp folder from invented text.
 */
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeXml, docxCore, docxText, googleDocPages, looksLikeGoogleDocs, readZipMembers } from "../src/importers/docx";
import { EXTRA_GROUPS, extraImporters } from "../src/importers/extra";
import { inspectExport } from "../src/importers/inspect";
import { looksLikeNotion, notionName, notionPageDate, notionPages, parseNotionDate, wrapperOf } from "../src/importers/notion";
import { createImporters } from "../src/importers/registry";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { loadSourceManifest } from "../src/store/manifest";
import { buildZip, harness, tmpDir, writeZip, type ZipMember } from "./helpers/importHarness";

const ID_A = "0123456789abcdef0123456789abcdef";
const ID_B = "fedcba9876543210fedcba9876543210";
const ID_C = "aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb";
const ID_D = "11111111111111112222222222222222";

const ROADMAP = `# Roadmap

Created: March 1, 2024 10:30 AM
Tags: planning, q2

## Goals

Ship the importer for notes exports.

## Risks

Dates in an export are only as good as the export.
`;
const CHILD = `# Sprint notes

Last Edited Time: March 9, 2024 4:05 PM

We agreed to keep the page tree as it is.
`;
const TABLE = "Name,Status\nWrite tests,Done\nShip,Open\n";

function notionMembers(roadmap = ROADMAP): ZipMember[] {
  return [
    { name: `Roadmap ${ID_A}.md`, data: roadmap, deflate: true },
    { name: `Roadmap ${ID_A}/Sprint notes ${ID_B}.md`, data: CHILD },
    { name: `Roadmap ${ID_A}/Sprint notes ${ID_B}/Retro ${ID_C}.md`, data: "# Retro\n\nWhat went well: the tests.\n" },
    { name: `Tasks ${ID_D}.csv`, data: TABLE },
    { name: `Tasks ${ID_D}_all.csv`, data: TABLE },
    { name: `Roadmap ${ID_A}/image.png`, data: Buffer.from([1, 2, 3]) },
  ];
}

describe("Notion names, tree and dates", () => {
  it("splits titles from ids and recognises an export", () => {
    expect(notionName(`Roadmap ${ID_A}`)).toEqual({ title: "Roadmap", id: ID_A, all: false });
    expect(notionName(`Tasks ${ID_D}_all`)).toMatchObject({ title: "Tasks", all: true });
    expect(notionName("Plain")).toEqual({ title: "Plain", all: false });
    expect(looksLikeNotion([`a/Roadmap ${ID_A}.md`])).toBe(true);
    expect(looksLikeNotion(["conversations.json", "notes.md"])).toBe(false);
    expect(wrapperOf([`Export-1/Roadmap ${ID_A}.md`, `Export-1/x/y.md`])).toBe("Export-1/");
    expect(wrapperOf([`Roadmap ${ID_A}.md`, `Roadmap ${ID_A}/x.md`])).toBe("");
  });
  it("keeps the page tree and drops the duplicate _all table", () => {
    const pages = notionPages(notionMembers().map((m) => ({ name: m.name, size: 10 })));
    expect(pages.map((p) => [p.name.title, p.ancestors.join(" > "), p.csv])).toEqual([
      ["Roadmap", "", false],
      ["Sprint notes", "Roadmap", false],
      ["Retro", "Roadmap > Sprint notes", false],
      ["Tasks", "", true],
    ]);
  });
  it("reads the dates a page names, as written and never from the future", () => {
    expect(parseNotionDate("March 1, 2024 10:30 AM")).toBe("2024-03-01T10:30:00.000Z");
    expect(parseNotionDate("@March 1, 2024 12:15 PM")).toBe("2024-03-01T12:15:00.000Z");
    expect(parseNotionDate("March 1, 2024 12:15 AM")).toBe("2024-03-01T00:15:00.000Z");
    expect(parseNotionDate("Sep 3, 2023")).toBe("2023-09-03T00:00:00.000Z");
    expect(parseNotionDate("2024-02-29")).toBe("2024-02-29T00:00:00.000Z");
    expect(parseNotionDate("February 30, 2024")).toBeUndefined();
    expect(parseNotionDate("soon")).toBeUndefined();
    expect(notionPageDate(ROADMAP)).toEqual({ at: "2024-03-01T10:30:00.000Z", detail: "Created" });
    expect(notionPageDate(CHILD)).toEqual({ at: "2024-03-09T16:05:00.000Z", detail: "Last edited" });
    expect(notionPageDate("# Title\n\nJust a paragraph, no properties.\n")).toBeUndefined();
    expect(notionPageDate("# Title\n\nNote: this is text\nand more text\n")).toBeUndefined();
  });
});

// ───────────────────────────── docx ─────────────────────────────

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const para = (text: string, style?: string, list = false): string => `<w:p>${style || list ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${list ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ""}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const documentXml = (body: string): string => `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`;
const coreXml = (created?: string, modified?: string, title?: string): string =>
  `<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y" xmlns:dcterms="z">${title ? `<dc:title>${title}</dc:title>` : ""}${created ? `<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>` : ""}${modified ? `<dcterms:modified xsi:type="dcterms:W3CDTF">${modified}</dcterms:modified>` : ""}</cp:coreProperties>`;

function docx(body: string, core?: { created?: string; modified?: string; title?: string }): Buffer {
  return buildZip([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "word/document.xml", data: documentXml(body), deflate: true },
    ...(core ? [{ name: "docProps/core.xml", data: coreXml(core.created, core.modified, core.title) }] : []),
  ]);
}

const PLAN_BODY = para("Project plan", "Heading1") + para("Tom &amp; Jerry shipped the draft.") + para("First step", undefined, true) + para("Second step", undefined, true) + para("Closing words.");

describe("docx reader", () => {
  it("turns paragraphs, headings, lists and tables into text", () => {
    const table = "<w:tbl><w:tr><w:tc>" + para("Item") + "</w:tc><w:tc>" + para("Count") + "</w:tc></w:tr><w:tr><w:tc>" + para("Pens") + "</w:tc><w:tc>" + para("3") + "</w:tc></w:tr></w:tbl>";
    const text = docxText(documentXml(PLAN_BODY + table));
    expect(text).toBe("# Project plan\n\nTom & Jerry shipped the draft.\n\n- First step\n- Second step\n\nClosing words.\n\nItem | Count\n\nPens | 3");
    expect(docxText(documentXml('<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p><w:p/>'))).toBe("a\tb\nc");
    expect(decodeXml("&#65;&#x42;&lt;&bogus;")).toBe("AB<&bogus;");
  });
  it("reads document properties", () => {
    expect(docxCore(coreXml("2023-05-01T08:00:00Z", "2023-06-01T09:30:00Z", "My plan"))).toEqual({ title: "My plan", created: "2023-05-01T08:00:00.000Z", modified: "2023-06-01T09:30:00.000Z" });
    expect(docxCore(coreXml("not a date"))).toEqual({});
  });
  it("reads named members from memory, and refuses what it should", () => {
    const buf = docx(para("hello"), { created: "2023-05-01T08:00:00Z" });
    const got = readZipMembers(buf, ["word/document.xml", "docProps/core.xml", "missing.xml"]);
    expect([...got.keys()].sort()).toEqual(["docProps/core.xml", "word/document.xml"]);
    expect(got.get("word/document.xml")?.toString("utf8")).toContain("hello");
    expect(readZipMembers(buf, ["word/document.xml"], 10).size).toBe(0);
    expect(readZipMembers(Buffer.from("not a zip at all"), ["x"]).size).toBe(0);
    expect(readZipMembers(Buffer.alloc(0), ["x"]).size).toBe(0);
  });
  it("lists documents under Takeout/Drive and skips bookkeeping", () => {
    const names = ["Takeout/archive_browser.html", "Takeout/Drive/Work/Plan.docx", "Takeout/Drive/Loose.html", "Takeout/Drive/Sheet.xlsx", "Takeout/Drive/Work/~$Plan.docx"];
    expect(looksLikeGoogleDocs(names)).toBe(true);
    expect(looksLikeGoogleDocs(["chat.html", "conversations.json"])).toBe(false);
    const pages = googleDocPages(names.map((name) => ({ name, size: 5 })));
    expect(pages.map((p) => [p.rel, p.ancestors.join("/"), p.html])).toEqual([
      ["Work/Plan.docx", "Work", false],
      ["Loose.html", "", true],
    ]);
  });
});

// ───────────────────────────── whole passes ─────────────────────────────

const notion = () => createImporters().notion;
const gdocs = () => createImporters()["google-docs"];

describe("registry and settings", () => {
  it("register through importers/extra", () => {
    expect(Object.keys(extraImporters())).toEqual(expect.arrayContaining(["notion", "google-docs"]));
    expect(EXTRA_GROUPS.map((g) => g.name)).toContain("notesDocs");
    expect(createImporters().notion.source).toBe("notion");
    expect(DEFAULT_SETTINGS.sources.notion.enabled).toBe(true);
  });
});

describe("Notion pass", () => {
  it("imports pages, passages and the table, with the tree, dates and bounds", async () => {
    const file = await writeZip(notionMembers());
    const h = await harness();
    const stats = await notion().run({ kind: "notion", file }, h.ctx);
    expect(stats.errors).toEqual([]);
    const entries = await h.entries();
    const docs = entries.filter((e) => e.kind === "document");
    expect(docs.map((e) => e.title).sort()).toEqual(["Retro", "Roadmap", "Sprint notes", "Tasks"]);
    expect(entries.every((e) => e.source === "notion" && e.speaker === "you")).toBe(true);
    const roadmap = docs.find((e) => e.title === "Roadmap");
    expect(await h.text(roadmap as never)).toBe(ROADMAP);
    expect(roadmap?.project).toBe("Roadmap");
    expect(roadmap?.folder).toEqual(["Notion"]);
    expect(roadmap?.writtenAt).toBe("2024-03-01T10:30:00.000Z");
    const types = roadmap?.dates.map((d) => `${d.type}:${d.strength}`);
    expect(types).toEqual(expect.arrayContaining(["source-timestamp:medium", "file-mtime:bound", "ingest:bound"]));
    const retro = docs.find((e) => e.title === "Retro");
    expect(retro?.project).toBe("Roadmap");
    expect(retro?.folder).toEqual(["Notion", "Roadmap", "Sprint notes"]);
    expect(retro?.writtenAt).toBeUndefined();
    expect(retro?.dates.some((d) => d.strength === "bound")).toBe(true);
    // The two headings of the Roadmap page also become passages.
    const passages = entries.filter((e) => e.kind === "passage" && e.passage?.doc === roadmap?.id);
    expect(passages.map((p) => p.passage?.heading)).toEqual([undefined, "Goals", "Risks"]);
    const table = docs.find((e) => e.title === "Tasks");
    expect(await h.text(table as never)).toBe(TABLE);
    expect((await loadSourceManifest(h.ctx.store)).sources.notion).toMatchObject({ kind: "notion", status: "imported" });
  });

  it("adds only what changed from a newer export, as a new version of the page", async () => {
    const h = await harness();
    await notion().run({ kind: "notion", file: await writeZip(notionMembers()) }, h.ctx);
    const before = (await h.entries()).length;
    const same = await notion().run({ kind: "notion", file: await writeZip(notionMembers()) }, h.next());
    expect(same.entriesAdded).toBe(0);
    const newer = ROADMAP.replace("Ship the importer", "Ship the notes importer and the agent importers");
    const again = await notion().run({ kind: "notion", file: await writeZip(notionMembers(newer)) }, h.next());
    expect(again.entriesAdded).toBeGreaterThan(0);
    const entries = await h.entries();
    expect(entries.length).toBeGreaterThan(before);
    const versions = entries.filter((e) => e.kind === "document" && e.title === "Roadmap");
    expect(versions).toHaveLength(2);
    expect(versions[1]?.supersedes).toBe(versions[0]?.id);
    expect(entries.filter((e) => e.kind === "document" && e.title === "Retro")).toHaveLength(1);
  });

  it("reads an unzipped folder and a zip of zip parts", async () => {
    const dir = await tmpDir();
    for (const m of notionMembers()) {
      const f = path.join(dir, "Export-1", m.name);
      await fsp.mkdir(path.dirname(f), { recursive: true });
      await fsp.writeFile(f, m.data);
    }
    const h = await harness();
    const a = await notion().run({ kind: "notion", file: dir }, h.ctx);
    expect(a.entriesAdded).toBeGreaterThan(0);
    expect((await h.entries()).find((e) => e.title === "Retro")?.folder).toEqual(["Notion", "Roadmap", "Sprint notes"]);
    const outer = await writeZip([{ name: "Export-abc-Part-1.zip", data: buildZip(notionMembers()) }]);
    const h2 = await harness();
    const b = await notion().run({ kind: "notion", file: outer }, h2.ctx);
    expect(b.errors).toEqual([]);
    expect((await h2.entries()).filter((e) => e.kind === "document")).toHaveLength(4);
    const insp = await inspectExport({ file: outer }, h2.ctx);
    expect(insp).toMatchObject({ kind: "notion", conversations: 4 });
  });

  it("does nothing when turned off, and refuses a path under an Off limits row", async () => {
    const file = await writeZip(notionMembers());
    const off = await harness((s) => void (s.sources.notion.enabled = false));
    expect((await notion().run({ kind: "notion", file }, off.ctx)).filesSeen).toBe(0);
    expect(await off.entries()).toHaveLength(0);
    const blocked = await harness((s) => void (s.privacy.offLimits = [{ path: path.dirname(file), reason: "test" }]));
    const stats = await notion().run({ kind: "notion", file }, blocked.ctx);
    expect(stats.errors).toHaveLength(1);
    expect(await blocked.entries()).toHaveLength(0);
  });

  it("is recognised by import.inspect, and a plain zip is not", async () => {
    const h = await harness();
    const res = await inspectExport({ file: await writeZip(notionMembers()) }, h.ctx);
    expect(res).toMatchObject({ kind: "notion", conversations: 4, projects: 2 });
    const plain = await inspectExport({ file: await writeZip([{ name: "readme.txt", data: "hi" }]) }, h.ctx);
    expect(plain.kind).toBe("unknown");
  });
});

describe("Google Docs pass", () => {
  const takeout = (): ZipMember[] => [
    { name: "Takeout/archive_browser.html", data: "<html>index</html>" },
    { name: "Takeout/Drive/Work/Plan.docx", data: docx(PLAN_BODY, { created: "2023-05-01T08:00:00Z", modified: "2023-06-01T09:30:00Z", title: "Q2 plan" }) },
    { name: "Takeout/Drive/Loose.docx", data: docx(para("A loose note about gardening.")) },
    { name: "Takeout/Drive/Draft.html", data: "<html><head><title>Draft post</title></head><body><h1>Hello</h1><p>An html document.</p></body></html>" },
    { name: "Takeout/Drive/Budget.xlsx", data: Buffer.from("not read") },
    { name: "Takeout/Drive/Link.gdoc", data: '{"url":"https://docs.google.com/x"}' },
  ];

  it("imports docx and html documents with the folder tree and the document's own dates", async () => {
    const file = await writeZip(takeout());
    const h = await harness();
    const stats = await gdocs().run({ kind: "google-docs", file }, h.ctx);
    expect(stats.errors).toEqual([]);
    const docs = (await h.entries()).filter((e) => e.kind === "document");
    expect(docs.map((e) => e.title).sort()).toEqual(["Draft post", "Loose", "Q2 plan"]);
    const plan = docs.find((e) => e.title === "Q2 plan");
    expect(plan?.source).toBe("google-docs");
    expect(plan?.project).toBe("Work");
    expect(plan?.folder).toEqual(["Google Docs", "Work"]);
    expect(plan?.writtenAt).toBe("2023-05-01T08:00:00.000Z");
    expect(plan?.dates.find((d) => d.strength === "bound" && d.detail?.includes("last modified"))?.at).toBe("2023-06-01T09:30:00.000Z");
    expect(await h.text(plan as never)).toContain("Tom & Jerry shipped the draft.");
    const loose = docs.find((e) => e.title === "Loose");
    expect(loose?.project).toBeUndefined();
    expect(loose?.writtenAt).toBeUndefined();
    expect(await h.text(docs.find((e) => e.title === "Draft post") as never)).toContain("An html document.");
    // A second pass over the same export adds nothing.
    expect((await gdocs().run({ kind: "google-docs", file }, h.next())).entriesAdded).toBe(0);
  });

  it("is recognised by import.inspect and reads one .docx file", async () => {
    const h = await harness();
    const res = await inspectExport({ file: await writeZip(takeout()) }, h.ctx);
    expect(res).toMatchObject({ kind: "google-docs", conversations: 3, projects: 1 });
    const dir = await tmpDir();
    const single = path.join(dir, "Meeting notes.docx");
    await fsp.writeFile(single, docx(para("Agenda"), { created: "2022-01-02T03:04:05Z" }));
    expect(await inspectExport({ file: single }, h.ctx)).toMatchObject({ kind: "google-docs", conversations: 1 });
    const h2 = await harness();
    await gdocs().run({ kind: "google-docs", file: single }, h2.ctx);
    const docs = await h2.entries();
    expect(docs[0]?.title).toBe("Meeting notes");
    expect(docs[0]?.writtenAt).toBe("2022-01-02T03:04:05.000Z");
  });
});
