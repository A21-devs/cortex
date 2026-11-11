/**
 * The chart panel's "Show or hide" checklist, as plain functions over the hidden set the stage already keeps
 * (`ui.hiddenGroups`: "dim=value" keys, the same shape the key bar and a right-click on a chart label write).
 * Nothing here knows about the page; the checklist, its Only link, its chips and Show all are all edits of that one list.
 */
import type { DimId } from "./dims";

/** The hidden-set key of a value ("dim=value"). */
export const hiddenKeyOf = (dim: DimId, value: string): string => `${dim}=${value}`;

/** Most hidden keys kept (a saved state or a pasted tab state cannot grow the list without bound). */
export const HIDDEN_CAP = 500;
const KEY_MAX = 400;

/** The values hidden on `dim`, in the order they were hidden. */
export function hiddenOn(hidden: readonly string[], dim: DimId): string[] {
  const head = `${dim}=`;
  return hidden.filter((k) => k.startsWith(head)).map((k) => k.slice(head.length));
}

export function isHiddenValue(hidden: readonly string[], dim: DimId, value: string): boolean {
  return hidden.includes(hiddenKeyOf(dim, value)) || hidden.includes(value);
}

/** Hide or show one value; every other key stays where it was. */
export function toggleValue(hidden: readonly string[], dim: DimId, value: string): string[] {
  const key = hiddenKeyOf(dim, value);
  if (isHiddenValue(hidden, dim, value)) return hidden.filter((k) => k !== key && k !== value);
  return [...hidden, key];
}

/** Whether `value` is the only one shown on `dim` among `all` (the state Only leaves). */
export function isOnlyValue(hidden: readonly string[], dim: DimId, all: readonly string[], value: string): boolean {
  return all.includes(value) && !isHiddenValue(hidden, dim, value) && all.filter((v) => v !== value).every((v) => isHiddenValue(hidden, dim, v));
}

/** Only: show just this value of `dim`; again, and every value of `dim` comes back. Other dimensions' keys are left alone. */
export function onlyValue(hidden: readonly string[], dim: DimId, all: readonly string[], value: string): string[] {
  const rest = hidden.filter((k) => !k.startsWith(`${dim}=`));
  if (isOnlyValue(hidden, dim, all, value)) return rest;
  return [...rest, ...all.filter((v) => v !== value).map((v) => hiddenKeyOf(dim, v))];
}

/** Show every hidden value of `dim`, or of every dimension when `dim` is omitted. */
export function showAllOf(hidden: readonly string[], dim?: DimId): string[] {
  return dim === undefined ? [] : hidden.filter((k) => !k.startsWith(`${dim}=`));
}

export interface ChecklistRow {
  key: string;
  label: string;
  count: number;
  shown: boolean;
}

/** The checklist's rows for `dim`, largest first (ties by name), each with its shown state. */
export function checklistRows(values: readonly { key: string; label: string; count: number }[], hidden: readonly string[], dim: DimId): ChecklistRow[] {
  return values
    .map((v) => ({ key: v.key, label: v.label, count: v.count, shown: !isHiddenValue(hidden, dim, v.key) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "en-GB"));
}

export interface HiddenChip {
  /** The hidden-set key this chip removes. */
  key: string;
  dim: DimId | null;
  value: string;
}

/**
 * One chip per hidden key. `dims` are the chart's own axes: a key for one of them splits on its dimension (a dimension
 * id never contains "=", a value can); other keys split at their first "="; a bare key is all value.
 */
export function hiddenChips(hidden: readonly string[], dims: readonly DimId[]): HiddenChip[] {
  const seen = new Set<string>();
  const out: HiddenChip[] = [];
  for (const key of hidden) {
    if (seen.has(key)) continue;
    seen.add(key);
    const own = dims.find((d) => key.startsWith(`${d}=`));
    if (own) {
      out.push({ key, dim: own, value: key.slice(own.length + 1) });
      continue;
    }
    const eq = key.indexOf("=");
    out.push(eq > 0 ? { key, dim: key.slice(0, eq) as DimId, value: key.slice(eq + 1) } : { key, dim: null, value: key });
  }
  return out;
}

/** The hidden set from saved data: strings only, bounded, no repeats. Anything else is dropped. */
export function sanitizeHidden(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const k of raw) {
    if (typeof k === "string" && k.length > 0 && k.length <= KEY_MAX && !out.includes(k)) out.push(k);
    if (out.length >= HIDDEN_CAP) break;
  }
  return out;
}

/** Whether two hidden sets hold the same keys (order aside). */
export function sameHidden(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k) => b.includes(k));
}
