/**
 * Menus are Obsidian's own `Menu` (CORTEX-UX §2.1, §4.9): pickers, context menus, the key's dimension menu, the
 * Layers checklist, the scope menu and More all look and behave natively (keyboard, focus, Esc). Owner: E11.
 *  - Items are grouped by `group`; groups are separated, and a labelled group gets a header item (setIsLabel
 *    when the running Obsidian has it, otherwise a disabled item).
 *  - Submenus use MenuItem.setSubmenu where it exists (feature-detected, newer than the typed minimum); otherwise
 *    the child items appear as their own labelled section (the flat fallback).
 *  - `onHover` previews a row while the pointer rests on it (scope menu: 300 ms); `onHide` runs when the menu
 *    closes, so previews end with it.
 * Menus open under their anchor in the anchor's own document (pop-out windows).
 */
import { Menu, type MenuItem } from "obsidian";

export interface MenuItemSpec<V extends string = string> {
  value: V;
  label: string;
  /** Section; a new section starts a separator, and `groupLabel` adds a header. */
  group?: string;
  groupLabel?: string;
  checked?: boolean;
  disabled?: boolean;
  icon?: string;
  warning?: boolean;
  /** Right-aligned mono detail (a count, a key name). */
  detail?: string;
  /** Child items: a native submenu, or a labelled flat section where submenus are unavailable. */
  submenu?: MenuItemSpec<V>[];
}

export interface ShowMenuOptions<V extends string> {
  onHover?: (v: V | null) => void;
  hoverDelayMs?: number;
  onHide?: () => void;
  /** Open at the pointer instead of under the anchor (context menus). */
  at?: { x: number; y: number };
  /** A picker: open over its button so the checked row sits where the button was (the current choice under the pointer). */
  overChecked?: boolean;
}

/** Group items by `group`, preserving first-seen group order. */
export function groupItems<V extends string>(items: readonly MenuItemSpec<V>[]): { group: string | undefined; label: string | undefined; items: MenuItemSpec<V>[] }[] {
  const out: { group: string | undefined; label: string | undefined; items: MenuItemSpec<V>[] }[] = [];
  for (const it of items) {
    let g = out.find((x) => x.group === it.group);
    if (!g) {
      g = { group: it.group, label: it.groupLabel, items: [] };
      out.push(g);
    }
    if (!g.label && it.groupLabel) g.label = it.groupLabel;
    g.items.push(it);
  }
  return out;
}

type SubmenuCapable = MenuItem & { setSubmenu?: () => Menu };

let submenuSupport: boolean | null = null;

/** True when this Obsidian exposes MenuItem.setSubmenu (checked once on a throwaway item). */
export function submenusAvailable(): boolean {
  if (submenuSupport !== null) return submenuSupport;
  let ok = false;
  try {
    new Menu().addItem((mi) => {
      ok = typeof (mi as SubmenuCapable).setSubmenu === "function";
    });
  } catch {
    ok = false;
  }
  submenuSupport = ok;
  return ok;
}

/** Flatten submenus into labelled sections (the fallback where setSubmenu is missing). */
export function flattenSubmenus<V extends string>(items: readonly MenuItemSpec<V>[]): MenuItemSpec<V>[] {
  const out: MenuItemSpec<V>[] = [];
  for (const it of items) {
    if (!it.submenu) {
      out.push(it);
      continue;
    }
    const group = `sub:${it.value}`;
    for (const child of it.submenu) out.push({ ...child, group: child.group ? `${group}:${child.group}` : group, groupLabel: child.groupLabel ?? it.label });
  }
  return out;
}

function addLabel(menu: Menu, title: string): void {
  menu.addItem((mi) => {
    mi.setTitle(title);
    const labelled = mi as MenuItem & { setIsLabel?: (on: boolean) => unknown };
    if (typeof labelled.setIsLabel === "function") labelled.setIsLabel(true);
    else mi.setDisabled(true);
  });
}

function fillMenu<V extends string>(menu: Menu, items: readonly MenuItemSpec<V>[], onPick: (v: V) => void, opts: ShowMenuOptions<V>, nested: boolean): void {
  const subs = nested && submenusAvailable();
  const list = subs ? items : flattenSubmenus(items);
  groupItems(list).forEach((g, gi) => {
    if (gi > 0) menu.addSeparator();
    if (g.label) addLabel(menu, g.label);
    for (const it of g.items) {
      menu.addItem((mi) => {
        mi.setTitle(menuTitle(it.label, it.detail));
        if (it.icon) mi.setIcon(it.icon);
        if (it.checked !== undefined) mi.setChecked(it.checked);
        if (it.disabled) mi.setDisabled(true);
        if (it.warning) mi.setWarning?.(true);
        if (it.submenu && subs) {
          const sub = (mi as SubmenuCapable).setSubmenu?.();
          if (sub) fillMenu(sub, it.submenu, onPick, opts, false);
          return;
        }
        mi.onClick(() => {
          markChosen(mi);
          onPick(it.value);
        });
        attachHover(mi, it.value, opts);
      });
    }
  });
}

/** The chosen row keeps its accent fill while the menu closes (the desktop shim sets the same class itself). */
function markChosen(mi: MenuItem): void {
  const dom = (mi as MenuItem & { dom?: HTMLElement }).dom;
  dom?.classList?.add("is-chosen");
}

/** Class that gives Cortex's own menus the solid accent bar (styles/menu-accent.css). */
export const MENU_CLASS = "cx-menu";
/** Class an opener wears from a choice until it loses focus: the lasting focus ring of a select that was just used. */
export const OPENER_PICKED_CLASS = "is-menu-picked";

/** Preview on hover: Obsidian's MenuItem keeps its row in `dom` (feature-detected; previews are optional). */
function attachHover<V extends string>(mi: MenuItem, value: V, opts: ShowMenuOptions<V>): void {
  const onHover = opts.onHover;
  const dom = (mi as MenuItem & { dom?: HTMLElement }).dom;
  if (!onHover || !dom || typeof dom.addEventListener !== "function") return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const delay = opts.hoverDelayMs ?? 300;
  dom.addEventListener("mouseenter", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => onHover(value), delay);
  });
  dom.addEventListener("mouseleave", () => {
    if (timer) clearTimeout(timer);
    timer = null;
    onHover(null);
  });
}

/** A title with a right-aligned mono detail where the DOM is available; plain text otherwise. */
export function menuTitle(label: string, detail?: string): string | DocumentFragment {
  if (!detail) return label;
  if (typeof document === "undefined" || typeof document.createDocumentFragment !== "function") return `${label}  ${detail}`;
  const frag = document.createDocumentFragment();
  const a = document.createElement("span");
  a.textContent = label;
  const b = document.createElement("span");
  b.className = "cx-menu-detail";
  b.textContent = detail;
  frag.append(a, b);
  return frag;
}

/** Build an Obsidian menu without showing it (callers append Obsidian's own pane items first). */
export function buildMenu<V extends string>(items: readonly MenuItemSpec<V>[], onPick: (v: V) => void, opts: ShowMenuOptions<V> = {}): Menu {
  const menu = new Menu();
  fillMenu(menu, items, onPick, opts, true);
  (menu as Menu & { dom?: HTMLElement }).dom?.classList?.add(MENU_CLASS);
  if (opts.onHide) menu.onHide?.(opts.onHide);
  return menu;
}

/** Show an Obsidian menu under `anchor`; `onPick` receives the chosen value. */
export function showMenu<V extends string>(items: readonly MenuItemSpec<V>[], anchor: HTMLElement, onPick: (v: V) => void, opts: ShowMenuOptions<V> = {}): Menu {
  let picked = false;
  const menu = buildMenu(
    items,
    (v) => {
      picked = true;
      onPick(v);
    },
    {
      ...opts,
      onHide: () => {
        opts.onHide?.();
        // The shim hides the menu before the pick callback runs, so the choice is read one microtask later.
        queueMicrotask(() => {
          if (picked) keepOpenerRing(anchor);
        });
      },
    },
  );
  showAt(menu, anchor, opts.at, opts.overChecked);
  return menu;
}

/** After a choice the opener keeps a visible focus ring until it blurs (a context menu at the pointer has none). */
export function keepOpenerRing(anchor: HTMLElement): void {
  if (!anchor.isConnected || typeof anchor.addEventListener !== "function") return;
  anchor.classList.add(OPENER_PICKED_CLASS);
  const clear = (): void => {
    anchor.classList.remove(OPENER_PICKED_CLASS);
    anchor.removeEventListener("blur", clear);
  };
  anchor.addEventListener("blur", clear);
  try {
    anchor.focus({ preventScroll: true });
  } catch {
    /* focus is optional */
  }
}

/** Position a menu under (or at) an element in that element's document. */
export function showAt(menu: Menu, anchor: HTMLElement, at?: { x: number; y: number }, overChecked = false): void {
  const doc = anchor.ownerDocument;
  if (at) {
    menu.showAtPosition({ x: at.x, y: at.y }, doc);
    return;
  }
  const r = typeof anchor.getBoundingClientRect === "function" ? anchor.getBoundingClientRect() : { left: 0, bottom: 0, width: 0 };
  menu.showAtPosition({ x: r.left, y: r.bottom + 4, width: r.width, overlap: true }, doc);
  if (overChecked && typeof anchor.getBoundingClientRect === "function") alignCheckedRow(menu, anchor.getBoundingClientRect(), doc.defaultView?.innerHeight ?? 0);
}

/** Where the menu's top goes so the row's centre meets the anchor's centre, kept inside the window (4 px margin). */
export function alignedMenuTop(menuTop: number, rowCenter: number, anchorCenter: number, menuHeight: number, viewportHeight: number): number {
  const wanted = menuTop + (anchorCenter - rowCenter);
  const max = viewportHeight - menuHeight - 4;
  return Math.round(Math.max(4, Math.min(wanted, Math.max(4, max))));
}

/** Slide an open picker menu so its checked row sits over the anchor (feature-detected: needs the menu's DOM). */
function alignCheckedRow(menu: Menu, anchor: { top: number; height: number }, viewportHeight: number): void {
  const dom = (menu as Menu & { dom?: HTMLElement }).dom;
  if (!dom || typeof dom.querySelector !== "function" || viewportHeight <= 0) return;
  const row = dom.querySelector<HTMLElement>(".menu-item.mod-checked");
  if (!row) return;
  const m = dom.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  if (m.height <= 0 || r.height <= 0) return;
  dom.style.top = `${alignedMenuTop(m.top, r.top + r.height / 2, anchor.top + anchor.height / 2, m.height, viewportHeight)}px`;
}
