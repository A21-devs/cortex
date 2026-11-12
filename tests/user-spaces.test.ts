/**
 * The person's own spaces: storage validation, the members line, the tokens that light a space, the cycle order, the
 * temporary look, the typed wordmark swap and the Settings edits. Pure logic (no DOM).
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, migrateSettings } from "../src/shared/settings";
import { extDefaults, mergeExt } from "../src/shared/settingsExt";
import type { SettingsIssue } from "../src/shared/settings";
import {
  activeUserSpace,
  applyUserSpaceLook,
  formatMembers,
  hasLook,
  isUserScope,
  newUserSpace,
  normaliseFolder,
  parseMembers,
  sanitiseUserSpaces,
  slugFor,
  tokensFor,
  typedFrameMs,
  typedFrames,
  uniqueId,
  userScope,
  userScopeId,
  userSpaceScope,
  userSpaceTokens,
  withoutUserSpaceTokens,
  type UserSpace,
} from "../src/shared/userSpaces";
import { cycleOrder, stepCycle, type Scope } from "../src/ui/header/spaceCycle";
import { areaRows, scopeLabel, scopeMenuItems, pickScope } from "../src/ui/header/ScopePicker";
import { chooseScope, currentScope, spaceOfScope, userSpaceName } from "../src/ui/header/userSpaceScope";
import { suffixColour, suffixText } from "../src/ui/nav/RailWordmark";
import { addSpace, deleteSpace, moveSpace, paletteOptions, renameSpace, setLook, setMembers, themeOptions } from "../src/plugin/settingsSections/spacesSection";
import { dimKeyMatches, tokenGroups } from "../src/worker/indexOps";
import type { CortexStore } from "../src/state/store";

const issues = (): SettingsIssue[] => [];
const sp = (over: Partial<UserSpace> & { id: string }): UserSpace => ({ name: over.id, areas: [], folders: [], open: false, ...over });

describe("sanitiseUserSpaces", () => {
  it("absent is none and raises nothing", () => {
    const i = issues();
    expect(sanitiseUserSpaces(undefined, i)).toEqual([]);
    expect(i).toEqual([]);
  });
  it("a wrong-typed value is none, reported", () => {
    const i = issues();
    expect(sanitiseUserSpaces("x", i)).toEqual([]);
    expect(i[0]?.path).toBe("userSpaces");
  });
  it("keeps a good item and cleans its parts", () => {
    const i = issues();
    const out = sanitiseUserSpaces([{ id: "garden", name: "  My   garden ", areas: ["life", "life", "nope", "none"], folders: ["kb\\plants/", "", "../x", 5], theme: "verdant", palette: "reef", open: true }], i);
    expect(out).toEqual([{ id: "garden", name: "My garden", areas: ["life"], folders: ["kb/plants", "x"], theme: "verdant", palette: "reef", open: true }]);
  });
  it("drops items with no name or a bad id, repeated ids and non-objects, and reports once", () => {
    const i = issues();
    const out = sanitiseUserSpaces([{ id: "a", name: "A" }, { id: "a", name: "Again" }, { id: "B C", name: "bad id" }, { id: "c", name: "  " }, 7, null, { id: "d", name: "D" }], i);
    expect(out.map((u) => u.id)).toEqual(["a", "d"]);
    expect(i.filter((x) => x.path === "userSpaces" && x.problem === "malformed-list")).toHaveLength(1);
  });
  it("an unknown theme or palette is dropped from the item, not the item", () => {
    const i = issues();
    const out = sanitiseUserSpaces([{ id: "a", name: "A", theme: "neon", palette: "rainbow" }], i);
    expect(out).toEqual([{ id: "a", name: "A", areas: [], folders: [], open: false }]);
    expect(i.map((x) => x.path).sort()).toEqual(["userSpaces.0.palette", "userSpaces.0.theme"]);
  });
  it("a damaged open flag reads as closed", () => {
    const i = issues();
    expect(sanitiseUserSpaces([{ id: "a", name: "A", open: "yes" }, { id: "b", name: "B", open: 1 }], i).map((u) => u.open)).toEqual([false, false]);
    expect(i.some((x) => x.action === "used-safe-value")).toBe(true);
  });
  it("is capped at 24 spaces and 24 folders each", () => {
    const many = Array.from({ length: 40 }, (_, n) => ({ id: `s${n}`, name: `S${n}`, folders: Array.from({ length: 40 }, (_x, k) => `f${k}`) }));
    const out = sanitiseUserSpaces(many, issues());
    expect(out).toHaveLength(24);
    expect(out[0]?.folders).toHaveLength(24);
  });
  it("is idempotent", () => {
    const once = sanitiseUserSpaces([{ id: "a", name: "A", areas: ["web"], folders: ["x/y"], theme: "orchid", open: true }], issues());
    expect(sanitiseUserSpaces(JSON.parse(JSON.stringify(once)), issues())).toEqual(once);
  });
});

describe("in the settings object", () => {
  it("defaults to no spaces, fresh each call", () => {
    expect(extDefaults().userSpaces).toEqual([]);
    expect(extDefaults().userSpaces).not.toBe(extDefaults().userSpaces);
    expect(DEFAULT_SETTINGS.userSpaces).toEqual([]);
  });
  it("is read back from a stored file and validated there", () => {
    const i = issues();
    expect(mergeExt({ userSpaces: [{ id: "a", name: "A", areas: ["money"] }, { id: "", name: "bad" }] }, i).userSpaces).toEqual([{ id: "a", name: "A", areas: ["money"], folders: [], open: false }]);
    const m = migrateSettings({ ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), userSpaces: [{ id: "z", name: "Z", folders: ["a/b"] }] });
    expect(m.userSpaces).toEqual([{ id: "z", name: "Z", areas: [], folders: ["a/b"], open: false }]);
  });
  it("an older file without the key gets none", () => {
    const old = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Record<string, unknown>;
    delete old.userSpaces;
    expect(migrateSettings(old).userSpaces).toEqual([]);
  });
});

describe("names and ids", () => {
  it("slugs a name", () => {
    expect(slugFor("My garden!")).toBe("my-garden");
    expect(slugFor("Café Ünï")).toBe("cafe-uni");
    expect(slugFor("!!!")).toBe("space");
  });
  it("makes ids unique", () => {
    expect(uniqueId("Garden", [])).toBe("garden");
    expect(uniqueId("Garden", ["garden"])).toBe("garden-2");
    expect(uniqueId("Garden", ["garden", "garden-2"])).toBe("garden-3");
  });
  it("a new space is empty, closed and trimmed", () => {
    const a = newUserSpace([], "  Home   lab ");
    expect(a).toEqual({ id: "home-lab", name: "Home lab", areas: [], folders: [], open: false });
    expect(newUserSpace([a], "Home lab").id).toBe("home-lab-2");
    expect(newUserSpace([], "   ").name).toBe("Space");
    expect(newUserSpace([], "x".repeat(100)).name).toHaveLength(40);
  });
  it("normalises a folder path", () => {
    expect(normaliseFolder(" \\kb\\money\\ ")).toBe("kb/money");
    expect(normaliseFolder("./a/../b")).toBe("a/b");
    expect(normaliseFolder("///")).toBe("");
  });
  it("scope ids round-trip", () => {
    expect(userScope("a")).toBe("user:a");
    expect(isUserScope("user:a")).toBe(true);
    expect(isUserScope("user:")).toBe(false);
    expect(isUserScope("money")).toBe(false);
    expect(userScopeId(userScope("a-b"))).toBe("a-b");
  });
});

describe("the members line", () => {
  it("areas by name or id, anything else is a folder", () => {
    expect(parseMembers("Money, web ; kb/plants\nLife, money, notes\\x")).toEqual({ areas: ["money", "web", "life"], folders: ["kb/plants", "notes/x"] });
  });
  it("ignores blanks and repeated folders", () => {
    expect(parseMembers(" , ,a, a ,")).toEqual({ areas: [], folders: ["a"] });
  });
  it("formats back to names then folders", () => {
    const m = { areas: ["money", "web"] as UserSpace["areas"], folders: ["a/b"] };
    expect(formatMembers(m)).toBe("Money, Web, a/b");
    expect(parseMembers(formatMembers(m))).toEqual(m);
  });
});

describe("lighting a space", () => {
  const two = sp({ id: "pair", name: "Pair", areas: ["money", "web"] });
  const one = sp({ id: "solo", name: "Solo", areas: ["money"] });
  const mixed = sp({ id: "mix", name: "Mix", areas: ["life"], folders: ["kb/plants"] });
  const none = sp({ id: "empty", name: "Empty" });

  it("one token per area and folder, with ids that mark them", () => {
    const t = userSpaceTokens(mixed);
    expect(t.map((x) => [x.kind, x.dim, x.value])).toEqual([["group", "space", "life"], ["group", "folderPath", "kb/plants"]]);
    expect(t.every((x) => x.id.startsWith("userspace:mix:"))).toBe(true);
  });
  it("the tokens OR together in the worker's query rule", () => {
    const groups = tokenGroups(userSpaceTokens(two));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });
  it("a folder token covers everything inside it", () => {
    expect(dimKeyMatches("folderPath", "kb/plants/ferns", "kb/plants")).toBe(true);
    expect(dimKeyMatches("folderPath", "kb/plantsx", "kb/plants")).toBe(false);
  });
  it("sets a real scope only for exactly one area", () => {
    expect(userSpaceScope(one)).toBe("money");
    expect(userSpaceScope(two)).toBe("all");
    expect(userSpaceScope(mixed)).toBe("all");
    expect(userSpaceScope(sp({ id: "f", folders: ["x"] }))).toBe("all");
  });
  it("is active only while its tokens and its scope agree", () => {
    const spaces = [two, one, mixed];
    expect(activeUserSpace(userSpaceTokens(two), "all", spaces)?.id).toBe("pair");
    expect(activeUserSpace(userSpaceTokens(two), "money", spaces)).toBeNull();
    expect(activeUserSpace(userSpaceTokens(one), "money", spaces)?.id).toBe("solo");
    expect(activeUserSpace(userSpaceTokens(one), "all", spaces)).toBeNull();
    expect(activeUserSpace([], "all", spaces)).toBeNull();
    expect(activeUserSpace(userSpaceTokens(two), "all", [])).toBeNull();
  });
  it("the person's own tokens stay, the space's come and go", () => {
    const mine = [{ id: "text:1", kind: "text" as const, label: "x", text: "x" }];
    const withTwo = tokensFor(mine, two);
    expect(withTwo.map((t) => t.id)).toEqual(["text:1", "userspace:pair:area:money", "userspace:pair:area:web"]);
    expect(tokensFor(withTwo, one).map((t) => t.id)).toEqual(["text:1", "userspace:solo:area:money"]);
    expect(tokensFor(withTwo, null)).toEqual(mine);
    expect(withoutUserSpaceTokens(withTwo)).toEqual(mine);
  });
  it("an empty space has no tokens", () => {
    expect(userSpaceTokens(none)).toEqual([]);
  });
});

describe("choosing a scope on a store", () => {
  function fakeStore(): CortexStore {
    let ui: Record<string, unknown> = { scope: "all", tokens: [], preview: null };
    return {
      get: () => ui,
      update: (_k: string, patch: unknown) => {
        ui = typeof patch === "function" ? (patch as (u: typeof ui) => typeof ui)(ui) : { ...ui, ...(patch as object) };
      },
    } as unknown as CortexStore;
  }
  const state = (s: CortexStore) => (s as unknown as { get(k: string): { scope: string; tokens: { id: string }[] } }).get("ui");
  const spaces = [sp({ id: "pair", name: "Pair", areas: ["money", "web"] }), sp({ id: "solo", name: "Solo", areas: ["life"] }), sp({ id: "empty", name: "Empty" })];

  it("a multi-area space keeps scope All and lights through tokens", () => {
    const st = fakeStore();
    chooseScope(st, userScope("pair"), spaces);
    expect(state(st).scope).toBe("all");
    expect(state(st).tokens).toHaveLength(2);
    expect(currentScope(state(st) as never, spaces)).toBe("user:pair");
  });
  it("a one-area space scopes to the area and reads back as the space", () => {
    const st = fakeStore();
    chooseScope(st, userScope("solo"), spaces);
    expect(state(st).scope).toBe("life");
    expect(currentScope(state(st) as never, spaces)).toBe("user:solo");
  });
  it("choosing an area, All areas or another space clears the first space's tokens", () => {
    const st = fakeStore();
    chooseScope(st, userScope("pair"), spaces);
    chooseScope(st, userScope("solo"), spaces);
    expect(state(st).tokens.map((t) => t.id)).toEqual(["userspace:solo:area:life"]);
    chooseScope(st, "web", spaces);
    expect(state(st)).toMatchObject({ scope: "web", tokens: [] });
    chooseScope(st, userScope("pair"), spaces);
    chooseScope(st, "all", spaces);
    expect(state(st)).toMatchObject({ scope: "all", tokens: [] });
  });
  it("an unknown or empty space changes nothing", () => {
    const st = fakeStore();
    chooseScope(st, userScope("ghost"), spaces);
    chooseScope(st, userScope("empty"), spaces);
    expect(state(st)).toMatchObject({ scope: "all", tokens: [] });
  });
  it("the menu's Next and Previous run through the areas, No area and then the spaces", () => {
    const st = fakeStore();
    chooseScope(st, "none", spaces);
    pickScope(st, "none", "next", spaces);
    expect(currentScope(state(st) as never, spaces)).toBe("user:pair");
    pickScope(st, "user:pair", "next", spaces);
    expect(currentScope(state(st) as never, spaces)).toBe("user:solo");
    pickScope(st, "user:solo", "next", spaces);
    expect(currentScope(state(st) as never, spaces)).toBe("all");
    pickScope(st, "all", "prev", spaces);
    expect(currentScope(state(st) as never, spaces)).toBe("user:solo");
  });
  it("picking a menu value of a space chooses it", () => {
    const st = fakeStore();
    pickScope(st, "all", "user:pair", spaces);
    expect(currentScope(state(st) as never, spaces)).toBe("user:pair");
  });
});

describe("the cycle order", () => {
  const rows = areaRows(undefined, null);
  const spaces = [sp({ id: "a", areas: ["web"] }), sp({ id: "b", folders: ["x"] }), sp({ id: "none-yet" })];
  it("is unchanged without spaces", () => {
    expect(cycleOrder(rows, null)).toEqual(["all", ...rows.map((r) => r.id)]);
  });
  it("appends the spaces that gather something after the areas, in the order kept", () => {
    const o = cycleOrder(rows, null, spaces);
    expect(o.slice(0, rows.length + 1)).toEqual(["all", ...rows.map((r) => r.id)]);
    expect(o.slice(rows.length + 1)).toEqual(["user:a", "user:b"]);
  });
  it("puts them after No area when something sits there", () => {
    const counts = { notes: 1, record: 0, notesBySpace: { none: 1 }, recordBySpace: {} } as never;
    const o = cycleOrder(rows, counts, spaces);
    expect(o.slice(-3)).toEqual(["none", "user:a", "user:b"]);
  });
  it("steps from the last area into the first space and from the last space back to All", () => {
    const o: Scope[] = cycleOrder(rows, null, spaces);
    const lastArea = rows[rows.length - 1]!.id;
    expect(stepCycle(o, lastArea, 1)).toBe("user:a");
    expect(stepCycle(o, "user:b", 1)).toBe("all");
    expect(stepCycle(o, "all", -1)).toBe("user:b");
  });
});

describe("names, menu and wordmark colour", () => {
  const spaces = [sp({ id: "garden", name: "Garden", areas: ["life"], palette: "reef" }), sp({ id: "empty", name: "Empty" })];
  it("names a space and falls back for an unknown one", () => {
    expect(scopeLabel("user:garden", spaces)).toBe("Garden");
    expect(scopeLabel("user:ghost", spaces)).toBe("All areas");
    expect(scopeLabel("money", spaces)).toBe("Money");
    expect(suffixText("user:garden", spaces)).toBe("Garden");
    expect(userSpaceName("user:garden", spaces)).toBe("Garden");
    expect(userSpaceName("money", spaces)).toBe("");
    expect(spaceOfScope("user:garden", spaces)?.id).toBe("garden");
  });
  it("the menu lists spaces that gather something, after the areas, and ticks the chosen one", () => {
    const items = scopeMenuItems("user:garden", areaRows(undefined, null), null, spaces);
    const mine = items.filter((i) => i.group === "spaces");
    expect(mine.map((i) => [i.value, i.label, i.checked])).toEqual([["user:garden", "Garden", true]]);
    expect(items.findIndex((i) => i.value === "user:garden")).toBeLessThan(items.findIndex((i) => i.value === "prev"));
  });
  it("a space's wordmark colour is the first colour of its own palette, kept readable", () => {
    const own = suffixColour("user:garden", undefined, "prism", "glow", true, spaces);
    const plain = suffixColour("user:garden", undefined, "prism", "glow", true, [sp({ id: "garden", name: "Garden", areas: ["life"] })]);
    expect(own).toMatch(/^#[0-9a-f]{6}$/i);
    expect(own).not.toBe(plain);
  });
});

describe("the temporary look", () => {
  const appearance = () => JSON.parse(JSON.stringify(DEFAULT_SETTINGS.appearance)) as typeof DEFAULT_SETTINGS.appearance;
  it("has a look only with a theme or a palette", () => {
    expect(hasLook(sp({ id: "a" }))).toBe(false);
    expect(hasLook(sp({ id: "a", theme: "verdant" }))).toBe(true);
    expect(hasLook(sp({ id: "a", palette: "reef" }))).toBe(true);
    expect(hasLook(null)).toBe(false);
  });
  it("a theme writes the figure colours only and leaves the window theme and the data palette", () => {
    const a = appearance();
    const stage = a.stage;
    const own = a.palette;
    applyUserSpaceLook(a, sp({ id: "a", theme: "sapphire" }));
    expect(a.stage).toBe(stage);
    expect(a.palette).toBe(own);
    expect(a.figureColours).toBe("sapphire");
  });
  it("a palette is applied beside the theme: the data palette for the window, the theme for the figure", () => {
    const a = appearance();
    const stage = a.stage;
    applyUserSpaceLook(a, sp({ id: "a", theme: "verdant", palette: "ember" }));
    expect(a.stage).toBe(stage);
    expect(a.palette).toBe("ember");
    expect(a.figureColours).toBe("verdant");
  });
  it("a palette alone leaves the window theme", () => {
    const a = appearance();
    const stage = a.stage;
    applyUserSpaceLook(a, sp({ id: "a", palette: "harbor" }));
    expect(a.stage).toBe(stage);
    expect(a.palette).toBe("harbor");
  });
});

describe("the typed swap", () => {
  it("ends on the new word and starts shorter than the old one", () => {
    const f = typedFrames("Garden", "Lab");
    expect(f[f.length - 1]).toBe("Lab");
    expect(f[0]!.length).toBeLessThan("Garden".length);
    expect(f).toContain("L");
    expect(f).toContain("La");
  });
  it("deletes in at most four steps whatever the old length", () => {
    const f = typedFrames("a-very-long-space-name", "x");
    expect(f.length).toBeLessThanOrEqual(4 + 1);
    expect(f[f.length - 1]).toBe("x");
  });
  it("types in from nothing, and out to nothing", () => {
    expect(typedFrames("", "Ab")).toEqual(["A", "Ab"]);
    const out = typedFrames("Ab", "");
    expect(out[out.length - 1]).toBe("");
  });
  it("the same word is one frame", () => {
    expect(typedFrames("Same", "Same")).toEqual(["Same"]);
  });
  it("frame time keeps the swap short", () => {
    expect(typedFrameMs(1)).toBeLessThanOrEqual(45);
    expect(typedFrameMs(100)).toBe(16);
    expect(typedFrameMs(10) * 10).toBeLessThan(500);
  });
});

describe("the Settings edits", () => {
  const draft = () => JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as typeof DEFAULT_SETTINGS;
  it("adds, renames, sets members and look, moves and deletes", () => {
    const s = draft();
    const a = addSpace(s, "Garden")!;
    const b = addSpace(s, "Garden")!;
    expect([a.id, b.id]).toEqual(["garden", "garden-2"]);
    renameSpace(s, "garden", "Allotment");
    expect(s.userSpaces[0]?.name).toBe("Allotment");
    renameSpace(s, "garden", "   ");
    expect(s.userSpaces[0]?.name).toBe("Allotment");
    setMembers(s, "garden", "Life, kb/plants");
    expect(s.userSpaces[0]).toMatchObject({ areas: ["life"], folders: ["kb/plants"] });
    setLook(s, "garden", { theme: "orchid", palette: "reef" });
    expect(s.userSpaces[0]).toMatchObject({ theme: "orchid", palette: "reef" });
    setLook(s, "garden", { theme: "none", palette: "none" });
    expect(s.userSpaces[0]?.theme).toBeUndefined();
    expect(s.userSpaces[0]?.palette).toBeUndefined();
    moveSpace(s, "garden-2", -1);
    expect(s.userSpaces.map((u) => u.id)).toEqual(["garden-2", "garden"]);
    moveSpace(s, "garden-2", -1);
    expect(s.userSpaces.map((u) => u.id)).toEqual(["garden-2", "garden"]);
    deleteSpace(s, "garden-2");
    expect(s.userSpaces.map((u) => u.id)).toEqual(["garden"]);
  });
  it("stops at 24 spaces", () => {
    const s = draft();
    for (let i = 0; i < 24; i++) expect(addSpace(s, `S${i}`)).not.toBeNull();
    expect(addSpace(s, "One more")).toBeNull();
  });
  it("what the edits write survives the settings validator unchanged", () => {
    const s = draft();
    addSpace(s, "Garden");
    setMembers(s, "garden", "Life, kb/plants");
    setLook(s, "garden", { theme: "verdant", palette: "reef" });
    expect(sanitiseUserSpaces(JSON.parse(JSON.stringify(s.userSpaces)), issues())).toEqual(s.userSpaces);
  });
  it("offers the five themes and every palette, each with a name", () => {
    expect(Object.keys(themeOptions())).toEqual(["none", "garnet", "sapphire", "verdant", "saffron", "orchid"]);
    const p = paletteOptions();
    expect(p.none).toBeTruthy();
    for (const [k, v] of Object.entries(p)) expect(v, k).not.toBe(k === "none" ? "" : "undefined");
    expect(p.reef).toBe("Reef");
  });
});
