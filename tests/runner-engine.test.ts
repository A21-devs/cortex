/**
 * Runner and agent engine (owner E5): the isolated headless invocation (ENV-INHERIT, SAFE-05), end-to-end calls
 * against a fake CLI that never calls a model, failure classification incl. usage limits (CLI-FAILURE-CLASSIFY),
 * a probe that refuses CLIs missing a safety flag, privacy (withheld replies, redaction, SAFE-10/11), argv
 * parsing with bounded skill runs (SKILL-LONG-RUNS), frame dispatch with a build id, and the plugin clients.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyUsage, canStart, emptyBudget, estimateTokens, loadBudget, recordPlan, rollDay } from "../src/agents/budget";
import { buildClaudeArgs, classifyCliFailure, claudeEnv, ClaudeCliEngine, ENV_ALLOWLIST, extractJsonPayload, MANDATORY_FLAGS, missingMandatory, parseHelpFlags } from "../src/agents/claudeCli";
import { zeroUsage } from "../src/agents/engine";
import { policyFor, prepareForCloud, redact, WITHHELD_REPLY } from "../src/agents/privacy";
import { enterEngineState, GuardedEngine, loadEngineState } from "../src/agents/scheduler";
import { openStoreContext } from "../src/store/layout";
import { createAgentsClock, type ClockSchedule } from "../src/plugin/agentsClock";
import { createRunnerClient } from "../src/plugin/runnerClient";
import { parseArgv } from "../src/runner/cli";
import { createHandlers } from "../src/runner/commands";
import { RunnerCore, type CommandHandlers, type RunnerHost } from "../src/runner/host";
import { findVaultRoot } from "../src/runner/settingsLoader";
import { createCancelSource } from "../src/shared/cancel";
import { nullLogger } from "../src/shared/log";
import type { FromRunner, RunnerContext } from "../src/shared/protocol/runner";
import { scanSecrets } from "../src/shared/secrets";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { EventBus } from "../src/state/events";

const FAKE = path.join(__dirname, "fixtures", "fake-claude.mjs");

/** A vault folder with .obsidian and a cache folder outside it, named the way the runner requires. */
async function tempVault(): Promise<{ vault: string; cacheDir: string; ctx: RunnerContext }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cortex-e5-"));
  const vault = path.join(root, "vault");
  await mkdir(path.join(vault, ".obsidian"), { recursive: true });
  const vaultKey = "abcdefghijklmnop";
  const cacheDir = path.join(root, "cortex", vaultKey);
  await mkdir(cacheDir, { recursive: true });
  return { vault, cacheDir, ctx: { vaultRoot: vault, vaultKey, cacheDir, settings: DEFAULT_SETTINGS, pluginVersion: "t", settingsSource: "plugin" } };
}

describe("agents/claudeCli: invocation (ENV-INHERIT, SAFE-05)", () => {
  it("builds a tool-less, isolated argument vector with an explicit effort", () => {
    const a = buildClaudeArgs({ model: "haiku", effort: "low", systemPromptFile: "C:/t/sys.txt", schemaJson: '{"type":"object"}', maxUsd: 1 });
    expect(a.slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
    for (const f of MANDATORY_FLAGS) expect(a, f).toContain(f);
    expect(a[a.indexOf("--tools") + 1]).toBe("");
    expect(a[a.indexOf("--effort") + 1]).toBe("low");
    expect(a[a.indexOf("--max-budget-usd") + 1]).toBe("1.0000");
    expect(() => buildClaudeArgs({ model: "haiku; rm -rf /", effort: "low" })).toThrow();
    expect(() => buildClaudeArgs({ model: "haiku", effort: "low", maxUsd: 0.001 })).toThrow();
  });
  it("passes only allow-listed environment variables", () => {
    const env = claudeEnv({ PATH: "p", USERPROFILE: "u", CLAUDE_EFFORT: "max", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", MCP_SERVER: "x", ANTHROPIC_API_KEY: "k", OTEL_EXPORTER: "y" });
    expect(Object.keys(env).sort()).toEqual(["DISABLE_AUTOUPDATER", "PATH", "USERPROFILE"].sort());
    expect(claudeEnv({ ANTHROPIC_API_KEY: "k" }, { allowAnthropic: true }).ANTHROPIC_API_KEY).toBe("k");
    expect(ENV_ALLOWLIST).not.toContain("CLAUDE_EFFORT");
  });
  it("reads mandatory flags as whole tokens and lists what an old CLI lacks", () => {
    const help = "  --restricted-mode\n  --tools <t>\n  --permission-mode <m>";
    expect(parseHelpFlags(help)["--restricted"]).toBe(false);
    expect(missingMandatory(parseHelpFlags(help))).toContain("--restricted");
  });
  it("classifies failures from structured fields, including the usage limit with its reset time", () => {
    expect(classifyCliFailure(1, "Invalid API key · Please run /login", null, false).code).toBe("E_ENGINE_AUTH");
    const limit = classifyCliFailure(1, "Claude usage limit reached. Your limit will reset at 2026-11-09T15:00:00Z", null, false);
    expect(limit.code).toBe("E_ENGINE_LIMIT");
    expect(classifyCliFailure(null, "", null, true).code).toBe("E_TIMEOUT");
    expect(classifyCliFailure(1, "", { type: "result", subtype: "error_max_budget_usd", is_error: true } as never, false).code).toBe("E_BUDGET_CAPPED");
    expect(extractJsonPayload({ type: "result", result: 'noise ```json\n{"a":1}\n``` tail' } as never)).toEqual({ a: 1 });
  });
});

describe("agents/claudeCli: engine against a fake CLI (no model is ever called)", () => {
  async function engine(mode: string) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cortex-cli-"));
    return new ClaudeCliEngine({ exe: process.execPath, preArgs: [FAKE, `--fake-mode=${mode}`], cwd: dir, tmpDir: path.join(dir, "tmp"), useJsonSchemaFlag: true, env: { ...process.env, CLAUDE_EFFORT: "max", CLAUDECODE: "1", MCP_TOKEN: "x" } }, nullLogger);
  }
  const req = (prompt: string) => ({ runId: "r_aaaaaaaaaaaaaaaa" as const, job: "label" as const, model: "haiku", system: "sys", prompt, schema: { type: "object" as const }, timeoutMs: 20_000, effort: "low" as const, signal: createCancelSource().token.signal });

  it("sends the prompt on stdin, isolated, with no session variables leaking", async () => {
    const r = await (await engine("ok")).run(req("x".repeat(5000)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output).toMatchObject({ model: "haiku", stdinChars: 5000, toolsDisabled: true, restricted: true, effort: "low", sawSchema: true, leaked: [] });
  }, 30_000);
  it("maps sign-in errors and probes without sending a prompt, refusing an old CLI", async () => {
    const a = await (await engine("auth")).run(req("p"));
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error.code).toBe("E_ENGINE_AUTH");
    const p = await (await engine("ok")).probe();
    expect(p.ok).toBe(true);
    expect(p.version).toBe("2.1.319 (Claude Code)");
    const old = await (await engine("oldhelp")).probe();
    expect(old.missingMandatory?.length ?? 0).toBeGreaterThan(0);
  }, 30_000);
  it("accepts flags the CLI hides from --help (checked with empty input) and refuses ones it rejects", async () => {
    const hidden = await (await engine("hidden")).probe();
    expect(hidden.flags["--max-turns"]).toBe(true);
    expect(hidden.ok).toBe(true);
    const nomax = await (await engine("nomax")).probe();
    expect(nomax.flags["--max-turns"]).toBe(false);
    expect(nomax.ok).toBe(false);
  }, 30_000);
});

describe("agents/budget", () => {
  it("counts tokens per local day without limiting them, and rolls over", () => {
    const s0 = emptyBudget("2026-11-09");
    const s1 = applyUsage(s0, { ...zeroUsage(false), inputTokens: 600_000, outputTokens: 100_000 }, "2026-11-09");
    expect(s1.today.tokens).toBe(700_000);
    const caps = { fiveHour: 70, weekly: 70 };
    expect(canStart(s1, caps, "2026-11-09")).toEqual({ ok: true });
    expect(canStart(applyUsage(s1, { ...zeroUsage(false), inputTokens: 90_000_000 }, "2026-11-09"), caps, "2026-11-09")).toEqual({ ok: true });
    expect(canStart(s1, caps, "2026-11-10")).toEqual({ ok: true });
    expect(rollDay(s1, "2026-11-10").history[0]?.tokens).toBe(700_000);
    expect(estimateTokens(3500, 0, 100)).toBe(1100);
  });
});

describe("agents/privacy (SAFE-10, §12.10)", () => {
  it("withholds assistant replies from ChatGPT and Gemini and redacts secrets everywhere", () => {
    const p = policyFor("chatgpt", DEFAULT_SETTINGS);
    expect(p.withholdAssistant).toBe(true);
    expect(policyFor("claude-code", DEFAULT_SETTINGS).withholdAssistant).toBe(false);
    const out = prepareForCloud([{ id: "e_aaaaaaaaaaaaaaaa", speaker: "assistant", text: "Here is the answer" }, { id: "e_bbbbbbbbbbbbbbbb", speaker: "you", text: "my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH" }] as never, p);
    const items = out.items as { text: string }[];
    expect(out.withheld).toBe(1);
    expect(items[0]?.text).toBe(WITHHELD_REPLY);
    expect(items[1]?.text).not.toContain("sk-ant-api03");
    expect(WITHHELD_REPLY).not.toMatch(/this computer/);
    expect(redact("mail me at a.b@example.com", p).text).not.toContain("a.b@example.com");
    expect(scanSecrets("token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB").count).toBeGreaterThan(0);
  });
});

describe("runner/cli + host + settingsLoader + commands", () => {
  it("parses bounded skill invocations", () => {
    expect(parseArgv(["import", "--source", "claude-code", "--source", "chatgpt=C:/x.zip"]).command).toMatchObject({ cmd: "import", args: { sources: [{ kind: "claude-code" }, { kind: "chatgpt", file: "C:/x.zip" }] } });
    const run = parseArgv(["agents", "run", "--job", "label", "--max-jobs", "3", "--max-seconds", "60"]).command;
    expect(run).toMatchObject({ cmd: "agents.run", args: { jobs: ["label"], maxJobs: 3, maxSeconds: 60 } });
    expect(parseArgv(["serve"]).mode).toBe("serve");
    expect(parseArgv(["nope"]).mode).toBe("help");
  });
  it("dispatches frames with a build id, answers pings and reports handler errors from the catalogue", async () => {
    const env = await tempVault();
    const frames: FromRunner[] = [];
    const host: RunnerHost = { mode: "inline", emit: (f) => frames.push(f), log: nullLogger, yield: async () => undefined };
    const handlers = { ...createHandlers(), "agents.status": async () => ({ ok: true }) } as unknown as CommandHandlers;
    const core = new RunnerCore(host, handlers);
    core.hello();
    core.handle({ t: "ping", n: 7 });
    core.handle({ t: "req", id: "q1", ctx: env.ctx, command: { cmd: "agents.status", args: {} } });
    core.handle({ t: "req", id: "q2", ctx: env.ctx, command: { cmd: "nope", args: {} } as never });
    await new Promise((r) => setTimeout(r, 50));
    expect(frames.map((f) => f.t).sort()).toEqual(["error", "hello", "pong", "result"]);
    expect(frames[0]).toMatchObject({ t: "hello" });
    expect(typeof (frames[0] as { build?: string }).build).toBe("string");
    expect(frames.find((f) => f.t === "error")).toMatchObject({ t: "error", id: "q2" });
    expect(frames.find((f) => f.t === "result")).toMatchObject({ t: "result", id: "q1" });
  });
  it("refuses agent passes before the first-run step and keeps the queue and cache commands working", async () => {
    const env = await tempVault();
    const h = createHandlers();
    const rc = { id: "x", ctx: env.ctx, token: createCancelSource().token, host: { mode: "child", emit: () => undefined, log: nullLogger, yield: async () => undefined } as RunnerHost, progress: () => undefined, event: () => undefined };
    await expect(h["agents.run"]({ reason: "manual" }, rc)).rejects.toMatchObject({ code: "E_PAUSED" });
    const queued = await h["agents.enqueue"]({ jobs: ["gist"], targets: ["c_aaaaaaaaaaaaaaaa"], reason: "manual" }, rc);
    expect(queued.queued).toHaveLength(1);
    await expect(h["agents.enqueue"]({ jobs: ["gist"], targets: ["not an id"], reason: "manual" }, rc)).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    const status = await h["agents.status"]({}, rc);
    expect(status).toMatchObject({ capped: false, tokensToday: 0, usdToday: 0 });
    expect(status.plan.fiveHour).toMatchObject({ pct: null, capPct: 70, atCap: false });
    expect(status.plan.weekly).toMatchObject({ pct: null, capPct: 70 });
    expect(status.pending.gist).toBe(1);
    expect(await h["agents.dequeue"]({ ids: queued.queued }, rc)).toEqual({ removed: 1 });
    // cache.clear removes rebuildable caches by name and keeps state (ordinals, cursors, queue)
    await fsp.writeFile(path.join(env.cacheDir, "record.cxi"), "x");
    await fsp.writeFile(path.join(env.cacheDir, "ordinals.cxo"), "keep");
    await fsp.mkdir(path.join(env.cacheDir, "search"), { recursive: true });
    await fsp.writeFile(path.join(env.cacheDir, "search", "search.cxs"), "x");
    const cleared = await h["cache.clear"]({}, rc);
    expect(cleared.files).toBe(2);
    await expect(fsp.access(path.join(env.cacheDir, "ordinals.cxo"))).resolves.toBeUndefined();
    await expect(fsp.access(path.join(env.cacheDir, "record.cxi"))).rejects.toBeTruthy();
  });
  it("finds the vault root by walking up to .obsidian", async () => {
    const v = await mkdtemp(path.join(os.tmpdir(), "cortex-vault-"));
    await mkdir(path.join(v, ".obsidian", "plugins", "cortex"), { recursive: true });
    expect(findVaultRoot(path.join(v, ".obsidian", "plugins", "cortex"))).toBe(v);
  });
});

describe("agents/claudeCli: live isolation check, timeout and the guarded engine", () => {
  async function engine(mode: string, extra: { cwd?: string } = {}) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cortex-live-"));
    const cwd = extra.cwd ?? path.join(dir, "agent");
    await mkdir(cwd, { recursive: true });
    return new ClaudeCliEngine({ exe: process.execPath, preArgs: [FAKE, `--fake-mode=${mode}`], cwd, tmpDir: path.join(dir, "tmp"), useJsonSchemaFlag: true, projectsDir: path.join(dir, "projects") }, nullLogger);
  }
  const sig = () => createCancelSource().token.signal;
  const request = (runId: string, over: { timeoutMs?: number; prompt?: string } = {}) => ({
    runId: runId as never,
    job: "label" as const,
    model: "haiku",
    system: "s",
    prompt: over.prompt ?? "p",
    schema: { type: "object" as const },
    timeoutMs: over.timeoutMs ?? 20_000,
    effort: "low" as const,
    signal: sig(),
  });

  it("passes when the init event lists no tools and no MCP servers, and refuses a leaky CLI", async () => {
    const ok = await (await engine("ok")).liveCheck({ model: "haiku", timeoutMs: 20_000, signal: sig() });
    expect(ok).toMatchObject({ ok: true, sent: true });
    const leaky = await (await engine("leaky")).liveCheck({ model: "haiku", timeoutMs: 20_000, signal: sig() });
    expect(leaky).toMatchObject({ ok: false, reason: "tools" });
  }, 40_000);
  it("will not run in a folder holding files Claude Code would load", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cortex-dirty-"));
    await writeFile(path.join(dir, "CLAUDE.md"), "x");
    const r = await (await engine("ok", { cwd: dir })).run(request("r_aaaaaaaaaaaaaaaa"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ state: "unsafe" });
  });
  it("kills a call that runs past its timeout", async () => {
    const t0 = Date.now();
    const r = await (await engine("slow")).run(request("r_aaaaaaaaaaaaaaaa", { timeoutMs: 800 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("E_TIMEOUT");
    expect(Date.now() - t0).toBeLessThan(8_000);
  }, 20_000);
  it("reserves and settles the budget around each call, refuses at a plan cap and when a read was not logged", async () => {
    const env = await tempVault();
    const store = await openStoreContext({ vaultRoot: env.vault, cacheDir: env.cacheDir, owner: "test", log: nullLogger });
    const settings = { ...DEFAULT_SETTINGS };
    const inner = await engine("ok");
    const states: string[] = [];
    const logged = new Set<string>(["r_aaaaaaaaaaaaaaaa"]);
    const guard = new GuardedEngine({ inner, store, settings, privacyRev: 0, token: createCancelSource().token, now: () => Date.now(), log: nullLogger, emit: () => undefined, readLogged: (id) => logged.has(id), onEngineState: async (s) => void states.push(s) });
    const first = await guard.run(request("r_aaaaaaaaaaaaaaaa", { prompt: "p".repeat(400) }));
    expect(first.ok).toBe(true);
    expect((await loadBudget(store)).today.tokens).toBe(200); // 120 in + 30 out + 40 cache read + 10 cache write
    const unlogged = await guard.run(request("r_bbbbbbbbbbbbbbbb"));
    expect(unlogged.ok).toBe(false);
    if (!unlogged.ok) expect(unlogged.error.reason).toBe("read-not-logged");
    logged.add("r_cccccccccccccccc");
    const big = await guard.run(request("r_cccccccccccccccc", { prompt: "p".repeat(4_000_000) }));
    expect(big.ok).toBe(true); // no daily token limit: a large call is not refused for its size
    // The plan's 5-hour window at 71% of its limit, with the cap at 70%: the next call is refused and says when it resets.
    const resetsAt = Date.now() + 3_600_000;
    await recordPlan(store, { fiveHour: { pct: 71, resetsAt, seenAt: Date.now() } });
    logged.add("r_dddddddddddddddd");
    const over = await guard.run(request("r_dddddddddddddddd"));
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.error).toMatchObject({ code: "E_BUDGET_CAPPED", reason: "plan-5h", resumeAt: new Date(resetsAt).toISOString() });
      expect(over.started).toBe(false);
    }
    expect(states).toContain("ok");
  }, 40_000);
  it("stops everything after a usage limit and records the engine state with its reset time", async () => {
    const env = await tempVault();
    const store = await openStoreContext({ vaultRoot: env.vault, cacheDir: env.cacheDir, owner: "test", log: nullLogger });
    const inner = await engine("limit");
    const sink = { store, emit: () => undefined, now: () => Date.now() };
    const guard = new GuardedEngine({ inner, store, settings: DEFAULT_SETTINGS, privacyRev: 0, token: createCancelSource().token, now: () => Date.now(), log: nullLogger, emit: () => undefined, readLogged: () => true, onEngineState: async (s, e) => void (await enterEngineState(sink, s, e)) });
    const a = await guard.run(request("r_aaaaaaaaaaaaaaaa"));
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error.code).toBe("E_ENGINE_LIMIT");
    const again = await guard.run(request("r_aaaaaaaaaaaaaaaa"));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("E_ENGINE_LIMIT");
    const es = await loadEngineState(env.cacheDir);
    expect(es.state).toBe("limit");
    expect(typeof es.resumeAt).toBe("string");
  }, 40_000);
});

describe("plugin/runnerClient", () => {
  const RUNNER_SRC = [
    'const readline = require("readline");',
    'const hello = (mode) => ({ t: "hello", protocol: 2, runner: "fake", build: "test", node: process.version, pid: process.pid, mode });',
    "function handle(f, out) {",
    '  if (f.t === "ping") out({ t: "pong", n: f.n });',
    '  else if (f.t === "cancel") out({ t: "error", id: f.id, error: { code: "E_CANCELLED", message: "cancelled", retryable: false } });',
    '  else if (f.t === "req") {',
    "    const c = f.command.cmd;",
    '    if (c === "agents.status") {',
    '      out({ t: "progress", id: f.id, phase: "p", done: 1 });',
    '      out({ t: "event", id: f.id, event: { kind: "review-cards", count: 2 } });',
    '      out({ t: "result", id: f.id, ok: true, cmd: c, data: { key: f.ctx.vaultKey } });',
    '    } else if (c === "cache.clear") out({ t: "error", id: f.id, error: { code: "E_LOCKED", message: "busy", retryable: true } });',
    "  }",
    "}",
    'exports.createInlineRunner = (on) => { on(hello("inline")); return { send: (f) => handle(f, on), dispose() {} }; };',
    "if (require.main === module) {",
    '  const out = (f) => process.stdout.write(JSON.stringify(f) + "\\n");',
    '  out(hello("child"));',
    "  const rl = readline.createInterface({ input: process.stdin });",
    '  rl.on("line", (l) => { const f = JSON.parse(l); if (f.t === "shutdown") process.exit(0); handle(f, out); });',
    '  rl.on("close", () => process.exit(0));',
    "}",
  ].join("\n");

  async function client(mode: "child" | "inline") {
    const env = await tempVault();
    const pluginDir = path.join(path.dirname(env.vault), "plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(path.join(pluginDir, "fake-runner.js"), RUNNER_SRC);
    const bus = new EventBus();
    const frames: FromRunner[] = [];
    bus.on("runner:frame", (f) => void frames.push(f));
    const settings = { ...DEFAULT_SETTINGS, advanced: { ...DEFAULT_SETTINGS.advanced, runnerMode: mode } };
    const c = createRunnerClient({ pluginDir, runnerFileName: "fake-runner.js", vaultRoot: env.vault, vaultKey: "abcdefghijklmnop", cacheDir: env.cacheDir, pluginVersion: "t", getSettings: () => settings, bus, log: nullLogger });
    return { c, frames };
  }

  it("starts a system Node child, correlates replies, forwards progress and events, and stops cleanly", async () => {
    const { c, frames } = await client("child");
    expect(c.mode).toBe("stopped");
    expect(await c.start()).toBe("child");
    const progress: string[] = [];
    const events: string[] = [];
    const res = await c.request({ cmd: "agents.status", args: {} }, { onProgress: (p) => progress.push(p.phase), onEvent: (e) => events.push(e.kind) });
    expect(res).toEqual({ key: "abcdefghijklmnop" });
    expect(progress).toEqual(["p"]);
    expect(events).toEqual(["review-cards"]);
    await expect(c.request({ cmd: "cache.clear", args: {} })).rejects.toMatchObject({ code: "E_LOCKED", retryable: true });
    expect(frames.some((f) => f.t === "hello")).toBe(true);
    await c.stop();
    expect(c.mode).toBe("stopped");
  }, 30_000);
  it("cancels a request on abort and reports E_CANCELLED", async () => {
    const { c } = await client("child");
    await c.start();
    const ac = new AbortController();
    const p = c.request({ cmd: "doctor", args: {} }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toMatchObject({ code: "E_CANCELLED" });
    await c.stop();
  }, 30_000);
  it("runs the runner on the UI thread when asked for inline", async () => {
    const { c } = await client("inline");
    expect(await c.start()).toBe("inline");
    expect(await c.request({ cmd: "agents.status", args: {} })).toEqual({ key: "abcdefghijklmnop" });
    await c.stop();
  }, 30_000);
  it("reports the runner as unavailable instead of throwing at start when the bundle is missing", async () => {
    const env = await tempVault();
    const settings = { ...DEFAULT_SETTINGS, advanced: { ...DEFAULT_SETTINGS.advanced, runnerMode: "inline" as const } };
    const c = createRunnerClient({ pluginDir: path.join(env.vault, "nope"), vaultRoot: env.vault, vaultKey: "abcdefghijklmnop", cacheDir: env.cacheDir, pluginVersion: "t", getSettings: () => settings, bus: new EventBus(), log: nullLogger });
    expect(await c.start()).toBe("unavailable");
    await expect(c.request({ cmd: "agents.status", args: {} })).rejects.toMatchObject({ code: "E_NODE_MISSING" });
  });
});

describe("plugin/agentsClock", () => {
  function setup(over: { blocked?: boolean; idle?: number; schedule?: ClockSchedule } = {}) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 9, 14, 0, 0));
    const calls: string[] = [];
    let changed: () => void = () => undefined;
    let closed = 0;
    const state = { blocked: over.blocked ?? false, idle: over.idle ?? 0 };
    const clock = createAgentsClock({
      now: () => Date.now(),
      isBlocked: () => state.blocked,
      idleMs: () => state.idle,
      runAgents: async (r) => void calls.push(`agents:${r}`),
      runImport: async (r) => void calls.push(`import:${r}`),
      watchTranscripts: (on) => {
        changed = on;
        return () => void closed++;
      },
      ...(over.schedule ? { schedule: () => over.schedule as ClockSchedule } : {}),
    });
    return { clock, calls, state, change: () => changed(), closed: () => closed };
  }
  afterEach(() => vi.useRealTimers());

  it("imports at startup, debounces transcript changes, and closes its watcher on stop", async () => {
    const t = setup();
    t.clock.start();
    expect(t.clock.running).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(t.calls).toEqual(["import:startup"]);
    t.change();
    t.change();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.calls).not.toContain("import:watch");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(t.calls.filter((c) => c === "import:watch")).toHaveLength(1);
    t.clock.stop();
    expect(t.clock.running).toBe(false);
    expect(t.closed()).toBe(1);
  });
  it("imports a note changed outside wiki/ once the vault is quiet for a few seconds, and closes that watcher on stop", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let changed: () => void = () => undefined;
    let closed = 0;
    const clock = createAgentsClock({
      now: () => Date.now(),
      isBlocked: () => false,
      idleMs: () => 0,
      runAgents: async (r) => void calls.push(`agents:${r}`),
      runImport: async (r) => void calls.push(`import:${r}`),
      watchTranscripts: () => () => undefined,
      watchVaultNotes: (on) => {
        changed = on;
        return () => void closed++;
      },
    });
    clock.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(["import:startup"]);
    changed();
    changed();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls).toEqual(["import:startup"]);
    // A later save (typing) starts the wait again: one import once the vault is quiet.
    changed();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(calls).toEqual(["import:startup"]);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(calls).toEqual(["import:startup", "import:vault"]);
    clock.stop();
    expect(closed).toBe(1);
    changed();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual(["import:startup", "import:vault"]);
  });
  it("runs another pass at the next tick while passes get work done, and rests once a pass finds nothing", async () => {
    vi.useFakeTimers();
    const passes: number[] = [];
    let left = 2;
    const clock = createAgentsClock({
      now: () => Date.now(),
      isBlocked: () => false,
      idleMs: () => 0,
      runAgents: async () => {
        passes.push(Date.now());
        // Two passes find work (a backlog bigger than one pass), the third finds nothing.
        return left-- > 0;
      },
      runImport: async () => undefined,
      watchTranscripts: () => () => undefined,
      schedule: () => ({ onlyWhenIdle: false, idleStartSec: 60, nightly: { enabled: false, hour: 3 }, deferWhileBusyMs: 0 }),
    });
    clock.start();
    // The startup import marks the record dirty: the first pass comes at the first tick.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(passes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(passes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(passes).toHaveLength(3);
    // Nothing left: the clock rests until the 15-minute repeat.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(passes).toHaveLength(3);
    clock.stop();
  });
  it("a vault change that comes while another import runs is imported once that one ends", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let release: () => void = () => undefined;
    let changed: () => void = () => undefined;
    const clock = createAgentsClock({
      now: () => Date.now(),
      isBlocked: () => false,
      idleMs: () => 0,
      runAgents: async () => undefined,
      runImport: (r) => {
        calls.push(`import:${r}`);
        return r === "startup" ? new Promise<void>((res) => (release = res)) : Promise.resolve();
      },
      watchTranscripts: () => () => undefined,
      watchVaultNotes: (on) => {
        changed = on;
        return () => undefined;
      },
      vaultDebounceMs: 100,
    });
    clock.start();
    changed();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toEqual(["import:startup"]);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(["import:startup", "import:vault"]);
    clock.stop();
  });
  it("runs an idle pass only after the idle time, never while blocked, and Run now bypasses idle only", async () => {
    const t = setup({ idle: 5_000, blocked: true });
    t.clock.start();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(t.calls.some((c) => c.startsWith("agents:"))).toBe(false);
    t.clock.poke("manual");
    await vi.advanceTimersByTimeAsync(10);
    expect(t.calls.some((c) => c.startsWith("agents:"))).toBe(false); // blocked: even Run now waits
    t.state.blocked = false;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(t.calls).not.toContain("agents:idle"); // user active 5 s ago, idle needs 120 s
    t.clock.poke("manual");
    await vi.advanceTimersByTimeAsync(10);
    expect(t.calls).toContain("agents:manual");
    t.state.idle = 200_000;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(t.calls).toContain("agents:idle");
    t.clock.stop();
  });
  it("runs the nightly pass once a day at the configured hour and defers while a transcript is changing", async () => {
    const t = setup({ idle: 0, schedule: { onlyWhenIdle: true, idleStartSec: 120, nightly: { enabled: true, hour: 15 }, deferWhileBusyMs: 5 * 60_000 } });
    t.clock.start();
    t.change();
    await vi.advanceTimersByTimeAsync(61 * 60_000); // 15:01; the transcript was quiet from 14:06
    expect(t.calls.filter((c) => c === "agents:nightly")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(t.calls.filter((c) => c === "agents:nightly")).toHaveLength(1);
    t.clock.stop();
  });
});
