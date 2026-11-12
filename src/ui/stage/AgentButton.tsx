/**
 * Ask button (stage overlay): a static glyph button at the stage's right edge, centred vertically below the tool
 * column. The glyph is Cortex's own (the Cortex mark with a small four-point spark). Cortex Desktop keeps a dim caption
 * pill "Ask" under the glyph at rest (it brightens on hover and is out of the way while a reader is open at the right
 * edge); in the Obsidian plugin the pill slides out on hover or keyboard focus. It does what Ctrl+Shift+K does: opens the Ask console on the command line. Hidden in
 * Immersive mode (the Stage does not mount the overlays there) and when the Ask feature is off. Owner: P16.
 */
import type { JSX } from "preact";
import { featureOn } from "../../shared/features";
import { setCommandMode } from "../../state/actions";
import type { CortexStore } from "../../state/store";
import { sheetPair, sheetSide, sheetTabbed } from "../breakpoints";
import { useLeaf, useShell, type Shell } from "../context";
import { t } from "../copy";
import { focusCommandLine } from "../keymap";
import { Glyph } from "../primitives/buttons";
import { toolLabel } from "./ToolColumn";

/** Open the Ask console and focus its input (the same action as Ctrl+Shift+K). */
export function openAsk(store: CortexStore, shell: Shell): void {
  setCommandMode(store, "ask");
  focusCommandLine(shell);
}

/** A reader is open at the stage's right edge (beside a page or on its own), so the button's caption steps back. */
export function readerOpenRight(ui: Parameters<typeof sheetPair>[0]): boolean {
  if (ui.immersive || !ui.sheet.open || sheetTabbed(ui.sheet)) return false;
  const pair = sheetPair(ui);
  if (pair) return pair.readerSide === "right";
  const top = ui.sheet.stack?.[ui.sheet.index ?? ui.sheet.stack.length - 1];
  return top?.kind === "reader" && sheetSide(ui.sheet, ui.breakpoint) === "right";
}

export function AgentButton(): JSX.Element | null {
  const leaf = useLeaf();
  const shell = useShell();
  const ui = leaf.store.slices.ui.value;
  if (!featureOn("ask") || ui.immersive) return null;
  const label = toolLabel(t("overlays.askLabel"), "Ctrl+Shift+K");
  return (
    <button type="button" class={`cx-agent-button cx-glass${readerOpenRight(ui) ? " is-reader-open" : ""}`} data-cx-overlay="agent" aria-label={label} title={label} onClick={() => openAsk(leaf.store, shell)}>
      <span class="cx-agent-mark" aria-hidden="true">
        <Glyph size={20} />
        <svg class="cx-agent-spark" viewBox="0 0 10 10" width="8" height="8" focusable="false">
          <path d="M5 0 L6 4 L10 5 L6 6 L5 10 L4 6 L0 5 L4 4 Z" fill="currentColor" />
        </svg>
      </span>
      <span class="cx-agent-pill">{t("overlays.askButton")}</span>
    </button>
  );
}
