/**
 * Add sources (CORTEX-UX §5.1, §5.26, SAFE-11): opened from the header button, the rail's + Add, the command, the
 * banners and the empty-state card. Before the first-run step it opens that step instead; refused in the sample
 * record. It opens as a page docked on the left beside the rail (the stage stays live); with no open view to put
 * a page in, the same content opens as a dialog. Lives apart from Header.tsx so the rail can use it without
 * importing the header.
 */
import { Notice } from "obsidian";
import type { CortexServices } from "../../plugin/services";
import { openPage } from "../../state/actions";
import type { CortexStore } from "../../state/store";
import { t } from "../copy";

export async function openAddSources(s: CortexServices, store?: CortexStore): Promise<void> {
  if (s.sandbox.value) {
    new Notice(t("ask.sample"));
    return;
  }
  if (!s.settings.value.general.firstRunDone) {
    const m = await import("../modals/FirstRunModal");
    new m.FirstRunModal(s.app, s).open();
    return;
  }
  const into = store ?? s.leafStore?.();
  if (into) {
    openPage(into, "add");
    return;
  }
  const m = await import("../modals/AddSourcesModal");
  new m.AddSourcesModal(s.app, s).open();
}
