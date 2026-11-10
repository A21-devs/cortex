/**
 * Obsidian's `Component` (load / unload with registered cleanups and children) and the keyboard: `Scope` (key
 * handlers with a parent scope) and the keymap that sends each keydown to the scope on top of the stack (a modal
 * or a menu above the view's scope above the app scope). Modifier names follow Obsidian: "Mod" is Ctrl on
 * Windows and Linux and Cmd on macOS; a handler that returns false has handled the key (preventDefault).
 */
import type { EventRef, Events } from "./events";

export class Component {
  private loadedFlag = false;
  private loading: Promise<void> = Promise.resolve();
  private readonly cleanups: (() => unknown)[] = [];
  private readonly children: Component[] = [];

  load(): void {
    if (this.loadedFlag) return;
    this.loadedFlag = true;
    // A plugin's onload may be async; Obsidian waits for it before the layout is ready (whenLoaded()).
    const r = this.onload() as unknown;
    if (r instanceof Promise) this.loading = r.then(() => undefined);
    for (const c of this.children) c.load();
  }

  /** Resolves when an async onload has finished. */
  whenLoaded(): Promise<void> {
    return this.loading;
  }

  onload(): void {}

  unload(): void {
    if (!this.loadedFlag) return;
    this.loadedFlag = false;
    for (const c of this.children.splice(0).reverse()) c.unload();
    for (const fn of this.cleanups.splice(0).reverse()) {
      try {
        fn();
      } catch (e) {
        console.error("[cortex-desktop] cleanup failed", e);
      }
    }
    this.onunload();
  }

  onunload(): void {}

  get loaded(): boolean {
    return this.loadedFlag;
  }

  addChild<T extends Component>(component: T): T {
    this.children.push(component);
    if (this.loadedFlag) component.load();
    return component;
  }

  removeChild<T extends Component>(component: T): T {
    const i = this.children.indexOf(component);
    if (i >= 0) {
      this.children.splice(i, 1);
      component.unload();
    }
    return component;
  }

  register(cb: () => unknown): void {
    this.cleanups.push(cb);
  }

  registerEvent(ref: EventRef | null | undefined): void {
    if (!ref) return;
    this.register(() => (ref.e as Events).offref(ref));
  }

  registerDomEvent(el: EventTarget, type: string, callback: (ev: Event) => unknown, options?: boolean | AddEventListenerOptions): void {
    const fn = callback as EventListener;
    el.addEventListener(type, fn, options);
    this.register(() => el.removeEventListener(type, fn, options));
  }

  registerInterval(id: number): number {
    this.register(() => window.clearInterval(id));
    return id;
  }
}

// ───────────────────────────── keyboard ─────────────────────────────

export type Modifier = "Mod" | "Ctrl" | "Meta" | "Shift" | "Alt";

export interface KeymapContext {
  modifiers: string | null;
  key: string | null;
  vkey: string;
}

export type KeymapEventListener = (evt: KeyboardEvent, ctx: KeymapContext) => false | unknown;

export interface KeymapEventHandler {
  scope: Scope;
  modifiers: string | null;
  key: string | null;
  func: KeymapEventListener;
}

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

/** The modifiers held during an event, in Obsidian's canonical order ("Mod,Shift"). */
export function eventModifiers(evt: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): string {
  const out: string[] = [];
  if (IS_MAC ? evt.metaKey : evt.ctrlKey) out.push("Mod");
  if (IS_MAC && evt.ctrlKey) out.push("Ctrl");
  if (!IS_MAC && evt.metaKey) out.push("Meta");
  if (evt.altKey) out.push("Alt");
  if (evt.shiftKey) out.push("Shift");
  return out.join(",");
}

/** Canonical form of a registered modifier list ("Ctrl" on Windows is "Mod"). */
export function canonicalModifiers(mods: readonly Modifier[] | null): string | null {
  if (mods === null) return null;
  const set = new Set<string>(mods.map((m) => (!IS_MAC && m === "Ctrl" ? "Mod" : IS_MAC && m === "Meta" ? "Mod" : m)));
  return ["Mod", "Ctrl", "Meta", "Alt", "Shift"].filter((m) => set.has(m)).join(",");
}

function keyMatches(registered: string | null, evt: KeyboardEvent): boolean {
  if (registered === null) return true;
  const k = evt.key;
  if (registered.length === 1 && /[a-z]/i.test(registered)) return k.toLowerCase() === registered.toLowerCase() || evt.code === `Key${registered.toUpperCase()}`;
  if (registered === " ") return k === " " || evt.code === "Space";
  return k === registered || k.toLowerCase() === registered.toLowerCase();
}

export class Scope {
  readonly keys: KeymapEventHandler[] = [];

  constructor(readonly parent?: Scope) {}

  register(modifiers: Modifier[] | null, key: string | null, func: KeymapEventListener): KeymapEventHandler {
    const h: KeymapEventHandler = { scope: this, modifiers: canonicalModifiers(modifiers), key, func };
    this.keys.push(h);
    return h;
  }

  unregister(handler: KeymapEventHandler): void {
    const i = this.keys.indexOf(handler);
    if (i >= 0) this.keys.splice(i, 1);
  }

  /** Run the first matching handler here, then in the parents. True when one returned false (handled). */
  handleKey(evt: KeyboardEvent): boolean {
    const mods = eventModifiers(evt);
    const ctx: KeymapContext = { modifiers: mods, key: evt.key, vkey: evt.code };
    for (let s: Scope | undefined = this; s; s = s.parent) {
      for (const h of [...s.keys]) {
        if (h.modifiers !== null && h.modifiers !== mods) continue;
        if (!keyMatches(h.key, evt)) continue;
        let r: unknown;
        try {
          r = h.func(evt, ctx);
        } catch (e) {
          console.error("[cortex-desktop] key handler failed", e);
          continue;
        }
        if (r === false) return true;
      }
    }
    return false;
  }
}

/**
 * The keymap: modal and menu scopes stack on top of the active view's scope, which sits on the app scope; keydown
 * goes to the top one and its parents.
 */
export class Keymap {
  private readonly stack: Scope[] = [];
  /** The active view's scope (a view sets `this.scope` when it mounts, so it is read at key time). */
  viewScope: () => Scope | null = () => null;

  constructor(readonly root: Scope) {}

  pushScope(scope: Scope): void {
    const i = this.stack.indexOf(scope);
    if (i >= 0) this.stack.splice(i, 1);
    this.stack.push(scope);
  }

  popScope(scope: Scope): void {
    const i = this.stack.indexOf(scope);
    if (i >= 0) this.stack.splice(i, 1);
  }

  get top(): Scope {
    return this.stack[this.stack.length - 1] ?? this.viewScope() ?? this.root;
  }

  /** Listen on a window (capture phase, like Obsidian, so a focused input cannot hide Mod+K from the view). */
  attach(win: Window): () => void {
    const onKey = (evt: KeyboardEvent): void => {
      if (evt.defaultPrevented || evt.isComposing) return;
      if (this.top.handleKey(evt)) evt.preventDefault();
    };
    win.addEventListener("keydown", onKey, true);
    return () => win.removeEventListener("keydown", onKey, true);
  }

  static isModEvent(evt?: MouseEvent | KeyboardEvent | null): boolean | "tab" | "split" | "window" {
    if (!evt) return false;
    return IS_MAC ? evt.metaKey : evt.ctrlKey;
  }

  static isModifier(evt: MouseEvent | TouchEvent | KeyboardEvent, modifier: Modifier): boolean {
    const e = evt as KeyboardEvent;
    switch (modifier) {
      case "Mod":
        return IS_MAC ? e.metaKey : e.ctrlKey;
      case "Ctrl":
        return e.ctrlKey;
      case "Meta":
        return e.metaKey;
      case "Shift":
        return e.shiftKey;
      case "Alt":
        return e.altKey;
    }
  }
}
