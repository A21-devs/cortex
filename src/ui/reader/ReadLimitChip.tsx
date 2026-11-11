/**
 * "read 3 of 3" on an entry: how often models have read it since its last reset, against the limit in Settings > Privacy
 * ("Most reads per item"). Shown only when the limit is on and the entry was read. At the limit the chip says so and offers
 * "Reset this item", which starts that one item's count again. Owner: consent-grants.
 */
import type { JSX } from "preact";
import { atLimit, itemLimit, readsSince, resetItem } from "../../shared/consent";
import type { IsoDate } from "../../shared/types";
import { useServices } from "../context";
import { t } from "../copy";
import { consentEntry } from "../consentEntry";
import { TextButton } from "../primitives/buttons";

export function ReadLimitChip(p: { id: string; reads: readonly IsoDate[] }): JSX.Element | null {
  const s = useServices();
  const consent = s.settings.signal.value.consent;
  const max = itemLimit(consent);
  if (max === null) return null;
  const n = readsSince(p.reads, consent.readResets?.[p.id]);
  if (n === 0) return null;
  const at = atLimit(n, max);
  const reset = (): void => {
    if (s.sandbox.value) return;
    void s.settings
      .update((x) => resetItem(x.consent, p.id, new Date().toISOString()))
      .then(() => {
        const e = consentEntry({ kind: "item-reset", id: p.id });
        return s.newEntry.save({ title: e.title, body: e.body }).catch(() => undefined);
      })
      .catch(() => undefined);
  };
  return (
    <span class={`cx-chip cx-read-limit${at ? " is-at-limit" : ""}`} title={t("consent.chipTitle", { n, max, state: at ? t("consent.chipAtLimit") : "" })} data-at-limit={at ? "true" : "false"}>
      {t("consent.chipRead", { n, max })}
      {at && !s.sandbox.value ? <TextButton onClick={reset}>{t("consent.chipReset")}</TextButton> : null}
    </span>
  );
}
