/**
 * Agents › Access log (CORTEX-UX §5.20; ORIG-01 moved the read log here): a sortable table Model · Route · Items
 * read · First · Last, e.g. "claude-haiku-4.5 · Claude Code → Anthropic · 41,208 · 9 Oct · today 14:22". Route
 * names where the text went. Retention follows Settings › Privacy › "Keep the access log". Data:
 * LedgerService.accessLog() (aggregates of `reads/` in the local cache). Owner: E12.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { AccessRow } from "../../plugin/services";
import type { RunnerResultMap } from "../../shared/protocol/runner";
import { addToken } from "../../state/actions";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import { fmtInt, isoMs } from "../valueLabels";
import { ConsentLog } from "./agents/ConsentLog";
import { ScreenedList } from "./agents/ScreenedList";
import { Load, useFmt, useLoad } from "./PageFrame";

export type AccessSort = "model" | "route" | "itemsRead" | "first" | "last";

export function sortAccess(rows: readonly AccessRow[], by: AccessSort, desc = true): AccessRow[] {
  const dir = desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = a[by], y = b[by];
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
  });
}

/** Where the text went, in words: "Claude Code → Anthropic" or "this computer". */
export function routeText(route: string): string {
  return route === "local" || route === "this computer" ? t("agents.routeLocal") : route === "remote" || route === "claude-cli" ? t("agents.routeAnthropic") : route;
}

type OutwardRows = NonNullable<RunnerResultMap["seals.status"]["outward"]>;
/** Rows that describe what was sent out (they have no reads to trace). */
const outwardRows = new WeakSet<AccessRow>();

/**
 * Timestamp traffic as access rows: what leaves this computer for the timestamp calendar and the block service is
 * a route like any other, named with what was sent (a fingerprint, one hash, a block number: never text).
 */
export function outwardAccessRows(out: OutwardRows): AccessRow[] {
  return out.map((o) => {
    const kind = o.kind === "stamp" ? "Stamp" : o.kind === "check" ? "Check" : "Header";
    const label = t(`agents.out${kind}` as "agents.outStamp");
    const row: AccessRow = {
      model: o.auto > 0 ? t("agents.outAuto", { label, n: String(o.auto) }) : label,
      route: t(`agents.out${kind}Route` as "agents.outStampRoute", { host: o.to }),
      itemsRead: o.count,
      first: o.first,
      last: o.last,
    };
    outwardRows.add(row);
    return row;
  });
}

export function AccessLog(): JSX.Element {
  const s = useServices();
  const fmt = useFmt();
  const sandbox = s.sandbox.value;
  const rows = useLoad(async () => {
    const reads = await s.ledger.accessLog();
    if (sandbox) return reads;
    let sent: AccessRow[] = [];
    try {
      sent = outwardAccessRows((await s.runner.request({ cmd: "seals.status", args: {} })).outward ?? []);
    } catch {
      sent = []; // the runner is not up: the model reads still show
    }
    return [...reads, ...sent];
  }, [sandbox]);
  const [sort, setSort] = useState<{ by: AccessSort; desc: boolean }>({ by: "last", desc: true });
  const leaf = useLeaf();
  const traceRead = async (r: AccessRow): Promise<void> => {
    try {
      const got = await s.ledger.accessIds(r.model, r.route);
      const ids = [...got.entries, ...got.notes];
      if (ids.length > 0) addToken(leaf.store, { id: `set:read:${r.model}:${r.route}`, kind: "set", label: t("agents.traceRead", { model: r.model }), ids });
    } catch (e) {
      s.log.warn("access trace failed", { error: String(e) });
    }
  };
  const retention = s.settings.value.privacy.accessLogRetention;
  const period = retention === "forever" ? t("agents.retentionForever") : retention === "1y" ? t("agents.retentionYear") : t("agents.retentionDays");
  const head = (by: AccessSort, label: string) => (
    <th scope="col" aria-sort={sort.by === by ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" class="cx-text-button" title={t("agents.sortBy", { column: label })} onClick={() => setSort((cur) => ({ by, desc: cur.by === by ? !cur.desc : true }))}>
        {label}
      </button>
    </th>
  );
  return (
    <section class="cx-access-log" aria-label={t("agents.access")}>
      <Load value={rows} failed={t("errors.access")} rows={4}>
        {(all) =>
          all.length === 0 ? (
            <p class="cx-note">{t("agents.accessEmpty")}</p>
          ) : (
            <table class="cx-table">
              <thead>
                <tr>
                  {head("model", t("agents.accessModel"))}
                  {head("route", t("agents.accessRoute"))}
                  {head("itemsRead", t("agents.accessItems"))}
                  {head("first", t("agents.accessFirst"))}
                  {head("last", t("agents.accessLast"))}
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {sortAccess(all, sort.by, sort.desc).map((r) => (
                  <tr>
                    <th scope="row" class="cx-mono">
                      {r.model}
                    </th>
                    <td>{routeText(r.route)}</td>
                    <td class="cx-mono">{fmtInt(r.itemsRead)}</td>
                    <td class="cx-mono">{fmt.date(isoMs(r.first), true)}</td>
                    <td class="cx-mono">{fmt.rel(isoMs(r.last))}</td>
                    <td>
                      {outwardRows.has(r) ? null : (
                        <button type="button" class="cx-text-button" onClick={() => void traceRead(r)}>
                          {t("agents.traceRead", { model: r.model })}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </Load>
      <p class="cx-note">{t("agents.retention", { period })}</p>
      <ConsentLog />
      <ScreenedList />
    </section>
  );
}
