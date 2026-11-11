/**
 * Cortex Desktop plays every animation by default: a stored (or default) "Follow system" motion preference becomes
 * "Full" once per vault. The plugin host keeps "Follow system" because Obsidian decides there.
 */
export interface MotionHostResult<T> {
  settings: T;
  /** True when the value was changed (the caller stores the result and writes its marker). */
  changed: boolean;
}

export function motionHostDefault<T extends { appearance?: { motion?: unknown } }>(raw: T, markerExists: boolean): MotionHostResult<T> {
  const motion = raw.appearance?.motion;
  if (markerExists || (motion !== undefined && motion !== "system")) return { settings: raw, changed: false };
  return { settings: { ...raw, appearance: { ...(raw.appearance ?? {}), motion: "full" } } as T, changed: true };
}
