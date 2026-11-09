/**
 * Vault note peek (CORTEX-UX §5.17) for notes Obsidian already shows. Owner: E12.
 * Meta "Vault note · ‹path› · ‹area› · layer ‹n›"; beside a dotted rule "Written before Cortex by Claude or a
 * script; the model wasn't recorded."; the body is the first 3,000 characters rendered with Obsidian's own
 * MarkdownRenderer (vault notes only — Obsidian renders them anyway; record text never goes through it), then
 * Show all; Open in editor (Enter, a new tab next to Cortex) · Open to the right (Ctrl+Enter) · Trace its links ·
 * "Linked from ‹n› notes". Moved or deleted: "This note was moved or deleted in your vault." Find it.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Component, MarkdownRenderer, type App, type TFile } from "obsidian";
import { NONE8, type DataIndex } from "../../shared/index-format";
import { wikiNoteId } from "../../shared/ids";
import { addToken } from "../../state/actions";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import { isTypingTarget, runObsidianCommand, useLoad } from "../pages/PageFrame";
import { areaLabel, fmtInt } from "../valueLabels";
import { idOf, metaOf, NotInIndex, openInObsidian, ReaderLoad, resolveOrdinal, useIndex } from "./readerKit";

export const PEEK_CHARS = 3000;

/** Cut a note for the peek at a line break near `max` characters; `cut` tells whether anything was left out. */
export function peekText(markdown: string, max: number = PEEK_CHARS): { text: string; cut: boolean } {
  if (markdown.length <= max) return { text: markdown, cut: false };
  const nl = markdown.lastIndexOf("\n", max);
  const end = nl > max * 0.6 ? nl : max;
  let text = markdown.slice(0, end);
  // Never leave a code fence open: Obsidian would render the rest as code.
  if ((text.match(/^\s*(```|~~~)/gm) ?? []).length % 2 === 1) text += "\n```";
  return { text, cut: true };
}

const pathCache = new Map<string, string>();

/** The vault path of a vault note id (ids are a hash of the path): search the note's folder first, then the vault. */
export function vaultPathOf(app: App, id: string, folderHint?: string): string | null {
  const cached = pathCache.get(id);
  const vault = app.vault as unknown as { getMarkdownFiles?(): TFile[]; getAbstractFileByPath?(p: string): unknown };
  if (cached && vault.getAbstractFileByPath?.(cached)) return cached;
  const files = vault.getMarkdownFiles?.() ?? [];
  const hint = folderHint?.replace(/\\/g, "/").replace(/\/+$/, "");
  const inFolder = hint ? files.filter((f) => f.path.startsWith(`${hint}/`) || f.path.startsWith(`wiki/${hint}/`)) : [];
  for (const group of [inFolder, files]) {
    for (const f of group) {
      if (wikiNoteId(f.path) === id) {
        pathCache.set(id, f.path);
        return f.path;
      }
    }
  }
  return null;
}

/** Notes linked with this one (vault wikilinks + related), from the index relations. */
export function linkedOrdinals(index: DataIndex | null, ordinal: number): number[] {
  if (!index || ordinal < 0) return [];
  const rel = index.rel.noteLinks;
  if (ordinal + 1 >= rel.offsets.length) return [];
  const a = rel.offsets[ordinal] ?? 0;
  const b = rel.offsets[ordinal + 1] ?? a;
  return Array.from(rel.targets.subarray(a, b));
}

interface PeekData {
  markdown: string;
  path: string | null;
}

export function NotePeek(p: { id: string }): JSX.Element {
  const s = useServices();
  const index = useIndex(s);
  const ordinal = resolveOrdinal(s, p.id, index);
  const data = useLoad(async (): Promise<PeekData> => {
    if (ordinal < 0) throw new NotInIndex(index === null);
    const meta = metaOf(s, ordinal);
    const path = vaultPathOf(s.app, p.id, meta?.folder);
    const markdown = await s.records.noteMarkdown(ordinal);
    return { markdown, path };
  }, [p.id, ordinal]);
  return <ReaderLoad value={data}>{(d) => <PeekView id={p.id} ordinal={ordinal} markdown={d.markdown} path={d.path} />}</ReaderLoad>;
}

export function PeekView(p: { id: string; ordinal: number; markdown: string; path: string | null }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const index = useIndex(s);
  const meta = metaOf(s, p.ordinal);
  const [all, setAll] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const shown = all ? { text: p.markdown, cut: false } : peekText(p.markdown);
  const layer = index && p.ordinal >= 0 ? index.cols.layer[p.ordinal] : undefined;
  const area = areaLabel(meta?.space ?? "none");
  const path = p.path ?? meta?.folder ?? "";
  const linked = linkedOrdinals(index, p.ordinal);
  const title = meta?.title ?? path.split("/").pop()?.replace(/\.md$/i, "") ?? "";

  useEffect(() => {
    const el = host.current;
    if (!el || !p.path) return;
    const ComponentCtor = Component as unknown as (new () => Component) | undefined;
    const comp = typeof ComponentCtor === "function" ? new ComponentCtor() : null;
    comp?.load();
    (el as unknown as { empty?(): void }).empty?.();
    void MarkdownRenderer.render(s.app, shown.text, el, p.path, comp as Component).catch(() => undefined);
    return () => {
      comp?.unload();
      (el as unknown as { empty?(): void }).empty?.();
    };
  }, [shown.text, p.path]);

  const open = (how: "tab" | "split") => {
    if (p.path) openInObsidian(s.app, p.path, how);
  };
  const onKey = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target) || e.key !== "Enter" || e.altKey || e.shiftKey) return;
    e.preventDefault();
    open(e.ctrlKey || e.metaKey ? "split" : "tab");
  };
  const findIt = () => {
    if (!runObsidianCommand(s.app, "switcher:open")) return;
    // Prefill Obsidian's quick switcher with the title once it has opened.
    setTimeout(() => {
      const input = (globalThis as { document?: Document }).document?.querySelector<HTMLInputElement>(".prompt .prompt-input");
      if (!input) return;
      input.value = title;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, 30);
  };
  const traceLinks = () => {
    const ids = linked.map((o) => idOf(s, o, index)).filter((x): x is string => x !== undefined);
    if (ids.length > 0) addToken(leaf.store, { id: `set:links:${p.id}`, kind: "set", label: t("reader.sourcesToken", { title }), ids });
  };

  return (
    <article class="cx-reader cx-note-peek" data-id={p.id} tabIndex={-1} onKeyDown={onKey}>
      <div class="cx-reader-head">
        <h3 class="cx-reader-title">{title}</h3>
        <p class="cx-note">{layer !== undefined && layer !== NONE8 ? t("reader.vaultNote", { path, area, layer }) : t("reader.vaultNoteNoLayer", { path, area })}</p>
      </div>
      <p class="cx-machine-rule cx-note">{t("reader.legacy")}</p>
      {p.path ? (
        <>
          <div class="cx-peek-body markdown-rendered" ref={host} />
          {shown.cut ? (
            <button type="button" class="cx-text-button" onClick={() => setAll(true)}>
              {t("reader.showAll")}
            </button>
          ) : null}
          <div class="cx-row-buttons">
            <button type="button" class="cx-button is-primary" onClick={() => open("tab")} title="Enter">
              {t("reader.openInEditor")}
            </button>
            <button type="button" class="cx-button" onClick={() => open("split")} title="Ctrl+Enter">
              {t("reader.openToRight")}
            </button>
          </div>
        </>
      ) : (
        <div class="cx-banner-card" role="status">
          <p>{t("reader.moved")}</p>
          <button type="button" class="cx-button" onClick={findIt}>
            {t("reader.findIt")}
          </button>
        </div>
      )}
      <div class="cx-reader-foot">
        <button type="button" class="cx-text-button" disabled={linked.length === 0} onClick={traceLinks}>
          {t("reader.traceLinks")}
        </button>
        <span class="cx-note">{t("reader.linkedFrom", { n: fmtInt(linked.length) })}</span>
      </div>
    </article>
  );
}
