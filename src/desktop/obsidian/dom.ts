/**
 * Obsidian's DOM helpers (`el.createDiv()`, `el.empty()`, `el.setText()`, `el.addClass()`, `el.win`, the global
 * `createEl`, …) installed on the prototypes, so Cortex code written against Obsidian runs unchanged. Only the
 * helpers Obsidian documents in its API are added; each one does what Obsidian's does.
 */

export interface DomElementInfo {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  parent?: Node;
  value?: string;
  type?: string;
  prepend?: boolean;
  placeholder?: string;
  href?: string;
}

type Info = DomElementInfo | string | undefined;
type Callback = ((el: Element) => void) | undefined;

const SVG_NS = "http://www.w3.org/2000/svg";

function classesOf(cls: string | string[]): string[] {
  return (Array.isArray(cls) ? cls : cls.split(" ")).map((c) => c.trim()).filter(Boolean);
}

function setAttrOn(el: Element, name: string, value: string | number | boolean | null | undefined): void {
  if (value === null || value === undefined) el.removeAttribute(name);
  else el.setAttribute(name, String(value));
}

function applyInfo(el: Element, o: Info): void {
  if (o === undefined) return;
  const info: DomElementInfo = typeof o === "string" ? { cls: o } : o;
  if (info.cls) el.classList.add(...classesOf(info.cls));
  if (info.text !== undefined) {
    if (typeof info.text === "string") el.textContent = info.text;
    else el.appendChild(info.text);
  }
  if (info.attr) for (const [k, v] of Object.entries(info.attr)) setAttrOn(el, k, v);
  if (info.title !== undefined) setAttrOn(el, "title", info.title);
  if (info.value !== undefined && "value" in el) (el as HTMLInputElement).value = info.value;
  if (info.type !== undefined) setAttrOn(el, "type", info.type);
  if (info.placeholder !== undefined) setAttrOn(el, "placeholder", info.placeholder);
  if (info.href !== undefined) setAttrOn(el, "href", info.href);
}

function place(parent: Node | null, el: Element, o: Info): void {
  const info = typeof o === "object" ? o : undefined;
  const target = info?.parent ?? parent;
  if (!target) return;
  if (info?.prepend) target.insertBefore(el, target.firstChild);
  else target.appendChild(el);
}

function docOf(node: Node | null): Document {
  if (!node) return document;
  if (node.nodeType === 9) return node as Document;
  return node.ownerDocument ?? document;
}

function make(parent: Node | null, tag: string, o: Info, cb: Callback, svg = false): Element {
  const doc = docOf(parent);
  const el = svg ? doc.createElementNS(SVG_NS, tag) : doc.createElement(tag);
  applyInfo(el, o);
  place(parent, el, o);
  cb?.(el);
  return el;
}

function define(proto: object, name: string, value: unknown): void {
  Object.defineProperty(proto, name, { value, configurable: true, writable: true, enumerable: false });
}

function getter(proto: object, name: string, get: (this: Node) => unknown): void {
  Object.defineProperty(proto, name, { get, configurable: true, enumerable: false });
}

let installed = false;

/** Install the helpers once per window (pop-out windows would call it with their own globals). */
export function installDomHelpers(win: Window & typeof globalThis = window): void {
  if (installed && win === window) return;
  if (win === window) installed = true;
  const { Node: N, Element: E, HTMLElement: H, DocumentFragment: F } = win;

  // ── Node ──
  define(N.prototype, "empty", function (this: Node) {
    while (this.firstChild) this.removeChild(this.firstChild);
  });
  define(N.prototype, "detach", function (this: Node) {
    this.parentNode?.removeChild(this);
  });
  define(N.prototype, "insertAfter", function (this: Node, node: Node, child: Node | null) {
    return this.insertBefore(node, child ? child.nextSibling : this.firstChild);
  });
  define(N.prototype, "indexOf", function (this: Node, other: Node) {
    return Array.prototype.indexOf.call(this.childNodes, other);
  });
  define(N.prototype, "setChildrenInPlace", function (this: Node, children: Node[]) {
    const keep = new Set(children);
    for (const c of Array.from(this.childNodes)) if (!keep.has(c)) this.removeChild(c);
    let at: ChildNode | null = this.firstChild;
    for (const c of children) {
      if (c === at) at = at.nextSibling;
      else this.insertBefore(c, at);
    }
  });
  define(N.prototype, "appendText", function (this: Node, val: string) {
    this.appendChild(docOf(this).createTextNode(val));
  });
  define(N.prototype, "instanceOf", function (this: Node, type: new () => unknown) {
    return this instanceof type;
  });
  define(N.prototype, "createEl", function (this: Node, tag: string, o?: Info, cb?: Callback) {
    return make(this, tag, o, cb);
  });
  define(N.prototype, "createDiv", function (this: Node, o?: Info, cb?: Callback) {
    return make(this, "div", o, cb);
  });
  define(N.prototype, "createSpan", function (this: Node, o?: Info, cb?: Callback) {
    return make(this, "span", o, cb);
  });
  define(N.prototype, "createSvg", function (this: Node, tag: string, o?: Info, cb?: Callback) {
    return make(this, tag, o, cb, true);
  });
  getter(N.prototype, "doc", function (this: Node) {
    return docOf(this);
  });
  getter(N.prototype, "win", function (this: Node) {
    return docOf(this).defaultView ?? window;
  });
  getter(N.prototype, "constructorWin", function (this: Node) {
    return docOf(this).defaultView ?? window;
  });

  // ── Element ──
  define(E.prototype, "getText", function (this: Element) {
    return this.textContent ?? "";
  });
  define(E.prototype, "setText", function (this: Element, val: string | DocumentFragment) {
    if (typeof val === "string") this.textContent = val;
    else {
      while (this.firstChild) this.removeChild(this.firstChild);
      this.appendChild(val);
    }
  });
  define(E.prototype, "addClass", function (this: Element, ...cls: string[]) {
    this.classList.add(...cls.flatMap(classesOf));
  });
  define(E.prototype, "addClasses", function (this: Element, cls: string[]) {
    this.classList.add(...cls.flatMap(classesOf));
  });
  define(E.prototype, "removeClass", function (this: Element, ...cls: string[]) {
    this.classList.remove(...cls.flatMap(classesOf));
  });
  define(E.prototype, "removeClasses", function (this: Element, cls: string[]) {
    this.classList.remove(...cls.flatMap(classesOf));
  });
  define(E.prototype, "toggleClass", function (this: Element, cls: string | string[], value: boolean) {
    for (const c of classesOf(cls)) this.classList.toggle(c, value);
  });
  define(E.prototype, "hasClass", function (this: Element, cls: string) {
    return this.classList.contains(cls);
  });
  define(E.prototype, "setAttr", function (this: Element, name: string, value: string | number | boolean | null) {
    setAttrOn(this, name, value);
  });
  define(E.prototype, "setAttrs", function (this: Element, obj: Record<string, string | number | boolean | null>) {
    for (const [k, v] of Object.entries(obj)) setAttrOn(this, k, v);
  });
  define(E.prototype, "getAttr", function (this: Element, name: string) {
    return this.getAttribute(name);
  });
  define(E.prototype, "matchParent", function (this: Element, selector: string, lastParent?: Element) {
    for (let el: Element | null = this; el && el !== lastParent; el = el.parentElement) if (el.matches(selector)) return el;
    return null;
  });
  define(E.prototype, "getCssPropertyValue", function (this: Element, property: string, pseudo?: string) {
    return (docOf(this).defaultView ?? window).getComputedStyle(this, pseudo).getPropertyValue(property);
  });
  define(E.prototype, "isActiveElement", function (this: Element) {
    return docOf(this).activeElement === this;
  });
  define(E.prototype, "find", function (this: Element, selector: string) {
    return this.querySelector(selector);
  });
  define(E.prototype, "findAll", function (this: Element, selector: string) {
    return Array.from(this.querySelectorAll(selector));
  });
  define(E.prototype, "findAllSelf", function (this: Element, selector: string) {
    const all = Array.from(this.querySelectorAll(selector));
    return this.matches(selector) ? [this, ...all] : all;
  });

  // ── HTMLElement ──
  define(H.prototype, "show", function (this: HTMLElement) {
    this.style.removeProperty("display");
  });
  define(H.prototype, "hide", function (this: HTMLElement) {
    this.style.display = "none";
  });
  define(H.prototype, "toggle", function (this: HTMLElement, show: boolean) {
    if (show) this.style.removeProperty("display");
    else this.style.display = "none";
  });
  define(H.prototype, "toggleVisibility", function (this: HTMLElement, visible: boolean) {
    this.style.visibility = visible ? "" : "hidden";
  });
  define(H.prototype, "isShown", function (this: HTMLElement) {
    if (!this.isConnected) return false;
    if (this.offsetParent !== null) return true;
    const view = docOf(this).defaultView;
    return view ? view.getComputedStyle(this).position === "fixed" && view.getComputedStyle(this).display !== "none" : false;
  });
  define(H.prototype, "setCssStyles", function (this: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
    Object.assign(this.style, styles);
  });
  define(H.prototype, "setCssProps", function (this: HTMLElement, props: Record<string, string>) {
    for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
  });
  getter(H.prototype, "innerWidth", function (this: Node) {
    const el = this as HTMLElement;
    const cs = (docOf(el).defaultView ?? window).getComputedStyle(el);
    return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  });
  getter(H.prototype, "innerHeight", function (this: Node) {
    const el = this as HTMLElement;
    const cs = (docOf(el).defaultView ?? window).getComputedStyle(el);
    return el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  });
  define(H.prototype, "onClickEvent", function (this: HTMLElement, listener: (ev: MouseEvent) => unknown, options?: AddEventListenerOptions) {
    this.addEventListener("click", listener, options);
    this.addEventListener("auxclick", listener, options);
  });
  define(H.prototype, "trigger", function (this: HTMLElement, eventType: string) {
    this.dispatchEvent(new (docOf(this).defaultView ?? window).Event(eventType, { bubbles: true, cancelable: true }));
  });
  // Delegated listeners: el.on("click", ".item", fn) and el.off(…) with the same arguments.
  const delegated = new WeakMap<object, Map<string, EventListener>>();
  define(H.prototype, "on", function (this: HTMLElement, type: string, selector: string, listener: (ev: Event, target: HTMLElement) => unknown, options?: AddEventListenerOptions) {
    const wrapped: EventListener = (ev) => {
      const t = (ev.target as Element | null)?.closest?.(selector);
      if (t && this.contains(t)) listener.call(this, ev, t as HTMLElement);
    };
    const map = delegated.get(listener) ?? new Map<string, EventListener>();
    map.set(`${type}|${selector}`, wrapped);
    delegated.set(listener, map);
    this.addEventListener(type, wrapped, options);
  });
  define(H.prototype, "off", function (this: HTMLElement, type: string, selector: string, listener: (ev: Event, target: HTMLElement) => unknown, options?: EventListenerOptions) {
    const wrapped = delegated.get(listener)?.get(`${type}|${selector}`);
    if (wrapped) this.removeEventListener(type, wrapped, options);
  });

  // ── DocumentFragment (createEl on fragments comes from Node) ──
  void F;

  // ── globals ──
  const g = win as unknown as Record<string, unknown>;
  g.createEl = (tag: string, o?: Info, cb?: Callback) => make(null, tag, o, cb);
  g.createDiv = (o?: Info, cb?: Callback) => make(null, "div", o, cb);
  g.createSpan = (o?: Info, cb?: Callback) => make(null, "span", o, cb);
  g.createSvg = (tag: string, o?: Info, cb?: Callback) => make(null, tag, o, cb, true);
  g.createFragment = (cb?: (f: DocumentFragment) => void) => {
    const f = win.document.createDocumentFragment();
    cb?.(f);
    return f;
  };
  if (!("activeWindow" in g)) {
    Object.defineProperty(g, "activeWindow", { get: () => win, configurable: true });
    Object.defineProperty(g, "activeDocument", { get: () => win.document, configurable: true });
  }
  g.sleep = (ms: number) => new Promise<void>((r) => win.setTimeout(r, ms));
  g.nextFrame = () => new Promise<void>((r) => win.requestAnimationFrame(() => r()));
}
