/**
 * Agents > Access log > "Grants and reads": what each grant has used (read n of its limit), the items models have read
 * most, a "Show these" that lights the items at the read limit on the figure, and "Reset" for one item. The grants
 * themselves are made in Settings > Privacy; changes to them are also dated entries in the record. Data: the runner's
 * `consent.reads` (read-only counts and titles, never text); sample mode shows a made-up example.
 * Owner: consent-grants.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { grantState, grantUsed, resetItem, type ConsentReads } from "../../../shared/consent";
import type { ConsentGrant } from "../../../shared/settingsExt";
import { localDayKey } from "../../../shared/time";
import { addToken } from "../../../state/actions";
import { useLeaf, useServices } from "../../context";
import { consentEntry } from "../../consentEntry";
import { COPY, t } from "../../copy";
import { TextButton } from "../../primitives/buttons";
import { fmtInt } from "../../valueLabels";
import { ChangeSlot, Load, useChange, useLoad } from "../PageFrame";

export const SAMPLE_READS: ConsentReads = {
  limit: 3,
  grants: { "g-sample-1": 41 },
  items: [
    { id: "e_sampleaaaaaaaaaaaa", n: 3, label: "Notes on the garden plan" },
    { id: "e_samplebbbbbbbbbbbb", n: 2, label: "Questions about the build" },
    { id: "e_samplecccccccccccc", n: 1, label: "Reading list" },
  ],
  atLimit: ["e_sampleaaaaaaaaaaaa"],
};

export const SAMPLE_GRANTS: ConsentGrant[] = [
  { id: "g-sample-1", purpose: "Tidy my notes on one project", spaces: ["code"], reader: "any-model", start: "2026-05-01", end: "2026-08-31", reads: 0, readLimit: 200, revoked: false },
  { id: "g-sample-2", purpose: "An export for my records", spaces: ["life"], reader: "export", start: "2026-02-01", end: "2026-02-28", reads: 0, readLimit: 0, revoked: true },
];

const stateName = (state: string): string => (COPY.consent.state as Readonly<Record<string, string>>)[state] ?? state;
const readerName = (id: string): string => (COPY.consent.readerNames as Readonly<Record<string, string>>)[id] ?? id;

/** "read 41 of 200" or "read 41". */
export function readsText(used: number, limit: number): string {
  return limit > 0 ? t("consent.grantReads", { used, limit }) : t("consent.grantReadsFree", { used });
}

export function ConsentLog(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const change = useChange();
  const sandbox = s.sandbox.value;
  const consent = s.settings.signal.value.consent;
  const [nonce, setNonce] = useState(0);
  const result = useLoad(async (): Promise<ConsentReads> => {
    if (sandbox) return SAMPLE_READS;
    return s.runner.request({ cmd: "consent.reads", args: {} });
  }, [sandbox, nonce, consent.itemReadLimit.enabled, consent.itemReadLimit.max, Object.keys(consent.readResets ?? {}).length]);

  const grants = sandbox && consent.grants.length === 0 ? SAMPLE_GRANTS : consent.grants;
  const today = localDayKey(Date.now());

  const show = (ids: readonly string[]): void => addToken(leaf.store, { id: "set:read-limit", kind: "set", label: t("consent.keyFilter"), ids: [...ids] });
  const reset = (id: string): void => {
    if (sandbox) return;
    void s.settings
      .update((x) => resetItem(x.consent, id, new Date().toISOString()))
      .then(async () => {
        change.post(t("consent.chipResetDone"));
        try {
          const e = consentEntry({ kind: "item-reset", id });
          await s.newEntry.save({ title: e.title, body: e.body });
        } catch {
          // the reset stands; the record entry is best effort
        }
        setNonce((n) => n + 1);
      })
      .catch(() => change.post(t("errors.action")));
  };

  return (
    <section class="cx-consent-log" aria-label={t("consent.logHeading")}>
      <div class="cx-section-label">
        <span>{t("consent.logHeading")}</span>
      </div>
      <p class="cx-note">{t("consent.logDesc")}</p>
      <Load value={result} failed={t("errors.access")} rows={3}>
        {(r) => (
          <>
            {grants.length === 0 ? (
              <p class="cx-note">{t("consent.grantsEmpty")}</p>
            ) : (
              <ul class="cx-consent-grants">
                {grants.map((g) => {
                  const used = grantUsed(g, r.grants[g.id] ?? 0);
                  const state = grantState(g, today, used);
                  return (
                    <li class="cx-consent-grant" data-state={state}>
                      <span>{g.purpose || g.id}</span>
                      <span class={`cx-chip cx-grant-chip cx-grant-chip-${state}`}>{stateName(state)}</span>
                      <span class="cx-note cx-mono">
                        {readerName(g.reader)} · {readsText(used, g.readLimit)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            <div class="cx-section-label">
              <span>{t("consent.logItems")}</span>
              {r.atLimit.length > 0 ? (
                <TextButton onClick={() => show(r.atLimit)}>
                  {t("consent.logAtLimit", { n: fmtInt(r.atLimit.length) })} · {t("consent.logTrace")}
                </TextButton>
              ) : null}
            </div>
            {r.items.length === 0 ? (
              <p class="cx-note">{t("consent.logItemsNone")}</p>
            ) : (
              <ul class="cx-consent-items">
                {r.items.map((it) => (
                  <li class="cx-consent-item" data-at-limit={r.limit !== null && it.n >= r.limit ? "true" : "false"}>
                    <span>{it.label || t("consent.logItemNoLabel")}</span>
                    <span class="cx-note cx-mono">{r.limit !== null ? t("consent.chipRead", { n: it.n, max: r.limit }) : t("consent.itemReads", { n: it.n })}</span>
                    {sandbox ? null : <TextButton onClick={() => reset(it.id)}>{t("consent.logReset")}</TextButton>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Load>
      <p class="cx-note">{t("consent.logChangeNote")}</p>
      <ChangeSlot state={change} />
    </section>
  );
}
