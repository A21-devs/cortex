/**
 * Renders SafeBlocks (inertMarkdown.ts) as text nodes only (SAFE-01). Owner: E12.
 * No HTML is interpreted, no image is fetched, no code runs. Links show their text and address; an http(s) link
 * opens only after "Open link" in a confirmation (other schemes stay text). Secret markers render as lock chips
 * with "Show on this computer", which reveals the held line in place for this session (§5.30.7). Long texts render
 * their first blocks and a "Show all" button so a 1 MB document never blocks the UI thread.
 */
import type { JSX } from "preact";
import { useContext, useMemo, useState } from "preact/hooks";
import { ServicesContext } from "../context";
import { t } from "../copy";
import { confirm } from "../modals/ConfirmModal";
import { Icon } from "../primitives/buttons";
import { isOpenableLink, parseInline, parseSafeMarkdown, SECRET_MARKER, type InlineSpan, type SafeBlock } from "./inertMarkdown";

export interface SecretView {
  marker: number;
  here: boolean;
}

export interface SafeMarkdownProps {
  text: string;
  /** Documents may start with frontmatter (shown as preformatted text). */
  document?: boolean;
  /** Secret markers of this text (EntryDetail.secrets) and the reveal call (RecordReader.revealHeld). */
  secrets?: readonly SecretView[];
  reveal?: (marker: number) => Promise<string | null>;
  /** Render at most this many blocks before "Show all" (default 400). */
  maxBlocks?: number;
  /** Highlight this term (Find within a conversation). */
  highlight?: string;
  class?: string;
}

interface Ctx {
  secrets?: readonly SecretView[];
  reveal?: (marker: number) => Promise<string | null>;
  highlight?: string;
  openLink?: (href: string) => void;
}

/** A lock chip in place of a held secret; "Show on this computer" reveals the original for this session. */
export function SecretChip(p: { n: number; secrets?: readonly SecretView[]; reveal?: (marker: number) => Promise<string | null> }): JSX.Element {
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const info = p.secrets?.find((s) => s.marker === p.n);
  const here = info ? info.here : true;
  if (shown !== null) {
    return (
      <span class="cx-secret is-shown" title={t("reader.secretShown")}>
        <code>{shown}</code>
        <button type="button" class="cx-text-button" onClick={() => setShown(null)}>
          {t("reader.hideSecret")}
        </button>
      </span>
    );
  }
  const canReveal = here && p.reveal !== undefined;
  return (
    <span class="cx-secret">
      <Icon name="lock" />
      <span>{here ? t("reader.secretHere") : t("reader.secretElsewhere")}</span>
      {canReveal ? (
        <button
          type="button"
          class="cx-text-button"
          disabled={busy}
          onClick={() => {
            const reveal = p.reveal;
            if (!reveal) return;
            setBusy(true);
            reveal(p.n)
              .then((v) => setShown(v))
              .catch(() => setShown(null))
              .finally(() => setBusy(false));
          }}
        >
          {t("reader.showHere")}
        </button>
      ) : null}
    </span>
  );
}

/** Highlight a term inside plain text (case-insensitive), as <mark> text nodes. */
function marked(text: string, term: string | undefined): JSX.Element | string {
  if (!term || term.length < 2) return text;
  const lower = text.toLowerCase();
  const needle = term.toLowerCase();
  const parts: (string | JSX.Element)[] = [];
  let i = 0;
  let j = lower.indexOf(needle);
  if (j < 0) return text;
  while (j >= 0) {
    if (j > i) parts.push(text.slice(i, j));
    parts.push(<mark class="cx-find-hit">{text.slice(j, j + needle.length)}</mark>);
    i = j + needle.length;
    j = lower.indexOf(needle, i);
  }
  if (i < text.length) parts.push(text.slice(i));
  return <>{parts}</>;
}

/** Plain text with secret markers turned into chips (code blocks and the Source view). */
export function SecretText(p: { text: string; base?: number; secrets?: readonly SecretView[]; reveal?: (marker: number) => Promise<string | null>; highlight?: string }): JSX.Element {
  const parts = p.text.split(SECRET_MARKER);
  const base = p.base ?? 0;
  return (
    <>
      {parts.map((part, k) => (
        <>
          {k > 0 ? <SecretChip n={base + k - 1} secrets={p.secrets} reveal={p.reveal} /> : null}
          {marked(part, p.highlight)}
        </>
      ))}
    </>
  );
}

function Inline(p: { spans: readonly InlineSpan[]; ctx: Ctx }): JSX.Element {
  return (
    <>
      {p.spans.map((s) => {
        if (s.secret !== undefined) return <SecretChip n={s.secret} secrets={p.ctx.secrets} reveal={p.ctx.reveal} />;
        if (s.image) return <span class="cx-inert-image">{t("reader.imageText", { alt: s.image.alt || "–", host: s.image.host })}</span>;
        let node: JSX.Element | string = marked(s.text, p.ctx.highlight);
        if (s.code) node = <code>{node}</code>;
        if (s.strike) node = <s>{node}</s>;
        if (s.em) node = <em>{node}</em>;
        if (s.strong) node = <strong>{node}</strong>;
        if (s.link !== undefined) {
          const href = s.link;
          const showAddress = href !== s.text;
          const openable = isOpenableLink(href) && p.ctx.openLink !== undefined;
          return (
            <span class="cx-inert-link" title={href}>
              {openable ? (
                <button type="button" class="cx-link-text" onClick={() => p.ctx.openLink?.(href)}>
                  {node}
                </button>
              ) : (
                <span class="cx-link-text">{node}</span>
              )}
              {showAddress ? <span class="cx-link-address"> ({href})</span> : null}
            </span>
          );
        }
        return <>{node}</>;
      })}
    </>
  );
}

function Blocks(p: { blocks: readonly SafeBlock[]; ctx: Ctx }): JSX.Element {
  return (
    <>
      {p.blocks.map((b) => {
        switch (b.kind) {
          case "heading":
            return (
              <p class={`cx-h cx-h${b.level}`} role="heading" aria-level={Math.min(6, b.level + 2)}>
                <Inline spans={b.spans} ctx={p.ctx} />
              </p>
            );
          case "paragraph":
            return (
              <p>
                <Inline spans={b.spans} ctx={p.ctx} />
              </p>
            );
          case "list": {
            const items = b.items.map((it) => (
              <li class={it.depth > 0 ? `cx-depth-${it.depth}` : undefined}>
                {it.checked !== undefined ? (
                  <span class="cx-task" role="img" aria-label={it.checked ? "✓" : "○"}>
                    {it.checked ? "☑ " : "☐ "}
                  </span>
                ) : null}
                <Inline spans={it.spans} ctx={p.ctx} />
              </li>
            ));
            return b.ordered ? <ol start={b.start !== 1 ? b.start : undefined}>{items}</ol> : <ul>{items}</ul>;
          }
          case "quote":
            return (
              <blockquote>
                <Blocks blocks={b.blocks} ctx={p.ctx} />
              </blockquote>
            );
          case "code":
            return b.text.includes(SECRET_MARKER) ? (
              <pre>
                <SecretText text={b.text} base={b.secretBase} secrets={p.ctx.secrets} reveal={p.ctx.reveal} highlight={p.ctx.highlight} />
              </pre>
            ) : (
              <pre>{marked(b.text, p.ctx.highlight)}</pre>
            );
          case "rule":
            return <hr />;
          case "table":
            return (
              <div class="cx-md-table">
                <table>
                  <thead>
                    <tr>
                      {b.header.map((c) => (
                        <th scope="col">
                          <Inline spans={c} ctx={p.ctx} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r) => (
                      <tr>
                        {r.map((c) => (
                          <td>
                            <Inline spans={c} ctx={p.ctx} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </>
  );
}

export function SafeMarkdown(p: SafeMarkdownProps): JSX.Element {
  const services = useContext(ServicesContext);
  const blocks = useMemo(() => parseSafeMarkdown(p.text, { document: p.document }), [p.text, p.document]);
  const max = p.maxBlocks ?? 400;
  const [all, setAll] = useState(false);
  const visible = all || blocks.length <= max ? blocks : blocks.slice(0, max);
  const app = services?.app;
  const ctx: Ctx = {
    secrets: p.secrets,
    reveal: p.reveal,
    highlight: p.highlight,
    openLink: app
      ? (href: string) => {
          void confirm(app, { title: t("reader.openLinkConfirm", { address: href }), confirm: t("reader.openLink"), cancel: t("reader.cancel") }).then((ok) => {
            if (ok && isOpenableLink(href)) (globalThis as { open?: (url: string, target?: string) => unknown }).open?.(href, "_blank");
          });
        }
      : undefined,
  };
  return (
    <div class={`cx-safe-md${p.class ? ` ${p.class}` : ""}`}>
      <Blocks blocks={visible} ctx={ctx} />
      {visible.length < blocks.length ? (
        <button type="button" class="cx-text-button cx-show-all" onClick={() => setAll(true)}>
          {t("reader.showAll")}
        </button>
      ) : null}
    </div>
  );
}

/** One machine statement (a note's text, a gist sentence): inline only, no block structure. */
export function SafeInline(p: { text: string }): JSX.Element {
  const spans = useMemo(() => parseInline(p.text.replace(/\s*\n+\s*/g, " ")), [p.text]);
  return (
    <span class="cx-safe-inline">
      <Inline spans={spans} ctx={{}} />
    </span>
  );
}
