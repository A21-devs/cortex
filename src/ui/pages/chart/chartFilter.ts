/**
 * The Chart page's Filter checklist, kept apart from the drawing: which values of a field the checklist offers
 * (largest first, at most FILTER_SHOWN), and how ticking a value writes the chart's `filter`. The filter keeps a row when
 * it matches ANY ticked value of one field and every field that has ticks (OR within a field, AND across fields).
 */
import type { DimId } from "../../../shared/dims";
import type { ChartSpec } from "../../../shared/protocol/worker";

/** How many values the checklist lists (the rest are reached by typing the value into the Filter menu of the stage). */
export const FILTER_SHOWN = 48;

export interface FilterValue {
  key: string;
  label: string;
  count: number;
}

export interface FilterChoices {
  rows: FilterValue[];
  /** Every value the field has. */
  total: number;
  /** The list is cut: it names the largest `rows.length` of `total`. */
  cut: boolean;
}

/** The values to offer, largest first (ties by name, so the order never jitters); values with no entries are left out. */
export function filterChoices(values: readonly FilterValue[], max: number = FILTER_SHOWN): FilterChoices {
  const live = values.filter((v) => v.count > 0).slice().sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { rows: live.slice(0, max), total: live.length, cut: live.length > max };
}

/** Whether a value is ticked. */
export function isKept(spec: ChartSpec, dim: DimId, value: string): boolean {
  return spec.filter.some((f) => f.dim === dim && f.value === value);
}

/** Tick or untick a value; the order of the other filters stays. */
export function toggleKept(spec: ChartSpec, dim: DimId, value: string): ChartSpec {
  const filter = isKept(spec, dim, value) ? spec.filter.filter((f) => !(f.dim === dim && f.value === value)) : [...spec.filter, { dim, value }];
  return { ...spec, filter };
}

/** Drop every tick of one field ("Keep all"). */
export function clearKept(spec: ChartSpec, dim: DimId): ChartSpec {
  return spec.filter.some((f) => f.dim === dim) ? { ...spec, filter: spec.filter.filter((f) => f.dim !== dim) } : spec;
}

/** The field the checklist is about: the one picked in the menu, else the last field the chart filters on. */
export function activeFilterDim(picked: DimId | null, spec: ChartSpec): DimId | null {
  return picked ?? spec.filter[spec.filter.length - 1]?.dim ?? null;
}
