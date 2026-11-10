/**
 * Runs ledger (CORTEX-UX §5.30.6): "All ‹n›" on Agents. Filters Job · Model · Result · Route · Date range; a table
 * with a sticky Time column that scrolls sideways: Time · Job · Model · Items · Labels · Declined · No answer ·
 * Tokens · Result; a row expands to the prompt version, tokens in / out / cached, duration, error text from the
 * catalogue, and an API-equivalent cost when the CLI reports one ("≈ $0.42 at API prices; your plan covers it").
 * Empty: "No runs match these filters." Data: LedgerService.runs(). Owner: E12.
 */
import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import type { RunRecord } from "../../shared/types";
import { useServices } from "../context";
import { t } from "../copy";
import { Select } from "../primitives/controls";
import { StatusPill } from "../primitives/buttons";
import { fmtCompact, fmtInt, isoMs, jobLabel, runResult, runResultLabel, type RunResult } from "../valueLabels";
import { Load, PageFrame, useFmt, useLoad } from "./PageFrame";

export interface RunFilter {
  job?: string;
  model?: string;
  result?: RunRecord["status"];
  route?: RunRecord["where"];
  from?: string;
  to?: string;
}

export function matchesRun(r: RunRecord, f: RunFilter): boolean {
  if (f.job && r.job !== f.job) return false;
  if (f.model && r.model !== f.model) return false;
  if (f.result && r.status !== f.result) return false;
  if (f.route && r.where !== f.route) return false;
  if (f.from && r.startedAt < f.from) return false;
  if (f.to && r.startedAt > f.to) return false;
  return true;
}

const PAGE = 100;
const ANY = "any";
const PILL: Readonly<Record<RunResult, "ok" | "warn" | "serious" | "critical" | "accent" | "muted">> = { done: "ok", partly: "warn", failed: "critical", capped: "warn", stopped: "muted", running: "accent" };
const STATUSES: readonly RunRecord["status"][] = ["running", "finished", "stopped", "failed", "capped", "nothing tagged"];

/** Start of a day input ("2026-11-10") as an ISO instant, or undefined when empty; `end` takes the day's last moment. */
export function dayBound(day: string, end: boolean): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const d = new Date(`${day}T${end ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function statusLabel(s: RunRecord["status"]): string {
  return runResultLabel(runResult({ status: s, noAnswer: 0, labels: 0, items: 1 }));
}

export function RunsLedger(_p: { params: Readonly<Record<string, string>> }): JSX.Element {
  const s = useServices();
  const fmt = useFmt();
  const runs = useLoad(() => s.ledger.runs({ limit: 5000 }), []);
  const [filter, setFilter] = useState<RunFilter>({});
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<string | null>(null);
  const all = runs.state === "ready" ? runs.value : runs.state === "loading" ? runs.previous ?? [] : [];
  const f: RunFilter = { ...filter, from: dayBound(from, false), to: dayBound(to, true) };
  const matched = useMemo(() => all.filter((r) => matchesRun(r, f)), [all, filter, from, to]);
  const jobs = [...new Set(all.map((r) => r.job))];
  const models = [...new Set(all.map((r) => r.model))];
  const set = (patch: RunFilter) => (setFilter((cur) => ({ ...cur, ...patch })), setLimit(PAGE));
  const filtered = Boolean(filter.job || filter.model || filter.result || filter.route || from || to);
  return (
    <PageFrame subtitle={t("runs.count", { n: matched.length.toLocaleString("en-GB") })}>
      <div class="cx-runs-filters">
        <Select label={t("runs.job")} value={filter.job ?? ANY} options={[{ value: ANY, label: t("runs.any") }, ...jobs.map((j) => ({ value: j, label: jobLabel(j) }))]} onChange={(v) => set({ job: v === ANY ? undefined : v })} />
        <Select label={t("runs.model")} value={filter.model ?? ANY} options={[{ value: ANY, label: t("runs.any") }, ...models.map((m) => ({ value: m, label: m }))]} onChange={(v) => set({ model: v === ANY ? undefined : v })} />
        <Select label={t("runs.result")} value={filter.result ?? ANY} options={[{ value: ANY, label: t("runs.any") }, ...STATUSES.map((x) => ({ value: x, label: statusLabel(x) }))]} onChange={(v) => set({ result: v === ANY ? undefined : (v as RunRecord["status"]) })} />
        <Select
          label={t("runs.route")}
          value={filter.route ?? ANY}
          options={[
            { value: ANY, label: t("runs.any") },
            { value: "remote", label: t("agents.routeAnthropic") },
            { value: "this computer", label: t("agents.routeLocal") },
          ]}
          onChange={(v) => set({ route: v === ANY ? undefined : (v as RunRecord["where"]) })}
        />
        <label class="cx-field">
          <span>{t("runs.from")}</span>
          <input class="cx-input" type="date" value={from} onInput={(e) => (setFrom((e.currentTarget as HTMLInputElement).value), setLimit(PAGE))} />
        </label>
        <label class="cx-field">
          <span>{t("runs.to")}</span>
          <input class="cx-input" type="date" value={to} onInput={(e) => (setTo((e.currentTarget as HTMLInputElement).value), setLimit(PAGE))} />
        </label>
        {filtered ? (
          <button
            type="button"
            class="cx-text-button"
            onClick={() => {
              setFilter({});
              setFrom("");
              setTo("");
            }}
          >
            {t("runs.clear")}
          </button>
        ) : null}
      </div>
      <Load value={runs} failed={t("errors.runs")} rows={6}>
        {() =>
          matched.length === 0 ? (
            <p class="cx-note">{all.length === 0 ? t("agents.noRuns") : t("runs.empty")}</p>
          ) : (
            <>
              <div class="cx-table-wrap">
                <table class="cx-table cx-runs-table">
                  <thead>
                    <tr>
                      <th scope="col" class="is-sticky">
                        {t("agents.time")}
                      </th>
                      <th scope="col">{t("agents.job")}</th>
                      <th scope="col">{t("agents.model")}</th>
                      <th scope="col">{t("agents.items")}</th>
                      <th scope="col">{t("agents.labels")}</th>
                      <th scope="col">{t("agents.declined")}</th>
                      <th scope="col">{t("agents.noAnswer")}</th>
                      <th scope="col">{t("agents.tokens")}</th>
                      <th scope="col">{t("agents.result")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matched.slice(0, limit).map((r) => {
                      const result = runResult(r);
                      const expanded = open === r.id;
                      return (
                        <>
                          <tr class="cx-run-row" tabIndex={0} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.id)} onKeyDown={(e) => (e.key === "Enter" ? setOpen(expanded ? null : r.id) : undefined)}>
                            <th scope="row" class="is-sticky cx-mono">
                              {fmt.dateTime(isoMs(r.startedAt), true)}
                            </th>
                            <td>{jobLabel(r.job)}</td>
                            <td class="cx-mono">{r.model}</td>
                            <td class="cx-mono">{fmtInt(r.items)}</td>
                            <td class="cx-mono">{fmtInt(r.labels)}</td>
                            <td class="cx-mono">{fmtInt(r.declined)}</td>
                            <td class="cx-mono">{fmtInt(r.noAnswer)}</td>
                            <td class="cx-mono">{fmtCompact(r.tokensIn + r.tokensOut)}</td>
                            <td>
                              <StatusPill state={PILL[result]}>{runResultLabel(result)}</StatusPill>
                            </td>
                          </tr>
                          {expanded ? (
                            <tr class="cx-run-detail">
                              <td colSpan={9}>
                                <RunExtra run={r} />
                              </td>
                            </tr>
                          ) : null}
                        </>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {matched.length > limit ? (
                <button type="button" class="cx-text-button" onClick={() => setLimit(limit + PAGE)}>
                  {t("runs.more")}
                </button>
              ) : null}
            </>
          )
        }
      </Load>
    </PageFrame>
  );
}

/** The expanded row: prompt, tokens, duration, the catalogue's error text and an API-equivalent cost. */
export function RunExtra(p: { run: RunRecord }): JSX.Element {
  const r = p.run;
  const started = isoMs(r.startedAt);
  const finished = isoMs(r.finishedAt);
  const seconds = Number.isFinite(finished) && Number.isFinite(started) ? Math.max(0, Math.round((finished - started) / 1000)) : 0;
  return (
    <div class="cx-run-extra">
      <p class="cx-mono">{t("runs.detail", { prompt: r.promptVersion, in: fmtInt(r.tokensIn), out: fmtInt(r.tokensOut), cached: fmtInt(r.tokensCacheRead), s: seconds })}</p>
      {r.tokensEstimated ? <p class="cx-note">{t("runs.estimated")}</p> : null}
      {r.error ? <p class="cx-note">{t("runs.error", { text: errorText(r.error.code, r.where) })}</p> : null}
      {r.where === "this computer" ? <p class="cx-note">{t("runs.ranLocal")}</p> : null}
      {r.costUsd > 0 ? <p class="cx-note">{t("agents.apiCost", { usd: r.costUsd.toFixed(2) })}</p> : null}
    </div>
  );
}

function errorText(code: string, where?: string): string {
  // A model on this computer that did not answer is not a Claude Code problem.
  if (code === "E_ENGINE_FAILED" && where === "this computer") return t("runs.localUnreachable");
  switch (code) {
    case "E_ENGINE_AUTH":
      return t("notices.signIn");
    case "E_ENGINE_LIMIT":
      return t("notices.limit");
    case "E_ENGINE_MISSING":
      return t("notices.missing");
    case "E_BUDGET_CAPPED":
      return t("agents.capped");
    default:
      return t("notices.failed");
  }
}
