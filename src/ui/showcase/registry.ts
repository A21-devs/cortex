/**
 * Showcase mode's registry: the beats of the hands-free tour and how fast each one moves (docs/research/showcase-spec.md).
 * A beat is a function that returns its steps for what this build and this record offer; a step sets absolute state
 * (never "the next one"), so the tour can start, skip or loop anywhere. Steps only move the view: in-memory store
 * actions, bus events to the renderer, the settings preview, and the window's tilt driven through ui/showcase/dom.ts.
 * Nothing here writes a file, calls an agent, records a read or imports anything.
 *
 * It shows the figure and its charts, nothing else (the user's rule; on 2026-11-12 they added that no tab opens): the
 * brain, spine and body with their camera moves, lens flips, colours, groupings, name labels and selection lines, and
 * the chart run drawn on the figure itself. No step opens a page or a tab (not Chart, not Time), Settings, the add
 * sheet, a reader, the Display panel, the start screen, a dialog, a menu, the Ask console or Find's results. A grouping
 * is never by a label field and never split between notes and record (that would bring up the coverage note with its
 * Add sources link), and its colours are shown as a preview, so the colours it hands new values are never written to
 * the record's colour file.
 *
 * Pace: every step belongs to a tempo class. Bursts (0.22 to 0.35 s) are the quick flips (areas, colours, picked
 * entries), normal beats (0.45 to 0.7 s) are groupings and charts, and holds (1.0 to 1.6 s)
 * fall only on the figure (turning, flying). Morphs are short, so a change reads as a cut with a quick blend; the camera
 * moves are continuous and run under the steps that follow them. A loop is built from a seed: the order of the beats and
 * every hold vary a little each lap, so the tour never repeats itself exactly. One loop lasts about 40 to 70 s.
 *
 * Every step may be unavailable (`available`): the runner passes over it without a pause, so an empty index, a host
 * with no window or no preview never stalls the tour or shows an error.
 */
import { BUILTIN_DIMS, GROUP_LAYOUTS, isLabelBased, type DimId, type GroupLayout } from "../../shared/dims";
import type { ColourThemeId } from "../../shared/colourTheme";
import type { PaletteId } from "../../shared/settings";
import type { SpaceId } from "../../shared/types";
import type { ChartSpec } from "../../shared/protocol/worker";
import { WAVE_SCALES, WAVE_SMOOTHINGS } from "../../shared/chartOptions";
import { CHART_CATALOGUE, type ChartId, type ShapeKind } from "../../shared/views";
import * as A from "../../state/actions";
import type { CameraMoveLeg } from "../../state/events";
import type { CortexStore } from "../../state/store";
import type { ViewControls } from "../../state/types";
import { chartAvailable, chartSpecFor, layoutsFor } from "../stage/ShapeBar";
import type { WindowTilt } from "./dom";

export type BeatId = "open" | "inside" | "orbit" | "fly" | "lens" | "colours" | "groups" | "charts" | "picks" | "names";

/** How fast a step moves: a quick flip, a normal beat, or a hold on the figure. */
export type Tempo = "burst" | "normal" | "hold";

/** The range each class draws its holds from (ms), and the wider range a step of that class may have. */
export const TEMPO_RANGE: Readonly<Record<Tempo, readonly [number, number]>> = { burst: [230, 340], normal: [450, 700], hold: [1000, 1600] };
export const TEMPO_ALLOWED: Readonly<Record<Tempo, readonly [number, number]>> = { burst: [200, 360], normal: [400, 760], hold: [950, 1700] };

/** The class a hold in ms belongs to. */
export function tempoOf(ms: number): Tempo {
  return ms <= TEMPO_ALLOWED.burst[1] ? "burst" : ms <= TEMPO_ALLOWED.normal[1] ? "normal" : "hold";
}

/** A small seeded generator (mulberry32): the same seed always builds the same loop. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An entry of the record the tour selects on the figure (only selected: nothing opens it). */
export interface TourEntry {
  ordinal: number;
  id: string;
}

/** What a step can touch. The runner supplies it; tests supply a recording one. */
export interface ShowcaseCtx {
  store: CortexStore;
  /** Items in the loaded index now (steps that need one skip themselves at 0; the runner reads it at each step). */
  readonly count: number;
  /** The view as the person had it when the tour began: what every beat returns to between its steps. */
  base: ViewControls;
  /** Renderer requests. */
  grow(): void;
  home(): void;
  /** Fly a scripted camera path (a dolly, an orbit, the comet tilt, a fly-through); an empty path stops it. */
  camera(legs: CameraMoveLeg[]): void;
  /** Animate the morph to `to` over `ms`. */
  morph(to: number, ms: number): void;
  /** Show a colour theme on the figure without saving it (settings preview). */
  theme(id: ColourThemeId): void;
  /** Entries to select on the figure, spread through the record, each a different one (empty: nothing in the record). */
  entries(n: number): TourEntry[];
  /** Run `fn` after `ms` (a timer the tour clears when it stops). */
  after(ms: number, fn: () => void): void;
  /** Show a data palette on the figure without saving it (null: back to the person's own colours, a space's look included). Absent when the host cannot preview. */
  palette?(id: PaletteId | null): void;
  /** Turn the whole window in 3D (null: back to rest). Absent without a window. */
  tilt?(t: WindowTilt | null): void;
}

export interface ShowcaseStep {
  id: string;
  beat: BeatId;
  tempo: Tempo;
  /** Milliseconds before the next step. */
  hold: number;
  /** False when the host or the record cannot show this step (the runner moves on without a pause). */
  available?(ctx: ShowcaseCtx): boolean;
  run(ctx: ShowcaseCtx): void;
}

/** What this build and this record offer. */
export interface ShowcaseEnv {
  layouts: readonly GroupLayout[];
  charts: readonly ChartId[];
  themes: readonly ColourThemeId[];
  areas: readonly SpaceId[];
  /** The data palettes to flip through (empty or absent: the host cannot preview them). */
  palettes?: readonly PaletteId[];
}

export interface ShowcaseBeat {
  id: BeatId;
  steps(env: ShowcaseEnv, rng: () => number): ShowcaseStep[];
}

// ───────────────────────────── helpers ─────────────────────────────

/** A hold drawn from the class's range. */
function holdFor(tempo: Tempo, rng: () => number): number {
  const [lo, hi] = TEMPO_RANGE[tempo];
  return Math.round(lo + (hi - lo) * rng());
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * The quiet baseline a beat starts from: nothing isolated, no page, panel, Ask console or Find list open, the look as the
 * person had it. (The shape bar's own panel at S is the shell's, not the store's: the runner keeps it shut.)
 */
export function settle(ctx: ShowcaseCtx, shape: ShapeKind): void {
  const store = ctx.store;
  const base = ctx.base;
  store.batch(() => {
    A.closeSheet(store);
    store.update("ui", (u) => ({ ...u, popover: null, preview: null, dimPreview: null, command: { ...u.command, resultsOpen: false, consoleOpen: false } }));
    A.setScope(store, "all");
    A.showAllGroups(store);
    A.clearSelection(store);
    A.setLook(store, { lines: base.look.lines, names: base.look.names, namesFor: base.look.namesFor, density: base.look.density, outline: base.look.outline });
    A.setView(store, "colour", base.colour);
    A.setMotion(store, base.motion);
    if (shape === "body") A.setShape(store, "body");
  });
}

/** A dimension the layout can group by: the current one when it allows it, else the first built-in that does. */
export function dimForLayout(current: DimId, layout: GroupLayout): DimId {
  if (layoutsFor(current).includes(layout)) return current;
  return BUILTIN_DIMS.find((d) => d.layouts.includes(layout))?.id ?? current;
}

/**
 * A dimension the tour may group the figure by: never a label field, Your labels or Your fixes. Grouped by one of those,
 * the stage puts up its coverage note (with Add sources and the sample record) whenever a value is thin; the area is
 * shown instead.
 */
export function tourDim(want: DimId, layout: GroupLayout): DimId {
  return isLabelBased(want) ? dimForLayout("space", layout) : want;
}

type Opts = { ms?: number; available?: ShowcaseStep["available"] };

function stepper(beat: BeatId, rng: () => number) {
  return (id: string, tempo: Tempo, run: ShowcaseStep["run"], o: Opts = {}): ShowcaseStep => ({
    id,
    beat,
    tempo,
    hold: o.ms ?? holdFor(tempo, rng),
    ...(o.available ? { available: o.available } : {}),
    run,
  });
}

const hasRecord = (c: ShowcaseCtx): boolean => c.count > 0;
const SHORT_MORPH_MS = 220;

/**
 * Show a grouped figure: the grouping, the layout and the Groups shape, morphing in quickly. Notes and record are grouped
 * alike (never split), by a dimension that is not a label field. The key follows the grouping as it does on the Groups
 * shape, and the figure is coloured through the dimension preview: a previewed dimension's new colours are never
 * written to the record's colour file (render/controller.ts), and the preview ends with the grouping (`endGroups`).
 */
function showGroups(c: ShowcaseCtx, want: DimId, layout: GroupLayout, ms = SHORT_MORPH_MS): void {
  const store = c.store;
  const dim = tourDim(want, layout);
  const use = layoutsFor(dim).includes(layout) ? layout : (layoutsFor(dim)[0] ?? layout);
  store.batch(() => {
    A.closeSheet(store);
    A.setScope(store, "all");
    store.update("view", (v) => ({ ...v, groupBy: dim, layout: use, shape: "groups", splitGroups: false, groupByRecord: null, colour: { ...v.colour, notes: { kind: "categorical", dim } } }));
    store.update("ui", { hiddenGroups: [], dimPreview: dim, dimPreviewPop: "notes" });
  });
  c.morph(1, ms);
}

/** A grouping is over: the person's colours come back and the dimension preview ends, together (so nothing new is committed in between). */
function endGroups(c: ShowcaseCtx): void {
  c.store.batch(() => {
    A.setView(c.store, "colour", c.base.colour);
    c.store.update("ui", { dimPreview: null });
  });
}

/** Show a chart: its spec and the Chart shape, morphing in quickly. */
function showChart(c: ShowcaseCtx, spec: ChartSpec, ms = SHORT_MORPH_MS): void {
  const store = c.store;
  store.batch(() => {
    A.setScope(store, "all");
    A.setView(store, "chart", spec);
    A.setShape(store, "chart");
  });
  c.morph(1, ms);
}

/** A chart spec with explicit axes and the options set from nothing (a beat never inherits the one before it). */
function tourChart(id: ChartId, patch: Partial<ChartSpec>, options: ChartSpec["options"] = {}): ChartSpec {
  return { ...chartSpecFor(id, null, "space"), ...patch, options };
}

// ───────────────────────────── the beats ─────────────────────────────

/** 1. The cold open: the points scatter from nothing and assemble into the figure, spine first. */
const open: ShowcaseBeat = {
  id: "open",
  steps: (_env, rng) => {
    const s = stepper("open", rng);
    return [
      s("open-grow", "hold", (c) => {
        settle(c, "body");
        A.setMotion(c.store, { mode: "off", speed: 1 });
        c.morph(0, 1);
        c.camera([]);
        c.home();
        // The growth plays on the next tick, once the figure is back on the body and the camera at home.
        c.after(0, () => c.grow());
      }),
    ];
  },
};

/** 2. Inside the brain: the camera starts among the points with the links fanning out, and pulls back to the whole figure. */
const inside: ShowcaseBeat = {
  id: "inside",
  steps: (_env, rng) => {
    const s = stepper("inside", rng);
    const lean = (rng() < 0.5 ? -1 : 1) * (14 + Math.round(rng() * 16));
    return [
      s(
        "inside-pull",
        "hold",
        (c) => {
          settle(c, "body");
          A.setLook(c.store, { lines: "all" });
          c.camera([
            { at: "brain", distance: 0.05, yawDeg: -lean, pitchDeg: 6, ms: 1 },
            { at: "brain", distance: 0.3, yawDeg: lean, pitchDeg: 2, ms: 750, ease: "inout" },
            { at: "home", distance: 1, ms: 800, ease: "out" },
          ]);
        },
        { ms: 1250 + Math.round(rng() * 250) },
      ),
      s("inside-calm", "normal", (c) => A.setLook(c.store, { lines: c.base.look.lines })),
    ];
  },
};

/** 3. Orbit and close-ups: the brain and the neck at different angles, the figure lying like a comet, far out, and a quick push back in. */
const orbit: ShowcaseBeat = {
  id: "orbit",
  steps: (_env, rng) => {
    const s = stepper("orbit", rng);
    const side = rng() < 0.5 ? -1 : 1;
    return [
      s("orbit-brain", "hold", (c) => {
        settle(c, "body");
        A.setMotion(c.store, { mode: "off" });
        c.camera([{ at: "brain", distance: 0.3, yawDeg: 40 * side, pitchDeg: 8, ms: 900, ease: "inout" }]);
      }),
      s("orbit-neck", "hold", (c) => c.camera([{ at: "neck", distance: 0.34, yawDeg: -50 * side, pitchDeg: -6, ms: 900, ease: "inout" }])),
      s("orbit-spin", "hold", (c) => {
        A.setMotion(c.store, { mode: "spin", speed: 2 });
        c.camera([{ at: "home", distance: 0.8, yawDeg: 150 * side, pitchDeg: 6, ms: 1200, ease: "inout" }]);
      }),
      s("orbit-comet", "hold", (c) => c.camera([{ at: "figure", distance: 0.95, yawDeg: 18 * side, pitchDeg: 4, rollDeg: 90 * side, ms: 900, ease: "inout" }])),
      s("orbit-far", "hold", (c) => c.camera([{ at: "figure", distance: 3.4, yawDeg: 10 * side, pitchDeg: 0, rollDeg: 90 * side, ms: 800, ease: "inout" }])),
      s("orbit-push", "normal", (c) => c.camera([{ at: "home", distance: 1, ms: 520, rollDeg: 0, ease: "out" }])),
    ];
  },
};

/** Fractions of the record the fly-through passes, as the camera's waypoints. */
const FLY_WAYPOINTS: readonly (readonly number[])[] = [
  [0.1, 0.34, 0.58],
  [0.82, 0.46, 0.22],
];

/** 4. The fly-through: the camera travels through the open cloud past the points, with every link drawn as a ray (two passes, one after the other). */
const fly: ShowcaseBeat = {
  id: "fly",
  steps: (_env, rng) => {
    const s = stepper("fly", rng);
    const pass = (id: string, fractions: readonly number[], first: boolean): ShowcaseStep => {
      const waypoints = fractions.map((f) => Math.min(0.97, Math.max(0.02, f + (rng() - 0.5) * 0.12)));
      return s(
        id,
        "hold",
        (c) => {
          if (first) {
            settle(c, "body");
            A.setLook(c.store, { lines: "all" });
          }
          const legs: CameraMoveLeg[] = waypoints.map((f, i) => ({
            at: { ordinal: Math.min(c.count - 1, Math.floor(f * c.count)) },
            distance: 0.08 + (i % 2) * 0.05,
            yawDeg: (i - 1) * 26,
            pitchDeg: i % 2 ? 5 : -5,
            ms: 480,
            ease: "linear" as const,
          }));
          c.camera(legs);
        },
        { ms: 1250 + Math.round(rng() * 150), available: hasRecord },
      );
    };
    return [
      pass("fly-through", FLY_WAYPOINTS[0] as readonly number[], true),
      pass("fly-through-b", FLY_WAYPOINTS[1] as readonly number[], false),
      s("fly-out", "normal", (c) => {
        A.setLook(c.store, { lines: c.base.look.lines });
        c.camera([{ at: "home", distance: 1, ms: 650, ease: "out" }]);
      }, { available: hasRecord }),
    ];
  },
};

/** 5. Lens flips: the rail wordmark's word flips through the areas, each isolating itself on the figure and switching the key. */
const lens: ShowcaseBeat = {
  id: "lens",
  steps: (env, rng) => {
    const s = stepper("lens", rng);
    if (env.areas.length < 2) return [];
    const shown = shuffled(env.areas, rng).slice(0, Math.min(8, env.areas.length));
    return [
      ...shown.map((a) =>
        s(`lens-${a}`, "burst", (c) =>
          c.store.batch(() => {
            A.setScope(c.store, a);
            // The wordmark's own lens: everything outside the area drops to a few percent while it shows.
            c.store.update("ui", { preview: { kind: "area", key: a, strong: true } });
          }),
        ),
      ),
      s("lens-all", "burst", (c) =>
        c.store.batch(() => {
          A.setScope(c.store, "all");
          c.store.update("ui", { preview: null });
        }),
      ),
    ];
  },
};

/** 6. Colour sweeps: the whole figure flips through the colour themes and data palettes; the spine is coloured by time. Data colours only; the window never changes. */
const colours: ShowcaseBeat = {
  id: "colours",
  steps: (env, rng) => {
    const s = stepper("colours", rng);
    const canPreview = (c: ShowcaseCtx) => typeof c.palette === "function";
    const themes = shuffled(env.themes.filter((t) => t !== "default"), rng).slice(0, 4);
    const palettes = shuffled(env.palettes ?? [], rng).slice(0, 3);
    const flips: ShowcaseStep[] = [
      ...themes.map((id) => s(`colours-theme-${id}`, "burst", (c) => c.theme(id), { available: canPreview })),
      ...palettes.map((id) => s(`colours-palette-${id}`, "burst", (c) => c.palette?.(id), { available: canPreview })),
    ];
    const timeColour = (id: string, population: "notes" | "record" | "both", theme: ColourThemeId | undefined): ShowcaseStep =>
      s(id, "normal", (c) => {
        // The age ramp follows the theme's hue, so each pass reads as its own colour running from the bottom of the spine to the top.
        if (theme && typeof c.palette === "function") c.theme(theme);
        c.store.batch(() => {
          if (population !== "notes") A.setColourMode(c.store, "record", { kind: "age" });
          if (population !== "record") A.setColourMode(c.store, "notes", { kind: "age" });
        });
      });
    const warm = env.themes.filter((t) => t !== "default");
    const pickTheme = (i: number): ColourThemeId | undefined => warm[(i + Math.floor(rng() * warm.length)) % Math.max(1, warm.length)];
    return [
      ...flips,
      s("colours-own", "burst", (c) => c.palette?.(null), { available: canPreview }),
      timeColour("colours-spine-by-time", "record", pickTheme(0)),
      timeColour("colours-both-by-time", "both", pickTheme(1)),
      s("colours-back", "burst", (c) => {
        A.setView(c.store, "colour", c.base.colour);
        c.palette?.(null);
      }),
    ];
  },
};

/** The groupings the beat walks through, each on a layout that suits it. */
const GROUPING_TOUR: readonly { dim: DimId; layout: GroupLayout }[] = [
  { dim: "month", layout: "wheel" },
  { dim: "source", layout: "bubbles" },
  { dim: "filing", layout: "strata" },
  { dim: "recency", layout: "bubbles" },
  { dim: "month", layout: "bubbles" },
];

/**
 * 8. Groupings: labelled clouds, the sphere grid, the hub spray, fans of lines, hub-coloured blobs, each as a quick cut:
 * every layout the build offers and every grouping of the tour, each once.
 */
const groups: ShowcaseBeat = {
  id: "groups",
  steps: (env, rng) => {
    const s = stepper("groups", rng);
    const known = new Set<string>(BUILTIN_DIMS.map((d) => d.id));
    const options = [
      ...env.layouts.map((l) => ({ dim: dimForLayout("space", l), layout: l })),
      ...GROUPING_TOUR.filter((g) => known.has(g.dim)),
    ].filter((g, i, all) => all.findIndex((o) => o.dim === g.dim && o.layout === g.layout) === i);
    const cuts = shuffled(options, rng);
    return [
      s("groups-reset", "normal", (c) => settle(c, "body")),
      ...cuts.map((g, i) => s(`groups-${g.dim}-${g.layout}-${i}`, "normal", (c) => showGroups(c, g.dim, g.layout))),
      s("groups-back", "normal", (c) => {
        endGroups(c);
        c.morph(0, SHORT_MORPH_MS);
      }),
    ];
  },
};

/**
 * 9. The chart run: every chart the build offers flips in on the figure itself, about every half second (the waves also
 * show a scale and a smoothing). No page, card, tab or picker opens: the stage draws each chart on its own.
 */
const charts: ShowcaseBeat = {
  id: "charts",
  steps: (env, rng) => {
    const s = stepper("charts", rng);
    const has = (id: ChartId) => env.charts.includes(id);
    const ids = shuffled(env.charts, rng);
    if (ids.length === 0) return [];
    const flips = ids.map((id, i) =>
      s(`charts-${id}-${i}`, "normal", (c) => {
        if (i === 0) settle(c, "body");
        showChart(c, chartSpecFor(id, c.store.get("view").chart, c.store.get("view").groupBy));
      }),
    );
    const tweaks: ShowcaseStep[] = [];
    if (has("ridgeline")) {
      const scale = shuffled(WAVE_SCALES.filter((x) => x !== "linear"), rng)[0];
      const smoothing = shuffled(WAVE_SMOOTHINGS.filter((x) => x !== "none"), rng)[0];
      tweaks.push(
        s("charts-waves", "normal", (c) => showChart(c, tourChart("ridgeline", {}, {}))),
        ...(scale ? [s("charts-scale", "burst", (c) => showChart(c, tourChart("ridgeline", {}, { scale })))] : []),
        ...(smoothing ? [s("charts-smoothing", "burst", (c) => showChart(c, tourChart("ridgeline", {}, { smoothing, windowDays: 30 })))] : []),
      );
    }
    return [...flips.slice(0, 3), ...tweaks, ...flips.slice(3), s("charts-close", "normal", (c) => c.morph(0, SHORT_MORPH_MS))];
  },
};

/**
 * 10. Picks: a few real entries are selected one after another, quick flicks, the figure drawing each one's lines. Only
 * the selection moves: no reader, page or panel opens, and nothing is recorded as read.
 */
const picks: ShowcaseBeat = {
  id: "picks",
  steps: (_env, rng) => {
    const s = stepper("picks", rng);
    const n = 3 + Math.floor(rng() * 3);
    const flicks = Array.from({ length: n }, (_, i) =>
      s(
        `picks-${i}`,
        i === 0 ? "normal" : "burst",
        (c) => {
          const entry = c.entries(n)[i];
          if (!entry) return;
          c.store.batch(() => {
            if (i === 0) {
              settle(c, "body");
              // Each pick draws its own links, even for a person who keeps links off or shows them all.
              A.setLook(c.store, { lines: "selection" });
            }
            A.select(c.store, entry.ordinal, entry.id);
          });
        },
        { ...(i === 0 ? {} : { ms: 300 + Math.round(rng() * 50) }), available: hasRecord },
      ),
    );
    return [
      ...flicks,
      s("picks-clear", "burst", (c) => {
        c.store.batch(() => {
          A.clearSelection(c.store);
          A.setLook(c.store, { lines: c.base.look.lines });
        });
      }, { available: hasRecord }),
    ];
  },
};

/** 14. Names over the figure: a flash of the brain covered in name labels. */
const names: ShowcaseBeat = {
  id: "names",
  steps: (_env, rng) => {
    const s = stepper("names", rng);
    return [
      s("names-flash", "normal", (c) => {
        settle(c, "body");
        // The person's own grouping when it may be toured (never a label field: showGroups takes the area then).
        showGroups(c, dimForLayout(c.store.get("view").groupBy, "bubbles"), "bubbles", 160);
        A.setLook(c.store, { names: "always", namesFor: "everything", density: "all", groupLabels: true });
      }, { ms: 560 + Math.round(rng() * 120) }),
      s("names-off", "burst", (c) => {
        c.store.batch(() => {
          A.setLook(c.store, { names: c.base.look.names, namesFor: c.base.look.namesFor, density: c.base.look.density, groupLabels: c.base.look.groupLabels });
          endGroups(c);
        });
        c.morph(0, SHORT_MORPH_MS);
      }),
    ];
  },
};

/**
 * The beats. The first lap opens with the cold open and the inside-the-brain pull and shuffles the rest; every later lap
 * shuffles them all. The spec's start screen, Display panel (7), Time page (11), Settings (12) and add sheet (13) are
 * left out at the user's request, its reader flicks (10) are selections on the figure only, and its chart run (9) is
 * drawn on the figure without the Chart card.
 */
export const SHOWCASE_BEATS: readonly ShowcaseBeat[] = [open, inside, orbit, fly, lens, colours, groups, charts, picks, names];

/** The tilt of the window each effect takes: a few degrees about each axis and a slow zoom. */
function tiltFor(rng: () => number): WindowTilt {
  const sign = () => (rng() < 0.5 ? -1 : 1);
  return { rx: sign() * (2 + rng() * 2.5), ry: sign() * (3 + rng() * 3.5), scale: 1.025 + rng() * 0.04, ms: 1400 + Math.round(rng() * 300) };
}

/**
 * Put the whole-window camera into a loop: about every ten steps (six to eight times a lap) one step also tilts the
 * window in 3D and zooms, and a later step (at least one move's time after) settles it back. Moves never overlap, and a
 * tilt starts only when a later step of the same lap is there to settle it (a lap never ends tilted).
 */
function withWindowCamera(steps: ShowcaseStep[], rng: () => number): ShowcaseStep[] {
  const out = steps.map((st) => ({ ...st }));
  let i = 5 + Math.floor(rng() * 4);
  while (i < out.length - 4) {
    const tilt = tiltFor(rng);
    let waited = 0;
    let j = i;
    while (j < out.length && waited < tilt.ms) waited += (out[j++] as ShowcaseStep).hold;
    if (j >= out.length) break;
    const start = out[i] as ShowcaseStep;
    const run = start.run;
    start.run = (c) => {
      c.tilt?.(tilt);
      run(c);
    };
    const back = out[j] as ShowcaseStep;
    const backRun = back.run;
    back.run = (c) => {
      c.tilt?.(null);
      backRun(c);
    };
    i = j + 6 + Math.floor(rng() * 6);
  }
  return out;
}

/**
 * One lap of the tour for this build and record: the opening beat first (on the first lap, with the inside-the-brain pull
 * right after it), the others in an order drawn from `seed`, every hold drawn from its class, the window camera worked in.
 */
export function buildShowcase(env: ShowcaseEnv, seed = 1, beats: readonly ShowcaseBeat[] = SHOWCASE_BEATS): ShowcaseStep[] {
  const rng = seeded(seed * 7919 + 13);
  const first = seed <= 1 ? beats.filter((b) => b.id === "open" || b.id === "inside") : [];
  const rest = shuffled(beats.filter((b) => !first.includes(b)), rng);
  const ordered = [...first, ...rest];
  const steps = ordered.flatMap((b) => b.steps(env, rng));
  return withWindowCamera(steps, rng);
}

/** The layouts the build offers for any dimension, the charts available now, in the order the catalogue lists them. */
export function offeredLayouts(): GroupLayout[] {
  return GROUP_LAYOUTS.filter((l) => BUILTIN_DIMS.some((d) => layoutsFor(d.id).includes(l)));
}

export function offeredCharts(): ChartId[] {
  return CHART_CATALOGUE.filter((c) => chartAvailable(c)).map((c) => c.id);
}
