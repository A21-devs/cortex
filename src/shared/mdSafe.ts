/**
 * Markdown is code in this vault (SAFE-01): Dataview runs with DataviewJS and inline DataviewJS enabled, so a
 * `$=…` inline span or a ```dataviewjs fence in a rendered note executes JavaScript with Node access. Owner: E2.
 *
 * Every model string and every quote that reaches a markdown file goes through `mdInert`:
 *  - line breaks of every kind (CR, LF, VT, FF, NEL, U+2028, U+2029) collapse to one space and tabs become
 *    spaces, so no multi-line structure (fence, table, heading, list, setext rule) can be smuggled in;
 *  - C0/C1 controls, bidi overrides and isolates and the BOM are removed (no invisible reordering);
 *  - ` \ * _ [ ] ( ) < > ! # | ~ = $ % ^ { } & are backslash-escaped and every run of two or more colons is
 *    escaped colon by colon: no code spans, fences, math, comments, links, embeds, HTML, entities, tags, tables,
 *    highlights, footnotes, block refs or Dataview inline fields;
 *  - URL schemes (`https://`, `obsidian://`, `javascript:` …) and `www.` get a zero-width space so neither
 *    Obsidian's autolinker nor a click can follow them;
 *  - a leading list or ordered-list marker (-, +, digits + "." or ")") is escaped.
 * Only Cortex code emits links (footnote citations and obsidian://cortex links built from validated ids).
 * `injectionSignals` flags model output that tried any of this; validators drop the field, raise a Checks card
 * and emit a warning (code "injection-signal"). Pure module: no Node, no DOM.
 */

/** Markdown, Obsidian and Dataview punctuation that is always backslash-escaped. */
const ESCAPE = /[`\\*_[\]()<>!#|~=$%^{}&]/g;
/** Everything a markdown or YAML parser may treat as a line break. */
const BREAKS = /[\r\n\u000b\u000c\u0085\u2028\u2029]+/g;
/** Invisible controls: C0 (except tab and breaks), DEL, C1, bidi marks, embeddings, overrides, isolates, BOM. */
const CONTROLS = /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const ZWSP = "\u200b";
/** `scheme://` (any scheme) and the schemes that act without slashes. */
const URL_SCHEME = /\b([a-z][a-z0-9+.-]{0,31})(?=:\/\/)/gi;
const BARE_SCHEME = /\b(javascript|vbscript|data|file|obsidian|mailto|tel)(?=:)/gi;
const WWW = /\b(www)(?=\.)/gi;

/** Remove invisible controls and turn every kind of line break and tab into a single space. */
export function flattenText(s: string): string {
  return String(s).replace(CONTROLS, "").replace(BREAKS, " ").replace(/\t/g, " ");
}

export function mdInert(s: string): string {
  let out = flattenText(s);
  out = out.replace(ESCAPE, (c) => `\\${c}`);
  out = out.replace(/:{2,}/g, (run) => "\\:".repeat(run.length));
  out = out.replace(URL_SCHEME, `$1${ZWSP}`).replace(BARE_SCHEME, `$1${ZWSP}`).replace(WWW, `$1${ZWSP}`);
  out = out.trim();
  // A leading list marker would start a list item if the string ever began a line; escape its punctuation.
  out = out.replace(/^([-+])(?=\s|$)/, "\\$1").replace(/^(\d{1,9})([.)])(?=\s|$)/, "$1\\$2");
  return out;
}

/** Signals that model output tried to inject markdown structure or code (checked BEFORE escaping). */
export const INJECTION_SIGNALS: readonly RegExp[] = [
  /\$=/,
  /dataviewjs/i,
  /```/,
  /~~~/,
  /<\s*script/i,
  /<\s*iframe/i,
  /javascript:/i,
  /obsidian:\/\//i,
  /\]\(/,
  /!\[/,
  /\[\[/,
  /::/,
];

export function injectionSignals(s: string): string[] {
  const text = String(s).replace(CONTROLS, "");
  return INJECTION_SIGNALS.filter((re) => re.test(text)).map((re) => re.source);
}

/** Plain YAML scalars are allowed only for simple word sequences that no YAML schema reads as anything else. */
const YAML_PLAIN = /^[\w./@-]+(?: [\w./@-]+)*$/;
/** Booleans and nulls of YAML 1.1 and 1.2 (yes/no/on/off … are booleans to some parsers). */
const YAML_SPECIAL = /^(?:true|false|yes|no|y|n|on|off|null|nil|none|~)$/i;
/** Numbers in any YAML notation (decimal, octal, hex, binary, sexagesimal, .inf/.nan) and dates or times. */
const YAML_NUMERIC = /^(?:[-+]?(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:e[-+]?\d+)?|[-+]?\.(?:inf|nan)|0[box][\da-f_]+|\d+(?::[0-5]?\d)+(?:\.\d*)?|\d{4}-\d{1,2}-\d{1,2}.*)$/i;

/**
 * A frontmatter value. Simple word sequences stay plain; everything else (and anything a YAML parser would
 * turn into a boolean, null, number or date) becomes a double-quoted string, which is valid YAML because JSON
 * string escapes are a subset of YAML's. Line breaks and invisible controls never survive.
 */
export function yamlScalar(v: string): string {
  // Properties can be rendered as markdown by other plugins and scanned by Templater: no value may hold a code
  // span, an inline query marker, a Templater tag, a wiki link or embed, a markdown link or image, a Dataview
  // inline-field marker, a raw HTML tag or a link scheme. These are broken up with a space (a zero-width space
  // inside a scheme) rather than escaped, because a backslash would show in the value. Every rule looks ahead, so
  // runs such as "[[[" or ":::" are broken everywhere and not only at the first pair.
  const s = flattenText(v)
    .replace(/`/g, "'")
    .replace(/<%/g, "< %")
    .replace(/%>/g, "% >")
    .replace(/\$=/g, "$ =")
    .replace(/!(?=\[)/g, "! ")
    .replace(/\[(?=\[)/g, "[ ")
    .replace(/\](?=[\](])/g, "] ")
    .replace(/:(?=:)/g, ": ")
    .replace(/<(?=[A-Za-z/!?])/g, "< ")
    .replace(URL_SCHEME, `$1${ZWSP}`)
    .replace(BARE_SCHEME, `$1${ZWSP}`)
    .replace(WWW, `$1${ZWSP}`)
    .trim();
  const plain = YAML_PLAIN.test(s) && !/^[-.@/]/.test(s) && !YAML_SPECIAL.test(s) && !YAML_NUMERIC.test(s);
  return plain ? s : JSON.stringify(s);
}

/** Undo mdInert's escapes for display (not exact for zero-width spaces that were already in the input). */
export function mdUnescape(s: string): string {
  return s.replace(/\\([`\\*_[\]()<>!#|~=$%^{}&:.+-])/g, "$1").replace(new RegExp(ZWSP, "g"), "");
}

/** Code-running fences of the vault's plugins (Dataview, DataviewJS, JS Engine, Templater, Buttons, Meta Bind JS). */
const RUNNABLE_FENCE = /(`{3,}|~{3,})([ 	]*)(dataviewjs|dataview|js-?engine|templater[\w-]*|button|meta-bind-js-view)(?![\w-])/gi;
/** Inline queries: a code span that starts with "=" or "$=" (Dataview's default inline prefixes). */
const RUNNABLE_INLINE = /`(\s*)(\$?=)/g;
const HTML_ACTIVE = /<(\/?)(script|iframe|object|embed|style)(?![\w-])/gi;

/**
 * Make text the user typed or pasted safe to store as a vault note WITHOUT changing a word of it: a zero-width
 * space is inserted into every trigger that would make a plugin run code (fence languages, inline `=` / `$=`
 * spans, Templater `<%` tags, active HTML). Visible text and word counts stay the same.
 */
export function defangRunnable(text: string): string {
  return String(text)
    .replace(RUNNABLE_FENCE, `$1$2${ZWSP}$3`)
    .replace(RUNNABLE_INLINE, `\`$1${ZWSP}$2`)
    .replace(/<%/g, `<${ZWSP}%`)
    .replace(HTML_ACTIVE, `<$1${ZWSP}$2`);
}
