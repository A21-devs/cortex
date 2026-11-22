/**
 * Index, search and state (owner E7): the binary index codec and the growable store, search shards and the
 * worker's search / query / related operations, the sample record, the corrections fold and service, the
 * runner's record and search builders, the plugin's index service and vault source, and the per-leaf state
 * (stores, named actions, selectors, events, persistence).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { signal } from "@preact/signals-core";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  IndexStore,
  OrdinalTable,
  newEpoch,
  PATCH_FLAGS,
  PATCH_LABELS,
  PATCH_SIZE,
  PATCH_TITLE,
  SAMPLE_COUNTS,
  SAMPLE_EPOCH,
  decodeIndex,
  decodePart,
  emptyIndex,
  encodeIndex,
  isAbsent,
  mergeIndexes,
  readIndexHeader,
  sampleIndexInput,
  type IndexBuildInput,
  type IndexItemInput,
} from "../src/shared/indexCodec";
import { ItemFlag, ItemKind, NONE16, NONE32, NONE8, NOTE_KIND_ORDER, Population, SPACE_ORDER } from "../src/shared/index-format";
import { exclusionMatcher, foldCorrections, nextVersion } from "../src/shared/correctionsFold";
import { wikiNoteId } from "../src/shared/ids";
import { nullLogger } from "../src/shared/log";
import { NEVER_CANCELLED } from "../src/shared/cancel";
import { migrateSettingsChecked } from "../src/shared/settings";
import type { ConversationRecord, CorrectionAction, CorrectionRecord, EntryRecord, LabelRecord, LabelValue, NoteRecord, ReviewCardRecord, SegmentLine } from "../src/shared/types";
import { sha256Text } from "../src/node/hash";
import { buildRecordIndex, composeRecordIndex, type LedgerSnapshot } from "../src/store/indexBuilder";
import { buildSearchIndex } from "../src/store/searchIndex";
import { cacheLayout, openStoreContext } from "../src/store/layout";
import { createLedgerStore, type LedgerStore } from "../src/store/ledger";
import { readSignal, writeSignal } from "../src/store/signal";
import { sealStage, stageMessages } from "../src/store/stage";
import { CortexError } from "../src/shared/errors";
import { buildVaultIndex, isIgnoredPath, listVaultNotes, vaultCacheKey, watchVault, watchVaultNoteFiles, type VaultApp } from "../src/plugin/vaultSource";
import { createNodeCorrectionService } from "../src/plugin/correctionsNode";
import { overlayFlags } from "../src/plugin/indexer";
import { createNodeIndexIo, createNodeIndexService } from "../src/plugin/indexerNode";
import { SAMPLE_AREAS, assertNotSample, createSampleRecord, sampleText, sampleTextResult } from "../src/plugin/sampleRecord";
import { EventBus } from "../src/state/events";
import { createLeafStore, createSharedStore } from "../src/state/store";
import { addToken, clearSelection, nextShape, openItem, openTab, pushSheet, removeLastToken, resetDisplay, revealArrivals, setColourMode, setLayer, setLook, setMorph, setPeriod, setScope, setShape, setSheetWidth, sheetBack, sheetForward, soloGroup, stepScope } from "../src/state/actions";
import { captureLeafState, restoreLeafState, savedCamera } from "../src/state/persist";
import { agentChipState, heldArrivals, visibilityParams, waitingTotal } from "../src/state/selectors";
import { defaultView } from "../src/state/types";
import { combineShards, decodeSearchIndex, encodeSearchIndex, readVarint, writeVarint } from "../src/shared/searchCodec";

vi.mock("../src/worker/grouping", async (orig) => {
  const real = await orig<typeof import("../src/worker/grouping")>();
  return {
    ...real,
    // The real dimValue belongs to E8; the query tests only need a faithful stand-in for a few dimensions.
    dimValue: (index: import("../src/shared/index-format").DataIndex, o: number, dim: string): string => {
      if (dim === "space") return SPACE_ORDER[index.cols.space[o]!] ?? "";
      if (dim === "speaker") return ["you", "assistant", "other", "tool"][index.cols.speaker[o]!] ?? "";
      if (dim === "conversation") return index.cols.conv[o] === NONE32 ? "" : index.convs.get(index.cols.conv[o]!).id;
      return "";
    },
  };
});

const tmpRoots: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), `cx-e7-${prefix}-`));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

// ───────────────────────────── fixtures ─────────────────────────────

const T0 = Date.UTC(2026, 10, 3, 14, 0, 0);

function entry(id: string, o: number, extra: Partial<IndexItemInput> = {}): IndexItemInput {
  return {
    id,
    ordinal: o,
    kind: ItemKind.RecordMessage,
    pop: Population.Record,
    source: "claude-code",
    speaker: o % 2 === 0 ? "you" : "assistant",
    space: "roblox",
    folderPath: "proj/a",
    conv: "c_aaaaaaaaaaaaaaaa",
    idx: o,
    t: T0 + o * 60_000,
    tAdded: T0 + o * 60_000,
    chars: 100,
    words: 20,
    flags: 0,
    project: "inventory",
    title: `message ${o}`,
    ...extra,
  };
}

function recordInput(extra: Partial<IndexBuildInput> = {}): IndexBuildInput {
  const items = [entry("e_aaaaaaaaaaaaaaa0", 0), entry("e_aaaaaaaaaaaaaaa1", 1), entry("e_aaaaaaaaaaaaaaa2", 2, { flags: ItemFlag.Undated, t: undefined })];
  items.push({
    id: "n_aaaaaaaaaaaaaaa3",
    ordinal: 4,
    kind: ItemKind.NoteGist,
    pop: Population.Note,
    source: "claude-code",
    speaker: "assistant",
    space: "roblox",
    folderPath: "proj/a",
    conv: "c_aaaaaaaaaaaaaaaa",
    t: T0,
    tAdded: T0 + 3_600_000,
    chars: 400,
    words: 70,
    flags: ItemFlag.MachineWritten,
    title: "Trading slots summary",
    noteKind: "gist",
  });
  return {
    part: "record",
    seq: 7,
    epoch: "ep1",
    items,
    conversations: [{ id: "c_aaaaaaaaaaaaaaaa", title: "Locking trade slots", source: "claude-code", startedAt: T0, endedAt: T0 + 120_000, entryCount: 3, space: "roblox", gist: 4 }],
    noteSources: new Map([["n_aaaaaaaaaaaaaaa3", ["e_aaaaaaaaaaaaaaa0", "e_aaaaaaaaaaaaaaa1", "e_unknownxxxxxxxx"]]]),
    hubMembers: new Map(),
    noteLinks: new Map(),
    labels: [
      { pack: "session", packVersion: "1.0.0", field: "work", type: "enum", values: ["debug", "build"], byTarget: new Map([["e_aaaaaaaaaaaaaaa0", { value: "debug", byUser: false }], ["e_aaaaaaaaaaaaaaa1", { value: "research", byUser: true }]]) },
      { pack: "session", packVersion: "1.0.0", field: "topics", type: "multi", byTarget: new Map([["e_aaaaaaaaaaaaaaa0", { value: ["trade", "slots"], byUser: false }]]) },
    ],
    count: 5,
    ...extra,
  };
}

function vaultInput(): IndexBuildInput {
  return {
    part: "vault",
    seq: 1,
    epoch: "ep1",
    items: [
      {
        id: "w_aaaaaaaaaaaaaaa3",
        ordinal: 3,
        kind: ItemKind.NoteWiki,
        pop: Population.Note,
        source: "obsidian",
        speaker: "you",
        space: "roblox",
        folderPath: "kb/deep/roblox",
        t: T0 - 86_400_000,
        tAdded: T0 - 86_400_000,
        chars: 2000,
        words: 300,
        flags: ItemFlag.Reference,
        layer: 4,
        title: "Inventory API",
        noteKind: "reference",
      },
    ],
    conversations: [],
    noteSources: new Map(),
    hubMembers: new Map(),
    noteLinks: new Map([["w_aaaaaaaaaaaaaaa3", ["n_aaaaaaaaaaaaaaa3"]]]),
    labels: [],
    ordinalOf: (id) => (id === "n_aaaaaaaaaaaaaaa3" ? 4 : undefined),
  };
}

// ───────────────────────────── codec ─────────────────────────────

describe("index codec: parts, the store and merging", () => {
  it("round-trips a record part with columns, strings, conversations, relations and labels", () => {
    const buf = encodeIndex(recordInput());
    const h = readIndexHeader(buf);
    expect(h.magic).toBe("CXI1");
    expect(h.epoch).toBe("ep1");
    expect(h.count).toBe(5);
    expect(h.x.rows).toBe(4);
    for (const b of h.blobs) expect(b.offset % 8).toBe(0);
    const idx = decodeIndex(buf);
    expect(idx.count).toBe(5);
    expect(isAbsent(idx, 3)).toBe(true);
    expect(idx.cols.flags[3]! & ItemFlag.Excluded).toBeTruthy();
    expect(idx.ids.get(1)).toBe("e_aaaaaaaaaaaaaaa1");
    expect(idx.titles.get(4)).toBe("Trading slots summary");
    expect(idx.ordinalOf("n_aaaaaaaaaaaaaaa3")).toBe(4);
    expect(idx.ordinalOf("e_nope")).toBe(-1);
    expect(Number.isNaN(idx.cols.t[2]!)).toBe(true);
    expect(idx.dicts.folders.get(idx.cols.folder[0]!)).toBe("proj/a");
    expect(idx.dicts.projects.get(idx.cols.project[1]!)).toBe("inventory");
    expect(idx.convs.get(idx.cols.conv[0]!).title).toBe("Locking trade slots");
    expect(idx.convs.rowOf("c_aaaaaaaaaaaaaaaa")).toBe(0);
    expect(idx.cols.noteKind[4]).toBe(0);
    expect(idx.cols.noteKind[0]).toBe(NONE8);
    const src = idx.rel.noteSources;
    expect([...src.targets.subarray(src.offsets[4]!, src.offsets[5]!)]).toEqual([0, 1]);
    const work = idx.labels.find((l) => l.field === "work")!;
    expect(work.values[work.single![0]!]).toBe("debug");
    expect(work.values[work.single![1]!]).toBe("research");
    expect(work.byUser[1]).toBe(1);
    expect(work.single![2]).toBe(NONE16);
    const topics = idx.labels.find((l) => l.field === "topics")!;
    const m = topics.multi!;
    expect([...m.targets.subarray(m.offsets[0]!, m.offsets[1]!)].map((v) => topics.values[v])).toEqual(["trade", "slots"]);
    expect(idx.cols.flags[0]! & ItemFlag.HasLabels).toBeTruthy();
    expect(idx.cols.flags[2]! & ItemFlag.HasLabels).toBeFalsy();
    expect(idx.header.stats).toMatchObject({ notes: 1, record: 3, undated: 1, conversations: 1 });
    expect(idx.header.stats.bySource["claude-code"]).toBe(3);
  });

  it("interleaves a vault part at its ordinals and refuses another epoch", () => {
    const record = decodePart(encodeIndex(recordInput()));
    const vault = decodePart(encodeIndex(vaultInput()));
    const store = IndexStore.fromParts([record, vault]);
    const idx = store.snapshot();
    expect(idx.count).toBe(5);
    expect(isAbsent(idx, 3)).toBe(false);
    expect(idx.ids.get(3)).toBe("w_aaaaaaaaaaaaaaa3");
    expect(idx.cols.layer[3]).toBe(4);
    const l = idx.rel.noteLinks;
    expect([...l.targets.subarray(l.offsets[3]!, l.offsets[4]!)]).toEqual([4]);
    expect(idx.header.stats.notes).toBe(2);
    const other = decodePart(encodeIndex({ ...vaultInput(), epoch: "ep2" }));
    expect(() => store.applyPart(other)).toThrow(/E_EPOCH/);
    const merged = mergeIndexes(decodeIndex(encodeIndex(recordInput())), decodeIndex(encodeIndex(vaultInput())));
    expect(merged.ids.get(3)).toBe("w_aaaaaaaaaaaaaaa3");
    expect(merged.ordinalOf("e_aaaaaaaaaaaaaaa2")).toBe(2);
    expect(emptyIndex().count).toBe(0);
  });

  it("applies patch rows, keeps labels for rows another part delivers later, and grows for arrivals", () => {
    const base = decodePart(encodeIndex(recordInput()));
    const store = IndexStore.fromParts([base]);
    const patch = recordInput({
      items: [entry("e_aaaaaaaaaaaaaaa5", 5, { title: "late arrival" })],
      patches: [
        { id: "e_aaaaaaaaaaaaaaa0", ordinal: 0, mask: PATCH_FLAGS | PATCH_TITLE | PATCH_SIZE, flags: ItemFlag.Pinned, title: "renamed", chars: 5, words: 1 },
        { id: "w_aaaaaaaaaaaaaaa3", ordinal: 3, mask: PATCH_LABELS },
      ],
      labels: [{ pack: "placement", packVersion: "1.0.0", field: "role", type: "enum", byTarget: new Map([["w_aaaaaaaaaaaaaaa3", { value: "reference", byUser: false }]]) }],
      count: 6,
    });
    const res = store.applyPart(decodePart(encodeIndex(patch)));
    expect(res).toEqual({ appeared: 1, from: 5, patched: 1 });
    let idx = store.snapshot();
    expect(idx.count).toBe(6);
    expect(idx.titles.get(0)).toBe("renamed");
    expect(idx.cols.chars[0]).toBe(5);
    expect(idx.cols.flags[0]! & ItemFlag.Pinned).toBeTruthy();
    // Labels for ordinal 3 waited until the vault part delivered the row.
    store.applyPart(decodePart(encodeIndex(vaultInput())));
    idx = store.snapshot();
    expect(store.labelsOf(3)).toEqual([{ pack: "placement", field: "role", values: ["reference"], byUser: false }]);
    expect(idx.cols.flags[3]! & ItemFlag.HasLabels).toBeTruthy();
    expect(store.applyFlags(Uint32Array.of(1, 99), Uint32Array.of(ItemFlag.Excluded, 0))).toBe(1);
    expect(store.snapshot().cols.flags[1]! & ItemFlag.Excluded).toBeTruthy();
  });

  it("re-encodes rows and patches from a store and diffs two stores", () => {
    const a = IndexStore.fromParts([decodePart(encodeIndex(recordInput()))]);
    const b = IndexStore.fromParts([decodePart(encodeIndex(recordInput())), decodePart(encodeIndex(vaultInput()))]);
    b.applyFlags(Uint32Array.of(0), Uint32Array.of(ItemFlag.Pinned));
    const d = a.diff(b);
    expect(d.structural).toBe(false);
    expect(d.appeared).toEqual([3]);
    expect(d.from).toBe(3);
    expect(d.patches).toEqual([{ ordinal: 0, mask: PATCH_FLAGS }]);
    const delta = b.encodeRows({ rows: d.appeared, patches: d.patches });
    a.applyPart(decodePart(delta));
    expect(a.diff(b)).toMatchObject({ structural: false, appeared: [], patches: [] });
    const moved = IndexStore.fromParts([decodePart(encodeIndex(recordInput({ items: [entry("e_aaaaaaaaaaaaaaa0", 0, { space: "games" })] })))]);
    expect(IndexStore.fromParts([decodePart(encodeIndex(recordInput()))]).diff(moved).structural).toBe(true);
    const other = new IndexStore({ epoch: "ep9" });
    expect(a.diff(other)).toMatchObject({ structural: true, reason: "epoch" });
  });

  it("rejects damaged files with E_PARSE", () => {
    const buf = encodeIndex(recordInput());
    expect(() => decodePart(new ArrayBuffer(4))).toThrow(/damaged/);
    const bad = buf.slice(0);
    new Uint8Array(bad)[0] = 0x58;
    expect(() => decodePart(bad)).toThrow(/magic/);
    expect(() => decodePart(buf.slice(0, buf.byteLength - 64))).toThrow(/damaged/);
  });
});

// ───────────────────────────── search codec ─────────────────────────────

describe("search shards", () => {
  it("encodes varints and postings, finds terms and prefixes, and masks earlier shards", () => {
    const out: number[] = [];
    writeVarint(out, 300);
    expect(readVarint(Uint8Array.from(out), 0)).toEqual([300, 2]);
    const a = decodeSearchIndex(
      encodeSearchIndex(
        [
          { ordinal: 0, title: "Trade slots", body: "duplication bug in the trade window" },
          { ordinal: 1, title: "", body: "slots locking works" },
          { ordinal: 2, title: "Garden", body: "tomatoes" },
        ],
        { seq: 1, builtAt: "2026-11-09T00:00:00.000Z", epoch: "ep1", key: "e-1" },
      ),
    );
    expect(a.header).toMatchObject({ docs: 3, epoch: "ep1", key: "e-1" });
    const i = a.find("slots");
    expect(i).toBeGreaterThanOrEqual(0);
    expect([...a.postings(i).docs]).toEqual([0, 1]);
    expect([...a.postings(i).fields]).toEqual([1, 2]);
    const [from, to] = a.prefixRange("tra");
    expect(to - from).toBe(1);
    expect(a.find("nothing")).toBe(-1);
    const b = decodeSearchIndex(encodeSearchIndex([{ ordinal: 1, title: "", body: "" }], { seq: 2, builtAt: "2026-11-09T01:00:00.000Z", epoch: "ep1", key: "live" }));
    const all = combineShards([a, b]);
    expect(all.owner(0)).toBe(0);
    expect(all.owner(1)).toBe(1);
    expect(all.owner(9)).toBe(-1);
    expect(all.header).toMatchObject({ docs: 3, seq: 2, epoch: "ep1" });
    expect(() => decodeSearchIndex(new ArrayBuffer(12))).toThrow(/damaged/);
  });
});

// ───────────────────────────── sample record ─────────────────────────────

describe("sample record", () => {
  it("is deterministic, the advertised size, and made of invented areas only", async () => {
    const { buildSampleIndex } = await import("../src/worker/sampleIndex");
    const now = Date.UTC(2026, 10, 9, 12);
    const t0 = performance.now();
    const a = buildSampleIndex(7, now);
    const ms = performance.now() - t0;
    const b = buildSampleIndex(7, now + 3_600_000);
    expect(a.header.epoch).toBe(SAMPLE_EPOCH);
    expect(a.header.stats.record).toBe(SAMPLE_COUNTS.entries);
    expect(a.header.stats.notes).toBe(SAMPLE_COUNTS.notes);
    expect(a.count).toBe(b.count);
    expect(a.ids.get(1234)).toBe(b.ids.get(1234));
    expect(a.titles.get(2000)).toBe(b.titles.get(2000));
    const spaces = new Set<number>();
    for (let o = 0; o < a.count; o++) spaces.add(a.cols.space[o]!);
    expect(spaces.size).toBe(6);
    expect(a.header.stats.lastT).toBeLessThanOrEqual(now + 86_400_000);
    expect(a.header.stats.firstT).toBeGreaterThanOrEqual(now - 3 * 366 * 86_400_000);
    expect(a.labels.map((l) => l.field)).toEqual(["work", "outcome", "project", "topics", "role"]);
    expect(ms).toBeLessThan(5_000);
    const c = buildSampleIndex(8, now);
    expect(c.ids.get(10)).not.toBe(a.ids.get(10));
    expect(sampleIndexInput(7, now).items.length).toBe(SAMPLE_COUNTS.entries + SAMPLE_COUNTS.notes);
  });
});

// ───────────────────────────── corrections fold ─────────────────────────────

let kSeq = 0;
function corr<A extends CorrectionAction>(action: A, target: string, payload: CorrectionRecord<A>["payload"], extra: Partial<CorrectionRecord<A>> = {}): CorrectionRecord<A> {
  kSeq++;
  return { v: 1, id: `k_${String(kSeq).padStart(16, "a")}`.slice(0, 18) as CorrectionRecord["id"], at: new Date(T0 + kSeq * 1000).toISOString(), via: "reader", action, target, payload, ...extra } as CorrectionRecord<A>;
}

describe("corrections fold", () => {
  it("lets an undo withdraw a correction and an undo of an undo restore it", () => {
    const pin = corr("pin", "e_aaaaaaaaaaaaaaa0", {});
    const undo = corr("pin", "e_aaaaaaaaaaaaaaa0", {}, { undoes: pin.id });
    expect(foldCorrections([pin]).pinned.has("e_aaaaaaaaaaaaaaa0")).toBe(true);
    expect(foldCorrections([pin, undo]).pinned.size).toBe(0);
    const redo = corr("pin", "e_aaaaaaaaaaaaaaa0", {}, { undoes: undo.id });
    expect(foldCorrections([pin, undo, redo]).pinned.has("e_aaaaaaaaaaaaaaa0")).toBe(true);
    expect(foldCorrections([corr("pin", "x", {}), corr("unpin", "x", {})]).pinned.size).toBe(0);
  });

  it("keeps edit versions as written, with gaps after an undo, and numbers the next one past every version ever written", () => {
    const sha = (t: string) => sha256Text(t);
    const v2 = corr("edit-text", "e_aaaaaaaaaaaaaaa0", { newText: "two", newTextSha256: sha("two"), fromVersion: 1, version: 2 });
    const v3 = corr("edit-text", "e_aaaaaaaaaaaaaaa0", { newText: "three", newTextSha256: sha("three"), fromVersion: 2, version: 3 });
    const undoV2 = corr("edit-text", "e_aaaaaaaaaaaaaaa0", v2.payload, { undoes: v2.id });
    const eff = foldCorrections([v2, v3, undoV2]);
    expect(eff.edits.get("e_aaaaaaaaaaaaaaa0")?.map((e) => e.version)).toEqual([3]);
    expect(nextVersion([v2, v3, undoV2], "e_aaaaaaaaaaaaaaa0")).toBe(4);
    expect(nextVersion([], "e_aaaaaaaaaaaaaaa0")).toBe(2);
  });

  it("splits a merge by the merge's own id and folds labels, speakers, dates and comments", () => {
    const merge = corr("merge-groups", "space", { dim: "space", from: "web", into: "code" });
    const split = corr("split-group", "space", { mergeCorrectionId: merge.id });
    expect(foldCorrections([merge]).merges).toEqual({ space: { web: "code" } });
    expect(foldCorrections([merge, split]).merges).toEqual({});
    const eff = foldCorrections([
      corr("set-label", "c_aaaaaaaaaaaaaaaa", { pack: "session", packVersion: "1.0.0", field: "work", value: "debug" }),
      corr("set-speaker", "e_aaaaaaaaaaaaaaa1", { speaker: "you" }),
      corr("set-date", "e_aaaaaaaaaaaaaaa1", { writtenAt: null }),
      corr("comment", "n_aaaaaaaaaaaaaaa3", { text: "too vague" }),
    ]);
    expect(eff.userLabels.get("c_aaaaaaaaaaaaaaaa|session|work")).toBe("debug");
    expect(eff.speakers.get("e_aaaaaaaaaaaaaaa1")?.speaker).toBe("you");
    expect(eff.dates.get("e_aaaaaaaaaaaaaaa1")).toBeNull();
    expect(eff.comments.get("n_aaaaaaaaaaaaaaa3")?.[0]?.resolved).toBe(false);
  });

  it("answers one exclusion question for every scope, and Bring back removes the rule", () => {
    const eff = foldCorrections([
      corr("exclude", "c_aaaaaaaaaaaaaaaa", { scope: "conversation" }),
      corr("exclude", "chatgpt", { scope: "source", sourceKind: "chatgpt" }),
      corr("exclude", "private/diary", { scope: "folder", folder: "private/diary" }),
      corr("exclude", "Secret Thing", { scope: "project", project: "Secret Thing" }),
    ]);
    const m = exclusionMatcher(eff);
    const facts = { id: "e_x", source: "claude-code" as const, folder: [] as string[] };
    expect(m({ ...facts, conv: "c_aaaaaaaaaaaaaaaa" })?.scope).toBe("conversation");
    expect(m({ ...facts, source: "chatgpt" })?.scope).toBe("source");
    expect(m({ ...facts, path: "private/diary/2026/a.md" })?.scope).toBe("folder");
    expect(m({ ...facts, folder: ["Private", "Diary"] })?.scope).toBe("folder");
    expect(m({ ...facts, project: "secret thing" })?.scope).toBe("project");
    expect(m({ ...facts, path: "private/diary-old/a.md" })).toBeNull();
    const rule = eff.excluded.get("c_aaaaaaaaaaaaaaaa")!;
    const back = foldCorrections([corr("exclude", "c_aaaaaaaaaaaaaaaa", { scope: "conversation" }, { id: rule.by }), corr("include", "c_aaaaaaaaaaaaaaaa", { excludeCorrectionId: rule.by })]);
    expect(back.excluded.size).toBe(0);
  });
});

// ───────────────────────────── ordinal allocator ─────────────────────────────

describe("ordinal table", () => {
  it("allocates in arrival order, keeps ordinals, and refuses damaged files", () => {
    const t = new OrdinalTable("ep_test");
    expect([t.allocate("e_a"), t.allocate("e_b"), t.allocate("e_a"), t.allocate("w_c")]).toEqual([0, 1, 0, 2]);
    expect(t.get("w_c")).toBe(2);
    expect(t.get("zzz")).toBe(-1);
    const back = OrdinalTable.decode(t.encode());
    expect(back.epoch).toBe("ep_test");
    expect(back.ids).toEqual(["e_a", "e_b", "w_c"]);
    expect(back.allocate("e_d")).toBe(3);
    expect(() => OrdinalTable.decode(new Uint8Array([1, 2, 3]))).toThrow(/ordinal table/);
    const bytes = t.encode();
    bytes[0] = 0x58;
    expect(() => OrdinalTable.decode(bytes)).toThrow(/not an ordinal table/);
    expect(() => t.allocate("bad\nid")).toThrow(/single line/);
    expect(newEpoch(1)).not.toBe(newEpoch(2));
  });
});

// ───────────────────────────── record builder, search builder, services (temp dirs only) ─────────────────────────────

const CONV = "c_aaaaaaaaaaaaaaaa" as const;
const eId = (n: number): EntryRecord["id"] => `e_${"a".repeat(15)}${"bcdefghijklmnopq"[n]}` as EntryRecord["id"];

function entryRec(n: number, text: string, extra: Record<string, unknown> = {}): EntryRecord {
  const sha = sha256Text(text);
  return {
    v: 1, id: eId(n), kind: "message", source: "claude-code", sourceRef: { path: "x.jsonl", nativeId: `n${n}`, sha256: sha }, conv: CONV, idx: n, speaker: n % 2 === 0 ? "you" : "assistant",
    text: { store: "stage", conv: CONV, line: n }, textSha256: sha, chars: text.length, words: text.split(" ").length, dates: [], existedBy: new Date(T0 + n * 60_000).toISOString(),
    addedAt: new Date(T0 + n * 60_000).toISOString(), writtenAt: new Date(T0 + n * 60_000).toISOString(), space: "roblox", folder: ["proj", "a"], project: "inventory", ...extra,
  } as unknown as EntryRecord;
}

async function world() {
  const vault = tmp("vault");
  const cache = tmp("cache");
  const ctx = await openStoreContext({ vaultRoot: vault, cacheDir: cache, owner: "test", log: nullLogger });
  const ledger = createLedgerStore(ctx);
  return { vault, cache, ctx, ledger };
}

const conversationRec = (extra: Record<string, unknown> = {}): ConversationRecord =>
  ({ v: 1, id: CONV, seq: 1, source: "claude-code", nativeId: "x", title: "Locking trade slots", titledBy: "native", startedAt: new Date(T0).toISOString(), endedAt: new Date(T0 + 120_000).toISOString(), entryCount: 3, parts: [], space: "roblox", folder: [], updatedAt: new Date(T0).toISOString(), ...extra }) as ConversationRecord;

const gistRec = (): NoteRecord =>
  ({ v: 1, id: "n_aaaaaaaaaaaaaaa3", seq: 1, kind: "gist", title: "Trading slots summary", text: "Locked the slots while a trade confirms.", file: "wiki/derived/gists/2026/x.md", madeBy: { runId: "r_a", model: "m", engine: "fake", at: new Date(T0 + 3_600_000).toISOString() }, sources: [{ entryId: eId(0), version: 1, quote: "q" }], space: "roblox", folder: ["proj", "a"], state: "current", conv: CONV, date: new Date(T0).toISOString() }) as unknown as NoteRecord;

const labelRec = (id: string, target: string, field: string, value: LabelValue, extra: Record<string, unknown> = {}): LabelRecord =>
  ({ v: 1, id: `l_${id.padEnd(16, "a")}`, target, pack: "session", packVersion: "1.0.0", field, value, state: "set", by: { model: "m", runId: "r_a", engine: "fake" }, at: new Date(T0).toISOString(), ...extra }) as LabelRecord;

function snapshot(extra: Partial<LedgerSnapshot> = {}): LedgerSnapshot {
  return { entries: [entryRec(0, "alpha beta"), entryRec(1, "gamma delta"), entryRec(2, "epsilon", { writtenAt: undefined })], conversations: [conversationRec()], notes: [gistRec()], labels: [], corrections: [], seq: 5, ...extra };
}

function composeWith(snap: LedgerSnapshot) {
  const table = new OrdinalTable("ep_t");
  const input = composeRecordIndex(snap, { epoch: table.epoch, ordinal: (id) => table.allocate(id), peek: (id) => table.get(id), count: () => table.size });
  return { input, table, index: decodeIndex(encodeIndex(input)) };
}

describe("composeRecordIndex", () => {
  it("builds items, flags, relations and the conversation row from the ledgers", () => {
    const { index, table } = composeWith(snapshot());
    expect(index.count).toBe(4);
    expect(table.get(eId(2))).toBe(2);
    expect(index.cols.flags[2]! & ItemFlag.Undated).toBeTruthy();
    expect(index.cols.flags[3]! & ItemFlag.MachineWritten).toBeTruthy();
    expect(index.convs.get(0).gist).toBe(3);
    expect(Array.from(index.rel.noteSources.targets)).toEqual([0]);
    expect(index.header.stats.record).toBe(3);
    expect(index.header.stats.notes).toBe(1);
  });

  it("applies exclusions, pins, hidden traffic, reference documents, supersession and your corrections", () => {
    const snap = snapshot({
      entries: [
        entryRec(0, "keep"),
        entryRec(1, "hidden", { hiddenByDefault: "subagent" }),
        entryRec(2, "doc", { hiddenByDefault: "reference" }),
        entryRec(3, "old"),
        entryRec(4, "new", { supersedes: eId(3) }),
        entryRec(5, "fixed"),
      ],
      corrections: [
        corr("exclude", eId(0), { scope: "entry" }),
        corr("pin", eId(1), {}),
        corr("set-speaker", eId(5), { speaker: "other" }),
        corr("set-date", eId(5), { writtenAt: null }),
        corr("refile", eId(5), { space: "web", folder: ["x"], project: null }),
        corr("edit-text", eId(5), { newText: "one two three four", newTextSha256: sha256Text("one two three four"), fromVersion: 1, version: 2 }),
      ],
      notes: [],
    });
    const { index } = composeWith(snap);
    const f = (n: number) => index.cols.flags[n]!;
    expect(f(0) & ItemFlag.Excluded).toBeTruthy();
    expect(f(1) & (ItemFlag.HiddenByDefault | ItemFlag.Subagent | ItemFlag.Pinned)).toBe(ItemFlag.HiddenByDefault | ItemFlag.Subagent | ItemFlag.Pinned);
    expect(f(2) & ItemFlag.Reference).toBeTruthy();
    expect(f(3) & ItemFlag.Superseded).toBeTruthy();
    expect(f(5) & (ItemFlag.Corrected | ItemFlag.Undated)).toBe(ItemFlag.Corrected | ItemFlag.Undated);
    expect(SPACE_ORDER[index.cols.space[5]!]).toBe("web");
    expect(index.cols.speaker[5]).toBe(2);
    expect(index.cols.words[5]).toBe(4);
    expect(index.header.stats.record).toBe(5);
  });

  it("resolves effective labels: user outranks model, held waits for a confirm, a conversation fans out, vault notes are patched", () => {
    const snap = snapshot({
      labels: [
        labelRec("1", CONV, "work", "build"),
        labelRec("2", CONV, "outcome", "shipped", { state: "held" }),
        labelRec("3", CONV, "topics", ["trade", "slots"]),
        labelRec("4", "w_aaaaaaaaaaaaaaa3", "work", "research"),
        labelRec("5", CONV, "project", "inventory", { state: "refused" }),
      ],
      corrections: [corr("set-label", CONV, { pack: "session", packVersion: "1.0.0", field: "work", value: "debug" })],
    });
    const { index, input } = composeWith(snap);
    const col = (field: string) => index.labels.find((l) => l.field === field);
    const work = col("work")!;
    expect(work.values[work.single![0]!]).toBe("debug");
    expect(work.byUser[0]).toBe(1);
    expect(work.single![3]).not.toBe(NONE16);
    expect(col("outcome")).toBeUndefined();
    expect(col("project")).toBeUndefined();
    expect(col("topics")!.type).toBe("multi");
    expect(input.patches?.map((p) => p.id)).toEqual(["w_aaaaaaaaaaaaaaa3"]);
    expect(index.cols.flags[0]! & ItemFlag.HasLabels).toBeTruthy();
    const confirmed = composeWith(snapshot({ labels: [labelRec("2", CONV, "outcome", "shipped", { state: "held" })], corrections: [corr("confirm", "v_card", { labelId: "l_2aaaaaaaaaaaaaaa" as never })] }));
    expect(confirmed.index.labels.find((l) => l.field === "outcome")).toBeDefined();
    const cleared = composeWith(snapshot({ labels: [labelRec("1", CONV, "work", "build")], corrections: [corr("set-label", CONV, { pack: "session", packVersion: "1.0.0", field: "work", value: null })] }));
    expect(cleared.index.labels.find((l) => l.field === "work")).toBeUndefined();
  });
});

describe("buildRecordIndex and buildSearchIndex", () => {
  const deps = (w: Awaited<ReturnType<typeof world>>) => ({ store: w.ctx, ledger: w.ledger, token: NEVER_CANCELLED, progress: () => undefined, yield: async () => undefined });

  it("writes a base, then deltas that keep every ordinal, then a new epoch on --full", async () => {
    const w = await world();
    await w.ledger.append("entries", [entryRec(0, "alpha beta"), entryRec(1, "gamma delta")]);
    await w.ledger.append("conversations", [conversationRec()]);
    const first = await buildRecordIndex(deps(w), { full: false });
    const layout = cacheLayout(w.cache);
    expect(first.count).toBe(2);
    expect(first.fromCount).toBe(2);
    expect(first.file).toBe(layout.recordIndex);
    const base = decodeIndex(new Uint8Array(readFileSync(layout.recordIndex)).buffer.slice(0) as ArrayBuffer);
    expect(base.ids.get(1)).toBe(eId(1));
    expect(readFileSync(path.join(w.cache, "ordinals.cxo")).length).toBeGreaterThan(8);
    expect(existsSync(layout.recordDelta)).toBe(false);

    await w.ledger.append("entries", [entryRec(2, "epsilon zeta")]);
    await w.ledger.appendCorrections([corr("pin", eId(0), {})]);
    const second = await buildRecordIndex(deps(w), { full: false });
    expect(second.epoch).toBe(first.epoch);
    expect(second.file).toBe(layout.recordDelta);
    expect(second.fromCount).toBe(2);
    expect(second.count).toBe(3);
    expect(second.patched).toBe(1);
    const store = IndexStore.fromParts([decodePart(new Uint8Array(readFileSync(layout.recordIndex)).buffer.slice(0) as ArrayBuffer)], { part: "merged" });
    store.applyPart(decodePart(new Uint8Array(readFileSync(layout.recordDelta)).buffer.slice(0) as ArrayBuffer));
    expect(store.ordinalOf(eId(2))).toBe(2);
    expect(store.ordinalOf(eId(0))).toBe(0);
    expect(store.flagsAt(0) & ItemFlag.Pinned).toBeTruthy();
    const sig = await readSignal(w.cache);
    expect(sig?.changed).toContain("record-delta");

    const full = await buildRecordIndex(deps(w), { full: true });
    expect(full.epoch).not.toBe(first.epoch);
    expect(full.count).toBe(3);
    expect(existsSync(layout.recordDelta)).toBe(false);
  });

  it("builds search shards: closed shards once, a live shard every time, edits and exclusions masking", async () => {
    const w = await world();
    const { stageMessages } = await import("../src/store/stage");
    const msgs = [entryRec(0, "inventory slots locking"), entryRec(1, "trade confirmation window")];
    await stageMessages(w.ctx, CONV, msgs.map((e, i) => ({ line: { v: 1, id: e.id, nid: `n${i}`, conv: CONV, i, ts: e.addedAt, sp: e.speaker, text: i === 0 ? "inventory slots locking" : "trade confirmation window", sha: e.textSha256 } as never, entry: e })));
    await w.ledger.append("entries", [entryRec(0, "inventory slots locking", { addedAt: "2026-10-30T10:00:00.000Z" }), entryRec(1, "trade confirmation window", { addedAt: "2026-11-02T10:00:00.000Z" })]);
    await w.ledger.append("conversations", [conversationRec()]);
    await w.ledger.append("notes", [gistRec()]);
    mkdirSync(path.join(w.vault, "wiki", "concepts"), { recursive: true });
    mkdirSync(path.join(w.vault, "wiki", "derived"), { recursive: true });
    writeFileSync(path.join(w.vault, "wiki", "concepts", "Pricing.md"), "---\ntitle: Marketplace pricing\ntype: concept\n---\nAuction floor price notes.\n");
    writeFileSync(path.join(w.vault, "wiki", "derived", "skip.md"), "machine words xylophone");
    await buildRecordIndex(deps(w), { full: false });
    const r = await buildSearchIndex(deps(w));
    expect(r.docs).toBeGreaterThan(0);
    const dir = cacheLayout(w.cache).searchDir;
    const names = readdirSync(dir).filter((n) => n.endsWith(".cxs")).sort();
    expect(names).toContain("live.cxs");
    expect(names).toContain("vault.cxs");
    expect(names.some((n) => n.startsWith("e-2026-10-"))).toBe(true);
    const load = (n: string) => decodeSearchIndex(new Uint8Array(readFileSync(path.join(dir, n))).buffer.slice(0) as ArrayBuffer);
    const data = combineShards(names.map(load));
    const hits = (term: string) => {
      const out: number[] = [];
      for (const s of data.shards) {
        const i = s.find(term);
        if (i >= 0) for (const d of s.postings(i).docs) if (data.owner(d) === data.shards.indexOf(s)) out.push(d);
      }
      return out;
    };
    expect(hits("inventory")).toEqual([0]);
    expect(hits("auction").length).toBe(1);
    expect(hits("xylophone")).toEqual([]);
    expect(hits("summary").length).toBe(1);
    const closedBefore = statSync(path.join(dir, names.find((n) => n.startsWith("e-2026-10-"))!)).mtimeMs;

    await w.ledger.appendCorrections([corr("exclude", eId(0), { scope: "entry" }), corr("edit-text", eId(1), { newText: "marketplace rewritten text", newTextSha256: sha256Text("marketplace rewritten text"), fromVersion: 1, version: 2 })]);
    await buildSearchIndex(deps(w));
    const data2 = combineShards(readdirSync(dir).filter((n) => n.endsWith(".cxs")).sort().map(load));
    const hits2 = (term: string) => {
      const out: number[] = [];
      for (const s of data2.shards) {
        const i = s.find(term);
        if (i >= 0) for (const d of s.postings(i).docs) if (data2.owner(d) === data2.shards.indexOf(s)) out.push(d);
      }
      return out;
    };
    expect(hits2("inventory")).toEqual([]);
    expect(hits2("confirmation")).toEqual([]);
    expect(hits2("rewritten")).toEqual([1]);
    expect(statSync(path.join(dir, names.find((n) => n.startsWith("e-2026-10-"))!)).mtimeMs).toBe(closedBefore);
  });
});

// ───────────────────────────── vault source ─────────────────────────────

interface FakeFile {
  path: string;
  basename: string;
  extension: string;
  stat: { ctime: number; mtime: number; size: number };
}

function fakeVaultApp(notes: { path: string; fm?: Record<string, unknown>; size?: number; ctime?: number }[], links: Record<string, Record<string, number>> = {}) {
  const files: FakeFile[] = notes.map((n, i) => ({ path: n.path, basename: path.posix.basename(n.path, ".md"), extension: "md", stat: { ctime: n.ctime ?? T0 + i * 1000, mtime: T0 + i * 2000, size: n.size ?? 1200 } }));
  const fm = new Map(notes.map((n) => [n.path, n.fm ?? {}]));
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  const ev = (scope: string) => ({
    on: (name: string, cb: (...a: unknown[]) => void) => {
      const key = `${scope}:${name}`;
      const set = handlers.get(key) ?? new Set();
      set.add(cb);
      handlers.set(key, set);
      return { scope, name, cb };
    },
    offref: (ref: { scope: string; name: string; cb: (...a: unknown[]) => void }) => handlers.get(`${ref.scope}:${ref.name}`)?.delete(ref.cb),
  });
  const app = {
    vault: { ...ev("vault"), getMarkdownFiles: () => files, getAbstractFileByPath: (p: string) => files.find((f) => f.path === p) ?? null, getConfig: (k: string) => (k === "userIgnoreFilters" ? ["_templates/", "/^wiki\\/scratch\\//"] : undefined) },
    metadataCache: { ...ev("meta"), getFileCache: (f: FakeFile) => ({ frontmatter: fm.get(f.path) }), resolvedLinks: links, getFirstLinkpathDest: (name: string) => files.find((f) => f.basename === name) ?? null },
  };
  return { app: app as unknown as VaultApp, files, fire: (scope: string, name: string, ...args: unknown[]) => handlers.get(`${scope}:${name}`)?.forEach((cb) => cb(...args)) };
}

describe("vault source", () => {
  it("builds wiki notes with kinds, flags, layers, areas and undirected links, reusing ordinals", async () => {
    const w = await world();
    const settings = migrateSettingsChecked(undefined).settings;
    const fake = fakeVaultApp(
      [
        { path: "wiki/concepts/Hub.md", fm: { type: "moc", title: "Hub", created: "2026-05-01", layer: 2, related: ["[[Ref]]"] } },
        { path: "wiki/concepts/Ref.md", fm: { type: "roblox-api", status: "reference" } },
        { path: "wiki/concepts/Plain.md", fm: {} },
        { path: "wiki/scratch/Tmp.md", fm: {} },
        { path: "wiki/derived/gists/G.md", fm: { cortex_id: "n_aaaaaaaaaaaaaaa3" } },
        { path: "notes/Outside.md", fm: {} },
        { path: "wiki/concepts/Linker.md", fm: {} },
      ],
      { "wiki/concepts/Linker.md": { "wiki/concepts/Plain.md": 1, "wiki/derived/gists/G.md": 1, "wiki/missing.md": 1 } },
    );
    expect(isIgnoredPath("wiki/scratch/Tmp.md", ["/^wiki\\/scratch\\//"], [])).toBe(true);
    expect(isIgnoredPath("_templates/x.md", ["_templates/"], [])).toBe(true);
    expect(listVaultNotes(fake.app, settings).map((f) => f.path)).toEqual(["wiki/concepts/Hub.md", "wiki/concepts/Ref.md", "wiki/concepts/Plain.md", "wiki/concepts/Linker.md"]);
    const store = { cacheDir: w.cache, owner: "test", lockStaleMs: 60_000 };
    const part = await buildVaultIndex(fake.app, settings, { store, yieldNow: async () => undefined });
    const idx = decodeIndex(part);
    const hub = idx.ordinalOf(wikiNoteId("wiki/concepts/Hub.md"));
    const ref = idx.ordinalOf(wikiNoteId("wiki/concepts/Ref.md"));
    expect(hub).toBe(0);
    expect(idx.cols.layer[hub]).toBe(2);
    expect(idx.cols.noteKind[hub]).toBe(NOTE_KIND_ORDER.indexOf("hub"));
    expect(idx.cols.flags[ref]! & ItemFlag.Reference).toBeTruthy();
    expect(idx.cols.flags[hub]! & ItemFlag.Undated).toBe(0);
    expect(idx.cols.flags[idx.ordinalOf(wikiNoteId("wiki/concepts/Plain.md"))]! & ItemFlag.Undated).toBeTruthy();
    expect(Array.from(idx.rel.noteLinks.targets.slice(idx.rel.noteLinks.offsets[hub]!, idx.rel.noteLinks.offsets[hub + 1]!))).toEqual([ref]);
    const linker = idx.ordinalOf(wikiNoteId("wiki/concepts/Linker.md"));
    const plain = idx.ordinalOf(wikiNoteId("wiki/concepts/Plain.md"));
    expect(Array.from(idx.rel.noteLinks.targets.slice(idx.rel.noteLinks.offsets[plain]!, idx.rel.noteLinks.offsets[plain + 1]!))).toEqual([linker]);
    // a second build keeps every ordinal and the cache key follows the file set
    fake.files.push({ path: "wiki/concepts/New.md", basename: "New", extension: "md", stat: { ctime: T0 + 9e6, mtime: T0 + 9e6, size: 10 } });
    const again = decodeIndex(await buildVaultIndex(fake.app, settings, { store, yieldNow: async () => undefined }));
    expect(again.ordinalOf(wikiNoteId("wiki/concepts/Hub.md"))).toBe(hub);
    expect(again.count).toBeGreaterThan(idx.count);
    expect(vaultCacheKey(fake.app, settings)).not.toBe(JSON.stringify([]));
    settings.sources.vault.enabled = false;
    expect(listVaultNotes(fake.app, settings)).toEqual([]);
  });

  it("places wiki notes by your own wiki folders first, and a change of them makes a new cache key", async () => {
    const w = await world();
    const settings = migrateSettingsChecked(undefined).settings;
    const fake = fakeVaultApp([{ path: "wiki/notes/recipes/Bread.md" }, { path: "wiki/notes/Plain.md" }, { path: "wiki/kb/deep/roblox/Parts.md" }, { path: "wiki/kb/library/ai/Agents.md" }]);
    const store = { cacheDir: w.cache, owner: "test", lockStaleMs: 60_000 };
    const areas = async (s: typeof settings): Promise<Record<string, string | undefined>> => {
      const idx = decodeIndex(await buildVaultIndex(fake.app, s, { store, yieldNow: async () => undefined }));
      return Object.fromEntries(fake.files.map((f) => [f.path, SPACE_ORDER[idx.cols.space[idx.ordinalOf(wikiNoteId(f.path))]!]]));
    };
    expect(await areas(settings)).toEqual({ "wiki/notes/recipes/Bread.md": "vault", "wiki/notes/Plain.md": "vault", "wiki/kb/deep/roblox/Parts.md": "roblox", "wiki/kb/library/ai/Agents.md": "ai" });
    const mine = { ...settings, wikiAreas: [{ folder: "notes", area: "life" as const }, { folder: "kb/deep", area: "code" as const }] };
    // Your rows first (even over the default table's longer kb/deep/roblox), the default table and folder names after.
    expect(await areas(mine)).toEqual({ "wiki/notes/recipes/Bread.md": "life", "wiki/notes/Plain.md": "life", "wiki/kb/deep/roblox/Parts.md": "code", "wiki/kb/library/ai/Agents.md": "ai" });
    expect(vaultCacheKey(fake.app, mine)).not.toBe(vaultCacheKey(fake.app, settings));
  });

  it("asks for a vault rebuild when your wiki folders' areas change, once they settle, and for nothing else", () => {
    vi.useFakeTimers();
    try {
      const sig = signal(migrateSettingsChecked(undefined).settings);
      const io = createNodeIndexIo({ app: fakeVaultApp([]).app, vaultRoot: tmpdir(), cacheDir: tmpdir(), owner: "test", settings: { get value() { return sig.value; }, signal: sig } });
      let n = 0;
      const stop = io.watchVault(() => void n++);
      sig.value = { ...sig.value, general: { ...sig.value.general, openOnStartup: true } };
      vi.advanceTimersByTime(10_000);
      expect(n).toBe(0);
      // Typing a folder saves on every key: one rebuild once the rows stop changing.
      sig.value = { ...sig.value, wikiAreas: [{ folder: "n", area: "life" }] };
      vi.advanceTimersByTime(500);
      sig.value = { ...sig.value, wikiAreas: [{ folder: "notes", area: "life" }] };
      vi.advanceTimersByTime(1999);
      expect(n).toBe(0);
      vi.advanceTimersByTime(1);
      expect(n).toBe(1);
      // The same rows again (a settings object rebuilt around them) are no change.
      sig.value = JSON.parse(JSON.stringify(sig.value)) as typeof sig.value;
      vi.advanceTimersByTime(10_000);
      expect(n).toBe(1);
      stop();
      sig.value = { ...sig.value, wikiAreas: [] };
      vi.advanceTimersByTime(10_000);
      expect(n).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("batches vault changes for the watcher and stops cleanly", () => {
    vi.useFakeTimers();
    try {
      const fake = fakeVaultApp([{ path: "wiki/a.md" }]);
      const seen: string[][] = [];
      const stop = watchVault(fake.app, (files) => seen.push(files.map((f) => f.path)), 50);
      fake.fire("meta", "changed", fake.files[0]);
      fake.fire("vault", "rename", fake.files[0]);
      fake.fire("vault", "create", { path: "wiki/derived/x.md", extension: "md" });
      fake.fire("vault", "create", { path: "other/x.md", extension: "md" });
      vi.advanceTimersByTime(60);
      expect(seen).toEqual([["wiki/a.md"]]);
      stop();
      fake.fire("meta", "changed", fake.files[0]);
      vi.advanceTimersByTime(100);
      expect(seen.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports notes created, changed, renamed or deleted outside wiki/ (the importer's), never wiki/ notes or other files", () => {
    const fake = fakeVaultApp([{ path: "wiki/a.md" }]);
    let n = 0;
    const stop = watchVaultNoteFiles(fake.app, () => void n++);
    fake.fire("vault", "create", { path: "Notes/new note.md", extension: "md" });
    fake.fire("vault", "modify", { path: "Projects/plan.MD", extension: "MD" });
    fake.fire("vault", "delete", { path: "old.md", extension: "md" });
    expect(n).toBe(3);
    // wiki/ notes are the vault part's (watchVault); a picture or a canvas is not a note.
    fake.fire("vault", "create", fake.files[0]);
    fake.fire("vault", "modify", { path: "wiki/derived/maps/x.md", extension: "md" });
    fake.fire("vault", "create", { path: "Projects/photo.png", extension: "png" });
    fake.fire("vault", "modify", { path: "board.canvas", extension: "canvas" });
    expect(n).toBe(3);
    // A note moved out of wiki/ (or into it from outside) changes the importer's side too.
    fake.fire("vault", "rename", { path: "Projects/a.md", extension: "md" }, "wiki/a.md");
    fake.fire("vault", "rename", { path: "wiki/b.md", extension: "md" }, "Projects/b.md");
    fake.fire("vault", "rename", { path: "wiki/c.md", extension: "md" }, "wiki/old-c.md");
    expect(n).toBe(5);
    stop();
    fake.fire("vault", "create", { path: "after.md", extension: "md" });
    expect(n).toBe(5);
  });
});

// ───────────────────────────── correction service ─────────────────────────────

async function correctionWorld() {
  const w = await world();
  const settings = migrateSettingsChecked(undefined).settings;
  let sandbox = false;
  const service = createNodeCorrectionService({
    ctx: w.ctx,
    ledger: w.ledger,
    settings: { value: settings, update: async (fn) => void fn(settings) },
    sandbox: () => sandbox,
  });
  await service.load();
  return { ...w, settings, service, setSandbox: (on: boolean) => (sandbox = on) };
}

describe("correction service", () => {
  it("assigns edit versions under the lock, undoes without renumbering, and refuses in the sample record", async () => {
    const c = await correctionWorld();
    const text = (t: string) => ({ newText: t, newTextSha256: sha256Text(t), fromVersion: 1, version: 0 });
    const a = await c.service.apply({ via: "reader", action: "edit-text", target: eId(0), payload: text("first fix") });
    const b = await c.service.apply({ via: "reader", action: "edit-text", target: eId(0), payload: text("second fix") });
    expect([a.payload.version, b.payload.version]).toEqual([2, 3]);
    await c.service.undo(a.id, "reader");
    expect(c.service.effective().edits.get(eId(0))?.map((e) => e.version)).toEqual([3]);
    const c2 = await c.service.apply({ via: "reader", action: "edit-text", target: eId(0), payload: text("third fix") });
    expect(c2.payload.version).toBe(4);
    await expect(c.service.apply({ via: "reader", action: "edit-text", target: eId(0), payload: { ...text("x"), newTextSha256: "0".repeat(64) } })).rejects.toThrow(/hash/);
    const seen = c.service.version.peek();
    expect((await c.ledger.readCorrections()).length).toBe(c.service.list().length);
    c.setSandbox(true);
    await expect(c.service.apply({ via: "key", action: "pin", target: eId(0), payload: {} })).rejects.toThrow(/sample record/);
    expect(c.service.version.peek()).toBe(seen);
  });

  it("writes the settings exclusion with the correction, lists what is left out, and Bring back reverses both", async () => {
    const c = await correctionWorld();
    const out = await c.service.exclude(CONV, "conversation", "sources");
    const folder = await c.service.exclude("projects/private", "folder", "sources");
    const project = await c.service.exclude("secret-thing", "project", "settings");
    const source = await c.service.exclude("chatgpt", "source", "sources");
    expect(folder.payload.settingsKey).toBe("sources.vault.excludeFolders");
    expect(project.payload.settingsKey).toBe("sources.claudeCode.excludeProjects");
    expect(source.payload.settingsKey).toBeUndefined();
    expect(c.settings.sources.vault.excludeFolders).toContain("projects/private");
    expect(c.settings.sources.claudeCode.excludeProjects).toContain("secret-thing");
    expect(c.service.leftOut().map((x) => x.scope).sort()).toEqual(["conversation", "folder", "project", "source"]);
    await c.service.include(folder.id, "sources");
    expect(c.settings.sources.vault.excludeFolders).not.toContain("projects/private");
    await c.service.undo(project.id, "settings");
    expect(c.settings.sources.claudeCode.excludeProjects).not.toContain("secret-thing");
    expect(c.service.leftOut().map((x) => x.target).sort()).toEqual([CONV, "chatgpt"].sort());
    expect(out.payload.scope).toBe("conversation");
    // undoing the undo puts the exclusion and its settings row back
    const undoRec = c.service.list().find((r) => r.undoes === project.id)!;
    await c.service.undo(undoRec.id, "settings");
    expect(c.settings.sources.claudeCode.excludeProjects).toContain("secret-thing");
    await expect(c.service.include(folder.id, "sources")).rejects.toThrow(/not standing/);
  });

  it("turns a Cortex-written note you leave out into a placeholder and brings it back exactly", async () => {
    const c = await correctionWorld();
    const { renderGistMarkdown, writeDerivedNote } = await import("../src/store/notesWriter");
    const doc = { id: gistRec().id, conv: CONV, title: "Trading slots", space: "roblox", date: new Date(T0).toISOString(), madeBy: { runId: "r_a", model: "m", engine: "fake", at: new Date(T0).toISOString() }, gist: "Locked the slots while a trade confirms.", facets: { topics: [] }, parts: [], addressedComments: [] } as unknown as Parameters<typeof renderGistMarkdown>[0];
    const rendered = renderGistMarkdown(doc, "wiki/derived/gists/2026/aaaaaaaa-trading-slots.md", {});
    const written = await writeDerivedNote(c.ctx, rendered, undefined);
    expect(written.written).toBe(true);
    const note = { ...gistRec(), file: rendered.path, ownedSha256: rendered.ownedSha256 };
    await c.ledger.append("notes", [note as NoteRecord]);
    await c.service.exclude(note.id, "entry", "reader");
    const after = readFileSync(path.join(c.vault, rendered.path), "utf8");
    expect(after).toContain("Left out by you");
    const latest: NoteRecord[] = [];
    for await (const n of c.ledger.readAll("notes")) latest.push(n);
    expect(latest[latest.length - 1]?.state).toBe("excluded");
    const exclusion = c.service.leftOut()[0]!;
    await c.service.include(exclusion.correctionId, "reader");
    expect(readFileSync(path.join(c.vault, rendered.path), "utf8")).toBe(rendered.markdown.replace(/\r\n/g, "\n"));
  });

  it("answers checks as corrections, tags them as one change, and undoes the whole answer", async () => {
    const c = await correctionWorld();
    const lab = (id: string, field: string, value: LabelValue) => ({ field, value, state: "set" as const, labelId: `l_${id.padEnd(16, "a")}` });
    const card = (id: string, kind: ReviewCardRecord["kind"], target: string, proposal: unknown): ReviewCardRecord => ({ v: 1, id: `v_${id.padEnd(16, "a")}` as ReviewCardRecord["id"], kind, target, proposal, createdAt: new Date(T0).toISOString() });
    const labelCard = card("1", "label", CONV, { kind: "label", pack: "session", version: "1.0.0", fields: [lab("1", "work", "build"), lab("2", "outcome", "shipped")] });
    const mention = card("2", "mention", eId(1), { kind: "mention", name: "Ari", quote: "Ari said" });
    const filing = card("3", "filing", eId(0), { kind: "filing", area: "web", folder: "kb/web" });
    const note = card("4", "note", gistRec().id, { kind: "note", noteId: gistRec().id, title: "t", text: "x", notes: 1, dropped: 0 });
    await c.ledger.append("review", [labelCard, mention, filing, note]);

    expect(await c.service.resolveCheck(labelCard.id, { kind: "skip" })).toBeNull();
    await expect(c.service.resolveCheck(labelCard.id, { kind: "change", values: { work: "dance" } })).rejects.toThrow(/does not fit/);
    await expect(c.service.resolveCheck(labelCard.id, { kind: "change", values: { nonsense: "x" } })).rejects.toThrow(/not a field/);
    const changed = await c.service.resolveCheck(labelCard.id, { kind: "change", values: { work: "debug" } });
    expect(changed?.target).toBe(labelCard.id);
    const eff = c.service.effective();
    expect(eff.userLabels.get(`${CONV}|session|work`)).toBe("debug");
    expect(eff.confirmedLabels.has(`l_${"2".padEnd(16, "a")}`)).toBe(true);
    await expect(c.service.resolveCheck(labelCard.id, { kind: "confirm" })).rejects.toThrow(/already answered/);
    await c.service.undo(changed!.id, "checks");
    expect(c.service.effective().userLabels.size).toBe(0);
    expect(c.service.effective().confirmedLabels.size).toBe(0);
    expect(await c.service.resolveCheck(mention.id, { kind: "mention", mine: true })).not.toBeNull();
    expect(c.service.effective().speakers.get(eId(1))?.speaker).toBe("you");
    await c.service.resolveCheck(filing.id, { kind: "confirm" });
    expect(c.service.effective().refiles.get(eId(0))).toEqual({ space: "web", folder: ["kb", "web"] });
    await c.service.resolveCheck(note.id, { kind: "change", values: { comment: "name the decision" } });
    expect(c.service.effective().comments.get(gistRec().id)?.[0]?.text).toBe("name the decision");
    await expect(c.service.resolveCheck(note.id, { kind: "conflict", keep: "mine" })).rejects.toThrow(/already answered|does not fit/);
    const open = (await new LedgerReaderProbe(c.ledger).openCards()).map((x) => x.id);
    expect(open).toEqual([labelCard.id]);
  });
});

describe("Confirm all (batched checks)", () => {
  async function world() {
    const c = await correctionWorld();
    const lab = (id: string, field: string, value: LabelValue) => ({ field, value, state: "set" as const, labelId: `l_${id.padEnd(16, "a")}` });
    const card = (id: string, kind: ReviewCardRecord["kind"], target: string, proposal: unknown): ReviewCardRecord => ({ v: 1, id: `v_${id.padEnd(16, "a")}` as ReviewCardRecord["id"], kind, target, proposal, createdAt: new Date(T0).toISOString() });
    const labelCard = card("1", "label", CONV, { kind: "label", pack: "session", version: "1.0.0", fields: [lab("1", "work", "build"), lab("2", "outcome", "shipped")] });
    const mention = card("2", "mention", eId(1), { kind: "mention", name: "Ari", quote: "Ari said" });
    const filing = card("3", "filing", eId(0), { kind: "filing", area: "web", folder: "kb/web" });
    const note = card("4", "note", gistRec().id, { kind: "note", noteId: gistRec().id, title: "t", text: "x", notes: 1, dropped: 0 });
    await c.ledger.append("review", [labelCard, mention, filing, note]);
    return { c, labelCard, mention, filing, note };
  }

  it("confirms every confirmable card in one append and leaves mentions to you", async () => {
    const { c, labelCard, mention, filing, note } = await world();
    const before = c.service.list().length;
    const spy = vi.spyOn(c.ledger, "appendCorrectionsWith");
    const r = await c.service.confirmChecks([labelCard.id, mention.id, filing.id, note.id, "v_missing"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.confirmed.sort()).toEqual([labelCard.id, filing.id, note.id].sort());
    expect(r.left.sort()).toEqual([mention.id, "v_missing"].sort());
    expect(c.service.list().length).toBe(before + r.ids.length);
    expect(c.service.effective().confirmedLabels.has(`l_${"1".padEnd(16, "a")}`)).toBe(true);
    expect(c.service.effective().refiles.get(eId(0))).toEqual({ space: "web", folder: ["kb", "web"] });
    const open = (await new LedgerReaderProbe(c.ledger).openCards()).map((x) => x.id);
    expect(open).toEqual([mention.id]);
    // a second Confirm all finds nothing left to confirm and writes nothing
    spy.mockClear();
    const again = await c.service.confirmChecks([labelCard.id, filing.id]);
    expect(again.confirmed).toEqual([]);
    expect(again.ids).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("takes a direction into Directions out, and Undo takes it out again", async () => {
    const { c } = await world();
    const dir: ReviewCardRecord = { v: 1, id: `v_${"9".padEnd(16, "a")}` as ReviewCardRecord["id"], kind: "direction", target: "r_directionsrun", proposal: { kind: "direction", purpose: "Plan the week", arm: "record", text: "Try a smaller first step each day" }, createdAt: new Date(T0).toISOString() };
    await c.ledger.append("review", [dir]);
    const { acceptedDirections } = await import("../src/shared/directions");
    const r = await c.service.confirmChecks([dir.id]);
    expect(r.confirmed).toEqual([dir.id]);
    expect(acceptedDirections(c.service.list()).map((d) => d.text)).toEqual(["Try a smaller first step each day"]);
    await c.service.undoMany(r.ids, "checks");
    expect(acceptedDirections(c.service.list())).toEqual([]);
  });

  it("undoes exactly that batch through the corrections log, in one append", async () => {
    const { c, labelCard, mention, filing, note } = await world();
    await c.service.resolveCheck(mention.id, { kind: "mention", mine: false });
    const r = await c.service.confirmChecks([labelCard.id, filing.id, note.id]);
    const spy = vi.spyOn(c.ledger, "appendCorrectionsWith");
    const undone = await c.service.undoMany(r.ids, "checks");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(undone.length).toBe(r.ids.length);
    expect(c.service.effective().confirmedLabels.size).toBe(0);
    expect(c.service.effective().refiles.size).toBe(0);
    // the earlier answer to the mention stands: only the batch went back
    const open = (await new LedgerReaderProbe(c.ledger).openCards()).map((x) => x.id).sort();
    expect(open).toEqual([labelCard.id, filing.id, note.id].sort());
  });
});

/** The Checks page's own rule (E2): a card is open until a standing correction targets it. */
class LedgerReaderProbe {
  constructor(private readonly ledger: LedgerStore) {}
  async openCards(): Promise<ReviewCardRecord[]> {
    const corrections = foldCorrections(await this.ledger.readCorrections());
    void corrections;
    const all = await this.ledger.readCorrections();
    const undone = new Set(all.filter((r) => r.undoes).map((r) => r.undoes));
    const targeted = new Set(all.filter((r) => !r.undoes && !undone.has(r.id)).map((r) => r.target));
    const out: ReviewCardRecord[] = [];
    for await (const c of this.ledger.readAll("review")) if (!targeted.has(c.id)) out.push(c);
    return out;
  }
}

// ───────────────────────────── index service ─────────────────────────────

function fakeShared() {
  return createSharedStore();
}

describe("index service", () => {
  it("loads the cache files into a main-thread copy and the worker, publishes status, and answers meta", async () => {
    const w = await world();
    await w.ledger.append("entries", [entryRec(0, "alpha beta"), entryRec(1, "gamma delta")]);
    await w.ledger.append("conversations", [conversationRec()]);
    await w.ledger.append("notes", [gistRec()]);
    await buildRecordIndex({ store: w.ctx, ledger: w.ledger, token: NEVER_CANCELLED, progress: () => undefined, yield: async () => undefined }, { full: false });
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const bus = new EventBus();
    const loaded: number[] = [];
    bus.on("index:loaded", (e) => loaded.push(e.count));
    const shared = fakeShared();
    const request = vi.fn(async () => ({}) as never);
    const svc = createNodeIndexService({
      app: fakeVaultApp([{ path: "wiki/concepts/Hub.md", fm: { type: "moc" } }]).app,
      vaultRoot: w.vault,
      cacheDir: w.cache,
      owner: "test",
      settings: { value: migrateSettingsChecked(undefined).settings },
      log: nullLogger,
      bus,
      shared,
      runner: { request },
      worker: { call: (async (_v: string, method: string, params: Record<string, unknown>) => void calls.push({ method, params })) as never },
      watch: false,
    });
    await svc.load();
    expect(request).not.toHaveBeenCalled();
    const loadCall = calls.find((c) => c.method === "loadIndex")!;
    expect(loadCall.params.record).toBeInstanceOf(ArrayBuffer);
    expect(loadCall.params.vault).toBeInstanceOf(ArrayBuffer);
    const snap = svc.index.peek()!;
    expect(snap.count).toBe(4);
    expect(shared.get("data")).toMatchObject({ phase: "ready", available: 4, record: 2, notes: 2 });
    expect(loaded).toEqual([4]);
    const meta = svc.meta(0)!;
    expect(meta).toMatchObject({ id: eId(0), population: "record", source: "claude-code", speaker: "you", space: "roblox", folder: "proj/a" });
    expect(meta.conversation).toMatchObject({ id: CONV, title: "Locking trade slots", index: 0, count: 3 });
    expect(svc.meta(2)?.population).toBe("note");
    expect(svc.meta(999)).toBeUndefined();
    expect(svc.ordinalOf(eId(1))).toBe(1);
    expect(svc.ordinalOf("e_nonexistentxxxxx")).toBe(-1);
    // the main-thread copy is not the buffer the worker got
    expect((loadCall.params.record as ArrayBuffer).byteLength).toBeGreaterThan(0);
    svc.dispose();
  });

  it("takes a change of your wiki folders' areas into the loaded index without a restart", async () => {
    const w = await world();
    await w.ledger.append("entries", [entryRec(0, "alpha beta")]);
    await w.ledger.append("conversations", [conversationRec()]);
    await buildRecordIndex({ store: w.ctx, ledger: w.ledger, token: NEVER_CANCELLED, progress: () => undefined, yield: async () => undefined }, { full: false });
    const sig = signal(migrateSettingsChecked(undefined).settings);
    const methods: string[] = [];
    const svc = createNodeIndexService({
      app: fakeVaultApp([{ path: "wiki/notes/recipes/Bread.md" }, { path: "wiki/kb/deep/roblox/Parts.md" }]).app,
      vaultRoot: w.vault,
      cacheDir: w.cache,
      owner: "test",
      settings: {
        get value() {
          return sig.value;
        },
        signal: sig,
      },
      log: nullLogger,
      bus: new EventBus(),
      shared: fakeShared(),
      runner: { request: vi.fn(async () => ({}) as never) },
      worker: { call: (async (_v: string, method: string) => void methods.push(method)) as never },
      watchDebounceMs: 10,
    });
    try {
      await svc.load();
      const areaOf = (p: string): string | undefined => svc.meta(svc.ordinalOf(wikiNoteId(p)))?.space;
      const both = (): (string | undefined)[] => [areaOf("wiki/notes/recipes/Bread.md"), areaOf("wiki/kb/deep/roblox/Parts.md")];
      expect(both()).toEqual(["vault", "roblox"]);
      const loads = (): number => methods.filter((m) => m === "loadIndex").length;
      const first = loads();
      // Another setting changing rebuilds nothing.
      sig.value = { ...sig.value, general: { ...sig.value.general, openOnStartup: true } };
      await new Promise((r) => setTimeout(r, 80));
      expect(loads()).toBe(first);
      sig.value = { ...sig.value, wikiAreas: [{ folder: "notes", area: "life" }, { folder: "kb/deep", area: "code" }] };
      await vi.waitFor(() => expect(both()).toEqual(["life", "code"]), { timeout: 5000, interval: 20 });
      // The worker was given the index again, so the figure is placed with the new areas.
      expect(loads()).toBeGreaterThan(first);
    } finally {
      svc.dispose();
    }
  });

  it("rebuilds after imports: a committed batch is signalled, and commits the signal never heard of still count as stale", async () => {
    const w = await world();
    await w.ledger.append("entries", [entryRec(0, "alpha beta")]);
    await w.ledger.append("conversations", [conversationRec()]);
    const built = await buildRecordIndex({ store: w.ctx, ledger: w.ledger, token: NEVER_CANCELLED, progress: () => undefined, yield: async () => undefined }, { full: false });
    const io = createNodeIndexIo({ app: fakeVaultApp([]).app, vaultRoot: w.vault, cacheDir: w.cache, owner: "test", settings: { value: migrateSettingsChecked(undefined).settings } });
    expect(await io.isStale(built.seq)).toBe(false);
    // An import through the ledger now marks "entries" past the build: stale.
    await w.ledger.append("entries", [entryRec(1, "gamma delta")]);
    expect(await io.isStale(built.seq)).toBe(true);
    const rebuilt = await buildRecordIndex({ store: w.ctx, ledger: w.ledger, token: NEVER_CANCELLED, progress: () => undefined, yield: async () => undefined }, { full: false });
    expect(await io.isStale(rebuilt.seq)).toBe(false);
    // A run record moves the seq but never the index: still fresh.
    await w.ledger.append("runs", [{ v: 1, id: "r_aaaaaaaaaaaaaaaa" } as never]);
    expect(await io.isStale(rebuilt.seq)).toBe(false);
    // A runner from before every commit signalled: the ledger seq moved past the index and the signal.
    const seqFile = path.join(w.vault, ".vault-meta", "cortex", "state", "seq.json");
    const cur = JSON.parse(readFileSync(seqFile, "utf8")) as { seq: number };
    writeFileSync(seqFile, JSON.stringify({ seq: cur.seq + 7, at: new Date(T0).toISOString() }));
    expect(await io.isStale(rebuilt.seq)).toBe(true);
    // The build that follows changes nothing (no new entries), yet it records that the index is current: without
    // that signal every later start would build again. The stale check reads the base file's own header, as doLoad does.
    const noop = await buildRecordIndex({ store: w.ctx, ledger: w.ledger, token: NEVER_CANCELLED, progress: () => undefined, yield: async () => undefined }, { full: false });
    expect(noop.patched).toBe(0);
    const baseSeq = readIndexHeader(new Uint8Array(readFileSync(path.join(w.cache, "record.cxi"))).buffer).seq;
    expect(baseSeq).toBeLessThan(cur.seq + 7);
    expect(await io.isStale(baseSeq)).toBe(false);
  });

  it("marks the index current after a build that finds nothing to change, so a covered change mark stops reading stale", async () => {
    const w = await world();
    await w.ledger.append("entries", [entryRec(0, "alpha beta")]);
    await w.ledger.append("conversations", [conversationRec()]);
    const deps = { store: w.ctx, ledger: w.ledger, token: NEVER_CANCELLED, progress: () => undefined, yield: async () => undefined };
    await buildRecordIndex(deps, { full: false });
    const io = createNodeIndexIo({ app: fakeVaultApp([]).app, vaultRoot: w.vault, cacheDir: w.cache, owner: "test", settings: { value: migrateSettingsChecked(undefined).settings } });
    const baseSeq = readIndexHeader(new Uint8Array(readFileSync(path.join(w.cache, "record.cxi"))).buffer).seq;
    expect(await io.isStale(baseSeq)).toBe(false);
    // A change mark the index turns out to reflect already (here a bare "labels" signal with no label behind it).
    await writeSignal(w.cache, { seq: 0, changed: ["labels"], by: "test" });
    expect(await io.isStale(baseSeq)).toBe(true);
    const noop = await buildRecordIndex(deps, { full: false });
    expect(noop.patched).toBe(0);
    expect((await readSignal(w.cache))?.changed).toEqual(["record-checked"]);
    expect(await io.isStale(baseSeq)).toBe(false);
  });

  it("names a batch committed during a build again after the build's own signal, so it is built next time", async () => {
    const w = await world();
    await w.ledger.append("entries", [entryRec(0, "alpha beta")]);
    await w.ledger.append("conversations", [conversationRec()]);
    const io = createNodeIndexIo({ app: fakeVaultApp([]).app, vaultRoot: w.vault, cacheDir: w.cache, owner: "test", settings: { value: migrateSettingsChecked(undefined).settings } });
    let once = true;
    // deps.yield runs between the ledger scan and writing the index: an import lands right there.
    const built = await buildRecordIndex(
      {
        store: w.ctx,
        ledger: w.ledger,
        token: NEVER_CANCELLED,
        progress: () => undefined,
        yield: async () => {
          if (!once) return;
          once = false;
          await w.ledger.append("entries", [entryRec(1, "gamma delta")]);
        },
      },
      { full: false },
    );
    const sig = await readSignal(w.cache);
    expect(sig?.changed).toEqual(["entries"]);
    expect(sig?.marks.entries).toBeGreaterThan(sig?.marks["record-index"] ?? 0);
    expect(await io.isStale(built.seq)).toBe(true);
    // The next build includes it and says nothing more.
    const next = await buildRecordIndex({ store: w.ctx, ledger: w.ledger, token: NEVER_CANCELLED, progress: () => undefined, yield: async () => undefined }, { full: false });
    expect(next.count).toBe(built.count + 1);
    expect((await readSignal(w.cache))?.changed).not.toContain("entries");
    expect(await io.isStale(next.seq)).toBe(false);
  });

  it("lets live messages staged on this computer into the index, flagged Live, and their staging marks it stale", async () => {
    const w = await world();
    await w.ledger.append("entries", [entryRec(0, "alpha beta", { text: { store: "segment", seg: "x.jsonl", line: 0 } })]);
    await w.ledger.append("conversations", [conversationRec()]);
    const deps = { store: w.ctx, ledger: w.ledger, token: NEVER_CANCELLED, progress: () => undefined, yield: async () => undefined };
    const first = await buildRecordIndex(deps, { full: false });
    const io = createNodeIndexIo({ app: fakeVaultApp([]).app, vaultRoot: w.vault, cacheDir: w.cache, owner: "test", settings: { value: migrateSettingsChecked(undefined).settings } });
    const baseSeq = () => readIndexHeader(new Uint8Array(readFileSync(path.join(w.cache, "record.cxi"))).buffer).seq;
    expect(await io.isStale(baseSeq())).toBe(false);
    const text = "live gamma";
    const line = { v: 1, id: eId(1), nid: "n1", conv: CONV, i: 1, ts: new Date(T0 + 60_000).toISOString(), sp: "assistant", text, sha: sha256Text(text) } as unknown as SegmentLine;
    expect(await stageMessages(w.ctx, CONV, [{ line, entry: entryRec(1, text) }])).toBe(1);
    // No ledger commit, yet the staging names itself: the plugin builds again.
    expect((await readSignal(w.cache))?.changed).toEqual(["staged"]);
    expect(await io.isStale(baseSeq())).toBe(true);
    const next = await buildRecordIndex(deps, { full: true });
    expect(next.count).toBe(first.count + 1);
    const store = IndexStore.fromParts([decodePart(new Uint8Array(readFileSync(path.join(w.cache, "record.cxi"))).buffer)]);
    const live = store.ordinalOf(eId(1));
    expect(live).toBeGreaterThanOrEqual(0);
    expect(store.flagsAt(live) & ItemFlag.Live).toBeTruthy();
    expect(store.flagsAt(store.ordinalOf(eId(0))) & ItemFlag.Live).toBe(0);
    expect(await io.isStale(baseSeq())).toBe(false);
    // Sealed later: the same id moves into the ledger, keeps its ordinal, and the next build only patches its flags.
    await sealStage(w.ctx, CONV, { ledger: w.ledger });
    expect(await io.isStale(baseSeq())).toBe(true);
    const sealed = await buildRecordIndex(deps, { full: false });
    expect(sealed.file).toBe(cacheLayout(w.cache).recordDelta);
    expect(sealed.patched).toBeGreaterThan(0);
    expect(sealed.count).toBe(next.count);
    const merged = IndexStore.fromParts([
      decodePart(new Uint8Array(readFileSync(path.join(w.cache, "record.cxi"))).buffer),
      decodePart(new Uint8Array(readFileSync(cacheLayout(w.cache).recordDelta)).buffer),
    ]);
    expect(merged.ordinalOf(eId(1))).toBe(live);
    expect(merged.flagsAt(live) & ItemFlag.Live).toBe(0);
  });

  it("never runs two runner builds at once, and runs one asked for meanwhile once afterwards", async () => {
    const w = await world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let builds = 0;
    let running = 0;
    let maxRunning = 0;
    const request = vi.fn(async (req: { cmd: string }) => {
      if (req.cmd !== "index.build") return {} as never;
      builds++;
      running++;
      maxRunning = Math.max(maxRunning, running);
      if (builds === 2) await gate;
      running--;
      return {} as never;
    });
    const svc = createNodeIndexService({
      app: fakeVaultApp([]).app,
      vaultRoot: w.vault,
      cacheDir: w.cache,
      owner: "test",
      settings: { value: migrateSettingsChecked(undefined).settings },
      log: nullLogger,
      bus: new EventBus(),
      shared: fakeShared(),
      runner: { request: request as never },
      worker: { call: (async () => undefined) as never },
      watch: false,
      buildDebounceMs: 0,
      buildGapMs: 0,
    });
    await svc.load(); // no record index yet: build 1
    expect(builds).toBe(1);
    const first = svc.requestBuild(); // build 2, held open
    await Promise.resolve();
    void svc.requestBuild(); // asked for meanwhile: runs once afterwards
    void svc.requestBuild();
    // A forced reload during the build must not start a second one: it loads what is there and asks for a rerun.
    await svc.load({ force: true }).catch(() => undefined);
    expect(builds).toBe(2);
    expect(maxRunning).toBe(1);
    release();
    await first;
    await new Promise((r) => setTimeout(r, 30));
    expect(maxRunning).toBe(1);
    expect(builds).toBe(3);
    svc.dispose();
  });

  it("asks the runner to build when there is no record index, and shows an empty index when it cannot", async () => {
    const w = await world();
    const request = vi.fn(async () => {
      throw new Error("runner offline");
    });
    const shared = fakeShared();
    const calls: string[] = [];
    const svc = createNodeIndexService({
      app: fakeVaultApp([]).app,
      vaultRoot: w.vault,
      cacheDir: w.cache,
      owner: "test",
      settings: { value: migrateSettingsChecked(undefined).settings },
      log: nullLogger,
      bus: new EventBus(),
      shared,
      runner: { request: request as never },
      worker: { call: (async (_v: string, method: string) => void calls.push(method)) as never },
      watch: false,
    });
    await svc.load();
    expect(request).toHaveBeenCalledWith({ cmd: "index.build", args: { full: false } }, expect.anything());
    expect(shared.get("data").phase).toBe("empty");
    expect(svc.index.peek()?.count).toBe(0);
    expect(shared.get("activity").jobs).toEqual([]);
    // CORTEX-UX 5.31: no earlier index, so the "nothing is lost" variant is raised
    expect(shared.get("data").failure).toBe("none");
    expect(shared.get("activity").lastWarning).toBe("index-failed");
    svc.dispose();
  });

  it("raises index-failed with the last good index shown, and clears it when a rebuild works (CORTEX-UX 5.31)", async () => {
    const w = await world();
    await w.ledger.append("entries", [entryRec(0, "alpha beta")]);
    await w.ledger.append("conversations", [conversationRec()]);
    await buildRecordIndex({ store: w.ctx, ledger: w.ledger, token: NEVER_CANCELLED, progress: () => undefined, yield: async () => undefined }, { full: false });
    let broken = true;
    const request = vi.fn(async () => {
      if (broken) throw new Error("runner offline");
      return {} as never;
    });
    const shared = fakeShared();
    const svc = createNodeIndexService({
      app: fakeVaultApp([]).app,
      vaultRoot: w.vault,
      cacheDir: w.cache,
      owner: "test",
      settings: { value: migrateSettingsChecked(undefined).settings },
      log: nullLogger,
      bus: new EventBus(),
      shared,
      runner: { request: request as never },
      worker: { call: (async () => undefined) as never },
      watch: false,
    });
    expect(shared.get("data").failure).toBeUndefined();
    await svc.load({ force: true });
    expect(shared.get("data")).toMatchObject({ phase: "ready", failure: "last-good" });
    expect(shared.get("activity").lastWarning).toBe("index-failed");
    expect(svc.index.peek()?.count).toBe(1);
    broken = false;
    await svc.requestBuild();
    expect(shared.get("data").failure).toBeUndefined();
    expect(shared.get("activity").lastWarning).toBeUndefined();
    svc.dispose();
  });

  it("treats a runner lock held by another build as busy, not failed, and builds again after the gap", async () => {
    const w = await world();
    await w.ledger.append("entries", [entryRec(0, "alpha beta")]);
    await w.ledger.append("conversations", [conversationRec()]);
    await buildRecordIndex({ store: w.ctx, ledger: w.ledger, token: NEVER_CANCELLED, progress: () => undefined, yield: async () => undefined }, { full: false });
    let busy = true;
    let builds = 0;
    const request = vi.fn(async (req: { cmd: string }) => {
      if (req.cmd === "index.build") {
        builds++;
        if (busy) throw new CortexError("E_LOCKED", "lock busy", { retryable: true });
      }
      return {} as never;
    });
    const warn = vi.fn();
    const shared = fakeShared();
    const svc = createNodeIndexService({
      app: fakeVaultApp([]).app,
      vaultRoot: w.vault,
      cacheDir: w.cache,
      owner: "test",
      settings: { value: migrateSettingsChecked(undefined).settings },
      log: { ...nullLogger, warn },
      bus: new EventBus(),
      shared,
      runner: { request: request as never },
      worker: { call: (async () => undefined) as never },
      watch: false,
      // Busy retries are spaced by the debounce here (the gap is 0), and the service gives up after six in a row. At
      // 40 ms that was about a quarter second, so a slow load under a full parallel suite ran out of retries and
      // reported a failure; 300 ms keeps six retries well beyond any load (production spaces them 10 s apart).
      buildDebounceMs: 300,
      buildGapMs: 0,
    });
    await svc.load({ force: true });
    expect(shared.get("data").failure).toBeUndefined();
    expect(shared.get("activity").lastWarning).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(svc.index.peek()?.count).toBe(1);
    busy = false;
    // It tries again once the other build is gone. Wait for it rather than sleeping a fixed 200 ms: under a loaded
    // full-suite run the debounce and the retry can take longer, which made this test flaky.
    await vi.waitFor(() => expect(builds).toBeGreaterThanOrEqual(2), { timeout: 5000, interval: 25 });
    expect(shared.get("data").failure).toBeUndefined();
    svc.dispose();
  });

  it("marks a load that throws as failed and keeps the error phase", async () => {
    const w = await world();
    await w.ledger.append("entries", [entryRec(0, "alpha beta")]);
    await w.ledger.append("conversations", [conversationRec()]);
    await buildRecordIndex({ store: w.ctx, ledger: w.ledger, token: NEVER_CANCELLED, progress: () => undefined, yield: async () => undefined }, { full: false });
    const shared = fakeShared();
    const svc = createNodeIndexService({
      app: fakeVaultApp([]).app,
      vaultRoot: w.vault,
      cacheDir: w.cache,
      owner: "test",
      settings: { value: migrateSettingsChecked(undefined).settings },
      log: nullLogger,
      bus: new EventBus(),
      shared,
      runner: { request: (async () => ({})) as never },
      worker: { call: (async () => { throw new Error("worker gone"); }) as never },
      watch: false,
    });
    await expect(svc.load()).rejects.toBeTruthy();
    expect(shared.get("data")).toMatchObject({ phase: "error", failure: "none" });
    expect(shared.get("activity").lastWarning).toBe("index-failed");
    svc.dispose();
  });

  it("appends the runner's delta when the signal says so, and the sample record swaps the index and back", async () => {
    const w = await world();
    await w.ledger.append("entries", [entryRec(0, "alpha beta")]);
    await w.ledger.append("conversations", [conversationRec()]);
    const rd = { store: w.ctx, ledger: w.ledger, token: NEVER_CANCELLED, progress: () => undefined, yield: async () => undefined };
    await buildRecordIndex(rd, { full: false });
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const bus = new EventBus();
    const arrivals: number[] = [];
    bus.on("arrivals", (e) => arrivals.push(e.added));
    const svc = createNodeIndexService({
      app: fakeVaultApp([]).app,
      vaultRoot: w.vault,
      cacheDir: w.cache,
      owner: "test",
      settings: { value: migrateSettingsChecked(undefined).settings },
      log: nullLogger,
      bus,
      shared: fakeShared(),
      runner: { request: (async () => ({})) as never },
      worker: { call: (async (_v: string, method: string, params: Record<string, unknown>) => void calls.push({ method, params })) as never },
      buildDebounceMs: 60_000,
    });
    await svc.load();
    const epoch = svc.epoch;
    await w.ledger.append("entries", [entryRec(1, "gamma delta")]);
    await buildRecordIndex(rd, { full: false });
    for (let i = 0; i < 60 && !calls.some((c) => c.method === "appendIndex"); i++) await new Promise((r) => setTimeout(r, 100));
    const append = calls.find((c) => c.method === "appendIndex");
    expect(append?.params).toMatchObject({ epoch, fromCount: 1 });
    expect(svc.index.peek()?.count).toBe(2);
    expect(arrivals).toEqual([1]);

    await svc.showSample(true, 7);
    expect(svc.epoch).toBe(SAMPLE_EPOCH);
    expect(svc.index.peek()?.header.stats.record).toBe(SAMPLE_COUNTS.entries);
    expect(calls.some((c) => c.method === "loadSample")).toBe(true);
    await svc.showSample(false);
    expect(svc.epoch).toBe(epoch);
    expect(svc.index.peek()?.count).toBe(2);
    svc.dispose();
  }, 20_000);

  it("overlays pins and exclusions on the flags and takes them back when the correction goes", () => {
    const { index } = composeWith(snapshot());
    const store = IndexStore.fromParts([decodePart(encodeIndex(composeWith(snapshot()).input))], { part: "merged" });
    const tracked = { excluded: new Set<number>(), pinned: new Set<number>() };
    const eff = foldCorrections([corr("pin", eId(0), {}), corr("exclude", CONV, { scope: "conversation" })]);
    const first = overlayFlags(store, eff, tracked);
    expect(first.ordinals.sort()).toEqual([0, 1, 2]);
    store.applyFlags(first.ordinals, first.flags);
    expect(store.flagsAt(0) & (ItemFlag.Pinned | ItemFlag.Excluded)).toBe(ItemFlag.Pinned | ItemFlag.Excluded);
    expect(store.flagsAt(3) & ItemFlag.Excluded).toBe(0);
    const second = overlayFlags(store, foldCorrections([]), tracked);
    store.applyFlags(second.ordinals, second.flags);
    expect(store.flagsAt(0) & (ItemFlag.Pinned | ItemFlag.Excluded)).toBe(0);
    expect(index.count).toBe(4);
  });
});

describe("sample record controller", () => {
  it("enters after the index shows it, leaves before writes are allowed again, and refuses writes meanwhile", async () => {
    const sandbox = signal(false);
    const order: string[] = [];
    const ctl = createSampleRecord({
      index: { showSample: async (on) => void order.push(`index:${on}`) },
      setSandbox: (on) => {
        order.push(`sandbox:${on}`);
        sandbox.value = on;
      },
      sandbox,
    });
    await ctl.enter();
    await ctl.enter();
    expect(ctl.active).toBe(true);
    expect(() => assertNotSample(() => sandbox.peek())).toThrow(/sample record/);
    await ctl.toggle();
    expect(order).toEqual(["index:true", "sandbox:true", "index:false", "sandbox:false"]);
    expect(() => assertNotSample(() => sandbox.peek())).not.toThrow();
    expect(sampleText(5)).toBe(sampleText(5));
    expect(sampleText(5)).not.toBe(sampleText(6));
    expect(SAMPLE_AREAS).toEqual(["Garden", "Studio", "Ledger", "Workshop", "Travel", "Reading"]);
    expect(sampleTextResult(3)).toMatchObject({ ok: true, version: 1 });
  });
});

// ───────────────────────────── state: stores, actions, selectors, events, persistence ─────────────────────────────

describe("leaf state", () => {
  const settings = migrateSettingsChecked(undefined).settings;

  it("keeps tabs, the sheet stack (≤ 12, forward history dropped), width, tokens, period and scope", () => {
    const store = createLeafStore({ view: defaultView(settings) });
    openTab(store, "read");
    expect(store.get("ui").sheet).toMatchObject({ open: true, index: 0, stack: [{ kind: "page", route: "read" }] });
    for (let i = 0; i < 14; i++) pushSheet(store, { kind: "reader", route: "entry", id: `e_${i}` });
    expect(store.get("ui").sheet.stack.length).toBe(12);
    sheetBack(store);
    sheetBack(store);
    sheetForward(store);
    expect(store.get("ui").sheet.index).toBe(10);
    pushSheet(store, { kind: "reader", route: "note", id: "n_x" });
    expect(store.get("ui").sheet.stack.length).toBe(12);
    expect(store.get("ui").sheet.stack[11]).toMatchObject({ id: "n_x" });
    setSheetWidth(store, 9999);
    expect(store.get("ui").sheet.width).toBe(560);
    setSheetWidth(store, 10);
    expect(store.get("ui").sheet.width).toBe(340);
    openTab(store, "brain");
    expect(store.get("ui").sheet.open).toBe(false);
    addToken(store, { id: "t1", kind: "text", label: "slots", text: "slots" });
    addToken(store, { id: "t1", kind: "text", label: "slots2", text: "slots" });
    addToken(store, { id: "t2", kind: "group", label: "Roblox", dim: "space", value: "roblox" });
    expect(store.get("ui").tokens.map((t) => t.label)).toEqual(["slots2", "Roblox"]);
    removeLastToken(store);
    openItem(store, 5, "e_five");
    clearSelection(store);
    expect(store.get("ui").tokens.length).toBe(1);
    expect(store.get("selection")).toBeNull();
    setPeriod(store, [1, 2]);
    setScope(store, "web");
    expect(stepScope(["code", "web", "data"], "web", 1)).toBe("data");
    expect(stepScope(["code", "web", "data"], "all", -1)).toBe("data");
    expect(nextShape("body", true)).toBe("groups");
    expect(nextShape("groups", false)).toBe("body");
    const before = store.snapshot();
    setShape(store, "groups");
    setMorph(store, 5);
    expect(store.get("view").morph).toBe(1);
    store.restore(before);
    expect(store.get("view").shape).toBe("body");
  });

  it("solos and restores groups, resets the display, and derives visibility, held arrivals and the agent chip", () => {
    const store = createLeafStore({ view: defaultView(settings) });
    soloGroup(store, "space=web", ["space=web", "space=code", "space=data"]);
    expect(store.get("ui").hiddenGroups).toEqual(["space=code", "space=data"]);
    soloGroup(store, "space=web", ["space=web", "space=code", "space=data"]);
    expect(store.get("ui").hiddenGroups).toEqual([]);
    setLayer(store, "reference", true);
    setLook(store, { glow: 2 });
    resetDisplay(store, defaultView(settings));
    expect(store.get("view").layers.reference).toBe(false);
    expect(store.get("view").look.glow).toBe(settings.appearance.glow);
    revealArrivals(store, 10);
    expect(heldArrivals(store.get("ui"), 14)).toBe(4);
    expect(heldArrivals(store.get("ui"), 3)).toBe(0);
    expect(visibilityParams(store.get("ui"), store.get("view"))).toMatchObject({ scope: "all", period: null, revealedCount: 10, reference: false });
    expect(waitingTotal({ label: 3, summaries: 2, maps: 1, checks: 9, bySource: {} })).toBe(6);
    const shared = createSharedStore();
    expect(agentChipState(shared.get("activity"))).toBe("idle");
    shared.update("activity", { engine: "auth" });
    expect(agentChipState(shared.get("activity"))).toBe("sign-in");
    shared.update("activity", { engine: "ok", paused: true });
    expect(agentChipState(shared.get("activity"))).toBe("paused");
  });

  it("round-trips through capture and restore, and falls back field by field on garbage", () => {
    const a = createLeafStore({ view: defaultView(settings) });
    openTab(a, "time");
    pushSheet(a, { kind: "reader", route: "conversation", id: "c_aaaaaaaaaaaaaaaa" });
    addToken(a, { id: "t1", kind: "text", label: "slots", text: "slots" });
    setPeriod(a, [10, 20]);
    setShape(a, "groups");
    setColourMode(a, "record", { kind: "single", slot: 3 });
    const camera = { yawDeg: 10, pitchDeg: -5, distance: 1.5, target: [0, 1, 2] as [number, number, number] };
    const saved = JSON.parse(JSON.stringify(captureLeafState(a, camera)));
    const b = createLeafStore();
    restoreLeafState(b, saved, settings);
    expect(b.get("ui")).toMatchObject({ tab: "time", period: [10, 20], tokens: [{ id: "t1" }] });
    expect(b.get("ui").sheet.stack).toEqual(a.get("ui").sheet.stack);
    expect(b.get("view")).toEqual(a.get("view"));
    expect(savedCamera(saved)).toEqual(camera);

    const c = createLeafStore();
    restoreLeafState(c, { v: 1, tab: "nowhere", scope: 42, period: [5, 1], keyCollapsed: "yes", tokens: [{ nope: 1 }, { id: "ok", kind: "text", label: "fine" }], sheet: { open: true, width: 99999, index: 40, stack: [{ kind: "page", route: "bogus" }, { kind: "reader", route: "entry", id: "e_1" }, "junk"] }, view: { shape: "cube", morph: 7, look: { glow: "bright", dotSize: 99 }, layers: { notes: "no" }, colour: { notes: { kind: "categorical", dim: "bad dim" } }, chart: { chart: "nope" } } }, settings);
    expect(c.get("ui")).toMatchObject({ tab: "brain", scope: "all", period: null, keyCollapsed: false });
    expect(c.get("ui").tokens.map((t) => t.id)).toEqual(["ok"]);
    expect(c.get("ui").sheet).toMatchObject({ open: true, width: 560, index: 0 });
    expect(c.get("ui").sheet.stack).toEqual([{ kind: "reader", route: "entry", id: "e_1" }]);
    const v = c.get("view");
    expect(v.shape).toBe("body");
    expect(v.morph).toBe(1);
    expect(v.look.glow).toBe(defaultView(settings).look.glow);
    expect(v.look.dotSize).toBe(4);
    expect(v.layers.notes).toBe(true);
    expect(v.colour.notes).toEqual(defaultView(settings).colour.notes);
    expect(v.chart).toBeNull();

    const d = createLeafStore();
    restoreLeafState(d, "garbage", settings);
    expect(d.get("view")).toEqual(defaultView(settings));
    expect(savedCamera({ camera: { yawDeg: "x" } })).toBeNull();
  });

  it("isolates event handlers, supports once and unsubscribe", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    bus.on("settings:changed", () => {
      throw new Error("bad handler");
    });
    const off = bus.on("settings:changed", () => seen.push("a"));
    bus.once("settings:changed", () => seen.push("once"));
    bus.emit("settings:changed", {});
    bus.emit("settings:changed", {});
    off();
    bus.emit("settings:changed", {});
    bus.emit("arrivals", { added: 1, available: 2 });
    bus.emit("command", { viewId: "v", id: "save-image" });
    expect(seen).toEqual(["a", "once", "a"]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
