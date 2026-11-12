/**
 * Minimal runtime stand-in for the "obsidian" module in unit tests (the npm package ships types only).
 * Implements just what Cortex's eager code, modals and settings tab touch. Not a simulation of Obsidian.
 */
/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-explicit-any */

type ElOptions = { cls?: string | string[]; text?: string; attr?: Record<string, string> } | string;

export class FakeEl {
  classes = new Set<string>();
  text = "";
  tag: string;
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  listeners = new Map<string, (() => void)[]>();
  isConnected = true;
  win: any = globalThis;
  doc: any = undefined;
  constructor(tag = "div") {
    this.tag = tag;
  }
  empty(): void {
    this.children = [];
    this.text = "";
  }
  addClass(...cs: string[]): void {
    for (const c of cs) this.classes.add(c);
  }
  removeClass(...cs: string[]): void {
    for (const c of cs) this.classes.delete(c);
  }
  toggleClass(c: string, on: boolean): void {
    if (on) this.classes.add(c);
    else this.classes.delete(c);
  }
  setText(t: string): void {
    this.text = t;
  }
  setAttr(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  createEl(tag: string, o?: ElOptions): FakeEl {
    const el = new FakeEl(tag);
    if (typeof o === "string") el.addClass(o);
    else if (o) {
      if (o.cls) el.addClass(...(Array.isArray(o.cls) ? o.cls : o.cls.split(" ")));
      if (o.text) el.text = o.text;
      for (const [k, v] of Object.entries(o.attr ?? {})) el.attrs.set(k, v);
    }
    this.children.push(el);
    return el;
  }
  createDiv(o?: ElOptions): FakeEl {
    return this.createEl("div", o);
  }
  createSpan(o?: ElOptions): FakeEl {
    return this.createEl("span", o);
  }
  querySelector(_sel: string): FakeEl | null {
    return null;
  }
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  addEventListener(type: string, cb: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  click(): void {
    for (const cb of this.listeners.get("click") ?? []) cb();
  }
  /** All descendant texts, depth first (for assertions). */
  allText(): string[] {
    return [this.text, ...this.children.flatMap((c) => c.allText())].filter((x) => x.length > 0);
  }
}

export const apiVersion = "1.8.0";
export const registeredIcons = new Map<string, string>();
export function addIcon(id: string, svg: string): void {
  registeredIcons.set(id, svg);
}

export function setIcon(el: { setAttr?(k: string, v: string): void; dataset?: Record<string, string> }, icon: string): void {
  el.setAttr?.("data-icon", icon);
}

export class Notice {
  static last = "";
  static all: string[] = [];
  constructor(message: string) {
    Notice.last = message;
    Notice.all.push(message);
  }
}

export class FileSystemAdapter {
  constructor(private readonly base: string) {}
  getBasePath(): string {
    return this.base;
  }
  getResourcePath(p: string): string {
    return `app://local/${p}`;
  }
}

export interface FakeCommand {
  id: string;
  name: string;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
}

type ScopeKey = { key: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean };

export class Scope {
  keys: { mods: string[] | null; key: string | null; cb?: (evt: ScopeKey, ctx: unknown) => unknown }[] = [];
  constructor(public parent?: unknown) {}
  register(mods: string[] | null, key: string | null, cb?: (evt: ScopeKey, ctx: unknown) => unknown): unknown {
    const h = { mods, key, cb };
    this.keys.push(h);
    return h;
  }
  unregister(h: unknown): void {
    const i = this.keys.indexOf(h as Scope["keys"][number]);
    if (i >= 0) this.keys.splice(i, 1);
  }
  /**
   * What a keymap does with a key on this scope (Obsidian's rule, as Cortex Desktop's shim has it): the first handler
   * that matches and returns false has handled it, else the parent is asked. Null modifiers or key match anything; "Mod"
   * is Ctrl or Cmd.
   */
  handleKey(evt: ScopeKey): boolean {
    for (const h of [...this.keys]) {
      if (h.key !== null && h.key.toLowerCase() !== evt.key.toLowerCase()) continue;
      const want = new Set(h.mods ?? []);
      if (h.mods !== null && (want.has("Mod") !== !!(evt.ctrlKey || evt.metaKey) || want.has("Shift") !== !!evt.shiftKey || want.has("Alt") !== !!evt.altKey)) continue;
      if (h.cb?.(evt, { modifiers: null, key: evt.key, vkey: "" }) === false) return true;
    }
    return (this.parent as Scope | undefined)?.handleKey?.(evt) ?? false;
  }
}

export class Menu {
  static last: Menu | null = null;
  items: { title: string; checked?: boolean; section?: string; onClick?: () => void }[] = [];
  constructor() {
    Menu.last = this;
  }
  addItem(cb: (item: any) => unknown): this {
    const it: { title: string; checked?: boolean; section?: string; onClick?: () => void } = { title: "" };
    const api = {
      setTitle: (t: string) => ((it.title = t), api),
      setIcon: () => api,
      setChecked: (c: boolean) => ((it.checked = c), api),
      setSection: (s: string) => ((it.section = s), api),
      setIsLabel: () => api,
      setDisabled: () => api,
      onClick: (f: () => void) => ((it.onClick = f), api),
    };
    cb(api);
    this.items.push(it);
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtMouseEvent(_e: unknown): this {
    return this;
  }
  showAtPosition(_p: unknown): this {
    return this;
  }
}

export function fakeApp(): any {
  const storage = new Map<string, unknown>();
  const handlers = new Map<string, ((...a: unknown[]) => void)[]>();
  return {
    workspace: {
      layoutReady: false,
      onLayoutReady(cb: () => void) {
        cb();
      },
      on(name: string, cb: (...a: unknown[]) => void) {
        handlers.set(name, [...(handlers.get(name) ?? []), cb]);
        return { name };
      },
      trigger(name: string, ...a: unknown[]) {
        for (const h of handlers.get(name) ?? []) h(...a);
      },
      getLeavesOfType: () => [],
      getActiveViewOfType: () => null,
      revealLeaf: async () => undefined,
      getLeaf: () => ({ setViewState: async () => undefined }),
      handlers,
    },
    vault: { adapter: new FileSystemAdapter("C:/vault"), getName: () => "vault" },
    loadLocalStorage: (k: string) => storage.get(k) ?? null,
    saveLocalStorage: (k: string, v: unknown) => void storage.set(k, v),
  };
}

export class Plugin {
  commands: FakeCommand[] = [];
  views = new Map<string, unknown>();
  ribbons: { icon: string; title: string }[] = [];
  settingTabs: unknown[] = [];
  statusItems: FakeEl[] = [];
  protocolHandlers = new Map<string, (p: Record<string, string>) => void>();
  hoverSources = new Map<string, unknown>();
  events: unknown[] = [];
  cleanups: (() => void)[] = [];
  data: unknown = null;
  constructor(public app: any, public manifest: { id: string; version: string; dir?: string }) {}
  addCommand(c: FakeCommand): FakeCommand {
    this.commands.push(c);
    return c;
  }
  registerView(type: string, factory: unknown): void {
    this.views.set(type, factory);
  }
  addRibbonIcon(icon: string, title: string, _cb: unknown): FakeEl {
    this.ribbons.push({ icon, title });
    return new FakeEl();
  }
  addSettingTab(tab: unknown): void {
    this.settingTabs.push(tab);
  }
  addStatusBarItem(): FakeEl {
    const el = new FakeEl();
    this.statusItems.push(el);
    return el;
  }
  registerObsidianProtocolHandler(action: string, h: (p: Record<string, string>) => void): void {
    this.protocolHandlers.set(action, h);
  }
  registerHoverLinkSource(id: string, info: unknown): void {
    this.hoverSources.set(id, info);
  }
  registerEvent(e: unknown): void {
    this.events.push(e);
  }
  domEvents: { target: unknown; type: string; cb: unknown }[] = [];
  registerDomEvent(target: unknown, type: string, cb: unknown, _opts?: unknown): void {
    this.domEvents.push({ target, type, cb });
  }
  register(cb: () => void): void {
    this.cleanups.push(cb);
  }
  async loadData(): Promise<unknown> {
    return this.data;
  }
  async saveData(d: unknown): Promise<void> {
    this.data = JSON.parse(JSON.stringify(d));
  }
}

export class ItemView {
  contentEl = new FakeEl();
  containerEl = new FakeEl();
  scope: Scope | null = null;
  app: any;
  constructor(public leaf: any) {
    this.app = leaf?.app ?? fakeApp();
  }
  getState(): Record<string, unknown> {
    return {};
  }
  async setState(_s: unknown, _r: unknown): Promise<void> {}
}

export class Modal {
  titleEl = new FakeEl();
  contentEl = new FakeEl();
  modalEl = new FakeEl();
  opened = false;
  constructor(public app: unknown) {}
  open(): void {
    this.opened = true;
    (this as unknown as { onOpen?: () => void }).onOpen?.();
  }
  close(): void {
    this.opened = false;
    (this as unknown as { onClose?: () => void }).onClose?.();
  }
}

export class PluginSettingTab {
  containerEl = new FakeEl();
  constructor(public app: unknown, public plugin: unknown) {}
}

class FakeToggle {
  value = false;
  onChangeCb: ((v: boolean) => unknown) | null = null;
  setValue(v: boolean): this {
    this.value = v;
    return this;
  }
  setDisabled(_d: boolean): this {
    return this;
  }
  onChange(cb: (v: boolean) => unknown): this {
    this.onChangeCb = cb;
    return this;
  }
}

class FakeText {
  value = "";
  setValue(v: string): this {
    this.value = v;
    return this;
  }
  setPlaceholder(_p: string): this {
    return this;
  }
  onChange(_cb: (v: string) => unknown): this {
    return this;
  }
}

class FakeDropdown {
  options = new Map<string, string>();
  value = "";
  addOption(v: string, label: string): this {
    this.options.set(v, label);
    return this;
  }
  addOptions(o: Record<string, string>): this {
    for (const [k, v] of Object.entries(o)) this.options.set(k, v);
    return this;
  }
  setValue(v: string): this {
    this.value = v;
    return this;
  }
  setDisabled(_d: boolean): this {
    return this;
  }
  onChange(_cb: (v: string) => unknown): this {
    return this;
  }
}

class FakeSlider {
  value = 0;
  setLimits(_a: number, _b: number, _s: number | "any"): this {
    return this;
  }
  setValue(v: number): this {
    this.value = v;
    return this;
  }
  setDynamicTooltip(): this {
    return this;
  }
  onChange(_cb: (v: number) => unknown): this {
    return this;
  }
}

class FakeButton {
  text = "";
  setButtonText(t: string): this {
    this.text = t;
    return this;
  }
  setCta(): this {
    return this;
  }
  setWarning(): this {
    return this;
  }
  setDisabled(_d: boolean): this {
    return this;
  }
  onClickCb: (() => unknown) | null = null;
  onClick(cb: () => unknown): this {
    this.onClickCb = cb;
    return this;
  }
}

export class Setting {
  static created: Setting[] = [];
  name = "";
  desc = "";
  heading = false;
  /** The controls added to this row, so tests can drive them. */
  toggles: FakeToggle[] = [];
  buttons: FakeButton[] = [];
  /** The row's control area (rows that put their own elements in it). */
  controlEl = new FakeEl();
  /** The row's description area (rows that draw a meter in it). */
  descEl = new FakeEl();
  constructor(public containerEl: FakeEl) {
    Setting.created.push(this);
  }
  setName(n: string): this {
    this.name = n;
    return this;
  }
  setDesc(d: string): this {
    this.desc = d;
    return this;
  }
  setHeading(): this {
    this.heading = true;
    return this;
  }
  setDisabled(_d: boolean): this {
    return this;
  }
  addToggle(cb: (t: FakeToggle) => unknown): this {
    const t = new FakeToggle();
    this.toggles.push(t);
    cb(t);
    return this;
  }
  addText(cb: (t: FakeText) => unknown): this {
    cb(new FakeText());
    return this;
  }
  addTextArea(cb: (t: FakeText) => unknown): this {
    cb(new FakeText());
    return this;
  }
  addDropdown(cb: (d: FakeDropdown) => unknown): this {
    cb(new FakeDropdown());
    return this;
  }
  addSlider(cb: (s: FakeSlider) => unknown): this {
    cb(new FakeSlider());
    return this;
  }
  addButton(cb: (b: FakeButton) => unknown): this {
    const b = new FakeButton();
    this.buttons.push(b);
    cb(b);
    return this;
  }
  addExtraButton(cb: (b: FakeButton) => unknown): this {
    cb(new FakeButton());
    return this;
  }
}

export const MarkdownRenderer = { render: async () => undefined };

export type App = any;
export type WorkspaceLeaf = any;
export type TFile = { path: string };
export type ViewStateResult = { history: boolean };
