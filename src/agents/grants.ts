/**
 * The runner's side of consent (shared/consent.ts holds the rules). A `ReadGate` answers, for one run: may this item be
 * sent to this reader? It says no when
 *   - "Require a grant" is on and no live grant for the reader covers the item (the grant must name the item's space,
 *     and that space must be open), or the grant's read limit is used up; or
 *   - "Most any item may be read by a model" is on and the item was already sent that many times since its last reset.
 * The plain-rules engine is not a reader: nothing leaves the code, so it is never gated.
 *
 * Reads are counted from the read log (ReadRecord), so the count is the same number the Access log shows: items sent per
 * grant, and times sent per item. A gate keeps what its own run took until the call writes its ReadRecord, so two items of
 * one prompt cannot both take the last free read.
 *
 * Fail-closed by construction: `assertRead` refuses a call whose items were not each taken from the gate when a grant is
 * required, so a code path that forgets to ask the gate is stopped at the call instead of reading.
 */
import type { ConsentGrant, ConsentSettings } from "../shared/settingsExt";
import { grantCovers, grantState, grantUsed, itemLimit, liveGrants, readerMatches, type ConsentReads, type Place, type Reader } from "../shared/consent";
import { localDayKey } from "../shared/time";
import type { ReadRecord } from "../shared/types";
import type { UserSpace } from "../shared/userSpaces";

/** Reads counted from the log: times each item was sent (since its reset) and items sent under each grant. */
export interface ReadTally {
  entries: Map<string, number>;
  grants: Map<string, number>;
}

export function emptyTally(): ReadTally {
  return { entries: new Map(), grants: new Map() };
}

/** Add one ReadRecord to a tally. `resets` maps an item id to the moment its count started over. */
export function countRead(tally: ReadTally, r: Pick<ReadRecord, "entryIds" | "noteIds" | "grants" | "at">, resets: Readonly<Record<string, string>> = {}): void {
  const ids = [...(r.entryIds ?? []), ...(r.noteIds ?? [])];
  for (const id of ids) {
    const reset = resets[id];
    if (reset !== undefined && r.at <= reset) continue;
    tally.entries.set(id, (tally.entries.get(id) ?? 0) + 1);
  }
  for (const g of r.grants ?? []) tally.grants.set(g, (tally.grants.get(g) ?? 0) + ids.length);
}

/** Count every ReadRecord of a stream. */
export async function tallyReads(records: AsyncIterable<unknown>, resets: Readonly<Record<string, string>> = {}): Promise<ReadTally> {
  const t = emptyTally();
  for await (const r of records) {
    if (typeof r !== "object" || r === null) continue;
    const rec = r as Partial<ReadRecord>;
    if (typeof rec.at !== "string") continue;
    countRead(t, { entryIds: Array.isArray(rec.entryIds) ? rec.entryIds : [], noteIds: Array.isArray(rec.noteIds) ? rec.noteIds : [], grants: Array.isArray(rec.grants) ? rec.grants : [], at: rec.at }, resets);
  }
  return t;
}

export type Verdict = { ok: true; grant?: string } | { ok: false; why: "limit" | "no-grant" | "grant-used-up" };

export interface GateInit {
  consent: ConsentSettings;
  userSpaces: readonly UserSpace[];
  /** Who reads; null = the plain-rules engine (never gated). */
  reader: Reader | null;
  /** Local day, yyyy-mm-dd. */
  today: string;
  tally: ReadTally;
}

export class ReadGate {
  private readonly consent: ConsentSettings;
  private readonly spaces: readonly UserSpace[];
  private readonly reader: Reader | null;
  private readonly today: string;
  private readonly tally: ReadTally;
  /** What this run took and has not written to the log yet. */
  private readonly takenEntries = new Map<string, number>();
  private readonly takenGrants = new Map<string, number>();
  /** The grant each item was taken under (items that needed none are absent). */
  private readonly grantOfItem = new Map<string, string>();
  private readonly taken = new Set<string>();

  constructor(i: GateInit) {
    this.consent = i.consent;
    this.spaces = i.userSpaces;
    this.reader = i.reader;
    this.today = i.today;
    this.tally = i.tally;
  }

  /** True when anything here can say no. */
  get active(): boolean {
    return this.reader !== null && (this.consent.requireGrant || itemLimit(this.consent) !== null);
  }

  /** True when a grant is required for this reader. */
  get requires(): boolean {
    return this.reader !== null && this.consent.requireGrant;
  }

  private entryCount(id: string): number {
    return (this.tally.entries.get(id) ?? 0) + (this.takenEntries.get(id) ?? 0);
  }

  private grantCount(g: ConsentGrant): number {
    return grantUsed(g, (this.tally.grants.get(g.id) ?? 0) + (this.takenGrants.get(g.id) ?? 0));
  }

  /** The verdict for one item, without taking it. */
  check(item: Place & { id: string }): Verdict {
    if (this.reader === null) return { ok: true };
    const limit = itemLimit(this.consent);
    if (limit !== null && this.entryCount(item.id) >= limit) return { ok: false, why: "limit" };
    if (!this.consent.requireGrant) return { ok: true };
    let sawUsedUp = false;
    for (const g of this.consent.grants) {
      if (!readerMatches(g.reader, this.reader) || !grantCovers(g, item, this.consent, this.spaces)) continue;
      const st = grantState(g, this.today, this.grantCount(g));
      if (st === "live") return { ok: true, grant: g.id };
      if (st === "used-up") sawUsedUp = true;
    }
    return { ok: false, why: sawUsedUp ? "grant-used-up" : "no-grant" };
  }

  /** Check an item and, when it may be read, count it against its grant and its own limit until the call is logged. */
  take(item: Place & { id: string }): Verdict {
    const v = this.check(item);
    if (!v.ok || this.reader === null) return v;
    this.takenEntries.set(item.id, (this.takenEntries.get(item.id) ?? 0) + 1);
    this.taken.add(item.id);
    if (v.grant !== undefined) {
      this.takenGrants.set(v.grant, (this.takenGrants.get(v.grant) ?? 0) + 1);
      this.grantOfItem.set(item.id, v.grant);
    }
    return v;
  }

  /** The grants an item list was taken under, for the ReadRecord. */
  grantsFor(ids: readonly string[]): string[] {
    const out = new Set<string>();
    for (const id of ids) {
      const g = this.grantOfItem.get(id);
      if (g !== undefined) out.add(g);
    }
    return [...out];
  }

  /**
   * Refuse a call that would read items nobody took from the gate, when a grant is required. `places` says where an item
   * that was not taken sits (notes); an item that is covered right now is accepted and taken here.
   */
  assertRead(ids: readonly string[], placeOf: (id: string) => (Place & { id: string }) | undefined): Verdict {
    if (!this.active) return { ok: true };
    for (const id of ids) {
      if (this.taken.has(id)) continue;
      const place = placeOf(id);
      if (!place) return { ok: false, why: "no-grant" };
      const v = this.take(place);
      if (!v.ok) return v;
    }
    return { ok: true };
  }

  /** The call that took these items is in the log: move them from "taken" to the counted reads. */
  logged(r: Pick<ReadRecord, "entryIds" | "noteIds" | "grants" | "at">): void {
    const ids = [...(r.entryIds ?? []), ...(r.noteIds ?? [])];
    for (const id of ids) {
      const n = this.takenEntries.get(id) ?? 0;
      if (n > 1) this.takenEntries.set(id, n - 1);
      else this.takenEntries.delete(id);
    }
    for (const g of r.grants ?? []) {
      const n = this.takenGrants.get(g) ?? 0;
      const left = n - ids.filter((id) => this.grantOfItem.get(id) === g).length;
      if (left > 0) this.takenGrants.set(g, left);
      else this.takenGrants.delete(g);
    }
    countRead(this.tally, { ...r }, this.consent.readResets ?? {});
  }
}

/** A gate for a reader, with the counts read from `records` (the reads stream). */
export async function openGate(args: { consent: ConsentSettings; userSpaces: readonly UserSpace[]; reader: Reader | null; now: number; records: () => AsyncIterable<unknown> }): Promise<ReadGate> {
  const active = args.reader !== null && (args.consent.requireGrant || itemLimit(args.consent) !== null);
  const tally = active ? await tallyReads(args.records(), args.consent.readResets ?? {}) : emptyTally();
  return new ReadGate({ consent: args.consent, userSpaces: args.userSpaces, reader: args.reader, today: localDayKey(args.now), tally });
}

/** Why a pass cannot start: "Require a grant" is on and no live grant names this reader at all. null = it may start. */
export function noGrantReason(consent: ConsentSettings, reader: Reader | null, today: string, counted: ReadonlyMap<string, number> = new Map()): "no-grant" | null {
  if (reader === null || !consent.requireGrant) return null;
  return liveGrants(consent, reader, today, counted).length === 0 ? "no-grant" : null;
}

/** The message a refused read shows. */
export function refusalMessage(why: "limit" | "no-grant" | "grant-used-up"): string {
  switch (why) {
    case "limit":
      return "an item has been read as many times as the limit allows";
    case "grant-used-up":
      return "the grant that covers this has no reads left";
    case "no-grant":
      return "no live grant covers this read";
  }
}


const TOP_ITEMS = 40;
const AT_LIMIT_MAX = 2000;

/** The counts the Access log and the reader show, from a tally. `labelOf` gives an item a short label (a title, never text). */
export async function summariseReads(records: AsyncIterable<unknown>, consent: ConsentSettings, labelOf: (ids: ReadonlySet<string>) => Promise<Map<string, string>>): Promise<ConsentReads> {
  const tally = await tallyReads(records, consent.readResets ?? {});
  const limit = itemLimit(consent);
  const sorted = [...tally.entries].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const atLimit = limit === null ? [] : sorted.filter(([, n]) => n >= limit).slice(0, AT_LIMIT_MAX).map(([id]) => id);
  const top = sorted.slice(0, TOP_ITEMS);
  const labels = await labelOf(new Set(top.map(([id]) => id)));
  return {
    limit,
    grants: Object.fromEntries(tally.grants),
    items: top.map(([id, n]) => ({ id, n, label: labels.get(id) ?? "" })),
    atLimit,
  };
}
