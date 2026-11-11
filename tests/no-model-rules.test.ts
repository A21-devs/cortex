/**
 * No model: the rule-based organiser (agents/ruleLabels.ts) and its job in agents/jobs.ts. The rules read text on
 * this computer and write labels stamped engine "rule"; no model is involved and nothing is sent. Everything runs
 * in the OS temp folder with stubbed text reads.
 */
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { modelFor, runJob, selectTargets, type JobContext } from "../src/agents/jobs";
import { guessTalk, isRuleLabel, isRuleNote, rankTopics, RULE_JOBS, RuleEngine, ruleMapSpecs, ruleNoteFields, ruleProject, ruleRole, ruleSessionFields, statsOfBatch, termCounts } from "../src/agents/ruleLabels";
import { createCancelSource } from "../src/shared/cancel";
import { conversationId, entryId } from "../src/shared/ids";
import { nullLogger } from "../src/shared/log";
import { findPack, labelValueFits, SESSION_PACK } from "../src/shared/packs";
import { DEFAULT_SETTINGS, type CortexSettings } from "../src/shared/settings";
import type { ConversationRecord, EntryRecord, LabelRecord, NoteRecord } from "../src/shared/types";
import { applyFirstRunChoice } from "../src/ui/modals/FirstRunModal";
import { agreementView } from "../src/ui/modals/AgreementModal";
import { errorText } from "../src/ui/command/AskConsole";
import { labelsByPack } from "../src/ui/reader/entryContext";
import { labelChips } from "../src/ui/reader/readerKit";
import { openStoreContext } from "../src/store/layout";
import { createLedgerStore } from "../src/store/ledger";
import { readTermStats } from "../src/store/searchIndex";
import { encodeSearchIndex } from "../src/shared/searchCodec";
import { mkdir, writeFile } from "node:fs/promises";

const tmp = () => mkdtemp(path.join(os.tmpdir(), "cortex-rule-"));

describe("agents/ruleLabels: the pieces", () => {
  it("takes the project from the conversation, its working folder or its folder, never from a home folder", () => {
    expect(ruleProject({ project: "cortex", folder: [] })).toBe("cortex");
    expect(ruleProject({ folder: [], meta: { cwd: "C:\\Users\\sam\\source\\repos\\inventory-api" } })).toBe("inventory-api");
    expect(ruleProject({ folder: [], meta: { cwd: "/home/sam/code/notes-app/" } })).toBe("notes-app");
    expect(ruleProject({ folder: [], meta: { cwd: "C:\\Users\\sam" } })).toBeUndefined();
    expect(ruleProject({ folder: ["wiki", "garden"] })).toBe("garden");
    expect(ruleProject({ folder: [] })).toBeUndefined();
  });

  it("guesses a question, a plan or code from the opening words, and says nothing when unsure", () => {
    expect(guessTalk("Why is the sky blue", "Why does the sky look blue in the day and red at sunset?")).toMatchObject({ kind: "question", work: "research" });
    expect(guessTalk("Roadmap", "Let's plan the next three milestones and their order.")).toMatchObject({ kind: "plan", work: "plan" });
    expect(guessTalk("Crash", "```ts\nconst x = 1\n```\nThis throws an error and the build fails.")).toMatchObject({ kind: "code", work: "debug" });
    expect(guessTalk("Add a button", "Please implement a new function in the typescript module")).toMatchObject({ kind: "code", work: "build" });
    expect(guessTalk("Hello", "Good morning everyone")).toBeNull();
  });

  it("ranks words against how common they are across the record", () => {
    const here = termCounts("inventory inventory inventory trade trade note", new Map());
    const all = [new Set(["inventory", "trade"]), new Set(["inventory"]), new Set(["note"]), new Set(["note", "trade"]), new Set(["trade"]), new Set(["trade", "note"]), new Set(["note"]), new Set(["trade"]), new Set(["trade"]), new Set(["trade"])];
    const stats = statsOfBatch(all);
    // "note" is in 4 of 10 documents (too common), "trade" in 6 (too common), "inventory" in 2: the telling word.
    expect(rankTopics(here, stats, 5)).toEqual(["inventory"]);
    // With no counts at all (a tiny record) a word needs two mentions.
    expect(rankTopics(new Map([["alpha", 1], ["beta", 3]]), null)).toEqual(["beta"]);
  });

  it("drops ids, numbers and filler from topics", () => {
    const c = termCounts("12345 0a1b2c3d4e5f please thanks regression regression", new Map());
    expect([...c.keys()]).toEqual(["regression"]);
  });

  it("guesses a note's role from its folder and title only when it is clear", () => {
    expect(ruleRole("wiki/plans/Q4 roadmap.md", "Q4 roadmap")).toBe("plan");
    expect(ruleRole("wiki/daily/2026-11-03.md", "2026-11-03")).toBe("log");
    expect(ruleRole("wiki/concepts/Hot Cache.md", "Hot Cache")).toBeUndefined();
    expect(ruleNoteFields("wiki/_index.md", "Index")).toEqual([{ field: "role", value: "map" }]);
  });

  it("writes only values that fit the session pack", () => {
    const fields = ruleSessionFields({ title: "Fix the parser", project: "cortex", folder: [] }, "There is a bug and an error in the parser, please fix it", new Map([["parser", 4], ["tokens", 2]]), null);
    expect(fields.map((f) => f.field).sort()).toEqual(["project", "topics", "work"]);
    for (const f of fields) expect(labelValueFits(SESSION_PACK.fields.find((x) => x.key === f.field) ?? SESSION_PACK.fields[0]!, f.value)).toBe(true);
    // The rules never answer the outcome: nothing there for a model to contradict.
    expect(fields.some((f) => f.field === "outcome")).toBe(false);
  });

  it("lists one map per project with enough conversations, newest title first", () => {
    const items = [
      { id: "c1", title: "Fix the loader", project: "Cortex", at: 3 },
      { id: "c2", title: "Fix the loader", project: "cortex", at: 2 },
      { id: "c3", title: "Plan the tray", project: "cortex", at: 5 },
      { id: "c4", title: "One-off", project: "other", at: 1 },
    ];
    const maps = ruleMapSpecs(items);
    expect(maps).toHaveLength(1);
    expect(maps[0]).toMatchObject({ key: "cortex", title: "cortex", count: 3, titles: ["Plan the tray", "Fix the loader"] });
  });

  it("marks rule labels and notes, never a model's or yours", () => {
    const by = (engine: string) => ({ model: "x", runId: "r_a", engine }) as unknown as LabelRecord["by"];
    expect(isRuleLabel({ by: by("rule") })).toBe(true);
    expect(isRuleLabel({ by: by("claude-cli") })).toBe(false);
    expect(isRuleLabel({ by: { user: true, correctionId: "k_a" } as unknown as LabelRecord["by"] })).toBe(false);
    expect(isRuleNote({ madeBy: { runId: "r_a", model: "rule", engine: "rule", at: "2026-01-01T00:00:00Z" } })).toBe(true);
    expect(isRuleNote({ madeBy: { legacy: true } })).toBe(false);
    expect([...RULE_JOBS].sort()).toEqual(["hub", "label"]);
  });

  it("has an engine that never answers a call and costs nothing", async () => {
    const e = new RuleEngine();
    expect([e.kind, e.where, e.paidBy]).toEqual(["rule", "this computer", "none"]);
    expect((await e.probe()).ok).toBe(true);
    const r = await e.run({ signal: new AbortController().signal } as never);
    expect(r.ok).toBe(false);
  });

  it("names rule runs 'rule' and leaves other engines' models alone", () => {
    const s: CortexSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    expect(modelFor("label", s)).toBe("haiku");
    s.agents.engine = "none";
    expect(modelFor("hub", s)).toBe("rule");
    s.agents.engine = "codex-cli";
    expect(modelFor("label", s)).toBe("codex");
    s.agents.codex.model = "gpt-5-codex";
    expect(modelFor("label", s)).toBe("gpt-5-codex");
  });
});

describe("store/searchIndex: word counts for the rules", () => {
  it("reads how many documents hold each word from the shards on disk, and is null with no index", async () => {
    const cache = await tmp();
    expect(await readTermStats(cache, ["alpha"])).toBeNull();
    const dir = path.join(cache, "search");
    await mkdir(dir, { recursive: true });
    const buf = encodeSearchIndex(
      [
        { ordinal: 1, title: "alpha beta", body: "alpha gamma" },
        { ordinal: 2, title: "", body: "alpha delta" },
        { ordinal: 3, title: "", body: "gamma" },
      ] as never,
      { seq: 1, builtAt: "2026-01-01T00:00:00Z", epoch: "e", key: "live" } as never,
    );
    await writeFile(path.join(dir, "live.cxs"), Buffer.from(buf));
    const stats = await readTermStats(cache, ["alpha", "gamma", "zeta"]);
    expect(stats?.docs).toBe(3);
    expect([stats?.df("alpha"), stats?.df("gamma"), stats?.df("zeta")]).toEqual([2, 2, 0]);
  });
});

// ───────────────────────────── the job over a temp vault ─────────────────────────────

const T0 = Date.parse("2026-11-01T10:00:00Z");

interface Rig {
  ctx: JobContext;
  ledger: ReturnType<typeof createLedgerStore>;
  vault: string;
  settings: CortexSettings;
}

async function rig(engine: "none" | "claude-cli" = "none"): Promise<Rig> {
  const vault = await tmp();
  const cacheDir = await tmp();
  const store = await openStoreContext({ vaultRoot: vault, cacheDir, owner: "test", log: nullLogger });
  const ledger = createLedgerStore(store);
  const settings: CortexSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.general.firstRunDone = true;
  settings.agents.engine = engine;
  const texts = new Map<string, string>();
  const ctx: JobContext = {
    engine: new RuleEngine(),
    ledger,
    store,
    settings,
    privacyRev: 0,
    token: createCancelSource().token,
    log: nullLogger,
    emit: () => undefined,
    now: () => T0 + 3_600_000 * 24,
    io: {
      readText: async (ref) => ({ ok: true, text: texts.get(JSON.stringify(ref)) ?? "" }),
      listWikiNotes: async () => [],
    },
  };
  (ctx as { texts?: Map<string, string> }).texts = texts;
  return { ctx, ledger, vault, settings };
}

async function addConversation(r: Rig, n: number, title: string, project: string | undefined, lines: string[]): Promise<ConversationRecord> {
  const id = conversationId("claude-code", `conv-${n}`);
  const conv = { v: 1, id, seq: 1, source: "claude-code", nativeId: `conv-${n}`, title, titledBy: "native", startedAt: new Date(T0 + n * 60_000).toISOString(), endedAt: new Date(T0 + n * 60_000 + 30_000).toISOString(), entryCount: lines.length, parts: [], space: "none", folder: [], updatedAt: new Date(T0 + n * 60_000 + 30_000).toISOString(), ...(project ? { project } : {}) } as unknown as ConversationRecord;
  const texts = (r.ctx as unknown as { texts: Map<string, string> }).texts;
  const entries = lines.map((text, i) => {
    const text_ = { store: "stage", conv: id, line: i } as const;
    texts.set(JSON.stringify(text_), text);
    return { v: 1, id: entryId("claude-code", `e-${n}-${i}`), kind: "message", source: "claude-code", sourceRef: { path: "x", sha256: "0" }, conv: id, idx: i, speaker: i % 2 === 0 ? "you" : "assistant", text: text_, textSha256: `sha-${n}-${i}`, chars: text.length, words: text.split(" ").length, dates: [], existedBy: conv.updatedAt, addedAt: conv.updatedAt, space: "none", folder: [] } as unknown as EntryRecord;
  });
  await r.ledger.append("conversations", [conv]);
  await r.ledger.append("entries", entries);
  return conv;
}

describe("agents/jobs with No model", () => {
  it("labels a conversation with rules, stamps every label 'rule', writes a run record and sends nothing", async () => {
    const r = await rig();
    const conv = await addConversation(r, 1, "Locking inventory slots", "inventory-api", ["Why does the inventory slot lock fail while a trade is open?", "Because the lock is released before the trade confirms."]);
    const plans = await selectTargets("label", r.ctx, 10);
    expect(plans.map((p) => p.targets)).toEqual([[conv.id]]);
    expect(plans[0]?.model).toBe("rule");
    const rec = await runJob(plans[0]!, r.ctx);
    expect(rec).toMatchObject({ job: "label", engine: "rule", model: "rule", where: "this computer", paidBy: "none", status: "finished", costUsd: 0, tokensIn: 0 });
    const labels: LabelRecord[] = [];
    for await (const l of r.ledger.readAll("labels")) labels.push(l as LabelRecord);
    expect(labels.length).toBe(4);
    expect(labels.every((l) => isRuleLabel(l) && l.by && "model" in l.by && l.by.model === "rule")).toBe(true);
    const by = (f: string) => labels.find((l) => l.field === f);
    expect(by("project")).toMatchObject({ value: "inventory-api", state: "set", pack: "session" });
    expect(by("work")).toMatchObject({ value: "research", state: "set" });
    // The rules do not guess an outcome: a plain "no answer" waits for a model.
    expect(by("outcome")).toMatchObject({ value: null, state: "unanswered" });
    // No read was logged: nothing left this computer.
    const reads: unknown[] = [];
    for await (const x of r.ledger.readAll("reads")) reads.push(x);
    expect(reads).toEqual([]);
  });

  it("does not label the same conversation again, and a model run still counts it as waiting", async () => {
    const r = await rig();
    await addConversation(r, 1, "Plan the roadmap", "cortex", ["Let's plan the roadmap for the next quarter and its milestones."]);
    const first = await selectTargets("label", r.ctx, 10);
    await runJob(first[0]!, r.ctx);
    expect(await selectTargets("label", r.ctx, 10)).toEqual([]);
    // The same record seen by a model engine: the rule labels do not count as "already labelled".
    const model = await selectTargets("label", { ...r.ctx, engine: { kind: "claude-cli", where: "remote", paidBy: "plan", probe: async () => ({ ok: true, flags: {}, missingMandatory: [], detail: "" }), run: async () => ({ ok: false, error: { code: "E_INTERNAL", message: "", retryable: false }, durationMs: 0 }) } as never }, 10);
    expect(model).toHaveLength(1);
  });

  it("leaves a model's answer alone and writes where none exists", async () => {
    const r = await rig();
    const conv = await addConversation(r, 1, "Fix the parser", "cortex", ["There is a bug and an error in the parser, please fix it."]);
    const model: LabelRecord = { v: 1, id: "l_modelmodelmodel01" as never, target: conv.id, pack: "session", packVersion: "1.0.0", field: "project", value: "parser rewrite", state: "set", by: { model: "haiku", runId: "r_1" as never, engine: "claude-cli" }, at: new Date(T0).toISOString() };
    await r.ledger.append("labels", [model]);
    const plans = await selectTargets("label", r.ctx, 10);
    // A model labelled the session pack: the rules have no work here.
    expect(plans).toEqual([]);
  });

  it("writes a project map listing titles, once, marked as a rule map that a model map replaces", async () => {
    const r = await rig();
    for (let i = 1; i <= 3; i++) await addConversation(r, i, `Session ${i} on the loader`, "loader", [`Why does the loader fail on file ${i}?`]);
    const labelPlan = await selectTargets("label", r.ctx, 10);
    for (const p of labelPlan) await runJob(p, r.ctx);
    const plans = await selectTargets("hub", r.ctx, 10);
    expect(plans).toHaveLength(1);
    const rec = await runJob(plans[0]!, r.ctx);
    expect(rec).toMatchObject({ job: "hub", engine: "rule", status: "finished" });
    const notes: NoteRecord[] = [];
    for await (const n of r.ledger.readAll("notes")) notes.push(n as NoteRecord);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "hub", title: "loader", state: "current" });
    expect(isRuleNote(notes[0]!)).toBe(true);
    expect(notes[0]?.hub?.brief.map((b) => b.text)).toEqual(["Session 3 on the loader", "Session 2 on the loader", "Session 1 on the loader"]);
    // Nothing changed since: nothing is planned again.
    expect(await selectTargets("hub", r.ctx, 10)).toEqual([]);
  });

  it("never touches a map a model wrote", async () => {
    const r = await rig();
    for (let i = 1; i <= 3; i++) await addConversation(r, i, `Session ${i}`, "loader", [`Why does the loader fail on file ${i}?`]);
    for (const p of await selectTargets("label", r.ctx, 10)) await runJob(p, r.ctx);
    const [plan] = await selectTargets("hub", r.ctx, 10);
    await runJob(plan!, r.ctx);
    const written: NoteRecord[] = [];
    for await (const n of r.ledger.readAll("notes")) written.push(n as NoteRecord);
    const byModel: NoteRecord = { ...(written[0] as NoteRecord), seq: 2, madeBy: { runId: "r_m" as never, model: "opus", engine: "claude-cli", at: new Date(T0).toISOString() } };
    await r.ledger.append("notes", [byModel]);
    expect(await selectTargets("hub", r.ctx, 10)).toEqual([]);
  });
});

describe("first-run choice: No model and sealing", () => {
  const fresh = () => JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as CortexSettings;
  it("turns agents on with the engine 'none' and writes the sealing choice", () => {
    const s = fresh();
    applyFirstRunChoice("no-model", undefined, true)(s);
    expect([s.general.firstRunChoice, s.agents.enabled, s.agents.engine, s.advanced.dateSeals.sealLocally]).toEqual(["no-model", true, "none", true]);
    applyFirstRunChoice("no-model", undefined, false)(s);
    expect(s.advanced.dateSeals.sealLocally).toBe(false);
  });
  it("leaves No model again when a model is chosen, and leaves sealing alone when not asked", () => {
    const s = fresh();
    s.advanced.dateSeals.sealLocally = true;
    s.agents.engine = "none";
    applyFirstRunChoice("import-and-organise")(s);
    expect([s.agents.enabled, s.agents.engine, s.advanced.dateSeals.sealLocally]).toEqual([true, "claude-cli", true]);
    applyFirstRunChoice("import-only")(s);
    expect(s.agents.enabled).toBe(false);
  });
  it("says in plain words what No model is, in the agreement and in Ask", () => {
    const s = fresh();
    applyFirstRunChoice("no-model", undefined, true)(s);
    const v = agreementView(s);
    expect(v.choiceTitle).toBe("No model");
    expect(v.choiceBody).toMatch(/Nothing is sent to any model/);
    expect(errorText("missing", { settings: { value: s } } as never)).toMatch(/needs a model/);
    s.agents.engine = "codex-cli";
    expect(errorText("missing", { settings: { value: s } } as never)).toMatch(/Codex/);
  });
  it("marks a rule label as a rule chip in the reader and leaves a model's alone", () => {
    const lv = (engine: string, model: string) => ({ label: { v: 1, id: "l_a", target: "c_a", pack: "session", packVersion: "1.0.0", field: "work", value: "plan", state: "set", by: { model, runId: "r_a", engine }, at: "2026-11-01T00:00:00Z" }, byUser: false }) as never;
    expect(labelChips([lv("rule", "rule")])[0]).toMatchObject({ rule: true });
    expect(labelChips([lv("claude-cli", "haiku")])[0]).toMatchObject({ rule: false });
    const blocks = labelsByPack([lv("rule", "rule")], { inConversation: true }).blocks;
    expect(blocks.find((b) => b.pack.id === "session")?.rows.find((r) => r.field === "work")?.value).toMatchObject({ who: "rule", rule: true });
  });
  it("knows the packs the rules write to", () => {
    expect(findPack("session")?.writer).toBe("model");
  });
});
