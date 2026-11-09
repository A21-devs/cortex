/**
 * Text helpers: titles, slugs, word counts, search tokens, truncation. Owner: E1.
 *
 * Slugs become file names in the vault, so they are lower-case ASCII words joined by "-", never empty, never a
 * Windows device name (con, nul, com1 …) and never start with "wiki" (the vault's case-insensitive `WIKI*.md`
 * ignore rule would silently hide the file). Titles are display text only and never used on stored originals.
 */

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Remove common Markdown and Obsidian inline syntax for one-line titles: embeds, links and wikilinks (alias
 * kept), emphasis, strikethrough, highlights, inline code, comments, footnote references, HTML tags, heading,
 * quote and list markers and task boxes. Intraword underscores (snake_case) are kept.
 */
export function stripMarkdownInline(s: string): string {
  return s
    .replace(/%%[\s\S]*?%%/g, "")
    .replace(/!\[\[[^\]]*\]\]/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[\^[^\]]*\]/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\*(?=\S)([^*]*?\S)\*/g, "$1")
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_]*?\S)_(?![\p{L}\p{N}_])/gu, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/==(?=\S)([\s\S]*?\S)==/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX/-]\]\s+)?/gm, "");
}

let segmenter: { segment(s: string): Iterable<{ segment: string }> } | null | undefined;

function graphemes(s: string): string[] {
  if (segmenter === undefined) {
    const Seg = (Intl as unknown as { Segmenter?: new (locale?: string, opts?: { granularity: "grapheme" }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
    segmenter = typeof Seg === "function" ? new Seg(undefined, { granularity: "grapheme" }) : null;
  }
  if (segmenter) return Array.from(segmenter.segment(s), (x) => x.segment);
  return Array.from(s); // code points: never splits a surrogate pair
}

/** Truncate for display with an ellipsis, never splitting a character (grapheme clusters when supported). */
export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  const parts = graphemes(s);
  if (parts.length <= max) return s;
  return parts.slice(0, Math.max(0, max - 1)).join("").trimEnd() + "…";
}

/** First meaningful line of a text, Markdown removed, truncated to `max` characters with an ellipsis. */
export function firstLineTitle(text: string, max = 80): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = normalizeWhitespace(stripMarkdownInline(raw));
    if (line.length > 0) return truncate(line, max);
  }
  return "";
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * Words in a text: runs of letters and digits (with inner apostrophes and hyphens) count as one word each;
 * Chinese and Japanese characters, which are written without spaces, count one word per character.
 */
export function wordCount(text: string): number {
  let n = 0;
  const m = text.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’-]*/gu);
  if (!m) return 0;
  for (const w of m) {
    if (!CJK.test(w)) {
      n++;
      continue;
    }
    // Split mixed runs: each CJK character is a word, each non-CJK stretch between them is one word.
    let inRun = false;
    for (const ch of w) {
      if (CJK.test(ch)) {
        n++;
        inRun = false;
      } else if (!inRun && /[\p{L}\p{N}]/u.test(ch)) {
        n++;
        inRun = true;
      }
    }
  }
  return n;
}

const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)$/i;

/** Filesystem-safe slug: lowercase ASCII words joined by "-", at most `max` chars, never "wiki…" or a device name. */
export function slugify(title: string, max = 40): string {
  const limit = Math.max(8, Math.floor(max));
  let s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ß/g, "ss")
    .replace(/æ/gi, "ae")
    .replace(/ø/gi, "o")
    .replace(/œ/gi, "oe")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length === 0) s = "untitled";
  if (s.length > limit) {
    const cut = s.slice(0, limit);
    // Prefer a word boundary when it keeps at least half of the room.
    const at = cut.lastIndexOf("-");
    s = at >= Math.floor(limit / 2) ? cut.slice(0, at) : cut;
  }
  if (s.startsWith("wiki")) s = `n-${s}`.slice(0, limit);
  s = s.replace(/-+$/g, "");
  if (RESERVED_NAME.test(s)) s = `${s}-note`;
  return s;
}

const STOP = new Set(["the", "and", "for", "are", "but", "not", "you", "with", "this", "that", "from", "have", "was", "were", "has"]);

/**
 * Search tokens: lower-case runs of letters and digits of length 2–40 with a few English stop words removed.
 * The worker's query parser and the search builders share this function, so its output must stay stable.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /[\p{L}\p{N}]{2,40}/gu;
  for (const m of text.toLowerCase().matchAll(re)) {
    const w = m[0];
    if (!STOP.has(w)) out.push(w);
  }
  return out;
}
