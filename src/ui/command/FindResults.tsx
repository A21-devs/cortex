/**
 * Find results (CORTEX-UX §5.9): above the command line (640 × ≤ 420), groups Entries · Notes · Maps · Areas and
 * folders · Pages and actions, ≤ 5 rows each + "Show all ‹n›"; rows 40 px (kind icon, title with the match
 * underlined, meta "Claude Code · 3 Nov 2026 · Roblox"); final row "Ask Cortex: “‹query›”" with the Tab hint.
 * ↑↓ move, Enter open (keeps the query lit), Ctrl+Enter turns the query into a token, Tab → Ask. States: no
 * results, index still building. Data: worker `search` (viewId-scoped). role="listbox". Owner: E12.
 */
import type { ComponentChildren, JSX } from "preact";
import { t } from "../copy";
import { Icon } from "../primitives/buttons";
import { Kbd } from "../primitives/buttons";
import type { IconName } from "../icons";

export const RESULTS_PER_GROUP = 5;

export type FindGroupId = "entries" | "notes" | "maps" | "areas" | "filters" | "pages";

export interface FindRow {
  /** Stable key, also the option id. */
  key: string;
  group: FindGroupId;
  icon: IconName;
  title: string;
  meta: string;
  /** What activating the row does. */
  action:
    | { kind: "item"; ordinal: number }
    | { kind: "folder"; path: string }
    | { kind: "area"; space: string }
    | { kind: "page"; id: string }
    /** An action command of the shared registry (plugin/commands.ts ACTION_REGISTRY), run by its id. */
    | { kind: "command"; id: string }
    /** A "Filter by" suggestion: adds this token (source:x or tag:x). */
    | { kind: "filter"; token: { id: string; dim: string; value: string; label: string } }
    /** Mark the selected conversation as not mine (ui/command/notMine.ts). */
    | { kind: "not-mine" };
}

export interface FindGroup {
  id: FindGroupId;
  label: string;
  rows: FindRow[];
  total: number;
}

const GROUP_LABEL: Readonly<Record<FindGroupId, "command.entries" | "command.notes" | "command.maps" | "command.areas" | "command.filterBy" | "command.actions">> = {
  entries: "command.entries",
  notes: "command.notes",
  maps: "command.maps",
  areas: "command.areas",
  filters: "command.filterBy",
  pages: "command.actions",
};

export const GROUP_ORDER: readonly FindGroupId[] = ["entries", "notes", "maps", "areas", "filters", "pages"];

/** Split rows into display groups, ≤ 5 each unless the group is expanded; empty groups are dropped. */
export function groupFindRows(rows: readonly FindRow[], expanded: ReadonlySet<FindGroupId>): FindGroup[] {
  const out: FindGroup[] = [];
  for (const id of GROUP_ORDER) {
    const all = rows.filter((r) => r.group === id);
    if (all.length === 0) continue;
    out.push({ id, label: t(GROUP_LABEL[id]), rows: expanded.has(id) ? all : all.slice(0, RESULTS_PER_GROUP), total: all.length });
  }
  return out;
}

/** The title split around the first case-insensitive match of the query, so the match can be underlined. */
export function splitMatch(title: string, query: string): { before: string; match: string; after: string } {
  const q = query.trim();
  const at = q ? title.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return { before: title, match: "", after: "" };
  return { before: title.slice(0, at), match: title.slice(at, at + q.length), after: title.slice(at + q.length) };
}

export interface FindResultsProps {
  query: string;
  groups: readonly FindGroup[];
  /** The visible rows in order (what ↑↓ walks), the Ask row last. */
  activeKey: string | null;
  searching: boolean;
  building: boolean;
  total: number;
  onActivate(row: FindRow): void;
  onHover(key: string): void;
  onShowAll(id: FindGroupId): void;
  onAsk(): void;
  askAvailable: boolean;
}

export const ASK_ROW_KEY = "ask-row";

function Underlined(p: { text: string; query: string }): JSX.Element {
  const s = splitMatch(p.text, p.query);
  return (
    <span class="cx-find-title">
      {s.before}
      {s.match ? <u>{s.match}</u> : null}
      {s.after}
    </span>
  );
}

export function FindResults(p: FindResultsProps): JSX.Element {
  const empty = p.groups.length === 0;
  let body: ComponentChildren;
  if (empty && p.searching) body = <p class="cx-find-state">{t("command.searching")}</p>;
  else if (empty) body = <p class="cx-find-state">{t("command.noResults", { q: p.query })}</p>;
  else
    body = p.groups.map((g) => (
      <div class="cx-find-group" role="group" aria-label={g.label}>
        <div class="cx-find-group-head">
          <span>{g.label}</span>
          {g.total > g.rows.length ? (
            <button type="button" class="cx-text-button" onMouseDown={(e) => e.preventDefault()} onClick={() => p.onShowAll(g.id)}>
              {t("command.showAll", { n: g.total.toLocaleString("en-GB") })}
            </button>
          ) : null}
        </div>
        {g.rows.map((r) => (
          <div id={`cx-find-${r.key}`} class={`cx-find-row${p.activeKey === r.key ? " is-active" : ""}`} role="option" aria-selected={p.activeKey === r.key} onMouseMove={() => p.onHover(r.key)} onMouseDown={(e) => e.preventDefault()} onClick={() => p.onActivate(r)}>
            <Icon name={r.icon} />
            <Underlined text={r.title} query={p.query} />
            <span class="cx-find-meta">{r.meta}</span>
          </div>
        ))}
      </div>
    ));
  return (
    <div id="cx-find-results" class="cx-find-results" role="listbox" aria-label={t("command.results")}>
      <div class="cx-find-scroll">
        {p.building ? <p class="cx-find-state cx-find-building">{t("command.incomplete")}</p> : null}
        {body}
      </div>
      {p.askAvailable ? (
        <div id={`cx-find-${ASK_ROW_KEY}`} class={`cx-find-row cx-find-ask${p.activeKey === ASK_ROW_KEY ? " is-active" : ""}`} role="option" aria-selected={p.activeKey === ASK_ROW_KEY} onMouseMove={() => p.onHover(ASK_ROW_KEY)} onMouseDown={(e) => e.preventDefault()} onClick={p.onAsk}>
          <Icon name="find" />
          <span class="cx-find-title">{t("command.askRow", { q: p.query })}</span>
          <Kbd>{t("command.tabHint")}</Kbd>
        </div>
      ) : null}
      <div class="cx-find-footer">{t("command.footer", { n: p.total.toLocaleString("en-GB") })}</div>
    </div>
  );
}
