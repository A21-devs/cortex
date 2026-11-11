/**
 * Directions out (the lab loop; Agents › Ledger, under the trials). The directions you accepted in Checks, one
 * sentence each, with Copy and Export markdown. Only the sentences go: never a passage of the record, a title or an
 * id (shared/outcomes.ts directionsExportText). Every copy or export is also kept as a dated entry holding the same
 * text, so you can read exactly what left.
 *
 * Each direction can take outcomes: held, did not hold or inconclusive, what was tried, the day, an optional file
 * name. An outcome is a dated entry of source "outcome" (plugin/outcomes.ts). For one that did not hold, "Make this
 * negative result public" shows the note first and writes it, with its fingerprint, to a folder on this computer.
 * Cortex sends nothing. Pure helpers are exported for tests.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { acceptedDirections, type AcceptedDirection } from "../../shared/directions";
import {
  directionsExportText,
  exportEntryTitle,
  latestByDirection,
  localDay,
  negativeFileName,
  negativeNoteText,
  normaliseOutcome,
  outcomeTitle,
  OUTCOME_RESULTS,
  TRIED_MIN,
  type OutcomeInput,
  type OutcomeResult,
  type OutcomeSummary,
} from "../../shared/outcomes";
import { useServices } from "../context";
import { t } from "../copy";
import { Button, TextButton } from "../primitives/buttons";
import { fmtInt } from "../valueLabels";
import { copyToClipboard, Load, useFmt, useLoad } from "./PageFrame";

const RESULT_KEY: Readonly<Record<OutcomeResult, "directions.resultHeld" | "directions.resultDidNotHold" | "directions.resultInconclusive">> = {
  held: "directions.resultHeld",
  "did-not-hold": "directions.resultDidNotHold",
  inconclusive: "directions.resultInconclusive",
};

/** The name of a result, as on the form and on the row. */
export function resultLabel(r: OutcomeResult): string {
  return t(RESULT_KEY[r]);
}

export interface OutboxRow {
  direction: AcceptedDirection;
  /** The newest outcome of this direction, when there is one. */
  latest: OutcomeSummary | null;
  /** How many outcomes it has. */
  count: number;
  /** A negative-result note for the newest outcome is already in the folder. */
  public: boolean;
}

/** One row per accepted direction (newest first) with its outcomes and whether its negative note was written. */
export function outboxRows(accepted: readonly AcceptedDirection[], outcomes: readonly OutcomeSummary[], negatives: readonly string[]): OutboxRow[] {
  const latest = latestByDirection(outcomes);
  const counts = new Map<string, number>();
  for (const o of outcomes) counts.set(o.cardId, (counts.get(o.cardId) ?? 0) + 1);
  const files = new Set(negatives);
  return accepted.map((direction) => {
    const l = latest.get(direction.cardId) ?? null;
    return { direction, latest: l, count: counts.get(direction.cardId) ?? 0, public: l !== null && l.result === "did-not-hold" && files.has(negativeFileName(l.on, l.direction)) };
  });
}

/** The markdown a copy or export carries: the sentences and nothing else. */
export function outboxText(accepted: readonly AcceptedDirection[], now: Date): string {
  return directionsExportText(accepted, { head: t("directions.outHead"), lead: t("directions.outLead"), day: localDay(now) });
}

/** The note a negative result writes (shown first, written exactly like this). */
export function negativeNote(o: Pick<OutcomeSummary, "direction" | "tried" | "on">): string {
  return negativeNoteText({ ...o, result: "did-not-hold" }, { head: t("directions.negHead"), direction: t("directions.negDirection"), tried: t("directions.negTried"), result: t("directions.negResult"), date: t("directions.negDate"), resultText: t("directions.negResultText") });
}

interface Form {
  result: OutcomeResult;
  tried: string;
  on: string;
  file: string;
}

function blankForm(): Form {
  return { result: "held", tried: "", on: localDay(new Date()), file: "" };
}

export function DirectionsOut(): JSX.Element {
  const s = useServices();
  const fmt = useFmt();
  const sandbox = s.sandbox.value;
  // Checks answers bump this signal; the log itself is read on each render (a short in-memory list).
  const checksTick = s.shared.slices.queues.value.checks;
  const [nonce, setNonce] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [formFor, setFormFor] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(blankForm);
  const [saving, setSaving] = useState(false);
  const [negFor, setNegFor] = useState<string | null>(null);
  const stored = useLoad(() => (sandbox ? Promise.resolve({ outcomes: [], negatives: [] }) : s.newEntry.listOutcomes()), [nonce, sandbox, checksTick]);

  let accepted: AcceptedDirection[] = [];
  try {
    accepted = sandbox ? [] : acceptedDirections(s.corrections.list());
  } catch {
    accepted = [];
  }

  /** Keep what left as a dated entry holding the same text. */
  const keepEntry = async (text: string) => {
    const day = localDay(new Date());
    await s.newEntry.save({ title: exportEntryTitle(t("directions.outEntryTitle"), day), body: text });
    setStatus(t("directions.outExported", { day }));
  };

  const copy = async () => {
    const text = outboxText(accepted, new Date());
    if (!(await copyToClipboard(text))) return setStatus(t("errors.action"));
    try {
      await keepEntry(text);
      setStatus(`${t("directions.outCopied", { n: fmtInt(accepted.length) })} ${t("directions.outExported", { day: localDay(new Date()) })}`);
    } catch {
      setStatus(t("directions.outExportFailed"));
    }
  };

  const exportMd = async () => {
    const text = outboxText(accepted, new Date());
    try {
      const where = await s.save({ suggestedName: `directions-out-${localDay(new Date())}.md`, mime: "text/markdown", data: text });
      if (where === null) return;
      await keepEntry(text);
    } catch {
      setStatus(t("directions.outExportFailed"));
    }
  };

  const input = (row: OutboxRow): OutcomeInput | null =>
    normaliseOutcome({ cardId: row.direction.cardId, direction: row.direction.text, result: form.result, tried: form.tried, on: form.on, file: form.file }, localDay(new Date()));

  const saveOutcome = async (row: OutboxRow) => {
    const o = input(row);
    if (!o || saving) return;
    setSaving(true);
    try {
      await s.newEntry.saveOutcome(o, outcomeTitle(o.result, o.direction, resultLabel));
      setStatus(t("directions.outcomeSaved", { date: fmt.date(Date.parse(`${o.on}T12:00:00Z`)) }));
      setFormFor(null);
      setForm(blankForm());
      if (o.result === "did-not-hold") setNegFor(row.direction.cardId);
      setNonce((n) => n + 1);
    } catch {
      setStatus(t("directions.outcomeFailed"));
    } finally {
      setSaving(false);
    }
  };

  const writeNote = async (l: OutcomeSummary) => {
    try {
      const res = await s.newEntry.saveNegativeResult({ on: l.on, direction: l.direction, text: negativeNote(l) });
      setStatus(res.existed ? t("directions.negExisted") : t("directions.negDone", { path: res.path, hash: res.fingerprint.slice(0, 16) }));
      setNegFor(null);
      setNonce((n) => n + 1);
    } catch {
      setStatus(t("directions.negFailed"));
    }
  };

  const disabledNote = sandbox ? t("directions.outSample") : null;

  return (
    <section class="cx-directions cx-directions-out" aria-label={t("directions.outTitle")}>
      <div class="cx-section-label">
        <span>{t("directions.outTitle")}</span>
      </div>
      <p class="cx-note">{t("directions.outIntro")}</p>
      <div class="cx-directions-actions">
        <Button disabled={sandbox || accepted.length === 0} onClick={() => void copy()}>
          {t("directions.outCopy")}
        </Button>
        <Button disabled={sandbox || accepted.length === 0} onClick={() => void exportMd()}>
          {t("directions.outExport")}
        </Button>
        {disabledNote ? <span class="cx-note">{disabledNote}</span> : null}
      </div>
      {status ? (
        <p class="cx-note" role="status">
          {status}
        </p>
      ) : null}
      <Load value={stored} failed={t("errors.agents")} rows={2}>
        {(data) => {
          const rows = outboxRows(accepted, data.outcomes, data.negatives);
          if (rows.length === 0) return <p class="cx-note">{t("directions.outEmpty")}</p>;
          const negatives = data.negatives.length;
          return (
            <>
              <ul class="cx-outbox" aria-label={t("directions.outTableLabel")}>
                {rows.map((row) => {
                  const id = row.direction.cardId;
                  const l = row.latest;
                  const noteFor = negFor === id && l !== null && l.result === "did-not-hold" ? l : null;
                  const problem = formFor === id ? input(row) === null : false;
                  return (
                    <li class="cx-outbox-row" key={id}>
                      <div class="cx-outbox-head">
                        <span class="cx-outbox-text">{row.direction.text}</span>
                        <span class="cx-note">{t("directions.outAccepted", { date: fmt.date(Date.parse(row.direction.at), true) })}</span>
                      </div>
                      <div class="cx-outbox-meta">
                        {l ? (
                          <span class={`cx-outcome-chip is-${l.result}`}>{t("directions.outcomeLatest", { result: resultLabel(l.result), date: fmt.date(Date.parse(`${l.on}T12:00:00Z`), true) })}</span>
                        ) : null}
                        {row.count > 1 ? <span class="cx-note">{t("directions.outcomeMore", { n: fmtInt(row.count) })}</span> : null}
                        {!sandbox ? (
                          <TextButton onClick={() => (setFormFor(formFor === id ? null : id), setForm(blankForm()))}>{formFor === id ? t("directions.outcomeCancel") : t("directions.outcomeRecord")}</TextButton>
                        ) : null}
                        {l && l.result === "did-not-hold" && !sandbox ? (
                          row.public ? (
                            <span class="cx-note">{t("directions.negPublic")}</span>
                          ) : (
                            <TextButton onClick={() => setNegFor(negFor === id ? null : id)}>{t("directions.negTitle")}</TextButton>
                          )
                        ) : null}
                      </div>
                      {formFor === id ? (
                        <div class="cx-outcome-form">
                          <div class="cx-directions-actions" role="group" aria-label={t("directions.outcomeResult")}>
                            <span class="cx-note">{t("directions.outcomeResult")}</span>
                            {OUTCOME_RESULTS.map((r) => (
                              <button type="button" class={`cx-button${form.result === r ? " is-primary" : ""}`} aria-pressed={form.result === r} disabled={saving} onClick={() => setForm({ ...form, result: r })}>
                                <span>{resultLabel(r)}</span>
                              </button>
                            ))}
                          </div>
                          <label class="cx-field">
                            <span>{t("directions.triedLabel")}</span>
                            <textarea class="cx-input" rows={3} maxLength={2000} placeholder={t("directions.triedPlaceholder")} value={form.tried} disabled={saving} onInput={(e) => setForm({ ...form, tried: (e.currentTarget as HTMLTextAreaElement).value })} />
                          </label>
                          <label class="cx-field">
                            <span>{t("directions.dayLabel")}</span>
                            <input class="cx-input" type="date" max={localDay(new Date())} value={form.on} disabled={saving} onInput={(e) => setForm({ ...form, on: (e.currentTarget as HTMLInputElement).value })} />
                          </label>
                          <label class="cx-field">
                            <span>{t("directions.fileLabel")}</span>
                            <input class="cx-input" type="text" maxLength={200} placeholder={t("directions.filePlaceholder")} value={form.file} disabled={saving} onInput={(e) => setForm({ ...form, file: (e.currentTarget as HTMLInputElement).value })} />
                          </label>
                          <p class="cx-note">{t("directions.fileHint")}</p>
                          <div class="cx-directions-actions">
                            <Button primary disabled={saving || problem} onClick={() => void saveOutcome(row)}>
                              {saving ? t("directions.outcomeSaving") : t("directions.outcomeSave")}
                            </Button>
                            {problem ? <span class="cx-note">{t("directions.outcomeShort", { n: TRIED_MIN })}</span> : null}
                          </div>
                        </div>
                      ) : null}
                      {noteFor ? (
                        <div class="cx-outcome-form">
                          <p class="cx-note">{t("directions.negIntro")}</p>
                          <p class="cx-note">{t("directions.negPreview")}</p>
                          <pre class="cx-outbox-note">{negativeNote(noteFor)}</pre>
                          <div class="cx-directions-actions">
                            <Button primary onClick={() => void writeNote(noteFor)}>
                              {t("directions.negWrite")}
                            </Button>
                          </div>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              <p class="cx-note">{data.outcomes.length === 0 && negatives === 0 ? t("directions.outcomesNone") : t("directions.outcomesCount", { n: fmtInt(data.outcomes.length), m: fmtInt(negatives) })}</p>
            </>
          );
        }}
      </Load>
    </section>
  );
}
