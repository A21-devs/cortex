/**
 * Corrections: the user outranks models. Owner: E7.
 *
 * `foldCorrections` (shared/correctionsFold.ts, re-exported here) turns the append-only corrections log into the
 * effective state used by the index builder (runner) and by the plugin (live overlay until the next index build).
 * A correction with `undoes` cancels the correction it names (and an undo of an undo restores it).
 *
 * Versions (SAFE-13): an edit's version number is assigned when the correction is WRITTEN (payload.version = max
 * existing + 1, under the corrections lock, by `LedgerStore.appendCorrectionsWith`); an undo withdraws that
 * version without renumbering later ones, so citations (entry, version, quote) never move.
 *
 * Exclusions (M2): one rule for every scope. An exclusion with scope source, folder or project writes the
 * correction AND the matching settings exclusion under one change; Undo reverses both. A Cortex-written note you
 * leave out becomes a placeholder with its old bytes in .vault-meta/cortex/trash/ (an edited one raises a conflict
 * check instead, SAFE-12); "Bring it back" restores exactly. Nothing is ever deleted.
 *
 * Check answers (§5.21): the answer is a correction. Every record of one answer carries the tag
 * `check:<card id>:<kind>` in `reason`, and the record whose target is the card itself is what marks the card
 * answered (LedgerService.checks); undoing any of them undoes the whole answer (Z).
 *
 * Pins (M15): pin / unpin corrections, folded into ItemFlag.Pinned at load and on every change.
 */
import type { ReadonlySignal } from "@preact/signals-core";
import { signal } from "@preact/signals-core";
import { CortexError } from "../shared/errors";
import { newCorrectionId, newReviewCardId, isNoteId } from "../shared/ids";
import type { Logger } from "../shared/log";
import { labelValueFits, normaliseLabelValue, findPack } from "../shared/packs";
import { nowIso } from "../shared/time";
import type { CorrectionAction, CorrectionId, CorrectionRecord, CorrectionVia, NoteRecord, ReviewCardRecord, SourceKind, SpaceId, LabelValue } from "../shared/types";
import { undoneIds, foldCorrections, nextVersion, type EffectiveCorrections, type ExcludeScope } from "../shared/correctionsFold";
import type { ConflictCardProposal, FilingCardProposal, LabelCardProposal, NoteCardProposal } from "../agents/schemas";
import { cleanDirection, type DirectionCardProposal } from "../shared/directions";
import { sha256Hex } from "../shared/sha256";
import type { SettingsHandle } from "./services";

export { foldCorrections, nextVersion, type EffectiveCorrections, type ExcludeScope };

export interface CorrectionService {
  list(): readonly CorrectionRecord[];
  effective(): EffectiveCorrections;
  /** Append a correction (assigns id/at; edit-text gets its version under the lock), update the live overlay. */
  apply<A extends CorrectionRecord["action"]>(c: Omit<CorrectionRecord<A>, "v" | "id" | "at">): Promise<CorrectionRecord<A>>;
  /** Append an undo for `id` (an answer to a check is undone as a whole). */
  undo(id: CorrectionId, via: CorrectionVia): Promise<CorrectionRecord>;
  /**
   * Leave something out (§5.30.4): never deletes; an unedited Cortex-written note becomes a placeholder with its
   * old bytes in .vault-meta/cortex/trash/, a user-edited one raises a conflict check (SAFE-12).
   */
  exclude(target: string, scope: ExcludeScope, via: CorrectionVia): Promise<CorrectionRecord<"exclude">>;
  /** Bring back exactly (restores placeholders from the trash). */
  include(excludeCorrectionId: CorrectionId, via: CorrectionVia): Promise<CorrectionRecord>;
  /** Answer a check (Agents › Checks, §5.21): the answer is a correction; Z undoes the last one. */
  resolveCheck(cardId: string, answer: CheckAnswer): Promise<CorrectionRecord | null>;
  /**
   * Confirm many checks in ONE append (Agents › Checks › Confirm all). Only labels, summaries, filing and directions
   * can be confirmed in bulk; mentions and conflicts need your own answer, and a card that is gone or already answered
   * is left alone. `ids` is every correction written, for `undoMany`.
   */
  confirmChecks(cardIds: readonly string[]): Promise<{ confirmed: string[]; left: string[]; ids: CorrectionId[] }>;
  /** Undo several corrections (an answer to a check goes as a whole) in ONE append. */
  undoMany(ids: readonly CorrectionId[], via: CorrectionVia): Promise<CorrectionRecord[]>;
  /** Sources and conversations you left out, for Settings › Privacy and Sources › Privacy ("Bring back"). */
  leftOut(): readonly { correctionId: CorrectionId; target: string; scope: ExcludeScope; at: string }[];
}

/** 1 Confirm · 2 Change (new field values) · 3 Reject (a reason chip) · 4 Skip; mentions: mine or not; conflicts. */
export type CheckAnswer =
  | { kind: "confirm" }
  | { kind: "change"; values: Record<string, unknown> }
  | { kind: "reject"; reason: "wrong" | "not-about-this" | "too-vague" | "other"; note?: string }
  | { kind: "skip" }
  | { kind: "mention"; mine: boolean }
  | { kind: "conflict"; keep: "mine" | "theirs" };

export interface CorrectionServiceExt extends CorrectionService {
  /** Read the log (idempotent); resolves once `list()` is current. */
  load(): Promise<void>;
  /** Re-read after the cache signal says the corrections changed (the runner may have written some). */
  refresh(): Promise<void>;
  /** Bumped on every change of the log (load, apply, undo, refresh); the index overlay and Checks follow it. */
  readonly version: ReadonlySignal<number>;
  dispose(): void;
}

/** The corrections log (E2: LedgerStore.appendCorrectionsWith / readCorrections; see correctionsNode.ts). */
export interface CorrectionLedger {
  appendCorrectionsWith(build: (existing: readonly CorrectionRecord[]) => readonly CorrectionRecord[] | Promise<readonly CorrectionRecord[]>): Promise<{ records: CorrectionRecord[]; seq: number }>;
  readCorrections(): Promise<CorrectionRecord[]>;
}

/** Machine notes: every NoteRecord line in ledger order, and appending upserts (a note you left out is rewritten). */
export interface NoteLedger {
  all(): AsyncIterable<NoteRecord>;
  append(records: readonly NoteRecord[]): Promise<void>;
}

/** The Checks cards: every line in ledger order, and appending (a conflict check when a left-out note was edited). */
export interface CardLedger {
  all(): AsyncIterable<ReviewCardRecord>;
  append(records: readonly ReviewCardRecord[]): Promise<void>;
}

export type NoteFileOutcome = { written: true; ownedSha256: string } | { written: false; reason: "user-edited" | "unchanged" };

/** Placeholder and restore for Cortex-written notes (E2: tombstoneDerivedNote / restoreDerivedNote). */
export interface NoteFiles {
  tombstone(file: string, expectedOwnedSha: string, leftOutOn: string): Promise<NoteFileOutcome>;
  restore(file: string, noteId: string, placeholderOwnedSha: string, previousOwnedSha: string): Promise<NoteFileOutcome>;
}

export interface CorrectionDeps {
  ledger: CorrectionLedger;
  notes?: NoteLedger;
  cards?: CardLedger;
  files?: NoteFiles;
  /** Writes the settings exclusion that goes with a source, folder or project exclusion. */
  settings?: Pick<SettingsHandle, "update" | "value">;
  /** The sample record refuses every write. */
  sandbox?: () => boolean;
  /** "Use theirs" on a conflict check: write the proposed note (the runner's notes writer). */
  applyTheirs?: (card: ReviewCardRecord) => Promise<void>;
  now?: () => number;
  log?: Logger;
}

export const SAMPLE_REFUSAL = "Not available in the sample record.";

const SETTINGS_LIST = {
  vault: "sources.vault.excludeFolders",
  raw: "sources.raw.excludeFolders",
  project: "sources.claudeCode.excludeProjects",
} as const;

function listOf(s: import("../shared/settings").CortexSettings, key: string): string[] | null {
  switch (key) {
    case SETTINGS_LIST.vault:
      return s.sources.vault.excludeFolders;
    case SETTINGS_LIST.raw:
      return s.sources.raw.excludeFolders;
    case SETTINGS_LIST.project:
      return s.sources.claudeCode.excludeProjects;
    default:
      return null;
  }
}

const CHECK_TAG = /^check:([^:]+):/;

function notConnected(): CortexError {
  return new CortexError("E_INTERNAL", "Corrections are not connected to the vault");
}

export function createCorrectionService(deps?: CorrectionDeps): CorrectionServiceExt {
  let records: CorrectionRecord[] = [];
  let eff: EffectiveCorrections = foldCorrections(records);
  const version = signal(0);
  let loading: Promise<void> | null = null;
  let disposed = false;
  const need = (): CorrectionDeps => {
    if (!deps) throw notConnected();
    return deps;
  };
  const clock = (): number => (deps?.now ?? Date.now)();
  const guard = (): CorrectionDeps => {
    const d = need();
    if (d.sandbox?.()) throw new CortexError("E_BAD_REQUEST", SAMPLE_REFUSAL);
    return d;
  };

  function set(next: CorrectionRecord[]): void {
    records = next;
    eff = foldCorrections(records);
    version.value += 1;
  }

  function merge(added: readonly CorrectionRecord[]): void {
    const have = new Set(records.map((r) => r.id));
    const fresh = added.filter((r) => !have.has(r.id));
    if (fresh.length > 0) set([...records, ...fresh]);
  }

  async function refresh(): Promise<void> {
    if (!deps || disposed) return;
    set(await deps.ledger.readCorrections());
  }

  function standing(): CorrectionRecord[] {
    const undone = undoneIds(records);
    return records.filter((r) => !undone.has(r.id) && !r.undoes);
  }

  // ───────────── settings that go with an exclusion ─────────────

  function settingsKeyFor(scope: ExcludeScope, target: string): string | undefined {
    if (scope === "project") return SETTINGS_LIST.project;
    if (scope === "folder") return target.replace(/\\/g, "/").startsWith(".raw/") ? SETTINGS_LIST.raw : SETTINGS_LIST.vault;
    return undefined;
  }

  async function changeSettingsList(d: CorrectionDeps, key: string, value: string, add: boolean): Promise<boolean> {
    if (!d.settings) return false;
    let changed = false;
    await d.settings.update((s) => {
      const list = listOf(s, key);
      if (!list) return;
      const at = list.indexOf(value);
      if (add && at < 0) {
        list.push(value);
        changed = true;
      } else if (!add && at >= 0) {
        list.splice(at, 1);
        changed = true;
      }
    });
    return changed;
  }

  /** The settings value an exclude correction wrote (its settingsKey names the list; the value is its target). */
  function settingsValueOf(rec: CorrectionRecord<"exclude">): string {
    return rec.payload.scope === "project" ? (rec.payload.project ?? rec.target) : (rec.payload.folder ?? rec.target);
  }

  // ───────────── machine notes you leave out ─────────────

  async function latestNotes(d: CorrectionDeps): Promise<Map<string, NoteRecord>> {
    const out = new Map<string, NoteRecord>();
    if (!d.notes) return out;
    for await (const n of d.notes.all()) {
      const prev = out.get(n.id);
      if (!prev || n.seq >= prev.seq) out.set(n.id, n);
    }
    return out;
  }

  async function allNoteVersions(d: CorrectionDeps, id: string): Promise<NoteRecord[]> {
    const all: NoteRecord[] = [];
    if (d.notes) for await (const n of d.notes.all()) if (n.id === id) all.push(n);
    return all.sort((a, b) => a.seq - b.seq);
  }

  function affectedNotes(notes: Map<string, NoteRecord>, scope: ExcludeScope, target: string): NoteRecord[] {
    if (scope === "entry" && isNoteId(target)) {
      const n = notes.get(target);
      return n ? [n] : [];
    }
    if (scope === "conversation") return [...notes.values()].filter((n) => n.conv === target);
    return [];
  }

  /** One file per gist (its atomic notes live in it): the record that owns the bytes decides. */
  function byFile(list: NoteRecord[]): Map<string, NoteRecord[]> {
    const out = new Map<string, NoteRecord[]>();
    for (const n of list) {
      const g = out.get(n.file) ?? [];
      g.push(n);
      out.set(n.file, g);
    }
    return out;
  }

  async function leaveNotesOut(d: CorrectionDeps, scope: ExcludeScope, target: string): Promise<void> {
    if (!d.files || !d.notes) return;
    const notes = await latestNotes(d);
    const today = nowIso();
    for (const [file, group] of byFile(affectedNotes(notes, scope, target))) {
      const owner = group.find((n) => n.ownedSha256 !== undefined && n.state !== "excluded");
      if (!owner || owner.ownedSha256 === undefined) continue;
      const outcome = await d.files.tombstone(file, owner.ownedSha256, today);
      if (outcome.written) {
        await d.notes.append(group.map((n) => ({ ...n, seq: n.seq + 1, state: "excluded" as const, ownedSha256: outcome.ownedSha256 })));
      } else if (outcome.reason === "user-edited") {
        const proposal: ConflictCardProposal = { kind: "conflict", noteId: owner.id, path: file, markdown: `> [!cortex-machine] Left out by you on ${today.slice(0, 10)}.\n` };
        await d.cards?.append([{ v: 1, id: newReviewCardId(clock()), kind: "conflict", target: owner.id, proposal, createdAt: today, reason: "You left this out, but you also edited the note." }]);
      }
    }
  }

  async function bringNotesBack(d: CorrectionDeps, scope: ExcludeScope, target: string): Promise<void> {
    if (!d.files || !d.notes) return;
    const notes = await latestNotes(d);
    for (const [file, group] of byFile(affectedNotes(notes, scope, target).filter((n) => n.state === "excluded"))) {
      const owner = group.find((n) => n.ownedSha256 !== undefined);
      if (!owner || owner.ownedSha256 === undefined) continue;
      const versions = await allNoteVersions(d, owner.id);
      const before = [...versions].reverse().find((n) => n.state !== "excluded" && n.ownedSha256 !== undefined);
      if (!before || before.ownedSha256 === undefined) continue;
      const outcome = await d.files.restore(file, owner.id, owner.ownedSha256, before.ownedSha256);
      if (outcome.written) {
        const upd = group.map((n) => {
          const prev = [...(n.id === owner.id ? versions : [])].reverse().find((x) => x.state !== "excluded");
          return { ...n, seq: n.seq + 1, state: prev?.state ?? ("current" as const), ownedSha256: before.ownedSha256 as string };
        });
        await d.notes.append(upd);
      }
    }
  }

  // ───────────── the service ─────────────

  function build<A extends CorrectionAction>(c: Omit<CorrectionRecord<A>, "v" | "id" | "at">): CorrectionRecord<A> {
    return { v: 1, id: newCorrectionId(clock()), at: nowIso(), ...c } as CorrectionRecord<A>;
  }

  async function append(d: CorrectionDeps, make: (existing: readonly CorrectionRecord[]) => CorrectionRecord[]): Promise<CorrectionRecord[]> {
    const { records: written } = await d.ledger.appendCorrectionsWith((existing) => make(existing));
    merge(written);
    return written;
  }

  async function apply<A extends CorrectionAction>(c: Omit<CorrectionRecord<A>, "v" | "id" | "at">): Promise<CorrectionRecord<A>> {
    const d = guard();
    if (typeof c.target !== "string" || c.target.length === 0) throw new CortexError("E_BAD_REQUEST", "a correction needs a target");
    if (c.action === "edit-text") {
      const p = c.payload as CorrectionRecord<"edit-text">["payload"];
      if (typeof p.newText !== "string" || p.newText.length === 0) throw new CortexError("E_BAD_REQUEST", "the corrected text is empty");
      if (p.newTextSha256 !== sha256Hex(p.newText)) throw new CortexError("E_BAD_REQUEST", "the corrected text does not match its hash");
    }
    const [rec] = await append(d, (existing) => {
      const r = build(c);
      if (r.action === "edit-text") (r.payload as CorrectionRecord<"edit-text">["payload"]).version = nextVersion(existing, r.target);
      return [r];
    });
    return rec as CorrectionRecord<A>;
  }

  async function reverseSideEffects(d: CorrectionDeps, orig: CorrectionRecord, restoring: boolean): Promise<void> {
    if (orig.action !== "exclude") return;
    const ex = orig as CorrectionRecord<"exclude">;
    const key = ex.payload.settingsKey;
    if (key) await changeSettingsList(d, key, settingsValueOf(ex), restoring);
    if (restoring) await leaveNotesOut(d, ex.payload.scope, ex.target);
    else await bringNotesBack(d, ex.payload.scope, ex.target);
  }

  async function undoMany(ids: readonly CorrectionId[], via: CorrectionVia): Promise<CorrectionRecord[]> {
    const d = guard();
    const live = standing();
    const byTag = new Map<string, CorrectionRecord[]>();
    for (const r of live) {
      const t = r.reason ? CHECK_TAG.exec(r.reason)?.[1] : undefined;
      if (t !== undefined) byTag.set(t, [...(byTag.get(t) ?? []), r]);
    }
    const victims = new Map<CorrectionId, CorrectionRecord>();
    for (const id of ids) {
      const target = records.find((r) => r.id === id);
      if (!target) throw new CortexError("E_BAD_REQUEST", "that correction is not in the log");
      // An answer to a check is one change: every record that carries its tag goes together.
      const tag = target.reason ? CHECK_TAG.exec(target.reason)?.[1] : undefined;
      const group = tag !== undefined ? byTag.get(tag) ?? [] : [];
      for (const v of group.length > 0 ? group : [target]) victims.set(v.id, v);
    }
    const all = [...victims.values()];
    const written = await append(d, () =>
      all.map((v) => build({ via, action: v.action, target: v.target, payload: v.payload, undoes: v.id, ...(v.reason !== undefined && CHECK_TAG.test(v.reason) ? { reason: v.reason } : {}) } as Omit<CorrectionRecord, "v" | "id" | "at">)),
    );
    for (const v of all) {
      // Undoing an exclusion brings it back; undoing an undo (or an include) puts the exclusion back.
      const via2 = v.undoes ?? (v.action === "include" ? (v.payload as CorrectionRecord<"include">["payload"]).excludeCorrectionId : undefined);
      if (via2 !== undefined) {
        const orig = records.find((r) => r.id === via2);
        if (orig) await reverseSideEffects(d, orig, true);
      } else await reverseSideEffects(d, v, false);
    }
    return written;
  }

  async function undo(id: CorrectionId, via: CorrectionVia): Promise<CorrectionRecord> {
    const written = await undoMany([id], via);
    return written[written.length - 1] as CorrectionRecord;
  }

  async function exclude(target: string, scope: ExcludeScope, via: CorrectionVia): Promise<CorrectionRecord<"exclude">> {
    const d = guard();
    const payload: CorrectionRecord<"exclude">["payload"] = { scope };
    if (scope === "source") payload.sourceKind = target as SourceKind;
    if (scope === "folder") payload.folder = target;
    if (scope === "project") payload.project = target;
    const key = settingsKeyFor(scope, target);
    let added = false;
    if (key) {
      added = await changeSettingsList(d, key, target, true);
      if (added) payload.settingsKey = key;
    }
    let rec: CorrectionRecord<"exclude">;
    try {
      [rec] = (await append(d, () => [build<"exclude">({ via, action: "exclude", target, payload })])) as [CorrectionRecord<"exclude">];
    } catch (e) {
      if (added && key) await changeSettingsList(d, key, target, false);
      throw e;
    }
    await leaveNotesOut(d, scope, target);
    return rec;
  }

  async function include(excludeCorrectionId: CorrectionId, via: CorrectionVia): Promise<CorrectionRecord> {
    const d = guard();
    const live = [...eff.excluded.values()].some((r) => r.by === excludeCorrectionId);
    const orig = live ? (standing().find((r) => r.id === excludeCorrectionId && r.action === "exclude") as CorrectionRecord<"exclude"> | undefined) : undefined;
    if (!orig) throw new CortexError("E_BAD_REQUEST", "that exclusion is not standing");
    const [rec] = await append(d, () => [build<"include">({ via, action: "include", target: orig.target, payload: { excludeCorrectionId } })]);
    await reverseSideEffects(d, orig, false);
    return rec as CorrectionRecord;
  }

  // ───────────── checks ─────────────

  async function findCard(d: CorrectionDeps, cardId: string): Promise<ReviewCardRecord | null> {
    let card: ReviewCardRecord | null = null;
    if (d.cards) for await (const c of d.cards.all()) if (c.id === cardId) card = c;
    return card;
  }

  function validateValue(pack: string, field: string, value: unknown): LabelValue {
    const def = findPack(pack)?.fields.find((f) => f.key === field);
    if (!def) throw new CortexError("E_BAD_REQUEST", `unknown field ${pack}.${field}`);
    const v = normaliseLabelValue(def, value as LabelValue);
    if (!labelValueFits(def, v)) throw new CortexError("E_BAD_REQUEST", `that value does not fit ${field}`);
    return v;
  }

  async function resolveCheck(cardId: string, answer: CheckAnswer): Promise<CorrectionRecord | null> {
    const d = guard();
    if (answer.kind === "skip") return null;
    const card = await findCard(d, cardId);
    if (!card) throw new CortexError("E_BAD_REQUEST", "that check is not in the ledger");
    if (standing().some((r) => r.target === cardId)) throw new CortexError("E_BAD_REQUEST", "that check was already answered");
    const make = await answerRecords(d, card, answer);
    const written = await append(d, () => make.map((m) => build(m)));
    return written[written.length - 1] ?? null;
  }

  /** The correction records one answer to one card writes (validated; a conflict's "use theirs" writes the note first). */
  async function answerRecords(d: CorrectionDeps, card: ReviewCardRecord, answer: CheckAnswer): Promise<Omit<CorrectionRecord, "v" | "id" | "at">[]> {
    const cardId = card.id;
    const tag = `check:${cardId}:${answer.kind}`;
    const via: CorrectionVia = "checks";
    const marker = (payload: CorrectionRecord<"confirm">["payload"] = {}, why?: string): Omit<CorrectionRecord<"confirm">, "v" | "id" | "at"> => ({ via, action: "confirm", target: cardId, payload, reason: why ? `${tag}:${why}` : tag });
    const tagged = <A extends CorrectionAction>(c: Omit<CorrectionRecord<A>, "v" | "id" | "at">): Omit<CorrectionRecord<A>, "v" | "id" | "at"> => ({ ...c, reason: tag });
    const make: Omit<CorrectionRecord, "v" | "id" | "at">[] = [];

    switch (card.kind) {
      case "label": {
        const p = card.proposal as LabelCardProposal;
        if (answer.kind === "confirm") {
          for (const f of p.fields) make.push(marker({ labelId: f.labelId }));
          if (p.fields.length === 0) make.push(marker());
        } else if (answer.kind === "change") {
          const keys = new Set(Object.keys(answer.values));
          for (const key of keys) if (!p.fields.some((f) => f.field === key)) throw new CortexError("E_BAD_REQUEST", `${key} is not a field of this check`);
          for (const f of p.fields) {
            if (keys.has(f.field)) make.push(tagged<"set-label">({ via, action: "set-label", target: card.target, payload: { pack: p.pack, packVersion: p.version, field: f.field, value: validateValue(p.pack, f.field, answer.values[f.field]) } }));
            else make.push(marker({ labelId: f.labelId }));
          }
          make.push(marker({}, "changed"));
        } else if (answer.kind === "reject") {
          for (const f of p.fields) make.push({ via, action: "reject-label", target: cardId, payload: { labelId: f.labelId }, reason: `${tag}:${answer.reason}${answer.note ? ` ${answer.note}` : ""}` });
          if (p.fields.length === 0) make.push(marker({}, answer.reason));
        } else throw new CortexError("E_BAD_REQUEST", "that answer does not fit a label check");
        break;
      }
      case "note": {
        const p = card.proposal as NoteCardProposal;
        if (answer.kind === "confirm") make.push(marker({ noteId: p.noteId }));
        else if (answer.kind === "change") {
          const text = typeof answer.values.comment === "string" ? answer.values.comment.trim() : "";
          if (!text) throw new CortexError("E_BAD_REQUEST", "say what to correct");
          make.push(tagged<"comment">({ via, action: "comment", target: p.noteId, payload: { text } }));
          make.push(marker({}, "correct"));
        } else if (answer.kind === "reject") make.push(marker({}, `rejected-${answer.reason}`));
        else throw new CortexError("E_BAD_REQUEST", "that answer does not fit a summary check");
        break;
      }
      case "filing": {
        const p = card.proposal as FilingCardProposal;
        if (answer.kind === "confirm" || answer.kind === "change") {
          const v = answer.kind === "change" ? answer.values : {};
          const area = (typeof v.area === "string" ? v.area : p.area) as SpaceId;
          const payload: CorrectionRecord<"refile">["payload"] = { space: area };
          const folder = typeof v.folder === "string" ? v.folder : p.folder;
          if (folder !== undefined) payload.folder = folder.split("/").filter((x) => x.length > 0);
          const project = v.project !== undefined ? (typeof v.project === "string" ? v.project : null) : p.project;
          if (project !== undefined) payload.project = project;
          make.push(tagged<"refile">({ via, action: "refile", target: card.target, payload }));
          make.push(marker({}, answer.kind));
        } else if (answer.kind === "reject") make.push(marker({}, `rejected-${answer.reason}`));
        else throw new CortexError("E_BAD_REQUEST", "that answer does not fit a filing check");
        break;
      }
      case "mention": {
        if (answer.kind !== "mention") throw new CortexError("E_BAD_REQUEST", "that answer does not fit a mention check");
        if (answer.mine) make.push(tagged<"set-speaker">({ via, action: "set-speaker", target: card.target, payload: { speaker: "you" } }));
        make.push(marker({}, answer.mine ? "mine" : "not-mine"));
        break;
      }
      case "conflict": {
        const p = card.proposal as ConflictCardProposal;
        if (answer.kind !== "conflict") throw new CortexError("E_BAD_REQUEST", "that answer does not fit a conflict check");
        if (answer.keep === "theirs") {
          if (!d.applyTheirs) throw new CortexError("E_INTERNAL", "writing the new version is not connected");
          await d.applyTheirs(card);
        }
        make.push(marker({ noteId: p.noteId }, answer.keep === "mine" ? "keep-mine" : "use-theirs"));
        break;
      }
      case "direction": {
        // A drafted direction is never applied by itself: accepting (or editing, then accepting) records the text you
        // kept in the answer; dismissing records only that you turned it down.
        const p = card.proposal as DirectionCardProposal;
        if (answer.kind === "confirm") make.push(marker({ text: p.text }, "accepted"));
        else if (answer.kind === "change") {
          const text = cleanDirection(answer.values.text);
          if (text === null) throw new CortexError("E_BAD_REQUEST", "a direction is one plain sentence of 8 to 200 characters");
          make.push(marker({ text }, "edited"));
        } else if (answer.kind === "reject") make.push(marker({}, `dismissed-${answer.reason}`));
        else throw new CortexError("E_BAD_REQUEST", "that answer does not fit a direction check");
        break;
      }
    }
    return make;
  }

  /** Cards a bulk Confirm may answer: the rest need a decision of yours (whose message, which side). */
  const BULK_CONFIRM_KINDS: ReadonlySet<ReviewCardRecord["kind"]> = new Set(["label", "note", "filing", "direction"]);

  async function confirmChecks(cardIds: readonly string[]): Promise<{ confirmed: string[]; left: string[]; ids: CorrectionId[] }> {
    const d = guard();
    const want = new Set(cardIds);
    const cards = new Map<string, ReviewCardRecord>();
    if (d.cards) for await (const c of d.cards.all()) if (want.has(c.id)) cards.set(c.id, c);
    const answered = new Set(standing().map((r) => r.target));
    const confirmed: string[] = [];
    const left: string[] = [];
    const make: Omit<CorrectionRecord, "v" | "id" | "at">[] = [];
    for (const id of want) {
      const card = cards.get(id);
      if (!card || answered.has(id) || !BULK_CONFIRM_KINDS.has(card.kind)) {
        left.push(id);
        continue;
      }
      try {
        make.push(...(await answerRecords(d, card, { kind: "confirm" })));
        confirmed.push(id);
      } catch {
        left.push(id);
      }
    }
    if (make.length === 0) return { confirmed, left, ids: [] };
    const written = await append(d, () => make.map((m) => build(m)));
    return { confirmed, left, ids: written.map((r) => r.id) };
  }

  return {
    list: () => records,
    effective: () => eff,
    version,
    apply,
    undo,
    exclude,
    include,
    resolveCheck,
    confirmChecks,
    undoMany,
    load(): Promise<void> {
      if (!deps) return Promise.reject(notConnected());
      loading ??= refresh().catch((e: unknown) => {
        loading = null;
        throw e;
      });
      return loading;
    },
    refresh,
    leftOut() {
      const live = new Set([...eff.excluded.values()].map((r) => r.by));
      return standing()
        .filter((r): r is CorrectionRecord<"exclude"> => r.action === "exclude" && live.has(r.id))
        .map((r) => ({ correctionId: r.id, target: r.target, scope: r.payload.scope, at: r.at }));
    },
    dispose() {
      disposed = true;
    },
  };
}
