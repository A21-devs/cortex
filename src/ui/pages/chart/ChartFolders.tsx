/**
 * The Chart page's Folders section (P10), shown in place of Fields for the folder charts: a Boxes | Tree switch
 * (Treemap and Icicle, keeping the folder selection and every option), a "Show all" action, and the folder tree: a
 * chevron per folder that has children, a checkbox, the name and the count. Levels below the first start collapsed.
 * Opening or closing a row writes the chart's `expanded` / `collapsed` (what clicking an Icicle label writes), so the
 * chart adds or removes the child rows; ticking a folder includes or leaves out its subtree. The box scrolls both ways.
 */
import type { JSX } from "preact";
import type { ChartSpec } from "../../../shared/protocol/worker";
import { t } from "../../copy";
import { Icon, SectionLabel, TextButton } from "../../primitives/buttons";
import { Segmented } from "../../primitives/controls";
import { categoryName, toggleFold } from "../../stage/ChartOverlay";
import { folderIncluded, setFolderIncluded } from "../ChartPage";
import type { ValueRow } from "./ChartMergeList";

export type FoldersForm = "boxes" | "tree";

/** The folder dimensions a folder tree can be drawn from. */
export function isFolderAxis(spec: ChartSpec): boolean {
  return spec.x.dim === "folder" || spec.x.dim === "folderPath";
}

export function formOf(spec: ChartSpec): FoldersForm {
  return spec.chart === "icicle" ? "tree" : "boxes";
}

/** Switch between the Treemap (Boxes) and the Icicle (Tree): the folder selection and every option stay. */
export function withFoldersForm(spec: ChartSpec, form: FoldersForm): ChartSpec {
  const chart = form === "tree" ? "icicle" : "treemap";
  return spec.chart === chart ? spec : { ...spec, chart };
}

export interface FolderRow {
  key: string;
  label: string;
  count: number;
  depth: number;
  hasChildren: boolean;
}

/** Folder rows in tree order (the chart reports them parent first): depth from the parents that came before, children known from the next row. */
export function folderRows(categories: readonly ValueRow[]): FolderRow[] {
  const out: FolderRow[] = [];
  const stack: string[] = [];
  for (const c of categories) {
    while (stack.length > 0 && !c.key.startsWith(`${stack[stack.length - 1]}/`)) stack.pop();
    const prev = out[out.length - 1];
    if (prev && c.key.startsWith(`${prev.key}/`)) prev.hasChildren = true;
    out.push({ key: c.key, label: c.label, count: c.count, depth: stack.length, hasChildren: false });
    stack.push(c.key);
  }
  return out;
}

/** The Icicle shows as many levels as fit in about this many rows (the layout's own limit). */
const ICICLE_ROWS = 40;

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * How many levels are open before the person opens or closes any row: the Icicle's own automatic depth (so the list
 * shows the rows the chart does), one level for the Treemap.
 */
export function defaultOpenDepth(spec: ChartSpec, rows: readonly FolderRow[]): number {
  if (spec.chart !== "icicle") return 1;
  const live = rows.filter((r) => folderIncluded(spec, r.key) && r.count > 0);
  let auto = 0;
  for (let d = 0; d < 32; d++) {
    if (live.filter((r) => r.depth <= d).length > ICICLE_ROWS) break;
    auto = d;
  }
  return auto + 1;
}

/** Whether a folder's children show: opened by hand, or inside the default depth and not closed by hand. */
export function isOpen(spec: ChartSpec, row: Pick<FolderRow, "key" | "depth">, depthOpen: number): boolean {
  return listOf(spec.options.expanded).includes(row.key) || (row.depth < depthOpen && !listOf(spec.options.collapsed).includes(row.key));
}

/** The rows on screen: a row shows when every folder above it is open. */
export function visibleFolderRows(spec: ChartSpec, rows: readonly FolderRow[]): FolderRow[] {
  const depthOpen = defaultOpenDepth(spec, rows);
  const out: FolderRow[] = [];
  const open: boolean[] = [];
  for (const r of rows) {
    if (r.depth > 0 && !open.slice(0, r.depth).every(Boolean)) continue;
    out.push(r);
    open[r.depth] = isOpen(spec, r, depthOpen);
    open.length = r.depth + 1;
  }
  return out;
}

/** Open or close a folder's row: the chart option the Icicle's own labels write. */
export function setFolderOpen(spec: ChartSpec, key: string, open: boolean): ChartSpec {
  return { ...spec, options: toggleFold(spec.options, key, !open) };
}

/** Whether "Show all" has been taken: every level of a Treemap, every row of an Icicle. */
export function allLevelsShown(spec: ChartSpec, rows: readonly FolderRow[]): boolean {
  if (spec.chart !== "icicle") return spec.options.allLevels === true;
  const depthOpen = defaultOpenDepth(spec, rows);
  return rows.filter((r) => r.hasChildren).every((r) => isOpen(spec, r, depthOpen));
}

/** "Show all" opens every level; "Show fewer" returns to the levels the chart opens on its own. */
export function withAllLevels(spec: ChartSpec, rows: readonly FolderRow[], on: boolean): ChartSpec {
  if (spec.chart !== "icicle") return { ...spec, options: { ...spec.options, allLevels: on } };
  const options = { ...spec.options };
  if (on) {
    options.expanded = rows.filter((r) => r.hasChildren).map((r) => r.key);
    options.collapsed = [];
  } else {
    delete options.expanded;
    delete options.collapsed;
  }
  return { ...spec, options };
}

export function ChartFolders(p: { spec: ChartSpec; setSpec(next: ChartSpec): void; categories: readonly ValueRow[] }): JSX.Element {
  const { spec, setSpec } = p;
  const byFolder = isFolderAxis(spec);
  const rows = folderRows(p.categories);
  const shown = visibleFolderRows(spec, rows);
  const depthOpen = defaultOpenDepth(spec, rows);
  const everything = byFolder && allLevelsShown(spec, rows);

  return (
    <section class="cx-section" aria-label={t("chart.folders")}>
      <SectionLabel>{t("chart.folders")}</SectionLabel>
      <div class="cx-chart-folders-head">
        <Segmented<FoldersForm>
          label={t("chart.foldersForm")}
          value={formOf(spec)}
          options={[
            { value: "boxes", label: t("chart.foldersBoxes") },
            { value: "tree", label: t("chart.foldersTree") },
          ]}
          onChange={(form) => setSpec(withFoldersForm(spec, form))}
        />
        {byFolder ? <TextButton onClick={() => setSpec(withAllLevels(spec, rows, !everything))}>{everything ? t("chart.showFewer") : t("chart.showAll")}</TextButton> : null}
      </div>
      {!byFolder ? (
        <div class="cx-chart-folders-note">
          <p class="cx-chart-values-note">{t("chart.notByFolder")}</p>
          <TextButton onClick={() => setSpec({ ...spec, x: { dim: "folderPath", sort: "count" } })}>{t("chart.drawByFolder")}</TextButton>
        </div>
      ) : shown.length === 0 ? (
        <p class="cx-chart-values-note">{t("chart.foldersNone")}</p>
      ) : (
        <ul class="cx-chart-tree" role="tree" aria-label={t("chart.folders")}>
          {shown.map((r) => {
            const open = isOpen(spec, r, depthOpen);
            const name = r.label || categoryName("folderPath", r.key, r.key);
            return (
              <li key={r.key} role="treeitem" aria-level={r.depth + 1} aria-expanded={r.hasChildren ? open : undefined} style={{ paddingLeft: `${r.depth * 16}px` }}>
                <span class="cx-chart-tree-row">
                  {r.hasChildren ? (
                    <button type="button" class={`cx-chevron cx-chart-tree-chevron${open ? " is-open" : ""}`} aria-label={t(open ? "chart.collapseFolder" : "chart.expandFolder", { name })} onClick={() => setSpec(setFolderOpen(spec, r.key, !open))}>
                      <Icon name="chevron" />
                    </button>
                  ) : (
                    <span class="cx-chart-tree-gap" aria-hidden="true" />
                  )}
                  <label class="cx-chart-folder">
                    <input type="checkbox" checked={folderIncluded(spec, r.key)} onChange={(e) => setSpec(setFolderIncluded(spec, r.key, (e.currentTarget as HTMLInputElement).checked))} />
                    <span class="cx-chart-tree-name">{name}</span>
                    <span class="cx-mono cx-chart-folder-count">{r.count.toLocaleString("en-GB")}</span>
                  </label>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
