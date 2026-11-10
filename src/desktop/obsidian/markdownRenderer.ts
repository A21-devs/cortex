/**
 * Obsidian's MarkdownRenderer for Cortex Desktop (Cortex uses it only for the vault-note peek). Markdown is
 * rendered with `marked` (GitHub flavour) plus `[[wikilinks]]`; the frontmatter becomes a small properties list
 * and `%% comments %%` are dropped. The renderer runs in a window with Node access, so nothing from a note is
 * ever treated as markup: raw HTML is shown as text, links keep http(s), mailto and obsidian URLs only, remote
 * images are not loaded (their alt text shows), and vault images load from their files.
 * Not rendered like Obsidian: embeds (shown as links), callout styling, Dataview / plugin blocks, math.
 */
import { Marked, type Tokens } from "marked";
import { findFrontmatter, parseFrontmatter, splitWikilink } from "./markdown";
import type { Component } from "./component";

export interface RendererHost {
  /** Resolve a link from `sourcePath` to a vault file's resource URL (images), or null. */
  resourceFor(linkpath: string, sourcePath: string): string | null;
  /** Open a vault link (a click on an internal link). */
  openLink(linktext: string, sourcePath: string, newLeaf: boolean): void;
  /** Open an external URL in the system browser. */
  openExternal(url: string): void;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

const EXTERNAL = /^(https?:|mailto:|obsidian:)/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function decode(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

interface WikiToken {
  type: "wikilink";
  raw: string;
  link: string;
  text: string;
  embed: boolean;
}

function buildMarked(host: RendererHost, sourcePath: string): Marked {
  // Obsidian's default (no "strict line breaks"): a single newline is a line break.
  const m = new Marked({ gfm: true, breaks: true, async: false });
  m.use({
    extensions: [
      {
        name: "wikilink",
        level: "inline",
        start(src: string) {
          const i = src.indexOf("[[");
          if (i < 0) return undefined;
          return i > 0 && src[i - 1] === "!" ? i - 1 : i;
        },
        tokenizer(src: string) {
          const w = /^(!?)\[\[([^[\]\n]+?)\]\]/.exec(src);
          if (!w || !w[2]) return undefined;
          const { link, alias } = splitWikilink(w[2]);
          const token: WikiToken = { type: "wikilink", raw: w[0], link, text: alias ?? link, embed: w[1] === "!" };
          return token as unknown as Tokens.Generic;
        },
        renderer(token: Tokens.Generic) {
          const t = token as unknown as WikiToken;
          return `<a class="internal-link${t.embed ? " is-embed" : ""}" data-href="${escapeHtml(t.link)}" href="#">${escapeHtml(t.text)}</a>`;
        },
      },
    ],
    renderer: {
      // Raw HTML in a note is shown as text: this window can reach Node.
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(text);
      },
      link(this: { parser: { parseInline(tokens: Tokens.Generic[]): string } }, { href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens as Tokens.Generic[]);
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        if (EXTERNAL.test(href)) return `<a class="external-link" data-url="${escapeHtml(href)}" href="#"${t}>${inner}</a>`;
        if (SCHEME.test(href) || href.startsWith("//")) return `<span class="cx-link-blocked"${t}>${inner}</span>`;
        return `<a class="internal-link" data-href="${escapeHtml(decode(href))}" href="#"${t}>${inner}</a>`;
      },
      image({ href, text }: Tokens.Image) {
        if (!SCHEME.test(href) && !href.startsWith("//")) {
          const url = host.resourceFor(decode(href).split("#")[0] ?? "", sourcePath);
          if (url && url.startsWith("file:")) return `<img src="${escapeHtml(url)}" alt="${escapeHtml(text)}">`;
        }
        return `<span class="cx-image-alt">${escapeHtml(text || href)}</span>`;
      },
    },
  });
  return m;
}

function propertiesHtml(fm: Record<string, unknown>): string {
  const rows = Object.entries(fm).map(([k, v]) => {
    const value = Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : v !== null && typeof v === "object" ? JSON.stringify(v) : String(v ?? "");
    return `<div class="metadata-property"><span class="metadata-property-key">${escapeHtml(k)}</span><span class="metadata-property-value">${escapeHtml(value)}</span></div>`;
  });
  return rows.length > 0 ? `<div class="metadata-container"><div class="metadata-properties">${rows.join("")}</div></div>` : "";
}

let host: RendererHost | null = null;

/** The app installs how links open and how vault files resolve (App.open). */
export function setRendererHost(h: RendererHost): void {
  host = h;
}

export function renderMarkdownToHtml(markdown: string, sourcePath: string, h: RendererHost): string {
  const block = findFrontmatter(markdown);
  const fm = block ? parseFrontmatter(markdown).frontmatter : undefined;
  const body = (block ? markdown.slice(block.bodyStart) : markdown).replace(/%%[\s\S]*?(?:%%|$)/g, "");
  const html = buildMarked(h, sourcePath).parse(body, { async: false });
  return (fm ? propertiesHtml(fm) : "") + html;
}

export class MarkdownRenderer {
  static async render(_app: unknown, markdown: string, el: HTMLElement, sourcePath: string, component?: Component | null): Promise<void> {
    const h = host;
    if (!h) throw new Error("MarkdownRenderer used before the app was opened");
    el.classList.add("markdown-rendered");
    el.innerHTML = renderMarkdownToHtml(markdown, sourcePath, h);
    const onClick = (ev: MouseEvent): void => {
      const a = (ev.target as Element | null)?.closest?.("a.internal-link, a.external-link");
      if (!a || !el.contains(a)) return;
      ev.preventDefault();
      const url = a.getAttribute("data-url");
      if (url) h.openExternal(url);
      else {
        const link = a.getAttribute("data-href");
        if (link) h.openLink(link, sourcePath, ev.ctrlKey || ev.metaKey);
      }
    };
    el.addEventListener("click", onClick);
    component?.register(() => el.removeEventListener("click", onClick));
  }

  /** Obsidian's older name for render(). */
  static async renderMarkdown(markdown: string, el: HTMLElement, sourcePath: string, component?: Component | null): Promise<void> {
    return MarkdownRenderer.render(null, markdown, el, sourcePath, component);
  }
}
