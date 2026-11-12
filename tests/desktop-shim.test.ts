/**
 * Cortex Desktop's "obsidian" shim: the metadata parser (frontmatter, links, tags, headings), link resolution,
 * and the vault / metadata cache over a real folder, including the plugin-data mount that never writes into the
 * vault. Pure Node: no Electron, no DOM.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findFrontmatter,
  getAllTags,
  LinkResolver,
  maskNonText,
  NOT_SIMPLE,
  parseFrontmatter,
  parseMarkdownMetadata,
  parseSimpleYaml,
  parseYaml,
  resolveFileLinks,
} from "../src/desktop/obsidian/markdown";
import { MetadataCache } from "../src/desktop/obsidian/metadataCache";
import { FileSystemAdapter, ReadOnlyVaultError, Vault } from "../src/desktop/obsidian/vault";

const links = (text: string) => (parseMarkdownMetadata(text).links ?? []).map((l) => l.link);
const tags = (text: string) => (parseMarkdownMetadata(text).tags ?? []).map((t) => t.tag);

describe("desktop shim: frontmatter", () => {
  it("reads a frontmatter block only at the very start, closed by --- or ...", () => {
    expect(parseFrontmatter("---\ntitle: A\n---\nbody").frontmatter).toEqual({ title: "A" });
    expect(parseFrontmatter("---\r\ntitle: A\r\n...\r\nbody").frontmatter).toEqual({ title: "A" });
    expect(parseFrontmatter("\n---\ntitle: A\n---\n").frontmatter).toBeUndefined();
    expect(parseFrontmatter("---\ntitle: A\nno closing fence").frontmatter).toBeUndefined();
    expect(findFrontmatter("---\n---\nbody")?.yaml).toBe("");
    expect(findFrontmatter("---\na: 1\n---\nbody")?.bodyStart).toBe(13);
  });

  it("keeps dates as strings and types scalars like Obsidian's properties (YAML 1.2 core schema)", () => {
    const fm = parseFrontmatter(
      ["---", "created: 2026-04-07", "updated: 2026-05-17T04:30:00", "layer: 2", "ratio: 0.5", "done: true", "empty:", "nothing: null", "yes: yes", 'quoted: "a: b"', "---", ""].join("\n"),
    ).frontmatter;
    expect(fm).toEqual({ created: "2026-04-07", updated: "2026-05-17T04:30:00", layer: 2, ratio: 0.5, done: true, empty: null, nothing: null, yes: "yes", quoted: "a: b" });
  });

  it("reads lists in both forms, and gives no frontmatter for bad YAML or a non-mapping", () => {
    expect(parseFrontmatter("---\ntags:\n  - a\n  - b\nrelated: [\"[[X]]\", y]\n---\n").frontmatter).toEqual({ tags: ["a", "b"], related: ["[[X]]", "y"] });
    expect(parseFrontmatter("---\na: 1\na: 2\n---\n").frontmatter).toBeUndefined();
    expect(parseFrontmatter("---\n- just\n- a list\n---\n").frontmatter).toBeUndefined();
    expect(parseFrontmatter("---\ntitle: [unclosed\n---\n").frontmatter).toBeUndefined();
  });

  it("the fast path gives exactly what the YAML parser gives, and steps aside for anything else", () => {
    const simple = [
      "title: Hot Cache\ntype: concept\ncreated: 2026-04-07",
      "tags:\n- a\n- b\nstatus: evergreen",
      "aliases:\n  - \"hot.md\"\n  - 'Session ''Cache'''\n",
      "n: -12\nf: 1e3\nh: 0x1F\no: 0o17\ninf: -.inf\nt: True\nnul: ~",
      "related: [\"[[index]]\", \"[[log]]\"]\nempty: []\n# a comment\nkey: value # trailing comment",
      "lang: C#\nurl: https://example.com/a#b\ntime: 04:30:00",
    ];
    for (const y of simple) {
      const fast = parseSimpleYaml(y);
      expect(fast, y).not.toBe(NOT_SIMPLE);
      expect(fast, y).toEqual(parseYaml(y));
    }
    for (const y of ["C#: a key the fast path leaves alone", "description: >\n  folded text", "a:\n  b: 1", "x: &anchor 1", "t: \"multi\n  line\"", "k: [a, [b]]", "k:\tv", "a: b: c", "dup: 1\ndup: 2"]) {
      expect(parseSimpleYaml(y), y).toBe(NOT_SIMPLE);
    }
  });
});

describe("desktop shim: links", () => {
  it("finds wikilinks with headings and aliases, embeds, and table-escaped bars", () => {
    const c = parseMarkdownMetadata("See [[Note A]], [[Note B#Part|the part]] and ![[image.png]].\n| [[C\\|alias]] |\n[[#Local heading]]");
    expect(c.links?.map((l) => [l.link, l.displayText])).toEqual([
      ["Note A", "Note A"],
      ["Note B#Part", "the part"],
      ["C", "alias"],
      ["#Local heading", "Local heading"],
    ]);
    expect(c.embeds?.map((l) => l.link)).toEqual(["image.png"]);
    const first = c.links?.[0];
    expect(first?.original).toBe("[[Note A]]");
    expect(first?.position.start).toEqual({ line: 0, col: 4, offset: 4 });
  });

  it("finds markdown links into the vault (decoded, <…> allowed) and skips URLs", () => {
    expect(links("[a](Notes/My%20Note.md) [b](<Other Note.md>) [c](https://example.com) [d](mailto:x@y.z) [e](#heading) ![f](pic.png)")).toEqual(["Notes/My Note.md", "Other Note.md", "#heading"]);
    expect(parseMarkdownMetadata("![f](pic.png)").embeds?.map((e) => e.link)).toEqual(["pic.png"]);
  });

  it("ignores links in code, comments and escapes", () => {
    const text = ["```", "[[In fence]]", "```", "`[[inline code]]` and \\[[escaped]]", "%% [[hidden]] %%", "<!-- [[html comment]] -->", "~~~md", "[[tilde fence]]", "~~~", "[[Real]]"].join("\n");
    expect(links(text)).toEqual(["Real"]);
  });

  it("collects frontmatter values that are exactly one wikilink", () => {
    const c = parseMarkdownMetadata('---\nup: "[[Parent]]"\nrelated:\n  - "[[A]]"\n  - "see [[B]]"\n  - "[[C|Cee]]"\n---\n');
    expect(c.frontmatterLinks?.map((l) => [l.key, l.link])).toEqual([
      ["up", "Parent"],
      ["related.0", "A"],
      ["related.2", "C"],
    ]);
  });
});

describe("desktop shim: tags and headings", () => {
  it("finds inline tags at line start or after whitespace, never in code, links or words", () => {
    expect(tags("#start then #nested/tag, and #snake_case-ok.\nmid#word #123 #a1 `#code` [[Note#heading]] (page.md#part) [[x]]#after")).toEqual(["#start", "#nested/tag", "#snake_case-ok", "#a1"]);
    expect(tags("# Heading is not a tag\n## Heading with #tag")).toEqual(["#tag"]);
  });

  it("getAllTags joins frontmatter tags (list or string) and inline tags", () => {
    expect(getAllTags(parseMarkdownMetadata("---\ntags: [meta, hot-cache]\n---\nbody #inline"))).toEqual(["#meta", "#hot-cache", "#inline"]);
    expect(getAllTags(parseMarkdownMetadata("---\ntags: one, two\n---\n"))).toEqual(["#one", "#two"]);
  });

  it("finds ATX and setext headings outside code", () => {
    const c = parseMarkdownMetadata(["---", "t: 1", "---", "# Title", "Text", "Setext one", "===", "", "Setext two", "---", "```", "# not a heading", "```", "### Closed ###", "- item", "---"].join("\n"));
    expect(c.headings?.map((h) => [h.level, h.heading])).toEqual([
      [1, "Title"],
      [1, "Setext one"],
      [2, "Setext two"],
      [3, "Closed"],
    ]);
    expect(c.headings?.[0]?.position.start.line).toBe(3);
  });

  it("masks code and comments without moving offsets", () => {
    const text = "a `b` c\n```\nd\n```\ne %% f %% g";
    const m = maskNonText(text);
    expect(m.length).toBe(text.length);
    expect(m).toBe("a     c\n   \n \n   \ne         g");
  });
});

describe("desktop shim: link resolution (Obsidian's getFirstLinkpathDest)", () => {
  const r = new LinkResolver([
    "INDEX.md",
    "wiki/index.md",
    "wiki/concepts/_index.md",
    "wiki/entities/_index.md",
    "wiki/kb/3d-graphics/Blender.md",
    "Other Vault/Atlas/Blender.md",
    "wiki/kb/business/acme/Growth.md",
    "wiki/kb/business/acme-strategy/Growth.md",
    "wiki/notes/Same.md",
    "Same.md",
    "assets/pic.png",
    "wiki/notes/sub/Deep.md",
  ]);

  it("resolves exact paths first, with or without .md, case kept", () => {
    expect(r.resolve("wiki/index", "x.md")).toBe("wiki/index.md");
    expect(r.resolve("Same", "wiki/notes/Other.md")).toBe("Same.md");
    expect(r.resolve("assets/pic.png", "x.md")).toBe("assets/pic.png");
  });

  it("picks the closest same-named file: shared folders, then the written case, then the shortest path", () => {
    expect(r.resolve("index", "wiki/meta/session.md")).toBe("wiki/index.md");
    expect(r.resolve("Blender", "wiki/kb/deep/web3d/Lighting.md")).toBe("wiki/kb/3d-graphics/Blender.md");
    expect(r.resolve("Blender", "Other Vault/Notes/x.md")).toBe("Other Vault/Atlas/Blender.md");
    expect(r.resolve("Growth", "wiki/brain/Index.md")).toBe("wiki/kb/business/acme/Growth.md");
    expect(r.resolve("_index", "wiki/entities/Some.md")).toBe("wiki/entities/_index.md");
    expect(r.resolve("pic.png", "wiki/a.md")).toBe("assets/pic.png");
    expect(r.resolve("sub/Deep", "x.md")).toBe("wiki/notes/sub/Deep.md");
  });

  it("resolves relative links from the source folder only, and the empty link to the source", () => {
    expect(r.resolve("./sub/Deep", "wiki/notes/Same.md")).toBe("wiki/notes/sub/Deep.md");
    expect(r.resolve("../index", "wiki/notes/Same.md")).toBe("wiki/index.md");
    expect(r.resolve("../../../../x", "wiki/notes/Same.md")).toBeNull();
    expect(r.resolve("", "Same.md")).toBe("Same.md");
    expect(r.resolve("Missing", "Same.md")).toBeNull();
  });

  it("counts resolved and unresolved links per file", () => {
    const c = parseMarkdownMetadata('---\nup: "[[index]]"\n---\n[[Blender]] [[Blender#x]] [[Nope]] ![[pic.png]]');
    expect(resolveFileLinks(c, "wiki/kb/a.md", r)).toEqual({
      resolved: { "wiki/kb/3d-graphics/Blender.md": 2, "assets/pic.png": 1, "wiki/index.md": 1 },
      unresolved: { Nope: 1 },
    });
  });
});

describe("desktop shim: vault and metadata cache over a folder", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  const setup = () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "cortex-shim-"));
    const vault = path.join(dir, "vault");
    const put = (rel: string, text: string) => {
      const p = path.join(vault, ...rel.split("/"));
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, text);
    };
    put(".obsidian/app.json", JSON.stringify({ userIgnoreFilters: ["skills/"] }));
    put(".obsidian/plugins/cortex/data.json", JSON.stringify({ version: 4, general: { firstRunDone: true } }));
    put(".hidden/secret.md", "[[A]]");
    put("wiki/A.md", "---\ntype: concept\nrelated: [\"[[B]]\"]\n---\n# A\nLinks [[B]] and [[wiki/sub/C|C]] #tag");
    put("wiki/B.md", "[[A]]");
    put("wiki/sub/C.md", "no links");
    put("img.png", "x");
    return { vault, local: path.join(dir, "appdata"), put };
  };

  it("lists visible files like Obsidian (dot folders hidden) and parses every note before it answers", async () => {
    const { vault, local } = setup();
    const v = new Vault(new FileSystemAdapter(vault, { vaultDir: ".obsidian/plugins/cortex", localDir: local, seedDir: path.join(vault, ".obsidian", "plugins", "cortex"), readOnly: false }));
    await v.load();
    expect(v.getMarkdownFiles().map((f) => f.path).sort()).toEqual(["wiki/A.md", "wiki/B.md", "wiki/sub/C.md"]);
    expect(v.getFiles().length).toBe(4);
    expect(v.getConfig("userIgnoreFilters")).toEqual(["skills/"]);
    const a = v.getFileByPath("wiki/A.md");
    expect(a?.basename).toBe("A");
    expect(a?.parent?.path).toBe("wiki");
    expect(a && a.stat.ctime > 0 && a.stat.mtime > 0 && Number.isInteger(a.stat.mtime)).toBe(true);
    const mc = new MetadataCache(v);
    const stats = await mc.initialize();
    expect(stats.markdown).toBe(3);
    expect(mc.getFileCache(a)?.frontmatter?.type).toBe("concept");
    expect(mc.getFileCache(a)?.headings?.[0]?.heading).toBe("A");
    expect(mc.resolvedLinks["wiki/A.md"]).toEqual({ "wiki/B.md": 2, "wiki/sub/C.md": 1 });
    expect(mc.getFirstLinkpathDest("C", "wiki/A.md")?.path).toBe("wiki/sub/C.md");
    expect(mc.fileToLinktext(v.getFileByPath("wiki/sub/C.md")!, "wiki/A.md")).toBe("C");
  });

  it("never writes into the vault: data.json is read from the vault, written to the desktop folder", async () => {
    const { vault, local } = setup();
    const seedFile = path.join(vault, ".obsidian", "plugins", "cortex", "data.json");
    const before = readFileSync(seedFile, "utf8");
    const adapter = new FileSystemAdapter(vault, { vaultDir: ".obsidian/plugins/cortex", localDir: local, seedDir: path.dirname(seedFile), readOnly: false });
    expect(await adapter.exists(".obsidian/plugins/cortex/data.json")).toBe(true);
    expect(JSON.parse(await adapter.read(".obsidian/plugins/cortex/data.json")).version).toBe(4);
    await adapter.write(".obsidian/plugins/cortex/data.json", '{"version":5}');
    await adapter.write(".obsidian/plugins/cortex/.data.json.bak", "{}");
    expect(readFileSync(seedFile, "utf8")).toBe(before);
    expect(existsSync(path.join(vault, ".obsidian", "plugins", "cortex", ".data.json.bak"))).toBe(false);
    expect(readFileSync(path.join(local, "data.json"), "utf8")).toBe('{"version":5}');
    expect(JSON.parse(await adapter.read(".obsidian/plugins/cortex/data.json")).version).toBe(5);
    await expect(adapter.write("wiki/A.md", "changed")).rejects.toBeInstanceOf(ReadOnlyVaultError);
    await expect(adapter.write(".obsidian/app.json", "{}")).rejects.toBeInstanceOf(ReadOnlyVaultError);
    const v = new Vault(adapter);
    await v.load();
    await expect(v.modify(v.getFileByPath("wiki/A.md")!)).rejects.toBeInstanceOf(ReadOnlyVaultError);
  });

  it("follows the folder: a new, changed or deleted note updates the cache and re-resolves links", async () => {
    const { vault, local, put } = setup();
    const v = new Vault(new FileSystemAdapter(vault, { vaultDir: ".obsidian/plugins/cortex", localDir: local, seedDir: null, readOnly: true }));
    await v.load();
    const mc = new MetadataCache(v);
    await mc.initialize();
    v.onChanges = (c) => mc.applyChanges(c);
    const resolved = () => new Promise<void>((resolve) => {
      const ref = mc.on("resolved", () => {
        mc.offref(ref);
        resolve();
      });
    });
    const events: string[] = [];
    v.on("create", (f: { path: string }) => events.push(`create ${f.path}`));
    v.on("delete", (f: { path: string }) => events.push(`delete ${f.path}`));
    v.startWatching();
    try {
      expect(mc.resolvedLinks["wiki/B.md"]).toEqual({ "wiki/A.md": 1 });
      let done = resolved();
      put("wiki/New.md", "---\ntype: log\n---\n[[Missing]]");
      await done;
      expect(mc.getFileCache(v.getFileByPath("wiki/New.md"))?.frontmatter?.type).toBe("log");
      expect(mc.unresolvedLinks["wiki/New.md"]).toEqual({ Missing: 1 });
      done = resolved();
      put("wiki/Missing.md", "now here");
      await done;
      expect(mc.resolvedLinks["wiki/New.md"]).toEqual({ "wiki/Missing.md": 1 });
      done = resolved();
      rmSync(path.join(vault, "wiki", "Missing.md"));
      await done;
      expect(v.getFileByPath("wiki/Missing.md")).toBeNull();
      expect(mc.unresolvedLinks["wiki/New.md"]).toEqual({ Missing: 1 });
      expect(events).toContain("create wiki/New.md");
      expect(events).toContain("delete wiki/Missing.md");
    } finally {
      v.stopWatching();
    }
  });

  it("view-only runs keep writes in memory", async () => {
    const { vault, local } = setup();
    const adapter = new FileSystemAdapter(vault, { vaultDir: ".obsidian/plugins/cortex", localDir: local, seedDir: path.join(vault, ".obsidian", "plugins", "cortex"), readOnly: true });
    await adapter.write(".obsidian/plugins/cortex/data.json", '{"version":9}');
    expect(JSON.parse(await adapter.read(".obsidian/plugins/cortex/data.json")).version).toBe(9);
    expect(existsSync(path.join(local, "data.json"))).toBe(false);
  });
});
