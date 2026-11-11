/**
 * Claude Code + source documents importers (owner E3). Fixtures mirror the verified line shapes of the
 * user's transcripts (synthetic text only).
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyLine, slashCommandText, type CcEvent, type CcOptions, type CcRawLine } from "../src/importers/claudeCodeClassify";
import { ClaudeCodeImporter, discoverClaudeCodeFiles } from "../src/importers/claudeCode";
import { emptyStats, makeEntryRecord, toSegmentLine } from "../src/importers/common";
import { isNeverRead, TEXT_EXTENSIONS } from "../src/importers/folders";
import { splitPassages } from "../src/importers/passages";
import { rawExcludedPrefixes, rawLicenceOf, rawSpaceOf } from "../src/importers/rawDocs";
import { createImporters } from "../src/importers/registry";
import { splitLines } from "../src/shared/jsonl";
import { DEFAULT_SETTINGS } from "../src/shared/settings";

const FIX = path.join(__dirname, "fixtures");
const PROJECTS = path.join(FIX, "claude-code", "projects");
const SESSION = path.join(PROJECTS, "C--Users-test-proj", "11111111-2222-3333-4444-555555555555.jsonl");
const DEFAULTS: CcOptions = { includeThinking: false, includeToolCalls: false, includeToolResults: false, includeHarness: false };

function load(file: string): { lines: CcRawLine[]; carry: string } {
  const { lines, carry } = splitLines(readFileSync(file, "utf8"));
  return { lines: lines.map((l) => JSON.parse(l) as CcRawLine), carry };
}

function messages(events: CcEvent[]): Extract<CcEvent, { kind: "message" }>[] {
  return events.filter((e): e is Extract<CcEvent, { kind: "message" }> => e.kind === "message");
}

describe("importers/claudeCodeClassify", () => {
  const { lines, carry } = load(SESSION);
  const all = lines.flatMap((l) => classifyLine(l, DEFAULTS, false));
  const msgs = messages(all);

  it("keeps the partial last line for the next pass", () => {
    expect(carry).toContain("partial line");
  });
  it("attributes only human-originated lines to the user", () => {
    expect(msgs.filter((m) => m.speaker === "you").map((m) => m.text)).toEqual([
      "Plan the importer for chat exports, please.",
      "Also keep the cursor per file.",
      "/wiki status",
      "Thanks, that works for me.",
    ]);
  });
  it("keeps assistant text, drops thinking, tool calls, tool output, api blobs and errors by default", () => {
    const a = msgs.filter((m) => m.speaker === "assistant");
    expect(a.map((m) => [m.messageId, m.text])).toEqual([
      ["msg_A", "Here is a plan in three steps."],
      ["msg_B", "Step one is streaming the file."],
      ["msg_D", "Status: all good."],
    ]);
    expect(a[0]?.speakerDetail).toBe("claude-sonnet-5-5");
    expect(msgs.some((m) => m.text.includes("tool output"))).toBe(false);
    expect(msgs.some((m) => m.text.includes("internal reasoning"))).toBe(false);
  });
  it("reads titles from custom-title and ai-title lines", () => {
    expect(all.filter((e) => e.kind === "title")).toEqual([
      { kind: "title", title: "Planning the chat export importer", by: "model" },
      { kind: "title", title: "Importer plan", by: "user" },
    ]);
  });
  it("can include harness, thinking and tool lines when asked", () => {
    const opts: CcOptions = { includeThinking: true, includeToolCalls: true, includeToolResults: true, includeHarness: true };
    const m = messages(lines.flatMap((l) => classifyLine(l, opts, false)));
    expect(m.some((x) => x.speaker === "other" && x.speakerDetail === "automated prompt")).toBe(true);
    expect(m.some((x) => x.speaker === "tool")).toBe(true);
    expect(m.some((x) => x.text.includes("internal reasoning"))).toBe(true);
    expect(m.some((x) => x.text.startsWith("Read: "))).toBe(true);
  });
  it("marks subagent traffic hidden and not the user's words", () => {
    const sub = load(path.join(PROJECTS, "C--Users-test-proj", "11111111-2222-3333-4444-555555555555", "subagents", "agent-a1.jsonl"));
    const m = messages(sub.lines.flatMap((l) => classifyLine(l, DEFAULTS, true)));
    expect(m.every((x) => x.hidden === "subagent")).toBe(true);
    expect(m.find((x) => x.speaker !== "assistant")?.speaker).toBe("other");
  });
  it("extracts slash commands", () => {
    expect(slashCommandText("<command-name>/save</command-name><command-args></command-args>")).toBe("/save");
  });
});

describe("importers/claudeCode", () => {
  it("discovers sessions and (optionally) subagent files", async () => {
    expect(await discoverClaudeCodeFiles(PROJECTS, { includeSubagents: false, excludeProjects: [] })).toHaveLength(1);
    const withSubs = await discoverClaudeCodeFiles(PROJECTS, { includeSubagents: true, excludeProjects: [] });
    expect(withSubs).toHaveLength(2);
    expect(withSubs.find((f) => f.isSubagent)?.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(await discoverClaudeCodeFiles(PROJECTS, { includeSubagents: true, excludeProjects: ["C--Users-test-proj"] })).toHaveLength(0);
  });
});

describe("importers/passages", () => {
  it("splits at H2/H3 headings with character offsets", () => {
    const text = readFileSync(path.join(FIX, "raw", "guide.md"), "utf8");
    const ps = splitPassages(text, 1200);
    expect(ps.map((p) => p.heading ?? null)).toEqual([null, "Setup", "Usage", "Advanced"]);
    expect(text.slice(ps[1]?.start, ps[1]?.end)).toContain("Install the tools");
    const tiny = splitPassages("a b c\n\nd e f\n\ng h i", 3);
    expect(tiny.length).toBe(3);
  });
});

describe("importers/rawDocs + folders + common + registry + written", () => {
  it("classifies raw paths and privacy-protected files", () => {
    expect(rawSpaceOf(".raw/roblox/creator-docs/a.md")).toBe("roblox");
    expect(rawLicenceOf(".raw/roblox/creator-docs/a.md")).toMatch(/CC-BY-4.0/);
    expect(rawExcludedPrefixes()).toContain(".raw/chats/");
    expect(isNeverRead("C:/proj/.env")).toBe(true);
    expect(isNeverRead("C:/proj/notes/a.md")).toBe(false);
    expect(TEXT_EXTENSIONS.has("luau")).toBe(true);
  });
  it("builds entry records and segment lines", () => {
    const rec = makeEntryRecord({
      id: "e_aaaaaaaaaaaaaaaa",
      kind: "message",
      source: "claude-code",
      sourceRef: { path: "x", sha256: "s" },
      text: "two words",
      textSha256: "h",
      textRef: { store: "segment", seg: "s.gz", line: 0 },
      speaker: "you",
      dates: [],
      addedAt: "2026-11-01T00:00:00.000Z",
      space: "vault",
      folder: [],
    });
    expect([rec.chars, rec.words, rec.existedBy]).toEqual([9, 2, "2026-11-01T00:00:00.000Z"]);
    expect(toSegmentLine("e_aaaaaaaaaaaaaaaa", { nativeId: "u1", speaker: "you", text: "hi", sourceRef: { path: "x", sha256: "s" } }, undefined, 0, "h").sp).toBe("you");
    expect(emptyStats("files", "x").entriesAdded).toBe(0);
    expect(Object.keys(createImporters()).sort()).toEqual(expect.arrayContaining(["chatgpt", "claude-ai", "claude-code", "folder", "gemini", "raw", "vault-notes", "written"]));
    expect(new WrittenImporter().source).toBe("written");
  });
});

// ───────────────────────────── integration: real store in temp folders ─────────────────────────────

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import { NEVER_CANCELLED } from "../src/shared/cancel";
import { nullLogger } from "../src/shared/log";
import type { CortexSettings } from "../src/shared/settings";
import type { EntryRecord } from "../src/shared/types";
import { createLedgerStore } from "../src/store/ledger";
import { openStoreContext } from "../src/store/layout";
import { loadSourceManifest } from "../src/store/manifest";
import { readText } from "../src/store/segments";
import { isUserNotePath, ignoreFilterMatcher, noteDateClaim, VaultNotesImporter, VERSION_QUIET_MS } from "../src/importers/vaultNotes";
import { FolderImporter, expandFileTypes, folderSpeakersPath } from "../src/importers/folders";
import { RawDocsImporter, importChangedPath, isApiDump, rawSkipReason } from "../src/importers/rawDocs";
import { WrittenImporter, writtenIdOf } from "../src/importers/written";
import { splitBytePassages } from "../src/importers/passages";
import { documentGroupDir, knownIdsFromLedger, newTally, noteNotLocal, notLocalFilePath, readHeldSecret, trackNotLocal, type ImportContext } from "../src/importers/common";
import { estimateSources, headSaysReference, TOKENS_PER_CONVERSATION, TOKENS_PER_NOTE } from "../src/importers/registry";
import { createNewEntryService, writtenFileText } from "../src/plugin/newEntry";
import { createSourcesService, yourShareBySource } from "../src/plugin/sourcesService";
import { agoText, extensionsOfTypes } from "../src/ui/modals/AddSourcesModal";
import { isAbsoluteTypedPath } from "../src/ui/modals/pickPath";

const tmp = (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), "cortex-e3-"));

function settingsWith(patch?: (s: CortexSettings) => void): CortexSettings {
  const s = structuredClone(DEFAULT_SETTINGS) as CortexSettings;
  s.sources.claudeCode.liveIdleMinutes = 0;
  patch?.(s);
  return s;
}

interface Harness {
  vault: string;
  cache: string;
  ctx: ImportContext;
  clock: { t: number };
  entries(): Promise<EntryRecord[]>;
  text(e: EntryRecord): Promise<string | null>;
}

async function harness(patch?: (s: CortexSettings) => void, opts: { vault?: string } = {}): Promise<Harness> {
  const vault = opts.vault ?? (await tmp());
  const cache = await tmp();
  const store = await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
  const ledger = createLedgerStore(store);
  // Just after the real time, so freshly written fixture files are not "live" sessions.
  const clock = { t: Date.now() + 1000 };
  const ctx: ImportContext = {
    store,
    ledger,
    settings: settingsWith(patch),
    mayContinue: async () => true,
    token: NEVER_CANCELLED,
    log: nullLogger,
    progress: () => undefined,
    yield: async () => undefined,
    now: () => Math.max(clock.t, Date.now() + 1000), // never behind real time, so files written during a slow run are not "live"
    knownEntryIds: (conv) => knownIdsFromLedger(ctx, conv),
  };
  const entries = async (): Promise<EntryRecord[]> => {
    const out: EntryRecord[] = [];
    for await (const e of ledger.readAll("entries")) out.push(e);
    return out;
  };
  const text = async (e: EntryRecord): Promise<string | null> => {
    const r = await readText(vault, e.text, e.textSha256);
    return r.ok ? r.text : null;
  };
  return { vault, cache, ctx, clock, entries, text };
}

/** A context that shares the harness's store but starts a fresh pass (new caches, new tally). */
function nextPass(h: Harness): ImportContext {
  const ctx: ImportContext = { ...h.ctx, tally: newTally() };
  ctx.knownEntryIds = (conv) => knownIdsFromLedger(ctx, conv);
  return ctx;
}

async function write(file: string, body: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, body);
}

describe("ClaudeCodeImporter.run", () => {
  it("imports a session once, keeps the words verbatim and picks up a live file's last line later", async () => {
    const projects = await tmp();
    const slug = path.join(projects, "C--Users-test-proj");
    await fsp.cp(path.join(PROJECTS, "C--Users-test-proj"), slug, { recursive: true });
    const h = await harness((s) => void (s.sources.claudeCode.projectsDir = projects));
    const imp = new ClaudeCodeImporter();
    const a = await imp.run({ kind: "claude-code" }, nextPass(h));
    expect(a.entriesAdded).toBe(7);
    const recs = await h.entries();
    const mine = recs.filter((r) => r.speaker === "you").sort((x, y) => (x.idx ?? 0) - (y.idx ?? 0));
    expect(mine).toHaveLength(4);
    expect(await h.text(mine[0] as EntryRecord)).toBe("Plan the importer for chat exports, please.");
    expect(recs.every((r) => r.hiddenByDefault === undefined)).toBe(true);
    expect((await imp.run({ kind: "claude-code" }, nextPass(h))).entriesAdded).toBe(0);
    // The last line was cut mid-write; finish it and the next pass reads it.
    await fsp.appendFile(path.join(slug, "11111111-2222-3333-4444-555555555555.jsonl"), '"}}\n');
    expect((await imp.run({ kind: "claude-code" }, nextPass(h))).entriesAdded).toBe(1);
    const all = await h.entries();
    expect(await h.text(all[all.length - 1] as EntryRecord)).toMatch(/^partial line that has no newline yet/);
    const manifest = await loadSourceManifest(h.ctx.store);
    expect(manifest.sources["claude-code"]?.conversations).toBe(1);
  });

  it("skips excluded projects and marks sessions without a person's words as automated", async () => {
    const projects = await tmp();
    await write(
      path.join(projects, "proj-a", "aaaaaaaa-0000-0000-0000-000000000001.jsonl"),
      [
        JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-11-01T09:00:00.000Z", promptSource: "sdk", turnOrigin: "sdk", message: { role: "user", content: "Automated prompt." } }),
        JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-11-01T09:00:01.000Z", message: { id: "m1", role: "assistant", model: "x", content: [{ type: "text", text: "Done." }] } }),
        "",
      ].join("\n"),
    );
    await write(path.join(projects, "proj-b", "bbbbbbbb-0000-0000-0000-000000000002.jsonl"), JSON.stringify({ type: "user", uuid: "u9", timestamp: "2026-11-01T09:00:00.000Z", message: { role: "user", content: "Hidden project." } }) + "\n");
    const h = await harness((s) => {
      s.sources.claudeCode.projectsDir = projects;
      s.sources.claudeCode.excludeProjects = ["proj-b"];
    });
    const res = await new ClaudeCodeImporter().run({ kind: "claude-code" }, nextPass(h));
    expect(res.filesSeen).toBe(1);
    const recs = await h.entries();
    expect(recs).toHaveLength(1);
    expect(recs[0]?.speaker).toBe("assistant");
    expect(recs[0]?.hiddenByDefault).toBe("automated");
  });

  it("holds high-confidence secrets back and keeps the originals on this computer", async () => {
    const projects = await tmp();
    const secret = "AKIAIOSFODNN7EXAMPLE";
    await write(
      path.join(projects, "proj-s", "cccccccc-0000-0000-0000-000000000003.jsonl"),
      JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-11-01T09:00:00.000Z", promptSource: "typed", turnOrigin: "human", message: { role: "user", content: `my key is ${secret} ok` } }) + "\n",
    );
    const h = await harness((s) => void (s.sources.claudeCode.projectsDir = projects));
    const ctx = nextPass(h);
    await new ClaudeCodeImporter().run({ kind: "claude-code" }, ctx);
    const [rec] = await h.entries();
    expect(await h.text(rec as EntryRecord)).toBe("my key is [secret kept on this computer] ok");
    expect(ctx.tally?.secretsHeld).toBe(1);
    expect(await readHeldSecret(h.cache, (rec as EntryRecord).id, 0)).toBe(secret);
  });
});

describe("RawDocsImporter", () => {
  async function rawVault(): Promise<Harness> {
    const vault = await tmp();
    await fsp.cp(path.join(FIX, "raw"), path.join(vault, ".raw"), { recursive: true });
    return harness(undefined, { vault });
  }

  it("classifies what is read", () => {
    const raw = DEFAULT_SETTINGS.sources.raw;
    expect(rawSkipReason(".raw/roblox/creator-docs/a.yaml", 10, raw)).toBe("yaml");
    expect(rawSkipReason(".raw/roblox/Full-API-Dump.json", 10, raw)).toBe("api-dump");
    expect(rawSkipReason(".raw/x.json", raw.maxJsonBytes + 1, raw)).toBe("json-size");
    expect(rawSkipReason(".raw/a.md", 10, raw)).toBeUndefined();
    expect(isApiDump(".raw/roblox/Full-API-Dump.json")).toBe(true);
    expect(rawSkipReason(".raw/a.png", 10, raw)).toBe("type");
  });

  it("imports documents in place with byte-range passages, then only changes", async () => {
    const h = await rawVault();
    const imp = new RawDocsImporter();
    expect((await imp.discover({ kind: "raw" }, h.ctx)).map((u) => u.path).sort()).toEqual([".raw/guide.md", ".raw/roblox/creator-docs/content/en-us/part.md", ".raw/settings.json"]);
    const r1 = await imp.run({ kind: "raw" }, nextPass(h));
    const recs = await h.entries();
    expect(r1.entriesAdded).toBe(recs.length);
    const guide = recs.filter((e) => e.sourceRef.path === ".raw/guide.md");
    expect(guide.map((e) => e.kind)).toEqual(["document", "passage", "passage", "passage", "passage"]);
    expect(guide[0]?.speaker).toBe("other");
    for (const e of guide) expect(await h.text(e)).not.toBeNull();
    const usage = guide.find((e) => e.passage?.heading === "Usage") as EntryRecord;
    expect(await h.text(usage)).toContain("Run the command");
    expect(usage.passage).toMatchObject({ doc: guide[0]?.id, n: 2, of: 4 });
    const ref = recs.filter((e) => e.sourceRef.path.endsWith("part.md"));
    expect(ref.length).toBeGreaterThan(0);
    expect(ref.every((e) => e.hiddenByDefault === "reference" && e.space === "roblox" && (e.licence ?? "").startsWith("CC-BY-4.0"))).toBe(true);
    expect(recs.some((e) => /skip\.md|Full-API|schema\.yaml/.test(e.sourceRef.path))).toBe(false);
    expect(recs.every((e) => e.dates.length === 1 && e.dates[0]?.type === "ingest")).toBe(true);
    expect((await imp.run({ kind: "raw" }, nextPass(h))).entriesAdded).toBe(0);
    // A changed file is flagged, not re-imported, until the new version is asked for.
    const guideFile = path.join(h.vault, ".raw", "guide.md");
    await fsp.writeFile(guideFile, (await fsp.readFile(guideFile, "utf8")).replace("Intro paragraph", "Opening paragraph") + "\n## Added\n\nA new section arrived.\n");
    const flagged = nextPass(h);
    expect((await imp.run({ kind: "raw" }, flagged)).entriesAdded).toBe(0);
    expect(flagged.tally?.warnings.get("changed-at-source")).toBe(1);
    expect(await h.text(guide[0] as EntryRecord)).toBeNull();
    expect((await imp.run({ kind: "raw" }, nextPass(h))).entriesAdded).toBe(0);
    // Import again: new ids with supersedes; the old entries stay in the ledger.
    await write(importChangedPath(h.cache), JSON.stringify({ v: 1, all: true }));
    expect((await imp.run({ kind: "raw" }, nextPass(h))).entriesAdded).toBe(6);
    const after = await h.entries();
    const newDoc = after.filter((e) => e.sourceRef.path === ".raw/guide.md" && e.kind === "document").pop() as EntryRecord;
    expect(newDoc.supersedes).toBe(guide[0]?.id);
    expect(newDoc.id).not.toBe(guide[0]?.id);
    expect(await h.text(newDoc)).toContain("A new section arrived.");
    await expect(fsp.access(importChangedPath(h.cache))).rejects.toBeDefined();
    expect((await imp.run({ kind: "raw" }, nextPass(h))).entriesAdded).toBe(0);
  });

  it("honours left-out folders", async () => {
    const h = await harness((s) => {
      s.sources.raw.excludeFolders = [".raw/roblox/"];
    });
    await fsp.cp(path.join(FIX, "raw"), path.join(h.vault, ".raw"), { recursive: true });
    await new RawDocsImporter().run({ kind: "raw" }, nextPass(h));
    const paths = new Set((await h.entries()).map((e) => e.sourceRef.path));
    expect([...paths].sort()).toEqual([".raw/guide.md", ".raw/settings.json"]);
  });
});

describe("splitBytePassages", () => {
  it("counts UTF-8 bytes, not characters", () => {
    const text = "# Title é\n\nintro ✓\n\n## Two\n\nsecond ü\n";
    const ps = splitBytePassages(text, 1200);
    const buf = Buffer.from(text, "utf8");
    expect(ps.map((p) => buf.subarray(p.byteStart, p.byteEnd).toString("utf8"))).toEqual(ps.map((p) => text.slice(p.start, p.end)));
    expect(ps[ps.length - 1]?.byteEnd).toBe(buf.length);
  });
});

describe("VaultNotesImporter", () => {
  it("recognises user notes, Obsidian excluded files and dates in names", () => {
    expect(isUserNotePath("daily/2026-11-09.md", [])).toBe(true);
    expect(isUserNotePath("wiki/a.md", [])).toBe(false);
    expect(isUserNotePath(".raw/a.md", [])).toBe(false);
    expect(isUserNotePath("agents/x.md", ["agents/"])).toBe(false);
    const ignored = ignoreFilterMatcher(["private/", "/^drafts\\//", 5, "/[unclosed/"]);
    expect(ignored("a/private/b.md")).toBe(true);
    expect(ignored("drafts/x.md")).toBe(true);
    expect(ignored("public/x.md")).toBe(false);
    expect(noteDateClaim({}, "daily/2026-11-09.md")).toMatchObject({ at: "2026-11-09", type: "filename-date" });
    expect(noteDateClaim({ created: "2026-10-01T08:00:00Z" }, "x.md")).toMatchObject({ at: "2026-10-01T08:00:00.000Z", type: "user-declared" });
    expect(noteDateClaim({ created: "soon" }, "x.md")).toBeUndefined();
    expect(headSaysReference("---\ntype: x\nstatus: reference\n---\nbody")).toBe(true);
    expect(headSaysReference("status: reference")).toBe(false);
  });

  it("copies notes into segments, versions a changed note after a quiet hour and holds secrets", async () => {
    const h = await harness();
    const v = h.vault;
    await write(path.join(v, "daily", "2026-11-09.md"), "Walked the dog and thought about the plan.\n");
    await write(path.join(v, "ideas", "tool.md"), "---\nstatus: reference\n---\n# Tool\n\nA reference note.\n");
    await write(path.join(v, "notes", "keys.md"), "# Keys\n\nstore AKIAIOSFODNN7EXAMPLE somewhere\n");
    await write(path.join(v, "wiki", "ignored.md"), "# machine note\n");
    await write(path.join(v, "private", "no.md"), "# private\n");
    await write(path.join(v, ".obsidian", "app.json"), JSON.stringify({ userIgnoreFilters: ["private/"] }));
    const imp = new VaultNotesImporter();
    const first = nextPass(h);
    expect((await imp.run({ kind: "vault-notes" }, first)).entriesAdded).toBe(3);
    const recs = await h.entries();
    const by = (p: string): EntryRecord => recs.find((e) => e.sourceRef.path === p) as EntryRecord;
    expect(by("daily/2026-11-09.md")).toMatchObject({ speaker: "you", kind: "document", source: "obsidian", writtenAt: "2026-11-09" });
    expect(by("ideas/tool.md").hiddenByDefault).toBe("reference");
    expect(await h.text(by("notes/keys.md"))).toContain("[secret kept on this computer]");
    expect(await h.text(by("notes/keys.md"))).not.toContain("AKIA");
    expect(first.tally?.secretsHeld).toBe(1);
    expect(recs.some((e) => /wiki|private/.test(e.sourceRef.path))).toBe(false);
    expect((await imp.run({ kind: "vault-notes" }, nextPass(h))).entriesAdded).toBe(0);
    // A note still being edited waits for a quiet hour; then it is a new version of the same note.
    const file = path.join(v, "daily", "2026-11-09.md");
    await fsp.writeFile(file, "Walked the dog and thought about the plan.\nThen changed my mind.\n");
    const fresh = new Date(h.clock.t);
    await fsp.utimes(file, fresh, fresh);
    expect((await imp.run({ kind: "vault-notes" }, nextPass(h))).entriesAdded).toBe(0);
    h.clock.t += VERSION_QUIET_MS + 1000;
    expect((await imp.run({ kind: "vault-notes" }, nextPass(h))).entriesAdded).toBe(1);
    const versions = (await h.entries()).filter((e) => e.sourceRef.path === "daily/2026-11-09.md");
    expect(versions).toHaveLength(2);
    expect(versions[1]?.supersedes).toBe(versions[0]?.id);
    expect(await h.text(versions[0] as EntryRecord)).not.toContain("changed my mind");
    expect(await h.text(versions[1] as EntryRecord)).toContain("changed my mind");
    expect(documentGroupDir("obsidian", "notes", h.clock.t).dir.startsWith(".raw/chats/obsidian/")).toBe(true);
  });
});

describe("FolderImporter", () => {
  it("expands file types", () => {
    expect(expandFileTypes(["md", "code"])).toEqual(expect.arrayContaining(["md", "markdown", "py", "luau"]));
    expect(extensionsOfTypes(["html"])).toEqual(["html", "htm"]);
  });

  it("copies the chosen types with the chosen speaker, skips secrets and versions changed files", async () => {
    const dir = await tmp();
    await write(path.join(dir, "a.md"), "# Plan\n\nMy plan for the week.\n");
    await write(path.join(dir, "sub", "b.txt"), "plain notes\n");
    await write(path.join(dir, "code.py"), "print('x')\n");
    await write(path.join(dir, ".env"), "TOKEN=abc\n");
    await write(path.join(dir, "node_modules", "m.md"), "# module\n");
    await write(path.join(dir, "page.html"), "<html><body><p>Hello <b>there</b></p></body></html>");
    const h = await harness((s) => {
      s.sources.folders = [{ id: "f1", path: dir, label: "Mine", extensions: ["md", "txt", "html"], space: "life", watch: true, enabled: true }];
      s.you.speakerBySource["folder:f1"] = "you";
    });
    const imp = new FolderImporter();
    expect((await imp.discover({ kind: "folder", id: "f1" }, h.ctx)).map((x) => x.label).sort()).toEqual(["a.md", "page.html", "sub/b.txt"]);
    expect((await imp.run({ kind: "folder", id: "f1" }, nextPass(h))).entriesAdded).toBe(3);
    const recs = await h.entries();
    expect(recs.every((e) => e.speaker === "you" && e.space === "life" && e.source === "files")).toBe(true);
    expect(await h.text(recs.find((e) => e.sourceRef.path.endsWith("page.html")) as EntryRecord)).toBe("Hello **there**");
    expect(recs.some((e) => /\.env|node_modules|code\.py/.test(e.sourceRef.path))).toBe(false);
    expect((await imp.run({ kind: "folder", id: "f1" }, nextPass(h))).entriesAdded).toBe(0);
    await fsp.writeFile(path.join(dir, "a.md"), "# Plan\n\nMy plan changed.\n");
    const old = new Date(h.clock.t - 3_600_000);
    await fsp.utimes(path.join(dir, "a.md"), old, old);
    expect((await imp.run({ kind: "folder", id: "f1" }, nextPass(h))).entriesAdded).toBe(1);
    const a = (await h.entries()).filter((e) => e.sourceRef.path.endsWith("a.md"));
    expect(a[1]?.supersedes).toBe(a[0]?.id);
    expect((await loadSourceManifest(h.ctx.store)).sources["folder:f1"]?.status).toBe("watching");
  });

  it("'Ask per file' imports only the files that were answered", async () => {
    const dir = await tmp();
    await write(path.join(dir, "mine.md"), "mine\n");
    await write(path.join(dir, "theirs.md"), "theirs\n");
    await write(path.join(dir, "unknown.md"), "unknown\n");
    const h = await harness((s) => {
      s.sources.folders = [{ id: "f2", path: dir, label: "Mixed", extensions: ["md"], space: "none", watch: false, enabled: true }];
      s.you.speakerBySource["folder:f2"] = "ask";
    });
    await write(folderSpeakersPath(h.cache, "f2"), JSON.stringify({ v: 1, files: { "mine.md": "you", "theirs.md": "other" } }));
    expect((await new FolderImporter().run({ kind: "folder", id: "f2" }, nextPass(h))).entriesAdded).toBe(2);
    expect((await h.entries()).map((e) => [path.basename(e.sourceRef.path), e.speaker]).sort()).toEqual([["mine.md", "you"], ["theirs.md", "other"]]);
  });
});

describe("New entry + WrittenImporter", () => {
  it("saves a file, imports it as yours with strong date evidence and never rewrites it", async () => {
    const h = await harness();
    const requests: unknown[] = [];
    const svc = createNewEntryService({
      vaultRoot: h.vault,
      cacheDir: h.cache,
      log: nullLogger,
      runner: { request: (async (c: unknown) => void requests.push(c)) as never },
      sandbox: () => false,
      now: () => new Date(2026, 10, 9, 14, 5, 7),
    });
    const a = await svc.save({ title: "A thought", body: "I think the moon is a rock.", space: "code" });
    const b = await svc.save({ title: "A thought", body: "Second one the same minute." });
    expect(a.path).toBe(".raw/written/2026/11/20261109-1405-a-thought.md");
    expect(b.path).toBe(".raw/written/2026/11/20261109-1405-a-thought-2.md");
    expect(a.entryId).not.toBe(b.entryId);
    expect(requests).toHaveLength(2);
    expect(await fsp.readFile(path.join(h.vault, ".raw", "written", ".gitignore"), "utf8")).toBe("*\n");
    const imp = new WrittenImporter();
    expect((await imp.run({ kind: "written" }, nextPass(h))).entriesAdded).toBe(2);
    const first = (await h.entries()).find((e) => e.id === a.entryId) as EntryRecord;
    expect(first).toMatchObject({ speaker: "you", source: "written", kind: "document", title: "A thought", space: "code" });
    expect(first.writtenAt).toBe(new Date(2026, 10, 9, 14, 5, 7).toISOString());
    expect(first.dates[0]).toMatchObject({ type: "source-timestamp", strength: "strong" });
    expect(await h.text(first)).toBe("I think the moon is a rock.\n");
    // Edited on disk: never a second entry.
    await fsp.appendFile(path.join(h.vault, a.path), "extra\n");
    expect((await imp.run({ kind: "written" }, nextPass(h))).entriesAdded).toBe(0);
    expect(writtenIdOf(a.path, undefined)).toBe(a.entryId);
    expect(writtenIdOf("x.md", "not-an-id")).toMatch(/^e_/);
  });

  it("refuses the sample record and empty text, keeps drafts per leaf and writes the documented file format", async () => {
    const h = await harness();
    const deps = { vaultRoot: h.vault, cacheDir: h.cache, log: nullLogger, runner: { request: (async () => undefined) as never } };
    await expect(createNewEntryService({ ...deps, sandbox: () => true }).save({ title: "", body: "x" })).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    const live = createNewEntryService({ ...deps, sandbox: () => false });
    await expect(live.save({ title: "t", body: "   " })).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    live.saveDraft("leaf-1", { title: "t", body: "draft" });
    expect(live.loadDraft("leaf-1")).toEqual({ title: "t", body: "draft" });
    live.clearDraft("leaf-1");
    expect(live.loadDraft("leaf-1")).toBeNull();
    expect(writtenFileText({ id: "e_x", created: new Date(0), title: 'a "b"', space: "none", body: "hi" })).toBe('---\ncortex_id: e_x\nmade_by: you\ncreated: 1970-01-01T00:00:00.000Z\ntitle: "a \\"b\\""\nspace: none\n---\nhi\n');
  });
});

describe("estimate, not-local tracking and the Sources service", () => {
  it("counts files without importing anything", async () => {
    const vault = await tmp();
    await fsp.cp(path.join(FIX, "raw"), path.join(vault, ".raw"), { recursive: true });
    await write(path.join(vault, "n1.md"), "---\nstatus: reference\n---\nx");
    await write(path.join(vault, "n2.md"), "plain");
    const projects = await tmp();
    await fsp.cp(path.join(PROJECTS, "C--Users-test-proj"), path.join(projects, "C--Users-test-proj"), { recursive: true });
    const h = await harness((s) => void (s.sources.claudeCode.projectsDir = projects), { vault });
    const est = await estimateSources([{ kind: "claude-code" }, { kind: "raw" }, { kind: "vault-notes" }], h.ctx);
    expect(est.sources.find((x) => x.source === "claude-code")?.items).toBe(1);
    expect(est.sources.find((x) => x.source === "files")).toMatchObject({ items: 3, reference: 1 });
    expect(est.sources.find((x) => x.source === "obsidian")).toMatchObject({ items: 2, reference: 1 });
    expect(est.conversations).toBe(1);
    expect(est.notes).toBe(1);
    expect(est.tokens).toBe(TOKENS_PER_CONVERSATION + TOKENS_PER_NOTE);
    expect(await h.entries()).toHaveLength(0);
  });

  it("keeps the list of OneDrive placeholders per importer", async () => {
    const h = await harness();
    const ctx = nextPass(h);
    await trackNotLocal(ctx, "raw", async () => noteNotLocal(ctx, ".raw/a.md"));
    expect(JSON.parse(await fsp.readFile(notLocalFilePath(h.cache), "utf8"))).toEqual({ v: 1, bySource: { raw: [".raw/a.md"] } });
    await trackNotLocal(nextPass(h), "raw", async () => undefined);
    expect(JSON.parse(await fsp.readFile(notLocalFilePath(h.cache), "utf8"))).toEqual({ v: 1, bySource: {} });
  });

  it("builds rows, files and attention rows from what the importers left behind", async () => {
    const vault = await tmp();
    await fsp.cp(path.join(FIX, "raw"), path.join(vault, ".raw"), { recursive: true });
    const h = await harness((s) => void (s.sources.claudeCode.projectsDir = path.join(vault, "no-such-folder")), { vault });
    await new RawDocsImporter().run({ kind: "raw" }, nextPass(h));
    await fsp.appendFile(path.join(vault, ".raw", "guide.md"), "more\n");
    await new RawDocsImporter().run({ kind: "raw" }, nextPass(h));
    await write(notLocalFilePath(h.cache), JSON.stringify({ v: 1, bySource: { raw: [".raw/x.md", ".raw/y.md"] } }));
    const excluded: unknown[] = [];
    const requests: unknown[] = [];
    const app = {
      vault: { getMarkdownFiles: () => [{ path: "a.md" }, { path: "b.md" }, { path: "c.md" }] },
      metadataCache: { getFileCache: (f: { path: string }) => ({ frontmatter: f.path === "c.md" ? { status: "reference" } : {} }) },
    };
    const svc = createSourcesService({
      app: app as never,
      vaultRoot: vault,
      cacheDir: h.cache,
      log: nullLogger,
      settings: { value: h.ctx.settings, signal: undefined as never, corrupt: false, issues: [], update: async (fn: (s: CortexSettings) => void) => fn(h.ctx.settings), reload: async () => undefined, useDefaults: async () => undefined },
      runner: {
        request: (async (c: { cmd: string }) => {
          requests.push(c);
          return { sources: [{ source: "obsidian", items: 1, reference: 0 }], conversations: 2, notes: 1, tokens: 2 * TOKENS_PER_CONVERSATION + TOKENS_PER_NOTE, days: 1 };
        }) as never,
      },
      corrections: { exclude: (async (...a: unknown[]) => void excluded.push(a)) as never },
    });
    const rows = await svc.list();
    expect(rows.map((r) => r.id)).toEqual(["vault", "raw", "claude-code", "claude-ai", "chatgpt", "gemini", "written"]);
    expect(rows.find((r) => r.id === "raw")).toMatchObject({ status: "attention", storedIn: ".raw/ (read in place)", yourShare: 0 });
    expect(rows.find((r) => r.id === "chatgpt")?.status).toBe("not-added");
    expect((await svc.needsAttention()).map((a) => [a.code, a.count])).toEqual([["not-local", 2], ["changed-at-source", 1], ["path-unreadable", 1]]);
    expect((await svc.files()).find((f) => f.name === "guide.md")).toMatchObject({ state: "changed", versions: 1 });
    const est = await svc.estimate();
    expect(est.sources.find((s) => s.source === "obsidian")).toEqual({ source: "obsidian", items: 3, reference: 1 });
    expect(est.notes).toBe(2);
    expect(est.tokens).toBe(2 * TOKENS_PER_CONVERSATION + 2 * TOKENS_PER_NOTE);
    await svc.pauseWatching("claude-code", true);
    expect(h.ctx.settings.sources.claudeCode.watch).toBe(false);
    await svc.remove("raw");
    expect(h.ctx.settings.sources.raw.enabled).toBe(false);
    expect(excluded).toEqual([["raw", "source", "sources"]]);
    await svc.importNow({ kind: "written" });
    expect(requests.at(-1)).toMatchObject({ cmd: "import", args: { sources: [{ kind: "written" }] } });
    await svc.importNow({ kind: "raw" });
    expect(JSON.parse(await fsp.readFile(importChangedPath(h.cache), "utf8"))).toEqual({ v: 1, all: true });
  });

  it("computes each source's share of your words from the index, leaving out reference items", () => {
    const cols = {
      kind: Uint8Array.from([0, 0, 0, 10]),
      source: Uint8Array.from([0, 0, 1, 0]),
      speaker: Uint8Array.from([0, 1, 0, 0]),
      flags: Uint32Array.from([0, 0, 4, 0]),
      words: Uint32Array.from([30, 70, 50, 99]),
    };
    const share = yourShareBySource({ count: 4, cols } as never);
    expect(share.get("claude-code")).toBeCloseTo(0.3);
    expect(share.has("claude-ai")).toBe(false);
  });
});

describe("Add sources helpers", () => {
  it("accepts only absolute typed paths and describes ages", () => {
    expect(isAbsoluteTypedPath("C:\\Users\\me\\export.zip")).toBe(true);
    expect(isAbsoluteTypedPath("\\\\server\\share\\x")).toBe(true);
    expect(isAbsoluteTypedPath("/home/me/x")).toBe(true);
    expect(isAbsoluteTypedPath("export.zip")).toBe(false);
    expect(agoText("2026-11-09T11:30:00Z", Date.parse("2026-11-09T12:00:00Z"))).toBe("30 min");
    expect(agoText(undefined)).toBe("–");
    expect(rawSpaceOf(".raw/a.md")).toBe("vault");
  });
});

describe("AddSourcesModal", () => {
  it("shows one row per source with counts, opens the Claude Code options and previews an export", async () => {
    const { AddSourcesModal } = await import("../src/ui/modals/AddSourcesModal");
    const settings = structuredClone(DEFAULT_SETTINGS) as CortexSettings;
    const imported: unknown[] = [];
    const services = {
      settings: { value: settings, update: async (fn: (s: CortexSettings) => void) => fn(settings) },
      sandbox: { value: false },
      sources: {
        list: async () => [{ id: "claude-code", kind: "claude-code", status: "watching", items: 3, yourShare: 0.2, storedIn: ".raw/chats/claude-code/", watching: true, lastImport: new Date().toISOString() }],
        estimate: async () => ({
          sources: [
            { source: "obsidian", items: 10, reference: 4 },
            { source: "files", items: 7, reference: 2 },
            { source: "claude-code", items: 3, reference: 0, where: "C:\\proj" },
          ],
          conversations: 3,
          notes: 6,
          tokens: 1,
          days: 1,
        }),
        inspect: async () => ({ kind: "chatgpt", conversations: 5, projects: 0, attachments: 1, alreadyImported: 2, range: ["2024-03-01T00:00:00Z", "2026-11-01T00:00:00Z"] }),
        importNow: async (sel: unknown) => void imported.push(sel),
        pauseWatching: async () => undefined,
      },
    };
    const modal = new AddSourcesModal({} as never, services as never);
    (modal as unknown as { open(): void }).open();
    await new Promise((r) => setTimeout(r, 20));
    const text = (modal as unknown as { contentEl: { allText(): string[] } }).contentEl.allText().join("\n");
    expect((modal as unknown as { titleEl: { text: string } }).titleEl.text).toBe("Add to your record");
    expect(text).toContain("6 notes · 4 reference notes hidden by default");
    expect(text).toContain("7 files · the Roblox creator docs count as reference");
    expect(text).toContain("3 sessions · checked under a minute ago");
    for (const name of ["This vault's notes", "Documents in .raw/", "Claude Code", "Claude.ai export", "ChatGPT export", "Gemini (Google Takeout)", "A folder of your own"]) expect(text).toContain(name);
    // A dropped export is recognised by the runner and continues in the matching row.
    const zone = (modal as unknown as { contentEl: { children: { classes: Set<string>; listeners: Map<string, (() => void)[]> }[] } }).contentEl.children.find((c) => c.classes.has("cx-drop-zone"));
    const drop = zone?.listeners.get("drop")?.[0] as unknown as (e: unknown) => void;
    expect(drop).toBeTypeOf("function");
    (modal as unknown as { route(p: string): Promise<void> }).route("C:\\exports\\chatgpt.zip");
    await new Promise((r) => setTimeout(r, 20));
    const after = (modal as unknown as { contentEl: { allText(): string[] } }).contentEl.allText().join("\n");
    expect(after).toContain("5 conversations · 2024-03 – 2026-11 · 0 projects · 1 attachments");
    expect(after).toContain("Only the branch you kept is imported");
    (modal as unknown as { close(): void }).close();
  });
});

describe("empty vault", () => {
  it("has nothing to import and nothing to complain about", async () => {
    const h = await harness();
    for (const [imp, sel] of [
      [new RawDocsImporter(), { kind: "raw" }],
      [new WrittenImporter(), { kind: "written" }],
      [new VaultNotesImporter(), { kind: "vault-notes" }],
    ] as const) {
      const r = await imp.run(sel as never, nextPass(h));
      expect([r.entriesAdded, r.errors.length]).toEqual([0, 0]);
    }
  });
});
