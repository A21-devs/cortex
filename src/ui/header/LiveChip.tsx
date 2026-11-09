/**
 * "● Live" (CORTEX-UX §5.1): a green 6 px dot + "Live" while at least one source is watched (after the first-run
 * step, with Claude Code watched or a watched folder, and a runner that is not stopped for good). Tooltip:
 * "Watching Claude Code. New sessions show up within a minute." At M the chip is the dot alone. Owner: E11.
 */
import type { JSX } from "preact";
import type { CortexSettings } from "../../shared/settings";
import type { ActivityState } from "../../state/types";
import { useServices } from "../context";
import { t } from "../copy";

export function isWatching(settings: CortexSettings, activity: Pick<ActivityState, "runner" | "settingsCorrupt">): boolean {
  if (!settings.general.firstRunDone || activity.settingsCorrupt || activity.runner === "unavailable") return false;
  const cc = settings.sources.claudeCode.enabled && settings.sources.claudeCode.watch;
  const folders = settings.sources.folders.some((f) => f.enabled && f.watch);
  return cc || folders;
}

export function LiveChip(p: { iconOnly?: boolean }): JSX.Element | null {
  const s = useServices();
  if (!isWatching(s.settings.value, s.shared.slices.activity.value)) return null;
  return (
    <span class={`cx-live${p.iconOnly ? " is-icon" : ""}`} title={t("header.liveTip")} role="status" aria-label={`${t("header.live")}. ${t("header.liveTip")}`}>
      <span class="cx-live-dot" aria-hidden="true" />
      {p.iconOnly ? null : <span aria-hidden="true">{t("header.live")}</span>}
    </span>
  );
}
