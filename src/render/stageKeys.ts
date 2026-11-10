/**
 * Stage keyboard map (CORTEX-UX §8.1, §8.3): what a key does while the stage canvas has focus. Pure, so the map and
 * the stepping order are testable without a canvas. Owner: GAPS-UI.
 *  - Arrow keys turn (←/→ yaw, ↑/↓ pitch); with Shift they pan.
 *  - + / − zoom (= and _ count as + and −, so no Shift is needed).
 *  - Tab / Shift Tab step through the traced points, largest first, each one hovered and announced.
 *  - Enter opens the stepped-to point; Ctrl/Cmd Enter opens a vault note in a new Obsidian tab.
 */
import { RENDER_TUNING } from "./tuning";

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export type StageKeyAction =
  | { kind: "turn"; dYawDeg: number; dPitchDeg: number }
  | { kind: "pan"; dxPx: number; dyPx: number }
  | { kind: "zoom"; k: number }
  | { kind: "step"; dir: 1 | -1 }
  | { kind: "open"; newTab: boolean };

/** The action for a key press on the stage, or null when the key is not the stage's. */
export function stageKeyAction(e: KeyLike): StageKeyAction | null {
  const T = RENDER_TUNING.camera;
  const mod = e.ctrlKey || e.metaKey;
  switch (e.key) {
    case "Enter":
      return e.altKey ? null : { kind: "open", newTab: mod };
    case "Tab":
      return mod || e.altKey ? null : { kind: "step", dir: e.shiftKey ? -1 : 1 };
    default:
      break;
  }
  if (mod || e.altKey) return null;
  switch (e.key) {
    case "ArrowLeft":
      return e.shiftKey ? { kind: "pan", dxPx: -T.keyPanPx, dyPx: 0 } : { kind: "turn", dYawDeg: T.keyTurnDeg, dPitchDeg: 0 };
    case "ArrowRight":
      return e.shiftKey ? { kind: "pan", dxPx: T.keyPanPx, dyPx: 0 } : { kind: "turn", dYawDeg: -T.keyTurnDeg, dPitchDeg: 0 };
    case "ArrowUp":
      return e.shiftKey ? { kind: "pan", dxPx: 0, dyPx: -T.keyPanPx } : { kind: "turn", dYawDeg: 0, dPitchDeg: T.keyTurnDeg };
    case "ArrowDown":
      return e.shiftKey ? { kind: "pan", dxPx: 0, dyPx: T.keyPanPx } : { kind: "turn", dYawDeg: 0, dPitchDeg: -T.keyTurnDeg };
    case "+":
    case "=":
      return { kind: "zoom", k: 1 / T.keyZoom };
    case "-":
    case "_":
      return { kind: "zoom", k: T.keyZoom };
    default:
      return null;
  }
}

/** The traced ordinals, largest first (by words; ties keep index order). */
export function tracedOrder(lit: Uint8Array | null, words: ArrayLike<number>, count: number): number[] {
  if (!lit) return [];
  const out: number[] = [];
  const n = Math.min(count, lit.length);
  for (let i = 0; i < n; i++) if (lit[i]) out.push(i);
  return out.sort((a, b) => (words[b] as number) - (words[a] as number) || a - b);
}

/**
 * The ordinal Tab or Shift Tab moves to from `current` (-1 = not started), or null when focus should leave the
 * stage: Shift Tab from the start, and Tab past the last point.
 */
export function stepTarget(order: readonly number[], current: number, dir: 1 | -1): number | null {
  if (order.length === 0) return null;
  const at = current < 0 ? -1 : order.indexOf(current);
  if (at < 0) return dir === 1 ? (order[0] as number) : null;
  const next = at + dir;
  return next < 0 || next >= order.length ? null : (order[next] as number);
}
