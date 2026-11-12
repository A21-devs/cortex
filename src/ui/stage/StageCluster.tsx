/**
 * Stage icon cluster (Cortex Desktop): the stage's top right corner holds three bare icons in place of the header
 * bar's buttons and the shape bar and tool column: Display (sliders; opens the Display panel, which carries the
 * shape, grouping, look and view controls, key O), Settings and More. Owner: shell track.
 */
import type { JSX } from "preact";
import { openPopover } from "../../state/actions";
import { useLeaf, useServices, useShell } from "../context";
import { t } from "../copy";
import { openCortexSettings } from "../header/Header";
import { openMoreMenu } from "../header/MoreMenu";
import { IconButton } from "../primitives/buttons";
import { toolLabel } from "./ToolColumn";

export function StageCluster(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const shell = useShell();
  const open = leaf.store.slices.ui.value.popover === "display";
  const themesOpen = leaf.store.slices.ui.value.popover === "themes";
  return (
    <div class="cx-cluster" role="toolbar" aria-label={t("tools.tools")} data-cx-overlay="tools">
      <IconButton icon="display" size={28} class="cx-cluster-btn" label={toolLabel(t("tools.display"), "O")} pressed={open} popoverToggle="display" hasPopup="dialog" expanded={open} onClick={() => openPopover(leaf.store, "display")} />
      <IconButton icon="theme" size={28} class="cx-cluster-btn" label={t("tools.theme")} pressed={themesOpen} popoverToggle="themes" hasPopup="dialog" expanded={themesOpen} onClick={() => openPopover(leaf.store, "themes")} />
      <IconButton icon="settings" size={28} class="cx-cluster-btn" label={t("header.settings")} onClick={() => openCortexSettings(s.app)} />
      <IconButton icon="more" size={28} class="cx-cluster-btn" label={t("header.more")} hasPopup="menu" onClick={(e) => openMoreMenu(s, leaf, shell, e.currentTarget as HTMLElement)} />
    </div>
  );
}
