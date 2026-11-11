/**
 * Opt-in session importers for Codex CLI, Gemini CLI and Cursor: parsing, privacy defaults, live staging and
 * sealing, resuming, exclusions, the registry and the SQLite reader. Every file here is synthetic and lives in temp
 * folders; nothing is read from the real tools' folders.
 */
import { createRequire } from "node:module";
import { promises as fsp, readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexRollout, codexSessionIdOfFile, isCodexHarnessText } from "../src/importers/codexCli";
import { contentNativeId, projectOfCwd, toIso } from "../src/importers/agentSessions";
import { stagedMessages } from "../src/importers/common";
import { cursorMessages, discoverCursorFiles, parseCursorChatTabs, projectOfWorkspaceFolder, readCursorDb, type SqliteDb } from "../src/importers/cursor";
import { discoverGeminiFiles, parseGeminiChat, parseGeminiLogs } from "../src/importers/geminiCli";
import { EXTRA_GROUPS, extraImporters } from "../src/importers/extra";
import { createImporters } from "../src/importers/registry";
import { conversationId } from "../src/shared/ids";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { loadSourceManifest } from "../src/store/manifest";
import { harness, tmpDir } from "./helpers/importHarness";

const FIX = path.join(__dirname, "fixtures", "agent-clis");
const NO_TOOLS = { includeToolOutput: false };
const WITH_TOOLS = { includeToolOutput: true };
const ROLLOUT = path.join(FIX, "codex-rollout.jsonl");

const rollout = (opts = NO_TOOLS): ReturnType<CodexRollout["finish"]> => {
  const r = new CodexRollout("fallback", opts);
  for (const line of readFileSync(ROLLOUT, "utf8").split("\n")) r.push(line);
  return r.finish(true);
};

describe("agent CLI settings and registry", () => {
  it("are off by default, with tool output off and watching on", () => {
    for (const k of ["codexCli", "geminiCli", "cursor"] as const) {
      expect(DEFAULT_SETTINGS.sources[k]).toEqual({ enabled: false, dir: "", watch: true, includeToolOutput: false, liveIdleMinutes: 10 });
    }
  });
  it("register through importers/extra and reach the registry", () => {
    expect(Object.keys(extraImporters()).sort()).toEqual(expect.arrayContaining(["codex-cli", "cursor", "gemini-cli"]));
    expect(EXTRA_GROUPS.map((g) => g.name)).toContain("agentCli");
    const all = createImporters();
    expect(all["codex-cli"].source).toBe("codex-cli");
    expect(all["gemini-cli"].label).toBe("Gemini CLI");
    expect(all.cursor.kind).toBe("cursor");
  });
  it("helpers: ids, projects and times", () => {
    expect(projectOfCwd("C:\\Users\\me\\proj\\")).toBe("proj");
    expect(projectOfCwd("/home/me/proj")).toBe("proj");
    expect(projectOfCwd(undefined)).toBeUndefined();
    expect(toIso(1_772_000_000)).toBe(new Date(1_772_000_000_000).toISOString());
    expect(toIso(1_772_000_000_000)).toBe(new Date(1_772_000_000_000).toISOString());
    expect(toIso("nope")).toBeUndefined();
    const seen = new Map<string, number>();
    const a = contentNativeId(seen, "t", "you", "same");
    expect(contentNativeId(seen, "t", "you", "same")).toBe(`${a}#1`);
  });
});

describe("Codex CLI rollout", () => {
  it("keeps what you typed and the replies, and nothing injected", () => {
    const s = rollout();
    expect(s.nativeId).toBe("019a0000-aaaa-bbbb-cccc-000000000001");
    expect(s.project).toBe("sample-proj");
    expect(s.messages.map((m) => [m.speaker, m.text])).toEqual([
      ["you", "Add a retry to the upload helper."],
      ["assistant", "I added a three-attempt retry with backoff."],
    ]);
    const all = JSON.stringify(s.messages);
    expect(all).not.toContain("private reasoning");
    expect(all).not.toContain("developer rules");
    expect(all).not.toContain("environment_context");
  });
  it("adds tool calls and output (hidden) only when asked, in order", () => {
    const s = rollout(WITH_TOOLS);
    expect(s.messages.map((m) => m.speaker)).toEqual(["you", "tool", "tool", "assistant"]);
    expect(s.messages.filter((m) => m.hidden === "tool")).toHaveLength(2);
    expect(s.messages[1]?.text).toContain("shell");
    expect(s.messages[2]?.text).toContain("upload.ts");
  });
  it("reads the older shape and falls back to event messages", () => {
    const old = new CodexRollout("old", NO_TOOLS);
    old.push('{"id":"11111111-2222-3333-4444-555555555555","timestamp":"2025-05-01T00:00:00.000Z","instructions":null}');
    old.push('{"type":"message","role":"user","content":[{"type":"input_text","text":"hello there"}]}');
    old.push('{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}');
    old.push('{"record_type":"state"}');
    const s = old.finish(true);
    expect(s.nativeId).toBe("11111111-2222-3333-4444-555555555555");
    expect(s.messages.map((m) => m.text)).toEqual(["hello there", "hi"]);
    const ev = new CodexRollout("ev", NO_TOOLS);
    ev.push('{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"only events"}}');
    expect(ev.finish(true).messages.map((m) => m.text)).toEqual(["only events"]);
  });
  it("marks a half-written last line as incomplete", () => {
    const r = new CodexRollout("f", NO_TOOLS);
    r.push('{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"user_message","message":"a"}}');
    r.push('{"timestamp":"2026-01-01T00:00:01Z","type":"event_msg","payload":{"type":"agent_mess');
    expect(r.finish(false).incomplete).toBe(true);
    expect(isCodexHarnessText("# AGENTS.md instructions for x")).toBe(true);
    expect(isCodexHarnessText("please fix the build")).toBe(false);
    expect(codexSessionIdOfFile("C:/x/rollout-2026-03-01T10-00-00-019A0000-AAAA-BBBB-CCCC-000000000001.jsonl")).toBe("019a0000-aaaa-bbbb-cccc-000000000001");
  });
});

describe("Gemini CLI history", () => {
  const chat = JSON.parse(readFileSync(path.join(FIX, "gemini-chat.json"), "utf8")) as unknown;
  it("keeps prompts and replies, never thoughts, info lines or (by default) tool traffic", () => {
    const s = parseGeminiChat(chat, "f", NO_TOOLS);
    expect(s?.nativeId).toBe("gem-session-0001");
    expect(s?.messages.map((m) => [m.speaker, m.text])).toEqual([
      ["you", "Explain the cache layout."],
      ["assistant", "The cache keeps state, stage and held files apart."],
      ["you", "Thanks."],
    ]);
    expect(s?.messages[1]?.speakerDetail).toBe("gemini-2.5-pro");
    expect(JSON.stringify(s)).not.toContain("private thinking");
    const withTools = parseGeminiChat(chat, "f", WITH_TOOLS);
    expect(withTools?.messages.filter((m) => m.hidden === "tool").map((m) => m.text)).toEqual(['read_file: {"path":"notes.md"}', "file body"]);
  });
  it("reads logs.json as your prompts only, grouped by session", () => {
    const s = parseGeminiLogs([
      { sessionId: "s1", messageId: 0, type: "user", message: "one", timestamp: "2026-03-02T09:00:00.000Z" },
      { sessionId: "s1", messageId: 1, type: "user", message: "two", timestamp: "2026-03-02T09:01:00.000Z" },
      { sessionId: "s2", messageId: 0, type: "model", message: "ignored" },
    ]);
    expect(s).toHaveLength(1);
    expect(s[0]?.messages.map((m) => m.text)).toEqual(["one", "two"]);
    expect(parseGeminiChat({ nothing: true }, "f", NO_TOOLS)).toBeNull();
  });
  it("finds chat files, and logs.json only where there are no chats", async () => {
    const root = await tmpDir();
    await fsp.mkdir(path.join(root, "tmp", "h1", "chats"), { recursive: true });
    await fsp.mkdir(path.join(root, "tmp", "h2"), { recursive: true });
    await fsp.writeFile(path.join(root, "tmp", "h1", "chats", "session-2026-03-02T09-00-abc.json"), "{}");
    await fsp.writeFile(path.join(root, "tmp", "h1", "logs.json"), "[]");
    await fsp.writeFile(path.join(root, "tmp", "h2", "logs.json"), "[]");
    await fsp.writeFile(path.join(root, "tmp", "h1", "chats", "checkpoint-x.json"), "{}");
    const found = (await discoverGeminiFiles(root)).map((u) => u.label).sort();
    expect(found).toEqual(["tmp/h1/chats/session-2026-03-02T09-00-abc.json", "tmp/h2/logs.json"]);
  });
});

type PutDb = SqliteDb & { exec(sql: string): void };

describe("Cursor chat store", () => {
  it("parses bubbles and the older chat panel", () => {
    const tool = { name: "edit_file", params: { path: "a.ts" }, result: "ok" };
    const msgs = cursorMessages(
      [
        { id: "b1", type: 1, text: "  fix the layout  ", createdAt: "2026-03-03T08:00:00.000Z" },
        { id: "b2", type: 2, text: "Done.", model: "gpt-x" },
        { id: "b3", type: 2, text: "", toolFormerData: tool },
      ],
      NO_TOOLS,
    );
    expect(msgs.map((m) => [m.speaker, m.text])).toEqual([["you", "fix the layout"], ["assistant", "Done."]]);
    expect(msgs[1]?.speakerDetail).toBe("gpt-x");
    expect(cursorMessages([{ id: "b3", type: 2, text: "", toolFormerData: tool }], WITH_TOOLS).map((m) => m.hidden)).toEqual(["tool", "tool"]);
    const tabs = parseCursorChatTabs({ tabs: [{ tabId: "t1", chatTitle: "Refactor", lastSendTime: 1_772_000_000_000, bubbles: [{ type: "user", text: "hi" }, { type: "ai", text: "hello" }] }] }, "proj", NO_TOOLS);
    expect(tabs[0]).toMatchObject({ nativeId: "tab:t1", title: "Refactor", project: "proj" });
    expect(tabs[0]?.messages.map((m) => m.speaker)).toEqual(["you", "assistant"]);
    expect(projectOfWorkspaceFolder("file:///c%3A/Users/me/my%20project")).toBe("my project");
  });
  it("finds the databases and folds the write-ahead log into the unit", async () => {
    const root = await tmpDir();
    await fsp.mkdir(path.join(root, "globalStorage"), { recursive: true });
    await fsp.mkdir(path.join(root, "workspaceStorage", "w1"), { recursive: true });
    await fsp.writeFile(path.join(root, "globalStorage", "state.vscdb"), "xxxx");
    await fsp.writeFile(path.join(root, "globalStorage", "state.vscdb-wal"), "yy");
    await fsp.writeFile(path.join(root, "workspaceStorage", "w1", "state.vscdb"), "z");
    const units = await discoverCursorFiles(root);
    expect(units.map((u) => [u.label, u.bytes])).toEqual([["globalStorage/state.vscdb", 6], ["workspaceStorage/w1/state.vscdb", 1]]);
  });

  const sqlite = (() => {
    try {
      return createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (f: string) => PutDb };
    } catch {
      return null;
    }
  })();
  it.skipIf(sqlite === null)("reads composers and bubbles from a real SQLite file, skipping unchanged conversations", async () => {
    const dir = await tmpDir();
    const db = new (sqlite as NonNullable<typeof sqlite>).DatabaseSync(path.join(dir, "state.vscdb"));
    db.exec("CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    const put = (table: string, k: string, v: unknown): void => void db.prepare(`INSERT INTO ${table} VALUES (?, ?)`).run(k, JSON.stringify(v));
    put("cursorDiskKV", "composerData:comp-1", { composerId: "comp-1", name: "Layout work", createdAt: 1_772_000_000_000, lastUpdatedAt: 1_772_000_100_000, fullConversationHeadersOnly: [{ bubbleId: "bb1", type: 1 }, { bubbleId: "bb2", type: 2 }] });
    put("cursorDiskKV", "bubbleId:comp-1:bb1", { type: 1, text: "Why is the grid slow?", createdAt: "2026-02-25T05:34:00.000Z" });
    put("cursorDiskKV", "bubbleId:comp-1:bb2", { type: 2, text: "It re-measures every frame.", createdAt: "2026-02-25T05:34:10.000Z" });
    put("cursorDiskKV", "composerData:empty", { composerId: "empty", fullConversationHeadersOnly: [] });
    put("ItemTable", "workbench.panel.aichat.view.aichat.chatdata", { tabs: [{ tabId: "t9", chatTitle: "Old chat", bubbles: [{ type: "user", text: "q" }, { type: "ai", text: "a" }] }] });
    const first = readCursorDb(db, "proj", NO_TOOLS, () => false);
    expect(first.map((s) => s.nativeId).sort()).toEqual(["comp-1", "tab:t9"]);
    const comp = first.find((s) => s.nativeId === "comp-1");
    expect(comp?.title).toBe("Layout work");
    expect(comp?.messages.map((m) => m.text)).toEqual(["Why is the grid slow?", "It re-measures every frame."]);
    const again = readCursorDb(db, "proj", NO_TOOLS, (id, fp) => first.some((s) => s.nativeId === id && s.fingerprint === fp));
    expect(again).toEqual([]);
    db.close();
  });
});

describe("the pass: opt-in, live staging, sealing, resuming, exclusions", () => {
  async function codexHome(content = readFileSync(ROLLOUT, "utf8"), ageMs = 3_600_000): Promise<{ dir: string; file: string }> {
    const dir = await tmpDir();
    const sub = path.join(dir, "sessions", "2026", "03", "01");
    await fsp.mkdir(sub, { recursive: true });
    const file = path.join(sub, "rollout-2026-03-01T10-00-00-019a0000-aaaa-bbbb-cccc-000000000001.jsonl");
    await fsp.writeFile(file, content);
    const t = new Date(Date.now() - ageMs);
    await fsp.utimes(file, t, t);
    return { dir, file };
  }
  const codex = () => createImporters()["codex-cli"];

  it("reads nothing until the tool is turned on", async () => {
    const { dir } = await codexHome();
    const h = await harness((s) => void (s.sources.codexCli.dir = dir));
    const stats = await codex().run({ kind: "codex-cli" }, h.ctx);
    expect(stats.filesSeen).toBe(0);
    expect(await h.entries()).toHaveLength(0);
    expect(await codex().discover({ kind: "codex-cli" }, h.ctx)).toEqual([]);
  });

  it("imports an idle session into one segment, with tool output left out", async () => {
    const { dir } = await codexHome();
    const h = await harness((s) => {
      s.sources.codexCli.enabled = true;
      s.sources.codexCli.dir = dir;
    });
    const stats = await codex().run({ kind: "codex-cli" }, h.ctx);
    expect(stats.entriesAdded).toBe(2);
    expect(stats.conversationsTouched).toBe(1);
    const entries = await h.entries();
    expect(entries.map((e) => e.speaker)).toEqual(["you", "assistant"]);
    expect(entries.every((e) => e.source === "codex-cli")).toBe(true);
    expect(await h.text(entries[0] as never)).toBe("Add a retry to the upload helper.");
    expect(entries[0]?.project).toBe("sample-proj");
    const manifest = await loadSourceManifest(h.ctx.store);
    expect(manifest.sources["codex-cli"]).toMatchObject({ kind: "codex-cli", entries: 2, conversations: 1, status: "watching" });
    // A second pass over an unchanged file adds nothing and does not read it again.
    const again = await codex().run({ kind: "codex-cli" }, h.next());
    expect(again.entriesAdded).toBe(0);
    expect(again.filesRead).toBe(0);
  });

  it("with tool output on, adds it as hidden tool entries", async () => {
    const { dir } = await codexHome();
    const h = await harness((s) => {
      s.sources.codexCli.enabled = true;
      s.sources.codexCli.dir = dir;
      s.sources.codexCli.includeToolOutput = true;
    });
    await codex().run({ kind: "codex-cli" }, h.ctx);
    const entries = await h.entries();
    expect(entries.filter((e) => e.hiddenByDefault === "tool")).toHaveLength(2);
    expect(entries.filter((e) => e.speaker === "tool")).toHaveLength(2);
  });

  it("stages a live session at once, adds only new lines later, and seals when idle", async () => {
    const { dir, file } = await codexHome(readFileSync(ROLLOUT, "utf8"), 1000);
    const h = await harness((s) => {
      s.sources.codexCli.enabled = true;
      s.sources.codexCli.dir = dir;
    });
    const conv = conversationId("codex-cli", "019a0000-aaaa-bbbb-cccc-000000000001");
    const first = await codex().run({ kind: "codex-cli" }, h.ctx);
    expect(first.entriesAdded).toBe(2);
    expect(await h.entries()).toHaveLength(0);
    expect(await stagedMessages(h.ctx, conv)).toHaveLength(2);
    // The session continues.
    await fsp.appendFile(file, '{"timestamp":"2026-03-01T10:05:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"And add a test."}]}}\n');
    const second = await codex().run({ kind: "codex-cli" }, h.next());
    expect(second.entriesAdded).toBe(1);
    expect(await stagedMessages(h.ctx, conv)).toHaveLength(3);
    // Idle for the whole window (the clock moves on): the pass seals it into the record.
    await codex().run({ kind: "codex-cli" }, h.next(undefined, { now: () => Date.now() + 3_600_000 }));
    expect(await stagedMessages(h.ctx, conv)).toHaveLength(0);
    const entries = await h.entries();
    expect(entries.map((e) => e.idx)).toEqual([0, 1, 2]);
  });

  it("seals everything on request (the daily seal)", async () => {
    const { dir } = await codexHome(readFileSync(ROLLOUT, "utf8"), 1000);
    const h = await harness((s) => {
      s.sources.codexCli.enabled = true;
      s.sources.codexCli.dir = dir;
    });
    await codex().run({ kind: "codex-cli" }, h.ctx);
    expect(await h.entries()).toHaveLength(0);
    await codex().run({ kind: "codex-cli" }, h.next(undefined, { options: { seal: true } }));
    expect(await h.entries()).toHaveLength(2);
  });

  it("leaves out an excluded project and anything under an Off limits row", async () => {
    const { dir } = await codexHome();
    const h = await harness((s) => {
      s.sources.codexCli.enabled = true;
      s.sources.codexCli.dir = dir;
      s.sources.claudeCode.excludeProjects = ["Sample-Proj"];
    });
    const stats = await codex().run({ kind: "codex-cli" }, h.ctx);
    expect(await h.entries()).toHaveLength(0);
    expect(stats.skipped).toBe(1);
    const h2 = await harness((s) => {
      s.sources.codexCli.enabled = true;
      s.sources.codexCli.dir = dir;
      s.privacy.offLimits = [{ path: dir, reason: "test" }];
    });
    await codex().run({ kind: "codex-cli" }, h2.ctx);
    expect(await h2.entries()).toHaveLength(0);
  });

  it("reads a Gemini CLI chat and keeps going when one file is damaged", async () => {
    const root = await tmpDir();
    const chats = path.join(root, "tmp", "h1", "chats");
    await fsp.mkdir(chats, { recursive: true });
    await fsp.copyFile(path.join(FIX, "gemini-chat.json"), path.join(chats, "session-2026-03-02T09-00-abc.json"));
    await fsp.writeFile(path.join(chats, "session-2026-03-02T10-00-bad.json"), '{"sessionId":"x","messages":[');
    const old = new Date(Date.now() - 3_600_000);
    for (const n of await fsp.readdir(chats)) await fsp.utimes(path.join(chats, n), old, old);
    const h = await harness((s) => {
      s.sources.geminiCli.enabled = true;
      s.sources.geminiCli.dir = root;
    });
    const stats = await createImporters()["gemini-cli"].run({ kind: "gemini-cli" }, h.ctx);
    expect(stats.entriesAdded).toBe(3);
    expect((await h.entries()).map((e) => e.source)).toEqual(["gemini-cli", "gemini-cli", "gemini-cli"]);
  });

  it("says plainly when Cursor's store cannot be read, instead of guessing", async () => {
    const root = await tmpDir();
    await fsp.mkdir(path.join(root, "globalStorage"), { recursive: true });
    await fsp.writeFile(path.join(root, "globalStorage", "state.vscdb"), "not a database");
    const h = await harness((s) => {
      s.sources.cursor.enabled = true;
      s.sources.cursor.dir = root;
    });
    const stats = await createImporters().cursor.run({ kind: "cursor" }, h.ctx);
    expect(stats.entriesAdded).toBe(0);
    expect(stats.errors).toHaveLength(1);
    expect(await h.entries()).toHaveLength(0);
  });
});
