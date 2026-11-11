/**
 * Codex CLI engine (agents/codexCli.ts) against a fake CLI (tests/fixtures/fake-codex.mjs): no model is ever
 * called and nothing leaves this computer. Also the scheduler running a No model pass end to end.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCodexArgs, classifyCodexFailure, CodexCliEngine, codexEnv, codexForbiddenEntries, codexPrompt, parseCodexEvents, parseCodexHelp, codexMissingMandatory, CODEX_MANDATORY_FLAGS } from "../src/agents/codexCli";
import { RuleEngine } from "../src/agents/ruleLabels";
import { AgentScheduler } from "../src/agents/scheduler";
import { createCancelSource } from "../src/shared/cancel";
import { conversationId, entryId } from "../src/shared/ids";
import { nullLogger } from "../src/shared/log";
import { DEFAULT_SETTINGS, type CortexSettings } from "../src/shared/settings";
import type { ConversationRecord, EntryRecord, RunRecord } from "../src/shared/types";
import { openStoreContext } from "../src/store/layout";
import { createLedgerStore } from "../src/store/ledger";
import { writeSegment } from "../src/store/segments";

const FAKE = path.join(__dirname, "fixtures", "fake-codex.mjs");
const tmp = () => mkdtemp(path.join(os.tmpdir(), "cortex-codex-"));

async function engine(mode: string, over: { model?: string; env?: Record<string, string | undefined> } = {}) {
  const dir = await tmp();
  return new CodexCliEngine({ exe: process.execPath, preArgs: [FAKE, `--fake-mode=${mode}`], cwd: path.join(dir, "cwd"), tmpDir: path.join(dir, "tmp"), model: over.model ?? "", env: over.env ?? { ...process.env, OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "k", CODEX_HOME: "C:/codex-home", CLAUDE_EFFORT: "max" } }, nullLogger);
}
const req = (prompt = "RECORD-DATA") => ({ runId: "r_aaaaaaaaaaaaaaaa" as const, job: "label" as const, model: "codex", system: "sys", prompt, schema: { type: "object" as const }, timeoutMs: 20_000, effort: "low" as const, signal: createCancelSource().token.signal });

describe("agents/codexCli: invocation", () => {
  it("builds a read-only, no-approval, ephemeral call with the prompt on stdin", () => {
    const a = buildCodexArgs({ outFile: "C:/t/out.txt", cwd: "C:/t/cwd" });
    expect(a.slice(0, 3)).toEqual(["exec", "--sandbox", "read-only"]);
    expect(a[a.indexOf("--output-last-message") + 1]).toBe("C:/t/out.txt");
    expect(a[a.indexOf("--cd") + 1]).toBe("C:/t/cwd");
    expect(a).toContain("--ephemeral");
    expect(a[a.indexOf("-c") + 1]).toBe('approval_policy="never"');
    expect(a[a.length - 1]).toBe("-");
    expect(a).not.toContain("--model");
    expect(buildCodexArgs({ outFile: "o", cwd: "c", model: "gpt-5-codex" })).toContain("gpt-5-codex");
    expect(buildCodexArgs({ outFile: "o", cwd: "c", omit: new Set(["--ephemeral", "--json"]) })).not.toContain("--json");
    expect(() => buildCodexArgs({ outFile: "o", cwd: "c", model: "x; rm -rf /" })).toThrow();
  });
  it("passes only allow-listed environment variables, with CODEX_HOME but no API keys", () => {
    const env = codexEnv({ PATH: "p", USERPROFILE: "u", OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k", CODEX_HOME: "h", CLAUDE_EFFORT: "max", MCP_X: "1" });
    expect(Object.keys(env).sort()).toEqual(["CODEX_HOME", "PATH", "USERPROFILE"]);
  });
  it("tells the model to answer from the text alone and carries the schema in the prompt", () => {
    const p = codexPrompt({ system: "S", prompt: "DATA", schema: { type: "object" } });
    expect(p).toContain("do not run commands");
    expect(p).toContain('{"type":"object"}');
    expect(p.endsWith("DATA")).toBe(true);
  });
  it("reads the help as whole flags and lists the isolation flags an old CLI lacks", () => {
    const flags = parseCodexHelp("  --skip-git-repo-check\n  --output-last-message <F>\n  --cd <D>\n  --sandbox-mode x");
    expect(codexMissingMandatory(flags)).toEqual(["--sandbox"]);
    expect(CODEX_MANDATORY_FLAGS).toContain("--sandbox");
  });
  it("reads usage, the last message and errors from the JSON events", () => {
    const ev = parseCodexEvents(
      ['{"type":"item.completed","item":{"type":"agent_message","text":"{\\"a\\":1}"}}', "noise", '{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":10,"output_tokens":5}}', '{"type":"error","message":"boom"}'].join("\n"),
    );
    expect(ev).toMatchObject({ usage: { input: 50, cached: 10, output: 5 }, lastMessage: '{"a":1}', errors: ["boom"], completed: true });
  });
  it("classifies failures from the exit code, stderr and events only", () => {
    const none = { errors: [], completed: false };
    expect(classifyCodexFailure(1, "Not logged in. Please run `codex login`.", none, false).code).toBe("E_ENGINE_AUTH");
    const limit = classifyCodexFailure(1, "", { ...none, errors: ["You've hit your usage limit. Try again in 3 hours."] }, false);
    expect(limit.code).toBe("E_ENGINE_LIMIT");
    expect(limit.resumeAt).toBeTruthy();
    expect(classifyCodexFailure(1, "error sending request: ECONNRESET", none, false)).toMatchObject({ code: "E_ENGINE_FAILED", state: "offline", retryable: true });
    expect(classifyCodexFailure(null, "", none, true).code).toBe("E_TIMEOUT");
    expect(classifyCodexFailure(2, "error: unexpected argument '--sandbox' found", none, false)).toMatchObject({ state: "unsafe", flag: "--sandbox" });
    expect(classifyCodexFailure(2, "error: unexpected argument '--ephemeral' found", none, false)).toMatchObject({ flag: "--ephemeral", retryable: true });
  });
});

describe("agents/codexCli: engine against a fake CLI", () => {
  it("probes for free and accepts a CLI that lists the isolation flags", async () => {
    const p = await (await engine("ok")).probe();
    expect(p).toMatchObject({ ok: true, version: "codex-cli 0.99.0", missingMandatory: [] });
    const old = await (await engine("old")).probe();
    expect(old.ok).toBe(false);
    expect(old.missingMandatory).toEqual(["--sandbox"]);
  }, 30_000);

  it("sends the prompt on stdin (never argv), read-only, with a clean environment", async () => {
    const e = await engine("echo", { model: "gpt-5-codex" });
    const r = await e.run(req());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const seen = r.output as { args: string[]; stdinHasPrompt: boolean; argvHasPrompt: boolean; env: string[] };
    expect(seen.stdinHasPrompt).toBe(true);
    expect(seen.argvHasPrompt).toBe(false);
    expect(seen.args[seen.args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(seen.args[seen.args.indexOf("--model") + 1]).toBe("gpt-5-codex");
    expect(seen.env).toContain("CODEX_HOME");
    expect(seen.env.filter((k) => /OPENAI|ANTHROPIC|CLAUDE/i.test(k))).toEqual([]);
    expect(r.modelUsed).toBe("gpt-5-codex");
  }, 30_000);

  it("returns the JSON answer with usage from the events (cached input split out)", async () => {
    const r = await (await engine("ok")).run(req());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).toEqual({ ok: true });
      expect(r.usage).toMatchObject({ inputTokens: 100, cacheReadTokens: 20, outputTokens: 15, costUsd: 0, estimated: false });
    }
  }, 30_000);

  it("falls back to the last agent message when the output file is missing, and estimates usage when none is reported", async () => {
    const r = await (await engine("stdout-only")).run(req());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toEqual({ ok: true });
  }, 30_000);

  it("maps a sign-in error, a usage limit and a dropped connection", async () => {
    const a = await (await engine("auth")).run(req());
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error).toMatchObject({ code: "E_ENGINE_AUTH", state: "auth" });
    const l = await (await engine("limit")).run(req());
    if (!l.ok) expect(l.error).toMatchObject({ code: "E_ENGINE_LIMIT", state: "limit" });
    const n = await (await engine("network")).run(req());
    if (!n.ok) expect(n.error).toMatchObject({ code: "E_ENGINE_FAILED", retryable: true });
  }, 40_000);

  it("retries once without an optional flag the CLI rejects", async () => {
    const e = await engine("flag");
    const r = await e.run(req());
    expect(r.ok).toBe(true);
    expect(e.disabledFlags()).toEqual(["--ephemeral"]);
  }, 30_000);

  it("treats a reply that is not a JSON object as a failed call, never as an answer", async () => {
    const r = await (await engine("prose")).run(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: "E_VALIDATION", reason: "no-json" });
  }, 30_000);

  it("refuses to run in a folder that holds files Codex would load", async () => {
    const dir = await tmp();
    const cwd = path.join(dir, "cwd");
    await mkdir(cwd, { recursive: true });
    await writeFile(path.join(cwd, "AGENTS.md"), "be chatty");
    expect(await codexForbiddenEntries(cwd)).toEqual(["AGENTS.md"]);
    const e = new CodexCliEngine({ exe: process.execPath, preArgs: [FAKE], cwd, tmpDir: path.join(dir, "tmp"), model: "" }, nullLogger);
    const r = await e.run(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ state: "unsafe", reason: "cwd-not-empty" });
  }, 30_000);

  it("reports a missing program without sending anything", async () => {
    const e = new CodexCliEngine({ exe: path.join(os.tmpdir(), "no-such-codex.exe"), cwd: path.join(await tmp(), "c"), tmpDir: path.join(await tmp(), "t"), model: "" }, nullLogger);
    const r = await e.run(req());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("E_ENGINE_MISSING");
  }, 30_000);
});

describe("agents/scheduler with No model", () => {
  async function setup() {
    const vault = await tmp();
    const store = await openStoreContext({ vaultRoot: vault, cacheDir: await tmp(), owner: "test", log: nullLogger });
    const ledger = createLedgerStore(store);
    const settings: CortexSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    settings.general.firstRunDone = true;
    settings.agents.engine = "none";
    settings.agents.onlyWhenIdle = false;
    const convId = conversationId("claude-code", "c1");
    const LINE = "How do I plan the roadmap for the importer milestones?";
    const seg = await writeSegment(store, {
      source: "claude-code",
      monthKey: "2026-11",
      conv: convId,
      lines: [{ v: 1, id: entryId("claude-code", "e1"), nid: "n1", conv: convId, i: 0, sp: "you", text: LINE, sha: createHash("sha256").update(LINE).digest("hex") } as never],
    });
    const when = new Date(Date.now() - 3_600_000).toISOString();
    const conv = { v: 1, id: convId, seq: 1, source: "claude-code", nativeId: "c1", title: "Importer roadmap", titledBy: "native", startedAt: when, endedAt: when, entryCount: 1, parts: [], space: "none", folder: [], project: "importer", updatedAt: when } as unknown as ConversationRecord;
    const entry = { v: 1, id: entryId("claude-code", "e1"), kind: "message", source: "claude-code", sourceRef: { path: "x", sha256: "0" }, conv: convId, idx: 0, speaker: "you", text: { store: "segment", seg: seg.path, line: 0 }, textSha256: createHash("sha256").update(LINE).digest("hex"), chars: 54, words: 10, dates: [], existedBy: when, addedAt: when, space: "none", folder: [] } as unknown as EntryRecord;
    await ledger.append("conversations", [conv]);
    await ledger.append("entries", [entry]);
    const events: { kind: string }[] = [];
    const scheduler = new AgentScheduler({ store, ledger, settings, engine: new RuleEngine(), liveCheck: null, token: createCancelSource().token, log: nullLogger, emit: (e) => void events.push(e), now: () => Date.now(), mode: "cli", origin: "skill", settingsSource: "plugin", pluginVersion: "t" });
    return { scheduler, ledger, convId, events };
  }

  it("runs the label job with the rules, plans no summaries, and records the run as 'rule'", async () => {
    const { scheduler, ledger, convId } = await setup();
    const res = await scheduler.run({ reason: "manual" });
    expect(res.runs.map((r) => r.job)).toEqual(["label"]);
    expect(res.runs[0]).toMatchObject({ status: "finished", tokens: 0, costUsd: 0 });
    const runs: RunRecord[] = [];
    for await (const r of ledger.readAll("runs")) runs.push(r as RunRecord);
    expect(runs.every((r) => r.engine === "rule" && r.paidBy === "none" && r.where === "this computer")).toBe(true);
    const labels: { target: string; field: string; value: unknown }[] = [];
    for await (const l of ledger.readAll("labels")) labels.push(l as never);
    expect(labels.find((l) => l.field === "project")).toMatchObject({ target: convId, value: "importer" });
    expect(labels.find((l) => l.field === "work")).toMatchObject({ value: "plan" });
    // A second pass finds nothing left to do.
    expect((await scheduler.run({ reason: "manual" })).runs).toEqual([]);
  }, 30_000);

  it("refuses Ask: the rules can file the record but cannot answer", async () => {
    const { scheduler } = await setup();
    await expect(scheduler.ask({ question: "what did I decide?" } as never)).rejects.toMatchObject({ code: "E_ENGINE_MISSING" });
  }, 30_000);
});
