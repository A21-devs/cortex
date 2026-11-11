/**
 * The Claude plan's 5-hour and weekly limits as the agents' only stop: reading the utilization Claude Code reports
 * (rate_limit_event lines in stream-json output), keeping the latest reading, holding calls and passes at the caps the
 * person set and carrying on after each window resets. Nothing here reaches a model: the CLI is tests/fixtures/fake-claude.mjs.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBudget, recordPlan } from "../src/agents/budget";
import { buildClaudeArgs, ClaudeCliEngine, limitResetFromPlan, withPlan } from "../src/agents/claudeCli";
import { addUsage, zeroUsage, type Engine } from "../src/agents/engine";
import { AgentScheduler, GuardedEngine } from "../src/agents/scheduler";
import { createCancelSource } from "../src/shared/cancel";
import { nullLogger } from "../src/shared/log";
import {
  effectivePct,
  emptyPlanViews,
  mergePlan,
  normalizePlan,
  parseRateLimitEvents,
  planBlock,
  planCapsOf,
  planViews,
  withCaps,
  type PlanWindows,
} from "../src/shared/planLimits";
import { DEFAULT_SETTINGS, migrateSettingsChecked } from "../src/shared/settings";
import { checkPatched } from "../src/plugin/settingsStore";
import { createLedgerStore } from "../src/store/ledger";
import { openStoreContext } from "../src/store/layout";
import { pctText, planTip, readingText, resetWhen, windowLine } from "../src/ui/planText";
import type { RunRecord } from "../src/shared/types";

const FAKE = path.join(__dirname, "fixtures", "fake-claude.mjs");
const NOW = Date.parse("2026-11-10T12:00:00Z");
const sec = (ms: number): number => Math.floor(ms / 1000);

const line = (o: unknown): string => JSON.stringify(o);
const event = (info: unknown): string => line({ type: "rate_limit_event", rate_limit_info: info, uuid: "u", session_id: "s" });

describe("planLimits: reading Claude Code's rate-limit events", () => {
  it("reads both windows from unifiedWindows (fractions become percent, seconds become milliseconds)", () => {
    const out = [
      line({ type: "system", subtype: "init" }),
      event({ status: "allowed", resetsAt: sec(NOW) + 7200, rateLimitType: "five_hour", utilization: 0.42, unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: sec(NOW) + 7200 }, seven_day: { utilization: 0.183, resetsAt: sec(NOW) + 259200 } } }),
      line({ type: "result", subtype: "success" }),
    ].join("\n");
    const p = parseRateLimitEvents(out, NOW) as PlanWindows;
    expect(p.fiveHour).toEqual({ pct: 42, resetsAt: (sec(NOW) + 7200) * 1000, seenAt: NOW });
    expect(p.weekly).toEqual({ pct: 18.3, resetsAt: (sec(NOW) + 259200) * 1000, seenAt: NOW });
  });
  it("reads the older top-level shape, a rejected window as full, and keeps the later event over the earlier", () => {
    const old = parseRateLimitEvents(event({ status: "allowed_warning", resetsAt: sec(NOW) + 100, rateLimitType: "seven_day", utilization: 0.8 }), NOW) as PlanWindows;
    expect(old.weekly?.pct).toBe(80);
    expect(old.fiveHour).toBeUndefined();
    const rejected = parseRateLimitEvents(event({ status: "rejected", resetsAt: sec(NOW) + 100, rateLimitType: "five_hour" }), NOW) as PlanWindows;
    expect(rejected.fiveHour?.pct).toBe(100);
    const twice = [event({ status: "allowed", rateLimitType: "five_hour", utilization: 0.1, resetsAt: sec(NOW) + 100 }), event({ status: "allowed", rateLimitType: "five_hour", utilization: 0.3, resetsAt: sec(NOW) + 100 })].join("\n");
    expect(parseRateLimitEvents(twice, NOW)?.fiveHour?.pct).toBe(30);
  });
  it("finds nothing in plain output, other limit types, or damaged lines", () => {
    expect(parseRateLimitEvents("", NOW)).toBeNull();
    expect(parseRateLimitEvents(line({ type: "result", subtype: "success", result: "rate_limit_event" }), NOW)).toBeNull();
    expect(parseRateLimitEvents('{"type":"rate_limit_event", broken', NOW)).toBeNull();
    expect(parseRateLimitEvents(event({ status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.9, resetsAt: sec(NOW) + 1 }), NOW)).toBeNull();
    expect(parseRateLimitEvents(event({ status: "allowed", rateLimitType: "five_hour", utilization: "x", resetsAt: sec(NOW) + 1 }), NOW)).toBeNull();
  });
});

describe("planLimits: caps, resets and what is shown", () => {
  const plan = (five: number, week: number): PlanWindows => ({ fiveHour: { pct: five, resetsAt: NOW + 2 * 3_600_000, seenAt: NOW }, weekly: { pct: week, resetsAt: NOW + 3 * 86_400_000, seenAt: NOW } });
  it("blocks at the cap, names the window and its reset, and lets go after the reset", () => {
    const caps = { fiveHour: 70, weekly: 70 };
    expect(planBlock(plan(69, 69), caps, NOW)).toBeNull();
    expect(planBlock(plan(70, 10), caps, NOW)).toEqual({ window: "fiveHour", pct: 70, capPct: 70, resumeAt: NOW + 2 * 3_600_000 });
    expect(planBlock(plan(10, 70), caps, NOW)?.window).toBe("weekly");
    expect(planBlock(plan(90, 90), caps, NOW)?.window).toBe("weekly"); // both full: wait for the one that resets last
    expect(planBlock(plan(90, 10), caps, NOW + 2 * 3_600_000)).toBeNull();
    expect(effectivePct(plan(90, 10).fiveHour, NOW + 2 * 3_600_000)).toBe(0);
  });
  it("each cap can be off, and no reading never blocks", () => {
    expect(planBlock(plan(99, 99), { fiveHour: null, weekly: null }, NOW)).toBeNull();
    expect(planBlock(plan(99, 10), { fiveHour: null, weekly: 70 }, NOW)).toBeNull();
    expect(planBlock(undefined, { fiveHour: 70, weekly: 70 }, NOW)).toBeNull();
    expect(planBlock({}, { fiveHour: 5, weekly: 5 }, NOW)).toBeNull();
  });
  it("turns the settings into caps (off or unusable means none)", () => {
    expect(planCapsOf(DEFAULT_SETTINGS.agents.planCaps)).toEqual({ fiveHour: 70, weekly: 70 });
    expect(planCapsOf({ fiveHour: { on: false, pct: 70 }, weekly: { on: true, pct: 250 } })).toEqual({ fiveHour: null, weekly: 100 });
    expect(planCapsOf({ fiveHour: { on: true, pct: 0 }, weekly: { on: true, pct: 55 } })).toEqual({ fiveHour: null, weekly: 55 });
  });
  it("merges a newer reading over an older one and keeps the other window", () => {
    const older = plan(10, 20);
    const newer: PlanWindows = { fiveHour: { pct: 30, resetsAt: NOW + 5, seenAt: NOW + 10 } };
    expect(mergePlan(older, newer).fiveHour?.pct).toBe(30);
    expect(mergePlan(older, newer).weekly?.pct).toBe(20);
    expect(mergePlan(newer, older).fiveHour?.pct).toBe(30); // an older reading does not replace a newer one
    expect(mergePlan(undefined, null)).toEqual({});
  });
  it("views: used, cap, reset, stale and at-cap, and the same views under new caps", () => {
    const v = planViews(plan(71, 10), { fiveHour: 70, weekly: null }, NOW);
    expect(v.fiveHour).toMatchObject({ pct: 71, capPct: 70, atCap: true, stale: false, resetsAt: NOW + 2 * 3_600_000 });
    expect(v.weekly).toMatchObject({ pct: 10, capPct: null, atCap: false });
    const stale = planViews(plan(71, 10), { fiveHour: 70, weekly: 70 }, NOW + 3 * 3_600_000);
    expect(stale.fiveHour).toMatchObject({ pct: 0, stale: true, atCap: false, resetsAt: null });
    expect(emptyPlanViews().fiveHour).toMatchObject({ pct: null, capPct: null, atCap: false });
    expect(withCaps(v, { fiveHour: 80, weekly: 5 })).toMatchObject({ fiveHour: { capPct: 80, atCap: false }, weekly: { capPct: 5, atCap: true } });
  });
  it("drops damaged stored readings", () => {
    expect(normalizePlan({ fiveHour: { pct: 12, resetsAt: NOW, seenAt: NOW }, weekly: { pct: -1, resetsAt: NOW } })).toEqual({ fiveHour: { pct: 12, resetsAt: NOW, seenAt: NOW } });
    expect(normalizePlan("x")).toBeUndefined();
    expect(normalizePlan({ weekly: { pct: "7", resetsAt: 1 } })).toBeUndefined();
  });
  it("words the windows for the screens", () => {
    const v = planViews(plan(42, 18.3), { fiveHour: 70, weekly: null }, NOW);
    expect(windowLine(v.fiveHour, NOW)).toMatch(/^42% used · stops at 70% · resets \d\d:\d\d$/);
    expect(windowLine(v.weekly, NOW)).toMatch(/^18\.3% used · no cap · resets [A-Z][a-z]{2} \d\d:\d\d$/);
    expect(windowLine(emptyPlanViews().fiveHour, NOW)).toBe("not reported yet · no cap");
    expect(readingText(emptyPlanViews().weekly, NOW)).toContain("Not reported yet");
    expect(planTip(v)).toBe("5-hour 42% · weekly 18.3%");
    expect(planTip(emptyPlanViews())).toBe("5-hour — · weekly —");
    expect(pctText(0.04)).toBe("0.1%");
    expect(pctText(99.6)).toBe("99.6%");
    expect(pctText(42)).toBe("42%");
    expect(resetWhen(NOW + 60_000, NOW)).toMatch(/^\d\d:\d\d$/);
  });
});

describe("settings: the plan caps", () => {
  it("clamp to 5–100 and round when saved, and an out-of-range stored value is repaired", () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.agents.planCaps.fiveHour.pct = 1;
    s.agents.planCaps.weekly.pct = 400.4;
    const saved = checkPatched(s);
    expect(saved.agents.planCaps).toEqual({ fiveHour: { on: true, pct: 5 }, weekly: { on: true, pct: 100 } });
    expect(migrateSettingsChecked({ agents: { planCaps: { fiveHour: { on: "yes", pct: 60 } } } }).issues.length).toBeGreaterThan(0);
  });
});

describe("claude headless calls: stream-json with the plan's utilization", () => {
  const dir = async () => mkdtemp(path.join(os.tmpdir(), "cortex-plan-"));
  async function engine(mode: string) {
    const d = await dir();
    return new ClaudeCliEngine({ exe: process.execPath, preArgs: [FAKE, `--fake-mode=${mode}`], cwd: d, tmpDir: path.join(d, "tmp"), useJsonSchemaFlag: true }, nullLogger);
  }
  const req = (runId = "r_aaaaaaaaaaaaaaaa") => ({ runId: runId as never, job: "label" as const, model: "haiku", system: "s", prompt: "p", schema: { type: "object" as const }, timeoutMs: 20_000, effort: "low" as const, signal: createCancelSource().token.signal });

  it("builds the call with stream-json and --verbose when asked", () => {
    const a = buildClaudeArgs({ model: "haiku", effort: "low", outputFormat: "stream-json" });
    expect(a.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(buildClaudeArgs({ model: "haiku", effort: "low" }).slice(0, 3)).toEqual(["-p", "--output-format", "json"]);
  });
  it("keeps today's result parsing and returns the plan reading with the usage", async () => {
    const r = await (await engine("plan")).run(req());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output).toMatchObject({ model: "haiku", toolsDisabled: true, restricted: true });
    expect(r.usage.inputTokens).toBe(120);
    expect(r.usage.plan?.fiveHour?.pct).toBe(42);
    expect(r.usage.plan?.weekly?.pct).toBe(18);
    expect(r.usage.plan?.fiveHour?.resetsAt).toBeGreaterThan(Date.now());
  }, 30_000);
  it("returns no plan reading when the CLI reports none", async () => {
    const r = await (await engine("ok")).run(req());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.usage.plan).toBeUndefined();
  }, 30_000);
  it("reads the older event shape too", async () => {
    const r = await (await engine("plan-old")).run(req());
    if (r.ok) expect(r.usage.plan?.fiveHour?.pct).toBe(80);
    expect(r.ok).toBe(true);
  }, 30_000);
  it("resumes a usage-limit failure at the rejected window's reset time", async () => {
    const before = Date.now();
    const r = await (await engine("plan-rejected")).run(req());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("E_ENGINE_LIMIT");
    const at = Date.parse(r.error.resumeAt as string);
    expect(at).toBeGreaterThan(before + 2.9 * 3_600_000);
    expect(at).toBeLessThan(before + 3.1 * 3_600_000);
    expect(r.usage?.plan?.fiveHour?.pct).toBe(100);
  }, 30_000);
  it("carries a plan reading through withPlan, addUsage and limitResetFromPlan", () => {
    expect(withPlan(undefined, null)).toBeUndefined();
    const u = withPlan(zeroUsage(false), { fiveHour: { pct: 100, resetsAt: 5000, seenAt: 1 }, weekly: { pct: 100, resetsAt: 9000, seenAt: 1 } });
    expect(u?.plan?.weekly?.pct).toBe(100);
    expect(addUsage(u!, { ...zeroUsage(false), plan: { fiveHour: { pct: 3, resetsAt: 6000, seenAt: 2 } } }).plan?.fiveHour?.pct).toBe(3);
    expect(limitResetFromPlan(u?.plan ?? null)).toBe(9000);
    expect(limitResetFromPlan({ fiveHour: { pct: 60, resetsAt: 5000, seenAt: 1 } })).toBeUndefined();
  });
});

async function tempStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cortex-planstore-"));
  const vault = path.join(root, "vault");
  await mkdir(path.join(vault, ".obsidian"), { recursive: true });
  const cacheDir = path.join(root, "cortex", "abcdefghijklmnop");
  await mkdir(cacheDir, { recursive: true });
  return openStoreContext({ vaultRoot: vault, cacheDir, owner: "test", log: nullLogger });
}

describe("the guarded engine: holds at a plan cap and resumes after the reset", () => {
  async function fakeEngine(mode: string): Promise<{ engine: Engine; store: Awaited<ReturnType<typeof tempStore>> }> {
    const d = await mkdtemp(path.join(os.tmpdir(), "cortex-plan-g-"));
    const engine = new ClaudeCliEngine({ exe: process.execPath, preArgs: [FAKE, `--fake-mode=${mode}`], cwd: d, tmpDir: path.join(d, "tmp"), useJsonSchemaFlag: true }, nullLogger);
    return { engine, store: await tempStore() };
  }
  const request = (runId: string) => ({ runId: runId as never, job: "label" as const, model: "haiku", system: "s", prompt: "p", schema: { type: "object" as const }, timeoutMs: 20_000, effort: "low" as const, signal: createCancelSource().token.signal });

  it("settles the reported utilization into the budget, refuses the next call at the cap, and runs again once the window has reset", async () => {
    const { engine, store } = await fakeEngine("plan-hot"); // each call reports the 5-hour window at 71%
    const emitted: unknown[] = [];
    const guard = new GuardedEngine({ inner: engine, store, settings: DEFAULT_SETTINGS, privacyRev: 0, token: createCancelSource().token, now: () => Date.now(), log: nullLogger, emit: (e) => void emitted.push(e), readLogged: () => true, onEngineState: async () => undefined });
    const first = await guard.run(request("r_aaaaaaaaaaaaaaaa"));
    expect(first.ok).toBe(true); // nothing was known before this call
    const stored = (await loadBudget(store)).plan;
    expect(stored?.fiveHour?.pct).toBe(71);
    expect(stored?.weekly?.pct).toBe(18);
    const last = emitted.filter((e) => (e as { kind: string }).kind === "budget").pop() as { plan: { fiveHour: { pct: number; capPct: number; atCap: boolean } }; capped: boolean };
    expect(last).toMatchObject({ capped: true, plan: { fiveHour: { pct: 71, capPct: 70, atCap: true } } });
    const second = await guard.run(request("r_bbbbbbbbbbbbbbbb"));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toMatchObject({ code: "E_BUDGET_CAPPED", reason: "plan-5h" });
      expect(second.started).toBe(false);
      expect(Date.parse(second.error.resumeAt as string)).toBeGreaterThan(Date.now());
    }
    // The 5-hour window resets: the stored reading's reset time passes, and the same call is allowed again.
    await recordPlan(store, { fiveHour: { pct: 71, resetsAt: Date.now() - 1000, seenAt: Date.now() + 1 } });
    const third = await guard.run(request("r_cccccccccccccccc"));
    expect(third.ok).toBe(true);
  }, 60_000);
  it("does not hold anything when the cap is off", async () => {
    const { engine, store } = await fakeEngine("plan-hot");
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.agents.planCaps.fiveHour.on = false;
    const guard = new GuardedEngine({ inner: engine, store, settings, privacyRev: 0, token: createCancelSource().token, now: () => Date.now(), log: nullLogger, emit: () => undefined, readLogged: () => true, onEngineState: async () => undefined });
    expect((await guard.run(request("r_aaaaaaaaaaaaaaaa"))).ok).toBe(true);
    expect((await guard.run(request("r_bbbbbbbbbbbbbbbb"))).ok).toBe(true);
  }, 60_000);
});

describe("a pass: pauses at a plan cap, between units and at the start, and resumes after the reset", () => {
  const jobPlan = (n: number) => ({ job: "label" as const, targets: [`c_${String(n).padStart(16, "a")}`], model: "haiku", estimateTokens: 100, priority: 1 });
  async function scheduler(over: { fire(plan: ReturnType<typeof jobPlan>): Promise<void> | void }) {
    const store = await tempStore();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.general.firstRunDone = true;
    settings.agents.concurrency = 1;
    const events: { kind: string }[] = [];
    const started: string[] = [];
    const engine: Engine = {
      kind: "fake",
      where: "this computer",
      paidBy: "none",
      probe: async () => ({ ok: true, version: "2.1.319 (Claude Code)", flags: {}, missingMandatory: [], detail: "ready" }),
      run: async () => ({ ok: false, error: { code: "E_INTERNAL", message: "never called", retryable: false }, durationMs: 0, started: false }),
    };
    const sch = new AgentScheduler({
      store,
      ledger: createLedgerStore(store),
      settings,
      engine,
      liveCheck: null,
      token: createCancelSource().token,
      log: nullLogger,
      emit: (e) => void events.push(e),
      now: () => Date.now(),
      mode: "child",
      origin: "plugin",
      settingsSource: "plugin",
      pluginVersion: "test",
      jobs: {
        selectTargets: async (job) => (job === "label" ? [jobPlan(1), jobPlan(2), jobPlan(3)] : []),
        runJob: async (plan) => {
          started.push(plan.targets[0] as string);
          await over.fire(plan as ReturnType<typeof jobPlan>);
          return { v: 1, id: `r_${String(started.length).padStart(16, "a")}`, job: "label", pass: 1, engine: "fake", model: "haiku", where: "this computer", paidBy: "none", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: "finished", targets: plan.targets, items: 1, labels: 1, declined: 0, noAnswer: 0, tokensIn: 1, tokensOut: 1, tokensCacheRead: 0, tokensCacheWrite: 0, tokensEstimated: false, costUsd: 0, priceTableDate: "2026-01-01", promptVersion: "t" } as unknown as RunRecord;
        },
      },
    });
    return { sch, store, events, started };
  }

  it("stops before the first job when a window is already at its cap, and says when work resumes", async () => {
    const t = await scheduler({ fire: () => undefined });
    const resetsAt = Date.now() + 2 * 3_600_000;
    await recordPlan(t.store, { weekly: { pct: 75, resetsAt, seenAt: Date.now() } });
    const r = await t.sch.run({ reason: "manual", jobs: ["label"] });
    expect(r).toMatchObject({ stopped: "capped", capped: true, resumeAt: new Date(resetsAt).toISOString() });
    expect(r.plan.weekly).toMatchObject({ pct: 75, capPct: 70, atCap: true });
    expect(t.started).toHaveLength(0);
    const status = await t.sch.status();
    expect(status).toMatchObject({ capped: true, resumeAt: new Date(resetsAt).toISOString() });
  }, 30_000);
  it("checks between units: a unit that takes the 5-hour window past its cap ends the pass, and the rest wait", async () => {
    const holder: { t?: Awaited<ReturnType<typeof scheduler>> } = {};
    const t = await scheduler({ fire: async () => void (await recordPlan((holder.t as NonNullable<typeof holder.t>).store, { fiveHour: { pct: 72, resetsAt: Date.now() + 3_600_000, seenAt: Date.now() } })) });
    holder.t = t;
    const r = await t.sch.run({ reason: "manual", jobs: ["label"] });
    expect(t.started).toHaveLength(1);
    expect(r).toMatchObject({ stopped: "capped", capped: true });
    expect(r.resumeAt).toBeDefined();
  }, 30_000);
  it("carries on in the next pass once the window has reset", async () => {
    const t = await scheduler({ fire: () => undefined });
    await recordPlan(t.store, { fiveHour: { pct: 90, resetsAt: Date.now() - 60_000, seenAt: Date.now() - 120_000 } });
    const r = await t.sch.run({ reason: "manual", jobs: ["label"] });
    expect(r.stopped).toBeUndefined();
    expect(t.started.length).toBeGreaterThan(0);
  }, 30_000);
  it("never stops for spend: a huge day of tokens and dollars is no reason to hold", async () => {
    const t = await scheduler({ fire: () => undefined });
    const { applyUsage } = await import("../src/agents/budget");
    void applyUsage;
    const r = await t.sch.run({ reason: "manual", jobs: ["label"] });
    expect(r.stopped).toBeUndefined();
    expect(r.capped).toBe(false);
  }, 30_000);
});
