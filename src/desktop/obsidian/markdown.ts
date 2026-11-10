/**
 * Cortex Desktop's stand-in for Obsidian's metadata parser. Pure (no DOM, no Node), so tests run it directly.
 *
 * What it computes, and how it follows Obsidian (only what src/plugin/vaultSource.ts and the readers use):
 *  - frontmatter: only when the file starts with a `---` line and a closing `---` (or `...`) line exists; the YAML
 *    is read with the YAML 1.2 core schema, so dates stay strings ("2026-04-07"), as in Obsidian's cache. A
 *    block that does not parse, or is not a mapping, gives no frontmatter (its position is still reported).
 *    Plain blocks (keys with scalars, flow lists and `- item` lists) take a fast path that gives exactly what
 *    the full parser gives; anything else goes to the `yaml` package.
 *  - links and embeds: `[[target]]`, `[[target#heading|alias]]`, `![[…]]`, and markdown links `[text](path)` /
 *    `![alt](path)` whose target has no URL scheme (decoded, `<…>` allowed). Nothing inside fenced code, inline
 *    code, `%% comments %%` or `<!-- comments -->` counts. An escaped `\[[` is not a link.
 *  - frontmatter links: a top-level string value, or a string in a top-level list, that is exactly one
 *    `[[wikilink]]` (key "related" or "related.0").
 *  - tags: `#tag` at the start of a line or after whitespace; letters, digits, `_`, `-`, `/` and non-ASCII
 *    letters; at least one character that is not a digit. Frontmatter `tags` stay in the frontmatter
 *    (getAllTags() joins both, like Obsidian's helper).
 *  - headings: ATX (`#`…`######` + space) and setext (`===` / `---` under a paragraph line).
 * Not modelled: reference-style links, indented code blocks, math blocks, block ids, sections and list items.
 */
import { parse as parseYamlText, stringify as stringifyYamlText } from "yaml";

export interface Loc {
  line: number;
  col: number;
  offset: number;
}

export interface Pos {
  start: Loc;
  end: Loc;
}

export interface LinkCache {
  /** The link target as written, without the alias (may carry a `#heading` subpath). */
  link: string;
  /** The whole link as it appears in the file. */
  original: string;
  displayText?: string;
  position: Pos;
}

export type EmbedCache = LinkCache;

export interface TagCache {
  tag: string;
  position: Pos;
}

export interface HeadingCache {
  heading: string;
  level: number;
  position: Pos;
}

export interface FrontmatterLinkCache {
  key: string;
  link: string;
  original: string;
  displayText?: string;
}

export type FrontMatterCache = Record<string, unknown>;

export interface CachedMetadata {
  links?: LinkCache[];
  embeds?: EmbedCache[];
  tags?: TagCache[];
  headings?: HeadingCache[];
  frontmatter?: FrontMatterCache;
  frontmatterPosition?: Pos;
  frontmatterLinks?: FrontmatterLinkCache[];
}

// ───────────────────────────── YAML ─────────────────────────────

/** Parse YAML the way Obsidian's properties do (core schema: dates and `yes` stay strings). Throws on bad YAML. */
export function parseYaml(text: string): unknown {
  // logLevel "error": bad YAML still throws, but warnings are not printed to the console for every note.
  return parseYamlText(text, { schema: "core", prettyErrors: false, logLevel: "error" });
}

export function stringifyYaml(value: unknown): string {
  return stringifyYamlText(value);
}

/** Returned by parseSimpleYaml when the block needs the full YAML parser. */
export const NOT_SIMPLE: unique symbol = Symbol("not-simple");
type NotSimple = typeof NOT_SIMPLE;

/** YAML 1.2 core schema type of a plain scalar (as the `yaml` package resolves it). */
export function plainScalar(s: string): unknown {
  // Most values are words: only these first characters can start a null, a boolean or a number.
  if (s !== "" && !"~nNtTfF+-.0123456789".includes(s[0] as string)) return s;
  if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  if (/^[-+]?[0-9]+$/.test(s)) return Number(s);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s.slice(2), 16);
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(s)) return Number(s);
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(s)) return s.startsWith("-") ? -Infinity : Infinity;
  if (/^\.(?:nan|NaN|NAN)$/.test(s)) return Number.NaN;
  return s;
}

const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "0": "\0" };

/** A quoted scalar at the start of `s`: its value and what follows the closing quote, or NOT_SIMPLE. */
function quoted(s: string): { value: string; rest: string } | NotSimple {
  const q = s[0];
  let out = "";
  for (let i = 1; i < s.length; i++) {
    const c = s[i] as string;
    if (q === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return { value: out, rest: s.slice(i + 1) };
      }
      out += c;
      continue;
    }
    if (c === '"') return { value: out, rest: s.slice(i + 1) };
    if (c === "\\") {
      const e = s[i + 1] ?? "";
      if (e === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
        out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
        i += 5;
        continue;
      }
      const v = SIMPLE_ESCAPES[e];
      if (v === undefined) return NOT_SIMPLE;
      out += v;
      i++;
      continue;
    }
    out += c;
  }
  return NOT_SIMPLE; // no closing quote on this line: a multi-line string
}

/** Only whitespace or a comment may follow a value. */
function restIsEmpty(rest: string): boolean {
  return /^\s*(?:#.*)?$/.test(rest) && (rest.trim() === "" || /^\s+#/.test(rest));
}

/** A scalar written after `key: ` or `- ` in block context. */
function blockScalar(raw: string): unknown | NotSimple {
  const s = raw.trim();
  if (s === "") return null;
  const c = s[0] as string;
  if (c === '"' || c === "'") {
    const q = quoted(s);
    if (q === NOT_SIMPLE || !restIsEmpty(q.rest)) return NOT_SIMPLE;
    return q.value;
  }
  if (c === "[") return flowSequence(s);
  let v = s;
  const hash = v.search(/\s#/);
  if (hash >= 0) v = v.slice(0, hash).trimEnd();
  if (v === "") return null;
  if ("{]}#&*!|>%@`,".includes(v[0] as string)) return NOT_SIMPLE;
  if ("-?:".includes(v[0] as string) && (v.length === 1 || /\s/.test(v[1] as string))) return NOT_SIMPLE;
  if (/:\s|:$/.test(v)) return NOT_SIMPLE;
  return plainScalar(v);
}

/** `[a, "b", 3]` on one line, with scalar items only. */
function flowSequence(s: string): unknown[] | NotSimple {
  const items: unknown[] = [];
  let i = 1;
  for (;;) {
    while (s[i] === " ") i++;
    if (s[i] === "]") {
      if (items.length > 0) return NOT_SIMPLE; // a trailing comma: leave the details to the full parser
      return restIsEmpty(s.slice(i + 1)) ? items : NOT_SIMPLE;
    }
    const c = s[i];
    if (c === undefined) return NOT_SIMPLE;
    let value: unknown;
    if (c === '"' || c === "'") {
      const q = quoted(s.slice(i));
      if (q === NOT_SIMPLE) return NOT_SIMPLE;
      value = q.value;
      i = s.length - q.rest.length;
    } else {
      let j = i;
      while (j < s.length && s[j] !== "," && s[j] !== "]") j++;
      const v = s.slice(i, j).trim();
      if (v === "" || "[{}#&*!|>%@`'\"".includes(v[0] as string) || /:\s|:$|\s#/.test(v)) return NOT_SIMPLE;
      if ("-?:".includes(v[0] as string) && (v.length === 1 || /\s/.test(v[1] as string))) return NOT_SIMPLE;
      value = plainScalar(v);
      i = j;
    }
    items.push(value);
    while (s[i] === " ") i++;
    if (s[i] === ",") {
      i++;
      continue;
    }
    if (s[i] === "]") return restIsEmpty(s.slice(i + 1)) ? items : NOT_SIMPLE;
    return NOT_SIMPLE;
  }
}

const KEY_LINE = /^([A-Za-z0-9_$][A-Za-z0-9_$ .\/()+-]*?) *:(?: +(.*?))? *$/;
const ITEM_LINE = /^( *)-(?: +(.*?))? *$/;

/**
 * The frontmatter shapes nearly every note uses — `key: scalar`, `key: [a, b]` and `key:` followed by `- item`
 * lines — read directly, giving exactly what the `yaml` package gives. Anything else (nested mappings, block
 * scalars, multi-line strings, anchors, tabs, odd keys, duplicates) returns NOT_SIMPLE.
 */
export function parseSimpleYaml(text: string): Record<string, unknown> | NotSimple {
  if (text.includes("\t")) return NOT_SIMPLE;
  const lines = text.split(/\r?\n/);
  const out: Record<string, unknown> = {};
  let i = 0;
  const skippable = (l: string): boolean => l.trim() === "" || /^\s*#/.test(l);
  while (i < lines.length) {
    const line = lines[i] as string;
    if (skippable(line)) {
      i++;
      continue;
    }
    const m = KEY_LINE.exec(line);
    if (!m || m[1] === undefined) return NOT_SIMPLE;
    const key = m[1];
    if (key === "__proto__" || Object.prototype.hasOwnProperty.call(out, key)) return NOT_SIMPLE;
    const rest = m[2] ?? "";
    i++;
    if (rest !== "" && !rest.startsWith("#")) {
      const v = blockScalar(rest);
      if (v === NOT_SIMPLE) return NOT_SIMPLE;
      out[key] = v;
      continue;
    }
    // `key:` alone (or with a comment): a list of `- item` lines at one indent, or null.
    let indent = -1;
    const items: unknown[] = [];
    while (i < lines.length) {
      const l = lines[i] as string;
      if (skippable(l)) {
        i++;
        continue;
      }
      const it = ITEM_LINE.exec(l);
      if (!it) {
        if (/^\s/.test(l)) return NOT_SIMPLE; // nested mapping or a continued scalar
        break;
      }
      const ind = (it[1] ?? "").length;
      if (indent === -1) indent = ind;
      else if (ind !== indent) return NOT_SIMPLE;
      const v = blockScalar(it[2] ?? "");
      if (v === NOT_SIMPLE || Array.isArray(v)) return NOT_SIMPLE;
      items.push(v);
      i++;
    }
    out[key] = indent === -1 ? null : items;
  }
  return out;
}

/** Frontmatter YAML → value: the fast path when the block is plain, else the full parser. Throws on bad YAML. */
export function parseFrontmatterYaml(text: string): unknown {
  const simple = parseSimpleYaml(text);
  return simple === NOT_SIMPLE ? parseYaml(text) : simple;
}

// ───────────────────────────── positions ─────────────────────────────

/** Offsets of every line start, for offset → line/col. */
export function lineStarts(text: string): number[] {
  const out = [0];
  let i = text.indexOf("\n");
  while (i !== -1) {
    out.push(i + 1);
    i = text.indexOf("\n", i + 1);
  }
  return out;
}

export function locAt(starts: readonly number[], offset: number): Loc {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, col: offset - (starts[lo] as number), offset };
}

function posOf(starts: readonly number[], from: number, to: number): Pos {
  return { start: locAt(starts, from), end: locAt(starts, to) };
}

// ───────────────────────────── frontmatter ─────────────────────────────

export interface FrontmatterBlock {
  /** The YAML between the fences. */
  yaml: string;
  /** Offset of the first character after the closing fence line (where the body starts). */
  bodyStart: number;
  /** From the opening `---` to the end of the closing fence (Obsidian's frontmatterPosition). */
  from: number;
  to: number;
}

const FENCE_LINE = /^(---|\.\.\.)[ \t]*$/;

/** Locate the frontmatter block: the file must start with `---` and have a closing `---` or `...` line. */
export function findFrontmatter(text: string): FrontmatterBlock | null {
  const from = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (!text.startsWith("---", from)) return null;
  const firstNl = text.indexOf("\n", from);
  if (firstNl === -1 || !/^---[ \t]*\r?$/.test(text.slice(from, firstNl))) return null;
  const yamlStart = firstNl + 1;
  let i = yamlStart;
  while (i <= text.length) {
    const nl = text.indexOf("\n", i);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(i, end).replace(/\r$/, "");
    if (FENCE_LINE.test(line)) {
      const yamlEnd = Math.max(yamlStart, i - 1 - (i >= 2 && text.charCodeAt(i - 2) === 13 ? 1 : 0));
      return { yaml: i === yamlStart ? "" : text.slice(yamlStart, yamlEnd), bodyStart: nl === -1 ? text.length : nl + 1, from, to: i + line.length };
    }
    if (nl === -1) break;
    i = nl + 1;
  }
  return null;
}

/** The frontmatter as Obsidian exposes it: a mapping, or undefined (none, empty, not a mapping, or bad YAML). */
export function parseFrontmatter(text: string): { frontmatter: FrontMatterCache | undefined; block: FrontmatterBlock | null } {
  const block = findFrontmatter(text);
  if (!block) return { frontmatter: undefined, block: null };
  if (block.yaml.trim() === "") return { frontmatter: undefined, block };
  try {
    const v = parseFrontmatterYaml(block.yaml);
    if (v && typeof v === "object" && !Array.isArray(v)) return { frontmatter: v as FrontMatterCache, block };
  } catch {
    // Obsidian shows invalid properties; the cache has no frontmatter.
  }
  return { frontmatter: undefined, block };
}

// ───────────────────────────── masking ─────────────────────────────

type Span = readonly [number, number];

const blankRun = (m: string): string => " ".repeat(m.length);

/** Blank the given [from, to) spans of `text` (newlines kept), in one pass. */
export function blankSpans(text: string, spans: readonly Span[]): string {
  if (spans.length === 0) return text;
  const sorted = spans.length > 1 ? [...spans].sort((a, b) => a[0] - b[0]) : spans;
  const parts: string[] = [];
  let at = 0;
  for (const [a0, b0] of sorted) {
    const a = Math.max(a0, at);
    const b = Math.min(b0, text.length);
    if (b <= a) continue;
    parts.push(text.slice(at, a), text.slice(a, b).replace(/[^\r\n]+/g, blankRun));
    at = b;
  }
  parts.push(text.slice(at));
  return parts.join("");
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/gm;

/** Fenced code blocks from `from` on: opening line to closing line (or the end of the file). */
function fenceSpans(text: string, from: number): Span[] {
  const out: Span[] = [];
  if (!text.includes("```") && !text.includes("~~~")) return out;
  FENCE_OPEN.lastIndex = from;
  for (let m = FENCE_OPEN.exec(text); m; m = FENCE_OPEN.exec(text)) {
    const fence = m[1] as string;
    if (fence[0] === "`" && (m[2] ?? "").includes("`")) continue; // "```x`" is inline code, not a fence
    const start = m.index;
    const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*\\r?$`, "gm");
    close.lastIndex = start + m[0].length;
    const c = close.exec(text);
    const end = c ? c.index + c[0].length : text.length;
    out.push([start, end]);
    if (end >= text.length) break;
    FENCE_OPEN.lastIndex = end;
  }
  return out;
}

/** Inline code: a run of N backticks up to the next run of exactly N inside the same paragraph. */
function inlineCodeSpans(text: string): Span[] {
  const out: Span[] = [];
  const blankLine = /\n[ \t]*\r?\n/g;
  let k = text.indexOf("`");
  while (k !== -1) {
    let n = 0;
    while (text[k + n] === "`") n++;
    blankLine.lastIndex = k;
    const para = blankLine.exec(text);
    const limit = para ? para.index : text.length;
    let j = k + n;
    let close = -1;
    while (j < limit) {
      const at = text.indexOf("`", j);
      if (at === -1 || at >= limit) break;
      let e = at;
      while (text[e] === "`") e++;
      if (e - at === n) {
        close = at;
        break;
      }
      j = e;
    }
    if (close === -1) {
      k = text.indexOf("`", k + n);
      continue;
    }
    out.push([k, close + n]);
    k = text.indexOf("`", close + n);
  }
  return out;
}

/**
 * Replace everything that cannot hold links, tags or headings (fenced code, inline code, `%%` and HTML comments)
 * with spaces, keeping newlines and offsets, so the scanners below can run plain regular expressions.
 * `from` is where the body starts (after the frontmatter); text before it is masked too.
 */
export function maskNonText(text: string, from = 0): string {
  let masked = blankSpans(text, [...(from > 0 ? [[0, from] as const] : []), ...fenceSpans(text, from)]);
  if (masked.includes("%%") || masked.includes("<!--")) {
    const comments: Span[] = [];
    for (const m of masked.matchAll(/%%[\s\S]*?(?:%%|$)|<!--[\s\S]*?(?:-->|$)/g)) comments.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    masked = blankSpans(masked, comments);
  }
  if (masked.includes("`")) masked = blankSpans(masked, inlineCodeSpans(masked));
  return masked;
}

// ───────────────────────────── links ─────────────────────────────

const WIKILINK = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
const MDLINK = /(!?)\[((?:[^\[\]\n]|\[[^\[\]\n]*\])*)\]\(\s*(<[^<>\n]*>|[^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The path part of a link (`Note#Heading` → `Note`). */
export function getLinkpath(linktext: string): string {
  const i = linktext.indexOf("#");
  return i === -1 ? linktext : linktext.slice(0, i);
}

/** Obsidian's parseLinktext: `{ path, subpath }` where subpath keeps its leading `#`. */
export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const i = linktext.indexOf("#");
  return i === -1 ? { path: linktext, subpath: "" } : { path: linktext.slice(0, i), subpath: linktext.slice(i) };
}

function wikiDisplay(target: string): string {
  const { path, subpath } = parseLinktext(target);
  if (!subpath) return path;
  const sub = subpath.replace(/^#\^?/, "").split("#").filter(Boolean).join(" > ");
  return path ? `${path} > ${sub}` : sub;
}

/** One `[[…]]` body → link and display text (`\|` inside tables counts as the alias bar). */
export function splitWikilink(inner: string): { link: string; alias?: string } {
  const body = inner.replace(/\\\|/g, "|");
  const bar = body.indexOf("|");
  const link = (bar === -1 ? body : body.slice(0, bar)).trim();
  const alias = bar === -1 ? undefined : body.slice(bar + 1).trim();
  return alias !== undefined && alias !== "" ? { link, alias } : { link };
}

function decodeTarget(raw: string): string {
  const t = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
  try {
    return decodeURIComponent(t);
  } catch {
    return t;
  }
}

/** True when a markdown link target points into the vault (no URL scheme). */
export function isInternalTarget(raw: string): boolean {
  const t = decodeTarget(raw).trim();
  if (t === "") return false;
  if (/^[a-zA-Z]:[\\/]/.test(t)) return false; // a Windows path is a file URL in disguise, not a vault link
  return !SCHEME.test(t) && !t.startsWith("//");
}

// ───────────────────────────── tags and headings ─────────────────────────────

// A tag ends at whitespace, ASCII punctuation other than `_`, `-` and `/`, or general / CJK punctuation.
const PUNCTUATION_RANGES = [
  [0x2000, 0x206f],
  [0x2e00, 0x2e7f],
  [0x3000, 0x303f],
]
  .map(([a, b]) => `${String.fromCharCode(a as number)}-${String.fromCharCode(b as number)}`)
  .join("");
const TAG = new RegExp(`(^|\\s)#([^\\s!"#$%&'()*+,.:;<=>?@^\`{|}~\\[\\]\\\\${PUNCTUATION_RANGES}]+)`, "g");

export function isValidTag(body: string): boolean {
  return body.length > 0 && !/^[0-9]+$/.test(body) && !/^\/|\/$/.test(body);
}

const ATX_LINE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const ATX_ALL = /^ {0,3}#{1,6}(?:[ \t][^\r\n]*)?\r?$/gm;
const ATX_HINT = /(?:^|\n) {0,3}#/;
const UNDERLINE = /^ {0,3}(=+|-+)[ \t]*\r?$/gm;
const NOT_PARAGRAPH = /^ {0,3}(?:[-*+>|#]|\d+[.)](?:[ \t]|$))/;

/** Setext headings: a `===` / `---` line right under a paragraph line (not a list item, quote, table or heading). */
function setextHeadings(masked: string, original: string, at0: number, pos: (a: number, b: number) => Pos): HeadingCache[] {
  const out: HeadingCache[] = [];
  UNDERLINE.lastIndex = 0;
  for (let m = UNDERLINE.exec(masked); m; m = UNDERLINE.exec(masked)) {
    const at = m.index;
    if (at < 2) continue;
    const prevEnd = at - 1 - (masked[at - 2] === "\r" ? 1 : 0);
    const prevStart = masked.lastIndexOf("\n", prevEnd - 1) + 1;
    const prev = masked.slice(prevStart, prevEnd);
    if (prev.trim() === "" || NOT_PARAGRAPH.test(prev)) continue;
    const end = at + m[0].replace(/\r$/, "").length;
    out.push({ heading: original.slice(prevStart, prevEnd).trim(), level: (m[1] ?? "=")[0] === "=" ? 1 : 2, position: pos(at0 + prevStart, at0 + end) });
  }
  return out;
}

// ───────────────────────────── the parser ─────────────────────────────

/** Everything Cortex reads from Obsidian's metadata cache for one markdown file. */
export function parseMarkdownMetadata(text: string): CachedMetadata {
  const out: CachedMetadata = {};
  let starts: number[] | null = null;
  const pos = (from: number, to: number): Pos => posOf((starts ??= lineStarts(text)), from, to);
  const { frontmatter, block } = parseFrontmatter(text);
  if (block) out.frontmatterPosition = pos(block.from, block.to);
  if (frontmatter) {
    out.frontmatter = frontmatter;
    const fl = frontmatterLinks(frontmatter);
    if (fl.length > 0) out.frontmatterLinks = fl;
  }
  // Only the body is scanned; `base` turns body offsets back into file offsets.
  const base = block ? block.bodyStart : 0;
  const body = base > 0 ? text.slice(base) : text;
  const masked = maskNonText(body);

  const links: LinkCache[] = [];
  const embeds: EmbedCache[] = [];
  const spans: [number, number][] = [];
  if (masked.includes("[[")) {
    for (const m of masked.matchAll(WIKILINK)) {
      const at = m.index ?? 0;
      if (at > 0 && masked[at - 1] === "\\") continue;
      spans.push([at, at + m[0].length]);
      const original = body.slice(at, at + m[0].length);
      const { link, alias } = splitWikilink(original.slice(m[1] ? 3 : 2, -2));
      if (!link && !alias) continue;
      (m[1] ? embeds : links).push({ link, original, displayText: alias ?? wikiDisplay(link), position: pos(base + at, base + at + m[0].length) });
    }
  }
  // Markdown links are looked for outside wikilinks only.
  if (masked.includes("](")) {
    for (const m of blankSpans(masked, spans).matchAll(MDLINK)) {
      const at = m.index ?? 0;
      if (at > 0 && masked[at - 1] === "\\") continue;
      spans.push([at, at + m[0].length]);
      const target = m[3] ?? "";
      if (!isInternalTarget(target)) continue;
      const original = body.slice(at, at + m[0].length);
      (m[1] ? embeds : links).push({ link: decodeTarget(target).trim(), original, displayText: m[2] ?? "", position: pos(base + at, base + at + m[0].length) });
    }
  }
  const byOffset = (a: LinkCache, b: LinkCache): number => a.position.start.offset - b.position.start.offset;
  if (links.length > 0) out.links = links.sort(byOffset);
  if (embeds.length > 0) out.embeds = embeds.sort(byOffset);

  // A `#` inside a link (`[[Note#Heading]]`, `(page.md#part)`) is never a tag.
  const tags: TagCache[] = [];
  if (masked.includes("#")) {
    for (const m of blankSpans(masked, spans).matchAll(TAG)) {
      const tagBody = m[2] ?? "";
      if (!isValidTag(tagBody)) continue;
      const at = (m.index ?? 0) + (m[1] ?? "").length;
      // Masking turned link and code text into spaces: the real character before the `#` must be one too.
      if (at > 0 && !/\s/.test(body[at - 1] ?? "")) continue;
      tags.push({ tag: `#${tagBody}`, position: pos(base + at, base + at + tagBody.length + 1) });
    }
  }
  if (tags.length > 0) out.tags = tags;

  const headings: HeadingCache[] = [];
  if (ATX_HINT.test(masked)) {
    for (const m of masked.matchAll(ATX_ALL)) {
      const at = m.index ?? 0;
      const orig = body.slice(at, at + m[0].length).replace(/\r$/, "");
      const atx = ATX_LINE.exec(orig);
      if (!atx || !atx[1]) continue;
      headings.push({ heading: (atx[2] ?? "").trim(), level: atx[1].length, position: pos(base + at, base + at + orig.length) });
    }
  }
  if (masked.includes("==") || masked.includes("--")) headings.push(...setextHeadings(masked, body, base, pos));
  if (headings.length > 0) out.headings = headings.sort((a, b) => a.position.start.offset - b.position.start.offset);
  return out;
}

const WHOLE_WIKILINK = /^\[\[([^\[\]\n]+?)\]\]$/;

/** Frontmatter values that are exactly one wikilink (Obsidian's property links). */
export function frontmatterLinks(fm: FrontMatterCache): FrontmatterLinkCache[] {
  const out: FrontmatterLinkCache[] = [];
  const take = (key: string, v: unknown): void => {
    if (typeof v !== "string") return;
    const m = WHOLE_WIKILINK.exec(v.trim());
    if (!m || !m[1]) return;
    const { link, alias } = splitWikilink(m[1]);
    if (!link) return;
    out.push({ key, link, original: v.trim(), displayText: alias ?? wikiDisplay(link) });
  };
  for (const [key, v] of Object.entries(fm)) {
    if (Array.isArray(v)) v.forEach((x, i) => take(`${key}.${i}`, x));
    else take(key, v);
  }
  return out;
}

/** Inline tags plus frontmatter `tags` / `tag` (Obsidian's getAllTags), each with a leading `#`. */
export function getAllTags(cache: CachedMetadata): string[] {
  const out: string[] = [];
  const fm = cache.frontmatter;
  for (const key of ["tags", "tag"]) {
    const v = fm?.[key];
    const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : [];
    for (const t of list) {
      if (typeof t !== "string") continue;
      const body = t.trim().replace(/^#/, "");
      if (isValidTag(body)) out.push(`#${body}`);
    }
  }
  for (const t of cache.tags ?? []) out.push(t.tag);
  return out;
}

// ───────────────────────────── link resolution ─────────────────────────────

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function nameOf(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

/** Normalise a vault path: forward slashes, no leading or doubled slash, `.` and `..` folded. Null if it escapes. */
export function normalizeVaultLink(p: string): string | null {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else map.set(key, [value]);
}

function drop(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (!list) return;
  const i = list.indexOf(value);
  if (i >= 0) list.splice(i, 1);
  if (list.length === 0) map.delete(key);
}

/**
 * Obsidian's getFirstLinkpathDest over a set of vault paths:
 *  1. an empty link is the source file itself;
 *  2. `./` and `../` links resolve from the source's folder only;
 *  3. otherwise the link is tried as an exact path from the vault root (with and without `.md`, case kept);
 *  4. otherwise every file whose path ends with the link (at a folder boundary, `.md` optional, any case)
 *     matches, and the closest wins: the most leading folders shared with the source, then the name written in
 *     the same case, then the shortest path, then folder by folder in name order. Obsidian does not document its
 *     choice among same-named notes; this order reproduces every link it stored for a large real vault (over
 *     50,000 note pairs, checked against the plugin's own vault.cxi).
 */
export class LinkResolver {
  private readonly exact = new Set<string>();
  private readonly lower = new Map<string, string[]>();
  private readonly byName = new Map<string, string[]>();

  constructor(paths: Iterable<string> = []) {
    for (const p of paths) this.add(p);
  }

  get size(): number {
    return this.exact.size;
  }

  add(path: string): void {
    if (this.exact.has(path)) return;
    this.exact.add(path);
    push(this.lower, path.toLowerCase(), path);
    const name = nameOf(path).toLowerCase();
    push(this.byName, name, path);
    if (name.endsWith(".md")) push(this.byName, name.slice(0, -3), path);
  }

  remove(path: string): void {
    if (!this.exact.delete(path)) return;
    drop(this.lower, path.toLowerCase(), path);
    const name = nameOf(path).toLowerCase();
    drop(this.byName, name, path);
    if (name.endsWith(".md")) drop(this.byName, name.slice(0, -3), path);
  }

  has(path: string): boolean {
    return this.exact.has(path);
  }

  private direct(p: string, ignoreCase: boolean): string | null {
    if (this.exact.has(p)) return p;
    if (this.exact.has(`${p}.md`)) return `${p}.md`;
    if (!ignoreCase) return null;
    const a = this.lower.get(p.toLowerCase());
    if (a && a.length > 0) return a[0] as string;
    const b = this.lower.get(`${p}.md`.toLowerCase());
    return b && b.length > 0 ? (b[0] as string) : null;
  }

  resolve(linkpath: string, sourcePath: string): string | null {
    const raw = linkpath.trim();
    if (raw === "") return this.exact.has(sourcePath) ? sourcePath : null;
    if (raw.startsWith("./") || raw.startsWith("../")) {
      const rel = normalizeVaultLink(`${dirOf(sourcePath)}/${raw}`);
      return rel ? this.direct(rel, true) : null;
    }
    const p = normalizeVaultLink(raw);
    if (!p) return null;
    const hit = this.direct(p, false);
    if (hit) return hit;
    const want = p.toLowerCase();
    const candidates = (this.byName.get(nameOf(want)) ?? []).filter((c) => {
      const lc = c.toLowerCase();
      const bare = lc.endsWith(".md") ? lc.slice(0, -3) : lc;
      return lc === want || bare === want || lc.endsWith(`/${want}`) || bare.endsWith(`/${want}`);
    });
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0] as string;
    const home = dirOf(sourcePath).split("/").filter(Boolean);
    const shared = (c: string): number => {
      const segs = dirOf(c).split("/").filter(Boolean);
      let n = 0;
      while (n < segs.length && n < home.length && segs[n] === home[n]) n++;
      return n;
    };
    const written = nameOf(p);
    const sameCase = (c: string): number => {
      const n = nameOf(c);
      return n === written || n === `${written}.md` ? 0 : 1;
    };
    const bySegments = (a: string, b: string): number => {
      const sa = a.split("/");
      const sb = b.split("/");
      for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
        const x = sa[i] as string;
        const y = sb[i] as string;
        if (x !== y) return x < y ? -1 : 1;
      }
      return sa.length - sb.length;
    };
    return [...candidates].sort((a, b) => shared(b) - shared(a) || sameCase(a) - sameCase(b) || a.length - b.length || bySegments(a, b))[0] as string;
  }
}

/** Resolved and unresolved link counts for one file (Obsidian's resolvedLinks / unresolvedLinks rows). */
export function resolveFileLinks(cache: CachedMetadata | null | undefined, sourcePath: string, resolver: LinkResolver): { resolved: Record<string, number>; unresolved: Record<string, number> } {
  const resolved: Record<string, number> = {};
  const unresolved: Record<string, number> = {};
  if (!cache) return { resolved, unresolved };
  const all: { link: string }[] = [...(cache.links ?? []), ...(cache.embeds ?? []), ...(cache.frontmatterLinks ?? [])];
  for (const l of all) {
    const linkpath = getLinkpath(l.link);
    const dest = resolver.resolve(linkpath, sourcePath);
    if (dest) resolved[dest] = (resolved[dest] ?? 0) + 1;
    else if (linkpath.trim() !== "") unresolved[linkpath] = (unresolved[linkpath] ?? 0) + 1;
  }
  return { resolved, unresolved };
}
