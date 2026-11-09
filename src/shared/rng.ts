/**
 * Deterministic randomness for layouts: the same data and seed give the same figure on every open and every
 * machine. Not for security (ids use crypto.getRandomValues). Owner: E1.
 */

/** FNV-1a 32-bit hash of a string (over UTF-16 code units; stable across engines). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG: returns a function producing floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A PRNG seeded from a string (hash32 of the string mixed with an optional numeric seed). */
export function seededRandom(key: string, seed = 0): () => number {
  return mulberry32(hash32(key) ^ Math.imul(seed >>> 0, 0x9e3779b1));
}

/** Stable value in [0, 1) for an id (used for per-point seeds). */
export function unitFromString(s: string): number {
  return hash32(s) / 4294967296;
}

/** Standard normal sample from a uniform source (Box–Muller); never infinite (u is clamped away from 0). */
export function gaussian(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Integer in [min, max] (inclusive) from a uniform source. */
export function randInt(rand: () => number, min: number, max: number): number {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/** Deterministic in-place Fisher–Yates shuffle; returns the same array. */
export function shuffleInPlace<T>(items: T[], rand: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = items[i] as T;
    items[i] = items[j] as T;
    items[j] = tmp;
  }
  return items;
}
