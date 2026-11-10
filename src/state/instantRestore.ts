/**
 * One-shot "restore without a tween" flag (FIG-25). Clearing an isolation or showing every hidden group relights the
 * whole figure in one frame; hiding still fades over 150 ms. The action that restores calls `markInstantRestore()`;
 * the render controller consumes the flag when it next recolours and refreshes point state. The flag expires after
 * `INSTANT_RESTORE_TTL_MS` so a restore that changes nothing cannot leak into a later, unrelated fade.
 */
export const INSTANT_RESTORE_TTL_MS = 1500;

let markedAt = -Infinity;

const clock = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

export function markInstantRestore(now: number = clock()): void {
  markedAt = now;
}

/** True once per mark (and only within the TTL); consuming clears it. */
export function consumeInstantRestore(now: number = clock()): boolean {
  const live = now - markedAt <= INSTANT_RESTORE_TTL_MS;
  markedAt = -Infinity;
  return live;
}

/** Test hook. */
export function resetInstantRestore(): void {
  markedAt = -Infinity;
}
