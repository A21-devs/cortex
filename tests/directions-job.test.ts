/**
 * Direction trials, the job end to end (LAB-10): runJob over an in-memory ledger with a fake engine. Nothing is ever
 * sent to a model: the engine below records what it was given and answers from a script. Covers the three arms, what
 * the record arm may and may not send (left-out material, redaction, other people's words), the run record, the Checks
 * cards, the budget and the failure paths, plus the scheduler's planning and its refusal of an unusable request.
 */
import { describe, expect, it } from "vitest";
import type { Engine, EngineRequest, EngineResult } from "../src/agents/engine";
import { runJob, selectTargets, type JobContext, type JobPlan } from "../src/agents/jobs";
import { AgentScheduler, enqueueJobs } from "../src/agents/scheduler";
import { acceptedDirections } from "../src/shared/directions";
import { createCancelSource } from "../src/shared/cancel";
import { migrateSettingsChecked } from "../src/shared/settings";
import type { CorrectionRecord, DirectionArm, EntryRecord, ReadRecord, ReviewCardRecord, RunRecord } from "../src/shared/types";
import type { LedgerStore } from "../src/store/ledger";
import type { Logger } from "../src/shared/log";
import type { StoreContext } from "../src/store/layout";
import type { RunnerEvent } from "../src/shared/protocol/runner";

const E_LAB = "e_aaaaaaaaaaaaaaaa";
const E_BREAD = "e_aaaaaaaaaaaaaaab";
const E_ASSIST = "e_aaaaaaaaaaaaaaac";
const E_LEFT = "e_aaaaaaaaaaaaaaad";
const E_MAIL = "e_aaaaaaaaaaaaaaae";
const E_CHATGPT = "e_aaaaaaaaaaaaaaaf";

const TEXTS: Record<string, string> = {
  [E_LAB]: "I want my laboratory to run protein crystallisation screens by itself overnight.",
  [E_BREAD]: "Notes on sourdough hydration and how long the dough should rest.",
  [E_ASSIST]: "A laboratory could automate crystallisation with a liquid handler.",
  [E_LEFT]: "My private laboratory crystallisation results that must never be sent.",
  [E_MAIL]: "For the laboratory crystallisation project email me at bob@example.com about the plate reader.",
  [E_CHATGPT]: "ChatGPT laboratory crystallisation question that should be sent when its own words are mine.",
};

function entry(id: string, speaker: "you" | "assistant", source: EntryRecord["source"], n: number): EntryRecord {
  return {
    v: 1,
    id,
    speaker,
    source,
    kind: "message",
    space: "none",
    addedAt: `2026-04-0${n}T10:00:00.000Z`,
    writtenAt: `2026-04-0${n}T10:00:00.000Z`,
    text: { path: `.raw/x/${id}.jsonl`, start: 0, end: 1 },
    textSha256: `sha-${id}`,
    chars: TEXTS[id]?.length ?? 0,
    folder: [],
  } as unknown as EntryRecord;
}

const SILENT: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => SILENT };

interface Rig {
  ctx: JobContext;
  requests: EngineRequest[];
  ledger: { runs: RunRecord[]; reads: ReadRecord[]; review: ReviewCardRecord[] };
  reserved: number[];
  events: RunnerEvent[];
}

function rig(opts: { reply?: (req: EngineRequest, n: number) => EngineResult; cap?: boolean; corrections?: CorrectionRecord[]; withheldChatgpt?: boolean } = {}): Rig {
  const settings = migrateSettingsChecked(undefined).settings;
  // The record arm reads only spaces the owner opened; these entries sit in "No area".
  settings.consent.openSpaces = ["none"];
  const entries = [entry(E_LAB, "you", "claude-code", 1), entry(E_BREAD, "you", "claude-code", 2), entry(E_ASSIST, "assistant", "claude-code", 3), entry(E_LEFT, "you", "claude-code", 4), entry(E_MAIL, "you", "claude-code", 5), entry(E_CHATGPT, "you", "chatgpt", 6)];
  const corrections: CorrectionRecord[] = opts.corrections ?? [{ v: 1, id: "k_1", at: "2026-04-10T00:00:00.000Z", via: "reader", action: "exclude", target: E_LEFT, payload: { scope: "entry" } } as unknown as CorrectionRecord];
  const store = { runs: [] as RunRecord[], reads: [] as ReadRecord[], review: [] as ReviewCardRecord[] };
  let seq = 1;
  const ledger = {
    seq: async () => seq,
    readCorrections: async () => corrections,
    append: async (name: string, records: unknown[]) => {
      seq++;
      if (name === "runs") store.runs.push(...(records as RunRecord[]));
      if (name === "reads") store.reads.push(...(records as ReadRecord[]));
      if (name === "review") store.review.push(...(records as ReviewCardRecord[]));
      return seq;
    },
    async *readAll(name: string) {
      if (name === "entries") yield* entries;
      if (name === "runs") yield* store.runs;
      if (name === "review") yield* store.review;
    },
  } as unknown as LedgerStore;
  const requests: EngineRequest[] = [];
  const events: RunnerEvent[] = [];
  const reserved: number[] = [];
  const engine: Engine = {
    kind: "fake",
    where: "this computer",
    paidBy: "none",
    async probe() {
      return { ok: true, flags: {}, missingMandatory: [], detail: "fake" };
    },
    async run(req) {
      requests.push(req);
      if (opts.reply) return opts.reply(req, requests.length);
      return { ok: true, output: { directions: [{ text: "Prototype a small liquid-handling step for one screen", from: [E_LAB] }, { text: "Ask two labs how they schedule overnight runs" }, { text: "Write down the three failures you would most want to catch" }] }, rawText: "", usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, estimated: false, models: ["fake"] }, durationMs: 1, modelUsed: "fake-model" };
    },
  };
  if (opts.withheldChatgpt) settings.privacy.withholdAssistantFrom.chatgpt = true;
  const ctx: JobContext = {
    engine,
    ledger,
    store: { vaultRoot: "C:/vault", cacheDir: "C:/cache", owner: "test", log: SILENT, lockStaleMs: 60_000 } as StoreContext,
    settings,
    privacyRev: 0,
    token: createCancelSource().token,
    log: SILENT,
    emit: (e) => void events.push(e),
    io: {
      readText: async (_ref, sha) => ({ ok: true, text: TEXTS[sha.replace("sha-", "")] ?? "" }),
      readControl: async () => ({ v: 1, paused: false, privacyRev: 0, at: "2026-04-10T00:00:00.000Z" }),
      reserve: async (_id, estimate) => {
        reserved.push(estimate);
        return opts.cap ? { ok: false, reason: "capped" } : { ok: true };
      },
      settle: async () => ({}) as never,
    },
    now: () => Date.parse("2026-05-01T12:00:00.000Z"),
  };
  return { ctx, requests, ledger: store, reserved, events };
}

const PURPOSE = "run protein crystallisation screens in my laboratory overnight";

function plan(arm: DirectionArm, purpose = PURPOSE): JobPlan {
  return { job: "directions", targets: [`arm:${arm}`], model: "sonnet", estimateTokens: 5_000, priority: 0, experiment: { purpose, arm } };
}

describe("directions job: the record arm", () => {
  it("sends only your own relevant passages, masks private details, and logs what it read", async () => {
    const r = rig();
    const run = await runJob(plan("record"), r.ctx);
    expect(run.status).toBe("finished");
    expect(r.requests).toHaveLength(1);
    const sent = `${r.requests[0]?.system}\n${r.requests[0]?.prompt}`;
    expect(sent).toContain("protein crystallisation screens by itself");
    expect(sent).toContain("plate reader");
    expect(sent).not.toContain("bob@example.com");
    expect(sent).not.toContain("sourdough");
    expect(sent).not.toContain("liquid handler");
    expect(sent).not.toContain("must never be sent");
    const read = r.ledger.reads[0] as ReadRecord;
    expect([...read.entryIds].sort()).toEqual([E_CHATGPT, E_LAB, E_MAIL].sort());
    expect(read.redactions).toBeGreaterThan(0);
    expect(read.where).toBe("this computer");
    expect(read.promptVersion).toBe("directions@1.0.0");
  });
  it("keeps other people's replies local when the source's setting says so, and leaves out what you left out", async () => {
    const r = rig({ withheldChatgpt: true });
    await runJob(plan("record"), r.ctx);
    const sent = r.requests[0]?.prompt ?? "";
    // Your own lines from a source whose replies are kept local are still yours to send; the assistant's are never read at all.
    expect(sent).not.toContain("liquid handler");
    expect(sent).not.toContain("must never be sent");
  });
  it("records the run with its purpose, arm, passages and drafted directions, and queues one Checks card per direction", async () => {
    const r = rig();
    const run = await runJob(plan("record"), r.ctx);
    expect(run.job).toBe("directions");
    expect(run.model).toBe("fake-model");
    expect(run.experiment).toMatchObject({ purpose: PURPOSE, arm: "record", passages: 3 });
    expect(run.experiment?.directions).toHaveLength(3);
    expect(run.experiment?.directions[0]).toEqual({ text: "Prototype a small liquid-handling step for one screen", from: [E_LAB] });
    expect(run.labels).toBe(3);
    expect(r.ledger.review).toHaveLength(3);
    for (const c of r.ledger.review) {
      expect(c.kind).toBe("direction");
      expect(c.target).toBe(run.id);
      expect(c.runId).toBe(run.id);
      expect(c.proposal).toMatchObject({ kind: "direction", purpose: PURPOSE, arm: "record" });
    }
    expect(r.events.some((e) => e.kind === "review-cards" && e.count === 3)).toBe(true);
    // The running line and the finished line both carry the experiment, so the table shows the purpose while it runs.
    const lines = r.ledger.runs.filter((x) => x.id === run.id);
    expect(lines.map((x) => x.status)).toEqual(["running", "finished"]);
    expect(lines[0]?.experiment?.directions).toEqual([]);
  });
  it("reserves budget before the call and stops cleanly when the day is capped", async () => {
    const ok = rig();
    await runJob(plan("record"), ok.ctx);
    expect(ok.reserved).toHaveLength(1);
    const capped = rig({ cap: true });
    const run = await runJob(plan("record"), capped.ctx);
    expect(run.status).toBe("capped");
    expect(capped.requests).toHaveLength(0);
    expect(capped.ledger.review).toHaveLength(0);
  });
  it("asks nothing when no passage of yours matches the purpose", async () => {
    const r = rig();
    const run = await runJob(plan("record", "plan a trip to the northern lights"), r.ctx);
    expect(run.status).toBe("nothing tagged");
    expect(r.requests).toHaveLength(0);
    expect(run.experiment).toMatchObject({ arm: "record", passages: 0, directions: [] });
    expect(r.ledger.review).toHaveLength(0);
  });
});

describe("directions job: the placebo and nothing arms", () => {
  it("the placebo arm sends neutral bundled passages and no record text", async () => {
    const r = rig();
    const run = await runJob(plan("placebo"), r.ctx);
    expect(run.status).toBe("finished");
    const sent = r.requests[0]?.prompt ?? "";
    expect(sent).toContain('"kind":"passage"');
    for (const id of [E_LAB, E_BREAD, E_MAIL, E_CHATGPT]) expect(sent).not.toContain(TEXTS[id] as string);
    expect(sent).not.toContain("bob@example.com");
    expect(run.experiment?.passages).toBe(6);
    expect((r.ledger.reads[0] as ReadRecord).entryIds).toEqual([]);
    expect(run.targets).toEqual([]);
  });
  it("the nothing arm sends the purpose alone", async () => {
    const r = rig();
    const run = await runJob(plan("none"), r.ctx);
    expect(run.status).toBe("finished");
    const sent = r.requests[0]?.prompt ?? "";
    expect(sent).toContain(PURPOSE);
    expect(sent).not.toContain('"kind":"passage"');
    expect(run.experiment).toMatchObject({ arm: "none", passages: 0 });
    expect((r.ledger.reads[0] as ReadRecord).entryIds).toEqual([]);
  });
  it("a passage id named by the placebo arm is allowed, one that was never shown is dropped", async () => {
    const r = rig({
      reply: () => ({ ok: true, output: { directions: [{ text: "Try a first small measurement", from: ["p_tide", "e_zzzzzzzzzzzzzzzz"] }] }, rawText: "", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, estimated: false, models: [] }, durationMs: 1, modelUsed: "fake" }),
    });
    const run = await runJob(plan("placebo", "how to measure small things"), r.ctx);
    expect(run.experiment?.directions).toHaveLength(1);
    expect(run.experiment?.directions[0]?.from?.every((id) => /^p_/.test(id))).toBe(true);
  });
});

describe("directions job: bad replies and failures", () => {
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, estimated: false, models: [] };
  it("repairs a bad reply once, then uses the good one", async () => {
    const r = rig({ reply: (_req, n) => ({ ok: true, output: n === 1 ? { directions: [{ text: "ok" }] } : { directions: [{ text: "Write the first three steps down" }] }, rawText: "", usage, durationMs: 1, modelUsed: "fake" }) });
    const run = await runJob(plan("none"), r.ctx);
    expect(r.requests).toHaveLength(2);
    expect(r.requests[1]?.prompt).toContain("plain sentence");
    expect(run.status).toBe("finished");
    expect(run.experiment?.directions).toHaveLength(1);
  });
  it("fails the run, with its experiment, after two unusable replies and queues nothing", async () => {
    const r = rig({ reply: () => ({ ok: true, output: { directions: [{ text: "see [[a note]] now" }] }, rawText: "", usage, durationMs: 1, modelUsed: "fake" }) });
    const run = await runJob(plan("none"), r.ctx);
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("E_VALIDATION");
    expect(run.experiment).toMatchObject({ arm: "none", directions: [] });
    expect(r.ledger.review).toHaveLength(0);
  });
  it("reports an engine failure without drafting anything", async () => {
    const r = rig({ reply: () => ({ ok: false, error: { code: "E_ENGINE_FAILED", message: "the model call failed", retryable: true }, durationMs: 1 }) });
    const run = await runJob(plan("none"), r.ctx);
    expect(run.status).toBe("failed");
    expect(r.ledger.review).toHaveLength(0);
  });
  it("does nothing without an experiment", async () => {
    const r = rig();
    const run = await runJob({ ...plan("none"), experiment: undefined }, r.ctx);
    expect(r.requests).toHaveLength(0);
    expect(run.status).toBe("finished");
    expect(run.items).toBe(0);
  });
});

describe("directions job: planning and the scheduler", () => {
  it("plans one run per chosen arm, in order, only for a named trial", async () => {
    const r = rig();
    const named = { ...r.ctx, trigger: { reason: "manual" as const, jobs: ["directions" as const], experiment: { purpose: PURPOSE, arms: ["none", "record"] as DirectionArm[] } } };
    const plans = await selectTargets("directions", named, 10);
    expect(plans.map((p) => p.experiment?.arm)).toEqual(["record", "none"]);
    expect(plans.every((p) => p.job === "directions" && p.estimateTokens > 0)).toBe(true);
    expect(plans[0]?.estimateTokens).toBeGreaterThan(plans[1]?.estimateTokens ?? 0);
    expect(await selectTargets("directions", r.ctx, 10)).toEqual([]);
    expect(await selectTargets("directions", { ...named, trigger: { ...named.trigger, experiment: { purpose: "no", arms: ["none"] as DirectionArm[] } } }, 10)).toEqual([]);
  });
  it("the queue never holds a trial", async () => {
    await expect(enqueueJobs({ vaultRoot: "C:/vault", cacheDir: "C:/cache", owner: "t", log: SILENT, lockStaleMs: 60_000 } as StoreContext, { jobs: ["directions"], targets: ["c_aaaaaaaaaaaaaaaa"], reason: "manual" })).rejects.toThrow(/unknown job/);
  });
  it("refuses a trial without a usable purpose or arm before anything is planned", async () => {
    const r = rig();
    const sch = new AgentScheduler({
      store: r.ctx.store,
      ledger: r.ctx.ledger,
      settings: r.ctx.settings,
      engine: r.ctx.engine,
      liveCheck: null,
      token: r.ctx.token,
      log: SILENT,
      emit: () => undefined,
      now: () => Date.now(),
      mode: "child",
      origin: "plugin",
      settingsSource: "plugin",
      pluginVersion: "test",
    });
    r.ctx.settings.general.firstRunDone = true;
    await expect(sch.run({ reason: "manual", jobs: ["directions"] })).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    await expect(sch.run({ reason: "manual", jobs: ["directions"], experiment: { purpose: "tiny", arms: ["none"] } })).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    await expect(sch.run({ reason: "manual", jobs: ["directions"], experiment: { purpose: "a proper purpose", arms: [] } })).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
  });
});

describe("directions job: what you accepted is readable from the corrections log", () => {
  it("round-trips through the check tag the corrections service writes", () => {
    const rec = { v: 1, id: "k_9", at: "2026-05-09T10:00:00.000Z", via: "checks", action: "confirm", target: "v_card", payload: { text: "Prototype one screen" }, reason: "check:v_card:confirm:accepted" } as unknown as CorrectionRecord;
    expect(acceptedDirections([rec])).toEqual([{ cardId: "v_card", text: "Prototype one screen", at: "2026-05-09T10:00:00.000Z" }]);
  });
});
