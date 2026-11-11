/**
 * "Screened on this computer" (Sources > Privacy and Agents > Access log): what the personal-detail screen replaces in
 * the text that may be sent to a model, counted per kind, each value shown masked with the text around it as the model
 * would get it, and a "Keep this one" for a value that is fine to send. Names and addresses you listed sit below; the
 * optional local-model pass only suggests. Data: the runner's `privacy.screened` (read-only); sample mode builds a
 * made-up example with the same detectors. Owner: screening-person.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { allowedViews, ADDRESS_ROW, PERSON_MARKERS, ScreenTally, type PersonKind, type ScreenedItem, type ScreenedSummary } from "../../../shared/personDetail";
import { useServices } from "../../context";
import { t, type CopyKey } from "../../copy";
import { Button, TextButton } from "../../primitives/buttons";
import { fmtInt } from "../../valueLabels";
import { ChangeSlot, Load, useChange, useLoad } from "../PageFrame";

const KIND_KEY: Readonly<Record<PersonKind, CopyKey>> = {
  card: "agents.screenedKindCard",
  bank: "agents.screenedKindBank",
  id: "agents.screenedKindId",
  address: "agents.screenedKindAddress",
  birth: "agents.screenedKindBirth",
  name: "agents.screenedKindName",
};

export const kindLabel = (k: PersonKind): string => t(KIND_KEY[k]);

/** The made-up record sample mode shows, run through the real detectors. */
export const SAMPLE_PASSAGES: readonly string[] = [
  "Paid the deposit with my card 4111 1111 1111 1111 yesterday, receipt is in the folder.",
  "Send the refund to GB82 WEST 1234 5698 7654 32 please.",
  "I live at 221 Baker Street and was born on 12/03/1985.",
  "My SSN is 123-45-6789, same as on the tax form.",
];

export function sampleSummary(): ScreenedSummary {
  const tally = new ScreenTally({ salt: "sample", now: Date.UTC(2026, 5, 1) });
  SAMPLE_PASSAGES.forEach((p, i) => tally.add(`sample-${i + 1}`, p));
  return tally.summary(SAMPLE_PASSAGES.length, SAMPLE_PASSAGES.length, false);
}

function newSalt(): string {
  const bytes = new Uint8Array(16);
  const c = (globalThis as { crypto?: { getRandomValues?(a: Uint8Array): Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const withoutKey = (rows: readonly string[], key: string): string[] => rows.filter((r) => !r.startsWith(`${key}:`));

export function ScreenedList(): JSX.Element {
  const s = useServices();
  const change = useChange();
  const sandbox = s.sandbox.value;
  const st = s.settings.signal.value.privacy;
  const [asking, setAsking] = useState(false);
  const [proposals, setProposals] = useState<ScreenedSummary["proposals"]>(undefined);
  const [draft, setDraft] = useState("");
  const dep = `${st.redact.personal}|${st.screening.idCountries.join(",")}|${st.screening.allowed.length}|${st.screening.names.length}`;

  const result = useLoad(async (): Promise<ScreenedSummary> => {
    if (sandbox) return sampleSummary();
    // Keys are salted per install: make the salt before the first look so what "Keep this one" stores matches later looks.
    if (s.settings.value.privacy.screening.salt === "") await s.settings.update((x) => void (x.privacy.screening.salt === "" && (x.privacy.screening.salt = newSalt())));
    return s.runner.request({ cmd: "privacy.screened", args: {} });
  }, [sandbox, dep]);

  const keep = (it: ScreenedItem) =>
    void s.settings.update((x) => void x.privacy.screening.allowed.push(`${it.key}:${it.hint.replace(/:/g, " ")}`)).then(
      () => change.post(t("agents.screenedKeepDone"), async () => void (await s.settings.update((x) => void (x.privacy.screening.allowed = withoutKey(x.privacy.screening.allowed, it.key))))),
      () => change.post(t("errors.action")),
    );
  const screenAgain = (key: string) =>
    void s.settings.update((x) => void (x.privacy.screening.allowed = withoutKey(x.privacy.screening.allowed, key))).then(
      () => change.post(t("agents.screenedScreenedAgain")),
      () => change.post(t("errors.action")),
    );
  const addName = (v: string, then?: () => void) => {
    const row = v.trim();
    if (row.length < 3) return;
    void s.settings.update((x) => void (!x.privacy.screening.names.includes(row) && x.privacy.screening.names.push(row))).then(
      () => {
        then?.();
        change.post(t("agents.screenedScreening", { what: row.startsWith(ADDRESS_ROW) ? row.slice(ADDRESS_ROW.length).trim() : row }));
      },
      () => change.post(t("errors.action")),
    );
  };
  const dropName = (row: string) => void s.settings.update((x) => void (x.privacy.screening.names = x.privacy.screening.names.filter((n) => n !== row))).catch(() => change.post(t("errors.action")));
  const askLocal = async () => {
    setAsking(true);
    try {
      const r = await s.runner.request({ cmd: "privacy.screened", args: { proposeNames: true } });
      setProposals(r.proposals ?? []);
    } catch {
      change.post(t("errors.action"));
    } finally {
      setAsking(false);
    }
  };
  const canAsk = !sandbox && st.screening.localNames && s.settings.value.agents.engine === "local";
  const kept = allowedViews(st.screening.allowed);

  return (
    <section class="cx-screened" aria-label={t("agents.screenedTitle")}>
      <div class="cx-section-label">
        <span>{t("agents.screenedTitle")}</span>
      </div>
      <p class="cx-note">{t("agents.screenedIntro")}</p>
      {sandbox ? <p class="cx-note">{t("agents.screenedSample")}</p> : null}
      <Load value={result} failed={t("errors.access")} rows={3}>
        {(r) =>
          r.off ? (
            <p class="cx-note">{t("agents.screenedOff")}</p>
          ) : (
            <>
              <p class="cx-note">{r.partial ? t("agents.screenedLookedPartial", { n: fmtInt(r.scanned), total: fmtInt(r.total) }) : t("agents.screenedLooked", { n: fmtInt(r.scanned) })}</p>
              {r.items.length === 0 ? (
                <p class="cx-note">{t("agents.screenedNone")}</p>
              ) : (
                <>
                  <ul class="cx-screened-kinds">
                    {r.kinds.map((k) => (
                      <li class="cx-screened-kind" data-kind={k.kind}>
                        <span class="cx-screened-count cx-mono">{fmtInt(k.count)}</span>
                        <span>{kindLabel(k.kind)}</span>
                      </li>
                    ))}
                  </ul>
                  <ul class="cx-screened-rows">
                    {r.items.map((it) => (
                      <li class="cx-screened-row" data-kind={it.kind}>
                        <div class="cx-screened-head">
                          <span class="cx-screened-hint cx-mono">{it.hint}</span>
                          <span class="cx-note">{kindLabel(it.kind)}</span>
                          <span class="cx-note cx-mono">
                            {t("agents.screenedColSeen")} {fmtInt(it.count)}
                          </span>
                        </div>
                        <div class="cx-screened-snippet" title={PERSON_MARKERS[it.kind]}>
                          <span class="cx-note">{t("agents.screenedColSent")}</span> <span class="cx-mono">{it.snippet}</span>
                        </div>
                        {sandbox ? null : <TextButton onClick={() => keep(it)}>{t("agents.screenedKeep")}</TextButton>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )
        }
      </Load>
      {kept.length > 0 ? (
        <div class="cx-screened-kept">
          <div class="cx-section-label">
            <span>{t("agents.screenedKeptTitle")}</span>
          </div>
          <p class="cx-note">{t("agents.screenedKeptNote")}</p>
          <ul class="cx-screened-list">
            {kept.map((k) => (
              <li>
                <span class="cx-mono">{k.hint}</span>
                <span class="cx-note">{kindLabel(k.kind)}</span>
                <TextButton onClick={() => screenAgain(k.key)}>{t("agents.screenedScreenAgain")}</TextButton>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {sandbox ? null : (
        <div class="cx-screened-names">
          <div class="cx-section-label">
            <span>{t("agents.screenedNamesTitle")}</span>
          </div>
          {st.screening.names.length > 0 ? (
            <ul class="cx-screened-list">
              {st.screening.names.map((n) => (
                <li>
                  <span class="cx-mono">{n}</span>
                  <TextButton onClick={() => dropName(n)}>{t("agents.screenedStop")}</TextButton>
                </li>
              ))}
            </ul>
          ) : null}
          <form
            class="cx-screened-add"
            onSubmit={(e) => {
              e.preventDefault();
              addName(draft, () => setDraft(""));
            }}
          >
            <input type="text" class="cx-input" value={draft} placeholder={t("agents.screenedNamePlaceholder")} aria-label={t("agents.screenedNamesTitle")} onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)} />
            <Button onClick={() => addName(draft, () => setDraft(""))} disabled={draft.trim().length < 3}>
              {t("agents.screenedNameAdd")}
            </Button>
          </form>
          {canAsk ? (
            <Button onClick={() => void askLocal()} disabled={asking}>
              {asking ? t("agents.screenedLooking") : t("agents.screenedLook")}
            </Button>
          ) : (
            <p class="cx-note">{t("agents.screenedNeedLocal")}</p>
          )}
          {proposals !== undefined ? (
            proposals.length === 0 ? (
              <p class="cx-note">{t("agents.screenedNoProposals")}</p>
            ) : (
              <div class="cx-screened-proposals">
                <div class="cx-section-label">
                  <span>{t("agents.screenedProposals")}</span>
                </div>
                <p class="cx-note">{t("agents.screenedProposalNote")}</p>
                <ul class="cx-screened-list">
                  {proposals.map((p) => (
                    <li>
                      <span class="cx-mono">{p.text}</span>
                      <span class="cx-note">{kindLabel(p.kind)}</span>
                      <TextButton onClick={() => addName(p.kind === "address" ? `${ADDRESS_ROW}${p.text}` : p.text, () => setProposals((cur) => cur?.filter((x) => x !== p)))}>{t("agents.screenedScreenThis")}</TextButton>
                      <TextButton onClick={() => setProposals((cur) => cur?.filter((x) => x !== p))}>{t("agents.screenedNotThis")}</TextButton>
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : null}
        </div>
      )}
      <ChangeSlot state={change} />
    </section>
  );
}
