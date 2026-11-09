/**
 * HTML → readable text for Gemini replies (Takeout `safeHtmlItem`) and `.html` files (no DOM in the runner).
 * Owner: E4. Also used by the folder importer (E3).
 *
 * Record text is rendered by Cortex's inert Markdown renderer, so structure becomes Markdown: paragraphs and
 * blocks are blank-line separated, headings `#`, lists `-` / `1.` (nested lists indented), bold `**`, italics
 * `*`, inline code `` ` ``, `<pre>` a fenced block (language from `class="language-…"`), tables pipe rows,
 * blockquotes `>`, and `http(s)` / `mailto` links `[text](url)`. Scripts, styles, `<head>`, templates, SVG and
 * other non-text content are dropped, and so are images. Entities are decoded (named, decimal, hex; C1 numbers
 * as Windows-1252 like browsers do) and numeric ones are clamped to valid code points (SAFE-15). Inline markers
 * are written lazily, so an empty `<b></b>` leaves nothing behind. Unclosed `<li>`, `<td>` and `<tr>` are closed
 * implicitly. Never throws.
 */

const LATIN1_A0 = [
  "nbsp", "iexcl", "cent", "pound", "curren", "yen", "brvbar", "sect", "uml", "copy", "ordf", "laquo", "not", "shy", "reg", "macr",
  "deg", "plusmn", "sup2", "sup3", "acute", "micro", "para", "middot", "cedil", "sup1", "ordm", "raquo", "frac14", "frac12", "frac34", "iquest",
  "Agrave", "Aacute", "Acirc", "Atilde", "Auml", "Aring", "AElig", "Ccedil", "Egrave", "Eacute", "Ecirc", "Euml", "Igrave", "Iacute", "Icirc", "Iuml",
  "ETH", "Ntilde", "Ograve", "Oacute", "Ocirc", "Otilde", "Ouml", "times", "Oslash", "Ugrave", "Uacute", "Ucirc", "Uuml", "Yacute", "THORN", "szlig",
  "agrave", "aacute", "acirc", "atilde", "auml", "aring", "aelig", "ccedil", "egrave", "eacute", "ecirc", "euml", "igrave", "iacute", "icirc", "iuml",
  "eth", "ntilde", "ograve", "oacute", "ocirc", "otilde", "ouml", "divide", "oslash", "ugrave", "uacute", "ucirc", "uuml", "yacute", "thorn", "yuml",
];

const NAMED: Readonly<Record<string, string>> = (() => {
  const m: Record<string, string> = {};
  LATIN1_A0.forEach((name, i) => {
    m[name] = String.fromCodePoint(0xa0 + i);
  });
  Object.assign(m, {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", AMP: "&", LT: "<", GT: ">", QUOT: '"',
    ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍", lrm: "‎", rlm: "‏",
    ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
    lsaquo: "‹", rsaquo: "›", hellip: "…", bull: "•", prime: "′", Prime: "″", dagger: "†", Dagger: "‡", permil: "‰",
    euro: "€", trade: "™", minus: "−", le: "≤", ge: "≥", ne: "≠", asymp: "≈", equiv: "≡", infin: "∞", sum: "∑", prod: "∏",
    radic: "√", int: "∫", part: "∂", nabla: "∇", isin: "∈", notin: "∉", cap: "∩", cup: "∪", sub: "⊂", sup: "⊃", and: "∧", or: "∨",
    forall: "∀", exist: "∃", empty: "∅", sim: "∼", prop: "∝", ang: "∠", there4: "∴", loz: "◊",
    larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", lArr: "⇐", rArr: "⇒", hArr: "⇔",
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", iota: "ι", kappa: "κ",
    lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π", rho: "ρ", sigma: "σ", sigmaf: "ς", tau: "τ", upsilon: "υ",
    phi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ",
    Phi: "Φ", Psi: "Ψ", Omega: "Ω", spades: "♠", clubs: "♣", hearts: "♥", diams: "♦", check: "✓", cross: "✗", star: "☆",
  });
  return m;
})();

/** Numeric references 0x80–0x9F mean Windows-1252 characters (as in browsers). */
const C1: Readonly<Record<number, string>> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ",
  0x8e: "Ž", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›",
  0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};

/** Clamp numeric entities to valid code points (SAFE-15): anything else becomes U+FFFD instead of throwing. */
function codePoint(n: number): string {
  if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return "�";
  return C1[n] ?? String.fromCodePoint(n);
}

/** Decode character references. Named ones need their ";" except the legacy &amp &lt &gt &quot &nbsp. */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]{1,8};?|#[0-9]{1,9};?|[A-Za-z][A-Za-z0-9]{1,31};?)/g, (m, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      return codePoint(parseInt(body.slice(hex ? 2 : 1).replace(/;$/, ""), hex ? 16 : 10));
    }
    if (body.endsWith(";")) return NAMED[body.slice(0, -1)] ?? m;
    return body === "amp" || body === "lt" || body === "gt" || body === "quot" || body === "nbsp" ? (NAMED[body] ?? m) : m;
  });
}

/** Elements whose content is never text. */
const DROP_CONTENT = new Set(["head", "template", "noscript", "svg", "math", "iframe", "object", "canvas", "audio", "video", "map", "select", "datalist"]);
/** Elements whose raw content runs to their end tag without markup inside. */
const RAW_TEXT = new Set(["script", "style", "title", "textarea", "xmp"]);
const RAW_KEEP = new Set(["textarea", "xmp"]);
/** Blocks separated by a blank line. */
const PARAGRAPH = new Set(["p", "figure", "address", "details", "fieldset", "hgroup", "section", "article", "aside", "header", "footer", "main", "nav", "dl", "form"]);
/** Blocks separated by a line break. */
const LINE = new Set(["div", "dt", "dd", "figcaption", "caption", "summary", "legend", "option", "center"]);
const INLINE_MARKS: Readonly<Record<string, string>> = { b: "**", strong: "**", i: "*", em: "*", code: "`", kbd: "`", samp: "`", tt: "`", s: "~~", strike: "~~", del: "~~" };

interface Mark {
  tag: string;
  /** Written before the first character of content. */
  open: string;
  /** Written after the content, only when `open` was written. */
  close: string;
  inline: boolean;
  written: boolean;
  /** List depth of a list-item marker. */
  depth: number;
}

interface TableFrame {
  row: number;
  cells: number;
  header: boolean;
  cellOpen: boolean;
}

class TextWriter {
  private out = "";
  private atLineStart = true;
  private pendingBreak = 0;
  private pendingSpace = false;
  private marks: Mark[] = [];
  private quoteDepth = 0;
  private lists: { ordered: boolean; n: number }[] = [];
  private tables: TableFrame[] = [];
  private preDepth = 0;
  private preLang = "";
  private preOpen = false;

  get inPre(): boolean {
    return this.preDepth > 0;
  }

  private get inCell(): boolean {
    return this.tables.some((t) => t.cellOpen);
  }

  private get inListItem(): boolean {
    return this.marks.some((m) => m.tag === "li");
  }

  private prefix(listMarker: boolean): string {
    let p = "> ".repeat(this.quoteDepth);
    const depth = this.lists.length;
    if (depth > 0 && this.inListItem) p += "  ".repeat(listMarker ? depth - 1 : depth);
    return p;
  }

  /** Ask for a line break (1) or a blank line (2) before the next text. */
  block(n: 1 | 2): void {
    if (this.inCell) {
      this.pendingSpace = true;
      return;
    }
    if (this.out.length > 0) this.pendingBreak = Math.max(this.pendingBreak, n);
    this.pendingSpace = false;
  }

  /** A forced line break (`<br>`). */
  lineBreak(): void {
    if (this.preDepth > 0) {
      this.text("\n");
      return;
    }
    if (this.inCell) {
      this.pendingSpace = true;
      return;
    }
    this.flushBreak();
    if (this.out.length > 0) this.out += "\n";
    this.atLineStart = true;
    this.pendingSpace = false;
  }

  private flushBreak(): void {
    if (this.pendingBreak > 0 && this.out.length > 0) {
      this.out = this.out.replace(/[ \t]+$/, "");
      // A blank line inside a quote keeps its ">" so the quote stays one block.
      if (this.pendingBreak === 2 && this.quoteDepth > 0) this.out += "\n" + "> ".repeat(this.quoteDepth).trimEnd() + "\n";
      else this.out += "\n".repeat(this.pendingBreak);
      this.atLineStart = true;
    }
    this.pendingBreak = 0;
  }

  pushMark(tag: string, open: string, close: string, inline: boolean, depth = 0): void {
    this.marks.push({ tag, open, close, inline, written: false, depth });
  }

  popMark(tag: string): void {
    for (let k = this.marks.length - 1; k >= 0; k--) {
      const m = this.marks[k] as Mark;
      if (m.tag !== tag) continue;
      this.marks.splice(k, 1);
      if (m.written && m.close.length > 0) this.out += m.close;
      return;
    }
  }

  /** Remove list-item markers of `depth` and deeper (an implicit `</li>`). */
  private closeItems(depth: number): void {
    this.marks = this.marks.filter((m) => m.tag !== "li" || m.depth < depth);
  }

  openList(ordered: boolean, start: number): void {
    this.block(this.lists.length > 0 ? 1 : 2);
    this.lists.push({ ordered, n: start });
  }

  closeList(): void {
    this.closeItems(this.lists.length);
    this.lists.pop();
    this.block(this.lists.length > 0 ? 1 : 2);
  }

  /** Start a list item: its marker is written with the item's first text. */
  listItem(): void {
    const depth = Math.max(1, this.lists.length);
    this.closeItems(depth);
    this.block(1);
    const list = this.lists[this.lists.length - 1];
    let marker = "- ";
    if (list?.ordered) marker = `${list.n++}. `;
    this.pushMark("li", marker, "", false, depth);
  }

  endListItem(): void {
    this.closeItems(Math.max(1, this.lists.length));
    this.block(1);
  }

  quote(delta: 1 | -1): void {
    this.block(2);
    this.quoteDepth = Math.max(0, this.quoteDepth + delta);
  }

  openTable(): void {
    this.block(2);
    this.tables.push({ row: 0, cells: 0, header: false, cellOpen: false });
  }

  closeTable(): void {
    this.endRow();
    this.tables.pop();
    this.block(2);
  }

  private endRow(): void {
    const t = this.tables[this.tables.length - 1];
    if (!t) return;
    t.cellOpen = false;
    if (t.cells > 0) {
      this.text(" |");
      if (t.row === 0 && t.header) {
        this.lineBreak();
        this.text("|" + " --- |".repeat(t.cells));
      }
      t.row++;
    }
    t.cells = 0;
    t.header = false;
  }

  /** `<tr>` or `</tr>`: finish the previous row (also an unclosed one) and start a new line. */
  row(): void {
    this.endRow();
    this.block(1);
  }

  cell(header: boolean, closing: boolean): void {
    const t = this.tables[this.tables.length - 1];
    if (!t) {
      if (!closing) this.text(" ");
      return;
    }
    if (closing) {
      t.cellOpen = false;
      return;
    }
    t.cellOpen = false;
    this.text(t.cells === 0 ? "|" : " |");
    this.pendingSpace = true;
    t.cells++;
    if (header) t.header = true;
    t.cellOpen = true;
  }

  startPre(): void {
    this.block(2);
    this.preDepth++;
    if (this.preDepth === 1) {
      this.preLang = "";
      this.preOpen = false;
    }
  }

  setPreLang(lang: string): void {
    if (this.preDepth > 0 && !this.preOpen && /^[\w+#.-]{1,32}$/.test(lang)) this.preLang = lang;
  }

  endPre(): void {
    if (this.preDepth === 0) return;
    this.preDepth--;
    if (this.preDepth > 0) return;
    if (this.preOpen) {
      if (!this.out.endsWith("\n")) this.out += "\n";
      this.out += this.prefix(false) + "```";
      this.atLineStart = false;
    }
    this.preOpen = false;
    this.block(2);
  }

  text(raw: string): void {
    if (raw.length === 0) return;
    if (this.preDepth > 0) {
      this.preText(raw);
      return;
    }
    // Collapse whitespace; U+00A0 from &nbsp; is a hard space and survives.
    const parts = raw.split(/[ \t\n\r\f]+/);
    for (let k = 0; k < parts.length; k++) {
      if (k > 0) this.pendingSpace = true;
      const word = parts[k] as string;
      if (word.length > 0) this.word(word);
    }
  }

  private preText(raw: string): void {
    let t = raw.replace(/\r\n?/g, "\n");
    if (!this.preOpen) {
      t = t.replace(/^\n/, "");
      if (t.length === 0) return;
      this.flushBreak();
      if (this.out.length > 0 && !this.out.endsWith("\n")) this.out += "\n";
      this.out += this.prefix(false) + "```" + this.preLang + "\n";
      this.preOpen = true;
    }
    const pre = this.prefix(false);
    this.out += pre.length > 0 ? t.replace(/\n(?!$)/g, "\n" + pre) : t;
    this.atLineStart = this.out.endsWith("\n");
  }

  private word(w: string): void {
    this.flushBreak();
    if (this.atLineStart) {
      const listMarker = this.marks.some((m) => m.tag === "li" && !m.written);
      this.out += this.prefix(listMarker);
    }
    // Block marks (list markers, heading hashes) first, then the space, then inline marks, then the word.
    for (const m of this.marks) {
      if (m.written || m.inline) continue;
      this.out += m.open;
      m.written = true;
      this.atLineStart = false;
      this.pendingSpace = false;
    }
    if (this.pendingSpace && !this.atLineStart) this.out += " ";
    this.pendingSpace = false;
    for (const m of this.marks) {
      if (m.written || !m.inline) continue;
      this.out += m.open;
      m.written = true;
    }
    this.out += w;
    this.atLineStart = false;
  }

  finish(): string {
    for (let k = this.marks.length - 1; k >= 0; k--) {
      const m = this.marks[k] as Mark;
      if (m.written && m.close.length > 0) this.out += m.close;
    }
    if (this.preOpen) {
      if (!this.out.endsWith("\n")) this.out += "\n";
      this.out += "```";
    }
    return this.out
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/ /g, " ")
      .replace(/^\n+|\n+$/g, "");
  }
}

function attr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i");
  const m = re.exec(attrs);
  if (!m) return undefined;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
}

/** Only web and mail links survive; characters that would end a Markdown link are percent-encoded. */
function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const h = href.trim();
  if (!/^(https?:\/\/|mailto:)/i.test(h) || /[\u0000-\u001f]/.test(h)) return undefined;
  return h.replace(/[\s()<>[\]]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

const TOKEN = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[([\s\S]*?)(?:\]\]>|$)|<![^>]*>?|<\?[^>]*>?|<(\/?)([A-Za-z][A-Za-z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

export function htmlToText(html: string): string {
  if (typeof html !== "string" || html.length === 0) return "";
  const w = new TextWriter();
  const drop: string[] = [];
  let pos = 0;
  const token = new RegExp(TOKEN.source, "g");
  for (let m = token.exec(html); m !== null; m = token.exec(html)) {
    if (m.index > pos && drop.length === 0) w.text(decodeEntities(html.slice(pos, m.index)));
    pos = token.lastIndex;
    if (m[1] !== undefined) {
      if (drop.length === 0) w.text(m[1]); // CDATA is literal text
      continue;
    }
    const name = m[3]?.toLowerCase();
    if (name === undefined) continue; // comment, doctype, processing instruction
    const closing = m[2] === "/";
    const attrs = m[4] ?? "";
    const selfClosing = /\/\s*$/.test(attrs);

    if (!closing && RAW_TEXT.has(name) && !selfClosing) {
      const endRe = new RegExp(`</${name}(?=[\\s/>])`, "ig");
      endRe.lastIndex = pos;
      const end = endRe.exec(html);
      const stop = end ? end.index : html.length;
      if (RAW_KEEP.has(name) && drop.length === 0) {
        w.block(1);
        w.text(decodeEntities(html.slice(pos, stop)));
        w.block(1);
      }
      const gt = end ? html.indexOf(">", end.index) : -1;
      pos = gt < 0 ? html.length : gt + 1;
      token.lastIndex = pos;
      continue;
    }
    if (DROP_CONTENT.has(name)) {
      if (closing) {
        const at = drop.lastIndexOf(name);
        if (at >= 0) drop.length = at;
      } else if (!selfClosing) drop.push(name);
      continue;
    }
    if (name === "body" && !closing && drop.includes("head")) drop.length = 0; // an unclosed <head>
    if (drop.length > 0) continue;
    handleTag(w, name, closing, attrs, selfClosing);
  }
  if (pos < html.length && drop.length === 0) w.text(decodeEntities(html.slice(pos)));
  return w.finish();
}

function handleTag(w: TextWriter, name: string, closing: boolean, attrs: string, selfClosing: boolean): void {
  if (name === "br") {
    w.lineBreak();
    return;
  }
  if (name === "pre") {
    if (closing) w.endPre();
    else if (!selfClosing) w.startPre();
    return;
  }
  if (w.inPre) {
    if (!closing && name === "code") {
      const lang = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/.exec(attr(attrs, "class") ?? "")?.[1];
      if (lang) w.setPreLang(lang);
    }
    return; // markup inside <pre> carries no structure
  }
  if (name === "hr") {
    w.block(2);
    w.text("---");
    w.block(2);
    return;
  }
  if (name === "ul" || name === "ol") {
    if (closing) w.closeList();
    else {
      const start = Number.parseInt(attr(attrs, "start") ?? "1", 10);
      w.openList(name === "ol", Number.isFinite(start) ? start : 1);
    }
    return;
  }
  if (name === "li") {
    if (closing) w.endListItem();
    else w.listItem();
    return;
  }
  if (name === "blockquote") {
    w.quote(closing ? -1 : 1);
    return;
  }
  if (/^h[1-6]$/.test(name)) {
    if (closing) {
      w.popMark(name);
      w.block(2);
    } else {
      w.block(2);
      w.pushMark(name, "#".repeat(Number(name[1])) + " ", "", false);
    }
    return;
  }
  if (name === "table") {
    if (closing) w.closeTable();
    else w.openTable();
    return;
  }
  if (name === "tr") {
    w.row();
    return;
  }
  if (name === "td" || name === "th") {
    w.cell(name === "th", closing);
    return;
  }
  if (name === "a") {
    if (closing) w.popMark("a");
    else {
      const href = safeHref(attr(attrs, "href"));
      w.pushMark("a", href ? "[" : "", href ? `](${href})` : "", true);
    }
    return;
  }
  const inline = INLINE_MARKS[name];
  if (inline !== undefined) {
    if (closing) w.popMark(name);
    else if (!selfClosing) w.pushMark(name, inline, inline, true);
    return;
  }
  if (PARAGRAPH.has(name)) {
    w.block(2);
    return;
  }
  if (LINE.has(name)) w.block(1);
}
