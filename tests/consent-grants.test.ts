/**
 * consent-grants: the rules (shared/consent.ts), the read gate (agents/grants.ts), the job and export paths that obey
 * them, the settings that hold them, and the entries that record a change. Nothing is ever sent to a model: the fake
 * engine below records what it was given.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Engine, EngineRequest, EngineResult } from "../src/agents/engine";
import { noGrantReason, openGate, ReadGate, tallyReads, emptyTally, countRead } from "../src/agents/grants";
import { runJob, type JobContext, type JobPlan } from "../src/agents/jobs";
import { sha256Text } from "../src/node/hash";
import { consentEntry } from "../src/ui/consentEntry";
import { atLimit, diffSpaces, effectiveOpenSpaces, expandSpaces, grantCovers, grantState, inList, isOpenPlace, itemLimit, liveGrants, makeGrant, readerMatches, readerOfEngine, readsSince, resetItem, revokeGrant } from "../src/shared/consent";
import { createCancelSource } from "../src/shared/cancel";
import { migrateSettingsChecked, type CortexSettings } from "../src/shared/settings";
import type { ConsentGrant } from "../src/shared/settingsExt";
import type { EntryRecord, ReadRecord } from "../src/shared/types";
import { newUserSpace, type UserSpace } from "../src/shared/userSpaces";
import { exportRecord } from "../src/store/exportRecord";
import { openStoreContext } from "../src/store/layout";
import { createLedgerStore } from "../src/store/ledger";
import type { LedgerStore } from "../src/store/ledger";
import type { StoreContext } from "../src/store/layout";
import { nullLogger } from "../src/shared/log";
import { verifierStrings } from "../src/plugin/verifierStrings";
import { closeFolder, grantChoices, isLocalRoute, openFolder, openNames, openNothing, setAreaOpen, setUserSpaceOpen, spaceLabel, whoLines } from "../src/plugin/settingsSections/privacySection";
import { COPY } from "../src/ui/copy";

const settingsOf = (patch: (s: CortexSettings) => void = () => undefined): CortexSettings => {
  const s = migrateSettingsChecked(undefined).settings;
  patch(s);
  return s;
};
const grant = (over: Partial<ConsentGrant> = {}): ConsentGrant => ({ id: "g-1", purpose: "tidy notes", spaces: ["code"], reader: "any-model", start: "2026-05-01", end: "2026-05-31", reads: 0, readLimit: 0, revoked: false, ...over });
const here = (space: string, folder: string[] = []) => ({ space, folder });

describe("open spaces", () => {
  it("everything starts closed", () => {
    const s = settingsOf();
    expect(s.consent.openSpaces).toEqual([]);
    expect(effectiveOpenSpaces(s.consent, s.userSpaces)).toEqual([]);
    expect(isOpenPlace(here("code"), s.consent, s.userSpaces)).toBe(false);
  });

  it("an area, a folder and a space of your own can each be opened, and a folder opens what is under it", () => {
    const s = settingsOf((x) => {
      const sp = newUserSpace(x.userSpaces, "Garden");
      sp.areas = ["life"];
      sp.folders = ["kb/plants"];
      x.userSpaces.push(sp);
      setAreaOpen(x, "code", true);
      openFolder(x, "kb/money/");
      setUserSpaceOpen(x, sp.id, true);
    });
    const open = (space: string, folder: string[] = []): boolean => isOpenPlace(here(space, folder), s.consent, s.userSpaces);
    expect(open("code")).toBe(true);
    expect(open("money", ["kb", "money", "bank"])).toBe(true);
    expect(open("money", ["kb", "moneyx"])).toBe(false);
    expect(open("life")).toBe(true);
    expect(open("design", ["kb", "plants", "x"])).toBe(true);
    expect(open("games")).toBe(false);
  });

  it("closing and Open nothing put everything back", () => {
    const s = settingsOf((x) => {
      const sp = newUserSpace(x.userSpaces, "Garden");
      sp.areas = ["life"];
      x.userSpaces.push(sp);
      setAreaOpen(x, "code", true);
      openFolder(x, "kb/money");
      setUserSpaceOpen(x, sp.id, true);
      closeFolder(x, "kb/money");
      setAreaOpen(x, "code", false);
    });
    expect(s.consent.openSpaces).toEqual([]);
    expect(openNames(s)).toEqual(["Garden"]);
    openNothing(s);
    expect(openNames(s)).toEqual([]);
    expect(s.userSpaces.every((u) => !u.open)).toBe(true);
  });

  it("a damaged open flag reads as closed", () => {
    const m = migrateSettingsChecked({ userSpaces: [{ id: "g", name: "G", areas: ["life"], folders: [], open: "yes" }] });
    expect(m.settings.userSpaces[0]?.open).toBe(false);
  });

  it("names a user space's members so a grant can name the space", () => {
    const sp: UserSpace = { id: "garden", name: "Garden", areas: ["life"], folders: ["kb/plants/"], open: false };
    expect(expandSpaces(["garden", "code", "kb/x/"], [sp])).toEqual(["life", "kb/plants", "code", "kb/x"]);
    expect(inList(here("life"), ["life"])).toBe(true);
    expect(inList(here("life"), [])).toBe(false);
  });

  it("lists what has changed between two lists", () => {
    expect(diffSpaces(["a", "b"], ["b", "c"])).toEqual({ opened: ["c"], closed: ["a"] });
  });

  it("the grant form offers only what is open", () => {
    const s = settingsOf((x) => {
      setAreaOpen(x, "code", true);
      openFolder(x, "kb/money");
    });
    expect(grantChoices(s).map((c) => c.id)).toEqual(["code", "kb/money"]);
    expect(spaceLabel(s, "code")).toBe("Code");
    expect(spaceLabel(s, "kb/money")).toBe("kb/money");
  });
});

describe("grants", () => {
  it("a grant is in force only between its days, while not revoked and while it has reads left", () => {
    const g = grant({ readLimit: 5 });
    expect(grantState(g, "2026-04-30", 0)).toBe("upcoming");
    expect(grantState(g, "2026-05-01", 0)).toBe("live");
    expect(grantState(g, "2026-05-31", 4)).toBe("live");
    expect(grantState(g, "2026-05-31", 5)).toBe("used-up");
    expect(grantState(g, "2026-06-01", 0)).toBe("expired");
    expect(grantState({ ...g, revoked: true }, "2026-05-10", 0)).toBe("revoked");
    expect(grantState(grant(), "2026-05-10", 99999)).toBe("live");
  });

  it("matches the reader: any model, one model, or an export", () => {
    expect(readerMatches("any-model", "claude-cli")).toBe(true);
    expect(readerMatches("any-model", "local")).toBe(true);
    expect(readerMatches("any-model", "export")).toBe(false);
    expect(readerMatches("claude-cli", "claude-cli")).toBe(true);
    expect(readerMatches("claude-cli", "codex-cli")).toBe(false);
    expect(readerMatches("export", "export")).toBe(true);
    expect(readerMatches("export", "claude-cli")).toBe(false);
    expect(readerMatches("anyone", "claude-cli")).toBe(false);
    expect(readerOfEngine("rule")).toBeNull();
    expect(readerOfEngine("codex-cli")).toBe("codex-cli");
  });

  it("covers an item only when the grant names its space and the space is open", () => {
    const s = settingsOf((x) => setAreaOpen(x, "code", true));
    expect(grantCovers(grant(), here("code"), s.consent, s.userSpaces)).toBe(true);
    expect(grantCovers(grant({ spaces: ["money"] }), here("code"), s.consent, s.userSpaces)).toBe(false);
    // named but closed
    expect(grantCovers(grant({ spaces: ["money"] }), here("money"), s.consent, s.userSpaces)).toBe(false);
  });

  it("lists the live grants for a reader", () => {
    const s = settingsOf((x) => {
      x.consent.grants = [grant(), grant({ id: "g-2", reader: "export" }), grant({ id: "g-3", revoked: true }), grant({ id: "g-4", end: "2026-05-02" })];
    });
    expect(liveGrants(s.consent, "claude-cli", "2026-05-10").map((g) => g.id)).toEqual(["g-1"]);
    expect(liveGrants(s.consent, "export", "2026-05-10").map((g) => g.id)).toEqual(["g-2"]);
    expect(liveGrants(s.consent, "claude-cli", "2026-06-10")).toEqual([]);
  });

  it("makeGrant builds a grant over open spaces and refuses the rest", () => {
    const s = settingsOf((x) => {
      setAreaOpen(x, "code", true);
      openFolder(x, "kb/money");
    });
    const open = effectiveOpenSpaces(s.consent, s.userSpaces);
    const ok = makeGrant({ purpose: "  tidy   my notes ", spaces: ["code", "kb/money/bank"], reader: "claude-cli", start: "2026-05-30", days: 3, readLimit: 20.4 }, [], open, s.userSpaces);
    expect(ok).toMatchObject({ ok: true, grant: { purpose: "tidy my notes", end: "2026-06-01", readLimit: 20, revoked: false, reads: 0, id: "g-20260530-1" } });
    const draft = { purpose: "tidy", spaces: ["code"], reader: "any-model", start: "2026-05-01", days: 7, readLimit: 0 };
    expect(makeGrant({ ...draft, purpose: "x" }, [], open, s.userSpaces)).toEqual({ ok: false, problem: "purpose" });
    expect(makeGrant({ ...draft, spaces: [] }, [], open, s.userSpaces)).toEqual({ ok: false, problem: "spaces" });
    expect(makeGrant({ ...draft, spaces: ["money"] }, [], open, s.userSpaces)).toEqual({ ok: false, problem: "closed" });
    expect(makeGrant({ ...draft, reader: "everyone" }, [], open, s.userSpaces)).toEqual({ ok: false, problem: "reader" });
    expect(makeGrant({ ...draft, days: 0 }, [], open, s.userSpaces)).toEqual({ ok: false, problem: "days" });
    expect(makeGrant({ ...draft, days: 400 }, [], open, s.userSpaces)).toEqual({ ok: false, problem: "days" });
    expect(makeGrant({ ...draft, start: "May 1" }, [], open, s.userSpaces)).toEqual({ ok: false, problem: "start" });
    // ids are never reused
    const again = makeGrant(draft, [grant({ id: "g-20260501-1" })], open, s.userSpaces);
    expect(again.ok && again.grant.id).toBe("g-20260501-2");
  });

  it("revoking keeps the grant listed and stops it", () => {
    const s = settingsOf((x) => void (x.consent.grants = [grant()]));
    expect(revokeGrant(s.consent, "g-1")).toBe(true);
    expect(revokeGrant(s.consent, "g-1")).toBe(false);
    expect(revokeGrant(s.consent, "nope")).toBe(false);
    expect(s.consent.grants).toHaveLength(1);
    expect(liveGrants(s.consent, "claude-cli", "2026-05-10")).toEqual([]);
  });

  it("grants survive a settings round trip, and a grant with a damaged flag counts as revoked", () => {
    const s = settingsOf((x) => void (x.consent.grants = [grant(), grant({ id: "g-2" })]));
    const back = migrateSettingsChecked(JSON.parse(JSON.stringify(s)));
    expect(back.settings.consent.grants).toHaveLength(2);
    expect(back.settings.consent.grants[0]?.revoked).toBe(false);
  });
});

describe("the read limit", () => {
  it("counts reads since an item's reset", () => {
    const at = ["2026-05-01T10:00:00.000Z", "2026-05-02T10:00:00.000Z", "2026-05-03T10:00:00.000Z"];
    expect(readsSince(at, undefined)).toBe(3);
    expect(readsSince(at, "2026-05-02T10:00:00.000Z")).toBe(1);
    expect(atLimit(3, 3)).toBe(true);
    expect(atLimit(2, 3)).toBe(false);
    expect(atLimit(99, null)).toBe(false);
  });

  it("is off until the owner turns it on", () => {
    const s = settingsOf();
    expect(itemLimit(s.consent)).toBeNull();
    s.consent.itemReadLimit = { enabled: true, max: 3 };
    expect(itemLimit(s.consent)).toBe(3);
  });

  it("a reset is stored per item, kept in order and bounded, and a damaged one is dropped", () => {
    const s = settingsOf();
    resetItem(s.consent, "e_aaaaaaaaaaaaaaaa", "2026-05-02T00:00:00.000Z");
    expect(s.consent.readResets).toEqual({ e_aaaaaaaaaaaaaaaa: "2026-05-02T00:00:00.000Z" });
    const back = migrateSettingsChecked(JSON.parse(JSON.stringify(s)));
    expect(back.settings.consent.readResets).toEqual({ e_aaaaaaaaaaaaaaaa: "2026-05-02T00:00:00.000Z" });
    const bad = migrateSettingsChecked({ consent: { readResets: { e_aaaaaaaaaaaaaaaa: 5, nonsense: "2026-05-02T00:00:00.000Z", e_bbbbbbbbbbbbbbbb: "2026-05-03T00:00:00.000Z" } } });
    expect(bad.settings.consent.readResets).toEqual({ e_bbbbbbbbbbbbbbbb: "2026-05-03T00:00:00.000Z" });
    const many = settingsOf();
    for (let i = 0; i < 1100; i++) resetItem(many.consent, `e_${String(i).padStart(16, "a")}`, `2026-05-02T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`);
    expect(Object.keys(many.consent.readResets ?? {})).toHaveLength(1000);
  });
});

describe("counting reads", () => {
  const rec = (over: Partial<ReadRecord> = {}): Pick<ReadRecord, "entryIds" | "noteIds" | "grants" | "at"> => ({ entryIds: ["e_a" as never], noteIds: [], grants: [], at: "2026-05-02T10:00:00.000Z", ...over });

  it("counts items per entry and per grant, skipping reads before a reset", async () => {
    async function* log(): AsyncIterable<unknown> {
      yield rec({ grants: ["g-1"] });
      yield rec({ grants: ["g-1"], entryIds: ["e_a" as never, "e_b" as never], at: "2026-05-03T10:00:00.000Z" });
      yield "junk";
      yield { at: 5 };
      yield rec({ at: "2026-05-04T10:00:00.000Z" });
    }
    const all = await tallyReads(log());
    expect(all.entries.get("e_a")).toBe(3);
    expect(all.entries.get("e_b")).toBe(1);
    expect(all.grants.get("g-1")).toBe(3);
    const reset = await tallyReads(log(), { e_a: "2026-05-03T10:00:00.000Z" });
    expect(reset.entries.get("e_a")).toBe(1);
    expect(reset.entries.get("e_b")).toBe(1);
  });

  it("an empty log counts nothing", () => {
    const t = emptyTally();
    countRead(t, { entryIds: [], noteIds: [], at: "2026-05-02T10:00:00.000Z" });
    expect(t.entries.size).toBe(0);
  });
});

const NOW = Date.parse("2026-05-10T12:00:00");
function gate(over: { patch?: (s: CortexSettings) => void; reader?: Parameters<typeof readerOfEngine>[0]; tally?: (t: ReturnType<typeof emptyTally>) => void } = {}): ReadGate {
  const s = settingsOf((x) => {
    x.consent.requireGrant = true;
    setAreaOpen(x, "code", true);
    x.consent.grants = [grant()];
    over.patch?.(x);
  });
  const tally = emptyTally();
  over.tally?.(tally);
  return new ReadGate({ consent: s.consent, userSpaces: s.userSpaces, reader: readerOfEngine(over.reader ?? "claude-cli"), today: "2026-05-10", tally });
}
const item = (id: string, space = "code") => ({ id, space, folder: [] as string[] });

describe("the read gate: refusal outside a grant", () => {
  it("lets an item through under a live grant and names the grant", () => {
    expect(gate().take(item("e_1"))).toEqual({ ok: true, grant: "g-1" });
  });

  it("refuses every item when no grant exists", () => {
    const g = gate({ patch: (x) => void (x.consent.grants = []) });
    expect(g.check(item("e_1"))).toEqual({ ok: false, why: "no-grant" });
  });

  it("refuses an item in a space the grant does not name", () => {
    expect(gate().check(item("e_1", "money"))).toEqual({ ok: false, why: "no-grant" });
  });

  it("refuses an item whose space is named but closed", () => {
    const g = gate({ patch: (x) => void (x.consent.grants = [grant({ spaces: ["money"] })]) });
    expect(g.check(item("e_1", "money"))).toEqual({ ok: false, why: "no-grant" });
  });

  it("refuses a reader the grant does not name", () => {
    expect(gate({ patch: (x) => void (x.consent.grants = [grant({ reader: "local" })]) }).check(item("e_1"))).toEqual({ ok: false, why: "no-grant" });
    expect(gate({ patch: (x) => void (x.consent.grants = [grant({ reader: "claude-cli" })]) }).check(item("e_1")).ok).toBe(true);
  });

  it("refuses once the grant has ended, and before it starts, and after it is revoked", () => {
    for (const g of [grant({ end: "2026-05-09" }), grant({ start: "2026-05-11" }), grant({ revoked: true })]) {
      expect(gate({ patch: (x) => void (x.consent.grants = [g]) }).check(item("e_1"))).toEqual({ ok: false, why: "no-grant" });
    }
  });

  it("an expired grant stops reads on the day after its end, not before", () => {
    const base = settingsOf((x) => {
      x.consent.requireGrant = true;
      setAreaOpen(x, "code", true);
      x.consent.grants = [grant({ end: "2026-05-10" })];
    });
    const at = (today: string) => new ReadGate({ consent: base.consent, userSpaces: [], reader: "claude-cli", today, tally: emptyTally() }).check(item("e_1")).ok;
    expect(at("2026-05-10")).toBe(true);
    expect(at("2026-05-11")).toBe(false);
  });

  it("stops at the grant's own read limit, counting what this run already took", () => {
    const g = gate({ patch: (x) => void (x.consent.grants = [grant({ readLimit: 2 })]) });
    expect(g.take(item("e_1")).ok).toBe(true);
    expect(g.take(item("e_2")).ok).toBe(true);
    expect(g.take(item("e_3"))).toEqual({ ok: false, why: "grant-used-up" });
    // reads already in the log count too
    const g2 = gate({ patch: (x) => void (x.consent.grants = [grant({ readLimit: 2 })]), tally: (t) => t.grants.set("g-1", 2) });
    expect(g2.check(item("e_1"))).toEqual({ ok: false, why: "grant-used-up" });
  });

  it("another live grant takes over when the first has no reads left", () => {
    const g = gate({ patch: (x) => void (x.consent.grants = [grant({ readLimit: 1 }), grant({ id: "g-2" })]) });
    expect(g.take(item("e_1"))).toEqual({ ok: true, grant: "g-1" });
    expect(g.take(item("e_2"))).toEqual({ ok: true, grant: "g-2" });
    expect(g.grantsFor(["e_1", "e_2", "e_9"])).toEqual(["g-1", "g-2"]);
  });

  it("the plain-rules engine is never gated", () => {
    const g = gate({ reader: "rule", patch: (x) => void (x.consent.grants = []) });
    expect(g.active).toBe(false);
    expect(g.check(item("e_1")).ok).toBe(true);
  });

  it("is silent when nothing is required and no limit is set", () => {
    const g = gate({ patch: (x) => void (x.consent.requireGrant = false) });
    expect(g.active).toBe(false);
    expect(g.check(item("e_1")).ok).toBe(true);
  });

  it("refuses a call that reads items nobody took from the gate", () => {
    const g = gate();
    const found = (id: string) => (id === "n_note" ? item("n_note") : undefined);
    expect(g.assertRead(["e_unknown"], found)).toEqual({ ok: false, why: "no-grant" });
    g.take(item("e_1"));
    expect(g.assertRead(["e_1"], found).ok).toBe(true);
    // a note that sits in a covered space is taken at the call
    expect(g.assertRead(["n_note"], found).ok).toBe(true);
    // and one in a space nothing covers is refused
    expect(gate().assertRead(["n_note"], () => item("n_note", "money"))).toEqual({ ok: false, why: "no-grant" });
  });

  it("noGrantReason says when a pass cannot start", () => {
    const none = settingsOf((x) => void (x.consent.requireGrant = true));
    expect(noGrantReason(none.consent, "claude-cli", "2026-05-10")).toBe("no-grant");
    expect(noGrantReason(none.consent, null, "2026-05-10")).toBeNull();
    const off = settingsOf();
    expect(noGrantReason(off.consent, "claude-cli", "2026-05-10")).toBeNull();
    const some = settingsOf((x) => {
      x.consent.requireGrant = true;
      x.consent.grants = [grant()];
    });
    expect(noGrantReason(some.consent, "claude-cli", "2026-05-10")).toBeNull();
    expect(noGrantReason(some.consent, "claude-cli", "2026-07-01")).toBe("no-grant");
    expect(noGrantReason(some.consent, "export", "2026-05-10")).toBe("no-grant");
  });
});

describe("the read gate: limit exclusion", () => {
  const limited = (max: number, tally: (t: ReturnType<typeof emptyTally>) => void, extra: (s: CortexSettings) => void = () => undefined): ReadGate =>
    gate({
      patch: (x) => {
        x.consent.requireGrant = false;
        x.consent.itemReadLimit = { enabled: true, max };
        extra(x);
      },
      tally,
    });

  it("leaves out an item that was read as often as allowed, and keeps the rest", () => {
    const g = limited(3, (t) => void t.entries.set("e_1", 3).set("e_2", 2));
    expect(g.check(item("e_1"))).toEqual({ ok: false, why: "limit" });
    expect(g.check(item("e_2")).ok).toBe(true);
    expect(g.check(item("e_3")).ok).toBe(true);
  });

  it("counts a read taken in this run before it reaches the log", () => {
    const g = limited(2, () => undefined);
    expect(g.take(item("e_1")).ok).toBe(true);
    expect(g.take(item("e_1")).ok).toBe(true);
    expect(g.take(item("e_1"))).toEqual({ ok: false, why: "limit" });
  });

  it("applies without a grant requirement, and without a limit nothing is left out", () => {
    expect(limited(1, (t) => void t.entries.set("e_1", 1)).check(item("e_1")).ok).toBe(false);
    const off = gate({ patch: (x) => void (x.consent.requireGrant = false), tally: (t) => void t.entries.set("e_1", 50) });
    expect(off.check(item("e_1")).ok).toBe(true);
  });

  it("an owner's reset lets the item back in, because only later reads count", async () => {
    async function* log(): AsyncIterable<unknown> {
      for (const d of ["01", "02", "03"]) yield { entryIds: ["e_1"], noteIds: [], grants: [], at: `2026-05-${d}T10:00:00.000Z` };
    }
    const s = settingsOf((x) => void (x.consent.itemReadLimit = { enabled: true, max: 3 }));
    const before = await openGate({ consent: s.consent, userSpaces: [], reader: "claude-cli", now: NOW, records: log });
    expect(before.check(item("e_1"))).toEqual({ ok: false, why: "limit" });
    resetItem(s.consent, "e_1", "2026-05-03T11:00:00.000Z");
    const after = await openGate({ consent: s.consent, userSpaces: [], reader: "claude-cli", now: NOW, records: log });
    expect(after.check(item("e_1")).ok).toBe(true);
  });

  it("after a logged call, the gate counts it once", () => {
    const g = limited(2, () => undefined);
    g.take(item("e_1"));
    g.logged({ entryIds: ["e_1" as never], noteIds: [], at: "2026-05-10T12:00:00.000Z" });
    expect(g.check(item("e_1")).ok).toBe(true);
    g.take(item("e_1"));
    g.logged({ entryIds: ["e_1" as never], noteIds: [], at: "2026-05-10T12:01:00.000Z" });
    expect(g.check(item("e_1"))).toEqual({ ok: false, why: "limit" });
  });
});

// ───────────────────────────── the job path ─────────────────────────────

const SILENT = nullLogger;
const E_A = "e_aaaaaaaaaaaaaaaa";
const E_B = "e_aaaaaaaaaaaaaaab";
const TEXTS: Record<string, string> = {
  [E_A]: "I want my laboratory to run protein crystallisation screens by itself overnight.",
  [E_B]: "More notes on the laboratory crystallisation plate reader and the overnight schedule.",
};

function entryRec(id: string, n: number, space: string): EntryRecord {
  return { v: 1, id, speaker: "you", source: "claude-code", kind: "message", space, addedAt: `2026-04-0${n}T10:00:00.000Z`, writtenAt: `2026-04-0${n}T10:00:00.000Z`, text: { path: `.raw/x/${id}.jsonl`, start: 0, end: 1 }, textSha256: `sha-${id}`, chars: TEXTS[id]?.length ?? 0, folder: [] } as unknown as EntryRecord;
}

function rig(patch: (s: CortexSettings) => void, spaces: [string, string] = ["code", "money"], logged: ReadRecord[] = []) {
  const settings = migrateSettingsChecked(undefined).settings;
  patch(settings);
  const entries = [entryRec(E_A, 1, spaces[0]), entryRec(E_B, 2, spaces[1])];
  const reads: ReadRecord[] = [...logged];
  const requests: EngineRequest[] = [];
  const ledger = {
    seq: async () => 1,
    readCorrections: async () => [],
    append: async (name: string, records: unknown[]) => {
      if (name === "reads") reads.push(...(records as ReadRecord[]));
      return 1;
    },
    async *readAll(name: string) {
      if (name === "entries") yield* entries;
      if (name === "reads") yield* reads;
    },
  } as unknown as LedgerStore;
  const engine: Engine = {
    kind: "fake",
    where: "this computer",
    paidBy: "none",
    async probe() {
      return { ok: true, flags: {}, missingMandatory: [], detail: "fake" };
    },
    async run(req): Promise<EngineResult> {
      requests.push(req);
      return { ok: true, output: { directions: [{ text: "Prototype a small liquid-handling step for one screen", from: [E_A] }] }, rawText: "", usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, estimated: false, models: ["fake"] }, durationMs: 1, modelUsed: "fake-model" };
    },
  };
  const ctx = (): JobContext => ({
    engine,
    ledger,
    store: { vaultRoot: "C:/vault", cacheDir: "C:/cache", owner: "test", log: SILENT, lockStaleMs: 60_000 } as unknown as StoreContext,
    settings,
    privacyRev: 0,
    token: createCancelSource().token,
    log: SILENT,
    emit: () => undefined,
    io: {
      readText: async (_ref, sha) => ({ ok: true, text: TEXTS[sha.replace("sha-", "")] ?? "" }),
      readControl: async () => ({ v: 1, paused: false, privacyRev: 0, at: "2026-04-10T00:00:00.000Z" }),
      reserve: async () => ({ ok: true }),
      settle: async () => ({}) as never,
    },
    now: () => NOW,
  });
  return { ctx, requests, reads, settings };
}
const PURPOSE = "run protein crystallisation screens in my laboratory overnight";
const plan = (): JobPlan => ({ job: "directions", targets: ["arm:record"], model: "sonnet", estimateTokens: 5_000, priority: 0, experiment: { purpose: PURPOSE, arm: "record" } });
const sentText = (r: { requests: EngineRequest[] }): string => r.requests.map((q) => q.prompt).join("\n");

describe("jobs obey open spaces", () => {
  it("the record arm sends nothing while every space is closed", async () => {
    const r = rig(() => undefined);
    const run = await runJob(plan(), r.ctx());
    expect(run.status).toBe("nothing tagged");
    expect(r.requests).toHaveLength(0);
    expect(r.reads).toHaveLength(0);
  });

  it("sends only what is in an open space", async () => {
    const r = rig((s) => setAreaOpen(s, "code", true));
    const run = await runJob(plan(), r.ctx());
    expect(run.status).toBe("finished");
    const sent = sentText(r);
    expect(sent).toContain("protein crystallisation screens by itself");
    expect(sent).not.toContain("plate reader");
  });
});

describe("jobs obey grants", () => {
  const required = (...extra: ((s: CortexSettings) => void)[]) => (s: CortexSettings) => {
    s.consent.requireGrant = true;
    setAreaOpen(s, "code", true);
    setAreaOpen(s, "money", true);
    for (const e of extra) e(s);
  };

  it("reads nothing without a live grant", async () => {
    const r = rig(required());
    const run = await runJob(plan(), r.ctx());
    expect(run.status).toBe("nothing tagged");
    expect(r.requests).toHaveLength(0);
    expect(r.reads).toHaveLength(0);
  });

  it("reads what a live grant covers, logs the grant, and nothing outside it", async () => {
    const r = rig(required((s) => void (s.consent.grants = [grant({ id: "g-ok", spaces: ["code"], start: "2026-05-01", end: "2026-05-31" })])));
    const run = await runJob(plan(), r.ctx());
    expect(run.status).toBe("finished");
    expect(sentText(r)).toContain("protein crystallisation screens by itself");
    expect(sentText(r)).not.toContain("plate reader");
    expect(r.reads).toHaveLength(1);
    expect(r.reads[0]?.entryIds).toEqual([E_A]);
    expect(r.reads[0]?.grants).toEqual(["g-ok"]);
  });

  it("reads nothing once the grant has ended or is revoked", async () => {
    for (const g of [grant({ spaces: ["code"], end: "2026-05-09" }), grant({ spaces: ["code"], revoked: true })]) {
      const r = rig(required((s) => void (s.consent.grants = [g])));
      await runJob(plan(), r.ctx());
      expect(r.requests).toHaveLength(0);
    }
  });

  it("stops at the grant's read limit across runs, because the log counts what the first run read", async () => {
    const r = rig(required((s) => void (s.consent.grants = [grant({ id: "g-one", spaces: ["code", "money"], readLimit: 1 })])));
    await runJob(plan(), r.ctx());
    expect(r.reads).toHaveLength(1);
    expect(r.reads[0]?.entryIds).toHaveLength(1);
    const before = r.requests.length;
    await runJob(plan(), r.ctx());
    expect(r.requests).toHaveLength(before);
  });
});

describe("jobs obey the read limit", () => {
  it("leaves an item out once it was read as often as allowed, and lets it back after a reset", async () => {
    const prior: ReadRecord[] = [1, 2].map((n) => ({ v: 1, runId: "r_x", model: "m", engine: "fake", where: "this computer", entryIds: [E_A], noteIds: [], policy: "", chars: 1, redactions: 0, withheld: 0, via: "job", origin: "plugin", at: `2026-05-0${n}T10:00:00.000Z` }) as unknown as ReadRecord);
    const open = (s: CortexSettings): void => {
      setAreaOpen(s, "code", true);
      s.consent.itemReadLimit = { enabled: true, max: 2 };
    };
    const a = rig(open, ["code", "code"], prior);
    await runJob(plan(), a.ctx());
    expect(sentText(a)).not.toContain("protein crystallisation screens by itself");
    expect(sentText(a)).toContain("plate reader");

    const b = rig((s) => {
      open(s);
      resetItem(s.consent, E_A, "2026-05-05T00:00:00.000Z");
    }, ["code", "code"], prior);
    await runJob(plan(), b.ctx());
    expect(sentText(b)).toContain("protein crystallisation screens by itself");
  });
});

// ───────────────────────────── exports ─────────────────────────────

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("exports obey grants", () => {
  async function world() {
    const vault = mkdtempSync(path.join(tmpdir(), "cx-cg-v-"));
    const cache = mkdtempSync(path.join(tmpdir(), "cx-cg-c-"));
    dirs.push(vault, cache);
    mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
    mkdirSync(path.join(vault, ".raw/docs"), { recursive: true });
    const ctx = await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
    const ledger = createLedgerStore(ctx);
    const recs: EntryRecord[] = [];
    for (const [n, space] of [[1, "code"], [2, "code"], [3, "code"], [4, "money"]] as const) {
      const text = `entry ${n} in ${space}`;
      writeFileSync(path.join(vault, `.raw/docs/e${n}.md`), text);
      const iso = new Date(Date.UTC(2026, 3, n, 10)).toISOString();
      recs.push({ v: 1, id: `e_${"a".repeat(15)}${"bcdef"[n]}`, kind: "message", source: "claude-code", sourceRef: { path: `x${n}`, nativeId: `n${n}`, sha256: sha256Text(text) }, conv: "c_aaaaaaaaaaaaaaaa", idx: n, speaker: "you", text: { store: "file", path: `.raw/docs/e${n}.md`, byteStart: 0, byteEnd: Buffer.byteLength(text) }, textSha256: sha256Text(text), chars: text.length, words: 3, dates: [], existedBy: iso, addedAt: iso, writtenAt: iso, space, folder: [] } as unknown as EntryRecord);
    }
    await ledger.append("entries", recs);
    return { ctx, ledger };
  }
  const out = (): string => path.join(mkdtempSync(path.join(tmpdir(), "cx-cg-o-")), "x.zip");

  it("only entries inside the grant's spaces go in, even where more is open", async () => {
    const w = await world();
    const r = await exportRecord(w.ctx, w.ledger, out(), verifierStrings(), { openSpaces: ["code", "money"], within: ["code"] });
    expect(r.entries).toBe(3);
    expect(r.skippedClosed).toBe(1);
  });

  it("a space the grant names but that is not open stays out", async () => {
    const w = await world();
    const r = await exportRecord(w.ctx, w.ledger, out(), verifierStrings(), { openSpaces: ["code"], within: ["code", "money"] });
    expect(r.entries).toBe(3);
  });

  it("stops at the grant's remaining reads", async () => {
    const w = await world();
    const r = await exportRecord(w.ctx, w.ledger, out(), verifierStrings(), { openSpaces: ["code"], within: ["code"], maxEntries: 2 });
    expect(r.entries).toBe(2);
  });

  it("the runner refuses an export without a grant when one is required, and counts the grant used", async () => {
    const { createHandlers } = await import("../src/runner/commands");
    const w = await world();
    const mk = (settings: CortexSettings) => ({ ctx: { vaultRoot: w.ctx.vaultRoot, vaultKey: "k", cacheDir: w.ctx.cacheDir, settings, pluginVersion: "9", settingsSource: "plugin" }, host: { log: nullLogger, event: () => undefined }, id: "r1", cancel: createCancelSource().token, token: createCancelSource().token, event: () => undefined }) as never;
    const h = createHandlers();
    const args = { out: out(), strings: verifierStrings(), areas: [], includeClosed: true, openSpaces: [] as string[] };
    const needs = settingsOf((x) => void (x.consent.requireGrant = true));
    await expect(h["export.record"](args, mk(needs))).rejects.toMatchObject({ code: "E_PAUSED", detail: { reason: "no-grant" } });
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const allowed = settingsOf((x) => {
      x.consent.requireGrant = true;
      setAreaOpen(x, "code", true);
      x.consent.grants = [grant({ id: "g-exp", reader: "export", spaces: ["code"], start: "2000-01-01", end: "2999-12-31" })];
    });
    void day;
    const done = await h["export.record"]({ ...args, out: out() }, mk(allowed));
    expect(done).toMatchObject({ entries: 3, grant: "g-exp" });
  });
});

// ───────────────────────────── the summary and the record ─────────────────────────────

describe("Who can read this", () => {
  const facts = { path: "C:/vault", sample: false, readers: [{ model: "claude-haiku", route: "claude-cli", itemsRead: 41, last: "2026-05-09T10:00:00.000Z" }], leftAt: { at: "2026-05-09T10:00:00.000Z", route: "claude-cli" } };

  it("says where the record is, whether it is encrypted, who read it, who holds a key, grants, open spaces and the last time anything left", () => {
    const s = settingsOf((x) => {
      x.record.encryption.enabled = true;
      x.record.shares.holders = [{ name: "A", contact: "", share: 1, instructions: "", checksum: "", namedAt: "" }];
      x.consent.requireGrant = true;
      x.consent.grants = [grant()];
      setAreaOpen(x, "code", true);
    });
    const lines = Object.fromEntries(whoLines(s, facts, "2026-05-10").map((l) => [l.id, l.text]));
    expect(lines.where).toContain("C:/vault");
    expect(lines.enc).toBe(COPY.consent.whoEncOn);
    expect(lines.readers).toContain("41");
    expect(lines.holders).toContain("1 people");
    expect(lines.grants).toContain("1 in force");
    expect(lines.open).toContain("Code");
    expect(lines.left).toContain("2026-05-09");
  });

  it("says plainly when nothing is set up", () => {
    const lines = Object.fromEntries(whoLines(settingsOf(), { path: "", sample: true, readers: [], leftAt: null }).map((l) => [l.id, l.text]));
    expect(lines.enc).toBe(COPY.consent.whoEncOff);
    expect(lines.readers).toBe(COPY.consent.whoReadersNone);
    expect(lines.grants).toBe(COPY.consent.whoGrantsOff);
    expect(lines.open).toBe(COPY.consent.whoOpenNone);
    expect(lines.left).toBe(COPY.consent.whoLeftNever);
    expect(lines.holders).toContain(COPY.consent.whoHoldersNone);
  });

  it("each line points at a control", () => {
    for (const l of whoLines(settingsOf(), facts)) expect(l.go.ctl !== undefined || l.go.tab !== undefined).toBe(true);
  });

  it("knows which routes stay on this computer", () => {
    expect(isLocalRoute("this computer")).toBe(true);
    expect(isLocalRoute("local")).toBe(true);
    expect(isLocalRoute("claude-cli")).toBe(false);
  });
});

describe("the entry that records a change", () => {
  it("says what changed, with the date, and never carries a record id", () => {
    const g = grant({ purpose: "tidy my notes" });
    const added = consentEntry({ kind: "grant-added", grant: g }, "2026-05-10");
    expect(added.title).toContain("tidy my notes");
    expect(added.body).toContain("2026-05-10");
    expect(added.body).toContain("Any model");
    expect(added.body).toContain("Code");
    const all = [
      added,
      consentEntry({ kind: "grant-revoked", grant: g }, "2026-05-10"),
      consentEntry({ kind: "spaces-opened", spaces: ["code", "kb/money"] }, "2026-05-10"),
      consentEntry({ kind: "spaces-closed", spaces: ["code"] }, "2026-05-10"),
      consentEntry({ kind: "nothing-open" }, "2026-05-10"),
      consentEntry({ kind: "require-grant", on: true }, "2026-05-10"),
      consentEntry({ kind: "read-limit", on: true, max: 3 }, "2026-05-10"),
      consentEntry({ kind: "item-reset", id: "e_aaaaaaaaaaaaaaaa" }, "2026-05-10"),
    ];
    for (const e of all) {
      expect(e.title.length).toBeGreaterThan(3);
      expect(e.body).not.toMatch(/\{\w+\}/);
      expect(`${e.title} ${e.body}`).not.toMatch(/\be_[a-z2-7]{16}\b/);
    }
    expect(all[2]?.body).toContain("kb/money");
  });
});
