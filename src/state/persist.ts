/**
 * Per-leaf persistence through ItemView.getState/setState (CORTEX-UX §2.2, H6). Owner: E7.
 * localStorage (`app.saveLocalStorage("cortex:leaf-seed")`) only seeds NEW leaves; restored leaves use their
 * own state. Readers are persisted by stable id; ordinals are re-resolved after the index loads.
 *
 * Restore validates every field against the shapes in state/types.ts: a value of the wrong type, an unknown
 * route or a number out of range falls back to that field's default (never a throw, never a half-applied leaf),
 * and a state that is not an object (or has another version) restores the defaults seeded from settings.
 */
import { BUILTIN_DIMS, GROUP_LAYOUTS, isLabelDim, type DimId } from "../shared/dims";
import { CHART_IDS, PAGE_IDS, READER_ROUTES, SHAPES, SHEET_PAGE_ROUTES, SHEET_STACK_MAX, SHEET_WIDTH, type PageId, type ReaderRoute, type SheetEntry, type SheetPageRoute } from "../shared/views";
import { SPACE_ORDER } from "../shared/index-format";
import { normaliseHex } from "../shared/palette";
import type { ColourMode, QueryToken, TimeWindow } from "../shared/protocol/worker";
import { sanitizeHidden } from "../shared/chartHidden";
import type { CortexSettings } from "../shared/settings";
import type { SpaceId } from "../shared/types";
import type { CortexStore } from "./store";
import { defaultUi, defaultView, MOTION_SPEED_RANGE, NAMES_DENSITY, NAMES_FOR, OUTLINE_RANGE, SPINE_ORDERS, STEM_ON_STRENGTH, type CameraPose, type LeafPersistedState, type ViewControls } from "./types";

export function captureLeafState(store: CortexStore, camera?: LeafPersistedState["camera"]): LeafPersistedState {
  const ui = store.get("ui");
  const view = store.get("view");
  const out: LeafPersistedState = {
    v: 1,
    tab: ui.tab,
    view,
    scope: ui.scope,
    period: ui.period,
    sheet: { stack: ui.sheet.stack, index: ui.sheet.index, width: ui.sheet.width, open: ui.sheet.open, ...(ui.sheet.docks && Object.keys(ui.sheet.docks).length > 0 ? { docks: ui.sheet.docks } : {}) },
    keyCollapsed: ui.keyCollapsed,
    tokens: ui.tokens,
    navAll: ui.navFull,
    navMore: ui.navMore,
  };
  if (ui.hiddenGroups.length > 0) out.hidden = [...ui.hiddenGroups];
  if (camera) out.camera = camera;
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown, max = 400): v is string => typeof v === "string" && v.length <= max;
/** The docks a leaf remembers (which edge each page sits on at XL and L): known pages and sides only, nothing when none is valid. */
function sanitizeDocks(raw: unknown): { docks?: Partial<Record<SheetPageRoute, "left" | "right">> } {
  if (!isRecord(raw)) return {};
  const docks: Partial<Record<SheetPageRoute, "left" | "right">> = {};
  for (const route of SHEET_PAGE_ROUTES) {
    const side = raw[route];
    if (side === "left" || side === "right") docks[route] = side;
  }
  return Object.keys(docks).length > 0 ? { docks } : {};
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

const DIM_IDS: ReadonlySet<string> = new Set(BUILTIN_DIMS.map((d) => d.id));

function isDimId(v: unknown): v is DimId {
  if (typeof v !== "string" || v.length > 200) return false;
  if (DIM_IDS.has(v)) return true;
  if (/^(day|week|month|year):imported$/.test(v)) return true;
  if (v === "maker:notes" || v === "maker:record") return true;
  return isLabelDim(v as DimId) && /^label:[^/]+\/[^/]+$/.test(v);
}

/** Keep `raw` only where it has the same type as `base`; recurse into plain objects (keys not in `base` are dropped). */
function sameShape<T>(base: T, raw: unknown): T {
  if (isRecord(base)) {
    if (!isRecord(raw)) return base;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(base)) out[k] = sameShape((base as Record<string, unknown>)[k], raw[k]);
    return out as T;
  }
  if (Array.isArray(base)) return (Array.isArray(raw) ? raw : base) as T;
  if (typeof base === "number") return (isNum(raw) ? raw : base) as T;
  if (typeof base === "boolean") return (typeof raw === "boolean" ? raw : base) as T;
  if (typeof base === "string") return (isStr(raw) ? raw : base) as T;
  return base;
}

function colourMode(raw: unknown, base: ColourMode): ColourMode {
  if (!isRecord(raw)) return base;
  if (raw.kind === "age") return { kind: "age" };
  if (raw.kind === "single" && isNum(raw.slot) && Number.isInteger(raw.slot) && raw.slot >= 0 && raw.slot < 64) {
    const hex = isStr(raw.hex, 7) ? normaliseHex(raw.hex) : null;
    return hex ? { kind: "single", slot: raw.slot, hex } : { kind: "single", slot: raw.slot };
  }
  if (raw.kind === "categorical" && isDimId(raw.dim)) return { kind: "categorical", dim: raw.dim };
  return base;
}

/** The view controls from saved data, field by field. */
export function sanitizeView(raw: unknown, base: ViewControls): ViewControls {
  if (!isRecord(raw)) return base;
  const out: ViewControls = sameShape(base, raw);
  out.shape = oneOf(SHAPES, raw.shape) ? raw.shape : base.shape;
  out.morph = isNum(raw.morph) ? Math.max(0, Math.min(1, raw.morph)) : base.morph;
  out.groupBy = isDimId(raw.groupBy) ? raw.groupBy : base.groupBy;
  out.layout = oneOf(GROUP_LAYOUTS, raw.layout) ? raw.layout : base.layout;
  out.placement = raw.placement === "area" || raw.placement === "role" ? raw.placement : base.placement;
  out.core = raw.core === "oldest" || raw.core === "newest" || raw.core === "largest" ? raw.core : base.core;
  out.pose = raw.pose === "lying" || raw.pose === "standing" ? raw.pose : base.pose;
  const c = isRecord(raw.colour) ? raw.colour : {};
  out.colour = {
    notes: colourMode(c.notes, base.colour.notes),
    record: colourMode(c.record, base.colour.record),
    same: typeof c.same === "boolean" ? c.same : base.colour.same,
    fold: typeof c.fold === "boolean" ? c.fold : base.colour.fold,
    hideNoValue: typeof c.hideNoValue === "boolean" ? c.hideNoValue : base.colour.hideNoValue,
  };
  const m = isRecord(raw.motion) ? raw.motion : {};
  out.motion = {
    mode: m.mode === "drift" || m.mode === "spin" || m.mode === "off" ? m.mode : base.motion.mode,
    speed: isNum(m.speed) ? Math.max(MOTION_SPEED_RANGE[0], Math.min(MOTION_SPEED_RANGE[1], m.speed)) : base.motion.speed,
    pauseWhilePointing: typeof m.pauseWhilePointing === "boolean" ? m.pauseWhilePointing : base.motion.pauseWhilePointing,
    keepUpright: typeof m.keepUpright === "boolean" ? m.keepUpright : base.motion.keepUpright,
  };
  const l = isRecord(raw.look) ? raw.look : {};
  const near = (v: unknown, fallback: number, lo: number, hi: number): number => (isNum(v) ? Math.max(lo, Math.min(hi, v)) : fallback);
  out.look = {
    dotSize: near(l.dotSize, base.look.dotSize, 0.2, 4),
    glow: near(l.glow, base.look.glow, 0, 4),
    brightness: near(l.brightness, base.look.brightness, 0.2, 3),
    scatter: near(l.scatter, base.look.scatter, 0.5, 1.5),
    names: l.names === "off" || l.names === "hover" || l.names === "always" ? l.names : base.look.names,
    lines: l.lines === "off" || l.lines === "selection" || l.lines === "all" ? l.lines : base.look.lines,
    // Saved views from before the strength slider hold a boolean: on becomes the old fixed strength.
    stemStrength: isNum(l.stemStrength) ? near(l.stemStrength, base.look.stemStrength, 0, 1) : typeof l.stems === "boolean" ? (l.stems ? STEM_ON_STRENGTH : 0) : base.look.stemStrength,
    groupLabels: typeof l.groupLabels === "boolean" ? l.groupLabels : base.look.groupLabels,
    shimmer: typeof l.shimmer === "boolean" ? l.shimmer : base.look.shimmer,
    outline: near(l.outline, base.look.outline, OUTLINE_RANGE[0], OUTLINE_RANGE[1]),
    namesFor: oneOf(NAMES_FOR, l.namesFor) ? l.namesFor : base.look.namesFor,
    density: oneOf(NAMES_DENSITY, l.density) ? l.density : base.look.density,
  };
  out.spineOrder = oneOf(SPINE_ORDERS, raw.spineOrder) ? raw.spineOrder : base.spineOrder;
  out.splitGroups = typeof raw.splitGroups === "boolean" ? raw.splitGroups : base.splitGroups;
  out.groupByRecord = out.splitGroups && isDimId(raw.groupByRecord) ? raw.groupByRecord : null;
  out.syncKeyToGroups = typeof raw.syncKeyToGroups === "boolean" ? raw.syncKeyToGroups : base.syncKeyToGroups;
  const lo = isRecord(raw.layoutOptions) ? raw.layoutOptions : {};
  out.layoutOptions = { gridMarks: lo.gridMarks === "rows" || lo.gridMarks === "spheres" ? lo.gridMarks : base.layoutOptions.gridMarks };
  out.chart = chartSpec(raw.chart);
  return out;
}

function chartSpec(raw: unknown): ViewControls["chart"] {
  if (!isRecord(raw) || !oneOf(CHART_IDS as readonly string[], raw.chart)) return null;
  if (!isRecord(raw.x)) return null;
  return raw as unknown as ViewControls["chart"];
}

function sheetEntry(raw: unknown): SheetEntry | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "page" && oneOf(SHEET_PAGE_ROUTES, raw.route)) {
    const route: SheetPageRoute = raw.route;
    if (isRecord(raw.params)) {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.params)) if (isStr(v, 400) && k.length <= 60) params[k] = v;
      return { kind: "page", route, params };
    }
    return { kind: "page", route };
  }
  if (raw.kind === "reader" && oneOf(READER_ROUTES, raw.route) && isStr(raw.id, 200) && raw.id.length > 0) {
    const route: ReaderRoute = raw.route;
    return { kind: "reader", route, id: raw.id };
  }
  return null;
}

function token(raw: unknown): QueryToken | null {
  if (!isRecord(raw) || !isStr(raw.id, 200) || !isStr(raw.label, 400) || !oneOf(["text", "group", "time", "band", "set"] as const, raw.kind)) return null;
  const t: QueryToken = { id: raw.id, kind: raw.kind, label: raw.label };
  if (isStr(raw.text, 2000)) t.text = raw.text;
  if (isDimId(raw.dim)) t.dim = raw.dim;
  if (isStr(raw.value, 400)) t.value = raw.value;
  if (Array.isArray(raw.range) && raw.range.length === 2 && isNum(raw.range[0]) && isNum(raw.range[1])) t.range = [raw.range[0], raw.range[1]];
  if (raw.recordsOnly === true) t.recordsOnly = true;
  if (Array.isArray(raw.ids)) t.ids = raw.ids.filter((x): x is string => isStr(x, 200)).slice(0, 5000);
  return t;
}

function period(raw: unknown): TimeWindow | null {
  return Array.isArray(raw) && raw.length === 2 && isNum(raw[0]) && isNum(raw[1]) && raw[0] <= raw[1] ? [raw[0], raw[1]] : null;
}

export function sanitizeCamera(raw: unknown): CameraPose | undefined {
  if (!isRecord(raw) || !isNum(raw.yawDeg) || !isNum(raw.pitchDeg) || !isNum(raw.distance) || !Array.isArray(raw.target) || raw.target.length !== 3 || !raw.target.every(isNum)) return undefined;
  return {
    yawDeg: Math.max(-360, Math.min(360, raw.yawDeg)),
    pitchDeg: Math.max(-90, Math.min(90, raw.pitchDeg)),
    distance: Math.max(0.15, Math.min(4, raw.distance)),
    target: [raw.target[0] as number, raw.target[1] as number, raw.target[2] as number],
  };
}

/** The camera saved in a state (null when there is none or it is damaged). */
export function savedCamera(raw: unknown): CameraPose | null {
  return isRecord(raw) ? (sanitizeCamera(raw.camera) ?? null) : null;
}

/** Restore a leaf from saved state; anything malformed falls back to the defaults seeded from settings. */
export function restoreLeafState(store: CortexStore, raw: unknown, settings: Pick<CortexSettings, "general" | "appearance">): void {
  const base = defaultView(settings);
  if (!isRecord(raw) || raw.v !== 1) {
    store.update("view", () => base);
    return;
  }
  const ui0 = defaultUi();
  store.batch(() => {
    store.update("view", () => sanitizeView(raw.view, base));
    store.update("ui", (ui) => {
      const tab: PageId = oneOf(PAGE_IDS, raw.tab) ? raw.tab : ui.tab;
      const scope: SpaceId | "all" = raw.scope === "all" || oneOf(SPACE_ORDER, raw.scope) ? (raw.scope as SpaceId | "all") : ui.scope;
      const saved = isRecord(raw.sheet) ? raw.sheet : {};
      const entries = (Array.isArray(saved.stack) ? saved.stack : []).map(sheetEntry).filter((e): e is SheetEntry => e !== null);
      const stack = entries.slice(-SHEET_STACK_MAX);
      const wanted = isNum(saved.index) && Number.isInteger(saved.index) ? saved.index - (entries.length - stack.length) : stack.length - 1;
      const index = stack.length === 0 ? -1 : Math.max(0, Math.min(stack.length - 1, wanted));
      const width = isNum(saved.width) ? Math.max(SHEET_WIDTH.min, Math.min(SHEET_WIDTH.max, Math.round(saved.width))) : ui0.sheet.width;
      return {
        ...ui,
        tab,
        scope,
        period: period(raw.period),
        keyCollapsed: raw.keyCollapsed === true,
        navFull: raw.navAll !== false,
        navMore: raw.navMore === true,
        hiddenGroups: sanitizeHidden(raw.hidden),
        tokens: (Array.isArray(raw.tokens) ? raw.tokens : []).map(token).filter((t): t is QueryToken => t !== null).slice(0, 50),
        sheet: { open: saved.open === true && stack.length > 0, width, stack, index, ...sanitizeDocks(saved.docks) },
      };
    });
  });
}
