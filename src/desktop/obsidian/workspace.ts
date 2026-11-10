/**
 * Obsidian's workspace for Cortex Desktop: one host element that fills the window and shows one leaf at a time,
 * with Obsidian's leaf DOM (`.workspace-leaf-content[data-type] > .view-header + .view-content`) so Cortex's CSS
 * applies unchanged. There are no tabs, splits or sidebars: getLeaf() always answers the main leaf (a "new
 * tab" opens in it), the splits exist only so `leaf.getRoot()` comparisons work, and opening a note goes to
 * Obsidian itself (obsidian://open) because the desktop has no editor.
 */
import { Component, type Scope } from "./component";
import { Events } from "./events";
import type { Menu } from "./ui";

export interface ViewState {
  type: string;
  state?: Record<string, unknown>;
  active?: boolean;
  pinned?: boolean;
}

export interface ViewStateResult {
  history: boolean;
}

export type ViewCreator = (leaf: WorkspaceLeaf) => View;

/** What the workspace needs from the desktop around it. */
export interface WorkspaceHost {
  /** Open a vault path in Obsidian (the desktop has no editor). */
  openInObsidian(path: string): void;
  /** Persist the layout (the leaf's view state) — debounced by the workspace. */
  saveLayout(layout: unknown): void;
}

interface AppLike {
  workspace: Workspace;
  keymap: { viewScope: () => Scope | null };
  metadataCache: { getFirstLinkpathDest(linkpath: string, sourcePath: string): { path: string } | null };
}

export abstract class View extends Component {
  readonly app: AppLike;
  icon = "";
  navigation = false;
  readonly containerEl: HTMLElement;
  scope: Scope | null = null;

  constructor(readonly leaf: WorkspaceLeaf) {
    super();
    this.app = leaf.app;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "workspace-leaf-content";
  }

  abstract getViewType(): string;
  abstract getDisplayText(): string;

  getIcon(): string {
    return this.icon;
  }

  getState(): Record<string, unknown> {
    return {};
  }

  async setState(_state: unknown, _result: ViewStateResult): Promise<void> {}

  getEphemeralState(): Record<string, unknown> {
    return {};
  }

  setEphemeralState(_state: unknown): void {}

  async onOpen(): Promise<void> {}

  async onClose(): Promise<void> {}

  onResize(): void {}

  /** Obsidian adds its own pane items here; the desktop has none to add. */
  onPaneMenu(_menu: Menu, _source: string): void {}
}

export abstract class ItemView extends View {
  readonly contentEl: HTMLElement;
  private readonly headerEl: HTMLElement;
  private readonly actionsEl: HTMLElement;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.headerEl = document.createElement("div");
    this.headerEl.className = "view-header";
    this.actionsEl = document.createElement("div");
    this.actionsEl.className = "view-actions";
    this.headerEl.appendChild(this.actionsEl);
    this.contentEl = document.createElement("div");
    this.contentEl.className = "view-content";
    this.containerEl.append(this.headerEl, this.contentEl);
  }

  addAction(icon: string, title: string, callback: (evt: MouseEvent) => unknown): HTMLElement {
    const a = document.createElement("a");
    a.className = "clickable-icon view-action";
    a.setAttribute("aria-label", title);
    a.dataset.icon = icon;
    a.addEventListener("click", callback);
    this.actionsEl.appendChild(a);
    return a;
  }
}

/** Stand-ins for Obsidian's splits: `leaf.getRoot()` returns rootSplit, never a sidebar. */
export class WorkspaceSplit {
  constructor(readonly name: string) {}
}

export class WorkspaceLeaf extends Events {
  view: View | null = null;
  activeTime = 0;
  readonly containerEl: HTMLElement;
  /** The leaf has no deferred state in the desktop. */
  readonly isDeferred = false;
  private opening: Promise<void> = Promise.resolve();

  constructor(readonly app: AppLike) {
    super();
    this.containerEl = document.createElement("div");
    this.containerEl.className = "workspace-leaf mod-active";
  }

  getRoot(): WorkspaceSplit {
    return this.app.workspace.rootSplit;
  }

  getContainer(): WorkspaceSplit {
    return this.app.workspace.rootSplit;
  }

  getViewState(): ViewState {
    if (!this.view) return { type: "empty", state: {} };
    return { type: this.view.getViewType(), state: this.view.getState(), active: this.app.workspace.activeLeaf === this };
  }

  getDisplayText(): string {
    return this.view?.getDisplayText() ?? "";
  }

  getIcon(): string {
    return this.view?.getIcon() ?? "";
  }

  async loadIfDeferred(): Promise<void> {
    await this.opening;
  }

  updateHeader(): void {
    this.app.workspace.trigger("leaf-title", this);
  }

  setPinned(_pinned: boolean): void {}

  togglePinned(): void {}

  async openFile(): Promise<void> {
    throw new Error("Cortex Desktop has no editor; notes open in Obsidian");
  }

  /** Replace the leaf's view: close the old one (onClose, unload), build the new one, setState, onOpen. */
  setViewState(state: ViewState, _eState?: unknown): Promise<void> {
    this.opening = this.opening.then(() => this.swap(state)).catch((e: unknown) => console.error("[cortex-desktop] could not open the view", e));
    return this.opening;
  }

  private async swap(state: ViewState): Promise<void> {
    const ws = this.app.workspace;
    if (this.view) {
      const old = this.view;
      this.view = null;
      try {
        await old.onClose();
      } finally {
        old.unload();
        old.containerEl.remove();
      }
    }
    const create = ws.viewCreator(state.type);
    if (!create) return;
    const view = create(this);
    this.view = view;
    view.containerEl.dataset.type = state.type;
    this.containerEl.replaceChildren(view.containerEl);
    view.load();
    await view.setState(state.state ?? {}, { history: false });
    await view.onOpen();
    if (state.active) ws.setActiveLeaf(this, { focus: true });
    ws.trigger("layout-change");
  }

  async detach(): Promise<void> {
    await this.setViewState({ type: "empty" });
    this.app.workspace.onDetach(this);
  }
}

export class Workspace extends Events {
  readonly rootSplit = new WorkspaceSplit("root");
  readonly leftSplit = new WorkspaceSplit("left");
  readonly rightSplit = new WorkspaceSplit("right");
  readonly containerEl: HTMLElement;
  activeLeaf: WorkspaceLeaf | null = null;
  layoutReady = false;
  private readonly creators = new Map<string, ViewCreator>();
  private readonly readyQueue: (() => unknown)[] = [];
  private main: WorkspaceLeaf | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly app: AppLike,
    hostEl: HTMLElement,
    private readonly host: WorkspaceHost,
  ) {
    super();
    this.containerEl = hostEl;
    this.containerEl.classList.add("workspace", "cxd-workspace");
    // Obsidian keeps its view scope on the active leaf; the keymap reads it at key time.
    app.keymap.viewScope = () => this.activeLeaf?.view?.scope ?? null;
  }

  registerView(type: string, creator: ViewCreator): void {
    this.creators.set(type, creator);
  }

  unregisterView(type: string): void {
    this.creators.delete(type);
    if (this.main?.view?.getViewType() === type) void this.main.detach();
  }

  viewCreator(type: string): ViewCreator | undefined {
    return this.creators.get(type);
  }

  onLayoutReady(callback: () => unknown): void {
    if (this.layoutReady) {
      try {
        callback();
      } catch (e) {
        console.error("[cortex-desktop] onLayoutReady callback failed", e);
      }
    } else this.readyQueue.push(callback);
  }

  /** The window has its layout: run what waited for it. */
  setLayoutReady(): void {
    if (this.layoutReady) return;
    this.layoutReady = true;
    for (const cb of this.readyQueue.splice(0)) {
      try {
        cb();
      } catch (e) {
        console.error("[cortex-desktop] onLayoutReady callback failed", e);
      }
    }
    this.trigger("layout-ready");
  }

  private mainLeaf(): WorkspaceLeaf {
    if (!this.main) {
      this.main = new WorkspaceLeaf(this.app);
      this.containerEl.appendChild(this.main.containerEl);
    }
    return this.main;
  }

  /** Every request for a leaf (same, tab, split, window) answers the one main leaf. */
  getLeaf(_newLeaf?: boolean | "tab" | "split" | "window"): WorkspaceLeaf {
    return this.mainLeaf();
  }

  getMostRecentLeaf(): WorkspaceLeaf | null {
    return this.main;
  }

  getLeavesOfType(type: string): WorkspaceLeaf[] {
    return this.main?.view?.getViewType() === type ? [this.main] : [];
  }

  iterateAllLeaves(cb: (leaf: WorkspaceLeaf) => unknown): void {
    if (this.main) cb(this.main);
  }

  iterateRootLeaves(cb: (leaf: WorkspaceLeaf) => unknown): void {
    this.iterateAllLeaves(cb);
  }

  detachLeavesOfType(type: string): void {
    for (const l of this.getLeavesOfType(type)) void l.detach();
  }

  async revealLeaf(leaf: WorkspaceLeaf): Promise<void> {
    await leaf.loadIfDeferred();
    this.setActiveLeaf(leaf);
  }

  setActiveLeaf(leaf: WorkspaceLeaf, _params?: { focus?: boolean }): void {
    const changed = this.activeLeaf !== leaf;
    this.activeLeaf = leaf;
    leaf.activeTime = Date.now();
    if (changed) this.trigger("active-leaf-change", leaf);
  }

  getActiveViewOfType<T extends View>(type: abstract new (...args: never[]) => T): T | null {
    const v = this.activeLeaf?.view;
    return v instanceof type ? (v as T) : null;
  }

  /** No editor in the desktop: there is never an active file. */
  getActiveFile(): null {
    return null;
  }

  /** Open a link in Obsidian (resolved against the vault; unresolved links open as typed). */
  async openLinkText(linktext: string, sourcePath: string, _newLeaf?: boolean | "tab" | "split" | "window"): Promise<void> {
    const [pathPart] = linktext.split("#");
    const dest = this.app.metadataCache.getFirstLinkpathDest(pathPart ?? "", sourcePath);
    this.host.openInObsidian(dest?.path ?? pathPart ?? linktext);
  }

  /** Save the layout soon (Obsidian saves workspace.json the same way). */
  requestSaveLayout(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.host.saveLayout(this.getLayout());
    }, 1000);
  }

  getLayout(): { main: ViewState | null } {
    return { main: this.main?.view ? this.main.getViewState() : null };
  }

  /** Called when a leaf detached itself. */
  onDetach(leaf: WorkspaceLeaf): void {
    if (this.activeLeaf === leaf) this.activeLeaf = null;
    this.trigger("layout-change");
  }

  /** Flush a pending layout save now (window closing). */
  flushLayout(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.host.saveLayout(this.getLayout());
  }
}
