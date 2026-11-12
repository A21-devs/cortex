/**
 * Directions out, outcomes and negative results: the entry shape, the no-record-text rule, the files on disk (temp
 * folders only), the importer (source "outcome") and the pieces of the page.
 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import { NEVER_CANCELLED } from "../src/shared/cancel";
import { nullLogger } from "../src/shared/log";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { SOURCE_ORDER } from "../src/shared/index-format";
import type { CortexSettings } from "../src/shared/settings";
import type { CorrectionRecord, EntryRecord } from "../src/shared/types";
import { SOURCE_KINDS } from "../src/shared/types";
import { acceptedDirections } from "../src/shared/directions";
import {
  directionsExportText,
  isOutcomePath,
  latestByDirection,
  negativeFileName,
  negativeNoteText,
  normaliseOutcome,
  outcomeFileText,
  outcomeMoment,
  outcomePath,
  parseOutcomeText,
  stripRecordIds,
  OUTCOME_RESULTS,
  type OutcomeInput,
} from "../src/shared/outcomes";
import { WrittenImporter } from "../src/importers/written";
import { knownIdsFromLedger, newTally, type ImportContext } from "../src/importers/common";
import { createNewEntryService } from "../src/plugin/newEntry";
import { listOutcomes, saveNegativeResult, saveOutcome } from "../src/plugin/outcomes";
import { createLedgerStore } from "../src/store/ledger";
import { openStoreContext } from "../src/store/layout";
import { readText } from "../src/store/segments";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { t } from "../src/ui/copy";
import { DirectionsOut, negativeNote, outboxRows, outboxText, resultLabel } from "../src/ui/pages/DirectionsOut";
import { entryKindLabel } from "../src/ui/reader/EntryReader";
import { valueLabel } from "../src/ui/valueLabels";
import { BUILT } from "../src/ui/pages/guide/recordModel";
import { fakeServices } from "./helpers/fakeServices";

const TODAY = "2026-11-12";
const CARD = "v_abcdefghijklmnop";
const PASSAGE_ID = "e_abcdefghijklmnop";

const good: OutcomeInput = { cardId: CARD, direction: "Try a smaller first step", result: "did-not-hold", tried: "Two evenings of the smaller step; the pattern did not repeat.", on: "2026-11-10", file: "results.csv" };

function accepted(id: string, text: string, at: string): CorrectionRecord {
  return { v: 1, id: `k_${id}`, at, action: "confirm", target: id, reason: `check:${id}:direction`, payload: { text } } as unknown as CorrectionRecord;
}

describe("outcomes: the entry shape", () => {
  it("knows the source, with its place at the end of the persisted order", () => {
    expect(SOURCE_KINDS).toContain("outcome");
    expect(SOURCE_ORDER.filter((s) => s === "outcome")).toHaveLength(1);
    expect(SOURCE_ORDER.indexOf("outcome")).toBeGreaterThan(SOURCE_ORDER.indexOf("zoom"));
    expect(valueLabel("outcome")).toBe("Outcome");
    expect(entryKindLabel({ kind: "document", source: "outcome" })).toBe(t("reader.kindOutcome"));
  });

  it("accepts held, did not hold and inconclusive, and refuses everything else", () => {
    for (const r of OUTCOME_RESULTS) expect(normaliseOutcome({ ...good, result: r }, TODAY)?.result).toBe(r);
    expect(normaliseOutcome({ ...good, result: "worked" }, TODAY)).toBeNull();
    expect(normaliseOutcome({ ...good, tried: "ok" }, TODAY)).toBeNull();
    expect(normaliseOutcome({ ...good, tried: "x".repeat(2001) }, TODAY)).toBeNull();
    expect(normaliseOutcome({ ...good, on: "2026-11-13" }, TODAY)).toBeNull();
    expect(normaliseOutcome({ ...good, on: "2026-02-30" }, TODAY)).toBeNull();
    expect(normaliseOutcome({ ...good, cardId: "has space" }, TODAY)).toBeNull();
    expect(normaliseOutcome({ ...good, direction: "see [[a note]] for <script>x</script>" }, TODAY)).toBeNull();
    expect(normaliseOutcome(null, TODAY)).toBeNull();
  });

  it("keeps only the name of the file, never a path", () => {
    expect(normaliseOutcome({ ...good, file: "C:\\Users\\me\\Documents\\results.csv" }, TODAY)?.file).toBe("results.csv");
    expect(normaliseOutcome({ ...good, file: "  " }, TODAY)?.file).toBeUndefined();
  });

  it("writes a file the importer and the list read back, linked to the direction", () => {
    const input = normaliseOutcome(good, TODAY) as OutcomeInput;
    const at = outcomeMoment(input.on, new Date(2026, 10, 12, 9, 0, 0));
    const rel = outcomePath(at, input.direction);
    expect(isOutcomePath(rel)).toBe(true);
    expect(rel).toMatch(/^\.raw\/written\/outcomes\/2026\/11\/20261110-\d{4}-try-a-smaller-first-step\.md$/);
    const text = outcomeFileText({ id: "e_aaaaaaaaaaaaaaaa", created: at, title: "Did not hold: Try a smaller first step", input });
    const o = parseOutcomeText(rel, text);
    expect(o).toMatchObject({ entryId: "e_aaaaaaaaaaaaaaaa", cardId: CARD, result: "did-not-hold", on: "2026-11-10", direction: "Try a smaller first step", file: "results.csv" });
    expect(o?.tried).toBe(good.tried);
    expect(parseOutcomeText(rel, "---\ncortex_id: e_x\n---\nplain")).toBeNull();
  });

  it("dates today's outcome now and an earlier one at midday of its day", () => {
    const now = new Date(2026, 10, 12, 15, 30, 0);
    expect(outcomeMoment("2026-11-12", now)).toBe(now);
    expect(outcomeMoment("2026-11-10", now).toISOString()).toBe("2026-11-10T12:00:00.000Z");
  });

  it("finds the newest outcome of each direction", () => {
    const mk = (cardId: string, on: string, result: "held" | "did-not-hold"): ReturnType<typeof parseOutcomeText> => ({ path: `p-${on}`, entryId: "e", cardId, result, on, direction: "d", tried: "t" });
    const m = latestByDirection([mk("a", "2026-01-01", "held"), mk("a", "2026-03-01", "did-not-hold"), mk("b", "2026-02-01", "held")] as never);
    expect(m.get("a")?.result).toBe("did-not-hold");
    expect(m.get("b")?.on).toBe("2026-02-01");
  });
});

describe("directions out: only sentences leave", () => {
  const recs = [accepted("v_aaaaaaaaaaaaaaaa", "Ask two people how they began", "2026-11-02T10:00:00.000Z"), accepted("v_bbbbbbbbbbbbbbbb", "Try a smaller first step", "2026-11-05T10:00:00.000Z")];

  it("lists accepted directions newest first, then exports the sentences and nothing else", () => {
    const list = acceptedDirections(recs);
    expect(list.map((d) => d.text)).toEqual(["Try a smaller first step", "Ask two people how they began"]);
    const md = outboxText(list, new Date(2026, 10, 12));
    expect(md).toContain("- Try a smaller first step");
    expect(md).toContain("- Ask two people how they began");
    expect(md).toContain(t("directions.outHead"));
    // No ids of any kind (the card ids are in the list objects, never in the text) and no dates of acceptance.
    expect(md).not.toMatch(/\b[a-z]_[a-z2-7]{16}\b/);
    expect(md).not.toContain("2026-11-02");
    expect(md.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2);
  });

  it("flattens a direction to one line and carries no record text from other fields", () => {
    const md = directionsExportText([{ text: "One\nline  only", at: "x", ...({ passage: "PRIVATE PASSAGE", from: [PASSAGE_ID] } as object) }], { head: "H", lead: "L", day: "D" });
    expect(md).toBe("# H\n\nL D\n\n- One line only\n");
    expect(md).not.toContain("PRIVATE");
    expect(md).not.toContain(PASSAGE_ID);
  });

  it("takes an id-shaped token a model left in a sentence out of the export", () => {
    const md = directionsExportText([{ text: "Revisit the plan from c_5e6fxlfodvkxlsvc this week", at: "x" }], { head: "H", lead: "L", day: "D" });
    expect(md).toBe("# H\n\nL D\n\n- Revisit the plan from this week\n");
  });

  it("builds the rows with each direction's newest outcome and whether its note was written", () => {
    const list = acceptedDirections(recs);
    const o = { path: "p", entryId: "e_aaaaaaaaaaaaaaaa", cardId: "v_bbbbbbbbbbbbbbbb", result: "did-not-hold" as const, on: "2026-11-10", direction: "Try a smaller first step", tried: "Two evenings." };
    const rows = outboxRows(list, [o], [negativeFileName("2026-11-10", "Try a smaller first step")]);
    expect(rows[0]).toMatchObject({ count: 1, public: true });
    expect(rows[0]?.latest?.result).toBe("did-not-hold");
    expect(rows[1]).toMatchObject({ latest: null, count: 0, public: false });
    expect(outboxRows(list, [o], [])[0]?.public).toBe(false);
  });
});

describe("negative results: record-free", () => {
  it("takes id shapes out and writes the direction, what was tried, the result and the date", () => {
    expect(stripRecordIds(`built on ${PASSAGE_ID} and c_abcdefghijklmnop today`)).not.toMatch(/[a-z]_[a-z2-7]{16}/);
    const note = negativeNote({ direction: `Try a smaller step ${PASSAGE_ID}`, tried: `Two evenings, see ${PASSAGE_ID}`, on: "2026-11-10" });
    expect(note).toContain("Try a smaller step");
    expect(note).toContain("2026-11-10");
    expect(note).toContain(t("directions.negResultText"));
    expect(note).not.toContain(PASSAGE_ID);
    expect(resultLabel("did-not-hold")).toBe(t("directions.resultDidNotHold"));
  });

  it("builds a stable file name", () => {
    expect(negativeFileName("2026-11-10", "Try a smaller first step")).toBe("20261110-try-a-smaller-first-step.md");
    expect(negativeNoteText({ direction: "d", tried: "t", on: "2026-11-10", result: "did-not-hold" }, { head: "H", direction: "D:", tried: "T", result: "R:", date: "Dt:", resultText: "no" })).toContain("# H");
  });
});

describe("outcomes on disk (temp folders)", () => {
  const tmp = (): Promise<string> => fsp.mkdtemp(path.join(os.tmpdir(), "cortex-lab-"));
  const now = new Date(2026, 10, 12, 14, 5, 7);

  async function deps(sandbox = false) {
    const vault = await tmp();
    const requests: unknown[] = [];
    return { vault, requests, d: { vaultRoot: vault, log: nullLogger, runner: { request: (async (c: unknown) => void requests.push(c)) as never }, sandbox: () => sandbox, now: () => now } };
  }

  it("saves an outcome as a dated file, asks for an import and lists it back", async () => {
    const { vault, requests, d } = await deps();
    const a = await saveOutcome(d, good, "Did not hold: Try a smaller first step");
    expect(a.path).toMatch(/^\.raw\/written\/outcomes\/2026\/11\/20261110-\d{4}-try-a-smaller-first-step\.md$/);
    expect(requests).toHaveLength(1);
    expect(await fsp.readFile(path.join(vault, ".raw", "written", ".gitignore"), "utf8")).toBe("*\n");
    const b = await saveOutcome(d, { ...good, result: "held" }, "Held: Try a smaller first step");
    expect(b.path).not.toBe(a.path);
    const list = await listOutcomes(d);
    expect(list.outcomes.map((o) => o.result).sort()).toEqual(["did-not-hold", "held"]);
    expect(list.outcomes[0]?.cardId).toBe(CARD);
    expect(list.negatives).toEqual([]);
  });

  it("refuses the sample record, a future date and an incomplete outcome", async () => {
    const sample = await deps(true);
    await expect(saveOutcome(sample.d, good, "t")).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    const live = await deps();
    await expect(saveOutcome(live.d, { ...good, on: "2026-11-13" }, "t")).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    await expect(saveOutcome(live.d, { ...good, tried: "" }, "t")).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    expect((await listOutcomes(live.d)).outcomes).toEqual([]);
  });

  it("writes the negative note and its fingerprint locally, once, and never with an id in it", async () => {
    const { vault, d } = await deps();
    const text = negativeNote({ direction: good.direction, tried: good.tried, on: good.on });
    const res = await saveNegativeResult(d, { on: good.on, direction: good.direction, text });
    expect(res.existed).toBe(false);
    expect(res.path).toBe(".vault-meta/cortex/negative-results/20261110-try-a-smaller-first-step.md");
    const file = await fsp.readFile(path.join(vault, ...res.path.split("/")), "utf8");
    expect(file).toBe(text);
    const { createHash } = await import("node:crypto");
    expect(res.fingerprint).toBe(createHash("sha256").update(file, "utf8").digest("hex"));
    expect(await fsp.readFile(path.join(vault, ...`${res.path}.sha256`.split("/")), "utf8")).toBe(`${res.fingerprint}  20261110-try-a-smaller-first-step.md\n`);
    expect((await saveNegativeResult(d, { on: good.on, direction: good.direction, text })).existed).toBe(true);
    expect((await listOutcomes(d)).negatives).toEqual(["20261110-try-a-smaller-first-step.md"]);
    await expect(saveNegativeResult(d, { on: good.on, direction: "another one", text: `built on ${PASSAGE_ID}` })).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    await expect(saveNegativeResult({ ...d, sandbox: () => true }, { on: good.on, direction: "x", text })).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    // Nothing from the negative folder is ever imported into the record.
    expect(isOutcomePath(res.path)).toBe(false);
  });

  it("comes back through the written importer as an entry of source 'outcome' at its own date", async () => {
    const vault = await tmp();
    const cache = await tmp();
    const store = await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
    const ledger = createLedgerStore(store);
    const ctx: ImportContext = {
      store,
      ledger,
      settings: structuredClone(DEFAULT_SETTINGS) as CortexSettings,
      mayContinue: async () => true,
      token: NEVER_CANCELLED,
      log: nullLogger,
      progress: () => undefined,
      yield: async () => undefined,
      now: () => Date.now() + 1000,
      tally: newTally(),
      knownEntryIds: (conv) => knownIdsFromLedger(ctx, conv),
    };
    const svc = createNewEntryService({ vaultRoot: vault, cacheDir: cache, log: nullLogger, runner: { request: (async () => undefined) as never }, sandbox: () => false, now: () => now });
    const w = await svc.save({ title: "A thought", body: "An ordinary entry." });
    const o = await svc.saveOutcome(good, "Did not hold: Try a smaller first step");
    expect((await svc.listOutcomes()).outcomes).toHaveLength(1);
    expect((await new WrittenImporter().run({ kind: "written" }, ctx)).entriesAdded).toBe(2);
    const all: EntryRecord[] = [];
    for await (const e of ledger.readAll("entries")) all.push(e as EntryRecord);
    const out = all.find((e) => e.id === o.entryId) as EntryRecord;
    expect(out).toMatchObject({ source: "outcome", speaker: "you", kind: "document", title: "Did not hold: Try a smaller first step", folder: ["Outcomes"] });
    expect(out.writtenAt).toBe(new Date("2026-11-10T12:00:00.000Z").toISOString());
    expect(all.find((e) => e.id === w.entryId)).toMatchObject({ source: "written" });
    const body = await readText(vault, out.text, out.textSha256);
    expect(body.ok && body.text).toBe(`${good.tried}\n`);
  });
});

describe("the page piece", () => {
  it("renders its title and the no-record-text promise, with its buttons off while nothing is accepted", () => {
    const h = fakeServices();
    const html = render(
      <ServicesContext.Provider value={h.services}>
        <LeafContext.Provider value={h.leaf}>
          <DirectionsOut />
        </LeafContext.Provider>
      </ServicesContext.Provider>,
    );
    expect(html).toContain(t("directions.outTitle"));
    expect(html).toContain("no passages from your record");
    expect(html).toMatch(/disabled[^>]*>[\s\S]*?Copy/);
  });

  it("flips the guide's Outcomes node to built", () => {
    expect(BUILT.outcomes).toBe(true);
  });
});
