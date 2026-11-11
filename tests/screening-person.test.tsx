/**
 * Screening personal details: the privacy-filter hook, the settings, the read-only scan behind "Screened on this
 * computer", the optional local-model pass (proposals only) and the list's sample. Detector cases are in person-detail.test.ts.
 */
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { render } from "preact-render-to-string";
import { describe, expect, it } from "vitest";
import type { Engine, EngineRequest, EngineResult } from "../src/agents/engine";
import type { JobContext } from "../src/agents/jobs";
import { proposePersonDetails } from "../src/agents/localEngine";
import { policyFor, redact, textPolicy, WITHHELD_REPLY } from "../src/agents/privacy";
import { RuleEngine } from "../src/agents/ruleLabels";
import { scanScreened } from "../src/agents/screenScan";
import { createCancelSource } from "../src/shared/cancel";
import { conversationId, entryId } from "../src/shared/ids";
import { nullLogger } from "../src/shared/log";
import { allowedRow, PERSON_MARKERS, ScreenTally } from "../src/shared/personDetail";
import { DEFAULT_SETTINGS, migrateSettingsChecked, type CortexSettings } from "../src/shared/settings";
import type { ConversationRecord, EntryRecord } from "../src/shared/types";
import { openStoreContext } from "../src/store/layout";
import { createLedgerStore } from "../src/store/ledger";
import { LeafContext, ServicesContext } from "../src/ui/context";
import { SHEET_PAGES } from "../src/ui/pages";
import { sampleSummary } from "../src/ui/pages/agents/ScreenedList";
import { fakeServices } from "./helpers/fakeServices";

const clone = (): CortexSettings => JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as CortexSettings;
const CARD = "4111 1111 1111 1111";

describe("privacy filter: one call screens personal details", () => {
  it("is on by default and replaces a card number, an IBAN and a birth date before anything is sent", () => {
    const policy = policyFor("claude-code", clone());
    expect(policy.redactPerson).toBe(true);
    const r = redact(`card ${CARD}, send to GB82 WEST 1234 5698 7654 32, born on 12/03/1985.`, policy);
    expect(r.text).toBe(`card ${PERSON_MARKERS.card}, send to ${PERSON_MARKERS.bank}, born on ${PERSON_MARKERS.birth}.`);
    expect(r.redactions).toBe(3);
  });

  it("runs before the phone rule, so a card is one removal and not a phone number", () => {
    const r = redact(`pay ${CARD} now`, policyFor("claude-code", clone()));
    expect(r.text).toBe(`pay ${PERSON_MARKERS.card} now`);
    expect(r.redactions).toBe(1);
  });

  it("can be switched off, and then nothing else about redaction changes", () => {
    const s = clone();
    s.privacy.redact.personal = false;
    s.privacy.redact.phones = false;
    const p = policyFor("claude-code", s);
    expect(redact(`pay ${CARD} to a@b.co`, p).text).toBe(`pay ${CARD} to [email removed]`);
  });

  it("applies to every field that leaves, through the text policy too", () => {
    const p = textPolicy(clone());
    expect(redact("my SSN is 123-45-6789", p).text).toBe(`my SSN is ${PERSON_MARKERS.id}`);
  });

  it("honours the countries, the listed names and the values you kept", () => {
    const s = clone();
    s.privacy.screening.idCountries = ["es"];
    s.privacy.screening.names = ["Ada Lovelace", "address:Flat 4, Rose House"];
    s.privacy.screening.salt = "salt-1";
    s.privacy.screening.allowed = [allowedRow("card", CARD, "salt-1")];
    const p = policyFor("claude-code", s);
    const text = `DNI 12345678Z, Ada Lovelace lives at Flat 4, Rose House. Card ${CARD} and 5555 5555 5555 4444.`;
    const out = redact(text, p).text;
    expect(out).toContain(PERSON_MARKERS.id);
    expect(out).toContain(PERSON_MARKERS.name);
    expect(out).toContain(PERSON_MARKERS.address);
    expect(out).toContain(CARD); // kept as written
    expect(out).not.toContain("5555 5555");
  });

  it("leaves ordinary text and withheld replies alone", () => {
    const p = policyFor("claude-code", clone());
    expect(redact("The build passed in 4.2 seconds on 3 machines.", p)).toEqual({ text: "The build passed in 4.2 seconds on 3 machines.", redactions: 0 });
    expect(WITHHELD_REPLY).toContain("withheld");
  });
});

describe("settings", () => {
  it("old settings gain the new keys with safe defaults", () => {
    const m = migrateSettingsChecked({ version: 3, privacy: { redact: { secrets: true, emails: true, phones: true, custom: [] } } });
    expect(m.settings.privacy.redact.personal).toBe(true);
    expect(m.settings.privacy.screening).toEqual({ idCountries: [], names: [], allowed: [], salt: "", localNames: false });
    expect(m.corrupt).toBe(false);
  });

  it("a wrong type for the switch turns screening on, not off", () => {
    const m = migrateSettingsChecked({ version: 3, privacy: { redact: { personal: "no" } } });
    expect(m.settings.privacy.redact.personal).toBe(true);
  });
});

describe("ScreenTally", () => {
  it("counts per kind, one row per value, with the replacement shown and the value masked", () => {
    const t = new ScreenTally({ salt: "x", now: Date.UTC(2026, 5, 1) });
    t.add("e1", `Please charge ${CARD} for the room.`);
    t.add("e2", `Again ${CARD}, and my DOB: 12/03/1985.`);
    const s = t.summary(2, 2, false);
    expect(s.kinds).toEqual([
      { kind: "card", count: 2, values: 1 },
      { kind: "birth", count: 1, values: 1 },
    ]);
    const card = s.items.find((i) => i.kind === "card");
    expect(card).toMatchObject({ count: 2, entry: "e1", hint: "4111 •••• •••• 1111" });
    expect(card?.snippet).toBe(`Please charge ${PERSON_MARKERS.card} for the room.`);
    expect(JSON.stringify(s)).not.toContain(CARD);
    expect(JSON.stringify(s)).not.toContain("12/03/1985");
  });

  it("the sample the list shows in sample mode comes from the real detectors", () => {
    const s = sampleSummary();
    expect(s.kinds.map((k) => k.kind)).toEqual(["card", "bank", "id", "address", "birth"]);
    expect(s.items.every((i) => i.snippet.includes("[") && !/\d{4} \d{4} \d{4}/.test(i.snippet))).toBe(true);
  });
});

// ───────────────────────────── the scan over a temp vault ─────────────────────────────

const T0 = Date.parse("2026-11-01T10:00:00Z");

async function rig(patch?: (s: CortexSettings) => void) {
  const vault = await mkdtemp(path.join(os.tmpdir(), "cortex-scr-"));
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "cortex-scr-c-"));
  const store = await openStoreContext({ vaultRoot: vault, cacheDir, owner: "test", log: nullLogger });
  const ledger = createLedgerStore(store);
  const settings = clone();
  settings.privacy.screening.salt = "salt-1";
  patch?.(settings);
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
    now: () => T0 + 86_400_000,
    io: { readText: async (ref) => ({ ok: true, text: texts.get(JSON.stringify(ref)) ?? "" }), listWikiNotes: async () => [] },
  };
  return { ctx, ledger, texts, settings };
}

async function add(r: Awaited<ReturnType<typeof rig>>, n: number, source: "claude-code" | "chatgpt", lines: { speaker: "you" | "assistant"; text: string }[], extra: Partial<EntryRecord> = {}): Promise<void> {
  const id = conversationId(source, `c-${n}`);
  const at = new Date(T0 + n * 60_000).toISOString();
  const conv = { v: 1, id, seq: 1, source, nativeId: `c-${n}`, title: `Chat ${n}`, titledBy: "native", startedAt: at, endedAt: at, entryCount: lines.length, parts: [], space: "none", folder: [], updatedAt: at } as unknown as ConversationRecord;
  const entries = lines.map((l, i) => {
    const ref = { store: "stage", conv: id, line: i } as const;
    r.texts.set(JSON.stringify(ref), l.text);
    return { v: 1, id: entryId(source, `e-${n}-${i}`), kind: "message", source, sourceRef: { path: "x", sha256: "0" }, conv: id, idx: i, speaker: l.speaker, text: ref, textSha256: `sha-${n}-${i}`, chars: l.text.length, words: 5, dates: [], existedBy: at, addedAt: at, space: "none", folder: [], ...extra } as unknown as EntryRecord;
  });
  await r.ledger.append("conversations", [conv]);
  await r.ledger.append("entries", entries);
}

describe("scanScreened: what would be replaced, read-only", () => {
  it("counts per kind over the entries that may be sent and shows no original value", async () => {
    const r = await rig();
    await add(r, 1, "claude-code", [
      { speaker: "you", text: `My card is ${CARD} and I live at 221 Baker Street.` },
      { speaker: "assistant", text: "Noted, thanks." },
    ]);
    await add(r, 2, "claude-code", [{ speaker: "you", text: `Born on 12/03/1985. Card ${CARD} again.` }]);
    const s = await scanScreened(r.ctx, { now: () => T0 });
    expect(s.total).toBe(3);
    expect(s.scanned).toBe(3);
    expect(s.partial).toBe(false);
    expect(s.kinds).toEqual([
      { kind: "card", count: 2, values: 1 },
      { kind: "address", count: 1, values: 1 },
      { kind: "birth", count: 1, values: 1 },
    ]);
    expect(s.items.find((i) => i.kind === "card")).toMatchObject({ count: 2, hint: "4111 •••• •••• 1111" });
    expect(JSON.stringify(s)).not.toContain(CARD);
  });

  it("skips what is never sent: replies withheld per source and entries left out", async () => {
    const r = await rig();
    await add(r, 1, "chatgpt", [
      { speaker: "you", text: "Plain question about trains, nothing private in it." },
      { speaker: "assistant", text: `Your card ${CARD} was charged.` },
    ]);
    await add(r, 2, "claude-code", [{ speaker: "you", text: `The tool printed ${CARD}` }], { hiddenByDefault: "tool" });
    const s = await scanScreened(r.ctx);
    expect(s.items).toEqual([]);
    expect(s.total).toBe(1);
  });

  it("does not list a value you kept, and an empty record gives an empty list", async () => {
    const r = await rig((s) => void (s.privacy.screening.allowed = [allowedRow("card", CARD, "salt-1")]));
    await add(r, 1, "claude-code", [{ speaker: "you", text: `Card ${CARD} on file, SSN 123-45-6789.` }]);
    const s = await scanScreened(r.ctx);
    expect(s.kinds.map((k) => k.kind)).toEqual(["id"]);
    const empty = await rig();
    expect(await scanScreened(empty.ctx)).toMatchObject({ scanned: 0, total: 0, items: [], kinds: [] });
  });

  it("stops at its limits and says it did not look at everything", async () => {
    const r = await rig();
    for (let i = 1; i <= 5; i++) await add(r, i, "claude-code", [{ speaker: "you", text: `note ${i} card ${CARD}` }]);
    const s = await scanScreened(r.ctx, { maxEntries: 2 });
    expect(s).toMatchObject({ scanned: 2, total: 5, partial: true });
  });

  it("reports that screening is off when both the switch and the name list are off", async () => {
    const r = await rig((s) => void (s.privacy.redact.personal = false));
    expect((await scanScreened(r.ctx)).off).toBe(true);
  });

  it("proposals only appear with the local engine and the setting, are checked against the text and are never applied", async () => {
    const r = await rig((s) => {
      s.agents.engine = "local";
      s.privacy.screening.localNames = true;
    });
    await add(r, 1, "claude-code", [{ speaker: "you", text: "Emailed Priya Raman about the lease for the flat; she lives at 14 Orchard Walk, so send it there." }]);
    const seen: EngineRequest[] = [];
    const engine = fakeEngine("this computer", { names: ["Priya Raman", "Nobody Invented"], addresses: ["14 Orchard Walk"] }, seen);
    const s = await scanScreened(r.ctx, { proposeNames: true, engine });
    expect(s.proposals).toEqual([
      { kind: "name", text: "Priya Raman" },
      { kind: "address", text: "14 Orchard Walk" },
    ]);
    expect(seen).toHaveLength(1);
    expect(r.settings.privacy.screening.names).toEqual([]);
    // Off: the engine is never called.
    const off = await rig();
    await add(off, 1, "claude-code", [{ speaker: "you", text: "Emailed Priya Raman about the lease for the flat, she said it is fine." }]);
    const calls: EngineRequest[] = [];
    expect((await scanScreened(off.ctx, { proposeNames: true, engine: fakeEngine("this computer", { names: ["Priya Raman"], addresses: [] }, calls) })).proposals).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

function fakeEngine(where: "this computer" | "remote", output: unknown, seen: EngineRequest[]): Engine {
  return {
    kind: "local",
    where,
    paidBy: "none",
    probe: async () => ({ ok: true, flags: {}, missingMandatory: [], detail: "ready" }),
    run: async (req): Promise<EngineResult> => {
      seen.push(req);
      return { ok: true, output, rawText: "", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, estimated: true, models: [] }, durationMs: 1, modelUsed: "m" } as unknown as EngineResult;
    },
  };
}

describe("proposePersonDetails", () => {
  const ctl = new AbortController();
  it("refuses an engine that is not on this computer", async () => {
    const seen: EngineRequest[] = [];
    const out = await proposePersonDetails(fakeEngine("remote", { names: ["Priya Raman"], addresses: [] }, seen), ["Priya Raman wrote"], { model: "m", signal: ctl.signal });
    expect(out).toEqual([]);
    expect(seen).toHaveLength(0);
  });
  it("drops invented text, duplicates and what is already listed", async () => {
    const seen: EngineRequest[] = [];
    const eng = fakeEngine("this computer", { names: ["Priya Raman", "priya raman", "Sam Known", "Someone Else"], addresses: [] }, seen);
    const out = await proposePersonDetails(eng, ["Priya Raman met Sam Known."], { model: "m", signal: ctl.signal, known: new Set(["sam known"]) });
    expect(out).toEqual([{ kind: "name", text: "Priya Raman" }]);
    expect(seen[0]?.prompt).toContain("Priya Raman met Sam Known.");
  });
  it("a failed or malformed reply proposes nothing", async () => {
    const bad = { kind: "local", where: "this computer", paidBy: "none", probe: async () => ({ ok: true }), run: async () => ({ ok: false }) } as unknown as Engine;
    expect(await proposePersonDetails(bad, ["x y z"], { model: "m", signal: ctl.signal })).toEqual([]);
    expect(await proposePersonDetails(fakeEngine("this computer", "nonsense", []), ["x y z"], { model: "m", signal: ctl.signal })).toEqual([]);
  });
});

describe("the list on the pages", () => {
  const h = fakeServices();
  const wrap = (node: preact.ComponentChild) =>
    render(
      <ServicesContext.Provider value={h.services}>
        <LeafContext.Provider value={h.leaf}>{node}</LeafContext.Provider>
      </ServicesContext.Provider>,
    );
  it("is on Sources > Privacy and on Agents > Access log, with its introduction", () => {
    for (const [Page, params] of [
      [SHEET_PAGES.sources, { tab: "privacy" }],
      [SHEET_PAGES.agents, { tab: "access" }],
    ] as const) {
      const html = wrap(<Page params={params} />);
      expect(html).toContain("Screened on this computer");
      expect(html).toContain("the model sees the replacement, never the original".replace("the model", "The model"));
    }
  });
});
