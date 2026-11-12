/**
 * The stage's top-left row on Cortex Desktop: the title block ("Brain" with its dim counts line) and, beside it, the slim
 * on-stage search field. The field shares its draft with the Find bar and Ctrl+K (`ui.command.text`), has a clear x when it
 * holds text, and a small chat button that flips the same box to Ask. Flipping is only a mode switch: nothing is ever sent
 * from here, and Enter in Ask mode opens the Ask console exactly as the bar does. Typing lights the matching particles
 * (the command line's own effect does that) and the rail reports how many were found. It goes while the Read drawer is
 * open and with Display › "Search on the stage" off; it stays whenever the rail is collapsed. Owner: pkg-03.
 */
import type { JSX } from "preact";
import { featureOn } from "../../shared/features";
import { clearTokens } from "../../state/actions";
import type { CortexStore } from "../../state/store";
import type { UiState } from "../../state/types";
import { drawerOpenLeft, stageBox } from "../breakpoints";
import { useLeaf, useServices, useShell, type Shell } from "../context";
import { t } from "../copy";
import { isDesktopHost } from "../host";
import { focusCommandLine } from "../keymap";
import { Icon } from "../primitives/buttons";
import { TitleBlock } from "./TitleBlock";

/** The field needs this much stage width; narrower stages keep the figure clear. */
export const STAGE_SEARCH_MIN_STAGE_W = 520;

/** Whether the on-stage field shows: Desktop, the setting on, and not while the Read drawer takes the left. */
export function stageSearchVisible(ui: Pick<UiState, "immersive" | "breakpoint" | "sheet">, stageWidth: number, on: boolean): boolean {
  return on && !ui.immersive && ui.breakpoint !== "Mini" && stageWidth >= STAGE_SEARCH_MIN_STAGE_W && !drawerOpenLeft(ui);
}

/** Write the shared draft (the same field the Find bar reads). Results stay closed: the list belongs to the bar. */
export function setStageDraft(store: CortexStore, next: string): void {
  store.update("ui", (u) => ({ ...u, command: { ...u.command, text: next, resultsOpen: false, consoleOpen: u.command.consoleOpen || (u.command.mode === "ask" && next.startsWith("/")) } }));
}

/** The chat button: flip the same box between a search and a question. Only the mode changes: no console opens and nothing is sent. */
export function flipStageMode(store: CortexStore): void {
  store.update("ui", (u) => ({ ...u, command: { ...u.command, mode: u.command.mode === "ask" ? "find" : "ask", resultsOpen: false, consoleOpen: false } }));
}

/** Clear the draft and whatever the query lit. */
export function clearStageDraft(store: CortexStore): void {
  store.batch(() => {
    clearTokens(store);
    setStageDraft(store, "");
  });
}

/**
 * Whether the bottom command bar rests (hidden until invoked) on Desktop: nothing typed into it or traced, no console.
 * With the on-stage field the draft lives up there, so a draft alone does not bring the bar out.
 */
export function commandBarResting(i: { desktop: boolean; tokens: number; text: string; consoleOpen: boolean; resultsOpen: boolean; stageSearch: boolean }): boolean {
  if (!i.desktop || i.tokens > 0 || i.consoleOpen || i.resultsOpen) return false;
  return i.text.length === 0 || i.stageSearch;
}

function onKey(e: KeyboardEvent, store: CortexStore, shell: Shell, ask: boolean, text: string): void {
  if (e.key === "Enter" && text.trim().length > 0) {
    e.preventDefault();
    if (ask) {
      // The question is sent only from the Ask console's own input, by a deliberate Enter there: this opens it and hands over.
      store.update("ui", (u) => ({ ...u, command: { ...u.command, consoleOpen: true } }));
      focusCommandLine(shell);
    } else {
      // Find: the matches are already lit; the result list opens on the command bar, which takes the focus.
      store.update("ui", (u) => ({ ...u, command: { ...u.command, resultsOpen: true } }));
      focusCommandLine(shell);
    }
  } else if (e.key === "ArrowDown" && !ask && text.trim().length > 0) {
    e.preventDefault();
    store.update("ui", (u) => ({ ...u, command: { ...u.command, resultsOpen: true } }));
    focusCommandLine(shell);
  }
}

/** Whether the on-stage field is showing now (Desktop only: the Obsidian plugin keeps its always-visible Find bar). */
export function useStageSearchShown(): boolean {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const ui = leaf.store.slices.ui.value;
  if (!isDesktopHost()) return false;
  return stageSearchVisible(ui, stageBox(shell.size.value, ui).width, s.settings.value.appearance.searchOnStage !== false);
}

export function StageSearch(): JSX.Element | null {
  const leaf = useLeaf();
  const shell = useShell();
  const ui = leaf.store.slices.ui.value;
  if (!useStageSearchShown()) return null;
  const askOn = featureOn("ask");
  const ask = ui.command.mode === "ask" && askOn;
  const text = ui.command.text;
  return (
    <div class={`cx-stage-search${ask ? " is-ask" : ""}`} role="search" data-cx-overlay="stage-search" data-mode={ask ? "ask" : "find"}>
      <Icon name="find" class="cx-stage-search-icon" />
      <input
        class="cx-stage-search-input"
        type="text"
        autocomplete="off"
        spellcheck={false}
        value={text}
        aria-label={ask ? t("command.ask") : t("overlays.searchLabel")}
        placeholder={ask ? t("command.askPlaceholder") : t("overlays.searchPlaceholder")}
        onInput={(e) => setStageDraft(leaf.store, (e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => onKey(e, leaf.store, shell, ask, text)}
      />
      {text.length > 0 ? (
        <button type="button" class="cx-stage-search-clear" aria-label={t("overlays.searchClear")} title={t("overlays.searchClear")} onClick={() => clearStageDraft(leaf.store)}>
          <Icon name="close" />
        </button>
      ) : null}
      {askOn ? (
        <button
          type="button"
          class={`cx-stage-search-ask${ask ? " is-on" : ""}`}
          aria-pressed={ask}
          aria-label={ask ? t("overlays.findToggle") : t("overlays.askToggle")}
          title={ask ? t("overlays.findToggle") : t("overlays.askToggle")}
          onClick={() => flipStageMode(leaf.store)}
        >
          <Icon name="conversation" />
        </button>
      ) : null}
    </div>
  );
}

/** Desktop's top-left row: the page title with its counts, then the search field. */
export function StageHead(): JSX.Element {
  return (
    <div class="cx-stage-head" data-cx-overlay="stage-head">
      <TitleBlock />
      <StageSearch />
    </div>
  );
}
