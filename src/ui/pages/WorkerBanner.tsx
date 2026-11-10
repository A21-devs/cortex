/**
 * "Background worker unavailable" banner on Agents and Sources (CORTEX-UX §5.31): shown once the runner has
 * stopped three times in ten minutes and is off until Obsidian restarts. One sentence and Export diagnostics,
 * which works without the worker. Owner: GAPS-DATA (state from plugin/runnerClient.ts via activity.runner).
 */
import type { JSX } from "preact";
import { useServices } from "../context";
import { t } from "../copy";
import { Button, Icon } from "../primitives/buttons";

export function WorkerBanner(): JSX.Element | null {
  const s = useServices();
  if (s.shared.slices.activity.value.runner !== "unavailable") return null;
  return (
    <div class="cx-error-card" role="status" data-cx-banner="worker-off">
      <Icon name="warning" />
      <p>{t("banners.workerOff")}</p>
      <Button onClick={() => void s.exportDiagnostics().catch(() => undefined)}>{t("banners.exportDiagnostics")}</Button>
    </div>
  );
}
