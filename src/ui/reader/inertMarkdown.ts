/**
 * Cortex's own inert markdown parser for record text, documents and machine notes (SAFE-01 item 3). Owner: E12.
 *
 * It produces plain data blocks that SafeMarkdown renders as text nodes only:
 *  - headings, paragraphs (soft line breaks kept, as chat text relies on them), emphasis (strong, em, strike),
 *    inline code, lists (ordered, unordered, task boxes, nesting depth), block quotes (callouts included, parsed
 *    recursively to a fixed depth), fenced and indented code, frontmatter (as preformatted text), thematic
 *    breaks and pipe tables;
 *  - nothing is ever interpreted as HTML (tags stay literal text), no image is loaded (remote images become
 *    "Image: ‹alt› · ‹host›"), embeds and wikilinks become their names, and links keep their address for an
 *    explicit, confirmed "Open link" step; `$=` spans and dataviewjs fences are just text;
 *  - secret markers written at import ("[secret kept on this computer]") become numbered lock chips, numbered in
 *    document order so they line up with EntryDetail.secrets (§5.30.7).
 * Work is bounded: inline delimiter searches have a budget, nesting has a depth limit, so hostile or huge text
 * cannot stall the UI thread. Obsidian's MarkdownRenderer is used only for legacy vault notes in the peek.
 */

/** The marker importers write in place of a detected secret (importers/common.ts, shared/secrets.ts). */
export const SECRET_MARKER = "[secret kept on this computer]";

export interface InlineSpan {
  text: string;
  strong?: boolean;
  em?: boolean;
  strike?: boolean;
  code?: boolean;
  /** The address of a link: shown as text, opened only after a confirmation. */
  link?: string;
  /** A remote or embedded image, shown as text and never loaded. */
  image?: { alt: string; host: string };
  /** Index (document order) of a secret marker. */
  secret?: number;
}

export interface ListItem {
  spans: InlineSpan[];
  /** Nesting depth (0 = top level). */
  depth: number;
  /** Task list box: true = done, false = open, undefined = not a task. */
  checked?: boolean;
}

export type SafeBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; spans: InlineSpan[] }
  | { kind: "paragraph"; spans: InlineSpan[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; blocks: SafeBlock[] }
  | { kind: "code"; text: string; lang?: string; secretBase: number }
  | { kind: "rule" }
  | { kind: "table"; header: InlineSpan[][]; rows: InlineSpan[][][] };

const MAX_QUOTE_DEPTH = 4;
const MAX_INLINE_CHARS = 20_000;
const MAX_TABLE_COLUMNS = 24;

// ───────────────────────────── inline ─────────────────────────────

interface InlineState {
  /** Next secret number to assign. */
  secret: number;
  /** Remaining failed delimiter searches before the rest is treated as text. */
  budget: number;
}

const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const WORD = /[\p{L}\p{N}]/u;

function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(url.trim());
  return m?.[1]?.replace(/^[^@]*@/, "") ?? url.trim().slice(0, 60);
}

function push(out: InlineSpan[], span: InlineSpan): void {
  if (span.text.length === 0 && span.secret === undefined && span.image === undefined) return;
  const last = out[out.length - 1];
  const plain = (s: InlineSpan) => !s.strong && !s.em && !s.strike && !s.code && s.link === undefined && s.image === undefined && s.secret === undefined;
  if (last && plain(last) && plain(span)) last.text += span.text;
  else out.push(span);
}

/** Find a closing delimiter run (exactly `delim`) after `from`, honouring flanking; -1 when none. */
function findCloser(s: string, delim: string, from: number, st: InlineState): number {
  let i = from;
  while (i < s.length) {
    const j = s.indexOf(delim, i);
    if (j < 0) break;
    const before = s[j - 1] ?? " ";
    const after = s[j + delim.length] ?? " ";
    const leftOk = !/\s/.test(before) && before !== "\\";
    const intraword = delim[0] === "_" && WORD.test(after);
    // A longer run of the same character is not this closer (e.g. "***" when looking for "*").
    const sameRun = s[j + delim.length] === delim[0] && delim.length === 1 && delim[0] !== "~";
    if (leftOk && !intraword && !sameRun && j > from) return j;
    i = j + 1;
  }
  st.budget--;
  return -1;
}

function parseInlineInto(s: string, out: InlineSpan[], st: InlineState, marks: Omit<InlineSpan, "text">, depth: number): void {
  let i = 0;
  let text = "";
  const flush = () => {
    if (text) push(out, { ...marks, text });
    text = "";
  };
  while (i < s.length) {
    const c = s[i] as string;
    if (st.budget <= 0) {
      text += s.slice(i);
      break;
    }
    // secret marker
    if (c === "[" && s.startsWith(SECRET_MARKER, i)) {
      flush();
      out.push({ text: "", secret: st.secret++ });
      i += SECRET_MARKER.length;
      continue;
    }
    // escapes
    if (c === "\\" && i + 1 < s.length && PUNCT.test(s[i + 1] as string)) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    // code spans
    if (c === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const fence = "`".repeat(n);
      let j = s.indexOf(fence, i + n);
      while (j >= 0 && s[j + n] === "`") j = s.indexOf(fence, j + n + 1);
      if (j > 0) {
        flush();
        let body = s.slice(i + n, j).replace(/\n/g, " ");
        if (body.length > 2 && body.startsWith(" ") && body.endsWith(" ") && body.trim().length > 0) body = body.slice(1, -1);
        push(out, { ...marks, text: body, code: true });
        i = j + n;
        continue;
      }
      text += fence;
      i += n;
      continue;
    }
    // embeds and wikilinks: ![[name]] and [[target|alias]] → their name, as text
    if ((c === "!" && s.startsWith("![[", i)) || (c === "[" && s.startsWith("[[", i))) {
      const start = c === "!" ? i + 3 : i + 2;
      const j = s.indexOf("]]", start);
      if (j > start && j - start < 400 && !s.slice(start, j).includes("\n")) {
        const inner = s.slice(start, j);
        const alias = inner.includes("|") ? inner.slice(inner.indexOf("|") + 1) : inner;
        text += alias.trim() || inner;
        i = j + 2;
        continue;
      }
    }
    // images ![alt](url) and links [text](url)
    if ((c === "!" && s[i + 1] === "[") || c === "[") {
      const open = c === "!" ? i + 1 : i;
      const close = s.indexOf("](", open + 1);
      if (close > open && close - open < 1000 && !s.slice(open + 1, close).includes("\n")) {
        const end = s.indexOf(")", close + 2);
        if (end > close) {
          const inner = s.slice(open + 1, close);
          const target = s.slice(close + 2, end).trim().replace(/\s+"[^"]*"$/, "").replace(/^<|>$/g, "");
          if (target.length > 0 && !/\s/.test(target)) {
            flush();
            if (c === "!") push(out, { ...marks, text: inner, image: { alt: inner, host: hostOf(target) } });
            else {
              const label: InlineSpan[] = [];
              parseInlineInto(inner, label, st, { ...marks }, depth + 1);
              for (const l of label) push(out, { ...l, link: target });
              if (label.length === 0) push(out, { ...marks, text: target, link: target });
            }
            i = end + 1;
            continue;
          }
        }
      }
      st.budget--;
    }
    // autolinks <https://…>
    if (c === "<") {
      const m = /^<([a-z][a-z0-9+.-]{1,31}:[^\s<>]+)>/i.exec(s.slice(i, i + 2048));
      if (m?.[1]) {
        flush();
        push(out, { ...marks, text: m[1], link: m[1] });
        i += m[0].length;
        continue;
      }
    }
    // bare web links
    if ((c === "h" || c === "H") && /^https?:\/\//i.test(s.slice(i, i + 8)) && !WORD.test(s[i - 1] ?? " ")) {
      const m = /^https?:\/\/[^\s<>"'`]+/i.exec(s.slice(i, i + 4096));
      if (m) {
        const url = m[0].replace(/[.,;:!?)\]]+$/, "");
        flush();
        push(out, { ...marks, text: url, link: url });
        i += url.length;
        continue;
      }
    }
    // emphasis
    if ((c === "*" || c === "_" || c === "~") && depth < 6) {
      const double = s[i + 1] === c;
      if (c === "~" && !double) {
        text += c;
        i++;
        continue;
      }
      const delim = double ? c + c : c;
      const next = s[i + delim.length] ?? " ";
      const prev = s[i - 1] ?? " ";
      const canOpen = !/\s/.test(next) && !(c === "_" && WORD.test(prev));
      if (canOpen) {
        const j = findCloser(s, delim, i + delim.length, st);
        if (j > 0) {
          flush();
          const kind: Omit<InlineSpan, "text"> = c === "~" ? { strike: true } : double ? { strong: true } : { em: true };
          parseInlineInto(s.slice(i + delim.length, j), out, st, { ...marks, ...kind }, depth + 1);
          i = j + delim.length;
          continue;
        }
      }
      text += delim;
      i += delim.length;
      continue;
    }
    text += c;
    i++;
  }
  flush();
}

/** Inline parse: emphasis, code, strike, links and images as text, secret markers. Everything else is text. */
export function parseInline(s: string, state?: { secret: number }): InlineSpan[] {
  const st: InlineState = { secret: state?.secret ?? 0, budget: 200 };
  const out: InlineSpan[] = [];
  if (s.length > MAX_INLINE_CHARS) {
    // Very long runs: keep secrets numbered, render the rest as plain text.
    const parts = s.split(SECRET_MARKER);
    parts.forEach((part, k) => {
      if (k > 0) out.push({ text: "", secret: st.secret++ });
      push(out, { text: part });
    });
  } else parseInlineInto(s, out, st, {}, 0);
  if (state) state.secret = st.secret;
  return out;
}

// ───────────────────────────── blocks ─────────────────────────────

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^([ \t]*)([-*+]|(\d{1,9})[.)])(?:[ \t]+(.*))?$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;

function countMarkers(s: string): number {
  let n = 0;
  let i = s.indexOf(SECRET_MARKER);
  while (i >= 0) {
    n++;
    i = s.indexOf(SECRET_MARKER, i + SECRET_MARKER.length);
  }
  return n;
}

function indentWidth(ws: string): number {
  let w = 0;
  for (const ch of ws) w += ch === "\t" ? 4 : 1;
  return w;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells.slice(0, MAX_TABLE_COLUMNS);
}

function isBlockStart(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

function parseLines(lines: readonly string[], st: { secret: number }, depth: number, allowFrontmatter: boolean): SafeBlock[] {
  const blocks: SafeBlock[] = [];
  let i = 0;

  // Frontmatter of a document: shown as preformatted text, never interpreted.
  if (allowFrontmatter && lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, k) => k > 0 && k < 400 && (l.trim() === "---" || l.trim() === "..."));
    if (end > 0) {
      const text = lines.slice(0, end + 1).join("\n");
      blocks.push({ kind: "code", text, lang: "yaml", secretBase: st.secret });
      st.secret += countMarkers(text);
      i = end + 1;
    }
  }

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i++;
      continue;
    }

    // fenced code
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2] ?? "```";
      const ch = marker[0] as string;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const close = new RegExp(`^ {0,3}\\${ch}{${marker.length},}\\s*$`).test(l);
        if (close) {
          i++;
          break;
        }
        body.push(l);
        i++;
      }
      const text = body.join("\n");
      blocks.push({ kind: "code", text, lang: fence[3] || undefined, secretBase: st.secret });
      st.secret += countMarkers(text);
      continue;
    }

    // ATX heading
    const h = HEADING.exec(line);
    if (h && (line.trimStart().length === (h[1] ?? "").length || /^ {0,3}#{1,6}[ \t]/.test(line))) {
      blocks.push({ kind: "heading", level: (h[1]?.length ?? 1) as 1 | 2 | 3 | 4 | 5 | 6, spans: parseInline((h[2] ?? "").trim(), st) });
      i++;
      continue;
    }

    // thematic break
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    // block quote (and callouts): parsed recursively
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i] ?? "");
        if (!m) break;
        inner.push(m[1] ?? "");
        i++;
      }
      if (depth < MAX_QUOTE_DEPTH) blocks.push({ kind: "quote", blocks: parseLines(inner, st, depth + 1, false) });
      else blocks.push({ kind: "paragraph", spans: parseInline(inner.join("\n"), st) });
      continue;
    }

    // pipe table: header row + separator row
    const sep = lines[i + 1];
    if (line.includes("|") && sep !== undefined && sep.includes("-") && TABLE_SEP.test(sep) && splitRow(sep).length === splitRow(line).length) {
      const header = splitRow(line).map((c) => parseInline(c, st));
      const rows: InlineSpan[][][] = [];
      i += 2;
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (l.trim() === "" || !l.includes("|")) break;
        rows.push(splitRow(l).map((c) => parseInline(c, st)));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    // lists
    const li = LIST_ITEM.exec(line);
    if (li) {
      const ordered = li[3] !== undefined;
      const start = ordered ? Math.min(999_999_999, Number(li[3])) : 1;
      const items: ListItem[] = [];
      const baseIndent = indentWidth(li[1] ?? "");
      while (i < lines.length) {
        const l = lines[i] ?? "";
        const m = LIST_ITEM.exec(l);
        if (m) {
          const isOrdered = m[3] !== undefined;
          const ind = indentWidth(m[1] ?? "");
          if (ind <= baseIndent && isOrdered !== ordered) break;
          let body = m[4] ?? "";
          let checked: boolean | undefined;
          const task = /^\[( |x|X)\][ \t]+(.*)$/.exec(body);
          if (task) {
            checked = task[1] !== " ";
            body = task[2] ?? "";
          }
          const item: ListItem = { spans: [], depth: Math.max(0, Math.min(6, Math.floor((ind - baseIndent) / 2))), checked };
          const text: string[] = [body];
          i++;
          // continuation lines: indented, non-blank, not a new item or block
          while (i < lines.length) {
            const c = lines[i] ?? "";
            if (c.trim() === "" || LIST_ITEM.test(c) || (isBlockStart(c) && !/^\s{2,}/.test(c))) break;
            text.push(c.trim());
            i++;
          }
          item.spans = parseInline(text.join("\n"), st);
          items.push(item);
          continue;
        }
        if (l.trim() === "") {
          // a blank line ends the list unless the next line continues it
          const nextLine = lines[i + 1] ?? "";
          if (LIST_ITEM.test(nextLine) && (LIST_ITEM.exec(nextLine)?.[3] !== undefined) === ordered) {
            i++;
            continue;
          }
        }
        break;
      }
      blocks.push({ kind: "list", ordered, start, items });
      continue;
    }

    // indented code (4 spaces or a tab), only where a paragraph cannot continue
    if (/^( {4}|\t)/.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? "";
        if (l.trim() === "") {
          if (/^( {4}|\t)/.test(lines[i + 1] ?? "")) {
            body.push("");
            i++;
            continue;
          }
          break;
        }
        if (!/^( {4}|\t)/.test(l)) break;
        body.push(l.replace(/^( {4}|\t)/, ""));
        i++;
      }
      const text = body.join("\n");
      blocks.push({ kind: "code", text, secretBase: st.secret });
      st.secret += countMarkers(text);
      continue;
    }

    // paragraph (with setext headings)
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (l.trim() === "") break;
      if (para.length > 0) {
        if (/^ {0,3}=+[ \t]*$/.test(l) || /^ {0,3}-{2,}[ \t]*$/.test(l)) {
          blocks.push({ kind: "heading", level: l.trim().startsWith("=") ? 1 : 2, spans: parseInline(para.join("\n"), st) });
          para.length = 0;
          i++;
          break;
        }
        if (FENCE.test(l) || HEADING.test(l) || QUOTE.test(l) || (RULE.test(l) && !/^ {0,3}-/.test(l)) || LIST_ITEM.exec(l)?.[2]?.match(/^[-*+]$/)) break;
      }
      para.push(l.trim());
      i++;
    }
    if (para.length > 0) blocks.push({ kind: "paragraph", spans: parseInline(para.join("\n"), st) });
  }
  return blocks;
}

/**
 * Parse text into inert blocks. `document` allows a leading frontmatter block (shown as preformatted text).
 * Secret markers are numbered in document order across all blocks.
 */
export function parseSafeMarkdown(text: string, opts: { document?: boolean } = {}): SafeBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return parseLines(lines, { secret: 0 }, 0, opts.document === true);
}

/** Plain text of inline spans (titles, aria labels). */
export function spansText(spans: readonly InlineSpan[]): string {
  return spans.map((s) => (s.secret !== undefined ? SECRET_MARKER : s.text)).join("");
}

/** Only http(s) addresses can be opened (after a confirmation); everything else stays text (SAFE-17). */
export function isOpenableLink(href: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(href.trim());
}
