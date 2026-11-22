/**
 * A wiki note's area: your own wiki folders first (Settings › Sources, `wikiAreas`), then the vault's area table (longest
 * prefix wins), then the area its folders' names say, so a vault that grows new folders (kb/library/ai,
 * kb/code-library/python…) does not pour them all into Vault. Also the stored rows' validation.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_VERSION, migrateSettingsChecked, type SettingsIssue } from "../src/shared/settings";
import { extDefaults, mergeExt } from "../src/shared/settingsExt";
import { AREA_IDS, AREA_RULES_VERSION, WIKI_AREA_LIMITS, isAreaId, normaliseWikiFolder, sanitiseWikiAreas, spaceOfFolderNames, spaceOfWikiPath, type WikiAreaRow } from "../src/shared/spaces";
import { checkPatched } from "../src/plugin/settingsStore";

/** No rows of your own: the default table and the folder names only. */
const none: readonly WikiAreaRow[] = [];

describe("wiki note areas", () => {
  it("keeps the area table's own answers", () => {
    expect(spaceOfWikiPath("kb/deep/roblox/scripting/x.md", none)).toBe("roblox");
    expect(spaceOfWikiPath("kb/web-frontend/x.md", none)).toBe("web");
    expect(spaceOfWikiPath("kb/databases/x.md", none)).toBe("data");
    // A listed prefix beats a word deeper down.
    expect(spaceOfWikiPath("kb/deep/roblox/python-tools/x.md", none)).toBe("roblox");
  });

  it("reads the area from folder names the table does not list, deepest first", () => {
    expect(spaceOfWikiPath("kb/library/ai/x.md", none)).toBe("ai");
    expect(spaceOfWikiPath("kb/library/web/x.md", none)).toBe("web");
    expect(spaceOfWikiPath("kb/library/money/x.md", none)).toBe("money");
    expect(spaceOfWikiPath("kb/library/design/x.md", none)).toBe("design");
    expect(spaceOfWikiPath("kb/library/life/x.md", none)).toBe("life");
    expect(spaceOfWikiPath("kb/library/code/x.md", none)).toBe("code");
    expect(spaceOfWikiPath("kb/code-library/python/x.md", none)).toBe("code");
    // A folder with no area word falls back to its parent's ("hubs" under code-library).
    expect(spaceOfWikiPath("kb/code-library/hubs/x.md", none)).toBe("code");
    // The most specific folder wins: python notes inside an AI folder are code.
    expect(spaceOfWikiPath("kb/library/ai/python/x.md", none)).toBe("code");
  });

  it("leaves the vault's own pages in Vault, and never reads a note's file name", () => {
    expect(spaceOfWikiPath("concepts/LLM Wiki Pattern.md", none)).toBe("vault");
    expect(spaceOfWikiPath("skills/x.md", none)).toBe("vault");
    expect(spaceOfWikiPath("ai.md", none)).toBe("vault");
    expect(spaceOfWikiPath("kb/library/Python basics.md", none)).toBe("vault");
  });

  it("matches whole words only, never part of a word", () => {
    expect(spaceOfFolderNames(["maintenance"])).toBeNull();
    expect(spaceOfFolderNames(["Brain"])).toBeNull();
    expect(spaceOfFolderNames(["03 Animation"])).toBe("games");
    expect(spaceOfFolderNames(["05 AI Tools"])).toBe("ai");
    expect(spaceOfFolderNames(["llms-genai"])).toBe("ai");
    expect(spaceOfFolderNames([])).toBeNull();
  });

  it("has a version, so a cached vault part built under older rules is rebuilt", () => {
    expect(AREA_RULES_VERSION).toBeGreaterThanOrEqual(2);
  });
});

describe("your own wiki folders", () => {
  const rows = (...pairs: [string, WikiAreaRow["area"]][]): WikiAreaRow[] => pairs.map(([folder, area]) => ({ folder, area }));

  it("a row of yours beats the default table, even where the table's prefix is longer", () => {
    const mine = rows(["kb/deep", "money"]);
    expect(spaceOfWikiPath("kb/deep/roblox/scripting/x.md", none)).toBe("roblox");
    expect(spaceOfWikiPath("kb/deep/roblox/scripting/x.md", mine)).toBe("money");
    expect(spaceOfWikiPath("kb/web-frontend/x.md", rows(["kb/web-frontend", "design"]))).toBe("design");
  });

  it("a row of yours beats the area words of folder names", () => {
    expect(spaceOfWikiPath("notes/ai/x.md", none)).toBe("ai");
    expect(spaceOfWikiPath("notes/ai/x.md", rows(["notes", "life"]))).toBe("life");
    // A word can be overruled the other way too: a folder you put in Vault stays there.
    expect(spaceOfWikiPath("tools/python/x.md", rows(["tools", "vault"]))).toBe("vault");
  });

  it("the longest of your matching folders wins, whatever order the rows are in", () => {
    const mine = rows(["notes", "life"], ["notes/work/clients", "money"], ["notes/work", "code"]);
    expect(spaceOfWikiPath("notes/garden/x.md", mine)).toBe("life");
    expect(spaceOfWikiPath("notes/work/x.md", mine)).toBe("code");
    expect(spaceOfWikiPath("notes/work/clients/x.md", mine)).toBe("money");
    expect(spaceOfWikiPath("notes/work/clients/deep/er/x.md", mine)).toBe("money");
    expect(spaceOfWikiPath("notes/work/clients/x.md", [...mine].reverse())).toBe("money");
  });

  it("a folder only matches at a folder boundary, never part of a name or the note itself", () => {
    const mine = rows(["notes", "life"]);
    expect(spaceOfWikiPath("notes/x.md", mine)).toBe("life");
    expect(spaceOfWikiPath("notesx/y.md", mine)).toBe("vault");
    expect(spaceOfWikiPath("notes-old/y.md", mine)).toBe("vault");
    expect(spaceOfWikiPath("notes.md", mine)).toBe("vault");
    expect(spaceOfWikiPath("other/notes/y.md", mine)).toBe("vault");
    // A folder is matched as written: another case is another folder.
    expect(spaceOfWikiPath("Notes/x.md", mine)).toBe("vault");
  });

  it("paths your rows do not cover fall through to the default table, then the folder names", () => {
    const mine = rows(["notes", "life"]);
    expect(spaceOfWikiPath("kb/deep/roblox/x.md", mine)).toBe("roblox");
    expect(spaceOfWikiPath("kb/library/ai/x.md", mine)).toBe("ai");
    expect(spaceOfWikiPath("concepts/x.md", mine)).toBe("vault");
  });
});

describe("the stored rows (sanitiseWikiAreas)", () => {
  const issues = (): SettingsIssue[] => [];

  it("absent is none and raises nothing; a wrong-typed value is none, reported", () => {
    const i = issues();
    expect(sanitiseWikiAreas(undefined, i)).toEqual([]);
    expect(i).toEqual([]);
    expect(sanitiseWikiAreas({ folder: "notes", area: "life" }, i)).toEqual([]);
    expect(i).toEqual([{ path: "wikiAreas", problem: "wrong-type", action: "used-default" }]);
  });

  it("normalises folders: trimmed, forward slashes, no leading, trailing or doubled slash", () => {
    const i = issues();
    const out = sanitiseWikiAreas(
      [
        { folder: "  notes/recipes  ", area: "life" },
        { folder: "\\work\\clients\\", area: "money" },
        { folder: "/projects//site/", area: "web" },
        { folder: "a / b", area: "code" },
        { folder: "./x/../y", area: "data" },
      ],
      i,
    );
    expect(out).toEqual(rowsOf(["notes/recipes", "life"], ["work/clients", "money"], ["projects/site", "web"], ["a/b", "code"], ["x/y", "data"]));
    // Tidying a folder is not a problem to report.
    expect(i).toEqual([]);
    expect(normaliseWikiFolder(" \\ / ")).toBe("");
  });

  it("drops rows with an empty folder or an area that is not one of the ten, and reports once", () => {
    const i = issues();
    const out = sanitiseWikiAreas(
      [
        { folder: "keep", area: "ai" },
        { folder: "", area: "ai" },
        { folder: " / ", area: "ai" },
        { folder: "no-area", area: "none" },
        { folder: "by-name", area: "Money" },
        { folder: "unknown", area: "space" },
        { folder: "no-area-at-all" },
        { folder: 7, area: "ai" },
        "notes",
        null,
        ["x", "ai"],
        { folder: "x".repeat(WIKI_AREA_LIMITS.folder + 1), area: "ai" },
      ],
      i,
    );
    expect(out).toEqual(rowsOf(["keep", "ai"]));
    expect(i).toEqual([{ path: "wikiAreas", problem: "malformed-list", action: "used-default" }]);
  });

  it("collapses repeated folders (also once tidied): the first row stays", () => {
    const i = issues();
    const out = sanitiseWikiAreas(
      [
        { folder: "notes", area: "life" },
        { folder: "/notes/", area: "code" },
        { folder: "work", area: "money" },
        { folder: "notes", area: "life" },
      ],
      i,
    );
    expect(out).toEqual(rowsOf(["notes", "life"], ["work", "money"]));
    expect(i.filter((x) => x.problem === "malformed-list")).toHaveLength(1);
  });

  it("keeps at most the limit, and only the two fields", () => {
    const many = Array.from({ length: WIKI_AREA_LIMITS.rows + 20 }, (_, n) => ({ folder: `f${n}`, area: "web", extra: true }));
    const out = sanitiseWikiAreas(many, issues());
    expect(out).toHaveLength(WIKI_AREA_LIMITS.rows);
    expect(out[0]).toEqual({ folder: "f0", area: "web" });
    expect(WIKI_AREA_LIMITS.rows).toBe(100);
  });

  it("is idempotent", () => {
    const once = sanitiseWikiAreas([{ folder: " a\\b/ ", area: "games" }, { folder: "c", area: "vault" }], issues());
    const i = issues();
    expect(sanitiseWikiAreas(JSON.parse(JSON.stringify(once)), i)).toEqual(once);
    expect(i).toEqual([]);
  });

  it("knows the ten areas and nothing else", () => {
    expect(AREA_IDS).toEqual(["code", "web", "data", "ai", "roblox", "games", "money", "design", "life", "vault"]);
    expect(isAreaId("life")).toBe(true);
    expect(isAreaId("none")).toBe(false);
    expect(isAreaId("Life")).toBe(false);
    expect(isAreaId(3)).toBe(false);
  });
});

describe("in the settings object", () => {
  it("defaults to no rows, fresh each call", () => {
    expect(extDefaults().wikiAreas).toEqual([]);
    expect(extDefaults().wikiAreas).not.toBe(extDefaults().wikiAreas);
    expect(DEFAULT_SETTINGS.wikiAreas).toEqual([]);
  });

  it("is validated on every load", () => {
    const i: SettingsIssue[] = [];
    expect(mergeExt({ wikiAreas: [{ folder: "/notes/", area: "life" }, { folder: "x", area: "none" }] }, i).wikiAreas).toEqual(rowsOf(["notes", "life"]));
    expect(i.map((x) => x.path)).toEqual(["wikiAreas"]);
    const m = migrateSettingsChecked({ ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), wikiAreas: [{ folder: "notes\\recipes", area: "life" }] });
    expect(m.settings.wikiAreas).toEqual(rowsOf(["notes/recipes", "life"]));
    expect(m.issues).toEqual([]);
    expect(m.corrupt).toBe(false);
  });

  it("needs no migration: the blocks carry no version of their own, and an older file without the key gets none", () => {
    const old = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Record<string, unknown>;
    delete old.wikiAreas;
    old.version = 7;
    const m = migrateSettingsChecked(old);
    expect(m.settings.wikiAreas).toEqual([]);
    expect(m.issues).toEqual([]);
    expect(m.settings.version).toBe(SETTINGS_VERSION);
  });

  it("a damaged list never marks the settings corrupt", () => {
    const m = migrateSettingsChecked({ ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), wikiAreas: "notes=life" });
    expect(m.settings.wikiAreas).toEqual([]);
    expect(m.corrupt).toBe(false);
  });

  it("a saved change with clean rows is accepted as it is, one that needs repair is refused", () => {
    const s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as typeof DEFAULT_SETTINGS;
    s.wikiAreas = rowsOf(["notes", "life"], ["notes/work", "money"]);
    expect(checkPatched(s).wikiAreas).toEqual(s.wikiAreas);
    s.wikiAreas.push({ folder: "notes", area: "code" });
    expect(() => checkPatched(s)).toThrow();
  });
});

function rowsOf(...pairs: [string, WikiAreaRow["area"]][]): WikiAreaRow[] {
  return pairs.map(([folder, area]) => ({ folder, area }));
}
