/**
 * The sample record sandbox (M13; CORTEX-UX §5.31). Owner: E7. Phase-gated (features.sampleRecord, P2).
 * A seeded, read-only made-up record (about 30,000 entries and 3,500 notes over three years in six invented
 * areas) built in the worker (worker/sampleIndex.ts, `loadSample`) and on the main thread from the same
 * generator, plus a synthetic text provider for the readers. While `services.sandbox` is true, corrections,
 * changes, Write, importers and agents refuse with the copy "Not available in the sample record." Reachable only
 * from the empty-state card, the More menu and Guide (they check the feature gate); leaving restores the real index.
 */
import type { ReadonlySignal } from "@preact/signals-core";
import { CortexError } from "../shared/errors";
import { mulberry32 } from "../shared/rng";
import { SAMPLE_AREAS as SAMPLE_AREA_DEFS } from "../shared/spaces";
import type { Logger } from "../shared/log";
import type { IndexServiceExt } from "./indexer";
import { SAMPLE_REFUSAL } from "./corrections";

/** The six invented areas of the sample record. */
export const SAMPLE_AREAS: readonly string[] = SAMPLE_AREA_DEFS.map((a) => a.name);

/** Seed of the sample record (the same every time, so a tour is repeatable). */
export const SAMPLE_SEED = 7;

export { SAMPLE_REFUSAL };

const WORDS = ["sketch", "plan", "list", "repair", "visit", "note", "draft", "measure", "plant", "fold", "budget", "chapter"] as const;

/** Deterministic placeholder text for a sample entry (no real words from anyone). */
export function sampleText(ordinal: number, seed = SAMPLE_SEED): string {
  const r = mulberry32(seed * 1_000_003 + ordinal);
  const n = 6 + Math.floor(r() * 18);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(r() * WORDS.length)] ?? "note");
  const s = out.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

/** The reader's answer for a sample entry: the made-up sentence, as a version-1 original. */
export function sampleTextResult(ordinal: number, seed = SAMPLE_SEED): { ok: true; text: string; version: 1 } {
  return { ok: true, text: sampleText(ordinal, seed), version: 1 };
}

/** Throws the sandbox refusal when the sample record is showing (the guard every writing service calls). */
export function assertNotSample(sandbox: () => boolean): void {
  if (sandbox()) throw new CortexError("E_BAD_REQUEST", SAMPLE_REFUSAL);
}

export interface SampleRecordDeps {
  index: Pick<IndexServiceExt, "showSample">;
  /** The container's `setSandbox` for these services. */
  setSandbox(on: boolean): void;
  sandbox: ReadonlySignal<boolean>;
  log?: Logger;
  seed?: number;
}

export interface SampleRecordController {
  readonly active: boolean;
  enter(): Promise<void>;
  leave(): Promise<void>;
  toggle(): Promise<void>;
}

/** Enter or leave the sample record. Entering marks the services read-only only after the index is showing. */
export function createSampleRecord(deps: SampleRecordDeps): SampleRecordController {
  const seed = deps.seed ?? SAMPLE_SEED;
  let busy: Promise<void> | null = null;
  const run = (on: boolean): Promise<void> => {
    if (busy) return busy;
    if (deps.sandbox.peek() === on) return Promise.resolve();
    busy = (async () => {
      if (on) {
        await deps.index.showSample(true, seed);
        deps.setSandbox(true);
      } else {
        // Writes stay refused until the real index is back, so nothing lands on a made-up item.
        await deps.index.showSample(false);
        deps.setSandbox(false);
      }
    })()
      .catch((e: unknown) => {
        deps.log?.warn("the sample record could not be switched", { error: e instanceof CortexError ? e.code : "E_INTERNAL" });
        throw e;
      })
      .finally(() => {
        busy = null;
      });
    return busy;
  };
  return {
    get active() {
      return deps.sandbox.peek();
    },
    enter: () => run(true),
    leave: () => run(false),
    toggle: () => run(!deps.sandbox.peek()),
  };
}
