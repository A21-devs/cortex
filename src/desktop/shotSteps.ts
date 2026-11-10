/**
 * Steps for the screenshot harness (scripts/desktop-shot.mjs → Electron main, src/desktop/main.ts). A steps file
 * is a JSON array (or `{ "steps": [...] }`) of objects with exactly one action each:
 *   { "wait": 1500 }                                   wait, in ms (≤ 10 min)
 *   { "click": ".cx-header button[aria-label='Settings']", "timeout": 5000 }
 *                                                      click the element's centre (waits for it to appear)
 *   { "eval": "document.body.dataset.x = '1'" }        run JavaScript in the page (awaited; the value is reported)
 *   { "size": "1280x800" }  /  { "size": [1280, 800] }  /  { "size": { "width": 1280, "height": 800 } }
 *                                                      set the window's content size
 *   { "capture": "after-click.png" }                   save a PNG (relative paths land in --out)
 * The canonical form `{ "type": "wait", "ms": 1500 }` (and `selector`, `js`, `width`/`height`, `path`) is
 * accepted too. Pure: tests run it directly.
 */

export type ShotStep =
  | { kind: "wait"; ms: number }
  | { kind: "click"; selector: string; timeoutMs: number }
  | { kind: "eval"; js: string }
  | { kind: "size"; width: number; height: number }
  | { kind: "capture"; path: string };

export class StepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepError";
  }
}

export const STEP_LIMITS = {
  maxSteps: 500,
  maxWaitMs: 600_000,
  defaultClickTimeoutMs: 10_000,
  minSide: 200,
  maxWidth: 7680,
  maxHeight: 4320,
  maxText: 100_000,
} as const;

const ACTIONS = ["wait", "click", "eval", "size", "capture"] as const;
type Action = (typeof ACTIONS)[number];

/** "1512x982" (or "1512×982", "1512,982") → { width, height }. */
export function parseSize(text: string): { width: number; height: number } {
  const m = /^\s*(\d{2,5})\s*[x×,]\s*(\d{2,5})\s*$/i.exec(text);
  if (!m) throw new StepError(`size "${text}" is not WIDTHxHEIGHT`);
  return checkSize(Number(m[1]), Number(m[2]));
}

function checkSize(width: unknown, height: unknown): { width: number; height: number } {
  const ok = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= STEP_LIMITS.minSide && v <= max;
  if (!ok(width, STEP_LIMITS.maxWidth) || !ok(height, STEP_LIMITS.maxHeight)) {
    throw new StepError(`size must be whole pixels between ${STEP_LIMITS.minSide} and ${STEP_LIMITS.maxWidth}×${STEP_LIMITS.maxHeight}`);
  }
  return { width, height };
}

function sizeOf(v: unknown, step: Record<string, unknown>): { width: number; height: number } {
  if (typeof v === "string") return parseSize(v);
  if (Array.isArray(v) && v.length === 2) return checkSize(v[0], v[1]);
  if (v && typeof v === "object") return checkSize((v as Record<string, unknown>).width, (v as Record<string, unknown>).height);
  if (v === undefined) return checkSize(step.width, step.height);
  throw new StepError("size needs WIDTHxHEIGHT, [width, height] or { width, height }");
}

function text(v: unknown, what: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new StepError(`${what} must be a non-empty string`);
  if (v.length > STEP_LIMITS.maxText) throw new StepError(`${what} is too long`);
  if (v.includes("\u0000")) throw new StepError(`${what} contains a NUL character`);
  return v;
}

function ms(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > STEP_LIMITS.maxWaitMs) throw new StepError(`${what} must be a number of milliseconds between 0 and ${STEP_LIMITS.maxWaitMs}`);
  return Math.round(v);
}

/** A capture path: a file name or path ending in .png (".png" is added when there is no extension). */
export function capturePath(v: unknown): string {
  const p = text(v, "capture path").trim();
  if (/[<>"|?*]/.test(p.replace(/^[a-zA-Z]:/, ""))) throw new StepError(`capture path "${p}" has characters a file name cannot hold`);
  if (/\.png$/i.test(p)) return p;
  if (/\.[a-z0-9]{1,5}$/i.test(p)) throw new StepError(`capture path "${p}" must end in .png`);
  return `${p}.png`;
}

/** One step object → a ShotStep. */
export function parseStep(raw: unknown, index = 0): ShotStep {
  const where = `step ${index + 1}`;
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new StepError("must be an object");
    const s = raw as Record<string, unknown>;
    let action: Action;
    if (typeof s.type === "string") {
      if (!(ACTIONS as readonly string[]).includes(s.type)) throw new StepError(`unknown type "${s.type}" (use ${ACTIONS.join(", ")})`);
      action = s.type as Action;
    } else {
      const present = ACTIONS.filter((a) => a in s);
      if (present.length === 0) throw new StepError(`needs one of ${ACTIONS.join(", ")}`);
      if (present.length > 1) throw new StepError(`has more than one action (${present.join(", ")})`);
      action = present[0] as Action;
    }
    const value = typeof s.type === "string" ? undefined : s[action];
    switch (action) {
      case "wait":
        return { kind: "wait", ms: ms(value ?? s.ms, "wait") };
      case "click":
        return { kind: "click", selector: text(value ?? s.selector, "click selector"), timeoutMs: s.timeout === undefined ? STEP_LIMITS.defaultClickTimeoutMs : ms(s.timeout, "click timeout") };
      case "eval":
        return { kind: "eval", js: text(value ?? s.js ?? s.script, "eval script") };
      case "size":
        return { kind: "size", ...sizeOf(value, s) };
      case "capture":
        return { kind: "capture", path: capturePath(value ?? s.path) };
    }
  } catch (e) {
    throw new StepError(`${where}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A whole steps document (array, or `{ steps: [...] }`) → ShotStep[]. */
export function parseSteps(raw: unknown): ShotStep[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { steps?: unknown }).steps) ? ((raw as { steps: unknown[] }).steps as unknown[]) : null;
  if (!list) throw new StepError("steps must be a JSON array (or an object with a \"steps\" array)");
  if (list.length > STEP_LIMITS.maxSteps) throw new StepError(`too many steps (${list.length} > ${STEP_LIMITS.maxSteps})`);
  return list.map((s, i) => parseStep(s, i));
}

/** Parse the text of a steps file (JSON). */
export function parseStepsText(json: string): ShotStep[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json.charCodeAt(0) === 0xfeff ? json.slice(1) : json);
  } catch (e) {
    throw new StepError(`steps file is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  return parseSteps(raw);
}
