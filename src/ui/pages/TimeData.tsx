/**
 * Time › Data (CORTEX-UX §5.19, P2): the same period as a table. Rows × Columns × what to count (Entries · Notes ·
 * Words · both), with Total and Share columns, sortable headers, selectable rows that can be traced on the figure,
 * and Copy data as CSV / as a Markdown table. Nothing is counted until a Rows dimension is chosen ("Pick what to
 * count, and Cortex fills the table."). Owner: E12; data from worker stats "data".
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { DimId } from "../../shared/dims";
import type { MeasureId, StatsResult } from "../../shared/protocol/worker";
import { addToken, removeToken } from "../../state/actions";
import { visibilityParams } from "../../state/selectors";
import { useLeaf, useServices } from "../context";
import { t } from "../copy";
import { Select } from "../primitives/controls";
import { Button } from "../primitives/buttons";
import { dimLabel } from "../valueLabels";
import { csvCell } from "./whenModel";
import { copyToClipboard, Load, setPageParams, statsKey, useChange, ChangeSlot, useLoad } from "./PageFrame";

export interface DataTable {
  rows: string[];
  columns: string[];
  /** rows × columns, row-major. */
  cells: number[];
}

export function tableToCsv(tb: DataTable, rowHeader: string): string {
  const lines = [[rowHeader, ...tb.columns].map(csvCell).join(",")];
  tb.rows.forEach((r, i) => lines.push([r, ...tb.columns.map((_, j) => String(tb.cells[i * tb.columns.length + j] ?? 0))].map(csvCell).join(",")));
  return lines.join("\n");
}

export function tableToMarkdown(tb: DataTable, rowHeader: string): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const head = `| ${[rowHeader, ...tb.columns].map(esc).join(" | ")} |`;
  const sep = `|${[rowHeader, ...tb.columns].map(() => " --- ").join("|")}|`;
  const body = tb.rows.map((r, i) => `| ${[esc(r), ...tb.columns.map((_, j) => String(tb.cells[i * tb.columns.length + j] ?? 0))].join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

type DataResult = Extract<StatsResult, { kind: "data" }>;
type ColumnChoice = "none" | "week" | "month" | "year" | DimId;

/** Dimensions offered as table rows. */
export const ROW_DIMS: readonly DimId[] = ["space", "source", "speaker", "project", "kind", "folder", "month", "weekday", "hour"];
const COLUMN_CHOICES: readonly ColumnChoice[] = ["none", "week", "month", "year", "space", "source", "speaker", "kind"];
const MEASURES: readonly MeasureId[] = ["both", "entries", "notes", "words"];

export function measureLabel(m: MeasureId): string {
  return m === "entries" ? t("time.entries") : m === "notes" ? t("time.notes") : m === "words" ? t("time.words") : t("time.count");
}

function columnLabel(c: ColumnChoice): string {
  return c === "none" ? t("time.none") : c === "week" ? t("time.week") : c === "month" ? t("time.month") : c === "year" ? t("time.year") : dimLabel(c as DimId);
}

/** Table rows sorted by a column (index into cells, "total" or "label"), keeping the original order for ties. */
export function sortDataRows(rows: DataResult["rows"], by: number | "total" | "label", desc: boolean): DataResult["rows"] {
  const dir = desc ? -1 : 1;
  const value = (r: DataResult["rows"][number]) => (by === "total" ? r.total : typeof by === "number" ? r.cells[by] ?? 0 : 0);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (by === "label" ? a.r.label.localeCompare(b.r.label) * dir : (value(a.r) - value(b.r)) * dir) || a.i - b.i)
    .map((x) => x.r);
}

export function TimeData(p: { params?: Readonly<Record<string, string>> }): JSX.Element {
  const s = useServices();
  const leaf = useLeaf();
  const change = useChange();
  const params = p.params ?? {};
  const rows = (ROW_DIMS as readonly string[]).includes(params.rows ?? "") ? (params.rows as DimId) : null;
  const columns = (COLUMN_CHOICES as readonly string[]).includes(params.cols ?? "") ? (params.cols as ColumnChoice) : "none";
  const measure = (MEASURES as readonly string[]).includes(params.measure ?? "") ? (params.measure as MeasureId) : "both";
  const [sort, setSort] = useState<{ by: number | "total" | "label"; desc: boolean }>({ by: "total", desc: true });
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const ui = leaf.store.slices.ui.value;
  const view = leaf.store.slices.view.value;

  const stats = useLoad<DataResult | null>(
    async (signal) => {
      if (!rows) return null;
      const res = await s.worker.call(statsKey(leaf.viewId, "data"), "stats", { kind: "data", rows, columns, measure, visibility: visibilityParams(ui, view) }, { signal });
      if (res.kind !== "data") throw new Error("unexpected stats result");
      return res;
    },
    [rows, columns, measure, JSON.stringify(ui.period), ui.scope],
  );

  const set = (patch: Record<string, string | null>) => setPageParams(leaf.store, patch);
  const rowHeader = rows ? dimLabel(rows) : t("time.rows");
  const toTable = (res: DataResult): DataTable => ({ rows: res.rows.map((r) => r.label), columns: res.columns, cells: res.rows.flatMap((r) => r.cells) });

  const copy = async (res: DataResult, kind: "csv" | "md") => {
    const tb = toTable(res);
    const ok = await copyToClipboard(kind === "csv" ? tableToCsv(tb, rowHeader) : tableToMarkdown(tb, rowHeader));
    change.post(ok ? t("time.copied") : t("errors.action"));
  };

  const trace = (res: DataResult) => {
    if (!rows) return;
    for (const r of res.rows) {
      const id = `time:${rows}:${r.key}`;
      if (picked.has(r.key)) addToken(leaf.store, { id, kind: "group", dim: rows, value: r.key, label: `${dimLabel(rows)}: ${r.label}` });
      else removeToken(leaf.store, id);
    }
  };

  return (
    <section class="cx-time-data" aria-label={t("time.data")}>
      <div class="cx-data-controls">
        <Select label={t("time.rows")} placeholder={t("time.rowsPlaceholder")} value={rows ?? ("" as DimId)} options={ROW_DIMS.map((d) => ({ value: d, label: dimLabel(d) }))} onChange={(v) => (setPicked(new Set()), set({ rows: v }))} />
        <Select label={t("time.columns")} value={columns} options={COLUMN_CHOICES.map((c) => ({ value: c, label: columnLabel(c) }))} onChange={(v) => set({ cols: v === "none" ? null : v })} />
        <Select label={t("time.count")} value={measure} options={MEASURES.map((m) => ({ value: m, label: measureLabel(m) }))} onChange={(v) => set({ measure: v === "both" ? null : v })} />
      </div>
      {!rows ? (
        <p class="cx-note">{t("time.dataEmpty")}</p>
      ) : (
        <Load value={stats} failed={t("errors.time")} rows={5}>
          {(res) => {
            if (!res || res.rows.length === 0) return <p class="cx-note">{t("time.empty")}</p>;
            const sorted = sortDataRows(res.rows, sort.by, sort.desc);
            const head = (label: string, by: number | "total" | "label") => (
              <th scope="col" aria-sort={sort.by === by ? (sort.desc ? "descending" : "ascending") : "none"}>
                <button type="button" class="cx-text-button" title={t("time.sortBy", { column: label })} onClick={() => setSort((cur) => ({ by, desc: cur.by === by ? !cur.desc : by !== "label" }))}>
                  {label}
                </button>
              </th>
            );
            return (
              <>
                <div class="cx-table-wrap">
                  <table class="cx-table">
                    <thead>
                      <tr>
                        <th scope="col" />
                        {head(rowHeader, "label")}
                        {res.columns.map((c, i) => head(c, i))}
                        {head(t("time.total"), "total")}
                        <th scope="col">{t("time.share")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((r) => (
                        <tr class={picked.has(r.key) ? "is-picked" : ""}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={t("time.selectRow", { row: r.label })}
                              checked={picked.has(r.key)}
                              onChange={(e) => {
                                const on = (e.currentTarget as HTMLInputElement).checked;
                                setPicked((cur) => {
                                  const next = new Set(cur);
                                  if (on) next.add(r.key);
                                  else next.delete(r.key);
                                  return next;
                                });
                              }}
                            />
                          </td>
                          <th scope="row">{r.label}</th>
                          {r.cells.map((n) => (
                            <td class="cx-mono">{n.toLocaleString("en-GB")}</td>
                          ))}
                          <td class="cx-mono">{r.total.toLocaleString("en-GB")}</td>
                          <td class="cx-mono">{Math.round(r.share * 100)}%</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td />
                        <th scope="row">{t("time.total")}</th>
                        {res.totals.map((n) => (
                          <td class="cx-mono">{n.toLocaleString("en-GB")}</td>
                        ))}
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <div class="cx-data-actions">
                  <Button icon="copyData" onClick={() => void copy(res, "csv")}>
                    {t("time.copyCsv")}
                  </Button>
                  <Button onClick={() => void copy(res, "md")}>{t("time.copyMarkdown")}</Button>
                  <Button disabled={picked.size === 0} onClick={() => trace(res)}>
                    {t("time.traceRows")}
                  </Button>
                </div>
                <ChangeSlot state={change} />
              </>
            );
          }}
        </Load>
      )}
    </section>
  );
}
