/**
 * Agents > Ledger: schemas you build (shared/schemas.ts) and the packs table's sorting (ui/pages/labPacks.ts).
 */
import { describe, expect, it } from "vitest";
import { migrateSettings } from "../src/shared/settings";
import { SESSION_PACK, STARTER_PACKS } from "../src/shared/packs";
import {
  cleanFields,
  draftFromFile,
  draftFromPack,
  fieldKeyFor,
  frozenCount,
  freshName,
  newDraft,
  renameDraft,
  sanitiseSchemas,
  saveVersion,
  schemaCoverage,
  schemaState,
  type SchemaDraft,
} from "../src/shared/schemas";
import { madeBy, nextSort, packTableRows, PACK_SORT_DEFAULT, sortPackRows, type PackStatRow } from "../src/ui/pages/labPacks";
import { parseValues, withType } from "../src/ui/pages/agents/Schemas";

const NOW = new Date("2026-11-10T12:00:00Z");

describe("a new schema", () => {
  it("starts empty, unsaved, with a name no other has", () => {
    const a = newDraft([], "My schema", NOW);
    expect(a).toMatchObject({ name: "My schema", fields: [], versions: [], archived: false });
    expect(schemaState(a)).toBe("unsaved");
    const b = newDraft([a], "My schema", NOW);
    expect(b.name).toBe("My schema 2");
    expect(b.id).not.toBe(a.id);
    expect(freshName([a, b], "My schema")).toBe("My schema 3");
  });

  it("keeps field keys short, plain and unique", () => {
    expect(fieldKeyFor("Main topic!", new Set())).toBe("main_topic");
    expect(fieldKeyFor("Main topic", new Set(["main_topic"]))).toBe("main_topic_2");
    expect(fieldKeyFor("???", new Set())).toBe("field");
  });
});

describe("saving versions", () => {
  const withFields = (): SchemaDraft => ({ ...newDraft([], "S", NOW), fields: cleanFields([{ label: "Mood", type: "enum", values: ["up", "down"] }]) });

  it("a version needs at least one field and a change", () => {
    const empty = newDraft([], "S", NOW);
    expect(saveVersion(empty, NOW)).toBe(empty);
    const d = withFields();
    const v1 = saveVersion(d, NOW);
    expect(v1.versions.map((v) => v.n)).toEqual([1]);
    expect(schemaState(v1)).toBe("saved");
    expect(saveVersion(v1, NOW)).toBe(v1);
  });

  it("an edit after saving reads as changes not saved, and saves as version 2 without touching version 1", () => {
    const v1 = saveVersion(withFields(), NOW);
    const edited = { ...v1, fields: [...v1.fields, ...cleanFields([{ label: "Place", type: "text" }])] };
    expect(schemaState(edited)).toBe("changed");
    const v2 = saveVersion(edited, NOW);
    expect(v2.versions.map((v) => v.n)).toEqual([1, 2]);
    expect(v2.versions[0]!.fields).toHaveLength(1);
    expect(v2.versions[1]!.fields).toHaveLength(2);
  });

  it("counts the versions a run froze", () => {
    const d = saveVersion(withFields(), NOW);
    expect(frozenCount(d)).toBe(0);
    expect(frozenCount({ ...d, versions: d.versions.map((v) => ({ ...v, frozen: true })) })).toBe(1);
  });
});

describe("copying a built-in pack", () => {
  it("copies the fields, remembers the source and leaves the pack as it was", () => {
    const before = JSON.stringify(SESSION_PACK);
    const d = draftFromPack(SESSION_PACK, [], "My session", NOW);
    expect(d.name).toBe("My session");
    expect(d.from).toEqual({ pack: "session", version: "1.0.0" });
    expect(d.fields.map((f) => f.key)).toEqual(SESSION_PACK.fields.map((f) => f.key));
    d.fields[0]!.label = "Changed";
    expect(JSON.stringify(SESSION_PACK)).toBe(before);
    expect(schemaState(d)).toBe("unsaved");
  });

  it("every shipped pack copies cleanly", () => {
    for (const pk of STARTER_PACKS) expect(draftFromPack(pk, [], "x", NOW).fields.length).toBeGreaterThan(0);
  });
});

describe("coverage from labels that already exist", () => {
  const stats = [{ pack: "session", version: "1.0.0", entryCount: 764, fields: [{ field: "work" }, { field: "outcome" }] }];
  it("is the pack's labelled entries while a field of it is kept", () => {
    const d = draftFromPack(SESSION_PACK, [], "x", NOW);
    expect(schemaCoverage(d, stats)).toBe(764);
    expect(schemaCoverage({ ...d, fields: d.fields.filter((f) => f.key === "work") }, stats)).toBe(764);
    expect(schemaCoverage({ ...d, fields: cleanFields([{ label: "Mine", type: "text" }]) }, stats)).toBe(0);
  });
  it("is 0 for a schema with no source or whose pack has no labels", () => {
    expect(schemaCoverage(newDraft([], "S", NOW), stats)).toBe(0);
    expect(schemaCoverage(draftFromPack(SESSION_PACK, [], "x", NOW), [])).toBe(0);
  });
});

describe("importing a file", () => {
  it("reads a name and fields", () => {
    const d = draftFromFile(JSON.stringify({ name: "Moods", fields: [{ label: "Mood", type: "enum", values: ["up", "down", "up"] }] }), [], NOW);
    expect(d?.name).toBe("Moods");
    expect(d?.fields[0]?.values).toEqual(["up", "down"]);
    expect(d?.versions).toEqual([]);
  });
  it("refuses what is not a schema", () => {
    expect(draftFromFile("not json", [], NOW)).toBeNull();
    expect(draftFromFile("[]", [], NOW)).toBeNull();
    expect(draftFromFile(JSON.stringify({ name: "x", fields: [] }), [], NOW)).toBeNull();
    expect(draftFromFile(JSON.stringify({ fields: [{ label: "a" }] }), [], NOW)).toBeNull();
    expect(draftFromFile("x".repeat(300_000), [], NOW)).toBeNull();
  });
});

describe("renaming", () => {
  it("refuses an empty name and a name another schema has", () => {
    const a = newDraft([], "Alpha", NOW);
    const b = newDraft([a], "Beta", NOW);
    expect(renameDraft([a, b], b.id, "  ").map((d) => d.name)).toEqual(["Alpha", "Beta"]);
    expect(renameDraft([a, b], b.id, "alpha").map((d) => d.name)).toEqual(["Alpha", "Beta"]);
    expect(renameDraft([a, b], b.id, "Gamma").map((d) => d.name)).toEqual(["Alpha", "Gamma"]);
  });
});

describe("the editor helpers", () => {
  it("reads values from one line", () => {
    expect(parseValues(" a, b ,, c ")).toEqual(["a", "b", "c"]);
  });
  it("a list type keeps its values, the other types drop them", () => {
    const f = cleanFields([{ label: "X", type: "enum", values: ["a"] }])[0]!;
    expect(withType(f, "multi").values).toEqual(["a"]);
    expect(withType(f, "bool").values).toBeUndefined();
    expect(withType(withType(f, "text"), "enum").values).toEqual([]);
  });
});

describe("stored in settings", () => {
  it("defaults to none, and keeps valid schemas through a load", () => {
    expect(migrateSettings({}).schemas).toEqual([]);
    const d = saveVersion({ ...draftFromPack(SESSION_PACK, [], "My session", NOW) }, NOW);
    const back = migrateSettings({ ...migrateSettings({}), schemas: [d] }).schemas;
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ id: d.id, name: "My session", from: { pack: "session" } });
    expect(back[0]!.versions).toHaveLength(1);
  });

  it("drops damaged items, duplicates and a wrong-typed list, and reports them", () => {
    const issues: { path: string }[] = [];
    const ok = newDraft([], "Fine", NOW);
    const out = sanitiseSchemas([ok, ok, { id: "BAD ID", name: "x" }, 7, { id: "a", name: "" }], issues as never);
    expect(out.map((d) => d.id)).toEqual([ok.id]);
    expect(issues.some((i) => i.path === "schemas")).toBe(true);
    expect(sanitiseSchemas("nope", issues as never)).toEqual([]);
  });
});

describe("the packs table", () => {
  const rows: PackStatRow[] = [
    { pack: "session", version: "1.0.0", entryCount: 100, labelCount: 300, authors: { machine: 300, you: 0 }, fields: [{ field: "work", coverage: 1 }] },
    { pack: "placement", version: "1.0.0", entryCount: 900, labelCount: 900, authors: { machine: 800, you: 100 }, fields: [{ field: "role", coverage: 1 }, { field: "x", coverage: 0 }] },
    { pack: "correction", version: "1.0.0", entryCount: 0, labelCount: 0, authors: { machine: 0, you: 0 }, fields: [] },
  ];
  const table = packTableRows(rows, { "session@1.0.0": 2 });

  it("takes the blank count from the ledger and writes fields by their names", () => {
    expect(table[0]).toMatchObject({ key: "session@1.0.0", entries: 100, labels: 300, unassigned: 2 });
    expect(table[0]!.fields).toEqual(["Work"]);
    expect(table[1]!.fields).toEqual(["Role", "x"]);
    expect(table[1]!.unassigned).toBe(0);
  });

  it("opens biggest entries first, and sorts every column both ways", () => {
    expect(sortPackRows(table, PACK_SORT_DEFAULT).map((r) => r.pack)).toEqual(["placement", "session", "correction"]);
    expect(sortPackRows(table, { by: "entries", desc: false }).map((r) => r.pack)).toEqual(["correction", "session", "placement"]);
    expect(sortPackRows(table, { by: "pack", desc: false }).map((r) => r.pack)).toEqual(["correction", "placement", "session"]);
    expect(sortPackRows(table, { by: "labels", desc: true })[0]!.pack).toBe("placement");
    expect(sortPackRows(table, { by: "unassigned", desc: true })[0]!.pack).toBe("session");
  });

  it("does not change the list it sorts, and ties keep a steady order", () => {
    const copy = [...table];
    sortPackRows(table, { by: "unassigned", desc: true });
    expect(table).toEqual(copy);
    const tied = packTableRows([rows[2]!, { ...rows[2]!, pack: "aaa" }], {});
    expect(sortPackRows(tied, { by: "entries", desc: true }).map((r) => r.pack)).toEqual(["aaa", "correction"]);
  });

  it("a header press flips the same column and starts a new one biggest-first (names A to Z)", () => {
    expect(nextSort({ by: "entries", desc: true }, "entries")).toEqual({ by: "entries", desc: false });
    expect(nextSort({ by: "entries", desc: true }, "labels")).toEqual({ by: "labels", desc: true });
    expect(nextSort({ by: "entries", desc: true }, "pack")).toEqual({ by: "pack", desc: false });
  });

  it("says who made the labels", () => {
    expect(table.map(madeBy)).toEqual(["model", "both", "none"]);
    expect(madeBy({ machine: 0, you: 5 })).toBe("you");
  });
});
