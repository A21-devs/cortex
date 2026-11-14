/**
 * The agents organise the vault's notes outside wiki/: the documents the vault-notes importer writes are planned for the
 * label job, read through the consent gate like any entry, and given a role (the placement pack), so they count as
 * organised. An edited note's older entry, reference notes and anything left out are not sent. No real model is called:
 * a stand-in engine answers every note it was shown.
 */
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { runJob, selectTargets, type JobContext } from "../src/agents/jobs";
import type { Engine, EngineRequest } from "../src/agents/engine";
import { RuleEngine } from "../src/agents/ruleLabels";
import { createCancelSource } from "../src/shared/cancel";
import { entryId } from "../src/shared/ids";
import { nullLogger } from "../src/shared/log";
import { DEFAULT_SETTINGS, type CortexSettings } from "../src/shared/settings";
import type { EntryRecord, LabelRecord, ReadRecord } from "../src/shared/types";
import { openStoreContext } from "../src/store/layout";
import { createLedgerStore } from "../src/store/ledger";

const T0 = Date.parse("2026-11-01T10:00:00Z");
const tmp = () => mkdtemp(path.join(os.tmpdir(), "cortex-vault-notes-"));

/** A model stand-in: gives every entry id in the prompt the role "plan"; records what it was sent. */
function standIn(sent: string[]): Engine {
  return {
    kind: "claude-cli",
    where: "remote",
    paidBy: "plan",
    probe: async () => ({ ok: true, flags: {}, missingMandatory: [], detail: "" }),
    run: async (req: EngineRequest) => {
      sent.push(req.prompt);
      const ids = [...new Set(req.prompt.match(/e_[a-z2-7]{16}/g) ?? [])];
      const output = { items: ids.map((id) => ({ target: id, fields: { "placement.role": { state: "set", value: "plan", confidence: 0.9 } } })) };
      return { ok: true, output, rawText: JSON.stringify(output), usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, estimated: false, models: ["claude-haiku"] }, durationMs: 1, modelUsed: "claude-haiku" };
    },
  } as unknown as Engine;
}

async function rig(engine: Engine) {
  const vault = await tmp();
  const cacheDir = await tmp();
  const store = await openStoreContext({ vaultRoot: vault, cacheDir, owner: "test", log: nullLogger });
  const ledger = createLedgerStore(store);
  const settings: CortexSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.general.firstRunDone = true;
  const texts = new Map<string, string>();
  const ctx: JobContext = {
    engine,
    ledger,
    store,
    settings,
    privacyRev: 0,
    token: createCancelSource().token,
    log: nullLogger,
    emit: () => undefined,
    now: () => T0 + 86_400_000,
    io: {
      readText: async (ref) => ({ ok: true, text: texts.get(JSON.stringify(ref)) ?? "" }),
      listWikiNotes: async () => [],
    },
  };
  /** A vault note as the vault-notes importer writes it: a document entry with no conversation. */
  const note = async (n: number, title: string, body: string, extra: Partial<EntryRecord> = {}): Promise<EntryRecord> => {
    const ref = { store: "segment", seg: `.raw/chats/obsidian/2026-11/notes/000${n}.jsonl.gz`, line: 0 } as const;
    texts.set(JSON.stringify(ref), `---\ntags: [x]\n---\n${body}`);
    const at = new Date(T0 + n * 60_000).toISOString();
    const e = { v: 1, id: entryId("obsidian", `note:${title}`), kind: "document", source: "obsidian", sourceRef: { path: `Notes/${title}.md`, nativeId: `note:${title}`, sha256: `s${n}` }, speaker: "you", text: ref, textSha256: `s${n}`, chars: body.length, words: body.split(" ").length, dates: [], existedBy: at, addedAt: at, space: "vault", folder: ["Notes"], title, ...extra } as unknown as EntryRecord;
    await ledger.append("entries", [e]);
    return e;
  };
  return { ctx, ledger, settings, note };
}

describe("the agents organise the vault's notes outside wiki/", () => {
  it("plans the current notes, reads them through the gate, gives each a role, and does not plan them again", async () => {
    const sent: string[] = [];
    const r = await rig(standIn(sent));
    const garden = await r.note(1, "Garden plan", "Beds to dig in spring, what to plant where.");
    const first = await r.note(2, "Trip", "A first draft of the trip.");
    // The same file edited after its import: a new entry that names the old one. Only the new version is work.
    const edited = await r.note(3, "Trip v2", "The trip, planned day by day.", { supersedes: first.id } as Partial<EntryRecord>);
    // Reference material is not sent while "skip reference" is on (the default).
    await r.note(4, "Manual", "A vendor's manual.", { hiddenByDefault: "reference" } as Partial<EntryRecord>);

    const plans = await selectTargets("label", r.ctx, 10);
    const targets = plans.flatMap((p) => p.targets).sort();
    expect(targets).toEqual([garden.id, edited.id].sort());
    expect(plans.every((p) => p.job === "label" && p.model === "haiku")).toBe(true);

    for (const p of plans) await runJob(p, r.ctx);
    // Sent: the notes' text without frontmatter, never the old version or the reference note.
    const prompt = sent.join("\n");
    expect(prompt).toContain("Beds to dig in spring");
    expect(prompt).toContain("planned day by day");
    expect(prompt).not.toContain("first draft");
    expect(prompt).not.toContain("vendor's manual");
    expect(prompt).not.toContain("tags: [x]");

    const labels: LabelRecord[] = [];
    for await (const l of r.ledger.readAll("labels")) labels.push(l);
    expect(labels.filter((l) => l.pack === "placement" && l.field === "role" && l.value === "plan").map((l) => l.target).sort()).toEqual([garden.id, edited.id].sort());
    // Every read is in the access log.
    const reads: ReadRecord[] = [];
    for await (const x of r.ledger.readAll("reads")) reads.push(x);
    expect(reads.flatMap((x) => x.entryIds).sort()).toEqual([garden.id, edited.id].sort());

    // Organised: nothing is planned again until a note changes.
    expect(await selectTargets("label", r.ctx, 10)).toEqual([]);
  });

  it("leaves notes alone that the person left out (one note or a whole folder), and the rule organiser leaves them all", async () => {
    const r = await rig(standIn([]));
    const kept = await r.note(1, "Kept", "A note to organise.");
    const out = await r.note(2, "Private", "Left out by the person.");
    const diary = await r.note(3, "Diary", "Private thoughts.", { folder: ["Diary"] } as Partial<EntryRecord>);
    const at = new Date(T0).toISOString();
    await r.ledger.appendCorrections([
      { v: 1, id: "k_aaaaaaaaaaaaaaaa", at, via: "reader", action: "exclude", target: out.id, payload: { scope: "item" } },
      { v: 1, id: "k_bbbbbbbbbbbbbbbb", at, via: "reader", action: "exclude", target: diary.id, payload: { scope: "folder", folder: "Diary" } },
    ] as never);
    const targets = (await selectTargets("label", r.ctx, 10)).flatMap((p) => p.targets);
    expect(targets).toEqual([kept.id]);

    const rules = await rig(new RuleEngine() as unknown as Engine);
    await rules.note(1, "Kept", "A note to organise.");
    expect(await selectTargets("label", rules.ctx, 10)).toEqual([]);
  });
});
