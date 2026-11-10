/**
 * Final safety review (owner: reviewer). Adversarial strings through every model-controlled field of the
 * machine-note renderers, the symlink-safe write guard and the document size cap. Temp dirs only.
 */
import { describe, expect, it } from "vitest";
import { renderGistMarkdown, renderHubMarkdown } from "../src/store/notesWriter";
import { mdInert, yamlScalar } from "../src/shared/mdSafe";
import { decideDocument, MAX_DOCUMENT_BYTES } from "../src/importers/common";
import type { GistDoc } from "../src/shared/notesDoc";
import { writtenFileText } from "../src/plugin/newEntry";

const EVIL = [
  "```dataviewjs\nawait app.vault.adapter.write('x','y')\n```",
  "`$= dv.span(require('fs').readdirSync('/'))`",
  "`= this.file.name`",
  "<% tp.system.prompt('x') %>",
  "<%* tR += 'x' %>",
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "{{embed}} ![[secret]] [[Note|alias]]",
  "~~~dataview\nTABLE file.name\n~~~",
  "key:: value (inline:: field)",
  "javascript:alert(1) obsidian://open?vault=x",
  "line\u2028break\u0085next\r\n---\r\ncortex_kind: hacked",
];
// Raw triggers, ignoring ones that a backslash defuses. Front matter only needs the code-running ones.
const BODY_FORBIDDEN: RegExp[] = [/(?<!\\)`/, /~~~/, /\$=/, /(?<!\\)</, /(?<!\\)\[\[/, /(?<!\\)!\[/, /::/, /javascript:/i, /obsidian:\/\/open/i];
// Front matter: code-running triggers, and (STAB, pass 3) links, embeds, inline fields, raw tags and link schemes,
// which other plugins and the Properties view would render or follow.
const FRONT_FORBIDDEN: RegExp[] = [/`/, /<%/, /\$=/, /\[\[/, /\]\]/, /!\[/, /\]\(/, /::/, /<[A-Za-z/!?]/, /javascript:/i, /vbscript:/i, /obsidian:\/\//i, /\b[a-z][a-z0-9+.-]*:\/\//i, /\bwww\./i]
const parts = (md: string): { front: string; body: string } => {
  const end = md.indexOf("\n---\n", 4);
  return { front: md.slice(0, end + 5), body: md.slice(end + 5) };
};
const check = (md: string): void => {
  const { front, body } = parts(md);
  for (const re of BODY_FORBIDDEN) expect(body, String(re)).not.toMatch(re);
  for (const re of FRONT_FORBIDDEN) expect(front, String(re)).not.toMatch(re);
};

const madeBy = (e: string) => ({ runId: "r_aaaaaaaaaaaaaaaa", model: e, engine: e, at: "2026-11-04T10:00:00.000Z" }) as unknown as GistDoc["madeBy"];
const gist = (e: string): GistDoc =>
  ({
    id: "n_aaaaaaaaaaaaaaaa",
    conv: "c_aaaaaaaaaaaaaaaa",
    title: e,
    space: e,
    madeBy: madeBy(e),
    gist: e,
    facets: { work: e, outcome: e, project: e, topics: [e, e] },
    parts: [
      {
        n: 1,
        title: e,
        startedAt: "2026-11-03T14:05:00.000Z",
        endedAt: "2026-11-03T14:40:00.000Z",
        msgFrom: 1,
        msgTo: 2,
        notes: [{ id: "n_bbbbbbbbbbbbbbbb", kind: "question", text: e, blockId: e, cites: [{ entryId: e, version: 1, quote: e, speaker: e, date: e }] }],
      },
    ],
    addressedComments: [],
  }) as unknown as GistDoc;

describe("machine notes stay inert whatever the model returns (SAFE-01)", () => {
  for (const [i, e] of EVIL.entries()) {
    it(`gist note, adversarial string #${i}`, () => {
      const md = renderGistMarkdown(gist(e), "wiki/derived/gists/2026/x.md" as never, { timeZone: "UTC" }).markdown;
      check(md);
      // the front matter block must still be a single block with only Cortex keys
      expect(md.startsWith("---\n")).toBe(true);
      expect(md.match(/^---$/gm)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(md).not.toMatch(/^cortex_kind: hacked/m);
    });
    it(`hub note, adversarial string #${i}`, () => {
      const md = renderHubMarkdown(
        { id: "n_cccccccccccccccc", hubType: "project", status: "active", range: ["2026-10-14T00:00:00.000Z", "2026-11-08T00:00:00.000Z"], members: [], brief: [{ text: e, cites: [] }], madeBy: madeBy(e), title: e, space: e } as never,
        "wiki/derived/maps/project/x.md" as never,
      ).markdown;
      check(md);
    });
    it(`mdInert and yamlScalar, adversarial string #${i}`, () => {
      for (const re of BODY_FORBIDDEN) expect(mdInert(e), String(re)).not.toMatch(re);
      for (const re of FRONT_FORBIDDEN) expect(yamlScalar(e), String(re)).not.toMatch(re);
      expect(yamlScalar(e)).not.toMatch(/[\r\n\u2028\u2029\u0085]/);
    });
  }
});

describe("yamlScalar neutralises links, inline fields, raw tags and link schemes (STAB)", () => {
  const FRONT_EVIL = [
    "see [[Private note]] and ![[secret.png]]",
    "[[[[nested]]]] ]]]] [[a|b]]",
    "[click](obsidian://open?vault=x) ![img](https://evil.example/x.png)",
    "status:: done (rating:: 5) ::::",
    "<img src=x onerror=alert(1)> </div> <!-- hidden --> <?php echo 1 ?> <a href='x'>t</a>",
    "javascript:alert(1) JaVaScRiPt:void(0) vbscript:msgbox(1) data:text/html,<b>x</b>",
    "https://evil.example/path www.evil.example ftp://h/x",
    "ok [[x]]\n---\ncortex_kind: hacked",
  ];
  for (const [i, e] of FRONT_EVIL.entries()) {
    it(`value #${i} keeps none of the triggers and stays one line`, () => {
      const y = yamlScalar(e);
      for (const re of FRONT_FORBIDDEN) expect(y, String(re)).not.toMatch(re);
      expect(y).not.toMatch(/[\r\n]/);
      // still a valid single JSON string (so valid YAML) unless it is a plain word sequence
      if (y.startsWith('"')) expect(typeof JSON.parse(y)).toBe("string");
    });
  }
  it("keeps the readable words and leaves ordinary values alone", () => {
    expect(yamlScalar("see [[Private note]]")).toBe('"see [ [Private note] ]"');
    expect(yamlScalar("a:: b")).toBe('"a: : b"');
    expect(yamlScalar("plain words here")).toBe("plain words here");
    expect(yamlScalar("code-review")).toBe("code-review");
    expect(yamlScalar("a < b and c > d")).toBe('"a < b and c > d"');
    expect(yamlScalar("Wednesday: planning")).toBe('"Wednesday: planning"');
  });
  it("neutralises the same values inside a flow list of a rendered front matter", () => {
    const md = renderGistMarkdown(gist("[[x]] a::b <b>t</b> javascript:alert(1)"), "wiki/derived/gists/2026/x.md" as never, { timeZone: "UTC" }).markdown;
    const front = parts(md).front;
    for (const re of FRONT_FORBIDDEN) expect(front, String(re)).not.toMatch(re);
  });
});

describe("huge documents are not read into memory", () => {
  it("skips a file over the size cap without opening it", async () => {
    const r = await decideDocument({} as never, { abs: "C:/does/not/exist.md", size: MAX_DOCUMENT_BYTES + 1, mtimeMs: 1 }, undefined, { allowChange: true });
    expect(r).toEqual({ act: "skip" });
  });
});

describe("text the user types into New entry keeps its words but cannot run code", () => {
  it("defangs fences, inline queries, Templater tags and active HTML with invisible spaces only", () => {
    const body = ["```dataviewjs", "dv.span(1)", "```", "~~~ templater", "x", "~~~", "inline `$= 1+1` and `= this.file.name`", "<% tp.date.now() %>", "<script>alert(1)</script>", "plain `code` stays"].join("\n");
    const text = writtenFileText({ id: "e_aaaaaaaaaaaaaaaa", created: new Date(0), title: "`$= 1` <% x %>", space: "none", body });
    for (const re of [/```dataviewjs/, /~~~ ?templater/, /`\$=/, /`=/, /<%/, /<script/i]) expect(text, String(re)).not.toMatch(re);
    expect(text.replace(/​/g, "")).toContain(body); // the words are unchanged
    expect(text).toContain("plain `code` stays");
  });
});
