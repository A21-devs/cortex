/**
 * The runner's agent jobs place wiki notes by your wiki folders too (Settings › Sources, `wikiAreas`, read from each
 * request's settings): the area a note is offered under, the consent gate's verdict, the read a job logs and the Agents
 * page's pending groups all go by the area the figure shows. A temp vault; no real model is called.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Engine, EngineRequest } from "../src/agents/engine";
import { runJob, selectTargets, wikiNotes, type JobContext } from "../src/agents/jobs";
import { describePending } from "../src/agents/pendingGroups";
import { createCancelSource } from "../src/shared/cancel";
import { nullLogger } from "../src/shared/log";
import { DEFAULT_SETTINGS, type CortexSettings } from "../src/shared/settings";
import type { ConsentGrant } from "../src/shared/settingsExt";
import { spaceOfWikiPath, type WikiAreaRow } from "../src/shared/spaces";
import type { ReadRecord } from "../src/shared/types";
import { openStoreContext, type StoreContext } from "../src/store/layout";
import { createLedgerStore } from "../src/store/ledger";

const T0 = Date.parse("2026-11-01T10:00:00Z");
const NOTE = "wiki/notes/recipes/x.md";
/** Your row: notes/ and every folder inside it are Life. Without it the note's folders name no area, so it is Vault. */
const ROWS: WikiAreaRow[] = [{ folder: "notes", area: "life" }];

const dirs: string[] = [];
let vault = "";

beforeAll(() => {
  vault = mkdtempSync(path.join(tmpdir(), "cx-wa-v-"));
  dirs.push(vault);
  mkdirSync(path.join(vault, "wiki", "notes", "recipes"), { recursive: true });
  writeFileSync(path.join(vault, ...NOTE.split("/")), "---\ntitle: Bread\n---\nFlour, water, salt and a slow rise overnight.\n");
});

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A model stand-in: gives every wiki note id in the prompt a role, and records what it was sent. */
function standIn(sent: string[]): Engine {
  return {
    kind: "claude-cli",
    where: "remote",
    paidBy: "plan",
    probe: async () => ({ ok: true, flags: {}, missingMandatory: [], detail: "" }),
    run: async (req: EngineRequest) => {
      sent.push(req.prompt);
      const ids = [...new Set(req.prompt.match(/w_[a-z2-7]{16}/g) ?? [])];
      const output = { items: ids.map((id) => ({ target: id, fields: { "placement.role": { state: "set", value: "plan", confidence: 0.9 } } })) };
      return { ok: true, output, rawText: JSON.stringify(output), usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, estimated: false, models: ["claude-haiku"] }, durationMs: 1, modelUsed: "claude-haiku" };
    },
  } as unknown as Engine;
}

/**
 * One request on the same vault: its own settings, and its own cache folder and ledger, so nothing a job run writes
 * (labels, reads) is seen by another request, and the jobs' per-request cache is fresh.
 */
async function request(rows: readonly WikiAreaRow[], patch: (s: CortexSettings) => void = () => undefined) {
  const cacheDir = mkdtempSync(path.join(tmpdir(), "cx-wa-c-"));
  dirs.push(cacheDir);
  const store: StoreContext = await openStoreContext({ vaultRoot: vault, cacheDir, owner: "test", log: nullLogger });
  const settings: CortexSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.general.firstRunDone = true;
  settings.wikiAreas = rows.map((r) => ({ ...r }));
  patch(settings);
  const sent: string[] = [];
  const ledger = createLedgerStore(store);
  const ctx: JobContext = { engine: standIn(sent), ledger, store, settings, privacyRev: 0, token: createCancelSource().token, log: nullLogger, emit: () => undefined, now: () => T0 };
  return { ctx, ledger, sent };
}

/** "Require a grant" on, Life and Money open, and one live grant for `spaces`. */
const grantFor =
  (...spaces: string[]) =>
  (s: CortexSettings): void => {
    s.consent.requireGrant = true;
    s.consent.openSpaces = ["life", "money"];
    const g: ConsentGrant = { id: `g-${spaces.join("-")}`, purpose: "sort my notes", spaces, reader: "any-model", start: "2026-10-01", end: "2026-12-31", reads: 0, readLimit: 0, revoked: false };
    s.consent.grants = [g];
  };

describe("agent jobs read your wiki folders from the request's settings", () => {
  it("offer a wiki note under the area of your folder, the same one the figure gives it", async () => {
    const notes = await wikiNotes((await request(ROWS)).ctx);
    expect(notes.map((n) => [n.path, n.title, n.space])).toEqual([[NOTE, "Bread", "life"]]);
    expect(notes[0]?.space).toBe(spaceOfWikiPath(NOTE.slice("wiki/".length), ROWS));
    // Without the row, the same note is Vault: the area came from the settings.
    expect((await wikiNotes((await request([])).ctx)).map((n) => n.space)).toEqual(["vault"]);
  });

  it("the consent gate goes by that area: a grant for Life lets the note through, one for Money does not", async () => {
    expect((await wikiNotes((await request(ROWS, grantFor("life"))).ctx)).map((n) => n.path)).toEqual([NOTE]);
    expect(await wikiNotes((await request(ROWS, grantFor("money"))).ctx)).toEqual([]);
    // Without the row the note is Vault, which the Life grant does not name.
    expect(await wikiNotes((await request([], grantFor("life"))).ctx)).toEqual([]);
  });

  it("a label job under a Life grant reads the note and logs the read under that grant; under a Money grant it is not planned", async () => {
    // Each request has a ledger of its own, so the note is unlabelled for both: only the grant tells them apart.
    const money = await request(ROWS, grantFor("money"));
    expect(await selectTargets("label", money.ctx, 10)).toEqual([]);

    const r = await request(ROWS, grantFor("life"));
    const plans = await selectTargets("label", r.ctx, 10);
    const id = (await wikiNotes(r.ctx))[0]?.id;
    expect(id).toBeDefined();
    expect(plans.flatMap((p) => p.targets)).toEqual([id]);
    for (const p of plans) await runJob(p, r.ctx);
    expect(r.sent.join("\n")).toContain("a slow rise overnight");
    const reads: ReadRecord[] = [];
    for await (const x of r.ledger.readAll("reads")) reads.push(x);
    expect(reads.map((x) => [x.noteIds, x.grants])).toEqual([[[id], ["g-life"]]]);
    expect(money.sent).toEqual([]);
  });

  it("the Agents page's pending groups name the note's area", async () => {
    const r = await request(ROWS);
    const id = (await wikiNotes(r.ctx))[0]!.id;
    expect(await describePending({ label: [id] }, r.ctx)).toEqual([{ what: "wiki", where: "Life", n: 1 }]);
  });
});
