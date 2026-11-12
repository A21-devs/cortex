/**
 * The label packs as a table (Agents > Ledger): PACK · ENTRIES · LABELS · BLANK, the pack's fields written under its
 * name, who made the labels under LABELS. A header sorts; a row lights its entries in the figure (Agents.tsx owns the
 * lighting and passes it in). Owner: lab.
 */
import type { JSX } from "preact";
import { t } from "../../copy";
import { fmtInt } from "../../valueLabels";
import { madeBy, nextSort, type PackSort, type PackSortKey, type PackTableRow } from "../labPacks";

function Head(p: { by: PackSortKey; label: string; sort: PackSort; onSort(s: PackSort): void; numeric?: boolean }): JSX.Element {
  const on = p.sort.by === p.by;
  return (
    <th scope="col" class={p.numeric ? "is-num" : undefined} aria-sort={on ? (p.sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" class="cx-text-button cx-lab-sort" title={t("agents.sortBy", { column: p.label })} onClick={() => p.onSort(nextSort(p.sort, p.by))}>
        {p.label}
        {on ? <span class="cx-lab-arrow" aria-hidden="true">{p.sort.desc ? "↓" : "↑"}</span> : null}
      </button>
    </th>
  );
}

function madeNote(r: PackTableRow): string | null {
  switch (madeBy(r)) {
    case "none":
      return null;
    case "model":
      return t("agents.packMadeModel");
    case "you":
      return t("agents.packMadeYou");
    case "both":
      return t("agents.packMadeBoth", { machine: fmtInt(r.machine), you: fmtInt(r.you) });
  }
}

export function PacksTable(p: { rows: readonly PackTableRow[]; sort: PackSort; onSort(s: PackSort): void; litKey: string | null; onLight(row: PackTableRow): void }): JSX.Element {
  return (
    <div class="cx-table-wrap">
      <table class="cx-table cx-lab-table cx-pack-table2">
        <thead>
          <tr>
            <Head by="pack" label={t("agents.packColPack")} sort={p.sort} onSort={p.onSort} />
            <Head by="entries" label={t("agents.packColEntries")} sort={p.sort} onSort={p.onSort} numeric />
            <Head by="labels" label={t("agents.packColLabels")} sort={p.sort} onSort={p.onSort} numeric />
            <Head by="unassigned" label={t("agents.packColUnassigned")} sort={p.sort} onSort={p.onSort} numeric />
          </tr>
        </thead>
        <tbody>
          {p.rows.map((r) => {
            const lit = p.litKey === r.key;
            const made = madeNote(r);
            return (
              <tr key={r.key} class={`cx-lab-row${lit ? " is-picked" : ""}`}>
                <th scope="row">
                  <button type="button" class="cx-lab-pick" aria-pressed={lit} title={t("agents.packLight", { pack: r.key })} onClick={() => p.onLight(r)}>
                    {t("agents.packName", { pack: r.pack, version: r.version })}
                  </button>
                  <span class="cx-note cx-lab-sub">{r.fields.length === 0 ? t("agents.packFieldsNone") : t("agents.packFieldsLine", { fields: r.fields.join(", ") })}</span>
                </th>
                <td class="cx-mono">{fmtInt(r.entries)}</td>
                <td class="cx-mono">
                  {fmtInt(r.labels)}
                  {made ? <span class="cx-note cx-lab-sub">{made}</span> : null}
                </td>
                <td class="cx-mono">
                  {fmtInt(r.unassigned)}
                  <span class="cx-note cx-lab-sub is-nowrap">{r.unassigned === 1 ? t("agents.packBlankUnitOne") : t("agents.packBlankUnit")}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
