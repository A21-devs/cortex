/**
 * The Showcase chord: Ctrl+0 followed by Ctrl+9 within one second. Ctrl+0 on its own is not consumed (it keeps its
 * normal meaning, actual size); any other key between the two, or a pause longer than the window, disarms it. Pure,
 * so a test can feed it events with timestamps.
 */
export const CHORD_WINDOW_MS = 1000;

export interface ChordKey {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
}

export type ChordResult = "arm" | "fire" | "reset" | "ignore";

const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"]);

function isDigit(e: ChordKey, d: "0" | "9"): boolean {
  return e.key === d || e.code === `Digit${d}` || e.code === `Numpad${d}`;
}

export interface Chord {
  feed(e: ChordKey, now: number): ChordResult;
  reset(): void;
}

export function createChord(windowMs = CHORD_WINDOW_MS): Chord {
  let armedAt: number | null = null;
  return {
    feed(e, now) {
      // A held key repeats and a modifier alone is part of the chord, not a key between the two.
      if (e.repeat === true || MODIFIERS.has(e.key)) return "ignore";
      const plain = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
      if (plain && isDigit(e, "0")) {
        armedAt = now;
        return "arm";
      }
      if (plain && isDigit(e, "9") && armedAt !== null && now - armedAt <= windowMs) {
        armedAt = null;
        return "fire";
      }
      armedAt = null;
      return "reset";
    },
    reset() {
      armedAt = null;
    },
  };
}
