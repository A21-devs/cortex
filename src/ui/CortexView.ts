/**
 * The Obsidian view (type "cortex-view"). Owner: E11. Part of the EAGER core: it imports nothing heavy; the UI
 * (Preact, three.js, renderer, panels) loads with a dynamic import() on first open.
 *
 *  - Each leaf is independent (H6): it creates its own leaf store through services.createLeaf(viewId) and
 *    persists shape, colours, layers, motion, look, scope, period, camera, sheet stack, sheet width, key
 *    collapsed and query tokens through getState/setState (CORTEX-UX §2.2).
 *  - Open is race-safe (VIEW-OPEN-RACE): a generation counter is checked after every await, so a tab closed or a
 *    plugin reloaded mid-open never mounts into a detached element; failures render an error with Try again.
 *  - A leaf restored with the workspace while Obsidian is still starting renders a light placeholder and mounts
 *    after layout ready + idle (Obsidian defers only background tabs).
 *  - Pop-out windows: everything the UI binds (animation frames, listeners, visibility, DPR) uses contentEl.win
 *    and contentEl.doc; the renderer is recreated when the leaf moves windows.
 *  - Immersive header: Cortex hides Obsidian's view header for its own leaf (styles/shell.css) and draws its
 *    own 44 px header; the More menu rebuilds Obsidian's pane menu (onPaneMenu + trigger("leaf-menu")).
 *  - Keyboard (§8.1): at mount the view sets `this.scope = new Scope(this.app.scope)` and registers ui/keymap.ts
 *    there, so Cortex keys work only while focus is inside the view.
 *  - Breakpoints (§2.5) come from a ResizeObserver on contentEl (ui/breakpoints.ts), never the window size.
 */
import { ItemView, Scope, type Menu, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { CortexServices, LeafServices } from "../plugin/services";
import type { ViewBridge } from "./context";
import { captureLeafState } from "../state/persist";
import type { CortexStore } from "../state/store";
import { CORTEX_ICON_ID } from "./icons";

export const VIEW_TYPE_CORTEX = "cortex-view";

export interface CortexViewHost {
  getServices(): Promise<CortexServices>;
  /** The lazy UI module (Preact, three.js, panels); main.ts supplies it from the lazy chunk. */
  loadUi(): Promise<typeof import("./mount")>;
  isLayoutReady(): boolean;
}

let viewCounter = 0;

export class CortexView extends ItemView {
  private unmount: (() => void) | null = null;
  private gen = 0;
  private leafServices: LeafServices | null = null;
  private pendingState: unknown = null;
  private areaName: string | null = null;
  /** The document the UI was mounted into; a different one after a move means the leaf is in another window. */
  private mountedDoc: Document | null = null;
  readonly viewId = `v${++viewCounter}-${Math.random().toString(36).slice(2, 8)}`;

  constructor(leaf: WorkspaceLeaf, private readonly host: CortexViewHost) {
    super(leaf);
  }

  override getViewType(): string {
    return VIEW_TYPE_CORTEX;
  }

  override getDisplayText(): string {
    return this.areaName ? `Cortex · ${this.areaName}` : "Cortex";
  }

  override getIcon(): string {
    return CORTEX_ICON_ID;
  }

  /** The leaf store (commands act on the active leaf). */
  leafStore(): CortexStore | null {
    return this.leafServices?.store ?? null;
  }

  setAreaName(name: string | null): void {
    this.areaName = name;
  }

  override getState(): Record<string, unknown> {
    const base = super.getState?.() ?? {};
    const s = this.leafServices?.store;
    if (!s) return { ...base, cortex: this.pendingState };
    return { ...base, cortex: captureLeafState(s) };
  }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const st = state as { cortex?: unknown } | null;
    this.pendingState = st?.cortex ?? null;
    await super.setState?.(state, result);
  }

  private connected(gen: number): boolean {
    return gen === this.gen && (this.contentEl as unknown as { isConnected?: boolean }).isConnected !== false;
  }

  override async onOpen(): Promise<void> {
    const gen = ++this.gen;
    const root = this.contentEl;
    root.empty();
    root.addClass("cx-host");
    if (!this.host.isLayoutReady()) {
      root.createDiv({ cls: "cx-placeholder" });
      this.app.workspace.onLayoutReady(() => {
        const idle = (root as unknown as { win?: { requestIdleCallback?: (cb: () => void) => void } }).win?.requestIdleCallback;
        if (idle) idle(() => void this.mount(gen));
        else void this.mount(gen);
      });
      return;
    }
    this.registerEvent(this.app.workspace.on("layout-change", () => this.followWindow(gen)));
    await this.mount(gen);
  }

  /** The renderer and every listener belong to one window: recreate the UI when the leaf moves to another. */
  private followWindow(gen: number): void {
    const doc = this.contentEl.ownerDocument;
    if (gen !== this.gen || !this.unmount || !this.mountedDoc || doc === this.mountedDoc) return;
    this.pendingState = this.leafServices ? captureLeafState(this.leafServices.store) : this.pendingState;
    this.unmount();
    this.unmount = null;
    this.leafServices?.dispose();
    this.leafServices = null;
    void this.mount(gen);
  }

  /** What the UI may ask of the view: pane menu items, the main area, the sidebar test, the tab title, a layout save. */
  private bridge(): ViewBridge {
    return {
      fillPaneMenu: (menu: Menu) => {
        this.onPaneMenu(menu, "more-options");
        this.app.workspace.trigger("leaf-menu", menu, this.leaf);
      },
      openInMainArea: () => {
        const state = this.leaf.getViewState();
        const target = this.app.workspace.getLeaf("tab");
        void target.setViewState(state).then(() => this.leaf.detach());
      },
      inSidebar: () => {
        const root = this.leaf.getRoot();
        return root === this.app.workspace.leftSplit || root === this.app.workspace.rightSplit;
      },
      refreshTitle: () => (this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.(),
      saveLayout: () => this.app.workspace.requestSaveLayout(),
    };
  }

  private async mount(gen: number): Promise<void> {
    try {
      const services = await this.host.getServices();
      if (!this.connected(gen)) return;
      const ui = await this.host.loadUi();
      if (!this.connected(gen)) return;
      this.leafServices = services.createLeaf(this.viewId);
      this.contentEl.empty();
      this.scope = new Scope(this.app.scope);
      this.mountedDoc = this.contentEl.ownerDocument;
      this.unmount = ui.mountCortex(this.contentEl, services, this.leafServices, this.pendingState, { bridge: this.bridge(), scope: this.scope });
    } catch (e) {
      if (!this.connected(gen)) return;
      this.renderError(gen, e);
    }
  }

  private renderError(gen: number, e: unknown): void {
    const root = this.contentEl;
    root.empty();
    const box = root.createDiv({ cls: "cx-error" });
    box.createDiv({ text: "Cortex couldn't open this view. Nothing was changed." });
    box.createDiv({ cls: "cx-error-detail", text: e instanceof Error ? e.message : String(e) });
    const btn = box.createEl("button", { text: "Try again" });
    btn.onclick = () => {
      if (gen === this.gen) void this.onOpen();
    };
  }

  override async onClose(): Promise<void> {
    this.gen++;
    this.unmount?.();
    this.unmount = null;
    this.mountedDoc = null;
    this.leafServices?.dispose();
    this.leafServices = null;
  }
}
