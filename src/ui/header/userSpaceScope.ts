/**
 * Choosing one of the person's own spaces (shared/userSpaces.ts) from the wordmark, the scope chip or the scope menu.
 * Choosing writes the figure's own state (the scope, plus group tokens that light the space's areas and folders); the
 * chosen space is read back from that state, so there is nothing else to keep in step. `useUserSpaceSync` (mounted by
 * the wordmark and the chip) removes the tokens when the person moves off the space and shows the space's colour theme
 * and data palette as a temporary look through the settings preview, which the next real settings change or leaving the
 * space puts back.
 */
import { useEffect } from "preact/hooks";
import type { SpaceId } from "../../shared/types";
import { applyUserSpaceLook, activeUserSpace, hasLook, isUserScope, isUserSpaceToken, tokensFor, userScope, userScopeId, userSpaceScope, withoutUserSpaceTokens, type UserSpace } from "../../shared/userSpaces";
import { setScope } from "../../state/actions";
import type { CortexStore } from "../../state/store";
import { useLeaf, useServices } from "../context";
import type { Scope } from "./spaceCycle";

/** The scope the chip and the wordmark show: the chosen user space, else the figure's scope. */
export function currentScope(ui: { scope: SpaceId | "all"; tokens: readonly { id: string }[] }, spaces: readonly UserSpace[]): Scope {
  const sp = activeUserSpace(ui.tokens, ui.scope, spaces);
  return sp ? userScope(sp.id) : ui.scope;
}

/** The text for a scope that is one of the person's spaces; "" for the areas. */
export function userSpaceName(scope: Scope, spaces: readonly UserSpace[]): string {
  return isUserScope(scope) ? (spaces.find((u) => u.id === userScopeId(scope))?.name ?? "") : "";
}

/** The space a scope names, or null. */
export function spaceOfScope(scope: Scope, spaces: readonly UserSpace[]): UserSpace | null {
  return isUserScope(scope) ? (spaces.find((u) => u.id === userScopeId(scope)) ?? null) : null;
}

/** Change the figure's scope to an area, "All areas" or one of the person's spaces (an unknown space changes nothing). */
export function chooseScope(store: CortexStore, scope: Scope, spaces: readonly UserSpace[]): void {
  if (isUserScope(scope)) {
    const sp = spaceOfScope(scope, spaces);
    if (!sp || sp.areas.length + sp.folders.length === 0) return;
    store.update("ui", (ui) => ({ ...ui, scope: userSpaceScope(sp), tokens: tokensFor(ui.tokens, sp) }));
    return;
  }
  setScope(store, scope);
  if (store.get("ui").tokens.some(isUserSpaceToken)) store.update("ui", (ui) => ({ ...ui, tokens: withoutUserSpaceTokens(ui.tokens) }));
}

/** True while a look started by `useUserSpaceSync` is showing, so only that preview is ever ended by it. */
let lookOwned = false;

/** Keep the figure and the look in step with the chosen space. Mount once per rail wordmark and scope chip. */
export function useUserSpaceSync(): void {
  const s = useServices();
  const leaf = useLeaf();
  const ui = leaf.store.slices.ui.value;
  const spaces = s.settings.value.userSpaces ?? [];
  const active = activeUserSpace(ui.tokens, ui.scope, spaces);
  const stale = !active && ui.tokens.some(isUserSpaceToken);
  useEffect(() => {
    if (stale) leaf.store.update("ui", (u) => ({ ...u, tokens: withoutUserSpaceTokens(u.tokens) }));
  }, [stale]);
  const key = active ? `${active.id}|${active.theme ?? ""}|${active.palette ?? ""}` : "";
  useEffect(() => {
    const sp = active;
    if (sp && hasLook(sp)) {
      s.settings.preview?.((x) => applyUserSpaceLook(x.appearance, sp));
      lookOwned = true;
    } else if (lookOwned) {
      s.settings.endPreview?.();
      lookOwned = false;
    }
  }, [key]);
}
