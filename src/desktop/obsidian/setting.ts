/**
 * Obsidian's settings API for Cortex Desktop: `Setting` rows with their controls (button, extra button, toggle,
 * text, text area, dropdown, slider), `PluginSettingTab`, and the Settings page that `app.setting.open()` /
 * `openTabById()` show over the window (one tab per plugin plus the desktop's own tab). Class names follow
 * Obsidian (`.setting-item`, `.checkbox-container`, `.vertical-tab-header`…) and desktop.css styles them.
 */
import { Scope } from "./component";
import { shimContext } from "./context";
import { getIcon, setIcon } from "./icons";
import { SETTINGS_COPY } from "../../ui/copy";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function setContent(target: HTMLElement, v: string | DocumentFragment): void {
  target.replaceChildren(typeof v === "string" ? v : v.cloneNode(true));
}

export class BaseComponent {
  disabled = false;
  then(cb: (component: this) => unknown): this {
    cb(this);
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
}

export class ButtonComponent extends BaseComponent {
  readonly buttonEl: HTMLButtonElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.buttonEl = el("button");
    this.buttonEl.type = "button";
    containerEl.appendChild(this.buttonEl);
  }
  setButtonText(name: string): this {
    this.buttonEl.textContent = name;
    return this;
  }
  setIcon(icon: string): this {
    setIcon(this.buttonEl, icon);
    return this;
  }
  setCta(): this {
    this.buttonEl.classList.add("mod-cta");
    return this;
  }
  removeCta(): this {
    this.buttonEl.classList.remove("mod-cta");
    return this;
  }
  setWarning(): this {
    this.buttonEl.classList.add("mod-warning");
    return this;
  }
  setTooltip(tooltip: string): this {
    this.buttonEl.setAttribute("aria-label", tooltip);
    this.buttonEl.title = tooltip;
    return this;
  }
  setClass(cls: string): this {
    this.buttonEl.classList.add(cls);
    return this;
  }
  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.buttonEl.disabled = disabled;
    return this;
  }
  onClick(callback: (evt: MouseEvent) => unknown): this {
    this.buttonEl.addEventListener("click", (e) => {
      if (!this.disabled) callback(e);
    });
    return this;
  }
}

export class ExtraButtonComponent extends BaseComponent {
  readonly extraSettingsEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.extraSettingsEl = el("div", "clickable-icon extra-setting-button");
    this.extraSettingsEl.setAttribute("role", "button");
    this.extraSettingsEl.tabIndex = 0;
    containerEl.appendChild(this.extraSettingsEl);
    setIcon(this.extraSettingsEl, "settings");
  }
  setIcon(icon: string): this {
    setIcon(this.extraSettingsEl, icon);
    return this;
  }
  setTooltip(tooltip: string): this {
    this.extraSettingsEl.setAttribute("aria-label", tooltip);
    this.extraSettingsEl.title = tooltip;
    return this;
  }
  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.extraSettingsEl.classList.toggle("is-disabled", disabled);
    return this;
  }
  onClick(callback: () => unknown): this {
    const run = (): void => {
      if (!this.disabled) callback();
    };
    this.extraSettingsEl.addEventListener("click", run);
    this.extraSettingsEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        run();
      }
    });
    return this;
  }
}

abstract class ValueComponent<T> extends BaseComponent {
  protected changeCb: ((value: T) => unknown) | null = null;
  abstract getValue(): T;
  abstract setValue(value: T): this;
  onChange(callback: (value: T) => unknown): this {
    this.changeCb = callback;
    return this;
  }
  protected changed(): void {
    try {
      void this.changeCb?.(this.getValue());
    } catch (e) {
      console.error("[cortex-desktop] setting change failed", e);
    }
  }
}

export class ToggleComponent extends ValueComponent<boolean> {
  readonly toggleEl: HTMLElement;
  private value = false;
  constructor(containerEl: HTMLElement) {
    super();
    this.toggleEl = el("div", "checkbox-container");
    this.toggleEl.setAttribute("role", "switch");
    this.toggleEl.tabIndex = 0;
    this.toggleEl.setAttribute("aria-checked", "false");
    containerEl.appendChild(this.toggleEl);
    const flip = (): void => {
      if (this.disabled) return;
      this.setValue(!this.value);
      this.changed();
    };
    this.toggleEl.addEventListener("click", flip);
    this.toggleEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        flip();
      }
    });
  }
  getValue(): boolean {
    return this.value;
  }
  setValue(on: boolean): this {
    this.value = on;
    this.toggleEl.classList.toggle("is-enabled", on);
    this.toggleEl.setAttribute("aria-checked", String(on));
    return this;
  }
  setTooltip(tooltip: string): this {
    this.toggleEl.title = tooltip;
    return this;
  }
  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.toggleEl.classList.toggle("is-disabled", disabled);
    return this;
  }
  onClick(): this {
    return this;
  }
}

export class TextComponent extends ValueComponent<string> {
  readonly inputEl: HTMLInputElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.inputEl = el("input");
    this.inputEl.type = "text";
    this.inputEl.spellcheck = false;
    containerEl.appendChild(this.inputEl);
    this.inputEl.addEventListener("input", () => this.changed());
  }
  getValue(): string {
    return this.inputEl.value;
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }
  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.inputEl.disabled = disabled;
    return this;
  }
  onChanged(): void {
    this.changed();
  }
}

export class SearchComponent extends TextComponent {
  constructor(containerEl: HTMLElement) {
    super(containerEl);
    this.inputEl.type = "search";
  }
}

export class TextAreaComponent extends ValueComponent<string> {
  readonly inputEl: HTMLTextAreaElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.inputEl = el("textarea");
    this.inputEl.spellcheck = false;
    containerEl.appendChild(this.inputEl);
    this.inputEl.addEventListener("input", () => this.changed());
  }
  getValue(): string {
    return this.inputEl.value;
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }
  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.inputEl.disabled = disabled;
    return this;
  }
}

export class DropdownComponent extends ValueComponent<string> {
  readonly selectEl: HTMLSelectElement;
  constructor(containerEl: HTMLElement) {
    super();
    this.selectEl = el("select", "dropdown");
    containerEl.appendChild(this.selectEl);
    this.selectEl.addEventListener("change", () => this.changed());
  }
  addOption(value: string, display: string): this {
    const o = el("option", undefined, display);
    o.value = value;
    this.selectEl.appendChild(o);
    return this;
  }
  addOptions(options: Record<string, string>): this {
    for (const [v, d] of Object.entries(options)) this.addOption(v, d);
    return this;
  }
  getValue(): string {
    return this.selectEl.value;
  }
  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }
  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.selectEl.disabled = disabled;
    return this;
  }
}

export class SliderComponent extends ValueComponent<number> {
  readonly sliderEl: HTMLInputElement;
  private dynamicTooltip = false;
  constructor(containerEl: HTMLElement) {
    super();
    this.sliderEl = el("input", "slider");
    this.sliderEl.type = "range";
    containerEl.appendChild(this.sliderEl);
    this.sliderEl.addEventListener("input", () => {
      if (this.dynamicTooltip) this.sliderEl.title = this.sliderEl.value;
      this.changed();
    });
  }
  setLimits(min: number | null, max: number | null, step: number | "any"): this {
    if (min !== null) this.sliderEl.min = String(min);
    if (max !== null) this.sliderEl.max = String(max);
    this.sliderEl.step = String(step);
    return this;
  }
  getValue(): number {
    return Number(this.sliderEl.value);
  }
  setValue(value: number): this {
    this.sliderEl.value = String(value);
    if (this.dynamicTooltip) this.sliderEl.title = String(value);
    return this;
  }
  setDynamicTooltip(): this {
    this.dynamicTooltip = true;
    this.sliderEl.title = this.sliderEl.value;
    return this;
  }
  showTooltip(): void {}
  setInstant(_instant: boolean): this {
    return this;
  }
  override setDisabled(disabled: boolean): this {
    super.setDisabled(disabled);
    this.sliderEl.disabled = disabled;
    return this;
  }
}

export class Setting {
  readonly settingEl: HTMLElement;
  readonly infoEl: HTMLElement;
  readonly nameEl: HTMLElement;
  readonly descEl: HTMLElement;
  readonly controlEl: HTMLElement;
  readonly components: BaseComponent[] = [];

  constructor(containerEl: HTMLElement) {
    this.settingEl = el("div", "setting-item");
    this.infoEl = el("div", "setting-item-info");
    this.nameEl = el("div", "setting-item-name");
    this.descEl = el("div", "setting-item-description");
    this.controlEl = el("div", "setting-item-control");
    this.infoEl.append(this.nameEl, this.descEl);
    this.settingEl.append(this.infoEl, this.controlEl);
    containerEl.appendChild(this.settingEl);
  }

  setName(name: string | DocumentFragment): this {
    setContent(this.nameEl, name);
    return this;
  }
  setDesc(desc: string | DocumentFragment): this {
    setContent(this.descEl, desc);
    return this;
  }
  setClass(cls: string): this {
    this.settingEl.classList.add(cls);
    return this;
  }
  setTooltip(tooltip: string): this {
    this.nameEl.title = tooltip;
    return this;
  }
  setHeading(): this {
    this.settingEl.classList.add("setting-item-heading");
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.settingEl.classList.toggle("is-disabled", disabled);
    for (const c of this.components) c.setDisabled(disabled);
    return this;
  }
  private add<C extends BaseComponent>(c: C, cb: (c: C) => unknown): this {
    this.components.push(c);
    cb(c);
    return this;
  }
  addButton(cb: (component: ButtonComponent) => unknown): this {
    return this.add(new ButtonComponent(this.controlEl), cb);
  }
  addExtraButton(cb: (component: ExtraButtonComponent) => unknown): this {
    return this.add(new ExtraButtonComponent(this.controlEl), cb);
  }
  addToggle(cb: (component: ToggleComponent) => unknown): this {
    return this.add(new ToggleComponent(this.controlEl), cb);
  }
  addText(cb: (component: TextComponent) => unknown): this {
    return this.add(new TextComponent(this.controlEl), cb);
  }
  addSearch(cb: (component: SearchComponent) => unknown): this {
    return this.add(new SearchComponent(this.controlEl), cb);
  }
  addTextArea(cb: (component: TextAreaComponent) => unknown): this {
    return this.add(new TextAreaComponent(this.controlEl), cb);
  }
  addDropdown(cb: (component: DropdownComponent) => unknown): this {
    return this.add(new DropdownComponent(this.controlEl), cb);
  }
  addSlider(cb: (component: SliderComponent) => unknown): this {
    return this.add(new SliderComponent(this.controlEl), cb);
  }
  then(cb: (setting: this) => unknown): this {
    cb(this);
    return this;
  }
  clear(): this {
    this.controlEl.replaceChildren();
    this.components.length = 0;
    return this;
  }
}

/** A plugin's tab on the Settings page. */
export abstract class PluginSettingTab {
  readonly containerEl: HTMLElement;
  constructor(
    readonly app: unknown,
    readonly plugin: { manifest: { id: string; name: string } },
  ) {
    this.containerEl = el("div", "vertical-tab-content");
  }
  abstract display(): void;
  hide(): void {
    this.containerEl.replaceChildren();
  }
}

/** One entry of the Settings page's tab list. */
export interface SettingsPageTab {
  id: string;
  name: string;
  containerEl: HTMLElement;
  display(): void;
  hide(): void;
}

/** `app.setting`: the Settings page over the window (Esc or the close button returns to Cortex). */
export class SettingsPage {
  private readonly tabs: SettingsPageTab[] = [];
  private readonly scope = new Scope();
  private root: HTMLElement | null = null;
  private current: SettingsPageTab | null = null;
  private returnFocus: Element | null = null;
  /** Cortex's own Settings window: the Cortex tab draws its own header, six tabs and long list (settingsTab.ts); this page only frames it. */
  readonly branded = true;
  /** The Cortex tab's id (the plugin's manifest id). */
  private static readonly OWN_TAB = "cortex";

  constructor() {
    this.scope.register([], "Escape", () => (this.close(), false));
  }

  /** The tabs other than Cortex's own (the desktop's folder and settings-file rows), shown at the end of "All settings". */
  extraTabs(): SettingsPageTab[] {
    return this.tabs.filter((t) => t.id !== SettingsPage.OWN_TAB);
  }

  private get framed(): boolean {
    return this.branded && this.tabs.some((t) => t.id === SettingsPage.OWN_TAB);
  }

  addSettingTab(tab: PluginSettingTab): void {
    const id = tab.plugin.manifest.id;
    this.removeTab(id);
    this.tabs.unshift({ id, name: tab.plugin.manifest.name, containerEl: tab.containerEl, display: () => tab.display(), hide: () => tab.hide() });
  }

  addTab(tab: SettingsPageTab): void {
    this.removeTab(tab.id);
    this.tabs.push(tab);
  }

  removeTab(id: string): void {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i >= 0) this.tabs.splice(i, 1);
  }

  get isOpen(): boolean {
    return this.root !== null;
  }

  open(): void {
    if (this.root) return;
    this.returnFocus = document.activeElement;
    const framed = this.framed;
    const container = el("div", `modal-container mod-dim mod-settings cxd-settings${framed ? " cxd-cortex-win" : ""}`);
    const bg = el("div", "modal-bg");
    bg.addEventListener("click", () => this.close());
    const modal = el("div", `modal mod-settings${framed ? " cxd-win-modal" : ""}`);
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", framed ? SETTINGS_COPY.window.label : "Settings");
    if (framed) {
      modal.append(el("div", "vertical-tab-content-container cxd-win-pane"));
    } else {
      const close = el("div", "modal-close-button");
      close.setAttribute("role", "button");
      close.setAttribute("aria-label", "Close");
      const x = getIcon("x");
      if (x) close.appendChild(x);
      close.addEventListener("click", () => this.close());
      const body = el("div", "vertical-tabs-container");
      const nav = el("div", "vertical-tab-header");
      const pane = el("div", "vertical-tab-content-container");
      body.append(nav, pane);
      modal.append(close, body);
    }
    container.append(bg, modal);
    (shimContext()?.layer() ?? document.body).appendChild(container);
    shimContext()?.keymap.pushScope(this.scope);
    this.root = container;
    this.renderNav();
    this.show(framed ? SettingsPage.OWN_TAB : (this.current?.id ?? this.tabs[0]?.id ?? ""));
  }

  private renderNav(): void {
    const nav = this.root?.querySelector(".vertical-tab-header");
    if (!nav) return;
    nav.replaceChildren(el("div", "vertical-tab-header-group-title", "Settings"));
    for (const t of this.tabs) {
      const item = el("div", `vertical-tab-nav-item${this.current?.id === t.id ? " is-active" : ""}`, t.name);
      item.setAttribute("role", "tab");
      item.tabIndex = 0;
      item.dataset.tab = t.id;
      item.addEventListener("click", () => this.show(t.id));
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.show(t.id);
        }
      });
      nav.appendChild(item);
    }
  }

  private show(wanted: string): void {
    const id = this.framed ? SettingsPage.OWN_TAB : wanted;
    const tab = this.tabs.find((t) => t.id === id);
    const pane = this.root?.querySelector(".vertical-tab-content-container");
    if (!tab || !pane) return;
    if (this.current && this.current !== tab) this.current.hide();
    this.current = tab;
    pane.replaceChildren(tab.containerEl);
    tab.display();
    this.root?.querySelectorAll(".vertical-tab-nav-item").forEach((n) => n.classList.toggle("is-active", (n as HTMLElement).dataset.tab === id));
  }

  openTabById(id: string): void {
    if (!this.root) this.open();
    this.show(id);
  }

  close(): void {
    if (!this.root) return;
    this.current?.hide();
    shimContext()?.keymap.popScope(this.scope);
    this.root.remove();
    this.root = null;
    if (this.returnFocus instanceof HTMLElement && this.returnFocus.isConnected) this.returnFocus.focus({ preventScroll: true });
  }
}
