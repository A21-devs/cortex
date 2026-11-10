/**
 * The maths behind the Waves chart's Smoothing, Window and Scale options (pure, no index needed).
 *  - moving average: the plain mean of the bins in a centred window (a window that runs off the end averages what is
 *    there), so a peak stays at its own date;
 *  - exponential average: an exponential moving average with α = 2 / (window + 1), run forwards and backwards and
 *    averaged, so recent bins weigh most on both sides and a peak still stays at its own date;
 *  - scale: linear, square root (lifts small rows without flattening the big ones) or log1p.
 * A window is given in days; a bin is a day, a week or a month, so the window becomes a whole number of bins (≥ 1;
 * a window shorter than one bin changes nothing).
 */
import type { WaveScale, WaveSmoothing } from "../../shared/chartOptions";

const BIN_DAYS = { day: 1, week: 7, month: 30.44 } as const;

export type BinGrain = keyof typeof BIN_DAYS;

/** The window in whole bins (at least 1). */
export function windowBins(days: number, grain: BinGrain): number {
  return Math.max(1, Math.round(days / BIN_DAYS[grain]));
}

export function movingAverage(src: Float64Array, window: number): Float64Array {
  const w = Math.max(1, Math.round(window));
  if (w === 1) return src;
  const n = src.length;
  const out = new Float64Array(n);
  // An even window is centred by giving its two outermost bins half weight, so a peak never drifts half a bin.
  const half = Math.floor(w / 2);
  const even = w % 2 === 0;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    let s = 0;
    let ws = 0;
    for (let j = lo; j <= hi; j++) {
      const wt = even && Math.abs(j - i) === half ? 0.5 : 1;
      s += src[j]! * wt;
      ws += wt;
    }
    out[i] = s / ws;
  }
  return out;
}

export function exponentialAverage(src: Float64Array, window: number): Float64Array {
  const w = Math.max(1, Math.round(window));
  if (w === 1) return src;
  const n = src.length;
  if (n === 0) return src;
  const a = 2 / (w + 1);
  const fwd = new Float64Array(n);
  const bwd = new Float64Array(n);
  fwd[0] = src[0]!;
  for (let i = 1; i < n; i++) fwd[i] = a * src[i]! + (1 - a) * fwd[i - 1]!;
  bwd[n - 1] = src[n - 1]!;
  for (let i = n - 2; i >= 0; i--) bwd[i] = a * src[i]! + (1 - a) * bwd[i + 1]!;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = (fwd[i]! + bwd[i]!) / 2;
  return out;
}

export function smoothSeries(src: Float64Array, mode: WaveSmoothing, bins: number): Float64Array {
  if (mode === "moving") return movingAverage(src, bins);
  if (mode === "exponential") return exponentialAverage(src, bins);
  return src;
}

export function scaleSeries(src: Float64Array, scale: WaveScale): Float64Array {
  if (scale === "linear") return src;
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = Math.max(0, src[i]!);
    out[i] = scale === "sqrt" ? Math.sqrt(v) : Math.log1p(v);
  }
  return out;
}
