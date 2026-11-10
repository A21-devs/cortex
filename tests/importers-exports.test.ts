/**
 * Export importers (owner E4): ChatGPT, Claude.ai, Gemini, zip, streaming JSON, HTML, import.inspect.
 * Every export here is synthetic: built from the fixtures folder or inline, written to temp dirs.
 */
import { readFileSync, promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { activeBranch, chatgptText, ChatgptImporter, type ChatgptConversation } from "../src/importers/chatgpt";
import { claudeAiText, ClaudeAiImporter, type ClaudeAiConversation } from "../src/importers/claudeAi";
import { knownIdsFromLedger, type ImportContext } from "../src/importers/common";
import { geminiPrompt, groupGeminiActivities, GeminiImporter, type GeminiActivity } from "../src/importers/gemini";
import { htmlToText } from "../src/importers/html";
import { inspectExport, recogniseExport } from "../src/importers/inspect";
import { streamJsonArray } from "../src/importers/jsonStream";
import { createImporters } from "../src/importers/registry";
import { crc32, EOCD_SIGNATURE, openExportSource, openZip } from "../src/importers/zip";
import { NEVER_CANCELLED } from "../src/shared/cancel";
import { nullLogger } from "../src/shared/log";
import { DEFAULT_SETTINGS, type CortexSettings } from "../src/shared/settings";
import type { EntryRecord } from "../src/shared/types";
import { createLedgerStore } from "../src/store/ledger";
import { openStoreContext } from "../src/store/layout";
import { loadSourceManifest } from "../src/store/manifest";
import { readText } from "../src/store/segments";

const FIX = path.join(__dirname, "fixtures");
const json = <T>(p: string): T => JSON.parse(readFileSync(path.join(FIX, p), "utf8")) as T;
const tmp = (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), "cortex-e4-"));

// ───────────────────────────── helpers: a tiny zip writer and an import harness ─────────────────────────────

interface ZipMember {
  name: string;
  data: Buffer | string;
  deflate?: boolean;
}

/** A zip with stored or deflated members (enough of the format for the reader under test). */
function buildZip(members: readonly ZipMember[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const m of members) {
    const raw = Buffer.isBuffer(m.data) ? m.data : Buffer.from(m.data, "utf8");
    const body = m.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(m.name, "utf8");
    const crc = crc32(raw) >>> 0;
    const method = m.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD_SIGNATURE, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

async function writeZip(members: readonly ZipMember[]): Promise<string> {
  const dir = await tmp();
  const file = path.join(dir, "export.zip");
  await fsp.writeFile(file, buildZip(members));
  return file;
}

function settingsWith(patch?: (s: CortexSettings) => void): CortexSettings {
  const s = structuredClone(DEFAULT_SETTINGS) as CortexSettings;
  patch?.(s);
  return s;
}

interface Harness {
  vault: string;
  ctx: ImportContext;
  entries(): Promise<EntryRecord[]>;
  text(e: EntryRecord): Promise<string | null>;
  next(patch?: (s: CortexSettings) => void): ImportContext;
}

async function harness(patch?: (s: CortexSettings) => void): Promise<Harness> {
  const vault = await tmp();
  const cache = await tmp();
  const store = await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
  const ledger = createLedgerStore(store);
  const make = (s: CortexSettings): ImportContext => {
    const ctx: ImportContext = {
      store,
      ledger,
      settings: s,
      mayContinue: async () => true,
      token: NEVER_CANCELLED,
      log: nullLogger,
      progress: () => undefined,
      yield: async () => undefined,
      now: () => Date.now(),
      knownEntryIds: (conv) => knownIdsFromLedger(ctx, conv),
    };
    return ctx;
  };
  const ctx = make(settingsWith(patch));
  return {
    vault,
    ctx,
    next: (p) => make(settingsWith(p ?? patch)),
    async entries() {
      const out: EntryRecord[] = [];
      for await (const e of ledger.readAll("entries")) out.push(e);
      return out.sort((a, b) => (a.conv ?? "").localeCompare(b.conv ?? "") || (a.idx ?? 0) - (b.idx ?? 0));
    },
    async text(e) {
      const r = await readText(vault, e.text, e.textSha256);
      return r.ok ? r.text : null;
    },
  };
}

const chatgptRich = (): string => readFileSync(path.join(FIX, "chatgpt", "conversations-rich.json"), "utf8");
const claudeBranches = (): string => readFileSync(path.join(FIX, "claude-ai", "conversations-branches.json"), "utf8");
const claudeSimple = (): string => readFileSync(path.join(FIX, "claude-ai", "conversations.json"), "utf8");
const chatgptSimple = (): string => readFileSync(path.join(FIX, "chatgpt", "conversations.json"), "utf8");
const geminiMixed = (): string => readFileSync(path.join(FIX, "gemini", "MyActivity-mixed.json"), "utf8");

const chatgptZip = (conversations: string = chatgptSimple()): Promise<string> =>
  writeZip([
    { name: "conversations.json", data: conversations, deflate: true },
    { name: "user.json", data: '{"id":"u","email":"private@example.invalid"}' },
    { name: "chat.html", data: "<html></html>" },
    { name: "message_feedback.json", data: "[]" },
  ]);

const claudeZip = (conversations: string = claudeSimple(), withProjects = true): Promise<string> =>
  writeZip([
    { name: "conversations.json", data: conversations, deflate: true },
    { name: "users.json", data: '[{"uuid":"u","full_name":"Private Name","email_address":"private@example.invalid"}]' },
    ...(withProjects ? [{ name: "projects.json", data: readFileSync(path.join(FIX, "claude-ai", "projects.json"), "utf8") }] : []),
  ]);

const geminiZip = (activity: string = geminiMixed()): Promise<string> =>
  writeZip([
    { name: "Takeout/archive_browser.html", data: "<html></html>" },
    { name: "Takeout/My Activity/Gemini Apps/MyActivity.json", data: activity, deflate: true },
  ]);

// ───────────────────────────── pure helpers (kept from the scaffold) ─────────────────────────────

describe("importers/chatgpt helpers", () => {
  const [conv] = json<ChatgptConversation[]>("chatgpt/conversations.json");
  it("follows the active branch from current_node to the root", () => {
    expect(activeBranch(conv as ChatgptConversation)).toEqual(["root", "n1", "n2", "n3", "n4b"]);
  });
  it("falls back to the newest leaf when current_node is missing", () => {
    expect(activeBranch({ ...(conv as ChatgptConversation), current_node: "missing" }).at(-1)).toBe("n4a");
  });
  it("renders code content as a fenced block", () => {
    const n4b = conv?.mapping?.n4b?.message;
    expect(n4b && chatgptText(n4b)).toBe("```python\nprint('tomatoes')\n```");
  });
  it("registers the three importers with their sources", () => {
    expect(new ChatgptImporter().source).toBe("chatgpt");
    expect(new ClaudeAiImporter().source).toBe("claude-ai");
    expect(new GeminiImporter().source).toBe("gemini");
  });
});

describe("importers/claudeAi helpers", () => {
  it("joins text blocks, falling back to the text field", () => {
    const [c] = json<ClaudeAiConversation[]>("claude-ai/conversations.json");
    const msgs = c?.chat_messages ?? [];
    expect(claudeAiText(msgs[0] as never)).toBe("Help me fix this formula.");
    expect(claudeAiText(msgs[1] as never)).toBe("Use SUMIF instead.\n\nThen copy it down.");
    expect(claudeAiText({ uuid: "x", sender: "human", text: "legacy" })).toBe("legacy");
  });
});

describe("importers/gemini + html helpers", () => {
  it("strips the prompt verb, groups by gaps and converts replies to text", () => {
    const items = json<GeminiActivity[]>("gemini/MyActivity.json");
    expect(geminiPrompt(items[0] as GeminiActivity)).toBe("how do magnets work");
    expect(groupGeminiActivities(items, 30).map((g) => g.length)).toEqual([2, 1]);
    expect(htmlToText(items[1]?.safeHtmlItem?.[0]?.html ?? "")).toBe("Opposite poles attract & like poles repel.");
    expect(htmlToText("<ul><li>Flour</li><li>Water</li></ul>")).toBe("- Flour\n- Water");
  });
});

describe("importers/zip + jsonStream", () => {
  it("zip opens by path and jsonStream reads a top-level array element by element", async () => {
    expect(EOCD_SIGNATURE).toBe(0x06054b50);
    await expect(openZip("x.zip")).rejects.toBeTruthy();
    const got: unknown[] = [];
    for await (const el of streamJsonArray(Readable.from(['[{"a":1},', '{"b":[2,3]}]']))) got.push((el as { value?: unknown }).value ?? el);
    expect(got.length).toBe(2);
    const empty = streamJsonArray(Readable.from(["[]"]));
    expect((await empty.next()).done).toBe(true);
  });
  it("reads stored and deflated members of a zip, and a folder the same way", async () => {
    const file = await writeZip([
      { name: "a/one.json", data: "[1]" },
      { name: "a/two.json", data: "[2,3]", deflate: true },
    ]);
    const zsrc = await openExportSource(file);
    expect(zsrc.form).toBe("zip");
    expect(zsrc.members.map((m) => m.name).sort()).toEqual(["a/one.json", "a/two.json"]);
    const read = async (s: typeof zsrc, n: string): Promise<string> => {
      const chunks: Buffer[] = [];
      for await (const c of await s.open(n)) chunks.push(Buffer.from(c as Uint8Array));
      return Buffer.concat(chunks).toString("utf8");
    };
    expect(await read(zsrc, "a/two.json")).toBe("[2,3]");
    await zsrc.close();
    const dir = await tmp();
    await fsp.mkdir(path.join(dir, "a"));
    await fsp.writeFile(path.join(dir, "a", "one.json"), "[1]");
    const fsrc = await openExportSource(dir);
    expect(fsrc.form).toBe("folder");
    expect(await read(fsrc, "a/one.json")).toBe("[1]");
    await fsrc.close();
  });
  it("recognises exports by member names", () => {
    expect(recogniseExport(["conversations.json", "users.json"])).toBe("claude-ai");
    expect(recogniseExport(["conversations.json", "chat.html"])).toBe("chatgpt");
    expect(recogniseExport(["Takeout/My Activity/Gemini Apps/MyActivity.json"])).toBe("gemini");
    expect(recogniseExport(["notes.txt"])).toBe("unknown");
  });
});

// ───────────────────────────── ChatGPT ─────────────────────────────

describe("ChatgptImporter.run", () => {
  it("imports the kept branch, keeps the other branch as a version and dates a missing timestamp from the conversation", async () => {
    const h = await harness();
    const file = await chatgptZip();
    const stats = await new ChatgptImporter().run({ kind: "chatgpt", file }, h.ctx);
    expect(stats.errors).toEqual([]);
    const recs = await h.entries();
    // active branch: n2 (user), n3 (assistant), n4b (user, code, no time); n1 is hidden context
    expect(recs).toHaveLength(3);
    expect(recs.map((r) => r.speaker)).toEqual(["you", "assistant", "you"]);
    expect(recs[1]?.speakerDetail).toBe("gpt-4o");
    expect(await h.text(recs[0] as EntryRecord)).toBe("What should I plant in spring?");
    expect(await h.text(recs[2] as EntryRecord)).toBe("```python\nprint('tomatoes')\n```");
    const last = recs[2] as EntryRecord;
    expect(last.dates.some((d) => d.type === "conversation-start" && d.strength === "medium")).toBe(true);
    expect(last.dates.some((d) => d.type === "source-timestamp")).toBe(false);
    // the sibling "And tomatoes?" is an earlier wording of that turn
    expect(last.branches).toHaveLength(1);
    const alt = last.branches?.[0];
    expect(alt?.nativeId).toBe("n4a");
    const altText = alt && (await readText(h.vault, alt.text, alt.textSha256));
    expect(altText && altText.ok && altText.text).toBe("And tomatoes?");
  });

  it("is quiet the second time and records the export in the sources manifest", async () => {
    const h = await harness();
    const file = await chatgptZip();
    const first = await new ChatgptImporter().run({ kind: "chatgpt", file }, h.ctx);
    expect(first.entriesAdded).toBe(3);
    const second = await new ChatgptImporter().run({ kind: "chatgpt", file }, h.next());
    expect(second.entriesAdded).toBe(0);
    expect((await h.entries()).length).toBe(3);
    const rows = Object.entries((await loadSourceManifest(h.ctx.store)).sources);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[0].startsWith("chatgpt:")).toBe(true);
    expect(rows[0]?.[1].status).toBe("imported");
  });

  it("drops images, tools, reasoning and context by default; lists attachments; holds secrets; keeps unicode", async () => {
    const h = await harness();
    const file = await chatgptZip(chatgptRich());
    await new ChatgptImporter().run({ kind: "chatgpt", file }, h.ctx);
    const recs = await h.entries();
    expect(recs.map((r) => [r.speaker, r.hiddenByDefault])).toEqual([
      ["you", undefined],
      ["assistant", undefined],
      ["assistant", undefined],
    ]);
    const user = await h.text(recs[0] as EntryRecord);
    expect(user).toContain("Café ☕ — 你好 🌱 مرحبا");
    expect(user).not.toContain("AKIAIOSFODNN7EXAMPLE"); // held back from the vault copy
    expect(recs[0]?.attachments?.map((a) => [a.name, a.bytes, a.mime, a.path])).toEqual([
      ["plan.pdf", 2048, "application/pdf", undefined],
      ["file-pic1", 5000, "image/*", undefined],
    ]);
    expect(await h.text(recs[1] as EntryRecord)).toBe("Planted  in spring.");
    expect(await h.text(recs[2] as EntryRecord)).toBe("The answer is two.");
    // the original stays out of every stored text
    for (const r of recs) expect(await h.text(r)).not.toMatch(/weighing the options|private profile|print\(1/);
  });

  it("keeps tool output and reasoning only when asked, hidden by default", async () => {
    const h = await harness((s) => {
      s.sources.chatgpt.includeToolOutput = true;
      s.sources.chatgpt.includeThinking = true;
    });
    await new ChatgptImporter().run({ kind: "chatgpt", file: await chatgptZip(chatgptRich()) }, h.ctx);
    const recs = await h.entries();
    expect(recs).toHaveLength(6);
    expect(recs.filter((r) => r.hiddenByDefault === "tool")).toHaveLength(3);
    expect(recs.filter((r) => r.speaker === "tool")).toHaveLength(2); // the python call and its output
    const thinking = recs.find((r) => r.speakerDetail === "thinking");
    expect(thinking && (await h.text(thinking))).toBe("weighing the options");
  });

  it("reads a conversation with no mapping, a cycle and a dangling current_node without failing", async () => {
    const odd = [
      { title: "no mapping", conversation_id: "x1", create_time: 1731000000, mapping: null },
      {
        title: "cycle",
        conversation_id: "x2",
        create_time: 1731000000,
        current_node: "gone",
        mapping: {
          a: { id: "a", parent: "b", children: ["b"], message: { id: "a", author: { role: "user" }, create_time: 1731000001, content: { content_type: "text", parts: ["hello"] } } },
          b: { id: "b", parent: "a", children: ["a"], message: { id: "b", author: { role: "assistant" }, create_time: 1731000002, content: { content_type: "text", parts: ["hi"] } } },
        },
      },
    ];
    const h = await harness();
    const stats = await new ChatgptImporter().run({ kind: "chatgpt", file: await chatgptZip(JSON.stringify(odd)) }, h.ctx);
    expect(stats.errors).toEqual([]);
    expect(stats.entriesAdded).toBeGreaterThanOrEqual(1);
  });

  it("imports the complete conversations of a truncated file, then reports the damage", async () => {
    const full = JSON.stringify([...json<unknown[]>("chatgpt/conversations.json"), ...json<unknown[]>("chatgpt/conversations.json").map((c) => ({ ...(c as object), conversation_id: "conv-2" }))]);
    const cut = full.slice(0, full.length - 40); // inside the second conversation
    const h = await harness();
    const stats = await new ChatgptImporter().run({ kind: "chatgpt", file: await chatgptZip(cut) }, h.ctx);
    expect(stats.entriesAdded).toBe(3);
    expect((stats as { partial?: boolean }).partial).toBe(true);
    expect(stats.errors.map((e) => e.message)).toContain("E_PARSE");
    const row = Object.values((await loadSourceManifest(h.ctx.store)).sources)[0];
    expect(row?.status).toBe("error");
  });

  it("reads the numbered conversation files of a newer export in order, from a folder", async () => {
    const dir = await tmp();
    const [conv] = json<ChatgptConversation[]>("chatgpt/conversations.json");
    await fsp.writeFile(path.join(dir, "conversations-000.json"), JSON.stringify([conv]));
    await fsp.writeFile(path.join(dir, "conversations-001.json"), JSON.stringify([{ ...conv, conversation_id: "conv-b" }]));
    await fsp.writeFile(path.join(dir, "message_feedback.json"), "[]");
    const h = await harness();
    const stats = await new ChatgptImporter().run({ kind: "chatgpt", file: dir }, h.ctx);
    expect(stats.entriesAdded).toBe(6);
  });

  it("stops at the unit limit and resumes from the saved cursor", async () => {
    const [conv] = json<ChatgptConversation[]>("chatgpt/conversations.json");
    const many = [1, 2, 3, 4].map((n) => ({ ...conv, conversation_id: `conv-${n}` }));
    const file = await chatgptZip(JSON.stringify(many));
    const h = await harness();
    const part = await new ChatgptImporter().run({ kind: "chatgpt", file }, { ...h.ctx, maxEntries: 3 });
    expect((part as { partial?: boolean }).partial).toBe(true);
    expect((await h.entries()).length).toBe(3);
    const row = Object.values((await loadSourceManifest(h.ctx.store)).sources)[0];
    expect(row?.status).toBe("paused");
    const rest = await new ChatgptImporter().run({ kind: "chatgpt", file }, h.next());
    expect(rest.entriesAdded).toBe(9);
    expect((await h.entries()).length).toBe(12);
  });

  it("does nothing when ChatGPT is turned off, and refuses an export of another service", async () => {
    const off = await harness((s) => void (s.sources.chatgpt.enabled = false));
    expect((await new ChatgptImporter().run({ kind: "chatgpt", file: await chatgptZip() }, off.ctx)).entriesAdded).toBe(0);
    const h = await harness();
    const wrong = await new ChatgptImporter().run({ kind: "chatgpt", file: await geminiZip() }, h.ctx);
    expect(wrong.errors.map((e) => e.message)).toEqual(["export-not-recognised"]);
  });
});

// ───────────────────────────── Claude.ai ─────────────────────────────

describe("ClaudeAiImporter.run", () => {
  it("turns text attachments into documents, lists them on the message, and keeps images out", async () => {
    const h = await harness();
    const stats = await new ClaudeAiImporter().run({ kind: "claude-ai", file: await claudeZip() }, h.ctx);
    expect(stats.errors).toEqual([]);
    const recs = await h.entries();
    const conv = recs.filter((r) => r.conv === recs.find((x) => x.kind === "message")?.conv);
    expect(conv.map((r) => [r.kind, r.speaker])).toEqual([
      ["message", "you"],
      ["document", "you"],
      ["message", "assistant"],
    ]);
    expect(await h.text(conv[0] as EntryRecord)).toBe("Help me fix this formula.");
    expect(await h.text(conv[1] as EntryRecord)).toBe("a,b\n1,2");
    expect(conv[0]?.attachments).toEqual([{ name: "sheet.csv", bytes: 120, mime: "text/csv" }]);
    expect(await h.text(conv[2] as EntryRecord)).toBe("Use SUMIF instead.\n\nThen copy it down.");
    expect(conv[2]?.speakerDetail).toBe("Claude");
    // project instructions and the one non-empty project document, outside any conversation
    const docs = recs.filter((r) => r.kind === "document" && r.conv === undefined);
    expect(docs.map((d) => d.project)).toEqual(["Garden notes", "Garden notes"]);
    expect((await Promise.all(docs.map((d) => h.text(d)))).sort()).toEqual(["Answer as a patient gardener.", "Bed one gets peas."]);
  });

  it("leaves attachment text out when the setting is off, but still lists the file", async () => {
    const h = await harness((s) => void (s.sources.claudeAi.includeAttachments = false));
    await new ClaudeAiImporter().run({ kind: "claude-ai", file: await claudeZip(claudeSimple(), false) }, h.ctx);
    const recs = await h.entries();
    expect(recs.map((r) => r.kind)).toEqual(["message", "message"]);
    expect(recs[0]?.attachments?.[0]?.name).toBe("sheet.csv");
  });

  it("keeps the newest branch, stores the other as a version, drops thinking blocks, files the chat in its project", async () => {
    const h = await harness();
    await new ClaudeAiImporter().run({ kind: "claude-ai", file: await claudeZip(claudeBranches()) }, h.ctx);
    const recs = (await h.entries()).filter((r) => r.conv !== undefined);
    expect(await Promise.all(recs.map((r) => h.text(r)))).toEqual(["Name my cat.", "Perhaps Biscuit.", "Biscuit it is, thanks 🐈"]);
    expect(recs[0]?.attachments?.map((a) => [a.name, a.mime])).toEqual([["cat.png", "image/png"]]);
    expect(recs[1]?.branches).toHaveLength(1);
    const v = recs[1]?.branches?.[0];
    const vt = v && (await readText(h.vault, v.text, v.textSha256));
    expect(vt && vt.ok && vt.text).toBe("How about Miso?");
    expect(recs[0]?.folder).toEqual(["Garden notes"]);
    for (const r of recs) expect(await h.text(r)).not.toContain("private chain");
  });

  it("dates a message with no created_at from its conversation and skips an empty message", async () => {
    const data = [
      {
        uuid: "nd-1",
        name: "",
        created_at: "2026-06-01T10:00:00.000000Z",
        chat_messages: [
          { uuid: "n1", sender: "human", text: "No stamp on me", content: [], attachments: [], files: [] },
          { uuid: "n2", sender: "assistant", text: "", content: [], attachments: [], files: [] },
        ],
      },
    ];
    const h = await harness();
    await new ClaudeAiImporter().run({ kind: "claude-ai", file: await claudeZip(JSON.stringify(data), false) }, h.ctx);
    const recs = await h.entries();
    expect(recs).toHaveLength(1);
    expect(recs[0]?.dates.some((d) => d.type === "conversation-start")).toBe(true);
    expect(recs[0]?.writtenAt).toBe("2026-06-01T10:00:00.000Z");
  });

  it("reports a cut-off file and a file that is not a list", async () => {
    const cut = claudeSimple().slice(0, 300);
    const h = await harness();
    const stats = await new ClaudeAiImporter().run({ kind: "claude-ai", file: await claudeZip(cut, false) }, h.ctx);
    expect(stats.errors.length).toBeGreaterThan(0);
    const bad = await new ClaudeAiImporter().run({ kind: "claude-ai", file: await claudeZip('{"not":"a list"}', false) }, h.next());
    expect(bad.entriesAdded).toBe(0);
    expect(bad.errors.length).toBeGreaterThan(0);
  });

  it("is quiet the second time", async () => {
    const h = await harness();
    const file = await claudeZip();
    const a = await new ClaudeAiImporter().run({ kind: "claude-ai", file }, h.ctx);
    const b = await new ClaudeAiImporter().run({ kind: "claude-ai", file }, h.next());
    expect(a.entriesAdded).toBeGreaterThan(0);
    expect(b.entriesAdded).toBe(0);
  });
});

// ───────────────────────────── Gemini ─────────────────────────────

describe("GeminiImporter.run", () => {
  it("groups exchanges by time gap, skips other activity, lists files, keeps unicode and undated records", async () => {
    const h = await harness();
    const stats = await new GeminiImporter().run({ kind: "gemini", file: await geminiZip() }, h.ctx);
    expect(stats.errors).toEqual([]);
    const recs = await h.entries();
    // 5 exchanges (the "Used Gemini Apps" line is not one) = 10 entries in 4 conversations:
    // {long ago}, {evening 19:00 + 19:05}, {newest}, {undated}
    expect(recs).toHaveLength(10);
    expect(new Set(recs.map((r) => r.conv)).size).toBe(4);
    const texts = await Promise.all(recs.map((r) => h.text(r)));
    expect(texts).toContain("café ☕ 你好");
    expect(texts).toContain("Bonjour 🌱");
    expect(texts).toContain("Newest **answer**.");
    const photo = recs.find((r) => r.attachments?.some((a) => a.name === "photo.jpg"));
    expect(photo?.speaker).toBe("you");
    const evening = recs.filter((r) => r.conv === photo?.conv);
    expect(evening.map((r) => r.speaker)).toEqual(["you", "assistant", "you", "assistant"]);
    expect(await h.text(evening[0] as EntryRecord)).toBe("second in the evening"); // oldest first
    expect(recs.filter((r) => !r.dates.some((d) => d.type === "source-timestamp")).length).toBe(2); // the undated pair
  });

  it("a larger gap merges the evening and the next morning; the gap is part of the resume cursor", async () => {
    const wide = await harness((s) => void (s.sources.gemini.gapMinutes = 24 * 60));
    await new GeminiImporter().run({ kind: "gemini", file: await geminiZip() }, wide.ctx);
    expect(new Set((await wide.entries()).map((r) => r.conv)).size).toBe(3);
  });

  it("reports a Takeout made in HTML and an export with no Gemini activity, without importing", async () => {
    const html = await writeZip([{ name: "Takeout/My Activity/Gemini Apps/MyActivity.html", data: readFileSync(path.join(FIX, "gemini", "MyActivity.html"), "utf8") }]);
    const h = await harness();
    const a = await new GeminiImporter().run({ kind: "gemini", file: html }, h.ctx);
    expect(a.errors.map((e) => e.message)).toEqual(["takeout-html"]);
    const none = await writeZip([{ name: "Takeout/archive_browser.html", data: "<html></html>" }, { name: "Takeout/Drive/readme.txt", data: "x" }]);
    const b = await new GeminiImporter().run({ kind: "gemini", file: none }, h.next());
    expect(b.errors.map((e) => e.message)).toEqual(["export-empty"]);
    expect(await h.entries()).toHaveLength(0);
  });

  it("imports the complete records of a truncated file, then reports the damage", async () => {
    const text = geminiMixed();
    const cut = text.slice(0, text.lastIndexOf('{ "header"')); // drops the last record entirely, leaving a dangling comma
    const h = await harness();
    const stats = await new GeminiImporter().run({ kind: "gemini", file: await geminiZip(cut) }, h.ctx);
    expect((stats as { partial?: boolean }).partial).toBe(true);
    expect(stats.errors.map((e) => e.message)).toContain("E_PARSE");
    expect((await h.entries()).length).toBeGreaterThanOrEqual(8);
  });

  it("is quiet the second time, from a Takeout folder as well", async () => {
    const dir = await tmp();
    const sub = path.join(dir, "Takeout", "My Activity", "Gemini Apps");
    await fsp.mkdir(sub, { recursive: true });
    await fsp.writeFile(path.join(sub, "MyActivity.json"), geminiMixed());
    const h = await harness();
    const a = await new GeminiImporter().run({ kind: "gemini", file: dir }, h.ctx);
    const b = await new GeminiImporter().run({ kind: "gemini", file: dir }, h.next());
    expect(a.entriesAdded).toBe(10);
    expect(b.entriesAdded).toBe(0);
  });
});

// ───────────────────────────── import.inspect and the registry ─────────────────────────────

describe("inspectExport", () => {
  it("previews a ChatGPT export: conversations, range, attachments, nothing from the text", async () => {
    const h = await harness();
    const r = await inspectExport({ file: await chatgptZip(chatgptRich()) }, h.ctx);
    expect(r).toMatchObject({ kind: "chatgpt", conversations: 1, projects: 0, attachments: 2, alreadyImported: 0 });
    expect(r.range?.[0]).toBe("2024-11-07T17:20:00.000Z");
    expect(JSON.stringify(r)).not.toMatch(/Café|plan|garden/i);
  });

  it("previews a Claude.ai export with its projects, then counts what is already here and spots an older export", async () => {
    const h = await harness();
    const file = await claudeZip();
    const before = await inspectExport({ file }, h.ctx);
    expect(before).toMatchObject({ kind: "claude-ai", conversations: 1, projects: 1, attachments: 1, alreadyImported: 0 });
    await new ClaudeAiImporter().run({ kind: "claude-ai", file }, h.ctx);
    const after = await inspectExport({ file }, h.next());
    expect(after.alreadyImported).toBe(1);
    expect(after.olderThanImportedAt).toBeUndefined();
    // an export of the same account that ends earlier than what is recorded
    const older = JSON.parse(claudeSimple()) as ClaudeAiConversation[];
    const c = older[0] as ClaudeAiConversation;
    c.uuid = "ca-conv-older";
    for (const m of c.chat_messages ?? []) m.created_at = "2025-01-01T00:00:00.000000Z";
    c.created_at = c.updated_at = "2025-01-01T00:00:00.000000Z";
    const olderRes = await inspectExport({ file: await claudeZip(JSON.stringify(older), false) }, h.next());
    expect(olderRes.olderThanImportedAt).toBeDefined();
  });

  it("previews a Gemini export grouped by the current gap, and flags HTML, empty and unknown inputs", async () => {
    const h = await harness();
    const r = await inspectExport({ file: await geminiZip() }, h.ctx);
    expect(r).toMatchObject({ kind: "gemini", conversations: 4, attachments: 1, projects: 0 });
    expect(r.range).toEqual(["2026-01-01T00:00:00.000Z", "2026-05-03T09:00:00.000Z"]);
    const html = await writeZip([{ name: "Takeout/My Activity/Gemini Apps/MyActivity.html", data: "<html></html>" }]);
    expect(await inspectExport({ file: html }, h.ctx)).toMatchObject({ kind: "gemini", conversations: 0, problem: "takeout-html" });
    const empty = await writeZip([{ name: "conversations.json", data: "[]" }, { name: "users.json", data: "[]" }]);
    expect((await inspectExport({ file: empty }, h.ctx)).problem).toBe("export-empty");
    const other = await writeZip([{ name: "notes.txt", data: "hello" }]);
    expect(await inspectExport({ file: other }, h.ctx)).toMatchObject({ kind: "unknown", problem: "export-not-recognised" });
  });

  it("recognises a single dropped conversations.json by its content, and refuses bad paths", async () => {
    const dir = await tmp();
    const file = path.join(dir, "download.json");
    await fsp.writeFile(file, chatgptSimple());
    const h = await harness();
    expect((await inspectExport({ file }, h.ctx)).kind).toBe("chatgpt");
    expect((await inspectExport({ file: "relative/export.zip" }, h.ctx)).problem).toBe("path-unreadable");
    expect((await inspectExport({ file: path.join(dir, "missing.zip") }, h.ctx)).problem).toBe("path-unreadable");
    await fsp.writeFile(path.join(dir, "garbage.zip"), "not a zip at all");
    expect((await inspectExport({ file: path.join(dir, "garbage.zip") }, h.ctx)).problem).toBe("export-not-recognised");
  });

  it("counts the complete conversations of a truncated export", async () => {
    const h = await harness();
    const r = await inspectExport({ file: await claudeZip(claudeSimple().slice(0, 300), false) }, h.ctx);
    expect(r.kind).toBe("claude-ai");
    expect(r.conversations).toBe(0);
  });
});

describe("registry", () => {
  it("offers the three export importers, each discovering the chosen file", async () => {
    const importers = createImporters();
    const file = await chatgptZip();
    const h = await harness();
    for (const kind of ["claude-ai", "chatgpt", "gemini"] as const) {
      const units = await importers[kind].discover({ kind, file } as never, h.ctx);
      expect(units.map((u) => u.path)).toEqual([file]);
    }
    expect(await importers.chatgpt.discover({ kind: "chatgpt", file: "nope" }, h.ctx)).toEqual([]);
  });
});
