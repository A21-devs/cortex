/**
 * You (rail destination; SPEC V16 in Cortex's own words): how much of the record is in your voice, and what is open
 * for you. Four blocks, every number from data Cortex already holds:
 *  - Hero and speaker bar: entries whose speaker is you, against everything, overall, by source and by month. One
 *    pass over the loaded index's columns (`youStats`, cached per index). Written entries count as yours; hidden
 *    material (excluded, reference, subagent and automated traffic) is left out, as everywhere else.
 *  - Open for you: whether Settings names you, and the unresolved checks (shared queues), with a link to Review.
 *  - Dates you can rely on: the runner's `seals.status` (blocks sealed on this computer, whether the chain is
 *    intact, the newest public fingerprint). Not asked in the sample record.
 *  - Models that have read it: the access log aggregates (`ledger.accessLog()`), with a link to the full log.
 * It renders with the sample record (the same index columns) and with no index at all (the hero says so).
 */
import type { JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import { acceptedDirections } from "../../shared/directions";
import { featureOn } from "../../shared/features";
import { ItemFlag, Population, SOURCE_ORDER, SPEAKER_ORDER, type DataIndex } from "../../shared/index-format";
import { openPage } from "../../state/actions";
import { useLeaf, useServices, useShell, num } from "../context";
import { t } from "../copy";
import { confirm } from "../modals/ConfirmModal";
import { openNavItem } from "../nav/navModel";
import { fmtDate, isoMs, sourceLabel } from "../valueLabels";
import { routeText } from "./AccessLog";
import { Load, PageFrame, openCortexSettings, useFmt, useLoad } from "./PageFrame";
import { useIndex } from "../reader/readerKit";

const SPEAKER_YOU = SPEAKER_ORDER.indexOf("you");
const SPEAKER_ASSISTANT = SPEAKER_ORDER.indexOf("assistant");
const SOURCE_WRITTEN = SOURCE_ORDER.indexOf("written");
/** Material that is not part of the record by default (the same set the Layers menu keeps off). */
const LEFT_OUT = ItemFlag.Excluded | ItemFlag.Reference | ItemFlag.HiddenByDefault;
/** Months shown in the by-month list. */
export const YOU_MONTHS = 12;

export interface YouShareRow {
  key: string;
  total: number;
  you: number;
}

export interface YouStats {
  total: number;
  you: number;
  assistants: number;
  others: number;
  /** One row per source with entries, largest first. */
  bySource: YouShareRow[];
  /** One row per month with a dated entry, oldest first ("2026-04"). */
  byMonth: YouShareRow[];
}

const cache = new WeakMap<DataIndex, YouStats>();

/** Your share of the record's entries, overall and by source and month: one pass over the index columns. */
export function youStats(ix: DataIndex): YouStats {
  const hit = cache.get(ix);
  if (hit) return hit;
  const { pop, speaker, source, flags, t: when } = ix.cols;
  let total = 0, you = 0, assistants = 0;
  const bySource = new Map<number, YouShareRow>();
  const byMonth = new Map<string, YouShareRow>();
  for (let i = 0; i < ix.count; i++) {
    if (pop[i] !== Population.Record) continue;
    const f = flags[i] ?? 0;
    if (f & LEFT_OUT) continue;
    const src = source[i] ?? 0;
    const mine = speaker[i] === SPEAKER_YOU || src === SOURCE_WRITTEN;
    total++;
    if (mine) you++;
    else if (speaker[i] === SPEAKER_ASSISTANT) assistants++;
    let s = bySource.get(src);
    if (!s) bySource.set(src, (s = { key: SOURCE_ORDER[src] ?? "", total: 0, you: 0 }));
    s.total++;
    if (mine) s.you++;
    const ms = when[i] ?? Number.NaN;
    if (f & ItemFlag.Undated || !Number.isFinite(ms)) continue;
    const d = new Date(ms);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    let m = byMonth.get(key);
    if (!m) byMonth.set(key, (m = { key, total: 0, you: 0 }));
    m.total++;
    if (mine) m.you++;
  }
  const out: YouStats = {
    total,
    you,
    assistants,
    others: total - you - assistants,
    bySource: [...bySource.values()].filter((r) => r.key !== "").sort((a, b) => b.total - a.total),
    byMonth: [...byMonth.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  };
  cache.set(ix, out);
  return out;
}

export function pct(you: number, total: number): number {
  return total > 0 ? Math.round((you / total) * 100) : 0;
}

/** "Apr 2026" for a "2026-04" month key. */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

function ShareRow(p: { label: string; row: YouShareRow; aria: string }): JSX.Element {
  const share = pct(p.row.you, p.row.total);
  return (
    <li class="cx-you-row" aria-label={p.aria}>
      <span class="cx-you-row-name">{p.label}</span>
      <span class="cx-you-meter" aria-hidden="true">
        <span class="cx-you-meter-fill" style={{ width: `${share}%` }} />
      </span>
      <span class="cx-you-row-value">{share}%</span>
    </li>
  );
}

/** Run a Cortex command by id (the one dispatch path: palette, menu and buttons). */
function runCortexCommand(app: unknown, id: string): void {
  (app as { commands?: { executeCommandById?(id: string): boolean } }).commands?.executeCommandById?.(`cortex:${id}`);
}

export function You(_p: { params?: Readonly<Record<string, string>> } = {}): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const fmt = useFmt();
  const ix = useIndex(s);
  const stats = useMemo(() => (ix ? youStats(ix) : null), [ix]);
  const sandbox = s.sandbox.value;
  const settings = s.settings.value;
  const checks = featureOn("checks") ? s.shared.slices.queues.value.checks : 0;
  const named = settings.you.names.length + settings.you.handles.length;
  const shell = useShell();
  const [sealTick, setSealTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const seals = useLoad(() => (sandbox ? Promise.resolve(null) : s.runner.request({ cmd: "seals.status", args: {} })), [sandbox, sealTick]);
  const readers = useLoad(() => (sandbox ? Promise.resolve([]) : s.ledger.accessLog()), [sandbox]);
  // Drafted directions: the ones still waiting in Checks, and how many you have accepted.
  const directions = useLoad(async () => {
    if (sandbox || !featureOn("checks")) return { waiting: 0, accepted: 0 };
    const waiting = (await s.ledger.checks({ kind: "direction", limit: 5000 })).length;
    let accepted = 0;
    try {
      accepted = acceptedDirections(s.corrections.list()).length;
    } catch {
      accepted = 0;
    }
    return { waiting, accepted };
  }, [sandbox, checks]);
  const drafts = directions.state === "ready" ? directions.value : directions.state === "loading" ? (directions.previous ?? { waiting: 0, accepted: 0 }) : { waiting: 0, accepted: 0 };
  const date = (iso: string) => fmtDate(isoMs(iso), fmt.format);

  // "Check public timestamps": the dialog says exactly what leaves this computer; declining sends nothing.
  const checkStamps = async (): Promise<void> => {
    if (busy) return;
    if (!(await confirm(s.app, { title: t("you.checkConfirm"), body: t("you.checkWhat"), confirm: t("you.checkSend"), cancel: t("dialogs.cancel") }))) return;
    setBusy(true);
    try {
      const r = await s.runner.request({ cmd: "seals.check", args: {} });
      shell.notify(r.confirmed > 0 && r.height !== undefined ? t("you.checkDone", { height: String(r.height) }) : r.checked === 0 && r.pending === 0 ? t("you.checkNone") : r.failed > 0 || r.unreachable ? t("you.checkFailed") : t("you.checkWaiting"), { kind: "info", ttl: 6000 });
      setSealTick((n) => n + 1);
    } catch {
      shell.notify(t("you.checkFailed"), { kind: "info", ttl: 6000 });
    } finally {
      setBusy(false);
    }
  };
  const copyProof = async (): Promise<void> => {
    try {
      const r = await s.runner.request({ cmd: "seals.proof", args: {} });
      await navigator.clipboard.writeText(r.json);
      shell.notify(t("you.proofCopied", { n: String(r.n) }), { kind: "info", ttl: 6000 });
    } catch {
      shell.notify(t("you.proofFailed"), { kind: "info", ttl: 6000 });
    }
  };
  const toReview = () => openNavItem(leaf.store, "review", { add: () => undefined, ask: () => undefined });
  const toDirections = () => openPage(leaf.store, "agents", { tab: "checks", filter: "directions" }, true);
  const toAccess = () => openPage(leaf.store, "agents", { tab: "access" }, true);
  const total = stats?.total ?? 0;
  const youPct = pct(stats?.you ?? 0, total);
  const months = stats ? stats.byMonth.slice(-YOU_MONTHS) : [];

  return (
    <PageFrame subtitle={t("you.subtitle")} label={t("pages.you")}>
      <section class="cx-you-hero" aria-label={t("pages.you")}>
        {stats && total > 0 ? (
          <>
            <div class="cx-you-pct">{youPct}%</div>
            <p class="cx-you-caption">{t("you.heroLabel")}</p>
            <div
              class="cx-you-bar"
              role="img"
              aria-label={t("you.barLabel", { you: num(stats.you), assistants: num(stats.assistants), others: num(stats.others) })}
            >
              <span class="is-you" style={{ flexGrow: stats.you }} />
              <span class="is-assistant" style={{ flexGrow: stats.assistants }} />
              <span class="is-other" style={{ flexGrow: stats.others }} />
            </div>
            <p class="cx-you-legend">
              <span class="is-you">{t("you.legendYou")} {num(stats.you)}</span>
              <span class="is-assistant">{t("you.legendAssistants")} {num(stats.assistants)}</span>
              <span class="is-other">{t("you.legendOthers")} {num(stats.others)}</span>
            </p>
          </>
        ) : (
          <p class="cx-note">{t("you.heroEmpty")}</p>
        )}
      </section>

      {stats && stats.bySource.length > 0 ? (
        <section class="cx-you-block" aria-label={t("you.bySource")}>
          <h3 class="cx-section-label">{t("you.bySource")}</h3>
          <ul class="cx-you-list">
            {stats.bySource.map((r) => (
              <ShareRow key={r.key} row={r} label={sourceLabel(r.key)} aria={t("you.sourceRow", { source: sourceLabel(r.key), p: pct(r.you, r.total), n: num(r.total) })} />
            ))}
          </ul>
        </section>
      ) : null}

      {months.length > 0 ? (
        <section class="cx-you-block" aria-label={t("you.byMonth")}>
          <h3 class="cx-section-label">
            {t("you.byMonth")}
            {stats && stats.byMonth.length > YOU_MONTHS ? <span class="cx-section-right">{t("you.monthsShown", { n: YOU_MONTHS })}</span> : null}
          </h3>
          <ul class="cx-you-list">
            {months.map((r) => (
              <ShareRow key={r.key} row={r} label={monthLabel(r.key)} aria={t("you.monthRow", { month: monthLabel(r.key), p: pct(r.you, r.total), n: num(r.total) })} />
            ))}
          </ul>
        </section>
      ) : null}

      <section class="cx-you-block" aria-label={t("you.open")}>
        <h3 class="cx-section-label">{t("you.open")}</h3>
        <ul class="cx-you-facts">
          <li>
            {named === 0 ? t("you.namesUnset") : t("you.namesSet", { n: named })}{" "}
            <button type="button" class="cx-text-button" onClick={() => openCortexSettings(s.app, "privacy")}>
              {t("you.namesLink")}
            </button>
          </li>
          <li>
            {checks > 0 ? t("you.checksOpen", { n: num(checks) }) : t("you.checksNone")}
            {checks > 0 && featureOn("checks") ? (
              <>
                {" "}
                <button type="button" class="cx-text-button" onClick={toReview}>
                  {t("you.openReview")}
                </button>
              </>
            ) : null}
          </li>
          {drafts.waiting > 0 ? (
            <li>
              {t(drafts.waiting === 1 ? "you.directionsItemOne" : "you.directionsItem", { n: num(drafts.waiting) })}{" "}
              <button type="button" class="cx-text-button" onClick={toDirections}>
                {t("you.directionsOpen")}
              </button>
            </li>
          ) : null}
        </ul>
      </section>

      {featureOn("checks") ? (
        <section class="cx-you-block" aria-label={t("you.directions")}>
          <h3 class="cx-section-label">{t("you.directions")}</h3>
          <p class="cx-note">
            {drafts.waiting > 0 ? t(drafts.waiting === 1 ? "you.directionsWaitingOne" : "you.directionsWaiting", { n: num(drafts.waiting) }) : t("you.directionsNone")}
            {drafts.accepted > 0 ? ` ${t("you.directionsAccepted", { n: num(drafts.accepted) })}` : ""}
          </p>
          {drafts.waiting > 0 ? (
            <button type="button" class="cx-text-button" onClick={toDirections}>
              {t("you.directionsOpen")}
            </button>
          ) : null}
        </section>
      ) : null}

      <section class="cx-you-block" aria-label={t("you.dates")}>
        <h3 class="cx-section-label">{t("you.dates")}</h3>
        {sandbox ? (
          <p class="cx-note">{t("you.datesSample")}</p>
        ) : (
          <Load value={seals} failed={t("you.failed")} rows={2}>
            {(st) => {
              if (!st) return <p class="cx-note">{t("you.datesSample")}</p>;
              if (st.blocks === 0) return <p class="cx-note">{settings.advanced.dateSeals.sealLocally ? t("you.sealedNone") : t("you.datesOff")}</p>;
              const last = st.lastAt ? date(st.lastAt) : "";
              const waiting = st.pending ?? 0;
              return (
                <>
                  {last ? (
                    <p class="cx-you-sealed">
                      <span class="cx-chip cx-sealed-chip">{t("you.sealedThrough", { date: last })}</span>
                    </p>
                  ) : null}
                  <ul class="cx-you-facts">
                    <li>{t(st.intact ? "you.sealed" : "you.sealedBroken", { n: num(st.entries), b: num(st.blocks), date: last })}</li>
                    {st.key ? <li>{t("you.keyLine", { key: st.key })}</li> : null}
                    <li>{st.published ? t("you.anchored", { date: date(st.published.at) }) : t("you.notAnchored")}</li>
                    {st.confirmed ? <li>{t("you.confirmedLine", { height: String(st.confirmed.height), date: date(st.confirmed.at) })}</li> : null}
                    {waiting > 0 ? <li>{t(waiting === 1 ? "you.waitingOne" : "you.waitingMany", { n: num(waiting) })}</li> : null}
                    {settings.advanced.dateSeals.weeklyStamp ? <li>{t("you.weeklyOn")}</li> : null}
                  </ul>
                  <div class="cx-you-actions">
                    {st.published && waiting > 0 ? (
                      <button type="button" class="cx-text-button" disabled={busy} onClick={() => void checkStamps()}>
                        {busy ? t("you.checking") : t("you.checkStamps")}
                      </button>
                    ) : null}
                    <button type="button" class="cx-text-button" onClick={() => void copyProof()}>
                      {t("you.copyProof")}
                    </button>
                  </div>
                </>
              );
            }}
          </Load>
        )}
      </section>

      <section class="cx-you-block" aria-label={t("proof.heading")}>
        <h3 class="cx-section-label">{t("proof.heading")}</h3>
        <p class="cx-note">{sandbox ? t("proof.sample") : t("proof.sub")}</p>
        {sandbox ? null : (
          <>
            <ul class="cx-you-facts">
              <li>{t("proof.auditPackDesc")}</li>
              <li>{t("proof.exportRecordDesc")}</li>
            </ul>
            <div class="cx-you-actions">
              <button type="button" class="cx-text-button" onClick={() => runCortexCommand(s.app, "audit-pack")}>
                {t("proof.auditPack")}
              </button>
              <button type="button" class="cx-text-button" onClick={() => runCortexCommand(s.app, "export-record")}>
                {t("proof.exportRecord")}
              </button>
              <button type="button" class="cx-text-button" onClick={() => runCortexCommand(s.app, "open-export")}>
                {t("proof.openExport")}
              </button>
            </div>
            <p class="cx-note">{t("proof.openVerifier")}</p>
          </>
        )}
      </section>

      <section class="cx-you-block" aria-label={t("you.readers")}>
        <h3 class="cx-section-label">{t("you.readers")}</h3>
        {sandbox ? (
          <p class="cx-note">{t("you.readersSample")}</p>
        ) : (
          <Load value={readers} failed={t("you.failed")} rows={2}>
            {(rows) =>
              rows.length === 0 ? (
                <p class="cx-note">{t("you.readersNone")}</p>
              ) : (
                <>
                  <ul class="cx-you-facts">
                    {rows.map((r) => (
                      <li key={`${r.model}:${r.route}`}>{t("you.readerRow", { model: r.model, route: routeText(r.route), n: num(r.itemsRead), date: date(r.last) })}</li>
                    ))}
                  </ul>
                  <button type="button" class="cx-text-button" onClick={toAccess}>
                    {t("you.openAccess")}
                  </button>
                </>
              )
            }
          </Load>
        )}
      </section>
    </PageFrame>
  );
}
