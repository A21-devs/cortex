/**
 * Read (CORTEX-UX §5.18): everything you have, by date, folder or source; today; new entries. Owner: E12.
 * Header: "Read", text button New entry (§5.24, P2), More. Filter field "Filter this list" with the toggle "Trace
 * results on the figure" (on). Segmented By date · By folder · By source, then the Today toggle (`sun`, P2). Read opens
 * as a wide drawer on the left: its left column (every tab) holds a collapsible Recent section and the folder list
 * (Everything, Pinned and the folders, each with a dot, chevron and count); the list has a heading with the selection
 * name and item count, and a Pinned section above the day-grouped cards. Rows (44 px): a 4 px speaker-split bar, title, right-aligned relative time,
 * one snippet line starting with the source icon and an area dot; no meta line. Row click pushes the matching
 * reader. By folder: a resizable tree (≤ 40% of the sheet) whose choice traces "Folder: ‹path›" and lists its
 * items; a Maps menu All · Active · Cooling · Dormant (30 / 120 days from your newest entry). Sort: Newest ·
 * Oldest · Most messages · Title. J / K move between rows. Data: worker stats "read" (rows, shares, snippets),
 * pins from corrections, pinned views, ledger for today's runs line.
 */
import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { recencyOfDays } from "../../shared/dims";
import { featureOn } from "../../shared/features";
import { ItemKind } from "../../shared/index-format";
import type { StatsResult } from "../../shared/protocol/worker";
import type { PinnedViewRecord } from "../../shared/types";
import { addToken, openPage, removeToken } from "../../state/actions";
import type { ItemMeta } from "../../plugin/indexer";
import { visibilityParams } from "../../state/selectors";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import { Button, Icon } from "../primitives/buttons";
import { Toggle } from "../primitives/controls";
import { AreaDot, SourceIcon, SplitBar } from "../reader/marks";
import { vaultPathOf } from "../reader/NotePeek";
import { openBesideId } from "../breakpoints";
import { isPinned, metaOf, openItemReader, useIndex } from "../reader/readerKit";
import { areaLabel, fmtCompact, isoMs, kindLabel, mapKindLabel, sourceLabel } from "../valueLabels";
import { Load, MenuButton, PageFrame, PageTabs, ToggleButton, loaded, pick, setPageParams, statsKey, useFmt, useLoad } from "./PageFrame";

export type ReadSort = "newest" | "oldest" | "messages" | "title";
export type DaySection = { key: "today" | "yesterday" | "thisWeek" | "month"; label: string; month?: string };
export type ReadTab = "date" | "folder" | "source";
export type MapsFilter = "all" | "active" | "cooling" | "dormant";

const READ_TABS: readonly ReadTab[] = ["date", "folder", "source"];
const SORTS: readonly ReadSort[] = ["newest", "oldest", "messages", "title"];
const MAPS: readonly MapsFilter[] = ["all", "active", "cooling", "dormant"];
const PAGE_SIZE = 100;
export const FILTER_TOKEN_ID = "read:filter";
/** Items in the tree's Recent block (SPEC V14). */
export const RECENT_COUNT = 8;

export interface RecentItem {
  ordinal: number;
  title: string;
  count: number;
}

type ReadStats = Extract<StatsResult, { kind: "read" }>;
type TodayStats = Extract<StatsResult, { kind: "today" }>;
type SourceStats = Extract<StatsResult, { kind: "sources" }>;

/** Day header for a row (§5.18): Today, Yesterday, This week, then months ("Oct 2026"). */
export function daySection(rowMs: number, nowMs: number, weekStart: 0 | 1 = 1): DaySection {
  const day = (ms: number) => Math.floor((ms - new Date(ms).getTimezoneOffset() * 60_000) / 86_400_000);
  const dr = day(rowMs), dn = day(nowMs);
  if (dr === dn) return { key: "today", label: t("read.today") };
  if (dr === dn - 1) return { key: "yesterday", label: t("read.yesterday") };
  const now = new Date(nowMs);
  const sinceWeekStart = (now.getDay() - weekStart + 7) % 7;
  if (dr >= dn - sinceWeekStart) return { key: "thisWeek", label: t("read.thisWeek") };
  const d = new Date(rowMs);
  const month = d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
  return { key: "month", label: month, month };
}

/** Map recency filter (§5.18): active ≤ 30 days, cooling 30–120, dormant beyond, from your newest entry. */
export function mapRecency(newestMemberMs: number, newestEntryMs: number): "active" | "cooling" | "dormant" {
  return recencyOfDays((newestEntryMs - newestMemberMs) / 86_400_000);
}

/** The worker's sort name for a Read sort (it knows "size" where the page says "Most messages"). */
export function workerSort(sort: ReadSort): "newest" | "oldest" | "size" | "title" {
  return sort === "messages" ? "size" : sort;
}

/** Last path segment of a folder, for the tree. */
export function folderName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export interface ReadRow {
  ordinal: number;
  id: string;
  title: string;
  ms: number;
  count: number;
  youShare: number;
  source: string;
  space: string;
  isMap: boolean;
  /** The kind word of the meta line ("Conversation", "Note", "Decision"...). */
  kindWord?: string;
}

/** The kind word shown after the source in a row's caps meta line: "Conversation", "Document", "Decision", "Project map". */
export function rowKindWord(meta: Pick<ItemMeta, "kind" | "noteKind" | "mapKind" | "population" | "conversation">, count: number): string {
  if (meta.mapKind) return mapKindLabel(meta.mapKind);
  if (meta.noteKind) return kindLabel(meta.noteKind);
  if (meta.population === "note") return t("read.kindNote");
  if (meta.kind === ItemKind.RecordDocument) return t("read.kindDocument");
  if (meta.kind === ItemKind.RecordFile) return t("read.kindFile");
  if (meta.kind === ItemKind.RecordPassage) return t("read.kindPassage");
  return count > 1 || meta.conversation ? t("read.kindConversation") : t("read.kindMessage");
}

/** "SOURCE · KIND" (caps by style): Claude Code · Conversation. */
export function rowMetaLine(source: string, kindWord: string | undefined): string {
  return [sourceLabel(source), kindWord].filter((x): x is string => !!x).join(" · ");
}

/** A row's bold short date: "4 Oct", with the year when it is not this year. */
export function shortDate(ms: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  return d.toLocaleDateString("en-GB", sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

/** Colour slot (1..8) of a folder's dot: the sticky slot of its folder (or top-level folder) when Cortex assigned one, else a stable pick by top-level name. */
export function folderSlot(path: string, slots?: Readonly<Record<string, Readonly<Record<string, number>>>>): number {
  const top = path.split("/")[0] ?? path;
  for (const dim of ["folderPath", "folder"]) {
    for (const key of [path, top]) {
      const v = slots?.[dim]?.[key];
      if (v !== undefined && v >= 1 && v <= 8) return v;
    }
  }
  let h = 0;
  for (let i = 0; i < top.length; i++) h = (h * 31 + top.charCodeAt(i)) >>> 0;
  return (h % 8) + 1;
}

/** What the left column has picked: everything, the pinned items, or one folder (and what is under it). */
export type ReadSelection = { kind: "everything" } | { kind: "pinned" } | { kind: "folder"; path: string };

/** A folder wins over Pinned (a link that carries both lands on the folder). */
export function readSelection(folder: string | null, pinnedOnly: boolean): ReadSelection {
  if (folder) return { kind: "folder", path: folder };
  return pinnedOnly ? { kind: "pinned" } : { kind: "everything" };
}

/** The heading above the list: the selection's name and how many items it holds ("Everything" · "7,747 items"). */
export function selectionHeading(sel: ReadSelection, total: number): { name: string; count: string } {
  const name = sel.kind === "everything" ? t("read.everything") : sel.kind === "pinned" ? t("read.pinnedRow") : folderName(sel.path);
  return { name, count: total === 1 ? t("read.itemOne") : t("read.items", { n: total.toLocaleString("en-GB") }) };
}

/** Pinned items shown in their own section above the day-grouped cards. */
export const PINNED_SECTION_MAX = 10;

/** What the left column remembers while the leaf lives (the page remounts whenever its params change). */
export interface ReadNavState {
  recentOpen: boolean;
  /** The folder list under Everything is shown. */
  foldersOpen: boolean;
  /** Folders the person opened (true) or closed (false); anything else follows the default (top level open, the rest closed). */
  folders: Map<string, boolean>;
}

const NAV_STATE = new WeakMap<object, ReadNavState>();

/** The left column's open/closed state for a leaf (its store identifies it). */
export function readNavState(owner: object): ReadNavState {
  let st = NAV_STATE.get(owner);
  if (!st) {
    st = { recentOpen: true, foldersOpen: true, folders: new Map() };
    NAV_STATE.set(owner, st);
  }
  return st;
}

export interface TreeRow {
  path: string;
  name: string;
  depth: number;
  count: number;
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * The folder rows to draw: a row shows when every folder above it is open. Top-level folders start open (their children
 * show), deeper ones start closed; a choice made with a chevron wins; the folders above the selection stay open.
 */
export function treeRows(folders: readonly { path: string; count: number; depth: number }[], overrides: ReadonlyMap<string, boolean>, selected: string | null): TreeRow[] {
  const parents = new Set<string>();
  for (const f of folders) {
    const cut = f.path.lastIndexOf("/");
    if (cut > 0) parents.add(f.path.slice(0, cut));
  }
  const isOpen = (path: string): boolean => overrides.get(path) ?? (selected !== null && selected.startsWith(`${path}/`) ? true : !path.includes("/"));
  const out: TreeRow[] = [];
  for (const f of folders) {
    const parts = f.path.split("/");
    let visible = true;
    for (let k = 1; k < parts.length && visible; k++) visible = isOpen(parts.slice(0, k).join("/"));
    if (!visible) continue;
    const hasChildren = parents.has(f.path);
    out.push({ path: f.path, name: folderName(f.path), depth: parts.length - 1, count: f.count, hasChildren, expanded: hasChildren && isOpen(f.path) });
  }
  return out;
}

/** Open or close one folder in the leaf's remembered state. */
export function setNavFolderOpen(st: ReadNavState, path: string, open: boolean): void {
  st.folders.set(path, open);
}

export function Read(p: { params: Readonly<Record<string, string>> }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const fmt = useFmt();
  const index = useIndex(s);
  const tab = pick(p.params.tab, READ_TABS, "date");
  const sort = pick(p.params.sort, SORTS, "newest");
  const maps = pick(p.params.maps, MAPS, "all");
  const today = p.params.today === "1";
  const folder = p.params.folder ?? null;
  const pinnedOnly = p.params.pinned === "1" && folder === null;
  const selection = readSelection(folder, pinnedOnly);
  const limit = Math.max(PAGE_SIZE, Number(p.params.limit) || PAGE_SIZE);
  const [text, setText] = useState(p.params.q ?? "");
  const [query, setQuery] = useState(text);
  const [trace, setTrace] = useState(true);
  const [treePct, setTreePct] = useState(32);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const ui = leaf.store.slices.ui.value;
  const view = leaf.store.slices.view.value;
  const openOrdinal = openItemOrdinal(leaf.store.slices.selection.value);
  // With the reader in the column beside this page, its entry is the one marked in the list.
  const besideId = openBesideId(leaf.store.slices.ui.value);

  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), 200);
    return () => clearTimeout(id);
  }, [text]);

  // Trace the filter on the figure through a text token while the toggle is on.
  useEffect(() => {
    if (trace && query) addToken(leaf.store, { id: FILTER_TOKEN_ID, kind: "text", label: t("command.queryToken", { q: query, n: "…" }), text: query });
    else removeToken(leaf.store, FILTER_TOKEN_ID);
    return () => removeToken(leaf.store, FILTER_TOKEN_ID);
  }, [trace, query]);

  const vis = visibilityParams(ui, view);
  const visKey = JSON.stringify(vis);
  const stats = useLoad<ReadStats>(
    async (signal) => {
      if (tab === "source") return { kind: "read", total: 0, rows: [], folders: [] };
      const res = await s.worker.call(statsKey(leaf.viewId, "read"), "stats", { kind: "read", view: listView(tab, folder), folder, preset: today ? "today" : "all", pinnedOnly, sort: workerSort(sort), query, offset: 0, limit, visibility: vis }, { signal });
      if (res.kind !== "read") throw new Error("unexpected stats result");
      return res;
    },
    [tab, folder, today, pinnedOnly, sort, query, limit, visKey, index],
  );
  // The left column's folders and its Everything / Pinned counts do not depend on what the list is filtered by.
  const tree = useLoad<{ folders: ReadStats["folders"]; everything: number; pinned: number }>(
    async (signal) => {
      const base = { kind: "read" as const, view: "folder" as const, folder: null, preset: "all" as const, sort: "newest" as const, query: "", offset: 0, limit: 0, visibility: vis };
      const [all, pins] = await Promise.all([s.worker.call(statsKey(leaf.viewId, "tree"), "stats", { ...base, pinnedOnly: false }, { signal }), s.worker.call(statsKey(leaf.viewId, "pins"), "stats", { ...base, pinnedOnly: true }, { signal })]);
      if (all.kind !== "read" || pins.kind !== "read") throw new Error("unexpected stats result");
      return { folders: all.folders, everything: all.total, pinned: pins.total };
    },
    [visKey, index],
  );
  // Pinned items inside the selection: their own section above the cards (the Pinned row itself lists them as the whole list).
  const pinnedItems = useLoad<ReadRow[]>(
    async (signal) => {
      if (pinnedOnly || tab === "source") return [];
      const res = await s.worker.call(statsKey(leaf.viewId, "pinlist"), "stats", { kind: "read", view: listView(tab, folder), folder, preset: today ? "today" : "all", pinnedOnly: true, sort: workerSort(sort), query, offset: 0, limit: PINNED_SECTION_MAX, visibility: vis }, { signal });
      if (res.kind !== "read") throw new Error("unexpected stats result");
      return readRows(s, res.rows).filter((r) => isPinned(s, r.id, r.ordinal, index));
    },
    [tab, folder, today, pinnedOnly, sort, query, visKey, index],
  );
  const sources = useLoad<SourceStats>(
    async (signal) => {
      if (tab !== "source") return { kind: "sources", rows: [] };
      const res = await s.worker.call(statsKey(leaf.viewId, "sources"), "stats", { kind: "sources", visibility: vis }, { signal });
      if (res.kind !== "sources") throw new Error("unexpected stats result");
      return res;
    },
    [tab, visKey, index],
  );
  const todayInfo = useLoad(
    async (signal) => {
      if (!today) return null;
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      const [stat, runs] = await Promise.all([
        s.worker.call(statsKey(leaf.viewId, "today"), "stats", { kind: "today", dayStart: d.getTime() }, { signal }),
        s.ledger.runs({ from: d.toISOString(), limit: 500 }),
      ]);
      return { stat: stat as TodayStats, runs: runs.length, tokens: runs.reduce((n, r) => n + r.tokensIn + r.tokensOut, 0) };
    },
    [today],
  );
  const recent = useLoad<RecentItem[]>(
    async (signal) => {
      const res = await s.worker.call(statsKey(leaf.viewId, "recent"), "stats", { kind: "read", view: "date", folder: null, preset: "all", pinnedOnly: false, sort: "newest", query: "", offset: 0, limit: RECENT_COUNT, visibility: vis }, { signal });
      if (res.kind !== "read") throw new Error("unexpected stats result");
      const out: RecentItem[] = [];
      for (const r of res.rows) {
        const m = metaOf(s, r.ordinal);
        if (m) out.push({ ordinal: r.ordinal, title: m.title || t("read.untitled"), count: r.count });
      }
      return out;
    },
    [visKey, index],
  );
  const pinnedViews = useLoad<PinnedViewRecord[]>(() => (pinnedOnly ? s.pinnedViews.list() : Promise.resolve([])), [pinnedOnly]);

  const data = loaded(stats);
  const rows = useMemo<ReadRow[]>(() => {
    if (!data) return [];
    const out = readRows(s, data.rows);
    const pinFiltered = pinnedOnly ? out.filter((r) => isPinned(s, r.id, r.ordinal, index)) : out;
    if (maps === "all") return pinFiltered;
    const newest = pinFiltered.reduce((mx, r) => (Number.isFinite(r.ms) && r.ms > mx ? r.ms : mx), 0);
    return pinFiltered.filter((r) => !r.isMap || mapRecency(r.ms, newest) === maps);
  }, [data, maps, pinnedOnly, index]);
  const pinnedRows = loaded(pinnedItems) ?? [];
  // Pinned items sit in their own section, so the day-grouped cards leave them out.
  const pinnedSet = useMemo(() => new Set(pinnedRows.map((r) => r.ordinal)), [pinnedRows]);
  const cards = useMemo(() => (pinnedSet.size === 0 ? rows : rows.filter((r) => !pinnedSet.has(r.ordinal))), [rows, pinnedSet]);
  const flatCount = pinnedRows.length + cards.length;

  const setParam = (patch: Record<string, string | null>) => setPageParams(leaf.store, patch);
  const chooseFolder = (path: string | null) => {
    // Picking from the By source tab goes back to the list; Pinned is a row of its own, so a folder clears it.
    setParam({ folder: path, limit: null, pinned: null, ...(tab === "source" ? { tab: null } : {}) });
    removeToken(leaf.store, "read:folder");
    if (path) addToken(leaf.store, { id: "read:folder", kind: "group", dim: "folderPath", value: path, label: t("read.folderToken", { path }) });
  };
  const choosePinned = () => {
    setParam({ folder: null, limit: null, pinned: "1", ...(tab === "source" ? { tab: null } : {}) });
    removeToken(leaf.store, "read:folder");
  };
  const chooseSource = (source: string) => {
    addToken(leaf.store, { id: `read:source:${source}`, kind: "group", dim: "source", value: source, label: t("read.sourceToken", { source: sourceLabel(source) }) });
    setParam({ tab: "date" });
  };
  const open = (r: ReadRow) => openItemReader(s, leaf, r.ordinal, index, true);

  const onKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
    if (e.key === "j" || e.key === "J" || e.key === "k" || e.key === "K") {
      e.preventDefault();
      const next = Math.max(0, Math.min(flatCount - 1, active + (e.key.toLowerCase() === "j" ? 1 : -1)));
      setActive(next);
      listRef.current?.querySelectorAll<HTMLElement>(".cx-read-row")[next]?.focus();
    }
  };

  const sortItems = SORTS.map((v) => ({ value: v, label: t(sortKey(v)), checked: v === sort }));
  const mapItems = MAPS.map((v) => ({ value: v, label: t(mapsKey(v)), checked: v === maps }));
  const sortLabel = t(sortKey(sort));
  const now = Date.now();
  const treeData = loaded(tree);

  const newEntry = featureOn("newEntry") ? (
    <Button icon="newEntry" onClick={() => openPage(leaf.store, "new-entry", undefined, true)} class="cx-read-new">
      {t("read.newEntry")}
    </Button>
  ) : null;

  let lastSection = "";
  const grouped = tab === "date" && !today && (sort === "newest" || sort === "oldest");
  return (
    <PageFrame
      tabs={
        <div class="cx-read-controls">
          <div class="cx-read-bar">
            <input class="cx-input" type="search" placeholder={t("read.filter")} aria-label={t("read.filter")} value={text} onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)} />
            {newEntry}
          </div>
          <PageTabs
            label={t("pages.read")}
            value={tab}
            options={[
              { value: "date", label: t("read.byDate") },
              { value: "folder", label: t("read.byFolder") },
              { value: "source", label: t("read.bySource") },
            ]}
            onChange={(v) => setParam({ tab: v === "date" ? null : v })}
          />
          <div class="cx-read-toggles">
            {featureOn("today") ? (
              <ToggleButton icon="today" pressed={today} onToggle={(v) => setParam({ today: v ? "1" : null })}>
                {t("read.today")}
              </ToggleButton>
            ) : null}
            <MenuButton label={t("read.sort")} value={t("read.sortValue", { sort: sortLabel })} items={() => sortItems} onPick={(v) => setParam({ sort: v === "newest" ? null : v })} />
            {tab !== "source" ? <MenuButton label={t("read.maps")} value={t("read.mapsValue", { value: t(mapsKey(maps)) })} items={() => mapItems} onPick={(v) => setParam({ maps: v === "all" ? null : v })} /> : null}
          </div>
        </div>
      }
    >
      <div class="cx-read has-tree" data-tab={tab} onKeyDown={onKey}>
        {today ? (
          <Load value={todayInfo} failed={t("errors.read")}>
            {(info) => (
              <div class="cx-read-today">
                <strong>{t("read.todayTitle", { date: fmt.date(now) })}</strong>
                {info ? <span class="cx-note cx-mono">{t("read.todayRuns", { runs: info.runs, tokens: fmtCompact(info.tokens) })}</span> : null}
                {info && info.stat.bySource.length > 0 ? (
                  <ul class="cx-read-today-sources">
                    {info.stat.bySource.map((b) => (
                      <li>
                        <SourceIcon source={b.source} label /> <span class="cx-mono">{t("sources.count", { n: b.entries.toLocaleString("en-GB") })}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <button type="button" class="cx-text-button" onClick={() => void openDaily(s.app)}>
                  {t("read.openDaily")}
                </button>
              </div>
            )}
          </Load>
        ) : null}
        {pinnedOnly ? <PinnedViews value={loaded(pinnedViews) ?? []} remove={(id) => void s.pinnedViews.remove(id).then(() => setParam({ pinned: "1" }))} /> : null}
        <div class="cx-read-split">
          <ReadNav
            owner={leaf.store}
            tree={treeData?.folders ?? []}
            everything={treeData?.everything}
            pinned={treeData?.pinned}
            selection={selection}
            width={treePct}
            recent={loaded(recent) ?? []}
            openOrdinal={openOrdinal}
            onOpenRecent={(ordinal) => openItemReader(s, leaf, ordinal, index, true)}
            onEverything={() => chooseFolder(null)}
            onPinned={choosePinned}
            onFolder={chooseFolder}
          />
          <ResizeHandle onResize={setTreePct} />
          <div class="cx-read-centre">
            {tab === "source" ? null : <ListHeading selection={selection} total={data?.total ?? 0} ready={!!data} />}
            <div class="cx-read-list" ref={listRef} role="list" aria-label={t("read.list")}>
              {tab === "source" ? (
                <Load value={sources} failed={t("errors.read")}>
                  {(res) =>
                    res.rows.length === 0 ? (
                      <p class="cx-note">{t("sources.empty")}</p>
                    ) : (
                      <ul class="cx-read-sources">
                        {res.rows.map((r) => (
                          <li>
                            <button type="button" class="cx-read-source" onClick={() => chooseSource(r.source)}>
                              <SplitBar share={r.words > 0 ? r.yourWords / r.words : 0} />
                              <SourceIcon source={r.source} label />
                              <span class="cx-mono cx-read-source-n">{t("read.sourceRow", { n: r.entries.toLocaleString("en-GB"), p: Math.round((r.words > 0 ? r.yourWords / r.words : 0) * 100) })}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )
                  }
                </Load>
              ) : (
                <Load value={stats} failed={t("errors.read")} rows={6}>
                  {() =>
                    flatCount === 0 ? (
                      <p class="cx-note">{emptyText({ query, pinnedOnly, today, folder })}</p>
                    ) : (
                      <>
                        {pinnedRows.length > 0 ? (
                          <section class="cx-read-pinned" aria-label={t("read.pinnedSection")}>
                            <h3 class="cx-read-day">{t("read.pinnedSection")}</h3>
                            {pinnedRows.map((r, i) => (
                              <ReadRowView row={r} pinned current={r.ordinal === openOrdinal || r.id === besideId} when={Number.isFinite(r.ms) ? fmt.rel(r.ms) : t("agents.none")} tabbable={i === active} onOpen={() => open(r)} onFocus={() => setActive(i)} />
                            ))}
                          </section>
                        ) : null}
                        {cards.map((r, n) => {
                          const i = pinnedRows.length + n;
                          const sec = grouped ? (Number.isFinite(r.ms) ? daySection(r.ms, now, fmt.weekStart) : { label: t("read.undatedSection") }) : null;
                          const head = sec && sec.label !== lastSection ? ((lastSection = sec.label), <h3 class="cx-read-day">{sec.label}</h3>) : null;
                          return (
                            <>
                              {head}
                              <ReadRowView row={r} current={r.ordinal === openOrdinal || r.id === besideId} when={Number.isFinite(r.ms) ? fmt.rel(r.ms) : t("agents.none")} tabbable={i === active} onOpen={() => open(r)} onFocus={() => setActive(i)} />
                            </>
                          );
                        })}
                        {data && data.total > data.rows.length ? (
                          <button type="button" class="cx-text-button cx-read-more" onClick={() => setParam({ limit: String(limit + PAGE_SIZE) })}>
                            {t("read.more")}
                          </button>
                        ) : null}
                      </>
                    )
                  }
                </Load>
              )}
            </div>
          </div>
        </div>
      </div>
    </PageFrame>
  );
}

/** The worker groups by folder (and filters to one) only in its folder view, so a chosen folder uses it in every tab. */
function listView(tab: ReadTab, folder: string | null): "date" | "folder" | "source" {
  return folder !== null ? "folder" : tab;
}

/** Rows of the worker's answer with their item's facts (rows whose item is not in the index are left out). */
/**
 * The time a row sits under. A conversation is listed by its newest message (the list sorts by it), so a dated one
 * with more than one message takes that time when it is later than the first message's; an undated one stays undated.
 */
export function rowMs(firstMs: number, count: number, lastMs: number | undefined): number {
  if (!Number.isFinite(firstMs) || count <= 1 || lastMs === undefined || !Number.isFinite(lastMs)) return firstMs;
  return Math.max(firstMs, lastMs);
}

function readRows(s: ReturnType<typeof useServices>, rows: readonly { ordinal: number; count: number; youShare: number; last?: number }[]): ReadRow[] {
  const out: ReadRow[] = [];
  for (const r of rows) {
    const m = metaOf(s, r.ordinal);
    if (!m) continue;
    out.push({ ordinal: r.ordinal, id: m.id, title: m.title || t("read.untitled"), ms: rowMs(isoMs(m.writtenAt), r.count, r.last), count: r.count, youShare: r.youShare, source: m.source, space: m.space, isMap: m.mapKind !== undefined, kindWord: rowKindWord(m, r.count) });
  }
  return out;
}

function ListHeading(p: { selection: ReadSelection; total: number; ready: boolean }): JSX.Element {
  const h = selectionHeading(p.selection, p.total);
  return (
    <div class="cx-read-heading">
      <h3 class="cx-read-heading-name">{h.name}</h3>
      {p.ready ? <span class="cx-mono cx-read-heading-n">{h.count}</span> : null}
    </div>
  );
}

function sortKey(v: ReadSort): "read.sortNewest" | "read.sortOldest" | "read.sortMessages" | "read.sortTitle" {
  return v === "newest" ? "read.sortNewest" : v === "oldest" ? "read.sortOldest" : v === "messages" ? "read.sortMessages" : "read.sortTitle";
}

function mapsKey(v: MapsFilter): "read.mapsAll" | "read.mapsActive" | "read.mapsCooling" | "read.mapsDormant" {
  return v === "all" ? "read.mapsAll" : v === "active" ? "read.mapsActive" : v === "cooling" ? "read.mapsCooling" : "read.mapsDormant";
}

/** The empty-state sentence for the current filters. */
export function emptyText(f: { query: string; pinnedOnly: boolean; today: boolean; folder: string | null }): string {
  if (f.query) return t("read.noMatch", { text: f.query });
  if (f.pinnedOnly) return t("read.pinnedEmpty");
  if (f.today) return t("read.todayEmpty");
  return t("read.empty");
}

async function openDaily(app: ReturnType<typeof useServices>["app"]): Promise<void> {
  const commands = (app as unknown as { commands?: { executeCommandById?(id: string): boolean } }).commands;
  commands?.executeCommandById?.("daily-notes");
}

const SNIPPET_CHARS = 120;
const snippetCache = new Map<number, string>();

/** A vault note's first words: front matter, code fences, headings, list marks, links and emphasis stripped, flattened to one short line. */
export function noteSnippet(markdown: string, max = SNIPPET_CHARS): string {
  let text = markdown.replace(/^\uFEFF/, "").replace(/^---\r?\n[\s\S]*?\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/, "");
  text = text.replace(/```[\s\S]*?(```|$)/g, " ").replace(/~~~[\s\S]*?(~~~|$)/g, " ").replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/!\[\[[^\]]*\]\]/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/gm, "").replace(/[*_~`=]{1,3}/g, "").replace(/<[^>]+>/g, " ");
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** The first words of a row's text, fetched once the row scrolls into view: an entry's own text, a vault note read lazily through Obsidian's vault (cachedRead), the sample text in the sample record. Never machine text. */
function useSnippet(ordinal: number, id: string): [string, (el: HTMLElement | null) => void] {
  const s = useServices();
  const [text, setText] = useState(snippetCache.get(ordinal) ?? "");
  const seen = useRef(false);
  const shown = useRef(ordinal);
  if (shown.current !== ordinal) {
    // The row now stands for another entry (the list re-sorted under it): drop the old text and look again.
    shown.current = ordinal;
    seen.current = false;
    const cached = snippetCache.get(ordinal) ?? "";
    if (cached !== text) setText(cached);
  }
  const fetchText = async (): Promise<string> => {
    if (id.startsWith("e_") || s.sandbox.value) {
      const res = await s.records.entryText(ordinal);
      return res.ok ? res.text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS) : "";
    }
    if (!id.startsWith("w_") && !id.startsWith("n_")) return "";
    const path = vaultPathOf(s.app, id, metaOf(s, ordinal)?.folder);
    const vault = s.app.vault as unknown as { getAbstractFileByPath?(p: string): unknown; cachedRead?(f: unknown): Promise<string> };
    const file = path ? vault.getAbstractFileByPath?.(path) : null;
    if (!file || !vault.cachedRead) return "";
    return noteSnippet(await vault.cachedRead(file));
  };
  const attach = (el: HTMLElement | null): void => {
    if (!el || seen.current || text || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((hits) => {
      if (seen.current || !hits.some((h) => h.isIntersecting)) return;
      seen.current = true;
      io.disconnect();
      void fetchText()
        .then((flat) => {
          if (!flat) return;
          if (snippetCache.size > 600) snippetCache.clear();
          snippetCache.set(ordinal, flat);
          setText(flat);
        })
        .catch(() => undefined);
    });
    io.observe(el);
  };
  return [text, attach];
}

/** The ordinal of the selected (reader-open) item, or -1 when nothing is selected. */
export function openItemOrdinal(selection: { ordinal: number } | null | undefined): number {
  return selection && Number.isInteger(selection.ordinal) && selection.ordinal >= 0 ? selection.ordinal : -1;
}

export function ReadRowView(p: { row: ReadRow; current?: boolean; pinned?: boolean; when: string; tabbable: boolean; onOpen(): void; onFocus(): void }): JSX.Element {
  const r = p.row;
  const [snippet, attach] = useSnippet(r.ordinal, r.id);
  return (
    <div
      class={`cx-read-row${p.current ? " is-on" : ""}`}
      aria-current={p.current ? "true" : undefined}
      title={r.count > 1 ? t("read.messages", { n: r.count.toLocaleString("en-GB") }) : undefined}
      ref={attach}
      role="listitem"
      tabIndex={p.tabbable ? 0 : -1}
      onClick={p.onOpen}
      onFocus={p.onFocus}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) {
          e.preventDefault();
          p.onOpen();
        }
      }}
    >
      <SplitBar share={r.youShare} />
      <div class="cx-read-main">
        <div class="cx-read-line">
          {p.pinned ? (
            <svg class="cx-read-pin" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
              <path d="M4 1.5h4M5 1.5v3.2L3.2 6.6h5.6L7 4.7V1.5M6 6.6v3.9" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          ) : null}
          <span class="cx-read-title">{r.title}</span>
          {r.count > 1 ? <span class="cx-read-count cx-mono">{r.count.toLocaleString("en-GB")}</span> : null}
        </div>
        <div class="cx-snippet cx-snippet-2">
          <span class="cx-snippet-text">
            {Number.isFinite(r.ms) ? <strong class="cx-read-date">{shortDate(r.ms)}</strong> : null}
            <span class="cx-read-when cx-mono">{p.when}</span>
            {snippet || areaLabel(r.space)}
          </span>
        </div>
        <div class="cx-read-meta">
          <SourceIcon source={r.source} />
          <AreaDot space={r.space} label={false} />
          <span>{rowMetaLine(r.source, r.kindWord ?? (r.count > 1 ? t("read.kindConversation") : undefined))}</span>
        </div>
      </div>
    </div>
  );
}

function PinnedViews(p: { value: readonly PinnedViewRecord[]; remove(id: string): void }): JSX.Element | null {
  if (p.value.length === 0) return null;
  return (
    <section class="cx-pinned-views" aria-label={t("read.pinnedViews")}>
      <h3 class="cx-read-day">{t("read.pinnedViews")}</h3>
      <ul>
        {p.value.map((v) => (
          <li>
            <Icon name="pin" />
            <span>{v.name}</span>
            <button type="button" class="cx-text-button" aria-label={v.name} onClick={() => p.remove(v.id)}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ReadNav(p: {
  /** The leaf's store: the open/closed state of the column lives against it. */
  owner: object;
  tree: readonly { path: string; count: number; depth: number }[];
  everything: number | undefined;
  pinned: number | undefined;
  selection: ReadSelection;
  width: number;
  recent: readonly RecentItem[];
  /** Ordinal of the item open in the reader (the selection), or -1. */
  openOrdinal: number;
  onEverything(): void;
  onPinned(): void;
  onFolder(path: string): void;
  onOpenRecent(ordinal: number): void;
}): JSX.Element {
  const s = useServices();
  const st = readNavState(p.owner);
  const [, bump] = useState(0);
  const change = (fn: () => void) => {
    fn();
    bump((n) => n + 1);
  };
  let slots: Readonly<Record<string, Readonly<Record<string, number>>>> | undefined;
  try {
    slots = s.colours.current();
  } catch {
    slots = undefined;
  }
  const selected = p.selection.kind === "folder" ? p.selection.path : null;
  const rows = treeRows(p.tree, st.folders, selected);
  const n = (v: number | undefined) => (v === undefined ? "" : v.toLocaleString("en-GB"));
  return (
    <nav class="cx-folder-tree cx-read-nav" style={{ width: `${p.width}%` }} aria-label={t("read.folders")}>
      <div class="cx-nav-tree" role="tree" aria-label={t("read.folders")}>
        <div class={`cx-nav-row${p.selection.kind === "everything" ? " is-on" : ""}`} role="treeitem" aria-selected={p.selection.kind === "everything"} aria-expanded={st.foldersOpen}>
          <button type="button" class="cx-chevron" aria-label={t(st.foldersOpen ? "read.collapseFolder" : "read.expandFolder", { name: t("read.everything") })} onClick={() => change(() => void (st.foldersOpen = !st.foldersOpen))}>
            {st.foldersOpen ? "▾" : "▸"}
          </button>
          <button type="button" class="cx-nav-select" onClick={p.onEverything}>
            <span class="cx-folder-dot is-all" aria-hidden="true" />
            <span class="cx-folder-name">{t("read.everything")}</span>
            <span class="cx-mono cx-folder-n">{n(p.everything)}</span>
          </button>
        </div>
        <div class={`cx-nav-row${p.selection.kind === "pinned" ? " is-on" : ""}`} role="treeitem" aria-selected={p.selection.kind === "pinned"}>
          <span class="cx-chevron is-gap" aria-hidden="true" />
          <button type="button" class="cx-nav-select" onClick={p.onPinned}>
            <span class="cx-folder-dot is-pin" aria-hidden="true" />
            <span class="cx-folder-name">{t("read.pinnedRow")}</span>
            <span class="cx-mono cx-folder-n">{n(p.pinned)}</span>
          </button>
        </div>
      </div>
      <div class="cx-nav-scroll">
        {p.recent.length > 0 ? (
          <section class="cx-recent" aria-label={t("read.recent")}>
            <button type="button" class="cx-nav-head" aria-expanded={st.recentOpen} title={t(st.recentOpen ? "read.collapseRecent" : "read.expandRecent")} onClick={() => change(() => void (st.recentOpen = !st.recentOpen))}>
              <span class="cx-chevron" aria-hidden="true">{st.recentOpen ? "▾" : "▸"}</span>
              <span class="cx-nav-head-name">{t("read.recent")}</span>
              <span class="cx-mono cx-folder-n">{p.recent.length}</span>
            </button>
            {st.recentOpen
              ? p.recent.map((r) => (
                  <button type="button" class={`cx-folder cx-recent-row${r.ordinal === p.openOrdinal ? " is-on" : ""}`} aria-current={r.ordinal === p.openOrdinal ? "true" : undefined} title={r.title} onClick={() => p.onOpenRecent(r.ordinal)}>
                    <span class="cx-folder-name">{r.title}</span>
                    {r.count > 1 ? <span class="cx-mono cx-folder-n">{r.count.toLocaleString("en-GB")}</span> : null}
                  </button>
                ))
              : null}
          </section>
        ) : null}
        <div class="cx-nav-tree" role="tree" aria-label={t("read.folders")}>
          {st.foldersOpen
            ? rows.map((f) => (
                <div class={`cx-nav-row${selected === f.path ? " is-on" : ""}`} style={{ paddingLeft: `${f.depth * 12}px` }} role="treeitem" aria-level={f.depth + 1} aria-selected={selected === f.path} aria-expanded={f.hasChildren ? f.expanded : undefined}>
                  {f.hasChildren ? (
                    <button type="button" class="cx-chevron" aria-label={t(f.expanded ? "read.collapseFolder" : "read.expandFolder", { name: f.name })} onClick={() => change(() => setNavFolderOpen(st, f.path, !f.expanded))}>
                      {f.expanded ? "▾" : "▸"}
                    </button>
                  ) : (
                    <span class="cx-chevron is-gap" aria-hidden="true" />
                  )}
                  <button type="button" class="cx-nav-select" title={f.path} onClick={() => p.onFolder(f.path)}>
                    <span class="cx-folder-dot" style={{ background: `var(--cx-cat-${folderSlot(f.path, slots)})` }} aria-hidden="true" />
                    <span class="cx-folder-name">{f.name}</span>
                    <span class="cx-mono cx-folder-n">{f.count.toLocaleString("en-GB")}</span>
                  </button>
                </div>
              ))
            : null}
        </div>
      </div>
    </nav>
  );
}

/** Drag handle between the folder tree and the list; the tree takes 15–40% of the sheet. */
function ResizeHandle(p: { onResize(pct: number): void }): JSX.Element {
  const onDown = (e: PointerEvent) => {
    const handle = e.currentTarget as HTMLElement;
    const host = handle.parentElement;
    if (!host) return;
    handle.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const box = host.getBoundingClientRect();
      if (box.width <= 0) return;
      p.onResize(Math.max(15, Math.min(40, ((ev.clientX - box.left) / box.width) * 100)));
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };
  return <div class="cx-resize-handle" role="separator" aria-orientation="vertical" aria-label={t("read.resize")} onPointerDown={onDown} />;
}
