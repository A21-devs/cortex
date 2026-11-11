import { describe, expect, it } from "vitest";
import { wikiNoteId } from "../src/shared/ids";
import { createVaultPathResolver } from "../src/store/vaultPaths";

describe("vault path resolver", () => {
  it("finds a note whose title differs from its file name", () => {
    const find = createVaultPathResolver(() => ["wiki/hot.md", "wiki/index.md"]);
    expect(find(wikiNoteId("wiki/hot.md"))).toBe("wiki/hot.md");
    expect(find(wikiNoteId("wiki/nope.md"))).toBeUndefined();
  });
  it("rebuilds when the file count changes", () => {
    let files = ["a.md"];
    const find = createVaultPathResolver(() => files);
    expect(find(wikiNoteId("b.md"))).toBeUndefined();
    files = ["a.md", "b.md"];
    expect(find(wikiNoteId("b.md"))).toBe("b.md");
  });
});
