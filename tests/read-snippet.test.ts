import { describe, expect, it } from "vitest";
import { noteSnippet, rowMs } from "../src/ui/pages/Read";

describe("Read page vault-note snippet", () => {
  it("strips front matter, headings, links and emphasis, and stays short", () => {
    const md = "---\ntitle: X\ntags: [a]\n---\n# Heading\n\nSome **bold** text with a [[Other|link]] and [site](https://x.test).\n\n```js\nignored()\n```\n- item";
    expect(noteSnippet(md)).toBe("Heading Some bold text with a link and site. item");
    expect(noteSnippet("word ".repeat(100)).length).toBeLessThanOrEqual(120);
    expect(noteSnippet("---\nonly: front\n---\n")).toBe("");
  });
});

describe("Read row time", () => {
  it("lists a dated conversation by its newest message, so the day sections follow the sort", () => {
    expect(rowMs(100, 8, 500)).toBe(500);
    expect(rowMs(100, 1, 500)).toBe(100);
    expect(rowMs(500, 8, 100)).toBe(500);
    expect(rowMs(100, 8, undefined)).toBe(100);
    expect(Number.isNaN(rowMs(Number.NaN, 8, 500))).toBe(true);
  });
});
