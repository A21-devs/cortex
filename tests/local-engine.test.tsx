/**
 * Local model engine (P20): a model on this computer, no cost. The HTTP layer is mocked, so no server is
 * contacted and no prompt is ever sent anywhere. Covers the engine contract (where "this computer", paid by
 * nobody, cost 0), loopback-only addresses, schema validation with one retry, failures, the free probe, the
 * settings Test button, the daily-cap rule and the run-row note.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { loadBudget, recordPlan } from "../src/agents/budget";
import { LocalEngine, type LocalEngineConfig } from "../src/agents/localEngine";
import { ensureEngineReady, GuardedEngine, loadEngineState } from "../src/agents/scheduler";
import { checkPatched } from "../src/plugin/settingsStore";
import { localTestText } from "../src/plugin/settingsTab";
import { createCancelSource } from "../src/shared/cancel";
import { CortexError } from "../src/shared/errors";
import { checkEndpoint, isLoopbackHost, LocalHttpError, localUrl, modelListed, parseJsonText, readReply, stripThinking, testEndpoint, type LocalHttp, type LocalHttpRequest } from "../src/shared/localModel";
import { nullLogger } from "../src/shared/log";
import { DEFAULT_SETTINGS, migrateSettingsChecked, type CortexSettings } from "../src/shared/settings";
import { openStoreContext } from "../src/store/layout";
import { RunExtra } from "../src/ui/pages/RunsLedger";
import { RunDetail } from "../src/ui/pages/Agents";
import type { RunRecord } from "../src/shared/types";
import type { EngineRequest } from "../src/agents/engine";

const SCHEMA = { type: "object" as const, required: ["items"], properties: { items: { type: "array" as const, items: { type: "string" as const } } } };
const GOOD = JSON.stringify({ items: ["a", "b"] });

function ollamaReply(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ model: "qwen2.5:14b", message: { role: "assistant", content }, prompt_eval_count: 11, eval_count: 5, ...extra });
}

interface Mock {
  http: LocalHttp;
  calls: LocalHttpRequest[];
}

/** A fake HTTP layer: each POST to the chat route takes the next scripted reply; GET lists models. */
function mock(chat: (string | Error | { status: number; text: string })[], models = '{"models":[{"name":"qwen2.5:14b"}]}'): Mock {
  const calls: LocalHttpRequest[] = [];
  let i = 0;
  const http: LocalHttp = async (req) => {
    calls.push(req);
    if (req.method === "GET") return { status: 200, text: models };
    const next = chat[Math.min(i++, chat.length - 1)];
    if (next instanceof Error) throw next;
    if (typeof next === "string") return { status: 200, text: next };
    return next as { status: number; text: string };
  };
  return { http, calls };
}

function cfg(http: LocalHttp, over: Partial<LocalEngineConfig> = {}): LocalEngineConfig {
  return { ...DEFAULT_SETTINGS.agents.local, model: "qwen2.5:14b", http, ...over };
}

const sig = () => createCancelSource().token.signal;
function request(over: Partial<EngineRequest> = {}): EngineRequest {
  return { runId: "r_aaaaaaaaaaaaaaaa" as never, job: "label", model: "haiku", system: "sys", prompt: "p".repeat(700), schema: SCHEMA, timeoutMs: 20_000, effort: "low", signal: sig(), ...over };
}

describe("shared/localModel: addresses", () => {
  it("knows which hosts mean this computer", () => {
    for (const h of ["localhost", "LOCALHOST", "foo.localhost", "127.0.0.1", "127.9.9.9", "[::1]", "::1", "::ffff:7f00:1"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["192.168.1.5", "10.0.0.2", "example.com", "0.0.0.0", "128.0.0.1", "127.0.0.1.evil.com", "[::2]"]) expect(isLoopbackHost(h), h).toBe(false);
  });
  it("accepts a loopback address, refuses others unless a network address is allowed, and cleans the base", () => {
    expect(checkEndpoint("http://127.0.0.1:11434/", false)).toMatchObject({ ok: true, base: "http://127.0.0.1:11434", loopback: true });
    expect(checkEndpoint("localhost:1234/v1/", false)).toMatchObject({ ok: true, base: "http://localhost:1234/v1" });
    expect(checkEndpoint("http://192.168.1.5:11434", false)).toEqual({ ok: false, reason: "not-loopback", host: "192.168.1.5" });
    expect(checkEndpoint("http://192.168.1.5:11434", true)).toMatchObject({ ok: true, loopback: false });
    expect(checkEndpoint("http://localhost.evil.com", false)).toMatchObject({ ok: false, reason: "not-loopback" });
    expect(checkEndpoint("", false)).toMatchObject({ ok: false, reason: "empty" });
    expect(checkEndpoint("file:///etc/passwd", true)).toMatchObject({ ok: false, reason: "scheme" });
    expect(checkEndpoint("http://user:pw@127.0.0.1", false)).toMatchObject({ ok: false, reason: "credentials" });
  });
  it("builds the routes for both server types", () => {
    expect(localUrl("http://127.0.0.1:11434", "ollama", "chat")).toBe("http://127.0.0.1:11434/api/chat");
    expect(localUrl("http://127.0.0.1:11434", "ollama", "models")).toBe("http://127.0.0.1:11434/api/tags");
    expect(localUrl("http://127.0.0.1:1234", "openai", "chat")).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(localUrl("http://127.0.0.1:1234/v1", "openai", "models")).toBe("http://127.0.0.1:1234/v1/models");
  });
});

describe("shared/localModel: reading replies", () => {
  it("reads text and usage from Ollama and OpenAI-style replies", () => {
    expect(readReply("ollama", ollamaReply("hi"))).toMatchObject({ text: "hi", tokensIn: 11, tokensOut: 5, model: "qwen2.5:14b" });
    expect(readReply("openai", JSON.stringify({ model: "m", choices: [{ message: { content: "yo" } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }))).toMatchObject({ text: "yo", tokensIn: 7, tokensOut: 3 });
    expect(readReply("ollama", "not json")).toBeUndefined();
    expect(readReply("openai", "{}")).toBeUndefined();
  });
  it("strips reasoning blocks and finds JSON in fences and prose", () => {
    expect(stripThinking("<think>hmm {\"x\":1}</think>\n{\"a\":1}")).toBe('{"a":1}');
    expect(parseJsonText('<think>x</think>```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonText('Sure! {"a":2} Hope that helps')).toEqual({ a: 2 });
    expect(parseJsonText("no json here")).toBeUndefined();
  });
  it("matches installed model names with or without the tag", () => {
    expect(modelListed(["qwen2.5:14b", "llama3:latest"], "qwen2.5:14b")).toBe(true);
    expect(modelListed(["llama3:latest"], "llama3")).toBe(true);
    expect(modelListed(["llama3:8b"], "llama3")).toBe(false);
    expect(modelListed([], "x")).toBe(false);
  });
});

describe("agents/localEngine: a call that ran on this computer", () => {
  it("answers with data, real token counts, cost 0 and the engine's own model name", async () => {
    const m = mock([ollamaReply(GOOD)]);
    const e = new LocalEngine(cfg(m.http));
    expect([e.kind, e.where, e.paidBy]).toEqual(["local", "this computer", "none"]);
    const r = await e.run(request());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output).toEqual({ items: ["a", "b"] });
    expect(r.modelUsed).toBe("qwen2.5:14b");
    expect(r.usage).toMatchObject({ inputTokens: 11, outputTokens: 5, costUsd: 0, estimated: false, models: ["qwen2.5:14b"] });
    expect(m.calls).toHaveLength(1);
    const call = m.calls[0] as LocalHttpRequest;
    expect(call.url).toBe("http://127.0.0.1:11434/api/chat");
    const body = JSON.parse(call.body as string) as { model: string; stream: boolean; format: unknown; messages: { role: string }[]; options: { num_ctx: number } };
    expect(body).toMatchObject({ model: "qwen2.5:14b", stream: false, format: SCHEMA });
    expect(body.messages.map((x) => x.role)).toEqual(["system", "user"]);
    expect(body.options.num_ctx).toBeGreaterThanOrEqual(4096);
  });
  it("estimates tokens when the server reports none, and says so", async () => {
    const m = mock([JSON.stringify({ message: { content: GOOD } })]);
    const r = await new LocalEngine(cfg(m.http)).run(request());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.usage.estimated).toBe(true);
      expect(r.usage.inputTokens).toBeGreaterThan(100);
      expect(r.usage.outputTokens).toBeGreaterThan(0);
      expect(r.usage.costUsd).toBe(0);
    }
  });
  it("speaks the OpenAI-compatible format when chosen", async () => {
    const m = mock([JSON.stringify({ model: "m1", choices: [{ message: { content: GOOD } }], usage: { prompt_tokens: 20, completion_tokens: 8 } })]);
    const r = await new LocalEngine(cfg(m.http, { api: "openai", endpoint: "http://127.0.0.1:1234", model: "m1" })).run(request());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.usage).toMatchObject({ inputTokens: 20, outputTokens: 8 });
    expect((m.calls[0] as LocalHttpRequest).url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(JSON.parse((m.calls[0] as LocalHttpRequest).body as string)).toMatchObject({ response_format: { type: "json_schema" }, max_tokens: expect.any(Number) });
  });
  it("reads an answer fenced or after a reasoning block", async () => {
    const m = mock([ollamaReply(`<think>let me see</think>\n\`\`\`json\n${GOOD}\n\`\`\``)]);
    const r = await new LocalEngine(cfg(m.http)).run(request());
    expect(r.ok).toBe(true);
  });
});

describe("agents/localEngine: only this computer, unless allowed", () => {
  it("refuses a non-loopback address without sending anything", async () => {
    const m = mock([ollamaReply(GOOD)]);
    const r = await new LocalEngine(cfg(m.http, { endpoint: "http://192.168.1.20:11434" })).run(request());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatchObject({ code: "E_ENGINE_FAILED", reason: "address-refused", retryable: false });
      expect(r.started).toBe(false);
    }
    expect(m.calls).toHaveLength(0);
  });
  it("uses a network address once it is allowed", async () => {
    const m = mock([ollamaReply(GOOD)]);
    const r = await new LocalEngine(cfg(m.http, { endpoint: "http://192.168.1.20:11434", allowNetwork: true })).run(request());
    expect(r.ok).toBe(true);
    expect((m.calls[0] as LocalHttpRequest).url.startsWith("http://192.168.1.20:11434/")).toBe(true);
  });
  it("the free check refuses it too, and never sends a prompt", async () => {
    const m = mock([ollamaReply(GOOD)]);
    expect(await new LocalEngine(cfg(m.http, { endpoint: "http://example.com" })).probe()).toMatchObject({ ok: false, detail: "address refused" });
    expect(m.calls).toHaveLength(0);
  });
  it("refuses when no model is chosen", async () => {
    const m = mock([ollamaReply(GOOD)]);
    const r = await new LocalEngine(cfg(m.http, { model: " " })).run(request());
    expect(r.ok).toBe(false);
    expect(m.calls).toHaveLength(0);
  });
});

describe("agents/localEngine: schema check with one retry", () => {
  it("asks again once, showing the model what was wrong, and adds up both calls", async () => {
    const m = mock([ollamaReply('{"items":"nope"}'), ollamaReply(GOOD)]);
    const r = await new LocalEngine(cfg(m.http)).run(request());
    expect(r.ok).toBe(true);
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(2);
    const second = JSON.parse((m.calls[1] as LocalHttpRequest).body as string) as { messages: { role: string; content: string }[] };
    expect(second.messages.map((x) => x.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(second.messages[3]?.content).toContain("did not match");
    if (r.ok) expect(r.usage.inputTokens).toBe(22);
  });
  it("gives up after the one retry with a validation error that keeps the raw text", async () => {
    const m = mock([ollamaReply("not json at all"), ollamaReply('{"items":[1]}')]);
    const r = await new LocalEngine(cfg(m.http)).run(request());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatchObject({ code: "E_VALIDATION", reason: "schema" });
      expect(r.usage?.inputTokens).toBe(22);
      expect(r.started).toBe(true);
    }
    expect(m.calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });
  it("drops the schema format once when an older server rejects it, then remembers", async () => {
    const m = mock([{ status: 400, text: "bad format" }, ollamaReply(GOOD), ollamaReply(GOOD)]);
    const e = new LocalEngine(cfg(m.http));
    expect((await e.run(request())).ok).toBe(true);
    const first = JSON.parse((m.calls[0] as LocalHttpRequest).body as string) as Record<string, unknown>;
    const retry = JSON.parse((m.calls[1] as LocalHttpRequest).body as string) as Record<string, unknown>;
    expect(first.format).toEqual(SCHEMA);
    expect(retry.format).toBeUndefined();
    expect((await e.run(request())).ok).toBe(true);
    expect((JSON.parse((m.calls[2] as LocalHttpRequest).body as string) as Record<string, unknown>).format).toBeUndefined();
  });
});

describe("agents/localEngine: failures", () => {
  it("reports an unreachable endpoint clearly, as nothing sent", async () => {
    const m = mock([new LocalHttpError("network")]);
    const r = await new LocalEngine(cfg(m.http)).run(request());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatchObject({ code: "E_ENGINE_FAILED", state: "offline", reason: "endpoint-unreachable", retryable: true });
      expect(r.started).toBe(false);
    }
  });
  it("maps a timeout, a cancel, a missing model and a server error", async () => {
    const t = await new LocalEngine(cfg(mock([new LocalHttpError("timeout")]).http)).run(request());
    expect(!t.ok && t.error.code).toBe("E_TIMEOUT");
    const c = await new LocalEngine(cfg(mock([new LocalHttpError("aborted")]).http)).run(request());
    expect(!c.ok && c.error.code).toBe("E_CANCELLED");
    const nf = await new LocalEngine(cfg(mock([{ status: 404, text: "{}" }]).http)).run(request());
    expect(!nf.ok && nf.error).toMatchObject({ reason: "model-not-found", state: "offline" });
    const se = await new LocalEngine(cfg(mock([{ status: 503, text: "" }]).http)).run(request());
    expect(!se.ok && se.error).toMatchObject({ code: "E_ENGINE_FAILED", retryable: true });
  });
  it("uses the settings timeout (capped by the call's own) for each request", async () => {
    const m = mock([ollamaReply(GOOD)]);
    await new LocalEngine(cfg(m.http, { timeoutSec: 60 })).run(request({ timeoutMs: 240_000 }));
    expect((m.calls[0] as LocalHttpRequest).timeoutMs).toBe(60_000);
    const m2 = mock([ollamaReply(GOOD)]);
    await new LocalEngine(cfg(m2.http, { timeoutSec: 60 })).run(request({ timeoutMs: 5_000 }));
    expect((m2.calls[0] as LocalHttpRequest).timeoutMs).toBeLessThanOrEqual(5_000);
  });
  it("does nothing when already cancelled", async () => {
    const m = mock([ollamaReply(GOOD)]);
    const src = createCancelSource();
    src.cancel();
    const r = await new LocalEngine(cfg(m.http)).run(request({ signal: src.token.signal }));
    expect(!r.ok && r.error.code).toBe("E_CANCELLED");
    expect(m.calls).toHaveLength(0);
  });
});

describe("agents/localEngine: the free check", () => {
  it("is ready when the model is installed, and says what is wrong otherwise", async () => {
    expect(await new LocalEngine(cfg(mock([]).http)).probe()).toMatchObject({ ok: true, detail: "ready" });
    expect(await new LocalEngine(cfg(mock([]).http, { model: "other" })).probe()).toMatchObject({ ok: false, detail: "model missing" });
    expect(await new LocalEngine(cfg(mock([]).http, { model: "" })).probe()).toMatchObject({ ok: false, detail: "no model chosen" });
    const down: LocalHttp = async () => {
      throw new LocalHttpError("network");
    };
    expect(await new LocalEngine(cfg(down)).probe()).toMatchObject({ ok: false, detail: "unreachable" });
  });
});

describe("shared/localModel: the Test button", () => {
  it("lists the models and answers one token", async () => {
    const m = mock([ollamaReply("ok", { eval_count: 1 })]);
    const r = await testEndpoint(cfg(m.http));
    expect(r).toMatchObject({ ok: true, model: "qwen2.5:14b", models: ["qwen2.5:14b"] });
    expect(m.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
    expect(JSON.parse((m.calls[1] as LocalHttpRequest).body as string)).toMatchObject({ options: { num_predict: 1 } });
    expect(localTestText(r, "x")).toContain("qwen2.5:14b answered");
  });
  it("lists models when none is chosen, and refuses a network address that is not allowed", async () => {
    const r = await testEndpoint(cfg(mock([]).http, { model: "" }));
    expect(r).toMatchObject({ ok: false, reason: "no-model", models: ["qwen2.5:14b"] });
    expect(localTestText(r, "x")).toContain("qwen2.5:14b");
    const m = mock([]);
    const refused = await testEndpoint(cfg(m.http, { endpoint: "http://10.1.1.1:11434" }));
    expect(refused).toMatchObject({ ok: false, reason: "address-refused", host: "10.1.1.1" });
    expect(m.calls).toHaveLength(0);
    expect(localTestText(refused, "x")).toContain("10.1.1.1");
  });
  it("reports a missing model and an unreachable server in plain words", async () => {
    const missing = await testEndpoint(cfg(mock([]).http, { model: "nope" }));
    expect(localTestText(missing, "x")).toContain("nope");
    const down: LocalHttp = async () => {
      throw new LocalHttpError("network");
    };
    const unreachable = await testEndpoint(cfg(down));
    expect(localTestText(unreachable, "http://127.0.0.1:11434")).toContain("http://127.0.0.1:11434");
  });
});

// ───────────────────────────── the daily cap and the engine state ─────────────────────────────

async function tempStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cortex-p20-"));
  const vault = path.join(root, "vault");
  await mkdir(path.join(vault, ".obsidian"), { recursive: true });
  const cacheDir = path.join(root, "cortex", "abcdefghijklmnop");
  await mkdir(cacheDir, { recursive: true });
  return openStoreContext({ vaultRoot: vault, cacheDir, owner: "test", log: nullLogger });
}

function guardFor(store: Awaited<ReturnType<typeof tempStore>>, inner: LocalEngine, settings: CortexSettings) {
  return new GuardedEngine({ inner, store, settings, privacyRev: 0, token: createCancelSource().token, now: () => Date.now(), log: nullLogger, emit: () => undefined, readLogged: () => true, onEngineState: async () => undefined });
}

describe("daily cap: runs on this computer", () => {
  it("leave the cap alone by default, and are listed as uncounted", async () => {
    const store = await tempStore();
    const guard = guardFor(store, new LocalEngine(cfg(mock([ollamaReply(GOOD)]).http)), DEFAULT_SETTINGS);
    expect([guard.kind, guard.where, guard.paidBy]).toEqual(["local", "this computer", "none"]);
    const r = await guard.run(request());
    expect(r.ok).toBe(true);
    const b = await loadBudget(store);
    expect(b.today.tokens).toBe(0);
    expect(b.today.uncounted).toBe(16);
    expect(b.today.usd).toBe(0);
  });
  it("count toward the cap when the setting asks for it", async () => {
    const store = await tempStore();
    const settings = { ...DEFAULT_SETTINGS, agents: { ...DEFAULT_SETTINGS.agents, local: { ...DEFAULT_SETTINGS.agents.local, countTowardCap: true } } };
    const guard = guardFor(store, new LocalEngine(cfg(mock([ollamaReply(GOOD)]).http)), settings);
    expect((await guard.run(request())).ok).toBe(true);
    expect((await loadBudget(store)).today.tokens).toBe(16);
  });
  it("still run when a plan cap is reached, because they cost nothing", async () => {
    const store = await tempStore();
    await recordPlan(store, { fiveHour: { pct: 99, resetsAt: Date.now() + 3_600_000, seenAt: Date.now() } });
    const settings = { ...DEFAULT_SETTINGS };
    const guard = guardFor(store, new LocalEngine(cfg(mock([ollamaReply(GOOD)]).http)), settings);
    expect((await guard.run(request({ prompt: "p".repeat(400_000) }))).ok).toBe(true);
  });
});

describe("scheduler: the local engine gate", () => {
  const deps = async (http: LocalHttp) => {
    const store = await tempStore();
    return { store, emit: () => undefined, now: () => Date.now(), settings: DEFAULT_SETTINGS, engine: new LocalEngine(cfg(http)), liveCheck: null, token: createCancelSource().token, log: nullLogger };
  };
  it("marks the engine offline when the server is down, then ready again once it answers, with no live check", async () => {
    const down: LocalHttp = async () => {
      throw new LocalHttpError("network");
    };
    const d = await deps(down);
    await expect(ensureEngineReady(d)).rejects.toMatchObject({ code: "E_ENGINE_FAILED", detail: { reason: "local:unreachable" } });
    expect((await loadEngineState(d.store.cacheDir)).state).toBe("offline");
    const d2 = { ...d, engine: new LocalEngine(cfg(mock([]).http)) };
    await expect(ensureEngineReady(d2)).resolves.toBeUndefined();
    expect((await loadEngineState(d.store.cacheDir)).state).toBe("ok");
  });
  it("says why an uninstalled model cannot run", async () => {
    const d = await deps(mock([]).http);
    d.engine = new LocalEngine(cfg(mock([]).http, { model: "missing-model" }));
    const err = await ensureEngineReady(d).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CortexError);
    expect((err as CortexError).detail).toMatchObject({ reason: "local:model-missing" });
  });
});

describe("settings", () => {
  it("default to the Claude Code engine with a local block pointing at this computer, off the cap", () => {
    expect(DEFAULT_SETTINGS.agents.engine).toBe("claude-cli");
    expect(DEFAULT_SETTINGS.agents.local).toMatchObject({ endpoint: "http://127.0.0.1:11434", api: "ollama", allowNetwork: false, timeoutSec: 60, countTowardCap: false });
  });
  it("fills the block for settings saved before it existed, and clamps the timeout", () => {
    const m = migrateSettingsChecked({ version: 4, agents: { engine: "local" } });
    expect(m.settings.agents.engine).toBe("local");
    expect(m.settings.agents.local.endpoint).toBe("http://127.0.0.1:11434");
    const next = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as CortexSettings;
    next.agents.local.timeoutSec = 99_999;
    expect(checkPatched(next).agents.local.timeoutSec).toBe(900);
  });
});

describe("run rows", () => {
  const run = (where: RunRecord["where"]): RunRecord =>
    ({ v: 1, id: "r_aaaaaaaaaaaaaaaa", job: "label", pass: 1, engine: where === "remote" ? "claude-cli" : "local", model: "qwen2.5:14b", where, paidBy: where === "remote" ? "plan" : "none", startedAt: "2026-11-10T10:00:00.000Z", finishedAt: "2026-11-10T10:00:12.000Z", status: "finished", targets: [], items: 1, labels: 1, declined: 0, noAnswer: 0, tokensIn: 10, tokensOut: 5, tokensCacheRead: 0, tokensCacheWrite: 0, tokensEstimated: false, costUsd: 0, priceTableDate: "2026-11-10", promptVersion: "label@1.0.0", effort: "low" }) as RunRecord;
  it("say a local run cost nothing, in the ledger and on the Agents page, and say nothing for a remote one", () => {
    expect(render(<RunExtra run={run("this computer")} />)).toContain("Ran on this computer, so it cost nothing.");
    expect(render(<RunDetail run={run("this computer")} />)).toContain("Ran on this computer, so it cost nothing.");
    expect(render(<RunExtra run={run("remote")} />)).not.toContain("cost nothing");
    expect(render(<RunDetail run={run("remote")} />)).not.toContain("cost nothing");
  });
  it("word a local run's failed call as a model that did not answer, not as Claude Code", () => {
    const failed = { ...run("this computer"), status: "failed" as const, error: { code: "E_ENGINE_FAILED", message: "x" } } as RunRecord;
    const html = render(<RunExtra run={failed} />);
    expect(html).toContain("The model on this computer didn't answer");
    expect(html).not.toContain("Claude Code");
  });
});
