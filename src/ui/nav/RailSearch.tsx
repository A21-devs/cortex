/**
 * The rail's search field: a button styled as a field (magnifier, "Find or ask", a right-aligned key chip with the
 * platform's shortcut) that does what Ctrl or Cmd K does, focus the command line in Find mode, and a 1 px
 * hairline under it in the active palette's colours. Nothing is typed here; the command line is the input.
 */
import type { JSX } from "preact";
import { setCommandMode } from "../../state/actions";
import type { CortexStore } from "../../state/store";
import { useLeaf, useShell, type Shell } from "../context";
import { t } from "../copy";
import { focusCommandLine } from "../keymap";
import { isDesktopHost } from "../host";
import { Icon } from "../primitives/buttons";
import { useLoading } from "../stage/LoadingLines";
import { useRailPalette } from "./RailWordmark";

/** True on macOS (the chip reads Cmd K there, Ctrl K elsewhere). */
export function isMacPlatform(win: { navigator?: { platform?: string; userAgent?: string } } | undefined): boolean {
  const nav = win?.navigator;
  return /mac|iphone|ipad/i.test(`${nav?.platform ?? ""} ${nav?.platform ? "" : (nav?.userAgent ?? "")}`);
}

/** The same action as the Mod+K key (keymap.ts "focus-find"): Find mode, command line focused. */
export function runRailFind(store: CortexStore, shell: Shell): void {
  setCommandMode(store, "find");
  focusCommandLine(shell);
}

/** Desktop: the hairline under the field fills left to right with the loading progress (the whole line when idle). */
function SearchLine(p: { gradient: string }): JSX.Element {
  const m = useLoading();
  const progress = m.progress;
  const pct = progress === null ? 100 : Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return (
    <span class={`cx-rail-search-line${progress !== null ? " is-loading" : ""}${progress !== null && progress <= 0 ? " is-sweep" : ""}`} aria-hidden="true">
      <span class="cx-rail-search-fill" style={{ background: p.gradient, width: `${pct}%` }} />
    </span>
  );
}

export function RailSearch(): JSX.Element {
  const leaf = useLeaf();
  const shell = useShell();
  const rp = useRailPalette();
  const mac = isMacPlatform(shell.win as unknown as { navigator?: { platform?: string; userAgent?: string } });
  return (
    <div class="cx-rail-search-wrap">
      <button type="button" class="cx-rail-search" aria-label={t("rail.findLabel")} aria-keyshortcuts={mac ? "Meta+K" : "Control+K"} onClick={() => runRailFind(leaf.store, shell)}>
        <Icon name="find" class="cx-rail-search-icon" />
        <span class="cx-rail-search-text">{t("rail.find")}</span>
        <kbd class="cx-rail-key">{t(mac ? "rail.keyMac" : "rail.keyCtrl")}</kbd>
      </button>
      {isDesktopHost() ? <SearchLine gradient={rp.gradient} /> : <span class="cx-rail-search-line" aria-hidden="true" style={{ background: rp.gradient }} />}
    </div>
  );
}
