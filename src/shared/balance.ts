/**
 * The Balance chart's two sides (CHART-33). Both the Chart page (its pickers) and the worker layout read these, so the
 * two agree on which dimension is compared and which pair of its values stands on each side.
 *
 * The default is you versus assistants (dimension "speaker"). Any other dimension takes a chosen pair of values; with
 * no choice yet it takes its two largest.
 */
import type { DimId } from "./dims";
import type { ChartSpec } from "./protocol/worker";

type Options = Readonly<Record<string, unknown>>;

export const BALANCE_DEFAULT_DIM: DimId = "speaker";
/** The pair the default dimension compares: its keys in the speaker dictionary. */
export const BALANCE_DEFAULT_SIDES: readonly [string, string] = ["you", "assistant"];

export interface BalanceValue {
  key: string;
  count: number;
}

/** The dimension whose two values are compared (an unset or non-text option is the default). */
export function balanceDim(options: Options): DimId {
  const d = options.dim;
  return typeof d === "string" && d !== "" ? (d as DimId) : BALANCE_DEFAULT_DIM;
}

function optionKey(options: Options, name: "sideA" | "sideB"): string | null {
  const v = options[name];
  return typeof v === "string" ? v : null;
}

/**
 * The two sides: the chosen values when both are set and differ; otherwise the dimension's defaults, filled in from its
 * largest values (never the same value twice). `values` is the dimension's values, any order. A side is null when the
 * dimension has fewer than two values to offer.
 */
export function balanceSides(options: Options, dim: DimId, values: readonly BalanceValue[]): [string | null, string | null] {
  const ranked = [...values].filter((v) => v.count > 0).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const has = (k: string) => values.some((v) => v.key === k);
  const chosenA = optionKey(options, "sideA");
  const chosenB = optionKey(options, "sideB");
  let a = chosenA !== null && has(chosenA) ? chosenA : null;
  let b = chosenB !== null && has(chosenB) && chosenB !== a ? chosenB : null;
  if (a === null && b === null && dim === BALANCE_DEFAULT_DIM && has(BALANCE_DEFAULT_SIDES[0]) && has(BALANCE_DEFAULT_SIDES[1])) {
    return [BALANCE_DEFAULT_SIDES[0], BALANCE_DEFAULT_SIDES[1]];
  }
  const pick = (not: (string | null)[]): string | null => ranked.find((v) => !not.includes(v.key))?.key ?? null;
  if (a === null) a = pick([b]);
  if (b === null) b = pick([a]);
  if (a !== null && a === b) b = pick([a]);
  return [a, b];
}

/** Options for a new dimension: the pair resets (the old values mean nothing on another dimension). */
export function withBalanceDim(options: ChartSpec["options"], dim: DimId): ChartSpec["options"] {
  const rest = { ...options };
  delete rest.sideA;
  delete rest.sideB;
  return { ...rest, dim };
}

/** Options with one side set; when it would equal the other side, the two swap. */
export function withBalanceSide(options: ChartSpec["options"], which: "sideA" | "sideB", key: string, current: readonly [string | null, string | null]): ChartSpec["options"] {
  const other = which === "sideA" ? "sideB" : "sideA";
  const otherKey = which === "sideA" ? current[1] : current[0];
  const mine = which === "sideA" ? current[0] : current[1];
  const next: ChartSpec["options"] = { ...options, [which]: key };
  if (key === otherKey && mine !== null) next[other] = mine;
  else if (key !== otherKey && otherKey !== null) next[other] = otherKey;
  else delete next[other];
  return next;
}
