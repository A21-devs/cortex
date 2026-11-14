/**
 * A wiki note's area: the vault's area table first (longest prefix wins), then the area its folders' names say, so a
 * vault that grows new folders (kb/library/ai, kb/code-library/python…) does not pour them all into Vault.
 */
import { describe, expect, it } from "vitest";
import { AREA_RULES_VERSION, spaceOfFolderNames, spaceOfWikiPath } from "../src/shared/spaces";

describe("wiki note areas", () => {
  it("keeps the area table's own answers", () => {
    expect(spaceOfWikiPath("kb/deep/roblox/scripting/x.md")).toBe("roblox");
    expect(spaceOfWikiPath("kb/web-frontend/x.md")).toBe("web");
    expect(spaceOfWikiPath("kb/databases/x.md")).toBe("data");
    // A listed prefix beats a word deeper down.
    expect(spaceOfWikiPath("kb/deep/roblox/python-tools/x.md")).toBe("roblox");
  });

  it("reads the area from folder names the table does not list, deepest first", () => {
    expect(spaceOfWikiPath("kb/library/ai/x.md")).toBe("ai");
    expect(spaceOfWikiPath("kb/library/web/x.md")).toBe("web");
    expect(spaceOfWikiPath("kb/library/money/x.md")).toBe("money");
    expect(spaceOfWikiPath("kb/library/design/x.md")).toBe("design");
    expect(spaceOfWikiPath("kb/library/life/x.md")).toBe("life");
    expect(spaceOfWikiPath("kb/library/code/x.md")).toBe("code");
    expect(spaceOfWikiPath("kb/code-library/python/x.md")).toBe("code");
    // A folder with no area word falls back to its parent's ("hubs" under code-library).
    expect(spaceOfWikiPath("kb/code-library/hubs/x.md")).toBe("code");
    // The most specific folder wins: python notes inside an AI folder are code.
    expect(spaceOfWikiPath("kb/library/ai/python/x.md")).toBe("code");
  });

  it("leaves the vault's own pages in Vault, and never reads a note's file name", () => {
    expect(spaceOfWikiPath("concepts/LLM Wiki Pattern.md")).toBe("vault");
    expect(spaceOfWikiPath("skills/x.md")).toBe("vault");
    expect(spaceOfWikiPath("ai.md")).toBe("vault");
    expect(spaceOfWikiPath("kb/library/Python basics.md")).toBe("vault");
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
