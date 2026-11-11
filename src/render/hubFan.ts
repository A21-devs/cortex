/**
 * Hub hover link fan (SPEC F9, "Hub link": straight, alpha 0.35, colour gradient hub → member). One 1 px segment from
 * the hub to each member that is placed; the end colours are the hub's and the member's. The spoke family multiplies
 * the vertex alpha by its tuned 0.55, so the vertex alpha is chosen to land on the fan's own alpha. Pure. Owner: E10.
 */
import { RENDER_TUNING } from "./tuning";

/** Alpha the fan ends at (before the depth cue). */
export const HUB_FAN_ALPHA = 0.35;

export interface HubFan {
  positions: Float32Array;
  colors: Uint8Array;
  t: Float32Array;
  segments: number;
}

/**
 * The positions the fan joins: the Body's anatomy, or (Groups, once its morph has settled) the arrangement's points
 * where they are on screen now; a chart's position buffer is used the same way, so a map's links fan out across the
 * chart's marks. Null when no fan can be drawn (a morph still under way, no arrangement yet).
 */
export function fanPositions(shape: string, morph: number, settled: number, bodyAnat: Float32Array, arrangement: Float32Array | null): Float32Array | null {
  if (shape === "body") return bodyAnat;
  if ((shape === "groups" || shape === "chart") && arrangement !== null && morph > settled) return arrangement;
  return null;
}

/**
 * @param anat   x, y, z per ordinal (NaN where a point is not drawn)
 * @param colour RGBA8 per ordinal
 */
export function buildHubFan(anat: Float32Array, colour: Uint8Array | null, hub: number, members: readonly number[]): HubFan {
  const at = (o: number): number => o * 3;
  const placed = (o: number): boolean => o >= 0 && at(o) + 2 < anat.length && Number.isFinite((anat[at(o)] as number) + (anat[at(o) + 1] as number) + (anat[at(o) + 2] as number));
  const out: number[] = members.filter(placed);
  const n = placed(hub) ? out.length : 0;
  const positions = new Float32Array(n * 6);
  const colors = new Uint8Array(n * 8);
  const t = new Float32Array(n * 2);
  const alpha = Math.round(255 * Math.min(1, HUB_FAN_ALPHA / RENDER_TUNING.lines.spokeAlpha));
  const rgb = (o: number, k: number): number => (colour ? ((colour[o * 4 + k] as number | undefined) ?? 255) : 255);
  for (let i = 0; i < n; i++) {
    const m = out[i] as number;
    positions.set([anat[at(hub)] as number, anat[at(hub) + 1] as number, anat[at(hub) + 2] as number, anat[at(m)] as number, anat[at(m) + 1] as number, anat[at(m) + 2] as number], i * 6);
    for (let k = 0; k < 3; k++) {
      colors[i * 8 + k] = rgb(hub, k);
      colors[i * 8 + 4 + k] = rgb(m, k);
    }
    colors[i * 8 + 3] = alpha;
    colors[i * 8 + 7] = alpha;
    t[i * 2] = 0;
    t[i * 2 + 1] = 1;
  }
  return { positions, colors, t, segments: n };
}
