/**
 * Command line (CORTEX-UX §5.9): glass-strong bar 640 × 44 (L 560; S full width − 32) at the stage's bottom
 * centre: a Find/Ask segmented switch (Tab toggles while focused), the query tokens, the input, the "‹n› traced"
 * readout with Clear, and key hints (Tab, Ctrl K). Placeholders: Find "Find anything in your record", Ask "Ask a
 * question, or type / for an action" (ORIG-08). Typing lights matches after 150 ms (a draft text token that the
 * renderer lights: matches full colour, others 12%, haze 5%). Esc is handled by the shell keymap (close results →
 * clear input → remove all tokens → clear the selection). Backspace in an empty input removes the last token.
 * role="search", input role="combobox". Owner: E12 (Find) with E6 (Ask console).
 *
 * In Ask mode Enter keeps the text in `ui.command.text` and opens the console; the Ask console (E6) sends it.
 */
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { availableActions } from "../../plugin/commands";
import { featureOn } from "../../shared/features";
import type { QueryToken, SearchResult } from "../../shared/protocol/worker";
import { addToken, clearHighlights, clearTokens, openPage, openTab, removeLastToken, removeToken, setCommandMode } from "../../state/actions";
import { highlightCount, visibilityParams } from "../../state/selectors";
import type { CortexStore } from "../../state/store";
import { useLeaf, useServices, useShell } from "../context";
import { t } from "../copy";
import { isDesktopHost } from "../host";
import { runCortexCommand } from "../header/MoreMenu";
import { Kbd } from "../primitives/buttons";
import { commandBarResting, useStageSearchShown } from "../stage/StageSearch";
import { metaOf, openItemReader, useIndex } from "../reader/readerKit";
import { areaLabel, fmtDate, isoMs, sourceLabel } from "../valueLabels";
import { AskConsole } from "./AskConsole";
import { ASK_ROW_KEY, FindResults, groupFindRows, type FindGroupId, type FindRow } from "./FindResults";
import { markNotMine, selectedConversation } from "./notMine";
import { DRAFT_TOKEN_ID, Tokens, visibleTokens } from "./Tokens";

export const FIND_DEBOUNCE_MS = 150;

export interface PageAction {
  id: string;
  label: string;
  run(store: CortexStore): void;
}

/** Pages and actions Find can jump to (matched against the typed text). */
export function pageActions(): PageAction[] {
  return [
    { id: "read", label: t("pages.read"), run: (s) => openTab(s, "read") },
    { id: "time", label: t("pages.time"), run: (s) => openTab(s, "time") },
    { id: "agents", label: t("pages.agents"), run: (s) => openTab(s, "agents") },
    { id: "checks", label: t("agents.checks"), run: (s) => openPage(s, "agents", { tab: "checks" }) },
    { id: "sources", label: t("pages.sources"), run: (s) => openTab(s, "sources") },
    { id: "guide", label: t("pages.guide"), run: (s) => openPage(s, "guide") },
    { id: "new-entry", label: t("pages.new-entry"), run: (s) => openPage(s, "new-entry") },
    { id: "change-history", label: t("pages.change-history"), run: (s) => openPage(s, "change-history") },
  ];
}

/** Pages whose name contains the typed text, at most `limit`. */
export function matchPages(query: string, limit = 8): PageAction[] {
  const q = query.trim().toLowerCase();
  return q ? pageActions().filter((p) => p.label.toLowerCase().includes(q)).slice(0, limit) : [];
}

/** Action commands (the shared registry, plugin/commands.ts) whose name or search words contain the typed text, at most `limit`. */
export function matchActions(query: string, limit = 8): { id: string; label: string }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return availableActions()
    .map((a) => ({ id: a.id as string, label: t(a.copy), words: a.words ?? "" }))
    .filter((a) => a.label.toLowerCase().includes(q) || a.words.includes(q))
    .slice(0, limit)
    .map(({ id, label }) => ({ id, label }));
}

/** The "Filter by" rows of a search result: its sources and tags with counts; picking one adds a source:x or tag:x token. */
export function filterRows(top: Pick<SearchResult["top"], "sources" | "tags">): FindRow[] {
  const out: FindRow[] = [];
  for (const r of top.sources ?? []) {
    out.push({ key: `fs${r.source}`, group: "filters", icon: "sources", title: sourceLabel(r.source), meta: t("command.filterSource", { n: r.count.toLocaleString("en-GB") }), action: { kind: "filter", token: { id: `find:source:${r.source}`, dim: "source", value: r.source, label: t("read.sourceToken", { source: sourceLabel(r.source) }) } } });
  }
  for (const r of top.tags ?? []) {
    out.push({ key: `ft${r.dim}|${r.value}`, group: "filters", icon: "names", title: r.value, meta: t("command.filterTag", { n: r.count.toLocaleString("en-GB") }), action: { kind: "filter", token: { id: `find:tag:${r.dim}:${r.value}`, dim: r.dim, value: r.value, label: t("command.tagToken", { tag: r.value }) } } });
  }
  return out;
}

export function CommandLine(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const index = useIndex(s);
  const ui = leaf.store.slices.ui.value;
  const lit = leaf.store.slices.lit.value;
  const selection = leaf.store.slices.selection.value;
  const askOn = featureOn("ask");
  const ask = ui.command.mode === "ask" && askOn;
  const text = ui.command.text;
  const [result, setResult] = useState<{ query: string; value: SearchResult } | null>(null);
  const [searching, setSearching] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<FindGroupId>>(new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const format = s.settings.value.general.dateFormat;
  const phase = s.shared.slices.data.value.phase;
  const building = phase !== "ready" && phase !== "empty";

  const setText = (next: string) => leaf.store.update("ui", (u) => ({ ...u, command: { ...u.command, text: next, resultsOpen: u.command.mode === "find" && next.length > 0, consoleOpen: u.command.consoleOpen || (u.command.mode === "ask" && next.startsWith("/")) } }));
  const openResults = () => leaf.store.update("ui", (u) => (u.command.resultsOpen ? u : { ...u, command: { ...u.command, resultsOpen: true } }));

  // Light what is typed after 150 ms: a draft text token for the renderer plus the result list.
  useEffect(() => {
    if (ask) {
      removeToken(leaf.store, DRAFT_TOKEN_ID);
      return;
    }
    const q = text.trim();
    if (q.length === 0) {
      removeToken(leaf.store, DRAFT_TOKEN_ID);
      setResult(null);
      setSearching(false);
      setActiveKey(null);
      return;
    }
    setSearching(true);
    const ac = new AbortController();
    const timer = setTimeout(() => {
      addToken(leaf.store, { id: DRAFT_TOKEN_ID, kind: "text", label: t("command.queryToken", { q, n: "…" }), text: q });
      const vis = visibilityParams(leaf.store.get("ui"), leaf.store.get("view"));
      s.worker.call(`${leaf.viewId}#find`, "search", { query: q, limit: 200, visibility: vis }, { signal: ac.signal }).then(
        (value) => {
          if (ac.signal.aborted) return;
          setResult({ query: q, value });
          setSearching(false);
          setExpanded(new Set());
          setActiveKey(null);
        },
        () => {
          if (!ac.signal.aborted) setSearching(false);
        },
      );
    }, FIND_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [text, ask]);

  const rows = useMemo<FindRow[]>(() => {
    if (!result) return [];
    const out: FindRow[] = [];
    const itemRow = (ordinal: number, group: FindGroupId, icon: FindRow["icon"]): void => {
      const m = metaOf(s, ordinal);
      if (!m) return;
      const when = isoMs(m.writtenAt);
      const meta = [sourceLabel(m.source), Number.isFinite(when) ? fmtDate(when, format) : null, m.space ? areaLabel(m.space) : null].filter(Boolean).join(" · ");
      out.push({ key: `i${ordinal}`, group, icon, title: m.title || t("read.untitled"), meta, action: { kind: "item", ordinal } });
    };
    for (const o of result.value.top.entries) itemRow(o, "entries", metaOf(s, o)?.conversation ? "conversation" : "document");
    for (const o of result.value.top.notes) itemRow(o, "notes", "document");
    for (const o of result.value.top.maps) itemRow(o, "maps", "groups");
    const q = result.query.toLowerCase();
    for (const f of result.value.top.folders) out.push({ key: `f${f.path}`, group: "areas", icon: "folder", title: f.path, meta: t("command.folderMeta", { n: f.count.toLocaleString("en-GB") }), action: { kind: "folder", path: f.path } });
    for (const space of Object.keys(s.colours.current().space ?? {})) {
      if (areaLabel(space).toLowerCase().includes(q)) out.push({ key: `a${space}`, group: "areas", icon: "scope", title: areaLabel(space), meta: t("command.areas"), action: { kind: "area", space } });
    }
    out.push(...filterRows(result.value.top));
    for (const p of matchPages(q)) out.push({ key: `p${p.id}`, group: "pages", icon: "guide", title: p.label, meta: t("command.page"), action: { kind: "page", id: p.id } });
    for (const a of matchActions(q)) out.push({ key: `c${a.id}`, group: "pages", icon: "play", title: a.label, meta: t("command.action"), action: { kind: "command", id: a.id } });
    if (selectedConversation(s, selection) && t("notMine.action").toLowerCase().includes(q)) out.push({ key: "cnot-mine", group: "pages", icon: "flag", title: t("notMine.action"), meta: t("command.action"), action: { kind: "not-mine" } });
    return out;
  }, [result, index, format, selection]);

  const groups = useMemo(() => groupFindRows(rows, expanded), [rows, expanded]);
  const keys = useMemo(() => [...groups.flatMap((g) => g.rows.map((r) => r.key)), ...(askOn && text.trim() ? [ASK_ROW_KEY] : [])], [groups, askOn, text]);
  const total = result?.value.total ?? 0;

  const activate = (row: FindRow): void => {
    const a = row.action;
    if (a.kind === "item") openItemReader(s, leaf, a.ordinal, index);
    else if (a.kind === "folder") addToken(leaf.store, { id: `folder:${a.path}`, kind: "group", dim: "folderPath", value: a.path, label: t("read.folderToken", { path: a.path }) });
    else if (a.kind === "area") addToken(leaf.store, { id: `space:${a.space}`, kind: "group", dim: "space", value: a.space, label: areaLabel(a.space) });
    else if (a.kind === "filter") addToken(leaf.store, { ...a.token, kind: "group" } as QueryToken);
    else if (a.kind === "command") runCortexCommand(s.app, a.id);
    else if (a.kind === "not-mine") void markNotMine(s, leaf, shell);
    else pageActions().find((p) => p.id === a.id)?.run(leaf.store);
    // The query stays lit; the results close so the figure and the sheet show.
    leaf.store.update("ui", (u) => ({ ...u, command: { ...u.command, resultsOpen: false } }));
  };

  const toAsk = () => setCommandMode(leaf.store, "ask");

  const commitToken = () => {
    const q = text.trim();
    if (!q) return;
    leaf.store.batch(() => {
      removeToken(leaf.store, DRAFT_TOKEN_ID);
      addToken(leaf.store, { id: `text:${q.toLowerCase()}`, kind: "text", label: t("command.queryToken", { q, n: total.toLocaleString("en-GB") }), text: q });
      setText("");
    });
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Tab" && !e.shiftKey && askOn) {
      e.preventDefault();
      setCommandMode(leaf.store, ask ? "find" : "ask");
      return;
    }
    if (e.key === "Backspace" && text.length === 0) {
      const last = visibleTokens(ui.tokens).pop();
      if (last) {
        e.preventDefault();
        removeToken(leaf.store, last.id);
      } else if (ui.tokens.length > 0) removeLastToken(leaf.store);
      return;
    }
    if (ask) {
      if (e.key === "Enter" && text.trim()) {
        e.preventDefault();
        leaf.store.update("ui", (u) => ({ ...u, command: { ...u.command, consoleOpen: true } }));
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (keys.length === 0) return;
      e.preventDefault();
      openResults();
      const at = activeKey === null ? -1 : keys.indexOf(activeKey);
      const next = e.key === "ArrowDown" ? (at + 1) % keys.length : (at - 1 + keys.length) % keys.length;
      setActiveKey(keys[next] ?? null);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) return commitToken();
      const key = activeKey ?? keys[0];
      if (key === ASK_ROW_KEY) return toAsk();
      const row = rows.find((r) => r.key === key);
      if (row) activate(row);
    }
  };

  useEffect(() => {
    if (activeKey) document.getElementById(`cx-find-${activeKey}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeKey]);

  const shown = visibleTokens(ui.tokens).length;
  const litLabels = highlightCount(ui);
  const stageSearch = useStageSearchShown();
  const resting = commandBarResting({ desktop: isDesktopHost(), tokens: shown, text, consoleOpen: ui.command.consoleOpen, resultsOpen: ui.command.resultsOpen, stageSearch });
  const traced = (shown > 0 || (!ask && text.trim().length > 0)) && lit !== null;
  return (
    <div class="cx-command" role="search" data-mode={ask ? "ask" : "find"} data-idle={resting ? "true" : undefined}>
      {ui.command.resultsOpen && !ask && text.trim().length > 0 ? (
        <FindResults
          query={text.trim()}
          groups={groups}
          activeKey={activeKey}
          searching={searching}
          building={building}
          total={total}
          askAvailable={askOn}
          onActivate={activate}
          onHover={setActiveKey}
          onShowAll={(id) => setExpanded((cur) => new Set([...cur, id]))}
          onAsk={toAsk}
        />
      ) : null}
      {ask && ui.command.consoleOpen ? <AskConsole /> : null}
      <div class="cx-command-bar">
        {askOn ? (
          <div class="cx-command-modes" role="radiogroup" aria-label={t("command.modes")}>
            <button type="button" role="radio" class={`cx-command-mode${!ask ? " is-on" : ""}`} aria-checked={!ask} onClick={() => setCommandMode(leaf.store, "find")}>
              {t("command.find")}
            </button>
            <button type="button" role="radio" class={`cx-command-mode${ask ? " is-on" : ""}`} aria-checked={ask} onClick={() => setCommandMode(leaf.store, "ask")}>
              {t("command.ask")}
            </button>
          </div>
        ) : null}
        <Tokens />
        <input
          ref={inputRef}
          class="cx-command-input"
          type="text"
          role="combobox"
          autocomplete="off"
          spellcheck={false}
          value={text}
          aria-expanded={ui.command.resultsOpen && !ask}
          aria-controls="cx-find-results"
          aria-activedescendant={activeKey ? `cx-find-${activeKey}` : undefined}
          aria-label={ask ? t("command.ask") : t("command.find")}
          placeholder={ask ? t("command.askPlaceholder") : t("command.findPlaceholder")}
          onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
          onFocus={() => (text.trim() && !ask ? openResults() : undefined)}
          onKeyDown={onKey}
        />
        {litLabels > 0 ? (
          <span class="cx-lit cx-lit-labels">
            {t("command.litLabels", { n: litLabels.toLocaleString("en-GB") })}
            <button type="button" class="cx-text-button" onClick={() => clearHighlights(leaf.store)}>
              {t("command.clear")}
            </button>
          </span>
        ) : null}
        {traced ? (
          <span class="cx-lit" aria-live="polite">
            {t("command.traced", { n: (lit ?? 0).toLocaleString("en-GB") })}
            <button
              type="button"
              class="cx-text-button"
              onClick={() => {
                clearTokens(leaf.store);
                setText("");
              }}
            >
              {t("command.clear")}
            </button>
          </span>
        ) : null}
        <span class="cx-command-hints" aria-hidden="true">
          {askOn ? <Kbd>{t("command.tabHint")}</Kbd> : null}
          <Kbd>{t("command.shortcut")}</Kbd>
        </span>
      </div>
    </div>
  );
}
