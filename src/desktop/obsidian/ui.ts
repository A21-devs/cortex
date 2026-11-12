/**
 * Obsidian's menus, notices and modals for Cortex Desktop, drawn as DOM with Obsidian's class names (`.menu`,
 * `.menu-item`, `.notice`, `.modal-container`, `.prompt`) and styled by desktop.css in Cortex's glass look.
 *  - Menu: one open at a time; keyboard (arrows, Enter, Esc, → / ← for submenus); closes on an outside click,
 *    on blur and on resize; flips to stay inside the window; submenus open on hover.
 *  - Notice: a toast in the top-right corner (default 5 s; 0 keeps it until clicked).
 *  - Modal: dimmed backdrop, Esc and the close button close it, focus moves inside and returns afterwards.
 *  - SuggestModal / FuzzySuggestModal: Obsidian's prompt (input, results, arrows + Enter).
 */
import { Component, Scope } from "./component";
import { shimContext } from "./context";
import { getIcon } from "./icons";

function layer(): HTMLElement {
  return shimContext()?.layer() ?? document.body;
}

function pushScope(scope: Scope): void {
  shimContext()?.keymap.pushScope(scope);
}

function popScope(scope: Scope): void {
  shimContext()?.keymap.popScope(scope);
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ───────────────────────────── Menu ─────────────────────────────

export class MenuItem {
  readonly dom: HTMLElement;
  readonly iconEl: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly checkIconEl: HTMLElement;
  callback: ((evt: MouseEvent | KeyboardEvent) => unknown) | null = null;
  disabled = false;
  checked: boolean | null = null;
  isLabel = false;
  section = "";
  submenu: Menu | null = null;

  constructor(readonly menu: Menu) {
    const doc = menu.doc;
    this.dom = el(doc, "div", "menu-item");
    this.dom.setAttribute("role", "menuitem");
    this.dom.tabIndex = -1;
    this.iconEl = el(doc, "div", "menu-item-icon");
    this.titleEl = el(doc, "div", "menu-item-title");
    this.checkIconEl = el(doc, "div", "menu-item-icon mod-checked");
    this.dom.append(this.iconEl, this.titleEl);
    this.dom.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.activate(e);
    });
    this.dom.addEventListener("mouseenter", () => menu.select(this));
  }

  setTitle(title: string | DocumentFragment): this {
    this.titleEl.replaceChildren(typeof title === "string" ? title : title.cloneNode(true));
    return this;
  }

  setIcon(icon: string | null): this {
    this.iconEl.replaceChildren();
    const svg = icon ? getIcon(icon) : null;
    if (svg) this.iconEl.appendChild(svg);
    return this;
  }

  setChecked(checked: boolean | null): this {
    this.checked = checked;
    this.dom.classList.toggle("mod-checked", checked === true);
    this.checkIconEl.replaceChildren();
    if (checked === true) {
      const svg = getIcon("check");
      if (svg) this.checkIconEl.appendChild(svg);
      if (!this.checkIconEl.isConnected) this.dom.appendChild(this.checkIconEl);
    } else this.checkIconEl.remove();
    this.dom.setAttribute("role", checked === null ? "menuitem" : "menuitemcheckbox");
    if (checked !== null) this.dom.setAttribute("aria-checked", String(checked));
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    this.dom.classList.toggle("is-disabled", disabled);
    this.dom.setAttribute("aria-disabled", String(disabled));
    return this;
  }

  setIsLabel(isLabel: boolean): this {
    this.isLabel = isLabel;
    this.dom.classList.toggle("is-label", isLabel);
    return this;
  }

  setWarning(warning: boolean): this {
    this.dom.classList.toggle("is-warning", warning);
    return this;
  }

  setSection(section: string): this {
    this.section = section;
    return this;
  }

  setActive(active: boolean): this {
    this.dom.classList.toggle("mod-active", active);
    return this;
  }

  onClick(callback: (evt: MouseEvent | KeyboardEvent) => unknown): this {
    this.callback = callback;
    return this;
  }

  setSubmenu(): Menu {
    if (!this.submenu) {
      this.submenu = new Menu(this.menu.doc);
      this.submenu.parent = this.menu;
      this.dom.classList.add("has-submenu");
      const chevron = el(this.menu.doc, "div", "menu-item-icon mod-submenu");
      const svg = getIcon("chevron-right");
      if (svg) chevron.appendChild(svg);
      this.dom.appendChild(chevron);
    }
    return this.submenu;
  }

  get selectable(): boolean {
    return !this.disabled && !this.isLabel;
  }

  activate(evt: MouseEvent | KeyboardEvent): void {
    if (!this.selectable) return;
    if (this.submenu) {
      this.menu.openSubmenu(this);
      return;
    }
    const cb = this.callback;
    // The chosen row stays filled for one fade length, then the menu fades out (Menu.retire).
    this.dom.classList.add("is-chosen");
    this.menu.closeAll(true);
    try {
      cb?.(evt);
    } catch (e) {
      console.error("[cortex-desktop] menu action failed", e);
    }
  }
}

/** Menus fade in and out over this long (desktop.css `.menu` uses the same 90 ms). */
export const MENU_FADE_MS = 90;
/** The chosen row holds its filled look this long before the menu fades (the recordings' short flash). */
export const MENU_FLASH_MS = 120;

let openMenu: Menu | null = null;

export class Menu extends Component {
  readonly dom: HTMLElement;
  readonly scrollEl: HTMLElement;
  readonly items: MenuItem[] = [];
  parent: Menu | null = null;
  private selected = -1;
  private hideCallbacks: (() => unknown)[] = [];
  private child: Menu | null = null;
  private readonly scope = new Scope();
  private cleanup: (() => void)[] = [];
  private shown = false;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly doc: Document = document) {
    super();
    this.dom = el(doc, "div", "menu cxd-menu");
    this.dom.setAttribute("role", "menu");
    this.scrollEl = el(doc, "div", "menu-scroll");
    this.dom.appendChild(this.scrollEl);
    this.dom.addEventListener("contextmenu", (e) => e.preventDefault());
    this.scope.register([], "ArrowDown", () => (this.move(1), false));
    this.scope.register([], "ArrowUp", () => (this.move(-1), false));
    this.scope.register([], "Enter", (e) => (this.items[this.selected]?.activate(e), false));
    this.scope.register([], " ", (e) => (this.items[this.selected]?.activate(e), false));
    this.scope.register([], "ArrowRight", () => {
      const it = this.items[this.selected];
      if (it?.submenu) this.openSubmenu(it, true);
      return false;
    });
    this.scope.register([], "ArrowLeft", () => {
      if (this.parent) this.hide();
      return false;
    });
    this.scope.register([], "Escape", () => (this.hide(), false));
    this.scope.register(null, "Tab", () => false);
  }

  setNoIcon(): this {
    this.dom.classList.add("mod-no-icon");
    return this;
  }

  setUseNativeMenu(_use: boolean): this {
    return this;
  }

  addItem(cb: (item: MenuItem) => unknown): this {
    const item = new MenuItem(this);
    this.items.push(item);
    this.scrollEl.appendChild(item.dom);
    cb(item);
    return this;
  }

  addSeparator(): this {
    const last = this.scrollEl.lastElementChild;
    if (last && !last.classList.contains("menu-separator")) this.scrollEl.appendChild(el(this.doc, "div", "menu-separator"));
    return this;
  }

  onHide(callback: () => unknown): void {
    this.hideCallbacks.push(callback);
  }

  select(item: MenuItem | null): void {
    const idx = item ? this.items.indexOf(item) : -1;
    this.items[this.selected]?.dom.classList.remove("selected");
    this.selected = item && item.selectable ? idx : -1;
    const now = this.items[this.selected];
    if (now) {
      now.dom.classList.add("selected");
      now.dom.focus({ preventScroll: true });
      now.dom.scrollIntoView({ block: "nearest" });
    }
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    if (now?.submenu) this.hoverTimer = setTimeout(() => this.openSubmenu(now), 150);
    else if (this.child && now) this.hoverTimer = setTimeout(() => this.child?.hide(), 150);
  }

  private move(dir: 1 | -1): void {
    const n = this.items.length;
    if (n === 0) return;
    let i = this.selected;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (this.items[i]?.selectable) {
        this.select(this.items[i] as MenuItem);
        return;
      }
    }
  }

  openSubmenu(item: MenuItem, focusFirst = false): void {
    const sub = item.submenu;
    if (!sub || this.child === sub) {
      if (focusFirst && sub) sub.move(1);
      return;
    }
    this.child?.hide();
    this.child = sub;
    const r = item.dom.getBoundingClientRect();
    sub.showAtPosition({ x: r.right - 2, y: r.top - 4, left: r.left + 2 }, this.doc);
    sub.onHide(() => {
      if (this.child === sub) this.child = null;
    });
    if (focusFirst) sub.move(1);
  }

  showAtMouseEvent(evt: MouseEvent): this {
    return this.showAtPosition({ x: evt.clientX, y: evt.clientY }, (evt.target as Node | null)?.ownerDocument ?? this.doc);
  }

  showAtPosition(position: { x: number; y: number; width?: number; overlap?: boolean; left?: number; right?: boolean }, doc?: Document): this {
    const d = doc ?? this.doc;
    if (!this.parent) {
      if (openMenu && openMenu !== this) openMenu.hide();
      openMenu = this;
    }
    // Drop a trailing separator (a group with nothing after it).
    const last = this.scrollEl.lastElementChild;
    if (last?.classList.contains("menu-separator")) last.remove();
    // When some rows carry an icon, the rows without one keep the icon's width so every title lines up.
    this.dom.classList.toggle("cxd-has-icons", this.items.some((i) => i.iconEl.childElementCount > 0));
    const host = layer();
    host.appendChild(this.dom);
    this.shown = true;
    this.load();
    pushScope(this.scope);
    const win = d.defaultView ?? window;
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    if (position.width) this.dom.style.minWidth = `${Math.round(position.width)}px`;
    const rect = this.dom.getBoundingClientRect();
    let x = position.x;
    let y = position.y;
    if (x + rect.width > vw - 4) x = position.left !== undefined ? position.left - rect.width : vw - rect.width - 4;
    if (y + rect.height > vh - 4) y = vh - rect.height - 4;
    this.dom.style.left = `${Math.max(4, Math.round(x))}px`;
    this.dom.style.top = `${Math.max(4, Math.round(y))}px`;
    if (!this.parent) {
      const outside = (e: Event): void => {
        const t = e.target as Node | null;
        let m: Menu | null = this;
        while (m) {
          if (t && m.dom.contains(t)) return;
          m = m.child;
        }
        this.hide();
      };
      const close = (): void => this.hide();
      d.addEventListener("pointerdown", outside, true);
      win.addEventListener("blur", close);
      win.addEventListener("resize", close);
      this.cleanup.push(() => {
        d.removeEventListener("pointerdown", outside, true);
        win.removeEventListener("blur", close);
        win.removeEventListener("resize", close);
      });
    }
    this.dom.focus({ preventScroll: true });
    return this;
  }

  /** Close this menu and every menu above it. */
  closeAll(chosen = false): void {
    let root: Menu = this;
    while (root.parent) root = root.parent;
    root.hide(chosen);
  }

  /**
   * Take the menu off screen. The menu is logically closed at once (keys, listeners, onHide); its element fades out
   * over MENU_FADE_MS and is removed on transitionend (a timer backs that up). After a choice the chosen row first
   * holds its filled look for one fade length. No animation under reduced motion or without matchMedia (tests).
   */
  private retire(flash: boolean): void {
    const dom = this.dom;
    const win = this.doc.defaultView;
    if (!dom.isConnected || !win || typeof win.matchMedia !== "function" || win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      dom.remove();
      return;
    }
    dom.classList.add("is-leaving");
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      dom.remove();
    };
    const fade = (): void => {
      dom.classList.add("is-closing");
      dom.addEventListener("transitionend", (e) => e.target === dom && finish());
      win.setTimeout(finish, MENU_FADE_MS + 80);
    };
    if (flash) win.setTimeout(fade, MENU_FLASH_MS);
    else fade();
  }

  hide(chosen = false): void {
    if (!this.shown) return;
    this.shown = false;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.child?.hide(chosen);
    this.child = null;
    for (const c of this.cleanup.splice(0)) c();
    popScope(this.scope);
    this.retire(chosen);
    if (openMenu === this) openMenu = null;
    this.unload();
    for (const cb of this.hideCallbacks.splice(0)) {
      try {
        cb();
      } catch (e) {
        console.error("[cortex-desktop] menu onHide failed", e);
      }
    }
  }

  close(): void {
    this.hide();
  }
}

// ───────────────────────────── Notice ─────────────────────────────

function noticeContainer(): HTMLElement {
  const host = layer();
  let c = host.querySelector<HTMLElement>(":scope > .notice-container");
  if (!c) {
    c = el(host.ownerDocument, "div", "notice-container");
    c.setAttribute("aria-live", "polite");
    host.appendChild(c);
  }
  return c;
}

export class Notice {
  readonly noticeEl: HTMLElement;
  readonly containerEl: HTMLElement;
  readonly messageEl: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(message: string | DocumentFragment, duration?: number) {
    const doc = layer().ownerDocument;
    this.containerEl = el(doc, "div", "notice-container-item");
    this.noticeEl = el(doc, "div", "notice");
    this.messageEl = el(doc, "div", "notice-message");
    this.noticeEl.appendChild(this.messageEl);
    this.containerEl.appendChild(this.noticeEl);
    this.setMessage(message);
    this.noticeEl.addEventListener("click", () => this.hide());
    noticeContainer().appendChild(this.containerEl);
    const ms = duration ?? 5000;
    if (ms > 0) this.timer = setTimeout(() => this.hide(), ms);
  }

  setMessage(message: string | DocumentFragment): this {
    this.messageEl.replaceChildren(typeof message === "string" ? message : message.cloneNode(true));
    return this;
  }

  hide(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.containerEl.remove();
  }
}

// ───────────────────────────── Modal ─────────────────────────────

export class Modal {
  readonly scope = new Scope();
  readonly containerEl: HTMLElement;
  readonly modalEl: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly contentEl: HTMLElement;
  readonly bgEl: HTMLElement;
  shouldRestoreSelection = true;
  private isOpen = false;
  private returnFocus: Element | null = null;

  constructor(readonly app: unknown) {
    const doc = layer().ownerDocument;
    this.containerEl = el(doc, "div", "modal-container mod-dim");
    this.bgEl = el(doc, "div", "modal-bg");
    this.modalEl = el(doc, "div", "modal");
    this.modalEl.setAttribute("role", "dialog");
    this.modalEl.setAttribute("aria-modal", "true");
    this.modalEl.tabIndex = -1;
    const close = el(doc, "div", "modal-close-button");
    close.setAttribute("role", "button");
    close.setAttribute("aria-label", "Close");
    const x = getIcon("x");
    if (x) close.appendChild(x);
    close.addEventListener("click", () => this.close());
    const header = el(doc, "div", "modal-header");
    this.titleEl = el(doc, "div", "modal-title");
    header.appendChild(this.titleEl);
    this.contentEl = el(doc, "div", "modal-content");
    this.modalEl.append(close, header, this.contentEl);
    this.containerEl.append(this.bgEl, this.modalEl);
    this.bgEl.addEventListener("click", () => this.close());
    this.scope.register([], "Escape", () => (this.close(), false));
  }

  setTitle(title: string): this {
    this.titleEl.textContent = title;
    return this;
  }

  setContent(content: string | DocumentFragment): this {
    this.contentEl.replaceChildren(typeof content === "string" ? content : content);
    return this;
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.returnFocus = this.containerEl.ownerDocument.activeElement;
    layer().appendChild(this.containerEl);
    pushScope(this.scope);
    this.onOpen();
    const first = this.modalEl.querySelector<HTMLElement>("input, textarea, select, button:not(.modal-close-button), [tabindex]:not([tabindex='-1'])");
    (first ?? this.modalEl).focus({ preventScroll: true });
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    popScope(this.scope);
    this.containerEl.remove();
    this.onClose();
    if (this.shouldRestoreSelection && this.returnFocus instanceof HTMLElement && this.returnFocus.isConnected) this.returnFocus.focus({ preventScroll: true });
  }

  onOpen(): void {}

  onClose(): void {}
}

// ───────────────────────────── suggestion prompts ─────────────────────────────

export interface Instruction {
  command: string;
  purpose: string;
}

export interface SearchMatches {
  score: number;
  matches: [number, number][];
}

export interface FuzzyMatch<T> {
  item: T;
  match: SearchMatches;
}

/** Obsidian's fuzzy search: every query character in order (spaces separate words), scored by closeness. */
export function prepareFuzzySearch(query: string): (text: string) => SearchMatches | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  return (text: string) => {
    if (q === "") return { score: 0, matches: [] };
    const t = text.toLowerCase();
    const matches: [number, number][] = [];
    let ti = 0;
    let score = 0;
    let prev = -2;
    for (const ch of q) {
      const at = t.indexOf(ch, ti);
      if (at === -1) return null;
      if (at === prev + 1 && matches.length > 0) (matches[matches.length - 1] as [number, number])[1] = at + 1;
      else matches.push([at, at + 1]);
      score -= at - ti;
      if (at === 0 || /[\s/_.-]/.test(t[at - 1] ?? "")) score += 2;
      prev = at;
      ti = at + 1;
    }
    return { score, matches };
  };
}

export abstract class SuggestModal<T> extends Modal {
  limit = 100;
  emptyStateText = "No results found.";
  readonly inputEl: HTMLInputElement;
  readonly resultContainerEl: HTMLElement;
  private readonly instructionsEl: HTMLElement;
  private values: T[] = [];
  private selectedIdx = 0;

  constructor(app: unknown) {
    super(app);
    const doc = this.modalEl.ownerDocument;
    this.modalEl.className = "prompt";
    this.modalEl.replaceChildren();
    const wrap = el(doc, "div", "prompt-input-container");
    this.inputEl = el(doc, "input", "prompt-input");
    this.inputEl.type = "text";
    this.inputEl.spellcheck = false;
    wrap.appendChild(this.inputEl);
    this.resultContainerEl = el(doc, "div", "prompt-results");
    this.instructionsEl = el(doc, "div", "prompt-instructions");
    this.modalEl.append(wrap, this.resultContainerEl, this.instructionsEl);
    this.inputEl.addEventListener("input", () => this.update());
    this.scope.register([], "ArrowDown", () => (this.moveSel(1), false));
    this.scope.register([], "ArrowUp", () => (this.moveSel(-1), false));
    this.scope.register([], "Enter", (e) => (this.choose(this.selectedIdx, e), false));
  }

  setPlaceholder(placeholder: string): void {
    this.inputEl.placeholder = placeholder;
  }

  setInstructions(instructions: Instruction[]): void {
    this.instructionsEl.replaceChildren(
      ...instructions.map((i) => {
        const d = el(this.modalEl.ownerDocument, "div", "prompt-instruction");
        d.append(el(this.modalEl.ownerDocument, "span", "prompt-instruction-command", i.command), el(this.modalEl.ownerDocument, "span", "", i.purpose));
        return d;
      }),
    );
  }

  override onOpen(): void {
    this.update();
  }

  abstract getSuggestions(query: string): T[] | Promise<T[]>;
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;

  private update(): void {
    void Promise.resolve(this.getSuggestions(this.inputEl.value)).then((list) => {
      this.values = list.slice(0, this.limit);
      this.selectedIdx = 0;
      const doc = this.modalEl.ownerDocument;
      this.resultContainerEl.replaceChildren();
      if (this.values.length === 0) {
        this.resultContainerEl.appendChild(el(doc, "div", "suggestion-empty", this.emptyStateText));
        return;
      }
      this.values.forEach((v, i) => {
        const row = el(doc, "div", `suggestion-item${i === 0 ? " is-selected" : ""}`);
        this.renderSuggestion(v, row);
        row.addEventListener("mousemove", () => this.setSel(i));
        row.addEventListener("click", (e) => this.choose(i, e));
        this.resultContainerEl.appendChild(row);
      });
    });
  }

  private setSel(i: number): void {
    const rows = this.resultContainerEl.querySelectorAll(".suggestion-item");
    rows[this.selectedIdx]?.classList.remove("is-selected");
    this.selectedIdx = i;
    rows[i]?.classList.add("is-selected");
    (rows[i] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }

  private moveSel(d: 1 | -1): void {
    const n = this.values.length;
    if (n > 0) this.setSel((this.selectedIdx + d + n) % n);
  }

  private choose(i: number, evt: MouseEvent | KeyboardEvent): void {
    const v = this.values[i];
    if (v === undefined) return;
    this.close();
    this.onChooseSuggestion(v, evt);
  }
}

export abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
  abstract getItems(): T[];
  abstract getItemText(item: T): string;
  abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;

  getSuggestions(query: string): FuzzyMatch<T>[] {
    const search = prepareFuzzySearch(query);
    const out: FuzzyMatch<T>[] = [];
    for (const item of this.getItems()) {
      const match = search(this.getItemText(item));
      if (match) out.push({ item, match });
    }
    return query.trim() === "" ? out : out.sort((a, b) => b.match.score - a.match.score);
  }

  renderSuggestion(value: FuzzyMatch<T>, row: HTMLElement): void {
    const text = this.getItemText(value.item);
    let at = 0;
    for (const [a, b] of value.match.matches) {
      if (a > at) row.appendChild(row.ownerDocument.createTextNode(text.slice(at, a)));
      row.appendChild(el(row.ownerDocument, "span", "suggestion-highlight", text.slice(a, b)));
      at = b;
    }
    if (at < text.length) row.appendChild(row.ownerDocument.createTextNode(text.slice(at)));
  }

  onChooseSuggestion(item: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent): void {
    this.onChooseItem(item.item, evt);
  }
}
