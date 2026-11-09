/**
 * The sample record (M13, P2): a seeded DataIndex built in the worker (`loadSample`), about 30,000 entries and
 * 3,500 notes over three years in six invented areas (Garden, Studio, Ledger, Workshop, Travel, Reading).
 * Owner: E7. Read-only; the plugin's sandbox flag blocks every write while it is shown.
 * The generator itself lives in shared/indexCodec.ts (`sampleIndexInput`) because the plugin builds the same
 * index for its tooltips and readers and may not import worker code; its epoch is "sample", so search shards of
 * the real record never apply to it (search falls back to titles).
 */
import { IndexStore, SAMPLE_COUNTS, decodePart, encodeIndex, sampleIndexInput } from "../shared/indexCodec";
import type { DataIndex } from "../shared/index-format";

export const SAMPLE_SIZE = SAMPLE_COUNTS;

/**
 * Build the sample index for `seed` (deterministic for the seed and the day of `now`). Buffers are reported to
 * `onBuffer` so the worker can register them as state-owned (TRANSFER-DETACH).
 */
export function buildSampleIndex(seed: number, now: number = Date.now(), onBuffer?: (b: ArrayBufferLike) => void): DataIndex {
  const part = decodePart(encodeIndex(sampleIndexInput(seed, now)));
  const opts = onBuffer ? { part: "merged" as const, onBuffer } : { part: "merged" as const };
  return IndexStore.fromParts([part], opts).snapshot();
}
