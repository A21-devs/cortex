/**
 * The one App of this window, for the classes Obsidian lets plugins construct without one (Menu, Notice) and for
 * modals that need the keymap. Set by App.open().
 */
import type { Keymap } from "./component";

export interface ShimContext {
  keymap: Keymap;
  /** Where menus, modals, notices and the settings page are attached (document.body by default). */
  layer(): HTMLElement;
}

let current: ShimContext | null = null;

export function setShimContext(ctx: ShimContext | null): void {
  current = ctx;
}

export function shimContext(): ShimContext | null {
  return current;
}
