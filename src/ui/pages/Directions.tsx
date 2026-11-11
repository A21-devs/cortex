/**
 * Direction trials (LAB-10; Agents › Ledger): write a purpose, choose what the model is given (passages from your
 * record, neutral passages as a placebo, or nothing) and ask for a few short directions toward it. One run per
 * chosen arm goes through the ordinary run path (`agents.run` with jobs ["directions"]: budget, pause, privacy and
 * the access log all apply). The table lists the trials (By · Where · Given · Purpose · Directions); every drafted
 * direction also waits in Checks until it is accepted, edited or dismissed. Pure helpers are exported for tests.
 */
import { effectiveOpenSpaces } from "../../shared/consent";
import { Fragment, type JSX } from "preact";
import { useState } from "preact/hooks";
import { DIRECTION_ARMS, normaliseRequest, PURPOSE_MAX, PURPOSE_MIN, type DirectionCardProposal } from "../../shared/directions";
import type { DirectionArm, DirectionsExperiment, ReviewCardRecord, RunRecord } from "../../shared/types";
import { useServices } from "../context";
import { t } from "../copy";
import { chipState } from "../header/AgentChip";
import { Button } from "../primitives/buttons";
import { fmtInt, runResult, runResultLabel } from "../valueLabels";
import { Load, useLoad } from "./PageFrame";

/** Passages the record arm sends at most (agents/directions.ts RECORD_PASSAGES; the UI states it in the privacy line). */
export const RECORD_PASSAGES_SHOWN = 12;

const ARM_LABEL: Readonly<Record<DirectionArm, "directions.armRecord" | "directions.armPlacebo" | "directions.armNone">> = {
  record: "directions.armRecord",
  placebo: "directions.armPlacebo",
  none: "directions.armNone",
};

/** The name of an arm, as on the start form. */
export function armLabel(arm: DirectionArm): string {
  return t(ARM_LABEL[arm]);
}

/** The Given column: what the model was given, with the number of passages when there were some. */
export function givenText(arm: DirectionArm, passages: number): string {
  if (arm === "record") return t("directions.givenRecord", { n: fmtInt(passages) });
  if (arm === "placebo") return t("directions.givenPlacebo", { n: fmtInt(passages) });
  return t("directions.givenNone");
}

/** The Where column: this computer or remote. */
export function whereText(where: RunRecord["where"]): string {
  return where === "this computer" ? t("directions.whereLocal") : t("directions.whereRemote");
}

export interface TrialRow {
  run: RunRecord;
  exp: DirectionsExperiment;
  /** Drafted directions of this run still waiting in Checks. */
  waiting: number;
}

/** The direction trials among the runs, newest first, each with how many of its drafts still wait in Checks. */
export function trialRows(runs: readonly RunRecord[], open: readonly Pick<ReviewCardRecord, "kind" | "runId">[]): TrialRow[] {
  const waiting = new Map<string, number>();
  for (const c of open) if (c.kind === "direction" && c.runId !== undefined) waiting.set(c.runId, (waiting.get(c.runId) ?? 0) + 1);
  return runs
    .filter((r): r is RunRecord & { experiment: DirectionsExperiment } => r.job === "directions" && typeof r.experiment === "object" && r.experiment !== null)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
    .map((run) => ({ run, exp: run.experiment, waiting: waiting.get(run.id) ?? 0 }));
}

/** Why a trial can't start yet (a copy key with its values), or null when it can. */
export function startProblem(purpose: string, arms: ReadonlySet<DirectionArm>): { key: "directions.purposeShort" | "directions.pickArm"; values: Record<string, number> } | null {
  if (normaliseRequest({ purpose, arms: [...arms] }) === null) return arms.size === 0 ? { key: "directions.pickArm", values: {} } : { key: "directions.purposeShort", values: { n: PURPOSE_MIN } };
  return null;
}

/** The Directions cell: a count, or how the run ended when it did not finish. */
export function countCell(row: TrialRow): string {
  const r = runResult(row.run);
  if (r === "failed" || r === "capped" || r === "stopped" || r === "running") return runResultLabel(r);
  if (row.run.status === "nothing tagged") return fmtInt(0);
  return fmtInt(row.exp.directions.length);
}

export function DirectionTrials(): JSX.Element {
  const s = useServices();
  const activity = s.shared.slices.activity.value;
  const settings = s.settings.value;
  const sandbox = s.sandbox.value;
  const [purpose, setPurpose] = useState("");
  const [arms, setArms] = useState<ReadonlySet<DirectionArm>>(new Set(DIRECTION_ARMS));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const runs = useLoad(() => s.ledger.runs({ job: "directions", limit: 200 }), [nonce, activity.jobs.length, activity.tokensToday]);
  const cards = useLoad(() => s.ledger.checks({ kind: "direction", limit: 5000 }), [nonce, s.shared.slices.queues.value.checks]);

  const state = chipState(activity, settings.agents.enabled);
  const available = state === "idle" && !activity.settingsCorrupt && !settings.agents.paused;
  const problem = startProblem(purpose, arms);
  const local = settings.agents.engine === "local";
  const model = settings.agents.models.ask;

  const toggle = (arm: DirectionArm) =>
    setArms((cur) => {
      const next = new Set(cur);
      if (next.has(arm)) next.delete(arm);
      else next.add(arm);
      return next;
    });

  const start = async () => {
    const req = normaliseRequest({ purpose, arms: [...arms] });
    if (!req || busy || sandbox || !available) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await s.runner.request({ cmd: "agents.run", args: { reason: "manual", jobs: ["directions"], experiment: req } });
      const finished = res.runs.filter((r) => r.job === "directions" && r.status === "finished").length;
      setStatus(finished > 0 ? t("directions.done") : t("directions.doneNone"));
      setNonce((n) => n + 1);
    } catch {
      setStatus(t("errors.action"));
    } finally {
      setBusy(false);
    }
  };

  const note = sandbox ? t("directions.sample") : !available ? t("directions.unavailable") : problem ? t(problem.key, problem.values) : null;

  return (
    <section class="cx-directions" aria-label={t("directions.title")}>
      <div class="cx-section-label">
        <span>{t("directions.title")}</span>
      </div>
      <p class="cx-note">{t("directions.intro")}</p>
      <label class="cx-field cx-directions-purpose">
        <span>{t("directions.purposeLabel")}</span>
        <textarea
          class="cx-input"
          rows={2}
          maxLength={PURPOSE_MAX}
          placeholder={t("directions.purposePlaceholder")}
          value={purpose}
          disabled={busy}
          onInput={(e) => setPurpose((e.currentTarget as HTMLTextAreaElement).value)}
        />
      </label>
      <fieldset class="cx-directions-arms" disabled={busy}>
        <legend class="cx-note">{t("directions.armsLabel")}</legend>
        {DIRECTION_ARMS.map((arm) => (
          <label class="cx-directions-arm">
            <input type="checkbox" checked={arms.has(arm)} onChange={() => toggle(arm)} />
            <span>{armLabel(arm)}</span>
          </label>
        ))}
      </fieldset>
      <p class="cx-note">
        {arms.has("record") ? t("directions.sendsRecord", { n: RECORD_PASSAGES_SHOWN }) : t("directions.sendsOther")}
        {arms.has("record") && arms.size > 1 ? ` ${t("directions.sendsOther")}` : ""}
      </p>
      {arms.has("record") && effectiveOpenSpaces(s.settings.signal.value.consent, s.settings.signal.value.userSpaces).length === 0 ? <p class="cx-note">{t("directions.noneOpen")}</p> : null}
      <p class="cx-note">{t(local ? "directions.routeLocal" : "directions.routeRemote", { model })}</p>
      <div class="cx-directions-actions">
        <Button primary disabled={busy || sandbox || !available || problem !== null} onClick={() => void start()}>
          {busy ? t("directions.running") : t("directions.run")}
        </Button>
        {note ? <span class="cx-note">{note}</span> : null}
      </div>
      {status ? (
        <p class="cx-note" role="status">
          {status}
        </p>
      ) : null}
      <Load value={runs} failed={t("errors.agents")} rows={2}>
        {(all) => {
          const rows = trialRows(all, cards.state === "ready" ? cards.value : cards.state === "loading" ? (cards.previous ?? []) : []);
          return rows.length === 0 ? (
            <p class="cx-note">{t("directions.empty")}</p>
          ) : (
            <table class="cx-table cx-directions-table" aria-label={t("directions.tableLabel")}>
              <thead>
                <tr>
                  <th scope="col">{t("directions.by")}</th>
                  <th scope="col">{t("directions.where")}</th>
                  <th scope="col">{t("directions.given")}</th>
                  <th scope="col">{t("directions.purpose")}</th>
                  <th scope="col">{t("directions.count")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const expanded = open === row.run.id;
                  return (
                    <Fragment key={row.run.id}>
                      <tr>
                        <th scope="row">{row.run.model}</th>
                        <td>{whereText(row.run.where)}</td>
                        <td>{givenText(row.exp.arm, row.exp.passages)}</td>
                        <td class="cx-directions-purpose-cell" title={row.exp.purpose}>
                          {row.exp.purpose}
                        </td>
                        <td>
                          <button type="button" class="cx-text-button cx-mono" aria-expanded={expanded} title={expanded ? t("directions.hide") : t("directions.show")} onClick={() => setOpen(expanded ? null : row.run.id)}>
                            {countCell(row)}
                          </button>
                          {row.waiting > 0 ? <span class="cx-note"> · {t("directions.waitingCount", { n: fmtInt(row.waiting) })}</span> : null}
                        </td>
                      </tr>
                      {expanded ? (
                        <tr class="cx-run-detail">
                          <td colSpan={5}>
                            {row.exp.directions.length === 0 ? (
                              <p class="cx-note">{row.exp.arm === "record" && row.run.status === "nothing tagged" ? t("directions.noPassages") : t("directions.noDirections")}</p>
                            ) : (
                              <ol class="cx-directions-list">
                                {row.exp.directions.map((d) => (
                                  <li>
                                    {d.text}
                                    {d.from && d.from.length > 0 ? <span class="cx-note"> · {t("directions.buildsOn", { n: d.from.length })}</span> : null}
                                  </li>
                                ))}
                              </ol>
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          );
        }}
      </Load>
    </section>
  );
}

/** Title line of a direction's Checks card: what the model was given. */
export function cardGiven(proposal: Pick<DirectionCardProposal, "arm">): string {
  return armLabel(proposal.arm);
}
