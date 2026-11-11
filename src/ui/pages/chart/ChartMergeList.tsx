/**
 * The Chart page's value list (P10): a scrollable checklist of the values on the horizontal axis with their counts.
 * Ticking two or more enables "Combine N", which writes the chart's `combined` (the shape the stage's right-click
 * "Combine with…" writes) and asks for a name inline. Combined groups list below with an Undo. Under the list: the
 * number of values and how many of them the chart shows, and the Largest select (5 · 10 · 20 · 40 · 60 · All).
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { DimId } from "../../../shared/dims";
import type { ChartSpec } from "../../../shared/protocol/worker";
import { useShell } from "../../context";
import { t } from "../../copy";
import { Button, SectionLabel, TextButton } from "../../primitives/buttons";
import { Select } from "../../primitives/controls";
import { categoryName, OTHER_VALUE, renamesOf, setCombinedName } from "../../stage/ChartOverlay";
import { clampTopN } from "../ChartPage";

export interface ValueRow {
  key: string;
  label: string;
  count: number;
}

/** The choices of the Largest select; "all" shows every value. */
export const LARGEST_CHOICES: readonly (number | "all")[] = [5, 10, 20, 40, 60, "all"];

/** The select's value for a chart's `top`. */
export function largestValue(top: ChartSpec["top"]): string {
  return top === "all" ? "all" : String(clampTopN(top));
}

/** Options for the Largest select; a number a saved chart carries that is not a choice is kept so the select can show it. */
export function largestOptions(top: ChartSpec["top"]): { value: string; label: string }[] {
  const cur = top === "all" ? null : clampTopN(top);
  const nums = [...new Set([...LARGEST_CHOICES.filter((c): c is number => c !== "all"), ...(cur === null ? [] : [cur])])].sort((a, b) => a - b);
  return [...nums.map((n) => ({ value: String(n), label: String(n) })), { value: "all", label: t("chart.largestAll") }];
}

/** The chart with its Largest set: "all" writes top "all", a number is clamped to 5–60. */
export function withLargest(spec: ChartSpec, value: string): ChartSpec {
  if (value === "all") return spec.top === "all" ? spec : { ...spec, top: "all" };
  const n = Number(value);
  return Number.isFinite(n) ? { ...spec, top: clampTopN(n) } : spec;
}

/** How many values the chart shows of `total`: all, or the `n` largest. */
export function shownValues(top: ChartSpec["top"], total: number): { all: boolean; n: number } {
  if (top === "all" || clampTopN(top) >= total) return { all: true, n: total };
  return { all: false, n: clampTopN(top) };
}

/** "All 107 values, the 20 largest shown" or "All 107 values". */
export function valuesFooter(top: ChartSpec["top"], total: number): string {
  const s = shownValues(top, total);
  const fmt = (n: number) => n.toLocaleString("en-GB");
  return s.all ? t("chart.valuesAll", { total: fmt(total) }) : t("chart.valuesLargest", { total: fmt(total), n: fmt(s.n) });
}

/** The values the list offers: no remainder bucket. */
export function valueRows(categories: readonly ValueRow[]): ValueRow[] {
  return categories.filter((c) => c.key !== OTHER_VALUE);
}

/** The values a combine of `head` on `dim` folds in, whichever spelling of the key the chart carries ("dim=head" or the bare head). */
function membersOf(combined: ChartSpec["combined"], dim: DimId, head: string): string[] {
  return [...(combined[`${dim}=${head}`] ?? []), ...(combined[head] ?? [])];
}

/** Combined groups of the chart on `dim`: the value that heads each one and the values folded into it. */
export function combinedGroups(combined: ChartSpec["combined"], dim: DimId): { head: string; members: string[] }[] {
  const out = new Map<string, string[]>();
  for (const [k, vals] of Object.entries(combined)) {
    if (!Array.isArray(vals) || vals.length === 0) continue;
    const eq = k.indexOf("=");
    const head = eq > 0 ? (k.slice(0, eq) === dim ? k.slice(eq + 1) : null) : k;
    if (head === null) continue;
    out.set(head, [...new Set([...(out.get(head) ?? []), ...vals.filter((v): v is string => typeof v === "string")])]);
  }
  return [...out].map(([head, members]) => ({ head, members }));
}

/**
 * Combine `keys` (the first is the head, normally the largest): the others are folded into it. A ticked value that
 * already heads a combine brings its members along, so a group is never nested inside another.
 */
export function combineKeys(combined: ChartSpec["combined"], dim: DimId, keys: readonly string[]): ChartSpec["combined"] {
  const head = keys[0];
  if (head === undefined || keys.length < 2) return combined;
  const next = { ...combined };
  const members = new Set(membersOf(combined, dim, head));
  delete next[`${dim}=${head}`];
  delete next[head];
  for (const k of keys.slice(1)) {
    members.add(k);
    for (const m of membersOf(combined, dim, k)) members.add(m);
    delete next[`${dim}=${k}`];
    delete next[k];
  }
  members.delete(head);
  next[`${dim}=${head}`] = [...members];
  return next;
}

/** The chart with the combine headed by `head` undone (and the name given to it removed). */
export function undoCombine(spec: ChartSpec, dim: DimId, head: string): ChartSpec {
  const combined = { ...spec.combined };
  delete combined[`${dim}=${head}`];
  delete combined[head];
  return { ...spec, combined, options: setCombinedName(spec.options, dim, head, "", "") };
}

/** The chart after combining `keys`, with `name` given to the group (blank keeps the first value's own name). */
export function applyCombine(spec: ChartSpec, keys: readonly string[], name: string, ownName: string): ChartSpec {
  const head = keys[0];
  if (head === undefined || keys.length < 2) return spec;
  const dim = spec.x.dim;
  return { ...spec, combined: combineKeys(spec.combined, dim, keys), options: setCombinedName(spec.options, dim, head, name, ownName) };
}

/** A stable ref callback: the name field takes focus when it appears (and not again while typing). */
const focusOnMount = (el: HTMLInputElement | null): void => {
  el?.focus();
  el?.select();
};

export function ChartMergeList(p: { spec: ChartSpec; setSpec(next: ChartSpec): void; categories: readonly ValueRow[] }): JSX.Element {
  const shell = useShell();
  const { spec, setSpec } = p;
  const dim = spec.x.dim;
  const rows = valueRows(p.categories);
  const names = renamesOf(spec.options);
  const label = (c: ValueRow) => categoryName(dim, c.key, c.label, names);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [naming, setNaming] = useState<{ keys: string[]; text: string } | null>(null);
  const picked = rows.filter((r) => ticked.has(r.key));
  const groups = combinedGroups(spec.combined, dim);

  const commit = (next: ChartSpec) => {
    const before = spec;
    setSpec(next);
    shell.pushUndo(() => setSpec(before));
  };
  const toggle = (key: string, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(key);
    else next.delete(key);
    setTicked(next);
    setNaming(null);
  };
  const finish = () => {
    if (!naming) return;
    const head = rows.find((r) => r.key === naming.keys[0]);
    commit(applyCombine(spec, naming.keys, naming.text, head ? categoryName(dim, head.key, head.label) : (naming.keys[0] ?? "")));
    setTicked(new Set());
    setNaming(null);
  };

  return (
    <section class="cx-section" aria-label={t("chart.combineValues")}>
      <SectionLabel>{t("chart.combineValues")}</SectionLabel>
      {rows.length === 0 ? (
        <p class="cx-chart-values-note">{t("chart.noValues")}</p>
      ) : (
        <ul class="cx-chart-values" aria-label={t("chart.valueList")}>
          {rows.map((c) => (
            <li key={c.key}>
              <label class="cx-chart-value">
                <input type="checkbox" checked={ticked.has(c.key)} onChange={(e) => toggle(c.key, (e.currentTarget as HTMLInputElement).checked)} />
                <span class="cx-chart-value-name">{label(c)}</span>
                <span class="cx-mono cx-chart-value-count">{c.count.toLocaleString("en-GB")}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 ? <p class="cx-chart-values-footer" aria-live="polite">{valuesFooter(spec.top, rows.length)}</p> : null}

      {naming ? (
        <div class="cx-chart-combine-name">
          <input
            type="text"
            class="cx-input"
            value={naming.text}
            maxLength={60}
            aria-label={t("chart.combineName")}
            placeholder={t("chart.combineName")}
            ref={focusOnMount}
            onInput={(e) => setNaming({ ...naming, text: (e.currentTarget as HTMLInputElement).value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                finish();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setNaming(null);
              }
            }}
          />
          <Button onClick={finish}>{t("chart.combineConfirm")}</Button>
          <TextButton onClick={() => setNaming(null)}>{t("chart.combineCancel")}</TextButton>
        </div>
      ) : (
        <div class="cx-chart-combine-row">
          {picked.length >= 2 ? (
            <Button onClick={() => setNaming({ keys: picked.map((r) => r.key), text: label(picked[0] as ValueRow) })}>{t("chart.combineN", { n: picked.length })}</Button>
          ) : (
            <p class="cx-chart-values-note">{t("chart.combineHint")}</p>
          )}
        </div>
      )}

      {groups.length > 0 ? (
        <ul class="cx-chart-combined">
          {groups.map((g) => (
            <li key={g.head}>
              <span class="cx-chart-value-name">{t("chart.combinedGroup", { name: categoryName(dim, g.head, g.head, names), n: g.members.length + 1 })}</span>
              <TextButton onClick={() => commit(undoCombine(spec, dim, g.head))}>{t("chart.combineUndo")}</TextButton>
            </li>
          ))}
        </ul>
      ) : null}

      <Select label={t("chart.largest")} value={largestValue(spec.top)} options={largestOptions(spec.top)} onChange={(v) => setSpec(withLargest(spec, v))} />
    </section>
  );
}
