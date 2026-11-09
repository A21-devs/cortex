/**
 * Native Obsidian hooks (CORTEX-UX §2.1–2.3; M3, SAFE-17). Owner: E1. The parsing half is part of the EAGER core
 * (main.ts registers the handlers cheaply); navigation resolves services lazily.
 *
 *  - registerObsidianProtocolHandler("cortex"): obsidian://cortex?entry=e_…|note=<vault path>|area=<id>|
 *    period=2026-11-02..2026-11-08|view=<pinned view id>. NAVIGATION ONLY: ids must match the id pattern, note
 *    paths resolve only through app.vault.getAbstractFileByPath inside this vault, periods parse strictly (real
 *    calendar days, start ≤ end), and nothing triggers an import, an agent run, Ask or a change. Unknown
 *    parameters (action, vault, v …) are ignored. Opens or reveals a Cortex leaf.
 *  - registerHoverLinkSource("cortex", { display: "Cortex", defaultMod: true }) + `previewNote()`, which
 *    triggers "hover-link" for Ctrl/Cmd-hover previews of vault notes and machine notes.
 *  - file-menu "Show in Cortex" (notes and folders); editor-menu "Show this note in Cortex" → `open()`.
 *  - file-open → bus "active-note" (Follow the active note; each leaf sets ui.activeNote).
 *  - Today preset → app.commands.executeCommandById("daily-notes") ("Open today's daily note").
 *  - "Open in editor" / Ctrl+click on a vault note → `openNote()` through workspace.openLinkText.
 *  - "Copy link" → `copyLink()` (obsidian://cortex links from validated ids only).
 *  - More menu: E11 rebuilds Obsidian's pane menu (onPaneMenu + trigger("leaf-menu")); the view header of Cortex
 *    leaves is hidden by CSS (styles/shell.css) and Cortex draws its own 44 px header.
 */
import { TFile, TFolder, type App, type WorkspaceLeaf } from "obsidian";
import { SPACE_ORDER } from "../shared/index-format";
import { wikiNoteId } from "../shared/ids";
import { endOfLocalDay, parseLocalDay } from "../shared/time";
import type { SpaceId } from "../shared/types";
import type { ReaderRoute } from "../shared/views";
import { addToken, openItem, setPeriod, setScope } from "../state/actions";
import { restoreLeafState } from "../state/persist";
import type { CortexStore } from "../state/store";
import { CortexView, VIEW_TYPE_CORTEX } from "../ui/CortexView";
import { t } from "../ui/copy";
import { noticeText } from "./notices";
import type { CortexServices } from "./services";

export type CortexLink =
  | { kind: "entry"; id: string; version?: number }
  | { kind: "note"; path: string }
  | { kind: "area"; area: SpaceId | "all" }
  | { kind: "period"; start: string; end: string }
  | { kind: "view"; id: string };

/** What the bridge can show: a parsed link, or a folder from the file explorer's "Show in Cortex". */
export type BridgeTarget = CortexLink | { kind: "folder"; path: string };

/** Entry links accept record entries and notes (machine "n_", vault "w_"). */
const ITEM_ID = /^[enw]_[a-z2-7]{16}$/;
export const PINNED_VIEW_LINK_ID = /^v_[a-z2-7]{16}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LINK_PATH = 400;

/** A vault-relative POSIX path that is safe to look up (no traversal, no absolute or device forms). */
export function safeVaultPath(raw: string, opts: { requireMarkdown?: boolean } = {}): string | null {
  if (typeof raw !== "string") return null;
  const p = raw.replace(/\\/g, "/").trim();
  if (p.length === 0 || p.length > MAX_LINK_PATH) return null;
  if (/[\u0000-\u001f\u007f]/.test(p)) return null;
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return null;
  if (p.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  if (opts.requireMarkdown && !p.toLowerCase().endsWith(".md")) return null;
  return p;
}

/** Parse protocol-handler params strictly; anything else is ignored (returns null). */
export function parseCortexLink(params: Readonly<Record<string, string | undefined>>): CortexLink | null {
  const { entry, note, area, period, view, v } = params;
  if (entry !== undefined) {
    if (!ITEM_ID.test(entry)) return null;
    if (v !== undefined && /^[1-9]\d{0,4}$/.test(v)) return { kind: "entry", id: entry, version: Number(v) };
    return { kind: "entry", id: entry };
  }
  if (note !== undefined) {
    const p = safeVaultPath(note, { requireMarkdown: true });
    return p === null ? null : { kind: "note", path: p };
  }
  if (area !== undefined) {
    const a = area.trim().toLowerCase();
    if (a === "all") return { kind: "area", area: "all" };
    return (SPACE_ORDER as readonly string[]).includes(a) ? { kind: "area", area: a as SpaceId } : null;
  }
  if (period !== undefined) {
    const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(period.trim());
    if (!m || !m[1] || !m[2] || !DAY.test(m[1]) || !DAY.test(m[2])) return null;
    if (Number.isNaN(parseLocalDay(m[1])) || Number.isNaN(parseLocalDay(m[2])) || m[1] > m[2]) return null;
    return { kind: "period", start: m[1], end: m[2] };
  }
  if (view !== undefined) return PINNED_VIEW_LINK_ID.test(view) ? { kind: "view", id: view } : null;
  return null;
}

/** obsidian://cortex link for a citation, a pinned view or "Copy link" (validated values only). */
export function cortexLink(link: CortexLink): string {
  switch (link.kind) {
    case "entry":
      return `obsidian://cortex?entry=${link.id}${link.version !== undefined ? `&v=${link.version}` : ""}`;
    case "note":
      return `obsidian://cortex?note=${encodeURIComponent(link.path)}`;
    case "area":
      return `obsidian://cortex?area=${link.area}`;
    case "period":
      return `obsidian://cortex?period=${link.start}..${link.end}`;
    case "view":
      return `obsidian://cortex?view=${link.id}`;
  }
}

/** The epoch-ms window [start of first day, end of last day] of a period link, in local time. */
export function periodWindow(start: string, end: string): [number, number] | null {
  const a = parseLocalDay(start);
  const b = parseLocalDay(end);
  if (Number.isNaN(a) || Number.isNaN(b) || a > b) return null;
  return [a, endOfLocalDay(b)];
}

type LeafWithInternals = WorkspaceLeaf & { activeTime?: number; loadIfDeferred?: () => Promise<void> };

/** The Cortex leaf used last (by Obsidian's activation time when available), or undefined. */
export function mostRecentCortexLeaf(app: App): WorkspaceLeaf | undefined {
  const leaves = app.workspace.getLeavesOfType(VIEW_TYPE_CORTEX) as LeafWithInternals[];
  if (leaves.length === 0) return undefined;
  const active = app.workspace.getActiveViewOfType?.(CortexView);
  if (active) return active.leaf;
  return [...leaves].sort((a, b) => (b.activeTime ?? 0) - (a.activeTime ?? 0))[0];
}

/**
 * Reveal the most recent Cortex leaf, or create one in the main area as a new tab (`newLeaf` always creates
 * one). Focuses it and returns its view (null if Obsidian did not give the leaf a Cortex view).
 */
export async function revealCortexLeaf(app: App, opts: { newLeaf?: boolean } = {}): Promise<CortexView | null> {
  const ws = app.workspace;
  let leaf: LeafWithInternals | undefined = opts.newLeaf ? undefined : (mostRecentCortexLeaf(app) as LeafWithInternals | undefined);
  if (!leaf) {
    leaf = ws.getLeaf("tab") as LeafWithInternals;
    await leaf.setViewState({ type: VIEW_TYPE_CORTEX, active: true });
  }
  await leaf.loadIfDeferred?.();
  await ws.revealLeaf(leaf);
  ws.setActiveLeaf?.(leaf, { focus: true });
  return leaf.view instanceof CortexView ? leaf.view : null;
}

/** Wait until a Cortex view has mounted its leaf store (it mounts after services and the UI bundle load). */
export async function waitForLeafStore(view: CortexView, timeoutMs = 15_000, pollMs = 50): Promise<CortexStore | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const store = view.leafStore();
    if (store) return store;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export interface ObsidianBridge {
  /** Navigate the most recent (or a new) Cortex leaf to a link or a folder. Resolves when navigation is done. */
  open(target: BridgeTarget): Promise<void>;
  /** Run Obsidian's core Daily notes command; false when it is not available (the core plugin is off). */
  openDailyNote(): boolean;
  /** Open a vault note in Obsidian's editor ("same" leaf, a new tab, a split or a window). */
  openNote(path: string, where?: "same" | "tab" | "split" | "window"): Promise<boolean>;
  /** Obsidian's page preview for a vault or machine note (Ctrl/Cmd-hover, §2.3). */
  previewNote(event: MouseEvent, targetEl: HTMLElement, path: string): void;
  /** Copy an obsidian://cortex link to the clipboard. */
  copyLink(link: CortexLink): Promise<boolean>;
  dispose(): void;
}

export interface BridgeDeps {
  app: App;
  /** The finished service container (the bridge is created while it is being built). */
  services(): CortexServices;
  /** Show a notice (Obsidian Notice in the plugin; a recorder in tests). */
  showNotice(text: string): void;
  /** Reveal a Cortex leaf (defaults to revealCortexLeaf). */
  reveal?(opts: { newLeaf?: boolean }): Promise<CortexView | null>;
  /** How long to wait for a new leaf to mount (default 15 s). */
  mountTimeoutMs?: number;
}

const MACHINE_NOTE_ID = /^n_[a-z2-7]{16}$/;

/** Resolve a vault markdown file to the id and reader route Cortex uses for it. */
export function noteTarget(app: App, file: TFile): { id: string; route: ReaderRoute } {
  const fm = app.metadataCache?.getFileCache?.(file)?.frontmatter as Record<string, unknown> | undefined;
  const cid = fm?.cortex_id;
  if (typeof cid === "string" && MACHINE_NOTE_ID.test(cid)) {
    const isMap = fm?.cortex_kind === "map" || typeof fm?.cortex_map_kind === "string";
    return { id: cid, route: isMap ? "map" : "note" };
  }
  return { id: wikiNoteId(file.path), route: "vault-peek" };
}

export function createBridge(deps: BridgeDeps): ObsidianBridge {
  const { app } = deps;
  const reveal = deps.reveal ?? ((opts: { newLeaf?: boolean }) => revealCortexLeaf(app, opts));
  const hoverParent: { hoverPopover: unknown } = { hoverPopover: null };
  let disposed = false;

  const ordinalOf = async (id: string): Promise<number> => {
    const s = deps.services();
    await s.index.load();
    return s.index.ordinalOf(id);
  };

  const openItemById = async (store: CortexStore, id: string, route: ReaderRoute): Promise<boolean> => {
    const ordinal = await ordinalOf(id);
    if (ordinal < 0) return false;
    let r = route;
    if (id.startsWith("n_")) {
      const meta = deps.services().index.meta(ordinal);
      r = meta?.mapKind !== undefined ? "map" : "note";
    }
    openItem(store, ordinal, id, r);
    return true;
  };

  const navigate = async (store: CortexStore, target: BridgeTarget): Promise<void> => {
    switch (target.kind) {
      case "entry": {
        const route: ReaderRoute = target.id.startsWith("e_") ? "entry" : target.id.startsWith("w_") ? "vault-peek" : "note";
        if (!(await openItemById(store, target.id, route))) deps.showNotice(noticeText("notFound"));
        return;
      }
      case "note": {
        const file = app.vault.getAbstractFileByPath(target.path);
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") {
          deps.showNotice(noticeText("notFound"));
          return;
        }
        const { id, route } = noteTarget(app, file);
        if (!(await openItemById(store, id, route))) deps.showNotice(noticeText("notFound"));
        return;
      }
      case "folder": {
        const folder = app.vault.getAbstractFileByPath(target.path);
        if (!(folder instanceof TFolder)) {
          deps.showNotice(noticeText("notFound"));
          return;
        }
        addToken(store, { id: `folder:${folder.path}`, kind: "group", dim: "folderPath", value: folder.path, label: t("read.folderToken", { path: folder.path }) });
        return;
      }
      case "area":
        setScope(store, target.area);
        return;
      case "period": {
        const w = periodWindow(target.start, target.end);
        if (w) setPeriod(store, w);
        return;
      }
      case "view": {
        const s = deps.services();
        const rec = await s.pinnedViews.get(target.id);
        if (!rec) {
          deps.showNotice(noticeText("notFound"));
          return;
        }
        restoreLeafState(store, rec.state, s.settings.value);
        return;
      }
    }
  };

  return {
    async open(target) {
      if (disposed) return;
      const view = await reveal({});
      if (!view) return;
      const store = await waitForLeafStore(view, deps.mountTimeoutMs ?? 15_000);
      if (!store || disposed) return;
      await navigate(store, target);
    },
    openDailyNote() {
      const commands = (app as unknown as { commands?: { executeCommandById?(id: string): boolean } }).commands;
      try {
        return commands?.executeCommandById?.("daily-notes") === true;
      } catch {
        return false;
      }
    },
    async openNote(path, where = "tab") {
      const p = safeVaultPath(path);
      if (p === null) return false;
      const file = app.vault.getAbstractFileByPath(p);
      if (!(file instanceof TFile)) return false;
      await app.workspace.openLinkText(file.path, "", where === "same" ? false : where);
      return true;
    },
    previewNote(event, targetEl, path) {
      const p = safeVaultPath(path);
      if (p === null || disposed) return;
      app.workspace.trigger("hover-link", { event, source: "cortex", hoverParent, targetEl, linktext: p, sourcePath: "" });
    },
    async copyLink(link) {
      const clip = (globalThis as { navigator?: { clipboard?: { writeText?(s: string): Promise<void> } } }).navigator?.clipboard;
      if (typeof clip?.writeText !== "function") return false;
      try {
        await clip.writeText(cortexLink(link));
        return true;
      } catch {
        return false;
      }
    },
    dispose() {
      disposed = true;
      hoverParent.hoverPopover = null;
    },
  };
}
