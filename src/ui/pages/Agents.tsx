/**
 * Agents (CORTEX-UX §5.20): header "Agents", actions Export ledger, More; segmented Ledger · Checks ‹n› · Access
 * log; subtitle "Model runs, their cost in tokens, and what they changed." Owner: E12 (page) with E5/E6 data.
 *
 * Ledger: status card (glyph + state + detail; Pause / Resume, Run now when idle; the §5.20 state sentences incl.
 * sign-in, not found, offline, usage limit, agents off); engine line (+ the inline-runner line when Node is
 * missing); Today (mono count "of ‹cap› tokens", 6 px meter, "‹p›% of today's cap" · "≈ ‹h› h of work left at
 * this pace", "resets at midnight"); Work waiting (queues line + one stacked bar per source: checked by you,
 * done, waiting); Recent runs (Time · Job · model · Tokens · Result; a row expands to Items · Labels · Declined ·
 * No answer and "label@1.0.0 · 1,840 in / 212 out · 41 s · from the plugin"; All ‹n› → runs page); Label packs
 * (Pack · Labels · Items · Blank, rows expand per field; "Include superseded labels"; Manage → Settings ›
 * Agents); Last 14 days bars with a dashed cap line; Privacy lines and the Off limits link. Before the first
 * run: "No runs yet…". Checks: Checks.tsx. Access log: AccessLog.tsx.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { featureOn } from "../../shared/features";
import { planCapsOf, PLAN_WINDOWS, type PlanWindowId, type PlanWindowView } from "../../shared/planLimits";
import { SETTING_RANGES } from "../../shared/settings";
import type { PendingGroup } from "../../shared/protocol/runner";
import type { StatsResult } from "../../shared/protocol/worker";
import type { RunRecord } from "../../shared/types";
import { addToken, openPage, removeToken } from "../../state/actions";
import type { ActivityState } from "../../state/types";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import { agentJobs, chipState, type ChipState } from "../header/AgentChip";
import { Button, Glyph, StatusPill } from "../primitives/buttons";
import { Slider, Toggle } from "../primitives/controls";
import { pctText, resetWhen, windowLine, windowName } from "../planText";
import { fmtDuration, fmtInt, isoMs, jobLabel, runResult, runResultLabel, type RunResult } from "../valueLabels";
import { AccessLog } from "./AccessLog";
import { Checks } from "./Checks";
import { DirectionTrials } from "./Directions";
import { DirectionsOut } from "./DirectionsOut";
import { WorkerBanner } from "./WorkerBanner";
import { fmtSpend, spendByDay, taggedRows, type PaidBy, type TaggedNow } from "./labTables";
import { Influence, MAKER_TOKEN_PREFIX } from "./agents/Influence";
import { PacksTable } from "./agents/PacksTable";
import { Schemas } from "./agents/Schemas";
import { PACK_SORT_DEFAULT, packTableRows, sortPackRows, type PackSort } from "./labPacks";
import { ChangeSlot, Load, type Loadable, PageFrame, PageTabs, openCortexSettings, setPageParams, useChange, useFmt, useLoad, type Fmt } from "./PageFrame";

type AgentsTab = "ledger" | "checks" | "access";
type PacksStats = Extract<StatsResult, { kind: "packs" }>;

/** "$4.97": dollars at API list prices. */
export function fmtUsd(usd: number): string {
  return `$${(Number.isFinite(usd) && usd > 0 ? usd : 0).toFixed(2)}`;
}

/** Totals over the runs shown: tokens in and out and the list-price cost (the runs' own recorded cost). */
export function runsTotals(runs: readonly Pick<RunRecord, "tokensIn" | "tokensOut" | "costUsd" | "tokensEstimated">[]): { n: number; tokensIn: number; tokensOut: number; costUsd: number; estimated: number } {
  const num = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);
  return {
    n: runs.length,
    tokensIn: runs.reduce((a, r) => a + num(r.tokensIn), 0),
    tokensOut: runs.reduce((a, r) => a + num(r.tokensOut), 0),
    costUsd: runs.reduce((a, r) => a + num(r.costUsd), 0),
    estimated: runs.filter((r) => r.tokensEstimated === true).length,
  };
}

/** "107 runs recorded their spend: 66,550,548 tokens in all, about $152.61 at list prices." */
export function runsSummaryLine(runs: readonly Pick<RunRecord, "tokensIn" | "tokensOut" | "costUsd" | "tokensEstimated">[]): string {
  const x = runsTotals(runs);
  const head = t(x.n === 1 ? "agents.runsSummaryOne" : "agents.runsSummary", { n: fmtInt(x.n), tokens: fmtInt(x.tokensIn + x.tokensOut), cost: fmtUsd(x.costUsd) });
  return x.estimated === 0 ? head : `${head} ${x.estimated === 1 ? t("agents.runsEstimatedOne") : t("agents.runsEstimated", { n: fmtInt(x.estimated) })}`;
}

/** The second line of a run: "416,067 tokens, about $1.29 at list price", or why there is no money to show. */
export function runCostLine(r: Pick<RunRecord, "tokensIn" | "tokensOut" | "costUsd" | "where">): string {
  const n = (Number.isFinite(r.tokensIn) ? Math.max(0, r.tokensIn) : 0) + (Number.isFinite(r.tokensOut) ? Math.max(0, r.tokensOut) : 0);
  if (n <= 0 && !(r.costUsd > 0)) return t("agents.runCostNone");
  if (r.where === "this computer") return t("agents.runCostLocal", { tokens: fmtInt(n) });
  return t("agents.runCostLine", { tokens: fmtInt(n), cost: fmtUsd(r.costUsd) });
}

/** The pack's sentence: "name 1.0.0 labelled 764 entries with 764 labels, every label made by a model. 3 fields left blank." */
export function packSentence(pk: { pack: string; version: string; labelCount: number; entryCount: number; authors: { machine: number; you: number } }, unanswered: number): string {
  if (pk.labelCount === 0) return t("agents.packNoLabels", { pack: pk.pack, version: pk.version });
  const by = pk.authors.you === 0 ? t("agents.packByAgents") : pk.authors.machine === 0 ? t("agents.packByYou") : t("agents.packByBoth", { machine: fmtInt(pk.authors.machine), you: fmtInt(pk.authors.you) });
  const head = t("agents.packLine", {
    pack: pk.pack,
    version: pk.version,
    labels: pk.labelCount === 1 ? t("agents.packLabelsOne") : t("agents.packLabels", { n: fmtInt(pk.labelCount) }),
    entries: pk.entryCount === 1 ? t("agents.packEntriesOne") : t("agents.packEntries", { n: fmtInt(pk.entryCount) }),
    by,
  });
  const blank = unanswered === 1 ? t("agents.packBlankOne") : t("agents.packBlank", { n: fmtInt(unanswered) });
  return unanswered > 0 ? `${head} ${blank}.` : head;
}

/** The muted note under the packs table when older versions are left out (null when there is nothing to say). */
export function supersededNote(count: number, included: boolean): string | null {
  if (included || count <= 0) return null;
  return count === 1 ? t("agents.supersededNoteOne") : t("agents.supersededNote", { n: fmtInt(count) });
}

/** The collapsed run row: "model · job · pass 1 · 23 October 2026 — 767 labels · 0 declined · 0 with no answer · done 2 h ago". */
export function runOneLine(r: RunRecord, fmt: Fmt): string {
  const started = isoMs(r.startedAt);
  const finished = isoMs(r.finishedAt);
  return t("agents.runOneLine", {
    model: r.model,
    job: jobLabel(r.job),
    pass: Math.max(1, r.pass || 1),
    date: Number.isFinite(started) ? fmt.date(started) : t("agents.none"),
    labels: fmtInt(r.labels),
    declined: fmtInt(r.declined),
    noAnswer: fmtInt(r.noAnswer),
    result: runResultLabel(runResult(r)),
    time: Number.isFinite(finished) ? fmt.rel(finished) : Number.isFinite(started) ? fmt.rel(started) : "",
  }).trim();
}

/** CSV text of runs for Export ledger. */
export function runsToCsv(runs: readonly RunRecord[]): string {
  const cell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const head = ["started", "job", "model", "items", "labels", "declined", "no answer", "tokens in", "tokens out", "result"];
  const lines = runs.map((r) => [r.startedAt, r.job, r.model, r.items, r.labels, r.declined, r.noAnswer, r.tokensIn, r.tokensOut, runResult(r)].map(cell).join(","));
  return [head.join(","), ...lines].join("\n");
}

const PILL: Readonly<Record<RunResult, "ok" | "warn" | "serious" | "critical" | "accent" | "muted">> = { done: "ok", partly: "warn", failed: "critical", capped: "warn", stopped: "muted", running: "accent" };

export function Agents(p: { params: Readonly<Record<string, string>> }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const change = useChange();
  const requested = p.params.tab === "checks" ? "checks" : p.params.tab === "access" ? "access" : "ledger";
  const ledgerOn = featureOn("agentsLedger");
  const tab: AgentsTab = (requested === "checks" && !featureOn("checks")) || (requested !== "ledger" && !ledgerOn) ? "ledger" : requested;
  const waiting = useLoad(() => (featureOn("checks") ? s.ledger.checksToday() : Promise.resolve({ checked: 0, waiting: 0 })), [tab, s.shared.slices.queues.value.checks]);
  const badge = waiting.state === "ready" && waiting.value.waiting > 0 ? waiting.value.waiting.toLocaleString("en-GB") : undefined;

  const exportLedger = async () => {
    try {
      const runs = await s.ledger.runs({ limit: 100_000 });
      const where = await s.save({ suggestedName: "cortex-ledger.csv", mime: "text/csv", data: runsToCsv(runs) });
      if (where) change.post(t("agents.exported"));
    } catch {
      change.post(t("errors.action"));
    }
  };

  const tabs = ledgerOn ? (
    <PageTabs
      label={t("pages.agents")}
      value={tab}
      options={[
        { value: "ledger", label: t("agents.ledger") },
        ...(featureOn("checks") ? [{ value: "checks" as const, label: t("agents.checks"), badge }] : []),
        { value: "access", label: t("agents.access") },
      ]}
      onChange={(v) => setPageParams(leaf.store, { tab: v === "ledger" ? null : v })}
    />
  ) : null;

  return (
    <PageFrame
      subtitle={t(tab === "checks" ? "agents.subtitleChecks" : tab === "access" ? "agents.subtitleAccess" : "agents.subtitle")}
      tabs={tabs}
      actions={
        tab === "ledger" && ledgerOn ? (
          <Button icon="export" onClick={() => void exportLedger()}>
            {t("agents.exportLedger")}
          </Button>
        ) : null
      }
    >
      <WorkerBanner />
      {tab === "checks" ? <Checks initial={p.params.filter} /> : tab === "access" ? <AccessLog /> : <Ledger ledgerOn={ledgerOn} />}
      <ChangeSlot state={change} />
    </PageFrame>
  );
}

// ───────────────────────────── status ─────────────────────────────

/** The state sentence and its tone for the status card. */
export function statusLine(state: ChipState, a: ActivityState, o: { claudePath: string; fmt: Fmt; lastRun?: number; now?: number; waiting?: number; idleOnly?: boolean }): { text: string; tone: "ok" | "warn" | "critical" | "accent" | "muted" } {
  switch (state) {
    case "sign-in":
      return { text: t("agents.signIn"), tone: "warn" };
    case "missing":
      return { text: t("agents.missing", { path: o.claudePath }), tone: "critical" };
    case "offline":
      return { text: t("agents.offline"), tone: "warn" };
    case "limit":
      return { text: t("agents.limit", { time: a.resumeAt ? o.fmt.dateTime(isoMs(a.resumeAt)) : t("agents.none") }), tone: "warn" };
    case "unsafe":
      return { text: t("agents.unsafe"), tone: "critical" };
    case "off":
      return { text: t("agents.off"), tone: "muted" };
    case "paused":
      return { text: t("agents.paused"), tone: "muted" };
    case "capped": {
      const held = PLAN_WINDOWS.map((id) => a.plan[id]).filter((v) => v.atCap && v.capPct !== null).sort((x, y) => (y.resetsAt ?? 0) - (x.resetsAt ?? 0))[0];
      if (held && held.resetsAt !== null) {
        const key = held.window === "fiveHour" ? "agents.cappedFive" : "agents.cappedWeek";
        return { text: t(key, { pct: Math.round(held.capPct as number), when: resetWhen(held.resetsAt, o.now) }), tone: "warn" };
      }
      return { text: t("agents.capped"), tone: "warn" };
    }
    case "organising": {
      const kinds = [...new Set(a.jobs.filter((j) => j.kind !== "import" && j.kind !== "index").map((j) => jobLabel(j.kind)))].join(", ");
      return { text: t("agents.organising", { n: agentJobs(a), jobs: kinds }), tone: "accent" };
    }
    default:
      // Never "up to date" while the runner holds work: say when it starts instead.
      if ((o.waiting ?? 0) > 0) return { text: t(o.idleOnly ? "agents.waitingIdle" : "agents.waitingSoon", { n: (o.waiting as number).toLocaleString("en-GB") }), tone: "accent" };
      return { text: o.lastRun !== undefined ? t("agents.upToDate", { time: o.fmt.rel(o.lastRun) }) : t("agents.upToDateNever"), tone: "ok" };
  }
}

/** At most this many groups are named one by one; the rest share one line. */
export const WAITING_MAIN_MAX = 3;
/** A group past the first is named on its own line only when it holds at least this share of the waiting work. */
export const WAITING_MAIN_SHARE = 0.1;

const fmtN = (n: number): string => n.toLocaleString("en-GB");
const listText = (items: readonly string[]): string => new Intl.ListFormat("en-GB", { style: "long", type: "conjunction" }).format(items);
const sumOf = (gs: readonly PendingGroup[]): number => gs.reduce((s, g) => s + g.n, 0);

function mainLine(g: PendingGroup): string {
  const n = fmtN(g.n);
  const one = g.n === 1;
  const where = g.where ?? "";
  switch (g.what) {
    case "notes": {
      const line = t(one ? "agents.whatNotesOne" : "agents.whatNotes", { n, where });
      if (!g.inside || g.inside.length === 0) return line;
      const more = (g.insideTotal ?? 0) > g.inside.length ? "…" : "";
      return `${line} ${t("agents.whatInside", { names: g.inside.join(", ") + more })}`;
    }
    case "wiki":
      return t(one ? "agents.whatWikiOne" : "agents.whatWiki", { n, where });
    case "chats":
      return t(one ? "agents.whatChatsOne" : "agents.whatChats", { n });
    case "summaries":
      return t(one ? "agents.whatSummariesOne" : "agents.whatSummaries", { n });
    case "maps":
      return t(one ? "agents.whatMapsOne" : "agents.whatMaps", { n });
    default:
      return t(one ? "agents.whatOtherOne" : "agents.whatOther", { n });
  }
}

/** One short phrase for all the groups not named on their own: notes by folder (two names, then a count), then the rest by kind. */
function restParts(rest: readonly PendingGroup[]): string {
  const parts: string[] = [];
  const notes = rest.filter((g) => g.what === "notes");
  if (notes.length > 0) {
    const names = notes.map((g) => g.where ?? "");
    const where = listText(names.length <= 3 ? names : [names[0] as string, names[1] as string, t("agents.restFolders", { n: fmtN(names.length - 2) })]);
    const n = sumOf(notes);
    parts.push(t(n === 1 ? "agents.restNotesOne" : "agents.restNotes", { n: fmtN(n), where }));
  }
  const kinds: [PendingGroup["what"], CopyKeyPair][] = [
    ["wiki", ["agents.restWikiOne", "agents.restWiki"]],
    ["chats", ["agents.restChatsOne", "agents.restChats"]],
    ["summaries", ["agents.restSummariesOne", "agents.restSummaries"]],
    ["maps", ["agents.restMapsOne", "agents.restMaps"]],
    ["other", ["agents.restOtherOne", "agents.restOther"]],
  ];
  for (const [what, [one, many]] of kinds) {
    const n = sumOf(rest.filter((g) => g.what === what));
    if (n > 0) parts.push(t(n === 1 ? one : many, { n: fmtN(n) }));
  }
  return listText(parts);
}
type CopyKeyPair = [Parameters<typeof t>[0], Parameters<typeof t>[0]];

/**
 * What the waiting work is, short: the main groups one line each (the biggest, then any holding a tenth of the work, at
 * most three), and one line that sums up all the others.
 */
export function waitingWhat(groups: readonly PendingGroup[]): { main: string[]; rest?: string } {
  const total = sumOf(groups);
  if (total === 0) return { main: [] };
  const sorted = [...groups].sort((a, b) => b.n - a.n);
  const main: PendingGroup[] = [];
  for (const g of sorted) {
    if (main.length >= WAITING_MAIN_MAX || (main.length > 0 && g.n < total * WAITING_MAIN_SHARE)) break;
    main.push(g);
  }
  const rest = sorted.slice(main.length);
  const out: { main: string[]; rest?: string } = { main: main.map(mainLine) };
  if (rest.length > 0) out.rest = t("agents.whatRest", { n: fmtN(sumOf(rest)), parts: restParts(rest) });
  return out;
}

export function WaitingWhat(p: { groups: readonly PendingGroup[] }): JSX.Element | null {
  const w = waitingWhat(p.groups);
  if (w.main.length === 0) return null;
  return (
    <div class="cx-waiting-what" aria-label={t("agents.whatTitle")}>
      <ul class="cx-waiting-main">
        {w.main.map((line) => (
          <li>{line}</li>
        ))}
      </ul>
      {w.rest ? <p class="cx-note">{w.rest}</p> : null}
    </div>
  );
}

function Ledger(p: { ledgerOn: boolean }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const fmt = useFmt();
  const activity = s.shared.slices.activity.value;
  const settings = s.settings.value;
  const state = chipState(activity, settings.agents.enabled);
  const canRun = (state === "idle") && !activity.settingsCorrupt;
  const runs = useLoad(() => (p.ledgerOn ? s.ledger.runs({ limit: 20_000 }) : s.ledger.runs({ limit: 1 })), [activity.jobs.length, activity.tokensToday]);
  const lastRun = runs.state === "ready" ? isoMs(runs.value[0]?.startedAt) : Number.NaN;
  const today = useLoad(() => s.ledger.budgetHistory(1), [activity.tokensToday, activity.jobs.length, activity.capped]);
  const usdSpent = today.state === "ready" ? (today.value[today.value.length - 1]?.usd ?? 0) : 0;
  const q = s.shared.slices.queues.value;
  const line = statusLine(state, activity, {
    claudePath: settings.agents.claudePath || "%USERPROFILE%/.local/bin/claude.exe",
    fmt,
    lastRun: Number.isFinite(lastRun) ? lastRun : undefined,
    waiting: q.label + q.summaries + q.maps,
    idleOnly: settings.agents.onlyWhenIdle,
  });
  const models = settings.agents.models;

  const togglePause = () => void s.settings.update((x) => void (x.agents.paused = !x.agents.paused));

  return (
    <section class="cx-ledger" aria-label={t("agents.ledger")}>
      <div class={`cx-status-card is-${line.tone}`} role="status">
        <Glyph size={20} spinning={state === "organising"} />
        <p class="cx-status-text">{line.text}</p>
        <div class="cx-status-actions">
          {state === "paused" || (settings.agents.paused && state !== "off") ? (
            <Button onClick={togglePause}>{t("agents.resume")}</Button>
          ) : state === "off" ? (
            <Button onClick={() => openCortexSettings(s.app, "agents")}>{t("agents.openSettings")}</Button>
          ) : (
            <Button onClick={togglePause}>{t("agents.pause")}</Button>
          )}
          {canRun ? (
            <Button primary onClick={() => s.clock.poke("manual")}>
              {t("agents.runNow")}
            </Button>
          ) : null}
        </div>
        {state !== "off" ? <WaitingWhat groups={q.groups ?? []} /> : null}
      </div>
      <p class="cx-note">{settings.agents.engine === "none" ? t("agents.engineLineNone") : settings.agents.engine === "codex-cli" ? t("agents.engineLineCodex") : t("agents.engineLine", { labels: models.labels, summaries: models.summaries, maps: models.maps })}</p>
      {activity.runner === "inline" ? <p class="cx-note">{t("agents.inlineLine")}</p> : null}
      <PlanMeters activity={activity} />
      {p.ledgerOn ? (
        <>
          <WorkWaiting fmt={fmt} />
          <Schemas />
          <Influence />
          <Packs />
          {state !== "off" ? <Budget activity={activity} usdSpent={usdSpent} runs={runs.state === "ready" ? runs.value : []} /> : null}
          <Last14 />
          <LabTables
            between={
              <Load value={runs} failed={t("errors.agents")}>
                {(all) => <RecentRuns runs={all} fmt={fmt} onAll={() => openPage(leaf.store, "runs", undefined, true)} />}
              </Load>
            }
          />
          <DirectionTrials />
          <DirectionsOut />
          <PrivacyLines />
        </>
      ) : null}
    </section>
  );
}

/**
 * The plan's two limits: how much of the 5-hour and the weekly limit is used (as Claude Code last reported it), the cap
 * agents stop at (a mark on the bar) and when each window resets, with the cap's own switch and slider beside it.
 */
function PlanMeters(p: { activity: ActivityState }): JSX.Element {
  const s = useServices();
  const settings = s.settings.value;
  const caps = settings.agents.planCaps;
  const setCap = (id: PlanWindowId, patch: { on?: boolean; pct?: number }) =>
    void s.settings.update((x) => {
      const c = x.agents.planCaps[id];
      if (patch.on !== undefined) c.on = patch.on;
      if (patch.pct !== undefined) c.pct = Math.round(patch.pct);
    });
  return (
    <section class="cx-plan" aria-label={t("plan.title")}>
      <div class="cx-section-label">
        <span>{t("plan.title")}</span>
      </div>
      {PLAN_WINDOWS.map((id) => {
        const cap = caps[id === "fiveHour" ? "fiveHour" : "weekly"];
        return <PlanMeter key={id} view={p.activity.plan[id]} on={cap.on} pct={cap.pct} onChange={(patch) => setCap(id, patch)} />;
      })}
      <p class="cx-note">{t("plan.note")}</p>
    </section>
  );
}

export function PlanMeter(p: { view: PlanWindowView; on: boolean; pct: number; onChange(patch: { on?: boolean; pct?: number }): void }): JSX.Element {
  const v = p.view;
  const used = v.pct === null ? 0 : Math.min(100, v.pct);
  const name = windowName(v.window);
  const label = t("plan.meterLabel", { name, used: v.pct === null ? t("plan.unknown") : pctText(v.pct) });
  const marker = p.on ? Math.min(100, Math.max(0, p.pct)) : null;
  return (
    <div class={`cx-plan-meter${v.atCap ? " is-at-cap" : ""}`} data-window={v.window}>
      <div class="cx-plan-head">
        <span class="cx-plan-name">{name}</span>
        <span class="cx-plan-value cx-mono">{v.pct === null ? "—" : pctText(v.pct)}</span>
      </div>
      <div class="cx-meter cx-plan-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(used)} aria-label={label}>
        <span style={{ width: `${used}%` }} />
        {marker !== null ? <i class="cx-plan-mark" style={{ left: `${marker}%` }} aria-hidden="true" /> : null}
      </div>
      <p class="cx-note cx-plan-line">{windowLine({ ...v, capPct: p.on ? p.pct : null })}</p>
      <div class="cx-plan-cap">
        <Toggle inline label={t("plan.capToggle")} checked={p.on} onChange={(on) => p.onChange({ on })} />
        <Slider label={t("plan.capSlider")} value={p.pct} min={SETTING_RANGES.planCapPct[0]} max={SETTING_RANGES.planCapPct[1]} step={1} format={(x) => `${Math.round(x)}%`} disabled={!p.on} onInput={(x) => p.onChange({ pct: x })} />
      </div>
    </div>
  );
}

/** What was spent today, shown for information (there is no spending limit): tokens and dollars at list prices, and the last pass. */
function Budget(p: { activity: ActivityState; usdSpent: number; runs: readonly RunRecord[] }): JSX.Element {
  const a = p.activity;
  const last = p.runs[0];
  const lastCost = last ? (last.where === "this computer" ? t("agents.budgetLastLocal") : t("agents.budgetLastCost", { cost: fmtUsd(last.costUsd) })) : "";
  return (
    <section class="cx-budget" aria-label={t("agents.budgetTitle")}>
      <div class="cx-section-label">
        <span>{t("agents.budgetTitle")}</span>
      </div>
      <p class="cx-budget-line cx-mono">{t("agents.budgetSpent", { tokens: fmtInt(a.tokensToday), usd: fmtUsd(a.usdToday > 0 ? a.usdToday : p.usdSpent) })}</p>
      <p class="cx-budget-line">{last ? t("agents.budgetLast", { job: jobLabel(last.job), labels: fmtInt(last.labels), cost: lastCost }) : t("agents.budgetLastNone")}</p>
    </section>
  );
}

/** What the agents leave as it is, named so the counts above are not mistaken for a backlog they will clear. */
export function leftAloneLine(left: { sessions: number; notes: number }): string {
  const parts = [
    ...(left.sessions > 0 ? [t("agents.leftSessions", { n: left.sessions.toLocaleString("en-GB") })] : []),
    ...(left.notes > 0 ? [t("agents.leftNotes", { n: left.notes.toLocaleString("en-GB") })] : []),
  ];
  return t("agents.leftAlone", { parts: parts.join(" · ") });
}

function WorkWaiting(p: { fmt: Fmt }): JSX.Element {
  const s = useServices();
  const q = s.shared.slices.queues.value;
  const waiting = useLoad(() => s.ledger.workWaiting(), [q.label, q.summaries, q.checks]);
  return (
    <section class="cx-work-waiting" aria-label={t("agents.waitingTitle")}>
      <div class="cx-section-label">
        <span>{t("agents.waitingTitle")}</span>
        <WaitingSince value={waiting} fmt={p.fmt} />
      </div>
      <Load value={waiting} failed={t("errors.agents")} rows={3}>
        {(w) => (
          <>
            <p class="cx-note cx-mono">{t("agents.waitingLine", { label: w.queues.label.toLocaleString("en-GB"), summaries: w.queues.summaries.toLocaleString("en-GB"), checks: w.queues.checks.toLocaleString("en-GB") })}</p>
            {w.leftAlone ? <p class="cx-note">{leftAloneLine(w.leftAlone)}</p> : null}
            <ul class="cx-stack-bars">
              {w.bySource.map((b) => {
                const total = Math.max(1, b.checked + b.done + b.waiting);
                const tip = t("agents.sourceBar", { source: b.source, checked: b.checked, done: b.done, waiting: b.waiting });
                return (
                  <li title={tip} aria-label={tip}>
                    <span class="cx-stack-name">{b.source}</span>
                    <span class="cx-stack-bar">
                      <span class="is-checked" style={{ width: `${(b.checked / total) * 100}%` }} />
                      <span class="is-done" style={{ width: `${(b.done / total) * 100}%` }} />
                      <span class="is-waiting" style={{ width: `${(b.waiting / total) * 100}%` }} />
                    </span>
                  </li>
                );
              })}
            </ul>
            <p class="cx-stack-key cx-note">
              <span class="is-checked">{t("agents.checkedByYou")}</span> · <span class="is-done">{t("agents.done")}</span> · <span class="is-waiting">{t("agents.queued")}</span>
            </p>
          </>
        )}
      </Load>
    </section>
  );
}

function WaitingSince(p: { value: Loadable<{ since?: string }>; fmt: Fmt }): JSX.Element | null {
  const v = p.value;
  if (v.state !== "ready" || !v.value.since) return null;
  return <span class="cx-section-right">{t("agents.since", { date: p.fmt.date(isoMs(v.value.since), true) })}</span>;
}

function RecentRuns(p: { runs: readonly RunRecord[]; fmt: Fmt; onAll(): void }): JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const shown = p.runs.slice(0, 8);
  return (
    <section class="cx-recent-runs" aria-label={t("agents.runs")}>
      <div class="cx-section-label">
        <span>{t("agents.runs")}</span>
        {p.runs.length > shown.length ? (
          <button type="button" class="cx-text-button" onClick={p.onAll}>
            {t("agents.all", { n: p.runs.length.toLocaleString("en-GB") })}
          </button>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <p class="cx-note">{t("agents.noRuns")}</p>
      ) : (
        <>
          <p class="cx-note cx-runs-summary">{runsSummaryLine(p.runs)}</p>
          <ul class="cx-run-list">
            {shown.map((r) => {
              const expanded = open === r.id;
              return (
                <li key={r.id}>
                  <button type="button" class="cx-run-line-row" aria-expanded={expanded} title={expanded ? t("agents.collapse") : t("agents.expand")} onClick={() => setOpen(expanded ? null : r.id)}>
                    <StatusPill state={PILL[runResult(r)]}>{runResultLabel(runResult(r))}</StatusPill>
                    <span class="cx-run-text">
                      <span class="cx-mono">{runOneLine(r, p.fmt)}</span>
                      <span class="cx-note cx-run-cost">{runCostLine(r)}</span>
                    </span>
                  </button>
                  {expanded ? (
                    <div class="cx-run-detail-box">
                      <RunDetail run={r} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/** The expanded run: counts and the "label@1.0.0 · 1,840 in / 212 out · 41 s · from the plugin" line. */
export function RunDetail(p: { run: RunRecord }): JSX.Element {
  const r = p.run;
  const started = isoMs(r.startedAt);
  const finished = isoMs(r.finishedAt);
  const seconds = Number.isFinite(finished) && Number.isFinite(started) ? Math.max(0, Math.round((finished - started) / 1000)) : 0;
  return (
    <dl class="cx-run-facts">
      <dt>{t("agents.items")}</dt>
      <dd class="cx-mono">{fmtInt(r.items)}</dd>
      <dt>{t("agents.labels")}</dt>
      <dd class="cx-mono">{fmtInt(r.labels)}</dd>
      <dt>{t("agents.declined")}</dt>
      <dd class="cx-mono">{fmtInt(r.declined)}</dd>
      <dt>{t("agents.noAnswer")}</dt>
      <dd class="cx-mono">{fmtInt(r.noAnswer)}</dd>
      <dd class="cx-run-line cx-mono">{t("agents.runLine", { prompt: r.promptVersion, in: fmtInt(r.tokensIn), out: fmtInt(r.tokensOut), s: seconds, origin: r.pack ? t("agents.fromSkill") : t("agents.fromPlugin") })}</dd>
      <dd class="cx-note">{r.tokensEstimated ? t("runs.estimated") : fmtDuration(seconds * 1000)}</dd>
      {r.where === "this computer" ? <dd class="cx-note cx-run-local">{t("runs.ranLocal")}</dd> : null}
    </dl>
  );
}

/** Token id of the pack whose entries are lit. */
export const PACK_TOKEN_PREFIX = "lab:pack:";

/** The group token that lights every entry labelled by one pack version (the worker reads `label:<pack>/*`). */
export function packToken(pack: string, version: string): { id: string; kind: "group"; dim: `label:${string}/*`; value: string; label: string } {
  return { id: `${PACK_TOKEN_PREFIX}${pack}@${version}`, kind: "group", dim: `label:${pack}/*`, value: version, label: t("agents.packToken", { pack: `${pack} ${version}` }) };
}

function Packs(): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const lit = leaf.store.slices.ui.value.tokens.find((x) => x.id.startsWith(PACK_TOKEN_PREFIX))?.id ?? null;
  const lightPack = (pack: string, version: string) => {
    const tok = packToken(pack, version);
    const was = lit === tok.id;
    for (const x of leaf.store.slices.ui.value.tokens) if (x.id.startsWith(PACK_TOKEN_PREFIX) || x.id.startsWith(MAKER_TOKEN_PREFIX)) removeToken(leaf.store, x.id);
    if (!was) addToken(leaf.store, tok);
  };
  const [superseded, setSuperseded] = useState(false);
  const [sort, setSort] = useState<PackSort>(PACK_SORT_DEFAULT);
  const unanswered = useLoad<Record<string, number>>(() => Promise.resolve().then(() => s.ledger.packsUnanswered()).catch(() => ({})), [s.shared.slices.queues.value.label]);
  const blankBy = unanswered.state === "ready" ? unanswered.value : {};
  const packs = useLoad<PacksStats>(
    async (signal) => {
      const res = await s.worker.call("agents#packs", "stats", { kind: "packs", includeSuperseded: superseded }, { signal });
      if (res.kind !== "packs") throw new Error("unexpected stats result");
      return res;
    },
    [superseded, s.shared.slices.queues.value.label],
  );
  return (
    <section class="cx-packs" aria-label={t("agents.packs")}>
      <div class="cx-section-label">
        <span>{t("agents.packs")}</span>
        <button type="button" class="cx-text-button" onClick={() => openCortexSettings(s.app, "agents")}>
          {t("agents.manage")}
        </button>
      </div>
      <p class="cx-note">{t("agents.packHint")}</p>
      <Toggle label={t("agents.superseded")} checked={superseded} onChange={setSuperseded} />
      <Load value={packs} failed={t("errors.agents")} rows={3}>
        {(res) => res.packs.length === 0 ? (
          <p class="cx-note">{t("agents.packsEmpty")}</p>
        ) : (
          <>
            <PacksTable rows={sortPackRows(packTableRows(res.packs, blankBy), sort)} sort={sort} onSort={setSort} litKey={lit === null ? null : lit.slice(PACK_TOKEN_PREFIX.length)} onLight={(r) => lightPack(r.pack, r.version)} />
            {supersededNote(res.supersededLabels, superseded) ? <p class="cx-note cx-superseded-note">{supersededNote(res.supersededLabels, superseded)}</p> : null}
          </>
        )}
      </Load>
    </section>
  );
}

/** The two ledger tables share one read of the runs ledger (it is re-read on every finished call). */
function LabTables(p: { between?: JSX.Element }): JSX.Element {
  const s = useServices();
  const runs = useLoad(() => s.ledger.runs({ limit: 20_000 }), [s.shared.slices.activity.value.tokensToday, s.shared.slices.activity.value.jobs.length]);
  return (
    <>
      <SpendByDay runs={runs} />
      {p.between ?? null}
      <ConversationsTagged runs={runs} />
    </>
  );
}

function SpendByDay(p: { runs: Loadable<RunRecord[]> }): JSX.Element {
  const fmt = useFmt();
  const runs = p.runs;
  return (
    <section class="cx-spend" aria-label={t("agents.spendTitle")}>
      <div class="cx-section-label">
        <span>{t("agents.spendTitle")}</span>
      </div>
      <Load value={runs} failed={t("errors.agents")} rows={2}>
        {(all) => {
          const days = spendByDay(all, 14);
          return days.length === 0 ? (
            <p class="cx-note">{t("agents.spendEmpty")}</p>
          ) : (
            <table class="cx-table">
              <thead>
                <tr>
                  <th scope="col">{t("agents.spendDay")}</th>
                  <th scope="col">{t("agents.spendSpent")}</th>
                  <th scope="col">{t("agents.spendCalls")}</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr>
                    <th scope="row">{fmt.date(isoMs(`${d.day}T12:00:00`))}</th>
                    <td class="cx-mono">{fmtSpend(d.spent)}</td>
                    <td class="cx-mono">{fmtInt(d.calls)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }}
      </Load>
    </section>
  );
}

const NOW_KEYS: Readonly<Record<TaggedNow, "agents.nowFinished" | "agents.nowRunning" | "agents.nowStopped" | "agents.nowNone" | "agents.nowFailed" | "agents.nowCapped">> = {
  finished: "agents.nowFinished",
  running: "agents.nowRunning",
  stopped: "agents.nowStopped",
  none: "agents.nowNone",
  failed: "agents.nowFailed",
  capped: "agents.nowCapped",
};

const PAID_KEYS: Readonly<Record<PaidBy, "agents.paidPlan" | "agents.paidApi" | "agents.paidNone" | "agents.paidMixed">> = {
  plan: "agents.paidPlan",
  api: "agents.paidApi",
  none: "agents.paidNone",
  mixed: "agents.paidMixed",
};

function ConversationsTagged(p: { runs: Loadable<RunRecord[]> }): JSX.Element {
  const runs = p.runs;
  return (
    <section class="cx-tagged" aria-label={t("agents.taggedTitle")}>
      <div class="cx-section-label">
        <span>{t("agents.taggedTitle")}</span>
      </div>
      <Load value={runs} failed={t("errors.agents")} rows={2}>
        {(all) => {
          const rows = taggedRows(all);
          return rows.length === 0 ? (
            <p class="cx-note">{t("agents.taggedEmpty")}</p>
          ) : (
            <table class="cx-table">
              <thead>
                <tr>
                  <th scope="col">{t("agents.taggedBy")}</th>
                  <th scope="col">{t("agents.taggedPaidBy")}</th>
                  <th scope="col">{t("agents.taggedConversations")}</th>
                  <th scope="col">{t("agents.taggedTagged")}</th>
                  <th scope="col">{t("agents.taggedRefused")}</th>
                  <th scope="col">{t("agents.taggedNow")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr>
                    <th scope="row">{r.pack ? `${r.model} · ${r.pack}` : r.model}</th>
                    <td>{t(PAID_KEYS[r.paidBy])}</td>
                    <td class="cx-mono">{fmtInt(r.conversations)}</td>
                    <td class="cx-mono">{fmtInt(r.tagged)}</td>
                    <td class="cx-mono">{fmtInt(r.refused)}</td>
                    <td>{t(NOW_KEYS[r.now])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }}
      </Load>
    </section>
  );
}

function Last14(): JSX.Element {
  const s = useServices();
  const days = useLoad(() => s.ledger.budgetHistory(14), [s.shared.slices.activity.value.tokensToday]);
  return (
    <section class="cx-last14" aria-label={t("agents.last14")}>
      <div class="cx-section-label">
        <span>{t("agents.last14")}</span>
        <span class="cx-section-right cx-mono">{t("agents.spendBars")}</span>
      </div>
      <Load value={days} failed={t("errors.agents")} rows={2}>
        {(list) => {
          const max = Math.max(...list.map((d) => d.tokens), 1);
          return (
            <div class="cx-bars" role="img" aria-label={t("agents.last14")}>
              {list.map((d) => {
                const tip = d.capped ? t("agents.dayCapped", { day: d.day, tokens: fmtInt(d.tokens) }) : t("agents.dayTip", { day: d.day, tokens: fmtInt(d.tokens) });
                return <span class={`cx-bar${d.capped ? " is-capped" : ""}`} style={{ height: `${Math.max(2, (d.tokens / max) * 100)}%` }} title={tip} aria-label={tip} />;
              })}
            </div>
          );
        }}
      </Load>
    </section>
  );
}

function PrivacyLines(): JSX.Element {
  const leaf = useLeaf();
  return (
    <section class="cx-agents-privacy" aria-label={t("agents.privacyTitle")}>
      <div class="cx-section-label">
        <span>{t("agents.privacyTitle")}</span>
      </div>
      <p class="cx-note">{t("agents.privacyWithheld")}</p>
      <p class="cx-note">{t("agents.privacyLogged")}</p>
      <button type="button" class="cx-text-button" onClick={() => openPage(leaf.store, "sources", { tab: "privacy" })}>
        {t("agents.offLimits")}
      </button>
    </section>
  );
}
