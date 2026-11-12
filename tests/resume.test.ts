import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { deflateRawSync, deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docxPlainText, pdfPlainText, resumeText } from "../src/node/documentText";
import { createResumeService, RESUME_FILE } from "../src/plugin/resumeService";
import { nullLogger } from "../src/shared/log";
import { checkClaims, claimTerms, judgeClaim, parseResumeFile, resumeExtension, splitClaims, statusOf, type ClaimEntry, type RecordSearch } from "../src/shared/resume";
import { SHEET_PAGE_ROUTES } from "../src/shared/views";
import { PAIR_PAGES, pageDock, sheetSide } from "../src/ui/breakpoints";
import { COPY, t } from "../src/ui/copy";

const RESUME = [
  "Jane Doe",
  "jane@example.com | +44 7700 900123",
  "",
  "Summary",
  "Product engineer who shipped the Atlas billing rewrite.",
  "",
  "Experience",
  "Senior Engineer, Acme Corp (2019 - 2022)",
  "- Led the migration of Postgres to Kubernetes",
  "- Managed a team of six engineers.",
  "",
  "Skills: TypeScript, Rust, Kubernetes; Figma",
  "",
].join("\n");

describe("splitClaims", () => {
  it("skips the name, contact lines and headings, and splits skills one per item", () => {
    const texts = splitClaims(RESUME).map((c) => c.text);
    expect(texts).not.toContain("Jane Doe");
    expect(texts.some((x) => x.includes("@"))).toBe(false);
    expect(texts).not.toContain("Experience");
    expect(texts).toContain("Product engineer who shipped the Atlas billing rewrite");
    expect(texts).toContain("Senior Engineer, Acme Corp (2019 - 2022)");
    expect(texts).toContain("Led the migration of Postgres to Kubernetes");
    expect(texts).toEqual(expect.arrayContaining(["TypeScript", "Rust", "Kubernetes", "Figma"]));
  });

  it("drops duplicates and caps the list", () => {
    expect(splitClaims("Skills: Rust, rust, RUST").length).toBe(1);
    const many = Array.from({ length: 200 }, (_, i) => `Built the Widget${i} platform`).join("\n");
    expect(splitClaims(many).length).toBe(60);
  });

  it("gives every claim key terms, best (names, tools) first and no years", () => {
    const [role] = splitClaims("Senior Engineer, Acme Corp (2019 - 2022)");
    expect(role?.terms[0]).toBe("acme");
    expect(role?.terms).not.toContain("2019");
    expect(claimTerms("Led the migration of Postgres to Kubernetes")[0]).toMatch(/postgres|kubernetes/);
    expect(claimTerms("and the of")).toEqual([]);
  });
});

function fakeSearch(corpus: Record<string, string>): { search: RecordSearch; calls: string[][] } {
  const calls: string[][] = [];
  const search: RecordSearch = async (terms) => {
    calls.push([...terms]);
    const out: ClaimEntry[] = [];
    for (const [id, text] of Object.entries(corpus)) if (terms.every((w) => text.toLowerCase().includes(w))) out.push({ id, title: id });
    return out;
  };
  return { search, calls };
}

describe("judgeClaim", () => {
  const corpus = { e_1: "We moved Postgres to Kubernetes last spring", e_2: "Acme Corp standup notes" };

  it("marks a claim supported when its terms are found together, with the entries it rests on", async () => {
    const r = await judgeClaim({ text: "Led the migration of Postgres to Kubernetes", terms: ["postgres", "kubernetes"] }, fakeSearch(corpus).search);
    expect(r.verdict).toBe("supported");
    expect(r.entries.map((e) => e.id)).toEqual(["e_1"]);
  });

  it("marks it partly supported when only some terms are found, and not found when none are", async () => {
    const { search } = fakeSearch(corpus);
    const partly = await judgeClaim({ text: "Postgres at Globex", terms: ["postgres", "globex"] }, search);
    expect(partly.verdict).toBe("partly");
    expect(partly.entries[0]?.id).toBe("e_1");
    const none = await judgeClaim({ text: "Wrote Haskell compilers", terms: ["haskell", "compilers"] }, search);
    expect(none).toEqual({ text: "Wrote Haskell compilers", verdict: "not-found", entries: [] });
  });

  it("does not call a claim partly supported on one weak shared word alone", async () => {
    const r = await judgeClaim({ text: "Globex notes", terms: ["globex", "notes"] }, fakeSearch({ e_9: "meeting notes" }).search);
    expect(r.verdict).toBe("not-found");
  });
});

describe("checkClaims", () => {
  it("checks every claim in reading order and stamps the time", async () => {
    const { search } = fakeSearch({ e_1: "Atlas billing rewrite shipped", e_2: "Kubernetes upgrade" });
    const steps: number[] = [];
    const r = await checkClaims(RESUME, search, { now: () => Date.UTC(2026, 0, 2), step: (d) => steps.push(d) });
    expect(r.at).toBe("2026-01-02T00:00:00.000Z");
    expect(r.claims.length).toBe(steps.length);
    expect(r.claims.find((c) => c.text === "Kubernetes")?.verdict).toBe("supported");
    expect(r.claims.find((c) => c.text === "Figma")?.verdict).toBe("not-found");
  });

  it("stops early when cancelled", async () => {
    let n = 0;
    const r = await checkClaims(RESUME, async () => [], { cancelled: () => n++ >= 2 });
    expect(r.claims.length).toBe(2);
  });
});

describe("stored resume", () => {
  it("round-trips through parseResumeFile and reports counts", () => {
    const f = parseResumeFile({
      v: 1,
      name: "cv.txt",
      addedAt: "2026-01-01T00:00:00.000Z",
      text: "x".repeat(30),
      state: "done",
      check: { at: "2026-01-02T00:00:00.000Z", claims: [{ text: "a b", verdict: "supported", entries: [{ id: "e_1", title: "t" }] }, { text: "c d", verdict: "bogus", entries: [] }, { text: "e f", verdict: "not-found" }] },
    });
    expect(f?.check?.claims.length).toBe(2);
    expect(statusOf(f!).counts).toEqual({ supported: 1, partly: 0, notFound: 1 });
    expect(parseResumeFile({ v: 0 })).toBeNull();
    expect(parseResumeFile("nope")).toBeNull();
  });

  it("knows the file types", () => {
    expect(resumeExtension("My CV.PDF")).toBe("pdf");
    expect(resumeExtension("cv.docx")).toBe("docx");
    expect(resumeExtension("cv.exe")).toBeNull();
  });
});

function zipWith(name: string, body: Buffer): Buffer {
  const data = deflateRawSync(body);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(n.length, 26);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(8, 10);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(body.length, 24);
  cen.writeUInt16LE(n.length, 28);
  cen.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cen.length + n.length, 12);
  end.writeUInt32LE(local.length + n.length + data.length, 16);
  return Buffer.concat([local, n, data, cen, n, end]);
}

describe("document text", () => {
  it("reads the words of a docx and of a pdf, and refuses what has no text", () => {
    const xml = "<w:document><w:body><w:p><w:r><w:t>Senior Engineer at Acme &amp; Co</w:t></w:r></w:p><w:p><w:r><w:t>Built the Atlas platform</w:t></w:r></w:p></w:body></w:document>";
    expect(docxPlainText(zipWith("word/document.xml", Buffer.from(xml)))).toBe("Senior Engineer at Acme & Co\nBuilt the Atlas platform\n");

    const content = "BT /F1 12 Tf 72 700 Td (Senior Engineer at Acme Corp) Tj 0 -14 Td [(Built the ) -20 (Atlas platform)] TJ ET";
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode /Length 1 >>\nstream\n", "latin1"), deflateSync(Buffer.from(content, "latin1")), Buffer.from("\nendstream\nendobj\n", "latin1")]);
    expect(pdfPlainText(pdf).split("\n").filter(Boolean)).toEqual(["Senior Engineer at Acme Corp", "Built the Atlas platform"]);

    expect(() => resumeText(Buffer.from("short"), "txt")).toThrow();
    expect(() => resumeText(Buffer.from("%PDF-1.4 nothing here"), "pdf")).toThrow();
    expect(resumeText(Buffer.from("﻿Senior Engineer at Acme Corp\r\n\r\n\r\nBuilt things\n"), "md")).toContain("Built things");
  });
});

describe("ResumeService", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cortex-resume-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps the text apart from the record, queues a check that does not run by itself, then checks on request", async () => {
    const cache = path.join(dir, "cache");
    const file = path.join(dir, "cv.md");
    await writeFile(file, RESUME);
    const { search, calls } = fakeSearch({ e_1: "Kubernetes upgrade notes" });
    const svc = createResumeService({ cacheDir: cache, log: nullLogger, search, autoRun: false, now: () => Date.UTC(2026, 4, 5) });
    expect(await svc.status()).toBeNull();
    const v0 = svc.version.value;
    const added = await svc.add(file);
    expect(added).toMatchObject({ name: "cv.md", state: "queued" });
    expect(svc.version.value).toBeGreaterThan(v0);
    expect(calls.length).toBe(0);
    const stored = JSON.parse(await readFile(path.join(cache, RESUME_FILE), "utf8")) as { text: string };
    expect(stored.text).toContain("Atlas billing rewrite");

    const done = await svc.check();
    expect(done?.state).toBe("done");
    expect(done?.checkedAt).toBe("2026-05-05T00:00:00.000Z");
    expect(done?.counts?.supported).toBeGreaterThan(0);
    expect(calls.length).toBeGreaterThan(0);
    expect((await svc.status())?.claims?.length).toBeGreaterThan(0);

    await svc.remove();
    expect(await svc.status()).toBeNull();
    expect(await readFile(path.join(cache, RESUME_FILE), "utf8")).not.toContain("Atlas");
  });

  it("refuses other file types, an empty file and the sample record", async () => {
    const svc = createResumeService({ cacheDir: path.join(dir, "cache"), log: nullLogger, search: async () => [], autoRun: false });
    const exe = path.join(dir, "cv.exe");
    await writeFile(exe, "MZ");
    await expect(svc.add(exe)).rejects.toThrow();
    const empty = path.join(dir, "empty.txt");
    await writeFile(empty, "");
    await expect(svc.add(empty)).rejects.toThrow();
    const sample = createResumeService({ cacheDir: path.join(dir, "cache"), log: nullLogger, search: async () => [], autoRun: false, sandbox: () => true });
    await expect(sample.add(empty)).rejects.toThrow();
  });
});

describe("the Add page", () => {
  it("is a sheet page that docks on the left and can sit beside a reader", () => {
    expect(SHEET_PAGE_ROUTES).toContain("add");
    expect(pageDock({}, "add")).toBe("left");
    expect(pageDock({ docks: { add: "right" } }, "add")).toBe("right");
    expect(PAIR_PAGES).toContain("add");
    expect(sheetSide({ stack: [{ kind: "page", route: "add" }] })).toBe("left");
  });

  it("has its wording in the catalogue", () => {
    expect(COPY.add.resumeHeading).toBe("Your resume");
    expect(COPY.add.resumeButton).toBe("Add resume");
    expect(t("add.resumeChecked", { date: "5 May 2026", a: 3, b: 1, c: 2 })).toBe("Last checked 5 May 2026: 3 supported, 1 partly, 2 not found.");
  });
});
