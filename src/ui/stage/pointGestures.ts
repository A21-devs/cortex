/**
 * What a gesture on a stage point does (CORTEX-UX §2.3 "How each kind of item opens", §5.2 Interactions). The
 * render controller emits "stage:point" (click, double-click, Ctrl/Cmd + click, right-click, Ctrl/Cmd + hover);
 * bindShell calls `handlePointGesture`. Owner: GAPS-UI.
 *
 *   Item                      Click                 Ctrl/Cmd + click            Double-click
 *   Vault note                note peek in sheet    new Obsidian tab            new Obsidian tab
 *   Machine note or map       Cortex reader         the markdown, new tab       Cortex reader
 *   Chat message              entry reader          reader, pinned              whole conversation reader
 *   Passage, file, new entry  entry reader          reader, pinned              entry reader (the document)
 *
 * Right-click: Open · Trace its sources · Trace everything like this · Pin · Show in Read · Copy link · (vault
 * notes) Open in new tab / Open to the right. Ctrl/Cmd + hover on a note: Obsidian's page preview.
 */
import { ItemKind } from "../../shared/index-format";
import type { ReaderRoute } from "../../shared/views";
import type { ItemMeta } from "../../plugin/indexer";
import type { CortexServices, LeafServices } from "../../plugin/services";
import { addToken, openPage } from "../../state/actions";
import { stageBus, type StageEvents } from "../context";
import { t } from "../copy";
import { copyToClipboard } from "../pages/PageFrame";
import { vaultPathOf } from "../reader/NotePeek";
import { linkFor, openInObsidian, openReader, setPinned } from "../reader/readerKit";
import { readerRouteOf } from "../reader/routes";
import { showMenu, type MenuItemSpec } from "../primitives/menu";
import { areaLabel, kindLabel, sourceLabel } from "../valueLabels";
import { truncate } from "../../shared/text";

export type PointEvent = StageEvents["stage:point"];
export type PointGesture = PointEvent["gesture"];

/** What the table says to do for one gesture. */
export type PointPlan =
  | { kind: "reader"; route: ReaderRoute; pin: boolean }
  | { kind: "file"; how: "tab" | "split" };

type MetaLike = Pick<ItemMeta, "id" | "kind" | "conversation">;

const isVaultNote = (m: MetaLike): boolean => m.kind === ItemKind.NoteWiki;
const isMachineNote = (m: MetaLike): boolean => m.kind >= ItemKind.NoteAtomic;
const isChatMessage = (m: MetaLike): boolean => m.kind === ItemKind.RecordMessage && m.conversation !== undefined;

/** The §2.3 table for click, double-click and Ctrl/Cmd + click. */
export function planGesture(m: MetaLike, gesture: "click" | "dblclick" | "ctrl-click"): PointPlan {
  const route = readerRouteOf(m.kind);
  if (isVaultNote(m)) return gesture === "click" ? { kind: "reader", route, pin: false } : { kind: "file", how: "tab" };
  if (isMachineNote(m)) return gesture === "ctrl-click" ? { kind: "file", how: "tab" } : { kind: "reader", route, pin: false };
  if (gesture === "dblclick" && isChatMessage(m)) return { kind: "reader", route: "conversation", pin: false };
  return { kind: "reader", route, pin: gesture === "ctrl-click" };
}

/** The vault path of a vault note or machine note (null for entries, or when the note is not in this vault). */
export async function notePathOf(s: CortexServices, meta: ItemMeta): Promise<string | null> {
  if (isVaultNote(meta)) return vaultPathOf(s.app, meta.id, meta.folder);
  if (isMachineNote(meta)) {
    try {
      const d = await s.records.note(meta.ordinal);
      return d.record.file || null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The token that "Trace everything like this" adds: same kind of note, same folder, same area or same source. */
export function likeThisToken(meta: ItemMeta): { id: string; kind: "group"; dim: "kind" | "folderPath" | "space" | "source"; value: string; label: string } | null {
  if (meta.noteKind) return { id: `like:kind:${meta.noteKind}`, kind: "group", dim: "kind", value: meta.noteKind, label: kindLabel(meta.noteKind, true) };
  if (isVaultNote(meta) && meta.folder) return { id: `like:folder:${meta.folder}`, kind: "group", dim: "folderPath", value: meta.folder, label: t("read.folderToken", { path: meta.folder }) };
  if (meta.kind === ItemKind.NoteHub || isVaultNote(meta)) return meta.space ? { id: `like:space:${meta.space}`, kind: "group", dim: "space", value: meta.space, label: areaLabel(meta.space) } : null;
  return { id: `like:source:${meta.source}`, kind: "group", dim: "source", value: meta.source, label: t("read.sourceToken", { source: sourceLabel(meta.source) }) };
}

export type PointMenuValue = "open" | "sources" | "like" | "pin" | "read" | "link" | "tab" | "right";

/** The right-click menu's rows (pure, so the order and the vault-note extras are testable). */
export function pointMenuItems(opts: { vaultNote: boolean; sources: number; pinned: boolean; canPin: boolean; hasLike: boolean }): MenuItemSpec<PointMenuValue>[] {
  const items: MenuItemSpec<PointMenuValue>[] = [
    { value: "open", label: t("pointMenu.open") },
    { value: "sources", label: t("reader.traceSources"), disabled: opts.sources === 0, ...(opts.sources > 0 ? { detail: String(opts.sources) } : {}) },
    { value: "like", label: t("pointMenu.traceLike"), disabled: !opts.hasLike },
    { value: "pin", label: opts.pinned ? t("reader.unpin") : t("reader.pin"), disabled: !opts.canPin },
    { value: "read", label: t("reader.showInRead") },
    { value: "link", label: t("reader.copyLink") },
  ];
  if (opts.vaultNote) {
    items.push({ value: "tab", label: t("pointMenu.newTab"), group: "file" }, { value: "right", label: t("reader.openToRight"), group: "file" });
  }
  return items;
}

/** Open a plan: a reader in the sheet (selects, optionally pins), or the markdown file in Obsidian. */
async function runPlan(s: CortexServices, leaf: LeafServices, meta: ItemMeta, plan: PointPlan): Promise<void> {
  if (plan.kind === "reader") {
    openReader(leaf, plan.route, meta.id, meta.ordinal);
    if (plan.pin && !s.sandbox.value) await setPinned(s, meta.id, true).catch(() => undefined);
    return;
  }
  const path = await notePathOf(s, meta);
  if (path && openInObsidian(s.app, path, plan.how)) return;
  // The file could not be found (moved or renamed): the reader still shows the note.
  openReader(leaf, readerRouteOf(meta.kind), meta.id, meta.ordinal);
}

/** The sources a point's lines join it to, as ids (the worker's `related`), for Trace its sources. */
async function sourcesOf(s: CortexServices, leaf: LeafServices, ordinal: number): Promise<string[]> {
  try {
    const res = await s.worker.call(leaf.viewId, "related", { ordinal });
    const ids: string[] = [];
    for (const o of res.sources) {
      const m = s.index.meta(o);
      if (m) ids.push(m.id);
    }
    return ids;
  } catch {
    return [];
  }
}

/** Right-click menu at the pointer. */
async function openPointMenu(s: CortexServices, leaf: LeafServices, root: HTMLElement, meta: ItemMeta, at: { x: number; y: number }): Promise<void> {
  const anchor = (root.querySelector("canvas") as HTMLElement | null) ?? root;
  const sources = await sourcesOf(s, leaf, meta.ordinal);
  const like = likeThisToken(meta);
  const pinned = (() => {
    try {
      return s.corrections.effective().pinned.has(meta.id);
    } catch {
      return false;
    }
  })();
  const items = pointMenuItems({ vaultNote: isVaultNote(meta), sources: sources.length, pinned, canPin: !s.sandbox.value, hasLike: like !== null });
  showMenu(
    items,
    anchor,
    (v) => {
      switch (v) {
        case "open":
          return void runPlan(s, leaf, meta, planGesture(meta, "click"));
        case "sources":
          addToken(leaf.store, { id: `set:sources:${meta.id}`, kind: "set", label: t("reader.sourcesToken", { title: truncate(meta.title.replace(/\s+/g, " ").trim(), 40) }), ids: sources });
          return;
        case "like":
          if (like) addToken(leaf.store, like);
          return;
        case "pin":
          return void setPinned(s, meta.id, !pinned).catch(() => undefined);
        case "read":
          return openPage(leaf.store, "read", { tab: "date", filter: truncate(meta.title, 80) }, true);
        case "link":
          return void notePathOf(s, meta).then((path) => copyToClipboard(path ? linkFor({ note: path }) : linkFor({ entry: meta.id })));
        case "tab":
          return void runPlan(s, leaf, meta, { kind: "file", how: "tab" });
        case "right":
          return void runPlan(s, leaf, meta, { kind: "file", how: "split" });
      }
    },
    { at },
  );
}

/** Dispatch one "stage:point" event. */
export async function handlePointGesture(s: CortexServices, leaf: LeafServices, root: HTMLElement, ev: PointEvent): Promise<void> {
  const meta = s.index.meta(ev.ordinal);
  if (!meta) return;
  switch (ev.gesture) {
    case "context":
      return openPointMenu(s, leaf, root, meta, { x: ev.x, y: ev.y });
    case "preview": {
      if (!ev.event || !(isVaultNote(meta) || isMachineNote(meta))) return;
      const path = await notePathOf(s, meta);
      const target = ((ev.event.target as HTMLElement | null) ?? (root.querySelector("canvas") as HTMLElement | null));
      if (path && target) s.bridge.previewNote(ev.event, target, path);
      return;
    }
    default:
      return runPlan(s, leaf, meta, planGesture(meta, ev.gesture));
  }
}

/** Subscribe to this leaf's point gestures. Returns the disposer. */
export function bindPointGestures(s: CortexServices, leaf: LeafServices, root: HTMLElement): () => void {
  return stageBus(s.bus).on("stage:point", (ev) => {
    if (ev.viewId !== leaf.viewId) return;
    void handlePointGesture(s, leaf, root, ev).catch((e: unknown) => s.log.warn("point gesture failed", { error: String(e) }));
  });
}
