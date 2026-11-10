/**
 * Sticky colour slots (M8; CORTEX-UX §4.4 "colour follows the group"). Owner: E8.
 * Slots are assigned once per dimension by rank over EVERYTHING indexed and kept when the filter, scope or
 * period changes; new values take the next free slot; at most 8 hues per dimension, the rest are Other.
 * Persisted to `.vault-meta/cortex/state/colours.json` (written by the plugin only, atomically under its lock)
 * so colours stay the same across devices. The worker receives the map in GroupingParams.slots and returns
 * GroupingResult.newSlots for values it had to assign; this service merges and persists them.
 */
import { CortexError } from "../shared/errors";
import type { Logger } from "../shared/log";
import type { ColourSlotsFile } from "../shared/types";
import { ensureCacheDir, ensureCortexRoots, readTextIfExists, writeFileAtomic, writeJsonAtomic } from "../node/fsAtomic";
import { DEFAULT_STALE_MS, locksDirOf, withLock } from "../node/locks";
import { resolveInVault, writablePath } from "../node/paths";
import { coloursPath, CORTEX_PATHS } from "../store/layout";

import type { ColourSlotService, SlotMap } from "./services";
export type { ColourSlotService, SlotMap } from "./services";

/** Merge rule shared by the plugin and tests: existing assignments win; new values take free slots 1..8. */
export function mergeSlots(cur: SlotMap, add: SlotMap): SlotMap {
  const out: SlotMap = {};
  for (const [dim, values] of Object.entries(cur)) out[dim] = { ...values };
  for (const [dim, values] of Object.entries(add)) {
    const target = (out[dim] ??= {});
    const used = new Set(Object.values(target));
    for (const [value, slot] of Object.entries(values)) {
      if (target[value] !== undefined) continue;
      if (!used.has(slot) && slot >= 1 && slot <= 8) {
        target[value] = slot;
        used.add(slot);
        continue;
      }
      for (let s = 1; s <= 8; s++) {
        if (!used.has(s)) {
          target[value] = s;
          used.add(s);
          break;
        }
      }
    }
  }
  return out;
}

export interface ColourSlotDeps {
  vaultRoot: string;
  cacheDir: string;
  log: Logger;
  now?: () => number;
  lockStaleMs?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Slots this version understands from a parsed colours.json; entries outside 1..8 are dropped. */
export function parseSlotsFile(raw: unknown): SlotMap | null {
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.dims)) return null;
  const out: SlotMap = {};
  for (const [dim, values] of Object.entries(raw.dims)) {
    if (!isRecord(values)) continue;
    const kept: Record<string, number> = {};
    const used = new Set<number>();
    for (const [value, slot] of Object.entries(values)) {
      if (typeof slot === "number" && Number.isInteger(slot) && slot >= 1 && slot <= 8 && !used.has(slot)) {
        kept[value] = slot;
        used.add(slot);
      }
    }
    out[dim] = kept;
  }
  return out;
}

const sameSlots = (a: SlotMap, b: SlotMap): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The service. With `deps` it persists to `.vault-meta/cortex/state/colours.json` (atomic write under a local lock,
 * re-read inside the lock so two computers converge; an unreadable file is kept aside, never overwritten). Without
 * `deps` it keeps the slots in memory only (the container passes deps once docs/rfcs/E8.md lands).
 */
export function createColourSlotService(deps?: ColourSlotDeps): ColourSlotService {
  let cache: SlotMap = {};
  const now = deps?.now ?? Date.now;

  const read = async (): Promise<{ kind: "ok"; slots: SlotMap } | { kind: "absent" } | { kind: "unreadable"; text: string }> => {
    if (!deps) return { kind: "absent" };
    const text = await readTextIfExists(resolveInVault(deps.vaultRoot, coloursPath()));
    if (text === null) return { kind: "absent" };
    try {
      const slots = parseSlotsFile(JSON.parse(text) as unknown);
      return slots ? { kind: "ok", slots } : { kind: "unreadable", text };
    } catch {
      return { kind: "unreadable", text };
    }
  };

  /** Read-modify-write under the local lock; `change` returns the new slots. */
  const mutate = async (change: (cur: SlotMap) => SlotMap): Promise<void> => {
    if (!deps) {
      cache = change(cache);
      return;
    }
    await ensureCortexRoots(deps.vaultRoot, [CORTEX_PATHS.meta]);
    await ensureCacheDir(deps.cacheDir);
    await withLock(locksDirOf(deps.cacheDir), "state:colours", { owner: "plugin", staleMs: deps.lockStaleMs ?? DEFAULT_STALE_MS }, async (lock) => {
      const file = await read();
      let cur: SlotMap = {};
      if (file.kind === "ok") cur = file.slots;
      else if (file.kind === "unreadable") {
        await writeFileAtomic(writablePath(deps.vaultRoot, `${CORTEX_PATHS.meta}/state/colours.unreadable-${now()}.json`), file.text);
        deps.log.warn("kept an unreadable colours.json aside before writing a new one");
      }
      const next = change(cur);
      cache = next;
      if (file.kind === "ok" && sameSlots(cur, next)) return;
      if (!(await lock.verify())) throw new CortexError("E_LOCKED", "lost the colour slots lock", { retryable: true });
      const body: ColourSlotsFile = { v: 1, dims: next };
      await writeJsonAtomic(writablePath(deps.vaultRoot, coloursPath()), body);
    });
  };

  return {
    current: () => cache,
    async load() {
      const file = await read();
      if (file.kind === "ok") cache = file.slots;
      else if (file.kind === "unreadable") deps?.log.warn("colours.json is unreadable; colours are reassigned until it is fixed");
      return cache;
    },
    merge: (newSlots) => mutate((cur) => mergeSlots(cur, newSlots)),
    reset: (dim) =>
      mutate((cur) => {
        const { [dim]: _dropped, ...rest } = cur;
        return rest;
      }),
  };
}
